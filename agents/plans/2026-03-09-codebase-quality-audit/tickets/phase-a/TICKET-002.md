---
title: "Remove dead exports, unused props, and orphan constants from frontend code"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "medium"
done: false
---

## Goal

Clean up dead code in the frontend (`src/`) by removing unused exports, unused component props, and duplicate constants. Pure deletions — no behavior change.

## Context

The R1 audit identified 42 exports never imported anywhere in `src/`, several component props never passed by any consumer, and small constant duplications.

**Research findings addressed:**
- R1 Finding I1: Dead `StabilityIndex` export (-70 LOC)
- R1 Finding I2: 42 dead exports (-60 LOC)
- R1 Finding I3: Dead component props (-18 LOC)
- R1 Finding M1: Orphan doc comment in use-api-query (-4 LOC)
- R1 Finding M2: Duplicate DAY_MS constant (-1 LOC)
- R1 Finding M3: Duplicate PAGE_SIZE constant (-4 LOC)

## Task

### 1. Remove dead `StabilityIndex` component

In `src/components/stability-index.tsx`, the `StabilityIndex` component (exported around line 98) is never imported. Only `PsiLighthouse` from the same file is used. Remove the `StabilityIndex` component and any code only used by it (not shared with `PsiLighthouse`). Keep `PsiLighthouse` intact.

### 2. De-export unused type and value exports

For each of the following, remove the `export` keyword (keep the declaration if it's used locally, delete entirely if not used at all):

**Value exports to de-export (verify each is not imported before removing):**
- `src/lib/constants.ts`: `MINUTES_PER_HOUR`, `HOURS_PER_DAY`, `MS_PER_SECOND`, `WEEK_DAYS`, `YEAR_DAYS`
- `src/lib/data-health.ts`: `DataHealthState`, `QueryHealthInput`, `MergedDataHealth`
- `src/lib/data-health-config.ts`: `DataHealthPreset`
- `src/lib/yield-scatter.ts`: `ApyAxisConfig`
- `src/lib/severity-colors.ts`: `ScoreTier`
- `src/lib/nav-config.ts`: `NavGroup`
- `src/lib/compare-pages.ts`: `StaticComparisonPage`
- `src/lib/compare-share-image.ts`: `ShareRadarCoinData`
- `src/lib/mint-burn-timeframes.ts`: `MintBurnSummaryTimeframePreset`, `ResolvedMintBurnSummaryTimeframePreset`
- `src/lib/stablecoin-detail-derive.ts`: `SupplyHistoryEntry`, `PegReferenceContext`

**Hook type exports to de-export:**
- `src/hooks/use-api-query.ts`: `PollingQueryControlOptions`
- `src/hooks/use-digest-snapshot.ts`: `DigestSnapshotData`
- `src/hooks/use-portfolio.ts`: `PortfolioHolding`, `PortfolioState`
- `src/hooks/use-preferences.ts`: `ColumnDef`
- `src/hooks/use-sort.ts`: `SortState`
- `src/hooks/use-stability-index.ts`: `StabilityIndexCurrent`, `StabilityIndexHistoryPoint`, `StabilityIndexData`, `StabilityIndexDetailHistoryPoint`, `StabilityIndexDetailData`
- `src/hooks/use-stablecoin-detail-view-model.ts`: `StablecoinDetailReadyViewModel`, `StablecoinDetailViewModel`
- `src/hooks/use-stablecoins.ts`: `DetailToken`
- `src/hooks/use-stress-signals.ts`: `StressSignalEntry`
- `src/hooks/use-stress-test.ts`: `StressTestImpact`, `SystemicRisk`
- `src/hooks/use-table-pagination.ts`: `UseTablePaginationOptions`, `DerivedPagination`

**Component exports to de-export:**
- `src/components/stablecoin-detail/safety-score-history-section.tsx`: `formatSafetyScoreHistoryDate`
- `src/components/status/cron-config.ts`: `StatusCronGroupKey`, `StatusCronGroupDefinition`, `StatusCronDisplayMeta`

**IMPORTANT:** Before removing each export, verify it's truly unused by searching for imports across the entire `src/` directory. Some type exports may be used internally within the same file — in that case, just remove the `export` keyword, don't delete the declaration.

### 3. Remove unused component props

- `src/components/comparison-chart.tsx`: Remove unused `isLoading` prop from interface and component signature
- `src/components/mcap-chart.tsx`: Remove unused `className` prop from interface and component signature
- `src/components/daily-digest.tsx`: Remove unused `showCta` prop from interface and component signature
- `src/components/depeg-feed.tsx`: Remove unused `className` prop from interface and component signature
- `src/components/radar-chart.tsx`: Remove unused `className` prop from interface and component signature

### 4. Remove orphan doc comment

In `src/hooks/use-api-query.ts` around line 107, there's an unfinished commentary block at the end of the file documenting a non-existent API variant. Delete it.

### 5. Consolidate duplicate DAY_MS

In `src/components/yield-history-chart.tsx` around line 24, `DAY_MS` is redefined locally. Replace with an import from `src/lib/constants.ts` (where `DAY_MS` already exists at line 10).

### 6. Consolidate duplicate PAGE_SIZE

In `src/components/depeg-tracker-table.tsx`, `src/components/liquidity-table.tsx`, and `src/components/yield-leaderboard.tsx`, the constant `PAGE_SIZE = 25` is defined locally in each. Add `export const TABLE_PAGE_SIZE = 25` to `src/lib/constants.ts` and import it in all three files, removing the local definitions.

## Files Modified

- `src/components/stability-index.tsx`
- `src/lib/constants.ts`
- `src/lib/data-health.ts`
- `src/lib/data-health-config.ts`
- `src/lib/yield-scatter.ts`
- `src/lib/severity-colors.ts`
- `src/lib/nav-config.ts`
- `src/lib/compare-pages.ts`
- `src/lib/compare-share-image.ts`
- `src/lib/mint-burn-timeframes.ts`
- `src/lib/stablecoin-detail-derive.ts`
- `src/hooks/use-api-query.ts`
- `src/hooks/use-digest-snapshot.ts`
- `src/hooks/use-portfolio.ts`
- `src/hooks/use-preferences.ts`
- `src/hooks/use-sort.ts`
- `src/hooks/use-stability-index.ts`
- `src/hooks/use-stablecoin-detail-view-model.ts`
- `src/hooks/use-stablecoins.ts`
- `src/hooks/use-stress-signals.ts`
- `src/hooks/use-stress-test.ts`
- `src/hooks/use-table-pagination.ts`
- `src/components/stablecoin-detail/safety-score-history-section.tsx`
- `src/components/status/cron-config.ts`
- `src/components/comparison-chart.tsx`
- `src/components/mcap-chart.tsx`
- `src/components/daily-digest.tsx`
- `src/components/depeg-feed.tsx`
- `src/components/radar-chart.tsx`
- `src/components/yield-history-chart.tsx`
- `src/components/depeg-tracker-table.tsx`
- `src/components/liquidity-table.tsx`
- `src/components/yield-leaderboard.tsx`

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep -r 'export.*StabilityIndex' src/components/stability-index.tsx` returns nothing
- `grep -r 'PAGE_SIZE' src/components/depeg-tracker-table.tsx src/components/liquidity-table.tsx src/components/yield-leaderboard.tsx` shows imports, not local definitions
- No new exports were added (except `TABLE_PAGE_SIZE` in constants.ts)
