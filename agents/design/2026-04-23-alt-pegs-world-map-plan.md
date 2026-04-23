Date: 2026-04-23

# Alt-Pegs Atlas World-Map Revision Plan

## Assumptions

- The current `/alt-pegs/` contract stays intact: fiat-only desktop atlas, mobile region-list fallback, and non-geographic cohorts remain off-map.
- The dataset continues to represent reference-currency regions, not issuer, reserve, circulation, or adoption geography.
- The redesign should make the fiat atlas read more like a world map chart without turning the static link hub into a decorative infographic.

## Success Criteria

- The desktop atlas reads as a map first and a stack of cards second.
- Every cohort link remains server-rendered and crawlable in static HTML.
- Mobile keeps the simple stacked region sections.
- Copy remains explicit that the atlas encodes reference-currency geography and that marker size means tracked fiat coin count.

## Implementation Plan

1. Replace the desktop overlay-grid card placement with perimeter callouts anchored to map markers.
2. Upgrade the backdrop from generic graph-paper chrome to a more cartographic atlas stage: recognizable landmasses, projection-like graticule, and restrained ocean treatment.
3. Add low-alpha fiat region footprints plus connector lines so markers and region cards read as one chart.
4. Keep color discipline tight: neutral/frost-blue structure, cohort colors reserved mostly for dots, micro-accents, and link chips.
5. Update route docs only if the rendered behavior contract changes materially, then run targeted route tests and lint.
