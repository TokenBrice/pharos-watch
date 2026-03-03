# Runtime-Neutral Reliability Gates Implementation Plan

**Date:** 2026-03-03  
**Status:** Proposed (implementation-ready)  
**Owner:** Engineering  
**Scope:** CI/process reliability hardening only. No product feature expansion.

---

## 1. Objective

Implement three improvements that increase test reliability and merge safety without increasing end-to-end deployment runtime:

1. **Runtime-neutral CI expansion:** remove duplicate CI test execution and spend the reclaimed budget on targeted high-risk coverage.
2. **Worktree merge delta gate:** run extra tests when worktree branches are merged back into `main`.
3. **Critical coverage ratchet:** enforce no-regression coverage for touched critical files.

Primary outcomes:

1. Better regression detection on critical paths with flat or lower wall-clock CI time.
2. Deterministic local gate before pushing merged worktree changes.
3. Coverage trend moves up over time and cannot silently drift downward in critical files.

---

## 2. Non-Goals

1. No changes to score models, APIs, or UI behavior.
2. No replacement of Vitest/ESLint/GitHub Actions stack.
3. No migration of deploy platform (Cloudflare workflow stays current).
4. No broad test infra rewrite.

---

## 3. Current Baseline (as of 2026-03-03)

## 3.1 CI validate job currently runs overlapping suites

From `.github/workflows/deploy-cloudflare.yml`:

1. `npm run lint`
2. `npm test`
3. `npm run test:critical-contracts`
4. `npm run test:invariants`
5. `npm run coverage:critical`
6. `cd worker && npx tsc --noEmit`

Issue: steps 3 and 4 are subsets of step 2 (`npm test`), so the same files are executed multiple times before step 5 runs them again with coverage.

## 3.2 Coverage gate exists but is static-threshold only

`scripts/check-critical-coverage.mjs` enforces:

1. fixed floor (`CRITICAL_COVERAGE_THRESHOLD`, default `35`)
2. fixed list of critical files

Gap: if a file drops from 80% to 36%, CI still passes.

## 3.3 Worktree merge guard is documented conceptually, not automated

Current workflow triggers on push to `main`, but there is no dedicated local merge gate script that adapts tests to changed files after merging a worktree branch.

## 3.4 Critical coverage weak spot (local snapshot)

Local snapshot indicates `worker/src/cron/sync-stablecoins.ts` is the weakest critical file (~39.2% line coverage), making it the highest-value target for additional tests.

---

## 4. Target Operating Contract

1. **Before pushing merged worktree changes to `main`**, run a delta-aware local gate.
2. **CI validate runtime stays roughly flat** by eliminating duplicate test passes and reallocating budget to high-yield tests.
3. **Touched critical files cannot regress in coverage** relative to an explicit baseline.

---

## 5. Workstream A: Runtime-Neutral CI Expansion

## 5.1 Design

Reduce duplicate test execution in CI validate, then add targeted tests in the weakest critical area.

Strategy:

1. Keep one full correctness run (`npm test`).
2. Keep one critical coverage run (`npm run coverage:critical`).
3. Remove duplicate non-coverage reruns (`test:critical-contracts`, `test:invariants`) from CI validate.
4. Use recovered runtime to add focused reliability tests for `sync-stablecoins`.

## 5.2 File-Level Changes

1. `.github/workflows/deploy-cloudflare.yml`
   - Remove `npm run test:critical-contracts` and `npm run test:invariants` from `validate`.
   - Keep `npm test` and `npm run coverage:critical`.
2. `worker/src/cron/__tests__/sync-stablecoins.test.ts`
   - Add high-value branch tests (see 5.3).
3. `docs/testing.md`
   - Clarify CI execution order and why duplicates were removed.

## 5.3 Test Additions (Targeted)

Add tests for branches currently underrepresented in `sync-stablecoins`:

1. Circuit half-open recovery path records success and continues.
2. CoinGecko fallback-only success with sufficient market-cap coverage writes cache.
3. Cache-write guard branch: stale payload is skipped (`setCacheIfNewer` false path).
4. Final schema-validated payload keeps normalized bucket and alias behavior under mixed source data.

Acceptance for this workstream:

1. CI validate runtime is not increased.
2. `sync-stablecoins` critical coverage increases measurably from baseline.
3. New tests validate failure and recovery paths, not only happy path.

---

## 6. Workstream B: Worktree Merge Delta Gate

## 6.1 Design

Introduce a local script that computes changed files between current `HEAD` and merge-base with `origin/main`, then runs only the required gate commands.

Script: `scripts/test-merge-gate.mjs`

Inputs:

1. Base ref (default `origin/main`; override via `MERGE_GATE_BASE_REF`)
2. Mode (default merged state; optional `--staged`)

Output:

1. Selected command plan
2. Pass/fail exit code
3. Summary of changed file classes and executed commands

## 6.2 Command Map (Initial Policy)

1. Any change in `worker/src/api/**`, `src/lib/types.ts`, `src/lib/api.ts`:
   - `npm run test:critical-contracts`
   - `npm run coverage:critical`
2. Any change in `worker/src/cron/**` or `worker/src/lib/**`:
   - `npm run test:invariants`
   - `npm run coverage:critical`
3. Any workflow/script gate changes (`.github/workflows/**`, `scripts/check-critical-coverage.mjs`, `scripts/test-merge-gate.mjs`, `package.json` scripts):
   - `npm test`
   - `npm run coverage:critical`
