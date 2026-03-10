# Cron Reliability Remediation — Implementation Plan

> Implementation plan for the March 9, 2026 cron audit findings.
> Scope is limited to the four requested issues:
> 1. `sync-stablecoins` depeg-detection degradation and downstream scheduling safety
> 2. `status-self-check` degradation from `/api/peg-summary` `500` plus cache-backed `503`s
> 3. `sync-mint-burn` live-cron under-capacity
> 4. `sync-yield-data` withholding the public `yield-rankings` cache under low safety coverage

## Objective

Restore cron correctness and public API availability without a broad architecture rewrite.

The plan is intentionally phased:

- Fix deterministic runtime regressions first.
- Make scheduler gating capability-aware instead of boolean-only.
- Make status probes reflect real user risk instead of bootstrap noise.
- Publish usable degraded data where possible instead of falling back to `503`.
- Stabilize mint/burn capacity with fairness and explicit backlog controls before considering new schedules.

## Findings Covered

1. `sync-stablecoins` degraded every observed 15-minute run because depeg detection threw `ReferenceError: metaById is not defined`, but downstream jobs still ran off a cache that looked fresh.
2. `status-self-check` degraded every observed 15-minute run because `/api/peg-summary` returned `500`, and `/api/usds-status`, `/api/bluechip-ratings`, and `/api/yield-rankings` returned `503`.
3. `sync-mint-burn` is structurally under-capacity: live runs processed only 1-2 of 84 enabled configs, with critical coverage stuck at `1/7` and lag still measured in millions of blocks.
4. `sync-yield-data` wrote fresh `yield_data` rows, but skipped the public `yield-rankings` cache because safety coverage was only `16/156`.

## Non-Goals

- No PSI / DEWS / report-card methodology redesign.
- No full cron topology rewrite unless the mint/burn stabilization phase proves the current slot cannot be salvaged.
- No opportunistic UI work outside status and cache-contract fallout.
- No destructive D1 backfill/reset operations as part of the code rollout.

## Success Criteria

### Correctness

- Quarter-hourly slot runs without `ReferenceError` in `sync-stablecoins` or `/api/peg-summary`.
- Depeg-dependent downstream jobs do not run against a partially failed depeg pipeline.
- `yield-rankings` returns `200` with fresh or degraded-but-usable data after each successful half-hourly slot.

### Status / Operability

- `status-self-check` distinguishes hard route failures from bootstrap/cache-miss conditions.
- `/api/status` tracks `dispatch-telegram-alerts-daily` as a named cron.
- Cron metadata exposes enough detail to explain degraded states without log spelunking.

### Capacity

- `sync-mint-burn` guarantees progress on critical configs every run.
- A single hot config cannot consume the full cron budget.
- Critical mint/burn lag has an explicit SLO and visible telemetry.

## Verification Gates

Run these after each completed phase unless the phase says otherwise:

```bash
npm run lint
npm test
cd worker && npx tsc --noEmit
npm run build
npm run coverage:critical
```

Targeted suites while developing:

```bash
npx vitest run worker/src/__tests__/index.scheduled.test.ts
npx vitest run worker/src/api/__tests__/peg-summary.test.ts
npx vitest run worker/src/api/__tests__/cache-passthrough.test.ts
npx vitest run worker/src/api/__tests__/status.test.ts
npx vitest run worker/src/cron/__tests__/sync-stablecoins.test.ts
npx vitest run worker/src/cron/__tests__/detect-depegs.test.ts
npx vitest run worker/src/cron/__tests__/sync-yield-data.test.ts
npx vitest run worker/src/lib/__tests__/safety-scores.test.ts
npx vitest run worker/src/cron/__tests__/sync-mint-burn.test.ts
```

Runtime smoke after Phases 1-3:

```bash
cd worker
npx wrangler dev --test-scheduled --persist-to <scratch-state>
```

Then manually trigger:

- `GET /__scheduled?cron=*/15 * * * *`
- `GET /__scheduled?cron=10,40 * * * *`
- `GET /api/peg-summary`
- `GET /api/usds-status`
- `GET /api/bluechip-ratings`
- `GET /api/yield-rankings`

## Execution Order

