# Implementation Plan: Stablecoin ID Migration to `ticker-issuer`

**Date:** 2026-03-06
**Design:** [2026-03-05-ticker-issuer-migration-design.md](./2026-03-05-ticker-issuer-migration-design.md)
**Status:** Ready for execution

## Execution Strategy

4 phases, 8 worktrees, 19 tickets. Phases are sequential gates; worktrees within a phase run in parallel via `cmcs`.

```
Phase 1 (Foundation)         → 1 worktree,  5 sequential tickets
Phase 2 (Code Migration)     → 3 worktrees, 5 tickets (parallel worktrees)
Phase 3 (ID Switchover)      → 3 worktrees, 8 tickets (parallel worktrees) + manual D1 migration
Phase 4 (Cleanup, +30 days)  → 1 worktree,  1 ticket
```

## Phase 1: Foundation (no user-visible changes)

**Worktree:** `id-migration-foundation` (sequential tickets, each depends on previous)

| Ticket | Title | Key Files |
|--------|-------|-----------|
| TICKET-001 | Add `llamaId` + `detailProvider` to StablecoinMeta | `shared/types/index.ts`, `shared/lib/stablecoins.ts` |
| TICKET-002 | Create stablecoin-id-registry.ts | `shared/lib/stablecoin-id-registry.ts` (new) |
| TICKET-003 | Create src/lib/urls.ts | `src/lib/urls.ts` (new) |
| TICKET-004 | Populate llamaId/detailProvider on all master list entries | `shared/lib/stablecoins.ts`, `shared/lib/shadow-stablecoins.ts` |
| TICKET-005 | Add tests for registry + URL helper | `shared/lib/__tests__/`, `src/lib/__tests__/` |

**Gate:** `npm run build && cd worker && npx tsc --noEmit && npm test` all pass. Merge to main.

## Phase 2: Code Migration (still using old IDs)

Three parallel worktrees — all depend on Phase 1 being merged.

### Worktree: `id-migration-worker-providers`

| Ticket | Title | Key Files |
|--------|-------|-----------|
| TICKET-001 | Replace id-prefix heuristics with detailProvider | `worker/src/cron/sync-stablecoins/supplemental-assets.ts`, `worker/src/api/stablecoin-detail.ts`, `worker/src/api/backfill-supply-history.ts` |
| TICKET-002 | Fetch stablecoin-detail by llamaId | `worker/src/api/stablecoin-detail.ts`, `worker/src/api/backfill-supply-history.ts`, `worker/src/api/backfill-depegs.ts` |

### Worktree: `id-migration-frontend-urls`

| Ticket | Title | Key Files |
|--------|-------|-----------|
| TICKET-001 | Replace inline stablecoin URLs with buildStablecoinUrl | 18 component/page files |

### Worktree: `id-migration-router-sync`

| Ticket | Title | Key Files |
|--------|-------|-----------|
| TICKET-001 | Update isValidStablecoinId to use resolver | `worker/src/lib/api-utils.ts`, `worker/src/router.ts` |
| TICKET-002 | Remap DefiLlama IDs in sync-stablecoins via registry | `worker/src/cron/sync-stablecoins.ts` |

**Gate:** All 3 worktrees pass build + worker tsc + tests. Merge to main. Old IDs still in use — behavior unchanged.

## Phase 3: ID Switchover

Three parallel worktrees + one manual step. All depend on Phase 2 being merged.

### Worktree: `id-migration-master-switchover`

| Ticket | Title | Key Files |
|--------|-------|-----------|
| TICKET-001 | Switch id values in TRACKED_STABLECOINS | `shared/lib/stablecoins.ts` |
| TICKET-002 | Switch id values in SHADOW stablecoins | `shared/lib/shadow-stablecoins.ts` |
| TICKET-003 | Re-key logos.json and ai-summaries.json | `data/logos.json`, `data/ai-summaries.json` |
| TICKET-004 | Re-key worker config maps with canonical IDs | 16 items: worker configs (`mint-burn-contracts.ts`, `yield-config.ts`, `compute-dews.ts`, `bluechip-slugs.ts`, `backfill-depegs.ts`, `stages.ts`, `router.ts`), shared (`peg-rates.ts`, `api-endpoints.ts`), frontend (`mint-burn-timeframes.ts`, `category-stats.tsx`, `total-mcap-chart.tsx`), scripts (`fetch-logos.ts`) |

