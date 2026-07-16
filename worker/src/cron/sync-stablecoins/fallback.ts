import type { CoinGeckoMcapData } from "./supplemental-assets";
import { buildSyncMetadata, type CronResult } from "./shared";
import {
  abortResult,
  reportStablecoinsStage,
  returnIfAborted,
} from "./runtime";
import {
  restoreFallbackCacheState,
  fillFallbackSupplyHistoryStage,
  runFallbackStalenessGate,
} from "./fallback-cache";
import { runFallbackPriceEnrichmentPhase } from "./fallback-enrichment";
import { hydrateFallbackFxPhase } from "./fallback-fx";
import { runFallbackIntakePhase } from "./fallback-intake";
import {
  publishFallbackStablecoinsCache,
  runFallbackDepegFollowThrough,
} from "./fallback-publish";
import type { CronProgressReporter } from "../../lib/cron-logger";
import {
  compactStablecoinActivePriceCoverage,
  evaluateStablecoinActivePriceCoverage,
  evaluateStablecoinPublicationCoverage,
  loadPreviousStablecoinActivePriceCoverage,
} from "../../lib/stablecoin-publication-coverage";

function isFallbackCronResult(result: unknown): result is CronResult {
  return typeof result === "object" && result !== null && "metadata" in result;
}

export async function syncViaCoingeckoFallback(
  db: D1Database,
  cgData: CoinGeckoMcapData,
  cmcApiKey: string | undefined,
  syncStartSec: number,
  signal?: AbortSignal,
  alertWebhookUrl?: string | null,
  coingeckoApiKey?: string | null,
  reportProgress?: CronProgressReporter,
  jupiterApiKey?: string | null,
): Promise<CronResult> {
  const aborted = returnIfAborted(signal, "fallback-start");
  if (aborted) return aborted;
  console.warn("[sync-stablecoins] Using CoinGecko supply fallback");

  const intake = await runFallbackIntakePhase({
    cgData,
    syncStartSec,
    reportProgress,
  });
  if (isFallbackCronResult(intake)) return intake;
  const { assets } = intake;

  const { previousAssetsById } = await restoreFallbackCacheState({ db, assets });
  const {
    fxFallbackRates,
    validationReferences,
    validationContexts,
    previousTrustedPrices,
  } = await hydrateFallbackFxPhase({
    db,
    syncStartSec,
    previousAssetsById,
  });

  const enrichment = await runFallbackPriceEnrichmentPhase({
    db,
    assets,
    syncStartSec,
    signal,
    reportProgress,
    cmcApiKey,
    jupiterApiKey,
    coingeckoApiKey,
    fxFallbackRates,
    validationReferences,
    validationContexts,
    previousTrustedPrices,
    returnIfAborted,
    abortResult,
  });
  if (isFallbackCronResult(enrichment)) return enrichment;
  const {
    enrichStats,
    authoritativeOverrideCount,
    authoritativeOverrideStats,
    rejectedCount,
    cachedFallbackCount,
    nativePegCorrectionCount,
    nativePegFillCount,
    priceCacheEntries,
    providerDiagnostics: fallbackProviderDiagnostics,
  } = enrichment;

  const supplyHistoryResult = await fillFallbackSupplyHistoryStage({
    db,
    assets,
    signal,
    returnIfAborted,
    abortResult,
  });
  if (supplyHistoryResult) return supplyHistoryResult;

  const staleness = await runFallbackStalenessGate({
    db,
    assets,
    syncStartSec,
    signal,
    reportProgress,
  });
  if (isFallbackCronResult(staleness)) return staleness;
  const {
    stalenessWarning,
    stalenessSummary,
    stalenessCheckFailed,
    stalenessCheckFailureReason,
  } = staleness;

  const cacheResult = await publishFallbackStablecoinsCache({
    db,
    assets,
    syncStartSec,
    signal,
    reportProgress,
    priceCacheEntries,
    fxFallbackRates,
    alertWebhookUrl,
    returnIfAborted,
    abortResult,
  });
  if (isFallbackCronResult(cacheResult)) return cacheResult;

  const depegResult = await runFallbackDepegFollowThrough({
    db,
    assets,
    syncStartSec,
    signal,
    reportProgress,
    previousAssetsById,
    fxFallbackRates,
    coingeckoApiKey,
    returnIfAborted,
    abortResult,
  });
  if (isFallbackCronResult(depegResult)) return depegResult;
  const { depegErrorCount, providerDiagnostics: depegProviderDiagnostics } = depegResult;
  const previousActivePriceCoverage = await loadPreviousStablecoinActivePriceCoverage(db, syncStartSec);
  const publicationCoverage = evaluateStablecoinPublicationCoverage(
    assets.map((asset) => String(asset.id)),
    syncStartSec,
  );
  const activePriceCoverage = evaluateStablecoinActivePriceCoverage(assets, undefined, {
    previousCoverage: previousActivePriceCoverage,
    previousAcceptedAssetsById: previousAssetsById,
  });
  const persistedActivePriceCoverage = activePriceCoverage.missingActiveAssets.length > 20
    ? compactStablecoinActivePriceCoverage(activePriceCoverage, 20)
    : activePriceCoverage;

  const result: CronResult = {
    status:
      depegErrorCount > 0
        || stalenessCheckFailed
        || !publicationCoverage.complete
        || !activePriceCoverage.complete
        ? "degraded"
        : "ok",
    itemCount: assets.length,
    metadata: buildSyncMetadata({
      rowsRead: assets.length,
      rowsWritten: assets.length,
      rowsDropped: 0,
      sourceCoverage: { defillama: false, coingeckoFallbackAssets: assets.length },
      fallbackMode: "coingecko-supply-fallback",
      validationFailures: 0,
      enrichment: enrichStats,
      providerDiagnostics: [...fallbackProviderDiagnostics, ...depegProviderDiagnostics],
      rejectedPrices: rejectedCount,
      nativePegCorrections: nativePegCorrectionCount,
      nativePegFills: nativePegFillCount,
      cachedFallbackPrices: cachedFallbackCount,
      authoritativeOverrides: authoritativeOverrideCount,
      authoritativeOverrideStats,
      stalenessWarning,
      priceStaleness: stalenessSummary,
      stalenessCheckFailed,
      stalenessCheckFailureReason,
      upstreamFetchOk: false,
      payloadAccepted: true,
      cacheWriteSucceeded: true,
      cacheKey: cacheResult.cacheKey,
      syncStartSec: cacheResult.syncStartSec,
      depegPipelineSucceeded: depegErrorCount === 0,
      activePublicationCoverage: publicationCoverage,
      activePriceCoverage: persistedActivePriceCoverage,
    }, {
      cacheWriteMode: "published",
      capabilities: {
        stablecoinsCache: publicationCoverage.complete,
        depegPipeline: depegErrorCount === 0,
      },
    }),
  };
  await reportStablecoinsStage(reportProgress, "complete", "Completed stablecoins fallback sync", {
    itemsDone: assets.length,
    itemsTotal: assets.length,
    metadata: {
      path: "fallback",
      status: result.status ?? "ok",
    },
  });
  return {
    ...result,
    productivity: {
      productive: true,
      reason: "stablecoins-fallback-cache-published",
      publications: [{
        surface: "stablecoins",
        generationId: `stablecoins:${cacheResult.syncStartSec}`,
        publishedAt: cacheResult.syncStartSec,
        candidateRows: assets.length,
        publishedRows: assets.length,
        expectedRows: assets.length,
        artifactCacheKey: cacheResult.cacheKey,
        validationSummary: { publicationPath: "coingecko-fallback" },
      }],
    },
  };
}
