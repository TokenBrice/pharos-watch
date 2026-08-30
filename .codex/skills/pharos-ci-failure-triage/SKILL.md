---
name: pharos-ci-failure-triage
description: Diagnose and fix failed Pharos GitHub Actions, adaptive PR checks, deploy-cloudflare, pages-release, or rebuild-pages runs. Use when a workflow failed, a push/merge gate fails, or the user asks to retrigger and iterate until CI/deploy clears.
user_invocable: true
---

# Pharos CI Failure Triage

Use this skill from the Pharos repository root for:

- failed `npm run check:pr` or `npm run check:release`
- failed GitHub Actions runs
- failed `Deploy to Cloudflare`
- failed `Rebuild Pages`
- failed `pages-release`, Worker migration/deploy/activation, Pages build/marker, generated-artifact, or docs checks
- requests to retrigger a workflow and keep iterating until it clears

## Core Rules

- Start from logs and the exact failing command. Do not guess from the workflow name alone.
- Classify the failing lane before editing: generated artifact, docs, tests, Pages build/marker, Worker migration/deploy/activation, deploy infra, post-deploy runtime, scheduled automation (bot PRs), or external transient.
- Read the outer and reusable workflow graph together. A skipped child job can be expected classifier behavior; the aggregate gate, selected surface, head SHA, and exact failed step determine the result.
- Reproduce locally with the narrowest equivalent command before broad gates when possible.
- Do not change test timeouts or retry policy merely because a local run was resource-starved. Reproduce the focused lane alone first.
- Do not add retries, credentials, or alternate origins until an external response is attributed to the edge, Worker route, application auth, or upstream provider from its URL, status, headers, and consumed body.
- Preserve unrelated dirty work. If other agents are editing, patch only the failing lane and do not push unless explicitly requested.
- If production deploy is requested, keep iterating until the workflow clears or a real external blocker is proven.

## Read First

1. `docs/agent-task-router.md`
2. `docs/testing.md`
3. `docs/deployment-process.md`
4. `docs/scripts.md`

For workflow edits, also inspect `.github/workflows/*` and `scripts/lib/automation-registry.mjs` as needed.

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
npm run check:pr -- --base=origin/main
npm run check:generated-artifacts
npm run check:doc-source-paths
npm run check:doc-sync
npm run check:stablecoin-data
npm run build
npm run seo:check
npm run typecheck
npm run typecheck:worker
npm run test:all -- --shard=1/2
npm run coverage:critical
npm run test:a11y
npm run validate:pages-smoke
npm run validate:worker-smoke
```

Use the exact `.nvmrc` runtime in the current shell. `check:pr` runs the committed-diff adaptive contract; use its failing leaf command for fast iteration. `check:release` is the optional Pages build plus Worker bundle rehearsal. `coverage:critical` is blocking in its weekly/manual workflow and runs on pull requests only when an enrolled critical source changes; `test:all`, full lint, and test typechecking belong to nightly/manual validation.

Use `scripts/ci/classify-deploy-changes.ts` and `scripts/ci/pharos-change-contract.ts` when deploy-surface classification is unclear.

### 3. Fix The Root Cause

Preferred fixes:

- Generated artifact drift: run `npm run check:generated-artifacts` to see every stale entry, then the owning generator/check from `scripts/lib/automation-registry.mjs`, inspect the diff, and commit generated output with the source change. After the final source state, rerun the full check so dependent or non-obvious projections converge together.
- Shallow-checkout failure in a history-derived generator: `assertFullGitHistory()` in `scripts/lib/git-history.mts` fails `sitemap-dates` and `docs-metadata` fast on a shallow clone rather than publishing wrong dates. Fix the job by setting `fetch-depth: 0` on its `actions/checkout` step, or run `git fetch --unshallow` locally; do not relax the guard.
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
npm run check:pr -- --base=origin/main
git push -u origin <fix-branch>
gh pr create --base main --head <fix-branch>
gh pr checks <pr-number> --watch
```

Run `npm run check:release` only when the user wants an explicit local production-build rehearsal. The required GitHub `PR gate` is authoritative. Merge through the protected PR path, then find and watch the resulting `main` deployment; do not push directly to `main`.

If a pushed workflow fails again, repeat from Step 1 with the new run id. Do not layer speculative fixes across retries: one causal change, one new SHA, then reassess the exact failing lane.

### 5. Retriggering

For manual workflow dispatch, use the repo workflow file/name and `main` ref. Confirm the workflow supports `workflow_dispatch` before running it.

Examples:

```bash
gh workflow run "Deploy to Cloudflare" --repo TokenBrice/pharos-watch --ref main -f surface=both
gh workflow run "Rebuild Pages" --repo TokenBrice/pharos-watch --ref main
```

`pages-release` is `workflow_call`-only and cannot be dispatched directly. It is called by both Deploy to Cloudflare and Rebuild Pages: use Deploy with `-f surface=pages` for a code-surface release, or dispatch Rebuild Pages for the API-backed snapshot refresh path.

Then watch the new run with `gh run list` and `gh run watch`.

### 6. Scheduled Automation Failures

Most workflows in `.github/workflows/` are scheduled automation. Shock-coverage refresh, protocol-API mechanism refresh, and OG refresh can open PRs; maintenance candidates opens or updates an issue, while nightly validation, coverage ratchets, and security scans report through their workflow runs. A failure there is not automatically a push/merge-gate failure — triage the automation's own run and any branch or issue it owns.

The shock-coverage refresh is the urgent one: its PR arms auto-merge at creation (repo-level auto-merge is enabled but per-PR opt-in; this is the one automation that opts in), so it self-merges the moment its gate goes green — and the underlying measurements carry a hard 72h freshness bound past which the V9 engine fails closed to degraded backing scores. If that loop is broken, check `scripts/ci/check-shock-coverage-freshness.ts` and follow `docs/process/shock-coverage-refresh.md`.

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
