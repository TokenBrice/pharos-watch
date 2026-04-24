# Liquidity Exit Route Visual Metaphor Plan

Date: 2026-04-24

## Problem

The current `Exit Route Map` reads like a polished table. It says "doors" and "lanes", but its form is two sorted bar lists plus metric cards. The shape does not carry the metaphor:

- Protocols do not look like doors, gates, or venues.
- Chains do not look like lanes or paths.
- Crowding is only a number, not visible route convergence.
- Pool balance and organic volume are detached KPI cards, not route qualities.
- The viewer cannot see whether exit capacity is broad, bottlenecked, or concentrated without reading labels.

The data model is already good enough for a first visual pass. `buildLiquidityExitRouteModel()` exposes protocol routes, chain routes, top protocol/chain, total TVL, total 24h volume, pool count, HHI, pool balance, and organic percentage. The first implementation should keep that seam and replace the rendering, not rewrite the liquidity pipeline.

## Existing Data Seams

- `src/components/liquidity-stats.tsx`
  - `LiquidityExitRouteItem`: `key`, `label`, `valueUsd`, `sharePct`, `colorClass`.
  - `LiquidityExitRouteModel`: protocol routes, chain routes, counts, HHI, balance, organic, interpretation.
  - `buildLiquidityExitRouteModel()`: already aggregates top routes plus `Other routes` using total DEX TVL as denominator.
  - `LiquidityExitRouteMap()`: current render target to replace.
- `src/components/__tests__/liquidity-stats.test.ts`
  - Already covers model derivation, denominator behavior, tail route aggregation, and basic map rendering.
- `src/app/liquidity/client.tsx`
  - Uses global deduped DEX row for route TVL/volume, then passes `stats` and `liquidityMap` to `LiquidityStats`.

## Design Goals

1. Make route topology visible before text: broad exits should look like many open paths; concentrated exits should look like a bottleneck.
2. Preserve exact financial reading: labels, TVL, shares, route counts, HHI, balance, and organic percentage stay present.
3. Avoid decorative nautical repetition. `/chains/` owns harbors and boats; liquidity should be about exits, corridors, venue gates, and flow.
4. Use current data only for the first pass. No new API fields, no pool-level map, no route simulation.
5. Keep the rendering deterministic and testable with SVG/HTML, not canvas.

## Option A: Transit Hub Route Diagram

Metaphor: the stablecoin market is a terminal. Liquidity flows from a central "Exit TVL" concourse through protocol gates, then fans into chain lanes.

Visual form:

- Left side: protocol gates as vertical portal blocks sized by `protocolRoutes.sharePct`.
- Center: an exit concourse node sized by `totalTvlUsd`, with HHI shown as how tight or wide the waist is.
- Right side: chain lanes as horizontal outbound tracks sized by `chainRoutes.sharePct`.
- Curved SVG bands connect gates to the center and center to lanes.
- `Other routes` becomes a deliberately diffuse service corridor, visually separate but still present.

Encoding:

- Gate height / lane stroke width = route share.
- Band opacity or width = route share.
- Center waist width = route diversity: low HHI is wide, high HHI narrows into a pinch.
- Pool balance = route surface quality: balanced routes get even strokes; low balance gets striped/segmented strokes.
- Organic percentage = solid vs dashed flow: more organic means more solid, less organic means more dashed/incentive-tinted.
- Total 24h volume = animated or static flow ticks along bands, disabled under reduced motion.

Pros:

- Strongest literal fit for "exit routes".
- Encodes protocol and chain dimensions simultaneously.
- HHI becomes visible as topology, not just a metric card.
- Easy to keep labels and exact values around the diagram.

Cons:

- Protocol-to-chain connection is aggregate-to-aggregate, not a true bipartite pool map. The UI must avoid implying exact protocol-chain pair weights unless the data exists.
- Needs careful layout at mobile widths.

Recommendation: best first implementation.

## Option B: Evacuation Corridor / Door Plan

Metaphor: exits from a crowded venue. Protocols are doors at the bottom of a floor plan; chains are corridors leaving the building.

Visual form:

- A floor-plan rectangle with door openings along one edge.
- Door widths scale by protocol TVL share.
- Corridors leaving the doors curve toward chain destinations.
- Crowding is shown as people/flow density near the largest door or as a narrowed threshold.

Pros:

- Very readable: doors and crowding map directly to the current copy.
- Strong visual contrast between healthy broad exits and dangerous bottlenecks.

Cons:

- Can become illustrative instead of analytical.
- "People" or evacuation imagery may feel too theatrical for a financial dashboard.
- Chain dimension is less natural than in a transit map.

Use only if the desired tone is more narrative than analytical.

## Option C: Subway Map

Metaphor: chains are train lines, protocols are transfer stations, liquidity is route capacity.

Visual form:

- Colored chain lines traverse the card.
- Protocol stations sit as transfer nodes.
- Station size = protocol TVL.
- Line thickness = chain TVL.
- HHI is visible as station dominance.

Pros:

- Highly legible as a route map.
- Works well with badges/logos and responsive simplification.
- Good match for "route" language.

Cons:

- Without protocol-chain matrix data, station-line intersections would be synthetic and could imply false precision.
- The design can drift into generic transit-map mimicry.

Good future direction if the API exposes protocol-by-chain TVL.

## Option D: Sankey Flow

