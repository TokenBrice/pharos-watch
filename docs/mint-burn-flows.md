# Mint/Burn Flow Tracker

On-chain mint and burn event tracker for stablecoins on **Ethereum** via Alchemy JSON-RPC. Detects Transfer events (and USDT-specific Issue/Redeem events), aggregates them into hourly flow buckets, computes per-coin Flow Intensity Scores, a market-cap-weighted Bank Run Gauge, and flight-to-quality signals. Runs every 20 minutes, incrementally scanning from the last processed block.

Operational freshness configuration is shared via `worker/src/lib/mint-burn-health-config.ts`:
- major-symbol baseline (`USDT`, `USDC`, `DAI`, `USDS`, `GHO`, `FRXUSD`, `BOLD`, `reUSD`)
- warning threshold (`6h`)
- critical threshold (`24h`)

Scheduled/http handlers apply env overrides on top of these defaults (`worker/src/handlers/scheduled.ts`, `worker/src/handlers/http.ts`), and `/api/health` uses the same resolved config for status evaluation.

---

## Methodology Versioning

- **Current methodology version:** `v4.3`
- **Public changelog page:** `/methodology/mint-burn-flow-changelog/`
- **Internal reconstructed timeline:** `docs/mint-burn-flows-timeline.md`

---

## Cron Schedule

- **Pattern:** `3,23,43 * * * *` (every 20 minutes, offset at :03/:23/:43)
- **Shares slot with:** `sync-blacklist` (independent providers — Alchemy for mint/burn, Etherscan for blacklist)
- **Function:** `syncMintBurn(db, alchemyApiKey)`
- **Provider:** Alchemy JSON-RPC (PAYG plan)
- **File:** `worker/src/cron/sync-mint-burn.ts`
- **Registration:** cron declared in `worker/wrangler.toml`, executed via `worker/src/handlers/scheduled.ts`
- **Returns:** `{ itemCount, status, metadata }` where `itemCount = rowsInserted` (not parsed rows)
- **Operator runbook:** `agents/runbooks/mint-burn-ingestion.md`

---

## Constants & Thresholds

| Constant | Value | Purpose |
|----------|-------|---------|
| `dustThreshold` | 10,000 default (token-native); 10 for gold tokens | Events below this amount are discarded |
| `INDEXING_SAFETY_SEC` | 900 (15 min) | Safety margin when advancing sync state to chain head |
| `ETHEREUM_BLOCK_TIME_SEC` | 12 sec | Approximate Ethereum block time (yields ~75-block safety margin) |
| `DENOM_SCALE` | 0.3 | FIS denominator = 30% of baseline daily absolute flow |
| `DENOM_FLOOR` | $1,000,000 | Minimum FIS denominator |
| `Z_MULTIPLIER` | 50 | Z-score amplification in FIS formula |
| Flow intensity clamp range | -100 to +100 | Signed Flow Intensity Score output range |
| `MIN_DATA_DAYS` | 7 | Days of history required before FIS returns a value |
| `FTQ_THRESHOLD` | $100,000,000 | Minimum net flow (both sides) to trigger flight-to-quality |
| `ETHEREUM_SCAN_RANGE` | 50K (Ethereum) | Max block range per contract per cycle |
| `startBlock` | per-config (non-uniform) | Each contract config has its own start block |
| Subrequest budget | 200 per cron run | Global Alchemy API call budget |
| Config tier policy | `critical` / `extended` | Under budget pressure, extended configs can be deferred deterministically |

---

## Contract Configurations

**File:** `worker/src/lib/mint-burn-contracts.ts`

### Tracked Stablecoins

Current scope: **84 contract configs** across **81 symbols** (81 transfer-only ERC-20 configs + 1 USDT mixed-event config + 2 reUSD custom-event configs).

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
| EURA | eura-angle | 18 | Extended | Transfer |
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

Safe haven IDs (`SAFE_HAVEN_IDS`): 1, 2, 119, 120 — fallback for flight-to-quality detection when report card grades are unavailable or stale (>2h). The preferred approach is grade-based classification from report card scores.

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

**reUSD special handling:** Re Protocol vault contracts emit custom deposit/redeem events instead of standard mint/burn Transfers. Deposits are decoded from `Deposited(address,address,uint256)` (`dataSlot=2`, 6-decimal collateral amount), and burns from `InstantRedemptionProcessed(address,uint256,uint256)` (`first-data-uint256`, 18-decimal shares burned).

---

## Sync Algorithm

