import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionResult, parseAbi } from "viem/utils";

vi.mock("../../../lib/evm-rpc", () => ({
  fetchEvmCallHexAtBlock: vi.fn(),
}));

import { fetchEvmCallHexAtBlock } from "../../../lib/evm-rpc";
import {
  fetchSlipstreamPools,
  getSlipstreamPoolFeeBps,
  projectSugarPoolPage,
  projectSugarTokens,
  sqrtRatioToSpotPrice,
} from "../fetch-slipstream";

const ABI = parseAbi([
  "function all(uint256 _limit, uint256 _offset) view returns ((address lp,string symbol,uint8 decimals,uint256 liquidity,int24 type,int24 tick,uint160 sqrt_ratio,address token0,uint256 reserve0,uint256 staked0,address token1,uint256 reserve1,uint256 staked1,address gauge,uint256 gauge_liquidity,bool gauge_alive,address fee,address bribe,address factory,uint256 emissions,address emissions_token,uint256 pool_fee,uint256 unstaked_fee,uint256 token0_fees,uint256 token1_fees,address nfpm,address alm,address root)[])",
  "function tokens(uint256 _limit, uint256 _offset, address _account, address[] _addresses) view returns ((address token_address,string symbol,uint8 decimals,uint256 account_balance,bool listed)[])",
]);

describe("sqrtRatioToSpotPrice", () => {
  it("returns 1.0 for a balanced sqrt price (Q96 == 2^96)", () => {
    // sqrt(1) * 2^96 = 2^96 → price = 1.0 (same decimals)
    const price = sqrtRatioToSpotPrice(1n << 96n, 6, 6);
    expect(price).toBeCloseTo(1, 3);
  });

  it("handles decimal adjustment across token decimals", () => {
    // Q96 balanced ratio with token0 6dec, token1 18dec:
    // priceRaw = 1.0, decimals adjust = 10^(6 - 18) = 10^-12
    const price = sqrtRatioToSpotPrice(1n << 96n, 6, 18);
    expect(price).toBeCloseTo(1e-12, 15);
  });

  it("handles large sqrt ratios without overflow", () => {
    // Uniswap V3 sqrtPriceX96 can reach ~2^160. Pick 2^140 as a well-above-safe-int test.
    const price = sqrtRatioToSpotPrice(1n << 140n, 18, 18);
    expect(Number.isFinite(price)).toBe(true);
    expect(price).toBeGreaterThan(0);
  });

  it("returns 0 for zero or negative sqrt ratio", () => {
    expect(sqrtRatioToSpotPrice(0n, 6, 6)).toBe(0);
    expect(sqrtRatioToSpotPrice(-1n, 6, 6)).toBe(0);
  });
});

describe("getSlipstreamPoolFeeBps", () => {
  it("returns the numeric bps for valid values", () => {
    expect(getSlipstreamPoolFeeBps(1n)).toBe(1);
    expect(getSlipstreamPoolFeeBps(5n)).toBe(5);
    expect(getSlipstreamPoolFeeBps(30n)).toBe(30);
    expect(getSlipstreamPoolFeeBps(100n)).toBe(100);
    expect(getSlipstreamPoolFeeBps(10_000n)).toBe(10_000);
  });

  it("returns null for out-of-range values", () => {
    expect(getSlipstreamPoolFeeBps(0n)).toBe(null);
    expect(getSlipstreamPoolFeeBps(-1n)).toBe(null);
    expect(getSlipstreamPoolFeeBps(10_001n)).toBe(null);
    expect(getSlipstreamPoolFeeBps(20_000n)).toBe(null);
  });
});

