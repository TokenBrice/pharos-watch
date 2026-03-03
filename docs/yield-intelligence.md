# Yield Intelligence

Risk-adjusted yield tracking and ranking for yield-bearing stablecoins. Computes APY from three sources (on-chain rates, DeFiLlama, price history), scores each coin via the Pharos Yield Score (PYS), and serves a dedicated `/yield` page with scatter plot and leaderboard.

---

## Tracked Coins

Every stablecoin with `flags.yieldBearing: true` in `src/lib/stablecoins.ts` enters the yield pipeline. Currently 41 yield-bearing coins, plus automatic lending pool discovery for non-yield-bearing stablecoins rated C- or above (safety score >= 50). `yieldConfig` is used when present to provide canonical source/type labels; auto-discovered lending rows can synthesize these labels when config is absent.

| Field | Type | Description |
|-------|------|-------------|
| `yieldSource` | `string` | Human-readable source name (e.g. "Ethena staking"). Optional for auto-discovered lending rows |
| `yieldType` | `YieldType` | Mechanism classification (see below). Optional for auto-discovered lending rows |

### Yield Types

| Type | Label | Description |
|------|-------|-------------|
| `lending-vault` | Lending | Deposited into lending protocols or vault strategies |
| `rebase` | Rebase | Token supply rebases to distribute yield |
| `fee-sharing` | Fee Share | Protocol fees passed to holders |
| `lp-receipt` | LP Receipt | LP position wrapped as stablecoin |
| `nav-appreciation` | NAV | Token price appreciates as backing grows |
| `governance-set` | Gov. Set | Yield rate set by governance vote |
| `lending-opportunity` | Lending Opp. | Auto-discovered best lending market for non-yield-bearing coins |

Labels and styles are centralized in `src/lib/classification.ts` (`YIELD_TYPE_LABELS`, `YIELD_TYPE_STYLES`), both typed as `Record<YieldType, ...>` so adding a new variant without updating the maps is a compile error.

---

## Three-Tier APY Resolution

The sync cron resolves APY for each coin using a priority-ordered strategy. The first successful tier wins; subsequent tiers are skipped.

### Tier 1: On-Chain Exchange Rates

Reads vault contract exchange rates via `eth_call` RPC, then computes APY from the 7-day rate delta.

**Config:** `ON_CHAIN_RATE_CONFIGS` in `worker/src/cron/yield-config.ts`

```ts
interface OnChainRateConfig {
  stablecoinId: string;
  chain: string;
  contract: string;       // vault contract address
  selector: string;       // 4-byte function selector
  decimals: number;
  inputAmount: string;    // hex-encoded input (e.g. 1e18)
}
```

Currently configured for sUSDe only (contract `0x9D39...7497`, selector `0x07a2d13a` = `convertToAssets(uint256)`).

**APY formula:**

```
apy = ((rate_now / rate_7d_ago) ^ (365.25 / 7) - 1) * 100
```

Falls through to Tier 2 if no previous exchange rate exists yet (first sync).

### Tier 2: DeFiLlama Yields API (Multi-Source)

Collects **all** matching DL pools per coin via `matchAllDlPools` (three layers). Each unique pool found becomes a separate row in `yield_data`. The row with the highest `currentApy` per coin is marked `is_best = 1`; others are `is_best = 0`.

**Layer 1 — Static map:** `YIELD_POOL_MAP` maps Pharos ID to a DL pool UUID. Filters for `exposure === "single"`. Finds the native/primary yield source.

**Layer 2 — Variant map:** `YIELD_VARIANT_MAP` maps to a wrapper/savings pool symbol. Filters for `exposure === "single"` only (stablecoin flag intentionally relaxed, since savings wrappers like fxSAVE are not flagged `stablecoin = true` in DeFiLlama). Picks highest TVL.

**Layer 3 — Base-symbol fallback:** Used only when both static maps miss. Searches DL pools by coin symbol. Filters for `exposure === "single"` and `stablecoin === true`. Picks highest TVL.

**Variant mapping:** `YIELD_VARIANT_MAP` entries supply labels and pool matching for wrapper/savings tokens:

| Base Coin | Wrapper | Purpose |
|-----------|---------|---------|
| USDe (146) | sUSDe | Ethena staking wrapper |
| USDS (209) | sUSDS | Sky savings wrapper |
| GHO (118) | sGHO | Aave staked GHO |
| DAI (5) | sDAI | Spark savings DAI |
| crvUSD (110) | scrvUSD | Curve staked crvUSD |
| FRXUSD (235) | sfrxUSD | Frax staked frxUSD |
| DOLA (15) | sDOLA | Inverse Finance staked DOLA |
| BOLD (269) | yBOLD | Liquity yield BOLD |
| reUSD (339) | stUSR | Resolv staking wrapper |
| AZND (327) | loAZND | Mu Digital locked wrapper |
| USD.AI (309) | sUSDai | GAIB USD.AI savings |
| Neutrl USD (346) | sNUSD | Neutrl staked USD |
| Avalon USDa (220) | sUSDa | Avalon staked USDa |
| infiniFi USD (298) | siUSD | infiniFi savings |
| Falcon USD (246) | sUSDf | Falcon Finance savings |
| Avant USD (271) | savUSD | Avant savings |
| Unitas (283) | sUSDu | Unitas savings |
| Yuzu USD (344) | sYUSD | Yuzu savings |
| fxUSD (168) | fxSAVE | Concentrator savings |
| Noon USN (230) | sUSN | Noon savings |
| Main Street USD (297) | sUSDM | Main Street savings |
| GAIB AID (353) | sAID | GAIB AID staking |

APY, base/reward split, pool TVL, and pool UUID are all taken directly from the DL response.

### Tier 3: Price-Derived APY

For `navToken` coins only. Derives APY from 30-day price appreciation in the existing `supply_history` table.

```
apy = ((price_now / price_30d_ago) ^ (365.25 / 30) - 1) * 100
```

Zero new API calls — reuses cached price data. Falls through if no price history exists.

### Automatic Lending Pool Discovery (Wave 2)

For stablecoins **not** flagged `yieldBearing` but rated C- or above (safety score >= 50), the sync cron automatically discovers the best lending pool from a curated protocol allowlist.

**Allowlist** (`LENDING_PROTOCOL_ALLOWLIST` in `worker/src/cron/yield-config.ts`):

| Tier | Protocols |
|------|-----------|
| Tier 1 | aave-v3, compound-v3, sparklend, spark-savings, maple, yearn-finance |
| Tier 2 | fluid-lending, euler-v2, venus-core-pool, kamino-lend, morpho-v1, pendle |
| Tier 3 | justlend, openeden-usdo, multipli.fi, jupiter-lend, stables-labs-usdx |

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

| Component | Range | Meaning |
|-----------|-------|---------|
| `safetyScore` | 0–100 | Report card overall score. `DEFAULT_SAFETY_SCORE` (40) for unrated coins |
| `riskPenalty` | 0.5–5.05 | Divisor derived from safety (A+ coin → 0.55, F → 4.55) |
| `apyVarianceScore` | 0–1 | Coefficient of variation of 30-day APY samples, clamped to [0, 1]. Returns 0 if mean ≈ 0 (`|mean| < 1e-10`) |
| `scalingFactor` | 5 | Global constant (`PYS_SCALING_FACTOR` in `constants.ts`) |

Returns 0 when `apy30d <= 0`.

### Supporting Metrics

| Metric | Formula | Description |
|--------|---------|-------------|
| `yieldStability` | `1 - CV(30d samples)` | 0–1, higher = more consistent. Null if < 2 samples. Returns 1 if mean ≈ 0 (`|mean| < 1e-10`) |
| `yieldToRisk` | `apy30d / (101 - safetyScore)` | Raw yield per unit of risk |
| `excessYield` | `apy30d - riskFreeRate` | Yield above the T-bill benchmark |
| `apy7d` | Timestamp-filtered 7d average | 7-day trailing APY (uses `recorded_at >= now - 7d`, not proportional slicing) |
| `apy30d` | Simple average of 30d samples | 30-day trailing APY |
| `variance30d` | Standard deviation of 30d APY samples | APY volatility measure |

---

## Risk-Free Rate (T-Bill)

Fetched daily by the `fetch-tbill-rate` cron from the US Treasury Fiscal Data API (free, no key).

**Source URL:**

```
https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/avg_interest_rates
  ?filter=security_desc:eq:Treasury Bills
  &sort=-record_date
  &page[size]=1
  &fields=record_date,avg_interest_rate_amt
```

**Stored as:** `cache` table, key `"risk_free_rate"`.

**Fallback:** `RISK_FREE_RATE_FALLBACK = 4.25%` — written when the API is unreachable, circuit-broken, or returns invalid data (NaN, negative, or > 20%).

**Usage:** The 30-min yield sync reads the cached rate. The scatter plot renders it as a dashed reference line, and `excessYield` is computed against it.

