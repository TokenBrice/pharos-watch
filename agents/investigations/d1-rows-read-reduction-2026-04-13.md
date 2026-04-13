# D1 Rows Read Reduction Investigation - 2026-04-13

## Scope

Investigate rising Cloudflare D1 rows-read cost with minimal website/API impact.

Assumptions:

- Use D1 Insights query fingerprints before production table scans.
- Prefer query-shape, cache, and index changes that preserve existing API contracts.
- Do not make runtime code changes during this investigation pass.

## Primary Signal

`wrangler d1 insights stablecoin-db --time-period 30d --sort-by reads --sort-type sum --sort-direction DESC --limit 20 --json`

Top 30-day row-read fingerprints:

| Rank | Query fingerprint | Calls | Avg rows read | Total rows read | Likely source |
| --- | --- | ---: | ---: | ---: | --- |
| 1 | `SELECT symbol, MAX(timestamp) ... FROM mint_burn_events WHERE symbol IN (...) GROUP BY symbol` | 37,876 | 909,365 | 34,443,134,668 | `loadMintBurnHealth()` via `/api/health`, `/api/status`, `/api/public-status-history`, probes |
| 2 | `SELECT stablecoin_id, SUM(net_flow_usd) ... FROM mint_burn_hourly WHERE chain_id = ? AND hour_ts >= ? GROUP BY stablecoin_id` | 54,309 | 116,005 | 6,300,118,379 | status mint/burn reconciliation or chain-scoped flow summaries |
| 3 | `SELECT stablecoin_id, MIN(snapshot_date) ... FROM supply_history GROUP BY stablecoin_id` | 52,016 | 95,103 | 4,946,922,273 | `getFirstSeenDates()` used by peg/report-card analytics |
| 4 | `SELECT COALESCE(SUM(mint_count + burn_count), 0) ... FROM mint_burn_hourly` | 38,513 | 119,908 | 4,618,028,682 | `loadMintBurnHealth()` |
| 5 | `SELECT stablecoin_id, MIN(hour_ts) ... FROM mint_burn_hourly WHERE chain_id = ? GROUP BY stablecoin_id` | 16,746 | 115,964 | 1,941,948,027 | status mint/burn reconciliation or chain-scoped flow summaries |
| 6 | `SELECT symbol, MAX(timestamp) as latest_ts ... FROM mint_burn_events ... GROUP BY symbol` | 1,997 | 903,157 | 1,803,606,358 | twenty-minute mint/burn stale-alert path |
| 7 | `SELECT * FROM depeg_events WHERE started_at > ? ORDER BY started_at DESC` | 52,039 | 30,687 | 1,596,938,330 | peg analytics/report cards/status probes |

Top 7-day row-read fingerprint was the same `symbol, MAX(timestamp)` query: 13,786,595,141 rows read.

## Query Plan Checks

Executed `EXPLAIN QUERY PLAN` on production D1. These explain statements reported `rows_read: 0`.

- `SELECT symbol, MAX(timestamp) ... WHERE symbol IN (...) GROUP BY symbol`
  - Plan: `SEARCH mint_burn_events USING COVERING INDEX idx_mbe_symbol_ts (symbol=?)`
  - Despite using the index, the aggregate scans each symbol range. With large symbols such as USDT/USDC this still reads nearly the whole event table per run.
- `SELECT stablecoin_id, MIN(snapshot_date) ... FROM supply_history GROUP BY stablecoin_id`
  - Plan: `SCAN supply_history USING COVERING INDEX sqlite_autoindex_supply_history_1`
  - This is a full covering-index scan.
- `mint_burn_hourly` chain/time aggregate and first-seen queries
  - Plan: scans `sqlite_autoindex_mint_burn_hourly_1`
  - Existing indexes do not line up with `chain_id`-first filters.

## Low-Impact Mitigations

1. Replace grouped latest-by-symbol mint/burn event scans with per-symbol indexed top-1 lookups.
   - Existing index `idx_mbe_symbol_ts(symbol, timestamp DESC)` can answer `WHERE symbol = ? ORDER BY timestamp DESC LIMIT 1`.
   - Apply in `worker/src/lib/public-health-assessment.ts` and `worker/src/handlers/scheduled/twenty-minute-mint-burn-critical.ts`.
   - Expected impact: largest single reduction. The 30-day top fingerprint alone was 34.4B rows read.

2. Cache or materialize mint/burn health metrics used by `/api/health`.
   - `totalEvents` currently scans all `mint_burn_hourly` rows on each health assessment.
   - Store a compact health snapshot in the `cache` table after `sync-mint-burn` / hourly persistence, or compute it lazily with a short TTL.
   - Expected impact: removes a 4.6B rows-read/month scan and avoids repeated no-store health costs.

3. Cache first-seen dates for peg analytics.
   - `getFirstSeenDates()` scans `supply_history` on peg/report-card paths.
   - First-seen dates change only when supply history is backfilled or a new coin appears, so a cache row with long TTL or cache invalidation from supply snapshot/backfill is low-risk.
   - Expected impact: removes roughly 4.9B rows read in the measured 30-day window.

4. Add `mint_burn_hourly` indexes for chain/time readers or materialize status reconciliation.
   - Candidate indexes:
     - `(chain_id, hour_ts DESC, stablecoin_id)`
     - `(chain_id, stablecoin_id, hour_ts)`
   - Indexes will increase write rows and storage. Cloudflare pricing docs say indexes can reduce rows read but add writes for indexed-column updates, so measure after the top query-shape fix.
   - A materialized/cache approach may be cheaper than indexes for "first seen" and health totals.

5. Reduce status/probe fan-out cost after SQL fixes.
   - `/api/health`, `/api/status`, and `/api/public-status-history` all call `assessPublicHealth()`.
   - Admin/browser endpoint probes also hit `/api/health` semantically every polling cycle.
   - After the heavy queries are cheap, this may not matter. If it still does, consider a short in-Worker or D1 cache for the public health assessment body.

6. Later: cache peg analytics/report-card snapshots.
   - `depeg_events` and `stress_signals` latest-row queries are meaningful but smaller than mint/burn.
   - Do this only after fixing the top mint/burn and first-seen scans.

## Notes

- The website and Worker both have cache layers, but cache hits still record request attribution in D1. D1 Insights did not show request-attribution upserts as the main rows-read driver.
- Cloudflare's current D1 pricing page says Workers Paid includes the first 25B rows read/month and then charges $0.001 per million rows read; the screenshots also imply a 25B included allowance (`67.52B total - 42.52B billable`).
- Cloudflare defines rows read as rows scanned, not rows returned, which matches the high row-read count on queries returning only 8 symbols.
