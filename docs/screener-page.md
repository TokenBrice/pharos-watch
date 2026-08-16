# Screener Page

Route contract for `/screener/`, the filterable and exportable view of the full tracked stablecoin universe.

## Route Shape

- Static shell, metadata, FAQ, and support copy: `src/app/screener/page.tsx`
- Client orchestration: `src/app/screener/client.tsx`
- Filter schema and pure row pipeline: `src/lib/screener-filters.ts`
- Toolbar and table: `src/components/screener/`
- URL codec: `src/lib/url-state.ts`, `src/hooks/use-url-filters.ts`
- Picker entry: `src/components/selector/selector-callout.tsx`

`createClientFeaturePage()` keeps the route shell static and loads the client behind a shape-preserving skeleton. The route is public, indexable, canonical `/screener/`, and uses `public/og-default.png`.

## Universe And Data Sources

The row builder starts from `CLIENT_TRACKED_STABLECOINS` and explicitly excludes quarantined and delisted records. The visible universe therefore contains active, pre-launch, and frozen rows; policy-withheld records remain available only through their static detail pages. Live data is joined by canonical stablecoin ID from:

- `useStablecoins()` for supply and short supply trend
- `usePegSummary()` for Peg Score and peg-deviation context
- `useReportCardsV9()` for Safety Grade, overall score, Backing / Exit / Economic Control, evidence level, weakest pillar, binding-cap context, and the published mint component
- `useStressSignals()` for DEWS
- `useDexLiquidity()` for Liquidity Score
- `useLogos()` for identity assets
- the slim client registry for lifecycle, governance type, mechanism, peg, blacklistability, Mint Authority summary, and curated custody model (with the shared backing/governance fallback)

The Screener uses `getCirculatingRaw()` for USD supply. It does not introduce its own API endpoint.

## URL Contract

`SCREENER_URL_SCHEMA` is the canonical key and validation source. It groups into six product families:

1. Exact identity: optional `coins`, limited to eight recognized tracked IDs. When present it is an inspection mode and takes precedence over the broad projection fields, so a relaxed Picker result cannot disappear on arrival.
2. Stress and size ranges: `dewsMin`, `dewsMax`, `supplyMin`, `supplyMax`, `pegScoreMin`, and `liquidityScoreMin`.
3. Safety V9: `safetyGrades`, `safetyEvidence`, and `safetyBackingMin`, `safetyExitMin`, `safetyControlMin`.
4. Classification and custody: `types`, `mechanisms`, `pegs`, and `custodyModels`.
5. Lifecycle and control: `lifecycle` and `blacklistable`.
6. Mint Authority: `mintAuthority`, `mintAuthorityScoreMin`, and `mintAuthorityScores`.

Enum lists are comma-delimited. Minimum floors are inclusive (`value >= floor`), matching Picker exclusion semantics. Default values are omitted by the shared codec, and updates clear only Screener-owned keys so unrelated query parameters survive.

Legacy `mechanism=<slug>` links normalize once after hydration to `mechanisms=<slug>`. When that alias arrives without lifecycle state, normalization pins `lifecycle=active` so a historical deep link does not unexpectedly include pre-launch or frozen assets. Quarantined and delisted records are excluded regardless of URL state. Invalid or deprecated aliases are removed; canonical writers use the schema keys above.

## Loading, Error, And Freshness

Rows are not built until the stablecoin list is available. Query freshness from all five live data sources is combined through `buildQueryFreshnessGroup()` and rendered by `QueryFreshnessNotices`, with a shared retry action.

Score-based filters wait for the required score source instead of temporarily filtering against incomplete score data. During that state the table stays in its loading presentation, match counts do not claim a partial result, and export is disabled. Missing optional values remain unrated; an active threshold excludes rows that lack the required score.

Retained data can remain visible with stale/error notices according to the shared hook metadata. This route does not invent local staleness windows.

## Sorting And Export

The default sort is Safety Score descending. Sortable keys are name, supply, Peg Score, DEWS, Liquidity Score, Safety Score, and the mint control score (retained for programmatic/advanced use). The primary table replaces the old Mint Score column with a compact V9 profile (`Backing / Exit / Economic Control`), highlights the published weakest pillar, and shows Strong, Adequate, Limited, or NR evidence status. `useSort()` owns direction and `aria-sort`; unrated handling comes from the shared table comparator.

`TableExportMenu` exports the currently filtered and sorted rows, not the unfiltered universe. The CSV includes identity, lifecycle/classification, custody, supply, V9 pillar/evidence/cap fields, blacklistability, and the mint route/score/band. Export stays disabled while an active score filter is waiting on source data and includes methodology labels for the score families.

Since safety `9.1` the mint columns come from the published V9 mint component. The Screener CSV contract uses the literal headers `mint_authority`, `mint_authority_score`, and `mint_authority_score_band`; the shared directory-table export has a separate title-case header contract. Band keys, filter values, and saved Screener URLs are unchanged. The export provenance line stamps the safety-score identity rather than the retired mint-authority lane.

## Picker Handoff

The dismissible Picker callout links to `/screener/picker/`. Picker results return through a URL assembled by `src/app/screener/picker/handoff.ts`; the Screener decodes that state through the same canonical schema. The URL includes `coins=` for exact shortlist identity plus the reusable Picker constraints. Picker-only gates are shown as divergence chips instead of being encoded under unsupported or retired filter keys. The Picker remains a guided input flow, while this route is the exact inspection, sorting, and export surface.

## Update Rules

- Filter or URL changes update `screener-filters.ts`, toolbar controls, pure filter tests, deep-link normalization tests, and Picker handoff tests.
- Data-source changes update `client.tsx`, freshness grouping, loading gates, and export columns.
- Sort/export changes update the row contract and table/export tests.
- Metadata or crawlability changes update `page.tsx`, sitemap/robots/header checks, and this doc.

Use [screener-picker-page.md](./screener-picker-page.md) for the guided Picker and [report-cards.md](./report-cards.md), [dews.md](./dews.md), [dex-liquidity.md](./dex-liquidity.md), and [mint-authority-scoring.md](./mint-authority-scoring.md) for score methodology.
