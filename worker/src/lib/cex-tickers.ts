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
import { isUnsignedDecimalLiteral } from "@shared/lib/decimal-literal";
import { CEX_MAX_BID_ASK_SPREAD_BPS, CEX_UPSTREAM_MAX_FUTURE_SKEW_SEC } from "@shared/lib/pricing-source-policy";
import { parseRetryAfterSeconds } from "@shared/lib/retry-after";
import { isRecord } from "@shared/lib/type-guards";
import { sleepWithSignal, throwIfAborted } from "./abort";
import { USER_AGENT } from "./constants";
import { fetchJsonWithRetry, fetchTextWithRetry, resolveRateLimitDelayMs } from "./fetch-retry";
import { mapWithConcurrency } from "./concurrency";
import {
  endpointLabel,
  errorClassFor,
  errorMessageFor,
  responseSnippet,
  type PricingProviderAttemptDiagnostic,
  type PricingProviderRejectionReason,
} from "./pricing-provider-diagnostics";
import type { FetcherOutcome } from "./fetcher-result";
import {
  readProviderAvailability,
  recordProviderEnvironmentAvailable,
  recordProviderEnvironmentBlocked,
} from "./pricing-provider-runtime-state";
import { logWorkerEvent } from "./structured-log";
import { validatePricingSourceFreshness } from "./pricing-source-freshness";

const CEX_REQUEST_TIMEOUT_MS = 10_000;
const CEX_REQUEST_RETRIES = 1;
const COINBASE_PRODUCT_FETCH_CONCURRENCY = 1;
// Coinbase public REST enforces 10 req/s per IP (15 burst, lazy-fill token bucket)
// across shared Worker egress; 1000ms serial spacing caps our rate at <= 1 req/s
// (at most one Pharos request per 1s refill window).
const COINBASE_REQUEST_INTERVAL_MS = 1_000;
const COINBASE_RATE_LIMIT_COOLDOWN_MS = 3_000;
const COINBASE_MAX_RETRY_DELAY_MS = 10_000;
const KRAKEN_TICKER_ENDPOINT = "api.kraken.com/0/public/Ticker";
const KRAKEN_DEPTH_ENDPOINT = "api.kraken.com/0/public/Depth";
// Kraken `/0/public/Depth` rejects multi-pair queries and rate-limits by IP;
// 250ms serial spacing caps the configured depth sweep at <= 4 req/s on 1 connection.
const KRAKEN_DEPTH_REQUEST_INTERVAL_MS = 250;
const KRAKEN_DEPTH_RATE_LIMIT_COOLDOWN_MS = 2_000;
const BITSTAMP_TICKER_ENDPOINT = "www.bitstamp.net/api/v2/ticker/";
const COINBASE_TICKER_ENDPOINT = "api.exchange.coinbase.com/products/{product}/ticker";
const COINBASE_BOOK_ENDPOINT = "api.exchange.coinbase.com/products/{product}/book";
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
function parseCexPrice(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!isUnsignedDecimalLiteral(trimmed)) return null;

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
  bid: unknown,
  ask: unknown,
): { midpoint: number; wideSpread: boolean } | null {
  const parsedBid = parseCexPrice(bid);
  const parsedAsk = parseCexPrice(ask);
  if (parsedBid == null || parsedAsk == null) {
    return null;
  }
  const midpoint = (parsedBid + parsedAsk) / 2;
  return {
    midpoint,
    // A crossed book (ask below bid) is as unusable as a wide one.
    wideSpread: parsedAsk < parsedBid || ((parsedAsk - parsedBid) / midpoint) * 10_000 > CEX_MAX_BID_ASK_SPREAD_BPS,
  };
}

function incrementRejectionReason(
  counts: Partial<Record<PricingProviderRejectionReason, number>> | undefined,
  reason: PricingProviderRejectionReason,
): void {
  if (!counts) return;
  counts[reason] = (counts[reason] ?? 0) + 1;
}

