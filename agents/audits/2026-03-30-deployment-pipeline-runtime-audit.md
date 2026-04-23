# Deployment Pipeline Runtime Audit

Date: 2026-03-30

## Scope

Audit target:

- push/manual production deploy flow in [`.github/workflows/deploy-cloudflare.yml`](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/deploy-cloudflare.yml)
- shared validation in [`.github/workflows/validate-ci.yml`](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/validate-ci.yml)
- shared Pages release path in [`.github/workflows/pages-release.yml`](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/pages-release.yml)
- scheduled Pages rebuild in [`.github/workflows/rebuild-pages.yml`](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/rebuild-pages.yml)
- deploy-impact classification and smoke/build scripts under [`scripts/`](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts)

This is a decision report, not an implementation patch.

## Evidence Base

Docs reviewed:

- [docs/architecture.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/architecture.md)
- [docs/api-reference.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/api-reference.md)
- [docs/testing.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/testing.md)
- [docs/worker-and-api-limits.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/worker-and-api-limits.md)
- [docs/deployment-process.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/deployment-process.md)
- [docs/digest-pipeline.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/digest-pipeline.md)

Workflow and script sources reviewed:

- [`.github/workflows/deploy-cloudflare.yml`](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/deploy-cloudflare.yml)
- [`.github/workflows/validate-ci.yml`](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/validate-ci.yml)
- [`.github/workflows/pages-release.yml`](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/pages-release.yml)
- [`.github/workflows/rebuild-pages.yml`](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/rebuild-pages.yml)
- [`scripts/lib/deploy-impact.mjs`](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/lib/deploy-impact.mjs)
- [`scripts/lib/validate-contract.mjs`](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/lib/validate-contract.mjs)
- [`scripts/classify-deploy-changes.mjs`](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/classify-deploy-changes.mjs)
- [`scripts/smoke-api.mjs`](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/smoke-api.mjs)
- [`scripts/smoke-ui.mjs`](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/smoke-ui.mjs)
- [`scripts/smoke-ops.mjs`](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/smoke-ops.mjs)
- [`scripts/sync-digests.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/sync-digests.ts)
- [`scripts/serve-static-export.mjs`](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/serve-static-export.mjs)

GitHub Actions data collected on 2026-03-30 via `gh`:

- latest 4 successful `Deploy to Cloudflare` push runs
- latest 3 successful `Rebuild Pages` runs
- current `main` branch protection configuration

## Executive Summary

The current pipeline is broadly justified. The 11-minute runtime is not coming from cheap guardrails or obvious deadweight; it is mostly coming from three real costs:

1. the main `validate` gate
2. the fully serialized worker release path
3. the fully serialized Pages build, local smoke, deploy, and live canary path

Important current-state conclusion: several earlier inefficiencies have already been fixed.

- Deploy classification is already diff-aware.
- Pages build/SEO is already skipped on worker-only deploys.
- Worker typecheck is already skipped on pages-only deploys.
- Live UI smoke is already narrowed to a single canary route in `live` mode.
- `smoke-ui` is no longer spawning repeated Playwright CLI sessions per route; it now does one `open`, one `run-code`, and one `close`.

So the remaining optimization work is structural, not cleanup of obviously wasteful checks.

The strongest optimization opportunities now are:

1. overlap Pages predeploy work with the worker post-preview path using the uploaded worker preview URL
2. reduce repeated installs and job setup in the worker release chain
3. add CI caches for build/lint/typecheck artifacts
4. treat `validate-node24` as a cost optimization problem, not a wall-clock problem

The biggest thing not to do first: cutting cheap checks like doc-sync, hotspot-ratchet, duplicate-export checks, or ops smoke. They do not materially explain the runtime.

## Current Runtime Profile

### Full deploy path

Latest 4 successful push deploys reviewed:

| Run           | SHA       |  Total |
| ------------- | --------- | -----: |
| `23757258622` | `718ca75` | `658s` |
| `23754700032` | `5efe923` | `707s` |
| `23750959818` | `62e054c` | `712s` |
| `23731188129` | `2ed2f70` | `660s` |

Average full push deploy runtime: `684.25s` (`11m24s`)

### Average job durations across those runs

| Job                             |      Avg |
| ------------------------------- | -------: |
| `validate / validate`           | `232.0s` |
| `pages-release / build-pages`   |  `74.5s` |
| `pages-release / smoke-ui`      |  `60.0s` |
| `pages-release / deploy-pages`  |  `57.5s` |
| `smoke-api`                     |  `41.8s` |
| `upload-worker-version`         |  `41.3s` |
| `smoke-api-preview`             |  `35.5s` |
| `pages-release / smoke-ui-live` |  `33.8s` |
| `deploy-worker`                 |  `33.0s` |
| `smoke-ops`                     |  `25.8s` |
| `validate / validate-node24`    |  `91.3s` |
| `detect-changes`                |   `7.3s` |

Observations:

- `validate` is still the single largest job.
- the worker chain after `validate` is about `152s` wall-clock on average:
  - `upload-worker-version`
  - `smoke-api-preview`
  - `deploy-worker`
  - `smoke-api`
- the Pages chain after `validate` is about `226s` wall-clock on average:
  - `build-pages`
  - `smoke-ui`
  - `deploy-pages`
  - `smoke-ui-live`

### What actually dominates `validate`

Average step durations inside `validate / validate`:

| Step                              |          Avg |
| --------------------------------- | -----------: |
| `npm test`                        |      `71.0s` |
| `npm run lint`                    |      `46.3s` |
| `npm run build`                   |      `38.0s` |
| `npm run typecheck`               |      `15.0s` |
| `npm ci`                          |      `14.8s` |
| `cd worker && npx tsc --noEmit`   |      `11.3s` |
| `npm run coverage:critical`       |       `9.0s` |
| `npm run check:shared-cycles`     |       `7.5s` |
| all remaining checks individually | `0s` to `3s` |

Conclusion:

- the expensive validate steps are `npm test`, `lint`, and `build`
- the policy/guardrail checks are mostly noise-level in runtime terms

### Scheduled Pages rebuild path

Latest 3 successful `Rebuild Pages` runs:

| Run           |  Total | Notes                                   |
| ------------- | -----: | --------------------------------------- |
| `23738426406` | `250s` | typical                                 |
| `23705535969` | `260s` | typical                                 |
| `23639005828` | `330s` | slower deploy-pages + smoke-ops outlier |

Typical scheduled rebuild runtime is currently about `4m10s` to `4m20s`.

## Current Pipeline Assessment By Stage

### `detect-changes`

Assessment: keep as-is.

Why:

- very cheap
- already correctly prevents non-deploy pushes from running the heavy path
- already scopes Pages build and worker typecheck in the shared validate workflow

Runtime concern: negligible.

### `validate / validate`

Assessment: keep, but optimize around it rather than gut it.

Why it is still justified:

- `main` branch protection currently has required PR review count `1`
- `main` does **not** currently have required status checks enabled
- therefore deploy-time validation is not redundant with GitHub branch protection

This materially changes the recommendation. Without required status checks, aggressively downgrading push-time validate would remove the last mandatory automated gate before production.

What is runtime-critical inside it:

- full `npm test`
- `lint`
- `build`

What is not worth cutting for runtime:

- `check:doc-counts`
- `check:doc-sync`
- `check:duplicate-exports`
- `check:hotspot-ratchet`
- `check:sql-safety`
- `check:stablecoin-data`

Those checks are cheap enough that removing them would buy very little.

### `validate / validate-node24`

Assessment: useful, but not part of the current wall-clock bottleneck.

Current role:

- rehearses the declared Node engine range `>=22 <25`
- currently runs `lint`, `typecheck`, `build`, and `test:critical-contracts`

Runtime reality:

- average `91.3s`
- it finishes well before the main `validate` job in current runs
- so it consumes runner minutes but does not currently lengthen the critical path

Optimization posture:

- safe target for cost optimization
- weak target for wall-clock optimization

### Worker release chain

Jobs:

- `upload-worker-version`
- `smoke-api-preview`
- `deploy-worker`
- `smoke-api`
- `rollback-worker`

Assessment: coverage is justified; orchestration is not optimal.

Why the stages are useful:

- preview smoke is high-value because it validates the exact uploaded candidate before promotion
- post-promotion production smoke is also high-value because preview URLs do not cover final custom-domain/runtime behavior
- automatic rollback is appropriate for a worker serving production API traffic

Where the runtime waste is:

- every stage repeats checkout/setup/install overhead
- `npm ci` is paid in multiple sequential jobs
- the jobs are cleanly separated for graph clarity, but that clarity costs time

### Pages release chain

Jobs:

- `build-pages`
- `smoke-ui`
- `deploy-pages`
- `smoke-ui-live`

Assessment: every stage is useful, but the chain is still too serialized.

Why the stages are useful:

- `build-pages` produces the actual deploy artifact and performs the build-time digest sync
- `smoke-ui` verifies the exact built artifact before publish
- `deploy-pages` publishes only the verified artifact
- `smoke-ui-live` validates the real host after publish

Where the runtime waste is:

- on combined Pages + worker deploys, the entire Pages path waits for `smoke-api`
- this leaves a large amount of overlap on the table
- the Pages path is also effectively paying for a second build beyond the push-path build in `validate`

### `smoke-ops`

Assessment: keep.

Why:

- protects an important production operator surface
- cheap relative to the overall runtime
- verifies Cloudflare Access, ops UI, and ops API

Optimization note:

- likely parallelizable with public live smoke after deployment success

## What Has Already Been Optimized

This matters because it narrows the real remaining work.

Previously obvious problems that are already fixed in the current pipeline:

1. Deploy classification is already used to skip the whole workflow for non-deploy pushes.
2. `validate` is already diff-aware for Pages build/SEO and worker typecheck.
3. `smoke-ui live` is already narrow.
4. `smoke-ui` no longer shells out for every route interaction.
5. digest preparation is already folded into `build-pages`, rather than living as a separate install-heavy job.

So the current audit is not recommending those already-landed fixes again.

## High-Confidence Findings

### 1. The main remaining wall-clock problem is serialization, not bad checks

This is the current high-level shape:

- `validate` blocks everything meaningful
- worker release then runs as a serial chain
- Pages release then runs as another serial chain
- `smoke-ops` runs after all of that

That structure is why full deploys are still around `11m`.

### 2. The combined deploy path is leaving safe overlap on the table

Current combined push behavior waits for post-promotion `smoke-api` before starting `pages-release`.

That is conservative, but it is stricter than the actual data dependency appears to require.

Relevant repo facts:

- `build-pages` only performs one build-time API fetch via [`scripts/sync-digests.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/sync-digests.ts)
- that fetch targets `GET /api/digest-archive`
- the local static export smoke server already supports an arbitrary API proxy base via [`scripts/serve-static-export.mjs`](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/serve-static-export.mjs)
- `upload-worker-version` already exposes the candidate preview URL

