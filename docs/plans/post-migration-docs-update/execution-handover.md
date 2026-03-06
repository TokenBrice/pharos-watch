# Execution Handover: Post-Migration Documentation Update

## What this does

Updates 10 active documentation files to replace stale stablecoin ID references (numeric DefiLlama IDs, `cg-*` prefixes, `gold-*`/`silver-*` prefixes) with canonical `ticker-issuer` format, following the completed ticker-issuer migration deployed 2026-03-06.

## File inventory

```
docs/plans/post-migration-docs-update/
  2026-03-06-post-migration-docs-update-design.md   # Design document
  implementation-plan.md                              # Implementation plan
  execution-handover.md                               # This file
  PROGRESS.md                                         # Progress tracker
  tickets/phase1-docs-update/
    TICKET-001.md   # api-reference.md
    TICKET-002.md   # adding-a-stablecoin.md
    TICKET-003.md   # mint-burn-flows.md + runbook
    TICKET-004.md   # classification.md + supply-snapshot.md
    TICKET-005.md   # dews.md, status-dashboard.md, cemetery-and-compare.md, scripts.md
```

## Prerequisites

All commands assume you are in the repository root directory.

## Execution commands

```bash
# 1. Create worktree
cmcs worktree create post-migration-docs

# 2. Copy tickets into worktree
cp docs/plans/post-migration-docs-update/tickets/phase1-docs-update/TICKET-*.md \
   worktrees/stablecoin-dashboard--post-migration-docs/.cmcs/tickets/

# 3. Run
cmcs run worktrees/stablecoin-dashboard--post-migration-docs

# 4. Wait
cmcs wait worktrees/stablecoin-dashboard--post-migration-docs
```

## Review checklist

After cmcs completes, verify from the worktree root:

```bash
# Build passes (methodology page renders from docs)
npm run build

# No old ID formats remain in updated docs (exclude plans/ and research/)
grep -rEn '"1".*USDT|"2".*USDC|gold-xaut|gold-paxg|silver-kag|cg-ustb|cg-ousg|cg-jpyc|cg-mtbill|cg-wrapped' \
  docs/api-reference.md docs/process/adding-a-stablecoin.md docs/mint-burn-flows.md \
  docs/classification.md docs/supply-snapshot.md docs/dews.md docs/status-dashboard.md \
  docs/cemetery-and-compare.md docs/scripts.md docs/runbooks/mint-burn-ingestion.md
# expect 0 matches

# No "numeric DL ID" or "DefiLlama numeric ID" as primary format description
grep -iEn 'numeric.*ID.*primary|DefiLlama numeric ID' \
  docs/api-reference.md docs/process/adding-a-stablecoin.md \
  docs/classification.md docs/supply-snapshot.md docs/cemetery-and-compare.md
# expect 0 matches

# No old ?stablecoin=<number> examples (except plans/)
grep -rn 'stablecoin=[0-9]' docs/dews.md docs/status-dashboard.md
# expect 0 matches

# Canonical IDs present in updated docs
grep -c 'usdt-tether' docs/api-reference.md         # expect >= 1
grep -c 'ticker-issuer' docs/api-reference.md        # expect >= 1
grep -c 'ticker-issuer' docs/process/adding-a-stablecoin.md  # expect >= 1
grep -c 'usdt-tether' docs/mint-burn-flows.md        # expect >= 1
```

## Merge instructions

```bash
cd worktrees/stablecoin-dashboard--post-migration-docs
git add docs/
git commit -m "docs: update 10 doc files for ticker-issuer ID migration"
# Merge to main (no conflicts expected — docs-only changes)
git checkout main && git merge post-migration-docs
```

## Rollback

This is a docs-only change. Rollback is a simple `git revert`.

```bash
git revert HEAD  # if the merge commit was the latest
```

## Orchestrator protocol

1. Read PROGRESS.md first
2. Create worktree, copy tickets, run cmcs
3. Wait for completion
4. Run review checklist
5. If all checks pass, merge to main
6. Update PROGRESS.md
7. Clean up worktree: `cmcs worktree delete post-migration-docs`

## After context compaction

Read `docs/plans/post-migration-docs-update/PROGRESS.md` first, then this file. Pick up where progress says.
