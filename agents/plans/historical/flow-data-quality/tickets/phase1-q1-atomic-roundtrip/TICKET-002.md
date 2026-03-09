---
title: "Exclude atomic roundtrips from aggregation, integrate into cron, add admin endpoint"
agent: "codex"
model: "gpt-5.4"
reasoning_effort: "high"
done: false
---

## Goal

Update hourly aggregation to exclude `atomic_roundtrip` events, integrate detection into the sync cron pipeline, add an observability counter to metadata, and create an admin endpoint for retroactive classification of existing events.

## Context

TICKET-001 added the `flow_type` column, the detection function `detectAtomicRoundtrips()`, and updated the INSERT to include `flow_type`. This ticket wires it all together:
- The hourly aggregation query must filter out `flow_type = 'atomic_roundtrip'` events
- The cron must call detection between parse and insert
- The metadata must report how many roundtrips were detected
- An admin endpoint allows retroactive classification of historical data

**Important codebase conventions for admin endpoints:**
- Handlers use `withErrorHandler` from `../lib/api-utils` and `requireAdmin` from `../lib/auth`
- Handler signature: `(db: D1Database, url: URL, adminKey: string | undefined, request?: Request)`
- Use `db` directly — NOT `env.DB`. There is no `Env` type import for API handlers.
- Routes registered in `worker/src/router.ts` via `STATIC_ROUTE_HANDLERS` Map (NOT `http.ts`)
- Endpoints also declared in `shared/lib/api-endpoints.ts` in `ENDPOINT_DEFINITIONS`
- Admin actions wrapped with `runIdempotentAdminAction` from `../lib/idempotency`
- Responses use `jsonResponse()` from `../lib/api-utils` (NOT `Response.json()`)

## Task

1. **`worker/src/lib/mint-burn-pipeline/persistence.ts`** (line ~86, `recalcAffectedHours` SQL):
   - The aggregation query currently has conditions like `direction = 'mint'` and `direction = 'burn' AND burn_type = 'effective_burn'`. Add `AND flow_type = 'standard'` to ALL CASE conditions. The updated SELECT should be:
     ```sql
     SELECT
      stablecoin_id,
      chain_id,
      (timestamp / 3600) * 3600 AS hour_ts,
      SUM(CASE WHEN direction = 'mint' AND flow_type = 'standard' THEN 1 ELSE 0 END),
      SUM(CASE WHEN direction = 'burn' AND burn_type = 'effective_burn' AND flow_type = 'standard' THEN 1 ELSE 0 END),
      COALESCE(SUM(CASE WHEN direction = 'mint' AND flow_type = 'standard' THEN amount_usd ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN direction = 'burn' AND burn_type = 'effective_burn' AND flow_type = 'standard' THEN amount_usd ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN direction = 'mint' AND flow_type = 'standard' THEN amount_usd
                   WHEN direction = 'burn' AND burn_type = 'effective_burn' AND flow_type = 'standard' THEN -amount_usd ELSE 0 END), 0)
     FROM mint_burn_events
     WHERE stablecoin_id = ? AND chain_id = ?
       AND timestamp >= ? AND timestamp < ?
     GROUP BY stablecoin_id, chain_id, hour_ts
     ```

