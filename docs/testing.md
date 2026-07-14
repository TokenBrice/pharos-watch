# Testing & Linting

> **Agent navigation** — Grep the heading you need instead of reading wholesale: Overview · Commands · CI Pipeline · Vitest Runtime Profiling · Test Setup · Test Infrastructure · Test Inventory · Conventions · Coverage · Adding a New Test · ESLint Configuration.

## Overview

The project uses **Vitest** for unit tests and **ESLint** (via `eslint-config-next`) for linting. The shared validation suite runs on pull requests to protected `main`. Post-merge production workflows consume the classifier result and rerun only mutation-adjacent migration or artifact checks.

## Commands

```bash
npm test
npm run test:watch
npm run lint
npm run lint:typed
npm run typecheck
npm run typecheck:tests
npm run typecheck:worker
npm run test:a11y
npm run test:a11y:hydrated
npm run test:merge-gate
npm run test:merge-gate:discover
```

Use `package.json` for the full live npm-script list. Use `scripts/lib/validation-lanes.mjs` for validation lane ownership, the reduced blocking `validate:prebuild` set, advisory prebuild opt-in, postbuild, Pages/Worker, smoke commands, and validation-owned deploy-impact paths; use `scripts/lib/automation-registry.mjs` for generated-artifact checks and deploy-impact classification, `scripts/lib/cli-argv-policy.mjs` for the exact strict/exempt `process.argv` inventory, and `scripts/lib/critical-test-files.mjs` / `scripts/lib/critical-coverage.mjs` for critical-suite ownership. `npm run typecheck:tests` runs the dedicated test-file TypeScript project and requires zero diagnostics. Do not duplicate those inventories here.

Common targeted runners:

```bash
npm run test:merge-gate:discover
npm run test:profile -- --output /tmp/pharos-vitest-profile.json
npm run test:critical-contracts
npm run test:invariants
npm run coverage:critical
npm run validate:pages
npm run validate:pages-smoke
npm run validate:worker
npm run validate:worker-scheduled-smoke
npm run validate:worker-smoke
npm run test:smoke-api -- --base-url https://api.pharos.watch
npm run test:smoke-ops
npm run test:smoke-transport
npm run test:smoke-ui -- --url https://pharos.watch --mode live
npm run test:smoke-ui:mobile -- --url http://localhost:3000
```

Markdown variants are generated for `/methodology/`, methodology changelogs, `/changelog/`, `/digest/[date]/`, stablecoin detail pages, and `/docs/*`. Representative checked-in fixture snapshots live under `scripts/__tests__/fixtures/markdown/`. When an intentional visible copy or renderer change updates one of those covered outputs, run `npm run build` or `npx tsx scripts/maintenance/generate-markdown-exports.ts`, copy the matching `out/**/index.md` file over its fixture, and commit the fixture in the same change as the JSX or renderer edit.

`npm run audit:pricing-providers` checks the configured CEX and RedStone provider contracts against live metadata and is covered by mocked unit tests for success, regional blocking, provider drift, non-OK responses, and malformed metadata shapes. Optional live source-shape probes can be run with `npx tsx scripts/maintenance/audit-pricing-provider-config.ts --live-source-shapes`; this adds Jupiter V3 shape validation and, when `CMC_API_KEY` is set, a CoinMarketCap category shape check. Stablecoins sync metadata also emits `pricingSourceAuditReport`, which summarizes source distribution risks such as missing prices, fallback/cache reliance, low-confidence pricing, assets without an independent hard source, and structured provider rejection counts.

When `SMOKE_UI_EXPECT_GA_ID` is set, `npm run test:smoke-ui` first verifies that the homepage artifact does not preload GA as first-paint work, then the browser smoke verifies runtime analytics initialization: `window.gtag`, the expected `config` entry, the `page_view` entry, a successful `gtag.js` load, and a GA4 `page_view` collect signal. Live mode requires successful collect delivery; after that success, expected-measurement GA collect `net::ERR_ABORTED` reports are treated as browser beacon noise. Local artifact mode also accepts a Playwright `net::ERR_ABORTED` report for a GA4 collect URL with the configured measurement id because Chromium can abort that issued beacon when the local smoke context closes.

## CI Pipeline

