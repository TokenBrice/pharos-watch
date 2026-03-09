---
title: "Audit src/lib/ and src/hooks/ for redundancy, overlap, and LOC reduction opportunities"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "xhigh"
done: false
---

## Goal

Produce a comprehensive `RESEARCH-REPORT.md` cataloguing every code quality improvement opportunity in `src/lib/` (~6.3K LOC) and `src/hooks/` (~3K LOC) — focused on utility overlap, dead helpers, hook consolidation, and LOC reduction without affecting features.

## Context

This is a read-only research task. You are NOT implementing changes — you are producing a detailed audit report.

The codebase is a Next.js 16 dashboard using React 19, TypeScript strict, Tailwind CSS v4, TanStack Query.

- `src/lib/` contains frontend-only utilities: API client, chart helpers, formatting, URL helpers, constants, metadata.
- `src/hooks/` contains TanStack Query hooks and shared state hooks.
- `shared/lib/` contains runtime-neutral shared modules (stablecoin metadata, supply/classification/peg/report-card logic) — audit for overlap with `src/lib/`.

**Keywords for this audit:** refine, enhance, reduce LOC — without affecting features.

## Task

### Part 1: src/lib/ Audit

1. **Utility overlap with shared/lib/**: Check if any logic in `src/lib/` duplicates or reimplements something already in `shared/lib/`. These should use the shared version.

2. **Dead exports**: For each exported function/constant in `src/lib/*.ts`, check if it's actually imported anywhere in `src/`. Report any unused exports.

3. **Overlapping utilities**: Check for functions that do similar things across different files (e.g., multiple formatting helpers, multiple color utilities, multiple URL builders).

4. **Constants consolidation**: Check `src/lib/constants.ts`, `src/lib/dex-constants.ts`, `src/lib/cron-intervals.ts` and similar files for duplication or overlap.

5. **Over-engineered helpers**: Functions that are more complex than needed for their single use case.

### Part 2: src/hooks/ Audit

1. **Hook consolidation**: Hooks that are thin wrappers around `use-api-query.ts` with identical patterns — could they be generated or simplified?

2. **Duplicated fetch/transform patterns**: Similar data transformation logic across hooks.

3. **Dead hooks**: Hooks that are defined but never used in any component.

4. **Hook composition opportunities**: Cases where multiple hooks are always used together and could be combined.

5. **Stale time / refetch interval consistency**: Check if hooks follow the convention (`staleTime = cron interval`, `refetchInterval = 2× cron interval`) consistently.

### Part 3: Test Files

1. **Test files in `src/lib/__tests__/` and `src/hooks/__tests__/`**: Check for redundant test cases, dead test helpers, tests that test implementation details instead of behavior.

## Report Format

Produce `RESEARCH-REPORT.md` in the worktree root with this structure:

```markdown
# Frontend Lib & Hooks Audit Report

## Summary
- Files audited: N (lib: N, hooks: N, tests: N)
- Total LOC audited: N
- Estimated LOC reducible: N (X%)
- Findings: N overlap, N dead code, N consolidation, N simplification

## src/lib/ Findings

### Overlap with shared/lib/
- [Finding]: `src/lib/file.ts:line` duplicates `shared/lib/file.ts:line` — LOC impact: -N

### Dead Exports
- [Function/const]: `src/lib/file.ts:line` — never imported — LOC impact: -N

### Overlapping Utilities
- [Finding]: ...

### Constants Consolidation
- [Finding]: ...

## src/hooks/ Findings

### Hook Consolidation Candidates
- [Finding]: ...

### Duplicated Patterns
- [Finding]: ...

### Dead Hooks
- [Finding]: ...

### Timing Consistency
- [Finding]: ...

## Test File Findings
- [Finding]: ...

## Cross-Cutting Patterns
Patterns that span lib and hooks suggesting shared abstractions.
```

## Acceptance Criteria

- `RESEARCH-REPORT.md` exists in the worktree root
- Report covers all files in `src/lib/` (excluding `__tests__/`), `src/hooks/` (excluding `__tests__/`), and test directories
- Every finding has exact file:line references
- Every finding has a LOC impact estimate
- Dead export analysis checked actual imports across the entire `src/` tree
- No code changes were made (read-only audit)
