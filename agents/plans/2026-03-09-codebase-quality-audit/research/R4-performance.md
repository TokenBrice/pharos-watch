---
title: "Audit performance: bundle size, rendering efficiency, lazy loading, network, worker"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "xhigh"
done: false
---

## Goal

Produce a comprehensive `RESEARCH-REPORT.md` cataloguing every performance improvement opportunity detectable through code analysis — focused on bundle size, rendering efficiency, lazy loading, network patterns, and worker execution efficiency.

## Context

This is a **read-only research task**. You are NOT implementing changes — you are producing a detailed audit report.

Pharos is a statically exported Next.js 16 dashboard deployed to Cloudflare Pages. The API is a Cloudflare Worker with D1. Users are crypto practitioners who expect fast, responsive dashboards.

**Scope:**
- Frontend: `src/` (components, hooks, lib, app)
- Worker: `worker/src/` (cron jobs, API handlers, lib)
- Config: `next.config.ts`, `tsconfig.json`, `package.json`, `vitest.config.ts`

**Note:** This audit is code-analysis only. Actual bundle size measurement, runtime profiling, and Lighthouse scoring require separate tooling. Focus on identifying code-level patterns that are likely to hurt performance.

## Task

### 1. Bundle Size Analysis

Analyze imports and dependencies for bundle bloat:

- **Heavy dependencies:** Identify large libraries imported at the top level. Check `package.json` dependencies and trace their usage. Flag libraries >50KB (minified) that are only used on one page but imported globally.
- **Barrel file imports:** Imports from barrel files (`index.ts`) that pull in the entire module when only one export is needed. Check `shared/lib/`, `src/lib/`, `src/hooks/`.
- **Tree-shaking blockers:** Side-effect imports, default exports that prevent tree-shaking, `require()` calls.
- **Recharts bundle:** Recharts is large. Check if chart components import from `recharts` directly vs. specific submodules. Check if charts could be lazy-loaded.
- **Duplicate dependencies:** Check if multiple versions of the same dependency exist (e.g., multiple React copies, multiple date libraries).

### 2. Route-Level Code Splitting

- **Page-level splitting:** Check if Next.js pages use dynamic imports for heavy components. Pages with charts, large data tables, or complex visualizations should lazy-load those components.
- **Client component boundaries:** Check if `"use client"` boundaries are drawn tightly around interactive components, or if entire pages are client-rendered unnecessarily.
- **Shared layout weight:** What's in the root layout that every page loads? Flag heavy components in shared layouts.

### 3. Rendering Efficiency

Analyze React rendering patterns:

- **Missing memoization:** Components with expensive computations in render that should use `useMemo`. Callback functions recreated on every render that should use `useCallback`. Child components receiving new object/array references on every render.
- **Unnecessary re-renders:** Components that re-render when parent state changes but their own props haven't changed. Candidates for `React.memo`.
- **Expensive list rendering:** Large lists (>100 items) rendered without virtualization. Map operations creating new arrays on every render.
- **State granularity:** State stored too high in the tree, causing large subtree re-renders. Context providers wrapping too much.
- **TanStack Query patterns:** Hooks that transform data in `select` (good) vs. in the component body (causes re-renders).

### 4. Lazy Loading Opportunities

- **Below-the-fold content:** Components/sections below the initial viewport that load eagerly. Candidates for lazy loading or intersection observer.
- **Conditional content:** Components behind tabs, accordions, or toggles that render eagerly even when hidden.
- **Image lazy loading:** Images without `loading="lazy"` attribute.
- **Heavy components:** Chart components, data tables, or visualizations that could use `React.lazy` + Suspense.

### 5. Network Efficiency

- **Over-fetching:** API calls that request more data than the component uses. Hooks that fetch full datasets when only a summary is needed.
- **Waterfall patterns:** Sequential API calls where parallel calls would work. Components that wait for parent data before starting their own fetch.
- **Redundant API calls:** Multiple components on the same page calling the same API endpoint. Check if TanStack Query deduplication covers this.
- **Missing prefetching:** Navigation patterns where the next page's data could be prefetched on hover/focus.
- **Payload size:** API responses with fields never consumed by any frontend component.

