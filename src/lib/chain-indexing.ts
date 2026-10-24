import { getActiveChainIds } from "@shared/lib/chains";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";

/**
 * A `/chains/<id>/` profile is indexed only when at least this many tracked
 * stablecoins (each with its own profile) have a mapped contract on the
 * chain. Thinner chain pages stay live and linked from `/chains/` but serve
 * `noindex, follow` and stay out of the sitemap and public route inventory:
 * the 41 chains below the bar drew 71 impressions in three months and made
 * up most of the chain URLs in crawled-not-indexed (2026-10-25 SEO plan, NQ5).
 */
export const MIN_INDEXABLE_CHAIN_STABLECOINS = 3;

const TRACKED_STABLECOIN_COUNT_BY_CHAIN: ReadonlyMap<string, number> = (() => {
  const counts = new Map<string, number>();
  for (const stablecoin of ACTIVE_STABLECOINS) {
    for (const chainId of new Set((stablecoin.contracts ?? []).map((contract) => contract.chain))) {
      counts.set(chainId, (counts.get(chainId) ?? 0) + 1);
    }
  }
  return counts;
})();

export function isChainProfileIndexable(chainId: string): boolean {
  return (TRACKED_STABLECOIN_COUNT_BY_CHAIN.get(chainId) ?? 0) >= MIN_INDEXABLE_CHAIN_STABLECOINS;
}

/** Chain profile IDs listed in the sitemap and public route inventory. */
export function getIndexableChainIds(): string[] {
  return getActiveChainIds().filter(isChainProfileIndexable);
}
