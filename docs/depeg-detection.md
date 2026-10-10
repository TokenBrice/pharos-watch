# Depeg Detection Pipeline

Two-stage depeg detection pipeline for stablecoins. Stage 1 (detection) runs every 15 minutes as part of the `sync-stablecoins` cron and writes every threshold-crossing onset to `depeg_pending`. Stage 2 runs immediately after and promotes only candidates that have remained beyond the full trigger threshold for at least 15 minutes and satisfy the applicable source-trust rule.

> **Agent navigation** — Grep the heading you need: Methodology Versioning · Downstream: Depeg Duration Resolver · Thresholds & Constants · Database Schema · Build-time event archive · Cron Scheduling · Stage 1 -- Detection · Stage 2 -- Confirmation · Historical Backfill Validation · Event Lifecycle · Types · API · Frontend · Peg Stability Metrics (`peg-stability.ts`) · Peg Score (`peg-score.ts`) · Edge Cases & Guardrails.

## Methodology Versioning

- **Current methodology version:** <!-- GENERATED-START: methodology-version-depeg-detection -->`v6.33`<!-- GENERATED-END: methodology-version-depeg-detection -->
- **Runtime/version source:** `shared/lib/methodology-versions/registry.ts`
- **Public changelog route:** `/methodology/depeg-changelog/`
- **Structured changelog:** `shared/data/methodology-changelogs/depeg-dews/`

The shared `v6.33` release of 2026-10-08 changes only DEWS weekly DEX-history admission; depeg onset, confirmation, recovery and PegScore rules are unchanged. Its release remains conditional on owner-approved production-history replay described in [DEWS](./dews.md#methodology-versioning).

## Downstream: Depeg Duration Resolver

Confirmed `depeg_events` are the trigger for the Depeg Duration Resolver (DDR), which resolves them into canonical incidents and, under current DDRv4 (the lock contract was introduced in DDRv3), freezes one public prediction or no-call when an active incident reaches forecast readiness (`score >0.75`, strictly) or the first healthy run at/after the 72h backstop. DDR does not run its own detection — it inherits the clean confirmed-event stream described here. If the incident recovers or receives reliable terminal evidence before a healthy DDR lock, DDRR records `resolved_before_prediction` or `terminal_before_prediction` instead of creating a retroactive forecast. See [depeg-resolver.md](./depeg-resolver.md).

## Thresholds & Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `DEPEG_THRESHOLD_BPS` | <!-- GENERATED-START: depeg-threshold-usd -->100 (1%)<!-- GENERATED-END: depeg-threshold-usd --> | USD peg deviation threshold |
| `DEPEG_THRESHOLD_BPS_NON_USD` | <!-- GENERATED-START: depeg-threshold-non-usd -->150 (1.5%)<!-- GENERATED-END: depeg-threshold-non-usd --> | Non-USD peg threshold (accounts for FX noise + thin liquidity) |
| `DEPEG_CONFIRMATION_SUPPLY_THRESHOLD` | <!-- GENERATED-START: depeg-confirmation-supply -->$1,000,000,000<!-- GENERATED-END: depeg-confirmation-supply --> | Adds the large-cap source-confirmation reason flag |
| `DEPEG_CONFIRMATION_SOFT_SUPPLY_THRESHOLD` | $750,000,000 | Adds the large-cap flag when source depth is below 2 or severity is at least 2x the peg threshold |
| `DEPEG_CONFIRMATION_WEAK_SEVERE_SUPPLY_THRESHOLD` | $500,000,000 | Adds the large-cap flag when both source depth is below 2 and severity is at least 2x the peg threshold |
| `DEPEG_PENDING_MIN_AGE_SEC` | <!-- GENERATED-START: depeg-pending-min-age -->900 (15 min)<!-- GENERATED-END: depeg-pending-min-age --> | Minimum continuous onset or recovery confirmation window |
| `DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC` | 1200 (20 min) | Largest gap between consecutive qualifying onset/recovery observations or trusted off-peg duration endpoints. Wider than ordinary 900-second producer jitter, below two intervals; a missed run starts a new observation interval |
| `DEPEG_PENDING_EXPIRY_SEC` | <!-- GENERATED-START: depeg-pending-expiry -->2700 (45 min)<!-- GENERATED-END: depeg-pending-expiry --> | Base time before a pending record can expire |
| `DEPEG_PENDING_EXTENDED_EXPIRY_SEC` | 8100 (135 min) | Extended limit when primary evidence still points same-direction or confirmation sources are unavailable/circuit-open |
| `DEPEG_PENDING_SEVERE_EXPIRY_SEC` | 10800 (180 min) | Severe/extreme-move limit; expiry records `unconfirmed-severe` |
| `DEPEG_SECONDARY_THRESHOLD_RATIO` | <!-- GENERATED-START: depeg-secondary-threshold-ratio -->1.0<!-- GENERATED-END: depeg-secondary-threshold-ratio --> | Secondary source agreement uses the full trigger threshold |
| `DEPEG_RECOVERY_THRESHOLD_RATIO` | 0.5 | Recovery must reach half the trigger threshold before its confirmation window starts |
| `DEPEG_PRIMARY_PRICE_MAX_AGE_SEC` | <!-- GENERATED-START: depeg-primary-price-max-age -->1800 (30 min)<!-- GENERATED-END: depeg-primary-price-max-age --> | Primary prices older than this are marked `confirm_required` |
| `DEPEG_EXTREME_MOVE_BPS` | <!-- GENERATED-START: depeg-extreme-move -->5000 (50%)<!-- GENERATED-END: depeg-extreme-move --> | Adds the severe/extreme pending reason and extended expiry policy |
| `DEX_FRESHNESS_SEC` | <!-- GENERATED-START: depeg-dex-freshness -->4500 (75 min)<!-- GENERATED-END: depeg-dex-freshness --> | Hourly DEX prices older than this are ignored |
| `DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD` | <!-- GENERATED-START: depeg-dex-min-tvl -->1,000,000<!-- GENERATED-END: depeg-dex-min-tvl --> | Minimum aggregate DEX source TVL required before depeg logic trusts a DEX row |
| `DEPEG_DEX_PROTOCOL_CORROBORATION_MIN` | 2 protocol groups | Minimum protocol-level DEX corroborations required before aggregate DEX rows can directly suppress or resolve live depeg state |
| `POOL_CHALLENGE_CONFIRM_MIN` | 2 protocol/source-family groups | Number of independent pool challenger groups that can veto a primary recovery or confirm a pending depeg. A diverging set must also be at least as numerous as the groups corroborating the recovered/at-peg price (`divergingProtocolGroupsOutvote` / `corroboratingProtocolGroupsOutvote` in `worker/src/lib/constants.ts`, shared with the pricing pool challenge) |
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
  close_reason TEXT,                    -- why the row closed, NULL for open/legacy rows
  recovery_first_seen_at INTEGER,       -- first qualifying recovery observation, NULL outside recovery confirmation
  recovery_last_seen_at INTEGER,        -- most recent consecutive qualifying recovery observation
  price_coverage_json TEXT,             -- recorded trusted off-peg [start,end] intervals; NULL = uninstrumented legacy
  last_trusted_price_at INTEGER,        -- latest trusted off-peg endpoint, never a guessed history boundary
  price_coverage_gap_started_at INTEGER -- first run observing loss of coverage, NULL outside a current gap
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
- `coverage-lost-supply` (only an observed sub-floor supply, including an explicit zero; unavailable supply never closes a row)
- `superseded-direction`
- `orphan-tracking-removed`

For live non-USD events opened from a CoinGecko native-fiat quote, `peg_reference = 1` and all populated event prices remain in that native quote domain. Later USD-primary or USD-DEX observations may close the row when policy permits, but they leave `recovery_price = NULL` unless a same-domain native recovery quote is available.

Pending upserts preserve an onset only when direction, observation continuity, and quote domain agree. Switching between USD-primary and `native-origin` observations resets the candidate's onset time, reference, and price fields, so confirmation cannot combine a native price with a retained USD reference (or vice versa). Other reason-flag changes within one quote domain preserve continuity.

Current deviation and reference are independent of circulating supply: any observed non-NAV price with an authoritative reference can populate `currentDeviationBps` and `pegReference`, including below $1M or when supply is unknown. The supply floor remains an event-creation/coverage gate, not a price-observation gate. Nominal par and unavailable prices remain unobserved; `depegEventCoverageLimited` still warns that no new events are created for a positive sub-floor supply.

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
  reason TEXT NOT NULL DEFAULT 'large-cap', -- includes "confirmation-window" plus optional trust/severity flags
  last_seen_bps INTEGER,
  last_seen_at INTEGER,
  last_price REAL,
  peak_seen_bps INTEGER,
  peak_price REAL,
  updated_at INTEGER
);

