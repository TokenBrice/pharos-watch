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
import { CEX_MAX_BID_ASK_SPREAD_BPS } from "@shared/lib/pricing-source-policy";
import { isRecord } from "@shared/lib/type-guards";
import { parseIsoDateOrUtcInstantSec } from "@shared/types/date-primitives";
import { throwIfAborted } from "./abort";
import { USER_AGENT } from "./constants";
import { fetchJsonWithRetry, fetchTextWithRetry } from "./fetch-retry";
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
const KRAKEN_TICKER_ENDPOINT = "api.kraken.com/0/public/Ticker";
const KRAKEN_BBO_ENDPOINT = "ws.kraken.com/v2";
const KRAKEN_BBO_SNAPSHOTS_ENABLED = false;
const KRAKEN_BBO_DEADLINE_MS = 2_000;
const KRAKEN_BBO_MAX_MESSAGES = 64;
const KRAKEN_BBO_MAX_BYTES = 32 * 1024;
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
  bid: string | number | null | undefined,
  ask: string | number | null | undefined,
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

async function fetchCexJson<T>(
  url: string,
  signal?: AbortSignal,
): Promise<{ payload: T | null; transportOk: boolean; status: number | null }> {
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
    return { payload: null, transportOk: false, status: result?.response.status ?? null };
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

export interface KrakenBookSnapshot {
  price: number;
  observedAt: number;
}

export interface CexTickerBatch {
  prices: Map<string, number>;
  quoteBasisBySymbol?: Map<string, "bid-ask-midpoint" | "last-trade">;
  observedAtBySymbol: Map<string, number>;
  bookSnapshotsBySymbol?: Map<string, KrakenBookSnapshot>;
  diagnostics: PricingProviderAttemptDiagnostic[];
}

export interface CoinbaseQuoteBatch extends CexTickerBatch {
  quoteAssetBySymbol: Map<string, "USD" | "USDC">;
  clockBySymbol: Map<string, "book" | "trade">;
}

async function fetchKrakenRestPrices(
  symbols: string[],
  signal?: AbortSignal,
): Promise<FetcherOutcome<CexTickerBatch>> {
  const prices = new Map<string, number>();
  const observedAtBySymbol = new Map<string, number>();
  const rejectionReasonCounts: Partial<Record<PricingProviderRejectionReason, number>> = {};
  // The batch Ticker response has no trade timestamp. Its last-trade fallback
  // stays undated, even when the HTTP request and its order book are current.
  const quoteBasisBySymbol = new Map<string, "bid-ask-midpoint" | "last-trade">();
  const value: CexTickerBatch = { prices, quoteBasisBySymbol, observedAtBySymbol, diagnostics: [] };
  const requestedPairs = KRAKEN_MARKETS.filter((market) => symbols.includes(market.symbol)).map(
    (market) => market.requestPair,
  );
  if (requestedPairs.length === 0) return { kind: "no-data", value };

  try {
    const { payload, transportOk, status } = await fetchCexJson<{
      error?: string[];
      result?: Record<string, { a?: string[]; b?: string[]; c?: string[] }>;
    }>(`https://api.kraken.com/0/public/Ticker?pair=${requestedPairs.join(",")}`, signal);
    if (!transportOk || !payload) {
      return { kind: "upstream-error", value, reason: "Kraken ticker HTTP error" };
    }
    if (Array.isArray(payload.error) && payload.error.length > 0) {
      logWorkerEvent({ scope: "lib", level: "warn", event: "cex_kraken_api_error", message: "Kraken ticker API returned an error", provider: "kraken", metadata: { errors: payload.error } });
      return { kind: "upstream-error", value, reason: payload.error.join("; ") };
    }

    applyTickerRows(
      Object.entries(payload.result ?? {}),
      prices,
      ([responseKey]) => KRAKEN_RESPONSE_KEY_TO_SYMBOL.get(responseKey),
      ([, market]) => market.b?.[0],
      ([, market]) => market.a?.[0],
      ([, market]) => market.c?.[0],
      { rejectionReasonCounts, quoteBasisBySymbol },
    );

    const rejectionCount = rejectionReasonCounts["wide-spread"] ?? 0;
    if (rejectionCount > 0) {
      value.diagnostics.push(
        wideSpreadDiagnostic("kraken", KRAKEN_TICKER_ENDPOINT, rejectionCount, prices.size > 0, status),
      );
    }
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    logWorkerEvent({ scope: "lib", level: "warn", event: "cex_kraken_fetch_failed", message: "Kraken ticker fetch failed", provider: "kraken", error: err });
    return { kind: "upstream-error", value, reason: errorMessageFor(err) };
  }

  return prices.size > 0 ? { kind: "ok", value } : { kind: "no-data", value };
}

function validateKrakenBook(row: Record<string, unknown>): KrakenBookSnapshot | PricingProviderRejectionReason {
  const quote = typeof row.bid === "number" && typeof row.ask === "number"
    ? midpointFromBidAsk(row.bid, row.ask) : null;
  if (!quote || !Number.isFinite(quote.midpoint)) return "invalid-shape";
  if (quote.wideSpread) return "wide-spread";

  const timestamp = typeof row.timestamp === "string"
    ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:Z|(\.\d+)Z)$/.exec(row.timestamp) : null;
  if (!timestamp) return "invalid-shape";
  // Check the fractional timestamp before normalizing it to publication seconds.
  const observedAt = parseIsoDateOrUtcInstantSec(`${timestamp[1]}Z`) + Number(timestamp[2] ?? 0);
  const now = Date.now() / 1000;
  if (observedAt > now) return "invalid-shape";
  const freshness = validatePricingSourceFreshness({
    source: "kraken", observedAt, nowSec: Math.floor(now), requireObservedAt: true, maxFutureSkewSec: 0,
  });
  if (!freshness.accepted) return freshness.reason === "stale_observed_at" ? "stale" : "invalid-shape";
  return freshness.observedAt == null ? "invalid-shape" : { price: quote.midpoint, observedAt: freshness.observedAt };
}

