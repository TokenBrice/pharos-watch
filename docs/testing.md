# Testing & Linting

## Overview

The project uses **Vitest** for unit tests and **ESLint** (via `eslint-config-next`) for linting. The shared validation suite runs in CI on pull requests to `main`, while push/manual production deploys reuse the same validate workflow with deploy-surface-aware conditionals.

## Commands

```bash
npm test              # Run all tests once (CI mode)
npm run test:profile -- --output /tmp/pharos-vitest-profile.json # Run Vitest once and write a runtime profile summary
npm run test:watch    # Watch mode — re-runs on file changes
npm run lint          # ESLint across frontend + worker code
npm run typecheck     # Type-check frontend, shared, Pages Functions, and root scripts
npm run typecheck:worker # Type-check Worker runtime code (includes worker-bound operational scripts)
npm run audit:deps    # Fails on high-severity npm advisories
npm run seo:check     # Static SEO audit against built `out/` HTML
npm run check:generated-artifacts # Verify all generated artifacts from the automation registry are current
npm run check:cemetery-dataset # Verify generated Stablecoin Cemetery JSON/CSV exports match source data
npm run check:agent-doc-sync # Verify AGENTS.md and CLAUDE.md stay synchronized where required
npm run check:worker-boundary # Enforce the shared boundary in both directions (no worker -> `src` imports, no `src`/`shared`/`scripts`/`functions` -> `worker/src` imports; pure cross-runtime metadata belongs in `shared/`)
npm run check:shared-cycles # Fail on circular dependencies inside `shared/`, `worker/src`, and `src`
npm run check:shared-types-imports # Manual guardrail for broad `@shared/types` value imports
npm run check:unused-code # Detect unreferenced internal runtime modules and unused named exports across `src/`, `shared/`, `worker/src/`, and `functions/`
npm run check:hotspot-ratchet # Fail when enrolled hotspots regress or generated hotspot candidates lack explicit metadata-rich enrollment/waivers
npm run check:site-csp-sync # Verify managed `public/_headers` CSP lines match `shared/lib/site-csp.ts`
npm run check:cron-abort-contract # Verify leased cron jobs accept/pass AbortSignal or carry explicit waivers
npm run check:cron-sync # Verify `shared/lib/cron-jobs.ts`, `shared/lib/scheduled-runner-registry.ts`, and `worker/wrangler.toml` stay aligned
npm run check:cron-connections # Enforce the documented per-trigger outbound connection budget across cron slots
npm run check:cron-console-usage # Ratchet `console.*` usage in worker cron/scheduled code against the checked-in baseline
npm run check:client-registry-imports # Block client `src/` code from importing the full stablecoin registry (use the client registry)
npm run check:selector-banned-phrases # Banned-phrase lint for the Stablecoin Picker/Selector editorial surface
npm run check:script-entrypoints # Verify script entrypoints referenced in scripts/docs/package.json exist under allowed prefixes
npm run check:doc-counts # Verify tracked/shadow/adapter/bluechip/live-enabled counts in docs match code
npm run check:verified-doc-links # Verify all markdown links in verified docs resolve
npm run check:doc-source-paths # Verify backtick source-path references in README.md and docs/** resolve to files/directories
npm run check:doc-sync # Verify exact methodology versions, thresholds, weights, and enforced limits stay aligned with code and canonical version labels
npm run check:env-contract # Verify shared env manifest, example files, and env-focused docs stay aligned
npm run check:frozen-invariants # Verify frozen stablecoins stay out of live/public-active data surfaces
npm run check:duplicate-exports # Detect duplicate export declarations within individual files
npm run check:docs-api-reference # Verify generated docs API-reference block is current
npm run check:llms-txt # Verify generated `/llms.txt` is current
npm run check:openapi # Verify generated public OpenAPI artifact is current
npm run check:postman # Verify generated public Postman collection/environment artifacts are current
npm run check:world-map # Verify generated static world map SVG is current
npm run check:sql-safety # Static analysis of D1 SQL patterns for safety issues
npm run check:stablecoin-data # Validate stablecoin JSON data files against schema
npm run check:dependency-coverage # Dependency-map coverage audit; enforces graph and reserve-link ratchets from scripts/lib/dependency-coverage-baseline.json
npm run check:build-size # Report and enforce static-export JS/CSS/media/HTML/TXT size budgets after `npm run build`
npm run check:feature-flag-inlining # Verify configured NEXT_PUBLIC_PHAROS_* flags are build-time inlined after `npm run build`
npm run check:phishing-signatures # Scan built `out/` HTML for inline-script patterns that match credential-harvesting phishing kits
npm run check:classifier-sensitive-copy # Scan built `out/` HTML for wallet-drainer/phishing/browser-warning copy on classifier-sensitive routes
npm run test:a11y    # Playwright/axe accessibility route smoke after `npm run build`
npm run check:safe-browsing # Query Google Safe Browsing v4 for monitored URL flags (daily workflow + manual)
npm run check:supply-helper-usage # Enforce `getCirculatingRaw()` usage for DefiLlama list-endpoint supply values
npm run check:stale-flags # Fail when feature-flag expiresAt comments are today or earlier
npm run check:one-liner-coverage # Verify active/pre-launch stablecoins keep one-line editorial summaries
npm run check:mechanism-archetype-coverage # Enforce the mechanism-archetype curation coverage threshold
npm run check:archetype-explainer-coverage # Verify every `MechanismArchetype` has a label, one-liner, content module, and `/learn/mechanisms/<slug>/` sitemap entry; see [learn-mechanisms-page.md](./learn-mechanisms-page.md)
npm run check:attestor-tier-coverage # Enforce proof-of-reserves attestor-tier coverage for independent-audit coins
npm run check:glossary-coverage # Verify AI-summary glossary term markers resolve
npm run check:redemption-backstops # Validate redemption backstop configs for completeness
npm run check:redemption-coverage-audit # Enforce ratcheted Redemption Backstop active-gap/default-gap/heuristic backlog baselines
npm run check:migrations # Replay worker D1 migrations against a throwaway SQLite DB
npm run audit:pricing-providers # Verify pricing provider configs are consistent
npm run coverage:critical:update-baseline # Update the critical-coverage baseline snapshot
npm run lint -- --fix # Auto-fix fixable warnings (stale directives, etc.)
npm test -- --coverage # Run tests with V8 coverage report
npm run test:critical-contracts # Targeted critical endpoint contract runner
npm run test:invariants # Critical numerical/schema invariant suite
npm run test:noncritical # Deploy/merge-gate Vitest lane excluding tests owned by coverage:critical
npm run coverage:critical # Critical-suite coverage run + critical-path line-coverage gate
npm run test:merge-gate # Delta-aware local gate before pushing merged worktree changes
npm run validate:pages-smoke # Serve the built static export and run local Pages smoke checks
npm run lighthouse:static # Serve the built static export and fail when mobile Lighthouse performance is below 95 using DevTools throttling
npm run validate:worker-smoke # Run local worker canary smoke checks after worker typecheck
npm run check:hook-polling-window # Verify local agent hook polling windows stay within the configured budget
npm run check:reserve-fixture-freshness # Verify retained reserve HTML fixtures stay within freshness policy
npm run test:smoke-api -- --base-url https://api.pharos.watch # HTTP smoke checks for critical API endpoints (set SMOKE_API_KEY when protected routes are enforced)
npm run test:smoke-ops # Private ops-host and ops-api smoke checks through Cloudflare Access
npm run test:smoke-transport # HTTP->HTTPS edge redirect smoke for api.pharos.watch and site-api.pharos.watch
npm run test:smoke-ui -- --url https://pharos.watch --mode live # Browser-level UI smoke check; local mode runs the full overflow sweep, live mode runs a narrower canary unless --skip-overflow is set
npm run test:smoke-ui:mobile -- --url http://localhost:3000 # Mobile-focused rendered smoke; strict common-control touch targets, table geometry checks, and console reporting (desktop spot pass is opt-in)
```

