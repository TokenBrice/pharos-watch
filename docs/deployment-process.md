# Deployment Process

## Purpose

This document defines the production deploy flow and the required local gate for merged worktree changes.

## Core Rules

1. Pull requests into `main` run the shared validation gate in GitHub Actions; production deploys still ship from pushes to `main` and the deploy workflow also supports a daily scheduled rebuild plus manual `workflow_dispatch`.
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

## Optional Pre-Push Hook (Recommended)

To auto-run the merge gate when pushing `main`, enable repo hooks:

```bash
git config core.hooksPath .githooks
```

Hook behavior:

1. Push to non-`main` branch: no gate.
2. Push to `main`: runs `npm run test:merge-gate` and blocks push on failure.

## What `test:merge-gate` Does

`scripts/test-merge-gate.mjs` compares current `HEAD` to merge-base with `origin/main` and runs a delta-aware command set.

Default policy:

1. Documentation changes:
   - `npm run check:doc-counts`
2. Critical API/shared contract changes:
   - `npm run test:critical-contracts`
   - `npm run coverage:critical`
3. Cron/worker-lib changes:
   - `npm run test:invariants`
   - `npm run coverage:critical`
4. Workflow/gate infra changes:
   - `npm test`
   - `npm run coverage:critical`
5. TypeScript/JavaScript changes additionally run:
   - `npm run lint`
   - `cd worker && npx tsc --noEmit`
6. Frontend export / SEO-critical changes additionally run:
   - `npm run build`
   - `npm run seo:check`

The gate stays lighter than CI on purpose: it is still diff-driven and does not run the deploy-time smoke suites locally by default.

Useful merge-gate controls:

- `npm run test:merge-gate -- --staged` to diff staged files instead of `merge-base ... HEAD`
- `MERGE_GATE_BASE_REF=<ref>` to override the default compare base (`origin/main`)
- `MERGE_GATE_DRY_RUN=1` to print the command plan without executing it

## CI Deploy Sequence

Defined across:

- `.github/workflows/validate-ci.yml` for the shared validate gate
- `.github/workflows/pull-request-checks.yml` for pull-request validation on `main`
- `.github/workflows/deploy-cloudflare.yml` for main-branch deploys that reuse the same validate gate

Deploy sequence in `.github/workflows/deploy-cloudflare.yml`:

1. `validate`
   - includes `npm run audit:deps`
   - includes `npm run check:cron-sync`
   - includes `npm run check:doc-counts`
   - includes `npm run check:duplicate-exports`
2. `detect-changes`
   - diffs `github.event.before..github.sha` on `push`
   - decides whether worker/API deploy work is actually required for that push
   - defaults to the full deploy path on `schedule` and `workflow_dispatch`
3. `deploy-worker`
   - applies D1 migrations via `cd worker && npx --no-install wrangler d1 migrations apply stablecoin-db --remote`
   - runs `cd worker && npx --no-install wrangler deploy`
   - runs `cd worker && npx --no-install wrangler triggers deploy` to explicitly sync cron/routes/domain triggers after the worker deploy
   - skipped on frontend-only `push` events where `detect-changes` reports no worker/API-impacting files
4. `smoke-api`
   - also skipped on those frontend-only `push` events
5. `build-pages`
   - runs `npm run sync:digests`
   - runs `npm run build`
   - runs `npm run seo:check`
   - uploads the built `out/` export as a reusable artifact
   - waits for `smoke-api` only when worker/API work was required for the push
6. `smoke-ui`
   - downloads the built `out/` artifact
   - serves it locally with `scripts/serve-static-export.mjs`
   - proxies `/api/*` to the configured public API base so browser smoke runs against the same rendered bundle before production deploy
7. `deploy-pages`
   - downloads the same `out/` artifact that passed `smoke-ui`
   - uses the workspace-installed Wrangler CLI (`npx --no-install wrangler`) with explicit retries for transient Pages API failures during `pages deploy`
8. `smoke-ops`
   - private post-deploy ops smoke against `ops.pharos.watch/admin/` and `ops-api.pharos.watch`
   - requires repository secrets `OPS_SMOKE_CF_ACCESS_CLIENT_ID` and `OPS_SMOKE_CF_ACCESS_CLIENT_SECRET`
   - UI check accepts either an Access redirect or a token-backed HTML response, so CI does not depend on the UI app also granting `Service Auth`

GitHub-owned JS actions in this workflow are pinned by full commit SHA. When bumping an action version, resolve the tag against the upstream action repo and pin that real commit SHA, not an unavailable tarball or transient hash.

Cloudflare deployment intentionally uses the local Wrangler CLI instead of `cloudflare/wrangler-action`. The repo now uses a root npm workspace, so the workflow installs the shared toolchain from the root `package-lock.json` and runs Wrangler from the `worker` workspace with `npx --no-install`, keeping worker deploys insulated from GitHub Actions runtime deprecations in third-party JS actions.

Deployment stops on the first failed job. Because `deploy-pages` now waits on the local `smoke-ui` gate, a bad static export is blocked before Cloudflare Pages production publish instead of being discovered only after the live site has already switched. On `push`, worker deploy and API smoke are now skipped entirely when the diff does not touch worker/shared runtime or worker-deploy infrastructure files.

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
