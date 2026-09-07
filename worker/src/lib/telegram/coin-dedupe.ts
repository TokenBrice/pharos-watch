import type { ResolvedCoin } from "./alerts";

/** Dedupes resolved coins by id, preserving first-seen order. */
export function dedupeCoins(coins: ResolvedCoin[]): ResolvedCoin[] {
  const deduped: ResolvedCoin[] = [];
  const seenIds = new Set<string>();

  for (const coin of coins) {
    if (seenIds.has(coin.id)) continue;
    seenIds.add(coin.id);
    deduped.push(coin);
  }

  return deduped;
}
