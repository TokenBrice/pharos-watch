# Depeg Tracker Page Design

**Date:** 2026-03-01
**Route:** `/depeg`
**Nav group:** Data (alongside Liquidity, Blacklist, Compare)

## Overview

Dedicated page for depeg monitoring. Consolidates three homepage components (DEWSSummary, PegHeatmap, DepegFeed) with a new summary stats section and a comprehensive peg data table. Layout follows the liquidity page pattern.

## Page Layout (top to bottom)

### 1. Header (server-rendered)

- Breadcrumb: Dashboard / Depeg Tracker
- Title: "Depeg Tracker"
- Description paragraph explaining the page's purpose

### 2. Summary Stats Cards (`DepegTrackerStats`)

6-card responsive grid (`grid-cols-2 lg:grid-cols-3 xl:grid-cols-6`), same pattern as `LiquidityStats`:

| Card | Border Color | Source |
|------|-------------|--------|
| Active Depegs | red | `pegSummary.activeDepegCount` |
| Coins at Peg | green | `pegSummary.coinsAtPeg` |
| Median Deviation | blue | `pegSummary.medianDeviationBps` |
| Total Tracked | violet | `pegSummary.totalTracked` |
| Events Today | amber | `pegSummary.depegEventsToday` (delta vs yesterday) |
| Worst Current | orange | `pegSummary.worstCurrent` (symbol + bps) |

### 3. DEWS Summary (moved from homepage)

`DEWSSummary` component — grid of coins with elevated threat bands. No changes to the component itself.

### 4. Peg Data Table (`DepegTrackerTable`)

Sortable, paginated table with responsive column hiding:

| Column | Breakpoint | Sort Key | Format |
|--------|-----------|----------|--------|
| # (rank) | always | — | right-aligned |
| Name | always | — | logo + symbol (+ name on lg+) |
| Peg Score | always | `pegScore` | 0-100, color-coded |
| DEWS | always | `dewsScore` | band badge + numeric score |
| Current Deviation | always | `currentDeviationBps` | ±N bps, color-coded |
| Peg % | md+ | `pegPct` | percentage |
| Event Count | md+ | `eventCount` | integer |
| Worst Deviation | lg+ | `worstDeviationBps` | ±N bps |
| Active Depeg | lg+ | `activeDepeg` | LIVE badge or — |
| DEX Agreement | xl+ | `dexAgrees` | checkmark/X or — |
| Tracking Span | xl+ | `trackingSpanDays` | human-readable |

- **Default sort:** composite "needs attention" — active depegs first, then DEWS threat band descending, then absolute deviation descending. Coins needing eyes float to the top on page load without user interaction.
- **Row severity accents:** subtle 3px left-border on rows based on overall status: red for active depeg, orange for DEWS WARNING+, no accent otherwise. Same design language as the liquidity stats card accents, applied to table rows for instant visual triage.
- Filters: peg currency toggle (All/USD/EUR/Gold), governance type toggle, search input
- Pagination: 25 rows per page
- URL-persisted filters via `useUrlFilters()`
- Click row → `/stablecoin/[id]`, hover → prefetch

### 5. Peg Heatmap (moved from homepage)

`PegHeatmap` component — live deviation tile grid.

### 6. Recent Depeg Events Feed (moved from homepage)

`DepegFeed` component — chronological event cards with LIVE badges. No changes to the component itself.

## Design Refinements

### Unified filter state

Table and heatmap share a single filter state via one `useUrlFilters()` call in the client orchestrator. When you toggle "USD only" or type a search query, both the table and the heatmap respond. Single source of truth — no divergent views on the same page.

## Data Flow

```
DepegClient (client.tsx)
├── usePegSummary()       → stats, table rows, heatmap coins
├── useStressSignals()    → DEWS column data, DEWSSummary component
├── useDepegEvents()      → DepegFeed component
└── useStablecoinLogos()  → logos for all components
```

Single client component orchestrates hooks and distributes data to children.

## Homepage Changes

Remove from `HomepageClient`:
- `DEWSSummary` component and its render
- `PegHeatmap` component and its render + filter state (peg/type/search)
- `DepegFeed` component and its render

Preserve all other homepage modules. Clean up any hook calls / state that become unused after removal.

## File Structure

```
src/app/depeg/
├── page.tsx          — metadata, breadcrumb, header, dynamic client import
└── client.tsx        — hook orchestration, filters, layout composition

src/components/
├── depeg-tracker-stats.tsx   — summary stats cards (new)
└── depeg-tracker-table.tsx   — peg data table (new)
```

Existing components (no changes needed):
- `src/components/dews-summary.tsx`
- `src/components/peg-heatmap.tsx`
- `src/components/depeg-feed.tsx`

## Navigation

Add to `src/lib/nav-config.ts` in the Data group:

```typescript
{
  href: "/depeg",
  label: "Depeg Tracker",
  icon: Activity,
  description: "Live peg monitoring & early warnings"
}
```
