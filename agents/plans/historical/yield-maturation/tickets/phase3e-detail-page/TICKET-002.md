---
title: "Integrate yield section into stablecoin detail page"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "medium"
done: false
---

## Goal

Wire `YieldDetailSection` into the existing stablecoin detail page.

## Task

1. **Read `src/app/stablecoin/[id]/client.tsx`** — Understand:
   - The `DETAIL_SECTIONS` array and how it drives section navigation
   - How section components are rendered (dynamic imports, conditional rendering)
   - The pattern for lazy-loading section components

2. **Add "Yield" to `DETAIL_SECTIONS`:**
   - Insert `{ id: "yield", label: "Yield" }` into the array. Place it after "info" (or after "chart"):
   ```ts
   { id: "yield", label: "Yield" },
   ```
   - Always include it in the array — the component handles returning null when no data exists.

3. **Import and render `YieldDetailSection`:**
   - Add a dynamic import matching the pattern used by other section components:
     ```ts
     const YieldDetailSection = dynamic(() => import("@/components/yield-detail-section"), { ssr: false });
     ```
   - Or if sections use a different lazy-loading pattern (e.g., React.lazy, direct import), match that pattern exactly.

4. **Render in the section loop:**
   - Find where sections are rendered (likely a switch statement, map, or series of conditionals on section ID)
   - Add the yield case:
     ```tsx
     {section.id === "yield" && <YieldDetailSection stablecoinId={id} />}
     ```
   - Pass the stablecoin ID — find how it's accessed in this component (likely from route params or props).

## Acceptance Criteria

- `npm run build` exits 0
- `grep -c "yield" src/app/stablecoin/\\[id\\]/client.tsx` returns >= 3 (section entry + import + render)
- `grep -c "YieldDetailSection" src/app/stablecoin/\\[id\\]/client.tsx` returns >= 2 (import + usage)
- The "Yield" tab appears in the section navigation on detail pages
- The yield section renders for coins with yield data
- The yield section returns null (invisible) for coins without yield data
