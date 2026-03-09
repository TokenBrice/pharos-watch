---
title: "Build YieldHistoryChart component"
agent: "codex"
model: "gpt-5.4"
reasoning_effort: "high"
done: false
---

## Goal

Create a shared Recharts-based chart component showing APY over time with T-bill reference line, peer median reference line, base/reward toggle, warning signal markers, and time preset buttons.

## Task

1. **Read these files first** (required context):
   - `src/components/yield-scatter-plot.tsx` — Recharts conventions, color tokens, responsive patterns
   - `src/hooks/use-yield-history.ts` — data fetching hook (created in TICKET-002)
   - `docs/design-tokens.md` — color token system
   - `docs/design-language.md` — chart styling patterns
   - Check if `src/components/ui/toggle.tsx` or `src/components/ui/toggle-group.tsx` exists for the base/reward toggle

2. **Create `src/components/yield-history-chart.tsx`:**

   **Props:**
   ```ts
   interface YieldHistoryChartProps {
     stablecoinId: string;
     riskFreeRate: number;
     medianApy: number;
     defaultDays?: number;  // default: 90
     compact?: boolean;     // true when used in leaderboard expandable row
   }
   ```

   **Internal state:**
   - `days`: number — managed by time preset buttons, initialized from `defaultDays`
   - `showBreakdown`: boolean — toggle for base/reward APY split, default false

   **Data:** Call `useYieldHistory(stablecoinId, days)`. Handle loading, error, and empty states.

   **Chart structure (Recharts `ResponsiveContainer` + `ComposedChart`):**
   - **Height:** 300px default, 200px in compact mode
   - **Primary `Line`:** `dataKey="apy"`, solid, brand accent color `oklch(0.72 0.14 248)`, strokeWidth 2, dot={false}
   - **Base APY `Line`** (conditional on `showBreakdown` AND any data point has non-null `apyBase`): `dataKey="apyBase"`, solid, muted color, strokeWidth 1.5, dot={false}
   - **Reward APY `Line`** (conditional same): `dataKey="apyReward"`, dashed (`strokeDasharray="4 3"`), muted color, strokeWidth 1.5, dot={false}
   - **T-bill `ReferenceLine`:** `y={riskFreeRate}`, horizontal dashed (`strokeDasharray="6 4"`), muted color, label="T-Bill" (small, positioned right)
   - **Peer median `ReferenceLine`:** `y={medianApy}`, horizontal dashed (`strokeDasharray="3 3"`), different muted color, label="Peer Median" (small, positioned right). Hide if `medianApy <= 0`.
   - **Warning markers:** For data points where `warningSignals.length > 0`, render using Recharts `Dot` customization or a custom active dot. Use amber fill. Small size (r=4).
   - **XAxis:** `dataKey="date"`, format dates based on period: daily ticks for 7d, weekly for 30d/90d, monthly for 1y. Use `tickFormatter` to format dates.
   - **YAxis:** APY %, auto domain with small padding. `tickFormatter` adds "%" suffix. Use `font-mono` for tick labels.
   - **Tooltip:** Custom tooltip showing: date (formatted), APY (%), apyBase/apyReward if `showBreakdown`, list of warning signals (if any on that point). All numbers in `font-mono`.
   - **CartesianGrid:** `strokeDasharray="3 3"`, subtle opacity

   **Controls above chart:**
   - **Time presets:** Row of 4 small buttons: "7d", "30d", "90d", "1y". Active button gets accent styling. Clicking sets `days` to 7, 30, 90, or 365.
   - **Base/reward toggle:** Small toggle/switch button labeled "Show breakdown". Only render if any data point has non-null `apyBase`. In compact mode, use abbreviated label or icon only.

   **Loading state:** Skeleton placeholder matching chart dimensions.
   **Error state:** Subtle error message within chart area.
   **Empty state:** "No yield history available" centered text.

   **Compact mode adjustments (`compact={true}`):**
   - Height: 200px
   - Hide reference line labels (keep the lines)
   - Smaller font sizes
   - Simplified time preset buttons

3. **Styling requirements:**
   - All Tailwind classes must be **static strings** — never dynamically constructed
   - Use `font-mono` for all numbers
   - Dark-first with light mode support (use CSS variables / Tailwind dark: variants as used in existing components)
   - Colors: use semantic tokens from `design-tokens.md`, not raw hex/oklch values (except brand accent)

## Acceptance Criteria

- `test -f src/components/yield-history-chart.tsx` returns success
- `npm run build` exits 0
- `grep -c "ReferenceLine" src/components/yield-history-chart.tsx` returns >= 2 (T-bill + median)
- `grep -c "useYieldHistory" src/components/yield-history-chart.tsx` returns >= 1
- `grep -c "ResponsiveContainer" src/components/yield-history-chart.tsx` returns >= 1
- No dynamic Tailwind class construction (no template literals building class names)
- All numbers use `font-mono` class
