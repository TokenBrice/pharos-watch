# Remediation plan for transient public `/status` stale incidents

Date: 2026-04-10
Status: planning only, no implementation performed

## Goal

Eliminate false public `stale` incidents that are caused by transient freshness-diagnostic read failures, while preserving fast detection of real data unavailability and real public-serving failures.

## Non-goals

- Do not weaken detection for actual stale public datasets.
- Do not hide real D1 outages.
- Do not redesign the status UI.
- Do not change methodology surfaces.

## Plan overview

The fix should land in four layers, in this order:

1. decouple freshness diagnostics from hot-table `MAX(...)` reads
2. change public-health semantics so diagnostic read failures stop auto-promoting to `stale`
3. move `status-self-check` out of the current overlap-prone shared slot
4. add enough observability to prove the fix worked and to diagnose any residual incidents

The rollout should keep the system backward-compatible throughout:

- add sentinel writes before depending on sentinel reads
- keep table-query fallback until production proves all sentinel writers are live
- remove emergency compatibility only after a quiet observation window

## Phase 1: Replace hot-table freshness reads with producer-owned freshness sentinels

### Objective

Stop reading freshness for `yield_data`, `dex_liquidity`, and `stress_signals` through live `MAX(...)` table scans inside `/api/health` and `/api/status`.

### Rationale

The current design makes public health depend on ad hoc reads against hot D1 tables during periods when those same tables are being republished. That is fragile under overlap and is the direct entry point for false stale incidents.

### Proposed design

Add explicit freshness sentinel keys in the `cache` table, written by the owning producer only after a successful publish of the underlying dataset.

Suggested keys:

- `freshness:yield-data`
- `freshness:dex-liquidity`
- `freshness:dews`

Suggested value shape:

```json
{
  "updatedAt": 1775841668,
  "source": "sync-yield-data",
  "publishStatus": "ok"
}
```

The `cache.updated_at` column can remain the primary freshness timestamp; the JSON value is there for debugging and future flexibility.

### Files likely to change

- `worker/src/lib/api-freshness.ts`
- `worker/src/cron/yield-sync/publication.ts`
- `worker/src/cron/dex-liquidity/persistence.ts`
- `worker/src/cron/dews/persistence.ts`
- possibly `worker/src/lib/db-cache.ts` if a helper is missing for sentinel writes

### Detailed work

1. Add a small shared helper for freshness-sentinel writes.
2. Write the sentinel only after the producer has completed its real publish path successfully.
3. Update `buildCacheStatuses()` to read the sentinel first for:
   - `yield-data`
   - `dex-liquidity`
   - `dews`
4. Keep a rollout-safe fallback:
   - if sentinel is missing, use the current table-freshness query path
   - log or report the fallback path so it is obvious when rollout is incomplete
5. Preserve current max-age thresholds.

### Expected result

Public health no longer depends on live `MAX(...)` reads over hot republishing tables during the most contention-prone windows.

## Phase 2: Reclassify freshness-diagnostic failures so they stop creating false incidents

### Objective

Make freshness diagnostics fail soft when the status system still has a valid last-known-good freshness source.

### Rationale

Today:

- query failure -> `ageSeconds = null`
- `null` -> cache freshness `stale`
- cache stale -> availability `stale`

That path is too aggressive for best-effort diagnostics and contradicts the intended warning-level framing in the docs.

### Proposed semantic rule

Use this precedence:

1. If a freshness sentinel exists and is readable:
   - compute freshness from that timestamp
2. If the sentinel is unreadable but a recent last-known timestamp is still available:
   - keep the previous freshness evaluation
   - add warning / info diagnostic state
   - do not auto-promote to public `stale`
3. Only mark the dataset `stale` when:
   - the sentinel indicates real staleness by threshold, or
   - both the sentinel and fallback freshness evidence are unavailable and the system can no longer establish recency safely

### Files likely to change

- `worker/src/lib/api-freshness.ts`
- `shared/lib/cache-health.ts`
- `worker/src/lib/public-health-assessment.ts`
- `worker/src/lib/status/evaluation-causes.ts`
- `worker/src/api/__tests__/status.test.ts`
- `worker/src/lib/__tests__/api-utils.test.ts`