Markdown variants are generated for `/methodology/`, methodology changelogs, `/changelog/`, `/digest/[date]/`, stablecoin detail pages, and `/docs/*`. Representative checked-in fixture snapshots live under `scripts/__tests__/fixtures/markdown/`. When an intentional visible copy or renderer change updates one of those covered outputs, run `npm run build` or `npx tsx scripts/maintenance/generate-markdown-exports.ts`, copy the matching `out/**/index.md` file over its fixture, and commit the fixture in the same change as the JSX or renderer edit.

`npm run audit:pricing-providers` checks the configured CEX and RedStone provider contracts against live metadata and is covered by mocked unit tests for success, regional blocking, provider drift, non-OK responses, and malformed metadata shapes. Optional live source-shape probes can be run with `tsx scripts/maintenance/audit-pricing-provider-config.ts --live-source-shapes`; this adds Jupiter V3 shape validation and, when `CMC_API_KEY` is set, a CoinMarketCap category shape check. Stablecoins sync metadata also emits `pricingSourceAuditReport`, which summarizes source distribution risks such as missing prices, fallback/cache reliance, low-confidence pricing, assets without an independent hard source, and structured provider rejection counts.

When `SMOKE_UI_EXPECT_GA_ID` is set, `npm run test:smoke-ui` first verifies that the homepage artifact includes the expected GA script tag, then the browser smoke verifies runtime analytics initialization: `window.gtag`, the expected `config` entry, the `page_view` entry, a successful `gtag.js` load, and a GA4 `page_view` collect signal. Live mode requires successful collect delivery; after that success, expected-measurement GA collect `net::ERR_ABORTED` reports are treated as browser beacon noise. Local artifact mode also accepts a Playwright `net::ERR_ABORTED` report for a GA4 collect URL with the configured measurement id because Chromium can abort that issued beacon when the local smoke context closes.

## CI Pipeline

Defined across `.github/workflows/validate-ci.yml`, `.github/workflows/pull-request-checks.yml`, `.github/workflows/pharos-change-contract.yml`, `.github/workflows/deploy-cloudflare.yml`, `.github/workflows/pages-release.yml`, `.github/workflows/rebuild-pages.yml`, `.github/workflows/og-refresh.yml`, `.github/workflows/critical-coverage-ratchet.yml`, `.github/workflows/codeql.yml`, `.github/workflows/zizmor.yml`, `.github/workflows/dependency-audit.yml`, `.github/workflows/telegram-load.yml`, `.github/workflows/secret-scan.yml`, and `.github/workflows/safe-browsing-monitor.yml`.

For deployment/worktree operating procedure (including the local merge gate before every push), see [Deployment Process](./deployment-process.md).

1. `Pull Request Checks`
   - runs the shared `validate` gate on `pull_request` to `main`
   - classifies the PR diff with `scripts/ci/classify-deploy-changes.mjs`, then passes `pages_changed` and `worker_changed` into the reusable workflow
   - still runs the shared non-deploy guardrails and tests on every PR; PR Pages build/SEO follows `pages_changed`, and Worker typechecks follow the same worker deploy-surface flag used by the push deploy workflow
   - runs a pinned gitleaks commit-range scan for pull-request secret detection
   - uses the PR base SHA for the critical-coverage ratchet diff
2. `Pharos Change Contract`
   - defined in `.github/workflows/pharos-change-contract.yml`
   - runs on pull requests to `main` and manual dispatch
   - renders the deploy-surface and validation-contract summary from `scripts/ci/pharos-change-contract.mjs`
   - is advisory and does not deploy or publish artifacts
3. `validate` (runs before any deployment):
   - runs the shared validate pre-build command set from `scripts/lib/validate-contract.mjs` with bounded parallelism: dependency/pricing audits, dependency-coverage audit, lint/typecheck, import boundaries, cycles, migrations, cron checks, docs checks, registry-derived generated-artifact checks, env checks, duplicate/export/registry guards, CSP/header sync, unused-code/hotspot/sql/stablecoin-data checks
   - starts `validate:prebuild` and the non-mutating leaf checks on separate runners at the same time: four non-critical Vitest shards, critical coverage, optional Worker runtime typecheck, and optional Pages build/SEO
   - runs all four `npm run test:noncritical -- --shard=N/4` shards and requires every shard before the aggregate `validate` job succeeds
   - keeps `npm run coverage:critical` unchanged and passes the compare ref into the critical coverage ratchet
   - runs `npm run typecheck:worker` only when `worker_changed=true`
   - runs `npm run build` + `npm run test:a11y` + `npm run check:feature-flag-inlining` + `npm run seo:check` + Safe Browsing classifier guardrails (`check:phishing-signatures`, `check:classifier-sensitive-copy`) and built-artifact budget/drift checks in PR validation when `pages_changed=true` and `run_pages_build_and_seo=true`
   - production deploy calls set `run_pages_build_and_seo=false`; the deploy workflow calls the consolidated `pages-release` workflow for Pages data sync, build, a11y, SEO, build-size/build-attribution guards, local artifact smoke, publish, and live smokes
