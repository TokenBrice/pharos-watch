/**
 * The active-depeg census: `/api/peg-summary` coins flagged `activeDepeg` over
 * the active registry. One reducer for the homepage market-state line, the
 * Active Depegs card and the route share cards. The id set is passed in so
 * client bundles can supply their generated projection instead of loading the
 * registry.
 */
export function selectActiveDepegCoins<T extends { id: string; activeDepeg?: boolean | null }>(
  coins: readonly T[],
  activeIds: ReadonlySet<string>,
): T[] {
  return coins.filter((coin) => activeIds.has(coin.id) && coin.activeDepeg === true);
}
