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
2. For deploy-impacting diffs, always run the shared validate core:
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
3. If Pages-impacting files changed, additionally run:
   - `npm run build`
   - `npm run seo:check`
4. If worker-impacting files changed, additionally run:
   - `cd worker && npx tsc --noEmit`

Pages-impacting files now use the same broad matcher as CI deploy classification: any `src/`, `shared/`, `functions/`, `public/`, or `data/` path, selected build/config scripts, and the Pages release workflow files all require local export validation. Worker-impacting files use the same worker/shared/deploy-infra matcher as CI. The gate still skips deploy-time smoke suites locally.

Useful merge-gate controls:

- `npm run test:merge-gate -- --staged` to diff staged files instead of `merge-base ... HEAD`
- `MERGE_GATE_BASE_REF=<ref>` to override the default compare base (`origin/main`)
- `MERGE_GATE_DRY_RUN=1` to print the command plan without executing it

## CI Deploy Sequence

Defined across:

- `.github/workflows/validate-ci.yml` for the shared validate gate
- `.github/workflows/dependency-audit.yml` for the scheduled full dependency audit
- `.github/workflows/pull-request-checks.yml` for pull-request validation on `main`
- `.github/workflows/deploy-cloudflare.yml` for push/manual production deploys that reuse the same validate gate
- `.github/workflows/pages-prepare.yml` for the reusable Pages build + local smoke path
- `.github/workflows/pages-publish.yml` for the reusable Pages publish + live smoke path
- `.github/workflows/pages-release.yml` for the shared Pages build/smoke/deploy path
- `.github/workflows/rebuild-pages.yml` for the scheduled/manual Pages-only rebuild path

Deploy sequence in `.github/workflows/deploy-cloudflare.yml`:

1. `detect-changes`
   - diffs `github.event.before..github.sha` on `push`
   - emits `deploy_required`, `worker_changed`, and `pages_changed`
   - decides separately whether worker/API deploy work and Pages deploy work are actually required for that push
   - treats Pages release workflow changes (`.github/workflows/pages-prepare.yml`, `.github/workflows/pages-publish.yml`, `.github/workflows/pages-release.yml`, `.github/workflows/rebuild-pages.yml`) as Pages-impacting so workflow-only changes still rehearse the Pages path
   - defaults to the full deploy path on `workflow_dispatch`
2. `validate`
   - runs only when `deploy_required=true`
   - always includes `npm run audit:deps`, lint, policy/guardrail checks, `npm test`, and `npm run coverage:critical`
   - includes `npm run build` + `npm run seo:check` only when `pages_changed=true`
   - includes `cd worker && npx tsc --noEmit` only when `worker_changed=true`
   - pull requests still call the same reusable workflow with default inputs, so PR validation stays full-strength
   - the parallel `validate-node24` job also runs `npm run build` and `npm run test:critical-contracts`
3. `no-deploy-required`
   - runs only when `deploy_required=false`
   - records an explicit no-op outcome for docs-only or other non-deploy pushes to `main`
4. `deploy-worker`
   - renamed in practice into a worker candidate + promotion path:
     - `upload-worker-version` captures the currently live production version ID, applies D1 migrations via `cd worker && npx --no-install wrangler d1 migrations apply stablecoin-db --remote`, uploads the candidate with `cd worker && npx --no-install wrangler versions upload`, then runs `npm run test:smoke-api` against that preview URL before the candidate is considered promotable
     - `deploy-worker` promotes that exact preview-smoked uploaded version with `cd worker && npx --no-install wrangler versions deploy <version-id>@100`
   - runs `cd worker && npx --no-install wrangler triggers deploy` after promotion to explicitly sync cron/routes/domain triggers and other non-versioned trigger settings
   - relies on the `check:migrations` rollout-safety contract for new migrations: standard deploy only supports backward-compatible D1 changes because the old worker can still receive traffic until the promoted version is live
   - skipped on Pages-only or non-deploy `push` events where `detect-changes` reports no worker/API-impacting files
5. `smoke-api`
   - runs after `deploy-worker`, against the real production API host
   - remains the post-promotion canary for custom-domain/runtime differences that preview URLs do not cover
6. `rollback-worker`
   - runs only when worker promotion succeeded but the post-promotion `smoke-api` failed
   - uses `cd worker && npx --no-install wrangler rollback <previous-version-id> --yes` to restore the previously live Worker version automatically
   - keeps the overall workflow failed so the incident still surfaces in GitHub Actions even when rollback succeeds
7. `pages-prepare`
   - reusable workflow call to `.github/workflows/pages-prepare.yml`
   - runs only when `detect-changes` reports `pages_changed=true`
   - waits for `upload-worker-version` only when worker/API work was also required for the push
   - on combined worker + Pages deploys, uses the uploaded Worker's preview URL for digest sync and local `/api/*` proxying so CI rehearses the static export against the exact candidate API while `deploy-worker` and `smoke-api` continue in parallel
   - executes the predeploy Pages path:
     - `build-pages` fetches `/api/digest-archive` once from the selected API environment into `data/digests.json`, forwards `NEXT_PUBLIC_GA_ID` from GitHub repo vars into `npm run build`, then runs `npm run seo:check`, and uploads `out/`
     - `smoke-ui` downloads the same artifact, serves it locally with `scripts/serve-static-export.mjs`, proxies `/api/*` to that same selected API base, and verifies the expected GA snippet when `SMOKE_UI_EXPECT_GA_ID` is configured