2. **`worker/src/cron/sync-mint-burn.ts`**:
   - Add import at the top of the file, near the other pipeline imports (around line 22):
     ```typescript
     import { detectAtomicRoundtrips } from "../lib/mint-burn-pipeline/roundtrip-detection";
     ```
   - Declare a counter variable alongside the existing counters (`rowsInserted`, `rowsParsed`, etc. — look for where these are initialized, likely around lines 200-210):
     ```typescript
     let atomicRoundtripsTotal = 0;
     ```
   - **IMPORTANT — detection placement:** The cron processes events per `eventDef` (one eventDef may cover mints only, another burns only). Roundtrip detection needs to see ALL parsed rows for a config to find mint+burn pairs in the same tx. The detection call must go AFTER the `for (const { eventDef, logs } of allConfigLogs)` loop ends (line ~526), NOT inside it.

     The approach: accumulate parsed rows in a first pass (with bridge classification preserved per-eventDef to maintain Alchemy budget batching), then run detection on accumulated rows, then insert.

     Here's the rewrite for the `allConfigLogs` processing block (lines ~481-526). Replace the existing loop body:

     ```typescript
     // Phase 1: Parse + classify bridge burns per eventDef (preserves Alchemy budget batching)
     const allParsedRows: MintBurnRow[] = [];

     for (const { eventDef, logs } of allConfigLogs) {
       const parsed = parseMintBurnLogs(
         config,
         eventDef,
         logs,
         blockTimestamps,
         prices,
         priceHistory,
         runTimestamp,
       );

       rowsDropped += parsed.dropped;
       summary.rowsDropped += parsed.dropped;

       rowsParsed += parsed.rows.length;
       summary.rowsParsed += parsed.rows.length;

       // Bridge classification stays per-eventDef to preserve Alchemy budget batching
       const burnCounts = await classifyBridgeBurnRows(
         parsed.rows,
         config,
         alchemyUrl,
         budget,
         txContextCache,
         signal,
       );
       effectiveBurns += burnCounts.effectiveBurns;
       bridgeBurns += burnCounts.bridgeBurns;
       reviewBurns += burnCounts.reviewBurns;

       allParsedRows.push(...parsed.rows);
     }

     // Phase 2: Detect atomic roundtrips across ALL eventDefs for this config
     // Must see all rows to find mint+burn pairs in the same tx
     const roundtripsDetected = detectAtomicRoundtrips(allParsedRows);
     atomicRoundtripsTotal += roundtripsDetected;

     // Phase 3: Track, collect, insert
     for (const row of allParsedRows) {
       summary.maxBlockSeen = Math.max(summary.maxBlockSeen, row.block_number);
     }
     collectAffectedHours(allParsedRows, affectedHours);

     if (allParsedRows.length > 0) {
       const insertResult = await insertMintBurnRows(db, allParsedRows);

       rowsInserted += insertResult.inserted;
       rowsIgnored += insertResult.ignored;

       summary.rowsInserted += insertResult.inserted;
       summary.rowsIgnored += insertResult.ignored;

       await updateBurnClassifications(db, allParsedRows);
     }
     ```

     You'll also need to add the import for `MintBurnRow` type if not already imported:
     ```typescript
     import type { MintBurnRow } from "../lib/mint-burn-pipeline/types";
     ```

   - In the metadata JSON object (around line 612), add after the `burnClassification` field:
     ```typescript
     atomicRoundtripsDetected: atomicRoundtripsTotal,
     ```

3. **Create `worker/src/api/reclassify-atomic-roundtrips.ts`:**
   ```typescript
   import { requireAdmin } from "../lib/auth";
   import { withErrorHandler, jsonResponse } from "../lib/api-utils";
   import { recalcAffectedHours } from "../lib/mint-burn-pipeline/persistence";
   import type { MintBurnAffectedHour } from "../lib/mint-burn-pipeline/types";

   const BATCH_SIZE = 1000;

   /**
    * POST /api/reclassify-atomic-roundtrips (admin)
    * Retroactively classifies existing events where the same tx_hash contains
    * both mints and burns for the same stablecoin. Processes BATCH_SIZE tx groups
    * per call. Returns { done: true } when no more roundtrips remain.
    */
   export const handleReclassifyAtomicRoundtrips = withErrorHandler(
     "reclassify-atomic-roundtrips",
     async (db: D1Database, _url: URL, adminKey: string | undefined, request?: Request): Promise<Response> => {
       const authErr = await requireAdmin(request, adminKey);
       if (authErr) return authErr;

       const { results: roundtripTxs } = await db.prepare(
         `SELECT tx_hash, stablecoin_id
          FROM mint_burn_events
          WHERE flow_type = 'standard'
          GROUP BY tx_hash, stablecoin_id
          HAVING COUNT(DISTINCT direction) > 1
          LIMIT ?`
       ).bind(BATCH_SIZE).all<{ tx_hash: string; stablecoin_id: string }>();

       if (roundtripTxs.length === 0) {
         return jsonResponse({ done: true, updated: 0 });
       }

       const affectedHours = new Map<string, MintBurnAffectedHour>();
       let updated = 0;

       for (const { tx_hash, stablecoin_id } of roundtripTxs) {
         const { results: events } = await db.prepare(
           `SELECT chain_id, timestamp FROM mint_burn_events
            WHERE tx_hash = ? AND stablecoin_id = ? AND flow_type = 'standard'`
         ).bind(tx_hash, stablecoin_id).all<{ chain_id: string; timestamp: number }>();

         for (const event of events) {
           const hourTs = Math.floor(event.timestamp / 3600) * 3600;
           const key = `${stablecoin_id}-${event.chain_id}-${hourTs}`;
           affectedHours.set(key, { stablecoinId: stablecoin_id, chainId: event.chain_id, hourTs });
         }

         const result = await db.prepare(
           `UPDATE mint_burn_events
            SET flow_type = 'atomic_roundtrip'
            WHERE tx_hash = ? AND stablecoin_id = ? AND flow_type = 'standard'`
         ).bind(tx_hash, stablecoin_id).run();
         updated += result.meta.changes ?? 0;
       }

       await recalcAffectedHours(db, affectedHours);

       return jsonResponse({
         done: roundtripTxs.length < BATCH_SIZE,
         updated,
         hoursRecalculated: affectedHours.size,
         batchSize: BATCH_SIZE,
       });
     },
   );
   ```

