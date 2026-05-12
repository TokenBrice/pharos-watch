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
git worktree add ".worktrees/$FEATURE_NAME" -b "$BRANCH_NAME" origin/main
```

2. Implement and test in that worktree branch.
3. Merge the branch into local `main`.

```bash
git checkout main
git pull --ff-only origin main
git merge --no-ff "$BRANCH_NAME"
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

1. Pushes that update `refs/heads/main`: runs `npm run test:merge-gate` against the exact `remote_sha...local_sha` range Git sends to the hook, matching the `github.event.before...github.sha` range used by `.github/workflows/deploy-cloudflare.yml`.
2. A new remote `main` push, where Git has no previous remote SHA, forces the full local deploy validate path.
3. Other pushes fall back to the default local merge-gate range (`origin/main...HEAD`) so branch pushes still receive the existing safety check.
4. Push is blocked on failure.

## What `test:merge-gate` Does

`scripts/test-merge-gate.mjs` compares `MERGE_GATE_BASE_REF...MERGE_GATE_HEAD_REF` (default `origin/main...HEAD`) and mirrors the deploy-path validate policy locally. The pre-push hook sets those refs from Git's pushed main ref update so the local changed-file set matches the deploy workflow's push classifier.

Default policy:

1. If the diff does not touch Pages or worker deploy surfaces, print the changed-file set and skip the gate.
2. For deploy-impacting diffs, run the shared validate pre-build command set from `scripts/lib/validate-contract.mjs`. That registry is the source of truth for dependency/pricing audits, lint/typecheck, import boundaries, cycle detection across `shared/`, `worker/src`, and `src`, migrations, cron schedule/connection checks, documentation/generated-artifact checks, env contracts, duplicate exports, redemption-backstop registry checks, unused code, hotspot ratchets, SQL-safety, stablecoin data validation, and supply-helper usage.
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

- `npm run test:merge-gate -- --staged` to diff staged files instead of the default ref range
- `MERGE_GATE_BASE_REF=<ref>` to override the default compare base (`origin/main`)
- `MERGE_GATE_HEAD_REF=<ref>` to override the default compare head (`HEAD`)
- `MERGE_GATE_FULL_DEPLOY=1` to force the full local deploy validate path when there is no usable base ref
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
   - emits `deploy_required`, `worker_changed`, `worker_promotion_required`, and `pages_changed`
   - decides separately whether Worker validation, Worker production promotion, and Pages deploy work are actually required for that push
   - treats Pages release workflow changes (`.github/workflows/pages-prepare.yml`, `.github/workflows/pages-publish.yml`, `.github/workflows/pages-release.yml`, `.github/workflows/rebuild-pages.yml`) as Pages-impacting so workflow-only changes still rehearse the Pages path
   - keeps `worker_changed=true` broad for Worker typecheck/guardrail coverage, but only sets `worker_promotion_required=true` for deployed Worker runtime/config, D1 migrations, Worker assets, shared runtime files, and root package/lock changes that can change the production Worker bundle
   - defaults to the full deploy path on `workflow_dispatch`
2. `validate`
   - runs only when `deploy_required=true`
   - always includes `npm run audit:deps`, `npm run audit:pricing-providers`, lint, policy/guardrail checks (including verified-doc link and env-contract validation), `npm run test:noncritical`, and `npm run coverage:critical`
   - includes `npm run build` + `npm run seo:check` only when `pages_changed=true`
   - includes `npm run typecheck:worker` and `npm run typecheck:worker-scripts` only when `worker_changed=true`
   - after `npm run validate:prebuild`, runs independent Pages build/SEO, non-critical-test, critical-coverage, and Worker typecheck groups in parallel through `scripts/run-validate-postbuild.mjs`; `npm run build` still precedes `npm run seo:check`, and `VALIDATE_POSTBUILD_SERIAL=1` restores the old serial shape for debugging
   - installs Node 24.x, matching the repo engine baseline; there is no separate LTS proof lane because Node 24 is the primary contract
   - pull requests call the same reusable workflow with diff-derived `pages_changed` and `worker_changed` inputs, so PR Pages build/SEO and worker typecheck coverage follows the deploy-surface classifier while the shared non-deploy guardrails and tests still run on every PR
