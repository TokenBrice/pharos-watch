# Flow Data Quality — Implementation Plan

## Execution Strategy

- **Phases:** 3 (Phase 1 parallel, Phase 2 sequential, Phase 3 manual)
- **Worktrees:** 5 total (4 parallel in Phase 1 + 1 in Phase 2)
- **Tickets:** 6 total (1+2+1+1 in Phase 1, 1 in Phase 2)
- **D1 migrations:** 1 (Q1: `0056_mint_burn_flow_type.sql`)
- **Admin endpoints added:** 2 (reclassify-atomic-roundtrips, reclassify-bridge-burns)

## Phase Breakdown

### Phase 1: Data Quality Fixes (parallel)

Four worktrees run simultaneously. Merge order matters due to two file overlaps (see Merge Instructions in execution-handover.md).

| Worktree | Tickets | Model | Key Files |
|----------|---------|-------|-----------|
| `flow-q4-activity-gate` | 1 | codex | scoring.ts, flows API, scoring tests |
| `flow-q1-atomic-roundtrip` | 2 (sequential) | gpt-5.4 | migration, types, parse, persistence, sync cron, new detection module, new admin endpoint, tests |
| `flow-q3-auto-backfill` | 1 | codex | new price-heal module, sync cron, tests |
| `flow-q2-bridge-expansion` | 1 | codex | contracts config, new admin endpoint, tests |

**Dependency notes:**
- Q2 requires Phase 0 bridge address research before dispatch
- Q1 TICKET-002 depends on Q1 TICKET-001 (schema must exist before aggregation filter)
- No cross-worktree dependencies during development
- Merge order: Q1 first, then Q2, then Q3, then Q4 (minimizes conflict resolution)

### Phase 2: Methodology Versioning (sequential, after Phase 1 merged)

| Worktree | Tickets | Model | Key Files |
|----------|---------|-------|-----------|
| `flow-methodology-v45` | 1 | spark | mint-burn-flow-version.ts, docs/mint-burn-flows.md |

**Gate:** Phase 1 fully merged, built, and deployed.

### Phase 3: Retroactive Data Corrections (manual)

No worktrees. Manual admin API calls to reclassify existing data.

1. Capture before-snapshot (SQL queries in execution-handover.md)
2. Run Q1 retroactive: `POST /api/reclassify-atomic-roundtrips` (repeat until `done: true`)
3. Run Q2 retroactive: `POST /api/reclassify-bridge-burns?stablecoin=<id>` for each configured coin
4. Capture after-snapshot and compute impact

## Gate Criteria

**Phase 1 → Phase 2:**
```bash
npm run build                          # frontend builds
cd worker && npx tsc --noEmit          # worker type-checks
npm test                               # all tests pass
npm run test:merge-gate                # merge gate (lint + type-check + test)
```
Plus post-deploy smoke tests (see execution-handover.md).

**Phase 2 → Phase 3:**
```bash
npm run build                          # methodology page renders
```

## Manual Steps

| Step | When | Runbook |
|------|------|---------|
| D1 migration 0056 | Before deploying Q1 code | `wrangler d1 migrations apply stablecoin-db --remote` |
| Retroactive roundtrip classification | After Phase 1 deploy | POST /api/reclassify-atomic-roundtrips |
| Retroactive bridge reclassification | After Phase 1 deploy | POST /api/reclassify-bridge-burns |

## File Ownership Per Worktree

### flow-q4-activity-gate
- **Modify:** `worker/src/lib/mint-burn-scoring.ts`
- **Modify:** `worker/src/api/mint-burn-flows.ts` (line ~439, computeFlowIntensity call)
- **Modify:** `worker/src/lib/__tests__/mint-burn-scoring.test.ts`

