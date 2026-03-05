import { describe, it, expect } from "vitest";
import {
  sumPegBuckets,
  getCirculatingRaw,
  getPrevDayRaw,
  getPrevWeekRaw,
  getPrevMonthRaw,
  computeGovernanceBreakdown,
} from "@shared/lib/supply";
import type { GovernanceType, StablecoinData } from "@shared/types";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";

/** Minimal mock — only the fields each function accesses */
function mockCoin(overrides: Partial<StablecoinData> = {}): StablecoinData {
  return overrides as StablecoinData;
}

function trackedIdByGovernance(governance: GovernanceType): string {
  for (const [id, meta] of TRACKED_META_BY_ID.entries()) {
    if (meta.flags.governance === governance) return id;
  }
  throw new Error(`No tracked coin found for governance=${governance}`);
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

// ---------------------------------------------------------------------------
// computeGovernanceBreakdown
// ---------------------------------------------------------------------------
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
