import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/evm-rpc", () => ({
  fetchEvmCallHexAtBlock: vi.fn(),
  fetchEvmUint256AtBlock: vi.fn(),
}));

import { fetchEvmCallHexAtBlock } from "../../lib/evm-rpc";
import { fetchAaveV3SupplyRates, type AaveV3RateTarget } from "../yield-sync/sources";
import type { ChainRpcConfig } from "../../lib/chain-registry";

const mockFetchEvmCallHexAtBlock = vi.mocked(fetchEvmCallHexAtBlock);

afterEach(() => vi.clearAllMocks());

function makeChainRpcs(chains: string[] = ["ethereum", "arbitrum", "base"]): Map<string, ChainRpcConfig> {
  const map = new Map<string, ChainRpcConfig>();
  for (const chain of chains) {
    map.set(chain, {
      chainId: chain,
      chainName: chain,
      type: "evm",
      rpcUrl: `https://rpc.${chain}.example.com`,
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
function buildGetReserveDataHex(currentLiquidityRate: bigint): `0x${string}` {
  const configuration = "0".repeat(64); // slot 0
  const liquidityIndex = "0".repeat(64); // slot 1
  const liquidityRateHex = currentLiquidityRate.toString(16).padStart(64, "0"); // slot 2
  const trailing = "0".repeat(64 * 5); // remaining fields
  return `0x${configuration}${liquidityIndex}${liquidityRateHex}${trailing}` as `0x${string}`;
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

    const { rates } = await fetchAaveV3SupplyRates([USDC_TARGET], undefined, makeChainRpcs());

    expect(rates.has("usdc-circle")).toBe(true);
    const apy = rates.get("usdc-circle")!.apy;
    // Continuous compounding of 5%/yr ≈ 5.127%
    expect(apy).toBeCloseTo(expectedApy(nominalRate), 2);
    expect(apy).toBeGreaterThan(5);
    expect(apy).toBeLessThan(6);
  });

  it("correctly reads currentLiquidityRate from byte offset 128 (slot 2 in the struct)", async () => {
    // Use a 0.1% nominal annual rate: 0.001 * RAY = 1e24
    const rawRate = RAY / 1000n; // ~1e24 → nominal 0.1%/yr → APY ≈ 0.1%
    const hex = buildGetReserveDataHex(rawRate);
    mockFetchEvmCallHexAtBlock.mockResolvedValue(hex);

    const { rates } = await fetchAaveV3SupplyRates([USDC_TARGET], undefined, makeChainRpcs());
    expect(rates.has("usdc-circle")).toBe(true);
    // Sanity: a small but positive APY — should be close to 0.1%
    const apy = rates.get("usdc-circle")!.apy;
    expect(apy).toBeGreaterThan(0);
    expect(apy).toBeLessThan(1);
  });

  it("returns empty map when RPC returns null", async () => {
    mockFetchEvmCallHexAtBlock.mockResolvedValue(null);

    const { rates } = await fetchAaveV3SupplyRates([USDC_TARGET], undefined, makeChainRpcs());
    expect(rates.size).toBe(0);
  });

  it("returns empty map when hex response is too short to contain currentLiquidityRate", async () => {
    // Only 64 chars = 32 bytes = 1 slot; need at least 3 slots (192 hex chars)
    mockFetchEvmCallHexAtBlock.mockResolvedValue("0x" + "ab".repeat(32) as `0x${string}`);

    const { rates } = await fetchAaveV3SupplyRates([USDC_TARGET], undefined, makeChainRpcs());
    expect(rates.size).toBe(0);
  });

  it("returns empty map when chainRpcs is not provided", async () => {
    const { rates } = await fetchAaveV3SupplyRates([USDC_TARGET]);
    expect(rates.size).toBe(0);
    expect(mockFetchEvmCallHexAtBlock).not.toHaveBeenCalled();
  });

  it("returns empty map when targets is empty", async () => {
    const { rates } = await fetchAaveV3SupplyRates([], undefined, makeChainRpcs());
    expect(rates.size).toBe(0);
    expect(mockFetchEvmCallHexAtBlock).not.toHaveBeenCalled();
  });

  it("skips chains not in the Aave V3 pool address list", async () => {
    const unsupportedTarget: AaveV3RateTarget = {
      stablecoinId: "usdc-circle",
      symbol: "USDC",
      chain: "fantom",
      assetAddress: "0x04068da6c83afcfa0e13ba15a6696662335d5b75",
    };

    const { rates } = await fetchAaveV3SupplyRates(
      [unsupportedTarget],
      undefined,
      makeChainRpcs(["fantom"]),
    );
    expect(rates.size).toBe(0);
    expect(mockFetchEvmCallHexAtBlock).not.toHaveBeenCalled();
  });

  it("skips targets when no RPC config exists for the chain", async () => {
    // chainRpcs only has 'base', not 'ethereum'
    const { rates } = await fetchAaveV3SupplyRates([USDC_TARGET], undefined, makeChainRpcs(["base"]));
    expect(rates.size).toBe(0);
    expect(mockFetchEvmCallHexAtBlock).not.toHaveBeenCalled();
  });

  it("handles multiple targets across different chains", async () => {
    const rate5pct = BigInt(Math.round(0.05 * Number(RAY)));
    const rate3pct = BigInt(Math.round(0.03 * Number(RAY)));

    mockFetchEvmCallHexAtBlock
      .mockResolvedValueOnce(buildGetReserveDataHex(rate5pct)) // USDC on ethereum
      .mockResolvedValueOnce(buildGetReserveDataHex(rate3pct)); // USDT on arbitrum

    const { rates } = await fetchAaveV3SupplyRates(
      [USDC_TARGET, USDT_TARGET],
      undefined,
      makeChainRpcs(),
    );

    expect(rates.has("usdc-circle")).toBe(true);
    expect(rates.has("usdt-tether")).toBe(true);
    expect(rates.get("usdc-circle")!.apy).toBeGreaterThan(5);
    expect(rates.get("usdt-tether")!.apy).toBeGreaterThan(3);
    expect(rates.get("usdt-tether")!.apy).toBeLessThan(5);
  });

  it("excludes rates where APY is zero (zero liquidity rate)", async () => {
    mockFetchEvmCallHexAtBlock.mockResolvedValue(buildGetReserveDataHex(0n));

    const { rates } = await fetchAaveV3SupplyRates([USDC_TARGET], undefined, makeChainRpcs());
    expect(rates.size).toBe(0);
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
      expect.any(Object),
    );
  });
});
