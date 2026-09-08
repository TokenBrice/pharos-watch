// @vitest-environment node

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

describe("compareYieldRows — numeric keys", () => {
  it.each(
    [
      ["pys", makeYield({ pharosYieldScore: 90 }), makeYield({ pharosYieldScore: 30 })],
      ["apy30d", makeYield({ apy30d: 15 }), makeYield({ apy30d: 3 })],
      ["safetyScore", makeYield({ safetyScore: 95 }), makeYield({ safetyScore: 30 })],
      ["tvl", makeYield({ sourceTvlUsd: 1_000_000_000 }), makeYield({ sourceTvlUsd: 1_000 })],
      ["yieldStability", makeYield({ yieldStability: 0.95 }), makeYield({ yieldStability: 0.2 })],
    ] as const,
  )("orders %s high before low on desc and reversed on asc", (key, high, low) => {
    expect(compareYieldRows(high, low, sort(key, "desc"))).toBeLessThan(0);
    expect(compareYieldRows(low, high, sort(key, "desc"))).toBeGreaterThan(0);
    expect(compareYieldRows(high, low, sort(key, "asc"))).toBeGreaterThan(0);
    expect(compareYieldRows(low, high, sort(key, "asc"))).toBeLessThan(0);
  });

  it.each(
    [
      ["pys", makeYield({ pharosYieldScore: 10 }), makeYield({ pharosYieldScore: null })],
      ["safetyScore", makeYield({ safetyScore: 1 }), makeYield({ safetyScore: null })],
      ["tvl", makeYield({ sourceTvlUsd: 100 }), makeYield({ sourceTvlUsd: null })],
      ["yieldStability", makeYield({ yieldStability: 0.01 }), makeYield({ yieldStability: null })],
    ] as const,
  )("treats null %s as worst rank and null/null as equal", (key, valued, nullRow) => {
    expect(compareYieldRows(valued, nullRow, sort(key, "desc"))).toBeLessThan(0);
    expect(compareYieldRows(nullRow, valued, sort(key, "desc"))).toBeGreaterThan(0);
    expect(compareYieldRows(nullRow, nullRow, sort(key, "desc"))).toBe(0);
  });
});

describe("compareYieldRows — yieldType", () => {
  it.each(["asc", "desc"] as const)("sorts lexicographically %s", (direction) => {
    const lending = makeYield({ yieldType: "lending-vault" });
    const rebase = makeYield({ yieldType: "rebase" });

    const result = compareYieldRows(lending, rebase, sort("yieldType", direction));
    expect(Math.sign(result)).toBe(direction === "asc" ? -1 : 1);
    expect(Math.sign(compareYieldRows(rebase, lending, sort("yieldType", direction)))).toBe(
      direction === "asc" ? 1 : -1,
    );
  });
});

describe("compareYieldRows — default fallback", () => {
  it("returns 0 for unknown key", () => {
    const high = makeYield({ pharosYieldScore: 80 });
    const low = makeYield({ pharosYieldScore: 20 });
    const result = compareYieldRows(high, low, { key: "unknown" as YieldTableSortKey, direction: "desc" });
    expect(result).toBe(0);
  });
});
