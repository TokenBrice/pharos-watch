# Structural Refactor Implementation Plan — Tier 3 (Independent Autonomous Runbook)

**Date:** 2026-03-04  
**Status:** Proposed (execution-ready)  
**Owner:** Engineering  
**Execution Mode:** Autonomous (no additional architectural decisions during implementation)  
**Scope:** High-effort structural refactors for long-term maintainability with strict behavior parity.

## 1. Objective

Execute Tier 3 refactors as an independent track with locked design choices, explicit safety gates, and deterministic validation:

1. Converge mint/burn cron + backfill ingestion paths onto shared pipeline modules.
2. Decompose `stablecoin/[id]` client into a view-model + section components + pure derivation helpers.
3. Reduce schema/interface duplication in `src/lib/types.ts` using `z.infer` where parity is exact.

This runbook is independent from Tier 1/2 and can execute on a separate branch without prerequisite merges.

## 2. Scope

In scope:

1. `worker/src/cron/sync-mint-burn.ts` + `worker/src/api/backfill-mint-burn.ts` structural convergence.
2. `src/app/stablecoin/[id]/client.tsx` decomposition.
3. `src/lib/types.ts` schema/interface dedup for explicitly approved schema-backed pairs.
4. Required documentation updates tied to these changes.

Out of scope:

1. Endpoint behavior or payload shape changes.
2. Scoring formula changes.
3. UI redesigns or copy changes.
4. New features outside these three workstreams.

## 3. Non-Negotiable Guardrails

1. Preserve existing API response shapes and status codes.
2. Preserve mint/burn semantics:
   - inserted vs ignored counting
   - burn classification counters (`effective/bridge/review`)
   - `nextFromBlock`, `done`, sync-state advancement behavior
   - hourly aggregate computation rules
3. Preserve stablecoin detail page section IDs and route behavior.
4. Keep Tailwind classes static strings.
5. Keep Worker external dependency surface unchanged.
6. Prefer extraction + deletion over dual-path coexistence.
7. Keep Worker fetch pattern sequential within a config/event loop (do not add `Promise.all` fan-out for log fetching; protect 6-connection budget constraints).

## 4. Locked Decisions (No Mid-Run Architecture Choice)

### 4.1 Execution Order

1. **T3-C first** (lowest runtime risk, compacts type surface).
2. **T3-B second** (frontend-only structural extraction).
3. **T3-A last** (highest operational risk; strongest safety harness required).

### 4.2 Mint/Burn Module Layout (Locked)

Create shared pipeline modules under `worker/src/lib/mint-burn-pipeline/`:

1. `types.ts`
   - shared row/context/counter types currently duplicated or imported from cron.
2. `parse.ts`
   - `parseMintBurnLogs(...)`
   - event-price resolution helper(s).
3. `classification.ts`
   - `classifyBridgeBurnRows(...)` + tx-context resolution helpers.
4. `context.ts`
   - price + price-history loading helpers for single and batched stablecoin IDs.
5. `persistence.ts`
   - row insert helper
   - burn classification update helper
   - affected-hour aggregation helper
6. `sync-state.ts`
   - sync-state read/init/upsert helpers (with explicit monotonic mode control for backfill).

Hard requirement: `worker/src/api/backfill-mint-burn.ts` must no longer import from `../cron/sync-mint-burn`.

### 4.3 Stablecoin Detail Decomposition Boundaries (Locked)

Add:

1. `src/hooks/use-stablecoin-detail-view-model.ts`
2. `src/lib/stablecoin-detail-derive.ts`
3. `src/lib/__tests__/stablecoin-detail-derive.test.ts`
4. `src/components/stablecoin-detail/hero-card.tsx`
5. `src/components/stablecoin-detail/overview-section.tsx`
6. `src/components/stablecoin-detail/chart-section.tsx`
7. `src/components/stablecoin-detail/info-section.tsx`
8. `src/components/stablecoin-detail/flows-section.tsx`
9. `src/components/stablecoin-detail/liquidity-section.tsx`
10. `src/components/stablecoin-detail/depeg-history-section.tsx`
11. `src/components/stablecoin-detail/notices-and-summary-section.tsx`

