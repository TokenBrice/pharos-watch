# Dependency Map

## Overview

The dependency map (`/dependency-map`) renders an interactive collateral graph for non-defunct stablecoins by market cap that have at least one live dependency edge. The visible node count is user-selectable at **50, 100, 200, or All** via the in-header Limit toggle; default is 50. The `All` option uncaps to the full ranked set.

Primary files:

- `src/app/dependency-map/page.tsx`
- `src/app/dependency-map/client.tsx`
- `src/app/dependency-map/dependency-hubs-model.ts` — shared pure model for desktop and mobile hub summaries
- `src/app/dependency-map/dependency-hubs-board.tsx` — desktop exact-value dependency hub board
- `src/lib/contagion-layout.ts` — graph construction, supernode scoring, simulation, and layout logic
- `src/components/contagion-graph.tsx` — graph shell and shared interaction state
- `src/components/contagion-graph-model.ts` and `src/components/contagion-graph-graph.ts` — pure graph model and graph algorithms
- `src/components/contagion-graph/contagion-graph-body.tsx` — SVG stage rendering and interaction handlers
- `src/components/contagion-graph/use-contagion-graph-model.ts` — ContagionGraph view-model hook
- `src/components/contagion-graph/contagion-graph-shell.tsx` — surrounding graph chrome and controls
- `src/components/contagion-graph/contagion-graph-svg.tsx` — low-level SVG node/link rendering helpers
- `src/components/contagion-graph/contagion-graph-insights.tsx` — Selection overlay rendered on top of the SVG stage
- `src/components/dependency-map-mobile-summary.tsx` — mobile quick-summary companion card

## Data Inputs

The page combines three data sources:

1. `useReportCards()` (`/api/report-cards`) for per-coin grade metadata.
2. `useStablecoins()` (`/api/stablecoins`) for market-cap sizing (`getCirculatingRaw(asset)`).
3. `useLogos()` (static `data/logos.json` import) for node logos.

Market-cap map construction lives in `src/app/dependency-map/client.tsx` and uses `getCirculatingRaw()` from `shared/lib/supply.ts` (which sums the peg buckets of `circulating`).

## Graph Construction

Graph construction logic lives in `src/lib/contagion-layout.ts` (called via `useMemo` from `ContagionGraph`):

- Filters out `isDefunct` report cards.
- Uses `reportData.dependencyGraph?.edges` from `/api/report-cards` as the primary dependency edge source, then filters to live source/target IDs with `filterDependencyGraphEdgesToLive()`.
- `buildGraphData()` falls back to `buildDependencyGraphEdges(CLIENT_ACTIVE_STABLECOINS)` only when `dependencyEdges` is omitted or `undefined`; an explicit empty edge array means “render no dependency edges.”
- The mobile hub summary is built from `reportData.dependencyGraph?.edges ?? []` and does not use the static fallback.
- Removes coins with no incoming and no outgoing live dependency edges.
- Sorts remaining coins by market cap descending.
- Takes the top N coins where N comes from the runtime Limit toggle (50 / 100 / 200 / All; default `DEFAULT_NODE_LIMIT = 50`, and `All` uncaps to the full ranked set), then iteratively prunes coins that are isolated inside the displayed subset and backfills from lower-ranked candidates.
- Node radius uses square-root scaling between `MIN_RADIUS = 10` and `MAX_RADIUS = 34`.

Edges are derived from the report-card edge set:

- Each dependency edge is included only if both coins are in the selected displayed subset after the runtime Limit toggle and isolated-node pruning.
- Edge `type` defaults to `"collateral"` when not explicitly provided.

## Dependency Hubs Model And Board

`buildDependencyHubsModel({ cards, edges, mcapMap })` is the shared model for the desktop Dependency Hubs Board and the mobile summary. It uses the current report-card dependency edge set plus the same stablecoin market-cap map used by the graph.

Model contract:

- `hubs`: ranked upstream hubs from live direct edges.
- `dependentCount`: unique direct dependent count for a hub; duplicate direct edges to the same dependent count once.
- `summedDirectDependencyWeight`: dimensionless sum of all live direct edge weights for a hub; duplicate direct edges still contribute their weights.
- `uniqueDependentMcapUsd`: modeled dependent market-cap context, deduped by direct dependent ID for that hub.
- `hubMcapUsd`: the hub's own market cap, kept separate from modeled dependent market-cap context.
- `examples`: up to three direct dependent examples, sorted by dependent market cap.
- `edgeTypeBreakdown`: direct edge counts and summed direct dependency weight by `collateral`, `mechanism`, and `wrapper`.

