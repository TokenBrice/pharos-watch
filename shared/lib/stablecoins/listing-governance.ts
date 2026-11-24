import listingDecisionsAsset from "../../data/stablecoins/listing-decisions.json";
import { type ListingClass } from "../../types/stablecoin-taxonomy";
import { isCoreAggregateListingClass, isTokenizedFundListingClass } from "./listing-class";

export type { ListingClass };
export { isCoreAggregateListingClass, isTokenizedFundListingClass };

export interface ListingDecisionRegistry {
  schemaVersion: 1;
  policyVersion: string;
  listingClassById: Record<string, ListingClass>;
}

const listingDecisions = listingDecisionsAsset as ListingDecisionRegistry;

export const LISTING_CLASS_BY_ID: ReadonlyMap<string, ListingClass> = new Map(
  Object.entries(listingDecisions.listingClassById),
);

export function getListingClass(stablecoinId: string): ListingClass | null {
  return LISTING_CLASS_BY_ID.get(stablecoinId) ?? null;
}

export function isTokenizedFundId(stablecoinId: string): boolean {
  return isTokenizedFundListingClass(getListingClass(stablecoinId));
}
