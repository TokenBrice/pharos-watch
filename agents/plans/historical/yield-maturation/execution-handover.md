# Yield Feature Maturation — Execution Handover

---

## What This Does

Graduates the `/yield` feature from experimental to mature across 6 phases: backend reliability + schema changes, coverage config expansion, frontend foundation (types + hooks + chart component), leaderboard enhancements (tabs, filters, warnings, PYS tooltip, expandable rows), stablecoin detail page yield section, and polish (remove experimental badge, update docs). 20 tickets across 6 worktrees. All changes are additive — no breaking API changes, no data migrations.

---

## File Inventory

```
agents/plans/yield-maturation/
  2026-03-09-yield-maturation-design.md    # Design document (why + what)
  implementation-plan.md                    # Phases, worktrees, gates, dispatch
  execution-handover.md                     # This file (operational runbook)
  PROGRESS.md                              # Single source of truth for state
  tickets/
    phase1a-backend/
      TICKET-001.md                        # Schema migration
      TICKET-002.md                        # Data-stale detection
      TICKET-003.md                        # Cross-source validation
      TICKET-004.md                        # Graceful per-coin fallback
      TICKET-005.md                        # Warning signals in history + median APY
      TICKET-006.md                        # Yield-history API update
      TICKET-007.md                        # Backend tests
    phase1b-coverage/
      TICKET-001.md                        # Fix DL pool map mismatches
      TICKET-002.md                        # Expand lending allowlist
    phase2-frontend-foundation/
      TICKET-001.md                        # Update shared types
      TICKET-002.md                        # Create useYieldHistory hook
      TICKET-003.md                        # Build YieldHistoryChart component
    phase3d-leaderboard/
      TICKET-001.md                        # Native/Lending tabs
      TICKET-002.md                        # Warning signals column
      TICKET-003.md                        # Yield type + warning filters
      TICKET-004.md                        # PYS breakdown tooltip
      TICKET-005.md                        # Expandable rows with chart
    phase3e-detail-page/
      TICKET-001.md                        # YieldDetailSection component
      TICKET-002.md                        # Integrate into detail page
    phase4-polish/
      TICKET-001.md                        # Remove experimental + update docs
```

---

## Pre-Flight Checks

Run before starting any phase:

```bash
# 1. Confirm clean working tree
git status  # expect: clean, on main

# 2. Confirm main is up to date
git pull origin main

# 3. Confirm cmcs initialized
cmcs status

# 4. Confirm build passes
npm run build && cd worker && npx tsc --noEmit && cd .. && npm test

# 5. Confirm tickets exist
ls agents/plans/yield-maturation/tickets/
```

---

## Execution Commands Per Phase

### Phase 0: Research (Manual)

No cmcs commands. Use browser/API to:
1. Fetch `https://yields.llama.fi/pools` and audit yield-bearing coins
2. Evaluate candidate lending protocols

**Output:** Save research results to `agents/plans/yield-maturation/phase0-research-output.md` with:
- List of coins missing DL coverage and their candidate pool UUIDs
- List of approved protocols with their DL slugs and tier assignments

**Amend tickets:** Replace the `AMENDMENT PLACEHOLDER` sections in `tickets/phase1b-coverage/TICKET-001.md` and `TICKET-002.md` with the exact entries from the research output before dispatching Phase 1B.

### Phase 1A + 1B (parallel)

```bash
# Create worktrees
cmcs worktree create yield-maturation-backend
cmcs worktree create yield-maturation-coverage

# Copy tickets
cp agents/plans/yield-maturation/tickets/phase1a-backend/*.md worktrees/yield-maturation-backend/.cmcs/tickets/
cp agents/plans/yield-maturation/tickets/phase1b-coverage/*.md worktrees/yield-maturation-coverage/.cmcs/tickets/

# Launch parallel
cmcs run worktrees/yield-maturation-backend 2>&1 &
cmcs run worktrees/yield-maturation-coverage 2>&1 &
wait
```

### Phase 1 — D1 Migration (manual, after Phase 1A merge)

```bash
# 1. Record pre-migration bookmark for rollback
cd worker
npx wrangler d1 time-travel info stablecoin-db  # save the bookmark value

# 2. Apply migration
npx wrangler d1 migrations apply stablecoin-db --remote

# 3. Verify
npx wrangler d1 execute stablecoin-db --remote --command "PRAGMA table_info(yield_history)" | grep warning_signals
```

**Record the pre-migration bookmark in PROGRESS.md** under the Phase 1A section for rollback reference.

### Phase 2

