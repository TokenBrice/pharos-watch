# Transient `/status` stale incidents investigation

Date: 2026-04-10
Scope: production-only investigation of repeated public `/status/` incident flips showing `healthy -> stale -> healthy` churn
Implementation status: no product code changed

## Executive summary

The repeated public incidents are not consistent with long-lived user-visible outages. They are consistent with a brief raw-status evaluation failure that is then stretched into a roughly 48-minute visible incident by the status hysteresis rules.

The highest-confidence failure path is:

1. `status-self-check` runs late inside the shared quarter-hour slot, not exactly on the quarter-hour.
2. During some half-past runs, the raw status evaluation hits a transient failure in the dedicated-table freshness diagnostics used by `buildCacheStatuses()`.
3. That failure sets the affected cache age to `null`.
4. `null` freshness is currently interpreted as cache-impact `stale`.
5. Availability is therefore forced to `stale`, even though the underlying public data may still be serving correctly.
6. The persisted state machine escalates to `stale` immediately on one raw stale sample and only recovers after three later raw healthy samples plus dwell time.

Primary source area: status freshness diagnostics over hot D1 tables during overlapping cron load.

Highest-confidence overlap driver for the current half-past pattern: the hourly `sync-yield-data` lane overlapping with the delayed half-past `status-self-check` run.

## Confidence assessment

- High confidence:
  - the public incidents are mostly false positives caused by transient raw-status failures rather than sustained outages
  - the current status semantics over-escalate freshness-diagnostic failures into public `stale`
  - cron-slot timing and overlap materially contribute to the issue
- Medium-high confidence:
  - the current half-past pattern is driven primarily by overlap with the hourly `sync-yield-data` lane
- Medium confidence:
  - the exact failing freshness key in each incident is `yield-data`

Why the last point is only medium confidence: I did not catch a live stale event while the watcher was running, so I did not observe the exact failing key in flight. The timing pattern and code path still make `yield-data` the strongest candidate by a clear margin.

## Evidence

### 1. Public transition history matches a one-sample raw failure

The public transition log repeatedly shows:

- `healthy -> stale`
- reason: `raw-stale-immediate-escalation`
- followed by `stale -> healthy`
- reason: `raw-healthy-recovery-from-stale`

Recent 7-day examples cluster around:

- stale around `:30/:31`
- recovery around `:19/:20`
- stale incident duration around `~48 minutes`

That duration is explained by the configured hysteresis:

- escalate to stale after `1` raw stale sample
- recover to healthy after `3` raw healthy samples
- stale dwell minimum `180s`

This is strong evidence of a brief raw-status miss being stretched into a much longer visible incident window.

### 2. The code path directly converts freshness-query failures into `stale`

Relevant behavior:

- `worker/src/lib/api-freshness.ts`
  - `buildCacheStatuses()` runs direct freshness queries against:
    - `dex_liquidity`
    - `yield_data`
    - `stress_signals`
  - on query failure it records a failure and sets `ageSeconds = null`
- `shared/lib/cache-health.ts`
  - `getCacheFreshnessStatus()` returns `stale` when the freshness ratio is `null`
- `worker/src/lib/status/evaluation-state.ts`
  - availability becomes `stale` when public-health cache impact is `stale`

This means a transient D1 read failure in one freshness query is sufficient to flip raw availability to `stale`, even if the public endpoints are otherwise serving usable data.

### 3. Tests intentionally lock this behavior in

Two tests prove the current behavior is not accidental:

- `worker/src/api/__tests__/status.test.ts`
  - `surfaces cache freshness query failures as availability causes`
  - expects `availabilityStatus === "stale"` when a freshness query throws
- `worker/src/lib/__tests__/api-utils.test.ts`
  - expects freshness-query failures to produce `ageSeconds = null`

So the false-stale path is currently part of the tested contract.

### 4. Repo docs describe these failures as diagnostic warnings, not hard outages

`docs/status-dashboard.md` describes dedicated-table freshness lookup failures as explicit diagnostic context:

- `/api/status` adds `cache_freshness_query_failed`
- `/api/health` returns a `warnings` array for these best-effort failures

That documented intent does not line up with the current code path, where `ageSeconds = null` still floors cache impact to `stale`.

This code-doc mismatch is part of the bug, not just a documentation issue.

