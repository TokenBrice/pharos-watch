# Depeg Reliability Implementation Plan

Date: March 10, 2026  
Source audit: `/depeg` end-to-end reliability audit  
Primary route: `/depeg/`  
Primary worker jobs: `sync-stablecoins` (`detect-depegs` + `confirm-pending-depegs`), `compute-dews`

## Purpose

This document converts the `/depeg` audit findings into an execution-ready implementation plan.

The goal is to improve:

- live depeg detection accuracy
- catastrophic-event coverage
- frontend freshness/provenance transparency
- historical completeness
- operational auditability

without expanding scope into a broader DEWS redesign or adding new external data sources.

## Scope

In scope:

- `worker/src/cron/sync-stablecoins.ts`
- `worker/src/cron/enrich-prices.ts`
- `worker/src/cron/detect-depegs.ts`
- `worker/src/cron/confirm-pending-depegs.ts`
- `worker/src/api/peg-summary.ts`
- `worker/src/api/depeg-events.ts`
- `worker/src/api/audit-depeg-history.ts`
- `worker/src/handlers/scheduled.ts`
- `src/hooks/use-api-query.ts`
- `src/hooks/use-peg-summary.ts`
- `src/hooks/use-depeg-events.ts`
- `src/hooks/use-stress-signals.ts`
- `src/app/depeg/page.tsx`
- `src/app/depeg/client.tsx`
- `src/components/depeg-feed.tsx`
- `src/components/depeg-tracker-table.tsx`
- `src/components/peg-heatmap.tsx`
- `src/components/stale-data-banner.tsx`
- `src/lib/api.ts`
- `src/lib/data-health.ts`
- `shared/types/index.ts`
- depeg-related docs and methodology docs

Out of scope:

- redesigning the `/depeg` visual layout
- reworking the DEWS formula
- changing the core cron-slot topology
- introducing new data vendors or new market data sources
- broad report-card or PSI methodology changes unrelated to depeg reliability

## Non-Negotiables

- Preserve current source-quality guardrails; do not relax thresholds just to increase event count.
- Prefer deterministic recomputation and explicit confidence states over silent heuristics.
- Do not allow low-confidence or cached prices to masquerade as authoritative live depeg inputs.
- Any change to methodology or page claims must update:
  - `docs/depeg-detection.md`
  - `docs/data-pipeline.md`
  - `docs/data-flow-map.md`
  - `docs/api-reference.md`
  - `docs/worker-infrastructure.md`
  - `docs/methodology-page.md`
- No new external source is introduced, so `/about` does not need a data-source update.
- Keep quarter-hourly cron safe under the Workers shared 6-connection limit.

## Verification Standard

Every completed workstream must finish with:

```bash
npm run build
npm run lint
npm test
cd worker && npx tsc --noEmit
```

Minimum targeted suites during development:

```bash
npm test -- \
  worker/src/cron/__tests__/detect-depegs.test.ts \
  worker/src/cron/__tests__/confirm-pending-depegs.test.ts \
  worker/src/cron/__tests__/sync-stablecoins.test.ts \
  worker/src/api/__tests__/peg-summary.test.ts \
  worker/src/api/__tests__/depeg-events.test.ts \
  worker/src/api/__tests__/stress-signals.test.ts \
  worker/src/api/__tests__/audit-depeg-history.test.ts \
  src/lib/__tests__/data-health.test.ts
```

Recommended new targeted suites to add as part of this plan:

- `src/components/__tests__/depeg-feed.test.tsx`
- `src/hooks/__tests__/use-api-query-meta.test.ts`
- `worker/src/cron/__tests__/detect-depegs-extreme.test.ts` or fold into existing detector tests

## Findings To Fix

| ID | Severity | Problem | Root cause |
|---|---|---|---|
| F1 | High | Low-confidence, single-source, and cached prices can drive live depeg state | detector trusts `asset.price` without source-age-confidence gating |
| F2 | High | Real catastrophic depegs can be missed or under-reported | detector hard-skips `<0.5x` / `>2x` peg moves before event insert/update |
| F3 | High | `/depeg` can look fresh while backend data is stale | frontend health banner uses browser fetch time, not API freshness metadata |
| F4 | Medium | `/depeg` claims full history but only loads the first 100 events | feed paginates inside a single default-limited API response |
| F5 | Medium | `coinsAtPeg` is inaccurate for non-USD pegs | summary aggregation uses a hardcoded 100bps threshold |
| F6 | Medium | Fallback peg-reference transparency is broken | API computes fallback peg info, but types/UI wiring drops it |
| F7 | Medium-low | Depeg orphan/cleanup docs do not match runtime behavior | docs still describe closure behavior that the code now intentionally avoids |
| F8 | Low | Empty successful event responses can be treated as unavailable | page health uses array length as proxy for endpoint health |

