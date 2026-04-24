# Cleanup Execution Notes

Date: 2026-04-24
Scope: implementation notes for `agents/plans/2026-04-24-website-maintainability-cleanup-plan.md`.

## Slice 0: Query-Contract Correctness

- Added blacklist sort fields to the `useBlacklistEventsPage()` query key so cached blacklist event pages are scoped by `sortBy` and `sortDirection`.
- Aligned `safetyScoreHistoryQueryOptions()` with `useSafetyScoreHistory()` by switching the prefetch builder to the meta-envelope query helper for the same query key.
- Added a hook-level blacklist query-key regression test and extended query-option builder coverage to prove safety-history prefetch uses `apiFetchWithMeta()`.
- Validation:
  - `npm test -- src/hooks/__tests__/query-option-builders.test.ts src/hooks/__tests__/use-safety-score-history.test.ts src/hooks/__tests__/use-blacklist-events.test.ts src/app/blacklist/view-model.test.tsx`
  - `npm run typecheck`
  - `npm run check:unused-code`
- Follow-up signal: query-option helpers now have stronger shape guarantees, but repo-wide cleanup should still look for key/response-shape drift outside the website scope.

## Slice 1: Supply-History Wrapper Removal

- Replaced the only `useStablecoinDetailHistory()` consumer with `useSupplyHistory()` directly in the total market-cap chart.
- Deleted `src/hooks/use-stablecoin-detail-history.ts`; this was a compatibility wrapper, not a reusable result-shape adapter.
- Follow-up signal: thin wrappers should only be removed when they are one-hop aliases with a proven direct consumer migration. Wider hook files still contain useful domain adapters and should not be blanket-collapsed.

## Slice 2: KPI Bar Presentation Split

- Moved KPI chips, cells, skeleton, mini tiles, PSI primary card, and tiny trend display helpers into `src/components/kpi-bar-parts.tsx`.
- Left data fetching, snapshot derivation, error handling, animation sequencing, and metric-definition assembly in `src/components/kpi-bar.tsx`.
- Removed the stale hotspot waiver for `src/components/kpi-bar.tsx` after the component fell below the waived hotspot threshold.
- Validation:
  - `npm test -- src/components/__tests__/kpi-bar.test.tsx`
  - `npm run typecheck`
  - `npm run check:hotspot-ratchet`
- Follow-up signal: the hotspot ratchet updater can refresh unrelated baseline entries when other committed files have drifted. Keep metadata commits scoped manually when executing a narrow slice.

## Slice 3: DEX Liquidity Card Parts Split

- Moved DEX liquidity table, breakdown bars, TVL chart, pool source label, trend arrow, score breakdown, and durability/organic/stress badges into `src/components/dex-liquidity-card-parts.tsx`.
- Kept `src/components/dex-liquidity-card.tsx` as the card shell that owns loading/empty states, score header, top health summary, and market-structure composition.
- Removed the stale hotspot waiver for `src/components/dex-liquidity-card.tsx` after the card shell shrank below the waived threshold.
- Added a hotspot waiver for pre-existing `worker/src/api/mint-burn-flows.ts` because the global ratchet surfaced it while validating this slice. No worker code changed; the waiver points it at the repo-wide follow-up lane.
- Validation:
  - `npm test -- src/components/__tests__/dex-liquidity-card.test.tsx`
  - `npm run typecheck`
  - `npm run check:hotspot-ratchet`
  - `npm run check:unused-code`
- Follow-up signal: final repo-wide cleanup should decide whether `worker/src/api/mint-burn-flows.ts` is a real P1 handler decomposition candidate or just needs ownership metadata refinement.

## Slice 4: Command Palette Pure Model Extraction

- Added `src/components/command-palette-model.ts` for pure fuzzy matching, command action descriptors, page catalog composition, and result grouping order.
- Kept dialog rendering, global shortcut listeners, selected-index state, focus capture/restoration, scroll-into-view, and keyboard handling in `src/components/command-palette.tsx`.
- Added unit coverage for matching, action descriptor output, and grouping order.
- Validation:
  - `npm test -- src/hooks/__tests__/use-command-palette-history.test.ts src/components/__tests__/command-palette-model.test.ts`
  - `npm run typecheck`
  - `npm run check:hotspot-ratchet`
- Follow-up signal: a later interaction-test pass is still needed before moving keyboard/focus behavior out of `command-palette.tsx`.

## Slice 5: Controlled Filter Search Primitive

- Added `src/components/filter-search-input.tsx` as a controlled visual wrapper for search-icon/input layout.
- Reused it in depeg, liquidity, and blacklist route controls while keeping each route's URL, debounce, analytics, page-reset, and filtering semantics owned by the caller.
- Validation:
  - `npm test -- src/app/blacklist/view-model.test.tsx src/app/depeg/page.test.tsx src/hooks/__tests__/use-depeg-events.test.tsx src/components/__tests__/depeg-table-logic.test.ts src/components/__tests__/table-toolbar.test.tsx src/lib/liquidity-ui.test.ts src/components/__tests__/liquidity-table-logic.test.ts src/components/__tests__/liquidity-table.test.ts src/components/__tests__/liquidity-stats.test.ts`
  - `npm run typecheck`
  - `npm run check:unused-code`
- Follow-up signal: `q=all` behavior is still inherited from the current URL-filter semantics. Any attempt to centralize URL/debounce behavior should first add explicit route-state tests for that sentinel case.

## Slice 6: Taxonomy Hub Route Descriptors

- Added `STABLECOIN_TAXONOMY_HUB_ROUTES` plus total and breadcrumb helpers to `src/lib/stablecoin-taxonomy.ts`.
- Converted backing, governance, and infrastructure hub pages into thin Next entrypoints over that descriptor table.
- Kept dynamic slug routes on the existing static-slug helpers.
- Validation:
  - `npm run typecheck`
  - `npm test -- src/lib/__tests__/stablecoin-taxonomy.test.ts src/app/stablecoins`
- Follow-up signal: the taxonomy descriptor is intentionally limited to hub routes. `/stablecoins/[peg]/` should only join a wider descriptor if SEO metadata equivalence tests are added first.

## Slice 7: Coverage Feature Definition Extraction

- Moved the static `COVERAGE_FEATURES` table into `src/lib/coverage-features.ts`.
- Split shared coverage types into `src/lib/coverage-types.ts` after `check:shared-cycles` caught a type-import cycle between `coverage.ts` and `coverage-features.ts`.
- Left coverage status resolvers, row construction, summary derivation, and breakdown text in `src/lib/coverage.ts`.
- Validation:
  - `npm test -- src/lib/__tests__/coverage.test.ts src/app/coverage/coverage-filtering.test.ts`
  - `npm run typecheck`
  - `npm run check:hotspot-ratchet`
  - `npm run check:unused-code`
  - `npm run check:shared-cycles`
  - `npm run check:duplicate-exports`
- Follow-up signal: the next safe coverage split is status presets/resolvers, but it should preserve exact labels and breakdown strings because they feed visible coverage copy.
