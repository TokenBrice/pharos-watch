# Development Methodology Audit

Date: 2026-03-22
Scope: testing, validation, deployment workflow, pre-push gates, documentation logic, and adjacent delivery methodology.
Status: audit complete; remediation implemented on 2026-03-22 and tracked in [plans/2026-03-22-development-methodology-remediation-plan.md](./plans/2026-03-22-development-methodology-remediation-plan.md)

## Audit Method

This audit is intentionally first-principles driven. For each part of the delivery system, the working questions are:

- What is the actual contract?
- Where is that contract enforced?
- Is the enforcement ordered correctly?
- Is the same failure caught locally before CI and before production?
- Does the documentation match reality?
- If a step fails, what state is left behind?
- Are expensive or destructive steps delayed until after cheaper confidence-building steps?
- Are there silent gaps where a human must remember policy instead of the repo enforcing it?

## Initial Map

Observed enforcement surfaces:

- `.github/workflows/validate-ci.yml`
- `.github/workflows/deploy-cloudflare.yml`
- `.github/workflows/pages-release.yml`
- `.github/workflows/rebuild-pages.yml`
- `.githooks/pre-push`
- `scripts/test-merge-gate.mjs`
- `package.json` scripts
- `docs/testing.md`
- `docs/deployment-process.md`

## Early Observations

1. The main production deploy workflow already validates before deploy. That addresses the earlier "deploy in the middle of validation" concern at the top-level workflow.
2. The local pre-push hook is intentionally minimal and delegates all enforcement to `npm run test:merge-gate`, which is structurally good because it reduces drift between policy and hook implementation.
3. The key audit question now is whether `test:merge-gate` is truly equivalent to CI, or whether local and CI validation are only partially aligned.
4. Another key question is whether docs and repo rules are enforced by code, or still partly dependent on humans remembering process.

## Confirmed Findings

### 1. Frontend build validation is missing from PR validation and is too narrowly triggered in the local merge gate

Severity: high

First-principles question:

- If a change can affect the Pages artifact, where is `next build` guaranteed to run before the change reaches `main`?

What the repo does today:

- PR validation (`.github/workflows/validate-ci.yml`) does not run `npm run build` or `npm run seo:check`.
- The local merge gate only adds build/SEO when the diff touches `src/app/`, `src/components/`, `public/`, `next.config.*`, or two SEO/build helper scripts (`scripts/test-merge-gate.mjs`).
- Actual Pages deployment classification is broader: any `src/`, `shared/`, `functions/`, `public/`, `data/`, or certain infra/config changes trigger the Pages release path (`scripts/classify-deploy-changes.mjs`), whose `build-pages` job does run `npm run build`.

Why this matters:

- A change in `src/lib/`, `src/hooks/`, `shared/`, or `functions/` can break the Pages build or frontend type-checking, yet still pass PR validation and also skip the local build gate.
- That means the first guaranteed build can happen only after the change is already on `main`, inside the deploy workflow.
- Because root `tsconfig.json` includes all `**/*.ts` / `**/*.tsx` except `worker/`, `npm run build` is also the only dedicated repo-level type-check step for non-worker TypeScript surfaces such as `functions/`.

Evidence:

- `.github/workflows/validate-ci.yml:23-40`
- `scripts/test-merge-gate.mjs:9-19`
- `scripts/classify-deploy-changes.mjs:13-19`
- `.github/workflows/pages-release.yml:27-43`
- `tsconfig.json:26-34`
- `README.md:107`

### 2. Production schema changes are applied before the new worker is live, and before runtime verification runs

Severity: high

First-principles question:

- If a D1 migration succeeds but the new worker deploy fails, what guarantees that the still-live old worker remains compatible with the new schema?

What the repo does today:

- The worker deploy order is: apply D1 migrations, deploy worker, then sync triggers.
- Runtime verification (`smoke-api`) only starts after the whole deploy-worker job succeeds.
- The pre-deploy migration check only proves replayability against a throwaway SQLite database; it does not prove compatibility between old code and new schema.

Why this matters:

- This workflow is safe only if production migrations are intentionally backward-compatible with both the old worker and the new worker.
- I did not find that rule stated explicitly in the delivery docs or enforced mechanically.
- Without that discipline, a failed worker deploy can still leave production in a partially migrated state.

Evidence:

- `.github/workflows/deploy-cloudflare.yml:53-58`
- `.github/workflows/deploy-cloudflare.yml:60-76`
- `package.json:39`
- `.github/workflows/validate-ci.yml:27`
- `scripts/check-worker-migrations.mjs:82-114`

### 3. The local merge gate does not actually mirror CI for critical coverage regression checks

Severity: medium-high

First-principles question:

- If CI rejects a coverage regression on a touched critical file, can that same regression be caught locally before push?

What the repo does today:

- CI passes `CRITICAL_COVERAGE_COMPARE_REF` into `npm run coverage:critical` (`.github/workflows/validate-ci.yml`).
- `scripts/check-critical-coverage.mjs` only runs the ratchet compare when `CRITICAL_COVERAGE_COMPARE_REF` or `CRITICAL_COVERAGE_CHANGED_FILES` is provided.
- The local merge gate runs `npm run coverage:critical` with no compare-ref injection.

Why this matters:

- Local runs still enforce absolute coverage thresholds.
- Local runs do not enforce the diff-aware ratchet that CI enforces.
- The docs currently say the merge gate "mirrors the shared CI validate core", which overstates parity.

Evidence:

- `.github/workflows/validate-ci.yml:36-39`
- `package.json:22`
- `scripts/check-critical-coverage.mjs:12-18`
- `scripts/check-critical-coverage.mjs:28-55`
- `scripts/check-critical-coverage.mjs:84-92`
- `docs/testing.md:113`

### 4. The documented pre-push policy contradicts actual repo behavior in multiple places

Severity: medium

First-principles question:

- If a contributor asks "when does the pre-push gate run?", is there a single unambiguous answer?

Observed contradiction:

- `package.json` auto-configures `.githooks` during `npm install` via `prepare`, so the hook is not merely "optional" in the normal setup path.
- `.githooks/pre-push` runs the merge gate on every push, with no branch check.
- `docs/deployment-process.md` says the hook is optional and only runs for pushes to `main`.
- `AGENTS.md` says developers should always run the merge gate before pushing any branch, while also saying the hook only enforces it for `main`.

Why this matters:

- Process docs are supposed to reduce uncertainty. Here they currently create it.
- When docs and enforcement disagree, people either stop trusting the docs or start bypassing enforcement.

Evidence:

- `package.json:42`
- `.githooks/pre-push:1-5`
- `docs/deployment-process.md:43-54`
- `AGENTS.md:47-57`

### 5. Coverage documentation currently overstates what CI actually enforces

Severity: medium-high

First-principles question:

- When a contributor reads the testing docs, do they learn the real coverage gate or an aspirational one?

What the repo does today:

- `docs/testing.md` says coverage enforcement is a global 66% line threshold plus the critical gate.
- CI does not run `npm test -- --coverage`; it runs `npm run coverage:critical`.
- That command explicitly disables Vitest's global threshold for the run (`--coverage.thresholds.lines=0`) and then hands off to the critical-file checker.

Why this matters:

- Engineers can make incorrect assumptions about what a green CI run proves.
- This is a methodology issue, not just a wording issue, because process decisions depend on knowing which guarantees are real.

Evidence:

- `docs/testing.md:491-503`
- `package.json:22`
- `.github/workflows/validate-ci.yml:36-39`
- `scripts/check-critical-coverage.mjs:12`

### 6. Delivery workflow knowledge is duplicated across several docs, but the duplication is not mechanically protected

Severity: medium

First-principles question:

- Is there one canonical document for the delivery workflow, or several narrative copies that all need manual synchronization?

What the repo does today:

- The same workflow logic is restated in `AGENTS.md`, `README.md`, `docs/testing.md`, and `docs/deployment-process.md`.
- `check-doc-sync` and `check-doc-counts` protect some methodology/constants docs, but they do not verify the delivery-workflow docs.
- `AGENTS.md` calls `/docs/` the "verified documentation corpus", but the delivery docs under review are largely outside the actual doc-sync coverage.
- There are tests for `test-merge-gate` and `classify-deploy-changes`, but no test that asserts the local merge gate still matches `validate-ci.yml`.

Why this matters:

- The repo already has one concrete drift example (pre-push behavior).
- The repo also has a second concrete drift example (coverage enforcement wording).
- Future workflow changes have to be updated in code plus several docs, with no automated parity check.

Evidence:

- `docs/testing.md:32-119`
- `docs/deployment-process.md:89-151`
- `README.md:266-275`
- `AGENTS.md:19`
- `scripts/check-doc-sync.ts:208-447`
- `scripts/__tests__/test-merge-gate.test.ts:1-30`

### 7. Changes to the Pages deployment workflows can ship without ever exercising the changed workflow

Severity: medium

First-principles question:

- If someone changes `pages-release.yml` itself, what path proves that the changed workflow still works before the next real production use?

What the repo does today:

- PR checks only call the reusable `validate-ci.yml` workflow.
- On push to `main`, `pages-release` only runs when `pages_changed=true`.
- The deploy classifier's infra allowlist includes `deploy-cloudflare.yml` and `validate-ci.yml`, but not `pages-release.yml` or `rebuild-pages.yml`.

Why this matters:

- A commit that only changes Pages release workflow logic can merge and push without ever executing that changed workflow.
- The first real rehearsal may be a later Pages-affecting push or the next scheduled rebuild.

Evidence:

- `.github/workflows/pull-request-checks.yml:12-16`
- `.github/workflows/deploy-cloudflare.yml:78-95`
- `.github/workflows/rebuild-pages.yml:1-15`
- `scripts/classify-deploy-changes.mjs:21-27`

## Implementation Seeds

