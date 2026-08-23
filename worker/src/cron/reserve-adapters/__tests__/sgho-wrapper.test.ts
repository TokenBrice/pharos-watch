import { describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { encodeUint256 } from "../../../lib/evm-selectors";
import { fetchSghoWrapperReserves } from "../sgho-wrapper";

vi.mock("../helpers", async () => {
  const actual = await vi.importActual<typeof import("../helpers")>("../helpers");
  const { makeOnchainCallersMock } = await import("./helpers/onchain-callers-mock");
  const fetchOnchainRawCall = vi.fn(async ({ data }: { data: string }) => {
    if (data === "0x18160ddd") return `0x${(1000n * 10n ** 18n).toString(16).padStart(64, "0")}`;
    if (data === `0x4cdad506${encodeUint256(1000n * 10n ** 18n)}`) {
      return `0x${(1005n * 10n ** 18n).toString(16).padStart(64, "0")}`;
    }
    return null;
  });
  return {
    ...actual,
    fetchOnchainRawCall,
    makeOnchainCallers: makeOnchainCallersMock({ raw: fetchOnchainRawCall }),
  };
});

const COIN = {
  id: "sgho-aave",
  contracts: [{ chain: "ethereum", address: "0x1a88df1cfe15af22b3c4c783d4e6f7f9e0c1885d", decimals: 18 }],
} as StablecoinMeta;

const CONFIG: LiveReservesConfig = {
  adapter: "sgho-wrapper",
  version: 1,
  semantics: "single-asset",
  inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
  params: {
    slice: {
      name: "GHO deposited in Aave Savings module",
      risk: "low",
      coinId: "gho-aave",
      depType: "wrapper",
    },
  },
};

describe("sgho-wrapper adapter", () => {
  it("uses previewRedeem(totalSupply) as same-run backing evidence", async () => {
    const result = await fetchSghoWrapperReserves(COIN, CONFIG, new AbortController().signal);

    expect(result.slices).toEqual([
      {
        name: "GHO deposited in Aave Savings module",
        pct: 100,
        risk: "low",
        coinId: "gho-aave",
        depType: "wrapper",
      },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      details: { proofKind: "aave-sgho-preview-redeem" },
      totalSupplyRaw: (1000n * 10n ** 18n).toString(),
      previewRedeemRaw: (1005n * 10n ** 18n).toString(),
      supplyUsd: 1000,
      previewRedeemUsd: 1005,
      collateralizationRatio: 1.005,
      immediateRedeemableUsd: 1005,
      immediateRedeemableRatio: 1,
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
