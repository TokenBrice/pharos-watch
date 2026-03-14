# DEX Liquidity Feature — Comprehensive Audit Report

**Date:** 2026-03-14
**Scope:** Full-stack audit of the liquidity feature (scoring cron, discovery cron, API endpoints, frontend, test coverage, downstream consumers)
**Context:** Liquidity data has been promoted to critical functions (report cards, DEWS, depeg confirmation, redemption backstops, price consensus). This audit assesses whether the feature is architecturally sound, reliable, and a good base to build on.

---

## Executive Summary

The DEX liquidity feature is **mature and well-architected**. Its two-cron separation (discovery + scoring), multi-source data pipeline, coverage confidence tracking, and graceful degradation patterns make it one of the more robust subsystems in the codebase. All downstream consumers handle missing/NULL liquidity data without hard failures.

However, its promotion to a critical dependency exposes several gaps that should be addressed:

| Severity | Count | Summary |
|----------|-------|---------|
| Critical | 2 | Missing circuit breakers on Curve/subgraph APIs; ~1,900 LOC of data-fetching code with zero test coverage |
| High | 6 | DEX price median not confidence-weighted; unprotected subgraph timeouts; no chain-resolution warnings; orderbook pool ID format mismatch; missing Zod bounds on scores; no detail-card error boundary |
| Medium | 10 | Various (see detailed findings) |
| Low | 8 | Various (see detailed findings) |

