# Mint-Burn Flows Audit Fix Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all issues found in the mint-burn flows audit — the feature is currently non-functional in production due to missing USD pricing, stale sync data, and incomplete USDT event detection.

**Architecture:** Six tasks, ordered by dependency. Task 1 (price_cache) unblocks USD values for all new events. Task 2 (startBlock) ensures the sync reaches current blocks quickly. Task 3 (USDT Issue/Redeem) restores mint tracking for USDT. Task 4 (backfill) retroactively fixes existing events + hourly buckets. Task 5 (partial gauge) makes the gauge usable before all 10 coins have 7 days of data. Task 6 (minor cleanup) consolidates constants and docs.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), TypeScript strict, Vitest

---

## Context for the Implementer

### What's broken

The mint-burn flows feature shipped recently but **is completely non-functional in production**:

1. **`amountUsd` is NULL on every event** — the sync job queries `price_cache` for stablecoin prices, but `price_cache` is only populated for enriched-fallback assets. Major stablecoins (USDT, USDC, etc.) come with prices from DefiLlama and are never written to `price_cache`. Result: all hourly USD volumes are 0, gauge is null.

2. **Sync is stuck years behind** — Only USDC (15K events, latest from Oct 2023) and USDT (49 events) have data. The remaining 8 coins have 0 events. The sync starts from block 0 and is slowly crawling through historical blocks.

3. **USDT mints are completely missed** — USDT on Ethereum uses a custom `Issue(uint256)` event for minting, not standard `Transfer(0x0, to, amount)`. The config only listens for Transfer events, so zero mint events exist for USDT.

### Key files

| File | Purpose |
|------|---------|
| `worker/src/cron/sync-stablecoins.ts` | Populates `price_cache` (lines 565–594) |
| `worker/src/cron/sync-mint-burn.ts` | Reads `price_cache` for USD conversion (lines 57–65), ingests events, aggregates hourly |
| `worker/src/lib/mint-burn-contracts.ts` | Contract configs (addresses, events, decimals, dust thresholds) |
| `worker/src/lib/mint-burn-scoring.ts` | FIS, gauge score, flight-to-quality pure functions |
| `worker/src/lib/__tests__/mint-burn-scoring.test.ts` | 17 existing scoring tests |
| `worker/src/api/mint-burn-flows.ts` | API handler for `/api/mint-burn-flows` |
| `worker/src/api/mint-burn-events.ts` | API handler for `/api/mint-burn-events` |
| `worker/src/index.ts` | Cron scheduler (lines 222–234) |
| `worker/src/router.ts` | API route registration |

### Commands

```bash
npm run build                        # Frontend build + type-check
cd worker && npx tsc --noEmit        # Worker type-check
npx vitest run                       # All tests (root)
npx vitest run worker/src/lib/__tests__/mint-burn-scoring.test.ts  # Scoring tests only
```

---

## Task 1: Fix price_cache population so mint-burn sync gets prices

**Files:**
- Modify: `worker/src/cron/sync-stablecoins.ts:565-575`
- Test: manual verification via worker type-check

The root cause: `savePriceCache()` is only called for assets that were "missing before" enrichment and got resolved. Assets that arrived with a valid price from DefiLlama (i.e., all major stablecoins) are never cached.

**Step 1: Modify `sync-stablecoins.ts` to save ALL valid prices to price_cache**

Replace lines 569–575 (the enriched-only save block):

```typescript
  // Save: coins that were missing but enrichment resolved (and passed validation)
  const enriched = llamaData.peggedAssets.filter(
    (a) => missingBefore.has(a.id) && !hasMissingPrice(a)
  );
  if (enriched.length > 0) {
    await savePriceCache(db, enriched.map((a) => ({ id: a.id, price: a.price! as number })));
  }
```

With:

