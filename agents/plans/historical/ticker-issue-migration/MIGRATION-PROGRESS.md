# Migration Progress Tracker

**Last updated:** 2026-03-08 (update this line after every state change)

This file is the single source of truth for migration state. Update it after every phase gate, worktree merge, or notable event. A fresh orchestrator session should read this file FIRST to know where things stand.

## Current State

**Active phase:** COMPLETE — all 4 phases deployed
**Phase 3 deploy date:** 2026-03-06
**Phase 4 deploy date:** 2026-03-08 (30-day wait overridden by user)
**Next action:** None — migration fully complete
**TODO issuers:** All 18 resolved (2026-03-06). No open items in DESIGN-MAPPING-TABLE.ts.

## Phase Checklist

### Phase 1: Foundation
- [x] Worktree `id-migration-foundation` created
- [x] Tickets copied
- [x] cmcs run started
- [x] cmcs run completed (5/5 tickets, 0 failures)
- [x] Review checklist passed (build + tsc + 1077 tests, all file/count checks)
- [x] Merged to main (commit 1c7665af)
- [x] Worktree cleaned up
- [x] Post-deploy smoke test passed

### Phase 2: Code Migration
- [x] Worktree `id-migration-worker-providers` created + tickets copied
- [x] Worktree `id-migration-frontend-urls` created + tickets copied
- [x] Worktree `id-migration-router-sync` created + tickets copied
- [x] All 3 cmcs runs started (parallel)
- [x] `id-migration-worker-providers` completed + review passed (2/2 tickets)
- [x] `id-migration-frontend-urls` completed + review passed (1/1 ticket)
- [x] `id-migration-router-sync` completed + review passed (2/2 tickets)
- [x] All 3 merged to main (no conflicts)
- [x] Worktrees cleaned up
- [x] Post-deploy smoke test passed

### Phase 3: ID Switchover
- [x] Drift detection passed (no IDs in code missing from mapping table)
- [x] Worktree `id-migration-master-switchover` created + tickets + mapping table copied (4 tickets)
- [x] Worktree `id-migration-test-fixtures` created + tickets + mapping table copied (1 ticket)
- [x] Worktree `id-migration-frontend-compat` created + tickets + mapping table copied (3 tickets)
- [x] All 3 cmcs runs started (parallel)
- [x] `id-migration-master-switchover` completed + review passed (4/4 tickets; T004 split into 5 parallel chunks after Codex timeout)
- [x] `id-migration-test-fixtures` completed + review passed (1/1 ticket)
- [x] `id-migration-frontend-compat` completed + review passed (3/3 tickets)
- [x] 12 remaining test fixture mismatches fixed post-merge
- [x] Pre-window: Crons disabled (deploy with crons commented out + `[skip ci]` commit + manual `wrangler deploy`) + 15-min wait
- [x] Pre-window: Verified no cron activity via `wrangler tail` (2+ min of silence)
- [x] All 3 merged to main with `[skip ci]` commit messages
- [x] Verified no CI workflow triggered for `[skip ci]` commits (GitHub Actions check)
- [x] Post-merge verification passed (build + tsc + 1077 tests on main, local only)
- [x] Pre-window: D1 backed up (Time Travel bookmark `00001534-00000670-00005026-f483be2f3cda2aa4455cf8edcc60d385` + SQL export `d1-backup-pre-migration.sql`)
- [x] Pre-window: D1 row count audit passed — all tables within expected bounds
- [x] Pre-window: Migration SQL files prepared and validated (6 files)
- [x] D1 maintenance window executed (2026-03-06 ~19:35-19:55 UTC)
  - [x] MAINTENANCE_MODE enabled (step 4)
  - [x] Migration SQL executed + validated (step 5) — see incident log for fixes applied
  - [x] Caches cleared (step 6) — Cloudflare edge cache purged via UI
  - [x] Phase 3 worker deployed with crons re-enabled (step 7)
  - [x] MAINTENANCE_MODE disabled (step 7)
  - [x] Pages built and deployed + CI resumed (step 8/8.5)
- [x] Post-deploy smoke test passed (step 9) — all key endpoints returning canonical IDs
- [x] Worktrees cleaned up (16 migration worktrees removed)

### Phase 4: Cleanup (30 days after Phase 3)
- [x] 30-day wait overridden by user (2026-03-08, 2 days after Phase 3)
- [x] Legacy ID compat layer removed (allowLegacy option, [legacy-id] logs, URL normalization effect)
- [x] resolveOrReject simplified (context parameter removed)
- [x] Portfolio migration switched to direct REGISTRY_BY_ID/REGISTRY_BY_LLAMA_ID lookups
- [x] Test fixtures updated from numeric IDs to canonical ticker-issuer IDs
- [x] D1 migration 0053_drop_legacy_id_support.sql created
- [x] Leftover migration-*.sql files cleaned up from root
- [x] Build + tsc + 1200 tests pass
- [x] Merged to main + pushed (commit 1ed4ac75)
- [x] D1 migration 0053 applied to production (auto-applied by CI deploy)

## Incident Log

Record any failures, retries, or unexpected events here:

```
2026-03-06 18:05 — P3-master-switchover TICKET-004 (config map re-keying, 16 items across 13 files)
  timed out during Codex execution. cmcs SQLite DB corrupted by disk I/O error
  from 3 concurrent writers. Resolution: split TICKET-004 into 5 parallel chunks
  (yield-config, mint-burn-contracts, router+api-endpoints, backfill-depegs+stages,
  misc). All 5 completed successfully. 12 additional test fixture mismatches fixed
  post-merge by sub-agent.

2026-03-06 — vitest.config.ts and tsconfig.json both missing worktrees/ exclude.
  Fixed: added "worktrees" to tsconfig.json exclude and "worktrees/**" to vitest
  test.exclude + coverage.exclude.

2026-03-06 19:35 — D1 maintenance window: 3 issues encountered and resolved:
  1. UNIQUE constraint on supply_history: one cron fired during 15-min propagation
     window, writing ~391 rows with canonical IDs alongside old-ID rows for same
     dates. Fix: added migration-03b-cleanup-dupes.sql to DELETE canonical-ID rows
     before remap (they'll be recreated by remapping old rows).
  2. migration-04-remap.sql had wrong column names for mint_burn_events and
     mint_burn_hourly (generated from assumed schemas, not actual D1 schemas).
     mint_burn_events PK is 'id' not stablecoin_id, so simple UPDATEs suffice.
     mint_burn_hourly columns: chain_id/hour_ts not chain/bucket.
     Fix: split into 04a (12 tables, UPDATEs), 04b (mint_burn_events, UPDATEs),
     04c (mint_burn_hourly, correct INSERT+DELETE).
  3. D1 UNION ALL term limit: pre/post validation queries with 14 UNION ALLs
     exceeded D1 compound SELECT limit. Fix: ran per-table spot checks instead.
  All 3 resolved without rollback. Total remap: ~1.4M rows across 14 tables.
```
