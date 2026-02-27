# Stablecoin Detail Hero Redesign

**Date:** 2026-02-26
**Status:** Approved

## Problem

The current hero section uses three separate stat cards (Market Cap/Supply | Price/Gauge | Peg/Liquidity) below a flat logo+name row. The left and right cards waste space — too much chrome and whitespace for the data they show. As the first thing users see when clicking a coin, it should feel denser and more intentional.

## Design

Replace the breadcrumb → logo/name row → description → section nav → 3-card grid with a **single unified card** containing a **2-column layout**.

### Overall Structure

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Dashboard / USDC                                            Compare ↔  │
│  ──────────────────────────────────────────────────────────────────────  │
│                                                                          │
│  ┌─ LEFT (~45%) ──────────────────┬─ RIGHT (~55%) ─────────────────────┐│
│  │  [Logo 48px]                   │  MARKET CAP      SUPPLY            ││
│  │  USD Coin  USDC  ●A           │  $54.2B          54.2B USDC        ││
│  │  Centralized · RWA-Backed·USD │  +1.2% 24h       +0.8% 7d         ││
│  │                                │  ──────────────────────────────     ││
│  │  ┌──────────┐  $1.0001        │  PEG SCORE       LIQUIDITY         ││
│  │  │ PegGauge │  +0.01 bps      │  97/100          85/100            ││
│  │  └──────────┘                 │  99.2% at peg    $1.2B TVL         ││
│  │                                │  3 events        42 pools·8 chains ││
│  └────────────────────────────────┴────────────────────────────────────┘│
│  ──────────────────────────────────────────────────────────────────────  │
│  Overview | Safety Score | Chart | Info | Liquidity | History            │
└──────────────────────────────────────────────────────────────────────────┘
```

### Card Container + Top Bar

- Single `Card` with `rounded-xl border`, no colored left-border
- Top bar: breadcrumb left, Compare link right
- `px-5 pt-4 pb-3` with `border-b border-border/40` separator below

### Left Column — Identity + Price

**Identity row** (flex-wrap, items-center, gap-3):
- Logo: **48px** rounded-full (up from 40px)
- Name: `text-2xl font-extrabold tracking-tighter`
- Symbol: `text-lg text-muted-foreground font-mono`
- BluechipHeaderBadge: unchanged, inline after symbol

**Classification line** (replaces Badge components):
- Single `text-sm text-muted-foreground` line
- Format: "Centralized · RWA-Backed · USD"
- Built from `GOVERNANCE_LABELS`, `BACKING_LABELS`, `PEG_LABELS_SHORT`

**Price + Gauge area** (flex, items-center, gap-4):
- PegGauge: `max-w-[140px]`, left side
- Price: `text-2xl font-bold font-mono`, right of gauge
- Deviation: `text-sm font-mono` below price, colored by severity

Left column: `lg:w-[45%]` or grid `lg:col-span-5` of 12.

### Right Column — 2×2 Stats Grid

`grid grid-cols-2` with thin `border-border/40` dividers between cells.

Each cell structure:
- Label: `text-xs font-semibold uppercase tracking-wider text-muted-foreground`
- Value: `text-xl font-bold font-mono tracking-tight`
- 1-2 secondary lines: `text-xs text-muted-foreground`

**Top-left — Market Cap:**
- Value: `formatCurrency(mcap)`
- Secondary: 24h change (green/red)

**Top-right — Supply:**
- Value: `formatSupply(supply)` + symbol
- Secondary: 7d change (green/red)

**Bottom-left — Peg Score** (hidden for NAV tokens):
- Value: score/100, colored via `pegScoreColor()`
- Secondary: % at peg, depeg event count

**Bottom-right — Liquidity Score:**
- Value: score/100, colored via `getScoreColor()`
- Secondary: TVL, pool count · chain count

**Footer line** below grid: chain count + 30d change + active depeg warning.

Right column: `lg:w-[55%]` or grid `lg:col-span-7` of 12.

### Section Nav (Bottom Bar)

`DetailSectionNav` moves inside the card as a bottom bar.
- `border-t border-border/40` separator
- Same horizontal tab layout, scrollable on mobile

### Mobile (< md)

Single column stack:
1. Identity block (logo, name, badges, classification line)
2. Price + gauge (full width)
3. 2×2 stats grid (stays 2×2, works at small sizes)
4. Section nav (horizontally scrollable)

No data hidden — just reflows.

## Files Changed

- `src/app/stablecoin/[id]/page.tsx` — restructure server-side hero into unified card
- `src/app/stablecoin/[id]/client.tsx` — move stats into 2×2 grid, remove 3-card layout
- `src/components/detail-section-nav.tsx` — may need minor adjustment for card-internal positioning

## What Stays the Same

- All data sources and hooks unchanged
- BluechipHeaderBadge component reused as-is
- PegGauge component reused (just resized)
- Score color functions unchanged
- Format helpers unchanged
- All existing conditional logic (NAV tokens, missing liquidity data) preserved
