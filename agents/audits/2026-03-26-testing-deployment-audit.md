# Testing And Deployment Audit

Date: 2026-03-26

## Scope

Audit target:

- the local validation/testing surface (`test:merge-gate`, Vitest suites, lint/type/build/doc/policy guards)
- the production deploy pipeline (`.github/workflows/validate-ci.yml`, `deploy-cloudflare.yml`, `pages-release.yml`, `rebuild-pages.yml`)
- current effective coverage, with special focus on data-producing and data-touching Pharos paths
- runtime-reduction scenarios from baseline through an aggressive ~50% reduction target

This report does **not** propose code changes yet. It is a decision document.

## Evidence Base

Repo/docs reviewed:

- [docs/testing.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/testing.md)
- [docs/deployment-process.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/deployment-process.md)
- [docs/architecture.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/architecture.md)
- [docs/api-reference.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/api-reference.md)
- [docs/worker-and-api-limits.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/worker-and-api-limits.md)
- [docs/data-flow-map.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/data-flow-map.md)
- [.github/workflows/validate-ci.yml](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/validate-ci.yml)
- [.github/workflows/deploy-cloudflare.yml](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/deploy-cloudflare.yml)
- [.github/workflows/pages-release.yml](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/pages-release.yml)
- [scripts/test-merge-gate.mjs](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/test-merge-gate.mjs)
- [scripts/smoke-api.mjs](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/smoke-api.mjs)
- [scripts/smoke-ui.mjs](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/smoke-ui.mjs)

GitHub Actions runs inspected:

- Full combined deploy: run `23571570317`, commit `4c44c9d`, total `11m11s`
- Pages-only deploy: run `23539074885`, commit `b44bb9c`, total `9m35s`
- Worker-only deploy: run `23559808642`, commit `19e5d94`, total `6m42s`

Local timings collected on current checkout:

- `npm test`: `40.64s`
- `npm run test:coverage`: `42.19s`
- `npm run lint`: `17.81s`
- `npm run build`: `15.08s`
- `cd worker && npx tsc --noEmit`: `5.74s`
- `npm run coverage:critical`: `3.37s`
- `npm run test:critical-contracts`: `0.96s`
- `npm run test:invariants`: `0.74s`

Current local suite/coverage counts:

- `336` test files
- `3230` passing tests, `1` todo
- overall line coverage: `77.59%`
- curated critical-coverage gate: `21` tracked files, all passing current floors

## Executive Summary

The current pipeline is **not primarily slow because the repo has too many tests**. The main sources of latency are orchestration duplication and very heavy browser smoke steps.

The two biggest runtime problems are:

1. `validate` is unconditional and expensive even when the later deploy graph proves only one surface changed.
2. Pages deploys run **two** heavy `smoke-ui` passes, and each pass is implemented in a mechanically expensive way.

The highest-confidence conclusion from the timing data is:

- the **largest low-risk savings** are in workflow structure, install/build duplication, and the live UI smoke scope
- the **largest remaining lever** after that is whether main-branch deploys really need the full `npm test` suite, or whether that full suite can live on PR/nightly while push deploys use the existing targeted critical suites

If the goal is purely “faster pushes with marginal loss of effective protection”, the first changes should **not** be deleting doc-sync or hotspot guards. Those checks are philosophically debatable in a deploy gate, but they are too cheap to matter.

## Current Pipeline Map

### Shared Validate Gate

Current `validate` always runs:

- `npm ci`
- `audit:deps`
- `lint`
- worker boundary check
- migration replay
- cron schedule check
- cron connection-budget check
- doc count check
- doc sync check
- duplicate export check
- redemption-backstop registry check
- unused-code check
- hotspot ratchet
- full Next build
- SEO static audit
- full Vitest suite
- critical coverage suite + coverage ratchet
- worker typecheck

### Deploy Branching

Current branching happens **after** validate:

- `detect-changes`
- `deploy-worker` only when `worker_changed=true`
- `smoke-api` only on worker-changing deploys
- `pages-release` only when `pages_changed=true`
- `smoke-ui-live` worker-only fallback when Pages was unchanged
- `smoke-ops` after production-changing paths

This means the repo already has deploy-surface classification, but it is not used to slim the shared validate job.

## Runtime Findings

### 1. The end-to-end runtime is dominated by orchestration duplication

Observed workflow totals:

| Path | Total |
| --- | ---: |
| Full combined deploy | `11m11s` |
| Pages-only deploy | `9m35s` |
| Worker-only deploy | `6m42s` |

The critical-path cost centers in the latest full run (`23571570317`) were:

| Segment | Time |
| --- | ---: |
| `validate` | `192s` |
| `deploy-worker` | `43s` |
| `smoke-api` | `34s` |
| `pages-release / prepare-digests` | `31s` |
| `pages-release / build-pages` | `84s` |
| `pages-release / smoke-ui` | `91s` |
| `pages-release / deploy-pages` | `47s` |
| `pages-release / smoke-ui-live` | `94s` |
| `smoke-ops` | `19s` |

### 2. Browser smoke is the single biggest post-validate offender

Current `smoke-ui` cost in GitHub Actions:

- local artifact smoke: `78s`
- live host smoke: `88s`

On combined/pages deploys, that is `166s` to `168s` of browser smoke alone, roughly a quarter of the full 11-minute path.

The live pass is especially redundant:

- local `smoke-ui` already checks the exact built artifact before deploy
- live `smoke-ui` repeats homepage loading and the full 9-route mobile overflow sweep again on production

Current default overflow route set in [scripts/smoke-ui.mjs](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/smoke-ui.mjs):

- `/`
- `/dependency-map/`
- `/flows/`
- `/yield/`
- `/liquidity/`
- `/depeg/`
- `/blacklist/`
- `/stability-index/`
- `/safety-scores/`

### 3. `smoke-ui` is not only broad, it is mechanically inefficient

The current script shells out repeatedly to:

- `npx --yes --package @playwright/cli playwright-cli`

It does this for `open`, `goto`, `eval`, `resize`, `close`, and each overflow-route step, instead of running one Playwright process/test file that performs the full sequence in-process.

That means the current runtime is paying for:

- actual UI validation
- repeated CLI process startup
- repeated `npx` resolution overhead
- repeated session round-trips

This is a pure implementation inefficiency. It is one of the cleanest “same coverage, less time” opportunities in the entire pipeline.

### 4. Repeated installs are materially expensive

In the latest full run, `npm ci` alone cost about `90s` across jobs:

- validate: `15s`
- deploy-worker: `16s`
- smoke-api: `15s`
- prepare-digests: `14s`
- build-pages: `17s`
- deploy-pages: `13s`

That runtime buys zero extra coverage. It is pure orchestration overhead.

### 5. Pages builds are duplicated on pages-changing pushes

Pages-changing pushes currently pay for two separate builds:

- `validate`: `npm run build` = `35s` to `38s`
- `pages-release / build-pages`: `npm run build` = `38s` to `40s`

That is `73s` to `78s` of duplicated build cost on pages deploys.

The second build is the one that actually matters for production artifact verification. The first is mainly acting as a general pre-deploy gate.

### 6. `validate` remains expensive even on single-surface deploys

Pages-only run `23539074885` still spent `207s` in `validate`, even though:

- `deploy-worker` was skipped
- `smoke-api` was skipped

Worker-only run `23559808642` still spent `188s` in `validate`, including:

- `npm run build` = `37s`

That 37-second build bought no deploy-path value on a worker-only push.

### 7. Inside `validate`, the real heavy steps are few

From the latest full run:

| Validate step | Time |
| --- | ---: |
| `npm run lint` | `42s` |
| `npm run build` | `35s` |
| `npm test` | `63s` |
| `npm run coverage:critical` | `9s` |
| `cd worker && npx tsc --noEmit` | `11s` |
| all remaining repo-policy/doc/guardrail checks combined | low single digits each |

This matters because it means:

- deleting tiny policy checks does almost nothing
- the meaningful decisions are about `build`, `lint`, full `npm test`, browser smoke scope, and repeated job setup/install

## Test Suite Assessment

### Inventory

Current test file distribution:

| Area | Files |
| --- | ---: |
| `src/*` tests | `92` |
| `worker/src/api/*` tests | `48` |
| `worker/src/cron/*` tests | `100` |
| `worker/src/lib/*` tests | `62` |
| `worker/src/__tests__` entrypoint tests | `2` |
| `shared/*` tests | `25` |
| `scripts/*` tests | `4` |
| `functions/*` tests | `3` |
| Total | `336` |

Worker cron/API/lib alone account for `210` test files. The suite is overwhelmingly backend/data oriented, not UI vanity testing.

