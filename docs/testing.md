# Testing & Linting

## Overview

The project uses **Vitest** for unit tests and **ESLint** (via `eslint-config-next`) for linting. The shared validation suite runs in CI on pull requests to `main`, while push/manual production deploys reuse the same validate workflow with deploy-surface-aware conditionals.

## Commands

```bash
npm test              # Run all tests once (CI mode)
npm run test:watch    # Watch mode — re-runs on file changes
npm run lint          # ESLint across frontend + worker code
npm run typecheck     # Type-check frontend, shared, Pages Functions, and root scripts
npm run typecheck:worker-scripts # Type-check worker-bound operational scripts
npm run audit:deps    # Fails on high-severity npm advisories
npm run seo:check     # Static SEO audit against built `out/` HTML
npm run check:worker-boundary # Enforce the shared boundary in both directions (no worker -> `src` imports, no `src`/`shared`/`scripts`/`functions` -> `worker/src` imports; pure cross-runtime metadata belongs in `shared/`)
npm run check:shared-cycles # Fail on circular dependencies inside `shared/`, `worker/src`, and `src`
npm run check:unused-code # Detect unreferenced internal runtime modules and unused named exports across `src/`, `shared/`, `worker/src/`, and `functions/`
npm run check:hotspot-ratchet # Fail when enrolled hotspots regress or generated hotspot candidates lack explicit enrollment/waivers
npm run check:cron-sync # Verify `shared/lib/cron-jobs.ts`, `shared/lib/scheduled-runner-registry.ts`, and `worker/wrangler.toml` stay aligned
npm run check:cron-connections # Enforce the documented per-trigger outbound connection budget across cron slots
npm run check:doc-counts # Verify tracked/shadow/adapter/bluechip/live-enabled counts in docs match code
npm run check:verified-doc-links # Verify all markdown links in verified docs resolve
npm run check:doc-source-paths # Verify backtick source-path references in README.md and docs/** resolve to files/directories
npm run check:doc-sync # Verify exact methodology versions, thresholds, weights, and enforced limits stay aligned with code and canonical version labels
npm run check:env-contract # Verify documented env bindings match the worker Env interface
npm run check:duplicate-exports # Detect duplicate export declarations within individual files
npm run check:sql-safety # Static analysis of D1 SQL patterns for safety issues
npm run check:stablecoin-data # Validate stablecoin JSON data files against schema
npm run check:redemption-backstops # Validate redemption backstop configs for completeness
npm run check:migrations # Replay worker D1 migrations against a throwaway SQLite DB
npm run audit:pricing-providers # Verify pricing provider configs are consistent
npm run coverage:critical:update-baseline # Update the critical-coverage baseline snapshot
npm run lint -- --fix # Auto-fix fixable warnings (stale directives, etc.)
npm test -- --coverage # Run tests with V8 coverage report
npm run test:critical-contracts # Critical endpoint contract suite
npm run test:invariants # Critical numerical/schema invariant suite
npm run coverage:critical # Critical-suite coverage run + critical-path line-coverage gate
npm run test:merge-gate # Delta-aware local gate before pushing merged worktree changes
npm run test:smoke-api -- --base-url https://api.pharos.watch # HTTP smoke checks for critical API endpoints (set SMOKE_API_KEY when protected routes are enforced)
npm run test:smoke-ops # Private ops-host and ops-api smoke checks through Cloudflare Access
npm run test:smoke-transport # HTTP->HTTPS edge redirect smoke for api.pharos.watch and site-api.pharos.watch
npm run test:smoke-ui -- --url https://pharos.watch --mode live # Browser-level UI smoke check; local mode runs the full overflow sweep, live mode runs a narrower canary smoke
```

When `SMOKE_UI_EXPECT_GA_ID` is set, `npm run test:smoke-ui` also verifies that the homepage artifact includes the expected GA script tag and `gtag('config', ...)` initialization before it runs the browser checks. The config init may live in the root static RSC payload (`/index.txt`) on newer Next.js static exports rather than directly in `index.html`.

## CI Pipeline

Defined across `.github/workflows/validate-ci.yml`, `.github/workflows/pull-request-checks.yml`, `.github/workflows/deploy-cloudflare.yml`, `.github/workflows/pages-prepare.yml`, `.github/workflows/pages-publish.yml`, `.github/workflows/pages-release.yml`, `.github/workflows/rebuild-pages.yml`, `.github/workflows/codeql.yml`, `.github/workflows/dependency-audit.yml`, and `.github/workflows/secret-scan.yml`.

