# Two-Phase Simplification and Decoupling Implementation Plan

**Date:** 2026-03-05  
**Status:** Phase 1 complete; Phase 2 in progress  
**Owner:** Engineering  
**Execution Mode:** Autonomous, reset-safe  
**Last Updated:** 2026-03-05

## 0) How to Use This Plan

Use this document as the single execution source for the two-phase program.

1. Do not rely on chat memory.
2. Update this file at the end of every PR with:
   1. completed workstream IDs
   2. PR link/number
   3. any scope changes and why
3. If this plan conflicts with current code and current canonical docs, current code + canonical docs win.
4. If any required decision is not explicitly specified here, use the autonomous defaults in section 11.

## 1) Objective

Deliver the simplification and structural refactor program in two phases:

1. **Phase 1:** Complete all simplification, deduplication, and structural cleanup work except worker/frontend cross-layer decoupling.
2. **Phase 2:** Execute long-term worker/frontend decoupling after Phase 1 is stable.

This plan is written so it can be executed after full context reset with no hidden decisions from prior chat state.

## 2) Phase Boundary

1. **In Phase 1:** everything from the simplification audit except cross-layer decoupling.
2. **In Phase 2 only:** reduce worker/frontend cross-layer coupling (`worker/src` importing `src/lib/*` directly).

## 3) Global Success Criteria

All must be true:

1. Phase 1 workstreams complete in locked order.
2. Phase 1 verification gates are green after each PR.
3. No intentional API contract changes (status code, response shape, auth semantics).
4. Docs are updated in the same PRs as behavior/structure changes.
5. Phase 2 has a separate branch and rollout after Phase 1 stabilization.

## 3.1) Entry Criteria

Before starting Phase 1:

1. Baseline gates are green (section 4).
2. No unresolved merge conflicts in working branch.
3. Current canonical docs are reviewed (section 4 bootstrap list).

Before starting Phase 2:

1. Phase 1 is fully merged.
2. No open high-severity regressions from Phase 1.
3. Phase 1 closeout verification has been rerun and is green.

## 3.2) Explicit Exit Criteria by Phase

Phase 1 exits only when:

1. P1-W0 through P1-W9 are all done.
2. Full repo gates are green.
3. Docs are reconciled with all file/path changes.
4. Endpoint and URL behavior parity is confirmed.

Phase 2 exits only when:

1. P2-W1 through P2-W5 are all done.
2. `worker/src` has zero imports of `src/lib/*`.
3. Boundary enforcement checks are active in CI.
4. Full repo gates are green.

## 4) Context-Reset Bootstrap (Read First)

If context is cleared, restart from this section only.

1. Read in this exact order:
   1. `docs/plans/2026-03-05-two-phase-simplification-and-decoupling-implementation-plan.md`
   2. `docs/architecture.md`
   3. `docs/api-reference.md`
   4. `docs/worker-infrastructure.md`
   5. `docs/testing.md`
2. Confirm repository state:
   1. `git status`
   2. `git branch --show-current`
3. Run baseline gates:
   1. `npm run lint`
   2. `npm test`
   3. `npm run build`
   4. `cd worker && npx tsc --noEmit`
4. If baseline fails, create a baseline-fix PR first, then continue with Phase 1.

## 4.1) Environment and Tooling Prerequisites

1. Node version must satisfy root `package.json` engines (`>=20`).
2. `npm`, `npx`, and `wrangler` must be available.
3. Run commands from repository root unless specified otherwise.
4. Network-dependent tests may be flaky; prefer deterministic unit tests for behavior verification.

## 4.2) Persistent Progress Ledger (Must Keep Updated)

Update this table in every implementation PR.

