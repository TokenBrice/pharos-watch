import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/evm-rpc", () => ({
  fetchEvmCallHexAtBlock: vi.fn(),
  fetchEvmUint256AtBlock: vi.fn(),
}));

// Every sibling supplemental family reaches the network. Only the Aave family is
// under test here, so the other fetchers reject and their families fall back to an
// empty result, which is what the runtime does for a real upstream failure.
vi.mock("../yield-sync/sources", async (importOriginal) => {
  const actual = await importOriginal<typeof YieldSourcesModule>();
  const failingFamilyFetch = vi.fn(async () => {
    throw new Error("family stubbed by the Aave suite");
  });
  return {
    ...actual,
    fetchMorphoVaultSources: failingFamilyFetch,
    fetchPendleMarketSources: failingFamilyFetch,
    fetchYearnKongSources: failingFamilyFetch,
    fetchBeefySources: failingFamilyFetch,
    fetchVaultsFyiSources: failingFamilyFetch,
    fetchRoycoDawnSources: failingFamilyFetch,
    fetchCompoundV3SupplyRates: failingFamilyFetch,
  };
});

import type * as YieldSourcesModule from "../yield-sync/sources";
import { fetchEvmCallHexAtBlock, fetchEvmUint256AtBlock } from "../../lib/evm-rpc";
import { fetchAaveV3SupplyRates, type AaveV3RateTarget } from "../yield-sync/sources-rpc";
import { loadSupplementalSourceFamilies } from "../yield-sync/supplemental-source-families";
import type { ChainRpcConfig } from "../../lib/chain-registry";

const mockFetchEvmCallHexAtBlock = vi.mocked(fetchEvmCallHexAtBlock);
const mockFetchEvmUint256AtBlock = vi.mocked(fetchEvmUint256AtBlock);

afterEach(() => vi.clearAllMocks());

function makeChainRpcs(chains: string[] = ["ethereum", "arbitrum", "base"]): Map<string, ChainRpcConfig> {
  const map = new Map<string, ChainRpcConfig>();
  for (const chain of chains) {
    map.set(chain, {
      chainId: chain,
      chainName: chain,
      type: "evm",
      rpcUrl: `https://rpc.${chain}.example.com`,
      fallbackRpcUrl: `https://fallback.${chain}.example.com`,
      explorerUrl: `https://explorer.${chain}.example.com`,
    });
  }
  return map;
}

/**
 * Build a synthetic getReserveData response hex string.
 *
 * The Aave V3 Pool.getReserveData struct encodes several uint256 fields.
 * currentLiquidityRate is the 3rd field (zero-indexed: index 2), which
 * starts at byte offset 64 (characters 128–191 after stripping "0x").
 *
 * Fields before currentLiquidityRate:
 *   [0] configuration (uint256) — bytes 0–31
 *   [1] liquidityIndex (uint256) — bytes 32–63
 *   [2] currentLiquidityRate (uint256) — bytes 64–95  ← we care about this
 *   ...more fields follow
 */
function buildGetReserveDataHex(
  currentLiquidityRate: bigint,
  aTokenAddress = "0xBcca60bB61934080951369a648Fb03DF4F96263C",
): `0x${string}` {
  const configuration = "0".repeat(64); // slot 0
  const liquidityIndex = "0".repeat(64); // slot 1
  const liquidityRateHex = currentLiquidityRate.toString(16).padStart(64, "0"); // slot 2
  const slots3to7 = "0".repeat(64 * 5);
  const aToken = aTokenAddress.replace("0x", "").toLowerCase().padStart(64, "0"); // slot 8
  const trailing = "0".repeat(64 * 5); // remaining fields
  return `0x${configuration}${liquidityIndex}${liquidityRateHex}${slots3to7}${aToken}${trailing}` as `0x${string}`;
}

// RAY = 10^27
const RAY = 10n ** 27n;