For deployment/worktree operating procedure (including the local merge gate before every push), see [Deployment Process](./deployment-process.md).

1. `Pull Request Checks`
   - runs the shared `validate` gate on `pull_request` to `main`
   - classifies the PR diff with `scripts/classify-deploy-changes.mjs`, then passes `pages_changed` and `worker_changed` into the reusable workflow
   - still runs the shared non-deploy guardrails and tests on every PR, while Pages build/SEO and worker typecheck follow the same deploy-surface flags used by the push deploy workflow
   - runs a pinned gitleaks commit-range scan for pull-request secret detection
   - uses the PR base SHA for the critical-coverage ratchet diff
2. `validate` (runs before any deployment):
   - runs the shared validate pre-build command set from `scripts/lib/validate-contract.mjs`: dependency/pricing audits, lint/typecheck, import boundaries, cycles, migrations, cron checks, docs checks, env checks, duplicate/export/registry guards, unused-code/hotspot/sql/stablecoin-data checks
   - `npm run build` + `npm run seo:check` when `pages_changed=true`
   - `npm test`
   - `npm run coverage:critical`
   - `cd worker && npx tsc --noEmit` when `worker_changed=true`
   - `cd worker && npx tsc --noEmit -p tsconfig.scripts.json` when `worker_changed=true`
3. `detect-changes` (push/manual deploy workflow; same classifier also runs in pull-request checks):
   - Diffs `github.event.before...github.sha` on `push`
   - Emits `deploy_required`, `worker_changed`, and `pages_changed`
   - Marks worker/API deploy work as required when the diff touches worker/shared runtime, package/deploy infra, `.github/actions/`, `scripts/lib/`, shared guardrail scripts, worker operational scripts, or worker-specific checks/smokes
   - Marks Pages deploy work as required when the diff touches Pages runtime paths, package/deploy infra, `.github/actions/`, `scripts/lib/`, shared guardrail scripts, Pages workflow files, or selected build/static-export scripts
   - Skips the heavy deploy workflow entirely when neither Pages nor worker deploy surfaces changed
   - Forces the full path on `workflow_dispatch`
4. `upload-worker-version` (needs `validate` and `detect-changes`):
   - Capture the currently live production Worker version ID with `wrangler deployments status --json`
   - Apply D1 migrations with the local worker-pinned Wrangler CLI
   - Upload a candidate Worker version with `wrangler versions upload`
   - Run `npm run test:smoke-api` against that preview URL inside the same job before the candidate is considered promotable
   - Pass `SMOKE_API_KEY` from GitHub repository secrets so protected public routes can be rehearsed before promotion
   - Skipped on Pages-only or non-deploy `push` events
5. `deploy-worker` (needs `upload-worker-version` when worker/API work is required):
   - Promote the already-smoked candidate version with `wrangler versions deploy <version-id>@100`
   - Sync routes/domains/cron triggers with `wrangler triggers deploy`
   - Skipped on Pages-only or non-deploy `push` events
6. `smoke-api` (needs `deploy-worker` when worker/API work is required):
   - `npm ci`
   - Run `npm run test:smoke-api`
   - Uses `SMOKE_API_BASE` from `vars.SMOKE_API_BASE_URL` (preferred) or `vars.API_BASE_URL`
   - Passes `SMOKE_API_KEY` from GitHub repository secrets
   - Acts as the post-promotion production canary after traffic is shifted
   - Runs strict API checks sequentially with bounded transient retry behavior (`SMOKE_API_RETRY_COUNT` default `1`, `SMOKE_API_TIMEOUT_MS` default `12000`)
   - Skipped on Pages-only or docs-only `push` events alongside `deploy-worker`
7. `rollback-worker`:
   - Runs only when `deploy-worker` succeeded but the post-promotion `smoke-api` failed
   - Uses the previously captured production version ID and `wrangler rollback --yes` to restore the last live Worker version automatically
   - Leaves the workflow failed so the production incident is still visible in CI
