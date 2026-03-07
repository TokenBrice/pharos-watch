# Codebase Simplification — Execution Handover

## What this does

Eliminates ~600 lines of structural duplication, 13 inline error response constructions, and dead code across the stablecoin dashboard codebase. The main change is unifying 6 methodology version files (~950 lines of identical boilerplate) into a single generic factory. Every feature continues working identically — this is a refactor, not a redesign.

## File inventory

```
agents/plans/codebase-simplification/
  implementation-plan.md                              # Phase/worktree/ticket breakdown
  execution-handover.md                               # This file — operational runbook
  PROGRESS.md                                         # Current state tracker
  tickets/
    phase1-quick-wins/
      TICKET-001.md                                   # Frontend hooks: SortDirection + pagination
      TICKET-002.md                                   # Worker errors: errorResponse() + dead code
    phase2-worker-structure/
      TICKET-001.md                                   # Router: matchDynamicRoute helper
      TICKET-002.md                                   # Cache handlers: consolidate 5 files → 1
    phase3-methodology-versions/
      TICKET-001.md                                   # Create methodology-version.ts factory
      TICKET-002.md                                   # Migrate all 6 version files
agents/audits/simplification-audit.md                 # Design document (audit findings)
```

## Pre-flight checks

Before starting execution:

```bash
# 1. cmcs is initialized
cmcs status

# 2. Clean working tree
git status  # should show only the agents/plans/codebase-simplification/ files

# 3. Main is up to date
git pull origin main

# 4. Current build is green
npm run build && cd worker && npx tsc --noEmit && cd .. && npm test
```

## Execution commands per phase

### Phase 1: Quick Wins

```bash
# Create worktrees
cmcs worktree create simplify-frontend-hooks
cmcs worktree create simplify-worker-errors

# Copy tickets
cp agents/plans/codebase-simplification/tickets/phase1-quick-wins/TICKET-001.md worktrees/simplify-frontend-hooks/.cmcs/tickets/
cp agents/plans/codebase-simplification/tickets/phase1-quick-wins/TICKET-002.md worktrees/simplify-worker-errors/.cmcs/tickets/TICKET-001.md

# Run both in parallel
cmcs run worktrees/simplify-frontend-hooks
cmcs run worktrees/simplify-worker-errors

# Wait for completion
cmcs wait worktrees/simplify-frontend-hooks
cmcs wait worktrees/simplify-worker-errors
```

### Phase 2: Worker Structure

**IMPORTANT:** Create Phase 2 worktrees ONLY after Phase 1 is fully merged to main. Phase 1 modifies `router.ts`; Phase 2 worktrees must branch from the merged state.

```bash
# Create worktrees (after Phase 1 is merged)
cmcs worktree create simplify-router
cmcs worktree create simplify-cache-handlers

# Copy tickets
cp agents/plans/codebase-simplification/tickets/phase2-worker-structure/TICKET-001.md worktrees/simplify-router/.cmcs/tickets/
cp agents/plans/codebase-simplification/tickets/phase2-worker-structure/TICKET-002.md worktrees/simplify-cache-handlers/.cmcs/tickets/TICKET-001.md

# Run both in parallel
cmcs run worktrees/simplify-router
cmcs run worktrees/simplify-cache-handlers

# Wait for completion
cmcs wait worktrees/simplify-router
cmcs wait worktrees/simplify-cache-handlers
```

### Phase 3: Methodology Versions

```bash
# Create worktree
cmcs worktree create simplify-versions

# Copy tickets (sequential — TICKET-002 depends on TICKET-001)
cp agents/plans/codebase-simplification/tickets/phase3-methodology-versions/TICKET-001.md worktrees/simplify-versions/.cmcs/tickets/
cp agents/plans/codebase-simplification/tickets/phase3-methodology-versions/TICKET-002.md worktrees/simplify-versions/.cmcs/tickets/

# Run
cmcs run worktrees/simplify-versions

# Wait for completion
cmcs wait worktrees/simplify-versions
```

## Review checklists per phase

### Phase 1 Review