| Workstream | Status (`todo`/`in-progress`/`done`) | PR | Notes |
| --- | --- | --- | --- |
| P1-W0 | done | local | Baseline gates + branch/worktree snapshot captured (2026-03-05) |
| P1-W1 | done | local | Deleted 14 confirmed-unused UI components |
| P1-W2 | done | local | Consolidated polling/health cron constants in `src/lib/cron-intervals.ts` |
| P1-W3 | done | local | Added `withAdmin()` and migrated listed admin handlers |
| P1-W4 | done | local | Converged scoring changelog route on shared methodology changelog shell |
| P1-W5 | done | local | Standardized homepage/blacklist/compare/portfolio URL sync on `use-url-filters` |
| P1-W6 | done | local | Added shared interactive row + sorted/paginated table scaffold and adopted in target tables |
| P1-W7 | done | local | Split worker entrypoint into `handlers/http.ts` and `handlers/scheduled.ts` |
| P1-W8 | done | local | Unified method gating + router dispatch contract via `src/lib/api-endpoints.ts` |
| P1-W9 | done | local | Reconciled docs (`architecture`, `api-reference`, `worker-infrastructure`) + final gates |
| P2-W1 | done | local | Shared boundary contract documented in architecture docs + worker import inventory driven from `rg -n "src/lib/" worker/src` |
| P2-W2 | done | local | Added top-level `shared/` boundary (`shared/lib`, `shared/types`, `shared/index.ts`) + `@shared/*` aliases in root/worker/vitest |
| P2-W3 | done | local | Migrated worker and shared cross-runtime modules to `@shared/*`; `worker/src` direct imports from `src/lib/*` reduced to zero |
| P2-W4 | done | local | Added boundary enforcement in lint + CI (`no-restricted-imports`, `check:worker-boundary`, workflow validate step) |
| P2-W5 | in-progress | local | Docs and scripts reconciled; frontend compatibility re-export shims in `src/lib/*` are intentionally retained for staged cleanup |

## 4.3) Branch and PR Conventions (Autonomous Default)

1. Phase 1 branch name default: `refactor/phase1-simplification`.
2. Phase 2 branch name default: `refactor/phase2-worker-frontend-decoupling`.
3. Commit message prefix default:
   1. `refactor(phase1): ...`
   2. `refactor(phase2): ...`
4. PR title default:
   1. `Phase 1 - <workstream IDs> - <short summary>`
   2. `Phase 2 - <workstream IDs> - <short summary>`

## 5) Non-Negotiable Guardrails

1. Prefer deletion over addition.
2. Keep Tailwind classes static strings.
3. Do not change scoring formulas unless explicitly required by a proven parity bug.
4. Preserve worker cron cadence and provider call semantics.
5. Preserve admin auth and idempotency semantics.
6. Keep behavior parity first, then simplify internals.
7. If uncertain between two patterns, choose the simplest existing pattern already used in production code.

## 6) Phase 1 Plan (Everything Except Cross-Layer Decoupling)

## 6.1 Locked execution order

Execute in this order:

1. P1-W0 Baseline and safety net
2. P1-W1 Dead code deletion
3. P1-W2 Constant deduplication (cron intervals)
4. P1-W3 Admin auth boilerplate consolidation
5. P1-W4 Methodology changelog convergence
6. P1-W5 URL search-param state standardization
7. P1-W6 Table scaffolding standardization
8. P1-W7 Worker entrypoint decomposition
9. P1-W8 Endpoint registry/routing unification
10. P1-W9 Documentation reconciliation and closeout

## 6.2 Workstream matrix

| ID | Goal | Primary files/modules | Impact | Effort |
| --- | --- | --- | --- | --- |
| P1-W0 | Freeze baseline + guard tests | `worker/src/api/__tests__/router-contract.test.ts`, baseline commands | High | Low |
| P1-W1 | Remove confirmed unused components | `src/components/*` unused set | High | Low |
| P1-W2 | Single source for query freshness intervals | `src/hooks/use-api-query.ts`, `src/lib/data-health-config.ts` | Medium | Low |
| P1-W3 | Remove repeated `requireAdmin` guard boilerplate | `worker/src/api/*`, `worker/src/index.ts` | Medium | Low |
| P1-W4 | Use shared changelog renderer for scoring changelog | `src/app/methodology/scoring-changelog/page.tsx`, shared methodology components | Medium | Medium |
| P1-W5 | One URL filter/state pattern | `src/hooks/use-url-filters.ts`, homepage/blacklist/compare/portfolio clients | High | Medium |
| P1-W6 | Normalize table sorting/pagination scaffolding | `src/components/*table*.tsx`, `src/hooks/use-sorted-table-rows.ts` | Medium-High | Medium |
| P1-W7 | Split worker index responsibilities | `worker/src/index.ts` + new HTTP/scheduled handler modules | Medium-High | Medium-High |
| P1-W8 | One endpoint contract source for dispatch + method checks | `src/lib/api-endpoints.ts`, `worker/src/router.ts`, `worker/src/index.ts` | High | High |
| P1-W9 | Update docs to match final state | `docs/architecture.md`, `docs/api-reference.md`, related docs | High | Low |

