# Depeg Detection Pipeline

Two-stage depeg detection pipeline for stablecoins. Stage 1 (detection) runs every 15 minutes as part of the `sync-stablecoins` cron. Stage 2 (confirmation) runs immediately after, promoting or rejecting candidates that require multi-source agreement: large-cap coins, low-confidence primary-price inputs, and extreme moves.

## Thresholds & Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `DEPEG_THRESHOLD_BPS` | 100 (1%) | USD peg deviation threshold |
| `DEPEG_THRESHOLD_BPS_NON_USD` | 150 (1.5%) | Non-USD peg threshold (accounts for FX noise + thin liquidity) |
| `DEPEG_CONFIRMATION_SUPPLY_THRESHOLD` | $1,000,000,000 | Coins above this require multi-source confirmation |
| `DEPEG_PENDING_MIN_AGE_SEC` | 900 (15 min) | Minimum time before a pending record can be promoted |
| `DEPEG_PENDING_EXPIRY_SEC` | 2700 (45 min) | Maximum time before a pending record expires |
| `DEPEG_SECONDARY_THRESHOLD_RATIO` | 0.5 | Secondary source agreement bar (50% of primary threshold) |
| `DEPEG_PRIMARY_PRICE_MAX_AGE_SEC` | 1800 (30 min) | Primary prices older than this require confirmation |
| `DEPEG_EXTREME_MOVE_BPS` | 5000 (50%) | Severe move threshold routed through dedicated confirmation lane |
| `DEX_FRESHNESS_SEC` | 2100 (35 min) | DEX prices older than this are ignored |
| `DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD` | 1,000,000 | Minimum aggregate DEX source TVL required before depeg logic trusts a DEX row |
| `DEPEG_DEX_PROTOCOL_CORROBORATION_MIN` | 2 protocol groups | Minimum protocol-level DEX corroborations required before aggregate DEX rows can directly suppress or resolve live depeg state |

`getDepegThresholdBps(pegType)` returns 100 for `peggedUSD`, 150 for all other peg types.

## Database Schema

### depeg_events (migration 0006)

```sql
CREATE TABLE IF NOT EXISTS depeg_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stablecoin_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  peg_type TEXT NOT NULL,
  direction TEXT NOT NULL,              -- "above" | "below"
  peak_deviation_bps INTEGER NOT NULL,
  started_at INTEGER NOT NULL,          -- Unix seconds
  ended_at INTEGER,                     -- NULL = ongoing
  start_price REAL NOT NULL,
  peak_price REAL,
  recovery_price REAL,
  peg_reference REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'live'   -- "live" | "backfill"
);

CREATE INDEX idx_depeg_stablecoin ON depeg_events(stablecoin_id);
CREATE INDEX idx_depeg_started ON depeg_events(started_at DESC);
```

Uniqueness and open-event indexes (migration 0008):

```sql
CREATE UNIQUE INDEX idx_depeg_unique ON depeg_events(stablecoin_id, started_at, source);
CREATE INDEX idx_depeg_open ON depeg_events(stablecoin_id) WHERE ended_at IS NULL;
```

### depeg_pending (migration 0023)

```sql
CREATE TABLE IF NOT EXISTS depeg_pending (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stablecoin_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  peg_type TEXT NOT NULL,
  direction TEXT NOT NULL,
  first_seen_bps INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  first_price REAL NOT NULL,
  peg_reference REAL NOT NULL,
  reason TEXT NOT NULL DEFAULT 'large-cap' -- "large-cap" | "low-confidence" | "extreme-move"
);

CREATE UNIQUE INDEX idx_depeg_pending_coin ON depeg_pending(stablecoin_id);
```

One row per coin maximum. Holds depeg candidates awaiting multi-source confirmation. Migration `0061` adds the `reason` column so operators can distinguish large-cap confirmations from ambiguous-price and extreme-move confirmations.

### Migration 0016

Cleaned up non-USD depeg events with `peak_deviation_bps < 150` when the non-USD threshold was raised from 100 to 150.

## Cron Scheduling

Detection runs as part of the `*/15 * * * *` sync cycle. After `syncStablecoins()` enriches prices, it calls:

1. `detectDepegEvents(db, peggedAssets, fxFallbackRates, signal, coingeckoApiKey)` -- detection
2. `confirmPendingDepegs(db, peggedAssets, fxFallbackRates, signal, coingeckoApiKey)` -- confirmation

Both calls are in `worker/src/cron/sync-stablecoins.ts`. Errors from either are captured in the sync metadata as `depegErrors` array but do not fail the parent cron.

