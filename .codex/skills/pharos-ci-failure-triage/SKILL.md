---
name: pharos-ci-failure-triage
description: Diagnose and fix failed Pharos GitHub Actions, adaptive PR checks, Cloudflare deploys, Pages releases, or scheduled automation. Use when a gate/run failed or the user asks to retrigger and iterate until clear.
user_invocable: true
---

# Pharos CI Failure Triage

## Trigger And Exclusions

Use for failed gates/runs or authorized repair loops, not routine readiness/trends. Local success never clears an external prerequisite.

## Classify The Operation

Capture run ID/URL, event, head SHA/currentness, **every failed leaf job/step**, exact command and first actionable error, and selected/skipped reusable jobs:

```bash
gh run view <run-id> --repo TokenBrice/pharos-watch --json status,conclusion,event,headSha,workflowName,url,jobs
gh run view <run-id> --repo TokenBrice/pharos-watch --log-failed
```

Classify each leaf as generated-artifact, docs, test, Pages build/marker, Worker migration/deploy/activation, infrastructure, post-deploy runtime, scheduled automation, or external transient. A skipped child may be expected; interpret the outer aggregate/deploy classifier, never stop at the first red step.

## Mandatory Core

Read [CI Pipeline](../../../docs/testing.md#ci-pipeline), [Failure Policy](../../../docs/deployment-process.md#failure-policy), and the failing workflow/source. Route each path; locate its narrow reproduction in `package.json`, [Testing commands](../../../docs/testing.md#commands), and [script validation index](../../../docs/scripts.md#validation-command-index), not whole-doc reads.

Start with narrow diagnosis, not broad release gates, retries, or timeout changes. Fix all causal failed-leaf defects in one revision. Generated output follows its registry owner; docs follow source truth; test expectations change only for intended behavior. Provider/infrastructure failure does not justify unrelated churn.

## Branch Reads And Actions

- **Generated artifact:** read [failure playbook](../../../docs/testing.md#generated-artifact-failure-playbook) and the reported registry/generator owner.
- **Docs/test:** read routed owner anchors and the failed check's source; preserve intended behavior.
- **Pages/Worker/deployment:** read [CI Deploy Sequence](../../../docs/deployment-process.md#ci-deploy-sequence) and the classifier-selected surface's acceptance requirements. Deployment proof and runtime health are separate.
- **External prerequisite/transient:** collect URL, status, non-secret headers and consumed response body. Verify current dependency-advisory, provider-access and incident-alert-secret blockers against their owning testing, coverage and deployment docs; a local green repro cannot clear them.
- **Scheduled automation:** use that run/branch/issue and its owner docs for urgency/freshness, not copied cadence tables.
- **Manual dispatch:** verify `workflow_dispatch` support. `pages-release` is call-only; dispatch its owning deploy/rebuild workflow and watch the exact new run.
- **Authorized delegation:** use [reviewer prompts](references/subagents.md); parent owns edits, commits, pushes, retriggers and judgment.
- **CI trends only:** `npm run ci:census` measures trends/recovery cohorts, never reproduction or readiness; aggregate census outcomes do not diagnose failed leaves.

## Checks Owned By The Verifier

The assigned verifier reruns focused reproductions after causal edits; these are authoring feedback, not readiness proof. Before **every authorized replacement push**, follow [Pre-push readiness](../../../docs/testing.md#pre-push-readiness), the sole ordered runtime/ref/artifact/plain-check procedure, including parity and coverage/Pages supplements when applicable. Require a fresh passing `.tmp/pr-check-receipts/<HEAD>.json` for final committed HEAD; edits/integration invalidate proof. Push once through protected main, never directly to `main`; release policy owns authorization. `check:release` is only a requested production rehearsal.

Use `npm run check:pr -- --explain-receipt` for read-only receipt diagnosis: local Git state only, no fetch/check execution/receipt rewrite/staging/push authorization. Exit success only means diagnosis completed, even for missing/failed/stale evidence; remote-base freshness remains unknown. It never replaces readiness.

## Completion Evidence

Report every failed leaf/root cause, changed files, focused verifier results, full readiness/current-HEAD receipt before replacement push, retrigger/run/deploy proof, separate operational evidence, and unresolved external risks. Continue until clear when requested; stop only for a proven external blocker or missing authority.
