import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";

const fetchErc20TotalSupplyMock = vi.fn();
const probeTrackedTokenSupplyMock = vi.fn();
const fetchOnchainUint256Mock = vi.fn();
const fetchSolanaTokenSupplyMock = vi.fn();
const fetchStarknetTotalSupplyMock = vi.fn();
const fetchIcrcLedgerTotalSupplyMock = vi.fn();
const fetchMovementFungibleAssetSupplyMock = vi.fn();

vi.mock("../../../reserve-adapters/helpers", () => ({
  fetchErc20TotalSupply: (...args: unknown[]) => fetchErc20TotalSupplyMock(...args),
  fetchOnchainUint256: (...args: unknown[]) => fetchOnchainUint256Mock(...args),
  fetchSolanaTokenSupply: (...args: unknown[]) => fetchSolanaTokenSupplyMock(...args),
  fetchStarknetTotalSupply: (...args: unknown[]) => fetchStarknetTotalSupplyMock(...args),
  fetchIcrcLedgerTotalSupply: (...args: unknown[]) => fetchIcrcLedgerTotalSupplyMock(...args),
  fetchMovementFungibleAssetSupply: (...args: unknown[]) => fetchMovementFungibleAssetSupplyMock(...args),
  probeTrackedTokenSupply: (...args: unknown[]) => probeTrackedTokenSupplyMock(...args),
}));

import { fetchCuratedAggregateOnChainMcap, fetchOnChainMcap } from "../onchain-supply";

function makeMovementMeta(): StablecoinMeta {
  return {
    id: "usdcx-movement",
    name: "Movement USDCx",
    symbol: "USDCx",
    detailProvider: "coingecko",
    contracts: [{
      chain: "movement",
      address: "0xba11833544a2f99eec743f41a228ca6ffa7f13c3b6b04681d5a79a8b75ff225e",
      decimals: 6,
    }],
    flags: { pegCurrency: "USD", backing: "rwa-backed", governance: "centralized-dependent" },
  } as StablecoinMeta;
}

function movementChainRpcs() {
  return new Map([
    ["movement", { chainId: "movement", chainName: "Movement", type: "other" as const, rpcUrl: "https://mainnet.movementnetwork.xyz/v1", explorerUrl: "https://explorer.movementnetwork.xyz" }],
    ["ethereum", { chainId: "ethereum", chainName: "Ethereum", type: "evm" as const, rpcUrl: "https://ethereum-rpc.publicnode.com", explorerUrl: "https://etherscan.io" }],
  ]);
}

function makeSkyMeta(): StablecoinMeta {
  return {
    id: "susds-sky",
    name: "Savings USDS",
    symbol: "sUSDS",
    detailProvider: "coingecko",
    contracts: [
      { chain: "ethereum", address: "0x0000000000000000000000000000000000000001", decimals: 18 },
      { chain: "base", address: "0x0000000000000000000000000000000000000002", decimals: 18 },
      { chain: "optimism", address: "0x0000000000000000000000000000000000000003", decimals: 18 },
      { chain: "arbitrum", address: "0x0000000000000000000000000000000000000004", decimals: 18 },
    ],
    flags: {
      pegCurrency: "USD",
      backing: "crypto-backed",
      governance: "centralized-dependent",
      yieldBearing: true,
      navToken: true,
    },
  } as StablecoinMeta;
}

function makeChfauMeta(): StablecoinMeta {
  return {
    id: "chfau-allunity",
    name: "AllUnity CHF",
    symbol: "CHFAU",
    detailProvider: "coingecko",
    contracts: [
      { chain: "ethereum", address: "0xbd4dfc058eb95b8de5ceaf39966a1a70f5556f78", decimals: 6 },
      { chain: "polygon", address: "0xbd4dfc058eb95b8de5ceaf39966a1a70f5556f78", decimals: 6 },
      { chain: "base", address: "0xbd4dfc058eb95b8de5ceaf39966a1a70f5556f78", decimals: 6 },
      { chain: "tempo", address: "0x20c00000000000000000000042109aef2f8b28e1", decimals: 6 },
    ],
    flags: {
      pegCurrency: "CHF",
      backing: "rwa-backed",
      governance: "centralized",
      yieldBearing: false,
      navToken: false,
    },
  } as StablecoinMeta;
}

