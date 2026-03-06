# Implementation Plan: Post-Migration Documentation Update

**Date:** 2026-03-06
**Design:** [2026-03-06-post-migration-docs-update-design.md](./2026-03-06-post-migration-docs-update-design.md)

## Execution Strategy

1 phase, 1 worktree, 5 sequential tickets. All documentation-only changes — no code, no DB, no deployment risk.

```
Phase 1 (Docs Update) → 1 worktree, 5 sequential tickets
```

## Phase 1: Documentation Update

**Worktree:** `post-migration-docs`

| Ticket | Title | Key Files | Effort |
|--------|-------|-----------|--------|
| TICKET-001 | Update api-reference.md ID format section | `docs/api-reference.md` | low |
| TICKET-002 | Rewrite adding-a-stablecoin.md for ticker-issuer IDs | `docs/process/adding-a-stablecoin.md` | medium |
| TICKET-003 | Update mint-burn-flows.md config table + runbook | `docs/mint-burn-flows.md`, `docs/runbooks/mint-burn-ingestion.md` | medium |
| TICKET-004 | Update classification.md + supply-snapshot.md ID descriptions | `docs/classification.md`, `docs/supply-snapshot.md` | low |
| TICKET-005 | Fix small stale ID references across 4 docs | `docs/dews.md`, `docs/status-dashboard.md`, `docs/cemetery-and-compare.md`, `docs/scripts.md` | low |

**Gate:** `npm run build` passes (docs are referenced from methodology page which is statically built). No test changes needed.

## Worktree Dispatch Summary

```bash
cmcs worktree create post-migration-docs
# Copy tickets
cp docs/plans/post-migration-docs-update/tickets/phase1-docs-update/TICKET-*.md \
   worktrees/stablecoin-dashboard--post-migration-docs/.cmcs/tickets/
cmcs run worktrees/stablecoin-dashboard--post-migration-docs
cmcs wait worktrees/stablecoin-dashboard--post-migration-docs
# Review + merge
```

## Supporting Artifacts

| Artifact | Path |
|----------|------|
| Canonical ID source of truth | `shared/lib/stablecoins.ts` (already migrated) |
| Mint-burn contract IDs | `worker/src/lib/mint-burn-contracts.ts` (already migrated) |
| Design doc | `docs/plans/post-migration-docs-update/2026-03-06-post-migration-docs-update-design.md` |
