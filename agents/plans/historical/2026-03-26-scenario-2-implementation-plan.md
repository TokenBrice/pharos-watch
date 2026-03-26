# Scenario 2 Implementation Plan

Date: 2026-03-26

## Goal

Implement Scenario 2 from the testing/deployment audit:

1. Keep Scenario 1 changes:
   - refactor `smoke-ui` to a single browser process
   - keep the current local artifact UI coverage
   - reduce live UI smoke to homepage + GA snippet + one canary route
   - merge `prepare-digests` into `build-pages`
2. Add Scenario 2 changes:
   - make deploy-path `validate` diff-aware using the existing deploy classification model
   - skip `build` + `seo:check` on worker-only pushes
   - skip worker typecheck on pages-only pushes
   - skip the deploy workflow’s heavy work entirely when a push changes neither Pages nor worker deploy surfaces

This plan is for implementation only. It does not change the recommended policy boundaries from the audit.

## Target Outcome

Runtime targets from the audit:

- full combined deploy: `8m40s` to `9m10s`
- pages-only deploy: `6m45s` to `7m15s`
- worker-only deploy: `4m45s` to `5m15s`

Success criteria:

- main-push deploys stay surface-aware without widening obvious blind spots
- PR validation remains full-strength unless deliberately changed later
- local merge-gate behavior stays intentionally aligned with main-push deploy validation
- docs-only or other non-deploy pushes to `main` stop paying for the full deploy path

## Scope

In scope:

- `.github/workflows/deploy-cloudflare.yml`
- `.github/workflows/pages-release.yml`
- `.github/workflows/validate-ci.yml`
- `.github/workflows/pull-request-checks.yml` only if reusable-workflow inputs need explicit defaults
- `scripts/smoke-ui.mjs`
- `scripts/test-merge-gate.mjs`
- `scripts/classify-deploy-changes.mjs`
- `scripts/lib/deploy-impact.mjs` only if classifier outputs need a small extension
- `scripts/__tests__/test-merge-gate.test.ts`
- `scripts/__tests__/classify-deploy-changes.test.ts`
- `scripts/__tests__/validate-ci-parity.test.ts`
- `docs/testing.md`
- `docs/deployment-process.md`

Out of scope:

- removing `npm test` from main-push deploys
- shrinking the local artifact overflow sweep
- broadening `smoke-api`
- changing production methodology/data behavior
- redesigning the PR validation policy beyond what is needed to preserve current behavior

## Guardrails

- Keep full `validate` behavior on pull requests by default.
- Do not reduce the local artifact smoke route set in this scenario.
- Do not remove `smoke-api` or `smoke-ops`.
- Do not weaken migration safety, cron checks, doc-sync, or hotspot guards just to save seconds; they are not the main runtime offenders.
- Any new diff-aware behavior must be covered by script tests and documented in both testing and deployment docs.

## Recommended Implementation Order

1. Land the `smoke-ui` refactor and live-scope split.
2. Collapse Pages digest/build duplication.
3. Make deploy-path `validate` input-driven and diff-aware.
4. Align the local merge gate with the new deploy-path policy.
5. Update docs and verify runtime behavior against the next real runs.

This order keeps the highest-confidence, lowest-policy-risk savings first and prevents CI wiring changes from obscuring browser/runtime improvements.

## Workstream 1: Refactor `smoke-ui` And Split Local vs Live Modes

### Objective

Remove the current repeated `playwright-cli` shell-out overhead while preserving the local predeploy UI coverage. Keep a live smoke, but cut it down to a narrow canary check.

### Files

- `scripts/smoke-ui.mjs`
- `package.json` only if a direct Playwright runner or helper dependency is required
- `docs/testing.md`
- `.github/workflows/pages-release.yml`
- `.github/workflows/deploy-cloudflare.yml`

### Changes

1. Replace the repeated `npx --yes --package @playwright/cli playwright-cli` command cycle with one browser session and one in-process control flow.
2. Introduce explicit smoke modes instead of one implicit behavior:
   - local artifact mode: current homepage data checks + full mobile overflow route sweep
   - live canary mode: homepage data checks + GA snippet verification + exactly one canary route overflow check