4. `detect-changes` (push/manual deploy workflow; same classifier also runs in pull-request checks):
   - Diffs `github.event.before...github.sha` on `push`
   - Emits `deploy_required`, `worker_changed`, `worker_promotion_required`, `pages_changed`, and `pages_ui_changed`
   - Marks worker validation work as required when the diff touches worker runtime, Worker-consumed shared runtime contracts, package/deploy infra, `.github/actions/`, `scripts/lib/`, shared guardrail scripts, worker operational scripts, or worker-specific checks/smokes. Known Pages-only shared helpers are excluded by subpath in `scripts/lib/automation-registry.mjs`.
   - Marks Worker promotion as required only when the diff touches deployed Worker runtime/config, D1 migrations, Worker assets, shared runtime files that the Worker can consume, or root package/lock changes to Worker-consumed packages; root package/tooling changes that only touch non-Worker packages and known Pages-only shared contract files still validate broadly without uploading/promoting a Worker version
   - Marks Pages deploy work as required when the diff touches Pages runtime paths, package/deploy infra, `.github/actions/`, `scripts/lib/`, shared guardrail scripts, Pages workflow files, or selected build/static-export scripts
   - Marks `pages_ui_changed=true` only for likely frontend/runtime surfaces (`src/`, `public/`, `shared/`, `functions/`, `data/`, root package/lock, `next.config.ts`) so strict mobile smoke can skip deploy-infra-only Pages diffs
   - Skips the heavy deploy workflow entirely when neither Pages nor worker deploy surfaces changed
   - Forces the full path on `workflow_dispatch`; manual production dispatch must target the `main` ref
5. `upload-worker-version` (needs `detect-changes`):
   - Uses the shared workspace setup and the lockfile-installed Wrangler CLI for non-mutating candidate upload, matching the later mutating deploy lane
   - Capture the currently live production Worker version ID with `wrangler deployments status --json`
   - Upload a candidate Worker version with `wrangler versions upload` before validation completes; this is non-mutating preparation for the promotion lane and keeps preview URL smoke available before production traffic shifts. If Cloudflare returns `entitlements.not_available [code: 10007]` for Workers Versions, the job records `version_upload_unavailable=true` and lets `deploy-worker` use the validated legacy deploy fallback instead.
   - Skipped on Pages-only, validation-only, or non-deploy `push` events where `worker_promotion_required=false`
6. `deploy-worker` (needs `upload-worker-version` when Worker promotion is required):
   - Waits for the aggregate `validate / validate` job before any production D1 mutation or Worker promotion
   - Re-runs `npm run check:migrations` on the release runner immediately before remote D1 changes
   - Applies D1 migrations with the local worker-pinned Wrangler CLI, then runs `npm run test:smoke-api` against the uploaded preview URL before the candidate is considered promotable when Workers Versions are available
   - Promotes the preview-smoked candidate version with `wrangler versions deploy <version-id>@100`, or runs `wrangler deploy` after validation and migrations when the account lacks Workers Versions entitlement
   - Sync routes/domains/cron triggers with `wrangler triggers deploy`
   - Runs deploy canary `smoke-api` checks in the same job before promotion when preview URLs are available and always after production deploy (full strict API contract coverage remains in Vitest). Automatic Worker rollback requires the Workers Versions path; the legacy fallback still fails the workflow on production smoke failure.
   - On worker-only deploys, runs live public UI, ops, and transport smokes in parallel inside the same job
   - Skipped on Pages-only, validation-only, or non-deploy `push` events
7. `pages-release`:
   - production deploy job in `.github/workflows/deploy-cloudflare.yml` that calls the consolidated `.github/workflows/pages-release.yml`
   - runs only when `pages_changed=true`
   - starts as soon as Pages changes are detected, in parallel with Worker candidate upload/promotion work when both surfaces changed
   - fetches `/api/digest-archive` into `data/digests.json`, fetches confirmed depeg events into `data/depeg-events.json`, regenerates public dataset mirrors from the selected API environment, forwards `NEXT_PUBLIC_GA_ID` and `NEXT_PUBLIC_PHAROS_*` repo variables into `npm run build`, clears the public-dataset fetch env for the build prehook so it preserves the synced mirrors instead of re-fetching, builds with `NEXT_PUBLIC_FORCE_SITE_DATA_PROXY=true` so local static-export smoke uses the production `/_site-data/*` browser lane, then runs `npm run test:a11y`, `npm run check:feature-flag-inlining`, `npm run check:phishing-signatures`, `npm run check:classifier-sensitive-copy`, `npm run check:build-size` (including the Cloudflare Pages 20,000-file cap), and `npm run check:build-attribution`
   - serves the just-built `out/` export locally, proxies direct `/api/*` and `/_site-data/*` calls to the selected API base, injects `SITE_API_SHARED_SECRET` for the site-data proxy hop, and runs local pre-publish checks in parallel (`npm run seo:check`, `npm run test:smoke-ui -- --url http://127.0.0.1:4173 --mode local`, plus strict mobile canary `npm run test:smoke-ui:mobile -- --url http://127.0.0.1:4173` when `pages_ui_changed=true`)
   - deploy-lane local artifact `smoke-ui` uses canary overflow routes with `SMOKE_UI_OVERFLOW_WORKERS=6` to reduce critical-path runtime; broader overflow route coverage remains in wider validation/smoke lanes
   - waits for the aggregate `validate / validate` job before publishing to Cloudflare Pages production; on combined Worker + Pages deploys, also waits for `deploy-worker` and reruns local artifact `smoke-ui` against the promoted Worker before publish
   - writes a Pages release summary with output file count, static export size, and depeg-event static page count, captures the current production Pages deployment id as a required rollback target, fails before publish when that capture is unavailable, publishes the verified local artifact with the Wrangler retry loop, and then runs live public UI, ops, and transport smokes in parallel inside the same job; the live UI smoke keeps broad overflow coverage on the exact local artifact and adds a narrow live `/depeg/` canary for the default-on DDR/DDRQ data contract
   - rolls Pages production back to the captured previous deployment when any fatal post-publish smoke (live public UI, ops, or transport) fails
   - when `SMOKE_UI_EXPECT_GA_ID` is configured, that smoke step verifies the built homepage artifact contains the expected GA script and that the browser initializes `window.gtag` with the expected `page_view` payload; live smoke requires successful GA4 `page_view` collect delivery, while local artifact smoke also accepts an issued collect request for the configured measurement id that Chromium reports as `net::ERR_ABORTED`; once a successful live collect is observed, additional expected-measurement GA collect aborts are tolerated as browser beacon noise
8. `smoke-ops`:

- Run `npm run test:smoke-ops`
- Uses `SMOKE_OPS_UI_URL` / `SMOKE_OPS_API_BASE` (defaults: `https://ops.pharos.watch/admin/`, `https://ops-api.pharos.watch`)
- Requires repository secrets `OPS_SMOKE_CF_ACCESS_CLIENT_ID` and `OPS_SMOKE_CF_ACCESS_CLIENT_SECRET`
- Runs inside `pages-release` after `deploy-pages` on Pages-including deploys, or inside `deploy-worker` on worker-only deploys
- On Pages-including deploys, runs inside the shared parallel post-publish smoke step; ops still emits its own status so failures are visible separately from public UI and transport checks
- Defaults to the full scope, which verifies the ops UI host is Access-gated (or service-token-accessible, if configured) plus `status`, `status-history`, admin samples, and safe dry-run admin paths on the operator API host
- Production deploys set `SMOKE_OPS_SCOPE=canary`, which keeps the ops UI shell/access checks plus direct and same-origin status checks on the critical path while leaving slower deep admin probes available for manual/full smoke runs

