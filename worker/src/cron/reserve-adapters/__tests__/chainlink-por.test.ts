import { describe, it, expect } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

import {
  adaptBackedCirculationResponse,
  adaptChainlinkPorResponse,
  type ChainlinkPorIssuerCirculationProbe,
  type ChainlinkPorParams,
} from "../chainlink-por";
import { expectWarnings, runAdapter, type AdapterNetworkSpec, type AdapterRpcValue } from "./reserve-adapter.test-support";
import { makePorCoin, makePorSupply } from "./chainlink-por.test-support";
const POR_FEED_ENDPOINT = "https://api.backed.fi/graphql";
const TRON_SUPPLY_ENDPOINT = "https://api.trongrid.io/wallet/triggerconstantcontract";

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
  tronSupply?: bigint | null;
  circulation?: unknown;
}

function porNetwork(options: PorNetworkOptions): AdapterNetworkSpec {
  const feed = options.feedAddress ?? "0xBE456fd14720C3aCCc30A2013Bffd782c9Cb75D5";
  const supply = Object.fromEntries(
    Object.entries(options.evmSupply ?? {}).map(([address, value]) => [address.toLowerCase(), value]),
  );
  const rpc: Record<string, AdapterRpcValue> = {
    [`${feed}:0x313ce567`]: options.feedDecimals ?? 8n,
    [`${feed}:0xfeaf968c`]: encodeLatestRoundData(options.reserves ?? 1_010_00000000n, options.updatedAt),
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
  if (Object.prototype.hasOwnProperty.call(options, "circulation")) {
    json[POR_FEED_ENDPOINT] = options.circulation;
  }
  return { rpc, ...(Object.keys(json).length > 0 ? { json } : {}) };
}

function runPor(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  network: AdapterNetworkSpec,
  nowSec: number,
) {
  return runAdapter("chainlink-por", { ...coin, liveReservesConfig: config }, {
    network,
    nowSec,
  });
}



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
      supplyCoverageComplete: true,
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

  it.each([
    ["XAU_G", "grams of fine gold"],
    ["XAG_G", "grams of fine silver"],
  ] as const)("labels %s reserves as gram quantities instead of USD", (reserveUnit, reserveUnitLabel) => {
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

  it("emits info warning when non-EVM chains are omitted from supply aggregation", () => {
    const result = adaptChainlinkPorResponse(
      { reserves: 100_000_000_000n, decimals: 8, roundId: 42n, updatedAt: 1710000000 },
      params,
      makePorSupply({ omittedNonEvmChains: ["tron"] }),
    );

    const omitted = result.warnings?.find((w) => w.code === "por-supply-chain-omitted");
    expect(omitted).toBeDefined();
    expect(omitted?.severity).toBe("info");
    expect(omitted?.message).toContain("tron");
    // Reads all succeeded, but coverage is not complete: a registry deployment
    // was omitted by design rather than read.
    expect(result.metadata?.supplyReadComplete).toBe(true);
    expect(result.metadata?.supplyCoverageComplete).toBe(false);
  });

  it("degrades and marks supply incomplete when any EVM supply source fails", () => {
    const result = adaptChainlinkPorResponse(
      { reserves: 100_000_000_000n, decimals: 8, roundId: 42n, updatedAt: 1710000000 },
      params,
      makePorSupply({ omittedReadFailureChains: ["bsc"] }),
    );

    expect(result.metadata).toMatchObject({
      supplyUsd: 1000,
      supplyReadComplete: false,
      supplyCoverageComplete: false,
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

  it("sums totalSupply across all configured EVM chains plus Tron for the ratio denominator", async () => {
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
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.01, 5);
    expect(result.metadata?.supplyUsd).toBeCloseTo(1000, 5);
    expect(result.metadata?.supplyReadComplete).toBe(true);
    expect(result.warnings?.some((w) => w.code === "por-reserve-over-supply")).not.toBe(true);
    expect(result.warnings?.some((w) => w.code === "por-reserve-under-supply")).not.toBe(true);
    const contributions = result.metadata?.supplyContributions as Array<{ chain: string }> | undefined;
    expect(contributions?.some((contribution) => contribution.chain === "tron")).toBe(true);
    expectWarnings(result, ["por-supply-chain-omitted"]);
    expect(result.warnings?.find((warning) => warning.code === "por-supply-chain-omitted")?.message).toContain("solana");
    expect(result.warnings?.find((warning) => warning.code === "por-supply-chain-omitted")?.message).not.toContain("tron");
  });

  it("degrades instead of silently reporting EVM-only coverage when the Tron totalSupply() read fails", async () => {
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
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1010 / 600, 5);
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
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
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

  it("wires the issuer circulation probe through the fetch path", async () => {
    const tokenAddress = "0xca30c93b02514f86d5c86a6e375e3a330b435fb5";
    const coin = makePorCoin({
      id: "bib01-test",
      name: "BIB01 Test",
      symbol: "BIB01T",
      contracts: [{ chain: "ethereum", address: tokenAddress, decimals: 18 }],
    });
    const now = 1_700_000_000;
    const { result, network } = await runPor(coin, {
      ...config,
      params: {
        ...baseParams,
        reserveUnit: "SHARES",
        issuerCirculationProbe: {
          kind: "backed-graphql",
          url: POR_FEED_ENDPOINT,
          reserveSymbol: "IB01.L",
        },
      },
    }, porNetwork({
      updatedAt: now - 60,
      reserves: 1018_00000000n,
      evmSupply: { [tokenAddress]: 155_000_000000000000000000n },
      circulation: {
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
      },
    }), now);

    expect(network.requests.some((request) => request.url === POR_FEED_ENDPOINT)).toBe(true);
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
