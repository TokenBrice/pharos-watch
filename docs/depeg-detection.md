# Depeg Detection Pipeline

Two-stage depeg detection pipeline for stablecoins. Stage 1 (detection) runs every 15 minutes as part of the `sync-stablecoins` cron. Stage 2 (confirmation) runs immediately after, promoting or rejecting candidates that require multi-source agreement: large-cap coins, low-confidence primary-price inputs, and extreme moves.

## Methodology Versioning

- **Current methodology version:** `v6.096`
- **Runtime/version source:** `shared/lib/depeg-dews-version.ts`
- **Public changelog route:** `/methodology/depeg-changelog/`
- **Structured changelog:** `shared/data/methodology-changelogs/depeg-dews/`

## Downstream: Depeg Duration Resolver

Confirmed `depeg_events` are the trigger for the Depeg Duration Resolver (DDR), which resolves them into canonical incidents and, under DDRv3, freezes one public prediction or no-call when an active incident reaches forecast readiness (`score >0.75`, strictly) or the first healthy run at/after the 72h backstop. DDR does not run its own detection — it inherits the clean confirmed-event stream described here. If the incident recovers or receives reliable terminal evidence before a healthy DDR lock, DDRR records `resolved_before_prediction` or `terminal_before_prediction` instead of creating a retroactive forecast. See [depeg-resolver.md](./depeg-resolver.md).

## Thresholds & Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `DEPEG_THRESHOLD_BPS` | 100 (1%) | USD peg deviation threshold |
| `DEPEG_THRESHOLD_BPS_NON_USD` | 150 (1.5%) | Non-USD peg threshold (accounts for FX noise + thin liquidity) |
| `DEPEG_CONFIRMATION_SUPPLY_THRESHOLD` | $1,000,000,000 | Coins at or above this require multi-source confirmation |
| `DEPEG_CONFIRMATION_SOFT_SUPPLY_THRESHOLD` | $750,000,000 | Coins at or above this also require confirmation when source depth is below 2 or severity is at least 2x the peg threshold |
| `DEPEG_CONFIRMATION_WEAK_SEVERE_SUPPLY_THRESHOLD` | $500,000,000 | Coins at or above this also require confirmation when both source depth is below 2 and severity is at least 2x the peg threshold |
| `DEPEG_PENDING_MIN_AGE_SEC` | 900 (15 min) | Minimum time before a pending record can be promoted |
| `DEPEG_PENDING_EXPIRY_SEC` | 2700 (45 min) | Base time before a pending record can expire |
| `DEPEG_PENDING_EXTENDED_EXPIRY_SEC` | 8100 (135 min) | Extended limit when primary evidence still points same-direction or confirmation sources are unavailable/circuit-open |
| `DEPEG_PENDING_SEVERE_EXPIRY_SEC` | 10800 (180 min) | Severe/extreme-move limit; expiry records `unconfirmed-severe` |
| `DEPEG_SECONDARY_THRESHOLD_RATIO` | 0.5 | Secondary source agreement bar (50% of primary threshold) |
| `DEPEG_PRIMARY_PRICE_MAX_AGE_SEC` | 1800 (30 min) | Primary prices older than this require confirmation |
| `DEPEG_EXTREME_MOVE_BPS` | 5000 (50%) | Severe move threshold routed through dedicated confirmation lane |
| `DEX_FRESHNESS_SEC` | 2100 (35 min) | DEX prices older than this are ignored |
| `DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD` | 1,000,000 | Minimum aggregate DEX source TVL required before depeg logic trusts a DEX row |
| `DEPEG_DEX_PROTOCOL_CORROBORATION_MIN` | 2 protocol groups | Minimum protocol-level DEX corroborations required before aggregate DEX rows can directly suppress or resolve live depeg state |
| `POOL_CHALLENGE_CONFIRM_MIN` | 2 protocol/source-family groups | Number of independent pool challenger groups that can veto a primary recovery or confirm a pending depeg |
| `POOL_CHALLENGE_HIGH_TVL_USD` | $5,000,000 | Single-pool TVL threshold that can veto a primary recovery or confirm a pending depeg without a second pool group |

`getDepegThresholdBps(pegType)` returns 100 for `peggedUSD`, 150 for all other peg types.

## Database Schema

### depeg_events

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
  source TEXT NOT NULL DEFAULT 'live',  -- "live" | "backfill"
  confirmation_sources TEXT,            -- JSON/provenance for promoted pending rows
  pending_reason TEXT,                  -- reason flags carried from depeg_pending
  close_reason TEXT                     -- why the row closed, NULL for open/legacy rows
);

