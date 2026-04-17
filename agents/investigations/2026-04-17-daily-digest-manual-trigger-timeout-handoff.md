# Daily Digest Manual Trigger Timeout Handoff - 2026-04-17

## Purpose

Handoff notes for the next agent investigating why the daily digest still did not publish after increasing its timeout budget and deploying commit `cdcd5968` (`Raise daily digest timeout budget`).

This document captures the production observations from the manual trigger follow-up, the exact evidence queried from D1, the likely failure shape, and recommended next steps.

## Current State

- Repo branch `main` was pushed to `origin/main` at commit `cdcd5968`.
- Deployed change increased:
  - `ANTHROPIC_TIMEOUT_MS` from `300_000` ms to `14 * 60_000` ms in `worker/src/lib/constants.ts`.
  - `CRON_TIMEOUT_MS["daily-digest"]` to `14 * 60_000 + 30_000` ms in `worker/src/lib/cron-lease.ts`.
- The manual digest trigger was run after deployment.
- The manual run did not write a new `daily_digest` row.
- The manual run did not insert a new `cron_runs` completion/error row.
- The latest stored daily digest remained the 2026-04-16 row.
- A stale expired `cron_leases` row for `daily-digest` remained after the manual attempt.

## Important Context

The scheduled cron failure reported by the status UI before this change was:

- job: `daily-digest`
- started: `2026-04-17 08:05:00 UTC`
- duration: `311654` ms
- status: `error`
- error: `TimeoutError: The operation was aborted due to timeout`

That failure is consistent with the old 5-minute Anthropic request timeout and happened before the timeout-budget deployment.

The post-deploy manual trigger is a separate run path:

- `POST /api/trigger-digest`
- handler: `worker/src/api/admin-actions.ts`
- runs `runManualDigestTrigger(...)` inside `execCtx.waitUntil(...)`
- internally wraps `generateDailyDigest(...)` with `logCronRun(...)` and `runCronWithLease(...)`

The deployed longer timeout was active during the manual attempt, based on the lease expiry timing below.

## Production Timeline Observed

All times are UTC.

### Latest Scheduled Failure Before Manual Retry

From `cron_runs`:

```text
job          daily-digest
started_at   1776413100
started_utc  2026-04-17 08:05:00
duration_ms  311654
status       error
error        TimeoutError: The operation was aborted due to timeout
```

### Manual Trigger Lease

After the user manually triggered the digest, D1 showed an active lease:

```text
job              daily-digest
lease_owner      ccb21c47-67d4-4604-a93c-308b863aa4e3
heartbeat_at     1776415021
heartbeat_utc    2026-04-17 08:37:01
lease_until      1776415951
lease_until_utc  2026-04-17 08:52:31
```

The `08:52:31 UTC` lease expiry is significant: it is roughly 15.5 minutes after the `08:37:01 UTC` heartbeat/acquisition time, matching the new `14.5 min` cron timeout plus the lease wrapper's extra 60-second TTL buffer. This is strong evidence that the new code was deployed and active.

### Polling Results

Repeated D1 polls at these times all showed the same stale lease heartbeat, no new completion row, and no new digest:

- `2026-04-17 08:39:56 UTC`
- `2026-04-17 08:42:25 UTC`
- `2026-04-17 08:43:57 UTC`
- `2026-04-17 08:46:33 UTC`
- `2026-04-17 08:48:52 UTC`
- `2026-04-17 08:52:37 UTC`
- `2026-04-17 08:54:59 UTC`

At `08:52:37 UTC`, the lease had passed its expiry time. The row still existed, but `acquireCronLease()` can take over expired rows because its conflict update condition allows `cron_leases.lease_until < now`.

## Latest Digest Row During Investigation

The latest daily digest row never advanced beyond:

```text
id             76
generated_at   1776326753
generated_utc  2026-04-16 08:05:53
digest_title   USDT Yield Creeps, USDD Drains
text_len       136
extended_len   1416
preview        USDT yield at 2.42% is 16% above its 30d average while TVL flows outward; USDD lost 72% of its DEX liquidity overnight on a $1.54B coin.
```

Expected success would have produced a new `daily_digest` row, likely `id = 77`, with `generated_at` around the manual run time.

## Commands Used

### Wrangler Version

```bash
cd worker && npx wrangler --version
```

