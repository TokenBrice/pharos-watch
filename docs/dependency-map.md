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
3. `useLogos()` (static `data/logos.json` import) for node logos.

Market-cap map construction lives in `src/app/dependency-map/client.tsx` and uses `sumPegBuckets()` from `shared/lib/supply.ts`.

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

The graph header exposes one runtime control group plus a conditional picker:

- **Focus mode**:
  - `All`: full graph
  - `Hub dependencies`: only edges touching Tier 1/Tier 2 hubs
  - `Selected neighborhood`: only edges adjacent to a selected coin (picker shown inline)
- **Neighborhood coin picker**:
  - Only appears in `Selected neighborhood` mode.
  - Lets the user set the neighborhood focus explicitly; clicking a node in the graph updates the same selection.

The current UI does not expose a separate weak-edge compression or `Min edge` threshold control.

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
- **Hover node**: triggers a contagion ripple effect — see below. Shows tooltip (symbol, grade, market cap).
- **Hover edge**: shows tooltip with dependency pair + percentage weight + dependency type.
- **Click node**: in `Selected neighborhood` focus mode, sets the neighborhood root to that node.

### Contagion Ripple

When a node is hovered, the graph visualizes how stress could propagate through the dependency chain:

- **Direct neighbors** (both upstream collateral and downstream dependents) highlight at distance 1.
- **Downstream contagion** (nodes that depend on the hovered node, transitively) ripples outward up to `MAX_RIPPLE_HOPS = 4` hops via BFS following dependency direction (`tgtId` → `srcId`).
- **Staggered timing**: each hop adds `100ms` of transition delay, creating a visible wave of emphasis radiating from the hovered node.
- **Distance-based fade**: multi-hop nodes and edges receive slightly reduced opacity further from the source, reinforcing the sense of attenuation.
- All non-connected nodes dim to `0.4` opacity; non-connected edges dim to `0.05`.
- CSS transitions (`opacity 200ms`, `stroke-width 160ms`) use `--motion-ease-standard` for smooth, consistent motion.

## Scope and Limits

- The map is intentionally scoped to the largest 50 live dependency-linked coins for readability.
- Dependencies are metadata/reserve-derived (`deriveDependencies`), not discovered from live on-chain graph traversal.
- The live reserve sync feature currently affects the stablecoin detail-page reserve card only. The dependency map still derives links from curated static reserve metadata and manual dependencies.
- Defunct coins are excluded from the graph.
