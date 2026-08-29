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

function buildChainHarborEntry(
  chain: ChainSummary,
  globalTotalUsd: number,
  maxSupply: number,
): ChainHarborEntry {
  const dominantCargoUsd = chain.totalUsd * chain.dominantStablecoin.share;
  const topStablecoinCargo = chain.topStablecoins
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
}

export function buildChainHarborEntries(
  chains: ChainSummary[],
  globalTotalUsd: number,
): ChainHarborEntry[] {
  const sorted = [...chains].sort((a, b) => b.totalUsd - a.totalUsd);
  const maxSupply = sorted[0]?.totalUsd ?? 0;
  return sorted.map((chain) => buildChainHarborEntry(chain, globalTotalUsd, maxSupply));
}

export function buildChainHarborModelFromEntries(
  allEntries: readonly ChainHarborEntry[],
  globalTotalUsd: number,
): ChainHarborModel {
  const entries = allEntries.slice(0, MAX_HARBORS);
  const topSupply = entries.reduce((sum, entry) => sum + entry.totalUsd, 0);
  const scored = allEntries
    .map((entry) => entry.healthScore)
    .filter((score): score is number => score != null);

  return {
    totalUsd: globalTotalUsd,
    harborCount: allEntries.length,
    entries,
    topSharePct: globalTotalUsd > 0 ? (topSupply / globalTotalUsd) * 100 : 0,
    largestHarbor: entries[0] ?? null,
    fragileHarbors: allEntries.filter((entry) => entry.healthBand === "fragile" || entry.healthBand === "concentrated").length,
    averageHealthScore: scored.length > 0
      ? Math.round(scored.reduce((sum, score) => sum + score, 0) / scored.length)
      : null,
  };
}

export function buildChainHarborModel(
  chains: ChainSummary[],
  globalTotalUsd: number,
): ChainHarborModel {
  return buildChainHarborModelFromEntries(buildChainHarborEntries(chains, globalTotalUsd), globalTotalUsd);
}

export const HARBOR_MAX = MAX_HARBORS;
