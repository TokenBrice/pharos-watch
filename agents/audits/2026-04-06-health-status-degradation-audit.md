# Health / Status Degradation Audit

Date: 2026-04-06

## Scope

Audit of the current `/api/health`, `/api/status`, `/status/`, and `/admin/` degradation paths with emphasis on repeated false-positive `degraded` states for minor operator issues.

## Current conclusion

The recurring problem is not one bad threshold. The status stack still mixes three different classes of signal:

1. public-impact breakage
2. operator lane degradation
3. diagnostics / observability gaps

As long as those classes share the same promotion path, the product will keep drifting back toward false-positive `degraded` incidents.

## High-priority changes

### 1. Keep diagnostics failures out of top-level degradation by default

Current behavior:

- `deriveDataQualityStatus()` marks the whole data-quality lane `degraded` when `dataQuality.sourceFailures.length > 0`
- `deriveDataQualityStatus()` also marks data quality `degraded` when `reserveCompositionQueryFailed === true`

Implication:

- a failed metrics query for blacklist gaps, active depegs, on-chain diagnostics, or reserve overview currently degrades the whole status even when the primary stablecoins cache is healthy and user-facing data is still trustworthy

Recommended change:

- split loader failures into `hardDependencyFailures` vs `diagnosticFailures`
- only hard dependencies should affect `dataQualityStatus`
- keep diagnostic failures in `causes` and `sectionErrors`, but do not promote them into global `degraded`

Relevant files:

- `worker/src/lib/status/evaluation-state.ts`
- `worker/src/lib/status/data-quality.ts`
- `worker/src/lib/status/evaluation-causes.ts`
- `shared/types/status.ts`

### 2. Rework reserve-composition degradation so it reflects coverage quality, not issue count alone

Current behavior:

- reserve composition is `critical` only when all configured feeds are bad
- reserve composition is `warning` when issue count reaches `max(3, ceil(configuredCoins * 0.1))`

Implication:

- three reserve issues can degrade the global data-quality lane even if most reserve coverage is fresh and all high-value/publicly important reserve feeds are still healthy
- the threshold is count-based, not impact-based

Recommended change:

- degrade only when fresh reserve coverage drops below a meaningful floor, not when issue count crosses a small integer
- treat `warning` reserve states as lane-local unless the reserve failures materially reduce authoritative fresh coverage
- optionally weight by evidence class or public/product dependence, so weak-probe or low-importance failures do not count the same as loss of authoritative independent reserve coverage

Relevant files:

- `worker/src/lib/status/evaluation-state.ts`
- `worker/src/lib/live-reserves-store-view.ts`
- `worker/src/lib/status/evaluation-causes.ts`

### 3. Stop treating any unhealthy cron as platform degradation

Current behavior:

- `deriveAvailabilityStatus()` marks availability `degraded` when `unhealthyCrons > 0`
- `loadCronHealth()` counts all cron jobs equally for `unhealthyCrons`

Implication:

- one stale non-critical cron can degrade the entire operator status even when public freshness and critical ingestion lanes are healthy
- this contradicts the otherwise lane-aware direction already used for mint/burn critical-vs-extended handling

Recommended change:

- classify cron jobs by impact tier
- reserve top-level availability degradation for critical public-serving lanes or multi-lane failures
- keep single non-critical unhealthy jobs as warning-only causes and lane-local surfacing

Relevant files:

- `worker/src/lib/status/evaluation-state.ts`
- `worker/src/lib/status/cron-health.ts`
- `shared/lib/cron-jobs.ts`

### 4. Remove info-only causes from blocker/top-fold promotion

Current behavior:

- `getTopCauses()` merges and sorts all causes, including `info`
- `StatusFacts` renders `causes.overall` under the heading `Current blockers`
- `/admin/` top fold uses `topCauses` to populate the urgent attention area

Implication:

- operators see items like `degraded_cron_warning` or `onchain_monitor_low_sample` presented as blockers
- the page reads as incident-grade even when the backend status is healthy or only mildly degraded

Recommended change:

- blocker lists and top-fold urgency should show only `critical` and `warning` causes
- move `info` causes into a separate diagnostics/watch section
- keep `info` entries visible, but do not label them as blockers or immediate action items

Relevant files:

- `src/lib/status-dashboard-model.ts`
- `src/components/status/status-facts.tsx`
- `src/app/admin/client.tsx`

## Secondary changes

### 5. Align the docs and API contract around “true degradation” vs “diagnostic incompleteness”

The docs still describe `any critical data-quality subquery failed` as a degraded condition for `/api/status`. That contract is the root of repeated re-tightening.

Recommended change:

- document a stricter rule: top-level status should degrade only when public data correctness, freshness, or core operator control is materially affected
- diagnostic incompleteness should remain visible through `causes`, `sectionErrors`, and lane cards

Relevant files:

- `docs/status-dashboard.md`
- `docs/api-reference.md`

### 6. Consider adding explicit “impact class” metadata to causes

Right now `StatusCause` carries only `severity` and `layer`. That is not enough to distinguish:

- user-facing breakage
- operator-affecting degradation
- advisory telemetry

Recommended change:

- add an `impact` field such as `public`, `operator`, or `diagnostic`
- use that in both status aggregation and UI promotion rules

Relevant files:

- `shared/types/status.ts`
- `worker/src/lib/status/evaluation-causes.ts`
- `src/lib/status-dashboard-model.ts`

## Already-fixed path

The earlier false-positive path where per-coin `live-reserves:*` circuit breakers degraded public health has already been corrected separately. Public-health counting now excludes reserve-specific circuit scopes from the top-level status and leaves them on the reserve/data-quality lanes instead.
