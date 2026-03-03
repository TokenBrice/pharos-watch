# Coverage Ratchet + Hotspot Test Expansion Plan

**Date:** 2026-03-03  
**Status:** Ready for implementation  
**Scope:** Follow-up implementation for items **#2** (ratchet coverage gates) and **#4** (target low-coverage hotspots).

## 1. Objectives

1. Raise coverage gates gradually without introducing flaky CI.
2. Improve coverage in the highest-value low-coverage modules first.
3. Keep the plan measurable with explicit thresholds, timelines, and pass/fail criteria.

## 2. Current Baseline (Two Lenses)

Coverage in this repo currently has two relevant lenses:

1. **Full suite lens** (`npm run test:coverage`) for overall quality.
2. **Critical-path lens** (`npm run coverage:critical`) for fast deploy gating.

### 2.1 Full Suite Snapshot (2026-03-03)

From `npm run test:coverage`:

| File | Lines |
| --- | --- |
| `src/lib/peg-utils.ts` | 100.00% (19/19) |
| `src/lib/peg-score.ts` | 90.57% (48/53) |
| `worker/src/lib/db.ts` | 79.66% (94/118) |
| `src/lib/supply.ts` | 38.10% (8/21) |

### 2.2 Critical-Path Snapshot (2026-03-03)

From `npm run coverage:critical` (`coverage/lcov.info`):

| File | Lines |
| --- | --- |
| `src/lib/peg-utils.ts` | 0.00% (0/19) |
| `worker/src/lib/db.ts` | 15.25% (18/118) |
| `src/lib/supply.ts` | 19.05% (4/21) |
| `src/lib/peg-score.ts` | 20.75% (11/53) |

### 2.3 Baseline Integrity Risk (Must Fix First)

Vitest is currently discovering and running tests under `.worktrees/*`, which duplicates test execution and pollutes coverage baselines.

This must be fixed before ratcheting thresholds.

## 3. Workstream A: Coverage Ratchet (Item #2)

## 3.1 Design Rules

1. Ratchet only upward.
2. Never increase thresholds and hotspot scope in the same PR.
3. Require stable baselines first (no `.worktrees` contamination).
4. Treat `coverage:critical` and full-suite coverage as separate controls.

## 3.2 Implementation Steps

### A0. Stabilize Measurement

**Files:**
- `vitest.config.ts`

**Changes:**
1. Add `test.exclude` for:
   - `.worktrees/**`
   - `.next/**`
   - `out/**`
   - `coverage/**`
2. Mirror these in `coverage.exclude` where appropriate.

**Validation:**
1. `npm run test:coverage`
2. Confirm no test files from `.worktrees/*` appear in output.

### A1. Make Thresholds Explicit and Auditable

**Files:**
- `vitest.config.ts`
- `scripts/check-critical-coverage.mjs`
- `docs/testing.md`

**Changes:**
1. Keep global line threshold in `vitest.config.ts`, but document each change in `docs/testing.md`.
2. Keep `scripts/check-critical-coverage.mjs` as the critical gate and set `CRITICAL_COVERAGE_THRESHOLD` explicitly in CI env (not implicit default).

### A2. Ratchet Schedule (Absolute Dates)

Apply only after A0 is merged and baseline re-collected.

1. **Step 1 (target date: March 5, 2026)**
   - Global line threshold: `50 -> 55`
   - Critical threshold: `35 -> 40`
2. **Step 2 (target date: March 12, 2026)**
   - Global line threshold: `55 -> 60`
   - Critical threshold: `40 -> 45`
3. **Step 3 (target date: March 19, 2026)**
   - Global line threshold: `60 -> 65`
   - Critical threshold: `45 -> 50`

**Promotion gate for each step:**
1. 5 consecutive passing CI runs on `main`.
2. No emergency threshold rollback in prior step.

### A3. CI Policy

**File:**
- `.github/workflows/deploy-cloudflare.yml`

**Changes:**
1. Pass explicit `CRITICAL_COVERAGE_THRESHOLD` per ratchet step.
2. Keep existing execution order unchanged.

## 3.3 Acceptance Criteria

1. Coverage runs no longer include `.worktrees/*`.
2. Ratchet steps happen on schedule with no threshold rollback.
3. CI fails on threshold regressions exactly as configured.

## 4. Workstream B: Hotspot Test Expansion (Item #4)

This section keeps the originally selected hotspots, but prioritizes by real risk and current full-suite gaps.

## 4.1 Priority Order

1. `src/lib/supply.ts` (true low coverage in full suite)
2. `worker/src/lib/db.ts` (high-impact infra module; low in critical lens)
3. `src/lib/peg-score.ts` (add missing wrapper branch coverage)
4. `src/lib/peg-utils.ts` (already high in full suite; ensure fast-path invariants include it)

