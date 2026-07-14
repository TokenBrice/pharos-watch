# Deployment Process

> **Agent navigation** — Grep the heading you need instead of reading wholesale: Purpose · Core Rules · Optional Worktree Flow · Repo Pre-Push Hook · What `test:merge-gate` Does · Yield History Cleanup Windows · CI Deploy Sequence · GitHub Deploy Inputs · Dependency Refresh Cadence · Runtime Measurement Notes · Runtime Origins · Self-Serve API Key Rollback · Failure Policy.

## Purpose

This document defines the production deploy flow, the GitHub Actions release gate, and the optional local rehearsal gate for production-impacting work.

## Core Rules

1. Pull requests into `main` run the shared validation gate in GitHub Actions; production deploys still ship from pushes to `main`, while a separate Pages-only rebuild workflow refreshes the static export daily. Manual production deploy dispatch is main-only: choose `main` as the workflow ref, and cancel the run if GitHub was opened on another ref.
2. Agents and routine maintenance default to the current `main` checkout. Do not create a branch, worktree, or PR unless the maintainer explicitly asks for one.
3. Heavy feature/refactor work may use a dedicated worktree branch when the maintainer chooses that workflow. After merging that branch into local `main`, run focused checks; GitHub Actions owns the authoritative release gate. Use `PHAROS_PRE_PUSH_GATE=main git push origin main` only when you want an explicit local merge-gate rehearsal before the push.

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

4. Push `main`. By default the local pre-push hook is advisory-only; use `PHAROS_PRE_PUSH_GATE=main git push origin main` when you want the exact-range local merge gate before GitHub Actions.

```bash
git push origin main
```

## Repo Pre-Push Hook

In the standard local npm setup, `package.json` runs `scripts/maintenance/prepare-workspace.mjs` via the `prepare` script. Local installs materialize bootstrap-safe generated projections and run `git config core.hooksPath .githooks`, so the repo pre-push hook is configured automatically after install. GitHub Actions skips that implicit prepare work and runs `npm run bootstrap:generated` explicitly through `.github/actions/setup-workspace/action.yml`. If hooks were disabled or overridden locally, re-enable them with:

```bash
git config core.hooksPath .githooks
```

Hook behavior:

1. Pushes that update `refs/heads/main` are advisory-only by default. The hook prints that GitHub Actions is the authoritative release gate and lets the push continue.
2. Set `PHAROS_PRE_PUSH_GATE=main` to run `npm run test:merge-gate` against the exact `remote_sha...local_sha` range Git sends to the hook, matching the `github.event.before...github.sha` range used by `.github/workflows/deploy-cloudflare.yml`. Pages smoke is on by default; override with `MERGE_GATE_PAGES_SMOKE=0`.
3. A new remote `main` push, where Git has no previous remote SHA, forces the full local deploy validate path only when `PHAROS_PRE_PUSH_GATE=main` or `PHAROS_PRE_PUSH_GATE=all` is set.
4. Other pushes skip the full local gate by default because they cannot deploy production. Set `PHAROS_PRE_PUSH_GATE=all` to opt into exact-range gating for branch pushes.
5. When the local gate runs, the hook requires the checked-out `HEAD` to equal the pushed local SHA and the worktree to remain clean before and after validation, so the proof cannot drift from the commit Git is sending.
6. A successful manual gate writes a 24-hour receipt only for a clean committed state. The hook reuses it when the base/head commits, gate implementation, lockfile, Node major, origin, worktree, and validation environment profile still match.
7. When the local gate is opted in, push is blocked on failure. Receipt mismatches fail closed and run the gate normally.

## What `test:merge-gate` Does

`scripts/maintenance/test-merge-gate.mjs` compares `MERGE_GATE_BASE_REF...MERGE_GATE_HEAD_REF` (default `origin/main...HEAD`) and mirrors the deploy-path validate policy locally. When the pre-push hook is opted in with `PHAROS_PRE_PUSH_GATE=main` or `PHAROS_PRE_PUSH_GATE=all`, it sets those refs from Git's pushed ref update so the local changed-file set matches the deploy workflow's push classifier.

