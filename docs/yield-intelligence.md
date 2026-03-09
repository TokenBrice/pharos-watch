# Yield Intelligence

Risk-adjusted yield tracking and ranking for yield-bearing stablecoins. Computes APY from three sources (direct on-chain reads, DeFiLlama, price history), scores each coin via the Pharos Yield Score (PYS), and serves a dedicated `/yield` page with scatter plot and leaderboard.

---

## Tracked Coins

Every stablecoin with `flags.yieldBearing: true` in `shared/lib/stablecoins.ts` enters the yield pipeline. The sync also supports deterministic custom sources for select non-yield-bearing coins, plus automatic lending pool discovery for tracked non-gold/silver stablecoins rated C- or above (safety score >= 50), including coins already flagged `yieldBearing`. `yieldConfig` is used when present to provide canonical source/type labels; auto-discovered lending rows can synthesize these labels when config is absent.

| Field         | Type        | Description                                                                                   |
| ------------- | ----------- | --------------------------------------------------------------------------------------------- |
| `yieldSource` | `string`    | Human-readable source name (e.g. "Ethena staking"). Optional for auto-discovered lending rows |
| `yieldType`   | `YieldType` | Mechanism classification (see below). Optional for auto-discovered lending rows               |

### Yield Types

| Type                  | Label        | Description                                                    |
| --------------------- | ------------ | -------------------------------------------------------------- |
| `lending-vault`       | Lending      | Deposited into lending protocols or vault strategies           |
| `rebase`              | Rebase       | Token supply rebases to distribute yield                       |
| `fee-sharing`         | Fee Share    | Protocol fees passed to holders                                |
| `lp-receipt`          | LP Receipt   | LP position wrapped as stablecoin                              |
| `nav-appreciation`    | NAV          | Token price appreciates as backing grows                       |
| `governance-set`      | Gov. Set     | Yield rate set by governance vote                              |
| `lending-opportunity` | Lending Opp. | Auto-discovered best lending market from the curated allowlist |

Labels and styles are centralized in `shared/lib/classification.ts` (`YIELD_TYPE_LABELS`, `YIELD_TYPE_STYLES`), both typed as `Record<YieldType, ...>` so adding a new variant without updating the maps is a compile error.

---

## Three-Tier APY Resolution

The sync cron resolves APY for each coin using a priority-ordered strategy. Tier 1 runs first, Tier 2 still runs afterward to collect additional DeFiLlama source rows, and Tier 3 runs only when neither Tier 1 nor Tier 2 produced any source.

### Tier 1: On-Chain Reads

Reads protocol state directly via `eth_call` RPC. The main path reads vault exchange rates and computes APY from the 7-day rate delta; special-case estimators can also derive APR from raw protocol state.

**Config:** `ON_CHAIN_RATE_CONFIGS` in `worker/src/cron/yield-config.ts`

```ts
interface OnChainRateConfig {
  stablecoinId: string;
  chain: string;
  contract: string; // vault contract address
  selector: string; // 4-byte function selector
  decimals: number;
  inputAmount: string; // hex-encoded input (e.g. 1e18)
}
```

Currently configured for sUSDe only in `ON_CHAIN_RATE_CONFIGS` (contract `0x9D39...7497`, selector `0x07a2d13a` = `convertToAssets(uint256)`).

**APY formula:**

```
apy = ((rate_now / rate_7d_ago) ^ (365.25 / 7) - 1) * 100
```

Even when Tier 1 succeeds, the cron still falls through to Tier 2 to collect additional wrapper/native DeFiLlama rows. If no previous exchange rate exists yet (first sync), Tier 1 contributes no row and Tier 2 becomes the first fallback.

#### Special-case Tier 1 estimator: LUSD / B.Protocol Stability Pool

LUSD also has a deterministic on-chain estimator for the Liquity v1 Stability Pool via B.Protocol. This row is intentionally conservative and is labeled `B.Protocol Stability Pool (LQTY only)`.

