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
import { sleepWithSignal, throwIfAborted } from "./abort";
import {
  endpointLabel,
  errorClassFor,
  errorMessageFor,
  readResponseSnippet,
  type PricingProviderAttemptDiagnostic,
} from "./pricing-provider-diagnostics";
import type { FetcherOutcome } from "./fetcher-result";

const CEX_REQUEST_TIMEOUT_MS = 10_000;
const CEX_REQUEST_RETRIES = 1;
const BINANCE_TICKER_URLS = [
  "https://data-api.binance.vision/api/v3/ticker/price",
  "https://api.binance.com/api/v3/ticker/price",
] as const;

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

export function isBinanceProviderBlocked(diagnostics: readonly PricingProviderAttemptDiagnostic[]): boolean {
  return diagnostics.length > 0 && diagnostics.every((diagnostic) => diagnostic.status === 403 || diagnostic.status === 451);
}

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

function getCexRetryDelayMs(response: Response, attempt: number): number | null {
  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    const waitSec = retryAfter ? parseInt(retryAfter, 10) : 0;
    return waitSec > 0 && waitSec <= 120 ? waitSec * 1000 : 5000;
  }
  if (response.status === 529) {
    return Math.min(30_000, 5_000 * 2 ** attempt);
  }
  if (response.status >= 500) {
    return 1000 * 2 ** attempt;
  }
  return null;
}

async function fetchBinanceTickerUrl(
  url: string,
  signal?: AbortSignal,
): Promise<{ prices: Map<string, number>; diagnostic: PricingProviderAttemptDiagnostic }> {
  const results = new Map<string, number>();
  const endpoint = endpointLabel(url);
  let diagnostic: PricingProviderAttemptDiagnostic = {
    source: "binance",
    stage: "primary",
    endpoint,
    status: null,
    ok: false,
    success: false,
  };

  for (let attempt = 0; attempt <= CEX_REQUEST_RETRIES; attempt++) {
    throwIfAborted(signal);
    try {
      const perRequestTimeout = AbortSignal.timeout(CEX_REQUEST_TIMEOUT_MS);
      const combinedSignal = signal
        ? AbortSignal.any([signal, perRequestTimeout])
        : perRequestTimeout;
      const response = await fetch(url, {
        signal: combinedSignal,
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      });

      diagnostic = {
        source: "binance",
        stage: "primary",
        endpoint,
        status: response.status,
        ok: response.ok,
        success: false,
      };

      if (!response.ok) {
        diagnostic.snippet = await readResponseSnippet(response);
        const retryDelayMs = attempt < CEX_REQUEST_RETRIES ? getCexRetryDelayMs(response, attempt) : null;
        if (retryDelayMs != null) {
          await sleepWithSignal(retryDelayMs, signal);
          continue;
        }
        return { prices: results, diagnostic };
      }

      const payload = await response.json() as unknown;
      if (!Array.isArray(payload)) {
        diagnostic.errorClass = "invalid-shape";
        diagnostic.errorMessage = "Expected Binance ticker response to be an array";
        return { prices: results, diagnostic };
      }

      diagnostic.responseRowCount = payload.length;
      for (const ticker of payload as Array<{ symbol?: string; price?: string }>) {
        const symbol = ticker.symbol ? BINANCE_PAIR_TO_SYMBOL.get(ticker.symbol) : undefined;
        const price = parsePositiveNumber(ticker.price);
        if (symbol && price != null) {
          results.set(symbol, price);
        }
      }

      diagnostic.matchedCount = results.size;
      diagnostic.success = results.size > 0;
      return { prices: results, diagnostic };
    } catch (err) {
      if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
      diagnostic = {
        source: "binance",
        stage: "primary",
        endpoint,
        status: null,
        ok: false,
        success: false,
        errorClass: errorClassFor(err),
        errorMessage: errorMessageFor(err),
      };
      console.warn("[cex-binance] Fetch failed:", err);
      if (attempt < CEX_REQUEST_RETRIES) {
        await sleepWithSignal(1000 * 2 ** attempt, signal);
      }
    }
  }

  return { prices: results, diagnostic };
}

export async function fetchBinancePricesDetailed(
  signal?: AbortSignal,
): Promise<FetcherOutcome<{ prices: Map<string, number>; diagnostics: PricingProviderAttemptDiagnostic[] }>> {
  const diagnostics: PricingProviderAttemptDiagnostic[] = [];
  for (const url of BINANCE_TICKER_URLS) {
    const { prices, diagnostic } = await fetchBinanceTickerUrl(url, signal);
    diagnostics.push(diagnostic);
    if (prices.size > 0) {
      return { kind: "ok", value: { prices, diagnostics } };
    }
  }
  const emptyPrices = new Map<string, number>();
  if (isBinanceProviderBlocked(diagnostics)) {
    return { kind: "blocked", value: { prices: emptyPrices, diagnostics } };
  }
  const allOkTransport = diagnostics.every((d) => d.ok === true);
  if (allOkTransport && diagnostics.length > 0) {
    return { kind: "no-data", value: { prices: emptyPrices, diagnostics } };
  }
  const firstError = diagnostics.find((d) => d.errorMessage) ?? diagnostics.find((d) => !d.ok);
  const reason = firstError?.errorMessage ?? (firstError?.status != null ? `HTTP ${firstError.status}` : "all Binance hosts failed");
  return { kind: "upstream-error", value: { prices: emptyPrices, diagnostics }, reason };
}

export async function fetchBinancePrices(
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  return (await fetchBinancePricesDetailed(signal)).value.prices;
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
