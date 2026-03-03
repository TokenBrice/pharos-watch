# Unified Trust UX Refinement Plan

**Date:** 2026-03-03  
**Status:** Proposed (implementation-ready)  
**Owner:** Engineering + Design  
**Scope:** Refinement only. No new endpoints, no new pages, no new scoring models.

---

## 1. Objective

Standardize how Pharos communicates data reliability and query failure states across all existing surfaces so users can immediately distinguish:

1. Fresh data
2. Degraded-but-usable data
3. Stale data
4. Temporarily unavailable data
5. Hard errors

This is a trust and operational clarity refinement, not a feature expansion.

---

## 2. Non-Goals

1. No additional product pages or dashboard modules.
2. No new backend data products.
3. No scoring logic changes (PSI, DEWS, Report Cards, Peg Score, Liquidity Score unchanged).
4. No visual redesign of page layouts.
5. No analytics event taxonomy changes.

---

## 3. Current Baseline and Gaps

Current code already has useful primitives:

1. Freshness metadata exists (`_meta`, `X-Data-Age`, `Warning`) in Worker cache handlers.
2. Frontend has `StaleDataBanner`.
3. Section and page error boundaries exist.
4. Cron cadences are centralized via `CRON_*` constants in `src/hooks/use-api-query.ts`.

Primary gaps:

1. `StaleDataBanner` only uses `dataUpdatedAt` and a fixed `2x staleTime` heuristic.
2. Most hooks use `useApiQuery` and do not consume meta-aware freshness.
3. "Degraded" state is not surfaced consistently even when metadata exists.
4. Error banners are page-specific and inconsistent in tone, action, and severity.
5. `PageError` and section-level errors are structurally separate from query-state messaging.
6. Trust-state mapping has no dedicated test suite (high regression risk).

---

## 4. Target Trust Contract

## 4.1 Canonical Health States

Define one app-wide contract:

1. `fresh`
2. `degraded`
3. `stale`
4. `unavailable`
5. `error`

## 4.2 State Derivation Rules

Derive health state using the following precedence:

1. Query error with no successful data -> `error`
2. Explicit "data not yet available" (`503` cache miss) -> `unavailable`
3. Metadata indicates stale (`meta.status=stale`) -> `stale`
4. Metadata indicates degraded (`meta.status=degraded`) or response has RFC `Warning` header -> `degraded`
5. Fallback to age-based derivation from `dataUpdatedAt` + hook `staleTime`:
   - `age <= staleTime`: `fresh`
   - `staleTime < age <= 1.5 * staleTime`: `degraded`
   - `age > 1.5 * staleTime`: `stale`

## 4.3 Display Policy

1. `fresh`: subtle timestamp only.
2. `degraded`: amber inline notice with short reason.
3. `stale`: elevated amber warning banner (existing behavior upgraded).
4. `unavailable`: neutral info card with "not yet available" copy and retry.
5. `error`: red error notice with retry action.

---

## 5. Architecture Changes

## 5.1 Frontend Contract Layer

Add centralized trust-state utilities:

1. New file: `src/lib/data-health.ts`
2. New types: `DataHealthState`, `DataHealthInfo`, `QueryHealthInput`
3. New pure functions:
   - `deriveDataHealth(input)`
   - `formatDataHealthTimestamp(...)`
   - `mergeHealthStates(...)` for multi-query banners

## 5.2 Fetch + Meta Layer

Refine metadata extraction in `src/lib/api.ts`:

1. Extend `ApiMeta` to include optional warning details:
   - `warning?: string | null`
2. In `apiFetchWithMeta`, parse and retain `Warning` header when present.
3. Keep strict schema behavior unchanged for critical paths.

## 5.3 Query Hook Layer

Update `src/hooks/use-api-query.ts`:

1. Add a health-aware hook variant:
   - `useApiQueryWithHealth(...)`
2. Return shape includes:
   - `health: DataHealthInfo`
   - `meta: ApiMeta | null` (when available)
3. Preserve existing `useApiQuery` API for phased migration.

## 5.4 UI Primitive Layer

Create reusable UI primitives:

1. New file: `src/components/data-health-banner.tsx`
   - Receives one or many `DataHealthInfo`.
   - Renders consistent `degraded/stale/unavailable/error` notice.
2. New file: `src/components/query-error-notice.tsx`
   - Standardized inline error block + retry.
3. Keep `src/components/stale-data-banner.tsx` as compatibility wrapper during migration.

## 5.5 Error Boundary Layer

Refine current boundaries:

1. `src/components/section-error-boundary.tsx`
   - Standardize fallback copy and retry affordance.
   - Include optional `supportingText` prop.
2. `src/components/page-error.tsx`
   - Normalize technical error output for production-safe messaging.
   - Keep `reset()` UX intact.

---

## 6. Endpoint Cadence + Trust Matrix

