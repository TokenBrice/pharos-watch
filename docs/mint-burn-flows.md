# Mint/Burn Flow Tracker

On-chain mint and burn event tracker for stablecoins across multiple EVM chains via Alchemy JSON-RPC. Detects Transfer events (and USDT-specific Issue/Redeem events), aggregates them into hourly flow buckets, computes per-coin Flow Intensity Scores, a market-cap-weighted Bank Run Gauge, and flight-to-quality signals. Runs every 20 minutes, incrementally scanning from the last processed block.

---

## Cron Schedule

- **Pattern:** `3,23,43 * * * *` (every 20 minutes, offset at :03/:23/:43)
- **Shares slot with:** `sync-blacklist` (independent providers — Alchemy for mint/burn, Etherscan for blacklist)
- **Function:** `syncMintBurn(db, alchemyApiKey)`
- **Provider:** Alchemy JSON-RPC (PAYG plan)
- **File:** `worker/src/cron/sync-mint-burn.ts`
- **Registration:** `worker/src/index.ts` (line 231)
- **Returns:** `{ itemCount, metadata: JSON { contractsProcessed, contractsSkipped, apiErrors } }`

---

## Constants & Thresholds

| Constant | Value | Purpose |
|----------|-------|---------|
| `dustThreshold` | 10,000 (token-native) | Events below this amount are discarded |
| `INDEXING_SAFETY_SEC` | 900 (15 min) | Safety margin when advancing sync state to chain head |
| `ETH_BLOCK_TIME` | 12 sec | Approximate Ethereum block time (yields ~75-block safety margin) |
| `DENOM_SCALE` | 0.3 | FIS denominator = 30% of baseline daily absolute flow |
| `DENOM_FLOOR` | $1,000,000 | Minimum FIS denominator |
| `Z_MULTIPLIER` | 25 | Z-score amplification in FIS formula |
| `NEUTRAL` | 50 | Neutral Flow Intensity Score |
| `MIN_DATA_DAYS` | 7 | Days of history required before FIS returns a value |
| `FTQ_THRESHOLD` | $100,000,000 | Minimum net flow (both sides) to trigger flight-to-quality |
| `CHAIN_SCAN_RANGE` | 50K (ETH/ARB/BASE/OPT), 10K (AVAX), 2K (Polygon) | Max block range per contract per cycle (per-chain Alchemy limits) |
| `startBlock` | 21,900,000 | All 10 contracts start scanning from this Ethereum block |
| Subrequest budget | 200 per cron run | Alchemy API call budget |

---

## Contract Configurations

**File:** `worker/src/lib/mint-burn-contracts.ts`

### Tracked Stablecoins

| Symbol | ID | Decimals | Category | Events |
|--------|----|----------|----------|--------|
| USDT | 1 | 6 | Safe haven | Transfer + Issue/Redeem |
| USDC | 2 | 6 | Safe haven | Transfer |
| FDUSD | 119 | 18 | Safe haven | Transfer |
| PYUSD | 120 | 6 | Safe haven | Transfer |
| DAI | 5 | 18 | Risky | Transfer |
| GHO | 118 | 18 | Risky | Transfer |
| USDe | 146 | 18 | Risky | Transfer |
| USDS | 209 | 18 | Risky | Transfer |
| FRXUSD | 235 | 18 | Risky | Transfer |
| BOLD | 269 | 18 | Risky | Transfer |

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

---

## Sync Algorithm

1. **Load sync state** — batch query `mint_burn_sync_state` for all 10 contract config keys. Falls back to `startBlock - 1` for new configs.
2. **Get chain head** — Alchemy `eth_blockNumber` call per chain (cached per chain ID).
3. **Load price cache** — query `price_cache` for all tracked stablecoin IDs (used for USD conversion).
4. **For each contract config:**
   - Skip if `fromBlock > chainHead` or subrequest budget exhausted.
   - For each event definition, call Alchemy `eth_getLogs` with compound topic filters.
   - Resolve block timestamps — batch `eth_getBlockByNumber` for all unique blocks in the returned logs.
   - Parse logs: decode amount (respecting decimals), derive counterparty address, compute `amount_usd = amount * price` (null if no price).
   - Filter out dust events (amount < `dustThreshold`).
   - Batch `INSERT OR IGNORE` into `mint_burn_events`.
   - Update `mint_burn_sync_state.last_block`:
     - If events found: advance to `maxBlockSeen`.
     - If no events: advance to `chainHead - safetyMarginBlocks` (avoids skipping not-yet-indexed events).
5. **Recalculate affected hourly buckets** — for each unique `(stablecoinId, chainId, hourTs)` touched, `INSERT OR REPLACE` into `mint_burn_hourly` by re-aggregating from `mint_burn_events`.

**Counterparty resolution:** For mints, `topics[2]` (recipient). For burns, `topics[1]` (sender).

**Event ID format:** `"{chainId}-{txHash}-{logIndex}"` — deterministic, prevents duplicates via `INSERT OR IGNORE`.

---

## Scoring

**File:** `worker/src/lib/mint-burn-scoring.ts`

### Flow Intensity Score (FIS)

Per-coin score measuring how unusual current flows are relative to the 30-day baseline. Runs server-side in the `/api/mint-burn-flows` aggregate handler.

```
denominator = max(baselineDailyAbs * 0.3, $1M)
z = (currentDailyNet - baselineDailyNet) / denominator
intensity = clamp(0, 100, 50 + z * 25)
```

- **Input:** 24h net flow, 30-day rolling average net flow, 30-day rolling average absolute flow, data age in days.
- **Output:** 0–100 score, or `null` if fewer than 7 days of history.
- Score of 50 = current flow matches baseline. Below 50 = net burns above baseline. Above 50 = net mints above baseline.

