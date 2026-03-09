# Flow Data Quality Improvements — Design

**Date:** 2026-03-09
**Status:** Approved
**Scope:** Data quality fixes for mint/burn flows (Q1–Q4)

---

## Q1: Same-Transaction Atomic Roundtrip Detection

**Problem:** Flash loans and atomic arbitrage mint AND burn the same token within a single transaction. These are counted as real flow, inflating volumes and distorting pressure scores.

**Approach:** Same-transaction flagging. Detect mint+burn pairs sharing a `tx_hash` and flag them without discarding raw data.

**Detection logic:**
- After parsing events from `eth_getLogs`, group by `(tx_hash, stablecoin_id)`
- If a tx contains both mint(s) and burn(s) for the same token, flag all events in that tx as `atomic_roundtrip`
- No partial netting — the entire tx is flagged (simple, auditable)

**Schema:**
- New column on `mint_burn_events`: `flow_type TEXT DEFAULT 'standard'`
- Values: `standard` (real flow) | `atomic_roundtrip` (flash loan / atomic arb)

**Aggregation change:**
- Hourly aggregation (`persistence.ts`) adds `WHERE flow_type = 'standard'`
- Atomic roundtrips excluded from all volume/count/net calculations

**Retroactive:**
- One-time migration to classify existing events: group by `(tx_hash, stablecoin_id)`, find txs with both directions, update `flow_type`

**Where in code:**
- Post-parse step in the shared pipeline (after `parseMintBurnLogs()`, before `persistEvents()`)
- Both cron and backfill paths benefit automatically via shared pipeline

---

## Q2: Bridge Address List Expansion

**Problem:** Only CCIP bridge detection exists (5 tokens). Burns to Stargate, Across, Wormhole, Axelar, Hyperlane are miscounted as `effective_burn`.

**Approach:** Research and add router/pool contract addresses for the top 5 bridge protocols by Ethereum stablecoin volume.

**Target bridges:**
1. Stargate (LayerZero) — major USDT/USDC bridge
2. Across — high-volume USDC/USDT/DAI bridge
3. Wormhole — broad token coverage
4. Axelar — cross-chain messaging + token transfers
5. Hyperlane — growing bridge infra

**Implementation:**
- Add verified Ethereum contract addresses to `knownBridgePoolAddresses` in per-config `bridgeDetection` entries in `mint-burn-contracts.ts`
- No logic changes — existing counterparty matching already works
- Document covered protocols and "last verified" date in file header

**Classification behavior (unchanged):**
- Burn to known bridge address → `bridge_burn`
- Burn to known bridge address but no bridge signal → `review_required`
- Burn to unknown address → `effective_burn`

**Retroactive:**
- Re-run classification on existing burn events against expanded address list
- Update affected hourly aggregates

---

## Q3: Automatic Price Backfill in Cron

**Problem:** Events synced without price data get `amount_usd = NULL`, making them invisible in USD aggregates. Currently requires manual admin endpoint trigger.

**Approach:** Self-healing tail-end step in the existing sync cron.

**Implementation:**
- At the end of `syncMintBurn()`, after the main scan loop:
  1. Query `mint_burn_events` for rows in last 48h where `amount_usd IS NULL`
  2. Load current prices from `price_cache` for affected stablecoin IDs
  3. Update matching rows: `amount_usd = amount * price`, plus `price_used`, `price_timestamp`, `price_source`
  4. Re-aggregate affected hourly buckets via existing `recalculateAffectedHours()`

**Scope controls:**
- 48h lookback window (old NULLs left for manual admin endpoint)
- Only runs if main sync completed without error
- Zero additional Alchemy calls (D1-only operations)

**Existing admin endpoint:** Unchanged, available for historical backfills beyond 48h.

---

## Q4: Minimum Activity Gate for Pressure Shift

**Problem:** The $1M floor denominator produces misleading pressure scores for coins with very low daily volume. A $10K event on a dormant coin can produce outsized score swings.

**Approach:** Add a minimum 24h absolute flow threshold below which pressure shift returns `null` (NR).

**Implementation:**
- New constant: `MIN_ACTIVITY_USD = 50_000`
- In `computePressureShift()`: if `abs24hFlow < MIN_ACTIVITY_USD`, return `null`
- Runs before the existing `MIN_DATA_DAYS` check

**Why $50K:**
- Below $50K daily flow, single small events cause large score swings
- Most extended-tier coins with real market activity clear this easily
- Dormant/illiquid coins get NR — honest about signal quality

**Downstream effects:**
- NR coins already excluded from Bank Run Gauge weighting (existing null handling)
- Frontend already handles NR state (shows "NR" badge)
- No schema changes — scores computed on the fly
- No retroactive migration needed

---

## Cross-Cutting: Impact Measurement

**Goal:** Prove each change improved data quality with concrete before/after metrics.

**Approach:**
- Before running Q1/Q2 retroactive migrations, capture a "before" snapshot:
  - Aggregate 30d burn volume (total USD)
  - Bank Run Gauge score
  - Per-coin pressure shift for the top 10 coins by market cap
  - Count of coins returning NR vs scored
- After each migration, capture "after" snapshot and compute the diff
- Produces concrete evidence: e.g., "Q1 reclassified 2,847 events as atomic_roundtrip, reducing 30d aggregate burn volume by 8%"
- Also validates Q4 threshold calibration — shows how many coins flip to NR at $50K

**Output:** Summary logged to console during migration; no persistent storage needed.

---

## Cross-Cutting: Methodology Versioning

**Goal:** Transparency for users who make financial decisions based on flow data.

**Approach:**
- Bump methodology version from v4.4 → v4.5
- Update the `/methodology` page's mint/burn flow section to document:
  - Atomic roundtrip exclusion (Q1)
  - Expanded bridge detection (Q2)
  - Minimum activity gate (Q4)
- Add changelog entry at `/methodology/mint-burn-flow-changelog/`
- Update `docs/mint-burn-flows.md` to reflect new constants, flow_type column, and bridge coverage

---

## Cross-Cutting: Cron Observability Counters

**Goal:** Production visibility into whether the new filters are firing correctly.

**Approach:**
- The sync already returns `{ itemCount, status, metadata }` — extend `metadata` with:
  - `atomicRoundtripsDetected` — count of events flagged as atomic_roundtrip this cycle
  - `bridgeBurnsClassified` — count of burns classified as bridge_burn this cycle
  - `nullPricesHealed` — count of NULL amount_usd events backfilled this cycle
- These counters flow into the existing `/status` dashboard health view with zero new endpoints
- Enables monitoring: if `bridgeBurnsClassified` drops to zero for weeks, the address list may be stale

---

## Non-Goals

- Multi-chain expansion (deferred — adds significant Alchemy budget and D1 load)
- Adding more stablecoin contract configs (deferred — same resource concern)
- Feature depth enhancements (alerting, counterparty analysis, UI improvements — separate effort)
- Changes to the pressure shift formula beyond the activity gate
