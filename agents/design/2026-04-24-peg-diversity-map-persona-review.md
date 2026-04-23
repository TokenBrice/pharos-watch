# Peg Diversity Map Persona Review

Date: 2026-04-24

Scope: UX, UI, and user-champion review of the desktop peg diversity map hover experience.

## Implemented Recommendations

- Added cohort-aware hover-card data: market cap, share of cohort cap, cohort cap, and cohort size.
- Passed cohort totals into fiat, gold, silver, and index-linked emblem clusters so sky cards no longer show incomplete data.
- Switched hover-card peg language from raw ticker codes to human cohort labels such as "Euro cohort".
- Added an explicit "Open profile" cue so coin emblems read as links, not only decorations.
- Added keyboard-focus hover-card coverage and restored a visible focus outline.
- Forced sky-cohort cards below the emblem and reversed horizontal edge nudges to reduce desktop clipping.
- Corrected the size legend from "$1M ... $3B+" to "$1M ... ~$550M+", matching the actual emblem size cap.
- Added a keyboard skip link from the desktop map to the cohort list.

## Deferred

- Repacking crowded Europe/Asia cohorts. This is higher risk because it changes the placement algorithm across clusters.
- Coloring individual hover relationship threads by peg. Useful, but less impactful than placement and data clarity for this pass.
