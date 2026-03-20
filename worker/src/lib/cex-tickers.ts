/**
 * Direct CEX ticker clients for Binance, Kraken, Bitstamp, and Coinbase.
 * All use free, unauthenticated public APIs.
 */

import { USER_AGENT } from "./constants";

async function cancelFailedResponseBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Best-effort: failed bodies still must not block the caller path.
  }
}

/**
 * Explicit mapping from Binance pair symbol to the stablecoin ticker.
 * This avoids broken string-replacement logic (e.g., "USDTUSD".replace("USD","") → "TUSD").
 */
// Only USDT and USDC have active USD pairs on Binance (verified 2026-03-14).
// DAI, TUSD, USDP, PYUSD, USDE, XAUT, PAXG, FDUSD USD pairs were all delisted.
const BINANCE_PAIR_TO_SYMBOL: Record<string, string> = {
  USDTUSD: "USDT",
  USDCUSD: "USDC",
};

/**
 * Explicit list of stablecoin symbols with confirmed active Coinbase Exchange
 * USD trading pairs. Verified 2026-03-14 against /products endpoint.
 *
 * NOTE: USDC has NO Coinbase Exchange USD pair — Coinbase treats USDC as
 * equivalent to USD (1:1 convertible), so no USDC-USD product exists.
 *
 * NOTE: Coinbase lists PAX-USD (Pax Dollar) but our tracked stablecoin uses
 * symbol "USDP" (rebranded), so "PAX" never matches in the symbol filter.
 */
export const COINBASE_KNOWN_SYMBOLS: readonly string[] = [
  "USDT", "DAI", "PAXG", "USDS", "USD1", "HONEY",
] as const;

/**
 * Kraken request-pair mapping. Keep request pair and returned result key
 * explicit because Kraken aliases some USD markets (notably USDT/USD).
 */
const KRAKEN_REQUEST_PAIR_TO_SYMBOL: Record<string, string> = {
  DAIUSD: "DAI",
  EURCUSD: "EURC",
  PAXGUSD: "PAXG",
  PYUSDUSD: "PYUSD",
  USD1USD: "USD1",
  USDCUSD: "USDC",
  USDSUSD: "USDS",
  USDTUSD: "USDT",
};

const KRAKEN_RESPONSE_KEY_TO_SYMBOL: Record<string, string> = {
  DAIUSD: "DAI",
  EURCUSD: "EURC",
  PAXGUSD: "PAXG",
  PYUSDUSD: "PYUSD",
  USD1USD: "USD1",
  USDCUSD: "USDC",
  USDSUSD: "USDS",
  USDTUSD: "USDT",
  USDTZUSD: "USDT",
};

export const KRAKEN_KNOWN_SYMBOLS: readonly string[] = [
  "USDT", "USDC", "DAI", "EURC", "PAXG", "PYUSD", "USD1", "USDS",
] as const;

const BITSTAMP_PAIR_TO_SYMBOL: Record<string, string> = {
  "DAI/USD": "DAI",
  "PYUSD/USD": "PYUSD",
  "USDC/USD": "USDC",
  "USDT/USD": "USDT",
};

export const BITSTAMP_KNOWN_SYMBOLS: readonly string[] = [
  "DAI", "PYUSD", "USDC", "USDT",
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
      { signal, headers: { Accept: "application/json", "User-Agent": USER_AGENT } },
    );
    if (!res.ok) {
      await cancelFailedResponseBody(res);
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
 * Fetch requested Kraken USD pairs in a single call.
 * Returns Map<symbol, price> for tracked markets only.
 */
export async function fetchKrakenPrices(
  symbols: string[],
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  const requested = Object.entries(KRAKEN_REQUEST_PAIR_TO_SYMBOL)
    .filter(([, symbol]) => symbols.includes(symbol))
    .map(([pair]) => pair);
  if (requested.length === 0) return results;

  try {
    const res = await fetch(
      `https://api.kraken.com/0/public/Ticker?pair=${requested.join(",")}`,
      { signal, headers: { Accept: "application/json", "User-Agent": USER_AGENT } },
    );
    if (!res.ok) {
      await cancelFailedResponseBody(res);
      console.warn(`[cex-kraken] API returned ${res.status}`);
      return results;
    }
    const data = (await res.json()) as {
      error?: string[];
      result?: Record<string, { c?: string[] }>;
    };
    if (Array.isArray(data.error) && data.error.length > 0) {
      console.warn(`[cex-kraken] API error: ${data.error.join(", ")}`);
      return results;
    }
    for (const [pair, payload] of Object.entries(data.result ?? {})) {
      const symbol = KRAKEN_RESPONSE_KEY_TO_SYMBOL[pair];
      const lastTrade = payload.c?.[0];
      if (!symbol || !lastTrade) continue;
      const price = parseFloat(lastTrade);
      if (price > 0) results.set(symbol, price);
    }
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[cex-kraken] Fetch failed:", err);
  }

  return results;
}

/**
 * Fetch all Bitstamp tickers in a single call.
 * Returns Map<symbol, price> for tracked stablecoin/USD pairs only.
 */
export async function fetchBitstampPrices(
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  try {
    const res = await fetch(
      "https://www.bitstamp.net/api/v2/ticker/",
      { signal, headers: { Accept: "application/json", "User-Agent": USER_AGENT } },
    );
    if (!res.ok) {
      await cancelFailedResponseBody(res);
      console.warn(`[cex-bitstamp] API returned ${res.status}`);
      return results;
    }
    const tickers = (await res.json()) as Array<{ pair?: string; market?: string; last?: string }>;
    for (const ticker of tickers) {
      const pair = ticker.pair ?? ticker.market;
      const symbol = pair ? BITSTAMP_PAIR_TO_SYMBOL[pair] : undefined;
      if (!symbol || !ticker.last) continue;
      const price = parseFloat(ticker.last);
      if (price > 0) results.set(symbol, price);
    }
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[cex-bitstamp] Fetch failed:", err);
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
        { signal, headers: { Accept: "application/json", "User-Agent": USER_AGENT } },
      );
      if (!res.ok) {
        await cancelFailedResponseBody(res);
        console.warn(`[cex-coinbase] ${symbol}-USD returned ${res.status}`);
        continue;
      }
      const data = (await res.json()) as { price?: string };
      if (data.price) {
        const price = parseFloat(data.price);
        if (price > 0) results.set(symbol, price);
      }
    } catch (err) {
      if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
      console.warn(`[cex-coinbase] ${symbol}-USD fetch failed:`, err);
    }
  }

  return results;
}
