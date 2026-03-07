---
title: "Extract shared chart primitives and consolidate chart component scaffolding"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "xhigh"
done: false
---

## Goal

Extract shared Recharts primitives for time-series charts and extract a reusable `CemeteryChartCard` wrapper to eliminate repeated chart scaffolding across 6+ chart components.

## Context

The audit found:
1. Time-series charts repeat the same `CartesianGrid` + date `XAxis` + mono `YAxis` + date `Tooltip` pattern across 6 components (~140 LOC savings)
2. Cemetery charts repeat identical `Card` + `CardHeader` + chart-height container + skeleton fallback 5 times (~85 LOC savings)

## Task

### 1. Create shared chart primitives

Create **`src/components/chart-primitives.tsx`** with these reusable Recharts wrapper components:

- `TimeXAxis`: A preconfigured `XAxis` for date/time series with:
  - `dataKey="date"` (or configurable)
  - Monospace tick font (Geist Mono)
  - Date formatting tick
  - Standard axis styling

- `MonoYAxis`: A preconfigured `YAxis` with:
  - Monospace tick font
  - Configurable formatter (compact number, percentage, etc.)
  - Standard axis styling

- `DateTooltip`: A preconfigured `Tooltip` with:
  - Date label formatting
  - Standard styling matching the dashboard theme

**Important:** Read the existing chart components first to understand the exact patterns used. The primitives should accept all the common props as-is, plus allow overrides via spread props. Look at these files for the repeated pattern:
- `src/components/mcap-chart.tsx` (~lines 171-195)
- `src/components/total-mcap-chart.tsx` (~lines 157-189)
- `src/components/peg-diversity-chart.tsx` (~lines 198-219)
- `src/components/psi-history-chart.tsx` (~lines 307-338)
- `src/components/comparison-chart.tsx` (~lines 189-206)
- `src/components/dews-detail.tsx` (~lines 170-186)

### 2. Use chart primitives in existing charts

Replace the repeated axis/tooltip/grid JSX in each of the 6 chart files listed above with the new primitives. Keep chart-specific series (Line, Area, Bar) as-is.

**Important:** Tailwind classes must be static strings. Do not dynamically construct class names.

### 3. Extract CemeteryChartCard wrapper

**`src/components/cemetery-charts.tsx`** repeats the same card shell 5 times (~lines 63, 144, 221, 325, 409, 493):
- `Card` + `CardHeader` + `CardTitle`
- Fixed chart-height container
- Skeleton loading fallback

Create a `CemeteryChartCard` component (in the same file or extracted) that takes:
- `title: string`
- `ariaLabel?: string`
- `children: ReactNode` (the chart content)

Then replace all 5 card shells with the wrapper.

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `src/components/chart-primitives.tsx` exists
- `grep -c 'TimeXAxis\|MonoYAxis\|DateTooltip' src/components/chart-primitives.tsx` returns 3+
- `grep -c 'TimeXAxis' src/components/mcap-chart.tsx` returns >0 (using the primitive)
- `wc -l src/components/cemetery-charts.tsx` shows reduced LOC vs original
