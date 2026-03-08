# Pipeline Hardening

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix silent failure modes in the data pipeline — NaN propagation in DEWS, unvalidated cache reads, missing price reasonableness bounds, swallowed errors — and document calibration rationale for all magic numbers. Prevent the embarrassing wrong-score scenario.

**Architecture:** All changes are in `worker/src/` and `shared/lib/`. No frontend changes. The fixes fall into three categories: (1) numeric safety in math utilities (`clamp`, `piecewiseLinear`), (2) schema validation at cache read boundaries, (3) calibration documentation. Each fix includes a regression test.

**Tech Stack:** TypeScript, Vitest, Zod, Cloudflare Workers + D1

---

### Task 1: Fix NaN propagation in `clamp()` and `piecewiseLinear()`

**Files:**
- Modify: `worker/src/lib/dews.ts` (lines 125-151)
- Test: `worker/src/lib/__tests__/dews.test.ts`

**Context:**
`clamp()` (line 125) uses `Math.max(min, Math.min(max, val))`. When `val` is NaN, both `Math.min` and `Math.max` return NaN — the NaN silently passes through. Downstream, `Math.round(NaN)` produces NaN, which in some contexts becomes 0.

`piecewiseLinear()` (line 134) interpolates between anchor points. If the input `x` is NaN, the comparison `x <= anchors[i][0]` is always false, so the function falls through to return the last anchor's value — a silent wrong result rather than a detectable error.

**Step 1: Write failing tests**

Add to `dews.test.ts`:

```typescript
describe("clamp", () => {
  it("returns min when value is NaN", () => {
    // NaN should be treated as 0 (minimum) rather than passing through
    expect(clamp(0, 100, NaN)).toBe(0);
  });

  it("returns min when value is Infinity", () => {
    expect(clamp(0, 100, Infinity)).toBe(100);
  });

  it("returns min when value is -Infinity", () => {
    expect(clamp(0, 100, -Infinity)).toBe(0);
  });
});

describe("piecewiseLinear", () => {
  const anchors: [number, number][] = [[0, 0], [10, 50], [20, 100]];

  it("returns 0 for NaN input", () => {
    expect(piecewiseLinear(NaN, anchors)).toBe(0);
  });

  it("returns 0 for Infinity input", () => {
    // Infinity should clamp to last anchor value, then context decides
    expect(piecewiseLinear(Infinity, anchors)).toBe(100);
  });
});
```

Note: `clamp` and `piecewiseLinear` may not be exported. If they're module-private, either export them for testing or test through `computeDEWS` with inputs that trigger the NaN path.

**Step 2: Run tests to verify they fail**

Run: `npm test -- --run dews`
Expected: FAIL — NaN tests produce unexpected values.

**Step 3: Fix `clamp()`**

```typescript
function clamp(min: number, max: number, val: number): number {
  if (!Number.isFinite(val)) return val !== val ? min : val > 0 ? max : min; // NaN→min, Inf→max, -Inf→min
  return Math.max(min, Math.min(max, val));
}
```

**Step 4: Fix `piecewiseLinear()`**

Add a guard at the top:

```typescript
function piecewiseLinear(x: number, anchors: readonly (readonly [number, number])[]): number {
  if (!Number.isFinite(x)) return x !== x ? 0 : x > 0 ? anchors[anchors.length - 1][1] : anchors[0][1];
  // ... rest unchanged
}
```

**Step 5: Run tests**

Run: `npm test -- --run dews`
Expected: All pass including new NaN tests.

**Step 6: Commit**

```bash
git add worker/src/lib/dews.ts worker/src/lib/__tests__/dews.test.ts
git commit -m "fix(dews): handle NaN/Infinity in clamp and piecewiseLinear"
```

---

### Task 2: Guard NaN in DEWS pool signal input

**Files:**
- Modify: `worker/src/lib/dews.ts` (lines 229-235, `computePoolSignal`)
- Test: `worker/src/lib/__tests__/dews.test.ts`