Workflow YAML is the source of truth. The main validation and deploy files are `.github/workflows/validate-ci.yml`, `.github/workflows/pull-request-checks.yml`, `.github/workflows/deploy-cloudflare.yml`, `.github/workflows/pages-release.yml`, and `.github/workflows/rebuild-pages.yml`; scheduled/advisory lanes live beside them for CodeQL, Zizmor, dependency audit, Telegram load, critical coverage ratchet, secret scan, Safe Browsing, and OG refresh.

For deployment/worktree operating procedure, secrets, rollback, and local merge-gate behavior, see [Deployment Process](./deployment-process.md). This file documents test ownership and runner conventions only.

CI shape:

1. Pull requests run through `.github/workflows/pull-request-checks.yml`. Internal-docs-only diffs run verified-link, source-path, doc-sync, and agent-doc-sync checks; other diffs run the reusable validate workflow. The deploy-impact classifier decides whether validation also needs a Pages build, Worker typechecking, or neither. Test-only Pages diffs still run the shared tests but do not request a Pages build or production publish.
2. `validate` runs the source-owned reduced blocking prebuild set from `scripts/lib/validation-lanes.mjs`, normal Vitest shards, optional Worker runtime typecheck, and optional Pages build/SEO/static copy checks. The reusable workflow invokes the fixed `validate:pages` and `validate:worker` phase entrypoints instead of copying either command sequence into YAML. The scheduled Worker entrypoint suite is covered by the normal Vitest shards and the scheduled/manual critical coverage ratchet, not by `validate:worker`.
3. A successful protected merge triggers the production deploy classifier. The deploy workflow does not rerun the full PR suite: Worker mutation keeps a focused migration check and Wrangler activation proof; Pages publication keeps build-artifact checks and a deployment-specific release-marker proof. Details live in [Deployment Process](./deployment-process.md).
4. `npm run test:merge-gate` mirrors the deploy-impact validation-lane plan locally and skips cleanly for non-deploy-impacting diffs. Use `MERGE_GATE_DRY_RUN=1` to print the plan without requiring a fresh install. The pre-push hook does not run this heavy gate by default; set `PHAROS_PRE_PUSH_GATE=main` or `PHAROS_PRE_PUSH_GATE=all` when an exact-range local rehearsal is desired.
5. `npm run test:merge-gate:discover` runs the same deploy-impact command plan for large failure-discovery passes, but keeps advisory prebuild checks opt-in via `VALIDATE_PREBUILD_INCLUDE_ADVISORY=1`. It keeps reduced prebuild and independent postbuild lanes running after failures, skips smoke by default, caps diagnostic fan-out at 3 unless `MERGE_GATE_DISCOVERY_MAX_PARALLEL` is set, and is diagnostic only. GitHub Actions owns the authoritative release gate.

Telegram load protection has two local shapes: `npm run check:telegram-load` is the blocking SLO/CPU guard, while direct `npx tsx scripts/ci/check-telegram-load.ts` is the advisory query-plan report. Both consume runtime delivery limits and reviewed model calibration from `shared/lib/telegram-delivery-policy.ts`. The dependency groups in `scripts/lib/telegram-load-guard.mjs` select the local merge-gate advisory and are parity-tested against `.github/workflows/telegram-load.yml`; sender, preset, formatter/chunker, scheduled-lane, durable schema, policy, migration, dispatch/pending, and admin-broadcast changes are covered. Full deploy fallback includes the advisory unconditionally.

`npm run test:critical-contracts` is a targeted local runner for strict endpoint registry, router mapping, cache passthrough, and high-impact API handler checks. It is not a separate validate/merge-gate lane; those gates rely on the normal sharded `test:noncritical` wrapper, which now includes critical tests despite the legacy script name.

Selected specialized checks:

- Cron schedule/connection changes: `npm run check:cron-sync`, `npm run check:cron-connections`, and `npm run validate:worker-scheduled-smoke`.
- Worker deployment configuration: `npm run check:worker-config` verifies that production custom domains remain root-owned and asset rules fall through.
- Worker fetch-body timeout guardrail: `npm run check:fetch-body-timeouts` flags new raw `fetchWithRetry()` response-body reads unless they are explicitly tracked as migration debt; it runs in advisory prebuild mode and can be run directly for Worker fetch changes.
- Provider fetch resilience changes: `npm run check:provider-resilience` verifies the external-provider registry, required timeout/body/circuit/test markers, and raw Worker `fetch(...)` coverage.
- Generated public artifacts: `npm run check:generated-artifacts`, with individual checks in `scripts/lib/automation-registry.mjs`.
- Static export SEO: `npm run seo:check`; live SEO smoke is `npm run seo:live-smoke -- --url https://pharos.watch`.
- Static export accessibility: `npm run test:a11y` scans the bare static export, while `npm run test:a11y:hydrated` reuses the API-backed static-export smoke server so axe sees hydrated product data. Both run route-per-test with 3 Playwright workers (`fullyParallel: true` in `playwright.config.ts`); the scans are independent per route, so parallelism changes no coverage.
- GSC exports: `npm run analyze:gsc-coverage -- <path>` and `npm run analyze:gsc-performance -- <path>` are offline triage helpers.
- Optional render-budget probe: `node scripts/maintenance/audit-seo-render-budget.mjs --url https://pharos.watch`.

## Vitest Runtime Profiling

`npm run test:profile -- --output /tmp/pharos-vitest-profile.json` runs Vitest once with the JSON reporter, stores the raw Vitest report beside the requested output as `*.vitest.json`, and writes a durable summary to the requested `/tmp` path. The summary prints total files/tests, wall time, summed file/test time, node/jsdom split, top files, top individual tests, files above 10s, and tests above 1s.

Pass Vitest filters or options after `--` when narrowing or validating runner behavior:

```bash
npm run test:profile -- --output /tmp/pharos-src-profile.json -- --dir src
npm run test:profile -- --output /tmp/pharos-vitest-threads.json --baseline /tmp/pharos-vitest-profile.json -- --pool=threads
```

In CI, `npm run test:noncritical` and `npm run coverage:critical` append `--silent=passed-only` unless an explicit `--silent` option is already supplied. Set `PHAROS_CI_VITEST_COMPACT=0` to restore full console output while debugging a CI-only failure. The PR reusable validate workflow shards `test:noncritical` across two runners and includes critical tests in that normal Vitest lane; local `npm run test:merge-gate` emits the same two shard commands and auto-enables its parallel matrix when at least 12 cores are available, staying serial below that threshold unless `MERGE_GATE_PARALLEL` overrides it.

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

The config also includes a `wasmStubPlugin()` Vite plugin that stubs `.wasm` imports for Node compatibility and resolve aliases for `satori/standalone`, `satori/yoga.wasm`, `@cf-wasm/resvg/workerd`, and `@resvg/resvg-wasm`. The supported test baseline is Node 24 LTS; the `nodeMajor >= 25` branch keeps jsdom as the source of `localStorage` / `sessionStorage` under the wider engine range, and pull-request CI runs a non-blocking Node 26 typecheck proof lane only when code or toolchain inputs change.

The suite is split into four `test.projects` (all `extends: true` from the root config):

- `node` — `functions/`, `scripts/`, `shared/` suites with `isolate: false` (pure-node tests reuse worker processes instead of paying a fork per file).
- `node-isolated` — the few node-root suites that depend on per-file process isolation (module-level registry/env state); listed explicitly in `vitest.config.ts`. If a `node`-project test starts failing only in full runs, module-state leakage is the first suspect — fix the leak or move the file here.
- `worker` — `worker/` suites with default per-file isolation (they lean on module-level state: circuit breakers, caches, D1 stubs; verified to fail without isolation).
- `src` — `src/` suites with default isolation for jsdom/React state.

`npm run test:noncritical` is now the normal Vitest runner for deploy validation and no longer excludes critical test files. The script name is retained for compatibility with existing npm scripts, workflow names, and historical receipts.

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

**Pattern:** `*.test.ts` / `*.test.tsx` — Vitest discovers files matching `**/*.{test,spec}.?(c|m)[jt]s?(x)`.

## Test Infrastructure

### Frontend Test Setup Helpers (`src/test-utils/frontend.ts`)

