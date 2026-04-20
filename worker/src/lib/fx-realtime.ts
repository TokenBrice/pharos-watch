import { z } from "zod";
import {
  isValidFxRate,
  REALTIME_FX_CURRENCY_TO_PEG,
} from "./fx-config";
import { cancelResponseBodyQuietly } from "./response-body";

/**
 * Real-time FX rate provider using Open Exchange Rates.
 * Free tier: 1,000 requests/month. At 1/hour = ~720/month, safely within free tier.
 * Basic plan ($12/mo, 10K/month) allows 15-min polling if needed later.
 */

const OpenExchangeRatesSchema = z.object({
  rates: z.record(z.string(), z.number()),
});

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
    const res = await fetch(
      `https://openexchangerates.org/api/latest.json?app_id=${apiKey}&symbols=${symbols}&base=USD`,
      { signal, headers: { Accept: "application/json" } },
    );
    if (!res.ok) {
      console.warn(`[fx-realtime] Open Exchange Rates returned ${res.status}`);
      await cancelResponseBodyQuietly(res);
      return { rates: result, completed: true };
    }
    const data = OpenExchangeRatesSchema.parse(await res.json());

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
    console.warn("[fx-realtime] Fetch failed:", err);
    return { rates: result, completed: false };
  }
}