This makes a stronger structure possible:

- after `smoke-api-preview` succeeds, start `build-pages` and local `smoke-ui` against the preview API base
- keep `deploy-pages` gated on production `smoke-api` success
- keep `smoke-ui-live` as the final real-host canary after publish

That would preserve the same deployment safety model while overlapping substantial work.

### 3. Worker release job boundaries are costing time more than they are buying safety

The current worker chain spends a meaningful fraction of its runtime on:

- checkout
- setup-node
- `npm ci`

The functional steps themselves are comparatively short.

This is a good candidate for consolidation or for narrower installs.

### 4. `validate-node24` is a runner-cost issue, not a deploy-runtime issue

If the question is pure wall-clock runtime, `validate-node24` is not the first thing to change.

If the question is CI spend and unnecessary duplication, it is a reasonable target.

### 5. The branch-protection configuration argues against slimming push validate right now

Verified current state:

- PR review requirement exists
- required status checks are not enabled

Implication:

- `pull-request-checks` is informational, not a required branch gate
- the push deploy workflow is still the mandatory automated quality gate before shipping

Therefore:

- removing `npm test` from push deploys is not a good first move
- moving meaningful validation to PR-only is only reasonable after branch protection is tightened

### 6. If runtime budget is reallocated, the better trade is from orchestration, not from smoke or policy deletion

