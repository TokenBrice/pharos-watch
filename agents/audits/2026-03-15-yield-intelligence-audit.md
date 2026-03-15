# Yield Intelligence Audit Report

**Date:** 2026-03-15
**Scope:** Full-stack audit of the yield safety feature — worker cron, API, frontend, tests, live data accuracy, and coverage expansion opportunities.

---

## Executive Summary

The yield intelligence pipeline is architecturally sound with a well-layered four-tier APY resolution system, confidence-weighted arbitration, comprehensive warning signals, and solid frontend presentation. However, the audit uncovered **1 confirmed data accuracy bug**, **3 high-severity reliability issues**, **6 medium-severity improvements**, and **several concrete coverage expansion opportunities**. The feature is a healthy base to build on, but the issues below should be addressed before expanding coin coverage.

**Live state (as of audit):** 64 coins ranked, risk-free rate 3.71%, median APY 4.11%.

---

## Part 1: Data Accuracy Issues

### 1.1 CRITICAL — Variant Symbol `.includes()` Matching Causes Cross-Contamination

**Files:** `worker/src/cron/yield-helpers.ts` (matchAllDlPools, Layer 2)
**Severity:** Critical — confirmed producing wrong data in production

Layer 2 variant symbol matching uses `.includes()` instead of exact match:

```typescript
const candidates = dlPools.filter(p => p.symbol.toLowerCase().includes(sym));
```

**Confirmed live impact:** USDa (Avalon) with variant `sUSDa` matches USD.AI's pool `sUSDai` because `"susdai".includes("susda") === true`. Live data shows DAI, USDa, and USD.AI all reporting identical APY (6.77% current, 6.6666% 30d) — a statistically impossible coincidence for three independent pools.

**Root cause:** Substring matching on short symbols. Any variant symbol that is a prefix of another will match the wrong pool.

**Other at-risk pairs:**
- Any future variant starting with common prefixes (sUSD, st, s)

**Fix:** Use exact match for Layer 2: `p.symbol.toLowerCase() === sym`. This is safe because variant symbols are curated and specific.

### 1.2 HIGH — Confidence Arbitration Suppresses Higher-APY Sources

**File:** `worker/src/cron/sync-yield-data.ts` (arbitration logic)
**Severity:** High — misleading "best" source in multiple live cases

The confidence tier system (deterministic > curated > discovered > fallback) means the `is_best` source is not always the highest-yielding option. Live examples:

| Coin | Best Source (curated) | Alt Source (discovered) | Delta |
|------|----------------------|------------------------|-------|
| FRXUSD | sfrxUSD: 4.25% | Auto: 10.26% | +141% |
| reUSD | stUSR: 2.43% | Auto: 9.92% | +308% |
| USDS | sUSDS: 3.75% | Auto: 4.14% | +10% |
| GHO | sGHO: 4.88% | Auto: 5.21% | +7% |

This is **by design** (curated sources are more reliable), but the user sees the lower APY as "best" while the higher one is buried in alt sources. The FRXUSD and reUSD gaps are particularly large and could indicate the auto-discovered sources have heavy reward incentives that inflate APY.

**Recommendation:** Don't change arbitration logic, but add a visual indicator on the yield page when an alt source has significantly higher APY than the best source. Consider a "higher yield available via lending" badge.

### 1.3 HIGH — Two Coins Stuck at 0% APY

**Live data:** `dusd-dtrinity` and `usn-noon` both show 0% APY persistently.

- **dUSD (dTRINITY):** Has Tier 1 on-chain config (sdUSD vault) AND variant map AND pool map. All three sources are returning 0%. Either the vault has genuinely 0% yield, or the on-chain exchange rate is not changing. Uses `DEFAULT_SAFETY_SCORE` (provenance confirms `usedDefaultSafety: true`).
- **USN (Noon):** Has variant map (sUSN) and pool map. DL pool is returning 0%.

**Recommendation:** Add monitoring/alerting when a previously-positive source drops to 0% for >24h. Consider hiding 0% coins from rankings or flagging them with a `zero-yield` warning signal.

---

## Part 2: Reliability Issues

### 2.1 HIGH — Risk-Free Rate Retained Without Fallback Flag

**File:** `worker/src/cron/fetch-tbill-rate.ts`

