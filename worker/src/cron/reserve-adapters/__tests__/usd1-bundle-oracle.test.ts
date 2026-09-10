import { describe, expect, it } from "vitest";
import { encodeAbiParameters } from "viem/utils";
import type { StablecoinMeta } from "@shared/types/core";
import type { ChainRpcConfig } from "../../../lib/chain-registry";
import {
  adaptUsd1BundleOracle,
  type Usd1SupplyAggregate,
} from "../usd1-bundle-oracle";
import {
  expectWarningEffect,
  expectWarnings,
  runAdapter,
  type AdapterNetworkSpec,
} from "./reserve-adapter.test-support";

const BUNDLE_TIMESTAMP = 1776154391;
const RESERVES_RAW = 4_089_230_010_760_000_230_000_000_000n;

function encodeBundle(timestamp: number, reservesRaw: bigint): `0x${string}` {
  return encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(timestamp), reservesRaw]);
}

function makeSupply(overrides: Partial<Usd1SupplyAggregate> = {}): Usd1SupplyAggregate {
  return {
    contributions: [{
      chain: "ethereum",
      tokenAddress: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d",
      raw: 1_540_271_014_130_832_212_980_859_451n,
      decimals: 18,
    }],
    omittedNonEvmChains: [],
    omittedNoRpcChains: [],
    omittedReadFailureChains: [],
    ...overrides,
  };
}