CREATE UNIQUE INDEX idx_depeg_pending_coin ON depeg_pending(stablecoin_id);
```

One row per coin maximum. Holds depeg candidates awaiting confirmation. The CREATE TABLE blocks above show the cumulative shape: the original `depeg_events` / `depeg_pending` schema and follow-on changes through migration 0227 were squashed into `0000_baseline.sql` on 2026-07-30, so their individual migration files no longer exist. The active migration tail starts at `0228_depeg_resolver_incident_closed_pre_lock.sql`; `0232_depeg_recovery_continuity.sql` adds the nullable recovery-continuity endpoint and `0233_ddr_lock_opportunity_attempt_key.sql` adds resolver audit idempotency. Use `worker/migrations/MANIFEST.md` for the full sequence and field ownership.

### depeg_pending_outcomes (migration 0126)

```sql
CREATE TABLE IF NOT EXISTS depeg_pending_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pending_id INTEGER,                   -- source depeg_pending.id, already deleted by the time the row lands
  stablecoin_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  peg_type TEXT NOT NULL,
  direction TEXT NOT NULL,
  reason TEXT NOT NULL,                 -- pending-row reason flags carried through
  first_seen_bps INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  first_price REAL NOT NULL,
  last_seen_bps INTEGER,
  last_seen_at INTEGER,
  last_price REAL,
  peak_seen_bps INTEGER,
  peak_price REAL,
  peg_reference REAL NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('promoted', 'rejected', 'expired', 'recovered', 'superseded', 'unconfirmed-severe')),
  outcome_at INTEGER NOT NULL,
  confirming_sources TEXT,              -- `+`-joined canonical confirmation keys, NULL when empty
  opposing_sources TEXT,
  unavailable_sources TEXT,
  circuit_open_sources TEXT,
  final_decision_reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_depeg_pending_outcomes_pending_id ON depeg_pending_outcomes(pending_id);