```bash
# In simplify-frontend-hooks worktree:
cd worktrees/simplify-frontend-hooks
npm run build && npm test

# Spot checks
grep -c "type SortDirection" src/hooks/use-sorted-table-rows.ts    # expect 0
grep -c "type SortDirection" src/hooks/use-sorted-paginated-table.ts  # expect 0
grep -c "type SortDirection" src/hooks/use-sort.ts                  # expect 1
grep -c "page: effectivePage" src/hooks/use-table-pagination.ts     # expect 0 (redundant alias removed)
grep -c "page: number" src/hooks/use-table-pagination.ts           # expect 1 (only TablePaginationState.page)

# In simplify-worker-errors worktree:
cd worktrees/simplify-worker-errors
npm run build && cd worker && npx tsc --noEmit && cd .. && npm test

# Spot checks
grep -rn "new Response(JSON.stringify.*error" worker/src/router.ts | wc -l      # expect 0-3 (success responses remain)
grep -rn "new Response(JSON.stringify.*error" worker/src/lib/auth.ts | wc -l    # expect 0
grep -c "isValidStablecoinId" worker/src/lib/api-utils.ts                       # expect 0
```

### Phase 2 Review

```bash
# In simplify-router worktree:
cd worktrees/simplify-router
cd worker && npx tsc --noEmit && cd .. && npm test

# Spot checks
grep -c "matchDynamicRoute" worker/src/router.ts    # expect >= 3
grep -c "decodeURIComponent" worker/src/router.ts   # expect 1

# In simplify-cache-handlers worktree:
cd worktrees/simplify-cache-handlers
cd worker && npx tsc --noEmit && cd .. && npm test

# Spot checks
test -f worker/src/api/cache-handlers.ts            # expect 0 (exists)
test ! -f worker/src/api/stablecoins.ts             # expect 0 (deleted)
test ! -f worker/src/api/bluechip.ts                # expect 0 (deleted)
grep -c "from.*cache-handlers" worker/src/router.ts # expect 1
```

### Phase 3 Review

```bash
cd worktrees/simplify-versions
npm run build && cd worker && npx tsc --noEmit && cd .. && npm test

# Spot checks — factory exists
test -f shared/lib/methodology-version.ts                           # expect 0
grep -c "createMethodologyVersion" shared/lib/methodology-version.ts  # expect >= 2

# Spot checks — all 6 files use factory
grep -c "from.*methodology-version" shared/lib/depeg-dews-version.ts       # expect 1
grep -c "from.*methodology-version" shared/lib/stability-index-version.ts  # expect 1
grep -c "from.*methodology-version" shared/lib/liquidity-score-version.ts  # expect 1
grep -c "from.*methodology-version" shared/lib/blacklist-tracker-version.ts # expect 1
grep -c "from.*methodology-version" shared/lib/yield-methodology-version.ts # expect 1
grep -c "from.*methodology-version" shared/lib/mint-burn-flow-version.ts   # expect 1

# Spot checks — boilerplate removed
grep -c "VERSION_WINDOWS_ASC" shared/lib/depeg-dews-version.ts     # expect 0
grep -c "for (const window of" shared/lib/depeg-dews-version.ts    # expect 0

# All version tests pass
npx vitest run src/lib/__tests__/methodology-version.test.ts src/lib/__tests__/*-version.test.ts
```

## Merge instructions

### Phase 1: Merge order does not matter (non-overlapping files)

```bash
# Merge simplify-frontend-hooks
cd worktrees/simplify-frontend-hooks
git add -A && git commit -m "refactor: remove duplicate SortDirection types and redundant pagination return"
cd ../..
git merge --no-ff simplify-frontend-hooks
# Record merge SHA in PROGRESS.md

# Merge simplify-worker-errors
cd worktrees/simplify-worker-errors
git add -A && git commit -m "refactor: replace inline error responses with errorResponse() utility"
cd ../..
git merge --no-ff simplify-worker-errors
# Record merge SHA in PROGRESS.md

# Post-merge verification on main
npm run build && cd worker && npx tsc --noEmit && cd .. && npm test
```

### Phase 2: Merge `simplify-router` FIRST

Both worktrees touch `worker/src/router.ts` (different regions). Merge `simplify-router` first to avoid conflicts:

```bash
cd worktrees/simplify-router
git add -A && git commit -m "refactor: extract matchDynamicRoute helper in router"
cd ../..
git merge --no-ff simplify-router
# Record merge SHA in PROGRESS.md

cd worktrees/simplify-cache-handlers
git add -A && git commit -m "refactor: consolidate cache-passthrough handler files"
cd ../..
git merge --no-ff simplify-cache-handlers
# If conflict in router.ts imports: keep the cache-handlers import, resolve manually
# Record merge SHA in PROGRESS.md

# Post-merge verification on main
npm run build && cd worker && npx tsc --noEmit && cd .. && npm test
```

### Phase 3: Single worktree, straightforward merge

```bash
cd worktrees/simplify-versions
git add -A && git commit -m "refactor: unify methodology version files with createMethodologyVersion factory"
cd ../..
git merge --no-ff simplify-versions
# Record merge SHA in PROGRESS.md

# Post-merge verification on main
npm run build && cd worker && npx tsc --noEmit && cd .. && npm test
```

## Rollback procedures per phase

Use the merge commit SHAs recorded in PROGRESS.md. Do NOT rely on `HEAD~N` — intermediate commits (PROGRESS.md updates, etc.) would shift the offsets.

### Phase 1 rollback

```bash
git revert <sha-of-worker-errors-merge> <sha-of-frontend-hooks-merge>
```

### Phase 2 rollback

```bash
git revert <sha-of-cache-handlers-merge> <sha-of-router-merge>
```

### Phase 3 rollback

```bash
git revert <sha-of-versions-merge>
```

All phases are code-only (no DB migrations, no secrets, no deployment coordination). Rollback is always a simple `git revert`.

## Known risks and mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Phase 2 worktrees both touch `router.ts` | Low | Non-overlapping regions. Merge `simplify-router` first. |
| Phase 3 version migration breaks consumer imports | Medium | All existing export names are preserved as re-exports. Build + tsc + test catch any breakage. |
| `errorResponse()` output differs from inline construction | Very low | Both produce identical `{ error: message }` JSON with `Content-Type: application/json`. Maintenance response kept inline (uses `error: "maintenance"` key). |
| Rate-limit `Retry-After` header lost during migration | Low | Ticket explicitly handles the extra header with `resp.headers.set()`. |
| Changelog `selectImpact` functions break after field rename | Medium | Ticket instructs agent to update `selectImpact` to use `entry.impact`. Build catches type errors. |

## Orchestrator protocol

1. Read `PROGRESS.md` to determine current state
2. If starting a new phase: run pre-flight checks, create worktrees, copy tickets, start runs
3. When runs complete: review diffs with checklist, run build/test in each worktree
4. If review passes: merge per instructions (use `--no-ff`), record merge SHA in PROGRESS.md
5. After merging: run `npm run build && cd worker && npx tsc --noEmit && cd .. && npm test` on main
6. If post-merge verification fails: `git revert <merge-sha>` and investigate
7. If review fails: check logs (`cmcs logs <path>`), fix ticket or code, re-run
8. After each phase: clean up worktrees with `cmcs worktree remove <name>`
9. After all phases: push to main

## When Codex fails

1. `cmcs logs worktrees/<name>` — read agent output
2. Identify failure: wrong file path? Missing context? Build error?
3. Fix the ticket (update paths, add code snippets, clarify instructions)
4. Re-run: `cmcs run worktrees/<name>`
5. If the ticket itself is structurally wrong (bad acceptance criteria, contradictory instructions):
   a. Fix the ticket in `agents/plans/codebase-simplification/tickets/`
   b. Reset the worktree: `cd worktrees/<name> && git checkout -- . && git clean -fd`
   c. Re-copy the fixed ticket: `cp <fixed-ticket> worktrees/<name>/.cmcs/tickets/`
   d. Re-run: `cmcs run worktrees/<name>`

## After context compaction

1. Read `agents/plans/codebase-simplification/PROGRESS.md` first
2. Read this file (`execution-handover.md`)
3. Pick up where PROGRESS.md says
4. If a phase is in-progress, also read the ticket files for that phase and `cmcs logs` for any active runs
