# Admin + Status Enhancement Implementation Plan

Date: 2026-03-20

Source audit:
- [admin-status-review-2026-03-20.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/audits/admin-status-review-2026-03-20.md)

## Objective

Bring `/admin/` and `/status/` into closer alignment with the actual application state, surface the highest-value signals first, and reduce scan cost so both pages become faster to trust and act on.

This plan is intentionally implementation-first. It converts the audit into a staged delivery plan with explicit scope boundaries, dependencies, acceptance criteria, verification, and documentation updates.

## Scope

In scope:

1. Fix semantic drift between frontend status surfaces and worker-side health/status contracts.
2. Surface already-available operator data that is currently fetched but not rendered.
3. Re-structure `/admin/` and `/status/` around failure-first scanning and trust-impact-first reading.
4. Harden the operator action workflow so recommendations and action execution are clearer and safer.
5. Add the missing frontend/model/component coverage needed to keep the status surfaces stable.

Out of scope for this plan:

1. A full visual redesign outside the status-specific components and shells.
2. New upstream telemetry sources or new cron jobs.
3. A new standalone public incident-history endpoint.
   This implementation keeps the public surface focused on current trust and impact, not full incident chronology.
4. A new price-source divergence backend feed.
   The plan resolves the current doc/UI mismatch by narrowing docs to the current contract in this implementation.
5. A public exposure of the operator state machine beyond the current public health contract.
   If the shipped public page still needs recent-incident context after the trust/impact rewrite, handle that in a follow-up with an explicit contract decision.

## Success Criteria

1. `/status/` and `/admin/` no longer represent `/api/health` as "passing" based only on transport success when the payload itself is degraded or stale.
2. Cache rendering uses the full `CacheStatus` contract, including fallback/source freshness state, rather than reducing cache health to age ratio alone.
3. `/admin/` renders all currently high-value status payload sections that are already available and operator-relevant:
   - `reserveDrift`
   - `classificationWarnings`
   - richer `status-history` context
4. `/status/` answers two public questions directly:
   - "Is the public surface trustworthy right now?"
   - "Which public surfaces should I distrust right now?"
5. The admin page defaults to unhealthy/active/problematic information first, with healthy detail collapsed by default.
6. The action panel separates read-only, mutating, and destructive actions and sends idempotency keys for supported endpoints.
7. The implementation ships with targeted frontend and worker tests plus updated docs for any API/behavior change.

## Deliverables

1. Route/component changes for:
   - `src/app/status/client.tsx`
   - `src/app/admin/client.tsx`
   - `src/components/status/*`
2. Shared model/hook changes for:
   - `src/hooks/use-endpoint-probes.ts`
   - `src/hooks/use-status-dashboard-model.ts`
   - `src/hooks/use-status-history.ts`
   - `src/lib/status-dashboard-model.ts`
3. Worker/shared contract changes for:
   - `worker/src/api/health.ts`
   - `worker/src/api/status.ts`
   - `shared/types/status.ts`
   - `shared/lib/api-endpoints.ts`
4. Tests covering:
   - browser-probe semantics
   - cache-state rendering
   - grouped-cause ordering
   - admin action metadata/execution
   - public impacted-surface mapping
   - status/health contract additions
5. Documentation updates in:
   - `docs/status-dashboard.md`
   - `docs/api-reference.md`
   - `docs/testing.md` if new test entry points are added

## Refinement Loop

### Draft issues identified and resolved

Previous medium issues in the first draft of this plan:

1. Scope was too broad and mixed correctness fixes with speculative product expansion.
   - Risk: the work could sprawl into a general redesign and stall before the semantic bugs are fixed.
   - Refinement: the plan now treats semantic correctness as Phase 1 and blocks later UI restructuring on those fixes. It also explicitly excludes a new public history endpoint and a new price-divergence backend feed.

2. Public recent-incident context was underspecified.
   - Risk: exposing operator state or introducing a public incident-summary contract would add scope and semantic ambiguity not required for the core fix.
   - Refinement: this plan now keeps the public implementation focused on current trust and impact only. Recent-incident context is explicitly deferred unless still needed after the main rewrite.

