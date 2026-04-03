import type {
  DexPriceObs,
  LiquidityCoverageClass,
  LiquidityMetrics,
  LiquiditySourceMix,
} from "./types";
import { isBlockedDexId } from "../../lib/dex-constants";
import { normalizeProtocol } from "./pool-helpers";

function getPoolExtraNumber(
  extra: LiquidityMetrics["topPools"][number]["extra"] | undefined,
  key: string,
): number | null {
  const value = extra?.[key as keyof NonNullable<typeof extra>];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getPoolExtraBoolean(
  extra: LiquidityMetrics["topPools"][number]["extra"] | undefined,
  key: string,
): boolean | null {
  const value = extra?.[key as keyof NonNullable<typeof extra>];
  return typeof value === "boolean" ? value : null;
}

export function rebuildMetricsFromPools(pools: LiquidityMetrics["topPools"]) {
  const protocolTvl: Record<string, number> = {};
  const chainTvl: Record<string, number> = {};
  const sourceMix: LiquiditySourceMix = {};
  const chains = new Set<string>();
  const pairs = new Set<string>();

  let totalTvlUsd = 0;
  let totalVolume24hUsd = 0;
  let totalVolume7dUsd = 0;
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
    totalVolume24hUsd += pool.volumeUsd1d || 0;
    totalVolume7dUsd += pool.volumeUsd7d ?? 0;
    qualityAdjustedTvl += getPoolExtraNumber(pool.extra, "qualityAdjustedTvl") ?? pool.tvlUsd;
    effectiveTvl += getPoolExtraNumber(pool.extra, "effectiveTvl") ?? pool.tvlUsd;

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
    if (lockedLiquidityPct != null && lockedLiquidityPct >= 0) {
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

  const visiblePools = [...pools]
    .sort((a, b) => (b.volumeUsd1d || 0) - (a.volumeUsd1d || 0) || b.tvlUsd - a.tvlUsd)
    .slice(0, 10);

  return {
    totalTvlUsd,
    totalVolume24hUsd,
    totalVolume7dUsd,
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

export function filterRetainedPools(pools: LiquidityMetrics["topPools"]): LiquidityMetrics["topPools"] {
  return pools.filter((pool) => {
    if (isBlockedDexId(pool.project)) return false;
    const vol = pool.volumeUsd1d || 0;
    if (pool.tvlUsd > 0 && vol / pool.tvlUsd > 50) return false;
    if (pool.tvlUsd > 100_000_000 && vol < 50_000) return false;
    return true;
  });
}

function shouldStrictlyCapSource(source: LiquidityMetrics["topPools"][number]["source"]): boolean {
  return source === "cg_onchain" ||
    source === "gecko_terminal" ||
    source === "dexscreener" ||
    source === "cg_tickers";
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
        const extra = pool.extra as Record<string, number | unknown>;
        if (typeof extra.qualityAdjustedTvl === "number") extra.qualityAdjustedTvl = Math.round(extra.qualityAdjustedTvl * scale);
        if (typeof extra.effectiveTvl === "number") extra.effectiveTvl = Math.round(extra.effectiveTvl * scale);
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
  metric.totalVolume24hUsd = rebuilt.totalVolume24hUsd;
  metric.totalVolume7dUsd = rebuilt.totalVolume7dUsd;
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

export function accumulateGlobalAggregate(
  pools: LiquidityMetrics["topPools"],
  globalSeenPools: Set<string>,
  globalProtocolTvl: Record<string, number>,
  globalChainTvl: Record<string, number>,
  globalProtoChainTvl: Record<string, number>,
  globalChains: Set<string>,
): { totalTvl: number; totalVol24h: number; totalVol7d: number; poolCount: number } {
  let totalTvl = 0;
  let totalVol24h = 0;
  let totalVol7d = 0;
  let poolCount = 0;

  for (const pool of pools) {
    if (globalSeenPools.has(pool.poolId)) continue;
    globalSeenPools.add(pool.poolId);
    totalTvl += pool.tvlUsd;
    totalVol24h += pool.volumeUsd1d;
    totalVol7d += pool.volumeUsd7d ?? 0;
    poolCount++;
    const chainKey = pool.chain.toLowerCase();
    globalChains.add(chainKey);
    const proto = normalizeProtocol(pool.project);
    globalProtocolTvl[proto] = (globalProtocolTvl[proto] ?? 0) + pool.tvlUsd;
    globalChainTvl[chainKey] = (globalChainTvl[chainKey] ?? 0) + pool.tvlUsd;
    globalProtoChainTvl[`${proto}:${chainKey}`] = (globalProtoChainTvl[`${proto}:${chainKey}`] ?? 0) + pool.tvlUsd;
  }

  return { totalTvl, totalVol24h, totalVol7d, poolCount };
}

export function classifyCoverage(input: {
  sourceMix: LiquiditySourceMix;
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
  const balanceMeasuredShare = totalTvlUsd > 0 ? balanceMeasuredTvlUsd / totalTvlUsd : 0;
  const organicMeasuredShare = totalTvlUsd > 0 ? organicMeasuredTvlUsd / totalTvlUsd : 0;
  const syntheticShare = totalTvlUsd > 0 ? syntheticTvlUsd / totalTvlUsd : 0;
  const decayedShare = totalTvlUsd > 0 ? decayedTvlUsd / totalTvlUsd : 0;
  const measuredPriceShare = totalTvlUsd > 0 ? measuredPriceTvlUsd / totalTvlUsd : 0;

  let confidence = 0.35;
  confidence += Math.min(0.2, protocolCount * 0.05);
  confidence += Math.min(0.15, sourceFamilyCount * 0.05);
  confidence += Math.min(0.1, balanceMeasuredShare * 0.1);
  confidence += Math.min(0.05, organicMeasuredShare * 0.05);
  confidence += Math.min(0.1, measuredPriceShare * 0.1);
  confidence -= Math.min(0.25, syntheticShare * 0.35);
  confidence -= Math.min(0.15, decayedShare * 0.2);

  if (primaryTvl > 0 && fallbackTvl <= 0) {
    confidence += 0.15;
    return { coverageClass: "primary", coverageConfidence: Math.max(0, Math.min(1, Number(confidence.toFixed(2)))) };
  }
  if (primaryTvl > 0 && fallbackTvl > 0) {
    confidence += 0.05;
    return { coverageClass: "mixed", coverageConfidence: Math.max(0, Math.min(1, Number(confidence.toFixed(2)))) };
  }

  return {
    coverageClass: "fallback",
    coverageConfidence: Math.max(0, Math.min(1, Number((confidence - 0.05).toFixed(2)))),
  };
}

function getObservationIdentityKey(observation: DexPriceObs): string | null {
  if (observation.poolKey) return `exact:${observation.poolKey}`;
  if (observation.identityConfidence === "derived_unique" && observation.derivedMatchKey) {
    return `derived:${observation.derivedMatchKey}`;
  }
  return null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
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
      price: median(group.map((observation) => observation.price)),
      tvl: Math.max(...group.map((observation) => observation.tvl)),
    });
  }

  return { collapsed: passthrough, duplicateGroups, duplicateObservations };
}

export function aggregateProtocolSources(
  observations: DexPriceObs[],
): Array<{ protocol: string; chain: string; price: number; tvl: number }> {
  const byProtocol = new Map<string, DexPriceObs[]>();
  for (const observation of observations) {
    const existing = byProtocol.get(observation.protocol) ?? [];
    existing.push(observation);
    byProtocol.set(observation.protocol, existing);
  }

  const aggregated = Array.from(byProtocol.entries(), ([protocol, protocolObs]) => {
    const sorted = [...protocolObs].sort((left, right) => left.price - right.price);
    const totalTvl = sorted.reduce((sum, observation) => sum + observation.tvl, 0);
    const halfTvl = totalTvl / 2;
    let cumulativeTvl = 0;
    let medianPrice = sorted[0]?.price ?? 0;
    for (const observation of sorted) {
      cumulativeTvl += observation.tvl;
      if (cumulativeTvl >= halfTvl) {
        medianPrice = observation.price;
        break;
      }
    }

    const chains = [...new Set(protocolObs.map((observation) => observation.chain))];
    return {
      protocol,
      chain: chains.length === 1 ? chains[0] : "multi",
      price: medianPrice,
      tvl: Math.round(totalTvl),
    };
  });

  return aggregated.sort((left, right) => right.tvl - left.tvl || left.protocol.localeCompare(right.protocol));
}

export function buildDexPriceObservationsFromRetainedPools(
  retainedPoolsByStablecoin: Map<string, LiquidityMetrics["topPools"]>,
): Map<string, DexPriceObs[]> {
  const observations = new Map<string, DexPriceObs[]>();

  for (const [stablecoinId, pools] of retainedPoolsByStablecoin) {
    const pricedPools = pools
      .filter((pool) => (
        !isBlockedDexId(pool.project) &&
        typeof pool.price === "number" &&
        Number.isFinite(pool.price) &&
        pool.price > 0 &&
        Number.isFinite(pool.tvlUsd) &&
        pool.tvlUsd > 0
      ))
      .map((pool) => ({
        price: pool.price!,
        tvl: pool.tvlUsd,
        chain: pool.chain,
        protocol: pool.project,
        poolKey: pool.poolId,
        identityConfidence: "exact" as const,
        sourceFamily: pool.source,
      }));

    if (pricedPools.length > 0) {
      observations.set(stablecoinId, pricedPools);
    }
  }

  return observations;
}
