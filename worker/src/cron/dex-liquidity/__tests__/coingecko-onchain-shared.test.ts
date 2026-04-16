import { describe, expect, it } from "vitest";
import { classifyCgPool } from "../coingecko-onchain-shared";

describe("classifyCgPool balanceRatio", () => {
  it("returns null balanceRatio for a stable-stable pair with fee data", () => {
    const result = classifyCgPool(
      { dexId: "uniswap-v3" },
      { pool_fee_percentage: "0.01", locked_liquidity_percentage: null },
    );

    expect(result.balanceRatio).toBeNull();
  });

  it("returns null balanceRatio for a stable-volatile pair without fee data", () => {
    const result = classifyCgPool(
      { dexId: "pancakeswap-v2" },
      { pool_fee_percentage: null, locked_liquidity_percentage: null },
    );

    expect(result.balanceRatio).toBeNull();
  });
});
