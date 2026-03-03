# Dependency Map

## Overview

The dependency map (`/dependency-map`) renders an interactive collateral graph for the **top 50 non-defunct stablecoins by market cap**.

Primary files:
- `src/app/dependency-map/page.tsx`
- `src/app/dependency-map/client.tsx`
- `src/components/contagion-graph.tsx`

## Data Inputs

The page combines three data sources:

1. `useReportCards()` (`/api/report-cards`) for per-coin grade metadata.
2. `useStablecoins()` (`/api/stablecoins`) for market-cap sizing (`sumPegBuckets(circulating)`).
3. `useLogos()` (`/api/logos`) for node logos.

Market-cap map construction lives in `src/app/dependency-map/client.tsx` and uses `sumPegBuckets()` from `src/lib/supply.ts`.

## Graph Construction

Graph construction happens in `ContagionGraph` (`src/components/contagion-graph.tsx`):

- Filters out `isDefunct` report cards.
- Sorts by market cap descending.
- Keeps top `MAX_NODES = 50`.
- Node radius uses square-root scaling between `MIN_RADIUS = 10` and `MAX_RADIUS = 34`.

Edges are derived from `TRACKED_STABLECOINS` + `deriveDependencies(meta)`:
- Each dependency edge is included only if both coins are in the selected top-50 set.
- Edge `type` defaults to `"collateral"` when not explicitly provided.

## Layout Algorithm

The layout uses `d3-force` with deterministic post-processing:

- Canvas: `WIDTH = 800`, `HEIGHT = 600`, `PAD = 44`.
- Link force: `distance = 100`, `strength = weight * 0.4`.
- Charge: `-200 - r * 4` (larger nodes repel more).
- Collision: `radius = r + 8`, `iterations = 4`.
- Centering: `forceX/forceY` toward center with `strength = 0.05`.
- Simulation ticks: fixed 300 ticks, then explicit overlap + boundary passes (up to 100 passes).

This keeps layout stable and prevents node clipping at the frame boundary.

## Visual Encoding

Node encoding:
- Outer ring color = report-card grade band (`GRADE_RADAR_COLORS` + `gradeRange()`).
- Node area = relative market cap (via radius scaling).
- Logo is clipped to inner circle; text fallback uses symbol initials when logo is missing.

Edge encoding:
- Width: `1 + weight * 5`.
- Opacity baseline: `0.15 + weight * 0.45`.
- Type color/dash:
  - `collateral`: solid slate
  - `mechanism`: amber dashed
  - `wrapper`: violet dotted

## Interaction Model

- **Drag**: nodes are draggable and clamped within padded bounds.
- **Hover node**: highlights connected nodes/edges; shows tooltip (symbol, grade, market cap).
- **Hover edge**: shows tooltip with dependency pair + percentage weight + dependency type.
- **Click node**: navigates to `/stablecoin/{id}`.

## Scope and Limits

- The map is intentionally scoped to the largest 50 live coins for readability.
- Dependencies are metadata/reserve-derived (`deriveDependencies`), not discovered from live on-chain graph traversal.
- Defunct coins are excluded from the graph.
