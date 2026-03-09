# Yield Feature Maturation — Implementation Plan

**Design doc:** `2026-03-09-yield-maturation-design.md`

---

## Execution Strategy

- **6 phases** (0 through 4, with Phase 3 split into 3D + 3E)
- **6 worktrees** + 1 manual research phase
- **20 tickets** total (7 + 2 + 3 + 5 + 2 + 1)
- Phases 1A/1B run in parallel; Phases 3D/3E run in parallel
- Each phase is independently deployable

---

## File Ownership Per Worktree

Parallel worktrees within a phase must have **strictly non-overlapping** file lists.

### Phase 1 (parallel: 1A + 1B)

| File | 1A (backend) | 1B (coverage) |
|------|:---:|:---:|
| `worker/src/cron/sync-yield-data.ts` | X | |
| `worker/src/cron/yield-helpers.ts` | X | |
| `worker/src/cron/yield-config.ts` | | X |
| `worker/src/api/yield-history.ts` | X | |
| `worker/src/cron/__tests__/yield-helpers.test.ts` | X | |
| New migration file | X | |

No overlap. Safe to parallel.

### Phase 3 (parallel: 3D + 3E)

| File | 3D (leaderboard) | 3E (detail page) |
|------|:---:|:---:|
| `src/components/yield-leaderboard.tsx` | X | |
| `src/app/yield/client.tsx` | X | |
| `src/components/yield-detail-section.tsx` (new) | | X |
| `src/app/stablecoin/[id]/client.tsx` | | X |

Shared dependency (read-only, not modified by either):
- `src/components/yield-history-chart.tsx` (created in Phase 2)
- `src/hooks/use-yield-history.ts` (created in Phase 2)

The `WARNING_SIGNAL_LABELS` map may be duplicated or extracted to a shared location. TICKET-001 of Phase 3E handles this: if duplication exists from Phase 3D, extract to `src/lib/yield-constants.ts` and import in both.

No write overlap. Safe to parallel.

---

## Phase Breakdown

### Phase 0: Research (Manual)

**Worktree:** None (manual browser/API work)
**Prerequisite for:** Phase 1B tickets (provides exact pool UUIDs and protocol slugs)

| Step | Action |
|------|--------|
| 0a | Fetch `https://yields.llama.fi/pools`, cross-reference all `yieldBearing: true` coins |
| 0b | Evaluate candidate lending protocols against quality gates |
| Output | Amend Phase 1B tickets with exact entries |

---

### Phase 1A: Worker Backend

**Worktree:** `yield-maturation-backend`
**Parallel with:** Phase 1B
**Tickets:** 7 (sequential)

| # | Title | Model | Key Files |
|---|-------|-------|-----------|
| 001 | Schema migration: warning_signals in yield_history | spark | New migration file |
| 002 | Add data-stale warning signal detection | codex | `yield-helpers.ts`, `sync-yield-data.ts` |
| 003 | Cross-source validation logging | codex | `sync-yield-data.ts` |
| 004 | Graceful per-coin fallback on missing DL pool | codex | `yield-helpers.ts`, tests |
| 005 | Write warning_signals to yield_history + compute median APY | codex | `sync-yield-data.ts` |
| 006 | Update yield-history API to return warning_signals | spark | `yield-history.ts` |
| 007 | Backend tests for new reliability features | codex | tests |

**Gate criteria:**
```bash
cd worker && npx tsc --noEmit
npm test
npm run build
```

---

### Phase 1B: Coverage Config

**Worktree:** `yield-maturation-coverage`
**Parallel with:** Phase 1A
**Prerequisite:** Phase 0 research completed
**Tickets:** 2 (sequential)

| # | Title | Model | Key Files |
|---|-------|-------|-----------|
| 001 | Fix DeFiLlama pool map mismatches | spark | `yield-config.ts` |
| 002 | Expand lending protocol allowlist | spark | `yield-config.ts` |

**Gate criteria:**
```bash
cd worker && npx tsc --noEmit
npm test
npm run build
```

---

### Phase 2: Frontend Foundation

**Worktree:** `yield-maturation-frontend-foundation`
**Depends on:** Phase 1A merged (types + API changes must be in main)
**Tickets:** 3 (sequential)

| # | Title | Model | Key Files |
|---|-------|-------|-----------|
| 001 | Update shared types (medianApy, YieldHistoryPoint) | spark | `shared/types/index.ts` |
| 002 | Create useYieldHistory hook | codex | `src/hooks/use-yield-history.ts` (new) |
| 003 | Build YieldHistoryChart component | gpt-5.4 | `src/components/yield-history-chart.tsx` (new) |

**Gate criteria:**
```bash
npm run build
npm test
```

---

### Phase 3D: Leaderboard Enhancements

