---
title: "Add MIN_ACTIVITY_USD gate to computeFlowIntensity"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
---

## Goal

Return `null` (NR) from `computeFlowIntensity()` when 24h absolute flow is below $50,000, preventing misleading pressure shift scores for low-activity coins.

## Context

The pressure shift formula uses a $1M floor denominator. For coins with very low daily volume (e.g., $20K/day), this floor is 50x their actual baseline. A single whale transaction can cause an outsized score swing. The fix: if total 24h activity is below a minimum threshold, return null (NR) — same pattern as the existing `MIN_DATA_DAYS` gate.

## Task

1. **`worker/src/lib/mint-burn-scoring.ts`** (line ~12, `FlowIntensityInput` interface):
   - Add a new optional field after `dataAgeDays` (line 20):
     ```typescript
     /** Current 24 h absolute flow (|mint| + |burn|), USD — used for activity gate */
     currentDailyAbs?: number;
     ```

2. **`worker/src/lib/mint-burn-scoring.ts`** (line ~26, constants):
   - Add new exported constant after `MIN_DATA_DAYS`:
     ```typescript
     export const MIN_ACTIVITY_USD = 50_000;
     ```

3. **`worker/src/lib/mint-burn-scoring.ts`** (line ~38, `computeFlowIntensity` function):
   - Add activity gate as the FIRST check in the function body, before the existing `MIN_DATA_DAYS` check at line 41:
     ```typescript
     if (input.currentDailyAbs !== undefined && input.currentDailyAbs < MIN_ACTIVITY_USD) return null;
     ```

4. **`worker/src/api/mint-burn-flows.ts`** (line ~439, `computeFlowIntensity` call site):
   - Add `currentDailyAbs` to the input object passed to `computeFlowIntensity`:
     ```typescript
     const intensity = has24hActivity && baseline
       ? computeFlowIntensity({
           currentDailyNet: netFlow24h,
           baselineDailyNet: baseline.avgNet,
           baselineDailyAbs: baseline.avgAbs,
           dataAgeDays: baseline.dataDays,
           currentDailyAbs: (agg?.mintVolume ?? 0) + (agg?.burnVolume ?? 0),
         })
       : null;
     ```
   - The variables `agg` (with `.mintVolume` and `.burnVolume`) are already in scope at this call site.

5. **`worker/src/lib/__tests__/mint-burn-scoring.test.ts`** (add to the `computeFlowIntensity` describe block):
   - Add three new test cases:

   ```typescript
   it("returns null when currentDailyAbs is below MIN_ACTIVITY_USD", () => {
     const result = computeFlowIntensity({
       currentDailyNet: 10_000,
       baselineDailyNet: 5_000,
       baselineDailyAbs: 20_000,
       dataAgeDays: 30,
       currentDailyAbs: 40_000, // below 50K threshold
     });
     expect(result).toBeNull();
   });

   it("returns score when currentDailyAbs meets MIN_ACTIVITY_USD", () => {
     const result = computeFlowIntensity({
       currentDailyNet: 100_000,
       baselineDailyNet: 50_000,
       baselineDailyAbs: 200_000,
       dataAgeDays: 30,
       currentDailyAbs: 150_000, // above 50K threshold
     });
     expect(result).not.toBeNull();
   });

   it("skips activity gate when currentDailyAbs is undefined (backward compat)", () => {
     const result = computeFlowIntensity({
       currentDailyNet: 100_000,
       baselineDailyNet: 50_000,
       baselineDailyAbs: 200_000,
       dataAgeDays: 30,
       // no currentDailyAbs — legacy callers
     });
     expect(result).not.toBeNull();
   });
   ```

## Acceptance Criteria

- `cd worker && npx vitest run src/lib/__tests__/mint-burn-scoring.test.ts` — all tests pass including 3 new activity gate tests
- `cd worker && npx tsc --noEmit` — no type errors
- `npm run build` — builds successfully
- `grep -c 'MIN_ACTIVITY_USD' worker/src/lib/mint-burn-scoring.ts` returns 2
- `grep -c 'currentDailyAbs' worker/src/lib/mint-burn-scoring.ts` returns at least 2
- `grep -c 'currentDailyAbs' worker/src/api/mint-burn-flows.ts` returns at least 1
