import { logWorkerEventArgs } from "../../lib/structured-log";
import { recordOutcome } from "../../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import type { PricingProviderAttemptDiagnostic } from "../../lib/pricing-provider-diagnostics";
import type { PriceCacheWriteEntry } from "../../lib/db-cache";
import type { CronProgressReporter } from "../../lib/cron-logger";
import type { BinanceFetchSession } from "../../lib/cex-tickers";
import type { NativePegQuoteSession } from "../../lib/native-peg-quotes";
import {
  evaluateStablecoinActivePriceCoverage,
  loadPreviousStablecoinActivePriceCoverage,
  type PreviousStablecoinActivePriceCoverage,
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
  checkStablecoinsPriceStaleness,
  reportStablecoinsStage,
  type StablecoinsStalenessSummary,
} from "./runtime";
import { buildSyncMetadata, type CronResult, type PreviousStablecoinsCacheState } from "./shared";
import { queueTrackedAdditionsNotice } from "./telegram-tracked-additions";
import type { PeggedAsset } from "./enrich-prices";

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
  | "cacheKey"
  | "syncStartSec"
  | "activePriceCoverage"
>;

export interface StablecoinsPublicationLabels {
  supplyHistoryAbortStage: string;
  logSupplyHistoryFillCount: boolean;
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
  completePath: "main" | "fallback";
  productivityReason: string;
  productivityValidationSummary?: Record<string, unknown>;
}

export interface StablecoinsPublicationPathPolicy {
  validationContext: "main" | "fallback";
  labels: StablecoinsPublicationLabels;
  sourceCoverage: Record<string, unknown>;
  fallbackMode: string | null;
  blockedResultBuilder: {
    staleness: (summary: StablecoinsStalenessSummary) => CronResult;
    invalidPayload: (stablecoinsCacheAgeSec: number | null) => CronResult;
  };
  circuitOutcome?: {
    source: string;
    staleBlockSuccess: boolean;
    cacheDecisionSuccess: boolean;
  };
  sharedFetchSessions?: {
    binance?: BinanceFetchSession;
    nativePeg?: NativePegQuoteSession;
  };
}

export async function loadStablecoinsPublicationContinuity(
  db: D1Database,
  syncStartSec: number,
): Promise<{
  previousActivePriceCoverage: PreviousStablecoinActivePriceCoverage | null;
  previousMissingGenerationsById: Map<string, number>;
}> {
  const previousActivePriceCoverage = await loadPreviousStablecoinActivePriceCoverage(db, syncStartSec);
  return {
    previousActivePriceCoverage,
    previousMissingGenerationsById: new Map(
      (previousActivePriceCoverage?.missingActiveAssets ?? []).map(
        (detail) => [detail.stablecoinId, detail.consecutiveMissingGenerations] as const,
      ),
    ),
  };
}

export function buildMainStablecoinsPublicationPolicy(input: {
  assets: PeggedAsset[];
  rawAssetCount: number;
  droppedMalformedAssets: number;
  binanceSession?: BinanceFetchSession;
  nativePegSession?: NativePegQuoteSession;
}): StablecoinsPublicationPathPolicy {
  return {
    validationContext: "main",
    labels: {
      supplyHistoryAbortStage: "fill-supply-history",
      logSupplyHistoryFillCount: true,
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
      completePath: "main",
      productivityReason: "stablecoins-cache-published",
    },
    sourceCoverage: { defillama: true },
    fallbackMode: null,
    blockedResultBuilder: {
      staleness: (summary) => ({
        status: "degraded",
        itemCount: input.assets.length,
        metadata: buildSyncMetadata({
          rowsRead: input.rawAssetCount,
          rowsWritten: 0,
          rowsDropped: input.droppedMalformedAssets,
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
          capabilities: { stablecoinsCache: false, depegPipeline: false },
        }),
      }),
      invalidPayload: (stablecoinsCacheAgeSec) => buildBlockedInvalidPayloadResult({
        rowsRead: input.rawAssetCount,
        rowsDropped: input.droppedMalformedAssets,
        sourceCoverage: { defillama: true },
        fallbackMode: null,
        validationContext: "main",
        stablecoinsCacheAgeSec,
        itemCount: input.assets.length,
      }),
    },
    circuitOutcome: {
      source: CIRCUIT_SOURCE.DL_STABLECOINS,
      staleBlockSuccess: false,
      cacheDecisionSuccess: true,
    },
    sharedFetchSessions: {
      binance: input.binanceSession,
      nativePeg: input.nativePegSession,
    },
  };
}

