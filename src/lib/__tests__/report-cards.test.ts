import { describe, it, expect } from "vitest";
import { computeCollateralQualityFromReserves } from "@shared/lib/report-cards";

describe("computeCollateralQualityFromReserves", () => {
  it("returns 0 for empty reserves array", () => {
    expect(computeCollateralQualityFromReserves([])).toBe(0);
  });

  it("returns 100 for 100% very-low risk reserves", () => {
    const reserves = [{ name: "US Treasuries", pct: 100, risk: "very-low" as const }];
    expect(computeCollateralQualityFromReserves(reserves)).toBe(100);
  });

  it("returns 5 for 100% very-high risk reserves", () => {
    const reserves = [{ name: "Algo backing", pct: 100, risk: "very-high" as const }];
    expect(computeCollateralQualityFromReserves(reserves)).toBe(5);
  });

  it("computes weighted average for mixed reserves", () => {
    const reserves = [
      { name: "Treasuries", pct: 60, risk: "very-low" as const },  // 60% * 100 = 6000
      { name: "Corporate bonds", pct: 40, risk: "medium" as const }, // 40% * 50  = 2000
    ];
    // (6000 + 2000) / 100 = 80
    expect(computeCollateralQualityFromReserves(reserves)).toBe(80);
  });

  it("handles reserves that don't sum to 100%", () => {
    const reserves = [
      { name: "USDC", pct: 30, risk: "low" as const },     // 30 * 75 = 2250
      { name: "ETH", pct: 20, risk: "high" as const },      // 20 * 25 = 500
    ];
    // totalPct = 50, weighted = 2750, result = 2750/50 = 55
    expect(computeCollateralQualityFromReserves(reserves)).toBe(55);
  });

  it("rounds to nearest integer", () => {
    const reserves = [
      { name: "Treasuries", pct: 70, risk: "very-low" as const },  // 70 * 100 = 7000
      { name: "Crypto", pct: 30, risk: "high" as const },           // 30 * 25  = 750
    ];
    // (7000 + 750) / 100 = 77.5, rounded to 78
    expect(computeCollateralQualityFromReserves(reserves)).toBe(78);
  });

  it("returns 0 when all pct values are 0", () => {
    const reserves = [{ name: "Ghost", pct: 0, risk: "very-low" as const }];
    expect(computeCollateralQualityFromReserves(reserves)).toBe(0);
  });

  it("treats unknown risk values as 0 instead of producing NaN", () => {
    const slices = [
      { name: "Good", pct: 50, risk: "low" as const },
      { name: "Bad", pct: 50, risk: "bogus" as unknown as "low" },
    ];
    const score = computeCollateralQualityFromReserves(slices);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBe(Math.round((50 * 75 + 50 * 0) / 100)); // 38
  });

  it("returns 0 when all risk values are invalid", () => {
    const slices = [
      { name: "A", pct: 60, risk: "invalid" as unknown as "low" },
      { name: "B", pct: 40, risk: "nope" as unknown as "low" },
    ];
    expect(computeCollateralQualityFromReserves(slices)).toBe(0);
  });
});
