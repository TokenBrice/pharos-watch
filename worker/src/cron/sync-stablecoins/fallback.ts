import type { ChainRpcConfig } from "../../lib/chain-registry";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { SUPPLEMENTAL_RESTORE_MAX_AGE_SEC } from "@shared/lib/supply";
import type { DwellirNativeCapability } from "../../lib/dwellir-native";
import { logWorkerEvent, logWorkerEventArgs } from "../../lib/structured-log";
import type { CronProgressReporter } from "../../lib/cron-logger";
import type { CoinGeckoMcapData } from "./supplemental-assets";
import {
  buildSyncMetadata,
  clearPriceMetadata,
  loadFreshFxRates,
  loadPreviousStablecoinsById,
  loadReplayPriceCacheForTrustedContinuity,
  logTrackedCoverageRestore,
  restoreMissingTrackedAssets,
  type CronResult,
} from "./shared";
import {
  returnIfAborted,
  reportStablecoinsStage,
} from "./runtime";
import { applyTrackedAssetOverrides } from "./phase-helpers";
import { countFallbackCoingeckoAssets } from "./metadata";
import {
  buildPreviousTrustedPriceLookup,
  createValidationContextResolver,
  applyProtocolPriceOverrides,
  prevalidatePrices,
} from "./pricing";
import { createAuthoritativeLivePriceOverrideStats, fetchAuthoritativeLivePriceOverrides } from "../../lib/authoritative-price-sources";
import { isAbortResult, runSharedPriceCompletion } from "./post-enrichment";
import { overlayFallbackCuratedAggregateSupply, runFallbackIntakePhase } from "./fallback-intake";
import {
  loadStablecoinsPublicationContinuity,
  runStablecoinsPostIntakePublication,
} from "./publication";
import { enrichMissingPrices, hasMissingPrice, type PeggedAsset } from "./enrich-prices";
import { carryForwardSupplyGapFill } from "./supply-gap-reconciliation";

function isFallbackCronResult(result: unknown): result is CronResult {
  return typeof result === "object" && result !== null && "metadata" in result;
}

export async function restoreFallbackCacheState({
  db,
  assets,
}: {
  db: D1Database;
  assets: PeggedAsset[];
}) {
  const { previousAssetsById, cacheState: previousCacheState } = await loadPreviousStablecoinsById(db);

  try {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const asset of assets) {
      // Frozen rows are archive captures, not this run's provider rows. Their
      // captured chain supply and clocks must survive an outage untouched.
      if (FROZEN_IDS.has(String(asset.id))) continue;
      const prev = previousAssetsById.get(String(asset.id));
      if (prev?.supplySource === "coingecko-gap-fill") {
        carryForwardSupplyGapFill(asset, prev);
        continue;
      }
      const observedAt = prev?.supplyObservedAt;
      if (
        !prev ||
        typeof observedAt !== "number" ||
        !Number.isFinite(observedAt) ||
        observedAt > nowSec + 60 ||
        nowSec - observedAt > SUPPLEMENTAL_RESTORE_MAX_AGE_SEC
      ) {
        continue;
      }
      if (prev.chainCirculating) {
        asset.chainCirculating = Object.fromEntries(
          Object.entries(prev.chainCirculating).map(([chain, row]) => [chain, { ...row, current: null }]),
        );
        asset.chains = prev.chains ?? [];
      }
      if (prev.circulatingPrevDay) asset.circulatingPrevDay = prev.circulatingPrevDay;
      if (prev.circulatingPrevWeek) asset.circulatingPrevWeek = prev.circulatingPrevWeek;
      if (prev.circulatingPrevMonth) asset.circulatingPrevMonth = prev.circulatingPrevMonth;
    }
  } catch (error) {
    logWorkerEventArgs("handler", "warn", "[sync-stablecoins] Failed to restore stale cache data:", error);
  }

  applyTrackedAssetOverrides(assets);

  return { previousAssetsById, previousCacheState };
}

