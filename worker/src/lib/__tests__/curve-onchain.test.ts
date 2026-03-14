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
    // Implied price = inputFloat/outputFloat = 1.0/0.999 ≈ 1.001
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
    expect(results.get("usdt-tether")).toBeCloseTo(1.001, 3);
    expect(mockEvmCall).toHaveBeenCalledWith(
      "ethereum", config.poolAddress, expect.any(String), "latest", expect.any(Object),
    );
  });

  it("computes correct implied price when pool is imbalanced (depeg scenario)", async () => {
    // Depeg: USDT at $0.95 → get_dy returns ~1.053e6 USDT per 1e6 USDC
    // Correct: inputFloat/outputFloat = 1.0/1.052632 ≈ 0.95
    const mockHex = ("0x" + BigInt(1_052_632).toString(16).padStart(64, "0")) as `0x${string}`;
    mockEvmCall.mockResolvedValue(mockHex);

    const config: CurvePoolConfig = {
      stablecoinId: "usdt-tether",
      poolAddress: "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7",
      inputIndex: 1, outputIndex: 2,
      inputDecimals: 6, outputDecimals: 6,
      chain: "ethereum",
    };
    const results = await fetchCurveOnchainPrices([config]);
    expect(results.get("usdt-tether")).toBeCloseTo(0.95, 2);
  });

  it("computes correct implied price with different decimals (DAI 18 decimals)", async () => {
    // 1 USDC (1e6) → 1.001e18 DAI → price = 1.0/1.001 ≈ 0.999
    const daiOutput = BigInt("1001000000000000000");
    const mockHex = ("0x" + daiOutput.toString(16).padStart(64, "0")) as `0x${string}`;
    mockEvmCall.mockResolvedValue(mockHex);

    const config: CurvePoolConfig = {
      stablecoinId: "dai-makerdao",
      poolAddress: "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7",
      inputIndex: 1, outputIndex: 0,
      inputDecimals: 6, outputDecimals: 18,
      chain: "ethereum",
    };
    const results = await fetchCurveOnchainPrices([config]);
    expect(results.get("dai-makerdao")).toBeCloseTo(0.999, 3);
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
