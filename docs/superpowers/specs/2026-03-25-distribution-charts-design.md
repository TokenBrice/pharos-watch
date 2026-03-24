# Distribution Charts — Stablecoin Detail Page

**Date:** 2026-03-25
**Status:** Approved
**Location:** New section on stablecoin detail page, between Chart and Info sections

## Overview

Add a "Distribution" section to the stablecoin detail page featuring two donut charts side by side: chain supply distribution (left) and DEX liquidity distribution by protocol (right). Stacks to single column on mobile.

## Data Sources

### Chain Distribution (left chart)
- **Source:** `StablecoinData.chainCirculating` from `useStablecoins()` hook
- **Shape:** `Record<string, { current: number, circulatingPrevDay: number, circulatingPrevWeek: number, circulatingPrevMonth: number }>`
- **Values:** Already in USD, no conversion needed
- **Refresh:** Every 15 minutes (existing cron)

### DEX Liquidity Distribution (right chart)
- **Source:** `DexLiquidityData.protocolTvl` from `useDexLiquidity()` hook
- **Shape:** `Record<string, number>` (protocol slug → TVL in USD)
- **Refresh:** Every 30 minutes (existing cron)

No new API endpoints or data pipeline changes required.

## Component

**File:** `src/components/stablecoin-detail/distribution-section.tsx`

**Props:** `{ stablecoinId: string }`

The component fetches data internally via `useStablecoins()` and `useDexLiquidity()` (same pattern as `DexLiquidityCard`).

### Layout
- `<section id="distribution">` wrapping a `grid grid-cols-1 md:grid-cols-2 gap-4`
- Each cell is a `<Card>` with a section kicker title and the donut chart + legend

### Chart Specifications

Both charts use Recharts `PieChart` + `Pie` (donut style, matching `cemetery-charts.tsx` pattern).

| Property | Value |
|---|---|
| Chart height | `h-[200px] sm:h-[250px]` |
| Inner radius | 50 |
| Outer radius | 85 |
| Padding angle | 3 |
| Stroke width | 0 |
| Grouping threshold | Segments < 2% of total grouped into "Other" |
| Sort order | Descending by value |

**Center label:** Total value (circulating supply or DEX TVL) displayed in the donut hole using a custom Recharts label.

### Colors

- **Chains:** `CHAIN_COLORS` from `src/lib/dex-constants.ts`, mapped to hex for SVG fill. Unmapped chains fall back to `CHART_PALETTE`. "Other" segment uses `CHART_SLATE`.
- **Protocols:** `PROTOCOL_COLORS` from `src/lib/dex-constants.ts`, mapped to hex. Unmapped protocols fall back to `EXTRA_COLORS`. "Other" uses `CHART_SLATE`.

Note: `CHAIN_COLORS` and `PROTOCOL_COLORS` use Tailwind classes (`bg-blue-600`). These must be mapped to hex values for SVG `fill` attributes since Recharts renders SVG directly. A small lookup map will convert the class names to hex.

### Legend
- Positioned below each chart
- Inline-wrapped layout: `flex flex-wrap gap-x-4 gap-y-1.5`
- Each entry: color dot (or logo if available) + name + percentage in monospace
- Chain logos from `CHAIN_META[key].logoPath`, protocol logos from `PROTOCOL_LOGOS`

### Tooltip
- Uses `PharosChartTooltip` + `TooltipRow` pattern (existing components)
- Shows: colored dot, name, USD value (formatted), percentage

### Empty / Edge States
- **Single chain:** Show the section with only the chain chart; DEX chart shows "No DEX liquidity data available" muted message
- **No chain data:** Hide the entire section (shouldn't happen for tracked coins)
- **Loading:** Skeleton matching existing detail section pattern

## Integration

### Detail Page (`src/app/stablecoin/[id]/client.tsx`)

1. Add `{ id: "distribution", label: "Distribution" }` to `DETAIL_SECTIONS` after `{ id: "chart", label: "Chart" }`
2. Dynamic-import the component:
   ```ts
   const DistributionSection = dynamic(
     () => import("@/components/stablecoin-detail/distribution-section").then((mod) => mod.DistributionSection),
     { loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" /> }
   );
   ```
3. Render between the chart section and info section:
   ```tsx
   <section id="distribution">
     <DistributionSection stablecoinId={viewModel.id} />
   </section>
   ```

### No View Model Changes
Both `useStablecoins()` and `useDexLiquidity()` are already available as standalone hooks. The component calls them directly, matching the pattern used by `DexLiquidityCard`.

## Files Changed

| File | Change |
|---|---|
| `src/components/stablecoin-detail/distribution-section.tsx` | **New** — distribution donut charts component |
| `src/app/stablecoin/[id]/client.tsx` | Add section entry, dynamic import, render in layout |

## Testing

- Visual verification on coins with many chains (USDT, USDC) and few chains (single-chain stables)
- Verify "Other" grouping works when many small chains exist
- Verify DEX empty state for coins without liquidity data
- Responsive: verify stacking on mobile, side-by-side on md+
- Build passes (`npm run build`)
