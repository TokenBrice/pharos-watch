# Deployment Process

> **Agent navigation** — Grep the heading you need instead of reading wholesale: Purpose · Core Rules · Release Snapshot State Machine · Optional Worktree Flow · Worktree hygiene · Repo Pre-Commit Hook · Local Validation Commands · Yield History Cleanup Windows · CI Deploy Sequence · Operational Acceptance · GitHub Deploy Inputs · Dependency Refresh Cadence · Runtime Measurement Notes · Runtime Origins · Self-Serve API Key Rollback · Failure Policy.

## Purpose

This document defines the production deploy flow, the GitHub Actions release gate, and optional local validation for production-impacting work.

## Core Rules

1. Pull requests into protected `main` must pass the aggregate validation gate. The resulting merge push triggers production deployment, while a separate Pages-only rebuild workflow refreshes the static export daily. Manual production dispatch is main-only.
2. Agents and routine maintenance default to the current `main` checkout. Do not create a branch, worktree, or PR unless the maintainer explicitly asks for one. A request to push, publish, release, or take work to production is authorization to use the required protected-main branch/PR path; it is not authorization for a direct `main` push.
3. Merge release pull requests with a merge commit (`gh pr merge --merge`), never with squash or rebase merge. Before declaring the release merged, verify the resulting `main` commit has two parents and contains the recorded PR head SHA.
4. Heavy feature/refactor work may use a dedicated worktree branch when the maintainer chooses that workflow. Run focused checks before opening its PR; GitHub Actions owns the authoritative release gate.

## Release Snapshot State Machine

Treat release preparation as ordered state transitions. Passing a check against an earlier state does not validate a later commit, generated diff, or environment profile.

