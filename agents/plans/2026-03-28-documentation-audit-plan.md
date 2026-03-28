# 2026-03-28 Documentation Audit Plan

## Scope

- `/docs/**`
- `/methodology` page and its supporting authored sections
- `/about` page
- `README.md`
- `AGENTS.md`
- `CLAUDE.md`

## Objective

Verify every in-scope documentation claim against the codebase, correct all confirmed inaccuracies, and repeat until a full pass yields no Medium-or-higher documentation issues.

## Constraints

- Code is the source of truth.
- Structural documentation changes stay in the main agent context.
- Existing unrelated worktree changes must remain untouched.
- Audit notes, plans, and reports for this pass belong under `/agents/`.

## Execution

1. Build the scoped inventory with file metadata, rough purpose, and obvious overlap/orphan notes.
2. Dispatch parallel per-document verification tasks to subagents with self-contained prompts.
3. Aggregate findings, reconcile cross-document contradictions, and classify severity.
4. Apply minimal documentation fixes only where discrepancies are confirmed.
5. Re-run the inventory and targeted verification loop until no Medium+ issues remain.
6. Run the repo validation commands relevant to documentation-touching frontend/worker surfaces and record any limits.

## Output

- Updated docs only where verification proves drift.
- Final audit report with loop-by-loop traceability.
