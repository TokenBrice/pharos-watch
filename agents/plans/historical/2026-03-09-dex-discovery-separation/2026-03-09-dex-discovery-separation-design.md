# DEX Discovery Separation Design

**Date**: 2026-03-09
**Status**: Approved
**Methodology version**: v3.3 (staged discovery pipeline with confidence decay)

## Problem

The DEX liquidity cron (`syncDexLiquidity`, every 30 min) is monolithic: it fetches primary sources (DeFiLlama, Curve, UniV3, Aerodrome), runs optional discovery crawls (CG/GT/DexScreener/CG Tickers), scores, and persists — all in one run. The optional discovery phases share a 5-minute budget crammed at the tail end, leaving insufficient time to crawl exotic chains and the long tail of smaller stablecoins. Result: ~50-65% coverage (80-100 of 156 tracked coins).

Primary sources produce slowly-changing data (pool TVLs, A-factors, balance ratios) that doesn't need 30-minute refresh cadence, yet consumes most of the runtime budget every run.

## Solution

Split into two independent cron jobs:

| Job | Cron slot | Trigger | Purpose |
|-----|-----------|---------|---------|
| **Scoring cron** | `:10,:40` (30 min) | Existing | Primary source fetch + merge staged pools + score + persist |
| **Discovery cron** | `:03,:23,:43` (20 min) | New on existing trigger | Sequential crawl of CG/GT/DexScreener/CG Tickers to staging table |

Discovery gets ~15 min of dedicated budget (3x improvement over current 5 min), coexisting safely with blacklist + mint-burn on the 20-min slot via single sequential connections.

## Architecture

```
Discovery cron --> dex_pool_staging (D1)
                        |
Scoring cron -----------+
     |
     +-- fetches primary sources (DL, Curve, UniV3, Aerodrome)
     +-- reads staging table (pools refreshed within 24h)
     +-- merges (dedup by poolId + fingerprint, primary wins on conflict)
     +-- applies confidence decay based on staged pool age
     +-- scores (6-component composite, unchanged formula)
     +-- persists to dex_liquidity + dex_liquidity_history + dex_prices
```

## New Tables

### dex_pool_staging

```sql
CREATE TABLE dex_pool_staging (
  pool_id       TEXT NOT NULL,           -- chain:address (lowercase)
  stablecoin_id TEXT NOT NULL,           -- tracked coin this pool belongs to
  source        TEXT NOT NULL,           -- 'cg_onchain' | 'gecko_terminal' | 'dexscreener' | 'cg_tickers'
  chain         TEXT NOT NULL,
  protocol      TEXT NOT NULL,           -- normalized protocol name
  symbol        TEXT NOT NULL,           -- pool symbol (e.g. "USDC/USDT")
  tvl_usd       REAL,
  volume_24h    REAL,
  fee_tier      REAL,                    -- basis points, NULL if unknown
  balance_ratio REAL,                    -- 0-1, NULL if unavailable
  is_stable     INTEGER,                 -- 1/0/NULL
  base_token    TEXT,                    -- address of the tracked stablecoin side
  quote_token   TEXT,                    -- address of the co-token
  quote_symbol  TEXT,                    -- co-token symbol for pair quality scoring
  price_usd     REAL,                    -- DEX-implied price observation
  locked_liq_pct REAL,                   -- 0-100, NULL if unknown
  raw_json      TEXT,                    -- full source response for debugging
  discovered_at INTEGER NOT NULL,        -- first seen (epoch seconds)
  refreshed_at  INTEGER NOT NULL,        -- last updated (epoch seconds)
  PRIMARY KEY (pool_id, stablecoin_id)
);

CREATE INDEX idx_staging_coin ON dex_pool_staging(stablecoin_id);
CREATE INDEX idx_staging_refreshed ON dex_pool_staging(refreshed_at);
```

### dex_discovery_meta

```sql
CREATE TABLE dex_discovery_meta (
  stablecoin_id       TEXT PRIMARY KEY,
  consecutive_misses  INTEGER NOT NULL DEFAULT 0,
  last_crawl_at       INTEGER NOT NULL,
  last_hit_at         INTEGER           -- NULL if never found pools
);
```

### kv_config (if not exists)

