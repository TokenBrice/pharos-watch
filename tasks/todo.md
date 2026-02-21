# Pharos Design Audit — Implementation Plan

## Phase 1 (Parallel — independent file sets)

### A. Table Overhaul (`stablecoin-table.tsx`)
- [x] Pagination (25/page with controls)
- [x] Add ↑/↓ arrows alongside green/red on 24h & 7d columns
- [x] Add direction indicator on peg deviation column
- [x] Full-row click target (navigate to detail)
- [x] `aria-sort` on sortable headers
- [x] Keyboard accessibility on sort headers (role, tabIndex, onKeyDown)
- [x] Mobile column hiding (hide Backing/Type/Flags on <md, hide 7d on <sm)
- [x] 3-point mini sparkline column (current, prevDay, prevWeek)

### B. Filters & Search (`page.tsx`)
- [x] Move filters directly above the table
- [x] Add active filter count badge
- [x] Search placeholder → "Search by name or symbol..."
- [x] Sync filter/search state to URL search params

### C. Navigation & Layout (`header.tsx`, `footer.tsx`, `layout.tsx`)
- [x] Mobile hamburger menu on header (<sm breakpoint)
- [x] Richer footer (nav links, data attribution, last updated)
- [x] Skip-to-content link in layout
- [x] `id="main-content"` on main element

### D. Chart Improvements (`price-chart.tsx`, `mcap-chart.tsx`, `total-mcap-chart.tsx`)
- [x] Time range selector (7D / 30D / 90D / 1Y / All)
- [x] Empty states when data is empty
- [x] Consistent tooltip formatting

### E. KPI & Detail Page (`category-stats.tsx`, `client.tsx`)
- [x] Trend deltas on category stat cards
- [x] Breadcrumbs on detail page
- [x] Mini sparklines on detail page Price/Market Cap cards

## Phase 2 (After Phase 1 — accessibility & polish sweep)

### F. Accessibility & Polish
- [x] `aria-live="polite"` on table container
- [x] Chart `aria-label` summaries
- [x] Content-aware skeleton rows for table loading
- [x] Hover states on interactive cards
- [x] Data freshness timestamp component

## Phase 3
- [x] `npm run build` — must pass with zero errors
- [x] Grep for any remaining issues
