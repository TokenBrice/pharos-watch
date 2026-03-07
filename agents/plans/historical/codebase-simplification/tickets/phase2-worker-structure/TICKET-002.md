---
title: "Consolidate 5 trivial cache-passthrough handler files into one"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "low"
done: false
---

## Goal

Merge 5 single-line cache-passthrough handler files into one `cache-handlers.ts` file and delete the originals.

## Task

1. **Create `worker/src/api/cache-handlers.ts`** with the following content:

   ```typescript
   import { createCacheHandler } from "../lib/api-utils";
   import { CACHE_PROFILES } from "../lib/constants";

   export const handleStablecoins = createCacheHandler("stablecoins", "stablecoins", CACHE_PROFILES.realtime, 600);

   export const handleStablecoinCharts = createCacheHandler("stablecoin-charts", "stablecoin-charts", CACHE_PROFILES.standard, 600);

   export const handleBluechipRatings = createCacheHandler("bluechip-ratings", "bluechip-ratings", CACHE_PROFILES.slow, 43200);

   export const handleUsdsStatus = createCacheHandler("usds-status", "usds-status", CACHE_PROFILES.standard, 86400);

   /**
    * GET /api/yield-rankings
    * Returns pre-computed yield rankings from cache (written by sync-yield-data cron).
    */
   export const handleYieldRankings = createCacheHandler(
     "yield-rankings",
     "yield-rankings",
     CACHE_PROFILES.standard,
     3600,
   );
   ```

2. **Delete these 5 files:**
   - `worker/src/api/stablecoins.ts`
   - `worker/src/api/stablecoin-charts.ts`
   - `worker/src/api/bluechip.ts`
   - `worker/src/api/usds-status.ts`
   - `worker/src/api/yield-rankings.ts`

3. **Update imports in `worker/src/router.ts`** (import block, lines 1-26):
   - Replace the 5 individual imports with one consolidated import:
     ```typescript
     import {
       handleStablecoins,
       handleStablecoinCharts,
       handleBluechipRatings,
       handleUsdsStatus,
       handleYieldRankings,
     } from "./api/cache-handlers";
     ```
   - The 5 imports to remove are:
     - `import { handleStablecoins } from "./api/stablecoins";` (line 1)
     - `import { handleStablecoinCharts } from "./api/stablecoin-charts";` (line 4)
     - `import { handleUsdsStatus } from "./api/usds-status";` (line 11)
     - `import { handleBluechipRatings } from "./api/bluechip";` (line 12)
     - `import { handleYieldRankings } from "./api/yield-rankings";` (line 26)
   - Keep all other imports unchanged.

4. **Update imports in `worker/src/api/__tests__/cache-passthrough.test.ts`** (lines 7-11):
   - This test file imports from the 5 deleted files. Replace with the consolidated import:
   - Before:
     ```typescript
     import { handleStablecoins } from "../stablecoins";
     import { handleStablecoinCharts } from "../stablecoin-charts";
     import { handleUsdsStatus } from "../usds-status";
     import { handleBluechipRatings } from "../bluechip";
     import { handleYieldRankings } from "../yield-rankings";
     ```
   - After:
     ```typescript
     import {
       handleStablecoins,
       handleStablecoinCharts,
       handleUsdsStatus,
       handleBluechipRatings,
       handleYieldRankings,
     } from "../cache-handlers";
     ```

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `test -f worker/src/api/cache-handlers.ts` exits 0 (new file exists)
- `test ! -f worker/src/api/stablecoins.ts` exits 0 (old file deleted)
- `test ! -f worker/src/api/stablecoin-charts.ts` exits 0
- `test ! -f worker/src/api/bluechip.ts` exits 0
- `test ! -f worker/src/api/usds-status.ts` exits 0
- `test ! -f worker/src/api/yield-rankings.ts` exits 0
- `grep -c "from.*cache-handlers" worker/src/router.ts` returns 1
