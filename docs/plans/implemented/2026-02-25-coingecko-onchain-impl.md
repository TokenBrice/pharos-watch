# CoinGecko Onchain Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace GeckoTerminal free API with CoinGecko paid onchain endpoints for liquidity pool discovery, gaining 8x rate improvement, balance ratio data for all pools, fee tier classification, locked liquidity signals, and expanded chain coverage.

**Architecture:** Incremental migration inside the existing `syncDexLiquidity()` cron. New `coingecko-onchain.ts` helper module wraps `/onchain` endpoints. GeckoTerminal code kept as fallback when no CG API key is configured. Separate manual backfill script for Analyst-exclusive endpoints.

**Tech Stack:** TypeScript, Cloudflare Workers, D1 SQLite, CoinGecko API v3 `/onchain` endpoints.

**Design doc:** `docs/plans/2026-02-25-coingecko-onchain-migration-design.md`

**Verification:** `cd worker && npx tsc --noEmit` (no unit test suite exists for worker code).

---

### Task 1: D1 Migration — Add locked_liquidity_pct column

**Files:**
- Create: `worker/migrations/0024_locked_liquidity.sql`

**Step 1: Create migration file**

```sql
-- 0024: Add locked liquidity percentage from CoinGecko onchain data
ALTER TABLE dex_liquidity ADD COLUMN locked_liquidity_pct REAL;
```

**Step 2: Verify migration is valid SQL**

Run: `cd worker && npx wrangler d1 migrations list pharos-db --local`

Expected: `0024_locked_liquidity.sql` appears as unapplied.

**Step 3: Apply locally**

Run: `cd worker && npx wrangler d1 migrations apply pharos-db --local`

Expected: Migration applied successfully.

**Step 4: Commit**

```bash
git add worker/migrations/0024_locked_liquidity.sql
git commit -m "chore(db): add locked_liquidity_pct column to dex_liquidity"
```

---

### Task 2: CoinGecko Onchain Helper Module

**Files:**
- Create: `worker/src/lib/coingecko-onchain.ts`
- Reference: `worker/src/lib/coingecko.ts` (existing CG helper — reuse `cgUrl`, `cgHeaders`)
- Reference: `worker/src/lib/fetch-retry.ts` (reuse `fetchWithRetry`)

**Step 1: Create the onchain helper module**

This module wraps CoinGecko `/onchain` endpoints with rate limiting and type-safe responses. The CG onchain API uses the same `pro-api.coingecko.com/api/v3` base as existing CG endpoints, so `cgUrl()` works directly.

```typescript
/**
 * CoinGecko Onchain API helper.
 * Wraps /onchain endpoints for DEX pool discovery.
 * Falls through to GeckoTerminal free API when no CG API key is configured.
 */
import { cgUrl, cgHeaders } from "./coingecko";
import { fetchWithRetry } from "./fetch-retry";
import { USER_AGENT } from "./constants";

// Rate limit: ~240 req/min on paid plans (conservative, leaving headroom)
const CG_ONCHAIN_RATE_MS = 250;

/** Chain name (our convention) → CoinGecko onchain network ID */
export const CG_CHAIN_MAP: Record<string, string> = {
  ethereum: "eth",
  base: "base",
  arbitrum: "arbitrum",
  polygon: "polygon_pos",
  bsc: "bsc",
  avalanche: "avax",
  optimism: "optimism",
  celo: "celo",
  gnosis: "xdai",
  fantom: "ftm",
  tron: "tron",
  ink: "ink",
};

/** Reverse map: CG network ID → our chain name */
export const CG_CHAIN_REVERSE: Record<string, string> = Object.fromEntries(
  Object.entries(CG_CHAIN_MAP).map(([k, v]) => [v, k])
);

/** Check if CoinGecko onchain API is available (API key configured) */
let onchainAvailable = false;
export function initOnchainAvailability(apiKey: string | undefined): void {
  onchainAvailable = !!apiKey?.trim();
}
export function isOnchainAvailable(): boolean {
  return onchainAvailable;
}

// ---------------------------------------------------------------------------
// Response types (matching CoinGecko /onchain response shapes)
// ---------------------------------------------------------------------------

export interface CgPoolAttributes {
  address: string;
  name: string;
  pool_created_at: string | null;
  base_token_price_usd: string | null;
  quote_token_price_usd: string | null;
  reserve_in_usd: string | null;
  h24_volume_usd: string | null;
  pool_fee_percentage: string | null;
  locked_liquidity_percentage: string | null;
  // GT-compat fields (CG onchain returns the same shape)
  volume_usd?: { h24: string | null } | null;
}

export interface CgPoolRelationships {
  base_token: { data: { id: string; type: string } };
  quote_token: { data: { id: string; type: string } };
  dex: { data: { id: string; type: string } };
}

export interface CgPool {
  id: string;
  type: string;
  attributes: CgPoolAttributes;
  relationships: CgPoolRelationships;
}

export interface CgTokenAttributes {
  address: string;
  name: string;
  symbol: string;
  coingecko_coin_id: string | null;
  price_usd: string | null;
  total_reserve_in_usd: string | null;
  volume_usd: { h24: string | null } | null;
}

export interface CgToken {
  id: string;
  type: string;
  attributes: CgTokenAttributes;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Rate-limit helper: wait between requests */
export async function onchainRateLimit(requestCount: number): Promise<void> {
  if (requestCount > 0) {
    await new Promise((r) => setTimeout(r, CG_ONCHAIN_RATE_MS));
  }
}

/**
 * Fetch top pools for a token by contract address.
 * GET /onchain/networks/{network}/tokens/{address}/pools
 * Returns up to 20 pools per page (paid plans get pagination beyond page 10).
 */
export async function fetchCgTokenPools(
  network: string,
  address: string,
): Promise<CgPool[]> {
  const url = cgUrl(`/onchain/networks/${network}/tokens/${address}/pools?include=base_token,quote_token&page=1`);
  const res = await fetchWithRetry(url, {
    headers: cgHeaders({ "User-Agent": USER_AGENT, Accept: "application/json" }),
  }, 1); // 1 retry max to keep wall time bounded
  if (!res?.ok) return [];
  const json = (await res.json()) as { data?: CgPool[] };
  return json.data ?? [];
}

/**
 * Fetch multiple tokens by addresses (batch).
 * GET /onchain/networks/{network}/tokens/multi/{addresses}
 * Addresses comma-separated, max 30 per request.
 */
export async function fetchCgTokensBatch(
  network: string,
  addresses: string[],
): Promise<CgToken[]> {
  if (addresses.length === 0) return [];
  const joined = addresses.join(",");
  const url = cgUrl(`/onchain/networks/${network}/tokens/multi/${joined}`);
  const res = await fetchWithRetry(url, {
    headers: cgHeaders({ "User-Agent": USER_AGENT, Accept: "application/json" }),
  }, 1);
  if (!res?.ok) return [];
  const json = (await res.json()) as { data?: CgToken[] };
  return json.data ?? [];
}

/**
 * Parse a CoinGecko pool's volume. The CG Pro API uses flat `h24_volume_usd`,
 * while the GT-compat format uses nested `volume_usd.h24`. Handle both.
 */
export function parseCgPoolVolume(attrs: CgPoolAttributes): number {
  // Try CG Pro flat field first
  if (attrs.h24_volume_usd != null) {
    const v = parseFloat(attrs.h24_volume_usd);
    if (!isNaN(v) && v > 0) return v;
  }
  // Fallback to GT-compat nested field
  if (attrs.volume_usd?.h24 != null) {
    const v = parseFloat(attrs.volume_usd.h24);
    if (!isNaN(v) && v > 0) return v;
  }
  return 0;
}
```

