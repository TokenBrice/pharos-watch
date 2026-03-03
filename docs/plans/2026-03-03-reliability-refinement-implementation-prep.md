# Reliability Refinement Implementation Prep (Parallel-Safe)

**Date:** 2026-03-03  
**Status:** Ready for execution  
**Depends on:** `docs/plans/2026-03-03-reliability-maintainability-resilience-refinement-plan.md`  
**Constraint:** Another agent is actively migrating `sync-mint-burn.ts` to Alchemy.

## 1. Purpose

This prep document turns the approved refinement plan into an execution-safe protocol for multi-agent implementation, with strict conflict controls around the in-flight Alchemy migration.

## 2. Parallel Work Safety Protocol

## 2.1 Protected Files (Do Not Touch Until Alchemy PR Merges)

- `worker/src/cron/sync-mint-burn.ts`
- `worker/src/lib/alchemy-logs.ts` (if created by parallel PR)
- `worker/src/cron/__tests__/sync-mint-burn.test.ts`
- `worker/src/lib/constants.ts` entries explicitly introduced for Alchemy migration
- Any new migration file created by the Alchemy PR

## 2.2 Shared/Risky Files (Touch Only in isolated, minimal diffs)

- `worker/src/index.ts` (cron orchestration)
- `worker/src/lib/db.ts` (shared infra helpers)
- `worker/src/lib/circuit-breaker.ts`
- `docs/worker-infrastructure.md`
- `docs/data-pipeline.md`

Rule: one concern per PR, and include a short "parallel-compatibility" note in each PR body.

## 2.3 Safe-Now Files (Preferred)

- `src/lib/api.ts`
- `src/lib/types.ts`
- `worker/src/lib/api-utils.ts`
- `worker/src/lib/__tests__/*` (new targeted tests)
- `worker/src/api/__tests__/*` (critical contract tests)
- `.github/workflows/deploy-cloudflare.yml`
- `vitest.config.ts`
- `scripts/*` (coverage/invariant helper scripts)
- `docs/testing.md`

## 3. Merge Strategy With Parallel Alchemy Work

1. Land all frontend strict contract changes first (no worker cron collision).
2. Land worker pre-write validation on non-mint-burn cron writers first.
3. Defer lease wrapper wiring for the `3,23,43` slot until Alchemy PR is merged.
4. After Alchemy PR merge, perform one focused integration PR for cron lease orchestration reconciliation in `worker/src/index.ts`.

## 4. Branching and Rebase Protocol

1. Create dedicated branch: `chore/reliability-refinement-prep` (or equivalent).
2. Keep PRs under ~400 LOC whenever possible.
3. Rebase before touching `worker/src/index.ts`.
4. For `worker/src/index.ts`, use "append-only" edits in clearly delimited blocks to minimize conflict risk.

## 5. Implementation Slices (Parallel-Safe)

## Slice A (safe now): Strict contracts in frontend

- Files: `src/lib/api.ts`, `src/lib/types.ts`, `src/lib/__tests__/...`
- Output: strict endpoint policy + typed schema error behavior.

## Slice B (safe now): Worker pre-write validation for non-mint-burn critical caches

- Files: `worker/src/cron/sync-stablecoins.ts`, `worker/src/cron/sync-yield-data.ts`, `worker/src/cron/dex-liquidity/*`, shared validator helper.
- Avoid: `sync-mint-burn.ts`.

## Slice C (safe now): CI risk gates

- Files: workflow/scripts/tests only.
- Output: invariant and critical-contract gates.

## Slice D (deferred until Alchemy merge): Lease orchestration in `index.ts`

- Wire leases to all jobs except keep mint-burn path untouched until reconciliation.
- After merge, apply final pass across `3,23,43` block.

## 6. Reconciliation Checklist (Post-Alchemy Merge)

1. Confirm cron dependencies still hold:
- `sync-blacklist` and `sync-mint-burn` share intended limiter/circuit behavior.
- Slot-level connection budgets are still within 6 concurrent fetch limit.

2. Confirm lease wrapping for both jobs in `3,23,43` block.

3. Confirm no stale references to Etherscan-only mint-burn assumptions remain in docs and tests.

4. Re-run targeted tests:
- `worker/src/cron/__tests__/sync-mint-burn.test.ts`
- `worker/src/cron/__tests__/sync-blacklist.test.ts`
- `worker/src/api/__tests__/mint-burn-*.test.ts`

## 7. Conflict Escalation Rules

Escalate immediately (pause merge) if:

- both branches modify same cron control-flow block in `worker/src/index.ts`
- migration numbering collides
- mint-burn tests fail due to lease wrapper and Alchemy RPC assumptions mismatch

Resolution order:
1. Keep Alchemy functional changes intact.
2. Re-apply lease/validation changes in a follow-up commit.
3. Re-run cron and API contract tests.

## 8. Done Criteria For "Preparation"

Preparation is complete when:

1. Execution board exists with phase-by-phase tasks and ownership.
2. Parallel-safety protocol is documented (this file).
3. Deferred integration points are explicit and testable.
4. No protected Alchemy files were modified in prep phase.
