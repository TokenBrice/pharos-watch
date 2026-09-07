import { logWorkerEventArgs } from "../../lib/structured-log";
import type { CronProgressReporter } from "../../lib/cron-logger";
import type { CoinGeckoMcapData } from "./supplemental-assets";
import {
  loadFreshFxRates,
  loadPreviousStablecoinsById,
  loadReplayPriceCacheForTrustedContinuity,
  type CronResult,
} from "./shared";
import {
  abortResult,
  returnIfAborted,
} from "./runtime";
import { applyTrackedAssetOverrides } from "./phase-helpers";
import {
  buildPreviousTrustedPriceLookup,
  createValidationContextResolver,
} from "./pricing";
import { runFallbackPriceEnrichmentPhase } from "./fallback-enrichment";
import { overlayFallbackCuratedAggregateSupply, runFallbackIntakePhase } from "./fallback-intake";
import {
  buildFallbackStablecoinsPublicationPolicy,
  loadStablecoinsPublicationContinuity,
  runStablecoinsPostIntakePublication,
} from "./publication";
import type { PeggedAsset } from "./enrich-prices";

function isFallbackCronResult(result: unknown): result is CronResult {
  return typeof result === "object" && result !== null && "metadata" in result;
}

export async function restoreFallbackCacheState({
  db,
  assets,
}: {
  db: D1Database;
  assets: PeggedAsset[];
}) {
  const { previousAssetsById, cacheState: previousCacheState } = await loadPreviousStablecoinsById(db);

  try {
    for (const asset of assets) {
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
    logWorkerEventArgs("handler", "warn", "[sync-stablecoins] Failed to restore stale cache data:", error);
  }

  applyTrackedAssetOverrides(assets);

  return { previousAssetsById, previousCacheState };
}

export async function syncViaCoingeckoFallback(
  db: D1Database,
  cgData: CoinGeckoMcapData,
  cmcApiKey: string | undefined,
  syncStartSec: number,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
  reportProgress?: CronProgressReporter,
  jupiterApiKey?: string | null,
): Promise<CronResult> {
  const aborted = returnIfAborted(signal, "fallback-start");
  if (aborted) return aborted;
  logWorkerEventArgs("handler", "warn", "[sync-stablecoins] Using CoinGecko supply fallback");

  const intake = await runFallbackIntakePhase({
    cgData,
    syncStartSec,
    reportProgress,
  });
  if (isFallbackCronResult(intake)) return intake;
  const { assets } = intake;

  const { previousAssetsById, previousCacheState } = await restoreFallbackCacheState({ db, assets });
  // Curated NAV wrappers (llamaId null) get a fresh per-chain on-chain supply
  // overlay here so the fallback lane no longer nulls their V9 chain breakdown;
  // a failed probe leaves the restore's previous-row carry intact.
  await overlayFallbackCuratedAggregateSupply(assets, signal);
  const { fxFallbackRates, validationReferences } = await loadFreshFxRates(
    db,
    "[sync-stablecoins:fallback]",
  );
  // Reuse this snapshot for trusted continuity and downstream cached fallback
  // instead of loading the full price_cache table a second time per run.
  const replayPriceCache = await loadReplayPriceCacheForTrustedContinuity(db);
  const validationContexts = createValidationContextResolver();
  const previousTrustedPrices = buildPreviousTrustedPriceLookup(
    previousAssetsById,
    syncStartSec,
    replayPriceCache,
  );
  const { previousActivePriceCoverage, previousMissingGenerationsById } =
    await loadStablecoinsPublicationContinuity(db, syncStartSec);

  const enrichment = await runFallbackPriceEnrichmentPhase({
    db,
    assets,
    syncStartSec,
    signal,
    reportProgress,
    cmcApiKey,
    jupiterApiKey,
    coingeckoApiKey,
    previousMissingGenerationsById,
    fxFallbackRates,
    validationReferences,
    validationContexts,
    previousTrustedPrices,
    priceCache: replayPriceCache,
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

  return runStablecoinsPostIntakePublication({
    db,
    assets,
    previousAssetsById,
    previousCacheState,
    previousActivePriceCoverage,
    syncStartSec,
    signal,
    reportProgress,
    priceCacheEntries,
    fxFallbackRates,
    coingeckoApiKey,
    providerDiagnostics: fallbackProviderDiagnostics,
    returnIfAborted,
    abortResult,
    metadata: {
      path: "fallback",
      input: {
        enrichStats,
        authoritativeOverrideCount,
        authoritativeOverrideStats,
        rejectedCount,
        cachedFallbackCount,
        nativePegCorrectionCount,
        nativePegFillCount,
      },
    },
    policy: buildFallbackStablecoinsPublicationPolicy(assets),
  });
}
