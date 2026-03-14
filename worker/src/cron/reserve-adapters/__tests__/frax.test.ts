import { describe, it, expect } from "vitest";
import { adaptFraxCombinedData, type FraxCombinedDataResponse } from "../frax";

const SAMPLE: FraxCombinedDataResponse = {
  protocol: {
    collateral: {
      ratio: 0.945,
      decentralization_ratio: 0.14,
      total_dollar_value: 518_626_905,
    },
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
    expect(result.metadata?.collateralRatio).toBe(0.945);
    expect(result.metadata?.totalCollateralUsd).toBe(518_626_905);
  });
});