Default policy:

1. If the diff does not touch Pages or worker deploy surfaces, print the changed-file set and skip the gate.
2. For deploy-impacting diffs, run the shared validate pre-build command set from `scripts/lib/validation-lanes.mjs`. The default blocking set is intentionally small: lint, typed lint, root/test typecheck, env/import boundaries, surface-scoped Worker migration/cron/SQL/config checks, Pages CSP/client-registry/generated-artifact checks, and stablecoin data validation. Advisory maintenance checks (dependency/provider audits, docs/agent infrastructure, hotspot/stale-flag/unused-code/script-entrypoint ratchets, provider/dependency/mechanism/oracle coverage, and similar long-tail hygiene) are skipped by default and can be restored with `VALIDATE_PREBUILD_INCLUDE_ADVISORY=1`. The production deploy workflow enables that advisory mode during the transition release cycle; PR validation and ordinary command-line runs use the reduced blocking set.
3. If Pages-impacting files changed, additionally run:
   - `npm run build` with the same static-export env contract as the production Pages job (`NEXT_PUBLIC_FORCE_SITE_DATA_PROXY=true` and public-dataset/API source env cleared so the prebuild hook preserves already-synced mirrors)
   - `npm run check:feature-flag-inlining`
   - `npm run seo:check`
   - `npm run check:phishing-signatures`
   - `npm run check:classifier-sensitive-copy`
   - CI invokes this ordered group through `npm run validate:pages`; the local gate consumes the same lane-owned leaf list so it can apply per-command environment and timing.
4. Always run the shared validate post-build checks:
   - `npm run test:noncritical`
5. If worker-impacting files changed, additionally run:
   - `npm run typecheck:worker`
   - CI invokes this ordered group through `npm run validate:worker`; the local gate consumes the same lane-owned leaf list.

After `npm run validate:prebuild` succeeds, the local merge gate runs independent build/Vitest/worker-validation groups, **auto-enabling the parallel matrix on machines with ≥12 available cores** and staying serial below that to avoid CPU contention on developer machines; `MERGE_GATE_PARALLEL=1`/`=0` forces either mode. The Vitest lane is emitted as two `npm run test:noncritical -- --shard=N/2` shards to match the CI fan-out (each shard runs on its own CI runner). Despite the legacy script name, those shards now include critical test files; `coverage:critical` is owned by the weekly/manual ratchet workflow and direct local rehearsals. This keeps the validation surface aligned with deploy CI while keeping the local default reliable. Before executing a non-dry-run validation plan, the gate runs `scripts/ci/check-node-modules-fresh.mjs --strict`; it fails when `node_modules/` is missing, when the install snapshot is missing, or when `package-lock.json` is newer than `node_modules/`. `MERGE_GATE_DRY_RUN=1` still prints the command plan without requiring `node_modules/`.

Gate builds skip the prebuild artifact regeneration (`GENERATED_ARTIFACTS_SKIP` covering every registry id): the same run's `check:generated-artifacts` already byte-verified the committed artifacts, so regenerating them inside `npm run build` is guaranteed no-op work. The gate also records wall-clock per command and prints a slowest-first timing summary at the end (on failures too); when the total exceeds the soft runtime budget (default 8 minutes, `MERGE_GATE_BUDGET_MINUTES` overrides, `0` disables) it emits a non-fatal warning so runtime regressions surface immediately instead of accreting silently. Advisory coverage, docs, agent-infra, dependency/provider, stale-flag, unused-code, and ratchet checks now live outside the default blocking prebuild path unless a caller explicitly enables advisory prebuild mode. Pages validate lanes cover build, feature-flag inlining, SEO, phishing signatures, and classifier-sensitive copy after the static export exists; broader a11y, build-size, and build-attribution checks remain production/scheduled/manual concerns.

