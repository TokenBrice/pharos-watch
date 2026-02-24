# GeckoTerminal Liquidity Enrichment — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace DexScreener with GeckoTerminal as a gap-filling DEX data source, adding broader pool coverage and price observations across 200+ chains.

**Architecture:** GT runs after existing sources (DeFiLlama, Curve, UniV3, Aerodrome) in `syncDexLiquidity()`. It crawls token pools per chain, deduplicates against known pool addresses, adds new pools with DEX-ID-based quality multipliers, and extracts price observations from all non-Curve pools. Rate-limited to 30 req/min (free tier), spread over ~9 minutes of the 15-min cron window.

**Tech Stack:** Cloudflare Worker (TypeScript), GeckoTerminal REST API v2, existing `fetchWithRetry` helper.

**Design doc:** `docs/plans/2026-02-24-geckoterminal-liquidity-design.md`

---

### Task 1: Add GT Constants, Types, and Chain Mapping

**Files:**
- Modify: `worker/src/cron/sync-dex-liquidity.ts:1-65` (constants section)

**Step 1: Add GT constants after the existing constants block (after line 65)**

After the `QUALITY_MULTIPLIERS` constant, add:

```typescript
// GeckoTerminal API
const GT_API_BASE = "https://api.geckoterminal.com/api/v2";
const GT_RATE_LIMIT_MS = 2000; // 30 req/min = 1 every 2s
const GT_BACKOFF_MS = 65_000;  // Back off 65s on 429

/** Map our chain names (from stablecoins.ts contracts) to GT network IDs */
const GT_CHAIN_MAP: Record<string, string> = {
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
};

/** Reverse map: GT network ID → our chain name */
const GT_CHAIN_REVERSE: Record<string, string> = Object.fromEntries(
  Object.entries(GT_CHAIN_MAP).map(([k, v]) => [v, k])
);

/** Quality multipliers for GT-only pools, keyed by DEX ID prefix */
const GT_DEX_QUALITY: [string, number][] = [
  ["balancer", 0.7],
  ["velodrome", 0.7],
  ["pancakeswap-v3", 0.5],
  ["trader-joe", 0.5],
  ["sushiswap-v3", 0.5],
  ["camelot-v3", 0.5],
  ["maverick", 0.5],
  ["ambient", 0.5],
  ["pancakeswap-v2", 0.3],
  ["sushiswap", 0.3],
];
```

**Step 2: Add GT response types after the existing `DexPriceObs` interface (after line 166)**

```typescript
// GeckoTerminal response types
interface GtPoolAttributes {
  address: string;
  name: string;
  pool_created_at: string | null;
  base_token_price_usd: string | null;
  quote_token_price_usd: string | null;
  reserve_in_usd: string | null;
  volume_usd: { h24: string | null } | null;
}

interface GtPool {
  id: string;
  type: string;
  attributes: GtPoolAttributes;
  relationships: {
    base_token: { data: { id: string; type: string } };
    quote_token: { data: { id: string; type: string } };
    dex: { data: { id: string; type: string } };
  };
}

interface GtTokenAttributes {
  address: string;
  name: string;
  symbol: string;
  coingecko_coin_id: string | null;
  price_usd: string | null;
  total_reserve_in_usd: string | null;
  volume_usd: { h24: string | null } | null;
}

interface GtToken {
  id: string;
  type: string;
  attributes: GtTokenAttributes;
}
```

**Step 3: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS (new types and constants are unused but valid)

**Step 4: Commit**

```bash
git add worker/src/cron/sync-dex-liquidity.ts
git commit -m "feat(liquidity): add GeckoTerminal constants, types, and chain mapping"
```

---

### Task 2: Add GT Quality Multiplier Helper

**Files:**
- Modify: `worker/src/cron/sync-dex-liquidity.ts` (after the existing `getQualityMultiplier` function at line 201)

**Step 1: Add the GT DEX quality resolver function**

After the `getQualityMultiplier` function (line 201), add:

```typescript
/** Resolve quality multiplier for a GeckoTerminal pool based on DEX ID */
function getGtDexQuality(dexId: string): number {
  for (const [prefix, quality] of GT_DEX_QUALITY) {
    if (dexId.startsWith(prefix)) return quality;
  }
  return QUALITY_MULTIPLIERS["generic"]!;
}
```

