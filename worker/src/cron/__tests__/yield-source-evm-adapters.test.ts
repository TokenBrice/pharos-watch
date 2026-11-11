import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/evm-rpc", () => ({
  fetchEvmUint256AtBlock: vi.fn(),
}));

import type { ChainRpcConfig } from "../../lib/chain-registry";
import { fetchEvmUint256AtBlock } from "../../lib/evm-rpc";
import { makeChainRpcConfig } from "../../test-helpers/chain-rpc-fixtures.test-support";
import { fetchCompoundV3SupplyRates } from "../yield-sync/sources-rpc";
import { fetchOndoUsdyOracleSource } from "../yield-sync/sources-optional";

const mockEvmCall = vi.mocked(fetchEvmUint256AtBlock);

function makeChainRpcs(chains: string[] = ["ethereum"]): Map<string, ChainRpcConfig> {
  return new Map(chains.map((chain): [string, ChainRpcConfig] => [
    chain,
    makeChainRpcConfig({
      chainId: chain,
      rpcUrls: [`https://rpc.${chain}.example.com`, `https://fallback.${chain}.example.com`],
      explorerUrl: `https://explorer.${chain}.example.com`,
    }),
  ]));
}

describe("fetchOndoUsdyOracleSource", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("derives APY from USDY oracle price vs prior price", async () => {
    mockEvmCall.mockResolvedValue(1_085_000_000_000_000_000n);
    const result = await fetchOndoUsdyOracleSource(
      1.0835, 7, 1_771_000_000,
    );
    expect(result).toEqual(expect.objectContaining({
      dataSource: "protocol-api",
      sourceKey: "protocol-api:ondo-usdy-oracle",
    }));
    expect(result!.currentApy).toBeCloseTo(7.4855, 4);
  });

  it("retains a finite negative USDY NAV return and its next history anchor", async () => {
    mockEvmCall.mockResolvedValue(990_000_000_000_000_000n);
    const anchor = 1_771_000_000;
    const result = await fetchOndoUsdyOracleSource(1, 7, anchor);
    expect(result?.currentApy).toBeCloseTo((Math.pow(0.99, 365.25 / 7) - 1) * 100);
    expect(result?.apyBase).toBe(result?.currentApy);
    expect(result).toMatchObject({ exchangeRate: 0.99, comparisonAnchorObservedAt: anchor });
  });

  it("returns seed row when no prior price exists", async () => {
    mockEvmCall.mockResolvedValue(1_085_000_000_000_000_000n);
    const result = await fetchOndoUsdyOracleSource(null, 0, null);
    expect(result).toEqual(expect.objectContaining({
      currentApy: 0,
      observationKind: "anchor-only",
      exchangeRate: expect.closeTo(1.085, 2),
      sourceKey: "protocol-api:ondo-usdy-oracle",
    }));
  });

  it("keeps a flat measured return distinct from a bootstrap anchor", async () => {
    mockEvmCall.mockResolvedValue(1_000_000_000_000_000_000n);
    const result = await fetchOndoUsdyOracleSource(1, 7, 1_771_000_000);
    expect(result).toMatchObject({ currentApy: 0, apyBase: 0, exchangeRate: 1 });
    expect(result?.observationKind).toBeUndefined();
  });

  it("returns null when oracle call fails", async () => {
    mockEvmCall.mockResolvedValue(null);
    const result = await fetchOndoUsdyOracleSource(null, 7, null);
    expect(result).toBeNull();
  });
});

describe("fetchCompoundV3SupplyRates", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("derives APY from per-second supply rate", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockEvmCall
      .mockResolvedValueOnce(687_700_000_000_000_000n)
      .mockResolvedValueOnce(795_585_475n)
      .mockResolvedValueOnce(125_000_000_000_000n);

    const { results, telemetry } = await fetchCompoundV3SupplyRates(
      [
        { stablecoinId: "usdc-circle", chain: "ethereum", comet: "0xc3d688B66703497DAA19211EEdff47f25384cdc3", symbol: "USDC" },
      ],
      undefined,
      makeChainRpcs(),
    );
    expect(results.length).toBe(1);
    expect(results[0].stablecoinId).toBe("usdc-circle");
    expect(results[0].yield.currentApy).toBeGreaterThan(0);
    expect(results[0].yield.sourcePool).toBe("0xc3d688B66703497DAA19211EEdff47f25384cdc3");
    expect(results[0].yield.sourceTvlUsd).toBe(125_000_000);
    expect(results[0].yield.sourceKey).toContain("protocol-api:compound-v3-supply:");
    // B11/D8: `sourceObservedAt` is what lets the row score at all; a dropped or
    // non-finite stamp silently leaves the coin unscorable.
    expect(Number.isFinite(results[0].yield.sourceObservedAt)).toBe(true);
    expect(results[0].yield.sourceObservedAt).toBeGreaterThan(nowSec - 60);
    expect(results[0].yield.sourceObservedAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(results[0].yield.comparisonAnchorObservedAt).toBeNull();
    expect(telemetry.resolvedTargetCount).toBe(1);
    expect(telemetry.emittedCount).toBe(1);
    expect(telemetry.missingTargetCount).toBe(0);
    expect(mockEvmCall).toHaveBeenCalledWith(
      "ethereum",
      "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
      expect.any(String),
      "latest",
      expect.objectContaining({
        extraRpcUrls: [
          "https://fallback.ethereum.example.com",
          "https://rpc.ethereum.example.com",
        ],
        // B-lane pacing: transport retries stay off so a stalled URL fails over
        // to the alternate endpoint before either one is retried.
        maxRetries: 0,
      }),
    );
  });

  it("returns empty telemetry on RPC failure", async () => {
    mockEvmCall.mockResolvedValue(null);
    const { results, telemetry } = await fetchCompoundV3SupplyRates(
      [{ stablecoinId: "usdc-circle", chain: "ethereum", comet: "0xabc", symbol: "USDC" }],
      undefined,
      makeChainRpcs(),
    );
    expect(results).toEqual([]);
    expect(telemetry.missingTargetCount).toBe(1);
    expect(telemetry.missingReasonCounts["utilization-unavailable"]).toBe(1);
  });

  it("still probes the primary RPC when no fallback URL exists", async () => {
    mockEvmCall
      .mockResolvedValueOnce(687_700_000_000_000_000n)
      .mockResolvedValueOnce(795_585_475n)
      .mockResolvedValueOnce(25_000_000_000_000n);

    const chainRpcs = new Map<string, ChainRpcConfig>([[
      "ethereum",
      makeChainRpcConfig({
        chainId: "ethereum",
        rpcUrls: ["https://rpc.ethereum.example.com"],
        explorerUrl: "https://explorer.ethereum.example.com",
      }),
    ]]);

    const { results } = await fetchCompoundV3SupplyRates(
      [{ stablecoinId: "usdc-circle", chain: "ethereum", comet: "0xabc", symbol: "USDC" }],
      undefined,
      chainRpcs,
    );

    expect(results).toHaveLength(1);
    expect(mockEvmCall).toHaveBeenCalledWith(
      "ethereum",
      "0xabc",
      expect.any(String),
      "latest",
      expect.objectContaining({
        extraRpcUrls: ["https://rpc.ethereum.example.com"],
      }),
    );
  });
});