3. Admin action hardening lacked a concrete mechanism.
   - Risk: "make actions safer" would stay vague and hard to verify.
   - Refinement: the plan now requires shared action metadata for grouping/labeling and explicit `Idempotency-Key` generation for supported endpoints.

4. The UI restructuring had no clear rollback boundary.
   - Risk: a large page rewrite could make regressions hard to isolate.
   - Refinement: each phase is now shippable on its own, with explicit stop points after semantic fixes and after admin surface improvements.

5. Verification was too qualitative.
   - Risk: the plan could be "done" without proving that the surfaces now represent the real state correctly.
   - Refinement: the test matrix and acceptance criteria now include contract, model, component, and route-level checks tied directly to the audit findings.

Residual medium issues after refinement: 0

## Design Decisions

1. Correctness ships before layout polish.
   If the UI and backend disagree semantically, fix the contract usage first and move the cards later.

2. Public status remains trust-first, not operator-first.
   `/status/` should explain trust impact, not expose the full operator console.

3. Admin stays evidence-first, not "hero-first".
   The top fold should point the operator into the right lane, not repeat the whole incident in multiple formats.

4. No new public endpoint unless existing contracts cannot support the required behavior.
   The default path in this implementation is to avoid new public status contracts entirely.

5. Existing status payload fields should be rendered before adding new backend signals.
   Rendering `reserveDrift` and `classificationWarnings` is higher-value than inventing new metrics.

6. Healthy detail is secondary by default.
   The pages should collapse or demote healthy caches, healthy cron lanes, and non-actionable diagnostics.

## Sequencing

Execution order:

1. Phase 0: baseline contract/test prep
2. Phase 1: semantic correctness foundation
3. Phase 2: admin operator surface improvements
4. Phase 3: public trust surface improvements
5. Phase 4: action workflow hardening
6. Phase 5: docs, polish, verification, rollout

Stop points:

1. Stop point A: after Phase 1 if semantics are fixed and the UI can safely be improved later without user-facing misrepresentation.
2. Stop point B: after Phase 2 if the admin surface is corrected and the public page restructure needs to ship separately.

Dependency notes:

1. Phase 1 must land before any major UI reordering.
2. Phase 4 depends on Phase 2 because action grouping and recommendations should use the final admin lane structure.
3. Docs should be updated only after the contract/UI shape is final, but before completion is claimed.

## Phase 0: Baseline Contract And Test Prep

Goal:
- establish stable fixtures and test hooks before changing semantics

Implementation steps:

1. Add or expand shared fixture builders for:
   - semantic `/api/health` degraded/stale payloads
   - full `CacheStatus` objects with FX fallback/source warnings
   - `reserveDrift` and `classificationWarnings`
   - richer `status-history` payloads
2. Add or expand frontend model/component tests for the current status model so later changes are easy to diff.
3. Inventory any status-specific docs that must change when `/api/health` or shared types change.

Acceptance criteria:

1. Test fixtures can represent all new UI states before implementation begins.
2. There is a clear before/after test target for semantic probe handling and cache rendering.

## Phase 1: Semantic Correctness Foundation

### Workstream 1A: Semantic Browser Probe Results

Problem:
- browser probes currently treat HTTP 2xx as success, even when `/api/health` semantically reports `degraded` or `stale`

Implementation steps:

1. Extend `EndpointProbeResult` in `shared/types/status.ts` to support optional semantic fields:
   - `httpStatus`
   - `semanticStatus`
   - `semanticDetail`
   - `scope`
2. Update `src/hooks/use-endpoint-probes.ts`:
   - keep generic transport probing for most routes
   - special-case `/api/health` to parse the JSON payload and record semantic status
   - retain transport failure details separately from semantic degradation
3. Update the dashboard model and probe grid to distinguish:
   - unreachable
   - reachable but degraded/stale
   - healthy
4. Keep the worker `status-self-check` semantics aligned with the browser probe interpretation.

Acceptance criteria:

1. A `200` `/api/health` response with body `status: "degraded"` no longer appears as a clean pass in either page.
2. Probe UI copy clearly distinguishes local reachability from system health.

Primary files:

- `src/hooks/use-endpoint-probes.ts`
- `src/lib/status-dashboard-model.ts`
- `src/components/status/endpoint-health-grid.tsx`
- `shared/types/status.ts`

