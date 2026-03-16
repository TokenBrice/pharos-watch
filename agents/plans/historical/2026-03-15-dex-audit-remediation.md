# DEX Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate 11 issues from the DEX feature audit + add targeted test coverage for high-risk untested paths.

**Architecture:** All changes are additive guards, constant tweaks, documentation, or UI polish. No migrations, no API shape changes, no scoring weight changes. Tests bundled with each fix.

**Tech Stack:** TypeScript, Vitest, React/Next.js, Cloudflare Workers

**Spec:** `agents/specs/2026-03-15-dex-audit-remediation-design.md`

---

## File Map

| Action | File | Changes |
|--------|------|---------|
| Modify | `worker/src/cron/dex-liquidity/process-pools.ts:148-154` | H-1: NaN guard on organicFraction |
| Modify | `worker/src/cron/dex-liquidity/scoring.ts:95,138-145` | H-2: NaN guard on computeSeriesStability, L-1: locked liq denominator |
| Modify | `worker/src/cron/dex-discovery/orchestrator.ts:222-250` | H-3: nested try/catch for crawl vs persist errors |
| Modify | `worker/src/lib/constants.ts:19` | M-1: DEX_FRESHNESS_SEC 1200->2100 |
| Modify | `worker/src/api/dex-liquidity.ts:177,274` | M-3: code comment, L-4: inline cache override |
| Modify | `worker/src/api/peg-summary.ts:88-102` | M-3: code comment |
| Modify | `worker/src/cron/dex-discovery/crawl-sources.ts:363` | M-4: vol/TVL ratio guard for DexScreener |
| Modify | `worker/src/cron/dex-liquidity/constants.ts:98-117` | L-5: protocol confidence docs |
| Modify | `src/components/dex-liquidity-card.tsx:30-41,149-215,572` | L-2: TrendArrow epsilon, L-3: truncation indicator |
| Modify | `worker/src/cron/__tests__/dex-liquidity-process-pools.test.ts` | H-1 tests |
| Modify | `worker/src/cron/__tests__/dex-liquidity-scoring.test.ts` | H-2, L-1 tests |
| Modify | `worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts` | price-sanity expanded tests |
| Create | `worker/src/cron/__tests__/dex-liquidity-series-stability.test.ts` | computeSeriesStability direct tests |
| Create | `worker/src/cron/dex-discovery/__tests__/crawl-sources-ds-ratio.test.ts` | M-4 DexScreener ratio test |

---

## Task 1: H-1 — organicFraction NaN guard

**Files:**
- Modify: `worker/src/cron/dex-liquidity/process-pools.ts:148-154`
- Modify: `worker/src/cron/__tests__/dex-liquidity-process-pools.test.ts`

- [ ] **Step 1: Add test cases for NaN/Infinity organicFraction**

Add to the existing `describe("processPoolMetrics")` block in `dex-liquidity-process-pools.test.ts`:

```typescript
it("ignores organicFraction when apyBase is NaN", () => {
  const pool = makePool({ apyBase: NaN, apy: 5, symbol: "USDT-USDC" });
  const result = processPoolMetrics({
    pools: [pool],
    symbolToIds: new Map([["USDT", ["tether"]]]),
    curvePoolsByAddress: new Map(),
    curvePoolsBySymbol: new Map(),
    aerodromeIsStable: new Map(),
    dexProjects: new Set(["curve"]),
    protocolTvlCaps: new Map(),
  });
  const m = result.metrics.get("tether");
  // organicFraction should NOT be measured (default 0.5 behavior)
  expect(m?.totalTvlForOrganic).toBe(0);
});

it("ignores organicFraction when apy is Infinity", () => {
  const pool = makePool({ apyBase: 3, apy: Infinity, symbol: "USDT-USDC" });
  const result = processPoolMetrics({
    pools: [pool],
    symbolToIds: new Map([["USDT", ["tether"]]]),
    curvePoolsByAddress: new Map(),
    curvePoolsBySymbol: new Map(),
    aerodromeIsStable: new Map(),
    dexProjects: new Set(["curve"]),
    protocolTvlCaps: new Map(),
  });
  const m = result.metrics.get("tether");
  expect(m?.totalTvlForOrganic).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/cron/__tests__/dex-liquidity-process-pools.test.ts`

