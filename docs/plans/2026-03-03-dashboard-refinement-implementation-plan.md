# Dashboard Refinement Implementation Plan (No Scope Expansion)

**Date:** 2026-03-03  
**Status:** Proposed (implementation-ready)  
**Owner:** Engineering  
**Scope:** Refinement only. No new pages, no new endpoints, no new scoring models.

---

## 1. Objective

Implement three high-leverage refinements that improve trust, operational quality, and professional UX without increasing product scope:

1. Complete the app-wide trust-state contract rollout.
2. Replace full-page reload retries with query-scoped recovery.
3. Resolve React compiler/lifecycle hygiene warnings to stabilize behavior and maintainability.

Expected outcomes:

1. Reliability messaging is consistent across all existing surfaces.
2. Error recovery preserves user context and avoids unnecessary hard refreshes.
3. Frontend warning debt is reduced to near-zero/zero for known high-risk rules.

---

## 2. Non-Goals

1. No additional dashboard modules, filters, cards, charts, or pages.
2. No backend data model or cron cadence redesign.
3. No methodology/scoring changes (Peg, Liquidity, DEWS, PSI, Report Cards).
4. No redesign of visual identity or navigation architecture.
5. No analytics taxonomy expansion.

---

## 3. Current Baseline (as of 2026-03-03)

### 3.1 Already in place

1. Trust primitives exist:
   - `src/lib/data-health.ts`
   - `src/components/data-health-banner.tsx`
   - `src/components/query-error-notice.tsx`
   - `src/lib/data-health-config.ts`
   - `useApiQueryWithHealth` in `src/hooks/use-api-query.ts`
2. Compatibility wrapper exists:
   - `src/components/stale-data-banner.tsx`
3. Query error UI is already centralized in many pages via `QueryErrorNotice`.

### 3.2 Gaps and drift

1. `useApiQueryWithHealth` exists but is not yet used in page/hook callsites.
2. Many retry handlers still call `window.location.reload()`.
3. Trust presets (`DATA_HEALTH_PRESETS`) are defined but not consistently consumed.
4. `StaleDataBanner` docstring still references an old `2x staleTime` heuristic.
5. Lint baseline currently shows significant frontend warning debt:
   - `react-hooks/preserve-manual-memoization`: 25
   - `react-hooks/set-state-in-effect`: 14
   - `react-hooks/purity`: 7
   - plus minor warnings (`incompatible-library`, `unused-vars`, coverage artifact)

---

## 4. Target Contract

### 4.1 Trust-state contract (app-wide)

Canonical states remain:

1. `fresh`
2. `degraded`
3. `stale`
4. `unavailable`
5. `error`

All page-level trust banners and error notices should derive from the same semantics and threshold presets, with no per-page drift in wording or behavior.

### 4.2 Retry contract

Retry actions should be query-scoped by default:

1. Refetch affected query keys.
2. Preserve existing filters, pagination, and scroll state.
3. Avoid full document reload except explicit hard-reset/admin paths.

### 4.3 Frontend quality contract

No unresolved warnings for:

1. `react-hooks/set-state-in-effect`
2. `react-hooks/purity`
3. `react-hooks/preserve-manual-memoization` (or explicit justified waivers where unavoidable)

---

## 5. Workstream A: Complete Trust-State Rollout

## 5.1 Goal

Use a single health derivation path everywhere, including metadata-aware degraded/stale/unavailable states.

## 5.2 Implementation tasks

1. Migrate high-traffic data hooks/pages from ad hoc stale handling to health-aware wiring.
2. Standardize labels/stale windows through `DATA_HEALTH_PRESETS`.
3. Update compatibility wrapper and docs so behavior description matches implementation.
4. Ensure multi-query surfaces merge trust states consistently.

## 5.3 File targets

Core:

1. `src/hooks/use-api-query.ts`
2. `src/lib/data-health-config.ts`
3. `src/components/stale-data-banner.tsx`
4. `src/components/data-health-banner.tsx`

