---
title: "Add warning signals column to leaderboard"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
---

## Goal

Display warning signals in the leaderboard with subtle indicators for single signals and prominent styling for multiple signals.

## Task

1. **Read `src/components/yield-leaderboard.tsx`** — Find the table column definitions and row rendering.

2. **Install shadcn Tooltip component** (it does NOT currently exist in `src/components/ui/`):
   ```bash
   npx shadcn@latest add tooltip
   ```
   If this command fails or is unavailable, create a minimal tooltip using the same hover-popover pattern as `AltSourcesPopover` already in this file (useState + useRef + onMouseEnter/onMouseLeave).

3. **Add a signal description constant** at the top of the file (after imports):
   ```ts
   const WARNING_SIGNAL_LABELS: Record<string, string> = {
     "yield-spike": "APY spiked 2\u00d7 above 30d average",
     "yield-divergence": "APY is 3\u00d7 the market median",
     "negative-trend": "APY declined 30%+ from average",
     "reward-heavy": "80%+ of yield from incentive rewards",
     "tvl-outflow": "TVL dropped 20%+ in the past week",
     "data-stale": "Yield data hasn\u2019t refreshed in 90+ min",
   };
   ```

4. **Add "Signals" column** after the last existing column (after "30d Range"):
   - **Header:** `Signals` (hidden on mobile — check how other columns handle responsive hiding, likely `className="hidden md:table-cell"` or similar)
   - **Cell rendering logic:**
     ```tsx
     {r.warningSignals.length === 0 ? (
       <span className="text-muted-foreground">&mdash;</span>
     ) : (
       <Tooltip>
         <TooltipTrigger>
           <AlertTriangle className={r.warningSignals.length >= 2
             ? "h-4 w-4 text-amber-500 fill-amber-500/20"
             : "h-4 w-4 text-amber-500"
           } />
         </TooltipTrigger>
         <TooltipContent>
           <ul className="text-xs space-y-1">
             {r.warningSignals.map(s => (
               <li key={s}>{WARNING_SIGNAL_LABELS[s] ?? s}</li>
             ))}
           </ul>
         </TooltipContent>
       </Tooltip>
     )}
     ```
   - Import `AlertTriangle` from `lucide-react`
   - Adapt Tooltip usage to match the project's existing pattern (check imports from `@/components/ui/tooltip`)

5. **Row accent for multiple signals:**
   - On the `<tr>` element, add conditional left border:
     ```tsx
     className={`... ${r.warningSignals.length >= 2 ? "border-l-2 border-amber-500/50" : ""}`}
     ```
   - This must use static class strings in the ternary (both branches are complete strings).

## Acceptance Criteria

- `npm run build` exits 0
- `grep -c "WARNING_SIGNAL_LABELS" src/components/yield-leaderboard.tsx` returns >= 1
- `grep -c "AlertTriangle" src/components/yield-leaderboard.tsx` returns >= 1
- `grep -c "warningSignals" src/components/yield-leaderboard.tsx` returns >= 2
- Single warning shows outline amber icon with tooltip
- Multiple warnings show filled icon + amber left border on row
