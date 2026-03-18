# Multi-DEX API Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate Fluid, Balancer, Raydium, and Orca direct APIs into the DEX liquidity scoring pipeline and pricing consensus engine.

**Architecture:** Four new fetcher modules run in the half-hourly DEX liquidity cron, producing normalized `DexApiPool[]` that feed into existing pool scoring and price observation pipelines. Prices bridge to the quarter-hourly pricing cron via `dex_prices.price_sources_json` in D1, where they are disaggregated into individually-weighted consensus sources.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, Vitest, REST/GraphQL APIs.

**Spec:** `docs/superpowers/specs/2026-03-18-multi-dex-api-integration-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `worker/src/lib/dex-api-common.ts` | `DexApiPool` type, `convertToGtNewPools()`, `extractPriceObservations()` |
| `worker/src/cron/dex-liquidity/fetch-fluid.ts` | Fluid REST fetcher (7 chains) |
| `worker/src/cron/dex-liquidity/fetch-balancer.ts` | Balancer GraphQL fetcher (multi-chain) |
| `worker/src/cron/dex-liquidity/fetch-raydium.ts` | Raydium REST fetcher (Solana) |
| `worker/src/cron/dex-liquidity/fetch-orca.ts` | Orca REST fetcher (Solana) |
| `worker/src/cron/__tests__/dex-api-common.test.ts` | Tests for shared type conversion + price extraction |
| `worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts` | Tests for all 4 fetchers (mocked HTTP) |
| `worker/src/cron/__tests__/dex-liquidity-price-bridge.test.ts` | Tests for `loadDexPriceSources()` + weight injection |

### Modified Files

| File | Change |
|------|--------|
| `shared/types/market.ts` | Add `"direct_api"` to `LiquidityPoolSourceFamilySchema` |
| `worker/src/lib/constants.ts` | Add 4 `CIRCUIT_SOURCE` entries |
| `worker/src/lib/dex-constants.ts` | Add 3 quality multipliers |
| `worker/src/cron/dex-liquidity/constants.ts` | Add 4 protocols to Tier 1 in `dexPriceConfidenceForProtocol()` |
| `worker/src/cron/dex-liquidity/pool-helpers.ts` | Add raydium/orca to `classifyPoolType()` |
| `worker/src/lib/depeg-helpers.ts` | Add `loadDexPriceSources()` |
| `worker/src/cron/dex-liquidity/orchestrator.ts` | Call 4 fetchers, convert results, merge |
| `worker/src/cron/enrich-prices.ts` | Disaggregate per-protocol prices with elevated weights |

---

## Task 1: Shared Types and Constants

**Files:**
- Create: `worker/src/lib/dex-api-common.ts`
- Modify: `shared/types/market.ts:117-123`
- Modify: `worker/src/lib/constants.ts:124-149`
- Modify: `worker/src/lib/dex-constants.ts:14-28`
- Modify: `worker/src/cron/dex-liquidity/constants.ts:121-135`
- Modify: `worker/src/cron/dex-liquidity/pool-helpers.ts:25-34`
- Test: `worker/src/cron/__tests__/dex-liquidity-pool-helpers.test.ts`

- [ ] **Step 1: Add `"direct_api"` to `LiquidityPoolSourceFamilySchema`**

In `shared/types/market.ts`, add `"direct_api"` to the Zod enum at line 117:

```typescript
export const LiquidityPoolSourceFamilySchema = z.enum([
  "dl",
  "cg_onchain",
  "gecko_terminal",
  "dexscreener",
  "cg_tickers",
  "direct_api",
]);
```

- [ ] **Step 2: Add circuit breaker source entries**

In `worker/src/lib/constants.ts`, add before the closing `} as const;` at line 149:

```typescript
  FLUID_DEX_API: "fluid-dex-api",
  BALANCER_API: "balancer-api",
  RAYDIUM_API: "raydium-api",
  ORCA_API: "orca-api",
```

- [ ] **Step 3: Add quality multipliers**

In `worker/src/lib/dex-constants.ts`, add to the `QUALITY_MULTIPLIERS` object (after `"fluid-dex": 0.85` at line 21):

```typescript
  "raydium-clmm": 0.85,
  "raydium-amm": 0.4,
  "orca-whirlpool": 0.85,
