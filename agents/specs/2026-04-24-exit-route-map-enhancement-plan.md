# Exit Route Map Enhancement Plan

**Date:** 2026-04-24
**Status:** Research and implementation plan
**Scope:** `/liquidity/` exit-route visualization in `src/components/liquidity-stats.tsx` and `src/components/exit-route-instrument.css`

## Assumptions

- This is a presentation enhancement only. No DEX pipeline, D1, API, scoring, or methodology semantics should change.
- The existing route-map concept is worth keeping. The prior liquidity depth-gauge direction was retired, and the current map better matches the user goal of explaining venue-to-chain exit structure.
- The table and existing aggregate breakdown cards remain below the hero. The visualization should improve first-glance comprehension and delight without replacing the dense workbench.
- Motion must remain CSS-only, gated by `prefers-reduced-motion`, consistent with `docs/design-language.md`.

## Success Criteria

- The route map feels authored at the level of the Alt-Peg Atlas and Chains Harbor Chart, not like an enhanced Sankey diagram.
- Every new shape maps to a data field already present in `DexLiquidityData` or the current aggregate model.
- Hover, focus, and selection reveal the relationship between protocol doors, the central exit throat, chain lanes, and the right-side metrics.
- Ambient animation makes liquidity feel routed through the system, but reduced-motion users get a static, complete visualization.
- Desktop and mobile preserve the same metaphor. Mobile may simplify labels, but it must not drop the route-map idea.
- Component tests cover the new model fields, route interaction state, and reduced-motion-safe animation hooks.

## What The Stronger Visualizations Do Right

### Alt-Peg Atlas

- **It has a literal visual world, not just labels.** The docs describe a map-first hero with logo-size key, top-cohort rail, real world map, and non-geographic celestial bodies. The code renders a sky layer, earth/map layer, and live coin emblems instead of merely naming "atlas".
- **The metaphor encodes data at multiple depths.** Logo size maps to market cap, map position maps to geography, celestial cohorts explain non-geographic pegs, and top-cohort rows keep the visual numerically anchored.
- **Interaction clarifies relationships.** `CoinEmblem` owns hover/focus state, exposes tooltip details, highlights siblings, and dims unrelated cohorts. `CohortThreads` draws connective lines from the hovered coin to cohort peers.
- **The scene has layered delight.** Star twinkle, sun/moon halo pulse, hover scaling, sibling emphasis, and tooltip cards are all small, but they make the data feel alive.
- **It controls clutter.** The atlas keeps duplicate counters out of the hero and moves summary rails outside the plotted sky layer so the primary visual stays readable.

### Chains Harbor + Lighthouse

- **It renders the metaphor completely.** The chart draws ships, sails, hulls, flags, cargo marks, wakes, reflections, waterlines, a horizon fleet, a coastline, and a lighthouse beam.
- **Each object is data-bearing.** Vessel length equals supply, hull color equals health, pennant width equals dominant stablecoin share, cargo marks equal top chain-local stablecoins, wake represents 7-day movement, and horizon fleet represents tail chains.
- **Selection is a first-class concept.** The route maintains selected harbor state, auto-sweeps the lighthouse among visible harbors when reduced motion is not requested, and synchronizes the selected scene element with `SelectedHarborPanel`.
- **Motion has semantic roles.** Lighthouse beam rotation tracks selected harbor, waterline drift makes the harbor feel active, flags move, reflections drift, and selected-harbor light glints. This is more than one generic opacity pulse.
- **The caption teaches the encoding.** The header states the visual grammar in one compact sentence, making the scene immediately legible.

## Current Exit Route Map Critique

### What Works

- It uses the right data source: the global DEX row, `protocolTvl`, `chainTvl`, pool count, HHI, weighted balance, organic fraction, and volume.
- It has a plausible explanatory structure: protocol doors feed a central throat, then split into chain lanes.
- It preserves source caveats: secondary-market DEX exits only, issuer redemption scored separately.
- It already maps width to share and throat width to crowding, which is the correct core story.

### Priority Problems

1. **The metaphor is underdrawn.**
   - The scene says "doors" and "lanes", but the objects are mostly bars, rails, and labels. Compared with ships/cargo or atlas/celestial bodies, it reads like a static process diagram.
   - Fix: make it a routing facility: protocol doors as actual apertures with gates, a measured central lock/throat, chain lanes as marked route corridors, and pool buckets/route pips as small moving packets.