Visible board contract:

- Desktop renders the Dependency Hubs Board near the graph under the heading "Direct dependency hubs"; "Upstream hubs" appears as one of its metric tiles.
- The board exposes exact values for upstream hubs, direct dependents, summed direct dependency weight, modeled dependent market-cap context, hub own market cap, examples, and edge type breakdown.
- Mobile consumes the same model and renders the same ranked hub metrics in the `DependencyMapMobileSummary` card below the graph.
- Modeled dependent market-cap context is direct and deduped; it is not a transitive total or forecasted dollar outcome.

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

## Graph Workspace And Readability Controls

The graph renders as a compact full-width workspace inspired by terminal-style dependency explorers: a metric strip, focus / type / limit controls, a trace picker, and the SVG viewport. A floating Selection overlay sits on top of the SVG stage when a node is hovered or pinned. The full exact-value Dependency Hubs Board remains below the graph for deeper review.

The graph header exposes:

- **Focus mode**:
  - `All`: full graph
  - `Hub dependencies`: only edges touching Tier 1/Tier 2 hubs
  - `Selected neighborhood`: only edges adjacent to the selected trace coin
- **Trace coin picker**:
  - Always visible.
  - Selecting a coin sets the neighborhood root and switches to `Selected neighborhood`.
  - Clicking a node pins the same trace target without changing the current focus mode unless the user selects from the picker or the overlay action.
- **Dependency type filter**:
  - `All`: no type filter.
  - `Collateral`, `Mechanism`, and `Wrapper`: show only visible edges of that dependency type while preserving the active focus mode.
- **Node limit toggle**:
  - `50` (default), `100`, `200`, or `All` top-mcap coins enter the map before isolated-node pruning; `All` uncaps to the full ranked set.
- **Selection overlay**:
  - Renders only when a node is actively hovered or pinned (clicked).
  - Sits in the top-right corner of the SVG stage with the HUD chrome (`--graph-panel-bg`, hairline border in `--graph-grid-line`).
  - Surfaces direct dependent count, upstream link count, summed visible dependent/upstream weights, examples, and a "Trace neighborhood" action.
  - The Selection overlay no longer lists Systemic Hubs — that surface is exclusive to the Dependency Hubs Board below the graph.

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

Workspace canvas:

- The SVG stage is a graph-local HUD surface with its own visual tokens: `--graph-canvas-bg`, `--graph-panel-bg`, and `--graph-grid-line`. The tokens live in `src/app/globals.css` and are scoped to the dependency-map workspace — they are not part of the global semantic layer.
- Background uses a 24px CSS gradient grid in `--graph-grid-line`. Border is a 1px hairline in the same color with a 4px radius. No shadow.
- Inner chrome (legend pill) sits on `--graph-panel-bg` with the same hairline border and 4px radius.
- The outer workspace card and the Dependency Hubs Board below it keep the warm system surface ramp; the cold HUD treatment is scoped to the SVG stage only.

Node encoding:

- Outer ring color = report-card grade band (`GRADE_RADAR_COLORS` + `gradeRange()`).
- Node area = relative market cap (via radius scaling).
- Logo is clipped to inner circle; text fallback uses symbol initials when logo is missing.
- In-circle symbol labels use a 10–11px floor when rendered (small labels still respect node radius but never drop below 10px).

Edge encoding:

- Width and opacity scale with dependency weight and are boosted for edges touching supernodes.
- Non-hub-to-non-hub edges are intentionally dimmed to reduce clutter.
- Type color/dash:
  - `collateral`: solid slate
  - `mechanism`: amber dashed
  - `wrapper`: violet dotted

## Interaction Model