```typescript
  // Save ALL assets with valid prices so other crons (mint-burn sync) can look them up.
  // Previously only enriched assets were cached, starving mint-burn of price data.
  const withValidPrices = llamaData.peggedAssets.filter(
    (a) => a.price != null && typeof a.price === "number" && a.price > 0
  );
  if (withValidPrices.length > 0) {
    await savePriceCache(db, withValidPrices.map((a) => ({ id: a.id, price: a.price! as number })));
  }
```

**Step 2: Run worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: all 163 tests pass (no test changes needed — this is a runtime data-flow fix)

**Step 4: Commit**

```
fix(worker): save all valid prices to price_cache, not just enriched

The mint-burn sync reads price_cache for USD conversion, but only
enriched (fallback) prices were saved. Major stablecoins that arrive
with prices from DefiLlama were never cached, causing amountUsd=NULL
on every mint/burn event.
```

---

## Task 2: Add `startBlock` to contract configs so sync starts near chain tip

**Files:**
- Modify: `worker/src/lib/mint-burn-contracts.ts:19-27,67-121`
- Modify: `worker/src/cron/sync-mint-burn.ts:44-48`

Starting from block 0 means weeks of catchup. Adding a `startBlock` per-config allows the sync to start from a recent block (e.g., 30 days before feature deployment) while still allowing incremental advancement.

**Step 1: Add `startBlock` field to `MintBurnContractConfig`**

In `worker/src/lib/mint-burn-contracts.ts`, add the field to the interface (after line 26):

```typescript
export interface MintBurnContractConfig {
  chain: ChainConfig;
  stablecoinId: string;
  symbol: string;
  contractAddress: string;
  decimals: number;
  dustThreshold: number;
  startBlock: number;       // <-- ADD: earliest block to scan (skip pre-deployment history)
  events: MintBurnEventDef[];
}
```

**Step 2: Set `startBlock` on each config entry**

Use block ~21900000 (approximately Feb 1, 2026 — ~1 month before feature launch) for all 10 Ethereum configs. This gives a month of historical data without scanning years of empty blocks.

For each config in the `MINT_BURN_CONFIGS` array, add `startBlock: 21_900_000`. Example for USDT:

```typescript
  {
    chain: ETHEREUM, stablecoinId: "1", symbol: "USDT",
    contractAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    events: transferMintBurn(),
  },
```

Apply the same `startBlock: 21_900_000` to all 10 entries.

**Step 3: Use `startBlock` as floor in sync-mint-burn.ts**

In `worker/src/cron/sync-mint-burn.ts`, modify the `lastBlocks` fallback (line 47) so that when no sync state exists, the initial block is `config.startBlock` instead of 0.

Replace lines 44-48:

```typescript
  const lastBlocks = new Map<string, number>();
  configKeys.forEach((key, i) => {
    const row = syncStates[i].results[0] as { last_block: number } | undefined;
    lastBlocks.set(key, row?.last_block ?? 0);
  });
```

With:

```typescript
  const lastBlocks = new Map<string, number>();
  configKeys.forEach((key, i) => {
    const row = syncStates[i].results[0] as { last_block: number } | undefined;
    // Fall back to config's startBlock (not 0) to avoid scanning pre-deployment history
    const config = MINT_BURN_CONFIGS[i];
    lastBlocks.set(key, row?.last_block ?? (config.startBlock - 1));
  });
```

**Step 4: Run worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: all tests pass

**Step 6: Commit**

```
feat(worker): add startBlock to mint-burn configs to skip pre-deployment history

Syncing from block 0 takes weeks to catch up. Each config now has a
startBlock (set to ~Feb 1 2026) so the first cron run starts near
recent blocks and provides useful data immediately.
```

---

## Task 3: Add USDT Issue/Redeem event detection on Ethereum

**Files:**
- Modify: `worker/src/lib/mint-burn-contracts.ts:34-40,70-73`

USDT on Ethereum uses custom `Issue(uint256)` and `Redeem(uint256)` events for minting/burning. The `issue()` function does NOT emit `Transfer(0x0, to, amount)`. The topic hashes are already defined in the file (lines 35–36) but unused.

