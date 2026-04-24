# Deployment Process

## Purpose

This document defines the production deploy flow and the required local gate for merged worktree changes.

## Core Rules

1. Pull requests into `main` run the shared validation gate in GitHub Actions; production deploys still ship from pushes to `main`, while a separate Pages-only rebuild workflow refreshes the static export daily. Both workflows also support manual dispatch.
2. Heavy feature/refactor work must be done in a dedicated worktree branch.
3. After merging a worktree branch into local `main`, run the merge gate before pushing.

## Worktree Flow

1. Create a worktree from `origin/main`.

```bash
git fetch origin
git worktree add .worktrees/<feature-name> -b <branch-name> origin/main
```

2. Implement and test in that worktree branch.
3. Merge the branch into local `main`.

```bash
git checkout main
git pull --ff-only origin main
git merge --no-ff <branch-name>
```

4. Run the merge gate on `main`.

```bash
npm run test:merge-gate
```

5. Push `main`.

```bash
git push origin main
```

## Repo Pre-Push Hook

In the standard npm setup, `package.json` runs `git config core.hooksPath .githooks` via the `prepare` script, so the repo pre-push hook is configured automatically after install. If hooks were disabled or overridden locally, re-enable them with:

```bash
git config core.hooksPath .githooks
```

Hook behavior:

1. Any push: runs `npm run test:merge-gate`.
2. Push is blocked on failure.

## What `test:merge-gate` Does

`scripts/test-merge-gate.mjs` compares current `HEAD` to merge-base with `origin/main` and mirrors the deploy-path validate policy locally.

Default policy:

1. If the diff does not touch Pages or worker deploy surfaces, print the changed-file set and skip the gate.
2. For deploy-impacting diffs, run the shared validate pre-build command set from `scripts/lib/validate-contract.mjs`. It covers dependency/pricing audits, lint/typecheck, import boundaries, cycle detection across `shared/`, `worker/src`, and `src`, migrations, cron schedule/connection checks, documentation link/source-path/sync checks, env contracts, duplicate exports, redemption-backstop registry checks, unused code, hotspot ratchets, SQL-safety, and stablecoin data validation.
3. If Pages-impacting files changed, additionally run:
   - `npm run build`
   - `npm run seo:check`
4. Always run the shared validate post-build checks:
   - `npm run test:noncritical`
   - `npm run coverage:critical`
5. If worker-impacting files changed, additionally run:
   - `npm run typecheck:worker`
   - `npm run typecheck:worker-scripts`

After `npm run validate:prebuild` succeeds, the local merge gate runs independent build/non-critical-test/critical-coverage/typecheck groups in parallel by default. This keeps the validation surface aligned with deploy CI while reducing local wall time. Set `MERGE_GATE_SERIAL=1` when debugging output ordering or resource contention.

Pages-impacting files now use the same broad matcher as CI deploy classification: any `src/`, `shared/`, `functions/`, `public/`, or `data/` path, selected build/config scripts, shared validate/guardrail infrastructure, and the Pages release workflow files all require local export validation. Worker-impacting files use the same worker/shared/deploy-infra matcher as CI, including Worker operational scripts and shared validate/guardrail infrastructure. The gate still skips deploy-time smoke suites locally.

Useful merge-gate controls:

- `npm run test:merge-gate -- --staged` to diff staged files instead of `merge-base ... HEAD`
- `MERGE_GATE_BASE_REF=<ref>` to override the default compare base (`origin/main`)
- `MERGE_GATE_DRY_RUN=1` to print the command plan without executing it
- `MERGE_GATE_SERIAL=1` to run the plan serially for lower local resource pressure

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
- `.github/workflows/dependency-audit.yml` for the scheduled full dependency audit
- `.github/workflows/pull-request-checks.yml` for pull-request validation on `main`, including a pinned gitleaks scan (`v8.30.0`, SHA256-verified) over the PR commit range (`--log-opts="--no-merges <base>..<head>"`); full-history scans still run weekly via `.github/workflows/secret-scan.yml`
- `.github/workflows/deploy-cloudflare.yml` for push/manual production deploys that reuse the same validate gate
- `.github/workflows/pages-prepare.yml` for the reusable Pages build + local smoke path
- `.github/workflows/pages-publish.yml` for the reusable Pages publish + live smoke path
- `.github/workflows/pages-release.yml` for the shared Pages build/smoke/deploy path
- `.github/workflows/rebuild-pages.yml` for the scheduled/manual Pages-only rebuild path

Deploy sequence in `.github/workflows/deploy-cloudflare.yml`:

1. `detect-changes`
   - diffs `github.event.before...github.sha` on `push` (three-dot, merge-base-resolved; identical to two-dot on push-to-main but robust if the base is ever not a strict ancestor)
   - emits `deploy_required`, `worker_changed`, and `pages_changed`
   - decides separately whether worker/API deploy work and Pages deploy work are actually required for that push
   - treats Pages release workflow changes (`.github/workflows/pages-prepare.yml`, `.github/workflows/pages-publish.yml`, `.github/workflows/pages-release.yml`, `.github/workflows/rebuild-pages.yml`) as Pages-impacting so workflow-only changes still rehearse the Pages path
   - defaults to the full deploy path on `workflow_dispatch`
2. `validate`
   - runs only when `deploy_required=true`
   - always includes `npm run audit:deps`, `npm run audit:pricing-providers`, lint, policy/guardrail checks (including verified-doc link and env-contract validation), `npm run test:noncritical`, and `npm run coverage:critical`
   - includes `npm run build` + `npm run seo:check` only when `pages_changed=true`
   - includes `npm run typecheck:worker` and `npm run typecheck:worker-scripts` only when `worker_changed=true`
   - after `npm run validate:prebuild`, runs independent Pages build/SEO, non-critical-test, critical-coverage, and Worker typecheck groups in parallel through `scripts/run-validate-postbuild.mjs`; `npm run build` still precedes `npm run seo:check`, and `VALIDATE_POSTBUILD_SERIAL=1` restores the old serial shape for debugging
   - the same reusable workflow also runs `validate-lts`, which installs Node 24.x and executes `npm run validate:lts` against the same shared deploy-surface-aware validate contract with the same deploy-surface flags as the main Node 25 validate job
   - pull requests call the same reusable workflow with diff-derived `pages_changed` and `worker_changed` inputs, so PR Pages build/SEO and worker typecheck coverage follows the deploy-surface classifier while the shared non-deploy guardrails and tests still run on every PR
3. `no-deploy-required`
   - runs only when `deploy_required=false`
   - records an explicit no-op outcome for docs-only or other non-deploy pushes to `main`
4. `deploy-worker`
   - renamed in practice into a worker candidate + promotion path:
     - `upload-worker-version` captures the currently live production version ID, applies D1 migrations via `cd worker && npx --no-install wrangler d1 migrations apply stablecoin-db --remote`, uploads the candidate with `cd worker && npx --no-install wrangler versions upload`, then runs `npm run test:smoke-api` against that preview URL with `SMOKE_API_KEY` before the candidate is considered promotable
     - `deploy-worker` promotes that exact preview-smoked uploaded version with `cd worker && npx --no-install wrangler versions deploy <version-id>@100`
   - runs `cd worker && npx --no-install wrangler triggers deploy` after promotion to explicitly sync cron/routes/domain triggers and other non-versioned trigger settings
   - relies on the `check:migrations` rollout-safety contract for new migrations: standard deploy only supports backward-compatible D1 changes because the old worker can still receive traffic until the promoted version is live
   - skipped on Pages-only or non-deploy `push` events where `detect-changes` reports no worker/API-impacting files
5. `smoke-api`
   - runs after `deploy-worker`, against the real production API host
   - sends `SMOKE_API_KEY` from GitHub repository secrets so protected public routes can be verified after cutover
   - remains the post-promotion canary for custom-domain/runtime differences that preview URLs do not cover
6. `rollback-worker`
   - runs only when worker promotion succeeded but the post-promotion `smoke-api` failed
   - uses `cd worker && npx --no-install wrangler rollback <previous-version-id> --yes` to restore the previously live Worker version automatically
   - keeps the overall workflow failed so the incident still surfaces in GitHub Actions even when rollback succeeds
7. `pages-prepare`
   - reusable workflow call to `.github/workflows/pages-prepare.yml`
   - runs only when `detect-changes` reports `pages_changed=true`
   - waits for `upload-worker-version` only when worker/API work was also required for the push
   - on combined worker + Pages deploys, uses the uploaded Worker's preview URL for digest sync and local `/_site-data/*` proxying so CI rehearses the static export against the exact candidate API while `deploy-worker` and `smoke-api` continue in parallel
   - executes the predeploy Pages path:
     - `build-pages` fetches `/api/digest-archive` once from the selected API environment into `data/digests.json`, sending `DIGEST_API_KEY` from GitHub repository secrets and forwarding `NEXT_PUBLIC_GA_ID` from GitHub repo vars into `npm run build`, then runs `npm run seo:check`, uploads `out/`, serves the same local artifact with `npm run serve:static-export`, proxies direct `/api/*` calls to the selected public API base, proxies `/_site-data/*` to `STATIC_EXPORT_SITE_API_BASE` when configured or the same selected API base by default, injects `SITE_API_SHARED_SECRET` for that hop, and verifies the expected GA snippet in the homepage shell or root static RSC payload when `SMOKE_UI_EXPECT_GA_ID` is configured
