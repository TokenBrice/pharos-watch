import { DEPEG_PRIMARY_PRICE_MAX_AGE_SEC } from "@shared/lib/depeg-config";
import { getPrimaryTrustSources } from "@shared/lib/depeg-primary-trust";
import { getPricingSourceRegistryEntry, PRICING_SOURCE_REGISTRY } from "@shared/lib/pricing-source-registry";
import { normalizePricingSourceKeys } from "@shared/lib/pricing-sources";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { readRecord } from "@shared/lib/type-guards";
import type { StablecoinData } from "@shared/types/supply";
import { validateCompositePricingSourceFreshness } from "../pricing-source-freshness";
import type { DexPriceSnapshot } from "./contracts";

const PRICING_FAMILIES = new Set<string>(PRICING_SOURCE_REGISTRY.map((entry) => entry.depegSourceFamily));

export function getDewsPrimaryQuoteClock(asset: StablecoinData, nowSec: number): number | null {
  if (!isObservedPrice(asset) || asset.priceSource === "cached" || asset.priceObservedAtMode !== "upstream") return null;
  const clock = asset.priceObservedAt;
  const freshness = validateCompositePricingSourceFreshness({
    source: asset.priceSource ?? "",
    observedAt: clock,
    observedAtMode: asset.priceObservedAtMode,
    nowSec,
    requireObservedAt: true,
    maxFutureSkewSec: 0,
  });
  return freshness.accepted && freshness.observedAt != null &&
    nowSec - freshness.observedAt <= DEPEG_PRIMARY_PRICE_MAX_AGE_SEC ? freshness.observedAt : null;
}

export function hasIndependentDewsVenues(asset: StablecoinData, dex: DexPriceSnapshot): boolean {
  const sources = normalizePricingSourceKeys([asset.priceSource, ...getPrimaryTrustSources(asset)])
    .map(getPricingSourceRegistryEntry);
  const families = dex.aggregateFamilies;
  return sources.length > 0 && !!families?.length && sources.every((source) =>
    source != null && source.depegSourceFamily !== "dex:aggregate" && !source.key.endsWith("-dex")
    && !source.isProtocolOverride && !source.isSearchDerived
    && (source.trustTier === "hard_market" || source.trustTier === "soft_aggregator" || source.trustTier === "soft_dex")
    && !families.includes(source.depegSourceFamily));
}

/** The display list may omit outliers and cannot certify the aggregate's complete lineage. */
export function readDewsDexAggregateFamilies(value: unknown, inputCount: number): string[] {
  if (!Array.isArray(value) || inputCount <= 0 || value.length !== inputCount) return [];
  const families = new Set<string>();
  for (const input of value) {
    const contribution = readRecord(input);
    for (const family of [contribution?.providerFamily, contribution?.venueFamily]) {
      if (typeof family !== "string") return [];
      const normalized = getPricingSourceRegistryEntry(family)?.depegSourceFamily ?? family;
      if (normalized === "dex:aggregate" || !PRICING_FAMILIES.has(normalized)) return [];
      families.add(normalized);
    }
  }
  return [...families];
}
