# Depeg Event Multi-Source Validation — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent false depeg events on mega-cap (>$1B) stablecoins by requiring temporal confirmation + multi-source agreement before creating events.

**Architecture:** New `depeg_pending` table holds suspected depegs for ≥$1B coins. A confirmation function runs after each sync cycle, promoting to real events only when CoinGecko or DEX data agrees. A one-time admin audit endpoint retroactively cleans historical false positives.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), CoinGecko public API, existing DEX price data.

---

### Task 1: Create the `depeg_pending` migration

**Files:**
- Create: `worker/migrations/0023_depeg_pending.sql`

**Step 1: Write the migration SQL**

```sql
-- Pending depeg events awaiting multi-source confirmation (>$1B coins only)
CREATE TABLE IF NOT EXISTS depeg_pending (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stablecoin_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  peg_type TEXT NOT NULL,
  direction TEXT NOT NULL,
  first_seen_bps INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  first_price REAL NOT NULL,
  peg_reference REAL NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_depeg_pending_coin ON depeg_pending(stablecoin_id);
```

**Step 2: Commit**

```bash
git add worker/migrations/0023_depeg_pending.sql
git commit -m "feat(depeg): add depeg_pending table migration"
```

---

### Task 2: Add confirmation constants

**Files:**
- Modify: `worker/src/lib/constants.ts` (append after line 57)

**Step 1: Add the new constants**

Append these after the existing constants at the end of `worker/src/lib/constants.ts`:

```typescript
// --- Depeg multi-source confirmation (>$1B coins) ---

/** Minimum circulating supply (USD) for multi-source depeg confirmation */
export const DEPEG_CONFIRMATION_SUPPLY_THRESHOLD = 1_000_000_000; // $1B

/** Minimum age (seconds) before a pending depeg can be promoted */
export const DEPEG_PENDING_MIN_AGE_SEC = 900; // 15 min (1 sync cycle)

/** Maximum age (seconds) before an unconfirmed pending depeg expires */
export const DEPEG_PENDING_EXPIRY_SEC = 2700; // 45 min (3 sync cycles)

/** Secondary source agreement threshold as fraction of primary threshold */
export const DEPEG_SECONDARY_THRESHOLD_RATIO = 0.5;
```

**Step 2: Verify type-check passes**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add worker/src/lib/constants.ts
git commit -m "feat(depeg): add multi-source confirmation constants"
```

---

### Task 3: Branch >$1B coins to pending table in `detect-depegs.ts`

**Files:**
- Modify: `worker/src/cron/detect-depegs.ts`

This task modifies the "Open new event" branch (lines 176-202) to divert >$1B coins into `depeg_pending` instead of creating instant events. The existing DEX cross-validation for <$1B coins stays unchanged.

**Step 1: Add imports**

At the top of `detect-depegs.ts`, add to the existing constants import:

```typescript
import { getDepegThresholdBps, DEX_FRESHNESS_SEC, DEPEG_CONFIRMATION_SUPPLY_THRESHOLD } from "../lib/constants";
```

**Step 2: Modify the new-event branch (lines 176-202)**

Replace the `} else {` block at line 176 (the "Open new event" branch where `existing` is falsy) with logic that checks supply:

```typescript
      } else {
        // Open new event — check supply threshold for multi-source confirmation
        const coinSupply = sumPegBuckets(asset.circulating);

        if (coinSupply >= DEPEG_CONFIRMATION_SUPPLY_THRESHOLD) {
          // >=$1B coin: insert into pending table for confirmation next cycle
          stmts.push(
            db.prepare(
              `INSERT INTO depeg_pending (stablecoin_id, symbol, peg_type, direction, first_seen_bps, first_seen_at, first_price, peg_reference)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(stablecoin_id) DO NOTHING`
            ).bind(asset.id, asset.symbol, asset.pegType ?? "", direction, bps, now, price, pegRef)
          );
          console.log(
            `[depeg] Pending confirmation for ${asset.symbol}: ${bps}bps (supply $${(coinSupply / 1e9).toFixed(1)}B)`
          );
        } else {
          // <$1B coin: existing behavior — DEX cross-validation then instant event
          const dexRow = dexPrices.get(asset.id);
          const dexFresh = dexRow && (now - dexRow.updated_at) < DEX_FRESHNESS_SEC;
          if (dexFresh) {
            const dexBps = Math.abs(Math.round(
              ((dexRow.dex_price_usd / pegRef) - 1) * 10000
            ));
            if (dexBps < threshold) {
              console.log(
                `[depeg] Suppressed new event for ${asset.symbol}: ` +
                `primary=${bps}bps but DEX=${dexBps}bps (${dexRow.source_pool_count} pools, ` +
                `$${(dexRow.source_total_tvl / 1e6).toFixed(1)}M TVL)`
              );
              continue;
            }
          }
          stmts.push(
            db.prepare(
              `INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peak_price, peg_reference, source)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live')`
            ).bind(asset.id, asset.symbol, asset.pegType ?? "", direction, bps, now, price, price, pegRef)
          );
        }
      }