2. **Motion is too generic.**
   - Only `.exit-route-instrument__flow` pulses opacity. It does not show direction, volume, route choice, imbalance, or organic quality.
   - Fix: add directional stroke-dashoffset animations on protocol-to-throat and throat-to-chain paths, with packet markers sized by route share and opacity/dash quality tied to organic fraction.

3. **No interaction layer.**
   - Protocol and chain groups have `aria-label` and `title`, but no hover/focus affordance, no route selection, no synchronized metric panel, and no way to trace one route through the system.
   - Fix: introduce selected route state in `LiquidityExitRouteMap`, with hover/focus/click on each protocol door and chain lane. Selection should brighten the chosen route, dim unrelated paths, and update a compact "Selected route" manifest.

4. **The right-side metrics are detached from the scene.**
   - Open routes, crowding, pool balance, and organic are useful, but they sit as generic metric cards. The user has to mentally connect HHI to throat width or organic to dashed flow.
   - Fix: make these cards behave like instruments connected to the map: crowding controls throat squeeze, pool balance controls side-rail stability, organic controls flow clarity, volume controls pulse tempo or packet frequency.

5. **The central value dominates but does not explain the system.**
   - `$6B` is visually strong, but it can collapse the scene into a metric hero instead of a network story.
   - Fix: keep the total, but surround it with a lock gauge: throat width, crowding band, balance rails, and volume ticks should make the number feel like the measured throughput of the whole map.

6. **Mobile preservation is minimum viable.**
   - The SVG just scrolls with a `min-width`. It preserves pixels, but not necessarily legibility or delight.
   - Fix: keep the same SVG metaphor but add a mobile layout mode with a top selected-route manifest, shorter labels, preserved hit targets, and horizontal snap points for protocol side, throat, and chain side.

## Recommended Direction

### Concept: Exit Routing Console

Keep the "exit route map" name, but visually commit to an exchange-routing console:

- **Protocol doors** are venue gates on the left. Gate aperture width = protocol share of total DEX TVL.
- **Route packets** are small illuminated pips moving from doors into the throat. Pip size or frequency = route share; pips are solid for high organic quality and segmented when organic is weaker.
- **The exit throat** is a lock/choke chamber. Chamber width = HHI crowding band; marker rails = weighted balance; central total = secondary DEX TVL.
- **Chain lanes** are outbound corridors on the right. Lane width/height = chain share; lane badge/logo = chain; lane light intensity = share.
- **Tail routes** stay visible as `Other routes`, but render as a cluster/fan instead of a single undifferentiated bar when omitted totals are meaningful.

This keeps the data interpretation serious and specific. It adds delight through a clearer physical system, not decorative neon.

## Proposed Data Model Changes

All changes are derived from existing fields.

- Extend `LiquidityExitRouteItem` with:
  - `rank`
  - `isOther`
  - `flowIntensity` from share bucket, e.g. `"low" | "medium" | "high"`
  - `packetCount` from share bucket, capped at 5
  - `shortValueLabel` and `shortShareLabel` preformatted only if useful for render/test clarity
- Add `LiquidityExitRouteSelection`:
  - `kind: "protocol" | "chain" | "throat"`
  - `key`
  - `label`
  - `valueUsd`
  - `sharePct`
  - `detail`
- Add helpers:
  - `flowIntensityBand(sharePct)`
  - `routePacketCount(sharePct)`
  - `routeOpacityForSelection(routeKey, selectedKey)`
  - `throatLabelForCrowding(concentrationHhi)`

Do not add a cross-product protocol-to-chain matrix. The current data only has aggregate protocol and aggregate chain buckets, not actual venue-by-chain edges. The visual should continue to show two aggregate halves feeding the same throat; it must not imply exact protocol-to-chain routing pairs.

## Implementation Plan

### Phase 1: Make the Existing Scene Interactive

- Move route hover/selection state into `LiquidityExitRouteMap`.
- Pass `selectedRoute` and `onSelectRoute` into `ExitRouteInstrumentScene`.
- Convert protocol and chain `<g>` elements into keyboard-focusable SVG groups:
  - `role="button"`
  - `tabIndex={0}`
  - `aria-pressed`
  - Enter/Space selection
  - mouse enter/focus update selection, mouse leave may preserve last click selection or fall back to top route.
- Add CSS classes:
  - `.exit-route-instrument__route`
  - `.exit-route-instrument__route-path`
  - `.exit-route-instrument__route-selected`
  - `.exit-route-instrument__route-dimmed`
  - `.exit-route-instrument__route-label`
