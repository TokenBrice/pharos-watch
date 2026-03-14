import { describe, it, expect } from "vitest";
import { adaptTetherTransparency, type TetherTransparencyResponse } from "../tether";

const SAMPLE: TetherTransparencyResponse = {
  data: {
    usdt: {
      total_assets: 145_000_000_000,
      total_liabilities: 144_500_000_000,
      shareholder_eq: 500_000_000,
    },
  },
};

describe("adaptTetherTransparency", () => {
  it("returns a single attestation slice", () => {
    const result = adaptTetherTransparency(SAMPLE);
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].pct).toBe(100);
    expect(result.slices[0].risk).toBe("very-low");
  });

  it("includes collateralization metadata", () => {
    const result = adaptTetherTransparency(SAMPLE);
    expect(result.metadata?.totalAssetsUsd).toBe(145_000_000_000);
    expect(result.metadata?.totalLiabilitiesUsd).toBe(144_500_000_000);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.00346, 4);
  });

  it("throws on missing usdt data", () => {
    expect(() => adaptTetherTransparency({ data: {} } as TetherTransparencyResponse)).toThrow();
  });
});