## 6.3) Behavior Invariants (Must Not Change)

1. Endpoint response shapes and status codes for public and admin APIs.
2. Admin key requirements and idempotent admin behavior.
3. URL filter/share-link semantics for:
   1. compare (`coins`, `range`, legacy symbol fallback)
   2. blacklist (`stablecoin`, `chain`, `event`, `page`, `q`)
   3. portfolio (`p` encoding)
4. Cron sequencing semantics in worker scheduled handler.
5. Cache bypass behavior tied to endpoint metadata.

## 6.4) Detailed execution checklist

### P1-W0 - Baseline and safety net

1. Capture baseline metrics:
   1. `find src worker/src -type f \\( -name '*.ts' -o -name '*.tsx' \\) -print0 | xargs -0 wc -l | tail -n 1`
   2. `find src/components worker/src/api worker/src/cron worker/src/lib -type f \\( -name '*.ts' -o -name '*.tsx' \\) -print0 | xargs -0 wc -l | sort -nr | head -n 20`
2. Run contract-sensitive test targets:
   1. `npm run test -- worker/src/api/__tests__/router-contract.test.ts`
3. Save command outputs in PR notes (not in code).
4. Done when:
   1. baseline commands and outputs are attached to PR
   2. no baseline failures remain

### P1-W1 - Dead code deletion

1. Revalidate unused candidates immediately before deletion using:
   1. run this exact loop:
   ```bash
   files=(
     blacklist-summary bluechip-box bluechip-rating-card cemetery-summary cemetery-timeline
     chain-overview contract-addresses digest-archive-summary liquidity-box liquidity-summary
     market-pulse peg-type-chart report-cards-summary stability-index-summary
   )
   for f in "${files[@]}"; do
     echo "== $f =="
     rg -n "@/components/${f}|components/${f}" src worker/src || true
   done
   ```
2. Target current confirmed list:
   1. `src/components/blacklist-summary.tsx`
   2. `src/components/bluechip-box.tsx`
   3. `src/components/bluechip-rating-card.tsx`
   4. `src/components/cemetery-summary.tsx`
   5. `src/components/cemetery-timeline.tsx`
   6. `src/components/chain-overview.tsx`
   7. `src/components/contract-addresses.tsx`
   8. `src/components/digest-archive-summary.tsx`
   9. `src/components/liquidity-box.tsx`
   10. `src/components/liquidity-summary.tsx`
   11. `src/components/market-pulse.tsx`
   12. `src/components/peg-type-chart.tsx`
   13. `src/components/report-cards-summary.tsx`
   14. `src/components/stability-index-summary.tsx`
3. Verify:
   1. `npm run lint`
   2. `npm run build`
4. Done when:
   1. all target files deleted
   2. no import references remain
   3. build/lint are green

### P1-W2 - Constant deduplication

1. Create one shared interval constants module in `src/lib/`.
2. Replace duplicates in:
   1. `src/hooks/use-api-query.ts`
   2. `src/lib/data-health-config.ts`
3. Verify no duplicated literal declarations remain for the same cron intervals.
4. Verify:
   1. `npm run test -- src/hooks/__tests__/query-polling-policy.test.ts`
   2. `npm run lint`
   3. `npm run build`
5. Done when:
   1. interval constants are defined once
   2. both modules consume shared constant source

### P1-W3 - Admin auth boilerplate consolidation

1. Add a small worker helper wrapper for admin endpoint gating.
2. Migrate repeated patterns in:
   1. `worker/src/api/backfill-cg-prices.ts`
   2. `worker/src/api/backfill-depegs.ts`
   3. `worker/src/api/backfill-supply-history.ts`
   4. `worker/src/api/backfill-stability-index.ts`
   5. `worker/src/api/audit-depeg-history.ts`
   6. `worker/src/api/backfill-dews.ts`
   7. `worker/src/api/status.ts`
   8. `worker/src/api/status-history.ts`
3. Verify:
   1. `npm run test -- worker/src/api/__tests__/router-contract.test.ts`
   2. `cd worker && npx tsc --noEmit`
   3. `npm run lint`
4. Done when:
   1. repeated auth-guard boilerplate is replaced in listed handlers
   2. contract test remains green

