# Peg Diversity Map Review Loop 4

Date: 2026-04-24

Reviewers: UX, UI, user-champion personas.

Loop gate: final implementation pass requested by user. Minor suggestions reported: 1, 1, and 2.

Implemented from the remaining safe recommendations:

- Added cohort rank to map emblem accessible labels so keyboard and screen-reader users get the same rank cue shown in hover cards.
- Added a transparent center hit-target layer for fiat emblems so smaller visible coins remain hoverable/clickable in crowded Europe and Asia clusters without changing the authored visual layout.
- Mirrored region arrival styling onto focus, not only `:target`, so region jump links keep an orientation highlight after focus moves.
- Reduced singleton ticker-label noise by only showing singleton labels for larger emblems while preserving hover cards for every coin.

Branch review notes:

- The branch is now four committed alt-peg map UX commits ahead of `origin/main`.
- Uncommitted safety/liquidity/chains files remain outside the alt-peg map branch and were not staged.