8. `pages-prepare`:
   - reusable workflow in `.github/workflows/pages-prepare.yml`
   - runs only when `pages_changed=true`
   - waits for preview-smoked `upload-worker-version` only when worker/API work was also required for that push
   - executes `build-pages -> smoke-ui`
   - on combined worker + Pages deploys, uses the uploaded Worker's preview URL for digest sync and for the local `/_site-data/*` smoke lane so the static export is rehearsed against the exact candidate API while worker promotion continues in parallel
   - `build-pages` fetches `/api/digest-archive` once from the selected API environment into `data/digests.json`, forwarding `DIGEST_API_KEY` from GitHub repository secrets and `NEXT_PUBLIC_GA_ID` from GitHub repo vars into `npm run build`, then runs `npm run seo:check`, and uploads `out/`
   - `smoke-ui` serves that exact artifact locally, proxies direct `/api/*` calls to the selected public API base, proxies `/_site-data/*` to the selected `site-api` base, injects `SITE_API_SHARED_SECRET` for the site-data proxy hop, and runs `npm run test:smoke-ui -- --url http://127.0.0.1:4173 --mode local`
   - when `SMOKE_UI_EXPECT_GA_ID` is configured, that smoke step also verifies the built homepage artifact still contains the expected GA snippet
9. `pages-publish`:
   - reusable workflow in `.github/workflows/pages-publish.yml`
   - runs only when `pages_changed=true`
   - waits for `pages-prepare`
   - also waits for post-promotion `smoke-api` only when worker/API work was required for that push
   - executes `deploy-pages -> smoke-ui-live`
   - `deploy-pages` still publishes the verified artifact with the Wrangler retry loop
   - `smoke-ui-live` then verifies the real public host with `npm run test:smoke-ui -- --url https://pharos.watch --mode live`
10. `smoke-ui-live` (worker-only push path):
   - Runs only when `worker_changed=true` and `pages_changed=false`
   - Runs `npm run test:smoke-ui -- --url https://pharos.watch --mode live`
   - when `SMOKE_UI_EXPECT_GA_ID` is configured, also verifies the live homepage artifact still contains the expected GA snippet
   - Verifies that the unchanged live Pages frontend still works against the newly deployed worker/API without repeating the full local overflow sweep
11. `smoke-ops`:

- Run `npm run test:smoke-ops`
- Uses `SMOKE_OPS_UI_URL` / `SMOKE_OPS_API_BASE` (defaults: `https://ops.pharos.watch/admin/`, `https://ops-api.pharos.watch`)
- Requires repository secrets `OPS_SMOKE_CF_ACCESS_CLIENT_ID` and `OPS_SMOKE_CF_ACCESS_CLIENT_SECRET`
- Runs after `pages-publish` on Pages-including deploys, or after `smoke-api` + `smoke-ui-live` on worker-only deploys
- Verifies the ops UI host is Access-gated (or service-token-accessible, if configured) plus `status`, `status-history`, and a safe dry-run admin path on the operator API host

12. `smoke-transport`:

- Run `npm run test:smoke-transport`
- Verifies `http://api.pharos.watch/...` and `http://site-api.pharos.watch/...` return `308` before application auth or worker logic responds
- Runs after the same production-changing gate as `smoke-ops`
- Fails the workflow on redirect regressions once the zone-level redirect rule is in place

13. `Rebuild Pages`:

- defined in `.github/workflows/rebuild-pages.yml`
- runs on the daily schedule and on manual dispatch
- skips `validate`, `deploy-worker`, and `smoke-api`
- runs the shared `pages-release` wrapper workflow and then `smoke-ops` plus `smoke-transport`

14. `CodeQL`:

- defined in `.github/workflows/codeql.yml`
- runs on pushes to `main`, pull requests to `main`, and a weekly Monday schedule
- analyzes the JavaScript/TypeScript codebase separately from the deploy pipeline

15. `Dependency Audit`:

- defined in `.github/workflows/dependency-audit.yml`
- runs on a weekly Monday schedule and on manual dispatch
- installs from the root lockfile and runs `npm audit --audit-level=high`
- complements the blocking production-only `npm run audit:deps` gate by covering devDependencies too
- owner: the maintainer driving the next production deploy or dependency update
- response expectation:
  - blocking `npm run audit:deps` failures are stop-ship until fixed, pinned away, or explicitly risk-accepted
  - scheduled dependency-audit findings must get a tracked triage note or remediation issue the same business day
  - do not leave a new high/critical finding unowned between audit detection and the next production deploy

16. `Secret Scan`:

- defined in `.github/workflows/secret-scan.yml`
- runs on a weekly Monday schedule and on manual dispatch
- checks out full git history and runs pinned `gitleaks` `8.30.0`
- uses the root `.gitleaksignore` to suppress reviewed historical false positives by exact fingerprint
- scans commit history for accidentally committed secrets and fails on any non-allowlisted finding

This arrangement keeps pull-request validation full-strength, makes deploy-path validation conditional on the surfaces that actually changed, skips the production workflow entirely for non-deploy pushes, proves the static export build and SEO gate before merge and on Pages-impacting deploys, fetches digest data once inside the Pages build job so the build itself is network-independent with respect to digest data, forwards the configured GA measurement ID into CI builds so the static artifact matches production analytics posture, smokes the exact candidate Worker version on its preview URL before production traffic is shifted, overlaps the Pages build + local smoke path with worker promotion and production API smoke when both surfaces changed, keeps the broad overflow sweep on the local artifact smoke before Pages production deploy, verifies the real `pharos.watch` host after each Pages publish with a narrower live canary smoke, keeps the scheduled digest rebuild off the worker deploy path, still runs the post-deploy ops-surface plus transport smoke after each production-changing workflow, and adds separate weekly/manual lanes for dependency auditing and history-aware secret scanning.

Current GitHub repository secrets required by the deploy path:

- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for Worker/Pages deploy and rollback helpers
- `SMOKE_API_KEY` for preview and production `smoke-api`
- `DIGEST_API_KEY` for Pages digest sync against protected public API routes
- `SITE_API_SHARED_SECRET` for local artifact smoke through `/_site-data/*`
- `OPS_SMOKE_CF_ACCESS_CLIENT_ID` and `OPS_SMOKE_CF_ACCESS_CLIENT_SECRET` for `smoke-ops`

Current GitHub repository variables used by the deploy path:

- `API_BASE_URL` (required)
- `SMOKE_API_BASE_URL`, `SMOKE_OPS_UI_URL`, `SMOKE_OPS_API_BASE`, and `NEXT_PUBLIC_GA_ID` (optional)

Cloudflare Access ownership split:

- Pages -> `ops-api` service token lives in the Cloudflare Pages project secrets, not in GitHub
- CI `smoke-ops` credentials live in the GitHub repository secrets listed above
- operator session duration is owned by the Cloudflare Zero Trust Access policy for `ops.pharos.watch`, not by repo code or CI

Rotation note for `smoke-ops` secrets:

1. Create a replacement Access service token for `https://ops-api.pharos.watch/*`.
2. Update both GitHub secrets together.
3. Run the production deploy workflow or `Rebuild Pages` via `workflow_dispatch` so `smoke-ops` verifies the new pair.
4. Revoke the old token only after the workflow passes.

Rollback:

1. Restore the previous GitHub secret pair.
2. Re-run the workflow manually.
3. Leave the replacement token active until verification succeeds.

The workflows pin `actions/checkout@v6`, `actions/setup-node@v6`, and `actions/cache@v4` by commit SHA and run project tooling on Node 25 (`node-version: 25`). The validate and Pages-build lanes restore caches for `.next/cache`, `.cache/eslint`, and `*.tsbuildinfo` outputs to avoid rebuilding or relinting unchanged work from scratch on every run. Worker deploys intentionally avoid `cloudflare/wrangler-action`; the repo now uses a root npm workspace, so CI installs the shared toolchain from the root lockfile and invokes Wrangler with `npx --no-install`. `npm run audit:deps` also runs in the validate job so high-severity production advisories fail the push/manual deploy pipeline before deploy, and the scheduled dependency-audit workflow covers devDependencies separately. The production-changing workflows also share a `concurrency` group (`production-deploy-${{ github.ref }}`): push/manual deploys cancel superseded in-flight runs, while the scheduled/manual Pages rebuild queues behind an active production deploy instead of interrupting it.

`npm run check:migrations` replays every file in `worker/migrations/` against a throwaway SQLite database before deploy. It uses Node's built-in `node:sqlite` module on Node 25 and falls back to the `sqlite3` CLI when needed, which catches schema typos in unapplied D1 migrations before `deploy-worker` touches production. Historical duplicate migration prefixes are tracked explicitly in `worker/migrations/MANIFEST.md`; the checker fails only on new undeclared duplicates and keeps the current allowlist visible in review. The same check now also enforces the rollout-safety contract for new migrations starting at `0071`: every new migration must declare `-- rollout-safety: backward-compatible`, and obvious table/column drop or rename patterns are rejected because the standard deploy path applies D1 migrations before the new worker is live.