```

- [ ] **Step 4: Add protocols to Tier 1 price confidence**

In `worker/src/cron/dex-liquidity/constants.ts`, update `dexPriceConfidenceForProtocol()` at line 122:

```typescript
export function dexPriceConfidenceForProtocol(protocol: string): number {
  if (
    protocol === "curve" || protocol === "uniswap-v3" || protocol === "aerodrome" ||
    protocol === "fluid" || protocol === "balancer" || protocol === "raydium" || protocol === "orca"
  ) return 1.0;
```

- [ ] **Step 5: Add raydium/orca to `classifyPoolType()`**

In `worker/src/cron/dex-liquidity/pool-helpers.ts`, add cases before the `return "generic"` line. Insert after the `if (proj.includes("balancer"))` block (around line 31):

```typescript
  if (proj.includes("raydium")) return "raydium-amm";
  if (proj.includes("orca")) return "orca-whirlpool";
```

Note: DL-sourced Raydium pools all get `"raydium-amm"` (0.4x) because DL lacks pool-type granularity. Direct API pools set the correct `"raydium-clmm"` (0.85x) themselves. The direct API pool takes precedence during dedup.

- [ ] **Step 6: Create `dex-api-common.ts`**

Create `worker/src/lib/dex-api-common.ts`:

```typescript
import type { DexPriceObs, GtNewPool } from "../cron/dex-liquidity/types";
import type { PriceValidationReferences } from "../cron/dex-liquidity/price-sanity";
import { isPlausibleDexObservationPrice } from "../cron/dex-liquidity/price-sanity";
import { QUALITY_MULTIPLIERS, normalizeDexSymbol, isUsdReferenceSymbol } from "./dex-constants";

export interface DexApiPoolToken {
  address: string;
  symbol: string;
  decimals: number;
  /** Per-token USD price when available (Balancer provides this via balanceUSD/balance). */
  priceUsd?: number | null;
}

export interface DexApiPool {
  source: "fluid" | "balancer" | "raydium" | "orca";
  chain: string;
  poolAddress: string;
  poolType: string;
  tokens: DexApiPoolToken[];
  /** Raw pool price ratio (token[0] / token[1]). Used for price inversion logic. */
  price: number | null;
  tvlUsd: number;
  volume24hUsd: number;
  feeRate: number | null;
  balances: number[] | null;
}

/** Min TVL for a pool's price to be considered as a price observation */
export const DIRECT_API_PRICE_MIN_TVL_USD = 50_000;

/** Min TVL for a pool to be included in liquidity scoring */
export const DIRECT_API_POOL_MIN_TVL_USD = 10_000;

/** Resolve a token to a stablecoin ID via address match or symbol fallback. */
function resolveStablecoinId(
  token: DexApiPoolToken,
  addressToId: Map<string, string>,
  symbolToIds: Map<string, string[]>,
): string | undefined {
  const addr = token.address.toLowerCase();
  const byAddr = addressToId.get(addr);
  if (byAddr) return byAddr;
  // Symbol fallback (empty symbols from Fluid skip this path)
  const sym = normalizeDexSymbol(token.symbol);
  if (sym) return symbolToIds.get(sym)?.[0];
  return undefined;
}

/**
 * Derive USD price for a specific token in a 2-token pool.
 *
 * Strategy per source:
 * - Balancer: uses per-token `priceUsd` (derived from balanceUSD / balance by the fetcher)
 * - Fluid/Raydium/Orca: `pool.price` is token[0]/token[1] ratio.
 *   If stablecoin is token[0] and token[1] is a USD reference: price = pool.price
 *   If stablecoin is token[1] and token[0] is a USD reference: price = 1 / pool.price
 */
function deriveTokenUsdPrice(
  pool: DexApiPool,
  tokenIndex: number,
  addressToId: Map<string, string>,
): number | null {
  const token = pool.tokens[tokenIndex];

  // 1. Prefer per-token priceUsd if set (Balancer)
  if (token.priceUsd != null && Number.isFinite(token.priceUsd) && token.priceUsd > 0) {
    return token.priceUsd;
  }

  // 2. Derive from pool.price ratio for 2-token pools
  if (pool.price == null || !Number.isFinite(pool.price) || pool.price <= 0) return null;
  if (pool.tokens.length !== 2) return null;

  const otherIdx = tokenIndex === 0 ? 1 : 0;
  const otherToken = pool.tokens[otherIdx];
  const otherSym = normalizeDexSymbol(otherToken.symbol);
  const otherAddr = otherToken.address.toLowerCase();

  // Check if the other side is a USD reference (by symbol or by being a tracked stablecoin)
  const otherIsUsdRef = isUsdReferenceSymbol(otherSym) || addressToId.has(otherAddr);
  if (!otherIsUsdRef) return null;

  // pool.price = token[0] priced in token[1]
  if (tokenIndex === 0) return pool.price;       // token[0] price in USD terms
  return 1 / pool.price;                          // token[1] price = inverse
}

/**
 * Convert DexApiPool[] to GtNewPool[] keyed by stablecoinId.
 * Matches pool tokens against the stablecoin contract registry + symbol fallback.
 */
export function convertToGtNewPools(
  pools: DexApiPool[],
  addressToId: Map<string, string>,
  symbolToIds: Map<string, string[]>,
): Map<string, GtNewPool[]> {
  const result = new Map<string, GtNewPool[]>();

  for (const pool of pools) {
    if (pool.tvlUsd < DIRECT_API_POOL_MIN_TVL_USD) continue;

    for (let i = 0; i < pool.tokens.length; i++) {
      const token = pool.tokens[i];
      const stablecoinId = resolveStablecoinId(token, addressToId, symbolToIds);
      if (!stablecoinId) continue;

      const qualityMultiplier = QUALITY_MULTIPLIERS[pool.poolType] ?? QUALITY_MULTIPLIERS.generic!;
      const pairSymbols = pool.tokens.map((t) => normalizeDexSymbol(t.symbol) || t.address.slice(0, 10));
      const symbolStr = pairSymbols.join(" / ");

      // Derive price for this specific stablecoin token
      const tokenPrice = deriveTokenUsdPrice(pool, i, addressToId);

      const gtPool: GtNewPool = {
        address: pool.poolAddress,
        chain: pool.chain,
        dexId: pool.source,
        name: `${pool.source}:${symbolStr}`,
        tvlUsd: pool.tvlUsd,
        volume24hUsd: pool.volume24hUsd,
        qualityMultiplier,
        maturityDays: 90, // conservative default for established DEXes
        price: tokenPrice ?? 0,
        symbol: symbolStr,
        poolType: pool.poolType,
        sourceFamily: "direct_api",
      };

      const existing = result.get(stablecoinId) ?? [];
      existing.push(gtPool);
      result.set(stablecoinId, existing);
    }
  }

  return result;
}

/**
 * Extract price observations from DexApiPool[] for computeDexPrices().
 * Applies per-token price inversion and plausibility filtering.
 * Only pools with TVL >= $50K and a valid derived price contribute.
 */
export function extractPriceObservations(
  pools: DexApiPool[],
  addressToId: Map<string, string>,
  symbolToIds: Map<string, string[]>,
  validationReferences?: PriceValidationReferences,
): Map<string, DexPriceObs[]> {
  const result = new Map<string, DexPriceObs[]>();

  for (const pool of pools) {
    if (pool.tvlUsd < DIRECT_API_PRICE_MIN_TVL_USD) continue;

    for (let i = 0; i < pool.tokens.length; i++) {
      const token = pool.tokens[i];
      const stablecoinId = resolveStablecoinId(token, addressToId, symbolToIds);
      if (!stablecoinId) continue;

      const price = deriveTokenUsdPrice(pool, i, addressToId);
      if (price == null || price <= 0) continue;

      // Plausibility filter — matches existing code paths in fetch-primary.ts
      if (validationReferences && !isPlausibleDexObservationPrice(stablecoinId, price, validationReferences)) {
        continue;
      }

      const obs: DexPriceObs = {
        price,
        tvl: pool.tvlUsd,
        chain: pool.chain,
        protocol: pool.source,
      };

      const existing = result.get(stablecoinId) ?? [];
      existing.push(obs);
      result.set(stablecoinId, existing);
    }
  }

  return result;
}
```

> **Note:** Fluid pools have empty symbols (API only provides addresses), so symbol-based matching and USD reference detection rely solely on address lookups. This means Fluid pools only match stablecoins with known contract addresses in our registry.

- [ ] **Step 7: Update pool-helpers test with new classifications**

Add to `worker/src/cron/__tests__/dex-liquidity-pool-helpers.test.ts` inside the `classifies pool types` test block:

```typescript
    expect(classifyPoolType("raydium")).toBe("raydium-amm");
    expect(classifyPoolType("Raydium CLMM")).toBe("raydium-amm");
    expect(classifyPoolType("orca-whirlpool")).toBe("orca-whirlpool");

    expect(getQualityMultiplier("raydium-clmm")).toBe(QUALITY_MULTIPLIERS["raydium-clmm"]);
    expect(getQualityMultiplier("raydium-amm")).toBe(QUALITY_MULTIPLIERS["raydium-amm"]);
    expect(getQualityMultiplier("orca-whirlpool")).toBe(QUALITY_MULTIPLIERS["orca-whirlpool"]);
```

- [ ] **Step 8: Run tests**

Run: `cd worker && npx vitest run src/cron/__tests__/dex-liquidity-pool-helpers.test.ts`
Expected: All tests pass.

- [ ] **Step 9: Run full type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No type errors. This verifies the `LiquidityPoolSourceFamily` change doesn't break consumers.

- [ ] **Step 10: Commit**

```bash
git add shared/types/market.ts worker/src/lib/constants.ts worker/src/lib/dex-constants.ts \
  worker/src/lib/dex-api-common.ts worker/src/cron/dex-liquidity/constants.ts \
  worker/src/cron/dex-liquidity/pool-helpers.ts worker/src/cron/__tests__/dex-liquidity-pool-helpers.test.ts
git commit -m "feat(dex): add shared types, constants, and quality multipliers for direct API integration"
```

---

## Task 2: Shared Conversion Tests

**Files:**
- Create: `worker/src/cron/__tests__/dex-api-common.test.ts`
- Ref: `worker/src/lib/dex-api-common.ts`

- [ ] **Step 1: Write tests for `convertToGtNewPools` and `extractPriceObservations`**

Create `worker/src/cron/__tests__/dex-api-common.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  convertToGtNewPools,
  extractPriceObservations,
  type DexApiPool,
} from "../../lib/dex-api-common";

