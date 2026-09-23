import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { LiquidityMetrics, DexPriceObs } from "./types";
import { getTrackedContracts } from "./pool-helpers";

const WEAK_COVERAGE_MIN_POOL_COUNT = 3;
const WEAK_COVERAGE_MIN_PROTOCOL_COUNT = 2;
const WEAK_COVERAGE_MIN_TVL_USD = 250_000;
const WEAK_COVERAGE_MIN_MEASURED_BALANCE_SHARE = 0.25;

interface PoolCoverageSummary {
  poolCount: number;
  totalTvlUsd: number;
  totalTvlForBalance: number;
}

// Pre-scoring metrics carry only `topPools`; the aggregate fields are rebuilt
// during scoring, so coverage is read from the pool list itself.
function summarizePools(metric: LiquidityMetrics): PoolCoverageSummary {
  let totalTvlUsd = 0;
  let totalTvlForBalance = 0;
  for (const pool of metric.topPools) {
    totalTvlUsd += pool.tvlUsd;
    const balanceRatio = pool.extra?.balanceRatio;
    if (typeof balanceRatio === "number" && Number.isFinite(balanceRatio)) totalTvlForBalance += pool.tvlUsd;
  }
  return { poolCount: metric.topPools.length, totalTvlUsd, totalTvlForBalance };
}

function needsCoverageEnrichment(metric: LiquidityMetrics | undefined, observations: DexPriceObs[]): boolean {
  if (!metric) return true;
  const pools = summarizePools(metric);
  if (needsDexScreenerEnrichment(pools, observations)) return true;
  const measuredBalanceShare = pools.totalTvlUsd > 0 ? pools.totalTvlForBalance / pools.totalTvlUsd : 0;
  return measuredBalanceShare < WEAK_COVERAGE_MIN_MEASURED_BALANCE_SHARE;
}

function needsDexScreenerEnrichment(
  pools: PoolCoverageSummary,
  observations: DexPriceObs[],
): boolean {
  if (pools.poolCount === 0) return true;
  if (observations.length === 0) return true;

  const protocolCount = new Set(observations.map((observation) => observation.protocol)).size;

  if (pools.poolCount < WEAK_COVERAGE_MIN_POOL_COUNT) return true;
  if (protocolCount < WEAK_COVERAGE_MIN_PROTOCOL_COUNT) return true;
  if (pools.totalTvlUsd < WEAK_COVERAGE_MIN_TVL_USD) return true;

  return false;
}

export function getFallbackTargets(
  metrics: Map<string, LiquidityMetrics>,
  priceObservations: Map<string, DexPriceObs[]>,
  options: {
    requireGeckoId?: boolean;
    requireTrackedContracts?: boolean;
  } = {},
): typeof ACTIVE_STABLECOINS {
  return ACTIVE_STABLECOINS.filter((meta) => {
    if (options.requireGeckoId && !meta.geckoId) return false;
    if (options.requireTrackedContracts && getTrackedContracts(meta).length === 0) return false;
    const metric = metrics.get(meta.id);
    const observations = priceObservations.get(meta.id) ?? [];
    return needsCoverageEnrichment(metric, observations);
  });
}
