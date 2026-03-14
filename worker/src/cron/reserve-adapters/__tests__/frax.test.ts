import { describe, it, expect } from "vitest";
import { adaptFraxCombinedData, type FraxCombinedDataResponse } from "../frax";

const SAMPLE: FraxCombinedDataResponse = {
  collateral: {
    collateral_ratio: 1.05,
    decentralization_ratio: 0.85,
    total_dollar_value_of_collateral: 800_000_000,
  },
};

describe("adaptFraxCombinedData", () => {
  it("returns single attestation slice", () => {
    const result = adaptFraxCombinedData(SAMPLE);
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].pct).toBe(100);
  });

  it("includes collateralization metadata", () => {
    const result = adaptFraxCombinedData(SAMPLE);
    expect(result.metadata?.collateralRatio).toBe(1.05);
    expect(result.metadata?.totalCollateralUsd).toBe(800_000_000);
  });
});