const MOCK_POOL: DexApiPool = {
  source: "fluid",
  chain: "ethereum",
  poolAddress: "0xpool1",
  poolType: "fluid-dex",
  tokens: [
    { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 },
    { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", decimals: 6 },
  ],
  price: 0.9998,
  tvlUsd: 500_000,
  volume24hUsd: 100_000,
  feeRate: 0.0001,
  balances: [250_000, 250_000],
};

describe("convertToGtNewPools", () => {
  it("matches pool token address to stablecoin ID", () => {
    const addressToId = new Map([["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"]]);
    const symbolToIds = new Map<string, string[]>();
    const result = convertToGtNewPools([MOCK_POOL], addressToId, symbolToIds);
    expect(result.get("usdc")).toHaveLength(1);
    expect(result.get("usdc")![0].sourceFamily).toBe("direct_api");
    expect(result.get("usdc")![0].poolType).toBe("fluid-dex");
  });

  it("falls back to symbol matching when address unknown", () => {
    const addressToId = new Map<string, string>();
    const symbolToIds = new Map([["USDC", ["usdc"]]]);
    const result = convertToGtNewPools([MOCK_POOL], addressToId, symbolToIds);
    expect(result.get("usdc")).toHaveLength(1);
  });

  it("skips pools below TVL threshold", () => {
    const pool = { ...MOCK_POOL, tvlUsd: 5_000 };
    const addressToId = new Map([["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"]]);
    const result = convertToGtNewPools([pool], addressToId, new Map());
    expect(result.size).toBe(0);
  });

  it("skips tokens not matching any stablecoin", () => {
    const result = convertToGtNewPools([MOCK_POOL], new Map(), new Map());
    expect(result.size).toBe(0);
  });
});

describe("extractPriceObservations", () => {
  it("extracts observations for matched tokens above TVL threshold", () => {
    // USDC is token[0], USDT (token[1]) is a USD reference via address lookup
    const addressToId = new Map([
      ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"],
      ["0xdac17f958d2ee523a2206206994597c13d831ec7", "usdt"],
    ]);
    const result = extractPriceObservations([MOCK_POOL], addressToId, new Map());
    expect(result.get("usdc")).toHaveLength(1);
    expect(result.get("usdc")![0].price).toBeCloseTo(0.9998);
    expect(result.get("usdc")![0].protocol).toBe("fluid");
  });

  it("inverts price when stablecoin is token[1]", () => {
    const addressToId = new Map([
      ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"],
      ["0xdac17f958d2ee523a2206206994597c13d831ec7", "usdt"],
    ]);
    const result = extractPriceObservations([MOCK_POOL], addressToId, new Map());
    // USDT is token[1], so its price = 1 / pool.price
    const usdtObs = result.get("usdt");
    expect(usdtObs).toHaveLength(1);
    expect(usdtObs![0].price).toBeCloseTo(1 / 0.9998);
  });

  it("uses per-token priceUsd when available (Balancer)", () => {
    const balancerPool: DexApiPool = {
      ...MOCK_POOL,
      source: "balancer",
      tokens: [
        { address: "0xgho", symbol: "GHO", decimals: 18, priceUsd: 0.9995 },
        { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6, priceUsd: 1.0001 },
      ],
    };
    const addressToId = new Map([["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"]]);
    const result = extractPriceObservations([balancerPool], addressToId, new Map());
    expect(result.get("usdc")![0].price).toBeCloseTo(1.0001);
  });

  it("skips pools with null price and no per-token priceUsd", () => {
    const pool = { ...MOCK_POOL, price: null };
    const addressToId = new Map([["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"]]);
    const result = extractPriceObservations([pool], addressToId, new Map());
    expect(result.size).toBe(0);
  });

  it("skips pools below $50K TVL", () => {
    const pool = { ...MOCK_POOL, tvlUsd: 40_000 };
    const addressToId = new Map([["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"]]);
    const result = extractPriceObservations([pool], addressToId, new Map());
    expect(result.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd worker && npx vitest run src/cron/__tests__/dex-api-common.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/__tests__/dex-api-common.test.ts
git commit -m "test(dex): add unit tests for DexApiPool conversion and price observation extraction"
```

---

## Task 3: Fluid Fetcher

**Files:**
- Create: `worker/src/cron/dex-liquidity/fetch-fluid.ts`
- Test: `worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts`

- [ ] **Step 1: Write test for `fetchFluidPools`**

Create `worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts` with Fluid section:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DexApiPool } from "../../lib/dex-api-common";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("fetchFluidPools", () => {
  afterEach(() => { mockFetch.mockReset(); vi.resetModules(); });

  it("fetches all chains and normalizes to DexApiPool[]", async () => {
    const { fetchFluidPools } = await import("../dex-liquidity/fetch-fluid");
    mockFetch.mockResolvedValue(new Response(JSON.stringify([
      {
        ticker_id: "0xbase_0xquote",
        base_currency: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        target_currency: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        last_price: "0.9999",
        base_volume: "100000",
        target_volume: "100000",
        pool_id: "0xPoolAddr",
        liquidity_in_usd: "500000",
      },
    ])));

    const pools = await fetchFluidPools();
    expect(pools.length).toBeGreaterThan(0);
    const pool = pools[0];
    expect(pool.source).toBe("fluid");
    expect(pool.poolType).toBe("fluid-dex");
    expect(pool.tvlUsd).toBe(500000);
    expect(pool.price).toBeCloseTo(0.9999);
    expect(pool.tokens).toHaveLength(2);
  });

  it("handles chain failure gracefully with Promise.allSettled", async () => {
    const { fetchFluidPools } = await import("../dex-liquidity/fetch-fluid");
    mockFetch
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValue(new Response(JSON.stringify([])));

    const pools = await fetchFluidPools();
    // Should not throw — partial failure is OK
    expect(Array.isArray(pools)).toBe(true);
  });

  it("returns empty array on complete failure", async () => {
    const { fetchFluidPools } = await import("../dex-liquidity/fetch-fluid");
    mockFetch.mockRejectedValue(new Error("all chains down"));
    const pools = await fetchFluidPools();
    expect(pools).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd worker && npx vitest run src/cron/__tests__/dex-liquidity-direct-api.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `fetch-fluid.ts`**

Create `worker/src/cron/dex-liquidity/fetch-fluid.ts`:

```typescript
import type { DexApiPool } from "../../lib/dex-api-common";
import { USER_AGENT } from "../../lib/constants";

const FLUID_API_BASE = "https://api.fluid.instadapp.io/v2";

/** Fluid API chain IDs mapped to our internal chain keys */
const FLUID_CHAINS: Record<string, number> = {
  ethereum: 1,
  arbitrum: 42161,
  base: 8453,
  polygon: 137,
  bsc: 56,
};

interface FluidTicker {
  ticker_id: string;
  base_currency: string;
  target_currency: string;
  last_price: string;
  base_volume: string;
  target_volume: string;
  pool_id: string;
  liquidity_in_usd: string;
}

export async function fetchFluidPools(signal?: AbortSignal): Promise<DexApiPool[]> {
  const results: DexApiPool[] = [];

  const fetches = Object.entries(FLUID_CHAINS).map(async ([chain, chainId]) => {
    const url = `${FLUID_API_BASE}/${chainId}/dexes/stats/tickers`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal,
    });
    if (!res.ok) {
      console.warn(`[fetch-fluid] ${chain} returned ${res.status}`);
      return [];
    }
    const tickers: FluidTicker[] = await res.json();
    if (!Array.isArray(tickers)) return [];

    return tickers.map((t): DexApiPool | null => {
      const tvlUsd = parseFloat(t.liquidity_in_usd);
      const price = parseFloat(t.last_price);
      const baseVol = parseFloat(t.base_volume);
      const targetVol = parseFloat(t.target_volume);
      if (!Number.isFinite(tvlUsd) || tvlUsd <= 0) return null;

      // Volume in token terms — approximate USD as sum (stablecoin pairs are ~$1 each side)
      const volume24hUsd = (Number.isFinite(baseVol) ? baseVol : 0) + (Number.isFinite(targetVol) ? targetVol : 0);

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
        volume24hUsd,
        feeRate: null,
        balances: null,
      };
    }).filter((p): p is DexApiPool => p !== null);
  });

  const settled = await Promise.allSettled(fetches);
  for (const result of settled) {
    if (result.status === "fulfilled") {
      results.push(...result.value);
    } else {
      console.warn(`[fetch-fluid] Chain fetch failed:`, result.reason);
    }
  }

  if (results.length > 0) {
    console.log(`[fetch-fluid] Fetched ${results.length} pools across ${Object.keys(FLUID_CHAINS).length} chains`);
  }
  return results;
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd worker && npx vitest run src/cron/__tests__/dex-liquidity-direct-api.test.ts`
Expected: All Fluid tests pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/dex-liquidity/fetch-fluid.ts worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts
git commit -m "feat(dex): add Fluid DEX API fetcher"
```

---

## Task 4: Balancer Fetcher

**Files:**
- Create: `worker/src/cron/dex-liquidity/fetch-balancer.ts`
- Modify: `worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts`

- [ ] **Step 1: Write test for `fetchBalancerPools`**

Append to `worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts`:

```typescript
describe("fetchBalancerPools", () => {
  afterEach(() => { mockFetch.mockReset(); vi.resetModules(); });

  it("fetches stable pools and classifies pool type", async () => {
    const { fetchBalancerPools } = await import("../dex-liquidity/fetch-balancer");
    mockFetch.mockResolvedValue(new Response(JSON.stringify({
      data: { poolGetPools: [{
        id: "0xpool",
        type: "STABLE",
        chain: "MAINNET",
        dynamicData: { totalLiquidity: "1000000", volume24h: "50000", swapFee: "0.0001" },
        poolTokens: [
          { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6, balance: "500000", balanceUSD: "500000" },
          { address: "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f", symbol: "GHO", decimals: 18, balance: "500000", balanceUSD: "500000" },
        ],
      }]},
    })));

    const pools = await fetchBalancerPools();
    expect(pools.length).toBe(1);
    expect(pools[0].source).toBe("balancer");
    expect(pools[0].poolType).toBe("balancer-stable");
    expect(pools[0].tvlUsd).toBe(1000000);
    expect(pools[0].feeRate).toBeCloseTo(0.0001);
    expect(pools[0].balances).toEqual([500000, 500000]);
  });

  it("classifies WEIGHTED pools correctly", async () => {
    const { fetchBalancerPools } = await import("../dex-liquidity/fetch-balancer");
    mockFetch.mockResolvedValue(new Response(JSON.stringify({
      data: { poolGetPools: [{
        id: "0xweighted",
        type: "WEIGHTED",
        chain: "ARBITRUM",
        dynamicData: { totalLiquidity: "200000", volume24h: "10000", swapFee: "0.003" },
        poolTokens: [
          { address: "0xtoken1", symbol: "USDC", decimals: 6, balance: "100000", balanceUSD: "100000" },
          { address: "0xtoken2", symbol: "WETH", decimals: 18, balance: "50", balanceUSD: "100000" },
        ],
      }]},
    })));

    const pools = await fetchBalancerPools();
    expect(pools[0].poolType).toBe("balancer-weighted");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd worker && npx vitest run src/cron/__tests__/dex-liquidity-direct-api.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `fetch-balancer.ts`**

Create `worker/src/cron/dex-liquidity/fetch-balancer.ts`:

```typescript
import type { DexApiPool } from "../../lib/dex-api-common";
import { USER_AGENT } from "../../lib/constants";

const BALANCER_API = "https://api-v3.balancer.fi/";

/** Balancer chain enum values mapped to our internal chain keys */
const BALANCER_CHAIN_MAP: Record<string, string> = {
  MAINNET: "ethereum",
  ARBITRUM: "arbitrum",
  BASE: "base",
  POLYGON: "polygon",
  OPTIMISM: "optimism",
  GNOSIS: "gnosis",
  AVALANCHE: "avalanche",
  SONIC: "sonic",
  FANTOM: "fantom",
  FRAXTAL: "fraxtal",
  MODE: "mode",
  ZKEVM: "zkevm",
};

const STABLE_POOL_TYPES = new Set([
  "STABLE", "COMPOSABLE_STABLE", "META_STABLE", "PHANTOM_STABLE", "GYRO", "GYROE",
]);

const QUERY = `query($first: Int!, $skip: Int!) {
  poolGetPools(
    first: $first,
    skip: $skip,
    orderBy: totalLiquidity,
    orderDirection: desc,
    where: { minTvl: 10000 }
  ) {
    id
    type
    chain
    dynamicData { totalLiquidity volume24h swapFee }
    poolTokens { address symbol decimals balance balanceUSD }
  }
}`;

interface BalancerPool {
  id: string;
  type: string;
  chain: string;
  dynamicData: { totalLiquidity: string; volume24h: string; swapFee: string };
  poolTokens: { address: string; symbol: string; decimals: number; balance: string; balanceUSD: string }[];
}

export async function fetchBalancerPools(signal?: AbortSignal): Promise<DexApiPool[]> {
  const results: DexApiPool[] = [];
  let skip = 0;
  const pageSize = 1000;

  while (true) {
    const res = await fetch(BALANCER_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ query: QUERY, variables: { first: pageSize, skip } }),
      signal,
    });

    if (!res.ok) {
      console.warn(`[fetch-balancer] API returned ${res.status}`);
      break;
    }

    const json = await res.json() as { data?: { poolGetPools?: BalancerPool[] } };
    const pools = json.data?.poolGetPools;
    if (!pools || pools.length === 0) break;

    for (const pool of pools) {
      const chain = BALANCER_CHAIN_MAP[pool.chain];
      if (!chain) continue;

      const tvlUsd = parseFloat(pool.dynamicData.totalLiquidity);
      const volume24h = parseFloat(pool.dynamicData.volume24h);
      const swapFee = parseFloat(pool.dynamicData.swapFee);
      if (!Number.isFinite(tvlUsd) || tvlUsd <= 0) continue;

      const isStable = STABLE_POOL_TYPES.has(pool.type);
      const poolType = isStable ? "balancer-stable" : "balancer-weighted";

      const balances = pool.poolTokens.map((t) => parseFloat(t.balance)).filter(Number.isFinite);
      const balancesUsd = pool.poolTokens.map((t) => parseFloat(t.balanceUSD)).filter(Number.isFinite);

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
        poolAddress: pool.id,
        poolType,
        tokens: pool.poolTokens.map((t) => {
          const bal = parseFloat(t.balance);
          const balUsd = parseFloat(t.balanceUSD);
          const tokenPriceUsd = (Number.isFinite(bal) && bal > 0 && Number.isFinite(balUsd) && balUsd > 0)
            ? balUsd / bal : null;
          return { address: t.address, symbol: t.symbol, decimals: t.decimals, priceUsd: tokenPriceUsd };
        }),
        price,
        tvlUsd,
        volume24hUsd: Number.isFinite(volume24h) ? volume24h : 0,
        feeRate: Number.isFinite(swapFee) ? swapFee : null,
        balances: balances.length === pool.poolTokens.length ? balances : null,
      });
    }

    if (pools.length < pageSize) break;
    skip += pageSize;
  }

  if (results.length > 0) {
    console.log(`[fetch-balancer] Fetched ${results.length} pools`);
  }
  return results;
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd worker && npx vitest run src/cron/__tests__/dex-liquidity-direct-api.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/dex-liquidity/fetch-balancer.ts worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts
git commit -m "feat(dex): add Balancer GraphQL API fetcher"
```

---

## Task 5: Raydium Fetcher

**Files:**
- Create: `worker/src/cron/dex-liquidity/fetch-raydium.ts`
- Modify: `worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts`

- [ ] **Step 1: Write test for `fetchRaydiumPools`**

Append to `worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts`:

```typescript
describe("fetchRaydiumPools", () => {
  afterEach(() => { mockFetch.mockReset(); vi.resetModules(); });

  it("fetches concentrated pools and maps to DexApiPool", async () => {
    const { fetchRaydiumPools } = await import("../dex-liquidity/fetch-raydium");
    mockFetch.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { count: 1, data: [{
        type: "Concentrated",
        id: "poolAddr1",
        mintA: { address: "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA", symbol: "USDS", decimals: 6 },
        mintB: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6 },
        price: 0.9999,
        tvl: 42000000,
        mintAmountA: 20000000,
        mintAmountB: 22000000,
        feeRate: 0.0001,
        day: { volume: 2000000 },
      }]},
    })));

    const pools = await fetchRaydiumPools();
    expect(pools.length).toBe(1);
    expect(pools[0].source).toBe("raydium");
    expect(pools[0].poolType).toBe("raydium-clmm");
    expect(pools[0].tvlUsd).toBe(42000000);
    expect(pools[0].price).toBeCloseTo(0.9999);
    expect(pools[0].balances).toEqual([20000000, 22000000]);
  });

  it("classifies standard pools as raydium-amm", async () => {
    const { fetchRaydiumPools } = await import("../dex-liquidity/fetch-raydium");
    // First call for concentrated returns empty, second for standard returns pool
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { count: 0, data: [] } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { count: 1, data: [{
          type: "Standard",
          id: "stdPool",
          mintA: { address: "addr1", symbol: "USDC", decimals: 6 },
          mintB: { address: "addr2", symbol: "USDT", decimals: 6 },
          price: 1.0001,
          tvl: 100000,
          mintAmountA: 50000,
          mintAmountB: 50000,
          feeRate: 0.0025,
          day: { volume: 5000 },
        }]},
      })));

    const pools = await fetchRaydiumPools();
    const std = pools.find((p) => p.poolType === "raydium-amm");
    expect(std).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd worker && npx vitest run src/cron/__tests__/dex-liquidity-direct-api.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `fetch-raydium.ts`**