When FRED fetch fails and a previous rate exists, the code retains the old rate but keeps `isFallback: false`. This means:
1. A 5-day-old T-bill rate is marked as "not fallback"
2. `shouldDegradeForRiskFreeRate()` in sync-yield-data returns false
3. Yield sync quality is not degraded despite stale benchmark data

All PYS, excess yield, and rate-derived APY calculations silently use stale data.

**Fix:** Set `isFallback: true` when retaining a previous rate due to fetch failure. The `fallbackMode: "retained"` metadata is already set correctly — only the boolean flag is wrong.

### 2.2 HIGH — DL Pools Cache Has No Age Validation

**File:** `worker/src/cron/yield-sync/sources.ts`

The yield sync reads cached DL pools from the DEX liquidity cron but performs no age check. If `sync-dex-liquidity` fails for 24+ hours, yield sync silently uses arbitrarily old pool data. The circuit breaker only trips when DL pools are completely unavailable, not when they're stale.

**Fix:** Reject cached pools if age > 6 hours (3x the expected 2-hour refresh interval). Fall through to direct DL Yields API fetch when cache is too old.

### 2.3 HIGH — On-Chain Rate Failures Are Silent

**File:** `worker/src/cron/yield-sync/sources.ts`

When an on-chain `eth_call` returns null (timeout, contract upgrade, RPC issue), the code silently moves to the next tier. No warning is logged about the specific config that failed. If a vault contract is upgraded and the old address stops working, Tier 1 silently degrades to Tier 2 for that coin with no alert.

**Fix:** Log a warning when an on-chain config returns null, especially if it previously succeeded. Consider a `tier1-degraded` warning signal or provenance annotation.

### 2.4 MEDIUM — Tier 1 Previous Rate Lookup Uses Imprecise 7-Day Window

**File:** `worker/src/cron/yield-sync/resolve.ts`

The on-chain APY formula uses `(rate_now / rate_7d_ago) ^ (365.25/7) - 1`. The "7 days ago" rate is the most recent `yield_history` row with `recorded_at <= now - 7d`. If the most recent qualifying row is from 6.9 days ago, the formula still divides by 7.0 days, slightly underestimating APY.

**Fix:** Use `actualDays = (now - recordedAt) / 86400` instead of hardcoded 7.

### 2.5 MEDIUM — Legacy History Fallback Has No Age Guard

**File:** `worker/src/cron/sync-yield-data.ts`

Legacy `source_key = 'legacy-best'` history rows are used when a coin has a single resolved source and the legacy source family matches. But there's no maximum age check — 60-day-old legacy rows can still influence 30d trailing metrics, distorting variance and stability calculations.

**Fix:** Add check that legacy rows are not older than 35 days (30d window + 5d buffer).

### 2.6 MEDIUM — Cross-Source Divergence Detection Is One-Directional

**File:** `worker/src/cron/sync-yield-data.ts`

Divergence checking only flags lower-confidence candidates against the canonical reference. A higher-confidence source that diverges from curated sources is never flagged. Additionally, divergence is not detected when either APY is 0%.

**Example failure:** If on-chain reads 0% (contract issue) and DL reads 5%, no divergence is flagged because the canonical (on-chain) has 0% APY.

**Fix:** Check divergence bidirectionally. Flag when a deterministic source reads 0% but a curated source reads >1%.

---

## Part 3: Data Quality Improvements

### 3.1 MEDIUM — APY Variance Score Returns 0 for Near-Zero Means

**File:** `worker/src/cron/yield-helpers.ts` (computeApyVarianceScore)

When mean APY is < 1e-10, the function returns 0 (perfect stability). But a coin oscillating between 0% and 0.01% is not "stable" — it's just small. This flows into PYS via sustainability multiplier, artificially boosting scores for near-zero-yield coins.

**Fix:** Return `null` instead of 0 for near-zero means. Handle null downstream as "insufficient data" rather than "perfectly stable".

### 3.2 MEDIUM — No Outlier Removal in APY History Averaging

**File:** `worker/src/cron/sync-yield-data.ts`

The 30d APY average includes all historical samples without outlier filtering. A single spike permanently skews the 30d average until it ages out.

**Example:** 29 days at 3%, 1 day at 20% → average = 3.59% (20% above true baseline).

