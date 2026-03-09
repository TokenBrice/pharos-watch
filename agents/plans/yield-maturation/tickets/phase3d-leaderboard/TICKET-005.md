---
title: "Add expandable rows with YieldHistoryChart to leaderboard"
agent: "codex"
model: "gpt-5.4"
reasoning_effort: "high"
done: false
---

## Goal

Make leaderboard rows expandable to show an inline APY history chart below the clicked row.

## Task

1. **Read `src/components/yield-leaderboard.tsx`** — Understand the current row rendering.
2. **Read `src/components/yield-history-chart.tsx`** — Understand the props interface.
3. **Read `src/app/yield/client.tsx`** — Understand how props flow to YieldLeaderboard.

4. **Update YieldLeaderboard props:**
   ```ts
   interface YieldLeaderboardProps {
     rankings: YieldRanking[];
     logos: Record<string, string>;
     riskFreeRate: number;   // NEW
     medianApy: number;      // NEW
   }
   ```
   Remove `onRowClick` if it exists — row clicks now expand/collapse instead of navigating.

5. **Add expanded state:**
   ```ts
   const [expandedId, setExpandedId] = useState<string | null>(null);
   ```

6. **On row click:**
   ```ts
   onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}
   ```
   - If clicking the already-expanded row -> collapse (set null)
   - Otherwise -> expand the clicked row

7. **Add expand/collapse indicator** at the end of each row:
   ```tsx
   <td className="px-2 py-2 text-right">
     <ChevronDown className={expandedId === r.id
       ? "h-4 w-4 text-muted-foreground rotate-180 transition-transform"
       : "h-4 w-4 text-muted-foreground transition-transform"
     } />
   </td>
   ```
   Import `ChevronDown` from `lucide-react`.

8. **Render expansion panel** after each row when expanded:
   ```tsx
   {expandedId === r.id && (
     <tr>
       <td colSpan={columnCount} className="p-4 bg-muted/30">
         <YieldHistoryChart
           stablecoinId={r.id}
           riskFreeRate={riskFreeRate}
           medianApy={medianApy}
           compact
         />
       </td>
     </tr>
   )}
   ```
   - `columnCount` should match the actual number of `<th>` elements in the header (count them — currently ~10, will be 11 with signals column + expand indicator)
   - Import `YieldHistoryChart` from `@/components/yield-history-chart`

9. **Update `src/app/yield/client.tsx`:**
   - Pass `riskFreeRate={data.riskFreeRate}` and `medianApy={data.medianApy ?? 0}` to `YieldLeaderboard`
   - Remove `onRowClick` prop if it was being passed

10. **Only one row expanded at a time** — this is automatic since `expandedId` is a single string.

## Acceptance Criteria

- `npm run build` exits 0
- `grep -c "expandedId" src/components/yield-leaderboard.tsx` returns >= 3
- `grep -c "YieldHistoryChart" src/components/yield-leaderboard.tsx` returns >= 1
- `grep -c "medianApy" src/app/yield/client.tsx` returns >= 1
- `grep -c "riskFreeRate" src/components/yield-leaderboard.tsx` returns >= 1
- Clicking a row expands chart below it
- Clicking again collapses
- Only one row expanded at a time
