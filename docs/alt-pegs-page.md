# Alt-Pegs Page

Route contract for the public `/alt-pegs/` surface.

---

## Purpose

`/alt-pegs/` is the dedicated non-USD market-structure route. It exists to answer one job cleanly:

- help users see whether stablecoin growth is broadening beyond dollar pegs
- show which non-USD peg cohorts matter right now
- provide crawlable drill-down links into the existing `/stablecoins/[peg]/` taxonomy routes

This route is intentionally not a generic filtered stablecoin table and not a parking lot for homepage overflow charts.

---

## Route Shape

- **Route:** `/alt-pegs/`
- **Server shell:** `src/app/alt-pegs/page.tsx`
- **Client implementation:** `src/app/alt-pegs/client.tsx`
- **Route-local history chart:** `src/app/alt-pegs/alt-peg-cohort-history-chart.tsx`
- **Server-rendered crawlability surface:** `src/app/alt-pegs/static-link-hub.tsx`
- **Shared frontend model:** `src/lib/alt-peg-market.ts`
- **Tests:** `src/app/alt-pegs/page.test.tsx`, `src/app/alt-pegs/client.test.tsx`, `src/app/alt-pegs/static-link-hub.test.tsx`, `src/app/alt-pegs/alt-peg-cohort-history-chart.test.tsx`, `src/components/__tests__/non-usd-share-chart.test.tsx`, `src/lib/__tests__/alt-peg-market.test.ts`

The route renders through `createClientFeaturePage(...)` / `FeaturePageShell` with:

- `breadcrumbName="Non-USD Market Structure"`
- `path="/alt-pegs/"`
- title `Non-USD Market Structure`
- two lead paragraphs describing the route as the non-USD market-structure surface
- the static peg link hub rendered after the client content so the drill-down links are included in the static HTML

Metadata is authored in `src/app/alt-pegs/page.tsx` with canonical `/alt-pegs/` through `buildPageMetadata(...)`.

Focused chart inspection stays on the same route through query-param state:

- `?view=focused`
- `?chart=share|cohorts`
- `?range=7d|30d|90d|1y|all`

The canonical route remains `/alt-pegs/`; focused query states are shareable inspection views, not separate canonical pages.
On the share chart, `range=all` means all currently loaded points from the 5-year `non-usd-share` endpoint window rather than unbounded history.

---

## Data Contract

This route stays frontend-only and uses existing public data sources:

| Source                                  | Used for                                                         |
| --------------------------------------- | ---------------------------------------------------------------- |
| `useStablecoins()`                      | live alt-peg snapshot, current peg distribution, coin/peg counts |
| `useNonUsdShare()`                      | non-USD share history and 1y trend context                       |
| `useStablecoinCharts()`                 | historical cohort-growth chart                                   |
| `PEG_TAXONOMY_PAGES` / `peg-landing.ts` | stable peg labels, hrefs, and the static link hub                |
| `ACTIVE_META_BY_ID`                     | joining live API rows to tracked peg metadata                    |

Important contract:

- `GET /api/stablecoins` does not expose `pegCurrency` directly on the live rows.
- `src/lib/alt-peg-market.ts` must join live rows against tracked frontend metadata before filtering to non-USD cohorts.
- The route must not add a worker/API endpoint unless the current frontend joins stop being sufficient.
- The current non-commodity historical bucket exposed by `useNonUsdShare()` is not pure fiat-only history; it includes currency-linked plus other non-commodity non-USD pegs. Route copy should stay honest about that unless the data contract changes.

---

## Section Order

`AltPegsClient` renders, in order:

1. `StaleDataBanner`
2. hero snapshot for the current non-USD segment
3. current peg-distribution card
4. `NonUsdShareChart`
5. `AltPegCohortHistoryChart`

`page.tsx` then renders `StaticAltPegLinkHub` after the client surface so the peg drill-down links are present in static HTML. On `xl+`, a single `FiatWorldAtlas` card carries the full non-USD drill-down surface: a celestial band above the map renders Gold (sun), Silver (moon), and CPI/Index (orbital glyph), and the map itself is a pre-rendered static SVG of 1:110m Natural Earth geometry, colored per country via `PEG_COUNTRY_MAP` in `src/lib/alt-peg-geography.ts`. The SVG is regenerated with `npm run build:world-map` (dev-only d3-geo + topojson-client). Below `xl`, the surface falls back to a stacked `MobileRegionList` that now includes the non-geographic cohorts at the bottom.

The route intentionally keeps all current-state modules ahead of the historical modules to reduce trust issues caused by mixed source cadences.

Current Release 1 behavior:

- both historical charts default to `1Y`
- each chart surfaces explicit unit, denominator, coverage-start, cadence, and provenance notes
- each historical card can enter a same-route focused inspection mode through the query state above

---

## Crawlability And Discoverability

- The route is indexable.
- `src/app/sitemap.ts` includes `/alt-pegs/`.
- `src/lib/nav-config.ts` includes `/alt-pegs` in the primary nav block immediately after `/yield`, labeled `Non-USD Stables`.
- The command palette picks the route up automatically through shared nav config.
- `scripts/generate-llms-txt.ts` includes `/alt-pegs/` in the generated `public/llms.txt`.
- `StaticAltPegLinkHub` is part of the static route output, so `out/alt-pegs/index.html` contains crawlable links into representative non-USD peg cohorts even though the visible analytics surface is client-rendered.
- The static link hub's desktop treatment is a single `FiatWorldAtlas` card: a celestial band (Gold sun, Silver moon, CPI/Index orbital) above a pre-rendered static SVG world map whose countries are colored per `PEG_COUNTRY_MAP`. Commodity, CPI-linked, and other non-fiat reference cohorts stay crawlable through the celestial band on desktop and through the stacked `MobileRegionList` on narrower viewports.

---

## Homepage Integration

The homepage Research Surfaces band no longer renders `PegDiversityChart` and `NonUsdShareChart`.

Instead it renders:

- `CategoryStats`
- `TotalMcapChart`
- `HomepageAltPegsTeaser`

`HomepageAltPegsTeaser` uses the same shared frontend model (`buildAltPegSnapshot(...)`) as the dedicated route so the homepage CTA and `/alt-pegs/` stay aligned on the current non-USD snapshot.

---

## Update Rules

Update this doc when any of these contracts change:

- route title, canonical path, or metadata ownership
- section order
- frontend-only data model assumptions
- focused chart query-state behavior
- crawlability pattern for peg links
- homepage teaser integration
- nav, sitemap, or `/llms.txt` discoverability rules

Related docs to update in the same change:

- [homepage.md](./homepage.md)
- [architecture.md](./architecture.md)
- [README.md](../README.md)
- [README.md](./README.md)
