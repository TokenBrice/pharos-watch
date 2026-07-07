import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";

/**
 * Strip entries whose id is in the frozen set. Generic over the iteration
 * shape — pass an extractor that returns the stablecoin id for each item.
 */
export function excludeFrozenIds<T>(
  items: readonly T[],
  getId: (item: T) => string,
  frozenIds: ReadonlySet<string> = FROZEN_IDS,
): T[] {
  return items.filter((item) => !frozenIds.has(getId(item)));
}
