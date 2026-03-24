# Cron Reliability Implementation Plan

Status: proposed
Source audit: `agents/cron-live-audit-2026-03-23/report.md`

## Goal

Execute the cron-audit findings in a sequence that reduces production risk, preserves backward compatibility for D1/Worker rollout, and leaves the cron system easier to observe, test, and operate.

## Objectives

- Eliminate scheduler/lease behaviors that can double-run, over-heal breakers, or stall downstream jobs.
- Make high-risk data products fail closed when key inputs are unavailable.
- Preserve last-known-good cache/state on partial upstream success.
- Improve live diagnosability for long-running jobs.
- Raise regression coverage around cron reliability semantics, not just happy-path execution.

## Non-Negotiables

- Keep D1 migrations additive and backward-compatible.
- Do not ship destructive lease/schema changes in the same rollout as behavior changes if they can be sequenced.
- Each phase must end with targeted tests, worker typecheck, and a merge-gate run before push.
- Any implementation that changes PSI, DEWS, or yield semantics must update the matching docs and timeline docs.

## Delivery Order

1. Scheduler and lease foundations
2. Shared-slot orchestration and breaker semantics
3. Stablecoins observability and publication semantics
4. PSI and DEWS correctness fixes
5. Daily publication/reference job hardening
6. Secondary data-publication guardrails
7. Test and docs backfill

## Finding Coverage Map

This is the execution trace from audit finding to implementation work. If a line is in the audit report and appears operationally relevant, it should map here.

| Audit finding | Fix path |
| --- | --- |
| Duplicate cron delivery can rerun the same logical slot | Workstream A: slot identity, additive slot-execution persistence, duplicate suppression |
| Lease heartbeat failures are cumulative instead of consecutive | Workstream A: reset renew failure counter on success and bound renew retry semantics |
| Timeout logging is outer-layer only and can outlive the real run state | Workstream A: make timeout authoritative and unify terminal record handling |
| Scheduler-owned telemetry is too thin | Workstream A: wrapper milestones plus job-stage telemetry |
| Half-hourly lane suppresses downstream jobs when `sync-dex-liquidity` fails | Workstream B: result-aware slot helper and failure-contained half-hourly flow |
| Daily `08:00 UTC` lane suppresses `sync-usds-status` behind `fetch-tbill-rate` | Workstream B: decouple sequential execution from failure propagation |
| Breakers heal on `skipped_locked` or non-upstream degraded outcomes | Workstream B: outcome-aware breaker mapping |
| `sync-stablecoins` is opaque while running | Workstream C: explicit stage telemetry |
| `sync-stablecoins` conflates upstream health with validation/publication failure | Workstream C: split provider health from publication health |
| `sync-stablecoins` can publish materially stale data as healthy-with-warning | Workstream C: stale-data degraded/no-write semantics |
| PSI can publish a falsely calm sample when `depeg_events` is unavailable | Workstream D: PSI fail-closed behavior |
| DEWS bootstrap grace is keyed to the wrong freshness source | Workstream D: bootstrap sentinel or dependency-table age gating |
| `sync-bluechip` can overwrite a healthy cache with partial upstream coverage | Workstream E: partial-merge and coverage-aware degraded semantics |
| `daily-digest` can consume appendix state before Telegram delivery | Workstream E: replay-safe appendix outbox/idempotency |
| `sync-usds-status` records success too early and hides cache-write failures | Workstream E: full-sequence success semantics and degraded publication failures |
| `fetch-tbill-rate` can fall from retained market data to hardcoded fallback too early | Workstream E: retain last real market rate across degraded streaks |
| `snapshot-psi` returns `ok` on a no-sample day | Workstream E: no-sample degraded semantics |
| `discovery-scan` reports healthy when discovery is circuit-open and no scan happened | Workstream E: non-healthy no-attempt branch |
| `sync-stablecoin-charts` and `snapshot-chain-supply` can write empty/zero-like outputs too optimistically | Workstream F: non-empty publish guards and degraded/no-write semantics |
| `sync-yield-data` under-signals severe input loss | Workstream F: source validation, cardinality checks, degraded publication rules |
| Missing tests/docs leave the above regressions unguarded | Workstream G: regression suite and doc backfill |

## Execution Principles

