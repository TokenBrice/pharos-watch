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
    expect(isHomepageSupplyComplete({ supplyObservedCount: 267, supplyExpectedCount: 267 })).toBe(true);
    expect(describeHomepageSupplyCoverage({ supplyObservedCount: 267, supplyExpectedCount: 267 })).toBeNull();
    expect(describeHomepageSupplyCoverage({ supplyObservedCount: 266, supplyExpectedCount: 267 })).toBe("Partial · 266/267 assets observed");
  });
});
