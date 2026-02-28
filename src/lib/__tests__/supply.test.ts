import { describe, it, expect } from "vitest";
import {
  sumPegBuckets,
  getCirculatingRaw,
  getPrevDayRaw,
  getPrevWeekRaw,
  getPrevMonthRaw,
} from "../supply";
import type { StablecoinData } from "../types";

/** Minimal mock — only the fields each function accesses */
function mockCoin(overrides: Partial<StablecoinData> = {}): StablecoinData {
  return overrides as StablecoinData;
}

// ---------------------------------------------------------------------------
// sumPegBuckets
// ---------------------------------------------------------------------------
describe("sumPegBuckets", () => {
  it("sums all values in a record", () => {
    expect(sumPegBuckets({ peggedUSD: 1_000_000, peggedEUR: 500_000 })).toBe(
      1_500_000
    );
  });

  it("sums a single-key record", () => {
    expect(sumPegBuckets({ peggedUSD: 42 })).toBe(42);
  });

  it("returns 0 for an empty record", () => {
    expect(sumPegBuckets({})).toBe(0);
  });

  it("returns 0 for undefined input", () => {
    expect(sumPegBuckets(undefined)).toBe(0);
  });

  it("treats NaN values as 0", () => {
    expect(sumPegBuckets({ peggedUSD: NaN, peggedEUR: 100 })).toBe(100);
  });

  it("treats null values as 0", () => {
    expect(sumPegBuckets({ peggedUSD: null as unknown as number, peggedEUR: 200 })).toBe(200);
  });

  it("treats Infinity as 0", () => {
    expect(sumPegBuckets({ peggedUSD: Infinity, peggedEUR: 300 })).toBe(300);
    expect(sumPegBuckets({ peggedUSD: -Infinity, peggedEUR: 400 })).toBe(400);
  });

  it("handles a mix of valid and invalid values", () => {
    expect(
      sumPegBuckets({
        peggedUSD: 1000,
        peggedEUR: NaN,
        peggedGBP: null as unknown as number,
        peggedCHF: Infinity,
        peggedJPY: 500,
      })
    ).toBe(1500);
  });
});

// ---------------------------------------------------------------------------
// getCirculatingRaw
// ---------------------------------------------------------------------------
describe("getCirculatingRaw", () => {
  it("sums circulating peg buckets", () => {
    const coin = mockCoin({
      circulating: { peggedUSD: 1_000_000, peggedEUR: 500_000 },
    });
    expect(getCirculatingRaw(coin)).toBe(1_500_000);
  });

  it("returns 0 when circulating is undefined", () => {
    const coin = mockCoin();
    expect(getCirculatingRaw(coin)).toBe(0);
  });

  it("returns 0 when circulating is empty", () => {
    const coin = mockCoin({ circulating: {} });
    expect(getCirculatingRaw(coin)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getPrevDayRaw
// ---------------------------------------------------------------------------
describe("getPrevDayRaw", () => {
  it("sums circulatingPrevDay peg buckets", () => {
    const coin = mockCoin({
      circulatingPrevDay: { peggedUSD: 900_000 },
    });
    expect(getPrevDayRaw(coin)).toBe(900_000);
  });

  it("returns 0 when circulatingPrevDay is undefined", () => {
    const coin = mockCoin();
    expect(getPrevDayRaw(coin)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getPrevWeekRaw
// ---------------------------------------------------------------------------
describe("getPrevWeekRaw", () => {
  it("sums circulatingPrevWeek peg buckets", () => {
    const coin = mockCoin({
      circulatingPrevWeek: { peggedUSD: 800_000, peggedEUR: 100_000 },
    });
    expect(getPrevWeekRaw(coin)).toBe(900_000);
  });

  it("returns 0 when circulatingPrevWeek is undefined", () => {
    const coin = mockCoin();
    expect(getPrevWeekRaw(coin)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getPrevMonthRaw
// ---------------------------------------------------------------------------
describe("getPrevMonthRaw", () => {
  it("sums circulatingPrevMonth peg buckets", () => {
    const coin = mockCoin({
      circulatingPrevMonth: { peggedUSD: 700_000 },
    });
    expect(getPrevMonthRaw(coin)).toBe(700_000);
  });

  it("returns 0 when circulatingPrevMonth is undefined", () => {
    const coin = mockCoin();
    expect(getPrevMonthRaw(coin)).toBe(0);
  });
});
