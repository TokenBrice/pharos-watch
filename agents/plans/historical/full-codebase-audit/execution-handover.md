# Full-Scale Codebase Audit — Execution Handover

## What this does

A comprehensive audit of the entire Pharos codebase and live deployment, executed by 10 parallel Codex agents (one per domain), then consolidated into a single actionable report. No code changes — findings only.

## File inventory

```
docs/plans/full-codebase-audit/
  2026-03-06-full-codebase-audit-design.md    # Design decisions
  implementation-plan.md                       # Phase/worktree structure
  execution-handover.md                        # This file — operational runbook
  PROGRESS.md                                  # Current state (read first after compaction)
  tickets/
    phase1-audit/
      TICKET-001.md   # Documentation
      TICKET-002.md   # Frontend UI/UX
      TICKET-003.md   # Accessibility
      TICKET-004.md   # SEO & Meta
      TICKET-005.md   # API Correctness
      TICKET-006.md   # Cron & Pipeline
      TICKET-007.md   # Schema & Data
      TICKET-008.md   # Testing Coverage
      TICKET-009.md   # Security
      TICKET-010.md   # Status & Observability
    phase2-consolidation/
      TICKET-001.md   # Merge findings into final report
```

## Pre-flight checks

```bash
# cmcs initialized
cmcs status

# Clean working tree
git status

# Main is up to date
git pull origin main

# Ticket files exist
ls docs/plans/full-codebase-audit/tickets/phase1-audit/TICKET-0*.md | wc -l
# Expected: 10

ls docs/plans/full-codebase-audit/tickets/phase2-consolidation/TICKET-001.md
# Expected: exists
```

## Phase 1: Parallel Audit

### Create worktrees (copy-paste block)

```bash
cmcs worktree create audit-docs
cmcs worktree create audit-frontend-ux
cmcs worktree create audit-accessibility
cmcs worktree create audit-seo
cmcs worktree create audit-api
cmcs worktree create audit-cron
cmcs worktree create audit-schema
cmcs worktree create audit-testing
cmcs worktree create audit-security
cmcs worktree create audit-status
```

### Copy tickets (copy-paste block)

```bash
cp docs/plans/full-codebase-audit/tickets/phase1-audit/TICKET-001.md worktrees/audit-docs/.cmcs/tickets/
cp docs/plans/full-codebase-audit/tickets/phase1-audit/TICKET-002.md worktrees/audit-frontend-ux/.cmcs/tickets/
cp docs/plans/full-codebase-audit/tickets/phase1-audit/TICKET-003.md worktrees/audit-accessibility/.cmcs/tickets/
cp docs/plans/full-codebase-audit/tickets/phase1-audit/TICKET-004.md worktrees/audit-seo/.cmcs/tickets/
cp docs/plans/full-codebase-audit/tickets/phase1-audit/TICKET-005.md worktrees/audit-api/.cmcs/tickets/
cp docs/plans/full-codebase-audit/tickets/phase1-audit/TICKET-006.md worktrees/audit-cron/.cmcs/tickets/
cp docs/plans/full-codebase-audit/tickets/phase1-audit/TICKET-007.md worktrees/audit-schema/.cmcs/tickets/
cp docs/plans/full-codebase-audit/tickets/phase1-audit/TICKET-008.md worktrees/audit-testing/.cmcs/tickets/
cp docs/plans/full-codebase-audit/tickets/phase1-audit/TICKET-009.md worktrees/audit-security/.cmcs/tickets/
cp docs/plans/full-codebase-audit/tickets/phase1-audit/TICKET-010.md worktrees/audit-status/.cmcs/tickets/
```

### Run all 10 (copy-paste block)

```bash
cmcs run worktrees/audit-docs
cmcs run worktrees/audit-frontend-ux
cmcs run worktrees/audit-accessibility
cmcs run worktrees/audit-seo
cmcs run worktrees/audit-api
cmcs run worktrees/audit-cron
cmcs run worktrees/audit-schema
cmcs run worktrees/audit-testing
cmcs run worktrees/audit-security
cmcs run worktrees/audit-status
```

### Wait for completion

```bash
cmcs wait worktrees/audit-docs
cmcs wait worktrees/audit-frontend-ux
cmcs wait worktrees/audit-accessibility
cmcs wait worktrees/audit-seo
cmcs wait worktrees/audit-api
cmcs wait worktrees/audit-cron
cmcs wait worktrees/audit-schema
cmcs wait worktrees/audit-testing
cmcs wait worktrees/audit-security
cmcs wait worktrees/audit-status
```

