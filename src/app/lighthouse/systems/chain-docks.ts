import type { ChainsResponse, ChainSummary } from "@shared/types/chains";
import type { DockNode } from "./world-types";
import { DOCK_TILES } from "./world-layout";

function dockSize(chain: ChainSummary, globalTotalUsd: number): number {
  if (globalTotalUsd <= 0) return 1;
  return Math.max(1, Math.min(8, Math.ceil((chain.totalUsd / globalTotalUsd) * 10)));
}

export function buildChainDocks(chains: ChainsResponse | null | undefined): DockNode[] {
  if (!chains?.chains?.length) return [];
  return chains.chains
    .toSorted((a, b) => b.totalUsd - a.totalUsd)
    .slice(0, DOCK_TILES.length)
    .map((chain, index) => ({
      id: `dock.${chain.id}`,
      kind: "dock",
      label: chain.name,
      chainId: chain.id,
      tile: DOCK_TILES[index],
      totalUsd: chain.totalUsd,
      size: dockSize(chain, chains.globalTotalUsd),
      healthBand: chain.healthBand,
      stablecoinCount: chain.stablecoinCount,
      concentration: chain.healthFactors?.concentration ?? null,
      detailId: `dock.${chain.id}`,
    }));
}