Good places to reclaim time:

- overlap
- install reduction
- build/cache reuse
- non-critical compatibility lane scope

Bad places to reclaim time:

- removing preview smoke
- removing post-prod smoke
- removing ops smoke
- deleting cheap repo-policy checks

## Coverage/Relevance Gaps Worth Noting

These are not major runtime offenders, but they matter to “is this pipeline checking the right things?”

### `smoke-api` does not cover `digest-archive`

That matters because:

- `build-pages` depends on `GET /api/digest-archive`
- worker-only deploys do not exercise the Pages build path
- current smoke coverage therefore leaves a low-cost gap around a build-critical endpoint

Recommendation:

- add a cheap `digest-archive` canary to `smoke-api` if you later trim any heavier Pages validation

### Live UI smoke does not explicitly touch digest routes

Current live smoke:

- homepage smoke
- one live canary overflow route, default `/yield/`

This is fine for runtime, but it does not specifically validate the build-time digest surface.

Recommendation:

- if you keep one live canary route only, consider whether `/digest/` or one static digest page would be a better canary than `/yield/`
- this is a coverage-quality adjustment, not a runtime optimization

## Prioritized Recommendations

### P1. Overlap Pages predeploy work with the worker post-preview path

Priority: highest

Expected wall-clock savings:

- about `60s` to `90s` on combined Pages + worker deploys

Reasoning:

- current full deploys serialize two long chains that do not need to be fully serialized
- `build-pages` only needs the preview URL plus digest fetch access
- local Pages smoke can also use that preview URL
- only `deploy-pages` truly needs to wait for post-promotion `smoke-api`

Suggested implementation shape:

1. make the Pages build/local smoke path start after `smoke-api-preview`
2. pass the worker preview URL into the Pages build/local smoke jobs when `worker_changed=true`
3. keep `deploy-pages` gated on production `smoke-api`
4. keep `smoke-ui-live` after Pages publish

Risk level: medium

Main risk:

- ensuring the preview URL is used consistently for both digest sync and local `/api/*` proxying when worker changes are present

### P2. Collapse the worker release chain or reduce its install surface

Priority: high

Expected wall-clock savings:

- about `30s` to `50s`

Options:

- merge `upload-worker-version`, `smoke-api-preview`, and `deploy-worker` into one job with a single install
- keep `smoke-api` separate if you want the clean post-prod canary boundary
- or keep the job graph but switch worker-only jobs to a narrower install strategy

Possible narrower-install direction:

- use worker-workspace install for Wrangler-only jobs
- convert `smoke-api` off `tsx` if you want that job to run without full repo install

Risk level: medium

Main risk:

- reduced per-stage restart granularity and a slightly denser job script

### P3. Add CI caches for build/lint/typecheck outputs

Priority: medium

Expected wall-clock savings:

- about `10s` to `30s` on warm-cache runs

Targets worth evaluating:

- `.next/cache`
- ESLint cache
- TypeScript incremental cache if practical

Notes:

- this is secondary to structural overlap
- cache savings will be probabilistic, not guaranteed

Risk level: low to medium

Main risk:

- cache invalidation complexity and occasionally noisy misses

### P4. Parallelize `smoke-ops` with public live smoke when dependencies allow

Priority: medium

Expected wall-clock savings:

- about `20s` to `25s`

Reasoning:

- `smoke-ops` is currently queued after the whole Pages or worker path
- in practice it only needs a successful deploy state, not the completion of the public-host live canary itself

Risk level: low

Main risk:

- wiring the `needs` graph cleanly, especially while `pages-release` remains encapsulated as a reusable workflow

### P5. Treat `validate-node24` as optional blocking policy

Priority: medium

Expected wall-clock savings:

- near zero today

Expected runner-minute savings:

- around `40s` to `60s` if you remove the duplicated `lint`/`typecheck` work from that lane

Reasonable options:

- keep it blocking but reduce it to `build` + `test:critical-contracts`
- move it to PR-only
- make it non-blocking/nightly if the goal is compatibility signal rather than deploy gating

Risk level: low

Main risk:

- reduced certainty around Node 24 compatibility if you trim too far

### P6. Only reconsider slimming push-time `npm test` after branch protection changes

Priority: conditional

Potential savings:

- about `70s` from `validate`

Do not do this first.

Precondition:

- enable required status checks on `main`
- decide explicitly whether the repo wants PR-time validation to become the required gate

Without that precondition, dropping full `npm test` from push deploys would materially weaken the only required automated gate before production.

Risk level: high in the current branch-protection state

## What I Would Keep As-Is

- `detect-changes`
- the main `validate` core, including cheap policy checks
- preview API smoke before worker promotion
- post-promotion production API smoke
- local predeploy Pages artifact smoke
- live public-host Pages canary
- `smoke-ops`
- automatic worker rollback

## What I Would Not Do

- cut doc-sync/doc-count/hotspot/duplicate-export checks for runtime reasons
- remove preview smoke to save seconds
- remove ops smoke to save seconds
- rely on PR checks as the real deploy gate while required status checks remain disabled on `main`

## Recommended Implementation Order

1. Parallelize the Pages predeploy path behind `smoke-api-preview` and feed it the worker preview URL when worker changes exist.
2. Consolidate or slim the worker release jobs so install/setup is paid fewer times.
3. Add build/lint/typecheck caches.
4. Parallelize `smoke-ops` where possible.
5. Decide whether Node 24 compatibility remains a blocking deploy concern.
6. Only after branch protection is tightened, revisit whether full `npm test` belongs on push deploys or only on PRs/local merge gate.

## Bottom Line

The current pipeline is not bloated with obviously useless stages. The long runtime is mostly the cost of meaningful validation plus a still-serialized deployment graph.

The best near-term runtime wins are not “delete checks.” They are:

- overlap Pages predeploy work with the worker release path
- pay install/setup costs fewer times
- cache the expensive build/lint/typecheck work