For post-swarm or very large local batches, use diagnostic discovery when you need one pass to surface multiple local failures:

```bash
npm run test:merge-gate:discover
```

`scripts/maintenance/run-merge-gate-discovery.mjs` uses the same diff, deploy-surface classifier, node_modules freshness check, and deploy-impact command plan as `test:merge-gate`, but it is optimized for diagnostics rather than release proof. It runs the reduced blocking `validate:prebuild` surface with `VALIDATE_PREBUILD_CONTINUE_ON_ERROR=1`; advisory prebuild checks stay skipped unless `VALIDATE_PREBUILD_INCLUDE_ADVISORY=1` is set. It then keeps independent postbuild groups running after failures so one pass can expose static-check, build/test, and Worker-validation failures together. Discovery mode skips smoke by default; set `MERGE_GATE_DISCOVERY_SMOKE=1` when smoke failures are the current target, and use `MERGE_GATE_DISCOVERY_MAX_PARALLEL=<n>` to cap local fan-out (default max: 3). Discovery success or failure does not create a release proof, does not write a reusable receipt, and does not replace GitHub Actions as the authoritative release gate.

Pages-impacting files now use the same broad matcher as CI deploy classification: any `src/`, `shared/`, `functions/`, `public/`, or `data/` path, selected build/config scripts, shared validate/guardrail infrastructure, and the Pages release workflow files all require local export validation when `test:merge-gate` is run. Worker-impacting files use the same worker/shared/deploy-infra matcher as CI, including Worker operational scripts and shared validate/guardrail infrastructure, but `shared/` is classified by subpath so known Pages-only shared helpers do not request Worker validation or promotion. `test:merge-gate` runs Pages smoke by default for Pages-impacting diffs so an explicit local rehearsal uses the same pre-publish artifact smoke path as production deploys; Worker smoke remains explicit via `MERGE_GATE_WORKER_SMOKE=1`. When Pages smoke runs, desktop overflow smoke uses the deploy-lane canary routes with 6 workers, and local mobile smoke follows the same UI-impact matcher and canary profile as production deploys.

Useful merge-gate controls:

- `npm run test:merge-gate -- --staged` to diff staged files instead of the default ref range
- `MERGE_GATE_BASE_REF=<ref>` to override the default compare base (`origin/main`)
- `MERGE_GATE_HEAD_REF=<ref>` to override the default compare head (`HEAD`)
- `MERGE_GATE_FULL_DEPLOY=1` to force the full local deploy validate path when there is no usable base ref
- `MERGE_GATE_DRY_RUN=1` to print the command plan without executing it
- `MERGE_GATE_PARALLEL=1`/`=0` to force parallel or serial post-validate execution. The default auto-enables parallel on machines with ≥12 available cores and stays serial below that to avoid local CPU contention; CI always runs the parallel matrix via separate runners
- `npm run test:merge-gate:discover -- --dry-run` to print the diagnostic discovery plan without executing commands
- `npm run test:merge-gate:discover` to run the local deploy-impact plan in failure-discovery mode while debugging large batches or CI failures
- `MERGE_GATE_DISCOVERY_MAX_PARALLEL=<n>` to cap discovery-mode postbuild fan-out (default max: 3)
- `MERGE_GATE_DISCOVERY_SMOKE=1` to include smoke commands in discovery mode; smoke stays on by default only in the final merge gate
- Production Pages environment rehearsal is opt-in: set `MERGE_GATE_PRODUCTION_ENV=1` and export the production `NEXT_PUBLIC_GA_ID`, `NEXT_PUBLIC_PHAROS_*`, `STATIC_EXPORT_API_BASE`, `STATIC_EXPORT_SITE_API_BASE`, `PHAROS_API_KEY` or `STATIC_EXPORT_API_KEY`, and `SITE_API_SHARED_SECRET` values before `npm run test:merge-gate`. With `NEXT_PUBLIC_GA_ID` present, the local Pages smoke expects the same GA measurement ID as the production Pages release smoke. Without that opt-in, the gate clears public production feature-flag env locally while applying the same static-export build contract as CI.
- `MERGE_GATE_PAGES_SMOKE=0` to skip default `npm run validate:pages-smoke` after build for Pages-impacting diffs. By default this serves the static export and runs desktop/local `smoke-ui` on the canary routes with 6 workers. Local merge-gate rehearsals can still run strict mobile canaries for UI-impacting diffs, but the production Pages release no longer runs mobile smoke by default.
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
   - emits `deploy_required`, `worker_changed`, `worker_promotion_required`, `pages_changed`, `pages_deploy_required`, and `pages_ui_changed`
   - decides separately whether Worker validation, Worker production promotion, and Pages deploy work are actually required for that push
   - treats Pages release workflow changes (`.github/workflows/pages-release.yml`, `.github/workflows/rebuild-pages.yml`) as Pages-impacting so workflow-only changes still rehearse the Pages path
   - keeps `worker_changed=true` broad for Worker validation/guardrail coverage, but classifies `shared/` by subpath so known Pages-only helpers skip Worker validation; only sets `worker_promotion_required=true` for deployed Worker runtime/config, D1 migrations, Worker assets, shared runtime files, and root package/lock changes that can change the production Worker bundle
   - keeps `pages_changed=true` broad enough to validate Pages tests and tooling, while `pages_deploy_required=true` excludes test-only diffs and includes Markdown sources rendered by the public docs route; `pages_ui_changed=true` remains available for explicit/manual UI-heavy browser checks, but it no longer widens the default production Pages release
   - defaults to the full deploy path on `workflow_dispatch`; manual production dispatch must target the `main` ref
