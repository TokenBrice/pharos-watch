# 2026-03-05 Pharos Maintainability Audit (Consolidated)

## Scope and Constraints

- Scope: maintainability, redundancy, production-risk hardening.
- Excluded: net-new features, architecture rewrites, speculative redesign.
- Change style: incremental, behavior-preserving unless explicitly fixing a bug.

## Executive Summary

1. Silent degradation in DEWS/PSI/yield paths can publish incomplete or biased outputs without escalating run status.
2. API contract drift exists (`/api/digest-snapshot` is routed but absent from endpoint registry), creating probe and test blind spots.
3. Health and status logic is duplicated and already divergent, which can mislead operators during incidents.
4. High code duplication across frontend table components and worker recomputation helpers increases drift risk and fix cost.
5. A few central worker functions are oversized and multi-responsibility, raising regression risk for routine edits.

---

## Critical Findings

### 1) DEWS swallows upstream failures and still reports a normal run

- Location: `worker/src/cron/compute-dews.ts` (notably around lines `63-237`, `387-397`)
- Category: Production Risk
- Severity: Critical
- Current State:
  - Multiple data-source reads are wrapped in broad `catch {}` blocks.
  - The cron still returns as a normal completion and metadata always reports `validationFailures: 0`.
- Recommended Change:
  - Track source-read failures in structured metadata (`sourceFailures`, `sourceCoverage`).
  - Return `status: "degraded"` when critical inputs are unavailable or malformed.
  - Keep first-run/table-missing bootstrapping exceptions explicit and time-bounded.
- Risk Assessment:
  - Risk: more degraded statuses at rollout.
  - Mitigation: bootstrap-aware thresholds and dedicated tests for first-run behavior.

### 2) PSI suppresses DEWS dependency failure by defaulting stress breadth to zero

- Location: `worker/src/cron/stability-index.ts` (around lines `48-68`, `115`)
- Category: Production Risk
- Severity: Critical
- Current State:
  - `stress_signals` query failure is silently ignored, `dewsStressBreadth` stays `0`, PSI is still stored as normal.
- Recommended Change:
  - Mark run `degraded` when DEWS dependency is unavailable.
  - Persist dependency health in metadata/input snapshot (`dewsUnavailable=true`) for traceability.
- Risk Assessment:
  - Risk: visible status changes in production.
  - Mitigation: deploy with alert dampening window and compare old/new status outcomes for 1-2 days.

### 3) Safety-score failures fall back to synthetic defaults and continue yield ranking

- Location: `worker/src/lib/safety-scores.ts` (around lines `194-196`), `worker/src/cron/sync-yield-data.ts` (around lines `173-177`, `510-513`)
- Category: Production Risk
- Severity: Critical
- Current State:
  - Safety computation failures return an empty snapshot.
  - Yield sync defaults to `DEFAULT_SAFETY_SCORE`/`NR` and continues writing.
- Recommended Change:
  - Treat empty/low-coverage safety snapshots as degraded input.
  - Avoid overwriting rankings cache on degraded safety runs (keep last-known-good).
- Risk Assessment:
  - Risk: temporary freshness reduction during dependency issues.
  - Mitigation: expose stale age and degraded reason clearly in metadata and status page.

### 4) Yield rankings schema validation failure does not mark cron degraded

- Location: `worker/src/cron/sync-yield-data.ts` (around lines `615-632`)
- Category: Production Risk
- Severity: High
- Current State:
  - Validation failure skips `yield-rankings` cache write but returns without `status`, so `logCronRun` records `ok`.
- Recommended Change:
  - Return `status: "degraded"` on schema validation failure and increment validation-failure metadata.
- Risk Assessment:
  - Risk: status page shows more degradations.
  - Mitigation: add explicit cause codes so degraded state is diagnosable and actionable.

### 5) Endpoint registry drift leaves a live route unprobed and under-tested

- Location:
  - Route exists: `worker/src/router.ts` (`/api/digest-snapshot`, around lines `138-140`)
  - Missing registry entry: `src/lib/api-endpoints.ts`
  - Registry-driven probing/tests: `worker/src/cron/status-self-check.ts`, `src/hooks/use-endpoint-probes.ts`, `worker/src/api/__tests__/router-contract.test.ts`
- Category: Production Risk
- Severity: High
- Current State:
  - Endpoint is routable but not in centralized endpoint definitions.
  - It is excluded from `getProbePaths(...)` and registry-alignment coverage.
