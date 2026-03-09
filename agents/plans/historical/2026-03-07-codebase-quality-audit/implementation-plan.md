# Codebase Quality Audit — Implementation Plan

## Execution Strategy

- **3 phases**, sequential gates
- **10 worktrees** across phases (4 + 3 + 3)
- **10 tickets** (1 per worktree — each is a focused cleanup job)
- Phase 1 is pure deletions/substitutions (zero behavior risk)
- Phase 2 consolidates worker patterns (well-defined extraction targets)
- Phase 3 consolidates frontend patterns (component deduplication)

**Gate criteria for each phase:** `npm run build && cd worker && npx tsc --noEmit && npm test`

## Phase 1: Dead Code & Safe Cleanup (~500 LOC)

All changes are deletions, de-exports, or trivial substitutions. Zero risk of behavior change.

| Worktree | Ticket | Key Files | Est. LOC |
|---|---|---|---|
| `cleanup-frontend-dead` | TICKET-001 | src/components/, src/lib/, src/hooks/ | -120 |
| `cleanup-worker-dead` | TICKET-002 | worker/src/cron/, worker/src/lib/ | -80 |
| `cleanup-shared-dead` | TICKET-003 | shared/types/, shared/lib/ | -130 |
| `cleanup-stablecoins-defaults` | TICKET-004 | shared/lib/stablecoins.ts | -129 |

**Dispatch:** All 4 in parallel (non-overlapping files).

## Phase 2: Worker Consolidation (~350 LOC)

Extract shared helpers from duplicated cron/API patterns. Well-defined extraction targets identified by research.

| Worktree | Ticket | Key Files | Est. LOC |
|---|---|---|---|
| `consolidate-cron-helpers` | TICKET-005 | worker/src/cron/, worker/src/lib/ | -150 |
| `consolidate-cron-fetch` | TICKET-006 | worker/src/cron/dex-liquidity/, worker/src/cron/enrich-prices.ts | -200 |
| `consolidate-worker-lib` | TICKET-007 | worker/src/lib/, worker/src/api/ | -100 |

**Dispatch:** All 3 in parallel (non-overlapping files per ticket).

## Phase 3: Frontend Consolidation (~400 LOC)

Component deduplication and shared primitive extraction.

| Worktree | Ticket | Key Files | Est. LOC |
|---|---|---|---|
| `consolidate-components-charts` | TICKET-008 | src/components/*chart*.tsx | -220 |
| `consolidate-components-cards` | TICKET-009 | src/components/*card*.tsx, *stats*.tsx, *kpi*.tsx | -180 |
| `consolidate-frontend-lib` | TICKET-010 | src/lib/, src/hooks/ | -100 |

**Dispatch:** All 3 in parallel (non-overlapping files).

## Total Estimated Impact

~1,250 LOC reduction across all phases, without affecting any features.

## Supporting Artifacts

Research reports (in research worktrees):
- `worktrees/research-frontend-components/RESEARCH-REPORT.md`
- `worktrees/research-frontend-lib-hooks/RESEARCH-REPORT.md`
- `worktrees/research-worker-cron/RESEARCH-REPORT.md`
- `worktrees/research-worker-api-lib/RESEARCH-REPORT.md`
- `worktrees/research-shared/RESEARCH-REPORT.md`
