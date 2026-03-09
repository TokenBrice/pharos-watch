---
title: "Add backend tests for new reliability features"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "medium"
done: false
---

## Goal

Add unit tests for the new `STALE_THRESHOLD_MS` constant and the `matchAllDlPools` fallback behavior (if not already covered by TICKET-004).

## Task

1. **Read `worker/src/cron/__tests__/yield-helpers.test.ts`** to understand the existing test structure and conventions.

2. **Add tests:**

   a. Test `STALE_THRESHOLD_MS` value:
   ```ts
   describe("STALE_THRESHOLD_MS", () => {
     it("equals 90 minutes in milliseconds", () => {
       expect(STALE_THRESHOLD_MS).toBe(5_400_000);
     });
   });
   ```

   b. Verify the import: add `STALE_THRESHOLD_MS` to the import statement from `../yield-helpers`.

3. **Do NOT duplicate tests** already added by TICKET-004. Read the current test file to check what exists.

4. The `computeTvlWeightedMedianApy` function is private to `sync-yield-data.ts` and cannot be imported for testing. Do not attempt to test it directly. Note this in a comment:
   ```ts
   // computeTvlWeightedMedianApy is internal to sync-yield-data.ts — tested via integration
   ```

## Acceptance Criteria

- `npm test` exits 0
- `grep -c "STALE_THRESHOLD_MS" worker/src/cron/__tests__/yield-helpers.test.ts` returns >= 2 (import + test)
- `cd worker && npx tsc --noEmit` exits 0
- `npm run build` exits 0