**Worktree:** `yield-maturation-leaderboard`
**Depends on:** Phase 2 merged
**Parallel with:** Phase 3E
**Tickets:** 5 (sequential)

| # | Title | Model | Key Files |
|---|-------|-------|-----------|
| 001 | Add Native Yield / Lending Opportunities tabs | codex | `yield-leaderboard.tsx` |
| 002 | Add warning signals column | codex | `yield-leaderboard.tsx` |
| 003 | Add yield type and warning filters | codex | `yield-leaderboard.tsx` |
| 004 | Add PYS score breakdown tooltip | codex | `yield-leaderboard.tsx` |
| 005 | Add expandable row with YieldHistoryChart | gpt-5.4 | `yield-leaderboard.tsx`, `client.tsx` |

**Gate criteria:**
```bash
npm run build
npm test
```

---

### Phase 3E: Detail Page Yield Section

**Worktree:** `yield-maturation-detail-page`
**Depends on:** Phase 2 merged
**Parallel with:** Phase 3D
**Tickets:** 2 (sequential)

| # | Title | Model | Key Files |
|---|-------|-------|-----------|
| 001 | Create YieldDetailSection component | gpt-5.4 | `src/components/yield-detail-section.tsx` (new) |
| 002 | Integrate yield section into detail page | codex | `src/app/stablecoin/[id]/client.tsx` |

**Gate criteria:**
```bash
npm run build
npm test
```

---

### Phase 4: Polish

**Worktree:** `yield-maturation-polish`
**Depends on:** Phases 3D + 3E both merged
**Tickets:** 1

| # | Title | Model | Key Files |
|---|-------|-------|-----------|
| 001 | Remove experimental badge + update docs | codex | `page.tsx`, `client.tsx`, `docs/yield-intelligence.md` |

**Gate criteria:**
```bash
npm run build
npm test
grep -r "experimental" src/app/yield/ # expect 0 results
```

---

## Manual Steps

| Step | When | Action |
|------|------|--------|
| D1 migration | After Phase 1A merge, before deploy | `cd worker && npx wrangler d1 migrations apply stablecoin-db --remote` |

This is a single `ALTER TABLE ADD COLUMN` (nullable). Instant, no data migration. Rollback via D1 Time Travel if needed.

No other manual steps required. No secrets, no DNS changes.

---

## Worktree Dispatch Summary

### Phase 1 (parallel)

```bash
# Create worktrees
cmcs worktree create yield-maturation-backend
cmcs worktree create yield-maturation-coverage

# Copy tickets
cp agents/plans/yield-maturation/tickets/phase1a-backend/*.md worktrees/yield-maturation-backend/.cmcs/tickets/
cp agents/plans/yield-maturation/tickets/phase1b-coverage/*.md worktrees/yield-maturation-coverage/.cmcs/tickets/

# Launch parallel
cmcs run worktrees/yield-maturation-backend 2>&1 &
cmcs run worktrees/yield-maturation-coverage 2>&1 &
wait
```

### Phase 2

```bash
cmcs worktree create yield-maturation-frontend-foundation
cp agents/plans/yield-maturation/tickets/phase2-frontend-foundation/*.md worktrees/yield-maturation-frontend-foundation/.cmcs/tickets/
cmcs run worktrees/yield-maturation-frontend-foundation
```

### Phase 3 (parallel)

```bash
cmcs worktree create yield-maturation-leaderboard
cmcs worktree create yield-maturation-detail-page
cp agents/plans/yield-maturation/tickets/phase3d-leaderboard/*.md worktrees/yield-maturation-leaderboard/.cmcs/tickets/
cp agents/plans/yield-maturation/tickets/phase3e-detail-page/*.md worktrees/yield-maturation-detail-page/.cmcs/tickets/

cmcs run worktrees/yield-maturation-leaderboard 2>&1 &
cmcs run worktrees/yield-maturation-detail-page 2>&1 &
wait
```

### Phase 4

```bash
cmcs worktree create yield-maturation-polish
cp agents/plans/yield-maturation/tickets/phase4-polish/*.md worktrees/yield-maturation-polish/.cmcs/tickets/
cmcs run worktrees/yield-maturation-polish
```

---

## Supporting Artifacts

| Artifact | Location | Status |
|----------|----------|--------|
| Design document | `agents/plans/yield-maturation/2026-03-09-yield-maturation-design.md` | Complete |
| Implementation plan | `agents/plans/yield-maturation/implementation-plan.md` | This file |
| Execution handover | `agents/plans/yield-maturation/execution-handover.md` | Complete |
| Progress tracker | `agents/plans/yield-maturation/PROGRESS.md` | Initialized |
| Phase 0 research output | TBD (produced during manual research) | Not started |
