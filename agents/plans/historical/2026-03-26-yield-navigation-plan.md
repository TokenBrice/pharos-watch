# Yield Navigation: Refined Implementation Plan

Date: 2026-03-26
Status: Draft
Based on: `agents/research/2026-03-26-yield-navigation-exploration.md`

## Problem Statement

The yield data model supports multiple sources per stablecoin (avg 3.55 sources/ranking, 44% of rows have alternatives), but the UI still treats yield as a single-source leaderboard. Users who start with a coin in mind must scan the table manually, and alternative sources are buried in a tiny `+N` popover that doesn't scale.

## Design Constraints (from live codebase audit)

These are the patterns every addition must follow:

- **Cards**: `rounded-xl border border-border/60 bg-background/55`, accent borders via `border-l-[3px]`
- **Kicker labels**: `text-[12px] font-semibold uppercase tracking-[0.12em] text-muted-foreground`
- **Numeric values**: `font-mono tabular-nums` everywhere, right-aligned in tables
- **Section rhythm**: `space-y-6` between sections, `space-y-3` within
- **Interactive pills**: `rounded-full border border-border/60 bg-background/60` with `data-[state=on]:bg-primary data-[state=on]:text-primary-foreground`
- **Badges**: `Badge variant="outline"` with category-specific color classes from `YIELD_TYPE_STYLES`
- **Progressive disclosure**: columns hide at breakpoints (sm/md/lg/xl), expanded rows for detail
- **Color**: semantic only (emerald = positive/yield, amber = warning, red = danger, sky = switches/info)
- **Overlays**: existing `Sheet` component (Radix-based, slide from right, `w-3/4 sm:max-w-sm`)

## Phase 1: Coin-First Source Explorer on `/yield`

### 1A. Stablecoin Search Combobox

**What**: Add a search/filter input at the top of the yield leaderboard, inline with the existing type filter pills.

**Where**: `src/components/yield-leaderboard.tsx`, in the controls bar above the table (where the type filter pills and "Hide warned" checkbox already live).

**Implementation**:
- Use the shadcn `Command` component (combobox pattern) wrapped in a `Popover`. This is consistent with how other search/filter patterns work in the shadcn ecosystem.
- Trigger: an input styled as a search field with `rounded-full border border-border/60 bg-background/60 px-3 py-1.5 text-sm` and a `Search` icon (from lucide). This matches the existing pill/control styling in the chart time-range and source selectors.
- Dropdown: `Command` list showing matching stablecoin names/symbols from the current rankings data. No new API call needed -- filter client-side from the already-loaded rankings array.
- On select: scroll to + highlight the matching row (brief `bg-primary/10` flash), and auto-expand it.
- Keyboard: arrow keys navigate, Enter selects, Escape closes. All built into `Command`.

**Why this approach**:
- Reuses existing data (rankings are already loaded).
- `Command` combobox is already in the shadcn primitives -- just needs wiring.
- Fits the existing control bar layout without adding a new section.
- The search pill looks native next to the type filter pills.

**Mobile**: Full-width below the type filter pills on `< sm`, inline on `sm+`.

### 1B. Source Explorer Sheet (replaces `+N` popover)

**What**: Replace the `AltSourcesPopover` (inline `+N` button opening a tiny absolute-positioned div) with a proper right-side `Sheet` that shows all sources for a stablecoin.

**Where**: New component `src/components/yield-source-sheet.tsx`. Triggered from the leaderboard row.

**Trigger**: The existing `+N` chip becomes a `SheetTrigger`. Same visual: `rounded-full bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground hover:bg-accent`. But now it opens the Sheet instead of a popover.

**Sheet content** (top to bottom):

1. **Header**: Stablecoin name + symbol + logo (reuse `StablecoinLogo` component). Below: a `text-xs text-muted-foreground` line showing total source count.

2. **Best source card**: A card matching the expanded-row style (`rounded-xl border border-border/60 bg-background/55 px-3 py-2.5`) with:
   - `border-l-[3px] border-l-emerald-500` accent (matches yield detail section pattern)
   - Kicker: "BEST SOURCE" in uppercase tracking
   - Source name (as `YieldSourceLink`), type badge, APY (`font-mono text-lg`), TVL, data source
   - Confidence tier pill from provenance

3. **Alternative sources list**: Each source as a compact row inside a `rounded-xl border border-border/60 bg-muted/20 p-3` container. Each row:
   - Source name, type badge (from `YIELD_TYPE_STYLES`), APY, TVL
   - Click row -> updates the history chart source (via the existing `sourceKey` mechanism in `YieldHistoryChart`)
   - Style: `flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/55 px-3 py-2 hover:bg-muted/30` (matches alt source cards in `yield-detail-section.tsx`)

4. **Inline history chart**: Embed `YieldHistoryChart` in `compact` mode (already supported, uses `h-[200px]`). Source selector visible. This reuses the existing component exactly as-is.

5. **Footer link**: "View full dossier" link to `/stablecoin/[id]` -- styled as `text-xs text-muted-foreground hover:text-foreground` with arrow icon.

**Why Sheet over drawer/modal**:
- `Sheet` component already exists in `src/components/ui/sheet.tsx` (Radix-based, right-side slide).
- Keeps the table visible behind the sheet -- user doesn't lose context.
- Mobile: sheet takes `w-3/4`, which is enough for the compact source list.
- Avoids the "giant modal with marketing-style empty space" anti-pattern called out in the design context.

