import { isRecord } from "@shared/lib/type-guards";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { rethrowIfAborted } from "./abort";
import { DEPEG_PRIMARY_PRICE_MAX_AGE_SEC, USER_AGENT } from "./constants";
import { cgHeaders, cgSimplePricePath, cgUrl } from "./coingecko";
import { fetchWithRetry } from "./fetch-retry";
import {
  endpointLabel,
  errorClassFor,
  errorMessageFor,
  type PricingProviderAttemptDiagnostic,
} from "./pricing-provider-diagnostics";
import { readResponseTextBoundedWithSignal, readResponseTextWithSignal } from "./response-body";

const COINGECKO_NATIVE_PEG_BATCH_SIZE = 50;
const COINGECKO_NATIVE_PEG_TIMEOUT_MS = 10_000;
const COINGECKO_NATIVE_PEG_ERROR_BODY_MAX_BYTES = 2_000;
const COINGECKO_NATIVE_PEG_FUTURE_SKEW_SEC = 5 * 60;

async function readNativePegResponseText(response: Response, signal?: AbortSignal): Promise<string> {
  const timeout = createTimeoutSignal({
    timeoutMs: COINGECKO_NATIVE_PEG_TIMEOUT_MS,
    timeoutReason: new DOMException(
      `response body timed out after ${COINGECKO_NATIVE_PEG_TIMEOUT_MS}ms`,
      "TimeoutError",
    ),
    parentSignal: signal,
  });
  try {
    return await readResponseTextWithSignal(response, timeout.signal);
  } finally {
    timeout.dispose();
  }
}

function sanitizeNativePegSnippet(value: string): string | undefined {
  const snippet = value.replace(/\s+/g, " ").trim().slice(0, 240);
  return snippet.length > 0 ? snippet : undefined;
}

async function readNativePegResponseSnippet(response: Response, signal?: AbortSignal): Promise<string | undefined> {
  const timeout = createTimeoutSignal({
    timeoutMs: COINGECKO_NATIVE_PEG_TIMEOUT_MS,
    timeoutReason: new DOMException(
      `response body timed out after ${COINGECKO_NATIVE_PEG_TIMEOUT_MS}ms`,
      "TimeoutError",
    ),
    parentSignal: signal,
  });
  try {
    return sanitizeNativePegSnippet(
      await readResponseTextBoundedWithSignal(response, COINGECKO_NATIVE_PEG_ERROR_BODY_MAX_BYTES, timeout.signal),
    );
  } catch (error) {
    rethrowIfAborted(error, signal);
    return undefined;
  } finally {
    timeout.dispose();
  }
}

/**
 * Maps each supported non-USD pegCurrency (uppercase ISO code matching
 * stablecoin registry `pegCurrency` values) to the CoinGecko `vs_currencies`
 * query strings to try in order.  CNY and CNH share both codes because
 * CoinGecko merges the two into a single `cny` feed while some providers
 * use `cnh`; trying both ensures a hit for either registry label.
 *
 * When adding a new FX stablecoin to the registry with a non-USD pegCurrency,
 * add a corresponding entry here so the native-peg quote pipeline covers it.
 * This map intentionally mirrors the set of non-USD pegCurrency values in
 * shared/data/stablecoins/coins/*.json — keep them in sync.
 */
const SUPPORTED_COINGECKO_NATIVE_PEG_CURRENCIES = new Map<string, string[]>([
  ["AUD", ["aud"]],
  ["ARS", ["ars"]],
  ["BRL", ["brl"]],
  ["CAD", ["cad"]],
  ["CHF", ["chf"]],
  ["CNY", ["cny", "cnh"]],
  ["CNH", ["cny", "cnh"]],
  ["EUR", ["eur"]],
  ["GBP", ["gbp"]],
  ["IDR", ["idr"]],
  ["JPY", ["jpy"]],
  ["KRW", ["krw"]],
  ["MXN", ["mxn"]],
  ["MYR", ["myr"]],
  ["NGN", ["ngn"]],
  ["PHP", ["php"]],
  ["RUB", ["rub"]],
  ["SGD", ["sgd"]],
  ["TRY", ["try"]],
  ["VND", ["vnd"]],
  ["ZAR", ["zar"]],
]);

export interface NativePegQuoteRequest {
  stablecoinId: string;
  geckoId?: string | null;
  pegCurrency?: string | null;
}

export interface NativePegQuote {
  stablecoinId: string;
  geckoId: string;
  pegCurrency: string;
  vsCurrency?: string;
  price: number;
  updatedAt: number;
}

export interface NativePegQuoteFetchOptions {
  diagnostics?: PricingProviderAttemptDiagnostic[];
  stage?: PricingProviderAttemptDiagnostic["stage"];
}

export function normalizeSupportedPegCurrency(pegCurrency: string | null | undefined): string | null {
  if (!pegCurrency) return null;
  const normalized = pegCurrency.trim().toUpperCase();
  return SUPPORTED_COINGECKO_NATIVE_PEG_CURRENCIES.has(normalized) ? normalized : null;
}

export function getNativePegQueryCurrencies(pegCurrency: string | null | undefined): string[] {
  const normalized = normalizeSupportedPegCurrency(pegCurrency);
  if (!normalized) return [];
  return SUPPORTED_COINGECKO_NATIVE_PEG_CURRENCIES.get(normalized) ?? [];
}