interface TickerRowOptions<T> {
  quoteBasisBySymbol?: Map<string, "bid-ask-midpoint" | "last-trade">;
  observedAtBySymbol?: Map<string, number>;
  getObservedAt?: (row: T) => number | null;
  rejectionReasonCounts?: Partial<Record<PricingProviderRejectionReason, number>>;
}

function applyTickerRows<T>(
  rows: Iterable<T>,
  results: Map<string, number>,
  resolveSymbol: (row: T) => string | undefined,
  getBid: (row: T) => string | number | null | undefined,
  getAsk: (row: T) => string | number | null | undefined,
  getLastTrade: (row: T) => string | number | null | undefined,
  options: TickerRowOptions<T> = {},
): void {
  for (const row of rows) {
    const symbol = resolveSymbol(row);
    if (!symbol) continue;

    const quote = midpointFromBidAsk(getBid(row), getAsk(row));
    if (quote?.wideSpread) {
      incrementRejectionReason(options.rejectionReasonCounts, "wide-spread");
      continue;
    }
    const lastTrade = parseCexPrice(getLastTrade(row));
    const price = quote?.midpoint ?? lastTrade;
    if (price != null) {
      results.set(symbol, price);
      options.quoteBasisBySymbol?.set(symbol, quote ? "bid-ask-midpoint" : "last-trade");
      const { observedAtBySymbol, getObservedAt } = options;
      if (observedAtBySymbol && getObservedAt) {
        const observedAt = getObservedAt(row);
        if (observedAt != null) {
          observedAtBySymbol.set(symbol, observedAt);
        }
      }
    }
  }
}