CREATE INDEX idx_depeg_stablecoin ON depeg_events(stablecoin_id);
CREATE INDEX idx_depeg_started ON depeg_events(started_at DESC);
```

Uniqueness and open-event indexes:

```sql
CREATE UNIQUE INDEX idx_depeg_unique ON depeg_events(stablecoin_id, started_at, source);
CREATE INDEX idx_depeg_open ON depeg_events(stablecoin_id) WHERE ended_at IS NULL;
```

`close_reason` distinguishes real recovery from non-recovery terminal boundaries:

- `recovered-primary`, `recovered-dex`, `recovered-native`
- `coverage-lost-supply`
- `superseded-direction`
- `orphan-tracking-removed`

For live non-USD events opened from a direct native-fiat quote, `peg_reference = 1` and all populated event prices remain in that native quote domain. Later USD-primary or USD-DEX observations may close the row when policy permits, but they leave `recovery_price = NULL` unless a same-domain native recovery quote is available.

### depeg_pending

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
  reason TEXT NOT NULL DEFAULT 'large-cap', -- "large-cap" | "low-confidence" | "extreme-move" or "+"-joined flags
  last_seen_bps INTEGER,
  last_seen_at INTEGER,
  last_price REAL,
  peak_seen_bps INTEGER,
  peak_price REAL,
  updated_at INTEGER
);

CREATE UNIQUE INDEX idx_depeg_pending_coin ON depeg_pending(stablecoin_id);
```

One row per coin maximum. Holds depeg candidates awaiting multi-source confirmation. The CREATE TABLE blocks above show the cumulative shape: the original `depeg_events` / `depeg_pending` schema, the `reason` column (distinguishes large-cap confirmations from ambiguous-price and extreme-move confirmations), and the original uniqueness/open-event indexes were all squashed into `0000_baseline.sql` (migrations 0001–0071, squashed 2026-03-25), so their pre-squash migration files no longer exist. The still-extant follow-on migrations layer on top: migration `0091` adds last-seen and peak-seen tracking columns so pending rows preserve current and worst observed evidence while they await promotion or expiry, migration `0105` adds `confirmation_sources` and `pending_reason` to promoted `depeg_events` rows for ex-post provenance, and migration `0164` adds nullable `close_reason` values for terminal semantics.

### depeg_event_provenance (migration 0127)

Side-table provenance for depeg rows. Legacy `depeg_events` rows remain valid when no provenance row exists. The public API reads through `depeg_events_with_provenance`, which projects a compact `provenance` object without exposing raw diagnostics.

Stored fields include source kind, replay run ID/version, source price providers, quote mode, peg-reference source, supply source, confirmation policy, confirmation point count, market diagnostics, policy adjustments, confidence tier, audit verdict, and created/updated timestamps.

### depeg_backfill_runs (migration 0128)

Backfill replay manifest table. Each mutating replay records stablecoin/window, source type, expected event count, expected fingerprint, removed/added/inserted counts, status (`started`, `complete`, or `incomplete`), timestamps, and any failure message. Chunked insert failures mark the run `incomplete` so operators can repair or re-run instead of assuming the historical slice is complete.

Retention policy: `depeg_backfill_runs` is a backfill audit archive kept forever. Replays are rare, and the run manifest is the durable evidence for repair provenance, expected fingerprints, and incomplete-run follow-up.

### Non-USD threshold cleanup (folded into baseline)

Cleaned up non-USD depeg events with `peak_deviation_bps < 150` when the non-USD threshold was raised from 100 to 150. This was a pre-squash migration now folded into `0000_baseline.sql`.

## Cron Scheduling

Detection runs as part of the `*/15 * * * *` sync cycle. After `syncStablecoins()` enriches prices, it calls:

1. `detectDepegEvents(db, peggedAssets, fxFallbackRates, signal, coingeckoApiKey)` -- detection
2. `confirmPendingDepegs(db, peggedAssets, fxFallbackRates, signal, coingeckoApiKey)` -- confirmation

Both calls are in `worker/src/cron/sync-stablecoins/post-enrichment.ts` (invoked from the parent `sync-stablecoins.ts` orchestrator). Errors from either are captured in the sync metadata as `depegErrors` array but do not fail the parent cron.