4. Frontend-only non-critical changes:
   - `npm test` (default fallback)
5. Always include `npm run lint` and `cd worker && npx tsc --noEmit` when any TypeScript code changed.

## 6.3 Hook + Invocation

1. Add npm script:
   - `"test:merge-gate": "node scripts/test-merge-gate.mjs"`
2. Optional local hook:
   - `.githooks/pre-push` executes `npm run test:merge-gate` only when pushing `main`.
3. Developer workflow:
   - Merge worktree branch into local `main`
   - Run `npm run test:merge-gate`
   - Push only on pass

## 6.4 File-Level Changes

1. Add: `scripts/test-merge-gate.mjs`
2. Update: `package.json` scripts
3. Add: `.githooks/pre-push` (optional but recommended)
4. Update docs:
   - `docs/deployment-process.md` (worktree merge gate command)
   - `docs/testing.md` (command reference)

Acceptance for this workstream:

1. Merged worktree changes can be gated locally with one command.
2. Gate is delta-aware and significantly faster than full CI-equivalent runs for small diffs.
3. Critical-path changes always trigger critical coverage gate.

---

## 7. Workstream C: Critical Coverage Ratchet (No Regression)

## 7.1 Design

Extend current critical coverage gate to enforce both:

1. Absolute floor (existing behavior)
2. No-regression baseline for touched critical files

Mechanism:

1. Store baseline in versioned file: `.ci/critical-coverage-baseline.json`
2. Parse current `coverage/lcov.info`
3. For each touched critical file, fail if:
   - current < threshold floor, or
   - current < baseline[file] - tolerance

Default tolerance: `0.0` (strict no regression). Optional env override for emergency.

## 7.2 File-Level Changes

1. Update `scripts/check-critical-coverage.mjs`
   - add baseline parsing
   - add touched-file mode (via changed file list or env)
   - print explicit baseline/current deltas
2. Add `.ci/critical-coverage-baseline.json`
   - initial values seeded from first accepted run
3. Optional helper:
   - `scripts/update-critical-coverage-baseline.mjs` for controlled baseline refresh
4. Update `.github/workflows/deploy-cloudflare.yml`
   - pass base ref and/or changed-files context when available

## 7.3 Baseline Governance

1. Baseline may be updated only in dedicated maintenance PRs.
2. Baseline decreases are disallowed unless explicitly approved and documented with reason.
3. Baseline increases are encouraged after significant test additions.

Acceptance for this workstream:

1. Critical files cannot silently lose coverage while still staying above 35%.
2. CI output clearly identifies regression source file and delta.
3. Baseline update procedure is explicit and auditable.

---

## 8. Delivery Plan (Phased)

## Phase 0: Baseline Capture (0.5 day)

1. Capture current critical coverage percentages.
2. Record initial `.ci/critical-coverage-baseline.json`.
3. Confirm command timings for current `validate`.

## Phase 1: CI Runtime De-dup + Tests (1 day)

1. Remove duplicate CI reruns.
2. Add targeted `sync-stablecoins` tests.
3. Verify total `validate` runtime is flat or better.

## Phase 2: Merge Delta Gate (1 day)

1. Implement `scripts/test-merge-gate.mjs`.
2. Add package script and optional pre-push hook.
3. Update deployment/testing docs.

## Phase 3: Coverage Ratchet (1 day)

1. Extend coverage gate script.
2. Add baseline file and policy docs.
3. Validate fail/pass scenarios using simulated regressions.

## Phase 4: Rollout + Stabilization (0.5 day)

1. Announce operational workflow to all contributors/agents.
2. Observe first week of merged-worktree pushes.
3. Tune command map and false-positive behavior if needed.

---

## 9. Risks and Mitigations

1. Risk: Delta gate misses an important dependency.
   - Mitigation: conservative mapping with fallback to `npm test` for unknown paths.
2. Risk: Coverage ratchet blocks urgent fixes.
   - Mitigation: emergency override env var + follow-up baseline correction policy.
3. Risk: Hook friction causes local bypass.
   - Mitigation: keep gate command simple and document direct invocation in deploy process doc.
4. Risk: Runtime-neutral goal fails if new tests are too heavy.
   - Mitigation: restrict additions to branch-heavy unit tests; avoid new integration/smoke runtime in validate.

---

## 10. Verification Matrix

1. Functional verification:
   - Intentionally break a critical contract test -> delta gate and CI fail.
   - Intentionally reduce covered branch in critical file -> ratchet fails.
2. Runtime verification:
   - Compare validate duration before/after changes across at least 3 runs.
3. Process verification:
   - Merge worktree branch into `main`, run `npm run test:merge-gate`, then push.

---

## 11. Definition of Done

All conditions must hold:

1. CI `validate` no longer reruns duplicate non-coverage subsets.
2. Worktree merge delta gate command exists and is documented.
3. Critical coverage gate enforces both floor and no-regression baseline.
4. `sync-stablecoins` critical coverage is improved with new reliability tests.
5. Documentation updated:
   - `docs/deployment-process.md`
   - `docs/testing.md`

---

## 12. Suggested PR Breakdown

1. **PR-1 CI de-dup + targeted tests**
   - workflow + `sync-stablecoins.test.ts`
2. **PR-2 Merge delta gate**
   - `scripts/test-merge-gate.mjs`, `package.json`, optional hook, docs
3. **PR-3 Coverage ratchet**
   - `check-critical-coverage.mjs`, baseline file, docs/workflow wiring

This split keeps each change small, testable, and reversible.