**Recommendation:** Consider IQR-based outlier removal or 10th/90th percentile trimming when samples > 5. Not urgent but would improve accuracy as coverage grows.

### 3.3 LOW — Warning Signal Thresholds Lack Absolute Floors

**File:** `worker/src/cron/yield-helpers.ts` (detectWarningSignals)

`yield-spike` triggers at 2x the 30d average, but for low-APY coins, small absolute changes trigger spurious warnings (e.g., 0.5% → 1.1% = spike). Similarly, `negative-trend` triggers at 0.7x for small changes (3.0% → 2.0%).

**Recommendation:** Add absolute APY floors: only flag `yield-spike` if `currentApy > 2%` AND 2x ratio met. Only flag `negative-trend` if `apy30d > 1%`.

### 3.4 LOW — Safety Score Coverage Threshold Too Lenient

**File:** `worker/src/cron/sync-yield-data.ts`

`MIN_SAFETY_SCORE_COVERAGE_RATIO = 0.5` means yield sync runs at full quality even when 50% of coins lack safety scores. This affects PYS accuracy since missing coins get `DEFAULT_SAFETY_SCORE = 40`.

**Recommendation:** Raise to 0.75. The safety pipeline is stable enough that 75% coverage should be the normal baseline.

---

## Part 4: Test Coverage Gaps

### 4.1 CRITICAL — `computeTvlWeightedMedianApy` Has Zero Test Coverage

**File:** `worker/src/cron/yield-sync/rankings.ts`

This function computes the peer median used for `yield-divergence` warning signals. It has no direct unit tests. The test file claims "tested via integration" but the integration test heavily mocks it. Edge cases untested: zero TVL, single row, tie-breaking.

### 4.2 HIGH — Incorrect Mock in Integration Test

**File:** `worker/src/cron/__tests__/sync-yield-data.test.ts`

`computeApyVarianceScore` is mocked to return `90`, but the real function returns values in [0, 1]. This means the integration test cannot catch bugs where out-of-range variance scores break PYS computation.

### 4.3 MEDIUM — Warning Signal Boundary Conditions Untested

No tests verify behavior at exact threshold boundaries (e.g., `currentApy / apy30d === 2.0` exactly). No tests for negative APY inputs to `detectWarningSignals`. The "healthy" baseline test asserts `length >= 3` instead of an exact count.

### 4.4 LOW — Missing Edge Case Tests

- `computeYieldStability` with all-zero samples (returns 1 = "perfectly stable", semantically wrong)
- `computePYS` with `scalingFactor = 0`, `apy30d = 0 AND safetyScore = 0`
- `matchAllDlPools` with empty pool array
- `computeApyFromRate` with NaN/Infinity inputs

---

## Part 5: Frontend Findings

### 5.1 MINOR — PYS Breakdown Shows Misleading Default Safety

**Files:** `src/lib/yield-constants.ts`, `src/components/yield-detail-section.tsx`

When `safetyScore` is null, the PYS breakdown tooltip displays calculations using the hardcoded default (40) as if it were the actual safety score. The final PYS value is correct (computed server-side), but the breakdown explanation is misleading.

**Fix:** Show "Safety: Unrated" with a note that default score (40) is applied, rather than displaying calculations as if 40 were a real rating.

### 5.2 MINOR — YIELD_TYPE_LABELS Has Duplicate "Native" Label

**File:** `shared/lib/classification.ts`

Both `lending-vault` and `governance-set` map to label "Native". These are semantically different yield mechanisms but display identically in the UI.

**Fix:** Change `governance-set` label to "Gov. Set" (matching the doc table).

### 5.3 OK — Formula Consistency Verified

The frontend `computePysBreakdown()` formula exactly matches the worker's `computePYS()`. All constants (floor 0.5, sustainability floor 0.3, scaling factor 5) are synchronized. Warning signal display is consistent across all surfaces (leaderboard, detail section, history chart) via the shared `formatYieldWarningSignal()` function.

---

## Part 6: Coverage Expansion Opportunities

### Current Coverage Summary

