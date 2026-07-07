# Cemetery and Compare

## Overview

This document covers two frontend-only feature surfaces that are not backed by dedicated page-specific worker endpoints:

- `/cemetery` — static memorial dataset + interactive UI
- `/compare` — indexable multi-source live compare tool plus static pair-directory hub
- `/compare/[slug]` — static comparison landing pages generated from tracked metadata

## Stablecoin Cemetery (`/cemetery`)

Primary files:

- `src/app/cemetery/page.tsx`
- `src/components/cemetery-client.tsx`
- `src/components/stablecoin-cemetery.tsx`
- `src/components/cemetery-tombstones.tsx`
- `src/components/cemetery-charts.tsx`
- `shared/lib/cemetery-merged.ts`
- `shared/lib/dead-stablecoins.ts`
- `shared/data/dead-stablecoins.json`
- `scripts/maintenance/generate-cemetery-dataset.ts`
- `public/datasets/stablecoin-cemetery.json`
- `public/datasets/stablecoin-cemetery.csv`

### Data model

Cemetery data is static and versioned in-repo. The curated dead-coin dataset lives in `shared/data/dead-stablecoins.json` and is validated/exported as `DEAD_STABLECOINS` by `shared/lib/dead-stablecoins.ts`. The route, charts, and public dataset export consume `CEMETERY_ENTRIES` from `shared/lib/cemetery-merged.ts`, which combines those curated dead rows with frozen tracked stablecoins.

Each entry follows `DeadStablecoin` (`shared/types/index.ts`) with fields such as:

- identity (`id`, `name`, `symbol`, optional `llamaId`)
- context (`pegCurrency`, `causeOfDeath`, `deathDate`)
- narrative (`epitaph`, `obituary`, `sourceUrl`, `sourceLabel`)
- optional `peakMcap`
- optional `contracts` — array of `{ chain, address }` for block-explorer links in the autopsy view

Cause metadata (labels + colors) is centralized in `CAUSE_META` / `CAUSE_HEX`.

### Public dataset export

`scripts/maintenance/generate-cemetery-dataset.ts` publishes the curated cemetery dataset to static export files:

- `/datasets/stablecoin-cemetery.json`
- `/datasets/stablecoin-cemetery.csv`

The JSON export includes schema metadata, field descriptions, source-data path, canonical cemetery URL, source labels/URLs per row, and known historical token contracts when available. The CSV export mirrors the same row set with contracts flattened as `chain:address` pairs. Both exports are deterministic and sorted newest-failure first for citation/research reuse. `npm run prebuild` regenerates them, and `npm run check:cemetery-dataset` fails when checked-in public exports drift from either `shared/data/dead-stablecoins.json` or `shared/data/stablecoins/coins.generated.json` (the combined `CEMETERY_ENTRIES` merge source).

The stable `id` field is the primary dead-coin identifier across the cemetery UI, public dataset export, report-card defunct rows, and Telegram cemetery snapshots. `llamaId` remains optional provider metadata only.

The `/cemetery/` page links directly to both exports from the route header so researchers and journalists can cite/download the dataset without inspecting the repository.

The `/cemetery/` page also emits a `Dataset` JSON-LD node built from the checked-in JSON export metadata, alongside the existing `CollectionPage` and `ItemList` nodes. The dataset node links JSON and CSV `DataDownload` distributions at the public `/datasets/stablecoin-cemetery.{json,csv}` URLs, exposes field descriptions as `variableMeasured`, includes source checksum / row-count metadata, and must not point crawlers at internal `/_site-data/*` URLs.

### Frozen entries in the cemetery

Frozen tracked stablecoins (registry entries with `status: "frozen"`) merge into the cemetery alongside curated `DEAD_STABLECOINS` through `shared/lib/cemetery-merged.ts`:

- `buildMergedCemetery()` (via `frozenToDeadShape()`) maps each `FROZEN_STABLECOINS` entry's `obituary.deathDate` to `deathDate` and the registry `obituary` block to `epitaph` / `obituary` / `causeOfDeath` / `sourceUrl` / `sourceLabel`. Frozen rows are flagged with `archivedDataAvailable: true` so the tombstone and obituary panels render a "View archived data ->" link to `/stablecoin/<id>/` (which serves the frozen detail page with the `<FrozenStateBanner>` and "Data frozen on YYYY-MM-DD" chart footer). Curated `DEAD_STABLECOINS` entries leave `archivedDataAvailable` falsy and link only to the cemetery anchor.
- Identifier rules: the merged `id` for a frozen row is the registry `id` (the same canonical ticker-issuer ID used everywhere else on the site). Curated dead-coin ids (e.g. `ust-terrausd-2022-05`) keep their stable cemetery-only identifiers.
- Sort and grouping: the merged list keeps the same year-grouped, newest-first behavior the cemetery already uses. The merged `deathDate` (sourced from the `obituary` block) is the sort input; `frozenAt` is not copied onto the entry and does not participate in the sort key.