Keep local state for feedback modal open/close in `client.tsx` (do not move to global/shared state).

### 4.4 Schema/Interface Conversion Scope (Locked)

Convert to `z.infer` in this tier:

1. `DexLiquidityPool`
2. `DexPriceSource`
3. `DexLiquidityData`
4. `StabilityIndexComponents`
5. `StabilityContributor`
6. `StabilityIndexMethodology`
7. `StabilityIndexCurrent`
8. `StabilityIndexHistoryPoint`
9. `StabilityIndexResponse`
10. `DepegDewsMethodology`

Keep manual interfaces in this tier:

1. `ReportCardsResponse` (intentional narrowing vs schema).
2. `AltYieldSource`, `YieldRanking`, `YieldRankingsResponse` (narrow string unions not represented in schema).
3. `StressSignalEntry`, `StressSignalsAllResponse`, `StressSignalDetailResponse` (passthrough/dynamic structure where manual typing remains intentional).

## 5. Branching and PR Slicing

Branch recommendation:

1. `refactor/tier3-independent`

PR sequence (do not reorder):

1. `PR-T3C-1` schema/interface dedup (small safe batches).
2. `PR-T3B-1` derivation extraction + view-model + tests.
3. `PR-T3B-2` section decomposition + client thinning.
4. `PR-T3A-1` mint/burn shared parse/classification/context extraction.
5. `PR-T3A-2` mint/burn persistence/sync-state extraction + duplicate deletion.

## 6. Global Preconditions (Run Once Before Any Workstream)

### 6.1 Baseline Commands

1. `npm run lint`
2. `npm test`
3. `npm run build`
4. `cd worker && npx tsc --noEmit`

### 6.2 Baseline Evidence to Capture in PR Description

1. Current line counts for primary files:
   - `worker/src/cron/sync-mint-burn.ts`
   - `worker/src/api/backfill-mint-burn.ts`
   - `src/app/stablecoin/[id]/client.tsx`
   - `src/lib/types.ts`
2. Existing targeted tests green:
   - `worker/src/cron/__tests__/sync-mint-burn.test.ts`
   - `worker/src/api/__tests__/backfill-mint-burn.test.ts`

If baseline is red, stop and fix baseline first before refactor work.

## 7. Workstream T3-C — Schema/Interface Dedup with `z.infer`

### 7.1 Entry Criteria

1. Global preconditions complete.
2. No unrelated edits in `src/lib/types.ts` pending.

### 7.2 Implementation Steps

#### Step C0 — Inventory Freeze

1. Add a short comment block in `src/lib/types.ts` near converted zones indicating:
   - schema-backed type aliases use `z.infer`
   - intentional manual interfaces are explicitly documented.

#### Step C1 — Convert Locked Safe Pairs

1. Replace listed interfaces in section 4.4 with `export type X = z.infer<typeof XSchema>`.
2. Keep exported names unchanged.
3. Preserve field optionality/nullability exactly as schema defines.

#### Step C2 — Preserve Intentional Manual Types

1. Leave `ReportCardsResponse`, yield, and stress-signal manual interfaces in place.
2. Ensure each retained manual interface has a concise reason comment.

#### Step C3 — Cleanup

1. Remove now-unused duplicated interfaces.
2. Update imports if any callsites require type-only import normalization.

### 7.3 Verification

Run after each converted batch:

1. `npm run build`
2. `cd worker && npx tsc --noEmit`
3. `npm test -- src/lib/__tests__/api-fetch-contracts.test.ts src/lib/__tests__/strict-path-drift.test.ts`

### 7.4 Acceptance Criteria

1. All 10 locked safe pairs converted to `z.infer`.
2. Intentional manual interfaces remain with rationale comments.
3. No consumer import/name breakage.
4. Build + worker typecheck pass.

### 7.5 Stop Conditions

Stop and re-plan if either occurs:

1. Conversion forces behavioral schema change (out of scope).
2. Callsites rely on wider manual types than schema allows and cannot be fixed without API contract changes.

## 8. Workstream T3-B — Stablecoin Detail Client Decomposition

### 8.1 Entry Criteria

