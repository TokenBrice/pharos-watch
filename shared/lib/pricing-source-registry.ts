export type {
  PricingSourceCapabilities,
  PricingSourceFreshnessKind,
  PricingSourceRegistryEntry,
  PricingSourceTrustTier,
} from "./pricing-source-registry-types";

import type { PricingSourceRegistryEntry } from "./pricing-source-registry-types";
import { PRICING_SOURCE_REGISTRY_AGGREGATORS } from "./pricing-source-registry-aggregators";
import { PRICING_SOURCE_REGISTRY_DEX_SEARCH } from "./pricing-source-registry-dex-search";
import { PRICING_SOURCE_REGISTRY_MARKET_FEEDS } from "./pricing-source-registry-market-feeds";
import { PRICING_SOURCE_REGISTRY_SPECIAL } from "./pricing-source-registry-special";

export const PRICING_SOURCE_REGISTRY = [
  ...PRICING_SOURCE_REGISTRY_AGGREGATORS,
  ...PRICING_SOURCE_REGISTRY_MARKET_FEEDS,
  ...PRICING_SOURCE_REGISTRY_DEX_SEARCH,
  ...PRICING_SOURCE_REGISTRY_SPECIAL,
] as const satisfies readonly PricingSourceRegistryEntry[];

export type PricingSourceKey = (typeof PRICING_SOURCE_REGISTRY)[number]["key"];

const REGISTRY_MAP = new Map<string, PricingSourceRegistryEntry>(
  PRICING_SOURCE_REGISTRY.map((entry): [string, PricingSourceRegistryEntry] => [entry.key, entry]),
);

export function getPricingSourceRegistryEntry(sourceKey: string): PricingSourceRegistryEntry | undefined {
  return REGISTRY_MAP.get(sourceKey);
}

export function isPricingSourceProtocolOverride(sourceKey: string | null | undefined): boolean {
  if (!sourceKey) return false;
  return getPricingSourceRegistryEntry(sourceKey)?.isProtocolOverride ?? false;
}

export function isPricingSourceSoftGuardrailExempt(sourceKey: string | null | undefined): boolean {
  if (!sourceKey) return false;
  return getPricingSourceRegistryEntry(sourceKey)?.bypassesSoftValidationGuardrails ?? false;
}
