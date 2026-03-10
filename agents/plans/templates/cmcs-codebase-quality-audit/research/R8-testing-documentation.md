---
title: "Audit testing coverage and documentation accuracy"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "xhigh"
done: false
---

## Goal

Produce a comprehensive `RESEARCH-REPORT.md` cataloguing testing gaps and documentation drift — focused on untested critical paths, test quality issues, stale documentation, and missing documentation.

## Context

This is a **read-only research task**. You are NOT implementing changes — you are producing a detailed audit report.

Pharos uses Vitest for testing. Test files live in `__tests__/` directories adjacent to the code they test. Documentation lives in `docs/`. The methodology page (`src/app/methodology/`) must stay in sync with scoring algorithm implementations.

**Scope:**
- Test files: `src/**/__tests__/`, `worker/src/**/__tests__/`, `shared/lib/__tests__/`
- Source files: all of `src/`, `worker/src/`, `shared/`
- Documentation: `docs/`
- Methodology page: `src/app/methodology/`

**Reference:** `docs/testing.md` describes the testing conventions. Read it first.

## Task

### Part 1: Testing Coverage

#### 1.1 Untested Critical Paths

Identify source files with NO corresponding test file that contain critical logic:

- **Scoring algorithms:** All files in `shared/lib/` implementing PSI, PegScore, DEWS, LiquidityScore, Report Cards — each MUST have tests.
- **Data transformations:** Functions that transform raw API/DB data into display-ready formats. Bugs here show wrong data to users.
- **Classification logic:** `shared/lib/classification.ts` and related files — the backbone of how stablecoins are categorized.
- **Cron data processing:** Core logic in cron jobs (data parsing, aggregation, scoring calculations). Not the fetch/write scaffolding, but the business logic.
- **API handlers:** At minimum, the response shape should be tested for key endpoints.
- **Utility functions:** `src/lib/` and `worker/src/lib/` utility functions with non-trivial logic.

For each untested critical path, note:
- The file and function(s) that should be tested
- What types of tests are needed (unit, integration, snapshot)
- Estimated test complexity (simple, moderate, complex)

#### 1.2 Edge Case Coverage

For files that DO have tests, check if edge cases are covered:

- **Boundary values:** Zero, negative, maximum, minimum values for numeric inputs.
- **Empty inputs:** Empty arrays, empty strings, null, undefined.
- **Large inputs:** Very large datasets, very long strings.
- **Invalid inputs:** Malformed data, wrong types, unexpected formats.
- **Time boundaries:** Start/end of day, timezone transitions, daylight saving time.

#### 1.3 Test Quality Issues

- **Tests testing implementation details:** Tests that mock internal functions, assert on internal state, or break when refactoring without behavior change.
- **Fragile tests:** Tests dependent on specific ordering, timing, or external state.
- **Redundant tests:** Multiple tests asserting the same behavior in different ways.
- **Missing assertions:** Tests that run code but don't assert anything meaningful (or only assert `toBeDefined()`).
- **Dead test helpers:** Test utilities defined but never used.
- **Snapshot overuse:** Snapshot tests on large objects where targeted assertions would be better.
- **Test naming:** Tests with vague names ("should work", "handles edge case") that don't describe the specific behavior being tested.

#### 1.4 CI Pipeline Coverage

- **Job dependency chain:** Audit `.github/workflows/` — are jobs ordered correctly? If API smoke tests fail, does the Pages deploy still proceed?
- **Missing CI checks:** Is there a bundle size budget check? Lighthouse/performance CI? a11y linting (e.g., `eslint-plugin-jsx-a11y`)?
- **Test gates:** Does the `test:merge-gate` script run in CI? Are coverage thresholds enforced?
- **Smoke test coverage:** Do `test:smoke-api` and `test:critical-contracts` cover all API endpoints used by the frontend?

#### 1.5 Test Infrastructure

- **Test data factories:** Are there shared test data builders, or does each test file construct its own test data from scratch?
- **Mock patterns:** Are mocks consistent? Centralized mock setup vs. per-test file?
- **Test configuration:** Any misconfigurations in `vitest.config.ts`?

### Part 2: Documentation Accuracy

#### 2.1 Architecture & API Docs

Compare documentation against actual code:

- **`docs/architecture.md`:** Is the file tree accurate? Are all directories described? Any directories not mentioned?
- **`docs/api-reference.md`:** Do all documented endpoints exist? Do response shapes match actual responses? Are any endpoints missing from the docs?
- **`docs/data-flow-map.md`:** Does the flow map match the actual data pipeline? Any new cron jobs or API endpoints not reflected?
- **`docs/worker-infrastructure.md`:** Are cron schedules accurate? Are all cron jobs listed? Is the job count correct?

#### 2.2 Feature Documentation

For each feature doc in `docs/`:
- Do file paths mentioned in the doc still exist?
- Are function names accurate?
- Are schemas/types referenced still current?
- Are numeric constants (thresholds, weights, timeouts) still matching the code?

#### 2.3 Methodology Page Accuracy

The methodology page (`src/app/methodology/`) must match the scoring implementations:

- **PSI formula:** Does the methodology page match `worker/src/lib/stability-index.ts`?
- **PegScore formula:** Match against `shared/lib/peg-score.ts`?
- **DEWS formula:** Match against `worker/src/lib/dews.ts`?
- **LiquidityScore formula:** Match against `worker/src/lib/dex-liquidity.ts`?
- **Report Card grading:** Match against `shared/lib/report-cards.ts`?
- **Weights, thresholds, band boundaries:** All hardcoded values on the methodology page — do they match the source code?

#### 2.4 Scripts Directory Accuracy

- **`docs/scripts.md` accuracy:** Do all documented scripts in `docs/scripts.md` exist in `scripts/`? Are all scripts in `scripts/` documented?
- **Dead scripts:** Scripts referenced in `package.json` that no longer work or are unused.
- **Script quality:** Shell scripts (`*.sh`) missing error handling, hardcoded URLs, stale values.

#### 2.5 Environment Variable Documentation

- **Completeness:** Compare `Env` type in `worker/src/lib/env.ts` against `.env.example`. Flag undocumented environment variables.
- **Setup guide:** Is local development setup documented clearly enough for a new developer?

#### 2.6 Missing Documentation

- **Undocumented features:** Features in the codebase with no corresponding doc.
- **Undocumented API endpoints:** Endpoints in the worker router with no entry in `docs/api-reference.md`.
- **Undocumented cron jobs:** Cron jobs not mentioned in `docs/worker-infrastructure.md`.

#### 2.7 Stale Counts & References

Documentation often includes counts ("156 stablecoins", "19 cron jobs", etc.) that drift:

- **Stablecoin count:** Does the documented count match `Object.keys(STABLECOINS).length` in `shared/lib/stablecoins.ts`?
- **Cron job count:** Does the documented count match actual cron jobs?
- **Page count:** Does the documented page list match actual pages in `src/app/`?
- **Ghost references:** Docs referencing files, functions, or features that no longer exist.

## Report Format

Produce `RESEARCH-REPORT.md` in the worktree root:

```markdown
# R8: Testing & Documentation Audit Report

## Summary
- Source files audited: N
- Test files audited: N
- Doc files audited: N
- Testing findings: N coverage gaps, N quality issues, N infrastructure issues
- Documentation findings: N inaccuracies, N missing docs, N stale references

## Part 1: Testing

### Critical Coverage Gaps (untested critical logic)

#### Gap G1: [File/function with missing tests]
- **File:** `path:line`
- **Why critical:** [What breaks if this has a bug]
- **Tests needed:** [Unit | Integration | Both] — [specific scenarios]
- **Effort:** [Low | Medium | High]
- **Complexity:** [Simple | Moderate | Complex]

### Edge Case Coverage Gaps
- [Test file]: missing [boundary/empty/invalid] case for [function]

### Test Quality Issues
#### Issue Q1: [Description]
- **File:** `path:line`
- **Type:** [Implementation detail | Fragile | Redundant | Missing assertion | Dead helper]
- **Suggested fix:** [Concrete change]

### Test Infrastructure Assessment
- Test data factories: [Exist | Partially | None]
- Mock consistency: [Consistent | Inconsistent] — [details]
- Configuration issues: [None | List]

## Part 2: Documentation

### Inaccuracies Found

#### Inaccuracy D1: [Doc file — what's wrong]
- **File:** `docs/[file].md` line N
- **Claim:** "[what the doc says]"
- **Reality:** "[what the code actually does]"
- **Fix:** [Concrete correction]
- **Effort:** [Low | Medium | High]

### Missing Documentation
- [Feature/endpoint/cron] has no documentation

### Stale Counts & References
| Doc File | Claim | Actual | Needs Update |
|----------|-------|--------|-------------|
| [doc] | "N stablecoins" | M stablecoins | Yes |
| ... | ... | ... | ... |

### Ghost References (docs referencing things that don't exist)
- `docs/[file].md` line N references `path/file.ts` — file does not exist

### Methodology Page Accuracy
| Section | Source File | Matches | Discrepancies |
|---------|-----------|---------|---------------|
| PSI formula | worker/src/lib/stability-index.ts | [Yes | No] | [details] |
| PegScore | shared/lib/peg-score.ts | [Yes | No] | [details] |
| DEWS | worker/src/lib/dews.ts | [Yes | No] | [details] |
| LiquidityScore | worker/src/lib/dex-liquidity.ts | [Yes | No] | [details] |
| Report Cards | shared/lib/report-cards.ts | [Yes | No] | [details] |
| ... | ... | ... | ... |
```

## Acceptance Criteria

- `RESEARCH-REPORT.md` exists in the worktree root
- Coverage gap analysis checked every file in `shared/lib/` that contains scoring/classification logic
- Test quality assessment covers all existing test files
- CI pipeline audit covers `.github/workflows/` and `package.json` test scripts
- Documentation accuracy checked every file in `docs/`
- Scripts directory (`scripts/`) cross-referenced with `docs/scripts.md`
- Methodology page verified against actual scoring implementations (correct file paths in report)
- Stale count check compared documented numbers against actual code
- Every finding has exact `file:line` references
- Every finding has an effort estimate (Low/Medium/High)
- No code changes were made (read-only audit)