| Tier | Coins | Coverage |
|------|-------|----------|
| Tier 1: On-Chain Rate | 4 | usde, dusd, iusd, usdp |
| Tier 2: DL Pool Map | 37 | Static UUID matches |
| Tier 2: Variant Map | 24 | Wrapper token symbol search |
| Tier 4: Rate-Derived | 4 | buidl, ylds, ustb, mtbill |
| Tier 3: Price-Derived | 2 | usdb, usda (fallback) |
| Auto-Discovery | ~23 | Lending pools for non-yield coins |
| Symbol Fallback Only | 1 | honey (no explicit config) |
| **Total ranked** | **64** | 41 yield-bearing + 23 auto-discovered |

### 6.1 Expand Tier 1 On-Chain Coverage (Higher Fidelity)

Currently only 4 coins use deterministic on-chain reads. Many coins with variant wrappers already have `variantAddress` populated but no `ON_CHAIN_RATE_CONFIGS` entry:

| Coin | Wrapper | Address | Status |
|------|---------|---------|--------|
| reUSD | stUSR | `0x1202f5...` | Address in YIELD_VARIANT_MAP, no Tier 1 config |
| USDe | sUSDe | `0x9D39...` | Already has Tier 1 config |
| USDS | sUSDS | — | Address not populated, `convertToAssets` available on Ethereum |
| DAI | sDAI | — | Address not populated, well-known Ethereum contract |
| crvUSD | scrvUSD | — | Address not populated, Ethereum vault |
| FRXUSD | sfrxUSD | — | Address not populated, Ethereum vault |
| GHO | sGHO | — | Address not populated, Ethereum staking |
| DOLA | sDOLA | — | Address not populated, Ethereum vault |

**Recommendation:** Add `ON_CHAIN_RATE_CONFIGS` for reUSD/stUSR (address already available), then progressively add sDAI, sUSDS, scrvUSD, sfrxUSD. All use `convertToAssets(uint256)` with the same selector. This gives deterministic confidence for the highest-traffic coins.

### 6.2 Expand Rate-Derived Coverage (T-Bill Proxies)

Several RWA/treasury-backed stablecoins could use rate-derived APY:

| Coin | Current Coverage | Recommendation |
|------|-----------------|----------------|
| USDO (OpenEden) | Auto-discovered (3.25%) | Add to RATE_DERIVED_CONFIGS with ~15 bps spread (sister product to TBILL which is already rate-derived) |
| OUSG (Ondo) | Price-derived fallback (3.47%) | Already has DL pool map entry but DL pool may be stale. Add rate-derived as additional source |
| CASH (Phantom) | Auto-discovered (2.87%) | Research if T-bill-backed; could be rate-derived candidate |

### 6.3 Add Missing Lending Protocols to Allowlist

| Protocol | TVL | Status | Recommendation |
|----------|-----|--------|----------------|
| Morpho Blue | $1B+ | Missing (only `morpho-v1` in allowlist) | Add `morpho-blue` — rapidly growing modular lending |
| Maker PSM | Large | Missing | Research DeFiLlama pool structure |

### 6.4 Stablecoins Missing `yieldBearing` Flag

| Coin | Rationale | Action |
|------|-----------|--------|
| LUSD (lusd-liquity) | Already has B.Protocol deterministic estimator; shows in rankings via special-case code | Consider adding `yieldBearing: true` to formalize |
| USDO (usdo-openeden) | RWA-backed, sister to TBILL | Add flag + rate-derived config |

### 6.5 Coins That Could Benefit from Better Source Coverage

| Coin | Current Source | Issue | Improvement |
|------|---------------|-------|-------------|
| honey-berachain | Symbol fallback (Layer 3) | No explicit config; relies entirely on DL symbol match | Add YIELD_POOL_MAP UUID for stability |
| aznd-mu-digital | DL curated (7.62%) | Single source, Monad chain, small TVL | Monitor; add on-chain read when contract is verified |
| yousd-yield-optimizer | DL curated (9.23%) | Uses DEFAULT_SAFETY_SCORE; unrated | Prioritize safety rating to get accurate PYS |

### 6.6 Auto-Discovery Expansion

The current auto-discovery already captures 23 non-yield coins via lending pools. To expand:

1. **Lower MIN_LENDING_POOL_TVL_USD from $1M to $500K** — would capture smaller but legitimate lending markets
2. **Add Morpho Blue** to the allowlist (as noted in 6.3)
3. **Review AUTO_LENDING_SAFETY_BYPASS_IDS** — currently only U (united-stables) bypasses the C- safety gate. This is appropriate and shouldn't be expanded without audit.