**Step 1: Add Issue and Redeem events to USDT Ethereum config**

The Issue event emits only amount in the data field (no indexed from/to). The existing `parseMintBurnLogs` already handles missing counterparty gracefully (line 239: `counterpartyTopic ? decodeAddress(...) : null`).

Modify the USDT config in `MINT_BURN_CONFIGS` (currently line 70–73):

```typescript
  {
    chain: ETHEREUM, stablecoinId: "1", symbol: "USDT",
    contractAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    events: [
      ...transferMintBurn(),
      // USDT Ethereum uses custom Issue/Redeem events (issue() does NOT emit Transfer)
      {
        signature: "Issue(uint256)",
        topicHash: USDT_ISSUE_TOPIC,
        direction: "mint" as const,
        amountEncoding: "first-data-uint256" as const,
        // No filterTopic — Issue has only topic0 (event sig)
      },
      {
        signature: "Redeem(uint256)",
        topicHash: USDT_REDEEM_TOPIC,
        direction: "burn" as const,
        amountEncoding: "first-data-uint256" as const,
      },
    ],
  },
```

**Step 2: Remove the `void` suppression lines**

Delete lines 38–40:
```typescript
// Suppress unused-variable warnings for Phase 2 topics
void USDT_ISSUE_TOPIC;
void USDT_REDEEM_TOPIC;
```

These are no longer unused.

**Step 3: Verify `parseMintBurnLogs` handles Issue/Redeem events correctly**

Check `sync-mint-burn.ts:226-239`. The amount decoding uses `decodeUint256(log.data, config.decimals)` — this works for Issue/Redeem since the amount is the only field in `data`. The counterparty extraction checks `log.topics[2]` / `log.topics[1]` — for Issue/Redeem events these topics don't exist, so `counterpartyTopic` is `undefined` and counterparty becomes `null`. This is correct behavior.

**Also check:** the `fetchEvmLogsForTopics` call (sync-mint-burn.ts:93-101). For Issue/Redeem events, `eventDef.filterTopic` is `undefined`, so no compound topic filter is added — only `topic0` is sent. This is correct: we want ALL Issue/Redeem events, not filtered by address.

No changes needed to `sync-mint-burn.ts`.

**Step 4: Run worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: all tests pass

**Step 6: Commit**

```
feat(worker): add USDT Issue/Redeem event detection on Ethereum

USDT's issue() function emits Issue(uint256) instead of Transfer
from zero address. Without this, zero USDT mints were being detected.
Adds Issue and Redeem event definitions to the USDT Ethereum config.
```

---

## Task 4: Add admin backfill endpoint for amountUsd on existing events

**Files:**
- Create: `worker/src/api/backfill-mint-burn-prices.ts`
- Modify: `worker/src/router.ts` (add route)
- Modify: `worker/src/index.ts` (add to cache skip list)

~15K existing events have `amount_usd = NULL`. After Task 1 fixes price_cache, new events get USD values, but old events need a backfill pass. This admin endpoint reads current prices from price_cache and updates all NULL amount_usd rows, then recalculates affected hourly buckets.

**Step 1: Create the backfill handler**

Create `worker/src/api/backfill-mint-burn-prices.ts`:

```typescript
import { requireAdmin } from "../lib/auth";
import { withErrorHandler } from "../lib/api-utils";
import { getPriceCache, batchExecute } from "../lib/db";

export const handleBackfillMintBurnPrices = withErrorHandler(
  "backfill-mint-burn-prices",
  async (db: D1Database, url: URL, adminKey: string | undefined, request: Request): Promise<Response> => {
    const authErr = await requireAdmin(request, adminKey);
    if (authErr) return authErr;

    // 1. Load current prices
    const priceCache = await getPriceCache(db);

    // 2. Find distinct stablecoin_ids with NULL amount_usd
    const nullRows = await db
      .prepare("SELECT DISTINCT stablecoin_id FROM mint_burn_events WHERE amount_usd IS NULL")
      .all<{ stablecoin_id: string }>();

    let totalUpdated = 0;
    const coinResults: Array<{ id: string; updated: number }> = [];

    for (const { stablecoin_id } of nullRows.results ?? []) {
      const cached = priceCache.get(stablecoin_id);
      if (!cached) {
        coinResults.push({ id: stablecoin_id, updated: 0 });
        continue;
      }

      // 3. Update amount_usd = amount * price for all NULL rows of this coin
      const result = await db
        .prepare(
          "UPDATE mint_burn_events SET amount_usd = amount * ? WHERE stablecoin_id = ? AND amount_usd IS NULL"
        )
        .bind(cached.price, stablecoin_id)
        .run();

      const updated = result.meta?.changes ?? 0;
      totalUpdated += updated;
      coinResults.push({ id: stablecoin_id, updated });
    }

    // 4. Recalculate ALL hourly buckets for affected coins (simpler than tracking affected hours)
    if (totalUpdated > 0) {
      const affectedIds = coinResults.filter((c) => c.updated > 0).map((c) => c.id);

      // Delete existing hourly rows for affected coins, then re-aggregate
      const deleteStmts = affectedIds.map((id) =>
        db.prepare("DELETE FROM mint_burn_hourly WHERE stablecoin_id = ?").bind(id)
      );
      await batchExecute(db, deleteStmts);

      const insertStmts = affectedIds.map((id) =>
        db.prepare(`
          INSERT OR REPLACE INTO mint_burn_hourly
            (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
             mint_volume_usd, burn_volume_usd, net_flow_usd)
          SELECT
            stablecoin_id, chain_id,
            (timestamp / 3600) * 3600 AS hour_ts,
            SUM(CASE WHEN direction = 'mint' THEN 1 ELSE 0 END),
            SUM(CASE WHEN direction = 'burn' THEN 1 ELSE 0 END),
            COALESCE(SUM(CASE WHEN direction = 'mint' THEN amount_usd ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN direction = 'burn' THEN amount_usd ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN direction = 'mint' THEN amount_usd ELSE -amount_usd END), 0)
          FROM mint_burn_events
          WHERE stablecoin_id = ?
          GROUP BY stablecoin_id, chain_id, hour_ts
        `).bind(id)
      );
      await batchExecute(db, insertStmts);
    }

    return new Response(
      JSON.stringify({ totalUpdated, coins: coinResults }),
      { headers: { "Content-Type": "application/json" } }
    );
  }
);
```

**Step 2: Register route in `router.ts`**

Add import at top:
```typescript
import { handleBackfillMintBurnPrices } from "./api/backfill-mint-burn-prices";
```

Add route (near the other backfill routes, after line 62):
```typescript
  if (path === "/api/backfill-mint-burn-prices") {
    return handleBackfillMintBurnPrices(db, url, adminKey, request);
  }
```

**Step 3: Add to cache-skip list in `index.ts`**

In `worker/src/index.ts` line 157, add `"/api/backfill-mint-burn-prices"` to the skipCache list:

```typescript
const skipCache = url.pathname === "/api/health" || url.pathname === "/api/status" || url.pathname === "/api/backfill-depegs" || url.pathname === "/api/backfill-supply-history" || url.pathname === "/api/backfill-cg-prices" || url.pathname === "/api/audit-depeg-history" || url.pathname === "/api/backfill-stability-index" || url.pathname === "/api/backfill-mint-burn-prices";
```

**Step 4: Run worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: all tests pass

**Step 6: Commit**

```
feat(worker): add admin endpoint to backfill mint-burn USD prices

POST /api/backfill-mint-burn-prices reads current prices from
price_cache and updates all events with NULL amount_usd. Also
recalculates affected hourly aggregation buckets.
```

---

## Task 5: Make gauge score work with partial data

