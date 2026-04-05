/**
 * Direct CEX ticker clients for Binance, Kraken, Bitstamp, and Coinbase.
 * All use free, unauthenticated public APIs.
 */

import {
  BINANCE_MARKETS,
  BITSTAMP_MARKETS,
  CEX_PROVIDER_AUDIT_CONFIG,
  COINBASE_PRODUCTS,
  KRAKEN_MARKETS,
} from "@shared/lib/pricing-provider-config";
import { USER_AGENT } from "./constants";
import { fetchWithRetry } from "./fetch-retry";
import { cancelResponseBodyQuietly } from "./response-body";

const CEX_REQUEST_TIMEOUT_MS = 10_000;
const CEX_REQUEST_RETRIES = 1;

const BINANCE_PAIR_TO_SYMBOL = new Map<string, string>(BINANCE_MARKETS.map((market) => [market.pair, market.symbol]));
const KRAKEN_RESPONSE_KEY_TO_SYMBOL = new Map<string, string>(
  KRAKEN_MARKETS.flatMap((market) => market.responseKeys.map((key) => [key, market.symbol] as const)),
);
const BITSTAMP_PAIR_TO_SYMBOL = new Map<string, string>(BITSTAMP_MARKETS.map((market) => [market.pair, market.symbol]));
const COINBASE_PRODUCT_TO_SYMBOL = new Map<string, string>(COINBASE_PRODUCTS.map((product) => [product.productId, product.symbol]));

export const BINANCE_KNOWN_SYMBOLS: readonly string[] = [...new Set(BINANCE_MARKETS.map((market) => market.symbol))].sort();
export const KRAKEN_KNOWN_SYMBOLS: readonly string[] = [...new Set(KRAKEN_MARKETS.map((market) => market.symbol))].sort();
export const BITSTAMP_KNOWN_SYMBOLS: readonly string[] = [...new Set(BITSTAMP_MARKETS.map((market) => market.symbol))].sort();
export const COINBASE_KNOWN_SYMBOLS: readonly string[] = [...new Set(COINBASE_PRODUCTS.map((product) => product.symbol))].sort();

function parsePositiveNumber(value: string | number | null | undefined): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? parseFloat(value) : Number.NaN;
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function midpointFromBidAsk(
  bid: string | number | null | undefined,
  ask: string | number | null | undefined,
): number | null {
  const parsedBid = parsePositiveNumber(bid);
  const parsedAsk = parsePositiveNumber(ask);
  if (parsedBid == null || parsedAsk == null) {
    return null;
  }
  return (parsedBid + parsedAsk) / 2;
}

function applyTickerRows<T>(
  rows: Iterable<T>,
  results: Map<string, number>,
  resolveSymbol: (row: T) => string | undefined,
  getBid: (row: T) => string | number | null | undefined,
  getAsk: (row: T) => string | number | null | undefined,
  getLastTrade: (row: T) => string | number | null | undefined,
): void {
  for (const row of rows) {
    const symbol = resolveSymbol(row);
    if (!symbol) continue;

    const midpoint = midpointFromBidAsk(getBid(row), getAsk(row));
    const lastTrade = parsePositiveNumber(getLastTrade(row));
    const price = midpoint ?? lastTrade;
    if (price != null) {
      results.set(symbol, price);
    }
  }
}

async function fetchCexJson<T>(
  url: string,
  signal?: AbortSignal,
): Promise<T | null> {
  const response = await fetchWithRetry(
    url,
    {
      signal,
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    },
    CEX_REQUEST_RETRIES,
    { timeoutMs: CEX_REQUEST_TIMEOUT_MS },
  );
  if (!response?.ok) {
    await cancelResponseBodyQuietly(response);
    return null;
  }
  return response.json() as Promise<T>;
}

export async function fetchBinancePrices(
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const results = new Map<string, number>();

  try {
    const tickers = await fetchCexJson<Array<{ symbol?: string; price?: string }>>(
      "https://data-api.binance.vision/api/v3/ticker/price",
      signal,
    );
    if (!tickers) return results;

    for (const ticker of tickers) {
      const symbol = ticker.symbol ? BINANCE_PAIR_TO_SYMBOL.get(ticker.symbol) : undefined;
      const price = parsePositiveNumber(ticker.price);
      if (symbol && price != null) {
        results.set(symbol, price);
      }
    }
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[cex-binance] Fetch failed:", err);
  }

  return results;
}

export async function fetchKrakenPrices(
  symbols: string[],
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  const requestedPairs = KRAKEN_MARKETS
    .filter((market) => symbols.includes(market.symbol))
    .map((market) => market.requestPair);
  if (requestedPairs.length === 0) return results;

  try {
    const payload = await fetchCexJson<{
      error?: string[];
      result?: Record<string, { a?: string[]; b?: string[]; c?: string[] }>;
    }>(
      `https://api.kraken.com/0/public/Ticker?pair=${requestedPairs.join(",")}`,
      signal,
    );
    if (!payload) return results;
    if (Array.isArray(payload.error) && payload.error.length > 0) {
      console.warn(`[cex-kraken] API error: ${payload.error.join(", ")}`);
      return results;
    }

    applyTickerRows(
      Object.entries(payload.result ?? {}),
      results,
      ([responseKey]) => KRAKEN_RESPONSE_KEY_TO_SYMBOL.get(responseKey),
      ([, market]) => market.b?.[0],
      ([, market]) => market.a?.[0],
      ([, market]) => market.c?.[0],
    );
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[cex-kraken] Fetch failed:", err);
  }

  return results;
}

export async function fetchBitstampPrices(
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const results = new Map<string, number>();

  try {
    const tickers = await fetchCexJson<Array<{
      pair?: string;
      market?: string;
      bid?: string;
      ask?: string;
      last?: string;
    }>>(
      "https://www.bitstamp.net/api/v2/ticker/",
      signal,
    );
    if (!tickers) return results;

    applyTickerRows(
      tickers,
      results,
      (ticker) => {
        const pair = ticker.pair ?? ticker.market;
        return pair ? BITSTAMP_PAIR_TO_SYMBOL.get(pair) : undefined;
      },
      (ticker) => ticker.bid,
      (ticker) => ticker.ask,
      (ticker) => ticker.last,
    );
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[cex-bitstamp] Fetch failed:", err);
  }

  return results;
}

export async function fetchCoinbasePrices(
  symbols: string[],
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  const requestedProducts = COINBASE_PRODUCTS.filter((product) => symbols.includes(product.symbol));

  for (const product of requestedProducts) {
    try {
      const response = await fetchWithRetry(
        `${CEX_PROVIDER_AUDIT_CONFIG.coinbase.metadataUrl}/${product.productId}/ticker`,
        {
          signal,
          headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        },
        CEX_REQUEST_RETRIES,
        { timeoutMs: CEX_REQUEST_TIMEOUT_MS },
      );
      if (!response?.ok) {
        await cancelResponseBodyQuietly(response);
        continue;
      }

      const payload = await response.json() as { bid?: string; ask?: string; price?: string };
      const midpoint = midpointFromBidAsk(payload.bid, payload.ask);
      const lastTrade = parsePositiveNumber(payload.price);
      const price = midpoint ?? lastTrade;
      if (price != null) {
        results.set(COINBASE_PRODUCT_TO_SYMBOL.get(product.productId) ?? product.symbol, price);
      }
    } catch (err) {
      if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
      console.warn(`[cex-coinbase] ${product.productId} fetch failed:`, err);
    }
  }

  return results;
}
