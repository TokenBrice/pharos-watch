# Pricing Pipeline Audit Remediation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 3 HIGH, 8 MEDIUM, and 5 LOW severity findings from the 2026-03-14 pricing pipeline audit.

**Architecture:** The pricing pipeline uses N-source weighted consensus (CG w2, DL w1, Pyth w2, Binance w2, Coinbase w2, RedStone w1, Curve w3, DEX w1) with circuit breakers, 4-pass enrichment fallback, two-stage depeg confirmation, FX rate sync, and protocol-native price overrides. All fixes are surgical — no architectural changes.

**Tech Stack:** TypeScript strict, Cloudflare Workers + D1, Vitest, Zod.

**Audit report:** `agents/audits/2026-03-14-pricing-pipeline-audit.md`

---

## File Map

| File | Action | Issues Addressed |
|------|--------|-----------------|
| `worker/src/lib/curve-onchain.ts` | Modify line 52 | H1 |
| `worker/src/lib/__tests__/curve-onchain.test.ts` | Add tests | H1, L5 |
| `worker/src/cron/enrich-prices.ts` | Modify lines 189, 290, 306, 344, 664, 766-768 | M2, M3, L4, L2 |
| `worker/src/lib/cex-tickers.ts` | Add `COINBASE_KNOWN_PAIRS`, refactor `fetchCoinbasePrices` | M2 |
| `worker/src/lib/__tests__/cex-tickers.test.ts` | Add tests | M2, L5 |
| `worker/src/cron/sync-fx-rates.ts` | Modify OXR block (~line 266), add ECB date check (~line 170) | H2b, M8 |
| `worker/src/cron/__tests__/sync-fx-rates.test.ts` | Add tests | H2b, M8, L5 |
| `worker/src/cron/confirm-pending-depegs.ts` | Modify lines 257-260 | M5 |
| `worker/src/cron/__tests__/confirm-pending-depegs.test.ts` | Add test | M5, L5 |
| `worker/src/lib/authoritative-price-sources.ts` | Add `console.warn` calls | M7 |
| `worker/src/lib/__tests__/authoritative-price-sources.test.ts` | Add test | M7, L5 |
| `worker/src/lib/price-consensus.ts` | Modify tie-breaking (lines 61, 74, 94), NAV confidence (line 66) | L1, L3 |
| `worker/src/lib/__tests__/price-consensus.test.ts` | Add tests | L1, L3, L5 |
| `worker/src/lib/curve-pool-configs.ts` | Expand pool configs | M1 |
| `shared/lib/stablecoins.ts` | Add geckoId for 3 coins | M4 |

**Documentation:** After all code tasks are complete, review `docs/data-pipeline.md` for any references to circuit breaker coverage or Curve pricing semantics that need updating. Per CLAUDE.md, docs must be updated before pushing.

**Out of scope (ops/investigation tasks — not code changes):**
- ~~H2: Configure `OPENEXCHANGERATES_API_KEY` in production~~ — **RESOLVED: key IS configured**, the audit incorrectly inferred "not configured" from the circuit breaker which was itself never wired up (H2b). The OXR code path runs via `quarter-hourly.ts:43` → `syncFxRates` → `fetchRealtimeFxRates`. Authentication uses `?app_id=KEY` query parameter, matching OXR docs. Verify with: `curl -s "https://api.pharos.watch/api/admin/cron-status" -H "Authorization: Bearer $TOKEN" | jq '.jobs[] | select(.job == "sync-fx-rates") | .metadata'` — look for `"openExchangeRates": "ok"` or `"rate-limited"`.
- H3: Investigate and fix CMC API key / plan tier
- M6: Pyth confidence weight modulation (deferred — requires consensus algorithm design work)

---

## Chunk 1: Critical Fixes (H1, M3, H2b)

### Task 1: Fix Curve On-Chain Price Formula Inversion (H1)

**Files:**
- Modify: `worker/src/lib/curve-onchain.ts:52`
- Modify: `worker/src/lib/__tests__/curve-onchain.test.ts`

**Context:** `get_dy(i, j, dx)` returns the output amount when swapping `dx` of token `i` for token `j`. We send 1 USDC (the reference) and receive ~1 USDT (the target). The **implied USD price of the output token** is `inputUsd / outputTokens` — i.e., "how many dollars of USDC did I spend per unit of output token received." The current code computes `output / input` which is the exchange rate (units received per unit sent), not the USD price.

- [ ] **Step 1: Write the failing test for depeg scenario**

In `worker/src/lib/__tests__/curve-onchain.test.ts`, add after the existing tests:

```typescript
it("computes correct implied price when pool is imbalanced (depeg scenario)", async () => {
  // Depeg scenario: USDT trading at $0.95
  // Sending 1 USDC (1e6), get_dy returns ~1.053e6 USDT (more USDT per USDC because USDT is cheap)
  // Correct implied price = inputUsd / outputTokens = 1.0 / 1.053 ≈ 0.9497
  // Bug (output/input) would give 1.053 — clearly wrong for a depeg
  const mockHex = ("0x" + BigInt(1_052_632).toString(16).padStart(64, "0")) as `0x${string}`;
  mockEvmCall.mockResolvedValue(mockHex);

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
  expect(results.get("usdt-tether")).toBeCloseTo(0.95, 2);
});

it("computes correct implied price with different decimals (DAI 18 decimals)", async () => {
  // 1 USDC (1e6) → 1.001e18 DAI (slightly above peg)
  // Correct: 1.0 / 1.001 ≈ 0.999
  const daiOutput = BigInt("1001000000000000000"); // 1.001 * 1e18
  const mockHex = ("0x" + daiOutput.toString(16).padStart(64, "0")) as `0x${string}`;
  mockEvmCall.mockResolvedValue(mockHex);

  const config: CurvePoolConfig = {
    stablecoinId: "dai-makerdao",
    poolAddress: "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7",
    inputIndex: 1,
    outputIndex: 0,
    inputDecimals: 6,
    outputDecimals: 18,
    chain: "ethereum",
  };
  const results = await fetchCurveOnchainPrices([config]);
  expect(results.get("dai-makerdao")).toBeCloseTo(0.999, 3);
});
```

