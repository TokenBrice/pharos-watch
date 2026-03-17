import satori, { init as initSatori } from "satori/standalone";
import yogaWasm from "satori/yoga.wasm";
import { Resvg, initResvg, resvgWasmModule } from "@cf-wasm/resvg/workerd";
import { OG_FONTS } from "../lib/og-fonts";
import { StablecoinCard, type StablecoinCardData } from "../lib/og-templates/stablecoin-card";
import { SafetyScoresCard, type SafetyScoresCardData } from "../lib/og-templates/safety-scores-card";
import { DepegCard, type DepegCardData } from "../lib/og-templates/depeg-card";
import { StabilityIndexCard, type StabilityIndexCardData } from "../lib/og-templates/stability-index-card";
import { resolveOrReject } from "../lib/api-utils";
import { loadDexLiquidityMap } from "../lib/dex-liquidity";
import { getConditionBand } from "../lib/stability-index";
import { sumPegBuckets } from "@shared/lib/supply";
import { ACTIVE_IDS } from "@shared/lib/stablecoins";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../lib/stablecoins-cache";
import { loadReportCardCache } from "../lib/report-card-cache";

// ---------------------------------------------------------------------------
// WASM singleton initialization (yoga for satori + resvg for SVG→PNG)
// ---------------------------------------------------------------------------

let wasmInitialized = false;

async function ensureWasm(): Promise<void> {
  if (!wasmInitialized) {
    const errors: unknown[] = [];

    // Initialize yoga WASM for satori layout engine
    try {
      await initSatori(yogaWasm);
    } catch (e: unknown) {
      // Ignore if already initialized in this isolate
      if (!(e instanceof Error && e.message.includes("already"))) {
        errors.push(e);
      }
    }

    // Initialize resvg WASM for SVG→PNG rendering
    try {
      await initResvg(resvgWasmModule);
    } catch (e: unknown) {
      // @cf-wasm/resvg throws if already initialized in this isolate
      if (!(e instanceof Error && e.message.includes("already called"))) {
        errors.push(e);
      }
    }

    if (errors.length > 0) {
      throw errors[0];
    }
    wasmInitialized = true;
  }
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const OG_WIDTH = 1200;
const OG_HEIGHT = 628;
const CACHE_HEADERS = {
  "Content-Type": "image/png",
  "Cache-Control": "public, max-age=900, s-maxage=900",
};

// ---------------------------------------------------------------------------
// SVG → PNG render pipeline
// ---------------------------------------------------------------------------

async function renderPng(element: React.ReactNode): Promise<Uint8Array> {
  await ensureWasm();

  const svg = await satori(element, {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    fonts: OG_FONTS,
  });

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: OG_WIDTH },
  });
  const rendered = resvg.render();
  return rendered.asPng();
}

interface StablecoinOgCoinInput {
  name: string;
  symbol: string;
  price?: number | null;
  circulating: Record<string, number>;
  circulatingPrevWeek?: Record<string, number> | null;
}

interface StablecoinOgSignalsInput {
  coin: StablecoinOgCoinInput;
  dexLiquidityScore: number | null;
  dewsBand: string | null | undefined;
  psiScore: number | null | undefined;
  psiBand: string | null | undefined;
  grade: string | null | undefined;
  sparklineRows: Array<{ price: number }>;
  hasActiveDepeg: boolean;
  flow7d: number | null | undefined;
}

export function deriveStablecoinOgCardData({
  coin,
  dexLiquidityScore,
  dewsBand,
  psiScore,
  psiBand,
  grade,
  sparklineRows,
  hasActiveDepeg,
  flow7d,
}: StablecoinOgSignalsInput): StablecoinCardData {
  const pegPrice = coin.price ?? 1;
  const mcap = sumPegBuckets(coin.circulating);
  const prevWeekMcap = sumPegBuckets(coin.circulatingPrevWeek ?? undefined);
  const sparklineData = sparklineRows.map((row) => row.price).reverse();

  return {
    name: coin.name,
    symbol: coin.symbol,
    grade: grade ?? "NR",
    pegPrice,
    dewsBand: dewsBand ?? "CALM",
    liquidityScore: dexLiquidityScore ?? 0,
    psiScore: psiScore ?? 0,
    psiBand: psiBand ?? "BEDROCK",
    mcap,
    vol24h: null,
    flow7d: flow7d ?? (mcap - prevWeekMcap),
    sparklineData: sparklineData.length >= 2 ? sparklineData : [pegPrice, pegPrice],
    hasActiveDepeg,
  };
}

// ---------------------------------------------------------------------------
// /api/og/stablecoin/:id
// ---------------------------------------------------------------------------

