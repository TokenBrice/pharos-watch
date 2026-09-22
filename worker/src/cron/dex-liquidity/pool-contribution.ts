import { canonicalExitRouteAssetKey, canonicalExitRouteChain } from "@shared/lib/exit-route-identity";
import type { LiquidityFallbackCounters, LiquidityMetrics, PoolEntry, PoolMeasurementFlags, GtNewPool, CgNewPool } from "./types";
import {
  computePoolPairQuality,
  computePoolQualityContribution,
  computePoolStress,
  initMetrics,
  normalizeProtocol,
} from "./pool-helpers";
import { STAGED_POOL_DEFAULTS } from "../dex-discovery/types";

type SecondaryPool = GtNewPool | CgNewPool;

export function addSecondaryPoolContribution(
  metrics: Map<string, LiquidityMetrics>,
  stablecoinId: string,
  stablecoinSymbol: string,
  pool: SecondaryPool,
  existingPoolsById?: Map<string, PoolEntry>,
  fallbackCounters?: LiquidityFallbackCounters,
): void {
  let m = metrics.get(stablecoinId);
  if (!m) {
    m = initMetrics(stablecoinId, stablecoinSymbol);
    metrics.set(stablecoinId, m);
  }

  const chain = canonicalExitRouteChain(pool.chain);
  const incomingPoolId = canonicalExitRouteAssetKey(chain, pool.address);
  const existingPool = existingPoolsById
    ? existingPoolsById.get(incomingPoolId)
    : m.topPools.find((existing) => existing.poolId === incomingPoolId);
  if (existingPool) {
    if (pool.ammExecutionModel || pool.executionCapabilityGate || pool.evmV2ExecutionCandidate) {
      const exactEvidence = { ...(existingPool.extra ?? {}) };
      if (pool.ammExecutionModel) {
        delete exactEvidence.executionCapabilityGate;
        exactEvidence.ammExecutionModel = pool.ammExecutionModel;
      } else if (pool.executionCapabilityGate) {
        delete exactEvidence.ammExecutionModel;
        exactEvidence.executionCapabilityGate = pool.executionCapabilityGate;
      }
      if (pool.evmV2ExecutionCandidate && !exactEvidence.ammExecutionModel) {
        exactEvidence.evmV2ExecutionCandidate = pool.evmV2ExecutionCandidate;
      }
      existingPool.extra = exactEvidence;
    }
    return;
  }

  const organicFraction = STAGED_POOL_DEFAULTS.organicFraction;
  const hasMeasuredBalance = pool.balanceRatio != null && Number.isFinite(pool.balanceRatio);
  const balanceRatio = hasMeasuredBalance ? pool.balanceRatio! : STAGED_POOL_DEFAULTS.balanceRatioFallback;
  if (fallbackCounters) {
    fallbackCounters.stagedOrganicFractionDefault++;
    if (!hasMeasuredBalance) {
      fallbackCounters.stagedBalanceRatioFallback++;
      // computePoolQualityContribution below runs its optimistic balanceHealth=1 path.
      fallbackCounters.unmeasuredBalanceOptimistic++;
    }
  }
  const pairQuality =
    pool.pairQualityOverride != null && Number.isFinite(pool.pairQualityOverride)
      ? pool.pairQualityOverride
      : computePoolPairQuality(
          (pool.symbol ?? "").split(/\s*\/\s*/).map((s) => s.trim()),
          stablecoinSymbol,
        );
  const { qualityAdjustedTvl, effectiveTvl } = computePoolQualityContribution({
    qualityTvlUsd: pool.tvlUsd,
    effectiveTvlUsd: pool.tvlUsd,
    qualityMultiplier: pool.qualityMultiplier,
    balanceRatio,
    pairQuality,
    hasMeasuredBalance,
  });
  const stressIndex = computePoolStress(balanceRatio, organicFraction, pool.maturityDays, pairQuality);
  const protocol = normalizeProtocol(pool.dexId);
  const measurement: PoolMeasurementFlags | undefined = pool.measurement;
  const lockedLiquidityPct = "lockedLiquidityPct" in pool ? pool.lockedLiquidityPct : null;
  const feeTier =
    "feePercentage" in pool
      ? pool.feePercentage != null
        ? Math.round(pool.feePercentage * 100)
        : undefined
      : pool.feeTierBps;


  const poolEntry: PoolEntry = {
    poolId: incomingPoolId,
    project: protocol,
    chain,
    tvlUsd: pool.tvlUsd,
    symbol: pool.symbol,
    volumeUsd1d: pool.volume24hUsd,
    volumeUsd7d: pool.volume7dUsd ?? null,
    poolType: pool.poolType,
    source: pool.sourceFamily,
    ...(pool.price > 0 ? { price: pool.price } : {}),
    extra: {
      ...(hasMeasuredBalance
        ? {
            balanceRatio: Math.round(balanceRatio * 100) / 100,
            balanceDetails: pool.balanceDetails,
          }
        : {}),
      ...(feeTier != null ? { feeTier } : {}),
      qualityAdjustedTvl: Math.round(qualityAdjustedTvl),
      effectiveTvl: Math.round(effectiveTvl),
      organicFraction,
      hasMeasuredOrganicFraction: false,
      pairQuality: Math.round(pairQuality * 100) / 100,
      stressIndex,
      maturityDays: pool.maturityDays,
      ...(lockedLiquidityPct != null ? { lockedLiquidityPct } : {}),
      ...(pool.orderbookDepthUsd != null ? { orderbookDepthUsd: Math.round(pool.orderbookDepthUsd) } : {}),
      ...(pool.orderbookDepthUpUsd != null ? { orderbookDepthUpUsd: Math.round(pool.orderbookDepthUpUsd) } : {}),
      ...(pool.orderbookTvlBasis ? { orderbookTvlBasis: pool.orderbookTvlBasis } : {}),
      ...(measurement ? { measurement } : {}),
      ...(pool.ammExecutionModel ? { ammExecutionModel: pool.ammExecutionModel } : {}),
      ...(pool.evmV2ExecutionCandidate ? { evmV2ExecutionCandidate: pool.evmV2ExecutionCandidate } : {}),
      ...(pool.executionCapabilityGate ? { executionCapabilityGate: pool.executionCapabilityGate } : {}),
    },
  };
  m.topPools.push(poolEntry);
  existingPoolsById?.set(incomingPoolId, poolEntry);
}