**Step 2: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add worker/src/cron/sync-dex-liquidity.ts
git commit -m "feat(liquidity): add GT DEX quality multiplier resolver"
```

---

### Task 3: Build Known Pool Addresses Set

The known pool address set must be populated from all existing sources BEFORE the GT crawl runs. This requires modifying `processPoolMetrics` to also return the set, or building it separately.

**Files:**
- Modify: `worker/src/cron/sync-dex-liquidity.ts` — add `buildKnownPoolAddresses` function

**Step 1: Add function after `buildChainAddressMap` (around line 937)**

This function collects pool addresses from DeFiLlama pools, Curve pools, UniV3 pools, and Aerodrome pools into a single `Set<string>` keyed by `{chain}:{address}` (lowercase).

```typescript
/** Collect all pool addresses from existing sources for dedup against GT */
function buildKnownPoolAddresses(
  pools: LlamaPool[],
  dexProjects: Set<string>,
  curvePoolMap: Map<string, CurvePoolEntry>,
  uniV3PoolFees: Map<string, number>,
  aerodromeIsStable: Map<string, boolean>,
): Set<string> {
  const known = new Set<string>();

  // DeFiLlama pools (all matched DEX pools)
  for (const pool of pools) {
    if (!pool.tvlUsd || pool.tvlUsd < 10_000) continue;
    if (!dexProjects.has(pool.project)) continue;
    if (pool.exposure === "single") continue;
    const key = `${pool.chain.toLowerCase()}:${pool.pool.toLowerCase()}`;
    known.add(key);
  }

  // Curve pools (keyed as chain:address in the map)
  for (const key of curvePoolMap.keys()) {
    // curvePoolMap keys are "chain:address" or "chain:SYMBOL-COMBO"
    // Only keep address-based keys (those containing 0x)
    if (key.includes("0x")) known.add(key);
  }

  // UniV3 pools (keyed as chain:address in the fees map)
  for (const key of uniV3PoolFees.keys()) {
    known.add(key);
  }

  // Aerodrome pools (keyed as chain:address in the isStable map)
  for (const key of aerodromeIsStable.keys()) {
    known.add(key);
  }

  console.log(`[dex-liquidity] Built known pool set: ${known.size} pool addresses from existing sources`);
  return known;
}
```

**Step 2: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add worker/src/cron/sync-dex-liquidity.ts
git commit -m "feat(liquidity): build known pool addresses set for GT dedup"
```

---

### Task 4: Implement GT Token Batch Fetch

Fetches token-level aggregate data via `/networks/{chain}/tokens/multi/{addresses}`. This is Phase 1 of the GT crawl (~10 requests, fast).

**Files:**
- Modify: `worker/src/cron/sync-dex-liquidity.ts` — add `fetchGtTokenBatch` function

**Step 1: Add function after the `buildKnownPoolAddresses` function**

```typescript
/** Build chain → addresses map from TRACKED_STABLECOINS contracts, filtered to GT-supported chains */
function buildGtChainAddresses(): Map<string, { address: string; stablecoinId: string }[]> {
  const result = new Map<string, { address: string; stablecoinId: string }[]>();
  for (const meta of TRACKED_STABLECOINS) {
    if (!meta.contracts) continue;
    for (const c of meta.contracts) {
      const gtChain = GT_CHAIN_MAP[c.chain.toLowerCase()];
      if (!gtChain) continue;
      const list = result.get(gtChain) ?? [];
      list.push({ address: c.address.toLowerCase(), stablecoinId: meta.id });
      result.set(gtChain, list);
    }
  }
  return result;
}

/** Fetch token-level aggregate data from GT multi-token endpoint.
 *  Returns price observations (one per token per chain). */
async function fetchGtTokenBatch(
  addressToId: Map<string, string>,
): Promise<Map<string, DexPriceObs[]>> {
  const priceObs = new Map<string, DexPriceObs[]>();
  const chainAddresses = buildGtChainAddresses();
  let requestCount = 0;

  for (const [gtChain, tokens] of chainAddresses) {
    const ourChain = GT_CHAIN_REVERSE[gtChain] ?? gtChain;

    // Batch into groups of 30 (GT limit for multi endpoint)
    for (let i = 0; i < tokens.length; i += 30) {
      const batch = tokens.slice(i, i + 30);
      const addresses = batch.map((t) => t.address).join(",");

      if (requestCount > 0) {
        await new Promise((r) => setTimeout(r, GT_RATE_LIMIT_MS));
      }
      requestCount++;

      try {
        const url = `${GT_API_BASE}/networks/${gtChain}/tokens/multi/${addresses}`;
        const res = await fetchWithRetry(url, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        });
        if (!res?.ok) {
          if (res?.status === 429) {
            console.warn(`[dex-liquidity] GT token batch rate-limited, backing off`);
            await new Promise((r) => setTimeout(r, GT_BACKOFF_MS));
          }
          continue;
        }

        const json = (await res.json()) as { data?: GtToken[] };
        if (!json.data) continue;

        for (const token of json.data) {
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
          obs.push({ price, tvl, chain: ourChain, protocol: "geckoterminal-aggregate" });
          priceObs.set(stablecoinId, obs);
        }
      } catch (err) {
        console.warn(`[dex-liquidity] GT token batch error for ${gtChain}:`, err);
      }
    }
  }

  console.log(`[dex-liquidity] GT token batch: ${priceObs.size} coins with price obs (${requestCount} requests)`);
  return priceObs;
}
```

