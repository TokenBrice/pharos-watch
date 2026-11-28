import { afterEach, describe, it, expect, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

import { adaptChainlinkPorResponse, type ChainlinkPorParams } from "../chainlink-por";
import {
  expectWarnings,
  expectWarningEffect,
  resolveAdapterCoin,
  runAdapter,
  type AdapterNetworkSpec,
  type AdapterRpcValue,
} from "./reserve-adapter.test-support";
import { makePorCoin, makePorSupply } from "./chainlink-por.test-support";
const TRON_SUPPLY_ENDPOINT = "https://api.trongrid.io/wallet/triggerconstantcontract";

afterEach(() => vi.restoreAllMocks());

function encodeLatestRoundData(answer: bigint, updatedAt: number): `0x${string}` {
  const word = (value: bigint) => value.toString(16).padStart(64, "0");
  return `0x${word(42n)}${word(answer)}${word(0n)}${word(BigInt(updatedAt))}${word(42n)}`;
}

interface PorNetworkOptions {
  feedAddress?: string;
  feedDecimals?: bigint;
  reserves?: bigint;
  updatedAt: number;
  evmSupply?: Record<string, bigint | null>;
  tokenDecimals?: Record<string, bigint>;
  tronSupply?: bigint | null;
  block?: { number?: number; timestamp?: number };
}

function porNetwork(options: PorNetworkOptions): AdapterNetworkSpec {
  const feed = options.feedAddress ?? "0xBE456fd14720C3aCCc30A2013Bffd782c9Cb75D5";
  const supply = Object.fromEntries(
    Object.entries(options.evmSupply ?? {}).map(([address, value]) => [address.toLowerCase(), value]),
  );
  const rpc: Record<string, AdapterRpcValue> = {
    [`${feed}:0x313ce567`]: options.feedDecimals ?? 8n,
    [`${feed}:0xfeaf968c`]: encodeLatestRoundData(options.reserves ?? 1_010_00000000n, options.updatedAt),
    ...Object.fromEntries(
      Object.entries(options.tokenDecimals ?? {}).map(([address, value]) => [`${address}:0x313ce567`, value]),
    ),
    "0x18160ddd": (call: { contract: string }) => Object.prototype.hasOwnProperty.call(supply, call.contract)
      ? supply[call.contract]
      : null,
  };
  const json: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(options, "tronSupply")) {
    json[TRON_SUPPLY_ENDPOINT] = options.tronSupply == null
      ? { result: { result: false } }
      : {
          result: { result: true },
          constant_result: [options.tronSupply.toString(16)],
        };
  }
  return { rpc, ...(Object.keys(json).length > 0 ? { json } : {}), ...(options.block ? { block: options.block } : {}) };
}

function runPor(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  network: AdapterNetworkSpec,
  nowSec: number,
) {
  vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
  return runAdapter("chainlink-por", { ...coin, liveReservesConfig: config }, {
    network,
    nowSec,
  });
}



