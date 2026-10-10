# Pharos Release Runner Reviewers

Use these prompts with any capability that can spawn a bounded read-only reviewer. Harness mappings live in `docs/process/agent-artifacts.md#harness-configuration`. Delegate only when the user authorizes it.

## Release Readiness Reviewer

Capability: spawn a read-only reviewer.

```text
Review the intended Pharos release surface for production readiness. Do not edit files.

Read docs/process/agent-start-here.md, docs/deployment-process.md, docs/testing.md#pre-push-readiness, and the committed diff against the refreshed, frozen target base.

Check generated/docs drift, routed checks, Pages/Worker impact, runtime scope, methodology updates, unrelated artifacts, and blockers. Require final-history full generated convergence and a fresh passing .tmp/pr-check-receipts/<HEAD>.json from full plain npm run check:pr without skip/filter/plan-only/no-fetch flags or selection overrides. Inspect exact .nvmrc Node/npm 11.x, frozen refs, complete lane outcomes (selected coverage/Pages may be deferred-to-ci), and invalidating edits/integration. Focused checks are not readiness. Identify supplemental ci-parity for lockfile/setup/security-policy changes or an unreproduced remote failure, and with-coverage/with-pages for remote failures or floor/budget changes per Testing. Return blockers/missing proof, risks, then smallest authoring repro plus full readiness requirement. Missing/incomplete proof blocks publication; limitations cannot waive it. Avoid file-by-file summaries and broad refactors.
```

## Release Scope Classifier

Capability: spawn a read-only reviewer.

```text
Inspect the Pharos dirty tree and classify files into release batches. Do not edit files.

Read git status, cached/uncached diff stats, and docs/process/agent-artifacts.md.

Return a concise table: path group, theme, include yes/no/unclear, reason, and suggested commit subject for included groups. Preserve unrelated work; mark uncertainty instead of guessing.
```