9. `smoke-transport`:

- Run `npm run test:smoke-transport`
- Verifies `http://api.pharos.watch/...` and `http://site-api.pharos.watch/...` return `308` before application auth or worker logic responds
- Runs after the same production-changing gate as `smoke-ops`
- Fails the workflow on redirect regressions once the zone-level redirect rule is in place

10. `Rebuild Pages`:

- defined in `.github/workflows/rebuild-pages.yml`
- runs on the daily schedule and on manual dispatch
- skips `validate` and Worker promotion
- runs the shared `pages-release` wrapper workflow, whose publish phase includes `smoke-ui-live`, `smoke-ops`, and `smoke-transport`

11. `OG Refresh`:

- defined in `.github/workflows/og-refresh.yml`
- runs on a weekly Monday schedule (cron `23 4 * * 1`) and on manual dispatch
- captures checked-in static OG screenshots against production and opens or updates the `automated/og-refresh` branch when the images change
- requires `OG_REFRESH_GITHUB_TOKEN`, a bot or PAT token that can push the refresh branch and open PRs so normal `pull_request` checks run

12. `CodeQL`:

- defined in `.github/workflows/codeql.yml`
- runs on pushes to `main`, pull requests to `main`, and a weekly Monday schedule
- analyzes the JavaScript/TypeScript codebase separately from the deploy pipeline
- uses `.github/codeql/codeql-config.yml` to exclude Vitest/test fixtures from production security scanning

13. `Zizmor`:

- defined in `.github/workflows/zizmor.yml`
- runs on pushes to `main`, pull requests to `main`, and a weekly Monday schedule
- scans GitHub Actions workflows and uploads SARIF findings to GitHub Code Scanning
- runs separately from CodeQL so workflow-security findings have their own tool identity and triage state

14. `Dependency Audit`:

- defined in `.github/workflows/dependency-audit.yml`
- runs on a weekly Monday schedule and on manual dispatch
- installs from the root lockfile and runs `npm audit --audit-level=high`
- complements the blocking production-only `npm run audit:deps` gate by covering devDependencies too
- owner: the maintainer driving the next production deploy or dependency update
- response expectation:
  - blocking `npm run audit:deps` failures are stop-ship until fixed, pinned away, or explicitly risk-accepted
  - scheduled dependency-audit findings must get a tracked triage note or remediation issue the same business day
  - do not leave a new high/critical finding unowned between audit detection and the next production deploy

15. `Telegram Load Guard`:

- defined in `.github/workflows/telegram-load.yml`
- runs on a weekly Monday schedule and on manual dispatch
- runs `npm run check:telegram-load`, including the 5,000-watcher target SLO, without touching production D1 or Telegram
- complements the deploy validate lane without adding the synthetic load harness to every push path

16. `Critical Coverage Ratchet`:

- defined in `.github/workflows/critical-coverage-ratchet.yml`
- runs on a weekly Monday schedule and on manual dispatch
- runs `npm run coverage:critical` with `CRITICAL_COVERAGE_RATCHET_ALL=1` so untouched critical files are checked against the baseline, while pull request and merge-gate paths keep the faster touched-file ratchet
- uses the same high-stakes pricing/depeg/reserve candidate completeness guard as pull request and merge-gate coverage; new candidates must be added to `CRITICAL_FILES` with a baseline or explicitly waived in `scripts/lib/critical-coverage.mjs`
- uses the same Node 24.16.0 workspace setup as the deploy validate lane

17. `Secret Scan`:

- defined in `.github/workflows/secret-scan.yml`
- runs on a weekly Monday schedule and on manual dispatch
- checks out full git history and runs pinned `gitleaks` `8.30.0`
- uses the root `.gitleaksignore` to suppress reviewed historical false positives by exact fingerprint
- scans commit history for accidentally committed secrets and fails on any non-allowlisted finding

18. `Safe Browsing Monitor`:

- defined in `.github/workflows/safe-browsing-monitor.yml`
- runs on a daily schedule (`17 7 * * *`) and on manual dispatch
- queries Google Safe Browsing v4 `threatMatches:find` for `pharos.watch` and key public URLs via `npm run check:safe-browsing`
- requires the `GOOGLE_SAFE_BROWSING_API_KEY` repository secret
- fails the run on any flagged URL; complements the deploy-gating `check:phishing-signatures` static scan

This arrangement keeps pull-request validation full-strength, makes deploy-path validation conditional on the surfaces that actually changed, skips the production workflow entirely for non-deploy pushes, proves the static export build, a11y route smoke, feature-flag inlining, SEO gate, build-size/build-attribution guards, dependency-coverage drift, and Safe Browsing classifier guardrails before merge and in the consolidated Pages release path, fetches digest/depeg/public-dataset data once inside the Pages release job so the build itself is network-independent with respect to those static inputs, forwards the configured GA measurement ID and `NEXT_PUBLIC_PHAROS_*` flag values into CI builds so the static artifact matches production analytics and flag posture, forces the local static-export artifact smoke through the production `/_site-data/*` browser lane instead of the protected direct `/api/*` lane, uploads the Worker candidate early when Workers Versions are available, waits for the aggregate validate result before D1 mutation or production publish, smokes the exact candidate Worker version on its preview URL before production traffic is shifted when possible, reruns local artifact `smoke-ui` after Worker promotion on combined deploys, falls back to a validation-gated `wrangler deploy` when Cloudflare rejects Workers Versions with an entitlement error, keeps the broad overflow sweep on the local artifact smoke before Pages production deploy, records a compact Pages release summary before publish, verifies the real `pharos.watch` host after each Pages publish with homepage, analytics, data-state, and `/depeg/` canary checks, keeps the scheduled Pages rebuild off the worker deploy path, still runs the post-deploy ops-surface plus transport smoke after each production-changing workflow, surfaces Pages post-publish UI/ops/transport outcomes via per-smoke statuses from one parallel post-publish step, and adds separate weekly/daily/manual lanes for CodeQL, GitHub Actions security scanning, dependency auditing, Telegram load simulation, all-critical coverage ratcheting, history-aware secret scanning, and Safe Browsing verdict monitoring.

Current GitHub repository secrets required by the deploy path:

- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for Worker/Pages deploy and rollback helpers
- `SMOKE_API_KEY` for preview and production `smoke-api`
- `DIGEST_API_KEY` for Pages digest sync against protected public API routes; it also acts as the fallback for depeg-event and public-dataset sync when their dedicated secrets are not set
- `SITE_API_SHARED_SECRET` for local artifact smoke through `/_site-data/*`
- `OPS_SMOKE_CF_ACCESS_CLIENT_ID` and `OPS_SMOKE_CF_ACCESS_CLIENT_SECRET` for `smoke-ops`

