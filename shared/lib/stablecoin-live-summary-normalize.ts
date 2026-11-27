import type { StablecoinLiveSummary } from "../types/stablecoin-live-summary";
import { isObservedPrice } from "./pricing-source-policy";

/** Nominal references never become observed display prices, regardless of transport. */
export function normalizeStablecoinLiveSummary(summary: StablecoinLiveSummary): StablecoinLiveSummary {
  if (isObservedPrice(summary)) return summary;
  const { priceDerivation: _derivation, pricePublicationReason: _publicationReason, ...rest } = summary;
  return {
    ...rest,
    price: null,
    priceConfidence: null,
    priceUpdatedAt: null,
    priceObservedAt: null,
    ...(summary.priceSyncedAt !== undefined ? { priceSyncedAt: null } : {}),
    ...(summary.consensusSources !== undefined ? { consensusSources: [] } : {}),
    ...(summary.agreeSources !== undefined ? { agreeSources: [] } : {}),
  };
}