**Reads:**

- `stabilityPool.getTotalLUSDDeposits()` on Ethereum
- `communityIssuance.totalLQTYIssued()` on Ethereum
- CoinGecko `liquity` USD price

**Formula:**

```
remainingLqtyRewards = max(0, 32_000_000 - totalLQTYIssued)
dailyIssuanceFactor  = 1 - 0.5^(1 / 365)
apr                  = remainingLqtyRewards * dailyIssuanceFactor * lqtyPriceUsd / totalLUSDDeposits * 365 * 100
```

**Caveat:** This source captures only the projected LQTY incentive stream. It deliberately excludes ETH liquidation gains, so it is a lower-bound estimate of the full Stability Pool return.

### Tier 2: DeFiLlama Yields API (Multi-Source)

Collects **all** matching DL pools per coin via `matchAllDlPools` (three layers). Each unique pool found becomes a separate row in `yield_data`. The row with the highest `currentApy` per coin is marked `is_best = 1`; others are `is_best = 0`.

**Layer 1 — Static map:** `YIELD_POOL_MAP` maps Pharos ID to a DL pool UUID. Filters for `exposure === "single"`. Finds the native/primary yield source. If a mapped UUID is missing from the DL payload, the sync logs `[yield-sync] Pool UUID ... not found in DL response, falling through` and continues to Layer 2/3 fallback matching.

**Layer 2 — Variant map:** `YIELD_VARIANT_MAP` maps to a wrapper/savings pool symbol. Filters for `exposure === "single"` only (stablecoin flag intentionally relaxed, since savings wrappers like fxSAVE are not flagged `stablecoin = true` in DeFiLlama). Picks highest TVL.

**Layer 3 — Base-symbol fallback:** Used only when both static maps miss. Searches DL pools by coin symbol. Filters for `exposure === "single"` and `stablecoin === true`. Picks highest TVL.

**Variant mapping:** `YIELD_VARIANT_MAP` entries supply labels and pool matching for wrapper/savings tokens:

| Base Coin             | Wrapper | Purpose                     |
| --------------------- | ------- | --------------------------- |
| USDe (146)            | sUSDe   | Ethena staking wrapper      |
| USDS (209)            | sUSDS   | Sky savings wrapper         |
| GHO (118)             | sGHO    | Aave staked GHO             |
| DAI (5)               | sDAI    | Spark savings DAI           |
| crvUSD (110)          | scrvUSD | Curve staked crvUSD         |
| FRXUSD (235)          | sfrxUSD | Frax staked frxUSD          |
| DOLA (15)             | sDOLA   | Inverse Finance staked DOLA |
| BOLD (269)            | yBOLD   | Liquity yield BOLD          |
| reUSD (339)           | stUSR   | Resolv staking wrapper      |
| AZND (327)            | loAZND  | Mu Digital locked wrapper   |
| USD.AI (309)          | sUSDai  | GAIB USD.AI savings         |
| Neutrl USD (346)      | sNUSD   | Neutrl staked USD           |
| Avalon USDa (220)     | sUSDa   | Avalon staked USDa          |
| infiniFi USD (298)    | siUSD   | infiniFi savings            |
| Falcon USD (246)      | sUSDf   | Falcon Finance savings      |
| Avant USD (271)       | savUSD  | Avant savings               |
| Unitas (283)          | sUSDu   | Unitas savings              |
| Yuzu USD (344)        | sYUSD   | Yuzu savings                |
| fxUSD (168)           | fxSAVE  | Concentrator savings        |
| Noon USN (230)        | sUSN    | Noon savings                |
| Main Street USD (297) | sUSDM   | Main Street savings         |
| GAIB AID (353)        | sAID    | GAIB AID staking            |

APY, base/reward split, pool TVL, and pool UUID are all taken directly from the DL response.

### Tier 3: Price-Derived APY