### Review checklist (per worktree)

For each completed worktree:

```bash
# 1. Check findings file exists
WORKTREE=audit-docs  # repeat for each
ls worktrees/$WORKTREE/FINDINGS-*.md

# 2. Verify format compliance — every finding has severity header and effort tag
grep -c '^\- \[' worktrees/$WORKTREE/FINDINGS-*.md
# Expected: > 0

grep -c '\[~' worktrees/$WORKTREE/FINDINGS-*.md
# Expected: same count as findings

# 3. Check for required sections
grep -c '^#### Critical\|^#### High\|^#### Medium\|^#### Low' worktrees/$WORKTREE/FINDINGS-*.md
# Expected: 4 (one per severity level)

# 4. Read and review content quality
cat worktrees/$WORKTREE/FINDINGS-*.md
```

### Live probe fallback

If Codex agents couldn't execute curl commands (no internet access), run these manually:

```bash
# SEO probes (Domain 4)
curl -s https://pharos.watch | grep -i '<meta' | head -20
curl -s https://pharos.watch | grep -i 'og:' | head -20
curl -s https://pharos.watch/stablecoin/usdt-tether | grep -i '<title'
curl -s https://pharos.watch/sitemap.xml | head -20
curl -s https://pharos.watch/robots.txt

# API probes (Domain 5)
curl -s https://api.pharos.watch/api/stablecoins | head -5
curl -s https://api.pharos.watch/api/peg-summary | head -5
curl -s https://api.pharos.watch/api/stablecoin/usdt-tether | head -5
curl -s https://api.pharos.watch/api/nonexistent-endpoint
curl -s -o /dev/null -w '%{http_code}' https://api.pharos.watch/api/status

# Status probes (Domain 10)
curl -s https://api.pharos.watch/api/status | python3 -m json.tool | head -30
curl -s https://pharos.watch/status | grep -i 'status'
```

Append results to the corresponding `FINDINGS-*.md` files before proceeding to Phase 2.

### Collect findings

```bash
mkdir -p docs/plans/full-codebase-audit/findings
cp worktrees/audit-docs/FINDINGS-DOCS.md docs/plans/full-codebase-audit/findings/
cp worktrees/audit-frontend-ux/FINDINGS-FRONTEND-UX.md docs/plans/full-codebase-audit/findings/
cp worktrees/audit-accessibility/FINDINGS-ACCESSIBILITY.md docs/plans/full-codebase-audit/findings/
cp worktrees/audit-seo/FINDINGS-SEO.md docs/plans/full-codebase-audit/findings/
cp worktrees/audit-api/FINDINGS-API.md docs/plans/full-codebase-audit/findings/
cp worktrees/audit-cron/FINDINGS-CRON.md docs/plans/full-codebase-audit/findings/
cp worktrees/audit-schema/FINDINGS-SCHEMA.md docs/plans/full-codebase-audit/findings/
cp worktrees/audit-testing/FINDINGS-TESTING.md docs/plans/full-codebase-audit/findings/
cp worktrees/audit-security/FINDINGS-SECURITY.md docs/plans/full-codebase-audit/findings/
cp worktrees/audit-status/FINDINGS-STATUS.md docs/plans/full-codebase-audit/findings/
```

## Phase 2: Consolidation

### Create worktree, copy inputs and ticket

```bash
cmcs worktree create audit-consolidation

# Copy all findings into worktree
mkdir -p worktrees/audit-consolidation/findings
cp docs/plans/full-codebase-audit/findings/FINDINGS-DOCS.md worktrees/audit-consolidation/findings/
cp docs/plans/full-codebase-audit/findings/FINDINGS-FRONTEND-UX.md worktrees/audit-consolidation/findings/
cp docs/plans/full-codebase-audit/findings/FINDINGS-ACCESSIBILITY.md worktrees/audit-consolidation/findings/
cp docs/plans/full-codebase-audit/findings/FINDINGS-SEO.md worktrees/audit-consolidation/findings/
cp docs/plans/full-codebase-audit/findings/FINDINGS-API.md worktrees/audit-consolidation/findings/
cp docs/plans/full-codebase-audit/findings/FINDINGS-CRON.md worktrees/audit-consolidation/findings/
cp docs/plans/full-codebase-audit/findings/FINDINGS-SCHEMA.md worktrees/audit-consolidation/findings/
cp docs/plans/full-codebase-audit/findings/FINDINGS-TESTING.md worktrees/audit-consolidation/findings/
cp docs/plans/full-codebase-audit/findings/FINDINGS-SECURITY.md worktrees/audit-consolidation/findings/
cp docs/plans/full-codebase-audit/findings/FINDINGS-STATUS.md worktrees/audit-consolidation/findings/

# Verify all 10 files copied
ls worktrees/audit-consolidation/findings/FINDINGS-*.md | wc -l
# Expected: 10

# Copy ticket
mkdir -p worktrees/audit-consolidation/.cmcs/tickets
cp docs/plans/full-codebase-audit/tickets/phase2-consolidation/TICKET-001.md worktrees/audit-consolidation/.cmcs/tickets/
```