2. `validate`
   - runs only when `deploy_required=true`
   - always includes the reduced blocking `validate:prebuild` set and sharded `npm run test:noncritical`; the production deploy caller also sets `include_advisory_prebuild: true` for the transition window so dependency/provider/docs/agent/ratchet checks still run before production mutation while PRs use the slimmer default
   - includes `npm run build`, `npm run check:feature-flag-inlining`, `npm run seo:check`, `npm run check:phishing-signatures`, and `npm run check:classifier-sensitive-copy` only for pull requests with `pages_deploy_required=true`; the push/manual production deploy path runs Pages build/SEO/static-export guardrails inside `pages-release`, not the validate gate
   - includes `npm run typecheck:worker` only when `worker_changed=true`; the scheduled Worker entrypoint suite is covered by the normal Vitest shards and the scheduled/manual critical coverage ratchet
   - CI runs `validate-prebuild`, `pages-build`, `test-noncritical`, and `typecheck-worker` as independent parallel GitHub jobs, with the aggregate `validate` job waiting on all required results. `pages-build` invokes the fixed `validate:pages` phase and `typecheck-worker` invokes `validate:worker`; both read their ordered commands from `scripts/lib/validation-lanes.mjs`. The local merge gate consumes those same lane-owned leaf lists through `buildCommandPlan`, retaining per-command environment/timing and auto-enabling parallel execution when at least 12 cores are available; `MERGE_GATE_PARALLEL=1` or `0` overrides the automatic choice.
   - installs Node 24.16.0 through the shared workspace setup action, matching the primary repo baseline; pull-request checks also run a non-blocking Node 26 proof lane because the engine range allows Node 26
   - internal-docs-only pull requests run the focused verified-link, source-path, sync, and count checks; other pull requests call the reusable workflow with diff-derived Pages validation, Pages publish, and Worker inputs
3. `no-deploy-required`
   - runs only when `deploy_required=false`
   - records an explicit no-op outcome for docs-only or other non-deploy pushes to `main`
