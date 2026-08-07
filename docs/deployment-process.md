# Deployment Process

> **Agent navigation** — Grep the heading you need instead of reading wholesale: Purpose · Core Rules · Release Snapshot State Machine · Optional Worktree Flow · Repo Pre-Push Hook · Local Validation Commands · Yield History Cleanup Windows · CI Deploy Sequence · Operational Acceptance · GitHub Deploy Inputs · Dependency Refresh Cadence · Runtime Measurement Notes · Runtime Origins · Self-Serve API Key Rollback · Failure Policy.

## Purpose

This document defines the production deploy flow, the GitHub Actions release gate, and optional local validation for production-impacting work.

## Core Rules

1. Pull requests into protected `main` must pass the aggregate validation gate. The resulting merge push triggers production deployment, while a separate Pages-only rebuild workflow refreshes the static export daily. Manual production dispatch is main-only.
2. Agents and routine maintenance default to the current `main` checkout. Do not create a branch, worktree, or PR unless the maintainer explicitly asks for one. A request to push, publish, release, or take work to production is authorization to use the required protected-main branch/PR path; it is not authorization for a direct `main` push.
3. Heavy feature/refactor work may use a dedicated worktree branch when the maintainer chooses that workflow. Run focused checks before opening its PR; GitHub Actions owns the authoritative release gate.

## Release Snapshot State Machine

Treat release preparation as ordered state transitions. Passing a check against an earlier state does not validate a later commit, generated diff, or environment profile.

