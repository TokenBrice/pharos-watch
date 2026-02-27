# Detail Hero Card Polish — Design

**Date:** 2026-02-26
**Scope:** Stablecoin detail page hero card (`src/app/stablecoin/[id]/client.tsx`)
**Approach:** Structural Reflow — rebalance left column vertical rhythm, tighten stats grid dividers, normalize whitespace

## Problem

The recently redesigned 2-column hero card has three issues:
1. **Left column imbalance** — identity row, classification, and price/gauge feel like three disconnected elements with uniform gap-4 spacing
2. **Stats grid feels generic** — flat cells with identical borders and padding lack visual precision
3. **Whitespace not intentional** — spacing between elements doesn't create a clear reading hierarchy

## Design

### Left Column — Identity Zone

- Reduce outer column gap: `gap-4` → `gap-3`
- Group identity row + classification line into a single block with `gap-1.5` internal spacing (creates "who this is" zone)
- Add faint top border to price zone: `border-t border-border/30 pt-3` — visually separates identity from pricing
- Keep `mt-auto` on price zone to push it to bottom
- Shrink gauge: `max-w-[140px]` → `max-w-[110px]`
- No changes to: logo size (48px), h1 (2xl extrabold), symbol, badge, classification format

### Right Column — Stats Grid

- Lighten all internal dividers: `border-border/40` → `border-border/30`
- Adjust cell padding: `p-3` → `px-3.5 py-2.5` (more horizontal room, less vertical)
- Add `min-h-[76px]` to each cell for uniform height
- Typography: add `leading-none` to stat values, reduce sub-value spacing `mt-1` → `mt-0.5`
- Score suffix: `/100` spans from `text-base` → `text-sm` (smoother typographic ratio)
- Change percentages: add `tabular-nums` to colored percentage spans to prevent layout shift
- Score accent: Peg Score and Liquidity cells get a `border-l-2` in their score color (green/amber/red) when data is present
- Active depeg warning: match cell padding (`px-3.5`), add `bg-red-500/5` background

### Card Wrapper

- Breadcrumb bar: `pt-4 pb-3` → `pt-3 pb-2.5`; border from `border-border/40` → `border-border/30`
- Card gap override: add `gap-0` to Card className (card manages spacing via borders)
- Vertical column divider: `bg-border/40` → `bg-border/30`, add `my-3` inset (stop short of edges)
- Section nav wrapper: border from `border-border/40` → `border-border/30`

### Section Nav

- Tighten button spacing: `gap-1 p-1.5` → `gap-0.5 p-1`
- Active tab: add `border-b-2 border-foreground/60` underline accent
- No changes to: rounded-lg buttons, bg-muted active background, sticky behavior

## Files Modified

1. `src/app/stablecoin/[id]/client.tsx` — hero card layout and stats grid
2. `src/components/detail-section-nav.tsx` — nav button spacing and active state

## Not Changed

- Card component (`src/components/ui/card.tsx`) — shadcn primitive, not edited
- PegGauge component — only the wrapper className changes
- Severity color system — no threshold or color changes
- Any other page or component
