# Testing & Linting

> **Agent navigation** — Grep the heading you need instead of reading wholesale: Overview · [Pre-push readiness](#pre-push-readiness) · Commands · [Smallest adequate check per area](#smallest-adequate-check-per-area) · [Generated-artifact failure playbook](#generated-artifact-failure-playbook) · Source Formatting Policy · CI Pipeline · Vitest Runtime Profiling · Test Setup · Test Infrastructure · Test Inventory · Conventions · [Test-lane gate protocol](#test-lane-gate-protocol) · Coverage · Adding a New Test · ESLint Configuration.

## Overview

The project uses **Vitest** for unit tests and **ESLint** (via `eslint-config-next`) for linting. The shared validation suite runs on pull requests; the [release snapshot state machine](./deployment-process.md#release-snapshot-state-machine) owns protected-`main` and post-merge behavior.

## Pre-push readiness

Before **every** authorized first or replacement push, use this order on the final committed source and integration history. Focused checks are authoring feedback, never readiness proof; there is no batch-size exemption or pre-push gate hook.

```sh
# Activate mise shims in this shell; let them read the repository's .nvmrc.
export PATH="${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims:$PATH"
mise settings add idiomatic_version_file_enable_tools node
mise install
node --version
npm --version

git fetch origin +refs/heads/main:refs/remotes/origin/main

# Finish and commit the final source/integration changes before convergence.
git add <final-source-paths>
git commit -m "<describe the causal change>"

npm run check:generated-artifacts
# If it fails, run the reported artifact's owning generator, commit its
# source/output changes, and rerun this FULL command until it passes.

npm run check:pr
```

The last command must be **plain**, without skip/filter/plan-only/no-fetch flags or selection overrides. Require a fresh passing `.tmp/pr-check-receipts/<HEAD>.json` for the current committed HEAD before pushing; an exit code alone is insufficient. Any subsequent source, generated-output, or integration commit invalidates that proof: repeat full convergence and readiness. The runtime guard requires the exact `.nvmrc` Node and npm 11.x, not merely an engine-compatible major. Runtime and receipt mechanics are owned by [`runtime-guard.mts`](../scripts/lib/runtime-guard.mts), [`run-pr-checks.ts`](../scripts/maintenance/run-pr-checks.ts), and [`pr-check-receipt.mts`](../scripts/lib/pr-check-receipt.mts); generated owners live in [`automation-registry.mjs`](../scripts/lib/automation-registry.mjs).

Plain readiness runs the secret, docs, static and selected-test leaves locally. The classifier-selected `critical-coverage` and `pages-artifact` lanes are CI-owned: GitHub runs them on separate runners (up to eight coverage shards and a dedicated Pages job) and keeps them required, while the local receipt records them as `deferred-to-ci` without making it incomplete. One workstation runs them serially, so they took 3.5–7.5 min and 1.5 min of each 8–10 min local run. Add `--with-coverage` after a remote coverage-ratchet failure or when changing coverage floors, and `--with-pages` after a remote Pages build/size/SEO failure or when changing those budgets.

Additionally run `npm run check:pr -- --ci-parity` after a remote failure that plain local readiness did not reproduce, and for lockfile/setup/security-policy changes. This is an opt-in clean-merge rehearsal, not a replacement for the mandatory plain command. `--plan` (or focused `--plan-only`) is never proof. End-to-end readiness/parity costs are **unmeasured** here: per-leaf receipt durations are observations for that run, while committed shard timing weights are scheduling estimates, not a promised runtime.

When CI fails, collect **every failed leaf**, fix all failures in one causal revision, rerun full convergence and plain readiness (plus parity when applicable), then push once. Use the [workflow incident runbook](./runbooks/workflow-incidents.md) for remote evidence and incident handling.

## Commands

Use the [validation command index](./scripts.md#validation-command-index) for command entrypoints and their canonical owners; this section owns what those validation lanes do.

`check:pr` is the adaptive local PR contract, implemented by [`scripts/maintenance/run-pr-checks.ts`](../scripts/maintenance/run-pr-checks.ts). After the pinned runtime guard it refreshes `origin/main` by default, resolves frozen base/head identities, and rejects `--head` unless it resolves to checked-out HEAD; `--staged` is rejected because checks inspect the checkout, not the index. Plain mode permits authoring checks on dirty tracked or untracked state (respecting `.gitignore`), but successful leaves yield an incomplete receipt with reason `dirty-worktree`, never passing readiness proof; commit final edits before readiness. `--no-fetch` or `PHAROS_PR_NO_FETCH=1` skips fetching; a failed refresh or a stale base with fetching disabled weakens the receipt. The runner warns when the base commit is over 24 hours old.

[`pr-lanes.mts`](../scripts/lib/pr-lanes.mts) owns lane commands, selectors, shard limits, and timeouts for the local runner and generated Actions matrix. Local tests and opted-in critical coverage are unsharded; the static plan is expanded into individual leaves. Leaves run as two concurrent serial tracks — Vitest (`pr-tests`, then `critical-coverage` when opted in) and the secret/docs/static leaves — followed by an opted-in `pages-artifact` alone, because it overlays release data into the checkout and deletes `.next`/`out`. When `critical-coverage` runs it executes every critical-owner test file, so local `pr-tests` receives `PR_TESTS_DEFER_CRITICAL_OWNERS=1` and skips those files instead of running them twice. Every independent selected leaf runs even after another fails or throws, then the final table reports status, milliseconds, command, and first actionable error in plan order. Internal-docs-only changes select docs instead of static/tests. Mixed changes reuse the classifier's `docsChanged` predicate, not a separate “any Markdown” selector; when docs owns doc-sync, static receives `--skip-doc-sync`. Standalone static retains its source-owned doc-sync checks. Pages-impact changes select the representative Pages artifact check, deferred to CI unless `--with-pages` is passed.

The trusted local secret contract is `runLocalTrustedGitleaks`, also exposed as `node --import tsx scripts/ci/run-gitleaks.ts --local-trusted --base=<full-sha> --head=<full-sha>`. It materializes the committed base scanner/import closure and policy, runs trusted range and merge-resolution scans, then checks committed candidate scanner/policy when changed; candidate success cannot replace trusted scans. It uses a temporary detached scan repository with read-only object alternates and redacted scanner output. It **does not scan uncommitted edits** or synthesize GitHub's PR merge in plain mode; the local synthetic merge is covered only in parity mode. Exit codes are 0 clean, 1 findings, and 2 usage/setup errors. Source: [`run-gitleaks.ts`](../scripts/ci/run-gitleaks.ts).

Receipt schema version 1 records Node/npm, base/head SHAs, tree cleanliness, invocation flags, `weakened`, optional `incompleteReasons`, timestamps, and leaves (`passed`, `failed`, `skipped`, `not-selected`, `deferred-to-ci`, duration, optional first error); parity adds mode and merge SHA/tree. [`pr-check-receipt.mts`](../scripts/lib/pr-check-receipt.mts) writes `.tmp/pr-check-receipts/<headSha>.json`: any failed leaf makes `outcome=failed`; otherwise dirty tracked or untracked state, weakening, or skipped required leaves makes `incomplete`; only complete execution on a clean tree is `passed`. `deferred-to-ci` leaves are CI-owned lanes this run did not opt into; they do not affect the outcome. Dirty state records `dirty-worktree` in `incompleteReasons`. Forwarded test filters/options and `--plan` weaken plain runs; `--with-coverage`/`--with-pages` do not. Incomplete runs can exit 0 and are not readiness proof; setup/runtime failures replace an older receipt when HEAD can be resolved.

`npm run check:pr -- --plan` prints selected lanes/commands, test files and CI partitions, critical owners, refs, and limitations without executing checks or fetching. Test discovery may import modules. Its skipped leaves make the receipt incomplete. `--json` selects the machine-readable gate report, with progress on stderr; its execution `status` matches the authoritative receipt outcome, including `incomplete` for dirty or weakened runs.

[`run-ci-parity.ts`](../scripts/maintenance/run-ci-parity.ts) guards runtime, rejects dirty tracked files/shallow history, fetches and freezes latest main and committed branch HEAD, creates an independent full-history clone (never a worktree or a copy of ignored/env files), and constructs a detached merge with separate base/head/merge/tree identities. It performs `npm ci`, generated/history bootstrap and tracked-output immutability, requires ripgrep and selected Playwright Firefox/system dependencies, then executes trusted scans, frozen-ref classification, static/docs leaves, explicit CI test partitions, coverage shard/merge completeness and touched ratchets, and selected Pages artifacts. Partitions run serially to bound memory. The clone is removed unless `--keep-clone`; the receipt is written back for the author's HEAD. Skip/filter flags are rejected; parity `--no-fetch` is incomplete. Parity `--plan` prints steps without cloning, fetching, installing, executing, or writing a receipt.

Parity does not reproduce GitHub artifact transport or hosted-runner OS, live provider refresh, remote migrations/deployments, Cloudflare account state, production upload/UUID/markers, or live health; remote protection remains authoritative. `check:bootstrap` separately rehearses clean committed-state bootstrap, and `check:release` is an optional production-build/Worker-bundle rehearsal, not the [protected release path](./deployment-process.md#release-snapshot-state-machine).

`npm run ci:census -- --since=YYYY-MM-DD [--until=YYYY-MM-DD] [--cut=YYYY-MM-DD] [--out=<path.json>]` uses authenticated `gh` for GET-only workflow/run/attempt/job evidence; it writes JSON and `<path.json>.md` when requested, otherwise prints both. It distinguishes latest run-ID conclusions from retained executions, censored branches, and annotation-backed cancellation classes; UTC cohorts are descriptive, not causal attribution. Failure categories require owner classification. Source: [`ci-failure-census.ts`](../scripts/maintenance/ci-failure-census.ts).

Use `package.json` for the full live npm-script list. `scripts/lib/automation-registry.mjs` owns generated artifacts and deploy-impact classification; `scripts/lib/critical-ownership.mts` derives critical source-to-test ownership, while `scripts/lib/critical-test-files.mts` and `scripts/lib/critical-coverage.mjs` consume it for critical-suite membership.

`npm run typecheck:tests` compiles the complete test surface, including every TypeScript and TSX support file under `tests/` rather than only `*.test.*` and `*.spec.*` entrypoints. The lane runs in nightly/manual validation so shared fixtures and helpers cannot accumulate type errors outside Vitest's selected module graph.

`check:doc-symbols`, included by `check:doc-sync`, scans the canonical verified corpus (README plus every Markdown document under `docs/`) and explicitly routed extras such as scoped agent guidance and the migration manifest. It reports verified and extra document counts separately; unrouted verified docs are not excluded. It uses ripgrep when available and falls back to an in-process scan of the same Git-listed source files on minimal CI runners. Reviewed exceptions name external APIs, historical references, or explicitly planned concepts rather than silently treating them as live Pharos identifiers.

`check:verified-doc-links` uses the docs renderer’s Markdown parsing and heading IDs, including repeated punctuation and duplicate headings. It resolves ordinary links and images with optional titles, angle-bracket destinations, and reference definitions, then checks local targets and anchors. A verified doc at or above 400 lines or 50 KB must include a top `> **Agent navigation**` block. (The separate requirement that a doc-ownership reference name a section for such a target is enforced by `scripts/__tests__/doc-ownership-registry.test.ts`, not by this check.)

Changed-file classification retains deletions and both sides of cross-area renames; ordinary Git selection failures stop the check rather than producing an empty plan. Classification uses frozen base/branch-head refs; CI and parity execute on a tested merge checkout, so import-graph test discovery inspects that tree while ownership selection retains the branch diff. Nonexistent test files are filtered only before execution. Generic parallel commands cancel and settle siblings on failure unless continue-on-error is explicit; the readiness runner instead collects every independent leaf. Sources: [`changed-files.mts`](../scripts/lib/changed-files.mts), [`run-pr-checks.ts`](../scripts/maintenance/run-pr-checks.ts), and [`run-ci-parity.ts`](../scripts/maintenance/run-ci-parity.ts).

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
| `src/components` change | `npm run check:focused -- --file <component-path>` selects lint, source typing, and related tests | Add `npm run check:table-primitives` for table markup/primitives; route/public-surface changes need the page-specific registry/CSP/SEO checks. |
| API route (`worker/src/api` or `functions/`) change | `npm run lint:changed`; `npm run typecheck`; `npm run typecheck:worker`; `npm run test:critical-contracts` | Add `npm run test:pr -- --base=<ref>` when dependency-selected or multi-mode contract coverage is needed. |
| D1 migration | `npm run lint:changed`; `npm run typecheck:worker`; `npm run check:migrations`; `npx vitest run worker/src` | Add the affected API test under `worker/src/api/<relevant>.test.ts` when runtime behavior changes; run `npm run test:pr -- --base=<ref>` for critical consumers. |
| Stablecoin JSON (`shared/data/stablecoins/**`) | `npm run lint:changed`; `npm run check:stablecoin-data`; `npm run check:generated-artifacts -- --only=stablecoin-client-projections`; `npm run typecheck`; `npm run typecheck:worker`; `npx vitest run shared/lib/stablecoins shared/lib/__tests__/stablecoin-id-registry.test.ts` | Add the focused catalog/registry test and `npm run check:dependency-review-gaps` when dependency or reserve mappings change; `check:pr:static` also selects page and Worker checks because stablecoin data is a deploy-impact shared path. |
| Safety Score V9 | Focused routing retains lint, Worker typing, `check:generated-artifacts -- --only=safety-score-v9-evaluation-build`, `check:doc-sync`, `audit:mint-authority-review`, and `npx vitest run shared/lib/safety-score-v9 worker/src/lib` | PR `testOwnership` adds source-selected evaluation-build identity, resource-budget, native-input/capture, and publication archive/replay invariants even when import discovery cannot find them. |
| Dependency coverage | `npm run audit:coverage -- --domain=dependency-coverage` (report); `npm run check:dependency-review-gaps` (gate, included in `check:structural`) | Add `--prod` to the report command for current published graph and live-reserve comparison. The weekly production gate fails and alerts on structural findings but never blocks releases; see [Dependency network runbook](./runbooks/dependency-network.md). |
| Docs-only change | `npm run check:verified-doc-links`; `npm run check:doc-source-paths`; `npm run check:doc-sync`; `npx vitest run scripts/__tests__/doc-ownership-registry.test.ts`; `npm run check:generated-artifacts -- --only=agents-doc` | The manifest docs lane is not full convergence. Generated output edits, including `docs/api-reference.md`, additionally select their owning artifact freshness check. |

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
npm run test:ops-browser
```

Markdown variants are generated for `/methodology/`, methodology changelogs, `/changelog/`, `/digest/[date]/`, stablecoin detail pages, and `/docs/*`. Representative checked-in fixture snapshots live under `scripts/__tests__/fixtures/markdown/`; refresh them with `npm run refresh:markdown-fixtures` and commit them in the same change as the JSX, renderer, or source edit.

`npm run audit:pricing-providers` checks the configured CEX and RedStone provider contracts against live metadata and is covered by mocked unit tests for success, regional blocking, provider drift, non-OK responses, and malformed metadata shapes. Optional live source-shape probes can be run with `npx tsx scripts/maintenance/audit-pricing-provider-config.ts --live-source-shapes`; this adds Jupiter V3 shape validation and, when `CMC_API_KEY` is set, a CoinMarketCap category shape check. Stablecoins sync metadata also emits `pricingSourceAuditReport`, which summarizes source distribution risks such as missing prices, fallback/cache reliance, low-confidence pricing, assets without an independent hard source, and structured provider rejection counts.

When `SMOKE_UI_EXPECT_GA_ID` is set, `npm run test:smoke-ui` first verifies that the homepage artifact does not preload GA as first-paint work, then the browser smoke requires a successful `gtag.js` load and a GA4 `page_view` collect signal in both modes; local artifact mode additionally asserts the runtime initialization state (`window.gtag`, the expected `config` entry, the `page_view` entry), while live mode warns and falls back to the network signals when that runtime global is not observable. Live mode requires successful collect delivery; after that success, expected-measurement GA collect `net::ERR_ABORTED` reports are treated as browser beacon noise. Local artifact mode also accepts a Playwright `net::ERR_ABORTED` report for a GA4 collect URL with the configured measurement id because Chromium can abort that issued beacon when the local smoke context closes.

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
2. `prepare` installs/bootstraps offline/history inputs and classifies frozen event base/branch-head refs while testing GitHub's merge checkout. Non-docs-only PRs serialize `.tmp/pr-test-plan.json` for matrices without execution. Docs-only PRs run the manifest docs lane inline (ownership invariants included); `docs/editorial-style.md` retains full static selection. A run/producer-attempt/SHA artifact transports `node_modules`, registered ignored bootstrap outputs, and the plan in zstd (`zstd -T0 -3`, upload compression `0`). Consumers restore `workspace_artifact_name` without reinstalling; setup rejects changed tracked/checkable bootstrap outputs. PR jobs never save reusable caches. Sources: workflow, [`pr-lanes.mts`](../scripts/lib/pr-lanes.mts).
3. `validation` restores the workspace and runs the manifest-selected `static-compile`, `static-guards`, `tests`, and optional mixed-PR `docs` lanes. `check:pr:static --group=compile` owns changed-file lint and selected root/Worker typechecks; `--group=guards` owns the remaining selected checks. Grouping changes scheduling, not check ownership; mixed docs/source plans give doc-sync to `docs` and pass `--skip-doc-sync` only to guards. Test shards consume `PR_TEST_PLAN_FILE=.tmp/pr-test-plan.json`, validate its base and shard count, and execute explicit file partitions without repeating selection or applying Vitest's hash sharding. The plan uses four shards, or eight when the selected test-file count exceeds 800.
4. Up to eight selected coverage shards start after prepare, independently of validation, and execute the **full critical-owner suite**; only V8 includes/touched ratchets narrow. Shards/merge use frozen event `PR_BASE_SHA`/`PR_HEAD_SHA`, with the same comparison base. [`critical-coverage-refs.mts`](../scripts/lib/critical-coverage-refs.mts) rejects missing Actions refs, never substituting moving main/merge HEAD. Shards upload blobs/timings; merge needs prepare/shards and enforces completeness/ratchets.
5. `pagesArtifactRequired` selects `pages-artifact` after prepare. With `actions: read`, the frozen PR base helper GET-downloads/validates the newest unexpired successful-main `pages-release-data-<sha>` before candidate setup; `GH_TOKEN` is scoped only to that step. The token-free candidate uses `PAGES_RELEASE_DATA_DIR`; the [runner](../scripts/ci/run-pages-artifact-lane.ts) overlays data, generates compile-input/post-refresh with offline detail replay, runs Webpack/postbuild and every `check:pages-release` gate without live refresh/publishing. Missing base helper or unavailable CLI/auth/API/download/artifact yields `degraded-data`: committed snapshots + offline bootstrap, **not** realistic size proof. Invalid data/gate failures remain fatal.
6. `PR gate` runs with `always()` and requires secrets/prepare success. Non-docs-only validation must succeed; docs-only validation must be skipped with successful inline docs. Selected coverage requires shards and merge success; unselected coverage requires explicit `false` and both skipped. Selected Pages artifacts must succeed; unselected Pages requires explicit `false` and skipped. Failures, cancellations, missing classification, and unexpected skips fail the gate.
7. Nightly/manual mandatory lint, root/Worker typing, typed lint, test typing, and structural steps each run after workspace success with `!cancelled()`: one failure cannot hide later leaves. The aggregate prints all six outcomes and fails unless all succeed. Cache save requires lint/root/Worker typing success. Full Vitest has two shards; Node 26 typing is advisory. [`package.json`](../package.json) gives typed lint an 8 GiB heap and combined TS/TSX globs; [`typed-lint-scope.test.ts`](../scripts/__tests__/typed-lint-scope.test.ts) rejects empty/omitted scope. CodeQL/Zizmor retain change/scheduled backstops; weekly all-critical coverage is blocking.

The [weekly workflow](../.github/workflows/weekly-validation.yml) also compares Cloudflare account state with `CLOUDFLARE_ACCOUNT_STATE_DRIFT_API_TOKEN`.

Weekly dependency coverage keeps structural evaluation separate from permanent advisory reconciliation (`if: always()`, `continue-on-error: true`). Audit JSON carries schema-validated upstream publication identity, clocks and source generations plus the audit checkout revision; `generatedAt` is only the capture clock. Reconciliation reports the current comparison checkout separately and renders absent legacy provenance as unknown, never reconstructing a publication generation from the capture time or methodology version. Malformed supplied provenance is a tool error, not a clean comparison. Differences do not admit edges or gate releases.

Validation is capped at `max-parallel: 10`, coverage shards at `8`, both with `fail-fast: false`. The [PR workflow](../.github/workflows/pull-request-checks.yml) now peaks at **20 jobs: validation 10 + coverage 8 + Pages 1 + secrets 1**. Under GitHub Free's 20-concurrent-job allowance this leaves no spare slot: other workflows share the allowance and queue at the peak. An eight-test-shard mixed PR has eleven validation entries, so one queues within the validation cap.

**Re-run failed jobs** can retry a validation/coverage shard or merge without rerunning successful `prepare`: consumers validate and restore its producer-owned name, not their new attempt. Per-shard coverage/timing uploads use `overwrite: true`, replacing only the rerun shard; merge downloads `critical-coverage-*`, including retained successful shards. Workspace/coverage artifacts expire after one day, so an expired transport requires a full rerun/new run. Failed `prepare` reruns itself; source fixes require a new PR revision.

`prepare`, `static-guards`, and `docs` install checksum-verified ripgrep `15.2.0` through shared setup (Linux x64) for `check:doc-symbols`; local JavaScript fallback remains supported.

Firefox installation is driven by selected generated artifacts' `requiredBrowsers` in [`automation-registry.mjs`](../scripts/lib/automation-registry.mjs), through [`classify-deploy-changes.ts`](../scripts/ci/classify-deploy-changes.ts); only the selected static-guards lane installs it. Do not maintain a second OG-path browser list.

[`run-pr-static-checks.ts`](../scripts/maintenance/run-pr-static-checks.ts) selects `check:html-fixture-metadata` for reserve HTML/JSON/TXT fixture edits or changes to the age checker/refresh owner. This validates capture metadata without rejecting legitimate aging during a PR; [weekly-validation.yml](../.github/workflows/weekly-validation.yml) retains `check:html-fixture-age` for the weekly age limit.

**Open provider prerequisite:** the supported Ethena endpoint access contract remains unresolved; offline tests do not prove live access for the [protocol capture workflow](../.github/workflows/protocol-api-mechanism-refresh.yml).

The static selector adds full-lockfile `check:dependency-audit -- --new-since=<baseSha>` for root package/lockfile, `.npmrc`, or audit checker/exception-policy edits; production-only `audit:deps` also runs on root dependency edits. The base is frozen `PR_BASE_SHA` when provided, otherwise the merge-base of the selected head with `origin/main`. [`verify-dependency-audit.ts`](../scripts/ci/verify-dependency-audit.ts) audits base and current lockfiles, including dev dependencies, and fails on new high/critical advisory/package pairs; pre-existing pairs print “pre-existing, tracked by weekly audit”. Missing base evidence fails explicitly. Weekly retains the full reviewed audit and package-signature check: braces `GHSA-vfj7-8cjw-p6xm` remains red and tracked until upstream supplies a fix, not an accepted exception.

Main/scheduled incident jobs use the shared [report-workflow-failure action](../.github/actions/report-workflow-failure/action.yml); nightly excludes advisory Node 26. See [Workflow incidents](./runbooks/workflow-incidents.md) for keys, issue lifecycle, and evidence. **Open alerting prerequisite:** Actions secrets `TELEGRAM_BOT_TOKEN`/`TELEGRAM_OPERATOR_CHAT_ID` are not provisioned; issue reporting does not prove Telegram delivery.

Gitleaks self-tests use three report-validated passes: public false positives stay clean; AWS and generic API-key controls must match their expected rule/path/line. Exceptions pair reviewed paths and exact values; `.gitleaksignore` retains uncovered findings. Hunk-aware extraction preserves added source starting with `+`, excluding file headers only outside hunks. `--tree` scans combined-diff resolution additions from HEAD and every in-range merge, closing the `--no-merges` gap; any finding fails closed. Non-merge checkouts without in-range merges scan nothing.

Plain and coverage shards publish `pr-test-timings-<shard>` and `pr-coverage-timings-<shard>` artifacts (seven-day retention), plus wall time and slowest-first file rows in the step summary. `PR_SHARD_TIMINGS_FILE` enables `scripts/lib/shard-timing-reporter.mts`, whose per-file measurements include preparation, environment/setup, import/collection, tests, and hooks. Those aggregate costs are scheduling estimates, not wall time: compare shard wall times to spot imbalance. Missing uploads warn rather than gating. Future plans use the committed `scripts/data/pr-test-timings.json` via deterministic longest-processing-time-first partitioning in `scripts/lib/pr-test-plan.mts`; both plain and coverage shards use their own duration maps. Unknown files use the map's median, or one second without measurements.

Shard runners pass an explicit plain-test or critical-coverage lane to the summary formatter. The lane selects both its heading and overflow artifact reference; coverage overflow rows point to `pr-coverage-timings-<shard>`, never the plain-test artifact. Timing telemetry does not change test/coverage exit status.

Refresh scheduling weights after substantial suite changes or persistent shard-wall imbalance, while seven-day timing artifacts are still retained. With authenticated `gh` available, run:

```bash
node --import tsx scripts/maintenance/refresh-pr-test-timings.ts --runs=5
```

The GET/download-only refresh selects the latest successful `pull-request-checks.yml` runs in `TokenBrice/pharos-watch`, downloads only unexpired plain/coverage timing artifacts, validates successful summaries, and writes median per-file milliseconds plus run/artifact provenance to `scripts/data/pr-test-timings.json`. It runs no tests and changes no CI state. Review and commit that file so future plain and coverage partitions use the new maps; increase `--runs` for a broader sample, or use `--output=<path>` to inspect a candidate without replacing the committed input. No retained plain timings is an error; missing coverage observations use twice the plain duration as a cold-start scheduling estimate, not measured coverage. Unknown files use their map's median (one second without measurements). New reporter samples include preparation, environment/setup, import/collection, tests, and hooks; legacy plain artifacts contain assertion spans only, so prefer post-reporter runs when refreshing.

Plain local readiness uses the shared selectors but executes on committed branch HEAD, with individually collected static leaves and unsharded tests/selected coverage. Opt-in parity tests the synthetic merge tree with frozen branch classification refs and explicit serialized CI partitions. Neither local mode reproduces hosted Actions artifact transport or production acceptance; use [Pre-push readiness](#pre-push-readiness) for publication policy.

Broad UI, accessibility, ops, analytics, asset-coherence, and transport checks remain PR, scheduled-monitor, or explicit operator commands; they do not control production mutation or automatic rollback. The [CI deploy sequence](./deployment-process.md#ci-deploy-sequence) owns the post-merge build, deploy classifier, migration, activation-marker, release-marker, and cache-separation facts.

The [generated-artifact registry mechanics](./scripts.md#build-and-generated-artifacts) own lifecycle and automatic-staging facts; the failure playbook above owns checkability and history-input behavior, while the [CI deploy sequence](./deployment-process.md#ci-deploy-sequence) owns build and release ordering.

Telegram load protection runs in selected `check:pr:static` plans and weekly/manual via `scripts/lib/telegram-load-guard.mts`. Fan-out and all six status-reader SQL templates come from production: full lifecycle aggregate, preset followers, pending count, lifecycle events, explicit top coins, and bounded snapshot history; there is no subscriber-history fallback. Canonical family metadata supplies alert predicates. Completion scenarios include planning and delivery (SLO at 1,000 watchers; CPU, TTL and status budgets at 5,000), comparing the higher of planner and pending-drain CPU. PR tests always include the critical contracts and real workerd OG-rendering contract; `test:critical-contracts` remains a focused local runner.

Selected specialized checks:

- Cron schedule/connection changes: `npm run check:cron-sync`, `npm run check:cron-connections`, and `npm run validate:worker-scheduled-smoke`. The sync gate compares raw trigger inventories before set membership, so duplicate Wrangler or slot-plan expressions fail; the connection gate requires each job's budget row to carry the exact scheduled-slot identity.
- Shock coverage: the refresh matrix and `check-shock-coverage-freshness` both enumerate `SHOCK_COVERAGE_TARGETS`; the scheduled freshness-only check runs independently of regeneration, so adding an unmeasured canonical target fails rather than disappearing behind a copied list.
- Worker deployment configuration: `npm run check:worker-config` verifies that production custom domains remain root-owned and asset rules fall through.
- Structural guardrails: `npm run check:structural` runs Worker raw-console usage, clone-ratchet, provider resilience, fetch-body timeouts, runtime reachability, script entrypoints, CLI argument policy, stale feature-flag, hook polling-window, dependency review-gap, unused-code, sensitive-page-copy, and agent-skills checks in affected PR static lanes and every nightly/manual run. Raw-response body tracking follows symbols/reassignment without a source-line cutoff. SQL interpolation needs a directly preceding allowlist guard on that expression or a reviewed `SAFETY` comment, not unrelated `.has()`/throws. Runtime reachability bundles memory-sensitive mint/burn and Telegram entrypoints to exclude the full stablecoin registry. Configured roots/sources must exist and resolve a nonempty graph; scheduled policy includes `worker/src/handlers/scheduled.ts` alongside dynamic runners. Individual commands remain available for diagnosis.

- Deletion evidence is commit-scoped for `check:unused-code` artifacts:
  no deletion may cite an unused-code artifact older than the commit it is
  dispatched against. A deletion cites either an independent closure proof or
  a stamped artifact—never a stale one. The unstamped campaign artifact is
  superseded and cannot support a deletion.
  Useful test-only corpora are preserved in recognized `*.test-support.ts` files beside their owning tests, not deleted or reclassified as external-consumer blind spots. The matched Safety Score invariant corpus remains test evidence outside the evaluation-build manifest; empty unused-code DEBT maps do not prove a clean current detector scan.
- Secret-scan exceptions: `.gitleaksignore` contains reviewed commit/path/rule/source-line fingerprints, not path-wide exemptions. The 2026-10-07 snapshot had 316 active fingerprints across 345 physical lines (38,874 bytes); comments and blanks are not exceptions. A fingerprint's line number identifies the finding's source line, not its row in the ignore file, so rearranging ignore rows does not invalidate fingerprints. Historical findings survive current-source cleanup. Delete an entry only after the trusted scanner proves its candidate removal clean with `GITLEAKS_FULL_HISTORY=1`; preserve the review evidence and real-secret positive controls.
- Architecture boundaries: `npm run check:architecture-boundaries`, also in `check:structural`, resolves executable TypeScript dependencies using the repository tsconfig (including aliases), static imports, re-exports, literal dynamic imports, CommonJS requires/import-equals, and relative template-import expansions. Erased types and comments do not create edges. Missing modules, unresolved imports, unconstrained dynamic dependencies, and escaped require loaders fail closed. Like runtime reachability, resolved npm packages are terminal public-module boundaries, not a scan of dependency internals; aliases to packages retain canonical package identities. Local dependency chains are reported on failure.
  - Path identity: the repository root and local modules are canonicalized through filesystem real paths before applying root-relative policies or reporting dependency chains. A symlinked checkout or temporary root (including macOS `/var` → `/private/var`) must enforce the same boundaries and report the same repository-relative paths as its physical root.
  - `reserve-network`: all nested reserve-adapter modules must reach network transport through the existing `request.ts`, `defillama.ts`, or Worker `evm-rpc.ts` gateways, never bypass them to import `fetch-retry.ts` or acquire network globals. Gateway implementation safety remains owned by provider-resilience and fetch-body-timeout checks.
  - `frontend-routes`: reusable components, hooks, and libraries cannot reach `src/app`; script-consumed case-study/mechanism content stays outside route-owned directories (index re-exports remain allowed).
  - `recap-cost`: personalized recap planning cannot reach daily/weekly digest generation, AI provider modules, or network capabilities, including aliased/destructured/bracketed access.
  - `verification-url`: the analytics entry must reach the URL scrubber, whose graph excludes Zod and shared schemas.
  - `stability-light`: the lightweight PSI contract cannot reach Zod or the full shared stability schema.
  - Deletion owners: `scripts/ci/check-architecture-boundaries.ts` and its synthetic-fixture test replace the retired `fetch-guard.test.ts` (`reserve-network`), `frontend-route-boundary.test.ts` (`frontend-routes`), and `telegram-recap-cost-boundary.test.ts` (`recap-cost`) suites, plus only the source-scan cases in `src/lib/__tests__/api-key-verification-url.test.ts` (`verification-url`) and `src/lib/__tests__/api-query-descriptors.test.ts` (`stability-light`). Their behavioral tests remain.

For test-only changes, structural validation runs only `check:clone-ratchet` and `check:cron-console-usage`.
- Table primitives: `npm run check:table-primitives` rejects raw `<table>` markup and direct shadcn table imports under `src/`, allowing them only in the shared primitives under `src/components/table/`, the chart data table, and test fixtures. It is listed unconditionally in `check:pr:static` rather than inside `check:structural`, so a table change is gated even when no structural path moved. `npm run check:table-primitives -- --inventory` reports every table call site with its chrome, density, accessible name, and mobile-hint state and never fails; [design-language.md](./design-language.md) owns the rule itself.
- Generated public artifacts: `npm run check:generated-artifacts`, with individual checks in `scripts/lib/automation-registry.mjs`.
- Release-data and provider boundaries fail closed: detail snapshots tolerate only explicit 404/410 lane absence and require at least one lane for each live asset; public depeg-history generation applies the same 60-row completeness floor as artifact checks and requires the requested year's source shard before writing; operator-pinned mechanism captures reject a mismatched RPC block header. The scheduled Safe Browsing monitor bounds provider time and validates successful payloads, while retaining Google's documented empty-object clean response.
- Static export SEO: `npm run seo:check` enforces unique sitemap locations, indexability against robots/googlebot `noindex`/`none` and headers, built-anchor rejection for reviewed legacy aliases, and one-hop permanent internal `_redirects`. Noindex HTML remains allowed outside the sitemap. Bounded worker threads extract pages; the parent owns global graph, sitemap, header and continuity assertions. Releases set `SEO_PREVIOUS_SITEMAP_URL` to reject lost digest/depeg URLs unless a direct 301 preserves them. Live `npm run seo:live-smoke -- --url https://pharos.watch` requires sitemap uniqueness, direct HTTP 200, robots/googlebot and `X-Robots-Tag` indexability, and self-canonical HTML; each request's 30-second deadline includes body reads. Search Console's submitted-page cohort distinguishes public recovery from intentional query, workbench, Markdown and operator exclusions; historical exclusions need a new crawl to reflect production.
- Static export accessibility: `npm run test:a11y` scans the bare static export, while `npm run test:a11y:hydrated` reuses the API-backed static-export smoke server so axe sees hydrated product data. Both block Google Analytics collection before navigation while retaining analytics script loading; the intentional GA smoke acceptance is unchanged. Both run route-per-test with 3 Playwright workers (`fullyParallel: true` in `playwright.config.ts`); the scans are independent per route, so parallelism changes no coverage.
- Public visual browser checks: `npm run test:visual` runs every top-level spec matching `tests/visual/*.spec.ts` (currently 10 files / 35 tests); the a11y specs under `tests/visual/a11y` and operator specs under `tests/visual/ops` use their own scripts and Playwright configuration.
- Operator workspace browser checks: `npm run test:ops-browser` runs all five specs under `tests/visual/ops` — `ops-routes.spec.ts`, `api-inventory-geometry.spec.ts`, `status-card-containment.spec.ts`, `ops-crons-altpegs-geometry.spec.ts`, and `stablecoin-gate-incident.spec.ts` — under the second Playwright config, `playwright.ops.config.ts`. It serves the static export on `OPS_PLAYWRIGHT_PORT` (default `4174`) and resolves `ops.pharos.watch` to `127.0.0.1` inside Chromium, so no hosts-file entry is needed; set `PLAYWRIGHT_REUSE_OPS_SERVER=1` to attach to an already-running `npm run serve:static-export`. The suite runs a six-viewport matrix from 320px to 1440px, but `@phase6`-tagged tests (200% text zoom, `prefers-color-scheme`, forced colors, reduced motion) are excluded from every project except 390px, so those assertions are proven at one viewport only. Workspace routes are driven by fixture API responses and a fixed clock, which means it covers operator route, layout, and a11y behavior and proves nothing about live operator data or the Cloudflare Access posture in [Operator Origin Access Setup](./operator-origin-access.md).
- GSC offline triage: `analyze:gsc-coverage` and `analyze:gsc-performance` accept exports. Combined page/query rows populate both dimensions; separate query totals override overlapping combined queries, while unmatched combined queries remain.
- Optional render-budget probe: `node scripts/maintenance/audit-seo-render-budget.mjs --url https://pharos.watch`.

## Vitest Runtime Profiling

`npm run test:profile -- --output /tmp/pharos-vitest-profile.json` runs Vitest once with the JSON reporter, stores the raw Vitest report beside the requested output as `*.vitest.json`, and writes a durable summary to the requested `/tmp` path. The summary prints total files/tests, wall time, summed file/test time, node/jsdom split, top files, top individual tests, files above 10s, and tests above 1s.

Pass Vitest filters or options after `--` when narrowing or validating runner behavior:

```bash
npm run test:profile -- --output /tmp/pharos-src-profile.json -- --dir src
npm run test:profile -- --output /tmp/pharos-vitest-threads.json --baseline /tmp/pharos-vitest-profile.json -- --pool=threads
```

In CI, every Vitest runner that routes through `scripts/lib/vitest-ci-args.mts` — `test:pr`, `test:all`, `test:critical-contracts`, `coverage:critical`, and its `:shard` / `:merge` variants — appends `--silent=passed-only` unless an explicit `--silent` option is supplied. Set `PHAROS_CI_VITEST_COMPACT=0` to restore full console output while debugging.

`npm run coverage:critical` also forwards trailing Vitest options to the critical suite. Use this to validate candidate pool behavior before any global `vitest.config.ts` change:

```bash
npm run coverage:critical -- --pool=threads
CRITICAL_COVERAGE_RATCHET_ALL=1 npm run coverage:critical -- --pool=threads
```

## Test Setup

[`vitest.config.ts`](../vitest.config.ts) owns projects, aliases, environments, transforms and exclusions; [`scripts/lib/critical-ownership.mts`](../scripts/lib/critical-ownership.mts) owns executable test discovery. Read those definitions before choosing a runner, rather than copying configuration into prose. Prefer the established `*.test.ts` / `*.test.tsx` convention and lane-local `__tests__/` homes; runtime discovery does not imply test-typecheck coverage.

[`scripts/test/ensure-fresh-stablecoin-artifacts.ts`](../scripts/test/ensure-fresh-stablecoin-artifacts.ts) owns catalog bootstrap. Its ignored `.cache/vitest-stablecoin-artifacts/` metadata cache is a local shortcut, not content proof: changed or missing inputs/outputs invalidate it, and deleting it forces regeneration. Clean CI generation and content checks remain authoritative.

The required release runtime is the exact `.nvmrc` Node and npm 11.x runtime. The future-major nightly typecheck is advisory, not build/test/release qualification. Keep JavaScript/TypeScript source maps and Worker per-file isolation enabled; the catalog JSON transform deliberately omits synthetic named exports and unnecessary maps to avoid retaining an oversized transform graph.

Pure Node suites may reuse processes; stateful exceptions require isolation. Worker and frontend suites retain isolation because they own module-level state; the native full-registry Safety pipeline uses its reviewed thread worker. jsdom is a per-file opt-in. If a Node suite fails only in a full run, fix module-state leakage or enroll it in the existing isolated project. Nested worktrees must not enter the parent checkout's corpus.

Optional Poppler (`pdftotext` and `pdfinfo` on `PATH`) enables RLUSD assurance PDF extraction cases; compiler/manifest parity remains unconditional without it.

Scheduled-slot topology is asserted once by [`worker/src/handlers/scheduled/__tests__/slot-registry.test.ts`](../worker/src/handlers/scheduled/__tests__/slot-registry.test.ts). Per-slot suites exercise gating/order semantics, not duplicate registry membership; state-dependent slots must still never lease an unplanned job. PSI recompute, replay and benchmark suites remain separate evidence for historical inputs, methodology-aware replay and crisis signatures.

## Test Infrastructure

### Sibling test-support modules

For shared test-only fixtures, harness setup, and builders, use a sibling `*.test-support.ts` module next to the owning test family. Keep assertions and test cases in the owning test files; the reference case is `worker/src/lib/__tests__/cron-leases.test-support.ts`.

Helpers used across test families live in the shared homes instead:

- `shared/test-utils/` — runtime-neutral helpers shared by frontend, Pages Functions, script, and Worker tests (`mock-d1`, `mock-fetch`, `latest-schema-sqlite`, stablecoin builders)
- `worker/src/test-helpers/__shared/` — Worker API/cron row fixtures, auth/request builders, and endpoint contracts
- `scripts/__tests__/helpers/` — script-suite helpers
- `functions/__tests__/helpers/` — Pages Functions helpers (`mock-kv`, Pages context, `mockUpstream(origin)` strict per-origin fetch installers)

Cross-runtime adversarial inputs live in `shared/test-utils/boundary-contract-vectors.test-support.ts`: numeric availability, scan frontiers, read outcomes and generation-bound clocks. Boundary suites specify their own expected public semantics; input sharing never supplies an oracle or replaces reviewed source/date fixtures. Existing import-based PR selection and critical ownership select these suites, not a separate lane.

A cron unit has one test home: tests for `worker/src/cron/<lane>/<module>.ts` live in that lane's own `__tests__/` directory, not in the flat `worker/src/cron/__tests__/` tree. Behaviour asserted through an adapter that is really owned by a shared executor (for example the adaptive multicall split) belongs to the shared unit's suite, with each adapter keeping only the wiring case that is adapter-specific.

A shared guard or mechanism is asserted where it is implemented, not at every route that imports it: `functions/lib/__tests__/site-data-origin.test.ts` owns the origin matrix and `functions/__tests__/upstream-proxy.test.ts` owns the response byte cap and deadline, so a proxy route suite keeps only its own wiring case.

**One unit, one home.** A production module has exactly one test file that owns its contract. Suites named after a ticket, ruling, or review wave (`R3`, `D2`, `VER-010`) are not units: fold their cases into the module's name-matched suite and delete the satellite, keeping every distinct assertion. A satellite that exercises a *different* module reachable from the same fixture belongs to that module's owner, not to whichever suite happened to build the fixture.

Timeline and homepage tape tests share only input construction in `shared/test-utils/tape-event.ts`; secondary DEX pool inputs use `scoring-test-builders.ts` in the owning cron test family. `depeg-trust-policy.test.ts` owns the trust/reference matrix, while `depeg-helpers.test.ts` keeps provenance and DEX corroboration. `generate-safety-score-v9-evaluation-build-manifest.test.ts` owns source mutations, runtime import closure, and Worker catalog transport identity. Supply replacement ownership is proved by the persisted-row SQLite case in `snapshot-supply.test.ts`, not duplicate SQL-bind assertions.

`src/components/__tests__/table-primitives.test.tsx` owns matrix semantics, surface/viewport props and caller-class forwarding; internal CSS tokens are not layout evidence. `src/lib/__tests__/design-invariants.test.ts` checks runtime font imports and styling expressions through TypeScript ASTs, excluding comments, display text and test-only files. `worker/src/lib/__tests__/depeg-resolver-assessment-store.test.ts` reads SQLite checkpoints to prove immutable thresholds, latest median/IQR updates and malformed-row quarantine.

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

[`scripts/lib/pr-test-plan.mts`](../scripts/lib/pr-test-plan.mts) owns the always-on contracts and changed-owner union. Retain real-SQL and failure-path suites even when pure helper tests are available. Colocate new tests with the owning module or established lane-local directory, and enroll production-gate contracts in the executable planner rather than documenting them only here.

## Conventions

### What to test

- **Pure `shared/lib/` + `src/lib/` functions** — formatters, supply helpers, classification maps, peg-rate derivation, and frontend derivations. These are the highest-value tests: deterministic, fast, and catch regressions in shared logic.
- **Edge cases** — `NaN`, `Infinity`, `null`, `undefined`, zero, negative values, empty inputs. The existing tests set this standard.
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

- `npm run check:clone-ratchet` checks exact duplicate significant-line windows against `scripts/lib/clone-ratchet-baseline.json`; `check:structural` enforces it for affected PR paths and nightly/manual validation. Normalization skips blank lines, whole-line `//` comments and leading block-comment spans, then collapses whitespace; inline/trailing comments remain significant. This is a bounded exact-clone growth policy, not a complete duplication metric or fleet-zero target. `npm run check:clone-ratchet:update-baseline` is reserved for reviewed extraction/deletion effects; the narrowly reviewed new-scaffolding exception and serialized regeneration protocol below still apply.
- The [Operator CLI Contract](./scripts.md#operator-cli-contract) owns what `npm run check:cli-args-policy` verifies; `check:structural` enforces it for affected PR paths and nightly/manual validation, and it can also be run directly when CI/operator scripts change.
- `npm run audit:coverage -- --domain=oracle-risk` always blocks on missing or structurally incomplete CDP oracle profiles and required branch evidence. The retired `--advisory` option is rejected, including through the generic coverage-audit wrapper, which forwards child arguments and propagates failures.
- Oracle stale-review reminders and the reviewed applicability queue remain advisory findings, not a structural exit-success bypass. `--stale-days=<positive integer>` controls the reminder age (default: 180 days). Explicit unresolved dispositions remain V9 blockers rather than silently passing as profile-only evidence; the shared stablecoin-data analyzer stays blocking independently.
- Raw-console budgets are stored upper bounds, not current-call counts. The checker reports filesystem-missing baseline keys separately from extant zero-call files. Drain calls through existing console-only structured helpers without adding D1 latest-event/status writes; preserve failure counters, terminal `logCronRun` persistence and already-authored durable events. Strict-zero closure targets 2027-01-31 only after a measured configured-root zero scan, persistence parity and first-path observation.
- `src/lib/__tests__/term-markup.test.ts` owns AI-summary glossary-marker integrity as an ordinary noncritical runtime-parser test, including known slugs, balanced markers, and the current corpus totals.
- Mechanism explainer completeness is split across ordinary noncritical domain tests: `src/app/learn/mechanisms/__tests__/content.test.ts` owns labels, one-liners, editorial content, and representative coin IDs; the existing dynamic-route test owns exact static params; `src/app/__tests__/sitemap-frozen.test.ts` owns sitemap membership. OG images remain generated-artifact-owned.
- `shared/lib/selector/__tests__/editorial-policy.test.ts` owns the Selector banned-phrase rule matrix and complete editorial corpus as an ordinary noncritical domain test, including Picker route/component copy and checked-in worked examples.
- `npm run check:stablecoin-data` has an advisory warning lane alongside its blocking errors. Warnings print to stdout, do not increment the error count, and never fail the gate; the footer reports `OK (N warning(s))`. It currently carries the collateral-prose drift report (`shared/lib/stablecoins/collateral-prose-reserve-drift.ts`), which flags a `collateral` string naming a tracked ticker that appears in no reviewed reserve slice. It is advisory by design: legitimate prose names non-reserve entities constantly — look-through naming and prose-vs-slice taxonomy differences are the noise floor — so only clauses carrying eligibility modality are reported per coin, and the rest collapse to a single count. Treat a new tier-1 warning as curation work, not a build break.
- `scripts/__tests__/weekly-curation-digest.test.ts` owns attestor-tier, coin one-liner, and mechanism-archetype coverage as an ordinary noncritical domain test. It reads authored per-coin entries and preserves the editorial rubric: all active/pre-launch coins need nonblank one-liners, more than 20% missing attestor tiers fails the independent-audit cohort, and unknown baseline IDs or more than 27% missing archetypes fails the fixed non-variant/non-frozen cohort.
- `npm run audit:coverage -- --domain=redemption-backstops` validates the redemption-backstop registry split across `shared/lib/redemption-backstop-configs/*`, catches duplicate IDs across modules, enforces allowed route-family membership per module, and keeps the headline counts in `docs/redemption-backstops.md` synced to the real registry.
- `npm run audit:coverage -- --domain=redemption-coverage` unconditionally evaluates source-reviewed dispositions for active unconfigured assets in `shared/data/coverage-dispositions/redemption-coverage-dispositions.ts`, with or without `--check`. It rejects missing, duplicate, unknown, inactive, configured-stale, and malformed reviews and ranks the queue by canonical market-cap order. `--check` changes presentation only; a reviewed nonzero backlog passes either mode. `--strict-active-gaps` independently escalates active gaps. Backlog size is curation work, not a merge failure.
- `worker/src/lib/__tests__/redemption-backstops-store.test.ts` now covers completed-run snapshot manifests for `redemption_backstop_runs`, including generation-filtered reads and current/history rows written with `snapshot_run_id`.
- Telegram callback suites are grouped by concern, not by ticket: `telegram-webhook-callbacks-settings.test.ts` owns settings, coin snooze and timezone callbacks; `telegram-webhook-callbacks-usage-analytics.test.ts` owns usage analytics and discoverability; `telegram-webhook-callbacks.test.ts` owns disambiguation and forget confirmations. Mocked pending-confirmation reads use `pendingDisambiguationTable(row)` from `worker/src/api/__tests__/telegram-rows.test-support.ts` rather than a hand-written table literal.
- The Telegram cron suites assert persisted rows, not statement text. `telegram-pending-queue.test.ts` owns enqueue/handoff collision semantics against real SQLite, and the pending-queue drain cases read `telegram_pending_alerts`, `telegram_subscribers` and `telegram_alert_dead_letters` back instead of pinning SQL fragments or bind indexes. `worker/src/cron/__tests__/` holds no snapshot artifact; retention-cleanup metadata is asserted with explicit counters.
- Telegram webhook units live with their handler concern: `telegram-webhook-messages.test.ts` owns every message/keyboard builder (status lines, safety provenance, HTML escaping, compact USD formatting), `telegram-webhook-parsing.test.ts` owns command parsing and ticker resolution, and `telegram-webhook-rate-limits-commands.test.ts` owns command rate limiting including the per-chat flood cap. Route-handler contexts come from `routeContextFactory()` in `worker/src/test-helpers/__shared/routes.ts`; the weekly-recap input-data suite owns both the candidate aggregation and the safety-identity cases over one fixture header.
- Supplemental commodity supply has one freshness home: `worker/src/cron/sync-stablecoins/supplemental-assets/__tests__/commodity-supply.test.ts` owns the shared market-cap/supply observation policy for every commodity lane, and each lane's own suite (`gold.test.ts`) keeps only its allocation cases.

### Test-lane gate protocol

A commit that deletes, renames, or merges test files carries the gate artifacts those files appear in, in the same commit:

- **Clone ratchet** — `scripts/lib/clone-ratchet-baseline.json` holds a per-file duplicated-line count. Deleting or merging files moves the counts of files the commit never touched.
- **Provider resilience** — `scripts/lib/provider-resilience-registry.mjs` lists exact `tests` paths per surface; a renamed or deleted path fails `npm run check:provider-resilience` with `missing-test-file`.
- **Critical ownership** — `scripts/lib/critical-ownership.mts` derives source-to-test ownership from each test's import specifiers, so a merge that removes the last importing test for an enrolled source silently drops ownership. Run `npm run check:critical-coverage-completeness` and confirm every source the deleted tests imported still has an importing test; do not close the gap with a waiver.
- **Executable test selection** — `assertExecutableTestFiles` requires every selected path to exist and to belong to exactly one Vitest project, so a deleted or moved entry of `CRITICAL_CONTRACT_TEST_FILES` / `ALWAYS_RUN_TEST_FILES` in `scripts/lib/critical-test-files.mts` fails selection before any suite runs. A cross-tree merge (for example `worker/` into `shared/`) can trip this even when coverage is preserved; move the entry with the file.

Baseline regeneration is serialized. The ratchet is cross-file (a window counts only when it occurs in at least two distinct files), whole-tree (regeneration rewrites the entire map from the working tree), and fails only when a file's count *increases*:

- Each lane rebases onto the merge target immediately before regenerating, and a single integration owner regenerates and reviews `scripts/lib/clone-ratchet-baseline.json` after the last lane merges. A concurrently-cut branch otherwise re-raises its siblings' counts, and because the gate only fails on an increase, the last merge permanently loses ratchet protection for those files.
- While parallel lanes are in flight, no lane regenerates: run `npm run check:clone-ratchet` read-only and record the decreases in the pull request, leaving one regeneration to the integration owner.
- A new file starts at baseline `0` and fails on its first shared window. The commit that creates shared scaffolding adds that single key with the count the read-only run reported, rather than rewriting the whole map.
- Deleting a baselined file leaves a stale key that the comparison never reads, because it walks current files only. `npm run check:clone-ratchet` reports those keys as `staleBaseline` without failing the deleting commit; the list must be empty after the integration owner's regeneration.

No gate threshold, waiver, or enumerated path is relaxed to accommodate a deletion.

### Test style

- Use `describe` per function, `it` per behavior.
- Test names describe the behavior, not the implementation: `"returns null for undefined input"` not `"calls sumPegBucketsOrNull with undefined"`.
- Use `makeStablecoin()` / `makeStablecoinMeta()` from `shared/test-utils/stablecoin.ts` (see `shared/lib/__tests__/supply.test.ts`) for partial `StablecoinData` mocks — avoids `as any` casts.
- Use shared fixtures from `worker/src/test-helpers/__shared/fixtures.ts` for DB row mocks.
- Keep tests focused: one assertion per `it` block when possible.
- Keep one canonical test home per unit concern. Split very large suites only along cohesive `describe` seams; do not create ticket-named satellite suites or fixture-only alias layers. A merge picks its target tree so the merged suite still resolves its sources under the [test-lane gate protocol](#test-lane-gate-protocol): the surviving file must import every source it now owns and belong to exactly one Vitest project.
- Drive repeated scenario scaffolding from one `it.each` table instead of copying the setup per `it`; keep every distinct assertion as a row field.
- Share genuinely repeated fixture construction through sibling `*.test-support.ts` modules; keep scenario-specific inputs, assertions and exact-source imports in the owning tests. Independent expected deployment identities, transport payloads and strict SQL expectations must not be derived from the production values they validate merely to reduce a clone allowance.
- Mock lazily loaded frontend sections by module (`vi.mock("./detail-lazy-sections", …)` with one stub per exported section name), never by `next/dynamic` loader source text or `dynamic()` call order — an ordering-keyed mock silently mis-assigns stubs when a section is added or reordered.

### Test evidence rules

The 2026 test audit enforced these rules across the suite; apply them to new and edited tests:

- **Assert consumer-observable behavior.** A test earns its place by failing when something a consumer observes regresses — a return value, rendered output, or persisted state — not when an internal detail changes.
- **Assert database outcomes, not statement shape.** SQL text, placeholder order, bind indexes, and prepared-call counts are implementation details. Seed the latest-schema SQLite fixture, run the unit, and select the persisted row by semantic column; use marker-matched strict D1 doubles only when the test does not depend on SQL semantics. Query-plan assertions are reserved for cases where index choice is itself the contract.
- **Prefer registry invariants to registry transcriptions.** Assert that every entry is retrievable by its own key and satisfies cross-row or cross-module constraints; do not copy authored keys, ordering, or row fields into expected-value tables.
- **No source-text, class-token, or prose pins.** Unit tests do not pin source strings, CSS class tokens, or editorial prose; such assertions churn on harmless edits while missing real regressions. Styling and layout claims belong in browser coverage, and source-structure scanning stays in its syntax-aware owner.
- **`test.fails` only with an `// audit:` comment.** An `it.fails`/`test.fails` marker must carry an adjacent `// audit: <finding> — <explanation>` comment recording the disputed or policy-deferred production defect it reproduces; it pins known-wrong current behavior and is never a way to leave a broken assertion green.
- **Deletions name a surviving owner.** A deleted test or fixture is removed only against a named surviving owner that defends the same behavior; consolidation never weakens coverage, and mere fixture relocation is not a deletion.

## Coverage

Full-suite coverage threshold is not enforced. The critical gate applies a 40% default plus explicit per-file line floors ranging from 30% to 70%, 40% branch/error-path floors at provider, authentication, scoring, and publication boundaries, and a touched-file no-regression ratchet. Run `npm test -- --coverage` to generate a detailed report. The V8 provider generates both text output and an `lcov` report for CI integration.

### Critical Coverage Gate

CI **does not** run a full-suite coverage gate. The PR workflow runs `coverage:critical` when an enrolled source or critical-coverage plumbing changes; the compare ref scopes the no-regression ratchet to touched sources. PR shards and the weekly/manual Critical Coverage Ratchet workflow execute the same full derived critical-owner test set so their measurements remain comparable to the checked-in baseline. Tests owning other critical sources can exercise a touched source indirectly:

- `critical-coverage.mjs` scans high-stakes source roots and applies the existing candidate path rules. `CRITICAL_FILES` is the generated intersection of those candidates and sources imported by tests; there is no hand-maintained source enrollment list.
- `critical-ownership.mts` resolves executable static imports and quoted dynamic `import(...)` calls (including `@/`, `@shared/`, and relative paths) to repository files and records every importing test. Mock-only `vi.mock` references and type-only imports are not ownership evidence. `CRITICAL_OWNERSHIP_WAIVERS` records each reviewed no-owner gap with a reason and `reviewAfter` date; `check:critical-coverage-completeness` fails for any new unowned candidate or any explicitly enrolled source without an owner. Ownership waivers are distinct from reviewed coverage-denominator exclusions: neither ledger proves measured coverage.
- Draining an ownership waiver requires a used exact-source import in a behavioral test. Imports through a barrel do not enroll its re-exported implementations: move the exercised function import to the implementation or add a direct consumer contract, preserving existing higher-level assertions. Registry reviews should exercise admission/expiry boundaries rather than transcribe authored rows; store readers should assert semantic results against the latest-schema SQLite fixture. Retained gaps keep their review date and a dated, path-specific evidence rationale; ownership removal never substitutes for measured coverage or permits lowering its floors.
- Pure fact builders can use admitted fixed-input and extension fixtures with an asset build context rather than mocking the compiler. Their direct contracts should distinguish missing from measured zero, preserve observed values and provenance through stale/unavailable paths, reject nonconserving partitions, and exercise freshness and exact-active-set boundaries.
- Depeg lane ownership contracts directly exercise hydration's open-book saturation/native-cache writes, native quote mutation vetoes, option normalization, consumer freshness/expiry budgets, assessment/review partial persistence and cancellation, and public methodology observation clocks. Durable outcomes use the latest-schema SQLite harness with the real stores; an unavailable required read is not an empty successful book.
- `CRITICAL_COVERAGE_WAIVERS` is a separate denominator policy for genuine forwarding/configuration facades, not a missing-test backlog. Every retained entry names its rationale, unchanged `reviewAfter` date, enrolled implementation `owner`, and executable importing `ownerTest`. Completeness rejects a missing rationale, an implementation no longer enrolled, or a test that no longer imports that implementation. A facade gaining runtime decisions must gain its own behavioral contract and leave the exclusion set; changing/deleting its implementation or owner test triggers a new path-specific review, not automatic date renewal.
- PR coverage matrix generation caps the shard count at the smaller of eight or the full owner-test count. `pr-test-plan.mts` partitions that full suite using the committed coverage duration map. Each shard passes the changed file set to `buildCriticalCoverageArgs`; it includes only touched enrolled sources for V8 remapping but retains the full critical-owner suite across all shards. The merge checker applies line/branch floors and `MISSING` checks to that same touched source scope; plumbing-only changes fall back to the full derived source set, while `CRITICAL_COVERAGE_RATCHET_ALL=1` checks every enrolled source.
- The full derived source and owner set is capped at four Vitest workers. v8 remapping is limited with per-file `--coverage.include` flags, so unrelated loaded modules do not inflate the report.
- Parses `coverage/lcov.info` and fails if any enrolled source falls below `CRITICAL_COVERAGE_THRESHOLD` (default 40%).
- Applies explicit per-file line minimums and 40% branch/error-path floors at provider, authentication, scoring, and publication boundaries.
- Applies the touched-source no-regression ratchet using `.ci/critical-coverage-baseline.json`; changing the baseline itself selects this lane. A missing baseline file (including a configured `CRITICAL_COVERAGE_BASELINE_FILE`) fails the ordinary check, never silently disables the ratchet. Missing, nonnumeric, out-of-range, or below-enforced-floor entries for the derived enrolled set also fail. Bootstrap or refresh is a separate explicit maintenance operation via `scripts/maintenance/update-critical-coverage-baseline.ts`, not a checker fallback.
- The decoded coverage baseline must be a non-null JSON record; if it has a `files` envelope, that value must also be a non-null record. JSON `null`, arrays, primitives, and malformed envelopes fail nonzero before threshold checks rather than bypassing the gate.
- Runs ordinary coverage and ownership waivers through the same review queue: due reviews are advisory for 30 days, while invalid metadata, stale entries, and reviews beyond that grace period fail completeness.

Baseline maintenance requires a complete `coverage/lcov.info` for the current derived source set. Use `CRITICAL_COVERAGE_RATCHET_ALL=1 npm run coverage:critical` (or merge every shard of that same full source/test selection) before `npm run coverage:critical:update-baseline`; do not refresh from a touched-source PR report or one shard. The maintenance command replaces the map with rounded measurements for `CRITICAL_FILES`, so it can remove older entries outside today's candidate rules and lower existing values. Review against the branch's local base: add measured enrollments, remove only deleted or demonstrably non-critical sources, and preserve every existing floor. If a retained source measures below its baseline, restore behavioral coverage rather than accepting the lower measurement. A first enrollment run can pass all tests but fail baseline validation until the measured additions are recorded; rerun the ordinary coverage checker after the update.

The GitHub PR gate runs this lane whenever the diff touches an enrolled source or critical-coverage plumbing. Local `npm run check:pr` records it as `deferred-to-ci` unless `--with-coverage` is passed; then it measures only the touched sources' V8 coverage over the full owner suite. Use `npm run coverage:critical` directly for custom `CRITICAL_COVERAGE_*` controls.

Gate scripts and ownership:

- `scripts/lib/critical-ownership.mts` owns generated source-to-test ownership and the dated cutover gap waivers.
- `scripts/lib/critical-test-files.mts` owns the 31-file always-on contract set and builds full/touched Vitest arguments from ownership.
- `scripts/lib/critical-coverage.mjs` owns candidate discovery and the generated enrolled source set.
- `scripts/ci/check-critical-coverage.ts` owns threshold parsing, completeness enforcement, explicit per-file overrides, and touched-source ratchets.

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

- `npm run test:critical-contracts` runs the 19 existing contract entries; `npm run test:pr` composes those with the additional user-facing contracts into the exact 31-file always-on set, then adds changed tests and touched-source owners.
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

Suppressions require a scoped justification, never a blanket subsystem exemption. Flat-config rule options replace rather than merge; use existing composed constants when extending restrictions. Import boundaries, nullable supply admission and React purity remain governed by the root rules and their executable lint authorities.

### Zod Runtime Validation

Schema validation in hooks flows from each endpoint descriptor's `schema` through `useRegisteredApiQuery`; in `src/hooks/api-hooks.ts`, meta responses use `createApiPollingQueryOptionsWithMeta` and are normalized with `unwrapApiQueryWithMetaResult`. Use `rg "schema:" src/hooks src/lib` for the live callsite and schema set before adding or auditing endpoint validation; do not maintain a second response-schema inventory here.

When a schema is provided, frontend API helpers now validate in `strict` mode by default and throw on schema mismatch. Use `contractMode: "warn"` only for explicitly degraded surfaces where returning raw data is acceptable.

When adding a new API endpoint:

1. Define the response schema in `shared/types/index.ts` if the response has nested arrays or objects accessed via `.find()` / `.map()`
2. Attach the response schema to the descriptor consumed by `useRegisteredApiQuery`
3. Add a contract test in `worker/src/api/__tests__/` if the endpoint has multiple response modes

**Narrow-type gotcha:** If your response type uses string unions or branded types (e.g. `ReportCardGrade`), prefer the shared hand-written interfaces and keep any unavoidable schema wiring/casts localized in the consolidated hook module (`src/hooks/api-hooks.ts`).

**Worker CI note:** `shared/types/index.ts` imports `zod`, and the worker type-checks shared modules via the `@shared/*` path alias in the PR static gate (`npm run typecheck:worker`, selected when the diff touches worker paths) and in nightly validation, before a merge can reach the production deploy workflow. Root deps are installed first (`npm ci`) through the npm workspace so shared imports resolve from root `node_modules/`. If you add new npm packages imported at the top level of shared files, they do not need duplication in `worker/package.json` unless the worker uses a worker-local runtime/deploy path that genuinely requires it.