The API layer reuses this event dataset through `worker/src/lib/peg-analytics.ts` (`derivePegAnalyticsSnapshot()`), which builds shared `eventsByCoin` and `pegDataById` maps. The snapshot is computed at producer cadence: the quarter-hourly report-card publish pass (`publish-report-card-cache`) is the only writer of the `peg-analytics` D1 cache row built from it. `/api/peg-summary` accepts that row for up to 30 minutes (2x producer cadence) and falls back to direct compute on a miss or stale/invalid row, while `/api/report-cards` consumes the same publish pass through its `report-cards:snapshot` envelope.

## Stage 1 -- Detection

### Initialization

1. Load PSI-eligible stablecoins into `metaById` map
2. Derive peg rates (handles FX lookups once)
3. Load DEX prices from `dex_prices` table (silently skip if table missing)
4. Merge duplicate open events: same-direction duplicates keep the earliest row and absorb only same-direction peaks; if opposite directions are open, the newest direction remains live and older direction rows close with `close_reason = 'superseded-direction'` and `recovery_price = NULL`

`dex_prices` rows are only trusted for depeg logic when they are both fresh (`updated_at < 35 min`) and deep enough (`source_total_tvl >= $1M`). Thin DEX rows remain visible in storage for analytics, but they do not suppress or confirm events.

The stablecoin detail page can still show the live price deviation for a tracked coin below the live depeg-event floor, but that state is explicitly labelled as coverage-limited. Low-cap tracked coins can therefore look off-peg in the detail UI without opening a new `depeg_events` row. If the coin already had an open live row from a period above the floor, the row closes as coverage-lost with `close_reason = 'coverage-lost-supply'` and `recovery_price = NULL` instead of remaining live indefinitely.

### Per-Asset Processing

Validation gates (skip if any fail):

- Must be in `PSI_ELIGIBLE_STABLECOINS`
- Not a NAV token (`meta.flags.navToken`)
- Price valid: non-null, is a number, not NaN, > 0
- Supply >= $1M (via `sumPegBuckets`) for live event recording; if an existing open event later falls below this floor while the coin remains tracked, the live row closes with `close_reason = 'coverage-lost-supply'` and `recovery_price = NULL` because coverage left the live-event universe rather than proving a price recovery
- Peg reference valid: finite and > 0
- Non-USD fiat peg references only mutate live state when they come from cached FX fallback or a median built from at least 3 live contributors; thin peer medians and empty live peer sets fail closed for that cycle
- Supported non-USD fiat pegs with reliable CoinGecko native pairs also consult a fresh direct native-peg quote before mutating live state; a native quote back inside threshold or pointing the other way vetoes the derived USD/FX move for that cycle, while a threshold-crossing native quote can initiate a live event when the primary USD-vs-reference path is still inside threshold

Primary-price trust gates:

- `authoritative`: fresh `high` / `single-source` current-sync prices
- `confirm_required`: cached, fallback, low-confidence, or stale primary prices
- `unusable`: invalid/missing/non-finite price

Before those gates are applied, `priceSource` and `agreeSources` are normalized through the pricing-source registry. Composite labels are expanded into their component source keys, unknown sources do not become pool-challenge eligible by accident, and each known key resolves to its registered `depegSourceFamily`. CoinGecko variants, DefiLlama list/detail/contract variants, and CoinMarketCap-style list aggregators are therefore not counted as independent hard corroboration just because their labels differ; promoted DEX protocol lanes and hard market/oracle/protocol sources keep provider- or protocol-specific families.

Deviation calculation:

```
bps = Math.round(((price / pegRef) - 1) * 10000)
direction = bps >= 0 ? "above" : "below"
```

### Three State Paths

**Path A -- Deviation >= threshold AND event already open**

- If a fresh direct native-peg quote is back inside threshold: close the live row immediately with `close_reason = 'recovered-native'`, but leave `recovery_price = NULL` because the stored USD price still contradicts the native close
- If a fresh direct native-peg quote still shows a depeg but in a conflicting direction: fail closed and keep the existing row unchanged
- If direction changed and the primary price is authoritative (or a trusted aggregate DEX row is corroborated by at least 2 protocol-level DEX groups in the replacement direction): close the old event and open the replacement immediately
- If direction changed but the primary price is `confirm_required`: keep the existing (old-direction) live row open (add to `seen`) and log a warning; the flip is only acted on once an authoritative primary reading or corroborated same-direction DEX support confirms it
- Same direction: mark as legitimately open (add to `seen` set); update peak only when the primary input is authoritative or a corroborated trusted DEX row corroborates the move
- For a live event opened in the native quote domain (`peg_reference = 1` on a non-USD peg), update the peak only from a same-direction native quote; never write the USD primary price into that row
- Same-direction DEX disagreement is now advisory only: detection logs the mismatch but does **not** auto-close the event from that contradiction alone

