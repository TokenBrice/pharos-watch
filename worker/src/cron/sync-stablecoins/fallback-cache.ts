import { applyTrackedAssetOverrides, fillMissingSupplyHistory } from "./phase-helpers";
import { buildSyncMetadata, loadPreviousStablecoinsById } from "./shared";
import { checkStablecoinsPriceStaleness } from "./runtime";
import type { CronResult } from "./shared";
import type {
  FallbackCacheRestorationInput,
  FallbackCacheRestorationOutput,
  FallbackStalenessInput,
  FallbackStalenessOutput,
  FallbackSupplyHistoryInput,
} from "./fallback-types";

export async function restoreFallbackCacheState(
  input: FallbackCacheRestorationInput,
): Promise<FallbackCacheRestorationOutput> {
  const previousAssetsById = await loadPreviousStablecoinsById(input.db);

  try {
    for (const asset of input.assets) {
      const prev = previousAssetsById.get(String(asset.id));
      if (prev?.chainCirculating) {
        asset.chainCirculating = prev.chainCirculating;
        asset.chains = prev.chains ?? [];
      }
      if (prev?.circulatingPrevDay) asset.circulatingPrevDay = prev.circulatingPrevDay;
      if (prev?.circulatingPrevWeek) asset.circulatingPrevWeek = prev.circulatingPrevWeek;
      if (prev?.circulatingPrevMonth) asset.circulatingPrevMonth = prev.circulatingPrevMonth;
    }
  } catch (error) {
    console.warn("[sync-stablecoins] Failed to restore stale cache data:", error);
  }

  applyTrackedAssetOverrides(input.assets);

  return { previousAssetsById };
}

export async function fillFallbackSupplyHistoryStage(
  input: FallbackSupplyHistoryInput,
): Promise<CronResult | null> {
  try {
    const fillAbort = input.returnIfAborted(input.signal, "fallback-fill-supply-history");
    if (fillAbort) return fillAbort;
    await fillMissingSupplyHistory(input.db, input.assets, input.signal);
  } catch (error) {
    if (input.signal?.aborted) return input.abortResult(input.signal, "fallback-fill-supply-history");
    console.warn("[sync-stablecoins] supply_history fallback failed:", error);
  }

  return null;
}

export async function runFallbackStalenessGate(
  input: FallbackStalenessInput,
): Promise<FallbackStalenessOutput | CronResult> {
  const {
    stalenessWarning,
    stalenessSummary,
    stalenessCheckFailed,
    stalenessCheckFailureReason,
    blockedResult,
  } = await checkStablecoinsPriceStaleness({
    db: input.db,
    assets: input.assets,
    signal: input.signal,
    reportProgress: input.reportProgress,
    progressStage: "fallback-staleness-check",
    progressMessage: "Checking fallback price staleness",
    abortStage: "fallback-detect-price-staleness",
    warningLabel: "(fallback)",
    failureLabel: "Fallback staleness check",
    blockedResultFactory: (summary) => ({
      status: "degraded",
      itemCount: input.assets.length,
      metadata: buildSyncMetadata({
        rowsRead: input.assets.length,
        rowsWritten: 0,
        rowsDropped: 0,
        sourceCoverage: { defillama: false, coingeckoFallbackAssets: input.assets.length },
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
        capabilities: {
          stablecoinsCache: false,
          depegPipeline: false,
        },
      }),
    }),
  });
  if (blockedResult) return blockedResult;

  return {
    stalenessWarning,
    stalenessSummary,
    stalenessCheckFailed,
    stalenessCheckFailureReason,
  };
}