1. T3-C merged or locally green.
2. `src/app/stablecoin/[id]/client.tsx` baseline behavior confirmed.

### 8.2 Implementation Steps

#### Step B0 — Derivation Test Harness First

Add deterministic tests for extracted pure logic:

1. Deviation bps computation (including null price and NAV token behavior).
2. 90d reference selection and 7-day tolerance fallback-to-zero behavior.
3. Supply fallback (`mcap/price` vs `mcap`).
4. Peg reference fallback handling and guard behavior.

#### Step B1 — Extract Pure Helpers

1. Move derivations to `src/lib/stablecoin-detail-derive.ts`.
2. Keep helpers pure (no hooks, no side effects, no Date.now usage without injected `nowMs`).
3. `client.tsx` should consume helper outputs only.

#### Step B2 — Build View-Model Hook

1. Add `useStablecoinDetailViewModel` to encapsulate:
   - all existing query hook wiring
   - retry-all orchestration
   - normalized loading/error/not-found states
   - derived values used by sections
2. Do not change underlying query hooks or cache timing behavior.

#### Step B3 — Split Sections

1. Move JSX blocks into locked section files from section 4.3.
2. Keep section IDs unchanged:
   - `report-card`
   - `overview`
   - `chart`
   - `info`
   - `flows`
   - `liquidity`
   - `history`
   - `flow-history`
3. Keep copy/text unchanged unless correction is required for parity.

#### Step B4 — Thin Client Composition Layer

1. `client.tsx` should orchestrate only:
   - local modal state
   - top-level guard branches (loading/list error/not-found)
   - section composition
2. Remove dead local constants/functions replaced by helpers/hook.

### 8.3 Verification

1. `npm run build`
2. `npm run lint`
3. `npm test -- src/lib/__tests__/stablecoin-detail-derive.test.ts`

Manual QA (required):

1. `/stablecoin/2/` (high-volume standard USD stablecoin path).
2. `/stablecoin/237/` (NAV token behavior path).
3. `/stablecoin/147/` (coin notices + warning path).

For each route verify:

1. page renders without runtime errors
2. section nav anchors jump correctly
3. feedback modal opens from hero
4. depeg section visibility matches NAV/non-NAV behavior
5. visual values match pre-refactor behavior for same cached data

### 8.4 Acceptance Criteria

1. `client.tsx` is an orchestration/composition layer, not a mixed-responsibility monolith.
2. Pure derivations are covered by deterministic tests.
3. Route behavior and rendered content are functionally equivalent.

### 8.5 Stop Conditions

Stop and re-plan if either occurs:

1. Required parity can only be achieved with major component API redesign.
2. Existing detail-page dependent components require broad upstream refactors outside this scope.

## 9. Workstream T3-A — Mint/Burn Pipeline Convergence

### 9.1 Entry Criteria

1. T3-B complete and green.
2. Mint/burn baseline tests passing.

### 9.2 Implementation Steps

#### Step A0 — Safety Harness Expansion (Before Any Extraction)

Strengthen tests first:

1. `worker/src/cron/__tests__/sync-mint-burn.test.ts`
2. `worker/src/api/__tests__/backfill-mint-burn.test.ts`
3. Add focused shared-module test file:
   - `worker/src/lib/__tests__/mint-burn-pipeline.test.ts`

Lock assertions for:

1. inserted vs ignored accounting
2. burn classification counters
3. `done` + `nextFromBlock` behavior
4. sync-state progression semantics
5. hourly aggregation correctness for affected buckets

#### Step A1 — Extract Parse + Classification Out of Cron File

1. Move `parseMintBurnLogs` and bridge burn classification helpers from cron file into shared pipeline modules.
2. Update cron/backfill to import from `worker/src/lib/mint-burn-pipeline/*`.
3. Remove backfill dependency on cron module exports.

#### Step A2 — Extract Shared Context Loading

1. Move duplicated price and price-history loading into `context.ts`.
2. Keep query ordering and null-handling behavior exactly unchanged.

#### Step A3 — Extract Shared Persistence Helpers

1. Move duplicated SQL blocks for:
   - event inserts
   - burn classification updates
   - hourly recomputation