**Path B -- Deviation >= threshold AND no event open**

- If the peg reference is a thin non-USD fiat peer median without FX fallback: skip live-state mutation for this cycle
- If a supported direct native-peg quote is back inside threshold or shows the opposite side of the peg: suppress the new event for this cycle
- If the primary USD-vs-reference deviation is still inside threshold but a fresh supported direct native-peg quote crosses threshold, use that native quote against a `1.0` peg reference to open or queue the new event
- If supply >= $1B: insert into `depeg_pending` for multi-source confirmation (`reason = "large-cap"` unless another reason is more specific). The same large-cap confirmation lane also catches near-large-cap cases: >= $750M when source depth is below 2 or severity is >= 2x the peg threshold, and >= $500M only when both source depth is below 2 and severity is >= 2x threshold.
- If primary trust is `confirm_required`: insert into `depeg_pending` with `reason = "low-confidence"`
- If `abs(bps) >= 5000`: route through the extreme-move lane (`reason = "extreme-move"`). Corroborated trusted DEX depeg agreement, or a fresh primary cluster spanning at least two independent depeg source families, may still promote the move immediately for non-large-cap coins
- Otherwise (authoritative primary input, non-large-cap, non-extreme): use corroborated trusted DEX recovery suppression and insert into `depeg_events` immediately

Whenever a row is written to `depeg_pending`, the worker now upserts directional state instead of treating the table as write-once:

- same direction: preserve `first_seen_*`, refresh `last_seen_*`, and update `peak_seen_*` when the move worsens
- opposite direction: reset the row as a new incident instead of preserving stale first-seen direction metadata

**Path C -- Deviation < threshold AND event open**

- If a supported direct native-peg quote still shows the same-direction depeg: keep the event open and ignore the derived recovery
- If a fresh trusted aggregate DEX row still crosses the depeg threshold in the existing event direction, with at least 2 protocol-level DEX groups corroborating that direction: keep the event open and ignore the primary recovery print
- If qualifying individual pool challengers still cross the threshold in the existing event direction — either one pool with at least $5M TVL or at least 2 independent protocol/source-family groups — keep the event open and ignore the primary recovery print
- Close immediately when the primary price is authoritative, or when a fresh non-cached multi-source primary cluster is already back inside threshold
- When the existing row was opened from a native-fiat quote, prefer the recovered native quote and persist it with `close_reason = 'recovered-native'`; if only a qualifying USD primary or DEX recovery exists, close with `recovery_price = NULL` to preserve the row's quote-domain invariant
- If the remaining primary input is ambiguous, close only when a trusted aggregate DEX row also shows recovery, at least 2 protocol-level DEX groups are also back inside threshold, and no qualifying challenger pool still shows the old depeg direction
- Otherwise keep the event open rather than letting cached/low-confidence prices silently resolve it

### Orphan Cleanup

After the main loop, load all open events. Close any that were not in the `seen` set and were not created during the current run. These are true "orphans" -- the coin was removed from tracking or exited the PSI-eligible set. Tracked coins are intentionally kept open through transient missing-price or ambiguous-input cycles and are **not** force-closed just because one run lacked a trusted recovery signal. Orphans are closed with `close_reason = 'orphan-tracking-removed'` and `recovery_price = NULL`.

## Stage 2 -- Confirmation

Processes all rows in `depeg_pending`. Applies to large-cap coins, low-confidence primary-price candidates, and extreme-move candidates.

### Per-Record Processing

Guards (delete pending + skip):

1. Invalid `peg_reference` (<= 0)
2. Open event already exists for this coin (another path created it)

Recovery check: if the current **authoritative** primary price is valid and deviation now < threshold, delete pending (transient noise). Ambiguous primary prices do not clear pending rows on their own.

Age checks:

- If age < 15 minutes: skip (wait for next cycle)
- If age is past the 45-minute base expiry, delete only when the dynamic final limit is also exceeded. The limit extends to 135 minutes when the current authoritative primary still points in the pending direction or confirmation sources are unavailable/circuit-open, and to 180 minutes for extreme-move pending rows.