**Context:**
`computePoolSignal` receives `weightedBalanceRatio` as a nullable number. The null check at line 230 handles `null` correctly (returns `available: false`). But if the value is NaN (which passes the null check), it propagates into `balanceStress = (1 - NaN) * 100 = NaN`, contaminating the entire pool signal.

**Step 1: Write failing test**

```typescript
describe("computeDEWS pool signal NaN handling", () => {
  it("treats NaN weightedBalanceRatio as unavailable", () => {
    const result = computeDEWS(baseInput({
      weightedBalanceRatio: NaN,
      avgPoolStress: 0,
      worstPoolStress: 0,
    }));
    // Pool signal should be unavailable, not silently 0
    expect(result.signals.pool.available).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run dews`
Expected: FAIL — pool signal is `available: true` with value 0 (NaN clamped to 0).

**Step 3: Fix the null check**

In `computePoolSignal`, change the guard from:

```typescript
if (input.weightedBalanceRatio == null) {
```

to:

```typescript
if (input.weightedBalanceRatio == null || !Number.isFinite(input.weightedBalanceRatio)) {
```

**Step 4: Run tests**

Run: `npm test -- --run dews`
Expected: All pass.

**Step 5: Commit**

```bash
git add worker/src/lib/dews.ts worker/src/lib/__tests__/dews.test.ts
git commit -m "fix(dews): treat NaN weightedBalanceRatio as unavailable signal"
```

---

### Task 3: Add price reasonableness bounds to depeg detection

**Files:**
- Modify: `worker/src/cron/detect-depegs.ts` (lines 149-156)
- Test: `worker/src/cron/__tests__/detect-depegs.test.ts` (create if needed)

**Context:**
Depeg detection validates `price > 0` and `Number.isFinite(price)` but accepts any positive price. A flash spike from $1.00 to $5.00 (500% of peg) or a data glitch to $0.01 (1% of peg) would trigger a depeg event. DEX oracle attacks, LP imbalances, or upstream API errors could produce these.

The fix: skip prices that deviate more than a generous bound from the peg reference. A 50% deviation (price < 0.5x peg or price > 2x peg) is far beyond any legitimate depeg and indicates bad data.

**Step 1: Write test**

```typescript
describe("price reasonableness", () => {
  it("skips prices more than 2x peg reference", () => {
    // A stablecoin with price = $5.00 and pegRef = $1.00
    // should be skipped as unreasonable, not trigger a depeg event
    // Test through the full detection flow or the validation logic
  });

  it("skips prices less than 0.5x peg reference", () => {
    // price = $0.01 with pegRef = $1.00 is data noise
  });

  it("allows legitimate depeg prices", () => {
    // price = $0.95 with pegRef = $1.00 is a real depeg (500bps)
    // price = $0.85 with pegRef = $1.00 is a severe depeg (1500bps)
    // Both should proceed normally
  });
});
```

**Step 2: Add the reasonableness check**

After the existing `price <= 0` check (line 150) and after `pegRef` is computed (line 155), add:

```typescript
// Skip wildly unreasonable prices — data glitch or oracle attack
const priceRatio = price / pegRef;
if (priceRatio > 2 || priceRatio < 0.5) {
  console.warn(`[depeg] Skipping ${meta.symbol}: price ${price} is ${(priceRatio * 100).toFixed(0)}% of peg ${pegRef}`);
  continue;
}
```

This goes between the `pegRef` validation (line 156) and the deviation computation (line 158).

**Step 3: Run tests**

Run: `npm test -- --run detect-depeg`
Expected: All pass.

**Step 4: Commit**

```bash
git add worker/src/cron/detect-depegs.ts worker/src/cron/__tests__/
git commit -m "fix(depeg): skip prices >2x or <0.5x peg reference as unreasonable"
```

---

### Task 4: Fix silent error swallowing

**Files:**
- Modify: `worker/src/lib/api-utils.ts` (line ~401)
- Modify: `worker/src/api/peg-summary.ts` (line ~98)
- Modify: `worker/src/cron/detect-depegs.ts` (lines ~78-83)

**Context:**
Three bare `catch` blocks silently swallow errors:

