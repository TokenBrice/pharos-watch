import { z } from "zod";

/**
 * Real-time FX rate provider using Open Exchange Rates.
 * Free tier: 1,000 requests/month. At 1/hour = ~720/month, safely within free tier.
 * Basic plan ($12/mo, 10K/month) allows 15-min polling if needed later.
 */

const CURRENCY_TO_PEG: Record<string, string> = {
  EUR: "peggedEUR", GBP: "peggedGBP", CHF: "peggedCHF",
  BRL: "peggedREAL", JPY: "peggedJPY", IDR: "peggedIDR",
  SGD: "peggedSGD", TRY: "peggedTRY", AUD: "peggedAUD",
  ZAR: "peggedZAR", CAD: "peggedCAD", CNY: "peggedCNY",
  CNH: "peggedCNH", PHP: "peggedPHP", MXN: "peggedMXN",
  RUB: "peggedRUB", UAH: "peggedUAH", ARS: "peggedARS",
};

const FX_RATE_BOUNDS: Record<string, [number, number]> = {
  peggedEUR: [0.50, 2.50], peggedGBP: [0.50, 3.00], peggedCHF: [0.40, 2.50],
  peggedREAL: [0.05, 0.60], peggedJPY: [0.003, 0.03], peggedIDR: [0.00003, 0.0003],
  peggedSGD: [0.30, 1.50], peggedTRY: [0.01, 0.20], peggedAUD: [0.30, 1.50],
  peggedZAR: [0.02, 0.20], peggedRUB: [0.003, 0.10], peggedCAD: [0.40, 1.50],
  peggedCNY: [0.05, 0.40], peggedCNH: [0.05, 0.40], peggedPHP: [0.01, 0.06],
  peggedMXN: [0.02, 0.15], peggedUAH: [0.01, 0.10], peggedARS: [0.0001, 0.01],
};

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
    const symbols = Object.keys(CURRENCY_TO_PEG).join(",");
    const res = await fetch(
      `https://openexchangerates.org/api/latest.json?app_id=${apiKey}&symbols=${symbols}&base=USD`,
      { signal, headers: { Accept: "application/json" } },
    );
    if (!res.ok) {
      console.warn(`[fx-realtime] Open Exchange Rates returned ${res.status}`);
      return { rates: result, completed: true };
    }
    const data = OpenExchangeRatesSchema.parse(await res.json());

    for (const [currency, unitsPerUsd] of Object.entries(data.rates)) {
      const pegKey = CURRENCY_TO_PEG[currency];
      if (!pegKey || unitsPerUsd <= 0) continue;
      const rate = Number((1 / unitsPerUsd).toFixed(8));
      const bounds = FX_RATE_BOUNDS[pegKey];
      if (bounds && (rate < bounds[0] || rate > bounds[1])) {
        console.warn(`[fx-realtime] Rejected ${pegKey}=${rate}: outside bounds`);
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
