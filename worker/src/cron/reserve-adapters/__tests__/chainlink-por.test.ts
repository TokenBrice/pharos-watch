import { beforeEach, describe, it, expect, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  const { makeOnchainCallersMock, makeOnchainMulticall3Mock } = await import("./helpers/onchain-callers-mock");
  const fetchOnchainUint256 = vi.fn();
  const fetchOnchainRawCall = vi.fn();
  const fetchOnchainMulticall3 = makeOnchainMulticall3Mock({
    uint256: fetchOnchainUint256,
    raw: fetchOnchainRawCall,
  });
  return {
    ...actual,
    fetchErc20TotalSupply: vi.fn(),
    fetchTronErc20TotalSupply: vi.fn(),
    fetchJsonPostWithRetry: vi.fn(),
    fetchOnchainMulticall3,
    fetchOnchainUint256,
    fetchOnchainRawCall,
    makeOnchainCallers: makeOnchainCallersMock({
      uint256: fetchOnchainUint256,
      raw: fetchOnchainRawCall,
    }),
  };
});

import {
  adaptBackedCirculationResponse,
  adaptChainlinkPorResponse,
  fetchChainlinkPorReserves,
  type ChainlinkPorIssuerCirculationProbe,
  type ChainlinkPorParams,
} from "../chainlink-por";
import {
  fetchErc20TotalSupply,
  fetchJsonPostWithRetry,
  fetchOnchainMulticall3,
  fetchOnchainRawCall,
  fetchOnchainUint256,
  fetchTronErc20TotalSupply,
} from "../helpers";

