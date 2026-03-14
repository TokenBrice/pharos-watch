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

### Data model

Cemetery data is static and versioned in-repo (`DEAD_STABLECOINS`).

Each entry follows `DeadStablecoin` (`shared/types/index.ts`) with fields such as:
- identity (`name`, `symbol`, optional `llamaId`)
- context (`pegCurrency`, `causeOfDeath`, `deathDate`)
- narrative (`epitaph`, `obituary`, `sourceUrl`, `sourceLabel`)
- optional `peakMcap`

Cause metadata (labels + colors) is centralized in `CAUSE_META` / `CAUSE_HEX`.

### Telegram channel notifications

The cemetery dataset now has a worker-side notification path:

- `worker/src/cron/announce-cemetery-additions.ts`
- runs on the dedicated 5-minute Telegram trigger
- diffs the deployed `DEAD_STABLECOINS` list against a cached snapshot in D1
- seeds silently on first run so existing graves do not backfill into Telegram
- posts one consolidated channel message when a deploy adds one or more new cemetery entries

Each notification includes the epitaph for every newly added coin, plus a rotating darkly editorial footer line and a link to `/cemetery/`.

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
- `src/lib/compare-pages.ts`
- `src/lib/compare-share-image.ts`

### Selection and URL contract

- Maximum selection: `MAX_COMPARE_COINS = 5`.
- URL is the source of truth for selection state.
- Query param `coins` accepts:
  - canonical ticker-issuer IDs (primary format, e.g. `usdt-tether`)
  - legacy DefiLlama / historical IDs that still resolve through the shared ID registry
  - lowercase symbols (legacy fallback)
- Static comparison landing pages are generated from `STATIC_COMPARISON_PAGES` in `src/lib/compare-pages.ts` and live at `/compare/<left-id>-vs-<right-id>/`.

Selected state is normalized back to canonical IDs in the URL to avoid duplicate-symbol collisions and preserve shareable links.

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
- Cemetery reliability depends on repository data curation (`shared/lib/dead-stablecoins.ts`).
- Cemetery channel notifications depend on the 5-minute Telegram cron plus `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`; additions are detected from the repo dataset, not from a separate API feed.
- Compare reliability depends on six independent API datasets plus per-coin supply-history and flow queries; partial failures are surfaced via query error/stale-data UI components.
