import { describe, it, expect } from "vitest";
import { sumPegBuckets, getCirculatingRaw, getPrevMonthRawOrNull } from "../supply";

describe("sumPegBuckets", () => {
  it("returns 0 for undefined", () => {
    expect(sumPegBuckets(undefined)).toBe(0);
  });

  it("returns 0 for empty object", () => {
    expect(sumPegBuckets({})).toBe(0);
  });

  it("sums all numeric values", () => {
    expect(sumPegBuckets({ usd: 100, eur: 50, gbp: 25 })).toBe(175);
  });

  it("treats NaN as 0", () => {
    expect(sumPegBuckets({ usd: 100, eur: NaN })).toBe(100);
  });

  it("treats Infinity as 0", () => {
    expect(sumPegBuckets({ usd: 100, eur: Infinity })).toBe(100);
  });

  it("treats -Infinity as 0", () => {
    expect(sumPegBuckets({ usd: 100, eur: -Infinity })).toBe(100);
  });
});

describe("getCirculatingRaw", () => {
  it("sums circulating peg buckets", () => {
    const coin = { circulating: { usd: 1_000_000 } } as never;
    expect(getCirculatingRaw(coin)).toBe(1_000_000);
  });
});

describe("getPrevMonthRawOrNull", () => {
  it("returns null when no prev month data", () => {
    const coin = { circulatingPrevMonth: undefined } as never;
    expect(getPrevMonthRawOrNull(coin)).toBeNull();
  });

  it("returns sum when data exists", () => {
    const coin = { circulatingPrevMonth: { usd: 500_000 } } as never;
    expect(getPrevMonthRawOrNull(coin)).toBe(500_000);
  });
});
