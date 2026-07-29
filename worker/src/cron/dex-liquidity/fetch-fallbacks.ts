import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { LiquidityMetrics, DexPriceObs } from "./types";
import { getTrackedContracts } from "./pool-helpers";

const WEAK_COVERAGE_MIN_POOL_COUNT = 3;
const WEAK_COVERAGE_MIN_PROTOCOL_COUNT = 2;
const WEAK_COVERAGE_MIN_TVL_USD = 250_000;
const WEAK_COVERAGE_MIN_MEASURED_BALANCE_SHARE = 0.25;

function needsCoverageEnrichment(metric: LiquidityMetrics | undefined, observations: DexPriceObs[]): boolean {
  if (!metric) return true;
  if (needsDexScreenerEnrichment(metric, observations)) return true;
  const measuredBalanceShare = metric.totalTvlUsd > 0 ? metric.totalTvlForBalance / metric.totalTvlUsd : 0;
  return measuredBalanceShare < WEAK_COVERAGE_MIN_MEASURED_BALANCE_SHARE;
}

function needsDexScreenerEnrichment(metric: LiquidityMetrics | undefined, observations: DexPriceObs[]): boolean {
  if (!metric) return true;
  if ((metric.poolCount ?? 0) === 0) return true;
  if (observations.length === 0) return true;

  const protocolCount = new Set(observations.map((observation) => observation.protocol)).size;

  if (metric.poolCount < WEAK_COVERAGE_MIN_POOL_COUNT) return true;
  if (protocolCount < WEAK_COVERAGE_MIN_PROTOCOL_COUNT) return true;
  if (metric.totalTvlUsd < WEAK_COVERAGE_MIN_TVL_USD) return true;

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
