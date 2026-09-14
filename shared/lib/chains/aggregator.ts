import { CHAIN_META, getChainResilienceTier, resolveChainId } from "./index";
import { canonicalizeChainCirculating } from "./circulating";
import { TRACKED_META_BY_ID } from "../stablecoins/registry";
import { getPegReference } from "../peg-rates";
import { getCirculatingRaw, getPrevDayRawOrNull, getPrevWeekRawOrNull, getPrevMonthRawOrNull } from "../supply";
import { relativeChangeRatio } from "../stats";
import { ZERO_RATIO, type Ratio } from "../../types/ratio";
import {
  ACTIVE_BACKING_DIVERSITY_TYPES,
  computeConcentrationScore,
  computeBackingDiversityScore,
  computePegStabilityScore,
  computeQualityScore,
  computeChainEnvironmentAssessment,
  computeHealthScore,
  getHealthBand,
  HEALTH_METHODOLOGY_VERSION,
} from "./health";
import type { BackingType } from "../../types";
import type {
  ChainSummary,
  ChainsResponse,
  ChainHealthFactors,
} from "../../types/chains";

/** Narrow input type — only the fields the aggregator actually reads. */
export interface ChainAggregatorAsset {
  id: string;
  symbol: string;
  name?: string;
  price: number | null;
  pegType?: string;
  circulating?: Record<string, number>;
  circulatingPrevDay?: Record<string, number>;
  circulatingPrevWeek?: Record<string, number>;
  circulatingPrevMonth?: Record<string, number> | null;
  chainCirculating?: Record<string, { chainId?: string; current?: number; circulatingPrevDay?: number; circulatingPrevWeek?: number; circulatingPrevMonth?: number }>;
}

export interface ChainAggregatorInput {
  peggedAssets: ChainAggregatorAsset[];
  safetyScores: Record<string, number>;
  pegRates: Record<string, number>;
  /**
   * When set, the response also carries `chainDetail` with the full coin rows
   * for that chain (names, per-coin deltas, chain-local shares). Absent input
   * keeps the leaderboard payload byte-identical.
   */
  detailChainId?: string;
}

interface ChainAccumulator {
  totalUsd: number;
  prevDay: number;
  prevWeek: number;
  pairedCurrent24h: number;
  pairedCurrent7d: number;
  pairedCurrent30d: number;
  pairedPrevMonth: number;
  has24hHistory: boolean;
  has7dHistory: boolean;
  has30dHistory: boolean;
  coins: Array<{
    id: string;
    name: string;
    symbol: string;
    supplyUsd: number;
    price: number | null;
    pegType: string | undefined;
    safetyScore: number | null;
    backing: BackingType | undefined;
    prevDay: number | null;
    prevWeek: number | null;
    prevMonth: number | null;
  }>;
}