---

## Warning Signals (Phase 2)

`yield-helpers.ts::detectWarningSignals()` runs in the sync cron and stores results in the `warning_signals` column of `yield_data`. It detects:

| Signal | Condition | Meaning |
|--------|-----------|---------|
| `yield-spike` | `currentApy / apy30d > 2.0` | Sudden 2× jump vs. 30d average |
| `yield-divergence` | `currentApy > medianApy * 3` | 3× the market median |
| `negative-trend` | `currentApy < apy30d * 0.7` | 30% decline from average |
| `reward-heavy` | `apyReward / apy > 0.8` | 80%+ from incentives, not base yield |
| `tvl-outflow` | TVL dropped > 20% from prev week | Capital leaving the protocol |

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

**Multi-source behavior:** Coins with both a native pool and a savings wrapper get two rows — one with `is_best = 1` (highest current APY), one with `is_best = 0`. Rankings queries filter `WHERE is_best = 1`. Alt-source rows are read separately and attached as `altSources[]` in the cached API response. Stale `is_best = 0` rows not written in the current run are purged after each batch write.

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
  PRIMARY KEY (stablecoin_id, recorded_at)
);
```

**Index:** `idx_yield_hist_coin` (stablecoin_id, recorded_at DESC).

**Retention:** 365 days. Older rows are pruned at the end of each sync run.

**Estimated volume:** ~39 coins × 48 points/day × 365 days ≈ 684K rows/year.

---

## Cron Jobs

### `sync-yield-data`

**Schedule:** `10,40 * * * *` (every 30 min, Trigger 3)
**File:** `worker/src/cron/sync-yield-data.ts`

**Execution flow:**

1. Filter `TRACKED_STABLECOINS` where `flags.yieldBearing === true`
2. Fetch DeFiLlama pools (`https://yields.llama.fi/pools`) — circuit-breaker protected
3. Fetch on-chain exchange rates via `eth_call` for `ON_CHAIN_RATE_CONFIGS` entries
4. Read cached risk-free rate from D1
5. Compute safety scores inline (full report-card dimensions — same logic as `daily-digest.ts`)
6. Resolve APY for each coin (Tier 1 → 2 → 3, potentially multiple sources per coin)
7. Determine `is_best` per coin: source with highest `currentApy` wins
8. Load 30-day APY history from `yield_history`, compute trailing averages and PYS
9. NaN/Infinity guard: clamp PYS, variance, and stability to finite values before DB write
10. Batch upsert `yield_data` (all sources) + insert `yield_history` point (best source only)
11. Purge stale `is_best = 0` rows not written in this run
12. Prune `yield_history` older than 365 days
13. Query best-source rows, fetch alt-source rows, attach as `altSources[]`, cache rankings JSON

**Inline safety scores:** The report-cards API handler doesn't cache results, so the cron computes all five dimensions (peg stability, liquidity, resilience, decentralization, dependency risk) and overall grade for each yield-bearing coin itself. Uses a two-phase approach: independent coins first, then CeFi-dependent coins.

**Tier 1 query dedup:** The cron caches previous exchange rates in a `Map<string, number | null>` during APY resolution and reuses them when writing `exchange_rate_prev`, avoiding a duplicate DB query per Tier 1 coin.

### `fetch-tbill-rate`

**Schedule:** `0 8 * * *` (daily, Trigger 4)
**File:** `worker/src/cron/fetch-tbill-rate.ts`