Specialized worker coverage depth is also real:

- reserve adapter tests: `30` files
- DEX liquidity tests: `9` files under `worker/src/cron/dex-liquidity/__tests__/`
- DEX discovery tests: `3` files
- yield-related cron tests: `17` files

### Suite Runtime Shape

Local timing makes the tradeoffs clear:

| Command | Local runtime |
| --- | ---: |
| `npm test` | `40.64s` |
| `npm run coverage:critical` | `3.37s` |
| `npm run test:critical-contracts` | `0.96s` |
| `npm run test:invariants` | `0.74s` |

Interpretation:

- the repo already has a **useful targeted critical suite**
- the full suite is much larger than the targeted suites, but still not the dominant contributor to the full 11-minute deploy path

### Local Hotspots Inside Vitest

The JSON reporter indicates a few concentrated hotspots rather than broad suite bloat. The most obvious one is:

- `worker/src/cron/__tests__/enrich-prices.test.ts`

It dominates the suite’s slowest individual assertion timings. Secondary hotspots are much smaller:

- `worker/src/lib/__tests__/cex-tickers.test.ts`
- `worker/src/cron/dex-discovery/__tests__/crawl-sources.test.ts`
- `worker/src/cron/__tests__/sync-live-reserves.test.ts`

This suggests the unit/integration suite does **not** need wholesale cutting. If you want to shrink pure Vitest time later, you should profile and optimize a few specific suites rather than reducing broad coverage.

## Coverage Assessment

### Overall Coverage

Current full coverage run:

- line coverage: `77.59%`

This is a healthy global baseline for a mixed frontend/worker repo of this size.

### Current Curated Critical-Coverage Gate

Current critical gate baseline file: [.ci/critical-coverage-baseline.json](/Users/ahirice/Documents/git/stablecoin-dashboard/.ci/critical-coverage-baseline.json)

Representative current critical-path line coverage:

| File | Coverage |
| --- | ---: |
| `worker/src/cron/sync-stablecoins.ts` | `94.0%` |
| `worker/src/cron/sync-yield-data.ts` | `96.69%` |
| `worker/src/cron/daily-digest.ts` | `77.94%` |
| `worker/src/cron/dex-liquidity/orchestrator.ts` | `78.31%` |
| `worker/src/api/dex-liquidity.ts` | `85.22%` |
| `worker/src/api/mint-burn-flows.ts` | `89.51%` |
| `worker/src/api/stress-signals.ts` | `95.56%` |
| `worker/src/api/status.ts` | `100%` |
| `worker/src/api/health.ts` | `82.89%` |
| `worker/src/lib/stablecoins-cache.ts` | `92.0%` |
| `worker/src/lib/evm-rpc.ts` | `78.89%` |
| `src/lib/api.ts` | `92.77%` |

This part of the suite is strong and justified.

### Important Distinction

The curated `coverage:critical` gate is **not the same thing** as “all Pharos data-critical coverage”.

It is a tight, high-signal subset. That is good for runtime. But it means several real data paths are not currently protected by explicit coverage floors.

## Critical Data Coverage Assessment

Below, “critical” means anything that produces, computes, or persists Pharos data, or directly serves those computed results.

### Strongly Covered Critical Domains

| Domain | Evidence | Assessment |
| --- | --- | --- |
| Stablecoin core pricing/supply ingestion | `sync-stablecoins 94%`, `stablecoin-detail 100%`, strong price-consensus/validation/FX tests | Strong |
| Depeg detection + pending confirmation | `detect-depegs 90.14%`, `confirm-pending-depegs 95.08%`, dedicated tests | Strong |
| Mint/burn pipeline | `sync-mint-burn 90.65%`, `mint-burn-flows API 89.51%`, dedicated parsing/classification/persistence tests | Strong |
| PSI / stability index | `stability-index cron 95.35%`, `stability-index API 100%`, replay/recompute/benchmark tests | Strong |
| DEWS | `compute-dews 83.84%`, `stress-signals API 95.56%`, dedicated tests | Strong |
| Yield core sync | `sync-yield-data 96.69%`, deep source/resolve/history tests | Strong |
| Redemption backstops | `sync-redemption-backstops 98.15%`, API `88.89%`, config registry checker | Strong |
| Status/ops surface | `status API 100%`, `status-self-check 87.41%`, post-deploy ops smoke | Strong |

### Moderately Covered Or Uneven Critical Domains