## 4.2 File-by-File Plan

### B1. `src/lib/supply.ts`

**Current line coverage:**
1. Full suite: 38.10%
2. Critical lens: 19.05%

**Missing area:** `computeGovernanceBreakdown`.

**Tests to add (in `src/lib/__tests__/supply.test.ts`):**
1. Splits market cap into centralized / centralized-dependent / decentralized buckets.
2. Skips untracked IDs (`TRACKED_META_BY_ID` miss path).
3. Returns all percentages as `0` when total is `0`.
4. Handles mixed valid and invalid circulating values through existing numeric coercion path.

**Target after B1:**
1. Full-suite lines >= 70% for `src/lib/supply.ts`.

### B2. `worker/src/lib/db.ts`

**Current line coverage:**
1. Full suite: 79.66%
2. Critical lens: 15.25%

**Missing areas:** query/pagination/cache helpers and error/prune branches in cron logging.

**Tests to add:**
1. New file `worker/src/lib/__tests__/db-utils.test.ts`:
   - `buildPaginatedQuery` variants (with/without conditions, limit-only, offset-only, both).
   - `getCache` null row and mapped row.
   - `setCacheIfNewer` branch where `meta.changes === 0`.
   - `savePriceCache` and `upsertOnchainSupply` early-return branches (`[]` input).
   - `getPriceCache`, `getOnchainSupply`, `getFirstSeenDates` mapping behavior.
2. Extend `worker/src/lib/__tests__/log-cron-run.test.ts`:
   - prune fallback path (`DELETE ... started_at < ?` fails, safety valve delete succeeds).
   - double-failure path where both prune attempts fail (ensures branch coverage and no throw).

**Target after B2:**
1. Full-suite lines >= 85% for `worker/src/lib/db.ts`.
2. Critical lens lines >= 45% for `worker/src/lib/db.ts` (by including selected tests in invariants pack if needed).

### B3. `src/lib/peg-score.ts`

**Current line coverage:**
1. Full suite: 90.57%
2. Critical lens: 20.75%

**Missing area in full suite:** `computePegScoreWithWindow` wrapper branch (`isNavToken || !events` and earliest-date path).

**Tests to add (in `src/lib/__tests__/peg-scoring.test.ts`):**
1. `computePegScoreWithWindow` returns `null` for NAV tokens.
2. Returns `null` for missing `events`.
3. Uses parsed `earliestTrackingDate` when present and returns deterministic output shape.

**Target after B3:**
1. Full-suite lines >= 95% for `src/lib/peg-score.ts`.

### B4. `src/lib/peg-utils.ts`

**Current line coverage:**
1. Full suite: 100.00%
2. Critical lens: 0.00%

This is not a full-suite hotspot anymore; action here is about **critical-path visibility**.

**Tests to add/route:**
1. Add one compact invariant test in `src/lib/__tests__/critical-invariants.test.ts` that exercises:
   - interval merge behavior (`mergeDepegSeconds`)
   - worst signed deviation selection (`worstDeviation`)

**Target after B4:**
1. Critical-lens lines >= 70% for `src/lib/peg-utils.ts`.

## 4.3 PR Sequence

1. **PR-1:** A0 baseline stabilization (`vitest.config.ts` excludes only).
2. **PR-2:** B1 + B3 (`supply.ts` and `peg-score.ts` tests).
3. **PR-3:** B2 (`db.ts` helper/logging tests).
4. **PR-4:** B4 (critical-lens peg-utils invariant test).
5. **PR-5:** A2 step 1 threshold increase.
6. **PR-6/7:** A2 step 2 and step 3 threshold increases on schedule.

## 5. Verification Commands

Run after each PR:

1. `npm test`
2. `npm run test:coverage`
3. `npm run coverage:critical`
4. `npm run lint`

For targeted iteration:

1. `npm test -- src/lib/__tests__/supply.test.ts`
2. `npm test -- src/lib/__tests__/peg-scoring.test.ts`
3. `npm test -- worker/src/lib/__tests__/db-utils.test.ts worker/src/lib/__tests__/log-cron-run.test.ts`

## 6. Done Definition

This effort is done when all are true:

1. `.worktrees/*` is excluded from test discovery.
2. Threshold ratchet step 1 (`55/40`) is merged and green.
3. `src/lib/supply.ts` meets >= 70% lines.
4. `worker/src/lib/db.ts` meets >= 85% full-suite lines and >= 45% critical-lens lines.
5. `src/lib/peg-score.ts` meets >= 95% lines.
6. `src/lib/peg-utils.ts` has explicit critical-lens coverage via invariants.
7. `docs/testing.md` reflects new thresholds and hotspot policy.
