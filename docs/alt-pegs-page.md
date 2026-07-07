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
- **Shared frontend model:** `src/lib/alt-peg-market.ts`
- **Tests:** `src/app/alt-pegs/page.test.tsx`, `src/app/alt-pegs/client.test.tsx`, `src/app/alt-pegs/alt-peg-cohort-history-chart.test.tsx`, `src/app/alt-pegs/fiat-world-atlas/__tests__/world-atlas.test.tsx`, `src/components/__tests__/non-usd-share-chart.test.tsx`, `src/lib/__tests__/alt-peg-market.test.ts`

The route renders through `createClientFeaturePage(...)` / `FeaturePageShell` with:

- `breadcrumbName="Non-USD Market Structure"`
- `path="/alt-pegs/"`
- title `Non-USD Market Structure`
- one lead paragraph introducing the non-USD market-structure surface

Metadata is authored in `src/app/alt-pegs/page.tsx` with canonical `/alt-pegs/` through `buildPageMetadata(...)`.

Focused chart inspection stays on the same route through query-param state:

- `?view=focused`
- `?chart=share|cohorts`
- `?range=7d|30d|90d|1y|all`

The canonical route remains `/alt-pegs/`; focused query states are shareable inspection views, not separate canonical pages.
On the share chart, `range=all` means all currently loaded points from the `non-usd-share` endpoint window rather than unbounded history.

---

## Data Contract

This route stays frontend-only and uses existing public data sources:

| Source                                  | Used for                                                         |
| --------------------------------------- | ---------------------------------------------------------------- |
| `useStablecoins()`                      | live alt-peg snapshot, current peg distribution, asset table inputs |
| `usePegSummary()`                       | peg-score/source context for the alt-peg asset table             |
| `useDexLiquidity()` / `useReportCards()` | DEX and safety overlays for the alt-peg asset table              |
| `useNonUsdShare()`                      | non-USD share history and 1y trend context                       |
| `useStablecoinCharts()`                 | historical cohort-growth chart                                   |
| `PEG_TAXONOMY_PAGES` / `peg-taxonomy.ts` | stable peg labels, hrefs, and cohort links                      |
| `ACTIVE_META_BY_ID`                     | joining live API rows to tracked peg metadata                    |
| `buildStablecoinTableInputs(...)`       | converts joined live rows into the shared `AltPegStablecoinTable` model |

Important contract:

- `GET /api/stablecoins` does not expose `pegCurrency` directly on the live rows.
- `src/lib/alt-peg-market.ts` must join live rows against tracked frontend metadata before filtering to non-USD cohorts.
- The route must not add a worker/API endpoint unless the current frontend joins stop being sufficient.
- The current non-commodity historical bucket exposed by `useNonUsdShare()` is not pure fiat-only history; it includes currency-linked plus other non-commodity non-USD pegs. Route copy should stay honest about that unless the data contract changes.

---

## Section Order

`AltPegsClient` then renders, in order:

1. `StaleDataBanner`
2. `FiatWorldAtlas` — the **sole full-width page hero** (its own standalone atlas card chrome). On the owner design follow-up the earlier split frost market-cap beam + `Current Structure` sub-block were dropped so the celestial atlas leads alone, full width.
3. `AltPegStablecoinTable` (the workbench, directly beneath the hero)
4. `AltPegMixBand` — the commodity / non-commodity mix bar, demoted out of the old hero into its own flat band
5. `NonUsdShareChart`
6. `AltPegCohortHistoryChart`
7. `AltPegDistributionCard`

At every breakpoint, the `FiatWorldAtlas` hero carries the full non-USD drill-down surface: Gold (sun), Silver (moon), and CPI/Index (orbital glyph) float over the map's ocean deadspots, while the top-cohort market-cap summary sits outside the plotted sky layer so it does not cover CPI-linked markers. The map itself is a pre-rendered static SVG of 1:110m Natural Earth geometry (`public/maps/world-countries.svg`), wired through `src/app/alt-pegs/fiat-world-atlas/world-map.tsx`; Antarctica is omitted before projection fitting so the populated atlas uses the vertical space instead of preserving an unused South Pole band. The SVG is regenerated with `npm run build:world-map` (dev-only d3-geo + topojson-client). Narrow screens keep the same atlas in a responsive viewport that fits the card first, with smaller mobile labels and scaled visual markers to avoid horizontal panning as the default interaction. The asset-level stablecoin table appears immediately after the current-structure snapshot and atlas so individual non-USD assets follow the visual map before the historical chart modules. The atlas card header exposes an Expand atlas affordance that opens a viewport-sized inspection overlay built on Radix Dialog; when `document.fullscreenEnabled` is true the overlay also requests browser fullscreen as a progressive enhancement. The overlay reuses the same `PegDiversityHeroLive` composition with a `--fullscreen` CSS variant and does not alter route query-state or section order.

The route intentionally leads with the atlas hero, then the shared asset table, then the demoted mix band before historical trend cards and the current distribution module, so the analysis reads from geography into the asset roster and then market-share history.

Current Release 1 behavior:

- both historical charts default to `1Y`
- each chart surfaces explicit unit, denominator, coverage-start, cadence, and provenance notes
- each historical card can enter a same-route focused inspection mode through the query state above

---

## Crawlability And Discoverability

- The route is indexable.
- `src/app/sitemap.ts` includes `/alt-pegs/`.
- `src/lib/nav-config.ts` includes `/alt-pegs` in the primary nav block immediately before `/yield`, labeled `Alt-Pegs`.
- The command palette picks the route up automatically through shared nav config.
- `scripts/maintenance/generate-llms-txt.ts` includes `/alt-pegs/` in the generated `public/llms.txt`.
- The visible atlas lives in `AltPegsClient` as `FiatWorldAtlas`: Gold, Silver, and CPI/Index reference markers sit on the same geography-driven visual surface used by the live route, while `AltPegStablecoinTable` provides asset-level details and `AltPegDistributionCard` covers the current cohort distribution.

---

## Homepage Integration

The homepage no longer carries a separate alt-peg teaser component. Its top market-cap hero (`src/components/home-alt-hero.tsx`) includes the live non-USD share as plain text, and its Browse By Peg strip (`PegBrowseStrip` in `src/components/peg-distribution-grid.tsx`) links each peg to its `/stablecoins/[peg]/` cohort page. `useHomeAltFilters` still resolves an inbound `/?peg=fiat-non-usd-peg#home-alt-rankings` deep link into the table's fiat-non-USD filter, but no on-page control currently emits that URL.

The dedicated `/alt-pegs/` route remains the canonical surface for `buildAltPegSnapshot(...)`, cohort history, and crawlable peg drill-down pages.

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
