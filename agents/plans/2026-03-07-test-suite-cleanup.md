# Test Suite Cleanup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove 12 redundant, duplicate, or trivial test files identified in the test suite audit, and consolidate one test into its natural home.

**Architecture:** Pure deletion of files that are strict subsets of other tests or too trivial to justify maintenance cost. One consolidation moves a unique assertion from `strict-path-drift.test.ts` into `api-endpoints.test.ts`. One `package.json` script update replaces the deleted file reference. Doc update keeps `docs/testing.md` accurate.

**Tech Stack:** Vitest, TypeScript

---

## Pre-flight

Before starting, run the full test suite to establish a green baseline:

```bash
npm test
```

Expected: all tests pass. Record the test count (e.g., "Tests: 142 passed"). Every task below should maintain this pass count minus the removed tests.

---

### Task 1: Remove 6 duplicate methodology version tests

These files all test the `createMethodologyVersion()` factory with identical three-test patterns (current version alignment, timestamp resolution, non-finite fallback). The generic factory test in `methodology-version.test.ts` already covers all of this behavior.

**Files to delete:**
- `src/lib/__tests__/blacklist-tracker-version.test.ts`
- `src/lib/__tests__/liquidity-score-version.test.ts`
- `src/lib/__tests__/depeg-dews-version.test.ts`
- `src/lib/__tests__/yield-methodology-version.test.ts`
- `src/lib/__tests__/stability-index-version.test.ts`
- `src/lib/__tests__/mint-burn-flow-version.test.ts`

**Keep:** `src/lib/__tests__/methodology-version.test.ts` (the generic factory test).

**Step 1: Delete the files**

```bash
git rm \
  src/lib/__tests__/blacklist-tracker-version.test.ts \
  src/lib/__tests__/liquidity-score-version.test.ts \
  src/lib/__tests__/depeg-dews-version.test.ts \
  src/lib/__tests__/yield-methodology-version.test.ts \
  src/lib/__tests__/stability-index-version.test.ts \
  src/lib/__tests__/mint-burn-flow-version.test.ts
```

**Step 2: Run tests to verify nothing broke**

```bash
npm test
```

Expected: all remaining tests pass. Test count drops by 18 (3 tests x 6 files).

**Step 3: Commit**

```bash
git add -A
git commit -m "test: remove 6 duplicate methodology version tests

The generic factory test in methodology-version.test.ts already covers
createMethodologyVersion() behavior. These domain-specific copies were
identical three-test patterns (version alignment, timestamp resolution,
non-finite fallback) with only different imports and timestamps."
```

---

### Task 2: Remove duplicate `src/lib/__tests__/yield-helpers.test.ts`

This 91-line file is a strict subset of `worker/src/cron/__tests__/yield-helpers.test.ts` (257 lines). The worker version covers all the same functions plus `matchAllDlPools`, multi-pool scenarios, and TVL quality gates.

**File to delete:**
- `src/lib/__tests__/yield-helpers.test.ts`

**Authoritative version (keep):** `worker/src/cron/__tests__/yield-helpers.test.ts`

**Step 1: Delete the file**

```bash
git rm src/lib/__tests__/yield-helpers.test.ts
```

**Step 2: Run tests to verify nothing broke**

```bash
npm test
```

Expected: all remaining tests pass. Test count drops by the number of `it` blocks in the deleted file (~19 tests).

**Step 3: Commit**

```bash
git add -A
git commit -m "test: remove duplicate yield-helpers test from src/lib

worker/src/cron/__tests__/yield-helpers.test.ts is a strict superset,
covering all the same functions plus matchAllDlPools, multi-pool
scenarios, and TVL quality gates."
```

---

### Task 3: Remove duplicate `dex-liquidity-helpers.test.ts`

This 106-line file is a strict subset of `worker/src/cron/__tests__/dex-liquidity-pool-helpers.test.ts` (144 lines). The pool-helpers version covers all the same functions plus `normalizeProtocol`, `computePoolStress`, `isCryptoSwap`, `buildSymbolLookups`, and chain map switching.

**File to delete:**
- `worker/src/cron/__tests__/dex-liquidity-helpers.test.ts`

**Authoritative version (keep):** `worker/src/cron/__tests__/dex-liquidity-pool-helpers.test.ts`

