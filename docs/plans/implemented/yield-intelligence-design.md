# Yield Intelligence Layer

**Date:** 2026-03-01
**Status:** Draft (refined)

---

## 1. Overview & Motivation

Pharos tracks ~145 stablecoins across 5 risk dimensions (peg stability, liquidity, resilience, decentralization, dependency risk) and produces composite report card grades from A+ to F. Separately, ~15 of those stablecoins are flagged as `yieldBearing: true` --- they accrue yield through lending, rebasing, fee-sharing, or NAV appreciation. Today, these two data points live in separate worlds: a user who wants to hold a yield-bearing stablecoin must manually cross-reference APY data from protocol websites against Pharos safety grades. Nobody synthesizes yield and risk into a single view.

**The Yield Intelligence Layer closes this gap.** It introduces:

1. **Yield data collection** --- APY tracking for every yield-bearing stablecoin, sourced from DefiLlama Yields, on-chain exchange rates, and price-derived NAV appreciation.
2. **Risk-adjusted yield rankings** --- a "Pharos Yield Score" that combines APY with the existing report card composite score, producing a Sharpe-like ratio for stablecoins.
3. **Yield sustainability analysis** --- historical variance and warning signal detection to flag unsustainable yields.

**Why this matters:** In traditional finance, nobody evaluates a bond's yield without its credit rating. The stablecoin ecosystem has yields (DeFi protocols publish APYs) and it has safety ratings (Pharos report cards), but no product combines them. Anchor Protocol offered 19.5% APY on UST; a risk-adjusted ranking would have placed it near the bottom of any sensible list. This feature turns hindsight into foresight.

**Key innovation:** The yield-vs-safety scatter plot. A single chart where X = safety score (0-100) and Y = APY. The upper-right quadrant (high yield, high safety) is the sweet spot. The upper-left quadrant (high yield, low safety) is the danger zone. This is the most tweetable chart Pharos can produce.

