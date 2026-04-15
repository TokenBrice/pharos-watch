import { describe, expect, it } from "vitest";
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

  it("preserves NAV reserve slices and adds current liquidity capacity", () => {
    const result = adaptSuperstateLiquidity(
      navResult,
      {
        USTB: {
          circle_usd_available_amount: "2696887.17",
          usdc_redemption_idle_balance: "3412248.944618",
        },
      },
      "USTB",
    );

    expect(result.slices).toEqual(navResult.slices);
    expect(result.metadata).toMatchObject({
      navPerToken: "10.15",
      freshnessMode: "verified",
      superstateLiquidityTicker: "USTB",
      circleUsdAvailable: 2_696_887.17,
      usdcRedemptionIdle: 3_412_248.944618,
      immediateRedeemableUsd: 6_109_136.114618,
      redemption: {
        capacityUsd: 6_109_136.114618,
        capacityKind: "live-proxy-validated",
        freshnessKind: "same-run-api",
        routeStatus: "open",
        routeStatusSource: "protocol-api",
      },
    });
  });

  it("marks the route paused when current liquidity is zero", () => {
    const result = adaptSuperstateLiquidity(
      navResult,
      {
        USTB: {
          circle_usd_available_amount: "0",
          usdc_redemption_idle_balance: "0",
        },
      },
      "USTB",
    );

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 0,
      routeStatus: "paused",
    });
  });

  it("throws when the requested ticker is absent", () => {
    expect(() => adaptSuperstateLiquidity(navResult, {}, "USTB")).toThrow("missing USTB");
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
      ),
    ).toThrow("invalid circle_usd_available_amount");
  });
});