Create `worker/src/cron/dex-liquidity/fetch-raydium.ts`:

```typescript
import type { DexApiPool } from "../../lib/dex-api-common";
import { DIRECT_API_POOL_MIN_TVL_USD } from "../../lib/dex-api-common";
import { USER_AGENT } from "../../lib/constants";

const RAYDIUM_API = "https://api-v3.raydium.io/pools/info/list";

interface RaydiumPool {
  type: string;
  id: string;
  mintA: { address: string; symbol: string; decimals: number };
  mintB: { address: string; symbol: string; decimals: number };
  price: number;
  tvl: number;
  mintAmountA: number;
  mintAmountB: number;
  feeRate: number;
  day: { volume: number };
}

async function fetchPoolType(
  poolType: "concentrated" | "standard",
  signal?: AbortSignal,
): Promise<DexApiPool[]> {
  const results: DexApiPool[] = [];
  let page = 1;

  while (true) {
    const url = `${RAYDIUM_API}?poolType=${poolType === "concentrated" ? "Concentrated" : "Standard"}&poolSortField=liquidity&sortType=desc&pageSize=1000&page=${page}`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal,
    });
    if (!res.ok) {
      console.warn(`[fetch-raydium] ${poolType} page ${page} returned ${res.status}`);
      break;
    }

    const json = await res.json() as { success?: boolean; data?: { data?: RaydiumPool[] } };
    const pools = json.data?.data;
    if (!pools || pools.length === 0) break;

    let belowThreshold = false;
    for (const pool of pools) {
      if (!Number.isFinite(pool.tvl) || pool.tvl < DIRECT_API_POOL_MIN_TVL_USD) {
        belowThreshold = true;
        break;
      }

      const isConcentrated = poolType === "concentrated";
      results.push({
        source: "raydium",
        chain: "solana",
        poolAddress: pool.id,
        poolType: isConcentrated ? "raydium-clmm" : "raydium-amm",
        tokens: [
          { address: pool.mintA.address, symbol: pool.mintA.symbol, decimals: pool.mintA.decimals },
          { address: pool.mintB.address, symbol: pool.mintB.symbol, decimals: pool.mintB.decimals },
        ],
        price: Number.isFinite(pool.price) && pool.price > 0 ? pool.price : null,
        tvlUsd: pool.tvl,
        volume24hUsd: Number.isFinite(pool.day?.volume) ? pool.day.volume : 0,
        feeRate: Number.isFinite(pool.feeRate) ? pool.feeRate : null,
        balances: [pool.mintAmountA, pool.mintAmountB].every(Number.isFinite)
          ? [pool.mintAmountA, pool.mintAmountB]
          : null,
      });
    }

    if (belowThreshold || pools.length < 1000) break;
    page++;
  }

  return results;
}

export async function fetchRaydiumPools(signal?: AbortSignal): Promise<DexApiPool[]> {
  const [concentrated, standard] = await Promise.allSettled([
    fetchPoolType("concentrated", signal),
    fetchPoolType("standard", signal),
  ]);

  const results: DexApiPool[] = [];
  if (concentrated.status === "fulfilled") results.push(...concentrated.value);
  else console.warn("[fetch-raydium] Concentrated fetch failed:", concentrated.reason);
  if (standard.status === "fulfilled") results.push(...standard.value);
  else console.warn("[fetch-raydium] Standard fetch failed:", standard.reason);

  if (results.length > 0) {
    console.log(`[fetch-raydium] Fetched ${results.length} pools`);
  }
  return results;
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd worker && npx vitest run src/cron/__tests__/dex-liquidity-direct-api.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/dex-liquidity/fetch-raydium.ts worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts
git commit -m "feat(dex): add Raydium REST API fetcher"
```

