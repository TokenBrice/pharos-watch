# Mint/Burn Flow Tracker

On-chain mint and burn event tracker for stablecoins on **Ethereum** via Alchemy JSON-RPC. Detects Transfer events (and USDT-specific Issue/Redeem events), aggregates them into hourly flow buckets, exposes per-coin raw `Net Flow` plus baseline-relative `Pressure Shift vs 30D`, computes a market-cap-weighted Bank Run Gauge, and flags flight-to-quality signals. Live ingestion now runs in two lanes: a critical 20-minute lane for major coverage and an offset extended 20-minute lane for long-tail backlog drain.

Product scope note: the public `/flows` page now labels this feature explicitly as **Ethereum-only** and surfaces per-coin `coverage` metadata so partial history or lagging sync states are visible to users instead of implied as complete market-wide coverage.

Operational freshness configuration is shared via `worker/src/lib/mint-burn-health-config.ts`:
- major-symbol baseline (`USDT`, `USDC`, `DAI`, `USDS`, `GHO`, `FRXUSD`, `BOLD`, `reUSD`)
- warning threshold (`6h`)
- critical threshold (`24h`)

Scheduled/http handlers apply env overrides on top of these defaults (`worker/src/handlers/scheduled.ts`, `worker/src/handlers/http.ts`). Public `/api/health` now keys mint/burn freshness to the critical-lane sync timestamp / run status (the same semantics exposed by `/api/mint-burn-flows`) so quiet majors do not falsely mark the health surface stale just because no new events occurred.

Public `/api/mint-burn-flows` freshness metadata and the `/flows` page intentionally allow one missed 20-minute critical-lane slot before warning. User-facing freshness is `fresh <= 40m`, `degraded <= 60m`, `stale > 60m`, which keeps the public warning surface aligned with `/status` cron-health grace windows instead of flagging a single late slot as an incident.

---

## Methodology Versioning

- **Current methodology version:** `v4.7`
- **Public changelog page:** `/methodology/mint-burn-flow-changelog/`
- **Internal reconstructed timeline:** [Mint/Burn Flow Methodology Timeline](./mint-burn-flows-timeline.md)

---

## Cron Schedule

- **Critical lane pattern:** `4,24,44 * * * *` (every 20 minutes, offset at :04/:24/:44)
- **Extended lane pattern:** `13,33,53 * * * *` (every 20 minutes, offset at :13/:33/:53)
- **Trigger mode:** isolated. `sync-blacklist` and `sync-dex-discovery` run on their own dedicated 20-minute triggers (`3,23,43 * * * *` and `6,26,46 * * * *`).
- **Function:** `syncMintBurn(db, alchemyApiKey, { lane, jobName, ... })`
- **Provider:** Alchemy JSON-RPC (PAYG plan)
- **File:** `worker/src/cron/sync-mint-burn.ts`
- **Registration:** cron declared in `worker/wrangler.toml`, executed via `worker/src/handlers/scheduled.ts`
- **Returns:** `{ itemCount, status, metadata }` where `itemCount = rowsInserted` (not parsed rows). Metadata includes `lane`, `jobName`, `nullPricesHealed`, and per-config coverage-frontier diagnostics when scans are partial.
- **Operator runbook:** `agents/process/mint-burn-ingestion.md`

Lane policy:
- `sync-mint-burn` = critical lane. Uses the existing job id so freshness alerts and API freshness remain keyed to the major-symbol path.
- `sync-mint-burn-extended` = extended lane. Uses its own `mint_burn_run_state.job` key and warning-only coverage semantics so long-tail backlog churn does not escalate the critical lane to `error`.

UI note: when `/flows` receives a mint/burn-specific `sync.warning`, it renders that targeted banner and suppresses the generic stale-data banner for the same query so users do not see duplicate amber warnings describing the same freshness condition. Cached fallback API responses now preserve only freshness-derived headers; a transient live-query failure no longer emits an extra generic `Warning` while the cached dataset is still inside the public 40-minute freshness window.

---

## Constants & Thresholds

| Constant | Value | Purpose |
|----------|-------|---------|
| `dustThreshold` | 10,000 default (token-native); 10 for gold tokens | Events below this amount are discarded |
| `INDEXING_SAFETY_SEC` | 900 (15 min) | Safety margin when advancing sync state to chain head |
| `ETHEREUM_BLOCK_TIME_SEC` | 12 sec | Approximate Ethereum block time (yields ~75-block safety margin) |
| `DENOM_SCALE` | 0.3 | Pressure-shift denominator = 30% of baseline daily absolute flow |
| `DENOM_FLOOR` | $1,000,000 | Minimum pressure-shift denominator |
| `Z_MULTIPLIER` | 50 | Z-score amplification in the pressure-shift formula |
| Pressure-shift clamp range | -100 to +100 | Signed baseline-relative score output range |
| `MIN_DATA_DAYS` | 7 | Days of history required before pressure shift returns a value |
| `MIN_ACTIVITY_USD` | 50,000 | 24h absolute flow below this returns NR pressure shift |
| `FTQ_THRESHOLD` | $100,000,000 | Minimum net flow (both sides) to trigger flight-to-quality |
| `ETHEREUM_SCAN_RANGE` | 50K (Ethereum) | Max block range per contract per cycle |
| `startBlock` | per-config (non-uniform) | Each contract config has its own start block |
| Subrequest budget | 200 per cron run | Global Alchemy API call budget |
| Per-config request cap | 60 critical / 25 extended | Prevents one hot config from consuming the full lane budget |
| Config tier policy | `critical` / `extended` | Critical and extended lanes run on separate cron schedules; each config also has a per-config request cap |