### Worktree: `id-migration-test-fixtures`

| Ticket | Title | Key Files |
|--------|-------|-----------|
| TICKET-001 | Update all test fixtures to canonical IDs | `worker/src/**/__tests__/`, `src/**/__tests__/` |

### Worktree: `id-migration-frontend-compat`

| Ticket | Title | Key Files |
|--------|-------|-----------|
| TICKET-001 | Add localStorage portfolio migration + re-key MAJOR_CENTRALIZED_IDS | `src/hooks/use-portfolio.ts` |
| TICKET-002 | Add compare page ?coins= backward compat | `src/app/compare/client.tsx` |
| TICKET-003 | Generate _redirects for old URLs | `scripts/generate-redirects.ts` (new), build pipeline |

### Manual: D1 Migration (coordinated maintenance window)

**Phase 3 code and D1 migration must happen in a single ~8-minute window** to avoid any period where code and DB are out of sync. The full procedure:

1. **Before the window (can be hours ahead):** Disable crons by deploying Phase 2 code with crons commented out. Wait 15 min for propagation. Merge Phase 3 code to main with `[skip ci]` commit messages (CI auto-deploys on push — deploying before D1 migration breaks production). Backup D1. Prepare migration SQL files.
2. **Maintenance window (~5-8 min):**
   - Execute D1 migration SQL (14 tables remapped + 2 cache tables cleared)
   - Validate (0 old IDs remaining)
   - `DELETE FROM cache; DELETE FROM price_cache;`
   - Deploy Phase 3 code with crons re-enabled
3. **After window:** Run smoke tests. Wait for first cron cycle to rebuild caches.

See `tickets/phase3-master-switchover/D1-MIGRATION-RUNBOOK.md` for the step-by-step with rollback procedures.

**Gate:** All worktrees pass build + tests. D1 migration validated. Smoke tests pass. Crons rebuild caches with canonical IDs.

## Phase 4: Cleanup (30 days after Phase 3)

### Worktree: `id-migration-cleanup`

| Ticket | Title | Key Files |
|--------|-------|-----------|
| TICKET-001 | Disable allowLegacy + remove legacy support | `shared/lib/stablecoin-id-registry.ts`, `worker/src/lib/api-utils.ts`, `worker/src/router.ts`, `src/app/compare/client.tsx`, `src/hooks/use-portfolio.ts`, D1 cleanup |

**Gate:** Legacy ID request volume at zero for 7 consecutive days.

## Worktree Dispatch Summary

```
Phase 1:  cmcs worktree create id-migration-foundation
          cmcs run <worktree-path>
          cmcs wait <worktree-path>
          # Review + merge

Phase 2:  cmcs worktree create id-migration-worker-providers
          cmcs worktree create id-migration-frontend-urls
          cmcs worktree create id-migration-router-sync
          # Run all 3 in parallel
          cmcs run <path-1> & cmcs run <path-2> & cmcs run <path-3>
          # Wait + review + merge all

Phase 3:  cmcs worktree create id-migration-master-switchover
          cmcs worktree create id-migration-test-fixtures
          cmcs worktree create id-migration-frontend-compat
          # Run all 3 in parallel
          # Wait + review + merge all
          # Then: manual D1 migration + deploy

Phase 4:  cmcs worktree create id-migration-cleanup
          # 30 days later
```

## Supporting Artifacts

| Artifact | Path |
|----------|------|
| Mapping table (228 entries) | `worktrees/stablecoin-dashboard--research-id-system/DESIGN-MAPPING-TABLE.ts` |
| D1 migration SQL | `worktrees/stablecoin-dashboard--research-db-schema/DESIGN-MIGRATION-DRAFT.sql` |
| API transition plan | `worktrees/stablecoin-dashboard--research-api-routes/DESIGN-API-TRANSITION.md` |
| Frontend migration plan | `worktrees/stablecoin-dashboard--research-frontend-urls/DESIGN-FRONTEND-MIGRATION.md` |
