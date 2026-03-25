# 2026-03-22 Development Methodology Remediation Plan

> Execution plan for the findings in [../2026-03-22-development-methodology-audit.md](../2026-03-22-development-methodology-audit.md).
> Scope covers the confirmed delivery-methodology findings plus one optional follow-up for the remaining open question.

## Implementation Status

Current repository status on 2026-03-22:

- W1 implemented: shared Pages-impact matcher now drives both deploy classification and local merge-gate build/SEO triggering.
- W2 implemented: shared `validate` CI now runs `npm run build` and `npm run seo:check` before tests/coverage.
- W3 implemented: local merge gate now passes changed-file context into `coverage:critical`, and workflow-parity tests guard drift.
- W4 implemented: pre-push docs now match actual every-push enforcement and `docs/deployment-process.md` is the canonical delivery reference.
- W5 implemented: migration safety is now an explicit documented contract and is enforced inside `npm run check:migrations` for new migrations from `0071` onward.
- W6 implemented: the shared Pages release workflow now runs a live public-host smoke after Pages publish, so both production deploys and scheduled rebuilds verify `https://pharos.watch`.

## Objective

Address the methodology audit in a way that:

- catches Pages build failures before merge instead of after merge
- removes drift between local validation, CI validation, and deployment classification
- makes migration-safety assumptions explicit instead of implicit
- reduces workflow/documentation contradiction
- adds lightweight automation where current process still depends on memory

## Findings Covered

This plan covers the seven confirmed findings from the audit:

1. Missing pre-merge Pages build validation and under-scoped local build gating
2. Schema migrations applied before new worker/runtime verification without an explicit compatibility contract
3. Local merge gate does not match CI for critical coverage ratchet behavior
4. Pre-push policy documentation contradicts actual enforcement
5. Coverage docs overstate what CI enforces
6. Delivery workflow knowledge is duplicated without mechanical protection
7. Pages workflow changes can ship without exercising the changed workflow

Optional follow-up:

- Q1 from the audit: whether to add live public-site smoke after Pages deploy

## Recommended Policy Decisions

These decisions should be treated as the default assumptions for implementation unless the team explicitly overrides them.

1. Canonical delivery doc: `docs/deployment-process.md`
2. Pre-push policy: run the merge gate on every push, not only `main`
3. Pre-merge Pages confidence model:
   - local gate stays diff-aware
   - shared CI validate always runs `npm run build` and `npm run seo:check`
4. Pages-impact source of truth: one shared matcher consumed by both deploy classification and local build gating
5. Migration safety rule:
   - production migrations must be backward-compatible with both the currently live worker and the new worker
   - destructive cleanup must be handled as an explicit later phase, not folded silently into a normal rollout
6. Workflow files that control Pages release are themselves Pages-impacting and must trigger the Pages validation/release path

## Constraints

- Keep production behavior stable while fixing delivery/process guardrails.
- Do not weaken the existing `validate` core while adding new checks.
- Avoid mixing workflow/CI changes with unrelated app refactors.
- Update the matching docs for every process/policy change.
- Prefer small PRs with tight scopes and clear validation.

## Mandatory Validation Gates

Run after each merged phase unless the phase is documentation-only:

```bash
npm run lint
npm test
npm run build
cd worker && npx tsc --noEmit
```

Additional targeted gates:

```bash
npm run check:doc-counts
npm run check:doc-sync
npx vitest run scripts/__tests__/test-merge-gate.test.ts scripts/__tests__/classify-deploy-changes.test.ts scripts/__tests__/check-worker-migrations.test.ts
```

Run before final closure of the full workstream:

```bash
npm run test:merge-gate
```

## Recommended PR Sequence

```text
PR 1  Shared Pages-impact matcher + local gate scope fix + workflow rehearsal scope
PR 2  Shared CI validate builds Pages artifacts pre-merge
PR 3  Coverage ratchet parity + validate-core parity tests + coverage doc correction
PR 4  Pre-push policy alignment + delivery-doc consolidation
PR 5  Migration-safety contract + migration guardrail
PR 6  Optional live public Pages smoke after deploy
```

This ordering fixes the highest-confidence/highest-impact guardrails first and postpones the only still-optional item until the end.

## Workstream Overview

| ID  | Priority | Outcome                                                                      | Main surfaces                                                               |
| --- | -------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| W1  | P0       | One shared Pages-impact definition used locally and in deploy classification | `scripts/classify-deploy-changes.mjs`, `scripts/test-merge-gate.mjs`, tests |
| W2  | P0       | PR CI catches frontend export/type/build failures before merge               | `.github/workflows/validate-ci.yml`                                         |
| W3  | P0       | Local coverage ratchet matches CI and docs describe real behavior            | `scripts/test-merge-gate.mjs`, coverage docs/tests                          |
| W4  | P1       | Pre-push behavior and delivery docs are internally consistent                | `docs/deployment-process.md`, `docs/testing.md`, `README.md`, `AGENTS.md`   |
| W5  | P0/P1    | Migration compatibility is an explicit enforced rollout rule                 | migration docs + guardrail script                                           |
| W6  | P2       | Live public Pages smoke after publish                                        | deploy workflows                                                            |

