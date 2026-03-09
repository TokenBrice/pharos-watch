---
title: "Add automatic NULL price backfill to sync cron with observability counter"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
---

## Goal

At the end of each successful sync cycle, automatically backfill `amount_usd` for recent events that were synced without a price. Report the count in cron metadata as `nullPricesHealed`.

## Context

When the sync cron processes events, it resolves USD prices from `price_cache` and `supply_history`. If neither has a price (e.g., newly added coin, temporary price gap), `amount_usd` is stored as NULL. These events are invisible in flow aggregates.

Currently, fixing this requires manually calling the admin endpoint `POST /api/backfill-mint-burn-prices`. This ticket adds a self-healing step at the tail end of each cron cycle that catches recently-NULL events and fills in their prices.

The existing admin endpoint stays unchanged for historical backfills beyond the 48h window.

**Important:** The `price_cache` table uses `asset_id` as its column name (NOT `stablecoin_id`). The existing helper function `getPriceCache()` from `worker/src/lib/db.ts` already loads all prices into a `Map<string, { price: number; updatedAt: number }>` keyed by `asset_id` (which IS the stablecoin ID). Use this helper rather than raw SQL.

## Task

1. **Create `worker/src/lib/mint-burn-pipeline/price-heal.ts`:**
   ```typescript
   import { batchExecute, getPriceCache } from "../db";
   import type { MintBurnAffectedHour } from "./types";

   const LOOKBACK_SEC = 48 * 3600; // 48 hours

   interface PriceHealResult {
     healed: number;
     affectedHours: Map<string, MintBurnAffectedHour>;
   }

   /**
    * Find recent mint_burn_events with NULL amount_usd, resolve prices
    * from price_cache, and update. Returns count of healed events and
    * affected hours for re-aggregation.
    */
   export async function healNullPrices(
     db: D1Database,
     nowSec: number,
   ): Promise<PriceHealResult> {
     const cutoff = nowSec - LOOKBACK_SEC;

     const { results: nullEvents } = await db.prepare(
       `SELECT e.id, e.stablecoin_id, e.chain_id, e.amount, e.timestamp
        FROM mint_burn_events e
        WHERE e.amount_usd IS NULL AND e.timestamp >= ?
        LIMIT 500`
     ).bind(cutoff).all<{
       id: string;
       stablecoin_id: string;
       chain_id: string;
       amount: number;
       timestamp: number;
     }>();

     if (nullEvents.length === 0) {
       return { healed: 0, affectedHours: new Map() };
     }

     // Load all prices via existing helper (reads price_cache table keyed by asset_id)
     const prices = await getPriceCache(db);

     // Filter to events where we have a price
     const healable = nullEvents.filter((e) => prices.has(e.stablecoin_id));
     if (healable.length === 0) {
       return { healed: 0, affectedHours: new Map() };
     }

     const updateStmts = healable.map((e) => {
       const cached = prices.get(e.stablecoin_id)!;
       return db.prepare(
         `UPDATE mint_burn_events
          SET amount_usd = ?, price_used = ?, price_timestamp = ?, price_source = ?
          WHERE id = ? AND amount_usd IS NULL`
       ).bind(e.amount * cached.price, cached.price, cached.updatedAt, "price_cache_heal", e.id);
     });

     const healed = await batchExecute(db, updateStmts);

     // Collect affected hours for re-aggregation
     const affectedHours = new Map<string, MintBurnAffectedHour>();
     for (const e of healable) {
       const hourTs = Math.floor(e.timestamp / 3600) * 3600;
       const key = `${e.stablecoin_id}-${e.chain_id}-${hourTs}`;
       affectedHours.set(key, {
         stablecoinId: e.stablecoin_id,
         chainId: e.chain_id,
         hourTs,
       });
     }

     return { healed, affectedHours };
   }
   ```

2. **`worker/src/cron/sync-mint-burn.ts`**:
   - Add import near the top with other pipeline imports (around line 22-28):
     ```typescript
     import { healNullPrices } from "../lib/mint-burn-pipeline/price-heal";
     ```
   - After the main processing loop completes and before the metadata assembly (around line 605-610), add the auto-heal step:
     ```typescript
     // Auto-heal NULL prices for recent events (only on non-error runs)
     let nullPricesHealed = 0;
     if (status !== "error") {
       try {
         const healResult = await healNullPrices(db, Math.floor(Date.now() / 1000));
         nullPricesHealed = healResult.healed;
         if (healResult.affectedHours.size > 0) {
           await recalcAffectedHours(db, healResult.affectedHours);
         }
       } catch (e) {
         console.warn("[sync-mint-burn] Price heal failed (non-fatal):", e);
       }
     }
     ```
   - Note: `recalcAffectedHours` is already imported in this file (from `../lib/mint-burn-pipeline/persistence`). The `status` variable is already computed by this point in the function.
   - In the metadata JSON object (around line 612), add the counter:
     ```typescript
     nullPricesHealed,
     ```
     Place it alongside the other counter fields (e.g., after `burnClassification` or at the end of the object before the closing `}`).

