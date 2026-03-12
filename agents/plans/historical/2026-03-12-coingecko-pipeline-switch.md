# CoinGecko Pipeline Switch (Phase C) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CoinGecko the primary price source, with DefiLlama as cross-validation, and collapse redundant enrichment passes.

**Architecture:** `fetchDualPrimaryPrices` becomes `fetchPrimaryPrices` -- CG is authoritative, DL cross-validates. When both agree within 50 bps, confidence is "high". When they diverge, CG wins (unless DL is provably closer to the canonical peg reference). Enrichment passes 2+3 (DL proxy for geckoId and CG direct) are removed since the primary fetch now covers those geckoId-based lookups. The legacy price-validation shadow tracking is removed since the new `validatePriceCandidate()` system has proven equivalent (1.5% mismatch rate, all acceptable).

**Tech Stack:** TypeScript strict, Cloudflare Workers, D1, Vitest

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `worker/src/cron/enrich-prices.ts` | Modify | Rename `fetchDualPrimaryPrices` -> `fetchPrimaryPrices`, flip CG/DL authority, remove passes 2+3, update `EnrichmentStats` |
| `worker/src/cron/sync-stablecoins.ts` | Modify | Update call sites + variable names, update `PriceSourceHealth`, remove legacy shadow tracking |
| `worker/src/cron/__tests__/enrich-prices.test.ts` | Modify | Update for renamed functions/types, update authority-flip assertions, remove pass 2+3 tests |
| `worker/src/cron/__tests__/sync-stablecoins.test.ts` | Modify | Update mocked `fetchDualPrimaryPrices` -> `fetchPrimaryPrices`, remove `pass2`/`pass3` from mock `EnrichmentStats`, remove `priceValidationShadow` assertions |
| `worker/src/api/__tests__/stablecoin-summary.test.ts` | Modify | Update `"defillama+coingecko"` fixture string to `"coingecko+defillama"` |
| `shared/types/index.ts` | Modify | Update `PriceSourceHealth.sourceDistribution` key: `"defillama+coingecko"` -> `"coingecko+defillama"` |
| `src/components/status/price-source-health.tsx` | Modify | Update rendered `sourceDistribution` key |
| `docs/data-pipeline.md` | Modify | Rewrite price enrichment section, update `dualPriceResults` reference at line 91 |
| `docs/api-reference.md` | Modify | Update `priceSource` examples (lines 132, 213) and `PriceSourceHealth` descriptions |
| `docs/dex-liquidity.md` | **No change** | Line 236 references the DEX-specific `priceValidationShadow` (in `dex-liquidity/price-sanity.ts`), NOT the sync-stablecoins shadow being removed. Leave as-is. |

**Files explicitly NOT modified:**
- `worker/src/cron/sync-stablecoins/supplemental-assets.ts` -- Supplemental assets (gold/silver/fiat) already go through `fetchPrimaryPrices` since they're merged into `llamaData.peggedAssets` at line 601 before the primary fetch at line 629. No override needed.
- `worker/src/lib/price-validation.ts` -- Untouched; `validatePriceCandidate()` is the sole price validation authority after this change.

---

## Chunk 1: Core Pipeline Switch

