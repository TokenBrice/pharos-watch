---
title: "Add yield type and warning filters to leaderboard"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
---

## Goal

Add yield type pill toggles and a "Hide warned" toggle as filter controls within each leaderboard tab.

## Task

1. **Read `src/components/yield-leaderboard.tsx`** — Understand the current data flow from props -> sort -> paginate -> render.

2. **Read `shared/lib/classification.ts`** — Import `YIELD_TYPE_LABELS` and `YIELD_TYPE_STYLES`. Their shapes:
   - `YIELD_TYPE_LABELS`: `Record<YieldType, string>` (e.g., `"lending-vault"` → `"Lending"`)
   - `YIELD_TYPE_STYLES`: `Record<YieldType, { badge: string; hex: string }>` — the `.badge` property contains ALL Tailwind classes as a single static string (e.g., `"bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20"`). There are NO separate `.bg` or `.text` properties.

3. **Add filter state** (after existing state like `activeTab`, `sortKey`, `page`):
   ```ts
   const [activeYieldTypes, setActiveYieldTypes] = useState<Set<string>>(() => new Set(
     Object.keys(YIELD_TYPE_LABELS)
   ));
   const [hideWarnings, setHideWarnings] = useState(false);
   ```

4. **Compute visible yield types** for the current tab (only show pills for types that actually exist in the data):
   ```ts
   const tabData = activeTab === "native" ? nativeRankings : lendingRankings;
   const visibleTypes = [...new Set(tabData.map(r => r.yieldType))];
   ```

5. **Apply filters** in the data pipeline (after tab filter, before sort):
   ```ts
   const typeFiltered = filteredRankings.filter(r => activeYieldTypes.has(r.yieldType));
   const warningFiltered = hideWarnings
     ? typeFiltered.filter(r => !r.warningSignals.length)
     : typeFiltered;
   // Use warningFiltered as input to sort/paginate
   ```

6. **Render filter row** between tabs and table:
   ```tsx
   <div className="flex flex-wrap items-center gap-2 mb-3">
     {visibleTypes.map(type => (
       <button
         key={type}
         onClick={() => {
           setActiveYieldTypes(prev => {
             const next = new Set(prev);
             next.has(type) ? next.delete(type) : next.add(type);
             return next;
           });
         }}
         className={activeYieldTypes.has(type)
           ? `px-2 py-0.5 rounded-full text-xs font-medium border ${YIELD_TYPE_STYLES[type as YieldType].badge}`
           : "px-2 py-0.5 rounded-full text-xs font-medium border border-border text-muted-foreground"
         }
       >
         {YIELD_TYPE_LABELS[type as YieldType] ?? type}
       </button>
     ))}
     <label className="flex items-center gap-1.5 text-xs text-muted-foreground ml-auto cursor-pointer">
       <input
         type="checkbox"
         checked={hideWarnings}
         onChange={e => setHideWarnings(e.target.checked)}
         className="rounded border-border"
       />
       Hide warned
     </label>
   </div>
   ```

7. **IMPORTANT Tailwind note:** `YIELD_TYPE_STYLES[type].badge` is a single string containing all Tailwind classes (e.g., `"bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20"`). These classes are defined as static strings in `classification.ts`, so Tailwind's purge will find them. The existing leaderboard already uses this pattern at line ~274: `className={YIELD_TYPE_STYLES[row.yieldType]?.badge ?? ""}`.

8. **Pagination auto-reset:** Do NOT call `setPage(0)` — there is no such function exposed by `useSortedPaginatedTable`. Instead, TICKET-001 sets `resetPageOnTotalChange: true` in the hook options, which automatically resets pagination to page 0 whenever the input row count changes. Since filters change `warningFiltered.length`, pagination resets automatically.

## Acceptance Criteria

- `npm run build` exits 0
- `grep -c "activeYieldTypes" src/components/yield-leaderboard.tsx` returns >= 3
- `grep -c "hideWarnings" src/components/yield-leaderboard.tsx` returns >= 3
- `grep -c "YIELD_TYPE_LABELS" src/components/yield-leaderboard.tsx` returns >= 1
- Yield type pills toggle correctly (multi-select)
- Warning toggle hides/shows rows with active signals
- Pagination resets on filter change
