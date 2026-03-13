import { describe, expect, it } from "vitest";
import { compareYieldRows, type YieldTableSortKey } from "@/components/yield-table-logic";
import type { YieldRanking } from "@shared/types";
import type { TableSortState } from "@/hooks/use-sorted-table-rows";

function makeYield(overrides: Partial<YieldRanking> = {}): YieldRanking {
  return {
    id: "usdc",
    symbol: "USDC",
    name: "USD Coin",
    currentApy: 5.0,
    apy7d: 5.0,
    apy30d: 5.0,
    apyBase: null,
    apyReward: null,
    yieldSource: "Compound",
    yieldSourceUrl: null,
    yieldType: "lending-vault",
    dataSource: "defillama",
    sourceTvlUsd: 1_000_000,
    pharosYieldScore: 50,
    safetyScore: 80,
    safetyGrade: "A",
    yieldToRisk: 1.0,
    excessYield: 2.0,
    yieldStability: 0.9,
    apyVariance30d: 0.5,
    apyMin30d: 4.5,
    apyMax30d: 5.5,
    warningSignals: [],
    altSources: [],
    ...overrides,
  };
}

const sort = (key: YieldTableSortKey, direction: "asc" | "desc" = "desc"): TableSortState<YieldTableSortKey> => ({
  key,
  direction,
});

describe("compareYieldRows — pys (pharosYieldScore)", () => {
  it("sorts by PYS descending", () => {
    const high = makeYield({ pharosYieldScore: 90 });
    const low = makeYield({ pharosYieldScore: 30 });
    const result = compareYieldRows(high, low, sort("pys", "desc"));
    expect(result).toBeLessThan(0); // high ranks first
  });

  it("sorts by PYS ascending", () => {
    const high = makeYield({ pharosYieldScore: 90 });
    const low = makeYield({ pharosYieldScore: 30 });
    const result = compareYieldRows(high, low, sort("pys", "asc"));
    expect(result).toBeGreaterThan(0); // low ranks first
  });

  it("treats null PYS as -1 (worst rank)", () => {
    const withScore = makeYield({ pharosYieldScore: 10 });
    const nullScore = makeYield({ pharosYieldScore: null });
    const result = compareYieldRows(withScore, nullScore, sort("pys", "desc"));
    expect(result).toBeLessThan(0); // withScore > nullScore
  });

  it("handles two null PYS as equal", () => {
    const a = makeYield({ pharosYieldScore: null });
    const b = makeYield({ pharosYieldScore: null });
    const result = compareYieldRows(a, b, sort("pys", "desc"));
    expect(result).toBe(0);
  });
});

describe("compareYieldRows — apy30d", () => {
  it("sorts by 30d APY descending", () => {
    const high = makeYield({ apy30d: 15.0 });
    const low = makeYield({ apy30d: 3.0 });
    const result = compareYieldRows(high, low, sort("apy30d", "desc"));
    expect(result).toBeLessThan(0);
  });

  it("sorts by 30d APY ascending", () => {
    const high = makeYield({ apy30d: 15.0 });
    const low = makeYield({ apy30d: 3.0 });
    const result = compareYieldRows(high, low, sort("apy30d", "asc"));
    expect(result).toBeGreaterThan(0);
  });
});

describe("compareYieldRows — safetyScore", () => {
  it("sorts by safety score descending", () => {
    const safe = makeYield({ safetyScore: 95 });
    const risky = makeYield({ safetyScore: 30 });
    const result = compareYieldRows(safe, risky, sort("safetyScore", "desc"));
    expect(result).toBeLessThan(0);
  });

  it("treats null safetyScore as -1", () => {
    const scored = makeYield({ safetyScore: 1 });
    const nulled = makeYield({ safetyScore: null });
    const result = compareYieldRows(scored, nulled, sort("safetyScore", "desc"));
    expect(result).toBeLessThan(0);
  });
});

describe("compareYieldRows — tvl", () => {
  it("sorts by TVL descending", () => {
    const big = makeYield({ sourceTvlUsd: 1_000_000_000 });
    const small = makeYield({ sourceTvlUsd: 1_000 });
    const result = compareYieldRows(big, small, sort("tvl", "desc"));
    expect(result).toBeLessThan(0);
  });

  it("treats null TVL as 0", () => {
    const hasTvl = makeYield({ sourceTvlUsd: 100 });
    const noTvl = makeYield({ sourceTvlUsd: null });
    const result = compareYieldRows(hasTvl, noTvl, sort("tvl", "desc"));
    expect(result).toBeLessThan(0);
  });
});

describe("compareYieldRows — yieldStability", () => {
  it("sorts by yield stability descending", () => {
    const stable = makeYield({ yieldStability: 0.95 });
    const volatile = makeYield({ yieldStability: 0.2 });
    const result = compareYieldRows(stable, volatile, sort("yieldStability", "desc"));
    expect(result).toBeLessThan(0);
  });

  it("treats null yieldStability as -1", () => {
    const hasStability = makeYield({ yieldStability: 0.01 });
    const nullStability = makeYield({ yieldStability: null });
    const result = compareYieldRows(hasStability, nullStability, sort("yieldStability", "desc"));
    expect(result).toBeLessThan(0);
  });
});

describe("compareYieldRows — yieldType", () => {
  it("sorts by yieldType lexicographically ascending", () => {
    const lending = makeYield({ yieldType: "lending-vault" });
    const rebase = makeYield({ yieldType: "rebase" });
    const result = compareYieldRows(lending, rebase, sort("yieldType", "asc"));
    // "lending-vault" < "rebase" → result < 0 → lending ranks first
    expect(result).toBeLessThan(0);
  });

  it("sorts by yieldType lexicographically descending", () => {
    const lending = makeYield({ yieldType: "lending-vault" });
    const rebase = makeYield({ yieldType: "rebase" });
    const result = compareYieldRows(lending, rebase, sort("yieldType", "desc"));
    // desc: b.localeCompare(a) → "rebase".localeCompare("lending-vault") > 0 → rebase ranks first
    expect(result).toBeGreaterThan(0);
  });
});

describe("compareYieldRows — default fallback", () => {
  it("falls back to PYS for unknown sort key", () => {
    const high = makeYield({ pharosYieldScore: 80 });
    const low = makeYield({ pharosYieldScore: 20 });
    const result = compareYieldRows(high, low, { key: "unknown" as YieldTableSortKey, direction: "desc" });
    expect(result).toBeLessThan(0); // high ranks first
  });
});