## W1 - Shared Pages-Impact Matcher

### Goal

Remove drift between local build gating and the deploy classifier, and ensure Pages workflow files themselves are treated as Pages-impacting.

### Files

- `scripts/classify-deploy-changes.mjs`
- `scripts/test-merge-gate.mjs`
- `scripts/__tests__/classify-deploy-changes.test.ts`
- `scripts/__tests__/test-merge-gate.test.ts`
- recommended new helper: `scripts/lib/deploy-impact.mjs`

### Implementation

1. Extract the file-classification logic into a shared helper.
2. Make local build/SEO triggering call the same Pages-impact matcher instead of its current narrower heuristic.
3. Expand the Pages-impact allowlist to explicitly include:
   - `.github/workflows/pages-release.yml`
   - `.github/workflows/rebuild-pages.yml`
4. Preserve the current worker-impact logic, but keep it in the same shared helper so drift becomes harder.
5. Add regression tests for:
   - `src/lib/*`
   - `src/hooks/*`
   - `shared/*`
   - `functions/*`
   - workflow-only changes to `pages-release.yml` / `rebuild-pages.yml`

### Acceptance Criteria

- A change to `functions/api/admin/[[path]].ts` triggers local `build` + `seo:check`.
- A change to `shared/lib/*` triggers local `build` + `seo:check`.
- A change only to `.github/workflows/pages-release.yml` is classified as `pages_changed=true`.
- Local and CI Pages-impact logic are defined in one place.

### Validation

```bash
npx vitest run scripts/__tests__/classify-deploy-changes.test.ts scripts/__tests__/test-merge-gate.test.ts
MERGE_GATE_DRY_RUN=1 npm run test:merge-gate
```

## W2 - Pre-Merge Pages Build Validation In Shared CI

### Goal

Guarantee that `main` cannot receive a Pages-breaking change without at least one CI run proving that the site still builds and passes the static SEO check.

### Files

- `.github/workflows/validate-ci.yml`
- optionally `docs/testing.md` and `docs/deployment-process.md` in the later docs PR, not required in this PR

### Implementation

1. Add `npm run build` to the shared `validate` job.
2. Add `npm run seo:check` immediately after `npm run build`.
3. Keep these checks inside the shared reusable validate workflow so both PR checks and push/manual deploy validation benefit.
4. Do not rely on the Pages release workflow as the first build gate anymore.

### Recommended Ordering Inside `validate`

Recommended order after the existing static checks and before long-tail coverage work:

1. `npm run audit:deps`
2. existing lint/check scripts
3. `npm run build`
4. `npm run seo:check`
5. `npm test`
6. `npm run coverage:critical`
7. `cd worker && npx tsc --noEmit`

This keeps cheap structural checks first, then the production-facing build gate, then the heavier test/coverage work.

### Acceptance Criteria

- Pull requests to `main` fail before merge if `npm run build` fails.
- Pull requests to `main` fail before merge if `npm run seo:check` fails.
- Worker-only changes still pass the same validate workflow, but no longer rely on post-merge Pages release as the first build proof.

### Validation

```bash
npm run build
npm run seo:check
```

## W3 - Coverage Ratchet Parity And Validate-Core Parity

### Goal

Make the local merge gate catch the same critical-coverage regressions CI catches, and stop overstating coverage guarantees in the docs.

### Files

- `scripts/test-merge-gate.mjs`
- `scripts/check-critical-coverage.mjs` if needed
- `scripts/__tests__/test-merge-gate.test.ts`
- recommended new test: `scripts/__tests__/validate-ci-parity.test.ts`
- `docs/testing.md`

### Implementation

1. Pass one of the following into the local `coverage:critical` run:
   - `CRITICAL_COVERAGE_COMPARE_REF=<merge-base>`
   - or `CRITICAL_COVERAGE_CHANGED_FILES=<resolved changed file list>`
2. Keep the local ratchet source aligned with the same merge-base diff the merge gate already computes.
3. Add a parity test that reads `.github/workflows/validate-ci.yml` and asserts the local non-negotiable command list still matches the reusable CI validate core.
4. Rewrite the coverage section in `docs/testing.md` so it states the real contract:
   - global `66%` applies when running full coverage locally
   - CI enforces the critical coverage gate, not a global full-suite `66%` gate

### Acceptance Criteria

- A touched critical file that regresses relative to the baseline fails locally, not only in CI.
- A future change to `validate-ci.yml` or `NON_NEGOTIABLE_VALIDATE_COMMANDS` that creates drift fails a test.
- `docs/testing.md` no longer claims CI enforces a global `66%` threshold.

### Validation

```bash
npx vitest run scripts/__tests__/test-merge-gate.test.ts scripts/__tests__/validate-ci-parity.test.ts
npm run check:doc-sync
```