**Sheet width override**: Default `sm:max-w-sm` is too narrow for the chart. Use `sm:max-w-md` (28rem / 448px) to give the chart room while staying panel-sized.

### 1C. Source Count Column

**What**: Add a "Sources" column to the leaderboard table, visible on `md+`.

**Where**: `src/components/yield-leaderboard.tsx`, column definitions.

**Implementation**:
- Column header: "Sources", `text-center`, hidden below `md`
- Cell: source count number (`1 + altSources.length`), styled as `font-mono text-xs text-muted-foreground`. If count > 1, render as the `SheetTrigger` chip (clickable, opens source sheet). If count === 1, render as plain text.
- This replaces the current `+N` chip that's inline with the source name. The source name column keeps showing just the best source name.

**Sort**: Sortable by source count (descending by default when activated).

### Implementation Notes for Phase 1

- **No new API endpoints needed**. All data comes from the existing `YieldRankingsResponse` (which includes `altSources[]` per ranking) and the existing `GET /api/yield-history?sourceKey=...` endpoint.
- **State**: The sheet needs to know which ranking row is selected. Use a simple `useState<string | null>(selectedId)` in the leaderboard component, passed to the sheet.
- **Chart in sheet**: Pass the stablecoin `id` and optionally a `sourceKey` to `YieldHistoryChart`. The chart already supports source selection via its internal state -- just mount it with the right props.
- **Remove `AltSourcesPopover`**: Once the sheet is in place, delete the old popover component entirely. No backwards-compat shim.

---

## Phase 2: Detail-Page Source Navigator

### 2A. Promote Source Count

**What**: Surface total source count in the yield detail section header, next to the section title.

**Where**: `src/components/yield-detail-section.tsx`, in the `CardHeader`.

**Implementation**:
- Add a pill next to the section title: `Sources (N)` styled as `rounded-full border border-border/60 bg-muted/20 px-2 py-0.5 text-xs font-mono text-muted-foreground`. Only shown when N > 1.
- This matches the badge/pill patterns used elsewhere (e.g., yield type badges in the same header).

### 2B. Upgrade Alternative Sources Grid to Source Table

**What**: Replace the current alt-source card grid with a compact, sortable source table. Make source switching a first-class interaction, not buried in chart controls.

**Where**: `src/components/yield-detail-section.tsx`, the "Alternative Sources" section.

**Implementation**:
- Replace the `grid gap-2 sm:grid-cols-2` of alt source cards with a compact table inside the same `rounded-xl border border-border/60 bg-muted/20 p-4` container.
- Columns: Source Name | Type (badge) | APY 30d | TVL | Action
- Action column: a small "Chart" icon button. Clicking it sets the source in the history chart above (scroll into view if needed).
- The currently selected/best source gets a subtle `bg-primary/5` row highlight and a small "Best" pill.
- Sortable by APY and TVL.
- Compact: `text-xs`, tight padding, no header borders -- it's a mini-table inside a card, not a full page table.

### 2C. Persistent Source Selector Above Chart

**What**: Move the source selector out of the chart's internal controls row and place it as a standalone control above the chart, making it more visible.

**Where**: `src/components/yield-detail-section.tsx`, above the `YieldHistoryChart` mount point.

**Implementation**:
- Render a row of source pills (one per source) above the chart. Each pill: `rounded-full border border-border/60 bg-background/60 px-2.5 py-1 text-xs font-mono`. Active pill: `bg-primary text-primary-foreground`.
- This mirrors the time-range toggle pattern already used in `YieldHistoryChart`.
- When a source pill is clicked, pass the `sourceKey` down to the chart.
- Keep the chart's own source selector as a fallback for the sheet/compact contexts, but in the detail page context, the external pills take precedence.

---

## Phase 3: Source-First Protocol Browser (future)

**Prerequisite**: Source identity normalization (dedup symbol collisions, establish protocol families). The research doc correctly identifies that the current source data is too noisy for a clean protocol browse mode.

**When ready**:
- Add a toggle at the top of `/yield`: "By coin" / "By source" -- using the existing `ToggleGroup` pattern with `pharos-toggle-pill` class.
- "By source" view groups rows by normalized protocol family (Morpho, Pendle, Aave, Beefy, Native savings, etc.).
- Each group: expandable card showing covered stablecoins, median APY, total TVL.

**Not in scope for Phase 1 or 2.** Flagged here for architectural awareness -- the Phase 1 sheet component should not hardcode assumptions that would block this later.

---

## Rollout Order

| Step | Scope | Depends on |
|------|-------|------------|
| 1A | Search combobox on `/yield` | Nothing |
| 1B | Source explorer sheet | Nothing (can parallel with 1A) |
| 1C | Sources column in table | 1B (sheet is the click target) |
| 2A | Source count in detail header | Nothing |
| 2B | Source table on detail page | Nothing |
| 2C | Source pills above detail chart | Nothing |
| 3 | Protocol browser mode | Source normalization work |

Steps 1A, 1B, 2A, 2B, 2C are independent and can be built in parallel. 1C depends on 1B for the sheet trigger.

## What This Plan Does NOT Do

- **No new API endpoints.** Everything uses existing `yield-rankings` and `yield-history` endpoints.
- **No source normalization.** That's a data-layer concern; the UI should work with current data and get better when normalization lands.
- **No new routes.** The `/yield` page and `/stablecoin/[id]` page are the only surfaces changed.
- **No table column explosion.** The only new column is "Sources" (on `md+`). The sheet handles the rest.