1. **Classify** — fetch `origin/main`, inspect committed/staged/worktree/untracked state, identify Pages and Worker impact, and preserve unrelated work.
2. **Commit source** — create logical source commits first. Use the exact `.nvmrc` Node runtime directly in the shell so nested workspace and `npx --no-install` commands inherit it.
3. **Settle commit-derived artifacts** — `docs-metadata` and `sitemap-dates` use source Git history. If their relevant sources changed, commit those sources before generation, run the owning generators, inspect the output, then commit the generated files separately or amend them into the source commit. Output generated while those source paths are uncommitted is provisional.
4. **Converge the artifact graph** — after the final source history is stable, run `npm run check:generated-artifacts`. Fixing only the first stale projection is not convergence; rerun the full check after focused fixes. If a later remediation changes a commit-derived source, return to step 3.
5. **Validate the intended contract** — use focused checks for small changes, `npm run check:pr -- --base=<ref>` for the adaptive PR contract, and `npm run check:release` only when a local production-build rehearsal is useful.
6. **Publish** — push a release branch, wait for the authoritative protected `PR gate`, merge through GitHub, and map the PR head SHA to the resulting `main` SHA and deployment run. Do not attempt direct `main` first.
7. **Prove deployment and operation separately** — verify Worker activation and/or the immutable Pages marker. Then complete any risk-based runtime observation required by [Operational Acceptance](#operational-acceptance).

## Optional Worktree Flow

Use this only when the maintainer explicitly asks for a separate worktree or branch.

1. Create a worktree from `origin/main`.

```bash
git fetch origin
git worktree add ".worktrees/$FEATURE_NAME" -b "$BRANCH_NAME" origin/main
```

2. Implement and test in that worktree branch.
3. Push the branch and open a pull request into `main`.

```bash
git push -u origin "$BRANCH_NAME"
gh pr create --base main --head "$BRANCH_NAME"
```

4. Merge only after the required `PR gate` status succeeds. The merge push triggers deployment.

## Repo Pre-Push Hook

In the standard local npm setup, `package.json` runs `scripts/maintenance/prepare-workspace.mjs` via the `prepare` script. Local installs materialize bootstrap-safe generated projections and run `git config core.hooksPath .githooks`, so the repo pre-push hook is configured automatically after install. GitHub Actions skips that implicit prepare work and runs `npm run bootstrap:generated` explicitly through `.github/actions/setup-workspace/action.yml`. If hooks were disabled or overridden locally, re-enable them with:

```bash
git config core.hooksPath .githooks
```

Hook behavior:

1. The hook runs `npm run check:commit-derived-artifacts` by default when the pushed commit is the checked-out `HEAD`. Unrelated dirty work is allowed, while dirty relevant sources or generated outputs fail the artifact check. It blocks stale committed sitemap/docs timestamps before CI has to discover the lifecycle error.
2. When a pushed ref is not the checked-out `HEAD`, the lightweight proof is skipped with an explicit unverified warning. GitHub Actions remains authoritative.
3. The hook does not run a local test/build gate. GitHub branch protection and the aggregate PR gate are authoritative.

## Local Validation Commands

`npm run check:pr -- --base=<ref>` is the local counterpart to a normal code PR. It reads the committed `base...HEAD` diff, runs changed-file lint and source typing, adds Pages/Worker/Telegram guardrails only when relevant, checks affected generated artifacts, and runs the critical plus dependency-selected Vitest files.

`npm run check:release` is the optional deeper rehearsal. It performs the Pages build, static feature/SEO checks, and a credential-free Worker bundle proof. It does not mutate Cloudflare, D1, or production state and does not replace the protected GitHub gate.

Use focused checks while iterating. Run `test:all`, full lint, typed lint, or `typecheck:tests` directly when a change affects those broad contracts; they also run in nightly/manual validation.

## Yield History Cleanup Windows

Tracked ownership handoffs and source-attribution corrections use `worker/scripts/yield-history-cleanup.ts` as an operator-run maintenance tool. When that cleanup is part of a release:

1. Deploy the read-path and hourly-purge protections first.
2. Arm the writer pause guard.
3. Verify `sync-yield-data` is not actively leased.
4. Export the targeted parent/source rows.
5. Rehearse the delete + restore drill on a local throwaway SQLite dataset.
6. Run the bounded production cleanup only after the restore drill passes.
7. Verify the parent/source rows stay absent after the next hourly writer cycle.

## CI Deploy Sequence

Production responsibility is split deliberately:

- `.github/workflows/pull-request-checks.yml` owns adaptive source validation before merge; `.github/workflows/nightly-validation.yml` retains broad regression coverage.
- `.github/workflows/zizmor.yml` analyzes workflow and composite-action changes before merge, after merge to `main`, and on its weekly backstop.
- `.github/workflows/deploy-cloudflare.yml` selects and deploys the changed production surfaces after a protected `main` merge.
- `.github/workflows/pages-release.yml` builds and publishes one exact Pages artifact.
- `.github/workflows/rebuild-pages.yml` performs the one daily API-backed Pages data refresh.
- Broad UI, accessibility, ops, analytics, asset-coherence, and transport checks remain PR, scheduled-monitor, or explicit operator commands; they do not control production mutation or automatic rollback.

Deploy sequence in `.github/workflows/deploy-cloudflare.yml`:

1. `plan`
   - rejects any ref other than `refs/heads/main`;
   - diffs `github.event.before...github.sha` for pushes and consumes only `pages_deploy_required` and `worker_deploy_required`;
   - treats root `package.json` or `package-lock.json` changes conservatively as both-surface changes instead of parsing lockfile hunks;
   - accepts an explicit manual `surface` choice: `both` (default), `pages`, or `worker`;
   - produces a successful no-op when neither surface needs deployment. There is no separate guard or no-op job.
2. `deploy-worker`
   - runs only when `worker_required=true`, on `ubuntu-latest`, with the protected `production` environment;
   - installs the lockfile workspace, runs `npm run check:migrations`, proves the strict Worker bundle with `npm run check:worker-package`, and only then applies remote D1 migrations;
   - deploys once with `cd worker && npx --no-install wrangler deploy --strict --message ...`; Wrangler synchronizes the checked-in Worker configuration and triggers as part of that supported path;
   - queries `wrangler deployments status --json` once and requires the SHA-tagged deployment to be the sole active version at 100% traffic;
   - fails visibly on migration, deploy, or activation-proof failure. It does not preview-upload, poll deployment status, make a custom-domain request from shared GitHub egress, run browser/ops/transport checks, or automatically roll back.
3. `pages-release`
   - calls the reusable Pages workflow only when `pages_required=true`;
   - uses native `needs: [plan, deploy-worker]` ordering. Pages proceeds when Worker was legitimately skipped, and stops when a required Worker deployment failed;
   - passes `refresh_data: true`, so ordinary code releases refresh digest, depeg, and public-dataset snapshots before building rather than regressing static archive routes to the committed snapshot's age.

Reusable Pages sequence in `.github/workflows/pages-release.yml`:

1. Check out at the default shallow depth and install the workspace without a browser.
2. When `refresh_data=true`, refresh digests, confirmed depeg events, and public dataset mirrors through the Origin-gated `https://stablecoin-dashboard.pages.dev/_site-data` proxy into `site-api.pharos.watch`. The digest and depeg syncs reject removal of any published slug present in the checked-in snapshot. A failed fetch, invalid input, or archive shrink restores the committed digests, depeg events, dataset mirrors, and Sheets CSV snapshots; removes untracked dataset/Sheets artifacts from the rejected refresh; and continues to the build with a job-summary warning.
3. Clear `.next`, build once with the production feature-flag environment, and preserve the selected committed or freshly refreshed data through the prebuild hook.
4. Run artifact-specific checks: feature-flag inlining, build size, build attribution, and static SEO. The release SEO check also fetches the currently deployed `pages.dev` sitemap and requires every previously published digest/depeg detail URL to remain submitted or have a direct permanent redirect to a submitted canonical. This final continuity gate covers refresh-only routes that are newer than the checked-in snapshots; a fallback build that would regress one of those routes fails before deployment.
5. Write `out/__pharos_release.json`, publish that exact `out/` directory with one `wrangler pages deploy` command, resolve the latest production deployment through `wrangler pages deployment list --json`, and require one cache-busted target-SHA marker match from that immutable `pages.dev` deployment URL within the bounded polling window.
6. Record the commit, run URL, artifact size/file count, refresh mode, immutable deployment URL, marker result, and the manual Cloudflare Pages deployment-history rollback pointer in the job summary.

There is no Pages browser installation, local proxy, GitHub Jobs API polling, deploy retry loop, broad live smoke suite, or automatic rollback in this path. The single post-publish deployment query identifies the just-published production deployment without depending on custom-domain edge treatment of GitHub shared egress. A failed marker proof leaves the failed deployment and its evidence visible for operator assessment instead of automatically changing production again.

## Operational Acceptance

Workflow success proves activation identity, not every runtime behavior. The read-only `post-deploy-acceptance` job adds narrow runtime-health evidence for each surface that successfully deployed; it records `passed`, `failed`, or explicitly `pending` in the workflow summary without mutating production or rolling anything back. Record deployment proof and operational acceptance separately.

| Change risk                     | Deployment proof                                       | Operational acceptance                                                                                                   |
| ------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Pages/static output             | Immutable deployment URL and target-SHA release marker | Narrow affected-route or live SEO smoke when the change warrants it                                                      |
| Worker request path             | SHA-tagged version at 100% traffic                     | Narrow API, transport, or owning endpoint smoke                                                                          |
| Cron/scheduler/ingestion/memory | Worker activation                                      | First matching scheduled execution completes within its expected status, duration, memory, and publication contract      |
| D1 migration plus runtime use   | Migration and Worker activation steps succeed          | First affected read/write or scheduled path succeeds; rollback notes acknowledge that Worker rollback does not revert D1 |

The acceptance job reads the public Pages shell after a Pages release and the public Worker health endpoint after a Worker release. A Worker release also records its first matching scheduled execution as `pending`, because a short deploy job cannot safely wait for and correlate a future cron run. Use `npm run ops:watch-worker-cron` for that bounded read-only cron evidence and `npm run ops:night-watch-worker` only when the owning rollout requires a longer observation window. Until the relevant execution occurs, report “deployment succeeded; operational acceptance pending” rather than “production healthy.”

## GitHub Deploy Inputs

Repository settings:

- `main` requires pull requests and the aggregate `PR gate` status check, including administrators. That job accepts either the full reusable validation path or the focused docs-only path and always requires the PR secret scan.
- The GitHub `production` environment is restricted to `main` and is attached only to the Worker and Pages mutating jobs.
- Production-changing workflows share the `production-deploy` concurrency group and do not cancel an active release.

Repository secrets consumed only by jobs attached to the production environment:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The Cloudflare credentials authorize Worker/D1 and Pages deployment. Re-enter these values as environment-scoped secrets before deleting their repository-scoped copies; GitHub does not expose existing secret values for automated migration. Secret values are never recorded in the repository. The matching Pages and Worker `SITE_API_SHARED_SECRET` bindings remain Cloudflare-managed; scheduled refreshes reach that authenticated Worker lane through the Pages proxy without exposing the secret to the GitHub runner.

The manual zone-cache recovery workflow additionally requires the Cloudflare token to grant `Zone Read` and `Cache Purge` for `pharos.watch`. Normal Pages and Worker deployment permissions do not imply those zone permissions.

The zone's free plan provides a single rate-limiting slot, held by the
deliberately disabled `api-rate-limit-ip` rule; per-endpoint ingress limiting
(API-key rates, self-serve issuance fencing, Telegram webhook dedup and
mini-app quotas) is enforced in the Worker application layer, so the drift
manifest requires exactly that one edge rule.

The scheduled Cloudflare account-state drift workflow uses the separate
repository secret `CLOUDFLARE_ACCOUNT_STATE_DRIFT_API_TOKEN`. It is a dedicated
read-only credential and is not attached to the production environment; see
[`docs/operator-origin-access.md`](./operator-origin-access.md) for its scope
and the secret-free manifest it checks.

Scheduled artifact PR secret:

- `OG_REFRESH_GITHUB_TOKEN` - bot/PAT used by `.github/workflows/og-refresh.yml` when generated OG assets changed.
- `MECHANISM_REFRESH_GITHUB_TOKEN` - optional dedicated bot/PAT for `.github/workflows/protocol-api-mechanism-refresh.yml`; that workflow falls back to the shock-coverage or OG refresh token.

The OG refresh captures the production Pages artifact through `stablecoin-dashboard.pages.dev` so shared GitHub egress does not receive the custom-domain security challenge. The capture script fails before PR creation when the response is unsuccessful, lacks the Pharos application shell, or contains Cloudflare challenge text.

Repository variables used by the Pages build:

- Optional: `NEXT_PUBLIC_GA_ID` and `NEXT_PUBLIC_PHAROS_*`

Manual dispatch examples:

```bash
gh workflow run "Deploy to Cloudflare" --repo TokenBrice/pharos-watch --ref main -f surface=both
gh workflow run "Deploy to Cloudflare" --repo TokenBrice/pharos-watch --ref main -f surface=pages
gh workflow run "Deploy to Cloudflare" --repo TokenBrice/pharos-watch --ref main -f surface=worker
gh workflow run "Rebuild Pages" --repo TokenBrice/pharos-watch --ref main
```

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

Risk-accepted transitive advisories are machine-readable in `scripts/ci/dependency-audit-exceptions.json`; the verifier rejects malformed, expired, or widened entries. The registry is the weekly workflow's authority, while this section records the review rationale. There are currently no active exceptions.

The production-scope check is `npm run audit:deps` (`npm audit --audit-level=high --omit=dev`) and reflects the deployed surface. Root manifest or lockfile PRs run it through `check:pr:static`. The weekly `dependency-audit.yml` job runs the broader full-lockfile audit through `scripts/ci/verify-dependency-audit.mjs`; it passes only when every high/critical finding is the exact, unexpired reviewed exception.

When the weekly job finds a new high/critical full-lockfile advisory, fix it, pin it away, or add a narrowly scoped, expiring registry entry with the reviewed unreachable/dev-only rationale here. Do not run `npm audit fix --force` outside a dedicated dependency tranche; forced fixes can downgrade or cross major lines.

Scheduled/manual Pages rebuild sequence in `.github/workflows/rebuild-pages.yml`:

- Schedule: `17 8 * * *` UTC, after the 08:05 UTC daily digest slot.
- The workflow has one main-only reusable job and calls `pages-release.yml` with `refresh_data: true`.
- It refreshes all three API-backed datasets through the production `stablecoin-dashboard.pages.dev/_site-data` proxy, builds and checks the exact artifact, publishes once, and verifies the release marker on the immutable production deployment URL.
- It intentionally skips Worker deployment and broad live smoke lanes. Missing or invalid refresh data fails before publication.
- Manual rebuild dispatch uses the same path and the shared `production-deploy` lock.

### Wrangler and Workspace Layout

- Cloudflare deployment uses the lockfile-installed local Wrangler CLI rather than `cloudflare/wrangler-action`.
- Worker production custom-domain routes, bindings, and cron triggers remain declared in `worker/wrangler.toml` and deploy together through `wrangler deploy --strict`.
- The root and Worker manifests keep the same pinned Wrangler version: root scripts own the shared install and dependency overrides, while Worker commands run from `worker/` with `npx --no-install`.
- The Pages release restores build cache state but does not install Playwright. Cold-cache runs remain valid.

### Failure Stop and Surface Classification

- Deployment stops on the first failed required step.
- Pull requests own full source/test validation. The post-merge workflow reruns only the focused Worker migration/activation checks and Pages artifact checks that are adjacent to production mutation.
- Worker deploy is skipped unless deployed Worker/runtime/config/shared inputs changed. Root package and lockfile changes conservatively deploy both surfaces.
- Pages publish is skipped for non-publishable or test-only Pages changes.
- A combined deployment publishes Pages only after the required Worker job succeeds; Pages-only deployment treats the skipped Worker job as expected.

### Concurrency and Rollback Scope

- Production-changing workflows share the global `production-deploy` concurrency group and queue instead of canceling one another.
- New D1 migrations must remain backward-compatible because migrations apply before the new Worker is live. Destructive cleanup requires a separate coordinated rollout.
- The default workflow never automatically rolls back from a broad or non-causal signal.
- Worker rollback is an operator decision using Cloudflare deployment history or `wrangler rollback [VERSION-ID] --yes`. It does not reverse D1 migrations, KV/R2/D1 data, secrets, bindings, or other resources.
- Pages rollback is an operator decision in Cloudflare Pages deployment history. Use the failed run's commit, deployment URL, marker response, and Wrangler output to identify the target.
- Persistent stale custom-domain HTML can use the guarded `purge-pages-zone-cache.yml` recovery workflow after the correct Pages deployment is confirmed.

## Runtime Measurement Notes

When reviewing deploy runtime after optimization work, separate queue time from job execution time because the shared `production-deploy` concurrency group can make a healthy run appear slow while it waits for another production-changing workflow. Compare like-for-like paths: combined worker + Pages deploys, worker-only deploys, Pages-only deploys, and scheduled Pages rebuilds have different expected critical paths.

For combined deploys, the native job graph runs `pages-release` only after the required Worker deployment succeeds. Pages-only deploys do not wait on a nonexistent Worker mutation.

Tooling cache restores are best-effort acceleration for `.next/cache`, `.cache/eslint`, and TypeScript build info. Cold-cache runs remain valid and may be slower. Only jobs that produce new tooling state upload a fresh cache; the Pages release restores and saves build state but carries no browser cache dependency.

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

If an explicit local `check:release` rehearsal fails:

1. Do not treat the local rehearsal as green.
2. Confirm the exact `.nvmrc` runtime, target, snapshot cleanliness, environment profile, and local concurrency before changing code. A release-only failure is not disproved by a `pr` target, and a globally exported Pages flag does not reproduce job-scoped CI.
3. For a small change, fix the failing command directly. For a large batch, run one full discovery for the intended target and read the final structured summary.
4. Fix all blocking root failures and rerun their focused commands while editing. If local parallel load is suspect, run the focused shard alone or set `MERGE_GATE_DISCOVERY_MAX_PARALLEL=1`; do not loosen timeouts solely from a contended run.
5. If producers left blocked or tainted nodes, use discovery `--resume` with the same target. Run another full discovery only when the changed snapshot broadly invalidates the original plan.
6. After the final source state, run the full generated-artifact freshness check. Commit-derived failures follow the post-commit generation sequence, not an immediate dirty-worktree rewrite.
7. Run `npm run check:release` only when an explicit local rehearsal is desired, then push to the protected PR gate. GitHub Actions remains authoritative.

If a production deployment fails after mutation:

1. Preserve the failed run, Wrangler output, target commit, and failing health/marker response.
2. Determine whether the failure is causal to the deployed surface before changing traffic again. Public WAF challenges, unrelated ops degradation, analytics, redirects, or browser-only signals are not automatic rollback evidence.
3. For a Worker code regression, choose the prior version in Cloudflare deployment history or run `wrangler rollback [VERSION-ID] --yes`. Do not claim that this reverts D1 migrations or bound-resource state.
4. For a Pages artifact regression, select the prior successful production deployment in Cloudflare Pages deployment history.
5. Run the narrow manual smoke that proves the affected surface after recovery. Broad live checks remain diagnostic evidence, not mutation triggers.

For HTTP 403, timeout, and provider failures, establish response provenance before remediation: record the exact URL, status, relevant non-secret headers, and consumed response body; distinguish Cloudflare edge/WAF handling from Worker routing, application authorization, and upstream provider behavior. Retry the same SHA only for a proven transient. A code, configuration, credential-scope, or routing change requires a new commit/run, and the deployment path must not gain a speculative retry loop.