---

## Task 6: Orca Fetcher

**Files:**
- Create: `worker/src/cron/dex-liquidity/fetch-orca.ts`
- Modify: `worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts`

- [ ] **Step 1: Write test for `fetchOrcaPools`**

Append to `worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts`:

```typescript
describe("fetchOrcaPools", () => {
  afterEach(() => { mockFetch.mockReset(); vi.resetModules(); });

  it("fetches whirlpools and normalizes to DexApiPool", async () => {
    const { fetchOrcaPools } = await import("../dex-liquidity/fetch-orca");
    mockFetch.mockResolvedValue(new Response(JSON.stringify({
      data: [{
        address: "9tXiuRRw7kbejLhZXtxDxYs2REe43uH2e7k1kocgdM9B",
        price: "0.99991840037040574739",
        tvlUsdc: "29901161.1424620915653082",
        feeRate: 100,
        tokenA: { address: "mint1", symbol: "PYUSD", decimals: 6 },
        tokenB: { address: "mint2", symbol: "USDC", decimals: 6 },
        tokenBalanceA: "17723442437577",
        tokenBalanceB: "12182931105377",
        stats: { "24h": { volume: "1635006.18" } },
      }],
      meta: { next: null },
    })));

    const pools = await fetchOrcaPools();
    expect(pools.length).toBe(1);
    expect(pools[0].source).toBe("orca");
    expect(pools[0].poolType).toBe("orca-whirlpool");
    expect(pools[0].price).toBeCloseTo(0.9999184);
    expect(pools[0].tvlUsd).toBeCloseTo(29901161.14);
    expect(pools[0].feeRate).toBeCloseTo(0.0001); // 100 / 1_000_000
  });

  it("handles 429 rate limit gracefully", async () => {
    const { fetchOrcaPools } = await import("../dex-liquidity/fetch-orca");
    mockFetch.mockResolvedValue(new Response("rate limited", { status: 429 }));
    const pools = await fetchOrcaPools();
    expect(pools).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd worker && npx vitest run src/cron/__tests__/dex-liquidity-direct-api.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `fetch-orca.ts`**

Create `worker/src/cron/dex-liquidity/fetch-orca.ts`:

```typescript
import type { DexApiPool } from "../../lib/dex-api-common";
import { DIRECT_API_POOL_MIN_TVL_USD } from "../../lib/dex-api-common";
import { USER_AGENT } from "../../lib/constants";

