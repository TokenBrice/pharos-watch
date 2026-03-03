# Reliability, Maintainability & Resilience Refinement Plan

**Date:** 2026-03-03  
**Status:** Proposed (implementation-ready)  
**Owner:** Engineering  
**Scope:** Refinement only. No new end-user features.  

## 1. Objective

Implement three high-leverage refinements that improve trustworthiness and long-term operability of Pharos without expanding product scope:

1. **Fail-closed critical data contracts** (schema-enforced, last-known-good preservation)
2. **Cron lease locking + fencing** (single-writer guarantees under overlap/failure)
3. **Risk-gated CI reliability checks** (block regressions before deploy)

Primary outcomes:
- Prevent silent bad data propagation
- Eliminate race-condition mutation risk in cron execution
- Increase confidence that critical data paths cannot regress unnoticed

---

## 2. Non-Goals

- No new API endpoints
- No new UI pages, cards, widgets, or dashboards
- No scoring model redesign
- No infra provider migration (Cloudflare/D1 remains current)
- No broad refactor unrelated to reliability/maintenance/resilience

---

## 3. Current Baseline (from codebase state)

- Frontend fetch layer in `src/lib/api.ts` validates optional schemas but currently logs and returns casted data on failure for both `apiFetch` and `apiFetchWithMeta`.
- Worker cron writes are guarded by `setCacheIfNewer` for key cache blobs, reducing stale overwrite risk.
- `logCronRun` already supports timeout + `AbortSignal` propagation.
- Circuit breakers exist for major external sources.
- CI runs lint + tests + build; current coverage threshold is global `lines: 50` in `vitest.config.ts`.

Gap summary:
- Critical contracts can still fail open at frontend boundary.
- No explicit per-job lease lock in D1 (single-writer not formally guaranteed).
- CI enforces broad quality, but not strict critical-path invariants.

---

## 4. Workstream A: Fail-Closed Critical Data Contracts

## 4.1 Design

Introduce a **Contract Policy** with two runtime modes:

- `STRICT` (critical endpoints): schema mismatch is a hard failure
- `PERMISSIVE` (non-critical endpoints): current warning behavior retained

Critical endpoints:
- `/api/stablecoins`
- `/api/peg-summary`
- `/api/report-cards`
- `/api/dex-liquidity`
- `/api/stress-signals`
- `/api/mint-burn-flows`

Principles:
- Validate as early as possible (worker write boundary)
- Never overwrite valid cache with invalid payload
- Prefer stale-but-valid data to fresh-but-invalid data

## 4.2 File-Level Changes

1. `src/lib/api.ts`
- Add per-endpoint strictness map
- For strict endpoints, on schema fail: throw typed `SchemaValidationError`
- For permissive endpoints, preserve current warn-and-return behavior
- In `apiFetchWithMeta`, preserve `_meta` extraction path but enforce strict schema before returning `data`

2. `src/lib/types.ts`
- Ensure strict endpoint response schemas are explicitly exported and complete
- Add missing schemas where endpoint types exist but schema does not

3. `worker/src/cron/*` (writers)
- Before `setCacheIfNewer`/`setCache` for critical keys, run schema parse against shared schema contract
- On parse failure:
  - log structured error with endpoint/cache key
  - increment validation-failure metric counter (via cron metadata)
  - skip write (keep LKG)

4. `worker/src/lib/api-utils.ts` (optional utility)
- Add helper `validateBeforeCacheWrite(schema, payload, context)` to reduce duplication

5. `worker/src/api/*` (if needed)
- Ensure response builder code paths preserve schema-aligned shape for critical endpoints

## 4.3 Error Handling Contract

For strict endpoints:
- Frontend receives controlled fetch error
- Query keeps previous successful data via TanStack Query cache
- Existing stale/degraded UX signals continue to communicate freshness state

Worker behavior:
- Invalid upstream/transformed payload does not replace existing cache
- Cron result metadata includes failure count and keys skipped

## 4.4 Tests

Add/expand tests:

1. `worker/src/cron/__tests__/sync-stablecoins.test.ts`
- invalid transformed payload -> no cache overwrite
- valid payload after invalid run -> write resumes

2. `worker/src/cron/__tests__/sync-yield-data.test.ts`
- invalid ranking payload -> skip write

3. `worker/src/api/__tests__/cache-passthrough.test.ts`
- malformed cache shape behavior for strict schemas

4. `src/lib/__tests__/api-fetch-contracts.test.ts` (new)
- strict endpoint schema mismatch throws
- permissive endpoint mismatch logs + returns

Acceptance:
- 100% of critical endpoint write paths validated pre-write
- No strict endpoint schema mismatch can silently render as typed success

---

## 5. Workstream B: Cron Lease Locking + Fencing

## 5.1 Design

Add D1-backed lease mechanism ensuring at most one mutating run per cron job.

Core semantics:
- Lease key: `job`
- Owner token: unique `run_id` (UUID)
- Expiry: `lease_until` (unix sec)
- Renewal heartbeat during long jobs
- Fencing token required for protected writes

If lease is held and not expired:
- new run exits early as `skipped_locked`

