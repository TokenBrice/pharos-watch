# Depeg Event Multi-Source Validation

**Date:** 2026-02-25
**Status:** Approved

## Problem

A single stale or anomalous price reading from DefiLlama can create a false depeg event on a mega-cap stablecoin. On January 17-18, 2026, DefiLlama reported USDC at $1.01 (100bps above peg) for one sync cycle. CoinGecko hourly data for the same window shows USDC never exceeded $1.0035 (35bps) — well within normal noise.

That phantom 100bps reading triggered a depeg event. The stability index formula, designed to amplify mega-cap deviations via the `log2(1 + mcap/$1B)` multiplier, computed severity=60 (capped) and breadth=15 (capped) from USDC's $77B market cap alone. Result: a one-day CRISIS (26.1) on an otherwise calm day.

The existing DEX cross-validation (lines 177-193 of `detect-depegs.ts`) already suppresses events when DEX data disagrees, but it only works when DEX data is fresh (<20 min). When DEX data is stale — weekends, low-activity periods — the check is skipped and the false positive sails through.

### Impact

- **Stability index corruption**: A single bad reading can drop the index 70+ points and trigger a false CRISIS band.
- **Digest contamination**: Sonnet comments on the score — a phantom CRISIS produces alarming editorial copy that erodes trust.
- **Historical record pollution**: The Jan 18, 2026 CRISIS is permanently baked into the sparkline alongside real events (SVB, FTX).

## Solution

Two complementary mechanisms gate depeg event creation for high-impact coins:

1. **Temporal confirmation**: Require the deviation to persist across 2 consecutive sync cycles (~30 min). Transient data anomalies self-correct within one cycle.
2. **Multi-source agreement**: Before promoting a pending event to a real one, verify the deviation against at least one independent source (CoinGecko spot price or DEX median).

Plus a one-time **historical audit** that retroactively cleans false positives from the existing data and recomputes affected stability index days.

### Scope

- **Gated coins**: All stablecoins with circulating supply >$1B at detection time. Currently ~15-20 coins including USDT, USDC, DAI, USDe, USDS, FDUSD, PYUSD.
- **Ungated coins**: Coins with <$1B supply keep current behavior — instant single-source detection with existing DEX cross-validation. False positives on small coins don't materially affect the stability index.

## Architecture

### Pending Depeg State

A new `depeg_pending` table stores suspected-but-unconfirmed depeg events:

```sql
CREATE TABLE depeg_pending (
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
CREATE UNIQUE INDEX idx_depeg_pending_coin ON depeg_pending(stablecoin_id);
```

The unique index on `stablecoin_id` ensures at most one pending record per coin. If a coin already has a pending record and the primary price still shows deviation, the existing record is kept (first-seen timestamp preserved).

### Detection Flow

The change is in `detectDepegEvents()` in `worker/src/cron/detect-depegs.ts`. The current flow for opening new events (lines 176-201) gains a branch:

```
Primary price crosses threshold for coin with no existing event:
  │
  ├─ Supply < $1B → Current behavior (instant event, DEX cross-validation)
  │
  └─ Supply >= $1B → Insert into depeg_pending (no event created yet)
```

### Confirmation Flow

After the main detection loop, a new `processPendingDepegs()` function runs:

```
For each row in depeg_pending:
  │
  ├─ 1. Check primary price (from current sync's asset data)
  │     └─ Below threshold? → DELETE pending (transient noise)
  │
  ├─ 2. Check age: (now - first_seen_at)
  │     └─ < 15 min (same cycle)? → SKIP (wait for next cycle)
  │
  ├─ 3. Fetch CoinGecko spot price for this coin
  │     └─ Calculate CG deviation in bps
  │
  ├─ 4. Read DEX median from dex_prices table (if fresh)
  │     └─ Calculate DEX deviation in bps
  │
  └─ 5. Decision:
        ├─ Primary above threshold AND (CG OR DEX) agrees → PROMOTE to real event
        ├─ Primary above threshold AND both disagree     → DELETE pending (confirmed false positive)
        ├─ Primary above threshold AND no secondary data  → KEEP pending (retry next cycle)
        └─ Pending age > 45 min without promotion        → DELETE (expiry, no source confirms)
```

### Secondary Source Agreement

A secondary source "agrees" when its deviation is at or above **half the primary threshold**:

| Peg type | Primary threshold | Secondary agreement bar |
|---|---|---|
| USD-pegged | 100bps | 50bps |
| Non-USD | 150bps | 75bps |

The softer bar accounts for price source timing differences. If CoinGecko shows 60bps while DefiLlama shows 110bps, the deviation is real and directionally consistent — it just hasn't peaked on CG yet.

### CoinGecko Spot Check

The confirmation function makes a targeted CoinGecko API call for each pending coin:

```
GET https://api.coingecko.com/api/v3/simple/price?ids={geckoId}&vs_currencies=usd
```

This is lightweight (single coin, no auth required, <100ms response). In the worst case, there are 2-3 pending records at once — 2-3 API calls per sync cycle, well within CoinGecko's public rate limits (10-30 req/min).

The `geckoId` is resolved from `TRACKED_STABLECOINS` metadata. Coins without a `geckoId` can only be confirmed by DEX data.

