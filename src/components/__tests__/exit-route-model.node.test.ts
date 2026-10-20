import { describe, expect, it } from "vitest";
import { buildLiquidityExitRouteModel } from "@/components/exit-route-model";
import { makeDexLiquidityData } from "@/test/fixtures/dex-liquidity";
import { DEX_GLOBAL_KEY } from "@shared/types/market";

describe("buildLiquidityExitRouteModel", () => {
  it.each([NaN, Infinity, -Infinity, -0.01, 1.01])("leaves invalid HHI %s unscored in the model interpretation", (concentrationHhi) => {
    const model = buildLiquidityExitRouteModel({
      [DEX_GLOBAL_KEY]: makeDexLiquidityData({ totalTvlUsd: 10_000, concentrationHhi }),
    });
    expect(model?.interpretation).toBe("Route concentration is not scored for this snapshot.");
  });

  it("derives exit routes from the global DEX liquidity row", () => {
    const model = buildLiquidityExitRouteModel({
      [DEX_GLOBAL_KEY]: makeDexLiquidityData({
        totalTvlUsd: 10_000,
        totalVolume24hUsd: 2_500,
        protocolTvl: {
          curve: 5_000,
          fluid: 3_000,
          balancer: 2_000,
        },
        chainTvl: {
          ethereum: 6_000,
          arbitrum: 2_500,
          base: 1_500,
        },
        poolCount: 42,
        concentrationHhi: 0.24,
        weightedBalanceRatio: 0.72,
        organicFraction: 0.63,
      }),
    });

    expect(model).toMatchObject({
      totalTvlUsd: 10_000,
      totalVolume24hUsd: 2_500,
      protocolCount: 3,
      chainCount: 3,
      poolCount: 42,
      concentrationHhi: 0.24,
      weightedBalancePct: 72,
      organicPct: 63,
      interpretation: "Exit depth is usable, but route concentration is visible.",
    });
    expect(model?.topProtocol).toMatchObject({
      key: "curve",
      sharePct: 50,
      rank: 1,
    });
    expect(model?.topChain).toMatchObject({
      key: "ethereum",
      sharePct: 60,
      rank: 1,
    });
  });

  it("uses total DEX TVL as the route-share denominator when bucket totals drift", () => {
    const model = buildLiquidityExitRouteModel(
      {
        [DEX_GLOBAL_KEY]: makeDexLiquidityData({
          totalTvlUsd: 10_000,
          totalVolume24hUsd: 2_500,
          protocolTvl: {
            curve: 5_000,
            fluid: 3_000,
          },
          chainTvl: {
            ethereum: 4_000,
            base: 1_000,
          },
          poolCount: 42,
          concentrationHhi: null,
          weightedBalanceRatio: null,
          organicFraction: null,
        }),
      },
      { avgBalance: 71, avgOrganic: 54 },
    );

    expect(model?.topProtocol).toMatchObject({ key: "curve", sharePct: 50 });
    expect(model?.topChain).toMatchObject({ key: "ethereum", sharePct: 40 });
    expect(model).toMatchObject({
      weightedBalancePct: 71,
      organicPct: 54,
    });
  });

  it("aggregates non-top exit routes into a visible other bucket", () => {
    const model = buildLiquidityExitRouteModel({
      [DEX_GLOBAL_KEY]: makeDexLiquidityData({
        totalTvlUsd: 10_000,
        totalVolume24hUsd: 2_500,
        protocolTvl: {
          curve: 3_000,
          fluid: 2_000,
          balancer: 1_500,
          orca: 1_000,
          raydium: 900,
          aerodrome: 700,
          quickswap: 400,
        },
        chainTvl: {
          ethereum: 6_000,
          base: 2_000,
          arbitrum: 1_000,
        },
        poolCount: 42,
      }),
    });

    expect(model?.protocolRoutes.map((route) => route.key)).toEqual([
      "curve",
      "fluid",
      "balancer",
      "orca",
      "raydium",
      "_other-routes",
    ]);
    expect(model?.protocolRoutes.at(-1)).toMatchObject({
      label: "Other routes",
      valueUsd: 1_100,
      sharePct: 11,
      isOther: true,
    });
    // The ledger names the tail the map folds into "Other routes".
    expect(model?.protocolTail).toEqual([
      { key: "aerodrome", label: "Aerodrome", valueUsd: 700 },
      { key: "quickswap", label: "QuickSwap", valueUsd: 400 },
    ]);
    expect(model?.chainTail).toEqual([]);
  });

  it("carries the chain registry's dark-invert flag onto lane logos", () => {
    const model = buildLiquidityExitRouteModel({
      [DEX_GLOBAL_KEY]: makeDexLiquidityData({
        totalTvlUsd: 10_000,
        protocolTvl: { curve: 10_000 },
        chainTvl: { robinhood: 6_000, ethereum: 4_000 },
      }),
    });
    expect(model?.chainRoutes.find((route) => route.key === "robinhood")?.logoDarkInvert).toBe(true);
    expect(model?.chainRoutes.find((route) => route.key === "ethereum")?.logoDarkInvert).toBeFalsy();
  });

  it("does not build an exit map without global TVL", () => {
    expect(buildLiquidityExitRouteModel({})).toBeNull();
    expect(
      buildLiquidityExitRouteModel({
        [DEX_GLOBAL_KEY]: makeDexLiquidityData({ totalTvlUsd: 0 }),
      }),
    ).toBeNull();
    expect(
      buildLiquidityExitRouteModel({
        [DEX_GLOBAL_KEY]: makeDexLiquidityData({ totalTvlUsd: 10_000, unavailableReason: "invalid-coverage-evidence" }),
      }),
    ).toBeNull();
  });

});
