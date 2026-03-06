---
title: "Audit testing coverage and quality"
agent: "codex"
reasoning_effort: "high"
done: false
---

## Goal

Audit test coverage, test quality, and testing gaps across the entire codebase. Produce `FINDINGS-TESTING.md` in the worktree root.

## Task

### Scope

All test files and their corresponding source files. Approximate counts: 36 frontend test files, ~60 worker test files (in `worker/src/api/__tests__/` and `worker/src/lib/__tests__/`), 1 shared test file.

### What to check

1. **Coverage gaps — untested source files**: For each layer, identify source files that have NO corresponding test file:
   - `src/lib/*.ts` — which have tests, which don't?
   - `src/hooks/*.ts` — which have tests?
   - `worker/src/api/*.ts` — which handlers have tests in `worker/src/api/__tests__/`?
   - `worker/src/cron/*.ts` — which crons have tests?
   - `worker/src/lib/*.ts` — which libs have tests in `worker/src/lib/__tests__/`?
   - `shared/lib/*.ts` — which shared modules have tests?

   Produce a table showing: source file → test file (or "MISSING").

2. **Critical untested logic**: Flag HIGH severity for untested code that is:
   - Financial calculations (supply, prices, scores, indexes)
   - Data transformations (API response shaping, cron data processing)
   - Classification logic (peg type, stablecoin classification, grading)
   - Security-adjacent (auth, input validation)

3. **Test quality — assertion patterns**: Sample at least 20 test files and check:
   - Do tests assert specific values, or just `toBeDefined()` / `toBeTruthy()`? (weak assertions)
   - Do tests cover both success and error paths?
   - Do tests verify edge cases (empty arrays, null values, boundary values)?
   - Are there tests that test implementation details rather than behavior?

4. **Mock correctness**: Check test mocks and fixtures:
   - `worker/src/api/__tests__/helpers/mock-d1.ts` — does the mock D1 behave like real D1?
   - `worker/src/api/__tests__/helpers/mock-fetch.ts` — does it cover error scenarios?
   - `worker/src/api/__tests__/helpers/fixtures.ts` — are fixture data shapes up to date with current schemas?
   - Are there tests that pass because of mock behavior rather than testing real logic?

5. **Flaky test patterns**: Look for:
   - Tests depending on current time (`Date.now()`, `new Date()`) without mocking
   - Tests depending on execution order
   - Tests with `setTimeout` or timing-dependent assertions
   - Tests using random data without seeding

6. **Frontend testing gaps**: With only 36 frontend tests vs 292 source files, identify:
   - Are any pages tested at all?
   - Are hooks tested?
   - Are utility functions in `src/lib/` tested?
   - What's the testing strategy — unit, integration, or none?

7. **Shared module testing**: Only 1 test file for 27 shared modules. Identify:
   - Which shared module has the test?
   - Which critical shared modules (`shared/lib/supply.ts`, `shared/lib/classification.ts`, etc.) lack tests?

8. **Test configuration**: Check:
   - `vitest.config.ts` or similar — is coverage reporting configured?
   - Are there test scripts in `package.json` that aren't documented?
   - Is there a CI pipeline running tests? (`docs/testing.md` reference)

### Files to examine

- All `*.test.*` and `*.spec.*` files across the repo
- `worker/src/api/__tests__/**/*.ts`
- `worker/src/lib/__tests__/**/*.ts`
- `src/**/*.test.*`
- `shared/**/*.test.*`
- `vitest.config.ts` (or similar)
- `package.json` (test scripts)
- `docs/testing.md` (testing documentation)

### Output format

Write `FINDINGS-TESTING.md` in the worktree root:

```markdown
# FINDINGS: Testing Coverage

## Summary
- Frontend: X source files, Y test files (Z% with tests)
- Worker API: X source files, Y test files (Z% with tests)
- Worker Cron: X source files, Y test files (Z% with tests)
- Worker Lib: X source files, Y test files (Z% with tests)
- Shared: X source files, Y test files (Z% with tests)
- Total findings: N (A critical, B high, C medium, D low)

## Coverage Map
(table: source file → test file or MISSING, one row per source file)

#### Critical
(findings or "None")

#### High
(findings)

#### Medium
(findings)

#### Low
(findings)

## Files Examined
(list)
```

Each finding:
```
- [TEST-NNN] **Title** — Description. Source: `path/to/source.ts`. Test: `path/to/test.ts` or "MISSING". What's missing/wrong. `[~effort]`
```

## Acceptance Criteria

- `FINDINGS-TESTING.md` exists in the worktree root
- File contains the coverage summary with percentages
- File contains the coverage map table
- File contains all four severity sections
- Every finding has a `[TEST-NNN]` ID and effort tag
- Summary counts match actual findings
