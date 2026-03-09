---
title: "Write warning_signals to yield_history and add medianApy to rankings cache"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
---

## Goal

(a) Persist computed warning signals in `yield_history` inserts. (b) Add a TVL-weighted median APY field to the cached rankings response.

## Task

### Part A: Warning signals in yield_history

1. **Read `worker/src/cron/sync-yield-data.ts`** — Find the `yield_history` INSERT statement at line ~783:
   ```sql
   INSERT OR IGNORE INTO yield_history (stablecoin_id, recorded_at, apy, apy_base, apy_reward, exchange_rate, source_tvl_usd, data_source)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ```

2. **Add `warning_signals`** as the 9th column:
   - Update the column list to include `warning_signals` at the end
   - Add a 9th `?` placeholder
   - Add `warningSignalsJson` to the `.bind()` call (this variable is already defined at line ~733: `const warningSignalsJson = warnings.length > 0 ? JSON.stringify(warnings) : null;`)
   - Result:
     ```sql
     INSERT OR IGNORE INTO yield_history (stablecoin_id, recorded_at, apy, apy_base, apy_reward, exchange_rate, source_tvl_usd, data_source, warning_signals)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ```
   - And `.bind(id, startSec, y.currentApy, y.apyBase, y.apyReward, y.exchangeRate, y.sourceTvlUsd, y.dataSource, warningSignalsJson)`

### Part B: TVL-weighted median APY in rankings cache

3. A simple (non-TVL-weighted) `medianApy` already exists at line ~617, computed from `resolvedApys`. We need a **TVL-weighted** median for the peer reference line. Add a helper function at the bottom of the file (after line ~972, not exported):

   ```ts
   function computeTvlWeightedMedianApy(
     rows: Array<{ apy_30d: number; source_tvl_usd: number | null }>
   ): number {
     const valid = rows.filter(
       (r) => r.source_tvl_usd && r.source_tvl_usd > 0 && r.apy_30d > 0
     );
     if (valid.length === 0) return 0;
     valid.sort((a, b) => a.apy_30d - b.apy_30d);
     const totalTvl = valid.reduce((s, r) => s + r.source_tvl_usd!, 0);
     let cumTvl = 0;
     for (const r of valid) {
       cumTvl += r.source_tvl_usd!;
       if (cumTvl >= totalTvl / 2) return r.apy_30d;
     }
     return valid[valid.length - 1].apy_30d;
   }
   ```

4. **In the cache-building section** at line ~850, the `rankingsPayload` object is built:
   ```ts
   const rankingsPayload = {
     rankings: dedupeLatestBestRows(rankingsData.results ?? []).map((row) => ({
       ...rowToRanking(row),
       altSources: altSourcesByCoin.get(row.stablecoin_id as string) ?? [],
     })),
     riskFreeRate,
     scalingFactor: PYS_SCALING_FACTOR,
     updatedAt: startSec,
   };
   ```

   - BEFORE building `rankingsPayload`, compute the TVL-weighted median from the raw DB rows:
     ```ts
     const tvlWeightedMedian = computeTvlWeightedMedianApy(
       (rankingsData.results ?? []) as Array<{ apy_30d: number; source_tvl_usd: number | null }>
     );
     ```
     Note: `rankingsData.results` contains raw D1 rows with **snake_case** column names (`apy_30d`, `source_tvl_usd`). The helper function's property names match these snake_case columns.

   - Add `medianApy: tvlWeightedMedian` to the `rankingsPayload` object:
     ```ts
     const rankingsPayload = {
       rankings: ...,
       riskFreeRate,
       scalingFactor: PYS_SCALING_FACTOR,
       medianApy: tvlWeightedMedian,
       updatedAt: startSec,
     };
     ```

5. **CRITICAL: Update the Zod schema** in `shared/types/index.ts` — The worker validates the rankings payload against `YieldRankingsResponseSchema` (at line ~860) before writing to cache. Zod's `.object()` strips unrecognized keys, so if `medianApy` is not in the schema, it will be silently removed from `validation.data` and never cached.

   - Find `YieldRankingsResponseSchema` (line ~1291) and add `medianApy`:
     ```ts
     export const YieldRankingsResponseSchema = z.object({
       rankings: z.array(YieldRankingSchema),
       riskFreeRate: z.number(),
       scalingFactor: z.number(),
       medianApy: z.number(),
       updatedAt: z.number(),
     });
     ```
   - Also add `medianApy: number` to the `YieldRankingsResponse` **interface** (line ~1284):
     ```ts
     export interface YieldRankingsResponse {
       rankings: YieldRanking[];
       riskFreeRate: number;
       scalingFactor: number;
       medianApy: number;
       updatedAt: number;
     }
     ```

## Acceptance Criteria

- The `yield_history` INSERT now has 9 columns (was 8) — `grep -c "warning_signals" worker/src/cron/sync-yield-data.ts` returns >= 3
- `grep -c "medianApy" worker/src/cron/sync-yield-data.ts` returns >= 1
- `grep -c "computeTvlWeightedMedianApy" worker/src/cron/sync-yield-data.ts` returns >= 2 (definition + call)
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `npm run build` exits 0
