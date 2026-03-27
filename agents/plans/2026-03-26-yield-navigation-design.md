# Yield Navigation Design Spec

Date: 2026-03-26
Status: Approved

## Problem

The yield data model supports multiple sources per stablecoin (avg 3.55 sources/ranking, 44% of rows have alternatives), but the UI treats yield as a single-source leaderboard. Users who start with a coin in mind must scan the table manually, and alternative sources are buried in a `+N` popover that doesn't scale past 2-3 alternatives.

## Scope

Two surfaces changed: `/yield` page and `/stablecoin/[id]` yield section. No new routes. No new API endpoints. All data comes from existing `yield-rankings` and `yield-history` endpoints.

## Phase 1: `/yield` Page

### 1A. Stablecoin Search Combobox

**Placement**: In the `topSlot` of the `DataTableShell` in `yield-leaderboard.tsx`. The `topSlot` container changes from `flex flex-wrap` to `flex flex-col gap-2`. The search input is the first child (full-width). The type filter pills row is the second child (keeping its current `flex flex-wrap items-center gap-2`). On desktop, the search input is constrained to `max-w-xs`.

**Component**: shadcn `Command` inside a `Popover`.

**Trigger input styling**:
```
pharos-focus-ring rounded-full border border-border/60 bg-background/60 px-3 py-1.5 text-sm
```
With a `Search` lucide icon on the left. Placeholder: "Search stablecoin..."

**Behavior — table filter mode**:
- Typing filters the leaderboard table itself, not just a dropdown. The table shows only rows matching the query (by symbol or name). Clearing the search restores the full table.
- Additionally, a `Command` dropdown appears below the input showing the top 5 matches for quick-jump. Selecting from the dropdown clears the search, scrolls to the row, and auto-expands it.
- Keyboard: arrow keys navigate dropdown, Enter selects, Escape closes dropdown (built into `Command`)

**Data source**: No new API call. Filters the `rankings` prop already passed to the leaderboard component.

### 1B. Source Explorer Sheet

**Trigger**: The existing `+N` chip on leaderboard rows becomes a `SheetTrigger`. Visual unchanged: `pharos-focus-ring rounded-full bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground hover:bg-accent`.

**Mobile trigger path**: The Sources column is hidden below `md`, so on mobile the `+N` chip must remain visible inside the expanded row content (which is always shown after tapping a row). The expanded row already shows source details — the `+N` chip moves there on mobile, opening the full sheet for deeper exploration.

**Component**: New file `src/components/yield-source-sheet.tsx`. Uses the existing `Sheet` from `src/components/ui/sheet.tsx`, opening from the right side.

**Width**: Override default to `sm:max-w-md` (448px) to give the embedded chart adequate room.

**Sheet content (top to bottom)**:

1. **Header**
   - `StablecoinLogo` + coin name + symbol
   - Subtitle: `N yield sources` in `text-xs text-muted-foreground`

2. **Best source card**
   - Container: `rounded-xl border border-border/60 bg-background/55 px-3 py-2.5`
   - Left accent: `border-l-[3px] border-l-emerald-500`
   - Kicker label: "BEST SOURCE" — `text-[12px] font-semibold uppercase tracking-[0.12em] text-muted-foreground`
   - Content: source name (as `YieldSourceLink`), yield type badge (`Badge variant="outline"` with `YIELD_TYPE_STYLES`), APY (`font-mono text-lg`), TVL, data source, confidence tier pill from provenance

3. **Alternative sources list**
   - Outer container: `rounded-xl border border-border/60 bg-muted/20 p-3`
   - Kicker: "ALTERNATIVE SOURCES" — same uppercase tracking style
   - Each source row: `flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/55 px-3 py-2 hover:bg-muted/30 cursor-pointer`
   - Row content: source name, type badge, APY (`font-mono text-sm`), TVL
   - Click behavior: sets the selected source key, which updates the chart below
   - Selected row highlight: `ring-1 ring-primary/40`

4. **Inline history chart**
   - Source subtitle above chart: `Showing: {sourceName}` in `text-xs text-muted-foreground` — updates when a source row is clicked, providing visual confirmation of the connection
   - `YieldHistoryChart` in `compact` mode (existing prop, renders at `h-[200px]`)
   - Single source at a time — source switching driven by clicking rows in the list above
   - When a source row is clicked, the chart scrolls into view within the sheet (`scrollIntoView({ behavior: 'smooth', block: 'nearest' })`)
   - Time range controls visible, source selector hidden (redundant with the list)

5. **Footer link**
   - "View full dossier →" linking to `/stablecoin/[id]`
   - Styled: `pharos-focus-ring text-xs text-muted-foreground hover:text-foreground`

