# Cemetery and Compare

## Overview

This document covers two frontend-only feature surfaces that are not backed by dedicated page-specific worker endpoints:

- `/cemetery` — static memorial dataset + interactive UI
- `/compare` — multi-source live compare tool
- `/compare/[slug]` — static comparison landing pages generated from tracked metadata

## Stablecoin Cemetery (`/cemetery`)

Primary files:
- `src/app/cemetery/page.tsx`
- `src/components/cemetery-client.tsx`
- `src/components/stablecoin-cemetery.tsx`
- `src/components/cemetery-tombstones.tsx`
- `src/components/cemetery-charts.tsx`
- `shared/lib/dead-stablecoins.ts`
- `shared/data/dead-stablecoins.json`
- `scripts/generate-cemetery-dataset.ts`
- `public/datasets/stablecoin-cemetery.json`
- `public/datasets/stablecoin-cemetery.csv`

### Data model

Cemetery data is static and versioned in-repo. The raw dataset lives in `shared/data/dead-stablecoins.json` and is validated/exported as `DEAD_STABLECOINS` by `shared/lib/dead-stablecoins.ts`.

Each entry follows `DeadStablecoin` (`shared/types/index.ts`) with fields such as:
- identity (`name`, `symbol`, optional `llamaId`)
- context (`pegCurrency`, `causeOfDeath`, `deathDate`)
- narrative (`epitaph`, `obituary`, `sourceUrl`, `sourceLabel`)
- optional `peakMcap`
- optional `contracts` — array of `{ chain, address }` for block-explorer links in the autopsy view

Cause metadata (labels + colors) is centralized in `CAUSE_META` / `CAUSE_HEX`.

### Public dataset export

`scripts/generate-cemetery-dataset.ts` publishes the curated cemetery dataset to static export files:

- `/datasets/stablecoin-cemetery.json`
- `/datasets/stablecoin-cemetery.csv`

The JSON export includes schema metadata, field descriptions, source-data path, canonical cemetery URL, source labels/URLs per row, and known historical token contracts when available. The CSV export mirrors the same row set with contracts flattened as `chain:address` pairs. Both exports are deterministic and sorted newest-failure first for citation/research reuse. `npm run prebuild` regenerates them, and `npm run check:cemetery-dataset` fails when checked-in public exports drift from `shared/data/dead-stablecoins.json`.

The `/cemetery/` page links directly to both exports from the route header so researchers and journalists can cite/download the dataset without inspecting the repository.

### Telegram channel notifications

The cemetery dataset now has a worker-side Telegram notification path:

- `worker/src/lib/telegram-digest-appendices.ts`
- runs as part of daily Telegram digest delivery
- diffs the deployed `DEAD_STABLECOINS` list against a cached snapshot in D1
- seeds silently on first run so existing graves do not backfill into Telegram
- appends one consolidated cemetery section to the next Telegram daily digest when a deploy adds one or more new entries

Each appendix includes the epitaph for every newly added coin plus a rotating darkly editorial footer line.

### UI behavior

- `CemeteryClient` maintains an `expanded` symbol set for obituary panels plus a local sort toggle (`newest` default, `oldest` fallback).
- Tombstones render newest death-year first by default even though `DEAD_STABLECOINS` remains curated in oldest-first order in-repo.
- `CemeteryTombstones` groups graves into explicit year sections while keeping each year in a single field; size still reflects peak market cap.
- Tombstone selection auto-expands the matching obituary and scrolls into view.
- `StablecoinCemetery` renders collapsible rows with source links and cause badges, using the same order as the tombstone field above.
- `CemeteryCharts` computes all chart series directly from `DEAD_STABLECOINS` (no API fetch).

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

- `src/app/compare/page.tsx` is the live comparison entry point. It uses `buildPageMetadata(...)` with canonical `/compare/`, serves through `createClientFeaturePage(...)`, and is intentionally `robots: { index: false, follow: true }`.
- `src/app/compare/[slug]/page.tsx` is the indexable static comparison surface. It statically generates params from `STATIC_COMPARISON_PAGES`, builds per-page metadata from each page descriptor, and calls `notFound()` for unknown slugs.
- Static comparison URLs follow `/compare/<left-id>-vs-<right-id>/`, with metadata/title/description derived from `src/lib/compare-pages.ts`.
- `src/app/cemetery/page.tsx` emits `CollectionPage` and `ItemList` JSON-LD for the defunct-stablecoin archive. Dead coins intentionally use `Thing` items rather than fabricated internal detail URLs.

### Selection and URL contract

- Maximum selection: `MAX_COMPARE_COINS = 5`.
- URL is the source of truth for selection state.
- Query param `coins` accepts:
  - canonical ticker-issuer IDs (primary format, e.g. `usdt-tether`)
  - legacy DefiLlama / historical IDs that still resolve through the shared ID registry
  - case-insensitive ticker symbols only when the symbol resolves uniquely; ambiguous symbols are rejected instead of guessing
- Query param `range` stores the market-cap chart window. Accepted values are `7d`, `30d`, `90d`, `1y`, and `all`; `all` is the default and is cleared from the URL instead of persisted.
- Static comparison landing pages are generated from `STATIC_COMPARISON_PAGES` in `src/lib/compare-pages.ts` and live at `/compare/<left-id>-vs-<right-id>/`.

Legacy coin tokens are resolved to canonical IDs in component state. The URL is rewritten with canonical IDs only when the user changes the selection or applies a preset; legacy `coins` params are not automatically rewritten on initial load.

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