1. **Load sync state** — batch query `mint_burn_sync_state` for all configured contract keys. Falls back to `startBlock - 1` for new configs.
2. **Apply runtime policy** — filter disabled configs (`MINT_BURN_DISABLED_IDS`, `MINT_BURN_DISABLED_SYMBOLS`), rotate start index from persisted run-state, and assign per-chain budget quotas.
3. **Get chain head** — Alchemy `eth_blockNumber` call per chain (cached per chain ID).
4. **Load price cache** — query `price_cache` for all tracked stablecoin IDs (used for USD conversion).
5. **For each contract config:**
   - Skip if `fromBlock > chainHead` or subrequest budget exhausted.
   - For each event definition, call Alchemy `eth_getLogs` with adaptive recursive block-range splitting on provider/range failures.
   - Resolve block timestamps — batch `eth_getBlockByNumber` for all unique blocks in the returned logs, using local + persistent (`block_timestamp_cache`) caches.
   - Parse logs: decode amount (respecting decimals), derive counterparty address, compute `amount_usd = amount * price` (null if no price).
   - Filter out dust events (amount < `dustThreshold`).
   - Batch `INSERT OR IGNORE` into `mint_burn_events`, track parsed vs inserted counts from D1 `meta.changes`.
   - Update `mint_burn_sync_state.last_block`:
     - If events found: advance to `maxBlockSeen`.
     - If no events: advance to `chainHead - safetyMarginBlocks` (avoids skipping not-yet-indexed events).
6. **Recalculate affected hourly buckets** — for each unique `(stablecoinId, chainId, hourTs)` touched, `INSERT OR REPLACE` into `mint_burn_hourly` by re-aggregating from `mint_burn_events`.
7. **Escalate degraded runs** — emit `status=degraded|error` when sustained coverage/API thresholds are breached, with streak tracking in `mint_burn_run_state`.

**Counterparty resolution:** For mints, `topics[2]` (recipient). For burns, `topics[1]` (sender).

**Event ID format:** `"{chainId}-{txHash}-{logIndex}"` — deterministic, prevents duplicates via `INSERT OR IGNORE`.

---

## Shared Ingestion Pipeline Boundaries

Cron (`sync-mint-burn`) and admin backfill (`backfill-mint-burn`) now share a single ingestion pipeline under `worker/src/lib/mint-burn-pipeline/`.

| Module | Responsibility |
|--------|----------------|
| `types.ts` | Shared ingestion row/context/counter types and sync-state mode union |
| `parse.ts` | `parseMintBurnLogs()` and event-level price resolution (`supply-history` then `price_cache` fallback) |
| `classification.ts` | Bridge-aware burn classification and transaction-context loading |
| `context.ts` | Shared loaders for current prices and historical price series |
| `persistence.ts` | `INSERT OR IGNORE` event writes, burn classification updates, affected-hour aggregation |
| `sync-state.ts` | Sync-state key helpers plus mode-specific upserts (`replace` for cron, `monotonic-max` for backfill) |

Implementation invariant: `worker/src/api/backfill-mint-burn.ts` does not import from `worker/src/cron/sync-mint-burn.ts`; both entrypoints import shared helpers from `mint-burn-pipeline/*`.

---

## Scoring

**File:** `worker/src/lib/mint-burn-scoring.ts`

### Flow Intensity Score (FIS)

Per-coin score measuring how unusual current flows are relative to the 30-day baseline. Runs server-side in the `/api/mint-burn-flows` aggregate handler.

```
denominator = max(baselineDailyAbs * 0.3, $1M)
z = (currentDailyNet - baselineDailyNet) / denominator
intensity = clamp(-100, 100, z * 50)
```

- **Input:** 24h net flow, 30-day rolling average net flow, 30-day rolling average absolute flow, data age in days.
- **Output:** -100 to +100 score, or `null` (NR) if fewer than 7 days of history or if the coin has no 24h mint/burn activity.
- Score of 0 = current flow matches baseline. Negative values = net burns above baseline. Positive values = net mints above baseline.

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

Market-cap-weighted average of individual FIS scores:

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
  counterparty TEXT,                   -- Address that received/sent tokens
  tx_hash TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,          -- Unix seconds
  explorer_tx_url TEXT NOT NULL
);

CREATE INDEX idx_mbe2_ts ON mint_burn_events(timestamp DESC);
CREATE INDEX idx_mbe2_coin ON mint_burn_events(stablecoin_id, timestamp DESC);
CREATE INDEX idx_mbe2_chain ON mint_burn_events(chain_id, timestamp DESC);
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
- `coins[]` — per-coin summaries: FIS, net 24h/7d, mint/burn volumes, largest event
- `hourly[]` — aggregate hourly timeseries: `{ hourTs, netFlowUsd, mintVolumeUsd, burnVolumeUsd }`
- `updatedAt` — Unix seconds of latest hourly bucket

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