For `navToken` coins and explicit `PRICE_DERIVED_FALLBACK_IDS`. Derives APY from 30-day price appreciation in the existing `supply_history` table.

```
apy = ((price_now / price_30d_ago) ^ (365.25 / 30) - 1) * 100
```

Zero new API calls — reuses cached price data. Falls through if no price history exists.

### Automatic Lending Pool Discovery (Wave 2)

For tracked non-gold/silver stablecoins rated C- or above (safety score >= 50), the sync cron can append the best lending pool from a curated protocol allowlist. This runs after the base three-tier resolution, so yield-bearing coins can also receive an additional `defillama-auto` source row when a distinct lending market passes filters. LUSD uses this to retain Aave as an alternative source alongside the deterministic B.Protocol estimate.

**Allowlist** (`LENDING_PROTOCOL_ALLOWLIST` in `worker/src/cron/yield-config.ts`):

| Tier   | Protocols                                                                |
| ------ | ------------------------------------------------------------------------ |
| Tier 1 | aave-v3, compound-v3, sparklend, spark-savings, maple, yearn-finance     |
| Tier 2 | fluid-lending, euler-v2, venus-core-pool, kamino-lend, morpho-v1, pendle |
| Tier 3 | justlend, openeden-usdo, multipli.fi, jupiter-lend, stables-labs-usdx    |

**Discovery logic:** Filters DL pools by `exposure === "single"`, `stablecoin === true`, project in allowlist, exact symbol match (case-insensitive). Picks highest TVL.

**Yield type:** `lending-opportunity` — distinguishes these from native yield coins on the frontend.

**Data source:** `defillama-auto` — distinguishes from static-mapped `defillama` pools.

**Eligibility evaluated dynamically:** If a coin's safety score drops below 50, it stops receiving auto-discovered yield data. If it rises back to 50 or above, it starts automatically.

---

## Pharos Yield Score (PYS)

Risk-adjusted ranking (0–100) that balances yield magnitude against safety and consistency.

**Formula (`yield-helpers.ts::computePYS`):**

```
riskPenalty         = max(0.5, (101 - safetyScore) / 20)
yieldEfficiency     = apy30d / riskPenalty
sustainabilityMult  = max(0.3, 1.0 - apyVarianceScore)
PYS                 = min(100, round(yieldEfficiency * sustainabilityMult * scalingFactor))
```

**Components:**

| Component          | Range    | Meaning                                                                                     |
| ------------------ | -------- | ------------------------------------------------------------------------------------------- | ---- | --------- |
| `safetyScore`      | 0–100    | Report card overall score. `DEFAULT_SAFETY_SCORE` (40) for unrated coins                    |
| `riskPenalty`      | 0.5–5.05 | Divisor derived from safety (A+ coin → 0.55, F → 4.55)                                      |
| `apyVarianceScore` | 0–1      | Coefficient of variation of 30-day APY samples, clamped to [0, 1]. Returns 0 if mean ≈ 0 (` | mean | < 1e-10`) |
| `scalingFactor`    | 5        | Global constant (`PYS_SCALING_FACTOR` in `constants.ts`)                                    |

Returns 0 when `apy30d <= 0`.

### Supporting Metrics

| Metric           | Formula                               | Description                                                                   |
| ---------------- | ------------------------------------- | ----------------------------------------------------------------------------- | ---- | --------- |
| `yieldStability` | `1 - CV(30d samples)`                 | 0–1, higher = more consistent. Null if < 2 samples. Returns 1 if mean ≈ 0 (`  | mean | < 1e-10`) |
| `yieldToRisk`    | `apy30d / (101 - safetyScore)`        | Raw yield per unit of risk                                                    |
| `excessYield`    | `apy30d - riskFreeRate`               | Yield above the T-bill benchmark                                              |
| `apy7d`          | Timestamp-filtered 7d average         | 7-day trailing APY (uses `recorded_at >= now - 7d`, not proportional slicing) |
| `apy30d`         | Simple average of 30d samples         | 30-day trailing APY                                                           |
| `variance30d`    | Standard deviation of 30d APY samples | APY volatility measure                                                        |

