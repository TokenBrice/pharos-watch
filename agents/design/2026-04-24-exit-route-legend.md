# Exit Route Map Review

## Assumptions

- Scope is the `/liquidity/` Exit Route Map presentation only.
- This is a presentational clarity fix; route model data, scoring, and methodology stay unchanged.
- The chart should remain dense and practitioner-oriented, matching the existing dark chart instrument.

## Success Criteria

- The standalone legend section is removed because it does not add enough useful information.
- The chart keeps accessible route labels, selected-route detail, mobile fallback rows, and the source caveat.
- Route encoding remains testable through the pure view-model and structural data attributes.

## Plan

1. Remove the standalone route-map legend from the card.
2. Preserve route accessibility and selected-state details without extra explanatory chrome.
3. Run the focused component test and lint/type validation appropriate for this UI-only change.

## Checklist Review

- Metaphor and framing: passes. The route/aperture/throat/lane language explains the data shape and the source caveat prevents redemption-capacity overclaiming.
- View-model: passes for this existing module. `exit-route-model.ts` owns route aggregation, HHI, sqrt scaling, clamping, geometry, and null fallbacks.
- Encoding: passes. Width, stroke, dash, packet count, position, and color are redundant encodings; color is not load-bearing by itself.
- Scene: passes. The chart is SVG with root `role="img"` and keyboard-selectable marks.
- Motion: passes. Flow animation is behind `prefers-reduced-motion: no-preference`, and reduced motion leaves static packet markers visible.
- Responsive and interaction: passes with caveat. Mobile uses horizontal scene overflow plus a parallel fallback list; the scene does not need destructive or navigational touch disambiguation because marks only update selection.
- Integration: passes. Selection state stays in the route-map component and drives the scene, detail panel, fallback list, and metric rail together.

## Implemented Follow-Ups

- Removed the standalone legend section after visual review.
- Added route share data attributes so structural tests can assert the visible width encoding has a machine-checkable source.
- Hid decorative SVG logo images from assistive technology because route groups already carry full accessible labels.
- Clarified the open-route metric copy as protocol doors / chain lanes.