Optional dedicated GitHub repository secrets for the deploy path:

- `DEPEG_EVENTS_API_KEY` and `PUBLIC_DATASETS_API_KEY` for dedicated Pages prebuild data sync credentials when those routes diverge from the digest credential; both fall back to `DIGEST_API_KEY`
- `ACTIONS_CHECKOUT_TOKEN` for production deploy checkout fallback when GitHub rejects the default Actions token during repository fetch; absent by default, and workflows fall back to `github.token`

Current GitHub repository secrets required by scheduled monitors:

- `GOOGLE_SAFE_BROWSING_API_KEY` for `Safe Browsing Monitor`

Current GitHub repository secrets required by scheduled artifact PRs:

- `OG_REFRESH_GITHUB_TOKEN` for `OG Refresh`; use a bot or PAT token instead of `GITHUB_TOKEN` so the automated PR runs the normal pull-request validation workflows

Current GitHub repository variables used by the deploy path:

- `API_BASE_URL` (required)
- `SMOKE_API_BASE_URL`, `SMOKE_OPS_UI_URL`, `SMOKE_OPS_API_BASE`, `NEXT_PUBLIC_GA_ID`, and `NEXT_PUBLIC_PHAROS_*` (optional)

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

The workflows pin `actions/checkout@v6` by commit SHA, and the shared `.github/actions/setup-workspace` action pins `actions/setup-node@v6` and `actions/cache@v5` by commit SHA. The shared validate/deploy lanes run on Node 24.16.0 through that setup action, matching `package.json#engines.node` and `.nvmrc`; there is no separate LTS proof lane because Node 24 is the primary supported baseline. The reusable validate workflow starts `validate:prebuild`, non-critical Vitest shards, critical coverage, optional Worker typechecks, and optional PR Pages build/SEO as independent GitHub jobs, with an aggregate `validate` job checking every required result before production-changing jobs may mutate D1, promote Workers, or publish Pages. The local merge gate in `scripts/maintenance/test-merge-gate.mjs` uses `buildCommandPlan` to construct a per-trigger execution plan and runs build/non-critical-test/critical-coverage/typecheck groups **serially by default** while preserving `build -> seo:check` ordering; set `MERGE_GATE_PARALLEL=1` to opt into the parallel matrix when you have the cores to spare (and `VALIDATE_PREBUILD_CONTINUE_ON_ERROR=1` when you need prebuild to collect all guardrail failures). Tooling caches for `.next/cache`, `.cache/eslint`, and `*.tsbuildinfo` use a normalized Node-major restore prefix plus dependency/config hashes, while primary keys include the job, run id, and attempt so restored generated caches can be saved after builds. Worker deploys intentionally avoid `cloudflare/wrangler-action`; the repo now uses a root npm workspace, so CI installs the shared toolchain from the root lockfile and invokes Wrangler with `npx --no-install`. `npm run audit:deps` also runs in the validate job so high-severity production advisories fail the push/manual deploy pipeline before deploy, and the scheduled dependency-audit workflow covers devDependencies separately. The production-changing workflows also share one global `concurrency` group (`production-deploy`): push/manual deploys and scheduled/manual Pages rebuilds queue behind active production runs instead of canceling post-promotion smoke or rollback work. Manual production dispatches are guarded to `refs/heads/main`.

`npm run check:migrations` replays every file in `worker/migrations/` against a throwaway SQLite database before deploy. It now prefers the `sqlite3` CLI when present and falls back to Node's built-in `node:sqlite`, which removes the old Node-25-first happy path while still catching schema typos in unapplied D1 migrations before `deploy-worker` touches production. Historical duplicate migration prefixes are tracked explicitly in `worker/migrations/MANIFEST.md`; the checker fails only on new undeclared duplicates and keeps the current allowlist visible in review. The same check now also enforces the rollout-safety contract for new migrations starting at `0071`: every new migration must declare `-- rollout-safety: backward-compatible`, destructive table/column drop-or-rename patterns are rejected, and `ALTER TABLE ... ADD COLUMN ... NOT NULL` without a `DEFAULT` is rejected because the still-live worker may still insert rows before promotion. The deploy workflow also reruns this check on the release runner immediately before remote `wrangler d1 migrations apply`.

`npm run test:merge-gate` now mirrors the deploy-path validate contract locally. The default changed-file range is `origin/main...HEAD`; the repo pre-push hook overrides that for pushes to `main` with Git's exact `remote_sha...local_sha` update range, matching the deploy workflow's `github.event.before...github.sha` classifier input. When no base ref is explicitly overridden and `MERGE_GATE_NO_FETCH=1` is not set, the gate also runs a best-effort `git fetch --quiet origin main` first to keep the diff base honest; offline failures log a warning and continue. Before executing a non-dry-run command plan, the gate runs `scripts/ci/check-node-modules-fresh.mjs --strict`, which is fatal when `node_modules/` is missing, when the install snapshot is ambiguous, or when the lockfile is newer than the local install. `MERGE_GATE_DRY_RUN=1` prints the plan without requiring `node_modules/`. If the changed-file set is not deploy-impacting, it prints the diff and exits successfully. For deploy-impacting diffs, it runs the shared prebuild guardrail registry from `scripts/lib/validate-contract.mjs`, then `npm run test:noncritical` (sharded as `--shard=1/4`, `--shard=2/4`, `--shard=3/4`, `--shard=4/4` to match CI) and critical coverage. That registry is the source of truth for dependency/pricing audits, lint/typecheck, import-boundary/cycle checks, migrations, cron checks, documentation checks, the registry-derived `check:generated-artifacts` drift gate, env contracts, frozen invariants, duplicate-export and redemption-backstop guards, CSP/header sync, unused-code, hotspot-ratchet, hook polling window, shared-types import boundary, reserve-fixture freshness, SQL-safety, stablecoin data validation, and supply-helper usage. The critical coverage lane owns the critical test files, so the merge gate keeps the full deploy test surface without rerunning those files in the bare Vitest lane. The cycle step now blocks on cycles in `shared/`, `worker/src`, and `src`. It adds `npm run build` with the production Pages static-export env contract (`NEXT_PUBLIC_FORCE_SITE_DATA_PROXY=true` and public-dataset/API source env cleared), then `npm run test:a11y`, `npm run check:feature-flag-inlining`, `npm run seo:check`, `npm run check:phishing-signatures`, `npm run check:classifier-sensitive-copy`, and Pages built-artifact guardrails when Pages-impacting files changed, and adds `npm run typecheck:worker` when worker-impacting files changed. After `validate:prebuild`, build/non-critical-test/critical-coverage/typecheck groups run **serially by default** to avoid local CPU contention; set `MERGE_GATE_PARALLEL=1` to opt into parallel execution, where a failing parallel group aborts siblings and reports the failing command explicitly. The gate also injects `TZ=UTC`, `LANG=C.UTF-8`, and `CI=true` into command env to match the CI runtime; set `MERGE_GATE_NATIVE_ENV=1` when debugging TZ-specific bugs. Set `MERGE_GATE_HEAD_REF=<ref>` with `MERGE_GATE_BASE_REF=<ref>` for explicit range checks, or `MERGE_GATE_FULL_DEPLOY=1` when there is no usable base ref. For an opt-in production Pages environment rehearsal, set `MERGE_GATE_PRODUCTION_ENV=1` and export the production `NEXT_PUBLIC_GA_ID`, `NEXT_PUBLIC_PHAROS_*`, `STATIC_EXPORT_API_BASE`, `STATIC_EXPORT_SITE_API_BASE`, `PHAROS_API_KEY` or `STATIC_EXPORT_API_KEY`, and `SITE_API_SHARED_SECRET` values before running the gate; without the opt-in, the gate clears public production feature-flag env locally while applying the static-export build contract. `test:merge-gate` runs Pages smoke by default for Pages-impacting diffs; set `MERGE_GATE_PAGES_SMOKE=0` to skip. Worker smoke remains explicit via `MERGE_GATE_WORKER_SMOKE=1` and defaults local worker smoke to `SMOKE_API_SCOPE=canary` unless overridden. When Pages smoke runs it includes desktop/local `smoke-ui` on the same deploy-lane canary routes with 6 overflow workers, auto-selects a free local static-export port if `127.0.0.1:4173` is occupied, and strict mobile smoke runs only when the same UI-surface matcher would set `pages_ui_changed=true`; mobile canary defaults mirror deploy.

