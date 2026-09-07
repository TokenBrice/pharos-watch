import {
  createAuthoritativeLivePriceOverrideStats,
  fetchAuthoritativeLivePriceOverrides,
} from "../../lib/authoritative-price-sources";
import type { CronProgressReporter } from "../../lib/cron-logger";
import type { PriceCacheEntry } from "../../lib/db-cache";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { hasMissingPrice, type PeggedAsset } from "./enrich-prices";
import {
  applyProtocolPriceOverrides,
  prevalidatePrices,
  type PreviousTrustedPrice,
  type ValidationContextResolver,
} from "./pricing";
import {
  isAbortResult,
  runMissingPriceEnrichmentPhase,
  runSharedPriceCompletion,
} from "./post-enrichment";
import { reportStablecoinsStage } from "./runtime";
import type { CronResult } from "./shared";

interface FallbackPriceEnrichmentInput {
  db: D1Database;
  assets: PeggedAsset[];
  syncStartSec: number;
  signal?: AbortSignal;
  reportProgress?: CronProgressReporter;
  cmcApiKey?: string;
  jupiterApiKey?: string | null;
  coingeckoApiKey?: string | null;
  previousMissingGenerationsById?: ReadonlyMap<string, number>;
  fxFallbackRates?: Record<string, number>;
  validationReferences?: PriceValidationReferences;
  validationContexts: ValidationContextResolver;
  previousTrustedPrices: Map<string, PreviousTrustedPrice>;
  priceCache?: ReadonlyMap<string, PriceCacheEntry>;
  returnIfAborted: (signal: AbortSignal | undefined, stage: string) => CronResult | null;
  abortResult: (signal: AbortSignal | undefined, stage: string) => CronResult;
}

export async function runFallbackPriceEnrichmentPhase(
  input: FallbackPriceEnrichmentInput,
) {
  for (const asset of input.assets) {
    if (!asset.supplySource) {
      asset.supplySource = "coingecko-fallback";
    }
  }

  prevalidatePrices({
    assets: input.assets,
    previousTrustedPrices: input.previousTrustedPrices,
    validationContexts: input.validationContexts,
    validationReferences: input.validationReferences,
    logLabel: "Pre-rejected fallback price",
  });
  const authoritativeOverrideStats = createAuthoritativeLivePriceOverrideStats();
  const authoritativeOverrides = await fetchAuthoritativeLivePriceOverrides(
    input.assets,
    input.signal,
    input.validationReferences,
    {
      db: input.db,
      stats: authoritativeOverrideStats,
      previousMissingGenerationsById: input.previousMissingGenerationsById,
    },
  );
  applyProtocolPriceOverrides({
    assets: input.assets,
    overrides: authoritativeOverrides,
    previousTrustedPrices: input.previousTrustedPrices,
    validationContexts: input.validationContexts,
    validationReferences: input.validationReferences,
    syncStartSec: input.syncStartSec,
    authoritativeOverrideStats,
  });

  await reportStablecoinsStage(
    input.reportProgress,
    "fallback-price-enrichment",
    "Enriching CoinGecko fallback prices",
    { itemsTotal: input.assets.length },
  );
  const enrichmentPhase = await runMissingPriceEnrichmentPhase({
    assets: input.assets,
    db: input.db,
    syncStartSec: input.syncStartSec,
    signal: input.signal,
    cmcApiKey: input.cmcApiKey,
    jupiterApiKey: input.jupiterApiKey,
    coingeckoApiKey: input.coingeckoApiKey,
    previousMissingGenerationsById: input.previousMissingGenerationsById,
    returnIfAborted: input.returnIfAborted,
  }, "fallback-");
  if (isAbortResult(enrichmentPhase)) return enrichmentPhase;
  const { missingBefore, enrichStats } = enrichmentPhase;

  const priceCompletion = await runSharedPriceCompletion({
    assets: input.assets,
    missingBefore,
    db: input.db,
    syncStartSec: input.syncStartSec,
    signal: input.signal,
    coingeckoApiKey: input.coingeckoApiKey,
    fxFallbackRates: input.fxFallbackRates,
    validationReferences: input.validationReferences,
    validationContexts: input.validationContexts,
    previousTrustedPrices: input.previousTrustedPrices,
    authoritativeOverrides,
    authoritativeOverrideStats,
    previousMissingGenerationsById: input.previousMissingGenerationsById,
    priceCache: input.priceCache,
    returnIfAborted: input.returnIfAborted,
    abortResult: input.abortResult,
  }, "fallback-");
  if (isAbortResult(priceCompletion)) return priceCompletion;

  const {
    authoritativeOverrideCount,
    rejectedCount,
    cachedFallbackCount,
    nativePegCorrectionCount,
    nativePegFillCount,
    priceCacheEntries,
    providerDiagnostics,
  } = priceCompletion;
  await reportStablecoinsStage(
    input.reportProgress,
    "fallback-price-validation",
    "Validated CoinGecko fallback prices",
    {
      itemsDone: input.assets.length - input.assets.filter(hasMissingPrice).length,
      itemsTotal: input.assets.length,
      metadata: {
        authoritativeOverrides: authoritativeOverrideCount,
        authoritativeOverrideStats,
        rejectedPrices: rejectedCount,
        nativePegCorrections: nativePegCorrectionCount,
        nativePegFills: nativePegFillCount,
        cachedFallbackPrices: cachedFallbackCount,
      },
    },
  );

  return {
    enrichStats,
    authoritativeOverrideCount,
    authoritativeOverrideStats,
    rejectedCount,
    cachedFallbackCount,
    nativePegCorrectionCount,
    nativePegFillCount,
    priceCacheEntries,
    providerDiagnostics: [
      ...(enrichStats.providerDiagnostics ?? []),
      ...providerDiagnostics,
    ],
  };
}
