# Reliability Refinement Execution Board

**Created:** 2026-03-03  
**Source plan:** `docs/plans/2026-03-03-reliability-maintainability-resilience-refinement-plan.md`  
**Parallel constraint:** `sync-mint-burn.ts` Alchemy migration in progress by another agent.

## 1. Execution Order

1. Contracts (frontend + worker pre-write checks excluding mint-burn)
2. CI risk gates
3. Lease infra primitives
4. Lease orchestration integration (defer mint-burn slot wiring until Alchemy merge)
5. Post-merge reconciliation for `3,23,43` cron slot

## 2. Task Board

## Phase A: Strict Contracts (safe-now)

- [x] A1: Add strict endpoint registry and policy in `src/lib/api.ts`
- [x] A2: Add `SchemaValidationError` and strict-path throw behavior
- [x] A3: Ensure critical endpoint schemas are exported/complete in `src/lib/types.ts`
- [x] A4: Add frontend tests for strict vs permissive behavior (`src/lib/__tests__/api-fetch-contracts.test.ts`)
- [x] A5: Add worker helper for pre-write schema validation (`worker/src/lib/api-utils.ts` or dedicated module)
- [ ] A6: Integrate pre-write validation in:
  - [x] `worker/src/cron/sync-stablecoins.ts`
  - [x] `worker/src/cron/sync-yield-data.ts`
  - [x] `worker/src/cron/dex-liquidity/*` (N/A: no critical endpoint cache blob written here)
- [x] A7: Add cron tests: invalid payload does not overwrite valid cache

## Phase B: CI Risk Gates (safe-now)

- [x] B1: Add scripts for critical contract tests and invariants
- [x] B2: Add critical coverage checker script in `scripts/`
- [x] B3: Update `package.json` scripts (`test:invariants`, `test:critical-contracts`, `coverage:critical`)
- [x] B4: Update `.github/workflows/deploy-cloudflare.yml`
- [x] B5: Calibrate thresholds from baseline and document chosen values (initial threshold set to 35%, documented in `docs/testing.md`; tighten in a later pass)

## Phase C: Lease Primitives (safe-ish, isolated)

- [x] C1: Add D1 migration for `cron_leases` (implemented as `worker/migrations/0034_cron_leases.sql`)
- [x] C2: Add `acquireCronLease/renewCronLease/releaseCronLease` helpers in `worker/src/lib/db.ts`
- [x] C3: Add lease unit tests (`worker/src/lib/__tests__/cron-leases.test.ts`)
- [x] C4: Add wrapper utility `runCronWithLease` with heartbeat + skip metadata

## Phase D: Scheduler Integration (defer risky slot)

- [x] D1: Integrate lease wrapper into `worker/src/index.ts` for non-`3,23,43` slots
- [x] D2: Validate no behavior change in 15-min/30-min/daily slots
- [x] D3: Reconciled `3,23,43` slot wiring after Alchemy merge (no edits to `sync-mint-burn.ts` required)

## Phase E: Post-Alchemy Reconciliation

- [x] E1: Rebase branch on top of merged Alchemy PR (shared branch continuation confirmed)
- [x] E2: Reconcile `worker/src/index.ts` `3,23,43` slot orchestration
- [x] E3: Ensure mint-burn lease integration respects new Alchemy flow
- [x] E4: Run targeted tests:
  - [x] `worker/src/cron/__tests__/sync-mint-burn.test.ts`
  - [x] `worker/src/cron/__tests__/sync-blacklist.test.ts`
  - [x] `worker/src/api/__tests__/mint-burn-events.test.ts`
  - [x] `worker/src/api/__tests__/mint-burn-flows.test.ts`
- [x] E5: Update docs (`docs/worker-infrastructure.md`, `docs/data-pipeline.md`, `docs/testing.md`)

## 3. Ownership Suggestion

- Stream 1 (can start now): A + B
- Stream 2 (can start now): C
- Stream 3 (must wait for merge): D3 + E

## 4. Test Matrix (Minimum)

- [ ] All existing tests pass (`npm test`)
- [ ] New strict contract tests pass
- [ ] New invariants pass
- [ ] New lease unit tests pass
- [ ] No regression in cache-passthrough API contract tests

## 5. Go/No-Go Gates

Gate 1 (after Phase A):
- strict endpoints enforce fail-closed semantics
- no data starvation in local/staging smoke checks

Gate 2 (after Phase C):
- lease acquire/renew/release paths deterministic in tests

Gate 3 (after Phase E):
- mint-burn Alchemy path + lease wrapper both green
- docs and CI gates updated

## 6. Explicit Do-Not-Edit List During Parallel Migration

- `worker/src/cron/sync-mint-burn.ts`
- `worker/src/cron/__tests__/sync-mint-burn.test.ts` (unless coordinated)
- Alchemy-specific helper modules introduced by parallel agent

## 7. Notes

If urgent fixes require touching protected files before merge, coordinate and do a dedicated short-lived integration branch with both agents aligned on final ownership of `worker/src/index.ts`.