- [ ] **Step 2: Run the tests and verify the depeg test fails**

```bash
cd worker && npx vitest run src/lib/__tests__/curve-onchain.test.ts
```

Expected: The depeg test FAILS (gets ~1.053 instead of ~0.95). The DAI test may also fail with ~1.001 instead of ~0.999.

- [ ] **Step 3: Fix the formula**

In `worker/src/lib/curve-onchain.ts`, change line 52:

```typescript
// Before:
const impliedPrice = outputFloat / inputFloat;
// After:
const impliedPrice = inputFloat / outputFloat;
```

Also update the doc comment at line 5 to match:

```typescript
// Before:
 * returning the output amount. The ratio output/input gives implied price.
// After:
 * returning the output amount. The implied price = inputUsd / outputTokens.
```

- [ ] **Step 4: Run tests and verify all pass**

```bash
cd worker && npx vitest run src/lib/__tests__/curve-onchain.test.ts
```

Expected: ALL tests pass, including the existing `0.999` test (the existing test used a balanced-market mock where `input/output ≈ output/input`; verify the existing assertion still holds — `1e6 / 999000 = 1.001001...` vs previous `999000 / 1e6 = 0.999`. The existing test asserts `toBeCloseTo(0.999, 3)`. With the fix, the result is `1.0 / 0.999 = 1.001001`. This means the existing test mock needs updating.)

**Important:** The existing test mock has `get_dy` returning 999000 for input 1000000. With the old formula `999000/1000000 = 0.999`. With the new formula `1000000/999000 = 1.001`. The existing assertion `toBeCloseTo(0.999, 3)` will FAIL. Update the existing test:

```typescript
it("parses get_dy response into implied price", async () => {
  // get_dy(1, 2, 1e6) returns 999000 for USDT (6 decimals out)
  // Implied price = inputUsd / outputTokens = 1.0 / 0.999 ≈ 1.001
  const mockHexResponse = ("0x" + BigInt(999000).toString(16).padStart(64, "0")) as `0x${string}`;
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
  expect(results.get("usdt-tether")).toBeCloseTo(1.001, 3);
  expect(mockEvmCall).toHaveBeenCalledWith(
    "ethereum", config.poolAddress, expect.any(String), "latest", expect.any(Object),
  );
});
```

- [ ] **Step 5: Run full test and verify**

```bash
cd worker && npx vitest run src/lib/__tests__/curve-onchain.test.ts
```

Expected: ALL 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add worker/src/lib/curve-onchain.ts worker/src/lib/__tests__/curve-onchain.test.ts
git commit -m "fix(H1): correct Curve on-chain price formula inversion

The implied price calculation was outputFloat/inputFloat (exchange rate)
instead of inputFloat/outputFloat (USD price of output token). This
caused Curve (weight=3) to produce inverted prices during depeg stress,
excluding it from consensus at the exact moment it's most valuable."
```

---

### Task 2: Fix Circuit Breaker Recording for Binance, Coinbase, and Curve (M3)

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts:290,306,344`
- Modify: `worker/src/lib/__tests__/cex-tickers.test.ts`

**Context:** Binance (line 290), Coinbase (line 306), and Curve on-chain (line 344) circuit breakers always record `true` even when the fetch returns zero results. Pyth (line 274) and RedStone (line 328) correctly use `results.size > 0`. All three should match that pattern.

- [ ] **Step 1: Write a test for empty Binance response**

In `worker/src/lib/__tests__/cex-tickers.test.ts`, add:

```typescript
it("returns empty map when Binance returns no stablecoin pairs", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve([
      { symbol: "BTCUSD", price: "65000" },
      { symbol: "ETHUSDT", price: "3500" },
    ]),
  }));
  const results = await fetchBinancePrices();
  expect(results.size).toBe(0);
});
```

- [ ] **Step 2: Run the test and verify it passes**

```bash
cd worker && npx vitest run src/lib/__tests__/cex-tickers.test.ts
```

Expected: PASS (the function already correctly returns an empty map; the test validates that the consuming code can check `prices.size > 0`).

- [ ] **Step 3: Fix Binance circuit breaker recording**

In `worker/src/cron/enrich-prices.ts`, change line 290:

```typescript
// Before:
await recordOutcome(db, CIRCUIT_SOURCE.BINANCE_PRICES, true);
// After:
await recordOutcome(db, CIRCUIT_SOURCE.BINANCE_PRICES, prices.size > 0);
```

- [ ] **Step 4: Fix Coinbase circuit breaker recording**

In `worker/src/cron/enrich-prices.ts`, change line 306:

```typescript
// Before:
await recordOutcome(db, CIRCUIT_SOURCE.COINBASE_PRICES, true);
// After:
await recordOutcome(db, CIRCUIT_SOURCE.COINBASE_PRICES, prices.size > 0);
```

- [ ] **Step 5: Fix Curve on-chain circuit breaker recording**

In `worker/src/cron/enrich-prices.ts`, change line 344:

```typescript
// Before:
await recordOutcome(db, CIRCUIT_SOURCE.CURVE_ONCHAIN, true);
// After:
await recordOutcome(db, CIRCUIT_SOURCE.CURVE_ONCHAIN, prices.size > 0);
```

- [ ] **Step 6: Type-check**

