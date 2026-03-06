---
title: "D1 Migration Runbook (manual execution)"
agent: "human"
done: false
---

## Goal

Migrate all stablecoin_id values in D1 from legacy IDs to canonical ticker-issuer format, coordinated with the Phase 3 code deploy to avoid any window where code and DB are out of sync.

## The Timing Problem

Phase 3 code has canonical IDs in `TRACKED_STABLECOINS` (e.g., `"usdt-tether"`). D1 has old IDs (e.g., `"1"`). If code deploys before D1 migrates, every DB query like `WHERE stablecoin_id = 'usdt-tether'` returns zero rows because D1 still has `"1"`. All history endpoints, detail pages, and DEWS scores break.

If D1 migrates before code deploys, the old code queries `WHERE stablecoin_id = '1'` against D1 that now has `"usdt-tether"`. Same breakage, opposite direction.

**Code and D1 must switch in a single maintenance window.** The window is ~5-8 minutes during which API responses may be incomplete.

## CI Auto-Deploy Warning

**CRITICAL:** The CI pipeline (`.github/workflows/deploy-cloudflare.yml`) triggers automatically on push to `main`. It deploys the worker BEFORE Pages. If Phase 3 code is pushed to main without the D1 data migration being done first, the worker deploys with canonical IDs but D1 still has old IDs — **production breaks immediately**.

**Solution:** Use `[skip ci]` in Phase 3 merge commit messages to prevent auto-deploy. The maintenance window includes a manual deploy step instead.

## Prerequisites

- Phase 3 worktrees (master-switchover, test-fixtures, frontend-compat) are reviewed and ready to merge
- All tests pass in each worktree: `npm run build && cd worker && npx tsc --noEmit && npm test`
- Mapping table SQL files are prepared (see step 3 below)
- **Workers Paid plan active** ($5/mo) — required for: 1,000 queries/invocation, 30-day Time Travel retention, gradual deployments
- **Wrangler >= 3.40.0** — required for gradual deployments (`wrangler versions upload`/`deploy`)
- Schedule during low-traffic hours (e.g., 04:00-06:00 UTC), avoiding 08:15 UTC (daily CI cron)

## Runbook

### 1. Disable cron triggers and merge Phase 3 code

**1a. Disable crons on current main (Phase 2 code):**

```bash
cd worker
# Edit wrangler.toml: comment out all [triggers.crons] entries
git add wrangler.toml
cd ..
git commit -m "[skip ci] chore: disable crons for ID migration window"
git push origin main
cd worker && npx wrangler deploy
```

The `[skip ci]` prevents a CI run for this commit. The manual `wrangler deploy` deploys the cron-disabled worker immediately.

**Wait at least 15 minutes.** Cloudflare cron propagation takes up to 15 min after each deploy — old Worker versions linger as "ghost triggers" until propagation completes. Verify no cron runs are in-flight:
```bash
npx wrangler tail --format=json | grep -i 'cron\|scheduled'
# Wait until you see no new scheduled events for 2+ minutes
```

**1b. Merge Phase 3 worktrees to main WITH `[skip ci]`:**

```bash
# Merge each Phase 3 worktree with [skip ci] to prevent auto-deploy
git merge id-migration-master-switchover --no-ff -m "[skip ci] merge: Phase 3 master switchover"
git merge id-migration-test-fixtures --no-ff -m "[skip ci] merge: Phase 3 test fixtures"
git merge id-migration-frontend-compat --no-ff -m "[skip ci] merge: Phase 3 frontend compat"
git push origin main
```

**Verify CI did NOT trigger:** Check GitHub Actions — no workflow run should appear for these commits.

**Post-merge verification (local only):**
```bash
npm run build && cd worker && npx tsc --noEmit && cd .. && npm test
```

**TIMING CONSTRAINT:** `[skip ci]` only suppresses **push-triggered** workflows. The scheduled CI cron at 8:15 UTC (`.github/workflows/deploy-cloudflare.yml`) fires independently and will deploy whatever is on `main`. If Phase 3 code is on main but D1 hasn't been migrated, the scheduled run deploys Phase 3 → production breaks.

