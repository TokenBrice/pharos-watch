# Pricing Pipeline Audit Remediation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate all 14 findings from the 2026-03-17 pricing pipeline audit (3 bugs, 5 design issues, 6 improvements) plus test gaps.

**Architecture:** Surgical changes to the existing v2.1 pricing pipeline. No new files — all modifications target existing modules. Changes are ordered by dependency: consensus-layer improvements first (source weights), then pool challenge fixes, then depeg confirmation, then observability/UI.

**Tech Stack:** TypeScript, Vitest, Cloudflare Workers D1

**Audit document:** `agents/audits/pricing-pipeline-audit-2026-03-17.md`

---

## File Map

| File | Changes |
|------|---------|
| `worker/src/cron/enrich-prices.ts` | BUG-2 peg-type-aware pool challenge threshold; IMPROVE-1 Pyth confidence gating; IMPROVE-2 RedStone venue agreement gating; DESIGN-4 CG+DL-only downgrade; DESIGN-1/IMPROVE-3 softOnly flag; DESIGN-2 DL coverage logging; IMPROVE-4 disagree logging |
| `worker/src/cron/confirm-pending-depegs.ts` | BUG-1 add pool-level fourth confirmation source |
| `worker/src/lib/constants.ts` | Extract `POOL_CHALLENGE_MIN_TVL` constant for reuse |
| `worker/src/lib/cex-tickers.ts` | IMPROVE-5 expand Coinbase coverage |
| `worker/src/api/peg-summary.ts` | BUG-3 include navToken coins with null deviation |
| `worker/src/lib/price-consensus.ts` | IMPROVE-6 full source label |
| `worker/src/cron/sync-stablecoins.ts` | DESIGN-3 protocol override divergence warning |
| `shared/lib/pricing-pipeline-version.ts` | Bump to v2.2 with changelog entry |
| `worker/src/cron/__tests__/confirm-pending-depegs.test.ts` | BUG-1 pool challenger confirmation tests |
| `worker/src/cron/__tests__/enrich-prices.test.ts` | BUG-2, IMPROVE-1, IMPROVE-2, DESIGN-4 pool challenge tests |
| `worker/src/lib/__tests__/price-consensus.test.ts` | IMPROVE-6 source label tests |
| `worker/src/api/__tests__/peg-summary.test.ts` | BUG-3 navToken inclusion test |

---

## Task 1: BUG-1 — Add pool-level prices as a fourth depeg confirmation source

This is the critical fix. Currently, pool-challenge-driven depegs (like dUSD at -510 bps) are always rejected because confirmation checks the same misleading aggregator sources. Adding individual pool prices as a confirmation source allows pool evidence to promote genuine depegs.

**Files:**
- Modify: `worker/src/lib/constants.ts` (extract `POOL_CHALLENGE_MIN_TVL`)
- Modify: `worker/src/cron/enrich-prices.ts:413` (use imported constant)
- Modify: `worker/src/cron/confirm-pending-depegs.ts:17-22` (add import), `:75` (load pool challengers), `:186-198` (add poolAgrees check), `:221` (add to promotion condition), `:265` (add to rejection condition)
- Test: `worker/src/cron/__tests__/confirm-pending-depegs.test.ts`

- [ ] **Step 1: Extract POOL_CHALLENGE_MIN_TVL to constants.ts**

In `worker/src/lib/constants.ts`, add:

```typescript
export const POOL_CHALLENGE_MIN_TVL = 100_000; // $100K minimum pool TVL
```

In `worker/src/cron/enrich-prices.ts:413`, replace the local constant with the import. Remove the local `const POOL_CHALLENGE_MIN_TVL = 100_000;` line and add `POOL_CHALLENGE_MIN_TVL` to the imports from `"../lib/constants"`.

- [ ] **Step 2: Write failing test — pool challenger promotes pending depeg**

In `worker/src/cron/__tests__/confirm-pending-depegs.test.ts`, first update `makeDb` to support `price_sources_json` in dex rows. Add `price_sources_json?: string` to the dexRows type in the `makeDb` config parameter.

Then add this test:

```typescript
it("promotes a pending depeg when individual pool prices confirm the deviation", async () => {
  const nowSec = 1_700_000_000;
  vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
  vi.spyOn(console, "log").mockImplementation(() => {});

  // CoinGecko returns ~$1 (disagrees with depeg)
  vi.mocked(fetchWithRetry).mockImplementation(async (url: string) => {
    if (url.includes("dusd")) {
      return new Response(JSON.stringify({ "dusd-trinity": { usd: 1.0 } }), { status: 200 });
    }
    return null;
  });

  await confirmPendingDepegs(
    makeDb({
      pendingRows: [
        makePendingRow({
          id: 40,
          stablecoin_id: "dusd-trinity",
          symbol: "dUSD",
          peg_type: "peggedUSD",
          first_seen_bps: -510,
          first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
          first_price: 0.949,
          peg_reference: 1,
        }),
      ],
      // DEX aggregate shows ~$1 (misleading)
      dexRows: [
        {
          stablecoin_id: "dusd-trinity",
          dex_price_usd: 0.9988,
          updated_at: nowSec - 30,
          source_pool_count: 3,
          source_total_tvl: 3_290_000,
          // Individual pools show real depeg via price_sources_json
          price_sources_json: JSON.stringify([
            { price: 0.80, tvl: 500_000, protocol: "curve", chain: "ethereum" },
            { price: 0.95, tvl: 200_000, protocol: "uniswap", chain: "ethereum" },
            { price: 1.00, tvl: 50_000, protocol: "balancer", chain: "ethereum" },
          ]),
        },
      ],
    }),
    [
      makeAsset({
        id: "dusd-trinity",
        name: "dUSD",
        symbol: "dUSD",
        geckoId: "dusd-trinity",
        price: 0.949,
        priceSource: "pool-tvl-weighted",
        priceConfidence: "low",
      }),
      ...makeNeutralUsdAssets(),
    ],
  );

  expect(batchExecute).toHaveBeenCalledTimes(1);
  const [, statements] = vi.mocked(batchExecute).mock.calls[0]!;
  const prepared = statements as PreparedStatementWithMeta[];
  const inserts = prepared.filter((stmt) => stmt.sql.startsWith("INSERT INTO depeg_events"));
  expect(inserts).toHaveLength(1);
  expect(inserts[0]?.boundValues?.[0]).toBe("dusd-trinity");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd worker && npx vitest run src/cron/__tests__/confirm-pending-depegs.test.ts --reporter=verbose`