Frontend jsdom tests should use `installMatchMediaMock()`, `cleanupFrontendTest()`, `resetBrowserStorage()`, and `createNextLinkMock()` from `src/test-utils/frontend.ts` instead of hand-rolling `matchMedia`, browser-storage cleanup, or `next/link` mocks. Keep test-local mocks only when the test needs behavior that differs from the shared helper.

### Mock D1 (`worker/src/test-helpers/__shared/mock-d1.ts`)

Lightweight D1 mock. By default it matches on SQL substrings, but critical-path tests should use stricter behavior when the test is meant to lock a query contract rather than only response shape.

```ts
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

const db = mockD1([
  { match: "COUNT", rows: [{ total: 5 }] },
  { match: "blacklist_events", rows: [row1, row2] },
]);
```

- `match` — substring to look for in the SQL query
- `rows` — array of row objects for `.all()` results
- `first` — optional single object for `.first()` results
- `batch()` — executes each statement and returns an array of results (SELECT statements use `.all()`; writes use `.run()`, falling back to `.all()`/`.first()`)
- `mockD1(tables, { requireMatch: true })` — throws if executed SQL does not match a configured entry
- `mockD1(tables, { strictSql: true })` — matches normalized SQL exactly instead of substring search
- `mockD1(tables, { strict: true })` — shorthand for `requireMatch` + exact normalized SQL matching
- `db.assertAllMatchesUsed()` — optional assertion that every configured match was exercised during the test

Cross-runtime tests outside `worker/src` should use `scripts/test-utils/d1.ts` for minimal D1 and RemoteD1 mocks. `makeTestD1Database()` covers Pages Functions that need `prepare()`, `batch()`, and `getHistory()`, while `createRemoteD1Mock()` covers worker maintenance scripts that accept a `RemoteD1Client` dependency.

### Mock Fetch (`worker/src/test-helpers/__shared/mock-fetch.ts`)

Stubs global `fetch` for testing cron jobs that make HTTP requests.

```ts
import { mockFetch } from "../../test-helpers/__shared/mock-fetch";

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
| `makeReportCardsDb()`          | Pre-wired `MockD1Database` for report-card style tests (`cache`, `dex_liquidity`, `depeg_events`, `supply_history`, …) |
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

Six issuer dashboards feed HTML-parsing adapters (Circle transparency, FDUSD, Mento reserve, Reserve (RE) metrics, SG Forge, USDH). Their HTML layout drifts over time, so the fixtures need periodic refreshes to keep tests anchored to today's markup rather than a snapshot from months ago.

Run:

```bash
npm run refresh:html-fixtures
```

The script fetches each source live, prepends a `<!-- captured-at: ISO -->` provenance header, and writes the file back under `worker/src/cron/reserve-adapters/__tests__/fixtures/`. Sources that respond with <200 bytes or an HTTP error are left untouched and a warning is printed; the script exits non-zero only when zero fixtures refreshed. Run locally before updating adapter parsers — do not run in CI.

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
npm run test:invariants
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
| Script tests                    | `scripts/__tests__/`                                                 | CI guardrail and operational-script behavior                                                    |

Critical gate coverage is intentionally smaller than the full suite:

- `npm run test:invariants` covers numerical/schema invariants and critical cron-cache validation.
- `npm run coverage:critical` runs the critical suite owned by `scripts/lib/critical-test-files.mjs` with line-coverage ratchets owned by `scripts/lib/critical-coverage.mjs`. It is owned by the weekly/manual Critical Coverage Ratchet workflow, not the blocking reusable validate workflow. Telegram enrollment includes authoritative target planning and legacy recovery, pending lifecycle and outage control, webhook effect fencing and watchlist import, Mini App authentication plus authenticated state/theme contracts, and aggregate-only adoption analytics. Real-SQL migration, crash-resume, rollback, and external-effect failure suites are preferred wherever the runtime owns durable state; authenticated axe coverage remains owned by the Playwright accessibility gate.
- `npm run test:critical-contracts` is a targeted local runner for strict endpoint registry, router mapping, cache passthrough, and high-impact API handler checks. It is not a separate validate/merge-gate lane; those gates rely on the two-shard `test:noncritical` wrapper, which runs the normal Vitest project set including critical tests.

Lane ownership is script-owned, not prose-owned. Put critical source coverage membership in `scripts/lib/critical-coverage.mjs`; keep the normal Vitest shard wrapper in `scripts/maintenance/run-noncritical-tests.mjs`; and keep targeted contract-runner plus critical coverage test membership in `scripts/lib/critical-test-files.mjs`. Do not duplicate either file list in this document; use the scripts when you need the live membership.

When adding tests, prefer colocating them near the module under test unless an existing `__tests__/` directory is already the local pattern. If the new test protects a production gate, add it to the relevant npm script rather than only documenting it here.

## Conventions

### What to test

- **Pure `shared/lib/` + `src/lib/` functions** — formatters, supply helpers, classification maps, peg-rate derivation, and frontend derivations. These are the highest-value tests: deterministic, fast, and catch regressions in shared logic.
- **Edge cases** — `NaN`, `Infinity`, `null`, `undefined`, zero, negative values, empty inputs. The existing tests set this standard.
- **Boundary values** — tier boundaries in formatters (e.g., 999 vs 1000 for K suffix).
- **API contract tests** — when a worker handler has multiple response modes (different JSON shapes based on query params), add a contract test for each mode in `worker/src/api/__tests__/`. Use the shared D1 mock from `worker/src/test-helpers/__shared/mock-d1.ts`.
- **Degraded-mode scenarios** — for cron jobs, test the normal path plus at least one failure/fallback scenario (e.g., upstream API 503, stale cache, missing data). Use `mockFetch()` to simulate API failures and `vi.useFakeTimers()` for deterministic time.

### What NOT to test (for now)

- **Broad DOM-rendered React integration tests** — jsdom is available only when a test opts in via `// @vitest-environment jsdom` (for example `src/hooks/__tests__/use-chart-container-ready.test.tsx`). Most existing tests stay pure or use server rendering instead of full browser-like component integration.
- **API/worker handlers (full integration)** — the D1 mock tests response shape, not SQL correctness. Full end-to-end worker testing would need a real D1 instance.
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