---

## Contract Configurations

**File:** `worker/src/lib/mint-burn-contracts.ts`

Token identity now resolves from shared metadata in `shared/lib/stablecoins.ts`. The mint/burn config file only keeps tracker-specific fields such as event signatures, `startBlock`, `dustThreshold`, tiering, and bridge-detection hints. The only explicit address overrides are the two `reUSD` vault-event configs, which intentionally track non-token contracts.

### Tracked Stablecoins

Current scope: **83 contract configs** across **82 stablecoin IDs** (6 critical + 77 extended; 80 transfer-only ERC-20 configs + 1 USDT mixed-event config + 2 reUSD custom-event configs).

| Symbol | ID | Decimals | Category | Events |
|--------|----|----------|----------|--------|
| USDT | usdt-tether | 6 | Safe haven | Transfer + Issue/Redeem |
| USDC | usdc-circle | 6 | Safe haven | Transfer |
| FDUSD | fdusd-first-digital | 18 | Safe haven | Transfer |
| PYUSD | pyusd-paypal | 6 | Safe haven | Transfer |
| DAI | dai-makerdao | 18 | Risky | Transfer |
| GHO | gho-aave | 18 | Risky | Transfer |
| USDe | usde-ethena | 18 | Risky | Transfer |
| USDS | usds-sky | 18 | Risky | Transfer |
| FRXUSD | frxusd-frax | 18 | Risky | Transfer |
| BOLD | bold-liquity | 18 | Risky | Transfer |
| fxUSD | fxusd-f-x-protocol | 18 | Extended | Transfer |
| crvUSD | crvusd-curve | 18 | Extended | Transfer |
| AUSD | ausd-agora | 6 | Extended | Transfer |
| ZCHF | zchf-frankencoin | 18 | Extended | Transfer |
| EURC | eurc-circle | 6 | Extended | Transfer |
| PAXG | paxg-paxos | 18 | Extended | Transfer |
| XAUT | xaut-tether | 6 | Extended | Transfer |
| USDG | usdg-paxos | 6 | Extended | Transfer |
| USD1 | usd1-world-liberty-financial | 18 | Extended | Transfer |
| USDf | usdf-falcon | 18 | Extended | Transfer |
| USYC | usyc-hashnote | 6 | Extended | Transfer |
| RLUSD | rlusd-ripple | 18 | Extended | Transfer |
| USDY | usdy-ondo-finance | 18 | Extended | Transfer |
| BUIDL | buidl-blackrock | 6 | Extended | Transfer |
| USDD | usdd-tron-dao-reserve | 18 | Extended | Transfer |
| USDTB | usdtb-ethena | 18 | Extended | Transfer |
| M | m-m0 | 6 | Extended | Transfer |
| USD0 | usd0-usual | 18 | Extended | Transfer |
| TUSD | tusd-trueusd | 18 | Extended | Transfer |
| CUSD | cusd-cap | 18 | Extended | Transfer |
| USR | usr-resolv | 18 | Extended | Transfer |
| FRAX | frax-frax | 18 | Extended | Transfer |
| DOLA | dola-inverse-finance | 18 | Extended | Transfer |
| IUSD | iusd-infinifi | 18 | Extended | Transfer |
| GUSD | gusd-gate | 6 | Extended | Transfer |
| avUSD | avusd-avant | 18 | Extended | Transfer |
| pmUSD | pmusd-precious-metals | 18 | Extended | Transfer |
| USDz | usdz-anzen | 18 | Extended | Transfer |
| MNEE | mnee-mnee | 18 | Extended | Transfer |
| TBILL | tbill-openeden | 6 | Extended | Transfer |
| USDO | usdo-openeden | 18 | Extended | Transfer |
| EURCV | eurcv-societe-generale-forge | 18 | Extended | Transfer |
| REUSD | reusd-resupply | 18 | Extended | Transfer |
| EURI | euri-banking-circle | 18 | Extended | Transfer |
| GUSD | gusd-gemini | 2 | Extended | Transfer |
| USDP | usdp-paxos | 18 | Extended | Transfer |
| XUSD | xusd-straitsx | 6 | Extended | Transfer |
| MUSD | musd-metamask | 6 | Extended | Transfer |
| YUSD | yusd-aegis | 18 | Extended | Transfer |
| SUSD | susd-synthetix | 18 | Extended | Transfer |
| LUSD | lusd-liquity | 18 | Extended | Transfer |
| USDCV | usdcv-societe-generale-forge | 18 | Extended | Transfer |
| EURE | eure-monerium | 18 | Extended | Transfer |
| USN | usn-noon | 18 | Extended | Transfer |
| EUSD | eusd-electronic-usd | 18 | Extended | Transfer |
| meUSD | meusd-mezo | 18 | Extended | Transfer |
| MSUSD | msusd-metronome | 18 | Extended | Transfer |
| NUSD | nusd-neutrl | 18 | Extended | Transfer |
| ALUSD | alusd-alchemix | 18 | Extended | Transfer |
| FIDD | fidd-fidelity | 18 | Extended | Transfer |
| MSUSD | msusd-main-street | 18 | Extended | Transfer |
| WUSD | wusd-worldwide | 18 | Extended | Transfer |
| SBC | sbc-brale | 18 | Extended | Transfer |
| OUSD | ousd-origin-protocol | 18 | Extended | Transfer |
| USP | usp-pikudao | 18 | Extended | Transfer |
| USDR | usdr-stablr | 6 | Extended | Transfer |
| USTB | ustb-superstate | 6 | Extended | Transfer |
| OUSG | ousg-ondo-finance | 18 | Extended | Transfer |
| mTBILL | mtbill-midas | 18 | Extended | Transfer |
| wsrUSD | wsrusd-reservoir | 18 | Extended | Transfer |
| AUDD | audd-novatti | 6 | Extended | Transfer |
| JPYC | jpyc-jpyc | 18 | Extended | Transfer |
| XAUm | xaum-matrixdock | 18 | Extended | Transfer |
| EURR | eurr-stablr | 6 | Extended | Transfer |
| EUROP | europ-schuman | 6 | Extended | Transfer |
| DEURO | deuro-deuro | 18 | Extended | Transfer |
| tGBP | tgbp-tokenised | 18 | Extended | Transfer |
| syrupUSDC | syrupusdc-maple | 6 | Extended | Transfer |
| syrupUSDT | syrupusdt-maple | 6 | Extended | Transfer |
| AID | aid-gaib | 18 | Extended | Transfer |
| apxUSD | apxusd-apyx | 18 | Extended | Transfer |
| reUSD | reusd-re-protocol | 18 | Risky | Deposited + InstantRedemptionProcessed (2 configs, Ethereum) |