- Fix scheduler correctness before cron-specific semantics. A duplicate-safe lease layer and coherent timeout model reduce the blast radius of every downstream job change.
- Separate source health from publication health everywhere. Breakers and operator dashboards should answer "was the upstream down?" without being polluted by local bugs or safe no-write decisions.
- Prefer preserve-and-degrade over publish-and-warn when user-visible datasets would become misleading.
- Ship observability before tuning. For long-running jobs, telemetry should land before any attempt to optimize budgets or concurrency.
- Keep each PR operationally reviewable. If a reviewer cannot tell what production invariant changed, the PR is too broad.

## Phase 0: Pre-Change Baseline

Purpose:
- Freeze a before-state so post-change impact is measurable.

Tasks:
- Save current 7d/24h cron reliability snapshots from the audit report.
- Add a one-page engineering checklist under `agents/cron-live-audit-2026-03-23/` for rollout tracking.
- Identify any pending migrations touching `cron_runs`, `cron_leases`, or status tables so the plan does not conflict with in-flight schema work.

Validation:
- No code change required.

Exit criteria:
- Baseline metrics and the rollout checklist exist under `agents/cron-live-audit-2026-03-23/`.
- Any open migration conflicts are identified before Workstream A starts.

## Workstream A: Scheduler and Lease Foundations

Priority: P0

Problems addressed:
- Duplicate slot execution after early lease release
- Cumulative heartbeat failure counting
- Timeout not being authoritative over lease lifecycle
- Thin scheduler-owned progress contract

Primary files:
- `worker/src/lib/cron-lease.ts`
- `worker/src/lib/cron-logger.ts`
- `worker/src/handlers/scheduled/context.ts`
- `worker/src/handlers/scheduled.ts`
- `shared/lib/cron-jobs.ts`
- New additive D1 migration(s)

Implementation steps:
1. Introduce a slot identity.
   - Derive `slot_started_at` from the scheduled event time, not from `Date.now()`.
   - Pass `event.scheduledTime` from `handleScheduledEvent()` into the scheduled runtime context.
   - Standardize a helper that normalizes scheduled time to a per-job bucket.

2. Add additive slot-execution persistence.
   - Preferred approach: new table such as `cron_slot_executions(job, slot_started_at, state, lease_owner, started_at, finished_at, updated_at)`.
   - Use it to enforce one logical execution per `(job, slot_started_at)` while keeping `cron_leases` for overlap prevention.
   - Keep all new columns/tables nullable/additive so old code can coexist during rollout.

3. Make acquisition idempotent per slot.
   - If a completed slot execution already exists, exit early with a new neutral status or a structured `skipped_duplicate` metadata path.
   - If the same slot is in flight, return `skipped_locked`.

4. Make heartbeat loss consecutive, not cumulative.
   - Reset `renewFailures` after a successful renew.
   - Wrap renewals in bounded retry/backoff similar to acquire/release.

5. Make timeout authoritative.
   - Ensure timeout abort stops further lease heartbeats immediately.
   - Ensure release/cleanup respects the same abort context as much as Workers semantics permit.
   - Avoid the current "timed out in logs while work still runs" behavior.

6. Strengthen scheduler-owned telemetry.
   - Standard milestones from wrapper: `started`, `lease-acquired`, `timed-out`, `completed`, `skipped-locked`, `skipped-duplicate`.
   - Keep per-job stage progress on top of this.

Acceptance criteria:
- A duplicated delivery for the same slot cannot mutate data twice.
- Two non-consecutive transient renew misses do not kill a healthy long run.
- Timeout immediately stops lease heartbeats and leaves one coherent terminal record.

Tests to add:
- Duplicate slot delivery suppression
- Consecutive-vs-cumulative renew-failure behavior
- Timeout stops heartbeat path
- Scheduler-level progress lifecycle

Rollout notes:
- Deploy schema first.
- Deploy code that writes new slot execution records while still tolerating their absence.
- Remove fallback code only after confirming stable writes in production.

Dependencies:
- None. This is the foundation for the rest of the program.

## Workstream B: Shared-Slot Orchestration and Breaker Semantics

Priority: P0/P1

Problems addressed:
- Half-hourly and daily `08:00` failure fan-out
- Breakers healing on degraded/skipped outcomes

Primary files:
- `worker/src/handlers/scheduled/half-hourly.ts`
- `worker/src/handlers/scheduled/daily-0800.ts`
- `worker/src/handlers/scheduled/hourly-blacklist.ts`
- `worker/src/handlers/scheduled/mint-burn-slot.ts`
- `worker/src/lib/circuit-breaker.ts`
- Optional new helper under `worker/src/handlers/scheduled/`

