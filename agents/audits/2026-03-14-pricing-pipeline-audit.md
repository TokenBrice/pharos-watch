# Pricing Pipeline Audit Report

**Date:** 2026-03-14
**Scope:** Full audit of the P0-P7 pricing pipeline upgrade: source modules, consensus engine, price validation, enrichment pipeline, authoritative overrides, depeg detection, FX rates, and stablecoin metadata.
**Method:** Code review of all pricing-related files, live API verification, test suite validation, 6 parallel deep-dive audits.

---

## Executive Summary

The P0-P7 pricing pipeline upgrade is a **substantial improvement** over the prior 2-source (CG+DL) system. The architecture is well-designed, the orchestration is sound, and the test suite (1950 tests, all passing) provides broad coverage. However, the audit uncovered **3 high-severity issues that must be fixed**, **2 operational failures in production**, and several medium-priority findings.

### Live Production State

| Metric | Value |
|--------|-------|
| Coins in peg-summary | 140 |
| High confidence | 135 (96.4%) |
| Single-source | 4 (2.9%) |
| Low confidence | 1 (0.7%) |
| Active depegs | 10 |
| All tests | 1950 PASS |
| Worker type-check | PASS |

**Circuit breaker health (pricing sources):**

| Source | State | Notes |
|--------|-------|-------|
| CoinGecko | Closed | Healthy |
| DefiLlama coins | Closed | Healthy |
| Pyth | Closed | Healthy |
| Binance | Closed | Healthy |
| Coinbase | Closed | Healthy |
| RedStone | Closed | Healthy |
| Curve on-chain | Closed | Healthy |
| DexScreener | Closed | Healthy |
| **CoinMarketCap** | **OPEN** | **Never succeeded (lastSuccessAt: null)** |
| **FX realtime (OXR)** | Closed | **Never invoked (lastSuccessAt: null, lastFailureAt: null)** |

---

## HIGH Severity

### H1: Curve On-Chain Price Formula Is Inverted

**File:** `worker/src/lib/curve-onchain.ts:52`
**Impact:** Curve (weight=3, highest in the pipeline) produces systematically wrong prices during stress conditions.

The implied price calculation is:
```typescript
const impliedPrice = outputFloat / inputFloat;  // WRONG
```

This computes the **exchange rate** (how many output tokens per input token), not the **USD price of the output token**. The correct formula is:
```typescript
const impliedPrice = inputFloat / outputFloat;  // CORRECT
```

**Why it matters:**
- **Balanced markets (normal):** Error is ~4 bps (within the swap fee). Curve clusters with other sources. No practical impact.
- **Stress conditions (depeg):** If USDT depegs to $0.95, Curve would report ~$1.053 instead of ~$0.95. This is 1000+ bps from other sources, causing Curve to be **excluded from consensus** at the exact moment its high-confidence data is most valuable.
- **Net effect:** Curve's weight-3 advantage is wasted during every depeg. The highest-weight source becomes anti-correlated with true prices under stress.

**Evidence:** Production currently shows USDT at `binance+7more` (8 sources) including Curve. This works because pools are balanced and the ~4 bps error is within the 50 bps consensus threshold. The bug would manifest during an actual depeg.

**Fix:** Change line 52 to `const impliedPrice = inputFloat / outputFloat;`

---

### H2: Real-Time FX Source (P0) Never Activated In Production

**File:** `worker/src/cron/sync-fx-rates.ts:232-272`
**Impact:** All 30 non-USD stablecoins across 16 currencies still rely on ECB daily rates only. The P0 improvement is deployed in code but non-functional.

**Evidence:** The `fx-realtime` circuit breaker shows:
```json
{
  "state": "closed",
  "consecutiveFailures": 0,
  "lastFailureAt": null,
  "lastSuccessAt": null
}
```

