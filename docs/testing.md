# Testing & Linting

## Overview

The project uses **Vitest** for unit tests and **ESLint** (via `eslint-config-next`) for linting. The shared validation suite runs in CI on pull requests to `main`, while push/manual production deploys reuse the same validate workflow with deploy-surface-aware conditionals.

## Commands

```bash
npm test              # Run all tests once (CI mode)
npm run test:watch    # Watch mode — re-runs on file changes
npm run lint          # ESLint across frontend + worker code
npm run audit:deps    # Fails on high-severity npm advisories
npm run seo:check     # Static SEO audit against built `out/` HTML
npm run check:worker-boundary # Enforce the shared boundary in both directions (no worker -> `src` imports, no `src`/`shared`/`scripts`/`functions` -> `worker/src` imports)
npm run check:shared-cycles # Fail on circular dependencies inside `shared/`
npm run check:unused-code # Detect unreferenced internal runtime modules and unused named exports across `src/`, `shared/`, `worker/src/`, and `functions/`
npm run check:hotspot-ratchet # Fail when key hotspot files grow beyond the checked-in baseline
npm run check:cron-sync # Verify `shared/lib/cron-jobs.ts` stays aligned with `worker/wrangler.toml` cron declarations
npm run check:cron-connections # Enforce the documented per-trigger outbound connection budget across cron slots
npm run check:doc-sync # Verify exact methodology versions, thresholds, weights, and enforced limits stay aligned with code
npm run check:migrations # Replay worker D1 migrations against a throwaway SQLite DB
npm run lint -- --fix # Auto-fix fixable warnings (stale directives, etc.)
npm test -- --coverage # Run tests with V8 coverage report
npm run test:critical-contracts # Critical endpoint contract suite
npm run test:invariants # Critical numerical/schema invariant suite
npm run coverage:critical # Critical-suite coverage run + critical-path line-coverage gate
npm run test:merge-gate # Delta-aware local gate before pushing merged worktree changes
npm run test:smoke-api -- --base-url https://api.pharos.watch # HTTP smoke checks for critical API endpoints
npm run test:smoke-ops # Private ops-host and ops-api smoke checks through Cloudflare Access
npm run test:smoke-ui -- --url https://pharos.watch --mode live # Browser-level UI smoke check; local mode runs the full overflow sweep, live mode runs a narrower canary smoke
```

When `SMOKE_UI_EXPECT_GA_ID` is set, `npm run test:smoke-ui` also verifies that the homepage HTML includes the expected GA script tag and `gtag('config', ...)` initialization before it runs the browser checks.

## CI Pipeline

Defined across `.github/workflows/validate-ci.yml`, `.github/workflows/pull-request-checks.yml`, `.github/workflows/deploy-cloudflare.yml`, `.github/workflows/pages-release.yml`, `.github/workflows/rebuild-pages.yml`, and `.github/workflows/codeql.yml`.

For deployment/worktree operating procedure (including the local merge gate before every push), see [Deployment Process](./deployment-process.md).

1. `Pull Request Checks`
   - runs the shared `validate` gate on `pull_request` to `main`
   - uses the reusable workflow defaults, so PRs still run the full validate surface (`build` + `seo:check` + worker typecheck included)
   - uses the PR base SHA for the critical-coverage ratchet diff
2. `validate` (runs before any deployment):
   - `npm run audit:deps`
   - `npm run lint`
   - `npm run check:worker-boundary`
   - `npm run check:shared-cycles`
   - `npm run check:migrations`
   - `npm run check:cron-sync`
   - `npm run check:cron-connections`
   - `npm run check:doc-counts`
   - `npm run check:doc-sync`
   - `npm run check:duplicate-exports`
   - `npm run check:redemption-backstops`
   - `npm run check:unused-code`
   - `npm run check:hotspot-ratchet`
   - `npm test`
   - `npm run coverage:critical`
   - `npm run build` + `npm run seo:check` when `pages_changed=true` (always true on PR validate, diff-aware on deploy pushes)
   - `cd worker && npx tsc --noEmit` when `worker_changed=true` (always true on PR validate, diff-aware on deploy pushes)
3. `detect-changes` (push/manual deploy workflow only):
   - Diffs `github.event.before..github.sha` on `push`
   - Emits `deploy_required`, `worker_changed`, and `pages_changed`
   - Marks worker/API deploy work as required only when the push touches worker/shared runtime or worker-deploy infra files
   - Marks Pages deploy work as required only when the push touches Pages-impacting paths (`src/`, `shared/`, `functions/`, `public/`, `data/`, selected build/config scripts, or Pages/deploy workflow files)
   - Skips the heavy deploy workflow entirely when neither Pages nor worker deploy surfaces changed
   - Forces the full path on `workflow_dispatch`
4. `deploy-worker` (needs `validate` and `detect-changes`):
   - Apply D1 migrations with the local worker-pinned Wrangler CLI
   - Deploy worker with the local worker-pinned Wrangler CLI
   - Sync routes/domains/cron triggers with `wrangler triggers deploy`
   - Skipped on Pages-only or non-deploy `push` events
5. `smoke-api` (needs `deploy-worker` when worker/API work is required):
   - `npm ci`
   - Run `npm run test:smoke-api`
   - Uses `SMOKE_API_BASE` from `vars.SMOKE_API_BASE_URL` (preferred) or `vars.API_BASE_URL`
   - Runs strict API checks sequentially with bounded transient retry behavior (`SMOKE_API_RETRY_COUNT` default `1`, `SMOKE_API_TIMEOUT_MS` default `12000`)
   - Skipped on Pages-only or docs-only `push` events alongside `deploy-worker`
6. `pages-release`:
   - reusable workflow in `.github/workflows/pages-release.yml`
   - runs only when `pages_changed=true`
   - waits for `smoke-api` only when worker/API work was also required for that push
   - executes `build-pages -> smoke-ui -> deploy-pages -> smoke-ui-live` as one shared Pages release path
   - `build-pages` fetches `/api/digest-archive` once from the target API environment into `data/digests.json`, forwards `NEXT_PUBLIC_GA_ID` from GitHub repo vars into `npm run build`, then runs `npm run seo:check`, and uploads `out/`
   - `smoke-ui` still serves that exact artifact locally and runs `npm run test:smoke-ui -- --url http://127.0.0.1:4173 --mode local`
   - when `SMOKE_UI_EXPECT_GA_ID` is configured, that smoke step also verifies the built homepage HTML still contains the expected GA snippet
   - `deploy-pages` still publishes the verified artifact with the Wrangler retry loop
   - `smoke-ui-live` then verifies the real public host with `npm run test:smoke-ui -- --url https://pharos.watch --mode live`
7. `smoke-ui-live` (worker-only push path):
   - Runs only when `worker_changed=true` and `pages_changed=false`
   - Runs `npm run test:smoke-ui -- --url https://pharos.watch --mode live`
   - when `SMOKE_UI_EXPECT_GA_ID` is configured, also verifies the live homepage HTML still contains the expected GA snippet
   - Verifies that the unchanged live Pages frontend still works against the newly deployed worker/API without repeating the full local overflow sweep
8. `smoke-ops`:

- Run `npm run test:smoke-ops`
- Uses `SMOKE_OPS_UI_URL` / `SMOKE_OPS_API_BASE` (defaults: `https://ops.pharos.watch/admin/`, `https://ops-api.pharos.watch`)
- Requires repository secrets `OPS_SMOKE_CF_ACCESS_CLIENT_ID` and `OPS_SMOKE_CF_ACCESS_CLIENT_SECRET`
- Runs after `pages-release` on Pages-including deploys, or after `smoke-api` + `smoke-ui-live` on worker-only deploys
- Verifies the ops UI host is Access-gated (or service-token-accessible, if configured) plus `status`, `status-history`, and a safe dry-run admin path on the operator API host

9. `Rebuild Pages`:

- defined in `.github/workflows/rebuild-pages.yml`
- runs on the daily schedule and on manual dispatch
- skips `validate`, `deploy-worker`, and `smoke-api`
- runs the shared `pages-release` workflow and then `smoke-ops`

10. `CodeQL`:

- defined in `.github/workflows/codeql.yml`
- runs on pushes to `main`, pull requests to `main`, and a weekly Monday schedule
- analyzes the JavaScript/TypeScript codebase separately from the deploy pipeline

This arrangement keeps pull-request validation full-strength, makes deploy-path validation conditional on the surfaces that actually changed, skips the production workflow entirely for non-deploy pushes, proves the static export build and SEO gate before merge and on Pages-impacting deploys, fetches digest data once inside the Pages build job so the build itself is network-independent with respect to digest data, forwards the configured GA measurement ID into CI builds so the static artifact matches production analytics posture, keeps the broad overflow sweep on the local artifact smoke before Pages production deploy, verifies the real `pharos.watch` host after each Pages publish with a narrower live canary smoke, keeps the scheduled digest rebuild off the worker deploy path, and still runs the post-deploy ops-surface smoke after each production-changing workflow.

The workflows pin `actions/checkout@v6` and `actions/setup-node@v6` by commit SHA and run project tooling on Node 22 (`node-version: 22`). Worker deploys intentionally avoid `cloudflare/wrangler-action`; the repo now uses a root npm workspace, so CI installs the shared toolchain from the root lockfile and invokes Wrangler with `npx --no-install`. `npm run audit:deps` also runs in the validate job so high-severity advisories fail the push/manual deploy pipeline before deploy. The production-changing workflows also share a `concurrency` group (`production-deploy-${{ github.ref }}`): push/manual deploys cancel superseded in-flight runs, while the scheduled/manual Pages rebuild queues behind an active production deploy instead of interrupting it.

`npm run check:migrations` replays every file in `worker/migrations/` against a throwaway SQLite database before deploy. It uses Node's built-in `node:sqlite` module on Node 22+ and falls back to the `sqlite3` CLI when needed, which catches schema typos in unapplied D1 migrations before `deploy-worker` touches production. Historical duplicate migration prefixes are tracked explicitly in `worker/migrations/MANIFEST.md`; the checker fails only on new undeclared duplicates and keeps the current allowlist visible in review. The same check now also enforces the rollout-safety contract for new migrations starting at `0071`: every new migration must declare `-- rollout-safety: backward-compatible`, and obvious table/column drop or rename patterns are rejected because the standard deploy path applies D1 migrations before the new worker is live.

`npm run test:merge-gate` now mirrors the deploy-path validate contract locally. If the changed-file set is not deploy-impacting, it prints the diff and exits successfully. For deploy-impacting diffs, it always runs `audit:deps`, lint, worker-boundary, shared-cycle detection, migrations, cron schedule/connection checks, doc sync checks, duplicate-export and redemption-backstop guards, unused-code, hotspot-ratchet, the full test suite, and critical coverage. It adds `npm run build` + `npm run seo:check` when Pages-impacting files changed, and adds `cd worker && npx tsc --noEmit` when worker-impacting files changed. It still skips deploy-time smoke suites.

`npm run check:unused-code` now scans all runtime code under `src/`, `shared/`, `worker/src/`, and `functions/`, with explicit module/export allowlists for intentional exceptions. `npm run check:hotspot-ratchet` now guards seventeen tracked hotspot files, including `src/app/coverage/client.tsx`, `src/app/methodology/sections/monitoring-sections.tsx`, `src/app/methodology/scoring-changelog/page.tsx`, `worker/src/cron/daily-digest.ts`, `worker/src/cron/enrich-prices.ts`, `worker/src/cron/sync-blacklist.ts`, `worker/src/cron/yield-sync/sources.ts`, `worker/src/lib/live-reserves-store.ts`, and `worker/src/lib/status-reliability.ts`; refresh the baseline only after an intentional refactor with `npm run check:hotspot-ratchet:update-baseline`.

`npm run check:cron-sync` is part of the shared CI validate gate. Run it locally whenever you change `worker/wrangler.toml` cron expressions or `shared/lib/cron-jobs.ts` so you catch schedule drift before pushing.

`npm run seo:check` is the static-export SEO gate. It inspects the built `out/` HTML for missing title/description/canonical/OpenGraph/Twitter tags, duplicate or missing `h1`s on indexable pages, CSR bailout markers, sitemap omissions, orphan pages, and indexable routes that are more than three clicks away from `/`.

## Test Setup

**Config:** `vitest.config.ts`

```ts
const isWorktreeCheckout = normalizedRoot.includes("/.worktrees/") || normalizedRoot.includes("/worktrees/");
const worktreeExcludes = isWorktreeCheckout ? [] : [".worktrees/**", "worktrees/**"];

export default defineConfig({
  test: {
    exclude: [...worktreeExcludes, ".next/**", "out/**", "coverage/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: { lines: 66 }, // Local full-suite coverage reference; CI enforces the critical coverage gate separately
    },
  },
  resolve: { alias: { "@": path.resolve(__dirname, "src"), "@shared": path.resolve(__dirname, "shared") } },
});
```

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
- `shared/lib/__tests__/` — shared library tests (format, classification invariants, peg rates, stablecoin registry)
- `scripts/__tests__/` — repo policy / guardrail tests for CI and developer tooling
- `src/components/stablecoin-detail/__tests__/` — stablecoin detail component tests
- `worker/src/cron/reserve-adapters/__tests__/` — reserve adapter tests (20+ adapters)
- `worker/src/cron/dex-discovery/__tests__/` — DEX discovery module tests
- `worker/src/cron/dex-liquidity/__tests__/` — DEX liquidity scoring module tests

Recent cron reliability coverage explicitly exercises slot-fencing and no-write guardrails as well: stablecoins stale-publication blocking, PSI fail-closed dependency loss, DEWS bootstrap/freshness degradation, digest Telegram replay safety, bluechip partial-cache merge, and yield deterministic-source outage handling all live in the worker cron suites above.

PSI now also has dedicated replay/regression coverage beyond the pure formula tests:

- `worker/src/lib/__tests__/psi-recompute.test.ts` covers historical input reconstruction, PSI-universe filtering, and replay denominator rules
- `worker/src/lib/__tests__/psi-replay.test.ts` covers methodology-aware historical replay behavior, including `v3.x` DEWS stress-breadth inclusion
- `worker/src/lib/__tests__/psi-benchmark-scenarios.test.ts` holds bounded benchmark scenarios for major stable-market trauma patterns so future PSI work does not accidentally flatten crisis signatures

**Pattern:** `*.test.ts` / `*.test.tsx` — Vitest discovers files matching `**/*.{test,spec}.?(c|m)[jt]s?(x)`.