export function buildFallbackStablecoinsPublicationPolicy(
  assets: PeggedAsset[],
): StablecoinsPublicationPathPolicy {
  const sourceCoverage = { defillama: false, coingeckoFallbackAssets: assets.length };
  return {
    validationContext: "fallback",
    labels: {
      supplyHistoryAbortStage: "fallback-fill-supply-history",
      logSupplyHistoryFillCount: false,
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
      completePath: "fallback",
      productivityReason: "stablecoins-fallback-cache-published",
      productivityValidationSummary: { publicationPath: "coingecko-fallback" },
    },
    sourceCoverage,
    fallbackMode: "coingecko-supply-fallback",
    blockedResultBuilder: {
      staleness: (summary) => ({
        status: "degraded",
        itemCount: assets.length,
        metadata: buildSyncMetadata({
          rowsRead: assets.length,
          rowsWritten: 0,
          rowsDropped: 0,
          sourceCoverage,
          fallbackMode: "coingecko-supply-fallback-stale-blocked",
          validationFailures: 1,
          upstreamFetchOk: false,
          payloadAccepted: false,
          cacheWriteSucceeded: false,
          depegPipelineSucceeded: false,
          stalenessWarning: true,
          priceStaleness: summary,
          staleWriteBlocked: true,
        }, {
          cacheWriteMode: "no-write",
          capabilities: { stablecoinsCache: false, depegPipeline: false },
        }),
      }),
      invalidPayload: (stablecoinsCacheAgeSec) => buildBlockedInvalidPayloadResult({
        rowsRead: assets.length,
        rowsDropped: 0,
        sourceCoverage,
        fallbackMode: "coingecko-supply-fallback",
        validationContext: "fallback",
        stablecoinsCacheAgeSec,
        itemCount: assets.length,
      }),
    },
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
  returnIfAborted: (signal: AbortSignal | undefined, stage: string) => CronResult | null;
  abortResult: (signal: AbortSignal | undefined, stage: string) => CronResult;
  policy: StablecoinsPublicationPathPolicy;
}

export type StablecoinsPostIntakePublicationContext = StablecoinsPostIntakePublicationBase & (
  | { metadata: { path: "main"; input: MainMetadataInput } }
  | { metadata: { path: "fallback"; input: FallbackMetadataInput } }
);

async function fillStablecoinsSupplyHistory(
  input: StablecoinsPostIntakePublicationContext,
): Promise<CronResult | null> {
  const stage = input.policy.labels.supplyHistoryAbortStage;
  try {
    const fillAbort = input.returnIfAborted(input.signal, stage);
    if (fillAbort) return fillAbort;
    const fillCount = await fillMissingSupplyHistory(input.db, input.assets, input.signal);
    if (fillCount > 0 && input.policy.labels.logSupplyHistoryFillCount) {
      logWorkerEventArgs(
        "handler",
        "info",
        `[sync-stablecoins] Filled ${fillCount} missing supply changes from supply_history`,
      );
    }
  } catch (error) {
    if (input.signal?.aborted) return input.abortResult(input.signal, stage);
    logWorkerEventArgs("handler", "warn", "[sync-stablecoins] supply_history fallback failed:", error);
  }
  return null;
}

export async function runStablecoinsPostIntakePublication(
  input: StablecoinsPostIntakePublicationContext,
): Promise<CronResult> {
  const supplyHistoryResult = await fillStablecoinsSupplyHistory(input);
  if (supplyHistoryResult) return supplyHistoryResult;

  const labels = input.policy.labels;
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
    blockedResultFactory: input.policy.blockedResultBuilder.staleness,
  });
  if (staleness.blockedResult) {
    if (staleness.blockedReason === "severe-staleness" && input.policy.circuitOutcome) {
      await recordOutcome(
        input.db,
        input.policy.circuitOutcome.source,
        input.policy.circuitOutcome.staleBlockSuccess,
      );
    }
    return staleness.blockedResult;
  }

  const activePriceCoverage = evaluateStablecoinActivePriceCoverage(input.assets, undefined, {
    previousCoverage: input.previousActivePriceCoverage,
    previousAcceptedAssetsById: input.previousAssetsById,
  });
  const previousAssetIds = new Set(input.previousAssetsById.keys());
  input.previousAssetsById.clear();

  if (labels.cacheValidationAbortStage) {
    const validationAbort = input.returnIfAborted(input.signal, labels.cacheValidationAbortStage);
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
    validationContext: input.policy.validationContext,
    returnIfAborted: input.returnIfAborted,
    abortResult: input.abortResult,
  }, input.policy.blockedResultBuilder.invalidPayload);
  if (isAbortResult(cacheResult)) return cacheResult;
  if (!cacheResult.written) {
    if (input.policy.circuitOutcome) {
      await recordOutcome(
        input.db,
        input.policy.circuitOutcome.source,
        input.policy.circuitOutcome.cacheDecisionSuccess,
      );
    }
    if (!cacheResult.skippedBecauseNewer) return cacheResult.blockedResult!;
    return buildSkippedNewerCacheResult({
      rowsRead: input.metadata.path === "main"
        ? input.metadata.input.rawAssetCount
        : input.assets.length,
      rowsDropped: input.metadata.path === "main"
        ? input.metadata.input.droppedMalformedAssets
        : 0,
      sourceCoverage: input.policy.sourceCoverage,
      fallbackMode: input.policy.fallbackMode,
      cacheKey: cacheResult.cacheKey,
      syncStartSec: cacheResult.syncStartSec,
      upstreamFetchOk: input.metadata.path === "main",
    });
  }

  await reportStablecoinsStage(
    input.reportProgress,
    labels.cacheWriteProgressStage,
    labels.cacheWriteProgressMessage,
    { itemsDone: input.assets.length, itemsTotal: input.assets.length },
  );
  const priceCacheCommit = await commitReplayPriceCache({
    db: input.db,
    entries: input.priceCacheEntries,
    signal: input.signal,
    returnIfAborted: input.returnIfAborted,
    stagePrefix: labels.priceCacheStagePrefix,
  });
  if (priceCacheCommit) return priceCacheCommit;
  if (input.policy.circuitOutcome) {
    await recordOutcome(
      input.db,
      input.policy.circuitOutcome.source,
      input.policy.circuitOutcome.cacheDecisionSuccess,
    );
  }

  await queueTrackedAdditionsNotice(input.db, previousAssetIds, input.assets);
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
    input.returnIfAborted,
    input.abortResult,
    labels.depegAbortStagePrefix,
    labels.depegLogContext,
    input.policy.sharedFetchSessions?.binance,
    input.policy.sharedFetchSessions?.nativePeg,
  );
  if (isAbortResult(depegResult)) return depegResult;

  const providerDiagnostics = [...input.providerDiagnostics, ...depegResult.providerDiagnostics];
  const result = input.metadata.path === "main"
    ? buildStablecoinsSyncResult({
        ...input.metadata.input,
        assets: input.assets,
        providerDiagnostics,
        stalenessWarning: staleness.stalenessWarning,
        stalenessSummary: staleness.stalenessSummary,
        stalenessCheckFailed: staleness.stalenessCheckFailed,
        stalenessCheckFailureReason: staleness.stalenessCheckFailureReason,
        depegErrorCount: depegResult.depegErrorCount,
        depegErrors: depegResult.depegErrors,
        cacheKey: cacheResult.cacheKey,
        syncStartSec: cacheResult.syncStartSec,
        responseReadyCacheError: cacheResult.responseReadyCacheError,
        depegPipelineSucceeded: depegResult.depegErrorCount === 0,
        previousActivePriceCoverage: input.previousActivePriceCoverage,
        activePriceCoverage,
      })
    : buildFallbackStablecoinsSyncResult({
        ...input.metadata.input,
        assets: input.assets,
        providerDiagnostics,
        stalenessWarning: staleness.stalenessWarning,
        stalenessSummary: staleness.stalenessSummary,
        stalenessCheckFailed: staleness.stalenessCheckFailed,
        stalenessCheckFailureReason: staleness.stalenessCheckFailureReason,
        depegErrorCount: depegResult.depegErrorCount,
        cacheKey: cacheResult.cacheKey,
        syncStartSec: cacheResult.syncStartSec,
        activePriceCoverage,
      });

  await reportStablecoinsStage(input.reportProgress, "complete", labels.completeMessage, {
    itemsDone: input.assets.length,
    itemsTotal: input.assets.length,
    metadata: {
      path: labels.completePath,
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
        candidateRows: input.assets.length,
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
