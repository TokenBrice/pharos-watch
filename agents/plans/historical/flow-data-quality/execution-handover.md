# Flow Data Quality — Execution Handover

## What This Does

Fixes four data quality issues in the mint/burn flows feature: (Q1) excludes flash loan/atomic arb transactions from flow aggregation, (Q2) expands bridge burn detection from CCIP-only to 6 bridge protocols, (Q3) auto-heals NULL USD prices on recent events each cron cycle, and (Q4) gates pressure shift scores for coins with < $50K daily activity. Also bumps methodology to v4.5 and adds observability counters.

## File Inventory

```
agents/plans/flow-data-quality/
  2026-03-09-flow-data-quality-design.md     # Approved design document
  implementation-plan.md                      # Phase/worktree/ticket structure
  execution-handover.md                       # THIS FILE — operational runbook
  PROGRESS.md                                 # Single source of truth for state
  tickets/
    phase1-q4-activity-gate/
      TICKET-001.md                           # MIN_ACTIVITY_USD gate
    phase1-q1-atomic-roundtrip/
      TICKET-001.md                           # Schema + detection logic
      TICKET-002.md                           # Aggregation filter + cron + admin endpoint
    phase1-q3-auto-backfill/
      TICKET-001.md                           # Auto price heal + observability
    phase1-q2-bridge-expansion/
      TICKET-001.md                           # Bridge addresses + admin endpoint
    phase2-methodology/
      TICKET-001.md                           # Version bump + changelog + docs
```

## Pre-Flight Checks

Before starting execution, verify:

```bash
# 1. Clean working tree
git status  # should be clean

# 2. Main is up to date
git pull origin main

# 3. cmcs initialized
cmcs status  # should not error

# 4. Build passes on current main
npm run build && cd worker && npx tsc --noEmit && npm test

# 5. Bridge address research complete (for Q2)
# Check that TICKET-001 in phase1-q2-bridge-expansion has concrete addresses, not placeholders
```

## Execution Commands Per Phase

### Phase 1: Data Quality Fixes

```bash
# Step 1: Create worktrees
cmcs worktree create flow-q4-activity-gate
cmcs worktree create flow-q1-atomic-roundtrip
cmcs worktree create flow-q3-auto-backfill
cmcs worktree create flow-q2-bridge-expansion

# Step 2: Copy tickets
cp agents/plans/flow-data-quality/tickets/phase1-q4-activity-gate/* worktrees/flow-q4-activity-gate/.cmcs/tickets/
cp agents/plans/flow-data-quality/tickets/phase1-q1-atomic-roundtrip/* worktrees/flow-q1-atomic-roundtrip/.cmcs/tickets/
cp agents/plans/flow-data-quality/tickets/phase1-q3-auto-backfill/* worktrees/flow-q3-auto-backfill/.cmcs/tickets/
cp agents/plans/flow-data-quality/tickets/phase1-q2-bridge-expansion/* worktrees/flow-q2-bridge-expansion/.cmcs/tickets/

# Step 3: Launch all in parallel
cmcs run worktrees/flow-q4-activity-gate 2>&1 &
cmcs run worktrees/flow-q1-atomic-roundtrip 2>&1 &
cmcs run worktrees/flow-q3-auto-backfill 2>&1 &
cmcs run worktrees/flow-q2-bridge-expansion 2>&1 &
wait

# Step 4: Check status
cmcs status
```

### Phase 1: Merge (sequential — order matters)

```bash
# Merge order: Q1 → Q2 → Q3 → Q4
# Q1 first (largest, touches sync-mint-burn.ts + router.ts + api-endpoints.ts)
# Q2 second (touches router.ts + api-endpoints.ts — trivial conflict with Q1's route)
# Q3 third (touches sync-mint-burn.ts — trivial conflict with Q1's import/metadata)
# Q4 last (no conflicts)

# IMPORTANT: Merge from the main repo root, NOT from inside the worktree
# For each worktree, after review checklist passes:
git checkout main
git merge flow-q1-atomic-roundtrip
# Resolve any conflicts, then run merge gate:
npm run test:merge-gate
# If gate passes, push:
git push origin main

# Repeat for Q2, Q3, Q4 in order
# After all merges, clean up worktrees:
git worktree remove worktrees/flow-q1-atomic-roundtrip
git worktree remove worktrees/flow-q2-bridge-expansion
git worktree remove worktrees/flow-q3-auto-backfill
git worktree remove worktrees/flow-q4-activity-gate
```