Primary page clients:

1. `src/components/homepage-client.tsx`
2. `src/app/depeg/client.tsx`
3. `src/app/liquidity/client.tsx`
4. `src/app/safety-scores/client.tsx`
5. `src/app/stablecoin/[id]/client.tsx`
6. `src/app/compare/client.tsx`
7. `src/app/portfolio/client.tsx`
8. `src/app/yield/client.tsx`
9. `src/app/flows/page.tsx`
10. `src/app/blacklist/page.tsx`
11. `src/app/stability-index/client.tsx`
12. `src/app/stability-index-alt/client.tsx`
13. `src/components/digest-archive-client.tsx`
14. `src/app/stablecoins/[peg]/client.tsx`

## 5.4 Acceptance criteria

1. No page manually redefines stale labels/thresholds for tracked datasets.
2. All listed surfaces show consistent trust messaging for `degraded/stale/unavailable/error`.
3. Banner behavior is driven by current health semantics, not legacy heuristic comments.

---

## 6. Workstream B: Query-Scoped Retry and Recovery

## 6.1 Goal

Replace hard page reload retries with refetch/invalidate strategies that only refresh failing data dependencies.

## 6.2 Implementation tasks

1. Remove `window.location.reload()` from query retry handlers in user-facing surfaces.
2. Provide local retry callbacks from the relevant query hooks (`refetch`, grouped refetch).
3. For multi-query pages, add deterministic retry ordering:
   - core dataset first
   - secondary enrichments second
4. Keep fallback hard reload only where query-level recovery is impossible (document each exception explicitly).

## 6.3 File targets (known current reload callsites)

1. `src/components/homepage-client.tsx`
2. `src/app/depeg/client.tsx`
3. `src/app/liquidity/client.tsx`
4. `src/app/flows/page.tsx`
5. `src/app/stability-index/client.tsx`
6. `src/app/stability-index-alt/client.tsx`
7. `src/app/stablecoin/[id]/client.tsx`
8. `src/app/yield/client.tsx`
9. `src/app/stablecoins/[peg]/client.tsx`
10. `src/app/compare/client.tsx`
11. `src/app/blacklist/page.tsx`
12. `src/app/portfolio/client.tsx`
13. `src/app/safety-scores/client.tsx`
14. `src/components/digest-archive-client.tsx`

## 6.4 Acceptance criteria

1. Zero `window.location.reload()` usage in query retry handlers on user-facing pages.
2. Retry button behavior does not reset route/filter/pagination state.
3. Pages with partial data continue rendering LKG snapshots while retries run.

---

## 7. Workstream C: React Compiler and Lifecycle Hygiene

## 7.1 Goal

Eliminate high-value warning debt that can lead to unstable render behavior and optimization skips.

## 7.2 Priority warning classes

1. `react-hooks/set-state-in-effect`
2. `react-hooks/purity` (`Date.now`, `Math.random` in render paths)
3. `react-hooks/preserve-manual-memoization`

## 7.3 Key file focus areas

Memoization warnings:

1. `src/app/stability-index/client.tsx`
2. `src/app/stability-index-alt/client.tsx`
3. `src/components/psi-history-chart.tsx`
4. `src/components/dews-detail.tsx`

State-in-effect warnings:

1. `src/app/blacklist/page.tsx`
2. `src/app/portfolio/client.tsx`
3. `src/app/status/client.tsx`
4. `src/components/contagion-graph.tsx`
5. `src/components/depeg-tracker-table.tsx`
6. `src/components/dews-summary.tsx`
7. `src/components/psi-history-chart.tsx`
8. `src/components/sidebar.tsx`
9. `src/hooks/use-homepage-filters.ts`
10. `src/hooks/use-url-filters.ts`
11. `src/hooks/use-portfolio.ts`
12. `src/hooks/use-preferences.ts`
13. `src/hooks/use-stress-test.ts`

Purity warnings:

1. `src/components/market-pulse.tsx`
2. `src/components/dews-summary.tsx`
3. `src/components/feature-highlights.tsx`
4. `src/app/status/client.tsx`
5. `src/app/stablecoin/[id]/client.tsx`

## 7.4 Remediation patterns

1. Replace render-time impure calls with memoized or effect-driven snapshots.
2. Move synchronous state alignment logic to initializer patterns where possible.
3. Refactor unstable memo dependencies to explicit primitive dependency lists.
4. Where a warning is intentionally retained, add a short justification and isolate scope.

## 7.5 Acceptance criteria

1. All targeted warning classes reduced to zero, or documented justified exceptions with owner/date.
2. `npm run lint` passes with no newly introduced warnings.
3. High-traffic pages (`/`, `/depeg`, `/stability-index`, `/stablecoin/[id]`) have no lifecycle/purity warnings.

---

## 8. Execution Sequence (PR Plan)

## PR 1: Trust preset and health plumbing foundation

1. Standardize health preset consumption.
2. Align stale wrapper/docs with current trust semantics.
3. Add/expand utility tests around health derivation and merging.

## PR 2: Retry behavior migration (query-scoped)

1. Replace reload retries in high-traffic pages first.
2. Migrate remaining retry callsites.
3. Add light regression checks for filter/pagination persistence after retry.

## PR 3: Lifecycle/purity warning cleanup (phase 1)

1. Remove `set-state-in-effect` warnings in hooks/shared components.
2. Fix render impurities (`Date.now`, `Math.random`) in shared components.

## PR 4: Memoization warning cleanup (phase 2)

1. Resolve `preserve-manual-memoization` warnings in PSI/stability pages and shared charts.
2. Re-run lint and targeted UI smoke tests.

## PR 5: Final polish + docs

1. Update `docs/design-language.md` trust/error copy sections.
2. Update `docs/testing.md` with lint warning gates and retry behavior expectations.
3. Move plan to `docs/plans/implemented/` after merge and validation.

---

## 9. Test Strategy

## 9.1 Automated

1. `npm run lint`
2. `npm test`
3. `npm run build`
4. Targeted test suites:
   - `src/lib/__tests__/data-health.test.ts`
   - `src/lib/__tests__/api-fetch-contracts.test.ts`
   - retry-related hook/component tests where applicable

## 9.2 Manual QA scenarios

1. Trigger transient API failure on homepage and verify retry does not reset filter state.
2. Verify `503` cache-miss paths render unavailable state, not generic hard error.
3. Confirm stale/degraded banners display consistent copy and tone across pages.
4. On mobile widths, verify retry flows and banners remain readable and non-overlapping.
5. Verify page state persistence (sort/page/search) through failed refresh + successful retry.

---

## 10. Risks and Mitigations

1. Risk: Retry callback wiring diverges page-by-page.
   - Mitigation: enforce shared helper pattern for grouped retries.
2. Risk: Aggressive memo refactors alter chart behavior.
   - Mitigation: run targeted visual smoke checks on PSI/stability/depeg pages before merge.
3. Risk: Lint-driven refactors trigger subtle state ordering regressions.
   - Mitigation: prioritize deterministic hooks tests and small PR batches.

---

## 11. Go/No-Go Gates

Gate 1 (after PR 2):

1. No `window.location.reload()` in query retry handlers.
2. Trust-state behavior consistent on homepage + depeg + detail page.

Gate 2 (after PR 4):

1. Target warning classes resolved (or explicitly waived with rationale).
2. No observed regression in core dashboard navigation/filters.

Gate 3 (before closeout):

1. CI green (`lint`, tests, build).
2. Docs updated.
3. Plan archived under `docs/plans/implemented/` with implementation notes.

---

## 12. Definition of Done

1. Three refinement workstreams are completed without adding product scope.
2. Trust and retry behavior are standardized across existing pages.
3. Frontend warning debt for targeted rules is resolved and sustained in CI practice.
4. Documentation reflects new operational contract and developer expectations.