3. Keep the current GA snippet assertion path intact in both modes.
4. Preserve the current failure semantics for homepage data availability, error banners, and known ticker detection.
5. Preserve environment-driven timing controls where they still matter.

### Design Recommendation

Preferred approach:

- keep `scripts/smoke-ui.mjs` as the entrypoint
- move from command-shell orchestration to one browser automation session inside the script
- make the route list mode-dependent rather than globally defaulted

Recommended route policy:

- local artifact mode: keep the existing 9-route overflow sweep
- live canary mode: `/` plus one high-signal canary route, recommended `/yield/` or `/liquidity/`

Rationale:

- local smoke is the place to catch broad layout regressions before deploy
- live smoke’s unique value is production-host wiring, not redoing the entire artifact sweep

### Risks

- browser dependency/setup strategy can accidentally reintroduce cold-start overhead
- changing the smoke runner and the workflow scope at the same time can make regressions harder to localize

### Mitigations

- land the mechanical runner refactor first, then narrow live scope in the same PR only if the script-level behavior is well covered
- if browser dependency choice is ambiguous, benchmark the runner on CI before finalizing the package choice
- keep the CLI surface stable: `npm run test:smoke-ui -- --url ...`

### Acceptance Criteria

- local Pages smoke still exercises the current 9-route overflow set
- live Pages smoke checks homepage + GA + one canary route only
- worker-only live smoke uses the same slim live mode
- the new runner is materially faster on CI without reducing local artifact coverage

## Workstream 2: Collapse `prepare-digests` Into `build-pages`

### Objective

Remove the extra Pages job and extra install/artifact handoff that currently fetch digest data separately from the build.

### Files

- `.github/workflows/pages-release.yml`
- `docs/testing.md`
- `docs/deployment-process.md`

### Changes

1. Fold digest fetching into `build-pages`.
2. Keep digest normalization and storage under `.artifacts/` or `data/` exactly as needed by the build.
3. Keep `build-pages` responsible for:
   - install
   - digest fetch
   - Pages build
   - SEO check
   - Pages artifact upload
4. Remove the `prepare-digests` job and its artifact upload/download hop.

### Design Recommendation

`build-pages` should become the single authoritative Pages artifact producer. Everything after it should consume the same built artifact.

That means:

- `smoke-ui` downloads `pages-static-export`
- `deploy-pages` downloads `pages-static-export`
- no separate digest artifact should remain unless another workflow genuinely needs it

### Risks

- digest fetch and build failures become coupled inside one job
- any script that assumed the digest artifact exists independently may need adjustment

### Mitigations

- keep the digest fetch as a clearly named step inside `build-pages`
- keep failure output explicit so it is obvious whether the failure was fetch, build, or SEO

### Acceptance Criteria

- Pages path runs one fewer Node install on push/manual deploys and rebuilds
- the built artifact still remains the only artifact deployed and smoked
- no functional change to digest input data handling

## Workstream 3: Make Deploy-Path `validate` Diff-Aware

### Objective

Use the existing deploy-surface classification to stop paying for export validation on worker-only pushes, stop paying for worker typecheck on Pages-only pushes, and short-circuit deploy-path validation entirely when a push has no deploy impact.

### Files

- `.github/workflows/deploy-cloudflare.yml`
- `.github/workflows/validate-ci.yml`
- `scripts/classify-deploy-changes.mjs`
- `scripts/__tests__/classify-deploy-changes.test.ts`
- `scripts/__tests__/validate-ci-parity.test.ts`

### Changes

1. Run `detect-changes` before `validate` in the deploy workflow and feed its outputs into the reusable validate workflow.
2. Extend the reusable workflow inputs so deploy callers can state:
   - whether Pages-impacting files changed
   - whether worker-impacting files changed
   - whether deploy work is needed at all
