import { getCache, setCacheIfNewer } from "../lib/db-cache";
import type { CronResult } from "../lib/cron-logger";
import { fetchWithRetry } from "../lib/fetch-retry";
import { validatePayloadWithSchema } from "../lib/api-utils";
import { RUB_FALLBACK, USER_AGENT, CIRCUIT_SOURCE } from "../lib/constants";
import { fetchRealtimeFxRates } from "../lib/fx-realtime";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { fetchChainlinkReferenceQuotes } from "../lib/chainlink-feeds";
import type { ChainRpcConfig } from "../lib/chain-registry";
import { z } from "zod";

/**
 * Fetches live FX rates from the European Central Bank (via frankfurter.app)
 * and stores them in D1 cache as fallback rates for thin peg groups.
 *
 * Format matches FALLBACK_RATES in peg-rates.ts: { peggedEUR: 1.08, ... }
 * where the value is "USD per 1 unit of the currency".
 *
 * CNH, RUB, UAH, and ARS are sourced from a secondary currency API because
 * Frankfurter/ECB does not publish them all directly.
 * Supported Chainlink feeds overlay the reference cache for a curated subset
 * of fiat and commodity pegs when the on-chain quotes are fresh and plausible.
 * Runs every 15 minutes.
 */

const CURRENCIES = ["EUR", "GBP", "CHF", "BRL", "JPY", "IDR", "SGD", "TRY", "AUD", "ZAR", "CAD", "CNY", "PHP", "MXN"] as const;

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
  CAD: "peggedCAD",
  CNY: "peggedCNY",
  PHP: "peggedPHP",
  MXN: "peggedMXN",
};

const SECONDARY_CURRENCY_TO_PEG = {
  cnh: "peggedCNH",
  rub: "peggedRUB",
  uah: "peggedUAH",
  ars: "peggedARS",
} as const;

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
  peggedCAD: [0.40, 1.50],     // CAD ~$0.73
  peggedCNY: [0.05, 0.40],     // CNY ~$0.14
  peggedCNH: [0.05, 0.40],     // CNH ~$0.14
  peggedPHP: [0.01, 0.06],     // PHP ~$0.018
  peggedMXN: [0.02, 0.15],     // MXN ~$0.058
  peggedUAH: [0.01, 0.10],     // UAH ~$0.024
  peggedARS: [0.0001, 0.01],   // ARS ~$0.0007
  peggedSILVER: [5, 500],      // Silver ~$30/oz
  peggedGOLD: [500, 10000],     // Gold ~$2900/oz
};

/** Max allowed change from previous cached value (no FX rate moves 20% in 15 minutes) */
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


const FrankfurterResponseSchema = z.object({
  base: z.string(),
  date: z.string(),
  rates: z.record(z.string(), z.number()),
});

const SecondaryCurrencyResponseSchema = z.object({
  usd: z.record(z.string(), z.number()),
});

const MetalPriceSchema = z.object({
  price: z.number(),
});

