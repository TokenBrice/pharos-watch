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

  it("uses get_dy_underlying selector when useUnderlying is true", async () => {
    const lusdOutput = BigInt("999000000000000000"); // 0.999e18
    const mockHex = ("0x" + lusdOutput.toString(16).padStart(64, "0")) as `0x${string}`;
    mockEvmCall.mockResolvedValue(mockHex);

    const config: CurvePoolConfig = {
      stablecoinId: "lusd-liquity",
      poolAddress: "0xEd279fDD11cA84bEef15AF5D39BB4d4bEE23F0cA",
      inputIndex: 2,  // USDC (underlying)
      outputIndex: 0, // LUSD (underlying)
      inputDecimals: 6,
      outputDecimals: 18,
      chain: "ethereum",
      useUnderlying: true,
    };
    const results = await fetchCurveOnchainPrices([config]);
    expect(results.get("lusd-liquity")).toBeCloseTo(1.001, 3);

    // Verify the underlying selector was used, not get_dy
    const calldata = mockEvmCall.mock.calls[0][2] as string;
    expect(calldata.startsWith("0x07211ef7")).toBe(true);
  });

  it("resolves hop prices by multiplying with via-token price", async () => {
    const crvusdOutput = BigInt("999000000000000000"); // 0.999e18 crvUSD per 1 USDC
    const ghoOutput = BigInt("998000000000000000"); // 0.998e18 GHO per 1e18 crvUSD

    mockEvmCall
      .mockResolvedValueOnce(("0x" + crvusdOutput.toString(16).padStart(64, "0")) as `0x${string}`)
      .mockResolvedValueOnce(("0x" + ghoOutput.toString(16).padStart(64, "0")) as `0x${string}`);

    const configs: CurvePoolConfig[] = [
      {
        stablecoinId: "crvusd-curve",
        poolAddress: "0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E",
        inputIndex: 0, outputIndex: 1,
        inputDecimals: 6, outputDecimals: 18,
        chain: "ethereum",
      },
      {
        stablecoinId: "gho-aave",
        poolAddress: "0x0001000100010001000100010001000100010001",
        inputIndex: 0, outputIndex: 1,
        inputDecimals: 18, outputDecimals: 18,
        chain: "ethereum",
        hop: { viaStablecoinId: "crvusd-curve" },
      },
    ];

    const results = await fetchCurveOnchainPrices(configs);
    expect(results.get("crvusd-curve")).toBeCloseTo(1.001, 3);
    const expectedGho = (1.0 / 0.998) * (1.0 / 0.999);
    expect(results.get("gho-aave")).toBeCloseTo(expectedGho, 3);
  });

  it("excludes hop coin when via-token RPC fails", async () => {
    mockEvmCall
      .mockResolvedValueOnce(null) // crvUSD fails
      .mockResolvedValueOnce(("0x" + BigInt("998000000000000000").toString(16).padStart(64, "0")) as `0x${string}`);

    const configs: CurvePoolConfig[] = [
      {
        stablecoinId: "crvusd-curve",
        poolAddress: "0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E",
        inputIndex: 0, outputIndex: 1,
        inputDecimals: 6, outputDecimals: 18,
        chain: "ethereum",
      },
      {
        stablecoinId: "gho-aave",
        poolAddress: "0x0001000100010001000100010001000100010001",
        inputIndex: 0, outputIndex: 1,
        inputDecimals: 18, outputDecimals: 18,
        chain: "ethereum",
        hop: { viaStablecoinId: "crvusd-curve" },
      },
    ];

    const results = await fetchCurveOnchainPrices(configs);
    expect(results.has("crvusd-curve")).toBe(false);
    expect(results.has("gho-aave")).toBe(false);
  });

  it("truncates oversized Vyper return data to first uint256 word", async () => {
    // Vyper metapools return thousands of bytes; only the first 32-byte word
    // is the actual get_dy_underlying result (~0.984 LUSD for 1 USDC)
    const actualValue = BigInt("984321781412057132"); // ~0.984e18 LUSD
    const word0 = actualValue.toString(16).padStart(64, "0");
    // Simulate Vyper response: word0 + extra trailing data
    const trailing = "00000002" + "0".repeat(56) + "0".repeat(64) + "000f4240" + "0".repeat(56);
    const vyperHex = ("0x" + word0 + trailing) as `0x${string}`;
    expect(vyperHex.length).toBeGreaterThan(66);

    mockEvmCall.mockResolvedValue(vyperHex);

    const config: CurvePoolConfig = {
      stablecoinId: "lusd-liquity",
      poolAddress: "0xEd279fDD11cA84bEef15AF5D39BB4d4bEE23F0cA",
      inputIndex: 2, outputIndex: 0,
      inputDecimals: 6, outputDecimals: 18,
      chain: "ethereum",
      useUnderlying: true,
    };
    const results = await fetchCurveOnchainPrices([config]);
    expect(results.get("lusd-liquity")).toBeCloseTo(1.016, 2);
  });

  it("throws when a hop references another hop config", async () => {
    const configs: CurvePoolConfig[] = [
      {
        stablecoinId: "token-a",
        poolAddress: "0x0000000000000000000000000000000000000001",
        inputIndex: 0, outputIndex: 1,
        inputDecimals: 18, outputDecimals: 18,
        chain: "ethereum",
        hop: { viaStablecoinId: "token-b" },
      },
      {
        stablecoinId: "token-b",
        poolAddress: "0x0000000000000000000000000000000000000002",
        inputIndex: 0, outputIndex: 1,
        inputDecimals: 18, outputDecimals: 18,
        chain: "ethereum",
        hop: { viaStablecoinId: "token-c" },
      },
    ];

    await expect(fetchCurveOnchainPrices(configs)).rejects.toThrow(/chained hop/i);
  });
});