CREATE INDEX idx_depeg_pending_outcomes_stablecoin_time ON depeg_pending_outcomes(stablecoin_id, outcome_at DESC);
```

Append-only terminal ledger for every candidate that leaves `depeg_pending`. Each row is written in the same batch that deletes the pending row (`buildOutcomeAndDeleteStmts()` in `worker/src/cron/pending-depeg-confirmation.ts`), so the candidate transition and its evidence land together. Because `depeg_pending` holds at most one row per coin and is deleted on every terminal path, this is the only record of candidates that never became events -- rejections, expiries, recoveries, and rows superseded by an already-open event leave no trace in `depeg_events`.

The four source columns record which confirmation families agreed, opposed, were unavailable, or were skipped behind an open circuit at decision time, which is what distinguishes "no evidence was reachable" from "evidence disagreed" when auditing a REJECT or an `unconfirmed-severe` expiry after the fact.

DDR depends on the `outcome = 'promoted'` rows: `loadPendingPromotionConfirmationTimes()` in `worker/src/cron/depeg-resolver/incident-state.ts` matches them to events on `(stablecoin_id, peg_type, direction, first_seen_at = started_at)` and uses the latest `outcome_at` as the incident `confirmedAt`. That timestamp decides `late_confirmation` lock timing, so deleting or rewriting promoted rows changes DDR lock verdicts for historical incidents.

Retention policy: never pruned. `prune-cron-history` does not touch this table, and no other job deletes from it; only growth telemetry reads it (`worker/src/lib/status/d1-usage.ts`). Growth is bounded by candidate volume, not by a cutoff.

### depeg_event_provenance (migration 0127)

Side-table provenance for depeg rows. Legacy `depeg_events` rows remain valid when no provenance row exists. The public API reads through `depeg_events_with_provenance`, which projects a compact `provenance` object without exposing raw diagnostics.

Stored fields include source kind, replay run ID/version, source price providers, quote mode, peg-reference source, supply source, confirmation policy, confirmation point count, market diagnostics, policy adjustments, confidence tier, audit verdict, and created/updated timestamps.

Audit vocabulary is owned by `shared/types/depeg-audit.ts`: `confirmed`, `disputed`, `false_positive`, `no_data`, and `repaired`. Archived event parsing rejects unknown verdicts rather than coercing them to null. Migration `0252_depeg_audit_verdict_vocabulary.sql` rejects unknown insert/update values while preserving stored archives. Null continues to mean legacy unaudited evidence.

### depeg_backfill_runs (migration 0128)

Backfill replay manifest table. Each mutating replay records stablecoin/window, source type, expected event count, expected fingerprint, removed/added/inserted counts, status (`started`, `complete`, or `incomplete`), timestamps, and any failure message. Chunked insert failures mark the run `incomplete` so operators can repair or re-run instead of assuming the historical slice is complete.

Retention policy: `depeg_backfill_runs` is a backfill audit archive kept forever. Replays are rare, and the run manifest is the durable evidence for repair provenance, expected fingerprints, and incomplete-run follow-up.

### Non-USD threshold cleanup (folded into baseline)

Cleaned up non-USD depeg events with `peak_deviation_bps < 150` when the non-USD threshold was raised from 100 to 150. This was a pre-squash migration now folded into `0000_baseline.sql`.

### Build-time event archive

The Pages build snapshot is maintained by `scripts/maintenance/sync-depeg-events.ts` under `data/depeg-events/`. `index.json` is the compact route-bearing projection used to enumerate permanent `/depeg/<event>/` pages and build the command-palette payload. It carries each route's slug, coin identity, direction, start date, and peak severity. The full event ledger is partitioned into UTC-year shards (`YYYY.json`); feeds, public dataset generation, and page hydration read those shards. A refresh therefore changes the index and only the affected year shard instead of rewriting one monolithic archive file.

Synchronization follows the API cursor until exhaustion, not a display-sized page cap. An outstanding cursor at the 1,000-page safety ceiling, an empty continuation page, or a unique-event count that disagrees with the initial API total is a `SnapshotIntegrityError` before any output write. Fetch-failure fallback cannot turn these integrity failures into successful refreshes; the Pages release wrapper retains the committed directory on producer failure. Published static-page preservation checks remain in force.

Every successful sync also writes `data/depeg-events/metadata/capture.json`: the SHA-256 identity of the exact yearly shard bytes, event count, API total when supplied, source URL, methodology label, and observation start/end clocks. Capture metadata lives in a subdirectory so top-level JSON archive enumeration sees only the route index and event shards; synchronization removes the superseded top-level `capture.json`. Keeping metadata within the archive directory also preserves the Pages release wrapper's directory-level copy and replacement; the release archive allowlist admits only this metadata directory and its capture file, not arbitrary metadata contents. Dataset generation validates this identity before using the ledger; legacy shards without a capture must be synchronized first. The ledger is a current capture, not a reconstruction of event peaks or recoveries at an older market snapshot's clock. Dated `depeg-history` exports therefore publish explicitly retrospective windowed history with this capture's provenance (see [Surface Split](./api-reference.md#surface-split)).

## Cron Scheduling

Detection runs as part of the `*/15 * * * *` sync cycle. After `syncStablecoins()` enriches prices, it calls:

1. `detectDepegEvents(db, peggedAssets, fxFallbackRates, signal, coingeckoApiKey, nativePegSession)` -- detection
2. `confirmPendingDepegs(db, peggedAssets, fxFallbackRates, signal, coingeckoApiKey, binanceSession, nativePegSession)` -- confirmation

Both calls are in `worker/src/cron/sync-stablecoins/post-enrichment.ts` (invoked from the parent `sync-stablecoins.ts` orchestrator). Errors from either are captured in the sync metadata as `depegErrors` array but do not fail the parent cron.

The API layer reuses this event dataset through `worker/src/lib/peg-analytics.ts` (`derivePegAnalyticsSnapshot()`), which builds shared `eventsByCoin` and `pegDataById` maps. The half-hourly, DEX-publication-triggered `prepare-safety-score-v9-input` job is the only writer of the producer-published `peg-analytics` D1 cache row and the exact V9 peg-provenance seed. `/api/peg-summary` accepts the analytics row for up to 30 minutes (one producer interval) and falls back to direct compute on a miss or stale/invalid row. `GET /api/report-cards/v9` reads only the separately accepted canonical V9 publication.

## Stage 1 -- Detection

### Initialization

1. Load PSI-eligible stablecoins into `metaById` map
2. Derive peg rates (handles FX lookups once)
3. Load DEX prices from `dex_prices` table (silently skip if table missing)
4. Merge duplicate open events: same-direction duplicates keep the earliest row and absorb only same-direction peaks; if opposite directions are open, the newest direction remains live and older direction rows close with `close_reason = 'superseded-direction'` and `recovery_price = NULL`

Open-event hydration explicitly joins `depeg_event_provenance.quote_mode`. This structured quote domain is authoritative for both live and backfilled rows: `native-peg` events keep native-currency peak and recovery prices with reference 1, while USD-domain rows use USD prices. Only legacy live non-USD events without quote-mode provenance use the reference-1 native heuristic.

`dex_prices` rows are only trusted for depeg logic when they are both fresh (`updated_at < 75 min`, covering the hourly producer plus one bounded delay) and deep enough (`source_total_tvl >= $1M`). Thin DEX rows remain visible in storage for analytics, but they do not suppress or confirm events.

The stablecoin detail page can still show the live price deviation for a tracked coin below the live depeg-event floor, but that state is explicitly labelled as coverage-limited. Low-cap tracked coins can therefore look off-peg in the detail UI without opening a new `depeg_events` row. If the coin already had an open live row from a period above the floor and an observed supply now sits below it, the row closes as coverage-lost with `close_reason = 'coverage-lost-supply'` and `recovery_price = NULL` instead of remaining live indefinitely. Unavailable supply is not an observation below the floor: when the asset's current circulating buckets are absent, empty or wholly invalid, the open row stays open and unchanged (marked seen, a `Kept live event ... current supply is unavailable` warning is logged) and no new row opens for that asset.

### Per-Asset Processing

Validation gates (skip if any fail):

- Must be in `PSI_ELIGIBLE_STABLECOINS`
- Not a NAV token (`meta.flags.navToken`)
- Price valid: non-null, is a number, not NaN, > 0
- Supply >= $1M (via `getCirculatingRawOrNull()`, which sums finite circulating buckets and returns `null` for absent, empty or wholly invalid buckets) for live event recording; if an existing open event later observes supply below this floor (an explicit zero included) while the coin remains tracked, the live row closes with `close_reason = 'coverage-lost-supply'` and `recovery_price = NULL` because coverage left the live-event universe rather than proving a price recovery. `null` supply skips the asset without touching an open event
- Peg reference valid: finite and > 0
- Non-USD fiat peg references use the live FX rate whenever it is available. A peer median is only a fallback when at least 3 live contributors remain; thin peer medians and empty live peer sets fail closed for that cycle
- Supported non-USD fiat pegs with reliable CoinGecko native pairs also consult a fresh native-currency quote before mutating live state; a native quote inside the recovery band or pointing the other way vetoes the derived USD/FX onset for that cycle, while a threshold-crossing native quote can initiate a pending candidate when the primary USD-vs-reference path is still inside threshold

Primary-price trust gates:

- `authoritative`: fresh `high` / `single-source` current-sync prices
- `confirm_required`: cached, fallback, low-confidence, or stale primary prices
- `unusable`: invalid/missing/non-finite price, or a non-observed price (`priceObservedAtMode: "nominal_reference"`, an unsupported mode, or any `protocol-par` source component). Since pricing v6.38 the nominal par routes publish par this way whenever no trusted market quote is admitted, so par can neither open, confirm nor recover an event; an open row stays open (tracked coins are never orphan-closed) until observed price evidence decides it, while a trusted market discount on those assets is evaluated like any other primary price

Before those gates are applied, `priceSource` and `agreeSources` are normalized through the pricing-source registry. Composite labels are expanded into their component source keys, unknown sources do not become pool-challenge eligible by accident, and each known key resolves to its registered `depegSourceFamily`. CoinGecko variants, DefiLlama list/detail/contract variants, and CoinMarketCap-style list aggregators are therefore not counted as independent hard corroboration just because their labels differ; promoted DEX protocol lanes and hard market/oracle/protocol sources keep provider- or protocol-specific families.

Deviation calculation:

```
rawBps = ((price / pegRef) - 1) * 10000
bps = Math.round(rawBps) // persisted and displayed value
direction = rawBps >= 0 ? "above" : "below"
```

Threshold decisions use `abs(rawBps)` so a value that merely rounds to the boundary cannot open or confirm an event.

### Three State Paths

**Path A -- Deviation beyond the trigger threshold AND event already open**

- If a fresh native-currency quote is inside the recovery band, route the row through the recovery confirmation path rather than closing immediately
- If a fresh native-currency quote still shows a depeg but in a conflicting direction: fail closed and keep the existing row unchanged
- If direction changed and the primary price is authoritative (or a trusted aggregate DEX row is corroborated by at least 2 protocol-level DEX groups in the replacement direction): close the old event and queue the replacement in `depeg_pending`
- If direction changed but the primary price is `confirm_required`: keep the existing (old-direction) live row open (add to `seen`) and log a warning; the flip is only acted on once an authoritative primary reading or corroborated same-direction DEX support confirms it
- Same direction: mark as legitimately open (add to `seen` set); update peak only when the primary input is authoritative or a corroborated trusted DEX row corroborates the move
- For a live event opened in the native quote domain (`peg_reference = 1` on a non-USD peg), update the peak only from a same-direction native quote; never write the USD primary price into that row
- Same-direction DEX disagreement is now advisory only: detection logs the mismatch but does **not** auto-close the event from that contradiction alone

**Path B -- Deviation beyond the trigger threshold AND no event open**

- If the peg reference is a thin non-USD fiat peer median without live FX: skip live-state mutation for this cycle
- If a supported native-currency quote is inside the recovery band or shows the opposite side of the peg: suppress the new event for this cycle
- If the primary USD-vs-reference deviation is inside threshold but a fresh supported native-currency quote crosses threshold, store that quote against a `1.0` peg reference in `depeg_pending`
- Every remaining onset is inserted or refreshed in `depeg_pending` with `reason = "confirmation-window"`. Large-cap, low-confidence, extreme-move, and native-origin flags are appended when applicable; none bypass the 15-minute window.
- Corroborated trusted DEX recovery can still suppress a new candidate before the pending write.

Whenever a row is written to `depeg_pending`, the worker now upserts directional state instead of treating the table as write-once:

- same direction with no more than 1200 seconds since the prior qualifying observation: preserve `first_seen_*`, refresh `last_seen_*`, and update `peak_seen_*` when the move worsens
- same direction after a gap greater than 1200 seconds: reset first/last/peak fields to the new observation; the blind interval cannot count toward confirmation
- opposite direction: reset the row as a new incident instead of preserving stale first-seen direction metadata

The 1200-second continuity tolerance is bounded from both sides. A production sample of five consecutive `sync-stablecoins` invocations captured on 2026-08-07 measured start-to-start gaps of 932, 932, 868, and 907 seconds (range 868-932, or -32/+32 seconds around the declared 900-second schedule). The tolerance therefore **cannot** equal one producer interval: three of those four ordinary gaps exceed 900 seconds, so a 900-second tolerance would reset `first_seen_at` on almost every observation, leave `last_seen_at - first_seen_at` permanently at zero, and prevent the 15-minute confirmation window from ever completing — silently disabling depeg confirmation rather than tightening it. The tolerance also stays below two producer intervals so that a genuinely missed run (~1800 seconds) still resets the episode, which is the property this rule exists to enforce: a blind interval must never prove persistence.

Detection persistence commits all mutations for one stablecoin as one ordered atomic transition, then proceeds to the next asset.

**Path C -- Deviation inside the trigger threshold AND event open**

- If a supported CoinGecko native-currency quote still shows the same-direction depeg: keep the event open and ignore the derived recovery
- If a fresh trusted aggregate DEX row still crosses the depeg threshold in the existing event direction, with at least 2 protocol-level DEX groups corroborating that direction: keep the event open and ignore the primary recovery print
- If qualifying individual pool challengers still cross the threshold in the existing event direction — either one pool with at least $5M TVL or at least 2 independent protocol/source-family groups that are also at least as numerous as the challenger groups corroborating the recovered (inside-threshold) price — keep the event open and ignore the primary recovery print. A minority of diverging groups no longer vetoes a corroborated recovery: the 2026-09-24 `vchf-vnx` event 90792 was vetoed by two dormant diverging venues (a months-silent Celo Uniswap v3 pool with 24h volume 0 and a provider-reported $4.7M reserve, plus a zero-volume ICP kongswap pool) against four live protocols sitting at the ECB CHF rate
- Challenger snapshots currently retain publication timestamps rather than each pool price's original observation timestamp. They therefore provide conservative recovery vetoes only; an in-band challenger majority cannot advance or complete positive recovery. Ambiguous primary recovery requires the fresh trusted aggregate DEX lane until original pool-price time provenance is retained end to end.
- A qualifying recovery must be at or inside 50% of the trigger threshold: 50 bps for USD pegs and 75 bps for non-USD pegs. The first qualifying observation sets both recovery timestamps; each consecutive qualifying observation refreshes `recovery_last_seen_at`. The row closes only after total recovery age reaches 15 minutes and the gap from the prior qualified observation is no more than 1200 seconds.
- A later qualifying recovery after a gap greater than 1200 seconds resets both recovery timestamps to the new observation. Missing data leaves the event open, but the missing interval never proves recovery.
- A reading between the recovery and trigger thresholds is a deadband: keep the event open and clear any partial recovery timer.
- When the existing row was opened from a native-fiat quote, prefer the recovered native quote and persist it with `close_reason = 'recovered-native'`; if only a qualifying USD primary or DEX recovery exists, close with `recovery_price = NULL` to preserve the row's quote-domain invariant.
- Authoritative or fresh multi-source primary recovery can advance the timer. Ambiguous primary recovery requires a trusted aggregate DEX row, at least 2 corroborating DEX protocol groups, and no qualifying challenger majority showing the old direction.
- Any renewed same-direction depeg or contradictory trusted evidence clears the partial recovery timer.

### Orphan Cleanup

After the main loop, load open events with the `MAX_OPEN_DEPEG_EVENTS = 200` bound. If the read reaches that bound, skip orphan cleanup and emit a structured degraded warning rather than operating on a truncated set. Otherwise, close any rows that were not in the `seen` set and were not created during the current run. Rows for frozen coins are also exempt and are never force-closed -- preserved historical data must not be falsified by a lifecycle change (`shouldCloseOrphanedDepeg` in `worker/src/cron/depeg-detection/repair.ts`). These are true "orphans" -- the coin was removed from tracking or exited the PSI-eligible set. Tracked coins are intentionally kept open through transient missing-price or ambiguous-input cycles and are **not** force-closed just because one run lacked a trusted recovery signal. Orphans are closed with `close_reason = 'orphan-tracking-removed'` and `recovery_price = NULL`.

## Stage 2 -- Confirmation

Processes all rows in `depeg_pending`. Every live onset, including small-cap, multi-source, native-origin, and extreme candidates, enters this stage.

### Per-Record Processing

Guards (delete pending + skip):

1. Invalid `peg_reference` (<= 0)
2. Open event already exists for this coin (another path created it)

Recovery check: if the current **authoritative** primary price is valid and deviation now < threshold, delete pending (transient noise). Ambiguous primary prices do not clear pending rows on their own.

Native-origin candidates keep their native quote as the event-price domain, but that quote cannot confirm itself. At confirmation time, Pharos normalizes the fresh canonical USD price through the authoritative FX reference and admits only source families outside CoinGecko. One such independent canonical family must agree with the native-domain direction and full threshold before promotion; an at-peg or opposite-direction normalized canonical reading rejects the candidate after the temporal window. Missing, stale, fallback, cached, or CoinGecko-only canonical evidence leaves the row pending rather than promoting it.

Age checks:

- If age < 15 minutes: skip (wait for next cycle)
- If age is past the 45-minute base expiry, delete only when the dynamic final limit is also exceeded. The limit extends to 135 minutes when the current authoritative primary still points in the pending direction or confirmation sources are unavailable/circuit-open, and to 180 minutes for extreme-move pending rows.

### Secondary Source Checks

**Off-chain check:**

- Preferred path for supported non-USD fiat pegs: use a fresh CoinGecko native-currency quote (for example `BRZ/BRL` or `EURC/EUR`) and compare that quote to the native `1.0` peg
- A candidate initiated by that native quote additionally requires a fresh canonical USD price from at least one non-CoinGecko source family, normalized through the authoritative FX reference, to cross the full native-domain threshold in the same direction. Repeated CoinGecko native observations provide temporal persistence only, not independent source confirmation.
- Default path: CoinGecko can confirm a primary that does not already contain the CoinGecko source family. A CoinGecko-family primary gets no off-chain confirmer because DefiLlama's `coingecko:{id}` price is a CoinGecko mirror, not an independent observation.
- CoinGecko confirmation uses `/simple/price` with `precision=full` and `include_last_updated_at=true`. Missing, stale, or future-dated observations are ignored, and non-OK response bodies are canceled before later confirmation fetches.
- Calculate deviation against the current peg reference recomputed during confirmation only when that reference passes the same authority gate as Stage 1; thin non-USD fiat references without FX fallback fall back to the stored pending-row `peg_reference` when valid, or wait without mutating when no safe reference is available
- Counts as confirmation only when deviation reaches the full trigger threshold and points in the same direction as the pending incident
- Non-fatal: if fetch fails, the off-chain agreement remains `null`
- Canonical persisted keys are `temporal:15m`, `coingecko-confirm`, or `native:<peg>`.

**CEX ticker check:**

- Fetches the active configured Binance market batch (currently `USDTUSD` and `USDCUSD`) as an additional secondary confirmation source, then looks up the pending coin by symbol
- Only attempted for symbols present in the configured Binance market set
- Counts as confirmation only when deviation reaches the full trigger threshold and points in the same direction as the pending incident
- Non-fatal: if the Binance fetch fails, the CEX agreement remains `null`

**DEX check:**

- Read from `dex_prices` table (same data as Stage 1)
- Must be within the 75-minute hourly-producer freshness window and have aggregate source TVL >= $1M
- Aggregate DEX confirmation now also requires at least `DEPEG_DEX_PROTOCOL_CORROBORATION_MIN` independent protocol groups from fresh per-source `price_sources_json`; one protocol cannot promote, recover, or decisively contradict a pending row by itself
- Counts as confirmation only when deviation reaches the full trigger threshold and points in the same direction as the pending incident
- Persisted confirmation keys use `dex:<protocol>`.

**Pool challenger check:**

- Loads qualifying individual DEX pool challengers from the published challenger snapshot tables via `loadDexPoolChallengers(...)`
- Uses the same freshness / minimum-TVL guardrail family as the depeg helper layer
- Counts as confirmation only when **at least two distinct protocol/source-family groups** reach the full trigger threshold in the same direction, **or** a single qualifying pool with `>= $5M` TVL does so, and the confirming groups are at least as numerous as the groups contradicting the pending direction (opposite-direction or back inside the bar). Multiple same-protocol pools from the same source family count as one group.
- The single-high-TVL exception replaces only the two-group minimum, never the opposing-group vote: one confirming group can be unopposed or tied with one opposing group, but cannot confirm against two opposing groups.
- Non-fatal: missing challenger tables or incomplete published snapshots fall back through the helper's legacy path and still yield `null`/`false` safely
- Persisted confirmation keys use `pool:<protocol>:<sourceFamily>`.

### Decision Matrix

| Temporal persistence | Source confirmation | Contradiction | Action |
|----------------------|---------------------|---------------|--------|
| Less than 15 minutes | any | any | Keep pending |
| Full 15 minutes beyond the trigger threshold | fresh primary cluster spanning at least 2 independent families | none decisive | PROMOTE |
| Full 15 minutes beyond the trigger threshold | independent CoinGecko, CEX, corroborated aggregate DEX, or qualifying pool evidence | none decisive | PROMOTE |
| Full 15 minutes beyond the trigger threshold | native-origin candidate plus a fresh non-CoinGecko canonical USD family normalized through authoritative FX, both beyond threshold in the same direction | none decisive | PROMOTE |
| Full 15 minutes beyond the trigger threshold | native-origin candidate only | normalized independent canonical price is at peg or points in the opposite direction | REJECT |
| Full 15 minutes | only soft off-chain evidence on a `low-confidence` row | none | Keep pending; require CEX, aggregate DEX, or pool confirmation |
| any | any | decisive opposing evidence with no same-direction rescue | REJECT under the safeguards below |
| any | none | none | Keep pending until dynamic expiry, then expire or record `unconfirmed-severe` |

**Primary-still-depegged safeguard:** the REJECT rows above assume the refreshed authoritative primary price no longer shows the pending direction. When it still does (`primarySameDirectionDepegged`), a single opposing secondary source cannot reject the row -- rejection then requires at least two independent hard-opposing sources (reason `two-hard-opposing-sources:...`); otherwise one opposing source suffices (reason `secondary-evidence-opposes`).

Promotion inserts into `depeg_events` with `started_at` = the current continuous episode's `first_seen_at`, direction = the active pending direction, the refreshed authoritative `peg_reference` (or the stored pending reference when the refreshed non-USD fiat reference is not authoritative), canonical `confirmation_sources` beginning with `temporal:15m`, and peak = worst of the stored pending peak, current same-domain authoritative price, and trustworthy same-direction confirmer prices, then atomically inserts the outcome and deletes from `depeg_pending` as one candidate transition.

Native-currency confirmers on USD-origin candidates normalize their price by multiplying the native quote (reference 1) by the candidate's admitted USD peg reference before peak selection; native-origin candidates retain native prices and reference 1. Pool peak candidates are exposed and consumed only when the pool confirmation policy accepts them, so rejected minority pools cannot deepen a primary-led promotion or supply uncredited event peaks.

Pending rows that pass the 45-minute base expiry but still have same-direction primary evidence, unavailable sources, or open confirmation circuits remain pending until their final dynamic limit. Rows that exceed that final limit are deleted with a recorded pending outcome; extreme-move expiries use `unconfirmed-severe` instead of the generic `expired` label.

## Historical Backfill Validation

Historical backfills in `worker/src/api/backfill-depegs.ts` do **not** reuse the exact same guard as live DEX or fallback enrichment, but they now consult the same authoritative-price provider registry as live sync before falling back to market history.

Backfill rewrites delete prior `source='backfill'` rows even when a trusted replay finds zero replacement events. Dry-runs preview that same removal scope through `removedBackfillEventCount`. For non-empty replacements, the delete and first insert chunk share one D1 `batch()` call (up to the D1 100-statement batch limit: delete + 99 inserts). Additional inserts are written in later chunks, so large replacements are bounded and restartable but not a single all-rows transaction.

Replay now drops recomputed episodes that reviewed data or an existing live row already covers, inside `executeBackfillForCoin` (`worker/src/api/backfill-depegs/execution.ts`; overlap predicate `backfillEpisodeCoveredByLiveEvent` in `worker/src/api/backfill-depegs-window.ts`):

- **Reviewed suppression.** An episode whose inclusive `[startedAt, endedAt]` interval overlaps a matching registry entry for the same coin and direction is skipped.
- **Live overlap.** An episode that overlaps an existing `source='live'` row of the same coin and direction (`episodeStart <= liveEnd && liveStart <= episodeEnd`, inclusive; an open row collapses to its start second) is skipped. Live detection polls at minute cadence while replay consumes hourly samples, so same-side overlapping windows are one market episode counted twice; intervals one second apart are disjoint.

Both rules run before the dry-run/apply split, so the preview, `expectedEventCount`/`expectedFingerprint`, and the inserted rows stay mutually consistent. Each skip logs a `backfill-depegs-episode-skipped` event with `skipReason: reviewed-suppression` or `live-overlap`. Neither rule deletes anything by itself: the replayed window's delete still removes stale `source='backfill'` rows, live rows are never removed by replay, and the skip only prevents the twin from being re-inserted. A read-only production dry-run of the live-overlap rule found 85 overlapping live/backfill pairs across 52 distinct backfill rows on 21 coins.

Mutating backfills now persist replay-run status and event provenance. Backfilled rows receive replay version, provider roster, quote mode, peg-reference source, supply source, confirmation policy, confidence tier, and compact public provenance. Existing rows without provenance are still accepted by API mappers and PegScore.

Historical supply admission prefers DefiLlama `totalCirculatingUSD`. Native-only `totalCirculating` / `circulating` snapshots are converted through the timestamp's historical FX or commodity peg reference (including per-token `commodityOunces`) before applying the `$1M` event floor or large-cap confirmation threshold; native units are never compared directly to USD thresholds. Absent, empty, invalid, or unconvertible records do not become zero snapshots; explicit finite zero remains observed zero.

When DefiLlama returns no historical rows, replay applies the live `$1M` event floor using the current stablecoins-cache supply for that asset. If neither historical nor current supply is available, the backfill preserves existing rows instead of silently replaying market prices without a supply floor. A non-empty historical response with no usable supply snapshots is treated as degraded and preserves existing rows even when current supply exists. The same current fallback supply controls large-cap confirmation behavior for genuinely absent-history assets.

Supported non-USD fiat backfills now prefer direct CoinGecko native-fiat history first and compare that series against the native `1.0` peg. In that native-fiat mode, replay uses daily points plus a two-point confirmation window across 36 hours before opening a normal event, while still preserving extreme single-point crashes of `>= 5000 bps`. Only when that native history is unavailable does the replay fall back to USD-denominated CoinGecko/DefiLlama history plus the historical FX reference.

`POST /api/backfill-depegs?dry-run=true` also accepts `startDay` / `endDay` for bounded replay audits, plus optional `contextDays` to widen the replay pad around that UTC window. The handler compares only the overlapping stored `source='backfill'` rows, which makes long-history repairs practical without waiting for a full-coin HTTP request.
For commodity-pegged assets, the peer-median reference fetch is bounded to the same replay pad and only fetches the needed gold or silver source family instead of rebuilding full hourly history for every tracked commodity token.

When a coin has an authoritative historical provider (for example, protocol redemption quotes replayed at historical blocks), backfill uses that provider first. If the provider cannot return enough historical coverage, the handler preserves existing `source='backfill'` rows instead of rebuilding from a weaker market-data source.

Instead, `extractDepegEvents()` now validates each price point in `historical_backfill` mode against the **direct peg reference for that timestamp**:

- USD and other fixed pegs can preserve catastrophic downside moves when the historical peg reference itself is valid
- low-nominal FX pegs such as JPY are judged against the actual historical FX reference, not a generic live-only fallback
- commodity tokens use `commodityOunces` when converting the historical gold/silver peg reference into per-token units

This keeps confirmed historical crashes visible without weakening the stricter live-source filters used to protect sync and DEX ingestion.

### Reviewed replay suppression registry

`shared/data/depegs/backfill-replay-suppressions.ts` records operator verdicts that a recomputed backfill episode is a price-feed artifact rather than a market depeg. It is what keeps a reviewed artifact deletion durable: without it, the next admin replay would delete and recompute the same window and re-persist the artifact.

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `coinId` | `string` | Tracked stablecoin id (validated against `shared/data/stablecoins/canonical-order.json`) |
| `direction` | `"above" \| "below"` | Depeg side the verdict applies to (shared `DepegDirectionSchema` vocabulary) |
| `windowStart` / `windowEnd` | `number` | Inclusive UTC window bounds in Unix seconds; `windowStart < windowEnd` |
| `reason` | `string` | The reviewed verdict, stated as the artifact conclusion |
| `evidenceUrls` | `string[]` | Primary forensics (on-chain transaction links, price-feed pages); `https` only |
| `reviewedAt` | `string` | Review date, `YYYY-MM-DD` |

Matching is inclusive interval overlap between the recomputed episode `[startedAt, endedAt ?? startedAt]` and the entry window, scoped to `(coinId, direction)`.

The module validates the corpus at import time and fails closed. `shared/data/depegs/__tests__/backfill-replay-suppressions.test.ts` additionally guards tracked coin ids, the shared direction vocabulary, ordered integer windows, `https` evidence URLs, `YYYY-MM-DD` review dates, non-overlapping same-coin/same-direction windows, and the behavioral contract of the seeded USN windows.

To add an entry: establish from primary evidence that the stored episode is an artifact (no economic-size on-chain trade, pool mids at peg), set the window to the union of the stored episode and its dust/recovery transactions plus a ±2h margin (hourly CoinGecko samples move episode edges by up to an hour), cite the evidence URLs with the review date, then re-run the integrity suite. Add the entry **before** deleting the matching `source='backfill'` rows, so a later replay cannot re-persist them. The seeded entries are the four `usn-noon` `above` windows for 2025-10-07, 2025-12-27/28, 2026-02-14, and 2026-03-02, where on-chain forensics found no economic-size USN trade above 1.0011 and pool mids stayed near $1.000.

### Operator runbook

Artifact-event removal is an operator procedure with a hard ordering constraint: the registry and the live-overlap skip must be deployed before the delete, and the review previews with `GET /api/audit-depeg-history?dry-run=true` before `POST /api/audit-depeg-history?delete=<ids>` and `npm run sync-depeg-events -- --allow-archive-shrink`. The full sequence, the reviewed Noon USN id set (`49235,49236,49237,24424,83782`), and the registry-entry steps live in [Depeg Artifact-Event Removal](./runbooks/depeg-artifact-removal.md).

## Event Lifecycle

```
Price crosses threshold
        |
        +-- Corroborated trusted DEX recovery --> suppress candidate
        |
        +-- Otherwise --> INSERT/UPDATE depeg_pending
                              |
                   remain beyond full threshold
                      for at least 15 minutes?
                              |
                   yes -------+------- no
                    |                  |
            source rule passes?      keep pending
                    |
             yes ---+--- no
              |          |
       PROMOTE to       keep pending, recover,
       depeg_events     reject, or expire

