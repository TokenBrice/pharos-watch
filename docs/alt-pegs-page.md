# Alt-Pegs Page

Public `/alt-pegs/` (H1 and navigation label **Non-USD Pegs**) explains growth/structure beyond dollar pegs and links crawlable [peg taxonomy](./stablecoin-taxonomy-pages.md) cohorts. It is not a second Screener. `src/app/alt-pegs/` owns shell/client/chart; `shared/lib/alt-peg-snapshot.ts` (`buildNonUsdMarketSnapshot`) is the one current-snapshot reducer, shared by the page (`src/lib/alt-peg-market.ts` adds labels, links and colours) and the live share card. Shared tables reuse ordinary peg/liquidity/report-card overlays; no dedicated Worker endpoint is needed while existing joins suffice.

## Route Shape

Canonical remains `/alt-pegs/`. Order: instrument header (deck, Share; no methodology line, as no versioned methodology exists) → hero → atlas → peg ranking → coin table → share and cohort history → footer (source, cadence, MiCA link). `?peg=<code>` is the ranking's and table's shared peg filter (unknown or USD values are ignored). Focused `view=focused`, `chart=share|cohorts`, `range=7d|30d|90d|1y|all` are shareable views, not separate canonical pages. Closing focus preserves range even for hydrated deep links. Share all means all currently loaded endpoint-window points, not unlimited history. Both history cards default one year with a one-line caption; unit, denominator, provenance, coverage start and (for share) cadence sit in a "How this series is built" fold.

## Data Contract

The hero beam is the core non-USD market cap (`altMarketCap`); while any non-USD member lacks supply or is absent from the list (counted as unavailable, as the homepage reducer does) its label reads "known subtotal, partial" and an amber `Partial supply` chip carries reason `supply-unavailable`. The universe chip names the computed count ("N non-USD of 268" core). Supporting facts are the provider-wide share of all stablecoins (dated by its latest sample, never "current"), its 1-year change, and the peg count. The cohort-mix bar (commodity pegs, then currency/index pegs) is hatched and labelled when shares are withheld, never empty. The ranking, coin table and hero all read the core universe, so counts agree; non-core coins stay reachable through dossiers and the Screener. Ranks print only when every member reports supply. Cohort figures use one rounding (`formatCurrency(…, 1)`; shares through `formatNonUsdShare`, one decimal and `<0.1%` for a nonzero sliver). A `?peg=` code with no core coins is ignored rather than producing an empty table.

Current aggregation admits each `CLIENT_CORE_AGGREGATE_ACTIVE_IDS` member once and joins active client metadata before non-USD classification. API stablecoin rows do not directly carry pegCurrency. Never aggregate all catalog rows or infer peg from ticker.

Supply uses nullable helpers: absent/empty/invalid is unavailable, finite zero is measured. Snapshot/cohort rows disclose observed/unavailable counts with known subtotals. No observed member means no numeric cap; incomplete denominators withhold shares. Partial cohorts remain visible with coverage. Atlas unknown markers are neutral, distinct from zero-floor size, with explicit accessible unavailable labels. Atlas cohort counts, subtotals and completeness come from the full core non-USD census, including omitted API rows and members without a plotted logo; ranks require every non-USD census member to report supply, and an incomplete cohort withholds coin shares.

The asset table reads scores from the compact DEX table projection (`useDexLiquidityTable`), not the full pool-detail map; missing scores remain unavailable and observed zero stays numeric.

### Permanent Series Boundary

Current core-universe aggregates and historical provider-wide series are different populations. `useStablecoinCharts()` plus selected Worker-reconciled structural supply overlays supplies cohort history. Never append a current core sum to that history; no shadow core-history tail is implied. Latest history is dated provider-wide sample, not current core cap.

Cohort history starts alongside the current stablecoin query, before the page's current-market loading return. Its mounted chart reuses the same canonical query key and producer-cadence options; there is no second history cache or polling policy.