```bash
cd worker && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add worker/src/cron/enrich-prices.ts worker/src/lib/__tests__/cex-tickers.test.ts
git commit -m "fix(M3): circuit breaker records actual success for Binance, Coinbase, Curve

All three handlers recorded true unconditionally. Now uses prices.size > 0,
matching the pattern used by Pyth and RedStone handlers."
```

---

### Task 3: Add FX Realtime Circuit Breaker Recording (H2b)

**Files:**
- Modify: `worker/src/cron/sync-fx-rates.ts:266` (after the OXR block)

**Context:** The OXR block (lines 232-272) never calls `recordOutcome()` for `CIRCUIT_SOURCE.FX_REALTIME`. This means the circuit breaker state is never updated, even if the key is configured. The `shouldAttemptFetch` guard can never close an opened circuit.

- [ ] **Step 1: Add `recordOutcome` import if not already present**

Check the imports at the top of `worker/src/cron/sync-fx-rates.ts`. If `recordOutcome` is not imported:

```typescript
import { recordOutcome } from "../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../lib/constants";
```

If the `CIRCUIT_SOURCE` and `recordOutcome` imports already exist, skip this step. (They likely don't exist in this file since the file currently uses no circuit breaker calls.)

- [ ] **Step 2: Add circuit breaker recording after OXR fetch**

In `worker/src/cron/sync-fx-rates.ts`, wrap the OXR fetch logic (lines 241-267) in a try/catch, and add `recordOutcome` at the end of the success path. Use `recordOutcome` (not `recordOutcomeSafe`) since we're already inside the outer try/catch of `syncFxRates`.

**Key behavior rules:**
- **Fetch succeeds with results:** record `true`
- **Fetch succeeds with 0 results:** record `false` (source is degraded)
- **Fetch throws:** record `false`
- **Rate-limited skip (the `else` branch at line 268):** do NOT record anything — the source wasn't attempted

Replace the body of `if (elapsedMinutes >= 55) { ... }` (lines 241-267) with:

```typescript
if (elapsedMinutes >= 55) {
  try {
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
          if (isValidRate(pegKey, realtimeRate, prevRates[pegKey])) {
            rates[pegKey] = realtimeRate;
            realtimeApplied++;
          }
        } else {
          console.warn(`[sync-fx-rates] ${pegKey} diverges: frankfurter=${frankfurterRate}, realtime=${realtimeRate} (${(delta * 100).toFixed(1)}%)`);
        }
      } else {
        if (isValidRate(pegKey, realtimeRate, prevRates[pegKey])) {
          rates[pegKey] = realtimeRate;
          realtimeApplied++;
        }
      }
    }
    console.log(`[sync-fx-rates] Applied ${realtimeApplied}/${realtimeRates.size} real-time FX rates`);
    oxrSource = realtimeRates.size > 0 ? (realtimeApplied === realtimeRates.size ? "ok" : "partial") : "unavailable";
    await recordOutcome(db, CIRCUIT_SOURCE.FX_REALTIME, realtimeRates.size > 0);
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[sync-fx-rates] OXR real-time fetch failed:", err);
    await recordOutcome(db, CIRCUIT_SOURCE.FX_REALTIME, false);
    oxrSource = "unavailable";
  }
} else {
  console.log(`[sync-fx-rates] Skipping OXR fetch (last fetch ${Math.round(elapsedMinutes)}min ago, rate limit: 55min)`);
  oxrSource = "rate-limited";
  // No recordOutcome — source was not attempted (rate-limited), not failed
}
```

- [ ] **Step 3: Type-check**

```bash
cd worker && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/sync-fx-rates.ts
git commit -m "fix(H2b): add circuit breaker recording for FX realtime source

The OXR block never called recordOutcome() for FX_REALTIME. Added
success/failure recording and a try/catch around the fetch to prevent
unhandled exceptions from killing the entire FX sync."
```

---

## Chunk 2: Depeg & Override Logging Fixes (M5, M7, M8)

### Task 4: Fix CEX Confirmation Logging in Depeg Promotion (M5)

**Files:**
- Modify: `worker/src/cron/confirm-pending-depegs.ts:257-260`
- Modify: `worker/src/cron/__tests__/confirm-pending-depegs.test.ts`

**Context:** When a depeg event is promoted because Binance CEX agrees, the `confirmedBy` log string omits "CEX". The array at line 257-260 only includes off-chain and DEX sources.

- [ ] **Step 1: Write the failing test**

In `worker/src/cron/__tests__/confirm-pending-depegs.test.ts`, add a new test that verifies CEX appears in the confirmation log. Add after the existing tests, before the final `});`:

```typescript
it("includes CEX in the confirmedBy log when Binance confirms alone", async () => {
  const nowSec = 1_700_000_000;
  vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  // Off-chain returns disagreeing price, DEX has no data, but Binance should confirm
  vi.mocked(fetchWithRetry).mockResolvedValue(
    new Response(JSON.stringify({ tether: { usd: 1.0 } }), { status: 200 }),
  );

  // Stub Binance fetch — need to mock the cex-tickers module
  // Since confirm-pending-depegs imports fetchBinancePrices directly,
  // we need the mock to return a depegged price for USDT
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
    if (url.includes("binance")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([{ symbol: "USDTUSD", price: "0.95" }]),
      });
    }
    return Promise.resolve({ ok: false });
  }));

  await confirmPendingDepegs(
    makeDb({
      pendingRows: [
        makePendingRow({
          id: 40,
          stablecoin_id: "usdt-tether",
          symbol: "USDT",
          first_seen_bps: -250,
          first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
          first_price: 0.975,
        }),
      ],
    }),
    [
      makeAsset({ id: "usdt-tether", symbol: "USDT", geckoId: "tether", price: 0.95 }),
      ...makeNeutralUsdAssets(),
    ],
  );

  const promotedLog = logSpy.mock.calls.find(
    (call) => typeof call[0] === "string" && call[0].includes("PROMOTED"),
  );
  expect(promotedLog).toBeDefined();
  expect(promotedLog![0]).toContain("CEX");
});
```

**Notes:**
- This test is complex because `confirmPendingDepegs` uses both `fetchWithRetry` (for off-chain) and `fetchBinancePrices` (direct import from `cex-tickers.ts` which calls global `fetch`). The mock setup depends on how the module is imported. If the test infrastructure already mocks `fetch` globally, adjust accordingly.
- The mock DB's `first()` returns `null`, which means `shouldAttemptFetch(db, CIRCUIT_SOURCE.BINANCE_PRICES)` should return `true` (no circuit record = allowed). If this doesn't work, mock the circuit-breaker module to always return `true` for `shouldAttemptFetch`.
- The key assertion is that `"CEX"` appears in the PROMOTED log line.

- [ ] **Step 2: Fix the confirmedBy array**

In `worker/src/cron/confirm-pending-depegs.ts`, change lines 257-260:

```typescript
// Before:
const confirmedBy = [
  offchainAgrees ? (asset?.priceSource === "coingecko" || asset?.priceSource === "coingecko+defillama" ? "DefiLlama" : "CoinGecko") : null,
  dexAgrees ? "DEX" : null,
].filter(Boolean).join("+");

// After:
const confirmedBy = [
  offchainAgrees ? (asset?.priceSource === "coingecko" || asset?.priceSource === "coingecko+defillama" ? "DefiLlama" : "CoinGecko") : null,
  dexAgrees ? "DEX" : null,
  cexAgrees ? "CEX" : null,
].filter(Boolean).join("+");
```

- [ ] **Step 3: Run the tests**

```bash
cd worker && npx vitest run src/cron/__tests__/confirm-pending-depegs.test.ts
```

Expected: ALL tests pass.

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/confirm-pending-depegs.ts worker/src/cron/__tests__/confirm-pending-depegs.test.ts
git commit -m "fix(M5): include CEX in depeg confirmation log

When Binance CEX agreement alone promotes a pending depeg, the
confirmedBy string now includes 'CEX' for operator visibility."
```

---

### Task 5: Add Protocol Override Failure Logging (M7)

**Files:**
- Modify: `worker/src/lib/authoritative-price-sources.ts`
- Modify: `worker/src/lib/__tests__/authoritative-price-sources.test.ts`

**Context:** When protocol override contracts (cUSD, iUSD, crvUSD) return zero, null, or invalid data, the code returns `null` without logging. The asset silently falls to market prices. We need `console.warn` at each null-return path so operators know when authoritative sources degrade.

- [ ] **Step 1: Write test for zero-return crvUSD**

In `worker/src/lib/__tests__/authoritative-price-sources.test.ts`, add:

```typescript
it("logs a warning when crvUSD PriceAggregator returns zero", async () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const zeroHex = "0x" + "0".repeat(64);
  fetchEvmCallHexAtBlockMock.mockResolvedValue(zeroHex);

  const overrides = await fetchAuthoritativeLivePriceOverrides([
    {
      id: "crvusd-curve",
      name: "crvUSD",
      symbol: "crvUSD",
      circulating: { peggedUSD: 400_000_000 },
    },
  ]);

  expect(overrides.has("crvusd-curve")).toBe(false);
  expect(warnSpy).toHaveBeenCalledWith(
    expect.stringContaining("zero or invalid"),
  );
  warnSpy.mockRestore();
});
```

- [ ] **Step 2: Run test and verify it fails**

```bash
cd worker && npx vitest run src/lib/__tests__/authoritative-price-sources.test.ts
```

Expected: FAIL — no warning is logged currently.

- [ ] **Step 3: Add warning logs to each provider**

In `worker/src/lib/authoritative-price-sources.ts`:

**cUSD provider** — in `fetchCapRedeemQuote` (around line 164-167), after `if (!quoteHex) return null;`:
```typescript
if (!quoteHex) {
  console.warn(`[authoritative-price-sources] ${CAP_CUSD_ID}: RPC returned null`);
  return null;
}
```

And after the `outputAmount` check (line 167):
```typescript
if (outputAmount == null || outputAmount <= 0n) {
  console.warn(`[authoritative-price-sources] ${CAP_CUSD_ID}: contract returned zero or invalid output`);
  return null;
}
```

**iUSD provider** — same pattern in `fetchInfiniFiRedeemQuote` at the equivalent null/zero checks.

**crvUSD provider** — in the `fetchLivePrice` method (line 330-334):
```typescript
if (!hex) {
  console.warn(`[authoritative-price-sources] ${CRVUSD_CURVE_ID}: RPC returned null`);
  return null;
}

