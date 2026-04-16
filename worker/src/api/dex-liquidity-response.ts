import { safeJsonParse } from "../lib/api-utils";
import { DexLiquidityCronMetadataSchema } from "../lib/schemas";
import type { LiquidityPoolSourceFamily } from "@shared/types/market";

const TREND_BASELINE_CONFIDENCE_MIN = 0.5;
const TREND_24H_TOLERANCE_SEC = 12 * 3600;
const TREND_7D_TOLERANCE_SEC = 36 * 3600;

export interface DexLiquidityRow {
  stablecoin_id: string;
  total_tvl_usd: number;
  total_volume_24h_usd: number;
  total_volume_7d_usd: number;
  pool_count: number;
  pair_count: number;
  chain_count: number;
  protocol_tvl_json: string | null;
  chain_tvl_json: string | null;
  top_pools_json: string | null;
  liquidity_score: number | null;
  concentration_hhi: number | null;
  depth_stability: number | null;
  updated_at: number;
  effective_tvl_usd: number | null;
  avg_pool_stress: number | null;
  weighted_balance_ratio: number | null;
  organic_fraction: number | null;
  durability_score: number | null;
  score_components_json: string | null;
  locked_liquidity_pct: number | null;
  coverage_class: string | null;
  coverage_confidence: number | null;
  source_mix_json: string | null;
  balance_measured_tvl_usd: number | null;
  organic_measured_tvl_usd: number | null;
  methodology_version: string | null;
}

export interface DexHistoryRow {
  stablecoin_id: string;
  total_tvl_usd: number;
  snapshot_date: number;
  coverage_class: string | null;
  coverage_confidence: number | null;
}

export interface DexPriceRow {
  stablecoin_id: string;
  dex_price_usd: number;
  deviation_from_primary_bps: number | null;
  source_pool_count: number;
  source_total_tvl: number;
  price_sources_json: string | null;
  updated_at: number;
}

export interface DexLiquidityCronRow {
  status: string;
  metadata: string | null;
}

type DexLiquidityPoolResponse = {
  source?: string;
} & Record<string, unknown>;

function normalizePoolSource(source: unknown): LiquidityPoolSourceFamily | undefined {
  if (typeof source !== "string" || source.length === 0) return undefined;
  if (source === "cg") return "cg_onchain";
  if (source === "gt") return "gecko_terminal";
  if (source === "ds") return "dexscreener";
  if (
    source === "dl" ||
    source === "cg_onchain" ||
    source === "gecko_terminal" ||
    source === "dexscreener" ||
    source === "cg_tickers" ||
    source === "direct_api"
  ) {
    return source;
  }
  return undefined;
}

function pickAllowedKeys(obj: Record<string, unknown>, allowed: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

const ALLOWED_POOL_KEYS = new Set<string>([
  "project", "chain", "symbol", "poolType", "tvlUsd", "volumeUsd1d", "price", "source",
]);
const ALLOWED_EXTRA_KEYS = new Set<string>([
  "amplificationCoefficient", "balanceRatio", "feeTier", "organicFraction",
  "pairQuality", "stressIndex", "maturityDays", "balanceDetails", "measurement",
  "effectiveTvl", "isMetaPool", "registryId", "lockedLiquidityPct",
  "orderbookDepthUsd", "orderbookDepthUpUsd", "orderbookTvlBasis",
]);

export function normalizeTopPools(json: string | null): DexLiquidityPoolResponse[] {
  const parsed = safeJsonParse<DexLiquidityPoolResponse[]>(json, []);
  return parsed.map((pool) => {
    const cleaned = pickAllowedKeys(pool as Record<string, unknown>, ALLOWED_POOL_KEYS);
    if (pool.extra && typeof pool.extra === "object") {
      cleaned.extra = pickAllowedKeys(pool.extra as Record<string, unknown>, ALLOWED_EXTRA_KEYS);
    }
    const normalizedSource = normalizePoolSource(pool.source);
    if (normalizedSource != null) {
      cleaned.source = normalizedSource;
    } else {
      console.info("[dex-liquidity] Unknown pool source:", pool.source);
      delete cleaned.source;
    }
    return cleaned as DexLiquidityPoolResponse;
  });
}

// M7: Wide tolerance windows (24h for 24h baseline, 48h for 7d baseline) handle
// missed cron runs gracefully. The dex-liquidity cron runs every 30 min, but if
// several runs are missed, we still find a usable baseline within the tolerance.
export function selectTrendBaseline(
  history: DexHistoryRow[],
  targetSec: number,
  toleranceSec: number,
): DexHistoryRow | null {
  let best: DexHistoryRow | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const row of history) {
    const confidence = row.coverage_confidence ?? 0;
    if (confidence < TREND_BASELINE_CONFIDENCE_MIN) continue;
    if (row.total_tvl_usd <= 0) continue;

    const distance = Math.abs(row.snapshot_date - targetSec);
    if (distance > toleranceSec) continue;
    if (distance < bestDistance) {
      best = row;
      bestDistance = distance;
    }
  }

  return best;
}