### 6. CSS Efficiency

- **Unused Tailwind classes:** Custom theme extensions in CSS config (`src/app/globals.css` — Tailwind v4 uses CSS-based configuration, NOT `tailwind.config.ts`) that are never used in templates.
- **Dynamic class construction:** Tailwind classes built dynamically (string concatenation, template literals) — these won't be purged and won't work.
- **Overly long class strings:** Components with 10+ Tailwind classes that could use `@apply` in a CSS module or be split into sub-components.

### 7. Configuration Files

Audit project configuration for optimization opportunities and misconfigurations:

- **`next.config.ts`:** Missing `optimizePackageImports`, deprecated experimental flags, unnecessary config entries.
- **`tsconfig.json` and `worker/tsconfig.json`:** Target/lib alignment between root and worker, unused path aliases, strictness settings.
- **`vitest.config.ts`:** Coverage thresholds (are they appropriate?), exclude patterns, path alias correctness.

### 8. Static Asset Optimization

- **Image format:** Check `public/` for oversized logo images, inconsistent formats (PNG/JPG where WebP would be smaller), orphaned logos for removed stablecoins.
- **Font loading:** Check how Geist Sans and Geist Mono are loaded — preload, subsetting, font-display strategy.

### 9. Worker Execution Efficiency

- **Cron job duration:** Cron jobs that do unnecessary work (re-processing data that hasn't changed, scanning all records when incremental would suffice).
- **D1 query efficiency:** Missing indexes (N+1 query patterns), SELECT * when only specific columns are needed, large result sets loaded into memory.
- **Connection utilization:** Cron jobs that could better pipeline their 6-connection budget. Response bodies not consumed promptly (blocking connection reuse).
- **Unnecessary data processing:** Cron jobs that fetch, parse, and transform data identically to the previous run, then no-op the DB write. Check for "skip if unchanged" guards.

## Report Format

Produce `RESEARCH-REPORT.md` in the worktree root:

```markdown
# R4: Performance Audit Report

## Summary
- Files audited: N
- Findings by severity: N critical, N important, N minor
- Findings by category: N bundle, N splitting, N rendering, N lazy-load, N network, N CSS, N config, N assets, N worker
- Estimated impact: [qualitative — high/medium/low improvement potential per category]

## Critical Findings (significant performance impact)

### Finding C1: [Short description]
- **Category:** [Bundle | Code Splitting | Rendering | Lazy Loading | Network | CSS | Config | Assets | Worker]
- **Files:** `path:line` — `path:line`
- **Description:** [What the issue is and its performance impact]
- **Suggested fix:** [Concrete description]
- **Impact:** [High | Medium | Low] — [qualitative description of expected improvement]
- **Effort:** [Low | Medium | High]
- **Risk:** [Low | Medium | High]

## Important Findings (moderate performance impact)
### Finding I1: ...

## Minor Findings (small optimizations)
### Finding M1: ...

## Bundle Dependency Analysis
| Dependency | Approx Size | Used By | Pages | Lazy-Loadable? |
|-----------|-------------|---------|-------|----------------|
| recharts | ~200KB | chart components | 8+ pages | Yes — per route |
| ... | ... | ... | ... | ... |

## Rendering Hot Spots
Components likely causing excessive re-renders:
- [component]: [reason] — [suggested fix]

## Worker Cron Efficiency
| Cron Job | Issue | Suggested Optimization |
|----------|-------|----------------------|
| [job] | [issue] | [fix] |
```

## Acceptance Criteria

- `RESEARCH-REPORT.md` exists in the worktree root
- Report covers frontend (`src/`), worker (`worker/src/`), and configuration files
- Every finding has exact `file:line` references
- Every finding has an impact level, effort estimate (Low/Medium/High), and risk level
- Bundle dependency analysis covers all production dependencies
- No code changes were made (read-only audit)