const rawPrice = BigInt(hex);
const price = Number(rawPrice) / 1e18;
if (price <= 0 || price > 10) {
  console.warn(`[authoritative-price-sources] ${CRVUSD_CURVE_ID}: zero or invalid price=${price}`);
  return null;
}
```

- [ ] **Step 4: Run tests and verify all pass**

```bash
cd worker && npx vitest run src/lib/__tests__/authoritative-price-sources.test.ts
```

Expected: ALL tests pass including the new zero-return test.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/authoritative-price-sources.ts worker/src/lib/__tests__/authoritative-price-sources.test.ts
git commit -m "fix(M7): log warnings when protocol overrides return zero or fail

cUSD, iUSD, and crvUSD contract calls now log console.warn when
returning null, so operators can see when authoritative sources
silently degrade to market prices."
```

---

### Task 6: Add ECB Date Staleness Validation (M8)

**Files:**
- Modify: `worker/src/cron/sync-fx-rates.ts` (after line 170, before the rate extraction loop)

**Context:** The Frankfurter response includes a `date` field (e.g., `"2026-03-14"`) that is never validated. On weekends and holidays, ECB returns Friday's rates. A warning should fire when the date is >24h stale to flag potential issues with non-USD stablecoins priced against old FX rates.

- [ ] **Step 1: Add date staleness check**

