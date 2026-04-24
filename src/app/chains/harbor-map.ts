import { CHAIN_META } from "@shared/lib/chains";
import type { ChainSummary, HealthBand } from "@shared/types/chains";

const MAX_HARBORS = 8;

export interface ChainHarborEntry {
  id: string;
  name: string;
  logoPath: string;
  darkInvert: boolean;
  totalUsd: number;
  sharePct: number;
  berthPct: number;
  healthScore: number | null;
  healthBand: HealthBand | null;
  stablecoinCount: number;
  dominantSymbol: string;
  dominantSharePct: number;
  change7dPct: number;
}

export interface ChainHarborModel {
  totalUsd: number;
  harborCount: number;
  entries: ChainHarborEntry[];
  topSharePct: number;
  largestHarbor: ChainHarborEntry | null;
  fragileHarbors: number;
  averageHealthScore: number | null;
}

export function buildChainHarborModel(
  chains: ChainSummary[],
  globalTotalUsd: number,
): ChainHarborModel {
  const sorted = [...chains].sort((a, b) => b.totalUsd - a.totalUsd);
  const top = sorted.slice(0, MAX_HARBORS);
  const maxSupply = top[0]?.totalUsd ?? 0;
  const topSupply = top.reduce((sum, chain) => sum + chain.totalUsd, 0);
  const scored = chains
    .map((chain) => chain.healthScore)
    .filter((score): score is number => score != null);

  const entries = top.map((chain) => ({
    id: chain.id,
    name: chain.name,
    logoPath: chain.logoPath,
    darkInvert: CHAIN_META[chain.id]?.darkInvert ?? false,
    totalUsd: chain.totalUsd,
    sharePct: globalTotalUsd > 0 ? (chain.totalUsd / globalTotalUsd) * 100 : 0,
    berthPct: maxSupply > 0 ? (chain.totalUsd / maxSupply) * 100 : 0,
    healthScore: chain.healthScore,
    healthBand: chain.healthBand,
    stablecoinCount: chain.stablecoinCount,
    dominantSymbol: chain.dominantStablecoin.symbol,
    dominantSharePct: chain.dominantStablecoin.share * 100,
    change7dPct: chain.change7dPct,
  }));

  return {
    totalUsd: globalTotalUsd,
    harborCount: chains.length,
    entries,
    topSharePct: globalTotalUsd > 0 ? (topSupply / globalTotalUsd) * 100 : 0,
    largestHarbor: entries[0] ?? null,
    fragileHarbors: chains.filter((chain) => chain.healthBand === "fragile" || chain.healthBand === "concentrated").length,
    averageHealthScore: scored.length > 0
      ? Math.round(scored.reduce((sum, score) => sum + score, 0) / scored.length)
      : null,
  };
}

export const HARBOR_MAX = MAX_HARBORS;
