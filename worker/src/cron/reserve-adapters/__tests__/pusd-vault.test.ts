import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { makeOnchainCallers } from "../helpers";
import { fetchPusdVaultReserves } from "../pusd-vault";

const uint256Mock = vi.hoisted(() => vi.fn());
const fetchErc20TotalSupplyMock = vi.hoisted(() => vi.fn());

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    makeOnchainCallers: vi.fn(() => ({
      uint256: uint256Mock,
      raw: vi.fn(),
    })),
    fetchErc20TotalSupply: fetchErc20TotalSupplyMock,
  };
});

const VAULT = "0xc417fd8e9661c0d2120b64a04bb3278c17e99db1";
const USDCE = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const USDC = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const TOKEN = "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb";
const ETH_VAULT = "0xdddd73f5df1f0dc31373357beac77545dc5a6f3f";
const PLUME_VAULT = "0xdddd73f5df1f0dc31373357beac77545dc5a6f3f";
const PLUME_USDC = "0x222365ef19f7947e5484218551b56bb3965aa7af";
const PLUME_USDCE = "0x78add880a697070c1e765ac44d65323a0dcce913";
const ETH_TOKEN = "0x1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a";
const PLUME_TOKEN = "0x2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b";
const UNMAPPED = "0x606bfbc3031890d5bc385ec152c66f14644e1bdc";

const signal = new AbortController().signal;

const coin = {
  id: "pusd-polymarket",
  contracts: [{ chain: "polygon", address: TOKEN, decimals: 6 }],
} as StablecoinMeta;

