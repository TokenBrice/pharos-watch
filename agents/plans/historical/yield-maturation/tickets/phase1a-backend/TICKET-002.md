---
title: "Add data-stale warning signal detection"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
---

## Goal

Detect coins whose yield data hasn't refreshed in 90+ minutes and mark them with a `data-stale` warning signal at cache-build time.

## Task

1. **`worker/src/cron/yield-helpers.ts`** — Add a new exported constant:
   ```ts
   export const STALE_THRESHOLD_MS = 90 * 60 * 1000; // 3 sync cycles
   ```
   Place it near the top of the file, after existing imports/constants.

2. **`worker/src/cron/sync-yield-data.ts`** — In the rankings cache-building section at line ~850, the `rankingsPayload` is built via `dedupeLatestBestRows(rankingsData.results ?? []).map((row) => ...)`. The stale detection must happen **inside this `.map()` callback**, because:
   - Raw DB rows have `row.updated_at` (Unix seconds) — this is the per-coin last-updated timestamp
   - The mapped ranking objects from `rowToRanking()` do NOT have an `updatedAt` property
   - `warningSignals` on the ranking object is already a `string[]` (parsed by `rowToRanking` → `parseWarningSignals`)

   Import `STALE_THRESHOLD_MS` from `./yield-helpers`, then modify the `.map()` callback at line ~851:
   ```ts
   const now = Date.now();
   const rankingsPayload = {
     rankings: dedupeLatestBestRows(rankingsData.results ?? []).map((row) => {
       const ranking = {
         ...rowToRanking(row),
         altSources: altSourcesByCoin.get(row.stablecoin_id as string) ?? [],
       };
       // Decorate with data-stale signal at read time (not persisted to yield_data)
       const updatedAtMs = typeof row.updated_at === "number" ? row.updated_at * 1000 : 0;
       if (updatedAtMs > 0 && updatedAtMs < now - STALE_THRESHOLD_MS) {
         if (!ranking.warningSignals.includes("data-stale")) {
           ranking.warningSignals = [...ranking.warningSignals, "data-stale"];
         }
       }
       return ranking;
     }),
     riskFreeRate,
     scalingFactor: PYS_SCALING_FACTOR,
     updatedAt: startSec,
   };
   ```
   - This is read-time decoration only — it does NOT write back to `yield_data`. The `data-stale` signal appears in the cached rankings JSON response but not in the DB.

## Acceptance Criteria

- `grep -c "STALE_THRESHOLD_MS" worker/src/cron/yield-helpers.ts` returns >= 1
- `grep -c "data-stale" worker/src/cron/sync-yield-data.ts` returns >= 1
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `npm run build` exits 0
