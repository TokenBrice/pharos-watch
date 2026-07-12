# Deployment Process

> **Agent navigation** — ~41 KB; Grep the heading you need instead of reading wholesale: Purpose · Core Rules · Optional Worktree Flow · Repo Pre-Push Hook · What `test:merge-gate` Does · Yield History Cleanup Windows · CI Deploy Sequence · GitHub Deploy Inputs · Dependency Refresh Cadence · Runtime Measurement Notes · Runtime Origins · Self-Serve API Key Rollback · Failure Policy.

## Purpose

This document defines the production deploy flow and the required local gate before pushing production-impacting work.

## Core Rules

1. Pull requests into `main` run the shared validation gate in GitHub Actions; production deploys still ship from pushes to `main`, while a separate Pages-only rebuild workflow refreshes the static export daily. Manual production deploy dispatch is main-only: choose `main` as the workflow ref, and cancel the run if GitHub was opened on another ref.
2. Agents and routine maintenance default to the current `main` checkout. Do not create a branch, worktree, or PR unless the maintainer explicitly asks for one.
3. Heavy feature/refactor work may use a dedicated worktree branch when the maintainer chooses that workflow. After merging that branch into local `main`, run focused checks and let the pre-push hook execute the authoritative merge gate once.

## Optional Worktree Flow

Use this only when the maintainer explicitly asks for a separate worktree or branch.

1. Create a worktree from `origin/main`.

```bash
git fetch origin
git worktree add ".worktrees/$FEATURE_NAME" -b "$BRANCH_NAME" origin/main
```

2. Implement and test in that worktree branch.
3. Merge the branch into local `main`.

```bash
git checkout main
git pull --ff-only origin main
git merge --no-ff "$BRANCH_NAME"
```

4. Push `main`; the pre-push hook runs the merge gate for the exact pushed range.

```bash
git push origin main
```

## Repo Pre-Push Hook

In the standard npm setup, `package.json` runs `git config core.hooksPath .githooks` via the `prepare` script, so the repo pre-push hook is configured automatically after install. If hooks were disabled or overridden locally, re-enable them with:

```bash
git config core.hooksPath .githooks
```

Hook behavior:

1. Pushes that update `refs/heads/main`: runs `npm run test:merge-gate` against the exact `remote_sha...local_sha` range Git sends to the hook, matching the `github.event.before...github.sha` range used by `.github/workflows/deploy-cloudflare.yml`. Pages smoke is on by default; override with `MERGE_GATE_PAGES_SMOKE=0`.
2. A new remote `main` push, where Git has no previous remote SHA, forces the full local deploy validate path.
3. Other pushes skip the full local gate by default because they cannot deploy production. Set `PHAROS_PRE_PUSH_GATE=all` to opt into exact-range gating for branch pushes.
4. A successful manual gate writes a 24-hour receipt only for a clean committed state. The hook reuses it when the base/head commits, gate implementation, lockfile, Node major, origin, worktree, and validation environment profile still match.
5. Push is blocked on failure. Receipt mismatches fail closed and run the gate normally.

## What `test:merge-gate` Does

`scripts/maintenance/test-merge-gate.mjs` compares `MERGE_GATE_BASE_REF...MERGE_GATE_HEAD_REF` (default `origin/main...HEAD`) and mirrors the deploy-path validate policy locally. The pre-push hook sets those refs from Git's pushed main ref update so the local changed-file set matches the deploy workflow's push classifier.

Default policy:

1. If the diff does not touch Pages or worker deploy surfaces, print the changed-file set and skip the gate.
2. For deploy-impacting diffs, run the shared validate pre-build command set from `scripts/lib/validate-contract.mjs`. That registry is the source of truth for dependency/pricing audits, dependency-coverage drift, lint/typecheck, import boundaries, cycle detection across `shared/`, `worker/src`, and `src`, migrations, cron schedule/connection checks, documentation/generated-artifact checks, env contracts, duplicate exports, redemption-backstop registry checks, CSP/static-header sync, unused code, hotspot ratchets, SQL-safety, stablecoin data validation, and supply-helper usage. The local merge gate path-gates the two network-backed audits: `audit:deps` runs only when package metadata or lockfiles change, and `audit:pricing-providers` runs only when the pricing-provider audit or config changes; scheduled CI still covers fresh advisory/provider drift checks.
3. If Pages-impacting files changed, additionally run:
   - `npm run build` with the same static-export env contract as the production Pages job (`NEXT_PUBLIC_FORCE_SITE_DATA_PROXY=true` and public-dataset/API source env cleared so the prebuild hook preserves already-synced mirrors)
   - `npm run test:a11y`
   - `npm run check:feature-flag-inlining`
   - `npm run seo:check`
   - `npm run check:phishing-signatures`
   - `npm run check:classifier-sensitive-copy`
   - `npm run check:build-size`
   - `npm run check:build-attribution`
4. Always run the shared validate post-build checks:
   - `npm run test:noncritical`
   - `npm run coverage:critical`
5. If worker-impacting files changed, additionally run:
   - `npm run typecheck:worker`
   - `npm run validate:worker-scheduled-smoke`

After `npm run validate:prebuild` succeeds, the local merge gate runs independent build/non-critical-test/critical-coverage/worker-validation groups, **auto-enabling the parallel matrix on machines with ≥12 available cores** and staying serial below that to avoid CPU contention on developer machines; `MERGE_GATE_PARALLEL=1`/`=0` forces either mode. The non-critical Vitest lane is emitted as two `npm run test:noncritical -- --shard=N/2` shards to match the CI fan-out (each shard runs on its own CI runner). This keeps the validation surface aligned with deploy CI while keeping the local default reliable. Before executing a non-dry-run validation plan, the gate runs `scripts/ci/check-node-modules-fresh.mjs --strict`; it fails when `node_modules/` is missing, when the install snapshot is missing, or when `package-lock.json` is newer than `node_modules/`. `MERGE_GATE_DRY_RUN=1` still prints the command plan without requiring `node_modules/`.

