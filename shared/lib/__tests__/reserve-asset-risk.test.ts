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
    expect(getCanonicalReserveAssetRisk("UNKNOWN_XYZ")).toBeNull();
  });

  it("covers governance / DeFi tokens as very-high risk", () => {
    expect(getCanonicalReserveAssetRisk("CRV")).toBe("very-high");
    expect(getCanonicalReserveAssetRisk("GNO")).toBe("very-high");
    expect(getCanonicalReserveAssetRisk("UNI")).toBe("very-high");
  });

  it("covers all stablecoin reserve assets commonly seen in adapters", () => {
    expect(getCanonicalReserveAssetRisk("USDT")).toBe("low");
    expect(getCanonicalReserveAssetRisk("USDS")).toBe("low");
    expect(getCanonicalReserveAssetRisk("FRXUSD")).toBe("low");
    expect(getCanonicalReserveAssetRisk("CBBTC")).toBe("medium");
    expect(getCanonicalReserveAssetRisk("SOLVBTC")).toBe("medium");
    expect(getCanonicalReserveAssetRisk("SOL")).toBe("high");
    expect(getCanonicalReserveAssetRisk("CELO")).toBe("high");
  });
});