### Secondary Source Checks

**Off-chain check:**

- Preferred path for supported non-USD fiat pegs: use a fresh direct native-peg quote (for example `BRZ/BRL` or `EURC/EUR`) and compare that quote directly to the native `1.0` peg
- Default path: choose an independent off-chain family from the current primary `agreeSources` (falling back to `priceSource`). CoinGecko-family primaries use DefiLlama confirmation, DefiLlama-family primaries use CoinGecko confirmation, and primary clusters that already include both families do not get an off-chain confirmation vote.
- CoinGecko confirmation uses `/simple/price` with `include_last_updated_at=true`; DefiLlama confirmation uses `coins.llama.fi/prices/current/coingecko:{geckoId}`. When those timestamps are present, stale or future-dated observations are ignored, and non-OK response bodies are canceled before later confirmation fetches.
- Calculate deviation against the current peg reference recomputed during confirmation only when that reference passes the same authority gate as Stage 1; thin non-USD fiat references without FX fallback fall back to the stored pending-row `peg_reference` when valid, or wait without mutating when no safe reference is available
- Counts as confirmation only when deviation >= `secondaryBar` (50% of primary threshold) **and** it points in the same direction as the pending incident
- Non-fatal: if fetch fails, the off-chain agreement remains `null`
- Canonical persisted keys are `coingecko-confirm`, `defillama-confirm`, or `native:<peg>`.

**CEX ticker check:**

- Fetches the active configured Binance market batch (currently `USDTUSD` and `USDCUSD`) as an additional secondary confirmation source, then looks up the pending coin by symbol
- Only attempted for symbols present in the configured Binance market set
- Counts as confirmation only when deviation >= `secondaryBar` and points in the same direction as the pending incident
- Non-fatal: if the Binance fetch fails, the CEX agreement remains `null`

**DEX check:**

- Read from `dex_prices` table (same data as Stage 1)
- Must be within 35-minute freshness window and have aggregate source TVL >= $1M
- Aggregate DEX confirmation now also requires at least `DEPEG_DEX_PROTOCOL_CORROBORATION_MIN` independent protocol groups from fresh per-source `price_sources_json`; one protocol cannot promote, recover, or decisively contradict a pending row by itself
- Counts as confirmation only when deviation >= `secondaryBar` and points in the same direction as the pending incident
- Persisted confirmation keys use `dex:<protocol>`.

**Pool challenger check:**

- Loads qualifying individual DEX pool challengers from the published challenger snapshot tables via `loadDexPoolChallengers(...)`
- Uses the same freshness / minimum-TVL guardrail family as the depeg helper layer
- Counts as confirmation only when **at least two distinct protocol/source-family groups** diverge by `secondaryBar` in the same direction, **or** a single qualifying pool with `>= $5M` TVL does so. Multiple same-protocol pools from the same source family count as one group.
- Non-fatal: missing challenger tables or incomplete published snapshots fall back through the helper's legacy path and still yield `null`/`false` safely
- Persisted confirmation keys use `pool:<protocol>:<sourceFamily>`.

### Decision Matrix

| Same-direction off-chain | Same-direction CEX | Same-direction DEX | Same-direction pool | Contradiction seen | Action |
|--------------------------|-------------------|--------------------|---------------------|--------------------|--------|
| true | any | any | any | any | PROMOTE to `depeg_events`, except low-confidence rows still need CEX, aggregate DEX, or pool confirmation |
| any | true | any | any | any | PROMOTE to `depeg_events` |
| any | any | true | any | any | PROMOTE to `depeg_events` |
| any | any | any | true | any | PROMOTE to `depeg_events` (pool-only path requires 2 distinct protocol/source-family groups or one pool with `>= $5M` TVL) |
| true | false/null | false/null | false/null | any | Keep pending when reason includes `low-confidence`; low-confidence rows need a hard secondary source (CEX, aggregate DEX, or pool challenger) |
| false | any | false | any | true | REJECT (off-chain and aggregate DEX both oppose the pending direction) |
| false | any | null | false/null | true | REJECT (directional contradiction with no same-direction rescue signal) |
| null | null | false | false/null | true | REJECT (available secondary evidence points the other way) |
| null | null | false/null | false/null | true | REJECT when DEX or pool contradiction is decisive and no same-direction source rescues the candidate |
| null | null | null | null | false | Keep pending until the dynamic expiry limit; then expire (or record `unconfirmed-severe` for extreme moves) |

