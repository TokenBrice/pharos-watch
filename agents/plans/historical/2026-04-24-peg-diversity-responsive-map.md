# Peg Diversity Responsive Map Plan

## Assumptions

- The desktop Peg Diversity Map composition should remain visually equivalent to the current atlas.
- Narrow screens should still render the full atlas instead of replacing it with only the cohort list.
- The dense icon map should preserve the full atlas, but phone layouts should fit the card first and reserve horizontal panning for edge cases rather than making it the default first interaction.

## Success Criteria

- `StaticAltPegLinkHub` renders the peg map at mobile, tablet, and desktop breakpoints.
- The atlas viewport fits the card on phone layouts, with compact labels/scaled markers to avoid horizontal scrolling by default.
- The route contract and tests describe responsive atlas behavior instead of an `xl`-only map.
- Focused alt-pegs tests pass, and visual QA covers desktop plus narrow viewports.

## Plan

1. [x] Update `FiatWorldAtlas` and peg hero CSS so the map is visible at every breakpoint with a responsive first-pane mobile layout.
2. [x] Add deterministic logo separation and compact marker scaling so dense cohorts do not collide.
3. [x] Update static link hub tests and route documentation to match the responsive atlas contract.
4. [x] Run focused tests, then launch the page locally and inspect desktop/mobile screenshots.