**Overall reliability rating: 80% — production-grade with improvable error resilience.**

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Scoring Cron Findings](#2-scoring-cron-findings)
3. [Discovery Cron Findings](#3-discovery-cron-findings)
4. [API Layer Findings](#4-api-layer-findings)
5. [Frontend Layer Findings](#5-frontend-layer-findings)
6. [Test Coverage Assessment](#6-test-coverage-assessment)
7. [Downstream Consumer Analysis](#7-downstream-consumer-analysis)
8. [Consolidated Findings](#8-consolidated-findings)
9. [Recommendations](#9-recommendations)

---

## 1. Architecture Overview

### Data Flow

```
                    DISCOVERY CRON (6,26,46 * * * *)
                    CG Onchain -> GT -> DexScreener -> CG Tickers
                            |
                            v
                      dex_pool_staging (D1)
                            |
    SCORING CRON (10,40 * * * *)                    |
    DL Yields + Curve + UniV3 + Aero  --merge-->  Score  --persist-->  dex_liquidity (D1)
                                                    |                  dex_liquidity_history
                                                    |                  dex_prices
                                                    v
                                              CONSUMERS
                                    Report Cards (30% weight)
                                    DEWS (stress signals)
                                    Depeg Detection (confirmation)
                                    Redemption Backstops (55% of exit)
                                    Price Consensus (promoted voice)
                                    PSI (indirect via DEWS)
```

### Key Design Decisions (Sound)

- **Two-cron separation**: Discovery (pool finding) runs independently from scoring (quality assessment), preventing slow crawls from delaying scores.
- **Tiered discovery priority**: T1/T2/T3 with exponential backoff prevents wasting API budget on coins with no DEX presence.
- **Coverage confidence tracking**: Every scored row carries `coverage_class` (primary/mixed/fallback/legacy/unobserved) and `coverage_confidence` (0-1), enabling downstream consumers to weight data appropriately.
- **Coverage guards**: Hard and near guards compare current vs. previous run, preventing silent data collapse.
- **`__global__` sentinel row**: Cross-stablecoin deduped aggregates prevent double-counting shared pools.
- **Staged pool confidence decay**: `max(0.5, 1 - ageHours/48)` ensures stale discovery data is progressively down-weighted.

---

## 2. Scoring Cron Findings

**Files audited:** 16 files in `worker/src/cron/dex-liquidity/`, ~4,100 LOC total.

### Strengths

- **Multi-layered data validation**: TVL bounds ($10K-$1T), volume/TVL ratio sanity (< 50x), balance ratio gates (>= 0.3 for price obs), peg-aware price filtering via shared validation engine.
- **Connection management**: DL fetch bodies consumed before Curve batch starts, respecting Workers' 6-connection limit. Documented in CLAUDE.md.
- **Coverage guards**: Three escalating levels (hard/near) for coverage count, global TVL, and top-10 TVL. Prevents persisting degenerate data.
- **Protocol TVL caps**: DeFiLlama protocol-level TVL used to clamp per-protocol totals, preventing inflated scores from protocol-level TVL inflation.
- **Aggregate rebuild after filtering**: All aggregates (TVL, volume, stress weights, protocol/chain breakdowns) are rebuilt from the retained pool set, so filtered/capped pools can't influence scores through stale pre-filter values.

### Issues Found

#### CRITICAL

**C1. Missing circuit breaker for Curve API** (`fetch-primary.ts`)
- Curve API fetches (4 chains in parallel) lack `shouldAttemptFetch()` protection.
- If Curve goes down, every 30-min cron run makes 4 failing requests with retries, potentially consuming minutes of the cron budget.
- DeFiLlama yields and protocols both have circuit breakers; Curve should too.
- Uniswap V3 and Aerodrome subgraphs similarly lack circuit breakers, though they're wrapped in non-fatal try/catch.

#### HIGH

**H1. DEX price median not confidence-weighted** (`scoring.ts`)
- TVL-weighted median across all observations treats fallback sources (confidence 0.55) the same as primary sources (confidence 1.0).
- A large-TVL fallback pool with a mispriced observation can shift the median.
- No outlier rejection: if one DEX has systematic mispricing, it can influence the median if its TVL is large.

**H2. Unprotected subgraph timeouts** (`fetch-primary.ts`)
- UniV3 and Aerodrome subgraph queries use the shared cron `signal` but no per-source timeout.
- If one chain's subgraph hangs, it blocks other enrichment sources until the global cron timeout fires.

#### MEDIUM

**M1. Coverage guard bootstrapping** (`orchestrator.ts:198`)
- First run has `previousCoverage = 0`, so `minExpectedCoverage = 1`. An empty dex_liquidity table passes the guard.
- Acceptable for cold start but undocumented.

**M2. Clock skew in staged pool confidence** (`staging-merge.ts`)
- If `refreshedAt` is in the future (clock skew between discovery and scoring workers), `ageHours` goes negative and confidence behavior is undefined.
- Risk is low (requires significant skew) but worth clamping: `Math.max(0, ageHours)`.

**M3. Protocol TVL cap reduction can distort per-chain TVL** (`scoring.ts`)
- Proportional reduction distributes cap excess across chains. If a protocol is 90% on one chain, that chain's TVL drops disproportionately relative to others.
- Documented but non-obvious.

#### LOW

**L1. Hardcoded orderbook quality multiplier** — CoinGecko Tickers use fixed 0.6x for all exchanges. Binance and a small regional exchange are weighted identically.

**L2. Score component formulas are complex but only partially documented** — The exact `poolQuality` component computation and durability sub-component weights are in code but not in `docs/dex-liquidity.md`.

---

## 3. Discovery Cron Findings

**Files audited:** 7 files in `worker/src/cron/dex-discovery/`, ~1,100 LOC total, plus chain-registry and rate-limit libs.

### Strengths

- **Excellent error isolation**: Per-coin errors do not propagate. Per-stage errors within a coin are logged as warnings and don't break subsequent stages. Even `updateDiscoveryMeta()` failure is swallowed gracefully.
- **Tiered priority with exponential backoff**: Coins with no DEX presence get demoted from T1 to dormant after 10 consecutive misses. Any discovery hit resets immediately to T1.
- **13-minute time budget** out of the 20-minute cron slot provides comfortable headroom.
- **Single-threaded sequential execution**: 1 active connection at a time with rate limiting per source (250ms CG, 2000ms GT, 1100ms DS).
- **Automatic staging cleanup**: 48h deletion, 6h raw_json nulling, runs every 20 minutes.

### Issues Found

#### HIGH

**H3. No runtime validation of contract chain IDs** (`crawl-sources.ts`)
- If a stablecoin has `contracts` with an unknown chain not in `CHAIN_REGISTRY`, all discovery stages silently skip it. No warning is logged.
- The coin is counted as a "miss" and eventually demoted to dormant, making the misconfiguration hard to diagnose.
- Should log a warning when a contract's chain cannot be resolved.

**H4. Orderbook pool ID format mismatch** (`crawl-sources.ts:480`)
- CoinGecko Tickers create pool IDs as `orderbook:{exchangeId}:{stablecoinId}`, while all other sources use `{chain}:{poolAddress}`.
- The scoring cron's fingerprint dedup logic assumes `chain:address` format. Orderbook pools may not deduplicate correctly via fingerprint matching.

#### MEDIUM

**M4. No per-source pool count metrics** — Cron metadata tracks `coinsCrawled` and `poolsDiscovered` totals but not per-source breakdown (CG vs GT vs DS vs CG Tickers). Makes it harder to diagnose which source is underperforming.

**M5. Deadline check only at coin boundaries** — Individual stages can exceed the 13-minute deadline if started before the check. Not a practical issue with current headroom but worth noting.

#### LOW

**L3. `discovery_candidates` table (migration 0059) exists but is not used by the discovery cron** — It's part of a separate candidate screening system. Not a bug, but creates confusion.

**L4. Raw JSON stored but never consumed** — `raw_json` field persisted but only nulled after 6h; never read by scoring cron. Reserved for debugging/future use.

---

## 4. API Layer Findings

**Files audited:** `dex-liquidity.ts`, `dex-liquidity-history.ts`, 7 migration files, router registration.

### Strengths

- **All queries properly indexed**: `idx_dex_liq_score`, `idx_dex_hist_coin_date`, `idx_dex_hist_unique`, `idx_cron_runs_job_started`.
- **Defensive JSON parsing**: `safeParse()` handles NULL, malformed JSON, and empty strings with typed fallbacks.
- **Dual-layer staleness warnings**: `X-Data-Age` header + `Warning: 110` for stale data + `Warning: 199` for degraded/failed cron runs.
- **Strict parameter validation**: History endpoint validates stablecoin ID via `resolveOrReject()` and days via `parseIntParam()` with bounds.
- **No SQL injection vectors**: All inputs parameterized. No string interpolation in queries.

### Issues Found

#### MEDIUM

**M6. `normalizeTopPools()` can produce `source: undefined`** (`dex-liquidity.ts:91-97`)
- Legacy source abbreviations are normalized ("cg" -> "cg_onchain", etc.), but unknown sources silently become `undefined`.
- JSON serialization will omit the key entirely, which may confuse clients expecting a consistent shape.

**M7. Trend baseline tolerance windows are generous** — 24h trend accepts any snapshot within +/-12 hours. Intentionally loose for missed cron runs, but undocumented rationale.

#### LOW

**L5. No explicit index on `dex_prices`** — Only the implicit PRIMARY KEY index. Table is ~156 rows, so not a performance issue, but a full-table scan is unnecessary.

**L6. Cron metadata JSON parse failures are silently swallowed** — `buildDexLiquidityWarning()` catches parse errors without logging, making corrupted metadata invisible.

---

## 5. Frontend Layer Findings

**Files audited:** 15 files (page, components, hooks, types, utilities).

### Strengths

- **Full Zod schema validation** (`DexLiquidityMapSchema`) enforces runtime type safety on API responses.
- **Proper unrated/unobserved handling**: Separate table section for NR coins with clear messaging.
- **Comprehensive memoization**: `rows`, `scoredRows`, `unratedRows`, `summaryStats`, `chartData` all memoized with correct dependency arrays.
- **Stale data awareness**: `StaleDataBanner` with preset `"dexLiquidity"` (CRON_30MIN) plus `meta?.warning` for pipeline warnings.
- **Coverage badge logic**: Exhaustive `Record` ensures all 5 coverage classes are handled.

### Issues Found

#### HIGH

**H5. No Zod bounds on scores and ratios** (`shared/types/market.ts`)
- `liquidityScore` is `z.number().nullable()` with no 0-100 range check.
- `concentrationHhi` has no 0-1 range check. Corrupted data could render as "123%" or "Infinity".
- Should be `z.number().min(0).max(100).nullable()` and `z.number().min(0).max(1).nullable()`.

**H6. No section-level error boundary on DexLiquidityCard**
- The card is dynamically imported and used on the stablecoin detail page. A rendering crash in the card would take down the entire detail page.
- The `/liquidity` page has `error.tsx`, but the detail page's card lacks its own boundary.

#### MEDIUM

**M8. `DEX_GLOBAL_KEY` existence not guarded** (`client.tsx:79`, `liquidity-stats.tsx`)
- `liquidityMap[DEX_GLOBAL_KEY]` accessed without checking if the key exists. Optional chaining (`globalData?.totalTvlUsd ?? 0`) prevents crashes, but if the `__global__` key is missing, all summary stats silently become 0 with no indication to the user.

**M9. Missing aria-label on peg filter ToggleGroup** — The filter group lacks an overall `aria-label` or legend for screen readers.

#### LOW

**L7. Summary stats iterate over `TRACKED_STABLECOINS` separately from `rows` computation** — Could compute from `rows` instead of re-iterating the full list, though with 156 coins the performance impact is negligible.

**L8. `methodologyVersion` field present in schema but not displayed anywhere in UI** — Could be useful for transparency.

---

## 6. Test Coverage Assessment

### Summary

| Category | Test Files | Tests | LOC Covered |
|----------|-----------|-------|-------------|
| Frontend (UI logic) | 4 | 27 | ~800 |
| Pool metrics & scoring | 7 | 35 | ~1,800 |
| API endpoints | 2 | 13 | ~600 |
| Discovery orchestration | 3 | 7 | ~300 |
| **Total** | **16** | **71** | **~3,500** |

### Well-Tested Areas

- All 8 sort keys with null/zero handling and pagination reconciliation
- Pool quality scoring (durability, TVL depth, volume activity, pair diversity)
- Price sanity across fiat (EUR, BRL, JPY), commodities (gold/silver), NAV/VAR pegs
- API response structure, empty data, v2 fields, warning headers, version reconstruction
- Tier computation, backoff demotion, dormant gating

### Critical Test Gap

**C2. ~1,900 LOC of data-fetching code has zero test coverage**

| File | LOC | Tests |
|------|-----|-------|
| `fetch-primary.ts` (DL yields, Curve, connection management) | ~500 | 0 |
| `fetch-crawlers.ts` (CG Onchain, GeckoTerminal crawlers) | ~550 | 0 |
| `crawl-helpers.ts` (token-to-pool crawl orchestration) | ~350 | 0 |
| `staging-merge.ts` (staged pool loading, profile resolution) | ~250 | 0 |
| `subgraph-helpers.ts` (GraphQL pagination) | ~200 | 0 |

These files contain all external API interaction logic — the most failure-prone code in the system. Key untested behaviors include:
- Circuit breaker integration
- Connection pooling / early body consumption
- Time-budget enforcement (30-min crawl window)
- Cascading failures (DL down -> use CG/GT; CG down -> use fallbacks)
- GraphQL pagination through Uniswap/Aerodrome subgraphs

### Test Anti-Patterns

- **Single mega-test in `process-pools`**: 210-line test covering 13 scenarios. Hard to isolate failures.
- **Heavy mocking in orchestration tests**: All 6 data sources mocked, missing integration between circuit breaker state, fallback behavior, and coverage tracking.

---

## 7. Downstream Consumer Analysis

### Dependency Map

| Consumer | Fields Read | Weight/Impact | NULL Handling | Stale Data Risk |
|----------|------------|---------------|---------------|-----------------|
| **Report Cards** | `liquidityScore`, `concentrationHhi`, `poolCount`, `chainCount` | 30% of overall grade | Grade = "NR" + 10% penalty | Uses last row, no age check |
| **DEWS** | `liquidityScore`, `weightedBalanceRatio`, `avgPoolStress`, `topPoolsJson`, `totalTvlUsd` + 7d history | Stress signal inputs | Skips coin, records `insufficientData` | History requires `coverage_confidence >= 0.75` |
| **Redemption Backstops** | `liquidityScore` only | 55% of effective exit score | Passes `null`, redemption-only pathway | Uses last row, no age check |
| **Depeg Detection** | `dex_prices` (not `dex_liquidity`) | Confirmation gate | Falls back to primary-only detection | Strict: < 20 min + >= $1M TVL |
| **Price Consensus** | `dex_prices` (promoted voice, weight=1) | 1 of 8 consensus sources | Simply not included in sources array | Strict: < 20 min + >= $1M TVL |
| **PSI** | Indirect via DEWS | Via `dewsStressBreadth` | `stressBreadth = 0` if unavailable | Inherits DEWS staleness |
| **Coverage Page** | `coverageClass` | UI labeling only | Falls back to "legacy" | Display-only, no computation |

### Cascade Failure Analysis

**All consumers handle missing/NULL liquidity data gracefully. No hard stops identified.**

Worst case scenario (complete `dex_liquidity` failure):
1. Report Cards: all coins get liquidity grade "NR" with 10% penalty
2. DEWS: all coins skipped for stress signals (recorded as `sourceFailure`)
3. Redemption Backstops: effective exit score uses redemption pathway only (45% weight)
4. Depeg Detection: falls back to primary-only (no DEX confirmation)
5. PSI: `stressBreadth = 0` (less accurate but not broken)
6. Status Dashboard: shows CRITICAL warning

**This is acceptable degradation behavior.** The system continues operating with reduced accuracy rather than failing.

### Stale Data Concern

Report Cards and Redemption Backstops both read `dex_liquidity` rows without checking their age. If the scoring cron fails for an extended period, these consumers will silently use stale data. The API layer does add `Warning` headers and `X-Data-Age`, but the compute-on-read consumers (report cards, redemption backstops) don't check staleness of their liquidity input.

---

## 8. Consolidated Findings

### Critical (2)

| ID | Finding | Location | Impact |
|----|---------|----------|--------|
| C1 | Missing circuit breaker for Curve API (and subgraphs) | `fetch-primary.ts` | Repeated failures hammer APIs, consume cron budget |
| C2 | ~1,900 LOC of data-fetching code with zero tests | `fetch-primary.ts`, `fetch-crawlers.ts`, `crawl-helpers.ts`, `staging-merge.ts`, `subgraph-helpers.ts` | Most failure-prone code is completely untested |

### High (6)

| ID | Finding | Location | Impact |
|----|---------|----------|--------|
| H1 | DEX price median not confidence-weighted | `scoring.ts` | Large-TVL fallback pool can distort median |
| H2 | No per-source timeout for subgraph queries | `fetch-primary.ts` | One hanging subgraph blocks all enrichment |
| H3 | No warning when contract chain can't be resolved | `crawl-sources.ts` | Misconfigured chains silently skip discovery |
| H4 | Orderbook pool ID format inconsistent with other sources | `crawl-sources.ts:480` | Fingerprint dedup may not work for orderbook pools |
| H5 | No Zod bounds on `liquidityScore` (0-100) or `concentrationHhi` (0-1) | `shared/types/market.ts` | Corrupted data renders as "123%" or "Infinity" |
| H6 | No section-level error boundary on DexLiquidityCard | `dex-liquidity-card.tsx` | Card crash takes down entire detail page |

### Medium (10)

| ID | Finding | Location |
|----|---------|----------|
| M1 | Coverage guard bootstrapping allows empty first run | `orchestrator.ts:198` |
| M2 | Clock skew can produce negative confidence decay | `staging-merge.ts` |
| M3 | Protocol TVL cap reduction distorts per-chain TVL | `scoring.ts` |
| M4 | No per-source pool count in discovery cron metadata | `orchestrator.ts` |
| M5 | Deadline check only at coin boundaries in discovery | `orchestrator.ts` |
| M6 | `normalizeTopPools()` produces `source: undefined` for unknown sources | `dex-liquidity.ts` |
| M7 | Trend baseline tolerance windows undocumented | `dex-liquidity.ts` |
| M8 | `DEX_GLOBAL_KEY` existence not explicitly guarded | `client.tsx`, `liquidity-stats.tsx` |
| M9 | Missing aria-label on peg filter ToggleGroup | Liquidity page |
| M10 | Report Cards and Redemption Backstops don't check liquidity data staleness | `report-cards-snapshot.ts`, `sync-redemption-backstops.ts` |

### Low (8)

| ID | Finding | Location |
|----|---------|----------|
| L1 | Hardcoded 0.6x orderbook quality multiplier for all exchanges | `staging-merge.ts` |
| L2 | Score component formulas partially undocumented | `docs/dex-liquidity.md` |
| L3 | `discovery_candidates` table unused by discovery cron | Migration 0059 |
| L4 | `raw_json` field stored but never consumed | `dex_pool_staging` |
| L5 | No explicit index on `dex_prices` table | Migration 0011 |
| L6 | Cron metadata JSON parse failures silently swallowed | `dex-liquidity.ts` |
| L7 | Summary stats re-iterate TRACKED_STABLECOINS unnecessarily | `client.tsx` |
| L8 | `methodologyVersion` not displayed in UI | Frontend |

---

## 9. Recommendations

### Tier 1 — Address Before Expanding (Critical + High)

1. **Add circuit breaker for Curve API and subgraphs** (C1)
   - Add `CIRCUIT_SOURCE.CURVE_API` to the breaker registry
   - Wrap Curve fetches with `shouldAttemptFetch()` / `recordOutcome()`
   - Consider per-chain subgraph circuit breakers for UniV3

2. **Add integration tests for data-fetching code** (C2)
   - Use HTTP mocks (msw or similar) for `fetch-primary.ts` and `fetch-crawlers.ts`
   - Test cascading failures: DL down -> CG/GT takeover; CG down -> use fallbacks
   - Test connection pooling and early body consumption
   - Test time-budget enforcement

3. **Add Zod bounds to schema** (H5)
   ```typescript
   liquidityScore: z.number().min(0).max(100).nullable(),
   concentrationHhi: z.number().min(0).max(1).nullable(),
   ```

4. **Log warning when contract chain can't be resolved** (H3)
   ```typescript
   console.warn(`[dex-discovery] Chain "${chain}" not in registry for ${stablecoinId}, skipping`);
   ```

5. **Add error boundary to DexLiquidityCard** (H6) — Wrap with a section-level boundary so card crashes don't take down the detail page.

### Tier 2 — Strengthen Reliability (Medium)

6. **Weight DEX price observations by coverage confidence** (H1) — Multiply TVL weight by `coverageConfidence` so fallback sources have proportionally less influence on the median.

7. **Add per-source timeout for subgraph queries** (H2) — Use `AbortSignal.timeout()` per chain so one hanging subgraph doesn't block others.

8. **Guard `DEX_GLOBAL_KEY` existence explicitly** (M8) — Show a "Global data unavailable" message instead of silently rendering 0s.

9. **Add staleness check in Report Cards and Redemption Backstops** (M10) — When `dex_liquidity.updated_at` is older than 2x the cron interval (60 min), log a warning and optionally mark the liquidity input as degraded.

10. **Normalize orderbook pool IDs** (H4) — Either adopt the same `chain:address` format or ensure the fingerprint dedup builder explicitly handles the `orderbook:` prefix.

### Tier 3 — Polish (Low)

11. Add per-source pool count metrics to discovery cron metadata (M4)
12. Clamp `ageHours` to >= 0 in confidence decay (M2)
13. Document score component formulas in `docs/dex-liquidity.md` (L2)
14. Add `aria-label` to peg filter ToggleGroup (M9)
15. Log cron metadata parse failures at INFO level (L6)

---

## Appendix: Files Audited

### Scoring Cron (16 files, ~4,100 LOC)
- `worker/src/cron/dex-liquidity/orchestrator.ts` (318 lines)
- `worker/src/cron/dex-liquidity/types.ts` (305 lines)
- `worker/src/cron/dex-liquidity/scoring.ts` (566 lines)
- `worker/src/cron/dex-liquidity/persistence.ts` (250 lines)
- `worker/src/cron/dex-liquidity/process-pools.ts` (251 lines)
- `worker/src/cron/dex-liquidity/fetch-primary.ts` (~700 lines)
- `worker/src/cron/dex-liquidity/fetch-crawlers.ts` (~400 lines)
- `worker/src/cron/dex-liquidity/fetch-fallbacks.ts` (~300 lines)
- `worker/src/cron/dex-liquidity/staging-merge.ts` (291 lines)
- `worker/src/cron/dex-liquidity/pool-helpers.ts` (~300 lines)
- `worker/src/cron/dex-liquidity/price-sanity.ts` (38 lines)
- `worker/src/cron/dex-liquidity/crawl-helpers.ts` (~400 lines)
- `worker/src/cron/dex-liquidity/subgraph-helpers.ts` (~100 lines)
- `worker/src/cron/dex-liquidity/constants.ts` (85 lines)
- `worker/src/lib/depeg-helpers.ts` (~100 lines)
- `worker/src/lib/price-consensus.ts` (~100 lines)

### Discovery Cron (7 files, ~1,100 LOC)
- `worker/src/cron/dex-discovery/orchestrator.ts` (292 lines)
- `worker/src/cron/dex-discovery/crawl-sources.ts` (534 lines)
- `worker/src/cron/dex-discovery/types.ts` (73 lines)
- `worker/src/cron/dex-discovery/persistence.ts` (187 lines)
- `worker/src/lib/chain-registry.ts` (143 lines)
- `worker/src/lib/rate-limit.ts` (199 lines)

### API Layer (9 files)
- `worker/src/api/dex-liquidity.ts`
- `worker/src/api/dex-liquidity-history.ts`
- 7 migration files (0009, 0010, 0011, 0012, 0017, 0036, 0061)

### Frontend (15 files)
- `src/app/liquidity/page.tsx`, `client.tsx`, `error.tsx`
- `src/components/dex-liquidity-card.tsx`
- `src/components/liquidity-stats.tsx`, `liquidity-table.tsx`, `balance-bar.tsx`
- `src/components/liquidity-table-logic.ts`
- `src/hooks/api-hooks.ts`
- `shared/types/market.ts`
- `src/lib/liquidity-coverage.ts`, `dex-constants.ts`, `severity-colors.ts`

### Tests (16 files, 71 test cases)
- Frontend: 4 files, 27 tests
- Worker scoring: 7 files, 35 tests
- Worker API: 2 files, 13 tests
- Worker discovery: 3 files, 7 tests

### Downstream Consumers (6 files)
- `worker/src/lib/report-cards-snapshot.ts`
- `shared/lib/report-cards.ts`
- `worker/src/cron/compute-dews.ts`
- `worker/src/cron/sync-redemption-backstops.ts`
- `worker/src/cron/detect-depegs.ts`
- `worker/src/cron/confirm-pending-depegs.ts`