---

## Part 7: Hardcoded Thresholds Review

| Constant | Current | Assessment | Recommendation |
|----------|---------|------------|----------------|
| `RISK_FREE_RATE_FALLBACK` | 4.25% | Stale — current 3-month T-bill is ~3.71% | Update to 3.75% or make it track the last-known-good rate more aggressively |
| `YIELD_SPIKE_THRESHOLD` | 2.0 (200%) | Too high for low-APY coins | Add absolute floor (e.g., AND currentApy > 2%) |
| `CROSS_SOURCE_DIVERGENCE_THRESHOLD` | 0.5 (50%) | Too loose — 5% vs 7.5% APY should flag | Consider lowering to 0.3 (30%) |
| `MIN_SAFETY_SCORE_COVERAGE_RATIO` | 0.5 | Too lenient | Raise to 0.75 |
| `MAX_RETAINED_RISK_FREE_RATE_AGE_SEC` | 2 days | Acceptable | OK |
| `LOW_SOURCE_TVL_USD` | $250K | Reasonable | OK |
| `MIN_LENDING_POOL_TVL_USD` | $1M | Conservative | Consider $500K for expansion |
| `MIN_LENDING_POOL_APY` | 0.5% | Reasonable | OK |
| `DEFAULT_SAFETY_SCORE` | 40 | Harsh penalty for unrated coins | Consider 50 (C- equivalent) to be neutral rather than punitive |
| `PYS_SCALING_FACTOR` | 5 | Reasonable distribution | OK |
| `STALE_THRESHOLD_MS` | 90 min | 3x sync interval — appropriate | OK |

---

## Part 8: Priority Implementation Plan

### P0 — Fix Now (Data Accuracy)

1. **Fix `.includes()` → exact match** in Layer 2 variant symbol matching (yield-helpers.ts)
2. **Investigate dUSD and USN 0% APY** — determine if genuine or broken source

### P1 — Fix Soon (Reliability)

3. **Fix risk-free rate `isFallback` flag** in fetch-tbill-rate.ts
4. **Add DL pool cache age validation** in sources.ts (reject if > 6h)
5. **Add on-chain rate failure logging** with source-specific warnings
6. **Fix `governance-set` label** from duplicate "Native" to "Gov. Set"

### P2 — Improve (Data Quality)

7. **Fix mock** in sync-yield-data.test.ts (variance score 90 → 0.9)
8. **Add unit tests** for `computeTvlWeightedMedianApy`
9. **Add boundary condition tests** for warning signals
10. **Fix variance score for near-zero means** (return null instead of 0)
11. **Use actual elapsed time** in Tier 1 APY calculation instead of hardcoded 7d
12. **Add legacy history age guard** (35d max)

### P3 — Expand Coverage

13. **Add Morpho Blue** to lending protocol allowlist
14. **Add Tier 1 on-chain configs** for reUSD/stUSR, sDAI, sUSDS, scrvUSD
15. **Add rate-derived config** for USDO (OpenEden)
16. **Add YIELD_POOL_MAP entry** for honey-berachain
17. **Update RISK_FREE_RATE_FALLBACK** from 4.25% to 3.75%
18. **Review DEFAULT_SAFETY_SCORE** — consider raising from 40 to 50

---

## Appendix: Live Data Snapshot (2026-03-15)

64 coins ranked. Key observations:
- **Highest PYS:** USP (60), USDU (23), msUSD (22), nUSD (20)
- **Highest APY:** USP (27.5%), USDU (12.9%), msUSD (12.0%), AID (11.3%)
- **Warning signals active:** USP (divergence + reward-heavy), USDU (divergence), msUSD (divergence), AID (divergence), USDD (reward-heavy), LUSD (reward-heavy), FDUSD (negative-trend)
- **Rate-derived coins:** USTB (3.56%), mTBILL (3.71%), BUIDL (3.51%), YLDS (3.21%)
- **Price-derived coins:** OUSG (3.47%)
- **Default safety used:** AID, dUSD
- **Zero APY:** dUSD, USN
- **Identical APY cluster (bug):** DAI, USDa, USD.AI all at 6.77%
