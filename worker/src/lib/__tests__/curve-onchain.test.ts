import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchCurveOnchainPrices, type CurvePoolConfig } from "../curve-onchain";

vi.mock("../evm-rpc", () => ({
  fetchEvmCallHexAtBlock: vi.fn(),
}));
import { fetchEvmCallHexAtBlock } from "../evm-rpc";
const mockEvmCall = vi.mocked(fetchEvmCallHexAtBlock);

afterEach(() => vi.clearAllMocks());

describe("fetchCurveOnchainPrices", () => {
  it("parses get_dy response into implied price", async () => {
    // get_dy(1, 2, 1e6) returns 999000 for USDT (6 decimals out)
    // Implied price = 999000 / 1e6 = 0.999
    const mockHexResponse = ("0x" + BigInt(999000).toString(16).padStart(64, "0")) as `0x${string}`;
    mockEvmCall.mockResolvedValue(mockHexResponse);

    const config: CurvePoolConfig = {
      stablecoinId: "usdt-tether",
      poolAddress: "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7",
      inputIndex: 1,
      outputIndex: 2,
      inputDecimals: 6,
      outputDecimals: 6,
      chain: "ethereum",
    };
    const results = await fetchCurveOnchainPrices([config]);
    expect(results.size).toBe(1);
    expect(results.get("usdt-tether")).toBeCloseTo(0.999, 3);
    expect(mockEvmCall).toHaveBeenCalledWith(
      "ethereum", config.poolAddress, expect.any(String), "latest", expect.any(Object),
    );
  });

  it("returns empty map when RPC returns null", async () => {
    mockEvmCall.mockResolvedValue(null);
    const config: CurvePoolConfig = {
      stablecoinId: "usdt-tether",
      poolAddress: "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7",
      inputIndex: 1, outputIndex: 2,
      inputDecimals: 6, outputDecimals: 6,
      chain: "ethereum",
    };
    const results = await fetchCurveOnchainPrices([config]);
    expect(results.size).toBe(0);
  });
});