Flight-to-quality classification is now **report-card-cache driven only**. Coins with report-card score `>= 65` are treated as `safe`, scores `< 50` are treated as `risky`, and the middle band is ignored for FTQ. When `report_card_cache` is missing, stale, or malformed, FTQ classification is marked unavailable in the response (`gauge.classificationSource = "unavailable"`, `sync.classificationWarning != null`) instead of silently falling back to a hardcoded safe-haven list. No hardcoded fallback is implemented — FTQ requires fresh report-card data.

Events are also classified by `flow_type` (`standard` or `atomic_roundtrip`) to exclude flash loan / atomic arb noise from aggregation.

### Event Detection

**Standard mint/burn:** ERC-20 `Transfer(address,address,uint256)` events filtered by zero address.

- **Mint:** `topics[1]` (from) = zero address
- **Burn:** `topics[2]` (to) = zero address

**USDT Ethereum special handling:** The USDT contract uses custom `Issue(uint256)` and `Redeem(uint256)` events for treasury operations (issue() does NOT emit Transfer). These are tracked in addition to Transfer events.

| Event | Topic Hash | Amount Encoding |
|-------|-----------|-----------------|
| `Transfer(address,address,uint256)` | `0xddf252ad...` | `transfer-value` (data field) |
| `Issue(uint256)` | `0xcb8241ad...` | `first-data-uint256` |
| `Redeem(uint256)` | `0x702d5967...` | `first-data-uint256` |

**reUSD special handling:** Re Protocol vault contracts emit custom deposit/redeem events instead of standard mint/burn Transfers. Deposits are decoded from `Deposited(address,address,uint256)` (`dataSlot=2`, 18-decimal amount), and burns from `InstantRedemptionProcessed(address,uint256,uint256)` (`first-data-uint256`, 18-decimal shares burned).

---

## Sync Algorithm

1. **Load sync state** — batch query `mint_burn_sync_state` for all lane-selected contract keys. Falls back to `startBlock - 1` for new configs.
2. **Apply runtime policy** — filter disabled configs (`MINT_BURN_DISABLED_IDS`, `MINT_BURN_DISABLED_SYMBOLS`), select the requested lane (`critical`, `extended`, or `all`), rotate start index from the lane-specific `mint_burn_run_state.job`, front-load critical configs inside mixed/all runs, and assign a per-config request cap inside the global budget.
3. **Get chain head** — Alchemy `eth_blockNumber` call per chain (cached per chain ID).
4. **Load price cache** — query `price_cache` for all tracked stablecoin IDs (used for USD conversion).
5. **For each contract config:**
   - Skip if `fromBlock > chainHead` or the lane/global budget is exhausted.
   - For each event definition, call Alchemy `eth_getLogs` with adaptive recursive block-range splitting on provider/range failures.
   - Enforce the per-config request cap while fetching logs, resolving timestamps, and classifying bridge burns so a single config cannot monopolize the lane.
   - Resolve block timestamps — batch `eth_getBlockByNumber` for all unique blocks in the returned logs, using local + persistent (`block_timestamp_cache`) caches.
   - Parse logs per event definition: decode amount (respecting decimals), derive counterparty address, compute `amount_usd = amount * price` (null if no price), and initialize `flow_type='standard'`.
   - Classify bridge burns per parsed batch to preserve the shared Alchemy transaction-context budget.
   - Detect atomic roundtrips after all event definitions for the config are parsed: group rows by `(tx_hash, stablecoin_id)` and flip the whole group to `flow_type='atomic_roundtrip'` when both mint and burn directions appear in the same transaction.
   - Filter out dust events (amount < `dustThreshold`).
   - Batch `INSERT OR IGNORE` into `mint_burn_events`, track parsed vs inserted counts from D1 `meta.changes`.
   - Update `mint_burn_sync_state.last_block`:
     - If every event definition completed and timestamps are fully resolved:
       - If events found: advance to `maxBlockSeen`.
       - If no events: advance to `chainHead - safetyMarginBlocks` (avoids skipping not-yet-indexed events).
     - If any event definition was partial or any block timestamps were unresolved: advance only to the shared safe coverage frontier (`min(scannedToBlock, earliestMissingTimestamp-1)`).
     - If no safe frontier exists for the config in that run: do not advance.
