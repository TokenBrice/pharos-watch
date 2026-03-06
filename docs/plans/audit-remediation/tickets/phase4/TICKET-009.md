---
title: "Add missing worker tests: cron, auth, API assertions"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
---

## Goal

Write tests for 7 testing-coverage findings: daily digest cron, PSI snapshot/recompute, auth helper, untested cron transforms, shallow API assertions, weak assertions, and over-mocked sync-stablecoins.

## Context

- Test runner: Vitest (see `vitest.config.ts`)
- Mock helpers: `worker/src/api/__tests__/helpers/mock-d1.ts`, `mock-fetch.ts`, `fixtures.ts`
- These have been improved by TICKET-008 (prerequisite). Use the updated mock-d1 with bind tracking.
- Existing test patterns: see `worker/src/api/__tests__/*.test.ts` and `worker/src/cron/__tests__/*.test.ts`

## Task

### Step 1: TEST-001 — Daily digest cron tests

Create `worker/src/cron/__tests__/daily-digest.test.ts`:

Test the following (mock D1, Claude API, and social posting):

1. **Happy path**: Mock DB returns with mcap data, depeg events, supply history. Mock Claude API returns valid JSON. Verify: digest row is inserted, no social errors.
2. **LLM returns malformed JSON**: Mock Claude API returns text with code-block wrapping. Verify: fallback parsing handles it gracefully.
3. **Skip if recent digest exists**: Mock DB shows a digest created within cooldown period. Verify: function returns early without calling Claude.
4. **DB failure during data collection**: Mock a DB query failure. Verify: function returns error status, doesn't call Claude.
5. **Social posting failure**: Mock Twitter/Telegram to throw. Verify: digest is still stored in DB (social failures are non-fatal).

For the Claude API mock, intercept `fetch()` calls to `api.anthropic.com` and return structured responses.

### Step 2: TEST-002 — PSI snapshot/recompute tests

Create `worker/src/lib/__tests__/psi-recompute.test.ts`:

Test the pure functions in `worker/src/lib/psi-recompute.ts`:

1. **`buildSupplySnapshotMap()`**: Groups rows by coin ID, sorted by date. Test with: empty array, single coin, multiple coins, unsorted input.
2. **`findNearestSupplySnapshot()`**: Finds closest snapshot within 14-day window. Test: exact match, 13-day gap (found), 15-day gap (returns null), empty map.
3. **`buildStabilityInputForDay()`**: Computes depegs, mcap, mcap7dChange. Test: no depegs, active depeg (picks worst |bps|), resolved depeg within window, zero mcap7dAgo (divide-by-zero safety).

Create `worker/src/cron/__tests__/snapshot-psi.test.ts`:

1. **Happy path**: Mock `stability_index_samples` with 96 rows (24h × 4 per hour). Verify: average score computed, row inserted into `stability_index`.
2. **Empty samples**: Verify: returns "skipped", no insert.
3. **Mixed methodology versions**: Verify: picks most common version.

### Step 3: TEST-003 — Auth helper tests

Create `worker/src/lib/__tests__/auth.test.ts`:

1. **`requireAdmin()` with correct key**: Returns `null` (no error).
2. **`requireAdmin()` with wrong key**: Returns 401 Response.
3. **`requireAdmin()` with missing Authorization header**: Returns 401 Response.
4. **`requireAdmin()` with malformed header** (no "Bearer " prefix): Returns 401 Response.
5. **`timingSafeEqual()`**: Equal strings return true, different strings return false, different-length strings return false.

### Step 4: TEST-006 — Cron transform tests

Create `worker/src/cron/__tests__/sync-stablecoin-charts.test.ts`:

1. **Happy path**: Mock DL API response. Verify: cache write with transformed data.
2. **DL API failure**: Verify: returns degraded status (after Phase 3 fix).
3. **Invalid response shape**: Verify: early return with logged warning.

Create similar minimal tests for `sync-usds-status.ts` and `sync-bluechip.ts` following the same pattern: happy path + API failure + invalid shape.

### Step 5: TEST-008 — Strengthen cache-passthrough assertions

In `worker/src/api/__tests__/cache-passthrough.test.ts`:

Add concrete value checks:
1. Assert `_meta.status` is a specific string (e.g., "ok"), not just truthy.
2. Assert `_meta.updatedAt` is a valid ISO date string.
3. Assert `_meta.ageSeconds` is a non-negative number.
4. Assert `X-Data-Age` header value matches the age calculation.
5. Test stale data scenario: set cache `updated_at` to >1h ago, verify response still 200 with appropriate age.

### Step 6: TEST-009 — Replace weak assertions in API tests

In `worker/src/api/__tests__/peg-summary.test.ts`, `stablecoin-summary.test.ts`, `stablecoin-detail.test.ts`:

Replace `toBeTruthy()`/`toBeDefined()` with concrete value checks:
```typescript
// Before:
expect(body.summary.activeDepegCount).toBeTruthy();
// After:
expect(body.summary.activeDepegCount).toBe(0); // or the exact expected count from mock data
```

For each test file, read the mock data setup and compute what the expected values should be, then assert those exact values.

### Step 7: TEST-010 — Reduce mock coupling in sync-stablecoins

In `worker/src/cron/__tests__/sync-stablecoins.test.ts`:

1. Identify which `vi.mock()` calls could be replaced with real implementations. Candidates:
   - Price enrichment (if it can work with mock fetch responses)
   - Depeg detection (if it's pure logic over data)
2. For mocks that must stay, add assertion-level checks: verify the mock was called with expected arguments.
3. Add at least one test for a currently untested scenario: e.g., duplicate coin IDs in DL response.

## Acceptance Criteria

1. `npm test` passes — all new and existing tests pass
2. `cd worker && npx tsc --noEmit` passes
3. New test files exist:
   - `worker/src/cron/__tests__/daily-digest.test.ts`
   - `worker/src/lib/__tests__/psi-recompute.test.ts`
   - `worker/src/cron/__tests__/snapshot-psi.test.ts`
   - `worker/src/lib/__tests__/auth.test.ts`
   - `worker/src/cron/__tests__/sync-stablecoin-charts.test.ts`
4. Cache-passthrough tests have concrete value assertions (not just `toBeTruthy`)
5. Peg-summary/stablecoin-summary/detail tests use exact value assertions
