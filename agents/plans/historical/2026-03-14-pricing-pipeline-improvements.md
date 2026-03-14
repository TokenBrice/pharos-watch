# Pricing Pipeline Improvements (P0–P7) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the pricing pipeline from 2-source cross-validation (CG+DL) to a multi-source consensus system with oracle prices, direct exchange tickers, on-chain pricing, and real-time FX rates, improving depeg detection accuracy across all 156 tracked stablecoins.

**Architecture:** New price sources (Pyth, Binance, Coinbase, RedStone, Curve on-chain, expanded protocol redemption) are integrated as additional voices in the existing `fetchPrimaryPrices()` cross-validation step. Each source is wrapped in its own module behind a circuit breaker, producing standard `PrimaryPriceResult` output. The N-source consensus replaces the current 2-source comparison. FX rate upgrade runs alongside the existing `syncFxRates()` cron. DEX prices are promoted from depeg-only cross-validation to a primary pipeline voice. CoinMarketCap enrichment is optimized from per-slug to batch endpoint.

**Tech Stack:** TypeScript strict, Cloudflare Workers (D1, fetch), Vitest, Zod validation

**Research doc:** `agents/research/2026-03-13-pricing-pipeline-improvement-research.md`

---

## Chunk 1: Shared Infrastructure

Foundation types, constants, and status tracking that all improvements depend on.

### Task 1: Extend StablecoinMeta with new source IDs

**Files:**
- Modify: `shared/types/core.ts:220-250` (StablecoinMeta interface)
- Modify: `shared/lib/stablecoins.ts:5-74` (StablecoinOpts + coin() builder)

- [ ] **Step 1: Add fields to StablecoinMeta**

In `shared/types/core.ts`, add after `cmcSlug` (line 231):

```typescript
pythFeedId?: string;
```

- [ ] **Step 2: Add fields to StablecoinOpts and coin() builder**

In `shared/lib/stablecoins.ts`, add to `StablecoinOpts` (after line 15):

```typescript
pythFeedId?: string;
```

In the `coin()` function return object (after line 55):

```typescript
pythFeedId: opts?.pythFeedId,
```

- [ ] **Step 3: Type-check**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: PASS (no consumers yet, so no type errors)

- [ ] **Step 4: Commit**

```bash
git add shared/types/core.ts shared/lib/stablecoins.ts
git commit -m "feat: add pythFeedId to StablecoinMeta"
```

---

### Task 2: Add circuit breaker sources for new providers

**Files:**
- Modify: `worker/src/lib/constants.ts:120-139` (CIRCUIT_SOURCE)

- [ ] **Step 1: Add new source constants**

In `worker/src/lib/constants.ts`, add to `CIRCUIT_SOURCE` object:

```typescript
PYTH_PRICES: "pyth-prices",
BINANCE_PRICES: "binance-prices",
COINBASE_PRICES: "coinbase-prices",
REDSTONE_PRICES: "redstone-prices",
CURVE_ONCHAIN: "curve-onchain",
FX_REALTIME: "fx-realtime",
```

- [ ] **Step 2: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add worker/src/lib/constants.ts
git commit -m "feat: add circuit breaker sources for new price providers"
```

---

### Task 3: Extend PriceSourceHealth for new sources

**Files:**
- Modify: `shared/types/status.ts:204-231` (PriceSourceHealth)

- [ ] **Step 1: Add new source keys to sourceDistribution**

In `shared/types/status.ts`, extend `sourceDistribution`:

```typescript
export interface PriceSourceHealth {
  sourceDistribution: {
    coingecko: number;
    "coingecko+defillama": number;
    defillama: number;
    "protocol-redeem": number;
    "defillama-contract": number;
    coinmarketcap: number;
    dexscreener: number;
    pyth: number;
    binance: number;
    coinbase: number;
    redstone: number;
    "curve-onchain": number;
    "dex-promoted": number;
    cached: number;
    missing: number;
  };
  // ... rest unchanged
}
```

- [ ] **Step 2: Initialize new keys in sync-stablecoins.ts**

Find the `sourceDistribution` initialization block in `worker/src/cron/sync-stablecoins.ts` (around line 834) and add the new keys initialized to `0`.

- [ ] **Step 2b: Map consensus source labels to distribution buckets**

The consensus module produces composite labels like `"coingecko+defillama"`, `"binance+coinbase"`, or `"coingecko+2more"`. The existing `sourceDistribution` lookup (`source in finalSourceDistribution`) only matches exact keys. Add a helper to normalize consensus labels to distribution buckets:

```typescript
// In sync-stablecoins.ts, near the sourceDistribution loop:
function mapSourceToBucket(source: string): keyof typeof finalSourceDistribution | null {
  // Exact match first
  if (source in finalSourceDistribution) return source as keyof typeof finalSourceDistribution;
  // Consensus labels: "coingecko+defillama" is already a bucket
  // For other multi-source labels, use the first (highest-weight) source name
  const firstSource = source.split("+")[0];
  if (firstSource in finalSourceDistribution) return firstSource as keyof typeof finalSourceDistribution;
  return null;
}

// Replace the existing lookup:
const bucket = mapSourceToBucket(source);
if (bucket) {
  finalSourceDistribution[bucket]++;
}
```

This ensures consensus labels like `"binance+coinbase"` map to the `"binance"` bucket (highest-weight source listed first), and `"coingecko+defillama"` still matches its dedicated bucket exactly.

- [ ] **Step 3: Update status dashboard display**

In `src/components/status/price-source-health.tsx`, add the new source labels to the source distribution text (around line 99).

- [ ] **Step 4: Type-check and build**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add shared/types/status.ts worker/src/cron/sync-stablecoins.ts src/components/status/price-source-health.tsx
git commit -m "feat: extend PriceSourceHealth with new price source categories"
```

---

### Task 4: Create multi-source price consensus module

This replaces the 2-source comparison in `fetchPrimaryPrices()` with an N-source weighted consensus.

**Files:**
- Create: `worker/src/lib/price-consensus.ts`
- Create: `worker/src/lib/__tests__/price-consensus.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `worker/src/lib/__tests__/price-consensus.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { computePriceConsensus, type SourcePrice } from "../price-consensus";

