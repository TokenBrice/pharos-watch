# Peg Diversity Map Review Loop 2

Date: 2026-04-24

Reviewers: UX, UI, user-champion personas.

Loop gate: not ready. Minor suggestions reported: 4, 4, and 5.

Implemented from the highest impact / lowest risk overlap:

- Reduced the fiat-map emblem cap again so EUR and TRY no longer dominate neighboring cohorts.
- Made requested ticker labels independent from emblem size, including single-coin cohorts below the old 44px cutoff.
- Added ranked, clickable top-cohort rows inside the atlas, with market-cap and alt-cap share context.
- Rounded the fiat size legend cap to a friendlier threshold instead of exposing an overly exact scale artifact.
- Moved the size key and top-cohort context into the upper atlas band to preserve the lower map read.
- Added an explicit live-data loading/unavailable overlay so an empty coin layer is not mistaken for a completed map.
- Added a visible down-arrow affordance to region summary pills.
- Tightened the heading breakpoint and mobile copy so the atlas description does not wrap awkwardly at mid desktop widths.
- Reworded hover-card action text so it works for mouse and keyboard users.

Deferred:

- Cross-list hover synchronization between region chips and map emblems, which needs shared interaction state across server/static and live client surfaces.
- Repacking Europe/Asia with cluster-specific collision rules, which is higher risk than a polish loop.
- Adding live market-cap/share values to static region and list chips, because the static link hub intentionally avoids live query dependency.