export function getDexLiquidityTrendTolerances() {
  return {
    day: TREND_24H_TOLERANCE_SEC,
    week: TREND_7D_TOLERANCE_SEC,
  };
}

export function buildDexLiquidityWarning(latestCron: DexLiquidityCronRow | null): string | null {
  if (!latestCron) return null;

  let failedSources: string[] = [];
  let nearCoverageGuard = false;
  let nearValueGuard = false;
  let nearMajorCoverageGuard = false;
  let qualityDriftSeverity: "none" | "medium" | "high" = "none";
  let qualityDriftFlags: string[] = [];
  if (latestCron.metadata) {
    try {
      const raw = JSON.parse(latestCron.metadata);
      const parsed = DexLiquidityCronMetadataSchema.parse(raw);
      failedSources = parsed.failedSources;
      nearCoverageGuard = parsed.sourceCoverage.nearCoverageGuard;
      nearValueGuard = parsed.sourceCoverage.nearValueGuard;
      nearMajorCoverageGuard = parsed.sourceCoverage.nearMajorCoverageGuard;
      qualityDriftSeverity = parsed.sourceCoverage.qualityDriftSeverity ?? "none";
      qualityDriftFlags = parsed.sourceCoverage.qualityDriftFlags ?? [];
    } catch (err) {
      console.info("[dex-liquidity] Malformed cron metadata:", err instanceof Error ? err.message : String(err));
    }
  }

  if (latestCron.status !== "degraded" && latestCron.status !== "error" && qualityDriftSeverity === "none") return null;

  const details: string[] = [];
  if (failedSources.length > 0) details.push(`failedSources=${failedSources.join(",")}`);
  if (nearCoverageGuard) details.push("nearCoverageGuard");
  if (nearValueGuard) details.push("nearValueGuard");
  if (nearMajorCoverageGuard) details.push("nearMajorCoverageGuard");
  if (qualityDriftSeverity !== "none") details.push(`qualityDrift=${qualityDriftSeverity}`);
  if (qualityDriftFlags.length > 0) details.push(`qualityDriftFlags=${qualityDriftFlags.join(",")}`);

  const suffix = details.length > 0 ? ` (${details.join("; ")})` : "";
  if (latestCron.status === "error") {
    return `199 - "Latest sync-dex-liquidity run failed; serving last successful dataset${suffix}"`;
  }
  if (latestCron.status === "ok" && qualityDriftSeverity !== "none") {
    return `199 - "Latest sync-dex-liquidity run shows ${qualityDriftSeverity} quality drift${suffix}"`;
  }
  return `199 - "Latest sync-dex-liquidity run degraded${suffix}"`;
}

export function classifyLiquidityEvidence(
  totalTvlUsd: number,
  balanceMeasuredTvlUsd: number,
): {
  liquidityEvidenceClass: "unobserved" | "measured" | "partial_measured" | "observed_unmeasured";
  hasMeasuredLiquidityEvidence: boolean;
} {
  if (totalTvlUsd <= 0) {
    return {
      liquidityEvidenceClass: "unobserved",
      hasMeasuredLiquidityEvidence: false,
    };
  }
  if (balanceMeasuredTvlUsd <= 0) {
    return {
      liquidityEvidenceClass: "observed_unmeasured",
      hasMeasuredLiquidityEvidence: false,
    };
  }
  if (balanceMeasuredTvlUsd >= totalTvlUsd * 0.8) {
    return {
      liquidityEvidenceClass: "measured",
      hasMeasuredLiquidityEvidence: true,
    };
  }
  return {
    liquidityEvidenceClass: "partial_measured",
    hasMeasuredLiquidityEvidence: true,
  };
}

export function isTrendworthySnapshot(
  totalTvlUsd: number,
  coverageClass: string | null,
  coverageConfidence: number | null,
): boolean {
  if (totalTvlUsd <= 0) return false;
  if ((coverageConfidence ?? 0) < 0.75) return false;
  return coverageClass === "primary" || coverageClass === "mixed";
}