// Helper: compute expected APY from a RAY-encoded rate
function expectedApy(rateFraction: number): number {
  const ratePerSecond = rateFraction / 31536000;
  return (Math.pow(1 + ratePerSecond, 31536000) - 1) * 100;
}

const USDC_TARGET: AaveV3RateTarget = {
  stablecoinId: "usdc-circle",
  symbol: "USDC",
  chain: "ethereum",
  assetAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
};

const USDT_TARGET: AaveV3RateTarget = {
  stablecoinId: "usdt-tether",
  symbol: "USDT",
  chain: "arbitrum",
  assetAddress: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
};

describe("fetchAaveV3SupplyRates", () => {
  it("converts a RAY-encoded currentLiquidityRate to APY correctly", async () => {
    // 5% nominal annual rate expressed in RAY
    const nominalRate = 0.05; // 5%
    const rayRate = BigInt(Math.round(nominalRate * Number(RAY)));
    const hex = buildGetReserveDataHex(rayRate);
    mockFetchEvmCallHexAtBlock.mockResolvedValue(hex);
    mockFetchEvmUint256AtBlock.mockResolvedValue(125_000_000_000_000n);

    const { results, telemetry } = await fetchAaveV3SupplyRates([USDC_TARGET], undefined, makeChainRpcs());

    expect(results).toHaveLength(1);
    const apy = results[0]?.apy ?? 0;
    // Continuous compounding of 5%/yr ≈ 5.127%
    expect(apy).toBeCloseTo(expectedApy(nominalRate), 2);
    expect(apy).toBeGreaterThan(5);
    expect(apy).toBeLessThan(6);
    expect(telemetry.resolvedTargetCount).toBe(1);
    expect(telemetry.emittedCount).toBe(1);
    expect(telemetry.missingTargetCount).toBe(0);
    expect(results[0]?.sourceTvlUsd).toBe(125_000_000);
  });

  it("correctly reads currentLiquidityRate from byte offset 128 (slot 2 in the struct)", async () => {
    // Use a 0.1% nominal annual rate: 0.001 * RAY = 1e24
    const rawRate = RAY / 1000n; // ~1e24 → nominal 0.1%/yr → APY ≈ 0.1%
    const hex = buildGetReserveDataHex(rawRate);
    mockFetchEvmCallHexAtBlock.mockResolvedValue(hex);
    mockFetchEvmUint256AtBlock.mockResolvedValue(50_000_000_000_000n);

    const { results } = await fetchAaveV3SupplyRates([USDC_TARGET], undefined, makeChainRpcs());
    expect(results).toHaveLength(1);
    // Sanity: a small but positive APY — should be close to 0.1%
    const apy = results[0]?.apy ?? 0;
    expect(apy).toBeGreaterThan(0);
    expect(apy).toBeLessThan(1);
  });

  it("returns empty results when RPC returns null", async () => {
    mockFetchEvmCallHexAtBlock.mockResolvedValue(null);

    const { results, telemetry } = await fetchAaveV3SupplyRates([USDC_TARGET], undefined, makeChainRpcs());
    expect(results).toEqual([]);
    expect(telemetry.missingReasonCounts["reserve-data-unavailable"]).toBe(1);
  });

  it("returns empty results when hex response is too short to contain currentLiquidityRate", async () => {
    // Only 64 chars = 32 bytes = 1 slot; need at least 3 slots (192 hex chars)
    mockFetchEvmCallHexAtBlock.mockResolvedValue("0x" + "ab".repeat(32) as `0x${string}`);

    const { results, telemetry } = await fetchAaveV3SupplyRates([USDC_TARGET], undefined, makeChainRpcs());
    expect(results).toEqual([]);
    expect(telemetry.missingReasonCounts["reserve-data-short"]).toBe(1);
  });

  it("returns empty results when chainRpcs is not provided", async () => {
    const { results, telemetry } = await fetchAaveV3SupplyRates([USDC_TARGET]);
    expect(results).toEqual([]);
    expect(mockFetchEvmCallHexAtBlock).not.toHaveBeenCalled();
    expect(telemetry.missingReasonCounts["no-chain-rpcs"]).toBe(1);
  });

  it("returns empty results when targets is empty", async () => {
    const { results } = await fetchAaveV3SupplyRates([], undefined, makeChainRpcs());
    expect(results).toEqual([]);
    expect(mockFetchEvmCallHexAtBlock).not.toHaveBeenCalled();
  });

  it("skips chains not in the Aave V3 pool address list", async () => {
    const unsupportedTarget: AaveV3RateTarget = {
      stablecoinId: "usdc-circle",
      symbol: "USDC",
      chain: "fantom",
      assetAddress: "0x04068da6c83afcfa0e13ba15a6696662335d5b75",
    };

    const { results, telemetry } = await fetchAaveV3SupplyRates(
      [unsupportedTarget],
      undefined,
      makeChainRpcs(["fantom"]),
    );
    expect(results).toEqual([]);
    expect(mockFetchEvmCallHexAtBlock).not.toHaveBeenCalled();
    expect(telemetry.missingReasonCounts["unsupported-pool-chain"]).toBe(1);
  });

  it("skips targets when no RPC config exists for the chain", async () => {
    // chainRpcs only has 'base', not 'ethereum'
    const { results, telemetry } = await fetchAaveV3SupplyRates([USDC_TARGET], undefined, makeChainRpcs(["base"]));
    expect(results).toEqual([]);
    expect(mockFetchEvmCallHexAtBlock).not.toHaveBeenCalled();
    expect(telemetry.missingReasonCounts["no-rpc-config"]).toBe(1);
  });

  it("handles multiple targets across different chains", async () => {
    const rate5pct = BigInt(Math.round(0.05 * Number(RAY)));
    const rate3pct = BigInt(Math.round(0.03 * Number(RAY)));

    mockFetchEvmCallHexAtBlock
      .mockResolvedValueOnce(buildGetReserveDataHex(rate5pct)) // USDC on ethereum
      .mockResolvedValueOnce(buildGetReserveDataHex(rate3pct)); // USDT on arbitrum
    mockFetchEvmUint256AtBlock
      .mockResolvedValueOnce(125_000_000_000_000n)
      .mockResolvedValueOnce(75_000_000_000_000n);

    const { results } = await fetchAaveV3SupplyRates(
      [USDC_TARGET, USDT_TARGET],
      undefined,
      makeChainRpcs(),
    );

    expect(results).toHaveLength(2);
    const usdc = results.find((row) => row.stablecoinId === "usdc-circle");
    const usdt = results.find((row) => row.stablecoinId === "usdt-tether");
    expect(usdc?.apy).toBeGreaterThan(5);
    expect(usdt?.apy).toBeGreaterThan(3);
    expect(usdt?.apy).toBeLessThan(5);
  });

  it("preserves per-market rows for same-stablecoin targets across chains", async () => {
    const rate5pct = BigInt(Math.round(0.05 * Number(RAY)));
    const rate3pct = BigInt(Math.round(0.03 * Number(RAY)));
    const baseTarget: AaveV3RateTarget = {
      stablecoinId: "usdc-circle",
      symbol: "USDC",
      chain: "base",
      assetAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    };

    mockFetchEvmCallHexAtBlock
      .mockResolvedValueOnce(buildGetReserveDataHex(rate5pct))
      .mockResolvedValueOnce(buildGetReserveDataHex(rate3pct));
    mockFetchEvmUint256AtBlock
      .mockResolvedValueOnce(125_000_000_000_000n)
      .mockResolvedValueOnce(75_000_000_000_000n);

    const { results, telemetry } = await fetchAaveV3SupplyRates(
      [USDC_TARGET, baseTarget],
      undefined,
      makeChainRpcs(),
    );

    expect(results).toHaveLength(2);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stablecoinId: "usdc-circle",
        chain: "ethereum",
        assetAddress: USDC_TARGET.assetAddress,
        sourceTvlUsd: 125_000_000,
      }),
      expect.objectContaining({
        stablecoinId: "usdc-circle",
        chain: "base",
        assetAddress: baseTarget.assetAddress,
        sourceTvlUsd: 75_000_000,
      }),
    ]));
    expect(telemetry.emittedCount).toBe(2);
  });

  it("excludes rates where APY is zero (zero liquidity rate)", async () => {
    mockFetchEvmCallHexAtBlock.mockResolvedValue(buildGetReserveDataHex(0n));

    const { results } = await fetchAaveV3SupplyRates([USDC_TARGET], undefined, makeChainRpcs());
    expect(results).toEqual([]);
  });

  it("encodes getReserveData calldata with selector + padded asset address", async () => {
    mockFetchEvmCallHexAtBlock.mockResolvedValue(null);

    await fetchAaveV3SupplyRates([USDC_TARGET], undefined, makeChainRpcs());

    expect(mockFetchEvmCallHexAtBlock).toHaveBeenCalledOnce();
    const callData = mockFetchEvmCallHexAtBlock.mock.calls[0][2] as string;

    // Must start with getReserveData selector
    expect(callData.startsWith("0x35ea6a75")).toBe(true);
    // The asset address must appear padded to 32 bytes (64 hex chars)
    const addressPart = callData.slice(10).toLowerCase(); // after selector
    expect(addressPart).toHaveLength(64);
    expect(addressPart).toContain(USDC_TARGET.assetAddress.replace("0x", "").toLowerCase());
  });

  it("stamps the run clock on every Aave candidate the family publishes", async () => {
    mockFetchEvmCallHexAtBlock.mockResolvedValue(
      buildGetReserveDataHex(BigInt(Math.round(0.05 * Number(RAY)))),
    );
    mockFetchEvmUint256AtBlock.mockResolvedValue(125_000_000_000_000n);

    const startSec = Math.floor(Date.now() / 1000);
    const { candidates } = await loadSupplementalSourceFamilies({
      startSec,
      chainRpcs: makeChainRpcs(),
    });

    const aaveCandidates = candidates.filter((candidate) =>
      candidate.yield.sourceKey.startsWith("aave-v3-onchain:"),
    );
    expect(aaveCandidates.length).toBeGreaterThan(0);
    for (const candidate of aaveCandidates) {
      expect(candidate.yield.currentApy).toBeGreaterThan(0);
      // B11/D8: the family — not the adapter — stamps the observation for Aave rows.
      // Without a finite stamp every candidate classifies `source-freshness-unknown`,
      // is rejected, and its coin can never score.
      expect(Number.isFinite(candidate.yield.sourceObservedAt)).toBe(true);
      expect(candidate.yield.sourceObservedAt).toBe(startSec);
      // No comparison anchor is used for this lane.
      expect(candidate.yield.comparisonAnchorObservedAt).toBeNull();
    }
  });

  it("calls the correct Aave V3 pool address for each chain", async () => {
    mockFetchEvmCallHexAtBlock.mockResolvedValue(null);

    const baseTarget: AaveV3RateTarget = {
      stablecoinId: "usdc-circle",
      symbol: "USDC",
      chain: "base",
      assetAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    };

    await fetchAaveV3SupplyRates([baseTarget], undefined, makeChainRpcs());

    expect(mockFetchEvmCallHexAtBlock).toHaveBeenCalledWith(
      "base",
      "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", // Aave V3 Base pool
      expect.any(String),
      "latest",
      expect.objectContaining({
        extraRpcUrls: [
          "https://fallback.base.example.com",
          "https://rpc.base.example.com",
        ],
        maxRetries: 2,
      }),
    );
  });
});