### Event Promotion

When a pending record is promoted to a real depeg event:

```sql
INSERT INTO depeg_events (
  stablecoin_id, symbol, peg_type, direction,
  peak_deviation_bps, started_at, start_price, peak_price,
  peg_reference, source
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live')
```

- `started_at` = `first_seen_at` from the pending record (preserves true detection time)
- `start_price` = `first_price` from the pending record
- `peak_deviation_bps` = the current (latest) primary deviation, which may be worse than `first_seen_bps`
- `peak_price` = current primary price

After insertion, the pending record is deleted.

### Interaction with Existing DEX Cross-Validation

The existing DEX cross-validation on lines 177-193 of `detect-depegs.ts` remains active as a **fast-path suppression** for <$1B coins. For >=\$1B coins, it becomes redundant (the pending flow subsumes it), but keeping it is harmless and provides defense-in-depth if a >$1B coin somehow bypasses the pending path.

The existing DEX cross-validation for **ongoing events** (lines 144-174, auto-close after 30 min) is unaffected. This handles the case where a real event was opened but DEX later disagrees — a separate concern from initial event creation.

### Constants

New constants in `worker/src/lib/constants.ts`:

```typescript
/** Minimum circulating supply (USD) for multi-source depeg confirmation */
export const DEPEG_CONFIRMATION_MCAP_THRESHOLD = 1_000_000_000; // $1B

/** Minimum age (seconds) before a pending depeg can be promoted */
export const DEPEG_PENDING_MIN_AGE_SEC = 900; // 15 min (1 sync cycle)

/** Maximum age (seconds) before an unconfirmed pending depeg expires */
export const DEPEG_PENDING_EXPIRY_SEC = 2700; // 45 min (3 sync cycles)

/** Secondary source agreement threshold as fraction of primary threshold */
export const DEPEG_SECONDARY_THRESHOLD_RATIO = 0.5;
```

## Historical False Positive Audit

### Why

The validation system only prevents future false positives. The existing database contains at least one confirmed false positive (USDC Jan 17-18, 2026) and potentially others. These corrupt the stability index history and will remain in the sparkline forever unless cleaned.

### Approach

A one-time admin endpoint `/api/audit-depeg-history` that:

1. **Queries all closed depeg events for coins with >$1B supply** at the time of the event. These are the high-impact events where a false positive materially affects the stability index.

2. **For each event, fetches CoinGecko historical hourly prices** covering the event window:
   ```
   GET /api/v3/coins/{geckoId}/market_chart/range?vs_currency=usd&from={started_at-3600}&to={ended_at+3600}
   ```

3. **Compares CoinGecko's max deviation** during the event window against the depeg threshold:
   - If CoinGecko's peak deviation during the window is **below half the threshold** (50bps for USD pegs): the event is a false positive.
   - If CoinGecko confirms the deviation: the event is legitimate.

4. **Deletes confirmed false positives** from `depeg_events`.

5. **Recomputes stability index** for each affected day using the same `computeStabilityIndex()` function and updated event set. This is the same logic as the backfill endpoint but scoped to only the days that had a deleted event.

6. **Returns an audit report**: which events were deleted, which days were recomputed, before/after scores.

### Rate Limiting

CoinGecko's public API allows 10-30 requests per minute. The audit processes events sequentially with a 2-second delay between CoinGecko calls. For a few hundred high-impact events, this takes 10-15 minutes — acceptable for a one-time admin operation.

### Data Availability

CoinGecko provides hourly granularity for data within the last 90 days and daily granularity beyond that. For older events (>90 days), the audit uses daily prices, which may miss intraday spikes but is sufficient for identifying events where the daily price never left the normal range.

Events without a `geckoId` mapping cannot be audited and are skipped.

## Files

| File | Change |
|---|---|
| `worker/migrations/0023_depeg_pending.sql` | New `depeg_pending` table |
| `worker/src/lib/constants.ts` | New threshold constants |
| `worker/src/cron/detect-depegs.ts` | Branch >$1B coins to pending table instead of instant event creation |
| `worker/src/cron/confirm-pending-depegs.ts` | New: process pending records, CoinGecko spot check, promote/expire |
| `worker/src/cron/sync-stablecoins.ts` | Call `confirmPendingDepegs()` after `detectDepegEvents()` |
| `worker/src/api/audit-depeg-history.ts` | New: one-time admin endpoint for historical false positive cleanup |
| `worker/src/router.ts` | Register `/api/audit-depeg-history` route |

## Testing

### Validation of the Fix

After implementation, verify the Jan 18, 2026 case:

1. Run `/api/audit-depeg-history` — should identify the USDC event (id likely in the 8000s) as a false positive, delete it, and recompute Jan 18's stability index from CRISIS (26.1) to something in the BEDROCK/STEADY range.

2. Check the stability index API — Jan 18 should no longer show a CRISIS dip in the sparkline.

### Regression

The validation only gates event *creation* for >$1B coins. Existing event lifecycle (peak updates, direction changes, recovery closure, orphan cleanup) is unaffected. Small-coin detection is unaffected. The stability index computation is unaffected (it reads from `depeg_events`, which now has cleaner data).
