import { logWorkerEventArgs } from "../../lib/structured-log";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import type { NativePegQuoteSession } from "../../lib/native-peg-quotes";
import type { BinanceFetchSession } from "../../lib/cex-tickers";
import type { PriceValidationReferences } from "../../lib/price-validation";
import type { CronProgressReporter } from "../../lib/cron-logger";
import { createEmptyGtProbeStats } from "../../lib/geckoterminal-price-probe-stats";
import {
  applyConsensusResults,
  applyProtocolPriceOverrides,
  buildDlListPrices,
  buildPreviousTrustedPriceLookup,
  createValidationContextResolver,
  prevalidatePrices,
} from "./pricing";
import {
  createAuthoritativeLivePriceOverrideStats,
  fetchAuthoritativeLivePriceOverrides,
} from "../../lib/authoritative-price-sources";
import {
  fetchPrimaryPrices,
  hasMissingPrice,
  type PeggedAsset,
} from "./enrich-prices";
import {
  reportStablecoinsStage,
  returnIfAborted,
} from "./runtime";
import {
  loadReplayPriceCacheForTrustedContinuity,
} from "./shared";
import {
  isAbortResult,
  runSharedPriceCompletion,
} from "./post-enrichment";


interface StablecoinsPricingStageOptions {
  signal?: AbortSignal;
  reportProgress?: CronProgressReporter;
  db: D1Database;
  assets: PeggedAsset[];
  previousAssetsById: Map<string, PeggedAsset>;
  previousMissingGenerationsById?: ReadonlyMap<string, number>;
  syncStartSec: number;
  fxFallbackRates?: Record<string, number>;
  validationReferences?: PriceValidationReferences;
  coingeckoApiKey?: string | null;
  chainRpcs?: Map<string, ChainRpcConfig>;
  binanceSession?: BinanceFetchSession;
  nativePegSession?: NativePegQuoteSession;
}

