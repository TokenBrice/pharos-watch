import type { PegSummaryCoin } from "@shared/types";

export function buildPegSummaryCoinMap(
  coins: readonly PegSummaryCoin[] | null | undefined,
): Map<string, PegSummaryCoin> {
  const map = new Map<string, PegSummaryCoin>();
  if (!coins) return map;
  for (const coin of coins) {
    map.set(coin.id, coin);
  }
  return map;
}