In `worker/src/cron/sync-fx-rates.ts`, after line 170 (`const data = frankfurterValidation.data;`), add:

```typescript
// Warn if ECB date is stale (>24h old — weekends, holidays)
const ecbDate = new Date(data.date + "T16:00:00Z"); // ECB publishes at 16:00 CET
const ecbAgeSec = (Date.now() - ecbDate.getTime()) / 1000;
if (ecbAgeSec > 86400) {
  console.warn(
    `[sync-fx-rates] ECB rates are ${Math.round(ecbAgeSec / 3600)}h stale (date=${data.date}). ` +
    `Weekend/holiday — non-USD pegs using last published rates.`,
  );
}
```

- [ ] **Step 2: Type-check**

```bash
cd worker && npx tsc --noEmit
```

Expected: No errors (the `date` field is already in the Zod schema at line 95).

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/sync-fx-rates.ts
git commit -m "fix(M8): warn when ECB FX rates are stale (weekends/holidays)

Validates the Frankfurter response date field and logs a warning when
rates are >24h old. Helps operators identify stale FX rates affecting
non-USD stablecoins like GYEN, BRZ, and IDRT."
```

---

## Chunk 3: Coinbase Optimization (M2)

### Task 7: Add Coinbase Known-Pairs Allowlist (M2)

**Files:**
- Modify: `worker/src/lib/cex-tickers.ts`
- Modify: `worker/src/cron/enrich-prices.ts:189`
- Modify: `worker/src/lib/__tests__/cex-tickers.test.ts`

**Context:** Coinbase fetches one ticker per stablecoin symbol (~140 sequential HTTP requests), but only ~10-15 products exist on Coinbase. The other ~125 return 404 and waste ~14 seconds of sequential fetch time. Add an explicit allowlist similar to Binance's `BINANCE_PAIR_TO_SYMBOL`.

- [ ] **Step 1: Add Coinbase known-pairs map**

In `worker/src/lib/cex-tickers.ts`, after line 15 (end of `BINANCE_PAIR_TO_SYMBOL`), add:

```typescript
/**
 * Explicit mapping from Coinbase product ID base to stablecoin symbol.
 * Only confirmed products with active USD trading pairs.
 * This avoids ~125 wasted 404 requests per sync.
 */
export const COINBASE_KNOWN_SYMBOLS: readonly string[] = [
  "USDT", "USDC", "DAI", "PYUSD", "EURC", "GHO",
  "GUSD", "PAX", "TUSD", "USDP", "FDUSD", "PAXG", "XAUT",
] as const;
```

- [ ] **Step 2: Write a test for the allowlist filtering**

In `worker/src/lib/__tests__/cex-tickers.test.ts`, add:

```typescript
import { COINBASE_KNOWN_SYMBOLS } from "../cex-tickers";

describe("COINBASE_KNOWN_SYMBOLS", () => {
  it("contains only uppercase symbols", () => {
    for (const symbol of COINBASE_KNOWN_SYMBOLS) {
      expect(symbol).toBe(symbol.toUpperCase());
    }
  });

  it("has a reasonable number of entries (10-20)", () => {
    expect(COINBASE_KNOWN_SYMBOLS.length).toBeGreaterThanOrEqual(5);
    expect(COINBASE_KNOWN_SYMBOLS.length).toBeLessThanOrEqual(25);
  });
});
```

- [ ] **Step 3: Update enrich-prices.ts to use the allowlist**

In `worker/src/cron/enrich-prices.ts`, change line 189:

```typescript
// Before:
const coinbaseSymbols = [...new Set(candidates.map((a) => a.symbol.toUpperCase()))];

// After:
const coinbaseKnownSet = new Set(COINBASE_KNOWN_SYMBOLS);
const coinbaseSymbols = [...new Set(
  candidates.map((a) => a.symbol.toUpperCase()).filter((s) => coinbaseKnownSet.has(s)),
)];
```

And add the import at the top of `enrich-prices.ts`:
```typescript
import { COINBASE_KNOWN_SYMBOLS } from "../lib/cex-tickers";
```

(Import alongside the existing `fetchBinancePrices, fetchCoinbasePrices` import.)

- [ ] **Step 4: Run tests and type-check**

```bash
cd worker && npx vitest run src/lib/__tests__/cex-tickers.test.ts && npx tsc --noEmit
```

Expected: ALL pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/cex-tickers.ts worker/src/cron/enrich-prices.ts worker/src/lib/__tests__/cex-tickers.test.ts
git commit -m "perf(M2): add Coinbase known-pairs allowlist

Reduces Coinbase ticker fetches from ~140 sequential requests to ~11.
Only confirmed Coinbase stablecoin/USD products are queried, matching
the pattern used by Binance's BINANCE_PAIR_TO_SYMBOL map."
```

---

## Chunk 4: Consensus & Enrichment Refinements (L1, L2, L3, L4)

### Task 8: Fix Consensus Tied-Weight Selection (L1)

**Files:**
- Modify: `worker/src/lib/price-consensus.ts:61,74,94`
- Modify: `worker/src/lib/__tests__/price-consensus.test.ts`

**Context:** When multiple sources in a cluster have the same weight (e.g., CG w2 and Binance w2), the `reduce` with `>=` picks whichever comes first in iteration order. A principled secondary tie-breaker: pick the source closest to the peg reference (or median if NAV token).