```text
Phase 1: Deterministic Runtime Fixes
  A1 fix depeg-detection runtime regression
  A2 fix peg-summary runtime regression
  A3 add compiled-runtime smoke coverage

Phase 2: Scheduler and Probe Semantics
  B1 replace one-bit downstreamSafe with explicit capability flags
  B2 make status-self-check bootstrap-aware for cache-backed endpoints
  B3 promote dispatch-telegram-alerts-daily into tracked cron health

Phase 3: Yield Availability
  C1 expose safety-coverage reasons
  C2 publish degraded yield cache instead of withholding it
  C3 optionally backfill missing safety fields from last-good cache

Phase 4: Mint/Burn Capacity Stabilization
  D1 add lag / fairness telemetry
  D2 enforce per-lane and per-config budgeting
  D3 drain critical backlog with backfill + evaluate schedule split

Phase 5: Docs and Rollout
  E1 docs
  E2 staged production rollout
  E3 post-deploy audit
```

---

## Phase 1 — Deterministic Runtime Fixes

### A1. Fix `sync-stablecoins` depeg-detection runtime regression

**Problem**

`sync-stablecoins` completes the main cache write, then degrades because depeg detection throws. That leaves the stablecoins cache looking fresh even when the depeg pipeline is broken.

**Primary files**

- `worker/src/cron/sync-stablecoins.ts`
- `worker/src/cron/detect-depegs.ts`
- `worker/src/cron/confirm-pending-depegs.ts`
- `worker/src/lib/depeg-helpers.ts`
- `worker/src/__tests__/index.scheduled.test.ts`
- `worker/src/cron/__tests__/detect-depegs.test.ts`

**Recommended implementation**

1. Reproduce the failure under a real scheduled run in a stable local harness.
2. Remove ad-hoc local metadata map construction where possible and use canonical exported maps:
   - prefer `PSI_ELIGIBLE_META_BY_ID` over rebuilding local lookup maps inside the depeg pipeline
3. Add a narrow regression test that executes the actual `syncStablecoins()` -> `detectDepegEvents()` path with representative assets and confirms no identifier/runtime errors.
4. Add a scheduled-slot test asserting that if the depeg stage fails, the returned cron metadata exposes that capability failure explicitly.

**Target state**

`sync-stablecoins` returns structured capabilities rather than one overloaded success bit:

```ts
{
  cacheWriteMode: "main-write" | "fallback-write" | "blocked-invalid-payload" | "no-write",
  capabilities: {
    stablecoinsCache: boolean,
    depegPipeline: boolean,
  },
}
```

**Acceptance**

- No `depegErrorCount` on happy-path scheduled runs.
- If depeg detection fails in tests, the failure is reflected in metadata and downstream gating, not silently tolerated.

### A2. Fix `/api/peg-summary` runtime regression

**Problem**

`status-self-check` repeatedly caught `/api/peg-summary` returning `500`, with logs showing `ReferenceError: TRACKED_STABLECOINS is not defined`.

**Primary files**

- `worker/src/api/peg-summary.ts`
- `worker/src/lib/peg-analytics.ts`
- `worker/src/api/__tests__/peg-summary.test.ts`
- `worker/src/cron/status-self-check.ts`

**Recommended implementation**

1. Reproduce through the real route handler, not only the pure helper layer.
2. Remove direct reliance on repeated imported array bindings in the handler body where a canonical exported map/set already exists:
   - prefer `TRACKED_META_BY_ID.values()` or a shared iterator helper over rebuilding from `TRACKED_STABLECOINS` in-request
3. Add a regression test that exercises the route through `router.ts` or the actual handler wrapper and validates a `200` response with a populated body.
4. Add a status-self-check focused test asserting `/api/peg-summary` stays probeable under the same seeded DB used by the cron harness.

**Acceptance**

- `/api/peg-summary` returns `200` in runtime smoke.
- `status-self-check` no longer records `500` probe failures for that route.

### A3. Add compiled-runtime smoke coverage

**Problem**

Both observed `ReferenceError`s appeared in live Worker execution even though the TypeScript sources look structurally valid. Unit tests alone are not a sufficient guard.

**Primary files**

- `worker/src/__tests__/index.scheduled.test.ts`
- `scripts/` new smoke helper if needed
- CI workflow if a new smoke job is added later

**Recommended implementation**

