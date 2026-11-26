import { directUsdVenueKeys, getDexGroupLineage, getDexObservationLineage, readDexPriceLineage } from "./price-lineage";
import { retainedPoolVolumeSanityRejection } from "./pool-volume-sanity";
import type { CurveBasePoolOverlapEvidence } from "./process-pool-protocol-enrichment";
import {
  CURVE_NAV_SPOT_QUOTE_POLICY,
  CURVE_NAV_SPOT_QUOTE_POLICY_ID,
  isCurveNavSpotQuoteEvidenceShape,
  type CurveNavSpotQuoteCandidate,
  type CurveNavSpotQuoteEvidence,
  type DexPoolVolumeReading,
  type DexPriceObs,
  type LiquidityCoverageClass,
  type LiquidityFallbackCounters,
  type LiquidityMetrics,
  type LiquiditySourceMixByFamily,
  type PoolEntry,
} from "./types";
export { isCurveNavSpotQuoteEvidenceShape };
import type { DexVolumeAvailabilityRecord } from "@shared/types/dex-liquidity";
import { isBlockedDexId } from "../../lib/dex-cron-constants";
import { DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../../lib/dex-cron-constants";
import { pricesAgreeWithinBps } from "../../lib/price-divergence";
import { clamp } from "@shared/lib/math";
import { normalizePricingSourceKeys } from "@shared/lib/pricing-sources";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { median, weightedMedian } from "@shared/lib/stats";
import {
  DEX_DEAD_POOL_TVL_MIN_USD,
  classifyDexPoolVolumeObservation,
  summarizeDexVolumeWindow,
} from "@shared/lib/dex-volume-availability";
import { normalizeProtocol } from "./pool-helpers";
import { logWorkerEvent } from "../../lib/structured-log";
import { CG_TICKER_PRICE_MIN_VOLUME_USD, dexPriceEvidenceWeight } from "./coingecko-tickers-shared";
import { canonicalExitRouteChain, canonicalExitRouteScopedKey } from "@shared/types/exit-route-identity";

import type { DexLiquidityProtocolTvlQuarantine } from "../../lib/schemas";
/** Evaluation clock for DEC-19 volume windows: the run's source clock plus the producer budget. */
export type DexVolumeClock = Parameters<typeof summarizeDexVolumeWindow>[2];

const MISSING_VOLUME_READING: DexPoolVolumeReading = { volume24hUsd: null, volume7dUsd: null, observedAtSec: null };

/**
 * DEC-19 eligibility pass. Classifies each pool's raw readings against the run
 * clock, keeps only in-window values in `volumeUsd1d` / `volumeUsd7d` (an aged
 * or absent reading becomes null, never a decayed or zero value), and records
 * the published 24h observation. Idempotent: it always reads `volumeReading`.
 */
export function applyPoolVolumeEligibility(pools: readonly PoolEntry[], clock: DexVolumeClock): void {
  for (const pool of pools) {
    const reading = pool.volumeReading ?? MISSING_VOLUME_READING;
    const observedAtSec = reading.observedAtSec;
    const status24h = classifyDexPoolVolumeObservation({ volumeUsd: reading.volume24hUsd, observedAtSec }, clock);
    const status7d = classifyDexPoolVolumeObservation({ volumeUsd: reading.volume7dUsd, observedAtSec }, clock);
    pool.volumeUsd1d = status24h === "measured" ? reading.volume24hUsd : null;
    pool.volumeUsd7d = status7d === "measured" ? reading.volume7dUsd : null;
    pool.volumeObservation = {
      status: status24h,
      observedAtSec: observedAtSec != null && Number.isInteger(observedAtSec) && observedAtSec >= 0 ? observedAtSec : null,
    };
    if (pool.extra?.measurement) pool.extra.measurement.volumeMeasured = status24h === "measured";
  }
}

export interface RetainedPoolVolumeSummary {
  totalVolume24hUsd: number | null;
  totalVolume7dUsd: number | null;
  volumeAvailability: DexVolumeAvailabilityRecord;
}

/** One retained pool's raw readings and its retained scoring TVL (the coverage weight). */
export interface RetainedPoolVolumeInput {
  reading: DexPoolVolumeReading | undefined;
  tvlUsd: number;
}

/**
 * Summarize both measured-volume windows over a COMPLETE retained (or globally
 * deduped) pool set — never the visible top-N. Only admitted observations enter
 * a sum or the admitted TVL; the total is null unless every pool was admitted,
 * and each window records its admitted share of the retained TVL.
 */
export function summarizeRetainedPoolVolume(
  pools: readonly RetainedPoolVolumeInput[],
  clock: DexVolumeClock,
): RetainedPoolVolumeSummary {
  const window24h = summarizeDexVolumeWindow(
    pools.map(({ reading, tvlUsd }) => ({ volumeUsd: reading?.volume24hUsd, observedAtSec: reading?.observedAtSec, tvlUsd })),
    "24h",
    clock,
  );
  const window7d = summarizeDexVolumeWindow(
    pools.map(({ reading, tvlUsd }) => ({ volumeUsd: reading?.volume7dUsd, observedAtSec: reading?.observedAtSec, tvlUsd })),
    "7d",
    clock,
  );
  return {
    totalVolume24hUsd: window24h.measuredUsd,
    totalVolume7dUsd: window7d.measuredUsd,
    volumeAvailability: { "24h": window24h.availability, "7d": window7d.availability },
  };
}

type PoolExtra = NonNullable<LiquidityMetrics["topPools"][number]["extra"]>;
type PoolExtraKey = keyof PoolExtra;

export function hasScoreFacingMeasuredExecution(pool: PoolEntry): boolean {
  const extra = pool.extra;
  return Boolean(
    extra?.measuredExecutionTarget ||
      extra?.measuredExecutionTargets?.length ||
      extra?.measuredExecution ||
      extra?.measuredExecutions?.length ||
      extra?.measuredExecutionProfile ||
      extra?.measuredExecutionProfiles?.length,
  );
}

export function resolveUniqueTrackedTokenIndex(
  assetIds: readonly (string | undefined)[],
  stablecoinId: string,
):
  | { trackedTokenIndex: number; reason: null }
  | { trackedTokenIndex: null; reason: "tracked-input-unresolved" | "ambiguous-token-identity" } {
  const trackedIndexes = assetIds
    .map((assetId, index) => (assetId === stablecoinId ? index : -1))
    .filter((index) => index >= 0);
  return trackedIndexes.length === 1
    ? { trackedTokenIndex: trackedIndexes[0]!, reason: null }
    : {
        trackedTokenIndex: null,
        reason: trackedIndexes.length === 0 ? "tracked-input-unresolved" : "ambiguous-token-identity",
      };
}

function getPoolExtraNumber(
  extra: LiquidityMetrics["topPools"][number]["extra"] | undefined,
  key: PoolExtraKey,
): number | null {
  const value = extra?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getPoolExtraBoolean(
  extra: LiquidityMetrics["topPools"][number]["extra"] | undefined,
  key: PoolExtraKey,
): boolean | null {
  const value = extra?.[key];
  return typeof value === "boolean" ? value : null;
}

function normalizeSourceFamily(value: string | null | undefined): string | undefined {
  const normalized = (value ?? "").trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function rebuildMetricsFromPools(
  pools: LiquidityMetrics["topPools"],
  fallbackCounters?: LiquidityFallbackCounters,
) {
  const protocolTvl: Record<string, number> = {};
  const chainTvl: Record<string, number> = {};
  const sourceMix: LiquiditySourceMixByFamily = {};
  const chains = new Set<string>();
  const pairs = new Set<string>();

  let totalTvlUsd = 0;
  let qualityAdjustedTvl = 0;
  let effectiveTvl = 0;
  let balanceRatioWeightedSum = 0;
  let totalTvlForBalance = 0;
  let organicTvlWeightedSum = 0;
  let totalTvlForOrganic = 0;
  let stressWeightedSum = 0;
  let oldestPoolDays = 0;
  let lockedLiqWeightedSum = 0;
  let totalTvlForLocked = 0;
  let syntheticTvlUsd = 0;
  let decayedTvlUsd = 0;
  let measuredPriceTvlUsd = 0;

  for (const pool of pools) {
    const proto = normalizeProtocol(pool.project);
    protocolTvl[proto] = (protocolTvl[proto] ?? 0) + pool.tvlUsd;
    chainTvl[pool.chain] = (chainTvl[pool.chain] ?? 0) + pool.tvlUsd;
    const sourceEntry = sourceMix[pool.source] ?? { poolCount: 0, tvlUsd: 0 };
    sourceEntry.poolCount += 1;
    sourceEntry.tvlUsd += pool.tvlUsd;
    sourceMix[pool.source] = sourceEntry;
    chains.add(pool.chain);
    pairs.add(pool.symbol);

    totalTvlUsd += pool.tvlUsd;
    const poolQualityAdjustedTvl = getPoolExtraNumber(pool.extra, "qualityAdjustedTvl");
    const poolEffectiveTvl = getPoolExtraNumber(pool.extra, "effectiveTvl");
    if (fallbackCounters && poolQualityAdjustedTvl == null) fallbackCounters.rebuildQualityAdjustedTvlFallback++;
    if (fallbackCounters && poolEffectiveTvl == null) fallbackCounters.rebuildEffectiveTvlFallback++;
    qualityAdjustedTvl += poolQualityAdjustedTvl ?? pool.tvlUsd;
    effectiveTvl += poolEffectiveTvl ?? pool.tvlUsd;

    const balanceRatio = getPoolExtraNumber(pool.extra, "balanceRatio");
    if (balanceRatio != null) {
      balanceRatioWeightedSum += pool.tvlUsd * balanceRatio;
      totalTvlForBalance += pool.tvlUsd;
    }

    const organicFraction = getPoolExtraNumber(pool.extra, "organicFraction");
    const hasMeasuredOrganicFraction = getPoolExtraBoolean(pool.extra, "hasMeasuredOrganicFraction") ?? false;
    if (organicFraction != null && hasMeasuredOrganicFraction) {
      organicTvlWeightedSum += pool.tvlUsd * organicFraction;
      totalTvlForOrganic += pool.tvlUsd;
    }

    const stressIndex = getPoolExtraNumber(pool.extra, "stressIndex");
    if (stressIndex != null) {
      stressWeightedSum += pool.tvlUsd * stressIndex;
    }

    const maturityDays = getPoolExtraNumber(pool.extra, "maturityDays");
    if (maturityDays != null) {
      oldestPoolDays = Math.max(oldestPoolDays, maturityDays);
    }

    const lockedLiquidityPct = getPoolExtraNumber(pool.extra, "lockedLiquidityPct");
    if (lockedLiquidityPct != null) {
      lockedLiqWeightedSum += pool.tvlUsd * (lockedLiquidityPct / 100);
      totalTvlForLocked += pool.tvlUsd;
    }

    const measurement = pool.extra?.measurement;
    if (measurement?.synthetic) syntheticTvlUsd += pool.tvlUsd;
    if (measurement?.decayed) decayedTvlUsd += pool.tvlUsd;
    if (measurement?.priceMeasured) measuredPriceTvlUsd += pool.tvlUsd;
  }

  let hhi = 0;
  if (totalTvlUsd > 0) {
    for (const pool of pools) {
      const share = pool.tvlUsd / totalTvlUsd;
      hhi += share * share;
    }
  }

  // Unobserved/aged flow (null) ranks below a measured zero; TVL breaks ties.
  const visiblePools = [...pools]
    .sort((a, b) => (b.volumeUsd1d ?? -1) - (a.volumeUsd1d ?? -1) || b.tvlUsd - a.tvlUsd)
    .slice(0, 10);

  return {
    totalTvlUsd,
    poolCount: pools.length,
    chains,
    pairs,
    protocolTvl,
    chainTvl,
    sourceMix,
    qualityAdjustedTvl,
    effectiveTvl,
    balanceRatioWeightedSum,
    totalTvlForBalance,
    organicTvlWeightedSum,
    totalTvlForOrganic,
    stressWeightedSum,
    oldestPoolDays,
    lockedLiqWeightedSum,
    totalTvlForLocked,
    hhi,
    visiblePools,
    sourceFamilyCount: Object.keys(sourceMix).length,
    protocolCount: Object.keys(protocolTvl).length,
    syntheticTvlUsd,
    decayedTvlUsd,
    measuredPriceTvlUsd,
  };
}

/**
 * Liquidity v6.92 dead-pool floor. A pool is dead when its scoring TVL is at
 * least DEX_DEAD_POOL_TVL_MIN_USD, its admitted (in-window) 24h reading is zero,
 * and the staged merge stamped that reading with the dead-pool signature (a
 * trade-verified zero on a pool whose counter-tokens are not tracked stablecoin
 * deployments). `volumeUsd1d` must be the in-window value: the DEC-19 eligibility
 * pass output at scoring, or the same classification at merge time.
 */
export function isDeadPool(pool: Pick<PoolEntry, "tvlUsd" | "volumeUsd1d" | "volumeReading">): boolean {
  return pool.volumeReading?.deadPoolSignature === true &&
    pool.volumeUsd1d === 0 &&
    pool.tvlUsd >= DEX_DEAD_POOL_TVL_MIN_USD;
}

/** Pools and scoring TVL removed by the dead-pool floor. */
export interface DeadPoolExclusionTally {
  poolCount: number;
  tvlUsd: number;
}

export function filterRetainedPools(
  pools: LiquidityMetrics["topPools"],
  fallbackCounters?: LiquidityFallbackCounters,
  deadPoolTally?: DeadPoolExclusionTally,
): LiquidityMetrics["topPools"] {
  return pools.filter((pool) => {
    if (isBlockedDexId(pool.project)) {
      if (fallbackCounters) fallbackCounters.retainedExclusionBlockedDex++;
      return false;
    }
    // Runs after the DEC-19 eligibility pass: `volumeUsd1d` is an in-window
    // reading or null. The ratio sanity check needs a reading; the large-pool
    // floor treats unobserved or aged flow as not clearing it.
    const rejection = retainedPoolVolumeSanityRejection(pool.tvlUsd, pool.volumeUsd1d);
    if (rejection === "volume-to-tvl-ratio") {
      if (fallbackCounters) fallbackCounters.retainedExclusionVolTvlRatio++;
      return false;
    }
    if (rejection === "large-pool-low-volume") {
      if (fallbackCounters) fallbackCounters.retainedExclusionLargePoolLowVolume++;
      return false;
    }
    if (isDeadPool(pool)) {
      if (deadPoolTally) {
        deadPoolTally.poolCount++;
        deadPoolTally.tvlUsd += pool.tvlUsd;
      }
      return false;
    }
    return true;
  });
}

export function isP4OnlyPausedBalancerPool(pool: PoolEntry): boolean {
  const gate = pool.extra?.executionCapabilityGate;
  return gate?.family === "balancer-amm" && gate.reason === "paused-or-swap-disabled";
}

export function hasDexPricePrimaryReference(price: number | null | undefined): price is number {
  return price != null && price > 0;
}

function isProtocolTvlFallbackSource(source: LiquidityMetrics["topPools"][number]["source"]): boolean {
  return source === "cg_onchain" ||
    source === "gecko_terminal" ||
    source === "dexscreener" ||
    source === "cg_tickers" ||
    source === "horizon" ||
    source === "aquarius" ||
    source === "tezos" ||
    source === "icon-balanced" ||
    source === "kava-swap" ||
    source === "osmosis-sqs" ||
    source === "noble-swap" ||
    source === "sundaeswap";
}

/**
 * Reject the suspect fallback group, never scale its observations to fit.
 * Headroom is evaluated per coin as before; a rejection follows the physical
 * fallback pool across every coin attribution. Trusted sources remain intact.
 */
export function quarantineProtocolTvlOutliers(
  poolsByStablecoin: Map<string, LiquidityMetrics["topPools"]>,
  protocolTvlCaps: Map<string, number>,
): DexLiquidityProtocolTvlQuarantine {
  const rejectedPools = new Map<string, PoolEntry>();
  const rejectedProtocols = new Set<string>();
  if (protocolTvlCaps.size > 0) {
    for (const pools of poolsByStablecoin.values()) {
      const fallbackTvl = new Map<string, number>();
      const trustedTvl = new Map<string, number>();
      for (const pool of pools) {
        const proto = normalizeProtocol(pool.project);
        const totals = isProtocolTvlFallbackSource(pool.source) ? fallbackTvl : trustedTvl;
        totals.set(proto, (totals.get(proto) ?? 0) + pool.tvlUsd);
      }
      const suspectProtocols = new Set<string>();
      for (const [proto, tvl] of fallbackTvl) {
        const cap = protocolTvlCaps.get(proto);
        if (cap == null || !Number.isFinite(cap) || cap <= 0) continue;
        if (tvl > Math.max(0, cap - (trustedTvl.get(proto) ?? 0))) suspectProtocols.add(proto);
      }
      for (const pool of pools) {
        const proto = normalizeProtocol(pool.project);
        if (!isProtocolTvlFallbackSource(pool.source) || !suspectProtocols.has(proto)) continue;
        const key = canonicalExitRouteScopedKey(pool.chain, pool.poolId);
        const previous = rejectedPools.get(key);
        if (!previous || pool.tvlUsd > previous.tvlUsd) rejectedPools.set(key, pool);
        rejectedProtocols.add(proto);
      }
    }
  }
  if (rejectedPools.size > 0) {
    for (const [id, pools] of poolsByStablecoin) {
      poolsByStablecoin.set(id, pools.filter((pool) =>
        !isProtocolTvlFallbackSource(pool.source) ||
        !rejectedPools.has(canonicalExitRouteScopedKey(pool.chain, pool.poolId))));
    }
  }
  let tvlUsd = 0;
  for (const pool of rejectedPools.values()) tvlUsd += pool.tvlUsd;
  return {
    reason: "fallback-protocol-tvl-exceeds-headroom",
    poolCount: rejectedPools.size,
    protocolCount: rejectedProtocols.size,
    tvlUsd: Math.round(tvlUsd),
  };
}


export interface GlobalPoolAggregateEntry extends CurveBasePoolOverlapEvidence {
  tvl: number;
  reading: DexPoolVolumeReading | undefined;
  proto: string;
  chain: string;
}

export function accumulateGlobalAggregate(
  pools: readonly (PoolEntry & CurveBasePoolOverlapEvidence)[],
  globalProtocolTvl: Record<string, number>,
  globalChainTvl: Record<string, number>,
  globalChains: Set<string>,
  seenPoolTvl: Map<string, GlobalPoolAggregateEntry>,
): { totalTvl: number; poolCount: number } {
  let totalTvl = 0;
  let poolCount = 0;

  for (const pool of pools) {
    const proto = normalizeProtocol(pool.project);
    const chainKey = canonicalExitRouteChain(pool.chain);
    const poolKey = pool.poolId.startsWith(`${chainKey}:defillama:`)
      ? pool.poolId
      : canonicalExitRouteScopedKey(chainKey, pool.poolId);
    const prev = seenPoolTvl.get(poolKey);

    // The highest-TVL occurrence owns the deduped pool, including its volume reading and valuation basis.
    if (prev != null && !(pool.tvlUsd > prev.tvl)) continue;
    if (prev != null) {
      totalTvl -= prev.tvl;
      globalProtocolTvl[prev.proto] = (globalProtocolTvl[prev.proto] ?? 0) - prev.tvl;
      globalChainTvl[prev.chain] = (globalChainTvl[prev.chain] ?? 0) - prev.tvl;
    } else {
      poolCount++;
    }

    seenPoolTvl.set(poolKey, {
      tvl: pool.tvlUsd, reading: pool.volumeReading, proto, chain: chainKey,
      ...(pool.curveBasePoolOverlap ? { curveBasePoolOverlap: pool.curveBasePoolOverlap } : {}),
    });
    totalTvl += pool.tvlUsd;
    globalChains.add(chainKey);
    globalProtocolTvl[proto] = (globalProtocolTvl[proto] ?? 0) + pool.tvlUsd;
    globalChainTvl[chainKey] = (globalChainTvl[chainKey] ?? 0) + pool.tvlUsd;
  }

  return { totalTvl, poolCount };
}

export function netGlobalCurveBaseLpOverlap(
  seenPoolTvl: ReadonlyMap<string, GlobalPoolAggregateEntry>,
  globalProtocolTvl: Record<string, number>,
  globalChainTvl: Record<string, number>,
): number {
  const claimedTvl = new Map<string, number>();
  const claims: { pool: GlobalPoolAggregateEntry; basePoolKey: string; lpLegTvlUsd: number }[] = [];
  for (const [poolKey, pool] of seenPoolTvl) {
    const overlap = pool.curveBasePoolOverlap;
    if (pool.proto !== "curve" || !overlap || overlap.basePoolKey === poolKey) continue;
    const { basePoolKey, lpLegTvlUsd } = overlap;
    const base = seenPoolTvl.get(basePoolKey);
    if (
      base?.proto !== "curve" || base.chain !== pool.chain ||
      !Number.isFinite(lpLegTvlUsd) || lpLegTvlUsd <= 0 || lpLegTvlUsd > pool.tvl
    ) continue;
    claimedTvl.set(basePoolKey, (claimedTvl.get(basePoolKey) ?? 0) + lpLegTvlUsd);
    claims.push({ pool, basePoolKey, lpLegTvlUsd });
  }

  let removedTvl = 0;
  for (const { pool, basePoolKey, lpLegTvlUsd } of claims) {
    const share = Math.min(1, seenPoolTvl.get(basePoolKey)!.tvl / claimedTvl.get(basePoolKey)!);
    const overlapTvl = lpLegTvlUsd * share;
    pool.tvl -= overlapTvl;
    globalProtocolTvl[pool.proto] -= overlapTvl;
    globalChainTvl[pool.chain] -= overlapTvl;
    removedTvl += overlapTvl;
  }
  return removedTvl;
}

/**
 * Coverage-confidence blending weights. The baseline is a low-trust floor;
 * bonuses reward protocol/source breadth and measured-vs-inferred TVL share;
 * penalties dock synthetic or freshness-decayed TVL share.
 */
const COVERAGE_CONFIDENCE = {
  baseline: 0.35,
  protocolBonusPer: 0.05,
  protocolBonusMax: 0.2,
  sourceFamilyBonusPer: 0.05,
  sourceFamilyBonusMax: 0.15,
  balanceMeasuredMult: 0.1,
  balanceMeasuredMax: 0.1,
  organicMeasuredMult: 0.05,
  organicMeasuredMax: 0.05,
  priceMeasuredMult: 0.1,
  priceMeasuredMax: 0.1,
  syntheticPenaltyMult: 0.35,
  syntheticPenaltyMax: 0.25,
  decayedPenaltyMult: 0.2,
  decayedPenaltyMax: 0.15,
  primaryClassBonus: 0.15,
  mixedClassBonus: 0.05,
  fallbackClassPenalty: 0.05,
} as const;

function clampConfidence(confidence: number): number {
  return clamp(Number(confidence.toFixed(2)), 0, 1);
}

export function classifyCoverage(input: {
  sourceMix: LiquiditySourceMixByFamily;
  totalTvlUsd: number;
  protocolCount: number;
  sourceFamilyCount: number;
  balanceMeasuredTvlUsd: number;
  organicMeasuredTvlUsd: number;
  syntheticTvlUsd: number;
  decayedTvlUsd: number;
  measuredPriceTvlUsd: number;
}): {
  coverageClass: LiquidityCoverageClass;
  coverageConfidence: number;
} {
  const {
    sourceMix,
    totalTvlUsd,
    protocolCount,
    sourceFamilyCount,
    balanceMeasuredTvlUsd,
    organicMeasuredTvlUsd,
    syntheticTvlUsd,
    decayedTvlUsd,
    measuredPriceTvlUsd,
  } = input;
  if (totalTvlUsd <= 0 || Object.keys(sourceMix).length === 0) {
    return { coverageClass: "unobserved", coverageConfidence: 0 };
  }

  const primaryTvl = (sourceMix.dl?.tvlUsd ?? 0) + (sourceMix.direct_api?.tvlUsd ?? 0);
  const fallbackTvl = Math.max(0, totalTvlUsd - primaryTvl);
  const balanceMeasuredShare = balanceMeasuredTvlUsd / totalTvlUsd;
  const organicMeasuredShare = organicMeasuredTvlUsd / totalTvlUsd;
  const syntheticShare = syntheticTvlUsd / totalTvlUsd;
  const decayedShare = decayedTvlUsd / totalTvlUsd;
  const measuredPriceShare = measuredPriceTvlUsd / totalTvlUsd;

  const C = COVERAGE_CONFIDENCE;
  let confidence = C.baseline;
  confidence += Math.min(C.protocolBonusMax, protocolCount * C.protocolBonusPer);
  confidence += Math.min(C.sourceFamilyBonusMax, sourceFamilyCount * C.sourceFamilyBonusPer);
  confidence += Math.min(C.balanceMeasuredMax, balanceMeasuredShare * C.balanceMeasuredMult);
  confidence += Math.min(C.organicMeasuredMax, organicMeasuredShare * C.organicMeasuredMult);
  confidence += Math.min(C.priceMeasuredMax, measuredPriceShare * C.priceMeasuredMult);
  confidence -= Math.min(C.syntheticPenaltyMax, syntheticShare * C.syntheticPenaltyMult);
  confidence -= Math.min(C.decayedPenaltyMax, decayedShare * C.decayedPenaltyMult);

  if (primaryTvl > 0 && fallbackTvl <= 0) {
    confidence += C.primaryClassBonus;
    return { coverageClass: "primary", coverageConfidence: clampConfidence(confidence) };
  }
  if (primaryTvl > 0 && fallbackTvl > 0) {
    confidence += C.mixedClassBonus;
    return { coverageClass: "mixed", coverageConfidence: clampConfidence(confidence) };
  }

  return {
    coverageClass: "fallback",
    coverageConfidence: clampConfidence(confidence - C.fallbackClassPenalty),
  };
}

function getObservationIdentityKey(observation: DexPriceObs): string | null {
  if (observation.poolKey) return `exact:${observation.poolKey}`;
  if (observation.identityConfidence === "derived_unique" && observation.derivedMatchKey) {
    return `derived:${observation.derivedMatchKey}`;
  }
  return null;
}

// Protocol display prices require usable positive evidence weight.
function evidenceWeightedMedian(observations: readonly DexPriceObs[]): number | null {
  return weightedMedian(
    observations.map((observation) => ({ value: observation.price, weight: dexPriceEvidenceWeight(observation) })),
  );
}

/** Unknown contributors keep the aggregate clock unknown; publication cannot renew a quote. */
export function oldestPriceObservation(observations: readonly DexPriceObs[]): number | null {
  let oldest = Infinity;
  for (const observation of observations) {
    if (typeof observation.observedAt !== "number" || !Number.isFinite(observation.observedAt) ||
      observation.observedAt < 0) return null;
    oldest = Math.min(oldest, observation.observedAt);
  }
  return oldest === Infinity ? null : oldest;
}

export function collapseDuplicateObservations(
  observations: DexPriceObs[],
): { collapsed: DexPriceObs[]; duplicateGroups: number; duplicateObservations: number } {
  const grouped = new Map<string, DexPriceObs[]>();
  const passthrough: DexPriceObs[] = [];

  for (const observation of observations) {
    const key = getObservationIdentityKey(observation);
    if (!key) {
      passthrough.push(observation);
      continue;
    }
    const existing = grouped.get(key) ?? [];
    existing.push(observation);
    grouped.set(key, existing);
  }

  let duplicateGroups = 0;
  let duplicateObservations = 0;
  for (const group of grouped.values()) {
    if (group.length === 1) {
      passthrough.push(group[0]!);
      continue;
    }

    duplicateGroups++;
    duplicateObservations += group.length - 1;
    const clockedMembers = group.filter((item) => item.curveNavSpotQuote != null);
    if (clockedMembers.length > 0) {
      // Never strip a clocked Curve NAV tag or merge non-clocked duplicates into default mode.
      if (clockedMembers.length === 1) {
        passthrough.push(clockedMembers[0]!);
        continue;
      }
      if (areUniformClockedCurveNavObservations(clockedMembers)) {
        const rep = [...clockedMembers].sort((left, right) => right.tvl - left.tvl || left.protocol.localeCompare(right.protocol))[0]!;
        passthrough.push({
          ...rep,
          tvl: Math.min(...clockedMembers.map((item) => item.tvl)),
        });
      } else {
        // Conflicting clocked Curve NAV copies for one pool key quarantine as "conflict" without falling back to default mode.
        const rep = clockedMembers[0]!;
        passthrough.push({
          ...rep,
          curveNavConflict: true as const,
        });
      }
      continue;
    }

    const representative = [...group].sort((left, right) => right.tvl - left.tvl || left.protocol.localeCompare(right.protocol))[0]!;
    const lineage = getDexGroupLineage(group);
    const contributor = lineage?.aggregateContributors?.[0];
    const sameFamilies = contributor && lineage?.aggregateContributors?.every((input) =>
      input.providerFamily === contributor.providerFamily && input.venueFamily === contributor.venueFamily);
    const allVerifiedClockedVenue = group.every((item) => item.verifiedClockedVenue === true);
    const { verifiedClockedVenue: _droppedVerified, ...representativeBase } = representative;
    passthrough.push({
      ...representativeBase,
      ...(allVerifiedClockedVenue ? { verifiedClockedVenue: true as const } : {}),
      mergedLineage: lineage ? {
        upstreamKeys: lineage.upstreamKeys,
        providerFamily: sameFamilies ? contributor.providerFamily : null,
        venueFamily: sameFamilies ? contributor.venueFamily : null,
      } : null,
      price: median(group.map((observation) => observation.price)) ?? 0,
      tvl: Math.max(...group.map((observation) => observation.tvl)),
      observedAt: oldestPriceObservation(group),
    });
  }

  return { collapsed: passthrough, duplicateGroups, duplicateObservations };
}

export function aggregateProtocolSources(
  observations: DexPriceObs[],
): Array<{ protocol: string; chain: string; price: number; tvl: number; observedAt?: number; aggregateObservedAt?: number; sourceFamily?: string; pricePoolKeys?: string[]; upstreamKeys?: string[] }> {
  const byProtocolFamily = new Map<string, DexPriceObs[]>();
  for (const observation of observations) {
    if (dexPriceEvidenceWeight(observation) <= 0 ||
      !Number.isFinite(observation.price) || observation.price <= 0) continue;
    const sourceFamily = normalizeSourceFamily(observation.sourceFamily);
    const key = `${observation.protocol}:${sourceFamily ?? "unknown"}`;
    const existing = byProtocolFamily.get(key) ?? [];
    existing.push(observation);
    byProtocolFamily.set(key, existing);
  }

  const aggregated = Array.from(byProtocolFamily.values()).flatMap((protocolObs) => {
    const protocol = protocolObs[0]?.protocol ?? "unknown";
    const sourceFamily = normalizeSourceFamily(protocolObs[0]?.sourceFamily);
    const totalTvl = protocolObs.reduce((sum, observation) => sum + observation.tvl, 0);
    const price = evidenceWeightedMedian(protocolObs);
    if (price == null) return [];
    const observedAt = oldestPriceObservation(protocolObs);
    const lineage = getDexGroupLineage(protocolObs);

    const chains = [...new Set(protocolObs.map((observation) => observation.chain))];
    return [{
      protocol,
      chain: chains.length === 1 ? chains[0] : "multi",
      price,
      tvl: Math.round(totalTvl),
      ...(observedAt != null ? { observedAt } : {}),
      ...(sourceFamily != null ? { sourceFamily } : {}),
      ...(lineage && { pricePoolKeys: lineage.pricePoolKeys, upstreamKeys: lineage.upstreamKeys }),
    }];
  });

  return aggregated.sort((left, right) => right.tvl - left.tvl || left.protocol.localeCompare(right.protocol));
}

/** Quote provenance and support are independent of the retained value observation. */
export function projectRetainedPoolPrice(
  pool: LiquidityMetrics["topPools"][number],
  stablecoinId?: string,
): DexPriceObs | null {
  const tvl = Math.min(pool.tvlUsd, pool.priceEvidenceTvlUsd ?? pool.tvlUsd);
  if (typeof pool.price !== "number" || !Number.isFinite(pool.price) || pool.price <= 0 ||
      !Number.isFinite(tvl) || tvl <= 0) return null;
  const verifiedClockedVenue =
    pool.curveNavSpotQuote == null &&
    pool.priceCounterparty?.observedAtMode === "upstream" &&
    hasVerifiedClockedVenueProof(pool, { stablecoinId });
  const measuredQuotedAt = verifiedClockedVenue ? pool.extra?.measuredExecution?.quotedAt : undefined;
  const observedAt =
    pool.priceObservedAt != null &&
    verifiedClockedVenue &&
    pool.extra?.ammExecutionModel?.source !== "uniswap-v2" &&
    pool.extra?.ammExecutionModel?.source !== "pancakeswap-v2" &&
    isPositiveSafeInt(measuredQuotedAt)
      ? Math.min(pool.priceObservedAt, measuredQuotedAt)
      : (pool.priceObservedAt ?? null);
  return {
    price: pool.price,
    observedAt,
    ...(pool.priceCounterparty ? { counterpartyPrice: pool.priceCounterparty } : {}),
    ...(pool.curveNavSpotQuote ? { curveNavSpotQuote: pool.curveNavSpotQuote } : {}),
    ...(verifiedClockedVenue ? { verifiedClockedVenue: true as const } : {}),
    tvl,
    chain: pool.chain,
    protocol: pool.project,
    poolKey: pool.poolId,
    identityConfidence: "exact",
    sourceFamily: pool.priceSource ?? pool.source,
  };
}

export type CurveNavIntegrityRejectionReason =
  | "capture-generation-mismatch"
  | "capture-invalid"
  | "capture-future"
  | "quote-mark-future"
  | "future-timestamp"
  | "invalid-clock"
  | "invalid-policy"
  | "conflict";

export type CurveNavEligibilityRejectionReason =
  | "pool-ineligible"
  | "insufficient-support"
  | "insufficient-volume"
  | "quote-mark-unavailable"
  | "quote-mark-stale"
  | "quote-stale"
  | "capture-stale"
  | "corroborator-missing"
  | "depth-test-failed";

export type CurveNavQuoteScoringRejectionReason =
  | CurveNavIntegrityRejectionReason
  | CurveNavEligibilityRejectionReason;

export interface CurveNavQuoteRejectionRecord {
  poolKey: string | null;
  chain?: string;
  reason: CurveNavQuoteScoringRejectionReason;
}

const CURVE_NAV_ELIGIBILITY_REJECTION_SET = new Set<string>([
  "pool-ineligible",
  "insufficient-support",
  "insufficient-volume",
  "quote-mark-unavailable",
  "quote-mark-stale",
  "quote-stale",
  "capture-stale",
  "corroborator-missing",
  "depth-test-failed",
]);

const CURVE_NAV_INTEGRITY_REJECTION_SET = new Set<string>([
  "capture-generation-mismatch",
  "capture-invalid",
  "capture-future",
  "quote-mark-future",
  "future-timestamp",
  "invalid-clock",
  "invalid-policy",
  "conflict",
]);

/**
 * Fail-closed integrity vs eligibility split (R8): anything outside the explicit
 * eligibility/support/staleness class isolates the coin fail-closed.
 */
function isCurveNavIntegrityRejectionReason(reason: string): boolean {
  return !CURVE_NAV_ELIGIBILITY_REJECTION_SET.has(reason);
}

export function normalizeCurveNavScoringRejectionReason(reason: string): CurveNavQuoteScoringRejectionReason {
  if (reason === "uncorroborated") return "corroborator-missing";
  if (CURVE_NAV_ELIGIBILITY_REJECTION_SET.has(reason) || CURVE_NAV_INTEGRITY_REJECTION_SET.has(reason)) {
    return reason as CurveNavQuoteScoringRejectionReason;
  }
  return "invalid-policy";
}

export function pickDecisiveCurveNavRejectionReason(
  rejections: readonly { reason: CurveNavQuoteScoringRejectionReason }[],
): CurveNavQuoteScoringRejectionReason {
  const integrity = rejections.find((entry) => isCurveNavIntegrityRejectionReason(entry.reason));
  return integrity?.reason ?? rejections[0]!.reason;
}

export function canonicalCurveNavPoolKey(
  chain: string | undefined,
  poolKey: string | null | undefined,
): string | null {
  if (!poolKey || !poolKey.trim()) return null;
  const trimmed = poolKey.trim();
  const separator = trimmed.indexOf(":");
  if (separator > 0) {
    return canonicalExitRouteScopedKey(trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }
  return chain ? canonicalExitRouteScopedKey(chain, trimmed) : trimmed.toLowerCase();
}

export function buildCurveNavRejectedPoolFilter(
  rejections: readonly CurveNavQuoteRejectionRecord[],
): { rejectedPoolKeys: Set<string>; hasNullKeyRejection: boolean; hasIntegrityRejection: boolean } {
  const rejectedPoolKeys = new Set<string>();
  let hasNullKeyRejection = false;
  let hasIntegrityRejection = false;
  for (const entry of rejections) {
    if (isCurveNavIntegrityRejectionReason(entry.reason)) hasIntegrityRejection = true;
    if (entry.poolKey == null || !entry.poolKey.trim()) {
      hasNullKeyRejection = true;
    } else {
      rejectedPoolKeys.add(entry.poolKey);
      const canonical = canonicalCurveNavPoolKey(entry.chain, entry.poolKey);
      if (canonical) rejectedPoolKeys.add(canonical);
    }
  }
  return { rejectedPoolKeys, hasNullKeyRejection, hasIntegrityRejection };
}

export function matchesRejectedCurveNavPool(
  poolKey: string | null | undefined,
  chain: string | undefined,
  protocol: string,
  filter: { rejectedPoolKeys: ReadonlySet<string>; hasNullKeyRejection: boolean },
): boolean {
  if (filter.hasNullKeyRejection && normalizeProtocol(protocol) === "curve") return true;
  if (!poolKey) return false;
  if (filter.rejectedPoolKeys.has(poolKey)) return true;
  const canonical = canonicalCurveNavPoolKey(chain, poolKey);
  return canonical != null && filter.rejectedPoolKeys.has(canonical);
}

const POOL_CONVERSION_SOURCE_UMBRELLAS = new Set(["curve-onchain", "dex-promoted"]);

function normalizeNavDependencyKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("venue:")) {
    const venue = lower.slice(6).trim();
    if (!venue) return null;
    const normalized = normalizePricingSourceKeys([venue]);
    return normalized.length === 1 ? `venue:${normalized[0]}` : `venue:${venue}`;
  }
  const separator = trimmed.indexOf(":");
  if (separator > 0) {
    return canonicalExitRouteScopedKey(trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }
  const normalized = normalizePricingSourceKeys([lower]);
  return normalized.length === 1 ? `venue:${normalized[0]}` : `venue:${lower}`;
}

function canonicalCounterMarkSignature(obs: DexPriceObs): string | null {
  const mark = obs.counterpartyPrice;
  if (
    !mark ||
    !isNonEmptyString(mark.stablecoinId) ||
    !isNonEmptyString(mark.source) ||
    !Number.isFinite(mark.priceUsd) ||
    mark.priceUsd <= 0 ||
    !isPositiveSafeInt(mark.observedAtSec)
  ) {
    return null;
  }
  const explicit = readDexPriceLineage(mark);
  const explicitUpstream = [...(explicit.upstreamKeys ?? [])]
    .map((key) => normalizeNavDependencyKey(key) ?? key)
    .sort()
    .join(",");
  const explicitPools = [...(explicit.pricePoolKeys ?? [])]
    .map((key) => normalizeNavDependencyKey(key) ?? key)
    .sort()
    .join(",");
  const obsLineage = getDexObservationLineage(obs);
  const obsUpstream = [...(obsLineage?.upstreamKeys ?? [])]
    .map((key) => normalizeNavDependencyKey(key) ?? key)
    .sort()
    .join(",");
  const normalizedSources = normalizePricingSourceKeys([mark.source]).sort().join("+");
  return JSON.stringify([
    mark.stablecoinId.trim(),
    mark.priceUsd,
    mark.source.trim().toLowerCase(),
    normalizedSources,
    mark.observedAtMode ?? null,
    mark.observedAtSec,
    explicitUpstream,
    explicitPools,
    obsUpstream,
  ]);
}

export function areUniformClockedCurveNavObservations(members: readonly DexPriceObs[]): boolean {
  if (members.length === 0) return false;
  const first = members[0]!;
  const firstQuote = first.curveNavSpotQuote;
  if (!isCurveNavSpotQuoteEvidenceShape(firstQuote)) return false;
  const firstMarkSig = canonicalCounterMarkSignature(first);
  if (firstMarkSig == null) return false;
  const firstCorroborators = [...(firstQuote.corroboratorPoolIds ?? [])].sort().join(",");
  return members.every((item) => {
    const q = item.curveNavSpotQuote;
    return (
      isCurveNavSpotQuoteEvidenceShape(q) &&
      item.curveNavConflict !== true &&
      item.price === first.price &&
      item.observedAt === first.observedAt &&
      q.policyId === firstQuote.policyId &&
      q.poolId === firstQuote.poolId &&
      q.blockNumber === firstQuote.blockNumber &&
      q.blockHash === firstQuote.blockHash &&
      q.poolRatioObservedAt === firstQuote.poolRatioObservedAt &&
      q.quoteMarkObservedAt === firstQuote.quoteMarkObservedAt &&
      q.captureEvaluatedAtSec === firstQuote.captureEvaluatedAtSec &&
      q.sourceGenerationId === firstQuote.sourceGenerationId &&
      q.admissionMode === firstQuote.admissionMode &&
      [...(q.corroboratorPoolIds ?? [])].sort().join(",") === firstCorroborators &&
      canonicalCounterMarkSignature(item) === firstMarkSig
    );
  });
}

export function classifyCurveNavCandidateIntegrityFailure(
  candidate: unknown,
  poolId: string,
  nowSec: number,
): CurveNavQuoteScoringRejectionReason | null {
  if (!isCurveNavSpotQuoteCandidateShape(candidate) || candidate.poolId !== poolId) {
    return "invalid-policy";
  }
  if (!isPositiveSafeInt(nowSec)) return "invalid-clock";
  if (
    candidate.poolRatioObservedAt > nowSec ||
    candidate.quoteMarkObservedAt > nowSec ||
    candidate.counterpartyPrice.observedAtSec > nowSec ||
    candidate.captureEvaluatedAtSec > nowSec ||
    candidate.poolRatioObservedAt > candidate.captureEvaluatedAtSec
  ) {
    return "future-timestamp";
  }
  if (
    candidate.counterpartyPrice.observedAtMode !== "upstream" ||
    candidate.counterpartyPrice.observedAtSec !== candidate.quoteMarkObservedAt
  ) {
    return "invalid-clock";
  }
  return null;
}

export function classifyPoolCurveNavIntegrityFailure(
  pool: PoolEntry,
  nowSec: number,
): CurveNavQuoteScoringRejectionReason | null {
  if (pool.curveNavSpotQuote === undefined) return null;
  const quote = pool.curveNavSpotQuote;
  if (
    !isCurveNavSpotQuoteEvidenceShape(quote) ||
    quote.poolId !== pool.poolId ||
    (pool.priceSource ?? pool.source) !== "direct_api" ||
    typeof pool.price !== "number" ||
    !Number.isFinite(pool.price) ||
    pool.price <= 0 ||
    !Number.isFinite(pool.priceEvidenceTvlUsd ?? pool.tvlUsd)
  ) {
    return "invalid-policy";
  }
  const mark = pool.priceCounterparty;
  if (!mark || !isNonEmptyString(mark.stablecoinId) || !isNonEmptyString(mark.source)) {
    return "invalid-policy";
  }
  if (!isPositiveSafeInt(nowSec) || !isPositiveSafeInt(pool.priceObservedAt) || !isPositiveSafeInt(mark.observedAtSec)) {
    return "invalid-clock";
  }
  if (
    quote.poolRatioObservedAt > nowSec ||
    quote.quoteMarkObservedAt > nowSec ||
    mark.observedAtSec > nowSec ||
    quote.captureEvaluatedAtSec > nowSec ||
    quote.poolRatioObservedAt > quote.captureEvaluatedAtSec
  ) {
    return "future-timestamp";
  }
  const expectedObservedAt = Math.min(quote.poolRatioObservedAt, quote.quoteMarkObservedAt);
  if (
    pool.priceObservedAt !== expectedObservedAt ||
    mark.observedAtMode !== "upstream" ||
    mark.observedAtSec !== quote.quoteMarkObservedAt ||
    !Number.isFinite(mark.priceUsd) ||
    mark.priceUsd <= 0
  ) {
    return "invalid-clock";
  }
  return null;
}

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTrackedNavTokenId(stablecoinId: string): boolean {
  const meta = WORKER_TRACKED_META_BY_ID.get(stablecoinId);
  return meta?.navToken === true || meta?.flags.navToken === true;
}

/** Defensive runtime shape check for staged Curve NAV quote candidates. */
export function isCurveNavSpotQuoteCandidateShape(value: unknown): value is CurveNavSpotQuoteCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.policyId !== CURVE_NAV_SPOT_QUOTE_POLICY_ID ||
    !isNonEmptyString(record.poolId) ||
    !isNonEmptyString(record.blockHash) ||
    !isNonEmptyString(record.sourceGenerationId) ||
    typeof record.priceUsd !== "number" || !Number.isFinite(record.priceUsd) || record.priceUsd <= 0 ||
    typeof record.supportUsd !== "number" || !Number.isFinite(record.supportUsd) || record.supportUsd <= 0 ||
    typeof record.volume24hUsd !== "number" || !Number.isFinite(record.volume24hUsd) || record.volume24hUsd < 0 ||
    !isPositiveSafeInt(record.blockNumber) ||
    !isPositiveSafeInt(record.poolRatioObservedAt) ||
    !isPositiveSafeInt(record.quoteMarkObservedAt) ||
    !isPositiveSafeInt(record.captureEvaluatedAtSec)
  ) {
    return false;
  }
  const mark = record.counterpartyPrice;
  if (!mark || typeof mark !== "object" || Array.isArray(mark)) return false;
  const markRecord = mark as Record<string, unknown>;
  return (
    isNonEmptyString(markRecord.stablecoinId) &&
    typeof markRecord.priceUsd === "number" && Number.isFinite(markRecord.priceUsd) && markRecord.priceUsd > 0 &&
    isPositiveSafeInt(markRecord.observedAtSec) &&
    markRecord.observedAtMode === "upstream" &&
    isNonEmptyString(markRecord.source)
  );
}

/**
 * Verify that a non-Curve `direct_api` pool carries an execution proof (`measuredExecution`
 * or pinned V2 `ammExecutionModel`) directly tied to its actual price observation.
 */
export function hasVerifiedClockedVenueProof(
  pool: PoolEntry,
  options: { stablecoinId?: string; nowSec?: number; sourceGenerationId?: string } = {},
): boolean {
  if (
    normalizeProtocol(pool.project) === "curve" ||
    (pool.priceSource ?? pool.source) !== "direct_api" ||
    pool.extra?.executionCapabilityGate != null ||
    typeof pool.price !== "number" ||
    !Number.isFinite(pool.price) ||
    pool.price <= 0 ||
    !isPositiveSafeInt(pool.priceObservedAt)
  ) {
    return false;
  }
  const observedAt = pool.priceObservedAt;
  const mark = pool.priceCounterparty;
  if (
    !mark ||
    !isNonEmptyString(mark.stablecoinId) ||
    !isNonEmptyString(mark.source) ||
    isTrackedNavTokenId(mark.stablecoinId) ||
    (options.stablecoinId != null && mark.stablecoinId === options.stablecoinId) ||
    !Number.isFinite(mark.priceUsd) ||
    mark.priceUsd <= 0 ||
    !isPositiveSafeInt(mark.observedAtSec) ||
    mark.observedAtMode !== "upstream" ||
    observedAt > mark.observedAtSec
  ) {
    return false;
  }
  if (options.nowSec != null) {
    if (
      !isPositiveSafeInt(options.nowSec) ||
      observedAt > options.nowSec ||
      options.nowSec - observedAt >= CURVE_NAV_SPOT_QUOTE_POLICY.quoteMaxAgeSec ||
      mark.observedAtSec > options.nowSec ||
      options.nowSec - mark.observedAtSec >= CURVE_NAV_SPOT_QUOTE_POLICY.quoteMaxAgeSec
    ) {
      return false;
    }
  }

  const model = pool.extra?.ammExecutionModel;
  if (
    model &&
    (model.source === "uniswap-v2" || model.source === "pancakeswap-v2") &&
    model.capture &&
    (options.sourceGenerationId == null || model.capture.sourceGenerationId === options.sourceGenerationId) &&
    isPositiveSafeInt(model.capture.blockTimestamp) &&
    observedAt <= model.capture.blockTimestamp &&
    (options.nowSec == null ||
      (model.capture.blockTimestamp <= options.nowSec &&
        options.nowSec - model.capture.blockTimestamp < CURVE_NAV_SPOT_QUOTE_POLICY.quoteMaxAgeSec)) &&
    model.tokens.length === 2
  ) {
    const tracked = model.tokens[model.trackedTokenIndex];
    const counter = model.tokens[1 - model.trackedTokenIndex];
    if (
      tracked &&
      counter &&
      tracked.balance > 0 &&
      counter.balance > 0 &&
      (options.stablecoinId == null || tracked.trackedAssetId == null || tracked.trackedAssetId === options.stablecoinId) &&
      (counter.trackedAssetId == null || counter.trackedAssetId === mark.stablecoinId)
    ) {
      const reservePriceUsd = (counter.balance / tracked.balance) * mark.priceUsd;
      if (
        Number.isFinite(reservePriceUsd) &&
        reservePriceUsd > 0 &&
        pricesAgreeWithinBps(reservePriceUsd, pool.price, CURVE_NAV_SPOT_QUOTE_POLICY.corroboratorMaxDivergenceBps)
      ) {
        return true;
      }
    }
  }

  const measured = pool.extra?.measuredExecution;
  const measuredPhysicalPoolId = pool.extra?.measuredExecutionPhysicalPoolId ?? pool.verifiedMeasuredPhysicalPoolId;
  if (
    measured &&
    isPositiveSafeInt(measured.quotedAt) &&
    (options.nowSec == null ||
      (measured.quotedAt <= options.nowSec &&
        options.nowSec - measured.quotedAt < CURVE_NAV_SPOT_QUOTE_POLICY.quoteMaxAgeSec)) &&
    (canonicalExitRouteScopedKey(pool.chain, measured.poolId) === canonicalExitRouteScopedKey(pool.chain, pool.poolId) ||
      (measuredPhysicalPoolId != null &&
        canonicalExitRouteScopedKey(pool.chain, measured.poolId) ===
          canonicalExitRouteScopedKey(pool.chain, measuredPhysicalPoolId))) &&
    (options.stablecoinId == null || measured.tokenIn?.trackedAssetId == null || measured.tokenIn.trackedAssetId === options.stablecoinId) &&
    (measured.tokenOut?.trackedAssetId == null || measured.tokenOut.trackedAssetId === mark.stablecoinId) &&
    typeof measured.marginalOutputRatio === "number" &&
    Number.isFinite(measured.marginalOutputRatio) &&
    measured.marginalOutputRatio > 0 &&
    typeof measured.tokenIn?.referencePriceUsd === "number" &&
    Number.isFinite(measured.tokenIn.referencePriceUsd) &&
    measured.tokenIn.referencePriceUsd > 0
  ) {
    const outRef = measured.tokenOut?.referencePriceUsd;
    const rawRatio =
      typeof outRef === "number" && Number.isFinite(outRef) && outRef > 0
        ? (measured.marginalOutputRatio * measured.tokenIn.referencePriceUsd) / outRef
        : measured.marginalOutputRatio * measured.tokenIn.referencePriceUsd;
    const measuredPriceUsd = rawRatio * mark.priceUsd;
    if (
      Number.isFinite(measuredPriceUsd) &&
      measuredPriceUsd > 0 &&
      pricesAgreeWithinBps(measuredPriceUsd, pool.price, CURVE_NAV_SPOT_QUOTE_POLICY.corroboratorMaxDivergenceBps)
    ) {
      return true;
    }
  }
  return false;
}

function resolveNavMarkDependencySets(
  obs: DexPriceObs,
): { markDeps: Set<string>; allDeps: Set<string> } | null {
  const mark = obs.counterpartyPrice;
  const markDeps = new Set<string>();
  const allDeps = new Set<string>();
  const obsPoolKey = canonicalCurveNavPoolKey(obs.chain, obs.poolKey);
  if (obsPoolKey) allDeps.add(obsPoolKey);

  const obsLineage = getDexObservationLineage(obs);
  if (obsLineage) {
    for (const key of obsLineage.upstreamKeys) {
      const normalized = normalizeNavDependencyKey(key);
      if (!normalized) continue;
      allDeps.add(normalized);
      if (normalized !== obsPoolKey) markDeps.add(normalized);
    }
  }

  if (mark) {
    const explicit = readDexPriceLineage(mark);
    if (
      (explicit.upstreamKeys !== undefined && explicit.upstreamKeys.length === 0) ||
      (explicit.pricePoolKeys !== undefined && explicit.pricePoolKeys.length === 0 && !explicit.upstreamKeys)
    ) {
      return null;
    }
    const hasExplicit = (explicit.upstreamKeys?.length ?? 0) > 0 || (explicit.pricePoolKeys?.length ?? 0) > 0;
    for (const key of [...(explicit.upstreamKeys ?? []), ...(explicit.pricePoolKeys ?? [])]) {
      const normalized = normalizeNavDependencyKey(key);
      if (normalized) {
        markDeps.add(normalized);
        allDeps.add(normalized);
      }
    }
    if (!isNonEmptyString(mark.stablecoinId) || !isNonEmptyString(mark.source)) {
      return null;
    }
    const symbol = WORKER_TRACKED_META_BY_ID.get(mark.stablecoinId)?.symbol;
    for (const part of normalizePricingSourceKeys([mark.source])) {
      if (hasExplicit && POOL_CONVERSION_SOURCE_UMBRELLAS.has(part)) continue;
      const directKeys = directUsdVenueKeys(part, symbol, mark.stablecoinId);
      if (directKeys && directKeys.length > 0) {
        for (const venueKey of directKeys) {
          const normalized = normalizeNavDependencyKey(venueKey);
          if (normalized) {
            markDeps.add(normalized);
            allDeps.add(normalized);
          }
        }
      }
      const normalizedPart = normalizeNavDependencyKey(part);
      if (normalizedPart) {
        markDeps.add(normalizedPart);
        allDeps.add(normalizedPart);
      }
    }
  }

  if (markDeps.size === 0) return null;
  return { markDeps, allDeps };
}

/**
 * Require independent mark/venue lineage between a Curve NAV quote and its
 * corroborator so a shared quote-token price source cannot falsely corroborate itself.
 */
export function hasIndependentNavMarkLineage(
  primaryObs: DexPriceObs,
  corroboratorObs: DexPriceObs,
): boolean {
  const primaryDeps = resolveNavMarkDependencySets(primaryObs);
  const corrDeps = resolveNavMarkDependencySets(corroboratorObs);
  if (!primaryDeps || !corrDeps) return false;
  for (const key of corrDeps.allDeps) {
    if (primaryDeps.allDeps.has(key)) return false;
  }
  return true;
}

/**
 * Re-validate a clocked Curve StableSwap-NG spot quote at scoring time against
 * the council freshness (`<= 600 s` capture against BOTH capture evaluation and
 * live scoring clock, `< 4,500 s` USD evidence, zero future skew) and support budgets.
 */
export function validateClockedCurveNavObservation(
  observation: DexPriceObs,
  admittedAtSec: number,
): CurveNavQuoteScoringRejectionReason | null {
  if (observation.curveNavConflict === true) {
    return "conflict";
  }
  const quote = observation.curveNavSpotQuote;
  if (
    !isCurveNavSpotQuoteEvidenceShape(quote) ||
    observation.sourceFamily !== "direct_api" ||
    observation.identityConfidence !== "exact" ||
    observation.poolKey !== quote.poolId ||
    !Number.isFinite(observation.price) ||
    observation.price <= 0 ||
    !Number.isFinite(observation.tvl)
  ) {
    return "invalid-policy";
  }
  const expectedObservedAt = Math.min(quote.poolRatioObservedAt, quote.quoteMarkObservedAt);
  const mark = observation.counterpartyPrice;
  if (!mark || !isNonEmptyString(mark.stablecoinId) || !isNonEmptyString(mark.source)) {
    return "invalid-policy";
  }
  if (!isPositiveSafeInt(admittedAtSec) || !isPositiveSafeInt(observation.observedAt) || !isPositiveSafeInt(mark.observedAtSec)) {
    return "invalid-clock";
  }
  if (
    quote.poolRatioObservedAt > admittedAtSec ||
    quote.quoteMarkObservedAt > admittedAtSec ||
    mark.observedAtSec > admittedAtSec ||
    quote.captureEvaluatedAtSec > admittedAtSec ||
    quote.poolRatioObservedAt > quote.captureEvaluatedAtSec
  ) {
    return "future-timestamp";
  }
  if (
    observation.observedAt !== expectedObservedAt ||
    mark.observedAtMode !== "upstream" ||
    mark.observedAtSec !== quote.quoteMarkObservedAt ||
    !Number.isFinite(mark.priceUsd) ||
    mark.priceUsd <= 0
  ) {
    return "invalid-clock";
  }
  if (
    quote.captureEvaluatedAtSec - quote.poolRatioObservedAt > CURVE_NAV_SPOT_QUOTE_POLICY.captureMaxAgeSec ||
    admittedAtSec - quote.poolRatioObservedAt > CURVE_NAV_SPOT_QUOTE_POLICY.captureMaxAgeSec
  ) {
    return "capture-stale";
  }
  if (
    admittedAtSec - quote.poolRatioObservedAt >= CURVE_NAV_SPOT_QUOTE_POLICY.quoteMaxAgeSec ||
    admittedAtSec - quote.quoteMarkObservedAt >= CURVE_NAV_SPOT_QUOTE_POLICY.quoteMaxAgeSec
  ) {
    return "quote-stale";
  }
  if (observation.tvl < CURVE_NAV_SPOT_QUOTE_POLICY.corroboratedPrimaryMinTvlUsd) {
    return "insufficient-support";
  }
  if (quote.admissionMode === "sole-venue") {
    return observation.tvl >= CURVE_NAV_SPOT_QUOTE_POLICY.soleVenueMinTvlUsd ? null : "insufficient-support";
  }
  if (quote.admissionMode === "corroborated") {
    return Array.isArray(quote.corroboratorPoolIds) && quote.corroboratorPoolIds.length > 0
      ? null
      : "corroborator-missing";
  }
  return "invalid-policy";
}

export function isIndependentlyVerifiedClockedObservation(
  candidate: DexPriceObs,
  admittedAtSec: number,
): boolean {
  if (
    candidate.curveNavSpotQuote != null ||
    candidate.verifiedClockedVenue !== true ||
    candidate.sourceFamily !== "direct_api" ||
    candidate.identityConfidence !== "exact" ||
    !isNonEmptyString(candidate.poolKey) ||
    normalizeProtocol(candidate.protocol) === "curve" ||
    !Number.isFinite(candidate.price) ||
    candidate.price <= 0 ||
    !Number.isFinite(candidate.tvl) ||
    candidate.tvl < DEX_PRICE_OBSERVATION_MIN_TVL_USD ||
    !isPositiveSafeInt(candidate.observedAt) ||
    candidate.observedAt > admittedAtSec ||
    admittedAtSec - candidate.observedAt >= CURVE_NAV_SPOT_QUOTE_POLICY.quoteMaxAgeSec
  ) {
    return false;
  }
  const mark = candidate.counterpartyPrice;
  if (
    !mark ||
    !isNonEmptyString(mark.stablecoinId) ||
    !isNonEmptyString(mark.source) ||
    isTrackedNavTokenId(mark.stablecoinId) ||
    mark.observedAtMode !== "upstream" ||
    !Number.isFinite(mark.priceUsd) ||
    mark.priceUsd <= 0 ||
    !isPositiveSafeInt(mark.observedAtSec) ||
    mark.observedAtSec > admittedAtSec ||
    admittedAtSec - mark.observedAtSec >= CURVE_NAV_SPOT_QUOTE_POLICY.quoteMaxAgeSec ||
    candidate.observedAt > mark.observedAtSec
  ) {
    return false;
  }
  return true;
}

export function isValidClockedNavCorroboratorObservation(
  candidate: DexPriceObs,
  primary: DexPriceObs,
  admittedAtSec: number,
): boolean {
  const candidateCanonical = canonicalCurveNavPoolKey(candidate.chain, candidate.poolKey);
  const primaryCanonical = canonicalCurveNavPoolKey(primary.chain, primary.poolKey);
  if (
    !isIndependentlyVerifiedClockedObservation(candidate, admittedAtSec) ||
    candidate.poolKey === primary.poolKey ||
    (candidateCanonical != null && candidateCanonical === primaryCanonical) ||
    candidate.tvl < CURVE_NAV_SPOT_QUOTE_POLICY.corroboratorMinTvlUsd
  ) {
    return false;
  }
  if (!hasIndependentNavMarkLineage(primary, candidate)) {
    return false;
  }
  return pricesAgreeWithinBps(primary.price, candidate.price, CURVE_NAV_SPOT_QUOTE_POLICY.corroboratorMaxDivergenceBps);
}

/**
 * Isolate clocked Curve StableSwap-NG NAV observations under an explicit
 * integrity vs eligibility R8 split:
 * - Admitted clocked Curve NAV quote(s): full `clocked-curve-nav` isolation
 *   (admitted Curve quotes + independently verified upstream-clocked non-Curve
 *   venues only; never blend Curve REST `observedAt: null`, untimestamped DL,
 *   or local-clock venues).
 * - Integrity-class Curve rejection (`capture-generation-mismatch`,
 *   `capture-invalid`, `capture-future`, `quote-mark-future`, `future-timestamp`,
 *   `invalid-clock`, `invalid-policy`, `conflict`): isolate the coin fail-closed
 *   to independently verified upstream-clocked non-Curve venues, withholding if none.
 * - Eligibility/support/staleness Curve rejection (`pool-ineligible`,
 *   `insufficient-support`, `insufficient-volume`, `quote-mark-unavailable`,
 *   `quote-mark-stale`, `quote-stale`, `capture-stale`, `corroborator-missing`,
 *   `depth-test-failed`): record in R4 diagnostics and quarantine ONLY the
 *   rejected Curve pool(s) (by raw + canonical scoped key), leaving healthy
 *   unrelated non-Curve venues intact under default rules (R8).
 */
export function selectClockedCurveNavObservations(
  observations: readonly DexPriceObs[],
  admittedAtSec: number,
  priorRejections: readonly CurveNavQuoteRejectionRecord[] = [],
): {
  mode: "default" | "clocked-curve-nav";
  observations: DexPriceObs[];
  captures: CurveNavSpotQuoteEvidence[];
  rejected: CurveNavQuoteRejectionRecord[];
} {
  const curveNavRows = observations.filter((observation) => observation.curveNavSpotQuote != null);
  if (curveNavRows.length === 0 && priorRejections.length === 0) {
    return { mode: "default", observations: [...observations], captures: [], rejected: [] };
  }

  const verifiedNonCurveByPoolKey = new Map<string, DexPriceObs>();
  for (const observation of observations) {
    if (!isIndependentlyVerifiedClockedObservation(observation, admittedAtSec)) continue;
    const key = observation.poolKey!;
    const existing = verifiedNonCurveByPoolKey.get(key);
    if (!existing || observation.tvl > existing.tvl) verifiedNonCurveByPoolKey.set(key, observation);
  }

  const admittedQuotes: DexPriceObs[] = [];
  const rejected: CurveNavQuoteRejectionRecord[] = [...priorRejections];
  const priorRejectionFilter = buildCurveNavRejectedPoolFilter(priorRejections);

  const curveNavGroups = new Map<string, DexPriceObs[]>();
  for (const row of curveNavRows) {
    const groupKey = canonicalCurveNavPoolKey(row.chain, row.poolKey) ?? row.poolKey ?? "";
    const list = curveNavGroups.get(groupKey) ?? [];
    list.push(row);
    curveNavGroups.set(groupKey, list);
  }

  for (const group of curveNavGroups.values()) {
    if (group.length > 1 && !areUniformClockedCurveNavObservations(group)) {
      for (const row of group) {
        rejected.push({ poolKey: row.poolKey ?? null, chain: row.chain, reason: "conflict" });
      }
      continue;
    }
    for (const row of group) {
      // Classify integrity/validity BEFORE skipping a prior pool rejection so a
      // future-dated or malformed copy of a pool-ineligible pool still triggers
      // coin-level integrity isolation.
      const failure = validateClockedCurveNavObservation(row, admittedAtSec);
      if (failure) {
        rejected.push({ poolKey: row.poolKey ?? null, chain: row.chain, reason: failure });
        continue;
      }
      if (matchesRejectedCurveNavPool(row.poolKey, row.chain, row.protocol, priorRejectionFilter)) {
        continue;
      }
      const quote = row.curveNavSpotQuote!;
      if (quote.admissionMode === "corroborated") {
        const matched: DexPriceObs[] = [];
        for (const poolId of new Set(quote.corroboratorPoolIds ?? [])) {
          const candidate = verifiedNonCurveByPoolKey.get(poolId);
          if (candidate && isValidClockedNavCorroboratorObservation(candidate, row, admittedAtSec)) {
            matched.push(candidate);
          }
        }
        const combinedTvl = row.tvl + matched.reduce((sum, entry) => sum + entry.tvl, 0);
        if (matched.length === 0 || combinedTvl < CURVE_NAV_SPOT_QUOTE_POLICY.corroboratedCombinedMinTvlUsd) {
          rejected.push({ poolKey: row.poolKey ?? null, chain: row.chain, reason: "corroborator-missing" });
          continue;
        }
      }
      admittedQuotes.push(row);
    }
  }

  const rejectionFilter = buildCurveNavRejectedPoolFilter(rejected);
  const survivingAdmittedQuotes = rejectionFilter.hasIntegrityRejection
    ? []
    : admittedQuotes.filter(
        (row) => !matchesRejectedCurveNavPool(row.poolKey, row.chain, row.protocol, rejectionFilter),
      );

  if (survivingAdmittedQuotes.length > 0) {
    return {
      mode: "clocked-curve-nav",
      observations: [...survivingAdmittedQuotes, ...verifiedNonCurveByPoolKey.values()],
      captures: survivingAdmittedQuotes.map((row) => row.curveNavSpotQuote!),
      rejected,
    };
  }

  if (rejectionFilter.hasIntegrityRejection) {
    if (verifiedNonCurveByPoolKey.size > 0) {
      return {
        mode: "default",
        observations: [...verifiedNonCurveByPoolKey.values()],
        captures: [],
        rejected,
      };
    }
    // Fail closed on integrity rejections: never fall back to unverified/local-clock/untimestamped venues.
    return {
      mode: "clocked-curve-nav",
      observations: [],
      captures: [],
      rejected,
    };
  }

  // Eligibility/support/staleness rejections quarantine ONLY the rejected Curve pool(s)
  // (including any Curve REST / DefiLlama copies sharing their poolKey / canonical key),
  // preserving unrelated non-Curve venues under existing default rules (R8).
  const survivingDefault = observations.filter(
    (observation) =>
      observation.curveNavSpotQuote == null &&
      !matchesRejectedCurveNavPool(observation.poolKey, observation.chain, observation.protocol, rejectionFilter),
  );
  return {
    mode: "default",
    observations: survivingDefault,
    captures: [],
    rejected,
  };
}

export function buildDexPriceObservationsFromRetainedPools(
  retainedPoolsByStablecoin: Map<string, LiquidityMetrics["topPools"]>,
  exactPriceEvidenceByStablecoin?: Map<string, DexPriceObs[]>,
  logRejections = true,
): Map<string, DexPriceObs[]> {
  const observations = new Map<string, DexPriceObs[]>();

  for (const [stablecoinId, pools] of retainedPoolsByStablecoin) {
    const exactEvidenceByPool = new Map<string, DexPriceObs[]>();
    for (const evidence of exactPriceEvidenceByStablecoin?.get(stablecoinId) ?? []) {
      if (
        evidence.identityConfidence !== "exact" ||
        evidence.sourceFamily !== "direct_api" ||
        !evidence.poolKey ||
        !Number.isFinite(evidence.price) ||
        evidence.price <= 0 ||
        !Number.isFinite(evidence.tvl) ||
        evidence.tvl < DEX_PRICE_OBSERVATION_MIN_TVL_USD
      ) {
        continue;
      }
      const existing = exactEvidenceByPool.get(evidence.poolKey) ?? [];
      existing.push(evidence);
      exactEvidenceByPool.set(evidence.poolKey, existing);
    }

    const pricedPools: DexPriceObs[] = [];
    let rejectedPriceEvidenceCount = 0;
    for (const pool of pools) {
      if (
        isBlockedDexId(pool.project) ||
        !Number.isFinite(pool.tvlUsd) ||
        pool.tvlUsd < DEX_PRICE_OBSERVATION_MIN_TVL_USD
      ) {
        continue;
      }

      if (typeof pool.price === "number" && Number.isFinite(pool.price) && pool.price > 0) {
        const priceEvidence = projectRetainedPoolPrice(pool, stablecoinId);
        if (!priceEvidence) {
          rejectedPriceEvidenceCount++;
          continue;
        }
        pricedPools.push(priceEvidence);
        continue;
      }

      for (const evidence of exactEvidenceByPool.get(pool.poolId) ?? []) {
        pricedPools.push({
          ...evidence,
          tvl: Math.min(pool.tvlUsd, evidence.tvl),
        });
      }
    }

    if (logRejections && rejectedPriceEvidenceCount > 0) {
      logWorkerEvent({
        scope: "handler",
        level: "warn",
        event: "dex_liquidity.price_evidence_rejected",
        message: "Omitted retained prices without usable evidence weight",
        metadata: { stablecoinId, reason: "nonpositive-or-invalid-price-evidence-tvl", count: rejectedPriceEvidenceCount },
      });
    }
    if (pricedPools.length > 0) {
      observations.set(stablecoinId, pricedPools);
    }
  }

  // Exchange evidence is independent of retained pools. Its zero TVL must
  // remain zero all the way to publication and downstream DEX trust gates.
  for (const [stablecoinId, evidence] of exactPriceEvidenceByStablecoin ?? []) {
    const tickerPrices = evidence.filter((observation) =>
      observation.sourceFamily === "cg_tickers" && observation.tvl === 0 &&
      dexPriceEvidenceWeight(observation) >= CG_TICKER_PRICE_MIN_VOLUME_USD &&
      Number.isFinite(observation.price) && observation.price > 0
    );
    if (tickerPrices.length > 0) {
      observations.set(stablecoinId, [...(observations.get(stablecoinId) ?? []), ...tickerPrices]);
    }
  }
  return observations;
}
