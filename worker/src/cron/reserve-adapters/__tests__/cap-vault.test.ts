import { describe, expect, it } from "vitest";
import { adaptCapVaultState } from "../cap-vault";

describe("adaptCapVaultState", () => {
  it("uses total supplied assets for reserve slices and available unpaused balances for redemption capacity", () => {
    const result = adaptCapVaultState({
      contractAddress: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
      supplyUsd: 100,
      assets: [
        {
          address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          name: "USDC",
          risk: "low",
          coinId: "usdc-circle",
          decimals: 6,
          totalSupplied: 70,
          totalBorrowed: 20,
          available: 50,
          paused: false,
        },
        {
          address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
          name: "USDT",
          risk: "low",
          coinId: "usdt-tether",
          decimals: 6,
          totalSupplied: 30,
          totalBorrowed: 0,
          available: 30,
          paused: true,
        },
      ],
    });

    expect(result.slices).toEqual([
      { name: "USDC", pct: 70, risk: "low", coinId: "usdc-circle" },
      { name: "USDT", pct: 30, risk: "low", coinId: "usdt-tether" },
    ]);
    expect(result.metadata).toMatchObject({
      totalReserveUsd: 100,
      supplyUsd: 100,
      immediateRedeemableUsd: 50,
      immediateRedeemableRatio: 0.5,
      redemption: {
        capacityUsd: 50,
        capacityRatioOfSupply: 0.5,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus: "degraded",
      },
    });
    expect(result.warnings?.some((warning) => warning.code === "cap-asset-paused")).toBe(true);
  });

  it("marks the route paused when no unpaused capacity remains", () => {
    const result = adaptCapVaultState({
      contractAddress: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
      supplyUsd: 100,
      assets: [
        {
          address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          name: "USDC",
          risk: "low",
          decimals: 6,
          totalSupplied: 100,
          totalBorrowed: 100,
          available: 0,
          paused: false,
        },
      ],
    });

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 0,
      routeStatus: "paused",
    });
  });
});
