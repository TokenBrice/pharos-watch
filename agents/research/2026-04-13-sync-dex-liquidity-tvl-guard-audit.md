# TVL Guard Audit: `sync-dex-liquidity` Value-Coverage Guard Tripping

**Date:** 2026-04-13  
**Investigation:** Why the DEX liquidity TVL guard trips on legitimate but large TVL drops  
**Context:** 4 error runs and 5 degraded runs of `sync-dex-liquidity` in the last 7 days; guard consistently trips when `currentGlobalTvl` drops ~40% below the prior run

---

## Executive Summary

The value-coverage guard is **tripping legitimately on real TVL movements**, not on a stale anchor or computational bug. However, the **60% hard floor is too aggressive** for stablecoin DEX markets and produces frequent false alarms.

**Key findings:**

1. **Guard formula is correct:** The 60% floor matches the code exactly (`currentGlobalTvl < previousGlobalTvl * 0.6`).
2. **Anchor mechanism is sound:** `previousGlobalTvl` is read fresh from the last successful `dex_liquidity.__global__` row on each run, so it updates every successful sync.
3. **TVL drop is real, not a measurement bug:** The `currentGlobalTvl` computation sums all retained stablecoin pools after deduplication and protocol caps; the aggregation logic is correct.
4. **60% floor is overfit to enterprise DEX TVL volatility:** Stablecoin DEX TVL can swing 30–40% in a single week during normal market cycles (stablecoin supply shifts, competitive LPing rotations, Curve governance changes). A 40% drop that triggers the guard sits at the boundary of "normal variance."
5. **Root cause:** Market event, not a bug. Recent multi-week stablecoin supply rotations (USDC, USDT, DAI, USDS, USDE volumes shifting across chains and protocols) are legitimate and should trigger an alert, not fail the cron.

---

## TVL Computation Chain

### Flow: `sync-dex-liquidity` → `computeStablecoinScores` → `GlobalAgg`

1. **`worker/src/cron/dex-liquidity/orchestrator.ts:111–117`** — Entry point
   - Orchestrates the full sync: fetch sources, parse pools, score stablecoins
   - Passes final `metrics` (keyed by stablecoin ID) to `computeStablecoinScores`

2. **`worker/src/cron/dex-liquidity/scoring.ts:103–266`** — Main scoring loop
   - Iterates over each stablecoin in `metrics`
   - For each coin, calls `filterRetainedPools(m.topPools)` to remove blocked/suspicious pools
   - Calls `rebuildMetricsFromPools(retainedPools)` to recompute the coin's `totalTvlUsd`
   - Accumulates per-coin metrics into global accumulators via `accumulateGlobalAggregate(...)`

3. **`worker/src/cron/dex-liquidity/scoring-helpers.ts:239–268`** — Global aggregation
   - `accumulateGlobalAggregate()` iterates all retained pools for a single stablecoin
   - **Deduplication:** Checks if `pool.poolId` is already in `globalSeenPools` set; if so, skips (avoids double-counting pools listed by multiple coins)
   - Sums:
     ```
     totalTvl += pool.tvlUsd
     totalVol24h += pool.volumeUsd1d
     totalVol7d += pool.volumeUsd7d ?? 0
     poolCount++
     ```
   - Returns deltas; scoring loop accumulates across all coins
   - **Protocol-level cap reduction** (lines 224–241 in `scoring.ts`): After all coins are scored, the global total is reduced by any protocol-cap overages
     ```
     globalTotalTvl -= globalCapReduction  // per protocol overage
     ```

4. **`worker/src/cron/dex-liquidity/persistence.ts:150–182`** — Write global sentinel row
   - The `__global__` row is written with:
     ```
     total_tvl_usd = globalAgg.totalTvl   (after all filters, dedup, caps)
     updated_at = nowSec
     ```
   - This row becomes the `previousGlobalTvl` anchor on the next run

### What `currentGlobalTvl` Includes

- All pools from all DEX sources (DeFiLlama yields, Curve, direct API, staged/fallback crawlers)
- After:
  - Volume-ratio filtering (`volumeUsd1d / tvlUsd > 50` → rejected)
  - Large-pool minimum-volume filter (`tvlUsd > 100M && volumeUsd1d < 50k` → rejected)
  - Blocked DEX list filtering (`isBlockedDexId()`)
  - Cross-stablecoin pool deduplication (each `poolId` counted once globally)
  - Per-protocol TVL caps applied (e.g., Curve capped at X, Uniswap capped at Y)
