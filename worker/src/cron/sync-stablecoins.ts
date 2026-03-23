import {
  enrichMissingPrices,
  hasMissingPrice,
  fetchPrimaryPrices,
  runGtProbePass,
} from "./enrich-prices";
import type { PeggedAsset } from "./enrich-prices";
import {
  fillMissingSupplyHistory,
} from "./sync-stablecoins/stages";
import {
  buildSyncMetadata,
  loadFreshFxRates,
  stampPriceMetadata,
  type CronResult,
} from "./sync-stablecoins/shared";
import {
  runPostEnrichmentPricePipeline,
  validateAndWriteStablecoinsCache,
  runDepegPipeline,
  isAbortResult,
} from "./sync-stablecoins/post-enrichment";
import { loadStablecoinsIntake } from "./sync-stablecoins/intake";
import { buildStablecoinsSyncResult } from "./sync-stablecoins/metadata";
import { syncViaCoingeckoFallback } from "./sync-stablecoins/fallback";
import {
  applyGtProbeResults,
  applyPrimaryPriceResults,
  applyProtocolPriceOverrides,
  buildDlListPrices,
  buildPreviousTrustedPriceLookup,
  createValidationContextResolver,
  prevalidatePrices,
  priceValidationModeForAsset,
  validatePublishablePrice,
} from "./sync-stablecoins/pricing";
import { queueTrackedAdditionsNotice } from "./sync-stablecoins/telegram-tracked-additions";
import {
  abortResult,
  checkStablecoinsPriceStaleness,
  reportStablecoinsStage,
  returnIfAborted,
} from "./sync-stablecoins/runtime";
import type { ChainRpcConfig } from "../lib/chain-registry";
import { createEmptyGtProbeStats } from "../lib/geckoterminal-price-probe";
import { CIRCUIT_SOURCE } from "../lib/constants";
import { recordOutcome } from "../lib/circuit-breaker";
import { fetchAuthoritativeLivePriceOverrides } from "../lib/authoritative-price-sources";
import type { CronProgressReporter } from "../lib/cron-logger";
import { getPriceCache, type PriceCacheEntry } from "../lib/db-cache";

async function loadReplayPriceCacheForTrustedContinuity(
  db: D1Database,
): Promise<Map<string, PriceCacheEntry>> {
  try {
    return await getPriceCache(db);
  } catch (error) {
    console.warn("[sync-stablecoins] Failed to load replay price cache for trusted-price continuity:", error);
    return new Map<string, PriceCacheEntry>();
  }
}

