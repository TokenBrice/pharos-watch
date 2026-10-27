import { describe, expect, it } from "vitest";
import { selectActiveDepegCoins } from "../active-depegs";
import { describeHomepageSupplyCoverage, isHomepageSupplyComplete } from "../homepage-hero-snapshot";

describe("selectActiveDepegCoins", () => {
  it("counts flagged coins over the active registry only", () => {
    const coins = [
      { id: "a", activeDepeg: true },
      { id: "b", activeDepeg: false },
      { id: "retired", activeDepeg: true },
    ];
    expect(selectActiveDepegCoins(coins, new Set(["a", "b"])).map((coin) => coin.id)).toEqual(["a"]);
  });
});

describe("homepage supply completeness", () => {
  it("names a known subtotal and stays silent when every member is observed", () => {
    const recorded = { supplyPartialCount: 0, supplyCoverageUnknownCount: 0 };
    expect(isHomepageSupplyComplete({ supplyObservedCount: 267, supplyExpectedCount: 267, ...recorded })).toBe(true);
    expect(describeHomepageSupplyCoverage({ supplyObservedCount: 267, supplyExpectedCount: 267, ...recorded })).toBeNull();
    expect(describeHomepageSupplyCoverage({ supplyObservedCount: 266, supplyExpectedCount: 267, ...recorded })).toBe("Partial · 266/267 assets observed");
  });

  it("never certifies a partial-chain remainder or unrecorded coverage as complete (K-031)", () => {
    // All 267 members numeric, one excluding a chain: still a known subtotal.
    expect(isHomepageSupplyComplete({
      supplyObservedCount: 267, supplyExpectedCount: 267, supplyPartialCount: 1, supplyCoverageUnknownCount: 0,
    })).toBe(false);
    expect(describeHomepageSupplyCoverage({
      supplyObservedCount: 267, supplyExpectedCount: 267, supplyPartialCount: 1, supplyCoverageUnknownCount: 0,
    })).toBe("Partial · 266/267 assets observed");
    // Old payloads omit the counts: absence never means zero.
    expect(isHomepageSupplyComplete({ supplyObservedCount: 267, supplyExpectedCount: 267 })).toBe(false);
  });
});
