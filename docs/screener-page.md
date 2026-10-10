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
- `logosById` from `src/lib/logos.ts` for static identity assets
- the slim client registry for lifecycle, governance type, mechanism, peg, blacklistability, Mint Authority summary, and curated custody model (with the shared backing/governance fallback)

The Screener reads USD supply through `getCirculatingRawOrNull()`. `ScreenerRow.supplyUsd` is `null` when the asset is absent from `/api/stablecoins` (for example a pre-launch row) or its current peg buckets are absent, empty or wholly invalid; only an explicit finite zero is `0`. An active supply range (including a max-only filter from a URL or the command-palette `supply<=N` verb) never matches `null`, while an explicit zero passes a max-only filter. The palette drops a non-positive `supply<=` ceiling, because `supplyMax=0` means "no maximum". Table cells render `—` for `null` and the formatted value for an explicit zero; the CSV `supply_usd` cell is empty for `null` and `0` for an explicit zero. The **30d Supply** sparkline keeps a missing current endpoint as a gap rather than a zero. The Screener does not introduce its own API endpoint.

## URL Contract

`SCREENER_URL_SCHEMA` is the canonical key and validation source. It groups into six product families:

1. Exact identity: optional `coins`, limited to eight recognized tracked IDs. When present it is an inspection mode and takes precedence over the broad projection fields, so a relaxed Picker result cannot disappear on arrival.
2. Stress and size ranges: `dewsMin`, `dewsMax`, `supplyMin`, `supplyMax`, `pegScoreMin`, and `liquidityScoreMin`.
3. Safety: `safetyGrades`, `safetyScoreMin`, `safetyEvidence`, and `safetyBackingMin`, `safetyExitMin`, `safetyControlMin`.
4. Classification and custody: `types`, `mechanisms`, `pegs`, and `custodyModels`.
5. Lifecycle and control: `lifecycle` and `blacklistable`.
6. Mint Authority: `mintAuthority`, `mintAuthorityScoreMin`, and `mintAuthorityScores`.

Enum lists are comma-delimited. Minimum floors are inclusive (`value >= floor`), matching Picker exclusion semantics. Default values are omitted by the shared codec, and updates clear only Screener-owned keys so unrelated query parameters survive.

Legacy `mechanism=<slug>` links normalize once after hydration to `mechanisms=<slug>`. When that alias arrives without lifecycle state, normalization pins `lifecycle=active` so a historical deep link does not unexpectedly include pre-launch or frozen assets. Quarantined and delisted records are excluded regardless of URL state. Invalid or deprecated aliases are removed; canonical writers use the schema keys above.

## Loading, Error, And Freshness

Rows are not built until the stablecoin list is available. Query freshness from all five live data sources is combined through `buildQueryFreshnessGroup()` and rendered by `QueryFreshnessNotices`, with a shared retry action.

Filters that read DEWS or report cards (safety grades, overall/pillar floors, evidence status, and the mint control score and band) wait during the initial source load without retained data. The table stays in its loading presentation and export is disabled; after a failed fetch, missing readings are excluded rather than keeping this loading gate open. `pegScoreMin` and `liquidityScoreMin` are not gated: they filter against whatever peg-summary and DEX-liquidity data has arrived, so an active floor can narrow the table during the first fetch.

Retained data can remain visible with stale/error notices according to the shared hook metadata. This route does not invent local staleness windows.

## Sorting And Export

The default sort is Safety Score descending. Sortable keys are name, supply, Peg Score, DEWS, Liquidity Score, Safety Score, and the mint control score (programmatic use). The primary table shows a compact V10 profile (`Backing / Exit / Economic Control`), highlights the published weakest pillar, and distinguishes Strong, Adequate, Limited, NR, Pipeline gap, and Unavailable evidence. Partial pipeline evidence and the binding-cap/weakest-pillar driver are surfaced separately. `useSort()` owns direction and `aria-sort`; unrated handling comes from the shared table comparator.

The desktop-only **Peg Range** sparkline is a two-point `[worst tracked deviation, current deviation]` comparison from the published peg summary, not a 30-day history window. Its tooltip and accessible name use the same worst/current wording, and the Screener makes no per-coin history requests to populate it. The separate **30d Supply** sparkline compares the previous-month and current supply endpoints.

`TableExportMenu` exports the currently filtered and sorted rows, not the unfiltered universe. The CSV includes identity, lifecycle/classification, supply, the Peg/DEWS/Liquidity scores, Safety grade/score, pillar/evidence/cap fields, rating status, partial-evidence causes, custody, blacklistability, and mint route/score/band. Export is disabled during the active score filter's initial source load and stamps the safety-score identity, noting the mint control columns.

The mint columns come from the published Safety Score mint component through the existing V9-named consumer helpers. The Screener CSV uses the literal headers `mint_authority`, `mint_authority_score`, and `mint_authority_score_band`; the shared directory-table export has a separate title-case header contract. Band keys and saved Screener URLs are unchanged. Export provenance uses the safety-score identity, not the retired mint-authority lane.

## Picker Handoff

The dismissible Picker callout links to `/screener/picker/`. Picker results return through a URL assembled by `src/lib/selector-handoff.ts`; the Screener decodes that state through the same canonical schema. The URL includes `coins=` for exact shortlist identity plus the reusable Picker constraints. Picker-only gates are shown as divergence chips instead of being encoded under unsupported or retired filter keys. The Picker remains a guided input flow, while this route is the exact inspection, sorting, and export surface.

## Update Rules

- Filter or URL changes update `screener-filters.ts`, toolbar controls, pure filter tests, deep-link normalization tests, and Picker handoff tests.
- Data-source changes update `client.tsx`, freshness grouping, loading gates, and export columns.
- Sort/export changes update the row contract and table/export tests.
- Metadata or crawlability changes update `page.tsx`, sitemap/robots/header checks, and this doc.

Use [screener-picker-page.md](./screener-picker-page.md) for the guided Picker and [report-cards.md](./report-cards.md), [dews.md](./dews.md), [dex-liquidity.md](./dex-liquidity.md), and [mint-authority-scoring.md](./mint-authority-scoring.md) for score methodology.
