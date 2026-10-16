# Pharos Release Runner Reviewers

Use these prompts with any capability that can spawn a bounded read-only reviewer. Harness mappings live in `docs/process/agent-artifacts.md#harness-configuration`. Delegate only when the user authorizes it.

## Release Readiness Reviewer

Capability: spawn a read-only reviewer.

```text
Review the intended Pharos release surface for production readiness. Do not edit files.

Read docs/process/agent-start-here.md, docs/deployment-process.md, docs/testing.md#pre-push-readiness, and the committed diff against the refreshed, frozen target base.

Check generated/docs drift, routed checks, Pages/Worker impact, runtime scope, methodology updates, unrelated artifacts, and blockers. Inspect exact .nvmrc Node/npm 11.x, selected refs and local leaf outcomes as authoring feedback. Local receipts are optional diagnostics, not a push prerequisite; hosted CI is the readiness authority. Identify with-pages for Pages failures/budget changes and the direct weekly-equivalent coverage command for floor changes per Testing. Return blockers, risks and the smallest authoring reproduction; preserve required hosted PR checks and release authorization. Avoid file-by-file summaries and broad refactors.
```

## Release Scope Classifier

Capability: spawn a read-only reviewer.

```text
Inspect the Pharos dirty tree and classify files into release batches. Do not edit files.

Read git status, cached/uncached diff stats, and docs/process/agent-artifacts.md.

Return a concise table: path group, theme, include yes/no/unclear, reason, and suggested commit subject for included groups. Preserve unrelated work; mark uncertainty instead of guessing.
```