### Workstream 1B: Full Cache-State Rendering

Problem:
- cache UI drops important `CacheStatus` semantics

Implementation steps:

1. Update cache table/card components to accept the full `CacheStatus` contract.
2. Surface:
   - cache mode
   - source status
   - source age / source updated at
   - warning text
   - fallback streak where available
3. Sort by severity using semantic state first, ratio second.
4. Demote fully healthy rows behind a collapsed section where appropriate.

Acceptance criteria:

1. FX cached-fallback mode is visible as such in the UI.
2. A cache with a fresh age ratio but degraded source data is not shown as fully healthy.

Primary files:

- `src/components/status/cache-freshness-table.tsx`
- `src/app/status/client.tsx`
- `src/app/admin/client.tsx`
- `shared/types/status.ts`

### Workstream 1C: `/api/health` Public Signal Parity

Problem:
- the public page does not receive the blacklist metrics it needs to represent trust impact correctly

Implementation steps:

1. Expand `HealthResponse.blacklist` in `shared/types/status.ts` and `worker/src/api/health.ts` to include:
   - `missingRatio`
   - `recentMissingAmounts`
   - `recentWindowSec`
2. Keep all additions backward-compatible and optional where needed.
3. Update Zod schemas and tests.

Acceptance criteria:

1. `/status/` can render blacklist health using the same threshold semantics the backend uses.
2. Existing `/api/health` consumers remain compatible.

Primary files:

- `worker/src/api/health.ts`
- `shared/types/status.ts`
- `src/hooks/api-hooks.ts`

### Workstream 1D: Per-Query Freshness Accounting

Problem:
- dashboard freshness uses the newest query timestamp rather than the oldest important source

Implementation steps:

1. Update `useStatusDashboardModel()` to track:
   - status query updated at
   - public health query updated at
   - probe query updated at
   - history query updated at
2. Replace the single max-timestamp freshness signal with:
   - `freshestAt`
   - `stalestAt`
   - a compact list of lagging sources
3. Use those values in the admin top fold and notices.

Acceptance criteria:

1. The page can no longer look globally fresh because one subquery updated recently.
2. Lagging data sources are named explicitly.

Primary files:

- `src/hooks/use-status-dashboard-model.ts`
- `src/lib/status-dashboard-model.ts`
- `src/app/admin/client.tsx`

## Phase 2: Admin Operator Surface Improvements

### Workstream 2A: Incident Header Simplification

Problem:
- the current admin top fold is repetitive and overloaded

Implementation steps:

1. Keep:
   - effective/raw status
   - confidence
   - current hold duration
   - promoted recommended actions
   - essential freshness timestamps
2. Reduce or collapse:
   - duplicate blocker lists
   - the separate "follow this order" panel if the sticky nav already covers it
3. Move detailed state-machine diagnostics below the first grouped-cause section.

Acceptance criteria:

1. The top fold contains one summary of blockers, not multiple competing summaries.
2. The operator can decide where to go next without reading multiple panels that repeat the same state.

Primary files:

- `src/app/admin/client.tsx`
- `src/components/status/status-banner.tsx`
- `src/components/status/recommended-action-strip.tsx`

### Workstream 2B: Grouped Cause Board

Problem:
- active causes are over-compressed into `causes.overall`

Implementation steps:

1. Replace the current single blocker list with:
   - `Availability causes`
   - `Data quality causes`
   - optional `System/info causes`
2. Keep a short executive summary, but render the grouped cause inventory directly underneath.
3. Preserve action buttons inline where there is a mapped action.

Acceptance criteria:

1. Operators can see the full active cause graph by layer.
2. The grouped cause board sorts by severity within each layer.

Primary files:

- `src/components/status/status-facts.tsx`
- `src/lib/status-dashboard-model.ts`

### Workstream 2C: Render Hidden Operator Signals

Problem:
- `/api/status` returns important operator data that the UI ignores

Implementation steps:

1. Add a `Reserve integrity` card for `reserveDrift`.
2. Add a `Classification review` card for `classificationWarnings`.
3. Expand the history lane to use more of `/api/status-history`:
   - state/staleness snapshot
   - probe summary
   - discrepancy summary
   - transition truncation messaging if the limit is hit