Gate builds skip the prebuild artifact regeneration (`GENERATED_ARTIFACTS_SKIP` covering every registry id): the same run's `check:generated-artifacts` already byte-verified the committed artifacts, so regenerating them inside `npm run build` is guaranteed no-op work. The gate also records wall-clock per command and prints a slowest-first timing summary at the end (on failures too); when the total exceeds the soft runtime budget (default 8 minutes, `MERGE_GATE_BUDGET_MINUTES` overrides, `0` disables) it emits a non-fatal warning so runtime regressions surface immediately instead of accreting silently. The fast static-check audit also pulled `check:hook-polling-window`, `check:shared-types-imports`, `check:reserve-fixture-freshness`, `check:site-csp-sync`, and `check:dependency-coverage` into the shared prebuild registry; intentionally skipped: `check:safe-browsing` and `check:telegram-load` (own scheduled workflows). Pages validate lanes cover feature-flag inlining, phishing/classifier scans, build-size, and build-attribution after the static export exists.

For post-swarm or very large local batches, use discovery mode before the final push gate:

```bash
npm run test:merge-gate:discover
```

`scripts/maintenance/run-merge-gate-discovery.mjs` uses the same diff, deploy-surface classifier, command env, node_modules freshness check, and command plan as `test:merge-gate`, but it is optimized for failure discovery rather than release proof. It runs `validate:prebuild` with `VALIDATE_PREBUILD_CONTINUE_ON_ERROR=1`, then keeps independent postbuild groups running after failures so one pass can expose static-check, build/test, coverage, and Worker-validation failures together. Discovery mode skips smoke by default; set `MERGE_GATE_DISCOVERY_SMOKE=1` when smoke failures are the current target, and use `MERGE_GATE_DISCOVERY_MAX_PARALLEL=<n>` to cap local fan-out. Discovery failures block pushing, but discovery success is not sufficient for release: the pre-push hook still runs or reuses the authoritative exact-range gate.

Pages-impacting files now use the same broad matcher as CI deploy classification: any `src/`, `shared/`, `functions/`, `public/`, or `data/` path, selected build/config scripts, shared validate/guardrail infrastructure, and the Pages release workflow files all require local export validation. Worker-impacting files use the same worker/shared/deploy-infra matcher as CI, including Worker operational scripts and shared validate/guardrail infrastructure, but `shared/` is classified by subpath so known Pages-only shared helpers do not request Worker validation or promotion. `test:merge-gate` runs Pages smoke by default for Pages-impacting diffs so the normal local merge gate and pushed ranges rehearse the same pre-publish artifact smoke path as production deploys; Worker smoke remains explicit via `MERGE_GATE_WORKER_SMOKE=1`. When Pages smoke runs, desktop overflow smoke uses the deploy-lane canary routes with 6 workers, and local mobile smoke follows the same UI-impact matcher and canary profile as production deploys.

Useful merge-gate controls:

- `npm run test:merge-gate -- --staged` to diff staged files instead of the default ref range
- `MERGE_GATE_BASE_REF=<ref>` to override the default compare base (`origin/main`)
- `MERGE_GATE_HEAD_REF=<ref>` to override the default compare head (`HEAD`)
- `MERGE_GATE_FULL_DEPLOY=1` to force the full local deploy validate path when there is no usable base ref
- `MERGE_GATE_DRY_RUN=1` to print the command plan without executing it
- `MERGE_GATE_PARALLEL=1`/`=0` to force parallel or serial post-validate execution. The default auto-enables parallel on machines with ≥12 available cores and stays serial below that to avoid local CPU contention; CI always runs the parallel matrix via separate runners
- `npm run test:merge-gate:discover` to run the same local plan in failure-discovery mode before the final authoritative gate
- `MERGE_GATE_DISCOVERY_MAX_PARALLEL=<n>` to cap discovery-mode postbuild fan-out
- `MERGE_GATE_DISCOVERY_SMOKE=1` to include smoke commands in discovery mode; smoke stays on by default only in the final merge gate
- Production Pages environment rehearsal is opt-in: set `MERGE_GATE_PRODUCTION_ENV=1` and export the production `NEXT_PUBLIC_GA_ID`, `NEXT_PUBLIC_PHAROS_*`, `STATIC_EXPORT_API_BASE`, `STATIC_EXPORT_SITE_API_BASE`, `PHAROS_API_KEY` or `STATIC_EXPORT_API_KEY`, and `SITE_API_SHARED_SECRET` values before `npm run test:merge-gate`. With `NEXT_PUBLIC_GA_ID` present, the local Pages smoke expects the same GA measurement ID as the production Pages release smoke. Without that opt-in, the gate clears public production feature-flag env locally while applying the same static-export build contract as CI.
- `MERGE_GATE_PAGES_SMOKE=0` to skip default `npm run validate:pages-smoke` after build for Pages-impacting diffs. By default this serves the static export, runs desktop/local `smoke-ui` on the deploy-lane canary routes with 6 workers, and runs strict mobile smoke only when the changed files hit the same `pages_ui_changed` UI-surface matcher used in deploy (mobile canary defaults mirror deploy — same canary routes, two mobile viewports, desktop pass disabled, 3 workers; desktop and mobile smoke run concurrently against one shared server. The mobile settle is adaptive — network idle plus one stable row/text sample — with `SMOKE_MOBILE_UI_WAIT_MS` as the hard cap: 5000 ms locally because gate runs share the machine with the parallel validate matrix, 1500 ms in the deploy lane on idle runners; the cap only costs time when hydration is actually slow)
- `MERGE_GATE_WORKER_SMOKE=1` to opt in to `npm run validate:worker-smoke` after worker validation for worker-impacting diffs (slow, ~1-2 min). Local worker smoke defaults to `SMOKE_API_SCOPE=canary` unless `SMOKE_API_SCOPE` is explicitly set
- `MERGE_GATE_NO_FETCH=1` to skip the best-effort `git fetch origin main` that keeps the diff base honest (use when offline)
- `MERGE_GATE_NATIVE_ENV=1` to skip the `TZ=UTC` / `LANG=C.UTF-8` / `CI=true` env injection (use when debugging TZ-specific bugs)

## Yield History Cleanup Windows

