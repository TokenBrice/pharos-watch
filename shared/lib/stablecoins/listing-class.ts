import type { ListingClass } from "../../types/stablecoin-taxonomy";

// Pure class predicates. Client code imports this module so it never loads the
// listing-decisions ledger; listing-governance.ts re-exports both for ID lookups.
const CORE_AGGREGATE_LISTING_CLASSES: ReadonlySet<ListingClass> = new Set([
  "core-stablecoin",
]);

export function isCoreAggregateListingClass(listingClass: ListingClass | null | undefined): boolean {
  return listingClass != null && CORE_AGGREGATE_LISTING_CLASSES.has(listingClass);
}

export function isTokenizedFundListingClass(listingClass: ListingClass | null | undefined): boolean {
  return listingClass === "tokenized-fund";
}
