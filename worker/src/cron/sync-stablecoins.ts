import type { CronResult } from "./sync-stablecoins/shared";
import {
  buildMainStablecoinsPublicationPolicy,
  loadStablecoinsPublicationContinuity,
  runStablecoinsPostIntakePublication,
} from "./sync-stablecoins/publication";
import {
  abortResult,
  returnIfAborted,
} from "./sync-stablecoins/runtime";
import {
  runStablecoinsIntakeStage,
  runStablecoinsPricingStage,
} from "./sync-stablecoins/stages";
import type { ChainRpcConfig } from "../lib/chain-registry";
import type { CronProgressReporter } from "../lib/cron-logger";
import { createBinanceFetchSession } from "../lib/cex-tickers";
import { createNativePegQuoteSession } from "../lib/native-peg-quotes";

export interface SyncStablecoinsOptions {
  cmcApiKey?: string;
  coingeckoApiKey?: string | null;
  chainRpcs?: Map<string, ChainRpcConfig>;
  reportProgress?: CronProgressReporter;
  jupiterApiKey?: string | null;
}

export async function syncStablecoins(
  db: D1Database,
  signal?: AbortSignal,
  options: SyncStablecoinsOptions = {},
): Promise<CronResult> {
  const {
    cmcApiKey,
    coingeckoApiKey,
    chainRpcs,
    reportProgress,
    jupiterApiKey,
  } = options;
  const startAbort = returnIfAborted(signal, "start");
  if (startAbort) return startAbort;
  const syncStartSec = Math.floor(Date.now() / 1000);
  const binanceSession = createBinanceFetchSession();
  // Shared across native-peg hardening, depeg detection, and pending-depeg
  // confirmation so their overlapping fiat-peg batches cost one fetch, not three.
  const nativePegSession = createNativePegQuoteSession();
  const intake = await runStablecoinsIntakeStage({
    db,
    syncStartSec,
    cmcApiKey,
    jupiterApiKey,
    signal,
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
  // Destructure every consumed field so nothing references `intake` past this
  // point: the stage result also carries cgData, canonicalDeduplication's
  // deduped rows, and other intake-only payloads that would otherwise stay
  // pinned on the isolate heap for the rest of the run.
  const {
    assets,
    rawAssetCount,
    droppedMalformedAssets,
    canonicalDeduplication,
    supplyGapReconciliation,
    trackedCoverage,
    previousAssetsById,
    previousCacheState,
    fxFallbackRates,
    validationReferences,
  } = intake;
  const { previousActivePriceCoverage, previousMissingGenerationsById } =
    await loadStablecoinsPublicationContinuity(db, syncStartSec);
  const pricingStage = await runStablecoinsPricingStage({
    db,
    assets,
    previousAssetsById,
    previousMissingGenerationsById,
    syncStartSec,
    fxFallbackRates,
    validationReferences,
    signal,
    coingeckoApiKey,
    chainRpcs,
    reportProgress,
    nativePegSession,
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
  return runStablecoinsPostIntakePublication({
    assets,
    previousAssetsById,
    previousCacheState,
    previousActivePriceCoverage,
    fxFallbackRates,
    db,
    syncStartSec,
    signal,
    coingeckoApiKey,
    priceCacheEntries,
    providerDiagnostics,
    returnIfAborted,
    abortResult,
    reportProgress,
    metadata: {
      path: "main",
      input: {
        rawAssetCount,
        droppedMalformedAssets,
        canonicalDeduplication,
        enrichStats,
        priceValidationStats,
        authoritativeOverrideCount,
        authoritativeOverrideStats,
        rejectedCount,
        nativePegCorrectionCount,
        nativePegFillCount,
        supplyGapReconciliation,
        trackedCoverage,
        gtProbe,
        upstreamFetchOk: true,
        payloadAccepted: true,
        cacheWriteSucceeded: true,
      },
    },
    policy: buildMainStablecoinsPublicationPolicy({
      assets,
      rawAssetCount,
      droppedMalformedAssets,
      binanceSession,
      nativePegSession,
    }),
  });
}
