import { describe, expect, it } from "vitest";
import { adaptThreeJaneUsd3Snapshot } from "../3jane-usd3";
import { expectValidAdapterOutput } from "./reserve-adapter.test-support";

const ONE = 1_000_000n;

describe("adaptThreeJaneUsd3Snapshot", () => {
  it("separates liquid waUSDC from deployed credit and emits direct redemption capacity", () => {
    const result = adaptThreeJaneUsd3Snapshot({
      contractAddress: "0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc",
      navRaw: 100n * ONE,
      totalAssetsRaw: 100n * ONE,
      totalSupplyRaw: 80n * ONE,
      idleUsdcRaw: 15n * ONE,
      localWaUsdcRaw: 5n * ONE,
      suppliedWaUsdcRaw: 80n * ONE,
      marketTotalSupplyAssetsRaw: 100n * ONE,
      marketTotalSharesRaw: 100n * ONE,
      marketTotalBorrowAssetsRaw: 75n * ONE,
      marketLiquidityRaw: 25n * ONE,
      marketLiquidPositionRaw: 20n * ONE,
      creditPositionRaw: 60n * ONE,
      liquidPositionAssetsRaw: 25n * ONE,
      creditPositionAssetsRaw: 60n * ONE,
      availableWithdrawRaw: 40n * ONE,
      minCommitmentTimeRaw: 0n,
      isShutdown: false,
    });

    expect(result.slices).toEqual([
      { name: "Fintech and crypto credit receivables", pct: 60, risk: "high" },
      {
        name: "Aave USDC liquidity buffer",
        pct: 40,
        risk: "medium",
        coinId: "usdc-circle",
        depType: "collateral",
        blacklistable: true,
      },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      supplyUsd: 100,
      totalReserveUsd: 100,
      totalAssetsUsd: 100,
      collateralizationRatio: 1,
      immediateRedeemableUsd: 40,
      immediateRedeemableRatio: 0.4,
      redemptionFeeBps: 0,
      redemption: {
        capacityUsd: 40,
        capacityRatioOfSupply: 0.4,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        feeBps: 0,
      },
      details: {
        proofKind: "3jane-usd3-onchain-accounting",
        marketLiquidPositionRaw: (20n * ONE).toString(),
        creditPositionRaw: (60n * ONE).toString(),
      },
    });
    expectValidAdapterOutput("3jane-usd3", result);
  });

  it("surfaces shutdown state and keeps bounded recoverable liquidity degraded", () => {
    const result = adaptThreeJaneUsd3Snapshot({
      contractAddress: "0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc",
      navRaw: 100n * ONE,
      totalAssetsRaw: 100n * ONE,
      totalSupplyRaw: 100n * ONE,
      idleUsdcRaw: 20n * ONE,
      localWaUsdcRaw: 0n,
      suppliedWaUsdcRaw: 80n * ONE,
      marketTotalSupplyAssetsRaw: 100n * ONE,
      marketTotalSharesRaw: 100n * ONE,
      marketTotalBorrowAssetsRaw: 75n * ONE,
      marketLiquidityRaw: 25n * ONE,
      marketLiquidPositionRaw: 20n * ONE,
      creditPositionRaw: 60n * ONE,
      liquidPositionAssetsRaw: 20n * ONE,
      creditPositionAssetsRaw: 60n * ONE,
      availableWithdrawRaw: 40n * ONE,
      minCommitmentTimeRaw: 0n,
      isShutdown: true,
    });

    expect(result.metadata?.redemption).toMatchObject({ routeStatus: "degraded", capacityUsd: 40 });
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "3jane-usd3-shutdown" }));
  });
});
