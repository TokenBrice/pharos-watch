import { logWorkerEventArgs } from "../../lib/structured-log";
import type { CoinGeckoMcapData } from "./supplemental-assets";
import type { CronResult } from "./shared";
import {
  abortResult,
  returnIfAborted,
} from "./runtime";
import { restoreFallbackCacheState } from "./fallback-cache";
import { runFallbackPriceEnrichmentPhase } from "./fallback-enrichment";
import { hydrateFallbackFxPhase } from "./fallback-fx";
import { overlayFallbackCuratedAggregateSupply, runFallbackIntakePhase } from "./fallback-intake";
import {
  buildFallbackStablecoinsPublicationPolicy,
  loadStablecoinsPublicationContinuity,
  runStablecoinsPostIntakePublication,
} from "./publication";
import type { CronProgressReporter } from "../../lib/cron-logger";

function isFallbackCronResult(result: unknown): result is CronResult {
  return typeof result === "object" && result !== null && "metadata" in result;
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
  const {
    fxFallbackRates,
    validationReferences,
    validationContexts,
    previousTrustedPrices,
    replayPriceCache,
  } = await hydrateFallbackFxPhase({
    db,
    syncStartSec,
    previousAssetsById,
  });
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