import { TEST_SIGNAL as signal } from "./reserve-adapter.test-support";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("adaptChainlinkPorResponse", () => {
  const params: ChainlinkPorParams = {
    porFeedAddress: "0xBE456fd14720C3aCCc30A2013Bffd782c9Cb75D5",
    assetLabel: "USD Cash Reserves",
    assetRisk: "very-low",
  };

  it("returns single 100% slice with configured label and risk", () => {
    const result = adaptChainlinkPorResponse(
      { reserves: 145_000_000_000n, decimals: 8, roundId: 42n, updatedAt: 1710000000 },
      params,
    );
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0]).toEqual({
      name: "USD Cash Reserves",
      pct: 100,
      risk: "very-low",
    });
  });

  it("includes metadata with reserves and feed info", () => {
    const result = adaptChainlinkPorResponse(
      { reserves: 145_000_000_000n, decimals: 8, roundId: 42n, updatedAt: 1710000000 },
      params,
      {
        contributions: [
          {
            chain: "ethereum",
            tokenAddress: "0x0000000000000000000000000000000000000001",
            raw: 144_000_000_000_000_000_000_000_000n,
            decimals: 18,
          },
        ],
        omittedNonEvmChains: [],
        omittedReadFailureChains: [],
      },
    );
    expect(result.metadata?.totalReservesRaw).toBe("145000000000");
    expect(result.metadata?.feedDecimals).toBe(8);
    expect(result.metadata?.feedRoundId).toBe("42");
    expect(result.metadata?.feedUpdatedAt).toBe(1710000000);
    expect(result.metadata).toMatchObject({
      totalReserveUsd: 1450,
      supplyUsd: 144_000_000,
      supplyReadComplete: true,
    });
  });

  it.each([
    ["XAU", "troy ounces of gold"],
    ["XAG", "troy ounces of silver"],
  ] as const)("labels %s reserves as commodity quantities instead of USD", (reserveUnit, reserveUnitLabel) => {
    const result = adaptChainlinkPorResponse(
      { reserves: 145_000_000_000n, decimals: 8, roundId: 42n, updatedAt: 1710000000 },
      { ...params, reserveUnit },
    );

    expect(result.metadata).toMatchObject({
      reserveUnit,
      reserveUnitLabel,
      totalReserveQuantity: 1450,
      totalReservesRaw: "145000000000",
      feedDecimals: 8,
      feedRoundId: "42",
      feedUpdatedAt: 1710000000,
    });
    expect(result.metadata?.totalReserveUsd).toBeUndefined();
  });

  it("does not emit USD supply or collateralization ratio for commodity reserves", () => {
    const result = adaptChainlinkPorResponse(
      { reserves: 99_000_000_000n, decimals: 8, roundId: 42n, updatedAt: 1710000000 },
      { ...params, reserveUnit: "XAU" },
      {
        contributions: [
          {
            chain: "ethereum",
            tokenAddress: "0x0000000000000000000000000000000000000001",
            raw: 1000_000000000000000000n,
            decimals: 18,
          },
        ],
        omittedNonEvmChains: [],
        omittedReadFailureChains: [],
      },
    );

    expect(result.metadata).toMatchObject({
      reserveUnit: "XAU",
      totalReserveQuantity: 990,
    });
    expect(result.metadata?.totalReserveUsd).toBeUndefined();
    expect(result.metadata?.supplyUsd).toBeUndefined();
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.warnings?.some((w) => w.code === "por-reserve-under-supply")).not.toBe(true);
    expect(result.warnings?.some((w) => w.code === "por-reserve-over-supply")).not.toBe(true);
  });

  it("degrades when reserves do not cover multichain token supply", () => {
    const result = adaptChainlinkPorResponse(
      { reserves: 99_000_000_000n, decimals: 8, roundId: 42n, updatedAt: 1710000000 },
      params,
      {
        contributions: [
          {
            chain: "ethereum",
            tokenAddress: "0x0000000000000000000000000000000000000001",
            raw: 1000_000000000000000000n,
            decimals: 18,
          },
        ],
        omittedNonEvmChains: [],
        omittedReadFailureChains: [],
      },
    );

    expect(result.metadata?.collateralizationRatio).toBe(0.99);
    expect(result.warnings?.some((w) => w.code === "por-reserve-under-supply")).toBe(true);
    expect(result.warnings?.find((w) => w.code === "por-reserve-under-supply")?.effect).toBe("degraded");
  });

  it("emits over-collateralization warning when ratio exceeds 1.1", () => {
    const result = adaptChainlinkPorResponse(
      { reserves: 160_000_000_000n, decimals: 8, roundId: 42n, updatedAt: 1710000000 },
      params,
      {
        contributions: [
          {
            chain: "ethereum",
            tokenAddress: "0x0000000000000000000000000000000000000001",
            raw: 1000_000000000000000000n,
            decimals: 18,
          },
        ],
        omittedNonEvmChains: [],
        omittedReadFailureChains: [],
      },
    );

    // reserves = 1600 USD / supply = 1000 tokens -> ratio = 1.6
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.6, 5);
    expect(result.warnings?.some((w) => w.code === "por-reserve-over-supply")).toBe(true);
    expect(result.warnings?.find((w) => w.code === "por-reserve-over-supply")?.effect).toBe("degraded");
  });

  it("emits info warning when non-EVM chains are omitted from supply aggregation", () => {
    const result = adaptChainlinkPorResponse(
      { reserves: 100_000_000_000n, decimals: 8, roundId: 42n, updatedAt: 1710000000 },
      params,
      {
        contributions: [
          {
            chain: "ethereum",
            tokenAddress: "0x0000000000000000000000000000000000000001",
            raw: 1000_000000000000000000n,
            decimals: 18,
          },
        ],
        omittedNonEvmChains: ["tron"],
        omittedReadFailureChains: [],
      },
    );

    const omitted = result.warnings?.find((w) => w.code === "por-supply-chain-omitted");
    expect(omitted).toBeDefined();
    expect(omitted?.severity).toBe("info");
    expect(omitted?.message).toContain("tron");
  });

  it("degrades and marks supply incomplete when any EVM supply source fails", () => {
    const result = adaptChainlinkPorResponse(
      { reserves: 100_000_000_000n, decimals: 8, roundId: 42n, updatedAt: 1710000000 },
      params,
      {
        contributions: [
          {
            chain: "ethereum",
            tokenAddress: "0x0000000000000000000000000000000000000001",
            raw: 1000_000000000000000000n,
            decimals: 18,
          },
        ],
        omittedNonEvmChains: [],
        omittedReadFailureChains: ["bsc"],
      },
    );

    expect(result.metadata).toMatchObject({
      supplyUsd: 1000,
      supplyReadComplete: false,
      collateralizationRatio: 1,
    });
    const warning = result.warnings?.find((w) => w.code === "partial-supply-read-failure");
    expect(warning).toBeDefined();
    expect(warning?.effect).toBe("degraded");
    expect(warning?.message).toContain("bsc");
  });

  it("throws on zero reserves", () => {
    expect(() =>
      adaptChainlinkPorResponse({ reserves: 0n, decimals: 8, roundId: 1n, updatedAt: 1710000000 }, params),
    ).toThrow();
  });
});