### Phase 1: Deploy

```bash
# 0. Capture D1 Time Travel bookmark BEFORE migration (for rollback)
wrangler d1 time-travel info stablecoin-db
# Save the bookmark value — this is the pre-migration restore point

# 1. Apply D1 migration (BEFORE deploying code)
cd worker && wrangler d1 migrations apply stablecoin-db --remote

# 2. Deploy worker
cd worker && wrangler deploy

# 3. Deploy frontend (Pages will auto-deploy from main push)

# 4. Capture post-deploy D1 bookmark (for Phase 3 rollback baseline)
wrangler d1 time-travel info stablecoin-db
# Save this bookmark — restore point before retroactive data corrections
```

### Phase 2: Methodology Versioning

```bash
# Only after Phase 1 is fully merged, built, and deployed
cmcs worktree create flow-methodology-v45
cp agents/plans/flow-data-quality/tickets/phase2-methodology/* worktrees/flow-methodology-v45/.cmcs/tickets/
cmcs run worktrees/flow-methodology-v45
cmcs wait worktrees/flow-methodology-v45

# Review, merge from main repo root, deploy
git checkout main
git merge flow-methodology-v45
npm run test:merge-gate
git push origin main
git worktree remove worktrees/flow-methodology-v45
```

### Phase 3: Retroactive Data Corrections

**Prerequisite:** Set `$ADMIN_KEY` to the value of the `ADMIN_KEY` Cloudflare Worker secret (same key used for /status admin actions).

```bash
# 0. Capture D1 Time Travel bookmark BEFORE retroactive changes (for rollback)
wrangler d1 time-travel info stablecoin-db
# Save this bookmark — restore point if reclassification causes issues

# 1. Capture before-snapshot
wrangler d1 execute stablecoin-db --remote --command "SELECT SUM(burn_volume_usd) as total_burn_30d FROM mint_burn_hourly WHERE hour_ts >= unixepoch() - 30*86400;"
curl -s 'https://api.pharos.watch/api/mint-burn-flows' | jq '{gauge_score: .gauge.score, nr_coins: [.coins[] | select(.pressureShiftScore == null)] | length, scored_coins: [.coins[] | select(.pressureShiftScore != null)] | length}'

# 2. Run Q1 retroactive classification (repeat until done: true)
curl -X POST -H "X-Admin-Key: $ADMIN_KEY" 'https://api.pharos.watch/api/reclassify-atomic-roundtrips'

# 3. Run Q2 retroactive classification (for each coin with bridge detection)
# Get list of coins with bridge configs:
# usdc-circle, zchf-frankencoin, usd1-world-liberty-financial, avusd-avant, usdo-openeden
# Plus any new coins added during Q2
for COIN in usdc-circle zchf-frankencoin usd1-world-liberty-financial avusd-avant usdo-openeden; do
  curl -X POST -H "X-Admin-Key: $ADMIN_KEY" "https://api.pharos.watch/api/reclassify-bridge-burns?stablecoin=$COIN"
done

# 4. Capture after-snapshot (same queries as step 1)
# 5. Compare and document impact
```

## Review Checklists Per Phase

### Phase 1 Review: flow-q4-activity-gate

```bash
cd worktrees/flow-q4-activity-gate

# Build + type check + test
npm run build && cd worker && npx tsc --noEmit && npm test

# Spot checks
grep -c 'MIN_ACTIVITY_USD' worker/src/lib/mint-burn-scoring.ts
# Expected: 2 (constant declaration + gate check)

grep -c 'currentDailyAbs' worker/src/lib/mint-burn-scoring.ts
# Expected: 2+ (interface field + gate check)

grep -c 'currentDailyAbs' worker/src/api/mint-burn-flows.ts
# Expected: 1+ (passed to computeFlowIntensity)

grep -c 'MIN_ACTIVITY_USD' worker/src/lib/__tests__/mint-burn-scoring.test.ts
# Expected: 1+ (test references)
```