4. `deploy-worker`
   - split into early non-mutating candidate preparation and gated production promotion:
     - `upload-worker-version` captures the currently live production version ID and uploads the candidate with the lockfile-installed Wrangler CLI (`npx --no-install wrangler ...`) only after `detect-changes` confirms Worker promotion is required and the aggregate `validate / validate` job has succeeded. The status read and upload preflight use bounded exponential retries for transient Cloudflare control-plane failures; the upload command retries only the known pre-upload service-metadata `GET`, so ambiguous failures and requests after candidate creation still fail closed. This keeps Cloudflare credentials and Worker-version mutation behind the validation gate while still using the shared `setup-workspace` install path so upload and deploy run against the same dependency graph. If Cloudflare returns `entitlements.not_available [code: 10007]` for Workers Versions, the prep lane records `version_upload_unavailable=true` instead of failing and the deploy summary calls out the reduced rollback safety of the legacy fallback.
     - `deploy-worker` waits for the aggregate `validate / validate` job, reruns `npm run check:migrations`, fails closed before production D1 mutation when Worker Versions are available but no previous production version was captured, applies D1 migrations via `cd worker && npx --no-install wrangler d1 migrations apply stablecoin-db --remote`, runs deploy-canary `smoke-api` checks against the uploaded preview URL with `SMOKE_API_KEY` when Workers Versions are available, and then promotes that exact preview-smoked version through the Cloudflare Workers Deployments API (`POST /workers/scripts/<name>/deployments`) without asking Wrangler to sync non-versioned script settings during promotion. When the account lacks Workers Versions entitlement, `deploy-worker` uses the legacy `cd worker && npx --no-install wrangler deploy` fallback after the same validation and migration gates.
   - runs `cd worker && npx --no-install wrangler triggers deploy` after promotion to explicitly sync cron/routes/domain triggers and other non-versioned trigger settings
   - keeps Worker candidate upload, remote D1 apply, and production promotion behind the aggregate validation result, with `check:migrations` still rerun immediately before remote D1 mutation
   - relies on the `check:migrations` rollout-safety contract for new migrations: standard deploy only supports backward-compatible D1 changes because the old worker can still receive traffic until the promoted version is live
   - runs production `npm run test:smoke-api` in the same job after promotion; on worker-only deploys, it then runs live UI, ops, and transport smokes before the rollback decision. Trigger-sync, production API smoke, or worker-only live-smoke failure automatically rolls back to the captured previous Worker version on the Workers Versions path. The legacy fallback cannot automatically re-promote a preview-smoked version, so it still fails visibly on post-deploy smoke failure and requires operator-led rollback from Cloudflare deployment history.
   - skipped on Pages-only, validation-only, or non-deploy `push` events where `detect-changes` reports `worker_promotion_required=false`
