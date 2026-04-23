# Peg Diversity Map Review Loop 1

Date: 2026-04-24

Reviewers: UX, UI, user-champion personas.

Loop gate: not ready. Minor suggestions reported: 4, 4, and 5.

Implemented from the highest impact / lowest risk overlap:

- Reduced fiat-map emblem max size to lower cluster crowding without changing the packing algorithm.
- Moved the fiat size key into the map and made the cap explicit.
- Added live top-cohort-by-market-cap context inside the atlas.
- Added persistent ticker labels for cohort leaders to reduce hover hunting.
- Added top-peer symbols and clearer `Cohort share` wording to hover cards.
- Reworded the hover-card action cue to describe the actual emblem click target.
- Retuned the gold sky layout inward to reduce accidental clipping.
- Added count language to silver/CPI sky tags and aligned the surface around `CPI` naming.
- Made region summary pills link to their region sections and gave cohort chips an action arrow.
- Clarified mobile copy so the fallback no longer promises an unavailable coin-level map.
- Balanced the non-geographic fallback band at wide-but-not-xl widths.
- Marked the world map backdrop decorative for assistive tech.

Deferred:

- Cross-cluster repacking for Europe/Asia, which is higher risk than a loop polish pass.
- List-to-map hover coordination, which requires a larger interaction-state lift across the atlas and link list.
- Full market-cap-ranked static cohort list, because the static server link hub does not have live market-cap data.