describe("computePriceConsensus", () => {
  it("returns high confidence when 2+ sources agree within threshold", () => {
    const sources: SourcePrice[] = [
      { source: "coingecko", price: 1.0001, weight: 1 },
      { source: "defillama", price: 1.0003, weight: 1 },
    ];
    const result = computePriceConsensus(sources, 1.0, 50);
    expect(result.confidence).toBe("high");
    expect(result.price).toBeCloseTo(1.0001, 4); // prefers first by weight
    expect(result.source).toContain("coingecko");
  });

  it("returns low confidence when sources diverge", () => {
    const sources: SourcePrice[] = [
      { source: "coingecko", price: 1.01, weight: 1 },
      { source: "defillama", price: 0.98, weight: 1 },
    ];
    const result = computePriceConsensus(sources, 1.0, 50);
    expect(result.confidence).toBe("low");
  });

  it("returns single-source when only one source available", () => {
    const sources: SourcePrice[] = [
      { source: "pyth", price: 0.999, weight: 1 },
    ];
    const result = computePriceConsensus(sources, 1.0, 50);
    expect(result.confidence).toBe("single-source");
    expect(result.price).toBe(0.999);
  });

  it("selects price closest to peg reference when diverging", () => {
    const sources: SourcePrice[] = [
      { source: "coingecko", price: 1.05, weight: 1 },
      { source: "pyth", price: 1.001, weight: 1 },
    ];
    const result = computePriceConsensus(sources, 1.0, 50);
    expect(result.price).toBe(1.001);
    expect(result.source).toBe("pyth");
  });

  it("uses majority when 3+ sources and 2 agree", () => {
    const sources: SourcePrice[] = [
      { source: "coingecko", price: 1.0001, weight: 1 },
      { source: "defillama", price: 1.0002, weight: 1 },
      { source: "pyth", price: 0.97, weight: 1 },
    ];
    const result = computePriceConsensus(sources, 1.0, 50);
    expect(result.confidence).toBe("high");
    // Should pick from the agreeing majority, not the outlier
    expect(result.price).toBeCloseTo(1.0001, 3);
  });

  it("prefers higher-weight source when multiple agree", () => {
    const sources: SourcePrice[] = [
      { source: "coingecko", price: 1.0001, weight: 1 },
      { source: "binance", price: 1.0002, weight: 2 },
    ];
    const result = computePriceConsensus(sources, 1.0, 50);
    expect(result.price).toBe(1.0002);
    expect(result.source).toContain("binance");
  });

  it("returns null for empty sources", () => {
    const result = computePriceConsensus([], 1.0, 50);
    expect(result).toBeNull();
  });

  it("handles NAV tokens by defaulting to highest-weight source", () => {
    const sources: SourcePrice[] = [
      { source: "coingecko", price: 1.12, weight: 1 },
      { source: "defillama", price: 1.15, weight: 1 },
    ];
    const result = computePriceConsensus(sources, null, 50);
    expect(result.confidence).toBe("high"); // NAV: any agreement within threshold
    expect(result.price).toBe(1.12);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- worker/src/lib/__tests__/price-consensus.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement price consensus module**

Create `worker/src/lib/price-consensus.ts`:

```typescript
import type { PriceConfidence } from "@shared/types";

export interface SourcePrice {
  source: string;
  price: number;
  weight: number;
  metadata?: Record<string, unknown>;
}

export interface ConsensusResult {
  price: number;
  source: string;
  confidence: PriceConfidence;
  agreeSources: string[];
  disagreeSources: string[];
  allPrices: Record<string, number>;
}

/**
 * Compute price consensus across N sources.
 *
 * Algorithm:
 * 1. If 0 sources, return null.
 * 2. If 1 source, return single-source.
 * 3. For 2+ sources, find the largest cluster of sources that agree within
 *    `thresholdBps` of each other (pairwise).
 * 4. If majority cluster has 2+ members → high confidence, pick highest-weight member.
 * 5. If no majority → low confidence, pick source closest to `pegRef` (or highest-weight if NAV).
 */
export function computePriceConsensus(
  sources: SourcePrice[],
  pegRef: number | null,
  thresholdBps: number,
): ConsensusResult | null {
  if (sources.length === 0) return null;

  const allPrices: Record<string, number> = {};
  for (const s of sources) allPrices[s.source] = s.price;

  if (sources.length === 1) {
    const s = sources[0];
    return {
      price: s.price,
      source: s.source,
      confidence: "single-source",
      agreeSources: [s.source],
      disagreeSources: [],
      allPrices,
    };
  }

  // Find largest agreeing cluster (pairwise within threshold)
  const clusters = findAgreementClusters(sources, thresholdBps);
  const bestCluster = clusters.reduce((a, b) => a.length >= b.length ? a : b, []);

  const clusterSet = new Set(bestCluster.map((s) => s.source));
  const disagreeSources = sources.filter((s) => !clusterSet.has(s.source)).map((s) => s.source);

  if (bestCluster.length >= 2) {
    // Majority agreement — high confidence
    const chosen = bestCluster.reduce((a, b) => a.weight >= b.weight ? a : b);
    return {
      price: chosen.price,
      source: buildSourceLabel(bestCluster),
      confidence: "high",
      agreeSources: bestCluster.map((s) => s.source),
      disagreeSources,
      allPrices,
    };
  }

  // No agreement cluster — low confidence
  // For NAV tokens (pegRef === null), use highest-weight source
  if (pegRef === null || pegRef <= 0) {
    const chosen = sources.reduce((a, b) => a.weight >= b.weight ? a : b);
    // Even without peg ref, if sources are close enough, still call it high
    const sorted = [...sources].sort((a, b) => a.price - b.price);
    const spread = sorted.length >= 2
      ? Math.abs(sorted[sorted.length - 1].price - sorted[0].price) / ((sorted[0].price + sorted[sorted.length - 1].price) / 2) * 10000
      : 0;
    return {
      price: chosen.price,
      source: chosen.source,
      confidence: spread <= thresholdBps ? "high" : "low",
      agreeSources: spread <= thresholdBps ? sources.map((s) => s.source) : [chosen.source],
      disagreeSources: spread <= thresholdBps ? [] : sources.filter((s) => s !== chosen).map((s) => s.source),
      allPrices,
    };
  }

  // Pick source closest to peg reference
  const chosen = sources.reduce((a, b) =>
    Math.abs(a.price - pegRef) <= Math.abs(b.price - pegRef) ? a : b,
  );
  return {
    price: chosen.price,
    source: chosen.source,
    confidence: "low",
    agreeSources: [chosen.source],
    disagreeSources: sources.filter((s) => s !== chosen).map((s) => s.source),
    allPrices,
  };
}

function findAgreementClusters(sources: SourcePrice[], thresholdBps: number): SourcePrice[][] {
  // For each source, find all other sources within threshold
  const clusters: SourcePrice[][] = [];
  for (const anchor of sources) {
    const cluster = sources.filter((s) => {
      if (s === anchor) return true;
      const mid = (anchor.price + s.price) / 2;
      if (mid <= 0) return false;
      return (Math.abs(anchor.price - s.price) / mid) * 10000 <= thresholdBps;
    });
    clusters.push(cluster);
  }
  return clusters;
}

function buildSourceLabel(cluster: SourcePrice[]): string {
  const names = cluster.map((s) => s.source).sort();
  if (names.length <= 2) return names.join("+");
  return `${names[0]}+${names.length - 1}more`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- worker/src/lib/__tests__/price-consensus.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/price-consensus.ts worker/src/lib/__tests__/price-consensus.test.ts
git commit -m "feat: add N-source price consensus module"
```

---

## Chunk 2: P0 — Real-Time FX Rate Upgrade

### Task 5: Add real-time FX provider

**Files:**
- Create: `worker/src/lib/fx-realtime.ts`
- Create: `worker/src/lib/__tests__/fx-realtime.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `worker/src/lib/__tests__/fx-realtime.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchRealtimeFxRates } from "../fx-realtime";

afterEach(() => vi.unstubAllGlobals());

describe("fetchRealtimeFxRates", () => {
  it("returns USD-per-unit rates for all requested currencies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        rates: { JPY: 150.5, EUR: 0.925, BRL: 5.1, ZAR: 18.2, IDR: 15800 },
      }),
    }));
    const rates = await fetchRealtimeFxRates("test-key");
    expect(rates.get("peggedJPY")).toBeCloseTo(1 / 150.5, 6);
    expect(rates.get("peggedEUR")).toBeCloseTo(1 / 0.925, 4);
    expect(rates.get("peggedREAL")).toBeCloseTo(1 / 5.1, 4);
  });

  it("returns empty map on API failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const rates = await fetchRealtimeFxRates("test-key");
    expect(rates.size).toBe(0);
  });

  it("validates rates against bounds before returning", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        rates: { JPY: 0.001, EUR: 0.925 }, // JPY rate is absurd (1 JPY = $1000)
      }),
    }));
    const rates = await fetchRealtimeFxRates("test-key");
    expect(rates.has("peggedJPY")).toBe(false); // rejected by bounds
    expect(rates.has("peggedEUR")).toBe(true);   // accepted
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- worker/src/lib/__tests__/fx-realtime.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement real-time FX provider**

Create `worker/src/lib/fx-realtime.ts`:

```typescript
import { z } from "zod";

/**
 * Real-time FX rate provider using Open Exchange Rates.
 * Free tier: 1,000 requests/month. We call once per 15-min cron = ~2,880/month,
 * so we need the basic plan ($12/mo) or can rate-limit to hourly (2,160/month free is tight).
 *
 * Alternative: exchangerate.host (100/mo free — too tight).
 * Alternative: Twelve Data (800/day free — fits comfortably at 96/day).
 *
 * This module supports both providers via an adapter pattern.
 */

const CURRENCY_TO_PEG: Record<string, string> = {
  EUR: "peggedEUR", GBP: "peggedGBP", CHF: "peggedCHF",
  BRL: "peggedREAL", JPY: "peggedJPY", IDR: "peggedIDR",
  SGD: "peggedSGD", TRY: "peggedTRY", AUD: "peggedAUD",
  ZAR: "peggedZAR", CAD: "peggedCAD", CNY: "peggedCNY",
  CNH: "peggedCNH", PHP: "peggedPHP", MXN: "peggedMXN",
  RUB: "peggedRUB", UAH: "peggedUAH", ARS: "peggedARS",
};

// Same bounds as sync-fx-rates.ts for consistency
const FX_RATE_BOUNDS: Record<string, [number, number]> = {
  peggedEUR: [0.50, 2.50], peggedGBP: [0.50, 3.00], peggedCHF: [0.40, 2.50],
  peggedREAL: [0.05, 0.60], peggedJPY: [0.003, 0.03], peggedIDR: [0.00003, 0.0003],
  peggedSGD: [0.30, 1.50], peggedTRY: [0.01, 0.20], peggedAUD: [0.30, 1.50],
  peggedZAR: [0.02, 0.20], peggedRUB: [0.003, 0.10], peggedCAD: [0.40, 1.50],
  peggedCNY: [0.05, 0.40], peggedCNH: [0.05, 0.40], peggedPHP: [0.01, 0.06],
  peggedMXN: [0.02, 0.15], peggedUAH: [0.01, 0.10], peggedARS: [0.0001, 0.01],
};

const OpenExchangeRatesSchema = z.object({
  rates: z.record(z.string(), z.number()),
});

/**
 * Fetch real-time FX rates from Open Exchange Rates.
 * Returns Map<pegKey, usdPerUnit> — same format as sync-fx-rates cache.
 */
export async function fetchRealtimeFxRates(
  apiKey: string,
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!apiKey) return result;

  try {
    const symbols = Object.keys(CURRENCY_TO_PEG).join(",");
    const res = await fetch(
      `https://openexchangerates.org/api/latest.json?app_id=${apiKey}&symbols=${symbols}&base=USD`,
      { signal, headers: { Accept: "application/json" } },
    );
    if (!res.ok) {
      console.warn(`[fx-realtime] Open Exchange Rates returned ${res.status}`);
      return result;
    }
    const data = OpenExchangeRatesSchema.parse(await res.json());

    for (const [currency, unitsPerUsd] of Object.entries(data.rates)) {
      const pegKey = CURRENCY_TO_PEG[currency];
      if (!pegKey || unitsPerUsd <= 0) continue;
      const rate = Number((1 / unitsPerUsd).toFixed(8));
      const bounds = FX_RATE_BOUNDS[pegKey];
      if (bounds && (rate < bounds[0] || rate > bounds[1])) {
        console.warn(`[fx-realtime] Rejected ${pegKey}=${rate}: outside bounds`);
        continue;
      }
      result.set(pegKey, rate);
    }
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[fx-realtime] Fetch failed:", err);
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- worker/src/lib/__tests__/fx-realtime.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/fx-realtime.ts worker/src/lib/__tests__/fx-realtime.test.ts
git commit -m "feat(P0): add real-time FX rate provider module"
```

---

### Task 6: Integrate real-time FX into sync-fx-rates

**Files:**
- Modify: `worker/src/cron/sync-fx-rates.ts:106-326`
- Modify: `worker/src/lib/env.ts` (add OPENEXCHANGERATES_API_KEY)
- Modify: `worker/src/handlers/scheduled/quarter-hourly.ts:42`

- [ ] **Step 1: Add env var for API key**

In `worker/src/lib/env.ts`, add to the `Env` interface:

```typescript
OPENEXCHANGERATES_API_KEY?: string;
```

- [ ] **Step 2: Integrate real-time FX into sync-fx-rates with hourly rate limit**

In `worker/src/cron/sync-fx-rates.ts`:

1. Import `fetchRealtimeFxRates` from `../lib/fx-realtime`
2. Add new parameter: `openExchangeRatesKey?: string`
3. **Rate limit to once per hour** (same pattern as CMC's `lastCmcFetchKey`). The Open Exchange Rates free tier allows 1,000 requests/month. At 1/hour = 720/month, safely within free tier. The basic plan ($12/mo, 10K/month) allows higher frequency later.
4. After the Frankfurter fetch block (around line 182), add a rate-limited real-time fetch
5. Cross-validate: for each currency where both Frankfurter and real-time agree within 5%, use the real-time (fresher) rate; if they diverge >5%, use Frankfurter (more established) and log a warning
6. Track source metadata: `sources.openExchangeRates: "ok" | "partial" | "unavailable"`

Key integration point — after line 182 (Frankfurter rates applied), before secondary API call:

```typescript
// Real-time FX cross-validation (P0) — rate limited to 1/hour for free tier
if (openExchangeRatesKey) {
  const OXR_CACHE_KEY = "fx-oxr-last-fetch";
  const lastFetch = await db.prepare("SELECT value FROM cache WHERE key = ?").bind(OXR_CACHE_KEY).first<{ value: string }>();
  const lastFetchTime = lastFetch ? parseInt(lastFetch.value, 10) : 0;
  const elapsedMinutes = (Math.floor(Date.now() / 1000) - lastFetchTime) / 60;

  if (elapsedMinutes >= 55) { // ~1 hour with margin
    const realtimeRates = await fetchRealtimeFxRates(openExchangeRatesKey, signal);
    if (realtimeRates.size > 0) {
      await db.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
        .bind(OXR_CACHE_KEY, String(Math.floor(Date.now() / 1000)), Math.floor(Date.now() / 1000)).run();
    }
    let realtimeApplied = 0;
    for (const [pegKey, realtimeRate] of realtimeRates) {
      const frankfurterRate = rates[pegKey];
      if (frankfurterRate != null) {
        const delta = Math.abs(realtimeRate - frankfurterRate) / frankfurterRate;
        if (delta <= 0.05) {
          // Agree within 5% — use fresher real-time rate
          if (isValidRate(pegKey, realtimeRate, prevRates[pegKey])) {
            rates[pegKey] = realtimeRate;
            realtimeApplied++;
          }
        } else {
          console.warn(`[sync-fx-rates] ${pegKey} diverges: frankfurter=${frankfurterRate}, realtime=${realtimeRate} (${(delta * 100).toFixed(1)}%)`);
        }
      } else {
        // Frankfurter doesn't have this currency — use real-time directly
        if (isValidRate(pegKey, realtimeRate, prevRates[pegKey])) {
          rates[pegKey] = realtimeRate;
          realtimeApplied++;
        }
      }
    }
    console.log(`[sync-fx-rates] Applied ${realtimeApplied}/${realtimeRates.size} real-time FX rates`);
  } else {
    console.log(`[sync-fx-rates] Skipping OXR fetch (last fetch ${Math.round(elapsedMinutes)}min ago, rate limit: 55min)`);
  }
}
```

- [ ] **Step 3: Pass API key from quarter-hourly slot**

In `worker/src/handlers/scheduled/quarter-hourly.ts`, update line 42:

```typescript
await runQuarterHourlyJob("sync-fx-rates", (signal) =>
  syncFxRates(runtime.db, signal, runtime.env.OPENEXCHANGERATES_API_KEY),
);
```

Update `syncFxRates` signature to accept the new parameter.

- [ ] **Step 4: Type-check and test**

Run: `npm run build && cd worker && npx tsc --noEmit && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/env.ts worker/src/cron/sync-fx-rates.ts worker/src/handlers/scheduled/quarter-hourly.ts
git commit -m "feat(P0): integrate real-time FX rates with Frankfurter cross-validation"
```

---

## Chunk 3: P1 — Pyth Network Oracle Integration

### Task 7: Create Pyth client module

**Files:**
- Create: `worker/src/lib/pyth.ts`
- Create: `worker/src/lib/__tests__/pyth.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `worker/src/lib/__tests__/pyth.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchPythPrices, type PythPriceResult } from "../pyth";

afterEach(() => vi.unstubAllGlobals());

describe("fetchPythPrices", () => {
  it("returns prices with confidence intervals", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        parsed: [
          {
            id: "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
            price: { price: "100013000", expo: -8, conf: "61000", publish_time: 1710000000 },
          },
        ],
      }),
    }));

    const feedIds = new Map([["usdt-tether", "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b"]]);
    const results = await fetchPythPrices(feedIds);

    expect(results.size).toBe(1);
    const r = results.get("usdt-tether")!;
    expect(r.price).toBeCloseTo(1.00013, 4);
    expect(r.confidenceBps).toBeGreaterThan(0);
    expect(r.publishTime).toBe(1710000000);
  });

  it("returns empty map on API failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const feedIds = new Map([["usdt-tether", "0xabc"]]);
    const results = await fetchPythPrices(feedIds);
    expect(results.size).toBe(0);
  });

  it("skips feeds with non-positive price", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        parsed: [
          { id: "0xabc", price: { price: "0", expo: -8, conf: "0", publish_time: 0 } },
        ],
      }),
    }));
    const feedIds = new Map([["broken-coin", "0xabc"]]);
    const results = await fetchPythPrices(feedIds);
    expect(results.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- worker/src/lib/__tests__/pyth.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement Pyth client**

Create `worker/src/lib/pyth.ts`:

```typescript
import { z } from "zod";

const HERMES_BASE = "https://hermes.pyth.network";

