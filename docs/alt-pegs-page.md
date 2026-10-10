# Alt-Pegs Page

Route contract for the public `/alt-pegs/` surface.

---

## Purpose

`/alt-pegs/` is the dedicated non-USD market-structure route. It exists to answer one job cleanly:

- help users see whether stablecoin growth is broadening beyond dollar pegs
- show which non-USD peg cohorts matter right now
- provide crawlable drill-down links into the existing `/stablecoins/[peg]/` taxonomy routes ([stablecoin-taxonomy-pages.md](./stablecoin-taxonomy-pages.md))

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
Closing a focused chart retains its selected range in the overview, including when the focused view was opened from a deep link after hydration.

---

## Data Contract

This route stays frontend-only and uses existing public data sources:

| Source                                  | Used for                                                         |
| --------------------------------------- | ---------------------------------------------------------------- |
| `useStablecoins()`                      | live alt-peg snapshot, current peg distribution, asset table inputs |
| `usePegSummary()`                       | peg-score/source context for the alt-peg asset table             |
| `useDexLiquidity()` / `useReportCardsV9()` | DEX and safety overlays for the alt-peg asset table            |
| `useNonUsdShare()`                      | non-USD share history and 1y trend context                       |
| `useStablecoinCharts()`                 | historical cohort-growth chart                                   |
| `PEG_TAXONOMY_PAGES` / `peg-taxonomy.ts` | stable peg labels, hrefs, and cohort links                      |
| `ACTIVE_META_BY_ID`                     | joining live API rows to tracked peg metadata                    |
| `buildStablecoinTableInputs(...)`       | builds the peg-rate, peg-score, and V9 report-card overlays for `AltPegStablecoinTable`; row data comes straight from `peggedAssets` |

Important contract:

- `GET /api/stablecoins` does not expose `pegCurrency` directly on the live rows.
- `src/lib/alt-peg-market.ts` must join live rows against tracked frontend metadata before filtering to non-USD cohorts.
- Current supply uses `getCirculatingRawOrNull`: absent, empty, or invalid buckets remain unavailable and explicit observed zero remains zero. Snapshot and peg rows carry observed/unavailable counts beside known subtotals. A segment with no observations has no numeric cap; incomplete denominators withhold market shares. Partial cohorts remain visible, labelled with their observed-member coverage.
- Atlas coins retain nullable market caps. Unknown supply uses a neutral marker size (not the measured-zero floor) and an explicit unavailable hover/accessible label. Cohort hover cards name known subtotals and unavailable members, withhold incomplete-denominator shares, and do not assign complete-cohort ranks while plotted supply is incomplete.
- The route must not add a worker/API endpoint unless the current frontend joins stop being sufficient.
- The current non-commodity historical bucket exposed by `useNonUsdShare()` is not pure fiat-only history; it includes currency-linked plus other non-commodity non-USD pegs. Route copy should stay honest about that unless the data contract changes.
- Non-USD history requires numeric observed cohort amounts/shares; malformed cohorts fail unavailable, not zero. Each point carries nullable/optional `coverage` ratios: observed value / (observed + prior-value estimates for interior gaps), with basis `interior-gap-prior-value`. Existing 95% total / 50% per-cohort publication floors are unchanged. Chart headlines, tooltips, tables and annual comparisons qualify partial or unknown coverage; this estimate cannot census assets with no history.
- `useNonUsdShare()` and `useStablecoinCharts()` retain producer freshness metadata, independently assessed against each endpoint's age budget. Share health appears in the page banner; cohort history owns its notice. A successful HTTP refresh does not refresh the producer generation.
- The share headline and accessible chart label name the latest included sample's as-of date, separately from coverage start and request receipt. Retained history never claims to be a “Current share.”
- `AltPegCohortHistoryChart` uses the historical provider-wide `stablecoin-charts` population with selected structural `supply_history` overlays reconciled by the Worker. It never appends a current core-universe aggregate to that different population. This is the permanent series boundary, not a temporary transition or an implemented shadow core-history tail.
- Cohort history labels its latest provider-wide sample with its date, not as current core market cap. Malformed buckets normalize to `null`; omitted/null buckets remain chart gaps and “Unavailable” table/tooltip cells. Explicit zero stays zero; Other and headline totals require every contributing cohort observation. The $5m grouping uses each cohort's latest observed value.
- Initial stablecoin failure without a usable alt-peg snapshot replaces the page; failed refetches retain the atlas, table and histories with saved-data health and the existing Retry action.

The shared table's peg-deviation text and severity both read the published `peg-summary.currentDeviationBps`; the raw price remains an independently refreshed price display rather than a second deviation authority.

---

## Section Order

`AltPegsClient` then renders, in order:

1. `StaleDataBanner`
2. `SafetyScoreV9StatusNotice` — compact notice shown only while V9 ratings are held
3. `FiatWorldAtlas` — the full-width page hero and non-USD drill-down surface
4. `AltPegStablecoinTable` (the workbench, directly beneath the hero)
5. `AltPegMixBand` — the commodity / non-commodity mix bar
6. `NonUsdShareChart`
7. `AltPegCohortHistoryChart`
8. `AltPegDistributionCard`

At every breakpoint, `FiatWorldAtlas` carries the non-USD drill-down surface. Gold, Silver, and CPI/Index markers share the geography-driven view, while the top-cohort market-cap summary stays outside the plotted layer. The pre-rendered Natural Earth map lives at `public/maps/world-countries.svg` and is generated by `npm run build:world-map`. The responsive scene offers an Expand atlas dialog and progressive browser fullscreen without changing route query state.

CZK and PLN fiat clusters use European map anchors and the Europe region; AED uses a UAE map anchor and the Asia region. Their symbols and labels derive from the shared peg taxonomy and classification metadata, not an OTHER bucket.

The route intentionally leads with the atlas hero, then the shared asset table, then the demoted mix band before historical trend cards and the current distribution module, so the analysis reads from geography into the asset roster and then market-share history.

Chart behavior:

- both historical charts default to `1Y`
- each chart surfaces explicit unit, denominator, coverage-start, and provenance notes; the share chart additionally states its sampling cadence
- each historical card can enter a same-route focused inspection mode through the query state above

---

## Crawlability And Discoverability

- The route is indexable.
- `src/app/sitemap.ts` includes `/alt-pegs/`.
- `src/lib/nav-config.ts` includes `/alt-pegs` in the `Markets` menu, labeled `Non-USD Pegs` in navigation only. The page title, H1, and route are unchanged.
- The command palette picks the route up automatically through shared nav config.
- `scripts/maintenance/generate-llms-txt.ts` includes `/alt-pegs/` in the generated `public/llms.txt`.
- The visible atlas lives in `AltPegsClient` as `FiatWorldAtlas`: Gold, Silver, and CPI/Index reference markers sit on the same geography-driven visual surface used by the live route, while `AltPegStablecoinTable` provides asset-level details and `AltPegDistributionCard` covers the current cohort distribution.

---

## Homepage Integration

The homepage market-cap hero (`src/components/home-alt-hero.tsx`) includes the live non-USD share as text, and `PegBrowseStrip` links peg cohorts to `/stablecoins/[peg]/`. `useHomeAltFilters` accepts the inbound `/?peg=fiat-non-usd-peg#home-alt-rankings` deep link.

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
