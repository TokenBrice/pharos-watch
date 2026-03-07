import { describe, expect, it } from "vitest";
import {
  getCoinFlowCompositeState,
  getLiteralMintingPressureScore,
  getNetFlowDirection24h,
  getPressureShiftState,
} from "../mint-burn-signals";

describe("mint-burn-signals", () => {
  it("classifies burning plus improving correctly", () => {
    expect(
      getCoinFlowCompositeState({
        netFlow24hUsd: -200_000,
        has24hActivity: true,
        pressureShiftScore: 30,
      }),
    ).toBe("burning-improving");
  });

  it("classifies burning plus worsening correctly", () => {
    expect(
      getCoinFlowCompositeState({
        netFlow24hUsd: -200_000,
        has24hActivity: true,
        pressureShiftScore: -30,
      }),
    ).toBe("burning-worsening");
  });

  it("classifies minting plus improving correctly", () => {
    expect(
      getCoinFlowCompositeState({
        netFlow24hUsd: 200_000,
        has24hActivity: true,
        pressureShiftScore: 30,
      }),
    ).toBe("minting-improving");
  });

  it("classifies minting plus worsening correctly", () => {
    expect(
      getCoinFlowCompositeState({
        netFlow24hUsd: 200_000,
        has24hActivity: true,
        pressureShiftScore: -30,
      }),
    ).toBe("minting-worsening");
  });

  it("classifies flat activity separately from inactive windows", () => {
    expect(
      getNetFlowDirection24h({ netFlow24hUsd: 0, has24hActivity: true }),
    ).toBe("flat");
    expect(
      getCoinFlowCompositeState({
        netFlow24hUsd: 0,
        has24hActivity: true,
        pressureShiftScore: 0,
      }),
    ).toBe("flat-stable");
  });

  it("classifies no-activity windows as inactive", () => {
    expect(
      getCoinFlowCompositeState({
        netFlow24hUsd: 0,
        has24hActivity: false,
        pressureShiftScore: 40,
      }),
    ).toBe("inactive");
  });

  it("returns nr pressure state for null scores", () => {
    expect(getPressureShiftState(null)).toBe("nr");
    expect(
      getCoinFlowCompositeState({
        netFlow24hUsd: -100,
        has24hActivity: true,
        pressureShiftScore: null,
      }),
    ).toBe("burning-nr");
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
});
