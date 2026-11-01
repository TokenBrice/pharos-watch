import { logWorkerEventArgs } from "../../lib/structured-log";
import { WORKER_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/worker-runtime-registry";
import { recordOutcome } from "../../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import type { PricingProviderAttemptDiagnostic } from "../../lib/pricing-provider-diagnostics";
import type { PriceCacheWriteEntry } from "../../lib/db-cache";
import type { CronProgressReporter } from "../../lib/cron-logger";
import type { BinanceFetchSession } from "../../lib/cex-tickers";
import type { NativePegQuoteSession } from "../../lib/native-peg-quotes";
import {
  ACTIVE_PRICE_COVERAGE_ALERT_GENERATIONS,
  resolveStablecoinPriceGapReviews,
  evaluateStablecoinActivePriceCoverage,
  loadPreviousStablecoinActivePriceCoverage,
  seedAbsentActivePriceCoverageMarketCaps,
  type PreviousStablecoinActivePriceCoverage,
  type StablecoinPriceCoverageAsset,
} from "../../lib/stablecoin-publication-coverage";
import { fillMissingSupplyHistory } from "./phase-helpers";
import {
  commitReplayPriceCache,
  validateAndWriteStablecoinsCache,
} from "./cache-publication";
import {
  buildFallbackStablecoinsSyncResult,
  buildBlockedInvalidPayloadResult,
  buildSkippedNewerCacheResult,
  buildStablecoinsSyncResult,
} from "./metadata";
import { isAbortResult, runDepegPipeline } from "./post-enrichment";
import {
  abortResult,
  returnIfAborted,
  checkStablecoinsPriceStaleness,
  reportStablecoinsStage,
  type StablecoinsStalenessSummary,
} from "./runtime";
import { buildSyncMetadata, type CronResult, type PreviousStablecoinsCacheState } from "./shared";
import { isFallbackBackedTrackedBaseline, queueTrackedAdditionsNotice } from "./telegram-tracked-additions";
import type { PeggedAsset } from "./enrich-prices";
import { persistChainDropoutState, type SupplyChainGuardResult } from "./chain-dropout-guard";

type MainMetadataInput = Omit<
  Parameters<typeof buildStablecoinsSyncResult>[0],
  | "assets"
  | "providerDiagnostics"
  | "stalenessWarning"
  | "stalenessSummary"
  | "stalenessCheckFailed"
  | "stalenessCheckFailureReason"
  | "depegErrorCount"
  | "depegErrors"
  | "depegHeldReason"
  | "depegObservation"
  | "depegObservationUnavailableReason"
  | "cacheKey"
  | "syncStartSec"
  | "responseReadyCacheError"
  | "depegPipelineSucceeded"
  | "previousActivePriceCoverage"
  | "activePriceCoverage"
>;

type FallbackMetadataInput = Omit<
  Parameters<typeof buildFallbackStablecoinsSyncResult>[0],
  | "assets"
  | "providerDiagnostics"
  | "stalenessWarning"
  | "stalenessSummary"
  | "stalenessCheckFailed"
  | "stalenessCheckFailureReason"
  | "depegErrorCount"
  | "depegHeldReason"
  | "depegObservation"
  | "depegObservationUnavailableReason"
  | "cacheKey"
  | "syncStartSec"
  | "activePriceCoverage"
  | "previousActivePriceCoverage"
>;

interface StablecoinsPublicationLabels {
  stalenessProgressStage: string;
  stalenessProgressMessage: string;
  stalenessAbortStage: string;
  stalenessWarningLabel?: string;
  stalenessFailureLabel: string;
  cacheValidationAbortStage?: string;
  cacheValidationProgressStage: string;
  cacheValidationProgressMessage: string;
  cacheWriteProgressStage: string;
  cacheWriteProgressMessage: string;
  priceCacheStagePrefix?: string;
  depegProgressStage: string;
  depegProgressMessage: string;
  depegAbortStagePrefix: string;
  depegLogContext: string;
  completeMessage: string;
  productivityReason: string;
  productivityValidationSummary?: Record<string, unknown>;
}


export async function loadStablecoinsPublicationContinuity(
  db: D1Database,
  syncStartSec: number,
): Promise<{
  previousActivePriceCoverage: PreviousStablecoinActivePriceCoverage | null;
  previousMissingGenerationsById: Map<string, number>;
}> {
  const previousRead = await loadPreviousStablecoinActivePriceCoverage(db, syncStartSec);
  const previousActivePriceCoverage = previousRead.status === "ok" ? previousRead.coverage
    : previousRead.status === "missing" ? null
      : { missingActiveIds: [], missingActiveAssets: [], unavailableReason: previousRead.reason };
  const reviews = resolveStablecoinPriceGapReviews(WORKER_ACTIVE_STABLECOINS.map((asset) => asset.id), syncStartSec);
  // Provider input is a priority projection, not persisted continuity evidence.
  // Unknown continuity stays conservatively alert-eligible, but cannot prioritize every provider lookup.
  const priorityEntries: [string, number][] = previousRead.status === "read-error"
    ? []
    : (previousActivePriceCoverage?.missingActiveAssets ?? []).map((detail) => [
        detail.stablecoinId, detail.consecutiveMissingGenerations ?? ACTIVE_PRICE_COVERAGE_ALERT_GENERATIONS,
      ]);
  return {
    previousActivePriceCoverage,
    previousMissingGenerationsById: new Map(priorityEntries.filter(([id]) => !reviews.activeById.has(id))),
  };
}

function publicationLabels(path: "main" | "fallback"): StablecoinsPublicationLabels {
  return path === "main" ? {
      stalenessProgressStage: "staleness-check",
      stalenessProgressMessage: "Checking stablecoin price staleness",
      stalenessAbortStage: "detect-price-staleness",
      stalenessFailureLabel: "Staleness check",
      cacheValidationAbortStage: "validate-stablecoins-payload",
      cacheValidationProgressStage: "cache-validation",
      cacheValidationProgressMessage: "Validating stablecoins cache payload",
      cacheWriteProgressStage: "cache-write",
      cacheWriteProgressMessage: "Published stablecoins cache",
      depegProgressStage: "depeg-pipeline",
      depegProgressMessage: "Running depeg pipeline",
      depegAbortStagePrefix: "",
      depegLogContext: "",
      completeMessage: "Completed stablecoins sync",
      productivityReason: "stablecoins-cache-published",
    } : {
      stalenessProgressStage: "fallback-staleness-check",
      stalenessProgressMessage: "Checking fallback price staleness",
      stalenessAbortStage: "fallback-detect-price-staleness",
      stalenessWarningLabel: "(fallback)",
      stalenessFailureLabel: "Fallback staleness check",
      cacheValidationProgressStage: "fallback-cache-validation",
      cacheValidationProgressMessage: "Validating CoinGecko fallback payload",
      cacheWriteProgressStage: "fallback-cache-write",
      cacheWriteProgressMessage: "Published CoinGecko fallback payload",
      priceCacheStagePrefix: "fallback-",
      depegProgressStage: "fallback-depeg-pipeline",
      depegProgressMessage: "Running fallback depeg pipeline",
      depegAbortStagePrefix: "fallback-",
      depegLogContext: " (CG fallback)",
      completeMessage: "Completed stablecoins fallback sync",
      productivityReason: "stablecoins-fallback-cache-published",
      productivityValidationSummary: { publicationPath: "coingecko-fallback" },
    };
}

interface StablecoinsPostIntakePublicationBase {
  db: D1Database;
  assets: PeggedAsset[];
  previousAssetsById: Map<string, PeggedAsset>;
  previousCacheState: PreviousStablecoinsCacheState;
  previousActivePriceCoverage: PreviousStablecoinActivePriceCoverage | null;
  syncStartSec: number;
  signal?: AbortSignal;
  reportProgress?: CronProgressReporter;
  coingeckoApiKey?: string | null;
  fxFallbackRates?: Record<string, number>;
  priceCacheEntries: PriceCacheWriteEntry[];
  providerDiagnostics: PricingProviderAttemptDiagnostic[];
  supplyChainGuard?: SupplyChainGuardResult;
  binanceSession?: BinanceFetchSession;
  nativePegSession?: NativePegQuoteSession;
}

export type StablecoinsPostIntakePublicationContext = StablecoinsPostIntakePublicationBase & (
  | { metadata: { path: "main"; input: MainMetadataInput } }
  | { metadata: { path: "fallback"; input: FallbackMetadataInput } }
);

async function fillStablecoinsSupplyHistory(
  input: StablecoinsPostIntakePublicationContext,
): Promise<CronResult | null> {
  const main = input.metadata.path === "main";
  const stage = main ? "fill-supply-history" : "fallback-fill-supply-history";
  try {
    const fillAbort = returnIfAborted(input.signal, stage);
    if (fillAbort) return fillAbort;
    const fillCount = await fillMissingSupplyHistory(input.db, input.assets, input.signal);
    if (fillCount > 0 && main) {
      logWorkerEventArgs(
        "handler",
        "info",
        `[sync-stablecoins] Filled ${fillCount} missing supply changes from supply_history`,
      );
    }
  } catch (error) {
    if (input.signal?.aborted) return abortResult(input.signal, stage);
    logWorkerEventArgs("handler", "warn", "[sync-stablecoins] supply_history fallback failed:", error);
  }
  return null;
}

export async function runStablecoinsPostIntakePublication(
  input: StablecoinsPostIntakePublicationContext,
): Promise<CronResult> {
  const supplyHistoryResult = await fillStablecoinsSupplyHistory(input);
  if (supplyHistoryResult) return supplyHistoryResult;

  const main = input.metadata.path === "main";
  const labels = publicationLabels(input.metadata.path);
  const rowsRead = input.metadata.path === "main" ? input.metadata.input.rawAssetCount : input.assets.length;
  const rowsDropped = input.metadata.path === "main" ? input.metadata.input.droppedMalformedAssets : 0;
  const sourceCoverage = main ? { defillama: true } : { defillama: false, coingeckoFallbackAssets: input.assets.length };
  const fallbackMode = main ? null : "coingecko-supply-fallback";
  const blockedResult = (summary: StablecoinsStalenessSummary): CronResult => ({
    status: "degraded",
    itemCount: input.assets.length,
    metadata: buildSyncMetadata({
      rowsRead, rowsWritten: 0, rowsDropped, sourceCoverage,
      fallbackMode: main ? "stale-prices-blocked" : "coingecko-supply-fallback-stale-blocked",
      validationFailures: 1,
      stalenessWarning: true, priceStaleness: summary, staleWriteBlocked: true,
      upstreamFetchOk: main, payloadAccepted: false, cacheWriteSucceeded: false, depegPipelineSucceeded: false,
    }, {
      cacheWriteMode: "no-write",
      capabilities: { stablecoinsCache: false, depegPipeline: false },
    }),
  });
  const staleness = await checkStablecoinsPriceStaleness({
    previousAssetsById: input.previousAssetsById,
    previousCacheState: input.previousCacheState,
    assets: input.assets,
    signal: input.signal,
    reportProgress: input.reportProgress,
    progressStage: labels.stalenessProgressStage,
    progressMessage: labels.stalenessProgressMessage,
    abortStage: labels.stalenessAbortStage,
    warningLabel: labels.stalenessWarningLabel,
    failureLabel: labels.stalenessFailureLabel,
    blockedResultFactory: blockedResult,
  });
  if (staleness.blockedResult) {
    if (staleness.blockedReason === "severe-staleness" && main) {
      await recordOutcome(input.db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    }
    return staleness.blockedResult;
  }

  // Retain only continuity evidence across the schema/serialization heap peak.
  const previousPriceEvidence = new Map<string, StablecoinPriceCoverageAsset>();
  for (const [id, asset] of input.previousAssetsById) {
    previousPriceEvidence.set(id, {
      id, price: asset.price, priceSource: asset.priceSource, priceConfidence: asset.priceConfidence,
      priceObservedAt: asset.priceObservedAt, priceObservedAtMode: asset.priceObservedAtMode,
      priceUpdatedAt: asset.priceUpdatedAt, supplyObservedAt: asset.supplyObservedAt,
      circulating: asset.circulating,
    });
  }
  const previousAssetIds = new Set(input.previousAssetsById.keys());
  const previousBaselineFallbackBacked = isFallbackBackedTrackedBaseline(input.previousAssetsById.values());
  input.previousAssetsById.clear();

  if (labels.cacheValidationAbortStage) {
    const validationAbort = returnIfAborted(input.signal, labels.cacheValidationAbortStage);
    if (validationAbort) return validationAbort;
  }
  await reportStablecoinsStage(
    input.reportProgress,
    labels.cacheValidationProgressStage,
    labels.cacheValidationProgressMessage,
    { itemsDone: input.assets.length, itemsTotal: input.assets.length },
  );
  const cacheResult = await validateAndWriteStablecoinsCache({
    assets: input.assets,
    fxFallbackRates: input.fxFallbackRates,
    db: input.db,
    syncStartSec: input.syncStartSec,
    signal: input.signal,
    validationContext: input.metadata.path,
  }, (stablecoinsCacheAgeSec) => buildBlockedInvalidPayloadResult({
    rowsRead, rowsDropped, sourceCoverage, fallbackMode,
    validationContext: input.metadata.path, stablecoinsCacheAgeSec, itemCount: input.assets.length,
  }));
  if (isAbortResult(cacheResult)) return cacheResult;
  if (!cacheResult.written) {
    if (main) await recordOutcome(input.db, CIRCUIT_SOURCE.DL_STABLECOINS, true);
    if (!cacheResult.skippedBecauseNewer) return cacheResult.blockedResult!;
    return buildSkippedNewerCacheResult({
      rowsRead, rowsDropped, sourceCoverage, fallbackMode,
      cacheKey: cacheResult.cacheKey,
      syncStartSec: cacheResult.syncStartSec,
      upstreamFetchOk: input.metadata.path === "main",
    });
  }
  const activePriceCoverage = evaluateStablecoinActivePriceCoverage(input.assets, undefined, {
    nowSec: input.syncStartSec,
    previousCoverage: input.previousActivePriceCoverage,
    previousAcceptedAssetsById: previousPriceEvidence,
  });
  previousPriceEvidence.clear();
  await seedAbsentActivePriceCoverageMarketCaps(input.db, activePriceCoverage, Math.floor(Date.now() / 1000));
  const admittedAssetIds = new Set(input.assets.map((asset) => asset.id));

  if (input.supplyChainGuard) {
    await persistChainDropoutState(input.db, input.supplyChainGuard, input.syncStartSec, input.signal);
  }

  await reportStablecoinsStage(
    input.reportProgress,
    labels.cacheWriteProgressStage,
    labels.cacheWriteProgressMessage,
    { itemsDone: input.assets.length, itemsTotal: input.assets.length },
  );
  const priceCacheCommit = await commitReplayPriceCache({
    db: input.db,
    entries: input.priceCacheEntries.filter((entry) => admittedAssetIds.has(entry.id)),
    signal: input.signal,
    stagePrefix: labels.priceCacheStagePrefix,
  });
  if (priceCacheCommit) return priceCacheCommit;
  if (main) await recordOutcome(input.db, CIRCUIT_SOURCE.DL_STABLECOINS, true);

  await queueTrackedAdditionsNotice(input.db, previousAssetIds, input.assets, { previousBaselineFallbackBacked });
  await reportStablecoinsStage(
    input.reportProgress,
    labels.depegProgressStage,
    labels.depegProgressMessage,
    { itemsTotal: input.assets.length },
  );
  const depegResult = await runDepegPipeline(
    input.db,
    input.assets,
    input.fxFallbackRates,
    input.signal,
    input.coingeckoApiKey,
    labels.depegAbortStagePrefix,
    labels.depegLogContext,
    input.binanceSession,
    input.nativePegSession,
  );
  if (isAbortResult(depegResult)) return depegResult;

  const providerDiagnostics = [...input.providerDiagnostics, ...depegResult.providerDiagnostics];
  const completion = {
    assets: input.assets,
    providerDiagnostics,
    stalenessWarning: staleness.stalenessWarning,
    stalenessSummary: staleness.stalenessSummary,
    stalenessCheckFailed: staleness.stalenessCheckFailed,
    stalenessCheckFailureReason: staleness.stalenessCheckFailureReason,
    depegErrorCount: depegResult.depegErrorCount,
    depegHeldReason: depegResult.depegHeldReason,
    depegObservation: depegResult.depegObservation,
    depegObservationUnavailableReason: depegResult.depegObservationUnavailableReason,
    cacheKey: cacheResult.cacheKey,
    syncStartSec: cacheResult.syncStartSec,
    activePriceCoverage,
  };
  const result = input.metadata.path === "main"
    ? buildStablecoinsSyncResult({
        ...input.metadata.input, ...completion,
        depegErrors: depegResult.depegErrors,
        responseReadyCacheError: cacheResult.responseReadyCacheError,
        depegPipelineSucceeded: !depegResult.depegHeldReason && depegResult.depegErrorCount === 0,
        previousActivePriceCoverage: input.previousActivePriceCoverage,
      })
    : buildFallbackStablecoinsSyncResult({
        ...input.metadata.input, ...completion,
        previousActivePriceCoverage: input.previousActivePriceCoverage,
      });

  await reportStablecoinsStage(input.reportProgress, "complete", labels.completeMessage, {
    itemsDone: input.assets.length,
    itemsTotal: input.assets.length,
    metadata: {
      path: input.metadata.path,
      status: result.status ?? "ok",
    },
  });
  return {
    ...result,
    productivity: {
      productive: true,
      reason: labels.productivityReason,
      publications: [{
        surface: "stablecoins",
        generationId: `stablecoins:${cacheResult.syncStartSec}`,
        publishedAt: cacheResult.syncStartSec,
        // `input.assets` already excludes rows the publication boundary quarantined (DEC-03).
        candidateRows: input.assets.length + cacheResult.quarantinedAssets.length,
        publishedRows: input.assets.length,
        expectedRows: input.assets.length,
        artifactCacheKey: cacheResult.cacheKey,
        ...(labels.productivityValidationSummary
          ? { validationSummary: labels.productivityValidationSummary }
          : {}),
      }],
    },
  };
}