Two issues:
1. ~~**API key likely not configured**~~ **CORRECTED (2026-03-14):** The `OPENEXCHANGERATES_API_KEY` secret IS configured in production. The audit incorrectly inferred "not configured" from the circuit breaker state. The code path `quarter-hourly.ts:43` → `syncFxRates(db, signal, env.OPENEXCHANGERATES_API_KEY)` → `fetchRealtimeFxRates(apiKey, signal)` passes the key correctly. Authentication uses `?app_id=KEY` query parameter, matching OXR docs.
2. **Circuit breaker never recorded:** `syncFxRates()` never calls `recordOutcome()` for `CIRCUIT_SOURCE.FX_REALTIME`. The circuit exists but is vestigial. This is why the circuit breaker showed `lastSuccessAt: null` — the source is likely running but has no observability.

**Consequence for GYEN, A7A5, BRZ, IDRT, ZARP:** These coins depend on once-daily ECB rates (published at 16:00 CET). Intraday FX moves, weekends, and Asian-hours JPY volatility are invisible. GYEN currently shows -2056 bps deviation with an active depeg — this may be exaggerated by a stale JPY reference.

**Fix:**
1. ~~Configure the Open Exchange Rates API key in production~~ — already configured.
2. Add circuit breaker outcome recording for `FX_REALTIME` in `syncFxRates()` to gain observability into the OXR code path.

---

### H3: CoinMarketCap Enrichment Permanently Broken (P7)

**File:** `worker/src/cron/enrich-prices.ts:614-702`
**Impact:** Pass 2 enrichment (CMC batch listings) has never successfully executed. Assets that need fallback pricing beyond DefiLlama skip directly to DexScreener.

**Evidence:** The `coinmarketcap-prices` circuit breaker:
```json
{
  "state": "open",
  "consecutiveFailures": 3,
  "lastSuccessAt": null,
  "lastFailureAt": 1773478924
}
```

The CMC API key IS configured (the code reaches the fetch), but every attempt fails. Possible causes:
- The `cryptocurrency_type=stablecoin` filter may require a paid plan
- The API key may be invalid or expired
- The Pro API endpoint may reject the free-tier key for `listings/latest`

**Fix:** Verify the CMC API key and plan tier. Test the endpoint manually: `curl -H "X-CMC_PRO_API_KEY: $KEY" "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?cryptocurrency_type=stablecoin&limit=5"`. If the free tier doesn't support this filter, either upgrade or remove `cryptocurrency_type=stablecoin` and filter client-side.

---

## MEDIUM Severity

### M1: Only 2 Curve Pool Configurations (Severely Under-Deployed P5)

**File:** `worker/src/lib/curve-pool-configs.ts`
**Impact:** The highest-weight source (w=3) covers only USDT and DAI. ~15+ stablecoins with deep Curve pools are missing.

Only configured:
- USDT via 3pool (USDC→USDT)
- DAI via 3pool (USDC→DAI)

Missing (have deep Curve pools >$1M TVL):
- crvUSD (has native `price_oracle()` but no `get_dy` config)
- FRAX / frxUSD
- LUSD
- PYUSD
- GHO
- sUSD
- DOLA
- BOLD
- USDe
- mkUSD

**Fix:** Expand `CURVE_POOL_CONFIGS` with pool addresses and indices for all stablecoins with >$1M Curve TVL. This is low-effort, high-reward.

---

### M2: Coinbase Makes ~140 Sequential HTTP Requests Per Sync

**File:** `worker/src/lib/cex-tickers.ts:60-84`, `worker/src/cron/enrich-prices.ts:189`
**Impact:** Wasted time and connection budget. Coinbase only has ~10-15 stablecoin/USD products; the other ~125 requests return 404.

```typescript
const coinbaseSymbols = [...new Set(candidates.map((a) => a.symbol.toUpperCase()))];
```

This sends a request for EVERY unique stablecoin symbol. At 100ms/request, that's ~14 seconds of sequential work within the sync cron.

**Contrast:** Binance uses an explicit `BINANCE_PAIR_TO_SYMBOL` map and fetches all tickers in a single batch call — clean and efficient.