export function aggregateChains(input: ChainAggregatorInput): ChainsResponse {
  const { peggedAssets, safetyScores, pegRates } = input;

  // Phase 1: accumulate per-chain data
  const accumulators = new Map<string, ChainAccumulator>();
  let aggregateTotalUsd = 0;
  let aggregatePrevDayUsd = 0;
  let aggregatePrevWeekUsd = 0;
  let aggregatePrevMonthUsd = 0;
  let aggregatePairedCurrent24hUsd = 0;
  let aggregatePairedCurrent7dUsd = 0;
  let aggregatePairedCurrent30dUsd = 0;
  let hasAggregate24hHistory = false;
  let hasAggregate7dHistory = false;
  let hasAggregate30dHistory = false;
  let hasAggregateSupply = false;

  for (const asset of peggedAssets) {
    if (asset.circulating) {
      hasAggregateSupply = true;
      aggregateTotalUsd += getCirculatingRaw(asset);
      const prevDay = getPrevDayRawOrNull(asset);
      if (prevDay != null) {
        aggregatePairedCurrent24hUsd += getCirculatingRaw(asset);
        aggregatePrevDayUsd += prevDay;
        hasAggregate24hHistory = true;
      }
      const prevWeek = getPrevWeekRawOrNull(asset);
      if (prevWeek != null) {
        aggregatePairedCurrent7dUsd += getCirculatingRaw(asset);
        aggregatePrevWeekUsd += prevWeek;
        hasAggregate7dHistory = true;
      }
      const prevMonth = getPrevMonthRawOrNull(asset);
      if (prevMonth != null) {
        aggregatePairedCurrent30dUsd += getCirculatingRaw(asset);
        aggregatePrevMonthUsd += prevMonth;
        hasAggregate30dHistory = true;
      }
    }

    const canonicalChainCirculating = canonicalizeChainCirculating(asset.chainCirculating);
    const pairedChainCirculating = new Map<string, { current: number; prevMonth: number }>();
    for (const [rawChainId, data] of Object.entries(asset.chainCirculating ?? {})) {
      if (!data || typeof data !== "object") continue;
      const chainId = (typeof data.chainId === "string" ? resolveChainId(data.chainId) : null)
        ?? resolveChainId(rawChainId);
      const prevMonth = data.circulatingPrevMonth;
      if (!chainId || typeof prevMonth !== "number" || !Number.isFinite(prevMonth) || prevMonth < 0) continue;
      const current = typeof data.current === "number" && Number.isFinite(data.current) && data.current >= 0
        ? data.current
        : 0;
      const existing = pairedChainCirculating.get(chainId);
      if (existing) {
        existing.current += current;
        existing.prevMonth += prevMonth;
      } else {
        pairedChainCirculating.set(chainId, { current, prevMonth });
      }
    }

    for (const [chainId, data] of canonicalChainCirculating) {
      const current = data.current;

      let acc = accumulators.get(chainId);
      if (!acc) {
        acc = { totalUsd: 0, prevDay: 0, prevWeek: 0, pairedCurrent24h: 0, pairedCurrent7d: 0, pairedCurrent30d: 0, pairedPrevMonth: 0, has24hHistory: false, has7dHistory: false, has30dHistory: false, coins: [] };
        accumulators.set(chainId, acc);
      }
      acc.totalUsd += current;
      if (data.circulatingPrevDay != null) {
        acc.pairedCurrent24h += current;
        acc.prevDay += data.circulatingPrevDay;
        acc.has24hHistory = true;
      }
      if (data.circulatingPrevWeek != null) {
        acc.pairedCurrent7d += current;
        acc.prevWeek += data.circulatingPrevWeek;
        acc.has7dHistory = true;
      }
      const paired = pairedChainCirculating.get(chainId);
      if (paired) {
        acc.pairedCurrent30d += paired.current;
        acc.pairedPrevMonth += paired.prevMonth;
        acc.has30dHistory = true;
      }

      // Zero-supply rows still contribute redemptions to paired deltas.
      if (current <= 0) continue;
      const meta = TRACKED_META_BY_ID.get(asset.id);
      acc.coins.push({
        id: asset.id,
        name: asset.name ?? asset.symbol,
        symbol: asset.symbol,
        supplyUsd: current,
        price: typeof asset.price === "number" ? asset.price : null,
        pegType: asset.pegType,
        safetyScore: safetyScores[asset.id] ?? null,
        backing: meta?.flags?.backing,
        prevDay: data.circulatingPrevDay ?? null,
        prevWeek: data.circulatingPrevWeek ?? null,
        prevMonth: data.circulatingPrevMonth ?? null,
      });
    }
  }

  // Phase 2: compute summaries
  let rawChainAttributedTotalUsd = 0;
  let chainPairedCurrent24hUsd = 0;
  let chainPairedCurrent7dUsd = 0;
  let chainPrevDayUsd = 0;
  let chainPrevWeekUsd = 0;
  let chainPrevMonthUsd = 0;
  let chainPairedCurrent30dUsd = 0;
  let hasChain24hHistory = false;
  let hasChain7dHistory = false;
  let hasChain30dHistory = false;
  for (const a of accumulators.values()) {
    rawChainAttributedTotalUsd += a.totalUsd;
    chainPairedCurrent24hUsd += a.pairedCurrent24h;
    chainPairedCurrent7dUsd += a.pairedCurrent7d;
    chainPrevDayUsd += a.prevDay;
    chainPrevWeekUsd += a.prevWeek;
    chainPairedCurrent30dUsd += a.pairedCurrent30d;
    chainPrevMonthUsd += a.pairedPrevMonth;
    hasChain24hHistory ||= a.has24hHistory;
    hasChain7dHistory ||= a.has7dHistory;
    hasChain30dHistory ||= a.has30dHistory;
  }
  const useAggregateSupply = hasAggregateSupply;
  const globalTotalUsd = useAggregateSupply ? aggregateTotalUsd : rawChainAttributedTotalUsd;
  const globalPrevDayUsd = useAggregateSupply ? aggregatePrevDayUsd : chainPrevDayUsd;
  const globalPrevWeekUsd = useAggregateSupply ? aggregatePrevWeekUsd : chainPrevWeekUsd;
  const globalPrevMonthUsd = useAggregateSupply ? aggregatePrevMonthUsd : chainPrevMonthUsd;
  const globalPairedCurrent24hUsd = useAggregateSupply ? aggregatePairedCurrent24hUsd : chainPairedCurrent24hUsd;
  const globalPairedCurrent7dUsd = useAggregateSupply ? aggregatePairedCurrent7dUsd : chainPairedCurrent7dUsd;
  const hasGlobal24hHistory = useAggregateSupply ? hasAggregate24hHistory : hasChain24hHistory;
  const hasGlobal7dHistory = useAggregateSupply ? hasAggregate7dHistory : hasChain7dHistory;
  const hasGlobal30dHistory = useAggregateSupply ? hasAggregate30dHistory : hasChain30dHistory;
  const globalPairedCurrent30dUsd = useAggregateSupply ? aggregatePairedCurrent30dUsd : chainPairedCurrent30dUsd;
  const chainAttributedTotalUsd = Math.min(rawChainAttributedTotalUsd, globalTotalUsd);
  const chainAttributionScale = rawChainAttributedTotalUsd > globalTotalUsd
    ? globalTotalUsd / rawChainAttributedTotalUsd
    : 1;
  const unattributedTotalUsd = globalTotalUsd - chainAttributedTotalUsd;
  const chains: ChainSummary[] = [];

  for (const [chainId, acc] of accumulators) {
    if (acc.totalUsd <= 0) continue;

    const meta = CHAIN_META[chainId];
    if (!meta) continue;

    // Deltas
    const change24h = acc.has24hHistory ? acc.pairedCurrent24h - acc.prevDay : null;
    const change7d = acc.has7dHistory ? acc.pairedCurrent7d - acc.prevWeek : null;
    const change30d = acc.has30dHistory ? acc.pairedCurrent30d - acc.pairedPrevMonth : null;

    // Dominant stablecoin
    const sorted = [...acc.coins].sort((a, b) => b.supplyUsd - a.supplyUsd);
    const dominant = sorted[0];
    const topStablecoins = sorted.slice(0, 5).map((coin) => ({
      id: coin.id,
      symbol: coin.symbol,
      share: coin.supplyUsd / acc.totalUsd,
      supplyUsd: coin.supplyUsd,
    }));

    // Supply shares for concentration
    const shares = acc.coins.map((c) => c.supplyUsd / acc.totalUsd);

    // Backing distribution
    const backingTotals: Record<string, number> = Object.fromEntries(
      ACTIVE_BACKING_DIVERSITY_TYPES.map((type) => [type, 0]),
    );
    for (const coin of acc.coins) {
      if (coin.backing && coin.backing in backingTotals) {
        backingTotals[coin.backing] += coin.supplyUsd;
      }
    }

    // Peg stability
    const pegCoins = acc.coins.flatMap((c) => {
      const coinMeta = TRACKED_META_BY_ID.get(c.id);
      const pegRef = getPegReference(c.pegType, pegRates, coinMeta?.commodityOunces);
      return pegRef == null ? [] : [{ price: c.price, pegRef, supplyUsd: c.supplyUsd }];
    });

    // Quality
    const qualityCoins = acc.coins.map((c) => ({
      safetyScore: c.safetyScore,
      supplyUsd: c.supplyUsd,
    }));

    // Chain environment
    const resilienceTier = getChainResilienceTier(chainId);
    const chainEnvironmentEvidence = computeChainEnvironmentAssessment(resilienceTier, chainId);

    const healthFactors: ChainHealthFactors = {
      concentration: computeConcentrationScore(shares),
      quality: computeQualityScore(qualityCoins),
      pegStability: computePegStabilityScore(pegCoins),
      backingDiversity: computeBackingDiversityScore(backingTotals),
      chainEnvironment: chainEnvironmentEvidence.score,
    };

    const healthScore = computeHealthScore(healthFactors);
    const healthBand = getHealthBand(healthScore);

    chains.push({
      id: chainId,
      name: meta.name,
      logoPath: meta.logoPath,
      type: meta.type,
      totalUsd: acc.totalUsd,
      change24h,
      change24hPct: change24h == null ? null : (relativeChangeRatio(acc.pairedCurrent24h, acc.prevDay) ?? ZERO_RATIO),
      change7d,
      change7dPct: change7d == null ? null : (relativeChangeRatio(acc.pairedCurrent7d, acc.prevWeek) ?? ZERO_RATIO),
      change30d,
      change30dPct: change30d == null ? null : (relativeChangeRatio(acc.pairedCurrent30d, acc.pairedPrevMonth) ?? ZERO_RATIO),
      stablecoinCount: acc.coins.length,
      dominantStablecoin: {
        id: dominant.id,
        symbol: dominant.symbol,
        share: dominant.supplyUsd / acc.totalUsd,
      },
      topStablecoins,
      dominanceShare: globalTotalUsd > 0 ? (acc.totalUsd * chainAttributionScale) / globalTotalUsd : 0,
      healthScore,
      healthBand,
      healthFactors,
      chainEnvironmentEvidence,
    });
  }

  chains.sort((a, b) => b.totalUsd - a.totalUsd);

  const detailAcc = input.detailChainId != null ? accumulators.get(input.detailChainId) : undefined;
  const chainDetail = detailAcc && detailAcc.totalUsd > 0 && CHAIN_META[input.detailChainId!]
    ? {
      chainId: input.detailChainId!,
      totalUsd: detailAcc.totalUsd,
      coins: [...detailAcc.coins]
        .sort((a, b) => b.supplyUsd - a.supplyUsd)
        .map((coin) => ({
          id: coin.id,
          name: coin.name,
          symbol: coin.symbol,
          price: coin.price,
          pegType: coin.pegType,
          supplyUsd: coin.supplyUsd,
          // Chain-local denominator: the chain's own total, never the global aggregate.
          chainShare: (coin.supplyUsd / detailAcc.totalUsd) as Ratio,
          change24h: coin.prevDay == null ? null : coin.supplyUsd - coin.prevDay,
          change24hPct: coin.prevDay == null ? null : (relativeChangeRatio(coin.supplyUsd, coin.prevDay) ?? ZERO_RATIO),
          change7d: coin.prevWeek == null ? null : coin.supplyUsd - coin.prevWeek,
          change7dPct: coin.prevWeek == null ? null : (relativeChangeRatio(coin.supplyUsd, coin.prevWeek) ?? ZERO_RATIO),
          change30d: coin.prevMonth == null ? null : coin.supplyUsd - coin.prevMonth,
          change30dPct: coin.prevMonth == null ? null : (relativeChangeRatio(coin.supplyUsd, coin.prevMonth) ?? ZERO_RATIO),
          backing: coin.backing,
        })),
    }
    : undefined;

  return {
    chains,
    globalTotalUsd,
    chainAttributedTotalUsd,
    unattributedTotalUsd,
    globalChange24hPct: hasGlobal24hHistory
      ? (relativeChangeRatio(globalPairedCurrent24hUsd, globalPrevDayUsd) ?? ZERO_RATIO) : null,
    globalChange7dPct: hasGlobal7dHistory
      ? (relativeChangeRatio(globalPairedCurrent7dUsd, globalPrevWeekUsd) ?? ZERO_RATIO) : null,
    globalChange30dPct: hasGlobal30dHistory
      ? (relativeChangeRatio(globalPairedCurrent30dUsd, globalPrevMonthUsd) ?? ZERO_RATIO)
      : null,
    ...(chainDetail ? { chainDetail } : {}),
    updatedAt: Math.floor(Date.now() / 1000),
    healthMethodologyVersion: HEALTH_METHODOLOGY_VERSION,
  };
}