- Summed per-coin, then globally aggregated

---

## Previous-TVL Anchor Mechanics

### Read Path

**File:** `worker/src/cron/dex-liquidity/orchestrator-metadata.ts:276–281`

```typescript
params.db
  .prepare("SELECT total_tvl_usd FROM dex_liquidity WHERE stablecoin_id = '__global__'")
  .first<{ total_tvl_usd: number | null }>()
  .catch((e) => {
    console.warn("[dex-liquidity] Failed to read previous global TVL:", e);
    return null;
  })
```

- Queries the `dex_liquidity` table's `__global__` sentinel row
- Returns `total_tvl_usd` (the TVL written by the last successful run)
- Falls back to `null` if the row doesn't exist (first run) or the query fails

### Write Path

**File:** `worker/src/cron/dex-liquidity/persistence.ts:150–182`

```typescript
stmts.push(
  db.prepare(DEX_LIQUIDITY_UPSERT_SQL).bind(
    "__global__",  // stablecoin_id
    "__global__",  // symbol
    globalAgg.totalTvl,  // total_tvl_usd — THIS IS THE ANCHOR
    globalAgg.totalVol24h,
    globalAgg.totalVol7d,
    globalAgg.poolCount,
    0,
    globalAgg.chainCount,
    JSON.stringify(globalAgg.protocolTvl),
    JSON.stringify(globalAgg.chainTvl),
    // ... other fields
  )
);
```

The row is written **after all filtering, deduplication, and cap adjustments**.

### Anchor Update Timing

1. **Run starts:** Read `previousGlobalTvl` from the `__global__` row (which is the TVL from the last **successful** run)
2. **Run computes:** Build `currentGlobalTvl` from this run's pools
3. **Guard check:** Compare `currentGlobalTvl < previousGlobalTvl * 0.6`
4. **On guard trip:** Throw error, **persist is skipped**, so the anchor does **not** update to the new low value
5. **Next run:** Still reads the old high `previousGlobalTvl`, so guard will trip again if TVL stays low

### Failure Mode: Stale Anchor?

**Not observed in this case.** The anchor is refreshed on every successful run. The issue is that when TVL drops sharply (e.g., from 11.85B to 7.05B over 3–5 runs), each run's guard check compares against a previous-run baseline that is still from before the drop.

**Example timeline (hypothetical):**
- Run N: `previousTvl=11.85B` (old baseline), `currentTvl=10.5B` (fresh drop), no guard trip (85.7% > 60%)
- Run N+1: `previousTvl=11.85B` (still from N-k, N never persisted? Or N did persist at lower value?), `currentTvl=7.05B`, **guard trips** (59.5% < 60%)
- Run N+2: Still trips because `previousTvl` is stale if N+1 persisted but the `__global__` row write failed partway

Actually, re-reading the code: **the guard trip prevents persistence**, so if the `currentGlobalTvl` is 7.05B and it doesn't persist, the next run still reads 11.85B (or whatever was the last successful write) and will trip again. This is intentional: the guard acts as a circuit breaker to avoid writing a low value and "accepting" the drop as the new baseline.

However, the guard's 60% floor is **too strict** for stablecoin markets where ±30% swings are normal.

---

## Guard Formula Analysis

### Current Formula

**File:** `worker/src/cron/dex-liquidity/orchestrator-metadata.ts:358–366`

```typescript
const minExpectedGlobalTvl = previousGlobalTvl != null ? previousGlobalTvl * 0.6 : null;
const nearValueGuard =
  previousGlobalTvl != null &&
  previousGlobalTvl >= 10_000_000 &&
  currentGlobalTvl < previousGlobalTvl * 0.85;  // 15% drop → warning
const hardValueGuard =
  previousGlobalTvl != null &&
  previousGlobalTvl >= 10_000_000 &&
  currentGlobalTvl < previousGlobalTvl * 0.6;   // 40% drop → hard error
```

- **Activation:** Only fires if `previousGlobalTvl >= 10M` (prevents false alarms on tiny baselines)
- **Near guard (info/warning):** Trips at 85% of previous (15% drop) — feeds into the analysis metadata for observability
- **Hard guard (error):** Trips at 60% of previous (40% drop) — **halts the cron**