```bash
cmcs worktree create yield-maturation-frontend-foundation
cp agents/plans/yield-maturation/tickets/phase2-frontend-foundation/*.md worktrees/yield-maturation-frontend-foundation/.cmcs/tickets/
cmcs run worktrees/yield-maturation-frontend-foundation
```

### Phase 3D + 3E (parallel)

```bash
cmcs worktree create yield-maturation-leaderboard
cmcs worktree create yield-maturation-detail-page
cp agents/plans/yield-maturation/tickets/phase3d-leaderboard/*.md worktrees/yield-maturation-leaderboard/.cmcs/tickets/
cp agents/plans/yield-maturation/tickets/phase3e-detail-page/*.md worktrees/yield-maturation-detail-page/.cmcs/tickets/

cmcs run worktrees/yield-maturation-leaderboard 2>&1 &
cmcs run worktrees/yield-maturation-detail-page 2>&1 &
wait
```

### Phase 4

```bash
cmcs worktree create yield-maturation-polish
cp agents/plans/yield-maturation/tickets/phase4-polish/*.md worktrees/yield-maturation-polish/.cmcs/tickets/
cmcs run worktrees/yield-maturation-polish
```

---

## Review Checklists Per Phase

### Phase 1A Review

```bash
cd worktrees/yield-maturation-backend

# Build gates
cd worker && npx tsc --noEmit && cd ..
npm test
npm run build

# Spot checks
# TICKET-001: Migration file exists
ls worker/migrations/*warning_signals* | wc -l  # expect: 1

# TICKET-002: Stale threshold constant exported
grep -c "STALE_THRESHOLD_MS" worker/src/cron/yield-helpers.ts  # expect: >= 1

# TICKET-002: Stale detection in sync
grep -c "data-stale" worker/src/cron/sync-yield-data.ts  # expect: >= 1

# TICKET-003: Cross-source validation logging
grep -c "APY divergence" worker/src/cron/sync-yield-data.ts  # expect: >= 1

# TICKET-004: Fallback logging on missing UUID
grep -c "not found in DL response" worker/src/cron/yield-helpers.ts  # expect: >= 1

# TICKET-005: warning_signals in history INSERT
grep -c "warning_signals" worker/src/cron/sync-yield-data.ts  # expect: >= 2

# TICKET-005: medianApy in cached response
grep -c "medianApy" worker/src/cron/sync-yield-data.ts  # expect: >= 1

# TICKET-006: warning_signals in history API
grep -c "warning_signals\|warningSignals" worker/src/api/yield-history.ts  # expect: >= 2
```

### Phase 1B Review

```bash
cd worktrees/yield-maturation-coverage

cd worker && npx tsc --noEmit && cd ..
npm test
npm run build

# Spot checks
# TICKET-001: Pool map entries updated (count should be >= 21)
grep -c ":" worker/src/cron/yield-config.ts | head -1  # rough check

# TICKET-002: Allowlist expanded (count should be > 17)
grep -c "\"" worker/src/cron/yield-config.ts | head -1  # rough check — verify manually
```

### Phase 2 Review

```bash
cd worktrees/yield-maturation-frontend-foundation

npm run build
npm test

# TICKET-001: medianApy in types
grep -c "medianApy" shared/types/index.ts  # expect: >= 1

# TICKET-001: YieldHistoryPoint type
grep -c "YieldHistoryPoint" shared/types/index.ts  # expect: >= 1

# TICKET-002: Hook file exists
test -f src/hooks/use-yield-history.ts && echo "OK" || echo "MISSING"

# TICKET-003: Chart component exists
test -f src/components/yield-history-chart.tsx && echo "OK" || echo "MISSING"

# TICKET-003: Chart uses Recharts
grep -c "ResponsiveContainer\|ComposedChart\|LineChart" src/components/yield-history-chart.tsx  # expect: >= 1

# TICKET-003: Reference lines present
grep -c "ReferenceLine" src/components/yield-history-chart.tsx  # expect: >= 2 (T-bill + median)
```

### Phase 3D Review

```bash
cd worktrees/yield-maturation-leaderboard

npm run build
npm test

# TICKET-001: Tabs exist
grep -c "native\|lending" src/components/yield-leaderboard.tsx  # expect: >= 4

# TICKET-002: Warning signals column
grep -c "WARNING_SIGNAL_LABELS\|warning_signal_labels\|warningSignals" src/components/yield-leaderboard.tsx  # expect: >= 2

# TICKET-003: Yield type filter
grep -c "YIELD_TYPE_LABELS\|activeYieldTypes\|yieldType" src/components/yield-leaderboard.tsx  # expect: >= 3

# TICKET-004: PYS tooltip
grep -c "riskPenalty\|yieldEfficiency\|sustainabilityMult\|Consistency" src/components/yield-leaderboard.tsx  # expect: >= 2

# TICKET-005: Expandable rows
grep -c "expandedId\|YieldHistoryChart" src/components/yield-leaderboard.tsx  # expect: >= 2

# TICKET-005: medianApy passed from client
grep -c "medianApy" src/app/yield/client.tsx  # expect: >= 1
```