5. `pages-release`
   - production deploy job in `.github/workflows/deploy-cloudflare.yml`
   - runs only when `detect-changes` reports `pages_deploy_required=true`; test-only Pages changes still receive validation but do not publish
   - starts after Pages changes are detected and the aggregate `validate / validate` job succeeds (no hard dependency on `upload-worker-version`)
   - uses an explicit Pages release `api_base_url` input when supplied; otherwise production digest sync, depeg-event sync, and public dataset generation read through `https://pharos.watch/_site-data/*` with a same-site caller header, while local artifact smoke sends direct `/api/*` probes to the configured public API base (`vars.SMOKE_API_BASE_URL || vars.API_BASE_URL`) and same-origin `/_site-data/*` browser reads to `https://site-api.pharos.watch` with `SITE_API_SHARED_SECRET`
   - executes the Pages build/local-smoke/publish path in one job:
   - fetches `/api/digest-archive` once into `data/digests.json`, fetches confirmed depeg events into `data/depeg-events.json`, generates `public/datasets/*` and `public/sheets/*`, and forwards `NEXT_PUBLIC_GA_ID` plus `NEXT_PUBLIC_PHAROS_*` repo variables into `npm run build`; production builds first use the browser-facing `https://pharos.watch/_site-data/*` GET-only lane with `Origin: https://pharos.watch` so the sync path matches browser reads instead of direct internal `site-api` edge paths, while an explicit preview API input still takes precedence and receives the configured API credentials. If GitHub-hosted shared egress is still edge-blocked, the release sync scripts preserve validated non-empty checked-in `data/digests.json`, `data/depeg-events.json`, and current public dataset mirrors rather than failing the deploy before build; invalid or missing mirrors remain fatal. Production public-API smoke retains bounded `403` retries for transient edge blocks. The build step clears the public-dataset fetch env so the prebuild hook preserves those synced mirrors instead of re-fetching, and depeg event SSG is bounded to the newest indexable archive entries plus pinned authored incidents so full production history cannot breach the repo's conservative Pages upload budget. Pages CI builds also set `NEXT_PUBLIC_FORCE_SITE_DATA_PROXY=true` so the local `127.0.0.1` artifact smoke uses the production `/_site-data/*` browser lane. The job then runs `npm run check:feature-flag-inlining`, `npm run check:phishing-signatures`, `npm run check:classifier-sensitive-copy`, `npm run check:build-size`, `npm run check:build-attribution`, `npm run seo:check`, and one local `npm run test:smoke-ui -- --url http://127.0.0.1:4173 --mode local` canary before publish. Bare/hydrated a11y, strict mobile smoke, and broad Yield asset coherence sweeps are scheduled/manual concerns instead of default release blockers. Live smoke requires GA4 `page_view` collect delivery; local artifact smoke accepts either successful delivery or a Playwright `net::ERR_ABORTED` report for an issued collect URL with the configured measurement id.
   - limits per-coin yield workbench SSG to intrinsic yield coins and curated deterministic lending overrides. Known coins outside that durable set redirect to filtered `/yield/`, restoring more than 25% direct-upload file headroom without leaving runtime lending discoveries at dead links.
   - the local static-export server treats exact `/api` and `/api/` as the public API access page, serves checked-in/static route payload artifacts below `/api/` when present, proxies endpoint-like `/api/*` requests including JSON `POST` bodies to the selected public API base, and mirrors the production Pages Function redirect for intentionally omitted known-coin Yield workbenches
   - catch-all document responses use `max-age=0, must-revalidate`; deploy-versioned HTML has no shared-cache lifetime or stale-while-revalidate window that can outlive its referenced Next.js chunks. Hashed `/_next/static/*` assets retain their one-year immutable policy through the more-specific header rule.
   - uses `SMOKE_UI_BROWSER_CHANNEL=chrome`, `SMOKE_UI_OVERFLOW_ROUTES=/`, and one local smoke worker for the pre-publish canary so the release still catches an unbootable artifact without running the broad overflow sweep on every deploy
   - starts only after the aggregate `validate / validate` job succeeds. On combined Worker + Pages deploys, static checks can run while Worker promotion is in flight, then the workflow waits for `deploy-worker` before running the local artifact UI canary once against the promoted Worker and publishing Pages.
   - writes a Pages release summary after `check:build-size` with the total output file count, static export size, and depeg-event static page count, then captures the current Cloudflare Pages production deployment id as the required rollback target; if that id cannot be captured, the job fails before publishing so a broken deploy cannot be left live without an automated rollback target. With rollback armed, it publishes the already verified local artifact through Wrangler with the existing retry loop, and runs live public UI, ops, and transport smokes concurrently in one post-publish step while still emitting per-smoke status outputs in the summary
   - requires ten consecutive target-SHA release-marker responses per public/ops host before live smoke, resetting the convergence counter on any regression. Broad live asset-coherence sweeps now belong to scheduled/manual browser validation instead of the default production release.
   - calls `scripts/maintenance/rollback-pages-deployment.mjs` when `deploy-pages` succeeded but any fatal post-publish smoke (live public UI, ops, or transport) failed; the overall workflow still surfaces as failed so the incident is visible
   - leaves broad zone-cache invalidation outside the normal deploy path. If a custom-domain edge continues serving pre-release HTML after publish or rollback, an operator can dispatch `purge-pages-zone-cache.yml` from `main` with the exact `purge pharos.watch` confirmation; the workflow shares the production deploy lock and the script refuses ambiguous zone lookups before issuing the idempotent purge
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