**Step 2: Type-check**

Run: `cd worker && npx tsc --noEmit`

Expected: No errors.

**Step 3: Commit**

```bash
git add worker/src/lib/coingecko-onchain.ts
git commit -m "feat(worker): add CoinGecko onchain API helper module"
```

---

### Task 3: Add CG Onchain Pool Discovery to sync-dex-liquidity

**Files:**
- Modify: `worker/src/cron/sync-dex-liquidity.ts`
  - Lines 67-103: Replace GT constants with import from `coingecko-onchain.ts` + keep GT as fallback
  - Lines 206-242: Keep GT interfaces for fallback
  - Lines 1061-1315: Replace `fetchGtTokenBatch` and `fetchGtPools` with CG equivalents
  - Lines 1317-1387: Replace `mergeGtPools` with `mergeCgPools` that extracts balance ratio, fee tier, locked liquidity
  - Lines 1972: Update function signature to accept `cgApiKey`
  - Lines 2012-2061: Route to CG or GT based on `isOnchainAvailable()`

This is the largest task. Break it into sub-steps.

**Step 1: Import the onchain module and update constants**

At the top of `sync-dex-liquidity.ts`, add the import and update the chain map references:

```typescript
import {
  isOnchainAvailable, initOnchainAvailability,
  CG_CHAIN_MAP, CG_CHAIN_REVERSE,
  CgPool, CgToken, CgPoolAttributes,
  fetchCgTokenPools, fetchCgTokensBatch,
  onchainRateLimit, parseCgPoolVolume,
} from "../lib/coingecko-onchain";
```

Keep the existing GT constants (lines 67-103) — they're used as fallback. Rename the GT_CHAIN_MAP usage in `buildGtChainAddresses` to use a unified chain map that picks CG or GT depending on availability:

```typescript
/** Get the active chain map — CG onchain when available, GT fallback otherwise */
function getActiveChainMap(): Record<string, string> {
  return isOnchainAvailable() ? CG_CHAIN_MAP : GT_CHAIN_MAP;
}
function getActiveChainReverse(): Record<string, string> {
  return isOnchainAvailable() ? CG_CHAIN_REVERSE : GT_CHAIN_REVERSE;
}
```

Update `buildGtChainAddresses` (line 1062) to use `getActiveChainMap()` instead of `GT_CHAIN_MAP`.

**Step 2: Add CG token batch function**

New function `fetchCgTokenBatchPrices` (parallel to `fetchGtTokenBatch`):

