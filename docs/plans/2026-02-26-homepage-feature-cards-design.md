# Homepage Feature Summary Cards

## Goal

Add two new summary cards to the homepage bottom grid to highlight Report Cards and Stability Index (PSI) features.

## Layout

Change the existing `grid-cols-2` grid to `grid-cols-2 lg:grid-cols-3` so all 6 cards fit in a single responsive grid (3 columns on large screens, 2 on smaller).

**Card order** (left-to-right, top-to-bottom):

1. Peg Tracker (blue) — existing
2. DEX Liquidity (cyan) — existing
3. **Report Cards** (amber) — new
4. Blacklist Activity (red) — existing
5. Cemetery (zinc) — existing
6. **Stability Index** (dynamic) — new

## Report Cards Summary

- **Border**: `border-l-amber-500`
- **Icon**: `ClipboardCheck` from lucide-react
- **Header**: "Report Cards" with "View grades →" link to `/report-cards`
- **Stats**:
  - Number of coins graded
  - Number with A or A+ grade
  - Number with D or F grade
- **Data**: `useReportCards()` hook (already loaded in `homepage-client.tsx`)

## Stability Index Summary

- **Border**: dynamic based on current PSI band (green/yellow/orange/red)
- **Icon**: `PsiLighthouse` mini SVG (already exists in `stability-index.tsx`)
- **Header**: "Stability Index" with "View history →" link to `/stability-index`
- **Stats**:
  - Current score (e.g. "82.3")
  - Current band (e.g. "Calm") with band color
  - Number of days in current band (computed from history)
- **Data**: `useStabilityIndex()` hook

## Style

Both cards follow the exact same pattern as existing summary cards: `Card` with `rounded-2xl`, `border-l-[3px]`, icon + title header, 3-stat grid, and a small navigation link.
