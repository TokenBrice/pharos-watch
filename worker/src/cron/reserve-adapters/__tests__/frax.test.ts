import { describe, it, expect } from "vitest";
import type { StablecoinMeta } from "@shared/types";
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

function makeCoin(reserves?: StablecoinMeta["reserves"]): StablecoinMeta {
  return { id: "frxusd-frax", name: "frxUSD", ticker: "frxUSD", reserves } as unknown as StablecoinMeta;
}

describe("adaptFraxCombinedData", () => {
  it("returns single fallback slice when coin is omitted", () => {
    const result = adaptFraxCombinedData(SAMPLE);
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].pct).toBe(100);
    expect(result.slices[0].name).toContain("T-bills");
  });

  it("returns single fallback slice when coin.reserves is empty", () => {
    const result = adaptFraxCombinedData(SAMPLE, makeCoin([]));
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].pct).toBe(100);
  });

  it("returns curated reserves when coin has them", () => {
    const coin = makeCoin([
      { name: "BUIDL", pct: 55, risk: "low", coinId: "buidl-blackrock" },
      { name: "USTB", pct: 20, risk: "low" },
      { name: "USDC", pct: 10, risk: "low", coinId: "usdc-circle" },
      { name: "USCC", pct: 5, risk: "medium" },
      { name: "Other", pct: 10, risk: "low" },
    ]);
    const result = adaptFraxCombinedData(SAMPLE, coin);
    expect(result.slices).toHaveLength(5);
    expect(result.slices[0].name).toBe("BUIDL");
    expect(result.slices[0].coinId).toBe("buidl-blackrock");
  });

  it("includes collateralization metadata", () => {
    const result = adaptFraxCombinedData(SAMPLE);
    expect(result.metadata?.collateralRatio).toBe(0.945);
    expect(result.metadata?.totalCollateralUsd).toBe(518_626_905);
  });
});
