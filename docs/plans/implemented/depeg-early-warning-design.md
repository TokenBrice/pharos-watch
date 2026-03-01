# Depeg Early Warning Score ("Breaking the Buck" Probability)

**Date:** 2026-03-01
**Status:** Draft

---

## 1. Overview & Motivation

Pharos already answers "is this coin depegged?" via the depeg detection pipeline (`depeg_events`, `depeg_pending`), and "how healthy is the market overall?" via the Pharos Stability Index (PSI). But neither answers the question every stablecoin holder actually cares about: **"is MY coin about to depeg?"**

The Depeg Early Warning Score (DEWS) is a forward-looking, per-coin stress signal that estimates the probability of an imminent depeg. It produces a 0-100 score for each tracked stablecoin, where:

- **0** = no detectable stress signals
- **100** = every precursor indicator is flashing red

This is not a binary "depegged / not depegged" detector (that already exists). It is a composite of six leading indicators that, historically, precede actual depeg events by hours to days. The score should have elevated **before** historical depegs, not during them.

### Why This Matters

1. **Actionable early signal.** Users can set their own thresholds and take protective action before a depeg materializes.
2. **Fills the gap between static grades and real-time detection.** Report card grades update slowly (daily). PSI is ecosystem-wide, not per-coin. Depeg detection fires only after the threshold is breached. DEWS sits in the middle: per-coin, updated frequently, forward-looking.
3. **Backtestable.** With 100+ historical depeg events and deep historical data in D1, we can validate that the score would have flagged known depegs before they happened.
4. **Digestible.** A single 0-100 number with named threat bands makes risk communication intuitive.

---

## 2. Score Architecture

### 2.1 Composite Formula

```
DEWS = clamp(0, 100, round(
    W_supply  * S_supply  +
    W_pool    * S_pool    +
    W_liq     * S_liq     +
    W_price   * S_price   +
    W_diverg  * S_diverg  +
    W_black   * S_black
))
```

All sub-signals (S) are normalized to 0-100. Weights (W) sum to 1.0.

### 2.2 Sub-Signals & Weights

| Signal | Weight | Data Source | Update Cadence | What It Detects |
|--------|--------|-------------|----------------|-----------------|
| Supply Velocity (`S_supply`) | 0.25 | `supply_history` + stablecoins cache | 15 min | Rapid redemptions (bank run) |
| Pool Balance Drift (`S_pool`) | 0.20 | `dex_liquidity` (`weighted_balance_ratio`, `top_pools_json`) | 30 min | One-sided selling pressure in DEX pools |
| Liquidity Erosion (`S_liq`) | 0.15 | `dex_liquidity_history` | 30 min | Liquidity providers fleeing |
| Price Confidence Degradation (`S_price`) | 0.15 | stablecoins cache (`priceConfidence`, `priceSource`) | 15 min | Data source failures, oracle problems |
| Cross-Source Price Divergence (`S_diverg`) | 0.15 | `dex_prices` + stablecoins cache | 15 min / 30 min | Fragmented pricing, trust breakdown |
| Blacklist Activity (`S_black`) | 0.10 | `blacklist_events` | 20 min | Issuer emergency response (freeze surge) |

**Weight rationale:** Supply velocity and pool balance drift are the strongest leading indicators because they reflect actual capital flows. Price confidence and divergence capture information asymmetry. Liquidity erosion is a medium-term signal. Blacklist activity is rare but highly specific when it occurs.

### 2.3 Sub-Signal Definitions

#### 2.3.1 Supply Velocity (`S_supply`)

Measures the rate of change in circulating supply. A stablecoin experiencing a bank run sees rapid supply contraction as holders redeem.

**Inputs:**
- `circulating` (current, from stablecoins cache)
- `circulatingPrevDay` (from stablecoins cache)
- `circulatingPrevWeek` (from stablecoins cache)
- `supply_history` rows for 30-day lookback (for trend validation)

**Computation:**

```typescript
// 1-day supply change (percentage)
const delta1d = (current - prevDay) / prevDay;

// 7-day supply change (percentage)
const delta7d = (current - prevWeek) / prevWeek;

// Use the worse (more negative) signal, but weight 1d higher for urgency
const rawVelocity = 0.6 * normalize1d(delta1d) + 0.4 * normalize7d(delta7d);

S_supply = clamp(0, 100, rawVelocity);
```

**Normalization curves (contraction only -- expansion never contributes stress):**

| 1d Change | `normalize1d` | Reasoning |
|-----------|---------------|-----------|
| >= 0 | 0 | Growth = no stress |
| -1% | 15 | Normal redemption activity |
| -3% | 40 | Elevated -- notable single-day outflow |
| -5% | 65 | High -- bank-run velocity for large coins |
| -10% | 85 | Severe -- UST-territory |
| -20%+ | 100 | Maximum stress |

| 7d Change | `normalize7d` | Reasoning |
|-----------|---------------|-----------|
| >= 0 | 0 | Growth = no stress |
| -3% | 15 | Normal weekly fluctuation |
| -7% | 40 | Elevated -- sustained outflows |
| -15% | 70 | High -- extended run |
| -30%+ | 100 | Maximum stress |

The normalization uses a piecewise linear interpolation between these anchor points:

```typescript
function normalizeSupply1d(deltaPct: number): number {
  if (deltaPct >= 0) return 0;
  const abs = Math.abs(deltaPct) * 100; // convert to percentage points
  // Anchor points: [threshold%, score]
  const anchors: [number, number][] = [
    [0, 0], [1, 15], [3, 40], [5, 65], [10, 85], [20, 100],
  ];
  return piecewiseLinear(abs, anchors);
}

function normalizeSupply7d(deltaPct: number): number {
  if (deltaPct >= 0) return 0;
  const abs = Math.abs(deltaPct) * 100;
  const anchors: [number, number][] = [
    [0, 0], [3, 15], [7, 40], [15, 70], [30, 100],
  ];
  return piecewiseLinear(abs, anchors);
}
```

