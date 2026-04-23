# Peg Diversity Map Review Loop 3

Date: 2026-04-24

Reviewers: UX, UI, user-champion personas.

Loop gate: not ready. Minor suggestions reported: 2, 3, and 4.

Implemented from the highest impact / lowest risk overlap:

- Added cohort rank to map hover cards so rank context follows the coin, not only the top strip.
- Reworded top-cohort strip values from `alt cap` to `non-USD cap` to avoid altcoin ambiguity.
- Clarified that static cohort lists are sorted by coin count while live cap rank appears on the map.
- Added market-cap/size-based resting z-index for emblems and render smaller fiat clusters first so visible leaders are reachable in crowded regions.
- Added live-region semantics to the map loading/unavailable overlay.
- Made region jump targets focusable and added a subtle target highlight after anchor jumps.
- Replaced the region pill down arrow with a map-pin target affordance.
- Tightened the top-cohort overlay near the `xl` breakpoint.
- Rewrote tablet/mobile atlas copy to describe the available grouped region view directly.

Deferred:

- Cross-cluster collision repacking and anchor nudging, because z-index/hit-testing fixes the immediate hover blocker with lower layout risk.
- Removing all single-coin ticker labels, because the previous loop specifically improved singleton discoverability and the current noise is secondary.