Implementation steps:
1. Introduce a result-aware slot helper.
   - Quarter-hourly already has the right pattern: catch, log, continue selectively.
   - Extract a reusable helper that returns a normalized cron outcome object instead of raw promise chaining.

2. Refactor the half-hourly lane.
   - Keep true dependencies explicit:
     - `sync-stablecoin-charts`
     - `sync-dex-liquidity`
     - `compute-dews`
     - `stability-index`
     - `sync-yield-data`
   - If `sync-dex-liquidity` fails, downstream jobs should still run against last-known-good tables when safe, and mark themselves degraded if inputs are stale or missing.

3. Refactor the daily `08:00` lane.
   - `fetch-tbill-rate` and `sync-usds-status` should no longer be coupled by raw `.then()`.
   - They can remain sequential if connection pool pressure requires it, but failure of one must not suppress the other.

4. Make breaker bookkeeping outcome-aware.
   - Define source-outcome mapping:
     - `ok` => success
     - `degraded` => neutral or source-specific
     - `skipped_locked` / duplicate-skip => neutral
     - thrown exception / explicit upstream failure => failure
   - Apply first to blacklist and mint/burn, then review similar patterns elsewhere.

5. Restore alert visibility on breaker transitions where operationally important.

Acceptance criteria:
- `sync-dex-liquidity` failure no longer erases the rest of the half-hourly lane.
- `fetch-tbill-rate` failure no longer suppresses `sync-usds-status`.
- `skipped_locked` cannot close a breaker.

Tests to add:
- Half-hourly continuation after upstream failure
- Daily `08:00` slot continuation after `fetch-tbill-rate` failure
- Breaker neutral handling for `skipped_locked` and `degraded`

Dependencies:
- Workstream A should land first so slot identity and terminal statuses are stable.

## Workstream C: Stablecoins Lane Observability and Publication Semantics

Priority: P0/P1

Problems addressed:
- Opaque long runs
- Upstream/downstream health conflation
- Warning-only stale publish behavior

Primary files:
- `worker/src/cron/sync-stablecoins.ts`
- `worker/src/cron/sync-stablecoins/intake.ts`
- `worker/src/cron/sync-stablecoins/metadata.ts`
- `worker/src/cron/sync-stablecoins/post-enrichment.ts`
- `worker/src/lib/cron-progress.ts`

Implementation steps:
1. Add mandatory stage telemetry to `sync-stablecoins`.
   - Recommended stages:
     - `intake`
     - `supplemental-assets`
     - `price-enrichment`
     - `price-validation`
     - `cache-validation`
     - `cache-write`
     - `depeg-pipeline`
     - `complete`
   - Include counts and elapsed hints where cheap.

2. Split source health from publication health.
   - Stop marking `DL_STABLECOINS=false` for local schema/validation bugs after a successful upstream response.
   - Keep distinct metadata fields for `upstreamFetchOk`, `payloadAccepted`, `cacheWriteSucceeded`, `depegPipelineSucceeded`.

3. Tighten stale-data publishing policy.
   - Convert severe staleness from warning-only into `degraded` and optionally no-write if threshold is exceeded.
   - Keep a documented threshold and make it testable.

4. Review skip semantics.
   - Ensure `skipped_locked` and duplicate-slot handling leave enough metadata for incident analysis.

Acceptance criteria:
- A future stablecoin timeout can be localized to a stage from production telemetry alone.
- DefiLlama breaker state reflects provider health, not local validation bugs.
- Severe stale-price scenarios cannot silently publish as healthy.

Tests to add:
- Stage progress emission
- Upstream success plus local validation failure does not open breaker
- Severe staleness degraded/no-write path

Docs to update on implementation:
- `docs/data-pipeline.md`
- `docs/worker-and-api-limits.md`
- `docs/testing.md`

Dependencies:
- Workstream B should land first if stablecoin status semantics are going to reuse the new normalized outcome model.

## Workstream D: PSI and DEWS Correctness Fixes

Priority: P1

Problems addressed:
- PSI can understate risk when `depeg_events` is unavailable
- DEWS bootstrap grace remains effectively always on

Primary files:
- `worker/src/cron/stability-index.ts`
- `worker/src/cron/compute-dews.ts`
- `worker/src/handlers/scheduled/half-hourly.ts`

