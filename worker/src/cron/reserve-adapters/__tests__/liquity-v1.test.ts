import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchOnchainUint256: vi.fn(),
    fetchOnchainRateBps: vi.fn(),
  };
});

import { fetchLiquityV1Reserves } from "../liquity-v1";
import { fetchOnchainRateBps, fetchOnchainUint256 } from "../helpers";

const signal = AbortSignal.timeout(5_000);
const coin = { id: "lusd-liquity" } as StablecoinMeta;

const config: LiveReservesConfig = {
  adapter: "liquity-v1",
  version: 2,
  semantics: "single-asset",
  inputs: {
    primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "alchemy" },
  },
  params: {
    troveManagerAddress: "0xA39739EF8b0231DbFA0DcdA07d7e29faAbCf4bb2",
    slice: {
      name: "ETH",
      risk: "very-low",
    },
    redemptionRateProbe: {
      contract: "0xA39739EF8b0231DbFA0DcdA07d7e29faAbCf4bb2",
      selector: "0xc52861f2",
    },
  },
};

describe("fetchLiquityV1Reserves", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a 100% ETH slice from Liquity v1 system collateral reads", async () => {
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(123_000_000_000_000_000_000n)
      .mockResolvedValueOnce(84_000_000_000_000_000_000n);
    vi.mocked(fetchOnchainRateBps).mockResolvedValue(50);

    const result = await fetchLiquityV1Reserves(coin, config, signal);

    expect(result.slices).toEqual([{
      name: "ETH",
      pct: 100,
      risk: "very-low",
    }]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      chain: "ethereum",
      troveManagerAddress: "0xA39739EF8b0231DbFA0DcdA07d7e29faAbCf4bb2",
      totalCollateralRaw: "123000000000000000000",
      totalDebtRaw: "84000000000000000000",
      immediateRedeemableUsd: 84,
      redemptionFeeBps: 50,
      redemption: {
        capacityUsd: 84,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        feeBps: 50,
      },
      details: {
        proofKind: "liquity-v1-system-collateral",
      },
    });
  });

  it("fails closed when system collateral is unreadable", async () => {
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(84_000_000_000_000_000_000n);

    await expect(fetchLiquityV1Reserves(coin, config, signal)).rejects.toThrow(
      "liquity-v1 getEntireSystemColl() returned zero/unreadable collateral",
    );
  });

  it("fails closed when system debt is zero", async () => {
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(123_000_000_000_000_000_000n)
      .mockResolvedValueOnce(0n);

    await expect(fetchLiquityV1Reserves(coin, config, signal)).rejects.toThrow(
      "liquity-v1 getEntireSystemDebt() returned zero/unreadable debt",
    );
  });
});
