# Plan Template

Write `agents/<YYYY-MM-DD>-issue-resolution/PLAN.md` in the main checkout. The executor has no memory of the planning session: the plan must stand alone, with the triage table and evidence files beside it.

```markdown
# Issue resolution plan — <YYYY-MM-DD>

- Status: awaiting owner verification (nothing executed)
- origin/main at planning: <sha> · open issues: <n> · open PRs: <list>
- Retention: keep until every row is closed or moved to an issue; delete after owner confirmation

## 1. Scope rollup
| Verdict | Count | Issues |
(every open issue exactly once; counts sum to the inventory)
- Expected net issue delta: closed (<n>) − newly filed (<n>) = <delta>
- Consolidation / pruning: <tracker duplicates, split-date merges, and retired low-value rows>

## 2. Owner decisions
(the decision table, rulings verbatim; unanswered rows marked)

## 3. Resolvable issues
### #<n> <title> — <verdict>
- Done when: <clause> → met / covered by <lane> / spun off (D#)
- Root-cause hypothesis: <what the evidence shows, not the issue's guess>
- Evidence read: <files at sha, commands, live reads with UTC time>
- Unverified: <assumptions the executor must confirm first>
- Change sketch: <files, owning skill, methodology or generated-artifact impact>
- Checks: <focused checks, owning suites>
- Closure criteria: <evidence that proves each clause after the change is live>
- Acceptance: <first production execution to observe, and when>

## 4. Excluded issues
| # | Verdict | Reason | Next gate or date | `Due:` move needed |

## 5. Lanes, batches and order
| Wave | Lane | Issues | Write scope | Depends on | Release PR batch |
- Ordering constraints: <shared generated artifacts, methodology versions, budget, expiries>
- Design-first lanes: <design memo → review → owner approval → build>

## 6. Review
Every write lane gets an independent diff review before integration. Cap: 3 rounds per lane, then re-scope or escalate to the owner.

## 7. Deploy windows
| Release PR | Surfaces | Window constraint | First execution to observe |

## 8. Executor prerequisites
<installed dependencies, tool logins by name, owner-only steps, files to leave untouched>

## 9. Worker common brief
<the brief from references/worker-common-brief.md, with the evidence path filled in>

## 10. Ledger
| Lane | Issues | Worktree / branch | Status | Review rounds | PR | Merge SHA | Deploy run | Acceptance | Notes |

## 11. Closure rules
<the closure audit from references/closure-and-batching.md; proposed new issues (default none — each must pass the filing bar and name why no existing open issue or standing tracker can hold it)>
```

## Filling Rules

- Section 3 holds only `close-now`, `close-redundant`, `fix`, `partial-advance` and `design-first` rows; a `partial-advance` row names the clauses that stay open and their gate.
- Every hypothesis cites the evidence that supports it. A hypothesis with no supporting read goes under `Unverified`, not under `Root-cause hypothesis`.
- A lane's write scope is a file or directory list. Two lanes that write the same file are one lane or strictly ordered.
- Section 7 follows [Operational Acceptance](../../../../docs/deployment-process.md#operational-acceptance); copy the constraint that applies to each release and name the production execution that proves it.
- The ledger starts with one row per lane at status `planned`. Statuses: `planned`, `running`, `in-review`, `held`, `superseded`, `dropped`, `merged`, `accepted`; a held, superseded or dropped row states why.
- Leave no placeholder: a field with nothing to say is `none`.
