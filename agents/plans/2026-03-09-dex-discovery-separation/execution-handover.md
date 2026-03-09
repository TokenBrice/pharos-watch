# DEX Discovery Separation — Execution Handover

## What this does

Splits the monolithic DEX liquidity cron into two independent cron jobs: a **scoring cron** (30 min, existing trigger) that fetches primary sources and scores, and a **discovery cron** (20 min, existing trigger) that crawls CG/GT/DexScreener/CG Tickers and writes pool data to a staging table. The scoring cron reads the staging table and merges pools with freshness confidence decay. This gives discovery 3x more runtime budget, increasing stablecoin coverage from ~50-65% to potentially 80%+. Bumps methodology to v3.3.

## File Inventory

```
agents/plans/2026-03-09-dex-discovery-separation/
  2026-03-09-dex-discovery-separation-design.md   # Design document
  implementation-plan.md                           # Implementation plan
  execution-handover.md                            # This file
  PROGRESS.md                                      # Progress tracker
  tickets/
    phase1-discovery-module/
      TICKET-001.md   # D1 migration + shared types
      TICKET-002.md   # Discovery orchestrator + tier logic + tests
      TICKET-003.md   # Crawl sources extraction
      TICKET-004.md   # Persistence + entry point
    phase1-scoring-refactor/
      TICKET-001.md   # Strip discovery phases from scoring cron
      TICKET-002.md   # Add staging merge + confidence decay + tests
    phase2-integration/
      TICKET-001.md   # Cron registration + methodology v3.3
      TICKET-002.md   # Integration tests
      TICKET-003.md   # Documentation updates
```

## Pre-Flight Checks

Before starting execution, verify:

```bash
# Clean working tree
git status

# Main is up to date
git pull origin main

# cmcs initialized
cmcs status

# Build passes on main
npm run build && cd worker && npx tsc --noEmit && cd .. && npm test
```

## Execution Commands

### Phase 1: Two Parallel Worktrees

**Create worktrees:**

```bash
cmcs worktree create dex-discovery-module
cmcs worktree create dex-scoring-refactor
```

**Copy tickets:**

```bash
cp agents/plans/2026-03-09-dex-discovery-separation/tickets/phase1-discovery-module/TICKET-*.md worktrees/dex-discovery-module/.cmcs/tickets/
cp agents/plans/2026-03-09-dex-discovery-separation/tickets/phase1-scoring-refactor/TICKET-*.md worktrees/dex-scoring-refactor/.cmcs/tickets/
```

**Launch both in parallel:**

```bash
cmcs run worktrees/dex-discovery-module 2>&1 &
cmcs run worktrees/dex-scoring-refactor 2>&1 &
wait
```

**Monitor:**

```bash
cmcs status
cmcs logs worktrees/dex-discovery-module
cmcs logs worktrees/dex-scoring-refactor
```

### Phase 2: Integration Worktree (after Phase 1 merged)

```bash
cmcs worktree create dex-discovery-integration
cp agents/plans/2026-03-09-dex-discovery-separation/tickets/phase2-integration/TICKET-*.md worktrees/dex-discovery-integration/.cmcs/tickets/
cmcs run worktrees/dex-discovery-integration
```

## File Ownership (Phase 1 — no overlap verification)

### Worktree `dex-discovery-module` — NEW files only

- `worker/migrations/0056_dex_discovery_staging.sql` (new)
- `worker/src/cron/dex-discovery/types.ts` (new)
- `worker/src/cron/dex-discovery/orchestrator.ts` (new)
- `worker/src/cron/dex-discovery/crawl-sources.ts` (new)
- `worker/src/cron/dex-discovery/persistence.ts` (new)
- `worker/src/cron/dex-discovery/index.ts` (new)
- `worker/src/cron/dex-discovery/__tests__/orchestrator.test.ts` (new)
- May add `export` keywords to existing files: `worker/src/cron/dex-liquidity/pool-helpers.ts`, `worker/src/cron/dex-liquidity/constants.ts`, `worker/src/cron/dex-liquidity/crawl-helpers.ts` (export-only additions, no logic changes)

### Worktree `dex-scoring-refactor` — MODIFY existing files only

- `worker/src/cron/dex-liquidity/orchestrator.ts` (modify — strip phases, add staging merge call)
- `worker/src/cron/dex-liquidity/staging-merge.ts` (new — but within existing module)
- `worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts` (new)