### Detailed work

1. Introduce an explicit distinction between:
   - freshness state
   - freshness diagnostics state
2. Add a non-null fallback freshness source for sentinel-backed datasets.
   - simplest acceptable fallback: last readable sentinel timestamp
   - secondary fallback: last successful producer cron timestamp
3. Update warnings/causes:
   - keep `cache_freshness_query_failed`
   - add the failing key
   - add whether sentinel, fallback, or both were used
4. Update public health to expose the warning without forcing `overallStatus = stale` for the diagnostic miss alone.
5. Keep real `stale` when the fallback evidence itself shows stale data.

### Expected result

Transient diagnostic misses become visible warnings and operator context, not public incidents.

## Phase 3: Move `status-self-check` to an isolated offset lane

### Objective

Reduce the probability that self-check status synthesis runs during heavy shared-slot D1 activity or the half-past hourly yield overlap window.

### Rationale

Even after semantic fixes, the current timing is poor:

- quarter-hour slot runs `sync-fx-rates`
- then `sync-stablecoins`
- then snapshots
- then `status-self-check`

This guarantees that the self-check runs later than the nominal quarter-hour and often inside or adjacent to other publication windows.

### Proposed scheduling change

Move `status-self-check` off the shared `*/15` slot and onto its own isolated cron schedule with a minute offset that avoids:

- `sync-yield-data` at `20 * * * *`
- quarter-hour `sync-stablecoins`
- half-hour `dex-liquidity` / `dews`

Candidate schedules to evaluate:

- `8,23,38,53 * * * *`
- `9,24,39,54 * * * *`
- `11,26,41,56 * * * *`

Preferred selection criteria:

1. not adjacent to the hourly yield lane
2. not adjacent to the shared quarter-hour slot end
3. consistent with the existing stale/refetch expectations documented for the dashboard

### Files likely to change

- `shared/lib/cron-jobs.ts`
- `worker/wrangler.toml`
- `worker/src/handlers/scheduled/quarter-hourly.ts`
- scheduled runner registry / dispatch wiring if needed
- status docs describing cron cadence and trigger mode

### Detailed work

1. Define a new cron schedule entry for isolated status self-check.
2. Mark `status-self-check` as isolated metadata in shared cron definitions.
3. Remove it from the quarter-hour shared slot.
4. Register it in the scheduled dispatcher.
5. Update status-page docs and cadence metadata.

### Expected result

The status evaluator stops sampling during the current worst overlap window, reducing both false positives and noisy timing drift.

## Phase 4: Add observability specific to this failure mode

### Objective

Make any residual freshness-diagnostic failure attributable to a specific key and a specific fallback path.

### Files likely to change

- `worker/src/lib/api-freshness.ts`
- `worker/src/cron/status-self-check.ts`
- `worker/src/lib/status/evaluation-causes.ts`
- status docs if response metadata changes

### Detailed work

1. Record structured freshness diagnostics:
   - key
   - source (`sentinel`, `table-fallback`, `cron-fallback`)
   - read error class/message
   - query latency if measured
2. Include cache-failure key details in status-self-check cron metadata.
3. Ensure public `/api/health` warnings remain concise, but admin `/api/status` keeps the richer breakdown.
4. Add a regression-focused log line when public health would have become stale under old semantics but no longer does under new semantics.

### Expected result

If another false incident occurs, operators can identify the exact failing freshness key and the exact fallback used without reconstructing it indirectly from timing.

## Test plan

### Unit / handler coverage

Add or update tests for:

1. sentinel-backed freshness read returns healthy/degraded/stale correctly
2. missing sentinel falls back to current table query during rollout
3. sentinel read failure with recent fallback timestamp produces warning but not public `stale`
4. true stale sentinel still produces public `stale`
5. full D1 failure still produces `stale`
6. `/api/status` availability causes include the failing freshness key
7. `status-self-check` metadata includes the new freshness-diagnostic details
8. cron metadata / schedule registry remains internally consistent

### Commands to run when implementation happens

