# Execution Handover: Stablecoin ID Migration

**Prepared:** 2026-03-06
**Status:** Ready for execution in a future session

This document contains everything a fresh Claude orchestrator session needs to execute the ticker-issuer ID migration via cmcs without re-reading the full design or re-discovering the codebase.

---

## What this migration does

Replaces all internal stablecoin identifiers from legacy formats (`"1"`, `"cg-ustb"`, `"gold-xaut"`) with canonical `ticker-issuer` format (`"usdt-tether"`, `"ustb-superstate"`, `"xaut-tether"`). Touches types, 3 master lists (228 entries), 14 DB tables (+ 2 cache tables cleared), 16 hardcoded-ID locations (worker configs, shared modules, frontend components, scripts), 18 frontend URL files (~30 callsites), 2 static data files, ~50+ test files, and the API router.

## File inventory

```
docs/plans/ticker-issue-migration/
  MIGRATION-PROGRESS.md                           ← CURRENT STATE (read this first after compaction)
  execution-handover.md                           ← THIS FILE (commands + orchestrator protocol)
  2026-03-05-ticker-issuer-migration-design.md   ← Full design (read if you need "why" context)
  implementation-plan.md                          ← Phase/worktree/ticket structure
  tickets/
    phase1-foundation/          TICKET-001..005   (sequential, 1 worktree)
    phase2-worker-providers/    TICKET-001..002   (sequential, parallel with P2b/P2c)
    phase2-frontend-urls/       TICKET-001        (single, parallel with P2a/P2c)
    phase2-router-sync/         TICKET-001..002   (sequential, parallel with P2a/P2b)
    phase3-master-switchover/   TICKET-001..004 + D1-MIGRATION-RUNBOOK.md
    phase3-test-fixtures/       TICKET-001        (single, parallel with P3a/P3c)
    phase3-frontend-compat/     TICKET-001..003   (sequential, parallel with P3a/P3b)
    phase4-cleanup/             TICKET-001        (30 days later)

worktrees/
  stablecoin-dashboard--research-id-system/   DESIGN-MAPPING-TABLE.ts   (228 old→new ID pairs)
  stablecoin-dashboard--research-db-schema/   DESIGN-MIGRATION-DRAFT.sql (14-table remap SQL + 2 cache clears)
  stablecoin-dashboard--research-api-routes/  DESIGN-API-TRANSITION.md
  stablecoin-dashboard--research-frontend-urls/ DESIGN-FRONTEND-MIGRATION.md
```

## Execution commands — copy-paste per phase

### Phase 1: Foundation

```bash
# Create worktree and copy tickets
/home/ahirice/.local/bin/cmcs worktree create id-migration-foundation
# Copy tickets into the worktree
cp docs/plans/ticker-issue-migration/tickets/phase1-foundation/TICKET-*.md \
   worktrees/id-migration-foundation/.cmcs/tickets/

# Run Codex
/home/ahirice/.local/bin/cmcs run worktrees/id-migration-foundation

# Wait for completion
/home/ahirice/.local/bin/cmcs wait worktrees/id-migration-foundation

# Check logs (cmcs logs may not find artifacts; if empty, read directly)
/home/ahirice/.local/bin/cmcs logs worktrees/id-migration-foundation
# Fallback: cat worktrees/id-migration-foundation/.cmcs/logs/*/*.stdout
```

**Review checklist (run manually after Codex finishes):**
```bash
cd worktrees/id-migration-foundation
npm run build
cd worker && npx tsc --noEmit && cd ..
npm test
# Verify new files exist:
ls shared/lib/stablecoin-id-registry.ts src/lib/urls.ts
# Verify registry exports:
grep -c 'resolveByExternalId' shared/lib/stablecoin-id-registry.ts  # expect 2+
grep -c 'REGISTRY_BY_CMC_SLUG' shared/lib/stablecoin-id-registry.ts # expect 2+
# Verify llamaId populated:
grep -c 'llamaId:' shared/lib/stablecoins.ts    # expect 129
grep -c 'detailProvider:' shared/lib/stablecoins.ts  # expect 148
```

