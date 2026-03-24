# Cron Audit Report

**Date:** 2026-03-23
**Observation window:** 2026-03-23 00:00:00 UTC to 2026-03-23 06:00:00 UTC
**Local time at start:** 2026-03-23 01:00:00 CET
**Scope:** All scheduled Worker cron jobs, their shared runtime infrastructure, and every live cron run that occurs inside the six-hour window above
**Artifacts:**
- `agents/cron-live-2026-03-23/live-observations.md`
- `agents/cron-live-2026-03-23/cron-runs.jsonl`
- `agents/cron-live-2026-03-23/wrangler-tail.jsonl`

## Audit Method

1. Static audit of cron orchestration, leases, logging, progress telemetry, cache writes, and shared failure-handling helpers.
2. Static audit of every cron implementation and its tests/docs.
3. Live production observation during the six-hour window using both:
   - `wrangler tail` against the deployed Worker
   - remote D1 polling of `cron_runs` / `cron_run_progress`
4. Incremental report updates written to disk during the window so findings survive context loss.

## Window Constraints

- The six-hour live window starts at `2026-03-23 00:00:00 UTC`.
- The daily slots (`0 8 * * *` and `5 8 * * *`) do **not** occur inside this window, so those jobs can only be audited statically or via historical run data unless the window is extended past `2026-03-23 08:05:00 UTC`.

## Early Findings

### Live pre-window baseline

- At `2026-03-22 23:57 UTC`, the latest production `cron_runs` sample already showed repeated `sync-stablecoins` hard errors at exactly `480000 ms`, which matches the configured 8-minute app timeout in [worker/src/lib/cron-lease.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/cron-lease.ts). This is a confirmed live reliability issue, not just a theoretical risk.
- The same sample showed `status-self-check` frequently returning `degraded` while still writing 29 probe rows, and `sync-fx-rates` succeeding only in `cadence-valid-carry-forward` fallback mode with 40-100 second runtimes. Those conditions materially affect the reliability of downstream status and freshness signals.

### Live window update: 2026-03-23 00:01 UTC

- The `00:00 UTC` quarter-hourly slot started with `sync-stablecoins` acquiring its lease, but `cron_run_progress` showed only `stage=lease-acquired` and no subsequent progress heartbeat by `00:01 UTC`.
- That observation matters because the same job had already failed twice at the exact 8-minute wrapper timeout immediately before the window. The live hypothesis is now stronger: the job is either stalling before its first explicit progress report or doing substantial work without emitting progress, which weakens operator visibility and makes imminent timeout risk harder to distinguish from normal execution.

### Monitoring note: 2026-03-23 00:06 UTC

- The first version of the D1 poller used `rowid`, but Wrangler serialized the autoincrement key back as `id`. That caused an accidental historical replay instead of a pure live ledger.
- I archived that bad bootstrap output under `agents/cron-live-2026-03-23/*bootstrap-bad-cursor*`, fixed the cursor query to use `id`, and restarted the live ledger from the current high-water mark. The main audit findings above are still valid because they came from direct D1 queries, not the broken cursor.

### Shared infrastructure hypotheses to validate live

- `logCronRun()` likely converts timeout-bound jobs into visible `cron_runs` errors reliably, but it may still lose detail because thrown errors only land in the `error` column unless callers also emit structured metadata before the abort.
- The lease wrapper appears strong for duplicate-prevention, but slot chaining plus long-running jobs can still create starvation or stale downstream data even when no lease collision happens.
- The status model may currently over-amplify operator noise by treating some warning-grade telemetry as degraded job health, especially for self-check style jobs.

## Findings

This section will be updated throughout the observation window.

### Validated production patterns so far

- `sync-stablecoins` hit the exact 8-minute wrapper timeout (`480000 ms`) 3 times in the last 7 days, and all 3 rows persisted as `CronTimeoutError: Cron job "sync-stablecoins" timed out after 480s`. This validates that the timeout path is active in production, not hypothetical.
- `sync-stablecoin-charts` has at least 2 near-duplicate start pairs in the last 7 days where the same job started again within 1-5 seconds of itself. One concrete example:
  - `2026-03-22 21:40:21 UTC` — `sync-stablecoin-charts` `ok`
  - `2026-03-22 21:40:23 UTC` — `sync-stablecoin-charts` `ok`
  - `2026-03-22 21:40:22 UTC` — `sync-dex-liquidity` `ok`
  - `2026-03-22 21:40:24 UTC` — `sync-dex-liquidity` `skipped_locked`
- That pattern confirms a subtle but important infrastructure limit: per-job leases prevent overlap, but they do not prevent near-serial duplicate schedule delivery after a fast first run releases its lease. Fast jobs still re-execute, while slower downstream jobs surface the duplicate as `skipped_locked`.
- `status-self-check` is frequently marked `degraded` even when probe execution itself is mostly healthy. Recent production rows show `passCount=28`, `failCount=0`, but `probeStatus="stale"` and `rawOverallStatus="stale"`, which means the cron status is often reflecting the platform state it observes rather than a failure of the self-check machinery itself.
