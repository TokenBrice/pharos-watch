import { describe, expect, it } from "vitest";
import { adaptEthenaCollateral, listUnexpectedEthenaAssets, type EthenaCollateralResponse } from "../ethena";

describe("adaptEthenaCollateral", () => {
  it("groups Ethena collateral into reserve buckets", () => {
    const payload: EthenaCollateralResponse = {
      totalBackingAssetsInUsd: 100,
      collateral: [
        { asset: "Liquid Cash", exchange: "Binance", timestamp: 1, usdAmount: 35 },
        { asset: "BTC", exchange: "Binance", timestamp: 1, usdAmount: 20 },
        { asset: "ETH", exchange: "Binance", timestamp: 1, usdAmount: 15 },
        { asset: "WBETH", exchange: "Binance", timestamp: 1, usdAmount: 15 },
        { asset: "SOL", exchange: "Binance", timestamp: 1, usdAmount: 15 },
      ],
    };

    const result = adaptEthenaCollateral(payload);

    expect(result.slices).toEqual([
      { name: "Liquid stables / cash equivalents", pct: 35, risk: "low" },
      { name: "ETH / liquid staking collateral", pct: 30, risk: "medium" },
      { name: "BTC collateral", pct: 20, risk: "medium" },
      { name: "Other crypto collateral", pct: 15, risk: "high" },
    ]);
    expect(result.metadata).toMatchObject({
      assetCount: 5,
      totalBackingAssetsInUsd: 100,
      immediateRedeemableUsd: 35,
      immediateRedeemableRatio: 0.35,
      lastUpdatedAt: 1,
      sourceTimestamp: 1,
      freshnessMode: "verified",
    });
  });

  it("does not warn for known alt-collateral already bucketed into other", () => {
    const payload: EthenaCollateralResponse = {
      totalBackingAssetsInUsd: 100,
      collateral: [
        { asset: "Liquid Cash", exchange: "Binance", timestamp: 1, usdAmount: 80 },
        { asset: "SOL", exchange: "Binance", timestamp: 1, usdAmount: 5 },
        { asset: "XRP", exchange: "Binance", timestamp: 1, usdAmount: 5 },
        { asset: "BNB", exchange: "Binance", timestamp: 1, usdAmount: 5 },
        { asset: "HYPE", exchange: "Binance", timestamp: 1, usdAmount: 5 },
      ],
    };

    expect(listUnexpectedEthenaAssets(payload)).toEqual([]);
  });

  it("still surfaces genuinely new Ethena assets", () => {
    const payload: EthenaCollateralResponse = {
      totalBackingAssetsInUsd: 100,
      collateral: [
        { asset: "Liquid Cash", exchange: "Binance", timestamp: 1, usdAmount: 95 },
        { asset: "DOGE", exchange: "Binance", timestamp: 1, usdAmount: 5 },
      ],
    };

    expect(listUnexpectedEthenaAssets(payload)).toEqual(["DOGE"]);
  });
});