If those are implemented cleanly, the deploy path should get materially faster without reducing confidence in production releases.

## 2026-04-23 Runtime Optimization Follow-Up

Review target:

- [`.github/workflows/deploy-cloudflare.yml`](/home/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/deploy-cloudflare.yml)
- [`.github/workflows/pages-prepare.yml`](/home/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/pages-prepare.yml)
- [`.github/workflows/pages-publish.yml`](/home/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/pages-publish.yml)
- [`.github/workflows/validate-ci.yml`](/home/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/validate-ci.yml)
- [`.github/actions/setup-workspace/action.yml`](/home/ahirice/Documents/git/stablecoin-dashboard/.github/actions/setup-workspace/action.yml)
- [`scripts/test-merge-gate.mjs`](/home/ahirice/Documents/git/stablecoin-dashboard/scripts/test-merge-gate.mjs)
- [docs/deployment-process.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/deployment-process.md)

Current implementation status:

- P1 is implemented: combined worker + Pages deploys start `pages-prepare` after `upload-worker-version` succeeds, and that job includes the uploaded Worker preview smoke. `pages-prepare` receives the preview URL as `api_base_url`, so digest sync and local static export proxying rehearse against the exact candidate Worker while `deploy-worker` and production `smoke-api` continue separately.
- P2 is partially implemented: preview upload and preview API smoke now share one `upload-worker-version` job, and smoke-only jobs use `install-deps: "false"` where they only need checked-in scripts and Node. The Worker promotion job remains separate, preserving a clean boundary before production traffic and trigger sync.
- P3 is implemented for the expensive repeatable tooling surfaces: the shared setup action restores `.next/cache`, `.cache/eslint`, and root/worker `*.tsbuildinfo` outputs for `validate`, `validate-lts`, and `pages-prepare`, keyed by Node version and core config files.
- P4 is implemented for the Pages path and worker-only path: `smoke-ops` and `smoke-transport` start from the production-changing gate rather than waiting for public live UI smoke completion.
- P5 remains intentionally present but now uses the same post-prebuild batching as the Node 25 validate lane: `validate-lts` still runs the shared deploy-surface-aware contract on Node 24.x, but after `validate:prebuild` it runs independent build/test/coverage/typecheck groups in parallel and preserves `build -> seo:check` ordering.
- P6 remains conditional: full push-time validation is still appropriate unless branch protection is changed so PR status checks become the mandatory pre-merge gate.
- A 2026-04-23 second pass added `scripts/run-validate-postbuild.mjs` so both CI validate lanes can run post-prebuild groups in parallel, moved the Pages local artifact smoke into the existing `build-pages` job to avoid a second runner setup and artifact download, removed unused PR `detect-changes` setup, and kept smoke-only jobs install-free where their scripts run on plain Node.

Residual risks to keep visible:

- Preview-backed Pages preparation is only as representative as the preview URL and proxy environment. Keep the production `smoke-api` gate before `pages-publish`, because preview URLs do not cover final route, custom-domain, trigger, or account-side behavior.
- Tooling cache hits are opportunistic. Treat cache misses as expected behavior, not deploy failures; cache correctness depends on the key including `package-lock.json`, Next config, and TypeScript configs.
- Smoke-only jobs that skip `npm ci` depend on scripts that run with Node built-ins or already available workflow context. If a smoke script starts importing package dependencies directly, either restore install coverage for that job or bundle/refactor the script deliberately.
- Pages rollback is best effort because it depends on capturing the previous production deployment id before publish. A failed capture should leave the deploy visible as risky in the workflow summary and requires manual rollback if live smoke fails.
- The deploy concurrency group now queues all production-changing deploy and rebuild workflows. This prevents overlapping production mutation and rollback work, but it can make runtime look worse during a queue backlog; distinguish queued time from execution time when measuring optimization impact.

Measurement notes for the next runtime review:

- Compare execution duration, not just total workflow duration, because the shared `production-deploy` concurrency group can add queue time.
- Segment combined deploys, worker-only deploys, Pages-only deploys, and scheduled rebuilds; the optimizations affect those paths differently.
- For combined deploys, measure whether `pages-prepare / build-pages` overlaps `deploy-worker` and production `smoke-api` as intended; local artifact smoke now appears inside `build-pages` rather than as a separate `pages-prepare / smoke-ui` job.
- Track warm-cache and cold-cache runs separately for `validate`, `validate-lts`, and `pages-prepare / build-pages`.
- Keep the earlier 2026-03-30 baseline (`684.25s` average full push deploy runtime) as the pre-overlap reference, but do not compare it directly to docs-only or deploy-surface-skipped pushes.
