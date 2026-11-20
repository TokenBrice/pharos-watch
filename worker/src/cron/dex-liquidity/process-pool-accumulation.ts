import { canonicalEvmAddress } from "@shared/lib/evm-address";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  buildPoolFingerprint,
  computePoolPairQuality,
  computePoolQualityContribution,
  computePoolStress,
  initSourcePoolGraph,
} from "./pool-helpers";
import type { CurvePoolEntry, LiquidityFallbackCounters, SourcePoolGraph } from "./types";
import type { CurveBasePoolOverlapEvidence } from "./process-pool-protocol-enrichment";
import type {
  PoolExecutionCapability,
  PoolProtocolEnrichment,
  ResolvedPoolIdentity,
} from "./process-pool-types";

export function accumulatePoolMetrics(
  metrics: Map<string, SourcePoolGraph>,
  poolId: string,
  identity: ResolvedPoolIdentity,
  enrichment: PoolProtocolEnrichment,
  capability: PoolExecutionCapability,
  stablecoinId: string,
  fallbackCounters?: LiquidityFallbackCounters,
): void {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  if (!meta) return;
  const { pool, poolSymbols, protocol, chainNorm } = identity;
  const curveData: (CurvePoolEntry & CurveBasePoolOverlapEvidence) | undefined = enrichment.curveData;
  const {
    resolvedPoolType,
    qualityMultiplier,
    organicFraction,
    hasMeasuredOrganicFraction,
    poolMaturityDays,
    rawContribTvl,
    volumeUsd1d,
    volumeUsd7d,
    volumeObservedAtSec,
  } = enrichment;
  let metric = metrics.get(stablecoinId);
  if (!metric) {
    metric = initSourcePoolGraph(stablecoinId, meta.symbol);
    metrics.set(stablecoinId, metric);
  }

  // v7.2: this coin's own side of the pool; the worst side when it is not located.
  const balanceRatio =
    (enrichment.hasMeasuredBalance ? curveData?.balanceRatioById?.[stablecoinId] : undefined) ??
    enrichment.balanceRatio;
  const pairQuality = computePoolPairQuality(poolSymbols, meta.symbol);
  // computePoolQualityContribution runs its optimistic balanceHealth=1 path when
  // no measured Curve balance data exists for this pool.
  if (fallbackCounters && !enrichment.hasMeasuredBalance) fallbackCounters.unmeasuredBalanceOptimistic++;
  const {
    qualityAdjustedTvl: poolQualityAdjustedTvl,
    effectiveTvl: poolEffectiveTvl,
  } = computePoolQualityContribution({
    qualityTvlUsd: rawContribTvl,
    effectiveTvlUsd: enrichment.effectivePoolTvl,
    qualityMultiplier,
    balanceRatio,
    pairQuality,
    hasMeasuredBalance: enrichment.hasMeasuredBalance,
  });
  const stressIndex = computePoolStress(
    balanceRatio,
    organicFraction,
    poolMaturityDays,
    pairQuality,
  );


  const poolPrice = curveData?.tokenPrices[meta.symbol.toUpperCase()];
  // Preserve the native physical identity after a proven address/unique-token join.
  // A two-token discovery row cannot dedupe a three-token Curve fingerprint.
  const exactCurveAddress = enrichment.curveAddressMatch ? curveData?.poolAddress : undefined;
  // A reviewed lock is a claim about one exact pool: it needs an address-grade
  // join, and a row that names another pool address never inherits it from a
  // shared coin-set fingerprint.
  const rowPoolAddress = canonicalEvmAddress(pool.pool);
  const exactReviewedCurveJoin =
    exactCurveAddress != null && (rowPoolAddress == null || rowPoolAddress === canonicalEvmAddress(exactCurveAddress));
  const reviewedLock = exactReviewedCurveJoin ? curveData?.permanentLiquidity : undefined;
  const curveBasePoolOverlap = exactReviewedCurveJoin ? curveData?.curveBasePoolOverlap : undefined;
  metric.pools.push({
    poolId,
    candidateFingerprint: buildPoolFingerprint(chainNorm, pool.project, pool.underlyingTokens ?? []) ?? undefined,
    project: protocol,
    chain: chainNorm,
    tvlUsd: rawContribTvl,
    ...(curveBasePoolOverlap ? { curveBasePoolOverlap } : {}),
    symbol: pool.symbol,
    volumeUsd1d,
    volumeUsd7d,
    volumeReading: { volume24hUsd: volumeUsd1d, volume7dUsd: volumeUsd7d, observedAtSec: volumeObservedAtSec },
    poolType: resolvedPoolType,
    source: "dl",
    ...(poolPrice != null ? { price: poolPrice } : {}),
    ...(poolPrice != null ? { priceObservedAt: curveData?.priceObservedAt ?? null } : {}),
    extra: {
      ...(curveData
        ? {
            amplificationCoefficient: curveData.A,
            ...(enrichment.hasMeasuredBalance ? { balanceRatio: Math.round(balanceRatio * 100) / 100 } : {}),
            registryId: curveData.registryId,
            isMetaPool: curveData.isMetaPool,
            balanceDetails: enrichment.balanceDetails,
            ...(reviewedLock ? { permanentLiquidity: reviewedLock } : {}),
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
        volumeMeasured: volumeUsd1d != null,
        balanceMeasured: enrichment.hasMeasuredBalance,
        maturityMeasured: poolMaturityDays > 0,
        priceMeasured: poolPrice != null && poolPrice > 0,
        synthetic: false,
      },
    },
  });
}
