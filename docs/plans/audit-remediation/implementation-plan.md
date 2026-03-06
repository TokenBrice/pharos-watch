# Audit Remediation — Implementation Plan

## Execution Strategy

- **5 phases**, **13 worktrees**, **13 tickets**
- Phase 1: 2 parallel worktrees (SQL safety + API input validation)
- Phase 2: 2 parallel worktrees (frontend error states + worker error handling)
- Phase 3: 3 parallel worktrees (probe alerts + cron reliability + status API)
- Phase 4: 3 worktrees (test infra → worker tests + frontend tests in parallel)
- Phase 5: 2 parallel worktrees (SEO/a11y + docs/config)
- Output: code changes across worker, frontend, shared, and docs

## Dependency Graph

```
Phase 1 (SQL safety)  ─────────┐
                                ├─→ Phase 3 (cron/obs) ─→ Phase 4 (tests) ──→ done
Phase 2 (error states) ────────┘                         Phase 5 (polish) ──→ done
```

- Phases 1 & 2: **parallel** (disjoint files)
- Phase 3: **after Phase 2** (cron status uses error-propagation patterns)
- Phases 4 & 5: **parallel**, both after Phases 1-3

## Phase 1: SQL Safety & Input Validation (2 worktrees)

| Worktree | Ticket | Findings | Key Files |
|----------|--------|----------|-----------|
| `fix-sql-safety` | TICKET-001 | SEC-001→007, SCHEMA-005 | `worker/src/lib/api-utils.ts`, `worker/src/lib/db.ts`, `worker/src/api/backfill-mint-burn-prices.ts`, `worker/src/cron/compute-dews.ts`, `worker/src/api/status.ts`, `worker/src/api/health.ts`, `worker/src/handlers/scheduled.ts`, `worker/src/cron/sync-yield-data.ts`, `worker/src/cron/daily-digest.ts`, `worker/src/lib/alchemy-logs.ts`, `worker/src/lib/mint-burn-pipeline/context.ts` |
| `fix-api-input` | TICKET-002 | API-001/003/004, SEC-008/009/010/011, SCHEMA-002/006 | `worker/src/router.ts`, `worker/src/api/feedback.ts`, `worker/src/api/digest-snapshot.ts`, `worker/src/lib/api-utils.ts`, `worker/src/api/blacklist.ts`, `worker/src/api/backfill-depegs.ts` |

## Phase 2: Error-State Handling & Degraded UX (2 worktrees)

| Worktree | Ticket | Findings | Key Files |
|----------|--------|----------|-----------|
| `fix-frontend-errors` | TICKET-003 | UX-001→011, A11Y-003/004/005 | `src/app/dependency-map/client.tsx`, `src/components/digest-archive-client.tsx`, `src/components/depeg-history.tsx`, `src/components/kpi-bar.tsx`, `src/components/daily-digest.tsx`, `src/components/stablecoin-detail/safety-score-history-section.tsx`, `src/components/dews-detail.tsx`, `src/components/dews-summary.tsx`, `src/app/status/client.tsx`, `src/components/status/cache-freshness-table.tsx`, `src/components/status/circuit-breaker-table.tsx`, `src/components/status/transition-timeline.tsx`, `src/components/comparison-table.tsx`, `src/app/safety-scores/client.tsx`, `src/components/stablecoin-table.tsx`, `src/components/stress-test-panel.tsx`, `src/components/feedback-modal.tsx` |
| `fix-worker-errors` | TICKET-004 | API-002/005, CRON-006/008 | `worker/src/router.ts`, `worker/src/api/feedback.ts`, `worker/src/cron/sync-stablecoins.ts`, `worker/src/cron/sync-mint-burn.ts`, `worker/src/lib/db.ts` |

## Phase 3: Cron Reliability & Observability (3 worktrees)

| Worktree | Ticket | Findings | Key Files |
|----------|--------|----------|-----------|
| `fix-probe-alerts` | TICKET-005 | STATUS-001/002 | `worker/src/cron/status-self-check.ts`, `worker/src/lib/alerts.ts` |
| `fix-cron-reliability` | TICKET-006 | CRON-001→005/007, STATUS-003 | `worker/src/cron/sync-stablecoin-charts.ts`, `worker/src/cron/sync-blacklist.ts`, `worker/src/handlers/scheduled.ts`, `worker/src/cron/sync-stablecoins.ts`, `worker/src/cron/snapshot-supply.ts`, `worker/src/cron/sync-yield-data.ts`, `worker/wrangler.toml` |
| `fix-status-api` | TICKET-007 | STATUS-004→008, SCHEMA-003/004 | `worker/src/api/status.ts`, `worker/src/api/status-history.ts`, `worker/src/lib/constants.ts`, `src/app/status/client.tsx` |

## Phase 4: Testing Coverage (3 worktrees)

| Worktree | Ticket | Findings | Key Files |
|----------|--------|----------|-----------|
| `fix-test-infra` | TICKET-008 | TEST-004/005 | `worker/src/api/__tests__/helpers/mock-d1.ts`, `worker/src/api/__tests__/helpers/fixtures.ts` |
| `fix-worker-tests` | TICKET-009 | TEST-001/002/003/006/008/009/010 | New test files in `worker/src/cron/__tests__/`, `worker/src/lib/__tests__/`, updated files in `worker/src/api/__tests__/` |
| `fix-frontend-tests` | TICKET-010 | TEST-007/011 | New test files in `src/hooks/__tests__/`, `shared/lib/__tests__/` |

**Dependency within phase:** `fix-test-infra` must complete before `fix-worker-tests`. `fix-frontend-tests` is independent.

## Phase 5: Docs, SEO, Accessibility & Config Polish (2 worktrees)

| Worktree | Ticket | Findings | Key Files |
|----------|--------|----------|-----------|
| `fix-seo-a11y` | TICKET-011 | SEO-001/002/003, A11Y-001/002/006 | `src/lib/page-metadata.ts`, `src/app/about/page.tsx`, `src/app/stablecoin/[id]/page.tsx`, `src/app/stablecoins/[peg]/page.tsx`, `src/app/digest/[date]/page.tsx`, `src/app/privacy/page.tsx`, `src/app/methodology/changelog-page-utils.ts`, `src/app/status/page.tsx`, `src/components/command-palette.tsx`, `src/components/status/admin-key-form.tsx`, `src/components/digest-archive-client.tsx`, `src/components/coin-selector.tsx`, `src/app/page.tsx`, `src/components/site-header.tsx` |
| `fix-docs-config` | TICKET-012 | DOC-001/002/003, SCHEMA-001/007 | `docs/plans/historical/ticker-issue-migration/execution-handover.md`, `docs/process/cmcs-large-implementation-preparation.md`, `docs/worker-infrastructure.md`, `worker/wrangler.toml`, `worker/migrations/0046_*` |

## Gate Criteria

### Phase 1 → Phase 3
- `npm run lint` passes (worker)
- `cd worker && npx tsc --noEmit` passes
- All existing tests pass (`npm test`)

### Phase 2 → Phase 3
- `npm run build` passes (frontend)
- `npm run lint` passes

### Phases 1-3 → Phase 4
- All code changes merged to main
- Build + lint + type-check all pass

### All phases → Done
- `npm run build` passes
- `npm run lint` passes
- `npm test` passes
- `cd worker && npx tsc --noEmit` passes

## Migration Note

Phase 3 ticket `fix-status-api` (TICKET-007) includes a new D1 migration for composite indexes (SCHEMA-003/004). This migration should be numbered after the highest existing migration file. The ticket specifies: `worker/migrations/NNNN_audit_perf_indexes.sql`.