const expectNoCollateralizationRatio = (result: { metadata?: { collateralizationRatio?: unknown } | null }) => expect(result.metadata?.collateralizationRatio).toBeUndefined();

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
      sourceKey: "chainlink-por:feed:0xbe456fd14720c3accc30a2013bffd782c9cb75d5",
      name: "USD Cash Reserves",
      pct: 100,
      risk: "very-low",
    });
  });

  it("includes metadata with reserves and feed info", () => {
    const result = adaptChainlinkPorResponse(
      { reserves: 145_000_000_000n, decimals: 8, roundId: 42n, updatedAt: 1710000000 },
      params,
      makePorSupply({
        contributions: [
          {
            chain: "ethereum",
            tokenAddress: "0x0000000000000000000000000000000000000001",
            raw: 144_000_000_000_000_000_000_000_000n,
            decimals: 18,
          },
        ],
      }),
    );
    expect(result.metadata?.totalReservesRaw).toBe("145000000000");
    expect(result.metadata?.feedDecimals).toBe(8);
    expect(result.metadata?.feedRoundId).toBe("42");
    expect(result.metadata?.feedUpdatedAt).toBe(1710000000);
    expect(result.metadata).toMatchObject({
      totalReserveUsd: 1450,
      supplyUsd: 144_000_000,
      supplyReadComplete: true,
      supplyCoverageComplete: true,
    });
  });

  it.each([
    ["XAU", "troy ounces of gold"],
    ["XAG", "troy ounces of silver"],
    ["XAU_G", "grams of fine gold"],
    ["XAG_G", "grams of fine silver"],
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
      makePorSupply(),
    );

    expect(result.metadata).toMatchObject({
      reserveUnit: "XAU",
      totalReserveQuantity: 990,
    });
    expect(result.metadata?.totalReserveUsd).toBeUndefined();
    expect(result.metadata?.supplyUsd).toBeUndefined();
    expectNoCollateralizationRatio(result);
    expect(result.warnings?.some((w) => w.code === "por-reserve-under-supply")).not.toBe(true);
    expect(result.warnings?.some((w) => w.code === "por-reserve-over-supply")).not.toBe(true);
  });

  it("compares gram-denominated reserves 1:1 against token supply for gram-pegged tokens", () => {
    const result = adaptChainlinkPorResponse(
      { reserves: 99_000_000_000n, decimals: 8, roundId: 42n, updatedAt: 1710000000 },
      { ...params, reserveUnit: "XAU_G" },
      makePorSupply(),
    );

    // 990 g of fine gold vs 1000 gram-pegged tokens (1 token = 1 g) -> 0.99
    expect(result.metadata).toMatchObject({
      reserveUnit: "XAU_G",
      reserveUnitLabel: "grams of fine gold",
      totalReserveQuantity: 990,
      supplyTokens: 1000,
      collateralizationRatio: 0.99,
    });
    expect(result.metadata?.supplyUsd).toBeUndefined();
    expect(result.metadata?.totalReserveUsd).toBeUndefined();
    expect(result.warnings?.some((w) => w.code === "por-reserve-under-supply")).toBe(true);
    expect(result.warnings?.find((w) => w.code === "por-reserve-under-supply")?.effect).toBe("degraded");
  });

  it("degrades when reserves do not cover multichain token supply", () => {
    const result = adaptChainlinkPorResponse(
      { reserves: 99_000_000_000n, decimals: 8, roundId: 42n, updatedAt: 1710000000 },
      params,
      makePorSupply(),
    );

    expect(result.metadata?.collateralizationRatio).toBe(0.99);
    expect(result.warnings?.some((w) => w.code === "por-reserve-under-supply")).toBe(true);
    expect(result.warnings?.find((w) => w.code === "por-reserve-under-supply")?.effect).toBe("degraded");
  });

  it("emits over-collateralization warning when ratio exceeds 1.1", () => {
    const result = adaptChainlinkPorResponse(
      { reserves: 160_000_000_000n, decimals: 8, roundId: 42n, updatedAt: 1710000000 },
      params,
      makePorSupply(),
    );

    // reserves = 1600 USD / supply = 1000 tokens -> ratio = 1.6
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.6, 5);
    expect(result.warnings?.some((w) => w.code === "por-reserve-over-supply")).toBe(true);
    expect(result.warnings?.find((w) => w.code === "por-reserve-over-supply")?.effect).toBe("degraded");
  });

  it("withholds the coverage ratio with a not-comparable scope and publishes the declared basis", () => {
    const result = adaptChainlinkPorResponse(
      { reserves: 2_567_133_466_000_000_000_000_000n, decimals: 18, roundId: 200n, updatedAt: 1710000000 },
      {
        ...params,
        reserveUnit: "XAU_G",
        liabilityScope: {
          basis: "not-comparable",
          canonicalChain: "kinesis",
          reason: "the Ethereum ERC-20 is a KMS Labs representation of Kinesis-native KAU",
        },
      },
      makePorSupply({
        contributions: [
          {
            chain: "ethereum",
            tokenAddress: "0x14dab79fd7b7b3f748d434812fd6a9aac460ea52",
            raw: 1_640_000_000_000_000_000_000_000n,
            decimals: 18,
          },
        ],
      }),
    );

    // 2,567,133.466 g of feed reserves against the 1,640,000-token readable
    // wrapper: the aggregate is a subset of the feed's reserve scope, so the
    // snapshot keeps the quantities and withholds any coverage verdict.
    expect(result.metadata?.totalReserveQuantity).toBeCloseTo(2_567_133.466, 3);
    expect(result.metadata?.supplyTokens).toBeCloseTo(1_640_000, 3);
    expectNoCollateralizationRatio(result);
    expect(result.metadata).toMatchObject({
      supplyReadComplete: true,
      supplyCoverageComplete: false,
      ratioUnavailableReason: "not-comparable",
      liabilityScope: {
        basis: "not-comparable",
        canonicalChain: "kinesis",
        reason: "the Ethereum ERC-20 is a KMS Labs representation of Kinesis-native KAU",
      },
    });
    expectWarnings(result, ["por-supply-scope-incomplete"]);
    expectWarningEffect(result, "por-supply-scope-incomplete", "info");
    expect(result.warnings?.some((w) => w.code === "por-reserve-over-supply")).not.toBe(true);
    expect(result.warnings?.some((w) => w.code === "por-reserve-under-supply")).not.toBe(true);
  });

  it("withholds the ratio when an unscoped roster omits a non-EVM chain", () => {
    const result = adaptChainlinkPorResponse(
      { reserves: 100_000_000_000n, decimals: 8, roundId: 42n, updatedAt: 1710000000 },
      params,
      makePorSupply({ omittedNonEvmChains: ["solana"] }),
    );

    const omitted = result.warnings?.find((w) => w.code === "por-supply-chain-omitted");
    expect(omitted?.severity).toBe("info");
    expect(omitted?.message).toContain("solana");
    // Every attempted read succeeded, but the readable subset is not the
    // liability: no ratio is published from it.
    expect(result.metadata).toMatchObject({
      supplyUsd: 1000,
      supplyReadComplete: true,
      supplyCoverageComplete: false,
      ratioUnavailableReason: "liability-scope-unclassified-chain",
    });
    expectNoCollateralizationRatio(result);
  });

  it("withholds coverage when any EVM supply source fails", () => {
    const result = adaptChainlinkPorResponse(
      { reserves: 100_000_000_000n, decimals: 8, roundId: 42n, updatedAt: 1710000000 },
      params,
      makePorSupply({ omittedReadFailureChains: ["bsc"] }),
    );

    expect(result.metadata).toMatchObject({
      supplyUsd: 1000,
      supplyReadComplete: false,
      supplyCoverageComplete: false,
      ratioUnavailableReason: "included-supply-read-failed",
    });
    expectNoCollateralizationRatio(result);
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
    version: 3,
    semantics: "attestation-mix",
    inputs: {
      primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
    },
    params: baseParams,
  };

  it("withholds the ratio when an unscoped roster has an unreadable non-EVM deployment", async () => {
    const coin = makePorCoin({
      contracts: [
        { chain: "ethereum", address: "0x0000000000085d4780b73119b644ae5ecd22b376", decimals: 18 },
        { chain: "tron", address: "TUpMhErZL2fhh4sVNULAbNKLokS4GjC1F4", decimals: 18 },
        { chain: "avalanche", address: "0x1c20e891bab6b1727d14da358fae2984ed9b59eb", decimals: 18 },
        { chain: "bsc", address: "0x40af3827f39d0eacbf4a168f8d4ee67c121d11c9", decimals: 18 },
        { chain: "solana", address: "5Wb2QwGNH5MQdBjrpqSCJk8QgKzhkjaEqE9BUmQqYuTM", decimals: 6 },
      ],
    });
    const now = 1_700_000_000;
    const { result, network } = await runPor(coin, config, porNetwork({
      updatedAt: now - 60,
      reserves: 1010_00000000n,
      evmSupply: {
        "0x0000000000085d4780b73119b644ae5ecd22b376": 200_000000000000000000n,
        "0x1c20e891bab6b1727d14da358fae2984ed9b59eb": 200_000000000000000000n,
        "0x40af3827f39d0eacbf4a168f8d4ee67c121d11c9": 200_000000000000000000n,
      },
      tronSupply: 400_000000000000000000n,
    }), now);

    expect(network.rpcCalls.filter((call) => call.selector === "0x18160ddd")).toHaveLength(3);
    expect(network.requests.some((request) => request.url === TRON_SUPPLY_ENDPOINT)).toBe(true);
    // The readable EVM+Tron subset is published as a diagnostic, but without a
    // reviewed scope proving Solana is outside the liability it is not a ratio.
    expect(result.metadata?.supplyUsd).toBeCloseTo(1000, 5);
    expect(result.metadata).toMatchObject({
      supplyReadComplete: true,
      supplyCoverageComplete: false,
      ratioUnavailableReason: "liability-scope-unclassified-chain",
    });
    expectNoCollateralizationRatio(result);
    const contributions = result.metadata?.supplyContributions as Array<{ chain: string }> | undefined;
    expect(contributions?.some((contribution) => contribution.chain === "tron")).toBe(true);
    expectWarnings(result, ["por-supply-chain-omitted"]);
    expect(result.warnings?.find((warning) => warning.code === "por-supply-chain-omitted")?.message).toContain("solana");
  });

  it("degrades and withholds coverage when the Tron totalSupply() read fails", async () => {
    const coin = makePorCoin({
      contracts: [
        { chain: "ethereum", address: "0x0000000000085d4780b73119b644ae5ecd22b376", decimals: 18 },
        { chain: "tron", address: "TUpMhErZL2fhh4sVNULAbNKLokS4GjC1F4", decimals: 18 },
        { chain: "avalanche", address: "0x1c20e891bab6b1727d14da358fae2984ed9b59eb", decimals: 18 },
        { chain: "bsc", address: "0x40af3827f39d0eacbf4a168f8d4ee67c121d11c9", decimals: 18 },
      ],
    });
    const now = 1_700_000_000;
    const { result, network } = await runPor(coin, config, porNetwork({
      updatedAt: now - 60,
      reserves: 1010_00000000n,
      evmSupply: {
        "0x0000000000085d4780b73119b644ae5ecd22b376": 200_000000000000000000n,
        "0x1c20e891bab6b1727d14da358fae2984ed9b59eb": 200_000000000000000000n,
        "0x40af3827f39d0eacbf4a168f8d4ee67c121d11c9": 200_000000000000000000n,
      },
      tronSupply: null,
    }), now);

    expect(network.requests.some((request) => request.url === TRON_SUPPLY_ENDPOINT)).toBe(true);
    expect(result.metadata?.supplyReadComplete).toBe(false);
    const warning = result.warnings?.find((w) => w.code === "partial-supply-read-failure");
    expect(warning).toBeDefined();
    expect(warning?.effect).toBe("degraded");
    expect(warning?.message).toContain("tron");
    expect(result.metadata?.supplyUsd).toBeCloseTo(600, 5);
    expectNoCollateralizationRatio(result);
  });

  it("does not call the Tron reader or change behavior for coins without a tron contract", async () => {
    const coin = makePorCoin({
      id: "bib01-test",
      name: "BIB01 Test",
      symbol: "BIB01T",
      contracts: [
        { chain: "ethereum", address: "0x0000000000085d4780b73119b644ae5ecd22b376", decimals: 18 },
        { chain: "base", address: "0x1c20e891bab6b1727d14da358fae2984ed9b59eb", decimals: 18 },
      ],
    });
    const now = 1_700_000_000;
    const { result, network } = await runPor(coin, config, porNetwork({
      updatedAt: now - 60,
      reserves: 300_00000000n,
      evmSupply: {
        "0x0000000000085d4780b73119b644ae5ecd22b376": 150_000000000000000000n,
        "0x1c20e891bab6b1727d14da358fae2984ed9b59eb": 150_000000000000000000n,
      },
    }), now);

    expect(network.requests.some((request) => request.url === TRON_SUPPLY_ENDPOINT)).toBe(false);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.0, 5);
    expect(result.warnings?.some((w) => w.code === "por-supply-chain-omitted")).not.toBe(true);
    expect(result.warnings?.some((w) => w.code === "partial-supply-read-failure")).not.toBe(true);
  });

  it("skips a contract supply probe when catalog decimals are missing", async () => {
    const coin = makePorCoin({
      contracts: [
        { chain: "ethereum", address: "0x0000000000085d4780b73119b644ae5ecd22b376" } as unknown as NonNullable<StablecoinMeta["contracts"]>[number],
        { chain: "base", address: "0x1c20e891bab6b1727d14da358fae2984ed9b59eb", decimals: 18 },
      ],
    });
    const now = 1_700_000_000;
    const { result, network } = await runPor(coin, config, porNetwork({
      updatedAt: now - 60,
      reserves: 300_00000000n,
      evmSupply: { "0x1c20e891bab6b1727d14da358fae2984ed9b59eb": 150_000000000000000000n },
    }), now);

    expect(network.rpcCalls.filter((call) => call.selector === "0x18160ddd")).toHaveLength(1);
    expect(network.rpcCalls.find((call) => call.selector === "0x18160ddd")?.contract).toBe(
      "0x1c20e891bab6b1727d14da358fae2984ed9b59eb",
    );
    expect(result.metadata?.supplyUsd).toBe(150);
    expect(result.warnings?.find((warning) => warning.code === "partial-supply-read-failure")?.message).toContain("ethereum");
  });

  it("throws when all EVM chain supply reads return null", async () => {
    const coin = makePorCoin({
      contracts: [
        { chain: "ethereum", address: "0x0000000000085d4780b73119b644ae5ecd22b376", decimals: 18 },
        { chain: "avalanche", address: "0x1c20e891bab6b1727d14da358fae2984ed9b59eb", decimals: 18 },
      ],
    });
    const now = 1_700_000_000;
    await expect(runPor(coin, config, porNetwork({
      updatedAt: now - 60,
      reserves: 100_00000000n,
      evmSupply: {
        "0x0000000000085d4780b73119b644ae5ecd22b376": null,
        "0x1c20e891bab6b1727d14da358fae2984ed9b59eb": null,
      },
    }), now)).rejects.toThrow(/chainlink-por/);
  });

  it("does not require token contracts when a commodity reserve unit is configured", async () => {
    const coin = {
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
    } as StablecoinMeta;
    const now = 1_700_000_000;
    const { result, network } = await runPor(coin, {
      ...config,
      params: {
        ...baseParams,
        assetLabel: "Physical gold bullion",
        reserveUnit: "XAU",
      },
    }, porNetwork({
      updatedAt: now - 60,
      reserves: 1_234_500_000_000n,
    }), now);

    expect(network.rpcCalls.filter((call) => call.selector === "0x18160ddd")).toHaveLength(0);
    expect(result.metadata).toMatchObject({
      reserveUnit: "XAU",
      reserveUnitLabel: "troy ounces of gold",
      totalReserveQuantity: 12_345,
    });
    expect(result.metadata?.supplyUsd).toBeUndefined();
    expectNoCollateralizationRatio(result);
  });

  it("compares gram feed answers against token supply for gram-pegged commodity units", async () => {
    const tokenAddress = "0x14dab79fd7b7b3f748d434812fd6a9aac460ea52";
    const coin = {
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
      contracts: [{ chain: "ethereum", address: tokenAddress, decimals: 18 }],
    } as StablecoinMeta;
    const now = 1_700_000_000;
    const { result, network } = await runPor(coin, {
      ...config,
      params: {
        ...baseParams,
        assetLabel: "Physical gold reserves (grams)",
        reserveUnit: "XAU_G",
      },
    }, porNetwork({
      updatedAt: now - 60,
      reserves: 256_713_346_600_000n,
      evmSupply: { [tokenAddress]: 2_386_227_834_200000000000000n },
    }), now);

    expect(network.rpcCalls.filter((call) => call.selector === "0x18160ddd")).toHaveLength(1);
    expect(result.metadata).toMatchObject({
      reserveUnit: "XAU_G",
      reserveUnitLabel: "grams of fine gold",
    });
    expect(result.metadata?.totalReserveQuantity).toBeCloseTo(2_567_133.466, 3);
    expect(result.metadata?.supplyTokens).toBeCloseTo(2_386_227.8342, 3);
    expect(result.metadata?.supplyUsd).toBeUndefined();
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(2_567_133.466 / 2_386_227.8342, 5);
    expect(result.warnings?.some((w) => w.code === "por-reserve-under-supply")).not.toBe(true);
    expect(result.warnings?.some((w) => w.code === "por-reserve-over-supply")).not.toBe(true);
  });

  it("publishes KAU's declared not-comparable scope instead of a scope-mismatch degradation", async () => {
    // Real catalog config for kau-kinesis: the feed answers the audited Kinesis
    // Cayman fine-gold balance (2,567,133.466 g), while the only readable
    // deployment is the Ethereum representation wrapper (1,640,000 totalSupply).
    const tokenAddress = "0x14dab79fd7b7b3f748d434812fd6a9aac460ea52";
    const now = 1_700_000_000;
    const { result, network } = await runAdapter("chainlink-por", "kau-kinesis", {
      nowSec: now,
      network: porNetwork({
        feedAddress: "0xaB5Dd7DD7669072a1Ef27c0ba241120A27A1aeC3",
        feedDecimals: 18n,
        updatedAt: now - 60,
        reserves: 2_567_133_466_000_000_000_000_000n,
        evmSupply: { [tokenAddress]: 1_640_000_000_000_000_000_000_000n },
      }),
    });

    expect(network.rpcCalls.filter((call) => call.selector === "0x18160ddd")).toHaveLength(1);
    expect(result.metadata?.totalReserveQuantity).toBeCloseTo(2_567_133.466, 3);
    expect(result.metadata?.supplyTokens).toBeCloseTo(1_640_000, 3);
    expectNoCollateralizationRatio(result);
    expect(result.metadata).toMatchObject({
      supplyCoverageComplete: false,
      ratioUnavailableReason: "not-comparable",
      liabilityScope: { basis: "not-comparable", canonicalChain: "kinesis" },
    });
    expectWarningEffect(result, "por-supply-scope-incomplete", "info");
    expect(result.warnings?.some((w) => w.code === "por-reserve-over-supply")).not.toBe(true);
    expect(result.warnings?.some((w) => w.code === "por-reserve-under-supply")).not.toBe(true);
  });

  it("omits registry-typed non-EVM chains like NEAR instead of firing EVM reads at them", async () => {
    const coin = makePorCoin({
      contracts: [
        { chain: "ethereum", address: "0x0000000000085d4780b73119b644ae5ecd22b376", decimals: 18 },
        { chain: "near", address: "tusd.near", decimals: 18 },
      ],
    });
    const now = 1_700_000_000;
    const { result, network } = await runPor(coin, config, porNetwork({
      updatedAt: now - 60,
      reserves: 150_00000000n,
      evmSupply: { "0x0000000000085d4780b73119b644ae5ecd22b376": 150_000000000000000000n },
    }), now);

    expect(network.rpcCalls.filter((call) => call.selector === "0x18160ddd")).toHaveLength(1);
    const omitted = result.warnings?.find((w) => w.code === "por-supply-chain-omitted");
    expect(omitted?.severity).toBe("info");
    expect(omitted?.message).toContain("near");
    expect(result.warnings?.some((w) => w.code === "partial-supply-read-failure")).not.toBe(true);
    expect(result.metadata?.supplyReadComplete).toBe(true);
    expect(result.metadata?.supplyCoverageComplete).toBe(false);
    expectNoCollateralizationRatio(result);
  });

  it("treats a zero totalSupply read as a valid empty deployment, not a read failure", async () => {
    const coin = makePorCoin({
      id: "bib01-test",
      name: "BIB01 Test",
      symbol: "BIB01T",
      contracts: [
        { chain: "ethereum", address: "0x0000000000085d4780b73119b644ae5ecd22b376", decimals: 18 },
        { chain: "bsc", address: "0x40af3827f39d0eacbf4a168f8d4ee67c121d11c9", decimals: 18 },
      ],
    });
    const now = 1_700_000_000;
    const { result, network } = await runPor(coin, config, porNetwork({
      updatedAt: now - 60,
      reserves: 150_00000000n,
      evmSupply: {
        "0x0000000000085d4780b73119b644ae5ecd22b376": 150_000000000000000000n,
        "0x40af3827f39d0eacbf4a168f8d4ee67c121d11c9": 0n,
      },
    }), now);

    expect(network.rpcCalls.filter((call) => call.selector === "0x18160ddd")).toHaveLength(2);
    expect(result.warnings?.some((w) => w.code === "partial-supply-read-failure")).not.toBe(true);
    expect(result.metadata?.supplyReadComplete).toBe(true);
    expect(result.metadata?.supplyUsd).toBe(150);
  });
});

