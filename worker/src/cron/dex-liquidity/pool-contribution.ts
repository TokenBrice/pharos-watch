import { CHAIN_META } from "@shared/lib/chains";
import { canonicalExitRouteAssetKey, canonicalExitRouteChain } from "@shared/lib/exit-route-identity";
import type { LiquidityMetrics, PoolEntry, PoolMeasurementFlags, GtNewPool, CgNewPool } from "./types";
import {
  computePoolPairQuality,
  computePoolQualityContribution,
  computePoolStress,
  initMetrics,
  normalizeProtocol,
} from "./pool-helpers";
import { STAGED_POOL_DEFAULTS } from "../dex-discovery/types";

type SecondaryPool = GtNewPool | CgNewPool;

function toChainDisplay(chain: string): string {
  return CHAIN_META[canonicalExitRouteChain(chain)]?.name ?? chain;
}

export function addSecondaryPoolContribution(
  metrics: Map<string, LiquidityMetrics>,
  stablecoinId: string,
  stablecoinSymbol: string,
  pool: SecondaryPool,
  existingPoolsById?: Map<string, PoolEntry>,
): void {
  let m = metrics.get(stablecoinId);
  if (!m) {
    m = initMetrics(stablecoinId, stablecoinSymbol);
    metrics.set(stablecoinId, m);
  }

  const incomingPoolId = canonicalExitRouteAssetKey(pool.chain, pool.address);
  const existingPool = existingPoolsById
    ? existingPoolsById.get(incomingPoolId)
    : m.topPools.find((existing) => existing.poolId === incomingPoolId);
  if (existingPool) {
    if (pool.ammExecutionModel || pool.executionCapabilityGate) {
      const exactEvidence = { ...(existingPool.extra ?? {}) };
      if (pool.ammExecutionModel) {
        delete exactEvidence.executionCapabilityGate;
        exactEvidence.ammExecutionModel = pool.ammExecutionModel;
      } else if (pool.executionCapabilityGate) {
        delete exactEvidence.ammExecutionModel;
        exactEvidence.executionCapabilityGate = pool.executionCapabilityGate;
      }
      existingPool.extra = exactEvidence;
    }
    return;
  }

  const organicFraction = STAGED_POOL_DEFAULTS.organicFraction;
  const hasMeasuredBalance = pool.balanceRatio != null && Number.isFinite(pool.balanceRatio);
  const balanceRatio = hasMeasuredBalance ? pool.balanceRatio! : STAGED_POOL_DEFAULTS.balanceRatioFallback;
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
  const chainDisplay = toChainDisplay(pool.chain);
  const protocol = normalizeProtocol(pool.dexId);
  const measurement: PoolMeasurementFlags | undefined = pool.measurement;
  const lockedLiquidityPct = "lockedLiquidityPct" in pool ? pool.lockedLiquidityPct : null;
  const feeTier =
    "feePercentage" in pool
      ? pool.feePercentage != null
        ? Math.round(pool.feePercentage * 100)
        : undefined
      : pool.feeTierBps;

  m.totalTvlUsd += pool.tvlUsd;
  m.totalVolume24hUsd += pool.volume24hUsd;
  m.poolCount++;
  m.chains.add(chainDisplay);
  m.pairs.add(pool.symbol);
  m.qualityAdjustedTvl += qualityAdjustedTvl;
  m.effectiveTvl += effectiveTvl;
  m.stressWeightedSum += pool.tvlUsd * stressIndex;
  m.oldestPoolDays = Math.max(m.oldestPoolDays, pool.maturityDays);

  if (hasMeasuredBalance) {
    m.balanceRatioWeightedSum += pool.tvlUsd * balanceRatio;
    m.totalTvlForBalance += pool.tvlUsd;
  }

  if (lockedLiquidityPct != null && lockedLiquidityPct > 0) {
    m.lockedLiqWeightedSum += pool.tvlUsd * (lockedLiquidityPct / 100);
    m.totalTvlForLocked += pool.tvlUsd;
  }

  m.protocolTvl[protocol] = (m.protocolTvl[protocol] ?? 0) + pool.tvlUsd;
  m.chainTvl[chainDisplay] = (m.chainTvl[chainDisplay] ?? 0) + pool.tvlUsd;

  const poolEntry: PoolEntry = {
    poolId: incomingPoolId,
    project: protocol,
    chain: chainDisplay,
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
      ...(pool.executionCapabilityGate
        ? { executionCapabilityGate: pool.executionCapabilityGate }
        : {}),
    },
  };
  m.topPools.push(poolEntry);
  existingPoolsById?.set(incomingPoolId, poolEntry);
}
