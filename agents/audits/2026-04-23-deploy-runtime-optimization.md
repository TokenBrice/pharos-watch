# Deploy Runtime Optimization Audit — 2026-04-23

## Latest Run Baseline

Source: GitHub Actions `deploy-cloudflare.yml` runs inspected with `gh run view` on 2026-04-23.

| Run           | Head       | Status                    | Wall time | Notes                                                                                          |
| ------------- | ---------- | ------------------------- | --------- | ---------------------------------------------------------------------------------------------- |
| `24858103567` | `60ab5349` | in progress at inspection | pending   | Validation was active; useful to confirm the prior smoke-parallelization commit once complete. |
| `24857294577` | `54999426` | success                   | 11m 11s   | Latest completed full Worker + Pages deployment at analysis time.                              |
| `24856431641` | `3712c88c` | success                   | 11m 47s   | Screenshot baseline; same full Worker + Pages shape.                                           |

## Critical Path Observations

- Validation is the largest fixed cost: `validate / validate` ~4m56s and `validate / validate-lts` ~4m48s in run `24857294577`.
- Repeated dependency setup is the largest removable deployment overhead: Worker upload/deploy/API-smoke/Pages-deploy setup steps are each ~22-30s when they run `npm ci`.
- Pages build is intentionally duplicated between validate and predeploy prepare because the deploy artifact needs live digest sync; reusing the validate artifact would change artifact freshness semantics.
- Local `test:merge-gate` mirrored the CI command order serially even after the expensive `validate:prebuild` umbrella had already parallelized its internal checks.

## Top 10 Optimization Options

| Rank | Optimization                                                                                          | Effort | Risk   | Expected impact                                                                                            | Decision                                                               |
| ---- | ----------------------------------------------------------------------------------------------------- | ------ | ------ | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1    | Make `smoke-api` pure Node and skip `npm ci` in the production `smoke-api` job.                       | S      | Low    | ~25s off Worker-changing deploys.                                                                          | Implemented.                                                           |
| 2    | Run independent local merge-gate post-validate groups in parallel after `validate:prebuild`.          | M      | Medium | Saves the sum of build/coverage/typecheck work behind the longest local test group, often ~45-90s locally. | Implemented with `MERGE_GATE_SERIAL=1` escape hatch.                   |
| 3    | Remove the setup-node wrapper from `detect-changes`; the classifier uses only built-in Node features. | S      | Low    | ~5-6s off every deploy run.                                                                                | Implemented.                                                           |
| 4    | Keep Pages post-publish UI/ops/transport smokes parallel after `deploy-pages`.                        | S      | Low    | Removes ~30s serial tail on Pages deploys.                                                                 | Already implemented in prior commit.                                   |
| 5    | Keep pure-node transport smoke jobs install-free.                                                     | S      | Low    | ~20-25s job runtime where transport smoke runs.                                                            | Already implemented for current workflow surfaces.                     |
| 6    | Replace Pages deploy job `npm ci` with a Wrangler-only install or action.                             | M      | Medium | ~15-25s off Pages publish.                                                                                 | Deferred; needs Wrangler pinning/retry parity check.                   |
| 7    | Reuse the validate build artifact for Pages deploy.                                                   | M      | High   | ~50s off Pages prepare.                                                                                    | Rejected for now; deploy artifact must include target-API digest sync. |
| 8    | Parallelize CI validate postbuild test/coverage/worker-typecheck stages.                              | M      | Medium | Up to ~20-30s CI wall time, more on slower runs.                                                           | Deferred; doubles CPU pressure on shared runners.                      |
| 9    | Fold post-promotion API smoke into `deploy-worker` to reuse installed dependencies.                   | M      | High   | ~25s off Worker deploys.                                                                                   | Deferred; rollback signaling becomes more complex.                     |
| 10   | Narrow local smoke-ui route set further.                                                              | M      | Medium | ~10-20s off Pages smoke.                                                                                   | Deferred; route coverage is the safety value of the local smoke.       |

## Implemented Scope

- `scripts/smoke-api.mjs` now runs with plain Node by mirroring the strict contract path list locally; `src/lib/__tests__/api-endpoints.test.ts` continues to guard drift against `shared/lib/api-endpoints`.
- The production `smoke-api` job now skips dependency installation.
- `detect-changes` no longer invokes the shared setup action.
- `scripts/test-merge-gate.mjs` now runs independent post-`validate:prebuild` command groups in parallel by default and supports `MERGE_GATE_SERIAL=1` for serial debugging.
