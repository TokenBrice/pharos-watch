import type { CronResult } from "./sync-stablecoins/shared";
import type { OnchainPartitionSummary } from "@shared/types/status/cron";
import {
  loadStablecoinsPublicationContinuity,
  runStablecoinsPostIntakePublication,
} from "./sync-stablecoins/publication";
import {
  returnIfAborted,
} from "./sync-stablecoins/runtime";
import {
  runStablecoinsPricingStage,
} from "./sync-stablecoins/stages";
import type { ChainRpcConfig } from "../lib/chain-registry";
import type { DwellirNativeCapability } from "../lib/dwellir-native";
import type { CronProgressReporter } from "../lib/cron-logger";
import { createBinanceFetchSession } from "../lib/cex-tickers";
import { createNativePegQuoteSession } from "../lib/native-peg-quotes";
import { createD1CostTracker } from "../lib/d1-cost";
import { loadStablecoinsIntake } from "./sync-stablecoins/intake";
import { syncViaCoingeckoFallback } from "./sync-stablecoins/fallback";

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
  let onchainPartition: OnchainPartitionSummary | null = null;
  const withD1Cost = (result: CronResult): CronResult => ({
    ...result,
    metadata: JSON.stringify({
      ...JSON.parse(result.metadata ?? "{}"),
      d1Cost: d1Cost.snapshot(),
      onchainPartition,
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
  const intake = await loadStablecoinsIntake({
    reportPartitionSummary: (summary) => { onchainPartition = summary; },
    db,
    syncStartSec,
    signal,
    coingeckoApiKey,
    chainRpcs,
    dwellirNative,
    reportProgress,
    fallbackToCoingecko: (cgData) => syncViaCoingeckoFallback(
      db, cgData, cmcApiKey, syncStartSec, signal, coingeckoApiKey,
      reportProgress, jupiterApiKey, chainRpcs, dwellirNative,
    ),
  });
  if (intake.kind === "withheld") return withD1Cost(intake.result);
  if (intake.kind === "fallback") {
    if (intake.result.itemCount && intake.result.itemCount > 0) {
      return withD1Cost(intake.result);
    }
    throw new Error(intake.errorMessage);
  }
  // Destructure every consumed field so nothing references `intake` past this
  // point: the intake result also carries cgData, canonicalDeduplication's
  // deduped rows, and other intake-only payloads that would otherwise stay
  // pinned on the isolate heap for the rest of the run.
  const {
    assets,
    rawAssetCount,
    droppedMalformedAssets,
    canonicalDeduplication: { duplicateRows, affectedIds },
    supplyGapReconciliation,
    supplyChainGuard,
    trackedCoverage,
    previousAssetsById,
    previousCacheState,
    fxFallbackRates,
    validationReferences,
  } = intake;
  const { state: _guardState, ...supplyChainGuardMetadata } = supplyChainGuard;
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
  if (!("priceCacheEntries" in pricingStage)) return withD1Cost(pricingStage);
  const { metadata: pricingMetadata, priceCacheEntries, providerDiagnostics } = pricingStage;
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
    reportProgress,
    binanceSession,
    nativePegSession,
    metadata: {
      path: "main",
      input: {
        rawAssetCount,
        droppedMalformedAssets,
        canonicalDeduplication: { duplicateRows, affectedIds },
        ...pricingMetadata,
        supplyGapReconciliation,
        supplyChainGuard: supplyChainGuardMetadata,
        trackedCoverage,
        upstreamFetchOk: true,
        payloadAccepted: true,
        cacheWriteSucceeded: true,
      },
    },
  }).then(withD1Cost);
}