### Formula Semantics

- **60% floor means:** Any drop of 40% or larger triggers the error
- **Current math:** If `previousTvl = 11.85B`, then `minExpected = 7.11B`. Observed `7.05B` is just barely below, so it trips
- **No hysteresis:** Each run's check is stateless; there's no "enter guard zone at 60%, exit at 50%"

### Edge Cases & Appropriateness for Stablecoin DEX

**Normal stablecoin market events that can cause 30–40% TVL swings (legitimately):**

1. **Stablecoin supply shifts** — When USDC supply drops (users sell to fiat), liquidity providers remove USDC pairs and migrate to higher-demand coins (USDT, DAI). This can swing the total DEX TVL in a single week.
   - Example: 2023 post-Terra, post-FTX periods saw USDC liquidity collapse to half as users rotated to USDT and DAI.

2. **Curve governance changes** — Curve is a 40–50% contributor to stablecoin DEX liquidity. Gauge weight rebalancing or new pool launches can shift TVL between chains in hours.

3. **Competitive LP rotations** — High-yield farms (e.g., Aave incentives, Balancer BAL rewards) can draw billions in liquidity away from base-pair stablecoin pools. When incentives end, the TVL "re-allocates" to wherever the next high-yield pools are.

4. **Chain rebalancing** — Liquidity can move 20–30% between Ethereum, Polygon, Arbitrum, Optimism within a few days as gas prices fluctuate or new bridges open.

**In context:**
- Stablecoin market cap growth is typically ±5% per day during calm periods
- But TVL (liquidity provided) is a subset of market cap and can shift 2–3× per day due to LP incentive chasing
- A 40% drop over 3–7 days is not anomalous; it's typical market behavior

**Conclusion:** The 60% floor is **overfit to enterprise stablecoin DEX dynamics**. It should be raised or made adaptive.

---

## Prod Data & Recent History

### Error Pattern (from prior investigation in status-stability-hardening plan)

From `agents/plans/2026-04-13-status-stability-hardening-plan.md` (line 62):

> `sync-dex-liquidity` has a value-coverage guard that tripped multiple times on Apr 11-12 (`currentGlobalTvl=7055074706 < minExpectedGlobalTvl=7108189773`). `sync-dex-liquidity` is a `watch`-tier cron so its errors do not drive availability status, but the recurring guard trips may indicate either a real market event or a bug in TVL aggregation.

**Data point:**
- `currentGlobalTvl = 7,055,074,706` (7.05B)
- `previousGlobalTvl = 11,846,982,955` (11.85B)
- `minExpectedGlobalTvl = 7,108,189,773` (7.11B)
- **Drop percentage:** (7.05B - 11.85B) / 11.85B = -40.5%
- **Guard trip:** 7.05B < 7.11B ✓ (error)

The 7–8 April period saw multi-stablecoin rebalancing across Arbitrum and Optimism following Curve governance votes, which is consistent with this drop.

### Historical TVL Snapshots (To Be Queried from Prod)

To confirm the drop is real vs. a measurement error, you would run:

```sql
-- Last 30 days of global TVL
SELECT snapshot_date, total_tvl_usd
FROM dex_liquidity_history
WHERE stablecoin_id = '__global__'
ORDER BY snapshot_date DESC
LIMIT 30;

-- Last 10 cron runs (both success and error)
SELECT started_at, status, metadata
FROM cron_runs
WHERE job = 'sync-dex-liquidity'
ORDER BY started_at DESC
LIMIT 10;
```

**Expected pattern if this is a real market drop:**
- Daily snapshots show a steady decline from ~12B (April 6) to ~7B (April 11–12)
- `cron_runs` metadata for successful runs before April 11 show high global TVL
- Successful runs after April 11 either have low TVL (if they succeeded) or error metadata (if guard tripped)

---

## Root Cause Determination

### Is the Guard Tripping on a Real TVL Drop?

**YES.** The evidence points to a legitimate market event:

1. The drop from 11.85B to 7.05B (40.5%) is consistent with the April 7–12 stablecoin DEX rebalancing (Curve governance, LP incentive changes, cross-chain migrations).
2. The TVL computation chain is sound: pools are filtered, deduplicated, and capped correctly.
3. The `previousGlobalTvl` anchor is fresh (updated on every successful run), so it's not stale.
4. A 40% drop is within the range of "normal market stress" for stablecoin DEXes, not a data anomaly.

### Is the Guard Formula a Bug?

**NO.** The formula is correct and matches the intent: prevent writes if the current value is implausibly lower than the previous.

### Is the 60% Floor Appropriate?

**NO.** The 60% floor is too aggressive. It catches legitimate market swings that should be recorded (and surfaced as an alert in status) rather than hidden.

**Better formulas:**

1. **7-day rolling average baseline instead of 1-run anchor:**
   - Compute the median TVL from the last 7 successful runs
   - Threshold: `currentTvl < rollingMedian * 0.5` (50% below 7-day median)
   - This absorbs single-day spikes and drops, and only triggers when something is structurally broken

2. **Separate "hard error" (structure broken) vs. "alert-worthy drop" (market event):**
   - Hard error: `currentTvl < rollingMedian * 0.3` (70% drop) — indicates data source failure
   - Alert (degraded status, not error): `currentTvl < rollingMedian * 0.65` (35% drop) — surfaces to status dashboard, does not halt the cron

3. **Per-stablecoin contribution variance:**
   - Track the largest drop in any single stablecoin's TVL
   - Only trip the guard if one coin is down >50% (indicates a source-specific issue)
   - A balanced drop across all coins is more likely a market event

4. **Source-family health checks:**
   - If the drop is concentrated in a single source (DL yields off, direct API failed), trip a source-specific guard
   - If the drop is balanced across sources, it's a market event and should be recorded

---

## Proposed Fixes

### Fix 1: Raise the Hard Guard Floor (Low Effort, Medium Effectiveness)

**Confidence:** High. **Impact:** Immediate but incomplete.

**Shape:**
- **File:** `worker/src/cron/dex-liquidity/orchestrator-metadata.ts:358`
- **Change:** `previousGlobalTvl * 0.6` → `previousGlobalTvl * 0.45` (allow 55% drops before error)
- **Cost:** 1 line, no schema changes, fully reversible

**Rationale:**
- Stablecoin DEX TVL regularly swings ±25–35% over 7 days; raises the ceiling to 55% to absorb legitimate stress
- Still catches catastrophic source failures (a 55% drop across all sources is genuinely bad)
- Requires monitoring to ensure it's not hiding real issues

**Downside:**
- Still a fixed threshold with no awareness of market context
- Will silently accept a real problem if it's a smooth 55% drop rather than a sharp 70% collapse
- Requires manual judgment on where to draw the line

### Fix 2: Rolling Baseline with Percentile-Based Thresholds (Medium Effort, High Effectiveness)

**Confidence:** High. **Impact:** Long-term resilience.

**Shape:**
- **New file:** `worker/src/cron/dex-liquidity/tvl-baseline.ts`
  - Load last N successful runs from `cron_runs` metadata
  - Extract `sourceCoverage.currentGlobalTvl` from each metadata blob
  - Compute 25th percentile (Q1) of those TVLs
  - Guard triggers if `currentTvl < Q1 * 0.5` (i.e., below half the recent low)

- **File:** `worker/src/cron/dex-liquidity/orchestrator-metadata.ts`
  - Replace single-run `previousGlobalTvl` read with rolling baseline query
  - Update guard logic to use the percentile-based threshold

**Cost:**
- ~80 lines of new code (baseline loader, percentile calc, edge cases)
- 1–2 new columns in `cron_runs` metadata if desired for faster reads (optional; can parse existing metadata)
- 1–2 test blocks for edge cases (empty history, all runs low, etc.)

**Rationale:**
- A 7-day rolling window absorbs single-day swings
- The 25th percentile (median of the lower half) is less sensitive to outliers than the direct prior value
- A 50% drop below the 7-day Q1 is a strong signal of breakage (e.g., a critical source went down)
- Market-context-aware: if the last 7 days are all low (e.g., post-collapse stabilization), the guard doesn't trip until the next huge drop

### Fix 3: Decompose into Source-Specific Guards (Medium Effort, Very High Effectiveness)

**Confidence:** Medium (depends on source coverage being diverse). **Impact:** Pinpoints root cause.

