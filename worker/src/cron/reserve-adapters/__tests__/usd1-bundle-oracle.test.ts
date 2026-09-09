import type * as EvmRpc from "../../../lib/evm-rpc";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters } from "viem/utils";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { ChainRpcConfig } from "../../../lib/chain-registry";

vi.mock("../../../lib/evm-rpc", async (importOriginal) => ({
  ...await importOriginal<typeof EvmRpc>(),
  fetchEvmBlockNumber: vi.fn(async (chain) => chain === "ethereum" ? 12345 : 54321),
  fetchEvmBlockTimestamp: vi.fn(async () => 1776154391),
}));

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  const { makeOnchainCallersMock } = await import("./helpers/onchain-callers-mock");
  const fetchOnchainUint256 = vi.fn();
  const fetchOnchainRawCall = vi.fn();
  return {
    ...actual,
    fetchErc20TotalSupply: vi.fn(),
    fetchTronErc20TotalSupply: vi.fn(),
    fetchOnchainUint256,
    fetchOnchainRawCall,
    makeOnchainCallers: makeOnchainCallersMock({
      uint256: fetchOnchainUint256,
      raw: fetchOnchainRawCall,
    }),
  };
});

import {
  adaptUsd1BundleOracle,
  fetchUsd1BundleOracleReserves,
  type Usd1SupplyAggregate,
} from "../usd1-bundle-oracle";
import {
  fetchErc20TotalSupply,
  fetchOnchainRawCall,
  fetchOnchainUint256,
  fetchTronErc20TotalSupply,
} from "../helpers";

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