/** No cache write: the omitted tracked coins have no readable prior row to restore from (R2). */
function buildUnreadablePreviousPublicationResult(assetCount: number, rowsRead: number): CronResult {
  return {
    status: "degraded",
    itemCount: assetCount,
    metadata: buildSyncMetadata({
      reason: "previous-stablecoins-publication-unreadable",
      previousCacheState: "error",
      rowsRead,
      rowsWritten: 0,
      rowsDropped: 0,
      sourceCoverage: { defillama: false, coingeckoFallbackAssets: rowsRead },
      fallbackMode: "coingecko-supply-fallback",
      validationFailures: 0,
      upstreamFetchOk: false,
      payloadAccepted: false,
      cacheWriteSucceeded: false,
      depegPipelineSucceeded: false,
    }, {
      cacheWriteMode: "no-write",
      capabilities: { stablecoinsCache: false, depegPipeline: false },
    }),
  };
}

export async function syncViaCoingeckoFallback(
  db: D1Database,
  cgData: CoinGeckoMcapData,
  cmcApiKey: string | undefined,
  syncStartSec: number,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
  reportProgress?: CronProgressReporter,
  jupiterApiKey?: string | null,
  chainRpcs?: Map<string, ChainRpcConfig>,
  dwellirNative?: DwellirNativeCapability,
): Promise<CronResult> {
  const aborted = returnIfAborted(signal, "fallback-start");
  if (aborted) return aborted;
  logWorkerEventArgs("handler", "warn", "[sync-stablecoins] Using CoinGecko supply fallback");

  const intake = await runFallbackIntakePhase({
    cgData,
    syncStartSec,
    reportProgress,
  });
  if (isFallbackCronResult(intake)) return intake;
  const { assets } = intake;

  const { previousAssetsById, previousCacheState } = await restoreFallbackCacheState({ db, assets });
  // The canonical write would replace a possibly complete publication with the CoinGecko subset.
  if (previousCacheState.state === "error") {
    // Only CoinGecko-served rows are this run's reads; frozen archive rows are
    // injected before the check and are not part of the outage cohort.
    const rowsRead = countFallbackCoingeckoAssets(assets, null);
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoins",
      level: "error",
      event: "fallback-previous-publication-unreadable",
      message: "Previous stablecoins publication is unreadable; withholding the CoinGecko outage cohort",
      metadata: { reason: "previous-stablecoins-publication-unreadable", coingeckoFallbackAssets: rowsRead },
    });
    return buildUnreadablePreviousPublicationResult(assets.length, rowsRead);
  }
  const { fxFallbackRates, validationReferences } = await loadFreshFxRates(
    db,
    "[sync-stablecoins:fallback]",
  );
  // Reuse this snapshot for trusted continuity and downstream cached fallback
  // instead of loading the full price_cache table a second time per run.
  const replaySnapshot = await loadReplayPriceCacheForTrustedContinuity(db, true).catch(() => null);
  const replayPriceCache = replaySnapshot ?? new Map<string, never>();
  const validationContexts = createValidationContextResolver();
  const previousTrustedPrices = buildPreviousTrustedPriceLookup(
    previousAssetsById,
    syncStartSec,
    replayPriceCache,
  );
  await overlayFallbackCuratedAggregateSupply(assets, signal, chainRpcs, dwellirNative, previousAssetsById, replaySnapshot === null ? null : previousTrustedPrices);
  const { previousActivePriceCoverage, previousMissingGenerationsById } =
    await loadStablecoinsPublicationContinuity(db, syncStartSec);

  for (const asset of assets) {
    // Injected frozen rows keep their captured provenance; CoinGecko did not
    // serve their supply this run. Where the archive names no source, label it
    // as the primary intake does, never as CoinGecko-served (R6).
    if (!asset.supplySource) {
      asset.supplySource = FROZEN_IDS.has(String(asset.id)) ? "defillama" : "coingecko-fallback";
    }
  }
  // Same restore-or-degrade backstop as the primary intake: a coin CoinGecko cannot serve keeps its
  // previous row (`supplyRestored`, original clock and source) or preferred-native unavailable supply,
  // or is dropped and named. Restores follow the source label and on-chain overlay, so they are
  // neither relabelled nor re-read. This path has no consensus pass to re-price or downgrade a carried
  // price, so coverage rows restart unpriced and only this run's enrichment can price them (R2).
  const trackedCoverage = restoreMissingTrackedAssets(assets, previousAssetsById, syncStartSec);
  for (const asset of trackedCoverage.assets) clearPriceMetadata(asset);
  applyTrackedAssetOverrides(trackedCoverage.assets);
  assets.push(...trackedCoverage.assets);
  logTrackedCoverageRestore(trackedCoverage);
  // Every carried row in this publication came from the outage fallback. Tag
  // it so PSI/digest flag it, while routine main-path carries stay unmarked.
  for (const asset of assets) {
    if (FROZEN_IDS.has(String(asset.id))) continue;
    if (asset.supplyRestored === true) asset.supplyRestoreMode = "outage-fallback";
    else delete asset.supplyRestoreMode;
  }
  prevalidatePrices({
    assets, previousTrustedPrices, validationContexts, validationReferences,
    logLabel: "Pre-rejected fallback price",
  });
  const authoritativeOverrideStats = createAuthoritativeLivePriceOverrideStats();
  const authoritativeOverrides = await fetchAuthoritativeLivePriceOverrides(
    assets, signal, validationReferences,
    { db, stats: authoritativeOverrideStats, chainRpcs, previousMissingGenerationsById, previousAssetsById, priceCache: replayPriceCache },
  );
  applyProtocolPriceOverrides({
    assets, overrides: authoritativeOverrides, previousTrustedPrices, validationContexts,
    validationReferences, syncStartSec, authoritativeOverrideStats,
  });
  await reportStablecoinsStage(reportProgress, "fallback-price-enrichment", "Enriching CoinGecko fallback prices", {
    itemsTotal: assets.length,
  });
  const enrichAbort = returnIfAborted(signal, "fallback-enrich-prices");
  if (enrichAbort) return enrichAbort;
  const enrichStats = await enrichMissingPrices(
    assets, cmcApiKey, db, signal, jupiterApiKey, coingeckoApiKey,
    undefined, previousMissingGenerationsById, undefined, chainRpcs,
  );
  const priceCompletion = await runSharedPriceCompletion({
    chainRpcs, assets, db, syncStartSec, signal, coingeckoApiKey, fxFallbackRates,
    validationReferences, validationContexts, previousTrustedPrices, authoritativeOverrides,
    authoritativeOverrideStats, previousMissingGenerationsById, priceCache: replayPriceCache,
  }, "fallback-");
  if (isAbortResult(priceCompletion)) return priceCompletion;
  const { priceCacheEntries, providerDiagnostics, ...pricingMetadata } = priceCompletion;
  await reportStablecoinsStage(reportProgress, "fallback-price-validation", "Validated CoinGecko fallback prices", {
    itemsDone: assets.length - assets.filter(hasMissingPrice).length,
    itemsTotal: assets.length,
    metadata: {
      authoritativeOverrides: pricingMetadata.authoritativeOverrideCount,
      authoritativeOverrideStats,
      rejectedPrices: pricingMetadata.rejectedCount,
      nativePegCorrections: pricingMetadata.nativePegCorrectionCount,
      nativePegFills: pricingMetadata.nativePegFillCount,
      cachedFallbackPrices: pricingMetadata.cachedFallbackCount,
      priceObservationEffectiveness: pricingMetadata.priceObservationEffectiveness,
    },
  });

  return runStablecoinsPostIntakePublication({
    db,
    assets,
    previousAssetsById,
    previousCacheState,
    previousActivePriceCoverage,
    syncStartSec,
    signal,
    reportProgress,
    priceCacheEntries,
    fxFallbackRates,
    coingeckoApiKey,
    providerDiagnostics: [...(enrichStats.providerDiagnostics ?? []), ...providerDiagnostics],
    metadata: {
      path: "fallback",
      input: {
        enrichStats,
        ...pricingMetadata,
        trackedCoverage,
      },
    },
  });
}
