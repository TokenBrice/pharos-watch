import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { canonicalExitRouteAssetKey } from "@shared/lib/exit-route-identity";
import {
  buildPoolFingerprint,
  computePoolPairQuality,
  computePoolQualityContribution,
  computePoolStress,
  initMetrics,
} from "./pool-helpers";
import { isTrustworthyExactPoolId } from "./pool-identity";
import type { LiquidityMetrics } from "./types";
import type {
  PoolExecutionCapability,
  PoolProtocolEnrichment,
  ResolvedPoolIdentity,
} from "./process-pool-types";

export function accumulatePoolMetrics(
  metrics: Map<string, LiquidityMetrics>,
  identity: ResolvedPoolIdentity,
  enrichment: PoolProtocolEnrichment,
  capability: PoolExecutionCapability,
  stablecoinId: string,
): void {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  if (!meta) return;
  const { pool, poolSymbols, protocol, chainNorm } = identity;
  const {
    curveData,
    resolvedPoolType,
    qualityMultiplier,
    balanceRatio,
    organicFraction,
    hasMeasuredOrganicFraction,
    poolMaturityDays,
    rawContribTvl,
    volumeUsd1d,
    volumeUsd7d,
  } = enrichment;
  let metric = metrics.get(stablecoinId);
  if (!metric) {
    metric = initMetrics(stablecoinId, meta.symbol);
    metrics.set(stablecoinId, metric);
  }

  const pairQuality = computePoolPairQuality(poolSymbols, meta.symbol);
  const {
    qualityAdjustedTvl: poolQualityAdjustedTvl,
    effectiveTvl: poolEffectiveTvl,
  } = computePoolQualityContribution({
    qualityTvlUsd: pool.tvlUsd,
    effectiveTvlUsd: enrichment.effectivePoolTvl,
    qualityMultiplier,
    balanceRatio,
    pairQuality,
    hasMeasuredBalance: curveData != null,
  });
  const stressIndex = computePoolStress(
    balanceRatio,
    organicFraction,
    poolMaturityDays,
    pairQuality,
  );

  metric.totalTvlUsd += rawContribTvl;
  metric.totalVolume24hUsd += volumeUsd1d;
  metric.totalVolume7dUsd += volumeUsd7d;
  metric.poolCount++;
  metric.chains.add(pool.chain);
  metric.pairs.add(pool.symbol);
  metric.qualityAdjustedTvl += poolQualityAdjustedTvl;
  metric.effectiveTvl += poolEffectiveTvl;
  if (curveData) {
    metric.balanceRatioWeightedSum += pool.tvlUsd * balanceRatio;
    metric.totalTvlForBalance += pool.tvlUsd;
  }
  if (hasMeasuredOrganicFraction) {
    metric.organicTvlWeightedSum += pool.tvlUsd * organicFraction;
    metric.totalTvlForOrganic += pool.tvlUsd;
  }
  metric.stressWeightedSum += pool.tvlUsd * stressIndex;
  metric.oldestPoolDays = Math.max(metric.oldestPoolDays, poolMaturityDays);
  metric.protocolTvl[protocol] =
    (metric.protocolTvl[protocol] ?? 0) + rawContribTvl;
  metric.chainTvl[pool.chain] =
    (metric.chainTvl[pool.chain] ?? 0) + rawContribTvl;

  const poolPrice = curveData?.tokenPrices[meta.symbol.toUpperCase()];
  metric.topPools.push({
    poolId: isTrustworthyExactPoolId(pool.pool, pool.project)
      ? canonicalExitRouteAssetKey(pool.chain, pool.pool)
      : (buildPoolFingerprint(
          chainNorm,
          pool.project,
          pool.underlyingTokens ?? [],
        ) ?? canonicalExitRouteAssetKey(pool.chain, pool.pool)),
    project: protocol,
    chain: pool.chain,
    tvlUsd: rawContribTvl,
    symbol: pool.symbol,
    volumeUsd1d,
    volumeUsd7d,
    poolType: resolvedPoolType,
    source: "dl",
    ...(poolPrice != null ? { price: poolPrice } : {}),
    extra: {
      ...(curveData
        ? {
            amplificationCoefficient: curveData.A,
            balanceRatio: Math.round(balanceRatio * 100) / 100,
            registryId: curveData.registryId,
            isMetaPool: curveData.isMetaPool,
            balanceDetails: enrichment.balanceDetails,
          }
        : enrichment.feeTierForExtra != null
          ? { feeTier: Math.round(enrichment.feeTierForExtra / 100) }
          : {}),
      ...capability,
      qualityAdjustedTvl: Math.round(poolQualityAdjustedTvl),
      effectiveTvl: Math.round(poolEffectiveTvl),
      organicFraction: Math.round(organicFraction * 100) / 100,
      hasMeasuredOrganicFraction,
      pairQuality: Math.round(pairQuality * 100) / 100,
      stressIndex,
      maturityDays: poolMaturityDays,
      measurement: {
        tvlMeasured: true,
        volumeMeasured: volumeUsd1d > 0 || volumeUsd7d > 0,
        balanceMeasured: curveData != null,
        maturityMeasured: poolMaturityDays > 0,
        priceMeasured: poolPrice != null && poolPrice > 0,
        synthetic: false,
      },
    },
  });
}