8. `pages-publish`
   - reusable workflow call to `.github/workflows/pages-publish.yml`
   - runs only when `detect-changes` reports `pages_changed=true`
   - waits for `pages-prepare`
   - also waits for `smoke-api` only when worker/API work was also required for the push
   - executes the publish Pages path:
     - `deploy-pages` first captures the current Cloudflare Pages production deployment id (via `wrangler pages deployment list --project-name=stablecoin-dashboard --environment=production --json`) as a best-effort step (continue-on-error), emits it as the `previous_deployment_id` job output, then publishes the already verified artifact through Wrangler with the existing retry loop
     - `smoke-ui-live` then runs `npm run test:smoke-ui -- --url https://pharos.watch --mode live` against the real public host, including the same homepage shell/static-payload GA snippet check when configured
     - `smoke-ops` and `smoke-transport` start after `deploy-pages` in parallel with `smoke-ui-live`, preserving the post-publish smoke surface while avoiding an unnecessary serial tail
     - `rollback-pages` calls the Cloudflare Pages rollback REST API via `scripts/rollback-pages-deployment.mjs` when `deploy-pages` succeeded but `smoke-ui-live` failed and `previous_deployment_id` is non-empty, restoring the previously live Pages production deployment; the overall workflow still surfaces as failed so the incident is visible
9. `smoke-ui-live`
   - worker-only deploy path that runs `npm run test:smoke-ui -- --url https://pharos.watch --mode live`
   - verifies the live Pages frontend still works against the newly deployed worker/API when no static rebuild is needed, including the expected GA snippet when configured
10. `smoke-ops`
    - private post-deploy ops smoke against `ops.pharos.watch/admin/` and `ops-api.pharos.watch`
    - runs inside `pages-publish` after `deploy-pages` on Pages-including deploys, or after `smoke-api` on worker-only deploys
    - runs in parallel with the public live UI smoke because it only depends on the production deployment being live
    - requires repository secrets `OPS_SMOKE_CF_ACCESS_CLIENT_ID` and `OPS_SMOKE_CF_ACCESS_CLIENT_SECRET`
    - UI check accepts either an Access redirect or a token-backed HTML response, so CI does not depend on the UI app also granting `Service Auth`
    - same-origin `ops.pharos.watch/api/admin/status` retries transient `502`/`504` gateway responses up to twice to absorb operator-status warmup immediately after promotion, but persistent proxy failures still fail the deploy

11. `smoke-transport`
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

Repository variables:

- Required: `API_BASE_URL`
- Optional: `SMOKE_API_BASE_URL`, `SMOKE_OPS_UI_URL`, `SMOKE_OPS_API_BASE`, `NEXT_PUBLIC_GA_ID`

`SMOKE_API_KEY` is required under the checked-in production Worker config because `PUBLIC_API_AUTH_MODE = "enforce"` protects non-exempt public API routes.

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

- `eslint@10`
- `typescript@6`

Scheduled/manual Pages rebuild sequence in `.github/workflows/rebuild-pages.yml`:

1. `pages-release`
   - reuses the same `.github/workflows/pages-release.yml` wrapper as push/manual production deploys
   - that reusable wrapper composes `.github/workflows/pages-prepare.yml` and `.github/workflows/pages-publish.yml` into the standard build/smoke/deploy path
   - the publish phase includes the post-publish live public-host smoke plus the `smoke-ops` and `smoke-transport` jobs; those smokes are inside the reusable Pages publish workflow, not separate jobs after the caller's `pages-release` job

This workflow intentionally skips `validate`, `deploy-worker`, and `smoke-api`; it exists to refresh the Pages export after digest generation without redeploying unchanged worker code. It still runs the ops and transport post-deploy smoke lanes so custom-domain regressions fail visibly.

GitHub-owned JS actions in this workflow are pinned by full commit SHA. When bumping an action version, resolve the tag against the upstream action repo and pin that real commit SHA, not an unavailable tarball or transient hash.

Cloudflare deployment intentionally uses the local Wrangler CLI instead of `cloudflare/wrangler-action`. The repo now uses a root npm workspace, so the workflows install the shared toolchain from the root `package-lock.json` and run Wrangler from the `worker` workspace with `npx --no-install`, keeping worker deploys insulated from GitHub Actions runtime deprecations in third-party JS actions. Worker production releases now use Wrangler Versions plus Preview URLs: CI uploads a candidate version, smokes that preview inside `upload-worker-version`, then promotes that exact version to production traffic. The validate and Pages-build lanes also restore `.next/cache`, `.cache/eslint`, and `*.tsbuildinfo` outputs so unchanged build/lint/typecheck work can be reused across runs, with separate cache keys per requested Node version so the Node 24 LTS lane does not collide with the existing Node 25 lane. The repo engine floor stays at Node 25 for the primary local/runtime baseline, while `validate-lts` runs the same shared deploy-surface-aware contract on Node 24.x.

