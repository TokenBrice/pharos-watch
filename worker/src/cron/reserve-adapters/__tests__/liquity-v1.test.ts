import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  const { makeOnchainCallersMock } = await import("./helpers/onchain-callers-mock");
  const fetchOnchainUint256 = vi.fn();
  return {
    ...actual,
    fetchOnchainUint256,
    makeOnchainCallers: makeOnchainCallersMock({ uint256: fetchOnchainUint256 }),
    fetchDefiLlamaPrices: vi.fn(),
    probeOptionalRedemptionRateBps: vi.fn(),
  };
});

import { fetchLiquityV1Reserves } from "../liquity-v1";
import { fetchDefiLlamaPrices, fetchOnchainUint256, probeOptionalRedemptionRateBps } from "../helpers";

import { TEST_SIGNAL as signal } from "./reserve-adapter.test-support";
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
      decimals: 18,
    },
  },
};

describe("fetchLiquityV1Reserves", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a 100% ETH slice with collateralization ratio from Liquity v1 reads", async () => {
    // 200 ETH collateral at $2000 = $400k, debt = 150k LUSD → CR ≈ 2.667
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(200_000_000_000_000_000_000n) // 200 ETH
      .mockResolvedValueOnce(150_000_000_000_000_000_000_000n); // 150k LUSD
    vi.mocked(probeOptionalRedemptionRateBps).mockResolvedValue(50);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["ETH", 2000]]));

    const result = await fetchLiquityV1Reserves(coin, config, signal);

    expect(result.slices).toEqual([{
      name: "ETH",
      pct: 100,
      risk: "very-low",
    }]);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      chain: "ethereum",
      troveManagerAddress: "0xA39739EF8b0231DbFA0DcdA07d7e29faAbCf4bb2",
      totalCollateralRaw: "200000000000000000000",
      totalDebtRaw: "150000000000000000000000",
      totalDebtUsd: 150_000,
      totalCollateralUsd: 400_000,
      ethPriceUsd: 2000,
      immediateRedeemableUsd: 150_000,
      redemptionFeeBps: 50,
      redemption: {
        capacityUsd: 150_000,
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
    // 400000 / 150000 ≈ 2.667
    expect((result.metadata?.collateralizationRatio as number | undefined)).toBeCloseTo(2.667, 2);
  });

  it("emits degraded warning when collateralization ratio falls below 1.2", async () => {
    // 100 ETH collateral at $1 → $100, debt = 100 LUSD → CR = 1.0
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(100_000_000_000_000_000_000n)
      .mockResolvedValueOnce(100_000_000_000_000_000_000n);
    vi.mocked(probeOptionalRedemptionRateBps).mockResolvedValue(50);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["ETH", 1]]));

    const result = await fetchLiquityV1Reserves(coin, config, signal);

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "liquity-v1-low-collateralization-ratio",
        severity: "warning",
      }),
    ]);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.0, 3);
  });

  it("emits degraded warning when the ETH price is unavailable", async () => {
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(100_000_000_000_000_000_000n)
      .mockResolvedValueOnce(100_000_000_000_000_000_000n);
    vi.mocked(probeOptionalRedemptionRateBps).mockResolvedValue(null);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map());

    const result = await fetchLiquityV1Reserves(coin, config, signal);

    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "liquity-v1-eth-price-unavailable" }),
    ]);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
  });

  it("fails closed when system collateral is unreadable", async () => {
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(84_000_000_000_000_000_000n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["ETH", 2000]]));

    await expect(fetchLiquityV1Reserves(coin, config, signal)).rejects.toThrow(
      "liquity-v1 getEntireSystemColl() returned zero/unreadable collateral",
    );
  });

  it("fails closed when system debt is zero", async () => {
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(123_000_000_000_000_000_000n)
      .mockResolvedValueOnce(0n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["ETH", 2000]]));

    await expect(fetchLiquityV1Reserves(coin, config, signal)).rejects.toThrow(
      "liquity-v1 getEntireSystemDebt() returned zero/unreadable debt",
    );
  });
});
