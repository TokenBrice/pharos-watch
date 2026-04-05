# Yield Schedule Refactor Plan — 2026-03-26

## Goal

Execute the three yield-operability ideas as a staged rollout:

1. move yield publication from 30-minute cadence to hourly
2. add deterministic on-chain failure cooldown / fast-fail behavior
3. split yield into hourly core publication plus slower supplemental-source refresh

This plan assumes we will implement all three, but not in one PR. Each phase should be shipped and observed before the next phase starts.

## Why This Needs Phasing

The current `sync-yield-data` runtime is no longer explained by simple scheduling alone. The scope expansion is real, but the telemetry also shows a pathological slow path when deterministic on-chain reads fail across the board.

As of 2026-03-26:

- half-hourly shared slot is not close to saturation overall
- `sync-yield-data` is the noisiest non-critical job operationally
- the recent worst cases are driven by expanded source resolution plus deterministic all-fail retries

So the right sequencing is:

- first reduce cadence
- then reduce wasted work on known-bad deterministic runs
- then separate core freshness from supplemental enrichment

## Current Constraints

- `sync-yield-data` currently runs in the shared half-hourly lane after:
  - `sync-stablecoin-charts`
  - `sync-dex-liquidity`
  - `compute-dews`
  - `stability-index`
- Yield depends on fresh DEX liquidity and stablecoin cache state, so we should not move it to an overlapping earlier trigger.
- The existing hourly reserve slot at `11 * * * *` is too close to the `10,40 * * * *` half-hourly slot start to be a clean dependency target.
- Any schedule change must keep:
  - `worker/wrangler.toml`
  - `shared/lib/cron-jobs.ts`
  - scheduler dispatch in `worker/src/handlers/scheduled.ts`
  - schedule/connection guard scripts
  in sync.

## Rollout Shape

### Phase 1

Ship a true hourly yield trigger for `sync-yield-data`.

### Phase 2

Keep the hourly trigger, but make deterministic on-chain reads back off after repeated masked all-fail runs.

### Phase 3

Keep `sync-yield-data` as the hourly publisher, and move optional protocol-family enrichment into a separate slower cron.

## Phase 1 — Hourly Yield Only

### Objective

Reduce yield runtime pressure and noisy half-hourly churn by running the existing `sync-yield-data` only once per hour.

### Design Decision

Use a new dedicated hourly trigger for yield rather than:

- piggybacking on the existing reserve-sync hourly slot
- keeping the current half-hourly trigger and adding only an internal cooldown

Reason:

- piggybacking on `11 * * * *` is too close to the half-hourly slot start and can race fresh DEX-liquidity completion
- an internal cooldown would reduce work, but it would not actually simplify the schedule topology or status semantics

### Proposed Schedule

- Add a dedicated hourly yield trigger after the half-hourly lane has had time to finish.
- Preferred target: `20 * * * *`

Why `20 * * * *`:

- it gives the `10 * * * *` half-hourly run roughly 10 minutes of wall-clock headroom
- recent half-hourly worst-case observed total runtime was about 8.5 minutes
- it avoids overlapping the `40 * * * *` half-hourly slot

### Implementation Steps

1. Add a new cron expression to [worker/wrangler.toml](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/wrangler.toml).
2. Add a new schedule key to [shared/lib/cron-jobs.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/cron-jobs.ts).
3. Move `sync-yield-data` off the half-hourly slot metadata and onto the new hourly schedule key.
4. Add a new scheduled runner file, likely:
   - `worker/src/handlers/scheduled/hourly-yield.ts`
5. Register the new runner in [worker/src/handlers/scheduled.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/handlers/scheduled.ts).
6. Remove `sync-yield-data` invocation from [worker/src/handlers/scheduled/half-hourly.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/handlers/scheduled/half-hourly.ts).
7. Keep the job name `sync-yield-data` unchanged so status/API/admin surfaces remain stable.

### Files Expected To Change