### Phase 3E Review

```bash
cd worktrees/yield-maturation-detail-page

npm run build
npm test

# TICKET-001: Component exists
test -f src/components/yield-detail-section.tsx && echo "OK" || echo "MISSING"

# TICKET-001: Uses YieldHistoryChart
grep -c "YieldHistoryChart" src/components/yield-detail-section.tsx  # expect: >= 1

# TICKET-002: Detail page integration
grep -c "yield\|Yield" src/app/stablecoin/\\[id\\]/client.tsx  # expect: >= 2
```

### Phase 4 Review

```bash
cd worktrees/yield-maturation-polish

npm run build
npm test

# No experimental markers remain
grep -r "experimental" src/app/yield/  # expect: 0 results

# Docs updated
grep -c "medianApy" docs/yield-intelligence.md  # expect: >= 1
grep -c "data-stale" docs/yield-intelligence.md  # expect: >= 1
grep -c "YieldHistoryChart" docs/yield-intelligence.md  # expect: >= 1
grep -c "YieldDetailSection" docs/yield-intelligence.md  # expect: >= 1
```

---

## Merge Instructions

### Phase 1 (parallel worktrees)

Merge order: **1A first, then 1B.** No expected conflicts (non-overlapping files). If 1B depends on 1A's type changes, rebase 1B onto updated main before merging.

```bash
# After review passes
cd worktrees/yield-maturation-backend
git checkout main && git merge yield-maturation-backend
# Run D1 migration (see manual step above)
# Then merge 1B
cd worktrees/yield-maturation-coverage
git checkout main && git pull && git merge yield-maturation-coverage
```

### Phase 3 (parallel worktrees)

Merge order: **3D first, then 3E.** No file overlap, but 3E TICKET-001 checks for `WARNING_SIGNAL_LABELS` duplication from 3D and extracts to a shared file if found.

```bash
cd worktrees/yield-maturation-leaderboard
git checkout main && git merge yield-maturation-leaderboard
cd worktrees/yield-maturation-detail-page
git checkout main && git pull && git merge yield-maturation-detail-page
```

**Post-merge cleanup:** After both are merged, verify that `WARNING_SIGNAL_LABELS` is not duplicated. If 3E defined its own copy (because it ran in parallel and couldn't see 3D's output), manually extract to `src/lib/yield-constants.ts` and update both imports. This is a minor manual step.

### All other phases

Single worktree — standard merge:
```bash
git checkout main && git merge <branch>
```

---

## Post-Deploy Smoke Tests

### After Phase 1A deploy

```bash
# Yield rankings still served (no regression)
curl -s "https://api.pharos.watch/api/yield-rankings" | jq '.rankings | length'  # expect: > 0

# medianApy present in response (NOTE: may take up to 30 min for the next cron cycle to write new cache format)
curl -s "https://api.pharos.watch/api/yield-rankings" | jq '.medianApy'  # expect: number > 0 (after next cron run)

# Yield history includes warningSignals (NOTE: only new data points will have signals; historical rows may return null)
curl -s "https://api.pharos.watch/api/yield-history?stablecoin=usde-ethena&days=7" | jq '.[0].warningSignals'  # expect: array (possibly empty/null for old points)
```

### After Phase 1B deploy

```bash
# Rankings count should increase (more coins with yield data)
curl -s "https://api.pharos.watch/api/yield-rankings" | jq '.rankings | length'  # expect: >= previous count
```

### After Phase 2/3/4 deploy

Frontend-only changes — verify by loading pages:
- `https://pharos.watch/yield/` — leaderboard has tabs, filters, expandable rows
- `https://pharos.watch/stablecoin/usde-ethena/` — yield section visible
- `https://pharos.watch/yield/` — no "experimental" badge

---

## Rollback Procedures Per Phase

### Phase 1A Rollback

```bash
# Code rollback
git revert <merge-commit-hash>
git push origin main

# D1 rollback (if migration was applied)
# warning_signals column is nullable and unused by old code — safe to leave.
# If needed: D1 Time Travel
cd worker
npx wrangler d1 time-travel info stablecoin-db
npx wrangler d1 time-travel restore stablecoin-db --bookmark=<pre-migration-bookmark>
```