---

## Risk-Free Rate (T-Bill)

Fetched daily by the `fetch-tbill-rate` cron from FRED's 3-month Treasury yield series (`DGS3MO`).

**Source URL:**

```
https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS3MO
```

**Stored as:** `cache` table, key `"risk_free_rate"`.

**Fallback:** `RISK_FREE_RATE_FALLBACK = 4.25%` — written when FRED is unreachable, circuit-broken, or returns invalid data.

**Usage:** The 30-min yield sync reads the cached rate. The scatter plot renders it as a dashed reference line, and `excessYield` is computed against it.

---

## Warning Signals (Phase 2)

`yield-helpers.ts::detectWarningSignals()` runs in the sync cron and stores results in the `warning_signals` column of `yield_data`. It detects:

| Signal             | Condition                        | Meaning                              |
| ------------------ | -------------------------------- | ------------------------------------ |
| `yield-spike`      | `currentApy / apy30d > 2.0`      | Sudden 2× jump vs. 30d average       |
| `yield-divergence` | `currentApy > medianApy * 3`     | 3× the market median                 |
| `negative-trend`   | `currentApy < apy30d * 0.7`      | 30% decline from average             |
| `reward-heavy`     | `apyReward / apy > 0.8`          | 80%+ from incentives, not base yield |
| `tvl-outflow`      | TVL dropped > 20% from prev week | Capital leaving the protocol         |

At rankings cache-build time, `sync-yield-data` also decorates rows with a read-time-only `data-stale` signal when `updated_at` is older than 90 minutes (`STALE_THRESHOLD_MS`). This signal is included in cached rankings responses but is not written back to `yield_data`.

The sync also performs an operational cross-source check after metric computation: if a coin has both native yield (`onchain` / `defillama` / `price-derived`) and auto-discovered lending yield (`defillama-auto`), and the APYs diverge by more than 50% (relative to the larger APY), it emits a `[yield-sync] APY divergence ...` `console.warn` log. This is observability-only and does not affect persisted data or ranking behavior.

---

## Database Schema

**Migrations:** `worker/migrations/0031_yield_data.sql` (initial), `worker/migrations/0041_yield_data_multi_source.sql` (multi-source PK)

### `yield_data` — Current Snapshot (one row per coin per source)

```sql
CREATE TABLE yield_data (
  stablecoin_id       TEXT NOT NULL,
  source_key          TEXT NOT NULL,  -- DL pool UUID or "price-derived"
  symbol              TEXT NOT NULL,
  current_apy         REAL NOT NULL,
  apy_base            REAL,
  apy_reward          REAL,
  apy_7d              REAL NOT NULL,
  apy_30d             REAL NOT NULL,
  yield_source        TEXT NOT NULL,
  yield_type          TEXT NOT NULL,
  source_pool         TEXT,           -- DL pool UUID
  source_tvl_usd      REAL,
  data_source         TEXT NOT NULL,  -- "onchain" | "defillama" | "defillama-auto" | "price-derived"
  safety_score        REAL,
  safety_grade        TEXT,
  pharos_yield_score  REAL,
  yield_to_risk       REAL,
  excess_yield        REAL,
  yield_stability     REAL,           -- 0-1
  apy_variance_30d    REAL,
  apy_min_30d         REAL,
  apy_max_30d         REAL,
  exchange_rate       REAL,           -- current vault rate (Tier 1 only)
  exchange_rate_prev  REAL,           -- 7d-ago vault rate
  warning_signals     TEXT,           -- JSON array of active signal keys (migration 0033)
  is_best             INTEGER NOT NULL DEFAULT 1,  -- 1 = highest-APY source per coin
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (stablecoin_id, source_key)
);
```

