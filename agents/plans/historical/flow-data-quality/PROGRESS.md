# Flow Data Quality — Progress Tracker

**Last updated:** 2026-03-09

## Current State

**Active phase:** All phases complete.
**Next action:** Monitor next cron cycle for new metadata fields (atomicRoundtripsDetected, nullPricesHealed).

## Phase Checklist

### Phase 0: Preparation
- [x] Design document written and approved
- [x] Implementation plan written
- [x] Execution handover written
- [x] Progress tracker initialized
- [x] Tickets extracted into standalone files
- [x] Bridge address research — **DROPPED** (Q2 removed: all target bridges use lock/release, not burn/mint — no burn events to reclassify)
- [x] Verification Pass 1 (Orchestrator Quality) completed — issues found and fixed
- [x] Verification Pass 2 (Ticket Quality) completed — issues found and fixed
- [x] Verification Pass 3 (Coherence Loop) completed — 1 Critical + 1 High found and fixed, final state clean

### Phase 1: Data Quality Fixes (3 parallel worktrees)

#### Worktree: flow-q1-atomic-roundtrip
- [x] Worktree created
- [x] Tickets copied
- [x] cmcs run started
- [x] cmcs run completed (2/2 tickets)
- [x] Review checklist passed
- [x] Spec compliance: APPROVED (1 trivial fix: api-endpoints snapshot test)
- [x] Code quality: Approved (1 fix: largest event query filter)
- [x] Merged to main (commit: 8edb5830)
- [x] Worktree cleaned up

#### Worktree: flow-q3-auto-backfill
- [x] Worktree created
- [x] Tickets copied
- [x] cmcs run started
- [x] cmcs run completed (1/1 tickets)
- [x] Review checklist passed
- [x] Spec compliance: APPROVED
- [x] Code quality: Approved (no fixes needed)
- [x] Merged to main (commit: 755d82d3, conflict resolved in docs/mint-burn-flows.md)
- [x] Worktree cleaned up

#### Worktree: flow-q4-activity-gate
- [x] Worktree created
- [x] Tickets copied
- [x] cmcs run started
- [x] cmcs run completed (1/1 tickets)
- [x] Review checklist passed
- [x] Spec compliance: APPROVED
- [x] Code quality: Approved (2 fixes: JSDoc, daily-digest call site)
- [x] Merged to main (commit: 9b5061b7)
- [x] Worktree cleaned up

#### Phase 1 Gate
- [x] All 3 worktrees merged to main
- [x] `npm run build` passes on main
- [x] `cd worker && npx tsc --noEmit` passes on main
- [x] `npm test` passes on main (847 tests, up from 830 baseline)
- [x] D1 migration applied to production (0056_mint_burn_flow_type.sql)
- [x] Worker deployed (version: e8454125-75c9-43e1-9841-f345a2382a01)
- [x] Post-deploy smoke tests passed

### Phase 2: Methodology Versioning

#### Worktree: flow-methodology-v45
- [x] Worktree created
- [x] Tickets copied
- [x] cmcs run started
- [x] cmcs run completed (1/1 tickets)
- [x] Review checklist passed
- [x] Merged to main (commit: 53e472bd, fast-forward)
- [x] Worktree cleaned up
- [x] Post-deploy smoke test passed (methodology page renders v4.5)

### Phase 3: Retroactive Data Corrections (manual)
- [x] Before-snapshot captured (burn volume 30d, gauge score, NR coin count)
- [x] Q1 retroactive reclassification run (direct D1 SQL, batched per-stablecoin — admin endpoint timed out on 38K+ candidates)
- [x] Re-aggregation of affected hourly buckets (71,565 buckets)
- [x] After-snapshot captured
- [x] Impact report written (see below)

#### Phase 3 Impact Report

**Reclassification:** 84,912 events flagged as `atomic_roundtrip` across 24 stablecoins.

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| Burn volume 30d (D1 raw) | $70.80B | $60.51B | **-$10.29B (-14.5%)** |
| Gauge score | -4.74 | -3.12 | **+1.62 (less bearish)** |
| NR coins | 48 | 48 | 0 |
| Scored coins | 35 | 35 | 0 |

**Interpretation:** Flash-loan and atomic-arb roundtrips were inflating burn volumes by ~14.5%, which pushed the gauge score more negative. After reclassification, the gauge shifted from moderately bearish (-4.74) toward neutral (-3.12). Coin NR/scored counts were unaffected since the activity gate was already live.

**Method:** Admin endpoint (`POST /api/reclassify-atomic-roundtrips`) timed out due to N+1 query pattern on 38K+ candidate transactions. Reclassification was completed via direct D1 SQL batched per-stablecoin using `wrangler d1 execute --remote`.

## Incident Log

| Date | Severity | Description | Resolution |
|------|----------|-------------|------------|
| 2026-03-09 | Low | Admin reclassify endpoint timed out on 38K+ candidates (N+1 D1 queries) | Used direct D1 SQL per-stablecoin batches instead. Endpoint still useful for smaller future runs. |

## Design Change Log

| Date | Change | Reason |
|------|--------|--------|
| 2026-03-09 | Dropped Q2 (bridge expansion) | All 5 target bridges (Stargate, Across, Wormhole, Axelar, Hyperlane) use lock/release on Ethereum — tokens are transferred to bridge contracts, not burned. No burn events exist to reclassify. |