The static cemetery dataset export reflects the same merge:

- `scripts/maintenance/generate-cemetery-dataset.ts` consumes `CEMETERY_ENTRIES` and writes one combined row set to `public/datasets/stablecoin-cemetery.json` and `public/datasets/stablecoin-cemetery.csv`.
- The JSON export records `shared/lib/cemetery-merged.ts` as the merge source plus per-source paths and checksums for `shared/data/dead-stablecoins.json` and `shared/data/stablecoins/coins.generated.json`.
- `archivedDataAvailable` is exposed as a row field, with a schema description, and `pharosUrl` resolves to `/stablecoin/<id>/` when archived data is available and to the cemetery anchor otherwise.
- `npm run check:cemetery-dataset` continues to guard drift across both sources.

### Telegram channel notifications

The cemetery dataset now has a worker-side Telegram notification path:

- `worker/src/lib/telegram-digest-appendices.ts`
- runs as part of daily Telegram digest delivery
- diffs the deployed `DEAD_STABLECOINS` list against a cached snapshot in D1
- seeds silently on first run so existing graves do not backfill into Telegram
- appends one consolidated cemetery section to the next Telegram daily digest when a deploy adds one or more new entries

Each appendix includes the epitaph (when present) for every newly added coin plus a rotating darkly editorial footer line.

### UI behavior

- `CemeteryClient` maintains an `expanded` coin-id set for obituary panels plus a local sort toggle (`newest` default, `oldest` fallback).
- Tombstones render newest death-year first by default even though `DEAD_STABLECOINS` remains curated in oldest-first order in-repo.
- `CemeteryTombstones` renders all year sections inside one continuous atmospheric cemetery scene with shared ground, horizon, fog, and a central path; size still reflects peak market cap.
- Tombstone logos come from each row's `logo` field and render both on the grave marker and in the hover/focus memorial plaque. Curated dead-coin rows usually point under `public/logos/cemetery/`; frozen tracked rows prefer the canonical `data/logos.json` path and fall back to the legacy cemetery filename heuristic only when no tracked logo is registered.
- Tombstone hover and keyboard focus reveal an over-grave plaque with the stablecoin name, symbol, cause, death date, peak market cap, peg currency, archive status, and obituary lead (or up to the first two sentences, capped at 380 characters, for the top-20 entries by peak market cap).
- Tombstone selection auto-expands the matching obituary and scrolls into view.
- `StablecoinCemetery` renders collapsible rows with source links and cause badges, using the same order as the tombstone field above.
- `CemeteryCharts` receives server-projected cemetery entries and computes all chart series from that payload (no API fetch).

## Compare (`/compare` + `/compare/[slug]`)

Primary files:

- `src/app/compare/page.tsx`
- `src/app/compare/[slug]/page.tsx`
- `src/app/compare/client.tsx`
- `src/components/comparison-table.tsx`
- `src/components/comparison-chart.tsx`
- `src/components/compare-empty-state.tsx`
- `src/lib/compare-pages.ts`
- `src/lib/compare-config.ts` — `MAX_COMPARE_COINS`, `COMPARISON_PRESETS`
- `src/lib/compare-types.ts` — shared compare slot / preset types
- `src/lib/compare-share-image.ts`
- `src/hooks/use-compare-selection.ts` — selection state management
- `src/hooks/use-compare-data-model.ts` — data fetching and derived state
- `src/hooks/use-compare-share-actions.ts` — share/export logic

### Route shell and SEO

