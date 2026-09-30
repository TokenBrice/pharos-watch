# Dependency Map

> **Agent navigation**: [Data inputs](#data-inputs) · [Dependency semantics](#dependency-semantics) · [Direct exposure and shared books](#direct-exposure-and-shared-books) · [Exposure mode](#exposure-mode) · [Graph workspace](#graph-workspace-and-readability-controls) · [Detail-page snapshot](#detail-page-snapshot).

## Overview

The dependency map route (`/dependency-map`) presents the canonical Safety Score V9 dependency graph as an interactive force-directed graph and ranked upstream hubs with direct dependent exposure. Exposure mode adds structural look-through results and separate offline modeled scenarios; the shared failure domains board displays publication groups and existing priced effects. The same graph component renders a focused, single-asset view inside the Dependency Context section of each stablecoin detail page.

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

1. `useDependencyGraph()` (`GET /api/dependency-graph/v1`) for accepted nodes, canonical dependency edges, and common-mode groups. Its registered `dependencyGraph` descriptor uses 30-minute `staleTime` and 60-minute `refetchInterval`.
2. `useStablecoins()` (`GET /api/stablecoins`) for nullable circulating USD context through `getCirculatingRawOrNull()`.
3. Static `logosById` for token logos.

A held V9 publication is shown with the shared status notice. Missing or invalid V9 data renders unavailable; the page never falls back to V8 or reconstructs dependency edges from a retired card model. The standalone graph takes its edge set only from the slim response's `edges`; it has no static fallback source.

`GET /api/dependency-graph/v1` is the free, no-key slim projection consumed by the standalone map and Exposure mode. Detail pages retain the full V9 report. The endpoint projects only the accepted publication, with generation id, methodology version, evaluation/publication clocks, current or held health, nodes, unchanged published edges, and optional common-mode groups. Nodes carry grade, nullable score, publication-bound supply and clock, shared-book id, role dependencies, and nullable coverage count. Retained v5 data leaves unpublished supply and coverage fields null. Held responses use `Cache-Control: no-store` and expose `X-Safety-Score-Status`. Static metadata supplies names and symbols; the separate stablecoins query remains for Explore sizing and explicitly labelled market-cap proxy totals.

Missing market caps remain `null`, never measured zero. Explore nodes without supply use `MIN_RADIUS` and display `mcap n/a`; direct hub USD totals exclude them and disclose the excluded count. If the market-cap query fails, the map client discards its market-cap projection even if cached data exists, keeps the published graph available with default node sizes and unknown Explore USD exposure, and shows a retry notice. Exposure mode retains its separate publication-bound supply source. V9 publication failure without cards renders unavailable; failure with cards retains the graph with a notice.

Since Safety Score methodology 9.49, variant parents, explicit wrapped-asset claims, and manual non-collateral relationships survive independently of reserve composition. The 9.48 no-revival rule remains in force for reserve weights: wholly unmapped live compositions contribute no reserve-derived edges rather than restoring old curated or manual collateral weights. Compiled dependency facts retain per-slice `rejectionReasons` (`no-match`, `expired`, or reviewed `non-link`) with zero-based `sliceIndex` and live mapping provenance even when a structural edge survives; curated reserve fallback is considered only when no live composition exists.

Dependency derivation no longer defaults a linked reserve row to collateral. A legacy live row with `coinId` but no `depType` may inherit a kind only when the authored reserve rows and adapter identity declarations identify exactly one kind for that same coin id. Otherwise that row's link is withheld with `coinId-without-depType` and counted in `coinIdWithoutDepTypeCount`; other rows and structural relationships remain available. An unmapped live composition still cannot revive curated collateral weights. Cached legacy rows can therefore temporarily lose links until their adapters resync with explicit types, unless unique reviewed-kind inheritance already resolves them.

## Dependency Coverage Audit

Run `npm run audit:coverage -- --domain=dependency-coverage` for the authored registry view, or add `--prod` to compare it with the current public V9 cards, live dependency graph, and stablecoin market-cap ordering. Cards publish `score`; graph edges publish `kind` (`serial` or `basket`) and use a null weight for serial claims. Report-v6 adds relationship and provenance fields while retained v5 publications remain readable.

The report separates graph invariants from curation queues. Self-edges, duplicate edges, cycles, invalid targets, stale reviews, malformed target dispositions, malformed dependency provenance, and missing reviews for dependency-producing live-reserve adapter mappings remain structural failures. The merge gate derives mapping requirements from the static authored graph when report cards are unavailable, so absence of a runtime capture cannot skip mapping coverage. Unlinked reserve slices, unique symbol-delimited active-target matches, sub-1% named exposures, and candidate IDs remain review leads: they can identify missing coverage, but never create an edge automatically. A curator must still establish current claim identity and either a measured basket weight or reviewed serial/mechanism semantics. Eligible assets, zero-balance routes, transformed strategy inputs, LP constituents, and same-symbol collisions are not dependencies by themselves.

When live inputs are supplied, compare three layers before calling a link missing:

1. authored reserve, variant, and manual relationships;
2. dependency IDs emitted by the admitted live reserve snapshot;
3. serial and basket edges in the accepted V9 publication.

This distinction matters because a live adapter can legitimately supersede stale authored percentages, while a uniquely named active target that remains unlinked or is still described as untracked is a targeted review lead. Role-specific dependencies (`exit-dependency`, `control-operator`, and `oracle-nav`) are scored on cards but are not part of the serial/basket map projection described below.

## Dependency Semantics

V9 dependency edges are serial or basket, and each carries a four-value `materiality` that also records whether the upstream score resolved (`serial-blocked`, `basket-bounded-unknown`).

**The map draws two relationships, not four.** `contagionEdgeRelationship()` collapses `materiality` onto `edge.kind`, using the reader-facing vocabulary the methodology page already publishes ("a serial wrapper cannot escape its parent; basket exposure is weighted") and the V8 stroke encoding readers already know:

| V9 `kind` | Legend label | Stroke | Meaning |
| --- | --- | --- | --- |
| `basket` | Collateral | solid slate | Weighted share of backing; risk inherited in proportion |
| `serial` | Wrapper | dotted violet | Full pass-through claim; inherits the upstream's risk in full |

Whether the upstream score resolved stays out of the legend because it is a data-quality fact, not another relationship. Resolved links preserve `scoreKnown` from `v9DependencyEdgeScoreKnown`; edge tooltips, dependency inspection options, and live announcements mark an upstream not rateable when it is false. Known collateral shares remain visible regardless of score availability. Edge `upstreamScore` is not presented as the upstream asset's headline Safety Score.

For reference, that distinction comes from one condition in `resolveV9DependencyInputs` — `cycleBlocked || unavailableDimensions.length > 0` — so an unscored edge means either a circular dependency or an upstream that is itself unrated. Both `blocked` (serial) and `boundedUnknown` (basket) are that same flag.

Only `collateral` sets `showWeight`, so only a weighted backing share renders a percentage. A wrapper is a full claim by definition, so a "100%" on one would be noise.

`DEPENDENCY_TYPE_PRESENTATION[type].description` carries the plain-English meaning and is surfaced as the `title` on both the legend swatches and the type-filter pills.

`contagionEdgeWeight()` derives the dimensionless magnitude used for stroke weight and link force. The exposure module uses the same serial/basket share semantics, then multiplies known shares by dependent supply to rank hubs in USD:

- a serial dependency (blocked or not) is full pass-through, weight `1`
- a basket dependency carries its published weight — including when the upstream score is unrateable (`basket-bounded-unknown`): losing the upstream score does not erase a known exposure
- a basket edge whose weight itself is absent (`weight: null`) contributes no magnitude and exerts no link force

Two different unknowns must not be conflated here. An unknown **weight** means the exposure share was never established, so the edge contributes no magnitude anywhere. An unrateable upstream **score** (`serial-blocked`, `basket-bounded-unknown` in `materiality`) means the upstream could not be scored; the exposure weight is whatever was published, and the simulation keeps it. `v9DependencyEdgeWeight()` returns `null` only for the first case and `v9DependencyEdgeScoreKnown()` reads `materiality` — never the weight — for the second.

Because an edge with no weight models to no magnitude, `contagion-graph-svg.tsx` floors stroke geometry at `MIN_EDGE_DISPLAY_WEIGHT` so the relationship still reads as a drawn edge, and the tooltip omits the percentage rather than showing a misleading `0%`.

Report-v6 edges also publish `dependencyType`, nullable serial `wrapperForm`, and `provenance` with source, evidence date, and an optional bridge, wrapper-token, or vault-share intermediary. The detail-page Used by labels consume `dependencyType`. The map's graph still draws from `kind` and `materiality`, not these richer annotations, while its exposure claim split uses only published edge `wrapperForm`. Edge provenance and intermediary annotations are not currently rendered by the graph tooltip.

## Direct Exposure And Shared Books

`shared/lib/dependency-exposure.ts` owns direct hub exposures and the hero's gross mapped dependent supply. Both use the full published edge set. The hub board ranks known dependent supply multiplied by mapped share; a serial dependent counts once in the hero even when it has multiple parents. Missing supplies and unknown basket shares are excluded from USD sums and reported separately.

The map client carries each published card's `sharedBookId` into `src/lib/dependency-hubs-model.ts`. Basket contributions from members of one shared book are accumulated once per book and upstream. A supplied measured holding replaces that combined contribution in both the hub and hero totals. Cards from v5 publications with an absent or null `sharedBookId` are not grouped.

The current report publication identifies shared books but does not publish their measured holdings. The map therefore uses the sum of mapped weight multiplied by each member's market-cap-proxy supply. For Sky, DAI and USDS contribute to one combined USDC book amount, rather than each being assigned the whole holding. This fallback is not an exact LitePSM USDC balance: it reconciles to the measured holding only within the Sky adapter's timing and rounding reconciliation band and the difference between group-debt supply and the map's market-cap-proxy supply basis. The hero and board label the market-cap source clock separately from the V9 publication clock.

Sky's adapter attributes verified LitePSM USDC to both DAI and USDS, whose published cards share `sharedBookId`. It does not assign exclusive ownership to either liability. If canonical identity or balance verification fails, `litepsm-attribution-unavailable` is an info-level warning. If measured USDC exceeds group debt beyond the 0.25 percentage-point reconciliation band, `litepsm-reconciliation-excess` is an info-level warning. In either case the classified PSM composition remains available for scoring without a USDC link.

DOLA's adapter publishes LP-secured debt as named `LP-secured debt (undecomposed)` rows without `coinId`. These are not measured constituent holdings and do not create links to the tokens named in the pool; positively measured direct collateral rows remain separate.

### Look-through footprint

The same module exposes `lookThroughShares()` and `exposureFootprint()` for joint-root downstream footprints. Serial parents contribute their greatest upstream share; basket parents contribute the sum of weighted upstream shares; the resulting share is the greater of those two terms. Roots are excluded from downstream rows. Each reached asset appears once with its minimum hop, nullable share, nullable USD exposure, and `scoreUnknown` derived from edge materiality rather than missing supply.

Cycles produce unknown shares and integrity flags. Null-weight basket edges are excluded from share sums and flag incomplete shares; basket sums above 1.000001 remain unclamped and flag integrity. Unavailable supply stays listed but is excluded from USD totals. Bands are material at the policy's 10% threshold, minor at 1%, trace above zero, and unknown for null or zero shares. Direct and indirect totals use the full edge set and the shared-book reconciliation path. Bounded best-first paths default to three per row and never limit totals. These are module semantics, not a transitive loss estimate displayed by the hub board.

## Exposure mode

The graph card switches between **Explore** and **Exposure**. Add upstream roots with **Use as exposure root** in the selected-node rail or mobile list, **Exposure** on a hub row, or the upstream picker. Roots are listed separately and excluded from dependent rows. Shared links use `?mode=exposure&root=<id>` with repeatable `root` parameters.

`useDependencyExposureMode` calls `exposureFootprint(roots, fullEdges, supplyOf, opts)` over the full published edge set. Focus, Type, Limit, and small-link visibility never restrict lookup totals. USD uses only slim-node `circulatingUsdAtEvaluation` with basis `publication-circulating`, not the Explore market-cap proxy. Missing publication-bound supply remains an unknown row and displays **Supply at evaluation not published for this generation**. Malformed identifiable relationships become unknown-share rows rather than invalidating unrelated dependents.

The headline reports **N mapped dependents · direct $X · indirect $Y (includes $Z counted in more than one layer)** beside **Linked coins; not a loss forecast**. Results default to known USD descending, offer a mapped-share sort, and retain unknown values after known values. Counts use the engine's policy bands. The **Unknown supply** filter is reversible; unavailable rows are never removed from the underlying result. Each row has **Inspect path**, which shows bounded top paths and highlights them on the graph, plus a coin-detail action. Roots' published role dependencies appear under **Role dependencies (not drawn)**, and their nullable coverage counts supply the **Known, not in the scored graph** count. Absent coverage means not published, not zero. An empty footprint warns that other dependencies and transmission channels may be missing.

Results identify the publication generation, methodology version, `asOfSec`, and node supply clocks. Same-identity polls retain the computation snapshot; changes to `publicationGenerationId` or per-node `supplyAsOfSec` replace it and show **Network updated. Results now use the latest publication.** Root changes also recompute the lookup. Held results are labeled and retain the accepted publication's supply clock.

URL updates preserve unrelated parameters and Explore's `focus`, `type`, `limit`, and `trace`. Reset removes only `mode` and `root`. Loading a shared URL never opens the fullscreen dialog automatically. Mobile Exposure provides keyboard-operable **Setup**, **Results**, and **Graph** tabs; adding a root selects Results, and closing or resetting restores the initiating control when it remains mounted. Analytics use `dependency_map_action` with `mode_switch`, `root_change`, `share`, and `inspect_path`.

`ContagionGraph` accepts a controlled `exposureOverlay` separately from hover `RippleState`: roots, a row map with `minHop`, band, nullable share/USD, and highlighted paths. Roots and dependents receive halos, unavailable USD receives a hatched halo, and inspected paths are emphasized even when they are small links. The overlay retains isolated roots, prioritizes roots and lower-hop dependents under Limit, fits to the visible footprint, and reports **Showing X of Y linked coins**. Hop reveal follows `minHop` without a four-hop cap; reduced motion shows the final state immediately. Subtle arrowheads remain on in both modes and point upstream, with the legend **Arrows point to the asset a coin depends on**.

The optional `hubExposures?: readonly HubExposure[]` contract lets the page pass the board's full-graph direct-exposure computation into the graph for hub tiers and inspection totals. The graph computes the same model itself only when the prop is absent; the map supplies `model.hubs` rather than computing it twice.

The map also summarizes **Known, not in the scored graph** across nodes with non-null published `dependencyCoverageCount`, explicitly identifies partial publication coverage, and links to `/coverage/` with instructions to use the dependency **Gaps** filter. These known relationships remain outside scored graph and exposure totals.

### Offline modeled scenarios

Exposure mode separately reads `GET /api/dependency-scenarios/v1`. Selected roots with stored scenarios offer a scenario selector, stated assumptions, **Published → modeled grade** view, and **Modeled Safety Score change** column. Each choice models one root, not a combined multi-root shock. The offline Node producer uses the production evaluator, including role dependencies, for up to 15 hubs ranked by A1 direct exposure USD from publication-bound supply and published edges, with shared books counted once. Its three D1b shocks are a downstream-consumed final score limit of 40, a 1,000 bps one-day depeg with historical peg and exit facts held fixed, and mint-control compromise.

Stored rows are changed coins plus the upstream root. A missing row means **No modeled change stored**, not a numeric estimate. NR stays NR with no invented score or delta. Modeled provenance names publication generation, artifact age, and the shared 7,200-second freshness budget beside **Modeled with the production Safety Score evaluator ... not a forecast**. These artifacts never change canonical cards, journals, or publication identity.

Freshness is `current` only for matching accepted/source generations within budget. `earlier-generation` results can display only with the modeled publication and age explicitly labelled; only this endpoint status claims the accepted publication is newer. A current artifact that differs from the displayed map instead says **The displayed map publication differs from the modeled publication &lt;id&gt;**, without an ordering claim. `stale`, `unavailable`, failed reads, future artifact clocks, and client-side expiration beyond budget withhold numbers. The hook uses hourly stale time and two-hour refetch, and expires cached results at their artifact deadline without waiting for the next fetch.

## Shared Failure Domains Board

`shared-failure-domains-board.tsx` consumes slim `commonModeGroups` and ranks groups with at least two distinct members by known member supply. It prefers publication-bound supply and labels any market-cap fallback per row. Unavailable supply produces a known subtotal with an excluded count or an unavailable state, never zero. The initial ten rows and native disclosure for all remaining groups name full census counts.

Absent groups mean not published; `[]` means a published empty census. Published resolved cap kind/limit and deployment before/after/points are displayed. Unresolved references and `pricedEffectsIncomplete` are separate disclosures. Member totals overlap across groups and must not be added; membership is not a loss estimate or a new score penalty.

## Graph Construction

Graph construction lives in `src/lib/contagion-layout.ts` and is called through `useContagionGraphModel`:

- Filters out cards marked `isDefunct`, then keeps only edges whose source and target are both live cards.
- Removes coins with no incoming and no outgoing live dependency edge.
- Sorts remaining coins by market cap descending.
- Admits each ranked coin when it connects to an admitted coin, or seeds a new component with that coin and its highest-ranked neighbor when two slots remain. This preserves connected pairs in disconnected ranking windows instead of pruning and permanently skipping their endpoints. `buildGraphData` defaults to `DEFAULT_NODE_LIMIT = 200`; the runtime Limit toggle selects 50 / 100 / 200 / All, and All admits every live graph participant.
- Node radius uses square-root scaling between `MIN_RADIUS = 10` and `MAX_RADIUS = 34`.
- Node ring color comes from the canonical grade band via `gradeRange()` in `shared/lib/report-card-core.ts` and `GRADE_RADAR_COLORS` in `shared/lib/classification`.

## Dependency Hubs Model And Board

`buildDependencyHubsModel({ cards, edges, mcapMap, marketCapAsOf })` derives one shared desktop/mobile model from published V9 cards and edges whose endpoints are present and non-defunct.

The board is titled **Largest mapped direct exposures** and ranks by known direct USD exposure: dependent market-cap-proxy supply multiplied by mapped share. Ties use direct dependent count, then hub ID. It displays the top six hubs with hub market cap, direct dependent count, wrapper/collateral edge counts, own-family wrapper and vault-claim USD, and the largest direct dependent's share. The model also retains pass-through USD. This is descriptive direct exposure, not a transitive loss estimate or a systemic-risk score.

The hero reports gross mapped dependent supply, upstream hub count, and unique direct dependent count. Its overlap line identifies the mapped fraction counted in more than one dependency layer; it is not subtracted from the gross figure. Serial dependents count once even with multiple parents. Unknown supply and unknown basket shares are disclosed separately, and excessive basket shares raise an integrity warning rather than silently clamping a published total.

Wrapper and vault-claim splits use only the published edge `wrapperForm`. A serial edge without it (every serial edge on a report v5 publication) stays in direct USD totals but cannot be classified. The hero, board and mobile summary then disclose that exposure's known USD as "split unavailable" and qualify any classified subtotal as covering classified claims only. They never print an unclassified category as $0.00, and own-family figures exclude form-unknown exposure.

Two clocks are explicit: methodology version and V9 publication time, then market-cap source time (or `unknown`). Graph filters and node limits never change these full-graph exposure totals.

## Adaptive Supernodes

Supernodes are computed over the full supplied published graph before node-limit, focus, type, and small-link display filtering, with no hardcoded coin IDs:

- Metrics per node: `inWeight = log10(1 + known direct dependent exposure USD)` from the shared direct-exposure model, incoming edge count (`inDegree`), total edge count (`totalDegree = in + out`), and `log10(1 + market cap)`.
- Normalization: min-max per metric over the full graph.
- Score: `0.50*inWeight + 0.25*inDegree + 0.15*totalDegree + 0.10*mcap`.

Tiers are a pure function of that graph, with coin ID breaking score ties and no render-history hysteresis:

- Tier 1 (core hubs): P90 + `inDegree >= 2`.
- Tier 2 (secondary hubs): P75 + (`inDegree >= 1` or `inWeight >= 0.10`).
- Clamps: Tier 1 min 2 / max 3; Tier 2 min 3 / max 5.
- Sparse fallback: if edge count < 12, use the top 2 by score as Tier 1.

Layout anchors Tier 1 near center, Tier 2 on an inner ring, and remaining nodes on outer rings. Edges touching hubs are emphasized and non-hub-to-non-hub edges are dimmed. Hub symbols are always labeled.

## Graph Workspace And Readability Controls

The graph header exposes a single wrapping control row — Focus, Type, Limit, and the trace-coin picker share one line so the controls cost at most two lines above the canvas:

- **Focus mode**: `All` (full graph), `Hubs` (only edges touching Tier 1/Tier 2 hubs; accessible name "Hub dependencies"), `Neighborhood` (only edges adjacent to the selected trace coin; accessible name "Selected neighborhood").
- **Type filter**: `All`, `Collateral`, or `Wrapper`, filtering which edges are drawn while preserving the active focus mode.
- **Node limit toggle**: `50`, `100`, `200` (default), or `All`, using connectivity-aware admission in market-cap order.
- **Trace coin picker**: always visible. Selecting a coin sets the neighborhood root and switches to `Neighborhood`. Clicking a node selects the same trace target without changing the active focus mode. Trace selection is not position pinning: dragging pins a node's coordinates; double-click releases that position, and the header's `Pinned position` control releases all positions without clearing the trace.
- **Selection overlay**: renders when a node is hovered or selected as the trace target, in the top-right of the SVG stage with HUD chrome. It reports full-graph direct dependent exposure in USD, full dependent/upstream counts with visible counts in parentheses, visible examples, and a "Trace neighborhood" action. Unavailable supply and unknown shares are disclosed separately. Focus, Type, Limit, and the small-link toggle do not change its full-graph exposure total.

Below `sm`, a neighborhood picker and linked-coin list provide the first inline inspection surface. **Fullscreen graph** opens a dialog with **Graph** and **List** tabs and named **Fit**, **Zoom in**, and **Zoom out** controls. Drag the background to pan, tap a coin to select, and mouse-drag a coin to pin; touch coin gestures do not pin positions. The list, pickers, and named controls provide 44 CSS px minimum alternatives to small canvas targets. The opener is hidden at `sm` and above, and crossing the 640px breakpoint closes the dialog. Only one live graph stage renders at a time, with the shared model retaining interaction state.

Canvas edges with a known share below 0.1% of the dependent's backing are hidden initially. The "N small links hidden" count and toggle expose them; unknown-share links remain drawn. This is a display-only filter: exposure totals, the board, Used by, tooltips, and dependency inspection options retain every edge. The **Inspect dependency** native combobox provides keyboard access to every connection in the current Focus/Type/Limit result, including hidden small links. The polite live region announces inspection details and filter results.

The map hero enables URL synchronization after hydration. `focus` stores `all`, `hub`, or `neighborhood`; `type` stores `all`, `collateral`, or `wrapper`; `limit` stores `50`, `100`, `200`, or `all`; and `trace` stores the selected coin ID. Updates use `history.replaceState`, preserving unrelated query parameters. Initial `?focus=<coinId>` selects a dependency-linked published coin in Neighborhood mode and defaults to All nodes unless an explicit valid limit is supplied. Detail snapshots do not synchronize URL state.

The `dependency_map_action` analytics event records changed `focus`, `type`, `limit`, and `trace` values, `fullscreen_open`, and `hub_open_coin` from desktop/mobile hub links. These are inspection interactions, not simulator actions.

## Layout Algorithm

The layout uses `d3-force` with deterministic post-processing:

- Canvas: `WIDTH = 800`, `HEIGHT = 600`, `PAD = 44`.
- Link force: `distance = 100`, `strength = weight * 0.4`.
- Charge: `-200 - r * 4` (larger nodes repel more).
- Collision: `radius = r + 8`, `iterations = 4`.
- Anchoring: `forceX`/`forceY` toward tier-specific layout targets with tier-dependent strengths.
- Simulation ticks: a fixed 300 ticks, then explicit overlap and boundary passes (up to 100).

The post-simulation overlap pass is O(n²), so it is bounded to the top `MAX_COLLISION_PASS_NODES = 200` ranked nodes. The 50/100/200 limit selections are therefore unaffected, and only the `All` view is capped; its long tail keeps the `forceCollide` positions. Node placement is seeded from `deterministicJitter()` rather than `Math.random()`, so the same input graph always lays out the same way.

The runtime invokes this same solver after render in cancellable idle chunks with an 8 ms work budget, using `requestIdleCallback` with a `setTimeout` fallback. A solver tick is indivisible, so the budget is not a hard upper bound on individual slices. Previous positions remain until the new layout lands; new nodes use layout targets meanwhile. The layout identity combines sorted membership, sorted endpoint/type/rounded-weight signatures, and the detail focus id, not market-cap rank, radii, or hub tiers. Unchanged membership/topology preserves layout and pins across market-cap refreshes; Focus and Type only affect presentation.

SVG nodes and edges are memoized by per-item presentation. Dragging updates node transforms, logo clips, and incident arrow geometry directly; pinned coordinates commit on pointer release rather than on every pointer move. During an active node drag, the position snapshot is held until pointerup/cancel so settled layout coordinates cannot move the drag frame.

## Detail-Page Snapshot

`ContagionSnapshot` renders the Dependency Context section on `/stablecoin/[id]`. It:

- uses edges touching the current asset with published endpoints to decide whether to show the stage and populate Used by, but passes the full published edge set and all published cards to the graph so full-graph hub tiers and exposure remain consistent;
- lazy-loads the graph with `next/dynamic` (`ssr: false`) behind a loading placeholder;
- passes `focusCoinId`, `minimalChrome`, and a 500-node cap, which drops the header controls and renders only the focus coin's own neighborhood, ringed around it;
- scales nodes up and shows ticker labels when the neighborhood is small: 1.5x at ≤10 visible nodes, 2x at ≤5. `MAX_RASTER_LOGO_RADIUS = 46` in `contagion-graph-svg.tsx` caps the drawn raster image radius; `.svg` logos are exempt. Logos come from static `logosById`, with no minimum raster-source resolution guarantee;
- takes the wider column (`3fr`) when it shares the row with the variant-relationship card or collateral-usage list (`2fr`), and returns `null` only when there is no focus card, no graph, no supplemental context, and no source error.

The **Used by** list comes from the same published neighborhood edges, selecting `edge.from === stablecoinId` and listing each dependent at `edge.to`; authored reserve names alone never add an entry. Relationship labels use published `dependencyType`. For v5 edges without it, basket means collateral; serial means wrapper only when the dependent's tracked variant parent matches the upstream, otherwise serial claim. Basket shares show `share unknown` for null, `n/a` for zero, `<1%` for positive sub-1% shares, and a percentage otherwise; serial entries omit shares.

The four context disclosures use published data:

- **What depends on me** reports direct dependent count and known direct USD exposure from the shared exposure module over published edges. It weights dependent market caps, identifies the market-cap date when available, and discloses unavailable supply, unknown shares, and integrity warnings.
- **What I depend on** lists published upstream links with relationship type, serial/basket kind, and backing share. Serial claims show "Full claim (100%)". The relationship fallback is the same as Used by.
- **Scored role dependencies (not drawn)** lists `card.dependencies.roles`, including upstream, role, weight, and role score or unavailable status.
- **Known, not in the scored graph** lists `card.dependencyCoverage`, including share, reason, identity verification, and source date. These rows never enter the graph or exposure totals.

Absent role or coverage lists mean not published for this generation, including older retained payloads; empty lists mean no corresponding rows were published. The section can therefore render its disclosures even without a drawn neighborhood.

The section links to `/dependency-map/?focus=<coinId>`. Its market-cap map also retains nulls. On either query error it shows a shared retry notice and can retain published neighborhood data; unlike the map-route client, it does not discard cached market caps on a market-cap query error.
