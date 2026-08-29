import type { PriceValidationReferences } from "../../lib/price-validation";
import type { PricingProviderAttemptDiagnostic } from "../../lib/pricing-provider-diagnostics";
import type { PriceCacheEntry, PriceCacheWriteEntry } from "../../lib/db-cache";
import type { AuthoritativeLivePriceOverrideStats } from "../../lib/authoritative-price-sources";
import type { CronProgressReporter } from "../../lib/cron-logger";
import type { CronResult, PreviousStablecoinsCacheState } from "./shared";
import type { PeggedAsset, EnrichmentStats } from "./enrich-prices";
import type { CoinGeckoMcapData } from "./supplemental-assets";
import type {
  PreviousTrustedPrice,
  ValidationContextResolver,
} from "./pricing";

export interface FallbackAbortHandlers {
  returnIfAborted: (signal: AbortSignal | undefined, stage: string) => CronResult | null;
  abortResult: (signal: AbortSignal | undefined, stage: string) => CronResult;
}

export interface FallbackPhaseContext {
  db: D1Database;
  syncStartSec: number;
  signal?: AbortSignal;
  reportProgress?: CronProgressReporter;
}

export interface FallbackStablecoinMetadata {
  id: string;
  name: string;
  symbol: string;
  geckoId?: string;
  flags: {
    pegCurrency: string;
    backing: string;
  };
}

export interface FallbackIntakeInput {
  cgData: CoinGeckoMcapData;
  syncStartSec: number;
  reportProgress?: CronProgressReporter;
  stablecoins?: readonly FallbackStablecoinMetadata[];
}

export interface FallbackIntakeOutput {
  assets: PeggedAsset[];
}

export interface FallbackCacheRestorationInput {
  db: D1Database;
  assets: PeggedAsset[];
}

export interface FallbackCacheRestorationOutput {
  previousAssetsById: Map<string, PeggedAsset>;
  previousCacheState: PreviousStablecoinsCacheState;
}

export interface FallbackFxInput {
  db: D1Database;
  syncStartSec: number;
  previousAssetsById: Map<string, PeggedAsset>;
}

export interface FallbackFxOutput {
  fxFallbackRates?: Record<string, number>;
  validationReferences?: PriceValidationReferences;
  validationContexts: ValidationContextResolver;
  previousTrustedPrices: Map<string, PreviousTrustedPrice>;
  replayPriceCache: Map<string, PriceCacheEntry>;
}

export interface FallbackPriceEnrichmentInput extends FallbackPhaseContext, FallbackAbortHandlers {
  assets: PeggedAsset[];
  cmcApiKey?: string;
  jupiterApiKey?: string | null;
  coingeckoApiKey?: string | null;
  previousMissingGenerationsById?: ReadonlyMap<string, number>;
  fxFallbackRates?: Record<string, number>;
  validationReferences?: PriceValidationReferences;
  validationContexts: ValidationContextResolver;
  previousTrustedPrices: Map<string, PreviousTrustedPrice>;
  priceCache?: ReadonlyMap<string, PriceCacheEntry>;
}

export interface FallbackPriceEnrichmentOutput {
  enrichStats: EnrichmentStats;
  authoritativeOverrideCount: number;
  authoritativeOverrideStats: AuthoritativeLivePriceOverrideStats;
  rejectedCount: number;
  cachedFallbackCount: number;
  nativePegCorrectionCount: number;
  nativePegFillCount: number;
  priceCacheEntries: PriceCacheWriteEntry[];
  providerDiagnostics: PricingProviderAttemptDiagnostic[];
}