### Gauge Bands

| Band | Range | Color | Meaning |
|------|-------|-------|---------|
| CRISIS | 0–15 | red | Massive redemption pressure |
| STRESS | 15–30 | orange | Heavy redemptions |
| CAUTIOUS | 30–45 | amber | Elevated burns |
| NEUTRAL | 45–55 | gray | Balanced mint/burn |
| HEALTHY | 55–70 | light-green | Net minting |
| CONFIDENT | 70–85 | green | Strong demand |
| SURGE | 85–100 | bright-green | Extreme minting demand |

Boundary convention: each band is `[min, max)`. The last band includes 100.

### Bank Run Gauge (Composite)

Market-cap-weighted average of individual FIS scores:

```
gauge_score = Σ(intensity_i * mcap_i) / Σ(mcap_i)
```

- Skips coins with `null` intensity (insufficient data).
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

### GET /api/backfill-mint-burn-prices (admin)

Backfills `amount_usd` for events that were synced without price data. Requires `X-Admin-Key` header.

1. Finds all `mint_burn_events` rows with `amount_usd IS NULL`.
2. Applies current price from `price_cache`: `amount_usd = amount * price`.
3. Deletes and re-aggregates all `mint_burn_hourly` rows for affected coins.

Returns: `{ totalUpdated, coins: [{ id, updated }] }`

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
| `FlowGauge` | `src/components/flow-gauge.tsx` | Semicircle gauge (180-degree arc), 7 colored segments, animated needle, calibrating/loading states, flight-to-quality badge |
| `FlowGaugeMini` | `src/components/flow-gauge-mini.tsx` | Compact gauge for KPI bar: score + colored dot + band label |
| `FlowChart` | `src/components/flow-chart.tsx` | Recharts composed chart: mint (green area), burn (red area), net flow (blue line), hourly tooltip |
| `FlowTable` | `src/components/flow-table.tsx` | Sortable per-coin table. Sort keys: net24h, mint24h, burn24h, net7d, largest, fis. Responsive column hiding |
| `FlowEventFeed` | `src/components/flow-event-feed.tsx` | Paginated event table: time, direction badge, amount USD, chain, tx link |
| `FlowSummaryCard` | `src/components/flow-summary-card.tsx` | Summary card for stablecoin detail pages: FIS, net 24h/7d, mint/burn volumes |

### Dashboard Integration

`FlowGaugeMini` appears as the 6th cell in the `KpiBar` component (`src/components/kpi-bar.tsx`) on the homepage, showing the composite gauge score and net 24h flow alongside PSI, mcap, DEX volume, and peg status.

---

## Error Handling & Edge Cases

| Condition | Behavior |
|-----------|----------|
| Price unavailable at sync time | `amount_usd` stored as NULL; backfillable via admin endpoint |
| Fewer than 7 days of flow history | FIS returns `null`; coin excluded from gauge weighting |
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
- `worker/src/api/__tests__/mint-burn-flows.test.ts` — API response shape validation (aggregate vs per-coin)

**Coverage:**
- FIS: null for < 7 days, neutral at baseline, clamping at 0/100, floor denominator
- Gauge bands: correct band for all score ranges
- Composite gauge: mcap-weighted average, skips null, returns null when all null
- Flight-to-quality: $100M activation, intensity formula, edge cases
- API: aggregate vs per-coin response shapes against Zod schemas, 404 for unknown coin

---

## Future Work

Multi-chain EVM support (Ethereum, Arbitrum, Base, Optimism, Avalanche) is implemented via Alchemy JSON-RPC. Remaining items:

- **Tron support:** USDT Issue/Redeem topic hashes already defined in `mint-burn-contracts.ts`
- **Polygon:** Alchemy supports it (2K block range limit), but no contract configs use it yet
- **Curve Finance detection:** DEX-level flow tracking

---

## File Index

| File | Role |
|------|------|
| `worker/src/cron/sync-mint-burn.ts` | Cron job: incremental event sync + hourly aggregation |
| `worker/src/lib/mint-burn-contracts.ts` | Contract configs, event definitions, safe haven IDs |
| `worker/src/lib/mint-burn-scoring.ts` | Pure scoring functions: FIS, gauge, flight-to-quality |
| `worker/src/api/mint-burn-flows.ts` | API handler: aggregate + per-coin flow data |
| `worker/src/api/mint-burn-events.ts` | API handler: paginated event feed |
| `worker/src/api/backfill-mint-burn-prices.ts` | Admin endpoint: backfill NULL amount_usd values |
| `worker/migrations/0031_mint_burn_v2.sql` | Database schema (3 tables) |
| `src/hooks/use-mint-burn-flows.ts` | TanStack Query hooks (3 hooks) |
| `src/app/flows/page.tsx` | Frontend page |
| `src/app/flows/layout.tsx` | Page metadata/layout |
| `src/components/flow-gauge.tsx` | Semicircle gauge component |
| `src/components/flow-gauge-mini.tsx` | Compact gauge for KPI bar |
| `src/components/flow-chart.tsx` | Recharts flow chart |
| `src/components/flow-table.tsx` | Sortable per-coin table |
| `src/components/flow-event-feed.tsx` | Paginated event table |
| `src/components/flow-summary-card.tsx` | Summary card for detail pages |
| `src/lib/types.ts` (lines 719–806) | TypeScript types + Zod schemas |
| `worker/src/lib/__tests__/mint-burn-scoring.test.ts` | Scoring unit tests |
| `worker/src/api/__tests__/mint-burn-flows.test.ts` | API contract tests |