The API layer reuses this event dataset through `worker/src/lib/peg-analytics.ts` (`derivePegAnalyticsSnapshot()`), which builds shared `eventsByCoin` and `pegDataById` maps for both `/api/peg-summary` and `/api/report-cards`.

## Stage 1 -- Detection

### Initialization

1. Load PSI-eligible stablecoins into `metaById` map
2. Derive peg rates (handles FX lookups once)
3. Load DEX prices from `dex_prices` table (silently skip if table missing)
4. Merge duplicate open events: for each coin with multiple open events, keep earliest, absorb worst peak, delete rest

`dex_prices` rows are only trusted for depeg logic when they are both fresh (`updated_at < 35 min`) and deep enough (`source_total_tvl >= $1M`). Thin DEX rows remain visible in storage for analytics, but they do not suppress or confirm events.

The stablecoin detail page can still show the live price deviation for a tracked coin below the live depeg-event floor, but that state is explicitly labelled as coverage-limited. Low-cap tracked coins can therefore look off-peg in the detail UI without opening a `depeg_events` row.

### Per-Asset Processing

Validation gates (skip if any fail):

- Must be in `PSI_ELIGIBLE_STABLECOINS`
- Not a NAV token (`meta.flags.navToken`)
- Price valid: non-null, is a number, not NaN, > 0
- Supply >= $1M (via `sumPegBuckets`) for live event recording
- Peg reference valid: finite and > 0
- Non-USD fiat peg references only mutate live state when they come from cached FX fallback or a median built from at least 3 live contributors; thin peer medians fail closed for that cycle
- Supported non-USD fiat pegs such as BRL also consult a fresh direct native-peg CoinGecko quote before mutating live state; a native quote back inside threshold or pointing the other way vetoes the derived USD/FX move for that cycle

Primary-price trust gates:

- `authoritative`: fresh `high` / `single-source` current-sync prices
- `confirm_required`: cached, fallback, low-confidence, or stale primary prices
- `unusable`: invalid/missing/non-finite price

Deviation calculation:

```
bps = Math.round(((price / pegRef) - 1) * 10000)
direction = bps >= 0 ? "above" : "below"
```

### Three State Paths

**Path A -- Deviation >= threshold AND event already open**

- If a fresh direct native-peg quote is back inside threshold: close the live row immediately as recovered
- If a fresh direct native-peg quote still shows a depeg but in a conflicting direction: fail closed and keep the existing row unchanged
- If direction changed and the primary price is authoritative (or a trusted aggregate DEX row is corroborated by at least 2 protocol-level DEX groups in the replacement direction): close the old event and open the replacement immediately
- If direction changed but the primary price is `confirm_required`: retire the stale live row immediately and route the replacement move through `depeg_pending` instead of leaving the wrong direction active
- Same direction: mark as legitimately open (add to `seen` set); update peak only when the primary input is authoritative or a corroborated trusted DEX row corroborates the move
- Same-direction DEX disagreement is now advisory only: detection logs the mismatch but does **not** auto-close the event from that contradiction alone

**Path B -- Deviation >= threshold AND no event open**

- If the peg reference is a thin non-USD fiat peer median without FX fallback: skip live-state mutation for this cycle
- If a supported direct native-peg quote is back inside threshold or shows the opposite side of the peg: suppress the new event for this cycle
- If supply >= $1B: insert into `depeg_pending` for multi-source confirmation (`reason = "large-cap"` unless another reason is more specific)
- If primary trust is `confirm_required`: insert into `depeg_pending` with `reason = "low-confidence"`
- If `abs(bps) >= 5000`: route through the extreme-move lane (`reason = "extreme-move"`). Corroborated trusted DEX depeg agreement may still promote the move immediately for non-large-cap coins
- Otherwise (authoritative primary input, non-large-cap, non-extreme): use corroborated trusted DEX recovery suppression and insert into `depeg_events` immediately

**Path C -- Deviation < threshold AND event open**

- If a supported direct native-peg quote still shows the same-direction depeg: keep the event open and ignore the derived recovery
- Close immediately when the primary price is authoritative, or when a fresh non-cached multi-source primary cluster is already back inside threshold
- If the remaining primary input is ambiguous, close only when a trusted aggregate DEX row also shows recovery, at least 2 protocol-level DEX groups are also back inside threshold, and no qualifying challenger pool still shows the old depeg direction
- Otherwise keep the event open rather than letting cached/low-confidence prices silently resolve it

### Orphan Cleanup