Implementation steps:
1. Make PSI fail closed on critical input loss.
   - If `depeg_events` read fails, return degraded/no-write rather than computing against `[]`.
   - Preserve last good sample rather than publishing a misleading calm sample.

2. Replace DEWS bootstrap grace logic.
   - Prefer a real bootstrap sentinel:
     - one-time migration marker
     - or table-age/row-count threshold by source table
   - Bootstrap allowance should expire based on the dependent table state, not stablecoins cache freshness.

3. Revisit downstream dependency semantics.
   - If DEWS runs against stale dex tables because the prior step failed, its metadata should say so explicitly and degrade accordingly.

Acceptance criteria:
- PSI never publishes a normal sample when the open-depeg query failed.
- Missing DEWS dependency tables stop being indefinitely bootstrap-allowed once the system is live.

Tests to add:
- PSI depeg query failure => degraded/no-write
- DEWS bootstrap expiration behavior
- DEWS stale-input degradation after upstream half-hourly failure

Docs to update on implementation:
- `docs/stability-index.md`
- `docs/stability-index-timeline.md`
- `docs/dews.md`
- `docs/depeg-dews-timeline.md`
- `docs/methodology-page.md`
- Relevant `/src/app/methodology/*` sections if text is duplicated in app routes

Dependencies:
- Workstream B should land first so DEWS/PSI can rely on the new continuation semantics in half-hourly slots.

## Workstream E: Daily Publication and Reference Job Hardening

Priority: P1

Problems addressed:
- Bluechip partial overwrite
- Digest appendix loss on Telegram failure
- USDS success semantics too optimistic
- T-bill fallback retention bug
- `snapshot-psi` healthy skip on no samples
- `discovery-scan` healthy status on no work

Primary files:
- `worker/src/cron/sync-bluechip.ts`
- `worker/src/cron/daily-digest.ts`
- `worker/src/cron/sync-usds-status.ts`
- `worker/src/cron/fetch-tbill-rate.ts`
- `worker/src/cron/snapshot-psi.ts`
- `worker/src/cron/discovery-scan.ts`
- `docs/digest-pipeline.md`

Implementation steps:
1. `sync-bluechip`
   - Preserve prior cache when only a subset of slugs succeeds.
   - Merge successful fresh rows into the last-known-good map.
   - Degrade when coverage shrinks materially.

2. `daily-digest`
   - Replace `commitSuccess()`-before-send with a replay-safe outbox/state model.
   - Recommended path:
     - prepare appendix payload
     - send Telegram
     - mark appendix items consumed only after confirmed success
   - Add idempotency keyed by digest edition/date to prevent duplicates.

3. `sync-usds-status`
   - Record provider success only after the full provider-dependent probe sequence succeeds.
   - Treat cache-write failure as degraded publication failure, not success.

4. `fetch-tbill-rate`
   - Preserve last non-fallback market rate across repeated degraded days.
   - Keep fallback provenance explicit in cache payload.

5. `snapshot-psi`
   - Treat "no samples for yesterday" as degraded unless explicitly proven benign.

6. `discovery-scan`
   - Return degraded or neutral-skip when CoinGecko discovery is circuit-open and no scan was attempted.

Acceptance criteria:
- Partial upstream success no longer wipes good cache rows.
- Telegram appendix state cannot be silently consumed before delivery.
- Repeated T-bill failure days do not degrade to the hardcoded rate if a better market-derived rate exists.

Tests to add:
- Bluechip partial merge/no-overwrite
- Digest appendix retry/idempotency behavior
- USDS cache-write failure => degraded
- Second consecutive T-bill degraded day retains last real rate
- `snapshot-psi` no-sample day => degraded
- `discovery-scan` no-attempt branch => non-healthy status

Docs to update on implementation:
- `docs/digest-pipeline.md`
- `docs/architecture.md`
- `docs/testing.md`
- `docs/stability-index.md` and timeline docs if snapshot semantics materially change

Dependencies:
- Independent of Workstream D for most items, but `snapshot-psi` changes should be coordinated with Workstream D docs.

## Workstream F: Secondary Data-Publication Guardrails

Priority: P2

Problems addressed:
- Empty chart cache write can succeed
- Zero-row chain snapshot can look healthy
- Yield direct-fetch and on-chain degradation under-signaled

Primary files:
- `worker/src/cron/sync-stablecoin-charts.ts`
- `worker/src/cron/snapshot-chain-supply.ts`
- `worker/src/cron/sync-yield-data.ts`
- `worker/src/cron/yield-sync/sources.ts`
- `worker/src/cron/yield-sync/publication.ts`

