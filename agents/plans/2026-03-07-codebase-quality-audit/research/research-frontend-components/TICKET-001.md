---
title: "Audit src/components/ for redundancy, duplication, and LOC reduction opportunities"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "xhigh"
done: false
---

## Goal

Produce a comprehensive `RESEARCH-REPORT.md` cataloguing every code quality improvement opportunity in `src/components/` (~24K LOC, ~160 files) — focused on redundancy elimination, pattern consolidation, and LOC reduction without affecting features.

## Context

This is a read-only research task. You are NOT implementing changes — you are producing a detailed audit report. The report will feed into an implementation plan executed by other agents.

The codebase is a Next.js 16 dashboard using React 19, TypeScript strict, Tailwind CSS v4, shadcn/ui, TanStack Query, and Recharts. Files in `src/components/ui/` are shadcn primitives and should NOT be audited (they are auto-generated).

**Keywords for this audit:** refine, enhance, reduce LOC — without affecting features.

## Task

Audit every file in `src/components/` (excluding `src/components/ui/`) for the following categories. For each finding, provide exact file paths, line numbers, and concrete descriptions.

### 1. Duplicated Patterns
- Identical or near-identical code blocks across components (copy-paste duplication)
- Repeated inline logic that could be a shared utility or hook
- Similar component structures that could be parameterized into one
- Duplicated Tailwind class strings or style patterns
- Repeated conditional rendering patterns

### 2. Extraction Candidates
- Components that are too large and could be split (>300 LOC single components)
- Inline logic that should be extracted to hooks or utilities
- Repeated UI patterns that could become reusable components
- Chart configurations or data transformations repeated across chart components

### 3. Dead / Unused Code
- Exported functions or components that are never imported anywhere
- Commented-out code blocks
- Unused imports
- Props that are defined but never passed
- Conditional branches that can never trigger

### 4. Simplification Opportunities
- Overly complex conditional logic that could be simplified
- Verbose patterns where terser equivalents exist
- Unnecessary wrapper components or HOCs
- Over-abstracted code where inline would be clearer
- Redundant type assertions or casts

### 5. LOC Reduction Estimates
For each finding, estimate the LOC that could be saved by the improvement.

## Report Format

Produce `RESEARCH-REPORT.md` in the worktree root with this structure:

```markdown
# Frontend Components Audit Report

## Summary
- Total files audited: N
- Total LOC audited: N
- Estimated LOC reducible: N (X%)
- Findings by category: N duplications, N extractions, N dead code, N simplifications

## Critical Findings (>50 LOC savings each)

### Finding C1: [Short description]
- **Category:** [Duplication | Extraction | Dead Code | Simplification]
- **Files:** `path:line` — `path:line`
- **Description:** [What the issue is and why it matters]
- **Suggested fix:** [Concrete description of the change]
- **LOC impact:** -N lines

### Finding C2: ...

## Important Findings (10–50 LOC savings each)

### Finding I1: ...

## Minor Findings (<10 LOC savings each)

### Finding M1: ...

## Cross-Component Patterns
Patterns that span multiple components and suggest a shared abstraction:
- [Pattern name]: found in [file1, file2, file3] — [description]

## Largest Files Review
For each file >400 LOC, a brief assessment of whether it's justifiably large or should be split.
```

## Acceptance Criteria

- `RESEARCH-REPORT.md` exists in the worktree root
- Report covers all files in `src/components/` except `src/components/ui/`
- Every finding has exact file:line references
- Every finding has a LOC impact estimate
- Summary section has aggregate stats
- No code changes were made (read-only audit)
