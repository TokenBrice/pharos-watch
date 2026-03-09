---
title: "Expand bridge address list and add retroactive reclassification endpoint"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
---

## Goal

Expand bridge burn detection from CCIP-only (5 tokens) to cover 6 bridge protocols by adding verified Ethereum contract addresses. Create an admin endpoint for retroactive reclassification of existing burn events.

## Context

Currently, only 5 tokens have bridge detection via CCIP (Chainlink Cross-Chain Interoperability Protocol). Burns to other bridge protocols (Stargate, Across, Wormhole, Axelar, Hyperlane) are miscounted as `effective_burn`, inflating burn volumes.

The existing bridge classifier in `worker/src/lib/mint-burn-bridge-classifier.ts` works by matching the burn `counterparty` address against a list of known bridge pool addresses. When a match is found WITH a bridge signal (topic/selector), it classifies as `bridge_burn`. When matched WITHOUT a bridge signal, it classifies as `review_required`. No logic changes are needed — we just need to expand the address list.

For non-CCIP bridges, we won't have bridge signal topics/selectors, so burns to these addresses will be classified as `review_required` (conservative — matches "known-bridge-pool-without-bridge-signal" reason). This is correct behavior.

**Important codebase conventions for admin endpoints:**
- Handlers use `withErrorHandler` from `../lib/api-utils` and `requireAdmin` from `../lib/auth`
- Handler signature: `(db: D1Database, url: URL, adminKey: string | undefined, request?: Request)`
- Use `db` directly — NOT `env.DB`. There is no `Env` type import for API handlers.
- Routes registered in `worker/src/router.ts` via `STATIC_ROUTE_HANDLERS` Map (NOT `http.ts`)
- Endpoints also declared in `shared/lib/api-endpoints.ts` in `ENDPOINT_DEFINITIONS`
- Admin actions wrapped with `runIdempotentAdminAction` from `../lib/idempotency`
- Responses use `jsonResponse()` from `../lib/api-utils` (NOT `Response.json()`)

## Task

1. **`worker/src/lib/mint-burn-contracts.ts`** (around line 78, near `ccipBridgeDetection()`):
   - Add a new **exported** factory function:
     ```typescript
     /**
      * Counterparty-only bridge detection: classifies burns sent to known
      * bridge pool/router addresses. Since we don't detect protocol-specific
      * event signatures for non-CCIP bridges, matching burns will be classified
      * as 'review_required' (conservative).
      */
     export function counterpartyBridgeDetection(
       knownBridgePoolAddresses: string[],
     ): MintBurnBridgeDetectionConfig {
       return {
         protocol: "ccip", // reuses existing classification logic
         knownBridgePoolAddresses,
         knownBridgeRouterAddresses: [],
         bridgeSignalTopics: [],
         bridgeSignalSelectors: [],
       };
     }
     ```
     Note: the function MUST be exported so tests can import it.

   - Add a file-level doc comment above the `MINT_BURN_CONFIGS` array documenting bridge coverage:
     ```typescript
     /**
      * Bridge detection coverage (last verified: YYYY-MM-DD):
      * - CCIP (Chainlink): USDC, ZCHF, USD1, avUSD, USDO — full signal detection
      * - Stargate v2 (LayerZero): USDT, USDC — counterparty-only
      * - Across v3: USDC, USDT, DAI — counterparty-only
      * - Wormhole: USDC — counterparty-only
      * - Axelar: USDC — counterparty-only
      * - Hyperlane: USDC — counterparty-only
      */
     ```

   - For major stablecoins that don't already have bridge detection, add `bridgeDetection: counterpartyBridgeDetection([...])` to their config entry. The specific bridge addresses per protocol are:

     **TODO (ORCHESTRATOR MUST FILL BEFORE DISPATCH):**
     - Stargate v2 pool addresses for USDT, USDC on Ethereum
     - Across v3 SpokePool address on Ethereum
     - Wormhole Token Bridge address on Ethereum
     - Axelar Gateway address on Ethereum
     - Hyperlane token router addresses on Ethereum

   - For tokens that already have `ccipBridgeDetection`, merge the new bridge addresses into their existing `knownBridgePoolAddresses` array (do NOT replace the CCIP config — extend it).