**Step 1: Delete the file**

```bash
git rm worker/src/cron/__tests__/dex-liquidity-helpers.test.ts
```

**Step 2: Run tests to verify nothing broke**

```bash
npm test
```

Expected: all remaining tests pass.

**Step 3: Commit**

```bash
git add -A
git commit -m "test: remove duplicate dex-liquidity-helpers test

dex-liquidity-pool-helpers.test.ts is a strict superset, covering all
the same functions plus normalizeProtocol, computePoolStress,
isCryptoSwap, buildSymbolLookups, and chain map switching."
```

---

### Task 4: Remove 3 trivial test files

These test files protect against scenarios that can't realistically regress:

- **`src/lib/__tests__/urls.test.ts`** — Tests `buildStablecoinUrl`, which is `"/stablecoin/" + encodeURIComponent(id) + "/"`. Four tests verifying string concatenation.
- **`src/lib/__tests__/digest.test.ts`** — Tests `splitDigestParagraphs` (regex split on blank lines) and `getDigestBodyParagraphs` (null coalescing). Simple 2-3 line functions.
- **`shared/lib/__tests__/psi-eligible.test.ts`** — Tests that `PSI_ELIGIBLE_SET` is non-empty and includes USDT/USDC/DAI. Verifying a static `Set` literal wasn't deleted.

**Files to delete:**
- `src/lib/__tests__/urls.test.ts`
- `src/lib/__tests__/digest.test.ts`
- `shared/lib/__tests__/psi-eligible.test.ts`

**Step 1: Delete the files**

```bash
git rm \
  src/lib/__tests__/urls.test.ts \
  src/lib/__tests__/digest.test.ts \
  shared/lib/__tests__/psi-eligible.test.ts
```

**Step 2: Run tests to verify nothing broke**

```bash
npm test
```

Expected: all remaining tests pass.

**Step 3: Commit**

```bash
git add -A
git commit -m "test: remove 3 trivial test files

- urls.test.ts: testing string concatenation in buildStablecoinUrl
- digest.test.ts: testing regex split and null coalescing
- psi-eligible.test.ts: verifying a static Set literal exists"
```

---

### Task 5: Consolidate `strict-path-drift.test.ts` into `api-endpoints.test.ts`

`strict-path-drift.test.ts` has two tests:
1. Path uniqueness check (`new Set(list).size === list.length`) -- **unique, worth keeping**
2. `assertPathCoverage()` alignment -- **already tested by `api-endpoints.test.ts` implicitly via `getProbePaths`**

Move the uniqueness guard into `api-endpoints.test.ts`, delete `strict-path-drift.test.ts`, and update the `test:critical-contracts` package.json script.

**Files:**
- Delete: `src/lib/__tests__/strict-path-drift.test.ts`
- Modify: `src/lib/__tests__/api-endpoints.test.ts`
- Modify: `package.json` (line 16, `test:critical-contracts` script)

**Step 1: Add the uniqueness guard and coverage assertion to `api-endpoints.test.ts`**

Add the following imports at the top of `src/lib/__tests__/api-endpoints.test.ts` (after the existing imports on line 8):

```typescript
import { STRICT_CONTRACT_PATHS_LIST } from "@shared/lib/strict-contract-paths";
import { ENDPOINT_ASSERTIONS, assertPathCoverage } from "../../../scripts/smoke-api.mjs";
```

Add the following test block at the end of the `describe("api endpoint registry", ...)` block (before the closing `});` on the last line):

```typescript
  it("keeps strict contract path list unique", () => {
    expect(new Set(STRICT_CONTRACT_PATHS_LIST).size).toBe(STRICT_CONTRACT_PATHS_LIST.length);
  });

  it("keeps smoke endpoint assertions aligned with strict contract paths", () => {
    expect(() => assertPathCoverage(STRICT_CONTRACT_PATHS_LIST, ENDPOINT_ASSERTIONS)).not.toThrow();
  });
```

**Step 2: Delete the old file**

```bash
git rm src/lib/__tests__/strict-path-drift.test.ts
```

**Step 3: Update `package.json` `test:critical-contracts` script**

In `package.json` line 16, replace:

```
src/lib/__tests__/strict-path-drift.test.ts
```

with nothing (remove it from the list). `api-endpoints.test.ts` is not currently in `test:critical-contracts`, so add it:

The updated script value should be:

```
vitest run src/lib/__tests__/api-fetch-contracts.test.ts src/lib/__tests__/api-endpoints.test.ts worker/src/api/__tests__/router-contract.test.ts worker/src/api/__tests__/cache-passthrough.test.ts worker/src/api/__tests__/peg-summary.test.ts worker/src/api/__tests__/report-cards.test.ts worker/src/api/__tests__/stability-index.test.ts worker/src/api/__tests__/dex-liquidity.test.ts worker/src/api/__tests__/stress-signals.test.ts worker/src/api/__tests__/mint-burn-flows.test.ts
```

(Swapped `strict-path-drift.test.ts` for `api-endpoints.test.ts`.)

**Step 4: Run the critical-contracts suite specifically**

```bash
npm run test:critical-contracts
```

Expected: all pass, including the two newly moved tests.

**Step 5: Run full test suite**

```bash
npm test
```

Expected: all pass, net test count unchanged (2 moved, not removed).

**Step 6: Commit**

```bash
git add -A
git commit -m "test: consolidate strict-path-drift into api-endpoints

Move the path uniqueness guard and smoke coverage assertion into
api-endpoints.test.ts where they naturally belong. Update the
test:critical-contracts script to reference the new location."
```

---

### Task 6: Update `docs/testing.md`

The test file inventory tables and references need to reflect the removed files. Read `docs/testing.md` first, then make these edits:

**Step 1: Remove deleted files from the "Frontend Library Tests" table**

Remove these rows from the table at `docs/testing.md` (in the `### Frontend Library Tests` section):
- The row for `format.test.ts` stays (it's valid)
- Remove any row referencing files we deleted. Cross-check with the current table -- the version tests, `urls`, `digest`, and `yield-helpers` were not in the representative table in the docs. `strict-path-drift.test.ts` IS listed.

Specifically in the `### Frontend Library Tests` table, update the row for `strict-path-drift.test.ts`:
- Remove the row entirely. Its assertions now live in `api-endpoints.test.ts`.

Update the `api-endpoints.test.ts` row description to:
```
Endpoint registry invariants: probe groups, status actions, cache/method flags, strict contract path uniqueness, smoke assertion alignment
```

**Step 2: Remove `dex-liquidity-helpers.test.ts` from the "Cron Tests" table**

In the `### Cron Tests` section, remove the row for `dex-liquidity-helpers.test.ts`. The `dex-liquidity-pool-helpers.test.ts` row already covers it.

**Step 3: Update the "Tier-3 Structural Refactor" section if needed**

Check whether any of the deleted files are referenced in the `### Tier-3 Structural Refactor Targeted Suites` section. Based on the current content, none of the deleted files appear there. No change needed.

**Step 4: Run lint to verify markdown is clean**

```bash
npm run lint
```

Expected: no lint errors.

**Step 5: Commit**

```bash
git add docs/testing.md
git commit -m "docs: update testing.md to reflect test suite cleanup

Remove references to 12 deleted test files and update api-endpoints
entry to reflect consolidated strict-path-drift assertions."
```

---

### Task 7: Final verification

**Step 1: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

**Step 2: Run critical contracts suite**

```bash
npm run test:critical-contracts
```

Expected: all pass.

**Step 3: Run invariants suite**

```bash
npm run test:invariants
```

Expected: all pass.

**Step 4: Run lint**

```bash
npm run lint
```

Expected: clean.

**Step 5: Verify the diff looks right**

```bash
git diff --stat HEAD~6
```

Expected: ~12 files deleted, 3 files modified (`api-endpoints.test.ts`, `package.json`, `docs/testing.md`). Net line delta should be strongly negative.

---

## Summary of changes

| Action | Files | Net tests removed |
|--------|-------|-------------------|
| Delete 6 methodology version tests | 6 deleted | ~18 |
| Delete duplicate yield-helpers (src) | 1 deleted | ~19 |
| Delete duplicate dex-liquidity-helpers | 1 deleted | ~12 |
| Delete 3 trivial tests | 3 deleted | ~10 |
| Consolidate strict-path-drift | 1 deleted, 2 modified | 0 (moved) |
| Update docs | 1 modified | 0 |
| **Total** | **12 deleted, 3 modified** | **~59** |