### Phase 1 Review: flow-q1-atomic-roundtrip

```bash
cd worktrees/flow-q1-atomic-roundtrip

# Build + type check + test
npm run build && cd worker && npx tsc --noEmit && npm test

# Spot checks
test -f worker/migrations/0056_mint_burn_flow_type.sql
# Expected: file exists

grep -c 'flow_type' worker/src/lib/mint-burn-pipeline/types.ts
# Expected: 1+ (field in MintBurnRow)

grep -c 'flow_type' worker/src/lib/mint-burn-pipeline/persistence.ts
# Expected: 5+ (INSERT column + bind + aggregation filters)

test -f worker/src/lib/mint-burn-pipeline/roundtrip-detection.ts
# Expected: file exists

grep -c 'detectAtomicRoundtrips' worker/src/cron/sync-mint-burn.ts
# Expected: 2+ (import + call)

grep -c 'atomicRoundtripsDetected' worker/src/cron/sync-mint-burn.ts
# Expected: 1+ (metadata field)

test -f worker/src/api/reclassify-atomic-roundtrips.ts
# Expected: file exists
```

### Phase 1 Review: flow-q3-auto-backfill

```bash
cd worktrees/flow-q3-auto-backfill

# Build + type check + test
npm run build && cd worker && npx tsc --noEmit && npm test

# Spot checks
test -f worker/src/lib/mint-burn-pipeline/price-heal.ts
# Expected: file exists

grep -c 'healNullPrices' worker/src/cron/sync-mint-burn.ts
# Expected: 2+ (import + call)

grep -c 'nullPricesHealed' worker/src/cron/sync-mint-burn.ts
# Expected: 1+ (metadata field)

grep -c 'price_cache_heal' worker/src/lib/mint-burn-pipeline/price-heal.ts
# Expected: 1 (price_source value)
```

### Phase 1 Review: flow-q2-bridge-expansion

```bash
cd worktrees/flow-q2-bridge-expansion

# Build + type check + test
npm run build && cd worker && npx tsc --noEmit && npm test

# Spot checks
grep -c 'counterpartyBridgeDetection' worker/src/lib/mint-burn-contracts.ts
# Expected: 1+ (factory function)

grep -c 'Bridge detection coverage' worker/src/lib/mint-burn-contracts.ts
# Expected: 1 (doc comment header)

test -f worker/src/api/reclassify-bridge-burns.ts
# Expected: file exists
```

### Phase 2 Review: flow-methodology-v45

```bash
cd worktrees/flow-methodology-v45

# Build
npm run build && cd worker && npx tsc --noEmit

# Spot checks
grep -c '"4.5"' shared/lib/mint-burn-flow-version.ts
# Expected: 2 (currentVersion + changelog entry)

grep -c 'MIN_ACTIVITY_USD' docs/mint-burn-flows.md
# Expected: 1+ (documented in constants table)

grep -c 'flow_type' docs/mint-burn-flows.md
# Expected: 1+ (documented in schema)
```

## Post-Deploy Smoke Tests

### After Phase 1 Deploy

```bash
# 1. Aggregate flows endpoint returns valid data
curl -s 'https://api.pharos.watch/api/mint-burn-flows' | jq '{gauge: .gauge.score, coins: (.coins | length), hourly: (.hourly | length)}'
# Expected: gauge is a number (or null), coins > 0, hourly > 0

# 2. Per-coin endpoint still works
curl -s 'https://api.pharos.watch/api/mint-burn-flows?stablecoin=usdc-circle' | jq '{id: .stablecoinId, mint: .mintVolumeUsd, burn: .burnVolumeUsd}'
# Expected: valid USDC flow data

# 3. Events endpoint still works
curl -s 'https://api.pharos.watch/api/mint-burn-events?stablecoin=usdt-tether&limit=5' | jq '{total: .total, count: (.events | length)}'
# Expected: total > 0, count = 5

# 4. Wait for next cron cycle (~20 min), then check /status for new metadata fields
# Look for: atomicRoundtripsDetected, nullPricesHealed in mint-burn cron metadata
```