const dualChainCoin = {
  id: "pusd-plume",
  contracts: [
    { chain: "ethereum", address: ETH_TOKEN, decimals: 6 },
    { chain: "plume", address: PLUME_TOKEN, decimals: 6 },
  ],
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

function makeMultichainConfig(extraAssets: Array<Record<string, unknown>> = []): LiveReservesConfig {
  return {
    adapter: "pusd-vault",
    version: 1,
    semantics: "single-asset",
    inputs: {
      primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
    },
    params: {
      chains: [
        {
          chain: "ethereum",
          vaultAddress: ETH_VAULT,
          assets: [{ address: PLUME_USDC, decimals: 6, name: "USDC on Ethereum", risk: "low", coinId: "usdc-circle", depType: "collateral" }],
        },
        {
          chain: "plume",
          vaultAddress: PLUME_VAULT,
          assets: [
            { address: PLUME_USDC, decimals: 6, name: "USDC on Plume", risk: "low", coinId: "usdc-circle", depType: "collateral" },
            { address: PLUME_USDCE, decimals: 6, name: "USDC.e on Plume", risk: "low", coinId: "usdc-circle", depType: "collateral" },
            ...extraAssets,
          ],
        },
      ],
      sourceUrls: ["https://docs.plume.org/plume/tokens/plume-usd"],
    },
  } as LiveReservesConfig;
}

function balanceOf(contract: string, balances: Record<string, bigint | null>): Promise<bigint | null> {
  const value = balances[contract.toLowerCase()];
  return Promise.resolve(value === undefined ? null : value);
}

interface ChainBalances {
  [chain: string]: Record<string, bigint | null> | undefined;
}

function mockMultichainCallers(chainBalances: ChainBalances): void {
  vi.mocked(makeOnchainCallers).mockImplementation((input) => ({
    uint256: (contract: string) => balanceOf(contract, chainBalances[input.chain] ?? {}),
    raw: () => Promise.resolve(null),
  }));
}

function mockSupplies(supplies: Record<string, bigint | null>): void {
  fetchErc20TotalSupplyMock.mockImplementation((_input: unknown, contract: string) => {
    const value = supplies[contract.toLowerCase()];
    return Promise.resolve(value === undefined ? null : value);
  });
}

describe("fetchPusdVaultReserves", () => {
  beforeEach(() => {
    uint256Mock.mockReset();
    fetchErc20TotalSupplyMock.mockReset();
    vi.mocked(makeOnchainCallers).mockClear();
    vi.mocked(makeOnchainCallers).mockImplementation(() => ({
      uint256: uint256Mock,
      raw: vi.fn(),
    }));
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
        sourceKey: "pusd-vault:0xc417fd8e9661c0d2120b64a04bb3278c17e99db1",
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

  it("sums per-asset holdings across chains and compares to multichain supply", async () => {
    mockMultichainCallers({
      ethereum: { [PLUME_USDC]: 100_000_000_000n }, // $100,000 (6dp)
      plume: {
        [PLUME_USDC]: 2_400_000_000_000n, // $2,400,000
        [PLUME_USDCE]: 500_000_000_000n, // $500,000
      },
    });
    mockSupplies({
      [ETH_TOKEN]: 600_000_000_000n, // $600,000 supply on Ethereum
      [PLUME_TOKEN]: 3_400_000_000_000n, // $3,400,000 supply on Plume
    });

    const result = await fetchPusdVaultReserves(dualChainCoin, makeMultichainConfig(), signal);

    // Holdings $3,000,000 vs supply $4,000,000: 80% / 16.7% / 3.3% slices.
    expect(result.slices).toEqual([
      { sourceKey: "pusd-vault:0x222365ef19f7947e5484218551b56bb3965aa7af", name: "USDC on Plume", pct: 80, risk: "low", coinId: "usdc-circle", depType: "collateral", blacklistable: true },
      { sourceKey: "pusd-vault:0x78add880a697070c1e765ac44d65323a0dcce913", name: "USDC.e on Plume", pct: 16.7, risk: "low", coinId: "usdc-circle", depType: "collateral", blacklistable: true },
      { sourceKey: "pusd-vault:0x222365ef19f7947e5484218551b56bb3965aa7af", name: "USDC on Ethereum", pct: 3.3, risk: "low", coinId: "usdc-circle", depType: "collateral", blacklistable: true },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      mode: "multichain",
      vaultBalanceUsd: 3_000_000,
      supplyUsd: 4_000_000,
      collateralizationRatio: 0.75,
      totalSupplyRaw: "4000000000000",
      supplyReadComplete: true,
      supplyContributions: [
        { chain: "ethereum", tokenAddress: ETH_TOKEN, supplyRaw: "600000000000", decimals: 6 },
        { chain: "plume", tokenAddress: PLUME_TOKEN, supplyRaw: "3400000000000", decimals: 6 },
      ],
      unknownExposurePct: 0,
      chains: [
        {
          chain: "ethereum",
          vaultAddress: ETH_VAULT,
          holdings: [{ address: PLUME_USDC, name: "USDC on Ethereum", coinId: "usdc-circle", balanceRaw: "100000000000", decimals: 6, usd: 100_000 }],
        },
        {
          chain: "plume",
          vaultAddress: PLUME_VAULT,
          holdings: [
            { address: PLUME_USDC, name: "USDC on Plume", coinId: "usdc-circle", balanceRaw: "2400000000000", decimals: 6, usd: 2_400_000 },
            { address: PLUME_USDCE, name: "USDC.e on Plume", coinId: "usdc-circle", balanceRaw: "500000000000", decimals: 6, usd: 500_000 },
          ],
        },
      ],
      redemption: { capacityUsd: 3_000_000, capacityRatioOfSupply: 0.75, capacityKind: "live-direct-bounded" },
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "reserve-undercollateralized",
        effect: "degraded",
        severity: "warning",
      }),
    ]);
  });

  it("counts unmapped assets toward unknownExposurePct and degrades past 5%", async () => {
    mockMultichainCallers({
      ethereum: { [PLUME_USDC]: 100_000_000_000n },
      plume: {
        [PLUME_USDC]: 2_400_000_000_000n,
        [PLUME_USDCE]: 500_000_000_000n,
        [UNMAPPED]: 600_000_000_000_000_000_000_000n, // 600,000 units (18dp)
      },
    });
    mockSupplies({ [ETH_TOKEN]: 600_000_000_000n, [PLUME_TOKEN]: 3_400_000_000_000n });

    const result = await fetchPusdVaultReserves(
      dualChainCoin,
      makeMultichainConfig([
        { address: UNMAPPED, decimals: 18, name: "Unmapped vault asset", risk: "high" },
      ]),
      signal,
    );

    // $600,000 of $3,600,000 holdings is unmapped.
    expect(result.metadata).toMatchObject({ vaultBalanceUsd: 3_600_000, unknownExposurePct: expect.closeTo(16.6667, 3) });
    expect(
      result.slices.some((slice) => slice.name === "Unmapped vault asset" && slice.risk === "high" && slice.coinId === undefined),
    ).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "reserve-unmapped-vault-asset", effect: "degraded" }),
        expect.objectContaining({ code: "reserve-undercollateralized", effect: "degraded" }),
      ]),
    );
  });

  it("fails closed when a per-chain vault balance read fails", async () => {
    mockMultichainCallers({
      ethereum: { [PLUME_USDC]: 100_000_000_000n },
      plume: { [PLUME_USDC]: 2_400_000_000_000n, [PLUME_USDCE]: null },
    });
    mockSupplies({ [ETH_TOKEN]: 600_000_000_000n, [PLUME_TOKEN]: 3_400_000_000_000n });

    await expect(fetchPusdVaultReserves(dualChainCoin, makeMultichainConfig(), signal)).rejects.toThrow(
      `pusd-vault: balanceOf(vault) failed for ${PLUME_USDCE} on plume`,
    );
  });

  it("fails closed when every chain's totalSupply() read fails", async () => {
    mockMultichainCallers({
      ethereum: { [PLUME_USDC]: 100_000_000_000n },
      plume: { [PLUME_USDC]: 2_400_000_000_000n, [PLUME_USDCE]: 500_000_000_000n },
    });
    mockSupplies({});

    await expect(fetchPusdVaultReserves(dualChainCoin, makeMultichainConfig(), signal)).rejects.toThrow(
      "pusd-vault: totalSupply() calls failed on all chains",
    );
  });

  it("degrades and flags supplyReadComplete when one chain's supply read fails", async () => {
    mockMultichainCallers({
      ethereum: { [PLUME_USDC]: 100_000_000_000n },
      plume: { [PLUME_USDC]: 2_400_000_000_000n, [PLUME_USDCE]: 500_000_000_000n },
    });
    mockSupplies({ [ETH_TOKEN]: 600_000_000_000n, [PLUME_TOKEN]: null });

    const result = await fetchPusdVaultReserves(dualChainCoin, makeMultichainConfig(), signal);

    expect(result.metadata).toMatchObject({
      supplyUsd: 600_000,
      supplyReadComplete: false,
      supplyContributions: [{ chain: "ethereum", tokenAddress: ETH_TOKEN, supplyRaw: "600000000000", decimals: 6 }],
      collateralizationRatio: 5,
      redemption: { capacityRatioOfSupply: 1 },
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "partial-supply-read-failure", effect: "degraded" }),
    ]);
  });

  it("fails closed when configured holdings all read zero", async () => {
    mockMultichainCallers({
      ethereum: { [PLUME_USDC]: 0n },
      plume: { [PLUME_USDC]: 0n, [PLUME_USDCE]: 0n },
    });
    mockSupplies({ [ETH_TOKEN]: 600_000_000_000n, [PLUME_TOKEN]: 3_400_000_000_000n });

    await expect(fetchPusdVaultReserves(dualChainCoin, makeMultichainConfig(), signal)).rejects.toThrow(
      "pusd-vault: vault holdings sum to zero",
    );
  });

  it("rejects chains params mixed with the single-chain shape and requires one shape", () => {
    const chains = (makeMultichainConfig().params as { chains: unknown }).chains;
    expect(() =>
      parseLiveReserveAdapterParams("pusd-vault", {
        chains,
        vaultAddress: VAULT,
        assets: [{ address: USDC, decimals: 6 }],
        slice: { name: "x", risk: "low" },
      }),
    ).toThrow("chains is exclusive");

    expect(() => parseLiveReserveAdapterParams("pusd-vault", {})).toThrow(
      "vaultAddress, assets and slice are required without chains",
    );
  });
});