Deployment stops on the first failed job. Pull requests run the shared validate gate with the same deploy-surface classifier used by push deploys: shared guardrails and the full deploy test surface always run, while Pages build/SEO and Worker runtime plus operational-script typechecks run only when the PR diff touches those surfaces. Push/manual deploy validation also skips Pages build/SEO on worker-only pushes, skips Worker typechecks on Pages-only pushes, and skips the production workflow entirely for non-deploy pushes. After the shared `validate:prebuild` guardrail set, both the Node 25 and Node 24 validate lanes run independent build/non-critical-test/critical-coverage/typecheck groups in parallel, aborting sibling groups on the first failure while preserving the same validation surface and `build -> seo:check` ordering. The shared Pages release path still fetches digests once inside `build-pages` and still requires the local `smoke-ui` gate before `deploy-pages`, so a bad static export is blocked before Cloudflare Pages production publish and the build itself no longer depends on the live production digest endpoint; the local smoke runs in the same `build-pages` job against the just-built `out/` directory to avoid a second runner setup and artifact download. On combined worker + Pages deploys, the predeploy Pages path now starts as soon as the worker preview smoke succeeds and runs against that preview URL in parallel with worker promotion and post-promotion API smoke. After publish, the same shared Pages path runs a narrower live public-host canary route set against `https://pharos.watch`, while the broader overflow sweep remains on the local artifact smoke. On `push`, worker deploy and API smoke are skipped entirely when the diff does not touch worker/shared runtime, Worker operational scripts, or worker-deploy/validate infrastructure files, and Pages build/deploy are skipped entirely when the diff does not touch Pages-impacting paths (`src/`, `shared/`, `functions/`, `public/`, `data/`, selected build/config scripts, shared validate/guardrail infrastructure, or Pages/deploy workflow files). Both production-changing workflows also share one global `concurrency` group (`production-deploy`): push/manual deploys and Pages rebuilds queue behind any active production deploy instead of canceling or overlapping post-promotion smoke or rollback work, including manual dispatches from non-main refs. The worker release path still applies D1 migrations before preview smoke and production promotion, so the normal path explicitly supports only backward-compatible D1 migrations; destructive cleanup requires a separate coordinated rollout after the new worker code is serving.

## Runtime Measurement Notes

When reviewing deploy runtime after optimization work, separate queue time from job execution time because the shared `production-deploy` concurrency group can make a healthy run appear slow while it waits for another production-changing workflow. Compare like-for-like paths: combined worker + Pages deploys, worker-only deploys, Pages-only deploys, and scheduled Pages rebuilds have different expected critical paths.

For combined deploys, the expected overlap is that `pages-prepare` starts after the uploaded Worker preview has passed smoke, then `pages-publish` waits for production `smoke-api` before publishing. Treat preview-backed Pages preparation as a rehearsal of the candidate API, not a replacement for production smoke; the production API smoke still protects custom-domain, route, trigger, and account-side differences that preview URLs do not cover.

Tooling cache restores are best-effort acceleration for `.next/cache`, `.cache/eslint`, and TypeScript build info. Cold-cache runs should remain valid and may be slower; investigate cache behavior only when repeated warm-cache deploys fail to reuse unchanged build, lint, or typecheck work.

## Runtime Origins

The current origin split is:

- public UI: `pharos.watch`
- website data API target: `site-api.pharos.watch` in production; preview/local rehearsal may intentionally point the Pages proxy at `api.pharos.watch`
- operator UI: `ops.pharos.watch`
- public API: `api.pharos.watch`
- operator API: `ops-api.pharos.watch`

The browser-facing website data lane is same-origin `/_site-data/*` on the Pages project. Production Pages hosts proxy that lane with `SITE_API_SHARED_SECRET` to the explicit `SITE_API_ORIGIN` target and fail closed when that binding is missing; preview/local rehearsal may still point the same lane at `api.pharos.watch` when `SITE_API_ORIGIN` is intentionally unset only for exempt routes, auth-off/report-only tests, Worker previews, or proxy setups that also forward a valid API key. The Pages project must also bind the shared D1 database as `DB` so `/_site-data/*` cache hits and proxy outcomes are recorded for `/api/request-source-stats`. Worker route declarations for `site-api.pharos.watch` and `ops-api.pharos.watch` live in `worker/wrangler.toml` and deploy with the normal Worker job. The Pages custom domains plus Cloudflare Access applications for the ops surfaces are account-side setup and are documented in [operator-origin-access.md](./operator-origin-access.md).

## Failure Policy

If `test:merge-gate` fails:

1. Do not push `main`.
2. Fix the failing change (or revert local merge commit).
3. Re-run `npm run test:merge-gate`.
4. Push only after passing.
