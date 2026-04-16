# Plan Ground Truth (2026-04-16)

Companion artifact to `agents/plans/2026-04-16-liquidity-remediation-plan.md`
after round-1 review (`agents/audits/2026-04-16-liquidity-plan-review-round1.md`).

This document pastes exact current code, exact function signatures, exact
test idioms, and captured real-API fixtures so the plan rewrite has zero
invented symbols. All paths are relative to the repo root.

---

## Part 1 — File/line content

### 1. `worker/src/cron/dex-liquidity/fetch-meteora.ts`

#### Imports (lines 1-8)
```ts
import {
  DIRECT_API_POOL_MIN_TVL_USD,
  makeDexApiFetchResult,
  type DexApiFetchResult,
  type DexApiPool,
} from "../../lib/dex-api-common";
import { USER_AGENT } from "../../lib/constants";
import { isDexApiRecord, readDexApiJson } from "./direct-api-json";
```

#### Exports
- `fetchMeteoraPools(signal?: AbortSignal): Promise<DexApiFetchResult>` (line 58 — only export)

#### `isMeteoraPool` type guard (lines 47-56)
```ts
function isMeteoraPool(value: unknown): value is MeteoraPool {
  return isDexApiRecord(value) &&
    typeof value.address === "string" &&
    isMeteoraToken(value.token_x) &&
    isMeteoraToken(value.token_y) &&
    typeof value.token_x_amount === "number" &&
    Number.isFinite(value.token_x_amount) &&
    typeof value.token_y_amount === "number" &&
    Number.isFinite(value.token_y_amount);
}
```

#### `fetchMeteoraPools` signature + price assignment (lines 58, 118-150)
```ts
export async function fetchMeteoraPools(signal?: AbortSignal): Promise<DexApiFetchResult> {
  // ...pagination loop...
      const reserve0 = row.token_x_amount;
      const reserve1 = row.token_y_amount;
      const derivedPrice = Number.isFinite(reserve0) && reserve0 > 0 && Number.isFinite(reserve1) && reserve1 > 0
        ? reserve1 / reserve0
        : null;

      pools.push({
        source: "meteora",
        chain: "solana",
        poolAddress: row.address,
        poolType: "meteora-dlmm",
        tokens: [
          {
            address: row.token_x.address,
            symbol: row.token_x.symbol,
            decimals: row.token_x.decimals,
            priceUsd: row.token_x.price ?? null,
          },
          {
            address: row.token_y.address,
            symbol: row.token_y.symbol,
            decimals: row.token_y.decimals,
            priceUsd: row.token_y.price ?? null,
          },
        ],
        price: Number.isFinite(derivedPrice) && derivedPrice != null && derivedPrice > 0
          ? derivedPrice
          : (row.current_price != null && Number.isFinite(row.current_price) && row.current_price > 0 ? row.current_price : null),
        tvlUsd,
        volume24hUsd: volume24hUsd != null && Number.isFinite(volume24hUsd) ? volume24hUsd : 0,
        feeRate: feePct > 0 ? feePct / 100 : null,
        balances: Number.isFinite(reserve0) && Number.isFinite(reserve1) ? [reserve0, reserve1] : null,
      });
```

**Critical finding**: `derivedPrice = reserve1 / reserve0` uses the **raw
`token_x_amount` and `token_y_amount` fields as they come from the Meteora API
without accounting for token decimals**. Meteora's API appears to already
deliver decimal-normalized amounts (see fixture below), so the raw ratio still
produces a token0-denominated spot price. But when `token_x_amount` and
`token_y_amount` were populated by an LP from an imbalanced starting
position, or when a bin's active liquidity is skewed, `reserve1/reserve0` is
NOT the spot price — `current_price` is. The fetcher prefers `derivedPrice` if
finite, so imbalanced DLMM pools emit a materially wrong `price` field. See
the captured fixture in Part 2 for a real `SOL/USDC` pool where
`reserve1/reserve0 = 13.02` vs `current_price = 84.93`.

---

### 2. `worker/src/cron/dex-liquidity/__tests__/fetch-meteora.test.ts`

#### FULL FILE

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