**Size-adjusted sensitivity:** Small coins (<$50M) have naturally volatile supply. Apply a dampening factor:

```typescript
const sizeFactor = Math.min(1, Math.log10(Math.max(mcapUsd, 1e6) / 1e6) / 3);
// $1M -> 0, $10M -> 0.33, $100M -> 0.67, $1B+ -> 1.0
S_supply = rawVelocity * sizeFactor;
```

#### 2.3.2 Pool Balance Drift (`S_pool`)

DEX pool imbalances are one of the earliest visible signals of selling pressure. When a stablecoin is being dumped, pools become heavily one-sided.

**Inputs:**
- `weighted_balance_ratio` from `dex_liquidity` (TVL-weighted average across pools)
- `avg_pool_stress` from `dex_liquidity` (composite 0-1 stress metric)
- `top_pools_json` from `dex_liquidity` (per-pool balance ratios)

**Computation:**

```typescript
// weighted_balance_ratio: 1.0 = perfectly balanced, 0.0 = completely one-sided
// avg_pool_stress: 0 = healthy, 1 = maximum stress
// Invert balance ratio so higher = more stress
const balanceStress = (1 - weightedBalanceRatio) * 100;

// Pool stress already normalized 0-1, scale to 0-100
const poolStressScore = avgPoolStress * 100;

// Check for extreme imbalance in any single large pool (top pools by TVL)
let worstPoolSignal = 0;
for (const pool of topPools) {
  if (pool.tvlUsd >= 100_000) { // only pools with meaningful TVL
    const ratio = pool.extra?.balanceRatio ?? 1.0;
    const imbalance = (1 - ratio) * 100;
    worstPoolSignal = Math.max(worstPoolSignal, imbalance);
  }
}

// Blend: overall balance drift + pool stress + worst single pool
S_pool = clamp(0, 100,
  0.40 * balanceStress +
  0.35 * poolStressScore +
  0.25 * worstPoolSignal
);
```

**Normalization (balance ratio to stress):**

| Balance Ratio | Stress Level | Meaning |
|---------------|-------------|---------|
| 0.95-1.00 | 0-5 | Healthy, normal range |
| 0.80-0.94 | 5-25 | Mild drift, typical for low-volume pools |
| 0.60-0.79 | 25-55 | Elevated -- notable selling pressure |
| 0.40-0.59 | 55-80 | High -- significant imbalance |
| <0.40 | 80-100 | Severe -- pool nearly drained of one side |

**Edge case:** Coins with no DEX liquidity data (`weighted_balance_ratio` is null) receive `S_pool = 0` (no signal, not alarm). The absence of DEX data is already penalized in report card grades.

#### 2.3.3 Liquidity Erosion (`S_liq`)

When liquidity providers sense danger, they withdraw. This is detectable as a declining liquidity score or TVL over days.

**Inputs:**
- `dex_liquidity_history` rows for the coin (last 30 days)
- Current `liquidity_score` from `dex_liquidity`

**Computation:**

```typescript
// 7-day liquidity score delta
const score7dAgo = history.find(h => h.date >= nowSec - 7 * 86400)?.score;
const scoreDelta7d = (currentScore - score7dAgo) / Math.max(score7dAgo, 1);

// 7-day TVL delta
const tvl7dAgo = history.find(h => h.date >= nowSec - 7 * 86400)?.tvl;
const tvlDelta7d = tvl7dAgo > 0 ? (currentTvl - tvl7dAgo) / tvl7dAgo : 0;

// Score erosion component (liquidity score declining)
const scoreErosion = scoreDelta7d < 0
  ? piecewiseLinear(Math.abs(scoreDelta7d) * 100, [
      [0, 0], [5, 15], [15, 40], [30, 70], [50, 100],
    ])
  : 0;

// TVL erosion component (raw TVL declining)
const tvlErosion = tvlDelta7d < 0
  ? piecewiseLinear(Math.abs(tvlDelta7d) * 100, [
      [0, 0], [10, 15], [25, 40], [50, 70], [75, 100],
    ])
  : 0;

S_liq = clamp(0, 100, 0.5 * scoreErosion + 0.5 * tvlErosion);
```

**Edge case:** Coins with fewer than 7 days of liquidity history receive `S_liq = 0`.

#### 2.3.4 Price Confidence Degradation (`S_price`)

When price feeds become unreliable, it signals that data infrastructure is breaking down around a coin. This often precedes or accompanies depegs.

**Inputs:**
- `priceConfidence` from stablecoins cache: `"high"` | `"single-source"` | `"low"` | `"fallback"`
- `priceSource` from stablecoins cache
- `price` (current price, may be null)

**Computation:**

```typescript
const CONFIDENCE_SCORES: Record<string, number> = {
  "high": 0,
  "single-source": 25,
  "low": 60,
  "fallback": 80,
};

let S_price = CONFIDENCE_SCORES[priceConfidence] ?? 0;

// No price at all = maximum concern
if (price === null || price === undefined || !Number.isFinite(price)) {
  S_price = 100;
}
```

**Why this works:** The dual-primary validation (`fetchDualPrimaryPrices`) already classifies confidence. A coin dropping from "high" to "low" means DL and CG disagree by >50bps -- a concrete signal. "Fallback" means the primary sources failed entirely and we're relying on CMC or DexScreener.

**State tracking for transitions:** To detect *degradation* (the transition matters more than the current state), the cron stores the previous confidence level and applies a bonus when confidence has dropped:

```typescript
// If confidence degraded since last run, add transition bonus
if (prevConfidence && CONFIDENCE_SCORES[priceConfidence] > CONFIDENCE_SCORES[prevConfidence]) {
  S_price = Math.min(100, S_price + 15); // degradation transition bonus
}
```

#### 2.3.5 Cross-Source Price Divergence (`S_diverg`)

When DL price, CG price, and DEX-implied price disagree, the market is fragmented. This is one of the earliest depeg signals.

**Inputs:**
- Primary price from stablecoins cache
- DEX-implied price from `dex_prices` table (`dex_price_usd`, `deviation_from_primary_bps`)
- Peg reference price

**Computation:**

```typescript
// Primary deviation from peg (in absolute bps)
const primaryDevBps = price && pegRef > 0
  ? Math.abs(((price / pegRef) - 1) * 10000)
  : 0;

// DEX deviation from peg (in absolute bps)
const dexDevBps = dexPriceUsd && pegRef > 0
  ? Math.abs(((dexPriceUsd / pegRef) - 1) * 10000)
  : 0;

// Cross-source spread (DL/CG vs DEX disagreement, in absolute bps)
const crossSpreadBps = dexPriceUsd && price
  ? Math.abs(((price / dexPriceUsd) - 1) * 10000)
  : 0;

// Use the maximum of: primary deviation, DEX deviation, and cross-source spread
const worstBps = Math.max(primaryDevBps, dexDevBps, crossSpreadBps);

S_diverg = piecewiseLinear(worstBps, [
  [0, 0],       // At peg
  [25, 10],     // 25bps -- normal noise
  [50, 25],     // 50bps -- the DL/CG cross-check threshold
  [75, 50],     // 75bps -- approaching depeg threshold
  [100, 75],    // 100bps -- at the depeg threshold
  [200, 90],    // 200bps -- clearly depegged territory
  [500, 100],   // 500bps+ -- maximum
]);
```

**Important:** This signal specifically targets the *sub-threshold* zone (0-100bps) where DEWS is most useful. Once a coin has crossed 100bps, the depeg detection pipeline takes over. DEWS adds value in the 25-99bps range where something is visibly wrong but hasn't triggered a formal depeg event yet.

**Edge case:** Coins with no DEX price data contribute only the primary deviation component.

#### 2.3.6 Blacklist Activity (`S_black`)

A spike in freeze/blacklist events for a specific stablecoin may indicate the issuer responding to an emerging crisis.

**Inputs:**
- `blacklist_events` for the specific stablecoin in the last 24h and 7d
- Only applies to USDC, USDT, PAXG, XAUT (tracked stablecoins in the blacklist system)

**Computation:**

```typescript
// Count blacklist+destroy events in the last 24h and 7d
const events24h = countBlacklistEvents(stablecoin, nowSec - 86400, nowSec);
const events7d = countBlacklistEvents(stablecoin, nowSec - 7 * 86400, nowSec);

// Daily rate in the last 7 days
const dailyRate7d = events7d / 7;

// Spike detection: is 24h count significantly above the 7d daily average?
const spikeRatio = dailyRate7d > 0 ? events24h / dailyRate7d : events24h;

// Raw signal from 24h count
const rawCount = piecewiseLinear(events24h, [
  [0, 0], [2, 10], [5, 30], [10, 55], [20, 80], [50, 100],
]);

// Spike multiplier (unusual burst relative to baseline)
const spikeMult = piecewiseLinear(spikeRatio, [
  [0, 0.5], [1, 0.7], [3, 1.0], [5, 1.2], [10, 1.5],
]);

S_black = clamp(0, 100, rawCount * spikeMult);
```

**Edge case:** Stablecoins not tracked in the blacklist system (most of the ~145 coins) receive `S_black = 0`. This is correct: the signal is unavailable, so it contributes nothing. The weight is redistributed (see Section 2.4).

### 2.4 Weight Redistribution for Missing Signals

Not all coins have all signal sources. The system redistributes weights proportionally when a signal is unavailable:

```typescript
interface SignalResult {
  value: number;         // 0-100
  available: boolean;    // false if data is missing
  confidence: number;    // 0-1, how reliable is this reading
}

function computeDEWS(signals: Record<string, SignalResult>): number {
  const weights: Record<string, number> = {
    supply: 0.25, pool: 0.20, liq: 0.15,
    price: 0.15, diverg: 0.15, black: 0.10,
  };

  let totalWeight = 0;
  let weightedSum = 0;

  for (const [key, signal] of Object.entries(signals)) {
    if (signal.available) {
      totalWeight += weights[key];
      weightedSum += weights[key] * signal.value;
    }
  }

  // Require at least 2 available signals to produce a score
  if (totalWeight < 0.30) return 0; // insufficient data

  // Normalize to 0-100
  return Math.round(clamp(0, 100, weightedSum / totalWeight));
}
```

**Minimum signal requirement:** At least 2 signal sources must be available (total weight >= 0.30) to produce a non-zero score. This prevents a single noisy signal from dominating.

---

## 3. Condition Bands

The 0-100 score maps to five named threat levels. Band names use weather/seismology metaphors consistent with PSI's geological theme.

| Range | Band | Color | Hex | Description |
|-------|------|-------|-----|-------------|
| 0-15 | **CALM** | Green | `#22c55e` | All clear. No stress signals detected. Business as usual. |
| 16-35 | **WATCH** | Teal | `#14b8a6` | Mild stress detected on 1-2 indicators. Worth monitoring but not alarming. |
| 36-55 | **ALERT** | Yellow | `#eab308` | Multiple indicators elevated. Concrete reasons for caution. |
| 56-75 | **WARNING** | Orange | `#f97316` | Strong stress signals. Depeg is plausible within hours to days. |
| 76-100 | **DANGER** | Red | `#ef4444` | All precursors firing. Depeg is imminent or actively unfolding. |

### Band Transition Logic

