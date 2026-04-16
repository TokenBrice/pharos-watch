# Redemption Backstop Iteration 3 — Plan

**Goal:** Add direct unit tests for two pure helper functions in the worker runtime that still lack dedicated coverage: `resolveCapacityBasis` (11 branches) and `resolveSnapshotMethodologyVersion` (3 branches). Pure test coverage — no semantics change, no version bump.

**Scope:** One new test file, one exported-helper flip, one appended describe block. Everything else untouched.

---

## Audit Context

After iteration 2, the following pure helpers still have no direct branch coverage:

1. **`resolveCapacityBasis`** in `worker/src/lib/redemption-backstop-capacity.ts:54-76` — already exported, 11 branches across `reserve-sync-metadata`, `supply-full`, `supply-ratio`, with 6 different route families and 5 capacity confidence values in play. Grep confirms no `*.test.ts` references this function.

2. **`resolveSnapshotMethodologyVersion`** in `worker/src/lib/redemption-backstops-store.ts:227-246` — currently private, 3 branches (entry match, entry mismatch, zero timestamp). Governs the `methodology.version` envelope on the `/redemption-backstops` API response. Never grepped in any test.

Both are 100% pure functions with no D1 or adapter dependencies. No behavior change, no methodology version bump needed.

**Not in scope** (deferred to iteration 4+):
- `resolveReserveSyncCapacityConfidence` direct tests (depends on `TRACKED_META_BY_ID` static data; requires picking real coin IDs or mocking module state)
- `readRedemptionBackstopLiveMetadata` direct tests (90-line function with complex snapshot-metadata harness)
- `loadSevereActiveDepegAvailabilityMap` tests (requires D1 mock)
- `pickValidDetails` / `parseDetails` tests (JSON parsing edge cases, lower priority)

---

## Task 1: `resolveCapacityBasis` branch tests

**Files:**
- Create: `worker/src/lib/__tests__/redemption-backstop-capacity.test.ts`

### Steps

Create `worker/src/lib/__tests__/redemption-backstop-capacity.test.ts` with direct branch coverage for all 11 paths:

1. reserve-sync-metadata + live-direct → `"live-direct-telemetry"`
2. reserve-sync-metadata + live-proxy → `"live-proxy-buffer"`
3. reserve-sync-metadata + model.basis set + other confidence → `model.basis`
4. reserve-sync-metadata + no model.basis + other confidence → `"live-proxy-buffer"`
5. non-reserve model with explicit model.basis → `model.basis`
6. supply-full + offchain-issuer → `"issuer-term-redemption"`
7. supply-full + stablecoin-redeem → `"issuer-term-redemption"`
8. supply-full + other family (e.g. basket-redeem) → `"full-system-eventual"`
9. supply-ratio + psm-swap → `"psm-balance-share"`
10. supply-ratio + queue-redeem → `"strategy-buffer"`
11. supply-ratio + other (e.g. collateral-redeem) → `"hot-buffer"`

Then run `cd worker && npx vitest run src/lib/__tests__/redemption-backstop-capacity.test.ts`.

Commit as `Add unit tests for resolveCapacityBasis`.

## Task 2: `resolveSnapshotMethodologyVersion` tests

**Files:**
- Modify: `worker/src/lib/redemption-backstops-store.ts:227` — change `function` → `export function`
- Modify: `worker/src/lib/__tests__/redemption-backstops-store.test.ts` — append new describe block

### Steps

1. Export `resolveSnapshotMethodologyVersion`. No behavior change.

2. In the existing store test file, append a new `describe("resolveSnapshotMethodologyVersion", ...)` block that covers:
   - Path A: `updatedAt > 0` and a coin's `updatedAt` matches exactly + the coin has `methodologyVersion` set → returns that coin's version
   - Path B: `updatedAt > 0` but no coin matches → fallback to `getRedemptionBackstopVersionAt`
   - Path C: `updatedAt == 0` → fallback to `getRedemptionBackstopVersionAt`

3. Run `cd worker && npx vitest run src/lib/__tests__/redemption-backstops-store.test.ts`.

4. Worker typecheck: `cd worker && npx tsc --noEmit`.

5. Commit as `Add tests for resolveSnapshotMethodologyVersion`.

## Task 3: Final validation and push

- `npm run test:merge-gate`
- `git push origin main`

## Self-Review

- [x] Both test targets are pure functions with no I/O
- [x] No methodology version bump (pure test coverage)
- [x] `resolveCapacityBasis` already exported — no API surface growth
- [x] `resolveSnapshotMethodologyVersion` export is the minimal diff for unit testability