If lease expired:
- next run can acquire and proceed

## 5.2 Migration

Create migration: `worker/migrations/0034_cron_leases.sql` (or next available index)

```sql
CREATE TABLE IF NOT EXISTS cron_leases (
  job TEXT PRIMARY KEY,
  lease_owner TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cron_leases_until ON cron_leases(lease_until);
```

Note: choose migration number based on current highest migration in repo at implementation time.

## 5.3 Runtime APIs

In `worker/src/lib/db.ts` add:

- `acquireCronLease(db, job, owner, ttlSec): Promise<boolean>`
  - atomic upsert with conditional takeover only when expired
- `renewCronLease(db, job, owner, ttlSec): Promise<boolean>`
  - extend lease only if owner matches
- `releaseCronLease(db, job, owner): Promise<void>`
  - best-effort cleanup only if owner matches

Add wrapper utility:
- `runCronWithLease(db, job, fn, opts)`
  - acquire -> execute -> release
  - heartbeat timer for long jobs
  - log skip metadata when lease not acquired

## 5.4 Index Integration

In `worker/src/index.ts` scheduled switch:
- wrap mutating jobs (all cron jobs writing cache/db) with lease-aware wrapper
- ensure `logCronRun` status includes:
  - `ok`
  - `error`
  - `skipped_locked`

## 5.5 Fencing Strategy

Minimal viable fencing:
- All cache writes for critical keys require current run ownership check before write.
- If ownership lost (renewal fails), abort remaining writes.

Optional phase-2 hardening:
- Extend ownership checks to high-volume table writes.

## 5.6 Timeout & Lease Alignment

- Lease TTL should exceed per-job timeout by a small buffer (e.g., timeout + 60s).
- Heartbeat interval ~TTL/3.
- On abort timeout, ensure release path still executes in `finally`.

## 5.7 Tests

Add `worker/src/lib/__tests__/cron-leases.test.ts` (new):
- acquire success when empty
- acquire fail when active lease exists
- acquire success when lease expired
- renew success/fail by owner mismatch
- release owner mismatch is no-op

Add concurrency behavior tests in affected cron tests (mocked D1 responses):
- locked lease -> job skip + metadata
- lost lease mid-run -> writes halted

Acceptance:
- No two active runs for same job can mutate protected writes concurrently
- Expired leases are safely reclaimed
- Crash recovery via TTL confirmed

---

## 6. Workstream C: Risk-Gated CI Reliability Checks

## 6.1 Design

Introduce targeted reliability gates for critical modules instead of relying solely on global coverage.

Gate categories:
1. **Contract gate**: strict endpoints must pass schema tests
2. **Invariant gate**: critical numerical invariants
3. **Critical coverage gate**: specific files/directories must meet higher threshold

## 6.2 Invariants (initial set)

Critical invariants:
- No NaN/Infinity in persisted score fields
- No negative supply/market-cap where semantically invalid
- Bounded score ranges (e.g., 0-100 where defined)
- Freshness metadata shape intact for cache-backed endpoints
- Invalid payloads cannot replace existing valid cache

## 6.3 CI Workflow Changes

Update `.github/workflows/deploy-cloudflare.yml`:

1. `npm run lint`
2. `npm test`
3. `npm run test:invariants` (new script)
4. `npm run test:critical-contracts` (new script or test filter)
5. `npm run coverage:critical` (new script; fail on threshold miss)
6. existing build/deploy steps

## 6.4 Package Scripts

In `package.json` add:
- `test:invariants`
- `test:critical-contracts`
- `coverage:critical`

Implementation pattern:
- Use Vitest include filters for critical suites
- Use coverage report parsing for critical-path thresholds (script in `scripts/`)

## 6.5 Threshold Policy

- Keep global line threshold at 50 for broad velocity
- Add critical-path threshold (example: 80 lines) for selected files:
  - `worker/src/cron/sync-stablecoins.ts`
  - `worker/src/cron/sync-yield-data.ts`
  - `worker/src/lib/fetch-retry.ts`
  - `worker/src/api/stress-signals.ts`
  - `src/lib/api.ts`

Final threshold values should be calibrated after first measurement pass.

## 6.6 Tests

Add/extend suites under:
- `worker/src/api/__tests__/`
- `worker/src/cron/__tests__/`
- `worker/src/lib/__tests__/`
- `src/lib/__tests__/`

Acceptance:
- CI fails on critical contract breakage/invariant violations
- CI fails when critical-path coverage drops below agreed threshold

---

## 7. Delivery Plan (Phased)

## Phase 0: Baseline & Instrumentation (0.5-1 day)

1. Capture current coverage and failing-edge baseline
2. Add doc stubs for contract policy and lease semantics
3. Add feature flags/env toggles:
- `STRICT_CONTRACTS_ENABLED`
- `CRON_LEASES_ENABLED`

Deliverable:
- baseline metrics in plan PR description

## Phase 1: Strict Contracts (1.5-2.5 days)

