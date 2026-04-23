Date: 2026-04-23

# Alt-Pegs Cohort Surface: World Map Synthesis

## Scope

Synthesize parallel design reviews of the `Explore Peg Cohorts` surface in `src/app/alt-pegs/static-link-hub.tsx`, with emphasis on whether the fiat cohort drill-down should shift from a region-grouped chip board to a world-map representation and how to handle `Gold` dominance truthfully.

## Assumptions

- The surface is primarily a **taxonomy picker**, not a geographic analytics module.
- The available geography is **reference geography** for fiat pegs, not country-level issuance, reserve, or adoption data.
- Commodity and CPI-linked cohorts remain important to the page even if the primary visual shifts.

## Consensus

Three reviews converged on the same boundary:

1. A **full alt-peg world map** is the wrong model for this surface.
2. A **fiat-only geography view** can work if it remains explicitly scoped to fiat reference regions.
3. `Gold`, `Silver`, and `CPI` should stay **off-map** because they are non-geographic references.

## Current Surface Review

What works now:

- The current layout is dense, calm, and consistent with Pharos' power-user dashboard language.
- Region-grouped fiat cohorts are easy to browse.
- Card-level labels, counts, and symbol previews make drill-down obvious.

What is weak now:

- The page mixes two organizing schemes in one glance: fiat by region, commodity/other by reference type.
- The fiat card visually dominates, making the right rail feel secondary instead of parallel.
- Region labels are too quiet relative to the chips, so structure lands after item-level scanning.
- Copy is a bit long for a route-picking surface.

## Recommendation

### Default recommendation

Keep the existing **region-grouped chip board** as the primary drill-down pattern unless the product goal explicitly becomes “show global orientation at a glance.”

Reason:

- This module is a link hub first.
- A world map adds interpretation cost.
- The dataset does not support a truthful single-map treatment for all cohorts.

### If a map is pursued

Use a **fiat-only world map with region overlays and clickable hub labels**.

Rules:

- Scope the map to fiat cohorts only.
- Label it as `Fiat Peg Geography` or equivalent, not as a generic world map of alt-pegs.
- Use broad regional overlays, not country choropleths.
- Make the hub labels the navigation targets.
- Treat the map as a secondary spatial lens layered onto the existing taxonomy, not as a new primary data encoding.

## Gold Dominance Solution

Best pattern: **off-map reference shelf**.

Structure:

- Left/main: fiat world map or current fiat region board
- Right sidecar: `Non-geographic references`
  - Gold
  - Silver
  - CPI

Sidecar rules:

- Keep gold visually prominent there if needed, but never on the geographic frame.
- Show coin count and optional compact share cue.
- Add explicit copy: `Tracked off-map because these cohorts reference assets or indices, not monetary regions.`

## Creative Option

If the team wants something more authored than a plain side rail, the strongest variant is a **split-frame composition**:

- Main atlas for fiat cohorts
- Thin external “reference lane” or “bullion shelf” wrapping the map edge

That keeps gold visible and memorable without pretending it belongs on land.

## Failure Modes To Avoid

- Choropleths or country fills that imply precision the data does not support
- Market-cap sizing on the map that makes gold the dominant visual object
- Decorative maps that reduce scan speed without improving comprehension
- Mixed labeling that makes users guess whether the map means currency area, issuer location, or reserve location

## Decision

If the goal is **fast drill-down**, stay with the current board and tighten hierarchy.

If the goal is **global orientation plus drill-down**, use:

- fiat-only map
- off-map reference shelf for gold/silver/CPI
- no commodity geometry on the atlas