**Files:**
- Modify: `worker/src/lib/mint-burn-scoring.ts:103-117`
- Modify: `worker/src/lib/__tests__/mint-burn-scoring.test.ts`

Currently `computeGaugeScore()` returns `null` if ANY coin has null intensity. Since FIS requires 7 days of data, and the sync is just starting, the gauge will stay null for weeks. Fix: skip null-intensity coins and compute from available data.

**Step 1: Write the failing tests**

Add to `worker/src/lib/__tests__/mint-burn-scoring.test.ts` inside the `computeGaugeScore` describe block:

```typescript
  it("skips coins with null intensity and computes from available data", () => {
    const result = computeGaugeScore([
      { intensity: 60, mcap: 1e11 },
      { intensity: null, mcap: 5e10 },
      { intensity: 40, mcap: 5e10 },
    ]);
    // 60 * (100B/150B) + 40 * (50B/150B) = 40 + 13.33 = 53.33
    expect(result).toBeCloseTo(53.33, 1);
  });

  it("returns null when ALL coins have null intensity", () => {
    expect(
      computeGaugeScore([
        { intensity: null, mcap: 1e11 },
        { intensity: null, mcap: 5e10 },
      ])
    ).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(computeGaugeScore([])).toBeNull();
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run worker/src/lib/__tests__/mint-burn-scoring.test.ts`
Expected: 2 new tests FAIL (the "skips coins" test returns null instead of 53.33; the "empty array" test may also fail depending on current behavior)

**Step 3: Update `computeGaugeScore` to skip null-intensity coins**

In `worker/src/lib/mint-burn-scoring.ts`, replace lines 99-117:

```typescript
/**
 * Compute the market-cap-weighted average Flow Intensity Score across coins.
 * Skips coins with null intensity (insufficient data) and computes from available data.
 * Returns `null` only when no coin has valid intensity data.
 */
export function computeGaugeScore(
  coins: GaugeCoinInput[]
): number | null {
  let totalMcap = 0;
  let weightedSum = 0;

  for (const coin of coins) {
    if (coin.intensity === null) continue;
    totalMcap += coin.mcap;
    weightedSum += coin.intensity * coin.mcap;
  }

  if (totalMcap === 0) return null;
  return weightedSum / totalMcap;
}
```

**Step 4: Update the existing "returns null when any coin has null intensity" test**

The old test expects null when one coin is null. Update it to match the new behavior (it should now return a value, not null):

Replace the existing test:

```typescript
  it("returns null when any coin has null intensity", () => {
    expect(
      computeGaugeScore([
        { intensity: 40, mcap: 1e11 },
        { intensity: null, mcap: 5e10 },
      ])
    ).toBeNull();
  });
```

With:

```typescript
  it("ignores coins with null intensity in weighted average", () => {
    // Only the coin with intensity=40 is included; the null coin is skipped
    expect(
      computeGaugeScore([
        { intensity: 40, mcap: 1e11 },
        { intensity: null, mcap: 5e10 },
      ])
    ).toBe(40);
  });
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run worker/src/lib/__tests__/mint-burn-scoring.test.ts`
Expected: all tests pass (17 old + 3 new - 1 modified = 19 total)

**Step 6: Run full test suite**

Run: `npx vitest run`
Expected: all tests pass

**Step 7: Commit**

```
fix(worker): compute gauge score from partial data instead of requiring all coins

Previously, computeGaugeScore returned null if ANY coin had null
intensity. Since FIS needs 7 days of data, the gauge stayed null
indefinitely during initial sync. Now skips null-intensity coins
and computes from available data.
```

---

## Task 6: Minor cleanup — constants, docs, and dead code

**Files:**
- Modify: `worker/src/api/mint-burn-flows.ts:19` (extract SAFE_HAVEN_IDS)
- Modify: `worker/src/lib/mint-burn-contracts.ts` (add SAFE_HAVEN_IDS export)
- Modify: `docs/api-reference.md` (document backfill endpoint)
- Modify: `docs/worker-infrastructure.md` (document startBlock, backfill endpoint)

