import { describe, expect, it } from "vitest";
import { getLiteralMintingPressureScore, getNetFlowDirection24h, getPressureShiftState } from "../mint-burn-signals";

describe("mint-burn-signals", () => {
  it("classifies 24h net flow direction", () => {
    expect(getNetFlowDirection24h({ netFlow24hUsd: 200_000, has24hActivity: true })).toBe("minting");
    expect(getNetFlowDirection24h({ netFlow24hUsd: -200_000, has24hActivity: true })).toBe("burning");
    expect(getNetFlowDirection24h({ netFlow24hUsd: 0, has24hActivity: true })).toBe("flat");
    expect(
      getNetFlowDirection24h({
        netFlow24hUsd: 0,
        has24hActivity: false,
      }),
    ).toBe("inactive");
  });

  it("returns nr pressure state for null scores", () => {
    expect(getPressureShiftState(null)).toBe("nr");
  });

  it("pins pressure-shift state boundaries", () => {
    expect(getPressureShiftState(-10.01)).toBe("worsening");
    expect(getPressureShiftState(-10)).toBe("stable");
    expect(getPressureShiftState(10)).toBe("stable");
    expect(getPressureShiftState(10.01)).toBe("improving");
  });

  it("computes literal minting pressure from raw 24h mint vs burn balance", () => {
    expect(
      getLiteralMintingPressureScore({
        mintVolume24hUsd: 105,
        burnVolume24hUsd: 95,
      }),
    ).toBeCloseTo(5, 6);
    expect(
      getLiteralMintingPressureScore({
        mintVolume24hUsd: 0,
        burnVolume24hUsd: 100,
      }),
    ).toBe(-100);
  });

  it("returns null literal minting pressure when there is no 24h activity", () => {
    expect(
      getLiteralMintingPressureScore({
        mintVolume24hUsd: 0,
        burnVolume24hUsd: 0,
      }),
    ).toBeNull();
  });

  it("gives inactivity precedence over nonzero flow", () => {
    expect(getNetFlowDirection24h({ netFlow24hUsd: 200_000, has24hActivity: false })).toBe("inactive");
    expect(getNetFlowDirection24h({ netFlow24hUsd: -200_000, has24hActivity: false })).toBe("inactive");
  });

  it("distinguishes balanced activity from mint-only activity", () => {
    expect(getLiteralMintingPressureScore({ mintVolume24hUsd: 100, burnVolume24hUsd: 100 })).toBe(0);
    expect(getLiteralMintingPressureScore({ mintVolume24hUsd: 100, burnVolume24hUsd: 0 })).toBe(100);
  });
});
