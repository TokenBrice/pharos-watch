import { logWorkerEventArgs } from "../lib/structured-log";
import type { CronResult } from "../lib/cron-logger";
import { getCache } from "../lib/db-cache";
import { CIRCUIT_SOURCE } from "../lib/constants";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import type { ChainRpcConfig } from "../lib/chain-registry";
import { runCadenceBucketPublication } from "../lib/cadence-bucket";
import { loadFxRateState, type FxRatesMeta } from "../lib/fx-rate-state";
import {
  EXPECTED_FX_PEG_KEYS,
  isValidFxRate,
  PRIMARY_CURRENCY_TO_PEG,
  PRIMARY_FX_CURRENCIES,
  SECONDARY_FX_CURRENCY_TO_PEG,
} from "../lib/fx-config";
import { loadCommodityPeerMedianReference, resolveMetalReferenceRates } from "../lib/fx-metals";
import {
  FxSyncRunState,
  persistFxSyncResult,
  runChainlinkOverlay,
  runOpenExchangeRatesOverlay,
} from "./sync-fx-rates-helpers";
import {
  loadExchangeRateApiPayload,
  loadFrankfurterPayload,
  loadSecondaryCurrencyCandidate,
  type SecondaryCurrencyLoadResult,
} from "./sync-fx-rates-sources";


/**
 * Fetches live FX rates from the European Central Bank (via api.frankfurter.dev)
 * and stores them in D1 cache as fallback rates for thin peg groups.
 *
 * Format matches FALLBACK_RATES in peg-rates.ts: { peggedEUR: 1.08, ... }
 * where the value is "USD per 1 unit of the currency".
 *
 * CNH, RUB, UAH, ARS, KGS, NGN, XOF, VND, KES, GHS, COP, CLP, and PEN are
 * sourced from a secondary currency API because Frankfurter/ECB does not
 * publish them all directly.
 * Supported Chainlink feeds overlay the reference cache for a curated subset
 * of fiat and commodity pegs when the on-chain quotes are fresh and plausible.
 * Triggered every 15 minutes, with scheduled deliveries grouped into one
 * generation-fenced 30-minute publication bucket.
 */
export interface SyncFxRatesOptions {
  scheduledAtSec?: number;
}

const FX_CADENCE_SEC = 30 * 60;
const FX_CADENCE_KEY = "sync-fx-rates:cadence";
const FX_STALE_CLAIM_SEC = 12 * 60;
const FX_SOURCE_SUCCESS_META_FIELD = "sourceLastSuccessAtBySource";
const FX_SOURCE_TTL_SEC = {
  "secondary:jsdelivr": 6 * 3600,
  "secondary:pages.dev": 6 * 3600,
  "secondary:jsdelivr-versioned": 6 * 3600,
  openExchangeRates: 6 * 3600,
  metals: FX_CADENCE_SEC,
  chainlink: FX_CADENCE_SEC,
} as const;
const SECONDARY_ENDPOINT_SOURCE_KEYS = {
  jsdelivr: "secondary:jsdelivr",
  "pages.dev": "secondary:pages.dev",
  "jsdelivr-versioned": "secondary:jsdelivr-versioned",
} as const;
const FX_SOURCE_ALIASES: Record<keyof typeof FX_SOURCE_TTL_SEC, readonly string[]> = {
  "secondary:jsdelivr": ["secondary:jsdelivr", "jsdelivr", "fawazahmed0"],
  "secondary:pages.dev": ["secondary:pages.dev", "pages.dev"],
  "secondary:jsdelivr-versioned": ["secondary:jsdelivr-versioned", "jsdelivr-versioned"],
  openExchangeRates: ["openExchangeRates", "openexchange-rates"],
  metals: ["metals", "gold-api.com"],
  chainlink: ["chainlink", "chainlink-feeds"],
};

type FxSourceLastSuccess = Partial<Record<keyof typeof FX_SOURCE_TTL_SEC, number>>;
type FxMetaWithSourceSuccess = FxRatesMeta & {
  sourceLastSuccessAtBySource?: FxSourceLastSuccess;
};