After the main loop, load all open events. Close any that were not in the `seen` set and were not created during the current run. These are true "orphans" -- the coin was removed from tracking or exited the PSI-eligible set. Tracked coins are intentionally kept open through transient missing-price or ambiguous-input cycles and are **not** force-closed just because one run lacked a trusted recovery signal. Orphans are closed with `recovery_price = NULL`.

## Stage 2 -- Confirmation

Processes all rows in `depeg_pending`. Applies to large-cap coins, low-confidence primary-price candidates, and extreme-move candidates.

### Per-Record Processing

Guards (delete pending + skip):

1. Invalid `peg_reference` (<= 0)
2. Open event already exists for this coin (another path created it)

Recovery check: if the current **authoritative** primary price is valid and deviation now < threshold, delete pending (transient noise). Ambiguous primary prices do not clear pending rows on their own.

Age checks:

- If age < 15 minutes: skip (wait for next cycle)
- If age > 45 minutes: delete (expired without confirmation)

### Secondary Source Checks

**Off-chain check:**

- Preferred path for supported fiat pegs such as `BRZ`: use a fresh direct native-peg quote (for example `BRZ/BRL`) and compare that quote directly to the native `1.0` peg
- Default path: fetch CoinGecko `/simple/price` for the coin's `geckoId`
- If the current primary price already comes from CoinGecko (`priceSource.startsWith("coingecko")`), switch the confirmer to DefiLlama `coins.llama.fi/prices/current/coingecko:{geckoId}` instead of querying CoinGecko again
- Calculate deviation against `peg_reference`
- Agrees if deviation >= `secondaryBar` (50% of primary threshold)
- Non-fatal: if fetch fails, the off-chain agreement remains `null`

**CEX ticker check:**

- Fetches Binance spot ticker for the coin's symbol (e.g., `USDTUSDC`) as an additional secondary confirmation source
- Only attempted for coins with known Binance trading pairs
- Agrees if deviation >= `secondaryBar`
- Non-fatal: if the Binance fetch fails, the CEX agreement remains `null`

**DEX check:**

- Read from `dex_prices` table (same data as Stage 1)
- Must be within 35-minute freshness window and have aggregate source TVL >= $1M
- Agrees if deviation >= `secondaryBar`

**Pool challenger check:**

- Loads qualifying individual DEX pool challengers from the published challenger snapshot tables via `loadDexPoolChallengers(...)`
- Uses the same freshness / minimum-TVL guardrail family as the depeg helper layer
- Agrees if **any** qualifying pool diverges by at least `secondaryBar`
- Non-fatal: missing challenger tables or incomplete published snapshots fall back through the helper's legacy path and still yield `null`/`false` safely

### Decision Matrix

| Off-chain agrees | CEX agrees | DEX agrees | Pool agrees | Action |
|------------------|-----------|-----------|-------------|--------|
| true | any | any | any | PROMOTE to `depeg_events` |
| any | true | any | any | PROMOTE to `depeg_events` |
| any | any | true | any | PROMOTE to `depeg_events` |
| any | any | any | true | PROMOTE to `depeg_events` |
| false | any | false | any | REJECT (off-chain and aggregate DEX both disagree) |
| false | any | null | false/null | REJECT (off-chain disagrees and no aggregate DEX confirmation exists) |
| null | null | false | false/null | Keep pending (retry next cycle) |
| null | null | null | null | Keep pending (retry next cycle) |

Promotion inserts into `depeg_events` with `started_at` = original `first_seen_at`, peak = worst of current vs `first_seen`, then deletes from `depeg_pending`.

## Historical Backfill Validation

Historical backfills in `worker/src/api/backfill-depegs.ts` do **not** reuse the exact same guard as live DEX or fallback enrichment, but they now consult the same authoritative-price provider registry as live sync before falling back to CoinGecko/DefiLlama history.

`POST /api/backfill-depegs?dry-run=true` also accepts `startDay` / `endDay` for bounded replay audits. The handler applies a small context pad around that UTC window and compares only the overlapping stored `source='backfill'` rows, which makes long BRZ history audits feasible without waiting for a full-history HTTP request.

When a coin has an authoritative historical provider (for example, protocol redemption quotes replayed at historical blocks), backfill uses that provider first. If the provider cannot return enough historical coverage, the handler preserves existing `source='backfill'` rows instead of rebuilding from a weaker market-data source.

Instead, `extractDepegEvents()` now validates each price point in `historical_backfill` mode against the **direct peg reference for that timestamp**:

- USD and other fixed pegs can preserve catastrophic downside moves when the historical peg reference itself is valid
- low-nominal FX pegs such as JPY are judged against the actual historical FX reference, not a generic live-only fallback
- commodity tokens use `commodityOunces` when converting the historical gold/silver peg reference into per-token units

This keeps confirmed historical crashes visible without weakening the stricter live-source filters used to protect sync and DEX ingestion.

## Event Lifecycle

```
Price crosses threshold
        |
        +-- Supply < $1B, authoritative primary, non-extreme move
        |         |
        |         +-- Trusted DEX fresh and below threshold --> Suppress (skip)
        |         |
        |         +-- Otherwise --> INSERT depeg_events (source='live')
        |
        +-- Supply >= $1B, low-confidence primary, or extreme move --> INSERT depeg_pending
                                                     |
                                          (next cycle, 15+ min later)
                                                     |
                          any secondary agrees? (off-chain, CEX, aggregate DEX, or pool challenger)
                                                     |
                                      yes ---------- + ---------- no
                                                     |             |
                                              PROMOTE to      authoritative recovery,
                                              depeg_events    expiry, or decisive disagreement
                                                               -> delete pending

Special case:
  - Extreme move + trusted DEX in the same direction can promote immediately without waiting for the pending retry

While event is open:
  - Peak deviation updated if worse price seen
  - Direction change with authoritative or DEX-confirmed input: close old, open new
  - Direction change with `confirm_required` input: close old, insert replacement pending candidate
  - Trusted DEX disagreement on the same side is logged, but does not by itself close the event
  - Price recovers below threshold: close with recovery_price

Orphan cleanup:
  - Open event not processed in current run: close with recovery_price=NULL
```

## Types

### DepegRow to DepegEvent

`rowToDepegEvent()` converts D1 snake_case rows to frontend camelCase. It validates:

- `direction` must be `"above"` or `"below"` (defaults to `"below"`)
- `source` must be `"live"` or `"backfill"` (defaults to `"live"`)

Frontend type (`shared/types/index.ts`):

```typescript
interface DepegEvent {
  id: number
  stablecoinId: string
  symbol: string
  pegType: string
  direction: "above" | "below"
  peakDeviationBps: number
  startedAt: number
  endedAt: number | null
  startPrice: number
  peakPrice: number | null
  recoveryPrice: number | null
  pegReference: number
  source: "live" | "backfill"
}
```

## API

### GET /api/depeg-events

Query params:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `stablecoin` | string | -- | Filter by `stablecoin_id` |
| `active` | string | -- | If `"true"`, only events where `ended_at IS NULL` |
| `limit` | number | 100 | Max results (clamped 1--1000) |
| `offset` | number | 0 | Pagination offset |

Response:

```json
{
  "events": [{ "...DepegEvent fields..." }],
  "total": 42,
  "methodology": { "version": "...", "versionLabel": "...", "currentVersion": "...", "currentVersionLabel": "...", "changelogPath": "/methodology/depeg-changelog/", "asOf": 1740000000 }
}
```

Cache: realtime profile (`s-maxage=60`, `max-age=10`). Freshness headers use the latest successful `sync-stablecoins` timestamp, falling back to the latest event `startedAt` when cron history is unavailable; TTL remains 900s.

## Frontend

### Hook: useDepegEvents (`use-depeg-events.ts`)

- Fetches `/api/depeg-events` with optional `?stablecoin=` filter
- TanStack Query: `staleTime` = 15 min, `refetchInterval` = 30 min
- Companion hook `useInfiniteDepegEvents({ stablecoinId?, autoLoadAll? })` pages through `/api/depeg-events?limit=100&offset=...`
- `/depeg` uses the unfiltered infinite hook for the global recent-events feed
- Stablecoin detail pages use the filtered infinite hook with `autoLoadAll` so the hero can read the full recorded-event `total` while the history table hydrates every page in the background

### Component: DepegFeed (`depeg-feed.tsx`)

- Responsive recent-events feed with progressive history pagination
- Sorted by `startedAt` DESC
- Shows: logo, symbol, peak deviation (red >= 500bps, amber < 500bps), direction badge, LIVE pulsing indicator if ongoing, date, duration
- Click navigates to `/stablecoin/{id}`

### Depeg dashboard stat context

`DepegTrackerStats` (`src/components/depeg-tracker-stats.tsx`) now uses the shared contextual methodology pattern on key cards (`Active Depegs`, `Coins at Peg`, `Median Deviation`, `Worst Current`) so users can read the live-event semantics in place instead of jumping straight to the long-form methodology.

### Component: DepegHistory (`depeg-history.tsx`)