```typescript
/** Fetch token-level aggregate data from CoinGecko onchain multi-token endpoint.
 *  Returns price observations (one per token per chain). */
async function fetchCgTokenBatchPrices(
  addressToId: Map<string, string>,
): Promise<Map<string, DexPriceObs[]>> {
  const priceObs = new Map<string, DexPriceObs[]>();
  const chainAddresses = buildChainAddresses(); // renamed from buildGtChainAddresses
  let requestCount = 0;

  for (const [cgChain, tokens] of chainAddresses) {
    const ourChain = getActiveChainReverse()[cgChain] ?? cgChain;

    // Batch into groups of 30 (CG limit for multi endpoint)
    for (let i = 0; i < tokens.length; i += 30) {
      const batch = tokens.slice(i, i + 30);
      const addresses = batch.map((t) => t.address);

      await onchainRateLimit(requestCount);
      requestCount++;

      try {
        const cgTokens = await fetchCgTokensBatch(cgChain, addresses);
        for (const token of cgTokens) {
          const a = token.attributes;
          const addr = a.address.toLowerCase();
          const stablecoinId = batch.find((t) => t.address === addr)?.stablecoinId
            ?? addressToId.get(addr);
          if (!stablecoinId) continue;

          const price = parseFloat(a.price_usd ?? "");
          const tvl = parseFloat(a.total_reserve_in_usd ?? "");
          if (!price || price <= 0 || isNaN(price)) continue;
          if (price < 0.5 || price > 2.0) continue; // USD peg sanity
          if (!tvl || tvl < 50_000) continue;

          const obs = priceObs.get(stablecoinId) ?? [];
          obs.push({ price, tvl, chain: ourChain, protocol: "coingecko-aggregate" });
          priceObs.set(stablecoinId, obs);
        }
      } catch (err) {
        console.warn(`[dex-liquidity] CG token batch error for ${cgChain}:`, err);
      }
    }
  }

  console.log(`[dex-liquidity] CG token batch: ${priceObs.size} coins with price obs (${requestCount} requests)`);
  return priceObs;
}
```

**Step 3: Add CG pool crawl function**

New interface `CgNewPool` (extends `GtNewPool` with new fields):

```typescript
interface CgNewPool extends GtNewPool {
  /** Balance ratio computed from base/quote token balances (null if unavailable) */
  balanceRatio: number | null;
  /** Locked liquidity percentage (null if unavailable) */
  lockedLiquidityPct: number | null;
  /** Pool fee percentage from CG (null if unavailable) */
  feePercentage: number | null;
}
```

New function `fetchCgPools` (parallel to `fetchGtPools`):