- `src/app/compare/page.tsx` is the indexable live comparison entry point. It uses `buildPageMetadata(...)` with canonical `/compare/`, serves the live client through `createClientFeaturePage(...)`, and keeps the client tool as the primary on-page workflow.
- The `/compare/` page also server-renders a crawlable pair directory from `STATIC_COMPARISON_PAGES` plus a compare FAQ. The directory includes a priority static-pair cluster for high-intent wrapper, gold-token, Liquity, and issuer-substitute searches, then links to every static pair brief and to matching live compare-tool URLs; the FAQ emits FAQ JSON-LD through `FaqSection`.
- `src/app/compare/[slug]/page.tsx` is the indexable static comparison surface. It statically generates params from `STATIC_COMPARISON_PAGES`, builds per-page metadata from each page descriptor, and calls `notFound()` for unknown slugs.
- Static comparison URLs follow `/compare/<left-id>-vs-<right-id>/`, with metadata/title/description derived from `src/lib/compare-pages.ts`.
- Static comparison pages emit route-specific `WebPage` + `ItemList` JSON-LD from `buildStaticComparisonJsonLd(...)`, including the two compared stablecoins as `Thing` nodes and the visible comparison rows as `PropertyValue` items.
- `src/app/sitemap.ts` includes both the `/compare/` hub and `/compare/[slug]/` pair pages. Pair-page `lastModified` uses the newer of the two compared stablecoin detail-page `LAST_EDITED` dates because dynamic comparison slugs are not generated into `sitemap-dates.json`.
- `src/app/cemetery/page.tsx` emits `CollectionPage` and `ItemList` JSON-LD for the defunct-stablecoin archive. Dead coins intentionally use `Thing` items rather than fabricated internal detail URLs.

### Selection and URL contract

- Maximum selection: `MAX_COMPARE_COINS = 5`.
- URL is the source of truth for selection state.
- Query param `coins` accepts canonical ticker-issuer IDs only (for example `usdt-tether`). Unknown IDs, legacy DefiLlama/historical IDs, and raw ticker symbols are dropped rather than guessed.
- Query param `range` stores the market-cap chart window. Accepted values are `7d`, `30d`, `90d`, `1y`, and `all`; `all` is the default and is cleared from the URL instead of persisted.
- Static comparison landing pages are generated from `STATIC_COMPARISON_PAGES` in `src/lib/compare-pages.ts` and live at `/compare/<left-id>-vs-<right-id>/`.
- Mobile selection renders selected-coin chips plus one add selector instead of all five selector slots up front. The underlying URL state and five-coin maximum are unchanged; desktop keeps the full slot grid.

Initial load normalizes the `coins` URL param to the accepted canonical ID list. If invalid tokens were present, `useCompareSelection()` rewrites the URL to the surviving canonical IDs or removes `coins` entirely.

### Data dependencies

Compare combines multiple query sources:

- `/api/stablecoins` (`useStablecoins`)
- `/api/peg-summary` (`usePegSummary`)
- `/api/bluechip-ratings` (`useBluechipRatings`)
- `/api/dex-liquidity` (`useDexLiquidity`)
- `/api/report-cards` (`useReportCards`)
- `/api/mint-burn-flows` (`useMintBurnFlows`) for the shared flow dataset
- per-coin `/api/supply-history?stablecoin=<id>&days=1825` (via `useQueries`) for long-range supply charts
- per-coin `/api/mint-burn-flows?stablecoin=<id>&hours=<window>` (via `useQueries`) for comparison-specific flow panels

It also derives live peg references with `derivePegRates(...)` for commodity/non-USD normalization in displayed prices.

### Share and export

Compare includes client-side share/export rendering:

- Builds a canvas card via `src/lib/compare-share-image.ts`
- Supports clipboard image copy + Twitter intent flow
- Supports PNG download from the generated canvas

### Compare table context

`src/components/comparison-table.tsx` now applies the shared contextual methodology pattern to the comparison metrics that most often need interpretation help in a side-by-side view:

- `Peg Score`
- `Liquidity Score`
- `Safety Rating`

That pattern is used in both the stacked mobile cards and the desktop comparison table so cross-asset comparison no longer assumes the user already remembers every Pharos-specific metric definition.

## Operational notes

- Both pages are part of static export and rely on client-side fetches where applicable.
- Cemetery reliability depends on repository data curation (`shared/data/dead-stablecoins.json` via `shared/lib/dead-stablecoins.ts`).
- Cemetery Telegram notifications depend on the daily Telegram digest post plus `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`; additions are detected from the repo dataset, not from a separate API feed.
- Compare reliability depends on six independent API datasets plus per-coin supply-history and flow queries. The global stale/error UI covers stablecoins, peg summary, bluechip ratings, DEX liquidity, and report cards. The shared mint/burn dataset is consumed as data-only in the compare model; per-coin flow panels degrade by omission unless all selected flow queries fail, in which case the page shows a flow-specific error notice.
