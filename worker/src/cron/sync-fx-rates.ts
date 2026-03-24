import type { CronResult } from "../lib/cron-logger";
import { fetchWithRetry } from "../lib/fetch-retry";
import { validatePayloadWithSchema } from "../lib/api-utils";
import { RUB_FALLBACK, USER_AGENT, CIRCUIT_SOURCE } from "../lib/constants";
import { fetchRealtimeFxRates } from "../lib/fx-realtime";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { fetchChainlinkReferenceQuoteSnapshot } from "../lib/chainlink-feeds";
import type { ChainRpcConfig } from "../lib/chain-registry";
import type { FxRateSourceMode, FxRateSyncMode, FxSourceCadence } from "../lib/fx-rate-state";
import { getFxSourceStatus, loadFxRateState, persistFxRateState } from "../lib/fx-rate-state";
import { loadCommodityPeerMedianReference, resolveMetalReferenceRates } from "../lib/fx-metals";
import {
  applyRealtimeOverlaySourceMetadata,
  canCarryForwardFxRates,
  inheritFxSourceMetadata,
} from "../lib/fx-source-metadata";
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

type SecondaryCurrencyPayload = z.infer<typeof SecondaryCurrencyResponseSchema>;
type SecondaryCurrencyEndpoint = "jsdelivr" | "pages.dev";

interface SecondaryCurrencyCandidate {
  endpoint: SecondaryCurrencyEndpoint;
  payload: SecondaryCurrencyPayload;
}

type SecondaryFxMappings = ReadonlyArray<readonly [string, string]>;

const ExchangeRateApiResponseSchema = z.object({
  result: z.string().optional(),
  time_last_update_unix: z.number().optional(),
  time_last_update_utc: z.string().optional(),
  rates: z.record(z.string(), z.number()),
});

type ExchangeRateApiPayload = z.infer<typeof ExchangeRateApiResponseSchema>;