Metaphor: liquidity flows from DEX TVL into protocol and chain buckets.

Visual form:

- Classic left-center-right Sankey.
- Protocol and chain shares are bands.
- The center node is total DEX TVL.

Pros:

- Accurate with current aggregate data.
- Fast to implement and easy to test.

Cons:

- It is a chart, not a distinctive Pharos metaphor.
- It solves information hierarchy but only partially solves the "embodied route" critique.

Acceptable fallback, not the preferred design.

## Recommended Direction

Build Option A: `ExitRouteTerminal`, a terminal/concourse SVG inside the existing `LiquidityExitRouteMap` card.

The diagram should feel like a routing instrument, not an infographic poster:

- Dark chart-stage background, restrained grid/guide lines.
- Protocol gate column on the left, chain lane column on the right.
- Central "Exit Concourse" waist whose width changes with `concentrationHhi`.
- Route bands sized by share; exact text labels remain adjacent.
- Metric cards become compact callouts docked around the diagram, not the main object.

## Implementation Plan

1. Preserve model seam
   - Keep `buildLiquidityExitRouteModel()` and its current tests.
   - Add derived visual helpers only if needed: `routeStrokeWidth(sharePct)`, `routeTerminalGeometry(model)`, `crowdingWaist(hhi)`.
   - Do not change API payloads or liquidity scoring.

2. Replace render layer
   - Add `ExitRouteTerminal` in `src/components/liquidity-stats.tsx` or a sibling component if the file gets too large.
   - Use SVG for the route field so geometry is stable and testable.
   - Use HTML overlays only for labels if needed for wrapping and accessibility.
   - Keep `ExitRouteMetric` cards, but compress them into a right rail or bottom stat strip.

3. Encode the data
   - Protocol gates:
     - Top routes sorted as now.
     - Gate height or aperture width = `sharePct`.
     - Protocol color = existing `PROTOCOL_COLORS`.
   - Chain lanes:
     - Lane width = `sharePct`.
     - Chain color = existing `CHAIN_COLORS`.
   - Crowding:
     - `concentrationHhi < 0.18`: wide concourse, separated bands.
     - `0.18-0.35`: moderate waist.
     - `>= 0.35`: visibly narrowed bottleneck at center.
   - Pool balance:
     - High balance = clean continuous lane.
     - Low balance = segmented/uneven center guide.
   - Organic:
     - High organic = solid flow markers.
     - Low organic = dashed/incentive-tinted flow markers.

4. Responsive behavior
   - Desktop: full left-to-right terminal diagram plus compact right metrics.
   - Tablet: diagram above metric strip.
   - Mobile: vertical route stack: protocol gates at top, concourse center, chain lanes below. Keep exact labels visible; do not hide route data.

5. Accessibility
   - SVG gets a descriptive `aria-label` summarizing top protocol, top chain, total TVL, and concentration.
   - Each visible route has an accessible label containing route name, TVL, and share.
   - Respect `prefers-reduced-motion`; if flow ticks are added, they must stop under reduced motion.

6. Tests
   - Keep current model tests.
   - Replace the render test expectation with semantic route geometry markers:
     - Renders "Exit Route Map".
     - Renders protocol gate elements for top routes and `Other routes`.
     - Renders chain lane elements.
     - Renders a crowding/concourse marker with an HHI-derived data attribute or label.
   - Add one helper test if geometry helpers are extracted.

7. Visual validation
   - Run focused test: `npm test -- src/components/__tests__/liquidity-stats.test.ts`.
   - Run `npm run build` if the component uses new SVG/math helpers.
   - Use Playwright screenshot checks for `/liquidity/` at desktop and mobile widths.
   - Confirm the diagram reads as routes without relying on the heading.

## Non-Goals For First Pass

- Do not model protocol-to-chain pair flows unless the data exposes a true matrix.
- Do not add new API fields.
- Do not change Liquidity Score methodology.
- Do not merge this with redemption-backstop routes; the card must keep secondary-market DEX exits distinct from issuer redemption capacity.
- Do not introduce a map library, canvas, or heavy chart package.

## Success Criteria

- A first-time viewer can tell whether exits are broad or bottlenecked from the shape alone.
- The largest protocol and chain are visually dominant without reading the metric cards.
- `Other routes` remains visible as tail distribution, not hidden in copy.
- Existing numerical disclosures are preserved.
- Mobile still exposes all top routes and metrics without overlap.

## Execution Review

Implemented as `ExitRouteTerminal` in `src/components/liquidity-stats.tsx`.

Validation notes:

- The existing aggregate model seam was preserved; no API, scoring, or methodology semantics changed.
- The render layer now uses a central exit concourse, left protocol gates, and right chain lanes.
- HHI changes the concourse waist through `crowdingWaist()`.
- Protocol and chain route marks use existing DEX and chain logo assets, with numeric value/share labels kept in mono.
- The previous highlighted interpretation pill was removed so the visualization leads the card.
- The right stat rail was narrowed to give the terminal more horizontal space.
- Browser review caught and fixed a desktop clipping issue and a mobile legibility issue.
- Browser review also caught muddy logo wells; badges now use light wells with smaller inset logos.

Validated with:

- `npm test -- src/components/__tests__/liquidity-stats.test.ts`
- `npm run lint`
- `npm run build`
- Playwright desktop and mobile screenshot review of `/liquidity/`