describe("fetchMeteoraPools", () => {
  afterEach(() => {
    mockFetch.mockReset();
    vi.resetModules();
  });

  it("normalizes Meteora pools into direct-api pools", async () => {
    const { fetchMeteoraPools } = await import("../fetch-meteora");
    mockFetch
      .mockResolvedValueOnce(jsonResponse({
        data: [{
          address: "Pool111",
          token_x: { address: "So111", symbol: "SOL", decimals: 9, price: 90 },
          token_y: { address: "USDC111", symbol: "USDC", decimals: 6, price: 1 },
          token_x_amount: 100,
          token_y_amount: 9000,
          current_price: 90,
          tvl: 18000,
          volume: { "24h": 25000 },
          pool_config: { base_fee_pct: 0.01 },
          dynamic_fee_pct: 0.002,
          is_blacklisted: false,
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    const result = await fetchMeteoraPools();

    expect(result.ok).toBe(true);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]).toMatchObject({
      source: "meteora",
      chain: "solana",
      poolType: "meteora-dlmm",
      tvlUsd: 18000,
      volume24hUsd: 25000,
      balances: [100, 9000],
    });
    expect(result.pools[0].feeRate).toBeCloseTo(0.00012);
  });

  it("returns a degraded result when Meteora returns invalid JSON", async () => {
    const { fetchMeteoraPools } = await import("../fetch-meteora");
    mockFetch.mockResolvedValueOnce(textResponse("{bad-json"));

    const result = await fetchMeteoraPools();

    expect(result.pools).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.errors[0]).toContain("invalid JSON");
  });

  it("returns a degraded result when Meteora returns a null root", async () => {
    const { fetchMeteoraPools } = await import("../fetch-meteora");
    mockFetch.mockResolvedValueOnce(textResponse("null"));

    const result = await fetchMeteoraPools();

    expect(result.pools).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.errors[0]).toContain("non-object JSON root");
  });

  it("skips malformed Meteora rows while preserving valid rows from the same page", async () => {
    const { fetchMeteoraPools } = await import("../fetch-meteora");
    mockFetch.mockResolvedValueOnce(jsonResponse({
      data: [
        {
          address: "BrokenPool",
          token_y: { address: "USDC111", symbol: "USDC", decimals: 6, price: 1 },
          token_x_amount: 100,
          token_y_amount: 100,
          tvl: 20_000,
        },
        {
          address: "Pool111",
          token_x: { address: "So111", symbol: "SOL", decimals: 9, price: 90 },
          token_y: { address: "USDC111", symbol: "USDC", decimals: 6, price: 1 },
          token_x_amount: 100,
          token_y_amount: 9000,
          current_price: 90,
          tvl: 18_000,
          volume: { "24h": 25_000 },
          pool_config: { base_fee_pct: 0.01 },
          dynamic_fee_pct: 0.002,
          is_blacklisted: false,
        },
      ],
    }));

    const result = await fetchMeteoraPools();

    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0].poolAddress).toBe("Pool111");
    expect(result.errors).toContain("page 1 skipped 1 malformed pool rows");
  });
});
```

**Idioms to match (required by A1 rewrite):**
- Top-level `const mockFetch = vi.fn(); vi.stubGlobal("fetch", mockFetch);`
- Per-test `mockFetch.mockResolvedValueOnce(jsonResponse({ data: [...] }))`
  followed by a `.mockResolvedValueOnce(jsonResponse({ data: [] }))` to
  terminate the pagination loop.
- `await fetchMeteoraPools()` with **no arguments** — the function signature
  is `fetchMeteoraPools(signal?: AbortSignal)`.
- Tests import inside the test body via `const { fetchMeteoraPools } = await import("../fetch-meteora");` because `vi.resetModules()` runs in `afterEach`.
- There's no `fixtures/` directory. Existing tests hard-code the payload
  shape inline.

---

### 3. `worker/src/cron/dex-liquidity/fetch-fluid.ts`

#### Imports (lines 1-9)
```ts
import {
  DIRECT_API_POOL_MIN_TVL_USD,
  makeDexApiFetchResult,
  type DexApiFetchResult,
  type DexApiPool,
} from "../../lib/dex-api-common";
import { USER_AGENT } from "../../lib/constants";
import { fetchEvmCallHexAtBlock } from "../../lib/evm-rpc";
import { buildChainRpcs, type ChainRpcConfig } from "../../lib/chain-registry";
```

#### Exports
- `fetchFluidPools(signal?: AbortSignal, chainRpcs?: Map<string, ChainRpcConfig>): Promise<DexApiFetchResult>` — only export.

#### `fetchFluidPools` per-ticker loop (lines 141-202)
```ts
export async function fetchFluidPools(
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<DexApiFetchResult> {
  const results: DexApiPool[] = [];
  const errors: string[] = [];
  let successfulChains = 0;
  const resolvedChainRpcs = chainRpcs ?? buildChainRpcs();

  for (const [chain, chainId] of Object.entries(FLUID_CHAINS) as Array<[keyof typeof FLUID_CHAINS, number]>) {
    const url = `${FLUID_API_BASE}/${chainId}/dexes/stats/tickers`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        throw new Error(`${chain} returned ${res.status}`);
      }
      const tickers = await res.json() as unknown;
      if (!Array.isArray(tickers)) {
        throw new Error(`${chain} returned non-array body`);
      }

      const pools = (tickers as FluidTicker[]).map((t): DexApiPool | null => {
        const tvlUsd = parseFloat(t.liquidity_in_usd);
        const price = parseFloat(t.last_price);
        const baseVol = parseFloat(t.base_volume);
        const targetVol = parseFloat(t.target_volume);
        if (!Number.isFinite(tvlUsd) || tvlUsd <= 0) return null;

        return {
          source: "fluid",
          chain,
          poolAddress: t.pool_id,
          poolType: "fluid-dex",
          tokens: [
            { address: t.base_currency, symbol: "", decimals: 0 },
            { address: t.target_currency, symbol: "", decimals: 0 },
          ],
          price: Number.isFinite(price) && price > 0 ? price : null,
          tvlUsd,
          volume24hUsd:
            (Number.isFinite(baseVol) ? baseVol : 0) +
            (Number.isFinite(targetVol) ? targetVol : 0),
          feeRate: null,
          balances: null,
          tokenVolumes24h: [Number.isFinite(baseVol) ? baseVol : 0, Number.isFinite(targetVol) ? targetVol : 0],
        };
      }).filter((p): p is DexApiPool => p !== null);
```

**Critical finding (M1)**: Lines 183-185 compute
`volume24hUsd = baseVol + targetVol` where `baseVol = parseFloat(t.base_volume)`
and `targetVol = parseFloat(t.target_volume)`. The Fluid tickers v3 endpoint
returns raw token amounts in `base_volume` / `target_volume` (see the captured
fixture in Part 2: both are `"0"` for USDC/USDT because the endpoint only
returns an `.h24` key for a different field set, not base/target). **The
current code adds two raw-token amounts together and calls the result USD** —
this is the exact bug the audit flagged.

There is **no paginated fetch** in `fetch-fluid.ts`. It iterates a fixed
`FLUID_CHAINS` object and makes one request per chain. F1 (paginated helper
extraction) does not apply to this fetcher.

---

### 4. `worker/src/cron/dex-liquidity/fetch-balancer.ts`

#### Imports (lines 1-3)
```ts
import { makeDexApiFetchResult, type DexApiFetchResult, type DexApiPool } from "../../lib/dex-api-common";
import { USER_AGENT } from "../../lib/constants";
import { isDexApiRecord, readDexApiJson } from "./direct-api-json";
```

#### Exports
- `fetchBalancerPools(signal?: AbortSignal): Promise<DexApiFetchResult>` — only export (line 118).

#### Parse loop around `totalLiquidity` check and `price` assignment (lines 168-227)
```ts
    let malformedRows = 0;
    for (const rawPool of pools) {
      if (!isBalancerPool(rawPool)) {
        malformedRows++;
        continue;
      }

      const pool = rawPool;
      if (!SUPPORTED_POOL_TYPES.has(pool.type)) continue;

      const chain = BALANCER_CHAIN_MAP[pool.chain];
      if (!chain) continue;

      const tvlUsd = parseFloat(pool.dynamicData.totalLiquidity);
      const volume24h = parseFloat(pool.dynamicData.volume24h);
      const swapFee = parseFloat(pool.dynamicData.swapFee);
      if (!Number.isFinite(tvlUsd) || tvlUsd <= 0) continue;

      const isStable = STABLE_POOL_TYPES.has(pool.type);
      const poolType = isStable ? "balancer-stable" : "balancer-weighted";

      const balances = pool.poolTokens.map((t) => parseFloat(t.balance)).filter(Number.isFinite);

      // Derive price from balanceUSD / balance for each token
      let price: number | null = null;
      for (const t of pool.poolTokens) {
        const bal = parseFloat(t.balance);
        const balUsd = parseFloat(t.balanceUSD);
        if (Number.isFinite(bal) && bal > 0 && Number.isFinite(balUsd) && balUsd > 0) {
          price = balUsd / bal;
          break; // use first token with valid data
        }
      }

      results.push({
        source: "balancer",
        chain,
        poolAddress: extractBalancerPoolAddress(pool),
        poolType,
        tokens: pool.poolTokens.map((t) => {
          const bal = parseFloat(t.balance);
          const balUsd = parseFloat(t.balanceUSD);
          const weight = t.weight == null ? null : parseFloat(t.weight);
          const tokenPriceUsd = (Number.isFinite(bal) && bal > 0 && Number.isFinite(balUsd) && balUsd > 0)
            ? balUsd / bal : null;
          return {
            address: t.address,
            symbol: t.symbol,
            decimals: t.decimals,
            priceUsd: tokenPriceUsd,
            weight: Number.isFinite(weight) && weight != null && weight > 0 ? weight : null,
          };
        }),
        price,
        tvlUsd,
        volume24hUsd: Number.isFinite(volume24h) ? volume24h : 0,
        feeRate: Number.isFinite(swapFee) ? swapFee : null,
        balances: balances.length === pool.poolTokens.length ? balances : null,
      });
    }
```

**Critical findings (M3 + M4)**:
1. **M3** — there is **no per-pool sanity check** against `pool.dynamicData.totalLiquidity`. A pool where `totalLiquidity` is $337B (see the captured Fantom DEI fixture in Part 2) is passed through as-is.
2. **M4** — `price` is set by walking `poolTokens` and assigning the **first** token's `balanceUSD / balance` ratio as the pool's scalar `price` field. For a `multiUSDC + DEI` pool where `multiUSDC.balance = 0.000001` and `multiUSDC.balanceUSD = 5.68e-8`, the first valid token is DEI (because multiUSDC's tiny balance passes `bal > 0` anyway) and `price = 337_677_697_052 / 1_000_002_064_258 ≈ 0.3377`. This single `price` is then used as the pool's emitted scalar price, which ends up in the DL-price retained-pool pool. The fix has to decide (a) whether to reject such pools at the TVL sanity gate or (b) whether to strip the `price` field entirely when the pool is a weighted pool with grossly-imbalanced balances.

There is no `parseBalancerPoolsResponse` function — the entire parse loop
lives inline inside `fetchBalancerPools`.

---

### 5. `worker/src/cron/dex-liquidity/fetch-slipstream.ts`

#### Imports (lines 1-6)
```ts
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem/utils";
import { makeDexApiFetchResult, type DexApiFetchResult, type DexApiPool } from "../../lib/dex-api-common";
import { fetchEvmCallHexAtBlock } from "../../lib/evm-rpc";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { resolveTrackedStablecoinId } from "./token-resolution";
import { classifyClPoolType, normalizeFeeRateFromBps } from "./direct-source-helpers";
```

#### Exports
- `fetchSlipstreamPools(protocol: SlipstreamProtocol, chainAddressToId, symbolToChainScopedIds, trackedStablecoinPrices, signal?, chainRpcs?): Promise<DexApiFetchResult>` — only export (line 123).

**There is no `fetchAerodromeSlipstreamPools` or `fetchVelodromeSlipstreamPools`.** The single `fetchSlipstreamPools` function takes `protocol: SlipstreamProtocol = "aerodrome-slipstream" | "velodrome-slipstream"` and dispatches via the `SLIPSTREAM_CONFIG` table. Callers in `orchestrator-phases.ts:210-233` wrap each protocol in an arrow function.

#### SUGAR_ABI declaration (lines 11-14)
```ts
const SUGAR_ABI = parseAbi([
  "function all(uint256 _limit, uint256 _offset) view returns ((address lp,string symbol,uint8 decimals,uint256 liquidity,int24 type,int24 tick,uint160 sqrt_ratio,address token0,uint256 reserve0,uint256 staked0,address token1,uint256 reserve1,uint256 staked1,address gauge,uint256 gauge_liquidity,bool gauge_alive,address fee,address bribe,address factory,uint256 emissions,address emissions_token,uint256 pool_fee,uint256 unstaked_fee,uint256 token0_fees,uint256 token1_fees,address nfpm,address alm,address root)[])",
  "function tokens(uint256 _limit, uint256 _offset, address _account, address[] _addresses) view returns ((address token_address,string symbol,uint8 decimals,uint256 account_balance,bool listed)[])",
]);
```

The `all()` struct **does** include `sqrt_ratio: uint160` (Q64.96 format) and `pool_fee: uint256`. But the fetcher **does not currently read `sqrt_ratio`**. It derives price from `reserve1 / reserve0` (see below).

#### Reserve/price/TVL derivation block (lines 141-204)
```ts
    const pools: DexApiPool[] = [];
    for (const pool of clPools) {
      const token0 = tokenMap.get(normalizeAddress(pool.token0));
      const token1 = tokenMap.get(normalizeAddress(pool.token1));
      if (!token0 || !token1) continue;

      const reserve0 = bigintToDecimal(pool.reserve0, token0.decimals);
      const reserve1 = bigintToDecimal(pool.reserve1, token1.decimals);
      if (!Number.isFinite(reserve0) || !Number.isFinite(reserve1) || reserve0 <= 0 || reserve1 <= 0) continue;

      const stable0 = resolveTrackedStablecoinId(
        { chain: config.chain, address: token0.token_address, symbol: token0.symbol },
        { chainAddressToId, symbolToChainScopedIds },
      );
      const stable1 = resolveTrackedStablecoinId(
        { chain: config.chain, address: token1.token_address, symbol: token1.symbol },
        { chainAddressToId, symbolToChainScopedIds },
      );

      let token0PriceUsd = stable0.status === "matched" && stable0.stablecoinId
        ? trackedStablecoinPrices.get(stable0.stablecoinId) ?? null
        : null;
      let token1PriceUsd = stable1.status === "matched" && stable1.stablecoinId
        ? trackedStablecoinPrices.get(stable1.stablecoinId) ?? null
        : null;

      if ((token0PriceUsd == null || token0PriceUsd <= 0) && token1PriceUsd != null && token1PriceUsd > 0) {
        token0PriceUsd = reserve1 > 0 ? (reserve1 * token1PriceUsd) / reserve0 : null;
      }
      if ((token1PriceUsd == null || token1PriceUsd <= 0) && token0PriceUsd != null && token0PriceUsd > 0) {
        token1PriceUsd = reserve0 > 0 ? (reserve0 * token0PriceUsd) / reserve1 : null;
      }

      const tvlUsd = (token0PriceUsd != null && token1PriceUsd != null)
        ? reserve0 * token0PriceUsd + reserve1 * token1PriceUsd
        : 0;
      if (!Number.isFinite(tvlUsd) || tvlUsd <= 0) continue;

      const feeBps = Number(pool.pool_fee);
      pools.push({
        source: protocol,
        chain: config.chain,
        poolAddress: pool.lp,
        poolType: classifyClPoolType(protocol, feeBps),
        tokens: [
          {
            address: token0.token_address,
            symbol: token0.symbol,
            decimals: token0.decimals,
            priceUsd: token0PriceUsd,
          },
          {
            address: token1.token_address,
            symbol: token1.symbol,
            decimals: token1.decimals,
            priceUsd: token1PriceUsd,
          },
        ],
        price: reserve0 > 0 ? reserve1 / reserve0 : null,
        tvlUsd,
        volume24hUsd: 0,
        feeRate: normalizeFeeRateFromBps(feeBps),
        balances: [reserve0, reserve1],
      });
    }
```

**Critical findings (M5 + M6 + m7):**
- **M5**: `price = reserve1 / reserve0` is the **aggregate reserves ratio**, not the active spot price. For a concentrated-liquidity Slipstream pool, the active liquidity is only in a narrow tick range around the current price, so the global reserves ratio is usually NOT the spot price. The correct derivation would use `sqrt_ratio` (which IS in the struct, so no new eth_call is required) and compute `(sqrt_ratio / 2^96)^2` in BigInt. **The plan's A6 task must NOT use `Number()` coercion of `sqrt_ratio`** — for a typical USDC/ETH pool, `sqrt_ratio ~ 7.92e28` which is 14 orders of magnitude past `Number.MAX_SAFE_INTEGER`.
- **M6**: `feeBps = Number(pool.pool_fee)` passes the raw `uint256` field to `classifyClPoolType`. Whether that is actually bps (e.g. `5`, `30`, `100`) or Aerodrome's 1e6-scaled hundredths-of-bps is NOT verified anywhere in the worker. The audit's data-accuracy section M6 calls this out; the plan needs a live fixture to resolve it. No Etherscan API key is available for this agent, and Basescan v1 is deprecated. See `agents/audits/fixtures/2026-04-16-aero-sugar-abi.md` for the deferral recommendation.
- **m7**: `volume24hUsd: 0` is hardcoded — the Slipstream fetcher reports zero volume for every pool. Downstream scoring always prefers a non-zero-volume challenger when deduping. The audit's m7 notes this cedes dedup precedence to DL (when it shouldn't).

---

### 6. `worker/src/cron/dex-liquidity/direct-source-helpers.ts`

#### FULL FILE
```ts
import { buildPoolIdentity, type PoolIdentity } from "./pool-identity";
import type { DexApiPool } from "../../lib/dex-api-common";

export function normalizeFeeRateFromBps(feeBps: number | null | undefined): number | null {
  if (feeBps == null || !Number.isFinite(feeBps) || feeBps <= 0) return null;
  return feeBps / 10_000;
}

export function classifyClPoolType(
  protocol: "pancakeswap" | "aerodrome-slipstream" | "velodrome-slipstream",
  feeBps: number | null | undefined,
): string {
  const normalizedFeeBps = feeBps != null && Number.isFinite(feeBps) ? feeBps : 500;
  const prefix = protocol === "pancakeswap" ? "pancakeswap-v3" : protocol;
  if (normalizedFeeBps <= 1) return `${prefix}-1bp`;
  if (normalizedFeeBps <= 5) return `${prefix}-5bp`;
  return `${prefix}-30bp`;
}

function deriveDirectApiFeeTierBps(pool: DexApiPool): number | null {
  if (pool.feeRate == null || !Number.isFinite(pool.feeRate) || pool.feeRate <= 0) return null;
  return Math.round(pool.feeRate * 10_000 * 100) / 100;
}

export function buildDirectApiPoolIdentity(pool: DexApiPool): PoolIdentity {
  return buildPoolIdentity({
    chain: pool.chain,
    protocol: pool.source,
    poolAddressOrId: pool.poolAddress,
    tokenAddresses: pool.tokens.map((token) => token.address),
    poolType: pool.poolType,
    feeTierBps: deriveDirectApiFeeTierBps(pool),
    isStable: pool.poolType.includes("stable") || pool.poolType.includes("fluid"),
  });
}
```

**Critical finding (audit C2 + M7)**: `classifyClPoolType` only has three
buckets: `<=1bp`, `<=5bp`, and else → `-30bp`. There is **no `25bp` branch and
no `100bp` branch**. PancakeSwap V3 has tiers 1, 5, 25, 100 — any PCS pool at
25bp gets labeled `-30bp`, any PCS pool at 100bp also gets labeled `-30bp`.
There's no `pancakeswap-v3-25bp` or `pancakeswap-v3-100bp` key in
`QUALITY_MULTIPLIERS` (see section 20), so the plan's A2 task must add both
the new classifier branches AND new multiplier entries in the same commit.

---

### 7. `worker/src/cron/dex-liquidity/coingecko-onchain-shared.ts`

#### FULL FILE (lines 1-117)

See section 7 in the raw read above — the file exports:
- `inferCgBalanceRatio(baseTokenPriceUsd: number, quoteTokenPriceUsd: number): number | null` (line 21)
- `parseCgPool(pool: CgPool): ParsedPool | null` (line 35)
- `classifyCgPool(parsed, rawAttrs): CgPoolClassification` (line 58)
- Type `CgPoolClassification` (line 7)

**There is no `parseCgOnchainPoolList` export.** The plan's Task A4 invented
this name.

#### Consumers of `inferCgBalanceRatio` (from `rg -n "inferCgBalanceRatio" worker/`)

1. **`worker/src/cron/dex-liquidity/coingecko-onchain-shared.ts:21`** — definition.
2. **`coingecko-onchain-shared.ts:72`** — called from `classifyCgPool` in the `<=0.01` (1bp) fee branch.
3. **`coingecko-onchain-shared.ts:82`** — called from `classifyCgPool` in the `<=0.05` (5bp) fee branch.
4. **`coingecko-onchain-shared.ts:92`** — called from `classifyCgPool` in the `<=0.30` (30bp) fee branch.
5. **`coingecko-onchain-shared.ts:101`** — called from `classifyCgPool` in the `>0.30` (wide-fee) branch.
6. **`coingecko-onchain-shared.ts:114`** — called from the no-fee-percentage fallback branch of `classifyCgPool`.
7. **`worker/src/cron/dex-liquidity/__tests__/fetch-crawlers.test.ts:3`** — test import.
8. **`fetch-crawlers.test.ts:91-93`** — direct unit tests.

**Every consumer of `inferCgBalanceRatio` is inside `classifyCgPool` itself**, not at an outer call site. The `balanceRatio` field set on `CgPoolClassification` then flows out to two places:

- **`fetch-crawlers.ts:120`** (`buildNewPool` for CG crawl): `balanceRatio` is read from the classification and stamped on the resulting `CgNewPool`. **This is where `CgNewPool.balanceRatio` is populated for the direct-crawl path.**
- **`crawl-sources.ts:145`** (dex-discovery `crawlCoin` Stage 1 CG onchain): `classifyCgPool` returns the classification, and `balanceRatio` is stamped on `StagedPool.balanceRatio` at line 159. **This is where `StagedPool.balanceRatio` is populated for the staging-discovery path.**

Neither call site sets a `measurement.balanceMeasured` flag based on the CG-derived ratio — `balanceMeasured` is set by `addSecondaryPoolContribution` in `pool-contribution.ts:31` (`hasMeasuredBalance = pool.balanceRatio != null && Number.isFinite(pool.balanceRatio)`) and then by `hasMeasuredBalance ? { balanceRatio: ..., balanceDetails: ... } : {}` in the `extra` object (line 86-89). **But `addSecondaryPoolContribution` never writes `balanceMeasured` into `measurement` for the secondary path** — the `measurement` flag is passed through from the upstream crawler's own `measurement` object. For `fetch-crawlers.ts:120` the crawler sets `balanceMeasured: balanceRatio != null` (line 126). For `crawl-sources.ts` the staging row does not set any measurement flag — `staging-merge.ts:350` sets `balanceMeasured: stagedPool.balanceRatio != null` when converting the staged row back to a `CgNewPool`.

**The audit M2 bug root cause**: `inferCgBalanceRatio` is a **price-ratio**
fallback (`min(basePrice, quotePrice) / max(basePrice, quotePrice)`) that only
fires for pairs where both prices differ by < 2×. **It is NOT a real
balance ratio**. The plan's Task A4 should (a) rename the helper and the
`balanceRatio` field it populates, or (b) make `balanceMeasured = false` when
the value came from the price-ratio fallback rather than from genuine
on-chain balance data, or (c) drop the price-ratio fallback entirely and
leave `balanceRatio = null` for CG pools (CG's `/pools` endpoint never
returns real pool reserves).

**There is no `measurement.balanceMeasured = true` assignment inside
`coingecko-onchain-shared.ts`.** The plan's claim that there is a CG "pool
constructor (same file)" that sets this flag is false.

---

### 8. `worker/src/cron/dex-liquidity/scoring-helpers.ts` — `accumulateGlobalAggregate`

#### Signature + body (lines 239-268)
```ts
export function accumulateGlobalAggregate(
  pools: LiquidityMetrics["topPools"],
  globalSeenPools: Set<string>,
  globalProtocolTvl: Record<string, number>,
  globalChainTvl: Record<string, number>,
  globalProtoChainTvl: Record<string, number>,
  globalChains: Set<string>,
): { totalTvl: number; totalVol24h: number; totalVol7d: number; poolCount: number } {
  let totalTvl = 0;
  let totalVol24h = 0;
  let totalVol7d = 0;
  let poolCount = 0;

  for (const pool of pools) {
    if (globalSeenPools.has(pool.poolId)) continue;
    globalSeenPools.add(pool.poolId);
    totalTvl += pool.tvlUsd;
    totalVol24h += pool.volumeUsd1d;
    totalVol7d += pool.volumeUsd7d ?? 0;
    poolCount++;
    const chainKey = pool.chain.toLowerCase();
    globalChains.add(chainKey);
    const proto = normalizeProtocol(pool.project);
    globalProtocolTvl[proto] = (globalProtocolTvl[proto] ?? 0) + pool.tvlUsd;
    globalChainTvl[chainKey] = (globalChainTvl[chainKey] ?? 0) + pool.tvlUsd;
    globalProtoChainTvl[`${proto}:${chainKey}`] = (globalProtoChainTvl[`${proto}:${chainKey}`] ?? 0) + pool.tvlUsd;
  }

  return { totalTvl, totalVol24h, totalVol7d, poolCount };
}
```

#### Callers (from `rg -n "accumulateGlobalAggregate" worker/src/cron/dex-liquidity/`)
- **Definition**: `scoring-helpers.ts:239`
- **Single caller**: `scoring.ts:153` (imported at `scoring.ts:12`)

#### The single call site in `scoring.ts` (lines 123-159)
```ts
  const results = new Map<string, FullScoreResult>();
  const retainedPoolsByStablecoin = new Map<string, LiquidityMetrics["topPools"]>();

  // Global dedup accumulators — accumulated per-coin BEFORE top-10 truncation
  const globalSeenPools = new Set<string>();
  const globalProtocolTvl: Record<string, number> = {};
  const globalChainTvl: Record<string, number> = {};
  const globalProtoChainTvl: Record<string, number> = {}; // "proto:chain" → TVL
  let globalTotalTvl = 0;
  let globalTotalVol24h = 0;
  let globalTotalVol7d = 0;
  let globalPoolCount = 0;
  const globalChains = new Set<string>();
  const protocolCapDiagnostics: ProtocolCapDiagnostics = { cappedPoolCount: 0, cappedProtocols: 0, reducedTvlUsd: 0 };

  for (const [id, m] of metrics) {
    m.topPools = filterRetainedPools(m.topPools);
    const capResult = applyProtocolCaps(m.topPools, protocolTvlCaps);
    protocolCapDiagnostics.cappedPoolCount += capResult.cappedPoolCount;
    protocolCapDiagnostics.cappedProtocols += capResult.cappedProtocols;
    protocolCapDiagnostics.reducedTvlUsd += capResult.reducedTvlUsd;

    const retainedPools = [...m.topPools];
    retainedPoolsByStablecoin.set(id, retainedPools.map((pool) => ({
      ...pool,
      extra: pool.extra ? { ...pool.extra } : undefined,
    })));
    const rebuilt = rebuildMetricsFromPools(retainedPools);

    applyRebuiltMetrics(m, rebuilt);
    const globalDelta = accumulateGlobalAggregate(
      retainedPools, globalSeenPools, globalProtocolTvl, globalChainTvl, globalProtoChainTvl, globalChains,
    );
    globalTotalTvl += globalDelta.totalTvl;
    globalTotalVol24h += globalDelta.totalVol24h;
    globalTotalVol7d += globalDelta.totalVol7d;
    globalPoolCount += globalDelta.poolCount;
```

**Critical finding (Critical 1 in the review)**:
`accumulateGlobalAggregate` is invoked **inside a `for (const [id, m] of metrics)` loop** — one call per tracked stablecoin. It mutates the passed-in `globalSeenPools: Set<string>` and the `global*Tvl` record objects in-place and returns per-call deltas that the caller sums. The "first wins on poolId collision" semantics (MED-4 in the dedup audit) come from `if (globalSeenPools.has(pool.poolId)) continue;` at line 253 — once a `poolId` has been seen, subsequent calls skip it even if they have higher TVL.

**There is no `initGlobalAggregate` or `agg` mutator object.** The plan's Task B1.1 invented both. The correct B1.1 test must:
1. Import `accumulateGlobalAggregate` with the real six-argument signature.
2. Pre-build the `globalSeenPools`, `globalProtocolTvl`, `globalChainTvl`, `globalProtoChainTvl`, `globalChains` external state.
3. Call it twice with pool sets that both contain the same `poolId` but different `tvlUsd` values.
4. Assert that the first call's TVL is the one that "won" (current behavior) OR the higher TVL is the one that "won" (fixed behavior).

For MED-4's "prefer higher TVL" fix, the simplest implementation is to (a) make `globalSeenPools` a `Map<poolId, tvl>`, (b) before skipping, compare the incoming TVL against the stored TVL, (c) if the incoming is larger, subtract the previously-counted TVL from all the global aggregates and re-add the new one. Alternatively, collect all pool contributions across all stablecoins first, resolve duplicates, then do a single accumulation pass — but that requires restructuring `scoring.ts`'s outer loop.

---

### 9. `worker/src/cron/dex-liquidity/scoring.ts` — aggregate declarations + call site

See the full snippet under section 8. The aggregate declarations are at lines 127-136:

```ts
  const globalSeenPools = new Set<string>();
  const globalProtocolTvl: Record<string, number> = {};
  const globalChainTvl: Record<string, number> = {};
  const globalProtoChainTvl: Record<string, number> = {}; // "proto:chain" → TVL
  let globalTotalTvl = 0;
  let globalTotalVol24h = 0;
  let globalTotalVol7d = 0;
  let globalPoolCount = 0;
  const globalChains = new Set<string>();
```

Later (lines 225-240), a **second pass** does per-protocol cap enforcement and reduces `globalChainTvl` proportionally:

```ts
  let globalCapReduction = 0;
  for (const proto of Object.keys(globalProtocolTvl)) {
    const cap = protocolTvlCaps.get(proto);
    if (cap != null && cap > 0 && globalProtocolTvl[proto] > cap) {
      const excess = globalProtocolTvl[proto] - cap;
      globalCapReduction += excess;
      // Distribute reduction to chain TVLs proportionally
      const protoTotal = globalProtocolTvl[proto];
      for (const [pcKey, pcTvl] of Object.entries(globalProtoChainTvl)) {
        if (!pcKey.startsWith(`${proto}:`)) continue;
        const chain = pcKey.slice(proto.length + 1);
        const chainReduction = (pcTvl / protoTotal) * excess;
        globalChainTvl[chain] = Math.max(0, (globalChainTvl[chain] ?? 0) - chainReduction);
      }
      globalProtocolTvl[proto] = cap;
    }
  }
  globalTotalTvl -= globalCapReduction;
```

Any MED-4 fix that changes the first-wins semantics must also cope with this post-hoc cap reduction — the global cap math currently assumes the accumulator is monotonic.

---

### 10. `worker/src/cron/dex-liquidity/process-pools.ts` — Curve metapool branch + topPools push

#### Full imports (lines 1-15)
```ts
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { QUALITY_MULTIPLIERS, isBlockedDexId } from "../../lib/dex-constants";
import type { LlamaPool, CurvePoolEntry, LiquidityMetrics } from "./types";
import {
  parsePoolSymbols,
  classifyPoolType,
  getQualityMultiplier,
  normalizeProtocol,
  computePoolPairQuality,
  computePoolStress,
  initMetrics,
  isCryptoSwap,
} from "./pool-helpers";
import { getChainScopedSymbolIds, makeChainAddressKey, normalizeTokenAddress } from "./token-resolution";
```

#### Exports
- `processPoolMetrics(pools, dexProjects, symbolToIds, symbolToChainScopedIds, addressToId, chainAddressToId, curvePoolMap, uniV3PoolFees, uniV3SymbolFees, aerodromeIsStable): Map<string, LiquidityMetrics>` — only export (line 18).

#### Curve metapool-adjusted-TVL branch (lines 107-122) + topPools push with poolId (lines 234-236)
```ts
      if (curveData) {
        balanceRatio = curveData.balanceRatio;
        balanceHealth = Math.pow(balanceRatio, 1.5);
        balanceDetails = curveData.balanceDetails;
        // v2: CryptoSwap vs StableSwap
        if (isCryptoSwap(curveData.registryId)) {
          resolvedPoolType = "curve-cryptoswap";
          qualMult = QUALITY_MULTIPLIERS["curve-cryptoswap"]!;
        } else {
          resolvedPoolType = curveData.A >= 500 ? "curve-stableswap-high-a" : "curve-stableswap";
          qualMult = getQualityMultiplier(resolvedPoolType, curveData.A);
        }
        // Use metapool-adjusted TVL only for address-based matches (the actual Curve pool).
        // Symbol fallbacks may match a different physical pool sharing the same token pair —
        // those pools must use their own TVL, not the Curve pool's.
        effectivePoolTvl = curveAddressMatch ? curveData.metapoolAdjustedTvl : pool.tvlUsd;
```

```ts
      for (const id of matchedIds) {
        // ...
        m.topPools.push({
          poolId: `${pool.chain.toLowerCase()}:${pool.pool.toLowerCase()}`,
          project: protocol,
          chain: pool.chain,
          tvlUsd: pool.tvlUsd,
          symbol: pool.symbol,
          // ...
        });
```

**Critical findings (MED-3 + HIGH-1):**
1. **MED-3**: `effectivePoolTvl = curveData.metapoolAdjustedTvl` is computed but only used in `m.effectiveTvl += poolEffTvl` (where `poolEffTvl = effectivePoolTvl * combinedQuality`). **`m.totalTvlUsd += pool.tvlUsd` still uses the raw (un-adjusted) `pool.tvlUsd`** (line 199). This means a Curve metapool contributes its FULL un-adjusted TVL to `m.totalTvlUsd` even though the LP token share has already been stripped out. B1.3 needs to change `m.totalTvlUsd += pool.tvlUsd` on line 199 to `m.totalTvlUsd += effectivePoolTvl` (or a new `rawTvlUsd` variable that tracks the already-adjusted value).
2. **HIGH-1**: `poolId: \`${pool.chain.toLowerCase()}:${pool.pool.toLowerCase()}\`` uses the DL opaque `pool` UUID directly. DL-reported `pool` is an **opaque DefiLlama UUID**, NOT an on-chain address. For the Curve `USDC/USDT/DAI` 3pool it's `0x1d6a…`-like — addressable in DL's own registry but NOT byte-equal to any direct-API poolId. The `__global__` dedupe in `scoring.ts` compares poolIds across DL and direct-API paths verbatim, so pools stamped here with a DL UUID will never dedupe against a direct-API pool with the same underlying on-chain address. **This is the HIGH-1 bug.** The fix is to stamp a canonical fingerprint (`chain:normalized-address:[token0,token1]`) at this site (and at the equivalent site in `pool-contribution.ts:75` for the secondary path — see section 11), using the existing `buildPoolFingerprint()` helper from `pool-helpers.ts:196`.

---

### 11. `worker/src/cron/dex-liquidity/pool-contribution.ts` — stamping site

#### Exports
- `addSecondaryPoolContribution(metrics, stablecoinId, stablecoinSymbol, pool)` (line 17)
- `SecondaryPool` type alias (line 11): `type SecondaryPool = GtNewPool | CgNewPool;`

#### topPools push site (lines 74-104)
```ts
  m.topPools.push({
    poolId: `${pool.chain.toLowerCase()}:${pool.address.toLowerCase()}`,
    project: protocol,
    chain: chainDisplay,
    tvlUsd: pool.tvlUsd,
    // ...
  });
```

**Critical finding (Critical 2 in the review)**: The plan proposed rewriting the `poolId` here to `buildCanonicalPoolId({ ..., tokenAddresses: [pool.baseToken, pool.quoteToken] })`. **Neither `GtNewPool` nor `CgNewPool` has `baseToken` or `quoteToken` fields.** See section 12 for the full type definitions. `GtNewPool.address` is already a lowercased on-chain address (it's derived from the upstream `parsed.poolAddress` at every construction site; see `fetch-crawlers.ts:108`, `fetch-fallbacks.ts:204`, `staging-merge.ts:330`, and all direct-API conversion sites in `dex-api-common`). So:

- DL path (`process-pools.ts:235`): stamps `${chain}:${DL-UUID}` — NOT canonical.
- Secondary path (`pool-contribution.ts:75`): stamps `${chain}:${lowercased-on-chain-address}` — already canonical for every current source (GT / CG onchain / direct API / DexScreener / staged cg_tickers which uses `orderbook-{id}` synthetic address).

**The HIGH-1 fix only needs to touch `process-pools.ts:235`.** The secondary path is already correct because `GtNewPool.address` is always an on-chain address or an `orderbook-` prefixed synthetic id.

Separately, if the plan wants to add **token-pair fingerprint fallback** (e.g. to catch the case where two on-chain addresses differ by case/checksum), `addSecondaryPoolContribution` does not currently have access to the token addresses — they are not plumbed through from `GtNewPool`. Adding them requires threading token addresses through every `GtNewPool`/`CgNewPool` construction site, which is a much larger change than the HIGH-1 fix needs.

---

### 12. `worker/src/cron/dex-liquidity/types.ts` — type definitions

#### `PoolEntry` (lines 83-120)
```ts
export interface PoolEntry {
  poolId: string;
  project: string;
  chain: string;
  tvlUsd: number;
  symbol: string;
  volumeUsd1d: number;
  volumeUsd7d?: number | null;
  poolType: string;
  /** Canonical source family for coverage-confidence accounting and UI attribution. */
  source: LiquidityPoolSourceFamily;
  /** DEX-implied price of the tracked stablecoin in this pool (USD). */
  price?: number;
  extra?: {
    amplificationCoefficient?: number;
    balanceRatio?: number;
    feeTier?: number;
    qualityAdjustedTvl?: number;
    effectiveTvl?: number;
    organicFraction?: number;
    hasMeasuredOrganicFraction?: boolean;
    pairQuality?: number;
    stressIndex?: number;
    isMetaPool?: boolean;
    maturityDays?: number;
    registryId?: string;
    lockedLiquidityPct?: number | null;
    orderbookDepthUsd?: number;
    orderbookDepthUpUsd?: number;
    orderbookTvlBasis?: "volume-derived" | "coingecko-depth-2pct-capped-by-volume";
    balanceDetails?: {
      symbol: string;
      balancePct: number;
      isTracked: boolean;
    }[];
    measurement?: PoolMeasurementFlags;
  };
}
```

#### `GtNewPool` (lines 259-298)
```ts
export interface GtNewPool {
  address: string;
  chain: string;
  dexId: string;
  name: string;
  tvlUsd: number;
  volume24hUsd: number;
  qualityMultiplier: number;
  maturityDays: number;
  /** The stablecoin's price in this pool */
  price: number;
  /** Pool symbol (e.g., "USDC / USDT") */
  symbol: string;
  /** Discovery/source-specific pool type used for quality weighting */
  poolType: string;
  /** Canonical source family for later merge attribution. */
  sourceFamily: Exclude<LiquidityPoolSourceFamily, "dl">;
  /** Optional per-pool 7d volume when source provides it */
  volume7dUsd?: number | null;
  /** Optional measured balance ratio from richer direct/discovery APIs. */
  balanceRatio?: number | null;
  /** Optional normalized fee tier in basis points. */
  feeTierBps?: number | null;
  /** Optional token balance composition details for richer top-pool UI. */
  balanceDetails?: {
    symbol: string;
    balancePct: number;
    isTracked: boolean;
  }[];
  /** Optional pair-quality override for synthetic/non-AMM liquidity families. */
  pairQualityOverride?: number | null;
  /** Measurement/provenance flags for downstream confidence accounting. */
  measurement?: PoolMeasurementFlags;
  /** CoinGecko 2% downside orderbook depth when available. */
  orderbookDepthUsd?: number | null;
  /** CoinGecko 2% upside orderbook depth when available. */
  orderbookDepthUpUsd?: number | null;
  /** How synthetic orderbook TVL was derived. */
  orderbookTvlBasis?: "volume-derived" | "coingecko-depth-2pct-capped-by-volume";
}
```

#### `CgNewPool` (lines 300-307)
```ts
export interface CgNewPool extends GtNewPool {
  /** Balance ratio computed from base/quote token balances (null if unavailable) */
  balanceRatio: number | null;
  /** Locked liquidity percentage (null if unavailable) */
  lockedLiquidityPct: number | null;
  /** Pool fee percentage from CG (null if unavailable) */
  feePercentage: number | null;
}
```

#### `LiquidityMetrics` (lines 48-71)
```ts
export interface LiquidityMetrics {
  stablecoinId: string;
  symbol: string;
  totalTvlUsd: number;
  totalVolume24hUsd: number;
  totalVolume7dUsd: number;
  poolCount: number;
  chains: Set<string>;
  pairs: Set<string>;
  protocolTvl: Record<string, number>;
  chainTvl: Record<string, number>;
  qualityAdjustedTvl: number;
  topPools: PoolEntry[];
  // v2 fields
  effectiveTvl: number;
  organicTvlWeightedSum: number;
  totalTvlForOrganic: number;
  balanceRatioWeightedSum: number;
  totalTvlForBalance: number;
  stressWeightedSum: number;
  oldestPoolDays: number;
  lockedLiqWeightedSum: number;
  totalTvlForLocked: number;
}
```

**No `baseToken`, `quoteToken`, or `dexId` + token-pair fields exist on
`GtNewPool`, `CgNewPool`, or `PoolEntry`.**

---

### 13. `worker/src/cron/dex-liquidity/staging-merge.ts` — `pool_id` split + `buildPoolIdentity` call

#### `buildPoolIdentity` call site (lines 243-251)
```ts
      const poolAddressOrId = stagedPool.poolId.includes(":")
        ? stagedPool.poolId.split(":").slice(1).join(":")
        : stagedPool.poolId;
      const identity = buildPoolIdentity({
        chain: stagedPool.chain,
        protocol: profile.dexId,
        poolAddressOrId,
        tokenAddresses: [stagedPool.baseToken ?? "", stagedPool.quoteToken ?? ""],
        poolType: profile.poolType,
        feeTierBps: stagedPool.feeTier,
        isStable: stagedPool.isStable,
      });
```

**Note**: This is the staging path where the `poolId` split-on-colon is correctly `split(":").slice(1).join(":")` because a staged `orderbook:kinesis:kau` id has two colons.

#### The `split(":")[1]` site (line 330)
```ts
    const adjustedVolume = (stagedPool.volume24h ?? 0) * confidence;
    const address = stagedPool.poolId.split(":")[1] ?? stagedPool.poolId;
    const maturityDays = stagedPoolMaturityDays(stagedPool.discoveredAt, nowSec);
```

**Critical finding (HIGH-3 / audit dedup)**: `split(":")[1]` is used to derive the `address` that gets stamped on the emitted `GtNewPool` / `CgNewPool`. For `chain:0xabc…`, `split(":")[1] = "0xabc…"` — fine. For `orderbook:kinesis:kau`, `split(":")[1] = "kinesis"` — **the address loses the stablecoin discriminator**. Two Kinesis stablecoins (KAU and KAG) would both get `address = "kinesis"` and produce identical secondary-path `poolId`s at `pool-contribution.ts:75`.

This is the HIGH-3 bug. The fix is to use the same logic as `poolAddressOrId` at line 240 (`stagedPool.poolId.includes(":") ? stagedPool.poolId.split(":").slice(1).join(":") : stagedPool.poolId`).

---

### 14. `worker/src/cron/dex-liquidity/fetch-fallbacks.ts` — `fetchCgTickersFallback`

#### Signature (line 266)
```ts
export async function fetchCgTickersFallback(
  metrics: Map<string, LiquidityMetrics>,
  priceObservations: Map<string, DexPriceObs[]>,
  signal?: AbortSignal,
  deadlineMs?: number,
  references?: PriceValidationReferences,
  coingeckoApiKey?: string | null,
): Promise<{ newPools: Map<string, GtNewPool[]>; priceObs: Map<string, DexPriceObs[]> }>
```

#### The orderbook pool emission (lines 316-343)
```ts
      const pools: GtNewPool[] = [];
      for (const summary of exchangeSummaries) {
        const orderbookMetadata = buildCgTickerOrderbookMetadata(summary);
        pools.push({
          address: `orderbook-${summary.exchangeId}`,
          chain: "orderbook",
          dexId: summary.exchangeId,
          name: summary.exchangeName,
          tvlUsd: summary.syntheticTvlUsd,
          volume24hUsd: summary.volumeUsd,
          qualityMultiplier: QUALITY_MULTIPLIERS["orderbook"],
          maturityDays: 30,
          poolType: "orderbook",
          price: summary.priceUsd,
          symbol: `${meta.symbol} / ORDERBOOK-USD`,
          sourceFamily: "cg_tickers",
          pairQualityOverride: 0.85,
          ...(orderbookMetadata ?? {}),
          measurement: {
            tvlMeasured: summary.depthDownUsd != null,
            volumeMeasured: true,
            balanceMeasured: false,
            maturityMeasured: false,
            priceMeasured: true,
            synthetic: true,
          },
        });
      }
```

**Critical finding (HIGH-3 scenario A)**: `address = \`orderbook-${summary.exchangeId}\`` does NOT contain the stablecoin id. Two different stablecoins (e.g. KAU and KAG, both listed on Kinesis) will both emit a `GtNewPool` with `address = "orderbook-kinesis"`. When `pool-contribution.ts:75` stamps `poolId = \`${chain.toLowerCase()}:${pool.address.toLowerCase()}\`` this collapses to `orderbook:orderbook-kinesis` for both, and the global dedupe in `scoring.ts` will drop one.

#### Call sites (from rg)
- `orchestrator-phases.ts:29` — imported
- `orchestrator-phases.ts:568` — called from `runFallbackCrawlerPhase`
- `worker/src/cron/__tests__/sync-dex-liquidity.test.ts:62` — mocked in the orchestrator test

---

### 15. `worker/src/cron/dex-discovery/crawl-sources.ts` — staged orderbook pool_id

#### Line 444 with context (lines 443-461)
```ts
          for (const summary of exchangeSummaries) {
            const poolId = `orderbook:${summary.exchangeId}:${stablecoinId}`.toLowerCase();
            if (knownPoolIds.has(poolId)) continue;
            const orderbookMetadata = buildCgTickerOrderbookMetadata(summary);

            addPool({
              poolId,
              stablecoinId,
              source: "cg_tickers",
              chain: "orderbook",
              protocol: summary.exchangeId,
              dexId: summary.exchangeId,
              symbol: `${stablecoinMeta?.symbol ?? stablecoinId} / USD`,
              tvlUsd: summary.syntheticTvlUsd,
              volume24h: summary.volumeUsd,
              qualityMultiplier: QUALITY_MULTIPLIERS["orderbook"],
              poolType: "orderbook",
              feeTier: null,
```

**Critical finding (HIGH-3 scenario B)**: The staged-discovery path at line 444 **does** include `stablecoinId` in the poolId, producing `orderbook:kinesis:kau`. But this three-segment format then collides with `staging-merge.ts:330`'s `.split(":")[1]` logic which extracts `"kinesis"`. **The two sources of orderbook pool ids are using incompatible conventions** — the discovery-stage writes three segments, the merge-stage reads the second segment. This is the HIGH-3 bug from the dedup audit.

---

### 16. `worker/src/cron/dex-liquidity/orchestrator.ts` — `filterPrimaryPoolsPreferDirectApi`

#### Signature + body (lines 42-111)

Already pasted in full in the raw reads (section 17 previously). Summary:

```ts
export function filterPrimaryPoolsPreferDirectApi(
  pools: LlamaPool[],
  directApiPools: DexApiPool[],
): {
  filteredPools: LlamaPool[];
  skippedByExactIdentity: number;
  skippedByUniqueDerivedIdentity: number;
  skippedByOptionalWildcardIdentity: number;
}
```

**The function is defined in `orchestrator.ts`, not `pool-identity.ts`.** It is called from `buildDexLiquidityPoolState` at `orchestrator.ts:286`. If Task F2 wants to move it, the move must update both the definition site and the import at `orchestrator.ts`.

---

### 17. `worker/src/cron/dex-liquidity/orchestrator-phases.ts`

#### `buildDexDirectApiFetchers` (lines 138-236)

Already pasted above. Key points:

- Takes `{ graphApiKey, chainAddressToId, symbolToChainScopedIds, stablecoinPriceById, chainRpcs? }`.
- Returns an array of 8 `DirectApiFetcher` entries: Fluid, Balancer, PancakeSwap, Meteora, Raydium, Orca, Aerodrome Slipstream, Velodrome Slipstream.
- Each entry has a hardcoded `supportedChains` list used by `buildAuthoritativeStagedPoolConfirmationIndex`.
- The `fn` fields are arrow-wrapped `fetchXPools` calls.

#### `fetchMajorStablecoinOrderbookDepthSummary` invocation (line 593)
```ts
  try {
    directCexOrderbookDepth = await fetchMajorStablecoinOrderbookDepthSummary(params.signal);
  } catch (err) {
    rethrowIfAborted(err, params.signal);
    console.warn("[dex-liquidity] Direct CEX orderbook depth telemetry failed (non-fatal):", err);
    params.failedSources.push("direct-cex-orderbook-depth");
  }
```

**Note**: This is called inside `runFallbackCrawlerPhase` as a non-fatal telemetry probe. There is **no circuit breaker** wrapping this call — failures only push to `failedSources` as a plain string, not a `CIRCUIT_SOURCE` entry. If Task A7 wants to add circuit-breaker protection (audit m12), it needs a new `CIRCUIT_SOURCE` entry (e.g. `CEX_ORDERBOOK_DEPTH`).

#### `integrateDirectApiLiquidityPhase` signature + body (lines 405-526)

Already pasted. Key points:
- Returns `DirectApiIntegrationResult = { directApiDedupSkippedByAddress, directApiDedupSkippedByDerivedIdentity, directApiDedupSkippedByOptionalWildcardIdentity }`.
- Builds `buildDirectApiPoolIdentity` for every pool (including ineligible ones), but only `buildDirectApiPoolIdentity(pool)` for eligible pools goes into the `countPoolIdentityKeys` call.
- Calls `convertToGtNewPools` from `dex-api-common` to transform the retained direct-API pools into `GtNewPool[]`, then `mergeGtPools` into `metrics`.
- Line 473-477: an extra pass forces **every** direct-API pool's `exactPoolKey` into `params.knownPoolIndex.exactKeys`, even for pools too small to score. This is an existing behavior that the HIGH-1 fix must not break.

---

### 18. `worker/src/cron/dex-liquidity/fetch-primary.ts`

#### `fetchGtTokenBatch` (lines 465-499)
```ts
export async function fetchGtTokenBatch(
  _addressToId: Map<string, string>,
  signal?: AbortSignal,
  chainAddresses: Map<string, ProviderChainAddress[]> = buildChainAddresses(GT_CHAIN_MAP),
  deadlineMs?: number,
  references?: PriceValidationReferences,
): Promise<Map<string, DexPriceObs[]>> {
  const { priceObs, requestCount } = await runTokenBatchPriceFetch<GtToken>({
    providerLabel: "GT token batch",
    sourceLabel: "geckoterminal-aggregate",
    signal,
    chainAddresses,
    deadlineMs,
    references,
    beforeRequest: (requestCount, requestSignal) =>
      requestCount > 0
        ? sleepWithSignal(RATE_LIMITS.GECKO_TERMINAL_MS, requestSignal)
        : Promise.resolve(),
    fetchTokens: async (gtChain, addresses, requestSignal) => {
      const url = `${GT_API_BASE}/networks/${gtChain}/tokens/multi/${addresses.join(",")}`;
      const res = await fetchWithRetry(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: requestSignal,
      });
      if (!res?.ok) return [];
      const json = (await res.json()) as { data?: GtToken[] };
      return json.data ?? [];
    },
    getAddress: (token) => token.attributes.address,
    getPriceUsd: (token) => parseFloat(token.attributes.price_usd ?? ""),
    getTvlUsd: (token) => parseFloat(token.attributes.total_reserve_in_usd ?? ""),
  });
  console.log(`[dex-liquidity] GT token batch: ${priceObs.size} coins with price obs (${requestCount} requests)`);
  return priceObs;
}
```

**Critical finding (audit m11, plan Task A7)**: `if (!res?.ok) return [];` — the fetcher silently returns an empty array on HTTP errors. The parent `runTokenBatchPriceFetch` records `successfulBatches` and the circuit-breaker path sees a "success" outcome because the function did not throw. Task A7's proposed fix is to throw on non-2xx, but **the callers of `fetchGtTokenBatch` and `fetchCgTokenBatchPrices` need to be checked** because a new throw changes the failure semantics.

#### Callers (from rg)
- `fetch-primary.ts:465` — definition
- `fetch-primary.ts:503` — `fetchCgTokenBatchPrices` definition
- `worker/src/cron/dex-liquidity/__tests__/fetch-primary.test.ts:36,215,259,290,378,379` — tests only.

**No production caller exists in the dex-liquidity orchestrator!** The functions are imported only in the test file. A grep of `fetchGtTokenBatch|fetchCgTokenBatchPrices` across `worker/src/cron/dex-liquidity/` returns only `fetch-primary.ts` and `__tests__/fetch-primary.test.ts`. This means Task A7 (throw-on-failure) and Task F3 (dead-code cleanup) overlap: **these two exports may be actually dead code**. Verify before Task A7 — throwing from a dead function changes nothing; deleting the function is a much simpler fix.

#### `buildKnownPoolAddresses` (lines 369-441)
```ts
export function buildKnownPoolAddresses(
  pools: LlamaPool[],
  dexProjects: Set<string>,
  curvePoolMap: Map<string, CurvePoolEntry>,
  uniV3PoolFees: Map<string, number>,
  aerodromeIsStable: Map<string, boolean>,
): KnownPoolIdentityIndex {
  const known = createKnownPoolIdentityIndex();
  // ... iterate DL pools, Curve pool map, UniV3, Aerodrome, registering each identity
  return known;
}
```

---

### 19. `worker/src/lib/circuit-breaker.ts`

#### `recordOutcomeSafe` (lines 168-174)
```ts
export async function recordOutcomeSafe(db: D1Database, source: string, success: boolean, webhookUrl?: string | null): Promise<void> {
  try {
    await recordOutcome(db, source, success, webhookUrl);
  } catch (err) {
    console.warn(`[circuit-breaker] Failed to record outcome (${source}):`, err);
  }
}
```

Also exports: `CircuitState`, `CircuitOutcomeDecision`, `CircuitRecord`, `getCircuitRecord`, `shouldAttemptFetch`, `recordOutcome`, `mapCronStatusToCircuitOutcome`, `recordOutcomeDecision`, `getCircuitStates`, `filterStaleLiveReserveCircuitStates`.

---

### 20. `worker/src/lib/constants.ts` — `CIRCUIT_SOURCE`

```ts
export const CIRCUIT_SOURCE = {
  DL_STABLECOINS: "defillama-stablecoins",
  DL_STABLECOIN_DETAIL: "defillama-stablecoin-detail",
  DL_COINS: "defillama-coins",
  DL_YIELDS: "defillama-yields",
  DL_PROTOCOLS: "defillama-protocols",
  CG_PRICES: "coingecko-prices",
  CG_DETAIL_PLATFORMS: "coingecko-detail-platforms",
  CG_MCAP: "coingecko-mcap",
  CG_DISCOVERY: "coingecko-discovery",
  DEXSCREENER_PRICES: "dexscreener-prices",
  DEXSCREENER_SEARCH: "dexscreener-search",
  CMC_PRICES: "coinmarketcap-prices",
  TREASURY_RATES: "treasury-rates",
  ETHERSCAN: "etherscan",
  ALCHEMY: "alchemy",
  TWITTER_API: "twitter-api",
  TELEGRAM_API: "telegram-api",
  PYTH_PRICES: "pyth-prices",
  BINANCE_PRICES: "binance-prices",
  KRAKEN_PRICES: "kraken-prices",
  BITSTAMP_PRICES: "bitstamp-prices",
  COINBASE_PRICES: "coinbase-prices",
  REDSTONE_PRICES: "redstone-prices",
  CURVE_ONCHAIN: "curve-onchain",
  CURVE_LIQUIDITY_API: "curve-liquidity-api",
  FX_FRANKFURTER: "fx-frankfurter",
  FX_REALTIME: "fx-realtime",
  CHAINLINK_FEEDS: "chainlink-feeds",
  JUPITER_PRICES: "jupiter-prices",
  GECKO_TERMINAL_PROBE: "geckoterminal-probe",
  FLUID_DEX_API: "fluid-dex-api",
  BALANCER_API: "balancer-api",
  RAYDIUM_API: "raydium-api",
  ORCA_API: "orca-api",
  METEORA_API: "meteora-api",
  PANCAKESWAP_API: "pancakeswap-api",
  AERODROME_SLIPSTREAM_API: "aerodrome-slipstream-api",
  VELODROME_SLIPSTREAM_API: "velodrome-slipstream-api",
  DRPC: "drpc",
  TRONGRID: "trongrid",
  ANTHROPIC: "anthropic-api",
  BLUECHIP: "bluechip-api",
  CG_TICKER: "coingecko-ticker",
  KINESIS_KAU: "kinesis-kau-horizon",
  KINESIS_KAG: "kinesis-kag-horizon",
} as const;
```

**`CIRCUIT_SOURCE` is a `const` object (`as const`), not a TS enum.** Adding new entries is a simple property addition. The 8 direct-API protocols the plan cares about (Fluid, Balancer, Raydium, Orca, Meteora, Pancake, Aero Slipstream, Velo Slipstream) ALL already have entries. The plan's Task A7 circuit-for-CEX-orderbook-depth needs a new entry that does NOT yet exist — there is no `CEX_ORDERBOOK_DEPTH` or similar.

#### `QUALITY_MULTIPLIERS` in `worker/src/lib/dex-constants.ts`

```ts
export const QUALITY_MULTIPLIERS: Record<string, number> = {
  "curve-stableswap-high-a": 1.0,
  "curve-stableswap": 0.85,
  "curve-cryptoswap": 0.5,
  "uniswap-v3-1bp": 1.1,
  "uniswap-v3-5bp": 0.85,
  "uniswap-v3-30bp": 0.4,
  "pancakeswap-v3-1bp": 1.1,
  "pancakeswap-v3-5bp": 0.85,
  "pancakeswap-v3-30bp": 0.4,
  "pancakeswap-stableswap": 0.85,
  "meteora-dlmm": 0.85,
  "aerodrome-slipstream-1bp": 1.1,
  "aerodrome-slipstream-5bp": 0.85,
  "aerodrome-slipstream-30bp": 0.4,
  "velodrome-slipstream-1bp": 1.1,
  "velodrome-slipstream-5bp": 0.85,
  "velodrome-slipstream-30bp": 0.4,
  "fluid-dex": 0.85,
  "raydium-clmm": 0.85,
  "raydium-amm": 0.4,
  "orca-whirlpool": 0.85,
  "aerodrome-stable": 0.85,
  "aerodrome-volatile": 0.4,
  "balancer-stable": 0.85,
  "balancer-weighted": 0.4,
  "generic": 0.3,
  "orderbook": 0.6,
};
```

**No `-25bp` or `-100bp` entries for any protocol.** The plan's Task A2 must add at minimum `pancakeswap-v3-25bp` and `pancakeswap-v3-100bp` keys (audit C2 + M7). If A2 also expands the Slipstream classifier to the same tiers, it should similarly add `aerodrome-slipstream-25bp/100bp` and `velodrome-slipstream-25bp/100bp`. The plan's review Critical 6 correctly flags the Slipstream expansion risk: without matching multiplier entries, pools in the new bucket fall back to `"generic": 0.3`.

---

### 21. `worker/src/api/dex-liquidity.ts` — `coverageClass` + `topPools` mapping

Line 87:
```ts
    const coverageClass = row.coverage_class ?? "legacy";
```

Line 105:
```ts
      topPools: normalizeTopPools(row.top_pools_json),
```

The `coverageClass` fallthrough **is in `dex-liquidity.ts:87`, not `dex-liquidity-response.ts`**. The `topPools` mapping uses `normalizeTopPools` which IS in `dex-liquidity-response.ts:84`. **The plan's Task C1 had the two file targets swapped** — confirmed by the review's Critical 5.

---

### 22. `worker/src/api/dex-liquidity-response.ts` — `normalizeTopPools`

Lines 84-95:
```ts
export function normalizeTopPools(json: string | null): DexLiquidityPoolResponse[] {
  const parsed = safeJsonParse<DexLiquidityPoolResponse[]>(json, []);
  return parsed.map((pool) => {
    const normalizedSource = normalizePoolSource(pool.source);
    if (normalizedSource != null) {
      return { ...pool, source: normalizedSource };
    }
    console.info("[dex-liquidity] Unknown pool source:", pool.source);
    const { source: _, ...rest } = pool;
    return rest as DexLiquidityPoolResponse;
  });
}
```

`DexLiquidityPoolResponse` (lines 62-64):
```ts
type DexLiquidityPoolResponse = {
  source?: string;
} & Record<string, unknown>;
```

**`normalizeTopPools` only normalizes the `source` field — it is a pass-through for every other field.** If the plan wants to strip dead per-pool fields (`poolId`, `volumeUsd7d`, `extra.qualityAdjustedTvl`, `extra.hasMeasuredOrganicFraction`), this is the place to add the allowlist.

---

### 23. `worker/src/cron/dex-liquidity/fetch-crawlers.ts` — `mergeSecondaryPools`

Already pasted in full above. Key points:
- `mergeSecondaryPools<TPool extends GtNewPool | CgNewPool>(metrics, discoveredPools, options?)` — **this is a `function` scoped to this file, NOT exported**. The audit's "LOW-4 mergeSecondaryPools defensive guard" refers to this inner helper. Task D3 needs to touch the single definition here.
- `mergeCgPools` and `mergeGtPools` are the two exported wrappers that delegate to `mergeSecondaryPools`.
- `mergeSecondaryPools` calls `addSecondaryPoolContribution` (from `pool-contribution.ts`) for each incoming pool — there is no inline dedupe. Any cross-pool fingerprint dedupe has to happen BEFORE this merge (either in the crawler or at the known-pool-index registration step).

---

### 24. `worker/src/cron/dex-liquidity/challenger-persistence.ts` — `selectDexPriceChallengerRowsFromPools`

Lines 240-279:
```ts
export function selectDexPriceChallengerRowsFromPools(
  stablecoinId: string,
  pools: PoolEntry[],
  minPoolTvlUsd: number,
): DexPriceChallengerPoolRow[] {
  const qualifying = pools
    .filter((pool) =>
      !isBlockedDexId(pool.project) &&
      Number.isFinite(pool.price) &&
      (pool.price ?? 0) > 0 &&
      Number.isFinite(pool.tvlUsd) &&
      pool.tvlUsd >= minPoolTvlUsd,
    )
    .sort((a, b) => b.tvlUsd - a.tvlUsd || a.poolId.localeCompare(b.poolId));

  if (qualifying.length === 0) return [];

  const totalQualifyingTvl = qualifying.reduce((sum, pool) => sum + pool.tvlUsd, 0);
  const rows: DexPriceChallengerPoolRow[] = [];
  let retainedTvl = 0;

  for (const pool of qualifying) {
    rows.push({
      stablecoinId,
      poolId: pool.poolId,
      chain: pool.chain,
      protocol: pool.project,
      sourceFamily: pool.source,
      priceUsd: pool.price as number,
      tvlUsd: pool.tvlUsd,
    });
    retainedTvl += pool.tvlUsd;

    const coverageRatio = totalQualifyingTvl > 0 ? retainedTvl / totalQualifyingTvl : 1;
    if (rows.length >= CHALLENGER_HARD_CAP) break;
    if (coverageRatio >= CHALLENGER_COVERAGE_TARGET) break;
  }

  return rows;
}
```

**LOW-1 intra-coin dedup**: the function has no dedup step. If the retained-pool list contains two entries with the same `poolId` (possible during the HIGH-1 period), both would be persisted as separate challenger rows. Task D3 should add a `seen` Set and skip subsequent duplicates.

---

### 25. `shared/types/market.ts` — `DexLiquidityDataSchema` and `DexLiquidityPoolSchema`

Lines 181-290 (full schemas already pasted in the raw read). Key points for Task C3:

- **`DexLiquidityPoolSchema`** (line 181) is the per-pool response schema. It does NOT include `poolId`, `volumeUsd7d`, `qualityAdjustedTvl`, or `hasMeasuredOrganicFraction`. The audit's C1 "strip dead per-pool fields" was already done in the schema; the problem is that `normalizeTopPools` in `dex-liquidity-response.ts` is a pass-through, so those dead fields still flow from the D1 column `top_pools_json` into the API response body. The fix is to add an explicit allowlist in `normalizeTopPools`.
- **`DexLiquidityDataSchema.coverageClass: LiquidityCoverageClassSchema`** (line 269) is currently NON-nullable. The enum is `"primary" | "mixed" | "fallback" | "legacy" | "unobserved"` (line 163). The review's Minor 2 warns that making it `.nullable()` breaks the frontend consumers. **Pharos' `/api/dex-liquidity` currently defaults `coverageClass = row.coverage_class ?? "legacy"` at `dex-liquidity.ts:87`, so the database CAN have NULLs but the API never emits them.** The right fix is either (a) keep the API fallback and add a defensive `?? "unobserved"` on the frontend, or (b) update the DB to backfill `coverage_class` for all rows.
- **`DexLiquidityPoolSchema.source`** (line 188) supports both current and legacy enum values via a union: `z.union([LiquidityPoolSourceFamilySchema, LegacyLiquidityPoolSourceSchema]).optional()`.

---

### 26. `src/lib/liquidity-coverage.ts` — FULL FILE

```ts
import { formatCurrency } from "@shared/lib/format";
import type { LiquidityCoverageClass, LiquiditySourceMix } from "@shared/types";

const COVERAGE_BADGES: Record<LiquidityCoverageClass, { label: string; className: string }> = {
  primary: {
    label: "Primary",
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  mixed: {
    label: "Mixed",
    className: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  fallback: {
    label: "Fallback",
    className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  legacy: {
    label: "Legacy",
    className: "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300",
  },
  unobserved: {
    label: "NR",
    className: "border-border/70 bg-muted text-muted-foreground",
  },
};

const SOURCE_LABELS: Record<string, string> = {
  dl: "DeFiLlama",
  cg_onchain: "CG Onchain",
  gecko_terminal: "GeckoTerminal",
  dexscreener: "DexScreener",
  cg_tickers: "CG Tickers",
};

export function getLiquidityCoverageBadge(coverageClass: LiquidityCoverageClass) {
  return COVERAGE_BADGES[coverageClass];
}

export function formatLiquiditySourceMix(sourceMix: LiquiditySourceMix): string {
  // ...
}
```

**The badge map has no `direct_api` key.** The audit's m3 (missing `direct_api` label in `SOURCE_LABELS`) is confirmed — `direct_api` prints as the raw string in the UI.

---

## Part 2 — Fixtures captured

| Fixture | Saved to | Status | Notes |
| --- | --- | --- | --- |
| Meteora imbalanced pool | `agents/audits/fixtures/2026-04-16-meteora-imbalanced-pool.json` | **ok** | SOL/USDC pool `HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR`: `token_x_amount=6885.094`, `token_y_amount=89650.78`, `current_price=84.93`, **reserve ratio 13.02** (an **84% delta** from spot). `tvl=$673,863`. Captures the M4/C1 bug: `derivedPrice = 13.02` while actual spot is `84.93`. |
| Fluid ticker USDC/USDT | `agents/audits/fixtures/2026-04-16-fluid-ticker-usdcusdt.json` | **ok** | `base_volume="0"` and `target_volume="0"` — raw token-volume fields that the fetcher adds together and stamps as `volume24hUsd`. Even at zero the fixture reveals the field-format mismatch. `liquidity_in_usd="52264916.11"`. |
| Balancer Fantom multiUSDC/DEI | `agents/audits/fixtures/2026-04-16-balancer-fantom-dei.json` | **ok** | Pool `0x4e415957aa4fd703ad701e43ee5335d1d7891d83` STABLE pool. `totalLiquidity="337677697052.70"` (**$337B**). `multiUSDC.balance=0.000001` + `DEI.balance=1e12`. First-token-price logic would derive `price=337e9/1e12=0.337`. Captures M3 + M4 bugs. |
| Noble Swaps | `agents/audits/fixtures/2026-04-16-noble-swaps.md` (degraded — all endpoints unreachable/501/HTML) | **missing** | All four candidate URLs failed: two returned connection errors, one returned a go-import HTML vanity page, one returned 501 Not Implemented. Documented in the md file. **Recommendation: defer G1 to a follow-up plan that starts with an endpoint spike.** |
| Aerodrome Sugar ABI | `agents/audits/fixtures/2026-04-16-aero-sugar-abi.md` (degraded — Basescan v1 deprecated, Etherscan v2 requires API key) | **missing but salvageable** | The struct is ALREADY in the worker's own `parseAbi` string at `fetch-slipstream.ts:11-14`. `sqrt_ratio` is `uint160`, `pool_fee` is `uint256`, `type` is `int24`. The unit of `pool_fee` is NOT determined (the audit M6 open question remains). **Recommendation: defer A6 OR ship only the classifier expansion (A2) + fall back to an eth_call spike for the sqrt_ratio/pool_fee math.** |

---

## Part 3 — Plan claim verification

### 1. Does `buildPoolFingerprint` exist in `pool-helpers.ts`?

**yes** — `worker/src/cron/dex-liquidity/pool-helpers.ts:196`, signature:
```ts
export function buildPoolFingerprint(chain: string, protocol: string, tokenAddresses: string[]): string | null
```
Implementation sorts the addresses, lowercases chain + tokens, normalizes protocol via `normalizeProtocol`, and returns `fp:${chain}:${protocol}:${sorted.join(":")}` or `null` if fewer than 2 non-empty addresses. Already used by `crawl-helpers.ts:158`.

### 2. Is `isTrustworthyExactPoolId` currently `export`ed from `pool-identity.ts`?

**no** — `pool-identity.ts:41` declares it as a local `function`, not `export function`. If the plan needs to call it from a new file, it must either add `export` OR duplicate the predicate inline. The predicate accepts `orderbook-`, `orderbook:`, EVM 40-hex, Uniswap V4 64-hex, and base58 32-64 char ids.

### 3. Is there a `fixtures/` directory under `worker/src/cron/dex-liquidity/__tests__/`?

**no** — `ls` returns only `.test.ts` files. No existing test imports from `fixtures/`. The plan must either create the directory as part of its own setup step or inline fixtures as consts in the test file (the existing idiom).

### 4. Is `@shared/*` importable from `worker/src/cron/dex-liquidity/*`?

**yes** — `worker/tsconfig.json:14-18`:
```json
"paths": {
  "@shared/*": ["../shared/*"]
}
```
And `"include": ["src/**/*.ts", "src/**/*.tsx", "../shared/**/*.ts"]`. `pool-contribution.ts:1` already does `import { CHAIN_META } from "@shared/lib/chains";`. Any worker code can safely import `@shared/*`.

### 5. Can the worker test suite be run via `cd worker && npx vitest --run <pattern>`?

**confirmed via existing test commands**. The worker has its own `package.json` with vitest as a direct dependency. The repo's CLAUDE.md states "`cd worker && npx tsc --noEmit`" for type check; the test command follows the same pattern (`cd worker && npx vitest --run` or `cd worker && npm test`). The existing worker tests under `worker/src/cron/dex-liquidity/__tests__/` are run via this path.

### 6. Does `recordOutcomeSafe` exist in `worker/src/lib/circuit-breaker.ts`?

**yes** — `circuit-breaker.ts:168`:
```ts
export async function recordOutcomeSafe(
  db: D1Database,
  source: string,
  success: boolean,
  webhookUrl?: string | null,
): Promise<void>
```

### 7. Does `CIRCUIT_SOURCE` have entries for all 8 direct-API protocols?

**yes** for all 8 plan-relevant protocols:
- `FLUID_DEX_API: "fluid-dex-api"` ✓
- `BALANCER_API: "balancer-api"` ✓
- `RAYDIUM_API: "raydium-api"` ✓
- `ORCA_API: "orca-api"` ✓
- `METEORA_API: "meteora-api"` ✓
- `PANCAKESWAP_API: "pancakeswap-api"` ✓
- `AERODROME_SLIPSTREAM_API: "aerodrome-slipstream-api"` ✓
- `VELODROME_SLIPSTREAM_API: "velodrome-slipstream-api"` ✓

All 44 entries are listed in section 20 above. **There is NO entry for CEX orderbook depth, Noble, or any of the plan's proposed new fetchers.** New entries need to be added for A7's CEX circuit and G1's Noble circuit.

### 8. Does `scoring.ts` call `accumulateGlobalAggregate` inside a loop over stablecoins or over a batch of pools?

**inside a loop over stablecoins** — `scoring.ts:138: for (const [id, m] of metrics) { ... scoring.ts:153: const globalDelta = accumulateGlobalAggregate(retainedPools, ...); }`. The function is called once per stablecoin with that stablecoin's `retainedPools`. The `globalSeenPools` Set is shared across calls, which gives the function its "first-wins" semantics.

### 9. What is `SecondaryPool`?

`pool-contribution.ts:11`:
```ts
type SecondaryPool = GtNewPool | CgNewPool;
```
Both `GtNewPool` (types.ts:259-298) and `CgNewPool` (types.ts:300-307) contain `address`, `chain`, `dexId`, `name`, `tvlUsd`, `volume24hUsd`, `qualityMultiplier`, `maturityDays`, `price`, `symbol`, `poolType`, `sourceFamily`, `volume7dUsd?`, `balanceRatio?`, `feeTierBps?`, `balanceDetails?`, `pairQualityOverride?`, `measurement?`, `orderbookDepthUsd?`, `orderbookDepthUpUsd?`, `orderbookTvlBasis?`. `CgNewPool` adds `lockedLiquidityPct: number | null` and `feePercentage: number | null`. **Neither has `baseToken`, `quoteToken`, or token-address arrays.**

### 10. What does `pool.address` hold per branch?

- **Direct API path (via `convertToGtNewPools` in `dex-api-common.ts`)**: the on-chain `pool.poolAddress` from the direct fetcher. For EVM protocols this is a 40-hex address; for Solana it's a base58 id; for Balancer it's the 40-hex extracted via `extractBalancerPoolAddress`.
- **GT crawl path (`fetch-crawlers.ts:108`)**: `parsed.poolAddress` which comes from `parseGtPool` (geckoterminal-shared.ts). Already lowercased at parse time.
- **CG onchain path (`fetch-crawlers.ts:108` same builder)**: `parsed.poolAddress` from `parseCgPool` (`coingecko-onchain-shared.ts:38`: `attrs.address?.toLowerCase()`). Already lowercased.
- **DexScreener fallback (`fetch-fallbacks.ts:204`)**: `pair.pairAddress.toLowerCase()`.
- **CG tickers fallback (`fetch-fallbacks.ts:320`)**: **synthetic** `\`orderbook-${summary.exchangeId}\`` — NOT an on-chain address. This is the HIGH-3 root cause: the `address` loses the stablecoin discriminator.
- **Staged merge (`staging-merge.ts:330`)**: `stagedPool.poolId.split(":")[1] ?? stagedPool.poolId`. For a staged `orderbook:kinesis:kau` id, this returns `"kinesis"` — LOSING the `kau` discriminator. See HIGH-3 notes.

### 11. Does `worker/src/api/dex-liquidity.ts:87` contain the `coverageClass` fallthrough?

**yes** — `dex-liquidity.ts:87: const coverageClass = row.coverage_class ?? "legacy";`. The review's Critical 5 is confirmed.

### 12. Does `normalizeTopPools` exist in `dex-liquidity-response.ts`?

**yes** — `dex-liquidity-response.ts:84-95`. It is a pure pass-through except for normalizing the `source` field. It is called from `dex-liquidity.ts:105`: `topPools: normalizeTopPools(row.top_pools_json)`. Confirmed — the plan's file targets in C1 are swapped.

---

## Part 4 — Knip dead-code report

`cd worker && npx knip` fails with `Create knip.json configuration file, and add entry and/or refine project files (305 unused files)` because **there is no `knip.json` in the repo at all** (`worker/knip.*` and `stablecoin-dashboard/knip.*` do not exist, and no `knip` block is declared in either `package.json`). Knip defaults to treating every test file as an unused file, which is not actionable.

An ad-hoc run with `{"entry":["src/index.ts","src/**/*.test.ts"],"project":["src/**/*.ts"]}` was attempted:

```
Unused files (3)
  src/__mocks__/resvg-stub.ts
  src/__mocks__/satori-stub.ts
  src/__mocks__/wasm-module-stub.ts

Unused dependencies (2)
  @cf-wasm/resvg    package.json:20:6
  satori            package.json:21:6

Unused devDependencies (1)
  wrangler          package.json:17:6

Unlisted dependencies (308)
  vitest   src/__tests__/index.fetch.test.ts:1:54
  … (vitest is listed as a root devDep but knip doesn't see it due to the
     ad-hoc config; these are all false positives)
  zod      src/api/feedback/types.ts:1:19
  … (zod is not listed in worker/package.json because it flows through the
     shared/ path alias — another false-positive class)
```

Full output (319 lines, mostly vitest/zod false positives) is at `/tmp/knip-output-2.txt` for reference.

**What is actually actionable**:

1. **`@cf-wasm/resvg`** and **`satori`** are flagged as unused dependencies in `worker/package.json`. The three `src/__mocks__/*-stub.ts` files are flagged unused — they are referenced only by vitest aliases that the ad-hoc knip config doesn't see. These are likely OG-image dependencies that the worker stopped using when OG generation moved to Pages Functions; **verify and remove if truly unused** (Task F3 candidate).
2. **`wrangler`** is flagged as an unused devDependency — this is a false positive because `wrangler` is invoked via `cd worker && npx wrangler dev` per CLAUDE.md. **Keep.**
3. The "Unlisted dependencies" list is dominated by `vitest` and `zod` false positives. These would be fixed by a proper `knip.json` with `entry: ["src/index.ts", "src/**/*.test.ts"]` and an `ignoreDependencies: ["vitest", "zod"]` declaration, OR by running knip from the repo root once a top-level `knip.json` exists.

**Recommendation for F3**: Task F3 should (a) create `worker/knip.json` with a correct entry/project set as a one-line prep step, (b) re-run knip, (c) enumerate the true dead files. The current F3 scoping based on the audit's point-in-time snapshot is unreliable without a working knip config.

---

## Appendix — Review-confirmed issues still unresolved

- **Critical 6 (A2 Slipstream 25bp gap)**: confirmed by section 20. No `aerodrome-slipstream-25bp` key in `QUALITY_MULTIPLIERS`. Plan must add it OR scope A2 to pancake-only.
- **Critical 8 (A6 math + tooling)**: confirmed by section 5 + `agents/audits/fixtures/2026-04-16-aero-sugar-abi.md`. The struct is in the repo, but the sqrt_ratio BigInt math is non-trivial and `pool_fee` unit remains unverified.
- **Major 3 (D1 fragile regex)**: the `derivedMatchKey` format is `chain|proto|tokens|shape|feeBucket|stability` (pool-identity.ts:124-134). A regex that replaces the first `|([0-9]+|wide)|` would indeed hit `chain` if the chain key were numeric. Safer to `split("|")`, mutate `parts[4]`, rejoin.
- **Major 7 (fixtures)**: confirmed. No fixtures directory. The plan must inline fixtures OR create the directory as part of a setup step.
- **Minor 3 (`isTrustworthyExactPoolIdForStamping`)**: confirmed — only `isTrustworthyExactPoolId` exists, and it is unexported.
- **Plan Task A7 caller audit**: confirmed that `fetchGtTokenBatch` and `fetchCgTokenBatchPrices` have **no production callers** — they appear in test code only. Task A7 may be moot; Task F3 should just delete them.
