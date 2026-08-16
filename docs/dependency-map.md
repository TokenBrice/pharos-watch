# Dependency Map

## Overview

The dependency map route (`/dependency-map`) presents the canonical Safety Score V9 dependency graph two ways: an interactive force-directed graph of the coins that carry at least one live dependency edge, and ranked upstream hubs with direct dependent exposure. The same graph component renders a focused, single-asset view inside the Dependency Context section of each stablecoin detail page.

Primary files:

- `src/app/dependency-map/page.tsx`
- `src/app/dependency-map/client.tsx`
- `src/app/dependency-map/dependency-hero.tsx` — summary strip plus the full-width graph
- `src/lib/dependency-hubs-model.ts`
- `src/app/dependency-map/dependency-hubs-board.tsx`
- `src/components/dependency-map-mobile-summary.tsx`
- `src/lib/contagion-layout.ts` — graph construction, supernode scoring, simulation, and layout
- `src/components/contagion-graph-root.tsx` — graph shell and shared interaction state
- `src/components/contagion-graph-model.ts` — relationship presentation tokens and grade colors
- `src/components/contagion-graph-graph.ts` — pure visibility, ripple, and navigation algorithms
- `src/components/contagion-graph-tooltips.tsx` — node/edge tooltips and the live-region announcement
- `src/components/contagion-graph/use-contagion-graph-model.ts` — graph view-model hook
- `src/components/contagion-graph/contagion-graph-shell.tsx` — card chrome, header, and mobile fullscreen dialog
- `src/components/contagion-graph/contagion-graph-body.tsx` — stage plus inspection rail composition
- `src/components/contagion-graph/contagion-graph-stage.tsx` — grid canvas, legend, and overlay slots
- `src/components/contagion-graph/contagion-graph-svg.tsx` — low-level SVG node and edge rendering
- `src/components/contagion-graph/contagion-graph-insights.tsx` — Selection overlay
- `src/hooks/use-contagion-graph-drag.ts` — pointer drag and per-node pinning
- `src/components/stablecoin-detail/contagion-snapshot.tsx` — focused per-stablecoin graph

## Data Inputs

The page combines:

1. `useReportCardsV9()` (`GET /api/report-cards/v9`) for current cards and canonical dependency edges.
2. `useStablecoins()` (`GET /api/stablecoins`) for circulating USD context through `getCirculatingRaw()`.
3. `useLogos()` for static token logos.

A held V9 publication is shown with the shared status notice. Missing or invalid V9 data renders unavailable; the page never falls back to V8 or reconstructs dependency edges from a retired card model. The graph takes its edge set only from `dependencyGraph.edges`; it has no static fallback source.

## Dependency Semantics

V9 dependency edges are serial or basket, and each carries a four-value `materiality` that also records whether the upstream score resolved (`serial-blocked`, `basket-bounded-unknown`).

**The map draws two relationships, not four.** `contagionEdgeRelationship()` collapses `materiality` onto `edge.kind`, using the reader-facing vocabulary the methodology page already publishes ("a serial wrapper cannot escape its parent; basket exposure is weighted") and the V8 stroke encoding readers already know:

| V9 `kind` | Legend label | Stroke | Meaning |
| --- | --- | --- | --- |
| `basket` | Collateral | solid slate | Weighted share of backing; risk inherited in proportion |
| `serial` | Wrapper | dotted violet | Full pass-through claim; inherits the upstream's risk in full |

Whether the upstream score resolved is **deliberately discarded here**. It is a data-quality fact, and the detail modules that exist to report it already do. Encoding it in the legend split two relationships into four categories and made the map harder to read for no structural gain — the map's job is showing the relationships.

For reference, that discarded distinction comes from one condition in `resolveV9DependencyInputs` — `cycleBlocked || unavailableDimensions.length > 0` — so an unscored edge means either a circular dependency or an upstream that is itself unrated. Both `blocked` (serial) and `boundedUnknown` (basket) are that same flag.

Only `collateral` sets `showWeight`, so only a weighted backing share renders a percentage. A wrapper is a full claim by definition, so a "100%" on one would be noise.

`DEPENDENCY_TYPE_PRESENTATION[type].description` carries the plain-English meaning and is surfaced as the `title` on both the legend swatches and the type-filter pills.

`contagionEdgeWeight()` derives the dimensionless exposure magnitude used for stroke weight, link force, and hub scoring, matching `buildDependencyHubsModel`:

- a serial dependency (blocked or not) is full pass-through, weight `1`
- a weighted basket dependency carries its published weight
- a bounded-unknown basket dependency contributes `0`

Because a bounded-unknown edge models to `0`, `contagion-graph-svg.tsx` floors stroke geometry at `MIN_EDGE_DISPLAY_WEIGHT` so the relationship still reads as a drawn edge, and the tooltip omits the percentage rather than showing a misleading `0%`.

## Graph Construction

Graph construction lives in `src/lib/contagion-layout.ts` and is called through `useContagionGraphModel`:

- Filters out cards marked `isDefunct`, then keeps only edges whose source and target are both live cards.
- Removes coins with no incoming and no outgoing live dependency edge.
- Sorts remaining coins by market cap descending.
- Takes the top N coins where N comes from the runtime Limit toggle (50 / 100 / 200 / All; default `DEFAULT_NODE_LIMIT = 200`, and `All` uncaps to the full ranked set), then iteratively prunes coins that become isolated inside the displayed subset and backfills from lower-ranked candidates.
- Node radius uses square-root scaling between `MIN_RADIUS = 10` and `MAX_RADIUS = 34`.
- Node ring color comes from the V9 grade band via `v9GradeRange()` and `GRADE_RADAR_COLORS`.