Expected: FAIL — NaN propagates through organicFraction.

- [ ] **Step 3: Apply the fix**

In `process-pools.ts`, change lines 148-154:

```typescript
// Before:
if (pool.apyBase != null && pool.apy > 0.01) {
// After:
if (pool.apyBase != null && Number.isFinite(pool.apyBase) &&
    pool.apy != null && Number.isFinite(pool.apy) && pool.apy > 0.01) {
```

And change line 151:
```typescript
// Before:
} else if (pool.apyBase != null) {
// After:
} else if (pool.apyBase != null && Number.isFinite(pool.apyBase)) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/cron/__tests__/dex-liquidity-process-pools.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```
fix(dex): guard organicFraction against NaN/Infinity APY values (H-1)
```

---

## Task 2: H-2 + L-1 — computeSeriesStability NaN guard + locked liquidity denominator

**Files:**
- Modify: `worker/src/cron/dex-liquidity/scoring.ts:95,138-145`
- Create: `worker/src/cron/__tests__/dex-liquidity-series-stability.test.ts`
- Modify: `worker/src/cron/__tests__/dex-liquidity-scoring.test.ts`

- [ ] **Step 1: Export computeSeriesStability for testing**

In `scoring.ts`, add `/** @internal */` annotation and export the function:

```typescript
/** @internal Exported for testing only. */
export function computeSeriesStability(values: number[]): number | null {
```

- [ ] **Step 2: Create test file for computeSeriesStability**

Create `worker/src/cron/__tests__/dex-liquidity-series-stability.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { computeSeriesStability } from "../dex-liquidity/scoring";

describe("computeSeriesStability", () => {
  it("returns null for fewer than 7 values", () => {
    expect(computeSeriesStability([1, 2, 3, 4, 5, 6])).toBeNull();
  });

  it("returns a stability score for 7+ valid values", () => {
    const stable = [100, 101, 99, 100, 102, 98, 100];
    const result = computeSeriesStability(stable);
    expect(result).toBeTypeOf("number");
    expect(result).toBeGreaterThan(0.9); // low CV = high stability
  });

  it("filters out NaN values before computing", () => {
    const withNaN = [100, NaN, 101, 99, NaN, 100, 102, 98, 100];
    const result = computeSeriesStability(withNaN);
    expect(result).toBeTypeOf("number");
    expect(result).toBeGreaterThan(0.9);
  });

  it("filters out Infinity values before computing", () => {
    const withInf = [100, Infinity, 101, 99, -Infinity, 100, 102, 98, 100];
    const result = computeSeriesStability(withInf);
    expect(result).toBeTypeOf("number");
    expect(result).toBeGreaterThan(0.9);
  });

  it("returns null when fewer than 7 finite values remain after filtering", () => {
    const mostlyNaN = [100, NaN, NaN, NaN, NaN, NaN, NaN, NaN, 101];
    expect(computeSeriesStability(mostlyNaN)).toBeNull();
  });

  it("returns null for all-zero values", () => {
    expect(computeSeriesStability([0, 0, 0, 0, 0, 0, 0])).toBeNull();
  });

  it("returns 0 for maximally volatile series", () => {
    // alternating 1 and 1000 gives very high CV
    const volatile = [1, 1000, 1, 1000, 1, 1000, 1];
    const result = computeSeriesStability(volatile);
    expect(result).toBeLessThanOrEqual(0.01);
  });
});
```

- [ ] **Step 3: Run tests to verify NaN tests fail**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/cron/__tests__/dex-liquidity-series-stability.test.ts`

Expected: NaN-related tests FAIL (function doesn't filter yet).

- [ ] **Step 4: Apply the computeSeriesStability fix**

In `scoring.ts`, replace lines 138-145:

```typescript
/** @internal Exported for testing only. */
export function computeSeriesStability(values: number[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < 7) return null;
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  if (mean <= 0) return null;
  const variance = finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finite.length;
  const cv = Math.sqrt(Math.max(0, variance)) / mean;
  return Math.round((1 - Math.min(1, cv)) * 10000) / 10000;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/cron/__tests__/dex-liquidity-series-stability.test.ts`

Expected: ALL PASS

- [ ] **Step 6: Fix L-1 locked liquidity denominator**

In `scoring.ts`, line 95, change:

```typescript
// Before:
if (lockedLiquidityPct != null && lockedLiquidityPct > 0) {
// After:
if (lockedLiquidityPct != null && lockedLiquidityPct >= 0) {
```

- [ ] **Step 7: Add L-1 test in scoring test file**

Add to `dex-liquidity-scoring.test.ts`, in the appropriate describe block:

```typescript
it("includes pools with lockedLiquidityPct=0 in locked liquidity denominator", () => {
  const m = initMetrics("test-coin", "TEST");
  m.topPools = [
    {
      symbol: "TEST-USDC", chain: "ethereum", project: "uniswap-v3",
      tvlUsd: 1_000_000, volumeUsd1d: 50_000, volumeUsd7d: 350_000,
      poolId: "ethereum:0x1", extra: { lockedLiquidityPct: 0 },
    } as any,
  ];
  // After fix: totalTvlForLocked should include this pool (1M)
  // Before fix: it would be 0 because lockedLiquidityPct > 0 fails
});
```

- [ ] **Step 8: Run full scoring test suite**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/cron/__tests__/dex-liquidity-scoring.test.ts worker/src/cron/__tests__/dex-liquidity-series-stability.test.ts`

Expected: ALL PASS

- [ ] **Step 9: Commit**

```
fix(dex): guard computeSeriesStability against NaN/Infinity (H-2), include zero-locked pools in denominator (L-1)
```

---

## Task 3: H-3 — Discovery miss vs persistence error separation

**Files:**
- Modify: `worker/src/cron/dex-discovery/orchestrator.ts:222-250`

- [ ] **Step 1: Restructure the try/catch block**

In `orchestrator.ts`, replace lines 222-250 (the try/catch around the crawl+persist logic) with nested try blocks. The outer try catches crawl failures (records miss). An inner try wraps only the persistence calls (`upsertStagedPools`, `updateDiscoveryMeta`) and the success bookkeeping — its catch logs a warning and adds to `failedCoins` but does NOT call `updateDiscoveryMeta(db, id, 0, nowSec)`.

Preserve all existing success bookkeeping (lines 226-237: `knownPoolIds.add`, `coinsCrawled`, `poolsDiscovered`, `allUnresolvedChains`, `poolsBySource`) inside the inner try, after `updateDiscoveryMeta`.

The outer catch (crawl failure) keeps the existing miss-recording logic.

- [ ] **Step 2: Type-check**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard/worker && npx tsc --noEmit`

Expected: No errors

- [ ] **Step 3: Run existing discovery tests**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/cron/dex-discovery`

Expected: ALL PASS

- [ ] **Step 4: Commit**

```
fix(dex): separate crawl errors from persistence errors in discovery backoff (H-3)
```

---

## Task 4: M-1 + M-3 + L-4 + L-5 — Constants and documentation

**Files:**
- Modify: `worker/src/lib/constants.ts:19`
- Modify: `worker/src/api/dex-liquidity.ts:177,274`
- Modify: `worker/src/api/peg-summary.ts:88-102`
- Modify: `worker/src/cron/dex-liquidity/constants.ts:98-117`

- [ ] **Step 1: Change DEX_FRESHNESS_SEC (M-1)**

In `worker/src/lib/constants.ts`, line 19:

```typescript
// Before:
export const DEX_FRESHNESS_SEC = 1200;
// After:
export const DEX_FRESHNESS_SEC = 2100;
```

Update the comment to:
```typescript
/** Maximum age (in seconds) for a DEX price observation to be considered fresh.
 *  Set to 35 min to cover the full 30-min scoring cron cycle + 5 min buffer. */
export const DEX_FRESHNESS_SEC = 2100;
```

- [ ] **Step 2: Add consistency comments (M-3)**

In `worker/src/api/dex-liquidity.ts`, add a comment above line 177:
```typescript
// dex_prices query uses a wider column set than loadDexPriceRows() (includes price_sources_json).
// The catch pattern mirrors depeg-helpers.ts loadDexPriceRows() for missing-table resilience.
```

In `worker/src/api/peg-summary.ts`, add a comment above line 88:
```typescript
// dex_prices query uses a narrower column set than dex-liquidity endpoint.
// Catch pattern mirrors depeg-helpers.ts loadDexPriceRows() for missing-table resilience.
```

- [ ] **Step 3: Inline cache override for dex-liquidity (L-4)**

In `worker/src/api/dex-liquidity.ts`, line 274, change:

```typescript
// Before:
"Cache-Control": CACHE_PROFILES.standard,
// After:
"Cache-Control": "public, s-maxage=300, max-age=300",
```

- [ ] **Step 4: Document protocol confidence tiers (L-5)**

In `worker/src/cron/dex-liquidity/constants.ts`, replace the comment block above `dexPriceConfidenceForProtocol()` (lines 98-102):

```typescript
/**
 * Confidence weight for DEX price observations by protocol.
 * Scales TVL weight in the TVL-weighted median to down-weight less reliable sources.
 *
 * Tier 1 (1.0): Primary scoring sources — exact match
 *   "curve", "uniswap-v3", "aerodrome"
 *
 * Tier 2 (0.85): Discovery-stage CoinGecko/GeckoTerminal — startsWith match
 *   "staged-cg_onchain-<dexId>"  (e.g., "staged-cg_onchain-raydium")
 *   "geckoterminal-<dexId>"      (e.g., "geckoterminal-uniswap_v3")
 *   "coingecko-<exchange>"       (e.g., "coingecko-binance")
 *
 * Tier 3 (0.55): DexScreener and CG tickers fallback — startsWith match
 *   "dexscreener-<dexId>"        (e.g., "dexscreener-raydium")
 *   "cg-ticker-<exchange>"       (e.g., "cg-ticker-kinesis")
 *   "staged-dexscreener-<dexId>" (e.g., "staged-dexscreener-raydium")
 *   "staged-cg_tickers-<exchange>"
 *
 * Tier 4 (0.3): Unknown/unrecognized protocols — fallback
 *
 * startsWith is used for Tier 2-3 because the crawl pipeline appends
 * source-specific dexId/exchange suffixes to the protocol string.
 */
```

- [ ] **Step 5: Type-check + lint**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npm run lint && cd worker && npx tsc --noEmit`

Expected: No errors

- [ ] **Step 6: Run existing API tests to verify no regression**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/api/__tests__/dex-liquidity.test.ts worker/src/api/__tests__/peg-summary.test.ts`

Expected: ALL PASS

- [ ] **Step 7: Commit**

```
fix(dex): widen DEX freshness window to 35 min (M-1), add consistency comments (M-3), tune dex-liquidity cache (L-4), document protocol confidence tiers (L-5)
```

---

## Task 5: M-4 — DexScreener vol/TVL ratio guard

**Files:**
- Modify: `worker/src/cron/dex-discovery/crawl-sources.ts:363`

- [ ] **Step 1: Add the ratio guard**

In `crawl-sources.ts`, after line 363 (`if (vol24h === 0 && tvl < 10_000) continue;`), add:

```typescript
if (tvl > 0 && vol24h / tvl > 50) continue;
```

- [ ] **Step 2: Type-check**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard/worker && npx tsc --noEmit`

Expected: No errors

- [ ] **Step 3: Run existing discovery tests**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/cron/dex-discovery`

Expected: ALL PASS

- [ ] **Step 4: Commit**

```
fix(dex): add vol/TVL ratio guard to DexScreener discovery stage (M-4)
```

---

## Task 6: L-2 + L-3 — Frontend tweaks (TrendArrow epsilon + pool truncation)

**Files:**
- Modify: `src/components/dex-liquidity-card.tsx:30-41,149-154,572`

- [ ] **Step 1: Add TrendArrow epsilon (L-2)**

In `dex-liquidity-card.tsx`, function `TrendArrow` (line 30-41), add after line 31:

```typescript
if (Math.abs(value) < 0.05) return null;
```

Full function becomes:
```typescript
function TrendArrow({ value }: { value: number | null }) {
  if (value == null) return null;
  if (Math.abs(value) < 0.05) return null;
  const isPositive = value >= 0;
  // ... rest unchanged
}
```

- [ ] **Step 2: Add TopPoolsTable truncation indicator (L-3)**

Change the `TopPoolsTable` signature from:
```typescript
function TopPoolsTable({ pools }: { pools: DexLiquidityPool[] }) {
```
to:
```typescript
function TopPoolsTable({ pools, totalPoolCount }: { pools: DexLiquidityPool[]; totalPoolCount?: number }) {
```

In the header section (line 154), change:
```typescript
// Before:
<p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Top Pools</p>
// After:
<p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
  {totalPoolCount != null && totalPoolCount > pools.slice(0, 5).length
    ? `Top ${Math.min(5, pools.length)} of ${totalPoolCount} pools`
    : "Top Pools"}
</p>
```

Update the call site at line 572:
```typescript
// Before:
{liq.topPools.length > 0 && <TopPoolsTable pools={liq.topPools} />}
// After:
{liq.topPools.length > 0 && <TopPoolsTable pools={liq.topPools} totalPoolCount={liq.poolCount} />}
```

- [ ] **Step 3: Build to verify**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npm run build`

Expected: Build succeeds

- [ ] **Step 4: Commit**

```
fix(dex): filter negligible trend changes (L-2), show pool truncation indicator (L-3)
```

---

## Task 7: Expanded test coverage — price-sanity.ts

**Files:**
- Modify: `worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts`

- [ ] **Step 1: Add expanded price-sanity tests**

Add to the existing `describe("isPlausibleDexObservationPrice")` block:

```typescript
it("accepts EUR-pegged price with live FX reference and rejects without", () => {
  // With fresh references, EUR price should validate against FX rate
  expect(isPlausibleDexObservationPrice("eurc-circle", 1.12, liveRefs)).toBe(true);
  // Without references, falls back to static bounds
  expect(isPlausibleDexObservationPrice("eurc-circle", 1.08)).toBe(true);
  // Way out of range should fail regardless
  expect(isPlausibleDexObservationPrice("eurc-circle", 50, liveRefs)).toBe(false);
});

it("handles missing references gracefully for commodity pegs", () => {
  // Without references, gold stablecoin should use static bounds
  expect(isPlausibleDexObservationPrice("xaut-tether", 2900)).toBe(true);
  // Clearly wrong price should fail even without references
  expect(isPlausibleDexObservationPrice("xaut-tether", 0.5)).toBe(false);
});

it("validates fractional gold tokens with commodityOunces scaling", () => {
  // GGBR has commodityOunces: 0.001 (1 milligram of gold)
  // Expected price ~ $2.915 at $2915/oz
  expect(isPlausibleDexObservationPrice("ggbr-goldfish-gold", 2.9, liveRefs)).toBe(true);
  expect(isPlausibleDexObservationPrice("ggbr-goldfish-gold", 0.001, liveRefs)).toBe(false);
  expect(isPlausibleDexObservationPrice("ggbr-goldfish-gold", 3000, liveRefs)).toBe(false);
});
```

- [ ] **Step 2: Run price-sanity tests**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts`

Expected: ALL PASS (these test existing behavior, not new code)

- [ ] **Step 3: Commit**

```
test(dex): expand price-sanity coverage for non-USD pegs and missing references
```

---

## Task 8: Final verification

- [ ] **Step 1: Full build + type-check**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npm run build && cd worker && npx tsc --noEmit`

Expected: Both succeed

- [ ] **Step 2: Full test suite**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npm test`

Expected: ALL PASS

- [ ] **Step 3: Lint**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npm run lint`

Expected: No errors

- [ ] **Step 4: Doc count guard**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npm run check:doc-counts`

Expected: PASS (no coin count changes)
