# Dependency Map Page — Design

**Date**: 2026-02-26
**Status**: Approved

## Goal

Move the `ContagionGraph` component from the Risk Lab page to its own dedicated `/dependency-map` page to reduce clutter and give the visualization the space it deserves.

## Architecture

### New files

- `src/app/dependency-map/page.tsx` — static page shell (metadata, breadcrumb, Suspense)
- `src/app/dependency-map/client.tsx` — data fetching + `ContagionGraph` render

### Modified files

- `src/app/risk-lab/client.tsx` — remove `<ContagionGraph>` block, add "View Dependency Map →" link
- `src/lib/nav-config.ts` — add Dependency Map entry under "Risk" group (after Portfolio), using `Network` icon

### Unchanged files

- `src/components/contagion-graph.tsx` — no changes, just moved caller

## Data Flow

The new client fetches the same three hooks already used in Risk Lab:
- `useReportCards()` → `cards`
- `useStablecoins()` → build `mcapMap`
- `useLogos()` → `logos`

TanStack Query caches these so there's no redundant network cost when navigating between the two pages.

## Nav Placement

Under "Risk" group, after Portfolio:

```
Risk
  Stability Index
  Risk Lab
  Portfolio
  Dependency Map   ← new
```

## Cross-link

Where `<ContagionGraph>` was in Risk Lab, add a small muted link:
> "Explore the full dependency map →"

This preserves discoverability for existing users.
