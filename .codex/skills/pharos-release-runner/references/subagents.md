# Pharos Release Runner Reviewers

Use these prompts with any capability that can spawn a bounded read-only reviewer. Harness mappings live in `docs/process/agent-artifacts.md#harness-configuration`. Delegate only when the user authorizes it.

## Release Readiness Reviewer

Capability: spawn a read-only reviewer.

```text
Review the intended Pharos release surface for production readiness. Do not edit files.

Read docs/process/agent-start-here.md, docs/deployment-process.md, docs/testing.md#pre-push-readiness, and the committed diff against the refreshed, frozen target base.

Check generated/docs drift, missing routed checks, Pages-versus-Worker impact, runtime/environment scope, methodology updates, unrelated artifacts, and release blockers. Require evidence of final-history full generated-artifact convergence and a fresh passing .tmp/pr-check-receipts/<HEAD>.json from full plain npm run check:pr without skip/filter/plan-only flags. Inspect exact .nvmrc Node/npm 11.x, frozen base/head identities, complete passing lane outcomes, and whether any edit/integration invalidated the receipt. Focused checks are not readiness proof. Identify whether opt-in ci-parity is required by lockfile/setup/security-policy changes or a remote failure not reproduced locally. Return blocking findings and missing proof, non-blocking risks, then the smallest authoring repro plus full pre-push readiness requirement. Missing or incomplete proof blocks publication; a documented limitation cannot waive it. Do not summarize every file or propose broad refactors.
```

## Release Scope Classifier

Capability: spawn a read-only reviewer.

```text
Inspect the Pharos dirty tree and classify files into release batches. Do not edit files.

Read git status, cached/uncached diff stats, and docs/process/agent-artifacts.md.

Return a concise table: path group, theme, include yes/no/unclear, reason, and suggested commit subject for included groups. Preserve unrelated work; mark uncertainty instead of guessing.
```