`npm run check:unused-code` now scans all runtime code under `src/`, `shared/`, `worker/src/`, and `functions/`, with explicit module/export allowlists for intentional exceptions. `npm run check:hotspot-ratchet` now guards the maintained shell/facade files in `scripts/lib/hotspot-ratchet-baseline.json`, including `worker/src/cron/compute-dews.ts`, and also generates current repo-wide hotspot candidates from the top file-line, max-function-line, and branch-count outliers. Every generated candidate must either be enrolled in the baseline or explicitly waived in `scripts/lib/hotspot-ratchet-waivers.json`, so newly emerged hotspots cannot drift past the guardrail unseen. The ratchet still fails fast on stale target paths, unexpected baseline entries, stale waiver entries, and incomplete waiver metadata. Each waiver must carry `owner`, `createdAt`, `reviewAfter`, and `nextAction`; each baseline entry declares a `disposition`, `targetBudget`, and implementation note so the ratchet doubles as a decomposition backlog rather than a blind ceiling list. Refresh the baseline only after an intentional refactor with `npm run check:hotspot-ratchet:update-baseline`, and update the matching waiver/backlog metadata at the same time.

`npm run check:cron-sync` is part of the shared CI validate gate. Run it locally whenever you change `worker/wrangler.toml` cron expressions, `shared/lib/cron-jobs.ts`, or the scheduled-runner registry so you catch schedule/dispatch drift before pushing.

`npm run seo:check` is the static-export SEO gate. It inspects the built `out/` HTML for missing title/description/canonical/OpenGraph/Twitter tags, indexable titles outside the 35-70 character search-snippet envelope, indexable descriptions outside the 110-180 character envelope, missing Google preview directives (`max-snippet:-1`, `max-image-preview:large`, `max-video-preview:-1`) on indexable pages, missing `og:type` on indexable pages, duplicate or missing `h1`s on indexable pages, invalid JSON-LD, indexable structured-data URLs that point under `/_site-data/`, conflicting robots directives, sitemap omissions, sitemap URLs without local static HTML artifacts, orphan pages, and indexable routes that are more than three clicks away from `/`. It also samples representative stablecoin detail and chain detail pages for crawlable static text so those routes do not regress into loading-shell-only exports.

`npm run analyze:gsc-coverage -- <export-or-drilldown-path> [...]` inventories Google Search Console coverage exports for SEO triage. It accepts coverage directories, CSV files, and ZIP drilldowns, reports XLSX/XLS files as unsupported unless exported as CSV, and performs no live network checks; use the output to map GSC issue rows to URL drilldowns and decide the manual live-check queue.

`npm run analyze:gsc-performance -- <export-or-drilldown-path> [...]` inventories Google Search Console performance exports for CTR triage. It accepts performance directories, CSV files, and ZIP exports, reports XLSX/XLS files as unsupported unless exported as CSV, and performs no live network checks; use `--target-ctr`, `--min-impressions`, and `--top` to rank site, family, page, and query CTR gaps before changing titles or descriptions. Standalone query exports are reported as query opportunities only and are not joined back to pages.

`node scripts/maintenance/audit-seo-render-budget.mjs --url https://pharos.watch` is an optional live/local render-budget probe for SEO work. It records per-route HTML size, visible text length, request counts, asset mix, cache headers, and observed/known transfer size; use it to investigate render budget or cacheability risks without making it part of the default CI gate.

`npm run seo:live-smoke -- --url https://pharos.watch` is the post-deploy/live SEO smoke. It checks sitemap URLs for redirects, 404s, and `noindex`, verifies `/chains/` HTML is not served with immutable asset caching, verifies direct generated markdown URLs carry `X-Robots-Tag` plus canonical `Link` headers, and runs JS-disabled Playwright canaries on key pages. It is intentionally not part of the local merge gate because it targets a deployed host; use `--sitemap-limit <n>` for a shorter sampling pass.

## Vitest Runtime Profiling

`npm run test:profile -- --output /tmp/pharos-vitest-profile.json` runs Vitest once with the JSON reporter, stores the raw Vitest report beside the requested output as `*.vitest.json`, and writes a durable summary to the requested `/tmp` path. The summary prints total files/tests, wall time, summed file/test time, node/jsdom split, top files, top individual tests, files above 10s, and tests above 1s.

Pass Vitest filters or options after `--` when narrowing or validating runner behavior:

```bash
npm run test:profile -- --output /tmp/pharos-src-profile.json -- --dir src
npm run test:profile -- --output /tmp/pharos-vitest-threads.json --baseline /tmp/pharos-vitest-profile.json -- --pool=threads
```

In CI, `npm run test:noncritical` and `npm run coverage:critical` append `--silent=passed-only` unless an explicit `--silent` option is already supplied. Set `PHAROS_CI_VITEST_COMPACT=0` to restore full console output while debugging a CI-only failure. The PR/deploy reusable validate workflow shards `test:noncritical` across four runners; local `npm run test:merge-gate` emits the same four shard commands but runs them sequentially by default to avoid local CPU contention.

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
      ".next/**",
      "out/**",
      "coverage/**",
      "tests/visual/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: [
        /* mirrors test.exclude */
      ],
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

