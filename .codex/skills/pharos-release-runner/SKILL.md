---
name: pharos-release-runner
description: Prepare logical commits, publish via protected-main PRs, watch deploys, and run post-deploy acceptance. Use only when commit, push, release, or acceptance is requested. Not for reviews or CI triage.
---

# Pharos Release Runner

## Trigger And Exclusions

Use only for requested commit, push, publish, release, deployment watching or post-deploy acceptance. Not for read-only reviews, overlapping active writers, or diagnosing a failed gate ([pharos-ci-failure-triage](../pharos-ci-failure-triage/SKILL.md)). Preserve unrelated work; never stash, reset, checkout or delete it.

## Classify The Operation

Select commit-only, publish/protected-main PR, deployment watch, or operational acceptance (after a deploy, or from an `ops:followup` issue). Inspect status, cached/uncached diffs, history and `origin/main`; distinguish committed-ahead work, cohesive dirty work, separate themes and unrelated user/agent files. Route intended files before acting.

## Mandatory Core

Read [Deployment Core Rules](../../../docs/deployment-process.md#core-rules). Actual diffs and ownership/theme define commit batches; “commit all” includes cohesive pending work, not clearly unrelated active work.

A push/publish/release request authorizes the necessary release branch and protected-main PR path, never direct `main` push. Parent alone stages, commits, pushes, merges and judges readiness. A missing or red hosted `PR gate` blocks merge and publication; successful activation alone is not runtime health.

## Branch Reads And Actions

- **Commit preparation:** read [script operational notes](../../../docs/scripts.md#operational-notes) and the affected automation registry entries. `npm run check:generated-artifacts` names stale tracked outputs: regenerate them explicitly and keep them with their source commit; ignored compile/serve projections are materialized by bootstrap/build. There is no repository pre-commit artifact hook. Inspect generated changes before staging so reviewed and released state match. Land an uncommitted lane delta from a detached worktree with `npm run agent:land` ([Reviewed Lane Landing](../../../docs/scripts.md#reviewed-lane-landing)). Add the exact trailer line `Sitemap-Date: unchanged` only to a commit that touches page sources without changing page content.
- **Publish:** read [Pre-push readiness](../../../docs/testing.md#pre-push-readiness) for local feedback guidance; hosted CI is the readiness authority and local receipts are optional diagnostics. Push the release branch, never `main`; wait for required checks with one bounded `gh pr checks <pr> --repo TokenBrice/pharos-watch --required --watch --fail-fast --interval 30`, and merge with `gh pr merge --merge`, never squash/rebase. Verify resulting `main` has two parents and contains the recorded PR head; retain both SHAs. A gate failure routes to [pharos-ci-failure-triage](../pharos-ci-failure-triage/SKILL.md): collect every failed leaf, fix all causal defects in one revision, rerun focused checks and push once.
- **Deployment watch:** read [CI Deploy Sequence](../../../docs/deployment-process.md#ci-deploy-sequence) and [Monitoring Without Model Polling](../../../docs/deployment-process.md#monitoring-without-model-polling). Watch `Deploy to Cloudflare` for the merged SHA; record classifier-selected Pages/Worker surfaces and activation/marker proof. Use one deadline-bounded native GitHub watcher and existing Worker evidence commands, scratch samples and completion evidence, not sleep/status loops or polling-only agents. A run waiting behind another production workflow is queued on the shared `production-deploy` group, not stalled. A missing matching execution at deadline is pending, not an indefinite new watch. A run red only in `post-deploy-acceptance` with `failureKind: "operational"` is activated with failed acceptance, never a failed activation.
- **Operational acceptance:** read [operational acceptance](references/operational-acceptance.md). Cron/scheduler/ingestion/memory/migration work remains pending until its first relevant production observation. Keep deployment and runtime proof separate.
- **Authorized delegation:** a bounded read-only reviewer may check release readiness against the frozen target base, or classify the dirty tree into a table of path group, theme, include yes/no/unclear, reason and commit subject. Parent retains mutation authority and final judgment.

## Checks Owned By The Verifier

Assigned verifier checks are authoring feedback, not release proof. Readiness and optional receipt diagnostics follow [Pre-push readiness](../../../docs/testing.md#pre-push-readiness). Keep generated artifacts with their owning sources. `check:release` is only an explicit production rehearsal. There is no pre-push test hook.

## Completion Evidence

Report commits, focused verifier feedback and generated-artifact changes, PR/run/deploy proof (PR head and merge SHAs, deploy run ID, activated Worker versions), operational acceptance or its pending window, excluded dirty files and skipped checks with reasons. Never label pending operational acceptance as success; when an unmonitored pending observation meets the bar in the acceptance companion, update the owning open issue (or file one rollout issue) and report its number, otherwise report `Follow-ups: none`.