describe("adaptUsd1BundleOracle", () => {
  it("decodes the Chainlink bundle oracle payload into a live reserve proof", () => {
    const result = adaptUsd1BundleOracle({
      bundle: encodeBundle(BUNDLE_TIMESTAMP, RESERVES_RAW),
      latestBundleTimestamp: BigInt(BUNDLE_TIMESTAMP),
      bundleDecimals: [18],
      supply: makeSupply(),
    });

    expect(result.slices).toEqual([
      {
        sourceKey: "usd1-bundle-oracle:0x691b74146cdba162449012aa32d3cbf5df77d4c4",
        name: "U.S. Treasury Bills, Money Market Funds & Cash",
        pct: 100,
        risk: "very-low",
      },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: BUNDLE_TIMESTAMP,
      totalReserveUsd: 4_089_230_010.76,
      supplyUsd: 1_540_271_014.1308322,
      reserveDecimals: 18,
      supplyReadComplete: true,
      redemption: {
        capacityKind: "documented-bound",
        freshnessKind: "verified-source-timestamp",
        sourceTimestamp: BUNDLE_TIMESTAMP,
        routeStatus: "unknown",
        holderEligibility: "verified-customer",
      },
    });
    expect(result.warnings).toBeUndefined();
  });

  it("sums the supply denominator across chains with differing token decimals", () => {
    const result = adaptUsd1BundleOracle({
      bundle: encodeBundle(BUNDLE_TIMESTAMP, 3_000_000000000000000000n),
      latestBundleTimestamp: BigInt(BUNDLE_TIMESTAMP),
      bundleDecimals: [18],
      supply: makeSupply({
        contributions: [
          { chain: "ethereum", tokenAddress: "0xeth", raw: 1_000_000000000000000000n, decimals: 18 },
          { chain: "bsc", tokenAddress: "0xbsc", raw: 500_000000000000000000n, decimals: 18 },
          // Tron/Solana-style 6-decimal deployments must not be scaled as 18.
          { chain: "tron", tokenAddress: "Ttron", raw: 750_000000n, decimals: 6 },
        ],
      }),
    });

    // 1000 + 500 + 750 = 2250 tokens of liability, not the 1000 Ethereum-only figure.
    expect(result.metadata?.supplyUsd).toBeCloseTo(2250, 6);
    expect(result.metadata?.fundBackingTotalRatio).toBeCloseTo(3000 / 2250, 6);
    expect(result.metadata?.supplyContributions).toEqual([
      { chain: "ethereum", tokenAddress: "0xeth", supplyRaw: "1000000000000000000000", decimals: 18 },
      { chain: "bsc", tokenAddress: "0xbsc", supplyRaw: "500000000000000000000", decimals: 18 },
      { chain: "tron", tokenAddress: "Ttron", supplyRaw: "750000000", decimals: 6 },
    ]);
  });

  it("does not emit misleading collateralizationRatio when oracle reports fund-wide reserves", () => {
    const result = adaptUsd1BundleOracle({
      bundle: encodeBundle(BUNDLE_TIMESTAMP, RESERVES_RAW),
      latestBundleTimestamp: BigInt(BUNDLE_TIMESTAMP),
      bundleDecimals: [18],
      supply: makeSupply(),
    });

    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.fundBackingTotalRatio).toBeCloseTo(
      4_089_230_010.76 / 1_540_271_014.1308322,
      3,
    );
    expect((result.metadata?.details as Record<string, unknown> | undefined)?.fundScope).toBe(
      "WLFI aggregate fund reserves; denominator is USD1 supply only",
    );
  });

  it("reports omitted non-EVM deployments as info without degrading the snapshot", () => {
    const result = adaptUsd1BundleOracle({
      bundle: encodeBundle(BUNDLE_TIMESTAMP, RESERVES_RAW),
      latestBundleTimestamp: BigInt(BUNDLE_TIMESTAMP),
      bundleDecimals: [18],
      supply: makeSupply({ omittedNonEvmChains: ["solana", "aptos"] }),
    });

    const omitted = result.warnings?.find((warning) => warning.code === "por-supply-chain-omitted");
    expect(omitted?.effect).toBe("info");
    expect(omitted?.message).toContain("solana");
    expect(omitted?.message).toContain("aptos");
    expect(result.metadata?.supplyReadComplete).toBe(true);
  });

  it("reports chains without a configured RPC as info without degrading the snapshot", () => {
    const result = adaptUsd1BundleOracle({
      bundle: encodeBundle(BUNDLE_TIMESTAMP, RESERVES_RAW),
      latestBundleTimestamp: BigInt(BUNDLE_TIMESTAMP),
      bundleDecimals: [18],
      supply: makeSupply({ omittedNoRpcChains: ["plume"] }),
    });

    const omitted = result.warnings?.find((warning) => warning.code === "por-supply-chain-omitted");
    expect(omitted?.effect).toBe("info");
    expect(omitted?.message).toContain("no RPC configured");
    expect(omitted?.message).toContain("plume");
    expect(result.warnings?.some((warning) => warning.code === "partial-supply-read-failure")).not.toBe(true);
    expect(result.metadata?.supplyReadComplete).toBe(true);
  });

  it("degrades and marks the supply read incomplete when a chain read fails", () => {
    const result = adaptUsd1BundleOracle({
      bundle: encodeBundle(BUNDLE_TIMESTAMP, RESERVES_RAW),
      latestBundleTimestamp: BigInt(BUNDLE_TIMESTAMP),
      bundleDecimals: [18],
      supply: makeSupply({ omittedReadFailureChains: ["bsc"] }),
    });

    const failure = result.warnings?.find((warning) => warning.code === "partial-supply-read-failure");
    expect(failure?.effect).toBe("degraded");
    expect(failure?.message).toContain("bsc");
    expect(result.metadata?.supplyReadComplete).toBe(false);
  });

  it("rejects an empty supply denominator instead of publishing an unbounded ratio", () => {
    expect(() =>
      adaptUsd1BundleOracle({
        bundle: encodeBundle(BUNDLE_TIMESTAMP, RESERVES_RAW),
        latestBundleTimestamp: BigInt(BUNDLE_TIMESTAMP),
        bundleDecimals: [18],
        supply: makeSupply({ contributions: [] }),
      }),
    ).toThrow("zero USD1 supply");
  });

  it("rejects mismatched bundle timestamps", () => {
    expect(() =>
      adaptUsd1BundleOracle({
        bundle: encodeBundle(BUNDLE_TIMESTAMP, RESERVES_RAW),
        latestBundleTimestamp: 1776154000n,
        bundleDecimals: [18],
        supply: makeSupply(),
      }),
    ).toThrow("timestamp mismatch");
  });
});

