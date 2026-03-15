# DEX Feature End-to-End Audit

**Date:** 2026-03-15
**Scope:** Pool discovery, DEX price analysis, liquidity scoring, API endpoints, frontend consumers, test coverage
**Method:** 6 parallel exploration agents + manual verification of critical findings

---

## Executive Summary

The DEX feature is well-engineered with strong defensive patterns, good separation of concerns (discovery vs scoring crons), and thoughtful quality multiplier design. The architecture — primary sources (DeFiLlama + Curve + UniV3 + Aerodrome) augmented by staged discovery (CG Onchain, GeckoTerminal, DexScreener, CG Tickers) — is sound and provides good coverage.

That said, this audit uncovered **12 confirmed issues** worth addressing, categorized below by severity. Several agent-reported findings were verified as false positives and are documented at the end for transparency.

---

## SEVERITY: HIGH (3 issues)

### H-1. organicFraction can propagate NaN through scoring

**File:** `worker/src/cron/dex-liquidity/process-pools.ts:148-154`

```typescript
if (pool.apyBase != null && pool.apy > 0.01) {
  organicFraction = Math.min(1, Math.max(0, pool.apyBase / pool.apy));
```

If `pool.apyBase` is present but happens to be `NaN` (e.g., DeFiLlama returns a non-numeric string that survives JSON parse), `pool.apyBase / pool.apy` produces `NaN`, which propagates through:
- `computePoolStress()` (line 180)
- `m.organicTvlWeightedSum` (line 199)
- `m.organicFrac` in the final score
- Ultimately the durability component and composite liquidity score

**Likelihood:** Low (DeFiLlama typically returns numbers or null), but the blast radius is high because one NaN pool poisons an entire stablecoin's score.

**Fix:** Add `Number.isFinite()` guard:
```typescript
if (pool.apyBase != null && Number.isFinite(pool.apyBase) &&
    pool.apy != null && Number.isFinite(pool.apy) && pool.apy > 0.01) {
```

---

### H-2. computeSeriesStability doesn't filter non-finite values

**File:** `worker/src/cron/dex-liquidity/scoring.ts:138-145`

```typescript
function computeSeriesStability(values: number[]): number | null {
  if (values.length < 7) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
```

If any element in `values` is `NaN` or `Infinity` (e.g., from a corrupted D1 history row), the entire `mean` becomes `NaN`, and the function returns `NaN` instead of `null`. This corrupts `depth_stability` and the durability sub-component for that stablecoin.

**Fix:**
```typescript
function computeSeriesStability(values: number[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < 7) return null;
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  if (mean <= 0) return null;
  const variance = finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finite.length;
  const cv = Math.sqrt(Math.max(0, variance)) / mean;
  return Math.round((1 - Math.min(1, cv)) * 10000) / 10000;
}
```

---

### H-3. Discovery miss recorded when pool persistence fails, not crawl

**File:** `worker/src/cron/dex-discovery/orchestrator.ts:238-249`

```typescript
} catch (err) {
  // ...
  try {
    await updateDiscoveryMeta(db, candidate.stablecoinId, 0, nowSec);  // records miss
  } catch { /* non-blocking */ }
}
```

The catch block wraps both `upsertStagedPools()` and the preceding crawl. If the crawl succeeds (pools discovered) but `upsertStagedPools()` fails (D1 error), the coin gets a miss recorded, incrementing `consecutive_misses`. After enough persistence failures, the coin gets demoted to T3 or dormant despite having real DEX presence.

**Likelihood:** Low (D1 outages are rare), but when it happens it creates a self-reinforcing demotion — the coin gets crawled less often, making recovery slower.

**Fix:** Separate crawl errors from persistence errors:
```typescript
try {
  const result = await crawlCoin(...);
  try {
    await upsertStagedPools(db, result.pools);
    await updateDiscoveryMeta(db, candidate.stablecoinId, result.pools.length, nowSec);
  } catch (persistErr) {
    console.warn("[dex-discovery] Persistence failed for", candidate.stablecoinId, persistErr);
    // Don't count as miss — crawl succeeded
  }
} catch (crawlErr) {
  // Only count crawl failures as misses
  await updateDiscoveryMeta(db, candidate.stablecoinId, 0, nowSec).catch(() => {});
}
```