**Step 2: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add worker/src/cron/sync-dex-liquidity.ts
git commit -m "feat(liquidity): implement GT token-level batch fetch"
```

---

### Task 5: Implement GT Pool Crawl with Dedup

This is the core function — Phase 2 of the GT crawl. Fetches pools per token per chain, deduplicates against known pools, and produces both new pool metrics and price observations.

**Files:**
- Modify: `worker/src/cron/sync-dex-liquidity.ts` — add `fetchGtPools` function

**Step 1: Add the main GT pool crawl function**

```typescript
/** Result of GT pool crawl: new pools to merge into metrics + price observations */
interface GtCrawlResult {
  /** New pools not found in existing sources, keyed by stablecoinId */
  newPools: Map<string, GtNewPool[]>;
  /** Price observations from all non-Curve GT pools */
  priceObs: Map<string, DexPriceObs[]>;
  /** Stats for logging */
  stats: { requests: number; poolsSeen: number; poolsNew: number; poolsSkippedCurve: number; poolsSkippedKnown: number };
}

interface GtNewPool {
  address: string;
  chain: string;
  dexId: string;
  name: string;
  tvlUsd: number;
  volume24hUsd: number;
  qualityMultiplier: number;
  maturityDays: number;
  poolType: string;
  /** The stablecoin's price in this pool */
  price: number;
  /** Pool symbol (e.g., "USDC / USDT") */
  symbol: string;
}

/** Crawl GT pools for all tracked stablecoins, dedup against known pools.
 *  Returns new pool data and price observations. */
