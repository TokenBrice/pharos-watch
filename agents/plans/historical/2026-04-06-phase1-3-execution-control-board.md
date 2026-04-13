# Phase 1-3 Execution Control Board

Date: 2026-04-06  
Companion to:

- `agents/plans/2026-04-06-phase1-3-implementation-plan.md`
- `agents/specs/2026-04-06-characterization-fixture-tickets.md`

## Purpose

This board turns the phase1-3 implementation plan into an execution-ready control surface for a multi-agent repo state.

Use it for:

1. assigning exactly one owner per slice
2. creating worktrees and branches consistently
3. avoiding overlapping edits in the same lane
4. understanding which slices may be prepared in parallel versus merged in sequence

## Naming Convention

- Branch name: use the `branch` value from the ownership matrix
- Worktree path: use the `worktree` value from the ownership matrix
- One owner only per slice at a time
- If a slice touches a lane already owned by another active slice, do not start until the lane is clear

## Slice Ownership Matrix

| Slice | Lane | Branch | Worktree | Owner slot | Recommended owner profile | Start prerequisites | Merge gate | No-overlap paths |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `A1` | Governance/docs/process | `phase1-a1-docs-governance-hygiene` | `.worktrees/phase1-a1-docs-governance-hygiene` | `TBD` | docs + infra | none | none | `.env.example`, `README.md`, `docs/testing.md`, `.gitignore`, `scripts/lib/hotspot-ratchet-baseline.json` |
| `A2` | Auth/admin | `phase1-a2-public-api-auth-fix` | `.worktrees/phase1-a2-public-api-auth-fix` | `TBD` | worker auth | none | none | `worker/src/lib/api-keys*`, `worker/src/handlers/http/gates.ts`, auth docs |
| `A3` | DEWS | `phase1-a3-dews-baseline-fix` | `.worktrees/phase1-a3-dews-baseline-fix` | `TBD` | worker scoring | none | none | `worker/src/cron/compute-dews.ts`, `worker/src/lib/dews.ts`, DEWS docs |
| `A4` | DEX degraded-mode | `phase1-a4-dex-degraded-audit-log` | `.worktrees/phase1-a4-dex-degraded-audit-log` | `TBD` | worker reliability | none | none | `worker/src/cron/dex-liquidity/*`, `worker/src/api/api-key-audit-log.ts` |
| `A5` | Frontend analytics/admin | `phase1-a5-admin-access-cleanup` | `.worktrees/phase1-a5-admin-access-cleanup` | `TBD` | frontend | none | none | `src/lib/admin-access.ts`, `src/app/admin/client.tsx`, `src/hooks/use-admin-polling-query.ts` |
| `B1` | Status contract | `phase2-b1-status-metadata-contract` | `.worktrees/phase2-b1-status-metadata-contract` | `TBD` | shared contracts | none | Gate A | `shared/types/status.ts`, status parser module, status consumers |
| `B2` | Cycle enforcement | `phase2-b2-cycle-reporting` | `.worktrees/phase2-b2-cycle-reporting` | `TBD` | infra/tooling | none | Gate A | `scripts/check-shared-cycles.mjs`, `scripts/lib/validate-contract.mjs`, `package.json`, cycle docs |
| `B3` | Cron architecture | `phase2-b3-cron-contract-foundation` | `.worktrees/phase2-b3-cron-contract-foundation` | `TBD` | worker architecture | `B2` prepared or merged | Gate A | `worker/src/cron/shared/*`, `worker/src/cron/sync-stablecoins*`, `worker/src/cron/sync-yield-data.ts`, `worker/src/cron/compute-dews.ts`, `worker/src/cron/yield-sync/*` |
| `B4` | Auth/admin | `phase2-b4-api-keys-split` | `.worktrees/phase2-b4-api-keys-split` | `TBD` | worker auth | `A2` merged, `CHAR-B4-01` complete | Gate A | `worker/src/lib/api-keys*`, auth tests |
| `B5` | Frontend analytics | `phase2-b5-contagion-graph-model` | `.worktrees/phase2-b5-contagion-graph-model` | `TBD` | frontend | none | Gate A | `src/components/contagion-graph.tsx`, helper modules |
| `B6` | Yield | `phase2-b6-yield-coordinator-split` | `.worktrees/phase2-b6-yield-coordinator-split` | `TBD` | worker yield | `B3` merged, `CHAR-B6-01` complete | Gate A | `worker/src/cron/sync-yield-data.ts`, `worker/src/cron/__tests__/sync-yield-data.test.ts`, yield docs if semantics move |
| `B7` | Governance/docs/process | `phase2-b7-governance-checks` | `.worktrees/phase2-b7-governance-checks` | `TBD` | infra/tooling + docs | `A1` merged preferred | Gate A | `scripts/lib/hotspot-ratchet.mjs`, `scripts/lib/validate-contract.mjs`, `package.json`, `.env.example`, `README.md`, `docs/testing.md`, `docs/deployment-process.md`, CI workflow files |
| `C1` | Cycle enforcement | `phase3-c1-live-reserves-cycle-break` | `.worktrees/phase3-c1-live-reserves-cycle-break` | `TBD` | worker architecture | `B2` merged | Gate B | `worker/src/lib/live-reserves-store-shared.ts`, `worker/src/lib/live-reserves-store-parsing.ts` |
| `C2` | Stablecoin sync | `phase3-c2-stablecoin-phase-contracts` | `.worktrees/phase3-c2-stablecoin-phase-contracts` | `TBD` | worker architecture | `B2` and `B3` merged, `CHAR-C2-01` complete | Gate B | `worker/src/cron/sync-stablecoins*`, pricing docs |
| `C3` | Stablecoin sync | `phase3-c3-price-enrichment-family-split` | `.worktrees/phase3-c3-price-enrichment-family-split` | `TBD` | worker pricing | `C2` merged, `CHAR-C3-01` complete | Gate B | `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts`, new `enrich-prices/*`, pricing docs |
| `C4` | Yield | `phase3-c4-yield-resolver-families` | `.worktrees/phase3-c4-yield-resolver-families` | `TBD` | worker yield | `B3` and `B6` merged, `CHAR-C4-01` complete | Gate B | `worker/src/cron/yield-sync/*`, `worker/src/cron/sync-yield-data.ts`, yield docs |
| `C5` | DEWS | `phase3-c5-dews-staged-decomposition` | `.worktrees/phase3-c5-dews-staged-decomposition` | `TBD` | worker scoring | `A3` and `B3` merged, `CHAR-C5-01` complete | Gate B | `worker/src/cron/compute-dews.ts`, `worker/src/lib/dews.ts`, DEWS docs |
| `C6` | Governance/docs/process | `phase3-c6-hotspot-enrollment-automation` | `.worktrees/phase3-c6-hotspot-enrollment-automation` | `TBD` | infra/tooling | `B7` merged | Gate B | `scripts/lib/hotspot-ratchet*`, docs/process material |
| `C7` | Cycle enforcement | `phase3-c7-blocking-cycle-enforcement` | `.worktrees/phase3-c7-blocking-cycle-enforcement` | `TBD` | infra/tooling | `C1` and `C2` merged, cycle report clean | Gate C | `scripts/check-shared-cycles.mjs`, `scripts/lib/validate-contract.mjs`, `package.json`, `.github/workflows/validate-ci.yml`, cycle docs |

