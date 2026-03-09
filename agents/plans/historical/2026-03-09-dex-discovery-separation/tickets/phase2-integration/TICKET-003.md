---
title: "Update documentation for discovery separation and methodology v3.3"
agent: codex
model: gpt-5.3-codex-spark
reasoning_effort: low
done: false
---

## Goal

Update all relevant documentation to reflect the new architecture.

## Task

### 1. `docs/dex-liquidity.md`

Add a new section **"## Discovery Cron"** after the first main section (after the quality multipliers / storage section, before "## DEX Price Cross-Validation"). Include:

- **Architecture**: Two cron jobs — scoring (`:10,:40`, 30 min) and discovery (`:03,:23,:43`, 20 min). Discovery writes to `dex_pool_staging`, scoring reads and merges.
- **Staging table schema**: `dex_pool_staging` with columns (pool_id, stablecoin_id, source, chain, protocol, symbol, tvl_usd, volume_24h, fee_tier, balance_ratio, is_stable, base_token, quote_token, quote_symbol, price_usd, locked_liq_pct, raw_json, discovered_at, refreshed_at). PK is (pool_id, stablecoin_id).
- **Discovery meta table**: `dex_discovery_meta` with columns (stablecoin_id PK, consecutive_misses, last_crawl_at, last_hit_at).
- **Tiered priority**: T1 (0 pools, every run), T2 (1-4 pools or 1 chain, every 3rd run), T3 (>=5 pools >=2 chains, every 10th run). Sorted by staleness within tier.
- **Exponential backoff**: 3-5 misses -> T2 cadence, 6-9 -> T3, 10+ -> dormant (daily). Resets on any pool found.
- **Chain-aware source routing**: Only queries chains where coin is deployed per its `contracts` map.
- **Freshness confidence decay**: `max(0.5, 1 - ageHours / 48)`. Multiplied into effective TVL. Pools >24h excluded.
- **Staged pool defaults contract**: organic_fraction=0.5, balanceRatio=1.0 (neutral), lockedLiquidity=null, maturity=min(daysSinceDiscovered, 30), isStable inferred from quoteSymbol.
- **Source order**: CG Onchain -> GeckoTerminal -> DexScreener -> CG Tickers (sequential, 1 connection).

Update the **"Data sources"** paragraph in the opening section to note that CG/GT/DexScreener/CG Tickers now run on the independent discovery cron rather than as optional phases of the scoring cron.

Remove any references to the old "5-minute optional discovery budget" or `OPTIONAL_DISCOVERY_BUDGET_MS`.

Update the **"Storage"** section to include the two new tables.

### 2. `docs/worker-infrastructure.md`

Find the cron schedule section. In the 20-minute trigger (`3,23,43 * * * *`) job list:
- Add `sync-dex-discovery` with `intervalSec: 1200`
- Note: "3 jobs now run on the 20-minute slot: sync-blacklist, sync-mint-burn, sync-dex-discovery"
- Add: "Discovery uses strictly sequential fetches (1 connection at a time), coexisting within the 6-connection pool alongside blacklist (2-3 connections) and mint-burn (1-2 connections)."

### 3. `docs/data-flow-map.md`

Find the DEX liquidity section. Add the staging table as an intermediate step:
- `CG/GT/DexScreener/CG Tickers -> [discovery cron] -> dex_pool_staging (D1) -> [scoring cron] -> dex_liquidity (D1)`
- Note the tiered priority and confidence decay in the flow description.

### 4. `docs/methodology-page.md`

Find the methodology changelog section. Add a v3.3 entry:
- **v3.3** (2026-03-09): Separated discovery pipeline with staged pool confidence decay. Discovery sources (CG Onchain, GeckoTerminal, DexScreener, CG Tickers) now run on an independent 20-minute cron with 3x more budget. Staged pools merged into scoring with freshness confidence decay (`max(0.5, 1 - ageHours/48)`) and explicit defaults contract. Chain-aware source routing reduces wasted API calls. Tiered priority with exponential backoff prevents looping on pool-less coins.

## Acceptance Criteria

- `grep -c "Discovery Cron" docs/dex-liquidity.md` returns >= 1
- `grep -c "dex_pool_staging" docs/dex-liquidity.md` returns >= 1
- `grep -c "dex_discovery_meta" docs/dex-liquidity.md` returns >= 1
- `grep -c "OPTIONAL_DISCOVERY_BUDGET_MS" docs/dex-liquidity.md` returns 0
- `grep -c "sync-dex-discovery" docs/worker-infrastructure.md` returns >= 1
- `grep -c "3.3" docs/methodology-page.md` returns >= 1
- `grep -c "dex_pool_staging" docs/data-flow-map.md` returns >= 1
- `npm run build` exits 0 (docs don't break build)
