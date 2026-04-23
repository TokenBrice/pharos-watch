# Recent Comments Optimization Plan

Date: 2026-04-23
Owner: Codex
Status: in progress

## Source Review

- GitHub feedback issues `#73` through `#77`
- `agents/audits/codebase-simplification-audit.md`
- `gpt-5.4` `xhigh` subagent review notes from this implementation pass

## Assumptions

- “Recent comments” means the recent feedback issue threads plus the fresh local audit notes, since the latest merged PRs do not have review-thread comments.
- The current dirty worktree is unrelated user work. This remediation must stay on clean files only and commit only the new changes from this pass.
- The goal is the simplest root-cause fix, not a broader refactor.

## Success Criteria

- `/api/yield-history` no longer returns bootstrap seed rows that the yield scoring pipeline already excludes from rolling stats.
- Multi-query retry handlers stop silently treating fulfilled React Query error results as success.
- Compare-page retry also refreshes aggregate mint/burn flow data, not just the per-coin flow queries.
- Targeted regression coverage is added for both fixes.
- Validation passes on the touched frontend and worker surfaces before commit.

## Candidate Review

1. Yield-history bootstrap seed filtering
   - Strongest user-facing correctness fix from the recent yield feedback follow-up.
   - Clean worker-only surface with direct regression-test coverage.
2. Shared query-refetch helper
   - Fixes a real retry gap found in current hook code and removes repeated broken logic.
   - Clean frontend-only surface with focused unit coverage.
3. Pinned-row rank semantics / UX affordances
   - Worth future follow-up, but lower priority than the two correctness issues above.

## Selected Scope

### Workstream 1: Yield History Filtering

Files:

- `worker/src/lib/yield-utils.ts`
- `worker/src/cron/yield-sync/evaluation.ts`
- `worker/src/api/yield-history.ts`
- `worker/src/api/__tests__/yield-history.test.ts`

Plan:

- Extract the on-chain bootstrap-seed predicate into shared worker yield utilities.
- Reuse the predicate in both yield scoring and `yield-history` API shaping.
- Add API regression tests for both best-mode and source-mode history reads.

### Workstream 2: Query Refetch Group Helper

Files:

- `src/lib/query-refetch-group.ts`
- `src/lib/__tests__/query-refetch-group.test.ts`
- `src/hooks/use-compare-data-model.ts`
- `src/hooks/use-stablecoin-detail-view-model.ts`
- `src/hooks/use-chain-profile-data.ts`
- `src/components/homepage-client.tsx`
- `src/app/safety-scores/client.tsx`
- `src/app/depeg/client.tsx`
- `src/hooks/__tests__/use-chain-profile-data.test.tsx`
- `src/hooks/__tests__/use-compare-data-model.test.tsx`

Plan:

- Add one small React-free helper that executes grouped refetches and treats both rejected promises and fulfilled error-state query results as failures.
- Ignore cancellation-style failures to avoid noisy retry logs during superseded refetches.
- Reuse the helper in the current duplicated retry call sites.
- Include aggregate `useMintBurnFlows().refetch` in compare-page retry.
- Add focused tests for helper behavior and compare/chain-profile wiring.

## Validation Plan

- `npx vitest run worker/src/api/__tests__/yield-history.test.ts`
- `npx vitest run src/lib/__tests__/query-refetch-group.test.ts src/hooks/__tests__/use-chain-profile-data.test.tsx src/hooks/__tests__/use-compare-data-model.test.tsx`
- `npm run lint`
- `npm run typecheck`
- `cd worker && npx tsc --noEmit`

## Commit Plan

- Commit only the files from the selected scope.
- Leave unrelated dirty files untouched and uncommitted.
