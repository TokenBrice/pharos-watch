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
    const partitions = [
      CORE_AGGREGATE_ACTIVE_STABLECOINS, ACTIVE_VARIANT_STABLECOINS, ACTIVE_STABLE_VALUE_INVESTMENTS,
    ].map((coins) => coins.map((coin) => coin.id));
    const ids = partitions.flat();
    expect(ids.toSorted()).toEqual(ACTIVE_STABLECOINS.map((coin) => coin.id).toSorted());
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 0; i < partitions.length; i++) {
      for (const other of partitions.slice(i + 1)) {
        expect(partitions[i].filter((id) => other.includes(id))).toEqual([]);
      }
    }
  });
});