Observed:

```text
4.83.0
```

### Main D1 Poll Query

```bash
cd worker && npx wrangler d1 execute stablecoin-db --remote --json --command "
SELECT job, lease_until, datetime(lease_until, 'unixepoch') AS lease_until_utc,
       heartbeat_at, datetime(heartbeat_at, 'unixepoch') AS heartbeat_utc
FROM cron_leases
WHERE job = 'daily-digest';

SELECT job, started_at, datetime(started_at, 'unixepoch') AS started_utc,
       duration_ms, status, item_count,
       substr(metadata, 1, 1200) AS metadata,
       substr(error, 1, 1200) AS error
FROM cron_runs
WHERE job = 'daily-digest'
ORDER BY started_at DESC
LIMIT 6;

SELECT id, generated_at, datetime(generated_at, 'unixepoch') AS generated_utc,
       digest_title, length(digest_text) AS text_len,
       length(digest_extended) AS extended_len,
       substr(digest_text, 1, 240) AS preview
FROM daily_digest
WHERE digest_meta IS NULL
   OR json_extract(digest_meta, '$.type') IS NULL
   OR json_extract(digest_meta, '$.type') != 'weekly'
ORDER BY generated_at DESC
LIMIT 1;
"
```

### Live Tail Attempt

```bash
cd worker
timeout 600s npx wrangler tail stablecoin-api --format pretty --search daily-digest
```

Result:

- Tail connected successfully.
- No `daily-digest` logs appeared before the tail timed out.

Note: the tail was search-filtered to `daily-digest`. A platform-level cancellation without an application log, or logs that did not include that string, would not appear.

## Interpretation

The deployed timeout increase appears to be active, but the manual trigger did not validate the scheduled cron path.

The failure shape is:

1. Manual trigger successfully acquired the `daily-digest` lease.
2. The lease heartbeat stopped at `08:37:01 UTC`.
3. No new digest row was inserted.
4. No new `cron_runs` row was inserted for the manual attempt.
5. The expired lease remained after `08:52:31 UTC`.

This points to the manual `execCtx.waitUntil(...)` background invocation being killed, orphaned, or otherwise failing before `logCronRun()` could reach its catch/finally logging path.

It does not prove the next scheduled cron will fail with the new budget. Scheduled Workers have a documented 15-minute wall-clock limit, while the manual trigger is an HTTP request that returns `202` immediately and then relies on `waitUntil(...)` for long-running background work. That is a materially different runtime path.

## Leading Hypotheses

### 1. Manual Trigger Is The Wrong Validation Path For A 14-Minute Job

`handleTriggerDigest` returns `202` and puts the full run into `execCtx.waitUntil(...)`. The manual run may not receive the same practical wall-clock behavior as the scheduled cron invocation. The disappearance before `logCronRun()` writes a final row fits this.

Relevant file:

- `worker/src/api/admin-actions.ts`

Relevant code path:

- `handleTriggerDigest`
- `runManualDigestTrigger`
- `logCronRun(db, "daily-digest", ...)`
- `runCronWithLease(db, "daily-digest", ...)`
- `generateDailyDigest(...)`

### 2. The Anthropic Request Still Did Not Return Before Runtime Cancellation

The lease was acquired, then heartbeat stopped while the job was likely inside `requestDigestCopy(...)` / `fetchWithRetry(...)` against Anthropic.

Relevant files:

- `worker/src/cron/digest/platform.ts`
- `worker/src/lib/fetch-retry.ts`
- `worker/src/lib/constants.ts`

The code now gives a single Anthropic request up to 14 minutes. If the platform cancels the HTTP-triggered `waitUntil` work before the fetch resolves or aborts, application logging may never run.

### 3. Lease Heartbeat Did Not Renew During Long Fetch

`runCronWithLease()` starts a `setInterval()` heartbeat. For the manual run, the heartbeat did not advance after the initial lease/acquire time. That could mean:

- the Worker invocation was canceled/frozen;
- timers were not firing while awaiting the long fetch in this runtime path;
- heartbeat renewals failed silently until lease expiry;
- the job was killed before the interval's next successful D1 write.

The lack of a `cron_runs` error row makes ordinary caught failure less likely.

## What Was Not Proven