1. Extend the existing scheduled test coverage for slot-level orchestration.
2. If Vitest cannot reliably catch the Worker-runtime version of these regressions, add a lightweight smoke script that runs:
   - quarter-hourly scheduled trigger once
   - `GET /api/peg-summary`
   - `GET /api/yield-rankings`
3. Keep that smoke out of the default unit suite if it is too slow, but run it in merge-gate or release verification.

---

## Phase 2 — Scheduler and Probe Semantics

### B1. Replace one-bit downstream gating with capability-aware scheduling

**Problem**

`worker/src/handlers/scheduled.ts` currently uses one boolean interpretation of `sync-stablecoins` success. That is too coarse.

**Primary files**

- `worker/src/handlers/scheduled.ts`
- `worker/src/cron/sync-stablecoins.ts`
- `worker/src/cron/stability-index.ts`
- `worker/src/cron/compute-dews.ts`
- `worker/src/cron/dispatch-telegram-alerts.ts`
- `worker/src/__tests__/index.scheduled.test.ts`

**Recommended implementation**

Use capability-specific gating:

- `snapshot-supply` requires `capabilities.stablecoinsCache`
- `compute-dews` requires `capabilities.stablecoinsCache`
- `stability-index` requires `capabilities.stablecoinsCache` and `capabilities.depegPipeline`
- `dispatch-telegram-alerts` requires `capabilities.depegPipeline` plus a completed DEWS run
- `status-self-check` continues to run unconditionally

**Why**

This is safer than either:

- letting everything run after a partial upstream failure
- or over-skipping jobs like `compute-dews` that do not actually depend on depeg detection

**Acceptance**

- Scheduler tests cover both:
  - stablecoins cache success + depeg pipeline failure
  - full success

### B2. Make `status-self-check` bootstrap-aware for cache-backed endpoints

**Problem**

Three of the four repeated probe failures were cache-backed `503`s:

- `/api/usds-status`
- `/api/bluechip-ratings`
- `/api/yield-rankings`

The first two are daily caches. Missing-cache `503` is a real route outcome, but it should not be treated the same as a broken handler during bootstrap or immediately after a reset.

**Primary files**

- `worker/src/cron/status-self-check.ts`
- `shared/lib/api-endpoints.ts`
- `worker/src/api/cache-handlers.ts`
- `worker/src/api/status.ts`
- `worker/src/api/__tests__/status.test.ts`

**Recommended implementation**

1. Extend endpoint metadata to capture probe expectations:

```ts
probePolicy?: {
  producerJob?: string,
  bootstrapGraceSec?: number,
  treatMissingCacheAsBootstrapOnly?: boolean,
}
```

2. In `status-self-check`, when a probe gets `503 "Data not yet available"` from a cache handler:
   - look up the producing cron job
   - if the producer has never had a successful run, or is still inside a defined bootstrap grace window, record `bootstrap-miss` instead of hard failure
   - if the producer has succeeded before and the cache is now missing, keep it as a real failure
3. Keep `/api/yield-rankings` in the critical set, but fix it primarily through Phase 3 so it returns `200` with degraded data rather than `503`.
4. Revisit whether daily-cache endpoints belong in the top critical probe set or in a lower-severity probe class once bootstrap-aware handling exists.

**Important design point**

Do not hide real data loss. This change is only for:

- first-run bootstrap
- newly seeded environments
- immediately after a deploy/reset when the producer cron has not yet produced data

### B3. Track `dispatch-telegram-alerts-daily` as a first-class cron

**Problem**

Runtime executes `dispatch-telegram-alerts-daily`, but `CRON_INTERVALS` does not track it, so `/api/status` omits it.

**Primary files**

- `worker/src/lib/cron-schedule.ts`
- `worker/src/api/status.ts`
- `docs/status-dashboard.md`

**Recommended implementation**

1. Add `dispatch-telegram-alerts-daily` to `CRON_INTERVALS`.
2. Group it under the daily slot in the status UI and docs.
3. Decide explicitly whether it is:
   - availability-impacting
   - or warning-only like other degraded-but-fresh jobs

---

## Phase 3 — Yield Availability

### C1. Expose safety-coverage reasons instead of a bare ratio

**Problem**

`sync-yield-data` only reports `16/156` coverage. It does not explain why.

That leaves two possibilities unresolved:

- the safety snapshot is partially correct but legitimately sparse
- the safety snapshot aborted or degraded for a narrower bug

