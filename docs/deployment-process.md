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

`scripts/test-merge-gate.mjs` compares current `HEAD` to merge-base with `origin/main` and always runs the shared CI validate core locally.

Default policy:

1. Always run the shared validate core:
   - `npm run audit:deps`
   - `npm run lint`
   - `npm run check:worker-boundary`
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
   - `cd worker && npx tsc --noEmit`
2. If Pages-impacting files changed, additionally run:
   - `npm run build`
   - `npm run seo:check`

Pages-impacting files now use the same broad matcher as CI deploy classification: any `src/`, `shared/`, `functions/`, `public/`, or `data/` path, selected build/config scripts, and the Pages release workflow files all require local export validation. The gate still skips deploy-time smoke suites locally. The only diff-driven part is whether export validation (`build` + `seo:check`) is required.

Useful merge-gate controls:

- `npm run test:merge-gate -- --staged` to diff staged files instead of `merge-base ... HEAD`
- `MERGE_GATE_BASE_REF=<ref>` to override the default compare base (`origin/main`)
- `MERGE_GATE_DRY_RUN=1` to print the command plan without executing it

## CI Deploy Sequence

Defined across:

- `.github/workflows/validate-ci.yml` for the shared validate gate
- `.github/workflows/pull-request-checks.yml` for pull-request validation on `main`
- `.github/workflows/deploy-cloudflare.yml` for push/manual production deploys that reuse the same validate gate
- `.github/workflows/pages-release.yml` for the shared Pages build/smoke/deploy path
- `.github/workflows/rebuild-pages.yml` for the scheduled/manual Pages-only rebuild path

Deploy sequence in `.github/workflows/deploy-cloudflare.yml`:

1. `validate`
   - includes `npm run audit:deps`
   - includes `npm run check:cron-sync`
   - includes `npm run check:cron-connections`
   - includes `npm run check:doc-counts`
   - includes `npm run check:doc-sync`
   - includes `npm run check:duplicate-exports`
   - includes `npm run check:redemption-backstops`
   - includes `npm run check:unused-code`
   - includes `npm run check:hotspot-ratchet`
   - includes `npm run build`
   - includes `npm run seo:check`
2. `detect-changes`
   - diffs `github.event.before..github.sha` on `push`
   - decides separately whether worker/API deploy work and Pages deploy work are actually required for that push
   - treats Pages release workflow changes (`.github/workflows/pages-release.yml`, `.github/workflows/rebuild-pages.yml`) as Pages-impacting so workflow-only changes still rehearse the Pages path
   - defaults to the full deploy path on `workflow_dispatch`
3. `deploy-worker`
   - applies D1 migrations via `cd worker && npx --no-install wrangler d1 migrations apply stablecoin-db --remote`
   - runs `cd worker && npx --no-install wrangler deploy`
   - runs `cd worker && npx --no-install wrangler triggers deploy` to explicitly sync cron/routes/domain triggers after the worker deploy
   - relies on the `check:migrations` rollout-safety contract for new migrations: standard deploy only supports backward-compatible D1 changes because the old worker can still receive traffic until the new deploy is live
   - skipped on Pages-only or docs-only `push` events where `detect-changes` reports no worker/API-impacting files
4. `smoke-api`
   - also skipped on those Pages-only or docs-only `push` events
5. `pages-release`
   - reusable workflow call to `.github/workflows/pages-release.yml`
   - runs only when `detect-changes` reports `pages_changed=true`
   - waits for `smoke-api` only when worker/API work was also required for the push
   - executes the shared Pages path:
     - `prepare-digests` fetches `/api/digest-archive` once from the target API environment and uploads a normalized digest artifact
     - `build-pages` downloads that artifact into `data/`, forwards `NEXT_PUBLIC_GA_ID` from GitHub repo vars into `npm run build`, then runs `npm run seo:check`, and uploads `out/`
     - `smoke-ui` downloads the same artifact, serves it locally with `scripts/serve-static-export.mjs`, proxies `/api/*` to the configured public API base, and verifies the expected GA snippet when `SMOKE_UI_EXPECT_GA_ID` is configured
     - `deploy-pages` publishes that verified artifact through Wrangler with the existing retry loop
     - `smoke-ui-live` then runs `npm run test:smoke-ui -- --url https://pharos.watch` against the real public host, including the same GA snippet check when configured
6. `smoke-ui-live`
   - worker-only deploy path that runs `npm run test:smoke-ui -- --url https://pharos.watch`
   - verifies the live Pages frontend still works against the newly deployed worker/API when no static rebuild is needed, including the expected GA snippet when configured
7. `smoke-ops`
   - private post-deploy ops smoke against `ops.pharos.watch/admin/` and `ops-api.pharos.watch`
   - requires repository secrets `OPS_SMOKE_CF_ACCESS_CLIENT_ID` and `OPS_SMOKE_CF_ACCESS_CLIENT_SECRET`
   - UI check accepts either an Access redirect or a token-backed HTML response, so CI does not depend on the UI app also granting `Service Auth`

Scheduled/manual Pages rebuild sequence in `.github/workflows/rebuild-pages.yml`:

1. `pages-release`
   - reuses the same `.github/workflows/pages-release.yml` build/smoke/deploy path as push/manual production deploys, including the post-publish live public-host smoke
2. `smoke-ops`
   - runs the normal post-deploy ops smoke

This workflow intentionally skips `validate`, `deploy-worker`, and `smoke-api`; it exists to refresh the Pages export after digest generation without redeploying unchanged worker code.

GitHub-owned JS actions in this workflow are pinned by full commit SHA. When bumping an action version, resolve the tag against the upstream action repo and pin that real commit SHA, not an unavailable tarball or transient hash.

Cloudflare deployment intentionally uses the local Wrangler CLI instead of `cloudflare/wrangler-action`. The repo now uses a root npm workspace, so the workflows install the shared toolchain from the root `package-lock.json` and run Wrangler from the `worker` workspace with `npx --no-install`, keeping worker deploys insulated from GitHub Actions runtime deprecations in third-party JS actions.

Deployment stops on the first failed job. Because the shared `validate` gate now also runs `npm run build` and `npm run seo:check`, pull requests and push/manual deploy validation catch static-export failures before any production-changing job starts. The shared `pages-release` workflow still fetches digests once into an artifact and still requires the local `smoke-ui` gate before `deploy-pages`, so a bad static export is blocked before Cloudflare Pages production publish and the build itself no longer depends on the live production digest endpoint. After publish, the same shared Pages workflow now also runs a live public-host smoke against `https://pharos.watch`, which closes the remaining gap between local artifact smoke and the actual Pages domain. On `push`, worker deploy and API smoke are skipped entirely when the diff does not touch worker/shared runtime or worker-deploy infrastructure files, and Pages build/deploy are skipped entirely when the diff does not touch Pages-impacting paths (`src/`, `shared/`, `functions/`, `public/`, `data/`, selected build/config scripts, or Pages/deploy workflow files). Both production-changing workflows also share a `concurrency` group (`production-deploy-${{ github.ref }}`): push/manual deploys cancel superseded in-flight runs on the same ref, while the Pages rebuild workflow waits behind an active production deploy instead of canceling it mid-flight. The worker deploy step still applies D1 migrations before `wrangler deploy`, so the normal path now explicitly supports only backward-compatible D1 migrations; destructive cleanup requires a separate coordinated rollout after the new worker code is serving.

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
