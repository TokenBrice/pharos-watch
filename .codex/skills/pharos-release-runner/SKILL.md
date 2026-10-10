---
name: pharos-release-runner
description: Prepare logical commits, publish through Pharos’s protected-main pull-request gate, monitor deployment, and hand off operational acceptance. Use only when commit, push, publish, release, or deployment watching is requested.
user_invocable: true
---

# Pharos Release Runner

## Trigger And Exclusions

Use only for requested commit, push, publish, release or deployment watching, not read-only reviews or overlapping active writers. Preserve unrelated work; never stash, reset, checkout or delete it.

## Classify The Operation

Select commit-only, publish/protected-main PR, deployment watch, or operational acceptance. Inspect status, cached/uncached diffs, history and `origin/main`; distinguish committed-ahead work, cohesive dirty work, separate themes and unrelated user/agent files. Route intended files before acting.

## Mandatory Core

Read [Deployment Core Rules](../../../docs/deployment-process.md#core-rules). Actual diffs and ownership/theme define commit batches; “commit all” includes cohesive pending work, not clearly unrelated active work.

A push/publish/release request authorizes the necessary release branch and protected-main PR path, never direct `main` push. Parent alone stages, commits, pushes, merges and judges readiness. Missing readiness blocks publication; successful activation alone is not runtime health.

## Branch Reads And Actions

- **Commit preparation:** read [script operational notes](../../../docs/scripts.md#operational-notes) and the affected automation registry entries. Keep generated artifacts with their source commit. The pre-commit hook syncs affected `autoStage` outputs, rejects unsafe unstaged-source overlap, and skips merge/rebase/cherry-pick/revert, an empty index or `PHAROS_SKIP_ARTIFACT_HOOK=1`; it is neither a test gate nor full convergence. Inspect hook output and re-check the tree after each commit/generator so reviewed and released state match.
- **Publish:** read [Pre-push readiness](../../../docs/testing.md#pre-push-readiness) before every first/replacement push; it is the sole ordered readiness/receipt procedure. Push only with proof, create the PR, wait for required checks and merge with `gh pr merge --merge`, never squash/rebase. Verify resulting `main` has two parents and contains the recorded PR head; retain both SHAs. A gate failure routes to `pharos-ci-failure-triage`: collect every failed leaf, fix all causal defects in one revision, obtain fresh readiness and push once.
- **Deployment watch:** read [CI Deploy Sequence](../../../docs/deployment-process.md#ci-deploy-sequence) and [Monitoring Without Model Polling](../../../docs/deployment-process.md#monitoring-without-model-polling). Watch `Deploy to Cloudflare` for the merged SHA; record classifier-selected Pages/Worker surfaces and activation/marker proof. Use one deadline-bounded native GitHub watcher and existing Worker evidence commands, scratch samples and completion evidence, not sleep/status loops or polling-only agents. A missing matching execution at deadline is pending, not an indefinite new watch.
- **Operational acceptance:** read [Operational Acceptance](../../../docs/deployment-process.md#operational-acceptance). Cron/scheduler/ingestion/memory/migration work remains pending until its first relevant production observation. Keep deployment and runtime proof separate.
- **Authorized delegation:** use [reviewer prompts](references/subagents.md) for read-only readiness review or dirty-tree classification; parent retains mutation authority and final judgment.

## Checks Owned By The Verifier

Assigned verifier checks are authoring feedback, not release proof. For publishing, require the final committed HEAD's fresh passing `.tmp/pr-check-receipts/<HEAD>.json` under [Pre-push readiness](../../../docs/testing.md#pre-push-readiness); subsequent edits/integration invalidate it. That owner defines runtime/base/head/lane completeness, CI-deferred coverage/Pages, supplemental parity/coverage/Pages checks and generated convergence. GitHub's required PR gate remains authoritative; `check:release` is only an explicit production rehearsal. There is no pre-push test hook.

Use `npm run check:pr -- --explain-receipt` for read-only receipt diagnosis: local Git state only, no fetch/check execution/receipt rewrite/staging/push authorization. Diagnostic success is not readiness, even for missing/failed/stale evidence; remote-base freshness remains unknown.

## Completion Evidence

Report commits, focused verifier feedback, full readiness/current-HEAD receipt and generated convergence, PR/run/deploy proof, operational acceptance or pending window, excluded dirty files and skipped checks with reasons. Never label pending operational acceptance as success.