6. **Recalculate affected hourly buckets** — for each unique `(stablecoinId, chainId, hourTs)` touched, `INSERT OR REPLACE` into `mint_burn_hourly` by re-aggregating from `mint_burn_events`, counting only `flow_type='standard'` rows so atomic roundtrips do not leak into flow statistics.
7. **Auto-heal recent NULL prices** — on non-error runs, query up to 500 events with `amount_usd IS NULL` in the last 48 hours, resolve from `price_cache`, update `amount_usd/price_*` with `price_source=price_cache_heal`, and re-aggregate only newly affected hourly buckets.
   - Cron metadata now includes both `nullPricesHealed` and `nullPriceBacklog` (`recent`, `historical`) so operators can distinguish live healable gaps from older debt.
8. **Emit active progress** — long runs call the shared cron `reportProgress(...)` hook so `/api/status` can surface the active stage, queue position, and budget heartbeat while the lease is still live.
9. **Escalate degraded runs** — the critical lane emits `status=degraded|error` when sustained coverage/API thresholds are breached, with streak tracking in `mint_burn_run_state`. The extended lane keeps the same observability metadata but does not escalate long-tail backlog pressure to `error`.
10. **Sweep cross-run roundtrips** — on non-error runs, query up to 200 `(tx_hash, stablecoin_id)` groups within the last 48 hours where both mint and burn directions exist but `flow_type = 'standard'`. Reclassify to `atomic_roundtrip` and re-aggregate affected hourly buckets. This catches roundtrips where the mint and burn were ingested in separate cron runs.

**Counterparty resolution:** For mints, `topics[2]` (recipient). For burns, `topics[1]` (sender).

**Event ID format:** `"{chainId}-{txHash}-{logIndex}"` — deterministic, prevents duplicates via `INSERT OR IGNORE`.

---

## Shared Ingestion Pipeline Boundaries

Cron (`sync-mint-burn`) and admin backfill (`backfill-mint-burn`) now share a single ingestion pipeline under `worker/src/lib/mint-burn-pipeline/`.

| Module | Responsibility |
|--------|----------------|
| `types.ts` | Shared ingestion row/context/counter types and sync-state mode union |
| `parse.ts` | `parseMintBurnLogs()` and event-level price resolution (`supply-history` then `price_cache` fallback) |
| `roundtrip-detection.ts` | Same-transaction `(tx_hash, stablecoin_id)` atomic roundtrip detection for `flow_type` tagging |
| `classification.ts` | Bridge-aware burn classification and transaction-context loading |
| `context.ts` | Shared loaders for current prices and historical price series |
| `persistence.ts` | `INSERT OR IGNORE` event writes, burn classification updates, affected-hour aggregation |
| `price-heal.ts` | Auto-heal recent NULL-price rows from `price_cache` and return affected hours |
| `roundtrip-sweep.ts` | Post-cron sweep for cross-run atomic roundtrip detection (48h window, 200 limit) |
| `sync-state.ts` | Sync-state key helpers plus mode-specific upserts (`replace` for cron, `monotonic-max` for backfill) |

Implementation invariant: `worker/src/api/backfill-mint-burn.ts` does not import from `worker/src/cron/sync-mint-burn.ts`; both entrypoints import shared helpers from `mint-burn-pipeline/*`.

`mint_burn_events.flow_type` is orthogonal to `burn_type`: `burn_type` only classifies burns as economic vs bridge/review, while `flow_type` applies to both mints and burns and marks same-transaction mint+burn noise as `atomic_roundtrip`.

Cron metadata includes `atomicRoundtripsDetected`, an observability counter for how many rows were tagged during the run.

---

## Scoring

**File:** `worker/src/lib/mint-burn-scoring.ts`

### Pressure Shift vs 30D (Flow Intensity Formula)

The underlying scoring formula is unchanged, but the product now exposes it as the baseline-relative `Pressure Shift vs 30D` signal. Runs server-side in the `/api/mint-burn-flows` aggregate handler.

```
denominator = max(baselineDailyAbs * 0.3, $1M)
z = (currentDailyNet - baselineDailyNet) / denominator
pressureShift = clamp(-100, 100, z * 50)
```

**Activity gate:** If the coin's 24h absolute flow (mint volume + burn volume) is below `MIN_ACTIVITY_USD` ($50,000), pressure shift returns `null` (NR). This prevents misleading scores for dormant or low-activity coins.

- **Input:** 24h net flow, 24h absolute flow (`|mint| + |burn|`), trailing 30 fully closed daily average net flow, trailing 30 fully closed daily average absolute flow, data age in days.

- **Output:** -100 to +100 score, or `null` (NR) if fewer than 7 days of history, if 24h absolute flow is below $50,000, or if the coin has no 24h mint/burn activity.
- Score of 0 = current flow matches baseline. Negative values = pressure is worse than baseline. Positive values = pressure is improving versus baseline.

### Two-Signal Interpretation Model

Per-coin UI and API now answer two different questions explicitly:

1. **Net Flow 24h** — current direction and magnitude from raw mint-minus-burn totals
   - `minting`: `netFlow24hUsd > 0`
   - `burning`: `netFlow24hUsd < 0`
   - `flat`: `netFlow24hUsd = 0` with activity
   - `inactive`: no 24h activity