- `npm run check:cli-args-policy` scans every committed JavaScript/TypeScript source file for `process.argv`, requires exact enrollment in `scripts/lib/cli-argv-policy.mjs`, and verifies that strict operator/mutating entrypoints reach a parser that imports and calls `scripts/lib/cli-args.mjs`. Read-only, build/local-artifact, and test/dev exemptions are exact path records with audited reasons; new unclassified scripts fail rather than increasing a baseline. It runs in advisory prebuild mode and can be run directly when CI/operator scripts change.
- `check:oracle-risk-coverage:enforce` remains the direct content guardrail for CDP oracle profiles and required branch evidence. It runs in advisory prebuild mode; its reviewed applicability queue is advisory for current v8 scoring, while explicit unresolved dispositions remain v9 blockers rather than silently passing as profile-only evidence.
- `src/lib/__tests__/term-markup.test.ts` owns AI-summary glossary-marker integrity as an ordinary noncritical runtime-parser test, including known slugs, balanced markers, and the current corpus totals.
- Mechanism explainer completeness is split across ordinary noncritical domain tests: `src/app/learn/mechanisms/__tests__/content.test.ts` owns labels, one-liners, editorial content, and representative coin IDs; the existing dynamic-route test owns exact static params; `src/app/__tests__/sitemap-frozen.test.ts` owns sitemap membership. OG images remain generated-artifact-owned.
- `shared/lib/selector/__tests__/editorial-policy.test.ts` owns the Selector banned-phrase rule matrix and complete editorial corpus as an ordinary noncritical domain test (41 files at relocation), including Picker route/component copy and checked-in worked examples.
- `scripts/__tests__/weekly-curation-digest.test.ts` owns attestor-tier, coin one-liner, and mechanism-archetype coverage as an ordinary noncritical domain test. It reads authored per-coin entries and preserves the editorial rubric: all active/pre-launch coins need nonblank one-liners, more than 20% missing attestor tiers fails the independent-audit cohort, and unknown baseline IDs or more than 27% missing archetypes fails the fixed non-variant/non-frozen cohort.
- `npm run check:redemption-backstops` validates the redemption-backstop registry split across `shared/lib/redemption-backstop-configs/*`, catches duplicate IDs across modules, enforces allowed route-family membership per module, and keeps the headline counts in `docs/redemption-backstops.md` synced to the real registry.
- `npm run check:redemption-coverage-audit` requires every active unconfigured asset to have a source-reviewed row in `scripts/lib/redemption-coverage-dispositions.ts`. It rejects missing, duplicate, unknown, inactive, configured-stale, and malformed reviews, ranks the queue by canonical market-cap order, and ratchets total active gaps plus heuristic configured routes through `scripts/lib/redemption-coverage-audit-baseline.json`. Default-inferred active classifications must remain zero.
- `worker/src/lib/__tests__/redemption-backstops-store.test.ts` now covers completed-run snapshot manifests for `redemption_backstop_runs`, including generation-filtered reads and current/history rows written with `snapshot_run_id`.

