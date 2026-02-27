# Dynamic FX-Based Price Bounds Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace hardcoded currency bounds in `isReasonablePrice` with dynamic bounds derived from live FX rates: `[0.01 * fxRate, 2 * fxRate]`.

**Architecture:** Add an optional `fxRates` parameter to `isReasonablePrice`. When provided and the peg type has a matching FX rate, use dynamic bounds. Fall back to existing hardcoded bounds when FX rates are unavailable. Thread FX rates from D1 cache through all call sites.

**Tech Stack:** TypeScript, Cloudflare Workers, D1 database

---

### Task 1: Update `isReasonablePrice` signature and logic

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts:35-61`

**Step 1: Update the function**

Replace the entire `isReasonablePrice` function (lines 35-61) with:

```ts
/** Guard against corrupted API prices that would break peg deviation calculations */
export function isReasonablePrice(price: number, pegType: string | undefined, fxRates?: Record<string, number>): boolean {
  if (!pegType) return price > 0 && price < 100_000;

  // USD is the base currency — no FX rate, keep tight hardcoded bounds
  if (pegType.includes("USD")) {
    return price > 0.01 && price < 1.19; // USD stablecoins never legitimately trade above $1.19 — higher values are CG data artifacts
  }

  // Dynamic bounds from live FX rates: 0.01x to 2x
  if (fxRates) {
    const fxRate = fxRates[pegType];
    if (fxRate && fxRate > 0) {
      return price > 0.01 * fxRate && price < 2 * fxRate;
    }
  }

  // Hardcoded fallback when FX rates unavailable (first boot, cache miss)
  if (pegType.includes("EUR") || pegType.includes("GBP") || pegType.includes("CHF") || pegType.includes("BRL") || pegType.includes("REAL")) {
    return price > 0.01 && price < 2;
  }
  if (pegType.includes("JPY")) return price > 0.001 && price < 0.05;
  if (pegType.includes("IDR")) return price > 0.00001 && price < 0.001;
  if (pegType.includes("SGD")) return price > 0.2 && price < 5;
  if (pegType.includes("TRY")) return price > 0.005 && price < 0.5;
  if (pegType.includes("AUD")) return price > 0.2 && price < 5;
  if (pegType.includes("RUB")) {
    return price > 0.005 && price < 50; // RUB ~$0.0127, lower bound allows for further weakening
  }
  if (pegType.includes("ZAR")) return price > 0.01 && price < 0.5;
  if (pegType.includes("CAD")) return price > 0.30 && price < 2;
  if (pegType.includes("CNY")) return price > 0.01 && price < 0.50;
  if (pegType.includes("PHP")) return price > 0.002 && price < 0.10;
  if (pegType.includes("MXN")) return price > 0.005 && price < 0.20;
  if (pegType.includes("UAH")) return price > 0.002 && price < 0.15;
  if (pegType.includes("ARS")) return price > 0.000001 && price < 0.05;
  if (pegType.includes("GOLD")) return price > 100 && price < 100_000;
  if (pegType.includes("SILVER")) return price > 5 && price < 500;
  return price > 0 && price < 100_000;
}
```

Key logic: FX dynamic check sits between the USD special case and the hardcoded fallbacks. If `fxRates` is provided and has the peg type, dynamic bounds win. Otherwise, existing hardcoded bounds kick in unchanged.

**Step 2: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS — the new optional parameter is backwards-compatible with all existing callers (they just don't pass it yet).

**Step 3: Commit**

```bash
git add worker/src/cron/enrich-prices.ts
git commit -m "feat(worker): add optional fxRates param to isReasonablePrice for dynamic bounds"
```

---

### Task 2: Thread FX rates through `enrichMissingPrices`

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts:273-277` (function signature)
- Modify: `worker/src/cron/enrich-prices.ts:492` (CMC pass call)
- Modify: `worker/src/cron/enrich-prices.ts:569` (DexScreener pass call)

`enrichMissingPrices` already has an optional `db` param. Strategy: load FX rates from D1 once at the top of the function and pass them to the two internal `isReasonablePrice` calls.

**Step 1: Load FX rates at the top of `enrichMissingPrices`**

After line 279 (`if (totalMissing === 0) return ...`), add:

```ts
  // Load FX rates for dynamic price bounds
  let fxRates: Record<string, number> | undefined;
  if (db) {
    try {
      const fxCache = await db.prepare("SELECT value FROM cache WHERE key = 'fx-rates'").first<{ value: string }>();
      if (fxCache) fxRates = JSON.parse(fxCache.value);
    } catch { /* non-blocking */ }
  }
```