3. `no-deploy-required`
   - runs only when `deploy_required=false`
   - records an explicit no-op outcome for docs-only or other non-deploy pushes to `main`
4. `deploy-worker`
   - split into early non-mutating candidate preparation and gated production promotion:
     - `upload-worker-version` captures the currently live production version ID and uploads the candidate with `cd worker && npx --no-install wrangler versions upload` as soon as `detect-changes` confirms Worker promotion is required
     - `deploy-worker` waits for the aggregate `validate / validate` job, reruns `npm run check:migrations`, applies D1 migrations via `cd worker && npx --no-install wrangler d1 migrations apply stablecoin-db --remote`, smokes the uploaded preview URL with `SMOKE_API_KEY`, and then promotes that exact preview-smoked version with `cd worker && npx --no-install wrangler versions deploy <version-id>@100`
   - runs `cd worker && npx --no-install wrangler triggers deploy` after promotion to explicitly sync cron/routes/domain triggers and other non-versioned trigger settings
   - uploads the candidate before validation completes so Pages preparation can use the preview URL early; remote D1 apply still waits for validation and the migration guard
   - relies on the `check:migrations` rollout-safety contract for new migrations: standard deploy only supports backward-compatible D1 changes because the old worker can still receive traffic until the promoted version is live
   - runs production `npm run test:smoke-api` in the same job after promotion and automatically rolls back to the captured previous Worker version if that production API smoke fails
   - skipped on Pages-only, validation-only, or non-deploy `push` events where `detect-changes` reports `worker_promotion_required=false`
5. `pages-release`
   - production deploy job in `.github/workflows/deploy-cloudflare.yml`
   - runs only when `detect-changes` reports `pages_changed=true`
   - waits for `upload-worker-version` only when Worker promotion was also required for the push, then uses the uploaded Worker's preview URL for digest sync and local `/_site-data/*` proxying so CI rehearses the static export against the candidate API while validation and Worker promotion continue on their own runners
   - executes the Pages build/local-smoke/publish path in one job:
     - fetches `/api/digest-archive` once from the selected API environment into `data/digests.json`, sending `DIGEST_API_KEY` from GitHub repository secrets and forwarding `NEXT_PUBLIC_GA_ID` from GitHub repo vars into `npm run build`, then runs `npm run seo:check`, serves the same local artifact with `npm run serve:static-export`, proxies direct `/api/*` calls to the selected public API base, proxies `/_site-data/*` to the CI-provided `STATIC_EXPORT_SITE_API_BASE` worker target and injects `SITE_API_SHARED_SECRET` for that hop, and verifies the expected GA snippet in the homepage shell or root static RSC payload when `SMOKE_UI_EXPECT_GA_ID` is configured
     - the local static-export server treats exact `/api` and `/api/` as the public API access page, serves checked-in/static route payload artifacts below `/api/` when present, and proxies endpoint-like `/api/*` requests including JSON `POST` bodies to the selected public API base
   - uses `SMOKE_UI_BROWSER_CHANNEL=chrome` and `SMOKE_UI_OVERFLOW_WORKERS=6` for the local smoke so the full local overflow route set remains covered without downloading a Playwright-managed browser in the release job
   - waits for the aggregate `validate / validate` job before Cloudflare Pages production publish
   - captures the current Cloudflare Pages production deployment id as a best-effort rollback target, publishes the already verified local artifact through Wrangler with the existing retry loop, and runs live public UI, ops, and transport smokes in parallel in the same job; the live public UI check skips overflow because the full overflow sweep already ran against the exact local artifact before publish
   - calls `scripts/rollback-pages-deployment.mjs` when `deploy-pages` succeeded but the live public UI smoke failed and a previous deployment id is available; the overall workflow still surfaces as failed so the incident is visible
6. `smoke-ui-live`
   - worker-only deploy path runs inside `deploy-worker` after production API smoke
   - Pages-including deploy path runs inside `pages-release` after `deploy-pages`
   - verifies the live Pages frontend works against the production API, including the expected GA snippet when configured
