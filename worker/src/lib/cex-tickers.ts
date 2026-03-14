/**
 * Direct CEX ticker clients for Binance and Coinbase.
 * Both use free, unauthenticated public APIs.
 */

/**
 * Explicit mapping from Binance pair symbol to the stablecoin ticker.
 * This avoids broken string-replacement logic (e.g., "USDTUSD".replace("USD","") → "TUSD").
 */
const BINANCE_PAIR_TO_SYMBOL: Record<string, string> = {
  USDTUSD: "USDT", USDCUSD: "USDC", DAIUSD: "DAI",
  TUSDUSD: "TUSD", USDPUSD: "USDP", PYUSDUSD: "PYUSD",
  USDEUSD: "USDE", XAUTUSD: "XAUT", PAXGUSD: "PAXG",
  FDUSDUSD: "FDUSD",
};

/**
 * Explicit list of stablecoin symbols with confirmed active Coinbase Exchange
 * USD trading pairs. Verified 2026-03-14 against /products endpoint.
 *
 * NOTE: USDC has NO Coinbase Exchange USD pair — Coinbase treats USDC as
 * equivalent to USD (1:1 convertible), so no USDC-USD product exists.
 */
export const COINBASE_KNOWN_SYMBOLS: readonly string[] = [
  "USDT", "DAI", "PAX", "PAXG", "USDS", "USD1",
] as const;

/**
 * Fetch all ticker prices from Binance in a single call.
 * Returns Map<symbol, price> for stablecoin/USD pairs only.
 * API weight: 4 (trivial against 6,000/min budget).
 */
export async function fetchBinancePrices(
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  try {
    const res = await fetch(
      "https://data-api.binance.vision/api/v3/ticker/price",
      { signal, headers: { Accept: "application/json" } },
    );
    if (!res.ok) {
      console.warn(`[cex-binance] API returned ${res.status}`);
      return results;
    }
    const tickers = (await res.json()) as Array<{ symbol: string; price: string }>;
    for (const t of tickers) {
      const symbol = BINANCE_PAIR_TO_SYMBOL[t.symbol];
      if (symbol) {
        const price = parseFloat(t.price);
        if (price > 0) results.set(symbol, price);
      }
    }
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[cex-binance] Fetch failed:", err);
  }
  return results;
}

/**
 * Fetch individual ticker prices from Coinbase.
 * No auth required. 10 req/sec rate limit.
 *
 * IMPORTANT: Fetches sequentially to avoid exceeding the Workers 6-connection
 * limit. This runs inside fetchPrimaryPrices() which shares the pool with
 * CG, DL, Pyth, RedStone, and Binance fetches.
 *
 * @param symbols Array of symbols to fetch (e.g., ["USDT", "USDC", "DAI"])
 */
export async function fetchCoinbasePrices(
  symbols: string[],
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const results = new Map<string, number>();

  for (const symbol of symbols) {
    try {
      const res = await fetch(
        `https://api.exchange.coinbase.com/products/${symbol}-USD/ticker`,
        { signal, headers: { Accept: "application/json" } },
      );
      if (!res.ok) continue;
      const data = (await res.json()) as { price?: string };
      if (data.price) {
        const price = parseFloat(data.price);
        if (price > 0) results.set(symbol, price);
      }
    } catch {
      // Individual pair failure — non-fatal
    }
  }

  return results;
}
