export interface CurrentPricePublicationState {
  price?: number | null;
  priceSource?: string | null;
  priceObservedAt?: number | null;
  priceUpdatedAt?: number | null;
  priceSyncedAt?: number | null;
}

function hasPositiveFinitePrice(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isPublishableSource(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value !== "missing" &&
    value !== "unknown"
  );
}

function hasFinitePositiveTimestamp(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function hasPublishableCurrentPrice(asset: CurrentPricePublicationState | undefined): boolean {
  if (!asset || !hasPositiveFinitePrice(asset.price)) return false;
  if (!isPublishableSource(asset.priceSource)) return false;
  return hasFinitePositiveTimestamp(asset.priceObservedAt ?? asset.priceUpdatedAt ?? asset.priceSyncedAt);
}