const SUSDE_OFT = "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2";
const SUSDE_REPRESENTATION_CHAINS = [
  "plasma", "linea", "fraxtal", "hyperevm", "berachain", "zircuit", "metis", "xlayer",
  "base", "bsc", "morph-l2", "scroll", "kava", "swellchain", "mode", "mantle",
  "arbitrum", "manta", "blast", "optimism", "zksync", "avalanche", "solana",
];

function makeSusdeMeta(): StablecoinMeta {
  return {
    id: "susde-ethena",
    name: "Staked USDe",
    symbol: "sUSDe",
    detailProvider: "coingecko",
    contracts: [
      { chain: "ethereum", address: "0x9d39a5de30e57443bff2a8307a4256c8797a3497", decimals: 18 },
      ...SUSDE_REPRESENTATION_CHAINS.map((chain) => ({ chain, address: SUSDE_OFT, decimals: 18 })),
    ],
    flags: {
      pegCurrency: "USD",
      backing: "crypto-backed",
      governance: "centralized-dependent",
      yieldBearing: true,
      navToken: true,
    },
  } as StablecoinMeta;
}

function makeAcrdxMeta(): StablecoinMeta {
  const share = "0x9477724bb54ad5417de8baff29e59df3fb4da74f";
  const spoke = "0x2fabf1c784b8583d63c00c5c9c0377d8cf1a3245";
  return {
    id: "acrdx-anemoy-apollo",
    name: "Anemoy Apollo",
    symbol: "ACRDX",
    detailProvider: "coingecko",
    contracts: [
      { chain: "ethereum", address: share, decimals: 18 },
      { chain: "plume", address: share, decimals: 18 },
      { chain: "monad", address: spoke, decimals: 18 },
      { chain: "base", address: share, decimals: 18 },
      { chain: "optimism", address: spoke, decimals: 18 },
      { chain: "solana", address: "ACDR3LGFrMuDZSDRyJjncFCzo5c8xkQxhWx4im4Vmq8G", decimals: 6 },
    ],
    flags: {
      pegCurrency: "USD",
      backing: "rwa-backed",
      governance: "centralized",
      yieldBearing: true,
      navToken: true,
    },
  } as StablecoinMeta;
}

function makeGldtMeta(): StablecoinMeta {
  const evm = "0x86856814e74456893cfc8946bedcbb472b5fa856";
  return {
    id: "gldt-gold-dao",
    name: "Gold Token",
    symbol: "GLDT",
    detailProvider: "commodity",
    contracts: [
      { chain: "ethereum", address: evm, decimals: 8 },
      { chain: "base", address: evm, decimals: 8 },
      { chain: "arbitrum", address: evm, decimals: 8 },
      { chain: "icp", address: "6c7su-kiaaa-aaaar-qaira-cai", decimals: 8 },
    ],
    flags: {
      pegCurrency: "GOLD",
      backing: "rwa-backed",
      governance: "centralized-dependent",
      yieldBearing: false,
      navToken: false,
    },
  } as StablecoinMeta;
}

function makeMre7yieldMeta(): StablecoinMeta {
  return {
    id: "mre7yield-midas",
    name: "Midas Re7 Yield",
    symbol: "mRe7YIELD",
    detailProvider: "coingecko",
    contracts: [
      { chain: "ethereum", address: "0x87c9053c819bb28e0d73d33059e1b3da80afb0cf", decimals: 18 },
      { chain: "etherlink", address: "0x733d504435a49fc8c4e9759e756c2846c92f0160", decimals: 18 },
      {
        chain: "starknet",
        address: "0x04be8945e61dc3e19ebadd1579a6bd53b262f51ba89e6f8b0c4bc9a7e3c633fc",
        decimals: 18,
      },
    ],
    flags: {
      pegCurrency: "USD",
      backing: "rwa-backed",
      governance: "centralized",
      yieldBearing: true,
      navToken: true,
    },
  } as StablecoinMeta;
}

function makeSingleContractMeta(): StablecoinMeta {
  return {
    id: "susdc-spark",
    name: "Spark Savings USDC",
    symbol: "sUSDC",
    detailProvider: "coingecko",
    contracts: [
      { chain: "ethereum", address: "0x0000000000000000000000000000000000000009", decimals: 18 },
    ],
    flags: {
      pegCurrency: "USD",
      backing: "crypto-backed",
      governance: "centralized-dependent",
      yieldBearing: true,
      navToken: true,
    },
  } as StablecoinMeta;
}

