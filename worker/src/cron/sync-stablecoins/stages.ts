import type { ChainRpcConfig } from "../../lib/chain-registry";
import { createEmptyGtProbeStats } from "../../lib/geckoterminal-price-probe";
import { syncViaCoingeckoFallback } from "./fallback";
import { loadStablecoinsIntake } from "./intake";
import type {
  CanonicalDeduplicationResult,
} from "./phase-helpers";
import {
  applyGtProbeResults,
  applyPrimaryPriceResults,
  buildDlListPrices,
  buildPreviousTrustedPriceLookup,
  createValidationContextResolver,
  prevalidatePrices,
} from "./pricing";
import {
  enrichMissingPrices,
  fetchPrimaryPrices,
  hasMissingPrice,
  runGtProbePass,
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
} from "./shared";
import {
  isAbortResult,
  runMissingPriceEnrichmentPhase,
  runSharedPriceCompletion,
} from "./post-enrichment";
import type { CoinGeckoMcapData } from "./supplemental-assets";
import type { PeggedAsset } from "./enrich-prices";
import type { CronStageContext } from "../shared/stage-contracts";

interface StablecoinsIntakeStageOptions extends CronStageContext {
  db: D1Database;
  syncStartSec: number;
  cmcApiKey?: string;
  alertWebhookUrl?: string | null;
  coingeckoApiKey?: string | null;
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
      cgData: CoinGeckoMcapData;
    };

export async function runStablecoinsIntakeStage(
  options: StablecoinsIntakeStageOptions,
): Promise<StablecoinsIntakeStageResult | CronResult> {
  const { fxFallbackRates: freshFxFallbackRates, validationReferences } = await loadFreshFxRates(
    options.db,
    options.syncStartSec,
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
        options.alertWebhookUrl,
        options.coingeckoApiKey,
        options.reportProgress,
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
    cgData: intake.cgData,
    fxFallbackRates,
    validationReferences,
  };
}

interface StablecoinsPricingStageOptions extends CronStageContext {
  db: D1Database;
  assets: PeggedAsset[];
  previousAssetsById: Map<string, PeggedAsset>;
  syncStartSec: number;
  fxFallbackRates: Awaited<ReturnType<typeof loadFreshFxRates>>["fxFallbackRates"];
  validationReferences: Awaited<ReturnType<typeof loadFreshFxRates>>["validationReferences"];
  cmcApiKey?: string;
  coingeckoApiKey?: string | null;
  chainRpcs?: Map<string, ChainRpcConfig>;
}

export async function runStablecoinsPricingStage(
  options: StablecoinsPricingStageOptions,
): Promise<
  | CronResult
  | {
      enrichStats: Awaited<ReturnType<typeof enrichMissingPrices>>;
      priceValidationStats: Awaited<ReturnType<typeof fetchPrimaryPrices>>["stats"];
      gtProbe: Awaited<ReturnType<typeof runGtProbePass>> | { updatedCount: number; stats: ReturnType<typeof createEmptyGtProbeStats> };
      authoritativeOverrideCount: number;
      rejectedCount: number;
      nativePegCorrectionCount: number;
      nativePegFillCount: number;
      cachedFallbackCount: number;
    }