3. Keep the reusable workflow defaults permissive so PR callers still run the full validate gate without passing these inputs.
4. In deploy-path `validate`:
   - always run the common core checks and `npm test`
   - run `npm run build` and `npm run seo:check` only when `pages_changed=true`
   - run `cd worker && npx tsc --noEmit` only when `worker_changed=true`
5. Skip deploy-path `validate` entirely when `pages_changed=false` and `worker_changed=false`.
6. Add a lightweight no-op summary job or workflow summary message for the no-deploy case so skipped deploys are explicit in Actions UI.

### Design Recommendation

Do not make `validate-ci.yml` self-diffing. Keep classification in one place and pass booleans into the reusable workflow.

Recommended input model:

- `coverage-compare-ref` existing input
- `pages-changed` boolean input, default `true`
- `worker-changed` boolean input, default `true`

Derived behavior:

- PR workflow passes only `coverage-compare-ref` and therefore still runs full validate
- deploy workflow passes the classifier outputs and gets diff-aware behavior

Recommended deploy short-circuit:

- keep the deploy workflow trigger on all pushes to `main`
- let `detect-changes` run first
- skip `validate`, deploy jobs, and smoke jobs when there is no deploy impact

This is preferable to a broad `paths:` trigger filter because the existing classifier is already the source of truth and is easier to test.

### Risks

- incorrect classifier behavior could skip a required validation step
- reusable-workflow input defaults could accidentally weaken PR checks
- workflow parity tests can become brittle once step-level `if:` conditions are added

### Mitigations

- add explicit classifier tests for docs-only and no-deploy diffs
- update parity tests so they assert the command contract plus conditionality, not just a flat run list
- keep PR workflow unchanged at the call site unless the new reusable inputs require explicit values for clarity

### Acceptance Criteria

- worker-only main pushes do not run build or SEO
- Pages-only main pushes do not run worker typecheck
- docs-only or other non-deploy main pushes finish after `detect-changes` with no heavy validation/deploy jobs
- PR validation still runs the full current validate set

## Workstream 4: Align `test:merge-gate` With Scenario 2

### Objective

Keep local pre-push validation intentionally aligned with deploy-path validation instead of the fuller PR path.

### Files

- `scripts/test-merge-gate.mjs`
- `scripts/__tests__/test-merge-gate.test.ts`
- `docs/testing.md`
- `docs/deployment-process.md`

### Changes

1. Replace the current “always run shared validate core, conditionally add build/SEO” policy with surface-aware planning:
   - no deploy-impacting files: print skip plan and exit successfully
   - Pages-only: run common core + build/SEO, skip worker typecheck
   - worker-only: run common core + worker typecheck, skip build/SEO
   - combined/shared/infrastructure: run full set
2. Reuse the same deploy-impact matcher already used by CI classification.
3. Preserve the existing smaller skippable-check logic only if it still fits cleanly inside the new policy; otherwise remove it in favor of a simpler, easier-to-reason-about deploy-surface contract.

### Design Recommendation

Prefer coherence over micro-optimization.

The current merge gate has a second layer of per-check path skipping on top of Pages detection. Scenario 2 should not become a three-layer decision tree. If that extra granularity makes parity hard to reason about, collapse the merge gate to:

- always-run common core for deploy-impacting changes
- add Pages export checks only for Pages-impacting changes
- add worker typecheck only for worker-impacting changes
- skip completely for no-deploy diffs

That policy is easier to document, easier to test, and closer to the runtime savings the audit is targeting.

### Risks

- the local gate becomes less strict on docs-only pushes than it is today
- developers may interpret a skipped merge gate as “nothing to validate” rather than “no deploy-surface validation required”

### Mitigations

- update docs so the distinction between PR validation and deploy-surface merge-gate validation is explicit
- print the changed files and the reason for a skip in the merge-gate output

### Acceptance Criteria

- merge-gate command planning clearly matches the new deploy-surface model
- docs-only local pushes do not run full lint/test/build/typecheck just to satisfy deploy parity
- test coverage exists for Pages-only, worker-only, combined, and no-deploy plans