Returns 404 if the stablecoin ID is not in the tracked set.

**Cache:** `CACHE_PROFILES.standard` (~300s freshness)

### GET /api/mint-burn-events

Paginated event feed for a single stablecoin.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `stablecoin` | string | — | Stablecoin ID (required) |
| `direction` | string | — | Filter: `"mint"` or `"burn"` |
| `chain` | string | — | Filter by chain ID |
| `minAmount` | number | — | Minimum USD amount (uses `COALESCE(amount_usd, amount)`) |
| `limit` | int | 50 | Page size, 1–500 |
| `offset` | int | 0 | Pagination offset |

Returns: `{ events[], total }`. Events sorted by `timestamp DESC`.

**Cache:** `CACHE_PROFILES.realtime` (~900s freshness with 15-min staleness window)

### POST /api/backfill-mint-burn-prices (admin)

Backfills `amount_usd` for events that were synced without price data. Requires `X-Admin-Key` header.

1. Finds all `mint_burn_events` rows with `amount_usd IS NULL`.
2. Applies current price from `price_cache`: `amount_usd = amount * price`.
3. Deletes and re-aggregates all `mint_burn_hourly` rows for affected coins.

Returns: `{ totalUpdated, coins: [{ id, updated }] }`

### POST /api/backfill-mint-burn (admin)

Controlled ingestion backfill by explicit config/range/chunk.

- Auth: `X-Admin-Key`
- Idempotency: `Idempotency-Key` supported via admin idempotency middleware
- Parameters: `configKey`, `fromBlock`, `toBlock`, `chunkSize`, `maxChunks`
- Behavior:
  - Uses the same shared parse/classification/context/persistence helpers as cron ingestion.
  - Advances `mint_burn_sync_state` with monotonic max semantics (never regresses on partial backfills).
  - Returns `done=false` with `nextFromBlock` when additional calls are needed.

---

## Frontend

### Page

**Route:** `/flows`
**File:** `src/app/flows/page.tsx`
**Layout:** `src/app/flows/layout.tsx`

Three sections:
1. **Bank Run Gauge** — hero semicircle gauge with needle, band label, flight-to-quality badge
2. **Per-Coin Flows** — sortable table with FIS bar, net 24h/7d, mint/burn volumes, largest event
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
| `GAUGE_BANDS` | `src/components/flow-gauge.tsx` | Shared Flow Intensity band config map (label, hex, Tailwind text/bg classes) consumed by flow summary UI |
| `FlowChart` | `src/components/flow-chart.tsx` | Recharts composed chart: mint (green area), burn (red area), net flow (blue line), hourly tooltip |
| `FlowTable` | `src/components/flow-table.tsx` | Sortable per-coin table. Sort keys: net24h, mint24h, burn24h, net7d, largest, fis. Responsive column hiding |
| `FlowEventFeed` | `src/components/flow-event-feed.tsx` | Paginated event table: time, direction badge, amount USD, chain, tx link |
| `HomepageFlowOverview` | `src/components/homepage-flow-overview.tsx` | Homepage snapshot wrapper: pulls 24h/7d aggregate flow data and renders the same printer/shredder scene used on `/flows` |
| `FlowSummaryCard` | `src/components/flow-summary-card.tsx` | Summary card for stablecoin detail pages: FIS, net 24h/7d, mint/burn volumes |

### Dashboard Integration

`FlowSummaryCard` (`src/components/flow-summary-card.tsx`) imports `GAUGE_BANDS` to keep Flow Intensity label/color semantics consistent with worker gauge band scoring.

---

## Error Handling & Edge Cases

| Condition | Behavior |
|-----------|----------|
| Price unavailable at sync time | `amount_usd` stored as NULL; backfillable via admin endpoint |
| Fewer than 7 days of flow history | FIS returns `null`; coin excluded from gauge weighting |
| No 24h mint/burn activity in a sparse window | FIS returns `null` (NR) for that window; coin excluded from gauge weighting |
| All coins have null FIS | Gauge score returns `null`; frontend shows "Calibrating" state |
| Alchemy API error for a config | `apiErrors` incremented; sync state NOT advanced (retried next cycle) |
| Incomplete timestamp resolution | `configError = true`; sync state not advanced, retried next cycle |
| Subrequest budget exhausted | Remaining configs skipped; picked up in next cron cycle |
| Block explorer indexing lag | 75-block safety margin prevents advancing past un-indexed blocks |
| Duplicate events | `INSERT OR IGNORE` on deterministic `id` key prevents duplicates |
| Unknown stablecoin ID in per-coin API | Returns 404 with descriptive error |
| Missing `stablecoin` param in events API | Returns 400 |