2. **Create `worker/src/api/reclassify-bridge-burns.ts`:**
   ```typescript
   import { requireAdmin } from "../lib/auth";
   import { withErrorHandler, jsonResponse, errorResponse } from "../lib/api-utils";
   import { MINT_BURN_CONFIGS } from "../lib/mint-burn-contracts";
   import { recalcAffectedHours } from "../lib/mint-burn-pipeline/persistence";
   import type { MintBurnAffectedHour } from "../lib/mint-burn-pipeline/types";

   /**
    * POST /api/reclassify-bridge-burns?stablecoin=<id> (admin)
    * Re-runs bridge classification on existing burn events for a single coin
    * against the current bridge address list. Call once per coin with bridge config.
    */
   export const handleReclassifyBridgeBurns = withErrorHandler(
     "reclassify-bridge-burns",
     async (db: D1Database, url: URL, adminKey: string | undefined, request?: Request): Promise<Response> => {
       const authErr = await requireAdmin(request, adminKey);
       if (authErr) return authErr;

       const stablecoinId = url.searchParams.get("stablecoin");
       if (!stablecoinId) {
         return errorResponse(400, "stablecoin param required");
       }

       const configs = MINT_BURN_CONFIGS.filter(
         (c) => c.stablecoinId === stablecoinId && c.bridgeDetection,
       );
       if (configs.length === 0) {
         return errorResponse(404, "No bridge detection config for this coin");
       }

       // Collect all known bridge pool addresses for this coin
       const allPoolAddresses = new Set<string>();
       for (const config of configs) {
         for (const addr of config.bridgeDetection!.knownBridgePoolAddresses) {
           allPoolAddresses.add(addr.toLowerCase());
         }
       }

       let updated = 0;
       const affectedHours = new Map<string, MintBurnAffectedHour>();

       for (const addr of allPoolAddresses) {
         const { results } = await db.prepare(
           `SELECT id, chain_id, timestamp FROM mint_burn_events
            WHERE stablecoin_id = ? AND direction = 'burn'
              AND burn_type = 'effective_burn'
              AND LOWER(counterparty) = ?`
         ).bind(stablecoinId, addr).all<{ id: string; chain_id: string; timestamp: number }>();

         if (results.length === 0) continue;

         for (const event of results) {
           await db.prepare(
             `UPDATE mint_burn_events SET burn_type = 'review_required',
              burn_review_reason = 'retroactive-bridge-reclassification'
              WHERE id = ?`
           ).bind(event.id).run();
           updated++;

           const hourTs = Math.floor(event.timestamp / 3600) * 3600;
           const key = `${stablecoinId}-${event.chain_id}-${hourTs}`;
           affectedHours.set(key, {
             stablecoinId,
             chainId: event.chain_id,
             hourTs,
           });
         }
       }

       await recalcAffectedHours(db, affectedHours);

       return jsonResponse({
         stablecoinId,
         updated,
         hoursRecalculated: affectedHours.size,
         bridgeAddressesChecked: allPoolAddresses.size,
       });
     },
   );
   ```

3. **Register the admin endpoint** — two files must be updated:

   **3a. `shared/lib/api-endpoints.ts`** — Add to the `ENDPOINT_DEFINITIONS` array (near the other mint-burn admin endpoints):
   ```typescript
   {
     path: "/api/reclassify-bridge-burns",
     methods: ["POST"],
     adminRequired: true,
     mutatingAdmin: true,
     cacheBypass: true,
     probeGroup: "manual",
   },
   ```

   **3b. `worker/src/router.ts`** — Add import at the top alongside other mint-burn imports:
   ```typescript
   import { handleReclassifyBridgeBurns } from "./api/reclassify-bridge-burns";
   ```
   Add to `STATIC_ROUTE_HANDLERS` Map, near the other mint-burn entries:
   ```typescript
   ["/api/reclassify-bridge-burns", ({ db, url, adminKey, request }) => runIdempotentAdminAction(
     db,
     "reclassify-bridge-burns",
     request,
     () => handleReclassifyBridgeBurns(db, url, adminKey, request),
   )],
   ```

4. **Add test in `worker/src/lib/__tests__/mint-burn-contracts.test.ts`** (or create if it doesn't exist):
   - Verify `counterpartyBridgeDetection()` returns a valid `MintBurnBridgeDetectionConfig`:
     ```typescript
     import { counterpartyBridgeDetection } from "../mint-burn-contracts";

     it("counterpartyBridgeDetection returns valid config shape", () => {
       const config = counterpartyBridgeDetection(["0x1234567890abcdef1234567890abcdef12345678"]);
       expect(config.protocol).toBe("ccip");
       expect(config.knownBridgePoolAddresses).toHaveLength(1);
       expect(config.knownBridgeRouterAddresses).toEqual([]);
       expect(config.bridgeSignalTopics).toEqual([]);
       expect(config.bridgeSignalSelectors).toEqual([]);
     });
     ```
   - Verify all bridge addresses in MINT_BURN_CONFIGS are lowercase valid hex:
     ```typescript
     import { MINT_BURN_CONFIGS } from "../mint-burn-contracts";

     it("all bridge pool addresses are lowercase hex", () => {
       for (const config of MINT_BURN_CONFIGS) {
         if (!config.bridgeDetection) continue;
         for (const addr of config.bridgeDetection.knownBridgePoolAddresses) {
           expect(addr).toMatch(/^0x[0-9a-f]{40}$/);
         }
       }
     });
     ```

## Acceptance Criteria

- `cd worker && npx vitest run` — all tests pass
- `cd worker && npx tsc --noEmit` — no type errors
- `npm run build` — builds successfully
- `grep -c 'counterpartyBridgeDetection' worker/src/lib/mint-burn-contracts.ts` — returns at least 1
- `grep -c 'Bridge detection coverage' worker/src/lib/mint-burn-contracts.ts` — returns 1
- `test -f worker/src/api/reclassify-bridge-burns.ts` — admin endpoint file exists
- `grep -c 'reclassify-bridge-burns' worker/src/router.ts` — returns at least 1 (route registration)
- `grep -c 'reclassify-bridge-burns' shared/lib/api-endpoints.ts` — returns at least 1 (endpoint definition)
