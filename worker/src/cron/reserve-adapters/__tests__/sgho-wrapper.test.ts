import { describe, expect, it } from "vitest";
import { runAdapter } from "./reserve-adapter.test-support";

const SUPPLY = 1000n * 10n ** 18n;
const PREVIEW_REDEEM = 1005n * 10n ** 18n;

function sghoNetwork(previewRedeem: bigint | null) {
  return {
    rpc: {
      "totalSupply()": SUPPLY,
      // previewRedeem(uint256) carries the supply as its argument, so the
      // selector-keyed answer covers every argument the adapter can send.
      "0x4cdad506": previewRedeem,
    },
  };
}

describe("sgho-wrapper adapter", () => {
  it("rejects an absent configured chain", async () => {
    await expect(
      runAdapter("sgho-wrapper", "sgho-aave", { coin: { contracts: [] }, network: sghoNetwork(PREVIEW_REDEEM) }),
    ).rejects.toThrow(/No ethereum contract/);
  });

  it("rejects an unavailable supply read", async () => {
    await expect(
      runAdapter("sgho-wrapper", "sgho-aave", {
        network: { rpc: { "totalSupply()": null, "0x4cdad506": PREVIEW_REDEEM } },
      }),
    ).rejects.toThrow(/totalSupply/);
  });

  it("rejects a zero supply", async () => {
    await expect(
      runAdapter("sgho-wrapper", "sgho-aave", {
        network: { rpc: { "totalSupply()": 0n, "0x4cdad506": PREVIEW_REDEEM } },
      }),
    ).rejects.toThrow(/totalSupply/);
  });

  it("rejects an unavailable or zero redemption preview", async () => {
    for (const previewRedeem of [null, 0n]) {
      await expect(
        runAdapter("sgho-wrapper", "sgho-aave", { network: sghoNetwork(previewRedeem) }),
      ).rejects.toThrow(/previewRedeem/);
    }
  });

  it("preserves a positive backing shortfall without clamping upward", async () => {
    const { result } = await runAdapter("sgho-wrapper", "sgho-aave", {
      network: sghoNetwork(800n * 10n ** 18n),
    });

    expect(result.metadata).toMatchObject({
      details: { sharePrice: 0.8 },
      redemption: { capacityUsd: 800, capacityRatioOfSupply: 0.8 },
    });
  });

  it("uses previewRedeem(totalSupply) as same-run backing evidence", async () => {
    const { result, network } = await runAdapter("sgho-wrapper", "sgho-aave", {
      network: sghoNetwork(PREVIEW_REDEEM),
    });

    expect(result.slices).toEqual([
      expect.objectContaining({
        sourceKey: "sgho-wrapper:gho",
        pct: 100,
        coinId: "gho-aave",
        depType: "wrapper",
      }),
    ]);
    expect(network.rpcCalls.map((call) => call.selector)).toEqual(["0x18160ddd", "0x4cdad506"]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      details: { proofKind: "aave-sgho-preview-redeem", sharePrice: 1.005 },
      totalSupplyRaw: SUPPLY.toString(),
      previewRedeemRaw: PREVIEW_REDEEM.toString(),
      supplyUsd: 1000,
      previewRedeemUsd: 1005,
      redemption: {
        capacityUsd: 1005,
        capacityRatioOfSupply: 1,
        capacityKind: "live-direct",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
      },
    });
  });
});