Expected: FAIL — `poolAgrees` doesn't exist yet, pending depeg is rejected.

- [ ] **Step 4: Write failing test — pool challenger does NOT fire when pools don't diverge**

```typescript
it("does not promote when individual pool prices do not confirm the deviation", async () => {
  const nowSec = 1_700_000_000;
  vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
  vi.spyOn(console, "log").mockImplementation(() => {});

  // CoinGecko disagrees
  vi.mocked(fetchWithRetry).mockImplementation(async (url: string) => {
    if (url.includes("tether")) {
      return new Response(JSON.stringify({ tether: { usd: 1.0 } }), { status: 200 });
    }
    return null;
  });

  await confirmPendingDepegs(
    makeDb({
      pendingRows: [
        makePendingRow({
          id: 41,
          stablecoin_id: "usdt-tether",
          symbol: "USDT",
          peg_type: "peggedUSD",
          first_seen_bps: -200,
          first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
          first_price: 0.98,
          peg_reference: 1,
        }),
      ],
      dexRows: [
        {
          stablecoin_id: "usdt-tether",
          dex_price_usd: 1.0,
          updated_at: nowSec - 30,
          source_pool_count: 5,
          source_total_tvl: 50_000_000,
          // All pools near peg — should NOT confirm
          price_sources_json: JSON.stringify([
            { price: 1.001, tvl: 20_000_000, protocol: "uniswap", chain: "ethereum" },
            { price: 0.999, tvl: 15_000_000, protocol: "curve", chain: "ethereum" },
          ]),
        },
      ],
    }),
    [
      makeAsset({ id: "usdt-tether", symbol: "USDT", geckoId: "tether", price: 0.98 }),
      ...makeNeutralUsdAssets(),
    ],
  );

  // Off-chain (CG $1) disagrees, DEX aggregate ($1) disagrees, pools near peg
  // → rejected as false positive
  expect(batchExecute).toHaveBeenCalledTimes(1);
  const [, statements] = vi.mocked(batchExecute).mock.calls[0]!;
  const prepared = statements as PreparedStatementWithMeta[];
  const inserts = prepared.filter((stmt) => stmt.sql.startsWith("INSERT INTO depeg_events"));
  expect(inserts).toHaveLength(0);
});
```

- [ ] **Step 5: Implement pool-level confirmation in confirm-pending-depegs.ts**

Add `loadDexPoolChallengers` to the import from `"../lib/depeg-helpers"`:

```typescript
import {
  buildInsertDepegEventStmt,
  classifyPrimaryDepegTrust,
  isTrustedDexPriceRow,
  loadDexPriceRows,
  loadDexPoolChallengers,
} from "../lib/depeg-helpers";
```

Add `DEX_FRESHNESS_SEC` and `POOL_CHALLENGE_MIN_TVL` to the **existing** constants import (line 1-9). Do NOT duplicate existing imports — just add the two new names to the existing import block:

```typescript
import {
  getDepegThresholdBps,
  DEPEG_PENDING_MIN_AGE_SEC,
  DEPEG_PENDING_EXPIRY_SEC,
  DEPEG_SECONDARY_THRESHOLD_RATIO,
  DEFILLAMA_COINS,
  USER_AGENT,
  CIRCUIT_SOURCE,
  DEX_FRESHNESS_SEC,           // ← add
  POOL_CHALLENGE_MIN_TVL,      // ← add
} from "../lib/constants";
```

After loading `dexPriceRows` (line 75), load pool challengers:

```typescript
const dexPriceRows = await loadDexPriceRows(db);

// Load individual pool prices for pool-level confirmation
throwIfAborted(signal);
const poolChallengers = await loadDexPoolChallengers(db, POOL_CHALLENGE_MIN_TVL, DEX_FRESHNESS_SEC, now);
```

After the CEX check block (after line ~218), add the pool-level check.

Note: This uses reference-based BPS (`pool.price / peg_reference`) which matches the methodology used elsewhere in depeg detection (e.g., `detect-depegs.ts:315`). The pool challenge in `enrich-prices.ts` uses midpoint-based BPS, but for confirmation we compare against the peg reference, which is the right denominator for "is this pool depegged?":

