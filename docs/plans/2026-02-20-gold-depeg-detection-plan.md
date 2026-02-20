# Gold Stablecoin Depeg Detection Fix

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable depeg event detection for gold-pegged stablecoins (PAXG, XAUT, etc.) by adding an independent XAU spot price reference and removing the backfill exclusion.

**Architecture:** Three changes: (1) fetch gold spot price in sync-fx-rates cron (same pattern as silver), (2) use spot price unconditionally for commodity pegs instead of self-referential peer median, (3) remove backfill exclusion and add historical gold spot reference for accurate historical depeg detection.

**Tech Stack:** Cloudflare Worker, D1, DefiLlama coins API

---

### Task 1: Add gold spot price to sync-fx-rates.ts

**Files:**
- Modify: `worker/src/cron/sync-fx-rates.ts`
- Modify: `worker/src/lib/constants.ts` (no change needed — bounds are in sync-fx-rates.ts)

**Context:** Silver spot is already fetched from `coins.llama.fi/prices/current/coingecko:silver` at lines 152-169. Gold follows the exact same pattern using `coingecko:gold`.

**Step 1: Add peggedGOLD to FX_RATE_BOUNDS**

In `worker/src/cron/sync-fx-rates.ts`, add to the `FX_RATE_BOUNDS` object after the `peggedSILVER` entry:

```ts
  peggedGOLD: [500, 10000],    // Gold ~$2900/oz
```

**Step 2: Add gold spot price fetch**

After the silver spot block (lines 152-169), add an identical block for gold:

```ts
    // Gold spot price (USD per troy ounce) from DefiLlama coins API
    // Used as FX fallback for peggedGOLD — commodity pegs need independent spot reference
    try {
      const goldRes = await fetchWithRetry("https://coins.llama.fi/prices/current/coingecko:gold", {
        headers: { "User-Agent": USER_AGENT },
      });
      if (goldRes && goldRes.ok) {
        const goldData = (await goldRes.json()) as { coins?: Record<string, { price?: number }> };
        const goldPrice = goldData?.coins?.["coingecko:gold"]?.price;
        if (typeof goldPrice === "number" && goldPrice > 0) {
          if (isValidRate("peggedGOLD", goldPrice, prevRates["peggedGOLD"])) {
            rates["peggedGOLD"] = goldPrice;
          } else if (prevRates["peggedGOLD"]) {
            rates["peggedGOLD"] = prevRates["peggedGOLD"];
          }
        }
      }
    } catch {
      // Gold spot fetch failed — peg-rates will rely on median only
    }
```

**Step 3: Verify**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

---

### Task 2: Use spot price for commodity pegs in peg-rates.ts

**Files:**
- Modify: `src/lib/peg-rates.ts`

**Context:** Currently, `derivePegRates()` only uses the FX fallback for thin groups (< 3 coins). For commodities (gold/silver), the spot price IS the definitive peg reference — tokens are redeemable for physical metal at spot. The peer median is self-referential when the 2 largest tokens (PAXG, XAUT) dominate the group.

**Step 1: Prefer spot fallback for commodity pegs**

In `derivePegRates()`, replace the thin-group guard block (lines 63-72):

```ts
    // For thin groups (<3 coins), always use the FX fallback rate.
    // Median of 1-2 coins is unreliable:
    //   - 1 coin: median = own price → always 0 bps (hides real deviations)
    //   - 2 coins: median = average → perfect mirror deviations (hides asymmetry)
    // The ECB FX rate is a far more reliable reference for these groups.
    const fallback = mergedFallbacks[peg];
    if (prices.length < 3 && fallback) {
      rates[peg] = fallback;
      continue;
    }
```

With:

```ts
    // For commodity pegs (gold, silver), always prefer the spot price over
    // the peer median. The spot price is the definitive reference — tokens
    // are redeemable for physical metal at spot. Peer median is self-referential
    // when 2 tokens (PAXG, XAUT) dominate the group by mcap.
    //
    // For thin fiat groups (<3 coins), also use the FX fallback — median of
    // 1-2 coins is unreliable (own price → 0 bps, or averaged mirror deviations).
    const fallback = mergedFallbacks[peg];
    const isCommodity = peg === "peggedGOLD" || peg === "peggedSILVER";
    if (fallback && (isCommodity || prices.length < 3)) {
      rates[peg] = fallback;
      continue;
    }
```

**Step 2: Verify**

Run: `npm run build` (includes type-check)
Expected: Build succeeds.

---

### Task 3: Enable gold token backfill

**Files:**
- Modify: `worker/src/api/backfill-depegs.ts`

**Context:** Two issues: (a) line 185 explicitly excludes `gold-*` IDs, (b) gold tokens fall through to the else branch in the peg reference builder but `PEG_TO_FX` has no "GOLD" entry, so they get a constant fallback instead of a historical time series. Silver has the same problem — its backfill also uses a constant. We'll fix both by fetching historical commodity spot prices from DefiLlama's coins chart API.

**Step 1: Remove the gold exclusion filter**

At line 183-186, change:

```ts
  // Filter to processable coins (skip NAV tokens, gold synthetics)
  const processable = coins.filter(
    (m) => !m.flags.navToken && !m.id.startsWith("gold-")
  );
```

