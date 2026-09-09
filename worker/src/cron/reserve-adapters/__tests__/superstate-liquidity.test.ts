import { describe, expect, it } from "vitest";
import { installAdapterNetwork, expectValidAdapterOutput, runAdapter } from "./reserve-adapter.test-support";

import { adaptSuperstateLiquidity } from "../superstate-liquidity";



describe("adaptSuperstateLiquidity", () => {
  const navResult = {
    slices: [{ name: "Short-duration U.S. government securities", pct: 100, risk: "very-low" as const }],
    metadata: {
      navPerToken: "10.15",
      totalSupplyFormatted: "1000000",
      sourceTimestamp: 1_776_000_000,
      freshnessMode: "verified" as const,
    },
  };

  it("preserves NAV reserve slices and emits the on-chain RedemptionIdle balance as direct capacity", () => {
    const result = adaptSuperstateLiquidity(
      navResult,
      {
        USTB: {
          circle_usd_available_amount: "2696887.17",
          usdc_redemption_idle_balance: "3412248.944618",
        },
      },
      "USTB",
      9_310_000,
    );

    expect(result.slices).toEqual(navResult.slices);
    expect(result.metadata).toMatchObject({
      navPerToken: "10.15",
      freshnessMode: "verified",
      superstateLiquidityTicker: "USTB",
      circleUsdAvailable: 2_696_887.17,
      usdcRedemptionIdle: 3_412_248.944618,
      apiLiquidityUsd: 6_109_136.114618,
      redemption: {
        capacityUsd: 9_310_000,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
      },
      liquidityFreshnessSource: "same-run-onchain",
      details: {
        apiLiquidityUsd: 6_109_136.114618,
        liquidityFreshnessSource: "same-run-onchain",
      },
    });
    expect(result.metadata?.sourceTimestamp).toBe(1_776_000_000);
    expect(result.metadata?.redemption?.sourceTimestamp).toBeUndefined();

    expectValidAdapterOutput("superstate-liquidity", result);
  });

  it("marks the route paused when the on-chain RedemptionIdle balance is zero", () => {
    const result = adaptSuperstateLiquidity(
      navResult,
      {
        USTB: {
          circle_usd_available_amount: "0",
          usdc_redemption_idle_balance: "0",
        },
      },
      "USTB",
      0,
    );

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 0,
      routeStatus: "paused",
    });
  });

  it("throws when the requested ticker is absent", () => {
    expect(() => adaptSuperstateLiquidity(navResult, {}, "USTB", 9_310_000)).toThrow("missing USTB");
  });

  it("throws on malformed liquidity amounts", () => {
    expect(() =>
      adaptSuperstateLiquidity(
        navResult,
        {
          USTB: {
            circle_usd_available_amount: "not-a-number",
            usdc_redemption_idle_balance: "0",
          },
        },
        "USTB",
        9_310_000,
      ),
    ).toThrow("invalid circle_usd_available_amount");
  });
});

describe("fetchSuperstateLiquidityReserves", () => {
  const liquidityUrl = "https://api.superstate.com/v1/funds/liquidity";
  const oracle = "0x289B5036cd942e619E1Ee48670F98d214E745AAC";
  const token = "0x43415eB6ff9DB7E26A15b704e7A3eDCe97d31C4e";
  const usdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const latestRoundData = `0x${[
    1n,
    1_015_000_000n,
    1_757_000_000n,
    1_757_000_000n,
    1n,
  ].map((word) => word.toString(16).padStart(64, "0")).join("")}`;

  function network(payload: unknown) {
    return installAdapterNetwork({
      json: {
        [liquidityUrl]: payload,
      },
      rpc: {
        [`${token}:decimals()`]: 18n,
        [`${token}:totalSupply()`]: 1_000_000n * 10n ** 18n,
        [`${oracle}:decimals()`]: 8n,
        [`${oracle}:latestRoundData()`]: latestRoundData,
        [`${usdc}:balanceOf(address)`]: 9_310_000_000000n,
      },
      block: { number: 23_000_000, timestamp: 1_757_000_000 },
    });
  }

  it("reads the liquidity API and on-chain RedemptionIdle balance through the shared harness", async () => {
    const { result, network: installed } = await runAdapter("superstate-liquidity", "ustb-superstate", {
      network: network({
        USTB: {
          circle_usd_available_amount: "2696887.17",
          usdc_redemption_idle_balance: "3412248.944618",
        },
      }),
      nowSec: 1_757_000_100,
    });

    expect(result.metadata).toMatchObject({
      redemption: {
        capacityUsd: 9_310_000,
        capacityKind: "live-direct-bounded",
      },
    });
    expect(installed.requests).toContainEqual({ url: liquidityUrl, method: "GET" });
    expectValidAdapterOutput("superstate-liquidity", result);
  });

  it("fails closed when the liquidity payload renames a required field", async () => {
    await expect(runAdapter("superstate-liquidity", "ustb-superstate", {
      network: network({
        USTB: {
          usdc_redemption_idle_balance: "3412248.944618",
        },
      }),
      nowSec: 1_757_000_100,
      validate: false,
    })).rejects.toThrow("circle_usd_available_amount");
  });
});
