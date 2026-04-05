# Collapsible Navigation Redesign

## Problem

The sidebar has 22 configured pages across 4 groups + 5 hidden reference pages. The sidebar is already long enough to scroll on shorter screens, and the page count will keep growing. Five reference pages (Methodology, Coverage, Start Here, API Reference, Changelog) are only reachable via the About page, footer, or Cmd+K — effectively invisible in the primary nav.

## Solution

Collapsible nav groups with persisted state, Info group dissolution, and About promoted to a collapsible parent group with a split click target.

## Group Restructure

The Info group is removed. Its items are redistributed:

| Item | From | To | Rationale |
|------|------|----|-----------|
| Upcoming | Info | Data | Pre-launch stablecoins are tracked data — lifecycle start |
| Cemetery | Info | Data | Failed stablecoins are historical data — lifecycle end |
| Digest | Info | Tools | Daily editorial is a utility you check, like Telegram Alerts |
| About | Info | Own group | Becomes a collapsible group at the sidebar bottom with 5 reference children |

### Final group layout

- **Risk Lab** (3): Stability Index, Safety Scores, Risk-Adjusted Yield
- **Data** (7): Stable per Chain, Liquidity Tracker, Depeg Tracker, Mint/Burn Flows, Blacklist Tracker, Upcoming, Cemetery
- **Tools** (5): Portfolio Audit, Compare, Dependency Map, Telegram Alerts, Digest
- **About** (parent link + 5 children): Methodology, Coverage, Start Here, API Reference, Changelog

## Collapse Mechanics

### Group header toggle

Clicking a group header label (Risk Lab, Data, Tools) toggles its expand/collapse state. A small chevron rotates to indicate state (▶ collapsed, ▼ expanded).

### Collapsed state hint

When a group is collapsed, a subtle `N pages` line appears below the header in muted italic text. This tells users there's content inside without taking significant vertical space.

### About split click target

About is special — it's both a navigable page (`/about`) and a group parent. The interaction is split:

- **Label area** ("About"): navigates to `/about`. Rendered as an underlined link.
- **Chevron area** (▶/▼): toggles the 5 reference children open/closed. Independent of the link.

This is the standard file-explorer / VS Code pattern — familiar and unambiguous.

### Persistence

Each group's expand/collapse state is stored in localStorage under a single key (e.g., `pharos-nav-collapsed`) as a JSON object mapping group keys to booleans. State survives page refreshes and sessions.

### Default state (no localStorage)

First-time visitors see:

- **Risk Lab**: expanded (analytical core, only 3 items)
- **Data**: collapsed (7 items — too long by default)
- **Tools**: collapsed (5 items)
- **About**: collapsed (reference material, not primary workflow)

Defined as a `DEFAULT_EXPANDED` constant in `nav-config.ts`.

### Active group auto-expand

When the current route matches an item inside a collapsed group, that group auto-expands. This ensures the active page's siblings are always visible for context. The user can manually re-collapse it.

### Animation

Expand/collapse uses a smooth height transition (200ms, matching the existing sidebar expand/collapse timing via `--motion-duration-fast` and `--motion-ease-standard`).

## Icon-Only Sidebar

When the sidebar is collapsed to icon-only mode (unpinned), the collapsible group feature does not apply — all item icons remain visible in a flat stack. Group headers are already hidden in this mode. Collapse is purely a labels-mode feature.

## Mobile Drawer

The Sheet drawer uses the same collapsible group behavior:

- Groups render as expandable sections with chevron toggles
- Same default state and localStorage persistence as desktop
- Active group auto-expands on open

**Key mobile difference**: the About split click target is too fiddly for touch (two small adjacent tap targets). Instead, on mobile:

- "About" renders as a standard `MobileNavLink` navigating to `/about`
- Immediately below it, a separate row reading "Methodology, API, Changelog…" with a trailing chevron expands the 5 reference children when tapped
- Both rows have ≥44px touch targets

## Nav Config Changes

### `nav-config.ts`

```
DASHBOARD_NAV_ITEM          — unchanged
NAV_GROUPS                  — 3 groups (Risk Lab, Data, Tools) with redistributed items
ABOUT_NAV_GROUP             — new: { href: "/about", label: "About", icon: Info, children: [...5 reference items] }
DEFAULT_EXPANDED            — new: { "risk-lab": true, data: false, tools: false, about: false }
NAV_ITEMS                   — flat list regenerated from all groups + about (for command palette)
BOTTOM_NAV_ITEMS            — remains empty
```

The `NavGroup` interface gains an optional `key` field (slug for localStorage keys) and the About group gets a new `NavGroupWithLink` type that adds `href` and `icon`.

### Command palette

No changes. It already uses the flat `NAV_ITEMS` list, which will include all pages regardless of sidebar collapse state.

### Footer

No changes. The footer has its own hardcoded link set that independently covers the main pages.

### Breadcrumbs

No changes. About children (e.g., `Dashboard / About / API Reference`) already use FeaturePageShell breadcrumbs that are independent of nav config.

## Files to modify

| File | Change |
|------|--------|
| `src/lib/nav-config.ts` | Restructure groups, add About group, add DEFAULT_EXPANDED, add group keys |
| `src/components/sidebar.tsx` | Add collapsible group rendering with chevron toggle, localStorage persistence, auto-expand logic, height animation, About split-target header variant |
| `src/components/header.tsx` | Add collapsible group rendering to mobile drawer, About mobile treatment with separate expansion row |
| `src/lib/navigation.ts` | Add helper to resolve which group contains a given route (for auto-expand) |

## Out of scope

- Sidebar width changes
- Command palette changes
- Footer navigation changes
- New pages or route changes
- Reordering items within groups (beyond the redistribution)