function wideSpreadDiagnostic(
  source: "kraken" | "bitstamp" | "coinbase",
  endpoint: string,
  rejectionCount: number,
  success: boolean,
  status: number | null,
): PricingProviderAttemptDiagnostic {
  return {
    source,
    stage: "primary",
    endpoint,
    status,
    ok: true,
    success,
    rejectionReasonCounts: { "wide-spread": rejectionCount },
  };
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

function createCexRequestPacer(
  intervalMs: number,
  rateLimitCooldownMs: number,
  maxRetryDelayMs: number,
  signal?: AbortSignal,
) {
  let nextRequestAtMs = 0;
  return {
    wait: async () => {
      const waitMs = nextRequestAtMs - Date.now();
      if (waitMs > 0) await sleepWithSignal(waitMs, signal);
      throwIfAborted(signal);
      nextRequestAtMs = Date.now() + intervalMs;
    },
    onResponse: (response: Response) => {
      if (response.status === 429) {
        const cooldownMs = resolveRateLimitDelayMs(response, rateLimitCooldownMs, maxRetryDelayMs);
        nextRequestAtMs = Math.max(nextRequestAtMs, Date.now() + cooldownMs);
      } else if (response.ok) {
        nextRequestAtMs = Date.now() + intervalMs;
      }
    },
  };
}

async function fetchCexJson<T>(
  url: string,
  signal?: AbortSignal,
  options?: {
    onResponse?: (response: Response) => void;
    maxRetryDelayMs?: number;
    retries?: number;
  },
): Promise<{ payload: T | null; transportOk: boolean; status: number | null; retryAfterSec?: number }> {
  let responseStatus: number | null = null;
  let retryAfterSec: number | undefined;
  const result = await fetchJsonWithRetry<T>(
    url,
    {
      signal,
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    },
    options?.retries ?? CEX_REQUEST_RETRIES,
    {
      timeoutMs: CEX_REQUEST_TIMEOUT_MS,
      maxRetryDelayMs: options?.maxRetryDelayMs,
      onResponse: (response) => {
        responseStatus = response.status;
        if (response.status === 429) {
          const parsedRetryAfter = parseRetryAfterSeconds(response.headers?.get?.("Retry-After"), {
            allowNumericPrefix: true,
            numericRounding: "floor",
          });
          retryAfterSec = parsedRetryAfter != null && parsedRetryAfter > 0 ? parsedRetryAfter : undefined;
        } else {
          retryAfterSec = undefined;
        }
        options?.onResponse?.(response);
      },
    },
  );
  if (!result?.response.ok) {
    return {
      payload: null,
      transportOk: false,
      status: result?.response.status ?? responseStatus,
      ...(retryAfterSec != null ? { retryAfterSec } : {}),
    };
  }
  return { payload: result.body, transportOk: true, status: result.response.status };
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

  // On HTTP failures we do not retry the same host; the caller immediately
  // advances through the Binance host cascade. Only thrown transport failures
  // receive the bounded same-host retry policy.
  try {
    const fetched = await fetchTextWithRetry(
      url,
      {
        signal,
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      },
      CEX_REQUEST_RETRIES,
      {
        timeoutMs: CEX_REQUEST_TIMEOUT_MS,
        maxResponseBytes: 4 * 1024 * 1024,
        returnFinalResponse: true,
        retryMode: "network-only",
        throwOnFinalNetworkError: true,
      },
    );
    if (!fetched) return { prices: results, diagnostic };
    const response = fetched.response;

    diagnostic = {
      source: "binance",
      stage: "primary",
      endpoint,
      status: response.status,
      ok: response.ok,
      success: false,
    };

    if (!response.ok) {
      diagnostic.snippet = responseSnippet(fetched.body);
      return { prices: results, diagnostic };
    }

    const payload = JSON.parse(fetched.body) as unknown;
    if (!Array.isArray(payload)) {
      diagnostic.errorClass = "invalid-shape";
      diagnostic.errorMessage = "Expected Binance ticker response to be an array";
      return { prices: results, diagnostic };
    }

    diagnostic.responseRowCount = payload.length;
    for (const ticker of payload as Array<{ symbol?: string; price?: string }>) {
      const market = ticker.symbol ? BINANCE_PAIR_TO_MARKET.get(ticker.symbol) : undefined;
      const price = parseCexPrice(ticker.price);
      if (!market || price == null) continue;

      results.set(market.symbol, price);
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
    logWorkerEvent({ scope: "lib", level: "warn", event: "cex_binance_fetch_failed", message: "Binance ticker fetch failed", provider: "binance", error: err, metadata: { endpoint } });
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

export interface CexTickerBatch {
  prices: Map<string, number>;
  quoteBasisBySymbol?: Map<string, "bid-ask-midpoint" | "last-trade">;
  observedAtBySymbol: Map<string, number>;
  diagnostics: PricingProviderAttemptDiagnostic[];
}

export interface CoinbaseQuoteBatch extends CexTickerBatch {
  quoteAssetBySymbol: Map<string, "USD" | "USDC">;
  clockBySymbol: Map<string, "book" | "trade">;
}

type KrakenDepthValidationResult =
  | { ok: true; price: number; observedAt: number }
  | { ok: false; reason: PricingProviderRejectionReason };

function parseKrakenDepthTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function validateKrakenDepthBook(
  result: unknown,
  responseKeys: readonly string[],
): KrakenDepthValidationResult {
  if (!isRecord(result)) return { ok: false, reason: "invalid-shape" };
  const matchingKey = responseKeys.find((key) => key in result);
  const book = matchingKey ? result[matchingKey] : undefined;
  if (!isRecord(book)) return { ok: false, reason: "missing-quote" };

  const topBid: unknown = Array.isArray(book.bids) ? book.bids[0] : undefined;
  const topAsk: unknown = Array.isArray(book.asks) ? book.asks[0] : undefined;
  if (!Array.isArray(topBid) || !Array.isArray(topAsk)) return { ok: false, reason: "missing-quote" };

  const quote = midpointFromBidAsk(topBid[0], topAsk[0]);
  if (!quote || !Number.isFinite(quote.midpoint)) return { ok: false, reason: "invalid-shape" };
  if (quote.wideSpread) return { ok: false, reason: "wide-spread" };

  const bidTs = parseKrakenDepthTimestamp(topBid[2]);
  const askTs = parseKrakenDepthTimestamp(topAsk[2]);
  if (bidTs == null || askTs == null) return { ok: false, reason: "invalid-shape" };

  const observedAt = Math.min(bidTs, askTs);
  const newestAt = Math.max(bidTs, askTs);
  const nowSec = Math.floor(Date.now() / 1000);
  // Reject future skew on either top-of-book side before judging staleness by the older level.
  const newestFreshness = validatePricingSourceFreshness({
    source: "kraken",
    observedAt: newestAt,
    observedAtMode: "upstream",
    nowSec,
    requireObservedAt: true,
    maxFutureSkewSec: CEX_UPSTREAM_MAX_FUTURE_SKEW_SEC,
  });
  if (!newestFreshness.accepted) {
    return { ok: false, reason: newestFreshness.reason === "stale_observed_at" ? "stale" : "invalid-shape" };
  }
  const freshness = validatePricingSourceFreshness({
    source: "kraken",
    observedAt,
    observedAtMode: "upstream",
    nowSec,
    requireObservedAt: true,
    maxFutureSkewSec: CEX_UPSTREAM_MAX_FUTURE_SKEW_SEC,
  });
  if (!freshness.accepted || freshness.observedAt == null) {
    return {
      ok: false,
      reason: !freshness.accepted && freshness.reason === "stale_observed_at" ? "stale" : "invalid-shape",
    };
  }
  return { ok: true, price: quote.midpoint, observedAt: freshness.observedAt };
}

export async function fetchKrakenPrices(
  symbols: string[],
  signal?: AbortSignal,
): Promise<FetcherOutcome<CexTickerBatch>> {
  const prices = new Map<string, number>();
  const observedAtBySymbol = new Map<string, number>();
  const tickerRejectionReasons: Partial<Record<PricingProviderRejectionReason, number>> = {};
  // The batch Ticker response has no upstream timestamp (last-trade fallback stays
  // undated). Reviewed `clockedDepth` markets read `/0/public/Depth?count=1`
  // exclusively and never fall back to `/0/public/Ticker` or local fetch time.
  const quoteBasisBySymbol = new Map<string, "bid-ask-midpoint" | "last-trade">();
  const value: CexTickerBatch = { prices, quoteBasisBySymbol, observedAtBySymbol, diagnostics: [] };
  const requestedMarkets = KRAKEN_MARKETS.filter((market) => symbols.includes(market.symbol));
  if (requestedMarkets.length === 0) return { kind: "no-data", value };

  const depthMarkets = requestedMarkets.filter((market) => "clockedDepth" in market && market.clockedDepth);
  const tickerMarkets = requestedMarkets.filter((market) => !("clockedDepth" in market && market.clockedDepth));

  let transportAttempts = 0;
  let transportFailures = 0;
  let lastFailureReason: string | undefined;

  if (tickerMarkets.length > 0) {
    transportAttempts++;
    const requestedPairs = tickerMarkets.map((market) => market.requestPair);
    try {
      const { payload, transportOk, status } = await fetchCexJson<{
        error?: string[];
        result?: Record<string, { a?: string[]; b?: string[]; c?: string[] }>;
      }>(`https://api.kraken.com/0/public/Ticker?pair=${requestedPairs.join(",")}`, signal);
      if (!transportOk || !payload) {
        transportFailures++;
        lastFailureReason ??= "Kraken ticker HTTP error";
        value.diagnostics.push({
          source: "kraken",
          stage: "primary",
          endpoint: KRAKEN_TICKER_ENDPOINT,
          status,
          ok: false,
          success: false,
          candidateCount: tickerMarkets.length,
          resolvedCount: 0,
          rejectionReasonCounts: { [status != null ? "non-ok" : "upstream-error"]: 1 },
          errorClass: status != null ? "http_error" : "upstream_error",
        });
      } else if (Array.isArray(payload.error) && payload.error.length > 0) {
        transportFailures++;
        lastFailureReason ??= payload.error.join("; ");
        logWorkerEvent({ scope: "lib", level: "warn", event: "cex_kraken_api_error", message: "Kraken ticker API returned an error", provider: "kraken", metadata: { errors: payload.error } });
        value.diagnostics.push({
          source: "kraken",
          stage: "primary",
          endpoint: KRAKEN_TICKER_ENDPOINT,
          status,
          ok: false,
          success: false,
          candidateCount: tickerMarkets.length,
          resolvedCount: 0,
          rejectionReasonCounts: { "upstream-error": 1 },
          errorClass: "api_error",
        });
      } else {
        const allowedTickerSymbols = new Set<string>(tickerMarkets.map((market) => market.symbol));
        applyTickerRows(
          Object.entries(payload.result ?? {}),
          prices,
          ([responseKey]) => {
            const symbol = KRAKEN_RESPONSE_KEY_TO_SYMBOL.get(responseKey);
            return symbol && allowedTickerSymbols.has(symbol) ? symbol : undefined;
          },
          ([, market]) => market.b?.[0],
          ([, market]) => market.a?.[0],
          ([, market]) => market.c?.[0],
          { rejectionReasonCounts: tickerRejectionReasons, quoteBasisBySymbol },
        );

        const rejectionCount = tickerRejectionReasons["wide-spread"] ?? 0;
        if (rejectionCount > 0) {
          value.diagnostics.push(
            wideSpreadDiagnostic("kraken", KRAKEN_TICKER_ENDPOINT, rejectionCount, prices.size > 0, status),
          );
        }
      }
    } catch (err) {
      if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
      transportFailures++;
      lastFailureReason ??= errorMessageFor(err);
      logWorkerEvent({ scope: "lib", level: "warn", event: "cex_kraken_fetch_failed", message: "Kraken ticker fetch failed", provider: "kraken", error: err });
    }
  }

  if (depthMarkets.length > 0) {
    const depthRejectionReasons: Partial<Record<PricingProviderRejectionReason, number>> = {};
    let depthResolved = 0;
    let depthTransportErrors = 0;
    let lastDepthStatus: number | null = null;
    let depthErrorClass: string | undefined;
    const pacer = createCexRequestPacer(
      KRAKEN_DEPTH_REQUEST_INTERVAL_MS,
      KRAKEN_DEPTH_RATE_LIMIT_COOLDOWN_MS,
      COINBASE_MAX_RETRY_DELAY_MS,
      signal,
    );

    for (const market of depthMarkets) {
      await pacer.wait();
      transportAttempts++;

      try {
        const { payload, transportOk, status } = await fetchCexJson<{
          error?: string[];
          result?: Record<string, unknown>;
        }>(`https://api.kraken.com/0/public/Depth?pair=${market.requestPair}&count=1`, signal, {
          onResponse: pacer.onResponse,
          maxRetryDelayMs: COINBASE_MAX_RETRY_DELAY_MS,
        });
        if (status != null) lastDepthStatus = status;

        if (!transportOk || !payload) {
          transportFailures++;
          depthTransportErrors++;
          lastFailureReason ??= status != null ? `Kraken depth HTTP ${status}` : "Kraken depth HTTP error";
          depthErrorClass ??= status != null ? "http_error" : "upstream_error";
          incrementRejectionReason(depthRejectionReasons, status != null ? "non-ok" : "upstream-error");
          continue;
        }
        if (Array.isArray(payload.error) && payload.error.length > 0) {
          transportFailures++;
          depthTransportErrors++;
          lastFailureReason ??= payload.error.join("; ");
          depthErrorClass ??= "api_error";
          incrementRejectionReason(depthRejectionReasons, "upstream-error");
          logWorkerEvent({
            scope: "lib",
            level: "warn",
            event: "cex_kraken_depth_api_error",
            message: "Kraken depth API returned an error",
            provider: "kraken",
            metadata: { pair: market.requestPair, errors: payload.error },
          });
          continue;
        }

        const validated = validateKrakenDepthBook(payload.result, market.responseKeys);
        if (!validated.ok) {
          incrementRejectionReason(depthRejectionReasons, validated.reason);
          continue;
        }
        prices.set(market.symbol, validated.price);
        observedAtBySymbol.set(market.symbol, validated.observedAt);
        quoteBasisBySymbol.set(market.symbol, "bid-ask-midpoint");
        depthResolved++;
      } catch (err) {
        if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
        transportFailures++;
        depthTransportErrors++;
        lastFailureReason ??= errorMessageFor(err);
        depthErrorClass ??= errorClassFor(err);
        incrementRejectionReason(depthRejectionReasons, "upstream-error");
        logWorkerEvent({
          scope: "lib",
          level: "warn",
          event: "cex_kraken_depth_fetch_failed",
          message: "Kraken depth fetch failed",
          provider: "kraken",
          error: err,
          metadata: { pair: market.requestPair },
        });
      }
    }

    value.diagnostics.push({
      source: "kraken",
      stage: "primary",
      endpoint: KRAKEN_DEPTH_ENDPOINT,
      status: lastDepthStatus,
      ok: depthTransportErrors === 0,
      success: depthResolved > 0,
      candidateCount: depthMarkets.length,
      resolvedCount: depthResolved,
      ...(Object.keys(depthRejectionReasons).length > 0 ? { rejectionReasonCounts: depthRejectionReasons } : {}),
      ...(depthErrorClass ? { errorClass: depthErrorClass } : {}),
    });
  }

  if (transportAttempts > 0 && transportFailures === transportAttempts) {
    return { kind: "upstream-error", value, reason: lastFailureReason ?? "Kraken REST HTTP error" };
  }
  return prices.size > 0 ? { kind: "ok", value } : { kind: "no-data", value };
}

export async function fetchBitstampPrices(signal?: AbortSignal): Promise<FetcherOutcome<CexTickerBatch>> {
  const prices = new Map<string, number>();
  const observedAtBySymbol = new Map<string, number>();
  const rejectionReasonCounts: Partial<Record<PricingProviderRejectionReason, number>> = {};
  const value: CexTickerBatch = { prices, observedAtBySymbol, diagnostics: [] };

  try {
    const { payload: tickers, transportOk, status } = await fetchCexJson<
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
      {
        observedAtBySymbol,
        getObservedAt: (ticker) => parseBitstampTimestamp(ticker.timestamp),
        rejectionReasonCounts,
      },
    );

    const rejectionCount = rejectionReasonCounts["wide-spread"] ?? 0;
    if (rejectionCount > 0) {
      value.diagnostics.push(
        wideSpreadDiagnostic("bitstamp", BITSTAMP_TICKER_ENDPOINT, rejectionCount, prices.size > 0, status),
      );
    }
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    logWorkerEvent({ scope: "lib", level: "warn", event: "cex_bitstamp_fetch_failed", message: "Bitstamp ticker fetch failed", provider: "bitstamp", error: err });
    return { kind: "upstream-error", value, reason: errorMessageFor(err) };
  }

  return prices.size > 0 ? { kind: "ok", value } : { kind: "no-data", value };
}

export async function fetchCoinbasePrices(
  symbols: string[],
  signal?: AbortSignal,
): Promise<FetcherOutcome<CoinbaseQuoteBatch>> {
  const prices = new Map<string, number>();
  const observedAtBySymbol = new Map<string, number>();
  const rejectionReasonCounts: Partial<Record<PricingProviderRejectionReason, number>> = {};
  let wideBooks = 0;
  const value: CoinbaseQuoteBatch = {
    prices, observedAtBySymbol, diagnostics: [], quoteAssetBySymbol: new Map(), clockBySymbol: new Map(),
  };
  const requestedProducts = COINBASE_PRODUCTS.filter((product) => symbols.includes(product.symbol));
  let transportFailures = 0;
  let transportAttempts = 0;
  const pacer = createCexRequestPacer(
    COINBASE_REQUEST_INTERVAL_MS,
    COINBASE_RATE_LIMIT_COOLDOWN_MS,
    COINBASE_MAX_RETRY_DELAY_MS,
    signal,
  );

  await mapWithConcurrency(
    requestedProducts,
    COINBASE_PRODUCT_FETCH_CONCURRENCY,
    async (product) => {
      transportAttempts++;
      try {
        const productUrl = `${CEX_PROVIDER_AUDIT_CONFIG.coinbase.metadataUrl}/${product.productId}`;
        const storeQuote = (price: number, observedAt: number, clock: "book" | "trade") => {
          prices.set(product.symbol, price);
          observedAtBySymbol.set(product.symbol, observedAt);
          value.quoteAssetBySymbol.set(product.symbol, product.quoteAsset);
          value.clockBySymbol.set(product.symbol, clock);
        };
        const bookUrl = `${productUrl}/book?level=1`;
        type CoinbaseBookPayload = {
          bids?: [string, string, number][];
          asks?: [string, string, number][];
          time?: string;
          auction_mode?: boolean;
        };
        await pacer.wait();
        let bookResult = await fetchCexJson<CoinbaseBookPayload>(bookUrl, signal, {
          onResponse: pacer.onResponse,
          maxRetryDelayMs: COINBASE_MAX_RETRY_DELAY_MS,
        });
        if (!bookResult.transportOk && bookResult.status === 429) {
          // Shared Cloudflare egress IPs can see multi-second external bursts on
          // Coinbase's per-IP public bucket. Retry `/book?level=1` once after the
          // Retry-After / cooldown window instead of immediately falling back to `/ticker`.
          await pacer.wait();
          bookResult = await fetchCexJson<CoinbaseBookPayload>(bookUrl, signal, {
            onResponse: pacer.onResponse,
            maxRetryDelayMs: COINBASE_MAX_RETRY_DELAY_MS,
            retries: 0,
          });
        }
        const {
          payload: book,
          transportOk: bookTransportOk,
          status: bookStatus,
          retryAfterSec: bookRetryAfterSec,
        } = bookResult;
        const bookQuote = midpointFromBidAsk(book?.bids?.[0]?.[0], book?.asks?.[0]?.[0]);
        const bookTime = parseCoinbaseTime(book?.time);
        const bookFreshness = bookTime != null
          ? validatePricingSourceFreshness({
            source: "coinbase", observedAt: bookTime, maxFutureSkewSec: CEX_UPSTREAM_MAX_FUTURE_SKEW_SEC,
          })
          : null;
        if (bookQuote && bookFreshness?.accepted && !book?.auction_mode) {
          if (bookQuote.wideSpread) {
            wideBooks++;
            return;
          }
          storeQuote(bookQuote.midpoint, bookTime!, "book");
          return;
        }
        const bookRejectReason: PricingProviderRejectionReason = !bookTransportOk
          ? (bookStatus != null ? "non-ok" : "upstream-error")
          : book?.auction_mode
            ? "price-rejected"
            : !bookQuote
              ? "missing-quote"
              : bookFreshness && !bookFreshness.accepted && bookFreshness.reason === "stale_observed_at"
                ? "stale"
                : "invalid-shape";
        const bookErrorClass = !bookTransportOk
          ? "http_error"
          : book?.auction_mode
            ? "auction_mode"
            : !bookQuote
              ? "missing_book_quote"
              : bookTime == null
                ? "missing_observed_at"
                : bookFreshness && !bookFreshness.accepted
                  ? bookFreshness.reason
                  : "book_unavailable";
        value.diagnostics.push({
          source: "coinbase",
          stage: "primary",
          endpoint: endpointLabel(`${productUrl}/book`),
          status: bookStatus,
          ok: bookTransportOk,
          success: false,
          candidateCount: 1,
          resolvedCount: 0,
          rejectionReasonCounts: { [bookRejectReason]: 1 },
          errorClass: bookErrorClass,
          ...(bookRetryAfterSec != null ? { retryAfterSec: bookRetryAfterSec } : {}),
        });

        if (!bookTransportOk && bookStatus === 429) {
          // `/ticker` shares Coinbase's per-IP public REST bucket with `/book`;
          // skipping it after repeated 429s avoids extra burst pressure and leaves
          // the post-429 pacer cooldown armed for the next product.
          transportFailures++;
          return;
        }

        await pacer.wait();
        const {
          payload,
          transportOk: tickerTransportOk,
          status: tickerStatus,
          retryAfterSec: tickerRetryAfterSec,
        } = await fetchCexJson<{ bid?: string; ask?: string; price?: string; time?: string }>(
          `${productUrl}/ticker`,
          signal,
          {
            onResponse: pacer.onResponse,
            maxRetryDelayMs: COINBASE_MAX_RETRY_DELAY_MS,
          },
        );
        if (!tickerTransportOk || !payload) {
          transportFailures++;
          value.diagnostics.push({
            source: "coinbase",
            stage: "primary",
            endpoint: COINBASE_TICKER_ENDPOINT,
            status: tickerStatus,
            ok: false,
            success: false,
            ...(tickerRetryAfterSec != null ? { retryAfterSec: tickerRetryAfterSec } : {}),
          });
          return;
        }

        const quote = midpointFromBidAsk(payload.bid, payload.ask);
        if (quote?.wideSpread) {
          incrementRejectionReason(rejectionReasonCounts, "wide-spread");
          return;
        }
        const lastTrade = parseCexPrice(payload.price);
        const observedAt = parseCoinbaseTime(payload.time);
        if (lastTrade != null && observedAt != null && validatePricingSourceFreshness({
          source: "coinbase", observedAt, maxFutureSkewSec: CEX_UPSTREAM_MAX_FUTURE_SKEW_SEC,
        }).accepted) {
          storeQuote(lastTrade, observedAt, "trade");
        }
      } catch (err) {
        if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
        logWorkerEvent({ scope: "lib", level: "warn", event: "cex_coinbase_fetch_failed", message: "Coinbase ticker fetch failed", provider: "coinbase", error: err, metadata: { productId: product.productId } });
        transportFailures++;
        value.diagnostics.push({
          source: "coinbase",
          stage: "primary",
          endpoint: COINBASE_TICKER_ENDPOINT,
          status: null,
          ok: false,
          success: false,
          errorClass: errorClassFor(err),
          errorMessage: errorMessageFor(err),
        });
      }
    },
  );

  if (transportAttempts > 0 && transportFailures === transportAttempts) {
    return { kind: "upstream-error", value, reason: "all Coinbase product requests failed" };
  }
  const rejectionCount = rejectionReasonCounts["wide-spread"] ?? 0;
  if (wideBooks > 0) {
    value.diagnostics.push(wideSpreadDiagnostic("coinbase", COINBASE_BOOK_ENDPOINT, wideBooks, prices.size > 0, 200));
  }
  if (rejectionCount > 0) {
    value.diagnostics.push(
      wideSpreadDiagnostic("coinbase", COINBASE_TICKER_ENDPOINT, rejectionCount, prices.size > 0, null),
    );
  }
  if (prices.size === 0) {
    return { kind: "no-data", value };
  }
  return { kind: "ok", value };
}