### P1-W4 - Methodology changelog convergence

1. Migrate scoring changelog page to shared machinery:
   1. `src/app/methodology/scoring-changelog/page.tsx`
   2. `src/components/methodology-changelog-page.tsx`
   3. `src/app/methodology/changelog-page-utils.ts`
2. Preserve:
   1. route path (`/methodology/scoring-changelog/`)
   2. canonical metadata
   3. anchor stability for existing deep links
3. Verify:
   1. `npm run build`
   2. `npm run lint`
4. Done when:
   1. scoring changelog uses shared renderer pattern
   2. route, metadata, and deep-link anchors are preserved

### P1-W5 - URL state standardization

1. Standardize on one URL-search-param pattern with shared hooks/utils.
2. Migrate custom URL sync logic in:
   1. `src/hooks/use-homepage-filters.ts`
   2. `src/app/blacklist/page.tsx`
   3. `src/app/compare/client.tsx`
   4. `src/app/portfolio/client.tsx` (portfolio `p=` semantics must remain stable)
3. Preserve compatibility behaviors:
   1. Compare accepts both ID and legacy symbol URL values.
   2. Blacklist filter defaults and page reset behavior.
   3. Portfolio share URL encoding format.
4. Add/extend tests if behavior coverage is missing.
5. Verify:
   1. `npm run build`
   2. `npm run lint`
   3. `npm test`
6. Done when:
   1. custom URL sync paths are removed from listed files
   2. share-link compatibility checks pass manually for compare/blacklist/portfolio

### P1-W6 - Table scaffolding standardization

1. Keep existing shared primitives:
   1. `src/hooks/use-sorted-table-rows.ts`
   2. `src/hooks/use-table-pagination.ts`
   3. `src/components/sortable-table-head.tsx`
   4. `src/components/table-pagination.tsx`
2. Converge repeated row interaction and ranking/pagination boilerplate across:
   1. `src/components/yield-leaderboard.tsx`
   2. `src/components/liquidity-table.tsx`
   3. `src/components/flow-table.tsx`
   4. `src/components/depeg-tracker-table.tsx`
   5. `src/components/blacklist-table.tsx`
3. Keep `src/components/stablecoin-table.tsx` as a special-case due virtualization.
4. Verify:
   1. `npm run lint`
   2. `npm run build`
   3. `npm test`
5. Done when:
   1. duplicated table-control scaffolding is materially reduced
   2. table behavior remains unchanged (sorting/pagination/row click)

### P1-W7 - Worker entrypoint decomposition

1. Split `worker/src/index.ts` responsibilities into thin composition modules:
   1. HTTP request handling module
   2. Scheduled cron handling module
2. Preserve:
   1. CORS behavior
   2. edge cache behavior
   3. cron order and `ctx.waitUntil` chaining
   4. circuit breaker and lease semantics
3. Verify:
   1. `npm run test -- worker/src/api/__tests__/router-contract.test.ts`
   2. `cd worker && npx tsc --noEmit`
   3. `npm run lint`
4. Done when:
   1. `worker/src/index.ts` acts as thin composition
   2. no behavior differences in fetch/scheduled paths

### P1-W8 - Endpoint contract/routing unification

1. Eliminate split endpoint semantics across:
   1. `src/lib/api-endpoints.ts`
   2. `worker/src/router.ts`
   3. `worker/src/index.ts`
2. Keep one authoritative endpoint contract that drives:
   1. method validation
   2. cache bypass behavior
   3. dispatch behavior (including router-handled exceptions)
3. Preserve special cases:
   1. `/api/stablecoin/:id` validation behavior
   2. `/api/audit-depeg-history?dry-run=true` method semantics
4. Verify:
   1. `npm run test -- worker/src/api/__tests__/router-contract.test.ts`
   2. `npm run build`
   3. `npm run lint`
   4. `cd worker && npx tsc --noEmit`
5. Done when:
   1. endpoint dispatch + method gating derive from one authoritative definition path
   2. router contract tests pass unchanged

### P1-W9 - Docs reconciliation and closeout

1. Update docs to reflect final Phase 1 state:
   1. `docs/architecture.md`
   2. `docs/api-reference.md`
   3. Any methodology-specific docs touched by UI/route refactors
2. Ensure removed files are no longer listed in architecture inventory.
3. Final Phase 1 verification gates:
   1. `npm run lint`
   2. `npm test`
   3. `npm run build`
   4. `cd worker && npx tsc --noEmit`