**Primary files**

- `worker/src/lib/safety-scores.ts`
- `worker/src/cron/sync-yield-data.ts`
- `worker/src/lib/__tests__/safety-scores.test.ts`
- `worker/src/cron/__tests__/sync-yield-data.test.ts`

**Recommended implementation**

Return richer safety snapshot metadata:

```ts
{
  kind: "ok" | "degraded",
  coveredCount,
  trackedCount,
  coverageRatio,
  reason?: string,
  skippedByReason?: {
    overallNr: number,
    missingPegData: number,
    missingLiquidityData: number,
    exception: number,
  },
}
```

This does not change the scoring methodology. It only makes the yield decision explainable.

### C2. Publish degraded `yield-rankings` cache instead of withholding it

**Problem**

The half-hourly cron writes fresh `yield_data`, but the public API still returns `503` because cache publication is blocked.

**Primary files**

- `worker/src/cron/sync-yield-data.ts`
- `worker/src/api/cache-handlers.ts`
- `docs/yield-intelligence.md`
- `docs/api-reference.md`

**Recommended implementation**

1. Change the cache publication rule:
   - if the rankings payload schema is valid and the core yield rows were refreshed, write the cache even when safety coverage is partial
2. Embed degraded metadata in the payload:

```ts
{
  rankings: [...],
  riskFreeRate,
  scalingFactor,
  medianApy,
  updatedAt,
  degraded: {
    reasons: [...],
    safetyCoverage: {
      coveredCount,
      trackedCount,
      coverageRatio,
      skippedByReason?: ...
    }
  }
}
```

3. Keep the cron status as `degraded` so `/api/status` still reflects the underlying issue.
4. Preserve the current hard stop only for:
   - schema invalid payloads
   - zero rankings rows
   - complete source failure

**Result**

- `/api/yield-rankings` returns `200` with degraded metadata
- `status-self-check` clears for that endpoint
- consumers can still show a warning banner if safety coverage is incomplete

### C3. Optionally backfill missing safety fields from last-good cache

**Problem**

If the live safety snapshot is partial but a recent `report_card_cache` exists, current behavior discards that potentially useful data.

**Recommended implementation**

1. If `report_card_cache` exists, is fresh, and matches the current methodology version, use it to fill missing per-coin safety fields before writing `yield-rankings`.
2. Mark backfilled rows in metadata so the degraded state stays visible.
3. Do not let this fallback mask a broken live safety computation.

**Why**

This improves user-facing quality without coupling route availability to perfect live coverage.

### C4. Decouple `report_card_cache` from yield cache availability

**Problem**

`sync-yield-data` currently acts as an opportunistic writer for `report_card_cache`, which is an awkward ownership boundary.

**Recommended implementation**

Short-term:

- keep `report_card_cache` write best-effort and independent from `yield-rankings`

Follow-up:

- evaluate moving `report_card_cache` publication to a dedicated snapshot job or explicit API-side refresh path

This follow-up is not required for the immediate fix, but it should be documented as technical debt if Phase 3 ships first.

---

## Phase 4 — Mint/Burn Capacity Stabilization

### D1. Add the telemetry needed to manage the backlog

**Problem**

The cron exposes enough metadata to prove it is falling behind, but not enough to tune it safely.

**Primary files**

- `worker/src/cron/sync-mint-burn.ts`
- `worker/src/lib/mint-burn-health-config.ts`
- `worker/src/api/status.ts`
- `docs/mint-burn-flows.md`
- `docs/status-dashboard.md`

**Recommended implementation**

Add per-run telemetry for:

- `criticalConfigsTargeted`
- `criticalConfigsCompleted`
- `extendedConfigsCompleted`
- per-config budget/request consumption
- per-config scan frontier delta
- oldest / median lag for critical configs
- whether a config was skipped due:
  - global budget
  - per-config cap
  - lane budget exhaustion

Expose a compact form in cron metadata and a richer form in `/api/status`.

### D2. Enforce lane-based fairness inside the current cron

**Problem**

Critical-first ordering exists, but one hot config can still monopolize the run. That is why critical coverage is stuck at `1/7`.

**Primary files**

- `worker/src/cron/sync-mint-burn.ts`
- `worker/src/lib/mint-burn-pipeline/*`
- `worker/src/cron/__tests__/sync-mint-burn.test.ts`

