import { describe, it, expect } from "vitest";
import {
  sumPegBuckets,
  getCirculatingRaw,
  getPrevDayRaw,
  getPrevDayRawOrNull,
  getPrevWeekRaw,
  getPrevWeekRawOrNull,
  getPrevMonthRawOrNull,
} from "../supply";
import { makeStablecoin } from "../../test-utils/stablecoin";

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
    const coin = makeStablecoin({ circulating: { usd: 1_000_000 } });
    expect(getCirculatingRaw(coin)).toBe(1_000_000);
  });
});

describe("getPrevDayRaw", () => {
  it("sums circulatingPrevDay peg buckets", () => {
    const coin = makeStablecoin({
      circulatingPrevDay: { peggedUSD: 900_000 },
    });
    expect(getPrevDayRaw(coin)).toBe(900_000);
  });

  it("returns 0 when circulatingPrevDay is undefined", () => {
    expect(getPrevDayRaw(makeStablecoin({ circulatingPrevDay: undefined }))).toBe(0);
  });
});

describe("getPrevDayRawOrNull", () => {
  it("returns null when circulatingPrevDay is undefined", () => {
    expect(getPrevDayRawOrNull(makeStablecoin({ circulatingPrevDay: undefined }))).toBeNull();
  });

  it("returns null when all buckets are missing-equivalent", () => {
    const coin = makeStablecoin({
      circulatingPrevDay: {
        peggedEUR: null as unknown as number,
        peggedGBP: undefined as unknown as number,
      },
    });
    expect(getPrevDayRawOrNull(coin)).toBeNull();
  });

  it("returns zero when an explicit finite bucket is zero", () => {
    const coin = makeStablecoin({
      circulatingPrevDay: {
        peggedUSD: 0,
      },
    });
    expect(getPrevDayRawOrNull(coin)).toBe(0);
  });

  it("returns zero when real bucket data exists but sums to zero", () => {
    const coin = makeStablecoin({
      circulatingPrevDay: {
        peggedUSD: 100,
        peggedEUR: -100,
      },
    });
    expect(getPrevDayRawOrNull(coin)).toBe(0);
  });
});

describe("getPrevWeekRaw", () => {
  it("sums circulatingPrevWeek peg buckets", () => {
    const coin = makeStablecoin({
      circulatingPrevWeek: { peggedUSD: 800_000, peggedEUR: 100_000 },
    });
    expect(getPrevWeekRaw(coin)).toBe(900_000);
  });

  it("returns 0 when circulatingPrevWeek is undefined", () => {
    expect(getPrevWeekRaw(makeStablecoin({ circulatingPrevWeek: undefined }))).toBe(0);
  });
});

describe("getPrevWeekRawOrNull", () => {
  it("returns null when circulatingPrevWeek is undefined", () => {
    expect(getPrevWeekRawOrNull(makeStablecoin({ circulatingPrevWeek: undefined }))).toBeNull();
  });

  it("returns zero when an explicit finite week bucket is zero", () => {
    const coin = makeStablecoin({
      circulatingPrevWeek: { peggedUSD: 0 },
    });
    expect(getPrevWeekRawOrNull(coin)).toBe(0);
  });

  it("returns summed value when any bucket has data", () => {
    const coin = makeStablecoin({
      circulatingPrevWeek: { peggedUSD: 800_000, peggedEUR: 100_000 },
    });
    expect(getPrevWeekRawOrNull(coin)).toBe(900_000);
  });
});

describe("getPrevMonthRawOrNull", () => {
  it("returns null when no prev month data", () => {
    const coin = makeStablecoin({ circulatingPrevMonth: undefined });
    expect(getPrevMonthRawOrNull(coin)).toBeNull();
  });

  it("returns zero when an explicit finite month bucket is zero", () => {
    const coin = makeStablecoin({ circulatingPrevMonth: { usd: 0 } });
    expect(getPrevMonthRawOrNull(coin)).toBe(0);
  });

  it("returns sum when data exists", () => {
    const coin = makeStablecoin({ circulatingPrevMonth: { usd: 500_000 } });
    expect(getPrevMonthRawOrNull(coin)).toBe(500_000);
  });
});
