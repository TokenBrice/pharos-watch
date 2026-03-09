---
title: "Graceful per-coin fallback on missing DL pool UUID"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
---

## Goal

When a coin's statically-mapped DeFiLlama pool UUID is absent from the DL response, log a warning and allow fallthrough to Layer 2/3 instead of returning no match.

## Task

1. **Read `worker/src/cron/yield-helpers.ts`** — Study the `matchAllDlPools` function carefully (around line 81-130). Understand how Layer 1 (static map lookup), Layer 2 (variant symbol), and Layer 3 (base symbol fallback) work.

2. **Modify `matchAllDlPools`** in `worker/src/cron/yield-helpers.ts`:
   - In Layer 1: when a `poolMap` entry exists for the coin (the UUID is in the map) but `dlPools.find(p => p.pool === uuid)` returns undefined (the UUID is not in the DL response), log a warning and continue to Layer 2 instead of returning an empty/no result:
     ```ts
     console.warn(`[yield-sync] Pool UUID ${uuid} for ${stablecoinId} not found in DL response, falling through`);
     ```
   - Make sure this does NOT change behavior when the UUID IS found in dlPools — that path should work exactly as before.
   - Make sure Layers 2 and 3 still execute as fallbacks when Layer 1 produces no matches.

3. **Add test in `worker/src/cron/__tests__/yield-helpers.test.ts`:**
   - Add a test case within the `matchAllDlPools` describe block:
     ```ts
     it("falls through to symbol match when static map UUID is missing from DL pools", () => {
       const poolMap = { "test-coin": "missing-uuid-123" };
       const dlPools = [
         { pool: "other-uuid", symbol: "TEST", project: "aave", stablecoin: true, exposure: "single", tvlUsd: 1000000, apy: 5.0, apyBase: 5.0, apyReward: null },
       ];
       const result = matchAllDlPools("test-coin", "TEST", dlPools, poolMap, {});
       expect(result.length).toBeGreaterThan(0);
       expect(result[0].pool).toBe("other-uuid");
     });
     ```
   - Adapt the test data structure to match the actual `dlPools` shape used in existing tests. Read the existing test file first to match conventions.

## Acceptance Criteria

- `grep -c "not found in DL response" worker/src/cron/yield-helpers.ts` returns >= 1
- `npm test` exits 0 (including the new test)
- `cd worker && npx tsc --noEmit` exits 0
- `npm run build` exits 0