---

## SEVERITY: MEDIUM (4 issues)

### M-1. DEX freshness window (20min) misaligns with scoring cron cycle (30min)

**File:** `worker/src/cron/detect-depegs.ts:26-31` and `worker/src/lib/constants.ts:19`

The depeg detection cron uses `DEX_FRESHNESS_SEC = 1200` (20 min) to decide if a DEX price row is trusted for depeg suppression/confirmation. But the DEX scoring cron runs every 30 minutes (`10,40 * * * *`). This means:

- Minutes 0-20 after sync: DEX prices are trusted
- Minutes 20-30 after sync: DEX prices are "stale" and depeg detection falls back to primary-only

A depeg event triggered at minute 25 cannot use DEX cross-validation, even though the DEX data is only 25 minutes old and the next refresh is 5 minutes away. This creates a 10-minute blind spot every 30-minute cycle where DEX-based false-positive suppression is unavailable.

**Fix:** Extend `DEX_FRESHNESS_SEC` to 2100 (35 min) to cover the full cron cycle with a small buffer, or keep it at 1200 but document the gap.

---

### M-2. Frontend doesn't surface Warning header for degraded DEX data

**File:** `src/app/liquidity/client.tsx` (meta.warning handling)

The `/api/dex-liquidity` endpoint attaches a `Warning` header when the last `sync-dex-liquidity` run was degraded or failed. The frontend hook (`useDexLiquidity`) does receive `meta.warning`, but the liquidity page doesn't display it to users. If the DEX cron is degraded (e.g., DeFiLlama down, running on fallback sources only), users see stale or lower-quality scores with no visual indication.

**Fix:** Parse `meta.warning` and show a banner when non-null, e.g., "DEX data may be incomplete — some sources were unavailable during the last sync."

---

### M-3. Inconsistent dex_prices table error handling across API endpoints

**File:** `worker/src/api/dex-liquidity.ts:177-182` vs `worker/src/api/peg-summary.ts`

The `/api/dex-liquidity` handler wraps the `dex_prices` query in a try-catch that gracefully handles a missing table (pre-migration environments). The `/api/peg-summary` handler loads the same table via `loadDexPriceRows()` which also has its own try-catch (in `depeg-helpers.ts:47-60`), so this is actually handled — but the pattern is inconsistent and would benefit from a shared helper that all consumers use.

**Fix:** Verify `loadDexPriceRows()` is used everywhere, or centralize the fallback pattern.

---

### M-4. Volume/TVL ratio threshold applied inconsistently across discovery stages

**File:** `worker/src/cron/dex-discovery/crawl-sources.ts`

- CG Onchain (line 101): `volume24h / tvlUsd > 50` — skips pools with >50x daily turnover ratio
- GeckoTerminal (line ~292): No ratio check
- DexScreener (line ~363): No ratio check

This means GT and DS can introduce pools with unrealistic volume/TVL ratios (e.g., wash-traded pools) that CG Onchain would correctly reject. These pools enter staging and can inflate volume-based scoring components.

**Fix:** Apply the same 50x ratio guard in all discovery stages, or document why GT/DS are exempt.

---

## SEVERITY: LOW (5 issues)

### L-1. Locked liquidity denominator only includes pools WITH locked percentage

**File:** `worker/src/cron/dex-liquidity/scoring.ts:94-98`

```typescript
if (lockedLiquidityPct != null && lockedLiquidityPct > 0) {
  lockedLiqWeightedSum += pool.tvlUsd * (lockedLiquidityPct / 100);
  totalTvlForLocked += pool.tvlUsd;
}
```

