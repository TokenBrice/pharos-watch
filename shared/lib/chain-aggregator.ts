import { CHAIN_META, CHAIN_ALIASES } from "./chains";
import { TRACKED_META_BY_ID } from "./stablecoins";
import { getPegReference } from "./peg-rates";
import {
  computeConcentrationScore,
  computeBackingDiversityScore,
  computePegStabilityScore,
  computeQualityScore,
  computeHealthScore,
  getHealthBand,
  HEALTH_METHODOLOGY_VERSION,
} from "./chain-health";
import type { BackingType } from "../types";
import type {
  ChainSummary,
  ChainsResponse,
  ChainHealthFactors,
} from "../types/chains";

/** Narrow input type — only the fields the aggregator actually reads. */
export interface ChainAggregatorAsset {
  id: string;
  symbol: string;
  name?: string;
  price: number | null;
  pegType?: string;
  chainCirculating?: Record<string, { current?: number; circulatingPrevDay?: number; circulatingPrevWeek?: number; circulatingPrevMonth?: number }>;
}

export interface ChainAggregatorInput {
  peggedAssets: ChainAggregatorAsset[];
  safetyScores: Record<string, number>;
  pegRates: Record<string, number>;
}

interface ChainAccumulator {
  totalUsd: number;
  prevDay: number;
  prevWeek: number;
  prevMonth: number;
  coins: Array<{
    id: string;
    symbol: string;
    supplyUsd: number;
    price: number | null;
    pegType: string | undefined;
    safetyScore: number | null;
    backing: BackingType | undefined;
  }>;
}

/** Reverse lookup: DL chain name → CHAIN_META id (e.g. "BSC" → "bsc"). */
const CHAIN_NAME_TO_ID = new Map<string, string>();
for (const [id, meta] of Object.entries(CHAIN_META)) {
  CHAIN_NAME_TO_ID.set(meta.name.toLowerCase(), id);
}

function resolveCanonicalChainId(raw: string): string | null {
  // Try as-is first (exact ID match)
  const aliased = CHAIN_ALIASES[raw] ?? raw;
  if (CHAIN_META[aliased]) return aliased;

  // Try case-insensitive name lookup (DL uses chain names like "BSC", "Ethereum")
  const byName = CHAIN_NAME_TO_ID.get(raw.toLowerCase());
  if (byName) {
    const canonical = CHAIN_ALIASES[byName] ?? byName;
    return CHAIN_META[canonical] ? canonical : null;
  }

  return null;
}

export function aggregateChains(input: ChainAggregatorInput): ChainsResponse {
  const { peggedAssets, safetyScores, pegRates } = input;

  // Phase 1: accumulate per-chain data
  const accumulators = new Map<string, ChainAccumulator>();

  for (const asset of peggedAssets) {
    const cc = asset.chainCirculating;
    if (!cc || typeof cc !== "object") continue;

    for (const [rawChainId, data] of Object.entries(cc)) {
      if (!data || typeof data !== "object") continue;
      const d = data as { current?: number; circulatingPrevDay?: number; circulatingPrevWeek?: number; circulatingPrevMonth?: number };
      const current = d.current ?? 0;
      if (current <= 0) continue;

      const chainId = resolveCanonicalChainId(rawChainId);
      if (!chainId) continue;

      let acc = accumulators.get(chainId);
      if (!acc) {
        acc = { totalUsd: 0, prevDay: 0, prevWeek: 0, prevMonth: 0, coins: [] };
        accumulators.set(chainId, acc);
      }

      acc.totalUsd += current;
      acc.prevDay += d.circulatingPrevDay ?? 0;
      acc.prevWeek += d.circulatingPrevWeek ?? 0;
      acc.prevMonth += d.circulatingPrevMonth ?? 0;

      const meta = TRACKED_META_BY_ID.get(asset.id);
      acc.coins.push({
        id: asset.id,
        symbol: asset.symbol,
        supplyUsd: current,
        price: typeof asset.price === "number" ? asset.price : null,
        pegType: asset.pegType,
        safetyScore: safetyScores[asset.id] ?? null,
        backing: meta?.flags?.backing,
      });
    }
  }

  // Phase 2: compute summaries
  const globalTotalUsd = Array.from(accumulators.values()).reduce((s, a) => s + a.totalUsd, 0);
  const chains: ChainSummary[] = [];

  for (const [chainId, acc] of accumulators) {
    if (acc.totalUsd <= 0) continue;

    const meta = CHAIN_META[chainId];
    if (!meta) continue;

    // Deltas
    const change24h = acc.totalUsd - acc.prevDay;
    const change7d = acc.totalUsd - acc.prevWeek;
    const change30d = acc.totalUsd - acc.prevMonth;

    // Dominant stablecoin
    const sorted = [...acc.coins].sort((a, b) => b.supplyUsd - a.supplyUsd);
    const dominant = sorted[0];

    // Supply shares for concentration
    const shares = acc.coins.map((c) => c.supplyUsd / acc.totalUsd);

    // Backing distribution
    const backingTotals: Record<string, number> = { "rwa-backed": 0, "crypto-backed": 0, algorithmic: 0 };
    for (const coin of acc.coins) {
      const key = coin.backing ?? "rwa-backed";
      backingTotals[key] = (backingTotals[key] ?? 0) + coin.supplyUsd;
    }
    const backingDist: Record<string, number> = {};
    for (const [key, val] of Object.entries(backingTotals)) {
      backingDist[key] = acc.totalUsd > 0 ? val / acc.totalUsd : 0;
    }

    // Peg stability
    const pegCoins = acc.coins.map((c) => {
      const coinMeta = TRACKED_META_BY_ID.get(c.id);
      const pegRef = getPegReference(c.pegType, pegRates, coinMeta?.commodityOunces);
      return { price: c.price, pegRef, supplyUsd: c.supplyUsd };
    });

    // Quality
    const qualityCoins = acc.coins.map((c) => ({
      safetyScore: c.safetyScore,
      supplyUsd: c.supplyUsd,
    }));

    const healthFactors: ChainHealthFactors = {
      concentration: computeConcentrationScore(shares),
      quality: computeQualityScore(qualityCoins),
      pegStability: computePegStabilityScore(pegCoins),
      backingDiversity: computeBackingDiversityScore(backingDist),
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
      change24hPct: acc.prevDay > 0 ? change24h / acc.prevDay : 0,
      change7d,
      change7dPct: acc.prevWeek > 0 ? change7d / acc.prevWeek : 0,
      change30d,
      change30dPct: acc.prevMonth > 0 ? change30d / acc.prevMonth : 0,
      stablecoinCount: acc.coins.length,
      dominantStablecoin: {
        id: dominant.id,
        symbol: dominant.symbol,
        share: dominant.supplyUsd / acc.totalUsd,
      },
      dominanceShare: globalTotalUsd > 0 ? acc.totalUsd / globalTotalUsd : 0,
      healthScore,
      healthBand,
      healthFactors,
    });
  }

  chains.sort((a, b) => b.totalUsd - a.totalUsd);

  return {
    chains,
    globalTotalUsd,
    updatedAt: Math.floor(Date.now() / 1000),
    healthMethodologyVersion: HEALTH_METHODOLOGY_VERSION,
  };
}