async function fetchGtPools(
  addressToId: Map<string, string>,
  knownPoolAddrs: Set<string>,
): Promise<GtCrawlResult> {
  const newPools = new Map<string, GtNewPool[]>();
  const priceObs = new Map<string, DexPriceObs[]>();
  const stats = { requests: 0, poolsSeen: 0, poolsNew: 0, poolsSkippedCurve: 0, poolsSkippedKnown: 0 };
  const chainAddresses = buildGtChainAddresses();
  const nowSec = Date.now() / 1000;

  for (const [gtChain, tokens] of chainAddresses) {
    const ourChain = GT_CHAIN_REVERSE[gtChain] ?? gtChain;

    for (const { address, stablecoinId } of tokens) {
      if (stats.requests > 0) {
        await new Promise((r) => setTimeout(r, GT_RATE_LIMIT_MS));
      }
      stats.requests++;

      try {
        const url = `${GT_API_BASE}/networks/${gtChain}/tokens/${address}/pools?page=1`;
        const res = await fetchWithRetry(url, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        });

        if (!res?.ok) {
          if (res?.status === 429) {
            console.warn(`[dex-liquidity] GT pool crawl rate-limited at request ${stats.requests}, backing off`);
            await new Promise((r) => setTimeout(r, GT_BACKOFF_MS));
          }
          continue;
        }

        const json = (await res.json()) as { data?: GtPool[] };
        if (!json.data) continue;

        for (const pool of json.data) {
          stats.poolsSeen++;
          const a = pool.attributes;
          const dexId = pool.relationships.dex.data.id;
          const poolAddr = a.address.toLowerCase();
          const tvl = parseFloat(a.reserve_in_usd ?? "");
          if (!tvl || tvl < 10_000) continue; // Skip dust

          // Rule 1: Skip Curve pools entirely
          if (dexId.startsWith("curve")) {
            stats.poolsSkippedCurve++;
            continue;
          }

          // Resolve which token in this pool is our stablecoin
          // GT pool relationship IDs are formatted as "{network}_{address}"
          const baseAddr = pool.relationships.base_token.data.id.split("_").pop()?.toLowerCase() ?? "";
          const quoteAddr = pool.relationships.quote_token.data.id.split("_").pop()?.toLowerCase() ?? "";
          const isBase = baseAddr === address;
          const isQuote = quoteAddr === address;
          if (!isBase && !isQuote) {
            // Neither token matches — try addressToId
            const baseId = addressToId.get(baseAddr);
            const quoteId = addressToId.get(quoteAddr);
            if (baseId !== stablecoinId && quoteId !== stablecoinId) continue;
          }

          // Extract price for our stablecoin
          const priceStr = isBase ? a.base_token_price_usd : a.quote_token_price_usd;
          const price = parseFloat(priceStr ?? "");

          // Price observation (from ALL non-Curve pools, even known ones)
          if (price > 0 && price >= 0.5 && price <= 2.0 && tvl >= 50_000) {
            const obs = priceObs.get(stablecoinId) ?? [];
            obs.push({ price, tvl, chain: ourChain, protocol: dexId });
            priceObs.set(stablecoinId, obs);
          }

          // Rule 2: Skip TVL/volume for known pools
          const poolKey = `${ourChain}:${poolAddr}`;
          if (knownPoolAddrs.has(poolKey)) {
            stats.poolsSkippedKnown++;
            continue;
          }

          // Rule 3: New pool — add with GT quality
          const vol24h = parseFloat(a.volume_usd?.h24 ?? "0");
          const qualMult = getGtDexQuality(dexId);

          let maturityDays = 0;
          if (a.pool_created_at) {
            const createdSec = new Date(a.pool_created_at).getTime() / 1000;
            if (createdSec > 0) {
              maturityDays = Math.floor((nowSec - createdSec) / 86400);
            }
          }

          // Classify pool type for display
          const poolType = dexId.includes("v3") || dexId.includes("v4")
            ? "concentrated" : dexId.includes("stable") ? "stable-amm" : "amm";

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
            poolType: `gt-${poolType}`,
            price,
            symbol: a.name, // GT pool name is like "USDC / USDT"
          });
          newPools.set(stablecoinId, pools);
          stats.poolsNew++;
        }
      } catch (err) {
        console.warn(`[dex-liquidity] GT pool crawl error for ${ourChain}:${address}:`, err);
      }
    }
  }

  console.log(
    `[dex-liquidity] GT pool crawl: ${stats.requests} requests, ${stats.poolsSeen} pools seen, ` +
    `${stats.poolsNew} new, ${stats.poolsSkippedCurve} skipped (Curve), ${stats.poolsSkippedKnown} skipped (known)`
  );
  return { newPools, priceObs, stats };
}
```

**Step 2: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add worker/src/cron/sync-dex-liquidity.ts
git commit -m "feat(liquidity): implement GT pool crawl with dedup and price extraction"
```

---

### Task 6: Implement GT Pool Merge Into LiquidityMetrics

New GT pools need to be merged into the existing `LiquidityMetrics` map produced by `processPoolMetrics`. This function runs after both `processPoolMetrics` and `fetchGtPools`.

**Files:**
- Modify: `worker/src/cron/sync-dex-liquidity.ts` — add `mergeGtPools` function

**Step 1: Add the merge function**