export async function fetchCurrentNativePegQuotes(
  requests: NativePegQuoteRequest[],
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
  options?: NativePegQuoteFetchOptions,
): Promise<Map<string, NativePegQuote>> {
  const supportedRequests = requests
    .map((request) => ({
      stablecoinId: request.stablecoinId,
      geckoId: typeof request.geckoId === "string" && request.geckoId.length > 0 ? request.geckoId : null,
      pegCurrency: normalizeSupportedPegCurrency(request.pegCurrency),
    }))
    .filter((request): request is { stablecoinId: string; geckoId: string; pegCurrency: string } => (
      request.geckoId != null && request.pegCurrency != null
    ));

  if (supportedRequests.length === 0) {
    if (requests.length > 0) {
      options?.diagnostics?.push({
        source: "native-peg",
        stage: options.stage ?? "depeg-confirmation",
        endpoint: "api.coingecko.com/api/v3/simple/price",
        status: null,
        ok: true,
        success: true,
        candidateCount: 0,
        rejectionReasonCounts: { "unsupported-quote": requests.length },
      });
    }
    return new Map();
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const quotes = new Map<string, NativePegQuote>();

  const groupedRequests = new Map<string, Array<{ stablecoinId: string; geckoId: string }>>();
  for (const request of supportedRequests) {
    const list = groupedRequests.get(request.pegCurrency) ?? [];
    list.push({ stablecoinId: request.stablecoinId, geckoId: request.geckoId });
    groupedRequests.set(request.pegCurrency, list);
  }

  for (const [pegCurrency, group] of groupedRequests) {
    const queryCurrencies = getNativePegQueryCurrencies(pegCurrency);
    if (queryCurrencies.length === 0) continue;
    for (let index = 0; index < group.length; index += COINGECKO_NATIVE_PEG_BATCH_SIZE) {
      const batch = group.slice(index, index + COINGECKO_NATIVE_PEG_BATCH_SIZE);
      const uniqueGeckoIds = Array.from(new Set(batch.map((request) => request.geckoId)));
      for (const vsCurrency of queryCurrencies) {
        const pendingRequests = batch.filter((request) => !quotes.has(request.stablecoinId));
        if (pendingRequests.length === 0) break;

        const url = cgUrl(
          cgSimplePricePath(`ids=${encodeURIComponent(uniqueGeckoIds.join(","))}&vs_currencies=${vsCurrency}&include_last_updated_at=true`),
          coingeckoApiKey ?? null,
        );
        const diagnostic: PricingProviderAttemptDiagnostic = {
          source: "native-peg",
          stage: options?.stage ?? "depeg-confirmation",
          endpoint: endpointLabel(url),
          status: null,
          ok: false,
          success: false,
          candidateCount: pendingRequests.length,
        };

        try {
          const response = await fetchWithRetry(
            url,
            {
              headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey ?? null),
              signal,
            },
            1,
            { timeoutMs: COINGECKO_NATIVE_PEG_TIMEOUT_MS },
          );
          diagnostic.status = response?.status ?? null;
          diagnostic.ok = response?.ok === true;
          if (!response?.ok) {
            diagnostic.snippet = response ? await readNativePegResponseSnippet(response, signal) : undefined;
            diagnostic.rejectionReasonCounts = { "non-ok": 1 };
            options?.diagnostics?.push(diagnostic);
            continue;
          }

          const payload = JSON.parse(await readNativePegResponseText(response, signal)) as unknown;
          if (!isRecord(payload)) {
            options?.diagnostics?.push({
              ...diagnostic,
              ok: true,
              errorClass: "invalid-shape",
              errorMessage: "Expected CoinGecko native-peg payload to be an object",
              rejectionReasonCounts: { "invalid-shape": 1 },
            });
            continue;
          }

          let filledAny = false;
          let staleCount = 0;
          let futureCount = 0;
          let emptyCount = 0;
          for (const request of pendingRequests) {
            const rawEntry = payload[request.geckoId];
            if (!isRecord(rawEntry)) {
              emptyCount++;
              continue;
            }

            const price = rawEntry[vsCurrency];
            const updatedAt = rawEntry.last_updated_at;
            if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
              emptyCount++;
              continue;
            }
            if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt <= 0) {
              emptyCount++;
              continue;
            }
            if (updatedAt - nowSec > COINGECKO_NATIVE_PEG_FUTURE_SKEW_SEC) {
              futureCount++;
              continue;
            }
            if (nowSec - updatedAt > DEPEG_PRIMARY_PRICE_MAX_AGE_SEC) {
              staleCount++;
              continue;
            }

            quotes.set(request.stablecoinId, {
              stablecoinId: request.stablecoinId,
              geckoId: request.geckoId,
              pegCurrency,
              vsCurrency,
              price,
              updatedAt,
            });
            filledAny = true;
          }
          diagnostic.responseRowCount = Object.keys(payload).length;
          diagnostic.resolvedCount = pendingRequests.filter((request) => quotes.has(request.stablecoinId)).length;
          diagnostic.success = filledAny;
          if (staleCount > 0 || futureCount > 0 || emptyCount > 0 || filledAny) {
            diagnostic.rejectionReasonCounts = {
              ...(staleCount > 0 ? { stale: staleCount } : {}),
              ...(futureCount > 0 ? { future: futureCount } : {}),
              ...(emptyCount > 0 ? { "empty-response": emptyCount } : {}),
            };
            options?.diagnostics?.push(diagnostic);
          }

          if (filledAny && batch.every((request) => quotes.has(request.stablecoinId))) {
            break;
          }
        } catch (error) {
          if (signal?.aborted) {
            throw error instanceof Error ? error : new Error(String(error));
          }
          console.warn(
            `[native-peg-quotes] CoinGecko ${pegCurrency} quote fetch failed for ${uniqueGeckoIds.join(",")}:`,
            error,
          );
          options?.diagnostics?.push({
            ...diagnostic,
            errorClass: errorClassFor(error),
            errorMessage: errorMessageFor(error),
            rejectionReasonCounts: { "upstream-error": 1 },
          });
        }
      }
    }
  }

  return quotes;
}