| Domain | Evidence | Assessment |
| --- | --- | --- |
| DEX discovery/liquidity | high-level orchestrators are strong (`78%+`), API is strong (`85.22%`), but several lower-level fetch/fallback helpers are weak | Uneven |
| Live reserves | top-level sync/API are solid (`79.23%`, `84.62%`), but helper/adapter coverage is uneven across individual adapters | Uneven |
| Stablecoin charts / chain analytics / supply-history periphery | tests exist and key files are covered, but these paths are not prominently represented in live smoke or explicit critical floors | Moderate |
| Daily digest/public digest endpoints | core cron is decent (`77.94%`) and API paths exist, but this area is mostly protected by unit tests and Pages rebuild, not broad live smoke | Moderate |

### Meaningful Critical Gaps

Representative lower-coverage data-critical files from the current full coverage run:

| File | Coverage | Notes |
| --- | ---: | --- |
| `worker/src/cron/sync-blacklist.ts` | `57.78%` | Important production data pipeline, not in critical coverage gate, not in smoke-api |
| `worker/src/api/peg-summary.ts` | `62.77%` | In critical gate, but notably lower than other critical APIs |
| `worker/src/cron/dex-liquidity/fetch-primary.ts` | `29.04%` | Critical DEX liquidity ingestion/fetch surface |
| `worker/src/cron/dex-liquidity/fetch-fallbacks.ts` | `15.75%` | Critical long-tail DEX/fallback path |
| `worker/src/cron/dex-liquidity/crawl-helpers.ts` | `0%` | DEX data path helper gap |
| `worker/src/cron/dex-liquidity/subgraph-helpers.ts` | `0%` | DEX data path helper gap |
| `worker/src/cron/reserve-adapters/helpers.ts` | `56.54%` | Shared reserve-adapter helper code |
| `worker/src/cron/yield-sync/rankings.ts` | `30.56%` | Output-facing yield ranking assembly is lightly covered |
| `worker/src/cron/yield-sync/publication.ts` | `68.82%` | Borderline for a published data path |
| `worker/src/cron/sync-stablecoins/supplemental-assets.ts` | `61.19%` | Important stablecoin ingest extension path |

The important implication is:

- if runtime budget must be reallocated, it is more rational to reduce redundant UI smoke than to preserve it at the expense of improving these data-critical gaps

## Smoke Coverage Assessment

### API Smoke

Current `smoke-api` covers:

- `/api/health`
- `8` strict contract endpoints

Strict endpoint set:

- `/api/stablecoins`
- `/api/peg-summary`
- `/api/dex-liquidity`
- `/api/stability-index`
- `/api/report-cards`
- `/api/redemption-backstops`
- `/api/mint-burn-flows`
- `/api/stress-signals`

Current endpoint metadata counts:

- `46` endpoint definitions total
- `27` public probe endpoints
- `8` strict contract endpoints

Interpretation:

- `smoke-api` is cheap and justified
- but it is narrower than the total public data surface
- the pipeline currently spends more time on duplicate browser smoke than on broad live API/data verification

### UI Smoke

Current UI smoke is valuable, but overweighted:

- local artifact smoke is high value
- live smoke should exist, but the current live scope is too close to the local scope

### Ops Smoke

`smoke-ops` is short (`10s` to `12s` actual test time) and protects a production-important operator surface. It is not a primary runtime offender.

## Overengineering Assessment

### Justified

These components are justified and should not be first-cut targets:

- full Vitest suite
- `coverage:critical`
- migration replay
- worker boundary guard
- cron schedule/connection-budget checks
- API smoke
- local artifact Pages smoke before deploy
- ops smoke

### Borderline But Cheap

These are debatable as deploy blockers, but not runtime-significant:

- `check:unused-code`
- `check:hotspot-ratchet`
- `check:duplicate-exports`
- `check:doc-counts`
- `check:doc-sync`

If the goal is runtime reduction, these are poor targets.

### Overengineered Relative To Runtime Cost

These are the real “worst offender runtime x lowest incremental value” candidates:

1. Full live `smoke-ui` after a full local predeploy `smoke-ui`
2. `smoke-ui` implementation via repeated Playwright CLI shell-outs
3. duplicate Next builds on Pages-changing pushes
4. repeated `npm ci` across sequential jobs
5. unconditional `validate` despite existing path classification

## Incremental Runtime-Reduction Scenarios

