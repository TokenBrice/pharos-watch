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
