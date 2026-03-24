# Distribution Charts — Stablecoin Detail Page

**Date:** 2026-03-25
**Status:** Approved
**Location:** New section on stablecoin detail page, between Chart and Info sections

## Overview

Add a "Distribution" section to the stablecoin detail page featuring two donut charts side by side: chain supply distribution (left) and DEX liquidity distribution by protocol (right). Stacks to single column on mobile.

## Data Sources

### Chain Distribution (left chart)
- **Source:** `StablecoinData.chainCirculating` from `useStablecoins()` hook
- **Access:** `useStablecoins()` returns `StablecoinListResponse` with a `peggedAssets: StablecoinData[]` array. The component must find the coin via `peggedAssets.find(a => a.id === stablecoinId)` then read `.chainCirculating`.
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
- `<section id="distribution">` wrapping a `grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4`
- Each cell is a `<Card>` (`rounded-xl`) with:
  - `CardHeader` (tight, `pb-2`) containing `CardTitle as="h2"` using `DETAIL_SECTION_TITLE_CLASS` (`text-lg font-semibold tracking-tight`) — matching every other detail section card
  - `CardContent` with the donut chart inside a `pharos-chart-stage` container (with `role="figure"` and `aria-label`) + legend below

### Chart Specifications

Both charts use Recharts `PieChart` + `Pie` (donut style, matching `cemetery-charts.tsx` pattern).

| Property | Value |
|---|---|
| Chart height | `h-[200px] sm:h-[250px]` (intentionally smaller than the standard `h-[250px] sm:h-[350px]` — donuts are simpler charts in a half-width column) |
| Inner radius | 50 |
| Outer radius | 85 |
| Padding angle | 3 |
| Stroke width | 0 |
| Grouping threshold | Segments < 2% of total grouped into "Other" |
| Sort order | Descending by value |

**Center label:** Total value (circulating supply or DEX TVL) displayed in the donut hole using a custom Recharts `<Label>`. Formatted via `formatCurrency` (compact notation), rendered in `font-mono tabular-nums text-sm font-semibold`.

### Colors

Recharts renders raw SVG — `fill` attributes need hex strings, not Tailwind classes. The existing `CHAIN_COLORS` / `PROTOCOL_COLORS` in `src/lib/dex-constants.ts` are Tailwind class strings (`bg-blue-600`). Two parallel hex maps (`CHAIN_HEX` and `PROTOCOL_HEX`) will be added to `dex-constants.ts`, following the same pattern as `CAUSE_HEX` in `shared/lib/dead-stablecoins.ts`.

- **Chains:** `CHAIN_HEX` for SVG fills. Unmapped chains fall back to `CHART_PALETTE` from `@/lib/chart-colors`. "Other" segment uses `CHART_SLATE`.
- **Protocols:** `PROTOCOL_HEX` for SVG fills. Unmapped protocols fall back to `CHART_PALETTE`. "Other" uses `CHART_SLATE`.
- **Legend dots:** Continue using the existing Tailwind class maps (`CHAIN_COLORS`, `PROTOCOL_COLORS`) for `bg-*` legend markers, since those render as HTML, not SVG.

### Legend
- Positioned below each chart, outside the `pharos-chart-stage`
- Inline-wrapped layout: `flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground`
- Each entry: color dot (or logo if available) + name + percentage in `font-mono tabular-nums` (numeric language rule)
- Chain logos from `CHAIN_META[key].logoPath`, protocol logos from `PROTOCOL_LOGOS`

### Tooltip
- Uses `PharosChartTooltip` + `TooltipRow` pattern (existing components) — uppercase label, mono values
- Shows: colored dot, name, USD value (via `formatCurrency`), percentage

### Empty / Edge States
- **Single chain:** Show the section with only the chain chart; DEX chart card shows a muted data-availability banner: `rounded-md border px-4 py-2.5 text-sm border-border/60 bg-muted/40 text-muted-foreground` with "No DEX liquidity data available" (matches Data Availability Banner pattern from design language)
- **No chain data:** Hide the entire section (shouldn't happen for tracked coins)
- **Loading:** Each card renders independently — if one hook has loaded and the other hasn't, the loaded chart renders while the other shows a skeleton (`animate-pulse rounded-xl`). This avoids blocking both charts when only one data source is slow.

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
3. Render between the chart section (`<section id="chart">`, line ~283) and info section (`<section id="info">`, line ~287) in `client.tsx`:
   ```tsx
   <section id="distribution">
     <SectionErrorBoundary name="distribution">
       <DistributionSection stablecoinId={viewModel.id} />
     </SectionErrorBoundary>
   </section>
   ```
   `SectionErrorBoundary` is already imported in `client.tsx` and used for the liquidity section — same pattern.

### No View Model Changes
Both `useStablecoins()` and `useDexLiquidity()` are already available as standalone hooks. The component calls them directly, matching the pattern used by `DexLiquidityCard`.

## Files Changed

| File | Change |
|---|---|
| `src/components/stablecoin-detail/distribution-section.tsx` | **New** — distribution donut charts component |
| `src/lib/dex-constants.ts` | Add `CHAIN_HEX` and `PROTOCOL_HEX` maps (hex equivalents for SVG fills) |
| `src/app/stablecoin/[id]/client.tsx` | Add section entry, dynamic import, render in layout with `SectionErrorBoundary` |

## Testing

- Visual verification on coins with many chains (USDT, USDC) and few chains (single-chain stables)
- Verify "Other" grouping works when many small chains exist
- Verify DEX empty state for coins without liquidity data
- Responsive: verify stacking on mobile, side-by-side on md+
- Build passes (`npm run build`)
