---
title: "Fix frontend error-state handling and accessibility gaps"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "high"
done: false
---

## Goal

Fix 14 frontend findings: 8 components that mask fetch errors as empty states, 3 overflow/layout issues, and 3 accessibility gaps (aria-pressed, table captions, th scope).

## Context

The codebase has a `QueryErrorNotice` component at `src/components/query-error-notice.tsx` that accepts `{ error, hasData?, onRetry? }`. Only 1 of 9 affected components uses it. The pattern to apply everywhere: destructure `error` and `refetch` from the TanStack Query hook, render `<QueryErrorNotice>` before the `!data` early return.

## Task

### Step 1: UX-001 — Dependency map error state

In `src/app/dependency-map/client.tsx`:
1. Import `QueryErrorNotice` from `@/components/query-error-notice`
2. Destructure `error` and `refetch` from the hooks (`useReportCards`, `useStablecoins`)
3. After loading check, before the `!reportData?.cards` empty-state return, add:
```tsx
{error && <QueryErrorNotice error={error} onRetry={() => void refetch()} />}
```
4. Only render the empty state when `!error && !data`.

### Step 2: UX-002 — Digest archive error state

In `src/components/digest-archive-client.tsx`:
This file already uses `QueryErrorNotice` correctly (line ~95). **Verify** it checks `error` before `!data`. If the `!data || empty` return at line 85 comes before the error check, reorder so error is checked first. The current code has the error notice after the early return — move it before.

### Step 3: UX-003 — Depeg history error state

In `src/components/depeg-history.tsx`:
1. Import `QueryErrorNotice`
2. Destructure `error, refetch` from `useDepegEvents()`
3. After `isLoading` skeleton, before empty-state check, add error notice
4. Change the empty-state condition from `if (!events || empty)` to `if (!error && (!events || empty))`

### Step 4: UX-004 — KPI bar error state

In `src/components/kpi-bar.tsx`:
1. Import `QueryErrorNotice`
2. Destructure `error` from at least the primary hook (`useStablecoins` or `useStabilityIndex`)
3. This is tricky because KPI bar uses 5 hooks. Add a combined error check:
```tsx
const primaryError = stablecoinsQuery.error || psiQuery.error;
```
4. If any primary query errors, show a subtle inline error indicator instead of fabricated zeros. Could render the KPI bar with a warning banner or dim the affected metrics.

### Step 5: UX-005 — Daily digest error state

In `src/components/daily-digest.tsx`:
1. Import `QueryErrorNotice`
2. Destructure `error, refetch` from `useDailyDigest()`
3. Replace the `if (!isLoading && !data) return null` with:
```tsx
if (!isLoading && !data) {
  if (error) return <QueryErrorNotice error={error} onRetry={() => void refetch()} />;
  return null;
}
```

### Step 6: UX-006 — Safety score history error state

In `src/components/stablecoin-detail/safety-score-history-section.tsx`:
1. Import `QueryErrorNotice`
2. The code already destructures `error` (line ~28) but returns `null` on error (line ~34-36)
3. Replace `if (error) return null` with:
```tsx
if (error) return <QueryErrorNotice error={error} />;
```

### Step 7: UX-007 — DEWS detail error state

In `src/components/dews-detail.tsx`:
1. Import `QueryErrorNotice`
2. Destructure `error, refetch` from `useStressSignalDetail()`
3. Before the `!data?.current` empty message, check error first

### Step 8: UX-008 — Status dashboard blank page

In `src/app/status/client.tsx`:
The status page already has custom error handling (line ~104-113). The issue is `if (!data) return null` at line ~115 which creates a blank page.
1. Replace `if (!data) return null` with an error/loading fallback:
```tsx
if (!data) return <div className="p-8 text-center text-muted-foreground">Loading status data...</div>;
```

### Step 9: UX-009 — Status tables overflow

In these 3 files, wrap the `<table>` element with `<div className="overflow-x-auto">`:
- `src/components/status/cache-freshness-table.tsx` (line ~21)
- `src/components/status/circuit-breaker-table.tsx` (line ~29)
- `src/components/status/transition-timeline.tsx` (line ~28)

### Step 10: UX-010 — Compare table overflow

In `src/components/comparison-table.tsx` (line ~210), wrap the desktop table with `<div className="overflow-x-auto">`.

### Step 11: UX-011 — DEWS summary error/empty fallback

In `src/components/dews-summary.tsx`:
1. Import `QueryErrorNotice`
2. Destructure `error` from `useStressSignals()`
3. After loading skeleton, before the `!data?.signals || empty` → null return, add error check

### Step 12: A11Y-003 — Toggle buttons `aria-pressed`

In `src/app/safety-scores/client.tsx` (line ~302) and `src/components/feedback-modal.tsx` (line ~138):
Add `aria-pressed={isSelected}` to toggle/segmented control buttons. For example:
```tsx
<button
  aria-pressed={selectedView === "grid"}
  onClick={() => setSelectedView("grid")}
  ...
>
```

### Step 13: A11Y-004 — Table captions

In these files, add a `<caption>` element as the first child of `<table>`:
- `src/components/stablecoin-table.tsx` (line ~197): `<caption className="sr-only">Stablecoin data table</caption>`
- `src/components/status/transition-timeline.tsx` (line ~28): `<caption className="sr-only">Status transition history</caption>`
- `src/components/stress-test-panel.tsx` (line ~173): `<caption className="sr-only">Stress test results</caption>`

Use `sr-only` class so the caption is accessible but not visually disruptive.

### Step 14: A11Y-005 — Table header scope

In `src/components/stress-test-panel.tsx` (line ~176) and across data tables generally:
Add `scope="col"` to column headers and `scope="row"` to row headers:
```tsx
<th scope="col">Column Name</th>
```

Apply this to the same tables from Step 13. Don't modify files in `src/components/ui/` (shadcn primitives).

## Acceptance Criteria

1. `npm run build` passes with zero errors
2. `npm run lint` passes
3. Verify with grep: no `if (!data) return null` pattern remaining without an error check in the fixed files:
   ```
   grep -n "return null" src/components/daily-digest.tsx src/components/stablecoin-detail/safety-score-history-section.tsx src/components/dews-detail.tsx src/components/dews-summary.tsx
   ```
4. All affected components import and render `QueryErrorNotice` when hook errors occur
5. All 3 status tables have `overflow-x-auto` wrapper
6. Toggle buttons have `aria-pressed`
7. Data tables have `<caption>` and `<th scope="col">`
