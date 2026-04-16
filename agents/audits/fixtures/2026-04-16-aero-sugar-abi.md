## Aerodrome Slipstream Sugar ABI probing (2026-04-16)

Goal: obtain the `all(uint256,uint256)` return struct for Task A6 Slipstream
sqrt_ratio / pool_fee unit verification.

### Attempted sources

| URL | Status | Body |
| --- | --- | --- |
| `https://api.basescan.org/api?module=contract&action=getabi&address=0x27fc745390d1f4BaF8D184FBd97748340f786634` | 200 | `{"status":"0","message":"NOTOK","result":"You are using a deprecated V1 endpoint, switch to Etherscan API V2 using https://docs.etherscan.io/v2-migration"}` |
| `https://api.etherscan.io/v2/api?chainid=8453&module=contract&action=getabi&address=0x27fc745390d1f4BaF8D184FBd97748340f786634` | 200 | `{"status":"0","message":"NOTOK","result":""}` — requires an Etherscan v2 API key that is not configured for agent bash sessions |

### Alternative: the struct is already in the worker's own ABI

The Slipstream fetcher uses viem's `parseAbi` to declare the ABI inline, so the
struct is already part of `worker/src/cron/dex-liquidity/fetch-slipstream.ts:11-14`:

```ts
const SUGAR_ABI = parseAbi([
  "function all(uint256 _limit, uint256 _offset) view returns ((address lp,string symbol,uint8 decimals,uint256 liquidity,int24 type,int24 tick,uint160 sqrt_ratio,address token0,uint256 reserve0,uint256 staked0,address token1,uint256 reserve1,uint256 staked1,address gauge,uint256 gauge_liquidity,bool gauge_alive,address fee,address bribe,address factory,uint256 emissions,address emissions_token,uint256 pool_fee,uint256 unstaked_fee,uint256 token0_fees,uint256 token1_fees,address nfpm,address alm,address root)[])",
  "function tokens(uint256 _limit, uint256 _offset, address _account, address[] _addresses) view returns ((address token_address,string symbol,uint8 decimals,uint256 account_balance,bool listed)[])",
]);
```

Key observations from the inlined struct:

- `sqrt_ratio` is declared as `uint160`. For a Uniswap-V3-derived slipstream,
  this is the **raw Q64.96 sqrtPriceX96** (not a decimal). Math in A6 must be
  BigInt-correct — the value is typically on the order of `2^96 .. 2^128`,
  which is well outside `Number.MAX_SAFE_INTEGER` (`2^53 - 1`).
- `pool_fee` is declared as `uint256`. The unit is **not** indicated in the
  ABI. To answer "is pool_fee in bps or in Aerodrome's internal 1e6-scaled
  units" requires either (a) an eth_call fixture, (b) reading the Sugar
  Vyper source, or (c) spot-checking a live pool's reported fee against a
  known-correct rate.
- `type` is `int24` and is the Uniswap-V3 tick spacing (positive for CL,
  0 for stable, -1 for volatile). `fetch-slipstream.ts:135` filters
  `Number(pool.type) > 0` to keep only concentrated pools.

### Recommendation for the plan

Either:

1. **Defer Task A6 from the remediation plan**. Add it to a follow-up plan that
   starts by obtaining an eth_call fixture via a pre-configured Base RPC
   (publicnode, drpc, etc.) — no Basescan/Etherscan API key required. Capture
   a real `sqrtPriceX96` + `pool_fee` pair from a known USDC/cbBTC pool and
   verify the math against a known spot price.

2. **Or ship A6 without the sqrt_ratio math fix** and only address `pool_fee`
   unit confusion if (and only if) the plan can obtain a live fixture. The
   audit itself (`2026-04-16-liquidity-data-accuracy-audit.md:M5/M6`) notes
   that live Tenderly eth_call reverted for the auditor — which means even
   the auditor couldn't verify their own fix hypothesis end-to-end.

The plan's current A6 math (`Number(sqrtRatio) / Number(Q96)`) is numerically
incorrect for 96-bit inputs and should not be shipped without a BigInt-correct
rewrite. Use viem's `encodeSqrtRatioX96` utilities or roll a BigInt
`(sqrtRatio**2 * 10**d0) / (Q192 * 10**d1)` pattern.
