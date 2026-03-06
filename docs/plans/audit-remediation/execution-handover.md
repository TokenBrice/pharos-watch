# Audit Remediation — Execution Handover

## What this does

Implements 73 audit findings (Critical + High + Medium) across 5 phases, 13 worktrees. All code changes, no rollback complexity — each phase produces independently testable improvements.

## File inventory

```
docs/plans/audit-remediation/
  2026-03-06-audit-remediation-design.md    # Design decisions
  implementation-plan.md                     # Phase/worktree structure
  execution-handover.md                      # This file — operational runbook
  PROGRESS.md                                # Current state (read first after compaction)
  tickets/
    phase1/TICKET-001.md   # SQL safety (fix-sql-safety)
    phase1/TICKET-002.md   # API input validation (fix-api-input)
    phase2/TICKET-003.md   # Frontend error states (fix-frontend-errors)
    phase2/TICKET-004.md   # Worker error handling (fix-worker-errors)
    phase3/TICKET-005.md   # Probe fidelity (fix-probe-alerts)
    phase3/TICKET-006.md   # Cron reliability (fix-cron-reliability)
    phase3/TICKET-007.md   # Status API expansion (fix-status-api)
    phase4/TICKET-008.md   # Test infrastructure (fix-test-infra)
    phase4/TICKET-009.md   # Worker tests (fix-worker-tests)
    phase4/TICKET-010.md   # Frontend tests (fix-frontend-tests)
    phase5/TICKET-011.md   # SEO + accessibility (fix-seo-a11y)
    phase5/TICKET-012.md   # Docs + config (fix-docs-config)
```

## Pre-flight checks

```bash
cmcs status
git status
git pull origin main

# Verify all tickets exist
ls docs/plans/audit-remediation/tickets/phase1/TICKET-00*.md | wc -l  # Expected: 2
ls docs/plans/audit-remediation/tickets/phase2/TICKET-00*.md | wc -l  # Expected: 2
ls docs/plans/audit-remediation/tickets/phase3/TICKET-00*.md | wc -l  # Expected: 3
ls docs/plans/audit-remediation/tickets/phase4/TICKET-0*.md | wc -l   # Expected: 3
ls docs/plans/audit-remediation/tickets/phase5/TICKET-0*.md | wc -l   # Expected: 2

# Build passes
npm run build
npm test
cd worker && npx tsc --noEmit && cd ..
```

## Phase 1 & 2: Parallel Launch

### Create worktrees (4 total)

```bash
cmcs worktree create fix-sql-safety
cmcs worktree create fix-api-input
cmcs worktree create fix-frontend-errors
cmcs worktree create fix-worker-errors
```

### Copy tickets

```bash
cp docs/plans/audit-remediation/tickets/phase1/TICKET-001.md worktrees/fix-sql-safety/.cmcs/tickets/
cp docs/plans/audit-remediation/tickets/phase1/TICKET-002.md worktrees/fix-api-input/.cmcs/tickets/
cp docs/plans/audit-remediation/tickets/phase2/TICKET-003.md worktrees/fix-frontend-errors/.cmcs/tickets/
cp docs/plans/audit-remediation/tickets/phase2/TICKET-004.md worktrees/fix-worker-errors/.cmcs/tickets/
```

### Run all 4

```bash
cmcs run worktrees/fix-sql-safety
cmcs run worktrees/fix-api-input
cmcs run worktrees/fix-frontend-errors
cmcs run worktrees/fix-worker-errors
```

### Wait + review

```bash
cmcs wait worktrees/fix-sql-safety
cmcs wait worktrees/fix-api-input
cmcs wait worktrees/fix-frontend-errors
cmcs wait worktrees/fix-worker-errors
```

### Review checklist (per worktree)

```bash
WORKTREE=fix-sql-safety  # repeat for each
# 1. Check logs for errors
cmcs logs worktrees/$WORKTREE | tail -20

# 2. Review git diff
cd worktrees/$WORKTREE && git diff HEAD~1 --stat && cd ../..

# 3. Run acceptance criteria
cd worktrees/$WORKTREE && npm test && npx tsc --noEmit && cd ../..
```

### Merge to main

For each completed worktree, cherry-pick or merge the commit(s) to main:

```bash
# Get the commit hash from the worktree
cd worktrees/fix-sql-safety && git log --oneline -1 && cd ../..
# Cherry-pick to main
git cherry-pick <hash>
```