- Recommended Change:
  - Add `/api/digest-snapshot` to `ENDPOINT_DEFINITIONS` with proper probe group/cache/admin metadata.
  - Add an invariant test that router-handled public paths are registry-listed.
- Risk Assessment:
  - Risk: minimal (extra probe traffic).
  - Mitigation: keep current probe cadence and timeout budget.

### 6) Health and status calculations diverged

- Location:
  - Blacklist missing-amount logic: `worker/src/api/health.ts` vs `worker/src/api/status.ts`
  - Mint/burn threshold usage: `worker/src/api/health.ts` vs `worker/src/index.ts`
- Category: Production Risk
- Severity: High
- Current State:
  - Different blacklist gap rules and staleness thresholds are applied in different surfaces.
- Recommended Change:
  - Extract shared evaluators for blacklist and mint/burn freshness and reuse in `health`, `status`, and scheduled alert path.
- Risk Assessment:
  - Risk: changes to effective status outcomes.
  - Mitigation: snapshot tests comparing outputs for fixed fixtures before enabling alert coupling.

---

## Redundancy Report

### A) Cron schedule and expected intervals are duplicated

- Location: `worker/src/index.ts` (cron expressions), `worker/src/api/status.ts` (`CRON_INTERVALS`)
- Category: Redundancy
- Severity: High
- Current State:
  - Schedule source and status expectations can drift independently.
- Recommended Change:
  - Define one canonical schedule config and derive status intervals from it.
- Risk Assessment:
  - Risk: accidental schedule mismatch during migration.
  - Mitigation: one invariant test that compares derived interval map with status expectations.

### B) PSI day-recompute logic duplicated across admin APIs

- Location: `worker/src/api/audit-depeg-history.ts`, `worker/src/api/backfill-stability-index.ts`
- Category: Redundancy
- Severity: High
- Current State:
  - Similar depeg grouping, mcap lookup, 7d trend, and `computeStabilityIndex(...)` assembly duplicated.
- Recommended Change:
  - Extract shared helper (`buildStabilityInputForDay` + `findNearestSupplySnapshot`) and reuse in both handlers.
- Risk Assessment:
  - Risk: subtle numeric changes.
  - Mitigation: golden tests on fixed historical windows pre/post refactor.

### C) DEX liquidity map loading duplicated

- Location: `worker/src/api/report-cards.ts`, `worker/src/lib/safety-scores.ts`
- Category: Redundancy
- Severity: Medium
- Current State:
  - Repeated SQL + mapping code for the same row shape.
- Recommended Change:
  - Introduce shared `loadDexLiquidityMap(db)` helper in worker lib.
- Risk Assessment:
  - Risk: low.
  - Mitigation: keep return type explicit and add one shared loader test.

### D) Stablecoins cache parsing pattern duplicated/inconsistent

- Location: `worker/src/lib/stablecoins-cache.ts` vs manual parsing in `worker/src/cron/compute-dews.ts`, `worker/src/cron/stability-index.ts`, `worker/src/api/backfill-depegs.ts`
- Category: Redundancy
- Severity: Medium
- Current State:
  - Mixed strict/lenient/manual parsing approaches.
- Recommended Change:
  - Route all consumers through `loadStablecoinsCache(...)` with explicit mode choice.
- Risk Assessment:
  - Risk: behavior change from explicit errors.
  - Mitigation: preserve mode semantics (`strict` vs `lenient`) and add caller-level tests.

### E) Frontend table scaffolding duplication

- Location: `src/components/stablecoin-table.tsx`, `src/components/liquidity-table.tsx`, `src/components/flow-table.tsx`, `src/components/depeg-tracker-table.tsx`, `src/components/yield-leaderboard.tsx`
- Category: Redundancy
- Severity: High
- Current State:
  - Shared sortable-header, keyboard interaction, and row wiring patterns are copy-pasted across major table views.
- Recommended Change:
  - Extract a shared table shell with typed column definitions and cell renderers.
- Risk Assessment:
  - Risk: UI regression.
  - Mitigation: incremental migration one table at a time + screenshot/smoke verification.

### F) Unused components add cognitive load

- Location candidates:
  - `src/components/blacklist-summary.tsx`
  - `src/components/bluechip-box.tsx`
  - `src/components/bluechip-rating-card.tsx`
  - `src/components/cemetery-summary.tsx`
  - `src/components/chain-overview.tsx`
  - `src/components/contract-addresses.tsx`
  - `src/components/liquidity-box.tsx`
  - `src/components/market-pulse.tsx`
  - `src/components/peg-type-chart.tsx`