**Primary-still-depegged safeguard:** the REJECT rows above assume the refreshed authoritative primary price no longer shows the pending direction. When it still does (`primarySameDirectionDepegged`), a single opposing secondary source cannot reject the row -- rejection then requires at least two independent hard-opposing sources (reason `two-hard-opposing-sources:...`); otherwise one opposing source suffices (reason `secondary-evidence-opposes`).

Promotion inserts into `depeg_events` with `started_at` = original `first_seen_at`, direction = the active pending direction, the refreshed authoritative `peg_reference` (or the stored pending reference when the refreshed non-USD fiat reference is not authoritative), canonical `confirmation_sources`, and peak = worst of the stored pending peak, current authoritative primary, and trustworthy same-direction confirmer prices, then deletes from `depeg_pending`.

Pending rows that pass the 45-minute base expiry but still have same-direction primary evidence, unavailable sources, or open confirmation circuits remain pending until their final dynamic limit. Rows that exceed that final limit are deleted with a recorded pending outcome; extreme-move expiries use `unconfirmed-severe` instead of the generic `expired` label.

## Historical Backfill Validation

Historical backfills in `worker/src/api/backfill-depegs.ts` do **not** reuse the exact same guard as live DEX or fallback enrichment, but they now consult the same authoritative-price provider registry as live sync before falling back to market history.

Backfill rewrites delete prior `source='backfill'` rows even when a trusted replay finds zero replacement events. Dry-runs preview that same removal scope through `removedBackfillEventCount`. For non-empty replacements, the delete and first insert chunk share one D1 `batch()` call (up to the D1 100-statement batch limit: delete + 99 inserts). Additional inserts are written in later chunks, so large replacements are bounded and restartable but not a single all-rows transaction.

Mutating backfills now persist replay-run status and event provenance. Backfilled rows receive replay version, provider roster, quote mode, peg-reference source, supply source, confirmation policy, confidence tier, and compact public provenance. Existing rows without provenance are still accepted by API mappers and PegScore.

When DefiLlama historical supply is absent, replay applies the live `$1M` event floor using the current stablecoins-cache supply for that asset. If neither historical nor current supply is available, the backfill preserves existing rows instead of silently replaying market prices without a supply floor. The same fallback supply also controls large-cap confirmation behavior for absent-history assets.

Supported non-USD fiat backfills now prefer direct CoinGecko native-fiat history first and compare that series against the native `1.0` peg. In that native-fiat mode, replay uses daily points plus a two-point confirmation window across 36 hours before opening a normal event, while still preserving extreme single-point crashes of `>= 5000 bps`. Only when that native history is unavailable does the replay fall back to USD-denominated CoinGecko/DefiLlama history plus the historical FX reference.

`POST /api/backfill-depegs?dry-run=true` also accepts `startDay` / `endDay` for bounded replay audits, plus optional `contextDays` to widen the replay pad around that UTC window. The handler compares only the overlapping stored `source='backfill'` rows, which makes long-history repairs practical without waiting for a full-coin HTTP request.
For commodity-pegged assets, the peer-median reference fetch is bounded to the same replay pad and only fetches the needed gold or silver source family instead of rebuilding full hourly history for every tracked commodity token.

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
        +-- Non-large-cap extreme move with fresh independent primary families --> INSERT depeg_events
        |
        +-- Supply >= $1B, low-confidence primary, or uncorroborated extreme move --> INSERT depeg_pending
                                                     |
                                          (next cycle, 15+ min later)
                                                     |
                          any secondary agrees? (off-chain, CEX, aggregate DEX, or pool challenger)
                                                     |
                                      yes ---------- + ---------- no
                                                     |             |
                                              PROMOTE to      authoritative recovery,
                                              depeg_events    expiry/final dynamic expiry,
                                                               or decisive disagreement
                                                               -> delete pending

Low-confidence pending rows are stricter: off-chain agreement alone does not promote them; they need CEX, aggregate DEX, or pool-challenger confirmation.

Special case:
  - Extreme move + trusted DEX in the same direction can promote immediately without waiting for the pending retry

While event is open:
  - Peak deviation updated if worse price seen
  - Direction change with authoritative or DEX-confirmed input: close old, open new
  - Direction change with `confirm_required` input: keep the old-direction row open and log a warning; the flip is only acted on once authoritative or DEX-confirmed input arrives
  - Trusted DEX disagreement on the same side is logged, but does not by itself close the event
  - Price recovers below threshold: close only when the primary recovery is authoritative, or when trusted aggregate DEX recovery has enough protocol corroboration and no challenger veto; otherwise keep the event open

