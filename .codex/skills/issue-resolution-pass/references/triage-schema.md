# Triage Schema

One row per triaged open issue (`ops:calendar` and `ops:upstream-wait` issues with `Due: > today + 7d` are auto-skipped in `clearance-plan` and reconciled via the plan's Scope rollup). Columns, in order:

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
| Resolvable today | `close-redundant` | Duplicate of another open issue, split-date sibling consolidated into one surviving issue, fully owned by an automated tracker/calendar (`#945`, `#1302`, `npm run digest:curation`, `reviewBy`/`expiresAtSec`), or a self-monitored/low-value check retired by owner ruling. No repo change. |
| Resolvable today | `fix` | Every open clause can be met by work merged and observed today (including previously approved `design-first` issues carrying a `Build-ready:` comment). Do not bundle buildable fixes with passive external waits or post-deploy verification in one issue. |
| Resolvable today | `partial-advance` | Some clauses move today and the issue stays open; name the remaining clauses and move `Due:` to the earliest remaining gate (never close-and-spin-off). A fix whose unmonitored acceptance observation falls after the session belongs here. |
| Resolvable today | `design-first` | The change touches architecture, methodology, schema or listing scope and needs a written design reviewed before build. Cap at 1–2 bounded designs per pass that can be built in-pass; route multi-PR architecture work to dedicated single-topic sessions. Once approved, post `Build-ready: <memo path or summary>` on the issue so the next pass treats it immediately as `fix` instead of re-triaging. |
| Excluded | `excluded-dated` | The next step is an observation or readout that cannot happen before a date **and** the row is not `close-redundant`; record the date and flag a `Due:` line that disagrees. `ops:calendar` issues with `Due: > today + 7d` auto-skip in `clearance-plan` without triage rows. |
| Excluded | `excluded-blocked` | An upstream, external, credential or owner-only prerequisite blocks it; name the blocker and the re-check date. `ops:upstream-wait` issues with `Due: > today + 7d` auto-skip in `clearance-plan`; when due, apply the **Upstream-Wait Backoff & 3-Strike Rule** below. |
| Excluded | `standing-tracker` | An automated tracker that never closes; act on items inside their lead time directly in the pass, and never spawn manual `ops:followup` issues for queued/future items the tracker already owns. |
| Needs owner | `needs-decision` | Policy, scope, methodology, listing or two defensible readings. Transient: re-verdict after the ruling; a row still here at session end is an unanswered decision. |

## Per-Issue Verification

1. Read the body and every comment. Later comments supersede the body; an owner decision comment is binding.
2. Search related issues and PRs (`gh issue list --state all --search "<terms>"`); check whether a merged PR already satisfied or changed the premise.
3. Read the cited code at `origin/main` and its recent history. Reproduce the premise before accepting the issue's proposed fix; the root-cause hypothesis is what the evidence shows.
4. For a runtime claim, make one read-only production read (the issue's `Check`, a public API or status surface) and record its time.
5. For an overdue `Due:`, run the `Check` now and record a due-check verdict.
6. List what could not be verified. Never upgrade a guess to a verdict.
7. Backlog hygiene check (applies to future-dated rows too): flag duplicates of automated trackers (`#945`, `#1302`, `npm run digest:curation`, `reviewBy`/`expiresAtSec`), split-date siblings of one feature/rollout, and self-monitored or low-value polish tickets for `close-redundant` or a batched owner retirement decision. Stay scoped to the open backlog; do not run open-ended audits that manufacture non-bug tickets.
8. Keep buildable fixes separate from passive external waits or post-deploy verification: do not bundle them in one issue — finish and close the buildable fix cleanly, and track any required unmonitored wait (`ops:upstream-wait`) or custom soak (`ops:followup`) separately only when it clears the filing bar.

Order the plan by urgency flags found here: `ci:nightly-red`, a review or waiver expiring before the next session (`npm run digest:curation` prints the expiry lookahead), an overdue `Due:`, and test-corpus headroom ([Test corpus budget](../../../../docs/testing.md#test-corpus-budget)).

User intake (`data-correction`, `feature-request`): verify the claim against primary sources before any verdict. A coin-addition request first clears [Instrument Eligibility](../../../../docs/listing-policy.md#instrument-eligibility) (out of scope is `needs-decision`, proposing a decline), and is `fix` only after the read-only [runtime gate](../../stablecoin-runtime-price-marketcap-gate/SKILL.md) passes; otherwise `excluded-blocked` with the gate result.

## Due-Check Verdicts

| Verdict | Meaning | Sweep action |
| --- | --- | --- |
| `pass` | The clause is satisfied by evidence read this run. | Close when every clause passes. |
| `fail` | The check ran and the condition does not hold. | Comment the evidence, move `Due:`, report the needed fix. |
| `not-yet-observable` | The first relevant production execution or readout has not happened. | Move `Due:` to the date it becomes observable (or apply upstream-wait backoff below when unchanged on `ops:upstream-wait`). |
| `could-not-check` | A credential, tool or upstream was unavailable. | Comment what was missing by name; move `Due:` to the next session date (or apply upstream-wait backoff below when unchanged on `ops:upstream-wait`). |

## Upstream-Wait Backoff & 3-Strike Rule

Applies to `ops:upstream-wait` issues (and `excluded-blocked` external waits) whose upstream state is unchanged on re-check:

- **1st unchanged re-check:** move `Due:` to `+14d`.
- **2nd unchanged re-check:** move `Due:` to `+30d`.
- **3rd unchanged re-check (or >30 days idle):** escalate to `needs-decision` — codify the blocker as a documented limitation/disposition and close, or park on a quarterly (`+90d`) `ops:upstream-wait` re-check.

## Owner Decision Table

| D# | Issue(s) | Question | Options | Recommended default and why | Owner ruling (verbatim, date) | Effect on verdict and plan |
| --- | --- | --- | --- | --- | --- | --- |

- One decision per row, with concrete mutually exclusive options and the recommended default first.
- Put the evidence the owner needs inside the question; they may see only the question.
- Do not ask what code, docs or an earlier owner comment already settles, or what cannot be decided until data exists (that row is `excluded-dated`; prepare the evidence packet instead).
- Record the ruling verbatim. An override of the default is re-checked against the plan before the plan is written.