These are not a full implementation plan yet. They are the most direct remediation directions suggested by the findings.

1. Unify Pages-impact detection behind one source of truth.
   - Reuse the deploy classifier logic for local build gating, or extract a shared "Pages-impact" matcher consumed by both `scripts/test-merge-gate.mjs` and `scripts/classify-deploy-changes.mjs`.
   - Then decide whether `validate-ci.yml` should always build, or at least build on Pages-impacting PR diffs.

2. Make local coverage ratchet behavior match CI.
   - Pass a compare ref or explicit changed-file list into `coverage:critical` from `test:merge-gate`.
   - Add a regression test that proves CI/local parity, not just stability of an internal constant list.

3. Make migration safety explicit.
   - Either document and enforce a backward-compatible migration rule, or redesign the worker deploy sequence around a safer two-phase schema rollout.
   - The important part is to stop treating old-code/new-schema compatibility as an implicit assumption.

4. Collapse workflow/process duplication.
   - Pick one canonical delivery-workflow doc, and let the other docs link to it instead of restating the full sequence.
   - Where duplication must stay, add automated parity checks.

5. Decide the real pre-push policy, then encode that policy consistently.
   - If the intended policy is "every push", update the docs accordingly.
   - If the intended policy is "main only", add the branch check to `.githooks/pre-push` and stop auto-installing a broader hook than the docs describe.

6. Add a rehearsal path for workflow changes.
   - Either classify Pages workflow files as Pages-impacting, or add a dedicated workflow-validation path that executes the reusable Pages workflow on relevant PRs/branches.

## Implementation Follow-Up

Remediation status in the repository on 2026-03-22:

1. Implemented: shared Pages-impact matcher now drives both deploy classification and local merge-gate build/SEO triggering.
2. Implemented: shared `validate` CI now runs `npm run build` and `npm run seo:check` before tests and coverage.
3. Implemented: local merge gate now passes changed-file context into `coverage:critical`, and workflow-parity tests guard drift.
4. Implemented: pre-push docs now match actual every-push hook behavior and `docs/deployment-process.md` is the canonical delivery reference.
5. Implemented: migration safety is now an explicit documented contract and is enforced inside `npm run check:migrations` for new migrations from `0071` onward.
6. Implemented: the shared Pages release workflow now runs a live public-host smoke after Pages publish, resolving Q1 from this audit.

## Evidence Log

- Read `package.json`
- Read `.github/workflows/*.yml`
- Read `.githooks/pre-push`
- Read `.ci/critical-coverage-baseline.json`
- Read `scripts/test-merge-gate.mjs`
- Read `scripts/classify-deploy-changes.mjs`
- Read `scripts/check-critical-coverage.mjs`
- Read `scripts/check-doc-sync.ts`
- Read `scripts/check-doc-counts.mjs`
- Read `scripts/check-worker-migrations.mjs`
- Read `worker/migrations/MANIFEST.md`
- Read `docs/testing.md`
- Read `docs/deployment-process.md`
- Read `docs/README.md`
- Read `docs/architecture.md`
- Read `docs/api-reference.md`
- Read `docs/worker-and-api-limits.md`
- Read `functions/**`

## Verification Log

Commands run during the audit:

- `npm test -- scripts/__tests__/test-merge-gate.test.ts scripts/__tests__/classify-deploy-changes.test.ts scripts/__tests__/check-worker-migrations.test.ts functions/__tests__/ops-env.test.ts functions/__tests__/ops-admin-proxy.test.ts functions/__tests__/admin-host-gate.test.ts`
  - Result: passed (`6` files, `30` tests)
- `npm run check:doc-counts`
  - Result: passed
- `npm run check:doc-sync`
  - Result: passed

Commands run during remediation:

- `npx vitest run scripts/__tests__/check-worker-migrations.test.ts scripts/__tests__/classify-deploy-changes.test.ts scripts/__tests__/test-merge-gate.test.ts scripts/__tests__/validate-ci-parity.test.ts`
  - Result: passed (`4` files, `32` tests)
- `npx eslint scripts/check-worker-migrations.mjs scripts/__tests__/check-worker-migrations.test.ts scripts/test-merge-gate.mjs scripts/classify-deploy-changes.mjs scripts/lib/deploy-impact.mjs scripts/__tests__/classify-deploy-changes.test.ts scripts/__tests__/test-merge-gate.test.ts scripts/__tests__/validate-ci-parity.test.ts`
  - Result: passed
- `npm run check:migrations`
  - Result: passed
- `npm run check:doc-counts`
  - Result: passed
- `npm run check:doc-sync`
  - Result: passed
- `npx prettier --check .github/workflows/pages-release.yml .github/workflows/validate-ci.yml scripts/check-worker-migrations.mjs scripts/__tests__/check-worker-migrations.test.ts docs/deployment-process.md docs/testing.md docs/scripts.md README.md AGENTS.md worker/migrations/MANIFEST.md agents/plans/2026-03-22-development-methodology-remediation-plan.md`
  - Result: passed