### Phase 1B Rollback

```bash
# Code-only rollback (config changes)
git revert <merge-commit-hash>
git push origin main
# Next cron cycle will use old pool maps / allowlist
```

### Phase 2 Rollback

```bash
git revert <merge-commit-hash>
git push origin main
# Frontend-only — no data impact
```

### Phase 3D/3E Rollback

```bash
git revert <merge-commit-hash>
git push origin main
# Frontend-only — no data impact
```

### Phase 4 Rollback

```bash
git revert <merge-commit-hash>
git push origin main
# Re-adds experimental badge — cosmetic only
```

---

## Known Risks and Mitigations

| Risk | Phase | Severity | Mitigation |
|------|-------|----------|------------|
| DL pool UUID drift breaks static maps | 1B | Medium | Graceful fallback (1A-004) catches at runtime. Cross-source validation (1A-003) flags anomalies. |
| New lending protocols surface low-quality pools | 1B | Low | Quality gates enforced. New protocols enter Tier 3. |
| `medianApy` is 0 when no coins have TVL | 1A | Low | Frontend hides reference line when `medianApy <= 0`. |
| Schema migration fails on prod D1 | 1A | Low | Single nullable ALTER TABLE. D1 Time Travel for rollback. |
| YieldHistoryChart performance with 1y data | 2 | Medium | Data points are ~48/day for 365d = ~17K points. Recharts handles this. If slow, downsample in the API (not planned unless needed). |
| Leaderboard re-render on tab/filter change | 3D | Low | Client-side filtering on already-fetched data. No new API calls on tab switch. |
| Detail page yield section weight | 3E | Medium | Lazy-loaded component. Reuses `useYieldRankings` data (already fetched). Only history chart triggers new API call. |
| WARNING_SIGNAL_LABELS duplicated across leaderboard and detail section | 3D+3E | Low | Both agents will define their own copy (parallel execution). Post-merge cleanup: extract to `src/lib/yield-constants.ts`. |
| Phase 1B can merge independently of Phase 2 | 1B/2 | Info | Phase 2 depends only on 1A. Phase 1B can merge before, during, or after Phase 2 — no dependency. |

---

## Orchestrator Protocol

For each phase:

1. **Update PROGRESS.md** — mark "Worktree created"
2. **Create worktree** — `cmcs worktree create <name>`
3. **Copy tickets** — `cp` from `agents/plans/yield-maturation/tickets/<phase>/`
4. **Launch cmcs** — `cmcs run <worktree-path>`
5. **Wait for completion** — `cmcs wait <worktree-path>` or poll `cmcs status`
6. **Review output** — run review checklist commands in the worktree
7. **Fix failures** — if tickets failed: read logs (`cmcs logs`), fix ticket or code, re-run
8. **Update PROGRESS.md** — record pass/fail counts
9. **Merge to main** — follow merge instructions
10. **Run smoke tests** — if backend changes, verify API responses
11. **Update PROGRESS.md** — record merge commit hash
12. **Clean up worktree** — `cmcs worktree remove <name>` (after confirming merge)

---

## When Codex Fails

1. **Check logs:** `cmcs logs worktrees/<name>`
2. **Identify failure:** Which ticket? What error? Type error? Test failure? Wrong file path?
3. **Common fixes:**
   - Wrong file path → update ticket with correct path, re-run
   - Missing import → add import to ticket instructions, re-run
   - Type error → check if upstream type changes from a prior ticket landed correctly
   - Test failure → read the test output, determine if the test or the implementation is wrong
4. **Re-run:** `cmcs run worktrees/<name>` (processes remaining undone tickets)
5. **If stuck after 2 retries:** Fix the code manually in the worktree, mark ticket done, continue

---

## After Context Compaction

1. Read `agents/plans/yield-maturation/PROGRESS.md` — this tells you exactly where you are
2. Read this file (`execution-handover.md`) — it has everything you need to continue
3. Pick up from the "Next action" line in PROGRESS.md
4. If between phases: run pre-flight checks before starting the next phase

---

## Drift Detection

If the project spans multiple sessions, run before each new phase:

```bash
# Check if yield files changed since last phase
git log --oneline --since="$(date -d '7 days ago' +%Y-%m-%d)" -- \
  worker/src/cron/yield-*.ts \
  worker/src/cron/sync-yield-data.ts \
  worker/src/api/yield-history.ts \
  src/components/yield-*.tsx \
  src/app/yield/ \
  shared/types/index.ts

# If changes found: review them, update affected tickets if line numbers shifted
```