The config also includes a `wasmStubPlugin()` Vite plugin that stubs `.wasm` imports for Node compatibility and resolve aliases for `satori/standalone`, `satori/yoga.wasm`, `@cf-wasm/resvg/workerd`, and `@resvg/resvg-wasm`. The supported test baseline is Node 24 LTS; the `nodeMajor >= 25` branch is a defensive guard for unsupported/manual runs so jsdom remains the source of `localStorage` / `sessionStorage` in DOM tests instead of Node's experimental Web Storage globals.

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
- `batch()` — executes each statement's `.all()` and returns array of results
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

Seven issuer dashboards feed HTML-parsing adapters (Circle transparency, Buck transparency, FDUSD, Mento reserve, Reserve (RE) metrics, SG Forge, USDH). Their HTML layout drifts over time, so the fixtures need periodic refreshes to keep tests anchored to today's markup rather than a snapshot from months ago.

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
- `npm run coverage:critical` runs the critical suite owned by `scripts/lib/critical-test-files.mjs` with line-coverage ratchets owned by `scripts/lib/critical-coverage.mjs`.
- `npm run test:critical-contracts` is a targeted local runner for strict endpoint registry, router mapping, cache passthrough, and high-impact API handler checks. It is not a separate validate/merge-gate lane; those gates rely on `coverage:critical` plus the four-shard `test:noncritical` complement.

Lane ownership is script-owned, not prose-owned. Put critical source coverage membership in `scripts/lib/critical-coverage.mjs`; keep `test:noncritical` as the complement generated from that critical coverage test list; and keep targeted contract-runner membership in `scripts/lib/critical-test-files.mjs`. Do not duplicate either file list in this document; use the scripts when you need the live membership.

When adding tests, prefer colocating them near the module under test unless an existing `__tests__/` directory is already the local pattern. If the new test protects a production gate, add it to the relevant npm script rather than only documenting it here.

## Conventions

### What to test

- **Pure `shared/lib/` + `src/lib/` functions** — formatters, supply helpers, classification maps, peg-rate derivation, and frontend derivations. These are the highest-value tests: deterministic, fast, and catch regressions in shared logic.
- **Edge cases** — `NaN`, `Infinity`, `null`, `undefined`, zero, negative values, empty inputs. The existing tests set this standard.
- **Boundary values** — tier boundaries in formatters (e.g., 999 vs 1000 for K suffix).
- **API contract tests** — when a worker handler has multiple response modes (different JSON shapes based on query params), add a contract test for each mode in `worker/src/api/__tests__/`. Use the shared D1 mock from `worker/src/test-helpers/__shared/mock-d1.ts`.
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
- `npm run check:redemption-coverage-audit` validates the Redemption Backstop backlog audit against `scripts/lib/redemption-coverage-audit-baseline.json`, so default-inferred active gaps, total active gaps, and heuristic route counts cannot grow while the backlog is being researched.
- `worker/src/lib/__tests__/redemption-backstops-store.test.ts` now covers completed-run snapshot manifests for `redemption_backstop_runs`, including generation-filtered reads and current/history rows written with `snapshot_run_id`.

### Test style

- Use `describe` per function, `it` per behavior.
- Test names describe the behavior, not the implementation: `"returns 0 for undefined input"` not `"calls sumPegBuckets with undefined"`.
- Use the `mockCoin()` helper (see `supply.test.ts`) for partial `StablecoinData` mocks — avoids `as any` casts.
- Use shared fixtures from `worker/src/test-helpers/__shared/fixtures.ts` for DB row mocks.
- Keep tests focused: one assertion per `it` block when possible.

## Coverage

Full-suite coverage threshold is not enforced; only per-file critical-coverage at 40% gates CI. Run `npm test -- --coverage` to generate a detailed report. The V8 provider generates both text output and an `lcov` report for CI integration.

### Critical Coverage Gate

CI does **not** run a full-suite coverage gate. CI runs the critical-path gate via `npm run coverage:critical`:

- Runs coverage for critical suites only (contract + invariant + targeted reliability suites for alerts/detail/dex orchestrator)
- Parses `coverage/lcov.info`
- Fails CI if any critical file falls below `CRITICAL_COVERAGE_THRESHOLD` (default: 40%, currently pinned to 40 in CI)
- Applies explicit per-file minimums for selected reliability paths (`alerts`, `auth`, `evm-rpc`, `discovery`, `health`, `stablecoin-detail`, `dex-liquidity/orchestrator`, plus the other file-specific overrides in `scripts/ci/check-critical-coverage.mjs`)
- For touched critical files, enforces a no-regression ratchet using `.ci/critical-coverage-baseline.json`
- The weekly `Critical Coverage Ratchet` workflow sets `CRITICAL_COVERAGE_RATCHET_ALL=1` so untouched critical files are checked regularly without making every PR pay that full ratchet cost.
- The local merge gate now passes its changed-file set into `coverage:critical`, so touched critical-file regressions fail locally too

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
- Per-file overrides: `CRITICAL_COVERAGE_THRESHOLD_ALERTS`, `CRITICAL_COVERAGE_THRESHOLD_AUTH`, `CRITICAL_COVERAGE_THRESHOLD_EVM_RPC`, `CRITICAL_COVERAGE_THRESHOLD_STABLECOINS_CACHE`, `CRITICAL_COVERAGE_THRESHOLD_SAFETY_SCORES`, `CRITICAL_COVERAGE_THRESHOLD_SCHEDULED`, `CRITICAL_COVERAGE_THRESHOLD_DAILY_DIGEST`, `CRITICAL_COVERAGE_THRESHOLD_STABLECOIN_DETAIL`, `CRITICAL_COVERAGE_THRESHOLD_DISCOVERY`, `CRITICAL_COVERAGE_THRESHOLD_HEALTH`, `CRITICAL_COVERAGE_THRESHOLD_STATUS`, `CRITICAL_COVERAGE_THRESHOLD_DEX_ORCHESTRATOR`

Selected files have explicit threshold overrides in `scripts/ci/check-critical-coverage.mjs`; keep that map as the source of truth instead of duplicating override values in prose.

### Critical Test Suites