describe("Sugar ABI projection", () => {
  it("drops non-CL rows and retains exactly the consumed pool fields in source order", () => {
    const makeDecodedPool = (lp: string, type: number, reserve0: bigint) => ({
      lp,
      symbol: `pool-${lp.slice(-2)}`,
      decimals: 18,
      liquidity: 123n,
      type,
      tick: 7,
      sqrt_ratio: 1n << 96n,
      token0: "0x00000000000000000000000000000000000000bb",
      reserve0,
      staked0: 11n,
      token1: "0x00000000000000000000000000000000000000cc",
      reserve1: 50_000_000n,
      staked1: 12n,
      gauge: "0x0000000000000000000000000000000000000001",
      pool_fee: 5n,
      emissions: 13n,
    });
    const decoded = [
      makeDecodedPool("0x0000000000000000000000000000000000000011", 0, 10n),
      makeDecodedPool("0x0000000000000000000000000000000000000022", 1, 20n),
      makeDecodedPool("0x0000000000000000000000000000000000000033", 2, 30n),
    ];

    const projected = projectSugarPoolPage(decoded);

    expect(projected.map((pool) => pool.lp)).toEqual([
      "0x0000000000000000000000000000000000000022",
      "0x0000000000000000000000000000000000000033",
    ]);
    expect(projected.map((pool) => Object.keys(pool))).toEqual([
      ["lp", "type", "token0", "reserve0", "token1", "reserve1", "sqrt_ratio", "pool_fee"],
      ["lp", "type", "token0", "reserve0", "token1", "reserve1", "sqrt_ratio", "pool_fee"],
    ]);
    expect(projected.map((pool) => pool.reserve0)).toEqual([20n, 30n]);
  });

  it("retains exactly the consumed token fields", () => {
    const decoded = [
      {
        token_address: "0x00000000000000000000000000000000000000BB",
        symbol: "USDC",
        decimals: 6,
        account_balance: 123n,
        listed: true,
      },
    ];

    const tokens = projectSugarTokens(decoded);

    expect(tokens.get("0x00000000000000000000000000000000000000bb")).toEqual({
      token_address: "0x00000000000000000000000000000000000000BB",
      symbol: "USDC",
      decimals: 6,
    });
    expect(Object.keys(tokens.values().next().value ?? {})).toEqual([
      "token_address",
      "symbol",
      "decimals",
    ]);
  });
});

describe("fetchSlipstreamPools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds CL pools from sugar contract pages", async () => {
    vi.mocked(fetchEvmCallHexAtBlock)
      .mockResolvedValueOnce(encodeFunctionResult({
        abi: ABI,
        functionName: "all",
        result: [{
          lp: "0x00000000000000000000000000000000000000aa",
          symbol: "CL1-USDC/DAI",
          decimals: 18,
          liquidity: 1n,
          type: 1,
          tick: 0,
          sqrt_ratio: 0n,
          token0: "0x00000000000000000000000000000000000000bb",
          reserve0: 50_000_000n,
          staked0: 0n,
          token1: "0x00000000000000000000000000000000000000cc",
          reserve1: 50_000000000000000000n,
          staked1: 0n,
          gauge: "0x0000000000000000000000000000000000000000",
          gauge_liquidity: 0n,
          gauge_alive: false,
          fee: "0x0000000000000000000000000000000000000000",
          bribe: "0x0000000000000000000000000000000000000000",
          factory: "0x0000000000000000000000000000000000000000",
          emissions: 0n,
          emissions_token: "0x0000000000000000000000000000000000000000",
          pool_fee: 1n,
          unstaked_fee: 0n,
          token0_fees: 0n,
          token1_fees: 0n,
          nfpm: "0x0000000000000000000000000000000000000000",
          alm: "0x0000000000000000000000000000000000000000",
          root: "0x0000000000000000000000000000000000000000",
        }],
      }))
      .mockResolvedValueOnce(encodeFunctionResult({
        abi: ABI,
        functionName: "tokens",
        result: [
          {
            token_address: "0x00000000000000000000000000000000000000bb",
            symbol: "USDC",
            decimals: 6,
            account_balance: 0n,
            listed: true,
          },
          {
            token_address: "0x00000000000000000000000000000000000000cc",
            symbol: "DAI",
            decimals: 18,
            account_balance: 0n,
            listed: true,
          },
        ],
      }));

    const result = await fetchSlipstreamPools(
      "aerodrome-slipstream",
      new Map([
        ["base:0x00000000000000000000000000000000000000bb", "usdc-circle"],
        ["base:0x00000000000000000000000000000000000000cc", "dai-makerdao"],
      ]),
      new Map(),
      new Map([
        ["usdc-circle", 1],
        ["dai-makerdao", 1],
      ]),
    );

    expect(result.ok).toBe(true);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]).toMatchObject({
      source: "aerodrome-slipstream",
      chain: "base",
      poolAddress: "0x00000000000000000000000000000000000000AA",
      poolType: "aerodrome-slipstream-1bp",
      feeRate: 0.0001,
      tvlUsd: 100,
      price: null,
      volume24hUsd: 0,
      balances: [50, 50],
      tokens: [
        {
          address: "0x00000000000000000000000000000000000000bb",
          symbol: "USDC",
          decimals: 6,
          priceUsd: 1,
        },
        {
          address: "0x00000000000000000000000000000000000000cc",
          symbol: "DAI",
          decimals: 18,
          priceUsd: 1,
        },
      ],
    });
  });
});