The tracked savings-wrapper ownership cleanup uses `worker/scripts/yield-history-cleanup.ts` as an operator-run maintenance tool. When that cleanup is part of a release:

1. Deploy the read-path and hourly-purge protections first.
2. Arm the writer pause guard.
3. Verify `sync-yield-data` is not actively leased.
4. Export the targeted parent/source rows.
5. Rehearse the delete + restore drill on a local throwaway SQLite dataset.
6. Run the bounded production cleanup only after the restore drill passes.
7. Verify the parent/source rows stay absent after the next hourly writer cycle.

## CI Deploy Sequence

Defined across:

- `.github/workflows/validate-ci.yml` for the shared validate gate
- `.github/workflows/critical-coverage-ratchet.yml` for the weekly/manual all-critical coverage ratchet
- `.github/workflows/dependency-audit.yml` for the scheduled full dependency audit
- `.github/workflows/pull-request-checks.yml` for pull-request validation on `main`, including a pinned gitleaks scan (`v8.30.0`, SHA256-verified) over the PR commit range (`--log-opts="--no-merges <base>..<head>"`); full-history scans still run weekly via `.github/workflows/secret-scan.yml`
- `.github/workflows/pharos-change-contract.yml` for the pull-request deploy-surface contract summary
- `.github/workflows/deploy-cloudflare.yml` for push/manual production deploys that reuse the same validate gate
- `.github/workflows/pages-release.yml` for the consolidated Pages build/local-smoke/publish/live-smoke path
- `.github/workflows/rebuild-pages.yml` for the scheduled/manual Pages-only rebuild path
- `.github/workflows/og-refresh.yml` for scheduled (weekly Monday, cron `23 4 * * 1`) and manual refresh of checked-in OG image artifacts
- `.github/workflows/zizmor.yml` for GitHub Actions workflow security scanning into Code Scanning

Deploy sequence in `.github/workflows/deploy-cloudflare.yml`:

1. `detect-changes`
   - diffs `github.event.before...github.sha` on `push` (three-dot, merge-base-resolved; identical to two-dot on push-to-main but robust if the base is ever not a strict ancestor)
   - emits `deploy_required`, `worker_changed`, `worker_promotion_required`, `pages_changed`, and `pages_ui_changed`
   - decides separately whether Worker validation, Worker production promotion, and Pages deploy work are actually required for that push
   - treats Pages release workflow changes (`.github/workflows/pages-release.yml`, `.github/workflows/rebuild-pages.yml`) as Pages-impacting so workflow-only changes still rehearse the Pages path
   - keeps `worker_changed=true` broad for Worker validation/guardrail coverage, but classifies `shared/` by subpath so known Pages-only helpers skip Worker validation; only sets `worker_promotion_required=true` for deployed Worker runtime/config, D1 migrations, Worker assets, shared runtime files, and root package/lock changes that can change the production Worker bundle
   - keeps `pages_ui_changed=true` narrower than `pages_changed`; it only flips on for likely frontend/runtime-impacting surfaces (`src/`, `public/`, `shared/`, `functions/`, `data/`, root package/lock, and `next.config.ts`) so strict mobile smoke can be skipped on deploy-infra-only Pages diffs
   - defaults to the full deploy path on `workflow_dispatch`; manual production dispatch must target the `main` ref
2. `validate`
   - runs only when `deploy_required=true`
   - always includes `npm run audit:deps`, `npm run audit:pricing-providers`, `npm run check:provider-resilience`, `npm run check:dependency-coverage`, lint, policy/guardrail checks (including verified-doc link and env-contract validation), `npm run test:noncritical`, and `npm run coverage:critical`
   - includes `npm run build`, `npm run test:a11y`, `npm run check:feature-flag-inlining`, `npm run seo:check`, `npm run check:phishing-signatures`, `npm run check:classifier-sensitive-copy`, `npm run check:build-size`, and `npm run check:build-attribution` only when `pages_changed=true` (pull-request validation only; the push/manual production deploy path runs Pages build/SEO/static-export guardrails inside `pages-release`, not the validate gate)
   - includes `npm run typecheck:worker` and `npm run validate:worker-scheduled-smoke` only when `worker_changed=true`
   - CI runs `validate-prebuild`, `pages-build`, `test-noncritical`, `coverage-critical`, and `typecheck-worker` as independent parallel GitHub jobs, with the aggregate `validate` job waiting on all of them; the `typecheck-worker` job also runs `npm run validate:worker-scheduled-smoke` after the Worker typecheck. `npm run build` still precedes `npm run seo:check` and the built-artifact classifier guardrails inside `pages-build`. The local merge gate provides the equivalent coverage through `scripts/maintenance/test-merge-gate.mjs`, which uses `buildCommandPlan` to construct a per-trigger execution plan and defaults to serial post-prebuild execution; set `MERGE_GATE_PARALLEL=1` to opt into local fan-out.
   - installs Node 24.16.0 through the shared workspace setup action, matching the primary repo baseline; pull-request checks also run a non-blocking Node 26 proof lane because the engine range allows Node 26
   - pull requests call the same reusable workflow with diff-derived `pages_changed` and `worker_changed` inputs, so PR Pages build/SEO and Worker validation coverage follows the deploy-surface classifier while the shared non-deploy guardrails and tests still run on every PR
3. `no-deploy-required`
   - runs only when `deploy_required=false`
   - records an explicit no-op outcome for docs-only or other non-deploy pushes to `main`