Low-confidence pending rows are stricter: off-chain agreement alone does not promote them; they need CEX, aggregate DEX, or pool-challenger confirmation.

While event is open:
  - Peak deviation updated if worse price seen
  - Direction change with authoritative or DEX-confirmed input: close old, queue new pending candidate
  - Direction change with `confirm_required` input: keep the old-direction row open and log a warning; the flip is only acted on once authoritative or DEX-confirmed input arrives
  - Trusted DEX disagreement on the same side is logged, but does not by itself close the event
  - Price reaches the 50% recovery band: start or continue a 15-minute recovery timer when the primary recovery is authoritative, when trusted aggregate DEX recovery has enough protocol corroboration and no challenger majority veto
  - Price returns to the deadband or depeg range: clear the recovery timer and keep the event open

Orphan cleanup:
  - If a bounded open-event read reaches `MAX_OPEN_DEPEG_EVENTS = 200`, skip the affected detection, confirmation, or orphan-cleanup pass and emit a structured degraded warning
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
  constituentEventCount?: number
  confirmationSources: string | null
  pendingReason: string | null
  closeReason:
    | "recovered-primary"
    | "recovered-dex"
    | "recovered-native"
    | "coverage-lost-supply"
    | "superseded-direction"
    | "orphan-tracking-removed"
    | null
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
    auditVerdict?: DepegAuditVerdict | null
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
| `includeTotal` | string | `true` | If `"false"`, skip the COUNT query; `total` is an observed lower bound and `totalExact` is `false`. Empty offset pages report `0`, never the requested offset. |

