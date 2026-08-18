import { logWorkerEventArgs } from "../../lib/structured-log";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import type { BinanceFetchSession } from "../../lib/cex-tickers";
import type { NativePegQuoteSession } from "../../lib/native-peg-quotes";
import type { AddressPriceProviderRuntimeConfig } from "../../lib/address-price-providers";
import type { PriceCacheWriteEntry } from "../../lib/db-cache";
import type { CronProgressReporter } from "../../lib/cron-logger";
import { createEmptyGtProbeStats } from "../../lib/geckoterminal-price-probe-stats";
import { syncViaCoingeckoFallback } from "./fallback";
import { loadStablecoinsIntake } from "./intake";
import type {
  CanonicalDeduplicationResult,
} from "./phase-helpers";
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
  type AuthoritativeLivePriceOverrideStats,
} from "../../lib/authoritative-price-sources";
import {
  enrichMissingPrices,
  fetchPrimaryPrices,
  hasMissingPrice,
} from "./enrich-prices";
import {
  abortResult,
  reportStablecoinsStage,
  returnIfAborted,
} from "./runtime";
import {
  loadFreshFxRates,
  loadReplayPriceCacheForTrustedContinuity,
  type CronResult,
  type PreviousStablecoinsCacheState,
  type TrackedCoverageRestoreResult,
} from "./shared";
import {
  isAbortResult,
  runMissingPriceEnrichmentPhase,
  runSharedPriceCompletion,
} from "./post-enrichment";
import type { CoinGeckoMcapData } from "./supplemental-assets";
import type { SupplyGapReconciliationResult } from "./supply-gap-reconciliation";
import type { PeggedAsset } from "./enrich-prices";

interface StablecoinsIntakeStageOptions {
  signal?: AbortSignal;
  reportProgress?: CronProgressReporter;
  db: D1Database;
  syncStartSec: number;
  cmcApiKey?: string;
  jupiterApiKey?: string | null;
  coingeckoApiKey?: string | null;
  addressPriceProvider?: AddressPriceProviderRuntimeConfig;
  chainRpcs?: Map<string, ChainRpcConfig>;
}

export type StablecoinsIntakeStageResult =
  | {
      kind: "fallback";
      result: CronResult;
      errorMessage: string;
    }
  | {
      kind: "ok";
      fxFallbackRates: Awaited<ReturnType<typeof loadFreshFxRates>>["fxFallbackRates"];
      validationReferences: Awaited<ReturnType<typeof loadFreshFxRates>>["validationReferences"];
      assets: PeggedAsset[];
      rawAssetCount: number;
      droppedMalformedAssets: number;
      canonicalDeduplication: CanonicalDeduplicationResult;
      previousAssetsById: Map<string, PeggedAsset>;
      previousCacheState: PreviousStablecoinsCacheState;
      cgData: CoinGeckoMcapData;
      supplyGapReconciliation: SupplyGapReconciliationResult;
      trackedCoverage: TrackedCoverageRestoreResult;
    };

export async function runStablecoinsIntakeStage(
  options: StablecoinsIntakeStageOptions,
): Promise<StablecoinsIntakeStageResult | CronResult> {
  const { fxFallbackRates: freshFxFallbackRates, validationReferences } = await loadFreshFxRates(
    options.db,
  );

  const preFetchAbort = returnIfAborted(options.signal, "fetch-stablecoins-and-supplementals");
  if (preFetchAbort) return preFetchAbort;
  await reportStablecoinsStage(options.reportProgress, "intake", "Loading DefiLlama stablecoin intake");
  const intake = await loadStablecoinsIntake({
    db: options.db,
    signal: options.signal,
    syncStartSec: options.syncStartSec,
    fxFallbackRates: freshFxFallbackRates,
    coingeckoApiKey: options.coingeckoApiKey,
    chainRpcs: options.chainRpcs,
    fallbackToCoingecko: (cgData) =>
      syncViaCoingeckoFallback(
        options.db,
        cgData,
        options.cmcApiKey,
        options.syncStartSec,
        options.signal,
        options.coingeckoApiKey,
        options.reportProgress,
        options.jupiterApiKey,
      ),
  });

  if (intake.kind === "fallback") {
    return {
      kind: "fallback",
      result: intake.result,
      errorMessage: intake.errorMessage,
    };
  }

  const fxFallbackRates = freshFxFallbackRates ?? intake.fxFallbackRates;
  await reportStablecoinsStage(options.reportProgress, "intake", "Loaded DefiLlama stablecoin intake", {
    itemsDone: intake.assets.length,
    itemsTotal: intake.rawAssetCount,
    metadata: {
      rawAssetCount: intake.rawAssetCount,
      droppedMalformedAssets: intake.droppedMalformedAssets,
      canonicalDuplicateRows: intake.canonicalDeduplication.duplicateRows,
    },
  });

  return {
    kind: "ok",
    assets: intake.assets,
    rawAssetCount: intake.rawAssetCount,
    droppedMalformedAssets: intake.droppedMalformedAssets,
    canonicalDeduplication: intake.canonicalDeduplication,
    previousAssetsById: intake.previousAssetsById,
    previousCacheState: intake.previousCacheState,
    cgData: intake.cgData,
    fxFallbackRates,
    validationReferences,
    supplyGapReconciliation: intake.supplyGapReconciliation,
    trackedCoverage: intake.trackedCoverage,
  };
}