2. **Pressure Shift vs 30D** — how unusual current pressure is versus the coin's own baseline
   - `improving`: score `> 10` (strictly greater; score of exactly 10 is stable)
   - `stable`: score between `-10` and `+10` (inclusive on both boundaries)
   - `worsening`: score `< -10` (strictly less; score of exactly -10 is stable)
   - `nr`: insufficient history or no current activity

Invariant: minting vs burning semantics now always come from raw net flow, never from score sign.

### Shared Signal Helper

`shared/lib/mint-burn-signals.ts` centralizes interpretation logic used by worker responses and frontend fallbacks:

- `getNetFlowDirection24h()`
- `getPressureShiftState()`
- `getCoinFlowCompositeState()`

### Gauge Bands

| Band | Range | Color | Meaning |
|------|-------|-------|---------|
| CRISIS | -100 to -70 | red | Massive redemption pressure |
| STRESS | -70 to -40 | orange | Heavy redemptions |
| CAUTIOUS | -40 to -10 | amber | Elevated burns |
| NEUTRAL | -10 to +10 | gray | Balanced mint/burn |
| HEALTHY | +10 to +40 | light-green | Net minting |
| CONFIDENT | +40 to +70 | green | Strong demand |
| SURGE | +70 to +100 | bright-green | Extreme minting demand |

Boundary convention: each band is `[min, max)`. The last band includes +100.

### Bank Run Gauge (Composite)

Market-cap-weighted average of individual pressure-shift scores:

```
gauge_score = Σ(intensity_i * mcap_i) / Σ(mcap_i)
```

- Skips coins with `null` intensity (insufficient data or NR no-activity window).
- Returns `null` only when ALL tracked coins lack valid intensity.
- Market cap sourced from `stablecoins` cache (DefiLlama data).

### Flight-to-Quality Detection

Detects simultaneous outflows from risky stablecoins and inflows to safe havens.

- **Activation:** `riskyNet24h < -$100M` AND `safeNet24h > +$100M`
- **Intensity:** `min(100, |riskyNet24h| / $1B * 100)`
- Safe havens: USDT, USDC, FDUSD, PYUSD. All others classified as risky.

---

## Database Schema

### mint_burn_events (migration 0031)

```sql
CREATE TABLE mint_burn_events (
  id TEXT PRIMARY KEY,                 -- "{chainId}-{txHash}-{logIndex}"
  stablecoin_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  direction TEXT NOT NULL,             -- "mint" or "burn"
  amount REAL NOT NULL,                -- Token-native amount
  amount_usd REAL,                     -- NULL if price unavailable at sync time
  price_used REAL,                     -- Price at resolution time
  price_timestamp INTEGER,             -- When the price was sourced (cache update time), NOT the event's block timestamp
  price_source TEXT,                   -- "supply-history-daily", "price-cache-current", or "price_cache_heal"
  flow_type TEXT DEFAULT 'standard',   -- "standard" or "atomic_roundtrip"
  counterparty TEXT,                   -- Address that received/sent tokens
  tx_hash TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,          -- Unix seconds
  explorer_tx_url TEXT NOT NULL
);

CREATE INDEX idx_mbe2_ts ON mint_burn_events(timestamp DESC);
CREATE INDEX idx_mbe2_coin ON mint_burn_events(stablecoin_id, timestamp DESC);
CREATE INDEX idx_mbe2_chain ON mint_burn_events(chain_id, timestamp DESC);
CREATE INDEX idx_mbe_null_price_ts ON mint_burn_events(timestamp DESC) WHERE amount_usd IS NULL;
```

### mint_burn_hourly (migration 0031)

Pre-aggregated hourly flow buckets. Written by cron after each scan; also recalculated by the backfill admin endpoint.

```sql
CREATE TABLE mint_burn_hourly (
  stablecoin_id TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  hour_ts INTEGER NOT NULL,            -- Unix seconds, truncated to hour: (timestamp / 3600) * 3600
  mint_count INTEGER NOT NULL DEFAULT 0,
  burn_count INTEGER NOT NULL DEFAULT 0,
  mint_volume_usd REAL NOT NULL DEFAULT 0,
  burn_volume_usd REAL NOT NULL DEFAULT 0,
  net_flow_usd REAL NOT NULL DEFAULT 0, -- mint_volume - burn_volume (positive = net mint)
  PRIMARY KEY (stablecoin_id, chain_id, hour_ts)
);

CREATE INDEX idx_mbh_ts ON mint_burn_hourly(hour_ts DESC);
CREATE INDEX idx_mbh_coin ON mint_burn_hourly(stablecoin_id, hour_ts DESC);
```

### mint_burn_sync_state (migration 0031)

Incremental block tracking (same pattern as `blacklist_sync_state`).

```sql
CREATE TABLE mint_burn_sync_state (
  config_key TEXT PRIMARY KEY,         -- "{chainId}-{contractAddress}"
  last_block INTEGER NOT NULL DEFAULT 0
);
```

**Migration history:** Initial schema in 0019 was dropped in 0020. Current schema is v2 (migration 0031).

---

## API Endpoints

### GET /api/mint-burn-flows

Two modes depending on whether `stablecoin` is provided.

**Aggregate mode** (no `stablecoin` param):

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `hours` | int | 24 | Time window, 1–720 (up to 30 days) |

Returns:

- `gauge` — composite Bank Run Gauge: `{ score, band, flightToQuality, flightIntensity, trackedCoins, trackedMcapUsd }`
- `coins[]` — per-coin summaries: fixed 24h raw net flow, canonical `pressureShiftScore`, derived interpretation fields, baseline context, coverage metadata, and largest event
- `hourly[]` — aggregate hourly timeseries: `{ hourTs, netFlowUsd, mintVolumeUsd, burnVolumeUsd }`
- `updatedAt` — Unix seconds of latest hourly bucket
- `windowHours` — requested chart window for `hourly[]`
- `scope` — current ingestion scope (`Ethereum-only`)
- `sync` — latest critical-lane freshness and warning state

**Per-coin mode** (`stablecoin` param provided):

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `stablecoin` | string | — | Stablecoin ID (required) |
| `hours` | int | 24 | Time window, 1–720 |

Returns:

- `stablecoinId`, `symbol`
- `mintVolumeUsd`, `burnVolumeUsd`, `netFlowUsd`, `mintCount`, `burnCount`
- `chains[]` — per-chain breakdown
- `hourly[]` — hourly timeseries
- `updatedAt`
- `windowHours`, `scope`, `sync`

Returns 404 if the stablecoin ID is not in the tracked set.

Contract note: aggregate `hours` only changes `hourly[]`. Coin-level `netFlow24hUsd`, mint/burn 24h volumes, counts, and pressure state remain fixed to the canonical 24-hour window.

**Cache:** `CACHE_PROFILES.standard` (~20-minute freshness keyed to successful critical-lane syncs)

### GET /api/mint-burn-events

Paginated event feed for a single stablecoin.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `stablecoin` | string | — | Stablecoin ID (required) |
| `direction` | string | — | Filter: `"mint"` or `"burn"` |
| `chain` | string | — | Filter by chain ID (`"ethereum"` only in current production scope) |
| `burnType` | string | — | Burn-only filter: `"effective_burn"`, `"bridge_burn"`, or `"review_required"` |
| `scope` | string | `"all"` | `"all"` returns the classified raw event stream; `"counted"` returns only rows that contribute to economic-flow aggregates (`flow_type='standard'` and mint/effective-burn semantics) |
| `minAmount` | number | — | Minimum USD amount; rows with `amount_usd IS NULL` are excluded when this filter is used |
| `limit` | int | 50 | Page size, 1–500 |
| `offset` | int | 0 | Pagination offset |

Returns: `{ events[], total }`. Events sorted by `timestamp DESC`.

Each event row includes valuation provenance fields (`priceUsed`, `priceTimestamp`, `priceSource`), `flowType`, plus burn classification fields (`burnType`, `burnReviewReason`).

Product note: stablecoin detail-page "Mint & Burn Flow History" uses the counted view so bridge burns, review-required burns, and atomic roundtrips do not appear as ordinary economic flow.

**Cache:** `CACHE_PROFILES.realtime` (~900s freshness with 15-min staleness window)

### POST /api/backfill-mint-burn-prices (admin)

Backfills `amount_usd` for events that were synced without price data. Requires Access service-token headers on `ops-api.pharos.watch`. 

Note: cron now auto-heals recent NULL-price events (48h lookback). This endpoint remains the operator tool for broader historical backfills.

1. Finds all `mint_burn_events` rows with `amount_usd IS NULL`.
2. Applies current price from `price_cache`: `amount_usd = amount * price`.
3. Deletes and re-aggregates all `mint_burn_hourly` rows for affected coins.

Returns: `{ totalUpdated, coins: [{ id, updated }] }`

### POST /api/backfill-mint-burn (admin)

Controlled ingestion backfill by explicit config/range/chunk, or by automatic config selection when `configKey` is omitted.

- Auth: Access service-token headers
- Idempotency: `Idempotency-Key` supported via admin idempotency middleware
- Parameters: `configKey`, `fromBlock`, `toBlock`, `chunkSize`, `maxChunks`
- Behavior:
  - If `configKey` is omitted, the worker auto-selects one Ethereum config using a critical-first / major-symbol-first / most-behind ordering and returns `selectionMode="auto"` plus the chosen `configKey`.
  - Uses the same shared parse/classification/context/persistence helpers as cron ingestion.
  - Advances `mint_burn_sync_state` with monotonic max semantics (never regresses on partial backfills).
  - Returns `done=false` with `nextFromBlock` when additional calls are needed.

### POST /api/reclassify-atomic-roundtrips (admin)

Retroactive cleanup endpoint for historical rows that predate shared roundtrip detection or were ingested before both sides of a transaction were visible to the detector.

- Auth: Access service-token headers
- Idempotency: `Idempotency-Key` supported via admin idempotency middleware
- Behavior:
  - Scans up to `1000` `(tx_hash, stablecoin_id)` groups per call where `flow_type='standard'` but both mint and burn directions exist.
  - Flips all matching rows in each group to `flow_type='atomic_roundtrip'`.
  - Recalculates the affected hourly buckets so downstream flow aggregates drop the reclassified rows immediately.
  - Returns `done=true` when no additional candidate groups remain.

---

## Frontend

### Page

**Route:** `/flows`
**File:** `src/app/flows/page.tsx`
**Layout:** `src/app/flows/layout.tsx`

Three sections:
1. **Hero Overview** — net-direction hero with the baseline-relative Bank Run Gauge, a literal 24h Minting Pressure gauge, and flight-to-quality badge. Headline copy is derived from aggregate `Net Flow 24h` direction plus the Bank Run Gauge pressure state; it does not imply cross-asset breadth unless a separate breadth signal is added.
2. **Per-Coin Flows** — sortable table with `Pressure vs 30D`, net 24h/7d, mint/burn volumes, largest event
3. **Aggregate Flows** — Recharts composed chart (mint area, burn area, net flow line) with 24h/7d/30d toggle