**v1 scope:** A standalone `/yield/` page with leaderboard, scatter plot, and stats. No integration with homepage, detail pages, comparison tool, portfolio builder, or daily digest until the data pipeline has been validated in production. See [Phase 2](#11-phase-2--future-integration) for deferred work.

---

## 2. Data Sources & Collection Strategy

### 2.1 Three-Tier APY Sourcing

Yield data is resolved using a **priority-ordered three-tier strategy**. For each yield-bearing stablecoin, the cron tries each tier in order and uses the first that produces a result.

| Tier | Source | Best For | Accuracy | Coverage |
|------|--------|----------|----------|----------|
| **1. On-chain exchange rate** | `eth_call` to vault contract | Vault/wrapper tokens (sUSDe, wUSDM) | Highest --- immune to dashboard manipulation | Low (~2-3 tokens) |
| **2. DefiLlama Yields pool** | `yields.llama.fi/pools` | Most yield-bearing tokens | High --- aggregated from protocol data | High (~12-13 tokens) |
| **3. Price-derived APY** | Existing price history | navTokens with no DL pool | Moderate --- subject to price noise | Universal for navTokens |

**Tier 3 rationale:** 10 of 15 yield-bearing coins are `navToken: true`. Their price appreciates over time, making APY directly derivable from price change. This is not a niche fallback --- it covers the majority of the yield universe and requires zero new data fetching.

### 2.2 Yield Variant Mapping

Many tracked stablecoins have a separate yield-bearing variant that Pharos does not track directly. For example, USDe (tracked, ID 146) has sUSDe (not tracked) as its staking wrapper. When matching DL pools or querying on-chain rates, we need to know about these variants.

**`YIELD_VARIANT_MAP`** maps a tracked Pharos stablecoin to its yield-bearing variant:

```typescript
interface YieldVariant {
  /** Symbol of the yield-bearing variant (e.g., "sUSDe", "sDAI") */
  variantSymbol: string;
  /** Contract address of the yield variant (for on-chain rate queries and DL matching) */
  variantAddress?: string;
  /** Chain where the variant lives */
  variantChain?: string;
}

/**
 * Maps Pharos stablecoin ID → yield variant info.
 * Used for DL pool matching (search for variantSymbol) and on-chain rate queries.
 * Coins without an entry here are their OWN yield token (e.g., USDY, BUIDL).
 */
const YIELD_VARIANT_MAP: Record<string, YieldVariant> = {
  "146": { variantSymbol: "sUSDe", variantAddress: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", variantChain: "ethereum" },
  // Add more as discovered during DL pool research
};
```

Coins NOT in this map are assumed to be their own yield token (e.g., USDY accrues yield directly via NAV appreciation, OUSD rebases). The DL pool matching (Section 2.4) searches for both the base symbol AND the variant symbol.

### 2.3 Tier 1: On-Chain Exchange Rate Queries

For lending vault tokens whose yield is most accurately derived from their exchange rate:

| Token | Base Stablecoin | On-Chain Source | Method |
|-------|-----------------|-----------------|--------|
| sUSDe | USDe (146) | sUSDe contract (`0x9D39A5DE30e57443BfF2A8307A4256c8797A3497`) | `convertToAssets(1e18)` |
| wUSDM | USDM (if tracked) | wUSDM contract | `convertToAssets(1e18)` |

**APY derivation from exchange rate:**

```
rate_now = convertToAssets(1e18) at time T
rate_prev = convertToAssets(1e18) at time T - 7 days (from yield_history)
apy_7d = ((rate_now / rate_prev) ^ (365.25 / 7) - 1) * 100
```

This produces a trailing 7-day APY that is immune to protocol dashboard manipulation and represents the actual yield accrued by holders.

**Implementation:** A new `fetchOnChainRates()` function will make `eth_call` RPC requests (reusing the existing `chain-rpcs.ts` infrastructure) to read exchange rates. These are simple view calls with no gas cost. The function will be called within the yield sync cron.

**Rate config:** A static `ON_CHAIN_RATE_CONFIGS` array defines per-token rate sources:

```typescript
interface OnChainRateConfig {
  stablecoinId: string;
  chain: string;           // "ethereum", "arbitrum", etc.
  contract: string;        // vault/wrapper contract address
  selector: string;        // function selector for rate query
  decimals: number;        // return value decimals
  inputAmount: string;     // hex-encoded input (e.g., 1e18)
}
```

Initially configured for sUSDe. More can be added as yield variant research identifies candidates.

### 2.4 Tier 2: DefiLlama Yields API

**Endpoint:** `GET https://yields.llama.fi/pools`

Returns ~18,000 pool records. The DEX liquidity cron (`sync-dex-liquidity.ts`) already fetches this endpoint every 30 minutes. Each pool record includes:

| Field | Type | Relevance |
|-------|------|-----------|
| `pool` | `string` | UUID pool identifier |
| `chain` | `string` | Chain name |
| `project` | `string` | Protocol slug (e.g. `ethena`, `maker`, `ondo-finance`) |
| `symbol` | `string` | Pool asset symbol (e.g. `sUSDe`, `sDAI`) |
| `tvlUsd` | `number` | Pool TVL |
| `apy` | `number` | Current APY (%) |
| `apyBase` | `number \| null` | Base yield (lending/fee APY) |
| `apyReward` | `number \| null` | Incentive/reward APY |
| `apyMean30d` | `number` | 30-day mean APY |
| `stablecoin` | `boolean` | Whether the pool is stablecoin-related |
| `ilRisk` | `string` | Impermanent loss risk |
| `exposure` | `string` | `"single"` for lending, `"multi"` for LP |
| `underlyingTokens` | `string[]` | Token contract addresses |
| `poolMeta` | `string \| null` | Additional metadata |

**Pool-to-stablecoin matching** uses a two-layer approach:

**Layer 1: Static mapping (`YIELD_POOL_MAP`).** A curated record of Pharos stablecoin ID → DeFiLlama pool UUID:

```typescript
/** Maps Pharos stablecoin ID → DeFiLlama pool UUID for deterministic yield matching */
const YIELD_POOL_MAP: Record<string, string> = {
  "146": "uuid-of-susde-staking-pool",     // USDe → sUSDe staking on Ethena
  "237": "uuid-of-usyc-pool",              // USYC → Hashnote T-bill pool
  "129": "uuid-of-usdy-pool",              // USDY → Ondo T-bill pool
  "173": "uuid-of-buidl-pool",             // BUIDL → BlackRock pool
  // ... etc — populated by querying yields.llama.fi/pools during setup
};
```

**Layer 2: Fallback matching (for unmapped coins):**

1. Filter DL pools to `exposure === "single"` and `stablecoin === true`
2. Match `pool.symbol` against both the stablecoin symbol AND the `YIELD_VARIANT_MAP` variant symbol (case-insensitive)
3. Match `pool.project` to `meta.protocolSlug` (if set)
4. Match `pool.underlyingTokens` to `meta.contracts[].address`
5. Select highest-TVL match

**Yield type filtering:** Only consider pools with `exposure === "single"` for native yield tokens. These represent the token's intrinsic yield, not LP returns.

**APY selection:** When multiple pools match a single stablecoin, select the pool with the highest TVL that has `exposure === "single"`.

### 2.5 Tier 3: Price-Derived APY (navTokens)

For navTokens (`navToken: true`) not covered by Tier 1 or Tier 2, derive APY from price appreciation using existing price history:

```
apy = ((price_now / price_30d_ago) ^ (365.25 / 30) - 1) * 100
```

**Data source:** The `supply_history` table already stores prices for all tracked stablecoins (populated by the supply snapshot cron). No additional API calls needed.

**Applicability:** 10 of 15 yield-bearing coins are navTokens. In practice, most will be covered by Tier 2 (DL Yields), but this tier ensures universal coverage for any navToken that DL misses.

**Limitations:**
- No `apyBase` / `apyReward` breakdown (both are null)
- Sensitive to short-term price noise (mitigated by using 30-day window)
- Only applicable to navTokens, not rebasing or fee-sharing tokens

When this tier is used, `dataSource` is set to `"price-derived"`.

### 2.6 Manual Override: `yieldConfig` on StablecoinMeta

For tokens where automated APY sourcing fails, add an optional `yieldConfig` field to `StablecoinMeta`:

```typescript
interface YieldConfig {
  /** DeFiLlama pool UUID for deterministic matching */
  defiLlamaPoolId?: string;
  /** On-chain rate source override */
  onChainRate?: OnChainRateConfig;
  /** Human-readable yield source description */
  yieldSource: string;
  /** Yield mechanism type */
  yieldType: "lending-vault" | "rebase" | "fee-sharing" | "lp-receipt" | "nav-appreciation" | "governance-set";
}
```

### 2.7 Yield Data Model

The unified yield record for each stablecoin:

```typescript
interface YieldData {
  stablecoinId: string;
  currentApy: number;          // current APY (%)
  apy7d: number;               // 7-day trailing average APY
  apy30d: number;              // 30-day trailing average APY
  apyBase: number | null;      // base yield component (excl. incentives)
  apyReward: number | null;    // incentive/reward component
  yieldSource: string;         // human-readable source (e.g., "Maker DSR", "Ethena staking")
  yieldType: string;           // "lending-vault", "rebase", "fee-sharing", etc.
  sourcePool: string | null;   // DL pool UUID if matched
  sourceTvlUsd: number | null; // TVL of the source pool
  dataSource: "defillama" | "onchain" | "price-derived" | "manual"; // where the APY came from
  apyVariance30d: number;      // 30-day APY standard deviation
  updatedAt: number;           // Unix seconds
}
```

---

## 3. Risk-Adjusted Yield Formula

### 3.1 Pharos Yield Score (PYS)

The PYS produces a single number (0-100) that answers: "How good is this yield relative to the risk you're taking?"

**Formula:**

```
PYS = min(100, yieldEfficiency * sustainabilityMultiplier * scalingFactor)
```

Where:

```
yieldEfficiency = apy30d / riskPenalty
riskPenalty = max(0.5, (101 - safetyScore) / 20)
sustainabilityMultiplier = max(0.3, 1.0 - apyVarianceScore)
scalingFactor = 5  (configurable, see calibration note)
```

**Calibration note:** The `scalingFactor` controls score distribution. Starting at 5 (down from 10 in the original draft). This needs calibration against real yield data once the pipeline is running. Example outputs with `scalingFactor = 5`:

| Coin | APY (30d) | Safety Score | Risk Penalty | Yield Eff. | Sustainability | PYS |
|------|-----------|-------------|--------------|------------|----------------|-----|
| Safe RWA (A+, 4.5%) | 4.5 | 90 | 0.55 | 8.18 | 1.0 | 41 |
| Ethena-like (B, 12%) | 12.0 | 65 | 1.80 | 6.67 | 0.85 | 28 |
| Risky high-yield (D, 25%) | 25.0 | 40 | 3.05 | 8.20 | 0.60 | 25 |
| Safe moderate (A, 8%) | 8.0 | 82 | 0.95 | 8.42 | 0.95 | 40 |

The yield page could expose a toggle or slider letting users adjust the safety-vs-yield weighting to explore the tradeoff space interactively. This is a stretch goal for v1 but the formula accommodates it naturally.

**Components explained:**

| Component | Range | Purpose |
|-----------|-------|---------|
| `apy30d` | 0-100+ | 30-day average APY. Uses 30d to smooth daily fluctuations |
| `safetyScore` | 0-100 | Report card `overallScore`. Higher = safer |
| `riskPenalty` | 0.5-5.05 | Converts safety score to a risk divisor. A+ coin (score 90) = penalty 0.55. D coin (score 40) = penalty 3.05. F coin (score 10) = penalty 4.55 |
| `apyVarianceScore` | 0-1 | Normalized 30-day APY coefficient of variation. High variance = lower multiplier |
| `sustainabilityMultiplier` | 0.3-1.0 | Penalizes volatile/unsustainable yields. Stable yields get 1.0x |

**Interpretation:**

| PYS Range | Label | Meaning |
|-----------|-------|---------|
| 80-100 | Excellent | High yield, high safety, stable returns |
| 60-79 | Good | Solid risk-adjusted yield |
| 40-59 | Moderate | Acceptable but with tradeoffs |
| 20-39 | Poor | Either low yield or high risk |
| 0-19 | Avoid | Yield does not compensate for risk |

**Why not a literal Sharpe ratio?** The Sharpe ratio divides excess return by volatility. Here, "excess return" would be APY minus the risk-free rate, and "volatility" would be APY standard deviation. The problem: stablecoin APYs don't have enough history for meaningful volatility stats on many tokens, and peg stability risk is more relevant than APY volatility for stablecoin holders. The PYS uses the report card safety score as a holistic risk measure instead of pure APY volatility, which better captures the actual risks stablecoin holders face (depeg, insolvency, freeze, illiquidity).

### 3.2 Supplementary Metrics

Beyond the PYS, expose raw building blocks for users who want to sort differently:

| Metric | Formula | Use Case |
|--------|---------|----------|
| Raw APY | `apy30d` | Simple yield comparison |
| Yield-to-Risk Ratio | `apy30d / (101 - safetyScore)` | Quick "bang per risk buck" |
| Excess Yield | `apy30d - riskFreeRate` | Yield premium over T-bills |
| Yield Stability | `1 - CV(apy_30d_samples)` | How consistent the yield is (0-1) |

### 3.3 Non-Yield-Bearing Coins

Coins without `yieldBearing: true` do not appear in yield rankings and receive no PYS score. This is not a penalty --- yield-bearing and non-yield-bearing stablecoins serve different purposes.

### 3.4 Coins Without Report Card Grades

If a yield-bearing coin has `overallScore === null` (NR), use a default safety score of 40 (equivalent to a D grade) for PYS computation. This is conservative: unrated coins are assumed risky until proven otherwise.

---

## 4. Data Pipeline

### 4.1 New Cron Job: `sync-yield-data`

**Schedule:** Piggyback on the existing `10,40 * * * *` trigger (Trigger 3), but as a **separate function** in its own file. Not embedded within `sync-dex-liquidity.ts`.

**Rationale for separation:** The DEX liquidity cron is already large and complex (spent significant effort stabilizing it). Adding yield extraction inline increases coupling and debugging difficulty. A separate function with its own error boundary is safer.

**Data sharing:** The DL Yields response is already fetched by `sync-dex-liquidity`. The yield cron fetches `yields.llama.fi/pools` independently --- the endpoint is free, has no rate limit, and the response is ~2MB. The marginal cost of a second fetch every 30 minutes is negligible compared to the operational benefit of full isolation.

**Cron flow:**

```
sync-yield-data (new, separate function, runs on 10,40 trigger)
  |-- fetch DL pools (yields.llama.fi/pools)
  |-- read cached T-bill rate from D1 (fallback to hardcoded 4.25%)
  |-- filter to yield-bearing stablecoins (TRACKED_STABLECOINS where yieldBearing)
  |-- for each yield-bearing coin:
  |    |-- Tier 1: check ON_CHAIN_RATE_CONFIGS → fetchOnChainRates()
  |    |-- Tier 2: check YIELD_POOL_MAP → match DL pool
  |    |   (also try YIELD_VARIANT_MAP variant symbol for fallback matching)
  |    |-- Tier 3: if navToken, compute price-derived APY from supply_history
  |    |-- use first tier that produces a result
  |-- compute 7d/30d averages from yield_history
  |-- compute variance metrics
  |-- compute PYS using report card safety scores
  |-- compute sustainability warning signals
  |-- store current yield snapshot → yield_data
  |-- store historical point → yield_history
  |-- prune yield_history older than 365 days
```

**Frequency:** Every 30 minutes (inherits from `10,40 * * * *`). Yield rates change slowly enough that 30-minute resolution is sufficient. On-chain rate queries every 30 minutes give 48 data points per day, enough to compute accurate trailing averages.

### 4.2 D1 Table Schema

#### `yield_data` --- Current yield snapshot per stablecoin

```sql
-- Migration: 0031_yield_data.sql

CREATE TABLE IF NOT EXISTS yield_data (
  stablecoin_id   TEXT PRIMARY KEY,
  symbol          TEXT NOT NULL,

  -- Current APY values
  current_apy     REAL NOT NULL,       -- current APY (%)
  apy_base        REAL,                -- base yield component
  apy_reward      REAL,                -- incentive/reward component
  apy_7d          REAL NOT NULL,       -- 7-day trailing average
  apy_30d         REAL NOT NULL,       -- 30-day trailing average

  -- Source metadata
  yield_source    TEXT NOT NULL,        -- human-readable (e.g., "Maker DSR")
  yield_type      TEXT NOT NULL,        -- "lending-vault", "rebase", etc.
  source_pool     TEXT,                 -- DL pool UUID
  source_tvl_usd  REAL,                -- TVL of source pool (USD)
  data_source     TEXT NOT NULL,        -- "defillama" | "onchain" | "price-derived" | "manual"

  -- Computed risk-adjusted metrics
  safety_score    REAL,                 -- report card overallScore at sync time
  safety_grade    TEXT,                 -- letter grade at sync time
  pharos_yield_score  REAL,            -- PYS (0-100), NULL if no safety score
  yield_to_risk       REAL,            -- apy30d / (101 - safetyScore)
  excess_yield        REAL,            -- apy30d - riskFreeRate
  yield_stability     REAL,            -- 1 - CV(30d samples)

  -- Variance & sustainability
  apy_variance_30d    REAL,            -- 30-day APY standard deviation
  apy_min_30d         REAL,            -- minimum APY in last 30 days
  apy_max_30d         REAL,            -- maximum APY in last 30 days

  -- On-chain rate (for vault tokens)
  exchange_rate       REAL,            -- current exchange rate (if applicable)
  exchange_rate_prev  REAL,            -- exchange rate 7 days ago

  updated_at      INTEGER NOT NULL     -- Unix seconds
);

CREATE INDEX IF NOT EXISTS idx_yield_pys ON yield_data(pharos_yield_score DESC);
CREATE INDEX IF NOT EXISTS idx_yield_apy ON yield_data(apy_30d DESC);
```

**Note:** `safety_score` and `safety_grade` are stored at sync time rather than live-computed in the API handler. Tradeoff: scores may be up to 30 minutes stale. Acceptable given report card inputs (peg scores, liquidity) update at similar intervals. This avoids the rankings endpoint needing to recompute all grades on every request.

#### `yield_history` --- Historical yield data points

```sql
-- Also in 0031_yield_data.sql

CREATE TABLE IF NOT EXISTS yield_history (
  stablecoin_id   TEXT NOT NULL,
  recorded_at     INTEGER NOT NULL,    -- Unix seconds
  apy             REAL NOT NULL,       -- APY at this point (%)
  apy_base        REAL,
  apy_reward      REAL,
  exchange_rate   REAL,                -- vault exchange rate (if applicable)
  source_tvl_usd  REAL,               -- source pool TVL at this point
  data_source     TEXT NOT NULL,

  PRIMARY KEY (stablecoin_id, recorded_at)
);

CREATE INDEX IF NOT EXISTS idx_yield_hist_coin ON yield_history(stablecoin_id, recorded_at DESC);
```

**Pruning:** Retain 365 days of history. Prune records older than 365 days at the end of each sync run (same pattern as `stability_index_samples`).

**Storage estimate:** ~15 yield-bearing coins * 48 records/day * 365 days = ~262,800 rows/year. Well within D1 limits.

### 4.3 Risk-Free Rate

**Source:** US Treasury Fiscal Data API (free, no API key required).

**Endpoint:**

```
GET https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/avg_interest_rates
  ?filter=security_desc:eq:Treasury Bills
  &sort=-record_date
  &page[size]=1
  &fields=record_date,avg_interest_rate_amt
```

Returns the most recent monthly average T-bill interest rate. Example: `{ "record_date": "2026-01-31", "avg_interest_rate_amt": "3.760" }`.

**Fetch strategy:** Fetched once daily by the `0 8 * * *` cron (Trigger 4, which already runs the daily digest). The rate changes at most once per month, so daily is more than sufficient. The fetched value is stored in a `key_value` table row (or a dedicated `yield_config` row) so the 30-minute yield sync cron can read it from D1 without making an external call.

**Storage:** Stored via the existing `cache` table using `setCache(db, "risk_free_rate", rateValue)` (see `worker/src/lib/db.ts`). The yield sync cron reads it with `getCache(db, "risk_free_rate")` on each run. The daily cron refreshes it.

**Fallback:** If the Treasury API is unavailable, fall back to a hardcoded constant:

```typescript
const RISK_FREE_RATE_FALLBACK = 4.25;
```

The `excessYield` metric uses this directly: `excessYield = apy30d - riskFreeRate`.

**Constants:** Add `TREASURY_FISCAL_DATA_URL` to `worker/src/lib/constants.ts`.

---

## 5. API Design

### 5.1 `GET /api/yield-rankings`

Returns yield data and risk-adjusted scores for all yield-bearing stablecoins.

**Cache:** standard (`public, s-maxage=300, max-age=60`)

**Response:**

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
      "apyMax30d": 15.3
    }
  ],
  "riskFreeRate": 3.76,
  "scalingFactor": 5,
  "updatedAt": 1772000000
}
```

**Sorting:** Default sort by `pharosYieldScore` descending. The frontend can re-sort client-side by any column.

### 5.2 `GET /api/yield-history?stablecoin=ID`

Returns historical APY data points for a single stablecoin.

**Cache:** slow (`public, s-maxage=3600, max-age=300`)

**Required query parameter:**

| Param | Type | Description |
|-------|------|-------------|
| `stablecoin` | `string` | Pharos stablecoin ID (required) |

**Optional query parameter:**

| Param | Type | Default | Bounds | Description |
|-------|------|---------|--------|-------------|
| `days` | `integer` | `90` | 1-365 | Lookback window in days |

**Response:**

```json
[
  {
    "date": 1772000000,
    "apy": 12.4,
    "apyBase": 12.4,
    "apyReward": null,
    "exchangeRate": 1.0847,
    "sourceTvlUsd": 5200000000
  }
]
```

Sorted by `date` ascending, matching the pattern of `supply-history` and `dex-liquidity-history`.

### 5.3 API Handler Files

| File | Endpoint | Purpose |
|------|----------|---------|
| `worker/src/api/yield-rankings.ts` | `GET /api/yield-rankings` | Read from `yield_data` table |
| `worker/src/api/yield-history.ts` | `GET /api/yield-history` | Read from `yield_history` with date bounds |

The yield-rankings handler reads directly from `yield_data` (which includes pre-computed `safety_score` and `safety_grade`). No live report card recomputation needed.

### 5.4 Router & Cache Registration

Add to `worker/src/router.ts`:

```typescript
if (path === "/api/yield-rankings") {
  return handleYieldRankings(db);
}
if (path === "/api/yield-history") {
  return handleYieldHistory(db, url);
}
```

Cache profiles: `yield-rankings` uses standard (5-min edge), `yield-history` uses slow (1-hour edge). Add both endpoints to the health check's `CRON_INTERVALS` map under `sync-yield-data` with interval 1800s.

---

## 6. UI Design: Standalone `/yield/` Page

v1 delivers a single standalone page at `/yield/`. No modifications to the homepage, detail pages, comparison tool, portfolio builder, or daily digest. This allows the data pipeline to be validated before propagating yield data across the site.

### 6.1 Yield Leaderboard Table

Sortable table showing only yield-bearing stablecoins:

| Column | Description |
|--------|-------------|
| Rank | Position by PYS |
| Coin | Logo + name + symbol |
| APY (30d) | 30-day trailing average |
| Safety Grade | Report card letter grade + badge color |
| PYS | Pharos Yield Score (0-100) with color band |
| Yield Source | Short description (e.g., "Ethena staking") |
| Yield Type | Badge: "Vault", "Rebase", "NAV", etc. |
| TVL | Source pool TVL |
| Yield Stability | 0-100% bar |
| 30d Range | Sparkline or `{min}%-{max}%` |

Default sort: PYS descending.

### 6.2 Yield vs Safety Scatter Plot

**The hero visualization.** A Recharts scatter plot:

- **X-axis:** Safety score (0-100), labeled with grade boundaries (F | D | C- | C | ... | A+)
- **Y-axis:** 30-day APY (%)
- **Each dot:** One yield-bearing stablecoin. Dot size proportional to log(market cap). Dot color by yield type.
- **Quadrant labels:**
  - Upper-right (high yield, high safety): "Sweet Spot" (green background tint)
  - Upper-left (high yield, low safety): "Danger Zone" (red background tint)
  - Lower-right (low yield, high safety): "Play It Safe" (blue background tint)
  - Lower-left (low yield, low safety): "Why Bother?" (gray background tint)
- **Reference line:** Horizontal dashed line at `riskFreeRate` (T-bill yield). Coins below this line offer less yield than a risk-free T-bill.
- **Hover tooltip:** Coin name, APY, safety grade, PYS, yield source
- **Click:** Navigate to `/stablecoin/{id}` detail page

**Implementation:** Use Recharts `<ScatterChart>` with `<ReferenceArea>` for quadrant shading and `<ReferenceLine>` for the risk-free rate. Custom dot renderer for variable-size circles with logos.

### 6.3 Aggregate Stats Bar

Three summary cards above the table:

| Card | Content |
|------|---------|
| Average Yield | Weighted average APY across all yield-bearing stablecoins (weighted by circulating supply) |
| Risk-Free Rate | Current T-bill rate (from US Treasury API) |
| Best Risk-Adjusted | Top PYS coin name + score |

### 6.4 Disclaimer

All UI surfaces must include: "Yield data is informational only. APY is not guaranteed and can change at any time. Past performance does not guarantee future results. This is not investment advice."

### 6.5 Frontend Files

| File | Purpose |
|------|---------|
| `src/hooks/use-yield-rankings.ts` | `useYieldRankings()` --- TanStack Query hook for `/api/yield-rankings` |
| `src/hooks/use-yield-history.ts` | `useYieldHistory(stablecoinId, days)` --- hook for `/api/yield-history` |
| `src/app/yield/page.tsx` | Yield intelligence page (SSG metadata) |
| `src/app/yield/client.tsx` | Client component: table, scatter plot, stats |
| `src/components/yield-scatter-plot.tsx` | Recharts scatter plot (yield vs safety) |
| `src/components/yield-leaderboard.tsx` | Sortable yield rankings table |

---

## 7. Yield Sustainability Analysis

### 7.1 Warning Signals

Historical precedent: Anchor Protocol offered 19.5% APY on UST for months before Terra collapsed. The yield was subsidized from Luna Foundation reserves, masking fundamental unsustainability.

**Warning signals (computed per coin in the cron):**

| Signal | Formula | Threshold | Meaning |
|--------|---------|-----------|---------|
| **Yield Spike** | `currentApy / apy30d > 2.0` | 2x recent average | Sudden yield increase, possibly unsustainable |
| **Yield Divergence** | `currentApy > median(all yield coins) * 3` | 3x market median | Outlier yield relative to peers |
| **Negative Trend** | `apy7d < apy30d * 0.7` | 30% decline | Yield falling rapidly |
| **High Variance** | `CV(30d samples) > 0.5` | CV > 50% | Yield is wildly inconsistent |
| **Reward-Heavy** | `apyReward / apy > 0.8` | 80% incentive | Yield depends on token incentives, not organic revenue |
| **TVL Outflow** | `sourceTvlUsd 7d change < -20%` | 20% weekly decline | Smart money leaving |

These signals are surfaced in the yield leaderboard as warning badges (e.g., amber icon with tooltip). They inform user judgment but do not feed into the PYS formula in v1.

---

## 8. Edge Cases

### 8.1 Variable vs Fixed Rates

| Rate Type | Examples | Handling |
|-----------|----------|----------|
| Variable (market-driven) | sUSDe, OUSD | APY fluctuates; use 30d average for PYS |
| Governance-set | USDB yield | Changes discretely; on-chain rate preferred over DL APY |
| Fixed-term | Some RWA tokens (TBILL, BUIDL) | APY stable; low variance is expected, not a positive signal |

For governance-set rates, detect discrete jumps (APY changes by >50% in a single observation) and annotate in the history chart.

### 8.2 Multi-Source Yield

Some tokens accrue yield from multiple mechanisms (e.g., base lending yield + reward token incentives). The DL Yields API separates `apyBase` and `apyReward`. Store both:

- `apyBase` = sustainable, fee-derived yield
- `apyReward` = incentive yield (less sustainable, token-emission dependent)

The sustainability analysis uses `apyReward / apy` ratio as a warning signal.

### 8.3 New Yield-Bearing Coins (No History)

When a new yield-bearing coin is added to `TRACKED_STABLECOINS`:

1. First sync: `apy7d` and `apy30d` equal `currentApy` (no history to average)
2. PYS uses `currentApy` as `apy30d` substitute
3. `yieldStability` is null (insufficient data)
4. After 7 days: `apy7d` becomes meaningful
5. After 30 days: all metrics are fully populated

The UI shows "New" badge and "(< 30d of data)" caveat next to the PYS.

### 8.4 Yield-Bearing Coins Not in Any Tier

If a yield-bearing coin has no on-chain rate config, no DL pool match, and is not a navToken:

1. Check `yieldConfig.defiLlamaPoolId` manual override
2. If still no match, mark as `dataSource: "unavailable"`
3. Show "Yield data unavailable" in UI instead of a number
4. No PYS computed
5. Log a warning in the cron run metadata so it appears in the status dashboard

### 8.5 Negative Yield Scenarios

Negative APY can occur when:
- Vault exchange rate decreases (rare, indicates loss event)
- Lending rate drops below protocol fees
- navToken price decreases over the measurement window

Handle by:
- Storing negative values as-is (do not clamp to 0)
- PYS formula naturally produces low scores for negative yields
- Show negative APY in red text

### 8.6 Rate Limiting and API Budget

DefiLlama Yields API has no rate limit and no API key requirement. On-chain RPC calls are view-only (`eth_call`) and use the existing Alchemy/dRPC endpoints, adding 2-3 calls per sync cycle. Price-derived APY uses data already in D1 (zero external calls). Total additional API budget: negligible.

---

## 9. Implementation Plan

### Phase 1: Data Pipeline

1. Add `YieldConfig` type and `yieldConfig` field to `StablecoinOpts`; populate for all 15 yield-bearing coins
2. Build `YIELD_VARIANT_MAP` by researching which tracked coins have separate yield wrapper tokens
3. Create migration `0031_yield_data.sql` with `yield_data` and `yield_history` tables
4. Build `YIELD_POOL_MAP` by querying DL Yields and recording pool UUIDs for each yield-bearing coin
5. Implement `sync-yield-data.ts` with three-tier APY resolution
6. Implement `fetchOnChainRates()` for sUSDe exchange rate queries (using `chain-rpcs.ts`)
7. Implement price-derived APY computation for navTokens (reading from `supply_history`)
8. Implement PYS computation with hardcoded risk-free rate
9. Add sustainability warning signal detection
10. Wire into `worker/src/index.ts` on the `10,40` trigger
11. Worker type-check: `cd worker && npx tsc --noEmit`

### Phase 2: API Layer

1. Create `worker/src/api/yield-rankings.ts` and `worker/src/api/yield-history.ts`
2. Register routes in `router.ts`
3. Add to health check cache monitoring and `CRON_INTERVALS`
4. Test endpoints with `wrangler dev`

### Phase 3: Frontend --- Standalone `/yield/` Page

1. Create TanStack Query hooks: `use-yield-rankings.ts`, `use-yield-history.ts`
2. Build `/yield/` page with leaderboard table
3. Build yield vs safety scatter plot component
4. Add aggregate stats bar
5. Add `/yield/` to sidebar navigation (`nav-config.ts`)
6. `npm run build` to verify static export

### Phase 4: Polish & Validation

1. Create admin backfill endpoint for historical yield data
2. Backfill DL yield history (DL provides historical APY via `/pools/{poolId}/chart`)
3. Monitor yield data quality for 1-2 weeks before Phase 2 integration
4. Calibrate PYS scaling factor against real data
5. Test mobile responsiveness

---

## 10. Key Files Summary

### New Files

| File | Purpose |
|------|---------|
| `worker/migrations/0031_yield_data.sql` | D1 schema: `yield_data` and `yield_history` tables |
| `worker/src/cron/sync-yield-data.ts` | Yield sync cron: three-tier APY resolution, PYS computation |
| `worker/src/api/yield-rankings.ts` | `GET /api/yield-rankings` handler |
| `worker/src/api/yield-history.ts` | `GET /api/yield-history` handler |
| `src/hooks/use-yield-rankings.ts` | TanStack Query hook for yield rankings |
| `src/hooks/use-yield-history.ts` | TanStack Query hook for yield history |
| `src/app/yield/page.tsx` | Yield page SSG wrapper |
| `src/app/yield/client.tsx` | Yield page interactive client |
| `src/components/yield-scatter-plot.tsx` | Yield vs safety scatter chart |
| `src/components/yield-leaderboard.tsx` | Sortable yield rankings table |

### Modified Files

| File | Change |
|------|--------|
| `src/lib/types.ts` | Add `YieldData`, `YieldHistoryPoint`, `YieldRankingsResponse` types |
| `src/lib/stablecoins.ts` | Add `yieldConfig` to `StablecoinOpts` and populate for yield-bearing coins |
| `worker/src/router.ts` | Register `/api/yield-rankings` and `/api/yield-history` routes |
| `worker/src/index.ts` | Call `syncYieldData()` on `10,40` trigger |
| `worker/src/lib/constants.ts` | Add `TREASURY_FISCAL_DATA_URL`, `RISK_FREE_RATE_FALLBACK`, `DEFILLAMA_YIELD_CHART_URL` |
| `worker/src/api/health.ts` | Add `yield-data` cache status |
| `worker/src/api/status.ts` | Add `sync-yield-data` to `CRON_INTERVALS` |
| `src/lib/nav-config.ts` | Add `/yield/` to sidebar navigation |
| `docs/architecture.md` | Add yield files to file tree |
| `docs/api-reference.md` | Document new endpoints |

---

## 11. Phase 2 / Future Integration

The following features are **deferred until the yield data pipeline has been validated in production** (recommend 2-4 weeks of monitoring). They build on the standalone `/yield/` page and API endpoints delivered in v1.

### 11.1 Homepage Integration

- **APY column** in `stablecoin-table.tsx`: show `apy30d` for yield-bearing coins, `--` for others. Green text, sortable.
- **Yield Intelligence summary card** on the homepage (alongside PSI, Liquidity, Blacklist cards): average yield, risk-free rate, top PYS coin.

### 11.2 Detail Page: Yield Section

For yield-bearing stablecoins, add a yield info card to `stablecoin/[id]/client.tsx`:
- Current APY, 7d/30d averages, PYS, yield source, yield type, source pool TVL
- APY history chart (area chart, 7d/30d/90d/1y time ranges, base vs reward breakdown)

### 11.3 Portfolio Builder: Weighted Yield

Extend `stress-test-panel.tsx` with a "Portfolio Yield" metric:
- `portfolioYield = sum(coinApy30d * coinAmount) / sum(coinAmount)`
- Display alongside the existing portfolio grade

### 11.4 Comparison Tool

Add yield comparison rows to `comparison-table.tsx` (APY, yield score, yield source, yield stability) and an APY comparison line chart option in `comparison-chart.tsx`.

### 11.5 Daily Digest Integration

Extend `DigestInputData` with `yieldHighlights`:
- Highest PYS coin, biggest APY change, yield anomalies, average yield, risk-free rate
- The LLM prompt can weave yield narrative into the digest

### 11.6 Depeg Early Warning Integration

Flag yield-bearing stablecoins where `currentApy > apy30d * 2.5 AND currentApy > 20%` in the PSI input snapshot. Enriches digest LLM and status dashboard context.

### 11.7 Yield Anomaly Database

Maintain a `yield_anomalies` table tracking historical anomaly events (spikes, divergences, collapses) with detection/resolution timestamps. Useful for pattern analysis and educational content.

### 11.8 Cemetery Correlation

Cross-reference yield history with `DEAD_STABLECOINS` data. Compute average APY of dead stablecoins in their final 90 days. Educational content for the yield page.

### 11.9 Methodology Page

Add a "Yield Intelligence" section to `/methodology/page.tsx`: PYS formula, data sources, sustainability signals, scatter plot quadrants, limitations.

### 11.10 Report Card Integration

Consider a future 6th dimension: "Yield Sustainability" for yield-bearing coins, using yield health signals as a dimension-level input. Requires yield data maturity (3+ months of collection).

---

## 12. Future Enhancements (Beyond Phase 2)

### 12.1 Yield Alerts

User-configurable alerts (requires notification infrastructure):
- "Alert me when sUSDe APY drops below 5%"
- "Alert me when any coin's PYS drops below 30"
- "Alert me when a new yield anomaly is detected"

### 12.2 Yield Strategy Recommendations

Based on user's risk profile (derived from portfolio analyzer):
- Conservative: "Your portfolio could earn 2.1% more by shifting X% from USDC to sDAI (safety grade: A-)"
- Moderate: "Adding sUSDe would increase portfolio yield by 3.5% with a grade drop from A to B+"
- These are educational, not financial advice. Clear disclaimers required.

### 12.3 Historical Yield Comparisons

"sUSDe vs sDAI: 6-month yield comparison" chart, exportable as shareable image (reusing `compare-share-image.ts` pattern).

### 12.4 Yield Decomposition

For complex yield sources, break down where the yield comes from:
- Ethena: funding rate % + staking reward %
- Maker: DSR base rate + stability fee surplus
- RWA tokens: T-bill rate - management fee

### 12.5 Chain-Specific Yields

Some tokens offer different yields on different chains (e.g., bridged versions may have additional incentives). Track per-chain yield where data is available.

### 12.6 Yield Correlation Matrix

Show how yields move together. High correlation between sUSDe and sDAI yields would indicate they share underlying drivers. Low correlation means true diversification.

### 12.7 User-Adjustable PYS Weighting

Interactive slider on the yield page letting users adjust the safety-vs-yield weighting to explore the tradeoff space. The formula's `scalingFactor` naturally accommodates this.

---

## 13. Risk & Limitations

### 13.1 Data Quality

- DL Yields API may have stale or incorrect APY for some pools
- On-chain exchange rates can be temporarily manipulated (flash loans)
- Price-derived APY is sensitive to short-term price noise
- Mitigation: Cross-validate DL APY vs on-chain rate where both are available; flag discrepancies >2x

### 13.2 APY vs Realized Yield

APY is the instantaneous annualized rate. Actual realized yield over a holding period may differ due to:
- Rate changes during the period
- Gas costs for claiming/compounding
- Smart contract risk (yield token could lose value)

The PYS accounts for this partially via the safety score, but users should understand the distinction.

### 13.3 Yield-Washing

Protocols can temporarily boost APY through incentive programs to attract TVL. The `apyReward / apy` signal helps detect this, but sophisticated schemes (where incentives are disguised as "base" yield) may escape detection.

### 13.4 PYS Calibration

The scaling factor and formula weights need calibration against real data. Initial values are educated guesses. Plan to revisit after 2-4 weeks of data collection.