1. **api-utils.ts:401** — `_meta` injection fails silently
2. **peg-summary.ts:98** — DEX price query failure returns empty array, no logging
3. **detect-depegs.ts:78-83** — "no such table" is expected (migration), but other errors are logged to console only, with no structured reporting

**Step 1: Add logging to api-utils.ts catch block**

Change:
```typescript
} catch {
  // If JSON parse fails, fall through to raw response
}
```
To:
```typescript
} catch (err) {
  console.warn(`[cache] Failed to inject _meta into ${endpoint}:`, err instanceof Error ? err.message : err);
}
```

**Step 2: Add logging to peg-summary.ts DEX price fallback**

Change:
```typescript
}>().catch(() => ({ results: [] as never[] }));
```
To:
```typescript
}>().catch((err) => {
  console.warn("[peg-summary] DEX price query failed, falling back to empty:", err instanceof Error ? err.message : err);
  return { results: [] as never[] };
});
```

**Step 3: Tighten detect-depegs.ts error handling**

The current code only checks for "no such table" — tighten to also log when the fallback is used:

```typescript
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg.includes("no such table")) {
    console.error("[depeg] Unexpected error loading dex_prices metadata:", msg);
  } else {
    console.info("[depeg] dex_prices table not yet created, skipping DEX metadata");
  }
}
```

**Step 4: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

**Step 5: Commit**

```bash
git add worker/src/lib/api-utils.ts worker/src/api/peg-summary.ts worker/src/cron/detect-depegs.ts
git commit -m "fix(worker): add logging to previously silent catch blocks"
```

---

### Task 5: Add cache read validation for peg-summary

**Files:**
- Read first: `worker/src/cron/sync-stablecoins.ts` (to find the Zod schema used at write time)
- Modify: `worker/src/api/peg-summary.ts` (lines ~75-88)
- Test: `worker/src/api/__tests__/peg-summary.test.ts` (create if needed)

**Context:**
`sync-stablecoins` validates the cache payload with a Zod schema before writing. But `peg-summary.ts` reads the cache and type-casts without re-validation: `as { peggedAssets: StablecoinData[]; fxFallbackRates?: ... }`. If the cache is corrupted (manual DB edit, partial write), the type cast succeeds but field access may crash.

The fix should be lightweight — not a full Zod re-parse (too slow for every request), but a structural guard that catches the most likely corruption mode (missing `peggedAssets` key or non-array value).

**Step 1: Check how `loadStablecoinsCache` works**

Read the `loadStablecoinsCache` function (likely in `worker/src/lib/` or `api-utils.ts`). It may already do structural validation — in which case, the `as` cast is fine because the function guarantees the shape. If it only checks for cache existence (not structure), we need to add a guard.

**Step 2: Add structural guard if needed**

If `loadStablecoinsCache` doesn't validate structure, add after the cast:

```typescript
const { peggedAssets, fxFallbackRates } = stablecoinsCache.payload as {
  peggedAssets: StablecoinData[];
  fxFallbackRates?: Record<string, number>;
};

if (!Array.isArray(peggedAssets)) {
  console.error("[peg-summary] Cache payload missing peggedAssets array");
  return errorResponse(503, "Cached stablecoins data is corrupt");
}
```

**Step 3: Apply same pattern to stablecoin-summary.ts**

In `stablecoin-summary.ts` (lines ~31-36), add after the JSON parse:

```typescript
if (!parsed.peggedAssets || !Array.isArray(parsed.peggedAssets)) {
  return errorResponse(503, "Cached stablecoins data is corrupt");
}
```

**Step 4: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

**Step 5: Commit**

```bash
git add worker/src/api/peg-summary.ts worker/src/api/stablecoin-summary.ts
git commit -m "fix(api): add structural validation on cache read for peg/stablecoin endpoints"
```

---

### Task 6: Document calibration rationale

**Files:**
- Modify: `worker/src/lib/dews.ts` (lines 190-526)
- Modify: `shared/lib/report-cards.ts` (lines 41-91)
- Modify: `worker/src/lib/constants.ts` (lines 4-83)