### Task 1: Rename and flip authority in `fetchPrimaryPrices`

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts:199-377`
- Test: `worker/src/cron/__tests__/enrich-prices.test.ts:2, 521-717`

**Context:** Currently `fetchDualPrimaryPrices` treats both DL and CG equally -- when both agree it picks DL (line 339: `price: dl, source: "defillama+coingecko"`). Phase C flips this: CG becomes authoritative, DL becomes the cross-validator.

**Key behavioral changes in cross-validation (lines 327-363):**
- When both agree (<=50 bps): use **CG price** (was DL), source = `"coingecko+defillama"` (was `"defillama+coingecko"`)
- When they diverge (>50 bps) AND a peg reference exists: use the candidate closer to reference (unchanged)
- When they diverge (>50 bps) AND no peg reference (including NAV tokens): default to **CG** (was DL)
- When only CG available: `"coingecko"`, confidence `"single-source"` (unchanged)
- When only DL available: `"defillama"`, confidence `"single-source"` (unchanged)

- [ ] **Step 1: Update all `fetchDualPrimaryPrices` tests for the authority flip**

In `enrich-prices.test.ts`:

**1a. Update import (line 2):** Change `fetchDualPrimaryPrices` to `fetchPrimaryPrices`.

**1b. Rename describe block (line 521-523):** `"fetchDualPrimaryPrices"` -> `"fetchPrimaryPrices"`.

**1c. Update "returns high confidence" test (line 534-562):**
- Line 554: `await fetchPrimaryPrices(assets, db)` (was `fetchDualPrimaryPrices`)
- Add `cgPrices` to destructure: `const { results, stats, cgPrices } = await fetchPrimaryPrices(assets, db);`
- Line 558: keep `expect(result.confidence).toBe("high")`
- Line 559: change `expect(result.source).toBe("defillama+coingecko")` to `expect(result.source).toBe("coingecko+defillama")`
- Add: `expect(result.price).toBe(1.0001)` (CG price, not DL's 1.0002)
- Add: `expect(cgPrices.get("tether")).toBe(1.0001)` (verify cgPrices map is returned)

**1d. Update "returns low confidence" test (line 564-591):**
- Line 584: `await fetchPrimaryPrices(assets, db)` (was `fetchDualPrimaryPrices`)

**1e. Update "chooses peg-closer candidate" test (line 593-627):**
- Line 613: `await fetchPrimaryPrices(` (was `fetchDualPrimaryPrices`)
- Assertions at lines 622-626 stay the same (CG=1.08 is already closer to peg ref=1.08)

**1f. Update NAV token test (line 629-657):** This is the critical change. Currently expects `source: "defillama"` and `price: 110` (DL) because NAV tokens have no peg reference and the old code defaulted to DL. After the flip, NAV tokens (pegRef=null) default to CG:
- Line 649: `await fetchPrimaryPrices(assets, db)` (was `fetchDualPrimaryPrices`)
- Line 654: change `expect(result.source).toBe("defillama")` to `expect(result.source).toBe("coingecko")`
- Line 655: change `expect(result.price).toBe(110)` to `expect(result.price).toBe(1.01)` (CG price)

**1g. Update "returns single-source" test (line 659-685):**
- Line 678: `await fetchPrimaryPrices(assets, db)` (was `fetchDualPrimaryPrices`)

**1h. Update "skips assets without geckoId" test (line 687-701):**
- Line 697: `await fetchPrimaryPrices(assets, db)` (was `fetchDualPrimaryPrices`)

**1i. Update "filters out wrong geckoId" test (line 703-717):**
- Line 713: `await fetchPrimaryPrices(assets, db)` (was `fetchDualPrimaryPrices`)

**1j. Add new test for cgOnly/dlOnly sub-counters:**
```typescript
it("tracks cgOnly and dlOnly in stats", async () => {
  const assets: PeggedAsset[] = [
    { id: "a", name: "A", symbol: "A", geckoId: "a-id", pegType: "peggedUSD", circulating: {} },
    { id: "b", name: "B", symbol: "B", geckoId: "b-id", pegType: "peggedUSD", circulating: {} },
  ];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (typeof url === "string" && url.includes("coins.llama.fi")) {
      return new Response(JSON.stringify({
        coins: { "coingecko:a-id": { price: 1.0 } }, // only A in DL
      }), { status: 200 });
    }
    if (typeof url === "string" && url.includes("coingecko.com")) {
      return new Response(JSON.stringify({
        "b-id": { usd: 1.0 }, // only B in CG
      }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  }));
  const db = makeTestDb();
  const { stats } = await fetchPrimaryPrices(assets, db);
  expect(stats.dlOnly).toBe(1);
  expect(stats.cgOnly).toBe(1);
  expect(stats.singleSource).toBe(2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run worker/src/cron/__tests__/enrich-prices.test.ts`
Expected: FAIL -- tests reference `fetchPrimaryPrices` which doesn't exist yet, and expect new source string/price values.

- [ ] **Step 3: Rename types, flip authority, add sub-counters**

In `worker/src/cron/enrich-prices.ts`:

1. Rename interface `DualPriceResult` (line 199) -> `PrimaryPriceResult`. Keep same fields.

2. Rename interface `DualPriceStats` (line 207) -> `PriceValidationStats`. Add `cgOnly` and `dlOnly`:
```typescript
export interface PriceValidationStats {
  attempted: number;
  high: number;
  singleSource: number;
  cgOnly: number;
  dlOnly: number;
  low: number;
  divergences: { id: string; symbol: string; dlPrice: number; cgPrice: number; bps: number }[];
}
```

3. Rename function `fetchDualPrimaryPrices` (line 219) -> `fetchPrimaryPrices`. Update return type:
```typescript
): Promise<{ results: Map<string, PrimaryPriceResult>; stats: PriceValidationStats; cgPrices: Map<string, number> }>
```

4. Initialize stats with `cgOnly: 0, dlOnly: 0` at line 227.

5. Flip cross-validation (lines 333-363):
```typescript
if (divergenceBps <= DIVERGENCE_THRESHOLD_BPS) {
  // Both agree -- high confidence, prefer CG (primary)
  results.set(asset.id, { price: cg, source: "coingecko+defillama", confidence: "high", dlPrice: dl, cgPrice: cg });
  stats.high++;
} else {
  const context = buildPriceValidationContext({
    stablecoinId: String(asset.id),
    pegType: asset.pegType,
    navToken: asset.navToken,
    commodityOunces: asset.commodityOunces,
  });
  const pegRef = context.navToken ? null : getReferencePriceForContext(context, references);
  // When diverging: use closer-to-reference, default to CG (primary)
  const chosen = pegRef != null ? (Math.abs(dl - pegRef) <= Math.abs(cg - pegRef) ? dl : cg) : cg;
  const chosenSource = chosen === dl ? "defillama" : "coingecko";
  results.set(asset.id, { price: chosen, source: chosenSource, confidence: "low", dlPrice: dl, cgPrice: cg });
  stats.low++;
  stats.divergences.push({ id: asset.id, symbol: asset.symbol, dlPrice: dl, cgPrice: cg, bps: Math.round(divergenceBps) });
}
```

6. Update single-source branches (lines 355-361):
```typescript
} else if (dl != null) {
  results.set(asset.id, { price: dl, source: "defillama", confidence: "single-source", dlPrice: dl, cgPrice: null });
  stats.singleSource++;
  stats.dlOnly++;
} else if (cg != null) {
  results.set(asset.id, { price: cg, source: "coingecko", confidence: "single-source", dlPrice: null, cgPrice: cg });
  stats.singleSource++;
  stats.cgOnly++;
}
```

7. Update return: `return { results, stats, cgPrices };`

8. Update all log prefixes from `[dual-primary]` to `[primary-prices]`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run worker/src/cron/__tests__/enrich-prices.test.ts`
Expected: PASS

- [ ] **Step 5: Type-check the worker**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard/worker && npx tsc --noEmit`
Expected: FAIL -- call sites in `sync-stablecoins.ts` and its test still reference old names. Fixed in Task 2.

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/enrich-prices.ts worker/src/cron/__tests__/enrich-prices.test.ts
git commit -m "feat(prices): rename fetchDualPrimaryPrices -> fetchPrimaryPrices, flip CG authority"
```

---

### Task 2: Update `sync-stablecoins.ts` and all consumers

**Files:**
- Modify: `worker/src/cron/sync-stablecoins.ts`
- Modify: `worker/src/cron/__tests__/sync-stablecoins.test.ts`
- Modify: `worker/src/api/__tests__/stablecoin-summary.test.ts`
- Modify: `shared/types/index.ts`
- Modify: `src/components/status/price-source-health.tsx`

**Context:** `sync-stablecoins.ts` imports `fetchDualPrimaryPrices` as a value import (line ~5-13). The types `DualPriceResult` / `DualPriceStats` are NOT explicitly imported -- they're inferred from the function return type. The test file (`sync-stablecoins.test.ts`) mocks the function by name at lines 98, 150, 222, 267, 271.

- [ ] **Step 1: Update imports in sync-stablecoins.ts**

Find the import from `"./enrich-prices"` and rename `fetchDualPrimaryPrices` -> `fetchPrimaryPrices`. No type imports to change.

- [ ] **Step 2: Update the call site (line 629)**

```typescript
const { results: primaryPriceResults, stats: priceValidationStats, cgPrices: primaryCgPrices } = await fetchPrimaryPrices(
  llamaData.peggedAssets, db, signal, validationReferences,
);
```

Rename all downstream references throughout the file:
- `dualPriceResults` -> `primaryPriceResults` (lines ~641, 668)
- `dualPriceStats` -> `priceValidationStats` (lines ~935, 945-946, 949, 969)

- [ ] **Step 3: Update shadow comparison comments (lines 633-664)**

```typescript
// Regression monitor: compare CG primary prices against DL list endpoint prices.
// This tracks divergence between our primary source and the DL ecosystem baseline.
```

No functional change needed.

- [ ] **Step 4: Update primary price application block (lines 666-688)**

Rename `dual` -> `primary` in the for-loop variable:
```typescript
const primary = primaryPriceResults.get(asset.id);
if (primary) { ... }
```

- [ ] **Step 5: Update `PriceSourceHealth` construction (lines 932-958)**

Keep distribution logic using current `EnrichmentStats` fields (pass2/pass3 still exist until Task 3). Only rename variable references and the high-confidence key:

```typescript
sourceDistribution: {
  coingecko: enrichStats.pass3,
  "coingecko+defillama": priceValidationStats.high,
  defillama: priceValidationStats.singleSource,
  "defillama-contract": enrichStats.pass1 + enrichStats.pass1b,
  coinmarketcap: enrichStats.passCmc,
  dexscreener: enrichStats.pass4,
  cached: enrichStats.pass2,
  missing: enrichStats.finalMissing,
},
confidenceDistribution: {
  high: priceValidationStats.high,
  "single-source": priceValidationStats.singleSource,
  low: priceValidationStats.low,
  fallback: enrichStats.passCmc + enrichStats.pass4,
},
```

- [ ] **Step 6: Update metadata block (line 969)**

```typescript
priceValidation: priceValidationStats, // was dualPrimary: dualPriceStats
```

- [ ] **Step 7: Update comments and log/abort labels**

Replace `"dual-primary-prices"` abort label with `"primary-prices"` (line ~627). Update any `[dual-primary]` log strings.

- [ ] **Step 8: Update sync-stablecoins.test.ts**

1. Line 98: rename mock from `fetchDualPrimaryPrices` to `fetchPrimaryPrices`, add `cgPrices: new Map()` to mock return
2. Line 150: update import from `fetchDualPrimaryPrices` to `fetchPrimaryPrices`
3. Lines 222, 267, 271: update all `vi.mocked(fetchDualPrimaryPrices)` to `vi.mocked(fetchPrimaryPrices)`
4. Line 222 mock return: add `cgPrices: new Map()` to the resolved value
5. Line 272: rename `dualPrimaryAssets` variable to `primaryPriceAssets` (cosmetic, not strictly required)

- [ ] **Step 9: Update PriceSourceHealth type in shared/types/index.ts**

At line 1068, rename:
```typescript
"coingecko+defillama": number;  // was "defillama+coingecko"
```

- [ ] **Step 10: Update frontend status card**

In `src/components/status/price-source-health.tsx`, find all occurrences of `"defillama+coingecko"` and rename to `"coingecko+defillama"`.

**Note on backward compatibility:** Status endpoint returns live data (not persistently cached on the client). The key change takes effect on the next cron run after deployment. No dual-key fallback needed.

- [ ] **Step 11: Update stablecoin-summary test fixture**

In `worker/src/api/__tests__/stablecoin-summary.test.ts` (line 16), update:
```typescript
priceSource: "coingecko+defillama",  // was "defillama+coingecko"
```

- [ ] **Step 12: Type-check**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard/worker && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 13: Run all tests**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run`
Expected: PASS

- [ ] **Step 14: Commit**

```bash
git add worker/src/cron/sync-stablecoins.ts worker/src/cron/__tests__/sync-stablecoins.test.ts shared/types/index.ts src/components/status/price-source-health.tsx worker/src/api/__tests__/stablecoin-summary.test.ts
git commit -m "refactor(prices): update sync-stablecoins and all consumers for CG-primary rename"
```

---

### Task 3: Remove enrichment passes 2+3

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts:379-837` (EnrichmentStats + enrichMissingPrices)
- Modify: `worker/src/cron/sync-stablecoins.ts` (PriceSourceHealth)
- Test: `worker/src/cron/__tests__/enrich-prices.test.ts`
- Test: `worker/src/cron/__tests__/sync-stablecoins.test.ts`

**Context:** Pass 2 (lines 556-598) fetches prices via DL's CoinGecko proxy (`coingecko:{geckoId}` -> DL coins API). Pass 3 (lines 600-625) fetches directly from CG `/simple/price`. Both are now redundant because `fetchPrimaryPrices` already fetched CG prices for all assets with a geckoId. The only special case is `wrong-*` geckoIds which Pass 2 strips before routing to Pass 3. These originate from the DefiLlama API payload -- zero tracked stablecoins have `wrong-*` geckoIds (verified). After removal, untracked `wrong-*` assets fall through to CMC/DexScreener, which is acceptable.

**Important:** Pass 2's `afterPass2` array and `wrongGeckoPass` routing are self-contained -- no state leaks into later passes. Passes 2+3 can be deleted cleanly.

- [ ] **Step 1: Verify no tracked stablecoins have wrong-* geckoIds**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && grep -c "wrong" shared/lib/stablecoins.ts`
Expected: 0 (or only in unrelated strings like comments). If any tracked stablecoin has a `wrong-*` geckoId, STOP and reassess.

- [ ] **Step 2: Update tests**

In `enrich-prices.test.ts`, update these specific tests in the `enrichMissingPrices` describe block:

- **Remove test:** `"enriches via Pass 2 (geckoId -> DL coins API)"` (line ~335) -- pass no longer exists
- **Remove test:** `"falls through to Pass 3 (CG direct) when DL returns no price"` (line ~362) -- pass no longer exists
- **Update test:** `"skips assets with 'wrong' geckoId from Pass 2, routes to Pass 3"` (line ~390) -- wrong-geckoId assets now fall through to CMC/DexScreener. Update the test name and expectations: verify the asset does NOT get enriched by passes 1/1b and the enrichment stats show it stayed missing (unless CMC/DexScreener mock provides a price).
- **Update test:** `"leaves assets unpriced when all APIs return empty data"` (line ~416) -- remove `pass2` and `pass3` from expected stats assertion
- **Update:** The zero-count return test at the top of the suite (line ~291) -- remove `pass2: 0, pass3: 0` from expected return value

Also update the JSDoc comment above `enrichMissingPrices` (lines 192-198) to describe the new 4-pass system:
```
 * Enrich assets that are missing prices via a 4-pass pipeline:
 *   1. Contract addresses via DefiLlama coins API
 *   1b. Multi-chain contract fallback
 *   2. CoinMarketCap API (rate-limited)
 *   3. DexScreener search API (best-effort)
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run worker/src/cron/__tests__/enrich-prices.test.ts`

- [ ] **Step 4: Remove passes 2+3 from `enrichMissingPrices`**

In `worker/src/cron/enrich-prices.ts`:

1. Remove `pass2Count` and `pass3Count` variables (lines 477-478)
2. Delete Pass 2 block entirely (lines 556-598) including `geckoPass`, `wrongGeckoPass`, `afterPass2` arrays
3. Delete Pass 3 block entirely (lines 600-625)
4. Update CMC pass comment from `"Pass 3.5"` to `"Pass 2: CoinMarketCap API"`
5. Update DexScreener pass comment from `"Pass 4"` to `"Pass 3: DexScreener search API"`
6. Update `EnrichmentStats` interface (line 379-388) -- remove `pass2` and `pass3`:
```typescript
export interface EnrichmentStats {
  totalMissing: number;
  pass1: number;
  pass1b: number;
  passCmc: number;
  pass4: number;
  finalMissing: number;
}
```
Note: keep `pass4` field name as-is to avoid unnecessary rename churn. It's now DexScreener ("Pass 3" in comments) but `pass4` in the interface. Add a comment: `pass4: number; // DexScreener (legacy field name)`
7. Update zero-return at line ~462: remove `pass2: 0, pass3: 0`
8. Update return statements (line ~831 and ~835): remove `pass2: pass2Count, pass3: pass3Count`
9. Update summary log (lines 820-826): remove "Pass 2" and "Pass 3" entries, renumber to show "Pass 2 (CMC)" and "Pass 3 (DexScreener)"

- [ ] **Step 5: Update `PriceSourceHealth` in sync-stablecoins.ts**

Now that `enrichStats.pass2` and `pass3` are gone, finalize the distribution using `cgOnly`/`dlOnly`:

```typescript
sourceDistribution: {
  "coingecko+defillama": priceValidationStats.high,
  coingecko: priceValidationStats.cgOnly,
  defillama: priceValidationStats.dlOnly,
  "defillama-contract": enrichStats.pass1 + enrichStats.pass1b,
  coinmarketcap: enrichStats.passCmc,
  dexscreener: enrichStats.pass4,
  cached: 0,
  missing: enrichStats.finalMissing,
},
```

- [ ] **Step 6: Update sync-stablecoins.test.ts mock EnrichmentStats**

Find mock return values that include `pass2: 0, pass3: 0` (lines ~94, ~219 in `sync-stablecoins.test.ts`) and remove those fields. The mock should match the new `EnrichmentStats` shape.

- [ ] **Step 7: Run tests**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run`
Expected: PASS

- [ ] **Step 8: Type-check and build**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npm run build && cd worker && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add worker/src/cron/enrich-prices.ts worker/src/cron/sync-stablecoins.ts worker/src/cron/__tests__/enrich-prices.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts
git commit -m "refactor(prices): remove enrichment passes 2+3, collapse to 4-pass pipeline"
```

---

## Chunk 2: Cleanup & Documentation

### Task 4: Remove legacy price-validation shadow tracking

**Files:**
- Modify: `worker/src/cron/sync-stablecoins.ts`
- Modify: `worker/src/cron/__tests__/sync-stablecoins.test.ts`

**Context:** The `priceValidationShadow` metadata tracks mismatches between the legacy `isReasonablePrice()` and the new `validatePriceCandidate()`. The shadow data shows 1.5% mismatch rate -- all mismatches are acceptable (the new system is more permissive for NAV tokens and deep depegs). Time to remove the legacy tracking.

**Important:** Do NOT remove:
- `validatePriceCandidate()` -- this is the active validation system, NOT part of the shadow
- `shadowDecisionModeForAsset()` -- still used as a parameter to `validatePriceCandidate()` in the post-enrichment rejection loop
- `createValidationContextResolver()` -- still used for validation contexts
- `isReasonablePrice` from `enrich-prices.ts` -- still used in CMC pass (line ~690) and DexScreener pass (line ~795)

**DO remove:**
- `createPriceValidationShadowMetadata()` function
- `recordPriceValidationShadow()` function
- `isReasonablePriceForAsset()` function (only used for shadow comparison)
- All `legacyAccepted` variables and their associated `recordPriceValidationShadow()` calls
- `priceValidationShadow` from the metadata object
- The `PriceValidationShadowMetadata` type (check if locally defined or imported)
- The `isReasonablePrice` import from `"./enrich-prices"` in sync-stablecoins.ts (only used via `isReasonablePriceForAsset`)
- The `buildPriceReasonablenessOptions` import from `"./enrich-prices"` in sync-stablecoins.ts (only used via `isReasonablePriceForAsset`)

- [ ] **Step 1: Assess risk**

Verify the current mismatch rate via API or by reading the plan context above: `mismatchRate: 0.015` (1.5%). This has been stable. Safe to remove.

- [ ] **Step 2: Remove shadow tracking in sync-stablecoins.ts**

1. Remove `createPriceValidationShadowMetadata` function (lines ~132-141)
2. Remove `recordPriceValidationShadow` function (lines ~173-200)
3. Remove `isReasonablePriceForAsset` function (lines ~278-293)
4. Remove `priceValidationShadow` variable creation (line ~622)
5. Remove all 4 `recordPriceValidationShadow(...)` call sites:
   - `dual_primary_apply` stage (line ~677)
   - `pre_reject` stage (line ~711)
   - `post_enrichment_reject` stage (line ~747)
   - `cached_fallback` stage (search for it in the cached-price fallback block around lines ~775-805)
6. Remove all `legacyAccepted` variable assignments paired with the above calls
7. Remove the `isReasonablePriceForAsset(...)` calls that compute `legacyAccepted`
8. Remove `priceValidationShadow` from metadata object (lines ~974-979)
9. Remove the `PriceValidationShadowMetadata` type (if locally defined, delete it; if imported, remove the import)
10. Remove `isReasonablePrice` and `buildPriceReasonablenessOptions` from the `"./enrich-prices"` import if no longer used in this file

- [ ] **Step 3: Update sync-stablecoins.test.ts**

Three test areas need updating:

1. **`priceValidationShadow` assertions (lines ~762-765, ~798-801):** These tests assert on `metadata.priceValidationShadow.mismatched` and `.mismatchBreakdown` / `.sampleMismatches`. Remove these assertions since the metadata field no longer exists. If the tests are solely about shadow tracking, remove them entirely. If they test other metadata too, just remove the shadow-specific assertions.

2. **`isReasonablePrice` mock setup (lines ~694, ~707, ~723, ~776):** These are `vi.mocked(isReasonablePrice).mockImplementation(...)` calls. After removing `isReasonablePriceForAsset` from `sync-stablecoins.ts`, the mock may no longer be needed for these tests IF the tests were specifically testing shadow tracking behavior. Check each test:
   - If the test is about commodity price validation shadow (line ~694): the `isReasonablePrice` mock was used to simulate the legacy validator. The actual validation now uses `validatePriceCandidate`. If the test doesn't assert on shadow metadata anymore, the mock isn't needed for legacy simulation. But `isReasonablePrice` is still imported by `sync-stablecoins.test.ts` because it's mocked at the module level (line ~97). Check if removing the module-level mock causes issues -- it should be fine since the function is no longer called in `sync-stablecoins.ts`.
   - If `isReasonablePrice` mock at line 97 is in the `vi.mock("../enrich-prices", ...)` block, it will still be auto-mocked. Just make sure no test assertions depend on it being called.

3. **Module-level mock (line ~97):** The `isReasonablePrice: vi.fn(() => true)` mock can stay (it doesn't hurt to mock an unused function), but the explicit `mockReset/mockImplementation` calls in individual tests (lines ~221, ~694, ~723, ~776) should be removed if they were only serving the shadow tracking.

- [ ] **Step 4: Run tests and type-check**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run && cd worker && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/sync-stablecoins.ts worker/src/cron/__tests__/sync-stablecoins.test.ts
git commit -m "refactor(prices): remove legacy price validation shadow tracking"
```

---

### Task 5: Update documentation

**Files:**
- Modify: `docs/data-pipeline.md`
- Modify: `docs/api-reference.md`

- [ ] **Step 1: Update data-pipeline.md**

**Rewrite lines 33-59** ("Price Enrichment Pipeline" section):

Replace "Dual-Primary Price Validation" heading with "Primary Price Fetch":
- CoinGecko `/simple/price` is the primary price source
- DefiLlama coins API cross-validates within 50 bps
- Both agree (<=50 bps) -> high confidence, CG price used
- Disagree (>50 bps) -> use candidate closer to canonical peg reference, default to CG
- One source down -> single-source, use available
- Both down -> falls through to enrichment

Replace "6-pass system" with "4-pass system":
1. Pass 1: Contract address -> DefiLlama coins API
2. Pass 1b: Multi-chain contract address fallback
3. Pass 2: CoinMarketCap slug -> CMC quotes API
4. Pass 3: Symbol -> DexScreener search API

**Update line 91:** Change `dualPriceResults.get(asset.id)` to `primaryPriceResults.get(asset.id)` (in the DL ID remap guardrail description).

- [ ] **Step 2: Update api-reference.md**

- Line 132: Update `priceSource` description from `"defillama+coingecko"` to `"coingecko+defillama"`
- Line 133: Update `priceConfidence` description from `"dual-source agreement"` to `"cross-validated agreement"`
- Line 213: Update example from `"priceSource": "defillama+coingecko"` to `"priceSource": "coingecko+defillama"`

- [ ] **Step 3: Commit**

```bash
git add docs/data-pipeline.md docs/api-reference.md
git commit -m "docs: update price pipeline docs for CG-primary switch"
```

---

### Task 6: Full verification

- [ ] **Step 1: Run full build + type-check**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npm run build && cd worker && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 2: Run full test suite**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run`
Expected: All tests pass.

- [ ] **Step 3: Run lint**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npm run lint`
Expected: 0 errors (pre-existing warning is OK).

- [ ] **Step 4: Sanity-check no stale references to removed symbols**

Run all of these and expect zero matches (or only in `agents/plans/` which are historical):
```bash
# Old function name
grep -rn "fetchDualPrimaryPrices" worker/src/ shared/ src/ --include="*.ts" --include="*.tsx"
# Old source distribution key
grep -rn "defillama+coingecko" worker/src/ shared/ src/ --include="*.ts" --include="*.tsx"
# Removed EnrichmentStats fields (excluding pass4 which is kept)
grep -rn "\.pass2\b\|\.pass3\b\|pass2:" worker/src/ shared/ src/ --include="*.ts" --include="*.tsx"
# Old type names
grep -rn "DualPriceResult\|DualPriceStats" worker/src/ shared/ src/ --include="*.ts" --include="*.tsx"
# Removed shadow tracking
grep -rn "priceValidationShadow\|isReasonablePriceForAsset" worker/src/ shared/ src/ --include="*.ts" --include="*.tsx"
```

- [ ] **Step 5: Verify docs consistency**

```bash
# Old function name in docs
grep -rn "fetchDualPrimaryPrices\|dualPriceResults" docs/ --include="*.md"
# Old key in docs
grep -rn "defillama+coingecko" docs/ --include="*.md"
```
Note: `docs/dex-liquidity.md` line 236 legitimately references `priceValidationShadow` for the DEX-specific shadow system (still active). Do NOT change it.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **CG rate limiting** | No new API calls -- `fetchPrimaryPrices` makes the same CG `/simple/price` call as before. Batch size stays at 250. |
| **Coverage regression** | Shadow comparison remains as permanent health monitor. Contract-address passes (1/1b) and CMC/DexScreener fallbacks are safety nets. |
| **NAV token authority change** | NAV tokens now default to CG when DL and CG diverge. This is correct since CG is now primary and NAV tokens have no canonical peg reference. |
| **Supplemental assets** | Gold/silver/fiat tokens have geckoIds and go through `fetchPrimaryPrices` automatically (merged at line 601, primary fetch at line 629). No explicit override needed. |
| **`wrong-*` geckoIds** | Come from DL API payload (zero tracked stablecoins affected). After pass removal, untracked `wrong-*` assets fall through to CMC/DexScreener. |
| **Frontend key change** | `sourceDistribution` key rename propagated to shared/types, frontend status card, test fixtures. Status API returns live data -- no cached-key backward compat issue. |
| **`pass4` field name** | Kept as-is despite renumbering to avoid rename churn. Comment added for clarity. |

## Out of Scope

- Migrating CMC/DexScreener passes to use `validatePriceCandidate()` instead of `isReasonablePrice()` -- separate task
- Splitting `DL_COINS` circuit breaker (still guards contract-address lookups in passes 1/1b) -- not needed yet
- Adding `include_market_cap=true` to primary CG fetch (would eliminate `fetchCoinGeckoMarketData` entirely) -- separate optimization
- Removing `fetchCoinGeckoMarketData` from supplemental-assets.ts -- still needed for market cap data