async function handleStablecoinOg(db: D1Database, coinId: string): Promise<Response> {
  const resolved = resolveOrReject(coinId);
  if (resolved instanceof Response) {
    return new Response("Unknown stablecoin", { status: 404, headers: { "Content-Type": "text/plain" } });
  }
  const id = resolved.canonicalId;

  if (!ACTIVE_IDS.has(id)) {
    return new Response("Unknown stablecoin", { status: 404, headers: { "Content-Type": "text/plain" } });
  }

  // Parallel queries: stablecoins cache, dex liquidity, DEWS, PSI, report card, 7d price sparkline, active depeg, 7d flow
  const [stablecoinsPayload, dexLiqMap, dewsRow, psiRow, reportCardRow, sparklineRows, activeDepegRow, flowRow] =
    await Promise.all([
      loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: false }),
      loadDexLiquidityMap(db),
      db
        .prepare(
          "SELECT score, band FROM stress_signals WHERE stablecoin_id = ? ORDER BY computed_at DESC LIMIT 1",
        )
        .bind(id)
        .first<{ score: number; band: string }>(),
      db
        .prepare(
          "SELECT score, band FROM stability_index_samples ORDER BY stored_at DESC LIMIT 1",
        )
        .first<{ score: number; band: string }>(),
      loadReportCardCache(db).then((result) => (result.kind === "ok" ? result.payload.scores?.[id] ?? null : null)),
      db
        .prepare(
          "SELECT price FROM supply_history WHERE stablecoin_id = ? AND price IS NOT NULL ORDER BY snapshot_date DESC LIMIT 7",
        )
        .bind(id)
        .all<{ price: number }>(),
      db
        .prepare(
          "SELECT id FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL LIMIT 1",
        )
        .bind(id)
        .first<{ id: number }>(),
      db
        .prepare(
          `SELECT SUM(net_flow_usd) as net_flow
           FROM mint_burn_hourly
           WHERE stablecoin_id = ? AND hour_ts >= ?`,
        )
        .bind(id, Math.floor(Date.now() / 1000) - 7 * 86400)
        .first<{ net_flow: number | null }>(),
    ]);

  if (!hasUsableStablecoinsPayload(stablecoinsPayload)) {
    return new Response("Data not yet available", { status: 503, headers: { "Content-Type": "text/plain" } });
  }

  const coin = stablecoinsPayload.payload.peggedAssets.find((a) => a.id === id);
  if (!coin) {
    return new Response("Stablecoin not found in cache", { status: 404, headers: { "Content-Type": "text/plain" } });
  }

  const liq = dexLiqMap[id];
  const data = deriveStablecoinOgCardData({
    coin,
    dexLiquidityScore: liq?.liquidityScore ?? null,
    dewsBand: dewsRow?.band,
    psiScore: psiRow?.score,
    psiBand: psiRow?.band,
    grade: reportCardRow?.grade,
    sparklineRows: sparklineRows.results ?? [],
    hasActiveDepeg: activeDepegRow !== null,
    flow7d: flowRow?.net_flow,
  });

  const png = await renderPng(<StablecoinCard data={data} />);
  return new Response(png, { headers: CACHE_HEADERS });
}

// ---------------------------------------------------------------------------
// /api/og/safety-scores
// ---------------------------------------------------------------------------

async function handleSafetyScoresOg(db: D1Database): Promise<Response> {
  const stablecoinsPayload = await loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: false });

  const gradeDistribution: Record<string, number> = {
    "A+": 0, A: 0, "A-": 0,
    "B+": 0, B: 0, "B-": 0,
    "C+": 0, C: 0, "C-": 0,
    D: 0, F: 0, NR: 0,
  };

  let pulseScore = 0;
  let ratedCount = 0;
  let totalCoins = ACTIVE_IDS.size;

  const reportCardCache = await loadReportCardCache(db);
  if (reportCardCache.kind === "ok") {
    for (const [, entry] of Object.entries(reportCardCache.payload.scores)) {
      const grade = entry.grade;
      if (grade in gradeDistribution) {
        gradeDistribution[grade]++;
      } else {
        gradeDistribution["NR"]++;
      }
      if (entry.score > 0) {
        pulseScore += entry.score;
        ratedCount++;
      }
    }
  }

  if (hasUsableStablecoinsPayload(stablecoinsPayload)) {
    totalCoins = stablecoinsPayload.payload.peggedAssets.length;
  }

  const avgScore = ratedCount > 0 ? pulseScore / ratedCount : 0;
  const pulseGrade =
    avgScore >= 90
      ? "A+"
      : avgScore >= 80
        ? "A"
        : avgScore >= 70
          ? "B+"
          : avgScore >= 60
            ? "B"
            : avgScore >= 50
              ? "C"
              : avgScore >= 40
                ? "D"
                : "F";

  const data: SafetyScoresCardData = {
    gradeDistribution,
    pulseGrade,
    pulseScore: avgScore,
    coverageRatio: totalCoins > 0 ? ratedCount / totalCoins : 0,
    totalCoins,
  };

  const png = await renderPng(<SafetyScoresCard data={data} />);
  return new Response(png, { headers: CACHE_HEADERS });
}