**Fix:** Add a `COINBASE_KNOWN_PAIRS` allowlist (similar to Binance's map) containing only confirmed Coinbase stablecoin products: USDT-USD, USDC-USD, DAI-USD, PYUSD-USD, EURC-USD, etc. This would reduce ~140 requests to ~10-15.

---

### M3: Binance Circuit Breaker Always Records Success

**File:** `worker/src/cron/enrich-prices.ts:290`
**Impact:** If Binance returns HTTP 200 but an empty result set, the circuit breaker still records success. This masks degraded Binance availability.

```typescript
await recordOutcome(db, CIRCUIT_SOURCE.BINANCE_PRICES, true);  // always true
```

**Contrast:** Pyth (line 274), RedStone (line 328), and Curve (line 344) all correctly use `results.size > 0`.

**Fix:** Change to `await recordOutcome(db, CIRCUIT_SOURCE.BINANCE_PRICES, prices.size > 0);`

---

### M4: Three Coins Missing geckoId — Unpriceable

**File:** `shared/lib/stablecoins.ts`
**Coins:** `m-m0`, `rwausdi-multipli`, `usdu-usdu-finance`

These coins cannot be priced via CoinGecko (primary pricing API) or DefiLlama coins API (uses `coingecko:{geckoId}`). They fall through to enrichment or remain unpriced.

**Evidence:** Live peg-summary shows:
- M: `defillama-contract` (single-source) — priced via contract address fallback
- rwaUSDi: `defillama` (single-source)
- USDU: not in peg-summary (may be missing entirely)

**Fix:** Research and add correct geckoId for these three coins, or document why they lack one.

---

### M5: CEX Confirmation Not Logged in Depeg Promotion

**File:** `worker/src/cron/confirm-pending-depegs.ts:257-263`
**Impact:** When a depeg event is promoted by Binance CEX agreement alone, the `confirmedBy` log array omits the CEX source. Operator visibility reduced.

**Fix:** Add `cexAgrees ? "CEX" : null` to the `confirmedBy` array alongside the existing off-chain and DEX entries.

---

### M6: Pyth Confidence Intervals Captured But Unused

**File:** `worker/src/cron/enrich-prices.ts:373`
**Impact:** Pyth provides unique `confidenceBps` data (a leading indicator of market stress), but the consensus engine treats Pyth identically regardless of confidence width. A price with 5000 bps confidence (±50%) counts the same as one with 5 bps.

**Recommendation:** Consider using Pyth confidence to modulate weight in the consensus algorithm, or at minimum surface it in the API response for operator awareness. This was identified as a key differentiator in the research doc.

---

### M7: Protocol Override Silent on Zero/Failure

**File:** `worker/src/lib/authoritative-price-sources.ts`
**Impact:** When cUSD, iUSD, or crvUSD contracts return zero or fail, the code returns `null` without logging. The asset silently falls to market prices.

**Fix:** Add `console.warn` when protocol overrides return zero or invalid data.

---

### M8: No Frankfurter (ECB) Date Staleness Validation

**File:** `worker/src/cron/sync-fx-rates.ts`
**Impact:** The Frankfurter response includes a `date` field that is never checked. On weekends, ECB returns Friday's rates; no alert fires about the 48h+ staleness.

**Fix:** Validate that the ECB `date` is within 24h; log a warning when stale.

---

## LOW Severity

### L1: Consensus Tied-Weight Selection Is Arbitrary

**File:** `worker/src/lib/price-consensus.ts:61,74,94`

When multiple sources in a cluster have the same weight (e.g., CoinGecko w2 and Binance w2), the algorithm picks whichever comes first in array iteration order. This is deterministic but unprincipled.

**Impact:** No data corruption, but the chosen price may vary by a few bps depending on source order. Consider secondary tie-breaking (closest to peg reference).

---

### L2: DexScreener Enrichment Takes Highest-Liquidity Pool, Not Median

**File:** `worker/src/cron/enrich-prices.ts:768`

The DexScreener fallback sorts pools by liquidity and takes the first pool's price. A single manipulated high-liquidity pool could produce a wrong price. Using a median across qualifying pools would be more robust.

---

### L3: NAV Token Confidence Semantic Overstatement

**File:** `worker/src/lib/price-consensus.ts:55-82`

NAV tokens use a 500 bps clustering threshold but still receive `confidence: "high"`. Downstream consumers may assume tight agreement when there's actually 5% tolerance.

---

### L4: CMC Batch Doesn't Handle Symbol Collisions

**File:** `worker/src/cron/enrich-prices.ts:664`

When CMC returns multiple coins with the same symbol (e.g., USDT on different chains), the Map stores only the last one. No detection or logging of collisions.

---

### L5: Missing Test Coverage Across Modules

Several areas lack test coverage:
- Curve on-chain: no boundary price tests, no inversion test
- CEX tickers: no test for empty Binance response
- Consensus: no test for tied weights, equal-sized clusters, all-source divergence
- Confirm pending depegs: no CEX confirmation path tests
- Protocol overrides: no test for zero-return contracts

---

## Verified Correct

These areas were thoroughly reviewed and found to be correctly implemented:

| Area | Verdict |
|------|---------|
| N-source consensus algorithm (clustering, weight selection) | Correct (modulo H1 input) |
| Price validation ordering (before savePriceCache) | Correct |
| DefiLlama ID remap before enrichment | Correct |
| Post-remap canonical dedupe | Correct |
| Fallback sync path (DL down → CG supply) | Correct |
| setCacheIfNewer CAS guard | Correct |
| Depeg thresholds (100 bps USD, 150 bps non-USD) | Correct |
| Primary trust gates (authoritative/confirm_required/unusable) | Correct |
| DEX cross-validation ($1M TVL, 20-min freshness) | Correct |
| Two-stage depeg confirmation (large-cap, low-confidence, extreme-move) | Correct |
| Orphan cleanup (safe, won't close legitimate events) | Correct |
| Direction flip handling | Correct |
| Circuit breakers for all new sources | Correct and operational |
| Pyth feed ID normalization (lowercase, strip 0x) | Correct |
| Binance explicit pair mapping | Correct |
| RedStone exact-case allowlist | Correct |
| Source weights match documentation | Verified |
| Gold/silver from gold-api.com with cached fallback | Correct |
| FX delta validation (20% max change) | Correct |
| FX bounds validation per currency | Correct |
| Commodity token scaling (commodityOunces) | Correct |
| Supply-weighted peer median for gold/silver reference | Correct |

---

## Source Coverage Analysis (Live)

| Source | Status | Coins Covered |
|--------|--------|---------------|
| CoinGecko | Active | ~150 (primary) |
| DefiLlama | Active | ~140 (cross-validation) |
| Pyth | Active | 40 (oracle) |
| Binance | Active | 10 (direct CEX) |
| Coinbase | Active | 10-15 (direct CEX) |
| RedStone | Active | ~29 (venue breakdown) |
| Curve on-chain | Active | 2 (should be 15+) |
| DEX promoted | Active | ~40 (from dex_prices) |
| CMC batch | **Broken** | 0 (circuit open) |
| FX realtime | **Inactive** | 0 (key not configured) |

---

## Priority Action Items

| # | Severity | Issue | Effort |
|---|----------|-------|--------|
| 1 | HIGH | Fix Curve price formula inversion (H1) | 1 line change + test |
| 2 | ~~HIGH~~ RESOLVED | ~~Configure OXR API key in production (H2)~~ Key already configured | N/A |
| 3 | HIGH | Fix/verify CMC API key and endpoint (H3) | Investigation + config |
| 4 | MEDIUM | Expand Curve pool configs to 15+ pools (M1) | Research + config |
| 5 | MEDIUM | Add Coinbase known-pairs allowlist (M2) | Small code change |
| 6 | MEDIUM | Fix Binance circuit breaker (M3) | 1 line change |
| 7 | MEDIUM | Add geckoId for 3 missing coins (M4) | Research |
| 8 | MEDIUM | Fix CEX confirmation logging (M5) | 1 line change |
| 9 | MEDIUM | Add circuit breaker recording for fx-realtime (H2b) | Small code change |
| 10 | MEDIUM | Log protocol override failures (M7) | Small code change |
| 11 | LOW | Add missing tests for all identified gaps (L5) | Multiple test files |