- Category: Redundancy
- Severity: Low
- Current State:
  - No import references found in `src` outside component directory.
- Recommended Change:
  - Remove after a full build/test pass, or annotate and retain behind explicit intent comments.
- Risk Assessment:
  - Risk: hidden dynamic usage.
  - Mitigation: run full build and grep checks before deletion.

---

## Code Quality Findings

### 1) Oversized, multi-concern functions in critical worker paths

- Location:
  - `worker/src/cron/sync-stablecoins.ts`
  - `worker/src/cron/sync-yield-data.ts`
  - `worker/src/api/status.ts` (`computeRawStatus`)
- Category: Code Quality
- Severity: High
- Current State:
  - Fetching, normalization, fallback, persistence, and observability are deeply interleaved.
- Recommended Change:
  - Split into stage-level helpers with explicit typed outputs while retaining current orchestration order.
- Risk Assessment:
  - Risk: refactor regressions.
  - Mitigation: characterization tests around output payload and cron metadata before split.

### 2) Error accounting is inconsistent in blacklist sync

- Location: `worker/src/cron/sync-blacklist.ts` (around lines `616-717`)
- Category: Code Quality
- Severity: Medium
- Current State:
  - Inner API error branches increment `apiErrors`; outer per-config failure catch logs only.
- Recommended Change:
  - Increment `apiErrors` in the outer catch as well and include error class in metadata.
- Risk Assessment:
  - Risk: higher reported failure counts.
  - Mitigation: communicate metric correction in changelog/release notes.

### 3) Run-state persistence failures in mint/burn sync are silent

- Location: `worker/src/cron/sync-mint-burn.ts` (around lines `143-183`)
- Category: Code Quality
- Severity: High
- Current State:
  - `getMintBurnRunState` / `setMintBurnRunState` swallow exceptions with no logging.
- Recommended Change:
  - Log warn-level messages with enough context (job, action, reason) and mark metadata flag when state persistence fails.
- Risk Assessment:
  - Risk: additional log volume.
  - Mitigation: one-line structured logs and dedup keys.

### 4) Hardcoded thresholds are partially centralized

- Location: `worker/src/api/status.ts`, `worker/src/api/health.ts`, `worker/src/index.ts`
- Category: Code Quality
- Severity: Medium
- Current State:
  - Threshold constants and env overrides are not uniformly applied across all consumers.
- Recommended Change:
  - Centralize thresholds in one shared config accessor used by status, health, and scheduled alerts.
- Risk Assessment:
  - Risk: threshold behavior drift.
  - Mitigation: lock defaults and add config snapshot tests.

---

## Sustainability Roadmap (Impact / Effort)

1. **High impact / Low effort**: Fix endpoint registry drift for `/api/digest-snapshot` and add invariants.
2. **High impact / Low effort**: Mark degraded status for yield schema-validation skips.
3. **High impact / Low-medium effort**: Add explicit degraded semantics for DEWS/PSI dependency failures.
4. **High impact / Medium effort**: Consolidate health/status/shared threshold evaluators.
5. **Medium impact / Medium effort**: Extract shared stablecoins cache and dex-liquidity loaders.
6. **Medium impact / Medium effort**: Deduplicate PSI day-recompute helper.
7. **Medium impact / Medium effort**: Begin incremental table-shell extraction on frontend.
8. **Low-medium impact / Low effort**: Remove dead components and resolve lint/build warning noise.

---

## Quick Wins (Immediate, Low-Risk)

- Add `/api/digest-snapshot` to `ENDPOINT_DEFINITIONS`.
- Return `status: "degraded"` in `sync-yield-data` when rankings schema validation fails.
- Increment `apiErrors` in outer `sync-blacklist` per-config catch.
- Add warning logs in mint/burn run-state load/save failure paths.
- Unify blacklist gap logic between `/health` and `/status`.
- Use one mint/burn staleness threshold source across `/health` and scheduled alerting.
- Remove unused `vi` import in `worker/src/api/__tests__/backfill-mint-burn-prices.test.ts`.

---

## Validation Snapshot (Audit Session)

- `npm run lint`: passed with one warning (`unused 'vi'` in backfill mint/burn prices test).
- `npm run build`: passed; existing warnings observed for Next export rewrites and chart width logs during static generation.
- Targeted tests during audit passed:
  - `worker/src/cron/__tests__/sync-yield-data.test.ts`
  - `worker/src/api/__tests__/router-contract.test.ts`
  - `worker/src/api/__tests__/status.test.ts`