**Therefore:** Steps 1a/1b and the full maintenance window (steps 2-9) must all complete within a single session that does NOT span an 8:15 UTC boundary. Recommended: start step 1a at ~08:30 UTC (right after the daily CI finishes), complete the maintenance window well before 08:14 UTC the next day. In practice, everything takes <2 hours, so start after 08:30 UTC and finish by ~11:00 UTC the same day.

Step 1a (cron disable) can be done slightly in advance since it doesn't put Phase 3 code on main. Step 1b (Phase 3 merge) must be immediately followed by steps 2-9 without interruption.

### 2. Backup D1 (two independent rollback paths)

**Primary: D1 Time Travel bookmark** (instant restore, no file transfer):
```bash
npx wrangler d1 time-travel info stablecoin-db
# Save the returned bookmark — this is your instant rollback point.
# Example output: bookmark: 0000004a-xxxxxxxx
# Write it down. Restoring to this bookmark takes seconds, not minutes.
```

**Secondary: SQL export** (belt-and-suspenders, works even if Time Travel has issues):
```bash
npx wrangler d1 export stablecoin-db --remote --output=backup-pre-migration.sql

# Validate backup isn't empty/truncated
wc -l backup-pre-migration.sql   # expect thousands of lines
grep -c 'INSERT INTO' backup-pre-migration.sql  # expect many INSERT statements
```

Time Travel retains 30 days of history on the paid plan. The SQL export is a local safety copy.

### 2.5 Audit row counts (D1 limit check)

D1 has a 30-second per-statement execution limit. Large bulk operations on big tables will timeout. Audit row counts to determine which tables need per-stablecoin-id batched statements:

```bash
npx wrangler d1 execute stablecoin-db --remote --command="
  SELECT 'supply_history' AS tbl, COUNT(*) AS cnt FROM supply_history
  UNION ALL SELECT 'mint_burn_events', COUNT(*) FROM mint_burn_events
  UNION ALL SELECT 'mint_burn_hourly', COUNT(*) FROM mint_burn_hourly
  UNION ALL SELECT 'yield_history', COUNT(*) FROM yield_history
  UNION ALL SELECT 'stress_signals', COUNT(*) FROM stress_signals
  UNION ALL SELECT 'stress_signal_history', COUNT(*) FROM stress_signal_history
  UNION ALL SELECT 'dex_liquidity_history', COUNT(*) FROM dex_liquidity_history
  UNION ALL SELECT 'dex_liquidity', COUNT(*) FROM dex_liquidity
  UNION ALL SELECT 'dex_prices', COUNT(*) FROM dex_prices
  UNION ALL SELECT 'depeg_events', COUNT(*) FROM depeg_events
  UNION ALL SELECT 'depeg_pending', COUNT(*) FROM depeg_pending
  UNION ALL SELECT 'onchain_supply', COUNT(*) FROM onchain_supply
  UNION ALL SELECT 'yield_data', COUNT(*) FROM yield_data
  UNION ALL SELECT 'safety_grade_history', COUNT(*) FROM safety_grade_history;
" --json
```

**Expected results (as of March 2026):**

| Table | Est. Rows | Action |
|-------|-----------|--------|
| `mint_burn_events` | ~1,035,000 | **MUST batch** |
| `mint_burn_hourly` | ~630,000 | **MUST batch** |
| `supply_history` | ~225,000 | **MUST batch** |
| `yield_history` | ~53,000 | Batch as precaution |
| `stress_signals` | ~53,000 | Batch as precaution |
| `depeg_events` | ~49,000 | Batch as precaution |
| `stress_signal_history` | ~29,000 | Single statement OK |
| `dex_liquidity_history` | ~8,000–30,000 | Single statement OK |
| `dex_liquidity` | ~150–500 | Single statement OK |
| `dex_prices` | ~150 | Single statement OK |
| `depeg_pending` | ~0–10 | Single statement OK |
| `onchain_supply` | ~150–500 | Single statement OK |
| `yield_data` | ~50–150 | Single statement OK |
| `safety_grade_history` | ~100–360 | Single statement OK |