4. `deploy-worker`
   - split into early non-mutating candidate preparation and gated production promotion:
     - `upload-worker-version` captures the currently live production version ID and uploads the candidate with the lockfile-installed Wrangler CLI (`npx --no-install wrangler ...`) only after `detect-changes` confirms Worker promotion is required and the aggregate `validate / validate` job has succeeded. This keeps Cloudflare credentials and Worker-version mutation behind the validation gate while still using the shared `setup-workspace` install path so upload and deploy run against the same dependency graph. If Cloudflare returns `entitlements.not_available [code: 10007]` for Workers Versions, the prep lane records `version_upload_unavailable=true` instead of failing and the deploy summary calls out the reduced rollback safety of the legacy fallback.
     - `deploy-worker` waits for the aggregate `validate / validate` job, reruns `npm run check:migrations`, fails closed before production D1 mutation when Worker Versions are available but no previous production version was captured, applies D1 migrations via `cd worker && npx --no-install wrangler d1 migrations apply stablecoin-db --remote`, runs deploy-canary `smoke-api` checks against the uploaded preview URL with `SMOKE_API_KEY` when Workers Versions are available, and then promotes that exact preview-smoked version through the Cloudflare Workers Deployments API (`POST /workers/scripts/<name>/deployments`) without asking Wrangler to sync non-versioned script settings during promotion. When the account lacks Workers Versions entitlement, `deploy-worker` uses the legacy `cd worker && npx --no-install wrangler deploy` fallback after the same validation and migration gates.
   - runs `cd worker && npx --no-install wrangler triggers deploy` after promotion to explicitly sync cron/routes/domain triggers and other non-versioned trigger settings
   - keeps Worker candidate upload, remote D1 apply, and production promotion behind the aggregate validation result, with `check:migrations` still rerun immediately before remote D1 mutation
   - relies on the `check:migrations` rollout-safety contract for new migrations: standard deploy only supports backward-compatible D1 changes because the old worker can still receive traffic until the promoted version is live
   - runs production `npm run test:smoke-api` in the same job after promotion; on worker-only deploys, it then runs live UI, ops, and transport smokes before the rollback decision. Trigger-sync, production API smoke, or worker-only live-smoke failure automatically rolls back to the captured previous Worker version on the Workers Versions path. The legacy fallback cannot automatically re-promote a preview-smoked version, so it still fails visibly on post-deploy smoke failure and requires operator-led rollback from Cloudflare deployment history.
   - skipped on Pages-only, validation-only, or non-deploy `push` events where `detect-changes` reports `worker_promotion_required=false`
5. `pages-release`
   - production deploy job in `.github/workflows/deploy-cloudflare.yml`
   - runs only when `detect-changes` reports `pages_changed=true`
   - starts after Pages changes are detected and the aggregate `validate / validate` job succeeds (no hard dependency on `upload-worker-version`)
   - uses the configured target API base (`vars.SMOKE_API_BASE_URL || vars.API_BASE_URL`) for digest sync, depeg-event sync, public dataset generation, and local `/_site-data/*` proxying
   - executes the Pages build/local-smoke/publish path in one job:
   - fetches `/api/digest-archive` once from the selected API environment into `data/digests.json`, fetches confirmed depeg events into `data/depeg-events.json`, generates `public/datasets/*` and `public/sheets/*` from the same API environment, sends `DIGEST_API_KEY` from GitHub repository secrets with dedicated `DEPEG_EVENTS_API_KEY` / `PUBLIC_DATASETS_API_KEY` overrides when present, and forwards `NEXT_PUBLIC_GA_ID` plus `NEXT_PUBLIC_PHAROS_*` repo variables into `npm run build`; the build step clears the public-dataset fetch env so the prebuild hook preserves those synced mirrors instead of re-fetching, and depeg event SSG is bounded to the newest indexable archive entries plus pinned authored incidents so full production history cannot breach the Cloudflare Pages direct-upload file cap. Pages CI builds also set `NEXT_PUBLIC_FORCE_SITE_DATA_PROXY=true` so the local `127.0.0.1` artifact smoke uses the production `/_site-data/*` browser lane. The job then runs `npm run check:feature-flag-inlining`, `npm run check:phishing-signatures`, `npm run check:classifier-sensitive-copy`, `npm run check:build-size`, and `npm run check:build-attribution`, serves the same local artifact with `npm run serve:static-export`, proxies direct `/api/*` calls to the selected public API base, proxies `/_site-data/*` to the CI-provided `STATIC_EXPORT_SITE_API_BASE` worker target and injects `SITE_API_SHARED_SECRET` for that hop, runs bare `npm run test:a11y` in parallel with `seo:check`, local artifact UI/mobile smoke, and Yield deep-route asset coherence smoke, then runs `npm run test:a11y:hydrated` against the API-backed export before publish. Live smoke requires GA4 `page_view` collect delivery; local artifact smoke accepts either successful delivery or a Playwright `net::ERR_ABORTED` report for an issued collect URL with the configured measurement id.
   - limits per-coin yield workbench SSG to intrinsic yield coins and curated deterministic lending overrides. Known coins outside that durable set redirect to filtered `/yield/`, restoring more than 25% direct-upload file headroom without leaving runtime lending discoveries at dead links.
   - the local static-export server treats exact `/api` and `/api/` as the public API access page, serves checked-in/static route payload artifacts below `/api/` when present, proxies endpoint-like `/api/*` requests including JSON `POST` bodies to the selected public API base, and mirrors the production Pages Function redirect for intentionally omitted known-coin Yield workbenches
   - catch-all document responses use `max-age=0, must-revalidate`; deploy-versioned HTML has no shared-cache lifetime or stale-while-revalidate window that can outlive its referenced Next.js chunks. Hashed `/_next/static/*` assets retain their one-year immutable policy through the more-specific header rule.
   - uses `SMOKE_UI_BROWSER_CHANNEL=chrome`, deploy-lane canary `SMOKE_UI_OVERFLOW_ROUTES`, and `SMOKE_UI_OVERFLOW_WORKERS=6` for local smoke to keep representative overflow coverage while reducing release critical-path time
   - runs `test:smoke-pages-assets` locally and after publish. It derives the current top 25 Yield ranking IDs, adds fixed native, linked-wrapper, lending, rate-derived, and structured canaries, checks every HTML-referenced first-party script for HTTP/MIME integrity, and rejects first-party script/style/font failures, `ChunkLoadError`, hydration errors, or the stablecoin error boundary. USDC and USDT receive a second warm-cache browser pass.
   - runs `test:smoke-ui:mobile` only when `pages_ui_changed=true`, and uses a canary scope in production deploys (`SMOKE_MOBILE_UI_ROUTES` limited route list, two mobile viewports, desktop pass disabled, `SMOKE_MOBILE_UI_WORKERS=3`, adaptive settle capped by `SMOKE_MOBILE_UI_WAIT_MS=1500`) to keep strict mobile coverage while reducing release critical-path runtime
   - waits for the aggregate `validate / validate` job before Cloudflare Pages production publish, and on combined Worker + Pages deploys also waits for `deploy-worker` to finish successfully before publishing Pages. When that worker-promotion gate is enabled, `pages-release` reruns local artifact `smoke-ui` against the same served `out/` export after the Worker has been promoted and before `deploy-pages`.
   - writes a Pages release summary after `check:build-size` with the total output file count, static export size, and depeg-event static page count, then captures the current Cloudflare Pages production deployment id as the required rollback target; if that id cannot be captured, the job fails before publishing so a broken deploy cannot be left live without an automated rollback target. With rollback armed, it publishes the already verified local artifact through Wrangler with the existing retry loop, and runs live public UI, Yield asset, ops, and transport smokes concurrently in one post-publish step while still emitting per-smoke status outputs in the summary; the live public UI check keeps the broad overflow sweep on the exact local artifact before publish, then runs homepage data-state, the Live Tape `/_site-data/events` contract, and a narrow live `/depeg/` canary for the default-on DDR/DDRQ data contract
   - requires ten consecutive target-SHA release-marker responses per public/ops host before live smoke, resetting the convergence counter on any regression, then retries the complete live Yield asset-coherence suite up to ten times with nine 30-second intervals (a four-and-a-half-minute bounded convergence window). This accommodates custom-domain edges that continue serving older deep-route HTML after the marker has converged, before every referenced immutable chunk is available. Every attempt retains the full HTTP, MIME, hydration, and runtime assertions, and persistent failure remains fatal
   - calls `scripts/maintenance/rollback-pages-deployment.mjs` when `deploy-pages` succeeded but any fatal post-publish smoke (live public UI, Yield asset coherence after its bounded retries, ops, or transport) failed; the overall workflow still surfaces as failed so the incident is visible