- `npm run lint`
- `npm test`
- `npm run build`
- `npm run test:merge-gate`
- `cd worker && npx tsc --noEmit`

## Documentation updates required when implementation happens

At minimum:

- `docs/status-dashboard.md`
- `docs/api-reference.md`
- `docs/worker-and-api-limits.md`
- `docs/worker-infrastructure.md` if cron topology changes materially

Update content for:

- new self-check cadence / trigger mode
- new freshness-sentinel architecture
- new warning semantics for freshness-diagnostic failures

## Rollout sequence

1. Land sentinel writes and sentinel reads with table-query fallback still enabled.
2. Deploy and verify sentinels are being written for all three datasets.
3. Change status semantics to prefer sentinel/fallback evidence and stop promoting diagnostic misses to public `stale`.
4. Move `status-self-check` to the isolated offset lane.
5. Watch production transition history and `/api/health` warnings for at least several half-past windows.
6. Only after the observation window is clean, remove or permanently demote the old hot-table freshness fallback path.

## Success criteria

Primary success criteria:

- the repeated `healthy -> stale -> healthy` half-past churn disappears from `/status/`
- freshness-diagnostic failures remain operator-visible without creating public incidents
- real stale datasets still drive public `stale`

Secondary success criteria:

- `/api/health` latency remains acceptable during cron publication windows
- status history no longer shows one-sample stale flips with three-check recoveries unless there is a real outage

Operational acceptance thresholds:

- zero false half-past stale incidents across at least `24` consecutive hours after the self-check schedule change
- no `cache_freshness_query_failed` warning burst that also drives public `overallStatus = stale`
- real stale simulation or fixture coverage still proves true stale datasets escalate correctly

## Production verification checklist

After each rollout stage, verify:

1. Direct uncached health:
   - `curl https://api.pharos.watch/api/health`
   - confirm sentinel-backed caches still report sensible ages
2. Public transition history:
   - `curl https://pharos.watch/_site-data/public-status-history?window=24h&limit=200`
   - confirm no new false `healthy -> stale` churn
3. Cron evidence:
   - inspect worker logs for the isolated `status-self-check` timing and for sentinel writes
4. Warning path:
   - force or fixture a freshness-diagnostic read failure in non-prod
   - confirm warning/info surfaces without public `stale`

## Rollback / abort conditions

Abort the rollout and revert to the previous semantic path if any of the following happens:

1. a genuinely stale dataset no longer escalates to public `stale`
2. sentinel writes are missing for any of the three producer families after deploy
3. the isolated self-check lane creates larger blind spots than the current cadence
4. the new warning/fallback semantics cause inconsistent admin/public health views

Rollback order:

1. restore previous self-check placement if cadence change is implicated
2. restore previous public-health semantics if stale detection is too soft
3. keep sentinel writes even during rollback if they are additive and harmless

## Compatibility cleanup gate

Do not remove the old table-query fallback until all of the following are true:

1. every target producer has written its sentinel in production for at least one full day
2. public health is stable across multiple half-past windows
3. admin status / public health / transition history all agree on the new semantics
4. regression tests cover both sentinel-present and sentinel-missing states

## Risks

1. If fallback semantics are too permissive, real stale data could be masked.
2. If sentinel writes are not truly post-publish, freshness could look newer than the dataset really is.
3. If the isolated self-check schedule is chosen poorly, it can still overlap another heavy lane.
4. If rollout removes the table-query fallback too early, existing environments could misreport freshness until all producers have written sentinels.

## Recommended implementation order

Implement in this exact order:

1. sentinel infrastructure
2. fallback-aware status semantics
3. self-check rescheduling
4. observability polish

That order minimizes rollout risk and lets the team separate semantic fixes from scheduling fixes when verifying production behavior.

## Review log

### Review 1

Minor issue 1:

- the first draft did not define when the temporary table-query fallback can safely be removed

Minor issue 2:

- the first draft listed success criteria and risks, but did not give concrete production verification and rollback gates

Fixes applied:

- added explicit compatibility-cleanup gate
- added production verification checklist
- added rollback / abort conditions
- tightened operational acceptance thresholds

### Review 2

Result:

- 0 issues remaining