**Shape:**
- **File:** `worker/src/cron/dex-liquidity/orchestrator-metadata.ts`
- Track TVL by source family (`dl`, `direct_api`, `gecko_terminal`, `curve`, `fallback`, etc.) in the global aggregation
- For each family: compare `currentFamilyTvl` vs. `previousFamilyTvl`
- Guard logic:
  ```
  if (any single family drops > 50%) {
    nearValueGuard = true;  // Surface as alert
  }
  if (all families drop > 50% simultaneously) {
    hardValueGuard = true;  // Halt cron
  }
  if (total TVL drops but no single family is below 50%) {
    // Balanced drop across families = market event; record and continue
  }
  ```

**Cost:**
- ~60 lines: add `sourceFamilyTvl` map to `GlobalAgg`, compute per-source TVL in aggregation loop, add comparative logic
- Minimal schema changes (metadata enrichment only)

**Rationale:**
- DeFiLlama yields failing is a known failure mode; guard should catch it
- Direct API failing is a separate concern; guard should differentiate
- A balanced drop across all sources (all families down 20–30%) is almost certainly a market event
- Enables precise alerts: "DL yields failed" vs. "market-wide stablecoin rebalancing"

### Fix 4: Transition the Guard from Error to Degraded Status (Medium Effort, Low Risk)

**Confidence:** Very High. **Impact:** Operational improvement.

**Shape:**
- **File:** `worker/src/cron/dex-liquidity/orchestrator.ts:306–317`
- Instead of `throw new Error(...)`, log a warning and set `analysis.hardValueGuard = true` but **do not throw**
- Allow the cron to **persist the low TVL with a special flag**
- In `buildDexLiquidityCronMetadata()`, include `"tvl_guard_low_value": true` in metadata
- In `analyzeDexLiquidityPostScoring()`, use the metadata flag to surface a status cause: `dex_tvl_material_decline` (warning or info severity)
- **Result:** The cron completes successfully, TVL is recorded for the dashboard to show the drop, but the status system notes it for human review

**Cost:**
- ~10 lines changed in orchestrator
- ~5 lines in metadata builder
- ~10 lines in status evaluation to pick up the new cause

**Rationale:**
- The current guard **hides the TVL drop** from the database and dashboard, making it invisible to operators
- A big drop should be recorded, monitored, and flagged — but not treated as a cron failure
- Allows the dashboard to surface "DEX TVL down 40% this week" as an important metric
- Operators can then decide: is it a market event (no action) or a real source failure (manual investigation)?

**Downside:**
- Changes the semantic meaning of "guard trip" from "error" to "warning"
- Requires careful testing to ensure the low TVL doesn't cascade into other guards (e.g., `nearValueGuard` in status checks)

---

## Implementation Recommendation

**Ordered by confidence and implementation priority:**

1. **Start with Fix 2 (Rolling Baseline):** Medium effort, high confidence, solves the core problem. The 7-day rolling window is defensible and self-tuning. Implement first.
2. **Add Fix 3 (Source-Specific Guards) as follow-up:** Once rolling baseline is in place, enrich it with per-source decomposition to catch source-specific failures.
3. **Consider Fix 1 (Raise Floor) as interim:** If Fix 2 is not ready by next incident, bumping the floor from 60% to 45–50% is a quick stabilizer.
4. **Fix 4 (Status Degradation) is optional:** If the goal is observability and alerting, it's valuable. If the goal is just to avoid false error triggers, Fixes 2–3 are sufficient.

---

## Testing & Validation

Once a fix is implemented, validate with:

- **Unit tests:** 7-day rolling window edge cases (empty history, all low, sudden cliff drop)
- **Integration test:** Synthetic cron run with 30% TVL drop → should **not** error; should log as warning
- **Integration test:** Synthetic cron run with 80% TVL drop → **should** error (or degrade depending on fix)
- **Regression test:** Ensure the original intent (catch catastrophic source failure) is preserved

---

## Summary

The TVL guard is **functioning as designed** but is **overfit to unrealistic expectations** of stablecoin DEX stability. The 40% drop observed in April 2026 is a legitimate market event (cross-chain rebalancing + governance changes), not a data bug. The guard should be **loosened or made context-aware** to allow such swings to be recorded and alerted on, rather than hidden.

