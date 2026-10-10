---
name: pharos-ci-failure-triage
description: Diagnose and fix failed Pharos GitHub Actions, adaptive PR checks, Cloudflare deploys, Pages releases, or scheduled automation. Use when a gate/run failed or the user asks to retrigger and iterate until clear.
user_invocable: true
---

# Pharos CI Failure Triage

The authoritative contracts are [Testing §Commands](../../../docs/testing.md#commands), [§Pre-push readiness](../../../docs/testing.md#pre-push-readiness), [§CI Pipeline](../../../docs/testing.md#ci-pipeline), [Deployment §CI Deploy Sequence](../../../docs/deployment-process.md#ci-deploy-sequence), and [§Failure Policy](../../../docs/deployment-process.md#failure-policy). Read `docs/scripts.md` and the relevant workflow/source after routing the failing path.

## Triage

1. Capture the run ID/URL, event, head SHA, **every failed leaf job/step**, each exact command and first actionable error, selected/skipped reusable jobs, and whether the SHA is still current:

```bash
gh run view <run-id> --repo TokenBrice/pharos-watch --json status,conclusion,event,headSha,workflowName,url,jobs
gh run view <run-id> --repo TokenBrice/pharos-watch --log-failed
```

2. Classify every failure: generated-artifact, docs, test, Pages build/marker, Worker migration/deploy/activation, deploy infrastructure, post-deploy runtime, scheduled automation, or external transient. A skipped child may be expected; interpret the outer aggregate and deploy classifier. Do not stop at the aggregate or first red step.
3. Map each failed leaf to the narrowest local reproduction from `package.json` and `docs/testing.md`. Use mise shims reading `.nvmrc`: enable `mise settings add idiomatic_version_file_enable_tools node` before `mise install`; readiness requires exact `.nvmrc` Node and npm 11.x. Start with narrow diagnosis, not `check:pr`, `check:release`, timeout changes, or retries. If the remote failure is not reproduced by the local gate, opt into `npm run check:pr -- --ci-parity`; also use it for lockfile/setup/security-policy changes.
4. Fix all causal defects from the failed leaves in one revision. Generated output follows its registry owner; documentation follows source truth; test expectations change only for intended behavior. For an external failure, record URL, status, non-secret headers, and consumed response body before treating it as transient. Infrastructure/provider failures do not justify unrelated source churn.

## Iterate And Handoff

Rerun each focused reproduction first; these results are authoring feedback, **not** readiness proof. Before any replacement push, follow [Pre-push readiness](../../../docs/testing.md#pre-push-readiness): finish and commit the causal revision/integration history, run full `npm run check:generated-artifacts` convergence, then full plain `npm run check:pr` on the final committed state with no skip/filter/plan-only/no-fetch flags or selection overrides. Require a fresh passing `.tmp/pr-check-receipts/<HEAD>.json`, then push once through protected main when authorized. Repeat after edits/integration. Parity supplements plain readiness; add `--with-coverage`/`--with-pages` for remote failures or floor/budget changes per Testing. Use `check:release` only for requested production rehearsal.

Use `npm run ci:census` only when asked to measure CI trends or recovery cohorts; it is not a failure reproduction or readiness gate. Review failed leaf evidence rather than inferring cause from aggregate census outcomes.

Before manual dispatch, confirm the workflow supports `workflow_dispatch`. `pages-release` is call-only; trigger its owning deploy/rebuild workflow. Watch the exact new run rather than assuming dispatch success.

Scheduled automation failures belong to their own run/branch/issue. Route urgency and freshness through the owning docs instead of copying schedules here.

When the user authorizes delegation, [references/subagents.md](references/subagents.md) provides bounded read-only investigation prompts. The parent owns edits, commits, pushes, retriggers, and judgment.

Report every failed leaf and its root cause, changed files, focused reproductions, full readiness and HEAD receipt evidence before any replacement push, retrigger/run status, deployment proof, separate post-deploy operational evidence, and unresolved external risks. Continue until clear when requested, or stop only on a proven external blocker or missing authority. Verify current dependency-advisory, provider-access, and incident-alert-secret blockers against their owning testing, coverage, and deployment docs; never claim an external prerequisite resolved from a local passing repro.