8. `pages-publish`
   - reusable workflow call to `.github/workflows/pages-publish.yml`
   - runs only when `detect-changes` reports `pages_changed=true`
   - waits for `pages-prepare`
   - also waits for `smoke-api` only when worker/API work was also required for the push
   - executes the publish Pages path:
     - `deploy-pages` publishes the already verified artifact through Wrangler with the existing retry loop
     - `smoke-ui-live` then runs `npm run test:smoke-ui -- --url https://pharos.watch --mode live` against the real public host, including the same GA snippet check when configured
9. `smoke-ui-live`
   - worker-only deploy path that runs `npm run test:smoke-ui -- --url https://pharos.watch --mode live`
   - verifies the live Pages frontend still works against the newly deployed worker/API when no static rebuild is needed, including the expected GA snippet when configured
10. `smoke-ops`
   - private post-deploy ops smoke against `ops.pharos.watch/admin/` and `ops-api.pharos.watch`
   - requires repository secrets `OPS_SMOKE_CF_ACCESS_CLIENT_ID` and `OPS_SMOKE_CF_ACCESS_CLIENT_SECRET`
   - UI check accepts either an Access redirect or a token-backed HTML response, so CI does not depend on the UI app also granting `Service Auth`

Separate from the deploy path, `.github/workflows/dependency-audit.yml` runs `npm audit --audit-level=high` on the full lockfile weekly and on manual dispatch so devDependency advisories are surfaced without turning them into a blocking production deploy gate.

Scheduled/manual Pages rebuild sequence in `.github/workflows/rebuild-pages.yml`:

1. `pages-release`
   - reuses the same `.github/workflows/pages-release.yml` wrapper as push/manual production deploys, which composes `.github/workflows/pages-prepare.yml` and `.github/workflows/pages-publish.yml` into the standard build/smoke/deploy path including the post-publish live public-host smoke
2. `smoke-ops`
   - runs the normal post-deploy ops smoke

This workflow intentionally skips `validate`, `deploy-worker`, and `smoke-api`; it exists to refresh the Pages export after digest generation without redeploying unchanged worker code.

GitHub-owned JS actions in this workflow are pinned by full commit SHA. When bumping an action version, resolve the tag against the upstream action repo and pin that real commit SHA, not an unavailable tarball or transient hash.

Cloudflare deployment intentionally uses the local Wrangler CLI instead of `cloudflare/wrangler-action`. The repo now uses a root npm workspace, so the workflows install the shared toolchain from the root `package-lock.json` and run Wrangler from the `worker` workspace with `npx --no-install`, keeping worker deploys insulated from GitHub Actions runtime deprecations in third-party JS actions. Worker production releases now use Wrangler Versions plus Preview URLs: CI uploads a candidate version, smokes that preview inside `upload-worker-version`, then promotes that exact version to production traffic. The validate and Pages-build lanes also restore `.next/cache`, `.cache/eslint`, and `*.tsbuildinfo` outputs so unchanged build/lint/typecheck work can be reused across runs.

Deployment stops on the first failed job. Pull requests still run the full shared validate gate, while push/manual deploy validation now skips Pages build/SEO on worker-only pushes, skips worker typecheck on Pages-only pushes, and skips the production workflow entirely for non-deploy pushes. The shared Pages release path still fetches digests once inside `build-pages` and still requires the local `smoke-ui` gate before `deploy-pages`, so a bad static export is blocked before Cloudflare Pages production publish and the build itself no longer depends on the live production digest endpoint. On combined worker + Pages deploys, the predeploy Pages path now starts as soon as the worker preview smoke succeeds and runs against that preview URL in parallel with worker promotion and post-promotion API smoke. After publish, the same shared Pages path runs a narrower live public-host canary smoke against `https://pharos.watch`, while the broader overflow sweep remains on the local artifact smoke. On `push`, worker deploy and API smoke are skipped entirely when the diff does not touch worker/shared runtime or worker-deploy infrastructure files, and Pages build/deploy are skipped entirely when the diff does not touch Pages-impacting paths (`src/`, `shared/`, `functions/`, `public/`, `data/`, selected build/config scripts, or Pages/deploy workflow files). Both production-changing workflows also share a `concurrency` group (`production-deploy-${{ github.ref }}`): push/manual deploys cancel superseded in-flight runs on the same ref, while the Pages rebuild workflow waits behind an active production deploy instead of canceling it mid-flight. The worker release path still applies D1 migrations before preview smoke and production promotion, so the normal path explicitly supports only backward-compatible D1 migrations; destructive cleanup requires a separate coordinated rollout after the new worker code is serving.

## Operator Origins

The operator-origin split is a staged rollout:

- public UI: `pharos.watch`
- operator UI: `ops.pharos.watch`
- public API: `api.pharos.watch`
- operator API: `ops-api.pharos.watch`

Worker route declarations for `ops-api.pharos.watch` live in `worker/wrangler.toml` and deploy with the normal Worker job. The Pages custom domain plus Cloudflare Access applications are account-side setup and are documented in [operator-origin-access.md](./operator-origin-access.md).

## Failure Policy

If `test:merge-gate` fails:

1. Do not push `main`.
2. Fix the failing change (or revert local merge commit).
3. Re-run `npm run test:merge-gate`.
4. Push only after passing.