**Merge to main after review passes.** Then delete the worktree.

**Rollback (if production breaks after deploy):**
```bash
git revert HEAD --no-edit   # revert the single Phase 1 merge commit
cd worker && npx wrangler deploy && cd ..
# Phase 1 only adds new files + fields — revert is safe, no data loss
```

### Phase 2: Code Migration (3 parallel worktrees)

```bash
# Create all 3 worktrees
/home/ahirice/.local/bin/cmcs worktree create id-migration-worker-providers
/home/ahirice/.local/bin/cmcs worktree create id-migration-frontend-urls
/home/ahirice/.local/bin/cmcs worktree create id-migration-router-sync

# Copy tickets
cp docs/plans/ticker-issue-migration/tickets/phase2-worker-providers/TICKET-*.md \
   worktrees/id-migration-worker-providers/.cmcs/tickets/
cp docs/plans/ticker-issue-migration/tickets/phase2-frontend-urls/TICKET-*.md \
   worktrees/id-migration-frontend-urls/.cmcs/tickets/
cp docs/plans/ticker-issue-migration/tickets/phase2-router-sync/TICKET-*.md \
   worktrees/id-migration-router-sync/.cmcs/tickets/

# Run all 3 in parallel
/home/ahirice/.local/bin/cmcs run worktrees/id-migration-worker-providers &
/home/ahirice/.local/bin/cmcs run worktrees/id-migration-frontend-urls &
/home/ahirice/.local/bin/cmcs run worktrees/id-migration-router-sync &
wait
```

**Review checklist per worktree (run build + tsc + test in each before merging):**
```bash
# All 3 worktrees — must pass:
cd worktrees/id-migration-worker-providers && npm run build && cd worker && npx tsc --noEmit && cd .. && npm test && cd ../..
cd worktrees/id-migration-frontend-urls && npm run build && npm test && cd ../..
cd worktrees/id-migration-router-sync && npm run build && cd worker && npx tsc --noEmit && cd .. && npm test && cd ../..

# Worker providers — spot checks (run from worktree dir):
cd worktrees/id-migration-worker-providers
grep -rn 'startsWith("cg-")' worker/src/ --include="*.ts" | grep -v __tests__  # expect 0
grep -F 'gold-|silver-|cg-' worker/src/api/backfill-supply-history.ts  # expect 0
cd ../..

# Frontend URLs (run from worktree dir):
cd worktrees/id-migration-frontend-urls
grep -rn '/stablecoin/\${' src/ --include="*.ts" --include="*.tsx" | grep -v __tests__ | grep -v '/api/stablecoin'  # expect 0
cd ../..

# Router sync (run from worktree dir):
cd worktrees/id-migration-router-sync
grep -F '/^\d+$/' worker/src/lib/api-utils.ts  # expect 0 (old regex gone)
cd ../..
```

**Merge all 3 to main.** Behavior is still unchanged — old IDs are in use.

**Rollback (if production breaks after deploy):**
```bash
# Revert all 3 Phase 2 merge commits (adjust count if squashed)
git log --oneline -5  # identify the 3 merge commits
git revert --no-commit HEAD~2..HEAD && git commit -m "revert: Phase 2 merge (production issue)"
cd worker && npx wrangler deploy && cd ..
# Phase 2 only changes code paths (detailProvider, URL helpers, router logic) — no data changes
```

### Phase 3: ID Switchover (3 parallel worktrees + manual D1)

**Pre-flight: Run drift detection before creating Phase 3 worktrees.** If stablecoins were added since Phase 2, they need mapping table entries before proceeding.
```bash
# Drift detection: find IDs in code but missing from the mapping table
grep -oP '(?:usd|eur|other)\("[^"]+' shared/lib/stablecoins.ts | sed 's/.*("//' | sort > /tmp/code-ids.txt
grep -oP 'oldId: "[^"]+' worktrees/stablecoin-dashboard--research-id-system/DESIGN-MAPPING-TABLE.ts | sed 's/oldId: "//' | sort > /tmp/map-ids.txt
DRIFT=$(comm -23 /tmp/code-ids.txt /tmp/map-ids.txt)
if [ -n "$DRIFT" ]; then
  echo "BLOCKING: These IDs are in code but not in the mapping table:"
  echo "$DRIFT"
  echo "Add them to DESIGN-MAPPING-TABLE.ts before proceeding."
else
  echo "OK: All code IDs are covered by the mapping table."
fi
```