2. Keep SQL semantics identical (including `INSERT OR IGNORE` behavior and aggregation filters).

#### Step A4 — Extract Sync-State Helpers

1. Consolidate sync-state read/upsert helpers into `sync-state.ts`.
2. Preserve behavioral difference explicitly:
   - cron path: writes computed progression target for current run
   - backfill path: monotonic max-upsert semantics (never regress)

#### Step A5 — Delete Duplicate Inline Logic

1. Remove replaced inline helpers from cron/backfill files.
2. Keep only orchestration logic specific to each entrypoint.

### 9.3 Verification

Required targeted tests:

1. `npm test -- worker/src/lib/__tests__/mint-burn-pipeline.test.ts`
2. `npm test -- worker/src/cron/__tests__/sync-mint-burn.test.ts`
3. `npm test -- worker/src/api/__tests__/backfill-mint-burn.test.ts`
4. `npm test -- worker/src/api/__tests__/mint-burn-events.test.ts worker/src/api/__tests__/mint-burn-flows.test.ts`

Required compile/lint/build:

1. `npm run lint`
2. `npm run build`
3. `cd worker && npx tsc --noEmit`

Static duplication checks (must pass):

1. `rg -n "from \"../cron/sync-mint-burn\"" worker/src/api/backfill-mint-burn.ts` returns no hits.
2. `rg -n "INSERT OR IGNORE INTO mint_burn_events|UPDATE mint_burn_events\s+SET burn_type|INSERT OR REPLACE INTO mint_burn_hourly" worker/src/cron/sync-mint-burn.ts worker/src/api/backfill-mint-burn.ts` returns no hits.

### 9.4 Acceptance Criteria

1. Shared mint/burn pipeline modules exist and are consumed by both cron and backfill.
2. No cron->api cross-import coupling remains.
3. Contract-critical mint/burn behavior is parity-verified by tests.
4. Worker typecheck passes.

### 9.5 Stop Conditions

Stop and re-plan if either occurs:

1. Convergence requires endpoint contract changes.
2. Sync-state behavior cannot be preserved without dual-path runtime toggles.

## 10. Documentation Updates (Mandatory in Same PRs)

Update as relevant per workstream:

1. `docs/architecture.md`
   - new `worker/src/lib/mint-burn-pipeline/` module structure
   - new stablecoin detail hook/components layout
2. `docs/mint-burn-flows.md`
   - internal ingestion pipeline boundaries (cron/backfill shared helpers)
3. `docs/testing.md`
   - newly added targeted tests and rationale

No methodology docs are expected to change in this Tier 3 scope.

## 11. Validation Matrix

### 11.1 Mandatory After Each Workstream

1. `npm run lint`
2. `npm test`
3. `npm run build`
4. `cd worker && npx tsc --noEmit`

### 11.2 Contract-Critical Gate (Run Before PR Merge)

1. `npm run test:critical-contracts`
2. `npm run test:invariants`

If any gate fails, do not merge; resolve or rollback the current phase.

## 12. Rollback Strategy

1. Keep each workstream in isolated commits and isolated PRs.
2. Rollback precedence:
   - rollback T3-A independently first on ingestion regressions
   - keep T3-B/T3-C if unaffected
3. For T3-A, keep a checkpoint commit immediately before duplicate deletion so shared helpers can be disabled by revert if needed.

## 13. Definition of Done

Tier 3 is complete when all are true:

1. T3-C locked conversion list completed with green build/typecheck.
2. T3-B decomposition completed; `client.tsx` is orchestration-only with parity preserved.
3. T3-A convergence completed with shared pipeline modules and duplicate logic removed.
4. Documentation updates are merged alongside code changes.
5. Validation matrix and contract-critical gates pass in CI.

## 14. Autonomous Execution Checklist

Use this as the final operator checklist before declaring complete:

1. All three workstreams executed in locked order.
2. All stop-condition checks remained false (or were explicitly resolved).
3. Required tests were added before high-risk extraction steps.
4. No out-of-scope behavior or API contract changes were introduced.
5. PR descriptions include baseline + final evidence for each workstream.