6. `smoke-ui-live`
   - worker-only deploy path runs inside `deploy-worker` after production API smoke
   - Pages-including deploy path runs inside `pages-release` after `deploy-pages`
   - verifies the live Pages frontend works against the production API, including expected GA runtime initialization when configured
7. `smoke-pages-assets`
   - runs against the exact local artifact before publish and against the public host after the release marker propagates
   - validates representative Yield deep routes, their HTML cache contract, every referenced first-party script response, browser-loaded script/style/font status and MIME, fresh-browser runtime integrity, and warm-cache USDC/USDT behavior
   - uses `SMOKE_API_KEY` only to discover the current top 25 ranked IDs from the protected public rankings API; the browser still exercises normal public page data transport
   - fails the shared post-publish step and arms automated Pages rollback on any coherence error
8. `smoke-ops`
   - private post-deploy ops smoke against `ops.pharos.watch/admin/` and `ops-api.pharos.watch`
   - runs inside `pages-release` after `deploy-pages` on Pages-including deploys, or inside `deploy-worker` on worker-only deploys
   - for Pages-including deploys, runs inside the shared parallel post-publish smoke step alongside live UI and transport checks, with its own status emitted to step outputs and the summary table
   - requires repository secrets `OPS_SMOKE_CF_ACCESS_CLIENT_ID` and `OPS_SMOKE_CF_ACCESS_CLIENT_SECRET`
   - UI check accepts either an Access redirect or a token-backed HTML response, so CI does not depend on the UI app also granting `Service Auth`
   - same-origin `ops.pharos.watch/api/admin/status` starts as soon as the UI Access cookie is available and retries transient `502`/`504` gateway responses up to twice to absorb operator-status warmup immediately after promotion, but persistent proxy failures still fail the deploy
   - production deploys use `SMOKE_OPS_SCOPE=canary` to keep ops shell/access plus direct and same-origin status checks on the critical path; the default full scope still covers slower status-history, admin-list, audit, and blacklist dry-run probes when run manually

9. `smoke-transport`
   - runs after the same production-changing gates as `smoke-ops`
   - runs `npm run test:smoke-transport`
   - verifies `http://api.pharos.watch/...` and `http://site-api.pharos.watch/...` return `308` with a scheme-only upgrade before any application auth or worker logic responds
   - intentionally fails the workflow on redirect regressions once the zone-level transport rule is configured

Separate from the deploy path, `.github/workflows/dependency-audit.yml` runs `npm audit --audit-level=high` on the full lockfile weekly and on manual dispatch so devDependency advisories are surfaced without turning them into a blocking production deploy gate.

## GitHub Deploy Inputs

Repository secrets required by the production deploy path:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `SMOKE_API_KEY`
- `DIGEST_API_KEY`
- `SITE_API_SHARED_SECRET`
- `OPS_SMOKE_CF_ACCESS_CLIENT_ID`
- `OPS_SMOKE_CF_ACCESS_CLIENT_SECRET`

Optional dedicated Pages data-sync secrets:

- `DEPEG_EVENTS_API_KEY` (falls back to `DIGEST_API_KEY`)
- `PUBLIC_DATASETS_API_KEY` (falls back to `DIGEST_API_KEY`)

Optional GitHub Actions checkout fallback:

- `ACTIONS_CHECKOUT_TOKEN` — a repo-scoped read token used by production deploy checkout steps only when the default `github.token` fetch path is rejected by GitHub. Push/manual production deploys pass this optional secret into `pages-release`; the reusable Pages workflow falls back to `github.token` when the secret is absent. Scheduled/manual `rebuild-pages.yml` calls do not pass the fallback token today and use the default `github.token` checkout path.

Scheduled artifact PR secret:

- `OG_REFRESH_GITHUB_TOKEN` — a bot or PAT token used by `.github/workflows/og-refresh.yml` to push `automated/og-refresh` and open checked PRs. The workflow fails closed when this secret is absent and OG screenshots have changed, because PRs created with the default `GITHUB_TOKEN` do not trigger the normal pull-request workflows. When `npm run og:capture` produces no image diff, the workflow completes without requiring the secret.

Repository variables:

- Required: `API_BASE_URL`
- Optional: `SMOKE_API_BASE_URL`, `SMOKE_OPS_UI_URL`, `SMOKE_OPS_API_BASE`, `NEXT_PUBLIC_GA_ID`, `NEXT_PUBLIC_PHAROS_*`, `CI_VALIDATE_RUNNER`, `CI_WORKER_DEPLOY_RUNNER`

Scheduled monitor secrets:

- `GOOGLE_SAFE_BROWSING_API_KEY` for `.github/workflows/safe-browsing-monitor.yml`

`SMOKE_API_KEY` is required because the smoke suite exercises protected public API routes on `api.pharos.watch`, and those non-exempt `/api/*` routes require a valid `X-API-Key`.

## Dependency Refresh Cadence

Use dependency maintenance as a dedicated routine, not as incidental churn inside larger refactors.

1. First full week of each month:
   - land one bounded patch/minor refresh tranche from the root lockfile
   - keep root testing/tooling and worker infrastructure cohorts separate so rollback stays targeted
2. Weekly:
   - review `.github/workflows/dependency-audit.yml` output
   - treat high/critical vulnerabilities as blocking until fixed, pinned away, or explicitly risk-accepted
   - treat non-blocking staleness as advisory input for the next monthly patch/minor tranche
3. Once per quarter, or earlier when upstream support windows force it:
   - run a dedicated major-upgrade spike for framework/tooling majors
   - do not combine those majors with hotspot refactors, methodology changes, or deploy-surface behavior changes

Current explicitly deferred major cohort:

- `eslint@10` — next review: 2026-08-15
- `@types/node@25` — next review: 2026-08-15
- `typescript@6` — next review: 2026-08-15

Current risk-accepted transitive advisories (triage reference for the weekly `dependency-audit.yml` run):

None as of 2026-06-26. The production-scope gate is `npm run audit:deps` (`npm audit --audit-level=high --omit=dev`), which runs in the deploy `validate` set and reflects the deployed surface (a static Pages export plus the Worker runtime). The weekly `dependency-audit.yml` job deliberately runs the broader `npm audit --audit-level=high` over the full lockfile (dev + build chain) as advisory input and is expected to stay green.

When the weekly job finds a new high/critical full-lockfile advisory, fix it, pin it away, or document the reviewed unreachable/dev-only risk acceptance here before treating the red job as accepted. Do not run `npm audit fix --force` outside a dedicated dependency tranche; forced fixes can downgrade or cross major lines.

Scheduled/manual Pages rebuild sequence in `.github/workflows/rebuild-pages.yml`:

Schedule: `10 8 * * *` and `25 8 * * *` UTC. The first slot follows the 08:05 UTC daily digest cron closely; the second is a catch-up for slower digest generation or a missed GitHub schedule tick.

1. `pages-release`
   - reuses the same consolidated `.github/workflows/pages-release.yml` job as push/manual production deploys
   - fetches data, builds, runs `test:a11y`, local SEO/UI/mobile smoke, hydrated a11y, publishes, and runs post-publish live public-host, ops, and transport smokes in that one reusable job

This workflow intentionally skips `validate`, `deploy-worker`, and `smoke-api`; it exists to refresh the Pages export after digest, depeg-event, and public-dataset sync without redeploying unchanged worker code. It still runs the ops and transport post-deploy smoke lanes so custom-domain regressions fail visibly.

GitHub-owned JS actions in this workflow are pinned by full commit SHA. When bumping an action version, resolve the tag against the upstream action repo and pin that real commit SHA, not an unavailable tarball or transient hash.

### Wrangler and Workspace Layout

- Cloudflare deployment intentionally uses the local Wrangler CLI instead of `cloudflare/wrangler-action`.
- Production custom-domain `routes` remain root-owned before the first `[[rules]]` table, and asset rules explicitly set `fallthrough = true`. `npm run check:worker-config` blocks releases when TOML table ownership or the three-domain contract drifts.
- The repo uses a root npm workspace, so the workflows install the shared toolchain from the root `package-lock.json` and run Wrangler from the `worker` workspace with `npx --no-install`, keeping worker deploys insulated from GitHub Actions runtime deprecations in third-party JS actions.
- Worker production releases prefer Wrangler Versions plus Preview URLs: CI uploads a candidate version early, captures the current production version as the required rollback target, waits for validation before D1 mutation, smokes that preview inside `deploy-worker`, then promotes that exact version to production traffic through the Cloudflare Workers Deployments API. If the previous version cannot be captured while Worker Versions are available, the workflow stops before production D1 mutation or promotion. If Cloudflare rejects Workers Versions with `entitlements.not_available [code: 10007]`, CI falls back to `wrangler deploy` after the same validation and migration gates and keeps the production smoke as the deployment proof; this legacy fallback has reduced rollback safety and any failure requires operator-led Worker rollback from Cloudflare deployment history.
- The validate and Pages release lanes restore `.next/cache`, `.cache/eslint`, and `*.tsbuildinfo` outputs so unchanged build/lint/typecheck work can be reused across runs.
- The repo engine floor is Node 24 LTS for the primary local/runtime baseline, with CI and `.nvmrc` pinned to Node 24.16.0. `package.json#engines.node` allows Node 26, and pull-request checks run a non-blocking Node 26 typecheck proof lane.

### Failure Stop and Surface Classification

- Deployment stops on the first failed job.
- Pull requests run the shared validate gate with the same deploy-surface classifier used by push deploys: shared guardrails and the full deploy test surface always run, while Pages build/SEO and Worker validation run only when the PR diff touches those surfaces.
- Push/manual deploy validation skips Pages build/SEO on worker-only pushes, skips Worker validation on Pages-only pushes, and skips the production workflow entirely for non-deploy pushes.

### Validate Lane Fan-out and Deploy Ordering