```bash
# Create worktrees
/home/ahirice/.local/bin/cmcs worktree create id-migration-master-switchover
/home/ahirice/.local/bin/cmcs worktree create id-migration-test-fixtures
/home/ahirice/.local/bin/cmcs worktree create id-migration-frontend-compat

# Copy tickets (exclude the runbook from cmcs — it's for humans)
cp docs/plans/ticker-issue-migration/tickets/phase3-master-switchover/TICKET-*.md \
   worktrees/id-migration-master-switchover/.cmcs/tickets/
cp docs/plans/ticker-issue-migration/tickets/phase3-test-fixtures/TICKET-*.md \
   worktrees/id-migration-test-fixtures/.cmcs/tickets/
cp docs/plans/ticker-issue-migration/tickets/phase3-frontend-compat/TICKET-*.md \
   worktrees/id-migration-frontend-compat/.cmcs/tickets/

# Copy mapping table into each Phase 3 worktree (Codex runs from worktree cwd,
# so the original path under worktrees/stablecoin-dashboard--research-*/ is unreachable)
for wt in id-migration-master-switchover id-migration-test-fixtures id-migration-frontend-compat; do
  cp worktrees/stablecoin-dashboard--research-id-system/DESIGN-MAPPING-TABLE.ts \
     worktrees/$wt/DESIGN-MAPPING-TABLE.ts
done

# Run all 3 in parallel
/home/ahirice/.local/bin/cmcs run worktrees/id-migration-master-switchover &
/home/ahirice/.local/bin/cmcs run worktrees/id-migration-test-fixtures &
/home/ahirice/.local/bin/cmcs run worktrees/id-migration-frontend-compat &
wait
```

**Review checklist (run from each worktree directory):**
```bash
# Master switchover:
cd worktrees/id-migration-master-switchover
npm run build && cd worker && npx tsc --noEmit && cd .. && npm test
grep '^  usd("[0-9]' shared/lib/stablecoins.ts        # expect 0 (no numeric IDs left)
grep '"usdt-tether"' shared/lib/stablecoins.ts          # expect 1+
grep 'stablecoinId: "1"' worker/src/lib/mint-burn-contracts.ts  # expect 0
grep '"gold-dgld"' shared/lib/peg-rates.ts              # expect 0
grep 'stablecoin=1' shared/lib/api-endpoints.ts          # expect 0 (probePath query params migrated; path values for /api/stablecoin/1 intentionally kept)
cd ../..

# Test fixtures:
cd worktrees/id-migration-test-fixtures
npm run build && npm test  # all green
cd ../..

# Frontend compat:
cd worktrees/id-migration-frontend-compat
npm run build && npm test
grep 'migratePortfolioIds\|resolveStablecoinId' src/hooks/use-portfolio.ts  # expect matches
cd ../..
```

**Merge all 3 to main using `[skip ci]` commit messages. DO NOT push without `[skip ci]`.** The CI pipeline auto-deploys on push to main — deploying Phase 3 code before D1 migration would break production. See the D1 runbook for the full procedure.

```bash
git merge id-migration-master-switchover --no-ff -m "[skip ci] merge: Phase 3 master switchover"
git merge id-migration-test-fixtures --no-ff -m "[skip ci] merge: Phase 3 test fixtures"
git merge id-migration-frontend-compat --no-ff -m "[skip ci] merge: Phase 3 frontend compat"
git push origin main
# Verify: NO GitHub Actions workflow triggered for these commits
```

#### Phase 3 deploy sequence (maintenance window)