4. Done when:
   1. docs and code inventory match
   2. Phase 1 exit criteria (section 3.2) are all satisfied

## 6.5) Phase 1 PR slicing (recommended)

1. PR-01: P1-W0 + P1-W1
2. PR-02: P1-W2 + P1-W3
3. PR-03: P1-W4
4. PR-04: P1-W5
5. PR-05: P1-W6
6. PR-06: P1-W7
7. PR-07: P1-W8
8. PR-08: P1-W9

Rule: do not start the next PR until current PR gates are green locally.

## 6.6) Required Manual Parity Smoke Checks for Phase 1

Run after each Phase 1 PR that touches relevant area:

1. Default API base setup:
   1. `export API_BASE="http://localhost:8787"` when validating with local worker
   2. `export API_BASE="https://api.pharos.watch"` when validating against deployed API
2. Example request templates:
   1. `curl -i "$API_BASE/api/stablecoins" | head -n 20`
   2. `curl -i "$API_BASE/api/stablecoin/1" | head -n 20`
   3. `curl -i "$API_BASE/api/health" | head -n 20`

3. Endpoint parity:
   1. `GET /api/stablecoins`
   2. `GET /api/stablecoin/1`
   3. `GET /api/health`
4. Admin/method parity:
   1. `GET /api/backfill-depegs` must remain method-restricted
   2. `POST /api/backfill-depegs` with/without admin key behavior unchanged
5. URL/share-link parity:
   1. compare page: `coins` + `range` round-trip through reload
   2. blacklist page: filters + `page` + `q` round-trip through reload/back
   3. portfolio page: `p=` links rehydrate holdings correctly
6. Cron path parity:
   1. scheduled handler still maps each cron expression to same jobs in same dependency order

## 7) Phase 2 Plan (Long-Term Worker/Frontend Decoupling)

Phase 2 starts only after Phase 1 is merged and stable.

## 7.1 Goal

Stop direct worker imports from `src/lib/*` by moving cross-runtime logic into an explicit shared domain boundary.

## 7.2 Locked execution order

1. P2-W1 Define and document shared boundary contract
2. P2-W2 Create shared module/package and migrate low-risk modules
3. P2-W3 Migrate medium/high-risk shared modules in waves
4. P2-W4 Enforce import-boundary rules in lint/CI
5. P2-W5 Remove compatibility shims and finalize docs

## 7.3 Phase 2 workstream details

### P2-W1 - Boundary contract

1. Define allowed layers:
   1. `frontend-only`
   2. `worker-only`
   3. `shared-runtime-safe`
2. Document import direction rules in `docs/architecture.md`.
3. Create migration inventory of current `worker/src -> src/lib/*` imports.
4. Use this inventory command:
   1. `rg -n "src/lib/" worker/src`
5. Save inventory snapshot in PR notes for change tracking.

### P2-W2 - Shared module/package bootstrap

1. Default approach: add top-level `shared/` directory (avoid package-manager workspace churn unless necessary).
2. Default shared structure:
   1. `shared/lib/` for pure helpers/constants
   2. `shared/types/` for shared TypeScript models
   3. `shared/index.ts` for controlled exports
3. Start with low-risk modules:
   1. endpoint definitions
   2. pure constants/version labels
   3. pure type-only modules
4. Add path aliases for shared modules in both root and worker TypeScript configs.
   1. default alias: `@shared/*`
5. Add temporary re-export shims only where needed for staged migration.

### P2-W3 - Progressive migration waves

1. Wave A (lowest risk):
   1. `src/lib/api-endpoints.ts`
   2. `src/lib/strict-contract-paths.ts`
   3. pure methodology version files (`*-version.ts`) used by both runtimes
2. Wave B (medium risk):
   1. `src/lib/types.ts` (or sliced shared type modules)
   2. `src/lib/supply.ts`
   3. `src/lib/peg-rates.ts`
3. Wave C (higher risk):
   1. `src/lib/stablecoins.ts`
   2. `src/lib/chains.ts`
   3. other broad domain modules imported by both worker and frontend
4. At each wave:
   1. migrate imports worker first
   2. migrate frontend second
   3. remove obsolete import paths
5. Keep each wave mergeable independently with green gates.
6. After each wave, run import inventory command and record remaining matches count.