The `> 0` condition excludes pools reporting 0% locked liquidity from the denominator. The resulting `lockedLiqPct` average only considers pools that have some locked liquidity, skewing the metric upward. A pool reporting "0% locked" is useful signal and should be included in the average.

**Fix:** Change to `lockedLiquidityPct >= 0`.

---

### L-2. TrendArrow displays negligible changes (< 0.05%)

**File:** `src/components/dex-liquidity-card.tsx:30-40`

Very small TVL changes (e.g., +0.01%) display as "up 0.0%" which is confusing. An epsilon threshold would avoid showing meaningless fluctuations.

**Fix:** Return `null` when `Math.abs(value) < 0.05`.

---

### L-3. TopPoolsTable doesn't indicate truncation

**File:** `src/components/dex-liquidity-card.tsx:149-214`

Shows "Top Pools" header and slices the first 5, but gives no indication that more pools exist. A stablecoin with 30 pools appears to only have 5.

**Fix:** Add subtitle like "Top 5 of {poolCount} pools".

---

### L-4. Browser cache (60s) is short relative to 30-min cron interval

**File:** `worker/src/lib/constants.ts:63`

`max-age=60` for the dex-liquidity endpoint means a user visiting the liquidity page twice within 2 minutes triggers a fresh network request despite the data not changing for 30 minutes. CDN cache is 300s.

**Fix:** Change `max-age` to 300 to match CDN.

---

### L-5. Protocol confidence function uses fragile prefix matching

**File:** `worker/src/cron/dex-liquidity/constants.ts:103-117`

```typescript
export function dexPriceConfidenceForProtocol(protocol: string): number {
  if (protocol === "curve" || protocol === "uniswap-v3" || protocol === "aerodrome") return 1.0;
  if (protocol.startsWith("staged-cg_onchain") || ...) return 0.85;
  if (protocol.startsWith("dexscreener") || ...) return 0.55;
  return 0.3;
}
```

Primary sources use exact match, fallback sources use `startsWith()`. Adding a new primary source like `"curve-v2"` would silently fall through to the 0.3 default. The expected protocol string formats are undocumented.

**Fix:** Add a code comment documenting the exact protocol strings each source produces, or use a lookup map.

---

## TEST COVERAGE GAPS

The feature has ~2,375 lines of test code across 12 files. Coverage is strong for scoring components and API handlers but has significant gaps in the data-fetching and discovery layers.

### Completely untested files (0% coverage):
| File | Role | Risk |
|------|------|------|
| `fetch-primary.ts` | DeFiLlama + Curve + UniV3 + Aerodrome fetching | HIGH — core data acquisition |
| `fetch-crawlers.ts` | CG Onchain + GeckoTerminal orchestration | MEDIUM |
| `crawl-helpers.ts` | Generic crawl loop, budget enforcement, address resolution | MEDIUM |
| `staging-merge.ts` | Staged pool merge + fingerprint dedup during scoring | MEDIUM |
| `subgraph-helpers.ts` | Subgraph query + retry + pagination | LOW |

### Partially tested files (key gaps):
| File | What's missing |
|------|---------------|
| `orchestrator.ts` (scoring) | Coverage guard logic, fallback signal accumulation, catastrophic failure paths |
| `orchestrator.ts` (discovery) | Tiered priority scheduling, backoff logic, budget exhaustion |
| `process-pools.ts` | Metapool detection, protocol TVL cap enforcement, per-pool TVL bounds |
| `pool-helpers.ts` | Address learning, `computeDepthStability()`, pool stress boundary conditions |
| `price-sanity.ts` | Non-USD peg edge cases, missing/stale reference rates, commodity decimal scaling |

### Critical untested paths:
1. **End-to-end flow**: No integration test covering fetch -> parse -> merge -> score -> persist
2. **Catastrophic failure**: No test for when DL + Curve both fail simultaneously
3. **Coverage classification**: No test for primary/mixed/fallback boundary conditions
4. **Fingerprint deduplication**: No test for cross-source pool dedup via token-pair fingerprints
5. **Discovery cascade**: No test for the CG -> GT -> DS -> CG Tickers source ordering

