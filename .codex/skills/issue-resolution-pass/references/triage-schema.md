# Triage Schema

One row per open issue. Columns, in order:

| Column | Content |
| --- | --- |
| `#` / title / labels | As on GitHub. |
| `Due` | The body's `Due:` date, `none`, or `overdue` with the date. |
| Area | Owning domain; route the likely file with `npm run agent:route -- --file <path>` and name the owning skill when one exists. |
| Verdict | Exactly one value from the table below. |
| Done when | Each open closing clause, quoted, with `met`, `today` or `later`. |
| Evidence read | Files at `origin/main`, commands, live reads with UTC time. |
| Owner question | Decision number, or empty. |
| Today's action | What the plan would do, or empty for excluded rows. |
| Next gate | Date or event for anything left open. |

## Verdicts

| Group | Verdict | Enter only when |
| --- | --- | --- |
| Resolvable today | `close-now` | Every `Done when` clause is already met by evidence read this session; no repo change. |
| Resolvable today | `fix` | Every open clause can be met by work merged and observed today. |
| Resolvable today | `partial-advance` | Some clauses move today and the issue stays open; name the remaining clauses and their gate. A fix whose acceptance observation falls after the session belongs here. |
| Resolvable today | `design-first` | The change touches architecture, methodology, schema or listing scope; today's deliverable is a written design reviewed before any build. |
| Excluded | `excluded-dated` | The next step is an observation or readout that cannot happen before a date; record the date and flag a `Due:` line that disagrees. |
| Excluded | `excluded-blocked` | An upstream, external, credential or owner-only prerequisite blocks it; name the blocker and the re-check date. |
| Excluded | `standing-tracker` | An automated tracker that never closes; list only the items inside their lead time as today's action. |
| Needs owner | `needs-decision` | Policy, scope, methodology, listing or two defensible readings. Transient: re-verdict after the ruling; a row still here at session end is an unanswered decision. |

## Per-Issue Verification

1. Read the body and every comment. Later comments supersede the body; an owner decision comment is binding.
2. Search related issues and PRs (`gh issue list --state all --search "<terms>"`); check whether a merged PR already satisfied or changed the premise.
3. Read the cited code at `origin/main` and its recent history. Reproduce the premise before accepting the issue's proposed fix; the root-cause hypothesis is what the evidence shows.
4. For a runtime claim, make one read-only production read (the issue's `Check`, a public API or status surface) and record its time.
5. For an overdue `Due:`, run the `Check` now and record a due-check verdict.
6. List what could not be verified. Never upgrade a guess to a verdict.

Order the plan by urgency flags found here: `ci:nightly-red`, a review or waiver expiring before the next session (`npm run digest:curation` prints the expiry lookahead), an overdue `Due:`, and test-corpus headroom ([Test corpus budget](../../../../docs/testing.md#test-corpus-budget)).

User intake (`data-correction`, `feature-request`): verify the claim against primary sources before any verdict. A coin-addition request is `fix` only after the read-only [runtime gate](../../stablecoin-runtime-price-marketcap-gate/SKILL.md) passes; otherwise `excluded-blocked` with the gate result.

## Due-Check Verdicts

| Verdict | Meaning | Sweep action |
| --- | --- | --- |
| `pass` | The clause is satisfied by evidence read this run. | Close when every clause passes. |
| `fail` | The check ran and the condition does not hold. | Comment the evidence, move `Due:`, report the needed fix. |
| `not-yet-observable` | The first relevant production execution or readout has not happened. | Move `Due:` to the date it becomes observable. |
| `could-not-check` | A credential, tool or upstream was unavailable. | Comment what was missing by name; move `Due:` to the next session date. |

## Owner Decision Table

| D# | Issue(s) | Question | Options | Recommended default and why | Owner ruling (verbatim, date) | Effect on verdict and plan |
| --- | --- | --- | --- | --- | --- | --- |

- One decision per row, with concrete mutually exclusive options and the recommended default first.
- Put the evidence the owner needs inside the question; they may see only the question.
- Do not ask what code, docs or an earlier owner comment already settles, or what cannot be decided until data exists (that row is `excluded-dated`; prepare the evidence packet instead).
- Record the ruling verbatim. An override of the default is re-checked against the plan before the plan is written.
