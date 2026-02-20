import { getCache, setCache } from "../lib/db";
import { fetchWithRetry } from "../lib/fetch-retry";
import { RUB_FALLBACK, USER_AGENT } from "../lib/constants";

/**
 * Fetches live FX rates from the European Central Bank (via frankfurter.app)
 * and stores them in D1 cache as fallback rates for thin peg groups.
 *
 * Format matches FALLBACK_RATES in peg-rates.ts: { peggedEUR: 1.08, ... }
 * where the value is "USD per 1 unit of the currency".
 *
 * RUB is not published by ECB (sanctions) so we keep a hardcoded fallback.
 * Runs every 2 hours.
 */

const CURRENCIES = ["EUR", "GBP", "CHF", "BRL", "JPY", "IDR", "SGD", "TRY", "AUD", "ZAR"] as const;

const CURRENCY_TO_PEG: Record<string, string> = {
  EUR: "peggedEUR",
  GBP: "peggedGBP",
  CHF: "peggedCHF",
  BRL: "peggedREAL", // DefiLlama uses "peggedREAL" (not "peggedBRL") for BRL stablecoins
  JPY: "peggedJPY",
  IDR: "peggedIDR",
  SGD: "peggedSGD",
  TRY: "peggedTRY",
  AUD: "peggedAUD",
  ZAR: "peggedZAR",
};

/** Generous bounds for USD-per-unit rates (~50%-200% of typical values).
 *  Any rate outside these bounds is almost certainly corrupted API data. */
const FX_RATE_BOUNDS: Record<string, [number, number]> = {
  peggedEUR: [0.50, 2.50],     // EUR ~$1.08
  peggedGBP: [0.50, 3.00],     // GBP ~$1.27
  peggedCHF: [0.40, 2.50],     // CHF ~$1.13
  peggedREAL: [0.05, 0.60],    // BRL ~$0.20
  peggedJPY: [0.003, 0.03],    // JPY ~$0.007
  peggedIDR: [0.00003, 0.0003],// IDR ~$0.00006
  peggedSGD: [0.30, 1.50],     // SGD ~$0.75
  peggedTRY: [0.01, 0.20],     // TRY ~$0.03
  peggedAUD: [0.30, 1.50],     // AUD ~$0.65
  peggedZAR: [0.02, 0.20],     // ZAR ~$0.055
  peggedRUB: [0.003, 0.10],    // RUB ~$0.013
  peggedSILVER: [5, 500],      // Silver ~$30/oz
  peggedGOLD: [500, 10000],     // Gold ~$2900/oz
};

/** Max allowed change from previous cached value (no FX rate moves 20% in 2 hours) */
const MAX_DELTA_PCT = 0.20;

/** Validate a rate against bounds and delta from previous value */
function isValidRate(pegKey: string, rate: number, prevRate: number | undefined): boolean {
  const bounds = FX_RATE_BOUNDS[pegKey];
  if (bounds && (rate < bounds[0] || rate > bounds[1])) {
    console.warn(`[sync-fx-rates] Rejected ${pegKey}=${rate}: outside bounds [${bounds[0]}, ${bounds[1]}]`);
    return false;
  }
  if (prevRate != null && prevRate > 0) {
    const delta = Math.abs(rate - prevRate) / prevRate;
    if (delta > MAX_DELTA_PCT) {
      console.warn(`[sync-fx-rates] Rejected ${pegKey}=${rate}: ${(delta * 100).toFixed(1)}% change from prev ${prevRate}`);
      return false;
    }
  }
  return true;
}


interface FrankfurterResponse {
  base: string;
  date: string;
  rates: Record<string, number>;
}