### Test style

- Use `describe` per function, `it` per behavior.
- Test names describe the behavior, not the implementation: `"returns 0 for undefined input"` not `"calls sumPegBuckets with undefined"`.
- Use the `mockCoin()` helper (see `supply.test.ts`) for partial `StablecoinData` mocks — avoids `as any` casts.
- Use shared fixtures from `worker/src/test-helpers/__shared/fixtures.ts` for DB row mocks.
- Keep tests focused: one assertion per `it` block when possible.

## Coverage

Full-suite coverage threshold is not enforced. The critical gate applies a 40% default plus explicit per-file floors ranging from 30% to 80%, and touched critical files also have a no-regression ratchet. Run `npm test -- --coverage` to generate a detailed report. The V8 provider generates both text output and an `lcov` report for CI integration.

### Critical Coverage Gate

CI does **not** run a full-suite coverage gate. The blocking PR/deploy validate workflow also does not run `coverage:critical`; it runs the normal sharded Vitest lane, including critical tests. The weekly/manual Critical Coverage Ratchet workflow runs the critical-path coverage gate via `npm run coverage:critical`:

- Runs coverage for critical suites only (contract + invariant + targeted reliability suites for alerts/detail/dex orchestrator)
- Scopes v8 remapping to the enrolled critical source via per-file `--coverage.include` flags (built in `buildCriticalCoverageArgs`); per-file numbers are unchanged, the reporter just stops remapping the rest of the module graph
- Parses `coverage/lcov.info`
- Fails CI if any critical file falls below `CRITICAL_COVERAGE_THRESHOLD` (default: 40%, currently pinned to 40 in CI)
- Applies explicit per-file minimums for selected reliability paths (`alerts`, `auth`, `evm-rpc`, `discovery`, `health`, `stablecoin-detail`, `dex-liquidity/orchestrator`, plus the other file-specific overrides in `scripts/ci/check-critical-coverage.mjs`)
- For touched critical files, enforces a no-regression ratchet using `.ci/critical-coverage-baseline.json`
- Fails closed when an explicit `CRITICAL_COVERAGE_COMPARE_REF` cannot be diffed, so a bad ref cannot silently disable the touched-file ratchet
- The weekly `Critical Coverage Ratchet` workflow sets `CRITICAL_COVERAGE_RATCHET_ALL=1` so untouched critical files are checked regularly without making every PR/deploy validate run pay that full ratchet cost.
- Local rehearsals that need coverage ratchet behavior should run `npm run coverage:critical` directly with the relevant `CRITICAL_COVERAGE_*` env controls.

Gate scripts and ownership:

- `scripts/lib/critical-test-files.mjs` owns critical test-file membership.
- `scripts/lib/critical-coverage.mjs` owns critical source-file ratchet membership.
- `scripts/ci/check-critical-coverage.mjs` owns threshold parsing, explicit per-file override handling, and touched-file ratchet enforcement.

Useful env controls:

