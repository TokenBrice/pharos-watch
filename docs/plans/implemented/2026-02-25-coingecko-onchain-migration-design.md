# CoinGecko Onchain Migration — Design Document

**Date:** 2026-02-25
**Context:** Upgrading from GeckoTerminal free API to CoinGecko Paid Onchain API for liquidity scoring. Currently on Analyst tier (one month), downgrading to Basic tier.

## Problem

The current liquidity scoring system uses the GeckoTerminal free API (`api.geckoterminal.com/api/v2`) for fallback pool discovery and price observations. This has several limitations:

1. **Rate-limited**: 30 req/min with a 7-minute time budget → covers ~210 of ~252 token-chain combos per run
2. **Shuffle-dependent coverage**: Fisher-Yates shuffle means any given coin may miss GT data for multiple cycles
3. **Missing balance data**: GT-discovered pools default to `balanceRatio=1.0`, missing imbalance signals
4. **No fee tier data**: Non-Uni-V3 concentrated liquidity pools get generic quality multipliers
5. **Limited chain coverage**: Only 10 chains mapped; tron (4 contracts) and ink (1 contract) excluded
6. **No locked liquidity signal**: Available in CoinGecko onchain API but not captured

## Approach

**Incremental migration** — replace GeckoTerminal with CoinGecko onchain endpoints inside the existing `syncDexLiquidity()` cron. Keep GT as fallback when no CoinGecko API key is configured. Separate manual backfill script for Analyst-exclusive endpoints.

## Architecture

### 1. CoinGecko Onchain Helper Module

**New file:** `worker/src/lib/coingecko-onchain.ts`

Wraps `/onchain` endpoints using the existing `cgUrl()`/`cgHeaders()` helpers from `coingecko.ts`. The onchain endpoints live under the same pro-api base URL.

```typescript
// URL construction: cgUrl("/onchain/networks/{net}/tokens/{addr}/pools")
// Headers: cgHeaders() (includes x-cg-pro-api-key)
// Rate limiter: configurable delay, default ~250ms (240 req/min, leaving headroom)

export function isOnchainAvailable(): boolean;  // true if CG API key is configured
export async function fetchCgTokensBatch(network: string, addresses: string[]): Promise<CgToken[]>;
export async function fetchCgTokenPools(network: string, address: string): Promise<CgPool[]>;
export async function fetchMegafilterPools(filters: MegafilterParams): Promise<CgPool[]>;  // Analyst only
```

**CoinGecko Onchain Network ID Map** (expands from 10 to 12):

| Our Chain | CG Network ID | Status |
|-----------|---------------|--------|
| ethereum | `eth` | existing |
| base | `base` | existing |
| arbitrum | `arbitrum` | existing |
| polygon | `polygon_pos` | existing |
| bsc | `bsc` | existing |
| avalanche | `avax` | existing |
| optimism | `optimism` | existing |
| celo | `celo` | existing |
| gnosis | `xdai` | existing |
| fantom | `ftm` | existing |
| tron | `tron` | **new** |
| ink | `ink` | **new** |

### 2. Pool Discovery Migration

Replace `fetchGtTokenBatch()` and `fetchGtPools()` in `sync-dex-liquidity.ts`:

**Token batch** (`fetchGtTokenBatch` → CG equivalent):
- Endpoint: `GET /onchain/networks/{net}/tokens/multi/{addrs}`
- Batch size: 30 addresses per request (same as GT)
- Rate: ~240 req/min (vs 30 on GT free) → 8x faster

**Pool crawl** (`fetchGtPools` → CG equivalent):
- Endpoint: `GET /onchain/networks/{net}/tokens/{addr}/pools?include=base_token,quote_token`
- No time budget needed — all ~252 token-chain combos complete in ~1-2 min
- No shuffle needed — deterministic order, full coverage every cycle
- Extracts new fields: `base_token_balance`, `quote_token_balance`, `pool_fee_percentage`, `locked_liquidity_percentage`

**Fallback**: If `!isOnchainAvailable()`, call existing GT functions unchanged. The GT code stays in `sync-dex-liquidity.ts` behind the feature check.

### 3. Enhanced Pool Quality Signals

#### Balance Ratio (from `base_token_balance` / `quote_token_balance`)

Currently only Curve pools contribute to `balanceRatioWeightedSum`. With CG onchain data, we compute balance ratios for all discovered pools:

```typescript
// For CG-discovered 2-token pools:
const baseUsd = parseFloat(pool.base_token_balance) * parseFloat(pool.base_token_price_usd);
const quoteUsd = parseFloat(pool.quote_token_balance) * parseFloat(pool.quote_token_price_usd);
const balanceRatio = Math.min(baseUsd, quoteUsd) / Math.max(baseUsd, quoteUsd);
```

This feeds into `balanceHealth`, `balanceRatioWeightedSum`, and pool stress calculations — all previously defaulting to 1.0 for non-Curve pools.

#### Fee Tier Classification (from `pool_fee_percentage`)

Replace coarse `GT_DEX_QUALITY` lookups for pools that report a fee percentage:

| Fee % | Pool Type | Multiplier |
|-------|-----------|-----------|
| ≤ 0.01% | 1bp tier | 1.1x |
| ≤ 0.05% | 5bp tier | 0.85x |
| ≤ 0.30% | 30bp tier | 0.4x |
| > 0.30% | wide tier | 0.3x |

Falls back to existing `GT_DEX_QUALITY` DEX-prefix lookup when fee is not reported.

#### Locked Liquidity (from `locked_liquidity_percentage`)

New field stored per-pool. Aggregated as TVL-weighted average per stablecoin. Feeds into durability scoring.

### 4. Durability Score Update

Add locked liquidity as a factor, reducing organic fraction weight slightly:

| Component | Current Weight | New Weight |
|-----------|---------------|------------|
| Organic fraction | 40% | 35% |
| TVL stability | 25% | 25% |
| Volume consistency | 20% | 20% |
| Pool maturity | 15% | 15% |
| Locked liquidity | — | 5% |

Conservative 5% weighting since locked liquidity data is only available for CG-discovered pools initially.

### 5. Schema Changes

**Migration 0015** (one new column):
```sql
ALTER TABLE dex_liquidity ADD COLUMN locked_liquidity_pct REAL;
```

No other schema changes — existing columns accommodate the richer data from CG pools.

### 6. Analyst Backfill Script

**New file:** `worker/src/scripts/backfill-coingecko.ts`

Run manually while Analyst tier is active. Two phases:

**Phase 1 — Megafilter Discovery:**
- Paginate `/onchain/pools/megafilter` filtering by each tracked stablecoin's contract addresses
- Discover pools not found by normal per-token crawl (different networks, smaller pools)
- Output discovered pools to stdout/JSON for review
- Optionally merge into D1 via a liquidity sync trigger

**Phase 2 — Token OHLCV History Backfill:**
- For each tracked stablecoin with contracts, fetch `/onchain/networks/{net}/tokens/{addr}/ohlcv/day`
- Backfill `dex_liquidity_history` rows for dates missing in the last 90 days
- Improves durability scoring for recently added stablecoins

### 7. Wire-up Changes

In `worker/src/index.ts`:
- Pass `COINGECKO_API_KEY` (already available via `env.COINGECKO_API_KEY`) to `syncDexLiquidity()` as a new parameter
- The cron signature changes from `syncDexLiquidity(db, graphApiKey)` to `syncDexLiquidity(db, graphApiKey, cgApiKey)`

### 8. API & Frontend

No API or frontend changes needed. The existing `/api/dex-liquidity` endpoint already serves all the fields we're enriching (`weighted_balance_ratio`, `durability_score`, `avg_pool_stress`, etc.). The new `locked_liquidity_pct` column can be exposed in a future PR if we want to display it.

## Out of Scope

- Replacing DeFiLlama Yields, Curve API, or Subgraph integrations (they provide superior data for their domains)
- WebSocket real-time streaming (unnecessary for 20-min cron cycle)
- CoinGecko onchain categories or trending endpoints
- Frontend changes to display locked liquidity (can be done later)

## Risks

- **CG onchain rate limits unclear for Basic tier**: Documentation doesn't specify exact numbers. We use conservative 240 req/min. If throttled, the time budget fallback mechanism can be reinstated.
- **CG network IDs for tron/ink**: Need runtime verification via `/onchain/networks` endpoint. If IDs differ, the chain map is easy to update.
- **Backfill OHLCV data quality**: CG token OHLCV may not cover all chains/tokens. Non-fatal; we skip gaps.