```typescript
// 4c. Individual DEX pool check
let poolAgrees: boolean | null = null;
const pools = poolChallengers.get(row.stablecoin_id);
if (pools?.length) {
  for (const pool of pools) {
    const poolBps = Math.abs(Math.round(((pool.price / row.peg_reference) - 1) * 10000));
    if (poolBps >= secondaryBar) {
      poolAgrees = true;
      console.log(
        `[depeg-confirm] ${row.symbol} pool check: price=$${pool.price} (${pool.protocol}/${pool.chain}), ` +
        `deviation=${poolBps}bps, bar=${secondaryBar}bps, agrees=true`,
      );
      break;
    }
  }
  if (poolAgrees !== true) {
    poolAgrees = false;
    console.log(
      `[depeg-confirm] ${row.symbol} pool check: ${pools.length} pools, none diverge ≥${secondaryBar}bps`,
    );
  }
}
```

Update the promotion condition at line 221:

```typescript
if (offchainAgrees === true || dexAgrees === true || cexAgrees === true || poolAgrees === true) {
```

Update the `confirmedBy` label to include Pool:

```typescript
const confirmedBy = [
  offchainAgrees ? (asset?.priceSource?.startsWith("coingecko") ? "DefiLlama" : "CoinGecko") : null,
  dexAgrees ? "DEX" : null,
  cexAgrees ? "CEX" : null,
  poolAgrees ? "Pool" : null,
].filter(Boolean).join("+");
```

Update the rejection conditions — don't reject when pool evidence exists:

```typescript
// Before:
} else if (offchainAgrees === false && dexAgrees === false) {

// After:
} else if (offchainAgrees === false && dexAgrees === false && poolAgrees !== true) {
```

```typescript
// Before:
} else if (offchainAgrees === false && dexAgrees === null) {

// After:
} else if (offchainAgrees === false && dexAgrees === null && poolAgrees !== true) {
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd worker && npx vitest run src/cron/__tests__/confirm-pending-depegs.test.ts --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 7: Run full test suite to check for regressions**

Run: `cd worker && npx vitest run --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add worker/src/lib/constants.ts worker/src/cron/enrich-prices.ts worker/src/cron/confirm-pending-depegs.ts worker/src/cron/__tests__/confirm-pending-depegs.test.ts
git commit -m "fix(depeg): add pool-level prices as fourth confirmation source (BUG-1)

Pool-challenge-driven depegs (e.g., dUSD at -510 bps) were always rejected
because confirmation checked the same aggregator sources the pool challenge
proved unreliable. Add individual pool prices as a fourth confirmation source
alongside off-chain, DEX aggregate, and CEX. Any pool with $100K+ TVL showing
deviation >= secondary bar can now confirm a pending depeg."
```

---

## Task 2: BUG-2 — Peg-type-aware pool challenge threshold

The pool challenge uses a fixed 500 bps threshold regardless of peg type. For non-USD stablecoins (depeg threshold 150 bps), a 221 bps divergence (like JPYC) is significant but goes undetected.

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts:412,417-434` (make threshold peg-type-aware)
- Test: `worker/src/cron/__tests__/enrich-prices.test.ts`

- [ ] **Step 1: Extract pool challenge logic into a testable function**

The pool challenge logic at `enrich-prices.ts:407-455` is embedded in `fetchPrimaryPrices`, which requires mocking 8+ external APIs. To make it testable, extract the pool challenge pass into a standalone exported function:

```typescript
/**
 * Post-consensus pool challenge: downgrade soft-only results when
 * large DEX pools diverge from the consensus price.
 */
export function applyPoolChallenge(
  results: Map<string, PrimaryPriceResult>,
  poolChallengers: Map<string, Array<{ price: number; tvlUsd: number; protocol: string; chain: string }>>,
  assetPegTypes: Map<string, string | undefined>,
  stats: PriceValidationStats,
): number {
  let downgrades = 0;
  for (const [assetId, result] of results) {
    if (result.confidence !== "high") continue;
    if (!isAllSoftSources(result.agreeSources)) continue;

    const pools = poolChallengers.get(assetId);
    if (!pools?.length) continue;

    const pegType = assetPegTypes.get(assetId);
    const poolChallengeBps = pegType === "peggedUSD"
      ? 500
      : Math.min(getDepegThresholdBps(pegType) * 2, 500);

    let challenged = false;
    for (const pool of pools) {
      const mid = (result.price + pool.price) / 2;
      if (mid <= 0) continue;
      const bps = Math.abs(result.price - pool.price) / mid * 10_000;
      if (bps >= poolChallengeBps) {
        challenged = true;
        break;
      }
    }
    if (challenged) {
      result.confidence = "low";
      stats.high--;
      stats.low++;
      downgrades++;

      let tvlWeightedSum = 0;
      let tvlSum = 0;
      for (const pool of pools) {
        tvlWeightedSum += pool.price * pool.tvlUsd;
        tvlSum += pool.tvlUsd;
      }
      if (tvlSum > 0) {
        result.price = tvlWeightedSum / tvlSum;
        result.source = "pool-tvl-weighted";
      }
    }
  }
  return downgrades;
}
```

Then replace the inline pool challenge at lines 407-458 with a call to this function:

```typescript
const assetPegTypes = new Map(candidates.map((a) => [a.id, a.pegType]));
const poolChallengeDowngrades = applyPoolChallenge(results, poolChallengers, assetPegTypes, stats);
if (poolChallengeDowngrades > 0) {
  console.log(`[primary-prices] Pool challenge downgraded ${poolChallengeDowngrades} soft-only results to low confidence`);
}
```

- [ ] **Step 2: Write failing tests for peg-type-aware pool challenge**

In `worker/src/cron/__tests__/enrich-prices.test.ts`, import the new function and write:

```typescript
import { applyPoolChallenge } from "../enrich-prices";
import type { PrimaryPriceResult, PriceValidationStats } from "../enrich-prices";

describe("applyPoolChallenge", () => {
  function makeStats(): PriceValidationStats {
    return { attempted: 1, high: 1, singleSource: 0, cgOnly: 0, low: 0 };
  }

  it("fires for non-USD peg at 300 bps divergence", () => {
    const results = new Map<string, PrimaryPriceResult>([
      ["jpyc-jpyc", {
        price: 0.00682, source: "coingecko+defillama-list+dex-promoted",
        confidence: "high", dlPrice: 0.00682, cgPrice: 0.00682,
        candidateSources: ["coingecko", "defillama-list", "dex-promoted"],
        agreeSources: ["coingecko", "defillama-list", "dex-promoted"],
      }],
    ]);
    const pools = new Map([
      ["jpyc-jpyc", [{ price: 0.00704, tvlUsd: 500_000, protocol: "uniswap", chain: "ethereum" }]],
    ]);
    const pegTypes = new Map([["jpyc-jpyc", "peggedJPY"]]);
    const stats = makeStats();

    const downgrades = applyPoolChallenge(results, pools, pegTypes, stats);

    expect(downgrades).toBe(1);
    expect(results.get("jpyc-jpyc")!.confidence).toBe("low");
  });

  it("does NOT fire for USD peg at 300 bps divergence", () => {
    const results = new Map<string, PrimaryPriceResult>([
      ["usdt-tether", {
        price: 1.0, source: "coingecko+defillama-list+dex-promoted",
        confidence: "high", dlPrice: 1.0, cgPrice: 1.0,
        candidateSources: ["coingecko", "defillama-list", "dex-promoted"],
        agreeSources: ["coingecko", "defillama-list", "dex-promoted"],
      }],
    ]);
    const pools = new Map([
      ["usdt-tether", [{ price: 0.97, tvlUsd: 500_000, protocol: "uniswap", chain: "ethereum" }]],
    ]);
    const pegTypes = new Map([["usdt-tether", "peggedUSD"]]);
    const stats = makeStats();

    const downgrades = applyPoolChallenge(results, pools, pegTypes, stats);

    expect(downgrades).toBe(0);
    expect(results.get("usdt-tether")!.confidence).toBe("high");
  });

  it("fires for USD peg at 500+ bps divergence", () => {
    const results = new Map<string, PrimaryPriceResult>([
      ["dusd-test", {
        price: 1.0, source: "coingecko+defillama-list",
        confidence: "high", dlPrice: 1.0, cgPrice: 1.0,
        candidateSources: ["coingecko", "defillama-list"],
        agreeSources: ["coingecko", "defillama-list"],
      }],
    ]);
    const pools = new Map([
      ["dusd-test", [{ price: 0.80, tvlUsd: 500_000, protocol: "curve", chain: "ethereum" }]],
    ]);
    const pegTypes = new Map([["dusd-test", "peggedUSD"]]);
    const stats = makeStats();

    const downgrades = applyPoolChallenge(results, pools, pegTypes, stats);

    expect(downgrades).toBe(1);
    expect(results.get("dusd-test")!.confidence).toBe("low");
    expect(results.get("dusd-test")!.source).toBe("pool-tvl-weighted");
  });

  it("skips results with hard sources in agreeSources", () => {
    const results = new Map<string, PrimaryPriceResult>([
      ["usdt-tether", {
        price: 1.0, source: "coingecko+binance",
        confidence: "high", dlPrice: 1.0, cgPrice: 1.0,
        candidateSources: ["coingecko", "binance"],
        agreeSources: ["coingecko", "binance"],
      }],
    ]);
    const pools = new Map([
      ["usdt-tether", [{ price: 0.80, tvlUsd: 500_000, protocol: "curve", chain: "ethereum" }]],
    ]);
    const pegTypes = new Map([["usdt-tether", "peggedUSD"]]);
    const stats = makeStats();

    const downgrades = applyPoolChallenge(results, pools, pegTypes, stats);

    expect(downgrades).toBe(0); // binance is a hard source
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd worker && npx vitest run src/cron/__tests__/enrich-prices.test.ts --reporter=verbose`
Expected: FAIL — `applyPoolChallenge` not exported, and the non-USD test would fail with the old fixed 500 bps threshold

- [ ] **Step 4: Implement — extract and make peg-type-aware**

In `worker/src/cron/enrich-prices.ts`, build an asset lookup before the pool challenge loop:

```typescript
// Build asset lookup for peg type access in pool challenge
const assetById = new Map(candidates.map((a) => [a.id, a]));
```

Then make the threshold peg-type-aware inside the loop. Replace the fixed constant with a per-asset calculation:

```typescript
// Before (line 412):
const POOL_CHALLENGE_BPS = 500;

// After: remove the constant, compute per-asset inside the loop.
```

Inside the `for (const [assetId, result] of results)` loop, compute the threshold:

```typescript
const asset = assetById.get(assetId);
// Non-USD pegs: 2x depeg threshold (300 bps). USD: keep 500 bps.
const poolChallengeBps = asset?.pegType === "peggedUSD"
  ? 500
  : Math.min(getDepegThresholdBps(asset?.pegType) * 2, 500);
```

Replace `bps >= POOL_CHALLENGE_BPS` with `bps >= poolChallengeBps`.

Add `getDepegThresholdBps` to the imports from constants if not already imported.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd worker && npx vitest run --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/enrich-prices.ts worker/src/cron/__tests__/enrich-prices.test.ts
git commit -m "fix(pricing): make pool challenge threshold peg-type-aware (BUG-2)

