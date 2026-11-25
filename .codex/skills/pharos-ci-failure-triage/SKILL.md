---
name: pharos-ci-failure-triage
description: Diagnose and fix failed GitHub Actions, PR checks, Cloudflare deploys, Pages releases, or scheduled workflows. Use when a gate, run, or nightly fails. Not for routine releases or CI slim passes.
---

# Pharos CI Failure Triage

## Trigger And Exclusions

Use for failed gates/runs, a red nightly, or authorized repair loops. Not for routine readiness or publishing ([pharos-release-runner](../pharos-release-runner/SKILL.md)) or lane-budget trimming ([ci-slim-pass](../ci-slim-pass/SKILL.md)). Local success never clears an external prerequisite.

## Classify The Operation

Capture run ID/URL, event, head SHA/currentness, **every failed leaf job/step**, exact command and first actionable error, and selected/skipped reusable jobs:

```bash
gh run view <run-id> --repo TokenBrice/pharos-watch --json status,conclusion,event,headSha,workflowName,url,jobs
gh run view <run-id> --repo TokenBrice/pharos-watch --log-failed
```

Classify each leaf as generated-artifact, docs, test, corpus budget, Pages build/marker, Worker migration/deploy/activation, infrastructure, post-deploy runtime, nightly-only, scheduled automation, or external transient. A skipped child may be expected; interpret the outer aggregate/deploy classifier, never stop at the first red step.

## Mandatory Core

Read [CI Pipeline](../../../docs/testing.md#ci-pipeline), [Failure Policy](../../../docs/deployment-process.md#failure-policy), [Workflow failure triage](../../../docs/runbooks/workflow-incidents.md), and the failing workflow/source. Route each path; locate its narrow reproduction in `package.json`, [Testing commands](../../../docs/testing.md#commands), and [script validation index](../../../docs/scripts.md#validation-command-index), not whole-doc reads.

Start with narrow diagnosis, not broad release gates, retries, or timeout changes. Fix all causal failed-leaf defects in one revision. Generated output follows its registry owner; docs follow source truth; test expectations change only for intended behavior. Provider/infrastructure failure does not justify unrelated churn.

## Branch Reads And Actions

- **Generated artifact:** read [failure playbook](../../../docs/testing.md#generated-artifact-failure-playbook) and the reported registry/generator owner.
- **Docs/test:** read routed owner anchors and the failed check's source; preserve intended behavior. `scripts/lib/pr-lanes.mts` owns lane selection, so a conditional lane absent from a run is not a failure. Reproduce typing with `npm run typecheck`, `npm run typecheck:worker` or `npm run typecheck:tests`, never bare `tsc`: it resolves to the older compiler that only `npm run lint:typed` uses ([Testing commands](../../../docs/testing.md#commands)).
- **`PR gate` red with no failed validation leaf:** the corpus-budget step is non-fatal in `prepare` and enforced by `PR gate`, so `--log-failed` shows no violation. Read the `prepare` job summary or run `npm run check:test-corpus-budget -- --base=origin/main` ([Test corpus budget](../../../docs/testing.md#test-corpus-budget)), then trim or retire tests. Never apply the owner-only `test-budget-override` or `new-asset-gate-override` labels; a label counts only on a new push, never on a re-run.
- **Nightly red:** read [nightly triage](references/nightly-triage.md) and [Scheduled validation](../../../docs/testing.md#scheduled-validation). Never close the `ci:nightly-red` issue by hand.
- **Pages/Worker/deployment:** read [CI Deploy Sequence](../../../docs/deployment-process.md#ci-deploy-sequence) and the classifier-selected surface's acceptance requirements. Deployment proof and runtime health are separate: a deploy red only in `post-deploy-acceptance` with `failureKind: "operational"` is activated, not a failed activation. Fix the condition, then re-run failed jobs only while that SHA is still the production release ([Operational Acceptance](../../../docs/deployment-process.md#operational-acceptance)). A deploy waiting behind another production workflow is queued on the shared `production-deploy` group, not stalled.
- **External prerequisite/transient:** collect URL, status, non-secret headers and consumed response body. Verify current dependency-advisory and provider-access blockers against their owning testing, coverage and deployment docs; a local green repro cannot clear them.
- **Scheduled automation:** use that run/branch/issue and its owner docs for urgency/freshness, not copied cadence tables. A scheduled run starting hours after its cron minute is normal; accept a workflow fix from a manual dispatch on `main` ([Scheduled start delay](../../../docs/runbooks/workflow-incidents.md#scheduled-start-delay)).
- **Manual dispatch:** verify `workflow_dispatch` support. `pages-prepare` and `pages-release` are `workflow_call`-only; dispatch `Deploy to Cloudflare` or `Rebuild Pages` on `main` and watch the exact new run.
- **Authorized delegation:** a bounded read-only reviewer may collect failed-leaf logs or map each leaf to its smallest repro and owner; it returns leaf, command, first error, repro and likely files. Parent owns edits, commits, pushes, retriggers and judgment. Without delegation, do it sequentially.
- **CI trends only:** `npm run ci:census` measures trends/recovery cohorts, never reproduction or readiness; aggregate census outcomes do not diagnose failed leaves.

## Checks Owned By The Verifier

The assigned verifier reruns focused reproductions after causal edits; these are authoring feedback, not readiness proof. Readiness and optional receipt diagnostics follow [Pre-push readiness](../../../docs/testing.md#pre-push-readiness). Push once through the protected-main PR path, never directly to `main`; release policy owns authorization. `check:release` is only a requested production rehearsal.

## Completion Evidence

Report every failed leaf/root cause, changed files, focused verifier results, retrigger/run/deploy proof, separate operational evidence, and unresolved external risks. Continue until clear when requested; stop only for a proven external blocker or missing authority.