**D1 has a 30-second per-statement execution limit.** Large single-statement operations (INSERT-SELECT of 1M rows, bulk UPDATE of 225K rows) will timeout. Tables above ~50K rows should use per-stablecoin-id batched statements to keep each statement small:

```sql
-- Instead of one massive UPDATE:
--   UPDATE supply_history SET stablecoin_id = (SELECT ...) WHERE ...
-- Do per-coin UPDATEs:
UPDATE supply_history SET stablecoin_id = 'usdt-tether' WHERE stablecoin_id = '1';
UPDATE supply_history SET stablecoin_id = 'usdc-circle' WHERE stablecoin_id = '2';
-- ... one per mapping entry

-- Instead of one massive INSERT+DELETE for PK tables:
-- Do per-coin INSERT+DELETE pairs:
INSERT INTO mint_burn_events (...) SELECT m.new_id, ... FROM mint_burn_events e JOIN stablecoin_id_map m ON e.stablecoin_id = m.old_id WHERE e.stablecoin_id = '1';
DELETE FROM mint_burn_events WHERE stablecoin_id = '1';
-- ... one pair per mapping entry with data in that table
```

This produces ~227 statements per table (one per mapping entry) instead of 1 giant statement. Each touches at most ~15K rows (the most active single coin), well within the 30-second limit.

**STOP if any table exceeds the estimates by 3× or more** — the per-coin batching assumes no single coin has >100K rows. Verify the largest coin per table if counts are unexpectedly high.

### 3. Prepare migration SQL files

The migration SQL at `worktrees/stablecoin-dashboard--research-db-schema/DESIGN-MIGRATION-DRAFT.sql` (relative to the main repo root) has `todo-*` placeholders AND is missing dead stablecoin mappings. **Do not use the INSERT block from the draft SQL.** Instead, generate a complete fresh mapping from the authoritative mapping table:

```bash
# Generate the complete stablecoin_id_map INSERT from the mapping table
# Deduplicates oldId "3" (UST): dead mapping (ust-terra-classic) takes priority
# over shadow mapping (ust-terra) because D1 has dead UST data, not shadow PSI data
npx tsx -e "
import { ID_MAPPING, SHADOW_ID_MAPPING, DEAD_ID_MAPPING } from './worktrees/stablecoin-dashboard--research-id-system/DESIGN-MAPPING-TABLE';
const seen = new Set();
const all = [...ID_MAPPING, ...DEAD_ID_MAPPING, ...SHADOW_ID_MAPPING].filter(m => {
  if (seen.has(m.oldId)) return false;
  seen.add(m.oldId);
  return true;
});
console.log('INSERT INTO stablecoin_id_map (old_id, new_id) VALUES');
console.log(all.map((m, i) => \`  \${i ? ',' : ' '}('\${m.oldId}', '\${m.newId}')\`).join('\n') + ';');
console.log(\`-- \${all.length} total mappings (deduplicated: dead takes priority over shadow)\`);
" > migration-02-populate-map.sql

# Sanity checks
grep -c "^  " migration-02-populate-map.sql        # expect 227 (228 minus 1 dedup)
grep -c "todo-" migration-02-populate-map.sql       # expect 0
grep "'3'" migration-02-populate-map.sql               # expect: ('3', 'ust-terra-classic') — dead takes priority over shadow
```

**Why dead IDs matter:** Dead stablecoins that were once tracked may have rows in supply_history, depeg_events, or stress_signal_history. Without their mappings in stablecoin_id_map, the coverage validation (step 5) will flag them, and the remap JOINs will skip them — leaving orphaned rows with legacy IDs.

