import { logWorkerEventArgs } from "../lib/structured-log";
import type { CronResult } from "../lib/cron-logger";
import { CIRCUIT_SOURCE } from "../lib/constants";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import type { ChainRpcConfig } from "../lib/chain-registry";
import {
  cadenceBucketFor,
  claimCadenceBucket,
  completeCadenceBucket,
  failCadenceBucket,
  appendCadenceResultMetadata,
} from "../lib/cadence-bucket";
import { loadFxRateState } from "../lib/fx-rate-state";
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
} from "./sync-fx-rates-sources";
import { logWorkerEvent } from "../lib/structured-log";
import { parseJsonObject } from "../lib/json-parse";

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
  const bucket = cadenceBucketFor(scheduledAtSec, FX_CADENCE_SEC);
  const claimResult = await claimCadenceBucket(db, {
    key: FX_CADENCE_KEY,
    bucket,
    nowSec: syncStartSec,
    staleClaimAfterSec: FX_STALE_CLAIM_SEC,
  });
  if (claimResult.kind === "skip") {
    return {
      itemCount: 0,
      metadata: JSON.stringify({
        reason: claimResult.reason === "already-completed"
          ? "cadence_bucket_completed"
          : "cadence_bucket_in_progress",
        cadence: {
          bucket,
          observedBucket: claimResult.bucket,
          cadenceSec: FX_CADENCE_SEC,
        },
      }),
    };
  }

  try {
    const result = await runFxRatePublication(
      db,
      syncStartSec,
      signal,
      openExchangeRatesKey,
      chainRpcs,
      drpcApiKey,
      etherscanApiKey,
    );
    const resultMetadata = parseJsonObject(result.metadata) ?? {};
    if (resultMetadata.lastWriteAdvanced !== true) {
      await failCadenceBucket(db, claimResult.claim);
      return appendCadenceResultMetadata(
        { ...result, status: "degraded" },
        { bucket, cadenceSec: FX_CADENCE_SEC, completed: false, retryable: true },
      );
    }
    const completed = await completeCadenceBucket(db, claimResult.claim);
    return appendCadenceResultMetadata(
      completed ? result : { ...result, status: "degraded" },
      { bucket, cadenceSec: FX_CADENCE_SEC, completed, retryable: !completed },
    );
  } catch (error) {
    try {
      await failCadenceBucket(db, claimResult.claim);
    } catch (transitionError) {
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: "sync_fx_rates.cadence_claim_release_failed",
        job: "sync-fx-rates",
        message: "Failed to release FX cadence claim after publication failure",
        error: transitionError,
        metadata: { bucket },
      });
    }
    throw error;
  }
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
        loadSecondaryCurrencyCandidate: () => loadSecondaryCurrencyCandidate(signal),
        loadExchangeRateApiPayload: () => loadExchangeRateApiPayload(signal),
        primaryMappings,
        secondaryMappings,
      });
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

        try {
          const secondaryCandidate = await loadSecondaryCurrencyCandidate(signal);
          if (secondaryCandidate) {
            syncState.applySecondaryRates(secondaryCandidate, secondaryMappings);
            syncState.sources.fawazahmed0 = Object.values(SECONDARY_FX_CURRENCY_TO_PEG).every(
              (pegKey) => pegKey in syncState.usableRates,
            )
              ? "ok"
              : "partial";
          }
        } catch (e) {
          logWorkerEventArgs("handler", "warn", "[sync-fx-rates] Secondary FX API failed:", e);
        }
      } else if (frankfurterResult.kind === "invalid-payload") {
        const cachedRateCount = Object.keys(syncState.prevRates).length;
        syncState.validationIssues = frankfurterResult.issues;
        const appliedLiveFallback = await syncState.tryLiveFullSetFallback("invalid-payload", {
          loadSecondaryCurrencyCandidate: () => loadSecondaryCurrencyCandidate(signal),
          loadExchangeRateApiPayload: () => loadExchangeRateApiPayload(signal),
          primaryMappings,
          secondaryMappings,
        });
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

    syncState.sources.openExchangeRates = await runOpenExchangeRatesOverlay(
      db,
      syncState,
      openExchangeRatesKey,
      signal,
      runBestEffort,
    );

    syncState.ensureCadenceValidRate("peggedRUB", "RUB");
    if (!("peggedCNH" in syncState.usableRates)) {
      syncState.ensureCachedRate("peggedCNH", "CNH");
    }

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
      logWorkerEventArgs("handler", "warn", `[sync-fx-rates] Missing rates for: ${missing.join(", ")}`);
    }

    const meta = syncState.buildPersistedMeta();
    return persistFxSyncResult(db, syncState, meta, syncStartSec, Object.values(SECONDARY_FX_CURRENCY_TO_PEG));
  } catch (err) {
    logWorkerEventArgs("handler", "error", `[sync-fx-rates] Failed:`, err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}
