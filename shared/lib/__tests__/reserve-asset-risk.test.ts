import { describe, expect, it } from "vitest";
import {
  CANONICAL_ETH_RESERVE_RISK,
  CANONICAL_WETH_RESERVE_RISK,
  getCanonicalReserveAssetRisk,
} from "../reserve-asset-risk";

describe("canonical reserve asset risk mapping", () => {
  it("treats WETH as ETH for direct reserve risk", () => {
    expect(CANONICAL_ETH_RESERVE_RISK).toBe("very-low");
    expect(CANONICAL_WETH_RESERVE_RISK).toBe(CANONICAL_ETH_RESERVE_RISK);
    expect(getCanonicalReserveAssetRisk("ETH")).toBe("very-low");
    expect(getCanonicalReserveAssetRisk("WETH")).toBe("very-low");
  });

  it("keeps ETH liquid staking tokens below ETH but above wrapped BTC", () => {
    expect(getCanonicalReserveAssetRisk("wstETH")).toBe("low");
    expect(getCanonicalReserveAssetRisk("rETH")).toBe("low");
    expect(getCanonicalReserveAssetRisk("WBTC")).toBe("medium");
  });

  it("returns null for symbols outside the canonical direct-asset map", () => {
    expect(getCanonicalReserveAssetRisk("CRV")).toBeNull();
  });
});