### Hooks

**File:** `src/hooks/use-mint-burn-flows.ts`

| Hook | Endpoint | Stale Time | Notes |
|------|----------|-----------|-------|
| `useMintBurnFlows(hours?)` | `/api/mint-burn-flows` | `CRON_20MIN` | Aggregate mode, no coin filter |
| `useMintBurnFlowsCoin(id, hours?)` | `/api/mint-burn-flows?stablecoin=` | `CRON_20MIN` | Per-coin mode, enabled only when ID truthy |
| `useMintBurnEvents(id, opts?)` | `/api/mint-burn-events?stablecoin=` | `CRON_20MIN` | Paginated event feed |

All hooks use Zod schema validation for aggregate and per-coin responses (`MintBurnFlowsResponseSchema`, `MintBurnPerCoinResponseSchema`).

### Components

| Component | File | Description |
|-----------|------|-------------|
| `FlowBrrrOverview` | `src/components/flow-brrr-overview.tsx` | Shared overview shell used by `/flows` and the homepage snapshot; renders the Bank Run Gauge band returned by the API plus the literal 24h minting-pressure gauge, with inline methodology help on the Bank Run Gauge label |
| `FlowChart` | `src/components/flow-chart.tsx` | Recharts composed chart: mint (green area), burn (red area), net flow (blue line), hourly tooltip |
| `FlowTable` | `src/components/flow-table.tsx` | Sortable per-coin table. Sort keys: net24h, mint24h, burn24h, net7d, largest, pressure. Responsive column hiding; `Pressure vs 30D` header uses the shared methodology-hint trigger |
| `FlowEventFeed` | `src/components/flow-event-feed.tsx` | Paginated event table: time, direction badge, amount USD, chain, tx link |
| `MintingPressureGauge` | `src/components/minting-pressure-gauge.tsx` | Shared literal 24h mint-vs-burn gauge used by both the aggregate overview and stablecoin detail summary cards |
| `HomepageFlowOverview` | `src/components/homepage-flow-overview.tsx` | Homepage snapshot wrapper: pulls 24h/7d aggregate flow data and renders the same net-direction hero used on `/flows`, including a headline keyed from aggregate net direction plus Bank Run Gauge pressure state, the Bank Run Gauge (pressure vs 30D), and the literal 24h Minting Pressure gauge |
| `FlowSummaryCard` | `src/components/flow-summary-card.tsx` | Summary card for stablecoin detail pages: explicit `Net 24h`, `Pressure Shift vs 30D`, and a literal `Minting Pressure (24h)` gauge, plus contextual methodology hints / footer links for the flow model |

### Dashboard Integration

`FlowSummaryCard` (`src/components/flow-summary-card.tsx`) now keys machine visuals from raw `netFlow24hUsd` and also renders the same literal `Minting Pressure (24h)` gauge used in the aggregate overview, while Bank Run Gauge band labels remain available for baseline-relative pressure semantics.

---

## Error Handling & Edge Cases

| Condition | Behavior |
|-----------|----------|
| Price unavailable at sync time | `amount_usd` stored as NULL initially; cron auto-heals recent rows (48h window) and admin endpoint handles older history |
| Fewer than 7 days of flow history | Pressure shift returns `null`; coin excluded from gauge weighting |
| No 24h mint/burn activity in a sparse window | Pressure shift returns `null` (NR) for that window; coin excluded from gauge weighting |
| All coins have null pressure shift | Gauge score returns `null`; frontend shows "Calibrating" state |
| Alchemy API error for a config | `apiErrors` incremented; sync state NOT advanced (retried next cycle) |
| Incomplete timestamp resolution | `configError = true`; sync state not advanced, retried next cycle |
| Subrequest budget exhausted | Remaining configs skipped; picked up in next cron cycle |
| Block explorer indexing lag | 75-block safety margin prevents advancing past un-indexed blocks |
| Duplicate events | `INSERT OR IGNORE` on deterministic `id` key prevents duplicates |
| Unknown stablecoin ID in per-coin API | Returns 404 with descriptive error |
| Missing `stablecoin` param in events API | Returns 400 |
| Partial-coverage cron run | Hourly aggregation rebuilds from all DB events for affected hours; buckets may be temporarily incomplete for configs still catching up |

### Circuit Breaker Separation

Blacklist and mint/burn have independent circuit breakers:

- **`CIRCUIT_SOURCE.ETHERSCAN`** — used by `sync-blacklist` (Etherscan REST API)
- **`CIRCUIT_SOURCE.ALCHEMY`** — used by `sync-mint-burn` (Alchemy JSON-RPC)

An Alchemy outage does not block blacklist sync, and vice versa. Each circuit breaker opens after consecutive failures and probes independently.

---

## Testing

**Files:**
- `worker/src/lib/__tests__/mint-burn-scoring.test.ts` — pressure-shift formula, gauge bands, composite gauge, flight-to-quality
- `worker/src/lib/__tests__/mint-burn-pipeline.test.ts` — shared parse/classification/persistence/sync-state behavior parity
- `worker/src/cron/__tests__/sync-mint-burn.test.ts` — cron ingestion orchestration and degraded-mode handling
- `worker/src/api/__tests__/backfill-mint-burn.test.ts` — admin backfill chunking, `done/nextFromBlock`, and sync-state progression
- `worker/src/api/__tests__/mint-burn-flows.test.ts` — API response shape validation plus burning/improving regression coverage
- `shared/lib/__tests__/mint-burn-signals.test.ts` — shared direction/pressure/composite interpretation coverage

