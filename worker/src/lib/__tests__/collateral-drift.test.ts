import { describe, it, expect } from "vitest";
import { computeCollateralQualityFromReserves } from "@shared/lib/report-cards";
import type { ReserveSlice } from "@shared/types";

describe("collateral score delta detection", () => {
  function computeDelta(live: ReserveSlice[], curated: ReserveSlice[]): number {
    return Math.abs(
      computeCollateralQualityFromReserves(live) -
      computeCollateralQualityFromReserves(curated),
    );
  }

  it("detects no drift when compositions match", () => {
    const slices: ReserveSlice[] = [
      { name: "USDC", pct: 100, risk: "low" },
    ];
    expect(computeDelta(slices, slices)).toBe(0);
  });

  it("detects drift above threshold when composition diverges", () => {
    const live: ReserveSlice[] = [{ name: "ETH", pct: 100, risk: "very-low" }];
    const curated: ReserveSlice[] = [{ name: "SOL", pct: 100, risk: "high" }];
    // live = 100, curated = 25, delta = 75
    expect(computeDelta(live, curated)).toBe(75);
    expect(computeDelta(live, curated)).toBeGreaterThan(15);
  });

  it("stays below threshold for minor composition changes", () => {
    const live: ReserveSlice[] = [
      { name: "Treasuries", pct: 55, risk: "very-low" },
      { name: "USDC", pct: 45, risk: "low" },
    ];
    const curated: ReserveSlice[] = [
      { name: "Treasuries", pct: 60, risk: "very-low" },
      { name: "USDC", pct: 40, risk: "low" },
    ];
    expect(computeDelta(live, curated)).toBeLessThanOrEqual(15);
  });

  it("boundary: exactly 15 does not trigger (threshold is >15)", () => {
    // live: 40% very-low + 60% low = 40+45=85. curated: 100% very-low = 100. delta=15.
    const live: ReserveSlice[] = [
      { name: "A", pct: 40, risk: "very-low" },
      { name: "B", pct: 60, risk: "low" },
    ];
    const curated: ReserveSlice[] = [{ name: "A", pct: 100, risk: "very-low" }];
    expect(computeDelta(live, curated)).toBe(15);
  });
});