## W4 - Pre-Push Policy Alignment And Delivery-Doc Consolidation

### Goal

Make the documented process match the actual enforced process, and reduce the number of places that restate the full delivery workflow.

### Files

- `docs/deployment-process.md`
- `docs/testing.md`
- `README.md`
- `AGENTS.md`
- optionally `docs/README.md`

### Implementation

1. Adopt the "every push" policy explicitly in docs.
2. Update docs to explain that `npm install` configures `.githooks` through `prepare`.
3. Make `docs/deployment-process.md` the canonical delivery-workflow document.
4. Reduce duplicated workflow prose elsewhere:
   - `docs/testing.md` should focus on test types, commands, and validation policy
   - `README.md` should keep only a short summary and a pointer
   - `AGENTS.md` should keep the repo rule, but not restate conflicting hook behavior
5. Preserve specific testing details in `docs/testing.md`, but replace repeated workflow narration with links to the canonical deploy/process doc where possible.

### Acceptance Criteria

- The repo gives one answer to "does the merge gate run on every push or only on main?"
- `docs/deployment-process.md` is clearly the canonical delivery-workflow reference.
- `README.md`, `AGENTS.md`, and `docs/testing.md` no longer restate conflicting hook/workflow behavior.

### Validation

```bash
npm run check:doc-counts
npm run check:doc-sync
```

## W5 - Migration-Safety Contract And Guardrail

### Goal

Turn migration compatibility from an implicit assumption into an explicit rollout rule with at least lightweight enforcement.

### Files

- `docs/deployment-process.md`
- `docs/worker-infrastructure.md`
- `worker/migrations/MANIFEST.md`
- recommended new script: `scripts/check-migration-safety.mjs`
- `package.json`
- `.github/workflows/validate-ci.yml`
- `scripts/test-merge-gate.mjs`
- recommended tests under `scripts/__tests__/`

### Implementation

#### Phase A: policy and documentation

1. Add an explicit rollout rule to the docs and migration manifest:
   - normal production migrations must be backward-compatible
   - destructive cleanup is a separate later step
2. Add author guidance with examples:
   - additive table/column/index changes are normal
   - dropping/renaming schema elements is cleanup-phase work

#### Phase B: lightweight automation

1. Add a migration-safety checker that validates new migration files for a required rollout-safety header, for example:
   - `-- rollout-safety: backward-compatible`
   - `-- rollout-safety: cleanup`
2. Make the checker reject obviously destructive statements in normal migrations, at minimum:
   - `DROP TABLE`
   - table/column rename patterns
   - other patterns the team agrees should never ship in a standard rollout
3. Wire the new checker into:
   - `package.json`
   - `.github/workflows/validate-ci.yml`
   - `scripts/test-merge-gate.mjs`

### Notes

This will not mathematically prove compatibility. That is not realistic from static SQL parsing alone. The goal is:

- make the compatibility rule explicit in review
- block obviously unsafe migrations from slipping through the normal path

### Acceptance Criteria

- The delivery docs state the migration compatibility rule explicitly.
- New migration files must declare rollout safety.
- Obviously destructive migration patterns fail CI/local validation unless the team later designs a dedicated cleanup workflow.

### Validation

```bash
npx vitest run scripts/__tests__/check-worker-migrations.test.ts
npm run check:migrations
```

## W6 - Optional Live Public Pages Smoke After Deploy

### Goal

Close the remaining visibility gap between local artifact smoke and the actual public Pages host after publish.

### Files

- `.github/workflows/deploy-cloudflare.yml`
- `.github/workflows/rebuild-pages.yml`
- potentially `docs/testing.md`
- potentially `docs/deployment-process.md`

### Implementation

1. Add a post-Pages-deploy live smoke step against `https://pharos.watch`.
2. Reuse the existing `npm run test:smoke-ui -- --url https://pharos.watch`.
3. Keep the current pre-deploy local artifact smoke; this new check supplements it rather than replacing it.
4. Keep current worker-only live smoke behavior, or consolidate both paths into one shared live-public-smoke job.

### Acceptance Criteria

- Pages-including deploys verify the real public host after publish.
- Worker-only deploys keep their current live smoke coverage.
- Failures are attributable and do not remove the pre-deploy artifact smoke gate.

### Validation

```bash
npm run test:smoke-ui -- --url https://pharos.watch
```

## Recommended Execution Order By Priority

### Immediate

- W1
- W2
- W3
- W5 Phase A

### Next

- W4
- W5 Phase B

### Optional / decision-dependent

- W6

## Definition Of Done

This plan is complete when:

- PR CI proves the Pages build before merge
- local and CI validation use the same Pages-impact scope
- local coverage ratchet behavior matches CI
- pre-push docs match actual enforcement
- the delivery workflow has one canonical doc
- migration compatibility is explicitly documented and at least lightly enforced
- workflow-only Pages-release changes can no longer skip rehearsal
- if the team accepts W6, Pages deploys also get live public-host smoke after publish