---

## DESIGN OBSERVATIONS (not issues, but worth noting)

### D-1. DEX price confidence weighting is an intentional design tradeoff
The TVL-weighted median applies confidence multipliers (1.0x for primary, 0.85x for CG/GT, 0.55x for DS/tickers) to scale TVL weights before computing the median. This means the median shifts toward higher-confidence sources even when lower-confidence sources have equal on-chain liquidity. This is a defensible design choice — it trusts primary sources more — but it means the "TVL-weighted median" is really a "confidence-and-TVL-weighted median." Worth documenting explicitly in the methodology.

### D-2. DEX price promotion into consensus uses the stricter tier
`enrich-prices.ts:424` promotes DEX prices using the `"depeg"` tier (20min freshness, $1M TVL), which is stricter than the `"ui"` tier (60min, $250K). This is the correct conservative choice — only high-confidence DEX observations enter primary pricing consensus. One agent flagged this as "overly conservative," but the current behavior is appropriate.

### D-3. Non-USD peg validation uses FX references correctly
The `isPlausibleDexObservationPrice()` function in `price-sanity.ts` builds a validation context from the stablecoin's peg type and passes live FX/commodity references. DEX prices for EUR-pegged or gold-pegged stablecoins are validated against their reference rate, not just hardcoded bounds. This is working correctly.

---

## VERIFIED FALSE POSITIVES

These findings were reported by exploration agents but confirmed as non-issues after manual code verification:

| Claim | Verdict | Why |
|-------|---------|-----|
| `incrementRunSeq()` race condition in discovery | **Safe** | D1's `db.batch()` runs as a SQLite transaction; concurrent batches serialize writes correctly |
| DexScreener div-by-zero at line 70 (`basePriceUsd / priceNative`) | **Guarded** | Lines 63-64 check `!Number.isFinite(priceNative) \|\| priceNative <= 0` before reaching the division |
| Curve balance ratio NaN propagation (fetch-primary.ts:191-208) | **Guarded** | `isNaN(raw) \|\| isNaN(decimals) ? 0` guards parseFloat, `.filter(b > 0)` removes zeros, `maxBal > 0` guards division |
| Pool filtering destroys pre-computed aggregates (scoring.ts) | **By design** | `rebuildMetricsFromPools()` explicitly recomputes all aggregates from the retained pool set |
| Staged pool confidence decay not applied to all data points | **Applied correctly** | Both TVL and volume are multiplied by `confidence`; verified in staging-merge.ts |
| globalTotalVol24h missing null guard (scoring.ts:332) | **Type-safe** | `PoolEntry.volumeUsd1d` is typed as `number` (not nullable); null is coalesced to 0 at construction in process-pools.ts:220 |
| Recursive price fallback loop (enrich-prices -> dex_prices -> stablecoins cache) | **Non-circular** | DEX prices enter consensus with weight=1 (lowest); they can shift but not dominate. Primary prices are fetched fresh from external sources each cycle, not read from stale cache |

---

## RECOMMENDED ACTION PLAN

### Immediate (next sprint)
1. Fix **H-1** (organicFraction NaN guard) — 5 min, zero risk
2. Fix **H-2** (computeSeriesStability finite filter) — 5 min, zero risk
3. Fix **H-3** (separate crawl vs persistence errors in discovery) — 15 min, low risk

### Short-term
4. Fix **M-1** (DEX freshness window) — review constant, 5 min
5. Fix **M-2** (surface Warning header in frontend) — 30 min UI work
6. Fix **M-4** (uniform vol/TVL ratio guard across discovery) — 10 min
7. Add tests for `fetch-primary.ts` and `staging-merge.ts` — highest-value test coverage investment

### When convenient
8. Fix **L-1** through **L-5** — small improvements, batch together
9. Expand test coverage for discovery orchestrator and coverage classification
10. Document confidence weighting design decision in methodology page