```sql
CREATE TABLE IF NOT EXISTS kv_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Used to store `discovery_run_seq` (auto-incrementing run counter). Created with `IF NOT EXISTS` to be safe if the table already exists from another migration.

## Tiered Discovery Priority

Each run assigns every tracked stablecoin to a tier based on current coverage (from `dex_liquidity`) adjusted by backoff state (from `dex_discovery_meta`).

### Tier assignment

| Tier | Condition | Crawl frequency |
|------|-----------|-----------------|
| T1 | 0 pools from primary sources (score = NULL) | Every run |
| T2 | 1-4 pools, or only 1 chain | Every 3rd run |
| T3 | >=5 pools across >=2 chains | Every 10th run |

Run counter: `discovery_run_seq` integer in D1 config row, incremented each run. T2 eligible when `seq % 3 === 0`, T3 when `seq % 10 === 0`.

Within each tier, coins sorted by `last_crawl_at` ascending (most stale first).

### Exponential backoff on empty results

Prevents looping on coins with no DEX presence:

| Consecutive misses | Effective behavior |
|---|---|
| 0-2 | Normal tier frequency |
| 3-5 | Demoted to T2 cadence (every 3rd run) |
| 6-9 | Demoted to T3 cadence (every 10th run) |
| 10+ | Dormant — once per day only |

Resets instantly when any source finds >=1 pool. Tracked via `consecutive_misses` and `last_hit_at` in `dex_discovery_meta`.

### Chain-aware source routing

Before crawling a coin, read its `contracts` map from stablecoin metadata. Only query sources for chains where the coin is actually deployed. A coin on Ethereum + Arbitrum skips Solana/Base/Berachain calls entirely. Cuts wasted API calls by 60-80% for single/dual-chain coins, increasing coins serviced per run.

### Source order per coin (sequential, 1 connection)

1. CG Onchain pool search (if `COINGECKO_API_KEY` set, for chains with CG mapping)
2. GeckoTerminal pool search (for GT-only chains)
3. DexScreener token search (for chains not covered by CG/GT, or gap-filler)
4. CG Tickers (only for coins with `geckoId` that still have 0 pools after steps 1-3)

Each source writes to `dex_pool_staging` immediately after fetching (partial runs still produce value).

## Scoring Cron Changes

### Removed

- CG token batch price fetch
- GT token batch price fetch
- CG pool crawl
- GT pool crawl
- DexScreener fallback
- CG tickers fallback
- Shared 5-min optional discovery budget + all abort/timeout logic for those phases

### Added

- After primary source fetch, read `dex_pool_staging` rows where `refreshed_at >= NOW - 24h`
- Convert to `PoolEntry` format via staged pool defaults contract (see below)
- Merge into pool set using existing dedup logic (fingerprinting + `poolId`)
- Primary source wins on conflict (same `poolId` found by both DL and staging)
- Proceed with scoring as before (6-component composite, unchanged formula)

### Freshness confidence decay

Instead of binary 24h cutoff, staged pools get a continuous confidence multiplier:

```
confidence = max(0.5, 1 - ageHours / 48)
```

This multiplies into effective TVL alongside the existing quality multiplier. A pool refreshed 1h ago contributes at full weight; one refreshed 20h ago contributes at ~0.8x. Pools older than 24h are excluded entirely.

### Staged pool defaults contract

Explicit typed mapping for how missing fields are handled at the merge boundary:

| Field | Default | Rationale |
|-------|---------|-----------|
| organic_fraction | 0.5 | Neutral — no incentive data available from discovery sources |
| maturity_days | `min(daysSinceDiscovered, 30)` | Conservative estimate using `discovered_at` |
| balance_ratio | NULL (triggers neutral 1.0) | No balance data from GT/DS; CG approximation stored when available |
| is_stable | Inferred from `quoteSymbol` | USD-pegged quote tokens -> stable; WETH/WBTC -> volatile |
| quality_multiplier | Protocol lookup from `GT_DEX_QUALITY`, fee tier when available, 0.3x generic fallback | Same logic as today |
| locked_liquidity | NULL (excluded from durability locked term) | Only CG Onchain provides this |

## Methodology Versioning

**v3.3**: Separated discovery pipeline with staged pool confidence decay.

Changes from v3.2:
- Discovery sources (CG/GT/DexScreener/CG Tickers) now run on independent cron with 3x more budget
- Staged pools merged into scoring with freshness confidence decay (`max(0.5, 1 - ageHours/48)`)
- Explicit defaults contract for staged pool fields
- Chain-aware source routing reduces wasted API calls
- Tiered priority with exponential backoff on empty results

Update `shared/lib/liquidity-score-version.ts` with new version window entry.

## Discovery Cron Structure

### File layout

```
worker/src/cron/dex-discovery/
  index.ts              -- cron entry point, exports syncDexDiscovery
  orchestrator.ts       -- tier computation, coin ordering, budget loop
  crawl-sources.ts      -- per-coin crawl logic (CG/GT/DS/tickers)
  persistence.ts        -- staging table + meta table upserts, cleanup
  types.ts              -- StagedPool, DiscoveryMeta interfaces