- `CRITICAL_COVERAGE_THRESHOLD`
- `CRITICAL_COVERAGE_COMPARE_REF`
- `CRITICAL_COVERAGE_CHANGED_FILES`
- `CRITICAL_COVERAGE_RATCHET_TOLERANCE`
- `CRITICAL_COVERAGE_RATCHET_ALL`
- `CRITICAL_COVERAGE_BASELINE_FILE`
- Per-file overrides: `CRITICAL_COVERAGE_THRESHOLD_ALERTS`, `CRITICAL_COVERAGE_THRESHOLD_AUTH`, `CRITICAL_COVERAGE_THRESHOLD_EVM_RPC`, `CRITICAL_COVERAGE_THRESHOLD_STABLECOINS_CACHE`, `CRITICAL_COVERAGE_THRESHOLD_SAFETY_SCORES`, `CRITICAL_COVERAGE_THRESHOLD_SCHEDULED`, `CRITICAL_COVERAGE_THRESHOLD_DAILY_DIGEST`, `CRITICAL_COVERAGE_THRESHOLD_STABLECOIN_DETAIL`, `CRITICAL_COVERAGE_THRESHOLD_DISCOVERY`, `CRITICAL_COVERAGE_THRESHOLD_HEALTH`, `CRITICAL_COVERAGE_THRESHOLD_STATUS`, `CRITICAL_COVERAGE_THRESHOLD_DEX_ORCHESTRATOR`, `CRITICAL_COVERAGE_THRESHOLD_API_PAGINATION`

Selected files have explicit threshold overrides in `scripts/ci/check-critical-coverage.mjs`; keep that map as the source of truth instead of duplicating override values in prose.

### Critical Test Suites

