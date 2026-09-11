import { describe, expect, it } from "vitest";
import { adaptThreeJaneUsd3Snapshot } from "../3jane-usd3";
import { expectValidAdapterOutput, installAdapterNetwork, runAdapter, type AdapterRpcValue } from "./reserve-adapter.test-support";

const ONE = 1_000_000n;

function abiWord(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function usd3Network(dropSelector?: string) {
  const rpc: Record<string, AdapterRpcValue> = {
    "0xc1590cd7": 100n * ONE,
    "0x01e1d114": 100n * ONE,
    "0x18160ddd": 80n * ONE,
    "0x4251c354": 5n * ONE,
    "0xa9b89c07": 80n * ONE,
    "0x59ddbab2": `0x${[100n, 100n, 75n, 25n].map((value) => abiWord(value * ONE)).join("")}`,
    "0x04bd4629": 40n * ONE,
    "0x0517bbab": 0n,
    "0xbf86d690": false,
    "balanceOf(address)": 15n * ONE,
    "0x07a2d13a": (call) => call.data.endsWith(abiWord(25n * ONE)) ? 25n * ONE : 60n * ONE,
  };
  if (dropSelector) delete rpc[dropSelector];
  return installAdapterNetwork({ rpc });
}

describe("3jane-usd3 adapter", () => {
  it("fetches the catalog-bound USD3 accounting through the harness", async () => {
    const { result, network } = await runAdapter("3jane-usd3", "usd3-3jane", {
      network: usd3Network(),
      nowSec: 1_757_003_600,
    });

    expect(result.metadata).toMatchObject({
      details: { proofKind: "3jane-usd3-onchain-accounting" },
      totalReserveUsd: 100,
      totalAssetsUsd: 100,
      collateralizationRatio: 1,
      redemption: { capacityUsd: 40, routeStatus: "open" },
    });
    expect(network.rpcCalls.some((call) => call.selector === "0x59ddbab2" && call.viaMulticall)).toBe(true);
  });

  it("fails closed when the nav() read is dropped from the upstream batch", async () => {
    await expect(runAdapter("3jane-usd3", "usd3-3jane", {
      network: usd3Network("0xc1590cd7"),
      nowSec: 1_757_003_600,
    })).rejects.toThrow(/nav|unanswered/i);
  });
});


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
      { sourceKey: "3jane-usd3:credit-receivables", name: "Fintech and crypto credit receivables", pct: 60, risk: "high" },
      {
        sourceKey: "3jane-usd3:usdc",
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
