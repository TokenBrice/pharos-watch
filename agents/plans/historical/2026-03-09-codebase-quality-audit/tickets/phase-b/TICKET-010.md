---
title: "Add empty states to stability-index sections and table row a11y"
agent: "codex"
model: "gpt-5.1-codex-max"
reasoning_effort: "high"
done: true
---

## Goal

Fix blank sections on the stability-index page when data is missing, and add link semantics to stablecoin table rows for screen reader accessibility.

## Context

**Research findings addressed:**
- R3-C1: Stability Index subsections return `null` when data is empty, yielding blank space
- R3-I3: Stablecoin table rows handle clicks but render as `<tr>` without `role="link"` or aria labels
- R3-M4: Stablecoin table pagination footer not announced to screen readers

## Task

### 1. Add empty states to stability-index sections

In `src/app/stability-index/client.tsx`, find all places where sections return `null` when their data arrays are empty (research identified ~lines 254, 280, 300, 485, 645). For each, replace `return null` with a simple empty-state message:

```tsx
if (!data?.length) {
  return (
    <div className="text-center py-8 text-muted-foreground text-sm">
      No data available
    </div>
  );
}
```

Keep the layout height stable — use the same container/card wrapper that the loaded state uses, just show the empty message inside it.

### 2. Add link semantics to stablecoin table rows

In `src/components/stablecoin-table.tsx` (~lines 388-404), the clickable `<tr>` elements use `onClick` and keyboard handlers but lack accessible link semantics.

Add to each clickable row:
- `role="link"`
- `aria-label={`View ${coin.name} (${coin.symbol}) details`}`
- `tabIndex={0}` (if not already present)

### 3. Add aria-label to pagination footer

In `src/components/stablecoin-table.tsx`, find the pagination footer section. Add `aria-label="Table pagination"` to the footer container and `aria-live="polite"` to the "Showing X-Y of Z" text span.

## Files Modified

- `src/app/stability-index/client.tsx`
- `src/components/stablecoin-table.tsx`

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep -c 'return null' src/app/stability-index/client.tsx` is lower than the original count
- `grep 'role="link"' src/components/stablecoin-table.tsx` shows link role on rows
- `grep 'aria-label.*pagination' src/components/stablecoin-table.tsx` shows labeled pagination