export interface PythPriceResult {
  price: number;
  confidence: number;       // raw confidence in USD
  confidenceBps: number;    // confidence as basis points of price
  publishTime: number;      // unix seconds
}

const PythPriceFeedSchema = z.object({
  parsed: z.array(z.object({
    id: z.string(),
    price: z.object({
      price: z.string(),
      expo: z.number(),
      conf: z.string(),
      publish_time: z.number(),
    }),
  })),
});

/**
 * Fetch latest prices from Pyth Hermes API.
 * Free public API, no auth required, 30 req/10s rate limit.
 *
 * @param feedIds Map of stablecoinId → Pyth price feed ID (hex)
 * @returns Map of stablecoinId → PythPriceResult
 */
export async function fetchPythPrices(
  feedIds: Map<string, string>,
  signal?: AbortSignal,
): Promise<Map<string, PythPriceResult>> {
  const results = new Map<string, PythPriceResult>();
  if (feedIds.size === 0) return results;

  // Reverse map: feedId → stablecoinId
  const reverseMap = new Map<string, string>();
  for (const [coinId, feedId] of feedIds) {
    reverseMap.set(feedId.toLowerCase(), coinId);
  }

  try {
    const ids = [...feedIds.values()].map((id) => `ids[]=${id}`).join("&");
    const res = await fetch(
      `${HERMES_BASE}/v2/updates/price/latest?${ids}`,
      { signal, headers: { Accept: "application/json" } },
    );
    if (!res.ok) {
      console.warn(`[pyth] Hermes API returned ${res.status}`);
      return results;
    }

    const data = PythPriceFeedSchema.parse(await res.json());

    for (const feed of data.parsed) {
      const coinId = reverseMap.get(feed.id.toLowerCase());
      if (!coinId) continue;

      const rawPrice = BigInt(feed.price.price);
      const rawConf = BigInt(feed.price.conf);
      const expo = feed.price.expo;
      const multiplier = Math.pow(10, expo);

      const price = Number(rawPrice) * multiplier;
      const confidence = Number(rawConf) * multiplier;

      if (price <= 0) continue;

      const confidenceBps = Math.round((confidence / price) * 10000);

      results.set(coinId, {
        price,
        confidence,
        confidenceBps,
        publishTime: feed.price.publish_time,
      });
    }
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[pyth] Fetch failed:", err);
  }

  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- worker/src/lib/__tests__/pyth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/pyth.ts worker/src/lib/__tests__/pyth.test.ts
git commit -m "feat(P1): add Pyth Network Hermes API client"
```

---

### Task 8: Populate pythFeedId for eligible stablecoins

**Files:**
- Modify: `shared/lib/stablecoins.ts` (add pythFeedId to ~15 coins)

- [ ] **Step 1: Research Pyth price feed IDs**

Use the Pyth price feed registry at `https://pyth.network/developers/price-feed-ids` to look up feed IDs for: USDT, USDC, DAI, FRAX, LUSD, USDD, GHO, PYUSD, crvUSD, USDe, USDS, EURC, TUSD, FDUSD, BUSD.

The implementer must verify each feed ID against the live Hermes API before committing.

- [ ] **Step 2: Add pythFeedId to stablecoin entries**

Example entries (feed IDs must be verified by the implementer):

```typescript
// In usdt-tether entry:
pythFeedId: "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",

// In usdc-circle entry:
pythFeedId: "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
```

- [ ] **Step 3: Build and type-check**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add shared/lib/stablecoins.ts
git commit -m "feat(P1): populate pythFeedId for 15 eligible stablecoins"
```

---

### Task 9: Integrate Pyth into primary price fetch

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts:128-291` (fetchPrimaryPrices)

- [ ] **Step 1: Add Pyth fetch to fetchPrimaryPrices**

In `worker/src/cron/enrich-prices.ts`, inside `fetchPrimaryPrices()`:

1. Import `fetchPythPrices` from `../lib/pyth`
2. Build a `Map<string, string>` of `stablecoinId → pythFeedId` from candidates that have a `pythFeedId`
3. Add Pyth fetch as a third parallel promise alongside CG and DL (inside the `fetches` array, guarded by `shouldAttemptFetch(db, CIRCUIT_SOURCE.PYTH_PRICES)`)
4. In the cross-validation loop (lines 238-276), convert from 2-source comparison to using `computePriceConsensus()` with all available sources

Key changes to the cross-validation loop:

```typescript
for (const asset of candidates) {
  const gId = asset.geckoId!;
  const sources: SourcePrice[] = [];

  const cg = cgPrices.get(gId);
  if (cg != null) sources.push({ source: "coingecko", price: cg, weight: 2 });

  const dl = dlPrices.get(gId);
  if (dl != null) sources.push({ source: "defillama", price: dl, weight: 1 });

  const pyth = pythPrices.get(asset.id);
  if (pyth != null) sources.push({ source: "pyth", price: pyth.price, weight: 2, metadata: { confidenceBps: pyth.confidenceBps } });

  stats.attempted++;

  const context = buildPriceValidationContext({
    stablecoinId: String(asset.id),
    pegType: asset.pegType,
    navToken: asset.navToken,
    commodityOunces: asset.commodityOunces,
  });
  const pegRef = context.navToken ? null : getReferencePriceForContext(context, references);
  const consensus = computePriceConsensus(sources, pegRef, DIVERGENCE_THRESHOLD_BPS);

  if (!consensus) continue; // no sources

  results.set(asset.id, {
    price: consensus.price,
    source: consensus.source,
    confidence: consensus.confidence,
    dlPrice: dl ?? null,
    cgPrice: cg ?? null,
  });

  // Update stats
  if (consensus.confidence === "high") stats.high++;
  else if (consensus.confidence === "single-source") stats.singleSource++;
  else stats.low++;
}
```

- [ ] **Step 2: Run existing tests to verify no regression**

Run: `npm test -- worker/src/cron/__tests__/enrich-prices.test.ts`
Expected: PASS (existing tests should still pass with consensus module)

- [ ] **Step 3: Add Pyth-specific test cases to enrich-prices tests**

Add test cases for:
- Pyth agrees with CG+DL → still "high"
- Pyth disagrees while CG+DL agree → "high" (majority wins)
- Only Pyth available (CG+DL both down) → "single-source"
- Pyth confidence interval widening logged

- [ ] **Step 4: Type-check and full test**

Run: `npm run build && cd worker && npx tsc --noEmit && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/enrich-prices.ts worker/src/cron/__tests__/enrich-prices.test.ts
git commit -m "feat(P1): integrate Pyth oracle prices into primary cross-validation"
```

---

## Chunk 4: P2 — Direct CEX Tickers (Binance + Coinbase)

### Task 10: Create CEX ticker client modules

**Files:**
- Create: `worker/src/lib/cex-tickers.ts`
- Create: `worker/src/lib/__tests__/cex-tickers.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `worker/src/lib/__tests__/cex-tickers.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchBinancePrices, fetchCoinbasePrices } from "../cex-tickers";

afterEach(() => vi.unstubAllGlobals());

describe("fetchBinancePrices", () => {
  it("returns stablecoin/USD prices from ticker endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { symbol: "USDTUSD", price: "0.9999" },
        { symbol: "USDCUSD", price: "1.0001" },
        { symbol: "BTCUSD", price: "65000" },
      ]),
    }));
    const results = await fetchBinancePrices();
    expect(results.get("USDT")).toBeCloseTo(0.9999, 4);
    expect(results.get("USDC")).toBeCloseTo(1.0001, 4);
    expect(results.has("BTC")).toBe(false); // not a stablecoin pair
  });

  it("returns empty map on failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const results = await fetchBinancePrices();
    expect(results.size).toBe(0);
  });
});