- Add a `SelectedExitRoutePanel` beneath or beside the scene, analogous to `SelectedHarborPanel`, showing exact route value, share, rank, and what it means.

### Phase 2: Add Directional Flow Motion

- Replace the generic central pulse with path-specific classes.
- Use CSS `stroke-dashoffset` animation for protocol inbound paths and chain outbound paths.
- Add 2-5 static SVG circles or short dashes on each route path; animate opacity/offset only under `prefers-reduced-motion: no-preference`.
- Tie animation delay to route index to avoid synchronized blinking.
- Use motion durations in the 5-9s ambient range, consistent with the harbor chart, not fast spinner-like motion.
- For reduced motion, keep visible path dashes and selected highlights but disable drift.

### Phase 3: Strengthen The Metaphor Without Adding Fake Data

- Redraw doors as true apertures:
  - gate frame, aperture opening, threshold tick, and protocol logo seal
  - aperture width still equals share
- Redraw chain lanes as corridors:
  - baseline lane rail, filled lane depth, endpoint logo buoy/marker
  - right-side lane marker intensity equals share
- Redraw the throat as a lock chamber:
  - squeeze markers tied to HHI
  - balance rails tied to weighted balance dash pattern
  - organic clarity overlay tied to organic percentage
  - total TVL remains centered, but the chamber becomes the focal object rather than the number alone
- Add small "pool bucket" tick marks on the throat or footer:
  - use `poolCount`, bucketed logarithmically, to avoid trying to draw hundreds or thousands of pools.

### Phase 4: Integrate Metrics With Scene State

- Make the right metric cards respond to selection:
  - `Open routes` highlights when protocol/chain count is selected.
  - `Crowding index` highlights the throat squeeze.
  - `Pool balance` highlights the rail dash treatment.
  - `Organic` highlights the flow clarity treatment.
- Replace generic card styling with compact instrument plates consistent with Pharos:
  - no extra nested cards
  - small icon, label, mono value, one-line explanation
  - selected state via border and subtle background, not glow overload.

### Phase 5: Mobile Refinement

- Keep the SVG scrollable, but define meaningful scroll regions:
  - protocol doors
  - exit throat
  - chain lanes
- Add a sticky or preceding compact selected-route manifest on mobile.
- Reduce label density inside SVG on small widths:
  - show route label and share
  - move full value to selected manifest/title
- Preserve hit targets at least 24px and keyboard focus rings.

## Files To Touch

- `src/components/liquidity-stats.tsx`
  - model extensions
  - interaction state
  - selected-route panel
  - SVG structure and keyboard handlers
- `src/components/exit-route-instrument.css`
  - route highlight states
  - directional flow animations
  - reduced-motion rules
  - mobile scale/label refinements
- `src/components/__tests__/liquidity-stats.test.ts`
  - model helper coverage
  - interaction and selected panel coverage
  - CSS hook/test-id presence
- `docs/design-language.md`
  - only if the new implementation introduces reusable metaphor rules beyond current documented rules.
- Potentially a new `docs/liquidity-page.md`
  - only if the repo has or wants a liquidity route contract. Do not create docs churn unless route behavior changes enough to warrant it.

## Test Plan

- Focused component tests:
  - `npm test -- src/components/__tests__/liquidity-stats.test.ts`
- Static checks:
  - `npm run lint`
  - `npm run typecheck`
- Build:
  - `npm run build`
- Browser validation:
  - visit `/liquidity/` desktop and mobile
  - confirm the SVG is nonblank, labels do not overlap, selected route updates on hover/focus/click, reduced-motion disables drift, and the existing leaderboard remains below.
- Pre-push if shipping:
  - `npm run test:merge-gate`

## Risks And Guardrails

- **False precision risk:** Do not draw exact protocol-to-chain links. The available data is two aggregate distributions, not a bipartite route matrix.
- **Over-animation risk:** Motion should be slow, directional, and ambient. Avoid busy particle streams.
- **Color semantics risk:** Protocol and chain colors can identify route families, but health/risk colors should remain semantic. Do not turn the page into decorative neon.
- **Mobile density risk:** If label collision appears, move details into the selected manifest instead of shrinking text below legibility.
- **Scope risk:** Keep all work inside the current liquidity presentation component unless extraction becomes necessary for testability.

## Suggested Commit Shape

1. `feat(liquidity): add interactive exit route selection`
2. `feat(liquidity): animate route flow through exit map`
3. `test(liquidity): cover exit route interaction model`

If the patch stays small, phases 1-3 can be one feature commit plus one test/doc commit.
