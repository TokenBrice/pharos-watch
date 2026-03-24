import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionResult, parseAbi } from "viem";

vi.mock("../../../lib/evm-rpc", () => ({
  fetchEvmCallHexAtBlock: vi.fn(),
}));

import { fetchEvmCallHexAtBlock } from "../../../lib/evm-rpc";
import { fetchSlipstreamPools } from "../fetch-slipstream";

const ABI = parseAbi([
  "function all(uint256 _limit, uint256 _offset) view returns ((address lp,string symbol,uint8 decimals,uint256 liquidity,int24 type,int24 tick,uint160 sqrt_ratio,address token0,uint256 reserve0,uint256 staked0,address token1,uint256 reserve1,uint256 staked1,address gauge,uint256 gauge_liquidity,bool gauge_alive,address fee,address bribe,address factory,uint256 emissions,address emissions_token,uint256 pool_fee,uint256 unstaked_fee,uint256 token0_fees,uint256 token1_fees,address nfpm,address alm,address root)[])",
  "function tokens(uint256 _limit, uint256 _offset, address _account, address[] _addresses) view returns ((address token_address,string symbol,uint8 decimals,uint256 account_balance,bool listed)[])",
]);

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
      poolType: "aerodrome-slipstream-1bp",
      feeRate: 0.0001,
      tvlUsd: 100,
    });
  });
});
