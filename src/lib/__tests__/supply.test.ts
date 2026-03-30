import { describe, expect, it } from "vitest";
import {
  computeGovernanceBreakdown,
  getPrevDayRaw,
  getPrevDayRawOrNull,
  getPrevWeekRaw,
  getPrevWeekRawOrNull,
} from "@shared/lib/supply";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { GovernanceType, StablecoinData } from "@shared/types";

function mockCoin(overrides: Partial<StablecoinData> = {}): StablecoinData {
  return overrides as StablecoinData;
}

function trackedIdByGovernance(governance: GovernanceType): string {
  for (const [id, meta] of TRACKED_META_BY_ID.entries()) {
    if (meta.flags.governance === governance) return id;
  }
  throw new Error(`No tracked coin found for governance=${governance}`);
}

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
});