```typescript
/** Merge GT-discovered new pools into existing LiquidityMetrics. */
function mergeGtPools(
  metrics: Map<string, LiquidityMetrics>,
  gtNewPools: Map<string, GtNewPool[]>,
): void {
  let merged = 0;

  for (const [stablecoinId, pools] of gtNewPools) {
    const meta = TRACKED_STABLECOINS.find((s) => s.id === stablecoinId);
    if (!meta) continue;

    let m = metrics.get(stablecoinId);
    if (!m) {
      m = initMetrics(stablecoinId, meta.symbol);
      metrics.set(stablecoinId, m);
    }

    for (const pool of pools) {
      const effectiveTvl = pool.tvlUsd * pool.qualityMultiplier;
      const organicFraction = 0.5; // neutral default for GT pools
      const balanceRatio = 1.0;    // no balance data from GT
      const coinPairQuality = computePoolPairQuality(
        pool.symbol.split(/\s*\/\s*/).map((s) => s.trim()),
        meta.symbol,
      );
      const combinedQuality = pool.qualityMultiplier * coinPairQuality;
      const poolEffTvl = pool.tvlUsd * combinedQuality;
      const stressIdx = computePoolStress(balanceRatio, organicFraction, pool.maturityDays, coinPairQuality);

      m.totalTvlUsd += pool.tvlUsd;
      m.totalVolume24hUsd += pool.volume24hUsd;
      m.poolCount++;
      m.chains.add(pool.chain);
      m.pairs.add(pool.symbol);
      m.qualityAdjustedTvl += pool.tvlUsd * pool.qualityMultiplier;
      m.effectiveTvl += poolEffTvl;
      m.stressWeightedSum += pool.tvlUsd * stressIdx;
      m.oldestPoolDays = Math.max(m.oldestPoolDays, pool.maturityDays);

      // Protocol and chain TVL
      const protocol = pool.dexId.split("-").slice(0, -1).join("-") || pool.dexId; // strip chain suffix
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
    console.log(`[dex-liquidity] Merged ${merged} GT pools into ${gtNewPools.size} stablecoins`);
  }
}
```

