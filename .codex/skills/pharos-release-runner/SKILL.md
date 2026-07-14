---
name: pharos-release-runner
description: Run the standard Pharos release path when asked to commit in logical/thematic batches, run the merge or push gate, push main, or watch the production deployment. Use for release prep, final publish, deployment monitoring, and production handoff after local work is complete.
user_invocable: true
---

# Pharos Release Runner

Use this skill from the Pharos repository root when the user asks to:

- commit pending work in logical or thematic batches
- run the local merge/push gate
- push `main`
- watch GitHub Actions or Cloudflare deployment until it clears
- take the local state to production

Do not use this for a pure review with no requested commit/push, or while another active writer owns the same files unless the user explicitly asks you to coordinate.

## Core Rules

- Default to `main`. Do not create a branch, worktree, or PR unless the user explicitly asks.
- Preserve unrelated dirty files. Never stash, reset, checkout, or delete work you did not create unless instructed.
- Commit before pushing. GitHub Actions owns the authoritative release gate; the repo pre-push hook is advisory-only by default and runs the exact-range local merge gate only when `PHAROS_PRE_PUSH_GATE=main` or `PHAROS_PRE_PUSH_GATE=all` is set.
- The pushed state must match the validated state. Re-run `git status --short --branch` after long builds or generators.
- If the user says other agents are working, skip broad validation/push unless explicitly requested and run only targeted checks for your scope.

## Read First

1. `docs/agent-task-router.md`
2. `docs/deployment-process.md`
3. `docs/testing.md`
4. `docs/process/agent-artifacts.md`

Use the task router and `scripts/ci/pharos-change-contract.mjs` to choose any additional docs/checks for the touched files.

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

### 3. Validate

Run focused checks selected from the touched files. Use the local merge gate only for an explicit rehearsal or failure investigation; GitHub Actions remains the release authority after push.

Useful controls:

- `MERGE_GATE_DRY_RUN=1 npm run test:merge-gate` to inspect the planned commands.
- An intentional manual `npm run test:merge-gate` writes a reusable receipt only when it validates a clean committed state. A subsequent matching push reuses that receipt instead of running the gate again.
- `PHAROS_PRE_PUSH_GATE=main git push origin main` opts into the exact-range local merge gate before sending `main`.
- `MERGE_GATE_PAGES_SMOKE=0 npm run test:merge-gate` only when the user explicitly asked to skip Pages smoke.
- `MERGE_GATE_WORKER_SMOKE=1 npm run test:merge-gate` when worker smoke is needed before a risky worker release.
- `npm run test:merge-gate:discover` for large failure-discovery passes only. It runs the deploy-impact plan diagnostically, skips advisory prebuild unless `VALIDATE_PREBUILD_INCLUDE_ADVISORY=1` is set, skips smoke unless `MERGE_GATE_DISCOVERY_SMOKE=1` is set, caps default fan-out at 3, and does not create a release proof or receipt.

Fix failures locally, commit the fixes, and rerun the failing focused command. Use the local merge gate manually only for deliberate rehearsal or failure investigation.

### 4. Push

When focused checks pass and the intended commit stack is clean:

```bash
git push origin main
```

By default the pre-push hook prints that GitHub Actions is authoritative and lets `main` pushes continue. If `PHAROS_PRE_PUSH_GATE=main` is set, the hook runs the merge gate against the exact pushed range and blocks the push on failure. Do not use `--no-verify` to bypass an intentionally enabled local gate.

### 5. Watch Deployment

After push, watch the GitHub Actions run tied to the pushed SHA:

```bash
gh run list --repo TokenBrice/pharos-watch --branch main --limit 10
gh run watch <run-id> --repo TokenBrice/pharos-watch --exit-status
```

If the run fails, switch to `$pharos-ci-failure-triage` (the `pharos-ci-failure-triage` skill in Claude Code).

For successful production-changing deploys, confirm the relevant live smokes from the workflow summary. If the touched area needs extra live confidence, run the narrow smoke command from `docs/testing.md` rather than a broad ad hoc probe.

## Companion Subagents

If the user asks for subagents or the release surface is large, use `references/subagents.md`:

- `pharos-release-reviewer` for independent committed-diff readiness review.
- `release-scope-classifier` for separating intended release files from unrelated dirty work.

The parent agent owns staging, committing, pushing, and final judgment.

## Completion Report

End with:

- commits created or pushed
- focused validation commands and pre-push gate outcome, if the hook was opted into the local gate
- GitHub Actions run watched and final status, if pushed
- any dirty files intentionally left out
- any skipped checks and the reason
