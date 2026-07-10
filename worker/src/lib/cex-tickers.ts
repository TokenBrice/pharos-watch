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
import { fetchJsonWithRetry } from "./fetch-retry";
import { sleepWithSignal, throwIfAborted } from "./abort";
import { mapWithConcurrency } from "./concurrency";
import {
  endpointLabel,
  errorClassFor,
  errorMessageFor,
  readResponseSnippet,
  type PricingProviderAttemptDiagnostic,
} from "./pricing-provider-diagnostics";
import type { FetcherOutcome } from "./fetcher-result";
import {
  readProviderAvailability,
  recordProviderEnvironmentAvailable,
  recordProviderEnvironmentBlocked,
} from "./pricing-provider-runtime-state";

const CEX_REQUEST_TIMEOUT_MS = 10_000;
const CEX_REQUEST_RETRIES = 1;
const COINBASE_PRODUCT_FETCH_CONCURRENCY = 1;
const BINANCE_TICKER_URLS = [
  "https://data-api.binance.vision/api/v3/ticker/price",
  "https://api.binance.com/api/v3/ticker/price",
] as const;

export interface BinancePriceBatch {
  prices: Map<string, number>;
  diagnostics: PricingProviderAttemptDiagnostic[];
}

export type BinancePriceOutcome = FetcherOutcome<BinancePriceBatch>;

export interface BinanceFetchSession {
  outcome?: Promise<BinancePriceOutcome>;
}

export function createBinanceFetchSession(): BinanceFetchSession {
  return {};
}
function isAsciiDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isDecimalPriceLiteral(value: string): boolean {
  let index = 0;
  let hasMantissaDigit = false;

  while (index < value.length && isAsciiDigit(value[index])) {
    hasMantissaDigit = true;
    index++;
  }

  if (value[index] === ".") {
    index++;
    while (index < value.length && isAsciiDigit(value[index])) {
      hasMantissaDigit = true;
      index++;
    }
  }

  if (!hasMantissaDigit) return false;
  if (index === value.length) return true;
  if (value[index] !== "e" && value[index] !== "E") return false;

  index++;
  if (value[index] === "+" || value[index] === "-") index++;

  let hasExponentDigit = false;
  while (index < value.length && isAsciiDigit(value[index])) {
    hasExponentDigit = true;
    index++;
  }

  return hasExponentDigit && index === value.length;
}

function parseCexPrice(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!isDecimalPriceLiteral(trimmed)) return null;

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

const BINANCE_PAIR_TO_MARKET = new Map<string, (typeof BINANCE_MARKETS)[number]>(
  BINANCE_MARKETS.map((market) => [market.pair, market]),
);
const KRAKEN_RESPONSE_KEY_TO_SYMBOL = new Map<string, string>(
  KRAKEN_MARKETS.flatMap((market) => market.responseKeys.map((key) => [key, market.symbol] as const)),
);
const BITSTAMP_PAIR_TO_SYMBOL = new Map<string, string>(BITSTAMP_MARKETS.map((market) => [market.pair, market.symbol]));
const COINBASE_PRODUCT_TO_SYMBOL = new Map<string, string>(
  COINBASE_PRODUCTS.map((product) => [product.productId, product.symbol]),
);

export const BINANCE_KNOWN_SYMBOLS: readonly string[] = [
  ...new Set(BINANCE_MARKETS.map((market) => market.symbol)),
].sort();
export const KRAKEN_KNOWN_SYMBOLS: readonly string[] = [
  ...new Set(KRAKEN_MARKETS.map((market) => market.symbol)),
].sort();
export const BITSTAMP_KNOWN_SYMBOLS: readonly string[] = [
  ...new Set(BITSTAMP_MARKETS.map((market) => market.symbol)),
].sort();
export const COINBASE_KNOWN_SYMBOLS: readonly string[] = [
  ...new Set(COINBASE_PRODUCTS.map((product) => product.symbol)),
].sort();

function isBinanceProviderBlocked(diagnostics: readonly PricingProviderAttemptDiagnostic[]): boolean {
  return (
    diagnostics.length > 0 && diagnostics.every((diagnostic) => diagnostic.status === 403 || diagnostic.status === 451)
  );
}

function midpointFromBidAsk(
  bid: string | number | null | undefined,
  ask: string | number | null | undefined,
): number | null {
  const parsedBid = parseCexPrice(bid);
  const parsedAsk = parseCexPrice(ask);
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
  observedAtBySymbol?: Map<string, number>,
  getObservedAt?: (row: T) => number | null,
): void {
  for (const row of rows) {
    const symbol = resolveSymbol(row);
    if (!symbol) continue;

    const midpoint = midpointFromBidAsk(getBid(row), getAsk(row));
    const lastTrade = parseCexPrice(getLastTrade(row));
    const price = midpoint ?? lastTrade;
    if (price != null) {
      results.set(symbol, price);
      if (observedAtBySymbol && getObservedAt) {
        const observedAt = getObservedAt(row);
        if (observedAt != null) {
          observedAtBySymbol.set(symbol, observedAt);
        }
      }
    }
  }
}