const USD1_ORACLE = "0x691b74146cdba162449012aa32d3cbf5df77d4c4";
const TRON_GRID = "https://api.trongrid.io/wallet/triggerconstantcontract";
const TRON_USD1 = "TPFqcBAaaUMCSVRCqPaQ9QnzKhmuoLR6Rc";
const ETH_TOKEN = "0x0000000000000000000000000000000000000001";
const BSC_TOKEN = "0x0000000000000000000000000000000000000002";
const PLUME_TOKEN = "0x0000000000000000000000000000000000000003";

type ContractList = NonNullable<StablecoinMeta["contracts"]>;

const MULTICHAIN_CONTRACTS: ContractList = [
  { chain: "ethereum", address: ETH_TOKEN, decimals: 18 },
  { chain: "bsc", address: BSC_TOKEN, decimals: 18 },
  { chain: "tron", address: TRON_USD1, decimals: 18 },
  { chain: "solana", address: "SoLusd1", decimals: 6 },
  { chain: "aptos", address: "0xaptos", decimals: 6 },
];

function usd1Network(options: {
  ethereumSupply?: bigint | null;
  bscSupply?: bigint | null;
  tronSupply?: bigint | null;
  bundle?: string;
  bundleTimestamp?: bigint;
  bundleDecimals?: `0x${string}`;
} = {}): AdapterNetworkSpec {
  const oracleBundle = options.bundle ?? encodeAbiParameters(
    [{ type: "bytes" }],
    [encodeBundle(BUNDLE_TIMESTAMP, 3_000_000000000000000000n)],
  );
  return {
    block: { number: 12345, timestamp: BUNDLE_TIMESTAMP },
    rpc: {
      [`${USD1_ORACLE}:latestBundle()`]: oracleBundle,
      [`${USD1_ORACLE}:latestBundleTimestamp()`]: options.bundleTimestamp ?? BigInt(BUNDLE_TIMESTAMP),
      [`${USD1_ORACLE}:bundleDecimals()`]: options.bundleDecimals ?? encodeAbiParameters([{ type: "uint8[]" }], [[18]]),
      [`ethereum:${ETH_TOKEN}:totalSupply()`]: options.ethereumSupply === undefined
        ? 1_000_000000000000000000n
        : options.ethereumSupply,
      [`bsc:${BSC_TOKEN}:totalSupply()`]: options.bscSupply === undefined
        ? 500_000000000000000000n
        : options.bscSupply,
    },
    json: {
      [TRON_GRID]: async () => options.tronSupply == null
        ? { result: { result: false } }
        : { result: { result: true }, constant_result: [options.tronSupply.toString(16).padStart(64, "0")] },
    },
  };
}

