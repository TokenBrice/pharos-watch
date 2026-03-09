---
title: "Add PYS score breakdown tooltip to leaderboard"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "medium"
done: false
---

## Goal

When hovering over a PYS score in the leaderboard, show a tooltip with the score's component breakdown.

## Task

1. **Read `src/components/yield-leaderboard.tsx`** — Find the PYS column cell rendering.

2. **Wrap the PYS value** in a Tooltip. Check if `src/components/ui/tooltip.tsx` exists (installed by TICKET-002 via `npx shadcn@latest add tooltip`).

   **Option A — If shadcn Tooltip exists**, use it:

   ```tsx
   import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
   // Wrap the table (or component root) in <TooltipProvider> if not already wrapped

   <Tooltip>
     <TooltipTrigger asChild>
       <span className={`font-mono text-sm cursor-help ${pysColor}`}>
         {r.pharosYieldScore}
       </span>
     </TooltipTrigger>
     <TooltipContent className="max-w-[220px]">
       <div className="text-xs space-y-1.5">
         <div>
           <span className="text-muted-foreground">Yield Efficiency: </span>
           <span className="font-mono">{yieldEfficiency.toFixed(1)}</span>
         </div>
         <div className="text-muted-foreground text-[11px]">
           {r.apy30d.toFixed(1)}% APY / {riskPenalty.toFixed(1)}x risk penalty
         </div>
         <div>
           <span className="text-muted-foreground">Safety: </span>
           <span className="font-mono">{r.safetyGrade ?? "?"}</span>
           <span className="text-muted-foreground"> ({r.safetyScore ?? 40})</span>
         </div>
         <div>
           <span className="text-muted-foreground">Consistency: </span>
           <span className="font-mono">{(sustainabilityMult * 100).toFixed(0)}%</span>
         </div>
       </div>
     </TooltipContent>
   </Tooltip>
   ```

   **Option B — If shadcn Tooltip does NOT exist**, use the same CSS hover pattern as `AltSourcesPopover` in this file:

   ```tsx
   <span className="group relative cursor-help">
     <span className={`font-mono text-sm ${pysColor}`}>
       {r.pharosYieldScore}
     </span>
     <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-50">
       <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md max-w-[220px]">
         <div className="space-y-1.5">
           <div>
             <span className="text-muted-foreground">Yield Efficiency: </span>
             <span className="font-mono">{yieldEfficiency.toFixed(1)}</span>
           </div>
           <div className="text-muted-foreground text-[11px]">
             {r.apy30d.toFixed(1)}% APY / {riskPenalty.toFixed(1)}x risk penalty
           </div>
           <div>
             <span className="text-muted-foreground">Safety: </span>
             <span className="font-mono">{r.safetyGrade ?? "?"}</span>
             <span className="text-muted-foreground"> ({r.safetyScore ?? 40})</span>
           </div>
           <div>
             <span className="text-muted-foreground">Consistency: </span>
             <span className="font-mono">{(sustainabilityMult * 100).toFixed(0)}%</span>
           </div>
         </div>
       </div>
     </div>
   </span>
   ```

   **Choose Option A if the file exists, Option B if not. Do NOT install shadcn yourself — that is TICKET-002's responsibility.**

3. **Compute breakdown values** in the row render (before the JSX):
   ```ts
   const riskPenalty = Math.max(0.5, (101 - (r.safetyScore ?? 40)) / 20);
   const yieldEfficiency = r.apy30d / riskPenalty;
   const sustainabilityMult = Math.max(0.3, r.yieldStability ?? 1.0);
   ```

   Derivation:
   - `riskPenalty` and `yieldEfficiency` are straightforward from the PYS formula
   - `sustainabilityMult = max(0.3, yieldStability)` because `yieldStability = 1 - CV` and `sustainabilityMult = max(0.3, 1 - CV)`

4. **Ensure all numbers use `font-mono`** in the tooltip.

## Acceptance Criteria

- `npm run build` exits 0
- `grep -c "riskPenalty" src/components/yield-leaderboard.tsx` returns >= 1
- `grep -c "yieldEfficiency" src/components/yield-leaderboard.tsx` returns >= 1
- `grep -c "Consistency" src/components/yield-leaderboard.tsx` returns >= 1
- Tooltip appears on hover over PYS cell
- All numbers in tooltip use `font-mono`
