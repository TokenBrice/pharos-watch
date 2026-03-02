# Mobile Menu Redesign: Full-Screen Overlay

**Date**: 2026-03-01
**Status**: Approved

## Problem

The current mobile menu is a `DropdownMenu` that renders all 16 navigation items as a flat, ungrouped list in a narrow dropdown portal. It feels crowded, has poor visual hierarchy, and ignores the 5 logical groups already defined in `nav-config.ts`.

## Solution

Replace the dropdown with a full-screen `Sheet` overlay that organizes items into their existing `NAV_GROUPS` with clear typographic hierarchy.

## Layout

```
┌──────────────────────────────┐
│  [logo] PHAROS            ✕  │  sticky header
│──────────────────────────────│
│                              │
│  ● Dashboard                 │  standalone, active = accent bg
│                              │
│  RISK LAB ──────────────     │  muted uppercase + separator
│  ◎ Stability Index           │
│  ◎ Safety Scores             │
│  ◎ Dependency Map            │
│                              │
│  DATA ──────────────────     │
│  ◎ Liquidity                 │
│  ◎ Depeg Tracker             │
│  ◎ Blacklist Tracker         │
│                              │
│  TOOLS ─────────────────     │
│  ◎ Portfolio Audit           │
│  ◎ Compare                   │
│                              │
│  INFO ──────────────────     │
│  ◎ Cemetery                  │
│  ◎ Digest                    │
│  ◎ Methodology               │
│  ◎ About                     │
│                              │
│  EXPERIMENTAL ──────────     │
│  ◎ Yield                     │
│  ◎ Flows                     │
│                              │
│──────────────────────────────│
│  🔍 Search         🌙 Theme  │  sticky footer
└──────────────────────────────┘
```

## Design Decisions

### Component choice
- `Sheet` from shadcn/ui (side="left") instead of `DropdownMenu`
- Full-width on mobile via className override on `SheetContent`

### Header (sticky)
- Pharos logo + "PHAROS" text on left
- X close button on right (SheetClose)

### Navigation items
- Icon + label per item, with **description** as muted secondary text below the label (uses existing `description` field from `nav-config.ts`)
- `py-3` padding for comfortable tap targets (~48px height)
- Active item: subtle accent background + font-medium (matches desktop sidebar)

### Group headers
- Muted uppercase text: `text-xs tracking-wider text-muted-foreground`
- Separator line after label
- Dashboard item stands alone above the groups

### Footer (sticky)
- Search button (opens command palette) and theme toggle
- Moved from the header bar into the sheet to declutter the top bar

### Staggered group entry animation
- Each group fades/slides in with ~50ms delay per group (5 groups = 250ms total)
- CSS animation with `animation-delay` per group index, using `@keyframes` for fade + translateY
- Dashboard item animates first, then each group in sequence

### Current-section visual anchor
- The group containing the active page gets a subtle left accent border on the entire group block
- Provides instant "you are here" orientation at the group level, not just item level

### Close behavior
- Tapping any nav link closes the sheet and navigates
- X button and backdrop scrim also close
- Sheet uses existing shadcn slide-from-left animation

## What Changes

| Before | After |
|--------|-------|
| `DropdownMenu` component | `Sheet` component |
| Flat list of 16 items | Grouped sections via `NAV_GROUPS` |
| Search + theme in header bar | Search + theme in sheet footer |

## What Stays the Same

- `header.tsx` bar: logo, hamburger position, sticky behavior
- Hamburger icon as the trigger
- `nav-config.ts` untouched — uses existing `NAV_GROUPS`
- Active state detection logic
- `md:hidden` breakpoint (desktop still uses sidebar)

## Files to Modify

1. `src/components/header.tsx` — replace DropdownMenu with Sheet, add grouped nav, move search/theme to sheet footer
