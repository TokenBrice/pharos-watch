---
title: "Apply performance config quick wins: optimizePackageImports and background-attachment fix"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "medium"
done: false
---

## Goal

Extend Next.js `optimizePackageImports` to cover additional heavy libraries, and fix the `background-attachment: fixed` scroll performance issue.

## Context

**Research findings addressed:**
- R4 Finding M2: optimizePackageImports misses heavy libraries
- R4 Finding M3: Fixed background-attachment forces expensive repaints during scroll

## Task

### 1. Extend optimizePackageImports

In `next.config.ts` (~line 4-12), the `experimental.optimizePackageImports` array currently only includes `recharts` and `lucide-react`. Add these additional packages:

```typescript
experimental: {
  optimizePackageImports: [
    "recharts",
    "lucide-react",
    "@tanstack/react-query",
    "@tanstack/react-virtual",
    "zod",
  ],
},
```

Do NOT add `html-to-image` here — that will be handled by lazy-loading in Phase B.

### 2. Fix background-attachment scroll jank

In `src/app/globals.css` (~line 44-63), the `body` element uses `background-attachment: fixed` on two radial gradients. This causes paint-heavy scrolling on many GPUs.

Change `background-attachment: fixed` to `background-attachment: local` (or remove it entirely since `local` is the default). The gradients will scroll with content instead of staying fixed, but this eliminates the compositing overhead.

Alternatively, if the fixed background effect is important, move the gradient to a `::before` pseudo-element with `position: fixed; inset: 0; z-index: -1;` so the browser can promote it to its own layer.

Choose whichever approach is simpler while maintaining the visual appearance.

## Files Modified

- `next.config.ts`
- `src/app/globals.css`

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep 'react-query' next.config.ts` shows it's in optimizePackageImports
- `grep 'react-virtual' next.config.ts` shows it's in optimizePackageImports
- `grep -c 'background-attachment.*fixed' src/app/globals.css` returns 0 (no more fixed attachment on body)
