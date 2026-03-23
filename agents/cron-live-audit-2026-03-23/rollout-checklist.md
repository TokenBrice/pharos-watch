# Cron Reliability Rollout Checklist

Use this alongside `implementation-plan.md` during execution.

## Phase 0: Baseline

- [ ] Freeze the before-state metrics from `report.md`
- [ ] Confirm no in-flight D1 migration conflicts for cron tables/state
- [ ] Define the deploy order and rollback owner for each PR

## PR 1: Scheduler and Lease Foundations

- [ ] Add slot identity derived from scheduled time
- [ ] Add additive slot execution persistence
- [ ] Suppress duplicate slot delivery
- [ ] Reset renew failures on successful heartbeat
- [ ] Make timeout authoritative over heartbeat/cleanup lifecycle
- [ ] Add scheduler-level progress milestones
- [ ] Add duplicate-slot, renew-failure, timeout, and telemetry tests
- [ ] Run `npm run lint`
- [ ] Run `npm run build`
- [ ] Run `cd worker && npx tsc --noEmit`
- [ ] Run targeted tests
- [ ] Run `npm run test:merge-gate`
- [ ] Observe production for at least one full cron day

## PR 2: Shared-Slot Orchestration and Breakers

- [ ] Refactor half-hourly lane to failure-contained execution
- [ ] Refactor daily `08:00 UTC` lane to avoid suppression coupling
- [ ] Make breaker bookkeeping outcome-aware
- [ ] Add continuation and neutral-breaker tests
- [ ] Run repo validation commands
- [ ] Confirm live runs no longer suppress downstream jobs

## PR 3: Stablecoins Observability and Publication Semantics

- [ ] Add `sync-stablecoins` stage telemetry
- [ ] Split upstream/provider health from publication health
- [ ] Tighten severe staleness handling
- [ ] Add stablecoins telemetry and publication tests
- [ ] Update pipeline/testing docs
- [ ] Confirm production telemetry exposes stage-localized progress

## PR 4: PSI and DEWS Correctness

- [ ] Make PSI fail closed when `depeg_events` is unavailable
- [ ] Replace DEWS bootstrap grace with dependency-aware bootstrap logic
- [ ] Add stale-input metadata for downstream DEWS runs
- [ ] Add PSI/DEWS regression tests
- [ ] Update methodology docs and timeline docs
- [ ] Confirm no misleading PSI samples are published in failure drills

## PR 5: Daily Publication and Reference Jobs

- [ ] Preserve prior Bluechip cache on partial upstream coverage
- [ ] Make digest appendix delivery replay-safe
- [ ] Fix `sync-usds-status` success/publication semantics
- [ ] Retain last real T-bill rate across degraded streaks
- [ ] Mark `snapshot-psi` no-sample days degraded
- [ ] Mark `discovery-scan` no-attempt circuit-open branch non-healthy
- [ ] Add targeted regressions
- [ ] Update digest and architecture docs

## PR 6: Secondary Guardrails and Backfill

- [ ] Add non-empty publish guard to stablecoin charts
- [ ] Add zero-row degraded/no-write guard to chain supply snapshots
- [ ] Strengthen yield input validation and degraded thresholds
- [ ] Add `weekly-recap` direct coverage
- [ ] Add remaining test/doc backfill
- [ ] Run full repo validation again

## Release Gates

- [ ] Each PR deployed independently or with an explicitly justified bundle
- [ ] No PR is pushed before `npm run test:merge-gate` passes locally
- [ ] Production monitoring reviewed after each deploy wave
- [ ] Report any production delta back into `report.md` or a follow-up note under `agents/`