describe("fetchCoinbasePrices", () => {
  it("returns prices for listed stablecoin products", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.includes("/products/USDT-USD/ticker"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ price: "0.9998" }) });
      if (url.includes("/products/USDC-USD/ticker"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ price: "1.0000" }) });
      return Promise.resolve({ ok: false, status: 404 });
    }));
    const results = await fetchCoinbasePrices(["USDT", "USDC", "XYZFAKE"]);
    expect(results.get("USDT")).toBeCloseTo(0.9998, 4);
    expect(results.get("USDC")).toBeCloseTo(1.0, 4);
    expect(results.has("XYZFAKE")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- worker/src/lib/__tests__/cex-tickers.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement CEX ticker clients**

Create `worker/src/lib/cex-tickers.ts`:

```typescript
/**
 * Direct CEX ticker clients for Binance and Coinbase.
 * Both use free, unauthenticated public APIs.
 */

/**
 * Explicit mapping from Binance pair symbol to the stablecoin ticker.
 * This avoids broken string-replacement logic (e.g., "USDTUSD".replace("USD","") → "TUSD").
 */
const BINANCE_PAIR_TO_SYMBOL: Record<string, string> = {
  USDTUSD: "USDT", USDCUSD: "USDC", DAIUSD: "DAI",
  TUSDUSD: "TUSD", USDPUSD: "USDP", PYUSDUSD: "PYUSD",
  USDEUSD: "USDE", XAUTUSD: "XAUT", PAXGUSD: "PAXG",
  FDUSDUSD: "FDUSD",
};

/**
 * Fetch all ticker prices from Binance in a single call.
 * Returns Map<symbol, price> for stablecoin/USD pairs only.
 * API weight: 4 (trivial against 6,000/min budget).
 */
export async function fetchBinancePrices(
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  try {
    const res = await fetch(
      "https://data-api.binance.vision/api/v3/ticker/price",
      { signal, headers: { Accept: "application/json" } },
    );
    if (!res.ok) {
      console.warn(`[cex-binance] API returned ${res.status}`);
      return results;
    }
    const tickers = (await res.json()) as Array<{ symbol: string; price: string }>;
    for (const t of tickers) {
      const symbol = BINANCE_PAIR_TO_SYMBOL[t.symbol];
      if (symbol) {
        const price = parseFloat(t.price);
        if (price > 0) results.set(symbol, price);
      }
    }
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[cex-binance] Fetch failed:", err);
  }
  return results;
}

/**
 * Fetch individual ticker prices from Coinbase.
 * No auth required. 10 req/sec rate limit.
 *
 * IMPORTANT: Fetches sequentially to avoid exceeding the Workers 6-connection
 * limit. This runs inside fetchPrimaryPrices() which shares the pool with
 * CG, DL, Pyth, RedStone, and Binance fetches.
 *
 * @param symbols Array of symbols to fetch (e.g., ["USDT", "USDC", "DAI"])
 */
export async function fetchCoinbasePrices(
  symbols: string[],
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const results = new Map<string, number>();

  // Sequential fetch to respect Workers 6-connection limit.
  // ~15 symbols × ~100ms each = ~1.5s total — acceptable.
  for (const symbol of symbols) {
    try {
      const res = await fetch(
        `https://api.exchange.coinbase.com/products/${symbol}-USD/ticker`,
        { signal, headers: { Accept: "application/json" } },
      );
      if (!res.ok) continue; // Pair doesn't exist or error
      const body = await res.json();
      const data = body as { price?: string };
      if (data.price) {
        const price = parseFloat(data.price);
        if (price > 0) results.set(symbol, price);
      }
    } catch {
      // Individual pair failure — non-fatal
    }
  }

  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- worker/src/lib/__tests__/cex-tickers.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/cex-tickers.ts worker/src/lib/__tests__/cex-tickers.test.ts
git commit -m "feat(P2): add Binance and Coinbase direct ticker clients"
```

---

### Task 11: Integrate CEX tickers into primary price fetch

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts` (add CEX sources to consensus)

- [ ] **Step 1: Add CEX fetch to fetchPrimaryPrices**

In the `fetches` array inside `fetchPrimaryPrices()`, add Binance and Coinbase fetches (guarded by their circuit breakers). After the fetches complete, merge CEX prices into the per-asset `sources` array for `computePriceConsensus()`.

CEX prices are matched to stablecoins by symbol (e.g., Binance returns "USDT" → match to stablecoin with `symbol === "USDT"`).

Mapping approach: build a `Map<symbol, stablecoinId>` from candidates, then look up CEX results by symbol.

```typescript
// After Promise.all(fetches):
const symbolToId = new Map(candidates.map((a) => [a.symbol.toUpperCase(), a.id]));

// In the per-asset consensus loop, add CEX sources:
const binancePrice = binancePrices.get(asset.symbol.toUpperCase());
if (binancePrice != null) {
  sources.push({ source: "binance", price: binancePrice, weight: 2 });
}
const coinbasePrice = coinbasePrices.get(asset.symbol.toUpperCase());
if (coinbasePrice != null) {
  sources.push({ source: "coinbase", price: coinbasePrice, weight: 2 });
}
```

- [ ] **Step 2: Add tests for CEX integration**

Add test cases to `enrich-prices.test.ts`:
- CEX agrees with CG+DL → "high" with 4 sources
- CEX available when CG+DL both down → "single-source" or "high" (if 2 CEX agree)

- [ ] **Step 3: Type-check and test**

Run: `npm run build && cd worker && npx tsc --noEmit && npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/enrich-prices.ts worker/src/cron/__tests__/enrich-prices.test.ts
git commit -m "feat(P2): integrate Binance and Coinbase tickers into primary price consensus"
```

---

### Task 12: Add CEX as secondary source in depeg confirmation

**Files:**
- Modify: `worker/src/cron/confirm-pending-depegs.ts:134-181`

- [ ] **Step 1: Add CEX price check alongside CoinGecko/DL check**

In `confirmPendingDepegs()`, after the off-chain CG/DL check (lines 134-181), add a CEX check:

```typescript
// After offchainAgrees determination:
let cexAgrees: boolean | null = null;
const cexAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.BINANCE_PRICES);
if (cexAllowed) {
  try {
    const binancePrices = await fetchBinancePrices(signal);
    const cexPrice = binancePrices.get(row.symbol.toUpperCase());
    if (cexPrice && cexPrice > 0) {
      const cexBps = Math.abs(Math.round(((cexPrice / row.peg_reference) - 1) * 10000));
      cexAgrees = cexBps >= secondaryBar;
      console.log(`[depeg-confirm] ${row.symbol} CEX check: price=$${cexPrice}, deviation=${cexBps}bps, agrees=${cexAgrees}`);
    }
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
  }
}

// Updated decision matrix: promote if ANY secondary confirms
if (offchainAgrees === true || dexAgrees === true || cexAgrees === true) {
  // ... promote (existing logic)
}
```

- [ ] **Step 2: Test and commit**

Run: `npm test && cd worker && npx tsc --noEmit`

```bash
git add worker/src/cron/confirm-pending-depegs.ts
git commit -m "feat(P2): add CEX ticker as secondary source in depeg confirmation"
```

---

## Chunk 5: P3 — RedStone Venue Breakdown + P4 — DEX Price Promotion

### Task 13: Create RedStone client module

**Files:**
- Create: `worker/src/lib/redstone.ts`
- Create: `worker/src/lib/__tests__/redstone.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `worker/src/lib/__tests__/redstone.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchRedstonePrices, type RedstoneResult } from "../redstone";

afterEach(() => vi.unstubAllGlobals());

