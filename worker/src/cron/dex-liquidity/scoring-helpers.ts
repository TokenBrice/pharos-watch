import type {
  DexPoolVolumeReading,
  DexPriceObs,
  LiquidityCoverageClass,
  LiquidityFallbackCounters,
  LiquidityMetrics,
  LiquiditySourceMixByFamily,
  PoolEntry,
} from "./types";
import type { DexVolumeAvailabilityRecord } from "@shared/types/market";
import { isBlockedDexId } from "../../lib/dex-cron-constants";
import { DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../../lib/constants";
import { clamp } from "@shared/lib/math";
import { median, weightedMedian } from "@shared/lib/stats";
import {
  DEX_DEAD_POOL_TVL_MIN_USD,
  classifyDexPoolVolumeObservation,
  summarizeDexVolumeWindow,
} from "@shared/lib/dex-volume-availability";
import { normalizeProtocol } from "./pool-helpers";
import { logWorkerEvent } from "../../lib/structured-log";
import { CG_TICKER_PRICE_MIN_VOLUME_USD, dexPriceEvidenceWeight } from "./coingecko-tickers-shared";

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

const POOL_VOL_TO_TVL_RATIO_MAX = 50;
const LARGE_POOL_TVL_MIN_USD = 100_000_000;
const LARGE_POOL_MIN_VOLUME_USD = 50_000;

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
    if (lockedLiquidityPct != null && lockedLiquidityPct > 0) {
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
    const vol = pool.volumeUsd1d;
    if (vol != null && pool.tvlUsd > 0 && vol / pool.tvlUsd > POOL_VOL_TO_TVL_RATIO_MAX) {
      if (fallbackCounters) fallbackCounters.retainedExclusionVolTvlRatio++;
      return false;
    }
    if (pool.tvlUsd > LARGE_POOL_TVL_MIN_USD && !(vol != null && vol >= LARGE_POOL_MIN_VOLUME_USD)) {
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

function shouldStrictlyCapSource(source: LiquidityMetrics["topPools"][number]["source"]): boolean {
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
    source === "noble-swap";
}

export function applyProtocolCaps(
  pools: LiquidityMetrics["topPools"],
  protocolTvlCaps: Map<string, number>,
) {
  if (protocolTvlCaps.size === 0 || pools.length === 0) {
    return { cappedPoolCount: 0, cappedProtocols: 0, reducedTvlUsd: 0 };
  }

  const cappedTvlByProto = new Map<string, number>();
  const trustedTvlByProto = new Map<string, number>();

  for (const pool of pools) {
    const proto = normalizeProtocol(pool.project);
    if (shouldStrictlyCapSource(pool.source)) {
      cappedTvlByProto.set(proto, (cappedTvlByProto.get(proto) ?? 0) + pool.tvlUsd);
      continue;
    }
    trustedTvlByProto.set(proto, (trustedTvlByProto.get(proto) ?? 0) + pool.tvlUsd);
  }

  let cappedPoolCount = 0;
  let cappedProtocols = 0;
  let reducedTvlUsd = 0;

  for (const [proto, cappedTvl] of cappedTvlByProto) {
    const cap = protocolTvlCaps.get(proto);
    if (cap == null || cap <= 0 || cappedTvl <= 0) continue;
    const trustedTvl = trustedTvlByProto.get(proto) ?? 0;
    const headroom = Math.max(0, cap - trustedTvl);
    if (cappedTvl <= headroom) continue;

    cappedProtocols++;
    const scale = headroom / cappedTvl;
    for (const pool of pools) {
      if (!shouldStrictlyCapSource(pool.source) || normalizeProtocol(pool.project) !== proto) continue;
      const previousTvl = pool.tvlUsd;
      pool.tvlUsd = Math.round(pool.tvlUsd * scale);
      reducedTvlUsd += Math.max(0, previousTvl - pool.tvlUsd);
      if (pool.extra) {
        if (typeof pool.extra.qualityAdjustedTvl === "number") {
          pool.extra.qualityAdjustedTvl = Math.round(pool.extra.qualityAdjustedTvl * scale);
        }
        if (typeof pool.extra.effectiveTvl === "number") {
          pool.extra.effectiveTvl = Math.round(pool.extra.effectiveTvl * scale);
        }
        const measurement = pool.extra.measurement ?? {};
        measurement.capped = true;
        pool.extra.measurement = measurement;
      }
      cappedPoolCount++;
    }
  }

  return { cappedPoolCount, cappedProtocols, reducedTvlUsd: Math.round(reducedTvlUsd) };
}

export function applyRebuiltMetrics(
  metric: LiquidityMetrics,
  rebuilt: ReturnType<typeof rebuildMetricsFromPools>,
): void {
  metric.protocolTvl = rebuilt.protocolTvl;
  metric.chainTvl = rebuilt.chainTvl;
  metric.totalTvlUsd = rebuilt.totalTvlUsd;
  metric.poolCount = rebuilt.poolCount;
  metric.chains = rebuilt.chains;
  metric.pairs = rebuilt.pairs;
  metric.qualityAdjustedTvl = rebuilt.qualityAdjustedTvl;
  metric.effectiveTvl = rebuilt.effectiveTvl;
  metric.balanceRatioWeightedSum = rebuilt.balanceRatioWeightedSum;
  metric.totalTvlForBalance = rebuilt.totalTvlForBalance;
  metric.organicTvlWeightedSum = rebuilt.organicTvlWeightedSum;
  metric.totalTvlForOrganic = rebuilt.totalTvlForOrganic;
  metric.stressWeightedSum = rebuilt.stressWeightedSum;
  metric.oldestPoolDays = rebuilt.oldestPoolDays;
  metric.lockedLiqWeightedSum = rebuilt.lockedLiqWeightedSum;
  metric.totalTvlForLocked = rebuilt.totalTvlForLocked;
  metric.topPools = rebuilt.visiblePools;
}

export interface GlobalPoolAggregateEntry {
  tvl: number;
  reading: DexPoolVolumeReading | undefined;
  proto: string;
  chain: string;
}

export function accumulateGlobalAggregate(
  pools: LiquidityMetrics["topPools"],
  globalProtocolTvl: Record<string, number>,
  globalChainTvl: Record<string, number>,
  globalProtoChainTvl: Record<string, number>,
  globalChains: Set<string>,
  seenPoolTvl: Map<string, GlobalPoolAggregateEntry>,
): { totalTvl: number; poolCount: number } {
  let totalTvl = 0;
  let poolCount = 0;

  for (const pool of pools) {
    const proto = normalizeProtocol(pool.project);
    const chainKey = pool.chain;
    const prev = seenPoolTvl.get(pool.poolId);

    if (prev) {
      // The highest-TVL occurrence owns the deduped pool, including its volume reading.
      if (pool.tvlUsd > prev.tvl) {
        totalTvl += pool.tvlUsd - prev.tvl;
        globalProtocolTvl[prev.proto] = (globalProtocolTvl[prev.proto] ?? 0) - prev.tvl;
        globalChainTvl[prev.chain] = (globalChainTvl[prev.chain] ?? 0) - prev.tvl;
        globalProtoChainTvl[`${prev.proto}:${prev.chain}`] =
          (globalProtoChainTvl[`${prev.proto}:${prev.chain}`] ?? 0) - prev.tvl;
        globalProtocolTvl[proto] = (globalProtocolTvl[proto] ?? 0) + pool.tvlUsd;
        globalChainTvl[chainKey] = (globalChainTvl[chainKey] ?? 0) + pool.tvlUsd;
        globalProtoChainTvl[`${proto}:${chainKey}`] =
          (globalProtoChainTvl[`${proto}:${chainKey}`] ?? 0) + pool.tvlUsd;
        globalChains.add(chainKey);
        seenPoolTvl.set(pool.poolId, { tvl: pool.tvlUsd, reading: pool.volumeReading, proto, chain: chainKey });
      }
      continue;
    }

    seenPoolTvl.set(pool.poolId, { tvl: pool.tvlUsd, reading: pool.volumeReading, proto, chain: chainKey });
    totalTvl += pool.tvlUsd;
    poolCount++;
    globalChains.add(chainKey);
    globalProtocolTvl[proto] = (globalProtocolTvl[proto] ?? 0) + pool.tvlUsd;
    globalChainTvl[chainKey] = (globalChainTvl[chainKey] ?? 0) + pool.tvlUsd;
    globalProtoChainTvl[`${proto}:${chainKey}`] = (globalProtoChainTvl[`${proto}:${chainKey}`] ?? 0) + pool.tvlUsd;
  }

  return { totalTvl, poolCount };
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
    const representative = [...group].sort((left, right) => right.tvl - left.tvl || left.protocol.localeCompare(right.protocol))[0]!;
    passthrough.push({
      ...representative,
      price: median(group.map((observation) => observation.price)) ?? 0,
      tvl: Math.max(...group.map((observation) => observation.tvl)),
    });
  }

  return { collapsed: passthrough, duplicateGroups, duplicateObservations };
}

export function aggregateProtocolSources(
  observations: DexPriceObs[],
): Array<{ protocol: string; chain: string; price: number; tvl: number; sourceFamily?: string }> {
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

    const chains = [...new Set(protocolObs.map((observation) => observation.chain))];
    return [{
      protocol,
      chain: chains.length === 1 ? chains[0] : "multi",
      price,
      tvl: Math.round(totalTvl),
      ...(sourceFamily != null ? { sourceFamily } : {}),
    }];
  });

  return aggregated.sort((left, right) => right.tvl - left.tvl || left.protocol.localeCompare(right.protocol));
}

