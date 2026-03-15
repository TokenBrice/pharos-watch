# DEX Audit Remediation — Design Spec

**Date:** 2026-03-15
**Source:** `agents/audits/dex-feature-audit-2026-03-15.md`
**Scope:** 11 issue fixes + targeted test coverage for high-risk untested paths

---

## 1. Overview

Remediate issues identified in the DEX feature end-to-end audit. Each fix is small and self-contained. Tests are bundled with each fix. Additionally, targeted test coverage is added for the highest-risk untested functions in `crawl-helpers.ts`, `staging-merge.ts`, `process-pools.ts`, `scoring.ts`, and `price-sanity.ts`.

No migrations. No API shape changes. No scoring weight changes. No breaking changes.

**Note:** Original audit finding M-2 (Warning header not shown in frontend) was a false positive — the amber warning banner already exists at `src/app/liquidity/client.tsx:167-170`. The existing implementation is non-dismissible, which is acceptable since the warning auto-clears when the next successful cron run completes. M-2 is dropped from remediation scope.

---

## 2. Fixes

### 2.1 H-1: organicFraction NaN propagation

**File:** `worker/src/cron/dex-liquidity/process-pools.ts:148-154`

**Current:**
```typescript
if (pool.apyBase != null && pool.apy > 0.01) {
  organicFraction = Math.min(1, Math.max(0, pool.apyBase / pool.apy));
  hasMeasuredOrganicFraction = true;
} else if (pool.apyBase != null) {
  organicFraction = pool.apyBase > 0 ? 1.0 : 0;
  hasMeasuredOrganicFraction = true;
}
```

**Change:** Add `Number.isFinite()` guards on both `pool.apyBase` and `pool.apy`:
```typescript
if (pool.apyBase != null && Number.isFinite(pool.apyBase) &&
    pool.apy != null && Number.isFinite(pool.apy) && pool.apy > 0.01) {
  organicFraction = Math.min(1, Math.max(0, pool.apyBase / pool.apy));
  hasMeasuredOrganicFraction = true;
} else if (pool.apyBase != null && Number.isFinite(pool.apyBase)) {
  organicFraction = pool.apyBase > 0 ? 1.0 : 0;
  hasMeasuredOrganicFraction = true;
}
```

**Test:** Add cases in `process-pools.test.ts` for pools with `apyBase: NaN`, `apy: Infinity`, `apy: 0`, `apyBase: -1`.

---

### 2.2 H-2: computeSeriesStability NaN propagation

**File:** `worker/src/cron/dex-liquidity/scoring.ts:138-145`

**Current:**
```typescript
function computeSeriesStability(values: number[]): number | null {
  if (values.length < 7) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean <= 0) return null;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const cv = Math.sqrt(variance) / mean;
  return Math.round((1 - Math.min(1, cv)) * 10000) / 10000;
}
```

**Change:**
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

**Test:** Export the function (with `/** @internal */` annotation) and add direct tests for: array with NaN elements, array with Infinity, array with < 7 finite values after filtering, all-zero array, normal array (regression).

---

### 2.3 H-3: Discovery miss recorded on persistence failure

**File:** `worker/src/cron/dex-discovery/orchestrator.ts:228-250`

**Current:** Single try/catch wraps both crawl and persistence. Catch records a miss regardless of which step failed.

**Change:** Nested try blocks:
```typescript
try {
  const result = await crawlCoin(/* ... */);
  try {
    await upsertStagedPools(db, result.pools);
    await updateDiscoveryMeta(db, candidate.stablecoinId, result.pools.length, nowSec);
    // ... success bookkeeping
  } catch (persistErr) {
    rethrowIfAborted(persistErr, signal);
    console.warn("[dex-discovery] Persistence failed for", candidate.stablecoinId, persistErr);
    failedCoins.push(candidate.stablecoinId);
    failedCoinErrors[candidate.stablecoinId] = summarizeDiscoveryError(persistErr);
    // Do NOT record miss — crawl succeeded, persistence failed
  }
} catch (crawlErr) {
  rethrowIfAborted(crawlErr, signal);
  console.warn("[dex-discovery]", candidate.stablecoinId, crawlErr);
  failedCoins.push(candidate.stablecoinId);
  failedCoinErrors[candidate.stablecoinId] = summarizeDiscoveryError(crawlErr);
  try {
    await updateDiscoveryMeta(db, candidate.stablecoinId, 0, nowSec);
  } catch { /* non-blocking */ }
}
```

Note: `failedCoins` will include persistence-failed coins, which is correct — the cron metadata shows partial failures. Downstream consumers (cron status, alerts) treat `failedCoins` as "something went wrong for this coin," not "no data exists."

**Test:** Add cases verifying:
- Crawl success + persist success = hit recorded
- Crawl success + persist failure = no miss recorded, appears in failedCoins
- Crawl failure = miss recorded

---

### 2.4 M-1: DEX freshness window

**File:** `worker/src/lib/constants.ts:19`

**Change:** `DEX_FRESHNESS_SEC` from `1200` to `2100`.

**Tradeoff:** This relaxes the data quality threshold for the depeg detection safety path. DEX prices up to 35 minutes old will now be trusted for depeg suppression/confirmation, vs 20 minutes previously. This is acceptable because: (a) the DEX scoring cron runs every 30 min, so requiring <20 min freshness creates a 10-min blind spot every cycle; (b) if a real depeg is happening, the DEX price itself will confirm it (not suppress it); (c) 35 min is still well within one cron cycle + buffer.

**Test:** Update any existing test that asserts on the 1200 value. Add a test verifying that a DEX row 25 min old passes `isTrustedDexPriceRow(row, now, "depeg")`.

---

### 2.5 M-3: dex_prices error handling consistency