```

Note: `coinSupply` is computed from `asset.circulating` which is already available. The variable `supply` at line 104 exists but it's scoped to the filter check (min 1M supply); recomputing here is clearer.

**Step 3: Verify type-check passes**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors

**Step 4: Commit**

```bash
git add worker/src/cron/detect-depegs.ts
git commit -m "feat(depeg): route >$1B coins through pending confirmation"
```

---

### Task 4: Create `confirm-pending-depegs.ts`

**Files:**
- Create: `worker/src/cron/confirm-pending-depegs.ts`

This is the core confirmation logic. It processes rows in `depeg_pending`, checks age, fetches CoinGecko spot prices, reads DEX data, and promotes/expires/keeps pending records.

**Step 1: Write the confirmation module**

Create `worker/src/cron/confirm-pending-depegs.ts`:

```typescript
import {
  getDepegThresholdBps,
  DEX_FRESHNESS_SEC,
  DEPEG_PENDING_MIN_AGE_SEC,
  DEPEG_PENDING_EXPIRY_SEC,
  DEPEG_SECONDARY_THRESHOLD_RATIO,
  USER_AGENT,
} from "../lib/constants";
import { TRACKED_STABLECOINS } from "../../../src/lib/stablecoins";
import { fetchWithRetry } from "../lib/fetch-retry";
import type { PegAssetBase } from "../../../src/lib/types";
import { sumPegBuckets } from "../../../src/lib/supply";
import { derivePegRates, getPegReference } from "../../../src/lib/peg-rates";

interface PendingRow {
  id: number;
  stablecoin_id: string;
  symbol: string;
  peg_type: string;
  direction: string;
  first_seen_bps: number;
  first_seen_at: number;
  first_price: number;
  peg_reference: number;
}

/**
 * Process pending depeg records for >$1B coins.
 * Called after detectDepegEvents() in each sync cycle.
 *
 * For each pending record:
 * 1. If primary price no longer exceeds threshold → delete (transient noise)
 * 2. If too young (same cycle) → skip (wait for next cycle)
 * 3. Fetch CoinGecko spot price and read DEX median
 * 4. If primary + secondary agree → promote to real event
 * 5. If primary above but both secondary disagree → delete (false positive)
 * 6. If no secondary data available → keep (retry next cycle)
 * 7. If pending > 45 min without promotion → delete (expired)
 */
