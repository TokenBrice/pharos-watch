# PSI Scoring Fix: Use Current Deviation Instead of Peak

**Date:** 2026-02-25
**Status:** Approved

## Problem

Both the live cron and historical backfill use `peak_deviation_bps` from `depeg_events` to score the PSI. This overstates severity:

- **Live cron**: If a coin peaked at 500 bps but is currently at 120 bps, the score uses 500 bps — a 4x overstatement. Today's score (75.6) has severity=10.02 and breadth=15 (maxed) despite no major depegs being active.
- **Backfill**: Every day of a depeg event's duration gets scored with the eventual peak. If sUSD started at 200 bps on Jan 25 and peaked at 2500 bps on Feb 5, the backfill scores Jan 25 with 2500 bps.

## Solution

**Live cron**: Compute current bps from live prices (already in the stablecoins cache) and `peg_reference` (stored on each depeg event).

**Backfill**: Compute bps from `start_price` and `peg_reference` (both stored on each depeg event). This is the best real data point available — the actual price when the depeg was first detected.

## Implementation

### Step 1: Fix live cron (`worker/src/cron/stability-index.ts`)

**Current code (lines 32–39):**
```typescript
// Active depegs
const activeDepegs = await db
  .prepare("SELECT stablecoin_id, peak_deviation_bps FROM depeg_events WHERE ended_at IS NULL")
  .all<{ stablecoin_id: string; peak_deviation_bps: number }>();
const depegs = (activeDepegs.results ?? []).map((r) => ({
  bps: r.peak_deviation_bps,
  mcapUsd: mcapById.get(r.stablecoin_id) ?? 0,
}));
```

**Replace with:**
```typescript
// Active depegs — use current price to compute live deviation
const activeDepegs = await db
  .prepare("SELECT stablecoin_id, peg_reference FROM depeg_events WHERE ended_at IS NULL")
  .all<{ stablecoin_id: string; peg_reference: number }>();

// Build price lookup from stablecoins cache
const priceById = new Map<string, number>();
for (const coin of tracked) {
  if (coin.price != null && typeof coin.price === "number" && coin.price > 0) {
    priceById.set(coin.id, coin.price);
  }
}

const depegs = (activeDepegs.results ?? []).flatMap((r) => {
  const price = priceById.get(r.stablecoin_id);
  if (!price || r.peg_reference <= 0) return [];
  const bps = Math.round(((price / r.peg_reference) - 1) * 10000);
  return [{ bps, mcapUsd: mcapById.get(r.stablecoin_id) ?? 0 }];
});
```

**Key details:**
- SQL changes: select `peg_reference` instead of `peak_deviation_bps`
- D1 type annotation changes: `{ stablecoin_id: string; peg_reference: number }` (was `peak_deviation_bps: number`)
- `priceById` map: built from the `tracked` array (already constructed at line 15), using `coin.price`
  - Guard: `coin.price != null && typeof coin.price === "number" && coin.price > 0`
  - This mirrors the exact same guard used in `detect-depegs.ts:101`
- `.flatMap()` instead of `.map()`: returns empty array `[]` to skip events where we have no current price or invalid peg_reference, rather than including them with bps=0
  - A missing price means we can't assess the current state — excluding is correct
  - A coin with mcap=0 (not in tracked list) would also be excluded since `priceById` only contains tracked coins
- `bps` computation: `Math.round(((price / r.peg_reference) - 1) * 10000)` — same formula used in `detect-depegs.ts:109`
  - This produces signed bps (positive = above peg, negative = below peg)
  - The scoring formula uses `Math.abs(d.bps)` (stability-index.ts:33) so sign doesn't matter

**No other changes needed in this file.** The `mcapById`, `totalMcapUsd`, freeze count, trend, insert statement, and logging all remain identical.

### Step 2: Fix backfill (`worker/src/api/backfill-stability-index.ts`)

**Current code (lines 32–34, the SELECT):**
```typescript
const allDepegs = await db
  .prepare("SELECT stablecoin_id, peak_deviation_bps, started_at, ended_at FROM depeg_events ORDER BY started_at")
  .all<{ stablecoin_id: string; peak_deviation_bps: number; started_at: number; ended_at: number | null }>();
```

**Replace with:**
```typescript
const allDepegs = await db
  .prepare("SELECT stablecoin_id, start_price, peg_reference, started_at, ended_at FROM depeg_events ORDER BY started_at")
  .all<{ stablecoin_id: string; start_price: number; peg_reference: number; started_at: number; ended_at: number | null }>();
```

**Key details:**
- SQL changes: select `start_price, peg_reference` instead of `peak_deviation_bps`
- D1 type annotation: replace `peak_deviation_bps: number` with `start_price: number; peg_reference: number`
- Column types in the DB schema (migration 0006): `start_price REAL NOT NULL`, `peg_reference REAL NOT NULL` — both always present, no null handling needed

**Current code (line 81, inside the per-day loop):**
```typescript
depegs.push({ bps: e.peak_deviation_bps, mcapUsd: mcap });
```

**Replace with:**
```typescript
const bps = e.peg_reference > 0
  ? Math.round(((e.start_price / e.peg_reference) - 1) * 10000)
  : 0;
depegs.push({ bps, mcapUsd: mcap });
```

**Key details:**
- Guard `e.peg_reference > 0`: prevents division by zero. If peg_reference is 0 or negative (shouldn't happen but defensive), bps defaults to 0
- `start_price / peg_reference`: computes the deviation at the time the depeg was first detected
- This uses the same bps formula as detect-depegs.ts and the live cron fix above
- `start_price` is the real observed price at event creation — it's conservative (likely smaller deviation than peak) but based on actual data
- No other changes needed in the backfill file

### Step 3: Type-check

```bash
cd worker && npx tsc --noEmit
```

Both files import from `../lib/stability-index` (unchanged) and `../lib/db` (unchanged). The only changes are SQL strings and local variable types. No new imports needed.

### Step 4: Commit and push

Single commit with both files. Push to main triggers Cloudflare Pages deployment.

### Step 5: After deployment — re-run backfill

```
GET /api/backfill-stability-index  (with admin auth)
```

This clears the `stability_index` table and regenerates all historical scores with the corrected deviation. The next live cron run (07:55 UTC) will also produce a corrected score using current prices.

## Verification

After backfill:
- `GET /api/stability-index?detail=true` — check that the current score and recent history look reasonable
- Jan 29-30 period should no longer show a dramatic dip
- Current score should be closer to ~95 if only micro-coin depegs are active
- sUSD's contribution should be negligible (~0.6 points total at most)
