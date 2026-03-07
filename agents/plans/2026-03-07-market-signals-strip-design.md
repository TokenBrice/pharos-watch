# Market Signals Strip — Design Document

**Date:** 2026-03-07
**Replaces:** `src/components/market-highlights.tsx` (BiggestDepegs + FastestMovers two-card layout)

## Problem

The current MarketHighlights component renders two side-by-side cards on the homepage. On desktop, each card uses a 2-column grid for 8 items — lots of whitespace for sparse data. On mobile, the depeg card's 2-column layout squashes prices and bps into unreadable overlap, and the movers card truncates coin names.

## Goal

Replace both cards with a single compact **Market Signals strip** — a horizontal, ticker-style component that delivers both depeg and mover signals at a glance with minimal vertical footprint.

## Design

### Structure

Single `pharos-card-shell` with no CardHeader/CardContent chrome. Two zones inside:

- **Left zone**: BIGGEST DEPEGS
- **Right zone**: MOVERS (7d)

Separated by a vertical `border-r border-border/40` divider on desktop (`lg+`). On mobile, zones stack vertically with a horizontal `border-t` divider between them.

```
Desktop (lg+):
┌──────────────────────────────────┬──────────────────────────────────┐
│ BIGGEST DEPEGS                   │ MOVERS (7d)                      │
│ [BRZ -8267bp] [SUSD -1922bp]    │ [↑ apxUSD +192%] [↓ SBC -65%]   │
│ [GYEN -1167bp] [EURS +816bp]    │ [↑ tGBP +140%]   [↓ WUSD -26%]  │
│                                  │ [↑ U +47%]       [↓ AUSD -19%]  │
└──────────────────────────────────┴──────────────────────────────────┘

Mobile (<lg):
┌──────────────────────────────┐
│ BIGGEST DEPEGS               │
│ [BRZ -8267bp] [SUSD -1922bp]│
│ [GYEN -1167bp]               │
│ ─────────────────────────────│
│ MOVERS (7d)                  │
│ [↑ apxUSD +192%] [↓ SBC -65%]│
│ [↑ tGBP +140%] [↓ WUSD -26%]│
└──────────────────────────────┘
```

### Data

**Depegs zone:**
- Top entries by absolute bps deviation (capped — see responsive section)
- Each entry: `[logo 16px] SYMBOL [bps]`
- No price shown — symbol + deviation is the signal
- NAV tokens excluded, supply floor $1M (same filters as today)
- Entries flow in a 2-column grid within the zone

**Movers zone:**
- Top growers paired with top shrinkers, row by row:
  - Row 1: #1 grower | #1 shrinker
  - Row 2: #2 grower | #2 shrinker
  - Row 3: #3 grower | #3 shrinker
- Each entry: `[logo 16px] SYMBOL [±pct]`
- Supply floor $1M, 7d window (same as today)

### Entry component

Each entry is a `<Link>` to the coin's detail page. Compact `inline-flex items-center gap-1.5`, `text-xs`, monospace numbers. Hover: subtle `bg-muted/40` background + underline on symbol. Uses the existing `pharos-focus-ring` pattern.

### Color: sign-aware depeg semantics

Depegs below peg and above peg are different risk signals:
- **Below peg** (negative bps): `text-red-700 dark:text-red-400` — insolvency/redemption concern
- **Above peg** (positive bps): `text-amber-700 dark:text-amber-400` — liquidity premium
- **Near peg** (<10 bps absolute): `text-muted-foreground`

Movers keep existing colors:
- Growers: `text-emerald-700 dark:text-emerald-400`
- Shrinkers: `text-red-700 dark:text-red-400`

### Responsive item capping via CSS

Instead of a fixed item count, use Tailwind responsive `hidden`/`flex` classes on entries by index:

| Breakpoint | Depegs shown | Mover pairs shown |
|------------|-------------|-------------------|
| `xs` (< sm) | 2 | 2 |
| `sm`–`md` | 3 | 3 |
| `lg+` | 4 | 3 |

Implementation: render all items, apply `hidden sm:flex` on the 3rd, `hidden lg:flex` on the 4th. Zero JS, no layout shifts, strip always fits the viewport.

### Section labels

Small uppercase kickers: `text-[11px] font-semibold uppercase tracking-wider text-muted-foreground`. "BIGGEST DEPEGS" and "MOVERS (7d)". Labels are plain text (not links) — only individual coins are links.

### Empty states

- All on-peg: "All on-peg" in `text-xs text-muted-foreground` in the depegs zone
- No significant movers: "No significant moves" in the movers zone

### Skeleton

Single card matching the two-zone layout. Each zone: kicker skeleton (`h-2.5 w-20`) + 3 entry skeletons (`h-4 w-24`). Uses the `SKELETON_INDICES` pattern from Batch 6.

## Files changed

- **Modify**: `src/components/market-highlights.tsx` — full rewrite of the component internals. Keep the same export name `MarketHighlights` and props interface. Delete `BiggestDepegs` and `FastestMovers` sub-components, replace with unified strip.
- **No other files change** — the homepage already renders `<MarketHighlights>` in the right spot.

## Out of scope

- Live-updating animation on data refresh (can add later)
- Linking section headers to /depeg or /flows (only coins link)
- Showing more than symbol + deviation/percentage per entry
