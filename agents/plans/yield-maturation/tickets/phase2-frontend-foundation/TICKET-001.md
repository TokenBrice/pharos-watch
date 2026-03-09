---
title: "Update shared types for yield maturation"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "low"
done: false
---

## Goal

Add `medianApy` to `YieldRankingsResponse` and create/update `YieldHistoryPoint` type with `warningSignals`.

## Task

1. **Read `shared/types/index.ts`** — Find the yield-related type definitions.

2. **Verify `YieldRankingsResponse` already has `medianApy`:**
   - Phase 1A TICKET-005 added `medianApy: number` to both `YieldRankingsResponse` (interface) and `YieldRankingsResponseSchema` (Zod schema). Confirm it's present. If for any reason it's missing, add `medianApy: number;` to the interface and `medianApy: z.number()` to the schema.

3. **Create or update `YieldHistoryPoint`:**
   - Search for an existing `YieldHistoryPoint` interface in the file.
   - If it exists, add `warningSignals: string[];` to it.
   - If it does NOT exist, create it:
     ```ts
     export interface YieldHistoryPoint {
       date: string;
       apy: number;
       apyBase: number | null;
       apyReward: number | null;
       exchangeRate: number | null;
       sourceTvlUsd: number | null;
       warningSignals: string[];
     }
     ```
   - Place it near the other yield-related types.

## Acceptance Criteria

- `grep -c "medianApy" shared/types/index.ts` returns >= 1
- `grep -c "YieldHistoryPoint" shared/types/index.ts` returns >= 1
- `grep -c "warningSignals" shared/types/index.ts` returns >= 1
- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
