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
import type { DwellirNativeCapability } from "../lib/dwellir-native";
import type { CronProgressReporter } from "../lib/cron-logger";
import { createBinanceFetchSession } from "../lib/cex-tickers";
import { createNativePegQuoteSession } from "../lib/native-peg-quotes";
import { createD1CostTracker } from "../lib/d1-cost";

export interface SyncStablecoinsOptions {
  cmcApiKey?: string;
  coingeckoApiKey?: string | null;
  chainRpcs?: Map<string, ChainRpcConfig>;
  dwellirNative?: DwellirNativeCapability;
  reportProgress?: CronProgressReporter;
  jupiterApiKey?: string | null;
}

export async function syncStablecoins(
  db: D1Database,
  signal?: AbortSignal,
  options: SyncStablecoinsOptions = {},
): Promise<CronResult> {
  const d1Cost = createD1CostTracker(db, ["outer-cron-lifecycle-excluded"]);
  db = d1Cost.db;
  const withD1Cost = (result: CronResult): CronResult => ({
    ...result,
    metadata: JSON.stringify({
      ...JSON.parse(result.metadata ?? "{}"),
      d1Cost: d1Cost.snapshot(),
    }),
  });
  const {
    cmcApiKey,
    coingeckoApiKey,
    chainRpcs,
    dwellirNative,
    reportProgress,
    jupiterApiKey,
  } = options;
  const startAbort = returnIfAborted(signal, "start");
  if (startAbort) return withD1Cost(startAbort);
  const syncStartSec = Math.floor(Date.now() / 1000);
  const binanceSession = createBinanceFetchSession();
  // Per-run memo shared by native-peg hardening, depeg detection, and
  // pending-depeg confirmation. Their geckoId sets overlap but are rarely
  // identical, so a later caller reuses a cached batch only when it already
  // covers every id that caller needs — coverage-based reuse, not general
  // partial-overlap deduplication. Failed/non-2xx/malformed batches are evicted
  // so they never suppress a later caller's own attempt.
  const nativePegSession = createNativePegQuoteSession();
  const intake = await runStablecoinsIntakeStage({
    db,
    syncStartSec,
    cmcApiKey,
    jupiterApiKey,
    signal,
    coingeckoApiKey,
    chainRpcs,
    dwellirNative,
    reportProgress,
  });
  if (!("kind" in intake)) return withD1Cost(intake);
  if (intake.kind === "fallback") {
    if (intake.result.itemCount && intake.result.itemCount > 0) {
      return withD1Cost(intake.result);
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
    supplyChainGuard,
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
    binanceSession,
    reportProgress,
    nativePegSession,
  });
  if ("enrichStats" in pricingStage === false) return withD1Cost(pricingStage);
  const {
    enrichStats,
    priceValidationStats,
    gtProbe,
    authoritativeOverrideCount,
    authoritativeOverrideStats,
    rejectedCount,
    nativePegCorrectionCount,
    nativePegFillCount,
    priceObservationEffectiveness,
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
    supplyChainGuard,
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
        priceObservationEffectiveness,
        supplyGapReconciliation,
        supplyChainGuard,
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
  }).then(withD1Cost);
}