- [worker/wrangler.toml](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/wrangler.toml)
- [shared/lib/cron-jobs.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/cron-jobs.ts)
- [worker/src/handlers/scheduled.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/handlers/scheduled.ts)
- [worker/src/handlers/scheduled/half-hourly.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/handlers/scheduled/half-hourly.ts)
- new `worker/src/handlers/scheduled/hourly-yield.ts`
- [worker/src/__tests__/index.scheduled.test.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/__tests__/index.scheduled.test.ts)
- possibly cron/status tests that assert current group membership or trigger count

### Docs To Update

- [docs/worker-and-api-limits.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/worker-and-api-limits.md)
- [docs/worker-infrastructure.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/worker-infrastructure.md)
- [docs/yield-intelligence-operations.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/yield-intelligence-operations.md)
- [docs/testing.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/testing.md) only if wording depends on trigger count or schedule map

### Validation

- `npm run check:cron-sync`
- `npm run check:cron-connections`
- `npm test -- worker/src/__tests__/index.scheduled.test.ts`
- `npm test -- worker/src/cron/__tests__/sync-yield-data.test.ts`
- `cd worker && npx tsc --noEmit`

### Rollout Success Criteria

Observe for at least 24 hours:

- half-hourly slot runtime drops materially
- yield job run count halves
- no stale data regression on `/yield`
- no new schedule fencing or status-health anomalies

### Expected Outcome

- immediate reduction in cron frequency and operational noise
- no architectural change yet
- deterministic failure path still exists, just happens half as often

## Phase 2 — Deterministic Cooldown / Fast-Fail

### Objective

Stop `sync-yield-data` from spending minutes re-proving a known-bad deterministic lane when alternative sources already preserve publication coverage.

### Problem To Solve

Today the slow path is:

- deterministic configs are attempted sequentially
- each config may burn time across RPC and explorer fallbacks
- when all deterministic sources are down, the run can still be publishable, but it wastes most of the runtime budget getting there

### Design Decision

Track deterministic-lane health in a dedicated cached state object and skip deterministic probes temporarily after repeated masked all-fail runs.

Do not implement this by querying `cron_runs` inside every yield run. That would work, but it unnecessarily couples runtime control logic to historical cron storage and makes testability worse.

### Proposed State Model

Store a cache key, for example:

- `yield:onchain-health`

Payload fields:

- `consecutiveAllFailRuns`
- `lastAllFailAt`
- `cooldownUntil`
- `lastSuccessfulProbeAt`
- `lastFailureMaskedByAlternativeCoverage`
- `lastAlternativeCoverageMissingIds`

### Proposed Runtime Policy

1. Run deterministic lane normally by default.
2. After each yield run:
   - if `onChainAllDeterministicFailed === true`
   - and `onChainAlternativeCoverageMissingIds.length === 0`
   then increment the masked-failure streak.
3. When streak reaches threshold:
   - recommended initial threshold: 2 consecutive runs
   - set cooldown for 1 hour
4. During cooldown:
   - skip `fetchOnChainRates()` entirely
   - annotate metadata so ops can see this was an intentional skip, not a silent omission
5. Any successful deterministic resolution clears streak and cooldown.
6. If alternative coverage is missing for any deterministic-configured asset, do not enter cooldown.

### Why This Version

- it directly targets the expensive failure mode
- it keeps correctness bias where deterministic-only coverage still matters
- it is transparent in cron metadata and status review

### Implementation Steps

1. Add a small helper module, likely:
   - `worker/src/cron/yield-sync/health-state.ts`
2. Read health state at the beginning of [worker/src/cron/sync-yield-data.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-yield-data.ts).
3. If cooldown is active, bypass deterministic fetch and surface metadata like:
   - `onChainSkippedByCooldown: true`
   - `onChainCooldownUntil`
4. Update health state after evaluation, once `onChainAlternativeCoverageMissingIds` is known.
5. Extend metadata emitted by `sync-yield-data` so ops can distinguish:
   - genuine deterministic probe failures
   - cooldown-protected skips
6. Keep cooldown logic local to yield and do not generalize it into shared cron infrastructure yet.

### Files Expected To Change