Band transitions are the headline event and should be prominently surfaced:

```typescript
type ThreatBand = "CALM" | "WATCH" | "ALERT" | "WARNING" | "DANGER";

function getThreatBand(score: number): ThreatBand {
  if (score <= 15) return "CALM";
  if (score <= 35) return "WATCH";
  if (score <= 55) return "ALERT";
  if (score <= 75) return "WARNING";
  return "DANGER";
}
```

### Calibration Targets

These are the expected band assignments for known historical scenarios. The backtesting phase (Section 6) will validate and may require threshold adjustments.

| Scenario | Expected Band | Target Score | Key Signals |
|----------|--------------|-------------|-------------|
| Normal day, no stress | CALM | 0-10 | All sub-signals near zero |
| USDT brief 30bps wobble (recovered in hours) | WATCH | 20-30 | S_diverg elevated, others flat |
| USDC SVB weekend (pre-depeg, Friday night) | ALERT-WARNING | 45-65 | S_supply (redemptions), S_diverg (price divergence), S_pool (pool drift) |
| UST pre-collapse (Anchor outflows starting) | WARNING-DANGER | 60-80 | S_supply (mass exodus), S_pool (heavy imbalance), S_liq (LP flight) |
| Actively depegged coin | DANGER | 75-100 | All signals maxed |

---

## 4. Data Pipeline

### 4.1 New Table: `stress_signals`

The DEWS computation writes per-coin results to a dedicated table. Each row captures the composite score plus sub-signal values for debugging and historical analysis.

**Migration: `0031_stress_signals.sql`**

```sql
CREATE TABLE IF NOT EXISTS stress_signals (
  stablecoin_id TEXT NOT NULL,
  computed_at   INTEGER NOT NULL,    -- Unix seconds
  score         REAL NOT NULL,       -- Composite DEWS 0-100
  band          TEXT NOT NULL,       -- CALM | WATCH | ALERT | WARNING | DANGER
  signals_json  TEXT NOT NULL,       -- JSON: per-signal breakdown
  PRIMARY KEY (stablecoin_id, computed_at)
);

CREATE INDEX idx_stress_computed ON stress_signals(computed_at DESC);
CREATE INDEX idx_stress_coin_date ON stress_signals(stablecoin_id, computed_at DESC);
```

**`signals_json` shape:**

```json
{
  "supply":  { "value": 12, "available": true, "delta1d": -0.8, "delta7d": -2.1 },
  "pool":    { "value": 45, "available": true, "balanceRatio": 0.72, "worstPool": 0.55 },
  "liq":     { "value": 8,  "available": true, "scoreDelta7d": -3.2, "tvlDelta7d": -5.1 },
  "price":   { "value": 25, "available": true, "confidence": "single-source", "prevConfidence": "high" },
  "diverg":  { "value": 18, "available": true, "primaryBps": 15, "dexBps": 32, "spreadBps": 17 },
  "black":   { "value": 0,  "available": false }
}
```

### 4.2 History Table: `stress_signal_history`

Daily snapshots for charting the score over time.

**Migration: `0032_stress_signal_history.sql`**

```sql
CREATE TABLE IF NOT EXISTS stress_signal_history (
  stablecoin_id TEXT NOT NULL,
  snapshot_date INTEGER NOT NULL,    -- UTC midnight epoch seconds
  score         REAL NOT NULL,
  band          TEXT NOT NULL,
  signals_json  TEXT NOT NULL,
  PRIMARY KEY (stablecoin_id, snapshot_date)
);

CREATE INDEX idx_stress_hist_date ON stress_signal_history(snapshot_date DESC);
```

### 4.3 Cron Job Design

**File:** `worker/src/cron/compute-dews.ts`

**Schedule:** Piggybacked on the `*/15 * * * *` trigger (Trigger 1), running after `syncStablecoins()` completes. This ensures fresh price and supply data.

**Rationale for 15-minute cadence:** DEWS needs fresh supply and price data (from `syncStablecoins`), and the signal should update frequently enough to catch rapid deterioration. The 15-minute cadence matches the depeg detection pipeline and PSI updates.

**Execution flow:**

```
syncStablecoins() completes
    |
    +---> computeAndStoreDEWS(db)
              |
              1. Read stablecoins cache (supply, prices, confidence)
              2. Read dex_liquidity table (pool metrics, DEX prices)
              3. Read dex_liquidity_history (7d lookback per coin)
              4. Read blacklist_events (24h + 7d counts)
              5. Read previous stress_signals (for confidence transitions)
              6. For each PSI-eligible stablecoin:
              |   a. Compute all 6 sub-signals
              |   b. Apply weight redistribution
              |   c. Compute composite DEWS
              |   d. Determine threat band
              |   e. Build INSERT statement
              7. Batch execute all INSERTs (INSERT OR REPLACE)
              8. Prune old rows (keep last 7 days of 15-min samples)
              9. If first run of UTC day: also INSERT into stress_signal_history
```

**Registration in `worker/src/index.ts`:**

```typescript
// Inside the */15 trigger block, after stablecoinsSync:
stablecoinsSync.then(() =>
  logCronRun(db, "compute-dews", () => computeAndStoreDEWS(db))
);
```

**Daily snapshot logic (inside the cron):**

```typescript
const nowUtc = new Date();
const todayMidnight = Math.floor(
  Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate()) / 1000
);

// Check if we already have a snapshot for today
const existing = await db.prepare(
  "SELECT 1 FROM stress_signal_history WHERE snapshot_date = ? LIMIT 1"
).bind(todayMidnight).first();

if (!existing) {
  // First run of the day: write daily snapshot
  const historyStmts = results.map(r =>
    db.prepare(
      "INSERT OR REPLACE INTO stress_signal_history (stablecoin_id, snapshot_date, score, band, signals_json) VALUES (?, ?, ?, ?, ?)"
    ).bind(r.stablecoinId, todayMidnight, r.score, r.band, JSON.stringify(r.signals))
  );
  await batchExecute(db, historyStmts);
}
```