describe("fetchUsd1BundleOracleReserves", () => {
  const config: LiveReservesConfig = {
    adapter: "usd1-bundle-oracle",
    version: 2,
    semantics: "single-asset",
    inputs: {
      primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
    },
    params: {
      rpcUrl: "https://ethereum-rpc.publicnode.com",
      fallbackRpcUrl: "https://eth.llamarpc.com",
    },
  };

  function makeCoin(contracts: StablecoinMeta["contracts"]): StablecoinMeta {
    return {
      id: "usd1-world-liberty-financial",
      name: "World Liberty Financial USD",
      symbol: "USD1",
      flags: {
        backing: "rwa-backed",
        pegCurrency: "USD",
        governance: "centralized",
        yieldBearing: false,
        rwa: true,
        navToken: false,
      },
      contracts,
    };
  }

  let signal: AbortSignal;

  beforeEach(() => {
    signal = new AbortController().signal;
    vi.clearAllMocks();
    // Promise.all invokes latestBundle() first, then bundleDecimals(); both go
    // through the raw caller and are returned ABI-encoded like a real eth_call.
    vi.mocked(fetchOnchainRawCall)
      .mockResolvedValueOnce(
        encodeAbiParameters(
          [{ type: "bytes" }],
          [encodeBundle(BUNDLE_TIMESTAMP, 3_000_000000000000000000n)],
        ),
      )
      .mockResolvedValueOnce(encodeAbiParameters([{ type: "uint8[]" }], [[18]]));
    vi.mocked(fetchOnchainUint256).mockResolvedValue(BigInt(BUNDLE_TIMESTAMP));
  });

  it.each([false, true])("aggregates every EVM and Tron deployment with inherited Ethereum pin=%s", async (inheritedPin) => {
    const coin = makeCoin([
      { chain: "ethereum", address: "0xeth", decimals: 18 },
      { chain: "bsc", address: "0xbsc", decimals: 18 },
      { chain: "tron", address: "Ttron", decimals: 18 },
      { chain: "solana", address: "SoLusd1", decimals: 6 },
      { chain: "aptos", address: "0xaptos", decimals: 6 },
    ]);

    vi.mocked(fetchErc20TotalSupply)
      .mockResolvedValueOnce(1_000_000000000000000000n) // ethereum
      .mockResolvedValueOnce(500_000000000000000000n); // bsc
    vi.mocked(fetchTronErc20TotalSupply).mockResolvedValueOnce(750_000000000000000000n);

    const result = await fetchUsd1BundleOracleReserves(coin, config, signal, {
      nowSec: BUNDLE_TIMESTAMP,
      ...(inheritedPin ? { observedBlock: { chain: "ethereum", number: 12345, timestamp: BUNDLE_TIMESTAMP } } : {}),
    });
    expect(result.metadata?.observedBlock).toEqual({ chain: "ethereum", number: 12345, timestamp: 1776154391 });
    for (const [request] of [...vi.mocked(fetchOnchainRawCall).mock.calls, ...vi.mocked(fetchOnchainUint256).mock.calls]) {
      expect(request.ctx?.observedBlock).toEqual(result.metadata?.observedBlock);
    }
    expect(vi.mocked(fetchErc20TotalSupply).mock.calls.map((call) => call[3]?.observedBlock)).toEqual([
      { chain: "ethereum", number: 12345, timestamp: 1776154391 },
      { chain: "bsc", number: 54321, timestamp: 1776154391 },
    ]);

    // Ethereum-only would have published 3000/1000 = 3.0; the full liability is 2250.
    expect(result.metadata?.supplyUsd).toBeCloseTo(2250, 6);
    expect(result.metadata?.fundBackingTotalRatio).toBeCloseTo(3000 / 2250, 6);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.supplyReadComplete).toBe(true);

    const contributionChains = (result.metadata?.supplyContributions as Array<{ chain: string }>).map(
      (contribution) => contribution.chain,
    );
    expect(contributionChains).toEqual(["ethereum", "bsc", "tron"]);

    const omitted = result.warnings?.find((warning) => warning.code === "por-supply-chain-omitted");
    expect(omitted?.effect).toBe("info");
    expect(omitted?.message).toContain("solana");
    expect(omitted?.message).toContain("aptos");

    expect(fetchErc20TotalSupply).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetchErc20TotalSupply).mock.calls.map((call) => call[0]?.chain)).toEqual([
      "ethereum",
      "bsc",
    ]);
    expect(fetchTronErc20TotalSupply).toHaveBeenCalledTimes(1);
  });

  it("degrades instead of silently shrinking the denominator when a chain read fails", async () => {
    const coin = makeCoin([
      { chain: "ethereum", address: "0xeth", decimals: 18 },
      { chain: "bsc", address: "0xbsc", decimals: 18 },
    ]);

    vi.mocked(fetchErc20TotalSupply)
      .mockResolvedValueOnce(1_000_000000000000000000n) // ethereum
      .mockResolvedValueOnce(null); // bsc read failed

    const result = await fetchUsd1BundleOracleReserves(coin, config, signal, { nowSec: BUNDLE_TIMESTAMP });

    expect(result.metadata?.supplyUsd).toBeCloseTo(1000, 6);
    expect(result.metadata?.supplyReadComplete).toBe(false);
    const failure = result.warnings?.find((warning) => warning.code === "partial-supply-read-failure");
    expect(failure?.effect).toBe("degraded");
    expect(failure?.message).toContain("bsc");
  });

  it("omits chains without a configured RPC as info instead of degrading the snapshot", async () => {
    const coin = makeCoin([
      { chain: "ethereum", address: "0xeth", decimals: 18 },
      { chain: "plume", address: "0xplume", decimals: 18 },
    ]);

    const chainRpcs = new Map<string, ChainRpcConfig>([
      ["ethereum", {
        chainId: "ethereum",
        chainName: "Ethereum",
        type: "evm",
        rpcUrl: "https://ethereum-rpc.publicnode.com",
        explorerUrl: "https://etherscan.io",
      }],
    ]);

    vi.mocked(fetchErc20TotalSupply).mockResolvedValueOnce(1_000_000000000000000000n); // ethereum

    const result = await fetchUsd1BundleOracleReserves(coin, config, signal, {
      nowSec: BUNDLE_TIMESTAMP,
      chainRpcs,
    });

    // Plume is omitted up front rather than read, so only Ethereum is probed.
    expect(result.metadata?.supplyUsd).toBeCloseTo(1000, 6);
    expect(result.metadata?.supplyReadComplete).toBe(true);
    expect(fetchErc20TotalSupply).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchErc20TotalSupply).mock.calls.map((call) => call[0]?.chain)).toEqual(["ethereum"]);

    const omitted = result.warnings?.find((warning) => warning.code === "por-supply-chain-omitted");
    expect(omitted?.effect).toBe("info");
    expect(omitted?.message).toContain("no RPC configured");
    expect(omitted?.message).toContain("plume");
    expect(result.warnings?.some((warning) => warning.code === "partial-supply-read-failure")).not.toBe(true);
  });

  it("fails when no chain supply read succeeds", async () => {
    const coin = makeCoin([{ chain: "ethereum", address: "0xeth", decimals: 18 }]);
    vi.mocked(fetchErc20TotalSupply).mockResolvedValue(null);

    await expect(
      fetchUsd1BundleOracleReserves(coin, config, signal, { nowSec: BUNDLE_TIMESTAMP }),
    ).rejects.toThrow(/usd1-bundle-oracle/);
  });
});
