# Deployment Process

## Purpose

This document defines the production deploy flow and the required local gate for merged worktree changes.

## Core Rules

1. Code deploys normally ship from pushes to `main`; the workflow also supports a daily scheduled rebuild and manual `workflow_dispatch`.
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

1. Critical API/shared contract changes:
   - `npm run test:critical-contracts`
   - `npm run coverage:critical`
2. Cron/worker-lib changes:
   - `npm run test:invariants`
   - `npm run coverage:critical`
3. Workflow/gate infra changes:
   - `npm test`
   - `npm run coverage:critical`
4. TypeScript/JavaScript changes additionally run:
   - `npm run lint`
   - `cd worker && npx tsc --noEmit`

Docs-only changes are skipped.

## CI Deploy Sequence

Defined in `.github/workflows/deploy-cloudflare.yml`:

1. `validate`
2. `deploy-worker`
   - applies D1 migrations via `cd worker && npx --no-install wrangler d1 migrations apply stablecoin-db --remote`
   - runs `cd worker && npx --no-install wrangler deploy`
   - runs `cd worker && npx --no-install wrangler triggers deploy` to explicitly sync cron/routes/domain triggers after the worker deploy
3. `smoke-api`
4. `deploy-pages`
   - uses explicit Wrangler CLI retries for transient Pages API failures during `pages deploy`
5. `smoke-ui`

GitHub-owned JS actions in this workflow are pinned by full commit SHA. When bumping an action version, resolve the tag against the upstream action repo and pin that real commit SHA, not an unavailable tarball or transient hash.

Cloudflare deployment intentionally uses the local Wrangler CLI instead of `cloudflare/wrangler-action`. The repo now uses a root npm workspace, so the workflow installs the shared toolchain from the root `package-lock.json` and runs Wrangler from the `worker` workspace with `npx --no-install`, keeping worker deploys insulated from GitHub Actions runtime deprecations in third-party JS actions.

Deployment stops on the first failed job.

## Failure Policy

If `test:merge-gate` fails:

1. Do not push `main`.
2. Fix the failing change (or revert local merge commit).
3. Re-run `npm run test:merge-gate`.
4. Push only after passing.