describe("fetchRedstonePrices", () => {
  it("returns price and venue breakdown", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        USDT: [{
          value: 0.9998,
          source: { binance: 0.9999, coinbase: 0.9997, curve: 0.9998 },
          timestamp: 1710000000000,
        }],
      }),
    }));
    const results = await fetchRedstonePrices(["USDT"]);
    expect(results.size).toBe(1);
    const r = results.get("USDT")!;
    expect(r.price).toBeCloseTo(0.9998, 4);
    expect(r.venues.size).toBeGreaterThanOrEqual(3);
    expect(r.venueAgreementPct).toBeGreaterThan(0);
  });

  it("computes venue agreement percentage correctly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        USDT: [{
          value: 0.97,
          source: {
            binance: 0.97, coinbase: 0.97, kraken: 0.97,
            curve: 1.00, uniswap: 1.00,
          },
          timestamp: Date.now(),
        }],
      }),
    }));
    const results = await fetchRedstonePrices(["USDT"]);
    const r = results.get("USDT")!;
    // 3 out of 5 venues show depeg → 60% venue agreement
    expect(r.venueAgreementPct).toBeCloseTo(60, 0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- worker/src/lib/__tests__/redstone.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement RedStone client**

Create `worker/src/lib/redstone.ts`:

```typescript
export interface RedstoneResult {
  price: number;
  venues: Map<string, number>;    // venue name → price
  venueCount: number;
  venueAgreementPct: number;      // % of venues within 50bps of median
  timestamp: number;
}

/**
 * Fetch prices from RedStone API with per-venue breakdown.
 * Free API, no auth, undocumented rate limits.
 */
export async function fetchRedstonePrices(
  symbols: string[],
  signal?: AbortSignal,
): Promise<Map<string, RedstoneResult>> {
  const results = new Map<string, RedstoneResult>();
  if (symbols.length === 0) return results;

  try {
    const symbolsParam = symbols.join(",");
    const res = await fetch(
      `https://api.redstone.finance/prices?symbols=${symbolsParam}&provider=redstone-primary-prod`,
      { signal, headers: { Accept: "application/json" } },
    );
    if (!res.ok) {
      console.warn(`[redstone] API returned ${res.status}`);
      return results;
    }

    const data = (await res.json()) as Record<string, Array<{
      value: number;
      source?: Record<string, number>;
      timestamp?: number;
    }>>;

    for (const [symbol, entries] of Object.entries(data)) {
      if (!entries || entries.length === 0) continue;
      const entry = entries[0];
      if (!entry.value || entry.value <= 0) continue;

      const venues = new Map<string, number>();
      if (entry.source) {
        for (const [venue, price] of Object.entries(entry.source)) {
          if (typeof price === "number" && price > 0) {
            venues.set(venue, price);
          }
        }
      }

      // Compute venue agreement: % of venues within 50bps of the aggregated price
      let agreeCount = 0;
      for (const venuePrice of venues.values()) {
        const bps = Math.abs(((venuePrice / entry.value) - 1) * 10000);
        if (bps <= 50) agreeCount++;
      }
      const venueAgreementPct = venues.size > 0
        ? Math.round((agreeCount / venues.size) * 100)
        : 100;

      results.set(symbol, {
        price: entry.value,
        venues,
        venueCount: venues.size,
        venueAgreementPct,
        timestamp: entry.timestamp ? Math.floor(entry.timestamp / 1000) : Math.floor(Date.now() / 1000),
      });
    }
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[redstone] Fetch failed:", err);
  }

  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- worker/src/lib/__tests__/redstone.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/redstone.ts worker/src/lib/__tests__/redstone.test.ts
git commit -m "feat(P3): add RedStone Oracle API client with venue breakdown"
```

---

### Task 14: Integrate RedStone into primary price fetch

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts` (add RedStone to consensus)

- [ ] **Step 1: Add RedStone fetch to fetchPrimaryPrices**

Add RedStone as another parallel fetch source. Map stablecoin symbols to RedStone results, then add to per-asset `sources` array for consensus.

```typescript
// In the per-asset consensus loop:
const redstoneResult = redstonePrices.get(asset.symbol.toUpperCase());
if (redstoneResult != null) {
  sources.push({
    source: "redstone",
    price: redstoneResult.price,
    weight: 1,
    metadata: {
      venueCount: redstoneResult.venueCount,
      venueAgreementPct: redstoneResult.venueAgreementPct,
    },
  });
}
```

- [ ] **Step 2: Test and type-check**

Run: `npm run build && cd worker && npx tsc --noEmit && npm test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/enrich-prices.ts
git commit -m "feat(P3): integrate RedStone venue prices into primary consensus"
```

---

### Task 15: Promote DEX prices into primary pipeline (P4)

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts:128-291` (read dex_prices in fetchPrimaryPrices)
- Modify: `worker/src/cron/sync-stablecoins.ts` (pass db to fetchPrimaryPrices for DEX read)

- [ ] **Step 1: Read DEX prices in fetchPrimaryPrices**

At the start of `fetchPrimaryPrices()`, load trusted DEX price observations:

```typescript
import { loadDexPriceRows, isTrustedDexPriceRow } from "../lib/depeg-helpers";

// Inside fetchPrimaryPrices():
const nowSec = Math.floor(Date.now() / 1000);
const dexRows = await loadDexPriceRows(db);
```

In the per-asset consensus loop, add DEX as a source when trusted:

```typescript
const dexRow = dexRows.get(asset.id);
if (dexRow && isTrustedDexPriceRow(dexRow, nowSec, "depeg")) {
  sources.push({
    source: "dex-promoted",
    price: dexRow.dex_price_usd,
    weight: 1, // Lower weight than CG/Pyth/CEX — it's already a median of medians
    metadata: { poolCount: dexRow.source_pool_count, tvl: dexRow.source_total_tvl },
  });
}
```

- [ ] **Step 2: Add test case for DEX promotion**

```typescript
it("includes trusted DEX price in consensus when fresh and high-TVL", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  // Mock D1 to return a trusted dex_prices row
  const mockDb = {
    prepare: vi.fn().mockReturnValue({
      all: vi.fn().mockResolvedValue({
        results: [{
          stablecoin_id: "usdt-tether",
          dex_price_usd: 0.998,
          source_pool_count: 5,
          source_total_tvl: 2_000_000,
          updated_at: nowSec - 300, // 5 min ago, within depeg freshness (1200s)
        }],
      }),
    }),
  };
  // ... run fetchPrimaryPrices with mockDb
  // Verify "dex-promoted" appears in consensus sources
  // Verify the DEX price is included alongside CG/DL
});
```

- [ ] **Step 3: Test and type-check**

Run: `npm run build && cd worker && npx tsc --noEmit && npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/enrich-prices.ts worker/src/cron/__tests__/enrich-prices.test.ts
git commit -m "feat(P4): promote trusted DEX prices into primary price consensus"
```

---

## Chunk 6: P5 — Curve On-Chain Pricing + P6 — Expanded Protocol Quotes

### Task 16: Create Curve on-chain price module

**Files:**
- Create: `worker/src/lib/curve-onchain.ts`
- Create: `worker/src/lib/__tests__/curve-onchain.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `worker/src/lib/__tests__/curve-onchain.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchCurveOnchainPrices, type CurvePoolConfig } from "../curve-onchain";

// Mock the evm-rpc module's fetchEvmCallHexAtBlock
vi.mock("../evm-rpc", () => ({
  fetchEvmCallHexAtBlock: vi.fn(),
}));
import { fetchEvmCallHexAtBlock } from "../evm-rpc";
const mockEvmCall = vi.mocked(fetchEvmCallHexAtBlock);

afterEach(() => vi.clearAllMocks());

describe("fetchCurveOnchainPrices", () => {
  it("parses get_dy response into implied price", async () => {
    // get_dy(1, 2, 1e6) returns 999000 for USDT (6 decimals out)
    // Implied price = 999000 / 1e6 = 0.999
    const mockHexResponse = "0x" + BigInt(999000).toString(16).padStart(64, "0");
    mockEvmCall.mockResolvedValue(mockHexResponse);

    const config: CurvePoolConfig = {
      stablecoinId: "usdt-tether",
      poolAddress: "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7",
      inputIndex: 1,
      outputIndex: 2,
      inputDecimals: 6,
      outputDecimals: 6,
      chain: "ethereum",
    };
    const results = await fetchCurveOnchainPrices([config]);
    expect(results.size).toBe(1);
    expect(results.get("usdt-tether")).toBeCloseTo(0.999, 3);
    expect(mockEvmCall).toHaveBeenCalledWith(
      "ethereum", config.poolAddress, expect.any(String), "latest", expect.any(Object),
    );
  });

  it("returns empty map when RPC returns null", async () => {
    mockEvmCall.mockResolvedValue(null);
    const config: CurvePoolConfig = {
      stablecoinId: "usdt-tether",
      poolAddress: "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7",
      inputIndex: 1, outputIndex: 2,
      inputDecimals: 6, outputDecimals: 6,
      chain: "ethereum",
    };
    const results = await fetchCurveOnchainPrices([config]);
    expect(results.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- worker/src/lib/__tests__/curve-onchain.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement Curve on-chain module**

Create `worker/src/lib/curve-onchain.ts`:

```typescript
/**
 * Fetch stablecoin prices via Curve StableSwap get_dy() on-chain calls.
 *
 * get_dy(i, j, dx) simulates swapping dx of token i for token j,
 * returning the output amount. The ratio output/input gives implied price.
 *
 * Curve StableSwap amplification factor (A=500-5000) makes manipulation
 * extremely expensive — these prices are among the most reliable on-chain signals.
 *
 * Uses the existing `fetchEvmCallHexAtBlock()` from `evm-rpc.ts` which handles
 * chain registry resolution and fallback RPCs (requires ALCHEMY_API_KEY in env).
 */

import { fetchEvmCallHexAtBlock } from "./evm-rpc";

export interface CurvePoolConfig {
  stablecoinId: string;
  poolAddress: string;
  inputIndex: number;    // coin index of the reference asset (e.g., USDC=1 in 3pool)
  outputIndex: number;   // coin index of the target stablecoin
  inputDecimals: number;
  outputDecimals: number;
  chain: string;
}