**Coverage:**
- Pressure shift: null for < 7 days, neutral at baseline, clamping at 0/100, floor denominator
- Gauge bands: correct band for all score ranges
- Composite gauge: mcap-weighted average, skips null, returns null when all null
- Flight-to-quality: $100M activation, intensity formula, edge cases
- Pipeline convergence: inserted-vs-ignored accounting, bridge/effective/review burn counters, affected-hour recomputation, sync-state mode semantics
- Backfill chunking: `done=false` and `nextFromBlock` emitted when `maxChunks` stops before target range
- API: aggregate vs per-coin response shapes against Zod schemas, 404 for unknown coin
- Coverage/freshness: aggregate `hours` leaves 24h coin fields unchanged, current UTC day excluded from baseline, deterministic largest-event selection on ties

---

## Future Work

Current production scope is Ethereum-only ingestion. Planned expansions:

- **Additional EVM chains:** add contract configs + chain-specific scan policies after reliability gates are met
- **Tron support:** USDT Issue/Redeem topic groundwork exists; ingestion path is not wired yet
- **Curve Finance detection:** DEX-level flow tracking

---

## File Index

| File | Role |
|------|------|
| `worker/src/cron/sync-mint-burn.ts` | Cron job: critical + extended incremental event sync lanes, hourly aggregation, lane-specific run-state |
| `worker/src/lib/mint-burn-pipeline/types.ts` | Shared ingestion types for cron/backfill |
| `worker/src/lib/mint-burn-pipeline/parse.ts` | Shared log parsing and price resolution |
| `worker/src/lib/mint-burn-pipeline/roundtrip-detection.ts` | Shared same-transaction roundtrip tagging |
| `worker/src/lib/mint-burn-pipeline/classification.ts` | Shared bridge-burn classification |
| `worker/src/lib/mint-burn-pipeline/context.ts` | Shared current/historical price context loaders |
| `worker/src/lib/mint-burn-pipeline/persistence.ts` | Shared event write + hourly recompute helpers |
| `worker/src/lib/mint-burn-pipeline/price-heal.ts` | Shared NULL-price auto-heal helper |
| `worker/src/lib/mint-burn-pipeline/roundtrip-sweep.ts` | Post-cron sweep for cross-run atomic roundtrip detection |
| `worker/src/lib/mint-burn-pipeline/sync-state.ts` | Shared sync-state read/init/upsert helpers |
| `worker/src/lib/mint-burn-contracts.ts` | Mint/burn event configs resolved from shared stablecoin contracts, plus explicit override addresses for special vault events |
| `worker/src/lib/mint-burn-scoring.ts` | Pure scoring functions: pressure shift (FIS), gauge, flight-to-quality |
| `worker/src/api/mint-burn-flows.ts` | API handler: route-level aggregate + per-coin orchestration |
| `worker/src/api/mint-burn-flows-shared.ts` | Shared mint/burn cache fallback, cron snapshot, baseline, and coverage helpers |
| `worker/src/api/mint-burn-events.ts` | API handler: paginated event feed |
| `worker/src/api/backfill-mint-burn.ts` | Admin endpoint: controlled event ingestion backfill |
| `worker/src/api/backfill-mint-burn-prices.ts` | Admin endpoint: backfill NULL amount_usd values |
| `worker/src/api/reclassify-atomic-roundtrips.ts` | Admin endpoint: retroactively tag same-tx mint/burn rows as atomic roundtrips |
| `worker/migrations/0031a_mint_burn_v2.sql` | Database schema (3 tables) |
| `src/hooks/use-mint-burn-flows.ts` | TanStack Query hooks (3 hooks) |
| `src/app/flows/page.tsx` | Frontend page |
| `src/app/flows/layout.tsx` | Page metadata/layout |
| `worker/src/lib/mint-burn-scoring.ts` | Pure Flow Intensity / Bank Run Gauge / flight-to-quality logic (`getGaugeBand`, `computeGaugeScore`, `detectFlightToQuality`) |
| `src/components/flow-brrr-overview.tsx` | Shared Bank Run Gauge overview shell for `/flows` and homepage snapshot |
| `src/components/flow-chart.tsx` | Recharts flow chart |
| `src/components/flow-table.tsx` | Sortable per-coin table |
| `src/components/flow-event-feed.tsx` | Paginated event table |
| `src/components/minting-pressure-gauge.tsx` | Shared literal 24h mint-vs-burn gauge |
| `src/components/flow-summary-card.tsx` | Summary card for detail pages |
| `shared/lib/mint-burn-signals.ts` | Shared net-direction + pressure-state interpretation helpers |
| `shared/types/index.ts` | TypeScript types + Zod schemas |
| `worker/src/lib/__tests__/mint-burn-scoring.test.ts` | Scoring unit tests |
| `worker/src/lib/__tests__/mint-burn-pipeline.test.ts` | Shared ingestion pipeline tests |
| `worker/src/cron/__tests__/sync-mint-burn.test.ts` | Cron ingestion tests |
| `worker/src/api/__tests__/backfill-mint-burn.test.ts` | Backfill ingestion tests |
| `worker/src/api/__tests__/mint-burn-flows.test.ts` | API contract tests |
