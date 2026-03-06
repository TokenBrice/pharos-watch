# Full-Scale Codebase Audit — Implementation Plan

## Execution Strategy

- **2 phases**, **11 worktrees**, **11 tickets**
- Phase 1: 10 parallel audit worktrees (one per domain), 1 ticket each
- Phase 2: 1 consolidation worktree, 1 ticket
- All worktrees are **read-only** — no production code is modified
- Output: single report file at `docs/audit/2026-03-06-full-codebase-audit.md`

## Phase 1: Parallel Audit (10 worktrees)

All 10 worktrees run simultaneously. Each produces a `FINDINGS-<domain>.md` file in the worktree root.

### Worktree dispatch

| Worktree | Ticket | Domain | Key Files |
|----------|--------|--------|-----------|
| `audit-docs` | TICKET-001 | Documentation | `docs/**/*.md`, `CLAUDE.md`, cross-ref with `src/`, `worker/`, `shared/` |
| `audit-frontend-ux` | TICKET-002 | Frontend UI/UX | `src/app/**/page.tsx`, `src/components/**/*.tsx`, `src/lib/*.ts` |
| `audit-accessibility` | TICKET-003 | Accessibility | `src/app/**/page.tsx`, `src/components/**/*.tsx` |
| `audit-seo` | TICKET-004 | SEO & Meta | `src/app/layout.tsx`, `src/lib/page-metadata.ts`, `public/`, all page files |
| `audit-api` | TICKET-005 | API Correctness | `worker/src/api/*.ts`, `worker/src/router.ts`, `docs/api-reference.md` |
| `audit-cron` | TICKET-006 | Cron & Pipeline | `worker/src/cron/*.ts`, `worker/src/lib/*.ts`, `docs/worker-infrastructure.md` |
| `audit-schema` | TICKET-007 | Schema & Data | `worker/migrations/*.sql` (50 files), `worker/src/lib/db.ts`, `worker/src/lib/env.ts`, type files |
| `audit-testing` | TICKET-008 | Testing Coverage | All `*.test.*` files, compare against source counterparts |
| `audit-security` | TICKET-009 | Security | `worker/src/lib/auth.ts`, `worker/src/router.ts`, all API handlers, `worker/src/lib/env.ts` |
| `audit-status` | TICKET-010 | Status & Observability | `worker/src/api/status.ts`, `worker/src/cron/status-self-check.ts`, `worker/src/lib/alerts.ts`, `src/app/status/page.tsx` |

### Gate criteria

Before proceeding to Phase 2:

1. All 10 cmcs runs have completed
2. Orchestrator has reviewed each `FINDINGS-<domain>.md` for quality and format compliance
3. Any failed live probes have been re-run manually by the orchestrator and results appended
4. All 10 findings files are collected in `docs/plans/full-codebase-audit/findings/`

## Phase 2: Consolidation (1 worktree)

### Worktree: `audit-consolidation`

| Ticket | Description |
|--------|-------------|
| TICKET-001 | Merge all 10 findings files into a single structured report |

### Input

All 10 `FINDINGS-*.md` files, copied into the worktree root before running.

### Output

`docs/audit/2026-03-06-full-codebase-audit.md` — the final consolidated report.

### Gate criteria

1. Report file exists and follows the schema defined in the design document
2. Every finding has a severity tag, domain prefix, and effort estimate
3. No duplicate findings (same issue reported by two domains)
4. Executive summary tallies match the actual finding counts
5. Orchestrator performs final review before committing to main

## Manual Steps

| Step | When | Who |
|------|------|-----|
| Run failed live probes (curl commands for SEO/API/status) | After Phase 1 if Codex lacked internet | Orchestrator |
| Review each findings file for quality | Phase 1 → Phase 2 gate | Orchestrator |
| Copy findings files into consolidation worktree | Before Phase 2 run | Orchestrator |
| Final report review and commit to main | After Phase 2 | Orchestrator |

## Worktree Dispatch Summary

### Phase 1 — create and run all 10 in parallel

```bash
# Create all worktrees
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

# Copy tickets (one per worktree)
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

# Run all 10
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

### Phase 2 — consolidation

```bash
# Create worktree
cmcs worktree create audit-consolidation

# Findings are already collected in docs/plans/full-codebase-audit/findings/
# (done by orchestrator at the Phase 1 → 2 gate)

# Copy findings into consolidation worktree
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

# Copy ticket and run
mkdir -p worktrees/audit-consolidation/.cmcs/tickets
cp docs/plans/full-codebase-audit/tickets/phase2-consolidation/TICKET-001.md worktrees/audit-consolidation/.cmcs/tickets/
cmcs run worktrees/audit-consolidation
```

## Supporting Artifacts

| Artifact | Location | Purpose |
|----------|----------|---------|
| Design document | `docs/plans/full-codebase-audit/2026-03-06-full-codebase-audit-design.md` | Why and what |
| This plan | `docs/plans/full-codebase-audit/implementation-plan.md` | How |
| Execution handover | `docs/plans/full-codebase-audit/execution-handover.md` | Operational runbook |
| Progress tracker | `docs/plans/full-codebase-audit/PROGRESS.md` | Current state |
| Prior doc audit | `docs/documentation-audit-report-2026-03-05.md` | Reference for Domain 1 |
| Phase 1 tickets | `docs/plans/full-codebase-audit/tickets/phase1-audit/TICKET-001..010.md` | Domain audit instructions |
| Phase 2 ticket | `docs/plans/full-codebase-audit/tickets/phase2-consolidation/TICKET-001.md` | Consolidation instructions |
