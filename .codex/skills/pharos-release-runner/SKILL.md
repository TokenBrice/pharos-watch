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

- **Commit preparation:** read [script operational notes](../../../docs/scripts.md#operational-notes) and the affected automation registry entries. Explicitly regenerate affected tracked outputs and keep them with their source commit; ignored compile/serve projections are materialized by bootstrap/build. There is no repository pre-commit artifact hook. Inspect generated changes before staging so reviewed and released state match.
- **Publish:** read [Pre-push readiness](../../../docs/testing.md#pre-push-readiness) for local feedback guidance; hosted CI is the readiness authority and local receipts are optional diagnostics. Push through the authorized protected-main PR path, wait for required checks and merge with `gh pr merge --merge`, never squash/rebase. Verify resulting `main` has two parents and contains the recorded PR head; retain both SHAs. A gate failure routes to `pharos-ci-failure-triage`: collect every failed leaf, fix all causal defects in one revision, rerun focused checks and push once.
- **Deployment watch:** read [CI Deploy Sequence](../../../docs/deployment-process.md#ci-deploy-sequence) and [Monitoring Without Model Polling](../../../docs/deployment-process.md#monitoring-without-model-polling). Watch `Deploy to Cloudflare` for the merged SHA; record classifier-selected Pages/Worker surfaces and activation/marker proof. Use one deadline-bounded native GitHub watcher and existing Worker evidence commands, scratch samples and completion evidence, not sleep/status loops or polling-only agents. A missing matching execution at deadline is pending, not an indefinite new watch.
- **Operational acceptance:** read [Operational Acceptance](../../../docs/deployment-process.md#operational-acceptance). Cron/scheduler/ingestion/memory/migration work remains pending until its first relevant production observation. Keep deployment and runtime proof separate.
- **Authorized delegation:** use [reviewer prompts](references/subagents.md) for read-only readiness review or dirty-tree classification; parent retains mutation authority and final judgment.

## Checks Owned By The Verifier

Assigned verifier checks are authoring feedback, not release proof. Use `npm run check:pr` under [Pre-push readiness](../../../docs/testing.md#pre-push-readiness) before publishing; hosted CI is the readiness authority. Keep generated artifacts with their owning sources. Local receipts are optional diagnostics, not a push prerequisite; `check:release` is only an explicit production rehearsal. There is no pre-push test hook.

Use `npm run check:pr -- --explain-receipt` for read-only receipt diagnosis: local Git state only, no fetch/check execution/receipt rewrite/staging/push authorization. Diagnostic success is not readiness, even for missing/failed/stale evidence; remote-base freshness remains unknown.

## Completion Evidence

Report commits, focused verifier feedback and generated-artifact changes, PR/run/deploy proof, operational acceptance or pending window, excluded dirty files and skipped checks with reasons. Never label pending operational acceptance as success.