export async function runStablecoinsPricingStage(
  options: StablecoinsPricingStageOptions,
) {
  const validationContexts = createValidationContextResolver();
  const replayPriceCache = await loadReplayPriceCacheForTrustedContinuity(options.db);
  const previousTrustedPrices = buildPreviousTrustedPriceLookup(
    options.previousAssetsById,
    options.syncStartSec,
    replayPriceCache,
  );
  // The inline GeckoTerminal probe is disabled at the Worker memory boundary. Keep this
  // explicit marker in the sync-stablecoins cron metadata for operational provenance.
  const gtProbe = {
    stats: {
      ...createEmptyGtProbeStats(),
      inlineDisabled: true,
      isolationReason: "worker-memory-boundary" as const,
    },
  };
  const dlListPrices = buildDlListPrices(options.assets);

  const primaryPricesAbort = returnIfAborted(options.signal, "primary-prices");
  if (primaryPricesAbort) return primaryPricesAbort;
  await reportStablecoinsStage(options.reportProgress, "price-enrichment", "Collecting primary stablecoin prices", {
    itemsTotal: options.assets.length,
    metadata: {
      subphase: "primary-provider-collection",
    },
  });
  const {
    results: primaryPriceResults,
    stats: priceValidationStats,
    providerDiagnostics: primaryProviderDiagnostics = [],
  } = await fetchPrimaryPrices(
    options.assets,
    options.db,
    options.signal,
    options.validationReferences,
    options.coingeckoApiKey,
    options.chainRpcs,
    dlListPrices,
    undefined,
    {
      previousAssetsById: options.previousAssetsById,
      previousMissingGenerationsById: options.previousMissingGenerationsById,
      binanceSession: options.binanceSession,
    },
  );
  const primaryPricedCount = options.assets.length - options.assets.filter(hasMissingPrice).length;
  await reportStablecoinsStage(options.reportProgress, "price-enrichment-primary-complete", "Collected primary stablecoin prices", {
    itemsDone: primaryPricedCount,
    itemsTotal: options.assets.length,
    metadata: {
      subphase: "primary-consensus",
      countTotals: {
        pricedAssets: primaryPricedCount,
        missingPrices: options.assets.length - primaryPricedCount,
        primaryResults: primaryPriceResults.size,
        providerDiagnostics: primaryProviderDiagnostics.length,
      },
    },
  });
  applyConsensusResults({
    assets: options.assets,
    primaryPriceResults,
    previousTrustedPrices,
    validationContexts,
    validationReferences: options.validationReferences,
    syncStartSec: options.syncStartSec,
    reason: "primary",
  });
  prevalidatePrices({
    assets: options.assets,
    primaryPriceResults,
    previousTrustedPrices,
    validationContexts,
    validationReferences: options.validationReferences,
    logLabel: "Pre-rejected bad price",
  });
  const authoritativeOverrideStats = createAuthoritativeLivePriceOverrideStats();
  await reportStablecoinsStage(options.reportProgress, "price-enrichment-overrides", "Fetching protocol-backed price overrides", {
    itemsDone: primaryPricedCount,
    itemsTotal: options.assets.length,
    metadata: {
      subphase: "authoritative-overrides",
      gtProbe: {
        inlineDisabled: gtProbe.stats.inlineDisabled,
        isolationReason: gtProbe.stats.isolationReason,
      },
    },
  });
  const authoritativeOverrides = await fetchAuthoritativeLivePriceOverrides(
    options.assets,
    options.signal,
    options.validationReferences,
    {
      db: options.db,
      stats: authoritativeOverrideStats,
      chainRpcs: options.chainRpcs,
      previousMissingGenerationsById: options.previousMissingGenerationsById,
    },
  );
  applyProtocolPriceOverrides({
    assets: options.assets,
    overrides: authoritativeOverrides,
    previousTrustedPrices,
    validationContexts,
    validationReferences: options.validationReferences,
    syncStartSec: options.syncStartSec,
    authoritativeOverrideStats,
  });

  const priceCompletion = await runSharedPriceCompletion({
    chainRpcs: options.chainRpcs,
    assets: options.assets,
    db: options.db,
    syncStartSec: options.syncStartSec,
    signal: options.signal,
    coingeckoApiKey: options.coingeckoApiKey,
    fxFallbackRates: options.fxFallbackRates,
    validationReferences: options.validationReferences,
    validationContexts,
    primaryPriceResults,
    previousTrustedPrices,
    authoritativeOverrides,
    authoritativeOverrideStats,
    previousMissingGenerationsById: options.previousMissingGenerationsById,
    priceCache: replayPriceCache,
    nativePegSession: options.nativePegSession,
  }, "");
  if (isAbortResult(priceCompletion)) return priceCompletion;
  const { priceCacheEntries, providerDiagnostics: nativePegProviderDiagnostics, ...metadata } = priceCompletion;
  const {
    authoritativeOverrideCount, rejectedCount, cachedFallbackCount,
    nativePegCorrectionCount, nativePegFillCount, priceObservationEffectiveness,
  } = metadata;

  if (authoritativeOverrideCount > 0) {
    logWorkerEventArgs("handler", "info",
      `[sync-stablecoins] Applied ${authoritativeOverrideCount} protocol-backed price override${authoritativeOverrideCount === 1 ? "" : "s"}`,
    );
  }
  if (rejectedCount > 0) {
    logWorkerEventArgs("handler", "info", `[sync-stablecoins] Rejected ${rejectedCount} unreasonable prices`);
  }
  if (nativePegCorrectionCount > 0) {
    logWorkerEventArgs("handler", "info", `[sync-stablecoins] Corrected ${nativePegCorrectionCount} weak non-USD fiat prices via direct native quotes`);
  }
  if (nativePegFillCount > 0) {
    logWorkerEventArgs("handler", "info", `[sync-stablecoins] Filled ${nativePegFillCount} missing non-USD fiat prices via direct native quotes`);
  }
  if (cachedFallbackCount > 0) {
    logWorkerEventArgs("handler", "info", `[sync-stablecoins] Applied ${cachedFallbackCount} cached fallback prices`);
  }
  await reportStablecoinsStage(options.reportProgress, "price-validation", "Validated stablecoin prices", {
    itemsDone: options.assets.length - options.assets.filter(hasMissingPrice).length,
    itemsTotal: options.assets.length,
    metadata: {
      authoritativeOverrides: authoritativeOverrideCount,
      authoritativeOverrideStats,
      rejectedPrices: rejectedCount,
      nativePegCorrections: nativePegCorrectionCount,
      nativePegFills: nativePegFillCount,
      cachedFallbackPrices: cachedFallbackCount,
      priceObservationEffectiveness,
    },
  });

  return {
    metadata: {
      ...metadata,
      enrichStats: null,
      priceValidationStats,
      gtProbe,
    },
    priceCacheEntries,
    providerDiagnostics: [
      ...primaryProviderDiagnostics,
      ...nativePegProviderDiagnostics,
    ],
  };
}