These scenarios are cumulative in spirit, not exact implementation bundles. Time estimates are based on the observed GitHub runs above.

### Scenario 0: Baseline

Current observed runtimes:

- full combined: `11m11s`
- pages-only: `9m35s`
- worker-only: `6m42s`

### Scenario 1: Conservative, Near-Zero Coverage Loss

Changes:

- rewrite `smoke-ui` to a single Playwright process instead of repeated CLI shell-outs
- keep the same local predeploy UI coverage
- keep a live smoke, but reduce it to homepage + GA snippet + one canary route, no 9-route overflow sweep
- merge `prepare-digests` into `build-pages` so the Pages path installs once fewer times

Expected impact:

- full combined: roughly `9m30s` to `10m00s`
- pages-only: roughly `8m00s` to `8m30s`
- worker-only: roughly `5m20s` to `5m40s`

Why this is attractive:

- almost no effective coverage loss
- attacks the largest redundant browser/runtime overhead directly
- does not weaken data-critical validation

### Scenario 2: Balanced, Minimal Confidence Loss

Scenario 1 plus:

- make CI `validate` diff-aware, using the same already-existing deploy classification model
- skip `build` + `seo:check` on worker-only pushes
- skip worker typecheck on pages-only pushes
- skip the full deploy workflow entirely when neither Pages nor worker deploy surfaces changed

Expected impact:

- full combined: roughly `8m40s` to `9m10s`
- pages-only: roughly `6m45s` to `7m15s`
- worker-only: roughly `4m45s` to `5m15s`

Why this is attractive:

- still keeps full checks on the surfaces that changed
- removes obvious misclassification waste
- aligns CI with the deploy classifier the repo already has

### Scenario 3: Strong Optimization, Still Defensible

Scenario 2 plus:

- keep the full 9-route overflow sweep only on the local artifact smoke
- move the full overflow sweep to the scheduled Pages rebuild or a nightly browser workflow
- on push deploys, keep only a smaller predeploy overflow subset such as `/`, `/yield/`, `/liquidity/`
- slightly broaden `smoke-api` to cover one or two currently under-smoked data surfaces such as `/api/blacklist` and `/api/yield-rankings`

Expected impact:

- full combined: roughly `6m45s` to `7m30s`
- pages-only: roughly `5m15s` to `6m00s`
- worker-only: roughly `4m30s` to `5m00s`

Tradeoff:

- small reduction in push-path long-tail visual/layout coverage
- but coverage shifts toward data surfaces, which is more aligned with Pharos risk

### Scenario 4: Aggressive, Around 50% On The Full Path

Scenario 3 plus:

- replace full `npm test` on **main push deploys only** with:
  - `npm run test:critical-contracts`
  - `npm run test:invariants`
  - `npm run coverage:critical`
- keep full `npm test` on pull requests and nightly/scheduled validation
- optionally move `smoke-ops` off the blocking path and run it as a fast follow-up

Expected impact:

- full combined: roughly `5m15s` to `5m45s`
- pages-only: roughly `4m30s` to `5m15s`
- worker-only: roughly `3m45s` to `4m30s`

Tradeoff:

- this is the first scenario that materially reduces the main-branch test breadth
- it is only acceptable if PR validation is mandatory and trusted

Key conclusion:

- getting close to `50%` on the full 11-minute path is **not** realistically achievable by trimming tiny guardrails
- it requires changing either:
  - the browser smoke scope
  - the push-path test policy
  - or both

## Recommended Order

If the objective is best runtime reduction for the least confidence loss, the implementation order should be:

1. Optimize `smoke-ui` mechanically and cut the live smoke scope.
2. Collapse Pages-job install/build duplication.
3. Make CI/local validate diff-aware by deploy surface.
4. Reinvest a small amount of saved runtime into slightly broader data smoke, not broader UI smoke.
5. Only then decide whether main-branch deploys still need full `npm test`.

## Bottom Line

The repo is **not overtested** in a simplistic sense. The worker/data surface is heavily tested and generally well covered.

The overengineering is mostly in the **shape of the pipeline**:

- unconditional validate
- duplicate builds
- repeated installs
- duplicate heavy UI smoke
- an expensive UI-smoke implementation

If you want faster, more incremental pushes without materially weakening Pharos data integrity, start by cutting **orchestration waste** and **live UI-smoke redundancy**, not by gutting the worker/data test suite.