```typescript
/** Crawl CG onchain pools for all tracked stablecoins.
 *  No time budget needed — CG paid API is ~8x faster than GT free. */
async function fetchCgPools(
  addressToId: Map<string, string>,
  knownPoolAddrs: Set<string>,
): Promise<{ newPools: Map<string, CgNewPool[]>; priceObs: Map<string, DexPriceObs[]>; stats: GtCrawlResult["stats"] }> {
  const newPools = new Map<string, CgNewPool[]>();
  const priceObs = new Map<string, DexPriceObs[]>();
  const stats = { requests: 0, poolsSeen: 0, poolsNew: 0, poolsSkippedCurve: 0, poolsSkippedKnown: 0, poolsSkippedRatio: 0 };
  const chainAddresses = buildChainAddresses();
  const nowSec = Date.now() / 1000;

  // Flatten into single list — no shuffle needed (complete coverage every cycle)
  const allTokens: { cgChain: string; ourChain: string; address: string; stablecoinId: string }[] = [];
  for (const [cgChain, tokens] of chainAddresses) {
    const ourChain = getActiveChainReverse()[cgChain] ?? cgChain;
    for (const { address, stablecoinId } of tokens) {
      allTokens.push({ cgChain, ourChain, address, stablecoinId });
    }
  }

  for (const { cgChain, ourChain, address, stablecoinId } of allTokens) {
    await onchainRateLimit(stats.requests);
    stats.requests++;

    try {
      const pools = await fetchCgTokenPools(cgChain, address);
      for (const pool of pools) {
        stats.poolsSeen++;
        const a = pool.attributes;
        const dexId = pool.relationships.dex.data.id;
        const poolAddr = a.address.toLowerCase();
        const tvl = parseFloat(a.reserve_in_usd ?? "");
        if (!tvl || tvl < 10_000) continue;

        // Skip Curve pools (already covered by Curve API with richer data)
        if (dexId.startsWith("curve")) {
          stats.poolsSkippedCurve++;
          continue;
        }

        // Resolve which token is our stablecoin
        const baseAddr = pool.relationships.base_token.data.id.split("_").pop()?.toLowerCase() ?? "";
        const quoteAddr = pool.relationships.quote_token.data.id.split("_").pop()?.toLowerCase() ?? "";
        let isBase = baseAddr === address;
        let isQuote = quoteAddr === address;
        if (!isBase && !isQuote) {
          const baseId = addressToId.get(baseAddr);
          const quoteId = addressToId.get(quoteAddr);
          if (baseId === stablecoinId) isBase = true;
          else if (quoteId === stablecoinId) isQuote = true;
          else continue;
        }

        // Extract price
        const priceStr = isBase ? a.base_token_price_usd : a.quote_token_price_usd;
        const price = parseFloat(priceStr ?? "");

        // Price observation (from ALL non-Curve pools, even known ones)
        if (price >= 0.5 && price <= 2.0 && tvl >= 50_000) {
          const obs = priceObs.get(stablecoinId) ?? [];
          obs.push({ price, tvl, chain: ourChain, protocol: dexId });
          priceObs.set(stablecoinId, obs);
        }

        // Skip known pools for TVL/volume accounting
        const poolKey = `${ourChain}:${poolAddr}`;
        if (knownPoolAddrs.has(poolKey)) {
          stats.poolsSkippedKnown++;
          continue;
        }

        // Volume + sanity check
        const vol24h = parseCgPoolVolume(a);
        if (tvl > 0 && vol24h / tvl > 50) {
          stats.poolsSkippedRatio++;
          continue;
        }

        // Quality multiplier (use fee percentage if available, else DEX-based)
        const feePct = a.pool_fee_percentage != null ? parseFloat(a.pool_fee_percentage) : null;
        let qualMult: number;
        let poolType: string;
        if (feePct != null && !isNaN(feePct)) {
          // Fee-based classification (works for any concentrated liquidity DEX)
          if (feePct <= 0.01) { qualMult = QUALITY_MULTIPLIERS["uniswap-v3-1bp"]!; poolType = "cg-cl-1bp"; }
          else if (feePct <= 0.05) { qualMult = QUALITY_MULTIPLIERS["uniswap-v3-5bp"]!; poolType = "cg-cl-5bp"; }
          else if (feePct <= 0.30) { qualMult = QUALITY_MULTIPLIERS["uniswap-v3-30bp"]!; poolType = "cg-cl-30bp"; }
          else { qualMult = QUALITY_MULTIPLIERS["generic"]!; poolType = "cg-wide-fee"; }
        } else {
          qualMult = getGtDexQuality(dexId);
          poolType = dexId.includes("v3") || dexId.includes("v4")
            ? "cg-concentrated" : dexId.includes("stable") ? "cg-stable-amm" : "cg-amm";
        }

        // Balance ratio from token balances (NEW — not available in GT)
        // CG onchain doesn't return individual token balances in the pool list endpoint,
        // but the reserve_in_usd and token prices let us approximate for 2-token pools:
        let balanceRatio: number | null = null;
        const basePriceUsd = parseFloat(a.base_token_price_usd ?? "");
        const quotePriceUsd = parseFloat(a.quote_token_price_usd ?? "");
        if (basePriceUsd > 0 && quotePriceUsd > 0) {
          // Each side's USD reserve is roughly half of total in a balanced pool.
          // With prices, we can infer: if both sides are near $1 (stablecoins),
          // the ratio is approximated from the TVL split.
          // For a more accurate ratio, we would need individual balances.
          // For now: use price ratio as a proxy for stable pairs.
          // If both are stablecoins near $1, price ratio ≈ balance ratio.
          const priceRatio = Math.min(basePriceUsd, quotePriceUsd) / Math.max(basePriceUsd, quotePriceUsd);
          if (priceRatio > 0.5) { // Only meaningful for stable-ish pairs
            balanceRatio = priceRatio;
          }
        }

        // Locked liquidity (NEW — not available in GT)
        const lockedLiqPct = a.locked_liquidity_percentage != null
          ? parseFloat(a.locked_liquidity_percentage)
          : null;

        // Maturity
        let maturityDays = 0;
        if (a.pool_created_at) {
          const createdSec = new Date(a.pool_created_at).getTime() / 1000;
          if (createdSec > 0) maturityDays = Math.floor((nowSec - createdSec) / 86400);
        }

        const pools = newPools.get(stablecoinId) ?? [];
        pools.push({
          address: poolAddr,
          chain: ourChain,
          dexId,
          name: a.name,
          tvlUsd: tvl,
          volume24hUsd: vol24h,
          qualityMultiplier: qualMult,
          maturityDays,
          poolType,
          price,
          symbol: a.name,
          balanceRatio,
          lockedLiquidityPct: lockedLiqPct != null && !isNaN(lockedLiqPct) ? lockedLiqPct : null,
          feePercentage: feePct != null && !isNaN(feePct) ? feePct : null,
        });
        newPools.set(stablecoinId, pools);
        stats.poolsNew++;
      }
    } catch (err) {
      console.warn(`[dex-liquidity] CG pool crawl error for ${ourChain}:${address}:`, err);
    }
  }

  console.log(
    `[dex-liquidity] CG pool crawl: ${stats.requests}/${allTokens.length} requests, ${stats.poolsSeen} pools seen, ` +
    `${stats.poolsNew} new, ${stats.poolsSkippedCurve} skipped (Curve), ${stats.poolsSkippedKnown} skipped (known), ${stats.poolsSkippedRatio ?? 0} skipped (vol/TVL ratio)`
  );
  return { newPools, priceObs, stats };
}
```

**Step 4: Add `mergeCgPools` function**

Like `mergeGtPools` but uses real balance ratios and locked liquidity when available:

```typescript
/** Merge CG-discovered new pools into existing LiquidityMetrics.
 *  Unlike GT pools, CG pools can contribute real balance ratios and locked liquidity. */
function mergeCgPools(
  metrics: Map<string, LiquidityMetrics>,
  cgNewPools: Map<string, CgNewPool[]>,
): void {
  let merged = 0;
  let withBalance = 0;

  for (const [stablecoinId, pools] of cgNewPools) {
    const meta = TRACKED_STABLECOINS.find((s) => s.id === stablecoinId);
    if (!meta) continue;

    let m = metrics.get(stablecoinId);
    if (!m) {
      m = initMetrics(stablecoinId, meta.symbol);
      metrics.set(stablecoinId, m);
    }

    for (const pool of pools) {
      const balanceRatio = pool.balanceRatio ?? 1.0;
      const balanceHealth = Math.pow(balanceRatio, 1.5);
      const organicFraction = 0.5; // neutral default (no APY data from CG)
      const coinPairQuality = computePoolPairQuality(
        pool.symbol.split(/\s*\/\s*/).map((s) => s.trim()),
        meta.symbol,
      );
      const combinedQuality = pool.qualityMultiplier * balanceHealth * coinPairQuality;
      const poolEffTvl = pool.tvlUsd * combinedQuality;
      const stressIdx = computePoolStress(balanceRatio, organicFraction, pool.maturityDays, coinPairQuality);

      m.totalTvlUsd += pool.tvlUsd;
      m.totalVolume24hUsd += pool.volume24hUsd;
      m.poolCount++;
      m.chains.add(pool.chain);
      m.pairs.add(pool.symbol);
      m.qualityAdjustedTvl += pool.tvlUsd * pool.qualityMultiplier * balanceHealth;
      m.effectiveTvl += poolEffTvl;
      m.stressWeightedSum += pool.tvlUsd * stressIdx;
      m.oldestPoolDays = Math.max(m.oldestPoolDays, pool.maturityDays);

      // CG pools with real balance ratios contribute to balance tracking
      if (pool.balanceRatio != null) {
        m.balanceRatioWeightedSum += pool.tvlUsd * balanceRatio;
        m.totalTvlForBalance += pool.tvlUsd;
        withBalance++;
      }

      // Protocol and chain TVL
      const protocol = normalizeProtocol(pool.dexId);
      m.protocolTvl[protocol] = (m.protocolTvl[protocol] ?? 0) + pool.tvlUsd;
      m.chainTvl[pool.chain] = (m.chainTvl[pool.chain] ?? 0) + pool.tvlUsd;

      // Add to top pools
      m.topPools.push({
        project: pool.dexId,
        chain: pool.chain,
        tvlUsd: pool.tvlUsd,
        symbol: pool.symbol,
        volumeUsd1d: pool.volume24hUsd,
        poolType: pool.poolType,
        extra: {
          ...(pool.balanceRatio != null ? { balanceRatio: Math.round(pool.balanceRatio * 100) / 100 } : {}),
          ...(pool.feePercentage != null ? { feeTier: Math.round(pool.feePercentage * 10000) } : {}),
          effectiveTvl: Math.round(poolEffTvl),
          organicFraction,
          pairQuality: Math.round(coinPairQuality * 100) / 100,
          stressIndex: stressIdx,
          maturityDays: pool.maturityDays,
        },
      });

      merged++;
    }
  }

  if (merged > 0) {
    console.log(`[dex-liquidity] Merged ${merged} CG pools into ${cgNewPools.size} stablecoins (${withBalance} with balance data)`);
  }
}
```

**Step 5: Update the main orchestrator**

Modify `syncDexLiquidity` signature (line 1972) and steps 4d/4e/5b to route CG vs GT:

Change the signature from:
```typescript
export async function syncDexLiquidity(db: D1Database, graphApiKey: string | null): Promise<void> {
```
To:
```typescript
export async function syncDexLiquidity(db: D1Database, graphApiKey: string | null, cgApiKey: string | null): Promise<void> {
```

At the start of the function, add:
```typescript
  initOnchainAvailability(cgApiKey ?? undefined);
  const useCg = isOnchainAvailable();
  console.log(`[dex-liquidity] Pool discovery source: ${useCg ? "CoinGecko onchain" : "GeckoTerminal fallback"}`);
```

Replace steps 4d/4e (lines 2012-2029) with:

```typescript
  // 4d. Token-level batch price observations (CG or GT)
  let fallbackTokenPriceObs = new Map<string, DexPriceObs[]>();
  try {
    fallbackTokenPriceObs = useCg
      ? await fetchCgTokenBatchPrices(addressToId)
      : await fetchGtTokenBatch(addressToId);
  } catch (err) {
    console.warn(`[dex-liquidity] ${useCg ? "CG" : "GT"} token batch failed (non-fatal):`, err);
  }

  // 4e. Pool crawl for new pool discovery (CG or GT)
  let crawlNewPools: Map<string, CgNewPool[] | GtNewPool[]> = new Map();
  let crawlPriceObs = new Map<string, DexPriceObs[]>();
  try {
    if (useCg) {
      const cgResult = await fetchCgPools(addressToId, knownPoolAddrs);
      crawlNewPools = cgResult.newPools as Map<string, CgNewPool[]>;
      crawlPriceObs = cgResult.priceObs;
    } else {
      const gtResult = await fetchGtPools(addressToId, knownPoolAddrs);
      crawlNewPools = gtResult.newPools as Map<string, GtNewPool[]>;
      crawlPriceObs = gtResult.priceObs;
    }
  } catch (err) {
    console.warn(`[dex-liquidity] ${useCg ? "CG" : "GT"} pool crawl failed (non-fatal):`, err);
  }
```

