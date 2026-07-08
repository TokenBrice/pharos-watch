import type { PriceValidationReferences } from "../../lib/price-validation";
import type { PricingProviderAttemptDiagnostic } from "../../lib/pricing-provider-diagnostics";
import type { PriceCacheWriteEntry } from "../../lib/db-cache";
import type { AuthoritativeLivePriceOverrideStats } from "../../lib/authoritative-price-sources";
import type { CronProgressReporter } from "../../lib/cron-logger";
import type { CronResult } from "./shared";
import type { StablecoinsStalenessSummary } from "./runtime";
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
}

export interface FallbackPriceEnrichmentInput extends FallbackPhaseContext, FallbackAbortHandlers {
  assets: PeggedAsset[];
  cmcApiKey?: string;
  jupiterApiKey?: string | null;
  coingeckoApiKey?: string | null;
  fxFallbackRates?: Record<string, number>;
  validationReferences?: PriceValidationReferences;
  validationContexts: ValidationContextResolver;
  previousTrustedPrices: Map<string, PreviousTrustedPrice>;
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

export interface FallbackSupplyHistoryInput extends FallbackAbortHandlers {
  db: D1Database;
  assets: PeggedAsset[];
  signal?: AbortSignal;
}

export interface FallbackStalenessInput extends FallbackPhaseContext {
  assets: PeggedAsset[];
}

export interface FallbackStalenessOutput {
  stalenessWarning: boolean;
  stalenessSummary: StablecoinsStalenessSummary | null;
  stalenessCheckFailed: boolean;
  stalenessCheckFailureReason?: string;
}

export interface FallbackCachePublicationInput extends FallbackPhaseContext, FallbackAbortHandlers {
  assets: PeggedAsset[];
  priceCacheEntries: PriceCacheWriteEntry[];
  fxFallbackRates?: Record<string, number>;
  alertWebhookUrl?: string | null;
}

export interface FallbackCachePublicationOutput {
  cacheKey: string;
  syncStartSec: number;
}

export interface FallbackDepegFollowThroughInput extends FallbackPhaseContext, FallbackAbortHandlers {
  assets: PeggedAsset[];
  previousAssetsById: Map<string, PeggedAsset>;
  fxFallbackRates?: Record<string, number>;
  coingeckoApiKey?: string | null;
}

export interface FallbackDepegFollowThroughOutput {
  depegErrorCount: number;
  depegErrors: string[];
  providerDiagnostics: PricingProviderAttemptDiagnostic[];
}