export async function syncFxRates(db: D1Database): Promise<void> {
  try {
    // Load previous rates for delta validation
    let prevRates: Record<string, number> = {};
    const prevCache = await getCache(db, "fx-rates");
    if (prevCache) {
      try { prevRates = JSON.parse(prevCache.value) as Record<string, number>; } catch { /* ignore */ }
    }

    const url = `https://api.frankfurter.app/latest?from=USD&to=${CURRENCIES.join(",")}`;
    const res = await fetchWithRetry(url, {
      headers: { "User-Agent": USER_AGENT },
    });

    if (!res || !res.ok) {
      console.error(`[sync-fx-rates] frankfurter.app returned ${res?.status ?? "no response"}`);
      return;
    }

    const data: FrankfurterResponse = await res.json();

    // frankfurter returns units-per-USD (e.g. EUR: 0.93 means 1 USD = 0.93 EUR)
    // We need USD-per-unit (e.g. 1 EUR = $1.08 USD), so take the reciprocal
    const rates: Record<string, number> = {};
    for (const [currency, unitsPerUsd] of Object.entries(data.rates)) {
      const pegKey = CURRENCY_TO_PEG[currency];
      if (pegKey && unitsPerUsd > 0) {
        const rate = Number((1 / unitsPerUsd).toFixed(6));
        if (isValidRate(pegKey, rate, prevRates[pegKey])) {
          rates[pegKey] = rate;
        } else if (prevRates[pegKey]) {
          rates[pegKey] = prevRates[pegKey]; // fall back to previous cached value
        }
      }
    }

    // Secondary: fetch RUB from exchangerate-api.com (ECB doesn't publish RUB)
    try {
      const rubRes = await fetchWithRetry("https://open.er-api.com/v6/latest/USD", {
        headers: { "User-Agent": USER_AGENT },
      });
      if (rubRes && rubRes.ok) {
        const rubData = (await rubRes.json()) as { rates?: Record<string, number> };
        const rubPerUsd = rubData?.rates?.RUB;
        if (typeof rubPerUsd === "number" && rubPerUsd > 0) {
          const rubRate = Number((1 / rubPerUsd).toFixed(6));
          if (isValidRate("peggedRUB", rubRate, prevRates["peggedRUB"])) {
            rates["peggedRUB"] = rubRate;
          } else if (prevRates["peggedRUB"]) {
            rates["peggedRUB"] = prevRates["peggedRUB"];
          }
        }
      }
    } catch {
      // Fall through to hardcoded fallback
    }

    // Fallback: RUB if secondary API also failed — use last-cached rate from D1, else hardcoded constant
    if (!rates["peggedRUB"]) {
      const cached = await getCache(db, "fx-rates");
      if (cached) {
        try {
          const prev = JSON.parse(cached.value) as Record<string, number>;
          if (typeof prev["peggedRUB"] === "number" && prev["peggedRUB"] > 0) {
            rates["peggedRUB"] = prev["peggedRUB"];
            console.log(`[sync-fx-rates] Using cached RUB rate: ${rates["peggedRUB"]}`);
          }
        } catch { /* ignore parse errors */ }
      }
      if (!rates["peggedRUB"]) {
        rates["peggedRUB"] = RUB_FALLBACK;
        console.log(`[sync-fx-rates] Using hardcoded RUB fallback: ${RUB_FALLBACK}`);
      }
    }

    // Silver spot price (USD per troy ounce) from DefiLlama coins API
    // Used as FX fallback for peggedSILVER thin-group validation
    try {
      const silverRes = await fetchWithRetry("https://coins.llama.fi/prices/current/coingecko:silver", {
        headers: { "User-Agent": USER_AGENT },
      });
      if (silverRes && silverRes.ok) {
        const silverData = (await silverRes.json()) as { coins?: Record<string, { price?: number }> };
        const silverPrice = silverData?.coins?.["coingecko:silver"]?.price;
        if (typeof silverPrice === "number" && silverPrice > 0) {
          if (isValidRate("peggedSILVER", silverPrice, prevRates["peggedSILVER"])) {
            rates["peggedSILVER"] = silverPrice;
          } else if (prevRates["peggedSILVER"]) {
            rates["peggedSILVER"] = prevRates["peggedSILVER"];
          }
        }
      }
    } catch {
      // Silver spot fetch failed — peg-rates will rely on median only
    }

    // Gold spot price (USD per troy ounce) from DefiLlama coins API
    // Used as FX fallback for peggedGOLD — commodity spot is the definitive reference
    try {
      const goldRes = await fetchWithRetry("https://coins.llama.fi/prices/current/coingecko:gold", {
        headers: { "User-Agent": USER_AGENT },
      });
      if (goldRes && goldRes.ok) {
        const goldData = (await goldRes.json()) as { coins?: Record<string, { price?: number }> };
        const goldPrice = goldData?.coins?.["coingecko:gold"]?.price;
        if (typeof goldPrice === "number" && goldPrice > 0) {
          if (isValidRate("peggedGOLD", goldPrice, prevRates["peggedGOLD"])) {
            rates["peggedGOLD"] = goldPrice;
          } else if (prevRates["peggedGOLD"]) {
            rates["peggedGOLD"] = prevRates["peggedGOLD"];
          }
        }
      }
    } catch {
      // Gold spot fetch failed — peg-rates will rely on median only
    }

    // Sanity check: we should have rates for all mapped currencies
    const expected = Object.values(CURRENCY_TO_PEG);
    const missing = expected.filter((k) => !(k in rates));
    if (missing.length > 0) {
      console.warn(`[sync-fx-rates] Missing rates for: ${missing.join(", ")}`);
    }

    await setCache(db, "fx-rates", JSON.stringify(rates));
    console.log(`[sync-fx-rates] Cached FX rates: ${JSON.stringify(rates)}`);
  } catch (err) {
    console.error(`[sync-fx-rates] Failed:`, err);
  }
}
