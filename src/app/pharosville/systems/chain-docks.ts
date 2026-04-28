import type { ChainsResponse, ChainSummary } from "@shared/types/chains";
import type { DockNode, DockStablecoin } from "./world-types";
import { DOCK_TILES } from "./world-layout";

export const MAX_CHAIN_HARBORS = 6;
export const MAX_DOCK_SIZE = 10;

const DOCK_ASSET_IDS = [
  "dock.grand-quay",
  "dock.container-wharf",
  "dock.twin-slip",
  "dock.stone-breakwater",
  "dock.market-marina",
  "dock.relay-pontoon",
] as const;

function dockSize(chain: ChainSummary, globalTotalUsd: number): number {
  const shareSize = globalTotalUsd > 0
    ? Math.ceil((chain.totalUsd / globalTotalUsd) * MAX_DOCK_SIZE)
    : 1;
  const absoluteSize =
    chain.totalUsd >= 50_000_000_000 ? 10
    : chain.totalUsd >= 20_000_000_000 ? 9
    : chain.totalUsd >= 10_000_000_000 ? 8
    : chain.totalUsd >= 5_000_000_000 ? 7
    : chain.totalUsd >= 2_000_000_000 ? 6
    : chain.totalUsd >= 1_000_000_000 ? 5
    : chain.totalUsd >= 500_000_000 ? 4
    : chain.totalUsd >= 100_000_000 ? 3
    : chain.totalUsd >= 25_000_000 ? 2
    : 1;
  return Math.max(1, Math.min(MAX_DOCK_SIZE, Math.max(shareSize, absoluteSize)));
}

function harboredStablecoins(chain: ChainSummary): DockStablecoin[] {
  const top = (chain.topStablecoins ?? [])
    .filter((coin) => coin.supplyUsd > 0 && coin.share > 0)
    .map((coin) => ({
      id: coin.id,
      symbol: coin.symbol,
      share: coin.share,
      supplyUsd: coin.supplyUsd,
    }));

  if (top.length > 0) return top;

  return [{
    id: chain.dominantStablecoin.id,
    symbol: chain.dominantStablecoin.symbol,
    share: chain.dominantStablecoin.share,
    supplyUsd: chain.totalUsd * chain.dominantStablecoin.share,
  }];
}

export function buildChainDocks(chains: ChainsResponse | null | undefined): DockNode[] {
  if (!chains?.chains?.length) return [];
  return chains.chains
    .toSorted((a, b) => b.totalUsd - a.totalUsd)
    .slice(0, MAX_CHAIN_HARBORS)
    .map((chain, index) => ({
      id: `dock.${chain.id}`,
      kind: "dock",
      label: chain.name,
      chainId: chain.id,
      assetId: DOCK_ASSET_IDS[index] ?? "dock.wooden-pier",
      tile: DOCK_TILES[index],
      totalUsd: chain.totalUsd,
      size: dockSize(chain, chains.globalTotalUsd),
      healthBand: chain.healthBand,
      stablecoinCount: chain.stablecoinCount,
      concentration: chain.healthFactors?.concentration ?? null,
      harboredStablecoins: harboredStablecoins(chain),
      detailId: `dock.${chain.id}`,
    }));
}
