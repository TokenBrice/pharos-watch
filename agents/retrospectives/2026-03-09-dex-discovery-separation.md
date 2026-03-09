# DEX Discovery Separation — Retrospective

**Date:** 2026-03-09
**Plan:** `agents/plans/2026-03-09-dex-discovery-separation/implementation-plan.md`
**Design:** `agents/plans/2026-03-09-dex-discovery-separation-design.md`

## Summary

Split the monolithic DEX liquidity cron into two independent cron jobs:
- **Discovery cron** (20-min slot): crawls CG/GT/DexScreener/CG Tickers with tiered priority, writes to `dex_pool_staging`
- **Scoring cron** (30-min slot): reads staging, merges with primary sources, applies confidence decay, scores

New D1 tables: `dex_pool_staging`, `dex_discovery_meta`, `kv_config`. Methodology bumped to v3.3.

## Execution

| Phase | Worktree | Tickets | Fix tickets | Model |
|-------|----------|---------|-------------|-------|
| 1A | dex-discovery-module | 4 | 1 (persistence fix) | gpt-5.3-codex |
| 1B | dex-scoring-refactor | 2 | 1 (dead code removal) | gpt-5.3-codex |
| 2 | dex-discovery-integration | 3 | 0 (doc fixes done inline) | gpt-5.3-codex |

**Total:** 9 original tickets + 2 fix tickets = 11 cmcs runs across 3 worktrees.

### Merge commits
- Phase 1A (discovery-module): `340e799a`
- Phase 1B (scoring-refactor): `90e9dd8e`
- Phase 2 (integration): `fd22054f`

### Test delta
- Before: 1313 tests
- After: 1355 tests (+42 new tests across 5 test files)

## What Went Well

1. **Parallel worktrees** — Phase 1A and 1B ran fully in parallel with zero file overlap, cutting wall-clock time roughly in half.
2. **Two-stage review** caught real issues:
   - Spec review caught nothing extra (tickets were well-scoped)
   - Code quality review caught `INSERT OR REPLACE` resetting `discovered_at` timestamps → fixed with `ON CONFLICT DO UPDATE`
   - Code quality review caught vestigial `initOnchainAvailability` + `cgApiKey` parameter → cleaned up
3. **D1 migration** executed cleanly on remote, all 3 tables verified immediately.
4. **Discovery cron fired within 20 minutes** of deploy — 37 staged pools and 15 discovery meta entries populated on first run.
5. **Confidence decay integration** working — scoring cron merges staged pools with appropriate confidence weighting.

## What Could Be Improved

1. **Rebase conflict on `types.ts`** — Both worktrees created `worker/src/cron/dex-discovery/types.ts`. The design doc listed this as a shared file but the plan assigned it to both worktrees. In practice the conflict was trivial (both versions had the same exports), but the merge order dependency should have been explicit in the plan.
2. **cmcs DB state fragility** — After a cmcs DB reset (`rm .cmcs/cmcs.db*`), worktrees weren't re-registered. Had to manually insert rows into sqlite. The cmcs tooling could handle orphaned worktrees more gracefully.
3. **Fish shell incompatibility** — Brace expansion `{a,b,c}` doesn't work in fish. Minor, but caused a few wasted commands during verification.
4. **Duplicate documentation** — Phase 1 and Phase 2 both added discovery documentation to `docs/dex-liquidity.md`, resulting in overlapping sections. Caught and consolidated during Phase 2 review.
5. **Status endpoint requires auth** — Smoke test commands in the execution handover included `curl /api/status` which requires `ADMIN_KEY` auth. Should either document the auth requirement or use a non-auth endpoint for smoke tests.

## Lessons Learned

- **`INSERT OR REPLACE` is dangerous for tables with `discovered_at` semantics** — always use `ON CONFLICT DO UPDATE` with explicit column list when you need to preserve creation timestamps.
- **Plan file ownership explicitly** when two worktrees might create the same file. Either assign the file to one worktree and have the other import, or document the expected merge conflict resolution.
- **Smoke test commands should be self-contained** — include auth tokens or use public endpoints.

## Production Verification

- `dex_pool_staging`: 37 rows (discovery cron populated)
- `dex_discovery_meta`: 15 rows (tier tracking active)
- `/api/dex-liquidity`: 138 coins with liquidity scores
- Methodology version: v3.3