### 5. `status-self-check` timing materially increases overlap risk

`status-self-check` is not isolated. It runs inside the quarter-hour shared slot after:

1. `sync-fx-rates`
2. `sync-stablecoins`
3. `snapshot-supply`
4. `snapshot-chain-supply`

That sequencing means the self-check does not run at `:00/:15/:30/:45` exactly. It runs after the shared slot finishes the preceding work.

This aligns with the public history:

- recoveries around `:19/:20`
- stale flips around `:31/:34`

Those are slot-end timings, not exact cron-minute timings.

### 6. Live production control sample confirmed the timing behavior

Observed live on 2026-04-10 UTC:

- the `17:15` quarter-hour slot did not republish `stablecoins` until `17:19:38Z`
- so that slot consumed about `4.5` minutes before the later self-check stage could even run
- the hourly `sync-yield-data` cron log showed:
  - `scheduledTime = 2026-04-10T17:20:36Z`
  - finish log at `2026-04-10T17:21:08.492Z`
  - wall time about `32.2s`

Important implications:

- Cloudflare cron start jitter is real
- shared-slot delay is real
- overlap windows are wider than the nominal cron minute alone suggests

### 7. Live health probing showed the system is sensitive to write activity

Direct uncached `/api/health` observations:

- health stayed `healthy` during this control hour
- latency still spiked during publication windows:
  - around half-hourly `dex-liquidity` / `dews` publication
  - around hourly yield start

Notable live observations:

- `dex-liquidity` freshness reset while `/api/health` latency temporarily jumped into multi-second territory
- `yield-data` crossed its nominal 1-hour freshness target and health remained `healthy`
- `yield-data` reset shortly after the live yield run finished

That proves:

- simple lateness is not enough to produce `stale`
- the health path is measurably sensitive to concurrent publish/load activity

### 8. The current half-past pattern points at the hourly yield lane

For the current recent symptom, the strongest overlap candidate is `sync-yield-data`:

- schedule: `20 * * * *`
- isolated lane
- 10-minute timeout budget
- writes directly into `yield_data`
- current incidents cluster around the half-past self-check window, not around the `:10/:40` half-hourly DEX/DEWS lane

This makes the current half-past pattern much more consistent with the hourly yield lane than with `dex-liquidity` or `dews`.

## Ruled out as primary causes

### Plain hourly lateness

Ruled out.

`yield-data` exceeded its nominal 1-hour freshness target in the live control sample and `/api/health` still remained `healthy`. The status thresholds are far more tolerant than a single missed publish.

### Live reserve circuit noise

Ruled out as the primary current cause.

Open `live-reserves:*` circuits were present in healthy production responses, and those circuits are intentionally excluded from the public-impact circuit count used for top-level public health.

### Mint/burn public freshness

Unlikely as the primary current cause.

The observed recent incident timing is much more aligned with the half-past self-check overlap than with mint/burn critical-lane cadence.

## Root cause statement

The current public incidents are primarily false positives caused by transient failures in dedicated-table freshness diagnostics during overlapping cron activity. The status system currently treats those diagnostic misses as real public-availability `stale` conditions. Because `status-self-check` runs late in a shared quarter-hour slot and the half-past slot overlaps the hourly yield lane most often, intermittent D1 contention in or around the `yield_data` freshness path is the most likely trigger for the recent repeated half-past stale transitions.

## Contributing factors

1. `status-self-check` is sequenced after expensive quarter-hour work instead of running in an isolated offset lane.
2. Cloudflare cron scheduling has real jitter beyond the nominal minute boundary.
3. `buildCacheStatuses()` performs live `MAX(...)` reads against hot tables instead of reading producer-owned freshness sentinels.
4. A failed diagnostic read becomes `ageSeconds = null`, which becomes cache-impact `stale`.
5. The persisted state machine escalates to `stale` on the first raw stale sample.
6. Recovery requires three later healthy samples, so each brief miss becomes a long visible incident.

## What I would fix

The remediation should address both classes of defect:

1. Semantic defect:
   - freshness-diagnostic failure should not automatically equal public outage
2. Timing/load defect:
   - `status-self-check` should not evaluate during the heaviest shared-slot / hourly overlap window

The implementation plan is in the companion file:

- `agents/2026-04-10-status-transient-stale-remediation-plan.md`
