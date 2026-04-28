# Mint/Burn Flows Rows-Read Reduction Plan - 2026-04-28

## Scope

Research-only plan for option #3 from the D1 rows-read investigation: reduce `/api/mint-burn-flows` read load by avoiding live aggregate scans on normal API reads.

## Current Hot Path

Main handler: `worker/src/api/mint-burn-flows.ts`.

`handleAggregate()` currently computes the aggregate response live after cache misses. The existing cache is used as a fallback path, but successful mint/burn cron runs invalidate flow caches, so the first public request after a run pays the full aggregate rebuild.

Hot aggregate queries in `fetchAggregateData()`:

- two hourly-window reads from `mint_burn_hourly`
- three rolling `SUM(net_flow_usd)` reads for 7d/30d/90d
- one daily-baseline grouped read
- one `MIN(hour_ts)` first-hour grouped read
- one largest-events read from `mint_burn_events`

The route is not the highest request-count endpoint, but each miss scans enough rows to dominate D1 rows-read cost.

## Recommended First Patch

Use the existing `cache` table as a response snapshot store for aggregate mode.

1. Add a non-fallback aggregate cache read path before live work in `/api/mint-burn-flows` when no `stablecoin` query param is present.
2. Extract the current aggregate response builder so both the API cold path and cron publisher can call one implementation.
3. Publish hot aggregate snapshots from the critical `sync-mint-burn` cron after `ok` or `degraded` runs.
4. Start with the app's hot windows: `24` and `168` hours.
5. Keep per-coin mode unchanged in the first patch.
6. Do not add a migration in the first patch.

Freshness should remain based on the response payload's sync timestamp (`sync.lastSuccessfulSyncAt` first, then `updatedAt`, then cache row `updated_at`) so newly published but stale data still reports stale/degraded correctly.

## Expected Impact

For common aggregate reads, D1 work drops from multiple `mint_burn_hourly` / `mint_burn_events` scans to one primary-key `cache` read. The aggregate scan cost moves to the cron once per hot window per critical run, which bounds the cost by producer cadence instead of multiplying it by site/API traffic.

## Test Plan

- Aggregate handler returns a cached aggregate response without querying `mint_burn_hourly` or `mint_burn_events`.
- Malformed cached aggregate fails closed with the existing cache-error semantics.
- Critical cron success/degraded path writes `aggregate:24` and `aggregate:168`.
- Error path does not publish.
- Cached stale snapshot still emits stale/degraded freshness warnings.