`npm run test:merge-gate` now mirrors the deploy-path validate contract locally. If the changed-file set is not deploy-impacting, it prints the diff and exits successfully. For deploy-impacting diffs, it always runs `audit:deps`, `audit:pricing-providers`, lint, the root source `typecheck`, worker-boundary, shared-cycle detection, migrations, cron schedule/connection checks, `check:doc-counts`, `check:verified-doc-links`, `check:doc-source-paths`, `check:doc-sync`, `check:env-contract`, duplicate-export and redemption-backstop guards, unused-code, hotspot-ratchet, SQL-safety, `check:stablecoin-data`, the full test suite, and critical coverage. The cycle step now blocks on cycles in `shared/`, `worker/src`, and `src`. It adds `npm run build` + `npm run seo:check` when Pages-impacting files changed, and adds both `cd worker && npx tsc --noEmit` and `cd worker && npx tsc --noEmit -p tsconfig.scripts.json` when worker-impacting files changed. It still skips deploy-time smoke suites.

`npm run check:unused-code` now scans all runtime code under `src/`, `shared/`, `worker/src/`, and `functions/`, with explicit module/export allowlists for intentional exceptions. `npm run check:hotspot-ratchet` now guards the maintained shell/facade files in `scripts/lib/hotspot-ratchet-baseline.json`, including `worker/src/cron/compute-dews.ts`, and also generates current repo-wide hotspot candidates from the top file-line, max-function-line, and branch-count outliers. Every generated candidate must either be enrolled in the baseline or explicitly waived in `scripts/lib/hotspot-ratchet-waivers.json`, so newly emerged hotspots cannot drift past the guardrail unseen. The ratchet still fails fast on stale target paths and unexpected baseline entries, and it now also fails on stale waiver entries. Each baseline entry declares a `disposition`, `targetBudget`, and implementation note so the ratchet doubles as a decomposition backlog rather than a blind ceiling list. Refresh the baseline only after an intentional refactor with `npm run check:hotspot-ratchet:update-baseline`, and update the matching waiver/backlog metadata at the same time.

`npm run check:cron-sync` is part of the shared CI validate gate. Run it locally whenever you change `worker/wrangler.toml` cron expressions, `shared/lib/cron-jobs.ts`, or the scheduled-runner registry so you catch schedule/dispatch drift before pushing.

`npm run seo:check` is the static-export SEO gate. It inspects the built `out/` HTML for missing title/description/canonical/OpenGraph/Twitter tags, duplicate or missing `h1`s on indexable pages, CSR bailout markers, sitemap omissions, orphan pages, and indexable routes that are more than three clicks away from `/`.

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
      ".next/**",
      "out/**",
      "coverage/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: [/* mirrors test.exclude */],
      thresholds: { lines: 66 }, // Local full-suite coverage reference; CI enforces the critical coverage gate separately
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

The config also includes a `wasmStubPlugin()` Vite plugin that stubs `.wasm` imports for Node compatibility and resolve aliases for `satori/standalone`, `satori/yoga.wasm`, `@cf-wasm/resvg/workerd`, and `@resvg/resvg-wasm`. On Node 25+, Vitest test workers run with `--no-experimental-webstorage` so jsdom remains the source of `localStorage` / `sessionStorage` in DOM tests instead of Node's experimental Web Storage globals.

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

### Reserve HTML Fixtures (`worker/src/cron/reserve-adapters/__tests__/fixtures/*.html`)

Five issuer dashboards feed HTML-parsing adapters (Circle transparency, FDUSD, Mento reserve, Reserve (RE) metrics, SG Forge). Their HTML layout drifts over time, so the fixtures need periodic refreshes to keep tests anchored to today's markup rather than a snapshot from months ago.

Run:

```bash
npm run refresh:html-fixtures
```

The script fetches each source live, prepends a `<!-- captured-at: ISO -->` provenance header, and writes the file back under `worker/src/cron/reserve-adapters/__tests__/fixtures/`. Sources that respond with <200 bytes or an HTTP error are left untouched and a warning is printed; the script exits non-zero only when zero fixtures refreshed. Run locally before updating adapter parsers — do not run in CI.

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

## Test Inventory

The source of truth for the current test inventory is the filesystem, not this document. Use these commands when you need the live set:

```bash
rg --files src shared worker/src functions scripts | rg '(^|/)__tests__/|\.(test|spec)\.' | sort
npm run test:critical-contracts
npm run test:invariants
npm run coverage:critical
```

Keep this section focused on how the suite is organized and which surfaces are gate-critical. Do not add a full per-file table; stale path tables were a recurring documentation drift source.

| Area | Location | Purpose |
| --- | --- | --- |
| Frontend library and page tests | `src/**/__tests__/`, colocated `*.test.ts(x)` files | Pure derivations, route view models, hooks, UI state, and page contracts |
| Shared runtime tests | `shared/lib/__tests__/` | Runtime-neutral scoring, classification, chain, dependency, reserve, and formatting contracts |
| Worker API tests | `worker/src/api/__tests__/` | Handler contracts, response shapes, auth/method behavior, and admin backfill surfaces |
| Worker library tests | `worker/src/lib/__tests__/` | Auth, cache, rate limit, pricing, status, mint/burn, reserves, report cards, and helper modules |
| Cron tests | `worker/src/cron/**/__tests__/` and colocated cron `*.test.ts` files | Scheduled ingestion, scoring, persistence, degradation, and adapter behavior |
| Script tests | `scripts/__tests__/` | CI guardrail and operational-script behavior |

Critical gate coverage is intentionally smaller than the full suite:

- `npm run test:critical-contracts` covers strict endpoint registry, router mapping, cache passthrough, and high-impact API handlers.
- `npm run test:invariants` covers numerical/schema invariants and critical cron-cache validation.
- `npm run coverage:critical` runs the critical suite with line-coverage ratchets for files listed in `scripts/lib/critical-coverage.mjs`.

When adding tests, prefer colocating them near the module under test unless an existing `__tests__/` directory is already the local pattern. If the new test protects a production gate, add it to the relevant npm script rather than only documenting it here.

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
- `worker/src/lib/__tests__/redemption-backstops-store.test.ts` now covers completed-run snapshot manifests for `redemption_backstop_runs`, including generation-filtered reads and current/history rows written with `snapshot_run_id`.

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
- Per-file overrides: `CRITICAL_COVERAGE_THRESHOLD_ALERTS`, `CRITICAL_COVERAGE_THRESHOLD_AUTH`, `CRITICAL_COVERAGE_THRESHOLD_EVM_RPC`, `CRITICAL_COVERAGE_THRESHOLD_STABLECOINS_CACHE`, `CRITICAL_COVERAGE_THRESHOLD_SAFETY_SCORES`, `CRITICAL_COVERAGE_THRESHOLD_SCHEDULED`, `CRITICAL_COVERAGE_THRESHOLD_DAILY_DIGEST`, `CRITICAL_COVERAGE_THRESHOLD_STABLECOIN_DETAIL`, `CRITICAL_COVERAGE_THRESHOLD_DISCOVERY`, `CRITICAL_COVERAGE_THRESHOLD_HEALTH`, `CRITICAL_COVERAGE_THRESHOLD_STATUS`, `CRITICAL_COVERAGE_THRESHOLD_DEX_ORCHESTRATOR`

Current critical file set (`CRITICAL_FILES` in `scripts/lib/critical-coverage.mjs`):

- `src/lib/api.ts`
- `worker/src/lib/api-cache-read.ts`
- `worker/src/lib/api-freshness.ts`
- `worker/src/lib/api-history.ts`
- `worker/src/lib/api-pagination.ts`
- `worker/src/lib/api-params.ts`
- `worker/src/lib/api-response.ts`
- `worker/src/lib/alerts.ts`
- `worker/src/lib/auth.ts`
- `worker/src/lib/evm-rpc.ts`
- `worker/src/lib/stablecoins-cache.ts`
- `worker/src/lib/safety-scores.ts`
- `worker/src/handlers/scheduled.ts`
- `worker/src/api/health.ts`
- `worker/src/cron/sync-stablecoins.ts`
- `worker/src/cron/daily-digest.ts`
- `worker/src/cron/sync-yield-data.ts`
- `worker/src/api/discovery.ts`
- `worker/src/api/peg-summary.ts`
- `worker/src/api/report-cards.ts`
- `worker/src/api/dex-liquidity.ts`
- `worker/src/api/stress-signals.ts`
- `worker/src/api/mint-burn-flows.ts`
- `worker/src/api/status.ts`
- `worker/src/api/stablecoin-detail.ts`
- `worker/src/cron/dex-liquidity/orchestrator.ts`

