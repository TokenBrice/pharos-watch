import { logWorkerEventArgs } from "./structured-log";
/**
 * CoinGecko per-exchange ticker extraction.
 *
 * For coins that trade on a single exchange with multiple pairs (e.g. KAU on
 * Kinesis Money), CoinGecko's /simple/price aggregate mixes all pairs —
 * including stale, low-volume, and wide-spread pairs — into one noisy number.
 *
 * This module fetches the /coins/{id}/tickers endpoint instead and extracts
 * the direct USD pair, giving a clean, authoritative price.
 */

import { cgUrl, cgHeaders } from "./coingecko";
import { USER_AGENT } from "./constants";
import { fetchJsonWithRetry } from "./fetch-retry";

export interface CgTickerConfig {
  stablecoinId: string;
  geckoId: string;
  targetCurrency: string;
  exchangeId?: string;
}

interface CgTickerEntry {
  base: string;
  target: string;
  last: number;
  volume: number;
  is_stale: boolean;
  bid_ask_spread_percentage: number;
  converted_last: { usd?: number };
  converted_volume: { usd?: number };
  market: { identifier: string };
}

interface CgTickerResponse {
  tickers?: CgTickerEntry[];
}

export interface CgTickerFetchResult {
  prices: Map<string, number>;
  successfulResponses: number;
}

/**
 * Pick the best USD ticker: non-stale, target matches, highest volume.
 * Returns the `last` price (already in target currency) or null.
 */
export function pickBestTicker(
  tickers: CgTickerEntry[],
  targetCurrency: string,
  exchangeId?: string,
): number | null {
  const normalizedTarget = targetCurrency.toUpperCase();
  const candidates = tickers.filter((t) => {
    if (t.target.toUpperCase() !== normalizedTarget) return false;
    if (t.is_stale) return false;
    if (exchangeId && t.market.identifier !== exchangeId) return false;
    if (!Number.isFinite(t.last) || t.last <= 0) return false;
    return true;
  });

  if (candidates.length === 0) return null;

  // Pick the ticker with highest converted USD volume (most liquid)
  candidates.sort((a, b) => (b.converted_volume?.usd ?? 0) - (a.converted_volume?.usd ?? 0));
  return candidates[0].last;
}

/**
 * Fetch per-exchange ticker prices for configured coins from CoinGecko's
 * /coins/{id}/tickers endpoint. Fetches sequentially to respect connection
 * budget (only 2 calls for KAU + KAG).
 */
export async function fetchCgTickerPricesDetailed(
  configs: CgTickerConfig[],
  apiKey: string | null,
  signal?: AbortSignal,
): Promise<CgTickerFetchResult> {
  const results = new Map<string, number>();
  let successfulResponses = 0;

  for (const config of configs) {
    try {
      const exchangeFilter = config.exchangeId ? `&exchange_ids=${config.exchangeId}` : "";
      const url = cgUrl(
        `/coins/${config.geckoId}/tickers?depth=false${exchangeFilter}`,
        apiKey,
      );
      const result = await fetchJsonWithRetry<CgTickerResponse>(
        url,
        {
          headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, apiKey),
          signal,
        },
        1, // single retry — this is a bonus source, not critical
        { timeoutMs: 10_000 },
      );

      if (!result?.response.ok) {
        logWorkerEventArgs("lib", "warn", `[cg-ticker] ${config.geckoId} returned ${result?.response.status ?? "null"}`);
        continue;
      }

      successfulResponses++;
      const data = result.body;
      const tickers = data.tickers;
      if (!Array.isArray(tickers) || tickers.length === 0) {
        logWorkerEventArgs("lib", "warn", `[cg-ticker] ${config.geckoId}: no tickers returned`);
        continue;
      }

      const price = pickBestTicker(tickers, config.targetCurrency, config.exchangeId);
      if (price != null) {
        results.set(config.stablecoinId, price);
      } else {
        logWorkerEventArgs("lib", "warn",
          `[cg-ticker] ${config.geckoId}: no valid ${config.targetCurrency} ticker found (${tickers.length} total)`,
        );
      }
    } catch (err) {
      if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
      logWorkerEventArgs("lib", "warn", `[cg-ticker] ${config.geckoId} failed:`, err instanceof Error ? err.message : err);
    }
  }

  return {
    prices: results,
    successfulResponses,
  };
}
