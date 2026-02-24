# Compare Feature Improvements

## Context

The compare feature (`/compare/`) was a quick implementation allowing side-by-side comparison of up to 3 stablecoins. It works but has UX, accessibility, and functionality gaps identified during review.

## Changes

### 1. Remove "best" highlight from Market Cap
Remove green highlight from Market Cap row — "highest" isn't objectively "best." Keep highlighting for peg score, price accuracy, liquidity score, and bluechip grade where "best" is unambiguous.

### 2. Add price/peg deviation chart
Add a second chart showing price history relative to peg (1.0 baseline for USD pegs, native reference for others). This is the most useful comparative visualization for stablecoins.

### 3. Increase max coins from 3 to 5
Change `MAX_COINS` to 5. Update grid layout to accommodate (`sm:grid-cols-3 lg:grid-cols-5`). Extend `CHART_COLORS` to use 5 palette entries.

### 4. Keyboard navigation in CoinSelector
- Arrow keys navigate through dropdown items
- Enter selects the focused item
- Focus trap within dropdown when open
- Escape closes and returns focus to trigger button
- Track `aria-activedescendant` on the listbox

### 5. Partial error/loading states
- Show inline error badge per coin column if its detail request fails
- Show skeleton cells in the table while individual data sources load
- Toast or inline message if a selected coin can't be found in the list data

### 6. Mobile-friendly table layout
On narrow screens (`< sm`), switch from horizontal table to stacked card layout where each coin gets its own card with all metrics listed vertically.

### 7. Fix URL sync
Replace the bidirectional `useState` + `useEffect` pattern with `useSearchParams` as the source of truth. Derive `selectedIds` from params directly, write via `router.replace` only on user actions (select/remove). Eliminates redundant replace on mount.

### 8. Persist time range in URL
Add `&range=30d` query param. Read on mount, update on change. Shared across both charts.

### 9. Log-scale / normalized chart option
Add a toggle above the market cap chart: "Absolute" vs "Normalized (%)". Normalized mode shows percentage change from first data point, making different-scale coins comparable.

### 10. Share/copy-link button
Add a "Copy link" button near the page header that copies the current URL (with coins and range params) to clipboard with a brief "Copied!" toast.
