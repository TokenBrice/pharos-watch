# PSI Overlay on Homepage Marketcap Chart

**Date:** 2026-02-25
**Status:** Approved

## Goal

Overlay the Pharos Stability Index (PSI) as a line on the homepage total stablecoin marketcap chart, allowing users to see the relationship between market cap growth and stability.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Visibility | Always visible | Maximizes discoverability of PSI |
| Visual style | Clean teal line | Distinct from blue area, matches PSI brand |
| Right Y-axis | Fixed 0-100 | Shows absolute context (distance from crisis) |
| Data interpolation | Monotone curves | Smooth daily points, honest about granularity |

## Architecture

Upgrade `TotalMcapChart` from `<AreaChart>` to `<ComposedChart>`. Add `<Line>` for PSI with right-side `<YAxis>` fixed at 0-100.

**Data source:** `useStabilityIndex()` — already fetched on homepage for lighthouse widget. TanStack Query deduplicates the request (no new API call).

## Data Merging

Marketcap data is sub-daily; PSI is daily. Forward-fill PSI scores into the marketcap data array:

1. Build sorted PSI array from `data.history` (reversed to oldest-first) + `data.current`
2. For each marketcap point, find most recent PSI score at or before that timestamp
3. Result: every point has `{ ts, total, score }` — single clean array for Recharts

## Visual Spec

- **Market cap area:** Unchanged — blue (`#3b82f6`) with gradient fill, left Y-axis
- **PSI line:** Teal (`#14b8a6`), `strokeWidth={2}`, no dots, right Y-axis
- **Right Y-axis:** Fixed `[0, 100]`, plain numbers, minimal styling (no axis line/ticks)
- **Legend:** Small inline pills below header — "Market Cap" (blue) + "PSI" (teal)
- **Tooltip:** Shows both values — "Market Cap: $234.5B" and "PSI: 81.2"

## Data Scope

Default `useStabilityIndex()` returns 91 days. For "1y"/"all" ranges, PSI line ends where data runs out. No need for the heavier detail endpoint.

## Edge Cases

- **PSI loading/error:** Chart renders as today (marketcap only, no PSI line)
- **No matching timestamps:** Forward-fill produces no matches; no line drawn
- **Short ranges (7d):** ~7 PSI points with monotone interpolation looks fine as trend line

## Files Changed

- `src/components/total-mcap-chart.tsx` — Main changes (ComposedChart, Line, right YAxis, data merge, legend, tooltip)
- `src/lib/chart-colors.ts` — Export `CHART_TEAL` constant (`#14b8a6`)