1. **Classify** — fetch `origin/main`, inspect committed/staged/worktree/untracked state, identify Pages and Worker impact, and preserve unrelated work.
2. **Commit source** — create logical source commits first. Use the exact `.nvmrc` Node runtime directly in the shell so nested workspace and `npx --no-install` commands inherit it.
3. **Converge the artifact graph** — after the final source history is stable, run `npm run check:generated-artifacts`. Fixing only the first stale projection is not convergence; rerun the full check after focused fixes.
4. **Validate the intended contract** — use focused checks for small changes, `npm run check:pr -- --base=<ref>` for the adaptive PR contract, and `npm run check:release` only when a local production-build rehearsal is useful.
5. **Publish** — push a release branch, wait for the authoritative protected `PR gate`, merge through GitHub, and map the PR head SHA to the resulting `main` SHA and deployment run. Do not attempt direct `main` first.
6. **Prove deployment and operation separately** — verify Worker activation and/or the immutable Pages marker. Then complete any risk-based runtime observation required by [Operational Acceptance](#operational-acceptance).

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

## Worktree hygiene

Auto-isolated or linked worktrees are disposable only when clean and their branch is merged to `main` (or patch-equivalent: `git cherry main <branch>` shows only `-`). Never remove an unmerged branch on age alone.
Exclude `.worktrees/` and `.claude/worktrees/` from repository-wide searches. Review output before removal; removal requires the clean-and-merged result or explicit owner approval.

```bash
git worktree list --porcelain
git branch --merged main
git worktree list --porcelain | awk '/^worktree /{print substr($0,10)}' | while IFS= read -r wt; do
  [ "$wt" = "$PWD" ] && continue; branch=$(git -C "$wt" branch --show-current); clean=$(git -C "$wt" status --short)
  if [ -n "$branch" ] && [ -z "$clean" ] && git merge-base --is-ancestor "$branch" main; then
    printf 'eligible: %s (%s)\n' "$wt" "$branch"; else printf 'preserve/review: %s (%s)\n' "$wt" "${branch:-detached}"; fi
done
git worktree prune --dry-run
```

## Repo Pre-Commit Hook

Hook installation, generated-artifact synchronization, staging, abort, no-op, bypass, and non-validation behavior are owned by [Pre-Commit Hook Mechanics](./scripts.md#pre-commit-hook-mechanics).

## Local Validation Commands

Validation behavior for `check:pr`, `check:release`, focused iteration, and nightly/manual lanes is owned by [Testing: Commands](./testing.md#commands) and the [smallest adequate check matrix](./testing.md#smallest-adequate-check-per-area).

## Yield History Cleanup Windows

Tracked ownership handoffs and source-attribution corrections use `worker/scripts/yield-history-cleanup.ts` as an operator-run maintenance tool. Arming, clearing, and restoring the writer pause guard is documented in [`docs/runbooks/yield-history-cleanup-writer-pause.md`](./runbooks/yield-history-cleanup-writer-pause.md). When that cleanup is part of a release:

1. Deploy the read-path and hourly-purge protections first.
2. Arm the writer pause guard.
3. Verify `sync-yield-data` is not actively leased.
4. Export the targeted parent/source rows.
5. Rehearse the delete + restore drill on a local throwaway SQLite dataset.
6. Run the bounded production cleanup only after the restore drill passes.
7. Verify the parent/source rows stay absent after the next hourly writer cycle.

## Blacklist Current-Balance Rebuild

Use `worker/scripts/rebuild-blacklist-current-balances.ts` only after the source event set is complete:

1. Preview, then arm the writer pause with `--arm-writer-pause`; live changes require `--execute --confirm rebuild-blacklist-current-balances` and an explicit `--local` or `--remote` target.
2. Wait for the `sync-blacklist` cron lease to expire. The rebuild checks both the pause key and lease before provider work and again immediately before mutation.
3. Run the rebuild as a dry-run first. Provider lookups still run, but D1 remains unchanged; inspect `failedCount` before proceeding.
4. Run the confirmed rebuild. More than 10% provider failures abort before D1 mutation. `--force` bypasses only this failure-rate guard and should be used only after reviewing the provider failures.
5. Verify current balances, then preview and execute `--clear-writer-pause`. Do not clear the pause after a failed rebuild until the retained rows have been checked.

Active rows stay in place during the rebuild so a transient `provider_failed` result retains the last resolved native/USD amounts and source. Wrangler treats each `--file` import as its own transactional chunk; the helper must not emit explicit `BEGIN TRANSACTION` / `COMMIT` statements because D1 rejects them. A failed chunk rolls back that chunk, but earlier successful chunks remain committed, so inspect the retained rows before retrying or clearing the writer pause.

## CI Deploy Sequence

Production responsibility is split deliberately:

- Validation workflow ownership and lane composition are documented in [Testing: CI Pipeline](./testing.md#ci-pipeline).
- `.github/workflows/deploy-cloudflare.yml` selects and deploys the changed production surfaces after a protected `main` merge.
- `.github/workflows/pages-prepare.yml` installs and materializes the Worker-independent compile-input workspace without secrets or live producers.
- `.github/workflows/pages-release.yml` builds and publishes one exact Pages artifact.
- `.github/workflows/rebuild-pages.yml` performs the one daily API-backed Pages data refresh.
- `.github/workflows/dependency-scenarios-refresh.yml` independently computes and publishes offline modeled dependency artifacts hourly at minute 17 or on manual dispatch. It does not deploy code or add Worker cron work; [Dependency network operations](./runbooks/dependency-network.md#offline-scenario-workflow) owns its commands, retained artifacts, readback proof, and failure handling.

PRs do not build the static site. A successful protected merge triggers the dependency-free production deploy classifier after Node setup without installing the workspace, and the production Pages workflow performs the one authoritative build. Worker mutation retains migration checks and activation proof, then records a best-effort write-once D1 activation marker keyed by the verified Cloudflare version ID and timestamped from the matched Cloudflare deployment's `created_on`; Pages publication retains artifact checks and the release-marker proof. Static, Next compiler, and Playwright caches are separate so a job restores only the state it can consume.

Deploy sequence in `.github/workflows/deploy-cloudflare.yml`: `plan → (deploy-worker ∥ pages-prepare) → pages-release → post-deploy-acceptance`, with unselected surfaces legitimately skipped. Acceptance also runs when only one surface deployed successfully.

1. `plan`
   - rejects any ref other than `refs/heads/main`;
   - checks out full history, installs Node without the npm workspace, and invokes the dependency-free TypeScript deploy classifier directly;
   - diffs `github.event.before...github.sha` for pushes and consumes only `pages_deploy_required` and `worker_deploy_required`;
   - treats root `package.json` or `package-lock.json` changes conservatively as both-surface changes instead of parsing lockfile hunks;
   - accepts an explicit manual `surface` choice: `both` (default), `pages`, or `worker`;
   - produces a successful no-op when neither surface needs deployment. There is no separate guard or no-op job.
2. `deploy-worker`
   - runs only when `worker_required=true`, on `ubuntu-latest`, with the protected `production` environment;
   - installs the lockfile workspace, runs `npm run check:migrations`, proves the strict Worker bundle with `npm run check:worker-package`, and only then applies remote D1 migrations;
   - deploys once with `cd worker && npx --no-install wrangler deploy --strict --message ...`; Wrangler synchronizes the checked-in Worker configuration and triggers as part of that supported path;
   - uses `scripts/ci/verify-worker-deployment.ts` to GET the native Cloudflare API `/accounts/{account_id}/workers/scripts/{script_name}/deployments`, without invoking Wrangler for verification. The API's first entry is active; it must carry the SHA-tagged deploy message and exactly one version at 100% traffic. Activation time is selected by deployment identity plus verified-version match, never by sorting timestamps or using CI wall time;
   - writes `worker-version-activated:<version_id>` once into the existing D1 `cache` table using the matched Cloudflare deployment's `created_on` as both the JSON activation time and `updated_at`. Missing deployment identity or an invalid activation timestamp skips the marker with a warning; a marker-write failure also only warns. API/active-identity failures still fail deployment, while missing marker evidence leaves later reconciliation fail-closed for that version;
   - fails visibly on migration, deploy, or activation-proof failure. It does not preview-upload, poll deployment status, make a custom-domain request from shared GitHub egress, run browser/ops/transport checks, or automatically roll back.
3. `pages-prepare`
   - calls the reusable preparation workflow only when `pages_required=true`, directly after `plan` and in parallel with `deploy-worker`;
   - checks out full history, installs the workspace, and runs `npm run generated:compile-input` (the `compile-input` lifecycle of `run-generated-artifacts.ts`, through npm so generator children resolve `node_modules/.bin`), including pure and history-derived projections;
   - has no production environment or secrets and must not run live-data producers, refresh release data, acquire detail snapshots, build, or publish;
   - uploads the complete workspace as a zstd archive (upload compression disabled), preserving generated files, symlinks, and modes but excluding Git/compiler caches; exposes its run/producer-attempt/SHA artifact name as `workspace_artifact_name`.
4. `pages-release`
   - calls the reusable Pages release workflow only when `pages_required=true`;
   - uses native `needs: [plan, deploy-worker, pages-prepare]` ordering. Release requires successful preparation and any required Worker deployment; it proceeds when Worker was legitimately skipped;
   - passes `refresh_data: true`, so ordinary code releases refresh digest, depeg, and public-dataset snapshots before building rather than regressing static archive routes to the committed snapshot's age.

5. `post-deploy-acceptance`
   - runs read-only identity and health probes for successfully deployed surfaces, with Node setup but no npm install or generated bootstrap; see [Operational Acceptance](#operational-acceptance).

The daily/manual `.github/workflows/rebuild-pages.yml` runs `pages-prepare → pages-release` on `main`, with `refresh_data: true` and no Worker deployment.

Reusable Pages sequence in `.github/workflows/pages-release.yml`:

1. Check out full history, set up Node without reinstalling dependencies, validate the supplied `workspace_artifact_name` against this run/SHA, and restore that exact producer-owned artifact. Production Pages builds never restore `.next/cache`: stale Webpack/PostCSS entries can pair new Tailwind HTML classes with older CSS. History-derived compile inputs arrive from preparation; full history remains available for post-refresh fallbacks and checks.
2. When `refresh_data=true`, `scripts/maintenance/refresh-pages-release-data.ts` refreshes digests and confirmed depeg events concurrently, then refreshes public dataset mirrors, all through the Origin-gated `https://stablecoin-dashboard.pages.dev/_site-data` proxy into `site-api.pharos.watch`. Digest and depeg refreshes write isolated temporary snapshots and move only successful results into place; public datasets keep their scoped git fallback. The digest sync rejects archive shrink; the depeg sync carries previously published static rows forward when live reclassification would make them sub-threshold, and rejects any remaining published-slug loss. One failed producer may retain that surface's committed snapshot, but the refresh step reads its machine-readable result and fails before build when all three producers fail or when public-dataset rollback fails. The job summary records the actual producer outcomes rather than the requested refresh mode.
3. Run `npm run generated:post-refresh` (the `post-refresh` lifecycle of `run-generated-artifacts.ts`) after the optional refresh, then `npx --no-install next build --webpack` and `npm run postbuild` with the production feature-flag environment and clean compiler state. `stablecoin-detail-snapshots` belongs to `post-refresh`, so live detail snapshots are acquired once per release, only after the Worker gate, not during preparation. Standalone `npm run build` still runs `prebuild` with both `compile-input,post-refresh` lifecycles. The protected PR gate has already run `next typegen` plus the root TypeScript project, so this post-merge build skips only Next's duplicate typecheck; direct local builds still typecheck by default. Postbuild's Beasties critical-CSS pass partitions the homepage and existing detail/yield pages across worker threads, with one optimizer per worker; the default pool is `max(1, min(availableParallelism() - 1, pageCount))`. `PHAROS_CRITICAL_CSS_WORKERS` accepts a positive integer override, bounded by page count; `1` processes in-thread.
4. Run feature-flag inlining, build-size/CSS-integrity, and phishing-signature checks concurrently, then run the static SEO and published-archive continuity gate over the same exact artifact. The build-size gate blocks the named JS, CSS, static-media, HTML, TXT/RSC, representative-detail, eager-JS, and `/cemetery/` (raw HTML, gzip HTML, `index.txt` RSC flight) byte ceilings as well as the total-file limit; direct-upload headroom and classic-Zod reach remain explicitly advisory diagnostics. The CSS-integrity gate reads the emitted `out/_next/static/css` bundles and requires the desktop search-width utility, preventing a stale Tailwind stylesheet from shipping beside newer header HTML. The SEO command extracts per-page metadata in bounded worker threads but retains all prior assertions. It also fetches the currently deployed `pages.dev` sitemap and requires every previously published digest/depeg detail URL to remain submitted or have a direct permanent redirect to a submitted canonical. This final continuity gate covers refresh-only routes that are newer than the checked-in snapshots; a fallback build that would regress one of those routes fails before deployment.
5. Write `out/__pharos_release.json`, publish that exact `out/` directory with one `wrangler pages deploy` command, resolve the latest production deployment through `wrangler pages deployment list --json`, and require one cache-busted target-SHA marker match from that immutable `pages.dev` deployment URL within the bounded polling window.
6. Record the commit, run URL, artifact size/file count, actual per-producer refresh outcomes, immutable deployment URL, marker result, and the manual Cloudflare Pages deployment-history rollback pointer in the job summary.

For transient Pages failures, **Re-run failed jobs** reuses successful preparation's exact artifact even though the consumer attempt increases. Failed `pages-prepare` reruns itself and publishes a new name. Artifacts expire after one day; once expired, rerun all jobs or dispatch a new current-`main` run to prepare again. Retry acceptance only while the SHA is current; [Operational Acceptance](#operational-acceptance) owns that limit.

Postbuild's `.mjs` worker entry loads TypeScript through `tsx/esm/api` under `node --import tsx`. Source CSS remains unchanged (`pruneSource: false`); every page retains inline-style, render-blocking-link, inline-handler, and CSP-safe-loader assertions. Diagnostics are sorted by page, and failures fail postbuild rather than falling back to sequential processing.

Bulk detail-snapshot acquisition is available but **not cut over**: the generator defaults to `PHAROS_DETAIL_SNAPSHOT_SOURCE=per-coin`. Deploy the cache-only Worker route and Pages proxy allowlist, run `npm run verify:detail-snapshot-sources` against production with zero byte differences, and only then set the Pages release environment to `bulk`. Keep per-coin acquisition until that proof; [Build snapshot hydration](./stablecoin-detail-page.md#build-snapshot-hydration) owns the parity and fallback contract.

There is no Pages browser installation, local proxy, GitHub Jobs API polling, deploy retry loop, broad live smoke suite, or automatic rollback in this path. The single post-publish deployment query identifies the just-published production deployment without depending on custom-domain edge treatment of GitHub shared egress. A failed marker proof leaves the failed deployment and its evidence visible for operator assessment instead of automatically changing production again.

## Operational Acceptance

Workflow success proves activation identity, not every runtime behavior. The read-only `post-deploy-acceptance` job adds narrow runtime-health evidence for each surface that successfully deployed; it records `passed`, `failed`, or explicitly `pending` in the workflow summary without mutating production or rolling anything back. Record deployment proof and operational acceptance separately.

| Change risk                     | Deployment proof                                       | Operational acceptance                                                                                                   |
| ------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Pages/static output             | Immutable deployment URL and target-SHA release marker | Narrow affected-route or live SEO smoke when the change warrants it                                                      |
| Worker request path             | SHA-tagged version at 100% traffic                     | Narrow API, transport, or owning endpoint smoke                                                                          |
| Cron/scheduler/ingestion/memory | Worker activation                                      | First matching scheduled execution completes within its expected status, duration, memory, and publication contract      |
| D1 migration plus runtime use   | Migration and Worker activation steps succeed          | First affected read/write or scheduled path succeeds; rollback notes acknowledge that Worker rollback does not revert D1 |

`scripts/ci/run-post-deploy-acceptance.ts` is the acceptance job's dependency-free entrypoint, run directly by Node without installing npm dependencies. After a Pages release it reads the uncached `/__pharos_release.json` marker and requires its full commit to equal the workflow SHA, so prior cached HTML cannot satisfy acceptance. After a Worker release the workflow uses `scripts/ci/verify-worker-deployment.ts` to GET the native Cloudflare deployments API again, fails closed unless the active 100%-traffic version still carries this release's deploy message, and requires that version id to equal the version verified by the deploy job; the public health probe must also report a served surface (`healthy` or `degraded`; its warnings are recorded in the evidence table) — `stale` or an unreadable status fails. It then writes the outcome and evidence table to the job summary and the `outcome` step output. A failed or missing identity/probe exits non-zero; `pending` and `passed` exit zero. The job records no cron probe, because a short deploy job cannot safely wait for and correlate a future scheduled run; observing the first matching scheduled execution stays a human step. Use `npm run ops:watch-worker-cron` for that bounded read-only cron evidence and `npm run ops:night-watch-worker` only when the owning rollout requires a longer observation window.

For saved execution evidence, run `node --import tsx scripts/lib/first-execution-acceptance.mts --status <status.json> --job sync-stablecoins --worker-version <exact-version> --not-before <activation-unix-seconds> --stablecoins <stablecoins.json> --require-publication`. The read-only evaluator returns JSON and exits `0` for passed, `1` for a matching failed/degraded run, or `2` for pending evidence. It requires the exact Worker version and a completed run after activation; publication additionally requires explicit published metadata and the public `_meta.updatedAt` to match that run's `syncStartSec`. Missing, older, unfinished, skipped or mismatched evidence cannot pass. For another job, omit the stablecoins/publication flags to evaluate execution only; that does not prove the job's domain-specific output contract. The collector must retain the first relevant observation: a saved `lastRun` alone cannot establish that no earlier attempt failed. This evaluator performs no polling, extends no deadline and does not change the short deploy smoke job.

The acceptance entrypoint always prints its probe/acceptance JSON to stdout; the job-summary and `outcome` step-output writes are conditional on `GITHUB_STEP_SUMMARY` and `GITHUB_OUTPUT` being set, so running it outside Actions skips those writes instead of failing.

If a deploy fails **only** in `post-deploy-acceptance`, first resolve the failing condition (for example, Worker health `stale`). While that run's SHA is still the current production release, GitHub's **Re-run failed jobs** re-executes only acceptance (about one minute), not preparation, build, or deployment. Do not retry an obsolete SHA: a later deployment correctly makes the old run's Pages marker or Worker identity checks fail. A code/configuration fix requires a new release, not replaying old acceptance.

### Monitoring Without Model Polling

Before observing, record the target SHA/run ID, affected jobs, Worker activation time, expected result/publication contract, and observation deadline. Use one deterministic watcher per target, with progress redirected to the campaign's ignored `agents/` directory. Do independent work while it runs; use completion notifications where supported, otherwise the fewest completion checks the harness permits. Do not repeatedly fetch unchanged state or assign a sub-agent solely to wait.

For GitHub, resolve the exact run for the target SHA once. Native watch mode handles refreshes without model turns. For example, after setting `release_run_id` and `watch_log` to the verified run ID and campaign log path:

```bash
python3 -c 'import subprocess, sys; subprocess.run(sys.argv[1:], timeout=1800, check=True)' \
  gh run watch "$release_run_id" --repo TokenBrice/pharos-watch --exit-status --compact --interval 30 \
  > "$watch_log" 2>&1
```

The wrapper bounds the watch to 30 minutes; choose another explicit deadline when the run warrants it. For PR checks, use the same wrapper with `gh pr checks <pr-number> --repo TokenBrice/pharos-watch --required --watch --fail-fast --interval 30`. On completion, inspect the exit status and a bounded log tail. Timeout leaves checks/deployment pending; failure routes to CI triage. Do not silently restart the watcher.

For Worker acceptance, reuse the existing commands:

- `npm run ops:watch-worker-cron -- --json` collects a **single snapshot**, not a wait-until-healthy loop. Use it when the relevant execution should already have completed.
- `npm run ops:night-watch-worker -- --start <iso> --end <iso> --interval-minutes 15 --include-d1 --output <report.md> --evidence-json <evidence.json> --checkpoint-jsonl <samples.jsonl>` collects a fixed observation window. Set campaign-specific scratch paths and a window covering the affected schedule plus its expected runtime. Add admin probes only when needed; supply credentials through the documented environment, never command arguments. Use a process deadline with collection grace beyond the observation end, because the window alone does not bound a stuck external command.

These collectors write evidence; exit zero does not certify health, and night-watch does not stop early on a healthy sample. Read the report and correlate a new affected execution with activation and its expected status, duration, memory, and publication evidence. Pre-deploy successes do not satisfy acceptance. Missing evidence at the deadline remains pending with the next scheduled opportunity recorded. A longer unattended watch belongs in an external scheduler/event-triggered workflow, not an indefinitely continuing agent goal.

## GitHub Deploy Inputs

Repository settings:

- `main` requires pull requests and the aggregate `PR gate` status check, including administrators. Independent `secrets` and `prepare` jobs must succeed: secrets uses the trusted base scanner/policy, while preparation installs and publishes one generated workspace and test-selection plan. The validation matrix uses static-compile, static-guards, plan-driven tests (four shards, or eight above 800 selected files), and selected docs, with `max-parallel: 10`; docs-only checks run inline in preparation. Touched-critical coverage uses a separate matrix of up to eight shards (`max-parallel: 8`), whose merge needs only preparation and coverage shards. The gate requires every selected job and permits only explicit legitimate skips. [Testing: CI Pipeline](./testing.md#ci-pipeline) owns the detailed lane contract.
- Critical-coverage waiver cohorts are re-reviewed and re-dated quarterly by the owning teams. The completeness gate reports reviews due within 14 days, caps each printed queue at 10 entries plus the remaining count, and fails once any review is more than 30 days overdue.
- The GitHub `production` environment is restricted to `main` and is attached to the Worker deploy job, the Pages release job, and the manual zone-cache purge job — the three production-mutating jobs.
- Production-changing workflows share the `production-deploy` concurrency group and do not cancel an active release.

Cloudflare credentials consumed by production-mutating jobs and the read-only Worker identity re-verification in acceptance:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The Cloudflare credentials authorize Worker/D1 and Pages deployment. Production-mutating jobs use the protected environment, while the acceptance job needs repository-scoped credential access for its read-only deployment API query; do not remove that access without providing an equivalent read-only credential path. GitHub does not expose existing secret values for automated migration, and secret values are never recorded in the repository. The matching Pages and Worker `SITE_API_SHARED_SECRET` bindings remain Cloudflare-managed; scheduled refreshes reach that authenticated Worker lane through the Pages proxy without exposing the secret to the GitHub runner. Pages preparation receives none of these secrets.

The manual zone-cache recovery workflow additionally requires the Cloudflare token to grant `Zone Read` and `Cache Purge` for `pharos.watch`. Normal Pages and Worker deployment permissions do not imply those zone permissions.

The zone's free plan provides a single rate-limiting slot, held by the
deliberately disabled `api-rate-limit-ip` rule; per-endpoint ingress limiting
(API-key rates, Telegram webhook dedup and mini-app quotas) is enforced in the
Worker application layer, so the drift manifest requires exactly that one edge
rule.

The scheduled Cloudflare account-state drift workflow uses the separate
repository secret `CLOUDFLARE_ACCOUNT_STATE_DRIFT_API_TOKEN`. It is a dedicated
read-only credential and is not attached to the production environment; see
[`docs/operator-origin-access.md`](./operator-origin-access.md) for its scope
and the secret-free manifest it checks.

Scheduled artifact PR secret:

- `OG_REFRESH_GITHUB_TOKEN` - bot/PAT used by `.github/workflows/og-refresh.yml` when generated OG assets changed.
- `MECHANISM_REFRESH_GITHUB_TOKEN` - optional dedicated bot/PAT for `.github/workflows/protocol-api-mechanism-refresh.yml`; that workflow falls back to the shock-coverage or OG refresh token.

The OG refresh captures the production Pages artifact through `stablecoin-dashboard.pages.dev` so shared GitHub egress does not receive the custom-domain security challenge. The capture script fails before PR creation when the response is unsuccessful, lacks the Pharos application shell, or contains Cloudflare challenge text.
The [Protocol API Mechanism Refresh](./process/protocol-api-mechanism-refresh.md) and [CDP Shock-Coverage Refresh](./process/shock-coverage-refresh.md) pages document the append-only measurement PR paths and their freshness gates.

Repository variables used by the Pages build:

- Optional: `NEXT_PUBLIC_GA_ID` and `NEXT_PUBLIC_PHAROS_*`

Environment overrides for the release-marker proof in `scripts/maintenance/wait-pages-release-marker.ts`:

- `PHAROS_RELEASE_MARKER_ATTEMPTS` (default 24) and `PHAROS_RELEASE_MARKER_DELAY_MS` (default 5000) bound the poll loop; `PHAROS_RELEASE_MARKER_TIMEOUT_MS` (default 8000) bounds each individual request.
- `PHAROS_RELEASE_MARKER_PATH` (default `out/__pharos_release.json`) selects the local marker whose `commit` field the deployment must serve back.
- Explicit CLI flags win over the environment. `.github/workflows/pages-release.yml` already passes `--attempts` and `--delay-ms`, so in that job only the timeout and marker-path variables take effect; widening the CI window means changing those flags, not exporting the variables. An unparseable or non-positive value falls back to the default without failing.

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
   - review `.github/workflows/weekly-validation.yml` output
   - treat high/critical vulnerabilities as blocking until fixed, pinned away, or explicitly risk-accepted
   - treat non-blocking staleness as advisory input for the next monthly patch/minor tranche
3. Once per quarter, or earlier when upstream support windows force it:
   - run a dedicated major-upgrade spike for framework/tooling majors
   - do not combine those majors with hotspot refactors, methodology changes, or deploy-surface behavior changes

Current explicitly deferred major cohort:

- `eslint@10` — reviewed 2026-09, still deferred; next review: 2026-12-15
- `typescript@6` — reviewed 2026-09, still deferred; next review: 2026-12-15
- `satori@0.33.x` — blocked, not deferred: 0.33 hard-imports `harfbuzzjs`, whose loader reads `self.location`/`__filename` to fetch `hb.wasm` and throws in workerd on the first OG render (`scripts/__tests__/og-worker-runtime.test.ts` returns 500; vercel/satori#796). Dependabot ignores the range; re-test when upstream ships a workerd-compatible loader.

The root `fflate` override pins Satori’s transitive dependency to patched `0.7.5` for [GHSA-px8p-9vwx-vf98](https://github.com/advisories/GHSA-px8p-9vwx-vf98). Keep it until Satori releases a compatible dependency update; the Worker OG renderer uses Satori for font decoding and rendering.

The root `miniflare` → `undici` override pins Wrangler’s Miniflare, which declares an exact `undici` version, to patched `7.29.1` for [GHSA-w293-vg96-wgc3](https://github.com/advisories/GHSA-w293-vg96-wgc3) and the five lower-severity `undici` advisories fixed in the same release. It is scoped to Miniflare so jsdom keeps resolving its declared `undici` 8 range instead of being forced onto the 7.x line. Remove it when the pinned Wrangler moves to 4.145.0 or later, whose Miniflare already depends on `undici` 7.29.1 (`npm ls undici` then shows no `overridden` marker).

Risk-accepted transitive advisories are machine-readable in `scripts/ci/dependency-audit-exceptions.json`; the verifier rejects malformed, expired, or widened entries. The registry is the weekly workflow's authority, while this section records the review rationale. There are currently no active exceptions.

The production-scope check is `npm run audit:deps` (`npm audit --audit-level=high --omit=dev`) and reflects the deployed surface. Root manifest or lockfile PRs run it through `check:pr:static`. The `audit` job in `weekly-validation.yml` runs the broader full-lockfile audit through `scripts/ci/verify-dependency-audit.ts`; it passes only when every high/critical finding is the exact, unexpired reviewed exception.

When the weekly job finds a new high/critical full-lockfile advisory, fix it, pin it away, or add a narrowly scoped, expiring registry entry with the reviewed unreachable/dev-only rationale here. Do not run `npm audit fix --force` outside a dedicated dependency tranche; forced fixes can downgrade or cross major lines.

Scheduled/manual Pages rebuild sequence in `.github/workflows/rebuild-pages.yml`:

- Schedule: `17 8 * * *` UTC, after the 08:05 UTC daily digest slot.
- The workflow has one main-only reusable job and calls `pages-release.yml` with `refresh_data: true`; this active schedule is the dataset-refresh trigger.
- It uses the reusable Pages sequence above: attempt to refresh all three API-backed datasets through the production `stablecoin-dashboard.pages.dev/_site-data` proxy, then build and verify the exact artifact, publish once, and verify the release marker on the immutable production deployment URL.
- A single digest, depeg, or public-dataset producer failure can use its scoped committed fallback. Total producer failure and public-dataset rollback failure stop the release, and the two-day alias-age guard stops frozen mirrors before publication.
- Manual rebuild dispatch uses the same path and the shared `production-deploy` lock.

### Wrangler and Workspace Layout

- Cloudflare deployment uses the lockfile-installed local Wrangler CLI rather than `cloudflare/wrangler-action`.
- Worker production custom-domain routes, bindings, and cron triggers remain declared in `worker/wrangler.toml` and deploy together through `wrangler deploy --strict`.
- The root and Worker manifests keep the same pinned Wrangler version: root scripts own the shared install and dependency overrides, while Worker commands run from `worker/` with `npx --no-install`.
- The Pages release restores no build cache state (no `.next/cache`, ESLint state, or TypeScript build info) and does not install Playwright; only the setup-node npm cache applies. Cold-cache runs are the normal path.

### Failure Stop and Surface Classification

- Deployment stops on the first failed required step.
- Pull requests own full source/test validation. The post-merge workflow reruns only the focused Worker migration/activation checks and Pages artifact checks that are adjacent to production mutation.
- Worker deploy is skipped unless deployed Worker/runtime/config/shared inputs changed. Root package and lockfile changes conservatively deploy both surfaces.
- Pages publish is skipped for non-publishable or test-only Pages changes.
- A combined deployment publishes Pages only after the required Worker job succeeds; Pages-only deployment treats the skipped Worker job as expected.

### Concurrency and Rollback Scope

- Production-changing workflows share the global `production-deploy` concurrency group and queue instead of canceling one another.
- New D1 migrations must remain backward-compatible because migrations apply before the new Worker is live. Destructive cleanup, including `DROP INDEX`, requires a separate coordinated rollout. Baseline consolidation follows the [D1 Baseline Squash Policy](./process/d1-baseline-squash-plan.md).
- The default workflow never automatically rolls back from a broad or non-causal signal.
- Worker rollback is an operator decision using Cloudflare deployment history or `wrangler rollback [VERSION-ID] --yes`. It does not reverse D1 migrations, KV/R2/D1 data, secrets, bindings, or other resources.
- Pages rollback is an operator decision in Cloudflare Pages deployment history. Use the failed run's commit, deployment URL, marker response, and Wrangler output to identify the target.
- Persistent stale custom-domain HTML can use the guarded `purge-pages-zone-cache.yml` recovery workflow after the correct Pages deployment is confirmed.

## Runtime Measurement Notes

When reviewing deploy runtime after optimization work, separate queue time from job execution time because the shared `production-deploy` concurrency group can make a healthy run appear slow while it waits for another production-changing workflow. Compare like-for-like paths: combined worker + Pages deploys, worker-only deploys, Pages-only deploys, and scheduled Pages rebuilds have different expected critical paths.

For combined deploys, the native job graph runs `pages-release` only after the required Worker deployment succeeds. Pages-only deploys do not wait on a nonexistent Worker mutation.

Tooling cache restores are best-effort acceleration for `.next/cache`, `.cache/eslint`, and TypeScript build info. Cold-cache runs remain valid and may be slower. Only jobs that produce new tooling state upload a fresh cache; the Pages release enables none of these caches, so it neither restores nor saves build state and carries no browser cache dependency.

## Runtime Origins

The current origin split is:

- public UI: `pharos.watch`
- website data API target: `site-api.pharos.watch`. The Pages `/_site-data` proxy allowlists exactly this HTTPS origin; any other `SITE_API_ORIGIN` value (including `api.pharos.watch`) is rejected and the proxy fails closed with HTTP 500
- operator UI: `ops.pharos.watch`
- public API: `api.pharos.watch`
- operator API: `ops-api.pharos.watch`

The browser-facing website data lane is same-origin `/_site-data/*` on the Pages project, and its runtime contract lives in [Worker Infrastructure: Site-Data Auth](./worker-infrastructure.md#site-data-auth). Every Pages host uses `SITE_API_SHARED_SECRET` only with the exact HTTPS `SITE_API_ORIGIN=https://site-api.pharos.watch`. The selector-snapshot Pages Function uses those same bindings server-side to recompute share artifacts from schema-validated canonical sources; missing or failing source access makes snapshot creation fail closed. Binding `DB` enables proxy-outcome attribution and is required for selector daily quotas; `SELECTOR_SNAPSHOT_IP_HASH_SECRET` is also required for privacy-preserving selector rate keys. Worker route declarations for `site-api.pharos.watch` and `ops-api.pharos.watch` live in `worker/wrangler.toml` and deploy with the normal Worker job. The Pages custom domains plus Cloudflare Access applications for the ops surfaces are account-side setup and are documented in [operator-origin-access.md](./operator-origin-access.md).

Public API `/api/*` POST requests are not production Pages proxy routes. On `pharos.watch`, `/api/` is the static API access page; its browser POST is the supporter-key claim, which goes cross-origin to `https://api.pharos.watch/api/donor-key-claims`, so CORS must allow JSON `POST` from `https://pharos.watch`. Local static-export smoke uses a proxy for endpoint-like `/api/*` only so the built artifact can be rehearsed without a deployed Pages Function.

## Self-Serve Key Incident Rollback

The self-serve request lane was removed on 2026-09-29: the public request/verification routes and the admin decision routes under `/api/api-key-requests-admin/` are unregistered and respond like any unknown API path on the public host (`401` without a valid `X-API-Key`, `404` with one), so no new self-serve issuance can occur. Existing `tier="self-serve"` keys keep authenticating until they drain through their 60-day expiry (about 2026-11-06), so an incident on this surface now means a compromised or leaked self-serve key:

1. Pause the supporter-key claim if the incident reaches it: set the supporter-claim switch to false in `shared/lib/public-api-contract.ts` and release. The Worker then answers `POST /api/donor-key-claims` with `403` before reading the body, and `/api/` shows the paused notice. The retired self-serve lane has no form page and no live route to hide.
2. No edge blocking rule is needed for the retired lane: its former POST paths are unknown routes and answer `401` without a valid key before any routing. Leave the deliberately disabled `api-rate-limit-ip` placeholder untouched; the free plan has one slot, and reallocating it for a removed lane buys nothing.
3. Roll back Worker or Pages through the normal deployment rollback path as needed.
4. Query self-serve keys around the incident window, deactivate compromised keys through `POST /api/api-keys/:id/deactivate` (or the SQL below), and verify matching audit rows. The retired release-claim admin route is gone; email-claim rows are handled only through the SQL below.
5. Check Worker logs and Cloudflare Security Events for plaintext API keys or raw IP addresses. The lane no longer uses an email provider, so there are no verification-token or provider-echoed requester surfaces to audit.

Use these SQL templates from a trusted operator shell. Set `cutoff_epoch` to the first suspect issuance timestamp; issuance ended when the lane was closed, so this window is historical. The lane's D1 tables remain in place until a separate follow-up rollout drops them.

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

Production smoke for this surface should confirm the retired request and verification paths respond like unknown API paths (`401` without a valid key, `404` with one), confirm an existing self-serve key still authenticates at its `30` requests per minute limit, then deactivate the smoke key through the admin key route and confirm the audit row.

## Failure Policy

If an explicit local `check:release` rehearsal fails:

1. Do not treat the local rehearsal as green.
2. Confirm the exact `.nvmrc` runtime, check lane, snapshot cleanliness, environment profile, and local concurrency before changing code. A release-only failure is not disproved by `npm run check:pr`, and a globally exported Pages flag does not reproduce job-scoped CI.
3. For a small change, fix the failing command directly. For a large batch, run `npm run check:pr -- --base=<ref>` and read its final summary.
4. Fix all blocking root failures and rerun their focused commands while editing. If local parallel load is suspect, run the focused command alone or set `PR_STATIC_MAX_PARALLEL=1`; do not loosen timeouts solely from a contended run.
5. Once every focused command passes, rerun `npm run check:pr -- --base=<ref>` over the whole change set instead of trusting the earlier partial run.
6. After the final source state, run the full generated-artifact freshness check. Regenerate stale artifacts with their owning generator and fold the output into the commit that moved their sources.
7. Run `npm run check:release` only when an explicit local rehearsal is desired, then push to the protected PR gate. GitHub Actions remains authoritative.

If a production deployment fails after mutation:

1. Preserve the failed run, Wrangler output, target commit, and failing health/marker response.
2. Determine whether the failure is causal to the deployed surface before changing traffic again. Public WAF challenges, unrelated ops degradation, analytics, redirects, or browser-only signals are not automatic rollback evidence.
3. For a Worker code regression, choose the prior version in Cloudflare deployment history or run `wrangler rollback [VERSION-ID] --yes`. Do not claim that this reverts D1 migrations or bound-resource state.
4. For a Pages artifact regression, select the prior successful production deployment in Cloudflare Pages deployment history.
5. Run the narrow manual smoke that proves the affected surface after recovery. Broad live checks remain diagnostic evidence, not mutation triggers.

For HTTP 403, timeout, and provider failures, establish response provenance before remediation: record the exact URL, status, relevant non-secret headers, and consumed response body; distinguish Cloudflare edge/WAF handling from Worker routing, application authorization, and upstream provider behavior. Retry the same SHA only for a proven transient. A code, configuration, credential-scope, or routing change requires a new commit/run, and the deployment path must not gain a speculative retry loop.