## Test Infrastructure

### Mock D1 (`worker/src/api/__tests__/helpers/mock-d1.ts`)

Lightweight D1 mock. By default it matches on SQL substrings, but critical-path tests can opt into stricter behavior.

```ts
import { mockD1 } from "./helpers/mock-d1";

const db = mockD1([
  { match: "COUNT", rows: [{ total: 5 }] },
  { match: "blacklist_events", rows: [row1, row2] },
]);
```

- `match` — substring to look for in the SQL query
- `rows` — array of row objects for `.all()` results
- `first` — optional single object for `.first()` results
- `batch()` — executes each statement's `.all()` and returns array of results
- `mockD1(tables, { requireMatch: true })` — throws if executed SQL does not match a configured entry
- `mockD1(tables, { strictSql: true })` — matches normalized SQL exactly instead of substring search
- `db.assertAllMatchesUsed()` — optional assertion that every configured match was exercised during the test

### Mock Fetch (`worker/src/api/__tests__/helpers/mock-fetch.ts`)

Stubs global `fetch` for testing cron jobs that make HTTP requests.

```ts
import { mockFetch } from "./helpers/mock-fetch";

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
- Call `vi.restoreAllMocks()` in `afterEach` to clean up

### Shared Fixtures (`worker/src/api/__tests__/helpers/fixtures.ts`)

Factory functions that return complete DB rows with sensible defaults. Pass `overrides` for specific values.

| Factory                        | Returns                                                                     |
| ------------------------------ | --------------------------------------------------------------------------- |
| `makeAsset()`                  | DL pegged asset (id, symbol, price, pegType, circulating, chainCirculating) |
| `makeBlacklistRow()`           | blacklist_events row                                                        |
| `makeDepegRow()`               | depeg_events row                                                            |
| `makeSupplyRow()`              | supply_history row                                                          |
| `makeMintBurnRow()`            | mint_burn_events row                                                        |
| `makeDexLiquidityRow()`        | dex_liquidity row (with v2 fields)                                          |
| `makeYieldHistoryRow()`        | yield_history row                                                           |
| `makeDexLiquidityHistoryRow()` | dex_liquidity_history row                                                   |
| `makeDigestRow()`              | daily_digest row                                                            |

Example:

```ts
import { makeBlacklistRow } from "./helpers/fixtures";

const row = makeBlacklistRow({ stablecoin: "USDC", event_type: "freeze" });
```

### Shared Auth Helpers (`worker/src/api/__tests__/helpers/auth.ts`)

Use these helpers in worker API contract tests that exercise admin auth and URL/request plumbing.

```ts
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "./helpers/auth";

stubCryptoForAuth();

const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
const url = makeApiUrl("/api/status?limit=5");
```

- `stubCryptoForAuth()` — shared `crypto.subtle` stub for `requireAdmin`-based handlers.
- `makeApiRequest(path, options)` — creates requests with optional `method`, `adminKey`, `headers`, and `body`.
- `makeApiUrl(path)` — normalizes relative API paths into `https://x/...` URLs.

Use these helpers instead of duplicating per-file `vi.stubGlobal("crypto", ...)` or repetitive request builders.

## Test File Inventory

This inventory is representative, not exhaustive. For the full current list, run:

```bash
rg --files src shared worker/src functions scripts | rg '(^|/)__tests__/|\\.(test|spec)\\.' | sort
```

### Frontend Library Tests (`src/lib/__tests__/`)