Response:

```text
{
  "events": [{ "...DepegEvent fields..." }],
  "total": 42,
  "totalExact": true,
  "counts": { "incidents": 42, "thresholdCrossings": 57 },
  "nextCursor": "..." | null,
  "pending": [{ "...DepegPendingIncident fields (only when includePending=true)..." }],
  "methodology": { "version": "...", "versionLabel": "...", "currentVersion": "...", "currentVersionLabel": "...", "changelogPath": "/methodology/depeg-changelog/", "asOf": 1740000000, "isCurrent": true }
}
```

`total` counts public incident rows, not necessarily individual threshold crossings. Exact `counts` are included only for a stablecoin-filtered historical request with `includeTotal=true`; `counts.incidents` matches `total`, while `counts.thresholdCrossings` counts the stored detector/replay rows before DDR projection.

Each `pending` row's `expiresAt` is the base expiry, `firstSeenAt + DEPEG_PENDING_EXPIRY_SEC`. The confirmation cron keeps a row pending past it under the extended and severe limits (see the timing table), so `lastSeenAt` may legitimately exceed `expiresAt`; the shared contract requires only `lastSeenAt >= firstSeenAt` and `expiresAt > firstSeenAt`.

When DDR has linked multiple raw rows into one active repaired incident, the endpoint returns the incident's current event row, excludes superseded source rows from the active projection, projects the public `startedAt`/`startPrice` from the first linked row, and reports the number of linked rows in `constituentEventCount`. Unprojected rows use `constituentEventCount = 1`.