export async function confirmPendingDepegs(
  db: D1Database,
  assets: PegAssetBase[],
  fxFallbackRates?: Record<string, number>,
): Promise<void> {
  const pending = await db
    .prepare("SELECT * FROM depeg_pending")
    .all<PendingRow>();

  const rows = pending.results ?? [];
  if (rows.length === 0) return;

  const now = Math.floor(Date.now() / 1000);
  const metaById = new Map(TRACKED_STABLECOINS.map((s) => [s.id, s]));
  const assetById = new Map(assets.map((a) => [a.id, a]));

  // Compute peg rates for reference price lookups
  const { rates: pegRates } = derivePegRates(assets, metaById, fxFallbackRates);

  // Load DEX prices
  let dexPrices = new Map<string, { dex_price_usd: number; updated_at: number }>();
  try {
    const dexResult = await db
      .prepare("SELECT stablecoin_id, dex_price_usd, updated_at FROM dex_prices")
      .all<{ stablecoin_id: string; dex_price_usd: number; updated_at: number }>();
    dexPrices = new Map((dexResult.results ?? []).map((r) => [r.stablecoin_id, r]));
  } catch {
    // dex_prices table may not exist yet
  }

  // Check for existing open events to avoid duplicates
  const openEvents = await db
    .prepare("SELECT stablecoin_id FROM depeg_events WHERE ended_at IS NULL")
    .all<{ stablecoin_id: string }>();
  const openSet = new Set((openEvents.results ?? []).map((r) => r.stablecoin_id));

  for (const row of rows) {
    const asset = assetById.get(row.stablecoin_id);
    const meta = metaById.get(row.stablecoin_id);
    const threshold = getDepegThresholdBps(row.peg_type);
    const secondaryBar = Math.round(threshold * DEPEG_SECONDARY_THRESHOLD_RATIO);

    // If an open event was created by another path (e.g. direction change), clean up pending
    if (openSet.has(row.stablecoin_id)) {
      await db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id).run();
      console.log(`[depeg-confirm] Cleaned pending for ${row.symbol}: open event already exists`);
      continue;
    }

    // 1. Check if primary price still exceeds threshold
    if (asset) {
      const price = asset.price;
      if (price != null && typeof price === "number" && price > 0) {
        const pegRef = getPegReference(asset.pegType, pegRates, meta?.commodityOunces);
        if (pegRef > 0) {
          const currentBps = Math.abs(Math.round(((price / pegRef) - 1) * 10000));
          if (currentBps < threshold) {
            await db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id).run();
            console.log(`[depeg-confirm] Cleared pending for ${row.symbol}: primary recovered to ${currentBps}bps`);
            continue;
          }
        }
      }
    }

    // 2. Check age — skip if too young (same cycle)
    const age = now - row.first_seen_at;
    if (age < DEPEG_PENDING_MIN_AGE_SEC) {
      continue; // Wait for next cycle
    }

    // 7. Check expiry — delete if too old without confirmation
    if (age > DEPEG_PENDING_EXPIRY_SEC) {
      await db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id).run();
      console.log(`[depeg-confirm] Expired pending for ${row.symbol}: ${Math.round(age / 60)}min without confirmation`);
      continue;
    }

    // 3. Fetch CoinGecko spot price
    let cgAgrees: boolean | null = null; // null = no data
    const geckoId = meta?.geckoId;
    if (geckoId) {
      try {
        const cgRes = await fetchWithRetry(
          `https://api.coingecko.com/api/v3/simple/price?ids=${geckoId}&vs_currencies=usd`,
          { headers: { Accept: "application/json", "User-Agent": USER_AGENT } },
          1, // single retry
        );
        if (cgRes?.ok) {
          const cgData = (await cgRes.json()) as Record<string, { usd?: number }>;
          const cgPrice = cgData[geckoId]?.usd;
          if (cgPrice && cgPrice > 0) {
            const cgBps = Math.abs(Math.round(((cgPrice / row.peg_reference) - 1) * 10000));
            cgAgrees = cgBps >= secondaryBar;
            console.log(
              `[depeg-confirm] ${row.symbol} CG check: price=$${cgPrice}, deviation=${cgBps}bps, ` +
              `bar=${secondaryBar}bps, agrees=${cgAgrees}`
            );
          }
        }
      } catch (err) {
        console.warn(`[depeg-confirm] CG fetch failed for ${row.symbol}:`, err);
      }
    }

    // 4. Read DEX median
    let dexAgrees: boolean | null = null;
    const dexRow = dexPrices.get(row.stablecoin_id);
    if (dexRow && (now - dexRow.updated_at) < DEX_FRESHNESS_SEC) {
      const dexBps = Math.abs(Math.round(
        ((dexRow.dex_price_usd / row.peg_reference) - 1) * 10000
      ));
      dexAgrees = dexBps >= secondaryBar;
      console.log(
        `[depeg-confirm] ${row.symbol} DEX check: price=$${dexRow.dex_price_usd}, deviation=${dexBps}bps, ` +
        `bar=${secondaryBar}bps, agrees=${dexAgrees}`
      );
    }

    // 5. Decision
    if (cgAgrees === true || dexAgrees === true) {
      // At least one secondary source confirms — promote to real event
      const currentPrice = asset?.price ?? row.first_price;
      const currentBps = asset?.price
        ? Math.round(((asset.price / row.peg_reference) - 1) * 10000)
        : row.first_seen_bps;

      await db.batch([
        db.prepare(
          `INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peak_price, peg_reference, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live')`
        ).bind(
          row.stablecoin_id, row.symbol, row.peg_type, row.direction,
          Math.abs(currentBps) > Math.abs(row.first_seen_bps) ? currentBps : row.first_seen_bps,
          row.first_seen_at, row.first_price, currentPrice, row.peg_reference,
        ),
        db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id),
      ]);

      const confirmedBy = [
        cgAgrees ? "CoinGecko" : null,
        dexAgrees ? "DEX" : null,
      ].filter(Boolean).join("+");
      console.log(
        `[depeg-confirm] PROMOTED ${row.symbol}: ${row.first_seen_bps}bps confirmed by ${confirmedBy}`
      );
    } else if (cgAgrees === false && dexAgrees === false) {
      // Both secondary sources disagree — confirmed false positive
      await db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id).run();
      console.log(
        `[depeg-confirm] Rejected false positive for ${row.symbol}: both CG and DEX disagree`
      );
    } else if (cgAgrees === false && dexAgrees === null) {
      // CG disagrees, no DEX data — lean toward false positive
      await db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id).run();
      console.log(
        `[depeg-confirm] Rejected ${row.symbol}: CG disagrees, no DEX data`
      );
    }
    // else: cgAgrees === null and dexAgrees === null (or null+false) — keep pending, retry next cycle
  }
}
```

**Step 2: Verify type-check passes**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add worker/src/cron/confirm-pending-depegs.ts
git commit -m "feat(depeg): add pending depeg confirmation with CG + DEX validation"
```