async function readKrakenBookSnapshots(pending: Map<string, string>, parent?: AbortSignal) {
  throwIfAborted(parent);
  const quotes = new Map<string, KrakenBookSnapshot>();
  const rejectionReasonCounts: Partial<Record<PricingProviderRejectionReason, number>> = {};
  const candidateCount = pending.size;
  const deadline = new AbortController();
  const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), KRAKEN_BBO_DEADLINE_MS);
  let socket: WebSocket | null = null;
  let status: number | null = null;
  let errorClass: string | undefined;
  try {
    const response = await fetch(`https://${KRAKEN_BBO_ENDPOINT}`, {
      headers: { Upgrade: "websocket" },
      redirect: "manual",
      signal,
    });
    status = response.status;
    const ws = response.webSocket;
    if (!ws) {
      await response.body?.cancel();
      errorClass = "upgrade-rejected";
    } else {
      ws.accept();
      socket = ws;
      errorClass = await new Promise<string | undefined>((resolve) => {
        const encoder = new TextEncoder();
        let bytes = 0;
        let messages = 0;
        const finish = (reason?: string) => {
          ws.removeEventListener("message", onMessage);
          ws.removeEventListener("close", onClose);
          ws.removeEventListener("error", onError);
          signal.removeEventListener("abort", onAbort);
          resolve(reason);
        };
        const onAbort = () => finish("timeout");
        const onClose = () => finish("socket-closed");
        const onError = () => finish("socket-error");
        function onMessage({ data }: MessageEvent) {
          if (++messages > KRAKEN_BBO_MAX_MESSAGES) return finish("message-cap");
          if (typeof data !== "string") return finish("invalid-shape");
          if (data.length > KRAKEN_BBO_MAX_BYTES - bytes) return finish("byte-cap");
          bytes += encoder.encode(data).byteLength;
          if (bytes > KRAKEN_BBO_MAX_BYTES) return finish("byte-cap");
          let message: unknown;
          try {
            message = JSON.parse(data);
          } catch {
            incrementRejectionReason(rejectionReasonCounts, "malformed-json");
            return;
          }
          if (!isRecord(message)) return;
          if (message.method === "subscribe" && message.success === false && isRecord(message.result)
            && typeof message.result.symbol === "string" && pending.delete(message.result.symbol)) {
            incrementRejectionReason(rejectionReasonCounts, "upstream-error");
          }
          if (message.channel === "ticker" && message.type === "snapshot" && Array.isArray(message.data)) {
            for (const row of message.data) {
              if (!isRecord(row) || typeof row.symbol !== "string") continue;
              const symbol = pending.get(row.symbol);
              if (!symbol) continue;
              pending.delete(row.symbol);

              const quote = validateKrakenBook(row);
              if (typeof quote === "string") incrementRejectionReason(rejectionReasonCounts, quote);
              else quotes.set(symbol, quote);
            }
          }
          if (pending.size === 0) finish();
        }

        if (signal.aborted) return onAbort();
        ws.addEventListener("message", onMessage);
        ws.addEventListener("close", onClose);
        ws.addEventListener("error", onError);
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          ws.send(JSON.stringify({
            method: "subscribe",
            params: { channel: "ticker", symbol: [...pending.keys()], event_trigger: "bbo", snapshot: true },
          }));
        } catch {
          finish("socket-error");
        }
      });
    }
  } catch {
    errorClass = signal.aborted ? "timeout" : "socket-error";
  } finally {
    clearTimeout(timer);
    socket?.close(1000);
  }
  throwIfAborted(parent);
  if (pending.size > 0) rejectionReasonCounts["missing-quote"] = pending.size;
  const diagnostic: PricingProviderAttemptDiagnostic = {
    source: "kraken", stage: "primary", endpoint: KRAKEN_BBO_ENDPOINT, status,
    ok: errorClass === undefined, success: quotes.size > 0,
    candidateCount, resolvedCount: quotes.size, rejectionReasonCounts, errorClass,
  };
  return { quotes, diagnostic };
}

