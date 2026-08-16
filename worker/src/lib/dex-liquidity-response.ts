import { logWorkerEventArgs } from "./structured-log";
import { safeJsonParse } from "./api-utils";
import { CURRENT_DEPLOYMENT_KEYS, deploymentKey } from "./dex-liquidity";
import { DexLiquidityCronMetadataSchema } from "./schemas";
import {
  ExitRouteObservationCoverageSchema,
  ExitRouteObservationSchema,
  MAX_DEX_EXIT_ROUTE_OBSERVATIONS,
  type ExitRouteObservation,
  type ExitRouteObservationCoverage,
  type LiquidityPoolSourceFamily,
} from "@shared/types/market";
import { toErrorMessage } from "./error-utils";

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

export interface DexDeploymentOutcomeRow {
  stablecoin_id: string;
  chain: string;
  contract_address: string;
  outcome: "observed_pools" | "verified_no_pools" | "provider_inaccessible";
  provider_set_json: string;
  reason: string;
  observed_pool_count: number;
  observed_at: number;
  waiver_owner: string | null;
  waiver_reason: string | null;
  waiver_expires_at: number | null;
}

export interface NormalizedDexScoreDetails {
  scoreComponents: unknown;
  exitRouteObservations: ExitRouteObservation[] | null;
  exitRouteObservationCoverage: ExitRouteObservationCoverage;
}

const UNKNOWN_EXIT_ROUTE_COVERAGE: ExitRouteObservationCoverage = {
  status: "unknown",
  capabilityMatrixVersion: "unknown",
  retainedPoolCount: 0,
  observationCount: 0,
  scoreEligibleObservationCount: 0,
  unsupportedPoolCount: 0,
  evidenceCounts: {},
  unsupportedReasons: { producerEnvelopeAbsent: 1 },
};

const SCORE_COMPONENT_KEYS = ["tvlDepth", "volumeActivity", "poolQuality", "durability", "pairDiversity"] as const;

function projectLegacyScoreComponents(details: Record<string, unknown>): Record<string, number> | null {
  const projected: Record<string, number> = {};
  for (const key of SCORE_COMPONENT_KEYS) {
    const value = details[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    projected[key] = value;
  }
  return projected;
}

export function normalizeDexScoreDetails(
  json: string | null,
  context = "dex-liquidity-response:score_components_json",
): NormalizedDexScoreDetails {
  const parsed = safeJsonParse<unknown>(json, null, context);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      scoreComponents: parsed,
      exitRouteObservations: null,
      exitRouteObservationCoverage: UNKNOWN_EXIT_ROUTE_COVERAGE,
    };
  }

  const details = parsed as Record<string, unknown>;
  const observations = ExitRouteObservationSchema.array()
    .max(MAX_DEX_EXIT_ROUTE_OBSERVATIONS)
    .safeParse(details.exitRouteObservations);
  const coverage = ExitRouteObservationCoverageSchema.safeParse(details.exitRouteObservationCoverage);
  return {
    scoreComponents: projectLegacyScoreComponents(details),
    exitRouteObservations: observations.success ? observations.data : null,
    exitRouteObservationCoverage: coverage.success ? coverage.data : UNKNOWN_EXIT_ROUTE_COVERAGE,
  };
}

export function buildDexDeploymentCoverage(rows: readonly DexDeploymentOutcomeRow[], nowSec: number) {
  const byStablecoin = new Map<
    string,
    {
      observedPools: number;
      verifiedNoPools: number;
      providerInaccessible: number;
      deployments: Array<Record<string, unknown>>;
    }
  >();
  for (const row of rows) {
    // Rows keyed under a superseded identity (pre-canonical lowercase non-EVM
    // addresses) are not deployments; counting them double-reports one mint.
    // loadDexLiquiditySnapshot already applies this same registry filter.
    if (!CURRENT_DEPLOYMENT_KEYS.has(deploymentKey(row.stablecoin_id, row.chain, row.contract_address))) {
      continue;
    }
    const coverage = byStablecoin.get(row.stablecoin_id) ?? {
      observedPools: 0,
      verifiedNoPools: 0,
      providerInaccessible: 0,
      deployments: [],
    };
    if (row.outcome === "observed_pools") coverage.observedPools++;
    else if (row.outcome === "verified_no_pools") coverage.verifiedNoPools++;
    else coverage.providerInaccessible++;
    const waiverActive = row.waiver_expires_at != null && row.waiver_expires_at > nowSec && !!row.waiver_owner;
    coverage.deployments.push({
      chain: row.chain,
      contractAddress: row.contract_address,
      outcome: row.outcome,
      providers: safeJsonParse<string[]>(
        row.provider_set_json,
        [],
        `dex-liquidity:${row.stablecoin_id}:${row.chain}:providers`,
      ),
      reason: row.reason,
      observedPoolCount: row.observed_pool_count,
      observedAt: row.observed_at,
      waiver: waiverActive
        ? {
            owner: row.waiver_owner,
            reason: row.waiver_reason,
            expiresAt: row.waiver_expires_at,
          }
        : null,
    });
    byStablecoin.set(row.stablecoin_id, coverage);
  }
  return byStablecoin;
}

type DexLiquidityPoolResponse = {
  source?: string;
} & Record<string, unknown>;

function normalizePoolSource(source: unknown): LiquidityPoolSourceFamily | undefined {
  if (typeof source !== "string" || source.length === 0) return undefined;
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
  "project",
  "chain",
  "symbol",
  "poolType",
  "tvlUsd",
  "volumeUsd1d",
  "price",
  "source",
]);
const ALLOWED_EXTRA_KEYS = new Set<string>([
  "amplificationCoefficient",
  "balanceRatio",
  "feeTier",
  "organicFraction",
  "pairQuality",
  "stressIndex",
  "maturityDays",
  "balanceDetails",
  "measurement",
  "effectiveTvl",
  "isMetaPool",
  "registryId",
  "lockedLiquidityPct",
  "orderbookDepthUsd",
  "orderbookDepthUpUsd",
  "orderbookTvlBasis",
  "executionCapabilityGate",
  "ammExecutionModel",
  "measuredExecution",
]);

export function normalizeTopPools(
  json: string | null,
  context = "dex-liquidity-response:top_pools_json",
): DexLiquidityPoolResponse[] {
  const parsed = safeJsonParse<unknown>(json, [], context);
  if (!Array.isArray(parsed)) return [];

  const pools: DexLiquidityPoolResponse[] = [];
  for (const pool of parsed) {
    if (!pool || typeof pool !== "object" || Array.isArray(pool)) continue;
    const poolRecord = pool as Record<string, unknown>;
    const cleaned = pickAllowedKeys(poolRecord, ALLOWED_POOL_KEYS);
    if (poolRecord.extra && typeof poolRecord.extra === "object" && !Array.isArray(poolRecord.extra)) {
      cleaned.extra = pickAllowedKeys(poolRecord.extra as Record<string, unknown>, ALLOWED_EXTRA_KEYS);
    }
    const normalizedSource = normalizePoolSource(poolRecord.source);
    if (normalizedSource != null) {
      cleaned.source = normalizedSource;
    } else {
      logWorkerEventArgs("lib", "info", "[dex-liquidity] Unknown pool source:", poolRecord.source);
      delete cleaned.source;
    }
    pools.push(cleaned as DexLiquidityPoolResponse);
  }
  return pools;
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
      logWorkerEventArgs("lib", "info", "[dex-liquidity] Malformed cron metadata:", toErrorMessage(err));
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