### Run

```bash
cmcs run worktrees/audit-consolidation
cmcs wait worktrees/audit-consolidation
```

### Review checklist

```bash
# 1. Report file exists
ls worktrees/audit-consolidation/docs/audit/2026-03-06-full-codebase-audit.md

# 2. Executive summary has tallies
grep -A5 'Executive Summary' worktrees/audit-consolidation/docs/audit/2026-03-06-full-codebase-audit.md

# 3. All 10 domains present
grep -c '^### [0-9]' worktrees/audit-consolidation/docs/audit/2026-03-06-full-codebase-audit.md
# Expected: 10

# 4. Tally check — summary matches actual count
TOTAL=$(grep -c '^\- \[' worktrees/audit-consolidation/docs/audit/2026-03-06-full-codebase-audit.md)
echo "Total findings: $TOTAL"

# 5. No duplicate IDs
grep -o '\[[A-Z]*-[0-9]*\]' worktrees/audit-consolidation/docs/audit/2026-03-06-full-codebase-audit.md | sort | uniq -d
# Expected: empty (no duplicates)
```

### Merge to main

```bash
# Copy report from worktree to main repo
mkdir -p docs/audit
cp worktrees/audit-consolidation/docs/audit/2026-03-06-full-codebase-audit.md docs/audit/

# Commit
git add docs/audit/2026-03-06-full-codebase-audit.md
git commit -m "docs: full codebase audit report — 2026-03-06"
```

## Cleanup

After the report is committed:

```bash
# Remove worktrees
cmcs worktree remove audit-docs
cmcs worktree remove audit-frontend-ux
cmcs worktree remove audit-accessibility
cmcs worktree remove audit-seo
cmcs worktree remove audit-api
cmcs worktree remove audit-cron
cmcs worktree remove audit-schema
cmcs worktree remove audit-testing
cmcs worktree remove audit-security
cmcs worktree remove audit-status
cmcs worktree remove audit-consolidation
```

## Rollback

This project produces only a single markdown report — no code or schema changes. Rollback is a single `git revert` of the commit that added the report. No D1, worker, or deployment rollback needed.

## Orchestrator protocol

1. Run pre-flight checks
2. Create all Phase 1 worktrees, copy tickets, launch runs
3. Update PROGRESS.md: Phase 1 started
4. Wait for all 10 runs to complete
5. Review each findings file (format + quality)
6. Run live probes manually if any agent lacked internet access
7. Collect all findings into `docs/plans/full-codebase-audit/findings/`
8. Update PROGRESS.md: Phase 1 complete
9. Create Phase 2 worktree, copy findings + ticket, launch run
10. Update PROGRESS.md: Phase 2 started
11. Review consolidated report
12. Copy report to `docs/audit/`, commit to main
13. Update PROGRESS.md: Phase 2 complete
14. Clean up worktrees

## When Codex fails

1. `cmcs logs worktrees/<failed-worktree>` — read the output
2. Common failures:
   - **Internet access denied**: Expected for live probe tickets. Run curl commands manually (see "Live probe fallback" above).
   - **Context window exceeded**: The ticket asked to read too many files. Not actionable — review what the agent did produce and accept partial findings.
   - **Format non-compliance**: Agent produced findings but not in the expected format. Reformat manually or re-run with a clarified ticket.
3. Fix the ticket or accept partial output, then update PROGRESS.md

## After context compaction

1. Read `docs/plans/full-codebase-audit/PROGRESS.md` first
2. Read this file (execution-handover.md)
3. Pick up where PROGRESS.md says
