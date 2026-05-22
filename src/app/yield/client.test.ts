import { describe, expect, it } from "vitest";

import { buildYieldStoryCallouts } from "@/app/yield/client";
import type { YieldViewModelRow } from "@/lib/yield-view-model";

function row(
  id: string,
  overrides: Partial<YieldViewModelRow>,
): YieldViewModelRow {
  return {
    id,
    symbol: id.toUpperCase(),
    name: id,
    apy30d: 0,
    safetyGrade: "B",
    yieldStability: null,
    sourceTvlUsd: null,
    warningSignals: [],
    ...overrides,
  } as YieldViewModelRow;
}

describe("buildYieldStoryCallouts", () => {
  it("selects top yield, stable A-grade yield, and largest TVL deterministically", () => {
    const callouts = buildYieldStoryCallouts([
      row("lusd", { apy30d: 7.2, safetyGrade: "A", yieldStability: 0.8, sourceTvlUsd: 5_000_000 }),
      row("usdc", { apy30d: 4.2, safetyGrade: "A+", yieldStability: 0.95, sourceTvlUsd: 40_000_000 }),
      row("usdt", { apy30d: 8.5, safetyGrade: "C", yieldStability: 0.7, sourceTvlUsd: 30_000_000 }),
    ]);

    expect(callouts?.topYield?.id).toBe("usdt");
    expect(callouts?.mostStable?.id).toBe("usdc");
    expect(callouts?.largestMarket?.id).toBe("usdc");
  });

  it("returns null when filters hide every row", () => {
    expect(buildYieldStoryCallouts([])).toBeNull();
  });
});