## Dependency Hubs Model And Board

`buildDependencyHubsModel({ cards, edges, mcapMap })` derives one shared desktop/mobile model from live V9 cards and edges.

The model reports:

- ranked upstream hubs
- unique direct dependent count
- summed direct dependency weight
- direct dependent market-cap context, deduplicated per hub
- the hub's own market cap
- up to three direct dependent examples
- direct edge counts and weights per V9 materiality (the hub board keeps the full four-value disposition; only the graph collapses it)

The market-cap figure is descriptive context, not a transitive loss estimate. Duplicate direct edges to the same dependent count once for dependent count and market-cap context, while each edge still contributes to summed relationship weight.

## Adaptive Supernodes

To keep dense graphs readable, the map computes supernodes from the currently displayed node and edge set (no hardcoded coin IDs):

- Metrics per node: incoming dependency weight (`inWeight`), incoming edge count (`inDegree`), total edge count (`totalDegree = in + out`), and log market cap (`log10(mcap + 1)`).
- Normalization: min-max per metric across displayed nodes.
- Score: `0.50*inWeight + 0.25*inDegree + 0.15*totalDegree + 0.10*mcap`.

Tiering (with hysteresis):

- Tier 1 (core hubs): enter at P90 + `inDegree >= 2`, stay until below P80.
- Tier 2 (secondary hubs): enter at P75 + (`inDegree >= 1` or `inWeight >= 0.10`), stay until below P65.
- Clamps: Tier 1 min 2 / max 3; Tier 2 min 3 / max 5.
- Sparse fallback: if edge count < 12, use the top 2 by score as Tier 1.

Layout anchors Tier 1 near center, Tier 2 on an inner ring, and remaining nodes on outer rings. Edges touching hubs are emphasized and non-hub-to-non-hub edges are dimmed. Hub symbols are always labeled.

## Graph Workspace And Readability Controls

The graph header exposes a single wrapping control row — Focus, Type, Limit, and the trace-coin picker share one line so the controls cost at most two lines above the canvas:

- **Focus mode**: `All` (full graph), `Hub dependencies` (only edges touching Tier 1/Tier 2 hubs), `Selected neighborhood` (only edges adjacent to the selected trace coin).
- **Type filter**: `All`, `Collateral`, or `Wrapper`, filtering which edges are drawn while preserving the active focus mode.
- **Node limit toggle**: `50`, `100`, `200` (default), or `All` top-mcap coins enter the map before isolated-node pruning.
- **Trace coin picker**: always visible. Selecting a coin sets the neighborhood root and switches to `Selected neighborhood`. Clicking a node pins the same trace target without changing the active focus mode.
- **Selection overlay**: renders only when a node is hovered or pinned, in the top-right of the SVG stage with the HUD chrome (`--graph-panel-bg`, hairline border in `--graph-grid-line`). It surfaces direct dependent count, upstream link count, summed visible dependent/upstream weights, examples, and a "Trace neighborhood" action. It does not list systemic hubs — that surface belongs to the Dependency Hubs Board.

Below `sm`, a "Fullscreen graph" control opens the same graph inside a dialog for a larger touch canvas, and a compact inspection panel replaces the desktop overlay.

## Layout Algorithm

The layout uses `d3-force` with deterministic post-processing:

- Canvas: `WIDTH = 800`, `HEIGHT = 600`, `PAD = 44`.
- Link force: `distance = 100`, `strength = weight * 0.4`.
- Charge: `-200 - r * 4` (larger nodes repel more).
- Collision: `radius = r + 8`, `iterations = 4`.
- Anchoring: `forceX`/`forceY` toward tier-specific layout targets with tier-dependent strengths.
- Simulation ticks: a fixed 300 ticks, then explicit overlap and boundary passes (up to 100).

The post-simulation overlap pass is O(n²), so it is bounded to the top `MAX_COLLISION_PASS_NODES = 200` ranked nodes. The 50/100/200 limit selections are therefore unaffected, and only the `All` view is capped; its long tail keeps the `forceCollide` positions. Node placement is seeded from `deterministicJitter()` rather than `Math.random()`, so the same input graph always lays out the same way.

## Detail-Page Snapshot

`ContagionSnapshot` renders the Dependency Context section on `/stablecoin/[id]`. It:

- keeps only edges that touch the current asset and whose endpoints are both published V9 cards, so the stage is never empty where the map belongs;
- lazy-loads the graph with `next/dynamic` (`ssr: false`) behind a loading placeholder;
- passes `focusCoinId`, `minimalChrome`, and a 500-node cap, which drops the header controls and renders only the focus coin's own neighborhood, ringed around it;
- scales nodes up and shows ticker labels when the neighborhood is small — 1.5x at ≤10 visible nodes, 2x at ≤5. `MAX_RASTER_LOGO_RADIUS` in `contagion-graph-svg.tsx` caps the drawn image so sparse maps do not aggressively upscale legacy raster assets; vector (`.svg`) logos are exempt and keep filling the node. Dependency-graph raster logos are maintained at 250px or better where an authoritative source is available;
- takes the wider column (`3fr`) when it shares the row with the variant-relationship card or collateral-usage list (`2fr`), and returns `null` when there is no graph, no supplemental context, and no source error.