Split the draft SQL into numbered checkpoint files:
- `migration-01-create-map.sql` — Create `stablecoin_id_map` table
- `migration-02-populate-map.sql` — INSERT all 227 deduplicated mappings (228 total minus 1 UST duplicate)
- `migration-03-validate-pre.sql` — Validation gates (0 duplicates, 0 placeholders, 0 missing coverage)
- `migration-04-remap.sql` — All remap statements, **batched per stablecoin_id** (see step 2.5). Use per-coin UPDATE statements for non-PK tables and per-coin INSERT+DELETE pairs for PK tables. **Do NOT use `BEGIN`/`COMMIT`** — D1 does not support explicit transactions. `wrangler d1 execute --file --remote` implicitly wraps the entire file in a D1-managed transaction, providing atomicity automatically. Including `BEGIN IMMEDIATE;` will error with "cannot start a transaction within a transaction."
- `migration-05-validate-post.sql` — Post-migration validation (all queries should return 0 rows)
- `migration-06-backup-map.sql` — Create `stablecoin_id_map_applied` backup table

**Do this preparation well before the maintenance window.**

### 4. BEGIN MAINTENANCE WINDOW — Enable maintenance mode

Instead of serving broken/empty responses during the migration, enable a maintenance mode flag so the Worker returns a clean 503 with a JSON message:

```bash
# This creates a new Worker version and deploys it immediately.
# The worker already supports MAINTENANCE_MODE (see worker/src/handlers/http.ts).
echo "true" | npx wrangler secret put MAINTENANCE_MODE
```

Edge cache will also serve stale-but-valid responses for most endpoints during the window.

### 5. Execute D1 migration

Run each file in order, validating between steps:

```bash
npx wrangler d1 execute stablecoin-db --remote --file=migration-01-create-map.sql
npx wrangler d1 execute stablecoin-db --remote --file=migration-02-populate-map.sql
npx wrangler d1 execute stablecoin-db --remote --file=migration-03-validate-pre.sql
```

**STOP if any validation query returns rows.** Do not proceed until all gates pass.

```bash
npx wrangler d1 execute stablecoin-db --remote --file=migration-04-remap.sql
npx wrangler d1 execute stablecoin-db --remote --file=migration-05-validate-post.sql
```

**STOP and rollback if any query returns non-zero.** Rollback is instant via Time Travel:
```bash
npx wrangler d1 time-travel restore stablecoin-db --bookmark=<SAVED_BOOKMARK>
```

**Atomicity note:** `wrangler d1 execute --file --remote` does NOT have a documented full-file atomicity guarantee. If migration-04-remap.sql fails mid-way, D1 may have mixed old/new IDs. This is why the Time Travel bookmark (step 2) is critical — it provides instant, guaranteed rollback to the pre-migration state regardless of partial failures.

```bash
npx wrangler d1 execute stablecoin-db --remote --file=migration-06-backup-map.sql
```

At this point D1 has canonical IDs, but the deployed worker still has Phase 2 code (old IDs). Old code queries will fail against the migrated D1. This is expected — move immediately to step 6.

### 6. Invalidate caches

```bash
npx wrangler d1 execute stablecoin-db --remote --command="DELETE FROM cache; DELETE FROM price_cache;"
```

### 7. Deploy Phase 3 worker with crons re-enabled (gradual deployment)

Use gradual deployments for instant rollback capability:

```bash
cd worker
# Uncomment cron triggers in wrangler.toml

# Save the Phase 2 version ID for potential rollback (gradual deployments keep last 100 versions).
# After this step, `wrangler rollback` reverts to THIS version — but only until CI redeploys.
npx wrangler versions list | head -5
# Write down the current active version ID.

# Upload the new version WITHOUT deploying to traffic yet
npx wrangler versions upload

# The upload returns a version ID. Now deploy it to 100% traffic:
npx wrangler versions deploy
# Interactive prompt: set the new version to 100%.
# If something is wrong, instant rollback: npx wrangler rollback

# Disable maintenance mode if it was enabled in step 4:
echo "" | npx wrangler secret put MAINTENANCE_MODE
# (Setting to empty string effectively disables the check)

# CRITICAL: commit the cron re-enable to git WITH [skip ci].
# We push now to save wrangler.toml (prevents daily CI at 8:15 UTC from reverting crons),
# but we skip CI because the cache is empty — smoke-api would fail.
# CI will be triggered in step 8.5 after caches rebuild.
git add wrangler.toml
cd ..
git commit -m "[skip ci] chore: re-enable cron triggers after ID migration"
git push origin main
```