**State management**: Two pieces of state in the leaderboard component:
- `sheetRankingId: string | null` — which coin's sheet is open (controls `Sheet` open/close)
- The sheet receives the full `YieldRanking` object for the selected coin (looked up from `rankings` by ID)

Inside the sheet, a local `selectedSourceKey: string | null` state controls which source's history is displayed in the embedded chart. Defaults to the best source's `sourceKey` from provenance. Resets when the sheet opens for a different coin.

**Deletion**: The `AltSourcesPopover` component is removed entirely. No backwards-compat wrapper.

### 1C. Sources Column

**Placement**: New column in the leaderboard table, visible on `md+` (hidden below `md`).

**Header**: "Sources", `text-center`.

**Cell**:
- Displays total source count: `1 + altSources.length`
- Typography: `font-mono text-xs text-muted-foreground text-center`
- If count > 1: rendered as the clickable `SheetTrigger` chip (opens the source explorer sheet)
- If count === 1: plain text, no interaction

**Sorting**: Sortable by source count, descending default when activated.

## Phase 2: `/stablecoin/[id]` Yield Section

### 2A. Source Count in Section Header

**Where**: `yield-detail-section.tsx`, in the `CardHeader` next to the section title.

**What**: A pill showing `Sources (N)`, only rendered when N > 1.

**Styling**: `rounded-full border border-border/60 bg-muted/20 px-2 py-0.5 text-xs font-mono text-muted-foreground`

### 2B. Source Table (replaces alt-source card grid)

**Where**: `yield-detail-section.tsx`, the "Alternative Sources" section.

**What**: Replace the `grid gap-2 sm:grid-cols-2` of alt-source cards with a compact sortable table.

**Rendering threshold**: Only render the source table when `altSources.length >= 2`. For 0-1 alternatives, keep the current compact card layout — a table with one row and sort headers looks odd.

**Container**: Same `rounded-xl border border-border/60 bg-muted/20 p-4` as the current section.

**Columns**: Source Name | Type (badge) | APY 30d | TVL | Action

**Row behavior**:
- Action column: small chart icon button. Click sets the source in the history chart above (scrolls to chart if needed).
- Currently selected/best source row: subtle `bg-primary/5` highlight + small "Best" pill.
- Typography: `text-xs`, tight padding. This is a mini-table inside a card, not a full-page table.

**Sorting**: Sortable by APY and TVL columns.

### 2C. Source Selector Pills Above Chart

**Where**: `yield-detail-section.tsx`, rendered above the `YieldHistoryChart` component.

**What**: A row of pills, one per source. Replaces the in-chart source dropdown as the primary source switching control for the detail page context.

**Styling**: Uses the shared `pharos-control-pill` system (promoted control language per design-language.md):
- Container: `flex flex-wrap items-center gap-1.5`
- Each pill: `pharos-control-pill` with `text-xs font-mono`
- Active pill: `pharos-control-pill pharos-control-pill-active`

**Behavior**: Clicking a pill passes the `sourceKey` down to the chart. The chart's internal source selector is hidden when external pills are present (to avoid redundant controls).

## Phase 3: Protocol Browser (future, not in scope)

Deferred until source identity normalization lands. When ready:
- Toggle at top of `/yield`: "By coin" / "By source" using `ToggleGroup` with `pharos-toggle-pill`
- Groups rows by normalized protocol family (Morpho, Pendle, Aave, etc.)
- Each group shows: covered stablecoins, median APY, total TVL

Not designed in detail here — depends on data-layer work that hasn't happened yet.

## Files Changed

| File | Change |
|------|--------|
| `src/components/yield-leaderboard.tsx` | Add search combobox in `topSlot`, add Sources column, replace `AltSourcesPopover` trigger with `SheetTrigger`, manage selected-ranking state |
| `src/components/yield-source-sheet.tsx` | **New file** — source explorer sheet component |
| `src/components/yield-detail-section.tsx` | Add source count pill, replace alt-source grid with mini table, add source selector pills above chart |
| `src/components/yield-history-chart.tsx` | Add prop to hide internal source selector when external pills control source switching |

## Files Deleted

| File | Reason |
|------|--------|
| Inline `AltSourcesPopover` (currently defined inside `yield-leaderboard.tsx`) | Replaced by source explorer sheet |

## What This Design Does NOT Do

- No new API endpoints — everything uses existing `yield-rankings` and `yield-history`
- No source normalization — UI works with current data, improves when normalization lands
- No new routes — `/yield` and `/stablecoin/[id]` are the only surfaces changed
- No multi-source chart comparison — single source at a time, switched by user interaction
- No table column explosion — only one new column (Sources on `md+`)
