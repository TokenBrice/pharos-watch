---
title: "Lazy-load html-to-image to reduce initial bundle size"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "medium"
done: false
---

## Goal

Convert the top-level `import { toPng } from "html-to-image"` to a dynamic import so the ~35-45KB library is only loaded when the user actually exports a chart.

## Context

**Research findings addressed:**
- R4-C1: html-to-image is eagerly imported at module top level, adding ~35-45KB to the initial JS bundle even though chart export is rarely used.

## Task

In `src/lib/chart-export.ts` (line 1), replace:

```typescript
import { toPng } from "html-to-image";
```

With a dynamic import inside the function that uses it. The `downloadChartPng()` function (~line 3-19) is the only consumer. Change it to:

```typescript
export async function downloadChartPng(element: HTMLElement, filename: string) {
  const { toPng } = await import("html-to-image");
  // ... rest of function
}
```

If `downloadChartPng` is not already `async`, make it async. Update any callers if needed (they should already be awaiting it or using `.then()`).

## Files Modified

- `src/lib/chart-export.ts`

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep "from \"html-to-image\"" src/lib/chart-export.ts` returns nothing (no top-level import)
- `grep "import(\"html-to-image\")" src/lib/chart-export.ts` shows dynamic import