- The Node 24.16.0 validate lane starts `validate:prebuild`, non-critical-test shards, critical coverage, and conditional Worker validation as independent jobs, then uses the aggregate `validate / validate` job to require every needed result. The pull-request Node 26 proof lane is separate and non-blocking; failures there should be triaged before widening Node-dependent behavior.
- Worker candidate upload waits for the aggregate `validate / validate` result before any Cloudflare-secret-bearing preparation. The `pages-release` job also has a `needs: validate` edge in `.github/workflows/deploy-cloudflare.yml`; the reusable workflow still keeps its internal "Wait for validation gate" step (`wait_for_validate_job`) as defense in depth for manual or non-standard callers before anything publishes.
- Production D1 mutation and Worker promotion remain behind the aggregate `validate / validate` result; Pages publish also waits for validation and, on combined deploys, successful Worker promotion.

### Pages Path Behavior

- The production Pages path fetches digests, depeg events, and public dataset mirrors once inside `pages-release` and requires a11y plus local `smoke-ui` gates before `deploy-pages`, so a bad static export is blocked before Cloudflare Pages production publish. The build step clears the public-dataset source env before `npm run build`, so the prebuild hook uses the already synced mirrors and the build itself no longer depends on mutable static input endpoints. The local artifact is built with `NEXT_PUBLIC_FORCE_SITE_DATA_PROXY=true` so browser reads go through `/_site-data/*` instead of the protected direct `/api/*` lane while the smoke server runs on `127.0.0.1`. `check:feature-flag-inlining` verifies configured `NEXT_PUBLIC_PHAROS_*` flags were statically inlined after build, and `check:build-size` enforces Cloudflare Pages' 20,000-file direct-upload cap before Wrangler deploys the artifact. Pages deploy retries use six attempts with increasing backoff because Cloudflare Pages asset uploads can return transient 500/no-healthy-upstream responses.
- On combined Worker-promotion + Pages deploys, the prepublish Pages path starts after validation and can overlap with the gated Worker release path using the configured target API base.
- After publish, `pages-release` runs live public UI, ops canary, and transport smokes concurrently inside one post-publish step, then writes a Markdown summary with per-smoke outcomes. The homepage/GA/data-state live public-host smoke targets `https://pharos.watch`, the live route canary includes `/depeg/`, and the broader overflow sweep remains on the local artifact smoke. The live GA smoke allows one reload retry only when the first browser context sees no analytics runtime or GA/GTM network evidence and no analytics-specific CSP violation, so Pages propagation gaps do not mask concrete analytics failures while unrelated first-party CSP events do not suppress the retry.
- The production ops smoke runs in canary scope on the deploy critical path, keeping shell/access and status coverage while leaving the slower deep admin probes for explicit full smoke runs.

### Skip Rules

- On `push`, Worker deploy and API smoke are skipped entirely when the diff does not touch deployed Worker runtime/config, D1 migrations, Worker assets, Worker-consumed shared runtime files, or root package/lock entries that can affect the Worker bundle, even if broader Worker validation still runs for package/tooling changes. Known Pages-only shared helpers are excluded from Worker validation and promotion by `scripts/lib/automation-registry.mjs`.
- Pages build/deploy are skipped entirely when the diff does not touch Pages-impacting paths (`src/`, `shared/`, `functions/`, `public/`, `data/`, selected build/config scripts, shared validate/guardrail infrastructure, or Pages/deploy workflow files).
- Even when `pages_changed=true`, strict local mobile canary smoke is skipped when `pages_ui_changed=false` (for example deploy-workflow-only or other non-UI Pages-surface diffs).

### Concurrency and Rollback Scope

- Both production-changing workflows share one global `concurrency` group (`production-deploy`): push/manual deploys and Pages rebuilds queue behind any active production deploy instead of canceling or overlapping post-promotion smoke or rollback work. Manual production dispatches are guarded to `refs/heads/main`.
- The worker release path applies D1 migrations before preview smoke and production promotion, so the normal path explicitly supports only backward-compatible D1 migrations; the release runner reruns `check:migrations` immediately before remote apply, writes the replayed schema fingerprint to the job summary for drift triage, and still requires a separate coordinated rollout for destructive cleanup after the new worker code is serving.
- Automatic worker rollback changes traffic back to the previous Worker version when Workers Versions are available; missing previous-version capture fails closed before production mutation. Before promotion, the workflow captures the previous `worker/wrangler.toml` when the push base exists; if trigger sync, production API smoke, or worker-only live smokes fail, it also attempts `wrangler triggers deploy --config .rollback-wrangler.toml` to restore non-versioned route/domain/cron trigger settings. D1 schema/data rollback remains a separate D1 recovery step.

## Runtime Measurement Notes

When reviewing deploy runtime after optimization work, separate queue time from job execution time because the shared `production-deploy` concurrency group can make a healthy run appear slow while it waits for another production-changing workflow. Compare like-for-like paths: combined worker + Pages deploys, worker-only deploys, Pages-only deploys, and scheduled Pages rebuilds have different expected critical paths.

For combined deploys, `pages-release` starts after the aggregate validation result, then waits for successful Worker promotion before publishing Pages when `wait_for_worker_promotion` is enabled. This keeps both Pages build/smoke scripts and Cloudflare publish actions behind validation while preserving Worker/Pages coordination; the consolidated Pages job reruns local artifact `smoke-ui` after worker promotion and before publishing Pages.

Tooling cache restores are best-effort acceleration for `.next/cache`, `.cache/eslint`, and TypeScript build info. Cold-cache runs should remain valid and may be slower; investigate cache behavior only when repeated warm-cache deploys fail to reuse unchanged build, lint, or typecheck work. Only jobs that produce new tooling state upload a fresh cache (`tooling-cache-save: "true"` on validate-prebuild, pages-build, and pages-release); restore-only jobs use a deterministic key whose exact hit suppresses the post-job save, protecting the repo's 10 GB cache quota from per-run churn. The pages-release Chromium install runs without `--with-deps` (the binary restores from cache and GitHub's Ubuntu runners carry the system libraries); if a runner-image change ever drops a library, the browser launch fails loudly before anything publishes — re-add the flag then.

## Runtime Origins

The current origin split is:

- public UI: `pharos.watch`
- website data API target: `site-api.pharos.watch` in production; preview/local rehearsal may intentionally point the Pages proxy at `api.pharos.watch`
- operator UI: `ops.pharos.watch`
- public API: `api.pharos.watch`
- operator API: `ops-api.pharos.watch`