| File                                   | Module Under Test                                                     | What It Covers                                                                                                                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format.test.ts`                       | `shared/lib/format.ts`                                                | `formatCurrency`, `formatBps`, `formatPegDeviation`, `formatPercentChange`, `formatSupply`, `formatAddress`, `formatDuration`, `formatNativePrice`, `formatPegStability`, `formatDeathDate`, `formatDeathDateShort` |
| `supply.test.ts`                       | `shared/lib/supply.ts`                                                | `sumPegBuckets`, `getCirculatingRaw`, `getPrevDayRaw`, `getPrevWeekRaw`, `getPrevMonthRaw`                                                                                                                          |
| `classification.test.ts`               | `shared/lib/classification.ts`                                        | Label maps, short label consistency, color map integrity, `PEG_CURRENCY_COUNT`                                                                                                                                      |
| `report-cards.test.ts`                 | `shared/lib/report-cards.ts`                                          | Grade computation, dimension scorers, peg multiplier, dependency risk, stress test                                                                                                                                  |
| `reserve-templates.test.ts`            | `shared/lib/reserve-templates.ts`                                     | Reserve composition templates, `getReserves()`, `deriveDependencies()`                                                                                                                                              |
| `reserve-coinid-validation.test.ts`    | `shared/lib/reserve-templates.ts`                                     | Reserve slice `coinId` references match tracked stablecoin IDs                                                                                                                                                      |
| `liquidity-coverage.test.ts`           | `src/lib/dex-constants.ts`                                            | DEX pool configs cover all stablecoins with DEX presence                                                                                                                                                            |
| `api-endpoints.test.ts`                | `shared/lib/api-endpoints.ts`                                         | Endpoint registry invariants: probe groups, status actions, cache/method flags, strict contract path uniqueness, smoke assertion alignment                                                                          |
| `api-fetch-contracts.test.ts`          | `shared/types/index.ts` + `src/lib/api.ts`                            | Shared Zod contracts and frontend API helpers stay aligned on critical endpoints                                                                                                                                    |
| `critical-invariants.test.ts`          | Shared methodology constants and schema invariants                    | Cross-surface invariants for contracts, methodology metadata, and route-critical defaults                                                                                                                           |
| `coverage.test.ts`                     | `src/lib/coverage.ts`                                                 | Coverage-status derivation, feature headline summaries, and reserve/yield/flow availability semantics                                                                                                               |
| `data-health.test.ts`                  | `src/lib/data-health.ts`                                              | Frontend freshness-band derivation and stale/degraded banner helpers                                                                                                                                                |
| `blacklist-api.test.ts`                | `src/lib/blacklist-api.ts`                                            | Query param encoding and API path generation for blacklist filters                                                                                                                                                  |
| `dews-radar-utils.test.ts`             | `src/lib/dews-radar-utils.ts`                                         | DEWS radar interaction geometry and deterministic calm-dot placement helpers                                                                                                                                        |
| `methodology-version.test.ts`          | `shared/lib/methodology-version.ts`                                   | Version-window resolution, labels, and changelog selection logic                                                                                                                                                    |
| `mint-burn-timeframes.test.ts`         | `src/lib/mint-burn-timeframes.ts`                                     | Timeframe presets and label semantics for flow views                                                                                                                                                                |
| `peg-scoring.test.ts`                  | `shared/lib/peg-score.ts` + `src/lib/peg-stability.ts`                | Peg score computation helpers plus UI-facing peg-stability formatting                                                                                                                                               |
| `portfolio-codec.test.ts`              | `src/lib/portfolio-codec.ts`                                          | Portfolio codec round-trips and canonical-ID migration behavior                                                                                                                                                     |
| `stablecoin-detail-derive.test.ts`     | `src/lib/stablecoin-detail-derive.ts`                                 | Stablecoin detail pure derivations: supply fallback, deviation guards, 90d reference tolerance, peg-reference fallback                                                                                              |
| `stablecoin-detail-view-model.test.ts` | `src/lib/stablecoin-detail-view-model.ts`                             | Detail-page composed view-model derivation, reserve integration, and stale-query aggregation                                                                                                                        |
| `stablecoin-schema-compat.test.ts`     | `shared/data/stablecoins/*.json` + `shared/lib/stablecoins/schema.ts` | Tracked stablecoin JSON assets load successfully, preserve canonical ordering, and remain compatible with the shared metadata loader                                                                                |
| `start-here-callout.test.ts`           | `src/lib/start-here-callout.ts`                                       | Browser-persisted Start Here callout retirement and first-session visibility helpers                                                                                                                                |
| `yield-scatter.test.ts`                | `src/lib/yield-scatter.ts`                                            | Scatterplot point derivation and label bucketing for yield views                                                                                                                                                    |
| `severity-colors.test.ts`              | `src/lib/severity-colors.ts`                                          | Deviation threshold classes/icons/hex mapping, score-tier thresholds, peg/durability color helpers                                                                                                                  |

### Frontend Component Tests (`src/__tests__/`)

| File                           | What It Covers                                                     |
| ------------------------------ | ------------------------------------------------------------------ |
| `depeg-tracker-sort.test.ts`   | Depeg event sorting logic                                          |
| `page-metadata.test.ts`        | Metadata generation and canonical route wiring for indexable pages |
| `portfolio-categorize.test.ts` | Portfolio upstream exposure categorization                         |

### Component / Hook Utility Tests

| File                                                             | What It Covers                                                                                             |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/components/__tests__/cron-card.test.tsx`                    | Status cron-card server-render summaries for self-check, DEX discovery, and scoring runs                   |
| `src/components/__tests__/cron-config.test.ts`                   | Status cron config labeling and schedule presentation                                                      |
| `src/components/__tests__/action-recommendations.test.ts`        | Status-page recommended-action derivation from active causes and unhealthy lanes                           |
| `src/components/__tests__/coin-flow-card.test.tsx`               | Compare-page per-coin flow card rendering and coverage-state presentation                                  |
| `src/components/__tests__/comparison-table.test.tsx`             | Compare-table row rendering, formatting, and fallback-state handling                                       |
| `src/components/__tests__/data-quality-cards.test.tsx`           | Status data-quality card severity and threshold presentation                                               |
| `src/components/__tests__/dews-summary.test.ts`                  | DEWS radar tap/click interaction resolver logic                                                            |
| `src/components/__tests__/flow-table.test.tsx`                   | Flow table rendering, labels, and coverage badge presentation                                              |
| `src/components/__tests__/liquidity-stats.test.ts`               | Liquidity headline stat formatting and NR handling                                                         |
| `src/components/__tests__/liquidity-table.test.ts`               | Liquidity row comparator behavior and filter-driven pagination reset flow                                  |
| `src/components/__tests__/overview-section.test.tsx`             | Stablecoin-detail overview section rendering, reserve fallback labels, and summary-state composition       |
| `src/components/__tests__/safety-score-history-section.test.tsx` | Safety Score detail timeline seed/transition labeling and conditional suppression when loading/error/empty |
| `src/hooks/__tests__/use-count-up.test.ts`                       | Opt-in jsdom hook test for count-up animation timing and reduced-motion behavior                           |
| `src/hooks/__tests__/use-entrance-sequence.test.ts`              | Opt-in jsdom hook test for staged reveal sequencing                                                        |
| `src/hooks/__tests__/use-start-here-callout.test.ts`             | Hook-level Start Here onboarding state integration                                                         |
| `src/hooks/__tests__/use-url-filters.test.ts`                    | URL param state helpers and encoding rules                                                                 |
| `src/hooks/__tests__/query-polling-policy.test.ts`               | Shared polling policy wiring (`staleTime`, `refetchInterval`, `retry`) for status-page hooks               |
| `src/hooks/__tests__/use-safety-score-history.test.ts`           | Safety Score history hook query-key scoping, daily polling policy, and endpoint path wiring                |
| `src/hooks/__tests__/use-sort.test.ts`                           | Table sort state transitions and keyboard activation key gating                                            |
| `src/hooks/__tests__/use-sorted-table-rows.test.ts`              | Pure table row sorting helper behavior and immutability                                                    |
| `src/hooks/__tests__/use-table-pagination.test.ts`               | Pagination derivation + persisted page reset semantics when row totals change                              |

### Worker Library Tests (`worker/src/lib/__tests__/`)

| File                                  | Module Under Test                                          | What It Covers                                                                                                                        |
| ------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `alerts.test.ts`                      | `worker/src/lib/alerts.ts`                                 | Webhook transport semantics, non-2xx failure handling, return-value contract                                                          |
| `api-utils.test.ts`                   | `worker/src/lib/api-utils.ts`                              | `parseIntParam`, `parseStablecoinHistoryQuery`, `jsonResponse`, `errorResponse`, `withErrorHandler`, `createCacheHandler`             |
| `mint-burn-scoring.test.ts`           | `worker/src/lib/mint-burn-scoring.ts`                      | `computeFlowIntensity`, `computeGaugeScore`, `detectFlightToQuality`, `getGaugeBand`                                                  |
| `evm-logs.test.ts`                    | `worker/src/lib/evm-logs.ts`                               | `buildTopicParams`, `decodeAddress`, `decodeUint256`, `createBudget`, `budgetExhausted`, `createRateLimiter`, `fetchEvmLogsForTopics` |
| `resolve-market-cap.test.ts`          | `worker/src/lib/resolve-market-cap.ts`                     | `resolveMarketCap` — CG vs computed mcap agreement, frozen data detection                                                             |
| `dews.test.ts`                        | `worker/src/lib/dews.ts`                                   | `computeDEWS` — DEWS scoring, sub-signal computation, threat band assignment                                                          |
| `circuit-breaker.test.ts`             | `worker/src/lib/circuit-breaker.ts`                        | Circuit state machine: closed/open/half-open transitions, probe intervals, alerts                                                     |
| `stability-index.test.ts`             | `worker/src/lib/stability-index.ts`                        | PSI computation and component scoring                                                                                                 |
| `safety-scores.test.ts`               | `worker/src/lib/safety-scores.ts`                          | Shared safety score snapshot helper parity modes (`map` vs `full-grades`)                                                             |
| `report-cards-snapshot.test.ts`       | `worker/src/lib/report-cards-snapshot.ts`                  | Shared report-card snapshot parity with `/api/report-cards` and cache-unavailable behavior                                            |
| `peg-analytics.test.ts`               | `worker/src/lib/peg-analytics.ts`                          | Shared peg analytics derivation (`eventsByCoin`, `pegDataById`)                                                                       |
| `stablecoins-cache.test.ts`           | `worker/src/lib/stablecoins-cache.ts`                      | Strict/lenient cache loading, missing cache behavior, malformed payloads, legacy array compatibility, FX fallback-rate filtering      |
| `authoritative-price-sources.test.ts` | `worker/src/lib/authoritative-price-sources.ts`            | Shared authoritative live/historical provider resolution, protocol-quote replay coverage, and preservation-on-low-coverage behavior   |
| `abort.test.ts`                       | `worker/src/lib/abort.ts`                                  | Abort reason normalization, `throwIfAborted`, timed sleep resolution, abort-driven sleep rejection                                    |
| `alchemy-logs.test.ts`                | `worker/src/lib/alchemy-logs.ts`                           | `eth_getLogs` range splitting, timestamp hydration, and fallback-chain RPC behavior                                                   |
| `coingecko-onchain.test.ts`           | `worker/src/lib/coingecko-onchain.ts`                      | API-key availability flag, request pacing, token/pool fetch response handling, volume parsing                                         |
| `auth.test.ts`                        | `worker/src/lib/auth.ts`                                   | Timing-safe admin auth guards, header parsing, and unauthorized responses                                                             |
| `blacklist-contracts.test.ts`         | `worker/src/lib/blacklist-contracts.ts`                    | Shared contract-config invariants, address sourcing, and event-definition coverage                                                    |
| `db-utils.test.ts`                    | `worker/src/lib/db.ts` helpers                             | SQL helper composition and pagination/query utility behavior                                                                          |
| `idempotency.test.ts`                 | `worker/src/lib/idempotency.ts`                            | Idempotency-key dedupe, replay semantics, and conflict handling                                                                       |
| `live-reserves-store.test.ts`         | `worker/src/lib/live-reserves-store.ts`                    | Consistent live-snapshot resolution, fallback modes, and reserve-overview aggregation                                                 |
| `log-cron-run.test.ts`                | `worker/src/lib/cron-logger.ts`                            | Success/error/skipped logging and prune fallback behavior                                                                             |
| `mint-burn-bridge-classifier.test.ts` | `worker/src/lib/mint-burn-pipeline/classification.ts`      | CCIP bridge-burn classification and review fallbacks                                                                                  |
| `mint-burn-contracts.test.ts`         | `worker/src/lib/mint-burn-contracts.ts`                    | Contract config invariants, decimals, and event definition coverage                                                                   |
| `twitter.test.ts`                     | `worker/src/lib/twitter.ts`                                | Digest tweet text building, first-mention cashtag injection, truncation, OAuth posting/error handling                                 |
| `status-reliability.test.ts`          | `worker/src/lib/status-reliability.ts`                     | Hysteresis transitions, state snapshot staleness, transition listing, probe persistence, discrepancy streak/alert state               |
| `cron-leases.test.ts`                 | `worker/src/lib/cron-lease.ts`                             | `acquireCronLease`, `renewCronLease`, `releaseCronLease`, `runCronWithLease`                                                          |
| `mint-burn-pipeline.test.ts`          | `worker/src/lib/mint-burn-pipeline/*`                      | Shared ingestion helpers: inserted/ignored accounting, burn counters, affected-hour aggregation, sync-state upsert modes              |
| `mint-burn-price-heal.test.ts`        | `worker/src/lib/mint-burn-pipeline/price-heal.ts`          | NULL-price auto-heal path, 48h cutoff, and affected-hour collection                                                                   |
| `mint-burn-roundtrip.test.ts`         | `worker/src/lib/mint-burn-pipeline/roundtrip-detection.ts` | Same-transaction roundtrip tagging semantics                                                                                          |
| `price-validation.test.ts`            | `worker/src/lib/price-validation.ts`                       | Primary-price plausibility bounds, peg-aware validation, and fallback acceptance rules                                                |
| `psi-recompute.test.ts`               | `worker/src/lib/psi-recompute.ts`                          | PSI recomputation triggers and rebuild selection logic                                                                                |
| `telegram-alerts.test.ts`             | `worker/src/lib/telegram-alerts.ts`                        | Alert subscription filters and message rendering                                                                                      |
| `telegram.test.ts`                    | `worker/src/lib/telegram.ts`                               | Telegram Bot API send/reply behavior and error handling                                                                               |

### API Contract Tests (`worker/src/api/__tests__/`)

| File                                  | Handler                                                | Modes Tested                                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `router-contract.test.ts`             | `route` + strict frontend contract paths               | All strict paths resolve in `worker/src/router.ts`, unknown paths return null, mutating admin GET guards hold (with audit dry-run exception)         |
| `backfill-depegs.test.ts`             | `handleBackfillDepegs`                                 | Auth guard, unknown stablecoin 404, out-of-range batch no-op                                                                                         |
| `backfill-depegs-helpers.test.ts`     | `backfill-depegs` helper logic                         | Supply parsing/nearest-snapshot lookup, historical secondary-FX caching, FX lookup fallback/nearest selection, large-cap depeg confirmation behavior |
| `backfill-supply-history.test.ts`     | `handleBackfillSupplyHistory`                          | Auth guard, unknown stablecoin 404, out-of-range batch no-op, USD insertion path                                                                     |
| `backfill-cg-prices.test.ts`          | `handleBackfillCgPrices`                               | Auth guard, unknown stablecoin 404, out-of-range batch no-op, NULL-price fill                                                                        |
| `backfill-stability-index.test.ts`    | `handleBackfillStabilityIndex`                         | Auth guard, no-events 404, rebuild success shape                                                                                                     |
| `audit-depeg-history.test.ts`         | `handleAuditDepegHistory`                              | GET dry-run vs POST behavior, auth guard, and audit summary shape                                                                                    |
| `backfill-dews.test.ts`               | `handleBackfillDEWS`                                   | Admin auth, query parsing, and DEWS backtest response shape                                                                                          |
| `blacklist.test.ts`                   | `handleBlacklist`                                      | 200 with events, empty results, 400 invalid params, camelCase mapping, X-Data-Age                                                                    |
| `depeg-events.test.ts`                | `handleDepegEvents`                                    | 200 with events, empty results, 400 invalid params, camelCase mapping                                                                                |
| `supply-history.test.ts`              | `handleSupplyHistory`                                  | 200 with history, empty, 400 missing/invalid stablecoin                                                                                              |
| `dex-liquidity-history.test.ts`       | `handleDexLiquidityHistory`                            | 200 with history, empty, 400 missing/invalid stablecoin, coverage-confidence fields                                                                  |
| `yield-history.test.ts`               | `handleYieldHistory`                                   | 200 with history, empty, 400 missing/invalid stablecoin, camelCase                                                                                   |
| `safety-score-history.test.ts`        | `handleSafetyScoreHistory`                             | 200 with history/empty, 400 missing/invalid stablecoin, freshness headers                                                                            |
| `mint-burn-events.test.ts`            | `handleMintBurnEvents`                                 | 200 with events, camelCase mapping, invalid stablecoin/direction/chain/burnType guards, freshness headers                                            |
| `cache-passthrough.test.ts`           | stablecoins, charts, usds, bluechip                    | 503 cache miss, 200 with \_meta, X-Data-Age                                                                                                          |
| `yield-rankings.test.ts`              | `handleYieldRankings`                                  | 503 cache miss/corrupt-cache handling, live Safety Score hydration, orphan-row filtering, and freshness metadata                                     |
| `dex-liquidity.test.ts`               | `handleDexLiquidity`                                   | 200 with liquidity map, empty map, coverage-confidence fields, degraded Warning header, X-Data-Age                                                   |
| `peg-summary.test.ts`                 | `handlePegSummary`                                     | 503 cache miss, 200 with coins + summary, X-Data-Age                                                                                                 |
| `redemption-backstops.test.ts`        | `handleRedemptionBackstops`                            | 503 bootstrap miss, 503 snapshot-read failure, 200 with modeled route map + methodology metadata                                                     |
| `report-cards.test.ts`                | `handleReportCards`                                    | 503 cache miss, 200 with cards/methodology/dependencyGraph                                                                                           |
| `stablecoin-detail.test.ts`           | `handleStablecoinDetail`                               | Upstream retry/timeout fallback behavior, stale-cache fallback, parse-failure diagnostics                                                            |
| `stablecoin-summary.test.ts`          | `handleStablecoinSummary`                              | 503 cache-miss/corrupt-cache handling, 404 unknown coin, 200 compact supply/price summary + freshness headers                                        |
| `stablecoin-reserves.test.ts`         | `handleStablecoinReserves`                             | 404 gating for non-live coins, live/fallback reserve response modes, corrupt-snapshot fail-closed behavior, and cache-profile selection             |
| `stablecoin-detail-commodity.test.ts` | `fetchCommodityTokens` helper                          | DefiLlama-empty fallback to CoinGecko market-chart + failure fallback to empty                                                                       |
| `stablecoin-detail-defillama.test.ts` | `normalizeDefiLlamaDetailBody` helper                  | Non-USD normalization branches, USD no-op behavior, invalid JSON throw path                                                                          |
| `daily-digest.test.ts`                | `handleDailyDigest`                                    | 200 with null digest, 200 with digest text, X-Data-Age                                                                                               |
| `digest-archive.test.ts`              | `handleDigestArchive`                                  | 200 empty, 200 with digests, PSI/mcap from input_data, null input_data                                                                               |
| `digest-snapshot.test.ts`             | `handleDigestSnapshot`                                 | 400 missing/invalid date, 404 no digest, 200 with snapshot                                                                                           |
| `discovery.test.ts`                   | `handleDiscoveryCandidates` + `handleDismissCandidate` | Admin candidate listing, filtering, and dismiss mutation behavior                                                                                    |
| `health.test.ts`                      | `handleHealth`                                         | 200 health status shape, Cache-Control: no-store                                                                                                     |
| `feedback.test.ts`                    | `handleFeedback` + `worker/src/api/feedback/*`         | Payload validation, rate limiting, verification routing, and GitHub mode selection after request/policy/submission decomposition                     |
| `mint-burn-flows.test.ts`             | `handleMintBurnFlows`                                  | Aggregate (gauge + coins[]), per-coin (flat + chains[]), cached-fallback corrupt-cache handling, 404                                                 |
| `backfill-mint-burn.test.ts`          | `handleBackfillMintBurn`                               | Auth/validation, chunked ingestion progression, `done/nextFromBlock` semantics                                                                       |
| `backfill-mint-burn-prices.test.ts`   | `handleBackfillMintBurnPrices`                         | NULL-price backfill aggregation and response summary shape                                                                                           |
| `stability-index.test.ts`             | `handleStabilityIndex`                                 | Summary, Detail (with components in history)                                                                                                         |
| `status.test.ts`                      | `handleStatus`                                         | Admin status payload synthesis, cache/cron health aggregation, liquidity health extraction, and probe sections                                       |
| `status-history.test.ts`              | `handleStatusHistory`                                  | Timeline/probe history pagination and range filters                                                                                                  |
| `stress-signals.test.ts`              | `handleStressSignals`                                  | DEWS scores, threat bands, signal components                                                                                                         |
| `telegram-webhook.test.ts`            | `handleTelegramWebhook`                                | Command routing, subscription state changes, and webhook auth validation                                                                             |

### Worker Entrypoint Tests (`worker/src/__tests__/`)

| File                      | Module Under Test  | What It Covers                                                                                    |
| ------------------------- | ------------------ | ------------------------------------------------------------------------------------------------- |
| `index.fetch.test.ts`     | `worker.fetch`     | CORS preflight, method guards, edge-cache hit/miss behavior, cache-bypass paths                   |
| `index.scheduled.test.ts` | `worker.scheduled` | Cron fan-out wiring and chained dependencies (`stablecoins -> snapshot`, `dex -> DEWS/PSI`, dedicated hourly/core yield and supplemental yield slots) |

### Cron Tests (`worker/src/cron/__tests__/`)

| File                                    | Cron Under Test                    | What It Covers                                                                                                                                                  |
| --------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync-stablecoins.test.ts`              | `sync-stablecoins.ts`              | Main/fallback validation guards, extracted intake/metadata orchestration, stale detection, depeg handoff, cache-write invariants                                |
| `sync-stablecoins-stages.test.ts`       | `sync-stablecoins/stages.ts`       | Extracted pure stage helpers (structural filtering, chain normalization, staleness summary)                                                                     |
| `sync-stablecoin-charts.test.ts`        | `sync-stablecoin-charts.ts`        | Chart sync cache writes, retention, and error handling                                                                                                          |
| `detect-depegs.test.ts`                 | `detect-depegs.ts`                 | Stable prices, depeg open/close/update, direction change, NAV skip, supply threshold, DEX cross-validation, duplicate merge                                     |
| `compute-dews.test.ts`                  | `compute-dews.ts`                  | DEWS cache writes, metadata, and no-data handling                                                                                                               |
| `daily-digest.test.ts`                  | `daily-digest.ts`                  | Digest generation control flow, posting toggles, and cache persistence                                                                                          |
| `dispatch-telegram-alerts.test.ts`      | `dispatch-telegram-alerts.ts`      | Snapshot diffs, rate guards, and subscriber fan-out behavior                                                                                                    |
| `sync-dex-liquidity.test.ts`            | `dex-liquidity/orchestrator.ts`    | Catastrophic throw path, degraded status propagation, success path                                                                                              |
| `dex-liquidity-fallbacks.test.ts`       | `dex-liquidity/fetch-fallbacks.ts` | DexScreener and CoinGecko ticker fallback ingestion behavior                                                                                                    |
| `enrich-prices.test.ts`                 | `enrich-prices.ts`                 | `isReasonablePrice` for all peg types (USD, EUR, JPY, IDR, GOLD, SILVER, etc.), FX-rate-aware bounds, `hasMissingPrice` edge cases                              |
| `fetch-tbill-rate.test.ts`              | `fetch-tbill-rate.ts`              | ECB/FRED benchmark parsing, SNB proxy extraction, cache updates, and degraded fallback behavior                                                                |
| `snapshot-psi.test.ts`                  | `snapshot-psi.ts`                  | Daily PSI snapshot writes and methodology-version attribution                                                                                                   |
| `snapshot-supply.test.ts`               | `snapshot-supply.ts`               | Cache missing, stale cache (>1200s), valid insert for PSI-eligible assets, zero supply skip                                                                     |
| `snapshot-safety-grade-history.test.ts` | `snapshot-safety-grade-history.ts` | Seed rows, grade-change inserts, unchanged-grade idempotent reruns                                                                                              |
| `stability-index.test.ts`               | `stability-index.ts`               | Cron PSI recomputation and cache/history persistence behavior                                                                                                   |
| `status-self-check.test.ts`             | `status-self-check.ts`             | Probe modes, latency summaries, and hysteresis persistence                                                                                                      |
| `sync-blacklist.test.ts`                | `sync-blacklist.ts`                | Incremental multi-chain sync, enrichment, and state advancement                                                                                                 |
| `sync-bluechip.test.ts`                 | `sync-bluechip.ts`                 | Bluechip scrape normalization and cache writes                                                                                                                  |
| `sync-live-reserves.test.ts`            | `sync-live-reserves.ts`            | Adapter orchestration, circuit-open skips, warning-effect handling, last-success snapshot preservation, and source-invariant shared-result dedupe              |
| `sync-redemption-backstops.test.ts`     | `sync-redemption-backstops.ts`     | Stablecoins-cache gating, resolved vs unresolved status semantics, source-mode metadata, and current-row pruning                                                |
| `sync-usds-status.test.ts`              | `sync-usds-status.ts`              | USDS implementation/freeze-module on-chain checks                                                                                                               |
| `yield-helpers.test.ts`                 | `yield-helpers.ts`                 | `computeApyFromRate`, `computePYS`, `computeYieldStability`, `computeApyVarianceScore`, `detectWarningSignals`, `findBestLendingPool`                           |
| `sync-fx-rates.test.ts`                 | `sync-fx-rates.ts`                 | Normal path (frankfurter + secondary + metals), degraded (frankfurter 503), secondary API for CNH/RUB/UAH/ARS                                                   |
| `sync-yield-data.test.ts`               | `sync-yield-data.ts`               | Yield ranking sync, validation guards, deterministic cooldown behavior, supplemental-cache consumption, fallback behavior, and ranking parity                    |
| `dex-liquidity-pool-helpers.test.ts`    | `dex-liquidity/pool-helpers.ts`    | Symbol parsing, pool classification, quality multipliers, chain-map toggles, durability/liquidity scoring branches, protocol normalization, pair/stress helpers |
| `dex-liquidity-process-pools.test.ts`   | `dex-liquidity/process-pools.ts`   | Pool filtering, address/symbol matching, collision safety, Curve/Uni v3/Aerodrome enrichment, weighted metric accumulation                                      |
| `dex-liquidity-price-sanity.test.ts`    | `dex-liquidity/price-sanity.ts`    | DEX observation plausibility bounds and anomaly rejection                                                                                                       |
| `dex-liquidity-scoring.test.ts`         | `dex-liquidity/scoring.ts`         | Pool filtering/scaling, per-coin/global aggregate recomputation, confidence-gated depth stability, DEX price median persistence                                 |
| `confirm-pending-depegs.test.ts`        | `confirm-pending-depegs.ts`        | Pending depeg state-machine decisions, secondary confirmation paths, missing dex table handling, abort propagation                                              |
| `dex-liquidity-persistence.test.ts`     | `dex-liquidity/persistence.ts`     | Current-score upserts, coverage-confidence persistence, zero-score placeholders, global sentinel row, daily snapshot reconciliation/no-op behavior              |
| `sync-mint-burn.test.ts`                | `sync-mint-burn.ts`                | Incremental event ingestion, burn classification, degraded-mode and sync-state advancement behavior                                                             |
| `telegram-digest-appendices.test.ts`    | `telegram-digest-appendices.ts`    | Cemetery/tracked snapshot diffing, first-run seeding, and deferred appendix snapshot commits after successful Telegram digest delivery                          |
| `discovery-scan.test.ts`                | `discovery-scan.ts`                | Daily CoinGecko residual scan, candidate upserts, and dismiss-state preservation                                                                                |

## Conventions

### What to test

- **Pure `shared/lib/` + `src/lib/` functions** — formatters, supply helpers, classification maps, peg-rate derivation, and frontend derivations. These are the highest-value tests: deterministic, fast, and catch regressions in shared logic.
- **Edge cases** — `NaN`, `Infinity`, `null`, `undefined`, zero, negative values, empty inputs. The existing tests set this standard.
- **Boundary values** — tier boundaries in formatters (e.g., 999 vs 1000 for K suffix).
- **API contract tests** — when a worker handler has multiple response modes (different JSON shapes based on query params), add a contract test for each mode in `worker/src/api/__tests__/`. Use the D1 mock from `helpers/mock-d1.ts`.
- **Degraded-mode scenarios** — for cron jobs, test the normal path plus at least one failure/fallback scenario (e.g., upstream API 503, stale cache, missing data). Use `mockFetch()` to simulate API failures and `vi.useFakeTimers()` for deterministic time.

### What NOT to test (for now)

- **Broad DOM-rendered React integration tests** — jsdom is available only when a test opts in via `// @vitest-environment jsdom` (for example `src/hooks/__tests__/use-count-up.test.ts`). Most existing tests stay pure or use server rendering instead of full browser-like component integration.
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

- `npm run check:redemption-backstops` validates the redemption-backstop registry split across `shared/lib/redemption-backstop-configs/*`, catches duplicate IDs across modules, enforces allowed route-family membership per module, and keeps the headline counts in `docs/redemption-backstops.md` synced to the real registry.

### Test style

- Use `describe` per function, `it` per behavior.
- Test names describe the behavior, not the implementation: `"returns 0 for undefined input"` not `"calls sumPegBuckets with undefined"`.
- Use the `mockCoin()` helper (see `supply.test.ts`) for partial `StablecoinData` mocks — avoids `as any` casts.
- Use shared fixtures from `helpers/fixtures.ts` for DB row mocks.
- Keep tests focused: one assertion per `it` block when possible.

## Coverage

**Local full-suite threshold:** 66% lines (enforced by `vitest.config.ts` thresholds when you run full coverage locally)

Run `npm test -- --coverage` to generate a detailed report. The V8 provider generates both text output and an `lcov` report for CI integration.

### Critical Coverage Gate

CI does **not** run the full-suite `66%` coverage gate. CI runs the critical-path gate via `npm run coverage:critical`:

- Runs coverage for critical suites only (contract + invariant + targeted reliability suites for alerts/detail/dex orchestrator)
- Parses `coverage/lcov.info`
- Fails CI if any critical file falls below `CRITICAL_COVERAGE_THRESHOLD` (default: 40%, currently pinned to 40 in CI)
- Applies explicit per-file minimums for selected reliability paths (`alerts`, `auth`, `evm-rpc`, `discovery`, `health`, `stablecoin-detail`, `dex-liquidity/orchestrator`, plus the other file-specific overrides in `scripts/check-critical-coverage.mjs`)
- For touched critical files, enforces a no-regression ratchet using `.ci/critical-coverage-baseline.json`
- The local merge gate now passes its changed-file set into `coverage:critical`, so touched critical-file regressions fail locally too

Gate script: `scripts/check-critical-coverage.mjs`

Useful env controls:

- `CRITICAL_COVERAGE_THRESHOLD`
- `CRITICAL_COVERAGE_COMPARE_REF`
- `CRITICAL_COVERAGE_CHANGED_FILES`
- `CRITICAL_COVERAGE_RATCHET_TOLERANCE`
- `CRITICAL_COVERAGE_RATCHET_ALL`
- `CRITICAL_COVERAGE_BASELINE_FILE`
- Per-file overrides such as `CRITICAL_COVERAGE_THRESHOLD_ALERTS`, `CRITICAL_COVERAGE_THRESHOLD_AUTH`, `CRITICAL_COVERAGE_THRESHOLD_EVM_RPC`, `CRITICAL_COVERAGE_THRESHOLD_DISCOVERY`, and `CRITICAL_COVERAGE_THRESHOLD_HEALTH`

Current critical file set:

- `src/lib/api.ts`
- `worker/src/lib/api-utils.ts`
- `worker/src/lib/auth.ts`
- `worker/src/lib/evm-rpc.ts`
- `worker/src/lib/stablecoins-cache.ts`
- `worker/src/lib/safety-scores.ts`
- `worker/src/handlers/scheduled.ts`
- `worker/src/cron/sync-stablecoins.ts`
- `worker/src/cron/daily-digest.ts`
- `worker/src/cron/sync-yield-data.ts`
- `worker/src/api/discovery.ts`
- `worker/src/api/health.ts`
- `worker/src/api/peg-summary.ts`
- `worker/src/api/report-cards.ts`
- `worker/src/api/dex-liquidity.ts`
- `worker/src/api/stress-signals.ts`
- `worker/src/api/mint-burn-flows.ts`
- `worker/src/api/status.ts`
- `worker/src/lib/alerts.ts` _(explicit threshold: 80% lines)_
- `worker/src/lib/auth.ts` _(explicit threshold: 70% lines)_
- `worker/src/lib/evm-rpc.ts` _(explicit threshold: 70% lines)_
- `worker/src/lib/stablecoins-cache.ts` _(explicit threshold: 50% lines)_
- `worker/src/lib/safety-scores.ts` _(explicit threshold: 40% lines)_
- `worker/src/handlers/scheduled.ts` _(explicit threshold: 40% lines)_
- `worker/src/cron/daily-digest.ts` _(explicit threshold: 40% lines)_
- `worker/src/api/discovery.ts` _(explicit threshold: 70% lines)_
- `worker/src/api/health.ts` _(explicit threshold: 60% lines)_
- `worker/src/api/status.ts` _(explicit threshold: 40% lines)_
- `worker/src/api/stablecoin-detail.ts` _(explicit threshold: 30% lines)_
- `worker/src/cron/dex-liquidity/orchestrator.ts` _(explicit threshold: 55% lines — above the global CI threshold, overridden per-file)_

### Critical Test Suites

- `npm run test:critical-contracts` covers the explicitly enumerated critical handler suites (`peg-summary`, `report-cards`, `stability-index`, `dex-liquidity`, `stress-signals`, `mint-burn-flows`) plus shared strict-path registry tests and router mapping tests.
- `npm run test:invariants` covers numerical/schema invariants and cache-write validation guards in critical cron paths.
- `npm run test:merge-gate` runs a delta-aware local gate for merged worktree changes. It skips cleanly when no deploy surfaces changed, runs the shared validate core for deploy-impacting diffs, adds `build` + `seo:check` for Pages-impacting changes, and adds worker typecheck for worker-impacting changes. Useful controls: `npm run test:merge-gate -- --staged`, `MERGE_GATE_BASE_REF=<ref>`, and `MERGE_GATE_DRY_RUN=1`.
- `npm run test:smoke-api` performs HTTP-level smoke checks for `/api/health` plus every strict contract path derived from `shared/lib/api-endpoints.ts` (currently including `stablecoins`, `peg-summary`, `report-cards`, `stability-index`, `dex-liquidity`, `redemption-backstops`, `stress-signals`, and `mint-burn-flows`) with shape/range assertions, sequential endpoint execution, and bounded retries for transient failures.
- `npm run test:smoke-ops` performs private post-deploy checks against the operator surfaces through Cloudflare Access. In service-token mode, Access consumes `CF-Access-Client-Id` / `CF-Access-Client-Secret`, injects `Cf-Access-Jwt-Assertion`, and the worker verifies that JWT before serving `ops-api` routes. The smoke test accepts either a Cloudflare Access redirect or a successful token-backed HTML response for `ops.pharos.watch/admin/`, then validates `ops-api.pharos.watch/api/status`, `ops-api.pharos.watch/api/status-history`, and the safe dry-run `audit-depeg-history` path.
- `npm run test:smoke-ui` performs a fast browser smoke check in either local or live mode. Local mode keeps the full tracked mobile overflow route sweep against the built artifact, while live mode keeps the homepage/GA checks and a single mobile canary route against the real host. Both modes fail on homepage outage/empty states (`Failed to load data` or `Failed to load this dataset`, `stablecoins:404`, `Data not yet available` or `Waiting for first sync`, `Connection issue` or `Unable to reach the Pharos data API right now.`, `No stablecoin data available`).

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

**API contract test:** Create in `worker/src/api/__tests__/`. Import the handler and use `mockD1()` from `helpers/mock-d1.ts`. Use shared fixtures from `helpers/fixtures.ts` for row data. Validate response shape against Zod schemas from `shared/types/index.ts`.

**Cron test:** Create in `worker/src/cron/__tests__/`. Mock external dependencies with `vi.mock()` and HTTP calls with `mockFetch()`. Test both normal path and at least one degraded-mode scenario.

Example API contract test:

```ts
import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeBlacklistRow } from "./helpers/fixtures";
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
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import { mockFetch } from "../../api/__tests__/helpers/mock-fetch";

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

**Custom rules** — React Compiler rules are downgraded to warnings since they flag valid patterns that work correctly at runtime:

| Rule                                      | Level | Reason                                                                                       |
| ----------------------------------------- | ----- | -------------------------------------------------------------------------------------------- |
| `react-hooks/preserve-manual-memoization` | warn  | Compiler can't optimize `useMemo([data])` when body accesses `data.current.*` sub-properties |
| `react-hooks/set-state-in-effect`         | warn  | Standard pattern for reading localStorage/sessionStorage on mount                            |
| `react-hooks/purity`                      | warn  | `Date.now()` in render is intentional for timestamp-based UIs                                |
| `react-hooks/incompatible-library`        | warn  | TanStack Virtual `useVirtualizer()` — known library limitation                               |

**Ignored paths:** `.next/`, `out/`, `build/`, `coverage/`, `.codex-autorunner/`, `worker/.wrangler/`, `.worktrees/`, and `worktrees/` (auto-generated build artifacts plus worktree directories). The conditional worktree behavior described earlier applies to Vitest coverage globs, not ESLint.

### Zod Runtime Validation

Schema validation in hooks is done via `useApiQuery(..., { schema })`. Current schema-validated response paths include:

- `StablecoinListResponseSchema`
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

On validation failure, hooks log warnings and return data in degraded mode rather than hard-crashing the UI.

When adding a new API endpoint:

1. Define the response schema in `shared/types/index.ts` if the response has nested arrays or objects accessed via `.find()` / `.map()`
2. Pass the schema to `useApiQuery` via `{ schema: MyResponseSchema }`
3. Add a contract test in `worker/src/api/__tests__/` if the endpoint has multiple response modes

**Narrow-type gotcha:** If your response type uses string unions or branded types (e.g. `ReportCardGrade`, `DimensionKey`), prefer the shared hand-written interfaces and keep any unavoidable schema wiring/casts localized in the consolidated hook module (`src/hooks/api-hooks.ts`).

**Worker CI note:** `shared/types/index.ts` imports `zod`, and the worker type-checks shared modules via the `@shared/*` path alias in the `validate` job (`cd worker && npx tsc --noEmit`) before any deploy step runs. Root deps are installed first (`npm ci`) through the npm workspace so shared imports resolve from root `node_modules/`. If you add new npm packages imported at the top level of shared files, they do not need duplication in `worker/package.json` unless the worker uses a worker-local runtime/deploy path that genuinely requires it.