Orphan cleanup:
  - Open event for a coin no longer tracked by Pharos: close with `close_reason='orphan-tracking-removed'` and `recovery_price=NULL`
  - Open event for a tracked coin not observed in the current run: keep open to avoid false recoveries during upstream gaps
```

## Types

### DepegRow to DepegEvent

`rowToDepegEvent()` converts D1 snake_case rows to frontend camelCase. It validates:

- `direction` must be `"above"` or `"below"` (an invalid value throws)
- `source` must be `"live"` or `"backfill"` (an invalid value throws)
- `closeReason` is `null` for open/legacy rows or one of the validated terminal reason strings above

Frontend type (defined in `shared/types/market.ts`, re-exported through `shared/types/index.ts`):

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
  confirmationSources: string | null
  pendingReason: string | null
  provenance?: {
    sourceKind?: string | null
    replayRunId?: string | null
    replayVersion?: string | null
    sourcePriceProviders?: string[] | null
    quoteMode?: string | null
    pegReferenceSource?: string | null
    supplySource?: string | null
    confirmationPolicy?: string | null
    confirmationPointCount?: number | null
    confidenceTier?: string | null
    auditVerdict?: string | null
    pegScoreEligible?: boolean | null
    updatedAt?: number | null
  } | null
}
```

## API

### GET /api/depeg-events

Query params:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `stablecoin` | string | -- | Filter by `stablecoin_id` |
| `active` | string | -- | If `"true"`, only events where `ended_at IS NULL` |
| `limit` | number | 100 | Max results; out-of-range values outside `1..1000` are rejected |
| `offset` | number | 0 | Pagination offset |
| `cursor` | string | -- | Keyset pagination cursor; advance via the response `nextCursor`. Cannot be combined with a non-zero `offset` |
| `includePending` | string | `false` | If `"true"`, add a `pending` array of unconfirmed candidates to the response |
| `includeTotal` | string | `true` | If `"false"`, skip the COUNT query; `total` becomes a lower-bound estimate and `totalExact` is `false` |

Response:

```text
{
  "events": [{ "...DepegEvent fields..." }],
  "total": 42,
  "totalExact": true,
  "nextCursor": "..." | null,
  "pending": [{ "...DepegPendingIncident fields (only when includePending=true)..." }],
  "methodology": { "version": "...", "versionLabel": "...", "currentVersion": "...", "currentVersionLabel": "...", "changelogPath": "/methodology/depeg-changelog/", "asOf": 1740000000, "isCurrent": true }
}
```

When DDR has linked multiple raw rows into one active repaired incident, the endpoint returns the incident's current event row, excludes superseded source rows from the active projection, and projects the public `startedAt`/`startPrice` from the first linked row.

Rows may include a nullable `provenance` object with public replay/audit metadata (`sourceKind`, `replayRunId`, `replayVersion`, `sourcePriceProviders`, `quoteMode`, `pegReferenceSource`, `supplySource`, `confirmationPolicy`, `confirmationPointCount`, `confidenceTier`, `auditVerdict`, `pegScoreEligible`, `updatedAt`). Legacy rows return `provenance: null`.

Cache: producer-backed profile (`s-maxage=300`, `max-age=60`, `stale-while-revalidate=300`). Freshness headers use the latest successful `sync-stablecoins` timestamp, falling back to the latest event `startedAt` when cron history is unavailable; TTL remains 900s.

## Frontend

### Hook: useInfiniteDepegEvents / useActiveDepegEvents (`use-depeg-events.ts`)

- `useInfiniteDepegEvents({ stablecoinId?, activeOnly?, includePending?, autoLoadAll? })` fetches `/api/depeg-events` with optional `?stablecoin=` filter (shared options built by `depegEventsInfiniteQueryOptions(...)`); `useActiveDepegEvents(...)` wraps it with `activeOnly` preset
- TanStack Query: `staleTime` = 15 min, `refetchInterval` = 30 min
- Pages through `/api/depeg-events?limit=100&cursor=...`, advancing via the response `nextCursor`; oversized `limit` values are rejected rather than silently clamped
- `/depeg` uses the unfiltered infinite hook for the global recent-events feed
- `/depeg/<event>/` static pages form a grow-only permanent archive: every confirmed event starting at or after the archive epoch (2026-01-01, `DEPEG_ARCHIVE_EPOCH_SECONDS`) with an absolute peak deviation at or above the 5.0% static-page threshold keeps its page permanently, plus pinned authored incidents such as USDC 2023 from before the epoch. Published event URLs are never deleted (the former 12-newest recency window churned already-ranked pages to 404). The full event table remains available through the API, live tracker, stablecoin detail history, and feeds; sub-threshold feed entries link back to the relevant stablecoin history anchor instead of consuming Cloudflare Pages files.
- Stablecoin detail pages use the filtered infinite hook with `autoLoadAll` so the hero can read the full recorded-event `total` while the history table hydrates every page in the background

