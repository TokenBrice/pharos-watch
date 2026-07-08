import {
  buildSyncMetadata,
  type CronResult,
} from "./sync-stablecoins/shared";
import { isAbortResult } from "./sync-stablecoins/post-enrichment";
import { buildStablecoinsSyncResult } from "./sync-stablecoins/metadata";
import { publishMainStablecoinsAndRunFollowThrough } from "./sync-stablecoins/main-publication";
import {
  abortResult,
  checkStablecoinsPriceStaleness,
  fillStablecoinsSupplyHistoryStage,
  recordStablecoinsStalenessBlockOutcome,
  reportStablecoinsStage,
  returnIfAborted,
} from "./sync-stablecoins/runtime";
import {
  runStablecoinsIntakeStage,
  runStablecoinsPricingStage,
} from "./sync-stablecoins/stages";
import type { ChainRpcConfig } from "../lib/chain-registry";
import type { CronProgressReporter } from "../lib/cron-logger";

export interface SyncStablecoinsOptions {
  cmcApiKey?: string;
  alertWebhookUrl?: string | null;
  coingeckoApiKey?: string | null;
  chainRpcs?: Map<string, ChainRpcConfig>;
  reportProgress?: CronProgressReporter;
  jupiterApiKey?: string | null;
  addressPriceProvider?: Parameters<typeof runStablecoinsPricingStage>[0]["addressPriceProvider"];
}

export async function syncStablecoins(
  db: D1Database,
  signal?: AbortSignal,
  options: SyncStablecoinsOptions = {},
): Promise<CronResult> {
  const {
    cmcApiKey,
    alertWebhookUrl,
    coingeckoApiKey,
    chainRpcs,
    reportProgress,
    jupiterApiKey,
    addressPriceProvider,
  } = options;
  const startAbort = returnIfAborted(signal, "start");
  if (startAbort) return startAbort;
  const syncStartSec = Math.floor(Date.now() / 1000);
  const intake = await runStablecoinsIntakeStage({
    db,
    syncStartSec,
    cmcApiKey,
    jupiterApiKey,
    signal,
    alertWebhookUrl,
    coingeckoApiKey,
    chainRpcs,
    reportProgress,
  });
  if (!("kind" in intake)) return intake;
  if (intake.kind === "fallback") {
    if (intake.result.itemCount && intake.result.itemCount > 0) {
      return intake.result;
    }
    throw new Error(intake.errorMessage);
  }
  const { assets, rawAssetCount, droppedMalformedAssets, canonicalDeduplication, supplyGapReconciliation, trackedCoverage } = intake;
  const pricingStage = await runStablecoinsPricingStage({
    db,
    assets,
    previousAssetsById: intake.previousAssetsById,
    syncStartSec,
    fxFallbackRates: intake.fxFallbackRates,
    validationReferences: intake.validationReferences,
    cmcApiKey,
    jupiterApiKey,
    signal,
    coingeckoApiKey,
    chainRpcs,
    addressPriceProvider,
    reportProgress,
  });
  if ("enrichStats" in pricingStage === false) return pricingStage;
  const {
    enrichStats,
    priceValidationStats,
    gtProbe,
    authoritativeOverrideCount,
    authoritativeOverrideStats,
    rejectedCount,
    nativePegCorrectionCount,
    nativePegFillCount,
    priceCacheEntries,
    providerDiagnostics,
  } = pricingStage;
  const fillSupplyHistoryResult = await fillStablecoinsSupplyHistoryStage(db, assets, signal);
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
    await recordStablecoinsStalenessBlockOutcome(db, stalenessCheck, alertWebhookUrl);
    return stalenessCheck.blockedResult;
  }
  const {
    stalenessWarning,
    stalenessSummary,
    stalenessCheckFailed,
    stalenessCheckFailureReason,
  } = stalenessCheck;
  const publication = await publishMainStablecoinsAndRunFollowThrough({
    assets,
    fxFallbackRates: intake.fxFallbackRates,
    db,
    syncStartSec,
    signal,
    alertWebhookUrl,
    coingeckoApiKey,
    rawAssetCount,
    droppedMalformedAssets,
    priceCacheEntries,
    previousAssetsById: intake.previousAssetsById,
    returnIfAborted,
    abortResult,
    reportProgress,
  });
  if (isAbortResult(publication)) return publication;
  if (!("cacheResult" in publication)) return publication;
  const { cacheResult, depegErrorCount, depegErrors, providerDiagnostics: depegProviderDiagnostics = [] } = publication;
  const result = buildStablecoinsSyncResult({
    assets,
    rawAssetCount,
    droppedMalformedAssets,
    canonicalDeduplication,
    enrichStats,
    priceValidationStats, providerDiagnostics: [...providerDiagnostics, ...depegProviderDiagnostics],
    authoritativeOverrideCount,
    authoritativeOverrideStats,
    rejectedCount,
    nativePegCorrectionCount,
    nativePegFillCount,
    stalenessWarning,
    stalenessSummary,
    stalenessCheckFailed,
    stalenessCheckFailureReason,
    supplyGapReconciliation,
    trackedCoverage,
    gtProbe,
    depegErrorCount,
    depegErrors,
    upstreamFetchOk: true,
    payloadAccepted: true,
    cacheWriteSucceeded: true,
    cacheKey: cacheResult.cacheKey, syncStartSec: cacheResult.syncStartSec,
    responseReadyCacheError: cacheResult.responseReadyCacheError,
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