The manual zone-cache recovery workflow also requires `CLOUDFLARE_API_TOKEN` to grant `Zone Read` and `Cache Purge` for the `pharos.watch` zone. Normal Pages and Worker deploy permissions alone do not imply either zone permission.

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

The 08:25 fallback skips its full release only when the live marker points to the current commit and the GitHub Actions API confirms that marker came from a successful same-day scheduled `Rebuild Pages` run after the 08:05 data refresh. Missing, stale, ordinary deploy, manual, or failed-run markers all fail closed into the full fallback release.

1. `pages-release`
   - reuses the same consolidated `.github/workflows/pages-release.yml` job as push/manual production deploys
   - fetches data, builds, runs local SEO plus one UI canary smoke, publishes, and runs post-publish live public-host, ops, and transport smokes in that one reusable job

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

- The Node 24.16.0 validate lane starts `validate:prebuild`, Vitest shards, and conditional Worker validation as independent jobs, then uses the aggregate `validate / validate` job to require every needed result. The pull-request Node 26 proof lane is separate and non-blocking; failures there should be triaged before widening Node-dependent behavior.
- Worker candidate upload waits for the aggregate `validate / validate` result before any Cloudflare-secret-bearing preparation. The `pages-release` job has the same authoritative `needs: validate` edge in `.github/workflows/deploy-cloudflare.yml`, avoiding a second API polling gate inside the reusable workflow.
- Production D1 mutation and Worker promotion remain behind the aggregate `validate / validate` result; Pages publish also waits for validation and, on combined deploys, successful Worker promotion.

### Pages Path Behavior