**Overlap risk:** Both worktrees may touch `worker/src/cron/dex-liquidity/pool-helpers.ts`, `constants.ts`, or `crawl-helpers.ts` (discovery adds `export` keywords, scoring imports from them). If merge conflicts occur in these files, accept all `export` keyword additions from `dex-discovery-module` and all import/call-site changes from `dex-scoring-refactor`. These are additive changes on both sides — no conflicting logic.

## Review Checklists

### Phase 1 — discovery-module Review

```bash
cd worktrees/dex-discovery-module

# Build passes
npm run build && cd worker && npx tsc --noEmit && cd ../.. && npm test

# Migration file exists
ls worker/migrations/*dex_discovery_staging*

# New module exists with all files
ls worker/src/cron/dex-discovery/{types,orchestrator,crawl-sources,persistence,index}.ts

# Tests exist and pass
npm test -- --run worker/src/cron/dex-discovery/__tests__/orchestrator.test.ts

# Types are properly exported
grep -c "export interface StagedPool" worker/src/cron/dex-discovery/types.ts
grep -c "export function stagedPoolConfidence" worker/src/cron/dex-discovery/types.ts
grep -c "export const DISCOVERY_TIERS" worker/src/cron/dex-discovery/types.ts

# Orchestrator exports key functions
grep -c "export async function syncDexDiscovery" worker/src/cron/dex-discovery/orchestrator.ts
grep -c "export function computeEffectiveTier" worker/src/cron/dex-discovery/orchestrator.ts

# Crawl sources reuse existing helpers (no duplication)
grep -c "from.*dex-liquidity" worker/src/cron/dex-discovery/crawl-sources.ts  # should be >= 3

# Entry point re-exports
grep -c "syncDexDiscovery" worker/src/cron/dex-discovery/index.ts

# Lint passes
npm run lint
```

### Phase 1 — scoring-refactor Review

```bash
cd worktrees/dex-scoring-refactor

# Build passes
npm run build && cd worker && npx tsc --noEmit && cd ../.. && npm test

# Discovery phases stripped
grep -c "hasOptionalBudget" worker/src/cron/dex-liquidity/orchestrator.ts          # 0
grep -c "OPTIONAL_DISCOVERY_BUDGET_MS" worker/src/cron/dex-liquidity/orchestrator.ts # 0
grep -c "fetchCgPools" worker/src/cron/dex-liquidity/orchestrator.ts               # 0
grep -c "fetchGtPools" worker/src/cron/dex-liquidity/orchestrator.ts               # 0
grep -c "fetchDsFallbackPools" worker/src/cron/dex-liquidity/orchestrator.ts       # 0
grep -c "fetchCgTickersFallback" worker/src/cron/dex-liquidity/orchestrator.ts     # 0
grep -c "mergeCgPools" worker/src/cron/dex-liquidity/orchestrator.ts               # 0

# Primary sources still present
grep -c "fetchDataSources" worker/src/cron/dex-liquidity/orchestrator.ts           # >= 1
grep -c "fetchUniV3Data" worker/src/cron/dex-liquidity/orchestrator.ts             # >= 1
grep -c "computeStablecoinScores" worker/src/cron/dex-liquidity/orchestrator.ts    # >= 1

# Staging merge added
grep -c "mergeStagedPools" worker/src/cron/dex-liquidity/orchestrator.ts           # >= 1
ls worker/src/cron/dex-liquidity/staging-merge.ts

# Tests exist and pass
npm test -- --run worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts

# Lint passes
npm run lint
```

### Phase 2 — integration Review

```bash
cd worktrees/dex-discovery-integration

# Build passes
npm run build && cd worker && npx tsc --noEmit && cd ../.. && npm test

# Cron registered
grep -c "syncDexDiscovery" worker/src/handlers/scheduled.ts               # >= 1
grep -c "sync-dex-discovery" worker/src/lib/cron-schedule.ts              # >= 1

# Uses ctx.waitUntil (parallel, not chained)
grep "ctx.waitUntil" worker/src/handlers/scheduled.ts | grep -c "syncDexDiscovery"  # >= 1

# Methodology bumped
grep -c '"3.3"' shared/lib/liquidity-score-version.ts                     # >= 1

# Docs updated
grep -c "Discovery Cron" docs/dex-liquidity.md                           # >= 1
grep -c "dex_pool_staging" docs/dex-liquidity.md                          # >= 1
grep -c "sync-dex-discovery" docs/worker-infrastructure.md                # >= 1
grep -c "3.3" docs/methodology-page.md                                    # >= 1
grep -c "dex_pool_staging" docs/data-flow-map.md                          # >= 1

# Old references cleaned
grep -c "OPTIONAL_DISCOVERY_BUDGET_MS" docs/dex-liquidity.md              # 0

# All tests pass
npm test

# Lint passes
npm run lint
```