---

### Task 5: Wire confirmation into `sync-stablecoins.ts`

**Files:**
- Modify: `worker/src/cron/sync-stablecoins.ts`

**Step 1: Add import**

At the top of `sync-stablecoins.ts`, add:

```typescript
import { confirmPendingDepegs } from "./confirm-pending-depegs";
```

**Step 2: Call confirmPendingDepegs after detectDepegEvents**

In `syncStablecoins()`, after the existing depeg detection block (lines 502-507), add the confirmation call:

```typescript
  // Confirm or expire pending depeg events for >$1B coins
  try {
    await confirmPendingDepegs(db, llamaData.peggedAssets, llamaData.fxFallbackRates);
  } catch (err) {
    console.error("[sync-stablecoins] Pending depeg confirmation failed:", err);
  }
```

This goes right after the existing `detectDepegEvents` try/catch block (after line 507) and before the metadata block (line 510).

**Step 3: Verify type-check passes**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors

**Step 4: Verify full build**

Run: `npm run build`
Expected: clean build, no errors

**Step 5: Commit**

```bash
git add worker/src/cron/sync-stablecoins.ts
git commit -m "feat(depeg): wire pending confirmation into sync cycle"
```

---

### Task 6: Create historical audit endpoint

**Files:**
- Create: `worker/src/api/audit-depeg-history.ts`

This admin endpoint retroactively identifies and removes false positive depeg events by cross-referencing with CoinGecko historical data, then recomputes affected stability index days.

