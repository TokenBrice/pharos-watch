import type { CronResult } from "../lib/cron-logger";
import { RUB_FALLBACK, CIRCUIT_SOURCE } from "../lib/constants";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { getCache } from "../lib/db-cache";
import type { ChainRpcConfig } from "../lib/chain-registry";
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
 * Triggered every 15 minutes, with an internal 30-minute write/fetch cooldown.
 */

export async function syncFxRates(
  db: D1Database,
  signal?: AbortSignal,
  openExchangeRatesKey?: string,
  chainRpcs?: Map<string, ChainRpcConfig>,
  drpcApiKey?: string | null, etherscanApiKey?: string | null,
): Promise<CronResult> {
  const syncStartSec = Math.floor(Date.now() / 1000);

  // FX rates rarely move meaningfully in 15 min. The quarter-hourly slot keeps
  // firing every 15 min because sync-stablecoins needs it; FX is gated here so
  // it only does work every 30 min, halving Frankfurter/fawazahmed0/OXR calls
  // and the Chainlink RPC overlay.
  const COOLDOWN_SEC = 30 * 60;
  const lastWrite = await getCache(db, "sync-fx-rates:last-write");
  if (lastWrite && syncStartSec - lastWrite.updatedAt < COOLDOWN_SEC) {
    return {
      itemCount: 0,
      metadata: JSON.stringify({
        reason: "cooldown_active",
        lastWriteAgeSec: syncStartSec - lastWrite.updatedAt,
      }),
    };
  }

  const runBestEffort = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      console.warn(`[sync-fx-rates] Best-effort step failed (${label}):`, err);
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
        console.warn(
          `[sync-fx-rates] Frankfurter API unavailable (${frankfurterResult.statusCode ?? "no response"}), using ${cachedRateCount} cached rates`,
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
          console.warn("[sync-fx-rates] Secondary FX API (CNH/RUB/UAH/ARS) failed:", e);
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

    syncState.ensureCachedOrHardcodedRate("peggedRUB", "RUB", RUB_FALLBACK);
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
      console.warn(`[sync-fx-rates] Missing rates for: ${missing.join(", ")}`);
    }

    const meta = syncState.buildPersistedMeta();
    return persistFxSyncResult(db, syncState, meta, syncStartSec, Object.values(SECONDARY_FX_CURRENCY_TO_PEG));
  } catch (err) {
    console.error(`[sync-fx-rates] Failed:`, err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}