The D1 migration and Phase 3 code deploy are coordinated in a ~5-8 minute maintenance window to avoid any period where code and DB are out of sync. See `tickets/phase3-master-switchover/D1-MIGRATION-RUNBOOK.md` for the full step-by-step, but the high-level sequence is:

1. **Before the window:** Disable crons (deploy Phase 2 code with crons commented out). Wait 15 min. Merge Phase 3 code to main with `[skip ci]`. Save D1 Time Travel bookmark + SQL export. Prepare migration SQL files. **IMPORTANT:** `[skip ci]` only suppresses push-triggered CI — the scheduled 8:15 UTC cron runs regardless. Start after 08:30 UTC and complete the full window before the next 08:15 UTC.
2. **Maintenance window starts (~5-8 min):**
   - Enable MAINTENANCE_MODE (clean 503s instead of broken responses)
   - Execute D1 migration SQL (batched per stablecoin_id — 3 tables exceed 80K rows)
   - Clear caches
   - Deploy Phase 3 worker via gradual deployment (`wrangler versions upload` + `wrangler versions deploy`) — provides instant rollback via `wrangler rollback`
   - Disable MAINTENANCE_MODE
   - Push to git with `[skip ci]` (saves wrangler.toml but doesn't trigger CI — caches are empty, smoke-api would fail)
3. **Window ends:** Wait for first cron cycle (~15 min) to rebuild caches. Verify `/api/stablecoins` returns data. Build and deploy Pages manually. Run smoke tests.
4. **Resume CI:** Push empty commit without `[skip ci]` to trigger full CI pipeline (validates everything end-to-end).
5. **Rollback (if needed):** `wrangler d1 time-travel restore --bookmark=SAVED` (instant D1 rollback) + `wrangler rollback` (instant Worker rollback, only valid before CI redeploys in step 4) + rollback Pages deployment via Cloudflare dashboard (Pages → Deployments → select previous → "Rollback to this deployment"). See runbook for details.

### Phase 4: Cleanup (30 days later)

```bash
/home/ahirice/.local/bin/cmcs worktree create id-migration-cleanup
cp docs/plans/ticker-issue-migration/tickets/phase4-cleanup/TICKET-*.md \
   worktrees/id-migration-cleanup/.cmcs/tickets/
/home/ahirice/.local/bin/cmcs run worktrees/id-migration-cleanup
```

**Only execute after:** legacy ID request volume at zero for 7+ consecutive days. Verify by checking for `[legacy-id]` log entries via `wrangler tail` or Workers Analytics — see "Legacy ID monitoring" section below.

## Merge order for parallel worktrees

Parallel worktrees within a phase are designed to touch non-overlapping files. But verify before merging:

### Phase 2 (no expected conflicts)

| Worktree | Files modified |
|----------|---------------|
| P2-worker-providers | `worker/src/cron/sync-stablecoins/supplemental-assets.ts`, `worker/src/api/stablecoin-detail.ts`, `worker/src/api/backfill-supply-history.ts`, `worker/src/api/backfill-depegs.ts` |
| P2-frontend-urls | 18 files under `src/components/` and `src/app/` |
| P2-router-sync | `worker/src/lib/api-utils.ts`, `worker/src/router.ts`, `worker/src/cron/sync-stablecoins.ts` |

**Merge order:** Any order. No file overlap.

### Phase 3 (one resolved conflict)

| Worktree | Files modified |
|----------|---------------|
| P3-master-switchover | `shared/lib/stablecoins.ts`, `shared/lib/shadow-stablecoins.ts`, `data/logos.json`, `data/ai-summaries.json`, worker config maps (7 files), `shared/lib/peg-rates.ts`, `shared/lib/api-endpoints.ts`, `src/lib/mint-burn-timeframes.ts`, `src/components/category-stats.tsx`, `src/components/total-mcap-chart.tsx`, `scripts/fetch-logos.ts` |
| P3-test-fixtures | `**/__tests__/**` only |
| P3-frontend-compat | `src/hooks/use-portfolio.ts`, `src/app/compare/client.tsx`, `scripts/generate-redirects.ts` (new) |

**Merge order:** Any order. `MAJOR_CENTRALIZED_IDS` re-keying has been moved from P3-master-switchover to P3-frontend-compat to avoid both worktrees modifying `src/hooks/use-portfolio.ts`.

**Important:** Run the post-merge verification only after ALL three Phase 3 worktrees are merged. Individual merges will temporarily break tests (e.g., test fixtures expect canonical IDs but code still has legacy, or vice versa). This is expected — merge all three in quick succession, then verify.

**Post-merge verification (after all 3 are merged):**
```bash
npm run build && cd worker && npx tsc --noEmit && cd .. && npm test
```

## Post-deploy smoke tests

Run these after each phase merge + deploy, and after the D1 maintenance window. The curl commands test runtime behavior, not just code text.

### After Phase 1 deploy
```bash
# Site still works with old IDs (no user-visible changes)
curl -sf "https://api.pharos.watch/api/stablecoins" | jq '.peggedAssets | length'  # expect 148
curl -sf "https://api.pharos.watch/api/stablecoin/1" | jq '.symbol'               # expect "USDT"
curl -sf "https://api.pharos.watch/api/health" | jq '.status'                      # expect "ok"
```

### After Phase 2 deploy
```bash
# Same as Phase 1 — behavior unchanged, old IDs still in use
curl -sf "https://api.pharos.watch/api/stablecoins" | jq '.peggedAssets | length'  # expect 148
curl -sf "https://api.pharos.watch/api/stablecoin/1" | jq '.symbol'               # expect "USDT"
curl -sf "https://api.pharos.watch/api/supply-history?stablecoin=1&days=7" | jq 'length'  # expect > 0
```

### After Phase 3 + D1 maintenance window
```bash
# Core endpoints with canonical IDs
curl -sf "https://api.pharos.watch/api/stablecoins" | jq '.peggedAssets | length'              # expect 148
curl -sf "https://api.pharos.watch/api/stablecoin/usdt-tether" | jq '.symbol'                 # expect "USDT"
curl -sf "https://api.pharos.watch/api/stablecoin/usdc-circle" | jq '.symbol'                 # expect "USDC"
curl -sf "https://api.pharos.watch/api/peg-summary" | jq '.summary | length'                  # expect > 0

# Legacy IDs still work (allowLegacy)
curl -sf "https://api.pharos.watch/api/stablecoin/1" | jq '.symbol'                           # expect "USDT"

# History endpoints (verify D1 queries work with canonical IDs)
curl -sf "https://api.pharos.watch/api/supply-history?stablecoin=usdt-tether&days=7" | jq 'length'         # expect > 0
curl -sf "https://api.pharos.watch/api/dex-liquidity-history?stablecoin=usdt-tether&days=7" | jq 'length'  # expect > 0
curl -sf "https://api.pharos.watch/api/yield-history?stablecoin=usdt-tether&days=7" | jq 'length'          # expect >= 0

# D1-dependent endpoints that also have stablecoin_id columns (catch missed tables)
curl -sf "https://api.pharos.watch/api/dex-liquidity" | jq 'length'                           # expect > 0
curl -sf "https://api.pharos.watch/api/stablecoin-summary/usdt-tether" | jq '.symbol'         # expect "USDT"
curl -sf "https://api.pharos.watch/api/depeg-events" | jq 'length'                            # expect >= 0
curl -sf "https://api.pharos.watch/api/mint-burn-events?stablecoin=usdt-tether" | jq 'length'  # expect >= 0
curl -sf "https://api.pharos.watch/api/stress-signals?stablecoin=usdt-tether" | jq '.score'    # expect number or null
curl -sf "https://api.pharos.watch/api/safety-score-history?stablecoin=usdt-tether" | jq 'length'  # expect >= 0

# Frontend redirects
curl -sI "https://pharos.watch/stablecoin/usdt-tether/" | head -1                             # expect 200
curl -sI "https://pharos.watch/stablecoin/1/" | grep -i location                              # expect 301 → /stablecoin/usdt-tether/

# Health
curl -sf "https://api.pharos.watch/api/health" | jq '.status'                                 # expect "ok"
```

## Legacy ID monitoring (Phase 4 readiness)

After Phase 3 deploy, the router logs `[legacy-id]` whenever a legacy ID is resolved via `allowLegacy`. Monitor this to determine when Phase 4 cleanup is safe:

```bash
# Check recent legacy ID usage via wrangler tail
npx wrangler tail --format=json | grep '\[legacy-id\]'

# Or query Workers Analytics for the [legacy-id] log pattern
# When zero hits for 7 consecutive days → Phase 4 is safe
```

## Known risks and mitigations

| Risk | Mitigation |
|------|------------|
| Codex produces wrong ID mapping | Every ticket references `DESIGN-MAPPING-TABLE.ts` — review diffs against it |
| Build breaks across worktree merge | Phases are sequential gates — never merge P2 before P1 passes |
| D1 migration fails mid-way | D1 Time Travel bookmark saved before migration — `wrangler d1 time-travel restore --bookmark=SAVED` provides instant rollback (seconds). SQL export as secondary fallback |
| `wrangler d1 execute --file` partial failure | File execution has no documented full-file atomicity guarantee. Time Travel bookmark is the safety net for partial failures — restores entire DB to pre-migration state |
| D1 per-statement 30s timeout on large tables | Migration SQL uses per-stablecoin-id batched statements (not single bulk operations). Three tables exceed 80K rows: mint_burn_events (~1M), mint_burn_hourly (~630K), supply_history (~225K) |
| D1 does not support explicit transactions | Do NOT use `BEGIN`/`COMMIT` in migration SQL — D1 errors with "cannot start a transaction within a transaction". Atomicity comes from D1's implicit transaction wrapping |
| Code-DB timing gap during deploy | D1 migration and code deploy happen in a single ~8-min maintenance window; MAINTENANCE_MODE secret shows clean 503 during gap (see runbook) |
| Worker deploy breaks production | Gradual deployments (`wrangler versions upload/deploy`) enable instant rollback via `wrangler rollback` — no need to redeploy old code |
| User portfolios lost | `migratePortfolioIds()` is idempotent — re-runs are safe |
| SEO ranking drop | `_redirects` file provides 301s for all old URLs indefinitely |
| Missed hardcoded ID | `allowLegacy: true` catches stragglers during 30-day window |
| CI auto-deploys Phase 3 before D1 migration | All Phase 3 merge commits use `[skip ci]`; worker + Pages deployed manually during maintenance window |
| CI smoke-api fails due to empty caches | Step 7 pushes with `[skip ci]`; CI only triggered in step 8.5 after caches rebuild (~15 min post-deploy) |
| `wrangler rollback` window closes after CI redeploys | Save Phase 2 version ID in step 7; after CI runs, use `wrangler versions deploy <phase2-id>` for explicit rollback |
| Cron runs during D1 migration | 15-min wait after disabling crons; `wrangler tail` verification |
| `_redirects` overwritten | Script appends after separator, idempotent on re-run |
| Can't measure Phase 4 readiness | `[legacy-id]` structured logging in router tracks every legacy request |
| Parallel worktrees conflict on merge | File ownership per worktree documented; `use-portfolio.ts` consolidated into P3-frontend-compat |
| Codex times out or fails mid-ticket | cmcs stops on failure; completed tickets have `done: true` and are skipped on re-run. Re-run `cmcs run <worktree>` to resume from the failed ticket |
| New stablecoins added between phases | Drift detection script (see "Open items" section) catches IDs in code but missing from mapping table |
| Test fixture staleness between phases | Run `npm test` in each worktree before merging; P3-test-fixtures covers all test files |
| `daily_digest.input_data` contains legacy IDs | Accepted as historical artifact — field is debug-only (never served to frontend), `content` column uses ticker symbols. Future digests auto-use canonical IDs post-migration |
| Backfill endpoints call DL with `meta.id` | Fixed: P2-TICKET-002 now covers `backfill-supply-history.ts` and `backfill-depegs.ts` (use `meta.llamaId` for DL fetch, keep `meta.id` for D1 writes) |
| Backfill-depegs has hardcoded legacy IDs | Fixed: P3-TICKET-004 now covers `OTHER_COIN_FX` (re-key `"289"`, `"122"`, `"165"`) and `CG_ABOVE_PEG_EXCLUSIONS` (`coinId: "1"` → canonical) |
| `ADDRESS_OVERRIDES` in stages.ts keyed by DL numeric IDs | Fixed: P3-TICKET-004 now covers re-keying `"213"` (M by M0) and `"67"` (BEAN) to canonical IDs |
| D1 runbook row count audit missing 5 tables | Fixed: Added `dex_liquidity`, `dex_prices`, `depeg_pending`, `onchain_supply`, `yield_data` to step 2.5 audit query and expected results table |

## Orchestrator protocol

You (Claude) are the orchestrator. Codex agents do the implementation. Your responsibilities:

1. **Before each phase:** Update `MIGRATION-PROGRESS.md` with current state. Run pre-flight checks.
2. **Create worktrees + copy tickets:** Use the exact commands in this document. For Phase 3, also copy the mapping table.
3. **Launch cmcs runs:** Use `cmcs run`. For parallel worktrees, background with `&`.
4. **Wait + check logs:** Use `cmcs wait`. If logs are empty, read directly from `worktrees/<name>/.cmcs/logs/*/*.stdout`.
5. **Review:** Run the review checklist for the phase. Check acceptance criteria. Read the diff for each modified file.
6. **Merge:** Only after review passes. Update `MIGRATION-PROGRESS.md` after each merge.
7. **Smoke test:** Run the curl commands for the deployed phase.

### Verifying Codex output against the mapping table

For Phase 3 (the big switchover), mechanically verify that Codex used the correct newId for every oldId. Run this after reviewing each P3 worktree:

```bash
# Extract all ID changes Codex made (old→new pairs from the diff)
cd worktrees/id-migration-master-switchover
git diff main -- shared/lib/stablecoins.ts | grep '^[-+].*usd\|^[-+].*eur\|^[-+].*other' | head -40

# Cross-check: for each newId in the diff, confirm it exists in the mapping table
git diff main -- shared/lib/stablecoins.ts | grep -oP '(?:usd|eur|other)\("[^"]+' | sed 's/.*("//' | while read id; do
  if ! grep -q "newId: \"$id\"" /home/ahirice/Documents/git/stablecoin-dashboard/worktrees/stablecoin-dashboard--research-id-system/DESIGN-MAPPING-TABLE.ts; then
    echo "WARNING: $id not found in mapping table"
  fi
done
# Any output = Codex invented an ID not in the mapping table
```

For config map re-keying (P3-TICKET-004), spot-check 5-10 entries:
```bash
# Verify mint-burn configs use canonical IDs from the mapping table
grep 'stablecoinId:' worker/src/lib/mint-burn-contracts.ts | head -5
# Each ID should match a newId in DESIGN-MAPPING-TABLE.ts
```

### When Codex fails

```
1. Check logs:    cat worktrees/<name>/.cmcs/logs/*/*.stdout
2. Identify which ticket failed and why
3. If it's a ticket bug:
   - Fix the ticket in .cmcs/tickets/
   - Re-run: cmcs run worktrees/<name>
   (completed tickets with done:true are skipped automatically)
4. If it's a codebase issue:
   - Fix in the worktree manually
   - Re-run cmcs to continue with remaining tickets
5. If Codex produced wrong output:
   - git checkout -- <file> in the worktree to reset
   - Refine the ticket instructions
   - Re-run
6. Log the incident in MIGRATION-PROGRESS.md
```

### After context compaction

If you're a fresh session continuing this migration:
1. Read `docs/plans/ticker-issue-migration/MIGRATION-PROGRESS.md` — it has the current state
2. Read `docs/plans/ticker-issue-migration/execution-handover.md` — it has all commands
3. Pick up from wherever the progress tracker says we are

## Worktree path convention

The `cmcs worktree create <branch>` command creates worktrees at `worktrees/<branch>/` (e.g., `cmcs worktree create id-migration-foundation` → `worktrees/id-migration-foundation/`). All paths in this document use this convention.

Note: The pre-existing research worktrees use a different naming convention (`stablecoin-dashboard--research-*`) because they were created manually, not by cmcs.

## Pre-flight checks before starting

1. **cmcs is initialized:** `.cmcs/cmcs.db` exists (already done 2026-03-06)
2. **Clean working tree:** `git status` shows no uncommitted changes that conflict with migration files
3. **Research worktrees intact:** All 4 `DESIGN-*` artifacts exist under `worktrees/`
4. **Main branch up to date:** `git pull` before creating worktrees
5. **Mapping table complete:** `grep -c 'TODO' worktrees/stablecoin-dashboard--research-id-system/DESIGN-MAPPING-TABLE.ts` returns 0 (all 18 TODOs resolved on 2026-03-06).
6. **D1 migration SQL ready:** `grep -c 'todo-' worktrees/stablecoin-dashboard--research-db-schema/DESIGN-MIGRATION-DRAFT.sql` — the SQL has 141 `todo-*` placeholders. These get auto-populated from the mapping table during the D1 runbook step. Not a blocker for Phases 1-2.

## Open items to resolve before Phase 3

1. ~~**18 entries with `// TODO: verify issuer`**~~ — **RESOLVED** (2026-03-06). All 18 issuers verified and mapping table updated. Key changes: USDG→paxos, A7A5→old-vector, rwaUSDi→multipli, CASH→phantom, USDH→native-markets, EURI→banking-circle, NECT→beraborrow, USDGO→osl, apxUSD→apyx, HYUSD→reserve, YU→yala. Remaining 7 dead stablecoin issuers confirmed correct as-is.

2. **D1 migration SQL placeholder fill** — the `DESIGN-MIGRATION-DRAFT.sql` has 141 `todo-*` placeholders, 3 wrong pre-filled values (`dai-sky` should be `dai-makerdao`, `usdf-falcon-finance` should be `usdf-falcon`, `ousg-ondo` should be `ousg-ondo-finance`), and is **missing all 78 dead stablecoin mappings**. Do NOT use the draft INSERT block — generate a fresh one from `DESIGN-MAPPING-TABLE.ts` including `DEAD_ID_MAPPING`. See the D1 runbook step 3 for the generation script. The remap SQL statements (sections 3A/3B) are correct and reusable as-is — only the mapping data needs regeneration.

3. **New stablecoins added between now and execution** — if TRACKED_STABLECOINS grows, new entries need mapping table entries and migration SQL rows. Run this before Phase 3 to detect drift:

   ```bash
   # Count entries in code vs mapping table
   CODE_COUNT=$(grep -c '^  usd\|^  eur\|^  other' shared/lib/stablecoins.ts)
   MAP_COUNT=$(grep -c 'oldId:' worktrees/stablecoin-dashboard--research-id-system/DESIGN-MAPPING-TABLE.ts | head -1)
   echo "Code: $CODE_COUNT entries, Mapping: $MAP_COUNT entries"

   # Find IDs in code that are missing from the mapping table
   grep -oP '(?:usd|eur|other)\("([^"]+)"' shared/lib/stablecoins.ts | \
     sed 's/.*("//;s/".*//' | sort > /tmp/code-ids.txt
   grep -oP 'oldId: "([^"]+)"' worktrees/stablecoin-dashboard--research-id-system/DESIGN-MAPPING-TABLE.ts | \
     sed 's/oldId: "//;s/"//' | sort > /tmp/map-ids.txt
   comm -23 /tmp/code-ids.txt /tmp/map-ids.txt
   # Any output = IDs in code but missing from the mapping table → add them before proceeding
   ```

   If new entries are found, add them to `DESIGN-MAPPING-TABLE.ts` with appropriate `newId` values, then regenerate the D1 migration SQL.