**Pruning:**

```typescript
// Keep 7 days of 15-min samples in stress_signals
const cutoff = nowSec - 7 * 86400;
await db.prepare("DELETE FROM stress_signals WHERE computed_at < ?").bind(cutoff).run();

// Keep 365 days of daily snapshots in stress_signal_history
const historyCutoff = nowSec - 365 * 86400;
await db.prepare("DELETE FROM stress_signal_history WHERE snapshot_date < ?").bind(historyCutoff).run();
```

### 4.4 Pure Compute Function

**File:** `worker/src/lib/dews.ts`

Stateless, deterministic function. No DB access. Same pattern as `computeStabilityIndex()`.

```typescript
export interface DEWSInput {
  stablecoinId: string;
  mcapUsd: number;
  // Supply velocity inputs
  circulatingCurrent: number;
  circulatingPrevDay: number;
  circulatingPrevWeek: number;
  // Pool balance inputs
  weightedBalanceRatio: number | null;
  avgPoolStress: number | null;
  topPools: PoolEntry[] | null;
  // Liquidity erosion inputs
  liquidityScore: number | null;
  liquidityScore7dAgo: number | null;
  tvlCurrent: number | null;
  tvl7dAgo: number | null;
  // Price confidence inputs
  priceConfidence: string | null;
  prevPriceConfidence: string | null;
  price: number | null;
  // Cross-source divergence inputs
  pegRef: number;
  dexPriceUsd: number | null;
  // Blacklist activity inputs
  blacklistEvents24h: number;
  blacklistEvents7d: number;
  // Whether blacklist tracking exists for this coin
  hasBlacklistTracking: boolean;
}

export interface DEWSResult {
  score: number;
  band: ThreatBand;
  signals: Record<string, SignalResult>;
}

export function computeDEWS(input: DEWSInput): DEWSResult { ... }
```

### 4.5 Cron Slot Impact

This piggybacks on the existing `*/15 * * * *` trigger (Trigger 1), chained after `syncStablecoins`. No new cron slot required. All 4 Cloudflare Workers cron slots remain used as before.

The `cron_runs` table will log this as job name `compute-dews`.

### 4.6 Status Registration

Add to `CRON_INTERVALS` in the status handler:

```typescript
"compute-dews": 900, // 15 min
```

---

## 5. API Design

### 5.1 `GET /api/stress-signals`

Returns the latest DEWS for all tracked stablecoins, plus optional per-coin history.

**Cache profile:** standard (`s-maxage=300, max-age=60`)

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `stablecoin` | `string` | -- | Filter to a single coin (returns history when specified) |
| `days` | `integer` | `30` | History lookback in days (1-365). Only used when `stablecoin` is specified. |

**Response (all coins, no filter):**

```json
{
  "signals": {
    "1": {
      "score": 8,
      "band": "CALM",
      "signals": {
        "supply":  { "value": 3, "available": true },
        "pool":    { "value": 12, "available": true },
        "liq":     { "value": 5, "available": true },
        "price":   { "value": 0, "available": true },
        "diverg":  { "value": 15, "available": true },
        "black":   { "value": 0, "available": true }
      },
      "computedAt": 1740470400
    },
    "2": { ... }
  },
  "updatedAt": 1740470400
}
```

**Response (single coin with history):**

```json
{
  "current": {
    "score": 42,
    "band": "ALERT",
    "signals": { ... },
    "computedAt": 1740470400
  },
  "history": [
    {
      "date": 1740384000,
      "score": 35,
      "band": "WATCH",
      "signals": { ... }
    }
  ]
}
```

**Implementation:** `worker/src/api/stress-signals.ts`

