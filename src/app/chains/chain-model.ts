import { canonicalizeChainCirculating } from "@shared/lib/chains/circulating";
import type { StablecoinData } from "@shared/types";
import type { ChainSummary } from "@shared/types/chains";

export type ChainSortKey =
  | "totalUsd"
  | "healthScore"
  | "change24hPct"
  | "change7dPct"
  | "change30dPct"
  | "stablecoinCount"
  | "dominanceShare";

export function sortChains(chains: ChainSummary[], key: ChainSortKey, dir: "asc" | "desc"): ChainSummary[] {
  return [...chains].sort((a, b) => {
    const av = a[key] ?? -Infinity;
    const bv = b[key] ?? -Infinity;
    return dir === "desc" ? bv - av : av - bv;
  });
}

function deriveTopStablecoinsByChain(
  chains: readonly ChainSummary[],
  stablecoins: readonly StablecoinData[],
): Map<string, NonNullable<ChainSummary["topStablecoins"]>> {
  const chainIds = new Set(chains.map((chain) => chain.id));
  const cargosByChain = new Map<string, Array<{ id: string; symbol: string; supplyUsd: number }>>();
  const totalsByChain = new Map<string, number>();

  for (const asset of stablecoins) {
    for (const [chainId, chainData] of canonicalizeChainCirculating(asset.chainCirculating)) {
      if (!chainIds.has(chainId) || chainData.current <= 0) continue;
      let cargos = cargosByChain.get(chainId);
      if (!cargos) {
        cargos = [];
        cargosByChain.set(chainId, cargos);
      }
      cargos.push({
        id: asset.id,
        symbol: asset.symbol,
        supplyUsd: chainData.current,
      });
      totalsByChain.set(chainId, (totalsByChain.get(chainId) ?? 0) + chainData.current);
    }
  }

  const topByChain = new Map<string, NonNullable<ChainSummary["topStablecoins"]>>();
  for (const [chainId, cargos] of cargosByChain) {
    const totalUsd = totalsByChain.get(chainId) ?? 0;
    if (totalUsd <= 0) continue;
    topByChain.set(
      chainId,
      cargos
        .sort((a, b) => b.supplyUsd - a.supplyUsd)
        .slice(0, 5)
        .map((cargo) => ({
          ...cargo,
          share: cargo.supplyUsd / totalUsd,
        })),
    );
  }

  return topByChain;
}

export function attachTopStablecoinCargo(
  chains: readonly ChainSummary[],
  stablecoins: readonly StablecoinData[] | undefined,
): ChainSummary[] {
  if (!stablecoins?.length) return [...chains];
  const fallbackCargoByChain = deriveTopStablecoinsByChain(chains, stablecoins);

  return chains.map((chain) => {
    const expectedCargoCount = Math.min(chain.stablecoinCount, 5);
    if ((chain.topStablecoins?.length ?? 0) >= expectedCargoCount) return chain;

    const topStablecoins = fallbackCargoByChain.get(chain.id) ?? [];
    return topStablecoins.length > 0 ? { ...chain, topStablecoins } : chain;
  });
}