// get_dy(int128,int128,uint256) selector
const GET_DY_SELECTOR = "0x5e0d443f";

/**
 * Fetch implied prices via Curve get_dy for a batch of pool configurations.
 * Uses fetchEvmCallHexAtBlock which resolves RPC URLs via chain-registry.ts.
 */
export async function fetchCurveOnchainPrices(
  configs: CurvePoolConfig[],
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const results = new Map<string, number>();

  for (const config of configs) {
    try {
      const inputAmount = BigInt(10) ** BigInt(config.inputDecimals); // 1 unit
      const calldata = encodeGetDy(config.inputIndex, config.outputIndex, inputAmount);

      const resultHex = await fetchEvmCallHexAtBlock(
        config.chain, config.poolAddress, calldata, "latest", { signal },
      );
      if (!resultHex) continue;

      const outputRaw = BigInt(resultHex);
      const outputFloat = Number(outputRaw) / Math.pow(10, config.outputDecimals);
      const inputFloat = Number(inputAmount) / Math.pow(10, config.inputDecimals);
      const impliedPrice = outputFloat / inputFloat;

      if (impliedPrice > 0 && impliedPrice < 100) {
        results.set(config.stablecoinId, impliedPrice);
      }
    } catch (err) {
      if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
      console.warn(`[curve-onchain] get_dy failed for ${config.stablecoinId}:`, err);
    }
  }

  return results;
}

