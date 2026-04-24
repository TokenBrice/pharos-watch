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
