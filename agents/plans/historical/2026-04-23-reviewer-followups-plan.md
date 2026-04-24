# Reviewer Follow-Ups Plan

Date: 2026-04-23
Owner: Codex
Status: in progress

## Source Review

- `gpt-5.4` reviewer notes gathered during the recent-comments optimization pass
- `agents/audits/codebase-simplification-audit.md`

## Assumptions

- “Reviewers” refers to the outstanding reviewer recommendations from the prior implementation pass, not to new GitHub review-thread comments.
- The current dirty `alt-pegs` worktree changes are unrelated user work and must remain untouched.
- This pass should stay on clean, localized surfaces and ship as a separate commit.

## Success Criteria

- Grade History shows freshness context using the already-available API freshness metadata.
- Excess-yield benchmark wording no longer uses hardcoded `Ref` copy and is derived from one shared helper path.
- Pinned stablecoins can still float to the top without overwriting the meaning of the rank column.
- Focused regression coverage exists for the touched behavior.

## Selected Scope

### Workstream 1: Grade History Freshness

Files:

- `src/hooks/api-hooks.ts`
- `src/hooks/__tests__/use-safety-score-history.test.ts`
- `src/components/stablecoin-detail/safety-score-history-section.tsx`
- `src/components/__tests__/safety-score-history-section.test.tsx`

Plan:

- Keep API freshness metadata in `useSafetyScoreHistory`.
- Render a small freshness chip in the Grade History card header when freshness metadata is available.

### Workstream 2: Excess-Yield Benchmark Copy

Files:

- `src/lib/yield-benchmark.ts`
- `src/lib/__tests__/yield-benchmark.test.ts`
- `src/components/yield-detail-section-model.ts`
- `src/components/stablecoin-detail/hero-card.tsx`
- `src/components/stablecoin-detail/__tests__/hero-card.test.tsx`

Plan:

- Add a shared helper for “30d vs benchmark” / “No 30d benchmark gap” wording.
- Reuse it in the hero chip and detail-section model so benchmark copy stops drifting.

### Workstream 3: Pinned Rank Semantics

Files:

- `src/components/stablecoin-table.tsx`
- `src/components/stablecoin-table-row.tsx`
- `src/components/__tests__/stablecoin-table.test.tsx`

Plan:

- Preserve the display order from pinning, but render the rank column from the pre-pin sorted order.
- Add a regression test covering a pinned row floated above a higher-ranked row.

## Validation Plan

- `npx vitest run src/hooks/__tests__/use-safety-score-history.test.ts src/components/__tests__/safety-score-history-section.test.tsx`
- `npx vitest run src/lib/__tests__/yield-benchmark.test.ts src/components/stablecoin-detail/__tests__/hero-card.test.tsx`
- `npx vitest run src/components/__tests__/stablecoin-table.test.tsx`
- targeted `eslint` on touched files

## Commit Plan

- Commit only the files from this reviewer-follow-up scope.
- Leave unrelated dirty files and untracked design/audit artifacts untouched.
