---
name: pharos-ci-failure-triage
description: Diagnose and fix failed Pharos GitHub Actions, adaptive PR checks, Cloudflare deploys, Pages releases, or scheduled automation. Use when a gate/run failed or the user asks to retrigger and iterate until clear.
user_invocable: true
---

# Pharos CI Failure Triage

The authoritative contracts are [Testing §Commands](../../../docs/testing.md#commands), [Testing §CI Pipeline](../../../docs/testing.md#ci-pipeline), [Deployment §CI Deploy Sequence](../../../docs/deployment-process.md#ci-deploy-sequence), and [Deployment §Failure Policy](../../../docs/deployment-process.md#failure-policy). Read `docs/scripts.md` and the relevant workflow/source after routing the failing path.

## Triage

1. Capture the run ID/URL, event, head SHA, failed job/step, exact command, first actionable error, selected/skipped reusable jobs, and whether the SHA is still current:

```bash
gh run view <run-id> --repo TokenBrice/pharos-watch --json status,conclusion,event,headSha,workflowName,url,jobs
gh run view <run-id> --repo TokenBrice/pharos-watch --log-failed
```

2. Classify generated-artifact, docs, test, Pages build/marker, Worker migration/deploy/activation, deploy infrastructure, post-deploy runtime, scheduled automation, or external transient. A skipped child may be expected; interpret the outer aggregate and deploy classifier.
3. Map the failed leaf to the narrowest local reproduction from `package.json` and `docs/testing.md`. Use the `.nvmrc` runtime. Do not widen to `check:pr`, `check:release`, timeout changes, or retries until focused evidence requires it.
4. Fix the smallest causal defect. Generated output follows its registry owner; documentation follows source truth; test expectations change only for intended behavior. For an external failure, record URL, status, non-secret headers, and consumed response body before treating it as transient.

## Iterate And Handoff

Rerun the focused command first. When push/release was requested, follow the protected-main path in `docs/deployment-process.md`; one causal commit/SHA precedes each reassessment. Use `npm run check:release` only for an explicitly requested production rehearsal.

Before manual dispatch, confirm the workflow supports `workflow_dispatch`. `pages-release` is call-only; trigger its owning deploy/rebuild workflow. Watch the exact new run rather than assuming dispatch success.

Scheduled automation failures belong to their own run/branch/issue. Route urgency and freshness through the owning docs instead of copying schedules here.

When the user authorizes delegation, [references/subagents.md](references/subagents.md) provides bounded read-only investigation prompts. The parent owns edits, commits, pushes, retriggers, and judgment.

Report the root cause, changed files, focused verification, retrigger/run status, deployment proof, separate post-deploy operational evidence, and unresolved external risks. Continue until clear when requested, or stop only on a proven external blocker or missing authority.