export async function fetchKrakenPrices(
  symbols: string[],
  signal?: AbortSignal,
  enableBookSnapshots = KRAKEN_BBO_SNAPSHOTS_ENABLED,
): Promise<FetcherOutcome<CexTickerBatch>> {
  if (!enableBookSnapshots) return fetchKrakenRestPrices(symbols, signal);
  const requested = new Map<string, string>();
  for (const market of KRAKEN_MARKETS) {
    if ("snapshotPair" in market && symbols.includes(market.symbol)) requested.set(market.snapshotPair, market.symbol);
  }
  if (requested.size === 0) return fetchKrakenRestPrices(symbols, signal);

  const { quotes, diagnostic } = await readKrakenBookSnapshots(requested, signal);
  throwIfAborted(signal);
  // REST still owns the availability breaker even when a clocked snapshot was admitted.
  const outcome = await fetchKrakenRestPrices(symbols, signal);
  throwIfAborted(signal);
  outcome.value.bookSnapshotsBySymbol = quotes;
  outcome.value.diagnostics.push(diagnostic);
  return outcome;
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

  await mapWithConcurrency(
    requestedProducts,
    COINBASE_PRODUCT_FETCH_CONCURRENCY,
    async (product) => {
      transportAttempts++;
      let responseStatus: number | null = null;
      try {
        const productUrl = `${CEX_PROVIDER_AUDIT_CONFIG.coinbase.metadataUrl}/${product.productId}`;
        const storeQuote = (price: number, observedAt: number, clock: "book" | "trade") => {
          prices.set(product.symbol, price);
          observedAtBySymbol.set(product.symbol, observedAt);
          value.quoteAssetBySymbol.set(product.symbol, product.quoteAsset);
          value.clockBySymbol.set(product.symbol, clock);
        };
        const { payload: book } = await fetchCexJson<{
          bids?: [string, string, number][];
          asks?: [string, string, number][];
          time?: string;
          auction_mode?: boolean;
        }>(`${productUrl}/book?level=1`, signal);
        const bookQuote = midpointFromBidAsk(book?.bids?.[0]?.[0], book?.asks?.[0]?.[0]);
        const bookTime = parseCoinbaseTime(book?.time);
        if (bookQuote && bookTime != null && !book?.auction_mode && validatePricingSourceFreshness({
          source: "coinbase", observedAt: bookTime, maxFutureSkewSec: 0,
        }).accepted) {
          if (bookQuote.wideSpread) {
            wideBooks++;
            return;
          }
          storeQuote(bookQuote.midpoint, bookTime, "book");
          return;
        }

        const result = await fetchJsonWithRetry<{ bid?: string; ask?: string; price?: string; time?: string }>(
          `${productUrl}/ticker`,
          {
            signal,
            headers: { Accept: "application/json", "User-Agent": USER_AGENT },
          },
          CEX_REQUEST_RETRIES,
          {
            timeoutMs: CEX_REQUEST_TIMEOUT_MS,
            onResponse: (response) => { responseStatus = response.status; },
          },
        );
        if (!result?.response.ok) {
          transportFailures++;
          value.diagnostics.push({
            source: "coinbase",
            stage: "primary",
            endpoint: COINBASE_TICKER_ENDPOINT,
            status: result?.response.status ?? responseStatus,
            ok: false,
            success: false,
          });
          return;
        }

        const payload = result.body;
        const quote = midpointFromBidAsk(payload.bid, payload.ask);
        if (quote?.wideSpread) {
          incrementRejectionReason(rejectionReasonCounts, "wide-spread");
          return;
        }
        const lastTrade = parseCexPrice(payload.price);
        const observedAt = parseCoinbaseTime(payload.time);
        if (lastTrade != null && observedAt != null && validatePricingSourceFreshness({
          source: "coinbase", observedAt, maxFutureSkewSec: 0,
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