3. **Create `worker/src/lib/__tests__/mint-burn-price-heal.test.ts`:**
   ```typescript
   import { describe, it, expect, vi, beforeEach } from "vitest";

   vi.mock("../db", () => ({
     batchExecute: vi.fn().mockResolvedValue(0),
     getPriceCache: vi.fn().mockResolvedValue(new Map()),
   }));

   import { healNullPrices } from "../mint-burn-pipeline/price-heal";
   import { batchExecute, getPriceCache } from "../db";

   const NOW = 1_700_000_000;
   const LOOKBACK = 48 * 3600;

   function mockDb(nullEvents: Array<{ id: string; stablecoin_id: string; chain_id: string; amount: number; timestamp: number }> = []) {
     return {
       prepare: (_sql: string) => ({
         bind: () => ({
           all: async () => ({ results: nullEvents }),
         }),
       }),
     } as unknown as D1Database;
   }

   describe("healNullPrices", () => {
     beforeEach(() => {
       vi.clearAllMocks();
     });

     it("returns healed=0 when no NULL events exist", async () => {
       const db = mockDb([]);
       const result = await healNullPrices(db, NOW);
       expect(result.healed).toBe(0);
       expect(result.affectedHours.size).toBe(0);
     });

     it("resolves prices from getPriceCache and returns correct healed count", async () => {
       const events = [
         { id: "e1", stablecoin_id: "usdc-circle", chain_id: "ethereum", amount: 1000, timestamp: NOW - 3600 },
         { id: "e2", stablecoin_id: "usdt-tether", chain_id: "ethereum", amount: 2000, timestamp: NOW - 7200 },
       ];
       const db = mockDb(events);
       vi.mocked(getPriceCache).mockResolvedValueOnce(
         new Map([
           ["usdc-circle", { price: 1.0, updatedAt: NOW }],
           ["usdt-tether", { price: 0.999, updatedAt: NOW }],
         ]),
       );
       vi.mocked(batchExecute).mockResolvedValueOnce(2);

       const result = await healNullPrices(db, NOW);
       expect(result.healed).toBe(2);
       expect(batchExecute).toHaveBeenCalledTimes(1);
     });

     it("skips events whose stablecoin has no price in price_cache", async () => {
       const events = [
         { id: "e1", stablecoin_id: "unknown-coin", chain_id: "ethereum", amount: 1000, timestamp: NOW - 3600 },
       ];
       const db = mockDb(events);
       vi.mocked(getPriceCache).mockResolvedValueOnce(new Map()); // no prices

       const result = await healNullPrices(db, NOW);
       expect(result.healed).toBe(0);
       expect(batchExecute).not.toHaveBeenCalled();
     });

     it("collects correct affected hours for re-aggregation", async () => {
       const events = [
         { id: "e1", stablecoin_id: "usdc-circle", chain_id: "ethereum", amount: 1000, timestamp: 3605 },
         { id: "e2", stablecoin_id: "usdc-circle", chain_id: "ethereum", amount: 2000, timestamp: 3610 },
         { id: "e3", stablecoin_id: "usdc-circle", chain_id: "ethereum", amount: 500, timestamp: 7205 },
       ];
       const db = mockDb(events);
       vi.mocked(getPriceCache).mockResolvedValueOnce(
         new Map([["usdc-circle", { price: 1.0, updatedAt: NOW }]]),
       );
       vi.mocked(batchExecute).mockResolvedValueOnce(3);

       const result = await healNullPrices(db, NOW);
       expect(result.affectedHours.size).toBe(2); // hour 3600 and hour 7200
     });
   });
   ```

## Acceptance Criteria

- `cd worker && npx vitest run src/lib/__tests__/mint-burn-price-heal.test.ts` — all tests pass
- `cd worker && npx tsc --noEmit` — no type errors
- `npm run build` — builds successfully
- `test -f worker/src/lib/mint-burn-pipeline/price-heal.ts` — module exists
- `grep -c 'healNullPrices' worker/src/cron/sync-mint-burn.ts` — returns at least 2 (import + call)
- `grep -c 'nullPricesHealed' worker/src/cron/sync-mint-burn.ts` — returns at least 1 (metadata field)
- `grep -c 'price_cache_heal' worker/src/lib/mint-burn-pipeline/price-heal.ts` — returns 1 (price_source value)
- `grep -c 'getPriceCache' worker/src/lib/mint-burn-pipeline/price-heal.ts` — returns at least 1 (uses existing helper)