D1 now has canonical IDs AND the deployed worker uses canonical IDs. The gap between steps 5 and 7 is the maintenance window (~5 minutes of manual work).

**Why `[skip ci]` here:** Three smoke-api endpoints (`/api/stablecoins`, `/api/peg-summary`, `/api/report-cards`) read from the D1 `cache` table, which was cleared in step 6. Until the first cron cycle rebuilds the cache (~15 min), these return 503. If CI runs now, `smoke-api` fails → `deploy-pages` never runs → Pages are never updated.

**Why `wrangler rollback` has a time limit:** Once CI runs `wrangler deploy` (step 8.5), it creates a new standard deployment that replaces the gradual deployment. After that, `wrangler rollback` reverts to the CI version (same Phase 3 code), not Phase 2. For Phase 2 rollback after CI has deployed, use `wrangler versions deploy` with the Phase 2 version ID saved above, plus Time Travel for D1.

### 8. Wait for caches to rebuild, then deploy Pages

Wait for the first cron cycle (~15 minutes) to rebuild caches. Verify:
```bash
curl -sf "https://api.pharos.watch/api/stablecoins" | jq '.peggedAssets | length'
# Expect 148. If 0 or error, caches haven't rebuilt yet — wait and retry.
```

Once caches are warm, build and deploy Pages:
```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard
npx tsx scripts/sync-digests.ts
npm run build
npx wrangler pages deploy out --project-name=stablecoin-dashboard --commit-dirty=true
```

This builds the static export with canonical IDs in `generateStaticParams()` and deploys to Cloudflare Pages. The `_redirects` file (generated by `prebuild` script) provides 301s from old URLs.

### 8.5. Trigger CI (push without `[skip ci]`)

Now that caches are warm and Pages are deployed, push a commit to trigger CI and resume normal operations:

```bash
git commit --allow-empty -m "chore: trigger CI after ID migration"
git push origin main
# CI runs: validate → deploy-worker (no-op, same code) → smoke-api (passes, caches warm)
#        → deploy-pages (rebuilds, same as step 8) → smoke-ui (passes)
```

This confirms the full pipeline works with canonical IDs and resumes automatic deploys for future pushes.

### 9. END MAINTENANCE WINDOW — Verify

Run the smoke tests:

```bash
# Core functionality
curl -sf "https://api.pharos.watch/api/stablecoins" | jq '.peggedAssets | length'  # expect 148
curl -sf "https://api.pharos.watch/api/stablecoin/usdt-tether" | jq '.symbol'     # expect "USDT"
curl -sf "https://api.pharos.watch/api/peg-summary" | jq '.summary | length'      # expect > 0

# Legacy ID still works (allowLegacy is on)
curl -s "https://api.pharos.watch/api/stablecoin/1" | jq '.symbol'               # expect "USDT"

# History endpoints (verify D1 queries work with canonical IDs)
curl -s "https://api.pharos.watch/api/supply-history?stablecoin=usdt-tether&days=7" | jq 'length'  # expect > 0
curl -s "https://api.pharos.watch/api/dex-liquidity-history?stablecoin=usdt-tether&days=7" | jq 'length'  # expect > 0

# Health check
curl -s "https://api.pharos.watch/api/health" | jq '.status'                     # expect "ok"

# Frontend (static export should have new URLs)
curl -sI "https://pharos.watch/stablecoin/usdt-tether/" | head -1                # expect 200
curl -sI "https://pharos.watch/stablecoin/1/" | grep -i location                 # expect 301 → /stablecoin/usdt-tether/
```

## Maintenance Window Duration