Acceptance criteria:

1. `reserveDrift` and `classificationWarnings` are visible when present.
2. The history lane no longer discards most of the endpoint payload.

Primary files:

- `src/app/admin/client.tsx`
- `worker/src/api/status.ts`
- `worker/src/api/status-history.ts`
- `src/components/status/transition-timeline.tsx`

### Workstream 2D: Reliability Lane Cleanup

Problem:
- the reliability lane contains manual-action noise and healthy detail competes with broken detail

Implementation steps:

1. Remove the `manual` pseudo-group from the endpoint-health grid in the admin reliability lane.
2. Sort probes by:
   - transport failure
   - semantic degradation
   - healthy
3. Collapse healthy cache rows and healthy probe groups by default.

Acceptance criteria:

1. Reliability lane shows actual reliability signals only.
2. Broken and degraded rows appear before clean rows everywhere in the lane.

Primary files:

- `src/components/status/endpoint-health-grid.tsx`
- `src/components/status/cache-freshness-table.tsx`
- `src/app/admin/client.tsx`

## Phase 3: Public Trust Surface Improvements

### Workstream 3A: Public Top Fold Reframing

Problem:
- `/status/` does not map telemetry to trust impact

Implementation steps:

1. Reframe the public top fold into three direct questions:
   - `Trust now`
   - `Affected surfaces`
   - `Live watch`
2. Add a mapping layer from unhealthy cache keys / failed public canaries to impacted public surfaces.
   Proposed location:
   - `src/lib/status-surface-impact.ts`
3. Keep the current hero tone/copy system, but swap the overview emphasis from telemetry-first to trust-impact-first.

Acceptance criteria:

1. A public user can tell what is affected without understanding the internal cache/cron model.
2. The page defaults to actionable public trust interpretation rather than internal diagnostics.

Primary files:

- `src/app/status/client.tsx`
- `src/components/status/public-status-hero.tsx`
- `src/lib/status-dashboard-model.ts`

### Workstream 3B: Structured Public Warnings

Problem:
- public warnings are raw strings

Implementation steps:

1. Normalize known warning classes into structured cards:
   - data trust
   - monitoring degraded
   - browser/local issue
2. Keep raw strings in an advanced diagnostics disclosure only.
3. Use the new `/api/health.blacklist` fields to build cleaner user-facing copy.

Acceptance criteria:

1. `/status/` no longer leads with machine-oriented warning strings.
2. Warning cards are categorized and consistent in tone.

Primary files:

- `src/app/status/client.tsx`
- `src/components/status/page-primitives.tsx`
- `worker/src/api/health.ts`

### Workstream 3C: Demote Browser Diagnostics

Problem:
- browser probes are over-promoted on the public page

Implementation steps:

1. Move browser probes into an `Advanced diagnostics` block below the trust summary.
2. Keep the probe summary in the hero as a secondary local-sample note, not a primary system verdict.
3. Keep the current public canary set in this implementation and change presentation first; probe-set reduction is deferred unless verification shows material UX or load issues.

Acceptance criteria:

1. Public readers see trust impact first and local-browser diagnostics second.
2. The page copy clearly states that browser probes are local samples.

Primary files:

- `src/app/status/client.tsx`
- `src/components/status/endpoint-health-grid.tsx`
- `src/hooks/use-endpoint-probes.ts`

## Phase 4: Action Workflow Hardening

### Workstream 4A: Action Metadata And Grouping

Problem:
- actions are flat and underspecified

Implementation steps:

1. Extend shared status action metadata to include:
   - `group`
   - `riskLevel`
   - `idempotent`
   - optional `runtimeHint`
2. Re-group the admin actions panel into:
   - Diagnostics
   - Data repair / backfills
   - Messaging / digest
   - Destructive reset
3. Label read-only, mutating, and destructive actions visually.

Acceptance criteria:

1. Operators can distinguish safe diagnostic actions from destructive resets at a glance.
2. The action shelf no longer looks like a flat router dump.

Primary files:

- `shared/lib/api-endpoints.ts`
- `src/components/status/admin-actions-panel.tsx`

### Workstream 4B: Idempotent Action Execution