**Recommended implementation**

1. Split live scheduling into two logical lanes:
   - critical lane
   - extended lane
2. Persist separate continuation state for each lane:
   - `nextCriticalIndex`
   - `nextExtendedIndex`
3. Reserve budget slices:
   - hard minimum for critical lane every run
   - leftover budget for extended lane
4. Add a per-config cap:
   - max request budget
   - or max block/log window
   - or both

The critical requirement is:

- one config must not be allowed to consume the entire global budget

5. Advance frontier and move on once the cap is hit, even if that config still has backlog.

**Target state**

- every run advances multiple critical configs
- extended configs make slower but non-zero progress

### D3. Use the existing backfill endpoint to shrink the live backlog

**Problem**

Live cron tuning alone may not recover quickly from the current multi-million-block backlog on critical configs.

**Primary files**

- `worker/src/api/backfill-mint-burn.ts`
- `docs/mint-burn-flows.md`

**Recommended implementation**

Before or during the lane rollout:

1. Identify the top lagging critical configs from current cron metadata.
2. Run targeted admin backfills in bounded chunks until critical lag is within the live cron’s steady-state envelope.
3. Keep the live cron focused on staying current, not excavating historic backlog forever.

This is an operational step, but it should be part of the implementation rollout plan because otherwise the new fairness logic will still spend weeks digging out.

### D4. Reassess schedule topology only after lane fairness lands

**Problem**

The current 20-minute slot may still be too crowded after fairness fixes.

**Recommended implementation**

Do not add new schedules first.

Instead:

1. Ship lane fairness and per-config caps.
2. Measure:
   - critical lag trend
   - average processed configs per run
   - budget utilization
3. If critical lag still does not converge, then split:
   - `sync-mint-burn-critical` onto the current 20-minute slot
   - `sync-mint-burn-extended` onto a slower dedicated cadence

Only take this step with measured evidence, because it increases orchestration complexity and status surface area.

---

## Phase 5 — Docs and Rollout

### E1. Docs to update

- `docs/worker-infrastructure.md`
- `docs/status-dashboard.md`
- `docs/data-pipeline.md`
- `docs/mint-burn-flows.md`
- `docs/yield-intelligence.md`
- `docs/api-reference.md`

Update requirements:

- new scheduler capability semantics
- status probe bootstrap policy
- `yield-rankings` degraded-cache contract
- mint/burn lane/backfill rollout and new metadata
- `dispatch-telegram-alerts-daily` as tracked cron

### E2. Rollout order

1. Phase 1 runtime fixes
2. Phase 2 scheduler/probe semantics
3. Phase 3 yield cache publication
4. Phase 4 mint/burn fairness
5. Optional mint/burn schedule split only if metrics still fail

### E3. Post-deploy audit

After rollout, repeat the same audit shape used in the original report:

- 3 consecutive quarter-hourly runs
- 3 consecutive half-hourly runs
- 3 consecutive daily runs
- at least 3 observed 20-minute invocations, including skipped-locked behavior

The post-deploy audit should confirm:

- no `ReferenceError` in quarter-hourly slot or `peg-summary`
- `yield-rankings` returns `200`
- status probes no longer treat daily bootstrap misses as hard failures
- mint/burn critical coverage rises above the current `1/7` floor

## Recommended First PR Breakdown

### PR 1 — Runtime Safety

- Fix `detect-depegs` runtime regression
- Fix `/api/peg-summary` runtime regression
- Add regression tests

### PR 2 — Quarter-Hour Capability Gating + Status Probe Policy

- Add structured `capabilities` metadata
- Gate quarter-hour downstream jobs by capability
- Add bootstrap-aware probe semantics
- Add `dispatch-telegram-alerts-daily` to tracked cron inventory

### PR 3 — Yield Availability

- Add safety coverage reason metadata
- Publish degraded `yield-rankings`
- Backfill missing safety fields from last-good cache if safe

### PR 4 — Mint/Burn Stabilization

- Add lane telemetry
- Add critical/extended continuation state
- Add per-config caps and fairness
- Prepare backfill rollout notes

This ordering gets the user-visible and operator-visible failures out first, then addresses the long-tail capacity issue without mixing it into the runtime hotfix PRs.
