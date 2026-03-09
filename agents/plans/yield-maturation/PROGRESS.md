# Yield Maturation — Progress Tracker

**Last updated:** 2026-03-09

## Current State

**Active phase:** COMPLETE
**Status:** All phases merged, deployed, D1 migration applied, smoke tests passed

## Phase Checklist

### Phase 0: Research (Manual)
- [x] DL pool audit completed — 40 yield-bearing coins audited, 8 new pool mappings + 6 price-derived fallbacks identified
- [x] Candidate lending protocols evaluated — 10 new protocols approved (compound-v2, dolomite, curve-llamalend, exactly, flux-finance, gains-network, lazy-summer-protocol, moonwell-lending, silo-v2, benqi-lending)
- [x] Research output documented (`phase0-research-output.md`) and ticket amendments prepared (TICKET-001 + TICKET-002 amended)

### Phase 1A: Worker Backend (`yield-maturation-backend`)
- [x] Worktree created
- [x] Tickets copied
- [x] cmcs run started
- [x] cmcs run completed (7/7 tickets, 0 failures)
- [x] Review checklist passed (build, tsc, tests green; all spot checks pass; Zod schema verified)
- [x] Merged to main (commit e909e596)
- Pre-migration D1 bookmark: `0000153a-000003b6-00005029-be1e50191184c29b27d8d109f878f645`
- [x] Post-deploy smoke test passed — medianApy: 3.58, 75 rankings, warningSignals live
- [x] Worktree cleaned up

### Phase 1B: Coverage Config (`yield-maturation-coverage`)
- [x] Worktree created
- [x] Tickets copied (amended with research output)
- [x] cmcs run started
- [x] cmcs run completed (2/2 tickets, 0 failures)
- [x] Review checklist passed (build, tsc, tests all green; all entries verified)
- [x] Merged to main (commit a08611c7)
- [x] Post-deploy smoke test passed
- [x] Worktree cleaned up

### Phase 2: Frontend Foundation (`yield-maturation-frontend-foundation`)
- [x] Worktree created
- [x] Tickets copied
- [x] cmcs run started
- [x] cmcs run completed (3/3 tickets, 0 failures)
- [x] Review checklist passed (build, 1315 tests green; all spot checks pass)
- [x] Merged to main (commit 103bc2e4)
- [x] Post-deploy smoke test passed
- [x] Worktree cleaned up

### Phase 3D: Leaderboard Enhancements (`yield-maturation-leaderboard`)
- [x] Worktree created
- [x] Tickets copied
- [x] cmcs run started
- [x] cmcs run completed (5/5 tickets, 0 failures) — 3 in first run, 2 after cmcs DB fix
- [x] Review checklist passed (build, tests green; all spot checks pass)
- [x] Merged to main (commit 47739904)
- [x] Post-deploy smoke test passed
- [x] Worktree cleaned up

### Phase 3E: Detail Page Yield Section (`yield-maturation-detail-page`)
- [x] Worktree created
- [x] Tickets copied
- [x] cmcs run started
- [x] cmcs run completed (2/2 tickets, 0 failures)
- [x] Review checklist passed (build, 1330 tests green; all spot checks pass)
- [x] Merged to main (commit fd2b21bd)
- [x] Post-deploy smoke test passed
- [x] Worktree cleaned up

**Post-merge cleanup:** WARNING_SIGNAL_LABELS deduplicated to `src/lib/yield-constants.ts` (commit 6df3ce8f)

### Phase 4: Polish (`yield-maturation-polish`)
- [x] Worktree created
- [x] Tickets copied
- [x] cmcs run started
- [x] cmcs run completed (1/1 tickets, 0 failures)
- [x] Review checklist passed (build, 1347 tests green; no experimental markers; all docs updated)
- [x] Merged to main (commit 7b139fbf)
- [x] Post-deploy smoke test passed
- [x] Worktree cleaned up

## Incident Log

1. **cmcs DB FK constraint failure** — After cmcs DB was reinitialized mid-execution, the `worktrees` table was empty. `cmcs run` from worktree CWD uses the worktree's own `.cmcs/cmcs.db` (which has no worktree registrations), not the main repo's DB. Fixed by always running `cmcs run <absolute-path>` from the main repo root. Phase 3D TICKET-004 + 005 relaunched after fix.

## Final Stats

- **Total tickets:** 20 (7 + 2 + 3 + 5 + 2 + 1)
- **First-pass success:** 20/20 (0 failures)
- **Test count:** 1313 → 1347 (+34 tests added by agents)
- **Files changed:** ~20 files across worker, shared types, frontend components, hooks, docs
- **Post-merge cleanups:** 1 (WARNING_SIGNAL_LABELS dedup)