Problem:
- the frontend does not send idempotency keys even when the backend supports them

Implementation steps:

1. Generate `Idempotency-Key` in `AdminActionButton` for actions marked `idempotent`.
2. Show replay/conflict feedback clearly in the recent-results log.
3. Preserve current behavior for non-idempotent actions.

Acceptance criteria:

1. Re-running a supported action from the UI sends an idempotency key.
2. The result log distinguishes fresh execution from replay/conflict.

Primary files:

- `src/components/status/admin-action-button.tsx`
- `shared/lib/api-endpoints.ts`

### Workstream 4C: Recommendation Coverage Expansion

Problem:
- recommended actions cover too little of the state surface

Implementation steps:

1. Expand cause-to-action mappings for:
   - reserve sync issues
   - liquidity scorer failures
   - daily snapshot/digest issues
   - Telegram delivery pressure
2. Add a fallback explanation when a serious cause has no mapped action.
3. Keep the number of promoted actions bounded to avoid reintroducing noise.

Acceptance criteria:

1. Serious common incident patterns either produce a useful recommendation or explain why none exists.
2. The top action strip remains concise.

Primary files:

- `src/components/status/action-recommendations.ts`
- `src/components/status/recommended-action-strip.tsx`

## Phase 5: Docs, Verification, And Rollout

### Documentation updates

1. Update `docs/status-dashboard.md` to match:
   - semantic browser probe behavior
   - public health summary structure
   - admin layout changes
   - rendered reserve/classification signals
2. Update `docs/api-reference.md` for any `/api/health` response additions and any shared type changes.
3. If new status-specific tests/scripts are added, update `docs/testing.md`.
4. Remove or correct the current price-source divergence description if the implementation does not add a divergence feed in this change.

### Verification matrix

Worker/API tests:

1. `worker/src/api/__tests__/health.test.ts`
   - semantic additions
   - blacklist ratio/recent fields
   - public status summary fallback behavior
2. `worker/src/api/__tests__/status.test.ts`
   - hidden signals present and shaped as expected
3. `worker/src/api/__tests__/status-history.test.ts`
   - richer history payload usage and limits

Frontend/model/component tests:

1. probe model classification tests
2. cache rendering tests using full `CacheStatus`
3. grouped-cause ordering tests
4. action grouping / idempotency-key tests
5. public impacted-surface mapping tests

Route/UI tests:

1. Implement these with the existing Vitest + Testing Library frontend test setup; do not add a new browser test framework in this change.
2. `/status/` healthy/degraded/stale route-client render snapshots or equivalent DOM assertions
3. `/admin/` recovery-hold, stale, and DB-unhealthy route-client render snapshots or equivalent DOM assertions
4. explicit check that semantically degraded `/api/health` is not shown as a clean probe pass

Manual verification:

1. public host `/status/`
   - trust summary reads correctly for healthy, degraded, and stale fixtures
   - advanced diagnostics stay secondary
2. ops host `/admin/`
   - top fold no longer duplicates blocker content
   - unhealthy rows sort first
   - hidden signals render when present
   - action results show idempotent replay/conflict clearly

## Rollout And Risk Control

1. Ship Phase 1 first if needed.
   This is the highest-value correction because it fixes representation bugs without waiting for page restructuring.

2. Prefer backend-compatible additions over breaking contract changes.
   Especially for `/api/health`, additions should be optional and backward-compatible.

3. Keep page rewrites incremental.
   Reuse existing status components where possible; replace or reorder them only after semantics are correct.

4. Do not add new public status endpoints in this implementation unless a hard blocker emerges.

5. If scope pressure appears, defer:
   - any public recent-incident context beyond the trust/impact rewrite
   - action recommendation expansion beyond the highest-confidence mappings
   - non-critical visual cleanup

## Completion Gate

The implementation is complete only when all of the following are true:

1. Phase 1 semantics are live in code and tested.
2. `/admin/` renders the hidden operator signals and no longer buries the cause graph.
3. `/status/` explains trust impact and affected public surfaces directly.
4. The action workflow is grouped, labeled, and idempotent where supported.
5. Relevant docs are updated to match shipped behavior.
6. No unresolved medium issues remain in the implementation plan or rollout checklist.
