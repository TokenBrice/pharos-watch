# Depeg Early Warning Score (DEWS) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a per-coin, forward-looking stress score (0-100) that estimates depeg probability using 7 sub-signals, computed every 15 minutes, exposed via API and integrated into the frontend.

**Architecture:** Pure compute function (`worker/src/lib/dews.ts`) consumed by a 15-min cron (`worker/src/cron/compute-dews.ts`) that reads existing D1 tables (stablecoins cache, dex_liquidity, dex_prices, dex_liquidity_history, blacklist_events, supply_history, mint_burn_hourly) and writes to two new tables (`stress_signals`, `stress_signal_history`). One new API endpoint (`GET /api/stress-signals`) serves the data. Frontend adds a badge component, detail card, and homepage widget.

**Tech Stack:** Cloudflare Worker (cron + API), D1 (SQLite), Next.js 16 static export, React 19, TanStack Query, Recharts, Tailwind CSS v4.

**Design doc:** `docs/plans/depeg-early-warning-design.md`

---

## Task 1: Database Migration

**Files:**
- Create: `worker/migrations/0032_stress_signals.sql`

**Context:** Latest migrations are `0031_yield_data.sql` and `0031_mint_burn_v2.sql` (duplicate number). This is 0032. Single file with both tables to avoid another number collision.

**Step 1: Create migration file**

```sql
-- Depeg Early Warning Score (DEWS) tables
-- 15-minute rolling samples (pruned to 7 days)
CREATE TABLE IF NOT EXISTS stress_signals (
  stablecoin_id TEXT NOT NULL,
  computed_at   INTEGER NOT NULL,    -- Unix seconds
  score         REAL NOT NULL,       -- Composite DEWS 0-100
  band          TEXT NOT NULL,       -- CALM | WATCH | ALERT | WARNING | DANGER
  signals_json  TEXT NOT NULL,       -- JSON: per-signal breakdown
  PRIMARY KEY (stablecoin_id, computed_at)
);

CREATE INDEX IF NOT EXISTS idx_stress_computed ON stress_signals(computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_stress_coin_date ON stress_signals(stablecoin_id, computed_at DESC);

-- Daily snapshots (pruned to 365 days)
CREATE TABLE IF NOT EXISTS stress_signal_history (
  stablecoin_id TEXT NOT NULL,
  snapshot_date INTEGER NOT NULL,    -- UTC midnight epoch seconds
  score         REAL NOT NULL,
  band          TEXT NOT NULL,
  signals_json  TEXT NOT NULL,
  PRIMARY KEY (stablecoin_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_stress_hist_date ON stress_signal_history(snapshot_date DESC);
```

**Step 2: Apply migration locally**

Run: `cd worker && npx wrangler d1 execute pharos-db --local --file=migrations/0032_stress_signals.sql`
Expected: Migration applies without errors.

**Step 3: Commit**

```bash
git add worker/migrations/0032_stress_signals.sql
git commit -m "feat(dews): add stress_signals and stress_signal_history tables"
```

---

## Task 2: Pure Compute Function — `piecewiseLinear` + Sub-Signals

**Files:**
- Create: `worker/src/lib/dews.ts`
- Test: `worker/src/lib/__tests__/dews.test.ts`

**Context:** Follow the same pattern as `worker/src/lib/stability-index.ts` — pure, stateless, no DB access. The function takes a typed input and returns score + band + signal breakdown. No `piecewiseLinear` utility exists in the codebase yet — create it here.

PSI-eligible coins are defined in `src/lib/psi-eligible.ts`. NAV tokens (`meta.flags.navToken`) and defunct coins (`isDefunct`) must be excluded. Non-USD pegs get dampened `S_diverg` (factor 0.7). Small coins (<$50M) get dampened `S_supply` via size factor.

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { computeDEWS, piecewiseLinear, getThreatBand } from "../dews";
import type { DEWSInput } from "../dews";

// --- piecewiseLinear tests ---

describe("piecewiseLinear", () => {
  const anchors: [number, number][] = [
    [0, 0], [1, 15], [3, 40], [5, 65], [10, 85], [20, 100],
  ];

  it("returns 0 at lower bound", () => {
    expect(piecewiseLinear(0, anchors)).toBe(0);
  });

  it("returns exact anchor value", () => {
    expect(piecewiseLinear(3, anchors)).toBe(40);
  });

  it("interpolates between anchors", () => {
    // Between [1, 15] and [3, 40]: at 2, expect 15 + (40-15) * (2-1)/(3-1) = 27.5
    expect(piecewiseLinear(2, anchors)).toBeCloseTo(27.5, 1);
  });

  it("clamps at maximum anchor", () => {
    expect(piecewiseLinear(30, anchors)).toBe(100);
  });

  it("clamps at 0 for negative input", () => {
    expect(piecewiseLinear(-5, anchors)).toBe(0);
  });
});

// --- getThreatBand tests ---

describe("getThreatBand", () => {
  it.each([
    [0, "CALM"], [15, "CALM"],
    [16, "WATCH"], [35, "WATCH"],
    [36, "ALERT"], [55, "ALERT"],
    [56, "WARNING"], [75, "WARNING"],
    [76, "DANGER"], [100, "DANGER"],
  ])("score %d => %s", (score, band) => {
    expect(getThreatBand(score)).toBe(band);
  });
});

// --- computeDEWS tests ---

function baseInput(overrides: Partial<DEWSInput> = {}): DEWSInput {
  return {
    stablecoinId: "1",
    mcapUsd: 5e9,
    pegType: "peggedUSD",
    // Supply velocity
    circulatingCurrent: 5e9,
    circulatingPrevDay: 5e9,
    circulatingPrevWeek: 5e9,
    // Pool balance
    weightedBalanceRatio: null,
    avgPoolStress: null,
    topPools: null,
    // Liquidity erosion
    liquidityScore: null,
    liquidityScore7dAgo: null,
    tvlCurrent: null,
    tvl7dAgo: null,
    // Price confidence
    priceConfidence: "high",
    prevPriceConfidence: null,
    price: 1.0,
    // Cross-source divergence
    pegRef: 1.0,
    dexPriceUsd: null,
    // Blacklist activity
    blacklistEvents24h: 0,
    blacklistEvents7d: 0,
    hasBlacklistTracking: false,
    // Mint/burn flow (optional)
    burnVolume24hUsd: null,
    mintVolume24hUsd: null,
    burnBaseline30dUsd: null,
    mintBaseline30dUsd: null,
    flowDataAgeDays: 0,
    ...overrides,
  };
}

