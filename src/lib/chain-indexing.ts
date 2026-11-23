import { getActiveChainIds } from "@shared/lib/chains";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  countStablecoinsByChain,
  MIN_INDEXABLE_CHAIN_STABLECOINS,
} from "@/lib/stablecoin-taxonomy-urls";

export { MIN_INDEXABLE_CHAIN_STABLECOINS };

const TRACKED_STABLECOIN_COUNT_BY_CHAIN: ReadonlyMap<string, number> = countStablecoinsByChain(ACTIVE_STABLECOINS);

export function isChainProfileIndexable(chainId: string): boolean {
  return (TRACKED_STABLECOIN_COUNT_BY_CHAIN.get(chainId) ?? 0) >= MIN_INDEXABLE_CHAIN_STABLECOINS;
}

/** Chain profile IDs listed in the sitemap and public route inventory. */
export function getIndexableChainIds(): string[] {
  return getActiveChainIds().filter(isChainProfileIndexable);
}
