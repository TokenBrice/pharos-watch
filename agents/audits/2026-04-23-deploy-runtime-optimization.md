# Deploy Runtime Optimization Audit — 2026-04-23

## Latest Run Baseline

Source: GitHub Actions `deploy-cloudflare.yml` runs inspected with `gh run view` on 2026-04-23.

| Run           | Head       | Status  | Wall time | Notes                                                                               |
| ------------- | ---------- | ------- | --------- | ----------------------------------------------------------------------------------- |
| `24858626499` | `108e99e9` | success | 10m 33s   | First pushed run after pure-Node `smoke-api` and install-free production API smoke. |
| `24858103567` | `60ab5349` | success | 10m 49s   | Confirmed prior smoke-parallelization commit; same full Worker + Pages path.        |
| `24857294577` | `54999426` | success | 11m 11s   | Latest completed full Worker + Pages deployment at analysis time.                   |
| `24856431641` | `3712c88c` | success | 11m 47s   | Screenshot baseline; same full Worker + Pages shape.                                |

## Critical Path Observations

- Validation is the largest fixed cost: `validate / validate` ~4m56s and `validate / validate-lts` ~4m48s in run `24857294577`.
- Repeated dependency setup is the largest removable deployment overhead: Worker upload/deploy/API-smoke/Pages-deploy setup steps are each ~22-30s when they run `npm ci`.
- Pages build is intentionally duplicated between validate and predeploy prepare because the deploy artifact needs live digest sync; reusing the validate artifact would change artifact freshness semantics.
- Local `test:merge-gate` mirrored the CI command order serially even after the expensive `validate:prebuild` umbrella had already parallelized its internal checks.

## Top 10 Optimization Options

| Rank | Optimization                                                                                          | Effort | Risk   | Expected impact                                                                                                 | Decision                                                               |
| ---- | ----------------------------------------------------------------------------------------------------- | ------ | ------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1    | Make `smoke-api` pure Node and skip `npm ci` in the production `smoke-api` job.                       | S      | Low    | ~25s off Worker-changing deploys.                                                                               | Implemented.                                                           |
| 2    | Run independent local merge-gate post-validate groups in parallel after `validate:prebuild`.          | M      | Medium | Saves the sum of build/coverage/typecheck work behind the longest local test group, often ~45-90s locally.      | Implemented with `MERGE_GATE_SERIAL=1` escape hatch.                   |
| 3    | Remove the setup-node wrapper from `detect-changes`; the classifier uses only built-in Node features. | S      | Low    | ~5-6s off every deploy run.                                                                                     | Implemented.                                                           |
| 4    | Keep Pages post-publish UI/ops/transport smokes parallel after `deploy-pages`.                        | S      | Low    | Removes ~30s serial tail on Pages deploys.                                                                      | Already implemented in prior commit.                                   |
| 5    | Keep pure-node transport smoke jobs install-free.                                                     | S      | Low    | ~20-25s job runtime where transport smoke runs.                                                                 | Already implemented for current workflow surfaces.                     |
| 6    | Replace Pages deploy job `npm ci` with a Wrangler-only install or action.                             | M      | Medium | ~15-25s off Pages publish.                                                                                      | Deferred; needs Wrangler pinning/retry parity check.                   |
| 7    | Reuse the validate build artifact for Pages deploy.                                                   | M      | High   | ~50s off Pages prepare.                                                                                         | Rejected for now; deploy artifact must include target-API digest sync. |
| 8    | Parallelize CI validate postbuild test/coverage/worker-typecheck stages.                              | M      | Medium | Latest run shows ~50-70s available per validate lane by overlapping build/SEO, tests, coverage, and typechecks. | Implemented with `VALIDATE_POSTBUILD_SERIAL=1` escape hatch.           |
| 9    | Fold post-promotion API smoke into `deploy-worker` to reuse installed dependencies.                   | M      | High   | ~25s off Worker deploys.                                                                                        | Deferred; rollback signaling becomes more complex.                     |
| 10   | Narrow local smoke-ui route set further.                                                              | M      | Medium | ~10-20s off Pages smoke.                                                                                        | Deferred; route coverage is the safety value of the local smoke.       |

## Implemented Scope

- `scripts/smoke-api.mjs` now runs with plain Node by mirroring the strict contract path list locally; `src/lib/__tests__/api-endpoints.test.ts` continues to guard drift against `shared/lib/api-endpoints`.
- The production `smoke-api` job now skips dependency installation.
- `detect-changes` no longer invokes the shared setup action.
- `scripts/test-merge-gate.mjs` now runs independent post-`validate:prebuild` command groups in parallel by default and supports `MERGE_GATE_SERIAL=1` for serial debugging.

## Second-Pass Optimizations

- `scripts/run-validate-postbuild.mjs` brings the merge-gate batching shape into CI: after `npm run validate:prebuild`, the Pages build/SEO group, full tests, critical coverage, and Worker typechecks run concurrently, with sibling cancellation on the first failure and `VALIDATE_POSTBUILD_SERIAL=1` as a debug escape hatch.
- `npm run validate:lts` now uses the same post-prebuild batching on Node 24.x while keeping the LTS proof lane intact.
- `.github/workflows/pages-prepare.yml` now runs the local artifact `smoke-ui` inside `build-pages` after upload-artifact, eliminating a second runner setup and artifact download while preserving the pre-publish smoke gate.
- `.github/workflows/pull-request-checks.yml` now runs the dependency-free classifier directly after checkout, matching the deploy workflow's setup-free `detect-changes` job.
- `scripts/smoke-ops.mjs` starts direct ops API probes alongside the ops UI shell fetch, and `scripts/smoke-transport.mjs` checks both redirect hosts concurrently.
