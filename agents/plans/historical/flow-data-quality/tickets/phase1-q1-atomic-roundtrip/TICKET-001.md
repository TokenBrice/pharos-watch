---
title: "Add flow_type column, detection logic, and insert update"
agent: "codex"
model: "gpt-5.4"
reasoning_effort: "high"
done: false
---

## Goal

Add a `flow_type` column to `mint_burn_events`, implement same-transaction atomic roundtrip detection, include `flow_type` in event inserts, and write comprehensive tests.

## Context

Flash loans and atomic arbitrage mint AND burn the same token within a single transaction (`tx_hash`). Currently these are counted as real flow, inflating volumes. The `flow_type` column classifies events as `standard` (real flow) or `atomic_roundtrip` (noise). Detection groups parsed events by `(tx_hash, stablecoin_id)` — if both directions are present, all events in that group are flagged.

The existing `burn_type` column follows a similar pattern (classifying burns as `effective_burn`, `bridge_burn`, or `review_required`). This new `flow_type` column is orthogonal — it applies to ALL events (both mints and burns).

## Task

1. **Create `worker/migrations/0056_mint_burn_flow_type.sql`:**
   ```sql
   ALTER TABLE mint_burn_events ADD COLUMN flow_type TEXT DEFAULT 'standard';
   ```
   Note: In SQLite, `ALTER TABLE ADD COLUMN` with DEFAULT is metadata-only — existing rows will read as `'standard'` without a table rewrite.

2. **`worker/src/lib/mint-burn-pipeline/types.ts`** (line ~3, `MintBurnRow` interface):
   - Add `flow_type` field after `burn_review_reason` (line 15):
     ```typescript
     flow_type: "standard" | "atomic_roundtrip";
     ```

3. **`worker/src/lib/mint-burn-pipeline/parse.ts`** (~line 95, where `MintBurnRow` objects are constructed in `parseMintBurnLogs`):
   - Add `flow_type: "standard"` to the returned row object, alongside the other fields.
   - Find the exact location by looking for where the function builds the return object with fields like `id`, `stablecoin_id`, `symbol`, etc.

4. **`worker/src/lib/mint-burn-pipeline/persistence.ts`** (line ~12, `insertMintBurnRows`):
   - In the INSERT SQL string, add `flow_type` to the column list:
     ```
     (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, price_used, price_timestamp, price_source,
      burn_type, burn_review_reason, counterparty, tx_hash, block_number, timestamp, explorer_tx_url, flow_type)
     ```
   - Add a corresponding `?` to the VALUES clause (18 total now).
   - Add `row.flow_type` to the `.bind()` call after `row.explorer_tx_url`.

5. **Create `worker/src/lib/mint-burn-pipeline/roundtrip-detection.ts`:**
   ```typescript
   import type { MintBurnRow } from "./types";

   /**
    * Detect atomic roundtrips: transactions that contain both mint(s) and burn(s)
    * for the same stablecoin. Mutates rows in place, setting flow_type = "atomic_roundtrip".
    * Returns count of rows flagged.
    */
   export function detectAtomicRoundtrips(rows: MintBurnRow[]): number {
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

6. **Create `worker/src/lib/__tests__/mint-burn-roundtrip.test.ts`:**
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
       flow_type: "standard",
       counterparty: "0x1234",
       tx_hash: "0xabc",
       block_number: 100,
       timestamp: 1700000000,
       explorer_tx_url: "https://etherscan.io/tx/0xabc",
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

7. **`worker/src/lib/__tests__/mint-burn-pipeline.test.ts`** (line ~61, existing `makeRow` function):
   - The existing `makeRow()` helper does NOT include `flow_type`. Adding `flow_type` as a required field to `MintBurnRow` will cause a type error here. Add `flow_type: "standard"` to the return object, after `burn_review_reason`:
     ```typescript
     burn_review_reason: overrides?.burn_review_reason ?? null,
     flow_type: overrides?.flow_type ?? "standard",
     counterparty: overrides?.counterparty ?? null,
     ```

## Acceptance Criteria

- `cd worker && npx vitest run src/lib/__tests__/mint-burn-roundtrip.test.ts` — all 6 tests pass
- `cd worker && npx tsc --noEmit` — no type errors
- `npm run build` — builds successfully
- `test -f worker/migrations/0056_mint_burn_flow_type.sql` — migration file exists
- `grep -c 'flow_type' worker/src/lib/mint-burn-pipeline/types.ts` — returns at least 1
- `grep -c 'flow_type' worker/src/lib/mint-burn-pipeline/persistence.ts` — returns at least 1
- `test -f worker/src/lib/mint-burn-pipeline/roundtrip-detection.ts` — detection module exists