```typescript
export async function handleStressSignals(
  request: Request,
  db: D1Database,
): Promise<Response> {
  const url = new URL(request.url);
  const stablecoinId = url.searchParams.get("stablecoin");
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 30));

  if (stablecoinId) {
    // Single coin: latest + history
    const latest = await db.prepare(
      `SELECT score, band, signals_json, computed_at
       FROM stress_signals
       WHERE stablecoin_id = ?
       ORDER BY computed_at DESC LIMIT 1`
    ).bind(stablecoinId).first();

    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    const history = await db.prepare(
      `SELECT snapshot_date, score, band, signals_json
       FROM stress_signal_history
       WHERE stablecoin_id = ? AND snapshot_date >= ?
       ORDER BY snapshot_date ASC`
    ).bind(stablecoinId, cutoff).all();

    return json({
      current: latest ? formatCurrent(latest) : null,
      history: history.results.map(formatHistoryRow),
    });
  }

  // All coins: latest only
  // Use a subquery to get the most recent row per coin
  const rows = await db.prepare(
    `SELECT s.stablecoin_id, s.score, s.band, s.signals_json, s.computed_at
     FROM stress_signals s
     INNER JOIN (
       SELECT stablecoin_id, MAX(computed_at) as max_at
       FROM stress_signals
       GROUP BY stablecoin_id
     ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at`
  ).all();

  const signals: Record<string, object> = {};
  let updatedAt = 0;
  for (const row of rows.results) {
    signals[row.stablecoin_id as string] = formatCurrent(row);
    updatedAt = Math.max(updatedAt, row.computed_at as number);
  }

  return json({ signals, updatedAt });
}
```

### 5.2 Router Registration

Add to the router in `worker/src/index.ts`:

```typescript
if (path === "/api/stress-signals") return handleStressSignals(request, db);
```

### 5.3 Caching

The all-coins endpoint is the primary consumer (coin cards, homepage). Use the **standard** cache profile (`s-maxage=300, max-age=60`) to balance freshness with Workers cost.

The single-coin-with-history endpoint uses the same cache profile. Query string variations create separate cache entries naturally.

---

## 6. Backtesting Strategy

### 6.1 Goal

Validate that DEWS would have flagged historical depegs *before* they crossed the 100bps threshold. The score should have been in ALERT or higher (>35) at least one sample period *before* the depeg event's `started_at`.

### 6.2 Available Historical Data

| Data Source | Historical Depth | Resolution | DEWS Signal |
|-------------|-----------------|------------|-------------|
| `supply_history` | Up to 5 years (backfilled) | Daily | Supply velocity |
| `dex_liquidity_history` | ~6 months | Daily | Liquidity erosion |
| `depeg_events` | ~4 years (backfilled) | Per-event | Ground truth for validation |
| `blacklist_events` | Since deployment (~6 months) | Per-event | Blacklist activity |
| Stablecoins cache | No historical snapshots | -- | Price confidence (not backtestable) |
| DEX prices | ~6 months (from `dex_prices`) | 30-min | Cross-source divergence |

### 6.3 Backtest Approach

**Admin endpoint:** `GET /api/backfill-dews` (requires `X-Admin-Key`)

**Algorithm:**

1. **Load all depeg events** that have both `started_at` and `ended_at` (completed events only, to validate post-hoc).
2. **For each event**, define the analysis window: `[started_at - 7d, started_at]`.
3. **For each day in the window**, reconstruct available signals:
   - **Supply velocity:** interpolate from `supply_history` (daily snapshots). Compute 1d and 7d deltas.
   - **Liquidity erosion:** interpolate from `dex_liquidity_history` if available for that date.
   - **Cross-source divergence:** use the `start_price` and `peg_reference` from the depeg event itself as a proxy for the price state just before the event.
   - **Pool balance drift, price confidence, blacklist activity:** not available historically; set to `available: false` (weight redistribution handles this).
4. **Compute DEWS** using the same `computeDEWS()` function, with available signals only.
5. **Score the prediction:**
   - **True positive:** DEWS >= 36 (ALERT+) at any point in the 7-day pre-depeg window.
   - **Lead time:** hours/days between first ALERT+ and `started_at`.
   - **Peak pre-depeg score:** highest DEWS in the pre-depeg window.
6. **Aggregate results:**
   - TP rate (% of depegs preceded by ALERT+)
   - Average lead time
   - False positive rate (days in ALERT+ without a subsequent depeg within 7 days)
   - Score distribution across all pre-depeg windows

**Response shape:**

```json
{
  "totalEvents": 105,
  "backtested": 87,
  "skipped": 18,
  "truePositives": 62,
  "tpRate": 0.71,
  "avgLeadTimeHours": 18.3,
  "medianPeakPreDepegScore": 48,
  "results": [
    {
      "eventId": 42,
      "symbol": "USDC",
      "startedAt": 1678579200,
      "peakDeviationBps": 850,
      "preDepegScores": [
        { "daysBeforeDepeg": 7, "score": 12, "band": "CALM" },
        { "daysBeforeDepeg": 3, "score": 28, "band": "WATCH" },
        { "daysBeforeDepeg": 1, "score": 52, "band": "ALERT" },
        { "daysBeforeDepeg": 0, "score": 71, "band": "WARNING" }
      ],
      "prediction": "true_positive",
      "leadTimeHours": 24
    }
  ]
}
```

### 6.4 Calibration Loop

If the backtest TP rate is below 60%, iteratively adjust:

1. **Weight adjustments:** If supply velocity alone predicts most true positives, increase its weight.
2. **Normalization curve tuning:** If the anchor points are too conservative (scores stay in CALM when they should be ALERT), shift the curve.
3. **Threshold tuning:** If 36 (ALERT boundary) is too high, lower the TP threshold.
4. **Signal-specific fixes:** If a signal is noisy (high false positive contribution), increase its dampening or tighten its normalization.

Document all calibration changes in the codebase (inline comments in `dews.ts`) so future modifications can reference the empirical basis.

### 6.5 Constraints

- **Price confidence** and **pool balance drift** are not available historically. The backtest operates with 3-4 of the 6 signals. Expect the live system to outperform the backtest.
- **Daily resolution** limits the backtest for events that developed over hours. Supply snapshots are daily; live data updates every 15 minutes.
- **Survivorship bias:** The backtest only covers coins that are still tracked. Coins that died and were removed from tracking may have had the most dramatic pre-depeg signals.

---

## 7. UI Integration Points

### 7.1 Coin Cards (Homepage Table & Compare Page)

A small badge next to the coin name or price cell:

```
USDC  $1.0001  [CALM]
TUSD  $0.9824  [WARNING ▲]
```

- Badge shows band name with band color
- Arrow indicator when score has increased since previous day
- Only show badge when score > 15 (suppress CALM to reduce visual noise on calm days)
- On hover/tap: tooltip with score number and top contributing signal

**Component:** `src/components/dews-badge.tsx`

```typescript
interface DEWSBadgeProps {
  score: number;
  band: ThreatBand;
  prevScore?: number;
  compact?: boolean; // true for table rows, false for detail page
}
```

### 7.2 Stablecoin Detail Page

Full signal breakdown card below the price chart:

```
 Depeg Early Warning Score                    42 [ALERT]

 Supply Velocity     ████████░░░░  35/100   -2.1% (7d)
 Pool Balance Drift  ██████████░░  52/100   ratio: 0.68
 Liquidity Erosion   ███░░░░░░░░░  15/100   score: -3.2 (7d)
 Price Confidence    ██████░░░░░░  25/100   single-source
 Price Divergence    ████████░░░░  38/100   32bps spread
 Blacklist Activity  ░░░░░░░░░░░░   0/100   no data

 [30-day DEWS history sparkline/chart]
```

**Component:** `src/components/dews-detail.tsx`

- 6-row breakdown with progress bars and sub-signal values
- 30-day mini area chart of the composite score, colored by band
- Band-colored header
- Explanation text for each signal

### 7.3 Homepage Widget

A compact overview card showing the top 5 most stressed coins:

```
 Depeg Early Warning
 ─────────────────────
 TUSD     [WARNING]  62
 USDD     [ALERT]    48
 GYEN     [ALERT]    39
 FRAX     [WATCH]    28
 MIM      [WATCH]    22
 ─────────────────────
 141 coins at CALM
```

**Component:** `src/components/dews-summary.tsx`

- Shows top 5 coins by DEWS score (only if any are above CALM)
- Falls back to "All coins at CALM" single-line state
- Links to a filtered view of the PSI or safety scores page

### 7.4 PSI / Stability Index Page

Add a "Per-Coin Stress Signals" section below the PSI chart showing a heatmap or sorted list of all coins by DEWS score. This connects the ecosystem-wide PSI to per-coin stress.

### 7.5 TanStack Query Hook

**File:** `src/hooks/use-stress-signals.ts`

```typescript
export function useStressSignals() {
  return useQuery({
    queryKey: ["stress-signals"],
    queryFn: () => fetchApi("/api/stress-signals"),
    staleTime: 15 * 60 * 1000,      // 15 min (matches cron interval)
    refetchInterval: 30 * 60 * 1000, // 30 min (2x cron interval)
  });
}

export function useStressSignalDetail(stablecoinId: string, days = 30) {
  return useQuery({
    queryKey: ["stress-signals", stablecoinId, days],
    queryFn: () => fetchApi(`/api/stress-signals?stablecoin=${stablecoinId}&days=${days}`),
    staleTime: 15 * 60 * 1000,
    refetchInterval: 30 * 60 * 1000,
    enabled: !!stablecoinId,
  });
}
```

### 7.6 Color Constants

Add to `src/lib/classification.ts`:

```typescript
export type ThreatBand = "CALM" | "WATCH" | "ALERT" | "WARNING" | "DANGER";

export const THREAT_BAND_COLORS: Record<ThreatBand, string> = {
  CALM:    "bg-green-500/10 text-green-500 border-green-500/20",
  WATCH:   "bg-teal-500/10 text-teal-500 border-teal-500/20",
  ALERT:   "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
  WARNING: "bg-orange-500/10 text-orange-500 border-orange-500/20",
  DANGER:  "bg-red-500/10 text-red-500 border-red-500/20",
};

export const THREAT_BAND_HEX: Record<ThreatBand, string> = {
  CALM:    "#22c55e",
  WATCH:   "#14b8a6",
  ALERT:   "#eab308",
  WARNING: "#f97316",
  DANGER:  "#ef4444",
};
```

Add to `src/styles/tokens/semantic.css`:

```css
--dews-calm:        var(--p-green-500);
--dews-calm-hex:    #22c55e;
--dews-watch:       var(--p-teal-500);
--dews-watch-hex:   #14b8a6;
--dews-alert:       var(--p-amber-500);
--dews-alert-hex:   #eab308;
--dews-warning:     var(--p-orange-500);
--dews-warning-hex: #f97316;
--dews-danger:      var(--p-red-500);
--dews-danger-hex:  #ef4444;
```

---

## 8. Edge Cases & Limitations

### 8.1 New Coins With No History

Coins tracked for fewer than 7 days lack supply history and liquidity history. They receive:

- `S_supply = 0` (no delta data)
- `S_liq = 0` (insufficient history)
- `S_pool`, `S_price`, `S_diverg` are available from day 1
- `S_black = 0` (unless they happen to be USDC/USDT/PAXG/XAUT)

With only 2-3 signals available (total weight ~0.50), the score is still produced but has lower confidence. The API response includes an `availableSignals` count so the UI can display a "limited data" caveat.

### 8.2 Coins With No DEX Liquidity Data

Approximately 30-40 of the ~145 tracked coins have no DEX presence. These lose `S_pool` and `S_liq` (35% of total weight). The remaining signals (supply, price, divergence, blacklist) are redistributed proportionally. The score still works but is less sensitive to selling pressure signals.

### 8.3 Stale Data Handling

If the stablecoins cache is older than 30 minutes (staleness threshold), the cron should:

1. Log a warning but still compute DEWS from available data.
2. Set `S_price.available = false` (confidence data may be outdated).
3. Mark the `signals_json` with a `"staleData": true` flag.

The API should respect the `X-Data-Age` header pattern used by other endpoints.

### 8.4 False Positive Mitigation

**Problem:** Small coins with thin liquidity may frequently register elevated pool drift and price divergence without an actual depeg risk.

**Mitigations:**

1. **Size-adjusted sensitivity** on supply velocity (already included in Section 2.3.1).
2. **Minimum TVL gate** on pool balance signals: ignore pools below $100K TVL.
3. **Confidence field in signals:** Each sub-signal carries a `confidence` (0-1) that the UI can use to display caveats.
4. **Smoothing:** Use the average of the last 2 readings (current + previous 15-min sample) for `S_pool` and `S_diverg` to dampen single-sample spikes.

### 8.5 NAV Tokens

Yield-bearing/price-appreciating tokens (where `meta.flags.navToken === true`) are expected to deviate from their peg reference. They should be excluded from DEWS or receive a permanent CALM score with a "NAV token -- DEWS not applicable" note.

### 8.6 Cemetery Coins

Defunct stablecoins in the cemetery should not receive DEWS scores. Check `isDefunct` and skip.

### 8.7 Non-USD Pegs

Non-USD pegs have wider natural volatility (FX noise). The depeg threshold is already 150bps for non-USD vs 100bps for USD. Apply a similar dampening to `S_diverg`:

```typescript
const pegTypeDampening = pegType === "peggedUSD" ? 1.0 : 0.7;
S_diverg = S_diverg * pegTypeDampening;
```

### 8.8 Concurrent Cron Safety

The cron uses `INSERT OR REPLACE` on `(stablecoin_id, computed_at)` primary key. If a slow run overlaps with a fast run, the later writer wins. This is acceptable because both runs use the same data snapshot.

---

## 9. Future Enhancements

### 9.1 Mint/Burn Flow Data

When the mint/burn tracking feature is implemented (tables 0019/0020 were created then dropped), it would provide the most granular view of capital flows:

- **Redemption surge:** Large burn volume relative to historical baseline signals holders exiting.
- **Mint/burn ratio:** A collapsing ratio (burns >> mints) is a stronger signal than supply delta alone, because supply delta can be delayed by accounting.
- **Chain-specific flows:** Redemptions concentrated on one chain may indicate bridge problems rather than fundamental stress.

Integration: Add a new sub-signal `S_flow` with weight ~0.15, redistributed from `S_supply` (0.25 -> 0.15) and `S_pool` (0.20 -> 0.15):

```typescript
// Future: mint/burn flow signal
S_flow = computeFlowSignal(burnVolume24h, mintVolume24h, historicalBurnRate);
```

### 9.2 Social Sentiment Signal

A future enhancement could scrape crypto Twitter/X mentions and sentiment for tracked stablecoins. Panic mentions of "depeg", "bank run", "insolvent" tend to precede and amplify actual depegs. This would be a new sub-signal `S_social` with modest weight (~0.10).

### 9.3 On-Chain Reserve Monitoring

For RWA-backed stablecoins with on-chain proof of reserves (e.g., USDC's attestation contract), monitoring the reserve ratio could provide an additional signal. A declining reserve ratio below 100% is an extremely strong depeg precursor.

### 9.4 Alert System Integration

Extend the existing webhook alert system to fire notifications on DEWS band transitions:

```typescript
if (prevBand === "WATCH" && currentBand === "ALERT") {
  await sendAlert(
    `DEWS: ${symbol} entered ALERT`,
    `Score: ${score}. Top signal: ${topSignal.name} (${topSignal.value}/100).`
  );
}
```

Only fire alerts for upgrades (CALM->WATCH->ALERT->WARNING->DANGER), not downgrades.

### 9.5 Digest Integration

Pass the top stressed coins to the daily digest LLM prompt:

```
Depeg Early Warning: TUSD at WARNING (62), USDD at ALERT (48), GYEN at ALERT (39).
All other coins at CALM.
```

The system prompt would instruct Sonnet to mention coins in WARNING or DANGER in the editorial.

### 9.6 Report Card Integration

DEWS could feed into the report card system as a "real-time risk" modifier. A coin in WARNING or DANGER could receive a temporary report card grade penalty, making the static grades more responsive to developing situations.

---

## 10. Implementation Plan

### Phase 1: Core Engine (1-2 days)

1. Create migration `0031_stress_signals.sql` and `0032_stress_signal_history.sql`
2. Implement `worker/src/lib/dews.ts` (pure compute function + `piecewiseLinear` utility)
3. Implement `worker/src/cron/compute-dews.ts` (cron job)
4. Register cron in `worker/src/index.ts` (chained after syncStablecoins)
5. Add to `CRON_INTERVALS` in status handler
6. Write unit tests for `computeDEWS()` with fixture data

### Phase 2: API & Frontend (1-2 days)

1. Implement `worker/src/api/stress-signals.ts`
2. Register route in router
3. Implement `src/hooks/use-stress-signals.ts`
4. Implement `src/components/dews-badge.tsx` (compact badge for tables)
5. Implement `src/components/dews-detail.tsx` (full breakdown for detail page)
6. Implement `src/components/dews-summary.tsx` (homepage widget)
7. Integrate badge into coin table and detail page
8. Add color constants to classification.ts and semantic tokens

### Phase 3: Backtesting & Calibration (1-2 days)

1. Implement `worker/src/api/backfill-dews.ts` (admin endpoint)
2. Run backtest against historical depeg events
3. Analyze TP rate, lead time, false positive rate
4. Adjust weights, normalization curves, and thresholds as needed
5. Document calibration rationale in code comments

### Phase 4: Polish & Documentation (1 day)

1. Update the methodology page (`/methodology`)
2. Update the about page with the new feature
3. Update `docs/api-reference.md` with the new endpoint
4. Create `docs/dews.md` documentation file
5. Add to `docs/worker-infrastructure.md` cron section

---

## 11. File Index

| File | Role |
|------|------|
| `worker/src/lib/dews.ts` | Pure compute: sub-signals, composite score, band classification |
| `worker/src/cron/compute-dews.ts` | 15-minute cron: reads D1, computes DEWS, stores results |
| `worker/src/api/stress-signals.ts` | `GET /api/stress-signals` handler |
| `worker/src/api/backfill-dews.ts` | Admin backtest endpoint |
| `worker/migrations/0031_stress_signals.sql` | `stress_signals` table (15-min samples) |
| `worker/migrations/0032_stress_signal_history.sql` | `stress_signal_history` table (daily snapshots) |
| `src/lib/classification.ts` | `ThreatBand` type, `THREAT_BAND_COLORS`, `THREAT_BAND_HEX` |
| `src/hooks/use-stress-signals.ts` | TanStack Query hooks |
| `src/components/dews-badge.tsx` | Compact badge for table rows |
| `src/components/dews-detail.tsx` | Full signal breakdown card for detail page |
| `src/components/dews-summary.tsx` | Homepage top-stressed-coins widget |
