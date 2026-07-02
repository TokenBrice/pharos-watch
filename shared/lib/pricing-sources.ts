import {
  PRICING_SOURCE_REGISTRY,
  getPricingSourceRegistryEntry,
  type PricingSourceKey,
} from "./pricing-source-registry";
import { PRICE_SOURCE_HEALTH_BUCKET_KEYS, type PriceSourceHealthBucketKey } from "../types/pricing-source-health";

export { PRICE_SOURCE_HEALTH_BUCKET_KEYS } from "../types/pricing-source-health";

export const PRICE_TRANSPARENCY_SOURCE_KEYS = [
  ...PRICING_SOURCE_REGISTRY.map((entry) => entry.key),
] as const satisfies readonly PricingSourceKey[];

const PRICE_SOURCE_HEALTH_BUCKET_DEFS = [
  { key: "coingecko+defillama-list", label: "CoinGecko + DefiLlama (list)", shortLabel: "CG+DL-list" },
  ...PRICING_SOURCE_REGISTRY.map((entry) => ({
    key: entry.key as PriceSourceHealthBucketKey,
    label: entry.label,
    shortLabel: entry.shortLabel,
  })),
  { key: "missing", label: "Missing", shortLabel: "Missing" },
] as const satisfies readonly {
  key: PriceSourceHealthBucketKey;
  label: string;
  shortLabel: string;
}[];
const PRICE_SOURCE_HEALTH_BUCKET_KEY_SET = new Set<string>(PRICE_SOURCE_HEALTH_BUCKET_KEYS);

export function createEmptyPriceSourceHealthDistribution(): Record<PriceSourceHealthBucketKey, number> {
  return Object.fromEntries(PRICE_SOURCE_HEALTH_BUCKET_KEYS.map((key) => [key, 0])) as Record<
    PriceSourceHealthBucketKey,
    number
  >;
}

export function getPricingSourceLabel(sourceKey: string): string {
  const parts = normalizePricingSourceKeys(sourceKey);
  if (parts.length > 1) {
    return parts.map((part) => getPricingSourceRegistryEntry(part)?.label ?? part).join(" + ");
  }
  return getPricingSourceRegistryEntry(parts[0] ?? sourceKey)?.label ?? sourceKey;
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

export function normalizePricingSourceKeys(
  sourceKeys: readonly (string | null | undefined)[] | string | null | undefined,
): string[] {
  const rawSources = typeof sourceKeys === "string" || sourceKeys == null ? [sourceKeys] : sourceKeys;
  const normalized: string[] = [];
  for (const rawSource of rawSources) {
    if (!rawSource) continue;
    for (const part of splitCompositePriceSource(rawSource)) {
      const key = part.toLowerCase();
      if (key && !normalized.includes(key)) {
        normalized.push(key);
      }
    }
  }
  return normalized;
}
