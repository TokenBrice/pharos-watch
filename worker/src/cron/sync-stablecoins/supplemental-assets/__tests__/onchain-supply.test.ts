import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { StablecoinMeta } from "@shared/types/core";
import { isFixedDecimalDeployment } from "@shared/lib/deployment-amounts";
import { buildChainRpcs, type ChainRpcConfig } from "../../../../lib/chain-registry";

const fetchEearnSuiSupplyMock = vi.hoisted(() => vi.fn());
vi.mock("../sui-vault-supply", () => ({ fetchEearnSuiSupply: fetchEearnSuiSupplyMock }));
const fetchErc20TotalSupplyMock = vi.fn();
const probeTrackedTokenSupplyMock = vi.fn();
const fetchOnchainUint256Mock = vi.fn();
const fetchSolanaTokenSupplyMock = vi.fn();
const fetchStarknetTotalSupplyMock = vi.fn();
const fetchIcrcLedgerTotalSupplyMock = vi.fn();
const fetchMoveFungibleAssetSupplyMock = vi.fn();

vi.mock("../../../reserve-adapters/helpers", () => ({
  fetchErc20TotalSupply: (...args: unknown[]) => fetchErc20TotalSupplyMock(...args),
  fetchOnchainUint256: (...args: unknown[]) => fetchOnchainUint256Mock(...args),
  fetchSolanaTokenSupply: (...args: unknown[]) => fetchSolanaTokenSupplyMock(...args),
  fetchStarknetTotalSupply: (...args: unknown[]) => fetchStarknetTotalSupplyMock(...args),
  fetchIcrcLedgerTotalSupply: (...args: unknown[]) => fetchIcrcLedgerTotalSupplyMock(...args),
  fetchMoveFungibleAssetSupply: (...args: unknown[]) => fetchMoveFungibleAssetSupplyMock(...args),
  probeTrackedTokenSupply: (...args: unknown[]) => probeTrackedTokenSupplyMock(...args),
}));

import { fetchCuratedAggregateOnChainMcap, fetchOnChainMcap } from "../onchain-supply";

function makeMeta(
  input: Pick<StablecoinMeta, "id" | "name" | "symbol" | "contracts"> & {
    detailProvider?: StablecoinMeta["detailProvider"];
    flags?: Partial<StablecoinMeta["flags"]>;
  },
): StablecoinMeta {
  return {
    detailProvider: "coingecko",
    ...input,
    flags: {
      pegCurrency: "USD", backing: "rwa-backed", governance: "centralized-dependent",
      ...input.flags,
    },
  } as StablecoinMeta;
}

function makeMovementMeta(): StablecoinMeta {
  return makeMeta({
    id: "usdcx-movement",
    name: "Movement USDCx",
    symbol: "USDCx",
    contracts: [{
      chain: "movement",
      address: "0xba11833544a2f99eec743f41a228ca6ffa7f13c3b6b04681d5a79a8b75ff225e",
      decimals: 6,
    }],
  });
}

function movementChainRpcs(): Map<string, ChainRpcConfig> {
  return new Map<string, ChainRpcConfig>([
    ["movement", { chainId: "movement", chainName: "Movement", type: "other", endpoints: [{ url: "https://mainnet.movementnetwork.xyz/v1", operator: "public", keyed: false, position: "registry", stateHistory: "archive", logsHistory: "full" }], explorerUrl: "https://explorer.movementnetwork.xyz" }],
    ["ethereum", { chainId: "ethereum", chainName: "Ethereum", type: "evm", endpoints: [{ url: "https://ethereum-rpc.publicnode.com", operator: "public", keyed: false, position: "registry", stateHistory: "archive", logsHistory: "full" }], explorerUrl: "https://etherscan.io" }],
  ]);
}

function makeSkyMeta(): StablecoinMeta {
  return makeMeta({
    id: "susds-sky",
    name: "Savings USDS",
    symbol: "sUSDS",
    contracts: [
      { chain: "ethereum", address: "0x0000000000000000000000000000000000000001", decimals: 18 },
      { chain: "base", address: "0x0000000000000000000000000000000000000002", decimals: 18 },
      { chain: "optimism", address: "0x0000000000000000000000000000000000000003", decimals: 18 },
      { chain: "arbitrum", address: "0x0000000000000000000000000000000000000004", decimals: 18 },
    ],
    flags: {
      backing: "crypto-backed",
      yieldBearing: true,
      navToken: true,
    },
  });
}