The browser-facing website data lane is same-origin `/_site-data/*` on the Pages project. Every Pages host uses `SITE_API_SHARED_SECRET` only with the exact HTTPS `SITE_API_ORIGIN=https://site-api.pharos.watch`; invalid or foreign origins fail closed before the secret is attached. The lane gates inbound `Origin` / `Referer`, preserves upstream cache age without adding a Pages Cache API lifetime, and consumes bounded response bodies inside the proxy deadline. The selector-snapshot Pages Function uses those same bindings server-side to recompute share artifacts from schema-validated canonical sources; missing or failing source access makes snapshot creation fail closed. Binding `DB` enables proxy-outcome attribution and is required for selector daily quotas; `SELECTOR_SNAPSHOT_IP_HASH_SECRET` is also required for privacy-preserving selector rate keys. Worker route declarations for `site-api.pharos.watch` and `ops-api.pharos.watch` live in `worker/wrangler.toml` and deploy with the normal Worker job. The Pages custom domains plus Cloudflare Access applications for the ops surfaces are account-side setup and are documented in [operator-origin-access.md](./operator-origin-access.md).

The public self-serve API-key form is not a production Pages proxy route. On `pharos.watch`, `/api/` is the static form page and its browser requests go cross-origin to `https://api.pharos.watch/api/api-key-requests` and `/api/api-key-requests/verify`; CORS must allow JSON `POST` from `https://pharos.watch`. Local static-export smoke uses a proxy for endpoint-like `/api/*` only so the built artifact can be rehearsed without a deployed Pages Function.

## Self-Serve API Key Rollback

For an incident isolated to public self-serve key issuance:

1. Enable or tighten the exact-path WAF rule `api-self-serve-key-intake-limit` for `POST /api/api-key-requests` and `POST /api/api-key-requests/verify`; do not block `/api/api-key-requests-admin*`.
2. Hide or disable the `/api/` form in Pages if the incident is not resolved by edge blocking.
3. Roll back Worker or Pages through the normal deployment rollback path as needed.
4. Query self-serve keys created after the incident cutoff, deactivate incident or smoke keys, release associated claims through the Access-gated admin route, and verify matching audit rows.
5. Check Worker logs, email-provider logs, and Cloudflare Security Events for plaintext API keys, raw verification tokens, raw IP addresses, or provider-echoed requester data.

The WAF expression of record is:

```text
(http.host eq "api.pharos.watch"
  and http.request.method eq "POST"
  and (http.request.uri.path eq "/api/api-key-requests"
    or http.request.uri.path eq "/api/api-key-requests/verify")
  and not cf.bot_management.verified_bot)
```

Record the Cloudflare rule ID from Security -> WAF -> Rate limiting rules in the incident note when the rule is created or edited, then verify matches under Security -> Events filtered by that rule ID.

Use these SQL templates from a trusted operator shell. Set `cutoff_epoch` to the first suspect issuance timestamp.

```bash
cutoff_epoch=1778500000
db_name=stablecoin-db

# Dry-run: list self-serve keys issued after cutoff.
npx wrangler d1 execute "$db_name" --remote --command "
SELECT k.id, k.key_prefix, k.owner_email, k.is_active, k.expires_at, k.created_at, r.request_id, r.status
FROM api_keys k
LEFT JOIN api_key_requests r ON r.api_key_id = k.id
WHERE k.tier = 'self-serve' AND k.created_at >= $cutoff_epoch
ORDER BY k.created_at DESC;
"

# Deactivate post-cutoff self-serve keys.
npx wrangler d1 execute "$db_name" --remote --command "
UPDATE api_keys
SET is_active = 0, updated_at = strftime('%s','now')
WHERE tier = 'self-serve' AND created_at >= $cutoff_epoch;
"

# Release claims only after their linked key is inactive or absent.
npx wrangler d1 execute "$db_name" --remote --command "
UPDATE api_key_self_serve_email_claims
SET status = 'released', released_at = strftime('%s','now'), updated_at = strftime('%s','now')
WHERE status IN ('pending_verification', 'issued')
  AND request_id IN (
    SELECT r.request_id
    FROM api_key_requests r
    LEFT JOIN api_keys k ON k.id = r.api_key_id
    WHERE r.created_at >= $cutoff_epoch
      AND (k.id IS NULL OR k.is_active = 0)
  );
"

# Mark affected request rows blocked for operator visibility.
npx wrangler d1 execute "$db_name" --remote --command "
UPDATE api_key_requests
SET status = 'blocked', verification_token_hash = NULL, issuance_locked_at = NULL, updated_at = strftime('%s','now')
WHERE created_at >= $cutoff_epoch
  AND status IN ('pending_verification', 'issued');
"

# Consistency check: active key linked to blocked/rejected/expired request.
npx wrangler d1 execute "$db_name" --remote --command "
SELECT r.request_id, r.status, k.id, k.key_prefix, k.is_active
FROM api_key_requests r
JOIN api_keys k ON k.id = r.api_key_id
WHERE k.tier = 'self-serve'
  AND k.is_active = 1
  AND r.status IN ('blocked', 'rejected', 'expired');
"

# Consistency check: pending claims without request rows.
npx wrangler d1 execute "$db_name" --remote --command "
SELECT c.email_hash, c.request_id, c.status, c.claimed_at
FROM api_key_self_serve_email_claims c
LEFT JOIN api_key_requests r ON r.request_id = c.request_id
WHERE c.status = 'pending_verification' AND r.request_id IS NULL;
"
```

Production smoke for this surface should request a smoke key, receive the email, verify once, confirm verification-token reuse fails, confirm the admin queue/key/claim/audit state through `ops-api`, then deactivate the smoke key and release its claim.

## Failure Policy

If `test:merge-gate` fails:

1. Do not push `main`.
2. For a small change, fix the failing command directly. For a large merged batch or repeated fail-fast loop, run `npm run test:merge-gate:discover` to collect more failing lanes in one pass.
3. Re-run the narrow failing command(s) until clean.
4. Re-run `npm run test:merge-gate`.
5. Push only after passing.
