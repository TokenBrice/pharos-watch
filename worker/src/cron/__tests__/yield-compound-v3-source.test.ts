import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/evm-rpc", () => ({
  fetchEvmUint256AtBlock: vi.fn(),
}));

import { fetchEvmUint256AtBlock } from "../../lib/evm-rpc";
import { fetchCompoundV3SupplyRates } from "../yield-sync/sources";
import type { ChainRpcConfig } from "../../lib/chain-registry";

const mockEvmCall = vi.mocked(fetchEvmUint256AtBlock);

function makeChainRpcs(chains: string[] = ["ethereum"]): Map<string, ChainRpcConfig> {
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

describe("fetchCompoundV3SupplyRates", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("derives APY from per-second supply rate", async () => {
    mockEvmCall
      .mockResolvedValueOnce(687_700_000_000_000_000n)
      .mockResolvedValueOnce(795_585_475n);

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
    expect(results[0].yield.sourceKey).toContain("protocol-api:compound-v3-supply:");
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
        maxRetries: 2,
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
      .mockResolvedValueOnce(795_585_475n);

    const chainRpcs = new Map<string, ChainRpcConfig>([[
      "ethereum",
      {
        chainId: "ethereum",
        chainName: "ethereum",
        type: "evm",
        rpcUrl: "https://rpc.ethereum.example.com",
        explorerUrl: "https://explorer.ethereum.example.com",
      },
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