**Files:** `worker/src/api/dex-liquidity.ts`, `worker/src/api/peg-summary.ts`

Both endpoints query `dex_prices` with inline try-catch blocks rather than using the shared `loadDexPriceRows()` from `depeg-helpers.ts`. They query different column sets (dex-liquidity includes `price_sources_json`; peg-summary omits it), which justifies separate queries.

**Change:** Add code comments in both handlers noting the pattern and cross-referencing `loadDexPriceRows()` as the canonical fallback pattern. No functional change needed — both already handle missing table gracefully.

**Test:** Existing API tests cover both endpoints; verify no regression.

---

### 2.6 M-4: Volume/TVL ratio guard in DexScreener discovery stage

**File:** `worker/src/cron/dex-discovery/crawl-sources.ts:363`

**Correction from audit:** GeckoTerminal already has the vol/TVL > 50 guard via `crawlTokenPools()` in `crawl-helpers.ts:163`. Only the DexScreener inline pool loop (line 359+) is missing the guard.

**Change:** Add after line 363 (`if (vol24h === 0 && tvl < 10_000) continue;`):
```typescript
if (tvl > 0 && vol24h / tvl > 50) continue;
```

**Test:** Add a test case for the DexScreener discovery path verifying that pools with vol/TVL > 50 are skipped.

---

### 2.7 L-1: Locked liquidity denominator

**File:** `worker/src/cron/dex-liquidity/scoring.ts:96`

**Change:** `lockedLiquidityPct > 0` -> `lockedLiquidityPct >= 0`

**Test:** Add case verifying that a pool with `lockedLiquidityPct: 0` is included in the denominator.

---

### 2.8 L-2: TrendArrow epsilon

**File:** `src/components/dex-liquidity-card.tsx` (TrendArrow function, ~line 30-40)

**Change:** Early return `null` when `Math.abs(value) < 0.05`.

**Test:** Visually verified.

---

### 2.9 L-3: TopPoolsTable truncation indicator

**File:** `src/components/dex-liquidity-card.tsx` (TopPoolsTable, ~line 149-214)

**Change:** Add a `totalPoolCount` prop to `TopPoolsTable`. The call site passes `liq.poolCount`. When `totalPoolCount > pools.length`, render subtitle: `"Showing top {pools.length} of {totalPoolCount} pools"`.

**Test:** Visually verified.

---

### 2.10 L-4: Browser cache duration for dex-liquidity

**File:** `worker/src/api/dex-liquidity.ts`

**Change:** Instead of modifying the shared `CACHE_PROFILES.standard` (which would affect 15+ other endpoints), inline a custom Cache-Control header for the dex-liquidity endpoint only: `"public, s-maxage=300, max-age=300"`. This keeps the CDN cache at 5 min and raises the browser cache from 1 min to 5 min, matching the data refresh cadence better.

**Test:** No test needed; verified via response headers.

---

### 2.11 L-5: Protocol confidence documentation

**File:** `worker/src/cron/dex-liquidity/constants.ts:98-117`

**Change:** Add a code comment block above `dexPriceConfidenceForProtocol()` documenting:
- Exact protocol strings produced by each source (e.g., `"curve"`, `"uniswap-v3"`, `"staged-cg_onchain-raydium"`, `"dexscreener-raydium"`, `"cg-ticker-kinesis"`)
- Which tier they map to (1.0, 0.85, 0.55, 0.3)
- Why `startsWith` is used for fallback sources (protocol string includes chain/dex suffixes appended by the crawl pipeline)

**Test:** No test needed; documentation only.

---

## 3. Targeted Test Coverage

Beyond tests bundled with each fix, add targeted tests for these high-risk untested paths:

### 3.1 crawl-helpers.ts
New file: `worker/src/cron/dex-liquidity/__tests__/crawl-helpers.test.ts`
- `resolveStablecoinSide()`: base side, quote side, neither side, case-insensitive matching
- Pool filtering: TVL bounds ($1K floor, $1T ceiling), vol/TVL > 50 skip
- `toMaturityDays()`: valid date, future date, invalid date string

### 3.2 staging-merge.ts
New file: `worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts`
- `mergeStagedPools()`: fresh row merged, stale row (>24h) excluded, address-dedup skips known pool, fingerprint-dedup skips known pair, freshness confidence decay applied to TVL/volume, price observation extracted when TVL >= $50K threshold

### 3.3 scoring.ts (expanded)
Add to existing `dex-liquidity-scoring.test.ts`:
- `computeSeriesStability()`: exported with `/** @internal */` for direct testing
- Coverage classification boundaries: primary-only, mixed, fallback-only, unobserved

### 3.4 price-sanity.ts (expanded)
Add to existing `dex-liquidity-price-sanity.test.ts`:
- Non-USD peg: EUR-pegged stablecoin with FX reference
- Commodity peg: gold stablecoin with commodityOunces scaling
- Missing references: graceful fallback to static bounds

---

## 4. Risk Assessment

- All changes are additive guards, UI tweaks, constant changes, or documentation
- No D1 migrations
- No API response shape changes
- No scoring weight changes
- M-1 widens depeg freshness window from 20 to 35 min — this relaxes the data quality threshold for depeg detection but eliminates a 10-min blind spot every 30-min cron cycle. If a real depeg is happening, the DEX price confirms it regardless of staleness.
- L-4 uses a per-endpoint cache override to avoid affecting the 15+ other endpoints that share `CACHE_PROFILES.standard`
- Build + type-check + test suite must pass before merge

---

## 5. Verification Criteria

1. `npm run build` succeeds
2. `cd worker && npx tsc --noEmit` succeeds
3. `npm test` passes with all new tests green
4. No lint errors (`npm run lint`)
5. Manual verification: liquidity page renders correctly
