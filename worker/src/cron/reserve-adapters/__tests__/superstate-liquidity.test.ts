import { describe, expect, it } from "vitest";
import { expectValidAdapterOutput } from "./reserve-adapter.test-support";

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
        routeStatus: "unknown",
        routeStatusSource: "static-config",
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

  it("keeps the route unknown when the on-chain RedemptionIdle balance is zero", () => {
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
      routeStatus: "unknown",
    });
  });

  it("keeps NAV slices and on-chain capacity when the ticker is absent from the optional liquidity body", () => {
    const result = adaptSuperstateLiquidity(navResult, {}, "USTB", 9_310_000);

    expect(result.slices).toEqual(navResult.slices);
    expect(result.metadata).toMatchObject({
      superstateLiquidityTicker: "USTB",
      redemption: { capacityUsd: 9_310_000 },
    });
    expect(result.metadata).not.toHaveProperty("apiLiquidityUsd");
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "superstate-liquidity-unavailable", effect: "info" }),
    ]);
  });

  it("keeps NAV slices and on-chain capacity when liquidity amounts are malformed", () => {
    const result = adaptSuperstateLiquidity(
      navResult,
      {
        USTB: {
          circle_usd_available_amount: "not-a-number",
          usdc_redemption_idle_balance: "0",
        },
      },
      "USTB",
      9_310_000,
    );

    expect(result.slices).toEqual(navResult.slices);
    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 9_310_000 });
    expect(result.metadata).not.toHaveProperty("circleUsdAvailable");
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "superstate-liquidity-unavailable", effect: "info" }),
    ]);
  });

  it("keeps NAV slices and on-chain capacity when the optional liquidity body is unavailable", () => {
    const result = adaptSuperstateLiquidity(navResult, null, "USTB", 9_310_000);

    expect(result.slices).toEqual(navResult.slices);
    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 9_310_000,
      capacityKind: "live-direct-bounded",
    });
    expect(result.metadata).not.toHaveProperty("apiLiquidityUsd");
    expect(result.warnings ?? []).toEqual([]);
  });
});
