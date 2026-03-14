import { describe, it, expect } from "vitest";
import { adaptOusdCollateral, type OusdCollateralResponse } from "../ousd";

const SAMPLE_RESPONSE: OusdCollateralResponse = {
  collateral: {
    DAI: { total: 1_500_000, price: 1.0 },
    USDC: { total: 3_200_000, price: 1.0 },
    USDT: { total: 2_800_000, price: 1.0 },
  },
};

describe("adaptOusdCollateral", () => {
  it("produces slices from collateral response", () => {
    const result = adaptOusdCollateral(SAMPLE_RESPONSE);
    expect(result.slices.length).toBeGreaterThanOrEqual(1);
    const total = result.slices.reduce((sum, s) => sum + s.pct, 0);
    expect(total).toBe(100);
  });

  it("maps known stablecoins to coinIds", () => {
    const result = adaptOusdCollateral(SAMPLE_RESPONSE);
    const usdc = result.slices.find((s) => s.name.includes("USDC"));
    expect(usdc?.coinId).toBe("usdc-circle");
  });

  it("assigns risk based on canonical risk map", () => {
    const result = adaptOusdCollateral(SAMPLE_RESPONSE);
    for (const slice of result.slices) {
      expect(["very-low", "low", "medium", "high", "very-high"]).toContain(slice.risk);
    }
  });

  it("handles empty collateral", () => {
    const empty: OusdCollateralResponse = { collateral: {} };
    const result = adaptOusdCollateral(empty);
    expect(result.slices).toHaveLength(0);
  });
});