To:

```ts
  // Filter to processable coins (skip NAV tokens)
  const processable = coins.filter(
    (m) => !m.flags.navToken
  );
```

**Step 2: Add commodity spot price map and fetch helper**

Add the following constant after the `OTHER_COIN_FX` object (around line 27):

```ts
/** Maps commodity pegCurrency → DefiLlama coins chart ID for historical spot prices */
const COMMODITY_SPOT_IDS: Record<string, string> = {
  GOLD: "coingecko:gold",
  SILVER: "coingecko:silver",
};
```

**Step 3: Add helper to fetch historical commodity spot prices**

Add this function after `buildFxLookup` (around line 116):

```ts
/**
 * Fetch historical commodity spot prices from DefiLlama coins chart API.
 * Returns a time series suitable for buildFxLookup.
 */
async function fetchCommoditySpotHistory(
  coinId: string,
  startTs: number,
): Promise<FxTimeSeries[]> {
  try {
    // Fetch in 2 chunks (2 years each) to match the backfill window
    const midTs = startTs + 2 * 365 * 86400;
    const [older, newer] = await Promise.all([
      fetchPriceChart(coinId, startTs),
      fetchPriceChart(coinId, midTs),
    ]);
    // Deduplicate by timestamp, then convert to FxTimeSeries format
    const byTs = new Map<number, number>();
    for (const p of [...older, ...newer]) {
      byTs.set(p.timestamp, p.price);
    }
    return Array.from(byTs.entries())
      .map(([timestamp, rate]) => ({ timestamp, rate }))
      .sort((a, b) => a.timestamp - b.timestamp);
  } catch (err) {
    console.error(`[backfill-depegs] Commodity spot fetch failed for ${coinId}:`, err);
    return [];
  }
}
```

**Step 4: Add commodity handling to the peg reference builder**

In the per-coin processing loop, replace the peg reference builder block (lines 243-264):

```ts
    // Build time-varying peg reference function for this coin
    const peg = meta.flags.pegCurrency;
    const pegType = `pegged${peg}`;
    const currentPegRef = getPegReference(pegType, pegRates, meta.goldOunces);
    let getPegRef: (timestamp: number) => number;

    if (peg === "USD") {
      getPegRef = () => 1;
    } else if (peg === "RUB") {
      getPegRef = () => RUB_FALLBACK;
    } else {
      const fxCode = PEG_TO_FX[peg] ?? OTHER_COIN_FX[meta.id];
      const series = fxCode ? fxSeries[fxCode] ?? [] : [];
      const fallback = currentPegRef > 0 ? currentPegRef : 1;
      const fxLookup = buildFxLookup(series, fallback);
      if (meta.goldOunces && meta.goldOunces > 0) {
        const oz = meta.goldOunces;
        getPegRef = (ts) => fxLookup(ts) * oz;
      } else {
        getPegRef = fxLookup;
      }
    }
```

With:

```ts
    // Build time-varying peg reference function for this coin
    const peg = meta.flags.pegCurrency;
    const pegType = `pegged${peg}`;
    const currentPegRef = getPegReference(pegType, pegRates, meta.goldOunces);
    let getPegRef: (timestamp: number) => number;

    const commodityId = COMMODITY_SPOT_IDS[peg];
    if (peg === "USD") {
      getPegRef = () => 1;
    } else if (peg === "RUB") {
      getPegRef = () => RUB_FALLBACK;
    } else if (commodityId) {
      // Commodity pegs (GOLD, SILVER): use historical spot prices from DefiLlama
      const series = await fetchCommoditySpotHistory(commodityId, fourYearsAgo);
      const fallback = currentPegRef > 0 ? currentPegRef : 1;
      const spotLookup = buildFxLookup(series, fallback);
      if (meta.goldOunces && meta.goldOunces > 0) {
        const oz = meta.goldOunces;
        getPegRef = (ts) => spotLookup(ts) * oz;
      } else {
        getPegRef = spotLookup;
      }
    } else {
      const fxCode = PEG_TO_FX[peg] ?? OTHER_COIN_FX[meta.id];
      const series = fxCode ? fxSeries[fxCode] ?? [] : [];
      const fallback = currentPegRef > 0 ? currentPegRef : 1;
      const fxLookup = buildFxLookup(series, fallback);
      if (meta.goldOunces && meta.goldOunces > 0) {
        const oz = meta.goldOunces;
        getPegRef = (ts) => fxLookup(ts) * oz;
      } else {
        getPegRef = fxLookup;
      }
    }
```

Note: `fourYearsAgo` is already computed as a unix-seconds value earlier in the function (around line 204 as `fourYearsAgoMs`). We'll need to use `Math.floor(fourYearsAgoMs / 1000)` to get seconds. Actually `fourYearsAgoMs` is milliseconds — the `fetchPriceChart` function takes seconds for the `start` parameter. So pass `Math.floor(fourYearsAgoMs / 1000)`.

**Step 5: Verify**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

---

### Task 4: Final verification

**Step 1: Full build**

Run: `npm run build`
Expected: Build succeeds with no type errors.

**Step 2: Worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.
