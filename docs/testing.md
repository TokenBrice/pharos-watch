# Testing & Linting

> **Agent navigation** — Grep the heading you need instead of reading wholesale: Overview · [Pre-push readiness](#pre-push-readiness) · Commands · [Smallest adequate check per area](#smallest-adequate-check-per-area) · [Generated-artifact failure playbook](#generated-artifact-failure-playbook) · Source Formatting Policy · CI Pipeline · Vitest Runtime Profiling · Test Setup · Test Infrastructure · Test Inventory · Conventions · [Test-lane gate protocol](#test-lane-gate-protocol) · Coverage · Adding a New Test · ESLint Configuration.

## Overview

The project uses **Vitest** for unit tests and **ESLint** (via `eslint-config-next`) for linting. The shared validation suite runs on pull requests; the [release snapshot state machine](./deployment-process.md#release-snapshot-state-machine) owns protected-`main` and post-merge behavior.

`npm run lint` enforces the `shared/types/` and `shared/contracts/` dependency boundary through `pharos/shared-types-imports`: schemas and wire contracts must not import `shared/lib/`. `pharos/contracts-imports` additionally enforces exact package exports and package-local implementation dependencies. The source-only `@pharos/contracts` workspace resolves through the root npm install and lockfile, not TypeScript/Vitest/Wrangler aliases; typed lint includes its production sources.

## Pre-push readiness

Start with [focused authoring checks](#smallest-adequate-check-per-area); `npm run check:pr` is optional broader local feedback before pushing. Hosted CI is the readiness authority. Local receipts are optional diagnostics, not a push prerequisite. The repository installs no pre-commit or pre-push Git hooks and never stages artifacts automatically.

Use the exact `.nvmrc` Node and npm 11.x runtime, not merely an engine-compatible major; nested npm/`npx` commands must inherit it:

```sh
export PATH="${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims:$PATH"
mise settings add idiomatic_version_file_enable_tools node
mise install
npm run check:pr
```

Keep generated artifacts with their owning source changes and use `npm run check:generated-artifacts` to inspect convergence. Runtime and receipt mechanics are owned by [`runtime-guard.mts`](../scripts/lib/runtime-guard.mts), [`run-pr-checks.ts`](../scripts/maintenance/run-pr-checks.ts), and [`pr-check-receipt.mts`](../scripts/lib/pr-check-receipt.mts); generated owners live in [`automation-registry.mjs`](../scripts/lib/automation-registry.mjs).

The optional `.tmp/pr-check-receipts/<headSha>.json` diagnostic records `failed`, `incomplete` or `passed`; dirty/weak/skipped-required runs are incomplete, while CI-deferred Pages checks are not. [`pr-check-receipt.mts`](../scripts/lib/pr-check-receipt.mts) owns its schema and outcome rules. `check:pr -- --explain-receipt` only reads current-HEAD local evidence: it neither fetches/runs checks nor authorizes a push, and missing receipts are not blockers.

The local runner executes the secret, docs, static and selected-test leaves. CI-owned lanes include the classifier-selected `pages-artifact` lane: GitHub runs it on a dedicated runner and keeps it required, while the local receipt records it as `deferred-to-ci`. Add `--with-pages` for local Pages build/size/SEO diagnosis. Measured coverage is not a PR/local lane; use `CRITICAL_COVERAGE_RATCHET_ALL=1 npm run coverage:critical` directly for the weekly-equivalent measurement when changing coverage floors.

When CI fails, collect **every failed leaf**, reproduce narrowly, fix all causal defects in one revision, rerun focused checks, then push once. Use the [workflow incident runbook](./runbooks/workflow-incidents.md) for remote evidence and incident handling.

## Commands

Use the [validation command index](./scripts.md#validation-command-index) for command entrypoints and their canonical owners; this section owns what those validation lanes do.

[`run-pr-checks.ts`](../scripts/maintenance/run-pr-checks.ts) implements adaptive local feedback. It guards the pinned runtime, refreshes `origin/main` by default and freezes base/head; an explicit head must resolve to checked-out HEAD. It rejects `--staged` because execution reads the checkout, not the index. Dirty worktrees remain usable but produce incomplete diagnostics; disabled/failed fetching or stale base evidence weakens the result.

The shared [`pr-lanes.mts`](../scripts/lib/pr-lanes.mts) registry owns commands, selectors, partitions and timeouts. Local execution collects every independent leaf, including thrown failures, rather than stopping at the first defect. Unsharded tests and selected V9 probes share one serial track; secret/docs/static leaves share another. Opted-in Pages runs alone last because it overlays data and deletes build output. Internal-docs-only selection runs docs checks; mixed/source-owned docs checks appear once in expanded static leaves.

`check:pr -- --plan` prints the selection without executing checks or fetching; discovery may import modules. `--json` emits a machine report with progress on stderr. Plan/skipped/dirty/weakened results are not readiness proof. [`run-gitleaks.ts`](../scripts/ci/run-gitleaks.ts) owns the trusted committed local scan: frozen base scanner/policy runs range and merge-resolution scans before any candidate-policy comparison. It neither scans uncommitted bytes nor constructs GitHub's synthetic PR merge. See [security policy](./security-governance.md#ci-guardrails).

`check:release` is an optional production-build/Worker-bundle rehearsal, not the [protected release path](./deployment-process.md#release-snapshot-state-machine).

`npm run ci:census -- --since=YYYY-MM-DD [--until=YYYY-MM-DD] [--cut=YYYY-MM-DD] [--out=<path.json>]` uses authenticated `gh` for GET-only workflow/run/attempt/job evidence; it writes JSON and `<path.json>.md` when requested, otherwise prints both. It distinguishes latest run-ID conclusions from retained executions, censored branches, and annotation-backed cancellation classes; UTC cohorts are descriptive, not causal attribution. Failure categories require owner classification. Source: [`ci-failure-census.ts`](../scripts/maintenance/ci-failure-census.ts).

Use `package.json` for the full live npm-script list. `scripts/lib/automation-registry.mjs` owns generated artifacts and deploy-impact classification; `scripts/lib/critical-ownership.mts` derives critical source-to-test ownership, while `scripts/lib/critical-test-files.mts` and `scripts/lib/critical-coverage.mjs` consume it for critical-suite membership.

`npm run typecheck:tests` compiles the test entrypoints and TypeScript/TSX support files selected by `tsconfig.test-typecheck.json` under `functions/`, `scripts/`, `shared/`, and `src/`; Worker typing is separate. The lane runs in nightly/manual validation so shared fixtures and helpers cannot accumulate type errors outside Vitest's selected module graph.

Worker test fixtures compile against the Worker's ES2021 library, not the frontend's DOM/ESNext environment. Keep frontend content assertions in frontend suites, use the current production signatures for mocks, and narrow nullable publication identities before passing them to SQL or downstream generation helpers.

`check:verified-doc-links` validates local links, images, anchors **and cited source paths** using renderer-compatible Markdown/heading parsing. Absolute `https://pharos.watch/docs/<slug>/` links must resolve to a public-docs registry entry, and any fragment must match a heading in the rendered public Markdown; other HTTPS URLs remain external. Verified docs at or above 400 lines or 50 KB need a top `> **Agent navigation**` block; section-qualified ownership references are enforced separately by the doc-ownership registry test.

Changed-file classification retains deletions and both sides of cross-area renames; ordinary Git selection failures stop the check rather than producing an empty plan. Classification uses frozen base/branch-head refs; CI executes on a tested merge checkout, so import-graph test discovery inspects that tree while ownership selection retains the branch diff. Nonexistent test files are filtered only before execution. Generic parallel commands cancel and settle siblings on failure unless continue-on-error is explicit; the local PR runner instead collects every independent leaf. Sources: [`changed-files.mts`](../scripts/lib/changed-files.mts) and [`run-pr-checks.ts`](../scripts/maintenance/run-pr-checks.ts).

`check:doc-sync` owns source-backed generated contract blocks and runtime TOML snippet parity. Edit source constants and regenerate the reported blocks, never literal marker contents. `check:worker-config` separately owns configuration safety and Public/Heavy parity.

### Smallest adequate check per area

Use this hierarchy rather than maintaining area-by-area copies of the PR command graph:

1. **Route the change:** `npm run check:focused -- --file <path>`; add `--plan-only` to inspect without running. Repeat `--file`, select `--staged`, or use a frozen `--base` / `--head` range (`--base-ref` / `--head-ref` are aliases shared with `agent:route`).
2. **Prove behavior:** run the owning `npx vitest run <owning-test-or-directory>` when behavior changes or import-related discovery cannot cover runtime-loaded/source-inspecting contracts.
3. **Broaden optionally:** `npm run check:pr` collects adaptive local PR feedback; [hosted readiness](#pre-push-readiness) remains separate.
4. **Diagnose a generated artifact:** `npm run check:generated-artifacts -- --only=<id>` checks its exact owner; it is not a replacement for the preceding behavioral checks.

Focused baseline checks are synthesized from the shared PR selector, `selectPrBaselineChecks`, then combined with exceptional authored checks in [`doc-ownership.json`](./doc-ownership.json). Specific mappings take precedence over fallback mappings per path. Docs paths receive docs checks; generic frontend modules use related tests, while scripts and runtime-loaded contracts retain their explicit suite owners. Declared `testOwnership` adds source-inspecting invariants to PR selection independently of focused-tier precedence and missing declared tests fail closed.

Explicit paths share `agent:route` normalization (repository-relative, `./`, or absolute within this worktree). Outside-root paths fail. Unmapped paths report `routing-incomplete` and exit 1 even in plan mode; a mapped empty plan reports `intentional-no-check`, not verification. Zero related tests fails rather than certifying runtime-loaded behavior. Source: [`run-focused-checks.ts`](../scripts/maintenance/run-focused-checks.ts).

Focused lint receives the resolved paths as repeatable `--file` arguments. Bare `lint:changed` selects staged, unstaged and untracked worktree files; `--staged` selects index paths but still reads checkout contents. Range flags isolate a branch diff; deleted paths are excluded. Forward extra ESLint options after a second `--`.

### Generated-artifact failure playbook

Automatic drift plans filter both `checkable: false` and `ciDriftCheck: false` registry entries. These properties differ: explicit `--only=<id>` may check a checkable artifact excluded from automatic drift, while any explicitly uncheckable ID rejects the whole request before child execution. Empty automatic plans skip rather than imply freshness. [`automation-registry.mjs`](../scripts/lib/automation-registry.mjs) owns the selector and lifecycle guidance. History-derived build projections need full Git history; missing/shallow history fails rather than using filesystem timestamps.

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

Do not retry a history-derived check in a shallow checkout; obtain history and run the history bootstrap first.

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

The workflow YAML and shared selectors are executable authority: [PR](../.github/workflows/pull-request-checks.yml), [nightly/manual](../.github/workflows/nightly-validation.yml), [weekly](../.github/workflows/weekly-validation.yml), [`pr-lanes.mts`](../scripts/lib/pr-lanes.mts) and [`run-pr-static-checks.ts`](../scripts/maintenance/run-pr-static-checks.ts). Production mutation and acceptance belong only to [Deployment Process](./deployment-process.md#ci-deploy-sequence).

### PR outcomes and transport

| Owner | Required outcome |
| --- | --- |
| `secrets` | Snapshot trusted-base scanner/import closure/policy before candidate checkout; run one combined `--range --tree` invocation after merge checkout for commits and merge-resolution lines, then check changed candidate policy. Candidate policy cannot replace trusted success. |
| `prepare` | Freeze event base/branch-head identities, bootstrap full-history/offline inputs, classify the tested merge checkout, and serialize the selected test plan. Internal-docs-only PRs run shared docs checks inline instead of validation jobs; editorial-style changes retain full static selection. |
| `validation` | Restore the exact producer workspace; execute selected compile, guards, uninstrumented test partitions and V9 resource lane. Mixed/source-owned docs checks run once inside static guards. |
| `pages-artifact` | When selected, build and check without publishing or live refresh. Only trusted retained release-data replay may waive mirror wall-clock age, as described below. |
| `PR gate` | `always()` requires secrets/prepare success, selected jobs successful and unselected jobs explicitly skipped. Missing classification, failure, cancellation and unexpected skip all fail closed. |

The shared [command coordinator](../scripts/lib/command-runner.mts) fails cancelled nonempty selections even if no child starts or queued units remain after a passing child. Non-aborted failures outrank cancellation; omitted units never become passing result rows. Child cleanup/settlement and empty-selection neutrality remain part of the contract.

Adaptive test selection remains enabled. [`pr-test-selection.mts`](../scripts/lib/pr-test-selection.mts) selects affected tests, always-run contracts and critical/source-inspecting owners; [`pr-test-plan.mts`](../scripts/lib/pr-test-plan.mts) partitions sorted unique files deterministically round-robin into four shards for up to 800 files or eight above that. Shards validate the frozen base/count and execute explicit partitions without reselection or Vitest hash sharding. PR tests collect no timing telemetry and use no scheduling weights. `npm test` is the canonical full-suite command and nightly two-shard backstop; full-suite execution on every PR is not the current contract.

The producer-owned run/attempt/SHA workspace artifact transports dependencies, ignored bootstrap outputs and plan; consumers do not reinstall or infer their own artifact name. Changed tracked/checkable bootstrap output fails setup. Validation uses `max-parallel: 10`, `fail-fast: false`. Same-repository `$/` action/workflow references bind definitions to the workflow commit and require runner 2.336.0 or newer. **Re-run failed jobs** can reuse successful preparation; workspace retention is one day, after which prepare a new workspace/full run. A source fix needs a new revision.

Selected registry `requiredBrowsers` drives browser installation, never a second path roster. The required [V9 resource lane](#v9-resource-lane) is selected fail-closed for evaluator/catalog and conservative shared/Worker/data/toolchain families; nightly runs it unconditionally.

The Pages lane's frozen-base helper downloads and validates the newest unexpired successful-main `pages-release-data-<sha>` with GitHub credentials confined to acquisition. The token-free candidate consumes `PAGES_RELEASE_DATA_DIR`. Only after validated retained-data overlay may [`run-pages-artifact-lane.ts`](../scripts/ci/run-pages-artifact-lane.ts) set `PHAROS_PAGES_REPLAY=1`, waiving **only** `scores-latest` maximum wall-clock age. Invalid/future dates, provenance, integrity and artifact checks stay blocking; ambient replay flags are cleared. Missing/unavailable acquisition produces explicit `degraded-data` using committed/offline inputs, not realistic size proof or a freshness waiver. Invalid supplied data fails. Production deploy/rebuild and local `check:release` never enable replay.

### Scheduled validation

Nightly/manual validation collects all eight mandatory static outcomes after workspace success: lint, root typing, Worker typing, typed lint, test typing, structural, unused code and sensitive-page copy. Each runs with cancellation-aware independence so one failure cannot hide later leaves; the aggregate prints every outcome and fails unless all succeed. `check:unused-code` and `check:sensitive-page-copy` are dedicated nightly leaves, **not** PR structural guards. Full test execution and V9 resource validation remain separate required owners. Heap/runtime options and typed-lint scope are source-owned in [`package.json`](../package.json).

Weekly owns blocking all-critical measured coverage, reviewed full-lockfile/signature audit, full-history secrets, fixture age, dependency structural coverage and read-only account drift; Node 26 typing is advisory. Dependency reconciliation remains advisory and never admits edges: distinguish capture clocks from schema-validated publication identity/source generations and comparison checkout; missing legacy provenance is unknown and malformed supplied provenance is a tool error. CodeQL retains daily/Monday/manual security scanning. Failures surface through Actions/notifications; [Workflow incidents](./runbooks/workflow-incidents.md) owns evidence collection.

### Performance guardrails

- [`report-build-size.mjs`](../scripts/maintenance/report-build-size.mjs) blocks homepage raw HTML and eager-script gzip growth alongside the representative-detail ceilings, and eager-script gzip for `/depeg/`, `/safety-scores/`, `/stablecoins/`, `/status/`, `/screener/` and `/portfolio/` at measured export sizes plus 5% (rounded up to 1,000 bytes). Each route must emit HTML; per-route overrides use `PHAROS_SIZE_BUDGET_<ROUTE>_EAGER_JS_GZIP_BYTES` (uppercase, hyphens replaced by underscores). Overrides are `PHAROS_SIZE_BUDGET_HOME_HTML_BYTES` and `PHAROS_SIZE_BUDGET_HOME_EAGER_JS_GZIP_BYTES`; defaults live in the script. The public route inventory supplies required `/privacy/`, `/about/`, `/methodology/`, `/stablecoins/`, `/api/`, `/api/reference/`, `/docs/` and `/docs/<slug>/` HTML: missing documents or references to root `app/page-*` / `recharts-vendor-*` scripts fail. `/status/` also rejects `recharts-vendor-*`. Ordinary route-specific `app/privacy/page-*` chunks and deliberate chart-bearing routes remain valid.
- The PR Pages artifact lane audits `/` and `/stablecoin/usdc-circle/` with pinned `lighthouse:static` after artifact gates. Both scores/audits append to `GITHUB_STEP_SUMMARY`; low scores and probe failures are advisory, not hidden. Nightly repeats against an explicitly offline/degraded-data export and retains HTML/JSON reports. Neither local static-server lane measures production CSP, authenticated site-data transport or live readiness.
- **Lighthouse ratchet:** collect two weeks on the fixed runner/form factor/throttling mode, then set `PHAROS_LIGHTHOUSE_THRESHOLD` from measured p50 minus 10% and switch nightly `PHAROS_LIGHTHOUSE_ENFORCE` to `1`. Keep PR scoring advisory until runner variance is understood. The initial threshold is a diagnostic ceiling/floor choice, not a claim that production meets it; do not raise it or weaken byte budgets to absorb a regression.
- [`production-canaries.yml`](../.github/workflows/production-canaries.yml) captures cold, no-scroll home/USDT detail at 1440×1000@1, 1920×960@2, 2560×1300@1.5, 3072×1600@1.25 and mobile 390×844@3. [`probe-page-performance.mjs`](../scripts/maintenance/probe-page-performance.mjs) retains request records, decoded JSON bytes, request count, V9 request→headers wait, observed detail banner-clear time, standard maximum-session CLS and JS heap samples. Monday adds a 30-minute home dwell at 3072×1600@1.25 to admit rankings, with heap samples every ten seconds. Only cumulative JSON-byte/request-count ceilings are relaxed; failed JSON, still-visible banners, CLS and timing checks remain blocking. Wide initial budgets are source-owned regression tripwires, not production targets.
- A missing V9 request or unobserved banner transition is `not observed`, never a zero-duration success. Banner clearance does not establish that every section is fresh. A banner still showing at the observation deadline fails with an explicit instruction to inspect producer health; stale/failed producers must remain visible, not be hidden to pass timing checks. Decoded bytes are browser-delivered CDP body counters, not wire bytes or JS heap; unfinished requests can make byte totals lower bounds.
- The typed `fresh_data_ready` event measures the first admitted live, freshness-qualified homepage hero/detail summary, never a static/retained seed. Document timing starts at navigation; SPA timing starts at the router-observed path change (not the user's click), reported separately. The existing analytics host/path/privacy gates and GA configuration still apply, with no extra client analytics dependency. [`analyze:web-vitals`](./scripts.md#web-vitals-analysis) consumes gated RUM rather than treating a synthetic result as field evidence.
- The same canary independently runs [`check-live-api-cache-policy.mjs`](../scripts/ci/check-live-api-cache-policy.mjs): bounded, credential-free public GETs check direct exempt API responses and browser-shaped same-origin `/_site-data` responses. Source profiles retain their edge/SWR/no-store semantics; browser `max-age` must equal the profile value (origin miss) or the greater of the profile value and the manifest's operator-selected zone floor (edge hit). [Account drift and the accepted floor](./operator-origin-access.md#10-monitor-cloudflare-account-state-drift) are separate settings evidence, not a substitute for live headers.

### Structural and safety contracts

`npm run check:structural` executes **nine guards**, as declared by `--structural` in [`run-pr-static-checks.ts`](../scripts/maintenance/run-pr-static-checks.ts). All guards run, print collected individual outcomes and return nonzero if any fails. Test-only edits do not select the structural lane. Use the source for the guard list, not a copied command roster.

- SQL interpolation needs a directly preceding allowlist check on the expression or a leading `// SAFETY:` review attached to that SQL template or its containing statement/property; nearby reviews of other statements, sibling properties and callbacks do not establish safety. The fetch-body guard follows Response copies, alias chains and reassignment by symbol without a line cutoff or debt baseline.
- [`check-architecture-boundaries.ts`](../scripts/ci/check-architecture-boundaries.ts) owns five policies: `reserve-network` (reviewed network gateways), `frontend-routes` (no reusable-to-route graph), `verification-url` (scrubber required, no schema graph), `stability-light` (no full/Zod stability graph), and `telegram-public-surface` (exact external importer/entry pairs including authored type edges). Its resolver owns runtime forms, realpath and chains; unresolved/unconstrained/escaped loaders fail closed, types create no runtime edge, local workspace exports resolve as source and third-party packages are leaves. Transport safety has separate checks. Generic traversal tests remain after retiring the recap-only policy.
- Runtime reachability uses source-owned roots/policies, including the scheduled handler and dynamic runners. Missing roots or empty graphs fail; memory-sensitive mint/burn and Telegram graphs must exclude the full registry. [`boundary-waivers.md`](./process/boundary-waivers.md) owns reviewed exceptions.
- Deletions need independent closure proof or a `check:unused-code` artifact stamped for the exact dispatched commit, never an older/unstamped campaign artifact. Empty DEBT maps do not prove a clean detector scan. Useful test evidence stays in recognized sibling `*.test-support.ts`, not production DEBT or external-consumer blind spots.
- [Security governance](./security-governance.md#ci-guardrails) owns exact-value/path exceptions and trusted scanning. Gitleaks self-tests require public controls clean and AWS/generic controls at expected rule/path/line; hunk-aware extraction must preserve added `+` source, and merge-resolution scans include in-range merges. Historical fingerprints survive current-source cleanup; local trusted range is not expanded by the full-history environment switch.
- Dependency-input PRs compare full lockfiles against the frozen base and reject new high/critical advisory/package pairs or missing base evidence; production audit also runs. Reviewed exceptions, expiry/removal conditions and weekly full audit belong to [Dependency refresh cadence](./deployment-process.md#dependency-refresh-cadence).
- Cron sync compares raw trigger inventories (duplicates fail); connection budgets must identify the exact slot. `check:worker-config` owns configuration safety/Public–Heavy parity; doc-sync owns runtime TOML snippet parity. Shock freshness validates raw registry measurements before newest-row selection, reusing the V9 stress fact schemas for source/block clocks, complete measured provenance, blockers and replay attestations. Malformed rows and omitted, null or empty attestations for a claimed exact replay fail closed. Exact target enrollment, independent wall-clock checks and the half-policy-age refresh budget remain required independently of regeneration.
- Release/provider boundaries fail closed: detail snapshots admit only explicit 404/410 lane absence and require a lane per live asset; public depeg history requires complete ledger/window/year-shard evidence rather than an arbitrary row floor; pinned mechanism reads reject mismatched block headers. Safe Browsing admits only the documented empty-object clean response or validated `matches` envelope; error and unknown top-level fields fail even with HTTP 200.
- SEO enforces sitemap uniqueness/indexability, reviewed legacy-anchor rejection (the hand-kept retired prefixes plus every non-rewrite `_redirects` source: static sources exactly, `/*` splats by prefix), direct permanent redirects and published digest/depeg URL continuity; noindex pages may exist outside sitemap. Live smoke requires direct 200, `text/html` (optional media-type parameters), indexability and a self-canonical document with body-inclusive deadlines; missing or unexpected media types fail rather than skip validation. Search Console history is not proof of a fresh crawl. [`check-seo-static.mjs`](../scripts/ci/check-seo-static.mjs) owns artifact assertions.

Production [Telegram documentation](./telegram-alerts.md) owns delivery semantics; the `check:telegram-load` simulation gate was retired with the legacy pipeline. Provider-access restrictions and manual evidence capture belong to [protocol refresh](./process/protocol-api-mechanism-refresh.md); offline tests do not establish hosted regional access.


## Vitest Runtime Profiling

`npm run test:profile -- --output /tmp/pharos-vitest-profile.json` runs Vitest once with the JSON reporter, stores the raw Vitest report beside the requested output as `*.vitest.json`, and writes a durable summary to the requested `/tmp` path. The summary prints total files/tests, wall time, summed file/test time, node/jsdom split, top files, top individual tests, files above 10s, and tests above 1s.

Pass Vitest filters or options after `--` when narrowing or validating runner behavior:

```bash
npm run test:profile -- --output /tmp/pharos-src-profile.json -- --dir src
npm run test:profile -- --output /tmp/pharos-vitest-threads.json --baseline /tmp/pharos-vitest-profile.json -- --pool=threads
```

In CI, every Vitest runner that routes through `scripts/lib/vitest-ci-args.mts` — `npm run test:pr`, `npm test`, `npm run test:critical-contracts`, and `npm run coverage:critical` — appends `--silent=passed-only` unless an explicit `--silent` option is supplied. Set `PHAROS_CI_VITEST_COMPACT=0` to restore full console output while debugging.

`npm run coverage:critical` also forwards trailing Vitest options to the critical suite. Use this to validate candidate pool behavior before any global `vitest.config.ts` change:

```bash
npm run coverage:critical -- --pool=threads
CRITICAL_COVERAGE_RATCHET_ALL=1 npm run coverage:critical -- --pool=threads
```

## Test Setup

[`vitest.config.ts`](../vitest.config.ts) owns projects, aliases, environments, transforms and exclusions; [`scripts/lib/critical-ownership.mts`](../scripts/lib/critical-ownership.mts) owns executable test discovery. Read those definitions before choosing a runner, rather than copying configuration into prose. Prefer the established `*.test.ts` / `*.test.tsx` convention and lane-local `__tests__/` homes; runtime discovery does not imply test-typecheck coverage.

[`scripts/test/ensure-fresh-stablecoin-artifacts.ts`](../scripts/test/ensure-fresh-stablecoin-artifacts.ts) owns catalog bootstrap. Its ignored `.cache/vitest-stablecoin-artifacts/` metadata cache is a local shortcut, not content proof: changed or missing inputs/outputs invalidate it, and deleting it forces regeneration. Clean CI generation and content checks remain authoritative.

The required release runtime is the exact `.nvmrc` Node and npm 11.x runtime. The future-major weekly typecheck is advisory, not build/test/release qualification. Keep JavaScript/TypeScript source maps and Worker per-file isolation enabled; the catalog JSON transform deliberately omits synthetic named exports and unnecessary maps to avoid retaining an oversized transform graph.
The packed Worker full-catalog import is the narrow exception to JSON object loading: its exact Vitest alias uses `?raw` to match Wrangler's Text module, keeping one parse/decode path.

Pure Node suites may reuse processes; stateful exceptions require isolation. Worker and frontend suites retain isolation because they own module-level state; the native full-registry Safety pipeline uses its reviewed thread worker. jsdom is a per-file opt-in. If a Node suite fails only in a full run, fix module-state leakage or enroll it in the existing isolated project. Registry-mocking selector fixtures remove their mock and reset dependent modules after the suite so later snapshot census validation uses the real registry. Nested worktrees must not enter the parent checkout's corpus.

The accepted retained-pair replay case in [`replay-safety-score-v9.test.ts`](../worker/scripts/__tests__/replay-safety-score-v9.test.ts) verifies the complete embedded registry across export, replay, and rejection paths. It has an explicit 180-second per-test timeout, matching the heavy full-registry publication precedent in [`safety-score-v9-public-witness-texts.test.ts`](../worker/src/lib/__tests__/safety-score-v9-public-witness-texts.test.ts); V8 coverage and concurrent critical-suite work can push this case beyond 60 seconds. This does not change the global timeout or the separate V9 resource budgets.

The unsafe-boundary probe in [`eslint-config-ratchet.test.ts`](../scripts/__tests__/eslint-config-ratchet.test.ts) has an explicit 60-second per-test timeout for cold type-aware ESLint project initialization under coverage; it retains all unsafe-operation rejection and reviewed-decoder assertions without raising the shared default.

Optional Poppler (`pdftotext` and `pdfinfo` on `PATH`) enables RLUSD assurance PDF extraction cases; compiler/manifest parity remains unconditional without it.

Scheduled-slot topology is asserted once by [`worker/src/handlers/scheduled/__tests__/slot-registry.test.ts`](../worker/src/handlers/scheduled/__tests__/slot-registry.test.ts). Per-slot suites exercise gating/order semantics, not duplicate registry membership; state-dependent slots must still never lease an unplanned job. PSI recompute, replay and benchmark suites remain separate evidence for historical inputs, methodology-aware replay and crisis signatures.

### V9 resource lane

The `v9-resource` code lane runs once, unsharded, on its own validation runner for V9-impact PRs; nightly/manual validation consumes the same `npm run test:v9-resource` command unconditionally. The launcher runs the faithful `compute --guard` profile (all live phases observed, correctness/byte checks, and a separate natural 128 MiB run), then the independent nine-scenario contagion case at 256 MiB with coverage off and one Vitest worker. It automatically enforces `.ci/safety-score-v9-resource-budget.json` when a qualified file exists; while that file is absent, reports and summaries explicitly say **`policy: "unqualified"`** and do not assert phase budgets. An existing invalid or mismatched file is never treated as absent. Fresh invocation-bound resource evidence and the named contagion pass are required; optional historical capture checks may skip. PR artifacts retain both resource directories even on failure as `safety-score-v9-resource-<sha>-<run_id>-<run_attempt>` for 30 days, with a phase table in the job summary. Local feedback runs this once serially when selected; added cost is approximately 5–7 minutes **[INFERENCE]**.

The launcher pins the current harness revision and complete ordered phase set, not the report's own reduced declaration. Measurements share a 300-second overall deadline across bundling, fixture setup, live/natural probes and correctness children; `--deadline-seconds` may select at most 360 seconds. Every child is clamped to the remaining budget. `report.json` starts incomplete before work and is flushed between stages, retaining partial evidence and an explicit `wall-timeout` before the eight-minute lane cap. The independent contagion assertion remains 90 seconds with a 130-second child kill guard.

The V9 resource test's admission unit cases still execute in ordinary coverage. Its expensive `describe` is default-off before bundling/hooks; `npm test`, `npm run test:pr`, and the coverage runner override an ambient `PHAROS_V9_RESOURCE_LANE=1` so coverage never spawns those probes. The dedicated launcher owns the only opt-in. Canonical, contagion and optional capture children allow only path/home/temp/locale environment values, then explicit contagion/capture protocol values; native coverage, Node preload/inspector options and ambient probe selectors are not inherited.

A heap OOM or signal from the natural 128 MiB publication child is **memory evidence**. Wall timeout, protocol/configuration failure and infrastructure cancellation are **not heap-margin evidence**. Nothing is retried away. Isolation removes contention and inherited instrumentation as variables, not proof of Workers-isolate margin.

The publication byte regression guards are calibrated in `shared/lib/safety-score-v9-resource-bytes.ts`. Each canonical card is counted incrementally in UTF-8; its **106,404-byte calibrated cap** is the measured **85,123-byte** maximum plus `ceil(25%) = 21,281` bytes of detail-growth headroom. The aggregate early-warning ceiling preserves the [original calibration](https://github.com/TokenBrice/pharos-watch/blob/958a14cbcd2592e77ef52eaf3ea31f6b72c3dad5/worker/src/lib/__tests__/safety-score-v9-resource-budget.test.ts#L108-L112)'s relative headroom: `ceil10KB(8,158,138 × 7,100,000 / 7,029,184) = 8,250,000 bytes`. This remains strictly below the independent **9,200,000-byte** production raw cap; the natural 128 MiB gate is unchanged. The resource fixture imports the canonical **1,350,000-byte write ceiling** from `shared/lib/safety-score-v9-publication-limits.ts`. The codec suite admits a real gzip publication above that ceiling, rejects oversized writes, and measures a real envelope at the **1,400,000-byte read ceiling** against unchanged **1,900,000-byte stored / 2,000,000-byte D1** ceilings ([rollout and rollback](./worker-and-api-limits.md#safety-score-production-budgets)). These are serialized-detail regression bounds, not heap estimates or KV/D1 value-size limits. The correctness child reports `publicationBytes` (unit count, largest unit, calibrated unit cap, streamed total, aggregate regression cap and hard total cap) for live and natural runs; `summary.md` and the Actions summary show each separately. Missing metrics reject the lane.

Sharding is private and invocation-local. The publication compiler compresses each fully admitted asset immediately; immutable getter views and one decoded-asset cache retain complete values for cohort admission and digesting without retaining the decoded cohort. Before dependency/rank/common-mode planning, evaluation retains only the exact planning projection and existing compressed shards. It releases that projection before hydrating one asset at a time in the unchanged topological order. Evaluated upstreams retain their existing last-reader frontier. Public card drafts are likewise serialized one at a time while evaluation continues. The full response rehydrates only after evaluator scratch is released, then undergoes existing cross-card finalization/admission and atomic publication. The canonical writer already streams JSON chunks to gzip; it does not build a whole raw cohort string. No schema, schedule, binding or durable shard store changes. **The uninstrumented natural 128 MiB success is still the binding memory gate**, even when both byte checks pass.

`npm run measure:v9-resource -- --profile=compute --runs=1` remains a **non-gating Node diagnostic** unless supplied `--guard` or `--policy=.ci/safety-score-v9-resource-budget.json`. Explicit `--policy` always fails closed on a missing file; only the required lane's `--guard` mode permits an explicitly unqualified absent policy. `heavy-warm` initializes real native capture/transfer-materiality preparation roots and remains diagnostic only. Both profiles run two successive real compute publications against independent latest-schema SQLite copies: instrumented 256 MiB old-space with forced-GC phases, then uninstrumented natural-GC 128 MiB old-space. The current manifest is `post-p2`, anchored in the compact baseline loader and runner; removed decode phases are not zero-filled. The parent always writes `.tmp/safety-score-v9-resource/report.json`, including failures; ordinary measurements replace that directory. Preserve evidence elsewhere before comparison. Synthetic input size and evidence density are not production-size replay or capacity runway; publication bytes are measured, not a fixed claimed gap from production.

`npm run calibrate:v9-resource -- --runs=5` collects five independent live+natural compute measurements and writes **only a proposal** to `.tmp/safety-score-v9-resource/proposed-policy.json`, with distinct per-run reports and a checked-in-policy diff. It never writes `.ci/`. Review/copy only a qualified proposal: every phase must measure at most 110 MiB and all five natural 128 MiB children must succeed. Limits are `min(112 MiB, ceil256KiB(maximum + 2 MiB))`; 112 MiB is immutable. Five distinct report SHA-256s, harness/manifest, fixture identity, runner image/version (or local host description), Node/V8/esbuild/Wrangler versions and protocol fingerprint accompany it. Existing invalid policy, missing phases or identity mismatch fails closed; normal commands never adjust limits. A one-run smoke writes an unqualified proposal, not an accepted baseline.

Policy equality covers only deterministic build keys: harness/phase manifest, Node/V8/esbuild/Wrangler versions, platform/architecture, the `wrangler.heavy.toml` hash and fixture source/manifest identity. Runner image/version (including unavailable self-hosted values), package-lock/source hashes and protocol fingerprint remain recorded evidence, not reasons to reject an otherwise matching build. Calibration uses the same identity projection and prints evidence separately.

**The local Node resource policy is unqualified:** no phase-budget policy is checked in, by owner decision to retain upstream's unqualified lane rather than require identity-bound recalibration after fixture/data changes. The faithful natural 128 MiB run, complete phases and publication/correctness/byte checks remain enforced; phase budgets are not enforced without a qualified policy. The memory repair's five complete live+natural calibration runs measured a maximum of **107,505,384 bytes / 102.53 MiB**, below the unchanged 110 MiB prerequisite. Its subsequent qualified local guard measured **101.16 MiB peak / 88.65 MiB facts** before later curation invalidated the fixture identity. These are retained local measurements, not current policy qualification, growth-independent capacity or production Worker-isolate safety. Immediate per-asset compaction and all admission/evidence guarantees remain in place. The [immutable post-P2 failure record](https://github.com/TokenBrice/pharos-watch/blob/e4e09b34e3b43baadd656471b973c686b34c1c27/docs/testing.md#v9-resource-lane) remains historical evidence.

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

Cross-runtime adversarial inputs live in `shared/test-utils/boundary-contract-vectors.test-support.ts`: numeric availability, read outcomes and generation-bound clocks. Boundary suites supply independent public expectations; input sharing never supplies an oracle or replaces reviewed source/date fixtures.

A cron unit has one test home: tests for `worker/src/cron/<lane>/<module>.ts` live in that lane's own `__tests__/` directory, not in the flat `worker/src/cron/__tests__/` tree. Behaviour asserted through an adapter that is really owned by a shared executor (for example the adaptive multicall split) belongs to the shared unit's suite, with each adapter keeping only the wiring case that is adapter-specific.

Use one canonical behavioral owner per production unit and risk boundary under [Test evidence rules](#test-evidence-rules). Shared mechanisms are tested at their implementation, with consumers keeping wiring cases; merge ticket/review-named satellites into module-named owners rather than preserving duplicate suites. Before a cross-tree move, apply the [test-lane gate protocol](#test-lane-gate-protocol): executable project membership and exact-source ownership must move with the test.

### Frontend Test Setup Helpers (`src/test-utils/frontend.ts`)

Use [`src/test-utils/frontend.ts`](../src/test-utils/frontend.ts) for matchMedia, storage cleanup and Next Link mocks; keep a local mock only when its behavior genuinely differs. Import the Link mock inside a hoisted `vi.mock` factory. It forwards refs and ordinary anchor props; matchMedia accepts a boolean or query predicate.

### Mock D1 (`shared/test-utils/mock-d1.ts`)

Use [`shared/test-utils/mock-d1.ts`](../shared/test-utils/mock-d1.ts); unmatched SQL always throws. Prefer statement markers to broad substrings, and strict normalized matching for exact SQL contracts. A supplied `first: null` is an explicit empty result, not fallback inference.

For SQLite D1 fixture wrappers, use the structural `D1Database` interface from [`shared/types/cloudflare-runtime.d.ts`](../shared/types/cloudflare-runtime.d.ts), matching the shared SQLite adapter. Spreading a fixture typed as the Worker global abstract class drops its method types; preserve the structural fixture contract when overriding `batch`. Typed row builders used by `mockD1` must also satisfy its `Record<string, unknown>` row contract without weakening production row interfaces.

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

[`critical-ownership.mts`](../scripts/lib/critical-ownership.mts), [`critical-test-files.mts`](../scripts/lib/critical-test-files.mts) and [`pr-test-selection.mts`](../scripts/lib/pr-test-selection.mts) own discovery and selection. [Critical coverage](#critical-coverage-gate) distinguishes ownership from measured percentages; [Test evidence rules](#test-evidence-rules) govern retention. Enroll production-gate contracts in executable selection, not a prose roster.

## Conventions

### What to test

- Prefer deterministic shared/frontend derivations and explicit API response-mode contracts.
- Use pure/server-rendered frontend tests by default; opt into jsdom only for valuable DOM coupling. Mock external service boundaries, not live providers.
- Persistence semantics require [`latest-schema-sqlite.ts`](../shared/test-utils/latest-schema-sqlite.ts); strict D1 doubles are suitable only when SQL semantics are irrelevant.
- Boundary representatives, normal/fallback/cache failure scenarios and independent expected outcomes follow [Test evidence rules](#test-evidence-rules); harness setup is not a second evidence policy.

### Default test boundaries

Use the runtime's existing test project and harness. Source-only, class-token and editorial assertions do not substitute for observable runtime/browser behavior.

### Degraded-mode testing convention

Test normal success, primary source failure/timeout, stale or unavailable cache and decision boundaries. Use deterministic clocks and scripted transport outcomes; assert the reason, fallback/publication outcome and retained last-good state, not merely no throw or a defined return.

Freshness fixtures that require a specific age band should supply explicit producer budgets instead of assuming an elapsed day exceeds the cadence-derived defaults. Numeric boundary fixtures must account for the actual unrounded unit conversion: a percentage converted to a ratio and back may land just below the original cutoff. Keep direct exact-cutoff cases in the classifier's owning suite and assert badge/gauge agreement on the converted raw value.

### Registry Guardrails

- The [Operator CLI Contract](./scripts.md#operator-cli-contract) owns what `npm run check:cli-args-policy` verifies; `check:structural` enforces it for affected PR paths and nightly/manual validation, and it can also be run directly when CI/operator scripts change.
- `npm run audit:coverage -- --domain=oracle-risk` always blocks on missing or structurally incomplete CDP oracle profiles and required branch evidence. The retired `--advisory` option is rejected, including through the generic coverage-audit wrapper, which forwards child arguments and propagates failures.
- Oracle stale-review reminders and the reviewed applicability queue remain advisory findings, not a structural exit-success bypass. `--stale-days=<positive integer>` controls the reminder age (default: 180 days). Explicit unresolved dispositions remain V9 blockers rather than silently passing as profile-only evidence; the shared stablecoin-data analyzer stays blocking independently.
- Domain behavioral owners are discovered through the executable [test inventory](#test-inventory), not restated here.
- `npm run check:stablecoin-data` has an advisory warning lane alongside its blocking errors. Warnings print to stdout, do not increment the error count, and never fail the gate; the footer reports `OK (N warning(s))`. It currently carries the collateral-prose drift report (`shared/lib/stablecoins/collateral-prose-reserve-drift.ts`), which flags a `collateral` string naming a tracked ticker that appears in no reviewed reserve slice. It is advisory by design: legitimate prose names non-reserve entities constantly — look-through naming and prose-vs-slice taxonomy differences are the noise floor — so only clauses carrying eligibility modality are reported per coin, and the rest collapse to a single count. Treat a new tier-1 warning as curation work, not a build break.
- `npm run audit:coverage -- --domain=redemption-backstops` validates the redemption-backstop registry split across `shared/lib/redemption-backstop-configs/*`, catches duplicate IDs across modules, and enforces allowed route-family membership per module; inventory counts belong to the registry, not copied documentation totals.
- `npm run audit:coverage -- --domain=redemption-coverage` unconditionally evaluates source-reviewed dispositions for active unconfigured assets in `shared/data/coverage-dispositions/redemption-coverage-dispositions.ts`, with or without `--check`. It rejects missing, duplicate, unknown, inactive, configured-stale, and malformed reviews and ranks the queue by canonical market-cap order. `--check` changes presentation only; a reviewed nonzero backlog passes either mode. `--strict-active-gaps` independently escalates active gaps. Backlog size is curation work, not a merge failure.

### Test-lane gate protocol

A commit that deletes, renames, or merges test files carries the gate artifacts those files appear in, in the same commit:

- **Provider resilience** — `scripts/lib/provider-resilience-registry.mjs` lists exact `tests` paths per surface; a renamed or deleted path fails `npm run check:provider-resilience` with `missing-test-file`.
- **Critical ownership** — `scripts/lib/critical-ownership.mts` derives source-to-test ownership from each test's import specifiers, so a merge that removes the last importing test for an enrolled source silently drops ownership. Run `npm run check:critical-coverage-completeness` and confirm every source the deleted tests imported still has an importing test; do not close the gap with a waiver.
- **Executable test selection** — `assertExecutableTestFiles` requires every selected path to exist and to belong to exactly one Vitest project, so a deleted or moved entry of `CRITICAL_CONTRACT_TEST_FILES` / `ALWAYS_RUN_TEST_FILES` in `scripts/lib/critical-test-files.mts` fails selection before any suite runs. A cross-tree merge (for example `worker/` into `shared/`) can trip this even when coverage is preserved; move the entry with the file.

No waiver or enumerated path is relaxed to accommodate deletion; migrate every enumerated path in the same commit. Any proposed floor decrease must satisfy the explicit, expiring reviewed-record protocol in [Critical Coverage Gate](#critical-coverage-gate); no cleanup transition is currently active.

### Test style

- Use `describe` per function, `it` per behavior.
- Test names describe the behavior, not the implementation: `"returns null for undefined input"` not `"calls sumPegBucketsOrNull with undefined"`.
- Use `makeStablecoin()` / `makeStablecoinMeta()` from `shared/test-utils/stablecoin.ts` (see `shared/lib/__tests__/supply.test.ts`) for partial `StablecoinData` mocks — avoids `as any` casts.
- Use shared fixtures from `worker/src/test-helpers/__shared/fixtures.ts` for DB row mocks.
- Keep cases focused and parameterize repeated scenario scaffolding. Canonical ownership, independent expectations and deletion evidence follow [Test evidence rules](#test-evidence-rules); shared setup follows [sibling test-support modules](#sibling-test-support-modules).
- Keep real-child CLI rejection cases separate from successful multi-command round trips. Share fixture construction, not mutable execution state, so process-startup costs for independent failure scenarios do not accumulate inside one test deadline; retain the existing command limits and every rejection assertion.
- Mock lazily loaded frontend sections by module (`vi.mock("./detail-lazy-sections", …)` with one stub per exported section name), never by `next/dynamic` loader source text or `dynamic()` call order — an ordering-keyed mock silently mis-assigns stubs when a section is added or reordered.

### Test evidence rules

Apply these rules to new and edited tests:

- **Assert consumer-observable behavior.** A test earns its place by failing when something a consumer observes regresses — a return value, rendered output, or persisted state — not when an internal detail changes.
- **Keep one home per unit/risk boundary.** Retain representatives for unavailable/non-finite inputs, observed zero, negatives, empty inputs and threshold edges when they change behavior. Share construction, never the oracle; expected deployment identities, payloads and SQL outcomes must be independent of production values.
- **Prove degraded outcomes.** Cron/API failure cases assert explicit reasons, unavailable versus empty/zero, absence of optimistic writes and retained last-good state in real SQLite when persistence matters.
- **Assert database outcomes, not statement shape.** SQL text, placeholder order, bind indexes, and prepared-call counts are implementation details. Seed the latest-schema SQLite fixture, run the unit, and select the persisted row by semantic column; use marker-matched strict D1 doubles only when the test does not depend on SQL semantics. Query-plan assertions are reserved for cases where index choice is itself the contract.
- **Prefer registry invariants to registry transcriptions.** Assert that every entry is retrievable by its own key and satisfies cross-row or cross-module constraints; do not copy authored keys, ordering, or row fields into expected-value tables.
- **No source-text, class-token, or prose pins.** Unit tests do not pin source strings, CSS class tokens, or editorial prose; such assertions churn on harmless edits while missing real regressions. Styling and layout claims belong in browser coverage, and source-structure scanning stays in its syntax-aware owner.
- **`test.fails` only with an `// audit:` comment.** An `it.fails`/`test.fails` marker must carry an adjacent `// audit: <finding> — <explanation>` comment recording the disputed or policy-deferred production defect it reproduces; it pins known-wrong current behavior and is never a way to leave a broken assertion green.
- **Deletions name their evidence.** Protected behaviors require a named surviving path and exact test title. Nonprotected tests/fixtures may be deleted with a reviewed META-TOOLING, DEAD-SUBJECT, TYPE-RESTATE, INCIDENTAL, or duplicate-behavior rationale stating remaining detection paths.

## Coverage

`npm test -- --coverage` produces V8 text/LCOV evidence; there is no full-suite percentage gate. PRs enforce ownership completeness and uninstrumented adaptive execution. Weekly/manual `all-critical-ratchet` is the sole measured gate for the full derived critical-owner source set.

### Critical Coverage Gate

[`critical-coverage.mjs`](../scripts/lib/critical-coverage.mjs) discovers high-stakes candidates; [`critical-ownership.mts`](../scripts/lib/critical-ownership.mts) derives executable exact-source importing tests. Type-only/mock-only imports do not establish ownership, and a barrel import does not enroll its implementations. The [V9 resource lane](#v9-resource-lane) keeps admission unit cases here but runs expensive probes separately.

[`check-critical-coverage.ts`](../scripts/ci/check-critical-coverage.ts) owns **constant per-file line and branch floors**, with no per-file environment overrides. `CRITICAL_COVERAGE_THRESHOLD` still controls the general line threshold (default 40%); named floors take precedence. The source tables, not copied env rosters, define named minima. Weekly `CRITICAL_COVERAGE_RATCHET_ALL=1 npm run coverage:critical` adds missing-source checks and all-source no-regression against [`.ci/critical-coverage-baseline.json`](../.ci/critical-coverage-baseline.json). Candidate discovery and ownership are not measured coverage or authority to lower a floor.

Completeness also compares the committed baseline against a real frozen comparison base, even without LCOV, so deferred weekly measurement cannot bypass review of PR floor decreases. Missing/invalid/all-zero comparison refs fail closed. Local runners pass their frozen refs; direct invocations may set `CRITICAL_COVERAGE_COMPARE_REF`. A missing, null, malformed or below-minimum baseline fails rather than disabling enforcement.

Ownership waivers name a reason and review date; draining one needs a used exact-source behavioral import, not a renewed waiver. Denominator waivers are only genuine forwarding/config facades with an enrolled implementation and executable importing owner test, not a missing-test backlog. Runtime decisions require the facade's own tests. Both queues advise due reviews, but invalid/stale metadata or reviews more than 30 days overdue fail completeness; changing an owner needs path-specific review, not automatic renewal.

**Baseline maintenance:** first generate complete current-set LCOV with the all-critical command, then run `npm run coverage:critical:update-baseline`. Never refresh from partial reports. Ordinary updates preserve the maximum of existing floor and rounded measurement, add measured enrollments and remove only deleted or demonstrably noncritical sources. An initial enrollment may need a measured baseline addition before the ordinary gate can pass; rerun that gate after maintenance.

Floor decreases require explicit `--rebaseline=.ci/critical-coverage-rebaseline/<wave-id>.json` and a matching committed, unexpired reviewed record validated by [`critical-coverage-rebaseline.mts`](../scripts/lib/critical-coverage-rebaseline.mts). The record binds frozen revisions, full before/after commands and LCOV hashes, run evidence, owner/reviewer approval and expiry, and exactly the decreased sources with rationale and removed/surviving test paths/titles. New floors must equal measured-after results without crossing constant minima or lowering branch floors. Protected behavior or a decrease of at least one percentage point needs a named surviving behavioral owner. There is **no active cleanup-transition record**; without newly reviewed authorization, restore detection rather than accepting a lower measurement.

Runner concurrency, LCOV parsing, baseline schema and supported scope/ref controls are source-owned by the checker and [`run-critical-coverage.ts`](../scripts/maintenance/run-critical-coverage.ts). Keep per-file percentages and parser/schema inventories out of this page.

### Critical Test Suites

[`critical-test-files.mts`](../scripts/lib/critical-test-files.mts) distinguishes the focused `CRITICAL_CONTRACT_TEST_FILES` runner from `ALWAYS_RUN_TEST_FILES`, which PR selection always includes before affected owners and dependencies. `npm test` runs the complete suite. Use [focused authoring](#smallest-adequate-check-per-area) and [`package.json`](../package.json) rather than a second command roster.

[Production Canaries](../.github/workflows/production-canaries.yml) runs daily at 06:37 UTC/manual with independent authenticated full API/OG contracts, Chromium Pages assets and HTTP-to-HTTPS transport probes. Missing API credentials fail; any probe failure fails its job/run. Browser smokes cover hydrated behavior/assets, not unit-test source shape. The local Pages wrapper requires its owned export server and built output; missing output, occupied explicit ports or early child failure cannot pass readiness. Canaries are read-only monitors, not deployment/rollback triggers or post-deploy acceptance.

## Adding a New Test

Colocate with the owning module or established lane-local test directory. Frontend imports use canonical frontend/shared boundaries; Worker imports stay relative. Shared scaffolding follows the [sibling test-support module convention](#sibling-test-support-modules).

API contracts validate response schemas and use existing typed row fixtures. Cron contracts assert normal/degraded reasons, unavailable inputs, no optimistic publication and retained last-good state. No-throw or defined-return assertions are not degraded-mode evidence; SQL publication tests assert retained rows and absence of new writes in real SQLite.

Use the actual [`blacklist.test.ts`](../worker/src/api/__tests__/blacklist.test.ts) and [`snapshot-psi.test.ts`](../worker/src/cron/__tests__/snapshot-psi.test.ts) behavioral owners as examples, not copied tutorial tests. Run the owning file and [focused feedback](#smallest-adequate-check-per-area) during authoring; [readiness](#pre-push-readiness) remains a separate contract.

## ESLint Configuration

[`eslint.config.mjs`](../eslint.config.mjs) and [`eslint.typed.config.mjs`](../eslint.typed.config.mjs) own scopes, rules and exclusions; do not duplicate their rule tables, allowlists or ignored-path arrays. Typed unsafe-value and promise rules remain blocking in configured scopes. Decode external data as `unknown` and validate it at the typed boundary.

The inherited Next plugin scope includes CommonJS source files so global React Hooks rule overrides always resolve their plugin. Frozen, compiled compatibility-reader fixtures are excluded from source linting to preserve their historical bytes; config regression tests cover both boundaries.

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
