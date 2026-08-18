---
name: pharos-release-runner
description: Run the standard Pharos release path when asked to commit in logical/thematic batches, publish through the protected main pull-request gate, or watch the production deployment. Use for release prep, final publish, deployment monitoring, and production handoff after local work is complete.
user_invocable: true
---

# Pharos Release Runner

Use this skill from the Pharos repository root when the user asks to:

- commit pending work in logical or thematic batches
- run an explicit local PR or release rehearsal
- publish through the protected `main` pull-request gate
- watch GitHub Actions or Cloudflare deployment until it clears
- take the local state to production

Do not use this for a pure review with no requested commit/push, or while another active writer owns the same files unless the user explicitly asks you to coordinate.

## Core Rules

- Default to `main` for inspection. Direct pushes are protected. A request to push, publish, release, or take work to production authorizes the necessary release branch and protected-main PR; do not attempt a direct `main` push or ask again solely because branch protection requires a PR.
- Preserve unrelated dirty files. Never stash, reset, checkout, or delete work you did not create unless instructed.
- Commit before publishing. The required `PR gate` check owns the authoritative release gate; the repo pre-commit hook only regenerates and stages the committed generated artifacts affected by the staged files, and aborts rather than staging an artifact whose sources still have unstaged working-tree edits.
- The pushed state must match the validated state. Re-run `git status --short --branch` after long builds or generators.
- Use the exact `.nvmrc` runtime directly in the shell. Do not use a temporary `npx node@...` wrapper: nested `npx --no-install` and workspace commands must inherit the same runtime.
- Distinguish deployment proof from operational acceptance. Worker activation and a Pages release marker prove that the intended artifact is live; cron, memory, scheduler, migration, and ingestion changes require the first relevant production execution before an operational-success claim.
- If the user says other agents are working, skip broad validation/push unless explicitly requested and run only targeted checks for your scope.

## Read First

1. `docs/agent-task-router.md`
2. `docs/deployment-process.md`
3. `docs/testing.md`
4. `docs/process/agent-artifacts.md`

Use the task router and `scripts/ci/pharos-change-contract.ts` to choose any additional docs/checks for the touched files.

## Workflow

### 1. Establish The Release Surface

Run:

```bash
git status --short --branch
git log --oneline --decorate -n 12
git diff --stat
git diff --cached --stat
git fetch origin main
```

Also check `gh pr list` for an open automated shock-coverage refresh PR: it arms auto-merge at creation and self-merges the moment its gate goes green (scheduled every other day), so it can move `main` under your release branch mid-release — rebase or re-fetch before pushing if it lands.

Classify the state:

- already committed ahead of `origin/main`
- cohesive dirty work that should be committed
- multiple unrelated dirty areas
- user/other-agent work that must be left untouched

If the user asked to "commit all pending work", treat cohesive dirty files as in scope, but still exclude clearly unrelated active work and report it.

### 2. Create Logical Commits

Inspect the actual diff before staging. Batch by ownership area, for example:

- stablecoin metadata/data
- shared runtime/schema/contracts
- worker/API/cron
- frontend/page/UI
- validation/scripts/CI
- docs/process/methodology
- `.codex/skills` or agent workflow tooling

Avoid one catch-all commit for mixed runtime, docs, and generated artifacts unless the change is genuinely indivisible.

After each commit, verify the tree state:

```bash
git status --short --branch
```

#### Keep Generated Artifacts With Their Source Commit

The pre-commit hook runs `npm run sync:staged-artifacts`, which regenerates and stages the committed generated artifacts affected by the staged files, so a source commit and its derived output land together. Bypass it only with `PHAROS_SKIP_ARTIFACT_HOOK=1`.

1. Stage the source change with a clean working tree for the affected inputs; the hook aborts instead of staging an artifact whose sources still have unstaged edits.
2. Regenerate the deliberately excluded artifacts yourself: the network-derived `llms-txt`, `public-datasets`, and `homepage-bootstrap` outputs plus the OG builders.
3. When the final source commit stack is stable, run `npm run check:generated-artifacts` to converge the entire registry rather than fixing artifacts one failure at a time.

`sitemap-dates` and `docs-metadata` are gitignored build-time artifacts materialized by `npm run bootstrap:generated:history` and by `prebuild` in the release. They need no commit and are skipped by `--check` runs.

### 3. Validate

Run focused checks selected from the touched files. GitHub Actions remains the release authority after push.

Useful controls:

- `npm run check:pr -- --base=<ref>` runs the adaptive committed-diff PR contract.
- `npm run check:release` runs the optional Pages build/static checks and credential-free Worker bundle proof.
- No local hook gates the push. The pre-commit hook only keeps staged generated artifacts in sync, so run `npm run check:generated-artifacts` yourself before pushing.

Fix failures locally and rerun the failing focused command. Use the full nightly commands directly only when the changed surface warrants them.

### 4. Publish Through The Protected Gate

When focused checks pass and the intended commit stack is clean, use the maintainer-authorized branch/PR path:

```bash
git push -u origin <release-branch>
gh pr create --base main --head <release-branch>
```

Wait for the required `PR gate` check, then merge through GitHub. `gh pr merge <pr> --squash --auto` is a sanctioned option — repo-level auto-merge is enabled, and it queues the merge behind the required checks rather than bypassing them. Do not bypass branch protection or an intentionally enabled local gate. The merge push triggers the deploy classifier.

Record the PR head SHA, merged `main` SHA, selected deployment surfaces, and deploy run id. A skipped reusable job is not a failure by itself; interpret it through the outer workflow classifier and aggregate `PR gate` result.

### 5. Watch Deployment

After the protected PR is merged, watch the `Deploy to Cloudflare` run tied to the resulting `main` SHA — its classifier outputs (`pages_required` / `worker_required`) tell you which deploy surfaces were selected:

```bash
gh run list --repo TokenBrice/pharos-watch --branch main --limit 10
gh run watch <run-id> --repo TokenBrice/pharos-watch --exit-status
```

If the run fails, switch to `$pharos-ci-failure-triage` (the `pharos-ci-failure-triage` skill in Claude Code).

For successful production-changing deploys, confirm the Worker activation proof and/or deployment-specific Pages release-marker proof in the workflow summary. Then apply risk-based acceptance:

- Pages-only presentation or static data: marker proof plus the narrow affected-route smoke when warranted.
- Worker request-path changes: activation proof plus the narrow API/transport smoke for the affected lane.
- Cron, scheduling, ingestion, memory, or migration-sensitive changes: activation proof plus observation of the first matching scheduled execution with `npm run ops:watch-worker-cron` or the owning status/runbook command. Report deployment as successful but operational acceptance as pending until that evidence exists.

Broad live checks remain diagnostic evidence, not automatic rollback triggers. Do not widen an incident remediation while a causal production failure continues; ship the smallest proven correction first.

## Companion Subagents

If the user asks for subagents or the release surface is large, use `references/subagents.md`:

- `pharos-release-reviewer` for independent committed-diff readiness review.
- `release-scope-classifier` for separating intended release files from unrelated dirty work.

The parent agent owns staging, committing, pushing, and final judgment.

## Completion Report

End with:

- commits created or pushed
- focused validation commands, discovery target/report status (including incomplete or provisional evidence), and generated-artifact check outcome
- GitHub Actions run watched and final status, if pushed
- deployment proof separately from operational-acceptance evidence or pending observation window
- any dirty files intentionally left out
- any skipped checks and the reason
