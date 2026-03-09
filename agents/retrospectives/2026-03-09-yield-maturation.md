# Retrospective: Yield Maturation (2026-03-09)

## Stats
- Tickets: 20 total, 20 first-pass success, 0 needed rework
- Models: codex-spark for 14 tickets (phases 1A, 1B, 3D, 3E, 4), codex for 6 tickets (phase 2, selected phase 3D tickets)
- Phases: 6 (0-research, 1A-backend, 1B-coverage, 2-frontend-foundation, 3D-leaderboard, 3E-detail-page, 4-polish)
- Tests: 1313 -> 1347 (+34 added by agents)
- Files changed: ~20 across worker, shared types, frontend components, hooks, docs

## What worked
- **Phase 0 research in parallel with Phase 1A** — ran DL pool audit while backend tickets executed, avoiding serial bottleneck. Research output directly amended Phase 1B tickets with exact UUIDs and slugs.
- **Coherence loop before dispatch** — 4-pass ticket review caught 5 issues (Zod schema stripping, `setPage(0)` non-existence, `ranking.updatedAt` non-existence, Tooltip parallel dependency, YIELD_TYPE_STYLES `.bg` vs `.badge`). Zero agent failures as a result.
- **codex-spark handled all mechanical tickets** — config additions (pool maps, lending protocols), badge text changes, doc updates. Perfect for well-specified, low-ambiguity work.
- **Parallel worktrees for independent phases** — 1A+1B parallel, 3D+3E parallel. Significant wall-clock time savings.
- **D1 Time Travel bookmark before migration** — safety net was in place before applying the `warning_signals` column migration.
- **Post-merge cleanup was minimal** — only one dedup needed (`WARNING_SIGNAL_LABELS`), expected from parallel 3D/3E execution.

## What didn't
- **cmcs DB FK constraint failure** — After DB reinitialization, `cmcs run` from worktree CWD used the worktree's own `.cmcs/cmcs.db` (empty `worktrees` table), causing FK violations. Required deleting and recreating the worktree + running from main repo root. Lost ~30 min diagnosing.
- **Phase 3D partial recovery** — Had to cherry-pick from reflog-reachable commit after branch deletion. Git worktree cleanup should happen only after confirming all commits are on main.

## Lessons for next time
- **Always run `cmcs run <absolute-path>` from the main repo root** — never `cd` into a worktree and run `cmcs run .`. The worktree's `.cmcs/cmcs.db` has no worktree registrations.
- **Run `npm install` after merging phases that add dependencies** — Phase 3D added `@radix-ui/react-tooltip` to `package.json`; build failed until `npm install` ran in main.
- **Include before/after code context in tickets touching shared types** — Zod schema + interface must stay in sync. Tickets that add fields to API responses should explicitly list both the Zod schema update AND the TypeScript interface update.
- **For hooks that don't expose `setPage()`**, document the alternative (`resetPageOnTotalChange: true`) directly in the ticket rather than expecting the agent to discover it.
- **When phases run in parallel and touch the same constants**, pre-extract the shared constant to a dedicated file in a prior phase. This avoids post-merge dedup cleanup.
- **codex-spark can't handle cross-file type propagation** — any ticket that requires updating types in one file and consumers in another should use codex, not spark.