- **Drag**: nodes are draggable and clamped within padded bounds. Drop position pins the node permanently for the current session; pinned positions survive focus-mode and edge-type filter changes, and are decorated with a dashed inner ring + `(pinned)` accessibility label. Pinned nodes are session-only — never persisted to URL or `localStorage`.
- **Double-click pinned node**: unpins it.
- **`Pinned · N` chip** in the header strip: appears whenever any node is pinned; clicking it unpins all.
- **Hover node**: triggers a contagion ripple effect — see below. Shows tooltip (symbol, grade, market cap). Connected edges restyle to the brand-blue highlight color (`--p-frost-blue`) at `0.9` opacity and `1.2px` stroke; non-connected nodes dim to `0.25`, non-connected edges to `0.1`.
- **Hover edge**: shows tooltip with dependency pair + percentage weight + dependency type.
- **Click node**: surfaces the node in the Selection overlay and sets it as the pending trace target. In `Selected neighborhood` mode this also retargets the visible neighborhood. A persistent brand-blue halo marks the pinned node when not currently hovered.
- **Drag release**: a drag that moves the node suppresses the follow-up click emitted by the browser, so repositioning a node does not accidentally retarget the selected neighborhood.
- **Click empty canvas**: clears the pinned selection, hover state, and ripple. The Selection overlay hides until the next hover or click.
- **Escape**: clears the pinned selection, hover state, and ripple. Skipped while a text input is focused.
- **Trace picker / rail action**: switches to `Selected neighborhood` and shows the selected coin's direct graph neighborhood.

## Mobile Layout

- The interactive graph renders on all screen sizes, including phones.
- The SVG viewport takes the full width of the workspace at every breakpoint. The Selection overlay floats over the top-right corner of the SVG when active on wider screens.
- On phones, the graph exposes a fullscreen action. The fullscreen dialog renders the same interactive SVG stage with the mobile inspect panel below it, giving selected-node facts and trace actions outside the constrained canvas.
- The non-fullscreen mobile graph keeps inspect details in a panel below the stage instead of forcing the desktop overlay into the narrow viewport.
- The `DependencyMapMobileSummary` card remains below the graph as a quick ranked companion view; it no longer replaces the graph and uses the same `buildDependencyHubsModel()` output as the desktop board.
- Graph controls stack vertically on narrow widths.

### Contagion Ripple

When a node is hovered, the graph visualizes how stress could propagate through the dependency chain:

- **Direct neighbors** (both upstream collateral and downstream dependents) highlight at distance 1.
- **Downstream contagion** (nodes that depend on the hovered node, transitively) ripples outward up to 4 hops (`maxRippleHops` default in `computeRippleState`) via BFS following dependency direction (`tgtId` → `srcId`).
- **Staggered timing**: each hop adds `60ms` of transition delay, creating a visible wave of emphasis radiating from the hovered node.
- **Distance-based fade**: multi-hop nodes and edges receive reduced opacity further from the source. Hop 4 attenuates to `0.55` node opacity and `0.45` edge opacity to keep second-order contagion visible without overwhelming the canvas.
- All non-connected nodes dim to `0.25` opacity; non-connected edges dim to `0.1`.
- Connected edges restyle to the brand-blue highlight color (`--p-frost-blue`) at `0.9` opacity and `1.2px` stroke (hop-4 edges keep their type color so they fade with the ripple tail).
- CSS transitions (`opacity 200ms`, `stroke-width 160ms`, `stroke 200ms`) use `--motion-ease-standard` for smooth, consistent motion.

## Scope and Limits

- The map starts at the largest 50 live dependency-linked coins for readability; the in-header Limit toggle lets users expand to 100, 200, or All when broader exposure context is needed. The d3-force overlap and post-pass collision passes scale O(n²) and remain interactive at 200 nodes.
- Dependencies are snapshot-derived from the same effective dependency resolver used by report-card scoring: score-grade live reserve slices with tracked `coinId` links can replace curated reserve links for that snapshot, unmapped live reserve share remains implicit self-backed / non-stablecoin exposure, and each tracked variant is represented by one serial weight-1 `wrapper` edge to its parent. Self-links and duplicate edges are rejected before graph publication. Static SCCs require review; live-created SCC members fall back to curated/manual sets, and a still-invalid graph rejects the report-card snapshot rather than publishing traversal-order-dependent edges. The map still does not perform live on-chain graph discovery.
- L2BEAT host-chain, layer, category, stage, and risk data can inform metadata review and audit queues, but those fields are chain-route context. They do not create dependency-map graph edges; graph edges remain stablecoin-to-stablecoin relationships from `deriveEffectiveDependencies()` and report-card snapshots.
- Live reserve sync still affects the map only through the report-card snapshot; detail-only, stale, degraded, or non-score-grade reserve feeds do not create graph edges.
- Defunct coins are excluded from the graph.