describe("computeDEWS", () => {
  it("returns CALM for a healthy large-cap coin with all signals available", () => {
    const result = computeDEWS(baseInput({
      weightedBalanceRatio: 0.97,
      avgPoolStress: 0.02,
      topPools: [],
      liquidityScore: 80,
      liquidityScore7dAgo: 78,
      tvlCurrent: 1e8,
      tvl7dAgo: 9.5e7,
    }));
    expect(result.band).toBe("CALM");
    expect(result.score).toBeLessThanOrEqual(15);
    expect(result.signals.supply.available).toBe(true);
    expect(result.signals.pool.available).toBe(true);
  });

  it("returns 0 when fewer than 2 signals available", () => {
    // Only price available, everything else null — only S_price + S_supply are available
    // Actually S_supply is always available (from cache), S_price is always available
    // So we always have at least 2. Let's test with both prices missing.
    const result = computeDEWS(baseInput({ price: null, priceConfidence: null }));
    // S_supply available (0.25), S_price available (100 for null price) = 0.40 weight
    expect(result.score).toBeGreaterThan(0);
  });

  it("detects supply velocity stress", () => {
    const result = computeDEWS(baseInput({
      circulatingCurrent: 4.5e9,   // -10% from prev day
      circulatingPrevDay: 5e9,
      circulatingPrevWeek: 5.5e9,  // -18% from prev week
    }));
    expect(result.signals.supply.value).toBeGreaterThan(50);
    expect(result.band).not.toBe("CALM");
  });

  it("dampens supply velocity for small coins", () => {
    const large = computeDEWS(baseInput({
      mcapUsd: 5e9,
      circulatingCurrent: 4.75e9,
      circulatingPrevDay: 5e9,
    }));
    const small = computeDEWS(baseInput({
      mcapUsd: 10e6,
      circulatingCurrent: 9.5e6,
      circulatingPrevDay: 10e6,
    }));
    expect(large.signals.supply.value).toBeGreaterThan(small.signals.supply.value);
  });

  it("detects pool balance drift", () => {
    const result = computeDEWS(baseInput({
      weightedBalanceRatio: 0.45,
      avgPoolStress: 0.7,
      topPools: [{ tvlUsd: 5e6, balanceRatio: 0.3 }],
    }));
    expect(result.signals.pool.available).toBe(true);
    expect(result.signals.pool.value).toBeGreaterThan(50);
  });

  it("detects price confidence degradation", () => {
    const result = computeDEWS(baseInput({
      priceConfidence: "low",
      prevPriceConfidence: "high",
    }));
    // 60 base + 15 transition bonus = 75
    expect(result.signals.price.value).toBe(75);
  });

  it("detects cross-source price divergence", () => {
    const result = computeDEWS(baseInput({
      price: 0.995,     // 50bps off peg
      dexPriceUsd: 0.99, // 100bps off peg
    }));
    expect(result.signals.diverg.available).toBe(true);
    expect(result.signals.diverg.value).toBeGreaterThan(25);
  });

  it("dampens S_diverg for non-USD pegs", () => {
    const usd = computeDEWS(baseInput({
      pegType: "peggedUSD",
      price: 0.995,
      dexPriceUsd: 0.99,
    }));
    const eur = computeDEWS(baseInput({
      pegType: "peggedEUR",
      price: 0.995,
      dexPriceUsd: 0.99,
    }));
    expect(usd.signals.diverg.value).toBeGreaterThan(eur.signals.diverg.value);
  });

  it("detects blacklist activity spike", () => {
    const result = computeDEWS(baseInput({
      hasBlacklistTracking: true,
      blacklistEvents24h: 15,
      blacklistEvents7d: 20,
    }));
    expect(result.signals.black.available).toBe(true);
    expect(result.signals.black.value).toBeGreaterThan(40);
  });

  it("marks blacklist unavailable for untracked coins", () => {
    const result = computeDEWS(baseInput({ hasBlacklistTracking: false }));
    expect(result.signals.black.available).toBe(false);
  });

  it("integrates mint/burn flow signal when available", () => {
    const result = computeDEWS(baseInput({
      burnVolume24hUsd: 5e8,
      mintVolume24hUsd: 1e7,
      burnBaseline30dUsd: 1e8,
      mintBaseline30dUsd: 1e8,
      flowDataAgeDays: 14,
    }));
    expect(result.signals.flow.available).toBe(true);
    expect(result.signals.flow.value).toBeGreaterThan(40);
  });

  it("marks flow unavailable when no mint/burn data", () => {
    const result = computeDEWS(baseInput());
    expect(result.signals.flow.available).toBe(false);
  });

  it("marks flow unavailable when data too young (<7 days)", () => {
    const result = computeDEWS(baseInput({
      burnVolume24hUsd: 5e8,
      mintVolume24hUsd: 1e7,
      burnBaseline30dUsd: 1e8,
      mintBaseline30dUsd: 1e8,
      flowDataAgeDays: 3,
    }));
    expect(result.signals.flow.available).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd worker && npx vitest run src/lib/__tests__/dews.test.ts`
Expected: FAIL (module not found)

**Step 3: Implement `worker/src/lib/dews.ts`**

Full implementation of:
- `piecewiseLinear(x, anchors)` — generic piecewise linear interpolation
- `getThreatBand(score)` — maps 0-100 to CALM/WATCH/ALERT/WARNING/DANGER
- 7 sub-signal compute functions (supply, pool, liq, price, diverg, black, flow)
- `computeDEWS(input)` — orchestrates all sub-signals, applies weight redistribution, returns `DEWSResult`

Key types:

```typescript
export type ThreatBand = "CALM" | "WATCH" | "ALERT" | "WARNING" | "DANGER";

export interface PoolEntry {
  tvlUsd: number;
  balanceRatio: number;
}

export interface SignalResult {
  value: number;         // 0-100
  available: boolean;
  [key: string]: unknown; // Extra debug fields per signal
}

export interface DEWSInput {
  stablecoinId: string;
  mcapUsd: number;
  pegType: string;
  // Supply velocity
  circulatingCurrent: number;
  circulatingPrevDay: number;
  circulatingPrevWeek: number;
  // Pool balance
  weightedBalanceRatio: number | null;
  avgPoolStress: number | null;
  topPools: PoolEntry[] | null;
  // Liquidity erosion
  liquidityScore: number | null;
  liquidityScore7dAgo: number | null;
  tvlCurrent: number | null;
  tvl7dAgo: number | null;
  // Price confidence
  priceConfidence: string | null;
  prevPriceConfidence: string | null;
  price: number | null;
  // Cross-source divergence
  pegRef: number;
  dexPriceUsd: number | null;
  // Blacklist activity
  blacklistEvents24h: number;
  blacklistEvents7d: number;
  hasBlacklistTracking: boolean;
  // Mint/burn flow (optional — from mint_burn_hourly)
  burnVolume24hUsd: number | null;
  mintVolume24hUsd: number | null;
  burnBaseline30dUsd: number | null;
  mintBaseline30dUsd: number | null;
  flowDataAgeDays: number;
}

export interface DEWSResult {
  score: number;
  band: ThreatBand;
  signals: Record<string, SignalResult>;
}
```

Weight map (7 signals, total ~1.10 before normalization — but redistribution handles it):

```typescript
const WEIGHTS: Record<string, number> = {
  supply: 0.25,
  pool:   0.20,
  liq:    0.15,
  price:  0.15,
  diverg: 0.15,
  black:  0.10,
  flow:   0.10,
};
```

Note: Weights sum to 1.10 — but only available signals participate, and the redistribution normalizes by actual available weight. When S_flow is unavailable (most coins), the effective weight is 1.00 split across the 6 original signals at their original ratios.

Sub-signal implementations — follow Section 2.3 of the design doc exactly, plus:

**S_flow (new, Section 9.1 adapted):**

```typescript
function computeFlowSignal(input: DEWSInput): SignalResult {
  // Unavailable if no mint-burn data or data too young
  if (
    input.burnVolume24hUsd === null ||
    input.mintVolume24hUsd === null ||
    input.burnBaseline30dUsd === null ||
    input.flowDataAgeDays < 7
  ) {
    return { value: 0, available: false };
  }

  // Net flow: negative = redemptions dominating
  const net24h = input.mintVolume24hUsd - input.burnVolume24hUsd;
  const baselineNet = (input.mintBaseline30dUsd ?? 0) - (input.burnBaseline30dUsd ?? 0);
  const baselineAbs = (input.mintBaseline30dUsd ?? 0) + (input.burnBaseline30dUsd ?? 0);

  // Burn surge: how much 24h burns exceed the 30d daily average
  const burnSurge = input.burnBaseline30dUsd > 0
    ? input.burnVolume24hUsd / input.burnBaseline30dUsd
    : input.burnVolume24hUsd > 1e6 ? 5 : 0;

  // Mint/burn ratio collapse: when burns >> mints
  const ratio = input.mintVolume24hUsd > 0
    ? input.burnVolume24hUsd / input.mintVolume24hUsd
    : input.burnVolume24hUsd > 0 ? 10 : 0;

  const surgeScore = piecewiseLinear(burnSurge, [
    [0, 0], [1, 5], [2, 25], [3, 50], [5, 75], [10, 100],
  ]);

  const ratioScore = piecewiseLinear(ratio, [
    [0, 0], [1, 5], [2, 20], [3, 40], [5, 65], [10, 100],
  ]);

  const value = clamp(0, 100, 0.6 * surgeScore + 0.4 * ratioScore);

  return {
    value,
    available: true,
    burnSurge: Math.round(burnSurge * 100) / 100,
    burnToMintRatio: Math.round(ratio * 100) / 100,
    net24hUsd: net24h,
  };
}
```

**Smoothing:** Design doc Section 8.4 specifies averaging last 2 readings for `S_pool` and `S_diverg`. Since the pure compute function is stateless, the cron will fetch the previous signal values and pass `prevPoolValue`/`prevDivergValue` for smoothing. Add optional smoothing fields to DEWSInput:

```typescript
  // Smoothing (optional — previous reading for averaging)
  prevPoolValue?: number;
  prevDivergValue?: number;
```

**Step 4: Run tests to verify they pass**

Run: `cd worker && npx vitest run src/lib/__tests__/dews.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add worker/src/lib/dews.ts worker/src/lib/__tests__/dews.test.ts
git commit -m "feat(dews): pure compute function with 7 sub-signals and unit tests"
```

---

## Task 3: Cron Job — `compute-dews.ts`

**Files:**
- Create: `worker/src/cron/compute-dews.ts`
- Modify: `worker/src/index.ts` (register cron)
- Modify: `worker/src/api/status.ts` (add to CRON_INTERVALS)

**Context:** Piggybacks on `*/15 * * * *` trigger, chained after `syncStablecoins` (same pattern as `stability-index`). See `worker/src/index.ts:197-205` for the chain pattern. Reads from: stablecoins cache (getCache), dex_liquidity, dex_prices, dex_liquidity_history, blacklist_events, stress_signals (previous reading for smoothing), mint_burn_hourly.

**Step 1: Write `worker/src/cron/compute-dews.ts`**

```typescript
import { getCache, batchExecute } from "../lib/db";
import { computeDEWS, getThreatBand } from "../lib/dews";
import type { DEWSInput, PoolEntry } from "../lib/dews";
import { PSI_ELIGIBLE_STABLECOINS } from "../../../src/lib/psi-eligible";
import { sumPegBuckets } from "../../../src/lib/supply";
import type { PegAssetBase } from "../../../src/lib/types";
import { derivePegRates, getPegReference } from "../../../src/lib/peg-rates";

export async function computeAndStoreDEWS(db: D1Database): Promise<number> {
  const nowSec = Math.floor(Date.now() / 1000);
  const metaById = new Map(PSI_ELIGIBLE_STABLECOINS.map(s => [s.id, s]));

  // 1. Read stablecoins cache
  const assetsRaw = await getCache<PegAssetBase[]>(db, "stablecoins");
  if (!assetsRaw?.length) {
    console.warn("[dews] No stablecoins cache, skipping");
    return 0;
  }
  const assetById = new Map(assetsRaw.map(a => [a.id, a]));
  const { rates: pegRates } = derivePegRates(assetsRaw, metaById);

  // 2. Read dex_liquidity (all coins in one query)
  const dexLiqRows = await db.prepare(
    "SELECT stablecoin_id, weighted_balance_ratio, avg_pool_stress, top_pools_json, liquidity_score, total_tvl_usd FROM dex_liquidity"
  ).all<{
    stablecoin_id: string;
    weighted_balance_ratio: number | null;
    avg_pool_stress: number | null;
    top_pools_json: string | null;
    liquidity_score: number | null;
    total_tvl_usd: number | null;
  }>();
  const dexLiqMap = new Map(dexLiqRows.results.map(r => [r.stablecoin_id, r]));

  // 3. Read dex_prices
  let dexPriceMap = new Map<string, { dex_price_usd: number }>();
  try {
    const dexPriceRows = await db.prepare(
      "SELECT stablecoin_id, dex_price_usd FROM dex_prices"
    ).all<{ stablecoin_id: string; dex_price_usd: number }>();
    dexPriceMap = new Map(dexPriceRows.results.map(r => [r.stablecoin_id, r]));
  } catch { /* table may not exist */ }

  // 4. Read dex_liquidity_history (7d lookback, one query for all coins)
  const liqHistCutoff = nowSec - 8 * 86400;
  const liqHistRows = await db.prepare(
    "SELECT stablecoin_id, date, score, tvl FROM dex_liquidity_history WHERE date >= ? ORDER BY date ASC"
  ).bind(liqHistCutoff).all<{
    stablecoin_id: string; date: number; score: number; tvl: number;
  }>();
  // Group by coin, find the row closest to 7 days ago
  const liqHist7dMap = new Map<string, { score: number; tvl: number }>();
  const target7d = nowSec - 7 * 86400;
  for (const row of liqHistRows.results) {
    const existing = liqHist7dMap.get(row.stablecoin_id);
    if (!existing || Math.abs(row.date - target7d) < Math.abs((existing as any)._date - target7d)) {
      liqHist7dMap.set(row.stablecoin_id, { score: row.score, tvl: row.tvl, _date: row.date } as any);
    }
  }

  // 5. Read blacklist_events counts (24h + 7d)
  const blacklistCutoff7d = nowSec - 7 * 86400;
  const blacklistCutoff24h = nowSec - 86400;
  let blacklistCounts = new Map<string, { count24h: number; count7d: number }>();
  try {
    const bl7d = await db.prepare(
      `SELECT stablecoin, COUNT(*) as cnt FROM blacklist_events
       WHERE timestamp >= ? GROUP BY stablecoin`
    ).bind(blacklistCutoff7d).all<{ stablecoin: string; cnt: number }>();
    const bl24h = await db.prepare(
      `SELECT stablecoin, COUNT(*) as cnt FROM blacklist_events
       WHERE timestamp >= ? GROUP BY stablecoin`
    ).bind(blacklistCutoff24h).all<{ stablecoin: string; cnt: number }>();

    const map7d = new Map(bl7d.results.map(r => [r.stablecoin, r.cnt]));
    const map24h = new Map(bl24h.results.map(r => [r.stablecoin, r.cnt]));

    // Map symbol -> stablecoin_id for blacklist-tracked coins
    for (const [symbol, count7d] of map7d) {
      blacklistCounts.set(symbol, {
        count24h: map24h.get(symbol) ?? 0,
        count7d,
      });
    }
  } catch { /* blacklist_events may not exist */ }

  // 6. Read previous stress_signals (for smoothing S_pool, S_diverg)
  const prevSignals = new Map<string, Record<string, any>>();
  try {
    const prevRows = await db.prepare(
      `SELECT s.stablecoin_id, s.signals_json
       FROM stress_signals s
       INNER JOIN (
         SELECT stablecoin_id, MAX(computed_at) as max_at
         FROM stress_signals GROUP BY stablecoin_id
       ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at`
    ).all<{ stablecoin_id: string; signals_json: string }>();
    for (const row of prevRows.results) {
      try {
        prevSignals.set(row.stablecoin_id, JSON.parse(row.signals_json));
      } catch {}
    }
  } catch { /* table may not exist yet on first run */ }

  // 7. Read mint/burn hourly aggregates (24h + 30d baselines)
  let mintBurnMap = new Map<string, {
    burn24h: number; mint24h: number;
    burnBaseline: number; mintBaseline: number;
    dataAgeDays: number;
  }>();
  try {
    const mbCutoff24h = nowSec - 86400;
    const mbCutoff30d = nowSec - 30 * 86400;

    // 24h aggregates
    const mb24h = await db.prepare(
      `SELECT stablecoin_id,
              SUM(CASE WHEN burn_volume_usd IS NOT NULL THEN burn_volume_usd ELSE 0 END) as total_burn,
              SUM(CASE WHEN mint_volume_usd IS NOT NULL THEN mint_volume_usd ELSE 0 END) as total_mint
       FROM mint_burn_hourly WHERE hour_ts >= ? GROUP BY stablecoin_id`
    ).bind(mbCutoff24h).all<{ stablecoin_id: string; total_burn: number; total_mint: number }>();

    // 30d daily averages
    const mb30d = await db.prepare(
      `SELECT stablecoin_id,
              SUM(CASE WHEN burn_volume_usd IS NOT NULL THEN burn_volume_usd ELSE 0 END) / 30.0 as avg_burn,
              SUM(CASE WHEN mint_volume_usd IS NOT NULL THEN mint_volume_usd ELSE 0 END) / 30.0 as avg_mint,
              COUNT(DISTINCT date(hour_ts, 'unixepoch')) as days_with_data
       FROM mint_burn_hourly WHERE hour_ts >= ? GROUP BY stablecoin_id`
    ).bind(mbCutoff30d).all<{
      stablecoin_id: string; avg_burn: number; avg_mint: number; days_with_data: number;
    }>();

    const mb24hMap = new Map(mb24h.results.map(r => [r.stablecoin_id, r]));
    const mb30dMap = new Map(mb30d.results.map(r => [r.stablecoin_id, r]));

    for (const [id, d24] of mb24hMap) {
      const d30 = mb30dMap.get(id);
      mintBurnMap.set(id, {
        burn24h: d24.total_burn,
        mint24h: d24.total_mint,
        burnBaseline: d30?.avg_burn ?? 0,
        mintBaseline: d30?.avg_mint ?? 0,
        dataAgeDays: d30?.days_with_data ?? 0,
      });
    }
  } catch { /* mint_burn_hourly may not exist */ }

  // Blacklist symbol -> ID mapping
  const BLACKLIST_SYMBOL_TO_IDS: Record<string, string[]> = {
    "USDC": ["5"],
    "USDT": ["1"],
    "PAXG": ["49"],
    "XAUT": ["87"],
  };

  // 8. Compute DEWS for each eligible coin
  const results: {
    stablecoinId: string; score: number; band: string; signals: Record<string, any>;
  }[] = [];

  for (const meta of PSI_ELIGIBLE_STABLECOINS) {
    // Skip NAV tokens and defunct coins
    if (meta.flags?.navToken) continue;

    const asset = assetById.get(meta.id);
    if (!asset) continue;

    const current = sumPegBuckets(asset.circulating);
    const prevDay = sumPegBuckets(asset.circulatingPrevDay);
    const prevWeek = sumPegBuckets(asset.circulatingPrevWeek);

    if (current <= 0) continue; // No supply data

    const dexLiq = dexLiqMap.get(meta.id);
    const dexPrice = dexPriceMap.get(meta.id);
    const liqHist = liqHist7dMap.get(meta.id);
    const prev = prevSignals.get(meta.id);
    const mb = mintBurnMap.get(meta.id);

    // Determine blacklist tracking availability
    const isBlacklistTracked = Object.values(BLACKLIST_SYMBOL_TO_IDS).flat().includes(meta.id);
    const blSymbol = Object.entries(BLACKLIST_SYMBOL_TO_IDS).find(([, ids]) => ids.includes(meta.id))?.[0];
    const blCounts = blSymbol ? blacklistCounts.get(blSymbol) : undefined;

    // Parse top pools
    let topPools: PoolEntry[] | null = null;
    if (dexLiq?.top_pools_json) {
      try {
        const parsed = JSON.parse(dexLiq.top_pools_json);
        topPools = (Array.isArray(parsed) ? parsed : []).map((p: any) => ({
          tvlUsd: p.tvlUsd ?? 0,
          balanceRatio: p.extra?.balanceRatio ?? 1.0,
        }));
      } catch {}
    }

    const pegRef = getPegReference(meta, pegRates);

    const input: DEWSInput = {
      stablecoinId: meta.id,
      mcapUsd: current,
      pegType: meta.pegType ?? "peggedUSD",
      circulatingCurrent: current,
      circulatingPrevDay: prevDay || current,
      circulatingPrevWeek: prevWeek || current,
      weightedBalanceRatio: dexLiq?.weighted_balance_ratio ?? null,
      avgPoolStress: dexLiq?.avg_pool_stress ?? null,
      topPools,
      liquidityScore: dexLiq?.liquidity_score ?? null,
      liquidityScore7dAgo: liqHist?.score ?? null,
      tvlCurrent: dexLiq?.total_tvl_usd ?? null,
      tvl7dAgo: liqHist?.tvl ?? null,
      priceConfidence: (asset as any).priceConfidence ?? null,
      prevPriceConfidence: prev?.price?.confidence ?? null,
      price: asset.price ?? null,
      pegRef: pegRef ?? 1.0,
      dexPriceUsd: dexPrice?.dex_price_usd ?? null,
      blacklistEvents24h: blCounts?.count24h ?? 0,
      blacklistEvents7d: blCounts?.count7d ?? 0,
      hasBlacklistTracking: isBlacklistTracked,
      burnVolume24hUsd: mb?.burn24h ?? null,
      mintVolume24hUsd: mb?.mint24h ?? null,
      burnBaseline30dUsd: mb?.burnBaseline ?? null,
      mintBaseline30dUsd: mb?.mintBaseline ?? null,
      flowDataAgeDays: mb?.dataAgeDays ?? 0,
      prevPoolValue: prev?.pool?.value,
      prevDivergValue: prev?.diverg?.value,
    };

    const result = computeDEWS(input);
    results.push({
      stablecoinId: meta.id,
      score: result.score,
      band: result.band,
      signals: result.signals,
    });
  }

  // 9. Batch INSERT OR REPLACE
  if (results.length > 0) {
    const stmts = results.map(r =>
      db.prepare(
        "INSERT OR REPLACE INTO stress_signals (stablecoin_id, computed_at, score, band, signals_json) VALUES (?, ?, ?, ?, ?)"
      ).bind(r.stablecoinId, nowSec, r.score, r.band, JSON.stringify(r.signals))
    );
    await batchExecute(db, stmts);
  }

  // 10. Daily snapshot (first run of UTC day)
  const nowUtc = new Date();
  const todayMidnight = Math.floor(
    Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate()) / 1000
  );
  const existing = await db.prepare(
    "SELECT 1 FROM stress_signal_history WHERE snapshot_date = ? LIMIT 1"
  ).bind(todayMidnight).first();

  if (!existing && results.length > 0) {
    const histStmts = results.map(r =>
      db.prepare(
        "INSERT OR REPLACE INTO stress_signal_history (stablecoin_id, snapshot_date, score, band, signals_json) VALUES (?, ?, ?, ?, ?)"
      ).bind(r.stablecoinId, todayMidnight, r.score, r.band, JSON.stringify(r.signals))
    );
    await batchExecute(db, histStmts);
  }

  // 11. Prune old data
  const pruneCutoff = nowSec - 7 * 86400;
  await db.prepare("DELETE FROM stress_signals WHERE computed_at < ?").bind(pruneCutoff).run();
  const histPruneCutoff = nowSec - 365 * 86400;
  await db.prepare("DELETE FROM stress_signal_history WHERE snapshot_date < ?").bind(histPruneCutoff).run();

  console.log(`[dews] Computed DEWS for ${results.length} coins`);
  return results.length;
}
```

**Step 2: Register in `worker/src/index.ts`**

After the stability-index chain (line ~204-205), add:

```typescript
// DEWS depends on stablecoins cache + dex data — run after sync
ctx.waitUntil(stablecoinsSync.then(() =>
  logCronRun(db, "compute-dews", () => computeAndStoreDEWS(db))
));
```

Import at top:
```typescript
import { computeAndStoreDEWS } from "./cron/compute-dews";
```

**Step 3: Add to CRON_INTERVALS in `worker/src/api/status.ts`**

Add to the `CRON_INTERVALS` object:
```typescript
"compute-dews": 900, // 15 min
```

**Step 4: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add worker/src/cron/compute-dews.ts worker/src/index.ts worker/src/api/status.ts
git commit -m "feat(dews): cron job computing DEWS every 15 min"
```

---

## Task 4: API Endpoint — `GET /api/stress-signals`

**Files:**
- Create: `worker/src/api/stress-signals.ts`
- Modify: `worker/src/router.ts` (register route)

**Context:** Follow the pattern of `worker/src/api/stability-index.ts`. Uses `CACHE_PROFILES.standard` from `worker/src/lib/constants.ts`. Two modes: all-coins summary, or single-coin with daily history.

**Step 1: Write `worker/src/api/stress-signals.ts`**

```typescript
import { CACHE_PROFILES } from "../lib/constants";

export async function handleStressSignals(
  db: D1Database,
  url: URL,
): Promise<Response> {
  const stablecoinId = url.searchParams.get("stablecoin");
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 30));

  if (stablecoinId) {
    // Single coin: latest + daily history
    const latest = await db.prepare(
      `SELECT score, band, signals_json, computed_at
       FROM stress_signals
       WHERE stablecoin_id = ?
       ORDER BY computed_at DESC LIMIT 1`
    ).bind(stablecoinId).first<{
      score: number; band: string; signals_json: string; computed_at: number;
    }>();

    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    const history = await db.prepare(
      `SELECT snapshot_date, score, band, signals_json
       FROM stress_signal_history
       WHERE stablecoin_id = ? AND snapshot_date >= ?
       ORDER BY snapshot_date ASC`
    ).bind(stablecoinId, cutoff).all<{
      snapshot_date: number; score: number; band: string; signals_json: string;
    }>();

    return new Response(JSON.stringify({
      current: latest ? {
        score: latest.score,
        band: latest.band,
        signals: JSON.parse(latest.signals_json),
        computedAt: latest.computed_at,
      } : null,
      history: history.results.map(r => ({
        date: r.snapshot_date,
        score: r.score,
        band: r.band,
        signals: JSON.parse(r.signals_json),
      })),
    }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": CACHE_PROFILES.standard,
      },
    });
  }

  // All coins: latest only (subquery for most recent per coin)
  const rows = await db.prepare(
    `SELECT s.stablecoin_id, s.score, s.band, s.signals_json, s.computed_at
     FROM stress_signals s
     INNER JOIN (
       SELECT stablecoin_id, MAX(computed_at) as max_at
       FROM stress_signals GROUP BY stablecoin_id
     ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at`
  ).all<{
    stablecoin_id: string; score: number; band: string;
    signals_json: string; computed_at: number;
  }>();

  const signals: Record<string, object> = {};
  let updatedAt = 0;
  for (const row of rows.results) {
    signals[row.stablecoin_id] = {
      score: row.score,
      band: row.band,
      signals: JSON.parse(row.signals_json),
      computedAt: row.computed_at,
    };
    updatedAt = Math.max(updatedAt, row.computed_at);
  }

  return new Response(JSON.stringify({ signals, updatedAt }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": CACHE_PROFILES.standard,
    },
  });
}
```

**Step 2: Register route in `worker/src/router.ts`**

Add import at top:
```typescript
import { handleStressSignals } from "./api/stress-signals";
```

Add route before the `/api/stablecoin/:id` catch-all:
```typescript
if (path === "/api/stress-signals") {
  return handleStressSignals(db, url);
}
```

**Step 3: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add worker/src/api/stress-signals.ts worker/src/router.ts
git commit -m "feat(dews): GET /api/stress-signals endpoint"
```

---

## Task 5: Frontend Types + Hook

**Files:**
- Create: `src/hooks/use-stress-signals.ts`
- Modify: `src/lib/classification.ts` (add ThreatBand type + colors)

**Context:** Follow the hook pattern in `src/hooks/` (TanStack Query). Use `staleTime = 15min`, `refetchInterval = 30min` per CLAUDE.md hook timing rule. Add ThreatBand type and color constants to `src/lib/classification.ts` — same file that holds all classification labels/colors (per CLAUDE.md gotchas).

**Step 1: Add to `src/lib/classification.ts`**

```typescript
// --- Depeg Early Warning Score (DEWS) threat bands ---
export type ThreatBand = "CALM" | "WATCH" | "ALERT" | "WARNING" | "DANGER";

export const THREAT_BAND_LABELS: Record<ThreatBand, string> = {
  CALM: "Calm",
  WATCH: "Watch",
  ALERT: "Alert",
  WARNING: "Warning",
  DANGER: "Danger",
};

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

**Step 2: Create `src/hooks/use-stress-signals.ts`**

```typescript
import { useQuery } from "@tanstack/react-query";
import { fetchApi } from "@/lib/api";

interface SignalDetail {
  value: number;
  available: boolean;
  [key: string]: unknown;
}

export interface StressSignalEntry {
  score: number;
  band: string;
  signals: Record<string, SignalDetail>;
  computedAt: number;
}

interface StressSignalsAllResponse {
  signals: Record<string, StressSignalEntry>;
  updatedAt: number;
}

interface StressSignalHistoryEntry {
  date: number;
  score: number;
  band: string;
  signals: Record<string, SignalDetail>;
}

interface StressSignalDetailResponse {
  current: StressSignalEntry | null;
  history: StressSignalHistoryEntry[];
}

export function useStressSignals() {
  return useQuery<StressSignalsAllResponse>({
    queryKey: ["stress-signals"],
    queryFn: () => fetchApi("/api/stress-signals"),
    staleTime: 15 * 60 * 1000,
    refetchInterval: 30 * 60 * 1000,
  });
}

export function useStressSignalDetail(stablecoinId: string, days = 30) {
  return useQuery<StressSignalDetailResponse>({
    queryKey: ["stress-signals", stablecoinId, days],
    queryFn: () => fetchApi(`/api/stress-signals?stablecoin=${stablecoinId}&days=${days}`),
    staleTime: 15 * 60 * 1000,
    refetchInterval: 30 * 60 * 1000,
    enabled: !!stablecoinId,
  });
}
```

**Step 3: Build check**

Run: `npm run build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/lib/classification.ts src/hooks/use-stress-signals.ts
git commit -m "feat(dews): frontend types, classification constants, and TanStack Query hooks"
```

---

## Task 6: DEWS Badge Component

**Files:**
- Create: `src/components/dews-badge.tsx`

**Context:** Small badge shown next to coin name/price in tables. Hidden when CALM (score <= 15) to reduce visual noise. Shows band name with colored background. Arrow when score increased. Tooltip with score + top signal. Design doc Section 7.1.

**Step 1: Create `src/components/dews-badge.tsx`**

```typescript
"use client";

import { THREAT_BAND_COLORS, THREAT_BAND_LABELS } from "@/lib/classification";
import type { ThreatBand } from "@/lib/classification";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface DEWSBadgeProps {
  score: number;
  band: ThreatBand;
  prevScore?: number;
  compact?: boolean;
  signals?: Record<string, { value: number; available: boolean }>;
}

export function DEWSBadge({ score, band, prevScore, compact, signals }: DEWSBadgeProps) {
  // Suppress CALM badges to reduce noise
  if (band === "CALM") return null;

  const arrow = prevScore !== undefined && score > prevScore ? " \u25B2" : "";
  const colorClasses = THREAT_BAND_COLORS[band] ?? "";

  // Find the top contributing signal
  let topSignal = "";
  if (signals) {
    const sorted = Object.entries(signals)
      .filter(([, s]) => s.available)
      .sort(([, a], [, b]) => b.value - a.value);
    if (sorted.length > 0) {
      topSignal = `Top: ${sorted[0][0]} (${sorted[0][1].value}/100)`;
    }
  }

  const badge = (
    <span
      className={`inline-flex items-center rounded-sm border px-1 py-0.5 text-[10px] font-semibold leading-none ${colorClasses}`}
    >
      {compact ? band.slice(0, 1) : THREAT_BAND_LABELS[band]}
      {arrow}
    </span>
  );

  if (!topSignal) return badge;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">DEWS: {score}/100</p>
          <p className="text-xs text-muted-foreground">{topSignal}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
```

**Step 2: Build check**

Run: `npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/components/dews-badge.tsx
git commit -m "feat(dews): compact badge component for table rows"
```

---

## Task 7: DEWS Detail Card (Stablecoin Detail Page)

**Files:**
- Create: `src/components/dews-detail.tsx`

**Context:** Full signal breakdown card for the `/stablecoin/[id]` detail page. Shows 6-7 progress bars with sub-signal values, 30-day sparkline chart, band-colored header. Design doc Section 7.2. Uses Recharts for the history chart (existing dependency). Uses `useStressSignalDetail` hook.

**Step 1: Create `src/components/dews-detail.tsx`**

A card component with:
- Band-colored header showing composite score + band name
- 7-row breakdown table: signal name, progress bar, value/100, key metric
- 30-day area chart colored by band
- "Limited data" caveat when `availableSignals < 4`
- Graceful empty state when no DEWS data yet

Signal display labels:
```typescript
const SIGNAL_LABELS: Record<string, { name: string; metricKey: string; metricLabel: string }> = {
  supply:  { name: "Supply Velocity",     metricKey: "delta1d",       metricLabel: "1d change" },
  pool:    { name: "Pool Balance Drift",  metricKey: "balanceRatio",  metricLabel: "balance ratio" },
  liq:     { name: "Liquidity Erosion",   metricKey: "scoreDelta7d",  metricLabel: "7d score \u0394" },
  price:   { name: "Price Confidence",    metricKey: "confidence",    metricLabel: "confidence" },
  diverg:  { name: "Price Divergence",    metricKey: "spreadBps",     metricLabel: "spread (bps)" },
  black:   { name: "Blacklist Activity",  metricKey: "events24h",     metricLabel: "24h events" },
  flow:    { name: "Mint/Burn Flow",      metricKey: "burnSurge",     metricLabel: "burn surge" },
};
```

**Step 2: Build check**

Run: `npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/components/dews-detail.tsx
git commit -m "feat(dews): detail card with signal breakdown and history chart"
```

---

## Task 8: DEWS Summary Widget (Homepage)

**Files:**
- Create: `src/components/dews-summary.tsx`

**Context:** Compact card showing top 5 most stressed coins above CALM. Falls back to "All coins at CALM" when everything is quiet. Design doc Section 7.3. Uses `useStressSignals` hook.

**Step 1: Create `src/components/dews-summary.tsx`**

A card with:
- Title "Depeg Early Warning"
- Sorted list of top 5 coins by DEWS score (only if > 15)
- Each row: symbol, band badge, score number
- Footer: "N coins at CALM"
- Fallback: single line "All N coins at CALM" when no stress
- Links each coin to its detail page

**Step 2: Build check**

Run: `npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/components/dews-summary.tsx
git commit -m "feat(dews): homepage summary widget showing top stressed coins"
```

---

## Task 9: Page Integration

**Files:**
- Modify: `src/app/stablecoin/[id]/page.tsx` (add DEWS detail card)
- Modify: homepage (add DEWS summary widget, location TBD)

**Context:** Add `<DEWSDetail stablecoinId={id} />` to the stablecoin detail page below the price chart section. Add `<DEWSSummary />` to the homepage in the analytics section.

**Step 1: Integrate into detail page**

Import `DEWSDetail` and add it after the price chart / before the report card section in the detail page.

**Step 2: Integrate into homepage**

Import `DEWSSummary` and add it to the homepage analytics grid.

**Step 3: Build + type check**

Run: `npm run build`
Expected: Build succeeds, no type errors

**Step 4: Commit**

```bash
git add src/app/stablecoin/\[id\]/page.tsx src/app/page.tsx
git commit -m "feat(dews): integrate badge, detail card, and summary widget"
```

---

## Task 10: Semantic Design Tokens

**Files:**
- Modify: `src/styles/tokens/semantic.css`

**Context:** Design doc Section 7.6 specifies CSS custom properties for DEWS band colors. Follow existing pattern in semantic.css.

**Step 1: Add DEWS tokens**

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

**Step 2: Build check**

Run: `npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/styles/tokens/semantic.css
git commit -m "feat(dews): add semantic design tokens for threat band colors"
```

---

## Task 11: Backtesting Admin Endpoint

**Files:**
- Create: `worker/src/api/backfill-dews.ts`
- Modify: `worker/src/router.ts` (register admin route)

**Context:** Admin-only endpoint (`X-Admin-Key` required) that validates DEWS against historical depeg events. Design doc Section 6. Uses `computeDEWS()` with reconstructed historical inputs from `supply_history` and `dex_liquidity_history`. Reports TP rate, lead time, and per-event scores. This is critical for calibrating the normalization curves.

**Step 1: Implement `worker/src/api/backfill-dews.ts`**

- Load all completed depeg events (those with both `started_at` and `ended_at`)
- For each event, define the 7-day pre-depeg window
- For each day in the window, reconstruct available signals from `supply_history` and `dex_liquidity_history`
- Set unavailable signals (pool, price confidence, blacklist, flow) to `available: false`
- Compute DEWS, record whether it predicted the depeg (ALERT+ before `started_at`)
- Return aggregate stats + per-event results

**Step 2: Register in router**

```typescript
if (path === "/api/backfill-dews") {
  return handleBackfillDEWS(db, url, adminKey, request);
}
```

**Step 3: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add worker/src/api/backfill-dews.ts worker/src/router.ts
git commit -m "feat(dews): admin backtesting endpoint for calibration"
```

---

## Task 12: Documentation

**Files:**
- Create: `docs/dews.md`
- Modify: `docs/api-reference.md` (add `/api/stress-signals`)
- Modify: `docs/worker-infrastructure.md` (add cron entry)
- Modify: `src/app/methodology/page.tsx` (add DEWS section)
- Modify: `src/app/about/page.tsx` (mention DEWS)

**Step 1: Create `docs/dews.md`**

Document:
- DEWS formula, 7 sub-signals, weights
- Threat bands with colors and meanings
- Normalization curves with anchor points
- Weight redistribution for missing signals
- Edge cases (NAV tokens, non-USD pegs, new coins, no DEX data)
- API endpoint reference
- Cron schedule and data flow

**Step 2: Update `docs/api-reference.md`**

Add:
```
### GET /api/stress-signals
- All coins: latest DEWS + signal breakdown
- Single coin: `?stablecoin=ID&days=30` for history
- Cache: standard (300s/60s)
```

**Step 3: Update `docs/worker-infrastructure.md`**

Add `compute-dews` to the cron section under `*/15 * * * *` trigger.

**Step 4: Update methodology page**

Add a DEWS section explaining the score to end users: what it measures, what the bands mean, and the 7 indicators.

**Step 5: Update about page**

Add a brief mention of the Depeg Early Warning Score feature.

**Step 6: Update CLAUDE.md**

Add `docs/dews.md` to the Topic References section:
```
- **`docs/dews.md`** — DEWS formula, 7 sub-signals, threat bands, normalization, API endpoint
```

**Step 7: Commit**

```bash
git add docs/dews.md docs/api-reference.md docs/worker-infrastructure.md \
       src/app/methodology/page.tsx src/app/about/page.tsx CLAUDE.md
git commit -m "docs(dews): comprehensive documentation and methodology page"
```

---

## Task 13: Run Backtest and Calibrate

**Context:** This is an iterative task. Deploy, run the backtest, review results, adjust normalization curves if needed.

**Step 1: Deploy to dev**

Run: `cd worker && npx wrangler deploy`
Wait 15 min for first cron run.

**Step 2: Run backtest**

```bash
curl -H "X-Admin-Key: $ADMIN_KEY" "https://api.pharos.watch/api/backfill-dews" | jq .
```

**Step 3: Evaluate results**

Target: TP rate >= 60% (ALERT+ before depeg), average lead time > 12 hours.

If TP rate is below 60%, adjust normalization anchors in `dews.ts`:
- If supply velocity is under-reporting: tighten the 1d anchors (lower thresholds)
- If too many false positives: increase dampening or raise thresholds
- Document all calibration changes as inline comments

**Step 4: Commit calibration changes**

```bash
git add worker/src/lib/dews.ts worker/src/lib/__tests__/dews.test.ts
git commit -m "fix(dews): calibrate normalization curves from backtest results"
```

---

## Verification

After all tasks are complete:

1. **Type-check both projects:**
   - `npm run build` (frontend)
   - `cd worker && npx tsc --noEmit` (worker)

2. **Run all tests:**
   - `npm test` (includes worker tests via vitest)

3. **Lint:**
   - `npm run lint`

4. **Local worker test:**
   - `cd worker && npx wrangler dev`
   - Wait for cron trigger or manually curl `GET /api/stress-signals`
   - Verify JSON response shape matches design

5. **Verify API response:**
   ```bash
   curl "https://api.pharos.watch/api/stress-signals" | jq '.signals | to_entries | .[0]'
   curl "https://api.pharos.watch/api/stress-signals?stablecoin=1&days=7" | jq .
   ```

6. **Frontend visual check:**
   - `npm run dev`
   - Visit `/stablecoin/1` — DEWS detail card should render
   - Visit homepage — DEWS summary widget should render
   - Check that CALM coins show no badge, elevated coins show colored badge

---

## File Index

| File | Role |
|------|------|
| `worker/migrations/0032_stress_signals.sql` | Both D1 tables |
| `worker/src/lib/dews.ts` | Pure compute: `piecewiseLinear`, 7 sub-signals, `computeDEWS`, `getThreatBand` |
| `worker/src/lib/__tests__/dews.test.ts` | Unit tests for pure compute function |
| `worker/src/cron/compute-dews.ts` | 15-min cron: reads D1, computes DEWS, stores results |
| `worker/src/api/stress-signals.ts` | `GET /api/stress-signals` handler |
| `worker/src/api/backfill-dews.ts` | Admin backtest endpoint |
| `worker/src/index.ts` | Cron registration (chained after syncStablecoins) |
| `worker/src/router.ts` | Route registration |
| `worker/src/api/status.ts` | CRON_INTERVALS entry |
| `src/lib/classification.ts` | `ThreatBand` type, colors, hex values |
| `src/hooks/use-stress-signals.ts` | TanStack Query hooks |
| `src/components/dews-badge.tsx` | Compact badge for table rows |
| `src/components/dews-detail.tsx` | Full signal breakdown card for detail page |
| `src/components/dews-summary.tsx` | Homepage top-stressed-coins widget |
| `src/styles/tokens/semantic.css` | CSS custom properties for band colors |
| `docs/dews.md` | Full documentation |