Implementation steps:
1. `sync-stablecoin-charts`
   - Add a guard for `downsampled.length === 0`.
   - Preserve last-known-good cache on empty or absurdly small publish sets.

2. `snapshot-chain-supply`
   - Add degraded/no-write semantics when no valid per-chain rows are produced unexpectedly.

3. Yield inputs
   - Add schema/minimum-cardinality validation to direct DefiLlama pool fetch.
   - Explicitly degrade when all deterministic on-chain rate fetches fail.
   - Review whether rankings cache should be skipped on severe source shrink.

Acceptance criteria:
- Empty downstream caches cannot be written as healthy outputs.
- Yield `ok` means materially acceptable input quality, not just non-zero coverage.

Tests to add:
- Charts non-empty publish guard
- Chain snapshot zero-row degraded path
- Yield direct-fetch schema failure
- Yield all-on-chain-failure degraded path

Docs to update on implementation:
- `docs/yield-intelligence.md`
- `docs/yield-intelligence-timeline.md`
- `docs/supply-snapshot.md`

Dependencies:
- Can run in parallel with late Workstream E items if file ownership stays separate.

## Workstream G: Tests and Documentation Backfill

Priority: P1/P2, but execute continuously with each workstream

Tasks:
- Add scheduled-handler coverage for daily `08:00` and `08:05`.
- Add direct tests for `weekly-recap`.
- Add slot-level continuation tests, duplicate-slot tests, breaker-neutral tests, and timeout semantics tests.
- Update any doc that describes current behavior incorrectly, especially digest appendix delivery.
- When PSI/DEWS semantics change, update both core docs and timeline/changelog docs.

Validation commands per PR:
- `npm test -- <targeted files>`
- `npm run lint`
- `npm run build`
- `cd worker && npx tsc --noEmit`
- `npm run test:merge-gate`

## Suggested PR Breakdown

PR 1: Scheduler and lease foundations
- Slot identity
- Additive schema
- Consecutive renew failure logic
- Base telemetry contract

PR 2: Shared-slot orchestration and breaker semantics
- Half-hourly + daily `08:00`
- Breaker result mapping
- Scheduler tests

PR 3: Stablecoins observability and source/publication split
- Progress stages
- Breaker semantics
- Staleness publishing rules

PR 4: PSI and DEWS correctness
- PSI fail-closed
- DEWS bootstrap sentinel
- Methodology docs

PR 5: Daily publication/reference hardening
- Bluechip
- Digest appendix outbox
- USDS
- T-bill retention
- Snapshot/discovery status semantics

PR 6: Secondary guardrails and remaining test gaps
- Charts
- Chain supply
- Yield validation
- Weekly recap tests

Suggested execution cadence:
- Week 1: PR 1
- Week 2: PR 2 and PR 3
- Week 3: PR 4
- Week 4: PR 5 and PR 6

This cadence should compress only if the production watch data stays quiet after each deploy wave.

## Rollout Strategy

- Deploy PR 1 alone and observe for at least one full cron day.
- Deploy PR 2 next; confirm no downstream slot suppression in live runs.
- Deploy PR 3 before changing stablecoins time-budget knobs, so new telemetry is live first.
- Deploy PR 4 and PR 5 separately because they affect user-visible semantics and may require docs publication in the same release.
- Deploy PR 6 last as hardening once the primary failure modes are fixed.

## Success Metrics

- `sync-stablecoins` has stage-level telemetry on every run.
- Duplicate-slot execution count is zero.
- `skipped_locked` never heals a breaker.
- A failed `sync-dex-liquidity` run no longer suppresses PSI/DEWS/yield execution.
- PSI never writes a normal sample when `depeg_events` is unavailable.
- `sync-yield-data` degraded rate drops materially once `fetch-tbill-rate` retention and input validation fixes ship.
- Cache-preservation jobs no longer shrink payloads silently on partial upstream success.

## Open Decisions

- Whether duplicate-slot suppression should surface as a new cron status or remain `skipped_locked` with richer metadata.
- Whether severe stablecoin staleness should block writes entirely or allow degraded writes with downstream-safe disabled.
- Whether yield should degrade on any deterministic on-chain failure, or only when the failure affects all configured on-chain sources.
- Whether digest appendix delivery should use a dedicated outbox table or extend existing cache/state records.