7. `smoke-ops`
   - private post-deploy ops smoke against `ops.pharos.watch/admin/` and `ops-api.pharos.watch`
   - runs inside `pages-release` after `deploy-pages` on Pages-including deploys, or inside `deploy-worker` on worker-only deploys
   - runs in parallel with the public live UI smoke because it only depends on the production deployment being live
   - requires repository secrets `OPS_SMOKE_CF_ACCESS_CLIENT_ID` and `OPS_SMOKE_CF_ACCESS_CLIENT_SECRET`
   - UI check accepts either an Access redirect or a token-backed HTML response, so CI does not depend on the UI app also granting `Service Auth`
   - same-origin `ops.pharos.watch/api/admin/status` starts as soon as the UI Access cookie is available and retries transient `502`/`504` gateway responses up to twice to absorb operator-status warmup immediately after promotion, but persistent proxy failures still fail the deploy
   - production deploys use `SMOKE_OPS_SCOPE=canary` to keep ops shell/access plus direct and same-origin status checks on the critical path; the default full scope still covers slower status-history, admin-list, audit, and blacklist dry-run probes when run manually

8. `smoke-transport`
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

- `eslint@10`
- `typescript@6`

Scheduled/manual Pages rebuild sequence in `.github/workflows/rebuild-pages.yml`:

1. `pages-release`
   - reuses the same `.github/workflows/pages-release.yml` wrapper as push/manual production deploys
   - that reusable wrapper composes `.github/workflows/pages-prepare.yml` and `.github/workflows/pages-publish.yml` into the standard build/smoke/deploy path
   - the publish phase includes the post-publish live public-host smoke plus the `smoke-ops` and `smoke-transport` jobs; those smokes are inside the reusable Pages publish workflow, not separate jobs after the caller's `pages-release` job

This workflow intentionally skips `validate`, `deploy-worker`, and `smoke-api`; it exists to refresh the Pages export after digest generation without redeploying unchanged worker code. It still runs the ops and transport post-deploy smoke lanes so custom-domain regressions fail visibly.

GitHub-owned JS actions in this workflow are pinned by full commit SHA. When bumping an action version, resolve the tag against the upstream action repo and pin that real commit SHA, not an unavailable tarball or transient hash.

Cloudflare deployment intentionally uses the local Wrangler CLI instead of `cloudflare/wrangler-action`. The repo now uses a root npm workspace, so the workflows install the shared toolchain from the root `package-lock.json` and run Wrangler from the `worker` workspace with `npx --no-install`, keeping worker deploys insulated from GitHub Actions runtime deprecations in third-party JS actions. Worker production releases now use Wrangler Versions plus Preview URLs: CI uploads a candidate version early, waits for validation before D1 mutation, smokes that preview inside `deploy-worker`, then promotes that exact version to production traffic. The validate and Pages release lanes also restore `.next/cache`, `.cache/eslint`, and `*.tsbuildinfo` outputs so unchanged build/lint/typecheck work can be reused across runs. The repo engine floor is Node 24 LTS for the primary local/runtime baseline.

