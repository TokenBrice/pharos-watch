---
title: "Audit shared/lib/ for type bloat, dead exports, and LOC reduction opportunities"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "xhigh"
done: false
---

## Goal

Produce a comprehensive `RESEARCH-REPORT.md` cataloguing every code quality improvement opportunity in `shared/lib/` and `shared/types/` (~11K LOC, 34 files) — focused on type bloat, dead exports, consolidation, and LOC reduction without affecting features.

## Context

This is a read-only research task. You are NOT implementing changes — you are producing a detailed audit report.

`shared/lib/` contains runtime-neutral modules shared between the Next.js frontend (`src/`) and the Cloudflare Worker (`worker/src/`). It's imported via the `@shared/*` alias. Changes here have the widest blast radius since both consumers depend on it.

Key files:
- `shared/lib/stablecoins.ts` (3,968 LOC) — stablecoin metadata registry
- `shared/types/index.ts` (1,401 LOC) — TypeScript type definitions
- `shared/lib/dead-stablecoins.ts` (1,150 LOC) — cemetery data
- `shared/lib/report-cards.ts` (795 LOC) — report card scoring logic

**Keywords for this audit:** refine, enhance, reduce LOC — without affecting features.

## Task

### 1. Type Audit (shared/types/index.ts — 1,401 LOC)
- **Dead types**: Types exported but never used in `src/` or `worker/src/`. Check actual imports.
- **Redundant types**: Types that are structurally identical or near-identical and could be unified.
- **Over-specified types**: Types with many optional fields where a simpler type + intersection would be cleaner.
- **Type vs interface consistency**: Inconsistent use of `type` vs `interface` for the same kind of definition.

### 2. Dead Exports Across shared/lib/
For each exported function, constant, or type in every `shared/lib/*.ts` file:
- Check if it's actually imported in `src/` or `worker/src/`
- Report any unused exports with LOC impact

### 3. Data File Optimization
- `shared/lib/stablecoins.ts` (3,968 LOC): Is the structure efficient? Are there fields that are never read? Could derived fields be computed instead of stored?
- `shared/lib/dead-stablecoins.ts` (1,150 LOC): Same analysis. Any entries that could be compressed or structured differently?

### 4. Logic Consolidation
- Functions across different files that do related things and could be in one module
- Helper functions that are more complex than their usage warrants
- Repeated patterns across scoring modules (report-cards, classification, peg logic)

### 5. Cross-Boundary Analysis
- Functions in `shared/lib/` only used by one consumer (frontend OR worker, not both). These could potentially move to the consumer, simplifying the shared boundary.
- Functions in `src/lib/` or `worker/src/lib/` that should be in `shared/lib/` because they're reimplemented in both.

### 6. Test Files
Audit `shared/lib/__tests__/` for redundant tests, dead helpers, and tests testing implementation details.

## Report Format

Produce `RESEARCH-REPORT.md` in the worktree root:

```markdown
# Shared Lib Audit Report

## Summary
- Files audited: N
- Total LOC audited: N
- Estimated LOC reducible: N (X%)

## Type Audit (shared/types/index.ts)
### Dead Types
- [Type]: line N — never imported — LOC impact: -N

### Redundant Types
- [Type1] ≈ [Type2]: could unify — LOC impact: -N

### Over-Specified Types
- [Type]: ...

## Dead Exports
- [export] in `shared/lib/file.ts:line` — never imported — LOC impact: -N

## Data File Optimization
### stablecoins.ts
- [Finding]: ...

### dead-stablecoins.ts
- [Finding]: ...

## Logic Consolidation
- [Finding]: ...

## Cross-Boundary Analysis
### shared/ exports used by only one consumer
- [export] in `shared/lib/file.ts` — only used by [src | worker] — candidate for move

### Duplicated logic across src/ and worker/
- [pattern]: `src/lib/file.ts:line` ≈ `worker/src/lib/file.ts:line` — candidate for shared/

## Test Findings
- [Finding]: ...
```

## Acceptance Criteria

- `RESEARCH-REPORT.md` exists in the worktree root
- Report covers all files in `shared/lib/`, `shared/types/`, and `shared/lib/__tests__/`
- Dead export analysis checked actual imports across BOTH `src/` and `worker/src/`
- Cross-boundary analysis identifies single-consumer exports
- Every finding has exact file:line references
- Every finding has a LOC impact estimate
- No code changes were made (read-only audit)
