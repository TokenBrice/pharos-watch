# Peg Diversity Map Readability Pass

## Assumptions

- This is a visual-readability refinement, not a new analytics surface.
- The static crawlable cohort links must remain intact.
- The map should keep all live logo markers, but their visual weight can be reduced.

## Success Criteria

- Fiat logo markers no longer dominate the country map at desktop sizes.
- The top-cohort market-cap summary does not overlap the CPI / FPI sky cohort.
- The legend, leader summary, and cohort labels explain the chart without adding a separate help surface.
- Existing alt-pegs route tests and the pre-push merge gate pass before pushing.

## Plan

1. Tighten the logo size scale and make sky cohorts use an explicit smaller cap.
2. Move the top-cohort summary out of the plotted sky layer into a compact rail above the atlas.
3. Reduce map chrome: thinner emblem borders, softer shadows, shorter sky labels, and smaller halos.
4. Validate with focused tests, a browser screenshot pass, the merge gate, then commit and push only this slice.