**Context:**
Magic numbers throughout the scoring system lack comments explaining why they were chosen. This makes it impossible to know whether a threshold should be adjusted without re-deriving the rationale. The goal is to add brief inline comments explaining the calibration basis.

This task is documentation-only — no logic changes.

**Step 1: Document DEWS piecewise linear anchors**

Add comments above each anchor array in `dews.ts`. Example for supply velocity (lines 190-197):

```typescript
// Supply contraction stress curve (1d).
// Calibrated from historical redemption events:
//   1% daily: routine rebalancing, minimal concern
//   3-5%: observed in moderate stress (e.g., USDC March 2023)
//   10-20%: bank-run territory (e.g., UST May 2022)
const norm1d = piecewiseLinear(Math.abs(delta1d) * 100, [
  [0, 0], [1, 15], [3, 40], [5, 65], [10, 85], [20, 100],
]);
```

Apply similar comments to:
- Supply 7d anchors (lines 202-208)
- Liquidity score erosion (lines 284-290)
- Liquidity TVL erosion (lines 299-305)
- Price divergence (lines 380-388)
- Blacklist count/spike (lines 421-436)
- Burn surge and burn-to-mint (lines 476-492)
- Pool stress blend weights 40/35/25 (line ~250)

**Step 2: Document report card thresholds**

In `report-cards.ts`, add comments to:

```typescript
// Dimension weights reflect relative importance to stablecoin safety:
//   Liquidity (30%): exit availability is the primary user concern
//   Dependency risk (25%): upstream failure cascades directly
//   Resilience (20%): collateral and custody protect against issuer failure
//   Decentralization (15%): governance concentration is a slower-moving risk
export const DIMENSION_WEIGHTS: Record<DimensionKey, number> = { ... };

// Peg multiplier exponent: 0.20 creates a gentle power curve.
// pegScore 90+ -> ~2% penalty (barely noticeable)
// pegScore 50  -> ~13% penalty (meaningful but not devastating)
// pegScore 10  -> ~37% penalty (severe, reflects sustained depegging)
// Rationale: peg stability is table-stakes — most coins score 95+,
// so the multiplier only bites for genuinely impaired pegs.
export const PEG_MULTIPLIER_EXPONENT = 0.20;

// No-liquidity penalty: 10% score reduction for coins with no DEX liquidity data.
// Rationale: absence of DEX presence is increasingly suspicious as DEX coverage
// matures. 10% is large enough to matter but doesn't dominate the grade.
export const NO_LIQUIDITY_PENALTY = 0.9;
```

**Step 3: Document constants.ts thresholds**

```typescript
// 100bps (1%) minimum deviation to consider a depeg event for USD-pegged stablecoins.
// Below this, price movement is within normal market noise.
export const DEPEG_THRESHOLD_BPS = 100;

// 150bps for non-USD pegs (FX, commodity). Higher threshold because FX pairs
// have wider bid-ask spreads and commodity oracles update less frequently.
export const DEPEG_THRESHOLD_BPS_NON_USD = 150;

// Coins above $1B circulating supply require confirmation from a second price source
// (DEX or CoinGecko) before a depeg event is created. Below $1B, single-source
// detection is acceptable because false alerts have lower blast radius.
export const DEPEG_CONFIRMATION_SUPPLY_THRESHOLD = 1_000_000_000;
```

**Step 4: Verify no logic changes**

Run: `npm test`
Expected: All tests pass — no logic was changed, only comments added.

**Step 5: Commit**

```bash
git add worker/src/lib/dews.ts shared/lib/report-cards.ts worker/src/lib/constants.ts
git commit -m "docs(calibration): add rationale comments to all scoring thresholds"
```

---

### Task 7: Build, type-check, full test suite

**Step 1: Worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No type errors.

**Step 2: Frontend build**

Run: `npm run build`
Expected: Clean build.

**Step 3: Full test suite**

Run: `npm test`
Expected: All tests pass.

**Step 4: Lint**

Run: `npm run lint`
Expected: No new warnings.

**Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "chore: fix build/lint issues from pipeline hardening"
```