### After Phase 2 Deploy

```bash
# Methodology page renders v4.5
# Note: pharos.watch is a static Next.js export — the changelog is embedded in the page JS bundle
# Verify the version string appears in the built output:
npm run build && grep -r '4.5' out/methodology/ | head -3
# Expected: at least 1 match

# Or check the version module directly:
grep -c '"4.5"' shared/lib/mint-burn-flow-version.ts
# Expected: 2 (currentVersion + changelog entry)
```

## Rollback Procedures Per Phase

### Phase 1 Rollback

**Q4 (activity gate):** Pure code. `git revert <merge-commit>`, redeploy.

**Q1 (atomic roundtrip):**
1. Code: `git revert <merge-commit>`, redeploy worker
2. Schema: D1 Time Travel — `wrangler d1 time-travel info stablecoin-db` to get pre-migration bookmark, `wrangler d1 time-travel restore stablecoin-db --bookmark=<pre-migration-bookmark>`
3. If Time Travel is not viable, the `flow_type` column is additive and harmless — old code ignores it

**Q3 (auto backfill):** Pure code. `git revert <merge-commit>`, redeploy. Healed prices are correct values — no data rollback needed.

**Q2 (bridge expansion):** Pure config. `git revert <merge-commit>`, redeploy. If retroactive reclassification was run, re-aggregate affected hourly buckets (or D1 Time Travel).

### Phase 2 Rollback

Pure content change. `git revert <merge-commit>`, rebuild and deploy frontend.

### Phase 3 Rollback

D1 Time Travel to pre-reclassification bookmark. Capture bookmark BEFORE running retroactive steps.

## Known Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Q1 migration on ~1M row table could be slow | Medium | `ALTER TABLE ADD COLUMN` with DEFAULT is metadata-only in SQLite — instant, no table rewrite |
| Q1+Q3 merge conflict on sync-mint-burn.ts | Low | Documented merge order (Q1 first). Conflicts are additive (imports + metadata fields) |
| Q1+Q2 merge conflict on router.ts + api-endpoints.ts | Low | Documented merge order (Q1 first). Both add non-overlapping route registrations and endpoint definitions |
| Q1 retroactive classification on ~1M events | Medium | Batched admin endpoint (LIMIT 1000 per call). Run repeatedly until `done: true` |
| Q2 bridge addresses may be stale by deploy time | Low | Verify addresses on Etherscan before dispatch. Document "last verified" date |
| Q3 price heal adds latency to cron | Low | Runs only on non-error status. 500-event LIMIT caps work per cycle. Wrapped in try/catch (non-fatal) |
| Q4 threshold ($50K) may be too aggressive/conservative | Low | Tunable constant. Monitor NR coin count post-deploy. Can adjust without schema change |

## Orchestrator Protocol

1. Read PROGRESS.md to determine current state
2. Execute the next unchecked item in the phase checklist
3. Update PROGRESS.md immediately after each state change
4. For cmcs runs: create worktree → copy tickets → run → wait → review → merge
5. For merges: follow documented merge order, resolve conflicts per file ownership table
6. For deploys: D1 migration BEFORE code deploy (when applicable)
7. For retroactive steps: capture before-snapshot FIRST, then run, then after-snapshot

## When Codex Fails

1. `cmcs logs worktrees/<name>` — read the agent output
2. Identify the failure: wrong file path? Missing context? Type error? Test failure?
3. Fix the ticket (clarify instructions, add missing context, correct paths)
4. If code was partially written: review what exists, decide whether to fix manually or re-run
5. Re-run: `cmcs run worktrees/<name>`
6. Log the failure in PROGRESS.md incident log

## After Context Compaction

1. Read `agents/plans/flow-data-quality/PROGRESS.md` — this tells you exactly where you are
2. Read this file (`execution-handover.md`) — has all commands you need
3. Pick up at the next unchecked item in PROGRESS.md
4. Do NOT re-read the design document or implementation plan unless debugging a specific issue
