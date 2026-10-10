import { describe, it, expect } from "vitest";
import {
  sumPegBucketsOrNull,
  getCirculatingRawOrNull,
  getPrevDayRawOrNull,
  getPrevWeekRawOrNull,
  getPrevMonthRawOrNull,
} from "../supply";
import { makeStablecoin } from "../../test-utils/stablecoin";
import { NUMERIC_INPUT_STATES } from "../../test-utils/boundary-contract-vectors.test-support";

describe("sumPegBucketsOrNull", () => {
  it("preserves absent and invalid records instead of publishing a known subtotal", () => {
    const unavailableBuckets: Parameters<typeof sumPegBucketsOrNull>[0][] = [
      undefined, null, {}, { usd: 100, eur: NaN }, { usd: 100, eur: Infinity },
      { usd: 100, eur: -1 }, { usd: Number.MAX_VALUE, eur: Number.MAX_VALUE },
    ];
    for (const buckets of unavailableBuckets) {
      expect(sumPegBucketsOrNull(buckets)).toBeNull();
    }
  });

  it("preserves explicit zero and wholly observed sums", () => {
    expect(sumPegBucketsOrNull({ usd: 0 })).toBe(0);
    expect(sumPegBucketsOrNull({ usd: 100, eur: 50, gbp: 25 })).toBe(175);
  });
});

describe("shared numeric input states", () => {
  const expected = { absent: null, null: null, nan: null, infinite: null, negative: null, zero: 0, positive: 100 };
  it.each(NUMERIC_INPUT_STATES)("preserves $state at current and historical supply boundaries", ({ state, value }) => {
    const buckets = value === undefined ? undefined : { peggedUSD: value as number };
    const coin = makeStablecoin({
      circulating: buckets, circulatingPrevDay: buckets,
      circulatingPrevWeek: buckets, circulatingPrevMonth: buckets,
    });
    expect(sumPegBucketsOrNull(buckets)).toBe(expected[state]);
    for (const readSupply of [getCirculatingRawOrNull, getPrevDayRawOrNull, getPrevWeekRawOrNull, getPrevMonthRawOrNull]) {
      expect(readSupply(coin)).toBe(expected[state]);
    }
  });
});

describe("getCirculatingRawOrNull", () => {
  it("returns null when the asset is absent from the payload", () => {
    expect(getCirculatingRawOrNull(undefined)).toBeNull();
    expect(getCirculatingRawOrNull(null)).toBeNull();
  });

  it("returns null when the asset carries no circulating buckets", () => {
    expect(getCirculatingRawOrNull(makeStablecoin({ circulating: undefined }))).toBeNull();
  });

  it("returns null for an empty bucket record", () => {
    expect(getCirculatingRawOrNull(makeStablecoin({ circulating: {} }))).toBeNull();
  });

  it("returns null when all buckets are missing-equivalent", () => {
    const coin = makeStablecoin({
      circulating: {
        peggedEUR: null as unknown as number,
        peggedGBP: undefined as unknown as number,
      },
    });
    expect(getCirculatingRawOrNull(coin)).toBeNull();
  });

  it("returns null when all buckets are non-finite", () => {
    const coin = makeStablecoin({
      circulating: {
        peggedUSD: NaN,
        peggedEUR: Infinity,
        peggedGBP: -Infinity,
      },
    });
    expect(getCirculatingRawOrNull(coin)).toBeNull();
  });

  it("returns zero when an explicit finite bucket is zero", () => {
    const coin = makeStablecoin({
      circulating: {
        peggedUSD: 0,
      },
    });
    expect(getCirculatingRawOrNull(coin)).toBe(0);
  });

  it("rejects a negative bucket rather than cancelling known supply", () => {
    const coin = makeStablecoin({ circulating: { peggedUSD: 100, peggedEUR: -100 } });
    expect(getCirculatingRawOrNull(coin)).toBeNull();
  });

  it("returns the summed USD value when bucket data exists", () => {
    const coin = makeStablecoin({
      circulating: { peggedUSD: 1_000_000, peggedEUR: 250_000 },
    });
    expect(getCirculatingRawOrNull(coin)).toBe(1_250_000);
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

  it("rejects negative historical buckets", () => {
    const coin = makeStablecoin({ circulatingPrevDay: { peggedUSD: 100, peggedEUR: -100 } });
    expect(getPrevDayRawOrNull(coin)).toBeNull();
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