Rows may include a nullable `provenance` object with public replay/audit metadata (`sourceKind`, `replayRunId`, `replayVersion`, `sourcePriceProviders`, `quoteMode`, `pegReferenceSource`, `supplySource`, `confirmationPolicy`, `confirmationPointCount`, `confidenceTier`, `auditVerdict`, `pegScoreEligible`, `updatedAt`). Legacy rows return `provenance: null`.

Cache: producer-backed profile (`s-maxage=300`, `max-age=60`, `stale-while-revalidate=300`). Freshness headers use the latest successful `sync-stablecoins` timestamp, falling back to the latest event `startedAt` when cron history is unavailable; TTL remains 900s.

## Frontend

### Hook: useInfiniteDepegEvents / useActiveDepegEvents (`use-depeg-events.ts`)

- `useInfiniteDepegEvents({ stablecoinId?, activeOnly?, includePending?, autoLoadAll? })` fetches `/api/depeg-events` with optional `?stablecoin=` filter (shared options built by `depegEventsInfiniteQueryOptions(...)`); `useActiveDepegEvents(...)` wraps it with `activeOnly` preset
- TanStack Query: `staleTime` = 15 min, `refetchInterval` = 30 min
- Pages through `/api/depeg-events?limit=100&cursor=...`, advancing via the response `nextCursor`; oversized `limit` values are rejected rather than silently clamped
- `/depeg` uses the unfiltered infinite hook for the global recent-events feed
- `/depeg/<event>/` static pages form a grow-only permanent archive: every confirmed event starting at or after the archive epoch (2026-01-01, `DEPEG_ARCHIVE_EPOCH_SECONDS`) with an absolute peak deviation at or above the 5.0% static-page threshold keeps its page permanently, plus pinned authored incidents such as USDC 2023 from before the epoch. Published event URLs never become unhandled 404s (the former 12-newest recency window churned already-ranked pages to 404). `sync-depeg-events.ts` carries previously published static rows forward when a live reclassification would drop them below the page threshold, then verifies that no archived slug disappeared; an operator must explicitly supply the reviewed `--allow-archive-shrink` override for an intentional removal. The release SEO gate separately compares the new build with the currently deployed sitemap, covering refresh-only routes that have not reached the checked-in snapshot: each deployed event must remain submitted or receive a direct 301 to its surviving submitted incident when the resolver consolidates fragments. A reviewed artifact removal is the other sanctioned shrink path: `sync-depeg-events --allow-archive-shrink` retires the rows and `public/_redirects` supplies the one-hop 301s, so a published `/depeg/<slug>/` URL never 404s (the three retired Noon USN slugs redirect to `/stablecoin/usn-noon/`; see the operator runbook above). The full event table remains available through the API, live tracker, stablecoin detail history, and feeds; sub-threshold feed entries link back to the relevant stablecoin history anchor instead of consuming Cloudflare Pages files.
- When multiple static events share the same stablecoin, UTC date, and direction, their detail pages add the precise UTC start time to metadata, H1, event metrics, and adjacent navigation. They also render a factual time/deviation/duration/recovery synopsis and use the canonical URL as the `NewsArticle.@id`, preventing materially separate observations from presenting as identical search documents.
- Stablecoin detail pages use the filtered infinite hook with `autoLoadAll` so the hero can read the full recorded-event `total` while the history table hydrates every page in the background

