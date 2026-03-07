---
title: "Audit worker/src/api/ and worker/src/lib/ for redundancy and LOC reduction opportunities"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "xhigh"
done: false
---

## Goal

Produce a comprehensive `RESEARCH-REPORT.md` cataloguing every code quality improvement opportunity in `worker/src/api/` (~11.5K LOC) and `worker/src/lib/` (~12.7K LOC) — focused on response builder duplication, shared utility consolidation, and LOC reduction without affecting features.

## Context

This is a read-only research task. You are NOT implementing changes — you are producing a detailed audit report.

The worker is a Cloudflare Worker with D1. API handlers are router-dispatched REST endpoints. `worker/src/lib/` contains DB helpers, constants, and shared utilities used by both API handlers and cron jobs.

**Keywords for this audit:** refine, enhance, reduce LOC — without affecting features.

## Task

### Part 1: worker/src/api/ Audit

1. **Duplicated response patterns**: Compare how API handlers build JSON responses, handle errors, validate query params, parse pagination, apply caching headers. Identify repeated boilerplate.

2. **Duplicated SQL query patterns**: Similar SELECT/JOIN patterns across handlers. Shared query builders that could be extracted.

3. **Handler consolidation**: API handlers that are structurally near-identical and could be parameterized.

4. **Dead endpoints**: Handlers defined but not registered in the router, or registered but serving no known frontend consumer.

5. **Large file review**:
   - `backfill-depegs.ts` (776 LOC)
   - `status.ts` (764 LOC)
   - `mint-burn-flows.ts` (681 LOC)
   Review whether they could be split.

### Part 2: worker/src/lib/ Audit

1. **Overlap with shared/lib/**: Check if any logic in `worker/src/lib/` duplicates or reimplements something in `shared/lib/`. These should use the shared version.

2. **Dead exports**: For each exported function/constant in `worker/src/lib/*.ts`, check if it's actually imported anywhere in `worker/src/`. Report any unused exports.

3. **Utility consolidation**: Multiple utility files doing related things that could be merged.

4. **Over-engineered helpers**: Functions more complex than needed for their use cases.

5. **Large file review**:
   - `mint-burn-contracts.ts` (753 LOC)
   - `status-reliability.ts` (665 LOC)
   Review whether they could be split.

### Part 3: Cross-Cutting (api ↔ lib)

1. **Underused helpers**: Helpers in `worker/src/lib/` that API handlers reimplement instead of using.
2. **Missing helpers**: Patterns repeated across multiple API handlers that should be in `worker/src/lib/`.

Also audit test files in `worker/src/lib/__tests__/` for redundant test patterns.

## Report Format

Produce `RESEARCH-REPORT.md` in the worktree root:

```markdown
# Worker API & Lib Audit Report

## Summary
- Files audited: N (api: N, lib: N, tests: N)
- Total LOC audited: N
- Estimated LOC reducible: N (X%)

## worker/src/api/ Findings

### Duplicated Response Patterns
- [Pattern]: found in [file1:line, file2:line, ...] — LOC impact: -N

### Duplicated SQL Patterns
- [Pattern]: ...

### Handler Consolidation Candidates
- [Finding]: ...

### Dead Endpoints
- [Finding]: ...

### Large File Assessments
- [file]: [justifiably large / should split] — reasoning

## worker/src/lib/ Findings

### Overlap with shared/lib/
- [Finding]: ...

### Dead Exports
- [Function/const]: `path:line` — never imported — LOC impact: -N

### Utility Consolidation
- [Finding]: ...

### Large File Assessments
- [file]: ...

## Cross-Cutting Patterns
### Underused Helpers
- [helper] in lib — reimplemented in [api handler1, handler2]

### Missing Helpers (extraction candidates)
- [pattern] repeated in [handler1, handler2] — should be in lib
```

## Acceptance Criteria

- `RESEARCH-REPORT.md` exists in the worktree root
- Report covers all files in `worker/src/api/` and `worker/src/lib/` including test files
- Every finding has exact file:line references
- Every finding has a LOC impact estimate
- Dead export analysis checked actual imports across the entire `worker/src/` tree
- No code changes were made (read-only audit)
