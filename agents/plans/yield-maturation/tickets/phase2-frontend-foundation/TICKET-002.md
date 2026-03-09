---
title: "Create useYieldHistory hook"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "medium"
done: false
---

## Goal

Create a TanStack Query hook for fetching historical APY data for a single coin.

## Task

1. **Read `src/hooks/use-yield-rankings.ts`** — This is the reference pattern. Understand the imports, `useApiQuery` usage, and timing constants.

2. **Read `src/hooks/use-api-query.ts`** (or wherever `useApiQuery` is defined) — Understand the function signature and how stale time works.

3. **Create `src/hooks/use-yield-history.ts`:**
   ```ts
   import { useApiQuery } from "@/hooks/use-api-query";
   import { CRON_30MIN } from "@/lib/api";
   import type { YieldHistoryPoint } from "@shared/types";

   export function useYieldHistory(stablecoinId: string, days = 90) {
     return useApiQuery<YieldHistoryPoint[]>(
       ["yield-history", stablecoinId, days],
       `/api/yield-history?stablecoin=${encodeURIComponent(stablecoinId)}&days=${days}`,
       CRON_30MIN,
     );
   }
   ```

4. **Verify imports:**
   - Check that `@/hooks/use-api-query` is the correct import path by reading the existing hook
   - Check that `CRON_30MIN` is available from the same module (it's re-exported from `@/hooks/use-api-query` via `@/lib/cron-intervals`)
   - Check that `@shared/types` resolves correctly (some projects use `@shared/types` or `@/shared/types`)
   - Adjust import paths to match the conventions used in `use-yield-rankings.ts`

## Acceptance Criteria

- `test -f src/hooks/use-yield-history.ts` returns success
- `npm run build` exits 0
- The hook follows the exact same import pattern as `use-yield-rankings.ts`