**Indices:** `idx_yield_pys` (PYS DESC), `idx_yield_apy` (apy_30d DESC), `idx_yield_best` (stablecoin_id, is_best).

**Multi-source behavior:** Coins with both a native pool and a savings wrapper get two rows — one with `is_best = 1` (highest current APY), one with `is_best = 0`. This also covers mixed source types such as LUSD, where a deterministic on-chain B.Protocol row can coexist with an auto-discovered Aave lending row. Rankings queries filter `WHERE is_best = 1`. Alt-source rows are read separately and attached as `altSources[]` in the cached API response. After each batch write, stale rows for coins refreshed in that run are purged so old primary sources cannot linger alongside the new winner.

### `yield_history` — Historical Data Points

```sql
CREATE TABLE yield_history (
  stablecoin_id   TEXT NOT NULL,
  recorded_at     INTEGER NOT NULL,  -- Unix seconds
  apy             REAL NOT NULL,
  apy_base        REAL,
  apy_reward      REAL,
  exchange_rate   REAL,
  source_tvl_usd  REAL,
  data_source     TEXT NOT NULL,
  warning_signals TEXT,              -- JSON array of active signal keys (best-source snapshot)
  PRIMARY KEY (stablecoin_id, recorded_at)
);
```

**Index:** `idx_yield_hist_coin` (stablecoin_id, recorded_at DESC).

**Retention:** 365 days. Older rows are pruned at the end of each sync run.

**Estimated volume:** ~40 coins × 48 points/day × 365 days ≈ 701K rows/year.

---

## Cron Jobs

### `sync-yield-data`

**Schedule:** `10,40 * * * *` (every 30 min, Trigger 3)
**File:** `worker/src/cron/sync-yield-data.ts`

**Execution flow:**

1. Filter `TRACKED_STABLECOINS` where `flags.yieldBearing === true` for the base three-tier resolution, then evaluate auto-discovery across all eligible tracked non-gold/silver coins
2. Fetch DeFiLlama pools (`https://yields.llama.fi/pools`) — circuit-breaker protected
3. Fetch on-chain exchange rates via `eth_call` for `ON_CHAIN_RATE_CONFIGS` entries
4. Read cached risk-free rate from D1
5. Compute safety scores via shared helper `computeSafetyScoresSnapshot(db, { includeNavTokens: true, outputMode: "map" })`; classify safety input as degraded when coverage is empty or below the minimum ratio
6. Resolve APY for each yield-bearing coin (Tier 1 → 2 → 3, potentially multiple sources per coin), then append auto-discovered lending rows for any remaining eligible tracked coins
7. Determine `is_best` per coin: source with highest `currentApy` wins
8. Batch preload `yield_history` datasets (7d previous exchange rates, previous TVL rows, and 30d APY history), group in memory, then compute trailing averages and PYS without per-coin query loops
9. NaN/Infinity guard: clamp PYS, variance, and stability to finite values before DB write
10. Batch upsert `yield_data` (all sources) + insert `yield_history` point (best source only)
11. Purge stale rows for refreshed coins so obsolete primary/alt sources are removed together
12. Prune `yield_history` older than 365 days
13. Query best-source rows, fetch alt-source rows, attach as `altSources[]`, add read-time `data-stale` warning decoration from `updated_at` age, then cache rankings JSON only when safety input is healthy and schema validation succeeds (with safe `warning_signals` JSON parsing on read paths)

**Degraded semantics:** If safety coverage is degraded or rankings schema validation fails, `sync-yield-data` returns `status: "degraded"` and skips `yield-rankings` cache overwrite. Safety-degraded runs also skip `report_card_cache` writes to preserve last-known-good snapshots.

**Shared safety scores:** The report-cards API handler doesn't cache results, so both yield sync and daily digest call the same shared safety-score pipeline. It still uses the two-phase dependency approach (independent first, then CeFi-dependent).