**Step 1: Write the audit endpoint**

Create `worker/src/api/audit-depeg-history.ts`:

```typescript
import { withErrorHandler } from "../lib/api-utils";
import { requireAdmin } from "../lib/auth";
import { TRACKED_STABLECOINS } from "../../../src/lib/stablecoins";
import { getDepegThresholdBps, DEPEG_SECONDARY_THRESHOLD_RATIO, USER_AGENT } from "../lib/constants";
import { computeStabilityIndex } from "../lib/stability-index";
import { batchExecute } from "../lib/db";
import type { DepegRow } from "../lib/depeg-helpers";

const DAY = 86400;

interface AuditResult {
  eventsAudited: number;
  falsePositivesDeleted: number;
  deletedEvents: { id: number; symbol: string; startedAt: number; peakBps: number }[];
  daysRecomputed: number;
  skippedNoGeckoId: number;
  cgFetchErrors: number;
}

export const handleAuditDepegHistory = withErrorHandler(
  "audit-depeg-history",
  async (db: D1Database, adminKey?: string, request?: Request): Promise<Response> => {
    const authError = await requireAdmin(request, adminKey);
    if (authError) return authError;

    const metaById = new Map(TRACKED_STABLECOINS.map((s) => [s.id, s]));

    // 1. Query all closed depeg events
    const allEvents = await db
      .prepare(
        "SELECT * FROM depeg_events WHERE ended_at IS NOT NULL ORDER BY started_at"
      )
      .all<DepegRow>();
    const events = allEvents.results ?? [];

    // Filter to high-impact events (coins with >$1B supply at time of event)
    // Use supply_history to determine supply at event time
    const supplyRows = await db
      .prepare("SELECT stablecoin_id, snapshot_date, circulating_usd FROM supply_history ORDER BY snapshot_date")
      .all<{ stablecoin_id: string; snapshot_date: number; circulating_usd: number }>();
    const supplyByCoin = new Map<string, { date: number; supply: number }[]>();
    for (const r of supplyRows.results ?? []) {
      const list = supplyByCoin.get(r.stablecoin_id) ?? [];
      list.push({ date: r.snapshot_date, supply: r.circulating_usd });
      supplyByCoin.set(r.stablecoin_id, list);
    }

    function getSupplyAtTime(coinId: string, ts: number): number {
      const snaps = supplyByCoin.get(coinId);
      if (!snaps || snaps.length === 0) return 0;
      let best = snaps[0];
      for (const s of snaps) {
        if (Math.abs(s.date - ts) < Math.abs(best.date - ts)) best = s;
        if (s.date > ts) break;
      }
      return Math.abs(best.date - ts) <= 30 * DAY ? best.supply : 0;
    }

    const highImpactEvents = events.filter(
      (e) => getSupplyAtTime(e.stablecoin_id, e.started_at) >= 1_000_000_000
    );

    const result: AuditResult = {
      eventsAudited: highImpactEvents.length,
      falsePositivesDeleted: 0,
      deletedEvents: [],
      daysRecomputed: 0,
      skippedNoGeckoId: 0,
      cgFetchErrors: 0,
    };

    const affectedDays = new Set<number>();

    for (const event of highImpactEvents) {
      const meta = metaById.get(event.stablecoin_id);
      const geckoId = meta?.geckoId;

      if (!geckoId) {
        result.skippedNoGeckoId++;
        continue;
      }

      const threshold = getDepegThresholdBps(event.peg_type);
      const falsePositiveBar = Math.round(threshold * DEPEG_SECONDARY_THRESHOLD_RATIO);

      // Fetch CoinGecko historical data for the event window
      const from = event.started_at - 3600;
      const to = (event.ended_at ?? event.started_at) + 3600;

      try {
        // Rate limit: 2-second delay between CG calls
        await new Promise((r) => setTimeout(r, 2000));

        const cgRes = await fetch(
          `https://api.coingecko.com/api/v3/coins/${geckoId}/market_chart/range?vs_currency=usd&from=${from}&to=${to}`,
          { headers: { Accept: "application/json", "User-Agent": USER_AGENT } },
        );

        if (!cgRes.ok) {
          console.warn(`[audit] CG fetch failed for ${event.symbol} (${geckoId}): ${cgRes.status}`);
          result.cgFetchErrors++;
          continue;
        }

        const cgData = (await cgRes.json()) as { prices?: [number, number][] };
        const prices = cgData.prices ?? [];

        if (prices.length === 0) {
          continue; // No data for this window
        }

        // Find max deviation in CG data during the event window
        let maxCgBps = 0;
        for (const [, cgPrice] of prices) {
          if (cgPrice <= 0) continue;
          const cgBps = Math.abs(Math.round(((cgPrice / event.peg_reference) - 1) * 10000));
          if (cgBps > maxCgBps) maxCgBps = cgBps;
        }

        if (maxCgBps < falsePositiveBar) {
          // CoinGecko never confirmed this deviation — false positive
          await db.prepare("DELETE FROM depeg_events WHERE id = ?").bind(event.id).run();
          result.falsePositivesDeleted++;
          result.deletedEvents.push({
            id: event.id,
            symbol: event.symbol,
            startedAt: event.started_at,
            peakBps: event.peak_deviation_bps,
          });

          // Track affected days for stability index recomputation
          const startDay = Math.floor(event.started_at / DAY) * DAY;
          const endDay = Math.floor((event.ended_at ?? event.started_at) / DAY) * DAY;
          for (let d = startDay; d <= endDay; d += DAY) {
            affectedDays.add(d);
          }

          console.log(
            `[audit] Deleted false positive: ${event.symbol} id=${event.id} peak=${event.peak_deviation_bps}bps, CG max=${maxCgBps}bps`
          );
        }
      } catch (err) {
        console.warn(`[audit] Error auditing ${event.symbol}:`, err);
        result.cgFetchErrors++;
      }
    }

    // Recompute stability index for affected days
    if (affectedDays.size > 0) {
      const sortedDays = [...affectedDays].sort((a, b) => a - b);
      const now = Math.floor(Date.now() / 1000);

      // Reload depeg events after deletions
      const remainingDepegs = await db
        .prepare("SELECT stablecoin_id, peak_deviation_bps, started_at, ended_at FROM depeg_events ORDER BY started_at")
        .all<{ stablecoin_id: string; peak_deviation_bps: number; started_at: number; ended_at: number | null }>();
      const depegEvents = remainingDepegs.results ?? [];

      // Load supply data
      const allSupply = await db
        .prepare("SELECT stablecoin_id, snapshot_date, circulating_usd FROM supply_history ORDER BY snapshot_date")
        .all<{ stablecoin_id: string; snapshot_date: number; circulating_usd: number }>();
      const supplyForRecompute = new Map<string, { date: number; mcap: number }[]>();
      for (const r of allSupply.results ?? []) {
        const list = supplyForRecompute.get(r.stablecoin_id) ?? [];
        list.push({ date: r.snapshot_date, mcap: r.circulating_usd });
        supplyForRecompute.set(r.stablecoin_id, list);
      }

      function getMcapForDay(coinId: string, day: number): number {
        const snapshots = supplyForRecompute.get(coinId);
        if (!snapshots || snapshots.length === 0) return 0;
        let best = snapshots[0];
        for (const s of snapshots) {
          if (Math.abs(s.date - day) < Math.abs(best.date - day)) best = s;
          if (s.date > day) break;
        }
        return Math.abs(best.date - day) <= 14 * DAY ? best.mcap : 0;
      }

      const stmts: D1PreparedStatement[] = [];

      for (const day of sortedDays) {
        // Delete existing index entry for this day
        stmts.push(
          db.prepare("DELETE FROM stability_index WHERE computed_at = ?").bind(day)
        );

        // Find active depegs on this day
        const activeDepegs = depegEvents.filter(
          (e) => e.started_at <= day && (e.ended_at === null ? day <= now : e.ended_at > day)
        );

        const depegs: { bps: number; mcapUsd: number }[] = activeDepegs.map((e) => ({
          bps: e.peak_deviation_bps,
          mcapUsd: getMcapForDay(e.stablecoin_id, day),
        }));

        let totalMcapUsd = 0;
        for (const [, snapshots] of supplyForRecompute) {
          let best = snapshots[0];
          for (const s of snapshots) {
            if (Math.abs(s.date - day) < Math.abs(best.date - day)) best = s;
            if (s.date > day) break;
          }
          if (Math.abs(best.date - day) <= 14 * DAY) totalMcapUsd += best.mcap;
        }

        const day7ago = day - 7 * DAY;
        let totalMcap7dAgo = 0;
        for (const [, snapshots] of supplyForRecompute) {
          let best = snapshots[0];
          for (const s of snapshots) {
            if (Math.abs(s.date - day7ago) < Math.abs(best.date - day7ago)) best = s;
            if (s.date > day7ago) break;
          }
          if (Math.abs(best.date - day7ago) <= 14 * DAY) totalMcap7dAgo += best.mcap;
        }

        const mcap7dChangePct = totalMcap7dAgo > 0
          ? ((totalMcapUsd - totalMcap7dAgo) / totalMcap7dAgo) * 100
          : 0;

        const indexResult = computeStabilityIndex({
          depegs,
          totalMcapUsd,
          freezeCount24h: 0,
          mcap7dChangePct,
        });

        stmts.push(
          db.prepare(
            "INSERT INTO stability_index (computed_at, score, band, components, input_snapshot) VALUES (?, ?, ?, ?, ?)"
          ).bind(
            day,
            indexResult.score,
            indexResult.band,
            JSON.stringify(indexResult.components),
            JSON.stringify({ depegCount: depegs.length, totalMcapUsd, freezeCount24h: 0, mcap7dChangePct }),
          )
        );
      }

      await batchExecute(db, stmts);
      result.daysRecomputed = sortedDays.length;
    }

    return new Response(JSON.stringify(result, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  }
);
```

**Step 2: Verify type-check passes**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add worker/src/api/audit-depeg-history.ts
git commit -m "feat(depeg): add historical false positive audit endpoint"
```