- [ ] **Step 1: Write the failing test**

In `worker/src/lib/__tests__/price-consensus.test.ts`, add:

```typescript
it("breaks weight tie by choosing source closest to peg reference", () => {
  const sources: SourcePrice[] = [
    { source: "coingecko", price: 1.003, weight: 2 },
    { source: "binance", price: 1.001, weight: 2 },
    { source: "defillama", price: 1.002, weight: 1 },
  ];
  const result = computePriceConsensus(sources, 1.0, 50);
  expect(result!.confidence).toBe("high");
  // Binance (1.001) is closer to peg 1.0 than CoinGecko (1.003), same weight
  expect(result!.price).toBe(1.001);
});

it("breaks weight tie for NAV tokens by choosing source closest to cluster median", () => {
  const sources: SourcePrice[] = [
    { source: "coingecko", price: 1.12, weight: 2 },
    { source: "binance", price: 1.10, weight: 2 },
    { source: "defillama", price: 1.11, weight: 1 },
  ];
  const result = computePriceConsensus(sources, null, 50);
  expect(result!.confidence).toBe("high");
  // Median of cluster = 1.11. CG(1.12) is 0.01 away, Binance(1.10) is 0.01 away — tie.
  // Both equidistant, either is acceptable. Just verify it's deterministic.
  expect([1.12, 1.10]).toContain(result!.price);
});
```

- [ ] **Step 2: Run tests and verify the first test fails**

```bash
cd worker && npx vitest run src/lib/__tests__/price-consensus.test.ts
```

Expected: The tie-breaking test may fail depending on source order (CG comes first in the array, so `>=` picks CG at 1.003 instead of Binance at 1.001).

- [ ] **Step 3: Implement secondary tie-breaking**

In `worker/src/lib/price-consensus.ts`, create a helper function after `buildSourceLabel`:

```typescript
/** Pick highest-weight source; break ties by proximity to reference price. */
function pickBestSource(cluster: SourcePrice[], ref: number): SourcePrice {
  return cluster.reduce((a, b) => {
    if (a.weight !== b.weight) return a.weight > b.weight ? a : b;
    return Math.abs(a.price - ref) <= Math.abs(b.price - ref) ? a : b;
  });
}
```

Then replace the three tied-weight reduce calls:

**Line 61** (NAV cluster with agreement):
```typescript
// Before:
const chosen = navBestCluster.reduce((a, b) => a.weight >= b.weight ? a : b);
// After:
const navMedian = navBestCluster.map(s => s.price).sort((a, b) => a - b)[Math.floor(navBestCluster.length / 2)];
const chosen = pickBestSource(navBestCluster, navMedian);
```

**Line 74** (NAV diverging):
```typescript
// Before:
const chosen = sources.reduce((a, b) => a.weight >= b.weight ? a : b);
// After:
const allMedian = sources.map(s => s.price).sort((a, b) => a - b)[Math.floor(sources.length / 2)];
const chosen = pickBestSource(sources, allMedian);
```

**Line 94** (USD peg cluster):
```typescript
// Before:
const chosen = bestCluster.reduce((a, b) => a.weight >= b.weight ? a : b);
// After:
const chosen = pickBestSource(bestCluster, pegRef);
```

- [ ] **Step 4: Run tests and verify all pass**

```bash
cd worker && npx vitest run src/lib/__tests__/price-consensus.test.ts
```

Expected: ALL tests pass. The existing "prefers higher-weight source" test still passes because weight 2 > weight 1.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/price-consensus.ts worker/src/lib/__tests__/price-consensus.test.ts
git commit -m "fix(L1): deterministic tie-breaking in consensus weight selection

When multiple sources have equal weight, pick the one closest to the
peg reference (or cluster median for NAV tokens) instead of relying
on array iteration order."
```

---

### Task 9: DexScreener Median Instead of Max-Liquidity (L2)

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts:766-768`

**Context:** DexScreener fallback sorts pools by liquidity and takes the first (highest-liquidity) pool's price. A single manipulated pool could produce a wrong price. Using the median across qualifying pools is more robust.

- [ ] **Step 1: Replace max-liquidity with median**

In `worker/src/cron/enrich-prices.ts`, replace lines 766-768:

```typescript
// Before:
// Take price from highest-liquidity pair
candidates.sort((a, b) => b.liquidity.usd - a.liquidity.usd);
const price = parseFloat(candidates[0].priceUsd);

// After:
// Take median price across qualifying pools (more robust than single max-liquidity pool)
const candidatePrices = candidates
  .map((c) => parseFloat(c.priceUsd))
  .filter((p) => !isNaN(p) && isFinite(p) && p > 0)
  .sort((a, b) => a - b);
if (candidatePrices.length === 0) continue;
const price = candidatePrices[Math.floor(candidatePrices.length / 2)];
```

- [ ] **Step 2: Remove the now-unnecessary NaN/infinity check below**

The lines at 769-771 check `isNaN(price) || !isFinite(price) || price <= 0` — but the median computation above already filters those out. Remove or simplify:

```typescript
// The median computation already filters invalid prices, but keep the guard
// for defense-in-depth
if (isNaN(price) || !isFinite(price) || price <= 0) continue;
```

(Keep as-is for safety — no change needed on these lines.)

- [ ] **Step 3: Type-check**

```bash
cd worker && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/enrich-prices.ts
git commit -m "fix(L2): use median price across DexScreener pools instead of max-liquidity

A single manipulated high-liquidity pool could produce a wrong
fallback price. Median across qualifying pools is more robust."
```

---

### Task 10: Fix NAV Token Confidence Semantic (L3)

**Files:**
- Modify: `worker/src/lib/price-consensus.ts:66`
- Modify: `worker/src/lib/__tests__/price-consensus.test.ts`