// TUSD reviewed liability scope, raw values read 2026-09-27 (Moore report as of
// 08:30:30Z; Chainlink TUSD Reserves feed updatedAt 04:00:47Z; supply reads
// around 20:43:47Z). Moore attests 501,928,900.88 reserves against exactly
// 494,515,082.75 issued TUSD on Ethereum, Tron, BNB Chain and Avalanche.
describe("fetchChainlinkPorReserves with TUSD's reviewed liability scope", () => {
  const TUSD_FEED = "0xBE456fd14720C3aCCc30A2013Bffd782c9Cb75D5";
  const FEED_UPDATED_AT = 1_790_481_647;
  const SUPPLY_READ_AT = 1_790_541_827;
  const RESERVES = 501_928_900_880_000_000_000_000_000n;
  const NATIVE_SUPPLY = {
    "0x0000000000085d4780b73119b644ae5ecd22b376": 315_125_540_952_349_698_425_178_789n,
    "0x40af3827f39d0eacbf4a168f8d4ee67c121d11c9": 10_030_363_880_000_000_000_000_000n,
    "0x1c20e891bab6b1727d14da358fae2984ed9b59eb": 845_723_780_000_000_000_000_000n,
  } as const;
  const TRON_SUPPLY = 168_513_454_137_650_301_574_821_211n;
  const BRIDGED_SUPPLY = {
    "0x2e1ad108ff1d8c782fcbbb89aad783ac49586756": 183_788_690_903_223_656_091_095n,
    "0x4d15a3a2286d883af0aa1b3f21367843fac63e07": 164_752_318_710_295_684_303_626n,
    "0xcb59a0a753fdb7491d5f3d794316f1ade197b21e": 4_874_232_760_387_043_201_513n,
    "0x9879abdea01a879644185341f7af7d8343556b7a": 466_468_532_660_924_841_124_161n,
  } as const;
  const EXPECTED_SUPPLY = 494_515_082.75;
  const EXPECTED_RATIO = 501_928_900.88 / 494_515_082.75;

  function tusdNetwork(options: { tronSupply?: bigint | null; withBridgedReads?: boolean } = {}) {
    vi.spyOn(Date, "now").mockReturnValue(SUPPLY_READ_AT * 1000);
    const evmSupply: Record<string, bigint> = {
      ...NATIVE_SUPPLY,
      ...(options.withBridgedReads ? BRIDGED_SUPPLY : {}),
    };
    return porNetwork({
      feedAddress: TUSD_FEED,
      feedDecimals: 18n,
      updatedAt: FEED_UPDATED_AT,
      reserves: RESERVES,
      evmSupply,
      tokenDecimals: Object.fromEntries(Object.keys(evmSupply).map((address) => [address, 18n])),
      tronSupply: options.tronSupply === undefined ? TRON_SUPPLY : options.tronSupply,
      block: { number: 26_071_248, timestamp: SUPPLY_READ_AT },
    });
  }

  it.each([false, true])("divides Moore's reserves by native-chain supply only (bridged reads answered=%s)", async (withBridgedReads) => {
    const { result, network } = await runAdapter("chainlink-por", "tusd-trueusd", {
      nowSec: SUPPLY_READ_AT,
      network: tusdNetwork({ withBridgedReads }),
    });

    expect(result.metadata?.supplyUsd).toBeCloseTo(EXPECTED_SUPPLY, 2);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(EXPECTED_RATIO, 7);
    // Regression guard: adding the 819,883.78 bridged TUSD gave 1.0133121.
    expect(result.metadata?.collateralizationRatio).toBeGreaterThan(1.0149);
    expect(result.metadata).toMatchObject({
      supplyReadComplete: true,
      supplyCoverageComplete: true,
      reserveObservedAt: FEED_UPDATED_AT,
      supplyObservedAt: { min: SUPPLY_READ_AT, max: SUPPLY_READ_AT },
      ratioSkewSec: SUPPLY_READ_AT - FEED_UPDATED_AT,
      liabilityScope: {
        basis: "issuer-native-supply",
        includedChains: ["ethereum", "tron", "bsc", "avalanche"],
        unclassifiedChains: [],
        failedChains: [],
        maxReserveSupplySkewSec: 172_800,
      },
    });
    const scope = result.metadata?.liabilityScope as { excludedChains: Array<{ chain: string }> };
    expect(scope.excludedChains.map((entry) => entry.chain)).toEqual(["polygon", "arbitrum", "optimism", "fantom", "near"]);
    expect(result.metadata?.ratioUnavailableReason).toBeUndefined();
    expect(result.warnings).toBeUndefined();
    const supplyReads = network.rpcCalls.filter((call) => call.selector === "0x18160ddd").map((call) => call.contract).sort();
    expect(supplyReads).toEqual(Object.keys(NATIVE_SUPPLY).sort());
  });

  it("withholds the ratio, never zero-filling, when an included Tron read fails", async () => {
    const { result } = await runAdapter("chainlink-por", "tusd-trueusd", {
      nowSec: SUPPLY_READ_AT,
      network: tusdNetwork({ tronSupply: null }),
    });

    expectNoCollateralizationRatio(result);
    expect(result.metadata).toMatchObject({
      supplyReadComplete: false,
      supplyCoverageComplete: false,
      ratioUnavailableReason: "included-supply-read-failed",
      liabilityScope: { failedChains: [{ chain: "tron", reason: "totalSupply() read failed" }] },
    });
    expect((result.metadata?.supplyContributions as Array<{ chain: string }>).map((entry) => entry.chain).sort())
      .toEqual(["avalanche", "bsc", "ethereum"]);
    expectWarningEffect(result, "partial-supply-read-failure", "degraded");
  });

  it("withholds the ratio when the catalog gains a chain the scope does not classify", async () => {
    const { result, network, coin } = await runAdapter("chainlink-por", "tusd-trueusd", {
      nowSec: SUPPLY_READ_AT,
      network: tusdNetwork(),
      coin: {
        contracts: [
          ...(resolveAdapterCoin("chainlink-por", "tusd-trueusd").coin.contracts ?? []),
          { chain: "base", address: "0x00000000000000000000000000000000000000b5", decimals: 18 },
        ],
      },
    });

    expect(coin.contracts?.some((contract) => contract.chain === "base")).toBe(true);
    expectNoCollateralizationRatio(result);
    expect(result.metadata?.supplyUsd).toBeCloseTo(EXPECTED_SUPPLY, 2);
    expect(result.metadata).toMatchObject({
      supplyCoverageComplete: false,
      ratioUnavailableReason: "liability-scope-unclassified-chain",
      liabilityScope: { unclassifiedChains: ["base"] },
    });
    expectWarningEffect(result, "por-liability-scope-unclassified", "degraded");
    expect(network.rpcCalls.some((call) => call.contract === "0x00000000000000000000000000000000000000b5")).toBe(false);
  });
});