Run full verification after all Phase 1+2 merges:
```bash
npm run build && npm test && npm run lint && cd worker && npx tsc --noEmit && cd ..
```

## Phase 3: After Phases 1+2

### Create worktrees (3)

```bash
cmcs worktree create fix-probe-alerts
cmcs worktree create fix-cron-reliability
cmcs worktree create fix-status-api
```

### Copy tickets + run

```bash
cp docs/plans/audit-remediation/tickets/phase3/TICKET-005.md worktrees/fix-probe-alerts/.cmcs/tickets/
cp docs/plans/audit-remediation/tickets/phase3/TICKET-006.md worktrees/fix-cron-reliability/.cmcs/tickets/
cp docs/plans/audit-remediation/tickets/phase3/TICKET-007.md worktrees/fix-status-api/.cmcs/tickets/

cmcs run worktrees/fix-probe-alerts
cmcs run worktrees/fix-cron-reliability
cmcs run worktrees/fix-status-api
```

### Wait + review + merge

Same review checklist as above. After merge, run full verification.

**Migration note:** TICKET-007 creates a D1 migration file. After merge, apply it:
```bash
cd worker && npx wrangler d1 execute stablecoin-db --remote --file migrations/NNNN_audit_perf_indexes.sql
```

## Phase 4 & 5: Parallel Launch

### Phase 4: Test infrastructure first

```bash
cmcs worktree create fix-test-infra
cp docs/plans/audit-remediation/tickets/phase4/TICKET-008.md worktrees/fix-test-infra/.cmcs/tickets/
cmcs run worktrees/fix-test-infra
cmcs wait worktrees/fix-test-infra
# Review + merge fix-test-infra BEFORE launching fix-worker-tests
```

Then launch remaining Phase 4 + Phase 5 in parallel:

```bash
cmcs worktree create fix-worker-tests
cmcs worktree create fix-frontend-tests
cmcs worktree create fix-seo-a11y
cmcs worktree create fix-docs-config

cp docs/plans/audit-remediation/tickets/phase4/TICKET-009.md worktrees/fix-worker-tests/.cmcs/tickets/
cp docs/plans/audit-remediation/tickets/phase4/TICKET-010.md worktrees/fix-frontend-tests/.cmcs/tickets/
cp docs/plans/audit-remediation/tickets/phase5/TICKET-011.md worktrees/fix-seo-a11y/.cmcs/tickets/
cp docs/plans/audit-remediation/tickets/phase5/TICKET-012.md worktrees/fix-docs-config/.cmcs/tickets/

cmcs run worktrees/fix-worker-tests
cmcs run worktrees/fix-frontend-tests
cmcs run worktrees/fix-seo-a11y
cmcs run worktrees/fix-docs-config
```

### Wait + review + merge

Same checklist. Final verification after all merges.

## Cleanup

After all phases complete:

```bash
cmcs worktree cleanup fix-sql-safety
cmcs worktree cleanup fix-api-input
cmcs worktree cleanup fix-frontend-errors
cmcs worktree cleanup fix-worker-errors
cmcs worktree cleanup fix-probe-alerts
cmcs worktree cleanup fix-cron-reliability
cmcs worktree cleanup fix-status-api
cmcs worktree cleanup fix-test-infra
cmcs worktree cleanup fix-worker-tests
cmcs worktree cleanup fix-frontend-tests
cmcs worktree cleanup fix-seo-a11y
cmcs worktree cleanup fix-docs-config
```

## Rollback

Each phase produces independent commits. Rollback any phase with `git revert <hash>`. The only stateful change is the D1 migration in Phase 3 — if needed, use D1 Time Travel to restore.

## Orchestrator protocol

1. Run pre-flight checks
2. Create Phase 1+2 worktrees (4), copy tickets, launch runs
3. Update PROGRESS.md
4. Wait for all 4 runs
5. Review each worktree (logs, diff, acceptance criteria)
6. Merge to main, run full verification
7. Create Phase 3 worktrees (3), copy tickets, launch runs
8. Wait, review, merge. Apply migration.
9. Create Phase 4 infra worktree, run, wait, merge (prerequisite)
10. Create Phase 4+5 remaining worktrees (4), launch runs
11. Wait, review, merge
12. Final verification on main
13. Clean up all worktrees
14. Update PROGRESS.md: complete

## After context compaction

1. Read `docs/plans/audit-remediation/PROGRESS.md` first
2. Read this file (execution-handover.md)
3. Pick up where PROGRESS.md says
