---
title: "Create YieldDetailSection component"
agent: "codex"
model: "gpt-5.4"
reasoning_effort: "high"
done: false
---

## Goal

Build a yield intelligence section for stablecoin detail pages showing yield stats, source info, warning signals, and a history chart.

## Task

1. **Read these files first:**
   - `src/app/stablecoin/[id]/client.tsx` — how detail sections are structured
   - `src/hooks/use-yield-rankings.ts` — data source for yield stats
   - `src/components/yield-history-chart.tsx` — chart component to embed
   - `src/components/yield-leaderboard.tsx` — check if `WARNING_SIGNAL_LABELS` exists there
   - `shared/lib/classification.ts` — `YIELD_TYPE_LABELS` (`Record<YieldType, string>`) and `YIELD_TYPE_STYLES` (`Record<YieldType, { badge: string; hex: string }>`). Use `.badge` for all styling — there are NO `.bg` or `.text` properties.
   - `src/components/ui/tooltip.tsx` — check if Tooltip component exists (installed by Phase 3D). If not, create a minimal hover tooltip using CSS `group`/`group-hover` Tailwind utilities or the AltSourcesPopover pattern from the leaderboard.
   - `docs/design-language.md` — card and section styling patterns

2. **Handle WARNING_SIGNAL_LABELS duplication:**
   - If `WARNING_SIGNAL_LABELS` already exists in `yield-leaderboard.tsx`, extract it to `src/lib/yield-constants.ts` and import in both files.
   - If it doesn't exist there, define it in the new component directly.

3. **Create `src/components/yield-detail-section.tsx`:**

   **Props:**
   ```ts
   interface YieldDetailSectionProps {
     stablecoinId: string;
   }
   ```

   **Data fetching:**
   ```ts
   const { data } = useYieldRankings();
   const ranking = data?.rankings.find(r => r.id === stablecoinId);
   const riskFreeRate = data?.riskFreeRate ?? 0;
   const medianApy = data?.medianApy ?? 0;
   ```

   **Return null** if `!ranking` and the coin is not yield-bearing (check for this by seeing if `data?.rankings` loaded but this coin isn't in it). Return empty state message if the coin should have yield data but doesn't.

   **Layout (top to bottom):**

   a. **Header:** Section title "Yield Intelligence" + yield type badge:
   ```tsx
   <div className="flex items-center justify-between">
     <h3 className="text-lg font-semibold">Yield Intelligence</h3>
     <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${YIELD_TYPE_STYLES[ranking.yieldType].badge}`}>
       {YIELD_TYPE_LABELS[ranking.yieldType]}
     </span>
   </div>
   ```

   b. **Warning callout** (only when `warningSignals.length >= 2`):
   ```tsx
   <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
     <div className="flex items-start gap-2">
       <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
       <div className="text-sm text-amber-200">
         <strong>Multiple risk signals active:</strong>
         <ul className="mt-1 space-y-0.5 text-xs text-amber-300/80">
           {ranking.warningSignals.map(s => (
             <li key={s}>{WARNING_SIGNAL_LABELS[s] ?? s}</li>
           ))}
         </ul>
       </div>
     </div>
   </div>
   ```
   For a single signal, show inline icon + text instead of a callout block.

   c. **Stat cards** (5 cards in a responsive grid):
   ```
   Current APY | 30d APY | PYS (with tooltip) | Stability | Excess Yield
   ```
   - Current APY: `ranking.currentApy.toFixed(2)%`
   - 30d APY: `ranking.apy30d.toFixed(2)%`
   - PYS: `ranking.pharosYieldScore` with color coding (green >40, amber >20, red <=20). Add a hover breakdown tooltip showing:
     - Yield Efficiency: `(ranking.apy30d / Math.max(0.5, (101 - (ranking.safetyScore ?? 40)) / 20)).toFixed(1)`
     - Safety: `ranking.safetyGrade ?? "?"` (`ranking.safetyScore ?? 40`)
     - Consistency: `(Math.max(0.3, ranking.yieldStability ?? 1.0) * 100).toFixed(0)%`
     Use the CSS `group`/`group-hover` hover pattern (since Phase 3E runs in parallel with Phase 3D and cannot depend on the shadcn Tooltip install from Phase 3D TICKET-002):
     ```tsx
     <div className="group relative cursor-help">
       <span className={`font-mono text-2xl ${pysColor}`}>{ranking.pharosYieldScore}</span>
       <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-50">
         <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md max-w-[220px] space-y-1.5">
           <div><span className="text-muted-foreground">Yield Efficiency: </span><span className="font-mono">{yieldEfficiency.toFixed(1)}</span></div>
           <div><span className="text-muted-foreground">Safety: </span><span className="font-mono">{ranking.safetyGrade ?? "?"}</span></div>
           <div><span className="text-muted-foreground">Consistency: </span><span className="font-mono">{(sustainabilityMult * 100).toFixed(0)}%</span></div>
         </div>
       </div>
     </div>
     ```
     Compute `yieldEfficiency`, `riskPenalty`, `sustainabilityMult` the same way as the PYS formula:
     ```ts
     const riskPenalty = Math.max(0.5, (101 - (ranking.safetyScore ?? 40)) / 20);
     const yieldEfficiency = ranking.apy30d / riskPenalty;
     const sustainabilityMult = Math.max(0.3, ranking.yieldStability ?? 1.0);
     ```
   - Stability: `(ranking.yieldStability * 100).toFixed(0)%`
   - Excess Yield: `ranking.excessYield.toFixed(2)%`, green if positive, red if negative
   - All numbers in `font-mono`

   d. **Source info row:**
   - Yield source name (`ranking.yieldSource`)
   - Data source badge: "On-chain" / "DeFiLlama" / "Price-derived" (derive from `ranking.dataSource`)
   - TVL: formatted USD (`ranking.sourceTvlUsd`)

   e. **Alt sources** (if `ranking.altSources.length > 0`):
   - Compact list: each alt source name + current APY

   f. **History chart:**
   ```tsx
   <YieldHistoryChart
     stablecoinId={stablecoinId}
     riskFreeRate={riskFreeRate}
     medianApy={medianApy}
   />
   ```

4. **Styling:** Follow card patterns from design-language.md. Dark-first. Static Tailwind classes only. `font-mono` for all numbers.

## Acceptance Criteria

- `test -f src/components/yield-detail-section.tsx` returns success
- `npm run build` exits 0
- `grep -c "YieldHistoryChart" src/components/yield-detail-section.tsx` returns >= 1
- `grep -c "useYieldRankings" src/components/yield-detail-section.tsx` returns >= 1
- `grep -c "YIELD_TYPE_LABELS" src/components/yield-detail-section.tsx` returns >= 1
- Component returns null when no yield data exists for the coin
- Warning callout appears only for 2+ signals