function parseFxSourceLastSuccess(value: string | null | undefined): FxSourceLastSuccess {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const sourceLastSuccessAtBySource: FxSourceLastSuccess = {};
    for (const source of Object.keys(FX_SOURCE_TTL_SEC) as Array<keyof typeof FX_SOURCE_TTL_SEC>) {
      const timestamp = FX_SOURCE_ALIASES[source]
        .map((alias) => parsed[alias])
        .find((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
      if (typeof timestamp === "number") {
        sourceLastSuccessAtBySource[source] = Math.floor(timestamp);
      }
    }
    return sourceLastSuccessAtBySource;
  } catch {
    return {};
  }
}

async function loadFxSourceLastSuccess(db: D1Database): Promise<FxSourceLastSuccess> {
  const cache = await getCache(db, "fx-rates-meta");
  if (!cache) return {};
  try {
    const parsed = JSON.parse(cache.value) as Record<string, unknown>;
    const sourceLastSuccess = parsed[FX_SOURCE_SUCCESS_META_FIELD] ?? parsed.sourceLastSuccessAt;
    return parseFxSourceLastSuccess(
      sourceLastSuccess && typeof sourceLastSuccess === "object"
        ? JSON.stringify(sourceLastSuccess)
        : null,
    );
  } catch {
    return {};
  }
}

function isFxSourceDue(
  source: keyof typeof FX_SOURCE_TTL_SEC,
  lastSuccessAt: FxSourceLastSuccess,
  nowSec: number,
): boolean {
  const timestamp = lastSuccessAt[source];
  return timestamp == null || nowSec - timestamp >= FX_SOURCE_TTL_SEC[source];
}

function carryForwardRates(
  state: FxSyncRunState,
  pegKeys: readonly string[],
): void {
  for (const pegKey of pegKeys) {
    if (!(pegKey in state.usableRates)) {
      state.ensureCachedRate(pegKey, "source TTL");
    }
  }
}

export async function syncFxRates(
  db: D1Database,
  signal?: AbortSignal,
  openExchangeRatesKey?: string,
  chainRpcs?: Map<string, ChainRpcConfig>,
  drpcApiKey?: string | null, etherscanApiKey?: string | null,
  options: SyncFxRatesOptions = {},
): Promise<CronResult> {
  const syncStartSec = Math.floor(Date.now() / 1000);
  const scheduledAtSec = options.scheduledAtSec ?? syncStartSec;
  return runCadenceBucketPublication(db, {
    key: FX_CADENCE_KEY,
    cadenceSec: FX_CADENCE_SEC,
    staleClaimAfterSec: FX_STALE_CLAIM_SEC,
    scheduledAtSec,
    startedAtSec: syncStartSec,
    job: "sync-fx-rates",
    releaseFailureEvent: "sync_fx_rates.cadence_claim_release_failed",
    releaseFailureMessage: "Failed to release FX cadence claim after publication failure",
    publication: () => runFxRatePublication(
      db,
      syncStartSec,
      signal,
      openExchangeRatesKey,
      chainRpcs,
      drpcApiKey,
      etherscanApiKey,
    ),
  });
}

async function runFxRatePublication(
  db: D1Database,
  syncStartSec: number,
  signal?: AbortSignal,
  openExchangeRatesKey?: string,
  chainRpcs?: Map<string, ChainRpcConfig>,
  drpcApiKey?: string | null,
  etherscanApiKey?: string | null,
): Promise<CronResult> {

  const runBestEffort = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      logWorkerEventArgs("handler", "warn", `[sync-fx-rates] Best-effort step failed (${label}):`, err);
    }
  };

  try {
    const prevState = await loadFxRateState(db);
    const sourceLastSuccessAtBySource = await loadFxSourceLastSuccess(db);
    let fallbackSecondaryCandidate: SecondaryCurrencyLoadResult | null = null;
    const loadSecondaryForFallback = async () => {
      const candidate = await loadSecondaryCurrencyCandidate(signal);
      fallbackSecondaryCandidate = candidate;
      return candidate;
    };
    const recordFallbackSecondarySuccess = () => {
      for (const endpoint of fallbackSecondaryCandidate?.successfulEndpoints ?? []) {
        sourceLastSuccessAtBySource[SECONDARY_ENDPOINT_SOURCE_KEYS[endpoint]] = syncStartSec;
      }
    };
    const primaryMappings = Object.entries(PRIMARY_CURRENCY_TO_PEG);
    const secondaryMappings = Object.entries(SECONDARY_FX_CURRENCY_TO_PEG);
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
      validateRate: (pegKey, rate, prevRate) => isValidFxRate(pegKey, rate, prevRate, "[sync-fx-rates]"),
    });
    const commodityPeerMedian = await loadCommodityPeerMedianReference(db, syncStartSec);

    const frankfurterAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.FX_FRANKFURTER);
    const frankfurterResult = frankfurterAllowed
      ? await loadFrankfurterPayload(PRIMARY_FX_CURRENCIES, signal)
      : { ok: false as const, kind: "unavailable" as const, statusCode: null };

    if (!frankfurterResult.ok && frankfurterResult.kind === "unavailable") {
      if (frankfurterAllowed) {
        await runBestEffort("recordOutcome:fx-frankfurter-failure", async () => {
          await recordOutcome(db, CIRCUIT_SOURCE.FX_FRANKFURTER, false);
        });
      }
      const cachedRateCount = Object.keys(syncState.prevRates).length;
      const appliedLiveFallback = await syncState.tryLiveFullSetFallback("error", {
        loadSecondaryCurrencyCandidate: loadSecondaryForFallback,
        loadExchangeRateApiPayload: () => loadExchangeRateApiPayload(signal),
        primaryMappings,
        secondaryMappings,
      });
      recordFallbackSecondarySuccess();
      if (!appliedLiveFallback && cachedRateCount > 0) {
        logWorkerEventArgs("handler", "warn",
          `[sync-fx-rates] Frankfurter API unavailable (${frankfurterResult.statusCode ?? "no response"}), using ${cachedRateCount} cached rates`,
        );
        syncState.enterCachedFallback("error");
      }
      if (syncState.mode !== "cached-fallback" && Object.keys(syncState.usableRates).length === 0) {
        throw new Error(`Frankfurter API returned ${frankfurterResult.statusCode ?? "no response"}`);
      }
    }
    if (syncState.mode !== "cached-fallback") {
      if (frankfurterResult.ok) {
        await runBestEffort("recordOutcome:fx-frankfurter-success", async () => {
          await recordOutcome(db, CIRCUIT_SOURCE.FX_FRANKFURTER, true);
        });
        syncState.applyFrankfurterRates(
          frankfurterResult.data.rates,
          frankfurterResult.data.date,
          PRIMARY_CURRENCY_TO_PEG,
        );

        const dueSecondaryEndpoints = (Object.keys(SECONDARY_ENDPOINT_SOURCE_KEYS) as Array<
          keyof typeof SECONDARY_ENDPOINT_SOURCE_KEYS
        >).filter((endpoint) => isFxSourceDue(
          SECONDARY_ENDPOINT_SOURCE_KEYS[endpoint],
          sourceLastSuccessAtBySource,
          syncStartSec,
        ));
        if (dueSecondaryEndpoints.length === 0) {
          carryForwardRates(syncState, Object.values(SECONDARY_FX_CURRENCY_TO_PEG));
          syncState.sources.fawazahmed0 = prevState?.sources?.fawazahmed0 ?? "cached";
        } else {
          try {
            const secondaryCandidate = await loadSecondaryCurrencyCandidate(signal, {
              endpoints: dueSecondaryEndpoints,
            });
            if (secondaryCandidate) {
              syncState.applySecondaryRates(secondaryCandidate, secondaryMappings);
              for (const endpoint of secondaryCandidate.successfulEndpoints ?? [secondaryCandidate.endpoint]) {
                sourceLastSuccessAtBySource[SECONDARY_ENDPOINT_SOURCE_KEYS[endpoint]] = syncStartSec;
              }
              syncState.sources.fawazahmed0 = Object.values(SECONDARY_FX_CURRENCY_TO_PEG).every(
                (pegKey) => pegKey in syncState.usableRates,
              )
                ? "ok"
                : "partial";
            } else {
              syncState.sources.fawazahmed0 = "error";
            }
            carryForwardRates(syncState, Object.values(SECONDARY_FX_CURRENCY_TO_PEG));
          } catch (e) {
            logWorkerEventArgs("handler", "warn", "[sync-fx-rates] Secondary FX API failed:", e);
            syncState.sources.fawazahmed0 = "error";
            carryForwardRates(syncState, Object.values(SECONDARY_FX_CURRENCY_TO_PEG));
          }
        }
      } else if (frankfurterResult.kind === "invalid-payload") {
        const cachedRateCount = Object.keys(syncState.prevRates).length;
        const appliedLiveFallback = await syncState.tryLiveFullSetFallback("invalid-payload", {
          loadSecondaryCurrencyCandidate: loadSecondaryForFallback,
          loadExchangeRateApiPayload: () => loadExchangeRateApiPayload(signal),
          primaryMappings,
          secondaryMappings,
        });
        recordFallbackSecondarySuccess();
        if (appliedLiveFallback) {
          logWorkerEventArgs("handler", "warn", "[sync-fx-rates] Invalid Frankfurter payload, using live FX fallback");
        } else if (cachedRateCount > 0) {
          logWorkerEventArgs("handler", "warn", `[sync-fx-rates] Invalid frankfurter payload, using ${cachedRateCount} cached rates`);
          syncState.enterCachedFallback("invalid-payload");
        } else {
          throw new Error(`Frankfurter API payload validation failed: ${frankfurterResult.issues}`);
        }
      }
    }

    const openExchangeRatesDue = openExchangeRatesKey != null && isFxSourceDue(
      "openExchangeRates",
      sourceLastSuccessAtBySource,
      syncStartSec,
    );
    if (openExchangeRatesKey && openExchangeRatesDue) {
      syncState.sources.openExchangeRates = await runOpenExchangeRatesOverlay(
        db,
        syncState,
        openExchangeRatesKey,
        signal,
        runBestEffort,
      );
      if (syncState.sources.openExchangeRates === "ok" || syncState.sources.openExchangeRates === "partial") {
        sourceLastSuccessAtBySource.openExchangeRates = syncStartSec;
      }
    } else if (openExchangeRatesKey) {
      syncState.sources.openExchangeRates = prevState?.sources?.openExchangeRates ?? "cached";
    }

    if (frankfurterResult.ok) {
      carryForwardRates(syncState, Object.values(SECONDARY_FX_CURRENCY_TO_PEG));
    } else {
      syncState.ensureCadenceValidRate("peggedRUB", "RUB");
      if (!("peggedCNH" in syncState.usableRates)) {
        syncState.ensureCachedRate("peggedCNH", "CNH");
      }
    }

    const metalsDue = isFxSourceDue("metals", sourceLastSuccessAtBySource, syncStartSec);
    if (metalsDue) {
      const metals = await resolveMetalReferenceRates({
        prevRates: syncState.prevRates,
        commodityPeerMedian,
        syncStartSec,
        signal,
        validateRate: (pegKey, rate, prevRate) => isValidFxRate(pegKey, rate, prevRate, "[sync-fx-rates]"),
      });
      syncState.applyResolvedMetals(metals);
      syncState.sources["gold-api.com"] = metals.sources["gold-api.com"];
      syncState.sources["commodity-peer-median"] = metals.sources["commodity-peer-median"];
      if (metals.sources["gold-api.com"] !== "error") {
        sourceLastSuccessAtBySource.metals = syncStartSec;
      }
    } else {
      carryForwardRates(syncState, ["peggedGOLD", "peggedSILVER"]);
      syncState.sources["gold-api.com"] = prevState?.sources?.["gold-api.com"] ?? "cached";
      syncState.sources["commodity-peer-median"] = prevState?.sources?.["commodity-peer-median"] ?? "cached";
    }

    if (isFxSourceDue("chainlink", sourceLastSuccessAtBySource, syncStartSec)) {
      syncState.sources.chainlink = await runChainlinkOverlay(
        db,
        syncState,
        signal,
        chainRpcs,
        drpcApiKey,
        etherscanApiKey,
        runBestEffort,
      );
      if (syncState.sources.chainlink === "ok" || syncState.sources.chainlink === "partial") {
        sourceLastSuccessAtBySource.chainlink = syncStartSec;
      }
    } else {
      syncState.sources.chainlink = prevState?.sources?.chainlink ?? "cached";
    }
    syncState.maybeRecoverFromCachedFallback();

    const missing = syncState.getMissingPegKeys();
    if (Object.keys(syncState.usableRates).length === 0) {
      throw new Error("sync-fx-rates produced zero usable rates");
    }
    if (missing.length > 0) {
      logWorkerEventArgs("handler", "warn", `[sync-fx-rates] Missing rates for: ${missing.join(", ")}`);
    }

    const meta: FxMetaWithSourceSuccess = {
      ...syncState.buildPersistedMeta(),
      sourceLastSuccessAtBySource,
    };
    return persistFxSyncResult(db, syncState, meta, syncStartSec, Object.values(SECONDARY_FX_CURRENCY_TO_PEG));
  } catch (err) {
    logWorkerEventArgs("handler", "error", `[sync-fx-rates] Failed:`, err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}