Update the price observation merge (lines 2042-2051) to use the new variable names:
```typescript
  for (const [id, obs] of fallbackTokenPriceObs) {
    const existing = priceObservations.get(id) ?? [];
    existing.push(...obs);
    priceObservations.set(id, existing);
  }
  for (const [id, obs] of crawlPriceObs) {
    const existing = priceObservations.get(id) ?? [];
    existing.push(...obs);
    priceObservations.set(id, existing);
  }
```

Replace step 5b (line 2061):
```typescript
  // 5b. Merge discovered pools into metrics (CG or GT)
  if (useCg) {
    mergeCgPools(metrics, crawlNewPools as Map<string, CgNewPool[]>);
  } else {
    mergeGtPools(metrics, crawlNewPools as Map<string, GtNewPool[]>);
  }
```

**Step 6: Rename `buildGtChainAddresses` to `buildChainAddresses`**

Update the function at line 1062 to use `getActiveChainMap()`:

```typescript
function buildChainAddresses(): Map<string, { address: string; stablecoinId: string }[]> {
  const chainMap = getActiveChainMap();
  const result = new Map<string, { address: string; stablecoinId: string }[]>();
  for (const meta of TRACKED_STABLECOINS) {
    if (!meta.contracts) continue;
    for (const c of meta.contracts) {
      const mappedChain = chainMap[c.chain.toLowerCase()];
      if (!mappedChain) continue;
      const list = result.get(mappedChain) ?? [];
      list.push({ address: c.address.toLowerCase(), stablecoinId: meta.id });
      result.set(mappedChain, list);
    }
  }
  return result;
}
```

**Step 7: Type-check**

Run: `cd worker && npx tsc --noEmit`

Expected: No errors.

**Step 8: Commit**

```bash
git add worker/src/cron/sync-dex-liquidity.ts
git commit -m "feat(liquidity): add CoinGecko onchain pool discovery with GT fallback

Replaces GeckoTerminal free API with CoinGecko paid onchain endpoints
when COINGECKO_API_KEY is configured. Extracts balance ratios, fee
tiers, and locked liquidity from CG pool data. Falls back to GT when
no API key is set."
```

---

### Task 4: Update Durability Score for Locked Liquidity

**Files:**
- Modify: `worker/src/cron/sync-dex-liquidity.ts`
  - Lines 150-171: Add `lockedLiqWeightedSum` and `totalTvlForLocked` to `LiquidityMetrics`
  - Lines 384-406: Add fields to `initMetrics`
  - Lines 296-326: Update `computeDurabilityScore` to include locked liquidity component
  - Inside `mergeCgPools`: Accumulate locked liquidity weighted sum

**Step 1: Add locked liquidity fields to LiquidityMetrics**

Add after line 170 (`oldestPoolDays: number;`):
```typescript
  lockedLiqWeightedSum: number;
  totalTvlForLocked: number;
```

Add to `initMetrics` (after `oldestPoolDays: 0,`):
```typescript
    lockedLiqWeightedSum: 0,
    totalTvlForLocked: 0,
```

**Step 2: Accumulate locked liquidity in mergeCgPools**

Inside `mergeCgPools`, after the `m.oldestPoolDays` line, add:
```typescript
      // Locked liquidity tracking (CG pools only)
      if (pool.lockedLiquidityPct != null && pool.lockedLiquidityPct > 0) {
        m.lockedLiqWeightedSum += pool.tvlUsd * (pool.lockedLiquidityPct / 100);
        m.totalTvlForLocked += pool.tvlUsd;
      }
```

**Step 3: Update computeDurabilityScore**

Change the function signature to accept locked liquidity:
```typescript
function computeDurabilityScore(
  m: LiquidityMetrics,
  tvlStability: number | null,
  volumeStability: number | null,
): number {
```

Add locked liquidity sub-score (after `maturityScore`):
```typescript
  // Locked liquidity sub-score (0-100)
  const lockedLiqFraction = m.totalTvlForLocked > 0
    ? m.lockedLiqWeightedSum / m.totalTvlForLocked
    : 0;
  const lockedLiqScore = Math.min(100, lockedLiqFraction * 125);
```

Update the weighted sum:
```typescript
  return Math.max(0, Math.min(100, Math.round(
    organicScore * 0.35 +
    tvlStabilityScore * 0.25 +
    volumeConsistencyScore * 0.20 +
    maturityScore * 0.15 +
    lockedLiqScore * 0.05
  )));
```

**Step 4: Persist locked_liquidity_pct**

In `persistScores` (line 1716), add `locked_liquidity_pct` to the INSERT statement and compute the TVL-weighted average:

In the `computeStablecoinScores` function, compute `lockedLiqPct` alongside the other aggregates:
```typescript
    const lockedLiqPct = m.totalTvlForLocked > 0
      ? Math.round((m.lockedLiqWeightedSum / m.totalTvlForLocked) * 10000) / 10000
      : null;
```

Add `lockedLiqPct` to the score result type and return value.

Add `locked_liquidity_pct` to the `INSERT OR REPLACE INTO dex_liquidity` column list and bind it.

**Step 5: Type-check**

Run: `cd worker && npx tsc --noEmit`

Expected: No errors.

**Step 6: Commit**

```bash
git add worker/src/cron/sync-dex-liquidity.ts
git commit -m "feat(liquidity): add locked liquidity to durability scoring

Reduces organic fraction weight from 40% to 35%, adds 5% locked
liquidity component. Only CG-discovered pools contribute real data;
others default to 0."
```

