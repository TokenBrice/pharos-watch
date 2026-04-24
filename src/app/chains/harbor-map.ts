import { CHAIN_META } from "@shared/lib/chains";
import type { ChainSummary, HealthBand } from "@shared/types/chains";

const MAX_HARBORS = 8;

export interface ChainHarborCargo {
  id: string;
  symbol: string;
  sharePct: number;
  cargoUsd: number;
}

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
  dominantId: string;
  dominantSymbol: string;
  dominantSharePct: number;
  dominantCargoUsd: number;
  cargos: ChainHarborCargo[];
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

  const entries = top.map((chain) => {
    const dominantCargoUsd = chain.totalUsd * chain.dominantStablecoin.share;
    const topStablecoinCargo = (chain.topStablecoins ?? [])
      .filter((coin) => coin.supplyUsd > 0 && coin.share > 0)
      .map((coin) => ({
        id: coin.id,
        symbol: coin.symbol,
        sharePct: coin.share * 100,
        cargoUsd: coin.supplyUsd,
      }));
    const cargos = topStablecoinCargo.length > 0
      ? topStablecoinCargo
      : [{
        id: chain.dominantStablecoin.id,
        symbol: chain.dominantStablecoin.symbol,
        sharePct: chain.dominantStablecoin.share * 100,
        cargoUsd: dominantCargoUsd,
      }];

    return {
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
      dominantId: chain.dominantStablecoin.id,
      dominantSymbol: chain.dominantStablecoin.symbol,
      dominantSharePct: chain.dominantStablecoin.share * 100,
      dominantCargoUsd,
      cargos,
      change7dPct: chain.change7dPct,
    };
  });

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