```

Fetch logic extracted from existing `dex-liquidity/fetch-crawlers.ts` and `dex-liquidity/fetch-fallbacks.ts` — adapted to write to staging instead of returning in-memory arrays.

### Runtime behavior

**Startup** (~1 sec):
1. Read `dex_liquidity` for current pool counts per coin
2. Read `dex_discovery_meta` for backoff state per coin
3. Read + increment `discovery_run_seq` from D1 config
4. Compute effective tier per coin (base tier adjusted by backoff)
5. Filter to coins eligible this run (tier + modulo check)
6. Sort by `last_crawl_at` ascending (most stale first)

**Crawl** (~14 min budget):
- Walk sorted coin list sequentially
- Per coin: CG Onchain -> GT -> DexScreener -> CG Tickers (chain-aware routing)
- Upsert results to `dex_pool_staging` + update `dex_discovery_meta` after each coin
- Check wall-clock budget after each coin — exit cleanly if exhausted

**Cleanup** (~1 sec):
- Delete `dex_pool_staging` rows where `refreshed_at < NOW - 48h`
- Delete `raw_json` from rows where `refreshed_at < NOW - 6h`
- Return `CronResult` with status, coins crawled, pools discovered/refreshed counts

## Error Handling

- Discovery cron returns `CronResult`: `ok` / `degraded` / error
- `degraded` if any source family (CG/GT/DS) fails entirely but others succeed
- Individual coin crawl failures caught and logged, don't abort the run
- Scoring cron: if staging table read fails (D1 error), falls back to primary-sources-only (no regression from current behavior)

## 20-min Slot Connection Budget

Discovery coexists with blacklist + mint-burn on the 20-min trigger. All three run via `ctx.waitUntil()` sharing the 6-connection pool:

- blacklist: 2-3 connections (Etherscan + chain RPC + TronGrid)
- mint-burn: 1-2 connections (Alchemy JSON-RPC)
- discovery: 1 connection (sequential, rate-limited)
- Total worst case: 6 — within budget

After blacklist/mint-burn finish (~8 min), discovery has all connections (though it only needs 1).

## Migration Strategy

1. Add `dex_pool_staging` + `dex_discovery_meta` tables (new D1 migration)
2. Deploy discovery cron on 20-min trigger — verify it populates staging
3. Update scoring cron to read staging table + apply confidence decay (additive)
4. Strip optional discovery phases from scoring cron
5. Register methodology v3.3 in `shared/lib/liquidity-score-version.ts`

Steps 3-4 can ship together. Step 2 can run independently first for a burn-in period.

## Testing

- Unit: tier computation logic (backoff thresholds, modulo gating, reset on hit)
- Unit: staging -> PoolEntry conversion with defaults contract
- Unit: confidence decay function
- Unit: merge/dedup of staged pools with primary pools
- Integration: scoring cron produces identical scores when staging table is empty (no regression)
- Monitor: compare pool coverage counts before/after over several days

## Documentation Updates

- `docs/dex-liquidity.md` — new architecture, staging table, discovery cron, v3.3 changes
- `docs/worker-infrastructure.md` — updated cron schedule (20-min slot now has 3 jobs)
- `docs/data-flow-map.md` — new discovery -> staging -> scoring flow
- `docs/methodology-page.md` — v3.3 entry in methodology changelog
