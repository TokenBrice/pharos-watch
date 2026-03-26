import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/evm-rpc", () => ({
  fetchEvmUint256AtBlock: vi.fn(),
}));

import { fetchEvmUint256AtBlock } from "../../lib/evm-rpc";
import { fetchCompoundV3SupplyRates } from "../yield-sync/sources";

const mockEvmCall = vi.mocked(fetchEvmUint256AtBlock);

describe("fetchCompoundV3SupplyRates", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("derives APY from per-second supply rate", async () => {
    mockEvmCall
      .mockResolvedValueOnce(687_700_000_000_000_000n)
      .mockResolvedValueOnce(795_585_475n);

    const results = await fetchCompoundV3SupplyRates([
      { stablecoinId: "usdc-circle", chain: "ethereum", comet: "0xc3d688B66703497DAA19211EEdff47f25384cdc3", symbol: "USDC" },
    ]);
    expect(results.length).toBe(1);
    expect(results[0].stablecoinId).toBe("usdc-circle");
    expect(results[0].yield.currentApy).toBeGreaterThan(0);
    expect(results[0].yield.sourceKey).toContain("protocol-api:compound-v3-supply:");
  });

  it("returns empty on RPC failure", async () => {
    mockEvmCall.mockResolvedValue(null);
    const results = await fetchCompoundV3SupplyRates([
      { stablecoinId: "usdc-circle", chain: "ethereum", comet: "0xabc", symbol: "USDC" },
    ]);
    expect(results).toEqual([]);
  });
});
