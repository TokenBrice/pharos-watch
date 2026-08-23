import type {
  AuthoritativeLivePriceOverrideOptions,
  CurrentPriceOverride,
} from "../authoritative-price-sources";
import { fetchAuthoritativeLivePriceOverrides } from "../authoritative-price-sources";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";

export function asset(id: string, overrides: Partial<PeggedAsset> = {}): PeggedAsset {
  return {
    id,
    name: id,
    symbol: id,
    ...overrides,
  };
}

export function unpricedChild(id: string, overrides: Partial<PeggedAsset> = {}): PeggedAsset {
  return asset(id, { price: null, ...overrides });
}

export function freshParent(
  id: string,
  price: number,
  source: string,
  overrides: Partial<PeggedAsset> & { nowSec?: number; observedAt?: number | null } = {},
): PeggedAsset {
  const { nowSec = Math.floor(Date.now() / 1_000), observedAt, ...assetOverrides } = overrides;
  return asset(id, {
    price,
    priceSource: source,
    priceConfidence: "high",
    priceObservedAt: observedAt ?? nowSec - 60,
    priceObservedAtMode: "upstream",
    ...assetOverrides,
  });
}

export function fetchLiveOverrides(
  assets: PeggedAsset[],
  options?: AuthoritativeLivePriceOverrideOptions,
  validationReferences?: Parameters<typeof fetchAuthoritativeLivePriceOverrides>[2],
): Promise<Map<string, CurrentPriceOverride>> {
  return fetchAuthoritativeLivePriceOverrides(assets, undefined, validationReferences, options);
}