## Implementation Strategy

Implement in four workstreams, in this order:

1. Primary price trust hardening
2. Frontend freshness and provenance plumbing
3. History completeness and summary correctness
4. Operational reconciliation and documentation alignment

This order prevents the UI from becoming more polished while still sitting on ambiguous or misclassified live event data.

## Workstream 1: Primary Price Trust Hardening

### 1.1 Add explicit depeg-input trust metadata

Fixes: `F1`

Current problem:

- `sync-stablecoins` writes all valid prices to `price_cache`
- later fallback reuses cached prices but does not preserve source-age semantics in the payload
- `detectDepegEvents()` and `confirmPendingDepegs()` do not distinguish authoritative live prices from fallback or ambiguous prices

Implementation:

1. Extend the stablecoins payload with explicit price provenance:
   - `priceSource`
   - `priceConfidence`
   - `priceUpdatedAt`
2. When `sync-stablecoins` applies `price_cache` fallback:
   - set `priceSource = "cached"`
   - set `priceConfidence = "fallback"`
   - set `priceUpdatedAt = cached.updatedAt`
3. For fresh prices produced in the current sync:
   - stamp `priceUpdatedAt = syncStartSec`
4. Add a shared helper for depeg detection, e.g. `classifyPrimaryDepegTrust(asset)` returning:
   - `authoritative`
   - `confirm_required`
   - `unusable`
5. Define trust policy explicitly:
   - `authoritative`: fresh high-confidence prices and fresh non-cached single-source prices
   - `confirm_required`: low-confidence, fallback, cached, or stale prices
   - `unusable`: null, invalid, non-finite, or price data outside the earlier sync-level sanity rules

Primary files:

- `shared/types/index.ts`
- `worker/src/cron/sync-stablecoins.ts`
- `worker/src/cron/enrich-prices.ts`
- `worker/src/cron/detect-depegs.ts`
- `worker/src/cron/confirm-pending-depegs.ts`
- `worker/src/api/peg-summary.ts`

Acceptance criteria:

- A cached fallback price is visibly marked as cached/fallback in the payload.
- Low-confidence inputs cannot open or close live depeg events without secondary confirmation.
- Page consumers can see price provenance without loading a second endpoint.

Tests:

- Add a `sync-stablecoins` test asserting cached fallback stamps source/confidence/timestamp.
- Add detector tests proving low-confidence or cached prices do not directly open events.
- Add API tests proving peg summary returns price provenance fields.

### 1.2 Generalize pending confirmation for ambiguous inputs

Fixes: `F1`, part of `F2`

Current problem:

- `depeg_pending` is currently reserved for `>$1B` coins only
- smaller coins with low-confidence or cached prices can still create immediate live events

Implementation:

1. Reuse the existing `depeg_pending` flow for any coin that requires confirmation, not just large-cap coins.
2. Add a small schema enhancement to improve observability:
   - migration adding `reason TEXT NOT NULL DEFAULT 'large-cap'` to `depeg_pending`
3. Allowed reasons:
   - `large-cap`
   - `low-confidence`
   - `extreme-move`
4. In `detect-depegs.ts`, route new events to pending when:
   - supply is above the current large-cap threshold
   - or primary trust is `confirm_required`
   - or the move qualifies as an extreme move under 1.3
5. In `confirm-pending-depegs.ts`, keep the confirmation matrix the same, but record/log reason-specific metrics.

Primary files:

- `worker/migrations/*` (new migration)
- `worker/src/cron/detect-depegs.ts`
- `worker/src/cron/confirm-pending-depegs.ts`
- `docs/depeg-detection.md`

Acceptance criteria:

- The same secondary-confirmation machinery covers large-cap, low-confidence, and extreme-move cases.
- Pending rows are inspectable by reason in logs and status output.
- No duplicate live event creation path exists for confirm-required inputs.

Tests:

- Add pending tests for a sub-$1B low-confidence coin.
- Add pending tests that confirm `reason` is set correctly.

### 1.3 Replace the hard `<0.5x` / `>2x` skip with an extreme-move lane

Fixes: `F2`

Current problem:

- the detector drops real moves below 50% of peg before opening or updating an event
- ongoing events stop updating their peak during the most severe phase of a crash

Implementation:

1. Remove the detector-local `0.5x` / `2x` skip from `detect-depegs.ts`.
2. Keep upstream price sanity protection in `sync-stablecoins`; do not weaken that layer.
3. Introduce an `EXTREME_DEPEG_THRESHOLD_BPS` constant, e.g. 5000 bps, and route such moves through pending confirmation unless already corroborated by trusted DEX.
4. For already-open events:
   - allow peak updates for extreme moves when the input is authoritative or a trusted secondary agrees
   - do not silently freeze peak tracking because the move became “too large”
5. Preserve logging for truly rejected inputs, but make rejection conditional on invalid/unusable data rather than severity alone.

Primary files:

- `worker/src/cron/detect-depegs.ts`
- `worker/src/lib/constants.ts`
- `worker/src/cron/__tests__/detect-depegs.test.ts`
- `docs/depeg-detection.md`

Acceptance criteria:

- A first-observed `-7000bps` move can enter pending/live flow instead of being dropped.
- Existing open events keep updating peak deviation during crashes below 50% of peg.
- Glitch protection still exists through sync-time sanity filtering and secondary confirmation.

Tests:

- Replace the current “skip below 0.5x” expectation with:
  - pending or confirmed insertion for corroborated extreme moves
  - rejection only for invalid/unusable input
- Add a test where an open event worsens from `-4000bps` to `-7000bps` and peak updates.

## Workstream 2: Frontend Freshness And Provenance Plumbing

### 2.1 Introduce meta-aware API query hooks

Fixes: `F3`, part of `F8`

Current problem:

- worker APIs already emit `X-Data-Age` and stale warnings
- `/depeg` ignores that and evaluates health from browser fetch time only

Implementation:

1. Add a `useApiQueryWithMeta()` helper built on `apiFetchWithMeta()`.
2. Update these hooks to return `{ data, meta }`:
   - `usePegSummary`
   - `useDepegEvents`
   - `useStressSignals`
3. Feed `meta` into `StaleDataBanner`.
4. Keep old hook signatures only if needed for compatibility; otherwise migrate callers directly.
5. Make `deriveDataHealth()` prefer backend freshness metadata when present.

Primary files:

- `src/lib/api.ts`
- `src/hooks/use-api-query.ts`
- `src/hooks/use-peg-summary.ts`
- `src/hooks/use-depeg-events.ts`
- `src/hooks/use-stress-signals.ts`
- `src/components/stale-data-banner.tsx`
- `src/lib/data-health.ts`
- `src/app/depeg/client.tsx`

Acceptance criteria:

- If the worker serves stale data with a fresh browser fetch timestamp, the banner still shows degraded/stale.
- `/depeg` no longer depends on client fetch time alone for health state.
- Empty-but-successful payloads are distinguishable from unavailable data.

Tests:

- Add `use-api-query` meta tests covering `X-Data-Age` and warning headers.
- Extend `data-health.test.ts` for backend-meta precedence.
- Add a frontend test where `depeg-events` returns an empty array with healthy meta and no unavailable banner is shown.

### 2.2 Expose price provenance and depeg trust on `/depeg`

Fixes: `F1`, part of `F3`

Implementation:

1. Extend `PegSummaryCoin` with:
   - `priceSource`
   - `priceConfidence`
   - `priceUpdatedAt`
   - `primaryTrust` or `depegTrust`
2. Surface provenance in:
   - `DepegTrackerTable`
   - `PegHeatmap`
3. Keep presentation subtle:
   - tooltip
   - small text/badge
   - no layout redesign
4. Clarify DEX check semantics in UI copy:
   - rename display label from “DEX Price Check” to “DEX Cross-check” or equivalent
   - tooltip should explain it is corroboration, not a canonical price source

Primary files:

- `shared/types/index.ts`
- `worker/src/api/peg-summary.ts`
- `src/components/depeg-tracker-table.tsx`
- `src/components/peg-heatmap.tsx`
- `src/app/depeg/client.tsx`

Acceptance criteria:

- Users can tell when a displayed deviation comes from cached/fallback/low-confidence inputs.
- A healthy DEX cross-check is presented as corroboration, not as the main price.
- No new API round-trip is needed to render provenance.

Tests:

- Add peg-summary response tests for provenance fields.
- Add component tests for badge/tooltip rendering on low-confidence rows.

### 2.3 Repair fallback peg-reference transparency

Fixes: `F6`

Implementation:

1. Decide on one typed contract:
   - either `pegRateSources: Record<string, "median" | "fallback">`
   - or `fallbackPegTypes: string[]`
2. Add that contract to `shared/types/index.ts`.
3. Return it from `/api/peg-summary`.
4. Pass it through `/depeg` into `PegHeatmap`.
5. Render a concise notice when fallback-derived peg references are in effect.

Primary files:

- `shared/types/index.ts`
- `worker/src/api/peg-summary.ts`
- `src/hooks/use-peg-summary.ts`
- `src/app/depeg/client.tsx`
- `src/components/peg-heatmap.tsx`

Acceptance criteria:

- The heatmap notice path is live and typed.
- Non-USD fallback-rate conditions are visible to users.

Tests:

- Add peg-summary API test for fallback peg source contract.
- Add heatmap rendering test for fallback-rate notice.

## Workstream 3: History Completeness And Summary Correctness

### 3.1 Implement real event-history pagination on `/depeg`

Fixes: `F4`

Current problem:

- page copy promises full history
- feed only paginates inside a single 100-row response

Implementation:

1. Replace the current single-page event hook with an infinite/paginated variant using `limit` + `offset`.
2. Update `DepegFeed` so “Load more” actually fetches the next page.
3. Keep API contract offset-based unless a cursor is clearly needed.
4. If pagination work is deferred, update page copy immediately to “recent history” in the same PR.

Primary files:

- `src/hooks/use-depeg-events.ts`
- `src/components/depeg-feed.tsx`
- `src/app/depeg/page.tsx`
- `worker/src/api/depeg-events.ts`
- `docs/api-reference.md`

Acceptance criteria:

- “Load more” increases fetched history, not just visible rows.
- `/depeg` copy matches actual data coverage.
- No duplicate or skipped rows across pages.

Tests:

- Add hook/component tests for page 1 + page 2 append behavior.
- Add API tests for pagination invariants if missing.

### 3.2 Fix non-USD `coinsAtPeg` semantics

Fixes: `F5`

Implementation:

1. Use `getDepegThresholdBps(pegType)` when computing `coinsAtPeg` in `handlePegSummary`.
2. Keep `medianDeviationBps` and `worstCurrent` as raw deviation metrics.
3. Add explicit tests for a `peggedEUR` or `peggedGOLD` case in the 100-149bps band.

Primary files:

- `worker/src/api/peg-summary.ts`
- `worker/src/api/__tests__/peg-summary.test.ts`
- `docs/depeg-detection.md`

Acceptance criteria:

- Non-USD coins between 100bps and 149bps count as “at peg” in summary stats.
- Summary thresholds match detection thresholds.

### 3.3 Fix empty-success health semantics

Fixes: `F8`

Implementation:

1. Stop using array length as the only indicator of endpoint health for `depeg-events`.
2. Treat a successful empty response as available data.
3. Keep `unavailable` reserved for:
   - 503/no dataset yet
   - schema failure with no usable data
   - actual fetch failure with no cached success

Primary files:

- `src/app/depeg/client.tsx`
- `src/lib/data-health.ts`
- `src/components/stale-data-banner.tsx`

Acceptance criteria:

- A healthy empty `events: []` response does not produce an unavailable banner.

Tests:

- Extend `data-health.test.ts` for empty-success payload behavior.

## Workstream 4: Operational Reconciliation And Documentation Alignment

### 4.1 Operationalize depeg-quality reconciliation

Improves: executive-summary addition #3

Current problem:

- `audit-depeg-history` is strong, but manual
- there is no ongoing quality signal for recent false positives, unresolved pending reasons, or freshness drift

