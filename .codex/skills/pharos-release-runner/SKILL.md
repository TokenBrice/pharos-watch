---
name: pharos-release-runner
description: Prepare logical commits, publish through Pharos’s protected-main pull-request gate, monitor deployment, and hand off operational acceptance. Use only when commit, push, publish, release, or deployment watching is requested.
user_invocable: true
---

# Pharos Release Runner

Read [Deployment §Core Rules](../../../docs/deployment-process.md#core-rules), [§CI Deploy Sequence](../../../docs/deployment-process.md#ci-deploy-sequence), [§Operational Acceptance](../../../docs/deployment-process.md#operational-acceptance), and [Testing §Smallest adequate check](../../../docs/testing.md#smallest-adequate-check-per-area). Those sections and workflow YAML own release policy.

Do not use for a read-only review or while another writer owns overlapping files. Preserve unrelated work; never stash, reset, checkout, or delete it.

## Prepare

1. Inspect status, cached/uncached diffs, recent history, and `origin/main`. Classify committed-ahead work, cohesive dirty work, separate themes, and unrelated user/agent files.
2. Route the intended files. Inspect actual diffs and batch commits by ownership/theme. A request to “commit all” includes cohesive pending work, not clearly unrelated active work.
3. Keep registered generated artifacts with their source commit. The pre-commit hook may regenerate affected `autoStage` outputs and rejects unsafe unstaged-source overlap; inspect its output and the registry rather than relying on a copied artifact list.
4. After each commit or generator, re-check the tree so the state being released matches the state reviewed.

## Validate And Publish

Run routed focused checks. GitHub’s required PR gate is authoritative; `npm run check:pr -- --base=<ref>` is the committed-diff rehearsal and `npm run check:release` is only an explicit local production rehearsal.

A request to push/publish/release authorizes the necessary release branch and protected-main PR path, never a direct push to `main`. Push the release branch, create the PR, wait for required checks, and merge through GitHub with `gh pr merge --merge`; never use squash or rebase merge. Verify the resulting `main` commit has two parents and contains the recorded PR head SHA, then record both SHAs. If a gate fails, switch to `pharos-ci-failure-triage`.

## Deployment And Acceptance

Watch the `Deploy to Cloudflare` run for the merged SHA and record classifier-selected Pages/Worker surfaces plus activation/marker proof. Apply the acceptance rules in `docs/deployment-process.md`: deployment proof and runtime health are separate, and cron/scheduler/ingestion/memory/migration work remains pending until its first relevant production observation.

Follow [Monitoring Without Model Polling](../../../docs/deployment-process.md#monitoring-without-model-polling): use one deadline-bounded native GitHub watcher and the existing Worker evidence commands. Keep samples in scratch files; inspect completion evidence instead of cycling through sleep/status calls or assigning polling-only sub-agents. A missing matching execution at the deadline is pending acceptance, not a reason to restart the watch indefinitely.

When the user authorizes delegation, use [references/subagents.md](references/subagents.md) for a read-only readiness review or dirty-tree classification. The parent alone stages, commits, pushes, merges, and makes final judgments.

Report commits, focused checks, generated-artifact status, PR/run/deploy evidence, operational acceptance or pending window, excluded dirty files, and skipped checks with reasons.