### P2-W4 - CI boundary enforcement

1. Add lint/import rules that disallow `worker/src` importing `src/lib/*`.
2. Add CI checks that fail on forbidden import patterns.
3. Ensure all tests and builds run with boundary rules enabled.
4. Add explicit verification command:
   1. `rg -n "src/lib/" worker/src` must return zero matches (excluding tests if intentionally allowed).
5. Add a stricter non-test check:
   1. `rg -n "src/lib/" worker/src --glob '!**/__tests__/**'`

### P2-W5 - Cleanup and closure

1. Delete transitional shims.
2. Update docs:
   1. `docs/architecture.md`
   2. `docs/api-reference.md` (if endpoint contract module paths changed)
   3. `docs/worker-infrastructure.md`
3. Confirm zero forbidden cross-layer imports remain.
4. Done when Phase 2 exit criteria (section 3.2) are all satisfied.

## 7.4 Phase 2 completion criteria

All must be true:

1. `worker/src` has zero direct imports from `src/lib/*`.
2. Shared package contains all cross-runtime pure modules.
3. Boundary lint/CI checks are active and green.
4. Full verification gates are green.

## 8) Autonomous Execution Protocol

Use this protocol to execute without additional user guidance:

1. Always choose the smallest behavior-preserving refactor first.
2. Prefer incremental PRs over large combined rewrites.
3. If a workstream reveals missing tests for a changed behavior, add minimal targeted tests in the same PR.
4. If blocked by ambiguity, resolve using existing production behavior in current code and docs.
5. Only stop and ask for input when:
   1. a required behavior is contradictory across docs and runtime code
   2. a destructive migration decision has no reversible path
6. Keep a running implementation log in PR descriptions:
   1. scope
   2. behavior parity notes
   3. command outputs
   4. risks
7. For autonomous defaults, follow section 11.

## 9) Stop Conditions and Re-Plan Triggers

Stop current workstream and re-plan if any occurs:

1. Baseline gates are red for unrelated reasons.
2. Endpoint contract parity cannot be preserved in current PR scope.
3. URL/state migration changes share-link compatibility.
4. Cron sequencing or provider interaction semantics change unexpectedly.
5. Phase 2 alias/config changes cause incompatible TypeScript resolution across root and worker.

When triggered:

1. Revert only the partial workstream changes.
2. Open a narrowed sub-plan in `docs/plans/` with explicit fallback.
3. Resume from the last green checkpoint.

## 10) Final Verification Gate (Phase 1 and Phase 2)

Run before merge of each phase:

1. `npm run lint`
2. `npm test`
3. `npm run build`
4. `cd worker && npx tsc --noEmit`

Phase 1 should complete before any Phase 2 work is merged.

## 10.1) Evidence Artifacts to Keep

For each PR, keep in PR description:

1. pre/post LOC snapshot for changed modules
2. test command outputs
3. import inventory deltas (especially for Phase 2)
4. manual parity smoke checklist results (section 6.6 where applicable)

## 11) Autonomous Defaults (Decision Matrix)

Use these defaults when the plan does not specify exact implementation details:

| Situation | Default decision |
| --- | --- |
| Two possible refactor shapes both preserve behavior | Choose the one with fewer new files and lower LOC |
| Utility placement uncertainty | Place runtime-neutral utilities in `src/lib/` during Phase 1; in `shared/` during Phase 2 |
| Table convergence ambiguity | Reuse `use-sorted-table-rows` + `use-table-pagination` patterns; do not introduce a generic mega-table |
| URL sync ambiguity | Use existing `use-url-filters` semantics and preserve current query keys |
| Router unification ambiguity | Preserve `src/lib/api-endpoints.ts` as authoritative metadata source, then align worker dispatch to it |
| Tests are missing for changed behavior | Add focused tests in same PR before merge |
| Docs mismatch after code changes | Update docs in same PR; do not defer |

## 12) PR Evidence Template (Copy Into Every PR Description)

1. **Scope**
   1. Workstream IDs covered
   2. Files changed
2. **Behavior parity checks**
   1. endpoints/URLs/cron semantics touched
   2. parity confirmation notes
3. **Validation output**
   1. `npm run lint`
   2. `npm test`
   3. `npm run build`
   4. `cd worker && npx tsc --noEmit`
4. **Risk and rollback**
   1. known risks
   2. rollback command/approach