describe("adaptBackedCirculationResponse", () => {
  const probe: ChainlinkPorIssuerCirculationProbe = {
    kind: "backed-graphql",
    url: "https://api.backed.fi/graphql",
    reserveSymbol: "IB01.L",
  };
  const contracts = [
    { chain: "ethereum", address: "0xCA30c93B02514f86d5C86a6e375E3A330B435Fb5", decimals: 18 },
    { chain: "polygon", address: "0xca30c93b02514f86d5c86a6e375e3a330b435fb5", decimals: 18 },
  ];

  function payload(deployments: Array<Record<string, unknown>>) {
    return {
      data: {
        assetReserves: [
          { symbol: "IB01.L", token: [{ symbol: "bIB01", deployments }] },
          { symbol: "OTHER", token: [] },
        ],
      },
    };
  }

  it("sums circulating supply across matched canonical deployments", () => {
    const outcome = adaptBackedCirculationResponse(
      payload([
        { chainId: "1", network: "Ethereum", address: "0xca30c93b02514f86d5c86a6e375e3a330b435fb5", totalSupply: "4.5e+22", circulatingSupply: "6.117e+19" },
        { chainId: "137", network: "Polygon", address: "0xCA30c93B02514f86d5C86a6e375E3A330B435Fb5", totalSupply: "4.4e+21", circulatingSupply: "8.73e+18" },
      ]),
      probe,
      contracts,
    );
    expect(outcome.failure).toBeUndefined();
    expect(outcome.aggregate?.circulatingTokens).toBeCloseTo(61.17 + 8.73, 6);
    expect(outcome.aggregate?.contributions).toHaveLength(2);
  });

  it("skips zero-circulation deployments without requiring a contract match", () => {
    const outcome = adaptBackedCirculationResponse(
      payload([
        { chainId: "1", address: "0xca30c93b02514f86d5c86a6e375e3a330b435fb5", totalSupply: "1e+22", circulatingSupply: "1e+18" },
        { chainId: "8453", network: "Base", address: "0x0000000000000000000000000000000000000009", totalSupply: "1e+22", circulatingSupply: "0" },
      ]),
      probe,
      contracts,
    );
    expect(outcome.aggregate?.circulatingTokens).toBeCloseTo(1, 6);
  });

  it("fails closed when a nonzero deployment does not match a configured contract", () => {
    const outcome = adaptBackedCirculationResponse(
      payload([
        { chainId: "1", address: "0xca30c93b02514f86d5c86a6e375e3a330b435fb5", totalSupply: "1e+22", circulatingSupply: "1e+18" },
        { chainId: "43114", network: "Avalanche", address: "0x0000000000000000000000000000000000000009", totalSupply: "1e+22", circulatingSupply: "5e+18" },
      ]),
      probe,
      contracts,
    );
    expect(outcome.aggregate).toBeUndefined();
    expect(outcome.failure?.unmatchedDeployments).toEqual([
      { chainId: "43114", network: "Avalanche", address: "0x0000000000000000000000000000000000000009" },
    ]);
  });

  it("fails closed when a deployment with nonzero total supply has no parseable circulating supply", () => {
    const outcome = adaptBackedCirculationResponse(
      payload([
        { chainId: "1", address: "0xca30c93b02514f86d5c86a6e375e3a330b435fb5", totalSupply: "1e+22", circulatingSupply: null },
      ]),
      probe,
      contracts,
    );
    expect(outcome.failure?.reason).toContain("no parseable circulatingSupply");
  });

  it("fails closed when the reserve symbol row is missing", () => {
    const outcome = adaptBackedCirculationResponse({ data: { assetReserves: [] } }, probe, contracts);
    expect(outcome.failure?.reason).toContain("IB01.L");
  });
});