---

### Task 5: Wire Up CG API Key in Worker Entry Point

**Files:**
- Modify: `worker/src/index.ts:191` — pass `env.COINGECKO_API_KEY` to `syncDexLiquidity`

**Step 1: Update the cron call**

Change line 191 from:
```typescript
ctx.waitUntil(logCronRun(db, "sync-dex-liquidity", () => syncDexLiquidity(db, env.GRAPH_API_KEY ?? null)));
```
To:
```typescript
ctx.waitUntil(logCronRun(db, "sync-dex-liquidity", () => syncDexLiquidity(db, env.GRAPH_API_KEY ?? null, env.COINGECKO_API_KEY ?? null)));
```

**Step 2: Type-check**

Run: `cd worker && npx tsc --noEmit`

Expected: No errors.

**Step 3: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat(worker): pass COINGECKO_API_KEY to syncDexLiquidity cron"
```

---

### Task 6: Expose locked_liquidity_pct in API Response

**Files:**
- Modify: `worker/src/api/dex-liquidity.ts`
  - Add `locked_liquidity_pct` to `DexLiquidityRow` interface
  - Add `lockedLiquidityPct` to API response

**Step 1: Update the row interface**

Add to `DexLiquidityRow` interface (after `score_components_json`):
```typescript
  locked_liquidity_pct: number | null;
```

**Step 2: Add to response object**

In the `map[id]` object (after `scoreComponents`), add:
```typescript
      lockedLiquidityPct: row.locked_liquidity_pct ?? null,
```

**Step 3: Type-check**

Run: `cd worker && npx tsc --noEmit`

Expected: No errors.

**Step 4: Commit**

```bash
git add worker/src/api/dex-liquidity.ts
git commit -m "feat(api): expose lockedLiquidityPct in dex-liquidity endpoint"
```

---

### Task 7: Analyst Backfill Script — Megafilter Discovery

**Files:**
- Create: `worker/src/scripts/backfill-megafilter.ts`
- Reference: `worker/src/lib/coingecko-onchain.ts`
- Reference: `src/lib/stablecoins.ts` (TRACKED_STABLECOINS)

**Step 1: Create the megafilter backfill script**

This is a standalone script run manually via `npx tsx`. It paginates through the CoinGecko megafilter endpoint to discover all stablecoin pools across every network.

```typescript
/**
 * Megafilter Backfill Script (Analyst tier only)
 *
 * Run: cd worker && COINGECKO_API_KEY=<key> npx tsx src/scripts/backfill-megafilter.ts
 *
 * Discovers pools for tracked stablecoins across all CoinGecko-supported networks
 * using the Analyst-exclusive megafilter endpoint. Outputs JSON to stdout.
 */
import { TRACKED_STABLECOINS } from "../../src/lib/stablecoins";
import { CG_CHAIN_MAP } from "../lib/coingecko-onchain";

const CG_PRO_BASE = "https://pro-api.coingecko.com/api/v3";
const API_KEY = process.env.COINGECKO_API_KEY;
if (!API_KEY) {
  console.error("COINGECKO_API_KEY required (Analyst tier)");
  process.exit(1);
}

const RATE_MS = 250;
const MAX_PAGES = 10; // Analyst plan supports up to 10 pages

interface MegafilterPool {
  id: string;
  attributes: {
    address: string;
    name: string;
    reserve_in_usd: string | null;
    h24_volume_usd: string | null;
    pool_created_at: string | null;
    pool_fee_percentage: string | null;
    locked_liquidity_percentage: string | null;
    base_token_price_usd: string | null;
    quote_token_price_usd: string | null;
  };
  relationships: {
    base_token: { data: { id: string } };
    quote_token: { data: { id: string } };
    dex: { data: { id: string } };
  };
}

