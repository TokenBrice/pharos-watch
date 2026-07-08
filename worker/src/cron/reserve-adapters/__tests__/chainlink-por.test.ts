import { beforeEach, describe, it, expect, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  const fetchOnchainUint256 = vi.fn();
  const fetchOnchainRawCall = vi.fn();
  return {
    ...actual,
    fetchErc20TotalSupply: vi.fn(),
    fetchOnchainUint256,
    fetchOnchainRawCall,
    makeOnchainCallers: vi.fn((input, options) => ({
      uint256: (contract: string, data: string) =>
        fetchOnchainUint256({
          ...options,
          contract,
          data,
          rpcMode: input.rpcMode,
          chain: input.chain,
        }),
      raw: (contract: string, data: string) =>
        fetchOnchainRawCall({
          ...options,
          contract,
          data,
          rpcMode: input.rpcMode,
          chain: input.chain,
        }),
    })),
  };
});

import { adaptChainlinkPorResponse, fetchChainlinkPorReserves, type ChainlinkPorParams } from "../chainlink-por";
import { fetchErc20TotalSupply, fetchOnchainRawCall, fetchOnchainUint256 } from "../helpers";

const signal = AbortSignal.timeout(5_000);

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

  it("sums totalSupply across all configured EVM chains for the ratio denominator", async () => {
    // TUSD-style: ethereum + tron + avalanche + bsc (EVM-only: ethereum + avalanche + bsc)
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

    // decimals() returns 8 for the PoR feed
    vi.mocked(fetchOnchainUint256).mockResolvedValueOnce(8n);
    // latestRoundData() returns reserves of 600e8 (600 tokens' worth)
    vi.mocked(fetchOnchainRawCall).mockResolvedValueOnce(encodeLatestRoundData(600_00000000n, now - 60));

    // EVM chains each return 200 tokens (18 decimals) — total 600 tokens supply
    vi.mocked(fetchErc20TotalSupply)
      .mockResolvedValueOnce(200_000000000000000000n) // ethereum
      .mockResolvedValueOnce(200_000000000000000000n) // avalanche
      .mockResolvedValueOnce(200_000000000000000000n); // bsc

    const result = await fetchChainlinkPorReserves(coin, config, signal, { nowSec: now });

    // reserves = $600, multichain supply = 600 tokens -> ratio ~ 1.0
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.0, 5);
    expect(result.metadata?.supplyUsd).toBeCloseTo(600, 5);
    expect(result.metadata?.supplyReadComplete).toBe(true);

    // Non-EVM chain (tron) should emit info warning
    const omitted = result.warnings?.find((w) => w.code === "por-supply-chain-omitted");
    expect(omitted).toBeDefined();
    expect(omitted?.message).toContain("tron");

    // EVM chains called once each
    expect(fetchErc20TotalSupply).toHaveBeenCalledTimes(3);
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
});