Selected files have explicit threshold overrides in `scripts/check-critical-coverage.mjs`; keep that map as the source of truth instead of duplicating override values in prose.

### Critical Test Suites

- `npm run test:critical-contracts` covers the explicitly enumerated critical handler suites (`peg-summary`, `report-cards`, `stability-index`, `dex-liquidity`, `stress-signals`, `mint-burn-flows`) plus shared strict-path registry tests and router mapping tests.
- `npm run test:invariants` covers numerical/schema invariants and cache-write validation guards in critical cron paths.
- `npm run test:merge-gate` runs a delta-aware local gate for merged worktree changes. It skips cleanly when no deploy surfaces changed, runs the shared validate core for deploy-impacting diffs, adds `build` + `seo:check` for Pages-impacting changes, and adds Worker runtime plus Worker operational-script typechecks for worker-impacting changes. Useful controls: `npm run test:merge-gate -- --staged`, `MERGE_GATE_BASE_REF=<ref>`, and `MERGE_GATE_DRY_RUN=1`.
- `npm run test:smoke-api` performs HTTP-level smoke checks for `/api/health` plus every strict contract path derived from `shared/lib/api-endpoints/` (currently including `stablecoins`, `peg-summary`, `report-cards`, `stability-index`, `dex-liquidity`, `redemption-backstops`, `stress-signals`, and `mint-burn-flows`) with shape/range assertions, sequential endpoint execution, and bounded retries for transient failures.
- `npm run test:smoke-ops` performs private post-deploy checks against the operator surfaces through Cloudflare Access. For direct `ops-api.pharos.watch` requests, service-token mode sends `CF-Access-Client-Id` / `CF-Access-Client-Secret` and the worker verifies the injected Access JWT there. For the same-origin Pages proxy path, the script first attempts to bootstrap an Access session on `ops.pharos.watch`; when a `CF_Authorization` cookie is returned, it reuses that cookie in a best-effort smoke of `https://ops.pharos.watch/api/admin/status`. The proxy assertion retries up to two transient `502`/`504` gateway responses to absorb post-deploy warmup on the operator status path, but all other non-auth failures still fail immediately. If the UI host exposes only the interactive Access redirect, if the service-token UI flow renders the shell without yielding a browser session cookie, or if the proxied request remains `401 Unauthorized` after that cookie replay, the script keeps the shell/direct-API assertions and skips the same-origin proxy assertion.
- `npm run test:smoke-transport` performs manual-redirect `HEAD` checks against `http://api.pharos.watch/...` and `http://site-api.pharos.watch/...`, requiring `308` plus an exact `Location` match that preserves host, path, and query while upgrading only to `https`.
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

Schema validation in hooks is done via `useApiQuery(..., { schema })` / `useApiQueryWithMeta(..., { schema })`. Current schema-validated response paths include:

- `StablecoinListResponseSchema`
- `SupplyHistoryResponseSchema`
- `StablecoinDetailHistoryResponseSchema`
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

Use `rg "schema:" src/hooks src/lib` for the live callsite set before adding or auditing endpoint validation.

When a schema is provided, frontend API helpers now validate in `strict` mode by default and throw on schema mismatch. Use `contractMode: "warn"` only for explicitly degraded surfaces where returning raw data is acceptable.

When adding a new API endpoint:

1. Define the response schema in `shared/types/index.ts` if the response has nested arrays or objects accessed via `.find()` / `.map()`
2. Pass the schema to `useApiQuery` via `{ schema: MyResponseSchema }`
3. Add a contract test in `worker/src/api/__tests__/` if the endpoint has multiple response modes

**Narrow-type gotcha:** If your response type uses string unions or branded types (e.g. `ReportCardGrade`, `DimensionKey`), prefer the shared hand-written interfaces and keep any unavoidable schema wiring/casts localized in the consolidated hook module (`src/hooks/api-hooks.ts`).

**Worker CI note:** `shared/types/index.ts` imports `zod`, and the worker type-checks shared modules via the `@shared/*` path alias in the `validate` job (`cd worker && npx tsc --noEmit`) before any deploy step runs. Root deps are installed first (`npm ci`) through the npm workspace so shared imports resolve from root `node_modules/`. If you add new npm packages imported at the top level of shared files, they do not need duplication in `worker/package.json` unless the worker uses a worker-local runtime/deploy path that genuinely requires it.
