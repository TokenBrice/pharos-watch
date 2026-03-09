---
title: "Add cross-source validation logging"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "medium"
done: false
---

## Goal

Log an operational warning when a coin's native yield APY and auto-discovered lending APY diverge by more than 50%.

## Task

1. **Read `worker/src/cron/sync-yield-data.ts`** — Understand the data flow:
   - There is a `resolved` array built during yield resolution. Each entry has `{ id, yield, ... }` where `yield` contains `currentApy` and `dataSource`.
   - The per-source metric computation loop (starting around line ~650) iterates through resolved entries. Each `y` (the yield object) has `dataSource` (`"defillama"`, `"onchain"`, `"defillama-auto"`, `"price-derived"`).
   - There is NO pre-built `sourcesByCoin` structure. You will need to build one.

2. **Add cross-source validation** AFTER the per-source metric loop (around line ~792, before the batch write at line ~796). Insert:

   ```ts
   // Cross-source APY validation: flag >50% divergence between native and lending
   {
     const nativeApyByCoin = new Map<string, number>();
     const lendingApyByCoin = new Map<string, number>();
     for (const r of resolved) {
       if (!r.yield) continue;
       const ds = r.yield.dataSource;
       if (ds === "defillama" || ds === "onchain" || ds === "price-derived") {
         nativeApyByCoin.set(r.id, r.yield.currentApy);
       } else if (ds === "defillama-auto") {
         lendingApyByCoin.set(r.id, r.yield.currentApy);
       }
     }
     for (const [coinId, nativeApy] of nativeApyByCoin) {
       const lendingApy = lendingApyByCoin.get(coinId);
       if (lendingApy != null && nativeApy > 0 && lendingApy > 0) {
         const maxApy = Math.max(nativeApy, lendingApy);
         if (Math.abs(nativeApy - lendingApy) / maxApy > 0.5) {
           console.warn(
             `[yield-sync] APY divergence for ${coinId}: native=${nativeApy.toFixed(1)}% vs lending=${lendingApy.toFixed(1)}%`
           );
         }
       }
     }
   }
   ```

   - Read the code to verify the exact structure of `resolved` entries and the property names on the yield object. The properties might be named differently — adapt accordingly.
   - This is logging only — no data changes, no behavioral changes.

## Acceptance Criteria

- `grep -c "APY divergence" worker/src/cron/sync-yield-data.ts` returns >= 1
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `npm run build` exits 0