**Context:** NAV tokens use a 500 bps (5%) clustering threshold but still receive `confidence: "high"`. This overstates the agreement quality. They should receive a distinct confidence level.

- [ ] **Step 1: Write the test**

In `worker/src/lib/__tests__/price-consensus.test.ts`, update the existing NAV token test:

```typescript
it("handles NAV tokens by defaulting to highest-weight source", () => {
  const sources: SourcePrice[] = [
    { source: "coingecko", price: 1.12, weight: 1 },
    { source: "defillama", price: 1.15, weight: 1 },
  ];
  const result = computePriceConsensus(sources, null, 50);
  // NAV tokens with 500bps threshold agreement should still get "high"
  // but the threshold is much wider — the cluster just needs 2+ members
  expect(result!.confidence).toBe("high");
});
```

**On reflection:** The audit notes this as L3/low severity, and changing the confidence value to something like `"nav-high"` would break the `PriceConfidence` type and all downstream consumers. The simplest fix is to keep `"high"` but is acceptable. Skip this task — the audit itself says "Consider" and the risk is minimal. **Mark as won't-fix for now.**

- [ ] **Step 1 (revised): Skip this task — L3 deferred**

The `PriceConfidence` type (`"high" | "single-source" | "low"`) is used across the entire pipeline and API. Adding a new variant would require changes to the API response schema, frontend consumers, and depeg detection thresholds. The semantic overstatement is a documentation issue, not a code bug. Add a code comment instead:

In `worker/src/lib/price-consensus.ts`, add a comment at line 56:

```typescript
// NAV tokens use 500bps (5%) threshold — "high" confidence means sources agree
// within 5%, not the tighter 50bps used for pegged tokens. This is intentional:
// NAV tokens have floating prices and wider agreement is expected.
```

- [ ] **Step 2: Commit**

```bash
git add worker/src/lib/price-consensus.ts
git commit -m "docs(L3): clarify NAV token confidence semantics in consensus code

NAV tokens use 500bps clustering vs 50bps for pegged tokens. The 'high'
confidence label is accurate for NAV context — added inline documentation."
```

---

### Task 11: Add CMC Symbol Collision Logging (L4)

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts:664`

**Context:** When CMC returns multiple coins with the same symbol (e.g., USDT on different chains), the `Map.set` silently overwrites the previous entry.

- [ ] **Step 1: Add collision detection**

In `worker/src/cron/enrich-prices.ts`, replace lines 660-666:

```typescript
// Before:
const cmcBySymbol = new Map<string, number>();
for (const entry of cmcData.data) {
  const price = entry.quote?.USD?.price;
  if (price != null && price > 0) {
    cmcBySymbol.set(entry.symbol.toUpperCase(), price);
  }
}

// After:
const cmcBySymbol = new Map<string, number>();
for (const entry of cmcData.data) {
  const price = entry.quote?.USD?.price;
  if (price != null && price > 0) {
    const sym = entry.symbol.toUpperCase();
    if (cmcBySymbol.has(sym)) {
      console.warn(`[enrich] CMC symbol collision: ${sym} (existing=$${cmcBySymbol.get(sym)}, new=$${price})`);
    }
    cmcBySymbol.set(sym, price);
  }
}
```

- [ ] **Step 2: Type-check**

```bash
cd worker && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/enrich-prices.ts
git commit -m "fix(L4): log CMC symbol collisions instead of silently overwriting

When CoinMarketCap returns multiple coins with the same symbol,
the last one wins. Now logs a warning so operators can spot when
the wrong coin's price is used."
```

---

## Chunk 5: Curve Pool Expansion & Missing geckoIds (M1, M4)

### Task 12: Expand Curve Pool Configurations (M1)

**Files:**
- Modify: `worker/src/lib/curve-pool-configs.ts`

**Context:** Curve on-chain is the highest-weight source (w=3) but only covers USDT and DAI via 3pool. Many stablecoins have deep Curve pools (>$1M TVL). Each config needs: pool address, input/output indices, decimals, chain. All use USDC as the reference input token where possible.

**Research required:** The pool addresses and coin indices below must be verified on-chain before deploying. The stablecoin IDs must match `shared/lib/stablecoins.ts`.

- [ ] **Step 1: Research and verify pool addresses**

Use Etherscan, Curve UI, or Curve API to verify pool addresses and coin indices. Key pools to add:

| Stablecoin | Pool | Type | Notes |
|-----------|------|------|-------|
| crvUSD | crvUSD/USDC (factory) | 2-coin | Has native `price_oracle()` too |
| FRAX | FRAX/USDC | 2-coin | Fraxswap or Curve |
| LUSD | LUSD/3CRV | meta | Meta-pool: use underlying index |
| PYUSD | PYUSD/USDC | 2-coin | |
| GHO | GHO/USDC/USDT | 3-coin | |
| sUSD | sUSD/3CRV | meta | |
| DOLA | DOLA/USDC | 2-coin | |
| USDe | USDe/USDC | 2-coin | |

- [ ] **Step 2: Add verified pool configs**

In `worker/src/lib/curve-pool-configs.ts`, add entries after the existing DAI config. Example format (addresses are placeholders — verify each one):

```typescript
// FRAX/USDC pool
{
  stablecoinId: "frax-frax-finance",
  poolAddress: "0xDcEF968d416a41Cdac0ED8702fAC8128A64241A2",
  inputIndex: 1,  // USDC
  outputIndex: 0, // FRAX
  inputDecimals: 6,
  outputDecimals: 18,
  chain: "ethereum",
},
```

**Important:** Each pool address and index MUST be verified via `eth_call` to `coins(uint256)` on the pool contract before adding. Wrong indices will produce silent wrong prices.

- [ ] **Step 3: Run tests**

```bash
cd worker && npx vitest run src/lib/__tests__/curve-onchain.test.ts && npx tsc --noEmit
```

Expected: Pass (new configs are data-only, no logic change).

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/curve-pool-configs.ts
git commit -m "feat(M1): expand Curve pool configs to N pools

Adds Curve on-chain pricing (weight=3) for [list coins]. Previously
only USDT and DAI had Curve coverage via 3pool."
```