- `npm run test:critical-contracts` is a targeted local runner for the explicitly enumerated contract suites owned by `scripts/lib/critical-test-files.mjs`; keep the npm script as a runner only instead of duplicating suite membership in prose or `package.json`.
- `npm run test:invariants` covers numerical/schema invariants and cache-write validation guards in critical cron paths.
- `npm run test:merge-gate` runs a delta-aware local gate for merged worktree changes. It skips cleanly when no deploy surfaces changed, runs the shared validate core for deploy-impacting diffs, always adds the common postbuild `test:noncritical` (four shards locally to match CI) and `coverage:critical` phase for deploy-impacting diffs, adds `build` + `test:a11y` + `check:feature-flag-inlining` + `seo:check` + `check:phishing-signatures` + `check:classifier-sensitive-copy` plus Pages built-artifact guardrails for Pages-impacting changes, and adds Worker runtime typecheck for worker-impacting changes. It also runs `scripts/ci/check-node-modules-fresh.mjs --strict` before executing a non-dry-run plan, making stale or ambiguous installs fatal while keeping `MERGE_GATE_DRY_RUN=1` usable as a pure planner. Useful controls: `npm run test:merge-gate -- --staged`, `MERGE_GATE_BASE_REF=<ref>`, `MERGE_GATE_HEAD_REF=<ref>`, `MERGE_GATE_FULL_DEPLOY=1`, `MERGE_GATE_DRY_RUN=1`, `MERGE_GATE_PARALLEL=1` (opt into the parallel post-validate matrix; default is serial to avoid local CPU contention; CI always runs the matrix via separate runners), `MERGE_GATE_PRODUCTION_ENV=1` (opt into production Pages env rehearsal after exporting the production `NEXT_PUBLIC_*`, static-export proxy, and API credentials), `MERGE_GATE_PAGES_SMOKE=0` (skip the default Pages serve smoke after build; desktop/local `smoke-ui` otherwise runs with deploy-aligned canary routes/worker count and strict mobile smoke only runs for UI-surface diffs with deploy-aligned canary defaults), `MERGE_GATE_WORKER_SMOKE=1` (opt-in wrangler dev + smoke-api, ~1-2 min; defaults to canary API scope unless `SMOKE_API_SCOPE` is explicitly set), `MERGE_GATE_NO_FETCH=1` (skip the best-effort `git fetch origin main` that keeps the diff base honest), and `MERGE_GATE_NATIVE_ENV=1` (skip the `TZ=UTC` / `LANG=C.UTF-8` / `CI=true` env injection).
- `npm run test:smoke-api` performs HTTP-level smoke checks for `/api/health` plus either every strict contract path (`SMOKE_API_SCOPE=full`, default) mirrored from `shared/lib/api-endpoints/` or a deploy canary subset (`SMOKE_API_SCOPE=canary`). Strict contract drift is guarded by `src/lib/__tests__/api-endpoints.test.ts`, with shape/range assertions, sequential endpoint execution, and bounded retries for transient failures.
- `npm run test:smoke-ops` performs private post-deploy checks against the operator surfaces through Cloudflare Access. For direct `ops-api.pharos.watch` requests, service-token mode sends `CF-Access-Client-Id` / `CF-Access-Client-Secret` and the worker verifies the injected Access JWT there. The independent direct ops API probes start together with the ops UI shell fetch to avoid serializing unrelated network waits. For the same-origin Pages proxy path, the script first attempts to bootstrap an Access session on `ops.pharos.watch`; when a `CF_Authorization` cookie is returned, it starts a best-effort smoke of `https://ops.pharos.watch/api/admin/status` while the direct status check is still in flight. The proxy assertion retries up to two transient `502`/`504` gateway responses to absorb post-deploy warmup on the operator status path, but all other non-auth failures still fail immediately. If the UI host exposes only the interactive Access redirect, if the service-token UI flow renders the shell without yielding a browser session cookie, or if the proxied request remains `401 Unauthorized` after that cookie replay, the script keeps the shell/direct-API assertions and skips the same-origin proxy assertion. `SMOKE_OPS_SCOPE=canary` keeps the UI shell/access, direct `/api/status`, and same-origin `/api/admin/status` checks but skips the slower status-history/admin-list/audit/blacklist dry-run probes used by the default full scope.
- `npm run test:smoke-transport` performs concurrent manual-redirect `HEAD` checks against `http://api.pharos.watch/...` and `http://site-api.pharos.watch/...`, requiring `308` plus an exact `Location` match that preserves host, path, and query while upgrading only to `https`.
- `npm run test:smoke-ui` performs a fast browser smoke check in either local or live mode using the workspace Playwright package directly. Local runs use the Playwright-managed browser by default; GitHub Actions uses the system Chrome channel unless `SMOKE_UI_BROWSER_CHANNEL` or `SMOKE_UI_BROWSER_EXECUTABLE_PATH` overrides it. Homepage/GA checks run once and include the homepage Live Tape same-origin `/_site-data/recent-events?limit=1` contract; overflow checks use the same route source and assertions as before but are chunked across browser contexts (`SMOKE_UI_OVERFLOW_WORKERS`, default `2` local and `1` live, capped at `6`). CI Pages builds set `NEXT_PUBLIC_FORCE_SITE_DATA_PROXY=true` so the local `127.0.0.1` artifact smoke exercises `/_site-data/*` like production. Local mode keeps the full tracked mobile overflow route sweep against the built artifact, while live mode keeps the homepage/GA checks and a narrow mobile canary route set against the real host unless `--skip-overflow` is set. Both modes fail on homepage outage/empty states (`Failed to load data` or `Failed to load this dataset`, `stablecoins:404`, `Data not yet available` or `Waiting for first sync`, `Connection issue` or `Unable to reach the Pharos data API right now.`, `No stablecoin data available`) and on a non-200 or non-JSON recent-events site-data response. Live mode requires successful GA4 `page_view` collect delivery; local mode accepts either successful delivery or a Playwright `net::ERR_ABORTED` report for an issued collect URL with the configured measurement id.
- `npm run test:smoke-ui:mobile` is the strict mobile UI smoke. It covers the mobile-heavy route set by default (`/`, stablecoins, screener, detail, timeline, compare, dependency map, flows, alt-pegs, liquidity, chains, yield, freezewatch, coverage, portfolio, and cemetery) at 360px, 390px, and 414px widths. The desktop spot pass is now opt-in with `--include-desktop` (or `SMOKE_MOBILE_UI_SKIP_DESKTOP=0`). The mobile checks run with bounded parallelism (`SMOKE_MOBILE_UI_WORKERS`, default `2`, max `6`). It fails on framework overlays, document overflow, mobile table geometry/readability regressions, and sub-44px common-control touch targets, while surfacing browser console errors and warnings in the log.

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

**Custom rules** — React Compiler rules are downgraded to warnings since they flag valid patterns that work correctly at runtime:

| Rule                                      | Level | Reason                                                                                       |
| ----------------------------------------- | ----- | -------------------------------------------------------------------------------------------- |
| `react-hooks/preserve-manual-memoization` | warn  | Compiler can't optimize `useMemo([data])` when body accesses `data.current.*` sub-properties |
| `react-hooks/set-state-in-effect`         | warn  | Standard pattern for reading localStorage/sessionStorage on mount                            |
| `react-hooks/purity`                      | warn  | `Date.now()` in render is intentional for timestamp-based UIs                                |
| `react-hooks/incompatible-library`        | warn  | TanStack Virtual `useVirtualizer()` — known library limitation                               |

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
