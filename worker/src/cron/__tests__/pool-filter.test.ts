import { describe, expect, it } from "vitest";
import { isYieldRelevantDlPool } from "../yield-sync/pool-filter";

describe("isYieldRelevantDlPool", () => {
  it("retains stablecoin single-exposure pools", () => {
    expect(
      isYieldRelevantDlPool({
        pool: "pool-usdc",
        symbol: "USDC",
        stablecoin: true,
        exposure: "single",
      }),
    ).toBe(true);
  });

  it("retains configured wrapper pools even when DeFiLlama marks them non-stablecoin", () => {
    expect(
      isYieldRelevantDlPool({
        pool: "ee0b7069-f8f3-4aa2-a415-728f13e6cc3d",
        symbol: "fxSAVE",
        stablecoin: false,
        exposure: "single",
      }),
    ).toBe(true);
  });

  it("filters unrelated non-stablecoin pools", () => {
    expect(
      isYieldRelevantDlPool({
        pool: "random-wrapper",
        symbol: "sETH",
        stablecoin: false,
        exposure: "single",
      }),
    ).toBe(false);
  });

  it("filters multi-exposure pools even if stablecoin", () => {
    expect(
      isYieldRelevantDlPool({
        pool: "lp-usdc-usdt",
        symbol: "USDC-USDT",
        stablecoin: true,
        exposure: "multi",
      }),
    ).toBe(false);
  });
});
