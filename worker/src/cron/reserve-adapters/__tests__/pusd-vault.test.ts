import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

const uint256Mock = vi.hoisted(() => vi.fn());

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    makeOnchainCallers: vi.fn(() => ({
      uint256: uint256Mock,
      raw: vi.fn(),
    })),
  };
});

import { fetchPusdVaultReserves } from "../pusd-vault";

const VAULT = "0xc417fd8e9661c0d2120b64a04bb3278c17e99db1";
const USDCE = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const USDC = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const TOKEN = "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb";

const signal = new AbortController().signal;

const coin = {
  id: "pusd-polymarket",
  contracts: [{ chain: "polygon", address: TOKEN, decimals: 6 }],
} as StablecoinMeta;

function makeConfig(): LiveReservesConfig {
  return {
    adapter: "pusd-vault",
    version: 1,
    semantics: "single-asset",
    inputs: {
      primary: { kind: "onchain-evm", chain: "polygon", rpcMode: "public-rpc" },
    },
    params: {
      vaultAddress: VAULT,
      assets: [
        { address: USDCE, decimals: 6 },
        { address: USDC, decimals: 6 },
      ],
      slice: {
        name: "USDC / USDC.e on Polygon",
        risk: "low",
        coinId: "usdc-circle",
        depType: "collateral",
      },
      sourceUrls: ["https://docs.polymarket.com/concepts/pusd"],
    },
  } as LiveReservesConfig;
}

function balanceOf(contract: string, balances: Record<string, bigint | null>): Promise<bigint | null> {
  const value = balances[contract.toLowerCase()];
  return Promise.resolve(value === undefined ? null : value);
}

describe("fetchPusdVaultReserves", () => {
  beforeEach(() => {
    uint256Mock.mockReset();
  });

  it("reads vault USDC balances vs pUSD supply for a ~101% coverage path", async () => {
    uint256Mock.mockImplementation((contract: string) =>
      balanceOf(contract, {
        [USDCE]: 300_000_000n, // $300 (6dp)
        [USDC]: 104_000_000n, // $104 (6dp)
        [TOKEN]: 400_000_000n, // $400 pUSD supply (6dp)
      }),
    );

    const result = await fetchPusdVaultReserves(coin, makeConfig(), signal);

    expect(result.slices).toEqual([
      {
        name: "USDC / USDC.e on Polygon",
        pct: 100,
        risk: "low",
        coinId: "usdc-circle",
        depType: "collateral",
        blacklistable: true,
      },
    ]);
    expect(result.warnings ?? []).toEqual([]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      vaultAddress: VAULT,
      tokenAddress: TOKEN,
      totalSupplyRaw: "400000000",
      vaultBalanceUsd: 404,
      supplyUsd: 400,
      collateralizationRatio: 1.01,
      redemption: {
        capacityUsd: 404,
        capacityRatioOfSupply: 1,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        sourceUrls: ["https://docs.polymarket.com/concepts/pusd"],
      },
    });
  });

  it("degrades a shortfall vault below the coverage threshold", async () => {
    uint256Mock.mockImplementation((contract: string) =>
      balanceOf(contract, {
        [USDCE]: 60_000_000n, // $60
        [USDC]: 35_000_000n, // $35
        [TOKEN]: 100_000_000n, // $100 pUSD supply
      }),
    );

    const result = await fetchPusdVaultReserves(coin, makeConfig(), signal);

    expect(result.metadata).toMatchObject({
      vaultBalanceUsd: 95,
      supplyUsd: 100,
      collateralizationRatio: 0.95,
      redemption: { capacityUsd: 95, capacityRatioOfSupply: 0.95 },
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "reserve-undercollateralized",
        effect: "degraded",
        severity: "warning",
      }),
    ]);
  });

  it("fails closed when a vault balance read fails", async () => {
    uint256Mock.mockImplementation((contract: string) =>
      balanceOf(contract, {
        [USDCE]: null,
        [USDC]: 35_000_000n,
        [TOKEN]: 100_000_000n,
      }),
    );

    await expect(fetchPusdVaultReserves(coin, makeConfig(), signal)).rejects.toThrow(
      "pusd-vault: balanceOf(vault) failed",
    );
  });

  it("fails closed when totalSupply() cannot be read", async () => {
    uint256Mock.mockImplementation((contract: string) =>
      balanceOf(contract, {
        [USDCE]: 60_000_000n,
        [USDC]: 35_000_000n,
        [TOKEN]: null,
      }),
    );

    await expect(fetchPusdVaultReserves(coin, makeConfig(), signal)).rejects.toThrow(
      "pusd-vault: totalSupply() failed",
    );
  });
});
