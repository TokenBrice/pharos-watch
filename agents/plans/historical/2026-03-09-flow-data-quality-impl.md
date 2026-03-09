# Flow Data Quality Improvements — Implementation Plan

> **For Claude:** This is a cmcs-driven plan. Dispatch via cmcs worktrees with parallel execution.

**Goal:** Fix four data quality issues in mint/burn flows (atomic roundtrip detection, bridge expansion, auto price backfill, activity gate) plus cross-cutting improvements (observability, methodology versioning).

**Architecture:** Four independent workstreams (Q1-Q4) in parallel worktrees, followed by a cross-cutting phase for methodology versioning. Each worktree has 1-2 sequential tickets.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), Vitest, TypeScript strict

---

## Dependency Graph

```
Phase 1 (parallel):
  [Q1: atomic-roundtrip]  ──┐
  [Q2: bridge-expansion]  ──┤
  [Q3: auto-price-backfill]──┼── all merge to main
  [Q4: activity-gate]     ──┘

Phase 2 (sequential, after Phase 1):
  [methodology-v45]  ── merge to main

Phase 3 (manual):
  Impact measurement queries
```

**Prerequisites before dispatch:**
- Q2 requires bridge address research (see Phase 0 below)

---

## Phase 0: Bridge Address Research (Orchestrator)

Before dispatching Q2, research and verify Ethereum contract addresses for:

1. **Stargate v2 (LayerZero)** — StargatePoolUSDC, StargatePoolUSDT on Ethereum
2. **Across v3** — SpokePool on Ethereum
3. **Wormhole Token Bridge** — Token Bridge contract on Ethereum
4. **Axelar Gateway** — Gateway contract on Ethereum
5. **Hyperlane** — Mailbox + token router contracts

For each bridge, verify:
- The contract address handles stablecoin burns (not just locks)
- The address is the one that appears as `counterparty` (topics[1]) in burn Transfer events
- Cross-reference with Etherscan verified contracts

Fill results into Q2 TICKET-001 before dispatch.

---

## Phase 1: Parallel Worktrees

### Worktree 1: `flow-q4-activity-gate`

Single ticket. Simplest change — pure scoring logic.

#### TICKET-001: Add minimum activity gate to pressure shift scoring

```yaml
title: "Add MIN_ACTIVITY_USD gate to computeFlowIntensity"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
```

**Goal:** Return `null` (NR) from `computeFlowIntensity()` when 24h absolute flow is below $50K, preventing misleading scores for low-activity coins.

**Task:**

1. In `worker/src/lib/mint-burn-scoring.ts`:
   - Add new field to `FlowIntensityInput` interface (after line 20):
     ```typescript
     /** Current 24 h absolute flow (|mint| + |burn|), USD — used for activity gate */
     currentDailyAbs?: number;
     ```
   - Add constant (after line 26):
     ```typescript
     export const MIN_ACTIVITY_USD = 50_000;
     ```
   - In `computeFlowIntensity()` (line 38), add gate BEFORE the existing `MIN_DATA_DAYS` check (before line 41):
     ```typescript
     if (input.currentDailyAbs !== undefined && input.currentDailyAbs < MIN_ACTIVITY_USD) return null;
     ```

2. In `worker/src/api/mint-burn-flows.ts`:
   - Find the `computeFlowIntensity()` call site (around line 439). Add `currentDailyAbs` to the input object:
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

3. In `worker/src/lib/__tests__/mint-burn-scoring.test.ts`:
   - Add tests for the activity gate in the `computeFlowIntensity` describe block:
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

**Acceptance Criteria:**
```bash
cd worker && npx vitest run src/lib/__tests__/mint-burn-scoring.test.ts
# All tests pass including 3 new activity gate tests
cd worker && npx tsc --noEmit
# No type errors
```

---

### Worktree 2: `flow-q1-atomic-roundtrip`

Two sequential tickets. Schema must land before pipeline changes.

#### TICKET-001: Schema migration + detection logic + insert update

```yaml
title: "Add flow_type column and atomic roundtrip detection"
agent: "codex"
model: "gpt-5.4"
reasoning_effort: "high"
done: false
```

**Goal:** Add a `flow_type` column to `mint_burn_events`, implement same-transaction roundtrip detection, and include `flow_type` in event inserts.

**Task:**

