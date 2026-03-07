# Codebase Simplification — Implementation Plan

## Execution Strategy

- **3 phases**, **5 worktrees**, **6 tickets**
- Phase 1: 2 parallel worktrees (quick wins — zero-risk mechanical changes)
- Phase 2: 2 parallel worktrees (worker structure consolidation)
- Phase 3: 1 worktree with 2 sequential tickets (methodology version infrastructure)
- All phases are independently deployable — each leaves production in a working state

## Design Document

The design document for this project is the simplification audit at `agents/audits/simplification-audit.md`. It documents the problem, current state, proposed changes, and risk assessment for every finding.

---

## Phase 1: Quick Wins (2 parallel worktrees)

Zero-risk mechanical changes. No logic changes, no behavioral changes.

### Worktree: `simplify-frontend-hooks`

| Ticket | Title | Key Files |
|--------|-------|-----------|
| TICKET-001 | Remove duplicate SortDirection types + redundant pagination return | `src/hooks/use-sorted-table-rows.ts`, `src/hooks/use-sorted-paginated-table.ts`, `src/hooks/use-table-pagination.ts` |

### Worktree: `simplify-worker-errors`

| Ticket | Title | Key Files |
|--------|-------|-----------|
| TICKET-001 | Replace inline error responses with errorResponse() + remove dead code | `worker/src/router.ts`, `worker/src/lib/auth.ts`, `worker/src/handlers/http.ts`, `worker/src/lib/rate-limit.ts`, `worker/src/lib/api-utils.ts` |

### Gate criteria

Before proceeding to Phase 2:

1. Both cmcs runs completed successfully
2. `npm run build` exits 0
3. `cd worker && npx tsc --noEmit` exits 0
4. `npm test` exits 0
5. Orchestrator reviewed diffs

---

## Phase 2: Worker Structure (2 parallel worktrees)

Small refactors within the worker. Non-overlapping files.

### Worktree: `simplify-router`

| Ticket | Title | Key Files |
|--------|-------|-----------|
| TICKET-001 | Extract matchDynamicRoute helper to deduplicate dynamic route matching | `worker/src/router.ts` |

### Worktree: `simplify-cache-handlers`

| Ticket | Title | Key Files |
|--------|-------|-----------|
| TICKET-001 | Consolidate 5 trivial cache-passthrough handler files into one | `worker/src/api/stablecoins.ts`, `worker/src/api/stablecoin-charts.ts`, `worker/src/api/bluechip.ts`, `worker/src/api/usds-status.ts`, `worker/src/api/yield-rankings.ts`, `worker/src/api/cache-handlers.ts` (new), `worker/src/router.ts` |

**File ownership note:** Both worktrees touch `worker/src/router.ts`. `simplify-router` modifies the dynamic route matching block (lines 281-323). `simplify-cache-handlers` modifies the import block only (lines 1-26). These are non-overlapping regions, but merge order matters: merge `simplify-router` first, then `simplify-cache-handlers`.

### Gate criteria

Before proceeding to Phase 3:

1. Both cmcs runs completed successfully
2. `npm run build` exits 0
3. `cd worker && npx tsc --noEmit` exits 0
4. `npm test` exits 0
5. Orchestrator reviewed diffs
6. Merge `simplify-router` before `simplify-cache-handlers`

---

## Phase 3: Methodology Version Infrastructure (1 worktree)

The highest-impact change. Creates a generic factory and migrates all 6 version files.

### Worktree: `simplify-versions`

| Ticket | Title | Key Files |
|--------|-------|-----------|
| TICKET-001 | Create shared/lib/methodology-version.ts factory with tests | `shared/lib/methodology-version.ts` (new), `src/lib/__tests__/methodology-version.test.ts` (new) |
| TICKET-002 | Migrate all 6 version files to use the factory + update all consumers | `shared/lib/{depeg-dews,stability-index,liquidity-score,blacklist-tracker,yield-methodology,mint-burn-flow}-version.ts`, 15+ worker/frontend/test consumers |

### Gate criteria