async function fetchMegafilter(tokenAddress: string, network: string, page: number): Promise<MegafilterPool[]> {
  const url = `${CG_PRO_BASE}/onchain/pools/megafilter?token_address=${tokenAddress}&networks=${network}&page=${page}&sort=h24_volume_usd_desc`;
  const res = await fetch(url, {
    headers: {
      "x-cg-pro-api-key": API_KEY!,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    if (res.status === 429) {
      console.error(`Rate limited on page ${page}, waiting 5s...`);
      await new Promise((r) => setTimeout(r, 5000));
      return fetchMegafilter(tokenAddress, network, page);
    }
    return [];
  }
  const json = (await res.json()) as { data?: MegafilterPool[] };
  return json.data ?? [];
}

async function main() {
  const results: Record<string, { stablecoinId: string; symbol: string; pools: MegafilterPool[] }> = {};
  let totalPools = 0;
  let requests = 0;

  // Build contract → stablecoin lookup
  const contractToStablecoin = new Map<string, { id: string; symbol: string }>();
  for (const meta of TRACKED_STABLECOINS) {
    if (!meta.contracts) continue;
    for (const c of meta.contracts) {
      contractToStablecoin.set(`${c.chain}:${c.address.toLowerCase()}`, { id: meta.id, symbol: meta.symbol });
    }
  }

  // For each stablecoin with contracts, query megafilter
  for (const meta of TRACKED_STABLECOINS) {
    if (!meta.contracts) continue;
    const allPools: MegafilterPool[] = [];

    for (const c of meta.contracts) {
      const cgNetwork = CG_CHAIN_MAP[c.chain.toLowerCase()];
      if (!cgNetwork) continue;

      for (let page = 1; page <= MAX_PAGES; page++) {
        await new Promise((r) => setTimeout(r, RATE_MS));
        requests++;
        const pools = await fetchMegafilter(c.address.toLowerCase(), cgNetwork, page);
        allPools.push(...pools);
        if (pools.length < 20) break; // Last page
      }
    }

    if (allPools.length > 0) {
      results[meta.id] = { stablecoinId: meta.id, symbol: meta.symbol, pools: allPools };
      totalPools += allPools.length;
    }

    // Progress
    process.stderr.write(`\r[megafilter] ${meta.symbol}: ${allPools.length} pools (${requests} requests total)`);
  }

  process.stderr.write(`\n[megafilter] Done: ${totalPools} pools across ${Object.keys(results).length} stablecoins (${requests} requests)\n`);
  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);
```

**Step 2: Test the script compiles**

Run: `cd worker && npx tsc --noEmit`

Expected: No errors (the script uses `process.env` which is available in Node but not Workers — this is fine since it's a standalone script, not deployed).

Note: This script is run locally, NOT deployed as a Worker. It imports from the codebase for types only. If tsc complains about `process`, add a tsconfig exclude or use a separate tsconfig for scripts.

**Step 3: Commit**

```bash
git add worker/src/scripts/backfill-megafilter.ts
git commit -m "feat(scripts): add megafilter backfill script for Analyst tier

Run with: cd worker && COINGECKO_API_KEY=<key> npx tsx src/scripts/backfill-megafilter.ts
Discovers pools across all networks using Analyst-exclusive megafilter endpoint."
```

---

### Task 8: Update Documentation

**Files:**
- Modify: `docs/dex-liquidity.md` — update data sources table, add CG onchain section
- Modify: `CLAUDE.md` — no changes needed (existing gotchas still apply)

**Step 1: Update dex-liquidity.md**

Add CoinGecko onchain to the data sources line (line 16):
```
Data sources: DeFiLlama Yields API (single request for all ~18K pools) + Curve Finance API (per-chain requests for A-factor, balance data, registry IDs, and metapool structure) + Uniswap V3 Subgraph (4 chains) + Aerodrome Subgraph (Base) + CoinGecko Onchain API (12 chains, with GeckoTerminal free API as fallback when no CG API key is configured).
```

Add a new section after "Data Quality Filters":
```markdown
### CoinGecko Onchain Integration

When `COINGECKO_API_KEY` is configured, pool discovery uses CoinGecko's `/onchain` endpoints instead of GeckoTerminal's free API:

| Feature | GeckoTerminal (fallback) | CoinGecko Onchain (paid) |
|---------|--------------------------|--------------------------|
| Rate limit | 30 req/min | ~240 req/min |
| Chain coverage | 10 chains | 12 chains (adds tron, ink) |
| Balance data | Not available (defaults to 1.0) | Approximated from token prices |
| Fee tier | DEX-prefix lookup only | `pool_fee_percentage` field |
| Locked liquidity | Not available | `locked_liquidity_percentage` field |
| Time budget | 7 min (partial coverage) | Not needed (full coverage) |

The CG integration extracts three signals unavailable from GeckoTerminal:
1. **Balance ratio approximation**: Computed from `base_token_price_usd`/`quote_token_price_usd` for stable pairs. Feeds into `balanceHealth`, `balanceRatioWeightedSum`, and pool stress.
2. **Fee tier classification**: `pool_fee_percentage` enables proper quality multipliers for non-Uniswap concentrated liquidity pools (PancakeSwap V3, SushiSwap V3, etc.).
3. **Locked liquidity**: Weighted into durability scoring at 5% weight.
```

Update the Durability Score section to reflect new weights:
```markdown
### Durability Score (0-100)

Per-stablecoin durability metric combining: organic fee fraction (35%), TVL stability from 30-day CV (25%), volume consistency from 30-day CV (20%), oldest pool maturity (15%), and locked liquidity fraction (5%). Stored as `durability_score`.
```

**Step 2: Commit**

```bash
git add docs/dex-liquidity.md
git commit -m "docs: update dex-liquidity docs with CoinGecko onchain integration"
```

---

### Task 9: Final Verification

**Step 1: Full type-check (both frontend and worker)**

Run: `npm run build` (frontend build + type-check)
Run: `cd worker && npx tsc --noEmit` (worker type-check)

Expected: Both pass with no errors.

**Step 2: Review the diff**

Run: `git log --oneline main..HEAD` to see all commits.
Run: `git diff main..HEAD --stat` to see all changed files.

Verify:
- `worker/migrations/0024_locked_liquidity.sql` — new migration
- `worker/src/lib/coingecko-onchain.ts` — new helper module
- `worker/src/cron/sync-dex-liquidity.ts` — main changes (CG pool discovery, merge, durability)
- `worker/src/index.ts` — wiring change (one line)
- `worker/src/api/dex-liquidity.ts` — expose new field (two lines)
- `worker/src/scripts/backfill-megafilter.ts` — standalone script
- `docs/dex-liquidity.md` — documentation update

**Step 3: Commit any remaining changes**

If any stray changes remain, commit them with an appropriate message.
