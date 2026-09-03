import type { PriceObservedAtMode } from "@shared/types/core";
import type {
  PricingProviderAttemptDiagnostic,
  PricingProviderRejectionReason,
} from "../pricing-provider-diagnostics";
import type { PricingSourceKey } from "@shared/lib/pricing-source-registry";

export type AddressPriceProviderKey = "coingecko-onchain-address";

export interface AddressPriceProviderRuntimeConfig {
  enabledProviders?: string | null;
  cgApiKey?: string | null;
}

export interface AddressPriceAssetLike {
  id: string;
  symbol: string;
  address?: string;
  chains?: string[];
  price?: number | null;
  circulating?: Record<string, number>;
  consensusSources?: string[];
  priceSource?: string | null;
  priceConfidence?: string | null;
  priceObservedAt?: number | null;
  priceUpdatedAt?: number | null;
  priceSyncedAt?: number | null;
}

export interface AddressPriceTarget {
  stablecoinId: string;
  symbol: string;
  chain: string;
  providerChainId: string;
  address: string;
  decimals?: number;
  origin: "contracts" | "tradedContracts" | "asset.address";
  previousSourceDepth: number;
  previousMissingGenerations: number;
  alertEligibleMissingPrice: boolean;
  recentlyMissingPrice: boolean;
  missingPrice: boolean;
  expiresBeforeNextGeneration: boolean;
  circulatingUsd: number;
}

export interface AddressPriceQuote {
  stablecoinId: string;
  source: PricingSourceKey;
  chain: string;
  address: string;
  priceUsd: number;
  observedAt: number | null;
  observedAtMode: PriceObservedAtMode | null;
  liquidityUsd?: number;
  volume24hUsd?: number;
  poolCount?: number;
  metadata?: Record<string, unknown>;
}

export interface AddressPriceProviderRunResult {
  quotes: AddressPriceQuote[];
  diagnostics: PricingProviderAttemptDiagnostic[];
  rejectedTargets: Partial<Record<PricingProviderRejectionReason, number>>;
  successfulRequests: number;
  attemptedRequests: number;
}

export interface AddressPriceProviderCollectionResult {
  quotesByStablecoinId: Map<string, AddressPriceQuote[]>;
  diagnostics: PricingProviderAttemptDiagnostic[];
  providerOutcomes: Map<AddressPriceProviderKey, "success" | "failure" | "neutral">;
}