describe("adaptChainlinkPorResponse with issuer circulation", () => {
  const params: ChainlinkPorParams = {
    porFeedAddress: "0xad4395fc414fc1575a7a38c20b0bfdbdb09ee41a",
    assetLabel: "iShares IB01 shares",
    assetRisk: "very-low",
    reserveUnit: "SHARES",
    issuerCirculationProbe: {
      kind: "backed-graphql",
      url: "https://api.backed.fi/graphql",
      reserveSymbol: "IB01.L",
    },
  };
  const grossSupply = {
    contributions: [
      {
        chain: "ethereum",
        tokenAddress: "0x0000000000000000000000000000000000000001",
        raw: 155_000_000000000000000000n,
        decimals: 18,
      },
    ],
    omittedNonEvmChains: [],
    omittedReadFailureChains: [],
  };

  it("compares reserves against issuer circulation and keeps the surplus informational", () => {
    // Backed-style: 1,018 reserve shares, 155k gross pre-minted, 80 circulating.
    const result = adaptChainlinkPorResponse(
      { reserves: 1018_00000000n, decimals: 8, roundId: 7n, updatedAt: 1710000000 },
      params,
      grossSupply,
      { aggregate: { circulatingTokens: 80, contributions: [] } },
    );

    expect(result.metadata).toMatchObject({
      liabilityBasis: "issuer-circulating",
      circulatingSupplyTokens: 80,
      supplyTokens: 155_000,
      reserveUnit: "SHARES",
      reserveUnitLabel: "underlying fund shares",
      totalReserveQuantity: 1018,
    });
    expect(result.metadata?.supplyUsd).toBeUndefined();
    expect(result.metadata?.totalReserveUsd).toBeUndefined();
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1018 / 80, 5);
    expect(result.warnings?.some((w) => w.code === "por-reserve-under-supply")).not.toBe(true);
    const over = result.warnings?.find((w) => w.code === "por-reserve-over-supply");
    expect(over?.effect).toBe("info");
    expect(over?.message).toContain("issuer-held inventory");
  });

  it("degrades when reserves undercover issuer circulation", () => {
    const result = adaptChainlinkPorResponse(
      { reserves: 70_00000000n, decimals: 8, roundId: 7n, updatedAt: 1710000000 },
      params,
      grossSupply,
      { aggregate: { circulatingTokens: 80, contributions: [] } },
    );

    const under = result.warnings?.find((w) => w.code === "por-reserve-under-supply");
    expect(under?.effect).toBe("degraded");
    expect(under?.message).toContain("issuer-reported circulating supply");
  });

  it("fails closed with a degraded warning and no coverage ratio when the probe fails", () => {
    const result = adaptChainlinkPorResponse(
      { reserves: 1018_00000000n, decimals: 8, roundId: 7n, updatedAt: 1710000000 },
      params,
      grossSupply,
      { failure: { reason: "HTTP 503 for POST https://api.backed.fi/graphql" } },
    );

    // Gross supply is proven non-authoritative for probe-configured coins, so
    // an outage must not publish any coverage verdict on the gross basis.
    expect(result.metadata?.liabilityBasis).toBeUndefined();
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.supplyTokens).toBe(155_000);
    expect(result.metadata).toMatchObject({
      circulationProbeFailure: { reason: "HTTP 503 for POST https://api.backed.fi/graphql" },
    });
    expect(result.warnings?.find((w) => w.code === "por-circulation-probe-failed")?.effect).toBe("degraded");
    expect(result.warnings?.some((w) => w.code === "por-reserve-under-supply")).not.toBe(true);
    expect(result.warnings?.some((w) => w.code === "por-reserve-over-supply")).not.toBe(true);
  });

  it("withholds the coverage verdict when circulation exceeds the on-chain supply envelope", () => {
    const result = adaptChainlinkPorResponse(
      { reserves: 1018_00000000n, decimals: 8, roundId: 7n, updatedAt: 1710000000 },
      params,
      grossSupply,
      { aggregate: { circulatingTokens: 200_000, contributions: [] } },
    );

    expect(result.metadata?.liabilityBasis).toBeUndefined();
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.warnings?.find((w) => w.code === "por-circulation-implausible")?.effect).toBe("degraded");
    expect(result.warnings?.some((w) => w.code === "por-reserve-under-supply")).not.toBe(true);
  });
});

