import { DEPEG_PRIMARY_PRICE_MAX_AGE_SEC, USER_AGENT } from "./constants";
import { cgHeaders, cgUrl } from "./coingecko";
import { fetchWithRetry } from "./fetch-retry";

const COINGECKO_NATIVE_PEG_BATCH_SIZE = 50;
const COINGECKO_NATIVE_PEG_TIMEOUT_MS = 10_000;
const SUPPORTED_COINGECKO_NATIVE_PEG_CURRENCIES = new Map<string, string[]>([
  ["AUD", ["aud"]],
  ["BRL", ["brl"]],
  ["CAD", ["cad"]],
  ["CHF", ["chf"]],
  ["CNY", ["cny", "cnh"]],
  ["CNH", ["cny", "cnh"]],
  ["EUR", ["eur"]],
  ["GBP", ["gbp"]],
  ["IDR", ["idr"]],
  ["JPY", ["jpy"]],
  ["MXN", ["mxn"]],
  ["PHP", ["php"]],
  ["RUB", ["rub"]],
  ["SGD", ["sgd"]],
  ["TRY", ["try"]],
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

export function getPreferredNativePegQueryCurrency(pegCurrency: string | null | undefined): string | null {
  return getNativePegQueryCurrencies(pegCurrency)[0] ?? null;
}

function getQueryCurrenciesForPeg(pegCurrency: string): string[] {
  return SUPPORTED_COINGECKO_NATIVE_PEG_CURRENCIES.get(pegCurrency) ?? [];
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function fetchCurrentNativePegQuotes(
  requests: NativePegQuoteRequest[],
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
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
    const queryCurrencies = getQueryCurrenciesForPeg(pegCurrency);
    if (queryCurrencies.length === 0) continue;
    for (let index = 0; index < group.length; index += COINGECKO_NATIVE_PEG_BATCH_SIZE) {
      const batch = group.slice(index, index + COINGECKO_NATIVE_PEG_BATCH_SIZE);
      const uniqueGeckoIds = Array.from(new Set(batch.map((request) => request.geckoId)));
      for (const vsCurrency of queryCurrencies) {
        const pendingRequests = batch.filter((request) => !quotes.has(request.stablecoinId));
        if (pendingRequests.length === 0) break;

        const url = cgUrl(
          `/simple/price?ids=${encodeURIComponent(uniqueGeckoIds.join(","))}&vs_currencies=${vsCurrency}&include_last_updated_at=true`,
          coingeckoApiKey ?? null,
        );

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
          if (!response?.ok) {
            if (response) {
              try {
                await response.text();
              } catch {
                // Ignore failed body reads on non-OK responses.
              }
            }
            continue;
          }

          const payload = await response.json();
          if (!isObjectRecord(payload)) {
            continue;
          }

          let filledAny = false;
          for (const request of pendingRequests) {
            const rawEntry = payload[request.geckoId];
            if (!isObjectRecord(rawEntry)) continue;

            const price = rawEntry[vsCurrency];
            const updatedAt = rawEntry.last_updated_at;
            if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue;
            if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt <= 0) continue;
            if (nowSec - updatedAt > DEPEG_PRIMARY_PRICE_MAX_AGE_SEC) continue;

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
        }
      }
    }
  }

  return quotes;
}
