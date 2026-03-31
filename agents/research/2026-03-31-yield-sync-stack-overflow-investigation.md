# Yield Sync Stack Overflow Investigation

Date: 2026-03-31

## Summary

`sync-yield-data` started failing hourly with `RangeError: Maximum call stack size exceeded` after several clean runs. The failure happened before any `yield_data` writes or `yield-rankings` cache overwrite, but after `report_card_cache` had already been refreshed.

## Live Findings

- `cron_runs` showed the first failing `sync-yield-data` run at `1774956026`, with the previous run at `1774952422` still healthy.
- `yield_data` remained pinned at `updated_at = 1774952422`, confirming the failure happened before persistence.
- `report_card_cache` advanced during failed runs, confirming the safety snapshot path completed successfully.
- `yield:onchain-health:v1` did not advance during failed runs, narrowing the failure window to the history-loading / source-evaluation stage.
- Remote D1 inspection showed `yield_history` had grown to `129,783` rows in the last 30 days.

## Root Cause

`worker/src/cron/yield-sync/history.ts` appended D1 result sets with:

- `historyRows.push(...historyResult.results)`
- `prevTvlRows.push(...prevTvlResult.results)`
- `prevBestRows.push(...prevBestResult.results)`

Once the per-query `yield_history` result set crossed the V8 spread-argument limit (around `130k` elements in local reproduction), `push(...rows)` threw `RangeError: Maximum call stack size exceeded`.

This aligns with the production timeline:

- the cron succeeded while the 30-day history set was smaller
- it began failing immediately once the history table grew past the spread limit

## Fix

Replace spread-based appends with bounded iteration so the loader can handle large result sets without relying on the engine’s argument limit.

## Validation

- Added a focused regression test that loads `130,000` history rows through `loadYieldHistorySnapshots()`.
- Planned runtime checks:
  - `npm test -- --run worker/src/cron/__tests__/yield-history-snapshots.test.ts worker/src/cron/__tests__/sync-yield-data.test.ts`
  - `cd worker && npx tsc --noEmit`