const ORCA_API = "https://api.orca.so/v2/solana/pools";

interface OrcaPool {
  address: string;
  price: string;
  tvlUsdc: string;
  feeRate: number;
  tokenA: { address: string; symbol: string; decimals: number };
  tokenB: { address: string; symbol: string; decimals: number };
  tokenBalanceA: string;
  tokenBalanceB: string;
  stats: { "24h"?: { volume?: string } };
}

interface OrcaResponse {
  data: OrcaPool[];
  meta: { next: string | null };
}

export async function fetchOrcaPools(signal?: AbortSignal): Promise<DexApiPool[]> {
  const results: DexApiPool[] = [];
  let url: string | null = `${ORCA_API}?sortBy=tvl&sortDirection=desc&minTvl=${DIRECT_API_POOL_MIN_TVL_USD}&size=200`;

  while (url) {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal,
    });

    if (res.status === 429) {
      console.warn("[fetch-orca] Rate limited (429), stopping pagination");
      break;
    }
    if (!res.ok) {
      console.warn(`[fetch-orca] API returned ${res.status}`);
      break;
    }

    const json = await res.json() as OrcaResponse;
    if (!json.data || json.data.length === 0) break;

    for (const pool of json.data) {
      const tvlUsd = parseFloat(pool.tvlUsdc);
      const price = parseFloat(pool.price);
      const volume = parseFloat(pool.stats?.["24h"]?.volume ?? "0");
      const balA = parseFloat(pool.tokenBalanceA);
      const balB = parseFloat(pool.tokenBalanceB);

      if (!Number.isFinite(tvlUsd) || tvlUsd < DIRECT_API_POOL_MIN_TVL_USD) continue;

      results.push({
        source: "orca",
        chain: "solana",
        poolAddress: pool.address,
        poolType: "orca-whirlpool",
        tokens: [
          { address: pool.tokenA.address, symbol: pool.tokenA.symbol, decimals: pool.tokenA.decimals },
          { address: pool.tokenB.address, symbol: pool.tokenB.symbol, decimals: pool.tokenB.decimals },
        ],
        price: Number.isFinite(price) && price > 0 ? price : null,
        tvlUsd,
        volume24hUsd: Number.isFinite(volume) ? volume : 0,
        // Orca feeRate is in hundredths of a basis point (100 = 1bp = 0.0001)
        feeRate: Number.isFinite(pool.feeRate) ? pool.feeRate / 1_000_000 : null,
        balances: Number.isFinite(balA) && Number.isFinite(balB) ? [balA, balB] : null,
      });
    }

    // Cursor-based pagination
    url = json.meta?.next ? `${ORCA_API}?next=${encodeURIComponent(json.meta.next)}&size=200` : null;
  }

  if (results.length > 0) {
    console.log(`[fetch-orca] Fetched ${results.length} pools`);
  }
  return results;
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd worker && npx vitest run src/cron/__tests__/dex-liquidity-direct-api.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/dex-liquidity/fetch-orca.ts worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts
git commit -m "feat(dex): add Orca REST API fetcher"
```

---

## Task 7: Orchestrator Integration

**Files:**
- Modify: `worker/src/cron/dex-liquidity/orchestrator.ts`

- [ ] **Step 1: Add imports to orchestrator**

At the top of `worker/src/cron/dex-liquidity/orchestrator.ts`, add after line 16 (`import { persistScores, writeHistoricalSnapshots } from "./persistence";`):

```typescript
import { fetchFluidPools } from "./fetch-fluid";
import { fetchBalancerPools } from "./fetch-balancer";
import { fetchRaydiumPools } from "./fetch-raydium";
import { fetchOrcaPools } from "./fetch-orca";
import { convertToGtNewPools, extractPriceObservations, type DexApiPool } from "../../lib/dex-api-common";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { shouldAttemptFetch, recordOutcomeSafe } from "../../lib/circuit-breaker";
```

- [ ] **Step 2: Add direct API fetching after existing data sources**

In `syncDexLiquidity()`, after `fetchDataSources()` completes and the DL availability checks (around line 48, before the comment `// 2. Build symbol/address lookup maps` at line 50), add:

```typescript
  // Fetch direct API sources in parallel (non-fatal, circuit-breaker gated)
  // These run alongside the existing data source processing to maximize parallelism.
  // All response bodies are consumed inline (await res.json()), so connections are released promptly.
  const directApiFetchers: Array<{ name: string; circuitKey: string; fn: (s?: AbortSignal) => Promise<DexApiPool[]> }> = [
    { name: "Fluid", circuitKey: CIRCUIT_SOURCE.FLUID_DEX_API, fn: fetchFluidPools },
    { name: "Balancer", circuitKey: CIRCUIT_SOURCE.BALANCER_API, fn: fetchBalancerPools },
    { name: "Raydium", circuitKey: CIRCUIT_SOURCE.RAYDIUM_API, fn: fetchRaydiumPools },
    { name: "Orca", circuitKey: CIRCUIT_SOURCE.ORCA_API, fn: fetchOrcaPools },
  ];

  const directApiPromise = Promise.allSettled(
    directApiFetchers.map(async ({ name, circuitKey, fn }) => {
      if (!(await shouldAttemptFetch(db, circuitKey))) {
        console.log(`[dex-liquidity] ${name} API circuit open, skipping`);
        return [];
      }
      try {
        const pools = await fn(signal);
        await recordOutcomeSafe(db, circuitKey, true);
        return pools;
      } catch (err) {
        if (signal?.aborted) throw err;
        console.warn(`[dex-liquidity] ${name} API failed (non-fatal):`, err);
        await recordOutcomeSafe(db, circuitKey, false);
        failedSources.push(circuitKey);
        return [];
      }
    }),
  );
```

Note: We start the fetches as a promise but don't await yet — we'll await after `symbolToIds`/`addressToId` are built so the API fetches run in parallel with Curve/Uniswap/Aerodrome processing.

- [ ] **Step 3: Await and merge direct API pools**

After the CG tickers fallback block (line 167, after `failedSources.push("cg-tickers-fallback")`) and before the fallback stats log (line 169), add:

```typescript
  // Await direct API results and merge into pipeline
  const directApiPools: DexApiPool[] = [];
  const directApiSettled = await directApiPromise;
  for (const result of directApiSettled) {
    if (result.status === "fulfilled") directApiPools.push(...result.value);
  }

  if (directApiPools.length > 0) {
    console.log(`[dex-liquidity] Fetched ${directApiPools.length} direct API pools total`);

    // Convert to GtNewPool and merge into metrics
    // symbolToIds and addressToId are already in scope from line 51
    const directApiGtPools = convertToGtNewPools(directApiPools, addressToId, symbolToIds);
    mergeGtPools(metrics, directApiGtPools);

    // Extract price observations with plausibility filtering
    const directApiPriceObs = extractPriceObservations(
      directApiPools, addressToId, symbolToIds, validationReferences,
    );
    for (const [id, obs] of directApiPriceObs) {
      const existing = priceObservations.get(id) ?? [];
      existing.push(...obs);
      priceObservations.set(id, existing);
    }
  }
```

This is inserted before `computeStablecoinScores()` at line 175, after all existing merge operations. The variables `symbolToIds`, `addressToId`, `metrics`, `priceObservations`, and `validationReferences` are all in scope from earlier in the function (lines 31, 51, 54, 111).

- [ ] **Step 4: Run type check**

Run: `cd worker && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 5: Run existing tests to verify no regression**

Run: `cd worker && npx vitest run`
Expected: All existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/dex-liquidity/orchestrator.ts
git commit -m "feat(dex): integrate 4 direct API fetchers into DEX liquidity orchestrator"
```

---

## Task 8: Pricing Pipeline Price Bridge

**Files:**
- Modify: `worker/src/lib/depeg-helpers.ts`
- Modify: `worker/src/cron/enrich-prices.ts`
- Create: `worker/src/cron/__tests__/dex-liquidity-price-bridge.test.ts`

- [ ] **Step 1: Write test for `loadDexPriceSources`**

Create `worker/src/cron/__tests__/dex-liquidity-price-bridge.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

describe("loadDexPriceSources", () => {
  it("parses price_sources_json into per-stablecoin protocol arrays", async () => {
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({
          results: [
            {
              stablecoin_id: "usdc",
              price_sources_json: JSON.stringify([
                { protocol: "fluid", chain: "ethereum", price: 0.9998, tvl: 500000 },
                { protocol: "balancer", chain: "ethereum", price: 1.0001, tvl: 800000 },
              ]),
              updated_at: Math.floor(Date.now() / 1000),
            },
          ],
        }),
      }),
    } as unknown as D1Database;

    const { loadDexPriceSources } = await import("../../lib/depeg-helpers");
    const result = await loadDexPriceSources(mockDb);

    expect(result.get("usdc")).toHaveLength(2);
    expect(result.get("usdc")![0].protocol).toBe("fluid");
    expect(result.get("usdc")![1].protocol).toBe("balancer");
  });

  it("returns empty map on missing table", async () => {
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockRejectedValue(new Error("no such table: dex_prices")),
      }),
    } as unknown as D1Database;

    const { loadDexPriceSources } = await import("../../lib/depeg-helpers");
    const result = await loadDexPriceSources(mockDb);
    expect(result.size).toBe(0);
  });
});
```

- [ ] **Step 2: Add `loadDexPriceSources` to `depeg-helpers.ts`**

In `worker/src/lib/depeg-helpers.ts`, add after `loadDexPriceRows()` (after line 60):