Note: we use a raw query instead of `getCache()` to avoid importing it (it's in `../lib/db` — check if already imported). Actually, `getCache` is NOT imported in `enrich-prices.ts`. Use a raw D1 query to avoid adding an import.

**Step 2: Pass `fxRates` to both internal `isReasonablePrice` calls**

At line 492, change:
```ts
                if (isReasonablePrice(cmcEntry.price, m.asset.pegType as string | undefined)) {
```
to:
```ts
                if (isReasonablePrice(cmcEntry.price, m.asset.pegType as string | undefined, fxRates)) {
```

At line 569, change:
```ts
        if (isReasonablePrice(price, m.asset.pegType as string | undefined)) {
```
to:
```ts
        if (isReasonablePrice(price, m.asset.pegType as string | undefined, fxRates)) {
```

**Step 3: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add worker/src/cron/enrich-prices.ts
git commit -m "feat(worker): thread FX rates through enrichMissingPrices to isReasonablePrice"
```

---

### Task 3: Thread FX rates through `syncStablecoins` (main path)

**Files:**
- Modify: `worker/src/cron/sync-stablecoins.ts:448-537`

`syncStablecoins` has 4 `isReasonablePrice` calls (lines 457, 481, 506, 537). The FX cache is currently loaded late (line 650). Strategy: load FX rates once early (before line 448) and pass them to all 4 calls.

**Step 1: Load FX rates early in `syncStablecoins`**

Before line 448 (the `// --- Dual-primary price validation ---` comment), insert:

```ts
  // Load FX rates early for dynamic price bounds in isReasonablePrice
  let fxRates: Record<string, number> | undefined;
  const fxCacheEarly = await getCache(db, "fx-rates");
  if (fxCacheEarly) {
    try { fxRates = JSON.parse(fxCacheEarly.value); } catch { /* ignore */ }
  }
```

**Step 2: Pass `fxRates` to all 4 `isReasonablePrice` calls**

Line 457:
```ts
    if (dual && isReasonablePrice(dual.price, asset.pegType as string | undefined, fxRates)) {
```

Line 481:
```ts
      !isReasonablePrice(asset.price, asset.pegType as string | undefined, fxRates)
```

Line 506:
```ts
    if (asset.price != null && typeof asset.price === "number" && !isReasonablePrice(asset.price, asset.pegType as string | undefined, fxRates)) {
```

Line 537:
```ts
      if (cached && (now - cached.updatedAt) < PRICE_CACHE_TTL && isReasonablePrice(cached.price, asset.pegType as string | undefined, fxRates)) {
```

**Step 3: Reuse `fxRates` for the existing FX embed (line 649-655)**

Replace the FX cache load at line 649-655:

```ts
  // Embed live FX fallback rates if available (reuse earlier fetch)
  if (fxRates) {
    llamaData.fxFallbackRates = fxRates;
  }
```

This eliminates the duplicate `getCache(db, "fx-rates")` call.

**Step 4: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add worker/src/cron/sync-stablecoins.ts
git commit -m "feat(worker): pass FX rates to isReasonablePrice in syncStablecoins"
```

---

### Task 4: Thread FX rates through `fallbackToCgSupply`

**Files:**
- Modify: `worker/src/cron/sync-stablecoins.ts:272-370` (`fallbackToCgSupply` function)

`fallbackToCgSupply` calls `enrichMissingPrices` (line 340) which now loads its own FX rates internally (Task 2). It does NOT call `isReasonablePrice` directly. So this task has **no changes needed** — `enrichMissingPrices` handles it internally.

Verify: Search `fallbackToCgSupply` for any direct `isReasonablePrice` calls → none. Skip this task.

---

### Task 5: Thread FX rates through `backfill-depegs.ts`

**Files:**
- Modify: `worker/src/api/backfill-depegs.ts:440-444` (function signature)
- Modify: `worker/src/api/backfill-depegs.ts:655` (call site)
- Modify: `worker/src/api/backfill-depegs.ts:369` (caller passes FX rates)

**Step 1: Find where FX rates are available in the backfill flow**

The handler at line ~255-266 already parses the stablecoins cache which contains `fxFallbackRates`. These need to be threaded down to `backfillCoin`.

Add `fxRates` parameter to `backfillCoin`:

Change line 440-444 from:
```ts
async function backfillCoin(
  meta: StablecoinMeta,
  geckoId: string,
  getPegRef: (timestamp: number) => number,
  supplyByDate: Map<number, number>
): Promise<BackfillEvent[] | null> {
```
to:
```ts
async function backfillCoin(
  meta: StablecoinMeta,
  geckoId: string,
  getPegRef: (timestamp: number) => number,
  supplyByDate: Map<number, number>,
  fxRates?: Record<string, number>,
): Promise<BackfillEvent[] | null> {
```

**Step 2: Pass `fxRates` to `isReasonablePrice` at line 655**

Change:
```ts
    if (!isReasonablePrice(price, pegType)) continue;
```
to:
```ts
    if (!isReasonablePrice(price, pegType, fxRates)) continue;
```

**Step 3: Pass FX rates from the caller at line 369**

First, find where `fxFallbackRates` is parsed. It's at line 263:
```ts
const data = JSON.parse(cached.value) as { peggedAssets: StablecoinData[]; fxFallbackRates?: Record<string, number> };
```

Need to check if this variable is in scope at line 369 where `backfillCoin` is called. Read lines around 250-370 to confirm the variable name and scope.

At line 369, change:
```ts
      const events = await backfillCoin(meta, geckoId, getPegRef, supplyByDate);
```
to:
```ts
      const events = await backfillCoin(meta, geckoId, getPegRef, supplyByDate, fxRates);
```

**Important:** The `fxFallbackRates` variable from line 263 may be scoped inside a try block. You may need to extract it to a broader scope variable named `fxRates` at the handler level. Read lines 240-370 carefully to determine scoping and name the variable appropriately.

**Step 4: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add worker/src/api/backfill-depegs.ts
git commit -m "feat(worker): pass FX rates to isReasonablePrice in backfill-depegs"
```

---

### Task 6: Final verification

**Step 1: Full type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS with zero errors

**Step 2: Frontend build**

Run: `npm run build`
Expected: PASS — frontend doesn't import `isReasonablePrice` so no impact, but verify no transitive breakage.

**Step 3: Verify no remaining unpatched call sites**

Run: `grep -rn "isReasonablePrice" worker/src/ | grep -v "fxRates"` — any line calling `isReasonablePrice` without `fxRates` should be either the function definition itself or a deliberate omission (which would fall back to hardcoded bounds).

Expected: Only the function definition line and no other calls missing `fxRates`.