### Component: DepegFeed (`depeg-feed.tsx`)

- Responsive recent-events feed with progressive history pagination
- Sorted ongoing-first, then by `startedAt` DESC
- Shows: logo, symbol, peak deviation colored by severity (green <50bps, amber 50-200bps, orange 200-500bps, red >=500bps), direction badge, LIVE pulsing indicator if ongoing, date, duration
- Click navigates to `/stablecoin/{id}`

### Depeg dashboard stat context

`DepegTrackerStats` (`src/components/depeg-tracker-stats.tsx`) now uses the shared contextual methodology pattern on the key cards (`Active Depegs`, `Coins at Peg`) so users can read the live-event semantics in place instead of jumping straight to the long-form methodology.

### Component: DepegHistory (`depeg-history.tsx`)

- Stablecoin-detail depeg history table backed by the filtered infinite hook
- Hero peg-score card now shows the full recorded-event count from the `GET /api/depeg-events` response field `total`; when that differs from the peg-score window count, the UI explicitly labels the 4-year score-window subset
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
    durationPenalty = (peakBps/100) * (durationDays/30) * recencyWeight   (durationDays capped at 90)
    magnitudeFloor  = (peakBps/2000) * recencyWeight
spreadPenalty = min(15, (stddev of peaks / 1000) * 15)
activeDepegPenalty = if ongoing: min(50, max(5, |peakBps| / 50))

pegScore = max(0, min(100, round(0.5*pegPct + 0.5*severityScore - activeDepegPenalty - spreadPenalty)))
```

v6.0 quality gate: events with provenance `auditVerdict` of `false_positive` or `disputed` are excluded from PegScore inputs. Included events with `confidenceTier = "low"` retain time-at-peg impact but receive a 0.5 severity/spread weight. The result includes quality counters so consumers can tell when provenance changed the score inputs.

**Tracking window**: `coinTrackingStart()` prefers a curated launch date when one is available, then falls back to the
coin's earliest `supply_history` snapshot, then to the first durable Pharos valid-price observation persisted through
`getFirstSeenDates()`. This gives priced assets without supply-history coverage a real age anchor instead of leaving
them unrated indefinitely, while still requiring at least 7 days of tracking before PegScore is rated. If none of those
anchors exists, a coin with depeg events falls back to the earliest event; a coin with no anchor and no events returns
`pegScore = null`.

**Magnitude floor**: Every depeg event carries a minimum severity penalty proportional
to its peak deviation, regardless of how brief. This prevents hundreds of short
high-magnitude depegs from being scored as nearly free.

**Active depeg penalty**: Floor of 5, scales at `|peakBps| / 50`, capped at 50.
A 500 bps ongoing depeg costs 10 points; 2500+ bps hits the cap.

Returns `null` if < 7 days tracking. Scores based on 7–30 days are flagged as "Early score" in the UI.

## Edge Cases & Guardrails

| Scenario | Handling |
|----------|----------|
| Duplicate events | Unique index (`stablecoin_id`, `started_at`, `source`) + run-start repair; same-direction rows merge, opposite-direction rows close older directions without absorbing opposite-sign peaks |
| NAV tokens | Skipped (expected to appreciate, depeg detection N/A) |
| Supply < $1M | Skipped for live event recording (prevents micro-cap noise); detail UI may still show current price deviation with an explicit coverage-limited note; existing rows close with `close_reason = 'coverage-lost-supply'` |
| Missing/invalid prices | Multiple null/NaN/<= 0 checks |
| Peg reference validation | Must be finite and > 0 |
| DEX freshness | Prices > 35 min old ignored |
| Orphaned events | Closed with `close_reason = 'orphan-tracking-removed'` and `recovery_price = NULL` when coin drops off tracking |
| Non-USD threshold | 150bps accounts for FX noise and thin liquidity |