```typescript
/** Load per-protocol price breakdowns from dex_prices.price_sources_json for trusted rows. */
export async function loadDexPriceSources(
  db: D1Database,
  maxAgeSec = 2100, // 35 min = 30min cron + 5min buffer
): Promise<Map<string, DexPoolSource[]>> {
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    const rows = await db
      .prepare("SELECT stablecoin_id, price_sources_json, updated_at FROM dex_prices WHERE price_sources_json IS NOT NULL")
      .all<{ stablecoin_id: string; price_sources_json: string; updated_at: number }>();

    const result = new Map<string, DexPoolSource[]>();
    for (const row of rows.results ?? []) {
      if (nowSec - row.updated_at > maxAgeSec) continue;
      let sources: DexPoolSource[];
      try { sources = JSON.parse(row.price_sources_json); } catch { continue; }
      if (!Array.isArray(sources) || sources.length === 0) continue;
      result.set(row.stablecoin_id, sources);
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("no such table")) {
      console.error("[depeg-helpers] Unexpected error loading dex price sources:", msg);
    }
    return new Map();
  }
}
```

- [ ] **Step 3: Run test, verify it passes**

Run: `cd worker && npx vitest run src/cron/__tests__/dex-liquidity-price-bridge.test.ts`
Expected: All tests pass.

- [ ] **Step 4: Inject per-protocol prices in `enrich-prices.ts`**

In `worker/src/cron/enrich-prices.ts`, add import at the top:

```typescript
import { loadDexPriceSources, type DexPoolSource } from "../lib/depeg-helpers";
```

After the existing `loadDexPriceRows(db)` call (line 330), add:

```typescript
  const dexPriceSources = await loadDexPriceSources(db);
```

Before the per-asset loop (after line 334), declare the weights map at module scope:

```typescript
  const DEX_API_WEIGHTS: Record<string, number> = { fluid: 3, balancer: 3, raydium: 2, orca: 2 };
```

Then in the per-asset loop, after the existing `"dex-promoted"` injection (line 378), add:

```typescript
    // Disaggregate per-protocol prices from dex_prices.price_sources_json
    const protocolSources = dexPriceSources.get(asset.id);
    if (protocolSources) {
      for (const ps of protocolSources) {
        const w = DEX_API_WEIGHTS[ps.protocol];
        if (w == null) continue; // only inject for protocols with elevated weights
        if (ps.tvl < 50_000) continue; // min TVL for pricing
        if (!Number.isFinite(ps.price) || ps.price <= 0) continue;
        sources.push({
          source: `${ps.protocol}-dex`,
          price: ps.price,
          weight: w,
          metadata: { tvl: ps.tvl, chain: ps.chain },
        });
      }
    }
```

- [ ] **Step 5: Add new sources to `HARD_SOURCES`**

In `enrich-prices.ts`, update the `HARD_SOURCES` set (line 525) to include the new sources:

```typescript
const HARD_SOURCES = new Set([
  "pyth", "binance", "coinbase", "curve-onchain", "curve-oracle", "redstone", "protocol-redeem",
  "fluid-dex", "balancer-dex", "raydium-dex", "orca-dex",
]);
```

- [ ] **Step 6: Run type check**

Run: `cd worker && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 7: Run full test suite**

Run: `cd worker && npx vitest run`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add worker/src/lib/depeg-helpers.ts worker/src/cron/enrich-prices.ts \
  worker/src/cron/__tests__/dex-liquidity-price-bridge.test.ts
git commit -m "feat(dex): add per-protocol price disaggregation bridge from DEX liquidity to pricing consensus"
```

---

## Task 9: Full Build Verification

**Files:** None modified — verification only.

- [ ] **Step 1: Run frontend build + type check**

Run: `npm run build`
Expected: Build succeeds with no errors. This catches any `LiquidityPoolSourceFamily` breakage in the frontend.

- [ ] **Step 2: Run worker type check**

Run: `cd worker && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Run lint**

Run: `npm run lint`
Expected: No lint errors.

- [ ] **Step 5: Commit any lint fixes if needed**

```bash
git add -A && git commit -m "fix: lint/type cleanup from multi-DEX API integration"
```

---

## Task 10: Documentation Update

**Files:**
- Modify: `docs/dex-liquidity.md`
- Modify: `docs/data-flow-map.md`

- [ ] **Step 1: Update dex-liquidity docs**

In `docs/dex-liquidity.md`, add a new row to the data sources table for each of the four new sources (Fluid, Balancer, Raydium, Orca) documenting their API endpoint, chain coverage, pool types, quality multipliers, and price confidence tier. Also update the price observation sources table to include the four new protocols at Tier 1.

- [ ] **Step 2: Update data flow map**

In `docs/data-flow-map.md`, add the four direct API fetchers to the DEX liquidity pipeline section and note the price bridge via `price_sources_json`.

- [ ] **Step 3: Commit**

```bash
git add docs/dex-liquidity.md docs/data-flow-map.md
git commit -m "docs: update dex-liquidity and data-flow docs for multi-DEX API integration"
```

---

## Task 11: Deploy and Monitor

- [ ] **Step 1: Push to remote**

```bash
git push origin main
```

- [ ] **Step 2: Verify Cloudflare Pages build succeeds**

Check the Cloudflare Pages dashboard for build status. Frontend should build cleanly.

- [ ] **Step 3: Verify worker deployment**

Run: `cd worker && npx wrangler deploy`
Or verify CI deploys the worker automatically.

- [ ] **Step 4: Monitor first 3 half-hourly cron runs**

Check worker logs for the DEX liquidity cron. Look for:
- `[fetch-fluid] Fetched N pools across M chains`
- `[fetch-balancer] Fetched N pools`
- `[fetch-raydium] Fetched N pools`
- `[fetch-orca] Fetched N pools`
- `[dex-liquidity] Fetched N direct API pools total`
- `[dex-liquidity] Merged N GT pools into M stablecoins`
- No error messages from the new fetchers
- Circuit breaker not tripping

Expected: All four fetchers produce pools and merge into scoring within the first run.

- [ ] **Step 5: Monitor first 3 quarter-hourly pricing cron runs**

Check worker logs for the pricing cron. Look for:
- Per-protocol price sources appearing in consensus (e.g., `fluid-dex`, `balancer-dex`, `raydium-dex`, `orca-dex`)
- No consensus degradation (prices should remain stable or improve)

- [ ] **Step 6: Verify API responses**

Check `https://api.pharos.watch/api/dex-liquidity` for updated `source_mix` including the new protocols. Check individual stablecoin pages for Fluid/Balancer/Raydium/Orca appearing in liquidity breakdowns.

- [ ] **Step 7: Fix any issues found during monitoring**

If any fetcher consistently fails, check:
- API endpoint URL correctness
- Response format matches expectations
- Circuit breaker state (may need manual reset via D1 console if tripped during testing)
- Token matching (are stablecoin addresses being correctly matched?)