describe("fetchOnChainMcap", () => {
  beforeEach(() => {
    fetchErc20TotalSupplyMock.mockReset();
    probeTrackedTokenSupplyMock.mockReset();
  });

  it("passes through the resolved chain and chain label for the single-contract fallback", async () => {
    probeTrackedTokenSupplyMock.mockResolvedValue(1_000n * 10n ** 18n);

    await expect(fetchOnChainMcap(makeSingleContractMeta(), 1)).resolves.toMatchObject({
      mcap: 1_000,
      chain: "ethereum",
      chainLabel: expect.any(String),
    });
  });

  it("skips the supply probe when contract decimals are missing", async () => {
    const source = makeSingleContractMeta();
    const meta = {
      ...source,
      contracts: [{ chain: "ethereum", address: source.contracts?.[0]?.address ?? "0x0" }],
    } as unknown as StablecoinMeta;

    await expect(fetchOnChainMcap(meta, 1)).resolves.toBeNull();
    expect(probeTrackedTokenSupplyMock).not.toHaveBeenCalled();
    expect(fetchErc20TotalSupplyMock).not.toHaveBeenCalled();
  });
});

describe("fetchCuratedAggregateOnChainMcap", () => {
  it("admits Movement USDCx only when its pinned-ledger supply reconciles to xReserve", async () => {
    fetchMovementFungibleAssetSupplyMock.mockResolvedValue({
      rawSupply: 1_739_632_096_715n,
      decimals: 6,
      ledgerVersion: "199722477",
    });
    fetchOnchainUint256Mock.mockResolvedValue(1_739_679_096_715n);

    const result = await fetchCuratedAggregateOnChainMcap(
      makeMovementMeta(), 1, movementChainRpcs(),
    );

    expect(result).toMatchObject({
      mcap: 1_739_632.096715,
      supplySource: "onchain-total-supply",
      chainCirculating: { Movement: { current: 1_739_632.096715, chainId: "movement" } },
    });
  });

  it("fails Movement USDCx closed when xReserve differs by more than one basis point", async () => {
    fetchMovementFungibleAssetSupplyMock.mockResolvedValue({
      rawSupply: 1_739_632_096_715n,
      decimals: 6,
      ledgerVersion: "199722477",
    });
    fetchOnchainUint256Mock.mockResolvedValue(1_740_000_000_000n);

    await expect(fetchCuratedAggregateOnChainMcap(
      makeMovementMeta(), 1, movementChainRpcs(),
    )).resolves.toBeNull();
  });

  it("fails Movement USDCx closed when its ledger observation is unavailable", async () => {
    fetchMovementFungibleAssetSupplyMock.mockResolvedValue(null);

    await expect(fetchCuratedAggregateOnChainMcap(
      makeMovementMeta(), 1, movementChainRpcs(),
    )).resolves.toBeNull();
    expect(fetchOnchainUint256Mock).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    fetchErc20TotalSupplyMock.mockReset();
    probeTrackedTokenSupplyMock.mockReset();
    fetchOnchainUint256Mock.mockReset();
    fetchSolanaTokenSupplyMock.mockReset();
    fetchStarknetTotalSupplyMock.mockReset();
    fetchIcrcLedgerTotalSupplyMock.mockReset();
    fetchMovementFungibleAssetSupplyMock.mockReset();
  });

  it("reallocates canonical lock/mint supply without double counting representations", async () => {
    probeTrackedTokenSupplyMock.mockImplementation(async (_meta, input) => {
      if (input?.chain === "ethereum") return 1_000n * 10n ** 18n;
      if (input?.chain === "base") return 100n * 10n ** 18n;
      if (input?.chain === "optimism") return 50n * 10n ** 18n;
      if (input?.chain === "arbitrum") return 25n * 10n ** 18n;
      return 0n;
    });

    await expect(fetchCuratedAggregateOnChainMcap(makeSkyMeta(), 1)).resolves.toEqual({
      mcap: 1_000,
      supplySource: "onchain-total-supply",
      chainCirculating: {
        Ethereum: { current: 825, chainId: "ethereum" },
        Base: { current: 100, chainId: "base" },
        Optimism: { current: 50, chainId: "optimism" },
        Arbitrum: { current: 25, chainId: "arbitrum" },
      },
    });
  });

  it("fails closed when representation supply is not smaller than canonical supply", async () => {
    probeTrackedTokenSupplyMock.mockImplementation(async (_meta, input) =>
      input?.chain === "ethereum" ? 100n * 10n ** 18n : 50n * 10n ** 18n,
    );

    await expect(fetchCuratedAggregateOnChainMcap(makeSkyMeta(), 1)).resolves.toBeNull();
  });

  it("keeps CHFAU aggregate supply when reviewed native deployments have zero supply", async () => {
    fetchErc20TotalSupplyMock.mockImplementation(async (input) => {
      if (input?.chain === "ethereum") return 49_680_021_921_656n;
      if (input?.chain === "polygon") return 0n;
      if (input?.chain === "base") return 0n;
      if (input?.chain === "tempo") return 0n;
      return null;
    });

    const result = await fetchCuratedAggregateOnChainMcap(makeChfauMeta(), 1.12);

    expect(result?.supplySource).toBe("onchain-total-supply");
    expect(result?.mcap).toBeCloseTo(55_641_624.55225472, 6);
    expect(result?.chainCirculating?.Ethereum?.current).toBeCloseTo(55_641_624.55225472, 6);
    expect(result?.chainCirculating?.Polygon?.current).toBe(0);
    expect(result?.chainCirculating?.Base?.current).toBe(0);
    expect(result?.chainCirculating?.Tempo?.current).toBe(0);
    expect(fetchErc20TotalSupplyMock).toHaveBeenCalledTimes(4);
  });

  it("fails CHFAU aggregate supply closed when a reviewed native deployment cannot be read", async () => {
    fetchErc20TotalSupplyMock.mockImplementation(async (input) => {
      if (input?.chain === "ethereum") return 49_680_021_921_656n;
      if (input?.chain === "polygon") return 0n;
      if (input?.chain === "base") return null;
      if (input?.chain === "tempo") return 0n;
      return null;
    });

    await expect(fetchCuratedAggregateOnChainMcap(makeChfauMeta(), 1.12)).resolves.toBeNull();
  });

  function mockSusdeLegs(): void {
    // Every configured representation reads 10; the X Layer leg is the one
    // allowZeroSupply leg and therefore bypasses the probe.
    probeTrackedTokenSupplyMock.mockImplementation(async (_meta, input) =>
      input?.chain === "ethereum" ? 1_000n * 10n ** 18n : 10n * 10n ** 18n,
    );
    fetchErc20TotalSupplyMock.mockResolvedValue(10n * 10n ** 18n);
  }

  it("splits sUSDe's canonical row into free float and an unattributed escrow remainder", async () => {
    mockSusdeLegs();
    // The OFT adapter escrows 300, but only 230 of it is claimed by configured
    // representation legs: TON, Aptos and unmatched escrow are the remaining 70.
    fetchOnchainUint256Mock.mockResolvedValue(300n * 10n ** 18n);

    const result = await fetchCuratedAggregateOnChainMcap(makeSusdeMeta(), 1);

    expect(result?.mcap).toBe(1_000);
    expect(result?.chainCirculating?.Ethereum?.current).toBe(700);
    expect(result?.chainCirculating?.["sUSDe unattributed OFT escrow"]?.current).toBe(70);
    const published = Object.values(result?.chainCirculating ?? {}).reduce((sum, value) => sum + value.current, 0);
    expect(published).toBeCloseTo(1_000, 6);
    // balanceOf(0x211cc4dd…) on the canonical Ethereum sUSDe contract.
    expect(fetchOnchainUint256Mock.mock.calls[0]?.[0]).toMatchObject({
      chain: "ethereum",
      contract: "0x9d39a5de30e57443bff2a8307a4256c8797a3497",
      data: `0x70a08231${SUSDE_OFT.slice(2).padStart(64, "0")}`,
    });
  });

  it("fails sUSDe closed when the escrow balance cannot be read or is inconsistent", async () => {
    mockSusdeLegs();
    fetchOnchainUint256Mock.mockResolvedValue(null);
    await expect(fetchCuratedAggregateOnChainMcap(makeSusdeMeta(), 1)).resolves.toBeNull();

    // Escrow smaller than the configured representations means the lock/mint
    // model no longer holds, so the aggregate must not publish a negative row.
    fetchOnchainUint256Mock.mockResolvedValue(100n * 10n ** 18n);
    await expect(fetchCuratedAggregateOnChainMcap(makeSusdeMeta(), 1)).resolves.toBeNull();
  });

  it("reads ACRDX's zero-supply Solana mint instead of failing the aggregate closed", async () => {
    probeTrackedTokenSupplyMock.mockImplementation(async (_meta, input) => {
      if (input?.chain === "ethereum") return 378_869n * 10n ** 18n;
      if (input?.chain === "plume") return 32_320_262n * 10n ** 18n;
      if (input?.chain === "monad") return 9_837_361n * 10n ** 18n;
      if (input?.chain === "optimism") return 97_931n * 10n ** 18n;
      return null;
    });
    fetchErc20TotalSupplyMock.mockResolvedValue(0n);
    fetchSolanaTokenSupplyMock.mockResolvedValue(0n);

    const result = await fetchCuratedAggregateOnChainMcap(makeAcrdxMeta(), 1);

    expect(result?.mcap).toBe(42_634_423);
    expect(result?.chainCirculating?.Base?.current).toBe(0);
    expect(result?.chainCirculating?.Solana?.current).toBe(0);
    expect(fetchSolanaTokenSupplyMock).toHaveBeenCalledTimes(1);
    // The Solana leg must never route through the probe, which rejects zero.
    expect(probeTrackedTokenSupplyMock.mock.calls.every(([, input]) => input?.kind !== "onchain-solana")).toBe(true);
  });

  it("reallocates GLDT's canonical ICP ledger supply across its Omnity EVM legs", async () => {
    fetchIcrcLedgerTotalSupplyMock.mockResolvedValue(59_450_000_000_000n);
    probeTrackedTokenSupplyMock.mockImplementation(async (_meta, input) => {
      if (input?.chain === "ethereum") return 764_444_464n;
      if (input?.chain === "base") return 534_540_392_636n;
      return null;
    });
    fetchErc20TotalSupplyMock.mockResolvedValue(0n);

    const result = await fetchCuratedAggregateOnChainMcap(makeGldtMeta(), 1);

    expect(result?.mcap).toBe(594_500);
    expect(result?.chainCirculating?.["Internet Computer"]?.current).toBeCloseTo(589_146.951629, 6);
    expect(result?.chainCirculating?.Base?.current).toBeCloseTo(5_345.40392636, 6);
    expect(result?.chainCirculating?.Ethereum?.current).toBeCloseTo(7.64444464, 6);
    expect(result?.chainCirculating?.Arbitrum?.current).toBe(0);
    expect(fetchIcrcLedgerTotalSupplyMock.mock.calls[0]?.[0]).toMatchObject({
      canisterId: "6c7su-kiaaa-aaaar-qaira-cai",
    });
  });

  it("sums mRe7YIELD's Starknet leg into the aggregate denominator", async () => {
    probeTrackedTokenSupplyMock.mockImplementation(async (_meta, input) => {
      if (input?.chain === "ethereum") return 6_792_507n * 10n ** 18n;
      if (input?.chain === "etherlink") return 1_041_331n * 10n ** 18n;
      return null;
    });
    fetchStarknetTotalSupplyMock.mockResolvedValue(175_676n * 10n ** 18n);

    const result = await fetchCuratedAggregateOnChainMcap(makeMre7yieldMeta(), 1);

    expect(result?.mcap).toBe(8_009_514);
    expect(result?.chainCirculating?.Starknet?.current).toBe(175_676);
    expect(fetchStarknetTotalSupplyMock.mock.calls[0]?.[0]).toMatchObject({
      contract: "0x04be8945e61dc3e19ebadd1579a6bd53b262f51ba89e6f8b0c4bc9a7e3c633fc",
    });
  });

  it("fails mRe7YIELD closed when the Starknet leg cannot be read", async () => {
    probeTrackedTokenSupplyMock.mockImplementation(async (_meta, input) =>
      input?.chain === "ethereum" ? 6_792_507n * 10n ** 18n : 1_041_331n * 10n ** 18n,
    );
    fetchStarknetTotalSupplyMock.mockRejectedValue(new Error("starknet_call failed"));

    await expect(fetchCuratedAggregateOnChainMcap(makeMre7yieldMeta(), 1)).resolves.toBeNull();
  });
});
