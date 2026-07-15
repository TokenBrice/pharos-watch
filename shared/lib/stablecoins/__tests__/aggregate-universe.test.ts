import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "../registry";
import {
  ACTIVE_STABLE_VALUE_INVESTMENTS,
  ACTIVE_VARIANT_STABLECOINS,
  CORE_AGGREGATE_ACTIVE_IDS,
  CORE_AGGREGATE_ACTIVE_STABLECOINS,
} from "../aggregate-registry";
import { filterCoreAggregateStablecoins, isCoreAggregateStablecoinId } from "../aggregate-universe";
import { getListingClass } from "../listing-governance";

describe("core stablecoin aggregate universe", () => {
  it("includes only reviewed core stablecoins and cash equivalents", () => {
    expect(CORE_AGGREGATE_ACTIVE_STABLECOINS.length).toBeGreaterThan(0);

    for (const stablecoin of CORE_AGGREGATE_ACTIVE_STABLECOINS) {
      expect(["core-stablecoin", "cash-equivalent"]).toContain(getListingClass(stablecoin.id));
      expect(CORE_AGGREGATE_ACTIVE_IDS.has(stablecoin.id)).toBe(true);
      expect(isCoreAggregateStablecoinId(stablecoin.id)).toBe(true);
    }
  });

  it("keeps variants and stable-value investments outside the monetary aggregate", () => {
    expect(ACTIVE_VARIANT_STABLECOINS.length).toBeGreaterThan(0);
    expect(ACTIVE_STABLE_VALUE_INVESTMENTS.length).toBeGreaterThan(0);

    for (const stablecoin of [...ACTIVE_VARIANT_STABLECOINS, ...ACTIVE_STABLE_VALUE_INVESTMENTS]) {
      expect(CORE_AGGREGATE_ACTIVE_IDS.has(stablecoin.id)).toBe(false);
    }
  });

  it("fails closed for rows without a listing decision", () => {
    expect(isCoreAggregateStablecoinId("unreviewed-asset")).toBe(false);
    expect(filterCoreAggregateStablecoins([{ id: "unreviewed-asset" }])).toEqual([]);
  });

  it("partitions every active listing into the reviewed aggregate classes", () => {
    const classifiedCount =
      CORE_AGGREGATE_ACTIVE_STABLECOINS.length +
      ACTIVE_VARIANT_STABLECOINS.length +
      ACTIVE_STABLE_VALUE_INVESTMENTS.length;

    expect(classifiedCount).toBe(ACTIVE_STABLECOINS.length);
  });
});