// ---------------------------------------------------------------------------
// /api/og/depeg
// ---------------------------------------------------------------------------

async function handleDepegOg(db: D1Database): Promise<Response> {
  const [activeDepegsResult, psiRow, stressRows] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) as count FROM depeg_events WHERE ended_at IS NULL")
      .first<{ count: number }>(),
    db
      .prepare("SELECT score, band FROM stability_index_samples ORDER BY stored_at DESC LIMIT 1")
      .first<{ score: number; band: string }>(),
    db
      .prepare(
        `SELECT s.band
         FROM stress_signals s
         INNER JOIN (
           SELECT stablecoin_id, MAX(computed_at) as max_at
           FROM stress_signals GROUP BY stablecoin_id
         ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at`,
      )
      .all<{ band: string }>(),
  ]);

  const dewsDistribution = { danger: 0, alert: 0, warning: 0, normal: 0 };
  let totalCoins = 0;
  for (const row of stressRows.results ?? []) {
    totalCoins++;
    switch (row.band) {
      case "DANGER":
        dewsDistribution.danger++;
        break;
      case "ALERT":
        dewsDistribution.alert++;
        break;
      case "WARNING":
        dewsDistribution.warning++;
        break;
      default:
        dewsDistribution.normal++;
        break;
    }
  }

  const activeDepegCount = activeDepegsResult?.count ?? 0;
  const coinsAtPeg = totalCoins - activeDepegCount;

  const data: DepegCardData = {
    activeDepegCount,
    psiScore: psiRow?.score ?? 0,
    psiBand: psiRow?.band ?? "BEDROCK",
    coinsAtPeg: Math.max(0, coinsAtPeg),
    totalCoins,
    dewsDistribution,
  };

  const png = await renderPng(<DepegCard data={data} />);
  return new Response(png, { headers: CACHE_HEADERS });
}

// ---------------------------------------------------------------------------
// /api/og/stability-index
// ---------------------------------------------------------------------------

async function handleStabilityIndexOg(db: D1Database): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);

  const [latestSample, avg24hRow, historyRows] = await Promise.all([
    db
      .prepare("SELECT score, band, stored_at FROM stability_index_samples ORDER BY stored_at DESC LIMIT 1")
      .first<{ score: number; band: string; stored_at: number }>(),
    db
      .prepare("SELECT AVG(score) as avg FROM stability_index_samples WHERE stored_at > ?")
      .bind(now - 86400)
      .first<{ avg: number | null }>(),
    db
      .prepare("SELECT score FROM stability_index ORDER BY computed_at DESC LIMIT 14")
      .all<{ score: number }>(),
  ]);

  const psiScore = latestSample?.score ?? 0;
  const psiBand = latestSample?.band ?? getConditionBand(psiScore);
  const avg24h = avg24hRow?.avg ?? psiScore;
  const delta24h = psiScore - avg24h;

  // Build sparkline from daily history (newest first → reverse for chronological)
  const sparklineData = (historyRows.results ?? []).map((r) => r.score).reverse();
  if (sparklineData.length < 2) {
    sparklineData.push(psiScore, psiScore);
  }

  const allBands: Array<{ name: string; active: boolean }> = [
    "BEDROCK",
    "STEADY",
    "TREMOR",
    "FRACTURE",
    "CRISIS",
    "MELTDOWN",
  ].map((name) => ({ name, active: name === psiBand }));

  const data: StabilityIndexCardData = {
    psiScore,
    psiBand,
    delta24h: Math.round(delta24h * 100) / 100,
    sparklineData,
    bands: allBands,
  };

  const png = await renderPng(<StabilityIndexCard data={data} />);
  return new Response(png, { headers: CACHE_HEADERS });
}

// ---------------------------------------------------------------------------
// Main OG route dispatcher
// ---------------------------------------------------------------------------

const STABLECOIN_OG_PATTERN = /^\/api\/og\/stablecoin\/(.+)$/;

export async function handleOg(db: D1Database, path: string): Promise<Response | null> {
  try {
    // /api/og/stablecoin/:id
    const stablecoinMatch = path.match(STABLECOIN_OG_PATTERN);
    if (stablecoinMatch) {
      let coinId: string;
      try {
        coinId = decodeURIComponent(stablecoinMatch[1]);
      } catch {
        return new Response("Malformed URI", { status: 400, headers: { "Content-Type": "text/plain" } });
      }
      return await handleStablecoinOg(db, coinId);
    }

    // /api/og/safety-scores
    if (path === "/api/og/safety-scores") {
      return await handleSafetyScoresOg(db);
    }

    // /api/og/depeg
    if (path === "/api/og/depeg") {
      return await handleDepegOg(db);
    }

    // /api/og/stability-index
    if (path === "/api/og/stability-index") {
      return await handleStabilityIndexOg(db);
    }

    return null;
  } catch (err) {
    console.error("[og] Render error:", err);
    return new Response("OG image generation failed", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
}
