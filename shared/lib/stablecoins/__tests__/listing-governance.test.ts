import { describe, expect, it } from "vitest";
import { DEAD_STABLECOINS } from "../../dead-stablecoins";
import {
  LISTING_CLASS_BY_ID,
  getListingClass,
  isCoreAggregateListingClass,
} from "../listing-governance";
import { TRACKED_STABLECOINS } from "../registry";

describe("listing governance", () => {
  it("has one authoritative decision for every tracked row and retained cemetery decision", () => {
    const trackedIds = new Set(TRACKED_STABLECOINS.map((coin) => coin.id));
    const cemeteryIds = new Set(DEAD_STABLECOINS.map((coin) => coin.id));
    const retainedCemeteryIds = [...LISTING_CLASS_BY_ID.keys()].filter((id) => !trackedIds.has(id));

    expect(LISTING_CLASS_BY_ID.size).toBe(TRACKED_STABLECOINS.length + retainedCemeteryIds.length);
    for (const coin of TRACKED_STABLECOINS) {
      expect(getListingClass(coin.id), coin.id).not.toBeNull();
    }
    for (const id of retainedCemeteryIds) {
      expect(cemeteryIds.has(id), id).toBe(true);
      expect(getListingClass(id), id).toBe("excluded");
    }
    expect(retainedCemeteryIds).toContain("xai-silo-finance");
  });

  it("limits the core aggregate to monetary and cash-equivalent classes", () => {
    expect(isCoreAggregateListingClass("core-stablecoin")).toBe(true);
    expect(isCoreAggregateListingClass("cash-equivalent")).toBe(true);
    expect(isCoreAggregateListingClass("stablecoin-variant")).toBe(false);
    expect(isCoreAggregateListingClass("stable-value-investment")).toBe(false);
    expect(isCoreAggregateListingClass("excluded")).toBe(false);
  });
});
