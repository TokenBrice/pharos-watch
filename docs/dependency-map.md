# Dependency Map

## Overview

The dependency map (`/dependency-map`) renders an interactive collateral graph for **up to 50 non-defunct stablecoins by market cap that have at least one live dependency edge (incoming or outgoing)**.

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
- Builds a live dependency edge set from `TRACKED_STABLECOINS` + `deriveDependencies(meta)` (live source and live target only).
- Removes coins with no incoming and no outgoing live dependency edges.
- Sorts remaining coins by market cap descending.
- Takes top `MAX_NODES = 50`, then iteratively prunes coins that are isolated inside the displayed subset and backfills from lower-ranked candidates.
- Node radius uses square-root scaling between `MIN_RADIUS = 10` and `MAX_RADIUS = 34`.

Edges are derived from the live edge set:
- Each dependency edge is included only if both coins are in the selected top-50 set.
- Edge `type` defaults to `"collateral"` when not explicitly provided.

## Adaptive Supernodes

To improve readability in dense graphs, the map computes supernodes dynamically from the currently displayed node+edge set (no hardcoded coin IDs):

- Metrics per node:
  - incoming dependency weight (`inWeight`)
  - incoming edge count (`inDegree`)
  - total edge count (`totalDegree = in + out`)
  - log market cap (`log10(mcap + 1)`)
- Normalization: min-max per metric across displayed nodes.
- Score formula:
  - `0.50*inWeight + 0.25*inDegree + 0.15*totalDegree + 0.10*mcap`

Tiering (with hysteresis):
- Tier 1 (core hubs): enter at P90 + `inDegree >= 2`, stay until below P80.
- Tier 2 (secondary hubs): enter at P75 + (`inDegree >= 1` or `inWeight >= 0.10`), stay until below P65.
- Clamps:
  - Tier 1: min 2, max 3.
  - Tier 2: min 3, max 5.
- Sparse fallback: if edge count < 12, use top 2 by score as Tier 1.

Rendering behavior:
- Layout anchors Tier 1 near center, Tier 2 on an inner ring, remaining nodes on outer rings.
- Edges touching hubs are emphasized; non-hub-to-non-hub edges are dimmed.
- Hub symbols are always labeled for quick orientation.

## Readability Controls

The graph header exposes two runtime controls:

- **Focus mode**:
  - `All`: full graph
  - `Hub dependencies`: only edges touching Tier 1/Tier 2 hubs
  - `Selected neighborhood`: only edges adjacent to a selected coin (picker shown inline)
- **Min edge** (weak-edge compression):
  - `Off`, `3%`, `5%`, `8%`
  - Edges below threshold are hidden unless they touch the hovered node or selected neighborhood node.
  - Nodes display a small `+N` marker for hidden minor links so compressed structure remains discoverable.

## Layout Algorithm

The layout uses `d3-force` with deterministic post-processing:

- Canvas: `WIDTH = 800`, `HEIGHT = 600`, `PAD = 44`.
- Link force: `distance = 100`, `strength = weight * 0.4`.
- Charge: `-200 - r * 4` (larger nodes repel more).
- Collision: `radius = r + 8`, `iterations = 4`.
- Anchoring: `forceX/forceY` toward tier-specific layout targets (core center cluster, secondary inner ring, others outer ring) with tier-dependent strengths.
- Simulation ticks: fixed 300 ticks, then explicit overlap + boundary passes (up to 100 passes).

This keeps layout stable and prevents node clipping at the frame boundary.

## Visual Encoding

Node encoding:
- Outer ring color = report-card grade band (`GRADE_RADAR_COLORS` + `gradeRange()`).
- Node area = relative market cap (via radius scaling).
- Logo is clipped to inner circle; text fallback uses symbol initials when logo is missing.

Edge encoding:
- Width and opacity scale with dependency weight and are boosted for edges touching supernodes.
- Non-hub-to-non-hub edges are intentionally dimmed to reduce clutter.
- Type color/dash:
  - `collateral`: solid slate
  - `mechanism`: amber dashed
  - `wrapper`: violet dotted

## Interaction Model

- **Drag**: nodes are draggable and clamped within padded bounds.
- **Hover node**: highlights connected nodes/edges; shows tooltip (symbol, grade, market cap).
- **Hover edge**: shows tooltip with dependency pair + percentage weight + dependency type.
- **Click node**: in `Selected neighborhood` focus mode, sets the neighborhood root to that node.

## Scope and Limits

- The map is intentionally scoped to the largest 50 live dependency-linked coins for readability.
- Dependencies are metadata/reserve-derived (`deriveDependencies`), not discovered from live on-chain graph traversal.
- Defunct coins are excluded from the graph.
