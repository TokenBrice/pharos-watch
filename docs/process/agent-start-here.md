# Agent Start Here

Use this page for repository work in omp, Claude Code, Codex, or another compatible harness. Harness-specific conveniences never override repository scope, safety, or verification rules.

## 1. Before Touching Files

Read the root `AGENTS.md` or `CLAUDE.md` first. For non-trivial work, route every planned path before editing:

```bash
npm run agent:route -- --file <path>
```

Read only the documents, anchors, and scoped `AGENTS.md` files the router returns, then inspect the source entrypoint and its local imports. Code, schemas, registries, and checked runtime data win when prose disagrees. Author root guidance in `CLAUDE.md`; root `AGENTS.md` is generated and must not be edited by hand.

Use native read, grep, glob, and edit tools first. Use Bash for real commands. If a harness rejects a shell command because a native tool shadows it, switch tools and never retry the same shell command.

## 2. Scratch Work

Put plans, research, screenshots, reports, captures, and handoffs under ignored `agents/<YYYY-MM-DD>-<slug>/`. Durable product, process, API, methodology, and operating truth belongs in the closest verified page under `docs/`, not in scratch.

Every campaign needs a README that records its owner, status, created and last-reviewed dates, source or plan, durable destinations, retention rule, and safe-to-remove condition. Follow the ledger and handoff convention in [Agent Artifacts](./agent-artifacts.md). Never infer that an ignored or old artifact is disposable.

## 3. Scope Safety

Treat unrelated working-tree changes as someone else's work. Do not revert, reformat, stage, or fold them into the task. Make the smallest root-cause change within the explicit file allowlist.

Do not create a branch, worktree, or pull request unless requested. Do not expose credentials, copy production Worker secrets into local files, run D1 migrations without the stated rollout authority, or edit generated outputs by hand. Check the documented environment source before reporting a local variable missing, and report only the variable name.

## 4. Verification

Choose the smallest adequate checks from [Testing: Smallest adequate check per area](../testing.md#smallest-adequate-check-per-area). Preserve nearby formatting because the repository has no canonical formatter, and finish with `git diff --check`. For larger committed batches, use `npm run check:pr -- --base=<ref>`; GitHub Actions remains the authoritative release gate.

Passing deployment proves activation, not runtime health. Cron, scheduler, ingestion, migration, and other operationally risky changes also require the first relevant production execution or observation before being called operationally complete.

## 5. Handoff

The final message must state:

- status: complete, partial, or blocked;
- exact changed files;
- verification commands and outcomes, including known failures;
- blockers and deferred items; and
- the next owner or action.

For a campaign, also update its ledger so every task ID ends as complete, deferred, superseded, or blocked. Record actual changed files and net LOC when the campaign contract requests them.

## 6. Commit And Release

Group changes into logical commits. Use a descriptive subject and a useful body explaining what changed and why. Batch commit bodies must include the stable scratch plan path and task IDs, for example:

```text
Plan: agents/<YYYY-MM-DD>-<slug>/IMPLEMENTATION-PLAN.md
Tasks: W2.6
```

The pre-commit hook may regenerate and stage registered artifacts marked `autoStage`; inspect that result as part of the same source commit. Publishing uses the protected-main branch and pull-request path. Never direct-push `main`.

## 7. Finish

Report the final artifact or plan path, verification and CI/deploy evidence, and any operational acceptance still pending. Name scratch as safe to remove only when its recorded condition is satisfied and its owner confirms closure. The handoff is complete when the next owner can continue without reconstructing scope, state, or evidence.