### flow-q1-atomic-roundtrip
- **Create:** `worker/migrations/0056_mint_burn_flow_type.sql`
- **Modify:** `worker/src/lib/mint-burn-pipeline/types.ts`
- **Modify:** `worker/src/lib/mint-burn-pipeline/parse.ts`
- **Modify:** `worker/src/lib/mint-burn-pipeline/persistence.ts`
- **Create:** `worker/src/lib/mint-burn-pipeline/roundtrip-detection.ts`
- **Modify:** `worker/src/cron/sync-mint-burn.ts` (import + counter + metadata)
- **Create:** `worker/src/api/reclassify-atomic-roundtrips.ts`
- **Modify:** `worker/src/router.ts` (route registration + import)
- **Modify:** `shared/lib/api-endpoints.ts` (endpoint definition)
- **Create:** `worker/src/lib/__tests__/mint-burn-roundtrip.test.ts`
- **Modify:** `worker/src/lib/__tests__/mint-burn-pipeline.test.ts`

### flow-q3-auto-backfill
- **Create:** `worker/src/lib/mint-burn-pipeline/price-heal.ts`
- **Modify:** `worker/src/cron/sync-mint-burn.ts` (import + tail-end step + metadata)
- **Create:** `worker/src/lib/__tests__/mint-burn-price-heal.test.ts`

### flow-q2-bridge-expansion
- **Modify:** `worker/src/lib/mint-burn-contracts.ts`
- **Create:** `worker/src/api/reclassify-bridge-burns.ts`
- **Modify:** `worker/src/router.ts` (route registration + import)
- **Modify:** `shared/lib/api-endpoints.ts` (endpoint definition)

### flow-methodology-v45 (Phase 2)
- **Modify:** `shared/lib/mint-burn-flow-version.ts`
- **Modify:** `docs/mint-burn-flows.md`

### Known File Overlaps (Phase 1)

| File | Worktrees | Conflict Risk | Resolution |
|------|-----------|---------------|------------|
| `worker/src/cron/sync-mint-burn.ts` | Q1 + Q3 | Trivial — both add imports at top and fields to metadata object | Merge Q1 first, then Q3 resolves by adding its import/field alongside Q1's |
| `worker/src/router.ts` | Q1 + Q2 | Trivial — both add new route registrations + imports | Merge Q1 first, then Q2 adds its route/import below Q1's |
| `shared/lib/api-endpoints.ts` | Q1 + Q2 | Trivial — both add new endpoint definitions | Merge Q1 first, then Q2 adds its definition below Q1's |

## Worktree Dispatch Summary

```bash
# Phase 1 — create all worktrees
cmcs worktree create flow-q4-activity-gate
cmcs worktree create flow-q1-atomic-roundtrip
cmcs worktree create flow-q3-auto-backfill
cmcs worktree create flow-q2-bridge-expansion

# Copy tickets to each worktree
cp agents/plans/flow-data-quality/tickets/phase1-q4-activity-gate/* worktrees/flow-q4-activity-gate/.cmcs/tickets/
cp agents/plans/flow-data-quality/tickets/phase1-q1-atomic-roundtrip/* worktrees/flow-q1-atomic-roundtrip/.cmcs/tickets/
cp agents/plans/flow-data-quality/tickets/phase1-q3-auto-backfill/* worktrees/flow-q3-auto-backfill/.cmcs/tickets/
cp agents/plans/flow-data-quality/tickets/phase1-q2-bridge-expansion/* worktrees/flow-q2-bridge-expansion/.cmcs/tickets/

# Launch all in parallel
cmcs run worktrees/flow-q4-activity-gate 2>&1 &
cmcs run worktrees/flow-q1-atomic-roundtrip 2>&1 &
cmcs run worktrees/flow-q3-auto-backfill 2>&1 &
cmcs run worktrees/flow-q2-bridge-expansion 2>&1 &
wait

# Phase 2 — after Phase 1 fully merged
cmcs worktree create flow-methodology-v45
cp agents/plans/flow-data-quality/tickets/phase2-methodology/* worktrees/flow-methodology-v45/.cmcs/tickets/
cmcs run worktrees/flow-methodology-v45
```

## Supporting Artifacts

| Artifact | Location | Purpose |
|----------|----------|---------|
| Design document | `agents/plans/flow-data-quality/2026-03-09-flow-data-quality-design.md` | Approved design decisions |
| Original inline plan | `agents/plans/2026-03-09-flow-data-quality-impl.md` | Reference (superseded by this folder) |
| Bridge address research | TBD (Phase 0 output) | Feeds into Q2 ticket |
