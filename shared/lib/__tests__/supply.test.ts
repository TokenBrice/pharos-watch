import { describe, it, expect } from "vitest";
import {
  sumPegBuckets,
  getCirculatingRaw,
  getPrevDayRaw,
  getPrevDayRawOrNull,
  getPrevWeekRaw,
  getPrevWeekRawOrNull,
  getPrevMonthRawOrNull,
  computeGovernanceBreakdown,
} from "../supply";
import type { GovernanceType, StablecoinData } from "../../types";
import { TRACKED_META_BY_ID } from "../stablecoins";

function mockCoin(overrides: Partial<StablecoinData> = {}): StablecoinData {
  return overrides as StablecoinData;
}

function trackedIdByGovernance(governance: GovernanceType): string {
  for (const [id, meta] of TRACKED_META_BY_ID.entries()) {
    if (meta.flags.governance === governance) return id;
  }
  throw new Error(`No tracked coin found for governance=${governance}`);
}

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

describe("getPrevDayRaw", () => {
  it("sums circulatingPrevDay peg buckets", () => {
    const coin = mockCoin({
      circulatingPrevDay: { peggedUSD: 900_000 },
    });
    expect(getPrevDayRaw(coin)).toBe(900_000);
  });

  it("returns 0 when circulatingPrevDay is undefined", () => {
    expect(getPrevDayRaw(mockCoin())).toBe(0);
  });
});

describe("getPrevDayRawOrNull", () => {
  it("returns null when circulatingPrevDay is undefined", () => {
    expect(getPrevDayRawOrNull(mockCoin())).toBeNull();
  });

  it("returns null when all buckets are missing-equivalent", () => {
    const coin = mockCoin({
      circulatingPrevDay: {
        peggedUSD: 0,
        peggedEUR: null as unknown as number,
        peggedGBP: undefined as unknown as number,
      },
    });
    expect(getPrevDayRawOrNull(coin)).toBeNull();
  });

  it("returns zero when real bucket data exists but sums to zero", () => {
    const coin = mockCoin({
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
    const coin = mockCoin({
      circulatingPrevWeek: { peggedUSD: 800_000, peggedEUR: 100_000 },
    });
    expect(getPrevWeekRaw(coin)).toBe(900_000);
  });

  it("returns 0 when circulatingPrevWeek is undefined", () => {
    expect(getPrevWeekRaw(mockCoin())).toBe(0);
  });
});

describe("getPrevWeekRawOrNull", () => {
  it("returns null when circulatingPrevWeek is undefined", () => {
    expect(getPrevWeekRawOrNull(mockCoin())).toBeNull();
  });

  it("returns summed value when any bucket has data", () => {
    const coin = mockCoin({
      circulatingPrevWeek: { peggedUSD: 800_000, peggedEUR: 100_000 },
    });
    expect(getPrevWeekRawOrNull(coin)).toBe(900_000);
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

describe("computeGovernanceBreakdown", () => {
  const centralizedId = trackedIdByGovernance("centralized");
  const dependentId = trackedIdByGovernance("centralized-dependent");
  const decentralizedId = trackedIdByGovernance("decentralized");

  it("splits market cap by governance tier", () => {
    const data = [
      mockCoin({ id: centralizedId, circulating: { peggedUSD: 100 } }),
      mockCoin({ id: dependentId, circulating: { peggedUSD: 50 } }),
      mockCoin({ id: decentralizedId, circulating: { peggedUSD: 25 } }),
    ];

    const result = computeGovernanceBreakdown(data);
    expect(result.centralizedMcap).toBe(100);
    expect(result.dependentMcap).toBe(50);
    expect(result.decentralizedMcap).toBe(25);
    expect(result.total).toBe(175);
    expect(result.cefiPct).toBeCloseTo(57.142857, 5);
    expect(result.depPct).toBeCloseTo(28.571428, 5);
    expect(result.defiPct).toBeCloseTo(14.285714, 5);
  });

  it("skips coins that are not in tracked metadata", () => {
    const data = [
      mockCoin({ id: centralizedId, circulating: { peggedUSD: 100 } }),
      mockCoin({ id: "999999", circulating: { peggedUSD: 500 } }),
    ];

    const result = computeGovernanceBreakdown(data);
    expect(result.centralizedMcap).toBe(100);
    expect(result.total).toBe(100);
    expect(result.cefiPct).toBe(100);
  });

  it("returns 0 percentages when total market cap is 0", () => {
    const data = [
      mockCoin({ id: centralizedId, circulating: { peggedUSD: NaN } }),
      mockCoin({ id: dependentId, circulating: { peggedUSD: Infinity } }),
      mockCoin({ id: decentralizedId, circulating: { peggedUSD: null as unknown as number } }),
    ];

    const result = computeGovernanceBreakdown(data);
    expect(result.total).toBe(0);
    expect(result.cefiPct).toBe(0);
    expect(result.depPct).toBe(0);
    expect(result.defiPct).toBe(0);
  });

  it("coerces invalid circulating bucket values to 0", () => {
    const data = [
      mockCoin({
        id: centralizedId,
        circulating: {
          peggedUSD: 100,
          peggedEUR: NaN,
          peggedGBP: Infinity,
        },
      }),
      mockCoin({
        id: dependentId,
        circulating: {
          peggedUSD: 25,
          peggedJPY: null as unknown as number,
        },
      }),
      mockCoin({
        id: decentralizedId,
        circulating: {
          peggedUSD: -5,
          peggedCHF: -Infinity,
        },
      }),
    ];

    const result = computeGovernanceBreakdown(data);
    expect(result.centralizedMcap).toBe(100);
    expect(result.dependentMcap).toBe(25);
    expect(result.decentralizedMcap).toBe(-5);
    expect(result.total).toBe(120);
  });
});
