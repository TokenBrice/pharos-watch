import { describe, expect, it } from "vitest";
import { adaptJupUsdData } from "../jupusd";

describe("adaptJupUsdData", () => {
  it("groups published JupUSD holdings and emits whitelisted redemption capacity", () => {
    const result = adaptJupUsdData({
      totalSupply: "75000000000000",
      holdings: [
        { name: "USDC", amount: "1000000000000", decimals: 6, type: "program" },
        { name: "USDC", amount: "500000000000", decimals: 6, type: "anchorage" },
        { name: "USDtb", amount: "6000000000000", decimals: 6, type: "anchorage" },
      ],
    }, {
      sourceTimestamp: 1776261612,
      oracle: { ripcord: false },
    });

    expect(result.slices).toEqual([
      { name: "USDtb", pct: 80, risk: "low", coinId: "usdtb-ethena", depType: "collateral" },
      { name: "USDC", pct: 20, risk: "low", coinId: "usdc-circle", depType: "collateral" },
    ]);
    expect(result.metadata).toMatchObject({
      totalReserveUsd: 7_500_000,
      supplyUsd: 75_000_000,
      unknownExposurePct: 0,
      immediateRedeemableUsd: 7_500_000,
      immediateRedeemableRatio: 0.1,
      freshnessMode: "verified",
      sourceTimestamp: 1776261612,
      redemption: {
        capacityUsd: 7_500_000,
        capacityRatioOfSupply: 0.1,
        capacityKind: "live-direct-bounded",
        freshnessKind: "verified-source-timestamp",
        routeStatus: "open",
        holderEligibility: "whitelisted-primary",
      },
    });
  });

  it("marks route paused when the oracle reports ripcord mode", () => {
    const result = adaptJupUsdData({
      totalSupply: "1000000",
      holdings: [{ name: "USDC", amount: "1000000", decimals: 6 }],
    }, {
      oracle: { ripcord: true, ripcordDetails: "manual stop" },
    });

    expect(result.metadata?.redemption).toMatchObject({
      routeStatus: "paused",
      routeStatusReason: "manual stop",
    });
  });

  it("keeps unknown holdings explicit instead of defaulting them to medium risk", () => {
    const result = adaptJupUsdData({
      holdings: [
        { name: "USDC", amount: "99000000", decimals: 6 },
        { name: "MYSTERY", amount: "1000000", decimals: 6 },
      ],
    });

    expect(result.slices).toEqual([
      { name: "USDC", pct: 99, risk: "low", coinId: "usdc-circle", depType: "collateral" },
      { name: "Unmapped JupUSD reserve holdings", pct: 1, risk: "high" },
    ]);
    expect(result.warnings?.[0]).toMatchObject({
      code: "unknown-holding",
      effect: "info",
    });
    expect(result.metadata).toMatchObject({
      unknownExposurePct: 1,
      unknownHoldingNames: ["MYSTERY"],
    });
  });

  it("degrades material unknown holdings", () => {
    const result = adaptJupUsdData({
      holdings: [
        { name: "USDC", amount: "90000000", decimals: 6 },
        { name: "MYSTERY", amount: "10000000", decimals: 6 },
      ],
    });

    expect(result.warnings?.[0]).toMatchObject({
      code: "unknown-holding",
      effect: "degraded",
    });
    expect(result.metadata?.unknownExposurePct).toBe(10);
  });
});