## Lane Queues

This is the merge order keyed to the ownership map.

| Lane | Queue |
| --- | --- |
| Governance/docs/process | `A1 -> B7 -> C6` |
| Auth/admin | `A2 -> B4` |
| DEWS | `A3 -> C5` |
| DEX degraded-mode | `A4` |
| Frontend analytics/admin | `A5` and `B5` may be prepared in parallel; merge independently |
| Status contract | `B1` |
| Cycle enforcement | `B2 -> C1 -> C2 -> C7` |
| Cron architecture | `B2 -> B3 -> B6 -> C4` and `B2 -> B3 -> C2 -> C3` and `A3 -> B3 -> C5` |

## Global Merge Board

This board is for merge readiness, not just branch creation.

### Ready Now

- `A1`
- `A2`
- `A3`
- `A4`
- `A5`

### Can Be Prepared Early But Must Wait For Gate A To Merge

- `B1`
- `B2`
- `B5`
- `B7`

### Blocked On Earlier Slice

| Slice | Blocked by |
| --- | --- |
| `B3` | `B2` |
| `B4` | `A2` |
| `B6` | `B3` |
| `C1` | `B2` |
| `C2` | `B2`, `B3` |
| `C3` | `C2` |
| `C4` | `B3`, `B6` |
| `C5` | `A3`, `B3` |
| `C6` | `B7` |
| `C7` | `C1`, `C2`, clean expanded cycle report |

### Must Merge Last In Lane

- `C7` in the cycle-enforcement lane
- `C6` after governance checks exist in `B7`
- `C3` after `C2`
- `C4` after `B6`
- `C5` after `A3` and `B3`

## Assignment Procedure

1. Pick the highest-priority ready slice whose lane is clear.
2. Assign one owner in the `Owner slot`.
3. Create the matching branch and worktree.
4. Before coding, verify that no active branch owns any path listed in `No-overlap paths`.
5. Before merge, rebase onto latest `main`, rerun targeted tests, then run `npm run test:merge-gate`.

## Conflict Procedure

If two active branches collide in the same lane:

1. The later-starting slice rebases and checks whether the overlap is real.
2. If the overlap is only docs/process, prefer moving that diff into the earlier slice.
3. If the overlap is runtime logic, stop and re-slice instead of doing a large manual conflict merge.
4. Update the board so only one active owner remains on the lane.
