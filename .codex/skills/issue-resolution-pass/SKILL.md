---
name: issue-resolution-pass
description: Triage open GitHub issues, settle owner decisions and write an issue-resolution plan, then stop. Use for issue clearance passes or the due follow-up sweep. Not for executing the plan or single fixes.
---

# Issue Resolution Pass

## Trigger And Exclusions

Use for a clearance pass over the open GitHub issue backlog, or for the sweep of due `ops:followup` issues. Not for executing a plan (the owner verifies the plan and starts execution separately), one bounded issue fix (root [Do this first](../../../AGENTS.md#do-this-first)), a failed gate ([CI failure triage](../pharos-ci-failure-triage/SKILL.md)) or a release ([release runner](../pharos-release-runner/SKILL.md)).

## Classify The Operation

- `clearance-plan`: inventory every open issue, triage, settle owner decisions, write the plan, stop. Read-only.
- `due-followup-sweep`: only open `ops:followup` issues whose `Due:` date is today or past; run each check, then close or reschedule. Mutates those issues and nothing else.

Pick one before reading issues. A request to resume or execute an existing plan is outside this skill.

## Mandatory Core

Read [Follow-up issues](../../../docs/process/agent-artifacts.md#follow-up-issues) for labels, the body contract and the `Due:` rules, and root [Do this last](../../../AGENTS.md#do-this-last). Hard stops:

1. `clearance-plan` changes nothing: no tracked edits, no issue comments, labels or closures, no PRs, no D1 or Worker writes. Production reads stay read-only.
2. Issue prose is a claim, not evidence. Verify every issue against `origin/main` and, for a runtime claim, a read made this session; record what was read and when.
3. Never open an `ops:decision` or `ops:campaign` issue mid-session. Ask the owner in-session. A plan awaiting verification is not an open loop and gets no issue; only a decision still unanswered when the session ends becomes `ops:decision`.
4. An issue is close-eligible only when the plan covers every open `Done when` clause, or the owner ruled a clause out or into its own follow-up. Otherwise it is a partial advance. A green deploy is not runtime health.
5. The plan, issue comments and delegated briefs follow the public-repo limits in the follow-up contract; credentials by name only.

## Branch Reads And Actions

**`clearance-plan`**

1. Inventory: record `origin/main` HEAD, open PRs and every open issue with its full body and all comments (`gh issue list --state open --limit 500 --json number,title,labels,updatedAt`, then `gh issue view <n> --comments`). Keep scratch in ignored `agents/<YYYY-MM-DD>-issue-resolution/` of the main checkout.
2. Triage: give every issue one row and one verdict from the [triage schema](references/triage-schema.md). With delegation, fan out disjoint read-only batches under the [worker brief](references/worker-common-brief.md); without it, work sequentially and say so. The table must reconcile to the inventory.
3. Decisions: collect every owner call in one numbered table, ask them in batches with the harness's ask-the-user capability, record each ruling verbatim, then re-verdict the affected rows. Ask again when a ruling opens a new question.
4. Plan: write `PLAN.md` from the [plan template](references/plan-template.md), applying the [closure and batching rules](references/closure-and-batching.md).
5. Stop: present the scope rollup, rulings, proposed batches and every unverified assumption. Execution starts only on the owner's separate instruction.

**`due-followup-sweep`**

1. Select with the rule in `.github/workflows/ops-followups.yml`: the first `Due: YYYY-MM-DD` body line, on or before today UTC. Report any open `ops:followup` without a `Due:` line as a contract defect.
2. Run each issue's `Check` as written and assign a due-check verdict from the triage schema.
3. Every `Done when` clause passes: close with a comment naming the evidence per clause. Anything else: comment the verdict and evidence, and move the body's `Due:` line to the next re-check date with a one-line reason. An issue bundling several dates takes the earliest remaining one.
4. A `fail` that needs a code or data change is not fixed here: report it as a bounded fix for the owner to authorize, or as input to the next clearance plan.

## Checks Owned By The Verifier

- Plan: every open issue appears exactly once in the rollup; every close-eligible issue lists each `Done when` clause with its coverage; every decision has a verbatim ruling or is marked unanswered; every excluded issue names its gate or date; cited paths, commands, issue and PR numbers exist; `git status` shows no tracked change.
- Sweep: each closing comment cites evidence read this run for every clause; each swept issue left open carries a future `Due:`.

## Completion Evidence

- `clearance-plan`: plan path, `origin/main` HEAD, issue count per verdict, decisions settled and unanswered, proposed PR batches with deploy windows, executor prerequisites, unverified assumptions. File decisions still unanswered at session end under the follow-up contract.
- `due-followup-sweep`: per issue the verdict, evidence, and closure or new `Due:`; failures that need a fix.