**Batch query policy:** No per-coin query loops are used for the three high-volume `yield_history` reads (previous exchange rate, previous TVL, 30d APY history); these are loaded in batch and indexed by stablecoin ID in-memory.

### `fetch-tbill-rate`

**Schedule:** `0 8 * * *` (daily, Trigger 4)
**File:** `worker/src/cron/fetch-tbill-rate.ts`

Fetches the latest T-bill proxy rate from FRED (`DGS3MO`). Validates the rate (must be 0–20%), stores in cache. Falls back to `RISK_FREE_RATE_FALLBACK` on any failure.

---

## API Endpoints

### `GET /api/yield-rankings`

Pre-computed rankings served from cache. Written by `sync-yield-data`.

**Cache profile:** Standard (`s-maxage=300, max-age=60`)

**Response shape:**

```json
{
  "rankings": [
    {
      "id": "usde-ethena",
      "symbol": "USDe",
      "name": "Ethena USDe",
      "currentApy": 12.4,
      "apy7d": 11.8,
      "apy30d": 10.2,
      "apyBase": 10.2,
      "apyReward": null,
      "yieldSource": "Ethena staking (sUSDe)",
      "yieldType": "lending-vault",
      "dataSource": "defillama",
      "sourceTvlUsd": 5200000000,
      "pharosYieldScore": 28,
      "safetyScore": 65,
      "safetyGrade": "B",
      "yieldToRisk": 0.33,
      "excessYield": 5.95,
      "yieldStability": 0.82,
      "apyVariance30d": 2.1,
      "apyMin30d": 7.5,
      "apyMax30d": 15.3,
      "altSources": [
        {
          "sourceKey": "ee0b7069-...",
          "yieldSource": "Concentrator (fxSAVE)",
          "yieldType": "lending-vault",
          "currentApy": 9.1,
          "apy30d": 8.8,
          "sourceTvlUsd": 31000000,
          "dataSource": "defillama"
        }
      ]
    }
  ],
  "riskFreeRate": 3.76,
  "scalingFactor": 5,
  "medianApy": 4.21,
  "updatedAt": 1772000000
}
```

Default sort: `pharos_yield_score` DESC. `altSources` is an empty array for coins with only one yield source. `medianApy` is the TVL-weighted median of best-source `apy30d` values and is used by peer-reference warning heuristics.

### `GET /api/yield-history?stablecoin=<id>&days=<n>`

Historical APY data points for a single coin. Reads from `yield_history` directly.

**Cache profile:** Slow (`s-maxage=3600, max-age=300`)

| Param        | Type    | Default  | Bounds | Description          |
| ------------ | ------- | -------- | ------ | -------------------- |
| `stablecoin` | string  | required | —      | Pharos stablecoin ID |
| `days`       | integer | 90       | 1–365  | Lookback window      |

**Response:** Array of `{ date, apy, apyBase, apyReward, exchangeRate, sourceTvlUsd, warningSignals }` sorted by `date` ASC.

---

## Frontend

### Page: `/yield`

**Files:** `src/app/yield/page.tsx` (SSG wrapper), `src/app/yield/client.tsx` (interactive)

**Layout (top to bottom):**

1. New-feature notice banner (amber)
2. Stale data banner (triggers at 2 × 30 min = 60 min)
3. Summary stat cards — Average Yield (TVL-weighted), Risk-Free Rate, Best Risk-Adjusted (highest PYS)
4. Yield vs Safety scatter plot
5. Yield leaderboard table
6. Disclaimer

### `YieldScatterPlot` (`src/components/yield-scatter-plot.tsx`)

Recharts scatter chart. X = safety score, Y = APY (%). The chart plots one best-source point per stablecoin, auto-focuses the x-axis on the occupied safety-score band instead of always rendering the full 0-100 range, and keeps the safety threshold at 60 visible for quadrant context. Scatter markers render each stablecoin's logo (with an initial fallback if no logo exists), and yield type information lives in the tooltip instead of a separate legend. Rare high-APY outliers are pinned to a disclosed top rail so one extreme point does not flatten the rest of the plot.