interface StablecoinsPricingStageOptions {
  signal?: AbortSignal;
  reportProgress?: CronProgressReporter;
  db: D1Database;
  assets: PeggedAsset[];
  previousAssetsById: Map<string, PeggedAsset>;
  previousMissingGenerationsById?: ReadonlyMap<string, number>;
  syncStartSec: number;
  fxFallbackRates: Awaited<ReturnType<typeof loadFreshFxRates>>["fxFallbackRates"];
  validationReferences: Awaited<ReturnType<typeof loadFreshFxRates>>["validationReferences"];
  cmcApiKey?: string;
  jupiterApiKey?: string | null;
  coingeckoApiKey?: string | null;
  addressPriceProvider?: AddressPriceProviderRuntimeConfig;
  chainRpcs?: Map<string, ChainRpcConfig>;
  binanceSession?: BinanceFetchSession;
  nativePegSession?: NativePegQuoteSession;
}

export async function runStablecoinsPricingStage(
  options: StablecoinsPricingStageOptions,
): Promise<
  | CronResult
  | {
      enrichStats: Awaited<ReturnType<typeof enrichMissingPrices>>;
      priceValidationStats: Awaited<ReturnType<typeof fetchPrimaryPrices>>["stats"];
      gtProbe: { stats: ReturnType<typeof createEmptyGtProbeStats> };
      authoritativeOverrideCount: number;
      authoritativeOverrideStats: AuthoritativeLivePriceOverrideStats;
      rejectedCount: number;
      nativePegCorrectionCount: number;
      nativePegFillCount: number;
      cachedFallbackCount: number;
      priceCacheEntries: PriceCacheWriteEntry[];
      providerDiagnostics: NonNullable<Awaited<ReturnType<typeof fetchPrimaryPrices>>["providerDiagnostics"]>;
    }
> {
  const validationContexts = createValidationContextResolver();
  const replayPriceCache = await loadReplayPriceCacheForTrustedContinuity(options.db);
  const previousTrustedPrices = buildPreviousTrustedPriceLookup(
    options.previousAssetsById,
    options.syncStartSec,
    replayPriceCache,
  );
  // The inline GeckoTerminal probe is disabled at the Worker memory boundary; the block is
  // published purely as an explicit disabled marker for `/api/status`.
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
      addressProvider: options.addressPriceProvider,
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
    },
  });
  const authoritativeOverrides = await fetchAuthoritativeLivePriceOverrides(
    options.assets,
    options.signal,
    options.validationReferences,
    {
      db: options.db,
      stats: authoritativeOverrideStats,
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
  const enrichmentPhase = await runMissingPriceEnrichmentPhase({
    assets: options.assets,
    db: options.db,
    syncStartSec: options.syncStartSec,
    signal: options.signal,
    cmcApiKey: options.cmcApiKey,
    coingeckoApiKey: options.coingeckoApiKey,
    jupiterApiKey: options.jupiterApiKey,
    previousMissingGenerationsById: options.previousMissingGenerationsById,
    returnIfAborted,
    onProgress: async (progress) => {
      const pass = progress.pass;
      const passLabel = pass?.passLabel ?? "Fallback";
      const missingCount = progress.finalMissing ?? options.assets.filter(hasMissingPrice).length;
      let message: string;
      switch (progress.phase) {
        case "start":
          message = "Preparing fallback price enrichment";
          break;
        case "fx-rates-loaded":
          message = "Loaded fallback price-enrichment bounds";
          break;
        case "pass-start":
          message = `Running ${passLabel} fallback price pass`;
          break;
        case "pass-failed":
          message = `${passLabel} fallback price pass failed`;
          break;
        case "complete":
          message = "Completed fallback price enrichment";
          break;
        case "pass-complete":
          message = `${passLabel} fallback price pass completed`;
          break;
      }
      await reportStablecoinsStage(options.reportProgress, "price-enrichment-fallback", message, {
        itemsDone: options.assets.length - missingCount,
        itemsTotal: options.assets.length,
        metadata: {
          subphase: progress.phase,
          passKey: pass?.passKey,
          passLabel: pass?.passLabel,
          passIndex: pass?.passIndex,
          passTotal: pass?.passTotal,
          missingBeforePass: pass?.missingBeforePass,
          missingAfterPass: pass?.missingAfterPass,
          totalMissingBeforeFallback: progress.totalMissing,
          finalMissing: progress.finalMissing,
          failedPasses: progress.failedPasses,
          counts: pass?.counts,
        },
      });
    },
  }, "");
  if (isAbortResult(enrichmentPhase)) return enrichmentPhase;
  const { missingBefore, enrichStats } = enrichmentPhase;

  await reportStablecoinsStage(
    options.reportProgress,
    "price-enrichment-gt-probe-disabled",
    "Skipping memory-isolated GeckoTerminal corroboration",
    {
      itemsDone:
        options.assets.length -
        options.assets.filter(hasMissingPrice).length,
      itemsTotal: options.assets.length,
      metadata: {
        subphase: "gt-probe-disabled",
        isolationReason: "worker-memory-boundary",
      },
    },
  );

  const priceCompletion = await runSharedPriceCompletion({
    assets: options.assets,
    missingBefore,
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
    returnIfAborted,
    abortResult,
  }, "");
  if (isAbortResult(priceCompletion)) return priceCompletion;
  const {
    authoritativeOverrideCount,
    rejectedCount,
    cachedFallbackCount,
    nativePegCorrectionCount,
    nativePegFillCount,
    priceCacheEntries,
    providerDiagnostics: nativePegProviderDiagnostics,
  } = priceCompletion;

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
    },
  });

  return {
    enrichStats,
    priceValidationStats,
    gtProbe,
    authoritativeOverrideCount,
    authoritativeOverrideStats,
    rejectedCount,
    nativePegCorrectionCount,
    nativePegFillCount,
    cachedFallbackCount,
    priceCacheEntries,
    providerDiagnostics: [
      ...primaryProviderDiagnostics,
      ...(enrichStats.providerDiagnostics ?? []),
      ...nativePegProviderDiagnostics,
    ],
  };
}
