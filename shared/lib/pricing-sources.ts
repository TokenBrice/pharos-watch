import {
  PRICING_SOURCE_REGISTRY,
  getPricingSourceRegistryEntry,
  type PricingSourceKey,
} from "./pricing-source-registry";

export const PRICE_TRANSPARENCY_SOURCE_KEYS = [
  ...PRICING_SOURCE_REGISTRY.map((entry) => entry.key),
] as const satisfies readonly PricingSourceKey[];

const PRICE_SOURCE_HEALTH_BUCKET_DEFS = [
  { key: "coingecko+defillama-list", label: "CoinGecko + DefiLlama (list)", shortLabel: "CG+DL-list" },
  ...PRICING_SOURCE_REGISTRY.map((entry) => ({
    key: entry.key,
    label: entry.label,
    shortLabel: entry.shortLabel,
  })),
  { key: "missing", label: "Missing", shortLabel: "Missing" },
] as const;

export const PRICE_SOURCE_HEALTH_BUCKET_KEYS = PRICE_SOURCE_HEALTH_BUCKET_DEFS.map((bucket) => bucket.key);
const PRICE_SOURCE_HEALTH_BUCKET_KEY_SET = new Set<string>(PRICE_SOURCE_HEALTH_BUCKET_KEYS);

export type PriceSourceHealthBucketKey = (typeof PRICE_SOURCE_HEALTH_BUCKET_DEFS)[number]["key"];

export function createEmptyPriceSourceHealthDistribution(): Record<PriceSourceHealthBucketKey, number> {
  return Object.fromEntries(
    PRICE_SOURCE_HEALTH_BUCKET_KEYS.map((key) => [key, 0]),
  ) as Record<PriceSourceHealthBucketKey, number>;
}

export function getPricingSourceLabel(sourceKey: string): string {
  return getPricingSourceRegistryEntry(sourceKey)?.label ?? sourceKey;
}

export function getPriceSourceHealthBucketShortLabel(bucketKey: PriceSourceHealthBucketKey): string {
  return PRICE_SOURCE_HEALTH_BUCKET_DEFS.find((bucket) => bucket.key === bucketKey)?.shortLabel ?? bucketKey;
}

export function isPriceSourceHealthBucketKey(value: string): value is PriceSourceHealthBucketKey {
  return PRICE_SOURCE_HEALTH_BUCKET_KEY_SET.has(value);
}

export function splitCompositePriceSource(source: string): string[] {
  return source
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
