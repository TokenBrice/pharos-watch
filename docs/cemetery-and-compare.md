# Cemetery and Compare

## Overview

This document covers two frontend-only feature pages that are not backed by dedicated worker endpoints:

- `/cemetery` — static memorial dataset + interactive UI
- `/compare` — multi-source side-by-side stablecoin analysis

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

### UI behavior

- `CemeteryClient` maintains an `expanded` symbol set for obituary panels.
- Tombstone selection auto-expands the matching obituary and scrolls into view.
- `StablecoinCemetery` renders collapsible rows with source links and cause badges.
- `CemeteryCharts` computes all chart series directly from `DEAD_STABLECOINS` (no API fetch).

## Compare (`/compare`)

Primary files:
- `src/app/compare/page.tsx`
- `src/app/compare/client.tsx`
- `src/components/comparison-table.tsx`
- `src/components/comparison-chart.tsx`

### Selection and URL contract

- Maximum selection: `MAX_COINS = 5`.
- URL is the source of truth for selection state.
- Query param `coins` accepts:
  - canonical ticker-issuer IDs (primary format, e.g. `usdt-tether`)
  - lowercase symbols (legacy fallback)
  - legacy stablecoin IDs that resolve through `resolveStablecoinId(..., { allowLegacy: true })`

Selected state is normalized back to canonical IDs in the URL to avoid duplicate-symbol collisions and preserve shareable links.

### Data dependencies

Compare combines multiple query sources:

- `/api/stablecoins` (`useStablecoins`)
- `/api/peg-summary` (`usePegSummary`)
- `/api/bluechip-ratings` (`useBluechipRatings`)
- `/api/dex-liquidity` (`useDexLiquidity`)
- `/api/report-cards` (`useReportCards`)
- per-coin detail `/api/stablecoin/:id` (via `useQueries`) for supply history charts

It also derives live peg references with `derivePegRates(...)` for commodity/non-USD normalization in displayed prices.

### Share and export

Compare includes client-side share/export rendering:

- Builds a canvas card via `src/lib/compare-share-image.ts`
- Supports clipboard image copy + Twitter intent flow
- Supports PNG download from the generated canvas

## Operational notes

- Both pages are part of static export and rely on client-side fetches where applicable.
- Cemetery reliability depends on repository data curation (`shared/lib/dead-stablecoins.ts`).
- Compare reliability depends on five independent API datasets plus per-coin detail fetches; partial failures are surfaced via query error/stale-data UI components.
