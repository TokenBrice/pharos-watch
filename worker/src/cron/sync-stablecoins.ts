import {
  buildSyncMetadata,
  type CronResult,
} from "./sync-stablecoins/shared";
import {
  validateAndWriteStablecoinsCache,
  runDepegPipeline,
  isAbortResult,
} from "./sync-stablecoins/post-enrichment";
import { buildStablecoinsSyncResult } from "./sync-stablecoins/metadata";
import {
  abortResult,
  checkStablecoinsPriceStaleness,
  fillStablecoinsSupplyHistoryStage,
  reportStablecoinsStage,
  returnIfAborted,
} from "./sync-stablecoins/runtime";
import {
  runStablecoinsIntakeStage,
  runStablecoinsPricingStage,
} from "./sync-stablecoins/stages";
import { queueTrackedAdditionsNotice } from "./sync-stablecoins/telegram-tracked-additions";
import type { ChainRpcConfig } from "../lib/chain-registry";
import { CIRCUIT_SOURCE } from "../lib/constants";
import { recordOutcome } from "../lib/circuit-breaker";
import type { CronProgressReporter } from "../lib/cron-logger";

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
  const intake = await runStablecoinsIntakeStage({
    db,
    syncStartSec,
    cmcApiKey,
    signal,
    alertWebhookUrl,
    coingeckoApiKey,
    chainRpcs,
    reportProgress,
  });
  if (!("kind" in intake)) {
    return intake;
  }
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
  const pricingStage = await runStablecoinsPricingStage({
    db,
    assets,
    previousAssetsById,
    syncStartSec,
    fxFallbackRates: intake.fxFallbackRates,
    validationReferences: intake.validationReferences,
    cmcApiKey,
    signal,
    coingeckoApiKey,
    chainRpcs,
    reportProgress,
  });
  if ("enrichStats" in pricingStage === false) return pricingStage;
  const {
    enrichStats,
    priceValidationStats,
    gtProbe,
    authoritativeOverrideCount,
    rejectedCount,
    nativePegCorrectionCount,
    nativePegFillCount,
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
    fxFallbackRates: intake.fxFallbackRates,
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
    db, assets, intake.fxFallbackRates, signal, coingeckoApiKey,
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
    authoritativeOverrideCount,
    rejectedCount,
    nativePegCorrectionCount,
    nativePegFillCount,
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