- `npm run test:critical-contracts` is a targeted local runner for the explicitly enumerated contract suites owned by `scripts/lib/critical-test-files.mjs`; keep the npm script as a runner only instead of duplicating suite membership in prose or `package.json`.
- `npm run test:invariants` covers numerical/schema invariants and cache-write validation guards in critical cron paths.
- `npm run validate:prebuild` runs the reduced blocking prebuild guardrail set by default. `VALIDATE_PREBUILD_SURFACE=pages|worker|full` keeps the deploy-impact filter, `VALIDATE_PREBUILD_INCLUDE_ADVISORY=1` restores advisory maintenance checks for transition deploys or explicit local rehearsals, and `VALIDATE_PREBUILD_SKIP_COMMANDS` is available to callers that need explicit command skips. Use `npm run validate:prebuild -- --dry-run` to print the effective surface and exact command plan without executing checks.
- `npm run validate:pages` and `npm run validate:worker` are fixed sequential CI phase entrypoints backed by the Pages and Worker command groups in `scripts/lib/validation-lanes.mjs`. They support `--dry-run` and `--help`, preserve leaf diagnostics, and keep workflow YAML out of command ownership.
- `npm run test:merge-gate` is the delta-aware local release rehearsal; `npm run test:merge-gate:discover` uses the same deploy-impact plan for diagnostics, with advisory prebuild checks still opt-in. Exact range selection, optional pre-push execution, receipt reuse, environment controls, smoke inclusion, and release-proof semantics belong to [Deployment Process](./deployment-process.md#what-testmerge-gate-does).
- `npm run test:smoke-api` checks `/api/health` plus either the strict endpoint contract set or its deploy-canary subset.
- `npm run test:smoke-ops` checks the Access-protected operator UI/API surfaces and their same-origin proxy where an authenticated session is available.
- `npm run test:smoke-transport` verifies that public HTTP API origins upgrade to the exact HTTPS host, path, and query.
- `npm run test:smoke-ui` covers the main hydrated browser path, analytics, first-party data availability, and responsive overflow checks; `npm run test:smoke-ui:mobile` applies the stricter tracked mobile-route geometry and control-size assertions. Production scope, retries, environment, and publish ordering remain canonical in [Deployment Process](./deployment-process.md#ci-deploy-sequence).

### Tier-3 Structural Refactor Targeted Suites

These are the narrow suites used to lock behavior parity before and after the Tier-3 structural extractions:

- `npm test -- src/lib/__tests__/stablecoin-detail-derive.test.ts` validates pure detail-page derivations independently of React rendering.
- `npm test -- worker/src/lib/__tests__/mint-burn-pipeline.test.ts` validates shared cron/backfill ingestion helpers without endpoint orchestration noise.
- `npm test -- worker/src/cron/__tests__/sync-mint-burn.test.ts worker/src/api/__tests__/backfill-mint-burn.test.ts` validates entrypoint-level progression semantics (`inserted/ignored`, burn counters, `done/nextFromBlock`, sync-state mode differences).

## Adding a New Test

**Frontend library test:**

1. Create `src/lib/__tests__/<module>.test.ts`.
2. Import from the module under test using the canonical boundary:
   - `@shared/*` for runtime-shared modules
   - `@/lib/*` for frontend-only modules
3. Write `describe`/`it` blocks following the conventions above.
4. Run `npm test` to verify, then `npm run lint` to check for issues.

**Worker library test:** Same as above but in `worker/src/lib/__tests__/`. Import via relative paths (no `@/` alias).

**API contract test:** Create in `worker/src/api/__tests__/`. Import the handler and use `mockD1()` from `../../test-helpers/__shared/mock-d1.ts`. Use shared fixtures from `../../test-helpers/__shared/fixtures.ts` for row data. Validate response shape against Zod schemas from `shared/types/index.ts`.

**Cron test:** Create in `worker/src/cron/__tests__/`. Mock external dependencies with `vi.mock()` and HTTP calls with `mockFetch()`. Test both normal path and at least one degraded-mode scenario.

Example API contract test:

```ts
import { describe, it, expect } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
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
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { mockFetch } from "../../test-helpers/__shared/mock-fetch";

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

**Ignored paths:** `.next/`, `out/`, `build/`, `coverage/`, `.claude/`, `.codex-autorunner/`, `agents/**`, `worker/.wrangler/`, `.worktrees/`, `worktrees/`, and `next-env.d.ts` (auto-generated build artifacts, agent scratch areas, and worktree directories). The conditional worktree behavior described earlier applies to Vitest coverage globs, not ESLint.

### Zod Runtime Validation

Schema validation in hooks is done via `useApiQuery(..., { schema })` / `useApiQueryWithMeta(..., { schema })`. Current schema-validated response paths include:

- `StablecoinListResponseSchema`
- `SupplyHistoryResponseSchema`
- `HealthResponseSchema`
- `BluechipRatingsMapSchema`
- `BlacklistResponseSchema`
- `BlacklistSummaryResponseSchema`
- `DepegEventsResponseSchema`
- `PegSummaryResponseSchema`
- `DexLiquidityMapSchema`
- `RedemptionBackstopsResponseSchema`
- `StabilityIndexResponseSchema`
- `ReportCardsResponseSchema`
- `SafetyScoreHistoryResponseSchema`
- `MintBurnFlowsResponseSchema`
- `MintBurnPerCoinResponseSchema`
- `MintBurnEventsResponseSchema`
- `StressSignalsAllResponseSchema`
- `StressSignalDetailResponseSchema`
- `YieldHistoryResponseSchema`
- `YieldRankingsResponseSchema`
- `StablecoinReservesResponseSchema`
- `StablecoinChartResponseSchema`
- `UsdsStatusResponseSchema`
- `ChainsResponseSchema`

Use `rg "schema:" src/hooks src/lib` for the live callsite set before adding or auditing endpoint validation.

When a schema is provided, frontend API helpers now validate in `strict` mode by default and throw on schema mismatch. Use `contractMode: "warn"` only for explicitly degraded surfaces where returning raw data is acceptable.

When adding a new API endpoint:

1. Define the response schema in `shared/types/index.ts` if the response has nested arrays or objects accessed via `.find()` / `.map()`
2. Pass the schema to `useApiQuery` via `{ schema: MyResponseSchema }`
3. Add a contract test in `worker/src/api/__tests__/` if the endpoint has multiple response modes

**Narrow-type gotcha:** If your response type uses string unions or branded types (e.g. `ReportCardGrade`, `DimensionKey`), prefer the shared hand-written interfaces and keep any unavoidable schema wiring/casts localized in the consolidated hook module (`src/hooks/api-hooks.ts`).

**Worker CI note:** `shared/types/index.ts` imports `zod`, and the worker type-checks shared modules via the `@shared/*` path alias in the `validate` job (`npm run typecheck:worker`) before any deploy step runs. Root deps are installed first (`npm ci`) through the npm workspace so shared imports resolve from root `node_modules/`. If you add new npm packages imported at the top level of shared files, they do not need duplication in `worker/package.json` unless the worker uses a worker-local runtime/deploy path that genuinely requires it.