**Step 2: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add worker/src/cron/sync-dex-liquidity.ts
git commit -m "feat(liquidity): merge GT pools into LiquidityMetrics"
```

---

### Task 7: Wire GT Into the Pipeline and Remove DexScreener

This is the integration task — modifying `syncDexLiquidity()` to call the new GT functions and remove DexScreener.

**Files:**
- Modify: `worker/src/cron/sync-dex-liquidity.ts` — `syncDexLiquidity` function (lines 1620-1701)

**Step 1: Remove DexScreener code**

Delete the `DEXSCREENER_CHAINS` constant, the `DexScreenerTokenPair` interface, the `fetchDexScreenerPriceObs` function, and the `buildChainAddressMap` function (lines 919-1024). These are fully replaced by GT.

**Step 2: Update the orchestrator**

Replace the orchestrator function `syncDexLiquidity` (starting at line 1620) with this updated version. The key changes are:

1. Remove the DexScreener call (step 4c)
2. Add known pool address set construction (new step 4c)
3. Add GT token batch call (new step 4d)
4. Add GT pool crawl call (new step 4e)
5. Merge GT price observations into the main priceObservations map
6. After `processPoolMetrics`, merge GT new pools before score computation

The updated orchestrator:

```typescript
export async function syncDexLiquidity(db: D1Database, graphApiKey: string | null): Promise<void> {
  console.log("[dex-liquidity] Starting sync");

  // 1. Fetch all external data sources
  const dataSources = await fetchDataSources(graphApiKey);
  if (!dataSources) return;

  // 2. Build symbol/address lookup maps
  const { symbolToIds, addressToId } = buildSymbolLookups();

  // 3. Parse Curve data into pool lookups and price observations
  const { curvePoolMap, priceObservations } = await buildCurveLookups(
    dataSources.curveResponses, symbolToIds, addressToId,
  );

  // 4. Fetch Uniswap V3 subgraph data for fee tier enrichment + price observations
  const { uniV3PoolFees, uniV3SymbolFees, uniV3PriceObs } = await fetchUniV3Data(
    graphApiKey, symbolToIds, addressToId,
  );
  if (addressToId.size > 0) {
    console.log(`[dex-liquidity] Learned ${addressToId.size} token addresses for disambiguation`);
  }

  // 4b. Fetch Aerodrome subgraph data for price observations + pool stability flags
  let aerodromePriceObs = new Map<string, DexPriceObs[]>();
  let aerodromeIsStable = new Map<string, boolean>();
  try {
    const aeroData = await fetchAerodromeData(graphApiKey, symbolToIds, addressToId);
    aerodromePriceObs = aeroData.aerodromePriceObs;
    aerodromeIsStable = aeroData.aerodromeIsStable;
  } catch (err) {
    console.warn("[dex-liquidity] Aerodrome fetch failed (non-fatal):", err);
  }

  // 4c. Build known pool address set from existing sources (for GT dedup)
  const knownPoolAddrs = buildKnownPoolAddresses(
    dataSources.pools, dataSources.dexProjects,
    curvePoolMap, uniV3PoolFees, aerodromeIsStable,
  );

  // 4d. GeckoTerminal token-level batch (fast, ~10 requests)
  let gtTokenPriceObs = new Map<string, DexPriceObs[]>();
  try {
    gtTokenPriceObs = await fetchGtTokenBatch(addressToId);
  } catch (err) {
    console.warn("[dex-liquidity] GeckoTerminal token batch failed (non-fatal):", err);
  }

  // 4e. GeckoTerminal pool crawl (slow, ~250 requests spread over ~8 min)
  let gtCrawlResult: GtCrawlResult = {
    newPools: new Map(), priceObs: new Map(),
    stats: { requests: 0, poolsSeen: 0, poolsNew: 0, poolsSkippedCurve: 0, poolsSkippedKnown: 0 },
  };
  try {
    gtCrawlResult = await fetchGtPools(addressToId, knownPoolAddrs);
  } catch (err) {
    console.warn("[dex-liquidity] GeckoTerminal pool crawl failed (non-fatal):", err);
  }

  // Merge all price observations into a single map
  for (const [id, obs] of uniV3PriceObs) {
    const existing = priceObservations.get(id) ?? [];
    existing.push(...obs);
    priceObservations.set(id, existing);
  }
  for (const [id, obs] of aerodromePriceObs) {
    const existing = priceObservations.get(id) ?? [];
    existing.push(...obs);
    priceObservations.set(id, existing);
  }
  for (const [id, obs] of gtTokenPriceObs) {
    const existing = priceObservations.get(id) ?? [];
    existing.push(...obs);
    priceObservations.set(id, existing);
  }
  for (const [id, obs] of gtCrawlResult.priceObs) {
    const existing = priceObservations.get(id) ?? [];
    existing.push(...obs);
    priceObservations.set(id, existing);
  }
  console.log(`[dex-liquidity] Total: ${priceObservations.size} coins with price observations across all sources`);

  // 5. Match pools to stablecoins and compute per-pool metrics
  const metrics = processPoolMetrics(
    dataSources.pools, dataSources.dexProjects, symbolToIds, addressToId,
    curvePoolMap, uniV3PoolFees, uniV3SymbolFees,
  );

  // 5b. Merge GT new pools into metrics
  mergeGtPools(metrics, gtCrawlResult.newPools);

  // 6. Compute composite scores per stablecoin
  const scoreResults = await computeStablecoinScores(db, metrics);

  // 7. Persist scores to D1
  const nowSec = Math.floor(Date.now() / 1000);
  await persistScores(db, metrics, scoreResults, nowSec);

  // 8. Write daily historical snapshots
  await writeHistoricalSnapshots(db, scoreResults);

  // 9. Compute and persist depth stability from 30-day history
  await computeDepthStability(db);

  // 10. Compute and persist DEX-implied prices from ALL observations
  await computeDexPrices(db, priceObservations, nowSec);
}
```

**Step 3: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add worker/src/cron/sync-dex-liquidity.ts
git commit -m "feat(liquidity): wire GT into pipeline, remove DexScreener

Replace DexScreener with GeckoTerminal for price observations and
gap-filling pool coverage. GT runs after existing sources, deduplicates
by pool address, and skips Curve pools entirely."
```

---

### Task 8: Full Build Verification

**Files:** None (verification only)

**Step 1: Worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS with no errors

**Step 2: Frontend build (ensures shared types still work)**

Run: `npm run build`
Expected: PASS — frontend imports `src/lib/stablecoins.ts` and `src/lib/types.ts` which are unchanged

**Step 3: Verify no references to DexScreener remain**

Run: `grep -r "dexscreener\|DexScreener\|dex_screener\|DEXSCREENER" worker/src/ --include="*.ts"`
Expected: No matches (all DexScreener code removed)

**Step 4: Verify GT integration points**

Run: `grep -n "GeckoTerminal\|geckoterminal\|GT_API_BASE\|fetchGtPools\|fetchGtTokenBatch\|mergeGtPools\|buildKnownPoolAddresses\|getGtDexQuality" worker/src/cron/sync-dex-liquidity.ts | head -30`
Expected: All new functions and constants are present

**Step 5: Commit (if any fixes were needed)**

If type-check or build revealed issues, fix and commit:
```bash
git add worker/src/cron/sync-dex-liquidity.ts
git commit -m "fix(liquidity): resolve build issues from GT integration"
```