function parseBitstampTimestamp(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const numeric = typeof value === "number" ? value : parseInt(String(value), 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function parseCoinbaseTime(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const sec = Math.floor(ms / 1000);
  return sec > 0 ? sec : null;
}

async function fetchCexJson<T>(
  url: string,
  signal?: AbortSignal,
): Promise<{ payload: T | null; transportOk: boolean }> {
  const result = await fetchJsonWithRetry<T>(
    url,
    {
      signal,
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    },
    CEX_REQUEST_RETRIES,
    { timeoutMs: CEX_REQUEST_TIMEOUT_MS },
  );
  if (!result?.response.ok) {
    return { payload: null, transportOk: false };
  }
  return { payload: result.body, transportOk: true };
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

  // On HTTP 5xx/429/403/451 we do NOT retry the same host — we return so the
  // caller can jump to the next URL in the Binance cascade. Same-host retry is
  // reserved for catchable network errors (fetch() throws).
  for (let attempt = 0; attempt <= CEX_REQUEST_RETRIES; attempt++) {
    throwIfAborted(signal);
    try {
      const perRequestTimeout = AbortSignal.timeout(CEX_REQUEST_TIMEOUT_MS);
      const combinedSignal = signal ? AbortSignal.any([signal, perRequestTimeout]) : perRequestTimeout;
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
        return { prices: results, diagnostic };
      }

      const payload = (await response.json()) as unknown;
      if (!Array.isArray(payload)) {
        diagnostic.errorClass = "invalid-shape";
        diagnostic.errorMessage = "Expected Binance ticker response to be an array";
        return { prices: results, diagnostic };
      }

      diagnostic.responseRowCount = payload.length;
      const pendingStableQuoted: Array<{ symbol: string; quoteSymbol: string; quotePrice: number }> = [];
      for (const ticker of payload as Array<{ symbol?: string; price?: string }>) {
        const market = ticker.symbol ? BINANCE_PAIR_TO_MARKET.get(ticker.symbol) : undefined;
        const price = parseCexPrice(ticker.price);
        if (!market || price == null) continue;

        if ("quoteSymbol" in market) {
          pendingStableQuoted.push({
            symbol: market.symbol,
            quoteSymbol: market.quoteSymbol,
            quotePrice: price,
          });
        } else {
          results.set(market.symbol, price);
        }
      }

      for (const market of pendingStableQuoted) {
        const quoteUsd = results.get(market.quoteSymbol);
        if (quoteUsd == null) continue;

        const convertedPrice = market.quotePrice * quoteUsd;
        const existingPrice = results.get(market.symbol);
        results.set(market.symbol, existingPrice == null ? convertedPrice : (existingPrice + convertedPrice) / 2);
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
  options?: { hostLimit?: number },
): Promise<BinancePriceOutcome> {
  const diagnostics: PricingProviderAttemptDiagnostic[] = [];
  const urls = options?.hostLimit == null
    ? BINANCE_TICKER_URLS
    : BINANCE_TICKER_URLS.slice(0, Math.max(1, options.hostLimit));
  for (const url of urls) {
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
  const reason =
    firstError?.errorMessage ?? (firstError?.status != null ? `HTTP ${firstError.status}` : "all Binance hosts failed");
  return { kind: "upstream-error", value: { prices: emptyPrices, diagnostics }, reason };
}

function suppressedBinanceOutcome(decision: {
  blockedStatus: number | null;
  nextProbeAt: number | null;
}): BinancePriceOutcome {
  return {
    kind: "blocked",
    value: {
      prices: new Map(),
      diagnostics: [{
        source: "binance",
        stage: "health-probe",
        endpoint: "binance:environment-ttl",
        status: decision.blockedStatus,
        ok: false,
        success: false,
        errorClass: "environment-blocked",
        errorMessage: decision.nextProbeAt == null
          ? "Binance unavailable from this runtime environment"
          : `Binance environment probe deferred until ${decision.nextProbeAt}`,
        rejectionReasonCounts: { blocked: 1 },
      }],
    },
  };
}

/**
 * Invocation-scoped Binance access. A shared session prevents the primary
 * consensus and pending-depeg follow-through from issuing the same request
 * twice, while durable environment state suppresses predictable 403/451
 * responses until the next bounded probe.
 */
export function fetchBinancePricesForRun(
  db: D1Database,
  session: BinanceFetchSession,
  signal?: AbortSignal,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<BinancePriceOutcome> {
  if (session.outcome) return session.outcome;

  session.outcome = (async () => {
    const decision = await readProviderAvailability(db, "binance", nowSec);
    if (!decision.shouldFetch) return suppressedBinanceOutcome(decision);

    const outcome = await fetchBinancePricesDetailed(signal, decision.probeOnly ? { hostLimit: 1 } : undefined);
    const blockedStatus = outcome.kind === "blocked"
      ? outcome.value.diagnostics.find((diagnostic) => diagnostic.status === 403 || diagnostic.status === 451)?.status
      : null;
    if (blockedStatus === 403 || blockedStatus === 451) {
      await recordProviderEnvironmentBlocked(db, "binance", blockedStatus, nowSec);
    } else if (outcome.kind === "ok" || outcome.kind === "no-data") {
      await recordProviderEnvironmentAvailable(db, "binance", nowSec);
    }
    return outcome;
  })();

  return session.outcome;
}

export async function fetchKrakenPrices(
  symbols: string[],
  signal?: AbortSignal,
): Promise<FetcherOutcome<Map<string, number>>> {
  const results = new Map<string, number>();
  const requestedPairs = KRAKEN_MARKETS.filter((market) => symbols.includes(market.symbol)).map(
    (market) => market.requestPair,
  );
  if (requestedPairs.length === 0) return { kind: "no-data", value: results };

  try {
    const { payload, transportOk } = await fetchCexJson<{
      error?: string[];
      result?: Record<string, { a?: string[]; b?: string[]; c?: string[] }>;
    }>(`https://api.kraken.com/0/public/Ticker?pair=${requestedPairs.join(",")}`, signal);
    if (!transportOk || !payload) {
      return { kind: "upstream-error", value: results, reason: "Kraken ticker HTTP error" };
    }
    if (Array.isArray(payload.error) && payload.error.length > 0) {
      console.warn(`[cex-kraken] API error: ${payload.error.join(", ")}`);
      return { kind: "no-data", value: results };
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
    return { kind: "upstream-error", value: results, reason: errorMessageFor(err) };
  }

  return results.size > 0 ? { kind: "ok", value: results } : { kind: "no-data", value: results };
}

export interface CexTickerBatch {
  prices: Map<string, number>;
  observedAtBySymbol: Map<string, number>;
}

export async function fetchBitstampPrices(signal?: AbortSignal): Promise<FetcherOutcome<CexTickerBatch>> {
  const prices = new Map<string, number>();
  const observedAtBySymbol = new Map<string, number>();
  const value: CexTickerBatch = { prices, observedAtBySymbol };

  try {
    const { payload: tickers, transportOk } = await fetchCexJson<
      Array<{
        pair?: string;
        market?: string;
        bid?: string;
        ask?: string;
        last?: string;
        timestamp?: string | number;
      }>
    >("https://www.bitstamp.net/api/v2/ticker/", signal);
    if (!transportOk || !tickers) {
      return { kind: "upstream-error", value, reason: "Bitstamp ticker HTTP error" };
    }

    applyTickerRows(
      tickers,
      prices,
      (ticker) => {
        const pair = ticker.pair ?? ticker.market;
        return pair ? BITSTAMP_PAIR_TO_SYMBOL.get(pair) : undefined;
      },
      (ticker) => ticker.bid,
      (ticker) => ticker.ask,
      (ticker) => ticker.last,
      observedAtBySymbol,
      (ticker) => parseBitstampTimestamp(ticker.timestamp),
    );
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[cex-bitstamp] Fetch failed:", err);
    return { kind: "upstream-error", value, reason: errorMessageFor(err) };
  }

  return prices.size > 0 ? { kind: "ok", value } : { kind: "no-data", value };
}

export async function fetchCoinbasePrices(
  symbols: string[],
  signal?: AbortSignal,
): Promise<FetcherOutcome<CexTickerBatch>> {
  const prices = new Map<string, number>();
  const observedAtBySymbol = new Map<string, number>();
  const value: CexTickerBatch = { prices, observedAtBySymbol };
  const requestedProducts = COINBASE_PRODUCTS.filter((product) => symbols.includes(product.symbol));
  let transportFailures = 0;
  let transportAttempts = 0;

  await mapWithConcurrency(
    requestedProducts,
    COINBASE_PRODUCT_FETCH_CONCURRENCY,
    async (product) => {
      transportAttempts++;
      try {
        const result = await fetchJsonWithRetry<{ bid?: string; ask?: string; price?: string; time?: string }>(
          `${CEX_PROVIDER_AUDIT_CONFIG.coinbase.metadataUrl}/${product.productId}/ticker`,
          {
            signal,
            headers: { Accept: "application/json", "User-Agent": USER_AGENT },
          },
          CEX_REQUEST_RETRIES,
          { timeoutMs: CEX_REQUEST_TIMEOUT_MS },
        );
        if (!result?.response.ok) {
          transportFailures++;
          return;
        }

        const payload = result.body;
        const midpoint = midpointFromBidAsk(payload.bid, payload.ask);
        const lastTrade = parseCexPrice(payload.price);
        const price = midpoint ?? lastTrade;
        if (price != null) {
          const symbol = COINBASE_PRODUCT_TO_SYMBOL.get(product.productId) ?? product.symbol;
          prices.set(symbol, price);
          const observedAt = parseCoinbaseTime(payload.time);
          if (observedAt != null) {
            observedAtBySymbol.set(symbol, observedAt);
          }
        }
      } catch (err) {
        if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
        console.warn(`[cex-coinbase] ${product.productId} fetch failed:`, err);
        transportFailures++;
      }
    },
  );

  if (transportAttempts > 0 && transportFailures === transportAttempts) {
    return { kind: "upstream-error", value, reason: "all Coinbase product requests failed" };
  }
  if (prices.size === 0) {
    return { kind: "no-data", value };
  }
  return { kind: "ok", value };
}