function makeChfauMeta(): StablecoinMeta {
  return makeMeta({
    id: "chfau-allunity",
    name: "AllUnity CHF",
    symbol: "CHFAU",
    contracts: [
      { chain: "ethereum", address: "0xbd4dfc058eb95b8de5ceaf39966a1a70f5556f78", decimals: 6 },
      { chain: "polygon", address: "0xbd4dfc058eb95b8de5ceaf39966a1a70f5556f78", decimals: 6 },
      { chain: "base", address: "0xbd4dfc058eb95b8de5ceaf39966a1a70f5556f78", decimals: 6 },
      { chain: "tempo", address: "0x20c00000000000000000000042109aef2f8b28e1", decimals: 6 },
    ],
    flags: {
      pegCurrency: "CHF",
      governance: "centralized",
      yieldBearing: false,
      navToken: false,
    },
  });
}

const SUSDE_OFT = "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2";
const SUSDE_REPRESENTATION_CHAINS = [
  "plasma", "linea", "fraxtal", "hyperevm", "berachain", "zircuit", "metis", "xlayer",
  "base", "bsc", "morph-l2", "scroll", "kava", "swellchain", "mode", "mantle",
  "arbitrum", "manta", "blast", "optimism", "zksync", "avalanche", "solana",
];

function makeSusdeMeta(): StablecoinMeta {
  return makeMeta({
    id: "susde-ethena",
    name: "Staked USDe",
    symbol: "sUSDe",
    contracts: [
      { chain: "ethereum", address: "0x9d39a5de30e57443bff2a8307a4256c8797a3497", decimals: 18 },
      ...SUSDE_REPRESENTATION_CHAINS.map((chain) => ({ chain, address: SUSDE_OFT, decimals: 18 })),
    ],
    flags: {
      backing: "crypto-backed",
      yieldBearing: true,
      navToken: true,
    },
  });
}

function makeAcrdxMeta(): StablecoinMeta {
  const share = "0x9477724bb54ad5417de8baff29e59df3fb4da74f";
  const spoke = "0x2fabf1c784b8583d63c00c5c9c0377d8cf1a3245";
  return makeMeta({
    id: "acrdx-anemoy-apollo",
    name: "Anemoy Apollo",
    symbol: "ACRDX",
    contracts: [
      { chain: "ethereum", address: share, decimals: 18 },
      { chain: "plume", address: share, decimals: 18 },
      { chain: "monad", address: spoke, decimals: 18 },
      { chain: "base", address: share, decimals: 18 },
      { chain: "optimism", address: spoke, decimals: 18 },
      { chain: "solana", address: "ACDR3LGFrMuDZSDRyJjncFCzo5c8xkQxhWx4im4Vmq8G", decimals: 6 },
    ],
    flags: {
      governance: "centralized",
      yieldBearing: true,
      navToken: true,
    },
  });
}

function makeGldtMeta(): StablecoinMeta {
  const evm = "0x86856814e74456893cfc8946bedcbb472b5fa856";
  return makeMeta({
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
      yieldBearing: false,
      navToken: false,
    },
  });
}

function makeMre7yieldMeta(): StablecoinMeta {
  return makeMeta({
    id: "mre7yield-midas",
    name: "Midas Re7 Yield",
    symbol: "mRe7YIELD",
    contracts: [
      { chain: "ethereum", address: "0x87c9053c819bb28e0d73d33059e1b3da80afb0cf", decimals: 18 },
      { chain: "tac", address: "0x0a72ed3c34352ab2dd912b30f2252638c873d6f0", decimals: 18 },
      { chain: "etherlink", address: "0x733d504435a49fc8c4e9759e756c2846c92f0160", decimals: 18 },
      {
        chain: "starknet",
        address: "0x04be8945e61dc3e19ebadd1579a6bd53b262f51ba89e6f8b0c4bc9a7e3c633fc",
        decimals: 18,
      },
    ],
    flags: {
      governance: "centralized",
      yieldBearing: true,
      navToken: true,
    },
  });
}