1. Implement strict/permissive policy in `src/lib/api.ts`
2. Add worker pre-write validation for critical cache keys
3. Add tests for strict behavior and no-overwrite-on-invalid
4. Roll out with `STRICT_CONTRACTS_ENABLED=false` first, then true in staging

Exit criteria:
- All strict-contract tests pass
- Staging shows no unexpected data starvation

## Phase 2: Lease Locking & Fencing (2-3 days)

1. Add migration and db helpers
2. Integrate lease wrapper into `scheduled` jobs
3. Add heartbeat and ownership checks for protected writes
4. Add skip-status logging + tests
5. Enable in staging via `CRON_LEASES_ENABLED=true`

Exit criteria:
- Synthetic overlap simulation shows one run proceeds, one skips
- No mutation from non-owner after ownership loss

## Phase 3: CI Risk Gates (1-2 days)

1. Add invariant and critical-contract test groups
2. Add critical coverage gate script
3. Update workflow and stabilize thresholds

Exit criteria:
- PR with intentional invariant break fails CI as expected
- Non-critical changes can still pass without disproportionate friction

## Phase 4: Production Rollout & Hardening (1 day)

1. Enable strict contracts in production
2. Enable leases in production
3. Monitor `/api/health`, `/api/status`, cron logs, alert volume for 24-48h
4. Triage and tune thresholds/TTL if needed

---

## 8. Implementation Task Checklist

## A. Contracts
- [ ] Define strict endpoint registry
- [ ] Add `SchemaValidationError` type and handler policy
- [ ] Implement strict parsing branch in `apiFetch`
- [ ] Implement strict parsing branch in `apiFetchWithMeta`
- [ ] Add worker-side pre-write validators for critical cache blobs
- [ ] Emit validation-failure metadata in cron run records
- [ ] Add tests for strict/permissive branches

## B. Leases
- [ ] Add migration for `cron_leases`
- [ ] Add acquire/renew/release helpers in db lib
- [ ] Build `runCronWithLease` wrapper
- [ ] Integrate wrapper for all mutating cron jobs
- [ ] Add ownership checks on protected writes
- [ ] Add skip-locked run status + metadata
- [ ] Add concurrency and lease-expiry tests

## C. CI Gates
- [ ] Add invariant test suite
- [ ] Add critical contract suite
- [ ] Add critical coverage measurement script
- [ ] Update npm scripts
- [ ] Update workflow ordering
- [ ] Calibrate threshold values from baseline

---

## 9. Risks & Mitigations

1. **Risk:** Strict validation causes temporary data unavailability if upstream payloads drift.
- Mitigation: LKG preservation, staged rollout, explicit alerts on repeated validation failure.

2. **Risk:** Lease bugs accidentally skip too many cron runs.
- Mitigation: short TTL, owner-checked renewals, `skipped_locked` observability, rapid flag rollback.

3. **Risk:** CI gate friction slows delivery.
- Mitigation: gate only critical paths, keep global threshold unchanged, calibrate with current baseline.

4. **Risk:** D1 single-thread semantics cause lock contention edge cases.
- Mitigation: atomic conditional updates, minimal statement footprint, robust retry for lease acquisition if needed.

---

## 10. Observability & Operations

Add/confirm the following signals:

- Cron metadata fields:
  - `leaseAcquired`
  - `leaseOwner`
  - `leaseRenewFailures`
  - `validationFailures`
  - `skippedWrites`

- Health/status views:
  - include strict-contract failure counts (recent window)
  - include lease skip counts per job (recent window)

- Alerts:
  - repeated validation failure on same cache key
  - repeated skipped_locked for same cron job beyond threshold

---

## 11. Rollback Strategy

Immediate rollback controls (no redeploy required if env-configured):

1. Disable strict contracts:
- `STRICT_CONTRACTS_ENABLED=false`

2. Disable leases:
- `CRON_LEASES_ENABLED=false`

3. Keep CI gates but allow temporary bypass only via explicit admin action in emergency branch policy.

Data safety note:
- None of these changes require destructive data migration.
- Lease table can remain even if feature is disabled.

---

## 12. Definition of Done

All must be true:

1. Critical endpoints are fail-closed at fetch boundary and pre-write validated in worker.
2. Invalid payload cannot overwrite valid critical cache data.
3. Cron jobs are lease-protected with owner-based fencing for protected writes.
4. CI enforces contract + invariant + critical coverage gates.
5. Documentation updated in:
- `docs/data-pipeline.md` (validation policy)
- `docs/worker-infrastructure.md` (lease protocol)
- `docs/testing.md` (new test categories and commands)
6. Production rollout completed with 48h monitoring and no unresolved reliability regressions.

---

## 13. Suggested PR Breakdown

1. **PR-1 Contracts foundation**
- `src/lib/api.ts`, `src/lib/types.ts`, tests

2. **PR-2 Worker pre-write validation**
- critical cron writers + tests

3. **PR-3 Lease migration + db helpers**
- migration + lib tests

4. **PR-4 Lease integration in scheduler**
- `worker/src/index.ts`, cron tests

5. **PR-5 CI risk gates**
- workflow/scripts/tests + docs updates

This split keeps review surface manageable and allows fast rollback by layer.
