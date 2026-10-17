# Pharos Release Runner Reviewers

Use these prompts with any capability that can spawn a bounded read-only reviewer. Harness mappings live in `docs/process/agent-artifacts.md#harness-configuration`. Delegate only when the user authorizes it.

## Release Readiness Reviewer

Capability: spawn a read-only reviewer.

```text
Review the intended Pharos release surface for production readiness. Do not edit files.

Read docs/process/agent-start-here.md#2-route-a-task, docs/deployment-process.md#release-snapshot-state-machine, docs/deployment-process.md#ci-deploy-sequence, docs/deployment-process.md#operational-acceptance, docs/testing.md#pre-push-readiness, and the committed diff against the refreshed, frozen target base. Open other routed owner anchors only for affected contracts.

Check generated/docs drift, routed checks, Pages/Worker impact, runtime scope, methodology updates, unrelated artifacts, and blockers. Inspect exact .nvmrc Node/npm 11.x, selected refs and local leaf outcomes as authoring feedback. Local receipts are optional diagnostics, not a push prerequisite; hosted CI is the readiness authority. Identify with-pages for Pages failures/budget changes and the direct weekly-equivalent coverage command for floor changes per Testing. Return blockers, risks and the smallest authoring reproduction; preserve required hosted PR checks and release authorization. Avoid file-by-file summaries and broad refactors.
```

## Release Scope Classifier

Capability: spawn a read-only reviewer.

```text
Inspect the Pharos dirty tree and classify files into release batches. Do not edit files.

Read git status and cached/uncached diff stats; use docs/process/agent-artifacts.md#source-of-truth, docs/process/agent-artifacts.md#cleanup-rule and docs/process/agent-artifacts.md#campaign-index-and-handoff for artifact inclusion and retention.

Return a concise table: path group, theme, include yes/no/unclear, reason, and suggested commit subject for included groups. Preserve unrelated work; mark uncertainty instead of guessing.
```
