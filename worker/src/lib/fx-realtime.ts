import { logWorkerEventArgs } from "./structured-log";
import { z } from "zod";
import {
  isValidFxRate,
  REALTIME_FX_CURRENCY_TO_PEG,
} from "./fx-config";
import { fetchJsonWithRetry } from "./fetch-retry";

/**
 * Real-time FX rate provider using Open Exchange Rates.
 * Free tier: 1,000 requests/month. At 1/hour = ~720/month, safely within free tier.
 * Basic plan ($12/mo, 10K/month) allows 15-min polling if needed later.
 */

const OpenExchangeRatesSchema = z.object({
  rates: z.record(z.string(), z.number()),
});

const OPEN_EXCHANGE_RATES_REQUEST_TIMEOUT_MS = 5_000;
const OPEN_EXCHANGE_RATES_MAX_RETRIES = 1;

export interface RealtimeFxFetchResult {
  rates: Map<string, number>;
  completed: boolean;
}

/**
 * Fetch real-time FX rates from Open Exchange Rates.
 * Returns Map<pegKey, usdPerUnit> — same format as sync-fx-rates cache.
 */
export async function fetchRealtimeFxRates(
  apiKey: string,
  signal?: AbortSignal,
): Promise<RealtimeFxFetchResult> {
  const result = new Map<string, number>();
  if (!apiKey) {
    return { rates: result, completed: false };
  }

  try {
    const symbols = Object.keys(REALTIME_FX_CURRENCY_TO_PEG).join(",");
    const fetchResult = await fetchJsonWithRetry<unknown>(
      `https://openexchangerates.org/api/latest.json?app_id=${apiKey}&symbols=${symbols}&base=USD`,
      { signal, headers: { Accept: "application/json" } },
      OPEN_EXCHANGE_RATES_MAX_RETRIES,
      { timeoutMs: OPEN_EXCHANGE_RATES_REQUEST_TIMEOUT_MS },
    );
    if (!fetchResult) {
      logWorkerEventArgs("lib", "warn", "[fx-realtime] Open Exchange Rates returned no response");
      return { rates: result, completed: false };
    }
    if (!fetchResult.response.ok) {
      logWorkerEventArgs("lib", "warn", `[fx-realtime] Open Exchange Rates returned ${fetchResult.response.status}`);
      return { rates: result, completed: true };
    }
    const data = OpenExchangeRatesSchema.parse(fetchResult.body);

    for (const [currency, unitsPerUsd] of Object.entries(data.rates)) {
      const pegKey = REALTIME_FX_CURRENCY_TO_PEG[currency];
      if (!pegKey || unitsPerUsd <= 0) continue;
      const rate = Number((1 / unitsPerUsd).toFixed(8));
      if (!isValidFxRate(pegKey, rate, undefined, "[fx-realtime]")) {
        continue;
      }
      result.set(pegKey, rate);
    }
    return { rates: result, completed: true };
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    logWorkerEventArgs("lib", "warn", "[fx-realtime] Fetch failed:", err);
    return { rates: result, completed: false };
  }
}