4. **Register the admin endpoint** — two files must be updated:

   **4a. `shared/lib/api-endpoints.ts`** — Add to the `ENDPOINT_DEFINITIONS` array (near the other mint-burn admin endpoints, around the `backfill-mint-burn` entries):
   ```typescript
   {
     path: "/api/reclassify-atomic-roundtrips",
     methods: ["POST"],
     adminRequired: true,
     mutatingAdmin: true,
     cacheBypass: true,
     probeGroup: "manual",
   },
   ```

   **4b. `worker/src/router.ts`** — Add import at the top alongside other mint-burn imports:
   ```typescript
   import { handleReclassifyAtomicRoundtrips } from "./api/reclassify-atomic-roundtrips";
   ```
   Add to `STATIC_ROUTE_HANDLERS` Map, near the other mint-burn entries (after `backfill-mint-burn`):
   ```typescript
   ["/api/reclassify-atomic-roundtrips", ({ db, url, adminKey, request }) => runIdempotentAdminAction(
     db,
     "reclassify-atomic-roundtrips",
     request,
     () => handleReclassifyAtomicRoundtrips(db, url, adminKey, request),
   )],
   ```

5. **Update tests in `worker/src/lib/__tests__/mint-burn-pipeline.test.ts`:**
   - The `makeRow()` helper was already updated in TICKET-001 to include `flow_type: "standard"`.
   - Add a test case to verify aggregation excludes atomic roundtrips. The test should insert rows with `flow_type = 'atomic_roundtrip'` and confirm they are NOT counted in hourly aggregation results.

## Acceptance Criteria

- `cd worker && npx vitest run src/lib/__tests__/mint-burn-pipeline.test.ts` — all tests pass
- `cd worker && npx vitest run src/lib/__tests__/mint-burn-roundtrip.test.ts` — all tests pass
- `cd worker && npx tsc --noEmit` — no type errors
- `npm run build` — builds successfully
- `grep -c "flow_type = 'standard'" worker/src/lib/mint-burn-pipeline/persistence.ts` — returns 5 (one per CASE clause in aggregation)
- `grep -c 'detectAtomicRoundtrips' worker/src/cron/sync-mint-burn.ts` — returns at least 2 (import + call)
- `grep -c 'atomicRoundtripsDetected' worker/src/cron/sync-mint-burn.ts` — returns at least 1
- `test -f worker/src/api/reclassify-atomic-roundtrips.ts` — admin endpoint file exists
- `grep -c 'reclassify-atomic-roundtrips' worker/src/router.ts` — returns at least 1 (route registration)
- `grep -c 'reclassify-atomic-roundtrips' shared/lib/api-endpoints.ts` — returns at least 1 (endpoint definition)