- [worker/src/cron/sync-yield-data.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-yield-data.ts)
- [worker/src/cron/yield-sync/sources.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-sync/sources.ts) if fetch metadata needs a richer return shape
- new `worker/src/cron/yield-sync/health-state.ts`
- yield tests under:
  - [worker/src/cron/__tests__/sync-yield-data.test.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/sync-yield-data.test.ts)
  - [worker/src/cron/__tests__/yield-cache.test.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/yield-cache.test.ts)
  - possibly new dedicated test file for the health-state helper

### Docs To Update

- [docs/yield-intelligence-operations.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/yield-intelligence-operations.md)
- [docs/worker-infrastructure.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/worker-infrastructure.md) if timeout/failure semantics are described there

### Validation

- targeted unit tests for cooldown state transitions
- targeted yield cron tests for:
  - repeated all-fail masked runs entering cooldown
  - deterministic success clearing cooldown
  - alternative-coverage-missing preventing cooldown
- full:
  - `npm test`
  - `npm run check:doc-sync` if any enforced docs touch yield semantics
  - `cd worker && npx tsc --noEmit`

### Rollout Success Criteria

Observe for at least 48 hours:

- hourly yield run duration collapses toward the healthy path when deterministic sources are down
- no additional timeout errors
- no regression in published row counts that is attributable to cooldown behavior

### Expected Outcome

- the yield job becomes operationally cheap during deterministic outages
- timeout risk becomes much lower without relaxing correctness

## Phase 3 — Split Core And Supplemental Yield

### Objective

Separate:

- fresh, high-value, publication-critical yield paths
from
- slow, optional, enrichment-heavy supplemental families

This is the long-term architecture cleanup.

### Design Decision

Keep `sync-yield-data` as the hourly core publisher and introduce a new slower cron for supplemental families.

Do not rename the existing public job unless there is a strong reason. Keeping `sync-yield-data` as the publisher minimizes status/admin churn.

### Recommended Cadence

- `sync-yield-data` core publisher: hourly
- new supplemental refresh job: every 4 hours

Why 4 hours:

- enough reduction to materially lower external-source churn
- still fresh enough for non-core opportunity rows
- easier operational story than 2 hours for the first split

### Core vs Supplemental Split

#### Keep In Core

- cached DeFiLlama pool loading
- deterministic on-chain native yield reads
- price-derived APY
- rate-derived APY
- single-asset native protocol sources that are direct source-of-truth for specific tracked assets:
  - BIMA sUSBD
  - Hashnote USYC
  - Ondo USDY oracle
  - B.Protocol LQTY-only
- auto-lending selection from already-loaded DeFiLlama pools
- evaluation, arbitration, persistence, publish

#### Move To Supplemental

- Morpho
- Pendle
- Yearn/Kong
- Beefy
- Compound V3 direct supply rates
- Aave V3 direct supply rates

These are the broad optional families that add runtime and external dependency surface but are not required to keep the yield page alive.

### Data Flow Proposal

1. New supplemental cron computes normalized `ResolvedYieldCandidate[]` style rows for the optional families.
2. Supplemental cron writes them to a dedicated cache snapshot.
3. Hourly core cron loads that snapshot if it is fresh enough.
4. Core cron appends supplemental candidates to the resolved set before evaluation.
5. If the supplemental snapshot is stale or missing, core cron still publishes using core-only sources.

### Storage Proposal

Use a D1 cache entry first, not a new table.

Suggested key:

- `yield:supplemental-sources:v1`

Suggested payload:

- `generatedAt`
- `families`
- `rows`
- `familyFailures`
- `familyCoverage`

Why a cache entry first:

- smaller migration surface
- easy invalidation/versioning
- good fit for “latest snapshot” enrichment data

If the payload becomes too large or needs row-level historical introspection later, move to a dedicated table in a follow-up.

### Freshness Policy

- core cron accepts supplemental snapshot if age <= 6 hours
- 4-hour cron target plus 6-hour TTL gives one missed run of tolerance
- when snapshot age > 6 hours:
  - core cron ignores supplemental rows
  - core cron records degraded metadata only if the absence materially changes publication coverage expectations

### New Job Surface

Recommended new job:

- `sync-yield-supplemental`

Recommended new trigger:

- `25 */4 * * *`

Reason:

- offset from the hourly core yield run
- isolated trigger keeps optional-family retries away from core publication

### Implementation Steps

1. Add new trigger schedule to [worker/wrangler.toml](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/wrangler.toml).
2. Add new cron metadata entry to [shared/lib/cron-jobs.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/cron-jobs.ts).
3. Add a scheduled runner:
   - `worker/src/handlers/scheduled/four-hourly-yield-supplemental.ts`
4. Extract current optional-family fetch logic out of [worker/src/cron/yield-sync/resolve.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-sync/resolve.ts) into a dedicated supplemental module, for example:
   - `worker/src/cron/yield-sync/supplemental.ts`
5. Add cache read/write helpers, for example:
   - `worker/src/cron/yield-sync/supplemental-cache.ts`
6. Change core resolution path so [worker/src/cron/sync-yield-data.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-yield-data.ts) consumes cached supplemental candidates instead of live-fetching those families.
7. Keep arbitration and final publish only in `sync-yield-data`.

### Files Expected To Change

- [worker/wrangler.toml](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/wrangler.toml)
- [shared/lib/cron-jobs.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/cron-jobs.ts)
- [worker/src/handlers/scheduled.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/handlers/scheduled.ts)
- [worker/src/cron/sync-yield-data.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-yield-data.ts)
- [worker/src/cron/yield-sync/resolve.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-sync/resolve.ts)
- [worker/src/cron/yield-sync/sources.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-sync/sources.ts)
- new supplemental modules and runner files
- cron/status tests

### Docs To Update

- [docs/yield-intelligence.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/yield-intelligence.md)
- [docs/yield-intelligence-operations.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/yield-intelligence-operations.md)
- [docs/worker-and-api-limits.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/worker-and-api-limits.md)
- [docs/worker-infrastructure.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/worker-infrastructure.md)
- [docs/testing.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/testing.md) if trigger count or cron topology language changes

### Validation

- targeted tests for supplemental cache read/write and merge behavior
- targeted scheduler tests for new supplemental slot
- regression tests ensuring core cron still publishes valid rankings when supplemental cache is:
  - fresh
  - stale
  - missing
  - partially degraded
- full validation:
  - `npm run check:cron-sync`
  - `npm run check:cron-connections`
  - `npm run lint`
  - `npm test`
  - `cd worker && npx tsc --noEmit`
  - before push: `npm run test:merge-gate`

### Rollout Success Criteria

Observe for at least 72 hours:

- core hourly yield runtime stays low and stable
- supplemental cron absorbs most optional-family variability
- no publication correctness regressions on `/yield`
- stale supplemental cache behavior is visible and non-catastrophic

## Cross-Phase Monitoring Plan

After each phase, capture:

- `sync-yield-data` run count
- `sync-yield-data` avg / p95 / max duration
- degraded/error count
- row count and coverage metadata
- percentage of runs with:
  - `onChainAllDeterministicFailed`
  - cooldown active
  - supplemental snapshot stale or unavailable

If phase 1 alone already removes the practical pain, phase 2 and 3 still remain good cleanup work, but their urgency drops.

## Recommended Execution Order

### PR 1

Hourly yield schedule only.

### PR 2

Deterministic cooldown / fast-fail.

### PR 3

Core vs supplemental split.

## Risks And Mitigations

### Risk

Hourly yield feels stale to users expecting 30-minute freshness.

Mitigation:

- communicate that yield is now hourly by design in ops docs
- keep DEX liquidity and DEWS at current faster cadences

### Risk

Cooldown hides deterministic recovery too long.

Mitigation:

- short initial cooldown window
- reset on first success
- never enter cooldown when deterministic-only coverage is needed

### Risk

Core/supplemental split creates stale optional rows in rankings.

Mitigation:

- explicit supplemental TTL
- ignore stale rows rather than silently retaining them forever
- surface supplemental age in metadata

## Final Recommendation

Implement all three ideas, but in sequence:

1. true hourly yield trigger first
2. deterministic cooldown second
3. core/supplemental split third

If implementation starts immediately, phase 1 is the only change that should be considered “must land first.” Phases 2 and 3 depend on observing the new hourly shape and then refining it.
