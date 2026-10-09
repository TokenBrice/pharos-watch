---
name: pharos-release-runner
description: Prepare logical commits, publish through Pharos’s protected-main pull-request gate, monitor deployment, and hand off operational acceptance. Use only when commit, push, publish, release, or deployment watching is requested.
user_invocable: true
---

# Pharos Release Runner

Read [Deployment §Core Rules](../../../docs/deployment-process.md#core-rules), [§CI Deploy Sequence](../../../docs/deployment-process.md#ci-deploy-sequence), [§Operational Acceptance](../../../docs/deployment-process.md#operational-acceptance), and [Testing §Pre-push readiness](../../../docs/testing.md#pre-push-readiness). Those sections and workflow YAML own release policy.

Do not use for a read-only review or while another writer owns overlapping files. Preserve unrelated work; never stash, reset, checkout, or delete it.

## Prepare

1. Inspect status, cached/uncached diffs, recent history, and `origin/main`. Classify committed-ahead work, cohesive dirty work, separate themes, and unrelated user/agent files.
2. Route the intended files. Inspect actual diffs and batch commits by ownership/theme. A request to “commit all” includes cohesive pending work, not clearly unrelated active work.
3. Keep registered generated artifacts with their source commit. The pre-commit hook synchronizes only affected `autoStage` outputs and rejects unsafe unstaged-source overlap; it skips merge/rebase/cherry-pick/revert, an empty index, and `PHAROS_SKIP_ARTIFACT_HOOK=1`. Inspect its output and the registry: it is neither a test gate nor full convergence.
4. After each commit or generator, re-check the tree so the state being released matches the state reviewed.

## Validate And Publish

Routed focused checks are authoring feedback, never readiness proof. Before **every** first or replacement push, follow [Pre-push readiness](../../../docs/testing.md#pre-push-readiness): activate mise shims reading `.nvmrc` (enable `mise settings add idiomatic_version_file_enable_tools node` before `mise install`), refresh target refs, finish source/integration history, run full `npm run check:generated-artifacts` convergence, then full plain `npm run check:pr` on the final committed state with no skip/filter/plan-only flags. The runner requires exact `.nvmrc` Node and npm 11.x.

Require a **fresh passing receipt for the current HEAD** at `.tmp/pr-check-receipts/<HEAD>.json` before pushing. Inspect its runtime, frozen base/head, lane outcomes, and completeness; a failed, incomplete, stale-state, or different-HEAD receipt is not authorization. `deferred-to-ci` leaves (critical coverage, Pages artifact) are expected: the GitHub PR gate runs and requires them; rerun locally with `--with-coverage`/`--with-pages` only after such a remote failure. Any subsequent edit, generated-output commit, or integration requires full readiness again. There is no pre-push test hook.

Opt into `npm run check:pr -- --ci-parity` after a remote failure the local gate did not reproduce, and for lockfile/setup/security-policy changes; this supplements, not replaces, mandatory plain readiness. `npm run check:release` is only an explicit production rehearsal. GitHub's required PR gate remains authoritative.

A request to push/publish/release authorizes the necessary release branch and protected-main PR path, never a direct push to `main`. Push only after receipt proof, create the PR, wait for required checks, and merge through GitHub with `gh pr merge --merge`; never use squash or rebase merge. Verify the resulting `main` commit has two parents and contains the recorded PR head SHA, then record both SHAs. If a gate fails, switch to `pharos-ci-failure-triage`: collect every failed leaf, fix all causal defects in one revision, rerun full readiness, and push once.

## Deployment And Acceptance

Watch the `Deploy to Cloudflare` run for the merged SHA and record classifier-selected Pages/Worker surfaces plus activation/marker proof. Apply the acceptance rules in `docs/deployment-process.md`: deployment proof and runtime health are separate, and cron/scheduler/ingestion/memory/migration work remains pending until its first relevant production observation.

Follow [Monitoring Without Model Polling](../../../docs/deployment-process.md#monitoring-without-model-polling): use one deadline-bounded native GitHub watcher and the existing Worker evidence commands. Keep samples in scratch files; inspect completion evidence instead of cycling through sleep/status calls or assigning polling-only sub-agents. A missing matching execution at the deadline is pending acceptance, not a reason to restart the watch indefinitely.

When the user authorizes delegation, use [references/subagents.md](references/subagents.md) for a read-only readiness review or dirty-tree classification. The parent alone stages, commits, pushes, merges, and makes final judgments.

Report commits, focused feedback, full readiness command and HEAD receipt evidence, generated-artifact convergence, PR/run/deploy evidence, operational acceptance or pending window, excluded dirty files, and skipped checks with reasons. Missing readiness proof blocks publication; successful activation with pending operational acceptance is not operational success.
