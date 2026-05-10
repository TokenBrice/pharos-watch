import { queueTrackedAdditionsNotice } from "./telegram-tracked-additions";
import { commitReplayPriceCache, validateAndWriteStablecoinsCache } from "./cache-publication";
import { isAbortResult, runDepegPipeline } from "./post-enrichment";
import { buildSyncMetadata } from "./shared";
import { reportStablecoinsStage } from "./runtime";
import type { CronResult } from "./shared";
import type {
  FallbackCachePublicationInput,
  FallbackCachePublicationOutput,
  FallbackDepegFollowThroughInput,
  FallbackDepegFollowThroughOutput,
} from "./fallback-types";

export async function publishFallbackStablecoinsCache(
  input: FallbackCachePublicationInput,
): Promise<FallbackCachePublicationOutput | CronResult> {
  await reportStablecoinsStage(
    input.reportProgress,
    "fallback-cache-validation",
    "Validating CoinGecko fallback payload",
    {
      itemsDone: input.assets.length,
      itemsTotal: input.assets.length,
    },
  );
  const cacheResult = await validateAndWriteStablecoinsCache({
    assets: input.assets,
    fxFallbackRates: input.fxFallbackRates,
    db: input.db,
    syncStartSec: input.syncStartSec,
    signal: input.signal,
    alertWebhookUrl: input.alertWebhookUrl,
    validationContext: "fallback",
    returnIfAborted: input.returnIfAborted,
    abortResult: input.abortResult,
  }, (stablecoinsCacheAgeSec) => ({
    status: "degraded",
    itemCount: input.assets.length,
    metadata: buildSyncMetadata({
      rowsRead: input.assets.length,
      rowsWritten: 0,
      rowsDropped: 0,
      sourceCoverage: { defillama: false, coingeckoFallbackAssets: input.assets.length },
      fallbackMode: "coingecko-supply-fallback",
      validationFailures: 1,
      validationContext: "fallback",
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
    if (cacheResult.skippedBecauseNewer) {
      return {
        itemCount: 0,
        metadata: buildSyncMetadata({
          rowsRead: input.assets.length,
          rowsWritten: 0,
          rowsDropped: 0,
          sourceCoverage: { defillama: false, coingeckoFallbackAssets: input.assets.length },
          fallbackMode: "coingecko-supply-fallback",
          validationFailures: 0,
          upstreamFetchOk: false,
          payloadAccepted: true,
          cacheWriteSucceeded: false,
          depegPipelineSucceeded: false,
          cacheKey: cacheResult.cacheKey,
          syncStartSec: cacheResult.syncStartSec,
        }, {
          cacheWriteMode: "skipped-newer",
          capabilities: {
            stablecoinsCache: true,
            depegPipeline: false,
          },
        }),
      };
    }
    return cacheResult.blockedResult!;
  }
  await reportStablecoinsStage(
    input.reportProgress,
    "fallback-cache-write",
    "Published CoinGecko fallback payload",
    {
      itemsDone: input.assets.length,
      itemsTotal: input.assets.length,
    },
  );
  const priceCacheCommit = await commitReplayPriceCache({
    db: input.db,
    entries: input.priceCacheEntries,
    signal: input.signal,
    returnIfAborted: input.returnIfAborted,
    stagePrefix: "fallback-",
  });
  if (priceCacheCommit) return priceCacheCommit;

  return {
    cacheKey: cacheResult.cacheKey,
    syncStartSec: cacheResult.syncStartSec,
  };
}

export async function runFallbackDepegFollowThrough(
  input: FallbackDepegFollowThroughInput,
): Promise<FallbackDepegFollowThroughOutput | CronResult> {
  await queueTrackedAdditionsNotice(input.db, input.previousAssetsById.keys(), input.assets);

  await reportStablecoinsStage(
    input.reportProgress,
    "fallback-depeg-pipeline",
    "Running fallback depeg pipeline",
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
    "fallback-",
    " (CG fallback)",
  );
  if (isAbortResult(depegResult)) return depegResult;

  return depegResult;
}
