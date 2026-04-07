# Health / Status Remediation Plan

Date: 2026-04-06

## Goal

Remediate the current false-positive degradation paths so `/api/status`, `/admin/`, and the remaining shared status surfaces report `degraded` only when freshness, correctness, or control is materially degraded.

## Success criteria

- Diagnostic blindness does not promote `/api/status` to `degraded` on its own.
- One non-critical stale cron does not promote availability to `degraded`.
- Reserve-sync issues degrade the global data-quality lane only when reserve coverage is materially reduced, not when a small absolute issue count is crossed.
- `info` causes never appear in blocker-first UI surfaces.
- Operator-facing uncertainty remains visible through lane-local status, causes, notices, and confidence.

## Design decisions

### 1. Keep the top-level status strict

Top-level `availabilityStatus` / `dataQualityStatus` should reflect only:

- shared/public freshness loss
- shared/public correctness loss
- material operator control loss on critical lanes

They should not reflect:

- missing diagnostics
- lane-local watch items
- advisory low-sample conditions

### 2. Prefer additive response changes

Keep existing response fields where possible and add new fields rather than replacing contract surfaces:

- keep `summary.unhealthyCrons` and `summary.cronErrors`
- add impact-aware summary counts for UI and worker logic
- keep `reserveComposition` and add lane-local status + coverage ratios inside it

### 3. Do not add a new `StatusCause.impact` field in this pass

It would help long-term, but it is not required to remediate the concrete failures already identified. This plan gets the needed behavior through:

- impact-aware cron summary fields
- lane-local reserve status
- severity reclassification for diagnostic query failures
- blocker filtering that excludes `info`

That keeps the remediation smaller and reduces fixture churn.

## Implementation

## Workstream 1: Shared policy metadata

### A. Add cron impact tiers

Files:

- `shared/lib/cron-jobs.ts`
- `shared/types/status.ts`

Change:

- Add a new shared cron metadata field, `statusImpact: "critical" | "watch"`.
- Initial `critical` jobs:
  - `sync-stablecoins`
  - `sync-fx-rates`
  - `sync-blacklist`
  - `sync-mint-burn`
- Initial `watch` jobs:
  - every other status-tracked cron, including `sync-live-reserves`, `sync-yield-data`, `sync-stablecoin-charts`, `stability-index`, `compute-dews`, `dispatch-telegram-alerts`, `status-self-check`, and all daily/supporting jobs

Rationale:

- only the four listed jobs directly gate the most critical shared/public data freshness surfaces
- everything else still matters, but should be surfaced as lane-local watch work unless it compounds with other failures

### B. Add reserve lane status metadata

Files:

- `shared/lib/status-thresholds.ts`
- `shared/types/status.ts`

Change:

- Add shared reserve coverage thresholds:
  - `degradedFreshCoverageRatio = 0.75`
  - `degradedAuthoritativeCoverageRatio = 0.50`
- Extend `StatusResponse.reserveComposition` with:
  - `status: "healthy" | "degraded" | "stale"`
  - `freshCoverageRatio: number`
  - `authoritativeFreshCoverageRatio: number`

Definition:

- `authoritativeFreshCoins = independentFreshEligible + independentFreshUnverified + staticValidatedFresh`
- `freshCoverageRatio = freshCoins / configuredCoins`
- `authoritativeFreshCoverageRatio = authoritativeFreshCoins / configuredCoins`

Rationale:

- this moves reserve health from count-based heuristics to coverage-based heuristics
- it preserves visibility for reserve issues without forcing them into the global status too early

## Workstream 2: Worker status evaluation rewrite

### A. Stop rolling diagnostic failures into `dataQualityStatus`

Files:

- `worker/src/lib/status/evaluation-state.ts`
- `worker/src/lib/status/data-quality.ts`
- `worker/src/lib/status-evaluation.ts`

Change:

- Remove `dataQuality.sourceFailures.length > 0` from the global `degraded` path.
- Remove `reserveCompositionQueryFailed` from the global `degraded` path.
- Keep `stablecoinsCacheStatus === "error" | "degraded"` as the hard dependency path.
- Keep diagnostic failures in `dataQuality.sourceFailures` and `causes`.

Additional visibility:

- add a new summary field: `summary.diagnosticIssueCount`
- lower confidence slightly for diagnostic gaps without changing the top-level status

Confidence rule:

- subtract `0.03` per diagnostic issue, capped at `0.09`

### B. Make availability depend only on critical cron failures

Files:

- `worker/src/lib/status/cron-health.ts`
- `worker/src/lib/status/evaluation-state.ts`
- `worker/src/lib/status-evaluation.ts`

Change:

- `loadCronHealth()` should return:
  - `availabilityImpactingUnhealthyCrons`
  - `watchUnhealthyCrons`
  - `availabilityImpactingCronErrors`
  - keep the total counts for UI compatibility
- `deriveAvailabilityStatus()` should use:
  - public health floor
  - `availabilityImpactingCronErrors`
  - `availabilityImpactingUnhealthyCrons`
- `watch` unhealthy crons should not affect `availabilityStatus`

Availability matrix:

- `stale` when any of:
  - shared/public availability floor is `stale`
  - `availabilityImpactingCronErrors > 0`
  - `availabilityImpactingUnhealthyCrons >= 2`
- `degraded` when any of:
  - shared/public availability floor is `degraded`
  - `availabilityImpactingUnhealthyCrons === 1`
- `healthy` otherwise

Rationale:

- one missing critical lane is real degradation
- a hard error on a critical lane is real staleness
- watch-only cron failures remain visible but do not promote the platform into incident mode

### C. Replace reserve count thresholds with reserve coverage status

Files:

- `worker/src/lib/status/evaluation-state.ts`
- `worker/src/lib/live-reserves-store-view.ts`
- `worker/src/lib/status-evaluation.ts`
- `worker/src/lib/status/evaluation-causes.ts`

Change:

- Replace `deriveReserveCompositionFlags()` with a `deriveReserveCompositionStatus()` helper.
- Preserve bootstrap behavior: no first-success snapshot means lane is watch-only, not degraded.
- `reserveComposition.status` rules:
  - `stale` when `configuredCoins > 0`, bootstrap is false, and `freshCoins === 0`
  - `degraded` when bootstrap is false and either:
    - `freshCoverageRatio < 0.75`, or
    - `authoritativeFreshCoverageRatio < 0.50`
  - `healthy` otherwise
- `dataQualityStatus` should consume `reserveComposition.status` instead of the current issue-count warning path.

Rationale:

- three bad reserve feeds out of thirty-plus is not real global degradation
- broad reserve coverage loss is

## Workstream 3: Cause and summary semantics

Files:

- `worker/src/lib/status/evaluation-causes.ts`
- `worker/src/lib/status-evaluation.ts`
- `shared/types/status.ts`

Change:

- Reclassify diagnostic query-failure causes to `info`:
  - `blacklist_gap_query_failed`
  - `active_depeg_query_failed`
  - `onchain_supply_query_failed`
  - `reserve_sync_query_failed`
  - `cache_freshness_query_failed`
  - `cron_history_query_failed`
  - `cron_progress_query_failed`
- Split cron causes into impacting vs watch-only:
  - keep warning/critical causes for critical unhealthy cron failures
  - add info-level watch causes for non-critical unhealthy cron counts
- Keep reserve causes, but tie the global reserve warning cause to coverage status instead of issue count

Summary additions:

- `summary.availabilityImpactingUnhealthyCrons`
- `summary.watchUnhealthyCrons`
- `summary.availabilityImpactingCronErrors`
- `summary.diagnosticIssueCount`

## Workstream 4: Admin/status UI remediation

### A. Blocker and top-fold filtering

Files:

- `src/lib/status-dashboard-model.ts`
- `src/components/status/status-facts.tsx`
- `src/app/admin/client.tsx`
- `src/lib/status/action-recommendations.ts`

Change:

- `getTopCauses()` should ignore `info` causes for blocker-first surfaces.
- `StatusFacts` should render two groups:
  - `Current blockers` for `critical` + `warning`
  - `Diagnostics watch` for `info`
- `/admin/` top fold `What needs attention now` should use only blocker causes.
- The immediate-count pill should count blocker causes only.
- `deriveStatusActionRecommendations()` should promote only blocker causes plus availability-impacting cron failures into the top action strip.
- Info-level causes may still expose local action buttons inside the diagnostics/watch list, but they must not promote the global action strip by themselves.

### B. Use impact-aware summary fields in urgency ordering

Files:

- `src/lib/status-dashboard-model.ts`
- `src/app/admin/client.tsx`

Change:

- section priority and cron urgency should use `availabilityImpactingUnhealthyCrons` / `availabilityImpactingCronErrors`
- `watchUnhealthyCrons` should remain visible in badges and cron cards, but should not dominate the page order
- replace the current all-causes `overallCauseCount` top-fold emphasis with blocker-first counts:
  - blocker count drives the urgent badge styling
  - info-only watch items use a separate watch count or neutral styling

### C. Surface reserve and diagnostic status locally

Files:

- `src/components/status/reserve-sync-health.tsx`
- `src/app/admin/sections/pipeline-section.tsx`
- `src/components/status/data-quality-cards.tsx`

Change:

- add a reserve-sync status chip using `reserveComposition.status`
- update reserve copy to explain the coverage thresholds
- change diagnostic query-failure card treatment from incident-red to watch-level amber/neutral where the failure no longer affects global status

Rationale:

- if the backend gets stricter but the lane cards still scream incident, operators will still perceive the system as degraded

## Workstream 5: Docs

Files:

- `docs/status-dashboard.md`
- `docs/api-reference.md`

Change:

- rewrite `/api/status` status logic to distinguish:
  - top-level status-affecting failures
  - lane-local degradation
  - diagnostics-only incompleteness
- document cron impact tiers
- document reserve coverage thresholds and the new `reserveComposition.status` / ratio fields
- document that `info` causes live in watch surfaces and do not appear in blocker-first sections

## Workstream 6: Test plan

### Worker / API tests

Files:

- `worker/src/api/__tests__/status.test.ts`
- add a new focused policy test file under `worker/src/lib/__tests__/` if needed

Add cases:

- blacklist-gap query failure leaves `dataQualityStatus="healthy"` and emits an info cause
- active-depeg query failure leaves `dataQualityStatus="healthy"`
- on-chain diagnostics query failure leaves `dataQualityStatus="healthy"`
- reserve overview query failure leaves `dataQualityStatus` unchanged and increments `diagnosticIssueCount`
- one watch-tier unhealthy cron leaves `availabilityStatus="healthy"`
- one critical unhealthy cron degrades availability
- one critical cron error marks availability stale
- reserve status stays healthy for low-count incidents with high coverage
- reserve status degrades when coverage drops below the new thresholds
- reserve status goes stale when no fresh reserve coverage remains

### Frontend tests

Files:

- `src/lib/__tests__/status-dashboard-model.test.ts`
- `src/app/admin/__tests__/client.test.tsx`
- `src/components/__tests__/data-quality-cards.test.tsx`

Add cases:

- top causes exclude info-only items from blocker lists
- diagnostics watch still renders info causes
- section ordering is driven by impacting cron counts, not total unhealthy cron counts
- recommended-action strip ignores info-only causes
- top-fold badge styling stays neutral when the page has watch items but zero blockers
- data-quality cards render diagnostic query failures as watch-level, not hard incident red

### Regression guard

Keep or add fixtures for these known false-positive scenarios:

- reserve-specific noise with healthy shared data
- single watch-tier cron missing
- query-failure-only diagnostic gaps
- low-sample on-chain monitor

## Execution order

1. Add shared metadata and response-shape extensions.
2. Rewrite worker evaluation logic and update API tests.
3. Update admin/status UI promotion rules and visual treatment.
4. Update docs after the code paths and response shapes settle.
5. Run full validation and then `npm run test:merge-gate`.

## Verification when implementing

Required commands:

- `npm run lint`
- `npm test`
- `npm run build`
- `cd worker && npx tsc --noEmit`
- `npm run test:merge-gate`

Recommended targeted runs during implementation:

- `npm test -- worker/src/api/__tests__/status.test.ts`
- `npm test -- src/lib/__tests__/status-dashboard-model.test.ts`
- `npm test -- src/app/admin/__tests__/client.test.tsx`
- `npm test -- src/components/__tests__/data-quality-cards.test.tsx`

## Explicit non-goals

- no change to `/api/health` public circuit filtering beyond the already-landed reserve breaker fix
- no new general-purpose severity taxonomy beyond the scoped worker/UI changes above
- no redesign of the admin/status layout

## Validation loop

### Round 1 review

Medium issues found:

1. The first draft removed diagnostic failures from global status but did not preserve enough operator visibility, which risked hiding uncertainty.
2. The first draft removed reserve count thresholds without replacing them with a stable lane-local contract and response field.
3. The first draft said “classify crons by impact” without freezing the actual initial mapping, leaving room for ambiguity during implementation.

Changes made:

- added `summary.diagnosticIssueCount`, confidence penalties, and an explicit diagnostics-watch UI section
- added `reserveComposition.status`, `freshCoverageRatio`, and `authoritativeFreshCoverageRatio`
- fixed the initial cron mapping to an explicit `critical` set and a default `watch` set

### Round 2 review

Medium issues found:

1. Info-only causes could still leak back into urgency via the promoted action strip.
2. The top-fold `Active Causes` badge could still read incident-like if it kept counting all causes instead of blockers.

Changes made:

- limited the promoted action strip to blocker causes plus availability-impacting cron failures
- changed the plan so top-fold urgency badges use blocker counts, with watch items rendered separately or neutrally

### Round 3 review

Medium issues found:

- none

Final assessment:

- remaining issues are implementation-detail questions, not plan-level medium risks
- medium-issue count: `0`