### Circuit Breaker Separation

Blacklist and mint/burn have independent circuit breakers:

- **`CIRCUIT_SOURCE.ETHERSCAN`** — used by `sync-blacklist` (Etherscan REST API)
- **`CIRCUIT_SOURCE.ALCHEMY`** — used by `sync-mint-burn` (Alchemy JSON-RPC)

An Alchemy outage does not block blacklist sync, and vice versa. Each circuit breaker opens after consecutive failures and probes independently.

---

## Testing

**Files:**
- `worker/src/lib/__tests__/mint-burn-scoring.test.ts` — FIS, gauge bands, composite gauge, flight-to-quality
- `worker/src/lib/__tests__/mint-burn-pipeline.test.ts` — shared parse/classification/persistence/sync-state behavior parity
- `worker/src/cron/__tests__/sync-mint-burn.test.ts` — cron ingestion orchestration and degraded-mode handling
- `worker/src/api/__tests__/backfill-mint-burn.test.ts` — admin backfill chunking, `done/nextFromBlock`, and sync-state progression
- `worker/src/api/__tests__/mint-burn-flows.test.ts` — API response shape validation (aggregate vs per-coin)

**Coverage:**
- FIS: null for < 7 days, neutral at baseline, clamping at 0/100, floor denominator
- Gauge bands: correct band for all score ranges
- Composite gauge: mcap-weighted average, skips null, returns null when all null
- Flight-to-quality: $100M activation, intensity formula, edge cases
- Pipeline convergence: inserted-vs-ignored accounting, bridge/effective/review burn counters, affected-hour recomputation, sync-state mode semantics
- Backfill chunking: `done=false` and `nextFromBlock` emitted when `maxChunks` stops before target range
- API: aggregate vs per-coin response shapes against Zod schemas, 404 for unknown coin

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
| `worker/src/cron/sync-mint-burn.ts` | Cron job: incremental event sync + hourly aggregation |
| `worker/src/lib/mint-burn-pipeline/types.ts` | Shared ingestion types for cron/backfill |
| `worker/src/lib/mint-burn-pipeline/parse.ts` | Shared log parsing and price resolution |
| `worker/src/lib/mint-burn-pipeline/classification.ts` | Shared bridge-burn classification |
| `worker/src/lib/mint-burn-pipeline/context.ts` | Shared current/historical price context loaders |
| `worker/src/lib/mint-burn-pipeline/persistence.ts` | Shared event write + hourly recompute helpers |
| `worker/src/lib/mint-burn-pipeline/sync-state.ts` | Shared sync-state read/init/upsert helpers |
| `worker/src/lib/mint-burn-contracts.ts` | Contract configs, event definitions, safe haven IDs |
| `worker/src/lib/mint-burn-scoring.ts` | Pure scoring functions: FIS, gauge, flight-to-quality |
| `worker/src/api/mint-burn-flows.ts` | API handler: aggregate + per-coin flow data |
| `worker/src/api/mint-burn-events.ts` | API handler: paginated event feed |
| `worker/src/api/backfill-mint-burn.ts` | Admin endpoint: controlled event ingestion backfill |
| `worker/src/api/backfill-mint-burn-prices.ts` | Admin endpoint: backfill NULL amount_usd values |
| `worker/migrations/0031a_mint_burn_v2.sql` | Database schema (3 tables) |
| `src/hooks/use-mint-burn-flows.ts` | TanStack Query hooks (3 hooks) |
| `src/app/flows/page.tsx` | Frontend page |
| `src/app/flows/layout.tsx` | Page metadata/layout |
| `src/components/flow-gauge.tsx` | Shared Flow Intensity band config map |
| `src/components/flow-chart.tsx` | Recharts flow chart |
| `src/components/flow-table.tsx` | Sortable per-coin table |
| `src/components/flow-event-feed.tsx` | Paginated event table |
| `src/components/flow-summary-card.tsx` | Summary card for detail pages |
| `shared/types/index.ts` | TypeScript types + Zod schemas |
| `worker/src/lib/__tests__/mint-burn-scoring.test.ts` | Scoring unit tests |
| `worker/src/lib/__tests__/mint-burn-pipeline.test.ts` | Shared ingestion pipeline tests |
| `worker/src/cron/__tests__/sync-mint-burn.test.ts` | Cron ingestion tests |
| `worker/src/api/__tests__/backfill-mint-burn.test.ts` | Backfill ingestion tests |
| `worker/src/api/__tests__/mint-burn-flows.test.ts` | API contract tests |