describe("fetchChainlinkPorReserves", () => {
  const baseParams = {
    porFeedAddress: "0xBE456fd14720C3aCCc30A2013Bffd782c9Cb75D5",
    assetLabel: "USD Cash Reserves",
    assetRisk: "very-low" as const,
  };

  const config: LiveReservesConfig = {
    adapter: "chainlink-por",
    version: 1,
    semantics: "collateral-mix",
    inputs: {
      primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
    },
    params: baseParams,
  };

  // Encodes latestRoundData() result: roundId=42, answer=200e8, startedAt=0, updatedAt, answeredInRound=42
  function encodeLatestRoundData(answer: bigint, updatedAt: number): string {
    const word = (value: bigint) => value.toString(16).padStart(64, "0");
    return `0x${word(42n)}${word(answer)}${word(0n)}${word(BigInt(updatedAt))}${word(42n)}`;
  }

  it("sums totalSupply across all configured EVM chains plus Tron for the ratio denominator", async () => {
    // TUSD-style: ethereum + tron + avalanche + bsc + solana (solana is the only
    // chain still unreadable and omitted; tron is now included in the aggregate).
    const coin: StablecoinMeta = {
      id: "tusd-test",
      name: "TUSD Test",
      symbol: "TUSDT",
      flags: {
        backing: "rwa-backed",
        pegCurrency: "USD",
        governance: "centralized",
        yieldBearing: false,
        rwa: false,
        navToken: false,
      },
      contracts: [
        { chain: "ethereum", address: "0x0000000000085d4780b73119b644ae5ecd22b376", decimals: 18 },
        { chain: "tron", address: "TUpMhErZL2fhh4sVNULAbNKLokS4GjC1F4", decimals: 18 },
        { chain: "avalanche", address: "0x1c20e891bab6b1727d14da358fae2984ed9b59eb", decimals: 18 },
        { chain: "bsc", address: "0x40af3827f39d0eacbf4a168f8d4ee67c121d11c9", decimals: 18 },
        { chain: "solana", address: "5Wb2QwGNH5MQdBjrpqSCJk8QgKzhkjaEqE9BUmQqYuTM", decimals: 6 },
      ],
    };

    const now = 1_700_000_000;

    // decimals() returns 8 for the PoR feed
    vi.mocked(fetchOnchainUint256).mockResolvedValueOnce(8n);
    // latestRoundData() returns reserves of 1010e8 ($1,010 worth) — this mirrors
    // the production scope-mismatch bug: EVM-only supply (600) would read as
    // 168% over-collateralized, while EVM+Tron supply (1000) reads as ~101%.
    vi.mocked(fetchOnchainRawCall).mockResolvedValueOnce(encodeLatestRoundData(1010_00000000n, now - 60));

    // EVM chains each return 200 tokens (18 decimals) — total 600 tokens supply
    vi.mocked(fetchErc20TotalSupply)
      .mockResolvedValueOnce(200_000000000000000000n) // ethereum
      .mockResolvedValueOnce(200_000000000000000000n) // avalanche
      .mockResolvedValueOnce(200_000000000000000000n); // bsc
    // Tron contributes 400 tokens, bringing multichain supply to 1000
    vi.mocked(fetchTronErc20TotalSupply).mockResolvedValueOnce(400_000000000000000000n);

    const result = await fetchChainlinkPorReserves(coin, config, signal, { nowSec: now });

    expect(fetchOnchainMulticall3).toHaveBeenCalledTimes(1);
    expect(fetchOnchainMulticall3).toHaveBeenCalledWith(expect.objectContaining({
      chain: "ethereum",
      calls: [
        { label: "feed-decimals", contract: baseParams.porFeedAddress, data: "0x313ce567" },
        { label: "feed-latest-round-data", contract: baseParams.porFeedAddress, data: "0xfeaf968c" },
      ],
    }));

    // reserves = $1010, multichain supply (600 EVM + 400 tron) = 1000 -> ratio ~1.01 (healthy)
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.01, 5);
    expect(result.metadata?.supplyUsd).toBeCloseTo(1000, 5);
    expect(result.metadata?.supplyReadComplete).toBe(true);

    // No scope-mismatch warning now that Tron supply is included in the denominator
    expect(result.warnings?.some((w) => w.code === "por-reserve-over-supply")).not.toBe(true);
    expect(result.warnings?.some((w) => w.code === "por-reserve-under-supply")).not.toBe(true);

    // Tron shows up as a real supply contribution, not an omitted chain
    const supplyContributions = result.metadata?.supplyContributions as Array<{ chain: string }> | undefined;
    expect(supplyContributions?.some((c) => c.chain === "tron")).toBe(true);

    // Solana remains the only chain omitted from the aggregate
    const omitted = result.warnings?.find((w) => w.code === "por-supply-chain-omitted");
    expect(omitted).toBeDefined();
    expect(omitted?.message).toContain("solana");
    expect(omitted?.message).not.toContain("tron");

    expect(fetchErc20TotalSupply).toHaveBeenCalledTimes(3);
    expect(fetchTronErc20TotalSupply).toHaveBeenCalledTimes(1);
  });

  it("degrades instead of silently reporting EVM-only coverage when the Tron totalSupply() read fails", async () => {
    const coin: StablecoinMeta = {
      id: "tusd-test",
      name: "TUSD Test",
      symbol: "TUSDT",
      flags: {
        backing: "rwa-backed",
        pegCurrency: "USD",
        governance: "centralized",
        yieldBearing: false,
        rwa: false,
        navToken: false,
      },
      contracts: [
        { chain: "ethereum", address: "0x0000000000085d4780b73119b644ae5ecd22b376", decimals: 18 },
        { chain: "tron", address: "TUpMhErZL2fhh4sVNULAbNKLokS4GjC1F4", decimals: 18 },
        { chain: "avalanche", address: "0x1c20e891bab6b1727d14da358fae2984ed9b59eb", decimals: 18 },
        { chain: "bsc", address: "0x40af3827f39d0eacbf4a168f8d4ee67c121d11c9", decimals: 18 },
      ],
    };

    const now = 1_700_000_000;
    vi.mocked(fetchOnchainUint256).mockResolvedValueOnce(8n);
    // Same $1010 reserves as the happy path above.
    vi.mocked(fetchOnchainRawCall).mockResolvedValueOnce(encodeLatestRoundData(1010_00000000n, now - 60));
    vi.mocked(fetchErc20TotalSupply)
      .mockResolvedValueOnce(200_000000000000000000n)
      .mockResolvedValueOnce(200_000000000000000000n)
      .mockResolvedValueOnce(200_000000000000000000n);
    // Tron read fails (matches fetchErc20TotalSupply's fail-closed null contract).
    vi.mocked(fetchTronErc20TotalSupply).mockResolvedValueOnce(null);

    const result = await fetchChainlinkPorReserves(coin, config, signal, { nowSec: now });

    // Must NOT silently shrink the denominator back to EVM-only and report a
    // healthy-looking ratio as ok — it has to surface as a degraded, incomplete read.
    expect(result.metadata?.supplyReadComplete).toBe(false);
    const warning = result.warnings?.find((w) => w.code === "partial-supply-read-failure");
    expect(warning).toBeDefined();
    expect(warning?.effect).toBe("degraded");
    expect(warning?.message).toContain("tron");

    // Ratio is still computed (over EVM-only supply while Tron is missing), but
    // it rides alongside the degraded warning rather than reporting a clean "ok".
    expect(result.metadata?.supplyUsd).toBeCloseTo(600, 5);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1010 / 600, 5);
  });

  it("does not call the Tron reader or change behavior for coins without a tron contract", async () => {
    const coin: StablecoinMeta = {
      id: "bib01-test",
      name: "BIB01 Test",
      symbol: "BIB01T",
      flags: {
        backing: "rwa-backed",
        pegCurrency: "USD",
        governance: "centralized",
        yieldBearing: false,
        rwa: false,
        navToken: false,
      },
      contracts: [
        { chain: "ethereum", address: "0x0000000000085d4780b73119b644ae5ecd22b376", decimals: 18 },
        { chain: "base", address: "0x1c20e891bab6b1727d14da358fae2984ed9b59eb", decimals: 18 },
      ],
    };

    const now = 1_700_000_000;
    vi.mocked(fetchOnchainUint256).mockResolvedValueOnce(8n);
    vi.mocked(fetchOnchainRawCall).mockResolvedValueOnce(encodeLatestRoundData(300_00000000n, now - 60));
    vi.mocked(fetchErc20TotalSupply)
      .mockResolvedValueOnce(150_000000000000000000n)
      .mockResolvedValueOnce(150_000000000000000000n);

    const result = await fetchChainlinkPorReserves(coin, config, signal, { nowSec: now });

    expect(fetchTronErc20TotalSupply).not.toHaveBeenCalled();
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.0, 5);
    expect(result.warnings?.some((w) => w.code === "por-supply-chain-omitted")).not.toBe(true);
    expect(result.warnings?.some((w) => w.code === "partial-supply-read-failure")).not.toBe(true);
  });

  it("skips a contract supply probe when catalog decimals are missing", async () => {
    const coin: StablecoinMeta = {
      id: "tusd-test",
      name: "TUSD Test",
      symbol: "TUSDT",
      flags: {
        backing: "rwa-backed",
        pegCurrency: "USD",
        governance: "centralized",
        yieldBearing: false,
        rwa: false,
        navToken: false,
      },
      contracts: [
        { chain: "ethereum", address: "0x0000000000085d4780b73119b644ae5ecd22b376" } as unknown as NonNullable<StablecoinMeta["contracts"]>[number],
        { chain: "base", address: "0x1c20e891bab6b1727d14da358fae2984ed9b59eb", decimals: 18 },
      ],
    };

    const now = 1_700_000_000;
    vi.mocked(fetchOnchainUint256).mockResolvedValueOnce(8n);
    vi.mocked(fetchOnchainRawCall).mockResolvedValueOnce(encodeLatestRoundData(300_00000000n, now - 60));
    vi.mocked(fetchErc20TotalSupply).mockResolvedValueOnce(150_000000000000000000n);

    const result = await fetchChainlinkPorReserves(coin, config, signal, { nowSec: now });

    expect(fetchErc20TotalSupply).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchErc20TotalSupply).mock.calls[0]?.[0]).toMatchObject({ chain: "base" });
    expect(result.metadata?.supplyUsd).toBe(150);
    expect(result.warnings?.find((warning) => warning.code === "partial-supply-read-failure")?.message).toContain("ethereum");
  });

  it("throws when all EVM chain supply reads return null", async () => {
    const coin: StablecoinMeta = {
      id: "tusd-test",
      name: "TUSD Test",
      symbol: "TUSDT",
      flags: {
        backing: "rwa-backed",
        pegCurrency: "USD",
        governance: "centralized",
        yieldBearing: false,
        rwa: false,
        navToken: false,
      },
      contracts: [
        { chain: "ethereum", address: "0x0000000000085d4780b73119b644ae5ecd22b376", decimals: 18 },
        { chain: "avalanche", address: "0x1c20e891bab6b1727d14da358fae2984ed9b59eb", decimals: 18 },
      ],
    };

    const now = 1_700_000_000;
    vi.mocked(fetchOnchainUint256).mockResolvedValueOnce(8n);
    vi.mocked(fetchOnchainRawCall).mockResolvedValueOnce(encodeLatestRoundData(100_00000000n, now - 60));
    vi.mocked(fetchErc20TotalSupply).mockResolvedValue(null);

    await expect(fetchChainlinkPorReserves(coin, config, signal, { nowSec: now })).rejects.toThrow(/chainlink-por/);
  });

  it("does not require token contracts when a commodity reserve unit is configured", async () => {
    const coin: StablecoinMeta = {
      id: "kau-kinesis",
      name: "Kinesis Gold",
      symbol: "KAU",
      flags: {
        backing: "rwa-backed",
        pegCurrency: "GOLD",
        governance: "centralized",
        yieldBearing: false,
        rwa: true,
        navToken: false,
      },
    };
    const now = 1_700_000_000;
    vi.mocked(fetchOnchainUint256).mockResolvedValueOnce(18n);
    vi.mocked(fetchOnchainRawCall).mockResolvedValueOnce(encodeLatestRoundData(12_345_000000000000000000n, now - 60));

    const result = await fetchChainlinkPorReserves(
      coin,
      {
        ...config,
        params: {
          ...baseParams,
          assetLabel: "Physical gold bullion",
          reserveUnit: "XAU",
        },
      },
      signal,
      { nowSec: now },
    );

    expect(fetchErc20TotalSupply).not.toHaveBeenCalled();
    expect(result.metadata).toMatchObject({
      reserveUnit: "XAU",
      reserveUnitLabel: "troy ounces of gold",
      totalReserveQuantity: 12_345,
    });
    expect(result.metadata?.supplyUsd).toBeUndefined();
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
  });

  it("omits registry-typed non-EVM chains like NEAR instead of firing EVM reads at them", async () => {
    const coin: StablecoinMeta = {
      id: "tusd-test",
      name: "TUSD Test",
      symbol: "TUSDT",
      flags: {
        backing: "rwa-backed",
        pegCurrency: "USD",
        governance: "centralized",
        yieldBearing: false,
        rwa: false,
        navToken: false,
      },
      contracts: [
        { chain: "ethereum", address: "0x0000000000085d4780b73119b644ae5ecd22b376", decimals: 18 },
        { chain: "near", address: "tusd.near", decimals: 18 },
      ],
    };

    const now = 1_700_000_000;
    vi.mocked(fetchOnchainUint256).mockResolvedValueOnce(8n);
    vi.mocked(fetchOnchainRawCall).mockResolvedValueOnce(encodeLatestRoundData(150_00000000n, now - 60));
    vi.mocked(fetchErc20TotalSupply).mockResolvedValueOnce(150_000000000000000000n);

    const result = await fetchChainlinkPorReserves(coin, config, signal, { nowSec: now });

    expect(fetchErc20TotalSupply).toHaveBeenCalledTimes(1);
    const omitted = result.warnings?.find((w) => w.code === "por-supply-chain-omitted");
    expect(omitted?.severity).toBe("info");
    expect(omitted?.message).toContain("near");
    expect(result.warnings?.some((w) => w.code === "partial-supply-read-failure")).not.toBe(true);
    expect(result.metadata?.supplyReadComplete).toBe(true);
  });

  it("treats a zero totalSupply read as a valid empty deployment, not a read failure", async () => {
    const coin: StablecoinMeta = {
      id: "bib01-test",
      name: "BIB01 Test",
      symbol: "BIB01T",
      flags: {
        backing: "rwa-backed",
        pegCurrency: "USD",
        governance: "centralized",
        yieldBearing: false,
        rwa: false,
        navToken: false,
      },
      contracts: [
        { chain: "ethereum", address: "0x0000000000085d4780b73119b644ae5ecd22b376", decimals: 18 },
        { chain: "bsc", address: "0x40af3827f39d0eacbf4a168f8d4ee67c121d11c9", decimals: 18 },
      ],
    };

    const now = 1_700_000_000;
    vi.mocked(fetchOnchainUint256).mockResolvedValueOnce(8n);
    vi.mocked(fetchOnchainRawCall).mockResolvedValueOnce(encodeLatestRoundData(150_00000000n, now - 60));
    vi.mocked(fetchErc20TotalSupply)
      .mockResolvedValueOnce(150_000000000000000000n) // ethereum
      .mockResolvedValueOnce(0n); // bsc: genuinely zero supply

    const result = await fetchChainlinkPorReserves(coin, config, signal, { nowSec: now });

    expect(result.warnings?.some((w) => w.code === "partial-supply-read-failure")).not.toBe(true);
    expect(result.metadata?.supplyReadComplete).toBe(true);
    expect(result.metadata?.supplyUsd).toBe(150);
  });

  it("wires the issuer circulation probe through the fetch path", async () => {
    const tokenAddress = "0xca30c93b02514f86d5c86a6e375e3a330b435fb5";
    const coin: StablecoinMeta = {
      id: "bib01-test",
      name: "BIB01 Test",
      symbol: "BIB01T",
      flags: {
        backing: "rwa-backed",
        pegCurrency: "USD",
        governance: "centralized",
        yieldBearing: false,
        rwa: false,
        navToken: false,
      },
      contracts: [{ chain: "ethereum", address: tokenAddress, decimals: 18 }],
    };

    const now = 1_700_000_000;
    vi.mocked(fetchOnchainUint256).mockResolvedValueOnce(8n);
    vi.mocked(fetchOnchainRawCall).mockResolvedValueOnce(encodeLatestRoundData(1018_00000000n, now - 60));
    vi.mocked(fetchErc20TotalSupply).mockResolvedValueOnce(155_000_000000000000000000n);
    vi.mocked(fetchJsonPostWithRetry).mockResolvedValueOnce({
      data: {
        assetReserves: [
          {
            symbol: "IB01.L",
            token: [
              {
                symbol: "bIB01",
                deployments: [
                  { chainId: "1", network: "Ethereum", address: tokenAddress, totalSupply: "1.55e+23", circulatingSupply: "8e+19" },
                ],
              },
            ],
          },
        ],
      },
    });

    const result = await fetchChainlinkPorReserves(
      coin,
      {
        ...config,
        params: {
          ...baseParams,
          reserveUnit: "SHARES",
          issuerCirculationProbe: {
            kind: "backed-graphql",
            url: "https://api.backed.fi/graphql",
            reserveSymbol: "IB01.L",
          },
        },
      },
      signal,
      { nowSec: now },
    );

    expect(fetchJsonPostWithRetry).toHaveBeenCalledWith(
      "https://api.backed.fi/graphql",
      expect.objectContaining({ query: expect.stringContaining("assetReserves") }),
      signal,
      10_000,
      expect.anything(),
    );
    expect(result.metadata).toMatchObject({
      liabilityBasis: "issuer-circulating",
      circulatingSupplyTokens: 80,
      supplyTokens: 155_000,
    });
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1018 / 80, 5);
    expect(result.warnings?.find((w) => w.code === "por-reserve-over-supply")?.effect).toBe("info");
    expect(result.warnings?.some((w) => w.code === "por-reserve-under-supply")).not.toBe(true);
  });
});
