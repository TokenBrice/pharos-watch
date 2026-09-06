# Testing & Linting

> **Agent navigation** — Grep the heading you need instead of reading wholesale: Overview · Commands · [Smallest adequate check per area](#smallest-adequate-check-per-area) · [Generated-artifact failure playbook](#generated-artifact-failure-playbook) · Source Formatting Policy · CI Pipeline · Vitest Runtime Profiling · Test Setup · Test Infrastructure · Test Inventory · Conventions · Coverage · Adding a New Test · ESLint Configuration.

## Overview

The project uses **Vitest** for unit tests and **ESLint** (via `eslint-config-next`) for linting. The shared validation suite runs on pull requests; the [release snapshot state machine](./deployment-process.md#release-snapshot-state-machine) owns protected-`main` and post-merge behavior.

## Commands

Use the [validation command index](./scripts.md#validation-command-index) for the discoverable command roster; this section owns what those validation lanes do.

`check:pr` is the adaptive local PR contract. It refreshes `origin/main` before classification by default (`--no-fetch` or `PHAROS_PR_NO_FETCH=1` skips the fetch), warns when the resolved base commit is more than 24 hours old, runs the pinned Gitleaks scanner over `base..head`, and executes the deploy classifier with bare Node exactly as CI does. `scripts/lib/pr-lanes.mts` is the single lane, command, shard-count, selector, and timeout manifest consumed by both this runner and the generated GitHub Actions matrix; local critical coverage is the manifest's unsharded form. The docs lane runs for any PR that touches verified docs; docs-only PRs skip the static and test jobs. Other diffs run changed-file ESLint, source typing (including generated Next route types), baseline repository checks, high-stakes coverage-waiver completeness, Pages/Worker guardrails selected from the diff, structural guardrails for affected production or validation paths, critical plus Vitest-affected tests, and generated artifacts selected from their registered sources. The static runner also selects `check:doc-sync` whenever a changed source matches a `docs/doc-ownership.json` mapping with owned docs, even if no Markdown changed. In a composed plan that also runs the docs lane (mixed docs/source PR), that lane owns `check:doc-sync` and the static lane receives `--skip-doc-sync`, so doc-sync executes exactly once per plan; standalone `check:pr:static` never receives the flag and keeps its own doc-sync selection. When an enrolled critical source changes, `check:pr` also runs `coverage:critical` against the base SHA; `--skip-coverage` suppresses only that local rehearsal and does not affect the [protected PR gate](./deployment-process.md#release-snapshot-state-machine). Pages-surface changes print a reminder to consider `SEO_PREVIOUS_SITEMAP_URL=https://stablecoin-dashboard.pages.dev/sitemap.xml npm run check:release` before a release batch. `check:bootstrap` rehearses a clean CI bootstrap from committed state, verifies every `@/generated/*` import resolves, and always restores the set-aside bootstrap-owned outputs afterwards, so the rehearsal leaves the working tree unchanged. `test:all`, full lint, typed lint, test-file typechecking, the structural guardrails, and the Node 26 compatibility proof run nightly or on manual dispatch. `check:release` is the optional local production-build and Worker-bundle rehearsal; it does not replace the [protected release path](./deployment-process.md#release-snapshot-state-machine). Pass `--json` to `check:pr` or `check:pr:static` for the stable lane envelope; progress goes to stderr and the JSON report goes to stdout.

Use `package.json` for the full live npm-script list. `scripts/lib/automation-registry.mjs` owns generated artifacts and deploy-impact classification; `scripts/lib/critical-ownership.mts` derives critical source-to-test ownership, while `scripts/lib/critical-test-files.mts` and `scripts/lib/critical-coverage.mjs` consume it for critical-suite membership.

`check:doc-symbols`, included by `check:doc-sync`, uses ripgrep when available and falls back to an in-process scan of the same Git-listed source files on minimal CI runners.

`check:doc-sync` also verifies generated contract blocks: `scripts/lib/doc-sync/contract-blocks.ts` renders every source-backed literal (thresholds, weights, TTLs, methodology versions) between `<!-- GENERATED-START: <id> -->`/`<!-- GENERATED-END: <id> -->` markers, and the check fails with the expected block when a doc's marker content drifts from the source constant. Edit the source constant, then paste the reported expected block; never hand-edit the value inside the markers.

### Smallest adequate check per area

Use `npm run check:focused -- --file <path>` to route one path through the change contract and run the checks selected by its ownership mappings, preferring specific-tier mappings over fallback-tier mappings for each path; add `--plan-only` to inspect the plan without executing it.

| Area | Smallest adequate local recipe | Conditional additions |
| --- | --- | --- |
| Shared `shared/lib` change | `npm run lint:changed`; `npm run typecheck`; `npm run typecheck:worker`; `npx vitest run shared/lib` | Add `npm run check:stablecoin-data` for catalog/data semantics; run `npm run test:pr -- --base=<ref>` when the change touches critical consumers. |
| Worker cron change | `npm run lint:changed`; `npm run typecheck:worker`; `npm run check:cron-sync`; `npm run check:cron-connections`; `npx vitest run worker/src/cron worker/src/handlers/scheduled` | Add `npm run validate:worker-scheduled-smoke` for dispatch wiring and the focused cron test when a specific source mapping supplies one. |
| `src/components` change | `npm run lint:changed`; `npm run typecheck`; `npx vitest run src/components` | Add `npm run check:table-primitives` for table markup/primitives; route/public-surface changes need the page-specific registry/CSP/SEO checks. |
| API route (`worker/src/api` or `functions/`) change | `npm run lint:changed`; `npm run typecheck`; `npm run typecheck:worker`; `npm run test:critical-contracts` | Add `npm run test:pr -- --base=<ref>` when dependency-selected or multi-mode contract coverage is needed. |
| D1 migration | `npm run lint:changed`; `npm run typecheck:worker`; `npm run check:migrations`; `npx vitest run worker/src` | Add the affected API test under `worker/src/api/<relevant>.test.ts` when runtime behavior changes; run `npm run test:pr -- --base=<ref>` for critical consumers. |
| Stablecoin JSON (`shared/data/stablecoins/**`) | `npm run lint:changed`; `npm run check:stablecoin-data`; `npm run check:generated-artifacts -- --only=stablecoin-client-projections`; `npm run typecheck`; `npm run typecheck:worker`; `npx vitest run shared/lib/stablecoins shared/lib/__tests__/stablecoin-id-registry.test.ts` | Add the focused catalog/registry test; `check:pr:static` also selects page and Worker checks because stablecoin data is a deploy-impact shared path. |
| Docs-only change | `npm run check:verified-doc-links`; `npm run check:doc-source-paths`; `npm run check:doc-sync`; `npm run check:generated-artifacts -- --only=agents-doc` | This is the exact CI docs lane and applies to internal docs as classified by the deploy-impact rules. |

### Generated-artifact failure playbook

A `check:generated-artifacts` failure naming a `checkable: false` artifact is not ordinary freshness drift: the registry intentionally excludes that build-time projection from check-mode selection. `sitemap-dates` and `docs-metadata` have `inputState: "build-time"` and `reproducibility: "git-history-derived"`; their dates require full Git history.
A shallow checkout or missing history therefore fails fast instead of using unsafe filesystem timestamps.

For ordinary bootstrap-safe artifacts:

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

## CI Pipeline

Workflow YAML is the source of truth. The main validation files are `.github/workflows/pull-request-checks.yml` and `.github/workflows/nightly-validation.yml`; the [CI deploy sequence](./deployment-process.md#ci-deploy-sequence) owns the production workflow inventory and ordering.

For deployment/worktree operating procedure, secrets, and rollback, see [Deployment Process](./deployment-process.md).

CI shape:

1. Internal-docs-only PRs run verified-link, source-path, doc-sync, and the generated `AGENTS.md` mirror check. `docs/editorial-style.md` is excluded from this lane so its registered generated module is checked by the full static artifact selection.
2. A dependency-free `preflight` checkout runs the deploy-impact classifier and strict pinned Gitleaks range scan without `npm ci`, then generates the selected matrix from `scripts/lib/pr-lanes.mts`. One `prepare` job performs `npm ci` and both generated-artifact bootstraps; its SHA-keyed cache of `node_modules` and bootstrap outputs is restored by every matrix and coverage-merge job. Other PRs then run `check:pr:static` plus four shards of `test:pr`; docs-only PRs generate only the docs matrix entry. When the docs lane is also selected (mixed docs/source PR), it owns `check:doc-sync`; the static job then receives `--skip-doc-sync` through the generated matrix so doc-sync executes once per PR. Jobs that require complete history use a blobless full-history checkout, retaining exact history-derived projections and merge-base coverage while avoiding transfer of unneeded historical file contents. The static runner always checks changed-file lint, table-primitive usage, generated Next route types plus source types, environment/import contracts, high-stakes coverage-waiver completeness, and documentation ownership obligations. Root `package.json` or `package-lock.json` changes also run the production-scope dependency audit. Independent TypeScript, structural, and generated-artifact checks run in a bounded parallel lane while the inexpensive checks stay ordered. Firefox is restored and installed only when the selected generated artifacts include a Firefox-rendered OG family. The runner adds data and Worker/Telegram checks only for relevant paths. Generated-artifact freshness is selected from the changed sources themselves through `scripts/ci/select-generated-artifacts.mts`, in every lane rather than only when a Pages surface moved, so a Worker-only or shared-only commit that leaves a manifest-pinned artifact such as the Safety Score V9 evaluation-build manifest stale fails the PR gate rather than the release discovery gate. `test:pr` unions the critical API contract list with Vitest's dependency-selected changed tests. When an enrolled critical source or the critical-coverage plumbing changes, up to four blobless full-history coverage shards upload Vitest blob reports even when a shard fails; preflight caps that matrix at the number of selected owner test files. The merge job reconstructs one `lcov.info` and runs the unchanged PR-base touched-file no-regression ratchet. PRs that change GitHub workflows or composite actions also run the path-scoped Zizmor analysis before merge.
3. Nightly/manual validation runs full lint, typed lint, all TypeScript projects, `check:structural`, the complete two-shard Vitest suite, and the non-blocking Node 26 proof. CodeQL runs after relevant `main` changes and weekly; Zizmor analyzes relevant pull requests, relevant `main` changes, and its weekly backstop. The weekly/manual all-critical coverage ratchet is blocking. The separate weekly Cloudflare account-state workflow compares the committed secret-free manifest through read-only API requests and fails clearly if `CLOUDFLARE_ACCOUNT_STATE_DRIFT_API_TOKEN` is not configured.

Broad UI, accessibility, ops, analytics, asset-coherence, and transport checks remain PR, scheduled-monitor, or explicit operator commands; they do not control production mutation or automatic rollback. The [CI deploy sequence](./deployment-process.md#ci-deploy-sequence) owns the post-merge build, deploy classifier, migration, activation-marker, release-marker, and cache-separation facts.

The [generated-artifact registry mechanics](./scripts.md#build-and-generated-artifacts) own lifecycle and automatic-staging facts; the failure playbook above owns checkability and history-input behavior, while the [CI deploy sequence](./deployment-process.md#ci-deploy-sequence) owns build and release ordering.

Telegram load protection is selected into `check:pr:static` by `scripts/lib/telegram-load-guard.mts` and also runs weekly/manual. `npm run test:critical-contracts` remains a focused local runner; the PR runner always includes those files.

Selected specialized checks:

- Cron schedule/connection changes: `npm run check:cron-sync`, `npm run check:cron-connections`, and `npm run validate:worker-scheduled-smoke`.
- Worker deployment configuration: `npm run check:worker-config` verifies that production custom domains remain root-owned and asset rules fall through.
- Structural guardrails: `npm run check:structural` runs the Worker raw-console usage, clone-ratchet, provider resilience, fetch-body timeouts, runtime reachability, script entrypoints, CLI argument policy, stale feature-flag, hook polling-window, dependency review-gap, unused-code, sensitive-page-copy, and agent-skills checks. It is enforced for affected production and validation paths in PR static validation and for every nightly/manual validation run. The runtime reachability checker owns the bundle-graph policies, including the memory-sensitive mint/burn and Telegram lanes whose entrypoints it bundles so the evidence-rich full stablecoin registry cannot re-enter their runtime module graphs. The individual commands remain available for focused local diagnosis.

For test-only changes, structural validation runs only `check:clone-ratchet` and `check:cron-console-usage`.
- Table primitives: `npm run check:table-primitives` rejects raw `<table>` markup and direct shadcn table imports under `src/`, allowing them only in the shared primitives under `src/components/table/`, the chart data table, and test fixtures. It is listed unconditionally in `check:pr:static` rather than inside `check:structural`, so a table change is gated even when no structural path moved. `npm run check:table-primitives -- --inventory` reports every table call site with its chrome, density, accessible name, and mobile-hint state and never fails; [design-language.md](./design-language.md) owns the rule itself.
- Generated public artifacts: `npm run check:generated-artifacts`, with individual checks in `scripts/lib/automation-registry.mjs`.
- Static export SEO: `npm run seo:check`; this includes unique sitemap-location enforcement, built-anchor rejection for reviewed legacy aliases, and one-hop/permanent checks for internal `_redirects` rules. Its per-page HTML extraction uses bounded worker threads while all global graph, sitemap, header, and continuity assertions remain consolidated in the parent process. Releases additionally set `SEO_PREVIOUS_SITEMAP_URL` so the same command rejects disappearance of deployed digest/depeg URLs unless an explicit direct 301 preserves the route. Live SEO smoke is `npm run seo:live-smoke -- --url https://pharos.watch` and enforces sitemap uniqueness against production.
- Static export accessibility: `npm run test:a11y` scans the bare static export, while `npm run test:a11y:hydrated` reuses the API-backed static-export smoke server so axe sees hydrated product data. Both run route-per-test with 3 Playwright workers (`fullyParallel: true` in `playwright.config.ts`); the scans are independent per route, so parallelism changes no coverage.
- Operator workspace browser checks: `npm run test:ops-browser` runs `tests/visual/ops/ops-routes.spec.ts` under the second Playwright config, `playwright.ops.config.ts`. It serves the static export on `OPS_PLAYWRIGHT_PORT` (default `4174`) and resolves `ops.pharos.watch` to `127.0.0.1` inside Chromium, so no hosts-file entry is needed; set `PLAYWRIGHT_REUSE_OPS_SERVER=1` to attach to an already-running `npm run serve:static-export`. The suite runs a six-viewport matrix from 320px to 1440px, but `@phase6`-tagged tests (200% text zoom, `prefers-color-scheme`, forced colors, reduced motion) are excluded from every project except 390px, so those assertions are proven at one viewport only. Workspace routes are driven by fixture API responses and a fixed clock, which means it covers operator route, layout, and a11y behavior and proves nothing about live operator data or the Cloudflare Access posture in [Operator Origin Access Setup](./operator-origin-access.md).
- GSC exports: `npm run analyze:gsc-coverage -- <path>` and `npm run analyze:gsc-performance -- <path>` are offline triage helpers.
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

**Config:** `vitest.config.ts`

```ts
const isWorktreeCheckout = normalizedRoot.includes("/.worktrees/") || normalizedRoot.includes("/worktrees/");
const worktreeExcludes = isWorktreeCheckout ? [] : [".worktrees/**", "worktrees/**"];
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
const nodeExecArgv = nodeMajor >= 25 ? ["--no-experimental-webstorage"] : [];

export default defineConfig({
  plugins: [wasmStubPlugin()],
  test: {
    execArgv: nodeExecArgv,
    exclude: [
      ...configDefaults.exclude,
      ...worktreeExcludes,
      ".claude/**",
      "agents/**",
      ".next/**",
      "out/**",
      "coverage/**",
      "tests/visual/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: [/* mirrors test.exclude */],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "shared"),
      // Stub WASM-dependent packages (satori, resvg) for Node-based vitest runs
      "satori/standalone": path.resolve(__dirname, "worker/src/__mocks__/satori-stub.ts"),
      // ... additional WASM alias stubs
    },
  },
});
```

The config also includes a `wasmStubPlugin()` Vite plugin that stubs `.wasm` imports for Node compatibility and resolve aliases for `satori/standalone`, `satori/yoga.wasm`, `@cf-wasm/resvg/workerd`, and `@resvg/resvg-wasm`. The supported test baseline is Node 24 LTS; the `nodeMajor >= 25` branch keeps jsdom as the source of `localStorage` / `sessionStorage` under the wider engine range, and nightly validation runs a non-blocking Node 26 typecheck proof.

The suite is split into five `test.projects` (all `extends: true` from the root config):

- `node` — `functions/`, `scripts/`, `shared/` suites with `isolate: false` (pure-node tests reuse worker processes instead of paying a fork per file).
- `node-isolated` — the few node-root suites that depend on per-file process isolation (module-level registry/env state); listed explicitly in `vitest.config.ts`. If a `node`-project test starts failing only in full runs, module-state leakage is the first suspect — fix the leak or move the file here.
- `worker` — `worker/` suites with default per-file isolation (they lean on module-level state: circuit breakers, caches, D1 stubs; verified to fail without isolation).
- `worker-threads` — the full-registry native Safety Score pipeline regression, isolated in a thread worker because V8 coverage can leave its otherwise-passing fork waiting during teardown.
- `src` — `src/` suites with default isolation for jsdom/React state.

`npm run test:all` is the full Vitest runner used by nightly/manual validation.

When the checkout itself lives under `/.worktrees/`, Vitest now drops those glob exclusions so coverage still includes the active repository files; nested worktree directories remain excluded in a normal top-level checkout.

**Locations:**

- `src/lib/__tests__/` — frontend library tests (pure functions)
- `src/components/__tests__/` — component-level pure/helper logic tests
- `src/hooks/__tests__/` — hook utility/state tests
- `src/__tests__/` — frontend component/integration tests
- `src/app/**/__tests__/` — route-level UI/page tests
- `functions/__tests__/` — Pages Functions and ops-host proxy tests
- `worker/src/__tests__/` — worker entrypoint tests (`fetch` request policy + `scheduled` cron dispatch wiring)
- `worker/src/lib/__tests__/` — worker library tests (scoring, parsing)
- `worker/src/api/__tests__/` — API handler contract tests
- `worker/src/cron/__tests__/` — cron job tests (with degraded-mode scenarios)
- `worker/src/cron/blacklist/__tests__/` — blacklist source-module tests
- `shared/lib/__tests__/` — shared library tests (format, classification invariants, peg rates, stablecoin registry, timeout helpers)
- `scripts/__tests__/` — repo policy / guardrail tests for CI and developer tooling
- `src/components/stablecoin-detail/__tests__/` — stablecoin detail component tests
- `worker/src/cron/reserve-adapters/__tests__/` — reserve adapter tests
- `worker/src/cron/dex-discovery/__tests__/` — DEX discovery module tests
- `worker/src/cron/dex-liquidity/__tests__/` — DEX liquidity scoring module tests

Recent cron reliability coverage explicitly exercises slot-fencing and no-write guardrails as well: stablecoins stale-publication blocking, PSI fail-closed dependency loss, DEWS bootstrap/freshness degradation, digest Telegram replay safety, bluechip partial-cache merge, and yield deterministic-source outage handling all live in the worker cron suites above.

PSI now also has dedicated replay/regression coverage beyond the pure formula tests:

- `worker/src/lib/__tests__/psi-recompute.test.ts` covers historical input reconstruction, PSI-universe filtering, and replay denominator rules
- `worker/src/lib/__tests__/psi-replay.test.ts` covers methodology-aware historical replay behavior, including `v3.x` DEWS stress-breadth inclusion
- `worker/src/lib/__tests__/psi-benchmark-scenarios.test.ts` holds bounded benchmark scenarios for major stable-market trauma patterns so future PSI work does not accidentally flatten crisis signatures

**Pattern:** `*.test.ts` / `*.test.tsx` — each `test.projects` entry in `vitest.config.ts` sets its own `include`, so only `*.test.?(c|m)[jt]s?(x)` files under `functions/`, `scripts/`, `shared/`, `worker/`, and `src/` are discovered; `.spec.` files are not.

## Test Infrastructure

### Sibling test-support modules

For shared test-only fixtures, harness setup, and builders, use a sibling `*.test-support.ts` module next to the owning test family. Keep assertions and test cases in the owning test files; the reference case is `worker/src/lib/__tests__/cron-leases.test-support.ts`.

### Frontend Test Setup Helpers (`src/test-utils/frontend.ts`)

Frontend jsdom tests should use `installMatchMediaMock()`, `cleanupFrontendTest()`, `resetBrowserStorage()`, and `createNextLinkMock()` from `src/test-utils/frontend.ts` instead of hand-rolling `matchMedia`, browser-storage cleanup, or `next/link` mocks. Keep test-local mocks only when the test needs behavior that differs from the shared helper.

`vi.mock` factories are hoisted above imports, so `createNextLinkMock` must be pulled in from inside the factory:

```ts
vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});
```

The mock renders a plain `<a>` with a forwarded ref and passes every other prop through, so tests that assert on `className`, `target`, or `data-*` attributes work unchanged.

`installMatchMediaMock(matches)` takes either a boolean or a `(query: string) => boolean` predicate, which covers query-dependent suites (simulated viewport widths, `(prefers-reduced-motion: reduce)`) without rebuilding the `MediaQueryList` shape.

### Mock D1 (`shared/test-utils/mock-d1.ts`)

Lightweight D1 mock. By default it matches on SQL substrings, but critical-path tests should use stricter behavior when the test is meant to lock a query contract rather than only response shape.

```ts
import { mockD1 } from "@shared/test-utils/mock-d1";

const db = mockD1([
  { match: "COUNT", rows: [{ total: 5 }] },
  { match: "blacklist_events", rows: [row1, row2] },
]);
```

- `match` — substring to look for in the SQL query
- `rows` — array of row objects for `.all()` results
- `first` — optional single object for `.first()` results
- `batch()` — executes each statement and returns an array of results (SELECT statements use `.all()`; writes use `.run()`, falling back to `.all()`/`.first()`)
- Unmatched SQL throws by default; pass `mockD1(tables, { allowUnmatched: true })` for permissive suites (the `requireMatch` option is deprecated)
- `mockD1(tables, { strictSql: true })` — matches normalized SQL exactly instead of substring search
- `mockD1(tables, { strict: true })` — shorthand for `requireMatch` + exact normalized SQL matching
- `db.assertAllMatchesUsed()` — optional assertion that every configured match was exercised during the test

Cross-runtime tests outside `worker/src` should use `scripts/test-utils/d1.ts` for minimal D1 and RemoteD1 mocks. `makeTestD1Database()` covers Pages Functions that need `prepare()`, `batch()`, and `getHistory()`, while `createRemoteD1Mock()` covers worker maintenance scripts that accept a `RemoteD1Client` dependency.

### Mock Fetch (`shared/test-utils/mock-fetch.ts`)

Stubs global `fetch` for testing cron jobs that make HTTP requests.

```ts
import { mockFetch } from "@shared/test-utils/mock-fetch";

const spy = mockFetch([
  { match: "frankfurter.dev", body: { rates: { EUR: 0.925 } } },
  { match: "gold-api.com", body: { price: 2900 }, status: 200 },
]);
```

- `match` — substring to match against the request URL
- `body` — response body (auto-serialized to JSON)
- `status` — HTTP status code (default: 200)
- `headers` — additional response headers
- Unmatched URLs return 404
- `mockFetch(routes, { requireMatch: true })` — throws on unexpected outbound URLs
- `mockFetch(routes, { strictUrl: true })` — matches the full request URL exactly instead of substring search
- `spy.assertAllRoutesUsed()` — optional assertion that every configured route was exercised during the test
- Call `vi.restoreAllMocks()` in `afterEach` to clean up

### Shared Fixtures (`worker/src/test-helpers/__shared/fixtures.ts`)

Factory functions that return complete DB rows with sensible defaults. Pass `overrides` for specific values.

| Factory                        | Returns                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `makeAsset()`                  | DL pegged asset (id, symbol, price, pegType, circulating, chainCirculating)                                            |
| `makeApiKeyRow()`              | api_keys row                                                                                                           |
| `makeBlacklistRow()`           | blacklist_events row                                                                                                   |
| `makeDepegRow()`               | depeg_events row                                                                                                       |
| `makeSupplyRow()`              | supply_history row                                                                                                     |
| `makeMintBurnRow()`            | mint_burn_events row                                                                                                   |
| `makeDexLiquidityRow()`        | dex_liquidity row (with v2 fields)                                                                                     |
| `makeYieldHistoryRow()`        | yield_history row                                                                                                      |
| `makeDexLiquidityHistoryRow()` | dex_liquidity_history row                                                                                              |
| `makeDigestRow()`              | daily_digest row                                                                                                       |

Example:

```ts
import { makeBlacklistRow } from "../../test-helpers/__shared/fixtures";

const row = makeBlacklistRow({ stablecoin: "USDC", event_type: "freeze" });
```

### Reserve HTML Fixtures (`worker/src/cron/reserve-adapters/__tests__/fixtures/*.html`)

Five issuer dashboards are refreshed by this script (Circle transparency, FDUSD, Mento reserve, Reserve (RE) metrics, SG Forge). Their HTML layout drifts over time, so the fixtures need periodic refreshes to keep tests anchored to today's markup rather than a snapshot from months ago. `usdh-native-markets.html` is deliberately excluded: usdh.com sunset on 2026-07-17, so a refresh would overwrite the archived capture the retired adapter's tests parse.

Run:

```bash
npm run refresh:html-fixtures
```

The script fetches each source live, prepends a `<!-- captured-at: ISO -->` provenance header, and writes the file back under `worker/src/cron/reserve-adapters/__tests__/fixtures/`. Sources that respond with <200 bytes or an HTTP error are left untouched and a warning is printed; the script exits non-zero only when zero fixtures refreshed. Run locally before updating adapter parsers — do not run in CI.

### Markdown Export Fixtures (`scripts/__tests__/fixtures/markdown/`)

`scripts/__tests__/generate-markdown-exports.test.ts` asserts these snapshots against the live renderers, so a covered source edit — a new weekly changelog entry, a methodology changelog record, or USDT registry metadata — fails that test on the next PR even when no renderer changed. `scripts/maintenance/refresh-markdown-export-fixtures.ts` owns which fixture is produced by which renderer.

Run:

```bash
npm run refresh:markdown-fixtures
```

Each fixture is re-rendered through the exact renderer the test calls, so a refresh always reconciles the snapshot with current renderer behavior: read the resulting diff, because an unintended renderer change is absorbed as silently as a data change. Commit the refreshed fixtures with the change that caused the drift — do not run this in CI.

### Shared Auth Helpers (`worker/src/test-helpers/__shared/auth.ts`)

Use these helpers in worker API contract tests that exercise admin auth and URL/request plumbing.

```ts
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "../../test-helpers/__shared/auth";

stubCryptoForAuth();

const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
const url = makeApiUrl("/api/status?limit=5");
```

- `stubCryptoForAuth()` — shared `crypto.subtle` stub for `requireAdmin`-based handlers.
- `makeApiRequest(path, options)` — creates requests with optional `method`, `adminKey`, `headers`, and `body`.
- `makeApiUrl(path)` — normalizes relative API paths into `https://x/...` URLs.

Use these helpers instead of duplicating per-file `vi.stubGlobal("crypto", ...)` or repetitive request builders.

## Test Inventory

The source of truth for the current test inventory is the filesystem, not this document. Use these commands when you need the live set:

```bash
rg --files src shared worker/src functions scripts | rg '(^|/)__tests__/|\.(test|spec)\.' | sort
npm run test:critical-contracts
npm run coverage:critical
```

Keep this section focused on how the suite is organized and which surfaces are gate-critical. Do not add a full per-file table; stale path tables were a recurring documentation drift source.

| Area                            | Location                                                             | Purpose                                                                                         |
| ------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Frontend library and page tests | `src/**/__tests__/`, colocated `*.test.ts(x)` files                  | Pure derivations, route view models, hooks, UI state, and page contracts                        |
| Shared runtime tests            | `shared/lib/__tests__/`                                              | Runtime-neutral scoring, classification, chain, dependency, reserve, and formatting contracts   |
| Worker API tests                | `worker/src/api/__tests__/`                                          | Handler contracts, response shapes, auth/method behavior, and admin backfill surfaces           |
| Worker library tests            | `worker/src/lib/__tests__/`                                          | Auth, cache, rate limit, pricing, status, mint/burn, reserves, report cards, and helper modules |
| Cron tests                      | `worker/src/cron/**/__tests__/` and colocated cron `*.test.ts` files | Scheduled ingestion, scoring, persistence, degradation, and adapter behavior                    |
Critical gate coverage is intentionally smaller than the full suite:

- `scripts/lib/critical-coverage.mjs` discovers high-stakes source candidates from the repository roots and path rules. It does not contain a second source-path enrollment list.
- `scripts/lib/critical-ownership.mts` scans every test file's static imports, quoted dynamic `import(...)` calls, and `vi.mock` specifiers, resolves relative and repository aliases, and derives a sorted `source → importing tests` map. A candidate is enrolled only when that map has an owner, while the 35 no-owner candidates known at the 2026-09-03 cutover are recorded as dated ownership waivers. New unowned candidates fail `check:critical-coverage-completeness`.
- `npm run test:critical-contracts` remains the explicit runner for the 19 existing contract entries (including the 2 global invariant paths). `test:pr` adds 11 additional unique user-facing response, auth, scheduled-dispatch, supply, freshness, and cron-sync contracts for an exact 30-file always-on set.
- `npm run test:pr` runs that always-on set, Vitest's changed tests, and every test that owns a changed enrolled source. A source change therefore pays only for its importing contracts instead of all 232 formerly hand-maintained critical tests.
- `npm run coverage:critical` runs the full derived owner set for the weekly/manual ratchet. PR coverage shards pass their changed paths to `buildCriticalCoverageArgs`, include only touched enrolled sources, and run only the owners of those sources; critical-coverage plumbing changes use the full derived source and test set.
- Real-SQL migration, crash-resume, rollback, and external-effect failure suites remain preferred wherever the runtime owns durable state; authenticated axe coverage and broad UI checks stay outside this gate.

The checked-in baseline remains valid because generated enrollment is a subset of the existing baseline; no baseline regeneration is required for this cutover.

When adding tests, prefer colocating them near the module under test unless an existing `__tests__/` directory is already the local pattern. If the new test protects a production gate, add it to the relevant npm script rather than only documenting it here.

## Conventions

### What to test

- **Pure `shared/lib/` + `src/lib/` functions** — formatters, supply helpers, classification maps, peg-rate derivation, and frontend derivations. These are the highest-value tests: deterministic, fast, and catch regressions in shared logic.
- **Edge cases** — `NaN`, `Infinity`, `null`, `undefined`, zero, negative values, empty inputs. The existing tests set this standard.
- **Boundary values** — tier boundaries in formatters (e.g., 999 vs 1000 for K suffix).
- **API contract tests** — when a worker handler has multiple response modes (different JSON shapes based on query params), add a contract test for each mode in `worker/src/api/__tests__/`. Use the shared D1 mock from `shared/test-utils/mock-d1.ts`.
- **Degraded-mode scenarios** — for cron jobs, test the normal path plus at least one failure/fallback scenario (e.g., upstream API 503, stale cache, missing data). Use `mockFetch()` to simulate API failures and `vi.useFakeTimers()` for deterministic time.

### Default test boundaries

- **Broad DOM-rendered React integration tests** — jsdom is available only when a test opts in via `// @vitest-environment jsdom` (for example `src/hooks/__tests__/use-chart-container-ready.test.tsx`). Most existing tests stay pure or use server rendering instead of full browser-like component integration.
- **API/worker handlers** — use `mockD1()` for response-shape and branch tests. When correctness depends on transactions, constraints, migrations, concurrency, or SQL semantics, use the latest-schema SQLite harness `createLatestSchemaSqlite()` in `worker/src/test-helpers/latest-schema-sqlite.ts` rather than treating substring-matched mocks as persistence proof.
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

- `npm run check:clone-ratchet` checks exact duplicate significant-line windows against `scripts/lib/clone-ratchet-baseline.json`; `check:structural` enforces it for affected PR paths and nightly/manual validation. `npm run check:clone-ratchet:update-baseline` is reserved for an intentional, reviewed extraction or deletion effect, not for ratcheting new duplication into the baseline.
- The [Operator CLI Contract](./scripts.md#operator-cli-contract) owns what `npm run check:cli-args-policy` verifies; `check:structural` enforces it for affected PR paths and nightly/manual validation, and it can also be run directly when CI/operator scripts change.
- `npm run audit:coverage -- --domain=oracle-risk --enforce` remains the direct content audit for CDP oracle profiles and required branch evidence. It is a manual curation audit, not a merge gate; its reviewed applicability queue is advisory for current Safety Score V9 (`9.461`) scoring, while explicit unresolved dispositions remain V9 blockers rather than silently passing as profile-only evidence.
- `src/lib/__tests__/term-markup.test.ts` owns AI-summary glossary-marker integrity as an ordinary noncritical runtime-parser test, including known slugs, balanced markers, and the current corpus totals.
- Mechanism explainer completeness is split across ordinary noncritical domain tests: `src/app/learn/mechanisms/__tests__/content.test.ts` owns labels, one-liners, editorial content, and representative coin IDs; the existing dynamic-route test owns exact static params; `src/app/__tests__/sitemap-frozen.test.ts` owns sitemap membership. OG images remain generated-artifact-owned.
- `shared/lib/selector/__tests__/editorial-policy.test.ts` owns the Selector banned-phrase rule matrix and complete editorial corpus as an ordinary noncritical domain test, including Picker route/component copy and checked-in worked examples.
- `npm run check:stablecoin-data` has an advisory warning lane alongside its blocking errors. Warnings print to stdout, do not increment the error count, and never fail the gate; the footer reports `OK (N warning(s))`. It currently carries the collateral-prose drift report (`shared/lib/stablecoins/collateral-prose-reserve-drift.ts`), which flags a `collateral` string naming a tracked ticker that appears in no reviewed reserve slice. It is advisory by design: legitimate prose names non-reserve entities constantly — look-through naming and prose-vs-slice taxonomy differences are the noise floor — so only clauses carrying eligibility modality are reported per coin, and the rest collapse to a single count. Treat a new tier-1 warning as curation work, not a build break.
- `scripts/__tests__/weekly-curation-digest.test.ts` owns attestor-tier, coin one-liner, and mechanism-archetype coverage as an ordinary noncritical domain test. It reads authored per-coin entries and preserves the editorial rubric: all active/pre-launch coins need nonblank one-liners, more than 20% missing attestor tiers fails the independent-audit cohort, and unknown baseline IDs or more than 27% missing archetypes fails the fixed non-variant/non-frozen cohort.
- `npm run audit:coverage -- --domain=redemption-backstops` validates the redemption-backstop registry split across `shared/lib/redemption-backstop-configs/*`, catches duplicate IDs across modules, enforces allowed route-family membership per module, and keeps the headline counts in `docs/redemption-backstops.md` synced to the real registry.
- `npm run audit:coverage -- --domain=redemption-coverage --check` requires every active unconfigured asset to have a source-reviewed row in `shared/data/coverage-dispositions/redemption-coverage-dispositions.ts`. It rejects missing, duplicate, unknown, inactive, configured-stale, and malformed reviews and ranks the queue by canonical market-cap order. The backlog counts are no longer ratcheted: a growing gap list is curation work, not a merge failure.
- `worker/src/lib/__tests__/redemption-backstops-store.test.ts` now covers completed-run snapshot manifests for `redemption_backstop_runs`, including generation-filtered reads and current/history rows written with `snapshot_run_id`.

### Test style

- Use `describe` per function, `it` per behavior.
- Test names describe the behavior, not the implementation: `"returns 0 for undefined input"` not `"calls sumPegBuckets with undefined"`.
- Use `makeStablecoin()` / `makeStablecoinMeta()` from `shared/test-utils/stablecoin.ts` (see `shared/lib/__tests__/supply.test.ts`) for partial `StablecoinData` mocks — avoids `as any` casts.
- Use shared fixtures from `worker/src/test-helpers/__shared/fixtures.ts` for DB row mocks.
- Keep tests focused: one assertion per `it` block when possible.

## Coverage

Full-suite coverage threshold is not enforced. The critical gate applies a 40% default plus explicit per-file line floors ranging from 30% to 70%, 40% branch/error-path floors at provider, authentication, scoring, and publication boundaries, and a touched-file no-regression ratchet. Run `npm test -- --coverage` to generate a detailed report. The V8 provider generates both text output and an `lcov` report for CI integration.

### Critical Coverage Gate

CI **does not** run a full-suite coverage gate. The PR workflow runs `coverage:critical` when an enrolled source or critical-coverage plumbing changes; the compare ref scopes the no-regression ratchet to touched sources. PR shards and the weekly/manual Critical Coverage Ratchet workflow execute the same full derived critical-owner test set so their measurements remain comparable to the checked-in baseline. Tests owning other critical sources can exercise a touched source indirectly:

- `critical-coverage.mjs` scans high-stakes source roots and applies the existing candidate path rules. `CRITICAL_FILES` is the generated intersection of those candidates and sources imported by tests; there is no hand-maintained source enrollment list.
- `critical-ownership.mts` resolves static imports, quoted dynamic `import(...)` calls, and `vi.mock` specifiers (including `@/`, `@shared/`, and relative paths) to repository files and records every importing test. `CRITICAL_OWNERSHIP_WAIVERS` documents the 35 no-owner candidates present at the 2026-09-03 cutover; `check:critical-coverage-completeness` fails for any new unowned candidate or any explicitly enrolled source without an owner.
- PR coverage preflight caps the matrix at the smaller of four shards or the full owner-test count. Each shard passes the changed file set to `buildCriticalCoverageArgs`; it includes only touched enrolled sources for V8 remapping but retains the full critical-owner suite. The merge checker applies line/branch floors and `MISSING` checks to that same touched source scope; plumbing-only changes fall back to the full derived source set, while `CRITICAL_COVERAGE_RATCHET_ALL=1` checks every enrolled source.
- The full derived source and owner set is capped at four Vitest workers. v8 remapping is limited with per-file `--coverage.include` flags, so unrelated loaded modules do not inflate the report.
- Parses `coverage/lcov.info` and fails if any enrolled source falls below `CRITICAL_COVERAGE_THRESHOLD` (default 40%).
- Applies explicit per-file line minimums and 40% branch/error-path floors at provider, authentication, scoring, and publication boundaries.
- Applies the touched-source no-regression ratchet using `.ci/critical-coverage-baseline.json`; the generated enrolled set is already represented in that baseline, so no regeneration is required for this cutover.
- Reports due or overdue ordinary coverage-waiver reviews without failing solely because the advisory date passed, but fails invalid or stale coverage waivers.

`npm run check:pr -- --base=<ref>` runs this lane automatically when the diff touches an enrolled source or critical-coverage plumbing. Use `npm run coverage:critical` directly for custom `CRITICAL_COVERAGE_*` controls; `--skip-coverage` skips the local lane but not the remote gate.

Gate scripts and ownership:

- `scripts/lib/critical-ownership.mts` owns generated source-to-test ownership and the dated cutover gap waivers.
- `scripts/lib/critical-test-files.mts` owns the 30-file always-on contract set and builds full/touched Vitest arguments from ownership.
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

- `npm run test:critical-contracts` runs the 19 existing contract entries; `npm run test:pr` composes those with the additional user-facing contracts into the exact 30-file always-on set, then adds changed tests and touched-source owners.
- `npm run check:pr -- --base=<ref>` runs the adaptive local PR contract against a committed diff.
- `npm run check:release` performs the optional full Pages build/static checks and credential-free Worker bundle proof.
- `npm run test:all` runs the complete suite; `npm run test:pr -- --base=<ref>` runs critical plus dependency-selected tests.
- `npm run test:smoke-api` checks `/api/health` plus either the strict endpoint contract set or its deploy-canary subset.
- `npm run test:smoke-ops` checks the Access-protected operator UI/API surfaces and their same-origin proxy where an authenticated session is available.
- `npm run test:smoke-transport` verifies that public HTTP API origins upgrade to the exact HTTPS host, path, and query.
- `npm run test:smoke-ui` covers the main hydrated browser path, analytics, first-party data availability, and responsive overflow checks; `npm run test:smoke-ui:mobile` applies the stricter tracked mobile-route geometry and control-size assertions. Production scope, retries, environment, and publish ordering remain canonical in [Deployment Process](./deployment-process.md#ci-deploy-sequence).
- `npm run test:smoke-pages-assets` checks Yield deep routes (the top live rankings plus the source-family canaries in `scripts/lib/pages-asset-smoke.mjs`) for HTML/script MIME coherence, unexpected redirect targets, first-party asset delivery, and fatal runtime or framework error markers; the warm-cache canaries are navigated twice so a cached repeat visit is covered, and `--mode live` additionally rejects HTML cache directives that would let a stale deployment keep being served.
- `npm run validate:pages-smoke` composes three smokes — `test:smoke-ui`, `test:smoke-ui:mobile`, and `test:smoke-pages-assets` — against one already-built `out/`, and fails fast if `out/` is missing. `PAGES_SMOKE_INCLUDE_MOBILE=0` drops only the mobile smoke; the desktop and asset smokes still run, and the flag has no effect on any smoke invoked directly.

## Adding a New Test
When scaffolding is shared by multiple suites, follow the [sibling test-support module convention](#sibling-test-support-modules).

**Frontend library test:**

1. Create `src/lib/__tests__/<module>.test.ts`.
2. Import from the module under test using the canonical boundary:
   - `@shared/*` for runtime-shared modules
   - `@/lib/*` for frontend-only modules
3. Write `describe`/`it` blocks following the conventions above.
4. Run `npm test` to verify, then `npm run lint` to check for issues.

**Worker library test:** Same as above but in `worker/src/lib/__tests__/`. Import via relative paths (no `@/` alias).

**API contract test:** Create in `worker/src/api/__tests__/`. Import the handler and use `mockD1()` from `@shared/test-utils/mock-d1`. Use shared fixtures from `../../test-helpers/__shared/fixtures.ts` for row data. Validate response shape against Zod schemas from `shared/types/index.ts`.

**Cron test:** Create in `worker/src/cron/__tests__/`. Mock external dependencies with `vi.mock()` and HTTP calls with `mockFetch()`. Test both normal path and at least one degraded-mode scenario.

Example API contract test:

```ts
import { describe, it, expect } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeBlacklistRow } from "../../test-helpers/__shared/fixtures";
import { handleBlacklist } from "../blacklist";

describe("handleBlacklist", () => {
  const row = makeBlacklistRow();
  const db = mockD1([
    { match: "COUNT", rows: [{ total: 1 }] },
    { match: "blacklist_events", rows: [row] },
  ]);

  it("returns 200 with events array", async () => {
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[]; total: number };
    expect(body.events).toHaveLength(1);
    expect(body.total).toBe(1);
  });
});
```

Example cron test with degraded mode:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { mockFetch } from "@shared/test-utils/mock-fetch";

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: async (url: string, opts?: RequestInit) => fetch(url, opts),
}));

import { syncFxRates } from "../sync-fx-rates";

describe("syncFxRates", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back gracefully when frankfurter.dev returns 503", async () => {
    mockFetch([{ match: "frankfurter.dev", body: {}, status: 503 }]);
    const db = mockD1([{ match: "cache", rows: [], first: null }]);
    const result = await syncFxRates(db);
    expect(result).toBeDefined(); // no throw
  });
});
```

## ESLint Configuration

**Config:** `eslint.config.mjs` (flat config format)

**Extends:** `eslint-config-next/core-web-vitals` + `eslint-config-next/typescript`

**Custom rules** — React Compiler rules are set to `error`. They flag patterns that are merely suboptimal for the compiler, but `lint` runs with `--max-warnings=0`, so `error` and `warn` fail the gate identically; configuring them as `error` keeps the declared severity aligned with enforcement. Use a scoped `eslint-disable` with justification for the rare legitimate exception:

| Rule                                      | Level | Reason                                                                                       |
| ----------------------------------------- | ----- | -------------------------------------------------------------------------------------------- |
| `react-hooks/preserve-manual-memoization` | error | Compiler can't optimize `useMemo([data])` when body accesses `data.current.*` sub-properties |
| `react-hooks/set-state-in-effect`         | error | Standard pattern for reading localStorage/sessionStorage on mount                            |
| `react-hooks/purity`                      | error | `Date.now()` in render is intentional for timestamp-based UIs                                |
| `react-hooks/incompatible-library`        | error | TanStack Virtual `useVirtualizer()` — known library limitation                               |

**Security plugin** — `eslint-plugin-security` keeps its regex and timing rules (`detect-unsafe-regex`, `detect-non-literal-regexp`, `detect-possible-timing-attacks`) enabled; suppress them only with a scoped `eslint-disable` plus justification. `detect-object-injection` and `detect-non-literal-fs-filename` are off globally in `eslint.config.mjs` — both flag routine dynamic-property and dynamic-filesystem-path access that repo scripts and tests use intentionally. The fs rule previously required ~101 inline suppressions; an owner review replaced them (and the `scripts/**` carve-out) with the global off.

**Import boundaries** — `no-restricted-imports` blocks carry the lint-shaped architectural rules so they run on every changed file through `lint:changed` instead of a separate scanner:

| Scope | Restriction |
| ----- | ----------- |
| `worker/src/**` | No bare `viem` or non-`viem/utils` subpaths; no `src/lib/*` / `@/lib/*` (ADR-2, worker→frontend half) |
| `src/**`, `shared/**`, `scripts/**`, `functions/**` | No `worker/src/**` imports (ADR-2, frontend→worker half). The sole reviewed waiver is listed in `FRONTEND_TO_WORKER_WAIVED_FILES` in `eslint.config.mjs` |
| `shared/lib/**` (excluding its tests) | No `@shared/*` aliases — use relative imports |
| `src/app/**`, `src/components/**`, `worker/src/api/**` | No `sumPegBuckets` from `@shared/lib/supply`; cached `StablecoinData` supply reads use `getCirculatingRaw()`. The three raw-bucket parsers under `worker/src/api/` that pre-date a `StablecoinData` object are listed as glob exceptions in the config |

Because flat config *replaces* a rule's options when several config objects match the same file, the blocks above compose their pattern lists from shared constants rather than relying on merging.

**Ignored paths:** `.next/`, `out/`, `build/`, `coverage/`, `.cache/`, `.claude/`, `.codex-autorunner/`, `agents/**`, `worker/.wrangler/`, `.worktrees/`, `worktrees/`, and `next-env.d.ts` (auto-generated build artifacts, gate/tooling caches, agent scratch areas, and worktree directories). The conditional worktree behavior described earlier applies to Vitest coverage globs, not ESLint.

### Zod Runtime Validation

Schema validation in hooks flows from each endpoint descriptor's `schema` through `useRegisteredApiQuery`; in `src/hooks/api-hooks.ts`, meta responses use `createApiPollingQueryOptionsWithMeta` and are normalized with `unwrapApiQueryWithMetaResult`. Use `rg "schema:" src/hooks src/lib` for the live callsite and schema set before adding or auditing endpoint validation; do not maintain a second response-schema inventory here.

When a schema is provided, frontend API helpers now validate in `strict` mode by default and throw on schema mismatch. Use `contractMode: "warn"` only for explicitly degraded surfaces where returning raw data is acceptable.

When adding a new API endpoint:

1. Define the response schema in `shared/types/index.ts` if the response has nested arrays or objects accessed via `.find()` / `.map()`
2. Attach the response schema to the descriptor consumed by `useRegisteredApiQuery`
3. Add a contract test in `worker/src/api/__tests__/` if the endpoint has multiple response modes

**Narrow-type gotcha:** If your response type uses string unions or branded types (e.g. `ReportCardGrade`), prefer the shared hand-written interfaces and keep any unavoidable schema wiring/casts localized in the consolidated hook module (`src/hooks/api-hooks.ts`).

**Worker CI note:** `shared/types/index.ts` imports `zod`, and the worker type-checks shared modules via the `@shared/*` path alias in the PR static gate (`npm run typecheck:worker`, selected when the diff touches worker paths) and in nightly validation, before a merge can reach the production deploy workflow. Root deps are installed first (`npm ci`) through the npm workspace so shared imports resolve from root `node_modules/`. If you add new npm packages imported at the top level of shared files, they do not need duplication in `worker/package.json` unless the worker uses a worker-local runtime/deploy path that genuinely requires it.
