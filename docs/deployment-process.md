# Deployment Process

> **Agent navigation** — Read the matching owner: [release states](#release-snapshot-state-machine) · [worktree hygiene](#worktree-hygiene) · [artifact preparation](#generated-artifact-preparation) · [cleanup runbooks](#yield-history-cleanup-windows) · [CI deploy sequence](#ci-deploy-sequence) · [operational acceptance](#operational-acceptance) · [GitHub inputs](#github-deploy-inputs) · [heavy prerequisites](#first-heavy-deployment-prerequisites-adr-38) · [dependency maintenance](#dependency-refresh-cadence) · [runtime origins](#runtime-origins) · [self-serve incident SQL](#self-serve-key-incident-rollback) · [failure policy](#failure-policy).

## Purpose

This document defines the production deploy flow, the GitHub Actions release gate, and optional production-profile rehearsal. Local feedback and hosted readiness authority are owned by [Testing: Pre-push readiness](./testing.md#pre-push-readiness).

## Core Rules

1. Pull requests into protected `main` must pass the aggregate validation gate. The resulting merge push triggers production deployment, while a separate Pages-only rebuild workflow refreshes the static export daily. Manual production dispatch is main-only.

   Auxiliary publication follows the same rule: the Dependency Scenarios `scenarios` job and Safety Map `plan` job require `refs/heads/main` before checkout or credential use. Non-main manual dispatch skips those jobs; main dispatch and scheduled execution remain enabled. Safety Map plans and conditionally renders/publishes within that one job; browser setup and rendering require `steps.plan.outputs.should_render == 'true'`.
2. Agents and routine maintenance default to the current `main` checkout. Do not create a branch, worktree, or PR unless the maintainer explicitly asks for one. A request to push, publish, release, or take work to production is authorization to use the required protected-main branch/PR path; it is not authorization for a direct `main` push.
3. Merge release pull requests with a merge commit (`gh pr merge --merge`), never with squash or rebase merge. Before declaring the release merged, verify the resulting `main` commit has two parents and contains the recorded PR head SHA.
4. Heavy feature/refactor work may use a dedicated worktree branch when the maintainer chooses that workflow. Run `npm run check:pr` for focused authoring feedback before pushing; GitHub Actions owns the authoritative protected release gate.

## Release Snapshot State Machine

Treat release preparation as ordered state transitions. Passing a check against an earlier state does not validate a later commit, generated diff, or environment profile.

1. **Classify** — inspect committed/staged/worktree/untracked state, identify Pages and Worker impact, and preserve unrelated work.
2. **Prepare the release** — create logical source commits, keep generated artifacts with their owning sources, and run `npm run check:pr` for focused authoring feedback under [Pre-push readiness](./testing.md#pre-push-readiness). Local receipts are optional diagnostics; hosted CI is the readiness authority. `check:release` remains an explicitly requested rehearsal.
3. **Publish** — push a release branch, wait for the authoritative protected `PR gate`, merge through GitHub, and map the PR head SHA to the resulting `main` SHA and deployment run. Do not attempt direct `main` first.
4. **Prove deployment and operation separately** — verify Worker activation and/or the immutable Pages marker. Cron, scheduler, ingestion, memory, and migration changes also require the first relevant production execution or observation under [Operational Acceptance](#operational-acceptance) before being called operationally complete.

## Optional Worktree Flow

Use this only when the maintainer explicitly asks for a separate worktree or branch.

1. Create a worktree from `origin/main`.

```bash
git fetch origin
git worktree add ".worktrees/$FEATURE_NAME" -b "$BRANCH_NAME" origin/main
```

2. Implement with focused feedback and use `npm run check:pr` under [pre-push readiness](./testing.md#pre-push-readiness) before pushing.
3. Push the branch and open a pull request into `main`. Hosted CI judges readiness for both first and replacement pushes.

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

## Generated Artifact Preparation

The repository does not install a pre-commit artifact hook or stage generated files automatically. Workspace setup materializes registered bootstrap inputs; regenerate and stage tracked outputs explicitly with their owning sources. See [Build and Generated Artifacts](./scripts.md#build-and-generated-artifacts) for registry ownership and commands.

## Local Validation Commands

Validation behavior and the focused → owning Vitest → optional PR feedback → artifact diagnosis hierarchy are owned by [Testing: Commands](./testing.md#commands) and [smallest adequate checks](./testing.md#smallest-adequate-check-per-area).

## Yield History Cleanup Windows

Release-integrated cleanup follows the [Yield writer-pause remediation procedure](./runbooks/yield-history-cleanup-writer-pause.md#remediation), including protection-first deployment, writer pause/lease proof, complete version-3 two-tier export, local restore rehearsal, bounded cleanup and next-cycle readback. Do not duplicate or bypass those mutation gates here.

## Blacklist Current-Balance Rebuild

Use the [Blacklist Sync remediation procedure](./runbooks/blacklist-sync.md#blacklist-current-balance-rebuild) for pause/lease coordination, provider-failure review, staged atomic publication, interrupted scratch-table recovery and safe pause clearing. It is the sole balance-maintenance operator contract; a release does not authorize ad hoc ledger replacement.

### KYC balance observation admission

The [KYC observation admission contract](./runbooks/blacklist-sync.md#kyc-balance-observation-admission) owns supported scopes, normalization, confirmation and cache invalidation. It writes current-state observations, not event-time balances.

## CI Deploy Sequence

Workflow YAML owns job wiring; this section owns the production safety ordering. [Testing: CI Pipeline](./testing.md#ci-pipeline) owns PR/nightly/weekly validation and trusted retained-data Pages replay. `PHAROS_PAGES_REPLAY` is forbidden in production deploy/rebuild and local release rehearsal: only the validated PR replay lane may relax mirror wall-clock age.

The release graph is `plan → (deploy-worker ∥ pages-prepare) → pages-release → post-deploy-acceptance`, with explicitly unselected surfaces skipped. [`deploy-cloudflare.yml`](../.github/workflows/deploy-cloudflare.yml) runs after a protected-main merge or main-only manual dispatch:

1. **Plan without production credentials.** Full-history classification freezes the push range or manual surface selection. Root package/lockfile edits conservatively select both surfaces. If neither surface is selected, succeed without mutation; do not reinterpret a failed selected surface as a no-op.
2. **Package and preflight before any Worker mutation.** In protected `production`, install the lockfile workspace, validate migrations and prove **both** strict Worker bundles with `check:worker-package`. Immediately before the **single shared-D1 apply**, `check:remote-d1-baseline-ledger` uses read-only remote JSON table/ledger receipts and lists unapplied filenames. Query/parse failure or pending `0000_baseline.sql` on an existing DB stops deployment; only absent/empty ledger **and no application tables** is fresh. See [baseline adoption](./process/d1-baseline-squash-plan.md#preconditions).
3. **Activate heavy, prove it, then activate public and prove it.** Strict deployment uses each role's Wrangler config and target-SHA message. [`verify-worker-deployment.ts`](../scripts/ci/verify-worker-deployment.ts) requires the first active deployment entry to have that message and exactly one 100% version; activation time is its identity-matched `created_on`, never CI time or sorted history. Fresh heavy creation is supported without a prior-version lookup.
4. **Write identity evidence only after both proofs.** Preserve write-once `worker-version-activated:<uuid>` rows and monotonic `worker-active-version:heavy` / `:public` markers, with the matched activation second and `{ worker, scriptName, workerVersion, activatedAt }`. Existing first-seen evidence is unchanged. Packaging/migration/deploy/proof/marker failure stops visibly; no automatic rollback. Pages waits for the **whole pair**, even when one Worker has already activated.
5. **Prepare Pages independently, release only after required Worker success.** [`pages-prepare.yml`](../.github/workflows/pages-prepare.yml) may run parallel with Worker deployment. It has no production environment/secrets: full history, locked dependencies and `generated:compile-input` only, **no live producers, detail acquisition, build or publish**. It transports generated files, symlinks and modes in one producer-owned run/attempt/SHA zstd workspace artifact, excluding Git/compiler caches. `pages-release` restores exactly that name and proceeds only with successful preparation plus successful required Worker pair (or explicit Worker skip).
6. **Acceptance probes each successful surface independently.** Read-only [`run-post-deploy-acceptance.ts`](../scripts/ci/run-post-deploy-acceptance.ts) needs Node but no npm install/bootstrap. It rechecks both exact deployment UUIDs and applicable public health/Pages evidence even when another deployment or identity probe failed. [Operational acceptance](#operational-acceptance) owns interpretation; activation is not runtime recovery.

The daily/main-only [`rebuild-pages.yml`](../.github/workflows/rebuild-pages.yml) uses the same `pages-prepare → pages-release` path without Worker mutation, under the shared production lock.

### Exact Pages artifact

[`pages-release.yml`](../.github/workflows/pages-release.yml) performs these transitions in order:

1. **Restore full-history workspace, not compiler cache.** Validate producer name/run/SHA; do not reinstall. Production restores no `.next/cache`, ESLint state or TypeScript build info: stale CSS/compiler state can pair old styling with new HTML.
2. **Refresh all public data.** [`refresh-pages-release-data.ts`](../scripts/maintenance/refresh-pages-release-data.ts) concurrently refreshes digest and confirmed-depeg snapshots, then public datasets through the Origin-gated production Pages `/_site-data` proxy. Temporary producer outputs replace snapshots only on success; datasets retain scoped Git fallback. Digest archive shrink and depeg published-slug loss fail; sub-threshold live reclassification retains previously published static rows. One failed producer may keep its committed fallback, but **all-three failure or public-dataset rollback failure stops before build**. Summaries record actual producer results. A fallback still must pass production mirror freshness.
3. **Acquire live details once, then compile/postbuild.** Run `generated:post-refresh`, Webpack build and postbuild under production flags with clean compiler state. Live detail snapshots belong here, after the Worker gate—not in preparation. Releases require `PHAROS_DETAIL_SNAPSHOT_SOURCE=bulk` and nonblank repository `SITE_API_SHARED_SECRET` confined to the build step; reject a missing credential before generation rather than causing corpus-wide per-coin fallback. Unavailable individual bulk rows may use the reviewed per-coin fallback. Standalone builds default to per-coin and run both prebuild lifecycles. [Build snapshot hydration](./stablecoin-detail-page.md#build-snapshot-hydration) owns acquisition parity and reproof after path changes.
4. **Retain replay inputs separately.** [`pages-release-data.mts`](../scripts/lib/pages-release-data.mts) archives only public post-refresh inputs as `pages-release-data-<sha>` / `pages-release-data.tar.zst`, retained **14 days**. It excludes workspace, credentials and built output. PR replay trusts only successful-main deploy/rebuild runs and preserves candidate redirects outside the generated alias block.
5. **Check the exact artifact before publishing.** `check:pages-release` collects feature-flag inlining, build-size/CSS integrity and phishing-signature leaves in parallel, with exit/signal evidence. SEO runs only after those prerequisites pass, otherwise reports skipped; required failure is nonzero. [`run-pages-release-checks.ts`](../scripts/maintenance/run-pages-release-checks.ts) owns the leaf list/summary and source-backed size ceilings. Enforce emitted search-width CSS and previously published digest/depeg sitemap continuity, including routes newer than committed snapshots. Direct-upload headroom/classic-Zod reach are advisory, not substitutes for blocking artifact gates.
6. **Publish exactly once, then prove immutable identity.** Write `out/__pharos_release.json`, deploy that exact `out/`, resolve the latest production deployment with one Wrangler list query, then require a cache-busted target-SHA marker from its immutable `pages.dev` URL within the bounded poll. A failed marker leaves the mutation/evidence visible for operator assessment; no retry deploy or automatic rollback.
7. **Retain release evidence.** Summary records commit/run URL, artifact size/count, actual refresh outcomes, immutable URL, marker result and Cloudflare deployment-history rollback pointer.

The protected PR gate already owns root typing; post-merge build skips only Next's duplicate typecheck, while direct local builds typecheck by default. Postbuild's worker pool owns concurrency (`PHAROS_CRITICAL_CSS_WORKERS`); source CSS is not pruned and every page keeps inline-style/link/handler/CSP-loader assertions. Failures fail postbuild, not silently fall back to sequential processing.

**Retry boundaries:** failed consumers can restore successful preparation's artifact even when their attempt increases. Workspace artifacts expire after **one day**; then prepare again via full rerun/new current-main dispatch. The separate 14-day public replay archive is not a workspace substitute. Source fixes require a new revision; retry acceptance only while the SHA is current. This path has no browser installation, proxy, Jobs-API polling, broad live smoke trigger or automatic rollback.

### Independent production monitors

Read-only monitors do not enter production-mutation concurrency or replace acceptance. [Production Canaries](../.github/workflows/production-canaries.yml) owns authenticated API/OG, Pages assets and HTTPS transport checks; [Worker Memory Monitor](../.github/workflows/worker-memory-monitor.yml) owns sampled memory and independently filtered kills, whose attribution belongs to [memory triage](./runbooks/cron-slot-abandonment.md#first-checks). Scheduled delivery is best effort, not continuous/hourly observation proof. [Dependency scenarios](./runbooks/dependency-network.md#offline-scenario-workflow) independently publishes modeled artifacts without deploying code or adding cron work. Workflow failures use the [incident runbook](./runbooks/workflow-incidents.md).

## Operational Acceptance

Activation and runtime acceptance are separate proofs. The read-only `post-deploy-acceptance` job checks identity and narrow runtime health for successfully deployed surfaces without mutation or rollback. JSON records `passed`, `failed`, or explicitly `pending`; failures carry `failureKind: "deployment"` for identity/marker failures or `"operational"` for Worker health failures, with deployment failures taking precedence if both occur. Operational failure reports **`activated; operational acceptance failed`**, not failed activation; the summary includes that reason and per-probe evidence (`scripts/ci/run-post-deploy-acceptance.ts`).

Batch nonurgent Worker changes into fewer releases and, where practical, activate after the :22/:52 V9 publication rather than between :16/:46 preparation and compilation. Urgent fixes are not blocked by this preference. A deployment-only recapture skip is expected provenance, not publication acceptance: observe the next same-build prepare and accepted V9 publication before another nonurgent release. Keep genuine input failures visible; never reset leases/checkpoints or loosen identity, freshness or score gates to obtain a green row.

| Change risk                     | Deployment proof                                       | Operational acceptance                                                                                                   |
| ------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Pages/static output             | Immutable deployment URL and target-SHA release marker | Narrow affected-route or live SEO smoke when the change warrants it                                                      |
| Worker request path             | SHA-tagged version at 100% traffic                     | Narrow API, transport, or owning endpoint smoke                                                                          |
| Cron/scheduler/ingestion/memory | Worker activation                                      | First matching scheduled execution completes within its expected status, duration, memory, and publication contract      |
| D1 migration plus runtime use   | Migration and Worker activation steps succeed          | First affected read/write or scheduled path succeeds; rollback notes acknowledge that Worker rollback does not revert D1 |

For ADR-38, observe the first two `:16/:46 → :22/:52` prepare/publication cycles and `:08/:23/:38/:53` attribution with simultaneous public detail/health traffic. The Workflow pilot is terminal no-go; require no new observer instances/rows and a newly produced current-cohort raw-status snapshot without retired-observer severity. Genuine current holds/failures must remain visible. Also observe reserve recovery and the next two four-hour reserve producers on public. Inspect authenticated `/api/status.workerVersions`, both public and heavy scheduler-liveness blocks, V9 generations and D1 slot/run UUIDs. Run `CLOUDFLARE_WORKER_NAME=stablecoin-heavy npm run ops:cron-delivery -- --minutes 240` and repeat for `stablecoin-api`; require no correlated resource deaths. CI activation alone is not runtime proof.

For Liquidity v6.93 / Pricing v6.44, deploy both Workers in one window after a successful `:16` publication and before the next `:10` stage (avoid :08–:17; roll both back together too). The `:10` stage runs on public; `:16/:46` consumes on heavy. Scoring-stage JSONL is payload v4 while D1 layout remains schema v1. A v3/v4 mismatch in either direction throws an unsupported-payload error at `:16` (recorded cron error, dependent sentinel skipped, DEX API warning); `:46` falls back to neutral current-generation reuse. The next compatible `:10/:16` pair restores publication, but persistent public/heavy version skew repeats the failure hourly. Inline recapture requires Graph-key preflight; heavy intentionally lacks `GRAPH_API_KEY` and refuses with `missing-graph-api-key` before source/target writes, so a missed `:10` is not recovered on heavy or replaced by a shrunken target catalog. Presence of a key does not prove it usable. Observe the next compatible source stage/publication and its frozen `registryEvaluation`, price-only tickers, target/route diagnostics and first-cutover policy TVL steps. Use the read-only [DEX acceptance capture](./scripts.md#dex-liquidity-acceptance-capture) for daily archives and weekly reconciliation. Partial `d1Cost` is not full cron billing, and activation or corrected inputs alone cannot prove Safety Score stability.

`scripts/ci/run-post-deploy-acceptance.ts` is the dependency-free Node entrypoint, with no npm install. Pages requires the uncached `/__pharos_release.json` commit to match the workflow SHA. Each Worker's active sole 100% SHA-tagged deployment is re-verified through `scripts/ci/verify-worker-deployment.ts`; both UUIDs must equal deploy outputs. An identity verification failure is collected as evidence, not an early exit: the remaining identity checks and public health/Pages acceptance still execute. Public health permits `healthy` or `degraded` (warnings recorded); stale, unreadable or unsuccessful health probes are operational failures. Missing/mismatched Worker UUIDs or unsuccessful/mismatched Pages markers are deployment failures. Failed exits nonzero, passed/pending exit zero. No short CI probe replaces first matching scheduled-execution observation. `npm run check:release` is an offline production-profile rehearsal, not production acceptance.

For saved execution evidence, run `node --import tsx scripts/lib/first-execution-acceptance.mts --status <status.json> --job sync-stablecoins --worker-version <exact-version> --not-before <activation-unix-seconds> --stablecoins <stablecoins.json> --require-publication`. The read-only evaluator returns JSON and exits `0` for passed, `1` for a matching failed/degraded run, or `2` for pending evidence. It requires the exact Worker version and a completed run after activation; publication additionally requires explicit published metadata and the public `_meta.updatedAt` to match that run's `syncStartSec`. Missing, older, unfinished, skipped or mismatched evidence cannot pass. For another job, omit the stablecoins/publication flags to evaluate execution only; that does not prove the job's domain-specific output contract. The collector must retain the first relevant observation: a saved `lastRun` alone cannot establish that no earlier attempt failed. This evaluator performs no polling, extends no deadline and does not change the short deploy smoke job.

The acceptance entrypoint always prints probe/acceptance JSON to stdout and writes its outcome, reason, and per-probe evidence table when `GITHUB_STEP_SUMMARY` is set. Its exit code gates the job; it writes no Actions outputs. Standalone runs without a summary path retain stdout and the exit code.

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

Night Watch grades conditionally admitted scheduled tasks (retry/poll paths) only on admission evidence, never as missing from schedule occurrence alone; unconditional due paths are still graded missing when unobserved.

These collectors write evidence; exit zero does not certify health, and night-watch does not stop early on a healthy sample. Read the report and correlate a new affected execution with activation and its expected status, duration, memory, and publication evidence. Pre-deploy successes do not satisfy acceptance. Missing evidence at the deadline remains pending with the next scheduled opportunity recorded. A longer unattended watch belongs in an external scheduler/event-triggered workflow, not an indefinitely continuing agent goal.

## GitHub Deploy Inputs

Repository settings:

- `main` requires pull requests and the aggregate `PR gate`, including administrators. [Testing: CI Pipeline](./testing.md#ci-pipeline) owns selected-lane success/skip rules; [critical coverage](./testing.md#critical-coverage-gate) owns weekly measurement and waiver review. Do not substitute a local runner, advisory check or expired waiver for the protected gate.
- The GitHub `production` environment is restricted to `main` and is attached to the Worker deploy job, the Pages release job, and the manual zone-cache purge job — the three production-mutating jobs.
- Production-changing workflows share the `production-deploy` concurrency group and do not cancel an active release.

Cloudflare credentials consumed by production-mutating jobs and the read-only Worker identity re-verification in acceptance:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The Cloudflare credentials authorize Worker/D1 and Pages deployment. Production-mutating jobs use the protected environment, while the acceptance job needs repository-scoped credential access for its read-only deployment API query; do not remove that access without providing an equivalent read-only credential path. GitHub does not expose existing secret values for automated migration, and secret values are never recorded in the repository. The matching Pages and Worker `SITE_API_SHARED_SECRET` bindings remain Cloudflare-managed. The repository secret of the same name authenticates cache-only bulk detail snapshot acquisition during the release build; release-data refreshes continue through the Pages proxy. Pages preparation receives none of these secrets.

The read-only Worker Memory Monitor instead requires repository secret `CLOUDFLARE_WORKERS_ANALYTICS_API_TOKEN`, scoped **Account → Account Analytics → Read**, plus the existing `CLOUDFLARE_ACCOUNT_ID`. Deployment/D1-status/settings tokens do not establish Analytics permission. Inject the dedicated token only into collection, not install/bootstrap; no Worker Scripts Edit, D1 Write, Pages, zone, OPS service-token or Telegram credentials are required. Confirm access to both Adaptive and Scheduled datasets and retain a first main dispatch plus a naturally scheduled fresh complete run before calling the monitor operational. Local operators explicitly export `CLOUDFLARE_ACCOUNT_ID`; `.env.local` may not contain it, and the collector has no account-discovery flag or OAuth fallback.

Production Canaries injects repository `PHAROS_API_KEY` as `SMOKE_API_KEY` only into authenticated API/Pages probe steps, never installation/bootstrap. Missing credentials fail protected contracts. [`production-canaries.yml`](../.github/workflows/production-canaries.yml) owns probe origins, scope and browser setup; transport probes remain credential-free and verify exact scheme-only redirects before application auth.

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

### First heavy deployment prerequisites (ADR-38)

Operator-only, before the paired release (agents do not deploy, export secrets or touch production):

1. Ensure account quota, Worker deployment permission (`Workers Scripts Write`), D1 binding/deploy access and the existing production CI credential path. Keep the shared database ID `8f3f54ca-e035-4cdf-9ec5-a4fbbe48b27a`; create no second authority.
2. Consult the [sunset record](process/worker-infrastructure-appendix.md#safety-score-v9-workflow-shadow-pilot) for retired-pilot state and rollback floor; do not recreate its bootstrap/transfer or use pre-retirement UUIDs as rollback targets.
3. For a fresh heavy bootstrap after resource retirement, use the real heavy bundle and normal runtime/DB settings with a temporary explicit `[triggers] crons = []` config; no Workflow resource, transfer or stub bundle is required. Keep triggers disabled until secrets are ready.
4. Provision only `COINGECKO_API_KEY`, `ALCHEMY_API_KEY`, `DRPC_API_KEY`, `TRONGRID_API_KEY`, `DWELLIR_API_KEY` from the operator vault using `npx --no-install wrangler secret bulk /secure/heavy-secrets.json --config wrangler.heavy.toml` from `worker/`. Filter to those names, never print values and securely remove the file. `ETHERSCAN_API_KEY` stays public-only; `M0_API_KEY`/`GRAPH_API_KEY` are not required, reserves stay public and absent Graph access retains named degraded/skip evidence.
5. After accepted export/disposition and authorized Workflow deletion, verify exact named not-found before activating the paired source/config cutover and both-script binding absence expectation. An unbound existing resource is pending sunset/drift, and failed/malformed GET is error. Do not delete `stablecoin-heavy`, move the retired resource back to public or reset D1 fences. Remove temporary bootstrap config before normal paired activation.
6. The dedicated `CLOUDFLARE_ACCOUNT_STATE_DRIFT_API_TOKEN` needs account `Workers Scripts Read` (both script settings, subdomain and exact named Workflow GET) and zone `Workers Routes Read` for `pharos.watch`, alongside Zone Read, Pages Read, Access applications/policies Read and WAF Read. Its GET-only checks preserve heavy existence, identical public/heavy D1 binding and no public exposure independently of Workflow absence. It cannot authorize resource deletion.

The accepted Safety capture archive binds heavy-only `SAFETY_CAPTURE_ARCHIVE` to the existing `pharos-measurements` R2 bucket. Migration 0263 creates only the D1 metadata index; apply it before activation and synchronize the heavy binding through strict paired deploy. This creates no bucket/lifecycle or R2 credential secrets. **External account state:** the [immutable October 8 verification](https://github.com/TokenBrice/pharos-watch/blob/e4e09b34e3b43baadd656471b973c686b34c1c27/docs/deployment-process.md#first-heavy-deployment-prerequisites-adr-38) recorded enabled `180d-capture-cleanup`, prefix `captures/`, expiry 180 days, plus default seven-day multipart abort. Before release, reverify identity/enabled status/prefix/age, absence of shorter conflicting object-expiry rules and the deployed heavy binding's bucket. Migration/config checks cannot establish lifecycle state; public must not acquire the binding. Preserve bookmark/version evidence and observe the first accepted upload plus D1 index before acceptance. Best-effort archive timeout/abort/skipped/index-failure metadata and gaps must remain visible.

Apply `worker/migrations/0264_dependency_scenario_chunks.sql` before activating the public reader in `worker/src/api/dependency-scenarios.ts`, then enable the scheduled chunk publisher. `worker/scripts/compute-dependency-scenarios.ts` writes ordered bounded D1 chunks, reads back and verifies bytes/hash, then publishes the latest pointer; failed partial generations must not become latest. Existing single-row artifacts remain readable. Follow the [dependency scenario rollout and rollback](./runbooks/dependency-network.md#offline-scenario-workflow): Worker rollback does not remove D1 state, and an old reader cannot read chunk manifests, so pause refreshes before rolling back.


Scheduled artifact PR secret:

- `OG_REFRESH_GITHUB_TOKEN` — fallback bot/PAT for shock-coverage, curation-expiry and protocol-mechanism refresh PRs; it does not schedule OG screenshots.
- `MECHANISM_REFRESH_GITHUB_TOKEN` - optional dedicated bot/PAT for `.github/workflows/protocol-api-mechanism-refresh.yml`; that workflow falls back to the shock-coverage or OG refresh token.

Route share cards are no longer screenshots: data-bearing routes select the live Worker card `/api/og/page/:slug` and every other route a committed timeless card ([OG Images](./og-images.md#1-route-cards)). After a Worker deploy, `GET` each live slug and decode the PNG; `X-Og-Status: timeless` names its `X-Og-Reason`.
The [Protocol API Mechanism Refresh](./process/protocol-api-mechanism-refresh.md) and [CDP Shock-Coverage Refresh](./process/shock-coverage-refresh.md) pages document the append-only measurement PR paths and their freshness gates.

Repository variables used by the Pages build:

- Optional: `NEXT_PUBLIC_GA_ID` and `NEXT_PUBLIC_PHAROS_*`

Environment overrides for the release-marker proof in `scripts/maintenance/wait-pages-release-marker.ts`:

- `PHAROS_RELEASE_MARKER_ATTEMPTS` (default 24) and `PHAROS_RELEASE_MARKER_DELAY_MS` (default 5000) bound the poll loop; `PHAROS_RELEASE_MARKER_TIMEOUT_MS` (default 8000) bounds each individual request.
- `PHAROS_RELEASE_MARKER_PATH` (default `out/__pharos_release.json`) selects the local marker whose `commit` field the deployment must serve back.
- Explicit CLI flags win over the environment; CI already passes `--attempts` and `--delay-ms`, so only the timeout and marker-path variables apply there. Invalid numeric environment values fall back to defaults; invalid CLI integers fail, and `--delay-ms 0` is valid.

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

- `eslint@10` and `typescript@6` — deferred until review on **2026-12-15**; [immutable review record](https://github.com/TokenBrice/pharos-watch/blob/e4e09b34e3b43baadd656471b973c686b34c1c27/docs/deployment-process.md#dependency-refresh-cadence).
- `satori@0.33.x` — blocked, not deferred: 0.33 hard-imports `harfbuzzjs`, whose loader reads `self.location`/`__filename` to fetch `hb.wasm` and throws in workerd on the first OG render (`scripts/__tests__/og-worker-runtime.test.ts` returns 500; vercel/satori#796). Dependabot ignores the range; re-test when upstream ships a workerd-compatible loader.

The root `fflate` override pins Satori’s transitive dependency to patched `0.7.5` for [GHSA-px8p-9vwx-vf98](https://github.com/advisories/GHSA-px8p-9vwx-vf98). Keep it until Satori releases a compatible dependency update; the Worker OG renderer uses Satori for font decoding and rendering.

The root `miniflare` → `undici` override pins Wrangler’s Miniflare, which declares an exact `undici` version, to patched `7.29.1` for [GHSA-w293-vg96-wgc3](https://github.com/advisories/GHSA-w293-vg96-wgc3) and the five lower-severity `undici` advisories fixed in the same release. It is scoped to Miniflare so jsdom keeps resolving its declared `undici` 8 range instead of being forced onto the 7.x line. Remove it when the pinned Wrangler moves to 4.145.0 or later, whose Miniflare already depends on `undici` 7.29.1 (`npm ls undici` then shows no `overridden` marker).

Risk-accepted transitive advisories live in `scripts/ci/dependency-audit-exceptions.json`; the weekly verifier rejects malformed, expired, or widened entries. Read that registry for active exceptions; this section owns the review rationale.

The [exact exception registry](../scripts/ci/dependency-audit-exceptions.json) binds the approved braces advisory to its dev-only lint-tooling graph and expiry; the [immutable approval rationale](https://github.com/TokenBrice/pharos-watch/blob/e4e09b34e3b43baadd656471b973c686b34c1c27/docs/deployment-process.md#dependency-refresh-cadence) records the no-compatible-patch evidence. No wider consumer/advisory is accepted. Remove it when a compatible patch exists; otherwise review before expiry, never silently extend.

The production-scope check is `npm run audit:deps` (`npm audit --audit-level=high --omit=dev`) and reflects the deployed surface. Root manifest or lockfile PRs run it through `check:pr:static`. The `audit` job in `weekly-validation.yml` runs the broader full-lockfile audit through `scripts/ci/verify-dependency-audit.ts`; it passes only when every high/critical finding is the exact, unexpired reviewed exception.

When the weekly job finds a new high/critical full-lockfile advisory, fix it, pin it away, or add a narrowly scoped, expiring registry entry with the reviewed unreachable/dev-only rationale here. Do not run `npm audit fix --force` outside a dedicated dependency tranche; forced fixes can downgrade or cross major lines.

The daily Pages refresh schedule is source-owned by [`rebuild-pages.yml`](../.github/workflows/rebuild-pages.yml). Manual and scheduled runs use the [same exact-artifact sequence](#ci-deploy-sequence) and production lock; committed fallback does not waive freshness or producer rollback gates.

### Wrangler and Workspace Layout

- Cloudflare deployment uses the lockfile-installed local Wrangler CLI rather than `cloudflare/wrangler-action`.
- Public routes/bindings/triggers live in `worker/wrangler.toml`; heavy scheduled/Workflow bindings and triggers live in `worker/wrangler.heavy.toml`. Both synchronize through strict deployment.
- The root and Worker manifests keep the same pinned Wrangler version: root scripts own the shared install and dependency overrides, while Worker commands run from `worker/` with `npx --no-install`.
- The Pages release restores no build cache state (no `.next/cache`, ESLint state, or TypeScript build info) and does not install Playwright; only the setup-node npm cache applies. Cold-cache runs are the normal path.

### Failure Stop and Surface Classification

- A failed required step fails its job and blocks dependent deployment gates; independent Pages preparation and applicable acceptance jobs can still run.
- Pull requests own full source/test validation. The post-merge workflow reruns only the focused Worker migration/activation checks and Pages artifact checks that are adjacent to production mutation.
- Worker deploy is skipped unless deployed Worker/runtime/config/shared inputs changed. Root package and lockfile changes conservatively deploy both surfaces.
- Pages publish is skipped for non-publishable or test-only Pages changes.
- A combined deployment publishes Pages only after the required Worker job succeeds; Pages-only deployment treats the skipped Worker job as expected.

### Concurrency and Rollback Scope

- Production-changing workflows share the global `production-deploy` concurrency group and queue instead of canceling one another.
- New D1 migrations must remain backward-compatible because migrations apply before the new Worker is live. Destructive cleanup, including `DROP INDEX`, requires a separate coordinated rollout. Baseline consolidation follows the [D1 Baseline Squash Policy](./process/d1-baseline-squash-plan.md).
- The default workflow never automatically rolls back from a broad or non-causal signal.
- Worker rollback is an operator decision using Cloudflare deployment history or `wrangler rollback [VERSION-ID] --yes`. It does not reverse D1 migrations, KV/R2/D1 data, secrets, bindings, or other resources.
- ADR-38 topology rollback restores moved registry plans to public **first**, re-adds public trigger expressions, then deploys heavy with explicit `[triggers] crons = []`. It does not recreate the retired Workflow. During the retained-resource drain stage, preserve the referenced heavy class until export/deletion; after deletion UUID rollback cannot recover instances/history/cache bytes. A new experiment needs separate approval and resource deployment. Cloudflare cron changes may overlap for up to 15 minutes; shared D1 fences remain the protection. Never reset leases/checkpoints or discard canonical publication data.
- Pages rollback is an operator decision in Cloudflare Pages deployment history. Use the failed run's commit, deployment URL, marker response, and Wrangler output to identify the target.
- Persistent stale custom-domain HTML can use the guarded `purge-pages-zone-cache.yml` recovery workflow after the correct Pages deployment is confirmed.

## Runtime Measurement Notes

When reviewing deploy runtime after optimization work, separate queue time from job execution time because the shared `production-deploy` concurrency group can make a healthy run appear slow while it waits for another production-changing workflow. Compare like-for-like paths: combined worker + Pages deploys, worker-only deploys, Pages-only deploys, and scheduled Pages rebuilds have different expected critical paths.

For combined deploys, the native job graph runs `pages-release` only after the required Worker deployment succeeds. Pages-only deploys do not wait on a nonexistent Worker mutation.

Tooling cache restores are best-effort acceleration for `.next/cache`, `.cache/eslint`, and TypeScript build info. Cold-cache runs remain valid and may be slower. Only jobs that produce new tooling state upload a fresh cache; the Pages release enables none of these caches, so it neither restores nor saves build state and carries no browser cache dependency.

## Runtime Origins

Production separates public website/API origins from Access-protected operator origins. [Operator Origin Access: Hostnames](./operator-origin-access.md#hostnames) owns the host values, [Runtime origin bindings](./operator-origin-access.md#runtime-origin-bindings) owns the site-data and selector-snapshot bindings and fail-closed upstream policy, and [Proxy contract](./operator-origin-access.md#proxy-contract) owns operator transport. Worker custom-domain routes deploy with the normal Worker job; Pages custom domains and Access applications are [account-side setup](./operator-origin-access.md#cloudflare-account-setup-and-recovery).

Public API `/api/*` POST requests are not production Pages proxy routes. On `pharos.watch`, `/api/` is the static API access page; its browser POST is the supporter-key claim, which goes cross-origin to `https://api.pharos.watch/api/donor-key-claims`, so CORS must allow JSON `POST` from `https://pharos.watch`. Local static-export smoke uses a proxy for endpoint-like `/api/*` only so the built artifact can be rehearsed without a deployed Pages Function.

## Self-Serve Key Incident Rollback

The self-serve request/verification and `/api/api-key-requests-admin/` routes are unregistered: unknown public paths return `401` without a valid `X-API-Key`, `404` with one. No new self-serve issuance occurs. Existing `tier="self-serve"` keys authenticate through their 60-day expiry; the [immutable removal/drain record](https://github.com/TokenBrice/pharos-watch/blob/e4e09b34e3b43baadd656471b973c686b34c1c27/docs/deployment-process.md#self-serve-key-incident-rollback) estimates final drain around November 6. An incident during that drain means compromised/leaked existing keys:

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

For CI validation failures, collect **every failed leaf**, use the [workflow incident runbook](./runbooks/workflow-incidents.md) for remote diagnosis, and fix all causal failures in one revision. Rerun focused checks before an authorized replacement push under [Pre-push readiness](./testing.md#pre-push-readiness); hosted CI is the readiness authority.

If an explicit local `check:release` rehearsal fails:

1. Do not treat the local rehearsal as green.
2. Confirm the exact `.nvmrc` runtime, check lane, snapshot cleanliness, environment profile, and local concurrency before changing code. A release-only failure is not disproved by `npm run check:pr`, and a globally exported Pages flag does not reproduce job-scoped CI.
3. For a small change, fix the failing command directly. For a large batch, run `npm run check:pr -- --base=<ref>` and read its final summary.
4. Fix all blocking root failures and rerun their focused commands while editing. If local parallel load is suspect, run the focused command alone or set `PR_STATIC_MAX_PARALLEL=1`; do not loosen timeouts solely from a contended run.
5. After focused fixes, use `npm run check:pr` for authoring feedback under [Pre-push readiness](./testing.md#pre-push-readiness).
6. Rerun an explicitly requested `check:release` rehearsal after its failure is resolved. Publish only through the protected PR gate; GitHub Actions remains authoritative.

If a production deployment fails after mutation:

1. Preserve the failed run, Wrangler output, target commit, and failing health/marker response.
2. Determine whether the failure is causal to the deployed surface before changing traffic again. Public WAF challenges, unrelated ops degradation, analytics, redirects, or browser-only signals are not automatic rollback evidence.
3. For a Worker code regression, choose the prior version in Cloudflare deployment history or run `wrangler rollback [VERSION-ID] --yes`. Do not claim that this reverts D1 migrations or bound-resource state.
4. For a Pages artifact regression, select the prior successful production deployment in Cloudflare Pages deployment history.
5. Run the narrow manual smoke that proves the affected surface after recovery. Broad live checks remain diagnostic evidence, not mutation triggers.

For HTTP 403, timeout, and provider failures, establish response provenance before remediation: record the exact URL, status, relevant non-secret headers, and consumed response body; distinguish Cloudflare edge/WAF handling from Worker routing, application authorization, and upstream provider behavior. Retry the same SHA only for a proven transient. A code, configuration, credential-scope, or routing change requires a new commit/run, and the deployment path must not gain a speculative retry loop.