## Workstream 5: Docs, Tests, And Rollout Evidence

### Objective

Make the new policy understandable and prove it behaves as intended.

### Files

- `docs/testing.md`
- `docs/deployment-process.md`
- `scripts/__tests__/test-merge-gate.test.ts`
- `scripts/__tests__/classify-deploy-changes.test.ts`
- `scripts/__tests__/validate-ci-parity.test.ts`

### Required Doc Changes

1. Update the validate section to distinguish:
   - PR/full validate behavior
   - main-push diff-aware deploy behavior
2. Update the Pages release section to describe:
   - digest fetch inside `build-pages`
   - local smoke vs live canary smoke
3. Update the merge-gate section to describe:
   - no-deploy skip behavior
   - Pages-only and worker-only conditional steps

### Required Test Coverage

1. `classify-deploy-changes`:
   - docs-only diff -> `pages_changed=false`, `worker_changed=false`
   - workflow/script changes still classified correctly
2. `test-merge-gate`:
   - no-deploy plan
   - Pages-only plan
   - worker-only plan
   - combined/shared plan
3. `validate-ci-parity`:
   - update from flat run-command equality to a shape/assertion model that can tolerate conditional workflow steps while still guarding the contract

### Verification Checklist

Required local verification after implementation:

- `npm test`
- `npm run lint`
- `npm run build`
- `npm run seo:check`
- `cd worker && npx tsc --noEmit`

Recommended targeted verification:

- `vitest run scripts/__tests__/classify-deploy-changes.test.ts scripts/__tests__/test-merge-gate.test.ts scripts/__tests__/validate-ci-parity.test.ts`
- `npm run test:smoke-ui -- --url http://127.0.0.1:4173` against a locally served export
- dry-run merge-gate scenarios using representative changed-file sets

Post-merge verification:

- compare the next real combined, Pages-only, worker-only, and no-deploy `main` pushes against the audit baselines
- confirm that the no-deploy path exits after classification with an explicit reason
- confirm that PR validation still runs full build, SEO, full test suite, critical coverage, and worker typecheck

## Runtime Savings By Workstream

Estimated contribution to Scenario 2:

- `smoke-ui` mechanical refactor + live-scope reduction: largest single savings after validate
- merged digest/build path: moderate Pages-path savings
- diff-aware deploy validate: large savings on worker-only and Pages-only paths, plus major savings on no-deploy pushes

Approximate expected shape after all Scenario 2 work lands:

- full combined: around `8m40s` to `9m10s`
- pages-only: around `6m45s` to `7m15s`
- worker-only: around `4m45s` to `5m15s`
- no-deploy push: near-immediate completion after classification

## Rollout Strategy

1. Land the script/workflow/test/doc changes in one PR if the diff stays readable.
2. If the `smoke-ui` refactor grows large, split it from the CI diff-awareness changes:
   - PR 1: `smoke-ui` refactor + live-scope split + Pages workflow consolidation
   - PR 2: diff-aware validate + merge-gate alignment + docs/tests
3. After merge, monitor the next natural runs instead of forcing artificial pushes just to collect timing.
4. If classification or conditional validate behavior misfires, revert the deploy-path gating first and keep the `smoke-ui` and Pages-duplication improvements.

## Backout Plan

Fastest safe backout order:

1. revert deploy-workflow diff-aware validate gating
2. revert merge-gate policy changes
3. keep the `smoke-ui` mechanical refactor if it is stable
4. keep the merged Pages digest/build path if it is stable

Reasoning:

- the highest-risk part of Scenario 2 is conditional validation policy, not the browser runner refactor or the Pages job collapse

## Decisions To Preserve During Implementation

- PR validation remains full by default
- local artifact UI smoke remains broad
- live UI smoke becomes intentionally narrow and host-focused
- deploy classification remains the single source of truth for surface-aware behavior
- the repo does not pursue Scenario 3 or 4 policy cuts as part of this implementation
