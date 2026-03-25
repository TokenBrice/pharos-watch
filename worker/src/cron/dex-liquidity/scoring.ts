import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { batchExecute } from "../../lib/db";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import type {
  LiquidityMetrics,
  FullScoreResult,
  GlobalAgg,
  DexPriceObs,
  LiquidityCoverageClass,
  LiquiditySourceMix,
} from "./types";
import { dexPriceConfidenceForProtocol } from "./constants";
import { computeDurabilityScore, computeLiquidityScore, normalizeProtocol } from "./pool-helpers";

const HISTORY_CONFIDENCE_MIN = 0.75;

interface ProtocolCapDiagnostics {
  cappedPoolCount: number;
  cappedProtocols: number;
  reducedTvlUsd: number;
}

interface ScoreDiagnostics {
  protocolCapReductions: ProtocolCapDiagnostics;
}

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

function rebuildMetricsFromPools(pools: LiquidityMetrics["topPools"]) {
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

function filterRetainedPools(pools: LiquidityMetrics["topPools"]): LiquidityMetrics["topPools"] {
  return pools.filter((p) => {
    const vol = p.volumeUsd1d || 0;
    if (p.tvlUsd > 0 && vol / p.tvlUsd > 50) return false;
    if (p.tvlUsd > 100_000_000 && vol < 50_000) return false;
    return true;
  });
}

function shouldStrictlyCapSource(source: LiquidityMetrics["topPools"][number]["source"]): boolean {
  return source === "cg_onchain" ||
    source === "gecko_terminal" ||
    source === "dexscreener" ||
    source === "cg_tickers";
}

function applyProtocolCaps(
  pools: LiquidityMetrics["topPools"],
  protocolTvlCaps: Map<string, number>,
): ProtocolCapDiagnostics {
  if (protocolTvlCaps.size === 0 || pools.length === 0) {
    return { cappedPoolCount: 0, cappedProtocols: 0, reducedTvlUsd: 0 };
  }

  const cappedTvlByProto = new Map<string, number>();
  const trustedTvlByProto = new Map<string, number>();

  for (const p of pools) {
    const proto = normalizeProtocol(p.project);
    if (shouldStrictlyCapSource(p.source)) {
      cappedTvlByProto.set(proto, (cappedTvlByProto.get(proto) ?? 0) + p.tvlUsd);
      continue;
    }
    trustedTvlByProto.set(proto, (trustedTvlByProto.get(proto) ?? 0) + p.tvlUsd);
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
    for (const p of pools) {
      if (!shouldStrictlyCapSource(p.source) || normalizeProtocol(p.project) !== proto) continue;
      const previousTvl = p.tvlUsd;
      p.tvlUsd = Math.round(p.tvlUsd * scale);
      reducedTvlUsd += Math.max(0, previousTvl - p.tvlUsd);
      if (p.extra) {
        const ex = p.extra as Record<string, number | unknown>;
        if (typeof ex.qualityAdjustedTvl === "number") ex.qualityAdjustedTvl = Math.round(ex.qualityAdjustedTvl * scale);
        if (typeof ex.effectiveTvl === "number") ex.effectiveTvl = Math.round(ex.effectiveTvl * scale);
        const measurement = p.extra.measurement ?? {};
        measurement.capped = true;
        p.extra.measurement = measurement;
      }
      cappedPoolCount++;
    }
  }

  return { cappedPoolCount, cappedProtocols, reducedTvlUsd: Math.round(reducedTvlUsd) };
}

function applyRebuiltMetrics(metric: LiquidityMetrics, rebuilt: ReturnType<typeof rebuildMetricsFromPools>): void {
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

function accumulateGlobalAggregate(
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

  for (const p of pools) {
    if (globalSeenPools.has(p.poolId)) continue;
    globalSeenPools.add(p.poolId);
    totalTvl += p.tvlUsd;
    totalVol24h += p.volumeUsd1d;
    totalVol7d += p.volumeUsd7d ?? 0;
    poolCount++;
    const chainKey = p.chain.toLowerCase();
    globalChains.add(chainKey);
    const proto = normalizeProtocol(p.project);
    globalProtocolTvl[proto] = (globalProtocolTvl[proto] ?? 0) + p.tvlUsd;
    globalChainTvl[chainKey] = (globalChainTvl[chainKey] ?? 0) + p.tvlUsd;
    globalProtoChainTvl[`${proto}:${chainKey}`] = (globalProtoChainTvl[`${proto}:${chainKey}`] ?? 0) + p.tvlUsd;
  }

  return { totalTvl, totalVol24h, totalVol7d, poolCount };
}

/** @internal Exported for testing only. */
export function computeSeriesStability(values: number[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < 7) return null;
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  if (mean <= 0) return null;
  const variance = finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finite.length;
  const cv = Math.sqrt(Math.max(0, variance)) / mean;
  return Math.round((1 - Math.min(1, cv)) * 10000) / 10000;
}

async function loadConfidentHistoryStability(db: D1Database): Promise<{
  tvlStabilityMap: Map<string, number>;
  volumeStabilityMap: Map<string, number>;
}> {
  const todayMidnight = Math.floor(Date.now() / 86_400_000) * 86_400;
  const thirtyDaysAgo = todayMidnight - 30 * 86_400;
  const tvlStabilityMap = new Map<string, number>();
  const volumeStabilityMap = new Map<string, number>();

  const histRows = await db
    .prepare(
      `SELECT stablecoin_id, total_tvl_usd, total_volume_24h_usd, coverage_confidence
       FROM dex_liquidity_history
       WHERE snapshot_date >= ?
       ORDER BY stablecoin_id, snapshot_date`
    )
    .bind(thirtyDaysAgo)
    .all<{
      stablecoin_id: string;
      total_tvl_usd: number;
      total_volume_24h_usd: number;
      coverage_confidence: number | null;
    }>();

  const tvlByCoin = new Map<string, number[]>();
  const volumeByCoin = new Map<string, number[]>();
  for (const row of histRows.results ?? []) {
    const confidence = row.coverage_confidence ?? 0;
    if (confidence < HISTORY_CONFIDENCE_MIN) continue;

    const tvlSeries = tvlByCoin.get(row.stablecoin_id) ?? [];
    tvlSeries.push(row.total_tvl_usd);
    tvlByCoin.set(row.stablecoin_id, tvlSeries);

    const volumeSeries = volumeByCoin.get(row.stablecoin_id) ?? [];
    volumeSeries.push(row.total_volume_24h_usd);
    volumeByCoin.set(row.stablecoin_id, volumeSeries);
  }

  for (const [coinId, tvls] of tvlByCoin) {
    const stability = computeSeriesStability(tvls);
    if (stability != null) {
      tvlStabilityMap.set(coinId, stability);
    }
  }
  for (const [coinId, volumes] of volumeByCoin) {
    const stability = computeSeriesStability(volumes);
    if (stability != null) {
      volumeStabilityMap.set(coinId, stability);
    }
  }

  return { tvlStabilityMap, volumeStabilityMap };
}

function classifyCoverage(input: {
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
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function collapseDuplicateObservations(
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
    const representative = [...group].sort((a, b) => b.tvl - a.tvl || a.protocol.localeCompare(b.protocol))[0]!;
    passthrough.push({
      ...representative,
      price: median(group.map((observation) => observation.price)),
      tvl: Math.max(...group.map((observation) => observation.tvl)),
    });
  }

  return { collapsed: passthrough, duplicateGroups, duplicateObservations };
}

function aggregateProtocolSources(
  observations: DexPriceObs[],
): Array<{ protocol: string; chain: string; price: number; tvl: number }> {
  const byProtocol = new Map<string, DexPriceObs[]>();
  for (const observation of observations) {
    const existing = byProtocol.get(observation.protocol) ?? [];
    existing.push(observation);
    byProtocol.set(observation.protocol, existing);
  }

  const aggregated = Array.from(byProtocol.entries(), ([protocol, protocolObs]) => {
    const sorted = [...protocolObs].sort((a, b) => a.price - b.price);
    const totalTvl = sorted.reduce((sum, obs) => sum + obs.tvl, 0);
    const halfTvl = totalTvl / 2;
    let cumulativeTvl = 0;
    let medianPrice = sorted[0]?.price ?? 0;
    for (const obs of sorted) {
      cumulativeTvl += obs.tvl;
      if (cumulativeTvl >= halfTvl) {
        medianPrice = obs.price;
        break;
      }
    }

    const chains = [...new Set(protocolObs.map((obs) => obs.chain))];
    return {
      protocol,
      chain: chains.length === 1 ? chains[0] : "multi",
      price: medianPrice,
      tvl: Math.round(totalTvl),
    };
  });

  return aggregated.sort((a, b) => b.tvl - a.tvl || a.protocol.localeCompare(b.protocol));
}

/** Compute HHI, durability, and 6-component composite score per stablecoin. */
export async function computeStablecoinScores(
  db: D1Database,
  metrics: Map<string, LiquidityMetrics>,
  protocolTvlCaps: Map<string, number>,
): Promise<{
  scores: Map<string, FullScoreResult>;
  globalAgg: GlobalAgg;
  retainedPoolsByStablecoin: Map<string, LiquidityMetrics["topPools"]>;
  tvlStabilityMap: Map<string, number>;
  diagnostics: ScoreDiagnostics;
}> {
  let tvlStabilityMap = new Map<string, number>();
  let volumeStabilityMap = new Map<string, number>();
  try {
    ({ tvlStabilityMap, volumeStabilityMap } = await loadConfidentHistoryStability(db));
  } catch {
    // First run / pre-migration state — fall back to neutral defaults downstream.
  }

  const results = new Map<string, FullScoreResult>();
  const retainedPoolsByStablecoin = new Map<string, LiquidityMetrics["topPools"]>();

  // Global dedup accumulators — accumulated per-coin BEFORE top-10 truncation
  const globalSeenPools = new Set<string>();
  const globalProtocolTvl: Record<string, number> = {};
  const globalChainTvl: Record<string, number> = {};
  const globalProtoChainTvl: Record<string, number> = {}; // "proto:chain" → TVL
  let globalTotalTvl = 0;
  let globalTotalVol24h = 0;
  let globalTotalVol7d = 0;
  let globalPoolCount = 0;
  const globalChains = new Set<string>();
  const protocolCapDiagnostics: ProtocolCapDiagnostics = { cappedPoolCount: 0, cappedProtocols: 0, reducedTvlUsd: 0 };

  for (const [id, m] of metrics) {
    m.topPools = filterRetainedPools(m.topPools);
    const capResult = applyProtocolCaps(m.topPools, protocolTvlCaps);
    protocolCapDiagnostics.cappedPoolCount += capResult.cappedPoolCount;
    protocolCapDiagnostics.cappedProtocols += capResult.cappedProtocols;
    protocolCapDiagnostics.reducedTvlUsd += capResult.reducedTvlUsd;

    const retainedPools = [...m.topPools];
    retainedPoolsByStablecoin.set(id, retainedPools.map((pool) => ({
      ...pool,
      extra: pool.extra ? { ...pool.extra } : undefined,
    })));
    const rebuilt = rebuildMetricsFromPools(retainedPools);

    applyRebuiltMetrics(m, rebuilt);
    const globalDelta = accumulateGlobalAggregate(
      retainedPools, globalSeenPools, globalProtocolTvl, globalChainTvl, globalProtoChainTvl, globalChains,
    );
    globalTotalTvl += globalDelta.totalTvl;
    globalTotalVol24h += globalDelta.totalVol24h;
    globalTotalVol7d += globalDelta.totalVol7d;
    globalPoolCount += globalDelta.poolCount;

    // v2: Compute durability score
    const tvlStab = tvlStabilityMap.get(id) ?? null;
    const volStab = volumeStabilityMap.get(id) ?? null;
    const durability = computeDurabilityScore(m, tvlStab, volStab);

    // v2: Compute 6-component score
    const { score, components } = computeLiquidityScore(m, durability);

    // v2: Compute aggregate metrics
    const weightedBalanceRatio = m.totalTvlForBalance > 0
      ? Math.round((m.balanceRatioWeightedSum / m.totalTvlForBalance) * 10000) / 10000
      : null;
    const organicFrac = m.totalTvlForOrganic > 0
      ? Math.round((m.organicTvlWeightedSum / m.totalTvlForOrganic) * 10000) / 10000
      : null;
    const avgStress = m.totalTvlUsd > 0
      ? Math.round((m.stressWeightedSum / m.totalTvlUsd) * 100) / 100
      : null;
    const lockedLiqPct = m.totalTvlForLocked > 0
      ? Math.round((m.lockedLiqWeightedSum / m.totalTvlForLocked) * 10000) / 10000
      : null;
    const { coverageClass, coverageConfidence } = classifyCoverage({
      sourceMix: rebuilt.sourceMix,
      totalTvlUsd: m.totalTvlUsd,
      protocolCount: rebuilt.protocolCount,
      sourceFamilyCount: rebuilt.sourceFamilyCount,
      balanceMeasuredTvlUsd: m.totalTvlForBalance,
      organicMeasuredTvlUsd: m.totalTvlForOrganic,
      syntheticTvlUsd: rebuilt.syntheticTvlUsd,
      decayedTvlUsd: rebuilt.decayedTvlUsd,
      measuredPriceTvlUsd: rebuilt.measuredPriceTvlUsd,
    });

    results.set(id, {
      tvl: m.totalTvlUsd,
      vol24h: m.totalVolume24hUsd,
      score,
      hhi: Math.round(rebuilt.hhi * 10000) / 10000,
      durability,
      components,
      weightedBalanceRatio,
      organicFrac,
      avgStress,
      lockedLiqPct,
      coverageClass,
      coverageConfidence,
      sourceMix: rebuilt.sourceMix,
      balanceMeasuredTvlUsd: m.totalTvlForBalance,
      organicMeasuredTvlUsd: m.totalTvlForOrganic,
    });
  }

  // M3: Global protocol-level TVL cap: when reducing excess, chain TVLs are
  // distributed proportionally rather than attributed to the chain with the
  // most excess. This is a trade-off — exact chain attribution would require
  // per-pool chain data which is not available in the global aggregate.
  //
  // Clamp deduped protocol totals at DL protocol TVL.
  // After cross-stablecoin dedup, a protocol can still exceed its real TVL when
  // CG/GT virtual reserves are inflated across many pools. The per-coin cap allows
  // up to protocolTvl PER stablecoin, but globally the protocol total must not
  // exceed DL's reported TVL. Chain TVLs are reduced proportionally.
  let globalCapReduction = 0;
  for (const proto of Object.keys(globalProtocolTvl)) {
    const cap = protocolTvlCaps.get(proto);
    if (cap != null && cap > 0 && globalProtocolTvl[proto] > cap) {
      const excess = globalProtocolTvl[proto] - cap;
      globalCapReduction += excess;
      // Distribute reduction to chain TVLs proportionally
      const protoTotal = globalProtocolTvl[proto];
      for (const [pcKey, pcTvl] of Object.entries(globalProtoChainTvl)) {
        if (!pcKey.startsWith(`${proto}:`)) continue;
        const chain = pcKey.slice(proto.length + 1);
        const chainReduction = (pcTvl / protoTotal) * excess;
        globalChainTvl[chain] = Math.max(0, (globalChainTvl[chain] ?? 0) - chainReduction);
      }
      globalProtocolTvl[proto] = cap;
    }
  }
  globalTotalTvl -= globalCapReduction;

  const globalAgg: GlobalAgg = {
    totalTvl: globalTotalTvl,
    totalVol24h: globalTotalVol24h,
    totalVol7d: globalTotalVol7d,
    poolCount: globalPoolCount,
    chainCount: globalChains.size,
    protocolTvl: globalProtocolTvl,
    chainTvl: globalChainTvl,
  };

  return {
    scores: results,
    globalAgg,
    retainedPoolsByStablecoin,
    tvlStabilityMap,
    diagnostics: {
      protocolCapReductions: {
        cappedPoolCount: protocolCapDiagnostics.cappedPoolCount,
        cappedProtocols: protocolCapDiagnostics.cappedProtocols,
        reducedTvlUsd: protocolCapDiagnostics.reducedTvlUsd + Math.round(globalCapReduction),
      },
    },
  };
}

/** Compute depth stability (CV-based) and persist to D1. Accepts pre-loaded data to avoid redundant DB scan. */
export async function computeDepthStability(
  db: D1Database,
  preloadedTvlStabilityMap?: Map<string, number>,
): Promise<void> {
  try {
    const tvlStabilityMap = preloadedTvlStabilityMap ?? (await loadConfidentHistoryStability(db)).tvlStabilityMap;

    const stabilityStmts: D1PreparedStatement[] = [];
    stabilityStmts.push(
      db.prepare("UPDATE dex_liquidity SET depth_stability = NULL WHERE stablecoin_id != '__global__'")
    );
    for (const [id, stability] of tvlStabilityMap) {
      stabilityStmts.push(
        db.prepare("UPDATE dex_liquidity SET depth_stability = ? WHERE stablecoin_id = ?").bind(stability, id)
      );
    }
    if (stabilityStmts.length > 0) {
      await batchExecute(db, stabilityStmts);
      console.log(`[dex-liquidity] Updated depth stability for ${tvlStabilityMap.size} coins`);
    }
  } catch (err) {
    console.warn("[dex-liquidity] Depth stability computation failed:", err);
  }
}

/** Compute DEX-implied prices from all observations (TVL-weighted median) and persist to dex_prices. */
export async function computeDexPrices(
  db: D1Database,
  priceObservations: Map<string, DexPriceObs[]>,
  nowSec: number,
): Promise<void> {
  const existingRows = await db
    .prepare("SELECT stablecoin_id FROM dex_prices")
    .all<{ stablecoin_id: string }>();
  const existingIds = new Set((existingRows.results ?? []).map((row) => row.stablecoin_id));

  if (priceObservations.size === 0) {
    if (existingIds.size === 0) return;

    const retireStmts = Array.from(existingIds, (stablecoinId) =>
      db.prepare("DELETE FROM dex_prices WHERE stablecoin_id = ?").bind(stablecoinId)
    );
    await batchExecute(db, retireStmts);
    console.log(`[dex-liquidity] Retired ${retireStmts.length} DEX price rows with no current observations`);
    return;
  }

  // Load primary prices from stablecoins cache for comparison
  const primaryPrices = new Map<string, number>();
  const stablecoinsCache = await loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: false });
  if (stablecoinsCache.kind === "ok") {
    for (const asset of stablecoinsCache.payload.peggedAssets) {
      if (asset.price != null && typeof asset.price === "number" && asset.price > 0) {
        primaryPrices.set(asset.id, asset.price);
      }
    }
  }

  const priceStmts: D1PreparedStatement[] = [];
  const observedIds = new Set<string>();
  let collapsedDuplicateGroups = 0;
  let collapsedDuplicateObservations = 0;
  for (const [id, observations] of priceObservations) {
    if (observations.length === 0) continue;
    observedIds.add(id);

    const {
      collapsed: collapsedObservations,
      duplicateGroups,
      duplicateObservations,
    } = collapseDuplicateObservations(observations);
    collapsedDuplicateGroups += duplicateGroups;
    collapsedDuplicateObservations += duplicateObservations;
    if (collapsedObservations.length === 0) continue;

    // Look up primary price early — used for outlier filtering and deviation calc
    const primaryPrice = primaryPrices.get(id);

    // H2: Filter extreme outliers relative to primary price before computing median.
    // When a source (e.g. CoinGecko aggregate) reports a price near peg for a severely
    // depegged stablecoin, its high TVL can dominate the TVL-weighted median.
    // Only apply when 3+ observations exist and majority by count agrees with primary.
    let medianInputObs = collapsedObservations;
    if (primaryPrice != null && primaryPrice > 0 && collapsedObservations.length >= 3) {
      const MAX_DEVIATION_RATIO = 2.5;
      const nearPrimary = collapsedObservations.filter((o) => {
        const ratio = o.price / primaryPrice;
        return ratio >= (1 / MAX_DEVIATION_RATIO) && ratio <= MAX_DEVIATION_RATIO;
      });
      if (nearPrimary.length >= 2 && nearPrimary.length > collapsedObservations.length / 2) {
        medianInputObs = nearPrimary;
      }
    }

    // H1: Scale TVL weights by source confidence before computing median
    const adjustedObs = medianInputObs.map((o) => ({
      ...o,
      tvl: o.tvl * dexPriceConfidenceForProtocol(o.protocol),
    }));

    // TVL-weighted median: sort by price, walk until cumulative (confidence-weighted) TVL crosses 50%
    adjustedObs.sort((a, b) => a.price - b.price);
    const adjustedTotalTvl = adjustedObs.reduce((s, o) => s + o.tvl, 0);
    const halfTvl = adjustedTotalTvl / 2;
    let cumTvl = 0;
    let medianPrice = adjustedObs[0].price;
    for (const obs of adjustedObs) {
      cumTvl += obs.tvl;
      if (cumTvl >= halfTvl) {
        medianPrice = obs.price;
        break;
      }
    }

    // Raw TVL for DB storage (represents actual on-chain liquidity, not confidence-weighted)
    const totalTvl = collapsedObservations.reduce((s, o) => s + o.tvl, 0);
    let deviationBps: number | null = null;
    if (primaryPrice != null && primaryPrice > 0) {
      deviationBps = Math.round(((medianPrice / primaryPrice) - 1) * 10000);
    }

    // Persist one aggregate per protocol for the primary-pricing bridge.
    const protocolSources = aggregateProtocolSources(collapsedObservations);

    const meta = TRACKED_META_BY_ID.get(id);
    const symbol = meta?.symbol ?? id;

    priceStmts.push(
      db
        .prepare(
          `INSERT INTO dex_prices
            (stablecoin_id, symbol, dex_price_usd, source_pool_count, source_total_tvl,
             deviation_from_primary_bps, primary_price_at_calc, price_sources_json, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(stablecoin_id) DO UPDATE SET
            symbol = excluded.symbol,
            dex_price_usd = excluded.dex_price_usd,
            source_pool_count = excluded.source_pool_count,
            source_total_tvl = excluded.source_total_tvl,
            deviation_from_primary_bps = excluded.deviation_from_primary_bps,
            primary_price_at_calc = excluded.primary_price_at_calc,
            price_sources_json = excluded.price_sources_json,
            updated_at = excluded.updated_at
          WHERE dex_prices.updated_at <= excluded.updated_at`
        )
        .bind(
          id,
          symbol,
          Math.round(medianPrice * 1e6) / 1e6, // 6 decimal places
          collapsedObservations.length,
          Math.round(totalTvl),
          deviationBps,
          primaryPrice ?? null,
          JSON.stringify(protocolSources),
          nowSec
        )
    );
  }

  let retiredCount = 0;
  for (const existingId of existingIds) {
    if (observedIds.has(existingId)) continue;
    priceStmts.push(
      db.prepare("DELETE FROM dex_prices WHERE stablecoin_id = ?").bind(existingId)
    );
    retiredCount++;
  }

  if (priceStmts.length > 0) {
    await batchExecute(db, priceStmts);
    console.log(
      `[dex-liquidity] Wrote ${observedIds.size} DEX price observations to dex_prices` +
      (collapsedDuplicateGroups > 0
        ? ` after collapsing ${collapsedDuplicateObservations} duplicate observations across ${collapsedDuplicateGroups} pool group(s)`
        : "") +
      (retiredCount > 0 ? ` and retired ${retiredCount} stale rows` : ""),
    );
  }
}