| Step | Duration |
|------|----------|
| 4. Enable maintenance mode | ~10 sec |
| 5. D1 migration (14 tables, batched per-coin) | ~3-5 min |
| 6. Cache invalidation | ~10 sec |
| 7. Upload + deploy Phase 3 worker (gradual) + push `[skip ci]` | ~1-2 min |
| 8. Wait for cron cache rebuild + build + deploy Pages | ~18-20 min |
| 8.5. Push empty commit to trigger CI (validates full pipeline) | ~5-8 min |
| **Total window (API returns 503)** | **~5-8 min** (steps 4-7) |
| **Total window (Pages stale)** | **~25 min** (until step 8 completes) |

Steps 1-3 (cron disable, merge with `[skip ci]`, backup + Time Travel bookmark, SQL prep) are done in advance — they don't contribute to downtime. During the window, users see a clean 503 with "maintenance" message or stale edge-cached responses. During steps 7-8, the API serves correct data but Pages may still show old URLs (users redirected via `_redirects`). Step 8.5 is a validation step — CI deploys the same code, confirming everything works end-to-end.

## Cloudflare Features Used

| Feature | Purpose | Plan Required |
|---------|---------|---------------|
| **D1 Time Travel** | Instant rollback — restore to pre-migration bookmark in seconds | Free (7d) / Paid (30d) |
| **Gradual Deployments** | Upload new Worker at 0%, test, flip to 100%; instant `wrangler rollback` | Paid (Workers $5/mo) |
| **MAINTENANCE_MODE secret** | Clean 503 during window instead of broken responses | Any |
| **D1 Export** | Belt-and-suspenders SQL backup alongside Time Travel | Any |

## Rollback

All rollback paths use D1 Time Travel (instant, seconds) instead of slow SQL re-import. The SQL backup file (`backup-pre-migration.sql`) is a last resort if Time Travel fails.

**If D1 migration fails mid-way (step 5):**
```bash
# Instant restore to pre-migration state
npx wrangler d1 time-travel restore stablecoin-db --bookmark=<SAVED_BOOKMARK>
```
Do not deploy Phase 3 code. Re-enable crons on the current Phase 2 code (`cd worker && npx wrangler deploy`). Investigate and retry later.

**If Phase 3 worker deploy fails (step 7):**
D1 already has canonical IDs. Either fix the deploy issue, or reverse everything:
```bash
# Restore D1 to pre-migration state
npx wrangler d1 time-travel restore stablecoin-db --bookmark=<SAVED_BOOKMARK>
# Re-enable crons on Phase 2 code
cd worker && npx wrangler deploy
```

**If smoke tests fail (step 9):**
Check which queries are failing. If D1 data looks correct but code is wrong, this is a code bug — fix and redeploy. If D1 data is wrong, roll back both D1 and code:
```bash
# 1. Instant D1 rollback
npx wrangler d1 time-travel restore stablecoin-db --bookmark=<SAVED_BOOKMARK>

# 2. Instant Worker rollback (gradual deployment)
cd worker && npx wrangler rollback
# This reverts to the previous Worker version (Phase 2 code) in seconds.

# 3. Revert Phase 3 code in git and redeploy Pages
cd ..
git revert --no-commit HEAD~4..HEAD  # revert: cron-re-enable + 3 Phase 3 merge commits (4 commits after cron-disable)
# If step 8.5 was already run, use HEAD~5..HEAD instead (5 commits).
# The cron-disable commit (step 1a) does NOT need reverting — crons stay disabled until explicitly re-enabled.
git commit -m "revert: Phase 3 (rollback)"
npm run build && npx wrangler pages deploy out --project-name=stablecoin-dashboard --commit-dirty=true
```

**Fallback if Time Travel fails** (shouldn't happen, but belt-and-suspenders):
```bash
npx wrangler d1 execute stablecoin-db --remote --file=backup-pre-migration.sql
```

**After any rollback:** Push a no-op commit without `[skip ci]` to resume normal CI, or manually re-enable the cron triggers in `wrangler.toml` and deploy.
