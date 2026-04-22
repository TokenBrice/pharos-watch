import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";

export interface PriceValidationStats {
  attempted: number;
  high: number;
  singleSource: number;
  cgOnly: number;
  low: number;
}

const INVALID_GECKO_ID_SENTINEL = "wrong";

export function isUsableGeckoId(geckoId: unknown): geckoId is string {
  return typeof geckoId === "string" && geckoId.length > 0 && !geckoId.includes(INVALID_GECKO_ID_SENTINEL);
}

export function getSourceDefaultWeight(source: string): number {
  return getPricingSourceRegistryEntry(source)?.defaultWeight ?? 1;
}