export async function syncFxRates(
  db: D1Database,
  signal?: AbortSignal,
  openExchangeRatesKey?: string,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<CronResult> {
  const syncStartSec = Math.floor(Date.now() / 1000);
  try {
    // Load previous rates for delta validation
    let prevRates: Record<string, number> = {};
    const prevCache = await getCache(db, "fx-rates");
    if (prevCache) {
      try { prevRates = JSON.parse(prevCache.value) as Record<string, number>; } catch { /* expected: corrupted cache — proceed with empty prev rates */ }
    }

    const url = `https://api.frankfurter.app/latest?from=USD&to=${CURRENCIES.join(",")}`;
    const res = await fetchWithRetry(url, {
      headers: { "User-Agent": USER_AGENT },
      signal,
    });

    if (!res || !res.ok) {
      const cachedRateCount = Object.keys(prevRates).length;
      if (cachedRateCount > 0) {
        console.warn(
          `[sync-fx-rates] frankfurter.app unavailable (${res?.status ?? "no response"}), using ${cachedRateCount} cached rates`,
        );
        return {
          itemCount: cachedRateCount,
          metadata: JSON.stringify({
            rateCount: cachedRateCount,
            fallbackMode: "cached-fx-rates",
            sources: {
              frankfurter: "error",
              cache: "ok",
            },
          }),
        };
      }
      throw new Error(`frankfurter.app returned ${res?.status ?? "no response"}`);
    }

    const frankfurterPayload = await res.json();
    const frankfurterValidation = validatePayloadWithSchema(
      FrankfurterResponseSchema,
      frankfurterPayload,
      "sync-fx-rates:frankfurter",
    );
    if (!frankfurterValidation.ok) {
      const cachedRateCount = Object.keys(prevRates).length;
      if (cachedRateCount > 0) {
        console.warn(`[sync-fx-rates] Invalid frankfurter payload, using ${cachedRateCount} cached rates`);
        return {
          itemCount: cachedRateCount,
          status: "degraded",
          metadata: JSON.stringify({
            rateCount: cachedRateCount,
            fallbackMode: "cached-fx-rates",
            validationIssues: frankfurterValidation.issues,
            sources: {
              frankfurter: "invalid-payload",
              cache: "ok",
            },
          }),
        };
      }
      throw new Error(`frankfurter.app payload validation failed: ${frankfurterValidation.issues}`);
    }
    const data = frankfurterValidation.data;

    // Warn if ECB date is stale (>24h old — weekends, holidays)
    const ecbDate = new Date(data.date + "T16:00:00Z");
    const ecbAgeSec = (Date.now() - ecbDate.getTime()) / 1000;
    if (ecbAgeSec > 86400) {
      console.warn(
        `[sync-fx-rates] ECB rates are ${Math.round(ecbAgeSec / 3600)}h stale (date=${data.date}). ` +
        `Weekend/holiday — non-USD pegs using last published rates.`,
      );
    }

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

    // Secondary: fetch CNH, RUB, UAH, and ARS from fawazahmed0/exchange-api
    // for currencies not reliably covered by Frankfurter/ECB.
    // CDN-backed, no rate limit. Response shape: { date: "...", usd: { rub: 76.5, ... } }
    try {
      const PRIMARY_URL = "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json";
      const FALLBACK_URL = "https://latest.currency-api.pages.dev/v1/currencies/usd.min.json";
      let erRes = await fetchWithRetry(PRIMARY_URL, {
        headers: { "User-Agent": USER_AGENT },
        signal,
      });
      if (!erRes || !erRes.ok) {
        erRes = await fetchWithRetry(FALLBACK_URL, {
          headers: { "User-Agent": USER_AGENT },
          signal,
        });
      }
      if (erRes && erRes.ok) {
        const secondaryPayload = await erRes.json();
        const secondaryValidation = validatePayloadWithSchema(
          SecondaryCurrencyResponseSchema,
          secondaryPayload,
          "sync-fx-rates:secondary",
        );
        if (!secondaryValidation.ok) {
          console.warn(`[sync-fx-rates] Secondary FX payload invalid: ${secondaryValidation.issues}`);
        } else {
          const erData = secondaryValidation.data;
          for (const [currency, pegKey] of Object.entries(SECONDARY_CURRENCY_TO_PEG)) {
            const perUsd = erData.usd?.[currency];
            if (typeof perUsd === "number" && perUsd > 0) {
              const rate = Number((1 / perUsd).toFixed(6));
              if (isValidRate(pegKey, rate, prevRates[pegKey])) {
                rates[pegKey] = rate;
              } else if (prevRates[pegKey]) {
                rates[pegKey] = prevRates[pegKey];
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn("[sync-fx-rates] Secondary FX API (CNH/RUB/UAH/ARS) failed:", e);
      // Fall through to hardcoded fallback for RUB
    }

    // Real-time FX cross-validation (P0) — rate limited to 1/hour for free tier
    let oxrSource: "ok" | "partial" | "rate-limited" | "unavailable" = "unavailable";
    if (openExchangeRatesKey) {
      const OXR_CACHE_KEY = "fx-oxr-last-fetch";
      const lastFetch = await db.prepare("SELECT value FROM cache WHERE key = ?").bind(OXR_CACHE_KEY).first<{ value: string }>();
      const lastFetchTime = lastFetch ? parseInt(lastFetch.value, 10) : 0;
      const elapsedMinutes = (Math.floor(Date.now() / 1000) - lastFetchTime) / 60;

      if (elapsedMinutes >= 55) {
        try {
          const realtimeRates = await fetchRealtimeFxRates(openExchangeRatesKey, signal);
          if (realtimeRates.size > 0) {
            await db.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
              .bind(OXR_CACHE_KEY, String(Math.floor(Date.now() / 1000)), Math.floor(Date.now() / 1000)).run();
          }
          let realtimeApplied = 0;
          for (const [pegKey, realtimeRate] of realtimeRates) {
            const frankfurterRate = rates[pegKey];
            if (frankfurterRate != null) {
              const delta = Math.abs(realtimeRate - frankfurterRate) / frankfurterRate;
              if (delta <= 0.05) {
                if (isValidRate(pegKey, realtimeRate, prevRates[pegKey])) {
                  rates[pegKey] = realtimeRate;
                  realtimeApplied++;
                }
              } else {
                console.warn(`[sync-fx-rates] ${pegKey} diverges: frankfurter=${frankfurterRate}, realtime=${realtimeRate} (${(delta * 100).toFixed(1)}%)`);
              }
            } else {
              if (isValidRate(pegKey, realtimeRate, prevRates[pegKey])) {
                rates[pegKey] = realtimeRate;
                realtimeApplied++;
              }
            }
          }
          console.log(`[sync-fx-rates] Applied ${realtimeApplied}/${realtimeRates.size} real-time FX rates`);
          oxrSource = realtimeRates.size > 0 ? (realtimeApplied === realtimeRates.size ? "ok" : "partial") : "unavailable";
          await recordOutcome(db, CIRCUIT_SOURCE.FX_REALTIME, realtimeRates.size > 0);
        } catch (err) {
          if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
          console.warn("[sync-fx-rates] OXR real-time fetch failed:", err);
          await recordOutcome(db, CIRCUIT_SOURCE.FX_REALTIME, false);
          oxrSource = "unavailable";
        }
      } else {
        console.log(`[sync-fx-rates] Skipping OXR fetch (last fetch ${Math.round(elapsedMinutes)}min ago, rate limit: 55min)`);
        oxrSource = "rate-limited";
      }
    }

    // Fallback: RUB if secondary API also failed — use last-cached rate from D1, else hardcoded constant
    if (!rates["peggedRUB"]) {
      if (typeof prevRates["peggedRUB"] === "number" && prevRates["peggedRUB"] > 0) {
        rates["peggedRUB"] = prevRates["peggedRUB"];
        console.log(`[sync-fx-rates] Using cached RUB rate: ${rates["peggedRUB"]}`);
      }
      if (!rates["peggedRUB"]) {
        rates["peggedRUB"] = RUB_FALLBACK;
        console.log(`[sync-fx-rates] Using hardcoded RUB fallback: ${RUB_FALLBACK}`);
      }
    }

    if (!rates["peggedCNH"] && typeof prevRates["peggedCNH"] === "number" && prevRates["peggedCNH"] > 0) {
      rates["peggedCNH"] = prevRates["peggedCNH"];
      console.log(`[sync-fx-rates] Using cached CNH rate: ${rates["peggedCNH"]}`);
    }

    // Gold & silver spot prices (USD per troy ounce) from gold-api.com
    // No API key required, no rate limit — fetch every sync run (every 15min).
    let metalsSource: "gold-api.com" | "cached" = "cached";
    try {
      const [goldRes, silverRes] = await Promise.all([
        fetchWithRetry("https://api.gold-api.com/price/XAU", { headers: { "User-Agent": USER_AGENT }, signal }),
        fetchWithRetry("https://api.gold-api.com/price/XAG", { headers: { "User-Agent": USER_AGENT }, signal }),
      ]);
      const goldPayload = goldRes?.ok ? await goldRes.json() : null;
      const silverPayload = silverRes?.ok ? await silverRes.json() : null;
      const goldValidation = goldPayload == null
        ? { ok: false as const, issues: "missing gold payload" }
        : validatePayloadWithSchema(MetalPriceSchema, goldPayload, "sync-fx-rates:gold");
      const silverValidation = silverPayload == null
        ? { ok: false as const, issues: "missing silver payload" }
        : validatePayloadWithSchema(MetalPriceSchema, silverPayload, "sync-fx-rates:silver");
      const goldPrice = goldValidation.ok ? goldValidation.data.price : undefined;
      const silverPrice = silverValidation.ok ? silverValidation.data.price : undefined;

      if (typeof goldPrice === "number" && goldPrice > 0) {
        if (isValidRate("peggedGOLD", goldPrice, prevRates["peggedGOLD"])) {
          rates["peggedGOLD"] = goldPrice;
          metalsSource = "gold-api.com";
        } else if (prevRates["peggedGOLD"]) {
          rates["peggedGOLD"] = prevRates["peggedGOLD"];
        }
      } else if (prevRates["peggedGOLD"]) {
        rates["peggedGOLD"] = prevRates["peggedGOLD"];
      }

      if (typeof silverPrice === "number" && silverPrice > 0) {
        if (isValidRate("peggedSILVER", silverPrice, prevRates["peggedSILVER"])) {
          rates["peggedSILVER"] = silverPrice;
        } else if (prevRates["peggedSILVER"]) {
          rates["peggedSILVER"] = prevRates["peggedSILVER"];
        }
      } else if (prevRates["peggedSILVER"]) {
        rates["peggedSILVER"] = prevRates["peggedSILVER"];
      }
    } catch (e) {
      console.warn("[sync-fx-rates] Gold/silver API failed, using cached values:", e);
      // fetch failed — fall back to previously cached values
      if (prevRates["peggedGOLD"]) rates["peggedGOLD"] = prevRates["peggedGOLD"];
      if (prevRates["peggedSILVER"]) rates["peggedSILVER"] = prevRates["peggedSILVER"];
    }

    let chainlinkSource: "ok" | "partial" | "unavailable" = "unavailable";
    const chainlinkAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.CHAINLINK_FEEDS);
    if (chainlinkAllowed) {
      try {
        const quotes = await fetchChainlinkReferenceQuotes(signal, chainRpcs, syncStartSec);
        let applied = 0;
        for (const [pegKey, quote] of quotes) {
          const existing = rates[pegKey];
          if (existing != null && existing > 0) {
            const delta = Math.abs(quote.price - existing) / existing;
            if (delta > 0.05) {
              console.warn(
                `[sync-fx-rates] Chainlink ${pegKey} diverges from current reference: ` +
                `current=${existing}, chainlink=${quote.price} (${(delta * 100).toFixed(1)}%)`,
              );
              continue;
            }
          }

          const normalized = Number(quote.price.toFixed(6));
          if (isValidRate(pegKey, normalized, prevRates[pegKey])) {
            rates[pegKey] = normalized;
            applied++;
          } else if (prevRates[pegKey]) {
            rates[pegKey] = prevRates[pegKey];
          }
        }

        chainlinkSource = quotes.size > 0
          ? (applied === quotes.size ? "ok" : "partial")
          : "unavailable";
        await recordOutcome(db, CIRCUIT_SOURCE.CHAINLINK_FEEDS, quotes.size > 0);
      } catch (err) {
        if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
        console.warn("[sync-fx-rates] Chainlink reference feeds failed:", err);
        await recordOutcome(db, CIRCUIT_SOURCE.CHAINLINK_FEEDS, false);
      }
    } else {
      console.warn("[sync-fx-rates] Chainlink reference-feed circuit open — skipping overlay");
    }

    // Sanity check: we should have rates for all mapped currencies
    const expected = [...Object.values(CURRENCY_TO_PEG), ...Object.values(SECONDARY_CURRENCY_TO_PEG)];
    const missing = expected.filter((k) => !(k in rates));
    if (Object.keys(rates).length === 0) {
      throw new Error("sync-fx-rates produced zero usable rates");
    }
    if (missing.length > 0) {
      console.warn(`[sync-fx-rates] Missing rates for: ${missing.join(", ")}`);
    }

    await setCacheIfNewer(db, "fx-rates", JSON.stringify(rates), syncStartSec);
    console.log(`[sync-fx-rates] Cached FX rates: ${JSON.stringify(rates)}`);

    const metadata = {
      rateCount: Object.keys(rates).length,
      missing: missing.length > 0 ? missing : undefined,
      secondaryCoverage: Object.values(SECONDARY_CURRENCY_TO_PEG).filter((pegKey) => pegKey in rates).length,
      sources: {
        frankfurter: "ok",
        fawazahmed0: Object.values(SECONDARY_CURRENCY_TO_PEG).every((pegKey) => pegKey in rates)
          ? "ok"
          : rates["peggedRUB"] !== RUB_FALLBACK
            ? "partial"
            : "fallback",
        "gold-api.com": metalsSource,
        chainlink: chainlinkSource,
        openExchangeRates: oxrSource,
      },
    };
    return { itemCount: Object.keys(rates).length, metadata: JSON.stringify(metadata) };
  } catch (err) {
    console.error(`[sync-fx-rates] Failed:`, err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}
