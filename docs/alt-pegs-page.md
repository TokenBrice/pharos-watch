# Alt-Pegs Page

Public `/alt-pegs/` explains growth/structure beyond dollar pegs and links crawlable [peg taxonomy](./stablecoin-taxonomy-pages.md) cohorts. It is not a second Screener. `src/app/alt-pegs/` owns shell/client/chart and `src/lib/alt-peg-market.ts` the current snapshot. Shared tables reuse ordinary peg/liquidity/report-card overlays; no dedicated Worker endpoint is needed while existing joins suffice.

## Route Shape

Canonical remains `/alt-pegs/`; focused `view=focused`, `chart=share|cohorts`, `range=7d|30d|90d|1y|all` are shareable views, not separate canonical pages. Closing focus preserves range even for hydrated deep links. Share all means all currently loaded endpoint-window points, not unlimited history. Both history cards default one year and disclose unit, denominator, provenance and coverage start; share additionally names cadence.

## Data Contract

Current aggregation admits each `CLIENT_CORE_AGGREGATE_ACTIVE_IDS` member once and joins active client metadata before non-USD classification. API stablecoin rows do not directly carry pegCurrency. Never aggregate all catalog rows or infer peg from ticker.

Supply uses nullable helpers: absent/empty/invalid is unavailable, finite zero is measured. Snapshot/cohort rows disclose observed/unavailable counts with known subtotals. No observed member means no numeric cap; incomplete denominators withhold shares. Partial cohorts remain visible with coverage. Atlas unknown markers are neutral, distinct from zero-floor size, with explicit accessible unavailable labels; partial plotted supply cannot receive complete-cohort ranks.

### Permanent Series Boundary

Current core-universe aggregates and historical provider-wide series are different populations. `useStablecoinCharts()` plus selected Worker-reconciled structural supply overlays supplies cohort history. Never append a current core sum to that history; no shadow core-history tail is implied. Latest history is dated provider-wide sample, not current core cap.

`useNonUsdShare()` non-commodity history includes currency-linked and other non-commodity pegs, not pure fiat only. Numeric cohort/share observations are required; malformed data is unavailable, not zero. Coverage uses `interior-gap-prior-value`: observed value over observed plus prior-value estimates for missing core assets, including trailing holes. This cannot census assets with no history. Existing endpoint publication floors remain producer-owned. Headline/tooltips/tables/annual changes qualify partial or unknown coverage.

Cohort omitted/null/malformed buckets stay chart gaps and Unavailable cells; explicit zero remains zero. Other and headline totals require every contributing observation. Grouping thresholds use each cohort's latest observed value, never fabricated simultaneous readings.

### Clocks And Failure

Share/history hooks independently retain producer metadata and age budgets. Share health reaches the page banner; cohort history owns its notice. HTTP receipt never renews producer generation. Share headline/accessible name uses latest included sample date, separately from coverage start/receipt, and retained history never says Current share.

Initial stablecoin failure without usable snapshot replaces the page. Failed refresh retains atlas/table/history with saved-data notices and retry. Published peg-summary deviation owns text/severity; raw price refresh does not create a second deviation measurement.

## Atlas And Drill-down

Geographic/commodity/index markers use shared peg labels/anchors, never a local Other catch-all for supported currencies. The asset table is the equivalent inspection surface. Expand/fullscreen are progressive presentation and do not rewrite route query state. `public/maps/world-countries.svg` is generated with `npm run build:world-map`. Distribution collapses only display rows behind native details; full peg links remain in static HTML.

## Crawlability And Discoverability

Keep indexability, sitemap and shared nav/command palette/LLM-index discovery. Navigation label Non-USD Pegs does not rename page title/canonical. All cohort hrefs derive from shared taxonomy, not route-local templates or copied route lists.

## Homepage Integration

[Homepage](./homepage.md) may tease non-USD share and link `/?peg=fiat-non-usd-peg#home-alt-rankings`; `/alt-pegs/` remains the snapshot/history/crawlable-drill-down owner. Component order and atlas anatomy belong to source.

## Update Rules

Change nullable populations, history boundaries, producer clocks, focused URL and crawlability contracts with their source/tests. Source/data-owner changes update architecture and affected homepage/taxonomy references. Layout changes do not require a second component inventory here.
