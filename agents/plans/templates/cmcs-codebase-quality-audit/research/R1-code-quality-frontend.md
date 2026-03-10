---
title: "Audit frontend code for dead code, duplication, and consolidation opportunities"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "xhigh"
done: false
---

## Goal

Produce a comprehensive `RESEARCH-REPORT.md` cataloguing every code quality improvement opportunity in the frontend codebase (`src/`) — focused on dead code removal, duplication elimination, pattern consolidation, and LOC reduction without affecting features.

## Context

This is a **read-only research task**. You are NOT implementing changes — you are producing a detailed audit report. The report feeds into an implementation plan executed by other agents.

The codebase is a Next.js 16 dashboard using React 19, TypeScript strict, Tailwind CSS v4, shadcn/ui, TanStack Query, and Recharts.

**Scope:**
- `src/components/` — UI components (~160 files). **Exclude `src/components/ui/`** (shadcn primitives, auto-generated).
- `src/lib/` — Frontend-only utilities (API client, chart helpers, formatting, constants).
- `src/hooks/` — TanStack Query hooks and shared state hooks.
- `src/app/` — Page components (only audit for inline logic that should be extracted).

**Cross-reference:** `shared/lib/` contains runtime-neutral shared modules. Check for overlap where `src/lib/` reimplements logic already in `shared/lib/`.

## Task

### 1. Dead / Unused Code

- Exported functions, components, types, or constants that are never imported anywhere in `src/`. **Verify with import analysis across the entire `src/` tree.**
- Commented-out code blocks (>3 lines).
- Unused imports.
- Props defined in component interfaces but never passed by any consumer.
- Conditional branches that can never trigger (dead logic paths).
- Entire files that are unused (no imports from anywhere).

### 2. Duplicated Patterns

- Identical or near-identical code blocks across components (copy-paste duplication). Threshold: 5+ lines of structural similarity.
- Repeated inline logic that could be a shared utility or hook.
- Similar component structures that could be parameterized into a single component.
- Duplicated Tailwind class strings (same long `className` appearing in 3+ places).
- Repeated conditional rendering patterns (same loading/error/empty guard in many components).

### 3. Extraction Candidates

- Components exceeding 300 LOC that could be split into smaller, focused components.
- Inline logic in components (>10 lines of data transformation, formatting, or computation) that should be extracted to hooks or utilities.
- Repeated UI patterns across 3+ components that could become a reusable component.
- Chart configurations or data transformations repeated across chart components.
- Complex render functions that could be split into sub-components.

### 4. Cross-Module Overlap

- Functions in `src/lib/` that duplicate or reimplement logic already in `shared/lib/`. These should use the shared version.
- Constants defined in multiple places (same value, different variable names).
- Hooks that are thin wrappers around `use-api-query.ts` with near-identical patterns — could they be simplified or generated?
- Formatting/display logic duplicated between `src/lib/` and component files.

### 5. Simplification Opportunities

- Overly complex conditional logic that could be simplified (nested ternaries, long if/else chains).
- Verbose patterns where terser equivalents exist.
- Unnecessary wrapper components or HOCs.
- Over-abstracted code where inline would be clearer and shorter.
- Redundant type assertions or casts that TypeScript could infer.

### 6. Hook Audit

- Dead hooks: hooks defined but never used in any component.
- Hook consolidation: hooks always used together that could be combined.
- Duplicated fetch/transform patterns across hooks.
- Stale time / refetch interval consistency: check if hooks follow `staleTime = cron interval`, `refetchInterval = 2x cron interval`.

### 7. Test File Audit

- Test files in `src/**/__tests__/`: redundant test cases, dead test helpers, tests testing implementation details instead of behavior.

## Report Format

Produce `RESEARCH-REPORT.md` in the worktree root:

```markdown
# R1: Frontend Code Quality Audit Report

## Summary
- Total files audited: N
- Total LOC audited: N
- Estimated LOC reducible: N (X%)
- Findings by severity: N critical, N important, N minor
- Findings by category: N dead code, N duplication, N extraction, N overlap, N simplification

## Critical Findings (significant LOC savings or high maintenance burden)

### Finding C1: [Short description]
- **Category:** [Dead Code | Duplication | Extraction | Overlap | Simplification]
- **Files:** `path:line` — `path:line`
- **Description:** [What the issue is, with specifics]
- **Suggested fix:** [Concrete description of the change]
- **LOC impact:** -N lines
- **Effort:** [Low | Medium | High]
- **Risk:** [None — pure deletion | Low — behavior-preserving refactor | Medium — needs testing]

## Important Findings (moderate LOC savings or noticeable quality improvement)

### Finding I1: ...

## Minor Findings (<10 LOC savings each)

### Finding M1: ...

## Cross-Component Patterns
Patterns that span multiple components and suggest a shared abstraction:
- [Pattern name]: found in [file1, file2, file3] — [description] — LOC impact: -N

## Hook Consistency Audit
- [Hook]: staleTime=X, refetchInterval=Y — [correct | should be X/Y]

## Largest Files Review
For each file >400 LOC, a brief assessment:
- [file] (N LOC): [justifiably large | should split] — [reasoning]
```

## Acceptance Criteria

- `RESEARCH-REPORT.md` exists in the worktree root
- Report covers all files in `src/components/` (except `ui/`), `src/lib/`, `src/hooks/`, and page files in `src/app/`
- Every finding has exact `file:line` references
- Every finding has a LOC impact estimate
- Every finding has an effort estimate (Low/Medium/High) and risk level
- Dead export analysis verified actual imports across the entire `src/` tree
- Summary section has aggregate stats
- No code changes were made (read-only audit)
