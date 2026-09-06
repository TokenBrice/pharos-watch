import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CURVE_POOL_CONFIGS, type CurvePoolConfig } from "@shared/lib/curve-pool-configs";
import { fetchCurveOnchainPrices } from "../curve-onchain";

vi.mock("../evm-rpc", () => ({
  fetchEvmBlockNumber: vi.fn(),
  fetchEvmBlockTimestamp: vi.fn(),
  fetchEvmCallHexAtBlock: vi.fn(),
}));
import { fetchEvmBlockNumber, fetchEvmBlockTimestamp, fetchEvmCallHexAtBlock } from "../evm-rpc";
const mockEvmCall = vi.mocked(fetchEvmCallHexAtBlock);
const mockBlockNumber = vi.mocked(fetchEvmBlockNumber);
const mockBlockTimestamp = vi.mocked(fetchEvmBlockTimestamp);

const FRESH_BLOCK_NUMBER = 19_000_000;
const FRESH_BLOCK_TIMESTAMP = Math.floor(Date.now() / 1000) - 30; // 30s ago
const THREE_POOL_ADDRESS = "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7";

function hexWord(value: bigint | number | string): `0x${string}` {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}` as `0x${string}`;
}

function makeCurveConfig(overrides: Partial<CurvePoolConfig> = {}): CurvePoolConfig {
  return {
    stablecoinId: "usdt-tether",
    poolAddress: THREE_POOL_ADDRESS,
    inputIndex: 1,
    outputIndex: 2,
    inputDecimals: 6,
    outputDecimals: 6,
    chain: "ethereum",
    ...overrides,
  };
}

beforeEach(() => {
  mockBlockNumber.mockResolvedValue(FRESH_BLOCK_NUMBER);
  mockBlockTimestamp.mockResolvedValue(FRESH_BLOCK_TIMESTAMP);
});
afterEach(() => vi.clearAllMocks());

describe("fetchCurveOnchainPrices", () => {
  it("includes verified safe direct Curve configs with explicit indices and decimals", () => {
    const byId = new Map(CURVE_POOL_CONFIGS.map((config) => [config.stablecoinId, config]));
    const expectedConfigs = [
      ["usdat-saturn", "0xF4d0CF32908b2C7f1021339c43Df0F77f06896d7", 0, 1, 6, 6],
      ["apxusd-apyx", "0xE1B96555BbecA40E583BbB41a11C68Ca4706A414", 1, 0, 6, 18],
      ["usat-tether", "0x0Bdb2c3AF83EE1d3196FA64d3162e54624B5f6b0", 1, 0, 6, 6],
      ["usdg-paxos", "0xc061caa073f3d95F80f8e5428d32D2d76F5e1622", 1, 0, 6, 6],
      ["nusd-neutrl", "0x7E19F0253A564e026C63eeAA9338d6DBddeF3b09", 1, 0, 6, 18],
      ["usdf-falcon", "0x72310DAAed61321b02B08A547150c07522c6a976", 0, 1, 6, 18],
      ["eusd-electronic-usd", "0x08BfA22bB3e024CDfEB3eca53c0cb93bF59c4147", 1, 0, 6, 18],
      ["fidd-fidelity", "0xE47E8Ced9D94AA43C922627782E29b41a93202AF", 1, 0, 6, 18],
      ["usdq-quantoz", "0x5a8C7623FEe10542614e492c670a67e3DfE922F8", 1, 0, 6, 6],
      ["susds-sky", "0x00836Fe54625BE242BcFA286207795405ca4fD10", 1, 0, 6, 18],
    ] as const;

    for (const [stablecoinId, poolAddress, inputIndex, outputIndex, inputDecimals, outputDecimals] of expectedConfigs) {
      expect(byId.get(stablecoinId)).toMatchObject({
        poolAddress,
        inputIndex,
        outputIndex,
        inputDecimals,
        outputDecimals,
        routeType: "direct",
      });
    }
  });

  it("keeps audited Curve route configs explicit and uniquely keyed", () => {
    const ids = CURVE_POOL_CONFIGS.map((config) => config.stablecoinId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(CURVE_POOL_CONFIGS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stablecoinId: "apyusd-apyx",
          hop: { viaStablecoinId: "apxusd-apyx" },
          routeType: "one-hop",
        }),
        expect.objectContaining({
          stablecoinId: "dola-inverse-finance",
          hop: { viaStablecoinId: "susds-sky" },
          routeType: "trusted-wrapper",
        }),
        expect.objectContaining({
          stablecoinId: "msusd-metronome",
          hop: { viaStablecoinId: "frxusd-frax" },
          routeType: "chained-hop",
          maxHopDepth: 2,
        }),
        expect.objectContaining({
          stablecoinId: "sfrxusd-frax",
          hop: { viaStablecoinId: "frxusd-frax" },
          routeType: "chained-hop",
          maxHopDepth: 2,
        }),
        expect.objectContaining({
          stablecoinId: "stusds-sky",
          hop: { viaStablecoinId: "usds-sky" },
          routeType: "chained-hop",
          maxHopDepth: 2,
        }),
        expect.objectContaining({
          stablecoinId: "alusd-alchemix",
          hop: { viaStablecoinId: "frxusd-frax" },
          routeType: "chained-hop",
          maxHopDepth: 2,
        }),
        expect.objectContaining({
          stablecoinId: "avusd-avant",
          hop: { viaStablecoinId: "frxusd-frax" },
          routeType: "chained-hop",
          maxHopDepth: 2,
        }),
      ]),
    );
  });

  it("parses get_dy response into implied price", async () => {
    // get_dy(1, 2, 1e6) returns 999000 for USDT (6 decimals out)
    // Implied price = inputFloat/outputFloat = 1.0/0.999 ≈ 1.001
    const mockHexResponse = hexWord(999000);
    mockEvmCall.mockResolvedValue(mockHexResponse);

    const config = makeCurveConfig();
    const outcome = await fetchCurveOnchainPrices([config]);
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.prices.size).toBe(1);
    expect(outcome.value.prices.get("usdt-tether")).toBeCloseTo(1.001, 3);
    expect(outcome.value.observedAtByCoinId.get("usdt-tether")).toBe(FRESH_BLOCK_TIMESTAMP);
    expect(outcome.value.routeTypeByCoinId.get("usdt-tether")).toBe("direct");
    expect(outcome.value.hopDepthByCoinId.get("usdt-tether")).toBe(0);
    expect(mockEvmCall).toHaveBeenCalledWith(
      "ethereum",
      config.poolAddress,
      expect.any(String),
      FRESH_BLOCK_NUMBER,
      expect.any(Object),
    );
  });

  it("computes correct implied price when pool is imbalanced (depeg scenario)", async () => {
    // Depeg: USDT at $0.95 → get_dy returns ~1.053e6 USDT per 1e6 USDC
    // Correct: inputFloat/outputFloat = 1.0/1.052632 ≈ 0.95
    const mockHex = hexWord(1_052_632);
    mockEvmCall.mockResolvedValue(mockHex);

    const config = makeCurveConfig();
    const outcome = await fetchCurveOnchainPrices([config]);
    expect(outcome.value.prices.get("usdt-tether")).toBeCloseTo(0.95, 2);
  });

  it("computes correct implied price with different decimals (DAI 18 decimals)", async () => {
    // 1 USDC (1e6) → 1.001e18 DAI → price = 1.0/1.001 ≈ 0.999
    const daiOutput = BigInt("1001000000000000000");
    const mockHex = hexWord(daiOutput);
    mockEvmCall.mockResolvedValue(mockHex);

    const config = makeCurveConfig({
      stablecoinId: "dai-makerdao",
      inputIndex: 1,
      outputIndex: 0,
      inputDecimals: 6,
      outputDecimals: 18,
    });
    const outcome = await fetchCurveOnchainPrices([config]);
    expect(outcome.value.prices.get("dai-makerdao")).toBeCloseTo(0.999, 3);
  });

  it("returns no-data outcome when RPC returns null for every pool", async () => {
    mockEvmCall.mockResolvedValue(null);
    const config = makeCurveConfig();
    const outcome = await fetchCurveOnchainPrices([config]);
    expect(outcome.kind).toBe("no-data");
    expect(outcome.value.prices.size).toBe(0);
  });

  it("uses get_dy_underlying selector when useUnderlying is true", async () => {
    const lusdOutput = BigInt("999000000000000000"); // 0.999e18
    const mockHex = hexWord(lusdOutput);
    mockEvmCall.mockResolvedValue(mockHex);

    const config = makeCurveConfig({
      stablecoinId: "lusd-liquity",
      poolAddress: "0xEd279fDD11cA84bEef15AF5D39BB4d4bEE23F0cA",
      inputIndex: 2, // USDC (underlying)
      outputIndex: 0, // LUSD (underlying)
      inputDecimals: 6,
      outputDecimals: 18,
      useUnderlying: true,
    });
    const outcome = await fetchCurveOnchainPrices([config]);
    expect(outcome.value.prices.get("lusd-liquity")).toBeCloseTo(1.001, 3);

    // Verify the underlying selector was used, not get_dy
    const calldata = mockEvmCall.mock.calls[0][2] as string;
    expect(calldata.startsWith("0x07211ef7")).toBe(true);
  });

  it("resolves hop prices by multiplying with via-token price", async () => {
    const crvusdOutput = BigInt("999000000000000000"); // 0.999e18 crvUSD per 1 USDC
    const ghoOutput = BigInt("998000000000000000"); // 0.998e18 GHO per 1e18 crvUSD

    mockEvmCall.mockResolvedValueOnce(hexWord(crvusdOutput)).mockResolvedValueOnce(hexWord(ghoOutput));

    const configs: CurvePoolConfig[] = [
      {
        stablecoinId: "crvusd-curve",
        poolAddress: "0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E",
        inputIndex: 0,
        outputIndex: 1,
        inputDecimals: 6,
        outputDecimals: 18,
        chain: "ethereum",
      },
      {
        stablecoinId: "gho-aave",
        poolAddress: "0x0001000100010001000100010001000100010001",
        inputIndex: 0,
        outputIndex: 1,
        inputDecimals: 18,
        outputDecimals: 18,
        chain: "ethereum",
        hop: { viaStablecoinId: "crvusd-curve" },
      },
    ];

    const outcome = await fetchCurveOnchainPrices(configs);
    expect(outcome.value.prices.get("crvusd-curve")).toBeCloseTo(1.001, 3);
    const expectedGho = (1.0 / 0.998) * (1.0 / 0.999);
    expect(outcome.value.prices.get("gho-aave")).toBeCloseTo(expectedGho, 3);
    expect(outcome.value.routeTypeByCoinId.get("gho-aave")).toBe("one-hop");
    expect(outcome.value.hopDepthByCoinId.get("gho-aave")).toBe(1);
  });

  it("resolves one-hop prices even when via config appears later", async () => {
    const ghoOutput = BigInt("998000000000000000"); // 0.998e18 GHO per 1e18 crvUSD
    const crvusdOutput = BigInt("999000000000000000"); // 0.999e18 crvUSD per 1 USDC

    mockEvmCall.mockResolvedValueOnce(hexWord(ghoOutput)).mockResolvedValueOnce(hexWord(crvusdOutput));

    const configs: CurvePoolConfig[] = [
      {
        stablecoinId: "gho-aave",
        poolAddress: "0x0001000100010001000100010001000100010001",
        inputIndex: 0,
        outputIndex: 1,
        inputDecimals: 18,
        outputDecimals: 18,
        chain: "ethereum",
        hop: { viaStablecoinId: "crvusd-curve" },
      },
      {
        stablecoinId: "crvusd-curve",
        poolAddress: "0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E",
        inputIndex: 0,
        outputIndex: 1,
        inputDecimals: 6,
        outputDecimals: 18,
        chain: "ethereum",
      },
    ];

    const outcome = await fetchCurveOnchainPrices(configs);
    const expectedGho = (1.0 / 0.998) * (1.0 / 0.999);
    expect(outcome.value.prices.get("gho-aave")).toBeCloseTo(expectedGho, 3);
  });

  it("excludes hop coin when via-token RPC fails", async () => {
    mockEvmCall
      .mockResolvedValueOnce(null) // crvUSD fails
      .mockResolvedValueOnce(hexWord("998000000000000000"));

    const configs: CurvePoolConfig[] = [
      {
        stablecoinId: "crvusd-curve",
        poolAddress: "0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E",
        inputIndex: 0,
        outputIndex: 1,
        inputDecimals: 6,
        outputDecimals: 18,
        chain: "ethereum",
      },
      {
        stablecoinId: "gho-aave",
        poolAddress: "0x0001000100010001000100010001000100010001",
        inputIndex: 0,
        outputIndex: 1,
        inputDecimals: 18,
        outputDecimals: 18,
        chain: "ethereum",
        hop: { viaStablecoinId: "crvusd-curve" },
      },
    ];

    const outcome = await fetchCurveOnchainPrices(configs);
    expect(outcome.value.prices.has("crvusd-curve")).toBe(false);
    expect(outcome.value.prices.has("gho-aave")).toBe(false);
  });

  it("truncates oversized Vyper return data to first uint256 word", async () => {
    // Vyper metapools return thousands of bytes; only the first 32-byte word
    // is the actual get_dy_underlying result (~0.984 LUSD for 1 USDC)
    const actualValue = BigInt("984321781412057132"); // ~0.984e18 LUSD
    const word0 = hexWord(actualValue).slice(2);
    // Simulate Vyper response: word0 + extra trailing data
    const trailing = "00000002" + "0".repeat(56) + "0".repeat(64) + "000f4240" + "0".repeat(56);
    const vyperHex = ("0x" + word0 + trailing) as `0x${string}`;
    expect(vyperHex.length).toBeGreaterThan(66);

    mockEvmCall.mockResolvedValue(vyperHex);

    const config = makeCurveConfig({
      stablecoinId: "lusd-liquity",
      poolAddress: "0xEd279fDD11cA84bEef15AF5D39BB4d4bEE23F0cA",
      inputIndex: 2,
      outputIndex: 0,
      inputDecimals: 6,
      outputDecimals: 18,
      useUnderlying: true,
    });
    const outcome = await fetchCurveOnchainPrices([config]);
    expect(outcome.value.prices.get("lusd-liquity")).toBeCloseTo(1.016, 2);
  });

  it("returns upstream-error outcome when every RPC call throws", async () => {
    mockEvmCall.mockRejectedValue(new Error("network down"));
    const config = makeCurveConfig();
    const outcome = await fetchCurveOnchainPrices([config]);
    expect(outcome.kind).toBe("upstream-error");
    expect(outcome.value.prices.size).toBe(0);
  });

  it("returns ok with partial=true when some pools throw but others succeed", async () => {
    mockEvmCall.mockResolvedValueOnce(hexWord(999000)).mockRejectedValueOnce(new Error("rpc broke"));

    const configs: CurvePoolConfig[] = [
      {
        ...makeCurveConfig(),
      },
      {
        ...makeCurveConfig({ stablecoinId: "usdc-usd-coin", inputIndex: 0, outputIndex: 1 }),
      },
    ];
    const outcome = await fetchCurveOnchainPrices(configs);
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.prices.size).toBe(1);
    expect(outcome.value.prices.get("usdt-tether")).toBeCloseTo(1.001, 3);
  });

  it("excludes chained hops unless the dependent config explicitly opts in", async () => {
    const configs: CurvePoolConfig[] = [
      {
        stablecoinId: "token-c",
        poolAddress: "0x0000000000000000000000000000000000000003",
        inputIndex: 0,
        outputIndex: 1,
        inputDecimals: 18,
        outputDecimals: 18,
        chain: "ethereum",
      },
      {
        stablecoinId: "token-b",
        poolAddress: "0x0000000000000000000000000000000000000002",
        inputIndex: 0,
        outputIndex: 1,
        inputDecimals: 18,
        outputDecimals: 18,
        chain: "ethereum",
        hop: { viaStablecoinId: "token-c" },
      },
      {
        stablecoinId: "token-a",
        poolAddress: "0x0000000000000000000000000000000000000001",
        inputIndex: 0,
        outputIndex: 1,
        inputDecimals: 18,
        outputDecimals: 18,
        chain: "ethereum",
        hop: { viaStablecoinId: "token-b" },
      },
    ];

    mockEvmCall.mockResolvedValue(hexWord("1000000000000000000"));

    const outcome = await fetchCurveOnchainPrices(configs);
    expect(outcome.value.prices.has("token-b")).toBe(true);
    expect(outcome.value.prices.has("token-a")).toBe(false);
  });

  it("resolves chained hops when maxHopDepth explicitly allows them", async () => {
    const tokenAOutput = BigInt("997000000000000000");
    const tokenBOutput = BigInt("998000000000000000");
    const tokenCOutput = BigInt("999000000000000000");

    mockEvmCall
      .mockResolvedValueOnce(hexWord(tokenAOutput))
      .mockResolvedValueOnce(hexWord(tokenBOutput))
      .mockResolvedValueOnce(hexWord(tokenCOutput));

    const configs: CurvePoolConfig[] = [
      {
        stablecoinId: "token-a",
        poolAddress: "0x0000000000000000000000000000000000000001",
        inputIndex: 0,
        outputIndex: 1,
        inputDecimals: 18,
        outputDecimals: 18,
        chain: "ethereum",
        hop: { viaStablecoinId: "token-b" },
        routeType: "chained-hop",
        maxHopDepth: 2,
      },
      {
        stablecoinId: "token-b",
        poolAddress: "0x0000000000000000000000000000000000000002",
        inputIndex: 0,
        outputIndex: 1,
        inputDecimals: 18,
        outputDecimals: 18,
        chain: "ethereum",
        hop: { viaStablecoinId: "token-c" },
      },
      {
        stablecoinId: "token-c",
        poolAddress: "0x0000000000000000000000000000000000000003",
        inputIndex: 0,
        outputIndex: 1,
        inputDecimals: 18,
        outputDecimals: 18,
        chain: "ethereum",
      },
    ];

    const outcome = await fetchCurveOnchainPrices(configs);
    const expectedTokenA = (1.0 / 0.997) * (1.0 / 0.998) * (1.0 / 0.999);
    expect(outcome.value.prices.get("token-a")).toBeCloseTo(expectedTokenA, 3);
    expect(outcome.value.routeTypeByCoinId.get("token-a")).toBe("chained-hop");
    expect(outcome.value.hopDepthByCoinId.get("token-a")).toBe(2);
  });

  it("fails closed when hop configs form a cycle", async () => {
    mockEvmCall.mockResolvedValue(hexWord("1000000000000000000"));

    const configs: CurvePoolConfig[] = [
      {
        stablecoinId: "token-a",
        poolAddress: "0x0000000000000000000000000000000000000001",
        inputIndex: 0,
        outputIndex: 1,
        inputDecimals: 18,
        outputDecimals: 18,
        chain: "ethereum",
        hop: { viaStablecoinId: "token-b" },
        routeType: "chained-hop",
        maxHopDepth: 2,
      },
      {
        stablecoinId: "token-b",
        poolAddress: "0x0000000000000000000000000000000000000002",
        inputIndex: 0,
        outputIndex: 1,
        inputDecimals: 18,
        outputDecimals: 18,
        chain: "ethereum",
        hop: { viaStablecoinId: "token-a" },
        routeType: "chained-hop",
        maxHopDepth: 2,
      },
    ];

    const outcome = await fetchCurveOnchainPrices(configs);
    expect(outcome.kind).toBe("no-data");
    expect(outcome.value.prices.size).toBe(0);
  });

  it("fails closed when a hop references a missing via config", async () => {
    mockEvmCall.mockResolvedValue(hexWord("1000000000000000000"));

    const config: CurvePoolConfig = {
      stablecoinId: "token-a",
      poolAddress: "0x0000000000000000000000000000000000000001",
      inputIndex: 0,
      outputIndex: 1,
      inputDecimals: 18,
      outputDecimals: 18,
      chain: "ethereum",
      hop: { viaStablecoinId: "token-b" },
    };

    const outcome = await fetchCurveOnchainPrices([config]);
    expect(outcome.kind).toBe("no-data");
    expect(outcome.value.prices.has("token-a")).toBe(false);
  });

  it("emits route metadata for explicit trusted-wrapper routes", async () => {
    const mockHexResponse = hexWord("1000000000000000000");
    mockEvmCall.mockResolvedValue(mockHexResponse);

    const config = makeCurveConfig({
      stablecoinId: "wrapper-token",
      poolAddress: "0x0000000000000000000000000000000000000001",
      inputIndex: 0,
      outputIndex: 1,
      inputDecimals: 18,
      outputDecimals: 18,
      routeType: "trusted-wrapper",
    });

    const outcome = await fetchCurveOnchainPrices([config]);
    expect(outcome.value.prices.get("wrapper-token")).toBe(1);
    expect(outcome.value.routeTypeByCoinId.get("wrapper-token")).toBe("trusted-wrapper");
    expect(outcome.value.hopDepthByCoinId.get("wrapper-token")).toBe(0);
  });

  it("stamps each priced coin with the block timestamp as observedAt", async () => {
    const mockHexResponse = hexWord(999000);
    mockEvmCall.mockResolvedValue(mockHexResponse);

    const configs: CurvePoolConfig[] = [
      makeCurveConfig(),
      makeCurveConfig({ stablecoinId: "usdc-usd-coin", inputIndex: 0, outputIndex: 1 }),
    ];
    const outcome = await fetchCurveOnchainPrices(configs);
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.observedAtByCoinId.get("usdt-tether")).toBe(FRESH_BLOCK_TIMESTAMP);
    expect(outcome.value.observedAtByCoinId.get("usdc-usd-coin")).toBe(FRESH_BLOCK_TIMESTAMP);
    // Block-number + block-timestamp each called exactly once for the whole run
    expect(mockBlockNumber).toHaveBeenCalledTimes(1);
    expect(mockBlockTimestamp).toHaveBeenCalledTimes(1);
  });

  it("rejects the whole run when block timestamp is older than 300s", async () => {
    const stale = Math.floor(Date.now() / 1000) - 400; // >300s old
    mockBlockTimestamp.mockResolvedValue(stale);
    const mockHexResponse = hexWord(999000);
    mockEvmCall.mockResolvedValue(mockHexResponse);

    const config = makeCurveConfig();
    const outcome = await fetchCurveOnchainPrices([config]);
    expect(outcome.kind).toBe("upstream-error");
    expect(outcome.value.prices.size).toBe(0);
  });

  it("returns upstream-error when block number RPC fails", async () => {
    mockBlockNumber.mockResolvedValue(null);
    const config = makeCurveConfig();
    const outcome = await fetchCurveOnchainPrices([config]);
    expect(outcome.kind).toBe("upstream-error");
    expect(outcome.value.prices.size).toBe(0);
    expect(mockEvmCall).not.toHaveBeenCalled();
  });
});