> {
  const validationContexts = createValidationContextResolver();
  const replayPriceCache = await loadReplayPriceCacheForTrustedContinuity(options.db);
  const previousTrustedPrices = buildPreviousTrustedPriceLookup(
    options.previousAssetsById,
    options.syncStartSec,
    replayPriceCache,
  );
  let gtProbe = { updatedCount: 0, stats: createEmptyGtProbeStats() };
  const dlListPrices = buildDlListPrices(options.assets);

  const primaryPricesAbort = returnIfAborted(options.signal, "primary-prices");
  if (primaryPricesAbort) return primaryPricesAbort;
  await reportStablecoinsStage(options.reportProgress, "price-enrichment", "Running primary pricing and enrichment", {
    itemsTotal: options.assets.length,
  });
  const { results: primaryPriceResults, stats: priceValidationStats } = await fetchPrimaryPrices(
    options.assets,
    options.db,
    options.signal,
    options.validationReferences,
    options.coingeckoApiKey,
    options.chainRpcs,
    dlListPrices,
  );
  applyPrimaryPriceResults({
    assets: options.assets,
    primaryPriceResults,
    previousTrustedPrices,
    validationContexts,
    validationReferences: options.validationReferences,
    syncStartSec: options.syncStartSec,
  });
  prevalidatePrices({
    assets: options.assets,
    previousTrustedPrices,
    validationContexts,
    validationReferences: options.validationReferences,
    logLabel: "Pre-rejected bad price",
  });
  const enrichmentPhase = await runMissingPriceEnrichmentPhase({
    assets: options.assets,
    db: options.db,
    syncStartSec: options.syncStartSec,
    signal: options.signal,
    cmcApiKey: options.cmcApiKey,
    returnIfAborted,
  }, "");
  if (isAbortResult(enrichmentPhase)) return enrichmentPhase;
  const { missingBefore, enrichStats } = enrichmentPhase;

  const gtProbeAbort = returnIfAborted(options.signal, "gt-probe");
  if (gtProbeAbort) return gtProbeAbort;
  try {
    gtProbe = await runGtProbePass(
      options.assets,
      primaryPriceResults,
      options.db,
      options.signal,
      options.validationReferences,
      options.coingeckoApiKey,
    );
    if (gtProbe.updatedCount > 0) {
      applyGtProbeResults({
        assets: options.assets,
        primaryPriceResults,
        previousTrustedPrices,
        validationContexts,
        validationReferences: options.validationReferences,
        syncStartSec: options.syncStartSec,
      });
      console.log(`[sync-stablecoins] GT probe updated ${gtProbe.updatedCount} asset prices`);
    }
  } catch (err) {
    if (options.signal?.aborted) return abortResult(options.signal, "gt-probe");
    console.warn("[sync-stablecoins] GT probe failed (non-fatal):", err);
  }

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
    previousTrustedPrices,
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
  } = priceCompletion;

  if (authoritativeOverrideCount > 0) {
    console.log(
      `[sync-stablecoins] Applied ${authoritativeOverrideCount} protocol-backed price override${authoritativeOverrideCount === 1 ? "" : "s"}`,
    );
  }
  if (rejectedCount > 0) {
    console.log(`[sync-stablecoins] Rejected ${rejectedCount} unreasonable prices`);
  }
  if (nativePegCorrectionCount > 0) {
    console.log(`[sync-stablecoins] Corrected ${nativePegCorrectionCount} weak non-USD fiat prices via direct native quotes`);
  }
  if (nativePegFillCount > 0) {
    console.log(`[sync-stablecoins] Filled ${nativePegFillCount} missing non-USD fiat prices via direct native quotes`);
  }
  if (cachedFallbackCount > 0) {
    console.log(`[sync-stablecoins] Applied ${cachedFallbackCount} cached fallback prices`);
  }
  await reportStablecoinsStage(options.reportProgress, "price-validation", "Validated stablecoin prices", {
    itemsDone: options.assets.length - options.assets.filter(hasMissingPrice).length,
    itemsTotal: options.assets.length,
    metadata: {
      authoritativeOverrides: authoritativeOverrideCount,
      rejectedPrices: rejectedCount,
      nativePegCorrections: nativePegCorrectionCount,
      nativePegFills: nativePegFillCount,
      cachedFallbackPrices: cachedFallbackCount,
      gtProbeUpdates: gtProbe.updatedCount,
    },
  });

  return {
    enrichStats,
    priceValidationStats,
    gtProbe,
    authoritativeOverrideCount,
    rejectedCount,
    nativePegCorrectionCount,
    nativePegFillCount,
    cachedFallbackCount,
  };
}
