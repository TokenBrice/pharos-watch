---
title: "Add Native Yield / Lending Opportunities tabs to leaderboard"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
---

## Goal

Replace the flat leaderboard with two tabs: "Native Yield" (coins with native yield sources) and "Lending Opportunities" (auto-discovered lending pools).

## Task

1. **Read `src/components/yield-leaderboard.tsx`** (~330 lines) — Understand the current component structure, props, state, sorting, and pagination.

2. **Read `src/components/ui/tabs.tsx`** — Check if shadcn Tabs component exists. If not, implement tabs as simple styled buttons.

3. **Add tab state and filtering:**

   a. Add state:
   ```ts
   const [activeTab, setActiveTab] = useState<"native" | "lending">("native");
   ```

   b. Compute filtered data:
   ```ts
   const nativeRankings = rankings.filter(r => r.dataSource !== "defillama-auto");
   const lendingRankings = rankings.filter(r => r.dataSource === "defillama-auto");
   const filteredRankings = activeTab === "native" ? nativeRankings : lendingRankings;
   ```

   c. Use `filteredRankings` as input to the existing sort/paginate pipeline (instead of raw `rankings`).

   d. **Enable automatic pagination reset:** The `useSortedPaginatedTable` hook accepts `resetPageOnTotalChange` in its options. The hook does NOT expose a `setPage()` function — instead, pagination resets automatically when the input row count changes. Find the existing `useSortedPaginatedTable(...)` call and set `resetPageOnTotalChange: true`:
   ```ts
   const { sortedRows, paginatedRows, ... } = useSortedPaginatedTable(filteredRankings, {
     // ... existing options ...
     resetPageOnTotalChange: true,  // auto-reset page when tab/filter changes row count
   });
   ```
   Since switching tabs changes `filteredRankings.length`, pagination will auto-reset to page 0.

4. **Render tab bar** above the table (below any existing header, above the table element):
   ```tsx
   <div className="flex gap-1 border-b border-border mb-4">
     <button
       onClick={() => setActiveTab("native")}
       className={activeTab === "native"
         ? "px-4 py-2 text-sm font-medium border-b-2 border-accent text-foreground"
         : "px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"}
     >
       Native Yield ({nativeRankings.length})
     </button>
     <button
       onClick={() => setActiveTab("lending")}
       className={activeTab === "lending"
         ? "px-4 py-2 text-sm font-medium border-b-2 border-accent text-foreground"
         : "px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"}
     >
       Lending ({lendingRankings.length})
     </button>
   </div>
   ```
   - Use static Tailwind classes — the ternary picks between two complete static strings, which is safe for purging.
   - Adapt the color tokens (`border-accent`, `text-foreground`, `text-muted-foreground`) to match what the codebase actually uses. Read existing components for conventions.
   - **Do NOT call `setPage(0)`** — there is no such function. Pagination resets automatically via `resetPageOnTotalChange: true`.

5. **Pagination auto-resets** when switching tabs (row count changes trigger reset via the hook option).

## Acceptance Criteria

- `npm run build` exits 0
- `grep -c "activeTab" src/components/yield-leaderboard.tsx` returns >= 3
- `grep -c "native\|lending" src/components/yield-leaderboard.tsx` returns >= 6
- `grep -c "defillama-auto" src/components/yield-leaderboard.tsx` returns >= 1
- Tab switching filters the table (native shows non-auto, lending shows auto)
- Page resets to 0 on tab switch
