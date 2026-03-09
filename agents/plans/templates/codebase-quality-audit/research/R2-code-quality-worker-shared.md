---
title: "Audit worker and shared code for dead code, duplication, and consolidation opportunities"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "xhigh"
done: false
---

## Goal

Produce a comprehensive `RESEARCH-REPORT.md` cataloguing every code quality improvement opportunity in the worker (`worker/src/`) and shared (`shared/`) codebases — focused on dead code removal, duplication elimination, helper consolidation, type cleanup, and LOC reduction without affecting features.

## Context

This is a **read-only research task**. You are NOT implementing changes — you are producing a detailed audit report.

The worker is a Cloudflare Worker using D1 (SQLite). Cron jobs sync data from external APIs into D1 tables. API handlers are router-dispatched REST endpoints. `shared/lib/` contains runtime-neutral modules shared between frontend and worker via the `@shared/*` alias.

**Scope:**
- `worker/src/cron/` — Data sync cron jobs (~60 files)
- `worker/src/api/` — REST API handlers
- `worker/src/lib/` — DB helpers, constants, shared utilities
- `shared/lib/` — Runtime-neutral shared modules
- `shared/types/` — TypeScript type definitions (currently a single `index.ts` file; the type audit focuses on exports within that file)

**Key constraints** (do NOT suggest violating these):
- Workers have a 6-connection limit per cron trigger, shared across all `ctx.waitUntil()` jobs
- D1 does NOT support explicit transactions — `db.batch()` provides atomicity
- D1 per-statement limit is 30 seconds execution time
- Response bodies must be consumed before starting new fetch batches

## Task

### 1. Dead / Unused Code

- Exported functions, constants, types that are never imported. **For shared/, check imports across BOTH `src/` and `worker/src/`.**
- Commented-out code blocks (>3 lines).
- Unused function parameters.
- Unused imports.
- Stale TODO comments referencing completed work.
- Code paths that can never execute.
- Entire files that are unused.

### 2. Duplicated Fetch Patterns (worker/src/cron/)

- Compare how each cron file fetches external APIs. Look for repeated patterns: retry logic, error handling, response parsing, rate limiting, batch chunking.
- Identify which patterns could be consolidated into shared helpers in `worker/src/lib/`.
- Check if existing helpers (e.g., `fetchWithRetry`) are underused — cron jobs reimplementing what helpers already provide.

### 3. Duplicated DB Patterns (worker/src/cron/ and worker/src/api/)

- Repeated INSERT/UPSERT patterns, batch statement construction, error handling.
- Similar SELECT/JOIN patterns across API handlers that could use shared query builders.
- Cache read/write patterns reimplemented instead of using `getCache`/`setCache` helpers.

### 4. API Handler Consolidation

- Duplicated response patterns: JSON response building, error handling, query param validation, pagination parsing, caching headers.
- Handlers that are structurally near-identical and could be parameterized.
- Dead endpoints: handlers defined but not registered in the router, or serving no known frontend consumer.

### 5. Type Audit (shared/types/)

- Dead types: exported but never used in `src/` or `worker/src/`.
- Redundant types: structurally identical or near-identical types that could be unified.
- Over-specified types: many optional fields where a simpler type + intersection would be cleaner.
- Type vs interface consistency.
- Methodology type aliases that are just `= MethodologyEnvelopeSchema` with a different name.

### 6. Cross-Boundary Analysis

- `shared/` exports used by only one consumer (frontend OR worker, not both). Candidates for moving to the consumer to simplify the shared boundary.
- Logic duplicated across `src/lib/` and `worker/src/lib/` that should be in `shared/lib/`.
- `worker/src/lib/` functions that overlap with `shared/lib/`.

### 7. Data File Optimization

- `shared/lib/stablecoins.ts`: fields that are never read, derived fields that could be computed instead of stored, default values that could be handled by the `coin()` helper.
- `shared/lib/dead-stablecoins.ts`: structural optimization opportunities.

### 8. Large File Review

For each file >500 LOC, assess whether it's justifiably large or should be split:
- All cron files >500 LOC
- All API handler files >500 LOC
- All lib files >500 LOC
- `shared/types/index.ts`

### 9. Worker Configuration

- **`worker/wrangler.toml`:** Check `compatibility_date` freshness, cron schedule accuracy vs actual job mapping, CPU limits, observability config.
- **Cron schedule accuracy:** Cross-reference cron schedules in `worker/wrangler.toml` against `docs/worker-infrastructure.md`. Flag mismatches.
- **Request pipeline:** Audit `worker/src/handlers/http.ts` — middleware ordering, init function call overhead per request, error response consistency, edge cache bypass logic.

### 10. Test File Audit

- Test files in `worker/src/**/__tests__/` and `shared/lib/__tests__/`: redundant test cases, dead helpers, tests testing implementation details.

## Report Format

Produce `RESEARCH-REPORT.md` in the worktree root:

```markdown
# R2: Worker & Shared Code Quality Audit Report

## Summary
- Files audited: N (cron: N, api: N, lib: N, shared: N, types: N, tests: N)
- Total LOC audited: N
- Estimated LOC reducible: N (X%)
- Findings by severity: N critical, N important, N minor
- Findings by category: N dead code, N fetch-duplication, N DB-duplication, N API-consolidation, N type-bloat, N cross-boundary, N simplification

## Critical Findings (significant LOC savings or high maintenance burden)

### Finding C1: [Short description]
- **Category:** [Dead Code | Fetch Duplication | DB Duplication | API Consolidation | Type Bloat | Cross-Boundary | Simplification]
- **Files:** `path:line` — `path:line`
- **Description:** [What the issue is, with specifics]
- **Suggested fix:** [Concrete description of the change]
- **LOC impact:** -N lines
- **Effort:** [Low | Medium | High]
- **Risk:** [None | Low | Medium]

## Important Findings (moderate LOC savings or noticeable quality improvement)
### Finding I1: ...

## Minor Findings (<10 LOC savings each)
### Finding M1: ...

## Duplicated Fetch Patterns
- [Pattern name]: found in [file1, file2, ...] — description — suggested shared helper — LOC impact: -N

## Duplicated DB Patterns
- [Pattern name]: found in [file1, file2, ...] — description — suggested shared helper — LOC impact: -N

## Type Audit Summary
- Dead types: N (LOC: -N)
- Redundant types: N (LOC: -N)
- Alias-only types: N (LOC: -N)

## Cross-Boundary Analysis
### Shared exports used by only one consumer
- [export] in `shared/lib/file.ts` — only used by [src | worker] — candidate for move

### Duplicated logic across src/ and worker/
- [pattern]: `src/lib/file.ts:line` ~ `worker/src/lib/file.ts:line` — candidate for shared/

## Underused Existing Helpers
- [helper in worker/src/lib/] — reimplemented in [cron/api file1, file2]

## Large File Assessments
- [file] (N LOC): [justifiably large | should split] — [reasoning]
```

## Acceptance Criteria

- `RESEARCH-REPORT.md` exists in the worktree root
- Report covers all files in `worker/src/` and `shared/` including test directories
- Every finding has exact `file:line` references
- Every finding has a LOC impact estimate, effort estimate (Low/Medium/High), and risk level
- Dead export analysis checked imports across BOTH `src/` and `worker/src/`
- Cross-boundary analysis identifies single-consumer exports
- Summary section has aggregate stats
- No code changes were made (read-only audit)