Introduce a single source of truth map:

1. New file: `src/lib/data-health-config.ts`
2. Define endpoint labels and freshness cadence:
   - `stablecoins`: 15m
   - `peg-summary`: 15m
   - `stress-signals`: 15m
   - `depeg-events`: 15m
   - `report-cards`: 15m
   - `stability-index`: 15m
   - `mint-burn-flows`: 20m
   - `dex-liquidity`: 30m
   - `yield-rankings`: 30m
   - `daily-digest/digest-archive`: 24h
   - `bluechip-ratings`: 24h

Purpose:

1. Remove duplicated label and stale-time definitions scattered across pages.
2. Ensure all surfaces describe data age with the same semantic thresholds.

---

## 7. File-Level Implementation Plan

## 7.1 Core Files (Phase 1)

1. `src/lib/data-health.ts` (new)
2. `src/lib/data-health-config.ts` (new)
3. `src/lib/api.ts` (modify)
4. `src/hooks/use-api-query.ts` (modify)
5. `src/components/data-health-banner.tsx` (new)
6. `src/components/query-error-notice.tsx` (new)
7. `src/components/stale-data-banner.tsx` (modify; compatibility wrapper)

## 7.2 Global Error UI (Phase 2)

1. `src/components/section-error-boundary.tsx` (modify)
2. `src/components/page-error.tsx` (modify)

## 7.3 Page Migrations (Phase 3)

Migrate these existing surfaces to the new health primitives:

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

Migration rule:

1. Replace ad hoc error banners with `QueryErrorNotice`.
2. Replace direct `StaleDataBanner` usage with `DataHealthBanner` (or compatibility wrapper).
3. Keep existing section structure and page layout unchanged.

## 7.4 Docs Alignment (Phase 4)

Update documentation after implementation:

1. `docs/design-language.md` (trust-state copy + semantics)
2. `docs/architecture.md` (new trust primitives)
3. `docs/testing.md` (health-state test coverage)

---

## 8. Testing Plan

## 8.1 New Tests

1. `src/lib/__tests__/data-health.test.ts` (new)
   - state derivation precedence
   - age-threshold mapping
   - multi-query merge behavior
2. Extend `src/lib/__tests__/api-fetch-contracts.test.ts`
   - `Warning` header extraction in `apiFetchWithMeta`
   - compatibility with strict contract paths

## 8.2 Optional Component Tests

If kept dependency-free:

1. Add pure rendering tests for banner decision logic at utility level.
2. Avoid introducing new test libraries unless already approved.

## 8.3 Acceptance Test Scenarios

1. Simulated fresh response (no warnings) -> subtle timestamp only.
2. Simulated degraded response (`meta.status=degraded`) -> amber notice.
3. Simulated stale response (`age > 1.5x`) -> stale warning.
4. Simulated 503 cache miss -> unavailable notice.
5. Simulated network/500 error -> error notice + retry.
6. Existing data + transient refetch error -> keep data visible, show degraded/error context, no hard layout collapse.

---

## 9. Rollout Strategy

## PR 1: Contract + Utilities

1. Add `data-health` library and tests.
2. Extend `ApiMeta` warning handling.
3. Add health-aware hook variant.

## PR 2: Shared Components

1. Introduce `DataHealthBanner` and `QueryErrorNotice`.
2. Keep backward compatibility through `StaleDataBanner`.

## PR 3: High-Traffic Surface Migration

1. Homepage
2. Depeg
3. Stablecoin detail
4. Compare
5. Safety scores

## PR 4: Remaining Surface Migration + Docs

1. Liquidity, yield, flows, blacklist, stability pages, portfolio, digest archive.
2. Update docs and finalize cleanup.

---

## 10. Success Criteria

1. Every query-driven page uses the same trust-state vocabulary and visual severity model.
2. `degraded` and `unavailable` states are explicitly distinguishable from `stale` and `error`.
3. No page contains custom one-off error banner copy outside shared primitives.
4. Trust-state derivation is covered by automated tests.
5. Existing page layouts and navigation remain unchanged.

---

## 11. Risks and Mitigations

1. **Risk:** Too many notices on multi-query pages.
   - **Mitigation:** Collapse into one merged banner with top-priority state.

2. **Risk:** Over-warning users for minor delays.
   - **Mitigation:** Keep severity thresholds tied to endpoint cadence and existing `fresh/degraded/stale` contract.

3. **Risk:** Migration churn across many pages.
   - **Mitigation:** Compatibility wrapper + phased PR slices.

4. **Risk:** Inconsistent fallback behavior during refetch errors.
   - **Mitigation:** Prefer keeping last successful data visible while adding context notice.

---

## 12. Final Decision

Implement a unified trust UX system as a focused refinement stream. This is a high-ROI professionalism upgrade that increases user confidence and operational clarity without adding product scope.
