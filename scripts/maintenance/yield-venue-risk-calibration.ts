/**
 * Yield v8.292 venue-risk calibration.
 *
 * Fetches the live /api/yield-rankings (still on the pre-deploy methodology),
 * recomputes each row's source-risk penalty + PYS under the new 5-category venue
 * rubric + dependency-concentration signal, and reports the blast radius.
 *
 * Run: PHAROS_API_KEY=... tsx scripts/maintenance/yield-venue-risk-calibration.ts
 * (or with the key in .env.local). Read-only; prints a Markdown-ish report.
 */
import { readFileSync } from "node:fs";
import { computePYS, derivePysSourceRiskPenalty } from "@shared/lib/yield-scoring";
import {
  resolveDependencyConcentration,
  resolveReviewedYieldRiskConfig,
  venueRiskTierOf,
  venueRiskWeightedOf,
} from "../../worker/src/cron/yield-sync/source-risk";

function loadKey(): string {
  if (process.env.PHAROS_API_KEY) return process.env.PHAROS_API_KEY;
  const env = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
  const line = env.split("\n").find((l) => l.trim().startsWith("PHAROS_API_KEY"));
  const key = line?.split("=")[1]?.trim();
  if (!key) throw new Error("PHAROS_API_KEY not found in env or .env.local");
  return key;
}

const API = process.env.PHAROS_API_BASE ?? "https://api.pharos.watch";

interface Row {
  id: string;
  symbol: string;
  apy30d: number;
  pharosYieldScore: number | null;
  safetyScore: number | null;
  benchmarkRate: number | null;
  yieldStability: number | null;
  sourceRisk: {
    sourceRiskPenalty?: number | null;
    rewardShare?: number | null;
    sourceDepthRatio?: number | null;
    sourceAgeSeconds?: number | null;
    sourceSwitchCount30d?: number | null;
    observationCount30d?: number | null;
    venueProtocol?: string | null;
    venueRiskTier?: string | null;
  } | null;
}

function varianceScore(yieldStability: number | null): number {
  if (yieldStability == null || !Number.isFinite(yieldStability)) return 0;
  return Math.max(0, Math.min(1, 1 - yieldStability));
}