`useNonUsdShare()` non-commodity history includes currency-linked and other non-commodity pegs, not pure fiat only. Numeric cohort/share observations are required; malformed data is unavailable, not zero. Coverage uses `interior-gap-prior-value`: observed value over observed plus prior-value estimates for missing core assets, including trailing holes. This cannot census assets with no history. Existing endpoint publication floors remain producer-owned. Headline/tooltips/tables/annual changes qualify partial or unknown coverage.

Cohort omitted/null/malformed buckets stay chart gaps and Unavailable cells; explicit zero remains zero. Other and headline totals require every contributing observation. Grouping thresholds use each cohort's latest observed value, never fabricated simultaneous readings.

### Clocks And Failure

Share/history hooks independently retain producer metadata and age budgets. Share health reaches the page banner; cohort history owns its notice. HTTP receipt never renews producer generation. Share headline/accessible name uses latest included sample date, separately from coverage start/receipt, and retained history never says Current share.

Initial stablecoin failure without usable snapshot replaces the page. Failed refresh retains atlas/table/history with saved-data notices and retry. Published peg-summary deviation owns text/severity; raw price refresh does not create a second deviation measurement.

## Atlas And Drill-down

The atlas follows the theme through scene tokens in `peg-hero.css`: light mode draws the map on the page ground; dark mode keeps a night sea with land lifted clear of it. Every mark is a coin: position is its peg's home (`PEG_ANCHORS`; the overlap pass never moves a coin more than `PEG_HOME_RADIUS_PX` from it, so a crowded home stacks smaller emblems on top instead of spilling onto another continent), size is market cap on one sqrt scale (map and shelf only differ in ceiling, stated in the size key), the ring is the peg hue, and a dashed ring marks unavailable supply. Pegs without a territory (gold, silver, CPI, unmapped currencies) stand on a shelf above the map in market-cap order; no core non-USD coin with a logo is left off the atlas. There is no starfield, halo, ray or orbit. Phones get the atlas behind a "Show map" disclosure. Geographic/commodity/index markers use shared peg labels/anchors, never a local Other catch-all for supported currencies. The asset table is the equivalent inspection surface. Expand/fullscreen are progressive presentation and do not rewrite route query state. `public/maps/world-countries.svg` is generated with `npm run build:world-map`. The ranking shows the top eight pegs and folds the rest behind native details ("Show all N pegs"); each row filters the table and links its peg page.

The marker census starts with the core non-USD registry, using registry names, symbols and logos before joining nullable API supply by ID. Omitting a member from a non-empty response is equivalent to an explicit unavailable bucket: its logo remains at the existing unavailable size. Members without logos remain unplotted, but still contribute to cohort counts, known subtotals and completeness; rendering admission never becomes the denominator.

## Share Card

`/alt-pegs/` selects the live route card `/api/og/page/alt-pegs` (`worker/src/api/og-page/alt-pegs.ts`): the same `buildNonUsdMarketSnapshot` beam over the published stablecoins cache, top three peg shares when complete, a `Partial · x/y non-USD coins observed` stamp when not. A missing, stale or null source, or a render failure, serves the timeless `og-alt-pegs.png` ([OG images](./og-images.md#1-route-cards)).

## Crawlability And Discoverability

Keep indexability, sitemap and shared nav/command palette/LLM-index discovery. The H1 matches the navigation label (Non-USD Pegs); the canonical path is unchanged. All cohort hrefs derive from shared taxonomy, not route-local templates or copied route lists.

## Homepage Integration

[Homepage](./homepage.md) may tease non-USD share and link `/?peg=fiat-non-usd-peg#home-alt-rankings`; `/alt-pegs/` remains the snapshot/history/crawlable-drill-down owner. Component order and atlas anatomy belong to source.

## Update Rules

Change nullable populations, history boundaries, producer clocks, focused URL and crawlability contracts with their source/tests. Source/data-owner changes update architecture and affected homepage/taxonomy references. Layout changes do not require a second component inventory here.