export async function syncStablecoins(
  db: D1Database,
  cmcApiKey?: string,
  signal?: AbortSignal,
  alertWebhookUrl?: string | null,
  coingeckoApiKey?: string | null,
  chainRpcs?: Map<string, ChainRpcConfig>,
  reportProgress?: CronProgressReporter,
): Promise<CronResult> {
  const startAbort = returnIfAborted(signal, "start");
  if (startAbort) return startAbort;
  const syncStartSec = Math.floor(Date.now() / 1000);

  const preFetchAbort = returnIfAborted(signal, "fetch-stablecoins-and-supplementals");
  if (preFetchAbort) return preFetchAbort;
  await reportStablecoinsStage(reportProgress, "intake", "Loading DefiLlama stablecoin intake");
  const intake = await loadStablecoinsIntake({
    db,
    signal,
    syncStartSec,
    coingeckoApiKey,
    chainRpcs,
    fallbackToCoingecko: (cgData) =>
      syncViaCoingeckoFallback(db, cgData, cmcApiKey, syncStartSec, signal, alertWebhookUrl, coingeckoApiKey, reportProgress),
  });

  if (intake.kind === "fallback") {
    if (intake.result.itemCount && intake.result.itemCount > 0) {
      return intake.result;
    }
    throw new Error(intake.errorMessage);
  }
  const {
    assets,
    rawAssetCount,
    droppedMalformedAssets,
    canonicalDeduplication,
  } = intake;
  const previousAssetsById = intake.previousAssetsById;
  let fxFallbackRates = intake.fxFallbackRates;
  await reportStablecoinsStage(reportProgress, "intake", "Loaded DefiLlama stablecoin intake", {
    itemsDone: assets.length,
    itemsTotal: rawAssetCount,
    metadata: {
      rawAssetCount,
      droppedMalformedAssets,
      canonicalDuplicateRows: canonicalDeduplication.duplicateRows,
    },
  });

  const { fxFallbackRates: freshFxFallbackRates, validationReferences } = await loadFreshFxRates(db, syncStartSec);
  if (freshFxFallbackRates) {
    fxFallbackRates = freshFxFallbackRates;
  }
  const validationContexts = createValidationContextResolver();
  const replayPriceCache = await loadReplayPriceCacheForTrustedContinuity(db);
  const previousTrustedPrices = buildPreviousTrustedPriceLookup(previousAssetsById, syncStartSec, replayPriceCache);
  let gtProbe = { updatedCount: 0, stats: createEmptyGtProbeStats() };
  const dlListPrices = buildDlListPrices(assets);
  const primaryPricesAbort = returnIfAborted(signal, "primary-prices");
  if (primaryPricesAbort) return primaryPricesAbort;
  await reportStablecoinsStage(reportProgress, "price-enrichment", "Running primary pricing and enrichment", {
    itemsTotal: assets.length,
  });
  const { results: primaryPriceResults, stats: priceValidationStats } = await fetchPrimaryPrices(
    assets, db, signal, validationReferences, coingeckoApiKey, chainRpcs, dlListPrices,
  );
  const protocolPriceOverrides = await fetchAuthoritativeLivePriceOverrides(assets, signal);
  applyPrimaryPriceResults({
    assets,
    primaryPriceResults,
    previousTrustedPrices,
    validationContexts,
    validationReferences,
    syncStartSec,
    validatePublishablePrice,
  });
  prevalidatePrices({
    assets,
    previousTrustedPrices,
    validationContexts,
    validationReferences,
    validatePublishablePrice,
    modeResolver: () => "primary_authoritative",
    logLabel: "Pre-rejected bad price",
  });
  const missingBefore = new Set(
    assets.filter(hasMissingPrice).map((a) => a.id)
  );
  const enrichAbort = returnIfAborted(signal, "enrich-prices");
  if (enrichAbort) return enrichAbort;
  const enrichStats = await enrichMissingPrices(assets, cmcApiKey, db, signal);
  for (const asset of assets) {
    if (missingBefore.has(asset.id) && !hasMissingPrice(asset) && !asset.priceConfidence) {
      stampPriceMetadata(asset, asset.priceSource || "unknown", "fallback", syncStartSec);
    }
  }

  const gtProbeAbort = returnIfAborted(signal, "gt-probe");
  if (gtProbeAbort) return gtProbeAbort;
  try {
    gtProbe = await runGtProbePass(
      assets, primaryPriceResults, db, signal, validationReferences, coingeckoApiKey,
    );
    const { updatedCount: gtUpdated } = gtProbe;
    if (gtUpdated > 0) {
      applyGtProbeResults({
        assets,
        primaryPriceResults,
        previousTrustedPrices,
        validationContexts,
        validationReferences,
        syncStartSec,
        validatePublishablePrice,
      });
      console.log(`[sync-stablecoins] GT probe updated ${gtUpdated} asset prices`);
    }
  } catch (err) {
    if (signal?.aborted) return abortResult(signal, "gt-probe");
    console.warn("[sync-stablecoins] GT probe failed (non-fatal):", err);
  }

  const protocolOverrideCount = applyProtocolPriceOverrides({
    assets,
    overrides: protocolPriceOverrides,
    previousTrustedPrices,
    validationContexts,
    validationReferences,
    syncStartSec,
    validatePublishablePrice,
  });
  if (protocolOverrideCount > 0) {
    console.log(`[sync-stablecoins] Applied ${protocolOverrideCount} protocol-backed price override${protocolOverrideCount === 1 ? "" : "s"}`);
  }

  const priceResult = await runPostEnrichmentPricePipeline({
    assets,
    missingBefore,
    db,
    syncStartSec,
    signal,
    fxFallbackRates,
    validationReferences,
    validationContexts,
    priceValidationModeForAsset,
    validatePublishablePrice,
    previousTrustedPrices,
    returnIfAborted,
    abortResult,
  }, "");
  if (isAbortResult(priceResult)) return priceResult;
  const { rejectedCount, cachedFallbackCount } = priceResult;
  if (rejectedCount > 0) {
    console.log(`[sync-stablecoins] Rejected ${rejectedCount} unreasonable prices`);
  }
  if (cachedFallbackCount > 0) {
    console.log(`[sync-stablecoins] Applied ${cachedFallbackCount} cached fallback prices`);
  }
  await reportStablecoinsStage(reportProgress, "price-validation", "Validated stablecoin prices", {
    itemsDone: assets.length - assets.filter(hasMissingPrice).length,
    itemsTotal: assets.length,
    metadata: {
      rejectedPrices: rejectedCount,
      cachedFallbackPrices: cachedFallbackCount,
      gtProbeUpdates: gtProbe.updatedCount,
    },
  });

  const fillSupplyHistoryResult = await fillStablecoinsSupplyHistoryFromSnapshots(db, assets, signal);
  if (fillSupplyHistoryResult) return fillSupplyHistoryResult;

  const stalenessCheck = await checkStablecoinsPriceStaleness({
    db,
    assets,
    signal,
    reportProgress,
    progressStage: "staleness-check",
    progressMessage: "Checking stablecoin price staleness",
    abortStage: "detect-price-staleness",
    failureLabel: "Staleness check",
    blockedResultFactory: (summary) => ({
      status: "degraded",
      itemCount: assets.length,
      metadata: buildSyncMetadata({
        rowsRead: rawAssetCount,
        rowsWritten: 0,
        rowsDropped: droppedMalformedAssets,
        sourceCoverage: { defillama: true },
        fallbackMode: "stale-prices-blocked",
        validationFailures: 1,
        stalenessWarning: true,
        priceStaleness: summary,
        staleWriteBlocked: true,
        upstreamFetchOk: true,
        payloadAccepted: false,
        cacheWriteSucceeded: false,
        depegPipelineSucceeded: false,
      }, {
        cacheWriteMode: "no-write",
        capabilities: {
          stablecoinsCache: false,
          depegPipeline: false,
        },
      }),
    }),
  });
  if (stalenessCheck.blockedResult) {
    await recordOutcome(db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    return stalenessCheck.blockedResult;
  }
  const { stalenessWarning, stalenessSummary } = stalenessCheck;

  const validationAbort = returnIfAborted(signal, "validate-stablecoins-payload");
  if (validationAbort) return validationAbort;
  await reportStablecoinsStage(reportProgress, "cache-validation", "Validating stablecoins cache payload", {
    itemsDone: assets.length,
    itemsTotal: assets.length,
  });
  const cacheResult = await validateAndWriteStablecoinsCache({
    assets,
    fxFallbackRates,
    db,
    syncStartSec,
    signal,
    alertWebhookUrl,
    validationContext: "main",
    returnIfAborted,
    abortResult,
  }, (stablecoinsCacheAgeSec) => ({
    status: "degraded",
    itemCount: assets.length,
    metadata: buildSyncMetadata({
      rowsRead: rawAssetCount,
      rowsWritten: 0,
      rowsDropped: droppedMalformedAssets,
      sourceCoverage: { defillama: true },
      fallbackMode: null,
      validationFailures: 1,
      validationContext: "main",
      stablecoinsCacheAgeSec,
      cacheWriteMode: "blocked-invalid-payload",
    }, {
      cacheWriteMode: "blocked-invalid-payload",
      capabilities: {
        stablecoinsCache: false,
        depegPipeline: false,
      },
    }),
  }));
  if (isAbortResult(cacheResult)) return cacheResult;
  if (!cacheResult.written) {
    await recordOutcome(db, CIRCUIT_SOURCE.DL_STABLECOINS, true);
    return cacheResult.blockedResult!;
  }
  await reportStablecoinsStage(reportProgress, "cache-write", "Published stablecoins cache", {
    itemsDone: assets.length,
    itemsTotal: assets.length,
  });
  await recordOutcome(db, CIRCUIT_SOURCE.DL_STABLECOINS, true);
  await queueTrackedAdditionsNotice(db, previousAssetsById.keys(), assets);

  await reportStablecoinsStage(reportProgress, "depeg-pipeline", "Running depeg pipeline", {
    itemsTotal: assets.length,
  });
  const depegResult = await runDepegPipeline(
    db, assets, fxFallbackRates, signal, coingeckoApiKey,
    returnIfAborted, abortResult, "", "",
  );
  if (isAbortResult(depegResult)) return depegResult;
  const { depegErrorCount, depegErrors } = depegResult;

  const result = buildStablecoinsSyncResult({
    assets,
    rawAssetCount,
    droppedMalformedAssets,
    canonicalDeduplication,
    enrichStats,
    priceValidationStats,
    rejectedCount,
    stalenessWarning,
    stalenessSummary,
    gtProbe,
    depegErrorCount,
    depegErrors,
    upstreamFetchOk: true,
    payloadAccepted: true,
    cacheWriteSucceeded: true,
    depegPipelineSucceeded: depegErrorCount === 0,
  });
  await reportStablecoinsStage(reportProgress, "complete", "Completed stablecoins sync", {
    itemsDone: assets.length,
    itemsTotal: assets.length,
    metadata: {
      path: "main",
      status: result.status ?? "ok",
    },
  });
  return result;
}

async function fillStablecoinsSupplyHistoryFromSnapshots(
  db: D1Database,
  assets: PeggedAsset[],
  signal?: AbortSignal,
): Promise<CronResult | null> {
  try {
    const fillAbort = returnIfAborted(signal, "fill-supply-history");
    if (fillAbort) return fillAbort;
    const fillCount = await fillMissingSupplyHistory(db, assets, signal);
    if (fillCount > 0) {
      console.log(`[sync-stablecoins] Filled ${fillCount} missing supply changes from supply_history`);
    }
  } catch (err) {
    if (signal?.aborted) return abortResult(signal, "fill-supply-history");
    console.warn("[sync-stablecoins] supply_history fallback failed:", err);
  }

  return null;
}
