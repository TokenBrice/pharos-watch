import type { PriceConfidence, PriceObservedAtMode } from "@shared/types/core";

export interface PrimaryPriceResult {
  price: number;
  source: string;
  selectedSource?: string;
  priceEstimator?: "selected_source" | "cluster_median";
  confidence: PriceConfidence;
  dlPrice: number | null;
  cgPrice: number | null;
  candidateSources: string[];
  agreeSources: string[];
  disagreeSources?: string[];
  allPrices?: Record<string, number>;
  observedAt?: number | null;
  observedAtMode?: PriceObservedAtMode | null;
  observedAtBySource?: Record<string, number | null>;
  observedAtModeBySource?: Record<string, PriceObservedAtMode | null>;
}

export interface PeggedAsset {
  id: string;
  name: string;
  symbol: string;
  address?: string;
  geckoId?: string;
  /** Snake-case alias for geckoId as returned by the DL stablecoins API. Normalized by hydrateGeckoIdAliases. */
  gecko_id?: string;
  cmcSlug?: string;
  navToken?: boolean;
  commodityOunces?: number;
  price?: number | null;
  priceSource?: string;
  priceConfidence?: PriceConfidence | null;
  priceUpdatedAt?: number | null;
  priceObservedAt?: number | null;
  priceObservedAtMode?: PriceObservedAtMode | null;
  priceSyncedAt?: number | null;
  priceSelectedSource?: string | null;
  supplySource?: string;
  pegType?: string;
  pegMechanism?: string;
  circulating?: Record<string, number>;
  circulatingPrevDay?: Record<string, number> | null;
  circulatingPrevWeek?: Record<string, number> | null;
  circulatingPrevMonth?: Record<string, number> | null;
  chains?: string[];
  chainCirculating?: Record<string, Record<string, unknown>>;
  consensusSources?: string[];
  agreeSources?: string[];
}

export function hasMissingPrice(asset: PeggedAsset): boolean {
  return asset.price == null || typeof asset.price !== "number" || asset.price === 0;
}

export function applyResolvedPrice(
  asset: PeggedAsset,
  price: number,
  source: string,
  confidence: PriceConfidence,
  updatedAtSec = Math.floor(Date.now() / 1000),
  observedAtMode: PriceObservedAtMode = "local_fetch",
): void {
  asset.price = price;
  asset.priceSource = source;
  asset.priceSelectedSource = source;
  asset.priceConfidence = confidence;
  asset.priceUpdatedAt = updatedAtSec;
  asset.priceObservedAt = updatedAtSec;
  asset.priceObservedAtMode = observedAtMode;
  asset.priceSyncedAt = updatedAtSec;
  asset.consensusSources = [source];
}