- The production Pages path fetches digests, depeg events, and public dataset mirrors once inside `pages-release` and requires local SEO plus one `smoke-ui` canary before `deploy-pages`, so a broken static export is blocked before Cloudflare Pages production publish without running the broader browser lab on every release. The build step clears the public-dataset source env before `npm run build`, so the prebuild hook uses the already synced mirrors and the build itself no longer depends on mutable static input endpoints. The local artifact is built with `NEXT_PUBLIC_FORCE_SITE_DATA_PROXY=true` so browser reads go through `/_site-data/*` instead of the protected direct `/api/*` lane while the smoke server runs on `127.0.0.1`; that local `/_site-data/*` proxy targets the canonical site API origin with `SITE_API_SHARED_SECRET`, mirroring the production Pages Function rather than the public API edge. `check:feature-flag-inlining` verifies configured `NEXT_PUBLIC_PHAROS_*` flags were statically inlined after build, and `check:build-size` enforces the repo's 20,000-file upload budget before Wrangler deploys the artifact. That conservative budget matches Cloudflare's current Free-plan and legacy Wrangler ceiling; current paid Pages projects can allow more, so consult the [Pages limits](https://developers.cloudflare.com/pages/platform/limits/) before changing the checked-in budget. Pages deploy retries use six attempts with increasing backoff because Cloudflare Pages asset uploads can return transient 500/no-healthy-upstream responses.
- On combined Worker-promotion + Pages deploys, the prepublish Pages path starts after validation and can overlap with the gated Worker release path using the configured target API base.
- After publish, `pages-release` runs live public UI, ops canary, and transport smokes concurrently inside one post-publish step, then writes a Markdown summary with per-smoke outcomes. The homepage/GA/data-state live public-host smoke targets `https://pharos.watch`, and the live route canary includes `/depeg/`. The live GA smoke allows one reload retry only when the first browser context sees no analytics runtime or GA/GTM network evidence and no analytics-specific CSP violation, so Pages propagation gaps do not mask concrete analytics failures while unrelated first-party CSP events do not suppress the retry.
- `.github/workflows/purge-pages-zone-cache.yml` is a manual recovery path for persistent stale custom-domain HTML, not a routine deploy step. It accepts only `main`, requires the exact production confirmation string, shares the `production-deploy` concurrency group, and uses the repository Cloudflare token only after an exact active-zone lookup.
- The production ops smoke runs in canary scope on the deploy critical path, keeping shell/access and status coverage while leaving the slower deep admin probes for explicit full smoke runs.

### Skip Rules

- On `push`, Worker deploy and API smoke are skipped entirely when the diff does not touch deployed Worker runtime/config, D1 migrations, Worker assets, Worker-consumed shared runtime files, or root package/lock entries that can affect the Worker bundle, even if broader Worker validation still runs for package/tooling changes. Known Pages-only shared helpers are excluded from Worker validation and promotion by `scripts/lib/automation-registry.mjs`.
- Pages build/deploy are skipped when the diff does not touch publishable Pages paths. Test-only Pages diffs still receive Pages-aware validation without a redundant build or production publish; Markdown sources rendered by the public docs route remain publishable inputs.
- Strict mobile, hydrated a11y, and broad asset-coherence browser checks are no longer part of the default production Pages release; run them through scheduled/manual browser validation or explicit local commands for UI-heavy changes.

### Concurrency and Rollback Scope

- Production-changing workflows share one global `concurrency` group (`production-deploy`): push/manual deploys, Pages rebuilds, and the manual zone-cache recovery workflow queue behind any active production operation instead of canceling or overlapping post-promotion smoke or rollback work. Manual production dispatches are guarded to `refs/heads/main`.
- The worker release path applies D1 migrations before preview smoke and production promotion, so the normal path explicitly supports only backward-compatible D1 migrations; the release runner reruns `check:migrations` immediately before remote apply, writes the replayed schema fingerprint to the job summary for drift triage, and still requires a separate coordinated rollout for destructive cleanup after the new worker code is serving.
- Automatic worker rollback changes traffic back to the previous Worker version when Workers Versions are available; missing previous-version capture fails closed before production mutation. Before promotion, the workflow captures the previous `worker/wrangler.toml` when the push base exists; if trigger sync, production API smoke, or worker-only live smokes fail, it also attempts `wrangler triggers deploy --config .rollback-wrangler.toml` to restore non-versioned route/domain/cron trigger settings. D1 schema/data rollback remains a separate D1 recovery step.
- Treat the report-card snapshot gzip codec as an independent forward-compatible production fix when rolling back V9. After any compressed `report-cards:snapshot` row has been written, retain a reader that supports gzip/base64 plus legacy plain rows: older readers cannot decode the compressed row, while restoring the older plain writer would again exceed D1's 2,000,000-byte row limit.
- Treat the first production promotion that introduces this codec as forward-only. If post-promotion automation restores the pre-codec Worker after a compressed row may have been written, immediately re-promote the codec-bearing version instead of leaving the incompatible reader and oversized writer active.

## Runtime Measurement Notes

When reviewing deploy runtime after optimization work, separate queue time from job execution time because the shared `production-deploy` concurrency group can make a healthy run appear slow while it waits for another production-changing workflow. Compare like-for-like paths: combined worker + Pages deploys, worker-only deploys, Pages-only deploys, and scheduled Pages rebuilds have different expected critical paths.

For combined deploys, `pages-release` starts after the aggregate validation result and runs its static checks while Worker promotion is in flight. When `wait_for_worker_promotion` is enabled, it waits before running the local artifact UI canary once against the promoted Worker, then publishes Pages.

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

If an explicit local `test:merge-gate` rehearsal fails:

1. Do not treat the local rehearsal as green.
2. For a small change, fix the failing command directly. For a large merged batch or repeated fail-fast loop, run `npm run test:merge-gate:discover` to collect more failing lanes in one pass.
3. Re-run the narrow failing command(s) until clean.
4. Re-run `npm run test:merge-gate`.
5. Push after the relevant focused checks or local rehearsal pass; GitHub Actions remains the authoritative release gate.
