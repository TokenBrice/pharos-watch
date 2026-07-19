import listingDecisionsAsset from "../../data/stablecoins/listing-decisions.json";
import { type ListingClass } from "../../types/stablecoin-taxonomy";

export type { ListingClass };

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

const CORE_AGGREGATE_LISTING_CLASSES: ReadonlySet<ListingClass> = new Set([
  "core-stablecoin",
  "cash-equivalent",
]);

export function isCoreAggregateListingClass(listingClass: ListingClass | null | undefined): boolean {
  return listingClass != null && CORE_AGGREGATE_LISTING_CLASSES.has(listingClass);
}