function resolveDatedSourceUpdatedAt(
  dateText: string | null | undefined,
  syncStartSec: number,
  publishedHourUtc?: number,
): number {
  if (!dateText) return syncStartSec;
  const timeSuffix = publishedHourUtc == null
    ? "T23:59:59Z"
    : `T${String(publishedHourUtc).padStart(2, "0")}:00:00Z`;
  const parsed = Date.parse(`${dateText}${timeSuffix}`);
  if (!Number.isFinite(parsed)) return syncStartSec;
  return Math.min(syncStartSec, Math.floor(parsed / 1000));
}

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
    const prevRates = prevState?.rates ?? {};
    const commodityPeerMedian = await loadCommodityPeerMedianReference(db, syncStartSec);
    const sourceUpdatedAtByPeg: Record<string, number | null> = {};
    const sourceModeByPeg: Record<string, FxRateSourceMode> = {};
    const sourceCadenceByPeg: Record<string, FxSourceCadence> = {};
    const sourceDateByPeg: Record<string, string | null> = {};
    let usableRates: Record<string, number> = {};
    let mode: FxRateSyncMode = "live";
    let ecbDate: string | null = null;
    let fallbackMode: string | undefined;
    let validationIssues: string | undefined;
    let sources: Record<string, string> = {
      frankfurter: "ok",
      fawazahmed0: "fallback",
      exchangeRateApi: "unavailable",
      "gold-api.com": "error",
      "commodity-peer-median": "unavailable",
      chainlink: "unavailable",
      openExchangeRates: "unavailable",
    };

    const markLive = (
      pegKey: string,
      updatedAt: number,
      cadence: FxSourceCadence = "intraday",
      sourceDate: string | null = null,
    ) => {
      sourceUpdatedAtByPeg[pegKey] = updatedAt;
      sourceModeByPeg[pegKey] = "live";
      sourceCadenceByPeg[pegKey] = cadence;
      sourceDateByPeg[pegKey] = sourceDate;
    };
    const inheritPrevious = (pegKey: string) => inheritFxSourceMetadata(
      prevState, pegKey, sourceUpdatedAtByPeg, sourceModeByPeg, sourceCadenceByPeg, sourceDateByPeg,
    );
    const setHardcoded = (pegKey: string) => {
      sourceModeByPeg[pegKey] = "hardcoded";
      sourceUpdatedAtByPeg[pegKey] = null;
      sourceCadenceByPeg[pegKey] = "intraday";
      sourceDateByPeg[pegKey] = null;
    };
    const canCarryForwardPreviousRates = (): boolean =>
      canCarryForwardFxRates(EXPECTED_FX_PEG_KEYS, prevState, prevRates, syncStartSec);
    const hasFreshFullFxCoverage = (): boolean => EXPECTED_FX_PEG_KEYS.every((pegKey) => {
      const rate = usableRates[pegKey];
      return typeof rate === "number"
        && Number.isFinite(rate)
        && rate > 0
        && getFxSourceStatus(sourceUpdatedAtByPeg[pegKey] ?? null, sourceModeByPeg[pegKey], syncStartSec, {
          pegKey,
          cadence: sourceCadenceByPeg[pegKey],
          sourceDate: sourceDateByPeg[pegKey] ?? null,
        }) === "fresh";
    });
    const seedCachedFallbackFromPrevious = () => {
      usableRates = { ...prevRates };
      Object.keys(usableRates).forEach(inheritPrevious);
      ecbDate = prevState?.ecbDate ?? null;
    };
    const applySecondaryRates = (
      candidate: SecondaryCurrencyCandidate,
      mappings: SecondaryFxMappings,
      { includeMissingPrevious = false }: { includeMissingPrevious?: boolean } = {},
    ) => {
      const sourceDate = typeof candidate.payload.date === "string" && candidate.payload.date.length > 0
        ? candidate.payload.date
        : null;
      const secondaryUpdatedAt = sourceDate ? resolveDatedSourceUpdatedAt(sourceDate, syncStartSec) : syncStartSec;

      for (const [currency, pegKey] of mappings) {
        const perUsd = candidate.payload.usd?.[currency.toLowerCase()];
        if (typeof perUsd === "number" && perUsd > 0) {
          const rate = Number((1 / perUsd).toFixed(6));
          if (isValidRate(pegKey, rate, prevRates[pegKey])) {
            usableRates[pegKey] = rate;
            markLive(pegKey, secondaryUpdatedAt, "calendar-daily", sourceDate);
          } else if (prevRates[pegKey]) {
            usableRates[pegKey] = prevRates[pegKey];
            inheritPrevious(pegKey);
          }
        } else if (includeMissingPrevious && prevRates[pegKey]) {
          usableRates[pegKey] = prevRates[pegKey];
          inheritPrevious(pegKey);
        }
      }
    };
    const applyExchangeRateApiRates = (
      payload: ExchangeRateApiPayload,
      mappings: SecondaryFxMappings,
      { includeMissingPrevious = false }: { includeMissingPrevious?: boolean } = {},
    ) => {
      const sourceUpdatedAt =
        typeof payload.time_last_update_unix === "number" &&
        Number.isFinite(payload.time_last_update_unix) &&
        payload.time_last_update_unix > 0
          ? Math.min(syncStartSec, Math.floor(payload.time_last_update_unix))
          : syncStartSec;
      const sourceDate = new Date(sourceUpdatedAt * 1000).toISOString().slice(0, 10);

      for (const [currency, pegKey] of mappings) {
        const perUsd = payload.rates[currency.toUpperCase()];
        if (typeof perUsd === "number" && perUsd > 0) {
          const rate = Number((1 / perUsd).toFixed(6));
          if (isValidRate(pegKey, rate, prevRates[pegKey])) {
            usableRates[pegKey] = rate;
            markLive(pegKey, sourceUpdatedAt, "calendar-daily", sourceDate);
          } else if (prevRates[pegKey]) {
            usableRates[pegKey] = prevRates[pegKey];
            inheritPrevious(pegKey);
          }
        } else if (includeMissingPrevious && prevRates[pegKey]) {
          usableRates[pegKey] = prevRates[pegKey];
          inheritPrevious(pegKey);
        }
      }
    };
    const tryLiveFullSetFallback = async (
      frankfurterSource: "error" | "invalid-payload",
    ): Promise<boolean> => {
      const secondaryCandidate = await loadSecondaryCurrencyCandidate(signal);
      if (secondaryCandidate) {
        usableRates = {};
        applySecondaryRates(
          secondaryCandidate,
          Object.entries(CURRENCY_TO_PEG),
          { includeMissingPrevious: true },
        );
        applySecondaryRates(secondaryCandidate, Object.entries(SECONDARY_CURRENCY_TO_PEG));
        fallbackMode = "secondary-live-fallback";
        sources = {
          ...sources,
          frankfurter: frankfurterSource,
          fawazahmed0: EXPECTED_FX_PEG_KEYS.every((pegKey) => pegKey in usableRates)
            ? "ok"
            : "partial",
        };
        return true;
      }

      const exchangeRateApiPayload = await loadExchangeRateApiPayload(signal);
      if (exchangeRateApiPayload) {
        usableRates = {};
        applyExchangeRateApiRates(
          exchangeRateApiPayload,
          Object.entries(CURRENCY_TO_PEG),
          { includeMissingPrevious: true },
        );
        applyExchangeRateApiRates(
          exchangeRateApiPayload,
          Object.entries(SECONDARY_CURRENCY_TO_PEG),
          { includeMissingPrevious: true },
        );
        fallbackMode = "exchange-rate-api-live-fallback";
        sources = {
          ...sources,
          frankfurter: frankfurterSource,
          fawazahmed0: "error",
          exchangeRateApi: EXPECTED_FX_PEG_KEYS.every((pegKey) => pegKey in usableRates)
            ? "ok"
            : "partial",
        };
        return true;
      }

      sources = {
        ...sources,
        frankfurter: frankfurterSource,
        fawazahmed0: "error",
      };
      if (canCarryForwardPreviousRates()) {
        usableRates = { ...prevRates };
        for (const pegKey of Object.keys(usableRates)) {
          inheritPrevious(pegKey);
        }
        fallbackMode = "cadence-valid-carry-forward";
        sources = {
          ...sources,
          cache: "carry-forward",
        };
        return true;
      }
      return false;
    };

    const frankfurterAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.FX_FRANKFURTER);
    const url = `https://api.frankfurter.app/latest?from=USD&to=${CURRENCIES.join(",")}`;
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
      const cachedRateCount = Object.keys(prevRates).length;
      const appliedLiveFallback = await tryLiveFullSetFallback("error");
      if (!appliedLiveFallback && cachedRateCount > 0) {
        console.warn(
          `[sync-fx-rates] frankfurter.app unavailable (${res?.status ?? "no response"}), using ${cachedRateCount} cached rates`,
        );
        seedCachedFallbackFromPrevious();
        mode = "cached-fallback";
        fallbackMode = "cached-fx-rates";
        sources = {
          ...sources,
          frankfurter: "error",
          cache: "ok",
        };
      }
      if (mode !== "cached-fallback" && Object.keys(usableRates).length === 0) {
        throw new Error(`frankfurter.app returned ${res?.status ?? "no response"}`);
      }
    }
    if (mode !== "cached-fallback") {
      if (res?.ok) {
        const frankfurterPayload = await res.json();
        const frankfurterValidation = validatePayloadWithSchema(
          FrankfurterResponseSchema,
          frankfurterPayload,
          "sync-fx-rates:frankfurter",
        );
        if (!frankfurterValidation.ok) {
          const cachedRateCount = Object.keys(prevRates).length;
          validationIssues = frankfurterValidation.issues;
          const appliedLiveFallback = await tryLiveFullSetFallback("invalid-payload");
          if (appliedLiveFallback) {
            console.warn("[sync-fx-rates] Invalid Frankfurter payload, using live FX fallback");
          } else if (cachedRateCount > 0) {
            console.warn(`[sync-fx-rates] Invalid frankfurter payload, using ${cachedRateCount} cached rates`);
            seedCachedFallbackFromPrevious();
            mode = "cached-fallback";
            fallbackMode = "cached-fx-rates";
            sources = {
              ...sources,
              frankfurter: "invalid-payload",
              cache: "ok",
            };
          } else {
            throw new Error(`frankfurter.app payload validation failed: ${frankfurterValidation.issues}`);
          }
        } else {
          await runBestEffort("recordOutcome:fx-frankfurter-success", async () => {
            await recordOutcome(db, CIRCUIT_SOURCE.FX_FRANKFURTER, true);
          });
          const data = frankfurterValidation.data;
          usableRates = {};
          ecbDate = data.date;

          const ecbDateObj = new Date(data.date + "T16:00:00Z");
          const ecbUpdatedAt = resolveDatedSourceUpdatedAt(data.date, syncStartSec, 16);
          const ecbAgeSec = (Date.now() - ecbDateObj.getTime()) / 1000;
          if (ecbAgeSec > 86400) {
            console.warn(
              `[sync-fx-rates] ECB rates are ${Math.round(ecbAgeSec / 3600)}h stale (date=${data.date}). ` +
              `Weekend/holiday — non-USD pegs using last published rates.`,
            );
          }

          for (const [currency, unitsPerUsd] of Object.entries(data.rates)) {
            const pegKey = CURRENCY_TO_PEG[currency];
            if (!pegKey || unitsPerUsd <= 0) continue;
            const rate = Number((1 / unitsPerUsd).toFixed(6));
            if (isValidRate(pegKey, rate, prevRates[pegKey])) {
              usableRates[pegKey] = rate;
              markLive(pegKey, ecbUpdatedAt, "business-daily", data.date);
            } else if (prevRates[pegKey]) {
              usableRates[pegKey] = prevRates[pegKey];
              inheritPrevious(pegKey);
            }
          }

          try {
            const secondaryCandidate = await loadSecondaryCurrencyCandidate(signal);
            if (secondaryCandidate) {
              applySecondaryRates(secondaryCandidate, Object.entries(SECONDARY_CURRENCY_TO_PEG));
              sources["fawazahmed0"] = Object.values(SECONDARY_CURRENCY_TO_PEG).every((pegKey) => pegKey in usableRates) ? "ok" : "partial";
            }
          } catch (e) {
            console.warn("[sync-fx-rates] Secondary FX API (CNH/RUB/UAH/ARS) failed:", e);
          }
        }
      }
    }

    let oxrSource: "ok" | "partial" | "rate-limited" | "unavailable" = "unavailable";
    if (openExchangeRatesKey) {
      const OXR_LAST_ATTEMPT_KEY = "fx-oxr-last-attempt";
      const OXR_LAST_SUCCESS_KEY = "fx-oxr-last-success";
      const OXR_LEGACY_LAST_FETCH_KEY = "fx-oxr-last-fetch";
      const [lastAttempt, legacyLastFetch] = await Promise.all([
        db.prepare("SELECT value FROM cache WHERE key = ?").bind(OXR_LAST_ATTEMPT_KEY).first<{ value: string }>(),
        db.prepare("SELECT value FROM cache WHERE key = ?").bind(OXR_LEGACY_LAST_FETCH_KEY).first<{ value: string }>(),
      ]);
      const lastFetchTime = lastAttempt ? parseInt(lastAttempt.value, 10)
        : legacyLastFetch ? parseInt(legacyLastFetch.value, 10)
          : 0;
      const elapsedMinutes = (Math.floor(Date.now() / 1000) - lastFetchTime) / 60;

      if (elapsedMinutes >= 55) {
        try {
          const completedAt = Math.floor(Date.now() / 1000);
          const realtimeFetch = await fetchRealtimeFxRates(openExchangeRatesKey, signal);
          const realtimeRates = realtimeFetch.rates;
          if (realtimeFetch.completed) {
            await runBestEffort("fx-oxr-last-fetch-write", async () => {
              await db.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
                .bind(OXR_LAST_ATTEMPT_KEY, String(completedAt), completedAt).run();
            });
          }
          let realtimeApplied = 0;
          for (const [pegKey, realtimeRate] of realtimeRates) {
            const currentRate = usableRates[pegKey];
            if (currentRate != null) {
              const delta = Math.abs(realtimeRate - currentRate) / currentRate;
              if (delta <= 0.05) {
                if (isValidRate(pegKey, realtimeRate, prevRates[pegKey])) {
                  usableRates[pegKey] = realtimeRate;
                  applyRealtimeOverlaySourceMetadata(
                    pegKey,
                    syncStartSec,
                    syncStartSec,
                    sourceUpdatedAtByPeg,
                    sourceModeByPeg,
                    sourceCadenceByPeg,
                    sourceDateByPeg,
                  );
                  realtimeApplied++;
                }
              } else {
                console.warn(`[sync-fx-rates] ${pegKey} diverges: current=${currentRate}, realtime=${realtimeRate} (${(delta * 100).toFixed(1)}%)`);
              }
            } else if (isValidRate(pegKey, realtimeRate, prevRates[pegKey])) {
              usableRates[pegKey] = realtimeRate;
              applyRealtimeOverlaySourceMetadata(
                pegKey,
                syncStartSec,
                syncStartSec,
                sourceUpdatedAtByPeg,
                sourceModeByPeg,
                sourceCadenceByPeg,
                sourceDateByPeg,
              );
              realtimeApplied++;
            }
          }
          if (realtimeRates.size > 0) {
            await runBestEffort("fx-oxr-last-success-write", async () => {
              await db.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
                .bind(OXR_LAST_SUCCESS_KEY, String(completedAt), completedAt).run();
            });
          }
          console.log(`[sync-fx-rates] Applied ${realtimeApplied}/${realtimeRates.size} real-time FX rates`);
          oxrSource = realtimeRates.size > 0 ? (realtimeApplied === realtimeRates.size ? "ok" : "partial") : "unavailable";
          await runBestEffort("recordOutcome:fx-realtime", async () => {
            await recordOutcome(db, CIRCUIT_SOURCE.FX_REALTIME, realtimeFetch.completed);
          });
        } catch (err) {
          if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
          console.warn("[sync-fx-rates] OXR real-time fetch failed:", err);
          await runBestEffort("recordOutcome:fx-realtime-failure", async () => {
            await recordOutcome(db, CIRCUIT_SOURCE.FX_REALTIME, false);
          });
          oxrSource = "unavailable";
        }
      } else {
        console.log(`[sync-fx-rates] Skipping OXR fetch (last fetch ${Math.round(elapsedMinutes)}min ago, rate limit: 55min)`);
        oxrSource = "rate-limited";
      }
    }
    sources.openExchangeRates = oxrSource;

    if (!usableRates["peggedRUB"]) {
      if (typeof prevRates["peggedRUB"] === "number" && prevRates["peggedRUB"] > 0) {
        usableRates["peggedRUB"] = prevRates["peggedRUB"];
        inheritPrevious("peggedRUB");
        console.log(`[sync-fx-rates] Using cached RUB rate: ${usableRates["peggedRUB"]}`);
      }
      if (!usableRates["peggedRUB"]) {
        usableRates["peggedRUB"] = RUB_FALLBACK;
        setHardcoded("peggedRUB");
        console.log(`[sync-fx-rates] Using hardcoded RUB fallback: ${RUB_FALLBACK}`);
      }
    }

    if (!usableRates["peggedCNH"] && typeof prevRates["peggedCNH"] === "number" && prevRates["peggedCNH"] > 0) {
      usableRates["peggedCNH"] = prevRates["peggedCNH"];
      inheritPrevious("peggedCNH");
      console.log(`[sync-fx-rates] Using cached CNH rate: ${usableRates["peggedCNH"]}`);
    }
    const metals = await resolveMetalReferenceRates({
      prevRates,
      commodityPeerMedian,
      syncStartSec,
      signal,
      validateRate: (pegKey, rate, prevRate) => isValidRate(pegKey, rate, prevRate),
    });
    for (const pegKey of ["peggedGOLD", "peggedSILVER"] as const) {
      const resolved = metals.resolvedByPeg[pegKey];
      if (!resolved) continue;
      usableRates[pegKey] = resolved.rate;
      if (resolved.source === "cached") {
        inheritPrevious(pegKey);
      } else {
        markLive(pegKey, resolved.updatedAt ?? syncStartSec);
      }
    }
    sources["gold-api.com"] = metals.sources["gold-api.com"];
    sources["commodity-peer-median"] = metals.sources["commodity-peer-median"];
    let chainlinkSource: "ok" | "partial" | "unavailable" = "unavailable";
    const chainlinkAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.CHAINLINK_FEEDS);
    if (chainlinkAllowed) {
      try {
        const snapshot = await fetchChainlinkReferenceQuoteSnapshot(
          signal,
          chainRpcs,
          syncStartSec,
          drpcApiKey,
          etherscanApiKey,
        );
        const quotes = snapshot.quotes;
        let applied = 0;
        for (const [pegKey, quote] of quotes) {
          const existing = usableRates[pegKey];
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
            usableRates[pegKey] = normalized;
            applyRealtimeOverlaySourceMetadata(
              pegKey,
              quote.updatedAt,
              syncStartSec,
              sourceUpdatedAtByPeg,
              sourceModeByPeg,
              sourceCadenceByPeg,
              sourceDateByPeg,
            );
            applied++;
          } else if (prevRates[pegKey]) {
            usableRates[pegKey] = prevRates[pegKey];
            inheritPrevious(pegKey);
          }
        }
        chainlinkSource = quotes.size > 0 ? (applied === quotes.size ? "ok" : "partial") : "unavailable";
        await runBestEffort("recordOutcome:chainlink-feeds", async () => {
          await recordOutcome(db, CIRCUIT_SOURCE.CHAINLINK_FEEDS, quotes.size > 0);
        });
      } catch (err) {
        if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
        console.warn("[sync-fx-rates] Chainlink reference feeds failed:", err);
        await runBestEffort("recordOutcome:chainlink-feeds-failure", async () => {
          await recordOutcome(db, CIRCUIT_SOURCE.CHAINLINK_FEEDS, false);
        });
      }
    } else {
      console.warn("[sync-fx-rates] Chainlink reference-feed circuit open — skipping overlay");
    }
    sources.chainlink = chainlinkSource;
    if (mode === "cached-fallback" && hasFreshFullFxCoverage()) {
      mode = "live";
      fallbackMode = "independent-live-recovery";
      if (sources.cache === "ok") sources.cache = "recovered";
      console.log("[sync-fx-rates] Independent sources restored fresh full-set coverage after cached fallback");
    }
    const missing = EXPECTED_FX_PEG_KEYS.filter((k) => !(k in usableRates));
    if (Object.keys(usableRates).length === 0) {
      throw new Error("sync-fx-rates produced zero usable rates");
    }
    if (missing.length > 0) {
      console.warn(`[sync-fx-rates] Missing rates for: ${missing.join(", ")}`);
    }

    const meta = {
      usableSyncAt: syncStartSec,
      mode,
      sourceUpdatedAtByPeg,
      sourceModeByPeg,
      sourceCadenceByPeg,
      sourceDateByPeg,
      sources,
      ecbDate,
      previousCacheUpdatedAt: prevState?.usableSyncAt ?? null,
      consecutiveFallbackRuns:
        mode === "cached-fallback"
          ? prevState?.mode === "cached-fallback"
            ? prevState.consecutiveFallbackRuns + 1
            : 1
          : 0,
    };
    await persistFxRateState(db, usableRates, meta, syncStartSec);
    console.log(`[sync-fx-rates] Cached FX rates: ${JSON.stringify(usableRates)}`);
    const metadata = {
      rateCount: Object.keys(usableRates).length,
      mode,
      fallbackMode,
      missing: missing.length > 0 ? missing : undefined,
      validationIssues,
      secondaryCoverage: Object.values(SECONDARY_CURRENCY_TO_PEG).filter((pegKey) => pegKey in usableRates).length,
      ecbDate: ecbDate ?? undefined,
      consecutiveFallbackRuns: meta.consecutiveFallbackRuns,
      sources,
    };
    return {
      status: mode === "cached-fallback" && meta.consecutiveFallbackRuns >= 4 ? "degraded" : undefined,
      itemCount: Object.keys(usableRates).length,
      metadata: JSON.stringify(metadata),
    };
  } catch (err) {
    console.error(`[sync-fx-rates] Failed:`, err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}
