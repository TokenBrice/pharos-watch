---
name: pharos-ci-failure-triage
description: Diagnose and fix failed Pharos GitHub Actions, merge-gate, deploy-cloudflare, pages-release, or rebuild-pages runs. Use when a workflow failed, a push/merge gate fails, or the user asks to retrigger and iterate until CI/deploy clears.
user_invocable: true
---

# Pharos CI Failure Triage

Use this skill from the Pharos repository root for:

- failed `npm run test:merge-gate`
- large local `npm run test:merge-gate` cleanup loops after post-swarm or post-merge batches
- failed GitHub Actions runs
- failed `Deploy to Cloudflare`
- failed `Rebuild Pages`
- failed `pages-release`, worker deploy, smoke, SEO, build-size, generated-artifact, or docs checks
- requests to retrigger a workflow and keep iterating until it clears

## Core Rules

- Start from logs and the exact failing command. Do not guess from the workflow name alone.
- Classify the failing lane before editing: generated artifact, docs, tests, Pages build/smoke, Worker typecheck/smoke, migration, deploy infra, or external transient.
- Reproduce locally with the narrowest equivalent command before broad gates when possible.
- For large local batches, use discovery mode to collect failures before the final authoritative gate.
- Preserve unrelated dirty work. If other agents are editing, patch only the failing lane and do not push unless explicitly requested.
- If production deploy is requested, keep iterating until the workflow clears or a real external blocker is proven.

## Read First

1. `docs/agent-task-router.md`
2. `docs/testing.md`
3. `docs/deployment-process.md`
4. `docs/scripts.md`

For workflow edits, also inspect `.github/workflows/*` and `scripts/lib/validation-lanes.mjs` or `scripts/lib/automation-registry.mjs` as needed.

## Workflow

### 1. Capture The Failure

For GitHub Actions:

```bash
gh run view <run-id> --repo TokenBrice/pharos-watch --json status,conclusion,event,headSha,workflowName,url,jobs
gh run view <run-id> --repo TokenBrice/pharos-watch --log-failed
```

For local gate failures, keep the command output and identify the first failing script, not the final aggregate failure.

Record:

- workflow/run id or local command
- failed job and step
- failing SHA/range
- exact command and first actionable error

### 2. Classify The Lane

Common local repro commands:

```bash
npm run test:merge-gate:discover
npm run check:generated-artifacts
npm run check:doc-source-paths
npm run check:doc-sync
npm run check:stablecoin-data
npm run build
npm run seo:check
npm run typecheck
npm run typecheck:worker
npm run test:noncritical -- --shard=1/4
npm run coverage:critical
npm run test:a11y
npm run validate:pages-smoke
npm run validate:worker-smoke
```

Use `npm run test:merge-gate:discover` when a large local batch is failing one lane at a time. It mirrors the merge-gate plan, runs `validate:prebuild` with continue-on-error, keeps independent postbuild lanes running after failures, and skips smoke by default. Tune it with `MERGE_GATE_DISCOVERY_MAX_PARALLEL=<n>`; set `MERGE_GATE_DISCOVERY_SMOKE=1` only when smoke is the current target. Discovery success is not a release proof.

Use `scripts/ci/classify-deploy-changes.mjs` and `scripts/ci/pharos-change-contract.mjs` when deploy-surface classification is unclear.

### 3. Fix The Root Cause

Preferred fixes:

- Generated artifact drift: run the owning generator/check from `scripts/lib/automation-registry.mjs`, inspect the diff, and commit generated output with the source change.
- Docs path/version drift: update the verified doc or source reference; do not silence checks.
- Test expectation drift: verify runtime behavior first, then update tests only when the behavior is intended.
- Pages smoke/SEO failure: inspect built `out/` and the route source; rebuild before rerunning `seo:check`.
- Worker type/smoke failure: inspect shared/worker imports and runtime env contracts; avoid adding frontend-only imports to shared Worker paths.
- External transient: rerun only after proving the failure is network/provider/transient, and report the evidence.

Avoid broad rewrites while fixing CI. Make the smallest root-cause patch.

### 4. Validate And Iterate

Rerun the failing local command first. If the user asked for release/push:

```bash
npm run test:merge-gate:discover # for large batches only; diagnostic
npm run test:merge-gate
git push origin main
gh run watch <run-id> --repo TokenBrice/pharos-watch --exit-status
```

If a pushed workflow fails again, repeat from Step 1 with the new run id.

### 5. Retriggering

For manual workflow dispatch, use the repo workflow file/name and `main` ref. Confirm the workflow supports `workflow_dispatch` before running it.

Examples:

```bash
gh workflow run "Deploy to Cloudflare" --repo TokenBrice/pharos-watch --ref main
gh workflow run "Rebuild Pages" --repo TokenBrice/pharos-watch --ref main
```

Then watch the new run with `gh run list` and `gh run watch`.

## Companion Subagents

Use `references/subagents.md` when the user authorizes subagents:

- `github-actions-log-investigator` for read-only log triage.
- `ci-repro-mapper` for mapping failed CI steps to local commands.

The parent agent owns edits, commits, pushes, and retriggers.

## Completion Report

Report:

- failing run/command and root cause
- files changed, if any
- local validation command(s)
- retriggered/watched workflow and final status
- remaining external risks or skipped lanes