**Quadrants** (divided at safety = 60 and APY = T-bill rate):

| Quadrant     | Position                  | Color              |
| ------------ | ------------------------- | ------------------ |
| Sweet Spot   | High safety, above T-bill | Green (5% opacity) |
| Danger Zone  | Low safety, above T-bill  | Red (5% opacity)   |
| Play It Safe | High safety, below T-bill | Blue (5% opacity)  |
| Why Bother?  | Low safety, below T-bill  | Gray (5% opacity)  |

Dashed reference line at the T-bill rate. Click a dot to navigate to that coin's detail page.

### `YieldLeaderboard` (`src/components/yield-leaderboard.tsx`)

Sortable, paginated table (25 rows/page). Default sort: PYS descending.

**Columns:** Rank, Coin (logo + symbol), APY (30d), Grade, PYS, Source, Type (badge), TVL, Stability (bar + %), 30d Range.

Stability display multiplies the raw 0–1 value by 100 for both the bar width and the percentage text.

**Alt-sources badge:** When a coin has `altSources.length > 0`, a `+N` pill badge appears next to the source name in the Source column. Clicking it opens a small inline popover listing each alternative source name and its current APY.

### `YieldHistoryChart` (`src/components/yield-history-chart.tsx`)

Shared Recharts history module for per-coin yield trends. It reads `/api/yield-history` through `useYieldHistory`, renders the main APY line with optional base/reward overlays, and layers two horizontal benchmarks: the current T-bill rate and the current peer median. Points carrying `warningSignals` get amber markers so spike/divergence/reward-heavy regimes are visible without expanding the tooltip.

The control row exposes four fixed lookback presets (`7d`, `30d`, `90d`, `1y`) plus an optional breakdown toggle. Compact mode keeps the same data semantics for inline leaderboard expansion, but shortens the chart height to 200px and drops reference-line labels to protect legibility in tighter rows.

### Hooks

| Hook               | File                              | Endpoint              | Stale Time            |
| ------------------ | --------------------------------- | --------------------- | --------------------- |
| `useYieldRankings` | `src/hooks/use-yield-rankings.ts` | `/api/yield-rankings` | `CRON_30MIN` (30 min) |
| `useYieldHistory`  | `src/hooks/use-yield-history.ts`  | `/api/yield-history`  | `CRON_30MIN` (30 min) |

---

## Constants

**File:** `worker/src/lib/constants.ts`

| Constant                        | Value                                                       | Purpose                                          |
| ------------------------------- | ----------------------------------------------------------- | ------------------------------------------------ |
| `RISK_FREE_RATE_FALLBACK`       | 4.25                                                        | Fallback T-bill rate (%)                         |
| `FRED_TBILL_CSV_URL`            | `https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS3MO` | FRED daily 3-month Treasury yield series         |
| `PYS_SCALING_FACTOR`            | 5                                                           | PYS distribution tuning parameter                |
| `DEFAULT_SAFETY_SCORE`          | 40                                                          | Safety score for unrated coins (most NAV tokens) |
| `CIRCUIT_SOURCE.DL_YIELDS`      | `"defillama-yields"`                                        | Circuit breaker key for DL Yields API            |
| `CIRCUIT_SOURCE.TREASURY_RATES` | `"treasury-rates"`                                          | Circuit breaker key for risk-free rate fetch     |

---

## Testing

**File:** `worker/src/cron/__tests__/yield-helpers.test.ts`

Covers all pure functions in `yield-helpers.ts`:

- `computeApyFromRate` — 7-day rate change, zero/negative inputs, decreasing rates
- `computeApyFromPrice` — delegates to `computeApyFromRate`
- `computePYS` — safe high-yield, safety penalty, variance penalty, 100 cap, negative APY
- `computeYieldStability` — stable vs. volatile yields, empty/single samples, near-zero mean guard
- `computeApyVarianceScore` — near-zero mean guard (no Infinity from floating-point)
- `detectWarningSignals` — yield spike, reward-heavy, TVL outflow, healthy baseline
- `matchAllDlPools` — Layer 1/2/3 source matching, dedup, relaxed Layer 2 stablecoin filter, highest-TVL selection

---

## Edge Cases

- **First sync (no history):** `apy7d` and `apy30d` equal `currentApy`. PYS still computed.
- **Unrated coins (no safety grade):** Safety score defaults to `DEFAULT_SAFETY_SCORE` (40, D-equivalent). Most NAV tokens hit this path since the report card framework doesn't grade them yet.
- **All tiers fail:** Coin is recorded with `yield: null` and skipped in the write phase. No PYS computed. Logged as warning.
- **Negative APY:** Stored and displayed. PYS returns 0 for `apy30d <= 0`.
- **DL Yields circuit-broken:** Tier 2 skipped entirely. Coins with Tier 1 or Tier 3 coverage still get APY. Others get `yield: null`.
- **Cron gaps (7d filter):** The 7d trailing average uses timestamp-based filtering (`recorded_at >= now - 7d`) rather than proportional slicing, so gaps don't shift the window.

---

## File Index

| File                                                 | Role                                                                                                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `worker/migrations/0031_yield_data.sql`              | D1 schema: `yield_data` + `yield_history` tables                                                                                             |
| `worker/migrations/0041_yield_data_multi_source.sql` | Adds `source_key` + `is_best` columns, changes PK to `(stablecoin_id, source_key)`                                                           |
| `worker/src/cron/sync-yield-data.ts`                 | Main sync cron: three-tier resolution, multi-source matching, PYS, safety scores, caching                                                    |
| `worker/src/cron/yield-config.ts`                    | Static config: `YIELD_POOL_MAP`, `YIELD_VARIANT_MAP`, `ON_CHAIN_RATE_CONFIGS`                                                                |
| `worker/src/cron/yield-helpers.ts`                   | Pure functions: APY, PYS, stability, variance, warning signals, `matchAllDlPools`                                                            |
| `worker/src/cron/fetch-tbill-rate.ts`                | Daily T-bill rate cron                                                                                                                       |
| `worker/src/api/cache-handlers.ts`                   | Cache-backed `GET /api/yield-rankings` handler (`handleYieldRankings`)                                                                       |
| `worker/src/api/yield-history.ts`                    | `GET /api/yield-history` handler                                                                                                             |
| `shared/types/index.ts`                              | `YieldConfig`, `YieldType`, `YieldRanking` (`.altSources: AltYieldSource[]`), `AltYieldSource`, `YieldRankingsResponse`, `YieldHistoryPoint` |
| `shared/lib/classification.ts`                       | `YIELD_TYPE_LABELS`, `YIELD_TYPE_STYLES`                                                                                                     |
| `src/hooks/use-yield-rankings.ts`                    | TanStack Query hook for rankings                                                                                                             |
| `src/app/yield/page.tsx`                             | SSG page wrapper with metadata                                                                                                               |
| `src/app/yield/client.tsx`                           | Interactive page: stats, scatter, leaderboard                                                                                                |
| `src/components/yield-leaderboard.tsx`               | Sortable rankings table with `+N` alt-source pill badge                                                                                      |
| `src/components/yield-history-chart.tsx`             | Shared APY history chart with T-bill / peer-median reference lines, optional base-reward split, and warning markers                         |
| `src/components/yield-scatter-plot.tsx`              | Risk-adjusted scatter visualization                                                                                                          |
| `worker/src/cron/__tests__/yield-helpers.test.ts`    | Unit tests for all pure yield functions                                                                                                      |