---

### Task 7: Register audit route and skip edge cache

**Files:**
- Modify: `worker/src/router.ts`
- Modify: `worker/src/index.ts`

**Step 1: Add import and route to `router.ts`**

In `worker/src/router.ts`, add the import at the top:

```typescript
import { handleAuditDepegHistory } from "./api/audit-depeg-history";
```

Add the route before the stablecoin detail catch-all (before line 104):

```typescript
  if (path === "/api/audit-depeg-history") {
    return handleAuditDepegHistory(db, adminKey, request);
  }
```

**Step 2: Add cache bypass in `index.ts`**

In `worker/src/index.ts`, extend the `skipCache` check (line 122) to include the audit endpoint:

```typescript
const skipCache = url.pathname === "/api/health" || url.pathname === "/api/status" || url.pathname === "/api/backfill-depegs" || url.pathname === "/api/backfill-supply-history" || url.pathname === "/api/audit-depeg-history";
```

**Step 3: Verify type-check passes**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors

**Step 4: Verify full build**

Run: `npm run build`
Expected: clean build, no errors

**Step 5: Commit**

```bash
git add worker/src/router.ts worker/src/index.ts
git commit -m "feat(depeg): register audit endpoint route"
```

---

### Task 8: Final verification

**Step 1: Full type-check (worker)**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors

**Step 2: Full frontend build**

Run: `npm run build`
Expected: clean build, no errors

**Step 3: Review changes**

Run: `git diff main --stat`
Verify the expected files were changed and nothing unexpected was modified.

**Step 4: Verify migration count**

Check that only one new migration (0023) was added and it matches the design doc schema exactly.