**Step 1: Move SAFE_HAVEN_IDS to mint-burn-contracts.ts**

In `worker/src/lib/mint-burn-contracts.ts`, add after the `MINT_BURN_CONFIGS` array (after line 121):

```typescript
/** IDs classified as "safe havens" for flight-to-quality detection */
export const SAFE_HAVEN_IDS = new Set(
  MINT_BURN_CONFIGS.filter((c) =>
    ["USDT", "USDC", "FDUSD", "PYUSD"].includes(c.symbol)
  ).map((c) => c.stablecoinId)
);
```

In `worker/src/api/mint-burn-flows.ts`, replace lines 18-19:

```typescript
/** IDs classified as "safe havens" for flight-to-quality detection */
const SAFE_HAVEN_IDS = new Set(["1", "2", "119", "120"]); // USDT, USDC, FDUSD, PYUSD
```

With:

```typescript
import { SAFE_HAVEN_IDS } from "../lib/mint-burn-contracts";
```

(And remove the existing `MINT_BURN_CONFIGS` import on line 4 is already there, but now also import `SAFE_HAVEN_IDS` alongside it.)

Update line 4:
```typescript
import { MINT_BURN_CONFIGS, SAFE_HAVEN_IDS } from "../lib/mint-burn-contracts";
```

And delete line 19 entirely.

**Step 2: Update docs/api-reference.md — add backfill endpoint**

Add the new endpoint to the admin endpoints section of `docs/api-reference.md`:

```markdown
### `POST /api/backfill-mint-burn-prices`

**Auth:** `X-Admin-Key` header required.

Backfills `amount_usd` for all mint-burn events with NULL values using current prices from `price_cache`. Recalculates affected hourly aggregation buckets.

**Response:**
```json
{
  "totalUpdated": 15000,
  "coins": [
    { "id": "1", "updated": 49 },
    { "id": "2", "updated": 15119 }
  ]
}
```

**Step 3: Update docs/worker-infrastructure.md — document startBlock**

Add a note about `startBlock` in the mint-burn section of `docs/worker-infrastructure.md`.

**Step 4: Run all checks**

Run: `cd worker && npx tsc --noEmit` (worker type-check)
Run: `npm run build` (frontend build)
Run: `npx vitest run` (tests)
Run: `npm run lint` (lint)

Expected: all pass

**Step 5: Commit**

```
refactor(worker): extract SAFE_HAVEN_IDS to mint-burn-contracts, update docs

Moves the hardcoded safe-haven ID set to a derived export in
mint-burn-contracts.ts. Documents the new backfill endpoint and
startBlock config in API reference and worker infrastructure docs.
```

---

## Post-Deploy Checklist

After deploying all 6 tasks:

1. **Wait for `sync-stablecoins` cron** (runs every 15 min) — this populates `price_cache` with valid prices
2. **Wait for 1–2 `sync-mint-burn` cycles** (runs every 20 min) — new events should now have `amount_usd` values
3. **Run the backfill** — `curl -X POST https://api.pharos.watch/api/backfill-mint-burn-prices -H "X-Admin-Key: $KEY"` — fixes existing NULL `amount_usd` rows
4. **Verify API data**:
   - `curl https://api.pharos.watch/api/mint-burn-events?stablecoin=2&limit=3` — check `amountUsd` is no longer null
   - `curl https://api.pharos.watch/api/mint-burn-flows` — check coins have non-zero volumes, gauge may still be null if < 7 days data but hourly should have values
5. **Monitor for 2 more cron cycles** — check that event counts are growing and the sync is advancing past the startBlock
6. **Reset stale sync state** (optional) — if USDC/USDT sync state is stuck at old blocks, manually reset via D1 console: `DELETE FROM mint_burn_sync_state;` — the sync will restart from `startBlock`