function encodeGetDy(i: number, j: number, dx: bigint): string {
  const iHex = BigInt(i).toString(16).padStart(64, "0");
  const jHex = BigInt(j).toString(16).padStart(64, "0");
  const dxHex = dx.toString(16).padStart(64, "0");
  return `${GET_DY_SELECTOR}${iHex}${jHex}${dxHex}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- worker/src/lib/__tests__/curve-onchain.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/curve-onchain.ts worker/src/lib/__tests__/curve-onchain.test.ts
git commit -m "feat(P5): add Curve on-chain get_dy price module"
```

---

### Task 17: Define Curve pool configs and integrate

**Files:**
- Create: `worker/src/lib/curve-pool-configs.ts`
- Modify: `worker/src/cron/enrich-prices.ts` (add Curve on-chain to consensus)

- [ ] **Step 1: Create Curve pool config registry**

Create `worker/src/lib/curve-pool-configs.ts`:

```typescript
import type { CurvePoolConfig } from "./curve-onchain";

/**
 * Curve pool configurations for on-chain price queries.
 *
 * Each config defines:
 * - Which pool to query
 * - Token indices (i=reference USDC/DAI, j=target stablecoin)
 * - Decimal precision for input/output normalization
 *
 * Pools should have >$1M TVL for meaningful prices.
 * 3pool indices: 0=DAI(18), 1=USDC(6), 2=USDT(6)
 */
export const CURVE_POOL_CONFIGS: CurvePoolConfig[] = [
  // 3pool: query USDT relative to USDC
  {
    stablecoinId: "usdt-tether",
    poolAddress: "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7",
    inputIndex: 1,  // USDC
    outputIndex: 2, // USDT
    inputDecimals: 6,
    outputDecimals: 6,
    chain: "ethereum",
  },
  // 3pool: query DAI relative to USDC
  {
    stablecoinId: "dai-maker",
    poolAddress: "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7",
    inputIndex: 1,  // USDC
    outputIndex: 0, // DAI
    inputDecimals: 6,
    outputDecimals: 18,
    chain: "ethereum",
  },
  // Implementer: add more pools after verifying on-chain indices.
  // Candidates: FRAX/USDC, LUSD/USDC, crvUSD/USDC, GHO/USDC
];
```

- [ ] **Step 2: Integrate into primary price fetch**

In `fetchPrimaryPrices()`, add Curve on-chain fetch (guarded by circuit breaker and RPC URL availability):

The RPC URL is resolved via the existing `chain-registry.ts` pattern. The env var is `ALCHEMY_API_KEY` (not `ALCHEMY_RPC_URL`). The Alchemy RPC URL for Ethereum is constructed as `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`.

However, `fetchCurveOnchainPrices` doesn't need direct RPC URL construction — it should use the existing `fetchEvmCallHexAtBlock()` from `evm-rpc.ts`, which already handles chain registry resolution and fallback RPCs. Refactor `fetchCurveOnchainPrices` to use it:

```typescript
import { fetchEvmCallHexAtBlock } from "../lib/evm-rpc";

// Inside fetchCurveOnchainPrices, replace the raw fetch() with:
const resultHex = await fetchEvmCallHexAtBlock(
  config.chain, config.poolAddress, calldata, "latest", { signal },
);
if (!resultHex) continue;
const outputRaw = BigInt(resultHex);
```

This eliminates the need for an explicit `rpcUrl` parameter entirely. The function signature simplifies to:

```typescript
export async function fetchCurveOnchainPrices(
  configs: CurvePoolConfig[],
  signal?: AbortSignal,
): Promise<Map<string, number>>
```

Integration in `fetchPrimaryPrices()`:

```typescript
const curveAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.CURVE_ONCHAIN);
if (curveAllowed) {
  const curvePrices = await fetchCurveOnchainPrices(CURVE_POOL_CONFIGS, signal);
  // In per-asset loop:
  const curvePrice = curvePrices.get(asset.id);
  if (curvePrice != null) {
    sources.push({ source: "curve-onchain", price: curvePrice, weight: 3 });
    // High weight: Curve StableSwap is manipulation-resistant
  }
}
```

**Note:** The `chain-registry.ts` module requires `ALCHEMY_API_KEY` to be set in the Worker env (already configured). No new env vars needed for Curve on-chain.

- [ ] **Step 3: Test and type-check**

Run: `npm run build && cd worker && npx tsc --noEmit && npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/curve-pool-configs.ts worker/src/cron/enrich-prices.ts
git commit -m "feat(P5): integrate Curve on-chain prices into primary consensus"
```

---

### Task 18: Expand protocol redemption quotes (P6)

**Files:**
- Modify: `worker/src/lib/authoritative-price-sources.ts` (add crvUSD and LUSD providers)

- [ ] **Step 1: Research contract ABIs**

The implementer must verify these contract functions on-chain before coding:

**crvUSD:** The `price_oracle()` function on the crvUSD Controller contract returns the internal oracle price. Contract address and ABI must be verified against the Curve docs.

**LUSD:** The Liquity PriceFeed contract at `0x4c517D4e2C851CA76d7eC94B805269Df0f2201De` has a `fetchPrice()` function that returns the latest ETH/USD price used by the protocol. The LUSD price itself can be derived from the `TroveManager.getRedemptionRate()`.

- [ ] **Step 2: Add crvUSD provider**

Follow the existing `capCusdProvider` pattern in `authoritative-price-sources.ts`. Create a new `PriceSourceProvider`:

```typescript
// crvUSD PriceAggregator contract on Ethereum mainnet
const CRVUSD_PRICE_AGGREGATOR = "0xe5Afcf332a5457E8FafCD668BcE3dF953762Dfe7";
// price() selector = keccak256("price()")[0:4] — returns crvUSD price in USD scaled by 1e18
const CRVUSD_PRICE_SELECTOR = "0xa035b1fe";

const crvUsdPriceOracleProvider: PriceSourceProvider = {
  source: "protocol-redeem",
  matches: (id) => id === "crvusd-curve",
  async fetchLivePrice(asset, signal) {
    const hex = await fetchEvmCallHexAtBlock(
      ETHEREUM_CHAIN,
      CRVUSD_PRICE_AGGREGATOR,
      CRVUSD_PRICE_SELECTOR,
      "latest",
      { signal, extraRpcUrls: ETHEREUM_ARCHIVE_FALLBACK_URLS },
    );
    if (!hex) return null;
    const rawPrice = BigInt(hex);
    const price = Number(rawPrice) / 1e18;
    if (price <= 0 || price > 10) return null;
    return { price, source: "protocol-redeem" as const, confidence: "high" as PriceConfidence };
  },
};
```

**Note:** The implementer must verify the correct contract address and function selector on-chain before committing. The `PriceAggregator` contract address above is from the Curve docs but should be verified against Etherscan. Verify the `price()` selector with `cast sig "price()"` (expected: `0xa035b1fe`) or Etherscan's Read Contract tab.

- [ ] **Step 3: Add to AUTHORITATIVE_PRICE_PROVIDERS array**

```typescript
const AUTHORITATIVE_PRICE_PROVIDERS: PriceSourceProvider[] = [
  capCusdProvider,
  iusdInfinifiProvider,
  crvUsdPriceOracleProvider,  // NEW
];
```

- [ ] **Step 4: Test with mock RPC response**

Add tests to verify the new provider returns valid prices from mock RPC responses.

- [ ] **Step 5: Type-check and test**

Run: `npm run build && cd worker && npx tsc --noEmit && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add worker/src/lib/authoritative-price-sources.ts
git commit -m "feat(P6): add crvUSD price_oracle() as authoritative price source"
```

---

## Chunk 7: P7 — CMC Optimization + Documentation

### Task 19: Optimize CoinMarketCap to batch endpoint (P7)

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts:455-551` (CMC pass)

- [ ] **Step 1: Replace per-slug with listings endpoint**

In `enrichMissingPrices()`, replace Pass 2 (lines 455-551) with:

```typescript
// Pass 2: CoinMarketCap listings (batch — covers all CMC-listed stablecoins)
if (cmcApiKey && cmcAllowed && missingAfterPass1b.length > 0) {
  try {
    const res = await fetch(
      "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?cryptocurrency_type=stablecoins&limit=200&convert=USD",
      {
        headers: { "X-CMC_PRO_API_KEY": cmcApiKey, Accept: "application/json" },
        signal,
      },
    );
    if (res.ok) {
      const data = (await res.json()) as {
        data: Array<{ symbol: string; quote: { USD: { price: number } } }>;
      };
      const cmcBySymbol = new Map(
        data.data.map((d) => [d.symbol.toUpperCase(), d.quote.USD.price]),
      );
      for (const asset of missingAfterPass1b) {
        const cmcPrice = cmcBySymbol.get(asset.symbol.toUpperCase());
        if (cmcPrice && cmcPrice > 0 && isReasonablePrice(asset, cmcPrice)) {
          applyResolvedPrice(asset, cmcPrice, "coinmarketcap", "fallback");
          enrichStats.passCmc++;
        }
      }
      await recordOutcome(db, CIRCUIT_SOURCE.CMC_PRICES, true);
    } else {
      await recordOutcome(db, CIRCUIT_SOURCE.CMC_PRICES, false);
    }
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    await recordOutcome(db, CIRCUIT_SOURCE.CMC_PRICES, false);
  }
}
```

This eliminates the need for per-asset `cmcSlug` configuration — all CMC-listed stablecoins are covered in one call.

**Keep the 1-call/hour rate limit** via the existing `lastCmcFetchKey` check to stay within free tier budget.

- [ ] **Step 2: Test the new batch path**

Update `enrichMissingPrices` tests to mock the `listings/latest` endpoint instead of `quotes/latest`.

- [ ] **Step 3: Type-check and test**

Run: `npm run build && cd worker && npx tsc --noEmit && npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/enrich-prices.ts worker/src/cron/__tests__/enrich-prices.test.ts
git commit -m "feat(P7): optimize CMC enrichment to batch listings endpoint"
```

---

### Task 20: Update documentation

**Files:**
- Modify: `docs/data-pipeline.md`
- Modify: `docs/depeg-detection.md`
- Modify: `docs/worker-infrastructure.md`
- Modify: `docs/data-flow-map.md`
- Modify: `docs/about-page.md`
- Modify: `docs/coverage-page.md`
- Modify: `src/app/about/page.tsx` (add new data sources to the source list per CLAUDE.md rule)

- [ ] **Step 1: Update data-pipeline.md**

Add sections for:
- New price sources (Pyth, Binance, Coinbase, RedStone, Curve on-chain)
- N-source consensus algorithm replacing 2-source cross-validation
- Real-time FX rate upgrade
- CMC batch optimization

- [ ] **Step 2: Update depeg-detection.md**

Document:
- CEX ticker as additional secondary source in confirmation
- Pyth confidence interval as stress indicator
- RedStone venue agreement as diagnostic signal

- [ ] **Step 3: Update worker-infrastructure.md**

Document:
- New circuit breaker sources
- New env vars (OPENEXCHANGERATES_API_KEY)
- Updated cron budget impact

- [ ] **Step 4: Update data-flow-map.md**

Add the new sources to the end-to-end flow diagram.

- [ ] **Step 5: Update about-page.md, coverage-page.md, and about page source**

Add new data sources (Pyth Network, Binance, Coinbase, RedStone, Curve on-chain, Open Exchange Rates) to the about page documentation, coverage matrix, and the actual about page component at `src/app/about/page.tsx`.

- [ ] **Step 6: Commit**

```bash
git add docs/ src/app/about/
git commit -m "docs: update pipeline, depeg, and infrastructure docs for P0-P7 improvements"
```

---

### Task 21: Update methodology page

**Files:**
- Modify: `src/app/methodology/page.tsx` (or relevant section file)

- [ ] **Step 1: Update pricing methodology section**

Add documentation about:
- Multi-source consensus (N sources, weighted, cluster-based agreement)
- Source hierarchy and weights
- Pyth confidence intervals as stress indicator
- Real-time FX for non-USD pegs

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/app/methodology/
git commit -m "docs: update methodology page with multi-source pricing methodology"
```

---

### Task 22: Final integration test and status dashboard verification

**Files:**
- Modify: `src/components/status/price-source-health.tsx` (if not already done in Task 3)

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 2: Run full build**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: PASS (or only pre-existing warnings)

- [ ] **Step 4: Verify status dashboard renders new sources**

Start dev server (`npm run dev`) and verify the `/status` page displays the new source distribution categories (pyth, binance, coinbase, redstone, curve-onchain, dex-promoted).

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "chore: final integration fixes for pricing pipeline improvements"
```

---

## Implementation Notes

### Env Vars to Configure

| Variable | Required By | Free Tier? |
|----------|------------|-----------|
| `OPENEXCHANGERATES_API_KEY` | P0 (FX rates) | Free tier (1K/mo) works at hourly polling (~720/mo). Basic plan ($12/mo) allows 15-min polling if needed |
| `COINGECKO_API_KEY` | Existing | Already configured |
| `CMC_API_KEY` | P7 (batch CMC) | Already configured |

No new env vars needed for Pyth, Binance, Coinbase, RedStone, or Curve on-chain — all use free, unauthenticated public APIs.

**Deployment prerequisite:** Before deploying P0, provision the API key:
```bash
wrangler secret put OPENEXCHANGERATES_API_KEY
```
Note: `wrangler secret put` creates a new version and auto-deploys immediately.

### Cron Budget Impact

All new fetches piggyback on the existing quarter-hourly slot (slot 1) inside `syncStablecoins()`. No new cron triggers needed. Estimated additional time per run:

| Source | Calls per Run | Est. Latency |
|--------|--------------|-------------|
| Pyth Hermes | 1 | ~200ms |
| Binance ticker | 1 | ~150ms |
| Coinbase tickers | ~15 | ~1.5s (sequential, Workers 6-conn limit) |
| RedStone | 1 | ~300ms |
| Curve get_dy RPC | ~5 | ~1s (sequential) |
| FX real-time | 1 | ~300ms |

**Total overhead: ~3.5s** — well within the 8-minute sync-stablecoins timeout.

### Worker 6-Connection Limit

All new fetches use standard `fetch()`. The existing sequential execution pattern in `fetchPrimaryPrices()` (parallel CG + DL, then sequential enrichment) ensures we don't exceed the 6-connection limit. New sources are added to the parallel primary fetch block, which already awaits `Promise.all()` before proceeding.

### Rollback Strategy

Each improvement (P0–P7) is independently deployable behind its circuit breaker. If a source causes issues:
1. The circuit breaker auto-opens after 3 failures
2. Manual disable: set `CIRCUIT_SOURCE.X` to permanently open via a one-line code change
3. Full rollback: revert the specific commit for that improvement

### Dependencies Between Improvements

```
P0 (FX rates) → independent
P1 (Pyth)     → depends on Task 1 (pythFeedId field), Task 4 (consensus module)
P2 (CEX)      → depends on Task 4 (consensus module)
P3 (RedStone) → depends on Task 4 (consensus module)
P4 (DEX promo) → depends on Task 4 (consensus module)
P5 (Curve)    → depends on Task 4 (consensus module)
P6 (Protocol) → independent (extends existing pattern)
P7 (CMC)      → independent (modifies existing enrichment)
```

**Recommended execution order:** Chunk 1 → Chunk 2 → Chunk 3 → Chunk 4 → Chunk 5 → Chunk 6 → Chunk 7