1. cmcs run completed successfully (2/2 tickets)
2. `npm run build` exits 0
3. `cd worker && npx tsc --noEmit` exits 0
4. `npm test` exits 0
5. Verify all 6 changelog pages load correctly (manual or grep check)
6. Verify worker API responses still include `methodologyVersion` fields

---

## Worktree Dispatch Summary

### Phase 1

```bash
cmcs worktree create simplify-frontend-hooks
cmcs worktree create simplify-worker-errors

cp agents/plans/codebase-simplification/tickets/phase1-quick-wins/TICKET-001.md worktrees/simplify-frontend-hooks/.cmcs/tickets/
cp agents/plans/codebase-simplification/tickets/phase1-quick-wins/TICKET-002.md worktrees/simplify-worker-errors/.cmcs/tickets/TICKET-001.md

cmcs run worktrees/simplify-frontend-hooks
cmcs run worktrees/simplify-worker-errors
```

### Phase 2

```bash
cmcs worktree create simplify-router
cmcs worktree create simplify-cache-handlers

cp agents/plans/codebase-simplification/tickets/phase2-worker-structure/TICKET-001.md worktrees/simplify-router/.cmcs/tickets/
cp agents/plans/codebase-simplification/tickets/phase2-worker-structure/TICKET-002.md worktrees/simplify-cache-handlers/.cmcs/tickets/TICKET-001.md

cmcs run worktrees/simplify-router
cmcs run worktrees/simplify-cache-handlers
```

### Phase 3

```bash
cmcs worktree create simplify-versions

cp agents/plans/codebase-simplification/tickets/phase3-methodology-versions/TICKET-001.md worktrees/simplify-versions/.cmcs/tickets/
cp agents/plans/codebase-simplification/tickets/phase3-methodology-versions/TICKET-002.md worktrees/simplify-versions/.cmcs/tickets/

cmcs run worktrees/simplify-versions
```

---

## Deferred Findings

The following audit findings are **not covered** by tickets in this project. They remain valid simplification opportunities for future work.

| Finding | Title | Reason for Deferral |
|---------|-------|---------------------|
| M2 | `data-health-config.ts` is single-use (22 lines) | Too small to justify a worktree. Inline into `use-health.ts` as a follow-up. |
| M3 | `blacklist-api.ts` is single-use (50 lines) | Standalone refactor, no dependency on other findings. Better as an opportunistic cleanup. |
| M4 | `buildMethodologyEnvelope` adds no logic | Requires touching all call sites across worker API handlers. Better done when those handlers are already being modified. |
| M6 | `safety-score-version.ts` doesn't follow the version pattern | The scoring changelog page (856 lines of inline data) is a large migration best done separately after Phase 3 proves the factory pattern. |
| M7 | `stablecoin-detail-derive.ts` is single-use (104 lines) | Standalone refactor, no dependency on other findings. Better as an opportunistic cleanup. |
| M5 | `formatHealthAge` duplicates `timeAgo` logic | Documentation-only — both functions serve different UX contexts. No code change needed. |
| L3 | `cron-intervals.ts` is single-use (7 lines) | Too small to justify a worktree. Merge into `use-api-query.ts` as a follow-up. |

---

## Supporting Artifacts

| Artifact | Location | Purpose |
|----------|----------|---------|
| Simplification audit | `agents/audits/simplification-audit.md` | Design document — problem, findings, proposed changes |
| This plan | `agents/plans/codebase-simplification/implementation-plan.md` | How — phases, worktrees, tickets |
| Execution handover | `agents/plans/codebase-simplification/execution-handover.md` | Operational runbook |
| Progress tracker | `agents/plans/codebase-simplification/PROGRESS.md` | Current state |
| Phase 1 tickets | `agents/plans/codebase-simplification/tickets/phase1-quick-wins/TICKET-{001,002}.md` | Quick win instructions |
| Phase 2 tickets | `agents/plans/codebase-simplification/tickets/phase2-worker-structure/TICKET-{001,002}.md` | Worker structure instructions |
| Phase 3 tickets | `agents/plans/codebase-simplification/tickets/phase3-methodology-versions/TICKET-{001,002}.md` | Version infrastructure instructions |
