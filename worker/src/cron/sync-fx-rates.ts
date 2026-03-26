import type { CronResult } from "../lib/cron-logger";
import { fetchWithRetry } from "../lib/fetch-retry";
import { validatePayloadWithSchema } from "../lib/api-utils";
import { RUB_FALLBACK, USER_AGENT, CIRCUIT_SOURCE } from "../lib/constants";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import type { ChainRpcConfig } from "../lib/chain-registry";
import { loadFxRateState, persistFxRateState } from "../lib/fx-rate-state";
import { loadCommodityPeerMedianReference, resolveMetalReferenceRates } from "../lib/fx-metals";
import {
  FxSyncRunState,
  runChainlinkOverlay,
  runOpenExchangeRatesOverlay,
  type ExchangeRateApiPayload,
  type SecondaryCurrencyCandidate,
  type SecondaryCurrencyEndpoint,
} from "./sync-fx-rates-helpers";
import { z } from "zod";

/**
 * Fetches live FX rates from the European Central Bank (via api.frankfurter.dev)
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

const EXPECTED_FX_PEG_KEYS = [...Object.values(CURRENCY_TO_PEG), ...Object.values(SECONDARY_CURRENCY_TO_PEG)];

const SECONDARY_FX_PRIMARY_URL = "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json";
const SECONDARY_FX_FALLBACK_URL = "https://latest.currency-api.pages.dev/v1/currencies/usd.min.json";
const TERTIARY_FX_URL = "https://open.er-api.com/v6/latest/USD";

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
  date: z.string().optional(),
  usd: z.record(z.string(), z.number()),
});

const ExchangeRateApiResponseSchema = z.object({
  result: z.string().optional(),
  time_last_update_unix: z.number().optional(),
  time_last_update_utc: z.string().optional(),
  rates: z.record(z.string(), z.number()),
});

function rankIsoDate(dateText: string | null | undefined): number {
  if (!dateText) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(`${dateText}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

async function fetchSecondaryCurrencyCandidate(
  endpoint: SecondaryCurrencyEndpoint,
  url: string,
  signal?: AbortSignal,
): Promise<SecondaryCurrencyCandidate | null> {
  const res = await fetchWithRetry(url, {
    headers: { "User-Agent": USER_AGENT },
    signal,
  });
  if (!res || !res.ok) {
    return null;
  }

  const payload = await res.json();
  const validation = validatePayloadWithSchema(
    SecondaryCurrencyResponseSchema,
    payload,
    `sync-fx-rates:secondary:${endpoint}`,
  );
  if (!validation.ok) {
    console.warn(`[sync-fx-rates] Secondary FX payload invalid (${endpoint}): ${validation.issues}`);
    return null;
  }

  return {
    endpoint,
    payload: validation.data,
  };
}

function chooseSecondaryCurrencyCandidate(
  primary: SecondaryCurrencyCandidate | null,
  fallback: SecondaryCurrencyCandidate | null,
): SecondaryCurrencyCandidate | null {
  if (!primary) return fallback;
  if (!fallback) return primary;

  return rankIsoDate(fallback.payload.date) > rankIsoDate(primary.payload.date)
    ? fallback
    : primary;
}

async function loadSecondaryCurrencyCandidate(signal?: AbortSignal): Promise<SecondaryCurrencyCandidate | null> {
  const primaryCandidate = await fetchSecondaryCurrencyCandidate(
    "jsdelivr",
    SECONDARY_FX_PRIMARY_URL,
    signal,
  );
  const fallbackCandidate = await fetchSecondaryCurrencyCandidate(
    "pages.dev",
    SECONDARY_FX_FALLBACK_URL,
    signal,
  );

  const secondaryCandidate = chooseSecondaryCurrencyCandidate(primaryCandidate, fallbackCandidate);
  if (
    primaryCandidate &&
    fallbackCandidate &&
    secondaryCandidate &&
    secondaryCandidate.endpoint !== primaryCandidate.endpoint
  ) {
    console.log(
      `[sync-fx-rates] Using fresher secondary FX mirror (${secondaryCandidate.endpoint} date=${secondaryCandidate.payload.date ?? "unknown"}, ` +
        `jsdelivr=${primaryCandidate.payload.date ?? "unknown"})`,
    );
  }

  return secondaryCandidate;
}

async function loadExchangeRateApiPayload(signal?: AbortSignal): Promise<ExchangeRateApiPayload | null> {
  const res = await fetchWithRetry(TERTIARY_FX_URL, {
    headers: { "User-Agent": USER_AGENT },
    signal,
  });
  if (!res || !res.ok) {
    return null;
  }

  const payload = await res.json();
  const validation = validatePayloadWithSchema(
    ExchangeRateApiResponseSchema,
    payload,
    "sync-fx-rates:exchange-rate-api",
  );
  if (!validation.ok) {
    console.warn(`[sync-fx-rates] ExchangeRate-API payload invalid: ${validation.issues}`);
    return null;
  }
  if (validation.data.result && validation.data.result !== "success") {
    console.warn(`[sync-fx-rates] ExchangeRate-API returned result=${validation.data.result}`);
    return null;
  }
  return validation.data;
}

export async function syncFxRates(
  db: D1Database,
  signal?: AbortSignal,
  openExchangeRatesKey?: string,
  chainRpcs?: Map<string, ChainRpcConfig>,
  drpcApiKey?: string | null, etherscanApiKey?: string | null,
): Promise<CronResult> {
  const syncStartSec = Math.floor(Date.now() / 1000);
  const runBestEffort = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      console.warn(`[sync-fx-rates] Best-effort step failed (${label}):`, err);
    }
  };

  try {
    const prevState = await loadFxRateState(db);
    const primaryMappings = Object.entries(CURRENCY_TO_PEG);
    const secondaryMappings = Object.entries(SECONDARY_CURRENCY_TO_PEG);
    const syncState = new FxSyncRunState({
      prevState,
      syncStartSec,
      expectedPegKeys: EXPECTED_FX_PEG_KEYS,
      initialSources: {
        frankfurter: "ok",
        fawazahmed0: "fallback",
        exchangeRateApi: "unavailable",
        "gold-api.com": "error",
        "commodity-peer-median": "unavailable",
        chainlink: "unavailable",
        openExchangeRates: "unavailable",
      },
      validateRate: isValidRate,
    });
    const commodityPeerMedian = await loadCommodityPeerMedianReference(db, syncStartSec);

    const frankfurterAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.FX_FRANKFURTER);
    const url = `https://api.frankfurter.dev/v1/latest?base=USD&symbols=${CURRENCIES.join(",")}`;
    const res = frankfurterAllowed
      ? await fetchWithRetry(url, {
          headers: { "User-Agent": USER_AGENT },
          signal,
        })
      : null;

    if (!res || !res.ok) {
      if (frankfurterAllowed) {
        await runBestEffort("recordOutcome:fx-frankfurter-failure", async () => {
          await recordOutcome(db, CIRCUIT_SOURCE.FX_FRANKFURTER, false);
        });
      }
      const cachedRateCount = Object.keys(syncState.prevRates).length;
      const appliedLiveFallback = await syncState.tryLiveFullSetFallback("error", {
        loadSecondaryCurrencyCandidate: () => loadSecondaryCurrencyCandidate(signal),
        loadExchangeRateApiPayload: () => loadExchangeRateApiPayload(signal),
        primaryMappings,
        secondaryMappings,
      });
      if (!appliedLiveFallback && cachedRateCount > 0) {
        console.warn(
          `[sync-fx-rates] Frankfurter API unavailable (${res?.status ?? "no response"}), using ${cachedRateCount} cached rates`,
        );
        syncState.seedCachedFallbackFromPrevious();
        syncState.mode = "cached-fallback";
        syncState.fallbackMode = "cached-fx-rates";
        syncState.sources = {
          ...syncState.sources,
          frankfurter: "error",
          cache: "ok",
        };
      }
      if (syncState.mode !== "cached-fallback" && Object.keys(syncState.usableRates).length === 0) {
        throw new Error(`Frankfurter API returned ${res?.status ?? "no response"}`);
      }
    }
    if (syncState.mode !== "cached-fallback") {
      if (res?.ok) {
        const frankfurterPayload = await res.json();
        const frankfurterValidation = validatePayloadWithSchema(
          FrankfurterResponseSchema,
          frankfurterPayload,
          "sync-fx-rates:frankfurter",
        );
        if (!frankfurterValidation.ok) {
          const cachedRateCount = Object.keys(syncState.prevRates).length;
          syncState.validationIssues = frankfurterValidation.issues;
          const appliedLiveFallback = await syncState.tryLiveFullSetFallback("invalid-payload", {
            loadSecondaryCurrencyCandidate: () => loadSecondaryCurrencyCandidate(signal),
            loadExchangeRateApiPayload: () => loadExchangeRateApiPayload(signal),
            primaryMappings,
            secondaryMappings,
          });
          if (appliedLiveFallback) {
            console.warn("[sync-fx-rates] Invalid Frankfurter payload, using live FX fallback");
          } else if (cachedRateCount > 0) {
            console.warn(`[sync-fx-rates] Invalid frankfurter payload, using ${cachedRateCount} cached rates`);
            syncState.seedCachedFallbackFromPrevious();
            syncState.mode = "cached-fallback";
            syncState.fallbackMode = "cached-fx-rates";
            syncState.sources = {
              ...syncState.sources,
              frankfurter: "invalid-payload",
              cache: "ok",
            };
          } else {
            throw new Error(`Frankfurter API payload validation failed: ${frankfurterValidation.issues}`);
          }
        } else {
          await runBestEffort("recordOutcome:fx-frankfurter-success", async () => {
            await recordOutcome(db, CIRCUIT_SOURCE.FX_FRANKFURTER, true);
          });
          const data = frankfurterValidation.data;
          syncState.applyFrankfurterRates(data.rates, data.date, CURRENCY_TO_PEG);

          try {
            const secondaryCandidate = await loadSecondaryCurrencyCandidate(signal);
            if (secondaryCandidate) {
              syncState.applySecondaryRates(secondaryCandidate, secondaryMappings);
              syncState.sources.fawazahmed0 = Object.values(SECONDARY_CURRENCY_TO_PEG).every(
                (pegKey) => pegKey in syncState.usableRates,
              )
                ? "ok"
                : "partial";
            }
          } catch (e) {
            console.warn("[sync-fx-rates] Secondary FX API (CNH/RUB/UAH/ARS) failed:", e);
          }
        }
      }
    }

    syncState.sources.openExchangeRates = await runOpenExchangeRatesOverlay(
      db,
      syncState,
      openExchangeRatesKey,
      signal,
      runBestEffort,
    );

    syncState.ensureCachedOrHardcodedRate("peggedRUB", "RUB", RUB_FALLBACK);
    if (!("peggedCNH" in syncState.usableRates)) {
      syncState.ensureCachedRate("peggedCNH", "CNH");
    }

    const metals = await resolveMetalReferenceRates({
      prevRates: syncState.prevRates,
      commodityPeerMedian,
      syncStartSec,
      signal,
      validateRate: isValidRate,
    });
    syncState.applyResolvedMetals(metals);
    syncState.sources["gold-api.com"] = metals.sources["gold-api.com"];
    syncState.sources["commodity-peer-median"] = metals.sources["commodity-peer-median"];
    syncState.sources.chainlink = await runChainlinkOverlay(
      db,
      syncState,
      signal,
      chainRpcs,
      drpcApiKey,
      etherscanApiKey,
      runBestEffort,
    );
    syncState.maybeRecoverFromCachedFallback();

    const missing = syncState.getMissingPegKeys();
    if (Object.keys(syncState.usableRates).length === 0) {
      throw new Error("sync-fx-rates produced zero usable rates");
    }
    if (missing.length > 0) {
      console.warn(`[sync-fx-rates] Missing rates for: ${missing.join(", ")}`);
    }

    const meta = syncState.buildPersistedMeta();
    await persistFxRateState(db, syncState.usableRates, meta, syncStartSec);
    console.log(`[sync-fx-rates] Cached FX rates: ${JSON.stringify(syncState.usableRates)}`);
    const metadata = syncState.buildResultMetadata(Object.values(SECONDARY_CURRENCY_TO_PEG));
    return {
      status: syncState.mode === "cached-fallback" && meta.consecutiveFallbackRuns >= 4 ? "degraded" : undefined,
      itemCount: Object.keys(syncState.usableRates).length,
      metadata: JSON.stringify(metadata),
    };
  } catch (err) {
    console.error(`[sync-fx-rates] Failed:`, err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}