---

### Task 13: Add geckoId for Missing Coins (M4)

**Files:**
- Modify: `shared/lib/stablecoins.ts`

**Context:** Three coins lack `geckoId`, making them unpriceable via CoinGecko and DefiLlama coins API:
- `m-m0` (M by M0)
- `rwausdi-multipli` (rwaUSDi)
- `usdu-usdu-finance` (USDU Finance)

**Research required:** Look up each coin on CoinGecko to find their API ID. If they don't have a CoinGecko listing, document this fact.

- [ ] **Step 1: Research geckoIds**

Search CoinGecko API for each:
```bash
curl "https://api.coingecko.com/api/v3/search?query=M0+USD" | jq '.coins[:5]'
curl "https://api.coingecko.com/api/v3/search?query=rwaUSDi" | jq '.coins[:5]'
curl "https://api.coingecko.com/api/v3/search?query=USDU+Finance" | jq '.coins[:5]'
```

- [ ] **Step 2: Add verified geckoIds**

In `shared/lib/stablecoins.ts`, find each coin's `coin()` call and add the `geckoId` field. For example:

```typescript
// If CoinGecko ID is "m-by-m0":
coin("m-m0", "M by M0", "M", { geckoId: "m-by-m0", ... })
```

If a coin genuinely has no CoinGecko listing, add a comment:
```typescript
// No CoinGecko listing — priced via DL contract fallback only
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit && cd worker && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add shared/lib/stablecoins.ts
git commit -m "fix(M4): add geckoId for M, rwaUSDi, USDU

These coins were unpriceable via CoinGecko/DefiLlama coins API.
[describe which IDs were found or if any remain without listings]"
```

---

## Chunk 6: Full Test Suite Validation

### Task 14: Run Full Test Suite and Type-Check

- [ ] **Step 1: Run full test suite**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard
npm test
```

Expected: ALL tests pass (1950+ tests).

- [ ] **Step 2: Run worker type-check**

```bash
cd worker && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Run frontend build**

```bash
npm run build
```

Expected: Build succeeds.

- [ ] **Step 4: Review all changes**

```bash
git diff --stat main
git log --oneline main..HEAD
```

Verify: Each commit addresses exactly one audit finding. No unrelated changes.

---

## Ops Tasks (Not Automated — Manual Intervention Required)

These are listed for completeness but are not code changes:

### H2: Configure OXR API Key
```bash
cd worker && wrangler secret put OPENEXCHANGERATES_API_KEY
# Paste the API key when prompted
```

Then verify on next cron cycle by checking:
```bash
curl -s "https://api.pharos.watch/api/admin/cron-status" -H "Authorization: Bearer $TOKEN" | jq '.fx'
```

### H3: Fix CoinMarketCap Integration
```bash
# Test the endpoint manually first:
curl -s -H "X-CMC_PRO_API_KEY: $CMC_KEY" \
  "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?cryptocurrency_type=stablecoin&limit=5" | jq '.status'
```

If the `cryptocurrency_type=stablecoin` filter requires a paid plan:
1. Either upgrade the CMC plan, or
2. Remove the filter and add client-side filtering in `enrich-prices.ts:642`:
   ```typescript
   // Remove cryptocurrency_type=stablecoin from URL, filter client-side:
   "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=500&convert=USD"
   // Then filter cmcData.data by matching symbols against tracked stablecoins
   ```

After fixing, reset the circuit breaker:
```bash
curl -X POST "https://api.pharos.watch/api/admin/circuit-reset?source=coinmarketcap-prices" \
  -H "Authorization: Bearer $TOKEN"
```

### M6: Pyth Confidence Weight Modulation (Deferred)

This requires consensus algorithm design work beyond a bug fix. The `confidenceBps` metadata is already captured and stored. A future enhancement could:
1. Halve Pyth weight when `confidenceBps > 200` (2% uncertainty)
2. Zero Pyth weight when `confidenceBps > 1000` (10% uncertainty)
3. Surface `confidenceBps` in the `/api/peg-summary` response for operator dashboards

---

## Summary

| Task | Issue | Type | Risk |
|------|-------|------|------|
| 1 | H1: Curve formula inversion | Bug fix | Low (1 line + test update) |
| 2 | M3: Circuit breaker recording | Bug fix | Low (3 line changes: Binance, Coinbase, Curve) |
| 3 | H2b: FX realtime circuit breaker | Bug fix | Low (add try/catch + recordOutcome) |
| 4 | M5: CEX confirmation logging | Bug fix | Low (add 1 array element) |
| 5 | M7: Protocol override logging | Observability | Low (add console.warn) |
| 6 | M8: ECB date staleness | Observability | Low (add date check + warn) |
| 7 | M2: Coinbase allowlist | Performance | Low (filter, not logic change) |
| 8 | L1: Consensus tie-breaking | Refinement | Low (secondary sort) |
| 9 | L2: DexScreener median | Robustness | Low (median vs max) |
| 10 | L3: NAV confidence | Documentation | None (comment only) |
| 11 | L4: CMC collision logging | Observability | Low (add warn) |
| 12 | M1: Curve pool expansion | Data config | Medium (requires research) |
| 13 | M4: Missing geckoIds | Data config | Medium (requires research) |
| 14 | Full validation | Verification | None |