- Stablecoin-detail depeg history table backed by the filtered infinite hook
- Hero peg-score card now shows the full recorded-event count from `/api/depeg-events.total`; when that differs from the peg-score window count, the UI explicitly labels the 4-year score-window subset
- Background-hydrates the full per-coin history, then paginates the rendered table client-side at 25 rows per page
- Summary metrics: recorded event count, worst deviation, current streak (days at peg or "Depegged now")
- Table columns: Date, Direction (badge), Peak Deviation (signed, colored), Duration (or "Ongoing"), Start Price, Peak Price, Recovery Price
- Uses `computePegStability()` once the full per-coin history has loaded

## Peg Stability Metrics (`peg-stability.ts`)

| Metric | Description |
|--------|-------------|
| `pegPct` | Percentage of tracked history at peg (merges overlapping intervals) |
| `trackingSpan` | Human-readable span ("3y 8mo", "45d") |
| `limited` | `true` if < 7 days history |
| `currentStreakDays` | Days since last event ended |
| `depeggedNow` | Boolean (any ongoing event?) |

## Peg Score (`peg-score.ts`)

Used in report cards. Formula:

```
pegPct = (1 - totalDepegSec / spanSec) * 100
severityScore = 100 - sum of per-event penalties
  per-event penalty = max(durationPenalty, magnitudeFloor)
    durationPenalty = (peakBps/100) * (durationDays/30) * recencyWeight
    magnitudeFloor  = (peakBps/2000) * recencyWeight
spreadPenalty = min(15, (stddev of peaks / 1000) * 15)
activeDepegPenalty = if ongoing: min(50, max(5, |peakBps| / 50))

pegScore = max(0, min(100, round(0.5*pegPct + 0.5*severityScore - activeDepegPenalty - spreadPenalty)))
```

**Tracking window**: `coinTrackingStart()` uses the coin's earliest supply_history snapshot
(queried via `getFirstSeenDates()`) so young coins aren't diluted across a phantom 4-year window.
Falls back to earliest depeg event, then to the 4-year lookback cap.

**Magnitude floor**: Every depeg event carries a minimum severity penalty proportional
to its peak deviation, regardless of how brief. This prevents hundreds of short
high-magnitude depegs from being scored as nearly free.

**Active depeg penalty**: Floor of 5, scales at `|peakBps| / 50`, capped at 50.
A 500 bps ongoing depeg costs 10 points; 2500+ bps hits the cap.

Returns `null` if < 7 days tracking. Scores based on 7–30 days are flagged as "Early score" in the UI.

## Edge Cases & Guardrails

| Scenario | Handling |
|----------|----------|
| Duplicate events | Unique index (`stablecoin_id`, `started_at`, `source`) + merge at run start |
| NAV tokens | Skipped (expected to appreciate, depeg detection N/A) |
| Supply < $1M | Skipped for live event recording (prevents micro-cap noise); detail UI may still show current price deviation with an explicit coverage-limited note |
| Missing/invalid prices | Multiple null/NaN/<= 0 checks |
| Peg reference validation | Must be finite and > 0 |
| DEX freshness | Prices > 35 min old ignored |
| Orphaned events | Closed with `recovery_price = NULL` when coin drops off tracking |
| Non-USD threshold | 150bps accounts for FX noise and thin liquidity |

## File Index

| File | Role |
|------|------|
| `worker/src/cron/detect-depegs.ts` | Stage 1: detection, peak tracking, DEX cross-validation, orphan cleanup |
| `worker/src/cron/confirm-pending-depegs.ts` | Stage 2: multi-source confirmation for large coins |
| `worker/src/cron/sync-stablecoins.ts` | Parent cron that calls both stages after price enrichment |
| `worker/src/lib/depeg-helpers.ts` | `DepegRow` type, `rowToDepegEvent()`, `loadDexPriceRows()`, `buildInsertDepegEventStmt()` |
| `worker/src/api/depeg-events.ts` | `GET /api/depeg-events` handler |
| `worker/migrations/0000_baseline.sql` | Baseline `depeg_events` / `depeg_pending` schema, including the historical dedupe and non-USD cleanup changes |
| `shared/types/index.ts` | `DepegEvent` frontend type |
| `shared/lib/peg-score.ts` | Peg score computation for report cards |
| `src/lib/peg-stability.ts` | Peg stability metrics (`pegPct`, streak, tracking span) |
| `src/hooks/use-depeg-events.ts` | TanStack Query hook |
| `src/components/depeg-feed.tsx` | Recent events grid (homepage) |
| `src/components/depeg-history.tsx` | Event history table (detail page) |
