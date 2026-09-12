import { describe, expect, it } from "vitest";

import { buildYieldStoryCallouts } from "@/lib/yield-story-callouts";
import { row } from "./yield-story-callouts.test-support";

describe("buildYieldStoryCallouts", () => {
  it("selects top yield, stable A-grade yield, and largest tracked market deterministically", () => {
    const callouts = buildYieldStoryCallouts([
      row("lusd", { apy30d: 7.2, safetyGrade: "A", yieldStability: 0.8, sourceTvlUsd: 5_000_000 }),
      row("usdc", { apy30d: 4.2, safetyGrade: "A+", yieldStability: 0.95, sourceTvlUsd: 40_000_000 }),
      row("usdt", { apy30d: 8.5, safetyGrade: "C", yieldStability: 0.7, sourceTvlUsd: 30_000_000 }),
    ]);

    expect(callouts?.topYield?.id).toBe("usdt");
    expect(callouts?.mostStable?.id).toBe("usdc");
    expect(callouts?.largestMarket?.id).toBe("usdc");
  });

  it("counts the rows the largest-market tile excludes for unmeasured TVL", () => {
    const callouts = buildYieldStoryCallouts([
      row("usdc", { apy30d: 4.2, sourceTvlUsd: 40_000_000 }),
      row("usde", { apy30d: 8.1, sourceTvlUsd: null }),
      row("buidl", { apy30d: 4.9, sourceTvlUsd: 0 }),
      row("tether", { apy30d: 3.3, sourceTvlUsd: 10_000_000 }),
    ]);

    // A native giant with no TVL figure can never win the tile; the count
    // footnotes that exclusion instead of presenting the tile as absolute fact.
    expect(callouts?.largestMarket?.id).toBe("usdc");
    expect(callouts?.unmeasuredTvlCount).toBe(2);
  });

  it("reports zero exclusions when every row publishes TVL", () => {
    const callouts = buildYieldStoryCallouts([
      row("usdc", { sourceTvlUsd: 40_000_000 }),
      row("usdt", { sourceTvlUsd: 30_000_000 }),
    ]);

    expect(callouts?.unmeasuredTvlCount).toBe(0);
  });

  it("returns null when filters hide every row", () => {
    expect(buildYieldStoryCallouts([])).toBeNull();
  });
});