describe("fetchUsd1BundleOracleReserves", () => {
  it.each([false, true])("aggregates every EVM and Tron deployment with inherited Ethereum pin=%s", async (inheritedPin) => {
    const { result, network } = await runAdapter("usd1-bundle-oracle", "usd1-world-liberty-financial", {
      coin: { contracts: MULTICHAIN_CONTRACTS },
      network: usd1Network({ tronSupply: 750_000000000000000000n }),
      nowSec: BUNDLE_TIMESTAMP,
      ...(inheritedPin ? { ctx: { observedBlock: { chain: "ethereum", number: 12345, timestamp: BUNDLE_TIMESTAMP } } } : {}),
    });
    expect(result.metadata?.observedBlock).toEqual({ chain: "ethereum", number: 12345, timestamp: BUNDLE_TIMESTAMP });

    // Ethereum-only would have published 3000/1000 = 3.0; the full liability is 2250.
    expect(result.metadata?.supplyUsd).toBeCloseTo(2250, 6);
    expect(result.metadata?.fundBackingTotalRatio).toBeCloseTo(3000 / 2250, 6);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.supplyReadComplete).toBe(true);
    expect((result.metadata?.supplyContributions as Array<{ chain: string }>).map(
      (contribution) => contribution.chain,
    )).toEqual(["ethereum", "bsc", "tron"]);
    expectWarnings(result, ["por-supply-chain-omitted"]);
    expect((result.warnings ?? []).find((warning) => warning.code === "por-supply-chain-omitted")?.effect).toBe("info");
    expect(network.rpcCalls.filter((call) => call.selector === "0x18160ddd").map((call) => call.chain).sort()).toEqual([
      "bsc",
      "ethereum",
    ]);
    expect(network.requests.filter((request) => request.url === TRON_GRID)).toHaveLength(1);
  });

  it("degrades instead of silently shrinking the denominator when a chain read fails", async () => {
    const { result } = await runAdapter("usd1-bundle-oracle", "usd1-world-liberty-financial", {
      coin: {
        contracts: [
          { chain: "ethereum", address: ETH_TOKEN, decimals: 18 },
          { chain: "bsc", address: BSC_TOKEN, decimals: 18 },
        ],
      },
      network: usd1Network({ bscSupply: null, tronSupply: null }),
      nowSec: BUNDLE_TIMESTAMP,
    });
    expect(result.metadata?.supplyUsd).toBeCloseTo(1000, 6);
    expect(result.metadata?.supplyReadComplete).toBe(false);
    expectWarningEffect(result, "partial-supply-read-failure", "degraded");
  });

  it("omits chains without a configured RPC as info instead of degrading the snapshot", async () => {
    const chainRpcs = new Map<string, ChainRpcConfig>([
      ["ethereum", {
        chainId: "ethereum",
        chainName: "Ethereum",
        type: "evm",
        rpcUrl: "https://ethereum-rpc.publicnode.com",
        explorerUrl: "https://etherscan.io",
      }],
    ]);
    const { result, network } = await runAdapter("usd1-bundle-oracle", "usd1-world-liberty-financial", {
      coin: {
        contracts: [
          { chain: "ethereum", address: ETH_TOKEN, decimals: 18 },
          { chain: "plume", address: PLUME_TOKEN, decimals: 18 },
        ],
      },
      network: usd1Network({ bscSupply: null, tronSupply: null }),
      nowSec: BUNDLE_TIMESTAMP,
      ctx: { chainRpcs },
    });

    // Plume is omitted up front rather than read, so only Ethereum is probed.
    expect(result.metadata?.supplyUsd).toBeCloseTo(1000, 6);
    expect(result.metadata?.supplyReadComplete).toBe(true);
    expect(network.rpcCalls.filter((call) => call.selector === "0x18160ddd")).toHaveLength(1);
    expectWarningEffect(result, "por-supply-chain-omitted", "info");
    expect(result.warnings?.some((warning) => warning.code === "partial-supply-read-failure")).not.toBe(true);
  });

  it("fails closed when the oracle bundle payload drops a required word", async () => {
    await expect(runAdapter("usd1-bundle-oracle", "usd1-world-liberty-financial", {
      coin: { contracts: [{ chain: "ethereum", address: ETH_TOKEN, decimals: 18 }] },
      network: usd1Network({ bundle: "0x1234", tronSupply: null }),
      nowSec: BUNDLE_TIMESTAMP,
      validate: false,
    })).rejects.toThrow();
  });

  it("fails when no chain supply read succeeds", async () => {
    await expect(runAdapter("usd1-bundle-oracle", "usd1-world-liberty-financial", {
      coin: { contracts: [{ chain: "ethereum", address: ETH_TOKEN, decimals: 18 }] },
      network: usd1Network({ ethereumSupply: null, tronSupply: null }),
      nowSec: BUNDLE_TIMESTAMP,
      validate: false,
    })).rejects.toThrow(/usd1-bundle-oracle/);
  });
});