function makeSingleContractMeta(): StablecoinMeta {
  return makeMeta({
    id: "susdc-spark",
    name: "Spark Savings USDC",
    symbol: "sUSDC",
    contracts: [
      { chain: "ethereum", address: "0x0000000000000000000000000000000000000009", decimals: 18 },
    ],
    flags: {
      backing: "crypto-backed",
      yieldBearing: true,
      navToken: true,
    },
  });
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

  it.each([
    { chain: "ethereum", decimals: null },
    { chain: "xrpl", decimals: null, amountEncoding: { kind: "xrpl-issued-currency" as const } },
    { chain: "xrpl", decimals: 6 },
    { chain: "ethereum", decimals: 6, amountEncoding: { kind: "xrpl-issued-currency" as const } },
  ])("skips deployments without fixed-decimal amounts: %j", async (deployment) => {
    const source = makeSingleContractMeta();
    const meta = {
      ...source,
      contracts: [{ ...source.contracts![0], ...deployment }],
    };

    await expect(fetchOnChainMcap(meta, 1)).resolves.toBeNull();
    expect(probeTrackedTokenSupplyMock).not.toHaveBeenCalled();
    expect(fetchErc20TotalSupplyMock).not.toHaveBeenCalled();
  });
});

describe("fetchCuratedAggregateOnChainMcap", () => {
  it("admits Movement USDCx only when its pinned-ledger supply reconciles to xReserve", async () => {
    fetchMoveFungibleAssetSupplyMock.mockResolvedValue({
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
    fetchMoveFungibleAssetSupplyMock.mockResolvedValue({
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
    fetchMoveFungibleAssetSupplyMock.mockResolvedValue(null);

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
    fetchMoveFungibleAssetSupplyMock.mockReset();
  });

  it("reallocates canonical lock/mint supply without double counting representations", async () => {
    probeTrackedTokenSupplyMock.mockImplementation(async (_meta, input) => {
      if (input?.chain === "ethereum") return 1_000n * 10n ** 18n;
      if (input?.chain === "base") return 100n * 10n ** 18n;
      if (input?.chain === "optimism") return 50n * 10n ** 18n;
      if (input?.chain === "arbitrum") return 25n * 10n ** 18n;
      return 0n;
    });

    const observedBefore = Math.floor(Date.now() / 1000);
    const result = await fetchCuratedAggregateOnChainMcap(makeSkyMeta(), 1);
    const observedAfter = Math.floor(Date.now() / 1000);

    expect(result).toMatchObject({
      mcap: 1_000,
      supplySource: "onchain-total-supply",
      chainCirculating: {
        Ethereum: { current: 825, chainId: "ethereum" },
        Base: { current: 100, chainId: "base" },
        Optimism: { current: 50, chainId: "optimism" },
        Arbitrum: { current: 25, chainId: "arbitrum" },
      },
    });
    expect(result?.observedAt).toBeGreaterThanOrEqual(observedBefore);
    expect(result?.observedAt).toBeLessThanOrEqual(observedAfter);
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

  it("conserves savUSD canonical supply with unprobed CCIP destinations and rejects insufficient escrow", async () => {
    const meta = TRACKED_META_BY_ID.get("savusd-avant")!;
    probeTrackedTokenSupplyMock.mockImplementation(async (_meta, input) =>
      input.chain === "avalanche" ? 1_000n * 10n ** 18n : 10n * 10n ** 18n,
    );
    fetchErc20TotalSupplyMock.mockResolvedValue(10n * 10n ** 18n);
    fetchOnchainUint256Mock.mockResolvedValue(300n * 10n ** 18n);
    const result = await fetchCuratedAggregateOnChainMcap(meta, 1);
    expect(result?.mcap).toBe(1_000);
    expect(result?.chainCirculating?.Avalanche?.current).toBe(700);
    expect(result?.chainCirculating?.["savUSD unattributed CCIP escrow"]?.current).toBe(210);
    expect(Object.values(result!.chainCirculating!).reduce((sum, row) => sum + row.current, 0)).toBe(1_000);
    fetchOnchainUint256Mock.mockResolvedValue(80n * 10n ** 18n);
    await expect(fetchCuratedAggregateOnChainMcap(meta, 1)).resolves.toBeNull();
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
      if (input?.chain === "tac") return 630_603n * 10n ** 18n;
      return null;
    });
    fetchStarknetTotalSupplyMock.mockResolvedValue(175_676n * 10n ** 18n);

    const result = await fetchCuratedAggregateOnChainMcap(makeMre7yieldMeta(), 1);

    expect(result?.mcap).toBe(8_640_117);
    expect(result?.chainCirculating?.TAC?.current).toBe(630_603);
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

  it("reads hbUSDT's HyperEVM-only supply through its reviewed pin when the Worker registry has no HyperEVM RPC", async () => {
    // Production-shaped registry: HyperEVM is pin-only, so its Dwellir endpoint is supplemental.
    const chainRpcs = buildChainRpcs(undefined, undefined, { dwellirApiKey: "dwellir-test" });
    // A supply read with no resolvable RPC URL yields null, as evm-rpc does. Only the reviewed
    // HyperEVM pin answers, so an unreviewed endpoint cannot satisfy this test.
    probeTrackedTokenSupplyMock.mockImplementation(
      async (_meta, _input, _signal, _adapter, _ctx, rpcUrl) =>
        rpcUrl === "https://rpc.hyperliquid.xyz/evm" ? 3_204_481n * 10n ** 18n : null,
    );

    const result = await fetchCuratedAggregateOnChainMcap(TRACKED_META_BY_ID.get("hbusdt-hyperbeat")!, 1.13, chainRpcs);

    expect(result).toMatchObject({
      supplySource: "onchain-total-supply",
      chainCirculating: { HyperEVM: { chainId: "hyperevm" } },
    });
    expect(result?.mcap).toBeCloseTo(3_621_063.53, 2);
  });
});


describe("curation-expanded complete supply rosters", () => {
  const cases: { id: string; canonical?: string; supplies: Record<string, number> }[] = [
    {
      id: "susdt-spark",
      canonical: undefined,
      supplies: { ethereum: 100, arbitrum: 10, xlayer: 20 },
    },
    {
      id: "syrupusdc-maple",
      canonical: "ethereum",
      supplies: { ethereum: 100, base: 10, arbitrum: 10, solana: 10, ink: 10, monad: 10, robinhood: 10, tempo: 10, arc: 10 },
    },
    {
      id: "syzusd-yuzu",
      canonical: "plasma",
      supplies: { plasma: 100, ethereum: 10, monad: 10, hyperevm: 10, sei: 10, pharos: 10, berachain: 10, aptos: 0.25 },
    },
  ];

  beforeEach(() => {
    fetchErc20TotalSupplyMock.mockReset();
    probeTrackedTokenSupplyMock.mockReset();
    fetchSolanaTokenSupplyMock.mockReset();
    fetchMoveFungibleAssetSupplyMock.mockReset();
    fetchOnchainUint256Mock.mockReset();
  });

  function installSupplyReads(meta: StablecoinMeta, supplies: Record<string, number>, unreadable?: string) {
    const raw = (chain: string) => {
      if (chain === unreadable) return null;
      const contract = meta.contracts?.find((contract) => contract.chain === chain);
      if (!contract || !isFixedDecimalDeployment(contract)) {
        throw new Error(`Supply fixture requires fixed decimals for ${chain}`);
      }
      return BigInt(supplies[chain] * 10 ** contract.decimals);
    };
    probeTrackedTokenSupplyMock.mockImplementation(async (_meta, input) =>
      raw(input.kind === "onchain-solana" ? "solana" : input.chain),
    );
    fetchErc20TotalSupplyMock.mockImplementation(async (input) => raw(input.chain));
    fetchSolanaTokenSupplyMock.mockImplementation(async () => raw("solana"));
    fetchMoveFungibleAssetSupplyMock.mockImplementation(async () => {
      const rawSupply = raw("aptos");
      return rawSupply == null ? null : { rawSupply, decimals: 6, ledgerVersion: "7439737313" };
    });
  }

  it.each(cases)("publishes $id's complete partition without double-counting representations", async ({ id, canonical, supplies }) => {
    const meta = TRACKED_META_BY_ID.get(id)!;
    installSupplyReads(meta, supplies);
    const price = 1.25;
    const result = await fetchCuratedAggregateOnChainMcap(meta, price, buildChainRpcs());
    const total = canonical ? supplies[canonical] : Object.values(supplies).reduce((sum, value) => sum + value, 0);
    const representations = Object.entries(supplies).reduce((sum, [chain, units]) => chain === canonical ? sum : sum + units, 0);
    expect(result?.mcap).toBe(total * price);
    expect(Object.fromEntries(Object.values(result!.chainCirculating!).map((row) => [row.chainId, row.current]))).toEqual(
      Object.fromEntries(Object.entries(supplies).map(([chain, units]) => [
        chain, (chain === canonical ? total - representations : units) * price,
      ])),
    );
    expect(Object.values(result!.chainCirculating!).reduce((sum, row) => sum + row.current, 0)).toBe(total * price);
    // Aptos must not be sent through Movement's asset-restricted xReserve gate.
    expect(fetchOnchainUint256Mock).not.toHaveBeenCalled();
  });

  it.each(cases.flatMap(({ id, supplies }) => Object.keys(supplies).map((unreadable) => ({ id, supplies, unreadable }))))(
    "fails $id closed when $unreadable cannot be read",
    async ({ id, supplies, unreadable }) => {
      const meta = TRACKED_META_BY_ID.get(id)!;
      installSupplyReads(meta, supplies, unreadable);
      await expect(fetchCuratedAggregateOnChainMcap(meta, 1.25, buildChainRpcs())).resolves.toBeNull();
    },
  );

  it.each(["decimals", "exception"])("fails syzUSD closed on Aptos %s failure", async (failure) => {
    const meta = TRACKED_META_BY_ID.get("syzusd-yuzu")!;
    installSupplyReads(meta, cases[2].supplies);
    if (failure === "decimals") {
      fetchMoveFungibleAssetSupplyMock.mockResolvedValue({ rawSupply: 250_000n, decimals: 8, ledgerVersion: "7439737313" });
    } else {
      fetchMoveFungibleAssetSupplyMock.mockRejectedValue(new Error("Aptos REST unavailable"));
    }
    await expect(fetchCuratedAggregateOnChainMcap(meta, 1.25, buildChainRpcs())).resolves.toBeNull();
  });
});

describe("eEARN complete native aggregate", () => {
  it.each([true, false])("requires both native legs (Sui available=%s)", async (available) => {
    const meta = TRACKED_META_BY_ID.get("eearn-ember")!;
    probeTrackedTokenSupplyMock.mockResolvedValue(3_000_000_000_000n);
    if (available) fetchEearnSuiSupplyMock.mockResolvedValue(7_000_000_000_000n);
    else fetchEearnSuiSupplyMock.mockRejectedValue(new Error("unavailable"));
    const result = await fetchCuratedAggregateOnChainMcap(meta, 1.04);
    if (available) {
      expect(result?.mcap).toBe(10_400_000);
      expect(result?.chainCirculating?.Sui.current).toBe(7_280_000);
    } else expect(result).toBeNull();
  });
});

describe("discovery native supply aggregates", () => {
  const cases = [
    {
      id: "uscc-superstate",
      contracts: [
        { chain: "ethereum", address: "0x14d60e7fdc0d71d8611742720e4c50e7a974020c", decimals: 6 },
        { chain: "plume", address: "0x4c21b7577c8fe8b0b0669165ee7c8f67fa1454cf", decimals: 6 },
        { chain: "solana", address: "BTRR3sj1Bn2ZjuemgbeQ6SCtf84iXS81CS7UDTSxUCaK", decimals: 6 },
      ],
      supplies: [9_102_522_978_447n, 1_441_528_020_930n, 708_371_216_894n],
      units: 11_252_422.216271,
    },
    {
      id: "pyusdx-moonpay",
      contracts: ["ethereum", "arbitrum", "monad", "base"].map((chain) => ({
        chain, address: "0xebdb0942ce16386ab90718c7bd10c91cdb66b14d", decimals: 6,
      })),
      supplies: [91_882_981_224_535n, 443_583_150_573n, 1_000_000n, 100_000n],
      units: 92_326_565.475108,
    },
  ];

  beforeEach(() => {
    probeTrackedTokenSupplyMock.mockReset();
    fetchErc20TotalSupplyMock.mockReset();
    fetchSolanaTokenSupplyMock.mockReset();
  });

  function installReads(contracts: NonNullable<StablecoinMeta["contracts"]>, supplies: (bigint | null)[]): void {
    const read = (chain: string) => chain === "0g" ? 0n : supplies[contracts.findIndex((contract) => contract.chain === chain)] ?? null;
    probeTrackedTokenSupplyMock.mockImplementation(async (_meta, input) => read(input.chain));
    fetchErc20TotalSupplyMock.mockImplementation(async (input) => read(input.chain));
    fetchSolanaTokenSupplyMock.mockImplementation(async () => read("solana"));
  }

  it.each(cases)("values the complete $id native stock without canonical reallocation", async ({ id, contracts, supplies, units }) => {
    installReads(contracts, supplies);
    const result = await fetchCuratedAggregateOnChainMcap(makeMeta({ id, name: id, symbol: id, contracts }), 1.25);
    expect(result?.mcap).toBeCloseTo(units * 1.25, 6);
    for (const [index, contract] of contracts.entries()) {
      const chain = Object.values(result?.chainCirculating ?? {}).find((row) => row.chainId === contract.chain);
      expect(chain?.current).toBeCloseTo(Number(supplies[index]) / 10 ** contract.decimals! * 1.25, 6);
    }
  });

  it.each(cases)("rejects $id if any native leg is unreadable", async ({ id, contracts, supplies }) => {
    for (const missingIndex of supplies.keys()) {
      installReads(contracts, supplies.map((supply, index) => index === missingIndex ? null : supply));
      await expect(fetchCuratedAggregateOnChainMcap(
        makeMeta({ id, name: id, symbol: id, contracts }), 1.25,
      )).resolves.toBeNull();
    }
  });

  it.each([
    { raw: 0n, reason: null },
    { raw: 1n, reason: "zero-supply-guard-positive" },
    { raw: null, reason: "zero-supply-guard-unavailable" },
    { raw: new Error("RPC unavailable"), reason: "zero-supply-guard-unavailable" },
  ])("publishes PYUSDx only after a same-run 0G zero read ($raw)", async ({ raw, reason }) => {
    const { id, contracts, supplies, units } = cases[1];
    installReads(contracts, supplies);
    const nativeRead = fetchErc20TotalSupplyMock.getMockImplementation()!;
    fetchErc20TotalSupplyMock.mockImplementation(async (input, ...args) => {
      if (input.chain !== "0g") return nativeRead(input, ...args);
      if (raw instanceof Error) throw raw;
      return raw;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const meta = makeMeta({ id, name: id, symbol: id, contracts });
      const result = await fetchCuratedAggregateOnChainMcap(meta, 1.25, buildChainRpcs());
      if (reason === null) {
        expect(result?.mcap).toBeCloseTo(units * 1.25, 6);
        expect(Object.values(result?.chainCirculating ?? {}).reduce((sum, row) => sum + row.current, 0))
          .toBeCloseTo(units * 1.25, 6);
      } else {
        expect(result).toBeNull();
        const events = warn.mock.calls.map(([line]) => JSON.parse(String(line)));
        expect(events).toContainEqual(expect.objectContaining({
          event: "onchain-supply-aggregate-withheld",
          metadata: expect.objectContaining({ stablecoinId: id, chain: "0g", reason }),
        }));
      }
      expect(fetchErc20TotalSupplyMock.mock.calls.filter(([input]) => input.chain === "0g")).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});
