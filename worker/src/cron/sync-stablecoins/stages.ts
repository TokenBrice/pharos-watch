import type { ChainRpcConfig } from "../../lib/chain-registry";
import type { BinanceFetchSession } from "../../lib/cex-tickers";
import type { AddressPriceProviderRuntimeConfig } from "../../lib/address-price-providers";
import { GT_PROBE_RUN_BUDGET_MS } from "../../lib/constants";
import type { PriceCacheWriteEntry } from "../../lib/db-cache";
import { createEmptyGtProbeStats } from "../../lib/geckoterminal-price-probe";
import { CRON_TIMEOUT_MS } from "../../lib/cron-lease";
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
import type { CronStageContext } from "../shared/stage-contracts";

const STABLECOINS_JOB_NAME = "sync-stablecoins";
const STABLECOINS_SYNC_TAIL_RESERVE_MS = 90_000;
const GT_PROBE_MIN_USEFUL_BUDGET_MS = 20_000;

function resolveGtProbeBudgetMs(syncStartSec: number): number {
  const elapsedMs = Math.max(0, Date.now() - syncStartSec * 1000);
  const timeoutMs = CRON_TIMEOUT_MS[STABLECOINS_JOB_NAME] ?? 8 * 60_000;
  const remainingBeforeTailMs = timeoutMs - elapsedMs - STABLECOINS_SYNC_TAIL_RESERVE_MS;
  if (remainingBeforeTailMs < GT_PROBE_MIN_USEFUL_BUDGET_MS) return 0;
  return Math.min(GT_PROBE_RUN_BUDGET_MS, remainingBeforeTailMs);
}

interface StablecoinsIntakeStageOptions extends CronStageContext {
  db: D1Database;
  syncStartSec: number;
  cmcApiKey?: string;
  jupiterApiKey?: string | null;
  alertWebhookUrl?: string | null;
  alertBrokerMode?: string;
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
        options.alertWebhookUrl,
        options.coingeckoApiKey,
        options.reportProgress,
        options.jupiterApiKey,
        options.alertBrokerMode,
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
    supplyGapReconciliation: intake.supplyGapReconciliation,
    trackedCoverage: intake.trackedCoverage,
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
  jupiterApiKey?: string | null;
  coingeckoApiKey?: string | null;
  addressPriceProvider?: AddressPriceProviderRuntimeConfig;
  chainRpcs?: Map<string, ChainRpcConfig>;
  binanceSession?: BinanceFetchSession;
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
  let gtProbe = { updatedCount: 0, stats: createEmptyGtProbeStats() };
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
    { db: options.db, stats: authoritativeOverrideStats },
  );
  applyProtocolPriceOverrides({
    assets: options.assets,
    overrides: authoritativeOverrides,
    previousTrustedPrices,
    validationContexts,
    validationReferences: options.validationReferences,
    syncStartSec: options.syncStartSec,
  });
  const enrichmentPhase = await runMissingPriceEnrichmentPhase({
    assets: options.assets,
    db: options.db,
    syncStartSec: options.syncStartSec,
    signal: options.signal,
    cmcApiKey: options.cmcApiKey,
    coingeckoApiKey: options.coingeckoApiKey,
    jupiterApiKey: options.jupiterApiKey,
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

  const gtProbeAbort = returnIfAborted(options.signal, "gt-probe");
  if (gtProbeAbort) return gtProbeAbort;
  try {
    const gtProbeBudgetMs = resolveGtProbeBudgetMs(options.syncStartSec);
    await reportStablecoinsStage(
      options.reportProgress,
      "price-enrichment-gt-probe",
      "Running GeckoTerminal price probe",
      {
        itemsDone: options.assets.length - options.assets.filter(hasMissingPrice).length,
        itemsTotal: options.assets.length,
        metadata: {
          subphase: "gt-probe",
          budgetMs: gtProbeBudgetMs,
          maxBudgetMs: GT_PROBE_RUN_BUDGET_MS,
          tailReserveMs: STABLECOINS_SYNC_TAIL_RESERVE_MS,
        },
      },
    );
    gtProbe = await runGtProbePass(
      options.assets,
      primaryPriceResults,
      options.db,
      options.signal,
      options.validationReferences,
      options.coingeckoApiKey,
      validationContexts,
      { budgetMs: gtProbeBudgetMs },
    );
    if (gtProbe.updatedCount > 0) {
      applyConsensusResults({
        assets: options.assets,
        primaryPriceResults,
        previousTrustedPrices,
        validationContexts,
        validationReferences: options.validationReferences,
        syncStartSec: options.syncStartSec,
        reason: "gt-probe",
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
    primaryPriceResults,
    previousTrustedPrices,
    authoritativeOverrides,
    authoritativeOverrideStats,
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
      authoritativeOverrideStats,
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
