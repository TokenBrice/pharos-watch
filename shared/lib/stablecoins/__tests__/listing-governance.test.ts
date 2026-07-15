import { describe, expect, it } from "vitest";
import listingDecisionsAsset from "../../../data/stablecoins/listing-decisions.json";
import {
  LISTING_CLASS_BY_ID,
  getListingClass,
  isCoreAggregateListingClass,
  isDiscoveryCandidateExcluded,
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

  it("blocks excluded provider IDs and contracts case-insensitively", () => {
    expect(isDiscoveryCandidateExcluded({ geckoId: "bfusd" })).toBe(true);
    expect(isDiscoveryCandidateExcluded({
      chain: "ZKSYNC",
      address: "0xAC4DE1E9A9E83524F24AF77972DD39D588DE8164",
    })).toBe(true);
    expect(isDiscoveryCandidateExcluded({ geckoId: "usd-coin" })).toBe(false);
  });
});