Non-USD stablecoins (JPY, EUR, etc.) have 150 bps depeg threshold but the
pool challenge used a fixed 500 bps threshold. A 221 bps DEX divergence on
JPYC went undetected. Now uses 300 bps (2x depeg threshold) for non-USD pegs,
keeping 500 bps for USD pegs to avoid over-sensitivity."
```

---

## Task 3: IMPROVE-1 — Gate Pyth consensus weight on confidence interval

Pyth provides `confidenceBps` per feed but it's not used in weighting. A wide confidence interval means the feed is unreliable.

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts:345` (adjust Pyth weight based on confidenceBps)
- Test: `worker/src/cron/__tests__/enrich-prices.test.ts`

- [ ] **Step 1: Write failing test**

Test that a Pyth source with `confidenceBps > 200` is NOT included in the consensus sources array. Test that `confidenceBps` between 100-200 results in weight 1 instead of 2.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/cron/__tests__/enrich-prices.test.ts --reporter=verbose`
Expected: FAIL

- [ ] **Step 3: Implement Pyth confidence gating**

In `worker/src/cron/enrich-prices.ts`, replace line 345:

```typescript
// Before:
if (pyth != null) sources.push({ source: "pyth", price: pyth.price, weight: 2, metadata: { confidenceBps: pyth.confidenceBps } });

