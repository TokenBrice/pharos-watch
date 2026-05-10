import { CIRCUIT_SOURCE } from "../../lib/constants";
import { recordOutcome } from "../../lib/circuit-breaker";
import type { PricingProviderAttemptDiagnostic } from "../../lib/pricing-provider-diagnostics";
import { buildStablecoinsUnwrittenCacheResult } from "./metadata";
import { reportStablecoinsStage } from "./runtime";
import {
  commitReplayPriceCache,
  type CacheValidationResult,
  validateAndWriteStablecoinsCache,
} from "./cache-publication";
import {
  isAbortResult,
  runDepegPipeline,
} from "./post-enrichment";
import { buildSyncMetadata, type CronResult } from "./shared";
import { queueTrackedAdditionsNotice } from "./telegram-tracked-additions";
import type { PeggedAsset } from "./enrich-prices";
import type { PriceCacheWriteEntry } from "../../lib/db-cache";
import type { CronProgressReporter } from "../../lib/cron-logger";

export interface MainPublicationInput {
  assets: PeggedAsset[];
  previousAssetsById: Map<string, PeggedAsset>;
  fxFallbackRates?: Record<string, number>;
  db: D1Database;
  syncStartSec: number;
  signal?: AbortSignal;
  alertWebhookUrl?: string | null;
  coingeckoApiKey?: string | null;
  rawAssetCount: number;
  droppedMalformedAssets: number;
  priceCacheEntries: PriceCacheWriteEntry[];
  returnIfAborted: (signal: AbortSignal | undefined, stage: string) => CronResult | null;
  abortResult: (signal: AbortSignal | undefined, stage: string) => CronResult;
  reportProgress?: CronProgressReporter;
}

export interface MainPublicationResult {
  cacheResult: CacheValidationResult;
  depegErrorCount: number;
  depegErrors: string[];
  providerDiagnostics: PricingProviderAttemptDiagnostic[];
}

export async function publishMainStablecoinsAndRunFollowThrough(
  input: MainPublicationInput,
): Promise<MainPublicationResult | CronResult> {
  const validationAbort = input.returnIfAborted(input.signal, "validate-stablecoins-payload");
  if (validationAbort) return validationAbort;
  await reportStablecoinsStage(input.reportProgress, "cache-validation", "Validating stablecoins cache payload", {
    itemsDone: input.assets.length,
    itemsTotal: input.assets.length,
  });
  const cacheResult = await validateAndWriteStablecoinsCache({
    assets: input.assets,
    fxFallbackRates: input.fxFallbackRates,
    db: input.db,
    syncStartSec: input.syncStartSec,
    signal: input.signal,
    alertWebhookUrl: input.alertWebhookUrl,
    validationContext: "main",
    returnIfAborted: input.returnIfAborted,
    abortResult: input.abortResult,
  }, (stablecoinsCacheAgeSec) => ({
    status: "degraded",
    itemCount: input.assets.length,
    metadata: buildSyncMetadata({
      rowsRead: input.rawAssetCount,
      rowsWritten: 0,
      rowsDropped: input.droppedMalformedAssets,
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
    await recordOutcome(input.db, CIRCUIT_SOURCE.DL_STABLECOINS, true);
    return buildStablecoinsUnwrittenCacheResult({
      cacheResult,
      rawAssetCount: input.rawAssetCount,
      droppedMalformedAssets: input.droppedMalformedAssets,
    });
  }
  await reportStablecoinsStage(input.reportProgress, "cache-write", "Published stablecoins cache", {
    itemsDone: input.assets.length,
    itemsTotal: input.assets.length,
  });
  const priceCacheCommit = await commitReplayPriceCache({
    db: input.db,
    entries: input.priceCacheEntries,
    signal: input.signal,
    returnIfAborted: input.returnIfAborted,
  });
  if (priceCacheCommit) return priceCacheCommit;
  await recordOutcome(input.db, CIRCUIT_SOURCE.DL_STABLECOINS, true);
  await queueTrackedAdditionsNotice(input.db, input.previousAssetsById.keys(), input.assets);
  await reportStablecoinsStage(input.reportProgress, "depeg-pipeline", "Running depeg pipeline", {
    itemsTotal: input.assets.length,
  });
  const depegResult = await runDepegPipeline(
    input.db,
    input.assets,
    input.fxFallbackRates,
    input.signal,
    input.coingeckoApiKey,
    input.returnIfAborted,
    input.abortResult,
    "",
    "",
  );
  if (isAbortResult(depegResult)) return depegResult;
  return {
    cacheResult,
    depegErrorCount: depegResult.depegErrorCount,
    depegErrors: depegResult.depegErrors,
    providerDiagnostics: depegResult.providerDiagnostics,
  };
}
