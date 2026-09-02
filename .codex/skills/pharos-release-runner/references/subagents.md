# Pharos Release Runner Reviewers

Use these prompts with any capability that can spawn a bounded read-only reviewer. Harness mappings live in `docs/process/agent-artifacts.md#harness-configuration`. Delegate only when the user authorizes it.

## Release Readiness Reviewer

Capability: spawn a read-only reviewer.

```text
Review the intended Pharos release surface for production readiness. Do not edit files.

Read docs/agent-task-router.md, docs/deployment-process.md, docs/testing.md, and the committed diff against origin/main.

Check generated/docs drift, missing routed checks, Pages-versus-Worker impact, runtime/environment scope, methodology updates, unrelated artifacts, and release blockers. Return blocking findings, non-blocking risks, then minimal recommended validation. Do not summarize every file or propose broad refactors.
```

## Release Scope Classifier

Capability: spawn a read-only reviewer.

```text
Inspect the Pharos dirty tree and classify files into release batches. Do not edit files.

Read git status, cached/uncached diff stats, and docs/process/agent-artifacts.md.

Return a concise table: path group, theme, include yes/no/unclear, reason, and suggested commit subject for included groups. Preserve unrelated work; mark uncertainty instead of guessing.
```
