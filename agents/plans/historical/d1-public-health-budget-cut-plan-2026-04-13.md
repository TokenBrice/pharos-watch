# D1 Public Health Budget Cut Plan - 2026-04-13

## Goal

Massively reduce D1 rows read from the public health/status path with acceptable loss of non-critical health detail.

Primary target:

- `worker/src/lib/public-health-assessment.ts`

Related target:

- `worker/src/handlers/scheduled/twenty-minute-mint-burn-critical.ts`

## Research Summary

D1 Insights for the trailing 1 day and 30 days show that the public health mint/burn diagnostics are the dominant current local offender.

Trailing 1 day, current top local fingerprints:

- `SELECT symbol, MAX(timestamp) ... FROM mint_burn_events WHERE symbol IN (...) GROUP BY symbol`
  - 2,195 calls
  - 943,689 average rows read
  - 2,071,398,057 total rows read
  - source: `loadMintBurnHealth()`
- `SELECT COALESCE(SUM(mint_count + burn_count), 0) ... FROM mint_burn_hourly`
  - 2,216 calls
  - 127,793 average rows read
  - 283,190,621 total rows read
  - source: `loadMintBurnHealth()`
- `SELECT symbol, MAX(timestamp) as latest_ts ... FROM mint_burn_events ... GROUP BY symbol`
  - 85 calls
  - 943,618 average rows read
  - 80,207,552 total rows read
  - source: post-critical-cron stale-major alert path

Trailing 30 days:

- health grouped latest-by-symbol scan: 34.4B rows read
- health all-time mint/burn hourly total scan: 4.6B rows read
- post-critical-cron grouped latest-by-symbol scan: 1.8B rows read

The grouped latest-by-symbol plan uses `idx_mbe_symbol_ts(symbol, timestamp DESC)`, but the aggregate still scans each large symbol range. A per-symbol `ORDER BY timestamp DESC LIMIT 1` would be much cheaper, but the stronger savings opportunity is to remove the symbol scan from health entirely because the data does not drive public status.

Current public mint/burn status is driven by:

- `mintBurn.sync.lastSuccessfulSyncAt`
- `mintBurn.sync.freshnessStatus`
- `mintBurn.sync.criticalLaneHealthy`
- `mintBurn.sync.warning`

These are derived from `cron_runs`, whose plan uses `idx_cron_runs_job_started(job, started_at DESC)`.

Cosmetic/advisory fields from the expensive scans:

- `mintBurn.totalEvents`
- `mintBurn.latestEventTs`
- `mintBurn.latestHourlyTs`
- `mintBurn.freshnessAgeSec`
- `mintBurn.majorStaleCount`
- `mintBurn.staleMajorSymbols`

UI usage:

- `SiteHeader` shows the mint/burn total in a small metric pill.
- Public status/admin surfaces show major stale badges and a latest hourly timestamp.
- Public status impact logic checks `majorStaleCount`, but public status severity already comes from `mintBurn.sync`.

## Implementation Plan - Revision 2

1. Simplify `loadMintBurnHealth()` to cron-health only.
   - Remove all reads from `mint_burn_events`.
   - Remove all reads from `mint_burn_hourly`.
   - Keep only:
     - latest critical-lane run status from `cron_runs`
     - latest successful critical-lane run timestamp from `cron_runs`
   - Continue to derive `sync` with `buildMintBurnSyncHealth()`.
   - Return advisory data as unavailable:
     - `totalEvents: null`
     - `latestEventTs: null`
     - `latestHourlyTs: null`
     - `freshnessAgeSec: null`
     - `majorStaleCount: 0`
     - `staleMajorSymbols: []`
   - Keep `mintBurnImpactStatus` unchanged because it already depends only on `sync`.

2. Update public health contract for the intentionally unavailable total.
   - Change `HealthResponse["mintBurn"]["totalEvents"]` from `number` to `number | null`.
   - Update `HealthResponseSchema` accordingly.
   - Update docs/api-reference.md so the endpoint explicitly states these expensive mint/burn advisory fields are no longer table-scanned by `/api/health`, and consumers should use `/api/mint-burn-flows` / `/api/mint-burn-events` for operational flow data.

3. Hide the removed metric in the site header.
   - Update `src/components/site-header.tsx` so it only renders the mint/burn event pill when `totalEvents` is a positive number.

4. Remove the post-critical-cron grouped symbol scan.
   - Delete the `onSettledSuccess` stale-major alert path from `runTwentyMinuteMintBurnCriticalSlot()`.
   - Rely on existing cron result logging, Alchemy circuit recording, status self-check, and public health sync freshness for degraded/stale visibility.
   - Remove now-unused imports from that file.

5. Update tests.
   - Adjust `health.test.ts` fixtures and assertions for nullable `mintBurn.totalEvents`.
   - Add a regression assertion that `/api/health` no longer executes SQL containing `FROM mint_burn_events` or `FROM mint_burn_hourly`.
   - Add or adjust a scheduled-cron assertion that the critical mint/burn slot no longer runs the stale-major alert DB query.

6. Validate.
   - Run targeted tests:
     - `npm test -- worker/src/api/__tests__/health.test.ts`
     - `npm test -- worker/src/__tests__/index.scheduled.test.ts`
     - `npm test -- src/lib/__tests__/public-status.test.ts src/lib/__tests__/status-dashboard-model.test.ts`
   - Run `npm run lint` only if touched types or frontend surface create obvious lint risk; otherwise report targeted test status.

## Expected Savings

Expected eliminated rows read from measured 1-day fingerprints:

- ~2.07B rows/day from health latest-by-symbol scan
- ~0.28B rows/day from health total hourly count scan
- ~0.08B rows/day from critical-cron stale-major alert scan

Total direct target: ~2.43B rows/day, or roughly 73B rows/month if traffic/cadence is similar.

This intentionally excludes mint/burn flow endpoint scans and peg/report-card first-seen scans because they are product data paths, not the health function requested here.

## Review Loop

### Review Iteration 1

Findings:

- Major: Returning `0` for unqueried `mintBurn.totalEvents` would be misleading and would still render "0 mint/burn events recorded" in the header.
- Minor: Removing major-stale symbols can also remove a public-status badge; this should be documented as an intentional health-budget tradeoff.
- Minor: The plan originally did not include a direct no-heavy-SQL regression assertion.

Fixes applied:

- Changed `totalEvents` to `number | null` and added site-header hiding.
- Added API docs update for unavailable advisory fields.
- Added health SQL regression assertion.

### Review Iteration 2

Findings:

- Minor: Cron stale-major alerts are not replaced one-for-one.

Decision:

- Accept. The user explicitly allowed aggressive cuts for a non-critical health feature. Existing cron logging, circuit state, and status self-check still surface critical-lane freshness and errors.

Remaining plan issues:

- 1 Minor: no per-symbol stale-major alert replacement.

