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
- failed `pages-release`, Worker migration/deploy/activation, Pages build/marker, generated-artifact, or docs checks
- requests to retrigger a workflow and keep iterating until it clears

## Core Rules

- Start from logs and the exact failing command. Do not guess from the workflow name alone.
- Classify the failing lane before editing: commit-derived artifact, other generated artifact, docs, tests, Pages build/marker, Worker migration/deploy/activation, deploy infra, post-deploy runtime, or external transient.
- Read the outer and reusable workflow graph together. A skipped child job can be expected classifier behavior; the aggregate gate, selected surface, head SHA, and exact failed step determine the result.
- Reproduce locally with the narrowest equivalent command before broad gates when possible.
- For large local batches, use diagnostic discovery to collect failures across independent lanes; it is not a final gate and does not create release proof.
- Do not change test timeouts or retry policy merely because a locally parallel run was resource-starved. Reproduce the focused lane serially or cap discovery fan-out first.
- Do not add retries, credentials, or alternate origins until an external response is attributed to the edge, Worker route, application auth, or upstream provider from its URL, status, headers, and consumed body.
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
- outer workflow conclusion, selected/skipped reusable jobs, and expected surface from the classifier
- whether the failed SHA is still the current PR or `main` head

### 2. Classify The Lane

Common local repro commands:

```bash
npm run test:merge-gate:discover -- --target=pr
npm run check:commit-derived-artifacts
npm run check:generated-artifacts
npm run check:doc-source-paths
npm run check:doc-sync
npm run check:stablecoin-data
npm run build
npm run seo:check
npm run typecheck
npm run typecheck:worker
npm run test:noncritical -- --shard=1/2
npm run coverage:critical
npm run test:a11y
npm run validate:pages-smoke
npm run validate:worker-smoke
```

Use one full `npm run test:merge-gate:discover -- --target=pr` when a large local batch is failing one lane at a time. The runner expands prebuild and generated-artifact checks into atomic nodes, runs all dependency-ready work, blocks `out/` consumers after a failed Pages build, and writes a stable failed/blocked/tainted/incomplete/omitted summary to `.cache/merge-gate/discovery/latest.json`. For Pages-changing PR parity, load the intended public values and set `MERGE_GATE_PRODUCTION_ENV=1`; otherwise treat the explicit environment result as incomplete. Use `local-gate` for optional local-gate parity, `release` for a clean production-bound snapshot, and `maintenance` for broad nonblocking advisories. CPU-heavy postbuild work is serial by default; set `MERGE_GATE_DISCOVERY_MAX_PARALLEL` above `1` only for an intentional performance experiment. `MERGE_GATE_PARALLEL=0` is accepted as a serial compatibility alias.

Use the exact `.nvmrc` runtime in the current shell. Scope production Pages variables to the Pages rehearsal command or a clean subshell; do not export Pages-only flags globally across Vitest and Worker commands. If an explicitly parallel local run looks load-dependent, rerun the exact shard or build alone and return to `MERGE_GATE_DISCOVERY_MAX_PARALLEL=1` before changing code or test budgets.

Fix every blocking root failure from the report and use the listed focused rerun commands while editing. If failed producers left blocked or tainted nodes, run the same target with `--resume`; this reruns those nodes and their dependencies without claiming that prior passing nodes are release proof. Run another full discovery only when the changed snapshot broadly invalidates the original plan. A provisional or incomplete report is not green, and no discovery report is a reusable receipt.

`coverage:critical` failures belong to the weekly/manual Critical Coverage Ratchet workflow or direct local rehearsals, not the blocking reusable validate workflow. The normal `test:noncritical` lane includes critical tests despite the legacy script name.

Use `scripts/ci/classify-deploy-changes.mjs` and `scripts/ci/pharos-change-contract.mjs` when deploy-surface classification is unclear.

### 3. Fix The Root Cause

Preferred fixes:

- Commit-derived artifact drift: inspect the `inputState: "committed-history"` entries in `scripts/lib/automation-registry.mjs`. Commit the relevant source first, regenerate `sitemap-dates` or `docs-metadata`, then commit or amend the output. Never regenerate against dirty history inputs and call that final.
- Other generated artifact drift: run the owning generator/check from `scripts/lib/automation-registry.mjs`, inspect the diff, and commit generated output with the source change. After the final source state, run the full `npm run check:generated-artifacts` so dependent or non-obvious projections converge together.
- Docs path/version drift: update the verified doc or source reference; do not silence checks.
- Test expectation drift: verify runtime behavior first, then update tests only when the behavior is intended.
- Pages smoke/SEO failure: inspect built `out/` and the route source; rebuild before rerunning `seo:check`.
- Worker type/smoke failure: inspect shared/worker imports and runtime env contracts; avoid adding frontend-only imports to shared Worker paths.
- External transient: capture the requested URL, response provenance, status, relevant non-secret headers, and consumed response body. Rerun the same SHA only after proving the failure is network/provider/transient; a code or configuration fix requires a new commit and run.

The production deploy workflow does not automatically roll back. A failed Worker activation or Pages marker proof requires causal assessment first; use Cloudflare deployment history for operator-led rollback and remember that Worker rollback does not revert D1 or other bound resources.

A green Worker upload/activation is not proof that scheduled work is healthy. For cron, scheduler, ingestion, memory, or migration incidents, inspect the first relevant production execution before closure. Keep the deployment result and operational-health result separate in the report.

Avoid broad rewrites while fixing CI. Make the smallest root-cause patch.

### 4. Validate And Iterate

Rerun the failing local command first. If the user asked for release/push:

```bash
npm run test:merge-gate:discover -- --target=pr # one full large-batch diagnostic
npm run test:merge-gate:discover -- --target=pr --resume # blocked/tainted convergence only
git push -u origin <fix-branch>
gh pr create --base main --head <fix-branch>
gh pr checks <pr-number> --watch
```

Run `npm run test:merge-gate` before publishing only when the user wants an explicit local rehearsal or when you are debugging a local gate failure. The required GitHub `PR gate` is authoritative. Merge through the protected PR path, then find and watch the resulting `main` deployment; do not push directly to `main`.

If a pushed workflow fails again, repeat from Step 1 with the new run id. Do not layer speculative fixes across retries: one causal change, one new SHA, then reassess the exact failing lane.

### 5. Retriggering

For manual workflow dispatch, use the repo workflow file/name and `main` ref. Confirm the workflow supports `workflow_dispatch` before running it.

Examples:

```bash
gh workflow run "Deploy to Cloudflare" --repo TokenBrice/pharos-watch --ref main -f surface=both
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
- deployment proof and post-deploy operational evidence as separate results
- remaining external risks or skipped lanes