Fetches the latest T-bill rate from the US Treasury API. Validates the rate (must be 0–20%), stores in cache. Falls back to `RISK_FREE_RATE_FALLBACK` on any failure.

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
      "id": "146",
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
  "updatedAt": 1772000000
}
```

Default sort: `pharos_yield_score` DESC. `altSources` is an empty array for coins with only one yield source.

### `GET /api/yield-history?stablecoin=<id>&days=<n>`

Historical APY data points for a single coin. Reads from `yield_history` directly.

**Cache profile:** Slow (`s-maxage=3600, max-age=300`)

| Param | Type | Default | Bounds | Description |
|-------|------|---------|--------|-------------|
| `stablecoin` | string | required | — | Pharos stablecoin ID |
| `days` | integer | 90 | 1–365 | Lookback window |

**Response:** Array of `{ date, apy, apyBase, apyReward, exchangeRate, sourceTvlUsd }` sorted by `date` ASC.

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

Recharts scatter chart. X = safety score (0–100), Y = APY (%). Dot color by yield type (`YIELD_TYPE_STYLES[type].hex`).

**Quadrants** (divided at safety = 60 and APY = T-bill rate):

| Quadrant | Position | Color |
|----------|----------|-------|
| Sweet Spot | High safety, above T-bill | Green (5% opacity) |
| Danger Zone | Low safety, above T-bill | Red (5% opacity) |
| Play It Safe | High safety, below T-bill | Blue (5% opacity) |
| Why Bother? | Low safety, below T-bill | Gray (5% opacity) |

Dashed reference line at the T-bill rate. Click a dot to navigate to that coin's detail page.

### `YieldLeaderboard` (`src/components/yield-leaderboard.tsx`)

Sortable, paginated table (25 rows/page). Default sort: PYS descending.

**Columns:** Rank, Coin (logo + symbol), APY (30d), Grade, PYS, Source, Type (badge), TVL, Stability (bar + %), 30d Range.

Stability display multiplies the raw 0–1 value by 100 for both the bar width and the percentage text.

**Alt-sources badge:** When a coin has `altSources.length > 0`, a `+N` pill badge appears next to the source name in the Source column. Clicking it opens a small inline popover listing each alternative source name and its current APY.

### Hooks

| Hook | File | Endpoint | Stale Time |
|------|------|----------|------------|
| `useYieldRankings` | `src/hooks/use-yield-rankings.ts` | `/api/yield-rankings` | `CRON_30MIN` (30 min) |
| `useYieldHistory` | `src/hooks/use-yield-history.ts` | `/api/yield-history` | `CRON_1H` (1 hour) |

---

## Constants

**File:** `worker/src/lib/constants.ts`

| Constant | Value | Purpose |
|----------|-------|---------|
| `RISK_FREE_RATE_FALLBACK` | 4.25 | Fallback T-bill rate (%) |
| `TREASURY_FISCAL_DATA_URL` | `https://api.fiscaldata.treasury.gov/...` | Treasury API endpoint |
| `PYS_SCALING_FACTOR` | 5 | PYS distribution tuning parameter |
| `DEFAULT_SAFETY_SCORE` | 40 | Safety score for unrated coins (most NAV tokens) |
| `CIRCUIT_SOURCE.DL_YIELDS` | `"defillama-yields"` | Circuit breaker key for DL Yields API |
| `CIRCUIT_SOURCE.TREASURY_RATES` | `"treasury-rates"` | Circuit breaker key for Treasury API |

---

## Testing

**File:** `src/lib/__tests__/yield-helpers.test.ts`

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

| File | Role |
|------|------|
| `worker/migrations/0031_yield_data.sql` | D1 schema: `yield_data` + `yield_history` tables |
| `worker/migrations/0041_yield_data_multi_source.sql` | Adds `source_key` + `is_best` columns, changes PK to `(stablecoin_id, source_key)` |
| `worker/src/cron/sync-yield-data.ts` | Main sync cron: three-tier resolution, multi-source matching, PYS, safety scores, caching |
| `worker/src/cron/yield-config.ts` | Static config: `YIELD_POOL_MAP`, `YIELD_VARIANT_MAP`, `ON_CHAIN_RATE_CONFIGS` |
| `worker/src/cron/yield-helpers.ts` | Pure functions: APY, PYS, stability, variance, warning signals, `matchAllDlPools` |
| `worker/src/cron/fetch-tbill-rate.ts` | Daily T-bill rate cron |
| `worker/src/api/yield-rankings.ts` | `GET /api/yield-rankings` handler |
| `worker/src/api/yield-history.ts` | `GET /api/yield-history` handler |
| `src/lib/types.ts` | `YieldConfig`, `YieldType`, `YieldRanking` (`.altSources: AltYieldSource[]`), `AltYieldSource`, `YieldRankingsResponse`, `YieldHistoryPoint` |
| `src/lib/classification.ts` | `YIELD_TYPE_LABELS`, `YIELD_TYPE_STYLES` |
| `src/hooks/use-yield-rankings.ts` | TanStack Query hook for rankings |
| `src/hooks/use-yield-history.ts` | TanStack Query hook for history |
| `src/app/yield/page.tsx` | SSG page wrapper with metadata |
| `src/app/yield/client.tsx` | Interactive page: stats, scatter, leaderboard |
| `src/components/yield-leaderboard.tsx` | Sortable rankings table with `+N` alt-source pill badge |
| `src/components/yield-scatter-plot.tsx` | Risk-adjusted scatter visualization |
| `src/lib/__tests__/yield-helpers.test.ts` | Unit tests for all pure yield functions |
