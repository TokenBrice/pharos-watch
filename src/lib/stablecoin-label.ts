import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";

const symbolCounts = new Map<string, number>();
for (const coin of CLIENT_TRACKED_META_BY_ID.values()) {
  const symbol = coin.symbol.toUpperCase();
  symbolCounts.set(symbol, (symbolCounts.get(symbol) ?? 0) + 1);
}

/** Resolve identity against the registry, not the currently visible subset. */
export function stablecoinLabel(coin: { id: string; symbol: string }): string {
  const meta = CLIENT_TRACKED_META_BY_ID.get(coin.id);
  const symbol = meta?.symbol ?? coin.symbol;
  return meta && (symbolCounts.get(symbol.toUpperCase()) ?? 0) > 1
    ? `${symbol} (${meta.name})`
    : symbol;
}