Implementation:

1. Extract shared reconciliation helpers from `audit-depeg-history.ts`.
2. Add a scheduled job, preferably daily, that audits:
   - all active depeg events
   - recent closed events, e.g. last 72 hours
3. Persist a latest summary to cache or cron metadata under a new status surface, e.g. `depeg-quality`.
4. Surface on `/status`:
   - audited event count
   - false positives found
   - active events lacking secondary corroboration
   - pending count by reason
   - last successful audit time
5. Do not mutate history in the scheduled job initially; make it detect/report only.
6. Keep the admin endpoint as the explicit destructive remediation path.

Primary files:

- `worker/src/api/audit-depeg-history.ts`
- `worker/src/handlers/scheduled.ts`
- `worker/src/api/status.ts`
- `docs/status-dashboard.md`
- `docs/worker-infrastructure.md`

Acceptance criteria:

- Operators can assess depeg data quality without manually running the audit endpoint.
- The scheduled quality job is non-destructive by default.
- Recent depeg false positives are visible on `/status`.

Tests:

- Add status API tests for the new `depegQuality` shape.
- Add scheduled handler tests for job registration/gating.

### 4.2 Align docs with runtime behavior

Fixes: `F7`

Implementation:

1. Update docs to match new pending-confirmation semantics:
   - large-cap
   - low-confidence
   - extreme-move
2. Decide explicitly on orphan behavior:
   - if runtime behavior remains unchanged, update docs to say tracked coins stay open through transient missing-price/low-supply gaps
   - do not leave a doc/runtime mismatch in place
3. Update `/methodology` page mapping if public explanatory copy changes.

Primary files:

- `docs/depeg-detection.md`
- `docs/data-pipeline.md`
- `docs/data-flow-map.md`
- `docs/api-reference.md`
- `docs/worker-infrastructure.md`
- `docs/methodology-page.md`
- `src/app/methodology/page.tsx` if required

Acceptance criteria:

- Docs reflect the actual live system.
- Public methodology copy no longer overpromises unsupported behavior.

### 4.3 Expand regression coverage around the audited risks

Fixes: cross-cutting test gap

Implementation:

1. Add regression tests for:
   - cached fallback provenance
   - low-confidence confirmation-required routing
   - extreme move promotion/update
   - backend freshness meta driving stale banners
   - non-USD `coinsAtPeg`
   - infinite event pagination
2. Tighten any mocks that currently allow silent warnings without failing the intended assertion path.

Primary files:

- `worker/src/cron/__tests__/detect-depegs.test.ts`
- `worker/src/cron/__tests__/confirm-pending-depegs.test.ts`
- `worker/src/cron/__tests__/sync-stablecoins.test.ts`
- `worker/src/api/__tests__/peg-summary.test.ts`
- `src/lib/__tests__/data-health.test.ts`
- new frontend tests as needed

Acceptance criteria:

- Every audited high-severity issue has at least one direct regression test.
- Test names make the reliability contract obvious.

## Recommended PR Sequence

### PR 1: Price Trust + Pending Generalization

- Workstream 1.1
- Workstream 1.2
- shared type additions
- migration for `depeg_pending.reason`

### PR 2: Extreme-Move Coverage

- Workstream 1.3
- detector/confirmation tests
- methodology doc update for extreme confirmation semantics

### PR 3: Freshness + Provenance UI Plumbing

- Workstream 2.1
- Workstream 2.2
- Workstream 2.3

### PR 4: History + Summary Fixes

- Workstream 3.1
- Workstream 3.2
- Workstream 3.3

### PR 5: Ops Reconciliation + Status Surface

- Workstream 4.1
- Workstream 4.2
- Workstream 4.3

This split keeps schema and detector behavior separate from frontend plumbing and operator tooling, which reduces rollback risk.

## Rollout Notes

- Ship PR 1 and PR 2 behind log-heavy observability first.
- After deployment, inspect:
  - pending counts by reason
  - live depeg event count delta
  - active event duration distribution
  - DEX/CG confirmation rates
- Only after confidence is established should `/depeg` UI copy switch fully from “recent” back to “full history” if pagination lands.
- The operational audit job should start report-only. Do not auto-delete events on a cron until at least one week of audit summaries looks sane.