1. Create migration `worker/migrations/0056_mint_burn_flow_type.sql`:
   ```sql
   ALTER TABLE mint_burn_events ADD COLUMN flow_type TEXT DEFAULT 'standard';
   ```

2. In `worker/src/lib/mint-burn-pipeline/types.ts`:
   - Add to `MintBurnRow` interface (after `burn_review_reason`, line 15):
     ```typescript
     flow_type: "standard" | "atomic_roundtrip";
     ```

3. In `worker/src/lib/mint-burn-pipeline/parse.ts`:
   - In the `parseMintBurnLogs` function, where `MintBurnRow` objects are constructed (around line 95), add:
     ```typescript
     flow_type: "standard",
     ```

4. In `worker/src/lib/mint-burn-pipeline/persistence.ts`:
   - In `insertMintBurnRows` (line 12-15), add `flow_type` to the INSERT column list and VALUES:
     ```typescript
     `INSERT OR IGNORE INTO mint_burn_events
      (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, price_used, price_timestamp, price_source,
       burn_type, burn_review_reason, counterparty, tx_hash, block_number, timestamp, explorer_tx_url, flow_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
     ```
   - Add `row.flow_type` to the `.bind()` call (after `row.explorer_tx_url`, line 34).

5. Create new file `worker/src/lib/mint-burn-pipeline/roundtrip-detection.ts`:
   ```typescript
   import type { MintBurnRow } from "./types";

   /**
    * Detect atomic roundtrips: transactions that contain both mint(s) and burn(s)
    * for the same stablecoin. Mutates rows in place, setting flow_type = "atomic_roundtrip".
    * Returns count of rows flagged.
    */
   export function detectAtomicRoundtrips(rows: MintBurnRow[]): number {
     // Group by (tx_hash, stablecoin_id)
     const groups = new Map<string, MintBurnRow[]>();
     for (const row of rows) {
       const key = `${row.tx_hash}-${row.stablecoin_id}`;
       const group = groups.get(key);
       if (group) {
         group.push(row);
       } else {
         groups.set(key, [row]);
       }
     }

     let flagged = 0;
     for (const group of groups.values()) {
       const hasMint = group.some((r) => r.direction === "mint");
       const hasBurn = group.some((r) => r.direction === "burn");
       if (hasMint && hasBurn) {
         for (const row of group) {
           row.flow_type = "atomic_roundtrip";
           flagged++;
         }
       }
     }
     return flagged;
   }
   ```

6. Add tests in `worker/src/lib/__tests__/mint-burn-roundtrip.test.ts`:
   ```typescript
   import { describe, it, expect } from "vitest";
   import { detectAtomicRoundtrips } from "../mint-burn-pipeline/roundtrip-detection";
   import type { MintBurnRow } from "../mint-burn-pipeline/types";

   function makeRow(overrides: Partial<MintBurnRow>): MintBurnRow {
     return {
       id: "ethereum-0xabc-0",
       stablecoin_id: "usdc-circle",
       symbol: "USDC",
       chain_id: "ethereum",
       direction: "mint",
       amount: 1_000_000,
       amount_usd: 1_000_000,
       price_used: 1.0,
       price_timestamp: 1700000000,
       price_source: "price_cache",
       burn_type: null,
       burn_review_reason: null,
       counterparty: "0x1234",
       tx_hash: "0xabc",
       block_number: 100,
       timestamp: 1700000000,
       explorer_tx_url: "https://etherscan.io/tx/0xabc",
       flow_type: "standard",
       ...overrides,
     };
   }

   describe("detectAtomicRoundtrips", () => {
     it("flags rows when same tx has both mint and burn for same coin", () => {
       const rows = [
         makeRow({ id: "eth-0xabc-0", tx_hash: "0xabc", direction: "mint" }),
         makeRow({ id: "eth-0xabc-1", tx_hash: "0xabc", direction: "burn" }),
       ];
       const flagged = detectAtomicRoundtrips(rows);
       expect(flagged).toBe(2);
       expect(rows[0].flow_type).toBe("atomic_roundtrip");
       expect(rows[1].flow_type).toBe("atomic_roundtrip");
     });

     it("does not flag when tx has only mints", () => {
       const rows = [
         makeRow({ id: "eth-0xabc-0", tx_hash: "0xabc", direction: "mint" }),
         makeRow({ id: "eth-0xabc-1", tx_hash: "0xabc", direction: "mint" }),
       ];
       const flagged = detectAtomicRoundtrips(rows);
       expect(flagged).toBe(0);
       expect(rows[0].flow_type).toBe("standard");
     });

     it("does not flag when tx has only burns", () => {
       const rows = [
         makeRow({ id: "eth-0xabc-0", tx_hash: "0xabc", direction: "burn" }),
       ];
       const flagged = detectAtomicRoundtrips(rows);
       expect(flagged).toBe(0);
     });

     it("handles multiple tx_hashes independently", () => {
       const rows = [
         makeRow({ id: "eth-0xabc-0", tx_hash: "0xabc", direction: "mint" }),
         makeRow({ id: "eth-0xabc-1", tx_hash: "0xabc", direction: "burn" }),
         makeRow({ id: "eth-0xdef-0", tx_hash: "0xdef", direction: "mint" }),
       ];
       const flagged = detectAtomicRoundtrips(rows);
       expect(flagged).toBe(2);
       expect(rows[2].flow_type).toBe("standard");
     });

     it("handles different stablecoins in same tx independently", () => {
       const rows = [
         makeRow({ id: "eth-0xabc-0", tx_hash: "0xabc", stablecoin_id: "usdc-circle", direction: "mint" }),
         makeRow({ id: "eth-0xabc-1", tx_hash: "0xabc", stablecoin_id: "usdt-tether", direction: "burn" }),
       ];
       const flagged = detectAtomicRoundtrips(rows);
       expect(flagged).toBe(0); // different coins, not a roundtrip
     });

     it("returns 0 for empty array", () => {
       expect(detectAtomicRoundtrips([])).toBe(0);
     });
   });
   ```

**Acceptance Criteria:**
```bash
cd worker && npx vitest run src/lib/__tests__/mint-burn-roundtrip.test.ts
# All 6 tests pass
cd worker && npx tsc --noEmit
# No type errors
```

---

#### TICKET-002: Aggregation filter + cron integration + observability + retroactive endpoint

```yaml
title: "Exclude atomic roundtrips from aggregation and add retroactive classification"
agent: "codex"
model: "gpt-5.4"
reasoning_effort: "high"
done: false
```

**Goal:** Update hourly aggregation to exclude atomic roundtrips, integrate detection into the cron pipeline, add observability counter, and create an admin endpoint for retroactive classification.

**Task:**

1. In `worker/src/lib/mint-burn-pipeline/persistence.ts`:
   - Update the aggregation SQL in `recalcAffectedHours()` (lines 94-98). Add `AND flow_type = 'standard'` to all CASE conditions:
     ```sql
     SUM(CASE WHEN direction = 'mint' AND flow_type = 'standard' THEN 1 ELSE 0 END),
     SUM(CASE WHEN direction = 'burn' AND burn_type = 'effective_burn' AND flow_type = 'standard' THEN 1 ELSE 0 END),
     COALESCE(SUM(CASE WHEN direction = 'mint' AND flow_type = 'standard' THEN amount_usd ELSE 0 END), 0),
     COALESCE(SUM(CASE WHEN direction = 'burn' AND burn_type = 'effective_burn' AND flow_type = 'standard' THEN amount_usd ELSE 0 END), 0),
     COALESCE(SUM(CASE WHEN direction = 'mint' AND flow_type = 'standard' THEN amount_usd
                  WHEN direction = 'burn' AND burn_type = 'effective_burn' AND flow_type = 'standard' THEN -amount_usd ELSE 0 END), 0)
     ```

2. In `worker/src/cron/sync-mint-burn.ts`:
   - Add import at top:
     ```typescript
     import { detectAtomicRoundtrips } from "../lib/mint-burn-pipeline/roundtrip-detection";
     ```
   - In the per-config processing loop, after `parseMintBurnLogs()` and before `insertMintBurnRows()`, call the detection:
     ```typescript
     const roundtripsDetected = detectAtomicRoundtrips(rows);
     atomicRoundtripsTotal += roundtripsDetected;
     ```
   - Declare `atomicRoundtripsTotal` counter (initialized to 0) alongside existing counters like `rowsInserted`, `rowsParsed` etc.
   - In the metadata object (around line 612), add after `burnClassification`:
     ```typescript
     atomicRoundtripsDetected: atomicRoundtripsTotal,
     ```

3. Create admin endpoint `worker/src/api/reclassify-atomic-roundtrips.ts`:
   ```typescript
   import type { Env } from "../types";
   import { collectAffectedHours, recalcAffectedHours } from "../lib/mint-burn-pipeline/persistence";
   import type { MintBurnAffectedHour, MintBurnRow } from "../lib/mint-burn-pipeline/types";

   const BATCH_SIZE = 1000;

   export async function handleReclassifyAtomicRoundtrips(
     request: Request,
     env: Env,
   ): Promise<Response> {
     // Find tx_hashes with both mint and burn for the same stablecoin
     const { results: roundtripTxs } = await env.DB.prepare(
       `SELECT tx_hash, stablecoin_id
        FROM mint_burn_events
        WHERE flow_type = 'standard'
        GROUP BY tx_hash, stablecoin_id
        HAVING COUNT(DISTINCT direction) > 1
        LIMIT ?`
     ).bind(BATCH_SIZE).all<{ tx_hash: string; stablecoin_id: string }>();

     if (roundtripTxs.length === 0) {
       return Response.json({ done: true, updated: 0 });
     }

     // Collect affected events for hour recalculation
     const { results: affectedEvents } = await env.DB.prepare(
       `SELECT stablecoin_id, chain_id, timestamp
        FROM mint_burn_events
        WHERE (tx_hash, stablecoin_id) IN (${roundtripTxs.map(() => "(?, ?)").join(", ")})
          AND flow_type = 'standard'`
     ).bind(...roundtripTxs.flatMap((r) => [r.tx_hash, r.stablecoin_id]))
      .all<{ stablecoin_id: string; chain_id: string; timestamp: number }>();

     // Update flow_type
     let updated = 0;
     for (const { tx_hash, stablecoin_id } of roundtripTxs) {
       const result = await env.DB.prepare(
         `UPDATE mint_burn_events
          SET flow_type = 'atomic_roundtrip'
          WHERE tx_hash = ? AND stablecoin_id = ? AND flow_type = 'standard'`
       ).bind(tx_hash, stablecoin_id).run();
       updated += result.meta.changes ?? 0;
     }

     // Recalculate affected hourly buckets
     const affectedHours = new Map<string, MintBurnAffectedHour>();
     for (const event of affectedEvents) {
       const hourTs = Math.floor(event.timestamp / 3600) * 3600;
       const key = `${event.stablecoin_id}-${event.chain_id}-${hourTs}`;
       affectedHours.set(key, {
         stablecoinId: event.stablecoin_id,
         chainId: event.chain_id,
         hourTs,
       });
     }
     await recalcAffectedHours(env.DB, affectedHours);

     return Response.json({
       done: roundtripTxs.length < BATCH_SIZE,
       updated,
       hoursRecalculated: affectedHours.size,
       batchSize: BATCH_SIZE,
     });
   }
   ```

4. Register the admin endpoint in the router (find the admin route registration pattern in `worker/src/handlers/http.ts` or the router file) — add:
   ```typescript
   // POST /api/reclassify-atomic-roundtrips (admin)
   ```
   Follow the same pattern as the existing `backfill-mint-burn` admin endpoint registration.

5. Update existing pipeline tests in `worker/src/lib/__tests__/mint-burn-pipeline.test.ts`:
   - Verify the updated aggregation SQL filters by `flow_type` — add a test case that inserts rows with `flow_type = 'atomic_roundtrip'` and confirms they are excluded from hourly aggregation.

**Acceptance Criteria:**
```bash
cd worker && npx vitest run src/lib/__tests__/mint-burn-pipeline.test.ts
cd worker && npx vitest run src/lib/__tests__/mint-burn-roundtrip.test.ts
# All tests pass
cd worker && npx tsc --noEmit
# No type errors
```

---

### Worktree 3: `flow-q3-auto-backfill`

Single ticket. Modifies the sync cron tail-end.

#### TICKET-001: Auto price backfill + nullPricesHealed observability counter

```yaml
title: "Add automatic NULL price backfill to sync-mint-burn cron"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
```

**Goal:** At the end of each successful sync cycle, automatically backfill `amount_usd` for recent events that were synced without a price, and report the count in metadata.

**Task:**

1. Create `worker/src/lib/mint-burn-pipeline/price-heal.ts`:
   ```typescript
   import { batchExecute } from "../db";
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

     // Find events with NULL amount_usd in the lookback window
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

     // Get unique stablecoin IDs and load prices
     const coinIds = [...new Set(nullEvents.map((e) => e.stablecoin_id))];
     const prices = new Map<string, number>();
     for (const coinId of coinIds) {
       const row = await db.prepare(
         `SELECT price FROM price_cache WHERE stablecoin_id = ?`
       ).bind(coinId).first<{ price: number }>();
       if (row?.price) prices.set(coinId, row.price);
     }

     // Update events with resolved prices
     const nowMs = nowSec * 1000;
     const updateStmts = nullEvents
       .filter((e) => prices.has(e.stablecoin_id))
       .map((e) => {
         const price = prices.get(e.stablecoin_id)!;
         return db.prepare(
           `UPDATE mint_burn_events
            SET amount_usd = ?, price_used = ?, price_timestamp = ?, price_source = ?
            WHERE id = ? AND amount_usd IS NULL`
         ).bind(
           e.amount * price,
           price,
           nowSec,
           "price_cache_heal",
           e.id,
         );
       });

     const healed = updateStmts.length > 0 ? await batchExecute(db, updateStmts) : 0;

     // Collect affected hours for re-aggregation
     const affectedHours = new Map<string, MintBurnAffectedHour>();
     for (const e of nullEvents.filter((e) => prices.has(e.stablecoin_id))) {
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

2. In `worker/src/cron/sync-mint-burn.ts`:
   - Add import:
     ```typescript
     import { healNullPrices } from "../lib/mint-burn-pipeline/price-heal";
     ```
   - After the main processing loop and before the metadata assembly (around line 610), add:
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
   - In the metadata object (around line 612), add:
     ```typescript
     nullPricesHealed,
     ```

3. Add tests in `worker/src/lib/__tests__/mint-burn-price-heal.test.ts`:
   ```typescript
   import { describe, it, expect, vi } from "vitest";
   import { healNullPrices } from "../mint-burn-pipeline/price-heal";

   // Test that healNullPrices:
   // 1. Returns { healed: 0, affectedHours: empty } when no NULL events exist
   // 2. Resolves prices from price_cache and updates events
   // 3. Collects correct affected hours for re-aggregation
   // 4. Skips events whose stablecoin has no price in cache
   // 5. Respects the 48h lookback window
   ```
   Use the same `mockD1()` / `makeDb()` test helper pattern from `worker/src/lib/__tests__/mint-burn-pipeline.test.ts`.

**Acceptance Criteria:**
```bash
cd worker && npx vitest run src/lib/__tests__/mint-burn-price-heal.test.ts
# All tests pass
cd worker && npx tsc --noEmit
# No type errors
```

---

### Worktree 4: `flow-q2-bridge-expansion`

Single ticket. Requires Phase 0 bridge address research to be complete.

#### TICKET-001: Expand bridge address list + retroactive reclassification endpoint

```yaml
title: "Add Stargate/Across/Wormhole/Axelar/Hyperlane bridge addresses"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
```

**Goal:** Expand bridge burn detection from CCIP-only (5 tokens) to cover the top 5 bridge protocols by stablecoin volume.

**Task:**

1. In `worker/src/lib/mint-burn-contracts.ts`:
   - Add a new bridge detection factory function alongside `ccipBridgeDetection()` (around line 78):
     ```typescript
     /**
      * Counterparty-only bridge detection: classifies burns sent to known
      * bridge pool/router addresses without requiring bridge signal topics.
      * Used for bridges where we can't reliably detect protocol-specific
      * event signatures but know the pool addresses.
      */
     function counterpartyBridgeDetection(
       knownBridgePoolAddresses: string[],
     ): MintBurnBridgeDetectionConfig {
       return {
         protocol: "ccip", // reuses classification logic, signals will be absent
         knownBridgePoolAddresses,
         knownBridgeRouterAddresses: [],
         bridgeSignalTopics: [],
         bridgeSignalSelectors: [],
       };
     }
     ```
   - Add a file-level comment block documenting covered bridges and last-verified date:
     ```typescript
     /**
      * Bridge detection coverage (last verified: 2026-03-XX):
      * - CCIP (Chainlink): USDC, ZCHF, USD1, avUSD, USDO — full signal detection
      * - Stargate v2 (LayerZero): pool addresses — counterparty-only
      * - Across v3: SpokePool — counterparty-only
      * - Wormhole: Token Bridge — counterparty-only
      * - Axelar: Gateway — counterparty-only
      * - Hyperlane: token routers — counterparty-only
      */
     ```
   - For stablecoins that route through these bridges (primarily USDT, USDC, DAI, and other major tokens), add `bridgeDetection: counterpartyBridgeDetection([...])` to their config entries. The specific addresses will be provided after Phase 0 research.
   - NOTE: For tokens that already have `ccipBridgeDetection`, merge the new addresses into the existing config rather than replacing.

2. Update `worker/src/lib/mint-burn-bridge-classifier.ts`:
   - Currently, when `detection` is provided but has empty `bridgeSignalTopics`/`bridgeSignalSelectors` (as with `counterpartyBridgeDetection`), burns to known pool addresses without any bridge signal will get `review_required` (line 108-111: "known-bridge-pool-without-bridge-signal").
   - This is actually the correct conservative behavior for counterparty-only detection. No logic changes needed — the existing classifier handles this correctly.

3. Create admin endpoint `worker/src/api/reclassify-bridge-burns.ts`:
   ```typescript
   import type { Env } from "../types";
   import { MINT_BURN_CONFIGS } from "../lib/mint-burn-contracts";
   import { recalcAffectedHours } from "../lib/mint-burn-pipeline/persistence";
   import type { MintBurnAffectedHour } from "../lib/mint-burn-pipeline/types";

   /**
    * POST /api/reclassify-bridge-burns (admin)
    * Re-runs bridge classification on existing burn events against
    * the current bridge address list. Processes one stablecoin per call.
    */
   export async function handleReclassifyBridgeBurns(
     request: Request,
     env: Env,
   ): Promise<Response> {
     const url = new URL(request.url);
     const stablecoinId = url.searchParams.get("stablecoin");
     if (!stablecoinId) {
       return Response.json({ error: "stablecoin param required" }, { status: 400 });
     }

     // Find configs with bridge detection for this stablecoin
     const configs = MINT_BURN_CONFIGS.filter(
       (c) => c.stablecoinId === stablecoinId && c.bridgeDetection
     );
     if (configs.length === 0) {
       return Response.json({ error: "No bridge detection config for this coin" }, { status: 404 });
     }

     // Collect all known bridge pool addresses for this coin
     const allPoolAddresses = new Set<string>();
     for (const config of configs) {
       for (const addr of config.bridgeDetection!.knownBridgePoolAddresses) {
         allPoolAddresses.add(addr.toLowerCase());
       }
     }

     // Find effective_burn events with counterparty matching bridge addresses
     let updated = 0;
     const affectedHours = new Map<string, MintBurnAffectedHour>();
     for (const addr of allPoolAddresses) {
       const { results } = await env.DB.prepare(
         `SELECT id, chain_id, timestamp FROM mint_burn_events
          WHERE stablecoin_id = ? AND direction = 'burn'
            AND burn_type = 'effective_burn'
            AND LOWER(counterparty) = ?`
       ).bind(stablecoinId, addr).all<{ id: string; chain_id: string; timestamp: number }>();

       if (results.length === 0) continue;

       for (const event of results) {
         await env.DB.prepare(
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

     await recalcAffectedHours(env.DB, affectedHours);

     return Response.json({
       stablecoinId,
       updated,
       hoursRecalculated: affectedHours.size,
       bridgeAddressesChecked: allPoolAddresses.size,
     });
   }
   ```

4. Register the admin endpoint in the router (same pattern as other admin endpoints).

5. Add test coverage in `worker/src/lib/__tests__/mint-burn-contracts.test.ts` (or create new):
   - Verify `counterpartyBridgeDetection()` returns valid config shape
   - Verify bridge detection configs have non-empty `knownBridgePoolAddresses`
   - Verify all pool addresses are lowercase and valid hex format

**Acceptance Criteria:**
```bash
cd worker && npx vitest run
# All existing + new tests pass
cd worker && npx tsc --noEmit
# No type errors
```

---

## Phase 2: Post-Merge (after all Phase 1 worktrees merged)

### Worktree 5: `flow-methodology-v45`

Single ticket. Documentation and versioning.

#### TICKET-001: Bump methodology version to 4.5 + update docs

```yaml
title: "Bump mint/burn flow methodology to v4.5 with data quality changelog"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "medium"
done: false
```

**Goal:** Document all data quality changes publicly via methodology version bump and changelog entry.

**Task:**

1. In `shared/lib/mint-burn-flow-version.ts`:
   - Update `currentVersion` from `"4.4"` to `"4.5"` (line 6)
   - Add new changelog entry at the top of the `changelog` array (before the v4.4 entry, line 9):
     ```typescript
     {
       version: "4.5",
       title: "Data quality: noise filtering, bridge coverage, and activity gating",
       date: "2026-03-XX", // fill with actual merge date
       effectiveAt: 0, // fill with actual unix timestamp
       summary:
         "Improves flow data reliability by excluding flash-loan roundtrips from aggregation, expanding bridge burn detection to 6 protocols, auto-healing missing USD prices, and gating pressure shift for low-activity coins.",
       impact: [
         "Transactions containing both mint and burn for the same token (flash loans, atomic arb) are now flagged as `atomic_roundtrip` and excluded from all flow aggregates",
         "Bridge burn detection expanded from CCIP-only (5 tokens) to cover Stargate, Across, Wormhole, Axelar, and Hyperlane",
         "Events synced without USD price are now automatically backfilled within 48h by the sync cron",
         "Coins with less than $50K absolute 24h flow now return NR instead of a potentially misleading pressure shift score",
         "New observability counters in cron metadata: `atomicRoundtripsDetected`, `nullPricesHealed`",
       ],
       commits: ["unreleased"],
       reconstructed: false,
     },
     ```

2. Update `docs/mint-burn-flows.md`:
   - Update methodology version reference from `v4.4` to `v4.5`
   - In the Constants table, add `MIN_ACTIVITY_USD` ($50,000) row
   - In Contract Configurations section, add note about `flow_type` column
   - In Scoring section, document the activity gate
   - In the Future Work section, remove "Additional EVM chains" bullet (still deferred but clarify bridge coverage is expanded)

3. Verify the methodology page renders correctly:
   ```bash
   npm run build
   # Build succeeds, methodology changelog page includes v4.5
   ```

**Acceptance Criteria:**
```bash
npm run build
# Build succeeds with no errors
cd worker && npx tsc --noEmit
# No type errors
```

---

## Phase 3: Impact Measurement (Manual Verification)

After Phase 1 merges, run these queries via `wrangler d1 execute stablecoin-db --remote` to measure impact:

### Before retroactive migrations (capture snapshot):
```sql
-- Total burn volume 30d
SELECT SUM(burn_volume_usd) as total_burn_30d
FROM mint_burn_hourly
WHERE hour_ts >= unixepoch() - 30*86400;

-- Count of coins with non-null pressure shift (via API call)
-- curl https://api.pharos.watch/api/mint-burn-flows | jq '.coins | map(select(.pressureShiftScore != null)) | length'
```

### After Q1 retroactive reclassification:
```sql
-- Count of atomic roundtrip events
SELECT COUNT(*) as roundtrip_events FROM mint_burn_events WHERE flow_type = 'atomic_roundtrip';

-- Impact on burn volume
SELECT
  SUM(CASE WHEN flow_type = 'standard' THEN burn_volume_usd ELSE 0 END) as clean_burn_30d,
  SUM(burn_volume_usd) as total_burn_30d
FROM mint_burn_hourly
WHERE hour_ts >= unixepoch() - 30*86400;
```

### After Q2 retroactive reclassification:
```sql
-- Bridge burns reclassified
SELECT burn_type, COUNT(*) FROM mint_burn_events
WHERE burn_review_reason = 'retroactive-bridge-reclassification'
GROUP BY burn_type;
```

---

## Dispatch Commands

```bash
# Phase 1 — all parallel
cmcs worktree create flow-q4-activity-gate
cmcs worktree create flow-q1-atomic-roundtrip
cmcs worktree create flow-q3-auto-backfill
cmcs worktree create flow-q2-bridge-expansion  # after Phase 0 research

# Place tickets in each worktree's .cmcs/tickets/
# Then launch all at once:
cmcs run worktrees/flow-q4-activity-gate 2>&1 &
cmcs run worktrees/flow-q1-atomic-roundtrip 2>&1 &
cmcs run worktrees/flow-q3-auto-backfill 2>&1 &
cmcs run worktrees/flow-q2-bridge-expansion 2>&1 &
wait

# Phase 2 — after all Phase 1 merged
cmcs worktree create flow-methodology-v45
cmcs run worktrees/flow-methodology-v45
```