async function main(): Promise<void> {
const res = await fetch(`${API}/api/yield-rankings`, { headers: { "X-API-Key": loadKey() } });
if (!res.ok) throw new Error(`API ${res.status}`);
const body = (await res.json()) as { rankings: Row[]; scalingFactor: number };
const rows = body.rankings;
const scalingFactor = body.scalingFactor;

let recomputeMatch = 0;
let recomputeTotal = 0;
interface Mover {
  id: string;
  symbol: string;
  venue: string | null;
  oldTier: string | null;
  newTier: string;
  oldPenalty: number;
  newPenalty: number;
  oldPys: number | null;
  newPys: number;
  delta: number;
  reason: string;
}
const movers: Mover[] = [];
const venueRowCount = new Map<string, number>();

for (const row of rows) {
  const sr = row.sourceRisk;
  if (sr == null || row.pharosYieldScore == null) continue;
  const apyVarianceScore = varianceScore(row.yieldStability);
  const oldPenalty = typeof sr.sourceRiskPenalty === "number" ? sr.sourceRiskPenalty : 1;

  // Validate reconstruction: recompute old PYS with the published penalty.
  const oldPysRecomputed = computePYS({
    apy30d: row.apy30d,
    safetyScore: row.safetyScore,
    apyVarianceScore,
    scalingFactor,
    benchmarkRate: row.benchmarkRate,
    sourceRiskPenalty: oldPenalty,
  });
  recomputeTotal += 1;
  if (Math.abs(oldPysRecomputed - row.pharosYieldScore) <= 1) recomputeMatch += 1;

  // New venue + concentration evidence.
  const cfg = resolveReviewedYieldRiskConfig(sr.venueProtocol);
  const newWeighted = cfg ? venueRiskWeightedOf(cfg) : null;
  const newTier = cfg ? venueRiskTierOf(cfg) : "unknown";
  const conc = resolveDependencyConcentration(row.id);

  const telemetry = {
    rewardShare: sr.rewardShare ?? null,
    sourceDepthRatio: sr.sourceDepthRatio ?? null,
    sourceAgeSeconds: sr.sourceAgeSeconds ?? null,
    sourceSwitchCount30d: sr.sourceSwitchCount30d ?? null,
    observationCount30d: sr.observationCount30d ?? null,
  };
  const newPenalty = derivePysSourceRiskPenalty({
    ...telemetry,
    venueRiskWeighted: newWeighted,
    dependencyConcentrationSeverity: conc?.severity ?? null,
  });

  if (cfg && sr.venueProtocol) {
    venueRowCount.set(sr.venueProtocol, (venueRowCount.get(sr.venueProtocol) ?? 0) + 1);
  }

  const newPys = computePYS({
    apy30d: row.apy30d,
    safetyScore: row.safetyScore,
    apyVarianceScore,
    scalingFactor,
    benchmarkRate: row.benchmarkRate,
    sourceRiskPenalty: newPenalty,
  });
  const delta = newPys - oldPysRecomputed;
  if (Math.abs(delta) >= 0.5 || Math.abs(newPenalty - oldPenalty) >= 0.01) {
    const reasons: string[] = [];
    if (Math.abs(newPenalty - oldPenalty) >= 0.01) reasons.push(`venue ${sr.venueProtocol}→${newTier}`);
    if (conc) reasons.push(`concentration:${conc.ecosystem}`);
    movers.push({
      id: row.id,
      symbol: row.symbol,
      venue: sr.venueProtocol ?? null,
      oldTier: sr.venueRiskTier ?? null,
      newTier,
      oldPenalty: Number(oldPenalty.toFixed(3)),
      newPenalty: Number(newPenalty.toFixed(3)),
      oldPys: row.pharosYieldScore,
      newPys,
      delta: Number(delta.toFixed(2)),
      reason: reasons.join(", "),
    });
  }
}

movers.sort((a, b) => a.delta - b.delta);

console.log(`\n# Yield v8.292 venue-risk calibration — ${rows.length} live rows\n`);
console.log(`Reconstruction validity: ${recomputeMatch}/${recomputeTotal} rows recompute old PYS within ±1.\n`);
console.log(`Rows touched by the new venue/concentration model: ${movers.length}`);
const drops = movers.filter((m) => m.delta < 0);
console.log(`  PYS decreases: ${drops.length}  |  increases: ${movers.length - drops.length}`);
if (drops.length) {
  const maxDrop = drops[0];
  const meanDrop = drops.reduce((s, m) => s + m.delta, 0) / drops.length;
  console.log(`  Largest drop: ${maxDrop.symbol} ${maxDrop.delta} PYS (${maxDrop.oldPys}→${maxDrop.newPys}, ${maxDrop.reason})`);
  console.log(`  Mean drop: ${meanDrop.toFixed(2)} PYS`);
  console.log(`  Rows that hit PYS 0: ${drops.filter((m) => m.newPys === 0).length}`);
}
console.log(`\n## Rows by newly-scored venue (count)`);
for (const [venue, count] of [...venueRowCount.entries()].sort((a, b) => b[1] - a[1])) {
  const cfg = resolveReviewedYieldRiskConfig(venue);
  const tier = cfg ? venueRiskTierOf(cfg) : "unknown";
  console.log(`  ${venue} (${tier}): ${count}`);
}
console.log(`\n## All movers (sorted by delta)`);
for (const m of movers) {
  console.log(
    `  ${m.symbol.padEnd(14)} ${String(m.delta).padStart(7)} PYS  ${String(m.oldPys).padStart(3)}→${String(m.newPys).padStart(3)}  pen ${m.oldPenalty}→${m.newPenalty}  [${m.reason}]`,
  );
}
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
