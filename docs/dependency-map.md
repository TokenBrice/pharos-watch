# Dependency Map

> **Agent navigation**: [Data inputs](#data-inputs) · [Dependency semantics](#dependency-semantics) · [Direct exposure and shared books](#direct-exposure-and-shared-books) · [Exposure mode](#exposure-mode) · [Watershed](#watershed) · [Graph workspace](#graph-workspace-and-readability-controls) · [Detail-page snapshot](#detail-page-snapshot).

## Overview

The dependency map route (`/dependency-map`) presents the canonical Safety Score V9 dependency graph as a force-directed **Network** graph (the default view), an alternate layered **Watershed** diagram on desktop, and ranked upstream hubs with direct dependent exposure. Exposure mode adds structural look-through results and separate offline modeled scenarios; the shared failure domains board displays publication groups and existing priced effects. The same graph component renders a focused, single-asset view inside the Dependency Context section of each stablecoin detail page.

Source entrypoints: `src/app/dependency-map/` owns route composition and authored copy; `src/lib/dependency-watershed/` owns the Watershed model; `src/lib/contagion-layout.ts` owns Network construction/layout. Both views consume the accepted graph and shared exposure semantics, not independent scoring models.

## Data Inputs

The page combines:

1. `useDependencyGraph()` (`GET /api/dependency-graph/v1`) for accepted nodes, canonical dependency edges, and common-mode groups. Its registered `dependencyGraph` descriptor uses 30-minute `staleTime` and 60-minute `refetchInterval`.
2. `useStablecoins()` (`GET /api/stablecoins`) for nullable circulating USD context through `getCirculatingRawOrNull()`.
3. Static `logosById` for token logos.

A held V9 publication is shown with the shared status notice. Missing or invalid V9 data renders unavailable; the page never falls back to V8 or reconstructs dependency edges from a retired card model. The standalone graph takes its edge set only from the slim response's `edges`; it has no static fallback source.

`GET /api/dependency-graph/v1` is the free, no-key slim projection consumed by the standalone map and Exposure mode. Detail pages retain the full V9 report. The endpoint projects only the accepted publication, with generation id, methodology version, evaluation/publication clocks, current or held health, nodes, unchanged published edges, and optional common-mode groups. Nodes carry grade, nullable score, publication-bound supply and clock, shared-book id, role dependencies, and nullable coverage count. Retained v5 data leaves unpublished supply and coverage fields null. Held and stale (past the Safety Score consumer budget) responses use `Cache-Control: no-store` and expose `X-Safety-Score-Status`. Static metadata supplies names and symbols; the separate stablecoins query remains for Explore sizing and explicitly labelled market-cap proxy totals.

Missing market caps remain `null`, never measured zero. Explore nodes without supply use `MIN_RADIUS` and display `mcap n/a`; direct hub USD totals exclude them and disclose the excluded count. If the market-cap query fails, the map client discards its market-cap projection even if cached data exists, keeps the published graph available with default node sizes and unknown Explore USD exposure, and shows a retry notice. Exposure mode retains its separate publication-bound supply source. V9 publication failure without cards renders unavailable; failure with cards retains the graph with a notice.

Exposure availability requires a known supply and a known mapped share on the same contribution. A nonempty set with no measurable contributions displays unavailable, not $0; an observed zero supply or share remains numeric zero. `buildDependencyHubsModel` computes direct and classified-claim availability from the same live edges as its totals (both endpoints present and non-defunct). Hero, hub boards and Network inspection consume those flags; defunct or absent endpoints cannot justify a known subtotal. These decisions use the full live edge set, independently of graph filters and node limits.

Since Safety Score methodology 9.49, variant parents, explicit wrapped-asset claims, and manual non-collateral relationships survive independently of reserve composition. The 9.48 no-revival rule remains in force for reserve weights: wholly unmapped live compositions contribute no reserve-derived edges rather than restoring old curated or manual collateral weights. Compiled dependency facts retain per-slice `rejectionReasons` (`no-match`, `expired`, or reviewed `non-link`) with zero-based `sliceIndex` and live mapping provenance even when a structural edge survives; curated reserve fallback is considered only when no live composition exists.

Dependency derivation no longer defaults a linked reserve row to collateral. A legacy live row with `coinId` but no `depType` may inherit a kind only when the authored reserve rows and adapter identity declarations identify exactly one kind for that same coin id. Otherwise that row's link is withheld with `coinId-without-depType` and counted in `coinIdWithoutDepTypeCount`; other rows and structural relationships remain available. An unmapped live composition still cannot revive curated collateral weights. Cached legacy rows can therefore temporarily lose links until their adapters resync with explicit types, unless unique reviewed-kind inheritance already resolves them.

## Dependency Coverage Audit

Run `npm run audit:coverage -- --domain=dependency-coverage` for the authored registry view, or add `--prod` to compare it with the current public V9 cards, live dependency graph, and stablecoin market-cap ordering. Cards publish `score`; graph edges publish `kind` (`serial` or `basket`) and use a null weight for serial claims. Report-v6 adds relationship and provenance fields while retained v5 publications remain readable.

The report separates graph invariants from curation queues. Self-edges, duplicate edges, cycles, invalid targets, stale reviews, malformed target dispositions, malformed dependency provenance, and missing reviews for dependency-producing live-reserve adapter mappings remain structural failures. The merge gate derives mapping requirements from the static authored graph when report cards are unavailable, so absence of a runtime capture cannot skip mapping coverage. Unlinked reserve slices, unique symbol-delimited active-target matches, sub-1% named exposures, and candidate IDs remain review leads: they can identify missing coverage, but never create an edge automatically. A curator must still establish current claim identity and either a measured basket weight or reviewed serial/mechanism semantics. Eligible assets, zero-balance routes, transformed strategy inputs, LP constituents, and same-symbol collisions are not dependencies by themselves.

This permanent evidence queue is distinct from two existing controls: the static `check:dependency-review-gaps` merge gate and the weekly production structural audit (which fails/alerts its job, not releases). Static-versus-published reconciliation is advisory; a difference is not proof of a missing edge or permission to restore stale weights. Preserve reviewed registries, deliberate non-links, withheld claims, and append-only review history.

Audit `provenance.publication` retains the upstream-validated Safety Score identity, original evaluation/publication clocks, source generations/digests, and publication health; it is `null` when unavailable. `generatedAt` is the audit capture clock and `provenance.checkoutRevision` identifies the capturing checkout. Reconciliation separately records the audit checkout and current comparison checkout plus publication comparison status. Never renew held publication evidence using a newer capture/checkout clock. Legacy missing provenance is unknown; malformed supplied provenance is rejected.

Runtime audit origins come from published edge provenance (`publishedSources`), with `mixed` for multiple known origins and a count of absent origins; unpublished set-level fallback and reserve-share facts stay null. `backingFromLiveReserves` is a separate backing fact and never proves a live dependency mapping. Scoreability follows the consumed serial, basket or role input: technical gaps are `pipeline-gap`, distinct from economic `active-nr`. Known exposure weights remain unchanged. An unavailable-target disposition becomes obsolete only when every referencing graph and role lane is scoreable. Verified published `outside-active-set:<id>` coverage rows also retain unavailable-target references without creating graph edges; unverified, unresolved or active-target rows do not. Published kind checks compare canonical effective dependencies, including variant-parent precedence, rather than overridden reserve slices.

When live inputs are supplied, compare three layers before calling a link missing:

1. authored reserve, variant, and manual relationships;
2. dependency IDs emitted by the admitted live reserve snapshot;
3. serial and basket edges in the accepted V9 publication.

This distinction matters because a live adapter can legitimately supersede stale authored percentages, while a uniquely named active target that remains unlinked or is still described as untracked is a targeted review lead. Role-specific dependencies (`exit-dependency`, `control-operator`, and `oracle-nav`) are scored on cards but are not part of the serial/basket map projection described below.

## Dependency Semantics

V9 dependency edges are serial or basket. Their four-value `materiality` distinguishes serial blockage (`serial-blocked`) and bounded basket uncertainty (`basket-bounded-unknown`) from ordinary serial/basket relationships; it is not a null-score test.

**The map draws two relationships, not four.** `contagionEdgeRelationship()` collapses `materiality` onto `edge.kind`, using the reader-facing vocabulary the methodology page already publishes ("a serial wrapper cannot escape its parent; basket exposure is weighted") and the V8 stroke encoding readers already know:

| V9 `kind` | Legend label | Stroke | Meaning |
| --- | --- | --- | --- |
| `basket` | Collateral | solid slate | Weighted share of backing; risk inherited in proportion |
| `serial` | Wrapper | dotted violet | Full pass-through claim; inherits the upstream's risk in full |

Blockage and bounded uncertainty stay out of the relationship legend. `v9DependencyEdgeScoreKnown()` reads materiality, not `upstreamScore`; its false state adds unavailable/not-rateable copy to tooltips, inspection options and live announcements. A bounded basket can still publish a numeric inherited score, while a serial pipeline gap can have null `upstreamScore` without `serial-blocked`. Known collateral shares remain visible in either case; `upstreamScore` is not the upstream asset's headline Safety Score.

`resolveV9DependencyInput` withholds an inherited score for cycles or unavailable consumed dimensions: serial claims consume final; baskets consume Backing. Serial `blocked` additionally excludes `pipeline-gap`; basket `boundedUnknown` also covers causes C/U even with a numeric score. `buildReportCardsV9DependencyGraph` projects those distinct flags into materiality.

Only `collateral` sets `showWeight`, so only a weighted backing share renders a percentage. A wrapper is a full claim by definition, so a "100%" on one would be noise.

`DEPENDENCY_TYPE_PRESENTATION[type].description` carries the plain-English meaning and is surfaced as the `title` on both the legend swatches and the type-filter pills.

`contagionEdgeWeight()` derives the dimensionless magnitude used for stroke weight and link force. The exposure module uses the same serial/basket share semantics, then multiplies known shares by dependent supply to rank hubs in USD:

- a serial dependency (blocked or not) is full pass-through, weight `1`
- a basket dependency carries its published weight — including when the upstream score is unrateable (`basket-bounded-unknown`): losing the upstream score does not erase a known exposure
- a basket edge whose weight itself is absent (`weight: null`) contributes no magnitude and exerts no link force

An unknown **weight** means the exposure share was never established, so the edge contributes no magnitude. Serial blockage or bounded basket **evidence** does not erase a published share. `v9DependencyEdgeWeight()` returns null only for an absent basket weight; `v9DependencyEdgeScoreKnown()` reads materiality, never weight or score nullability.

Because an edge with no weight models to no magnitude, `contagion-graph-svg.tsx` floors stroke geometry at `MIN_EDGE_DISPLAY_WEIGHT` so the relationship still reads as a drawn edge, and the tooltip omits the percentage rather than showing a misleading `0%`.

Report-v6 edges also publish `dependencyType`, nullable serial `wrapperForm`, and `provenance` with source, evidence date, and an optional bridge, wrapper-token, or vault-share intermediary. The detail-page Used by labels consume `dependencyType`. The map's graph still draws from `kind` and `materiality`, not these richer annotations, while its exposure claim split uses only published edge `wrapperForm`. Edge provenance and intermediary annotations are not currently rendered by the graph tooltip.

## Direct Exposure And Shared Books

`shared/lib/dependency-exposure.ts` owns direct hub exposures and the hero's gross mapped dependent supply. Both use the full published edge set. The hub board ranks known dependent supply multiplied by mapped share; a serial dependent counts once in the hero even when it has multiple parents. Missing supplies and unknown basket shares are excluded from USD sums and reported separately.

The hero, Network inspection, Watershed and hub board share the same availability contract: incomplete measurable totals are labelled **known only**, while all-unknown totals are unavailable. A leaf with no published dependents has zero direct exposure; an empty graph retains the hero's **No mapped dependencies** state. Classified wrapper and vault subtotals likewise preserve unavailable supplies instead of presenting their absent amounts as zero, including in the mobile basin list. Admitted measured shared-book holding replacements remain known evidence; this display contract never changes published weights or the aggregation basis.

The map client carries each published card's `sharedBookId` into `shared/lib/dependency-hubs-model.ts`. Basket contributions from members of one shared book are accumulated once per book and upstream. A supplied measured holding replaces that combined contribution in both the hub and hero totals. Cards from v5 publications with an absent or null `sharedBookId` are not grouped.

The current report publication identifies shared books but does not publish their measured holdings. The map therefore uses the sum of mapped weight multiplied by each member's market-cap-proxy supply. For Sky, DAI and USDS contribute to one combined USDC book amount, rather than each being assigned the whole holding. This fallback is not an exact LitePSM USDC balance: it reconciles to the measured holding only within the Sky adapter's timing and rounding reconciliation band and the difference between group-debt supply and the map's market-cap-proxy supply basis. The hero and board label the market-cap source clock separately from the V9 publication clock.

Sky's adapter attributes verified LitePSM USDC to both DAI and USDS, whose published cards share `sharedBookId`. It does not assign exclusive ownership to either liability. If canonical identity or balance verification fails, `litepsm-attribution-unavailable` is an info-level warning. If measured USDC exceeds group debt beyond the 0.25 percentage-point reconciliation band, `litepsm-reconciliation-excess` is an info-level warning. In either case the classified PSM composition remains available for scoring without a USDC link.

DOLA's adapter publishes LP-secured debt as named `LP-secured debt (undecomposed)` rows without `coinId`. These are not measured constituent holdings and do not create links to the tokens named in the pool; positively measured direct collateral rows remain separate.

### Look-through footprint

The same module exposes `lookThroughShares()` and `exposureFootprint()` for joint-root downstream footprints. Serial parents contribute their greatest upstream share; basket parents contribute the sum of weighted upstream shares; the resulting share is the greater of those two terms. Roots are excluded from downstream rows. Each reached asset appears once with its minimum hop, nullable share, nullable USD exposure, and `scoreUnknown` derived from edge materiality rather than missing supply.

Cycles produce unknown shares and integrity flags. Null-weight basket edges are excluded from share sums and flag incomplete shares; basket sums above 1.000001 remain unclamped and flag integrity. Unavailable supply stays listed but is excluded from USD totals. Bands are material at the policy's 10% threshold, minor at 1%, trace above zero, and unknown for null shares; zero-share rows are omitted. Direct and indirect totals use the full edge set and shared-book reconciliation. Bounded best-first paths default to three per row and never limit totals. These are module semantics, not a transitive loss estimate displayed by the hub board.

## Exposure mode

The graph card switches between **Explore** and **Exposure**. Add upstream roots with **Use as exposure root** in the selected-node rail or mobile list, **Exposure** on a hub row, or the upstream picker. Roots are listed separately and excluded from dependent rows. Shared links use `?mode=exposure&root=<id>` with repeatable `root` parameters.

`useDependencyExposureMode` calls `exposureFootprint(roots, fullEdges, supplyOf, opts)` over the full published edge set. Focus, Type, Limit, and small-link visibility never restrict lookup totals. USD uses only slim-node `circulatingUsdAtEvaluation` with basis `publication-circulating`, not the Explore market-cap proxy. Missing publication-bound supply remains an unknown row and displays **Supply at evaluation not published for this generation**. Malformed identifiable relationships become unknown-share rows rather than invalidating unrelated dependents.

The headline reports **N mapped dependents · direct $X · indirect $Y (includes $Z counted in more than one layer)** beside **Linked coins; not a loss forecast**. Results default to known USD descending, offer a mapped-share sort, and retain unknown values after known values. Counts use the engine's policy bands. The **Unknown supply** filter is reversible; unavailable rows are never removed from the underlying result. Each row has **Inspect path**, which shows bounded top paths and highlights them on the graph, plus a coin-detail action. Roots' published role dependencies appear under **Role dependencies (not drawn)**, and their nullable coverage counts supply the **Known, not in the scored graph** count. Absent coverage means not published, not zero. An empty footprint warns that other dependencies and transmission channels may be missing.

Results identify the publication generation, methodology version, `asOfSec`, and node supply clocks. Same-identity polls retain the computation snapshot; changes to `publicationGenerationId` or per-node `supplyAsOfSec` replace it and show **Network updated. Results now use the latest publication.** Root changes also recompute the lookup. Held results are labeled and retain the accepted publication's supply clock.

URL updates preserve unrelated parameters and Explore's `focus`, `type`, `limit`, and `trace`. Reset removes only `mode` and `root`. Loading a shared URL never opens the fullscreen dialog automatically. Mobile Exposure provides keyboard-operable **Setup**, **Results**, and **Graph** tabs; adding a root selects Results, and closing or resetting restores the initiating control when it remains mounted. Analytics use `dependency_map_action` with `mode_switch`, `root_change`, `share`, and `inspect_path`.

`ContagionGraph` accepts a controlled `exposureOverlay` separately from hover `RippleState`: roots, a row map with `minHop`, band, nullable share/USD, and highlighted paths. Roots and dependents receive halos, unavailable USD receives a hatched halo, and inspected paths are emphasized even when they are small links. The overlay retains isolated roots, prioritizes roots and lower-hop dependents under Limit, fits to the visible footprint, and reports **Showing X of Y linked coins**. Hop reveal follows `minHop` without a four-hop cap; reduced motion shows the final state immediately. Subtle arrowheads remain on in both modes and point upstream, with the legend **Arrows point to the asset a coin depends on**.

The optional `hubExposures?: readonly DependencyHubExposure[]` contract lets the page pass the board's full-graph direct-exposure computation and precomputed `directKnown` flags into the graph for hub tiers and inspection totals. The graph computes the same model itself only when the prop is absent; the map supplies `model.hubs` rather than computing it twice.

The map also summarizes **Known, not in the scored graph** across nodes with non-null published `dependencyCoverageCount`, explicitly identifies partial publication coverage, and links to `/coverage/` with instructions to use the dependency **Gaps** filter. These known relationships remain outside scored graph and exposure totals.

### Offline modeled scenarios

Exposure mode separately reads `GET /api/dependency-scenarios/v1`. Selected roots with stored scenarios offer a scenario selector, stated assumptions, **Published → modeled grade** view, and **Modeled Safety Score change** column. Each choice models one root, not a combined multi-root shock. The offline Node producer uses the production evaluator, including role dependencies, for up to 15 hubs ranked by A1 direct exposure USD from publication-bound supply and published edges, with shared books counted once. Its three D1b shocks are a downstream-consumed final score limit of 40, a 1,000 bps one-day depeg with historical peg and exit facts held fixed, and mint-control compromise.

Stored rows are changed coins plus the upstream root. A missing row means **No modeled change stored**, not a numeric estimate. NR stays NR with no invented score or delta. Modeled provenance names publication generation, artifact age, and the shared 172,800-second (two-day) freshness budget beside **Modeled with the production Safety Score evaluator ... not a forecast**. These artifacts never change canonical cards, journals, or publication identity.

Freshness is `current` only for matching accepted/source generations within budget. `earlier-generation` results can display only with the modeled publication and age explicitly labelled; only this endpoint status claims the accepted publication is newer. A current artifact that differs from the displayed map instead says **The displayed map publication differs from the modeled publication &lt;id&gt;**, without an ordering claim. `stale`, `unavailable`, failed reads, future artifact clocks, and client-side expiration beyond budget withhold numbers. The daily producer interval and two-day budget are owned by `shared/types/dependency-scenarios.ts`; the hook derives daily stale time and two-day refetch and expires cached results at their artifact deadline without waiting for the next fetch.

## Shared Failure Domains Board

`shared-failure-domains-board.tsx` consumes slim `commonModeGroups` and ranks groups with at least two distinct members by known member supply. It prefers publication-bound supply and labels any market-cap fallback per row. Unavailable supply produces a known subtotal with an excluded count or an unavailable state, never zero. The initial ten rows and native disclosure for all remaining groups name full census counts.

Absent groups mean not published; `[]` means a published empty census. Published resolved cap kind/limit and deployment before/after/points are displayed. Unresolved references and `pricedEffectsIncomplete` are separate disclosures. Member totals overlap across groups and must not be added; membership is not a loss estimate or a new score penalty.

## Watershed

**Network** (the force graph) is the default view. The **Watershed** is an opt-in desktop (`md` and up) view; the choice is stored as `view=watershed` and preserves every other parameter, and `view` is omitted for the Network default. Below `md` the map shows the basin list above the Network graph. The detail-page snapshot keeps the force layout.

`buildWatershedModel` (`src/lib/dependency-watershed/model.ts`) is pure and deterministic: the same publication always yields the same layout, whatever the edge order.

The Network component and its d3-force solver load lazily when the Network view (the default) or a genuine Watershed failure fallback mounts. URL defaults live in the solver-free `contagion-graph-constants.ts` module so reading a view choice cannot pull in d3-force. Layout, chunk cancellation and collision limits are unchanged.

- **Inputs:** published nodes and edges only. An edge needs both endpoints published; a malformed share becomes an unknown basket share. USD uses the publication-bound `circulatingUsdAtEvaluation` (the Exposure basis), not the market-cap proxy used by the hero and board.
- **Cycles fail closed.** An iterative Tarjan check runs first. A non-trivial strongly connected component or self-loop returns `{ ok: false, reason: "cycle", members }`, and the route renders the Network view under the notice **Layered view unavailable: the published graph contains a dependency cycle (A → B → A)**. No edge is broken or dropped to force a layering.
- **Columns** are longest-path layers: 0 for a coin with no published upstream, otherwise one more than its deepest upstream. Columns are unlabelled; an **← Upstream / Downstream →** cue sits above the stage. Layers are a structural fact about the published graph, not a risk ordering.
- **Basins:** weakly connected components. The largest basin is drawn; the others render in the **Other basins** strip of hub buttons, so no participant is dropped. Every graph participant appears exactly once: on the canvas, folded under a hub, or in another basin.
- **Hubs and folded dependents:** a coin with at least one dependent is a hub and is always drawn. A coin with no dependents of its own folds into a grey stub on each upstream hub, labelled **N folded leaves · $X (+N unknown)**, which counts only the folded coins, not the hub's direct dependents (the hub tooltip leads with **Direct $X · N dependents**). A dependent with several upstreams folds under each (gross, as the hub board counts it); the legend states how many.
- **Expansion:** each committed Exposure root that is a drawn hub expands its 12 largest folded dependents into drawn coins; the rest stay in a **N more folded leaves** stub.
- **Ordering:** tributary order (grouped under the largest-USD upstream, then hub direct USD, then id), then four weighted barycenter sweeps. The source column (layer 0) stays sorted by direct USD so the largest upstream heads the stage; sweeps move only the downstream columns. Ties keep the previous position, so there is no jitter. Links spanning more than one layer route through waypoints that reserve space in each intermediate column.
- **Ribbon width** is linear in mapped USD (dependent's supply at evaluation × `edgeShare()`), with the scale fixed from the full graph's largest known link so filters and expansion never rescale it. The 1px floor is disclosed in the legend as **Links under $X draw at the 1px minimum**. Linear width keeps each coin's stacked ports additive, which is why the Watershed waives the [non-linear magnitude guidance](./data-visualization.md#encoding). Exact values are in the tooltip and table.
- **Ports are independent stacks.** A coin's left side stacks what it maps upstream; its right side stacks its dependents' mapped supply plus the folded stub. The two measure different things and need not match (USDS maps part of its supply to USDC while carrying more of its dependents' supply downstream). Bar height is not supply. A dependent with two serial parents (`susdc-spark`, `susdt-spark`) stacks two full claims, and the legend names it.
- **Unknown is not zero.** A link with unpublished supply or share draws as a dashed neutral hairline with a `?` cap, counts in **Unknown USD (N links)**, and contributes nothing to USD totals.
- **Printed figures** come only from the shared exposure module: hub figures from `buildDirectHubExposures` (shared books counted once), previews and the committed beam from `computeDependencyExposure`, the same engine as Exposure mode. Geometry is never summed into a printed total.
- **Relationship encoding** reuses the map's two relationships: Collateral solid slate, Wrapper dotted violet (texture as well as hue). The Relationship filter dims non-matching links and never changes totals.

Hovering or focusing a hub previews its downstream footprint and shows **Downstream of X: $Y of mapped dependent supply across N coins**, its direct and indirect totals, and its three largest reached coins. Clicking, Enter or Space pins the hub in place: its downstream links light in the beam colour, everything else dims to 15%, and a fixed-height readout above the stage shows the headline, so the page mode, layout and scroll position do not change. Clicking the pinned hub again, **Clear** or Escape unpins. **Trace exposure →** in the readout is the explicit hand-off to the Exposure workspace's `addRoot`, so the URL, analytics, results panel, Reset and multi-root union are shared with Exposure mode; Other-basin hubs, which are not on the stage, trace directly. The readout repeats **Linked coins; not a loss forecast**. A lit link means "reached through published edges", not "affected". The beam reveal staggers by `minHop`; reduced motion shows the final state. Hubs are `role="button"` inside a `role="group"` SVG with a roving tab stop: Up/Down move within a column, Left/Right move to the strongest drawn upstream or downstream hub, Escape clears the preview and the pin. `dependency_map_action` records `view_switch` (Watershed/Network). The folded-leaves stub is informational; tracing its hub's exposure expands it.

The **Table view** disclosure is always in the DOM and is the equivalent data surface: a sortable hub table (layer, direct USD, indirect USD from the same footprint engine, direct dependents, unknowns) and a sortable link table (upstream, dependent, relationship, wrapper form, share, mapped USD). A provenance line names the publication supply basis, methodology version, publication generation and supply clock (or the earliest-to-latest range when node clocks differ), and flags a held publication. A hub's direct USD prints only when at least one of its links has both known supply and a known share (`hubDirectKnown`); otherwise it reads unavailable, and an incomplete total is marked known only (`≥` on the drawn label).

The mobile basin list (`dependency-map-basin-list.tsx`) ranks every hub by direct mapped dependent supply on the market-cap proxy basis (top eight, then **Show all**), with a linear bar and **n/a** for unknown supply. Expanding a hub shows the hub board's wrapper/vault split, then its publication-basis footprint grouped by hop; **Own dependents ›** re-roots the list with a breadcrumb trail, and **Use as exposure root** hands the hub to the Exposure workspace.

## Graph Construction

`buildGraphData` in `src/lib/contagion-layout.ts`, consumed through `useContagionGraphModel`, retains live published endpoints and graph participants. Market-cap-ranked admission preserves connected pairs rather than stranding endpoints in disconnected ranking windows. Limit selects 50 / 100 / 200 (default) / All; All admits every live participant. Supply controls bounded square-root sizing and canonical grade descriptors control rings; absent supply remains unknown, not zero.

## Dependency Hubs Model And Board

`buildDependencyHubsModel({ cards, edges, mcapMap, marketCapAsOf })` derives one shared desktop/mobile model from published V9 cards and edges whose endpoints are present and non-defunct.

The board is titled **Largest mapped direct exposures** and ranks by known direct USD exposure: dependent market-cap-proxy supply multiplied by mapped share. Ties use direct dependent count, then hub ID. It displays the top six hubs with hub market cap, direct dependent count, wrapper/collateral edge counts, own-family wrapper and vault-claim USD, and the largest direct dependent's share. The model also retains pass-through USD. This is descriptive direct exposure, not a transitive loss estimate or a systemic-risk score.

The hero reports gross mapped dependent supply, upstream hub count, and unique direct dependent count. Its overlap line identifies the mapped fraction counted in more than one dependency layer; it is not subtracted from the gross figure. Serial dependents count once even with multiple parents. Unknown supply and unknown basket shares are disclosed separately, and excessive basket shares raise an integrity warning rather than silently clamping a published total.

Wrapper and vault-claim splits use only the published edge `wrapperForm`. A serial edge without it (every serial edge on a report v5 publication) stays in direct USD totals but cannot be classified. The hero, board and mobile basin list then disclose that exposure's known USD as "split unavailable" and qualify any classified subtotal as covering classified claims only. They never print an unclassified category as $0.00, and own-family figures exclude form-unknown exposure.

Two clocks are explicit: methodology version and V9 publication time, then market-cap source time (or `unknown`). Graph filters and node limits never change these full-graph exposure totals.

## Adaptive Supernodes

Supernodes are computed over the full supplied published graph before node-limit, focus, type or small-link filtering, with no hardcoded coin IDs. `SUPERNODE_CONFIG` in `src/lib/contagion-layout.ts` owns coefficients, percentile thresholds, clamps and sparse fallback. Ranking combines known direct dependent USD exposure, connectivity and market cap; coin ID breaks ties. Tiers are a pure function of the graph, without render-history hysteresis.

Layout anchors Tier 1 near center, Tier 2 on an inner ring, and remaining nodes on outer rings. Edges touching hubs are emphasized and non-hub-to-non-hub edges are dimmed. Hub symbols are always labeled.

## Graph Workspace And Readability Controls

The graph header exposes a single wrapping control row — Focus, Type, Limit, and the trace-coin picker share one line so the controls cost at most two lines above the canvas:

- **Focus mode**: `All` (full graph), `Hubs` (only edges touching Tier 1/Tier 2 hubs; accessible name "Hub dependencies"), `Neighborhood` (only edges adjacent to the selected trace coin; accessible name "Selected neighborhood").
- **Type filter**: `All`, `Collateral`, or `Wrapper`, filtering which edges are drawn while preserving the active focus mode.
- **Node limit toggle**: `50`, `100`, `200` (default), or `All`, using connectivity-aware admission in market-cap order.
- **Trace coin picker**: always visible. The standalone map includes tracked registry coins even when they have no published graph links. Selecting a coin sets the neighborhood root and switches to `Neighborhood`. Clicking a node selects the same trace target without changing the active focus mode. Trace selection is not position pinning: dragging pins a node's coordinates; double-click releases that position, and the header's `Pinned position` control releases all positions without clearing the trace.
- **Selection overlay**: renders when a node is hovered or selected as the trace target, in the top-right of the SVG stage with HUD chrome. It reports full-graph direct dependent exposure in USD, full dependent/upstream counts with visible counts in parentheses, visible examples, and a "Trace neighborhood" action. Unavailable supply and unknown shares are disclosed separately. Focus, Type, Limit, and the small-link toggle do not change its full-graph exposure total.
  Desktop/mobile inspection panels, edge-free exposure roots, and detail snapshots retain partial-evidence qualifications. A null grade reads `Pipeline gap`, never NR; partial grades disclose `Partial evidence: pipeline gap (A/B)` as the tooltip does.

Below `sm`, a neighborhood picker and linked-coin list provide the first inline inspection surface. **Fullscreen graph** opens a dialog with **Graph** and **List** tabs and named **Fit**, **Zoom in**, and **Zoom out** controls. Drag the background to pan, tap a coin to select, and mouse-drag a coin to pin; touch coin gestures do not pin positions. The list, pickers, and named controls provide 44 CSS px minimum alternatives to small canvas targets. The opener is hidden at `sm` and above, and crossing the 640px breakpoint closes the dialog. Only one live graph stage renders at a time, with the shared model retaining interaction state.

Canvas edges with a known share below 0.1% of the dependent's backing are hidden initially. The "N small links hidden" count and toggle expose them; unknown-share links remain drawn. This is a display-only filter: exposure totals, the board, Used by, tooltips, and dependency inspection options retain every edge. The **Inspect dependency** native combobox provides keyboard access to every connection in the current Focus/Type/Limit result, including hidden small links. The polite live region announces inspection details and filter results.

The map hero enables URL synchronization after hydration. `focus` stores `all`, `hub`, or `neighborhood`; `type` stores `all`, `collateral`, or `wrapper`; `limit` stores `50`, `100`, `200`, or `all`; and `trace` stores the selected coin ID. Updates use `history.replaceState`, preserving unrelated query parameters. Initial `?focus=<coinId>` accepts any tracked registry coin and defaults to All nodes unless an explicit valid limit is supplied. A coin with no published graph links retains `focus=<coinId>` and renders a focused empty state, not an unrelated hub. Its published shared failure-domain memberships remain visible; an absent census is explicitly unavailable. This state does not establish an absence of dependencies or risk. Detail snapshots do not synchronize URL state, and their outbound focused map links remain useful for edge-free coins.

Coin identity labels use `src/lib/stablecoin-label.ts`: a symbol shared by multiple tracked registry coins gains its registry name (`symbol (name)`). The rule is independent of the visible graph subset and is shared by graph labels, accessible names, the trace, neighborhood and exposure pickers, inspection details, flow rows, and comparison headings and detail links. Unique symbols remain concise.

The `dependency_map_action` analytics event records changed `focus`, `type`, `limit`, and `trace` values, `fullscreen_open`, and `hub_open_coin` from desktop/mobile hub links. These are inspection interactions, not simulator actions.

## Layout Algorithm

`src/lib/contagion-layout.ts` owns the deterministic `d3-force` solver and geometry constants. Seeded ID-based jitter, never `Math.random()`, makes equal input graphs lay out equally. Explicit overlap/boundary passes are bounded to the top `MAX_COLLISION_PASS_NODES`; the All-view tail keeps collision-force positions rather than incurring unbounded quadratic work.

The same solver runs after render in cancellable idle chunks. A tick is indivisible, so the work budget is not a hard slice deadline. Existing positions remain until replacement lands. Identity uses membership, endpoint/type/rounded-weight topology and detail focus, not market-cap rank, radii or hub tiers: market refreshes preserve layout/pins when topology is unchanged; Focus and Type affect presentation only.

Dragging holds the position snapshot until pointerup/cancel, when pinned coordinates commit, so a settling layout cannot move the drag frame. Auto-fit and **Fit** never magnify above base scale; only **Zoom in** exceeds it, bounded at 4×. The fixed 4:3 stage preserves its aspect independently of viewBox bounds. Fit accounts for legend/clipping obstruction, centering sparse footprints in available space and zooming large ones out; sparse neighborhoods cannot inflate a node to fill the card or hide labels under the legend.

## Detail-Page Snapshot

`ContagionSnapshot` renders the Dependency Context section on `/stablecoin/[id]`. It:

- uses edges touching the current asset with published endpoints to decide whether to show the stage and populate Used by, but passes the full published edge set and all published cards to the graph so full-graph hub tiers and exposure remain consistent;
- lazy-loads the graph with `next/dynamic` (`ssr: false`) behind a loading placeholder;
- passes `focusCoinId`, `minimalChrome`, and a 500-node cap, which drops the header controls and renders only the focus coin's own neighborhood, ringed around it;
- scales nodes up and shows ticker labels when the neighborhood is small: 1.5x at ≤10 visible nodes, 2x at ≤5. `MAX_RASTER_LOGO_RADIUS = 46` in `contagion-graph-svg.tsx` caps the drawn raster image radius; `.svg` logos are exempt. Logos come from static `logosById`, with no minimum raster-source resolution guarantee;
- takes the wider column (`3fr`) when it shares the row with the variant-relationship card or collateral-usage list (`2fr`), and returns `null` when no context disclosure has a row, there is no graph, no supplemental context, and no source error.

The **Used by** list comes from the same published neighborhood edges, selecting `edge.from === stablecoinId` and listing each dependent at `edge.to`; authored reserve names alone never add an entry. Relationship labels use published `dependencyType`. For v5 edges without it, basket means collateral; serial means wrapper only when the dependent's tracked variant parent matches the upstream, otherwise serial claim. Basket shares show `share unknown` for null, `n/a` for zero, `<1%` for positive sub-1% shares, and a percentage otherwise; serial entries omit shares.

The four context disclosures use published data:

- **What depends on me** reports direct dependent count and known direct USD exposure from the shared exposure module over published edges. It weights dependent market caps, identifies the market-cap date when available, and discloses unavailable supply, unknown shares, and integrity warnings.
- **What I depend on** lists published upstream links with relationship type, serial/basket kind, and backing share. Serial claims show "Full claim (100%)". The relationship fallback is the same as Used by.
- **Scored role dependencies (not drawn)** lists `card.dependencies.roles`, including upstream, role, weight, and role score or unavailable status.
- **Known, not in the scored graph** lists `card.dependencyCoverage`, including share, reason, identity verification, and source date. These rows never enter the graph or exposure totals.

Absent role or coverage lists mean not published for this generation, including older retained payloads; empty lists mean no corresponding rows were published. The disclosures render, even without a drawn neighborhood, only when at least one has a row: a direct dependent, an upstream link, a scored role, or a coverage row. Absent and empty lists alone never keep the section visible; a variant card or collateral-usage list still renders without the empty disclosures.

The section links to `/dependency-map/?focus=<coinId>`. Its market-cap map also retains nulls. On either query error it shows a shared retry notice and can retain published neighborhood data; unlike the map-route client, it does not discard cached market caps on a market-cap query error.