Deployment stops on the first failed job. Pull requests run the shared validate gate with the same deploy-surface classifier used by push deploys: shared guardrails and the full deploy test surface always run, while Pages build/SEO and Worker runtime plus operational-script typechecks run only when the PR diff touches those surfaces. Push/manual deploy validation also skips Pages build/SEO on worker-only pushes, skips Worker typechecks on Pages-only pushes, and skips the production workflow entirely for non-deploy pushes. The Node 24 validate lane starts `validate:prebuild`, non-critical-test shards, critical coverage, and conditional typechecks as independent jobs, then uses the aggregate `validate / validate` job to require every needed result. The deploy workflow no longer waits for all of that runner work before starting non-mutating Cloudflare preparation: it uploads the Worker candidate early and starts the Pages build/local-smoke job as soon as the preview URL is available. Production D1 mutation, Worker promotion, and Pages publish still wait for the aggregate `validate / validate` result. The production Pages path fetches digests once inside `pages-release` and requires the local `smoke-ui` gate before `deploy-pages`, so a bad static export is blocked before Cloudflare Pages production publish and the build itself no longer depends on the live production digest endpoint. On combined Worker-promotion + Pages deploys, the prepublish Pages path runs against the uploaded Worker preview URL in parallel with validation and Worker release preparation. After publish, `pages-release` runs a homepage/GA/data-state live public-host smoke against `https://pharos.watch`, while the broader overflow sweep remains on the local artifact smoke. The production ops smoke runs in canary scope on the deploy critical path, keeping shell/access and status coverage while leaving the slower deep admin probes for explicit full smoke runs. On `push`, Worker deploy and API smoke are skipped entirely when the diff does not touch deployed Worker runtime/config, D1 migrations, Worker assets, shared runtime files, or root package/lock entries that can affect the Worker bundle, even if broader Worker validation still runs for package/tooling changes. Pages build/deploy are skipped entirely when the diff does not touch Pages-impacting paths (`src/`, `shared/`, `functions/`, `public/`, `data/`, selected build/config scripts, shared validate/guardrail infrastructure, or Pages/deploy workflow files). Both production-changing workflows also share one global `concurrency` group (`production-deploy`): push/manual deploys and Pages rebuilds queue behind any active production deploy instead of canceling or overlapping post-promotion smoke or rollback work, including manual dispatches from non-main refs. The worker release path still applies D1 migrations before preview smoke and production promotion, so the normal path explicitly supports only backward-compatible D1 migrations; the release runner reruns `check:migrations` immediately before remote apply and still requires a separate coordinated rollout for destructive cleanup after the new worker code is serving. Automatic worker rollback only changes traffic back to the previous Worker version; D1 schema/data rollback remains a separate D1 recovery step.

## Runtime Measurement Notes

When reviewing deploy runtime after optimization work, separate queue time from job execution time because the shared `production-deploy` concurrency group can make a healthy run appear slow while it waits for another production-changing workflow. Compare like-for-like paths: combined worker + Pages deploys, worker-only deploys, Pages-only deploys, and scheduled Pages rebuilds have different expected critical paths.

For combined deploys, the expected overlap is that `pages-release` starts after `upload-worker-version` exposes the Worker preview URL, then waits for the aggregate validation result before production Pages publish. Treat preview-backed Pages preparation as a rehearsal of the candidate API, not a replacement for production smoke; the production API smoke still protects custom-domain, route, trigger, and account-side differences that preview URLs do not cover.

Tooling cache restores are best-effort acceleration for `.next/cache`, `.cache/eslint`, and TypeScript build info. Cold-cache runs should remain valid and may be slower; investigate cache behavior only when repeated warm-cache deploys fail to reuse unchanged build, lint, or typecheck work.

## Runtime Origins

The current origin split is:

- public UI: `pharos.watch`
- website data API target: `site-api.pharos.watch` in production; preview/local rehearsal may intentionally point the Pages proxy at `api.pharos.watch`
- operator UI: `ops.pharos.watch`
- public API: `api.pharos.watch`
- operator API: `ops-api.pharos.watch`

The browser-facing website data lane is same-origin `/_site-data/*` on the Pages project. Every Pages host (production and preview) proxies that lane with `SITE_API_SHARED_SECRET` to the explicit `SITE_API_ORIGIN` target and fails closed when the binding is missing. The lane also gates inbound requests on the caller's `Origin` (or `Referer` fallback); only `pharos.watch`, `ops.pharos.watch`, `stablecoin-dashboard.pages.dev`, and subdomains of `stablecoin-dashboard.pages.dev` are accepted. Binding the shared D1 database as `DB` is optional and enables `/_site-data/*` cache-hit/proxy-outcome attribution for `/api/request-source-stats`; without it the proxy still serves allowed reads and skips telemetry writes. Worker route declarations for `site-api.pharos.watch` and `ops-api.pharos.watch` live in `worker/wrangler.toml` and deploy with the normal Worker job. The Pages custom domains plus Cloudflare Access applications for the ops surfaces are account-side setup and are documented in [operator-origin-access.md](./operator-origin-access.md).

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
db_name=pharos-watch

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
2. Fix the failing change (or revert local merge commit).
3. Re-run `npm run test:merge-gate`.
4. Push only after passing.
