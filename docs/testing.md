# Testing & Linting

> **Agent navigation** — Grep the heading you need instead of reading wholesale: Overview · [Pre-push readiness](#pre-push-readiness) · Commands · [Smallest adequate check per area](#smallest-adequate-check-per-area) · [Generated-artifact failure playbook](#generated-artifact-failure-playbook) · Source Formatting Policy · CI Pipeline · Vitest Runtime Profiling · Test Setup · Test Infrastructure · Test Inventory · Conventions · [Test-lane gate protocol](#test-lane-gate-protocol) · Coverage · Adding a New Test · ESLint Configuration.

## Overview

The project uses **Vitest** for unit tests and **ESLint** (via `eslint-config-next`) for linting. The shared validation suite runs on pull requests; the [release snapshot state machine](./deployment-process.md#release-snapshot-state-machine) owns protected-`main` and post-merge behavior.

## Pre-push readiness

Run `npm run check:pr` for focused authoring feedback before pushing; hosted CI is the readiness authority. Local receipts are optional diagnostics, not a push prerequisite. There is no pre-push test hook.

Use the exact `.nvmrc` Node and npm 11.x runtime, not merely an engine-compatible major; nested npm/`npx` commands must inherit it:

```sh
export PATH="${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims:$PATH"
mise settings add idiomatic_version_file_enable_tools node
mise install
npm run check:pr
```

Keep generated artifacts with their owning source changes and use `npm run check:generated-artifacts` to inspect convergence. Runtime and receipt mechanics are owned by [`runtime-guard.mts`](../scripts/lib/runtime-guard.mts), [`run-pr-checks.ts`](../scripts/maintenance/run-pr-checks.ts), and [`pr-check-receipt.mts`](../scripts/lib/pr-check-receipt.mts); generated owners live in [`automation-registry.mjs`](../scripts/lib/automation-registry.mjs).

Receipt schema version 1 records runtime, base/head SHAs, tree cleanliness, invocation flags, `weakened`, optional `incompleteReasons`, timestamps, and per-leaf outcomes/durations. The runner writes `.tmp/pr-check-receipts/<headSha>.json` for optional local diagnosis: failed leaves yield `failed`; dirty state, weakened invocations, or skipped required leaves yield `incomplete`; otherwise it records `passed`. These outcomes describe that local run, not hosted readiness. `deferred-to-ci` leaves do not make local diagnostics incomplete. Setup/runtime failures replace an older receipt when HEAD can be resolved.

Use `npm run check:pr -- --explain-receipt` to explain the current-HEAD receipt from local Git state only; it never fetches, runs checks, rewrites receipts, stages, or authorizes a push. Missing receipts are not a blocker; remote-base freshness remains unknown.

The local runner executes the secret, docs, static and selected-test leaves. CI-owned lanes include the classifier-selected `pages-artifact` lane: GitHub runs it on a dedicated runner and keeps it required, while the local receipt records it as `deferred-to-ci`. Add `--with-pages` for local Pages build/size/SEO diagnosis. Measured coverage is not a PR/local lane; use `CRITICAL_COVERAGE_RATCHET_ALL=1 npm run coverage:critical` directly for the weekly-equivalent measurement when changing coverage floors.

When CI fails, collect **every failed leaf**, reproduce narrowly, fix all causal defects in one revision, rerun focused checks, then push once. Use the [workflow incident runbook](./runbooks/workflow-incidents.md) for remote evidence and incident handling.

## Commands

Use the [validation command index](./scripts.md#validation-command-index) for command entrypoints and their canonical owners; this section owns what those validation lanes do.

`check:pr` is the adaptive local feedback runner, implemented by [`scripts/maintenance/run-pr-checks.ts`](../scripts/maintenance/run-pr-checks.ts). After the pinned runtime guard it refreshes `origin/main` by default, resolves frozen base/head identities, and rejects `--head` unless it resolves to checked-out HEAD; `--staged` is rejected because checks inspect the checkout, not the index. Dirty tracked or untracked state (respecting `.gitignore`) remains usable for authoring checks and records an incomplete diagnostic with reason `dirty-worktree`. `--no-fetch` or `PHAROS_PR_NO_FETCH=1` skips fetching; a failed refresh or a stale base with fetching disabled weakens the diagnostic. The runner warns when the base commit is over 24 hours old.

[`pr-lanes.mts`](../scripts/lib/pr-lanes.mts) owns lane commands, selectors, shard limits, and timeouts for the local runner and generated Actions matrix. Local tests are unsharded; the static plan is expanded into individual leaves. Leaves run as two concurrent serial tracks — Vitest (`pr-tests` and, when selected, `v9-resource`) and the secret/docs/static leaves — followed by an opted-in `pages-artifact` alone, because it overlays release data into the checkout and deletes `.next`/`out`. Local `pr-tests` retains selected critical-owner tests in the uninstrumented run. Every independent selected leaf runs even after another fails or throws, then the final table reports status, milliseconds, command, and first actionable error, listing omitted/deferred leaves before selected leaves in plan order. Internal-docs-only changes select the shared docs commands instead of static/tests. Mixed changes reuse the classifier's `docsChanged` predicate, not a separate “any Markdown” selector, and include those docs checks in the expanded static leaves. The static plan owns doc-sync once and retains source-owned doc-sync checks for source-only changes. Pages-impact changes select the representative Pages artifact check, deferred to CI unless `--with-pages` is passed.

The trusted local secret contract is `runLocalTrustedGitleaks`, also exposed as `node --import tsx scripts/ci/run-gitleaks.ts --local-trusted --base=<full-sha> --head=<full-sha>`. It materializes the committed base scanner/import closure and policy, runs trusted range and merge-resolution scans, then checks committed candidate scanner/policy when changed; candidate success cannot replace trusted scans. It uses a temporary detached scan repository with read-only object alternates and redacted scanner output. It **does not scan uncommitted edits** or synthesize GitHub's PR merge. Exit codes are 0 clean, 1 findings, and 2 usage/setup errors. Source: [`run-gitleaks.ts`](../scripts/ci/run-gitleaks.ts).

Receipt outcomes and publication interpretation are owned by [Pre-push readiness](#pre-push-readiness).

`npm run check:pr -- --plan` prints selected lanes/commands, test files and CI partitions, critical owners, refs, and limitations without executing checks or fetching. Test discovery may import modules. Its skipped leaves make the optional diagnostic receipt incomplete. `--json` selects the machine-readable local report, with progress on stderr; its execution `status` matches the receipt outcome, including `incomplete` for dirty or weakened runs. Neither output is readiness authority.

`check:bootstrap` separately rehearses clean committed-state bootstrap, and `check:release` is an optional production-build/Worker-bundle rehearsal, not the [protected release path](./deployment-process.md#release-snapshot-state-machine).

`npm run ci:census -- --since=YYYY-MM-DD [--until=YYYY-MM-DD] [--cut=YYYY-MM-DD] [--out=<path.json>]` uses authenticated `gh` for GET-only workflow/run/attempt/job evidence; it writes JSON and `<path.json>.md` when requested, otherwise prints both. It distinguishes latest run-ID conclusions from retained executions, censored branches, and annotation-backed cancellation classes; UTC cohorts are descriptive, not causal attribution. Failure categories require owner classification. Source: [`ci-failure-census.ts`](../scripts/maintenance/ci-failure-census.ts).

Use `package.json` for the full live npm-script list. `scripts/lib/automation-registry.mjs` owns generated artifacts and deploy-impact classification; `scripts/lib/critical-ownership.mts` derives critical source-to-test ownership, while `scripts/lib/critical-test-files.mts` and `scripts/lib/critical-coverage.mjs` consume it for critical-suite membership.

`npm run typecheck:tests` compiles the complete test surface, including every TypeScript and TSX support file under `tests/` rather than only `*.test.*` and `*.spec.*` entrypoints. The lane runs in nightly/manual validation so shared fixtures and helpers cannot accumulate type errors outside Vitest's selected module graph.

`check:verified-doc-links` uses the docs renderer’s Markdown parsing and heading IDs, including repeated punctuation and duplicate headings. It resolves ordinary links and images with optional titles, angle-bracket destinations, and reference definitions, then checks local targets and anchors. A verified doc at or above 400 lines or 50 KB must include a top `> **Agent navigation**` block. (The separate requirement that a doc-ownership reference name a section for such a target is enforced by `scripts/__tests__/doc-ownership-registry.test.ts`, not by this check.)

Changed-file classification retains deletions and both sides of cross-area renames; ordinary Git selection failures stop the check rather than producing an empty plan. Classification uses frozen base/branch-head refs; CI executes on a tested merge checkout, so import-graph test discovery inspects that tree while ownership selection retains the branch diff. Nonexistent test files are filtered only before execution. Generic parallel commands cancel and settle siblings on failure unless continue-on-error is explicit; the local PR runner instead collects every independent leaf. Sources: [`changed-files.mts`](../scripts/lib/changed-files.mts) and [`run-pr-checks.ts`](../scripts/maintenance/run-pr-checks.ts).

`check:doc-sync` also verifies generated contract blocks: `scripts/lib/doc-sync/contract-blocks.ts` renders every source-backed literal (thresholds, weights, TTLs, methodology versions) between `<!-- GENERATED-START: <id> -->`/`<!-- GENERATED-END: <id> -->` markers, and the check fails with the expected block when a doc's marker content drifts from the source constant. Edit the source constant, then paste the reported expected block; never hand-edit the value inside the markers.

### Smallest adequate check per area

Use `npm run check:focused -- --file <path>` to route one path through the change contract and run the checks selected by its ownership mappings, preferring specific-tier mappings over fallback-tier mappings for each path; add `--plan-only` to inspect the plan without executing it.

Explicit paths use the same normalization as `agent:route`, including repository-relative, `./`, and absolute paths within the repository or current worktree. Outside-root paths fail selection. Unmapped paths produce `routing-incomplete` and exit 1 before checks, even in plan-only mode; an empty plan for an unmapped production path is a routing failure, not verification. A fully mapped area with no focused commands reports `intentional-no-check` (for example, low-risk documentation); it still needs its local recipe and full readiness. Source: [`run-focused-checks.ts`](../scripts/maintenance/run-focused-checks.ts).

Focused lint forwards the resolved selection as repeatable `--file` arguments, rather than re-reading a branch diff. Bare `npm run lint:changed` checks staged, unstaged, and untracked working-tree files; use `--staged` for index-selected paths or explicit `--base` / `--head` (also supplied by PR environment variables) for branch-range isolation. Deleted files are excluded. ESLint reads the current working-tree contents of selected paths, including paths selected from the index. Extra ESLint options follow a second `--`.

For generic frontend modules, the focused runner uses `vitest related --run --passWithNoTests=false`; zero related tests fails and requires an explicit suite for runtime-loaded coverage. Non-module changes retain directory coverage; scripts retain their suite because source-reading/CLI contracts are invisible to imports. Generic Worker/shared mappings now supply changed-file lint, relevant typechecks, and affected checkable generated artifacts (including dependencies), not a zero-check fallback. Sensitive mappings retain explicit suites and guardrails. [`docs/doc-ownership.json`](./doc-ownership.json) also declares `testOwnership` for source-inspecting invariants (including isolate-local-state and Safety Score evaluation identity/resource/native-input/capture tests); [`pr-test-selection.mts`](../scripts/lib/pr-test-selection.mts) adds these owners independently of focused-tier precedence and fails if a declared test is missing. `--plan-only` previews narrowed authoring feedback, never readiness.

| Area | Smallest adequate local recipe | Conditional additions |
| --- | --- | --- |
| Shared `shared/lib` change | `npm run check:focused -- --file <path>` selects lint, root/Worker typechecks, and affected checkable artifacts; add `npx vitest run shared/lib` for behavior | Add `npm run check:stablecoin-data` for catalog/data semantics and selected critical-consumer tests. |
| Generic Worker runtime/library change | `npm run check:focused -- --file <path>` selects lint, Worker typing, and affected checkable artifacts | Run the owning behavioral suite; PR selection additionally includes declared source-inspecting `testOwnership` invariants. |
| Worker cron change | `npm run lint:changed`; `npm run typecheck:worker`; `npm run check:cron-sync`; `npm run check:cron-connections`; `npx vitest run worker/src/cron worker/src/handlers/scheduled` | Add `npm run validate:worker-scheduled-smoke` for dispatch wiring and the focused cron test when a specific source mapping supplies one. |
| `src/components` change | `npm run check:focused -- --file <component-path>` selects lint, source typing, and related tests | Route/public-surface changes need the page-specific registry/CSP/SEO checks. |
| API route (`worker/src/api` or `functions/`) change | `npm run lint:changed`; `npm run typecheck`; `npm run typecheck:worker`; `npm run test:critical-contracts` | Add `npm run test:pr -- --base=<ref>` when dependency-selected or multi-mode contract coverage is needed. |
| D1 migration | `npm run lint:changed`; `npm run typecheck:worker`; `npm run check:migrations`; `npx vitest run worker/src` | Add the affected API test under `worker/src/api/__tests__/<relevant>.test.ts` when runtime behavior changes; run `npm run test:pr -- --base=<ref>` for critical consumers. |
| Stablecoin JSON (`shared/data/stablecoins/**`) | `npm run lint:changed`; `npm run check:stablecoin-data`; `npm run check:generated-artifacts -- --only=stablecoin-client-projections`; `npm run typecheck`; `npm run typecheck:worker`; `npx vitest run shared/lib/stablecoins shared/lib/__tests__/stablecoin-id-registry.test.ts` | Add the focused catalog/registry test and `npm run check:dependency-review-gaps` when dependency or reserve mappings change; `check:pr:static` also selects page and Worker checks because stablecoin data is a deploy-impact shared path. |
| Safety Score V9 | Focused routing retains lint, Worker typing, `check:generated-artifacts -- --only=safety-score-v9-evaluation-build`, `check:doc-sync`, `audit:mint-authority-review`, and `npx vitest run shared/lib/safety-score-v9 worker/src/lib` | PR `testOwnership` adds source-selected evaluation-build identity, resource-budget, native-input/capture, and publication archive/replay invariants even when import discovery cannot find them. |
| Dependency coverage | `npm run audit:coverage -- --domain=dependency-coverage` (report); `npm run check:dependency-review-gaps` (gate, included in `check:structural`) | Add `--prod` to the report command for current published graph and live-reserve comparison. The weekly production gate fails and alerts on structural findings but never blocks releases; see [Dependency network runbook](./runbooks/dependency-network.md). |
| Docs-only change | `npm run check:verified-doc-links`; `npm run check:doc-source-paths`; `npm run check:doc-sync`; `npx vitest run scripts/__tests__/doc-ownership-registry.test.ts`; `npm run check:generated-artifacts -- --only=agents-doc` | The shared docs commands are not full convergence. Generated output edits, including `docs/api-reference.md`, additionally select their owning artifact freshness check. |

### Generated-artifact failure playbook

Automatic check plans exclude registry entries marked `checkable: false`; an explicit `--only` containing any such entry fails before executing any child, even when mixed with checkable IDs. Legitimately empty artifact plans print a skip message, not a freshness claim. `sitemap-dates` and `docs-metadata` are build-time, Git-history-derived projections rather than checkable snapshots; their dates require full Git history.
A shallow checkout or missing history fails during history generation instead of using unsafe filesystem timestamps.

For ordinary offline bootstrap-safe artifacts (including valid empty detail-snapshot envelopes):

```bash
npm run bootstrap:generated
```

For the history-derived projections, obtain full history first, then:

```bash
npm run bootstrap:generated:history
```

For one checkable artifact:

```bash
npm run check:generated-artifacts -- --only=<id>
```

The former `check:commit-derived-artifacts` path is retired; do not retry it. Do not retry a history-derived `--check` in a shallow or incomplete checkout; fix the checkout and run the history bootstrap first.

Common targeted runners:

```bash
npx vitest run scripts/maintenance/__tests__/build-annotation-candidates.test.ts
npm run test:profile -- --output /tmp/pharos-vitest-profile.json
npm run test:critical-contracts
npm run coverage:critical
npm run validate:pages-smoke
npm run validate:worker-scheduled-smoke
npm run validate:worker-smoke
npm run test:smoke-api -- --base-url https://api.pharos.watch
npm run test:smoke-ops
npm run test:smoke-transport
npm run test:smoke-ui -- --url https://pharos.watch --mode live
npm run test:smoke-ui:mobile -- --url http://localhost:3000
npm run test:smoke-pages-assets -- --url https://pharos.watch --mode live
```

Markdown variants are generated for `/methodology/`, methodology changelogs, `/changelog/`, `/digest/[date]/`, stablecoin detail pages, and `/docs/*`. Representative checked-in fixture snapshots live under `scripts/__tests__/fixtures/markdown/`; refresh them with `npm run refresh:markdown-fixtures` and commit them with changes to their renderers or source inputs.

`npm run audit:pricing-providers` checks the configured CEX and RedStone provider contracts against live metadata and is covered by mocked unit tests for success, regional blocking, provider drift, non-OK responses, and malformed metadata shapes. Optional live source-shape probes can be run with `npx tsx scripts/maintenance/audit-pricing-provider-config.ts --live-source-shapes`; this adds Jupiter V3 shape validation and, when `CMC_API_KEY` is set, a CoinMarketCap category shape check. Stablecoins sync metadata also emits `pricingSourceAuditReport`, which summarizes source distribution risks such as missing prices, fallback/cache reliance, low-confidence pricing, assets without an independent hard source, and structured provider rejection counts.

When `SMOKE_UI_EXPECT_GA_ID` is set, `npm run test:smoke-ui` first verifies that the homepage artifact does not preload GA as first-paint work, then the browser smoke requires a successful `gtag.js` load in both modes; local artifact mode additionally asserts the runtime initialization state (`window.gtag`, the expected `config` entry, the `page_view` entry), while live mode warns and falls back to the network signals when that runtime global is not observable. Live mode requires a successful `page_view` collect response; after that success, expected-measurement GA collect `net::ERR_ABORTED` reports are treated as browser beacon noise. Local artifact mode also accepts a Playwright `net::ERR_ABORTED` report for a GA4 collect URL with the configured measurement id, without requiring its event name, because Chromium can abort that issued beacon when the local smoke context closes.

## Source Formatting Policy

Pharos intentionally has no canonical source formatter. The repository is agent-maintained, and its existing source, curated data, generated artifacts, fixtures, and documentation contain multiple deliberate layouts. Applying a formatter to a touched legacy file creates unrelated review and merge churn without improving runtime correctness.

- Preserve existing layout in edited files and match nearby conventions in new code.
- Keep formatting-only changes out of semantic patches unless the task explicitly requests them.
- Treat generated-file layout as generator-owned; regenerate artifacts instead of normalizing their output afterward.
- Use `.editorconfig` and `git diff --check` for whitespace hygiene. Use ESLint, TypeScript, schemas, and focused tests for semantic and structural validation.
- Do not invoke an ad hoc formatter or add a replacement formatter dependency. Reintroducing canonical formatting requires an explicit repository-wide decision with a defined scope, a one-time baseline, exclusions for non-owned formats, and mandatory automated enforcement.

Static OG checks render the current SVG and compare its PNG pixels against the published image, even when checked-in source and PNG hashes match the manifest. Signature-only edits cannot certify an old image; run the owning OG generator to refresh both images and signatures.

## CI Pipeline

Workflow YAML is the source of truth. The main validation files are [pull-request-checks.yml](../.github/workflows/pull-request-checks.yml) and [nightly-validation.yml](../.github/workflows/nightly-validation.yml); the [CI deploy sequence](./deployment-process.md#ci-deploy-sequence) owns the production workflow inventory and ordering.

For deployment/worktree operating procedure, secrets, and rollback, see [Deployment Process](./deployment-process.md).

Same-repository actions and reusable workflows use GitHub’s `$/` references, binding their definitions to the workflow commit rather than mutable checkout contents. Workspace checkouts remain required for npm, scripts, and build inputs. Runners, including any `CI_VALIDATE_RUNNER` override, must support this syntax (Actions runner 2.336.0 or newer).

CI shape:

1. `secrets` and `prepare` start independently. Secrets snapshots the exact PR base scanner/import closure/config/ignore policy, then executes trusted `--range` and PR merge-resolution `--tree` scans with `--policy-root`. Candidate `--range --candidate-policy --trusted-root` runs only when scanner/policy differ; candidate success never replaces trusted scans.
2. `prepare` installs/bootstraps offline/history inputs and classifies frozen event base/branch-head refs while testing GitHub's merge checkout. Non-docs-only PRs serialize `.tmp/pr-test-plan.json` for matrices without execution. Docs-only PRs run the shared docs commands inline (ownership invariants included), without scheduling validation jobs; `docs/editorial-style.md` retains full static selection. A run/producer-attempt/SHA artifact transports `node_modules`, registered ignored bootstrap outputs, and the plan in zstd (`zstd -T0 -3`, upload compression `0`). Consumers restore `workspace_artifact_name` without reinstalling; setup rejects changed tracked/checkable bootstrap outputs. PR jobs do not save ESLint/TypeScript caches; npm and selected browser caches use save-capable actions. Sources: workflow, [`pr-lanes.mts`](../scripts/lib/pr-lanes.mts).
3. `validation` restores the workspace and runs the manifest-selected `static-compile`, `static-guards`, `tests`, and selected `v9-resource` lanes. `check:pr:static --group=compile` owns changed-file lint and selected root/Worker typechecks; `--group=guards` owns the remaining selected checks. Mixed docs/source PRs run verified-doc links, doc-source paths, doc-sync, the doc-ownership registry test, and the agents-doc artifact check inside `static-guards`, not a separate docs job. Doc-sync has one owner in the static plan; source-only PRs still select it for owned-documentation impact. Test shards consume `PR_TEST_PLAN_FILE=.tmp/pr-test-plan.json`, validate its base and shard count, and execute explicit file partitions without repeating selection or applying Vitest's hash sharding. The plan uses four shards, or eight when the selected test-file count exceeds 800.
4. `pagesArtifactRequired` selects `pages-artifact` after prepare. With `actions: read`, the frozen PR base helper GET-downloads/validates the newest unexpired successful-main `pages-release-data-<sha>` before candidate setup; `GH_TOKEN` is scoped only to that step. The token-free candidate uses `PAGES_RELEASE_DATA_DIR`; the [runner](../scripts/ci/run-pages-artifact-lane.ts) overlays data, generates compile-input/post-refresh with offline detail replay, runs Webpack/postbuild and every `check:pages-release` gate without live refresh/publishing. Missing base helper or unavailable CLI/auth/API/download/artifact yields `degraded-data`: committed snapshots + offline bootstrap, **not** realistic size proof. Invalid data/gate failures remain fatal.
5. `PR gate` runs with `always()` and requires secrets/prepare success. Non-docs-only validation must succeed; docs-only validation must be skipped with successful inline docs. Selected Pages artifacts must succeed; unselected Pages requires explicit `false` and skipped. Failures, cancellations, missing classification, and unexpected skips fail the gate.
6. Nightly/manual mandatory lint, root/Worker typing, typed lint, test typing, and structural steps each run after workspace success with `!cancelled()`: one failure cannot hide later leaves. The aggregate prints all six outcomes and fails unless all succeed. Cache save requires lint/root/Worker typing success. Full Vitest has two shards. [`package.json`](../package.json) gives typed lint, Worker typing and test typing an 8 GiB heap so the full programs do not depend on Node's smaller default heap; typed lint uses combined TS/TSX globs, and [`typed-lint-scope.test.ts`](../scripts/__tests__/typed-lint-scope.test.ts) checks intended-root probes and actual-file coverage. ESLint rejects unmatched patterns. Zizmor retains change/scheduled backstops; weekly all-critical coverage is blocking.

The required `v9-resource` lane's execution, environment isolation, failure classification and non-gating diagnostic are documented in [V9 resource lane](#v9-resource-lane).

The PR `v9-resource` lane runs for the audited evaluator/catalog dependency closure plus conservative shared/Worker library, data, setup-migration, resource-harness, bundler and toolchain input families; unrelated frontend, API and most cron edits skip it. Missing or unclassifiable input selects it fail-closed. Nightly validation remains the unconditional V9 resource-budget owner.

CodeQL runs daily and retains its Monday schedule and manual dispatch, rather than running on every main push.

The Node 26 advisory typecheck runs weekly; nightly `test:all` remains unchanged pending the full-suite capacity decision. The weekly workflow no longer duplicates the nightly V9 resource run.

The [weekly workflow](../.github/workflows/weekly-validation.yml) also compares Cloudflare account state with `CLOUDFLARE_ACCOUNT_STATE_DRIFT_API_TOKEN`.

Weekly dependency coverage keeps structural evaluation separate from permanent advisory reconciliation (`if: always()`, `continue-on-error: true`). Audit JSON carries schema-validated upstream publication identity, clocks and source generations plus the audit checkout revision; `generatedAt` is only the capture clock. Reconciliation reports the current comparison checkout separately and renders absent legacy provenance as unknown, never reconstructing a publication generation from the capture time or methodology version. Malformed supplied provenance is a tool error, not a clean comparison. Differences do not admit edges or gate releases.

Validation is capped at `max-parallel: 10` with `fail-fast: false`. The [PR workflow](../.github/workflows/pull-request-checks.yml) now peaks at **12 jobs: validation 10 + Pages 1 + secrets 1**. Under GitHub Free's 20-concurrent-job allowance this leaves eight slots, shared with other workflows. An eight-test-shard mixed PR has twelve validation entries, so two queue within the validation cap.

**Re-run failed jobs** can retry a validation shard without rerunning successful `prepare`: consumers validate and restore its producer-owned name, not their new attempt. Workspace artifacts expire after one day, so an expired transport requires a full rerun/new run. Failed `prepare` reruns itself; source fixes require a new PR revision.

Firefox installation is driven by selected generated artifacts' `requiredBrowsers` in [`automation-registry.mjs`](../scripts/lib/automation-registry.mjs), through [`classify-deploy-changes.ts`](../scripts/ci/classify-deploy-changes.ts); only the selected static-guards lane installs it. Do not maintain a second OG-path browser list.

[`run-pr-static-checks.ts`](../scripts/maintenance/run-pr-static-checks.ts) selects `check:html-fixture-metadata` for reserve HTML/JSON/TXT fixture edits or changes to the age checker/refresh owner. This validates capture metadata without rejecting legitimate aging during a PR; [weekly-validation.yml](../.github/workflows/weekly-validation.yml) retains `check:html-fixture-age` for the weekly age limit.

**Ethena capture access:** the [protocol capture workflow](../.github/workflows/protocol-api-mechanism-refresh.yml) runs Falcon only. Ethena remains supported through [manual capture from a permitted region](./process/protocol-api-mechanism-refresh.md#accepting-a-manual-ethena-refresh), following its restricted-HTML redirect on GitHub-hosted runners. Offline tests do not prove provider access; a supported hosted-runner access contract remains unresolved and is not a prerequisite for the Falcon-only matrix.

The static selector adds full-lockfile `check:dependency-audit -- --new-since=<baseSha>` for root package/lockfile, `.npmrc`, or audit checker/exception-policy edits; production-only `audit:deps` also runs on root dependency edits. The base is frozen `PR_BASE_SHA` when provided, otherwise the merge-base of the selected head with `origin/main`. [`verify-dependency-audit.ts`](../scripts/ci/verify-dependency-audit.ts) audits base and current lockfiles, including dev dependencies, and fails on new high/critical advisory/package pairs; pre-existing pairs print “pre-existing, tracked by weekly audit”. Missing base evidence fails explicitly. Weekly retains the full reviewed audit and package-signature check. User-approved risk acceptance reviewed 2026-10-16 covers only the exact dev-only lint-tooling graph for braces `GHSA-vfj7-8cjw-p6xm` through 2026-11-15; changed advisory identity, dependency nodes, unreviewed affected packages, or expiry fail closed. The [dependency maintenance policy](./deployment-process.md#dependency-refresh-cadence) records the no-patch rationale and removal condition.

Workflow failures surface as red GitHub Actions runs and GitHub notifications. See [Workflow incidents](./runbooks/workflow-incidents.md) for failed-leaf evidence and triage guidance.

Gitleaks self-tests use three report-validated passes: public false positives stay clean; AWS and generic API-key controls must match their expected rule/path/line. Exceptions pair reviewed paths and exact values; `.gitleaksignore` retains uncovered findings. Hunk-aware extraction preserves added source starting with `+`, excluding file headers only outside hunks. `--tree` scans combined-diff resolution additions from HEAD and every in-range merge, closing the `--no-merges` gap; any finding fails closed. Non-merge checkouts without in-range merges scan nothing.

Plain PR test shards publish `pr-test-timings-<shard>` artifacts (seven-day retention), plus wall time and slowest-first file rows in the step summary. `PR_SHARD_TIMINGS_FILE` enables `scripts/lib/shard-timing-reporter.mts`, whose per-file measurements include preparation, environment/setup, import/collection, tests, and hooks. Those aggregate costs are scheduling estimates, not wall time: compare shard wall times to spot imbalance. Missing uploads warn rather than gating. Future plans use the committed plain-test duration map in `scripts/data/pr-test-timings.json` via deterministic longest-processing-time-first partitioning in `scripts/lib/pr-test-plan.mts`. Unknown files use the map's median, or one second without measurements.

PR shard runners use the plain-test summary heading and timing artifact. Missing raw timing reports leave the result unchanged; malformed reports or publication-write errors can fail the runner.

Refresh scheduling weights after substantial suite changes or persistent shard-wall imbalance, while seven-day timing artifacts are still retained. With authenticated `gh` available, run:

```bash
node --import tsx scripts/maintenance/refresh-pr-test-timings.ts --runs=5
```

The GET/download-only refresh selects the latest successful `pull-request-checks.yml` runs in `TokenBrice/pharos-watch`, downloads only unexpired plain/legacy-coverage timing artifacts, validates successful summaries, and writes median per-file milliseconds plus run/artifact provenance to `scripts/data/pr-test-timings.json`. It runs no tests and changes no CI state. Review and commit that file so future plain partitions use the new map; increase `--runs` for a broader sample, or use `--output=<path>` to inspect a candidate without replacing the committed input. No retained plain timings is an error. Historical coverage observations and cold-start estimates are scheduling telemetry, not measured-coverage proof or an active PR coverage lane. Unknown files use their map's median (one second without measurements). New reporter samples include preparation, environment/setup, import/collection, tests, and hooks; legacy plain artifacts contain assertion spans only, so prefer post-reporter runs when refreshing.

PR full-suite cutover and timing-telemetry removal remain pending owner decision #12: measure retained-suite capacity first. Until that decision, PRs retain adaptive test selection, weighted partitions, timing uploads, and the committed duration map; nightly `test:all` is not demoted.

Local PR feedback uses the shared selectors but executes on the current branch checkout, with individually collected static leaves and unsharded uninstrumented tests. It does not reproduce hosted Actions artifact transport or production acceptance; hosted CI remains the readiness authority under [Pre-push readiness](#pre-push-readiness).

Broad UI, ops, analytics, asset-coherence, and transport smoke checks remain PR, scheduled-monitor, or explicit operator commands; they do not control production mutation or automatic rollback. The [CI deploy sequence](./deployment-process.md#ci-deploy-sequence) owns the post-merge build, deploy classifier, migration, activation-marker, release-marker, and cache-separation facts.

The [generated-artifact registry mechanics](./scripts.md#build-and-generated-artifacts) own lifecycle and automatic-staging facts; the failure playbook above owns checkability and history-input behavior, while the [CI deploy sequence](./deployment-process.md#ci-deploy-sequence) owns build and release ordering.

Telegram load protection runs in selected `check:pr:static` plans and weekly/manual via `scripts/lib/telegram-load-guard.mts`. Fan-out and all six status-reader SQL templates come from production: full lifecycle aggregate, preset followers, pending count, lifecycle events, explicit top coins, and bounded snapshot history; there is no subscriber-history fallback. Canonical family metadata supplies alert predicates. Completion scenarios include planning and delivery (SLO at 1,000 watchers; CPU, TTL and status budgets at 5,000), comparing the higher of planner and pending-drain CPU. PR tests always include the critical contracts and real workerd OG-rendering contract; `test:critical-contracts` remains a focused local runner.

Selected specialized checks:

- Cron schedule/connection changes: `npm run check:cron-sync`, `npm run check:cron-connections`, and `npm run validate:worker-scheduled-smoke`. The sync gate compares raw trigger inventories before set membership, so duplicate Wrangler or slot-plan expressions fail; the connection gate requires each job's budget row to carry the exact scheduled-slot identity.
- Shock coverage: the refresh matrix and `check-shock-coverage-freshness` use `shared/data/safety-score-v9/shock-coverage-targets.json`; the checker also verifies its derived `SHOCK_COVERAGE_TARGET_IDS`. The scheduled freshness-only check runs independently of regeneration, so an unmeasured canonical target fails rather than disappearing behind a copied list.
- Worker deployment configuration: `npm run check:worker-config` verifies that production custom domains remain root-owned and asset rules fall through.
- Structural guardrails: `npm run check:structural` runs the guard sequence owned by `package.json` in affected PR static lanes and every nightly/manual run. Raw-response body tracking follows symbols/reassignment without a source-line cutoff. SQL interpolation needs a directly preceding allowlist guard on that expression or a reviewed `SAFETY` comment, not unrelated `.has()`/throws. Runtime reachability bundles memory-sensitive mint/burn and Telegram entrypoints to exclude the full stablecoin registry. Configured roots/sources must exist and resolve a nonempty graph; scheduled policy includes `worker/src/handlers/scheduled.ts` alongside dynamic runners. Individual commands remain available for diagnosis.

- Deletion evidence is commit-scoped for `check:unused-code` artifacts:
  no deletion may cite an unused-code artifact older than the commit it is
  dispatched against. A deletion cites either an independent closure proof or
  a stamped artifact—never a stale one. The unstamped campaign artifact is
  superseded and cannot support a deletion.
  Useful test-only corpora are preserved in recognized `*.test-support.ts` files beside their owning tests, not deleted or reclassified as external-consumer blind spots. The matched Safety Score invariant corpus remains test evidence outside the evaluation-build manifest; empty unused-code DEBT maps do not prove a clean current detector scan.
- Secret-scan exceptions: `.gitleaksignore` owns the reviewed commit/path/rule/source-line fingerprints, not path-wide exemptions; comments and blanks are not exceptions. A fingerprint's line number identifies the finding's source line, not its row in the ignore file, so rearranging ignore rows does not invalidate fingerprints. Historical findings survive current-source cleanup. Delete an entry only after a full-history scan with the trusted scanner and candidate ignore file proves its removal clean; `GITLEAKS_FULL_HISTORY=1` does not expand `check:pr`'s `--local-trusted` range. Preserve the review evidence and real-secret positive controls.
  For reviewed non-secret findings that move between files or must survive rebases, `.gitleaks.toml` exceptions combine the specific rule, owner path and exact finding span; scanner self-tests must retain real-key positive controls on those same paths. The trusted local scan freezes base policy before checking candidate policy, so candidate exceptions alone cannot clear findings rejected by that base.
- Architecture boundaries: `npm run check:architecture-boundaries`, also in `check:structural`, resolves executable TypeScript dependencies using the repository tsconfig (including aliases), static imports, re-exports, literal dynamic imports, CommonJS requires/import-equals, and relative template-import expansions. Erased types and comments do not create edges. Missing modules, unresolved imports, unconstrained dynamic dependencies, and escaped require loaders fail closed. Like runtime reachability, resolved npm packages are terminal public-module boundaries, not a scan of dependency internals; aliases to packages retain canonical package identities. Local dependency chains are reported on failure.
  - Path identity: the repository root and local modules are canonicalized through filesystem real paths before applying root-relative policies or reporting dependency chains. A symlinked checkout or temporary root (including macOS `/var` → `/private/var`) must enforce the same boundaries and report the same repository-relative paths as its physical root.
  - `reserve-network`: all nested reserve-adapter modules must reach network transport through the existing `request.ts`, `defillama.ts`, or Worker `evm-rpc.ts` gateways, never bypass them to import `fetch-retry.ts` or acquire network globals. Gateway implementation safety remains owned by provider-resilience and fetch-body-timeout checks.
  - `frontend-routes`: reusable components, hooks, and libraries cannot reach `src/app`; script-consumed case-study/mechanism content stays outside route-owned directories (index re-exports remain allowed).
  - `recap-cost`: personalized recap planning cannot reach daily/weekly digest generation, AI provider modules, or network capabilities, including aliased/destructured/bracketed access.
  - `verification-url`: the analytics entry must reach the URL scrubber, whose graph excludes Zod and shared schemas.
  - `stability-light`: the lightweight PSI contract cannot reach Zod or the full shared stability schema.
  - Deletion owners: `scripts/ci/check-architecture-boundaries.ts` and its synthetic-fixture test replace the retired `fetch-guard.test.ts` (`reserve-network`), `frontend-route-boundary.test.ts` (`frontend-routes`), and `telegram-recap-cost-boundary.test.ts` (`recap-cost`) suites, plus only the source-scan cases in `src/lib/__tests__/api-key-verification-url.test.ts` (`verification-url`) and `src/lib/__tests__/api-query-descriptors.test.ts` (`stability-light`). Their behavioral tests remain.
- Test-only changes do not select structural validation.
- Generated public artifacts: `npm run check:generated-artifacts`, with individual checks in `scripts/lib/automation-registry.mjs`.
- Release-data and provider boundaries fail closed: detail snapshots tolerate only explicit 404/410 lane absence and require at least one lane for each live asset; public depeg-history generation has no fixed row floor (a quiet market legitimately shrinks its rolling 90-day window) and instead requires a full-ledger capture count, coverage back to the window start, and the requested year's source shard before writing; operator-pinned mechanism captures reject a mismatched RPC block header. The scheduled Safe Browsing monitor bounds provider time and validates successful payloads, while retaining Google's documented empty-object clean response.
- Static export SEO: `npm run seo:check` enforces unique sitemap locations, indexability against robots/googlebot `noindex`/`none` and headers, built-anchor rejection for reviewed legacy aliases, and one-hop permanent internal `_redirects`. Noindex HTML remains allowed outside the sitemap. Bounded worker threads extract pages; the parent owns global graph, sitemap, header and continuity assertions. Releases set `SEO_PREVIOUS_SITEMAP_URL` to reject lost digest/depeg URLs unless a direct 301 preserves them. Live `npm run seo:live-smoke -- --url https://pharos.watch` requires sitemap uniqueness, direct HTTP 200, robots/googlebot and `X-Robots-Tag` indexability, and self-canonical HTML; each request's 30-second deadline includes body reads. Search Console's submitted-page cohort distinguishes public recovery from intentional query, workbench, Markdown and operator exclusions; historical exclusions need a new crawl to reflect production.
- GSC offline triage: `analyze:gsc-coverage` and `analyze:gsc-performance` accept exports. Combined page/query rows populate both dimensions; separate query totals override overlapping combined queries, while unmatched combined queries remain.
- Optional render-budget probe: `node scripts/maintenance/audit-seo-render-budget.mjs --url https://pharos.watch`.

## Vitest Runtime Profiling

`npm run test:profile -- --output /tmp/pharos-vitest-profile.json` runs Vitest once with the JSON reporter, stores the raw Vitest report beside the requested output as `*.vitest.json`, and writes a durable summary to the requested `/tmp` path. The summary prints total files/tests, wall time, summed file/test time, node/jsdom split, top files, top individual tests, files above 10s, and tests above 1s.

Pass Vitest filters or options after `--` when narrowing or validating runner behavior:

```bash
npm run test:profile -- --output /tmp/pharos-src-profile.json -- --dir src
npm run test:profile -- --output /tmp/pharos-vitest-threads.json --baseline /tmp/pharos-vitest-profile.json -- --pool=threads
```

In CI, every Vitest runner that routes through `scripts/lib/vitest-ci-args.mts` — `test:pr`, `test:all`, `test:critical-contracts`, and `coverage:critical` — appends `--silent=passed-only` unless an explicit `--silent` option is supplied. Set `PHAROS_CI_VITEST_COMPACT=0` to restore full console output while debugging.

`npm run coverage:critical` also forwards trailing Vitest options to the critical suite. Use this to validate candidate pool behavior before any global `vitest.config.ts` change:

```bash
npm run coverage:critical -- --pool=threads
CRITICAL_COVERAGE_RATCHET_ALL=1 npm run coverage:critical -- --pool=threads
```

## Test Setup

[`vitest.config.ts`](../vitest.config.ts) owns projects, aliases, environments, transforms and exclusions; [`scripts/lib/critical-ownership.mts`](../scripts/lib/critical-ownership.mts) owns executable test discovery. Read those definitions before choosing a runner, rather than copying configuration into prose. Prefer the established `*.test.ts` / `*.test.tsx` convention and lane-local `__tests__/` homes; runtime discovery does not imply test-typecheck coverage.

[`scripts/test/ensure-fresh-stablecoin-artifacts.ts`](../scripts/test/ensure-fresh-stablecoin-artifacts.ts) owns catalog bootstrap. Its ignored `.cache/vitest-stablecoin-artifacts/` metadata cache is a local shortcut, not content proof: changed or missing inputs/outputs invalidate it, and deleting it forces regeneration. Clean CI generation and content checks remain authoritative.

The required release runtime is the exact `.nvmrc` Node and npm 11.x runtime. The future-major weekly typecheck is advisory, not build/test/release qualification. Keep JavaScript/TypeScript source maps and Worker per-file isolation enabled; the catalog JSON transform deliberately omits synthetic named exports and unnecessary maps to avoid retaining an oversized transform graph.

Pure Node suites may reuse processes; stateful exceptions require isolation. Worker and frontend suites retain isolation because they own module-level state; the native full-registry Safety pipeline uses its reviewed thread worker. jsdom is a per-file opt-in. If a Node suite fails only in a full run, fix module-state leakage or enroll it in the existing isolated project. Registry-mocking selector fixtures remove their mock and reset dependent modules after the suite so later snapshot census validation uses the real registry. Nested worktrees must not enter the parent checkout's corpus.

The accepted retained-pair replay case in [`replay-safety-score-v9.test.ts`](../worker/scripts/__tests__/replay-safety-score-v9.test.ts) verifies the complete embedded registry across export, replay, and rejection paths. It has an explicit 180-second per-test timeout, matching the heavy full-registry publication precedent in [`safety-score-v9-public-witness-texts.test.ts`](../worker/src/lib/__tests__/safety-score-v9-public-witness-texts.test.ts); V8 coverage and concurrent critical-suite work can push this case beyond 60 seconds. This does not change the global timeout or the separate V9 resource budgets.

The unsafe-boundary probe in [`eslint-config-ratchet.test.ts`](../scripts/__tests__/eslint-config-ratchet.test.ts) has an explicit 60-second per-test timeout for cold type-aware ESLint project initialization under coverage; it retains all unsafe-operation rejection and reviewed-decoder assertions without raising the shared default.

Optional Poppler (`pdftotext` and `pdfinfo` on `PATH`) enables RLUSD assurance PDF extraction cases; compiler/manifest parity remains unconditional without it.

Scheduled-slot topology is asserted once by [`worker/src/handlers/scheduled/__tests__/slot-registry.test.ts`](../worker/src/handlers/scheduled/__tests__/slot-registry.test.ts). Per-slot suites exercise gating/order semantics, not duplicate registry membership; state-dependent slots must still never lease an unplanned job. PSI recompute, replay and benchmark suites remain separate evidence for historical inputs, methodology-aware replay and crisis signatures.

### V9 resource lane

The `v9-resource` code lane runs once, unsharded, on its own validation runner for V9-impact PRs; nightly/manual validation consumes the same `npm run test:v9-resource` command unconditionally. The launcher runs the faithful `compute --guard` profile (all live phases observed, correctness/byte checks, and a separate natural 128 MiB run), then the independent nine-scenario contagion case at 256 MiB with coverage off and one Vitest worker. It automatically enforces `.ci/safety-score-v9-resource-budget.json` when a qualified file exists; while that file is absent, reports and summaries explicitly say **`policy: "unqualified"`** and do not assert phase budgets. An existing invalid or mismatched file is never treated as absent. Fresh invocation-bound resource evidence and the named contagion pass are required; optional historical capture checks may skip. PR artifacts retain both resource directories even on failure as `safety-score-v9-resource-<sha>-<run_id>-<run_attempt>` for 30 days, with a phase table in the job summary. Local feedback runs this once serially when selected; added cost is approximately 5–7 minutes **[INFERENCE]**.

The launcher pins the current harness revision and complete ordered phase set, not the report's own reduced declaration. Measurements share a 300-second overall deadline across bundling, fixture setup, live/natural probes and correctness children; `--deadline-seconds` may select at most 360 seconds. Every child is clamped to the remaining budget. `report.json` starts incomplete before work and is flushed between stages, retaining partial evidence and an explicit `wall-timeout` before the eight-minute lane cap. The independent contagion assertion remains 90 seconds with a 130-second child kill guard.

The V9 resource test's admission unit cases still execute in ordinary coverage. Its expensive `describe` is default-off before bundling/hooks; `test:all`, `test:pr`, and the coverage runner override an ambient `PHAROS_V9_RESOURCE_LANE=1` so coverage never spawns those probes. The dedicated launcher owns the only opt-in. Canonical, contagion and optional capture children allow only path/home/temp/locale environment values, then explicit contagion/capture protocol values; native coverage, Node preload/inspector options and ambient probe selectors are not inherited.

A heap OOM or signal from the natural 128 MiB publication child is **memory evidence**. Wall timeout, protocol/configuration failure and infrastructure cancellation are **not heap-margin evidence**. Nothing is retried away. Isolation removes contention and inherited instrumentation as variables, not proof of Workers-isolate margin.

`npm run measure:v9-resource -- --profile=compute --runs=1` remains a **non-gating Node diagnostic** unless supplied `--guard` or `--policy=.ci/safety-score-v9-resource-budget.json`. Explicit `--policy` always fails closed on a missing file; only the required lane's `--guard` mode permits an explicitly unqualified absent policy. `heavy-warm` initializes real native capture/transfer-materiality preparation roots and remains diagnostic only. Both profiles run two successive real compute publications against independent latest-schema SQLite copies: instrumented 256 MiB old-space with forced-GC phases, then uninstrumented natural-GC 128 MiB old-space. The current manifest is `post-p2`, anchored in the compact baseline loader and runner; removed decode phases are not zero-filled. The parent always writes `.tmp/safety-score-v9-resource/report.json`, including failures; ordinary measurements replace that directory. Preserve evidence elsewhere before comparison. Synthetic publication bytes remain approximately 1 MB below approximately 8 MB production, not capacity runway.

`npm run calibrate:v9-resource -- --runs=5` collects five independent live+natural compute measurements and writes **only a proposal** to `.tmp/safety-score-v9-resource/proposed-policy.json`, with distinct per-run reports and a checked-in-policy diff. It never writes `.ci/`. Review/copy only a qualified proposal: every phase must measure at most 110 MiB and all five natural 128 MiB children must succeed. Limits are `min(112 MiB, ceil256KiB(maximum + 2 MiB))`; 112 MiB is immutable. Five distinct report SHA-256s, harness/manifest, fixture identity, runner image/version (or local host description), Node/V8/esbuild/Wrangler versions and protocol fingerprint accompany it. Existing invalid policy, missing phases or identity mismatch fails closed; normal commands never adjust limits. A one-run smoke writes an unqualified proposal, not an accepted baseline.

Policy equality covers only deterministic build keys: harness/phase manifest, Node/V8/esbuild/Wrangler versions, platform/architecture, the `wrangler.heavy.toml` hash and fixture source/manifest identity. Runner image/version (including unavailable self-hosted values), package-lock/source hashes and protocol fingerprint remain recorded evidence, not reasons to reject an otherwise matching build. Calibration uses the same identity projection and prints evidence separately.

**Current qualification is blocked:** the 2026-10-15 post-P2 smoke observed `facts-compiled` at 124,994,456 bytes (approximately **119.2 MiB**), above the **110 MiB** calibration ceiling. No qualified policy is checked in. The faithful natural 128 MiB run, all phase observations and publication/correctness/byte checks are enforced instead; the live phase report remains visible but is not a green 112 MiB claim. Further remediation, including durable P3/P4 (sharding/publication-worker separation), is required before qualification; this work establishes no growth-independent memory or runway.

Expect the qualified guard to block data/listing PRs as evidence and detail grow, even without more assets. Respond with paired evidence and explicitly reviewed re-baselining **within 112 MiB**, remediation, or P3/P4; never raise caps, drop evidence or retry away failures. Node heapUsed includes more than old-space; neither post-GC samples nor the natural Node cap proves Cloudflare isolate peak safety.

## Test Infrastructure

### Sibling test-support modules

For shared test-only fixtures, harness setup, and builders, use a sibling `*.test-support.ts` module next to the owning test family. Keep assertions and test cases in the owning test files; the reference case is `worker/src/lib/__tests__/cron-leases.test-support.ts`.

The V9 resource family separates the measured `safety-score-v9-resource-probe.test-support.ts` entry from `safety-score-v9-resource-fixture.test-support.ts` setup/correctness inspection. `safety-score-v9-resource-budget.test-support.ts` owns production-config-derived bundling, fail-closed AST phase instrumentation, child isolation and diagnostic reports. Fixture generation and migration code must never enter the measured module graph; full correctness decoding runs only after children exit.

The resource diagnostic CLI's failure-mode tests live in [`worker/scripts/__tests__/measure-v9-resource.test.ts`](../worker/scripts/__tests__/measure-v9-resource.test.ts), alongside the Worker tooling entry rather than in cross-boundary root scripts.

Helpers used across test families live in the shared homes instead:

- `shared/test-utils/` — runtime-neutral helpers shared by frontend, Pages Functions, script, and Worker tests (`mock-d1`, `mock-fetch`, `latest-schema-sqlite`, stablecoin builders)
- `worker/src/test-helpers/__shared/` — Worker API/cron row fixtures, auth/request builders, and endpoint contracts
- `scripts/__tests__/helpers/` — script-suite helpers
- `functions/__tests__/helpers/` — Pages Functions helpers (`mock-kv`, Pages context, `mockUpstream(origin)` strict per-origin fetch installers)

Cross-runtime adversarial inputs live in `shared/test-utils/boundary-contract-vectors.test-support.ts`: numeric availability, scan frontiers, read outcomes and generation-bound clocks. Boundary suites specify their own expected public semantics; input sharing never supplies an oracle or replaces reviewed source/date fixtures. Existing import-based PR selection and critical ownership select these suites, not a separate lane.

A cron unit has one test home: tests for `worker/src/cron/<lane>/<module>.ts` live in that lane's own `__tests__/` directory, not in the flat `worker/src/cron/__tests__/` tree. Behaviour asserted through an adapter that is really owned by a shared executor (for example the adaptive multicall split) belongs to the shared unit's suite, with each adapter keeping only the wiring case that is adapter-specific.

A shared guard or mechanism is asserted where it is implemented, not at every route that imports it: `functions/lib/__tests__/site-data-origin.test.ts` owns the origin matrix and `functions/__tests__/upstream-proxy.test.ts` owns the response byte cap and deadline, so a proxy route suite keeps only its own wiring case.

**One unit, one home.** A production module has exactly one test file that owns its contract. Suites named after a ticket, ruling, or review wave (`R3`, `D2`, `VER-010`) are not units: fold their cases into the module's name-matched suite and delete the satellite. Keep one canonical owner per distinct observable behavior and risk boundary; redundant input permutations and implementation-only assertions may be removed with a titled evidence rationale. A satellite that exercises a *different* module reachable from the same fixture belongs to that module's owner, not to whichever suite happened to build the fixture.

Timeline and homepage tape tests share only input construction in `shared/test-utils/tape-event.ts`; secondary DEX pool inputs use `scoring-test-builders.ts` in the owning cron test family. `depeg-trust-policy.test.ts` owns the trust/reference matrix, while `depeg-helpers.test.ts` keeps provenance and DEX corroboration. `generate-safety-score-v9-evaluation-build-manifest.test.ts` owns source mutations, runtime import closure, and Worker catalog transport identity. Supply replacement ownership is proved by the persisted-row SQLite case in `snapshot-supply.test.ts`, not duplicate SQL-bind assertions.

`src/components/__tests__/table-primitives.test.tsx` owns matrix semantics, surface/viewport props, TableSourceLink external-link metadata and row-event propagation, and TableFrame surface/viewport refs and composed-ref stability; internal CSS tokens are not layout evidence. `src/lib/__tests__/design-invariants.test.ts` checks runtime font imports and styling expressions through TypeScript ASTs, excluding comments, display text and test-only files. `worker/src/lib/__tests__/depeg-resolver-assessment-store.test.ts` reads SQLite checkpoints to prove immutable thresholds, latest median/IQR updates and malformed-row quarantine.

Plan the target tree before moving a file. `assertExecutableTestFiles` in `scripts/lib/critical-ownership.mts` requires each selected test file to exist and to be selected by exactly one Vitest project, and `scripts/lib/critical-coverage.mjs` derives ownership from the surviving file's import specifiers. A `worker/` → `shared/` move therefore changes both the selecting project and the ownership edge, and can fail `npm run check:critical-coverage-completeness` even when every assertion was preserved. Merge within a tree, and run the gate after each merge.

### Frontend Test Setup Helpers (`src/test-utils/frontend.ts`)

Use [`src/test-utils/frontend.ts`](../src/test-utils/frontend.ts) for matchMedia, storage cleanup and Next Link mocks; keep a local mock only when its behavior genuinely differs. Import the Link mock inside a hoisted `vi.mock` factory. It forwards refs and ordinary anchor props; matchMedia accepts a boolean or query predicate.

### Mock D1 (`shared/test-utils/mock-d1.ts`)

Use [`shared/test-utils/mock-d1.ts`](../shared/test-utils/mock-d1.ts); unmatched SQL always throws. Prefer statement markers to broad substrings, and strict normalized matching for exact SQL contracts. A supplied `first: null` is an explicit empty result, not fallback inference.

Enable fixture match accounting: unused scenario fixtures invalidate the scenario. An `allowUnused` shared fallback must not exempt the scenario's own evidence; accounting counts selected entries, not only recorded SQL text. Telegram mocks always account for matches; use strict writes when the scenario must declare its own mutations.

Cron entrypoint suites share their existing module-specific harness. Import mocked real-module bindings after the harness, never re-exported fixture aliases (which resolve to `undefined` under Vitest 4). Cross-runtime maintenance clients use [`scripts/test-utils/d1.ts`](../scripts/test-utils/d1.ts); Pages Functions use the existing D1 harness with prepare/batch/history support.

### Reserve Adapter Harness (`worker/src/cron/reserve-adapters/__tests__/reserve-adapter.test-support.ts`)

The colocated [`reserve-adapter.test-support.ts`](../worker/src/cron/reserve-adapters/__tests__/reserve-adapter.test-support.ts) owns transport fixtures and adapter setup. Route at `globalThis.fetch`, not mocked transport implementation modules, to exercise URL/header construction, retries, body limits, parsing and ABI handling. Use the registered fetcher and real catalog config so config/registry drift is observable; run descriptor output validation, disabling it only when explicitly asserting rejection.

Unlisted network routes fail with their exact URL; a routed null RPC is a real revert, not an unmatched request. Block reads never become semantic contract calls; the harness owns request matching. Assert warning codes/effects rather than message wording. Preserve admission, failure, provenance and redemption assertions when sharing fixtures; a generic success response is not adapter evidence. Pure parser tests still call their parser directly.

Independent-assurance suites use their existing sibling test-support module and exercise registered real-engine dispatch through discovery/PDF/hash/reconciliation/output validation, not forwarder mocks. Issuer suites retain publisher-specific discovery and rewrite behavior.

#### Corpus replay gate (`__tests__/adapter-corpus.test.ts`)

[`adapter-corpus.test.ts`](../worker/src/cron/reserve-adapters/__tests__/adapter-corpus.test.ts) and its sibling test-support module own corpus enrollment. Every registered adapter needs exactly one case or a reviewed structural/backlog exemption; stale, duplicate, missing or insufficiently justified entries fail. Happy-path captures must validate, including the descriptor's allowed freshness modes; upstream drift must fail or degrade explicitly, never silently publish a fallback.

Add a captured happy-path-plus-drift case with each replayable adapter. Structural exemptions explain why replay cannot work; backlog entries name the existing behavioral owner and still owe a capture. Clearing backlog means adding that evidence, not deleting keys.

### Latest-Schema SQLite Harness (`shared/test-utils/latest-schema-sqlite.ts`)

Use [`shared/test-utils/latest-schema-sqlite.ts`](../shared/test-utils/latest-schema-sqlite.ts) for transactions, constraints, migrations and SQL publication contracts; substring mocks are not persistence proof. Apply the current migration sequence rather than hand-copying production schema. Keep migration, crash-resume, rollback and external-effect failure cases executable.

Register handles immediately through the fixture tracker and close all in `afterEach`, including initialization-failure paths. Template-restored databases remain byte-equivalent to migration replay and independent across fixtures/threads; never cache a failed template build. [`latest-schema-sqlite-equivalence.test.ts`](../worker/src/test-helpers/__tests__/latest-schema-sqlite-equivalence.test.ts) owns those guarantees. Migration-inventory tests use the uncached creator or tracker mode so every open re-reads and replays migrations.

### Mock Fetch (`shared/test-utils/mock-fetch.ts`)

Use [`shared/test-utils/mock-fetch.ts`](../shared/test-utils/mock-fetch.ts) for ordered transport fixtures; declare the exact source/response consumed by the scenario. Keep unsuccessful bodies, aborts and deadlines as distinct evidence. Outcomes construct fresh responses (explicit response objects are returned as supplied), honor abort before consuming scripted outcomes, and give `init.signal` precedence over a Request's signal. Restore installed globals after each test.

### Shared Fixtures (`worker/src/test-helpers/__shared/fixtures.ts`)

[`worker/src/test-helpers/__shared/fixtures.ts`](../worker/src/test-helpers/__shared/fixtures.ts) owns typed row builders. Read signatures/defaults there instead of maintaining a second factory table; specify scenario-specific overrides explicitly.

### Reserve HTML Fixtures (`worker/src/cron/reserve-adapters/__tests__/fixtures/*.html`)

Use the reviewed refresh-target inventory and canonical capture stamps owned by [`scripts/maintenance/refresh-reserve-html-fixtures.ts`](../scripts/maintenance/refresh-reserve-html-fixtures.ts). Refresh locally before changing parsers, never in CI; partial refresh warnings do not certify all fixtures. Archived fixtures retain their provenance obligations; removed legacy scrapers do not require executable compatibility.

[`scripts/ci/check-html-fixture-age.ts`](../scripts/ci/check-html-fixture-age.ts) separates PR metadata validation from weekly calendar-age/future-clock validation. Missing or malformed capture stamps must not become affirmative freshness. Non-archived fixtures require the canonical timestamp and bounded age; archived fixtures skip age but still reject future metadata. Deleted, archived or hand-trimmed refresh targets must not quietly escape inventory validation.

### Markdown Export Fixtures (`scripts/__tests__/fixtures/markdown/`)

[`scripts/__tests__/generate-markdown-exports.test.ts`](../scripts/__tests__/generate-markdown-exports.test.ts) compares fixtures to live renderers. Use [`scripts/maintenance/refresh-markdown-export-fixtures.ts`](../scripts/maintenance/refresh-markdown-export-fixtures.ts) locally, never in CI. A refresh can absorb an unintended renderer change: inspect the output diff and commit snapshots with their generating source rather than hand-editing them.

### Shared Auth Helpers (`worker/src/test-helpers/__shared/auth.ts`)

Use [`worker/src/test-helpers/__shared/auth.ts`](../worker/src/test-helpers/__shared/auth.ts) for auth and request builders rather than duplicating crypto stubs or URL plumbing. Keep success, rejection and unavailable evidence distinct; never weaken authenticated fixtures to bypass changed policy.

## Test Inventory

The Git index owns tracked corpus volume; ignored worktrees and generated copies must not be counted. Record the producing command and commit with any volume measurement. Use executable project discovery for runnable tests, not a second per-file roster.

[`scripts/lib/critical-coverage.mjs`](../scripts/lib/critical-coverage.mjs) discovers high-stakes candidates; [`scripts/lib/critical-ownership.mts`](../scripts/lib/critical-ownership.mts) derives importing owners. Mock-only and type-only imports do not establish behavioral ownership. Completeness, measured coverage thresholds and baseline ratchets are separate obligations: closing a waiver requires a real behavioral import and full-owner coverage measurement.

[`scripts/lib/critical-test-files.mts`](../scripts/lib/critical-test-files.mts) owns always-on contracts; [`pr-test-selection.mts`](../scripts/lib/pr-test-selection.mts) unions them with changed tests and owners. Retain real-SQL and failure-path suites even when pure helper tests are available. Colocate new tests with the owning module or established lane-local directory, and enroll production-gate contracts in executable selection rather than documenting them only here.

## Conventions

### What to test

- **Pure `shared/lib/` + `src/lib/` functions** — formatters, supply helpers, classification maps, peg-rate derivation, and frontend derivations. These are the highest-value tests: deterministic, fast, and catch regressions in shared logic.
- **Edge cases** — Keep one canonical owner per distinct observable behavior and risk boundary; redundant input permutations and implementation-only assertions may be removed with a titled evidence rationale. Retain boundary representatives for unavailable and non-finite inputs, zero, negative values, and empty inputs where they change observable behavior.
- **Boundary values** — tier boundaries in formatters (e.g., 999 vs 1000 for K suffix).
- **API contract tests** — when a worker handler has multiple response modes (different JSON shapes based on query params), add a contract test for each mode in `worker/src/api/__tests__/`. Use the shared D1 mock from `shared/test-utils/mock-d1.ts`.
- **Degraded-mode scenarios** — for cron jobs, test the normal path plus at least one failure/fallback scenario (e.g., upstream API 503, stale cache, missing data). Use `mockFetch()` to simulate API failures and `vi.useFakeTimers()` for deterministic time.

### Default test boundaries

- **Broad DOM-rendered React integration tests** — jsdom is available only when a test opts in via `// @vitest-environment jsdom` (for example `src/hooks/__tests__/use-chart-container-ready.test.tsx`). Most existing tests stay pure or use server rendering instead of full browser-like component integration.
- **API/worker handlers** — use `mockD1()` for response-shape and branch tests. When correctness depends on transactions, constraints, migrations, concurrency, or SQL semantics, use the latest-schema SQLite harness (`createLatestSchemaFixtureTracker()` with `afterEach(closeAll)`) in `shared/test-utils/latest-schema-sqlite.ts` rather than treating substring-matched mocks as persistence proof.
- **React-rendering behavior inside hooks/components** — prefer pure derivation tests and mocked query tests unless there is high-value UI coupling.
- **Full external-service integration for cron orchestrators** — orchestration tests should mock `fetch`/D1 boundaries and assert status/metadata contracts, not live upstream behavior.

### Degraded-mode testing convention

For cron jobs with external dependencies (APIs, RPC nodes), test at least:

1. **Normal path** — all external calls succeed
2. **Primary source failure** — upstream API returns 503 or times out; verify fallback behavior
3. **Stale/missing cache** — handler gets `null` from `getCache()` or data older than threshold
4. **Boundary validation** — rate bounds, supply thresholds, deviation thresholds

Use `vi.mock()` to stub external modules (stablecoin list, peg-rates, supply helpers) and `mockFetch()` to control HTTP responses. Use `vi.useFakeTimers()` when test logic depends on `Date.now()`.

### Registry Guardrails

- The [Operator CLI Contract](./scripts.md#operator-cli-contract) owns what `npm run check:cli-args-policy` verifies; `check:structural` enforces it for affected PR paths and nightly/manual validation, and it can also be run directly when CI/operator scripts change.
- `npm run audit:coverage -- --domain=oracle-risk` always blocks on missing or structurally incomplete CDP oracle profiles and required branch evidence. The retired `--advisory` option is rejected, including through the generic coverage-audit wrapper, which forwards child arguments and propagates failures.
- Oracle stale-review reminders and the reviewed applicability queue remain advisory findings, not a structural exit-success bypass. `--stale-days=<positive integer>` controls the reminder age (default: 180 days). Explicit unresolved dispositions remain V9 blockers rather than silently passing as profile-only evidence; the shared stablecoin-data analyzer stays blocking independently.
- `src/lib/__tests__/term-markup.test.ts` owns valid glossary-marker parsing and stripping to visible labels as an ordinary noncritical runtime-parser test, plus authored AI-summary corpus integrity: known glossary slugs and no raw opening/closing markers.
- Mechanism routing is covered by ordinary noncritical domain tests: `src/app/__tests__/static-content-route-contracts.test.tsx` owns exact registered static params, and `src/app/__tests__/sitemap-frozen.test.ts` owns equality with the canonical public route inventory. OG images remain generated-artifact-owned.
- `shared/lib/selector/__tests__/editorial-policy.test.ts` owns the Selector banned-phrase rule matrix and complete editorial corpus as an ordinary noncritical domain test, including Picker route/component copy and checked-in worked examples.
- `npm run check:stablecoin-data` has an advisory warning lane alongside its blocking errors. Warnings print to stdout, do not increment the error count, and never fail the gate; the footer reports `OK (N warning(s))`. It currently carries the collateral-prose drift report (`shared/lib/stablecoins/collateral-prose-reserve-drift.ts`), which flags a `collateral` string naming a tracked ticker that appears in no reviewed reserve slice. It is advisory by design: legitimate prose names non-reserve entities constantly — look-through naming and prose-vs-slice taxonomy differences are the noise floor — so only clauses carrying eligibility modality are reported per coin, and the rest collapse to a single count. Treat a new tier-1 warning as curation work, not a build break.
- `scripts/__tests__/weekly-curation-digest.test.ts` owns summary staleness and missing-summary reporting at the 180-day boundary, finite empty-cohort percentages, and absent annotation-queue evidence. It does not enforce authored-catalog one-liner, archetype, or attestor-tier floors.
- `npm run audit:coverage -- --domain=redemption-backstops` validates the redemption-backstop registry split across `shared/lib/redemption-backstop-configs/*`, catches duplicate IDs across modules, enforces allowed route-family membership per module, and keeps the headline counts in `docs/redemption-backstops.md` synced to the real registry.
- `npm run audit:coverage -- --domain=redemption-coverage` unconditionally evaluates source-reviewed dispositions for active unconfigured assets in `shared/data/coverage-dispositions/redemption-coverage-dispositions.ts`, with or without `--check`. It rejects missing, duplicate, unknown, inactive, configured-stale, and malformed reviews and ranks the queue by canonical market-cap order. `--check` changes presentation only; a reviewed nonzero backlog passes either mode. `--strict-active-gaps` independently escalates active gaps. Backlog size is curation work, not a merge failure.
- `worker/src/lib/__tests__/redemption-backstops-store.test.ts` now covers completed-run snapshot manifests for `redemption_backstop_runs`, including generation-filtered reads and current/history rows written with `snapshot_run_id`.
- Telegram callback suites are grouped by concern, not by ticket: `telegram-webhook-callbacks-settings.test.ts` owns settings, coin snooze and timezone callbacks; `telegram-webhook-callbacks-usage-analytics.test.ts` owns usage analytics and discoverability; `telegram-webhook-callbacks.test.ts` owns disambiguation and forget confirmations. Mocked pending-confirmation reads use `pendingDisambiguationTable(row)` from `worker/src/api/__tests__/telegram-rows.test-support.ts` rather than a hand-written table literal.
- The Telegram cron suites assert persisted rows, not statement text. `telegram-pending-queue.test.ts` owns enqueue/handoff collision semantics against real SQLite, and the pending-queue drain cases read `telegram_pending_alerts`, `telegram_subscribers` and `telegram_alert_dead_letters` back instead of pinning SQL fragments or bind indexes. `worker/src/cron/__tests__/` holds no snapshot artifact; retention-cleanup metadata is asserted with explicit counters.
- Telegram webhook units live with their handler concern: `telegram-webhook-messages.test.ts` owns every message/keyboard builder (status lines, safety provenance, HTML escaping, compact USD formatting), `telegram-webhook-parsing.test.ts` owns command parsing and ticker resolution, and `telegram-webhook-rate-limits-commands.test.ts` owns command rate limiting including the per-chat flood cap. Route-handler contexts come from `routeContextFactory()` in `worker/src/test-helpers/__shared/routes.ts`; the weekly-recap input-data suite owns both the candidate aggregation and the safety-identity cases over one fixture header.
- Supplemental commodity supply has one freshness home: `worker/src/cron/sync-stablecoins/supplemental-assets/__tests__/commodity-supply.test.ts` owns the shared market-cap/supply observation policy for every commodity lane, and each lane's own suite (`gold.test.ts`) keeps only its allocation cases.

### Test-lane gate protocol

A commit that deletes, renames, or merges test files carries the gate artifacts those files appear in, in the same commit:

- **Provider resilience** — `scripts/lib/provider-resilience-registry.mjs` lists exact `tests` paths per surface; a renamed or deleted path fails `npm run check:provider-resilience` with `missing-test-file`.
- **Critical ownership** — `scripts/lib/critical-ownership.mts` derives source-to-test ownership from each test's import specifiers, so a merge that removes the last importing test for an enrolled source silently drops ownership. Run `npm run check:critical-coverage-completeness` and confirm every source the deleted tests imported still has an importing test; do not close the gap with a waiver.
- **Executable test selection** — `assertExecutableTestFiles` requires every selected path to exist and to belong to exactly one Vitest project, so a deleted or moved entry of `CRITICAL_CONTRACT_TEST_FILES` / `ALWAYS_RUN_TEST_FILES` in `scripts/lib/critical-test-files.mts` fails selection before any suite runs. A cross-tree merge (for example `worker/` into `shared/`) can trip this even when coverage is preserved; move the entry with the file.

Coverage floors are maintained by the weekly measured gate. During the cleanup transition, explicitly listed floors may be lowered only through one reviewed, recorded rebaseline with full `CRITICAL_COVERAGE_RATCHET_ALL=1` measurements before and after, per-file rationale, owner approval and review, and a named surviving behavioral owner for every decrease of at least 1.0 percentage point or protected behavior. The record expires at its `transitionExpiresAt`; afterwards the ordinary no-regression rule resumes. No waiver or enumerated path is relaxed to accommodate a deletion; enumerated paths migrate in the same commit.

### Test style

- Use `describe` per function, `it` per behavior.
- Test names describe the behavior, not the implementation: `"returns null for undefined input"` not `"calls sumPegBucketsOrNull with undefined"`.
- Use `makeStablecoin()` / `makeStablecoinMeta()` from `shared/test-utils/stablecoin.ts` (see `shared/lib/__tests__/supply.test.ts`) for partial `StablecoinData` mocks — avoids `as any` casts.
- Use shared fixtures from `worker/src/test-helpers/__shared/fixtures.ts` for DB row mocks.
- Keep tests focused: one assertion per `it` block when possible.
- Keep one canonical test home per unit concern. Keep one canonical owner per distinct observable behavior and risk boundary; redundant input permutations and implementation-only assertions may be removed with a titled evidence rationale. Split very large suites only along cohesive `describe` seams; do not create ticket-named satellite suites or fixture-only alias layers. A merge picks its target tree so the merged suite still resolves its sources under the [test-lane gate protocol](#test-lane-gate-protocol): the surviving file must import every source it now owns and belong to exactly one Vitest project.
- Drive repeated scenario scaffolding from one `it.each` table instead of copying the setup per `it`. Keep one canonical owner per distinct observable behavior and risk boundary; redundant input permutations and implementation-only assertions may be removed with a titled evidence rationale.
- Share genuinely repeated fixture construction through sibling `*.test-support.ts` modules; keep scenario-specific inputs, assertions and exact-source imports in the owning tests. Independent expected deployment identities, transport payloads and strict SQL expectations must not be derived from the production values they validate merely to reduce a clone allowance.
- Mock lazily loaded frontend sections by module (`vi.mock("./detail-lazy-sections", …)` with one stub per exported section name), never by `next/dynamic` loader source text or `dynamic()` call order — an ordering-keyed mock silently mis-assigns stubs when a section is added or reordered.

### Test evidence rules

The 2026 test audit enforced these rules across the suite; apply them to new and edited tests:

- **Assert consumer-observable behavior.** A test earns its place by failing when something a consumer observes regresses — a return value, rendered output, or persisted state — not when an internal detail changes.
- **Assert database outcomes, not statement shape.** SQL text, placeholder order, bind indexes, and prepared-call counts are implementation details. Seed the latest-schema SQLite fixture, run the unit, and select the persisted row by semantic column; use marker-matched strict D1 doubles only when the test does not depend on SQL semantics. Query-plan assertions are reserved for cases where index choice is itself the contract.
- **Prefer registry invariants to registry transcriptions.** Assert that every entry is retrievable by its own key and satisfies cross-row or cross-module constraints; do not copy authored keys, ordering, or row fields into expected-value tables.
- **No source-text, class-token, or prose pins.** Unit tests do not pin source strings, CSS class tokens, or editorial prose; such assertions churn on harmless edits while missing real regressions. Styling and layout claims belong in browser coverage, and source-structure scanning stays in its syntax-aware owner.
- **`test.fails` only with an `// audit:` comment.** An `it.fails`/`test.fails` marker must carry an adjacent `// audit: <finding> — <explanation>` comment recording the disputed or policy-deferred production defect it reproduces; it pins known-wrong current behavior and is never a way to leave a broken assertion green.
- **Deletions name their evidence.** Protected behaviors require a named surviving path and exact test title. Nonprotected tests/fixtures may be deleted with a reviewed META-TOOLING, DEAD-SUBJECT, TYPE-RESTATE, INCIDENTAL, or duplicate-behavior rationale stating remaining detection paths.

## Coverage

Full-suite coverage threshold is not enforced. The weekly critical gate applies a 40% default plus explicit per-file line floors ranging from 30% to 70%, 40% branch/error-path floors at provider, authentication, scoring, and publication boundaries, and an all-source no-regression ratchet. PRs enforce behavioral ownership (`check:critical-coverage-completeness`) and execution, not measured percentages. Run `npm test -- --coverage` to generate a detailed report. The V8 provider generates both text output and an `lcov` report for CI integration.

### Critical Coverage Gate

CI **does not** run a full-suite coverage gate. The weekly/manual all-critical ratchet is the sole measured-coverage execution; PRs run the adaptively selected retained tests, including the always-run contracts and affected critical owners, without instrumentation. Full-suite PR selection remains pending an owner decision. The weekly measurement executes the full derived critical-owner test set against the checked-in baseline. Tests owning other critical sources can exercise a source indirectly:

The [V9 resource lane](#v9-resource-lane) keeps admission unit coverage here while isolating expensive probes and their environment from ordinary and coverage runners.

- `critical-coverage.mjs` scans high-stakes source roots and applies the existing candidate path rules. `CRITICAL_FILES` is the generated intersection of those candidates and sources imported by tests; there is no hand-maintained source enrollment list.
- `critical-ownership.mts` resolves executable static imports and quoted dynamic `import(...)` calls (including `@/`, `@shared/`, and relative paths) to repository files and records every importing test. Mock-only `vi.mock` references and type-only imports are not ownership evidence. `CRITICAL_OWNERSHIP_WAIVERS` records each reviewed no-owner gap with a reason and `reviewAfter` date; `check:critical-coverage-completeness` fails for any new unowned candidate or any explicitly enrolled source without an owner. Ownership waivers are distinct from reviewed coverage-denominator exclusions: neither ledger proves measured coverage.
- Draining an ownership waiver requires a used exact-source import in a behavioral test. Imports through a barrel do not enroll its re-exported implementations: move the exercised function import to the implementation or add a direct consumer contract, preserving existing higher-level assertions. Registry reviews should exercise admission/expiry boundaries rather than transcribe authored rows; store readers should assert semantic results against the latest-schema SQLite fixture. Retained gaps keep their review date and a dated, path-specific evidence rationale; ownership removal never substitutes for measured coverage or permits lowering its floors.
- Pure fact builders can use admitted fixed-input and extension fixtures with an asset build context rather than mocking the compiler. Their direct contracts should distinguish missing from measured zero, preserve observed values and provenance through stale/unavailable paths, reject nonconserving partitions, and exercise freshness and exact-active-set boundaries.
- Bridge tier factors must reject unregistered exact research sources rather than borrowing whole-profile evidence. Bridge aggregation must retain unknown incident disposition until a downstream independently scoped incident review supplies an outcome, including when every route/controller is otherwise reviewed; test both deployment and representation-group aggregation.
- Depeg lane ownership contracts directly exercise hydration's open-book saturation/native-cache writes, native quote mutation vetoes, option normalization, consumer freshness/expiry budgets, assessment/review partial persistence and cancellation, and public methodology observation clocks. Durable outcomes use the latest-schema SQLite harness with the real stores; an unavailable required read is not an empty successful book.
- `CRITICAL_COVERAGE_WAIVERS` is a separate denominator policy for genuine forwarding/configuration facades, not a missing-test backlog. Every retained entry names its rationale, unchanged `reviewAfter` date, enrolled implementation `owner`, and executable importing `ownerTest`. Completeness rejects a missing rationale, an implementation no longer enrolled, or a test that no longer imports that implementation. A facade gaining runtime decisions must gain its own behavioral contract and leave the exclusion set; changing/deleting its implementation or owner test triggers a new path-specific review, not automatic date renewal.
- The weekly/manual gate runs the full derived critical-owner suite with `CRITICAL_COVERAGE_RATCHET_ALL=1`, enforcing line and branch floors, missing-source checks, and the no-regression ratchet across the full source set. PRs retain completeness and uninstrumented test execution, not coverage shards or a merge gate.
- CI critical coverage defaults to four Vitest workers; the unsharded local runner uses half the available parallelism, bounded to four through eight. Per-file `--coverage.include` flags limit V8 remapping so unrelated loaded modules do not inflate the report.
- Parses `coverage/lcov.info` and applies `CRITICAL_COVERAGE_THRESHOLD` (default 40%) to the selected coverage scope, unless a per-file line override applies.
- Applies explicit per-file line minimums and 40% branch/error-path floors at provider, authentication, scoring, and publication boundaries.
- Applies the all-source no-regression ratchet using `.ci/critical-coverage-baseline.json`. A missing baseline file (including a configured `CRITICAL_COVERAGE_BASELINE_FILE`) fails the ordinary check, never silently disables the ratchet. Missing, nonnumeric, out-of-range, or below-enforced-floor entries for the derived enrolled set also fail. Bootstrap or refresh is a separate explicit maintenance operation via `scripts/maintenance/update-critical-coverage-baseline.ts`, not a checker fallback. Any decreased floor requires a matching committed record under `.ci/critical-coverage-rebaseline/` against a valid comparison base.
- `--completeness` also compares the committed base baseline without requiring LCOV, so PR floor decreases cannot bypass reviewed-record validation when measured coverage is deferred to the weekly gate. An explicit `CRITICAL_COVERAGE_COMPARE_REF`, `PR_BASE_SHA`, or `GITHUB_BASE_SHA` selects the comparison base; CI otherwise uses the shared Git base resolver. Local static/readiness runners pass their frozen base and head to completeness. Direct completeness and measured runs without a comparison base, or with an all-zero or invalid ref, fail closed; set a real comparison ref before rerunning.
- The decoded coverage baseline must be a non-null JSON record; if it has a `files` envelope, that value must also be a non-null record. JSON `null`, arrays, primitives, and malformed envelopes fail nonzero before threshold checks rather than bypassing the gate.
- Runs ordinary coverage and ownership waivers through the same review queue: due reviews are advisory for 30 days, while invalid metadata, stale entries, and reviews beyond that grace period fail completeness.

Baseline maintenance requires a complete `coverage/lcov.info` for the current derived source set. Use `CRITICAL_COVERAGE_RATCHET_ALL=1 npm run coverage:critical` before `npm run coverage:critical:update-baseline`; do not refresh from a partial report. Ordinary maintenance preserves the maximum of each retained source's existing floor and new rounded measurement; it can remove older entries outside today's candidate rules but cannot lower an existing floor. The explicit `--rebaseline=.ci/critical-coverage-rebaseline/<wave-id>.json` mode permits the reviewed cleanup transition only: commit the version-1 record with the baseline change, naming frozen base/candidate SHAs, full before/after measurement command and LCOV SHA-256 digests, run URL (or null for local), owner approval, reviewer, approval/expiry timestamps, and exactly the decreased sources. Every entry records previous and measured floors, configured line minimum, unchanged branch floor (null where none is configured), removed test paths/titles, surviving owner paths/exact titles, protected class, and a rationale of at most 300 characters. New floors must equal measured-after coverage and remain at or above configured minima; every decrease of at least 1.0 percentage point or protected class needs a surviving owner. Expired records fail closed. Review against the branch's local base: add measured enrollments, remove only deleted or demonstrably non-critical sources, and otherwise preserve every existing floor. Outside the reviewed transition, restore behavioral coverage rather than accepting a lower measurement. A first enrollment run can pass all tests but fail baseline validation until the measured additions are recorded; rerun the ordinary coverage checker after the update.

The GitHub PR gate runs completeness and the retained uninstrumented tests, not measured coverage. Weekly/manual execution owns measured percentages and the all-critical ratchet. Use `npm run coverage:critical` directly for custom `CRITICAL_COVERAGE_*` controls.

Gate scripts and ownership:

- `scripts/lib/critical-ownership.mts` owns generated source-to-test ownership and the dated cutover gap waivers.
- `scripts/lib/critical-test-files.mts` owns the always-on contract set and builds the full critical-owner Vitest arguments from ownership.
- `scripts/lib/critical-coverage.mjs` owns candidate discovery and the generated enrolled source set.
- `scripts/ci/check-critical-coverage.ts` owns threshold parsing, completeness enforcement, explicit per-file overrides, and touched-source ratchets.
- `scripts/lib/critical-coverage-rebaseline.mts` validates reviewed rebaseline records for both the checker and explicit maintenance mode.

Useful env controls:

- `CRITICAL_COVERAGE_THRESHOLD`
- `CRITICAL_COVERAGE_COMPARE_REF`
- `CRITICAL_COVERAGE_CHANGED_FILES`
- `CRITICAL_COVERAGE_RATCHET_TOLERANCE`
- `CRITICAL_COVERAGE_RATCHET_ALL`
- `CRITICAL_COVERAGE_BASELINE_FILE`
- Per-file line overrides: `CRITICAL_COVERAGE_THRESHOLD_AUTH`, `CRITICAL_COVERAGE_THRESHOLD_EVM_RPC`, `CRITICAL_COVERAGE_THRESHOLD_STABLECOINS_CACHE`, `CRITICAL_COVERAGE_THRESHOLD_SAFETY_SCORES`, `CRITICAL_COVERAGE_THRESHOLD_SCHEDULED`, `CRITICAL_COVERAGE_THRESHOLD_DAILY_DIGEST`, `CRITICAL_COVERAGE_THRESHOLD_STABLECOIN_DETAIL`, `CRITICAL_COVERAGE_THRESHOLD_HEALTH`, `CRITICAL_COVERAGE_THRESHOLD_STATUS`, `CRITICAL_COVERAGE_THRESHOLD_DEX_ORCHESTRATOR`, `CRITICAL_COVERAGE_THRESHOLD_API_PAGINATION`
- Branch-floor overrides: `CRITICAL_COVERAGE_BRANCH_THRESHOLD_AUTH`, `CRITICAL_COVERAGE_BRANCH_THRESHOLD_EVM_RPC`, `CRITICAL_COVERAGE_BRANCH_THRESHOLD_SAFETY_SCORES`, `CRITICAL_COVERAGE_BRANCH_THRESHOLD_PRICE_PUBLICATION_STATE`

Selected files have explicit threshold overrides in `scripts/ci/check-critical-coverage.ts`; keep that map as the source of truth instead of duplicating override values in prose.

### Critical Test Suites

- [Production Canaries](../.github/workflows/production-canaries.yml) runs daily at 06:37 UTC and on manual dispatch, with independent jobs for authenticated full API contracts (including three OG PNG routes), live Pages asset checks in Chromium, and HTTP-to-HTTPS API transport. API and Pages probes use the existing `PHAROS_API_KEY` repository secret; API smoke requires a key, so missing credentials cannot silently skip protected contracts. Any failed command fails its job/run and surfaces through GitHub Actions notifications; this read-only monitor does not deploy, roll back, or replace post-deploy acceptance.
- `npm run test:critical-contracts` runs `CRITICAL_CONTRACT_TEST_FILES`; `npm run test:pr` starts with `ALWAYS_RUN_TEST_FILES` (both owned by `scripts/lib/critical-test-files.mts`), then adds dependency-selected tests, affected critical owners, and declared `testOwnership` suites.
- `npm run check:pr -- --base=<ref>` runs the adaptive local PR contract against a committed diff.
- `npm run check:release` performs the optional full Pages build/static checks and credential-free Worker bundle proof.
- `npm run test:all` runs the complete suite; `npm run test:pr -- --base=<ref>` runs critical plus dependency-selected tests.
- `npm run test:smoke-api` checks `/api/health` plus either the strict endpoint contract set or its deploy-canary subset.
- `npm run test:smoke-ops` checks the Access-protected operator UI/API surfaces and their same-origin proxy where an authenticated session is available.
- `npm run test:smoke-transport` verifies that public HTTP API origins upgrade to the exact HTTPS host, path, and query.
- `npm run test:smoke-ui` covers hydrated browser paths, analytics, first-party data, and responsive overflow; `npm run test:smoke-ui:mobile` checks tracked route identity, geometry, and control size. Canonical slashes are equivalent; only coin-preserving Yield fallbacks are intentional redirects. [Deployment Process](./deployment-process.md#ci-deploy-sequence) owns production scope and ordering.
- `npm run test:smoke-pages-assets` checks top-ranked Yield routes and source-family canaries (`scripts/lib/pages-asset-smoke.mjs`) for HTML/script MIME, first-party assets, and fatal errors. Both fetch and browser passes require the requested route or `/yield/` with preserved query overrides and coin-specific `compare`, `from`, and `workbenchFallback` defaults. Warm-cache canaries repeat navigation; `--mode live` rejects stale-serving HTML cache directives.
- `npm run validate:pages-smoke` runs desktop, mobile and Pages-assets smokes against one built `out/`; missing output, occupied explicit ports, and early child error/exit fail. Readiness requires the owned export server's startup marker before HTTP probing, never an unrelated listener. `PAGES_SMOKE_INCLUDE_MOBILE=0` omits only this wrapper's mobile smoke.

## Adding a New Test

Colocate with the owning module or established lane-local test directory. Frontend imports use canonical frontend/shared boundaries; Worker imports stay relative. Shared scaffolding follows the [sibling test-support module convention](#sibling-test-support-modules).

API contracts validate response schemas and use existing typed row fixtures. Cron contracts assert normal/degraded reasons, unavailable inputs, no optimistic publication and retained last-good state. No-throw or defined-return assertions are not degraded-mode evidence; SQL publication tests assert retained rows and absence of new writes in real SQLite.

Use the actual [`blacklist.test.ts`](../worker/src/api/__tests__/blacklist.test.ts) and [`snapshot-psi.test.ts`](../worker/src/cron/__tests__/snapshot-psi.test.ts) behavioral owners as examples, not copied tutorial tests. Run the owning file and [focused feedback](#smallest-adequate-check-per-area) during authoring; [readiness](#pre-push-readiness) remains a separate contract.

## ESLint Configuration

[`eslint.config.mjs`](../eslint.config.mjs) and [`eslint.typed.config.mjs`](../eslint.typed.config.mjs) own scopes, rules and exclusions; do not duplicate their rule tables, allowlists or ignored-path arrays. Typed unsafe-value and promise rules remain blocking in configured scopes. Decode external data as `unknown` and validate it at the typed boundary.

`Array.isArray` narrows an unknown collection to `any[]`, not validated elements. Keep decoded elements in an `unknown[]` view and narrow each member with the owning record guards or schema before accessing it; preserve existing element types on already-typed readonly collections. Explicitly parameterize empty `Map` and length-only `Array` constructors so their storage cannot introduce implicit `any`.

Typed-lint regression probes use `ESLint.lintText` with an existing in-scope project member and disable automatic single-run inference so the parser typechecks the supplied text even when `CI=true`. Never create transient fixtures under `src/`: concurrent readiness scanners can enumerate them before cleanup and then fail when the files disappear.

Suppressions require a scoped justification, never a blanket subsystem exemption. Flat-config rule options replace rather than merge; use existing composed constants when extending restrictions. Import boundaries, nullable supply admission and React purity remain governed by the root rules and their executable lint authorities.

### Zod Runtime Validation

Schema validation in hooks flows from each endpoint descriptor's `schema` through `useRegisteredApiQuery`; in `src/hooks/api-hooks.ts`, meta responses use `createApiPollingQueryOptionsWithMeta` and are normalized with `unwrapApiQueryWithMetaResult`. Use `rg "schema:" src/hooks src/lib` for the live callsite and schema set before adding or auditing endpoint validation; do not maintain a second response-schema inventory here.

When a schema is provided, frontend API helpers now validate in `strict` mode by default and throw on schema mismatch. Use `contractMode: "warn"` only for explicitly degraded surfaces where returning raw data is acceptable.

When adding a new API endpoint:

1. If the response has nested arrays or objects accessed via `.find()` / `.map()`, define its schema in the owning `shared/types/` module (for example `shared/types/peg.ts`); `shared/types/index.ts` is the re-export barrel, not the schema implementation home.
2. Attach the response schema to the descriptor consumed by `useRegisteredApiQuery`
3. Add a contract test in `worker/src/api/__tests__/` if the endpoint has multiple response modes

**Narrow-type gotcha:** If your response type uses string unions or branded types (e.g. `ReportCardGrade`), prefer the shared hand-written interfaces and keep any unavoidable schema wiring/casts localized in the consolidated hook module (`src/hooks/api-hooks.ts`).

**Worker CI note:** Schema modules re-exported by `shared/types/index.ts` use `zod`; Worker typing resolves shared modules via `@shared/*` in selected PR static checks and nightly validation. Root `npm ci` installs workspace dependencies so shared imports resolve from root `node_modules/`. A new package imported by shared code needs no duplicate `worker/package.json` entry unless a Worker-local runtime/deploy path genuinely requires it.
