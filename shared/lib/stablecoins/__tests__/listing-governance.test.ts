import { describe, expect, it } from "vitest";
import listingDecisionsAsset from "../../../data/stablecoins/listing-decisions.json";
import {
  LISTING_CLASS_BY_ID,
  getListingClass,
  isCoreAggregateListingClass,
} from "../listing-governance";
import { TRACKED_STABLECOINS } from "../registry";

describe("listing governance", () => {
  it("has one authoritative decision for every tracked catalog row", () => {
    expect(Object.keys(listingDecisionsAsset.listingClassById)).toHaveLength(TRACKED_STABLECOINS.length);
    expect(LISTING_CLASS_BY_ID.size).toBe(TRACKED_STABLECOINS.length);
    for (const coin of TRACKED_STABLECOINS) {
      expect(getListingClass(coin.id), coin.id).not.toBeNull();
    }
  });

  it("limits the core aggregate to monetary and cash-equivalent classes", () => {
    expect(isCoreAggregateListingClass("core-stablecoin")).toBe(true);
    expect(isCoreAggregateListingClass("cash-equivalent")).toBe(true);
    expect(isCoreAggregateListingClass("stablecoin-variant")).toBe(false);
    expect(isCoreAggregateListingClass("stable-value-investment")).toBe(false);
    expect(isCoreAggregateListingClass("excluded")).toBe(false);
  });
});