export function buildDexPriceObservationsFromRetainedPools(
  retainedPoolsByStablecoin: Map<string, LiquidityMetrics["topPools"]>,
  exactPriceEvidenceByStablecoin?: Map<string, DexPriceObs[]>,
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
        const priceEvidenceTvl = Math.min(pool.tvlUsd, pool.priceEvidenceTvlUsd ?? pool.tvlUsd);
        if (!Number.isFinite(priceEvidenceTvl) || priceEvidenceTvl <= 0) {
          rejectedPriceEvidenceCount++;
          continue;
        }
        pricedPools.push({
          price: pool.price,
          // A cross-source price (value row and price row from different
          // registry observations) is weighted by the TVL the price-observing
          // row itself claims, never by the value row's larger TVL.
          tvl: priceEvidenceTvl,
          chain: pool.chain,
          protocol: pool.project,
          poolKey: pool.poolId,
          identityConfidence: "exact",
          // Confidence and published attribution follow the family that
          // observed the price, not the family that supplied the value.
          sourceFamily: pool.priceSource ?? pool.source,
        });
        continue;
      }

      for (const evidence of exactEvidenceByPool.get(pool.poolId) ?? []) {
        pricedPools.push({
          ...evidence,
          tvl: Math.min(pool.tvlUsd, evidence.tvl),
        });
      }
    }

    if (rejectedPriceEvidenceCount > 0) {
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
