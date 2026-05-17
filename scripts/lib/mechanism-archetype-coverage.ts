import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StablecoinMeta } from "../../shared/types";

const BASELINE_FILE = "scripts/lib/curation-baseline-caps.json";

export interface CurationBaselineCaps {
  capturedAt: string;
  rationale: string;
  segmentLabel: string;
  topByRank: readonly string[];
}

export interface MechanismArchetypeCoverageResult {
  baseline: CurationBaselineCaps;
  segmentTotal: number;
  segmentVariants: number;
  segmentTracked: number;
  withArchetype: number;
  withoutArchetype: number;
  missingIds: string[];
  /** Fraction (0..1) of in-segment non-variant coins missing mechanismArchetype. */
  missingRatio: number;
  /** Coin IDs listed in the baseline but missing from the per-coin registry. */
  unknownBaselineIds: string[];
  /** Coin IDs in the segment whose status is "frozen" (excluded from the gate). */
  excludedFrozenIds: string[];
}

export function loadCurationBaselineCaps(rootDir: string = process.cwd()): CurationBaselineCaps {
  const absolutePath = resolve(rootDir, BASELINE_FILE);
  // Repo-owned baseline; BASELINE_FILE is a hardcoded module constant.
  const raw = readFileSync(absolutePath, "utf8");
  const parsed = JSON.parse(raw) as CurationBaselineCaps;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.topByRank)) {
    throw new Error(`${BASELINE_FILE}: expected an object with topByRank: string[]`);
  }
  return parsed;
}

function isFrozen(coin: StablecoinMeta): boolean {
  return coin.status === "frozen";
}

function isVariant(coin: StablecoinMeta): boolean {
  return typeof coin.variantOf === "string" && coin.variantOf.length > 0;
}

export function analyzeMechanismArchetypeCoverage(
  coins: readonly StablecoinMeta[],
  baseline: CurationBaselineCaps,
): MechanismArchetypeCoverageResult {
  const byId = new Map<string, StablecoinMeta>();
  for (const coin of coins) {
    byId.set(coin.id, coin);
  }

  const unknownBaselineIds: string[] = [];
  const excludedFrozenIds: string[] = [];
  const tracked: StablecoinMeta[] = [];
  let segmentVariants = 0;

  for (const id of baseline.topByRank) {
    const coin = byId.get(id);
    if (!coin) {
      unknownBaselineIds.push(id);
      continue;
    }
    if (isFrozen(coin)) {
      excludedFrozenIds.push(id);
      continue;
    }
    if (isVariant(coin)) {
      segmentVariants += 1;
      continue;
    }
    tracked.push(coin);
  }

  const missingIds = tracked
    .filter((coin) => !coin.mechanismArchetype)
    .map((coin) => coin.id)
    .sort((a, b) => a.localeCompare(b));

  const segmentTotal = baseline.topByRank.length;
  const segmentTracked = tracked.length;
  const withoutArchetype = missingIds.length;
  const withArchetype = segmentTracked - withoutArchetype;
  const missingRatio = segmentTracked === 0 ? 0 : withoutArchetype / segmentTracked;

  return {
    baseline,
    segmentTotal,
    segmentVariants,
    segmentTracked,
    withArchetype,
    withoutArchetype,
    missingIds,
    missingRatio,
    unknownBaselineIds,
    excludedFrozenIds,
  };
}