## Merge Instructions

### Phase 1 Merge Order

**Order is mandatory:** `dex-discovery-module` MUST merge first because `dex-scoring-refactor` imports `StagedPool`, `stagedPoolConfidence`, `stagedPoolMaturityDays`, and `STAGED_POOL_DEFAULTS` from `worker/src/cron/dex-discovery/types.ts` (created by the discovery module). Merging in reverse order will fail the build.

1. Merge `dex-discovery-module` first (all new files, no conflicts expected)
2. Merge `dex-scoring-refactor` second (modifies existing files, imports from discovery module)
3. If conflicts on `pool-helpers.ts`, `constants.ts`, or `crawl-helpers.ts`: accept all `export` additions from discovery-module and all import changes from scoring-refactor

```bash
# After review passes:
cd worktrees/dex-discovery-module && git push origin dex-discovery-module
# Create PR, merge to main

git checkout main && git pull origin main

cd worktrees/dex-scoring-refactor && git rebase main
# Resolve any conflicts (export additions in pool-helpers.ts)
git push origin dex-scoring-refactor
# Create PR, merge to main
```

### Phase 2 Merge

Single worktree, straightforward merge after Phase 1 is on main.

```bash
cd worktrees/dex-discovery-integration && git rebase main
git push origin dex-discovery-integration
# Create PR, merge to main
```

## Post-Phase-1 Smoke Tests

After Phase 1 merge + D1 migration, verify the scoring cron works with the stripped orchestrator:

```bash
# Tables created
npx wrangler d1 execute stablecoin-db --remote --command="SELECT name FROM sqlite_master WHERE type='table' AND name IN ('dex_pool_staging', 'dex_discovery_meta', 'kv_config')"
# Expected: all three table names

# Wait for next :10/:40 trigger, then check scoring cron still works
curl -s "https://api.pharos.watch/api/status" | jq '.crons["sync-dex-liquidity"]'
# Expected: recent lastRun, status "ok"

# Coverage hasn't regressed (scoring with empty staging = primary-only)
curl -s "https://api.pharos.watch/api/dex-liquidity" | jq '[to_entries[] | select(.value.liquidityScore != null)] | length'
# Expected: >= previous count (primary sources still cover ~80-100 coins)

# Staging merge returns zero (no discovery data yet)
curl -s "https://api.pharos.watch/api/dex-liquidity" | jq 'to_entries[0].value.methodologyVersion'
# Expected: still "3.2" until Phase 2 bumps to "3.3"
```

## Post-Deploy: D1 Migration

**Run BEFORE deploying Phase 1 code** to avoid "no such table" errors. The migration uses `CREATE TABLE IF NOT EXISTS` so it's safe to run early. The `mergeStagedPools` function in the scoring cron also has a try/catch for the table-not-found case as a safety net, but running the migration first is the clean path.

Note: This project uses manual migration execution (`--file`), not `wrangler d1 migrations apply`.

```bash
cd worker
npx wrangler d1 execute stablecoin-db --remote --file=migrations/0056_dex_discovery_staging.sql
```

Verify tables created:

```bash
npx wrangler d1 execute stablecoin-db --remote --command="SELECT name FROM sqlite_master WHERE type='table' AND name IN ('dex_pool_staging', 'dex_discovery_meta')"
```

Expected: both table names returned.

**Note:** The scoring cron's `mergeStagedPools()` has a try/catch that handles both empty tables and missing tables (pre-migration). So deploying the scoring refactor before the discovery cron is active is safe — it just won't merge any staged pools until discovery starts writing.

## Post-Deploy Smoke Tests

After Phase 2 is deployed and the next 20-min cron fires:

```bash
# Check discovery cron ran
curl -s "https://api.pharos.watch/api/status" | jq '.crons["sync-dex-discovery"]'
# Expected: recent lastRun timestamp, status "ok" or "degraded"

# Check staging table has rows
# (via wrangler or admin endpoint)
npx wrangler d1 execute stablecoin-db --remote --command="SELECT COUNT(*) as cnt FROM dex_pool_staging"
# Expected: cnt > 0 after first discovery run

# Check discovery meta has rows
npx wrangler d1 execute stablecoin-db --remote --command="SELECT COUNT(*) as cnt, SUM(CASE WHEN consecutive_misses = 0 THEN 1 ELSE 0 END) as with_pools FROM dex_discovery_meta"
# Expected: cnt > 0, with_pools > 0

# Check scoring cron still works (next 30-min trigger)
curl -s "https://api.pharos.watch/api/dex-liquidity" | jq 'to_entries | length'
# Expected: same or more entries than before deploy

# Check methodology version bumped
curl -s "https://api.pharos.watch/api/dex-liquidity" | jq 'to_entries[0].value.methodologyVersion'
# Expected: "3.3"

# Check coverage hasn't regressed
curl -s "https://api.pharos.watch/api/dex-liquidity" | jq '[to_entries[] | select(.value.liquidityScore != null)] | length'
# Expected: >= previous count (was ~80-100)
```

## Rollback Procedures

### Phase 1 Rollback

If scoring cron breaks after merge:

```bash
# Git revert the merge commits
git revert <scoring-refactor-merge-commit> --no-edit
git revert <discovery-module-merge-commit> --no-edit
git push origin main

# The D1 migration tables are harmless (empty, unused) — no need to drop them
# But if needed:
npx wrangler d1 execute stablecoin-db --remote --command="DROP TABLE IF EXISTS dex_pool_staging; DROP TABLE IF EXISTS dex_discovery_meta;"
```

### Phase 2 Rollback

If discovery cron causes issues on the 20-min trigger:

```bash
# Git revert the integration merge commit
git revert <integration-merge-commit> --no-edit
git push origin main

# Discovery cron stops running, scoring cron falls back to primary-only
# (staging table still exists but no longer populated — merge reads 0 rows)
```

### Emergency: D1 Time Travel

If data corruption occurs:

```bash
npx wrangler d1 time-travel info stablecoin-db
# Note the bookmark before the issue
npx wrangler d1 time-travel restore stablecoin-db --bookmark=<pre-deploy-bookmark>
```

## Known Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Discovery cron exceeds 6-connection pool | Medium | Discovery is strictly sequential (1 connection). Total worst case: blacklist(3) + mint-burn(2) + discovery(1) = 6. |
| Staging table grows unbounded | Low | Cleanup phase deletes rows >48h old, nulls raw_json >6h old. |
| Confidence decay changes scores vs v3.2 | Expected | This is a methodology change (v3.3). Scores may shift slightly as staged pools fade with age. |
| CG pool crawl export additions conflict with scoring refactor | Low | Export-only changes (adding `export` keyword). Resolve by taking both sides. |
| Discovery cron fails consistently | Low | Returns `degraded` status. Scoring cron falls back to primary-only (same as pre-change behavior). No regression. |
| kv_config table doesn't exist | Low | `incrementRunSeq` creates it with `CREATE TABLE IF NOT EXISTS`. |

## Orchestrator Protocol

1. Update PROGRESS.md immediately after every state change
2. Create worktrees -> copy tickets -> launch runs
3. Wait for completion, check logs for failures
4. Run review checklist for each worktree
5. If tickets failed: read logs, fix ticket or code, re-run
6. Merge in documented order
7. Run D1 migration
8. Run post-deploy smoke tests
9. Proceed to next phase

## When Codex Fails

1. `cmcs logs <worktree>` — identify which ticket failed
2. Read the agent's output — what went wrong?
3. Common fixes:
   - **Import not found**: Missing export in source file — add it manually or fix the ticket
   - **Type error**: Interface mismatch — check types.ts matches actual usage
   - **Test failure**: Adjust test expectations or fix implementation
4. Fix the issue in the worktree, then `cmcs run <worktree>` to re-run remaining tickets

## Drift Detection

If the project spans multiple sessions, check for codebase changes since the plan was written:

```bash
git log --oneline --since="2026-03-09" -- worker/src/cron/dex-liquidity/ worker/src/handlers/scheduled.ts worker/src/lib/cron-schedule.ts shared/lib/liquidity-score-version.ts worker/src/lib/chain-registry.ts worker/src/lib/rate-limit.ts worker/src/lib/abort.ts
```

If any relevant files changed, review the changes and update tickets if needed before continuing.

## After Context Compaction

1. Read `agents/plans/2026-03-09-dex-discovery-separation/PROGRESS.md` — see current state
2. Read this file (`execution-handover.md`) — pick up where progress says
3. Run drift detection commands above
4. Run pre-flight checks before resuming