// After:
if (pyth != null) {
  const pythWeight = pyth.confidenceBps > 200 ? 0 : pyth.confidenceBps > 100 ? 1 : 2;
  if (pythWeight > 0) {
    sources.push({ source: "pyth", price: pyth.price, weight: pythWeight, metadata: { confidenceBps: pyth.confidenceBps } });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && npx vitest run --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/enrich-prices.ts worker/src/cron/__tests__/enrich-prices.test.ts
git commit -m "feat(pricing): gate Pyth consensus weight on confidence interval (IMPROVE-1)

Pyth feeds with >200 bps confidence interval excluded from consensus.
100-200 bps downweighted to 1 (from 2). Prevents wide-confidence feeds
from diluting agreement clusters."
```

---

## Task 4: IMPROVE-2 — Gate RedStone consensus weight on venue agreement

RedStone provides `venueAgreementPct` but it's not used. Low venue agreement signals unreliable data.

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts:351-357` (gate RedStone on venueAgreementPct)
- Test: `worker/src/cron/__tests__/enrich-prices.test.ts`

- [ ] **Step 1: Write failing test**

Test that a RedStone source with `venueAgreementPct < 50` is excluded from the consensus sources array.

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement RedStone venue agreement gating**

In `worker/src/cron/enrich-prices.ts`, around lines 351-357:

```typescript
// Before:
if (redstoneResult != null) {
  sources.push({
    source: "redstone", price: redstoneResult.price, weight: 1,
    metadata: { venueCount: redstoneResult.venueCount, venueAgreementPct: redstoneResult.venueAgreementPct },
  });
}

// After:
if (redstoneResult != null && redstoneResult.venueAgreementPct >= 50) {
  sources.push({
    source: "redstone", price: redstoneResult.price, weight: 1,
    metadata: { venueCount: redstoneResult.venueCount, venueAgreementPct: redstoneResult.venueAgreementPct },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && npx vitest run --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/enrich-prices.ts worker/src/cron/__tests__/enrich-prices.test.ts
git commit -m "feat(pricing): exclude RedStone when venue agreement < 50% (IMPROVE-2)"
```

---

## Task 5: DESIGN-4 — Downgrade CG+DL-only consensus to single-source

Two soft aggregators that may share upstream data shouldn't get "high" confidence. This also makes these assets eligible for the GT probe pass.

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts:387-404` (post-consensus downgrade check)
- Test: `worker/src/cron/__tests__/enrich-prices.test.ts`

- [ ] **Step 1: Write failing test**

Test that a consensus result with only `["coingecko", "defillama-list"]` as agree sources gets downgraded from `"high"` to `"single-source"`. Test that `["coingecko", "defillama-list", "redstone"]` is NOT downgraded (3 sources, not CG+DL-only).

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement CG+DL-only downgrade**

After the stats tracking block (after the `if (consensus.confidence === "single-source")` block around line 404), add a new code block. This goes **after** the existing stats accounting so the decrement is correct:

```typescript
// Downgrade CG+DL-only "high" to "single-source" — these soft aggregators
// may share upstream data, creating illusory agreement.
// Note: storedResult is a NEW variable — the consensus result was stored
// by results.set(asset.id, { ... }) at line 387.
const storedResult = results.get(asset.id)!;
if (
  storedResult.confidence === "high" &&
  storedResult.agreeSources.length === 2 &&
  storedResult.agreeSources.every((s) => s === "coingecko" || s === "defillama-list")
) {
  storedResult.confidence = "single-source";
  stats.high--;
  stats.singleSource++;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && npx vitest run --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/enrich-prices.ts worker/src/cron/__tests__/enrich-prices.test.ts
git commit -m "feat(pricing): downgrade CG+DL-only consensus to single-source (DESIGN-4)

CoinGecko and DefiLlama list prices may share upstream data. Two correlated
soft sources agreeing shouldn't be treated as independent confirmation.
Downgrade to single-source, making these assets eligible for GT probe."
```

---

## Task 6: DESIGN-3 — Protocol override divergence warning

Protocol overrides (iUSD, cUSD) bypass consensus entirely. Log a warning when the override diverges significantly from market consensus.

**Files:**
- Modify: `worker/src/cron/sync-stablecoins.ts:531-544` (add divergence check before override)

- [ ] **Step 1: Read the protocol override section**

Read `sync-stablecoins.ts:525-550` to understand the exact override loop structure.

- [ ] **Step 2: Implement divergence warning**

Before replacing the consensus price, check for divergence and log:

```typescript
// Warn if protocol override diverges significantly from market consensus
if (asset.price != null && asset.price > 0 && override.price > 0) {
  const divergenceBps = Math.abs(Math.round(((override.price / asset.price) - 1) * 10000));
  if (divergenceBps > 100) {
    console.warn(
      `[sync] Protocol override for ${asset.symbol} diverges ${divergenceBps}bps from consensus ` +
      `(override=$${override.price.toFixed(4)}, consensus=$${asset.price.toFixed(4)})`,
    );
  }
}
```

- [ ] **Step 3: Run full test suite**

Run: `cd worker && npx vitest run --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/sync-stablecoins.ts
git commit -m "feat(pricing): warn when protocol override diverges >100 bps from consensus (DESIGN-3)"
```

---

## Task 7: BUG-3 — Include navToken coins in peg-summary with null deviation

**Files:**
- Modify: `worker/src/api/peg-summary.ts:164` (remove blanket navToken skip)
- Test: `worker/src/api/__tests__/peg-summary.test.ts`

- [ ] **Step 1: Read peg-summary.ts fully to understand the coin entry structure**

Read `worker/src/api/peg-summary.ts:158-200` to understand all fields in the coins array and which ones need null treatment for navTokens.

- [ ] **Step 2: Write failing test**

In `worker/src/api/__tests__/peg-summary.test.ts`, add a test that verifies a navToken coin (FPI) appears in the response. This requires the `TRACKED_META_BY_ID` mock to include FPI. Check how the mock is set up — if it uses the real module, add FPI to the test assets. If it mocks `TRACKED_META_BY_ID`, add an entry with `navToken: true`.

Note: The test file uses the real `TRACKED_META_BY_ID` (no mock). FPI is already in the tracked metadata (`shared/lib/stablecoins/non-usd.ts:91`), so the test just needs to pass FPI data through the DB cache. The `handlePegSummary` function signature is `handlePegSummary(db: D1Database)` — NOT `handlePegSummary(request, db)`.

```typescript
it("includes navToken coins with null deviation fields", async () => {
  const db = makePegSummaryDb([
    makeAsset({
      id: "fpi-frax",
      name: "Frax Price Index",
      symbol: "FPI",
      pegType: "peggedVAR",
      price: 1.12,
    }),
  ]);
  const res = await handlePegSummary(db);
  const data = (await res.json()) as { coins: Array<{ id: string; currentDeviationBps: number | null }> };
  const fpi = data.coins.find((c) => c.id === "fpi-frax");
  expect(fpi).toBeDefined();
  expect(fpi!.currentDeviationBps).toBeNull();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd worker && npx vitest run src/api/__tests__/peg-summary.test.ts --reporter=verbose`
Expected: FAIL — FPI filtered by `if (meta.flags.navToken) continue`

- [ ] **Step 4: Implement navToken inclusion**

There are two places to change:

**4a. Enable navTokens in peg analytics** (`peg-summary.ts:108`):

```typescript
// Before:
includeNavTokens: false,

// After:
includeNavTokens: true,
```

This is needed because `derivePegAnalyticsSnapshot` (in `worker/src/lib/peg-analytics.ts:54`) skips navTokens when `includeNavTokens` is false, so `pegDataById` won't contain FPI. Without this change, the `!pegData` guard at line 167 would skip FPI even after removing the navToken filter.

**4b. Replace blanket navToken skip** (`peg-summary.ts:164`):

```typescript
// Before:
if (meta.flags.navToken) continue;

// After:
const isNavToken = meta.flags.navToken === true;
```

Then guard all deviation-dependent logic with `!isNavToken`:

- `currentBps`: set to `null` for navTokens (override whatever `pegData.currentDeviationBps` says, since the peg reference is meaningless for VAR-peg)
- `activeDepeg`: set to `false` for navTokens
- `allAbsBps.push(...)`: skip for navTokens
- `worstCurrent` / `coinsAtPeg` tracking: skip for navTokens
- `primaryTrust`: still compute normally (navTokens have prices)
- `dexPriceCheck`: still compute normally if DEX data exists

The coin entry should be included with deviation fields set to null.

**Important**: Verify that changing `includeNavTokens` to `true` doesn't break the peg analytics computation for navTokens. In `peg-analytics.ts`, navTokens will get `currentDeviationBps: null` because `getPegReference()` returns 0 for `peggedVAR` — check that the deviation calculation handles this gracefully. If not, add a guard in step 4b to force `currentBps = null` for navTokens regardless of what pegData says.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd worker && npx vitest run src/api/__tests__/peg-summary.test.ts --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 6: Run full test suite**

Run: `cd worker && npx vitest run --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add worker/src/api/peg-summary.ts worker/src/api/__tests__/peg-summary.test.ts
git commit -m "fix(api): include navToken coins in peg-summary with null deviation (BUG-3)

FPI-FRAX (navToken=true) was invisible in the peg-summary API due to blanket
navToken skip. Now included with null deviation fields since variable-peg
coins don't have a fixed reference to deviate from."
```

---

## Task 8: IMPROVE-4 — Disagree source logging

Log when high-weight sources (weight >= 2) persistently disagree with the cluster. Catches stale feeds and API issues.

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts` (add logging after consensus in the per-asset loop)

- [ ] **Step 1: Implement disagree source logging**

After the consensus result is stored (around line 395), add:

```typescript
// Log when high-weight sources disagree — aids operational monitoring (IMPROVE-4)
if (consensus.disagreeSources.length > 0) {
  const highWeightDisagrees = sources
    .filter((s) => s.weight >= 2 && consensus.disagreeSources.includes(s.source))
    .map((s) => `${s.source}($${s.price.toFixed(4)})`);
  if (highWeightDisagrees.length > 0) {
    console.log(
      `[primary-prices] ${asset.symbol}: high-weight disagree: ${highWeightDisagrees.join(", ")} ` +
      `vs consensus $${consensus.price.toFixed(4)}`,
    );
  }
}
```

- [ ] **Step 2: Run full test suite**

Run: `cd worker && npx vitest run --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/enrich-prices.ts
git commit -m "feat(pricing): log high-weight source disagreements (IMPROVE-4)"
```

---

## Task 9: IMPROVE-5 — Expand Coinbase coverage

Add verified Coinbase Exchange USD pairs to increase hard source coverage.

**Files:**
- Modify: `worker/src/lib/cex-tickers.ts:29-31`

- [ ] **Step 1: Verify active Coinbase USD pairs**

Check Coinbase Exchange for these symbols: GHO, BOLD, FRAX, XAUT, TUSD, FDUSD. Only add confirmed active USD pairs. Use the Coinbase API `/products` endpoint or documentation.

- [ ] **Step 2: Update COINBASE_KNOWN_SYMBOLS**

Add only verified symbols:

```typescript
export const COINBASE_KNOWN_SYMBOLS: readonly string[] = [
  "USDT", "DAI", "PAXG", "USDS", "USD1", "HONEY",
  // Verified Coinbase USD pairs (2026-03-17):
  // ... add confirmed symbols here
] as const;
```

- [ ] **Step 3: Run full test suite**

Run: `cd worker && npx vitest run --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/cex-tickers.ts
git commit -m "feat(pricing): expand Coinbase coverage with verified USD pairs (IMPROVE-5)"
```

---

## Task 10: IMPROVE-6 — Preserve full source list in consensus label

**Files:**
- Modify: `worker/src/lib/price-consensus.ts` (change `buildSourceLabel`)
- Test: `worker/src/lib/__tests__/price-consensus.test.ts`

- [ ] **Step 1: Write failing test**

In `worker/src/lib/__tests__/price-consensus.test.ts`:

```typescript
it("includes all agree sources in the source label", () => {
  const sources: SourcePrice[] = [
    { source: "coingecko", price: 1.0001, weight: 2 },
    { source: "binance", price: 1.0002, weight: 2 },
    { source: "pyth", price: 1.0001, weight: 2 },
    { source: "redstone", price: 1.0003, weight: 1 },
  ];
  const result = computePriceConsensus(sources, 1.0, 50);
  // All 4 sources agree within 50 bps — label should include all
  expect(result!.source).toContain("coingecko");
  expect(result!.source).toContain("binance");
  expect(result!.source).toContain("pyth");
  expect(result!.source).toContain("redstone");
  expect(result!.source).not.toContain("more");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/lib/__tests__/price-consensus.test.ts --reporter=verbose`
Expected: FAIL — current label truncates to `"binance+3more"`

- [ ] **Step 3: Implement full source label**

Find `buildSourceLabel` at `worker/src/lib/price-consensus.ts:138-142`. Note: the actual signature takes `SourcePrice[]`, not `string[]`:

```typescript
// Before (line 138-142):
function buildSourceLabel(cluster: SourcePrice[]): string {
  const names = cluster.map((s) => s.source).sort();
  if (names.length <= 2) return names.join("+");
  return `${names[0]}+${names.length - 1}more`;
}

// After:
function buildSourceLabel(cluster: SourcePrice[]): string {
  return cluster.map((s) => s.source).sort().join("+");
}
```

- [ ] **Step 4: Update any existing tests that assert the truncated format**

Search for `"more"` in `price-consensus.test.ts` and update assertions to expect the full label.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd worker && npx vitest run src/lib/__tests__/price-consensus.test.ts --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 6: Run full test suite**

Run: `cd worker && npx vitest run --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add worker/src/lib/price-consensus.ts worker/src/lib/__tests__/price-consensus.test.ts
git commit -m "feat(pricing): preserve full source list in consensus label (IMPROVE-6)"
```

---

## Task 11: DESIGN-1 + IMPROVE-3 — Soft-only consensus annotation

Mark consensus results where all agreeing sources are soft aggregators. Provides visibility without changing the confidence tier model.

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts:93-101` (add `softOnly` to `PrimaryPriceResult`), `:387-404` (set flag)

- [ ] **Step 1: Add softOnly flag to PrimaryPriceResult**

```typescript
export interface PrimaryPriceResult {
  price: number;
  source: string;
  confidence: PriceConfidence;
  dlPrice: number | null;
  cgPrice: number | null;
  candidateSources: string[];
  agreeSources: string[];
  softOnly?: boolean;
}
```

- [ ] **Step 2: Set the flag after consensus**

After storing the result and after the CG+DL-only downgrade (Task 5), add:

```typescript
if (storedResult.confidence === "high" && isAllSoftSources(storedResult.agreeSources)) {
  storedResult.softOnly = true;
}
```

- [ ] **Step 3: Run full test suite**

Run: `cd worker && npx vitest run --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/enrich-prices.ts
git commit -m "feat(pricing): annotate soft-only consensus results (DESIGN-1, IMPROVE-3)"
```

---

## Task 12: DESIGN-5 — Document GYEN investigation

Investigation/documentation task. Determine if GYEN's chronic +280-305 bps is a real premium or pricing artifact.

**Files:**
- Modify: `agents/audits/pricing-pipeline-audit-2026-03-17.md` (update DESIGN-5)

- [ ] **Step 1: Investigate GYEN pricing**

Research:
- Is GYEN redeemable at par (1 GYEN = 1 JPY)?
- What FX rate does the system use as peg reference?
- Does the premium persist across all CG-reported exchanges, or is it exchange-specific?

- [ ] **Step 2: Document findings in audit**

Update DESIGN-5 with investigation results and recommended action (threshold adjustment, annotation, or "it's real").

- [ ] **Step 3: Commit**

```bash
git add agents/audits/pricing-pipeline-audit-2026-03-17.md
git commit -m "docs: document GYEN chronic depeg investigation (DESIGN-5)"
```

---

## Task 13: DESIGN-2 — Log missing DL list prices for coverage awareness

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts` (add coverage logging after consensus loop)

- [ ] **Step 1: Check if PeggedAsset has llamaId**

Read `PeggedAsset` interface at `enrich-prices.ts:38-62` — it doesn't have `llamaId` directly. Use the tracked metadata to check which assets should have DL list prices. Alternatively, check which assets have `dlListPrice` as null when they have a CG ID (all DL-tracked coins have CG IDs).

- [ ] **Step 2: Implement DL coverage logging**

After the consensus loop (after line 405), add:

```typescript
// Log coverage: how many candidates received a DL list price
if (dlListPrices) {
  const withDl = candidates.filter((a) => dlListPrices.has(a.id)).length;
  const withoutDl = candidates.length - withDl;
  if (withoutDl > 0) {
    console.log(`[primary-prices] DL list coverage: ${withDl}/${candidates.length} (${withoutDl} missing)`);
  }
}
```

- [ ] **Step 3: Run full test suite**

Run: `cd worker && npx vitest run --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/enrich-prices.ts
git commit -m "feat(pricing): log DL list price coverage for monitoring (DESIGN-2)"
```

---

## Task 14: Version bump and changelog

**Files:**
- Modify: `shared/lib/pricing-pipeline-version.ts`

- [ ] **Step 1: Bump version to v2.2 and add changelog entry**

Add a new v2.2 entry at the top of the changelog array:

```typescript
{
  version: "2.2",
  title: "Pool confirmation fix, peg-type-aware challenge, source quality gating",
  date: "2026-03-17",
  effectiveAt: 1773897600, // 2026-03-17T00:00:00Z
  summary:
    "Fixed critical depeg detection gap where pool-challenge-driven depegs could never be confirmed. " +
    "Made pool challenge threshold peg-type-aware. Added Pyth confidence and RedStone venue agreement gating. " +
    "Downgraded CG+DL-only consensus to single-source.",
  impact: [
    "Pool-level individual prices added as fourth depeg confirmation source — fixes dUSD-like depegs going undetected",
    "Pool challenge threshold now peg-type-aware: 300 bps for non-USD (was 500 bps for all)",
    "Pyth feeds with >200 bps confidence excluded from consensus; 100-200 bps downweighted",
    "RedStone excluded when internal venue agreement < 50%",
    "CG+DL-only consensus downgraded from high to single-source (illusory agreement)",
    "NAV tokens (FPI) now visible in peg-summary API with null deviation",
    "Full source list preserved in consensus label (no more truncation)",
    "Protocol override divergence warnings logged when >100 bps from consensus",
  ],
  commits: [],
  reconstructed: false,
},
```

Update `currentVersion` to `"2.2"`.

- [ ] **Step 2: Run full test suite**

Run: `cd worker && npx vitest run --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 3: Type-check both worker and frontend**

Run: `cd worker && npx tsc --noEmit && cd .. && npm run build`
Expected: No errors

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 5: Check if docs need updating**

Per CLAUDE.md: "After updating a scoring methodology, update both the `/methodology` page and the relevant `*-timeline.md` changelog in `/docs/`." Check if `docs/pricing-pipeline-timeline.md` (or similar) needs a v2.2 entry. Also check if the methodology page references pool challenge behavior that changed.

- [ ] **Step 6: Commit**

```bash
git add shared/lib/pricing-pipeline-version.ts
git commit -m "chore: bump pricing pipeline to v2.2 with audit remediation changelog"
```

---

## Execution Order & Parallelism

Tasks are ordered by dependency:

1. **Task 1** (BUG-1) — Critical fix, extracts shared constant
2. **Task 2** (BUG-2) — Uses same constant, touches pool challenge
3. **Tasks 3, 4** (IMPROVE-1, IMPROVE-2) — Independent consensus source gating, parallelizable
4. **Task 5** (DESIGN-4) — Depends on Tasks 3-4 completing (touches same stats block)
5. **Tasks 6, 7, 8, 9, 10** — All independent, fully parallelizable
6. **Task 11** (DESIGN-1+IMPROVE-3) — Depends on Task 5 (adds flag after CG+DL downgrade)
7. **Tasks 12, 13** — Independent documentation/logging, parallelizable
8. **Task 14** — Version bump, must be last

```
Task 1 → Task 2 → Tasks 3+4 (parallel) → Task 5 → Task 11
                    Tasks 6+7+8+9+10 (parallel, after Task 1)
                    Tasks 12+13 (parallel, anytime)
                    Task 14 (last)
```