### Component: DepegFeed (`depeg-feed.tsx`)

- Responsive recent-events feed with progressive history pagination
- Sorted ongoing-first, then by `startedAt` DESC
- Shows: logo, symbol, peak deviation colored by severity (green <50bps, amber 50-200bps, orange 200-500bps, red >=500bps), direction badge, LIVE pulsing indicator if ongoing, date, duration
- Click navigates to `/stablecoin/{id}`

### Depeg dashboard stat context

`DepegOutlookHero` (`src/components/depeg-outlook-hero.tsx`) uses the shared contextual methodology pattern on its key figures (`Active depegs`, `Holding peg`) so users can read the live-event semantics in place instead of jumping straight to the long-form methodology. It replaced the route's earlier stat-card stack; route composition is owned by [depeg-page.md](./depeg-page.md).

### Component: DepegHistory (`depeg-history.tsx`)

- Stablecoin-detail depeg history table backed by the filtered infinite hook
- Separates public incidents from raw threshold crossings using the filtered API counts and per-incident `constituentEventCount`
- Shows a coverage-aware recent 90-day peg percentage alongside observed days, incident count, and threshold-crossing count; pre-coverage days are not silently treated as stable
- Shows the PegScore coverage anchor and whether it came from a reviewed replay or an assumed asset-age/first-observation fallback
- Background-hydrates the full per-coin history, then paginates the rendered table client-side at 25 rows per page
- Summary metrics: recorded incidents, threshold crossings, worst deviation, current streak (days at peg or "Depegged now")
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

**Window divergence (deliberate).** `computePegStability()` measures over the coin's *full* available chart/event history and does not call `coinTrackingStart()`, so it never applies PegScore's 4-year lookback clamp. Published PegScore, `/api/peg-summary`, and the detail-page hero (`trackingSpanDays`, `pegPct`) all use the clamped 4-year window. The two therefore disagree for coins with more than four years of history — display-side spans and time-at-peg can be longer than the scored ones, and neither number is wrong. Today only `currentStreakDays`, `depeggedNow`, and `worstDeviationBps` from this helper reach the UI (`src/components/depeg-history.tsx`), so the `pegPct` / `trackingSpan` divergence is not currently visible side by side; keep it in mind before surfacing `pegPct` or `trackingSpan` next to a published PegScore.

## Peg Score (`peg-score.ts`)

Used in report cards. Formula:

```
knownSpanSec = spanSec - unknownCoverageSeconds
pegPct = knownSpanSec > 0 ? (1 - totalObservedDepegSec / knownSpanSec) * 100 : null
severityScore = 100 - sum of per-event penalties
  per-event penalty = max(durationPenalty, magnitudeFloor)
    durationPenalty = (peakBps/100) * (durationDays/30) * recencyWeight   (durationDays capped at 90)
    magnitudeFloor  = (peakBps/2000) * recencyWeight
spreadPenalty = min(15, (stddev of (|peakBps| × eventSeverityWeight) / 1000) * 15)
activeDepegPenalty = if current trusted off-peg observation: min(50, max(5, |peakBps| / 50))

pegScore = max(0, min(100, round(0.5*pegPct + 0.5*severityScore - activeDepegPenalty - spreadPenalty)))
```

The quality gate uses `PEG_SCORE_EXCLUDED_AUDIT_VERDICTS` from `shared/types/depeg-audit.ts`: `false_positive` and `disputed` are excluded. `no_data` remains eligible for PegScore but is excluded by DDR's separate `DDR_INELIGIBLE_AUDIT_VERDICTS` policy. As of v6.30, unknown non-null verdicts fail closed in direct scoring and SQL recomputation, and archived/V9 parsing rejects them without coercion to null. Null legacy verdicts remain eligible. Included events with `confidenceTier = "low"` retain time-at-peg impact but receive a 0.5 severity/spread weight. Quality counters expose changed score inputs.

**Tracking window**: `coinTrackingStart()` first honors a reviewed `pegScoreCoverage.startDate` when an operator has
verified replay plus continuous live coverage. Otherwise it prefers a curated launch date, then the
earliest first-seen anchor from `getFirstSeenDates()`, which merges the coin's earliest `supply_history` snapshot
with its first durable Pharos valid-price observation and keeps whichever is earlier. This gives priced assets
without supply-history coverage a real age anchor instead of leaving
them unrated indefinitely without claiming that unverified pre-observation time was incident-free. PegScore still
requires at least 7 days after excluding unknown event spans. If none of those anchors exists, a coin with depeg events falls back to the
earliest event; a coin with no anchor and no events returns `pegScore = null`.

The API also computes a coverage-aware 90-day companion window. Its denominator starts at the later of 90 days ago
or the tracking anchor, and it excludes replay rows audited as false positives or disputed. The result reports
observed days, incident count, raw threshold-crossing count, peg percentage, and whether the window is coverage-limited.

**Magnitude floor**: Every depeg event carries a minimum severity penalty proportional
to its peak deviation, regardless of how brief. This prevents hundreds of short
high-magnitude depegs from being scored as nearly free.

**Active depeg penalty**: Floor of 5, scales at `|peakBps| / 50`, capped at 50.
A 500 bps currently observed depeg costs 10 points; 2500+ bps hits the cap. An open lifecycle alone cannot activate this penalty: a recorded trusted off-peg observation must have no explicit gap and be no older than 1200 seconds. Historical peaks still contribute the magnitude floor and spread even when current coverage is unavailable.

Returns `null` if fewer than 7 known days remain after subtracting unknown event spans; occupancy is also `null` if no known time remains. The legacy tracking-age field still reports the full anchor span. The 7–30 day "Early score" label described on /methodology and /depeg is not currently rendered.

## Edge Cases & Guardrails

| Scenario | Handling |
|----------|----------|
| Duplicate events | Unique index (`stablecoin_id`, `started_at`, `source`) + run-start repair; same-direction rows merge, opposite-direction rows close older directions without absorbing opposite-sign peaks |
| NAV tokens | Skipped (expected to appreciate, depeg detection N/A) |
| Supply < $1M | Skipped for live event recording (prevents micro-cap noise); detail UI may still show current price deviation with an explicit coverage-limited note; existing rows close with `close_reason = 'coverage-lost-supply'` only on an observed sub-floor supply |
| Supply unavailable (absent/empty/invalid buckets) | No new event; an existing open row stays open and unchanged (no coverage closure, no recovery progress) with a per-asset warning |
| Missing/invalid prices | Multiple null/NaN/<= 0 checks |
| Peg reference validation | Must be finite and > 0 |
| DEX freshness | Prices > 75 min old ignored |
| Orphaned events | Closed with `close_reason = 'orphan-tracking-removed'` and `recovery_price = NULL` when coin drops off tracking |
| Non-USD threshold | 150bps accounts for FX noise and thin liquidity |

### Trusted-price coverage and unresolved legacy spans (6.31)

Migration `0255_depeg_trusted_price_coverage.sql` adds nullable columns only; it records no historical observations. Detection persists trusted off-peg `intervals`, known `atParIntervals`, the latest trusted price clock, and `lastObservationKind` (`trusted-off-peg`, `trusted-at-par`, or `blind`). A trusted at-par observation advances the trusted clock but breaks off-peg continuity; `gapStartedAt` therefore marks a break in off-peg continuity, not necessarily blind time. Missing/unusable prices, unavailable supply/reference context, omitted assets, and gaps over 1200 seconds break observation continuity. State transitions and resumption start zero-length endpoints; only subsequent continuous observations in the same trusted state extend their intervals. Pending promotion starts evidence at confirmation, not inside unrecorded pending history. Malformed stored coverage warns with the row ID and becomes unknown; producer writes remain strictly validated. Unchanged omitted-asset blind coverage does not trigger another UPDATE.

For pre-migration **open** events, the entire uninstrumented span is explicitly unknown. The first post-migration trusted observation does not backfill the preceding span. Closed legacy and historical replay rows retain their recorded episode durations; their internal price-gap boundaries remain unreconstructable. Instrumented rows retain coverage intervals when closed. Recovery time bounded by consecutive trusted at-par endpoints is known at-par time; unrecorded transition/recovery spans remain unknown rather than automatically off peg.

The single `mergeDepegSeconds` authority counts recorded off-peg intervals only. The complement of both off-peg and at-par intervals inside each scored event is `unknownCoverageSeconds`; overlapping unknown spans merge and trusted intervals from another row take precedence. Unknown time is excluded from both off-peg time and the occupancy denominator, including recent 90-day statistics, and from duration severity. It is neither zero deviation nor verified at-peg time. `pegPct` is nullable when the known denominator is empty; `pegScore` is NR when fewer than seven known days remain. Public event `priceCoverage` and summary `unknownCoverageSeconds` expose this distinction, and exact Safety Score peg provenance retains it.

**First production run:** retain the pre-window Time Travel bookmark, migration ledger, and deployed Worker version. Require the exact `0000_baseline.sql` ledger membership and only the intended tail migration pending; run the migration and SQL-safety checks before the normal migration-before-Worker deploy. After verifying sole-version activation, observe the first two `sync-stablecoins` runs: a trusted open event receives a first endpoint then at most the continuous interval between those runs, while USDA (Avalon), if its current price remains unavailable, keeps its lifecycle open, has a persisted gap, and accrues no observed off-peg seconds. Inspect its three new columns with read-only SELECTs. Then observe the next `prepare-safety-score-v9-input` job publishing `peg-analytics` and the subsequent Safety Score publication: methodology 6.31, explicit unknown coverage, nullable occupancy where fully blind, admitted sub-floor deviations where prices exist, and no `peg-supply-floor-withheld` reason for those observed facts. Frozen pre-cutover Safety Score captures cannot prove a producer change without explicitly projected recomputation; compare the first newly produced generation, not just deployment status. A Worker-only rollback leaves the additive schema/evidence intact but pauses the new producer; reactivation must start a new interval after a long gap. D1 restore is reserved for unexpected schema/data mutation and requires the retained bookmark.