- We did not prove the scheduled `daily-digest` cron still fails after the timeout deployment.
- We did not prove Anthropic returned an error.
- We did not capture unfiltered Worker logs or provider-side Anthropic request logs.
- We did not identify whether Cloudflare killed the HTTP-triggered `waitUntil` run or whether the fetch/timer interaction stalled inside the Worker.

## Recommended Next Steps

### Immediate Operational Validation

1. Watch the next scheduled `daily-digest` run at `08:05 UTC`.
2. Query D1 around and after the run using the poll query above.
3. Expected success:
   - new `daily_digest` row for `2026-04-18`;
   - new `cron_runs` row with `status = ok` or `degraded`;
   - no stale active lease after completion.
4. Expected controlled failure:
   - new `cron_runs` row with `status = error`;
   - error should mention the new 14.5-minute cron timeout if wrapper timeout fires.
5. Dangerous failure:
   - stale/expired `cron_leases` row again with no matching `cron_runs` completion row.

### Improve Manual Validation Path

Do not rely on the current `POST /api/trigger-digest` path as proof for long digest runs.

Options, from simplest to more durable:

1. Add an operator-only synchronous trigger mode, for example `POST /api/trigger-digest?wait=true`, that keeps the HTTP request open until `generateDailyDigest()` finishes. This relies on the caller staying connected and may need a direct `ops-api` call rather than the Pages admin proxy.
2. Add a proper background queue/workflow for manual digest jobs, so manual runs execute under a runtime designed for long asynchronous work.
3. Add a one-shot "run digest on next scheduled tick" flag in D1/cache, then let the scheduled cron path perform the forced run.

### Add Better Observability

Add durable logs or progress updates around the LLM call:

- before building digest input;
- before Anthropic request;
- after Anthropic response;
- before corrective retry;
- before insert into `daily_digest`;
- after insert;
- before channel delivery;
- after channel delivery.

For the scheduled path, `createScheduledRuntimeContext()` already reports progress before lease acquisition. The manual path does not call `reportProgress()`, so `cron_run_progress` was empty and not useful for this incident. Consider adding manual progress reporting or moving manual trigger through the same scheduled runtime context helper.

### Consider A Safer Budget Split

The current request budget is close to the 15-minute scheduled ceiling:

- Anthropic request: 14 minutes.
- Daily cron wrapper: 14.5 minutes.
- Cloudflare scheduled-trigger wall-clock limit: 15 minutes.

This leaves little room for:

- digest input collection;
- JSON parse and validation;
- corrective retry;
- D1 insert;
- Telegram delivery;
- final cron logging.

If scheduled cron also fails, consider:

1. Use a lower Anthropic request cap, for example 12 or 13 minutes, with a wrapper at 14.5 minutes.
2. Disable or shorten corrective retry for daily scheduled runs when the first request consumes most of the budget.
3. Split generation and channel delivery so D1 persistence completes before social posting.
4. Reduce prompt/input size or max tokens if the expanded digest prompt is causing model-side latency.

## Files Most Likely To Matter

- `worker/src/api/admin-actions.ts`
  - Manual trigger implementation and `execCtx.waitUntil(...)` use.
- `worker/src/lib/cron-lease.ts`
  - `CRON_TIMEOUT_MS`, lease TTL, heartbeat, lease acquisition and renewal.
- `worker/src/lib/cron-logger.ts`
  - Cron timeout, error logging, final `cron_runs` insert.
- `worker/src/cron/daily-digest.ts`
  - Daily digest orchestration and D1 persistence point.
- `worker/src/cron/digest/platform.ts`
  - Anthropic request, parse, validation retry, digest insertion helper.
- `worker/src/lib/fetch-retry.ts`
  - Fetch timeout and retry behavior.
- `worker/src/handlers/scheduled/context.ts`
  - Scheduled path runtime wrapper and progress reporting, useful contrast with manual path.

## Suggested First Task For Next Agent

Start by inspecting `worker/src/api/admin-actions.ts`, `worker/src/lib/cron-lease.ts`, and `worker/src/cron/digest/platform.ts` together. The key question is whether manual digest triggers should be made reliable for 10-15 minute runs, or whether the manual endpoint should simply enqueue/defer work to the scheduled cron path.

If the goal is immediate product recovery, prefer watching the next scheduled cron first. If the goal is operator reliability, fix the manual trigger runtime model next.
