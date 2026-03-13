# Live Reserve Sync System — Audit Report

**Date:** 2026-03-13
**Scope:** Full audit of the live reserve composition pipeline: 16 adapters (covering 28 stablecoins), cron orchestrator, D1 storage layer, API handler, frontend consumers, shared helpers, type definitions, and test suite.
**Purpose:** Assess code health before scaling to more adapters. Identify mutualization opportunities, bugs, data accuracy risks, and maintainability concerns.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Assessment](#2-architecture-assessment)
3. [Critical Issues (Bugs)](#3-critical-issues)
4. [Code Mutualization — The Priority Remediation](#4-code-mutualization)
5. [Data Accuracy Concerns](#5-data-accuracy-concerns)
6. [Reliability & Resilience](#6-reliability--resilience)
7. [Type Safety](#7-type-safety)
8. [Test Coverage](#8-test-coverage)
9. [Per-Adapter Notes](#9-per-adapter-notes)
10. [Recommendations Summary](#10-recommendations-summary)

---

## 1. Executive Summary

The live reserves system is **architecturally sound**. The cron orchestrator, D1 storage model, API handler, and frontend integration form a well-designed pipeline with atomic writes, consistency checks, circuit breakers, and graceful fallback modes. The `adapt`/`fetch` separation in most adapters is an excellent pattern that enables clean testing.

However, the **adapter layer has significant code duplication** that will compound as more adapters are added. Two independent helper modules (`helpers.ts` and `utils.ts`) serve the same purpose, creating a split ecosystem where adapters arbitrarily belong to one "camp" or the other. Several adapters bypass both to call infrastructure directly.

**Key numbers:**
- 3 bugs found (1 functional, 2 correctness)
- ~80 lines of duplicated code across 9 files
- 4 separate implementations of normalize-to-100% logic
- 2 adapters + 3 utility modules with zero test coverage
- 8 of 14 tested adapters have only 1 test case (happy path only)

**Verdict:** Good foundation, but needs a consolidation pass before adding more adapters. The issues are all fixable without architectural changes.

---

## 2. Architecture Assessment

### What's Working Well

- **Atomic persistence**: Successful snapshots write both `reserve_composition` and `reserve_sync_state` via `db.batch()` — no torn reads possible.
- **Consistency checks**: `resolveReserveResult` verifies `syncState.lastSuccessAt === composition.fetchedAt` before serving live data. Orphaned or split-write rows safely fall through to static fallback.
- **Circuit breakers**: Per-source breaker keys prevent hammering failed sources. The `breakerScope` mechanism allows grouping related adapters.
- **Shared-source caching**: The cron deduplicates fetch calls when multiple coins share the same adapter + input config (e.g., the 3 M0 coins or 2 Mento coins).
- **Graceful degradation**: Five response modes (`live` → `live-stale` → `curated-fallback` → `template-fallback` → `unavailable`) give consumers clear signal about data provenance.
- **Adapt/fetch separation**: 12 of 16 adapters export a pure `adapt*` transformation function alongside their `fetch*` function, enabling fast unit tests without mocking.
- **Status integration**: Reserve health feeds into the `/status` dashboard with bootstrap suppression and appropriate severity escalation.
- **Frontend double-fallback**: The view model falls back to `getReserves(coin)` client-side if the live API returns null, providing additional resilience.

### Structural Concerns

- **Two helper modules** (`helpers.ts` and `utils.ts`) with overlapping functionality create confusion about which to import.
- **Sequential cron loop**: All 28 coins are processed sequentially. This is documented as deliberate (connection pressure management), and is fine at current scale, but will become a concern as adapter count grows and the hourly window tightens.
- **No adapter-level timeouts**: The per-coin timeout is managed only by the `AbortSignal` from the cron — there is no per-adapter timeout to prevent one slow adapter from consuming the entire window.

---

## 3. Critical Issues

### 3.1 BUG: btcfi adapter always produces a single 100% slice

**File:** `worker/src/cron/reserve-adapters/btcfi.ts` lines 30-44
**Severity:** Functional bug

The adapter computes `total` (sum of non-stable deposits) and `btcBucket` (sum of non-stable deposits) using **identical logic**. Both iterate the same market array, apply the same filter, and sum the same values. Therefore `btcBucket / total` is always `1.0`, and the adapter always returns a single slice at 100%.

Either the `btcBucket` computation should filter differently (e.g., only BTC-type assets, not all non-stables), or the adapter is fundamentally just a liveness probe and the single-slice output is intentional but misleadingly named.

### 3.2 BUG: crvusd has order-dependent risk assignment

**File:** `worker/src/cron/reserve-adapters/crvusd.ts`
**Severity:** Correctness

When multiple collateral symbols map to the same bucket name (e.g., wstETH and weETH both map to `"wstETH / sfrxETH / weETH"`), the bucket's risk level is set by whichever symbol the API returns first. If `getCanonicalReserveAssetRisk("WSTETH")` returns `"low"` but `getCanonicalReserveAssetRisk("WEETH")` returns `"medium"`, the bucket risk depends on API response order.

**Fix:** Use the worst (highest) risk among all symbols in a bucket, or pre-define the bucket risk statically.

### 3.3 BUG: collateral-positions-api uses EUR price as USD fallback

**File:** `worker/src/cron/reserve-adapters/collateral-positions-api.ts` line 67
**Severity:** Correctness

```
const usdPrice = priceInfo?.price?.usd ?? priceInfo?.price?.eur;
```

If the USD price is absent but a EUR price is available, the EUR value is used as if it were USD. With EUR/USD ~1.08, this introduces ~8% valuation error for affected assets, silently skewing the composition percentages.

---

## 4. Code Mutualization

This is the highest-priority remediation area for maintainability before scaling.

### 4.1 Merge `utils.ts` into `helpers.ts`

`utils.ts` contains exactly two functions, both of which have near-identical equivalents in `helpers.ts`:

| `utils.ts` | `helpers.ts` | Difference |
|------------|-------------|------------|
| `requireHttpJsonInput(config, name)` | `requireJsonInput(input, name)` | utils takes full config; helpers takes dereferenced input |
| `buildReserveSlicesFromValues(entries, decimals)` | `slicesFromUsdValues(values)` | utils has configurable `decimals` precision; helpers always rounds to integers |

**Recommended consolidation:**
- Adopt the `utils.ts` signature for `requireJsonInput` (takes full config — more ergonomic for callers).
- Add a `decimals` parameter to `slicesFromUsdValues` (default 0 for backward compatibility, 1 for adapters that need it).
- Delete `utils.ts`. Update all 6 consumer imports.

### 4.2 Eliminate 4x normalize-to-100% implementations

The "adjust largest slice so percentages sum to 100" algorithm exists in four places:

| Location | Used by |
|----------|---------|
| `helpers.ts: normalizeSlices()` | asymmetry, btcfi, collateral-positions-api, crvusd, fx, evm-branch-balances |
| `utils.ts: buildReserveSlicesFromValues()` | accountable, ethena, falcon, m0, mento, openeden |
| `reservoir.ts: adjustSlicesToHundred()` | reservoir only |
| `infinifi.ts` lines 98-108 (inline) | infinifi only |

The `helpers.ts` version is the most robust (deduplicates by composite key, handles grouping, sorts by percentage). **Reservoir and infinifi should import from helpers** instead of reimplementing.

### 4.3 Eliminate direct `fetchWithRetry` imports

Seven adapters bypass `fetchJsonWithRetry` to call `fetchWithRetry` directly, repeating the same 4-line boilerplate:

```typescript
const res = await fetchWithRetry(url, { signal }, 2, { timeoutMs: 12_000 });
if (!res) throw new Error("...");
if (!res.ok) throw new Error(`HTTP ${res.status} ...`);
const payload = await res.json() as T;
```

**Affected adapters:** accountable, ethena, falcon, infinifi, m0, openeden, reservoir

**Fix:** Add an optional `timeoutMs` parameter to `fetchJsonWithRetry` (currently hardcoded to 10,000). For `m0.ts` which needs POST, either add an optional `init` parameter or keep the single direct import.

### 4.4 Remove duplicated type guards

| Duplicate | Original |
|-----------|----------|
| `reservoir.ts: isHttpJsonInput()` | `helpers.ts: isHttpJsonInput()` |
| `infinifi.ts: isHttpJsonInput()` | `helpers.ts: isHttpJsonInput()` |
| `erc4626-single-asset.ts: isOnChainInput()` | `helpers.ts: isOnchainEvmInput()` |

All three should be deleted and replaced with imports from `helpers.ts`.

### 4.5 Summary of file changes

After consolidation, the adapter layer should have exactly **two** shared utility modules:
- **`helpers.ts`** — All fetch wrappers, input type guards, slice normalization, EVM balance/supply reads, price fetching
- **`evm.ts`** — Hex-level EVM call helpers (raw calldata, address parsing). Used only by `erc4626-single-asset.ts`. Separation is justified since it wraps different `evm-rpc` functions.

**Estimated reduction:** ~80 lines of duplicated code across 9 files.

### 4.6 Future mutualization opportunity: bucket aggregation

Five adapters (asymmetry, crvusd, ethena, falcon, reservoir) follow an identical pattern:
1. Iterate response rows
2. Classify each row into a named bucket using a hardcoded map/set
3. Accumulate USD totals per bucket
4. Convert to slices

A shared `bucketAndSlice(rows, classifyFn, riskMap)` utility could reduce these adapters by ~30% each. This is lower priority than the above items since each adapter's classification logic is unique, but worth considering if adapter count grows significantly.

---

## 5. Data Accuracy Concerns

### 5.1 Inconsistent rounding precision

Adapters using `helpers.normalizeSlices` produce **integer percentages** (33%, 34%). Adapters using `utils.buildReserveSlicesFromValues` produce **one-decimal percentages** (33.3%, 33.4%). This means different stablecoins show different precision levels on the same dashboard.

**Recommendation:** Standardize on one decimal place for all adapters during the helpers consolidation.

### 5.2 Non-canonical risk assignments

`fx.ts` hardcodes wstETH risk as `"low"` instead of using `getCanonicalReserveAssetRisk()` like `mento.ts` and `crvusd.ts` do. If the canonical risk for wstETH changes, fx will be stale.

`single-asset.ts` does not validate the `params.risk` value against the `ReserveRisk` type, unlike `erc4626-single-asset.ts` which has an explicit `isReserveRisk()` guard. An invalid risk string in config would flow through unchecked.

### 5.3 Silent new-asset handling varies by adapter

| Behavior on unknown asset | Adapters |
|---------------------------|----------|
| Emits warning + classifies as fallback bucket | crvusd, ethena, infinifi, reservoir |
| Silently classifies as "other" / "medium" | asymmetry, falcon, accountable, mento, openeden |
| Silently ignores entirely | btcfi, fx |

The inconsistency means some adapters will alert operators when a protocol adds new collateral types, while others will silently misclassify. All adapters with hardcoded asset maps should emit warnings for unknown assets.

### 5.4 No adapter validates source freshness

No API-based adapter checks response timestamps or staleness indicators. A cached or stale API response from the source is treated as current data. On-chain adapters (erc4626, single-asset, evm-branch-balances) are inherently current since they read latest block state.

### 5.5 Hard failure on partial DefiLlama price misses

`fx.ts` and `evm-branch-balances.ts` throw if ANY DefiLlama price is missing, even if other assets are priced successfully. A partial result with a warning for the unpriced asset would be more resilient, since DefiLlama can temporarily drop individual price feeds.

---

## 6. Reliability & Resilience

### 6.1 API handler missing error wrapper

`handleStablecoinReserves` in `worker/src/api/stablecoin-reserves.ts` does not use `withErrorHandler`. If `resolveReserveResult` throws (e.g., D1 query failure), the exception propagates unhandled. Compare with `handleStatus` which wraps with `withErrorHandler("status", ...)`.

### 6.2 Mento HTML scraping is fragile

The mento adapter parses reserve data from escaped JSON inside HTML (`\\"reserveComposition\\"`). This depends on Mento's exact HTML rendering — a framework version bump on their site could break extraction with no graceful degradation. This is the most fragile adapter in the set.

### 6.3 M0 hardcoded unit scaling

`m0.ts` applies `totalCash * 1_000` to correct a milli-USD vs micro-USD mismatch in the M0 API. If M0 normalizes their API, this adapter would silently overstate cash by 1000x. The comment is good documentation, but there's no runtime guard.

### 6.4 No fallback inputs used

`LiveReservesConfig` supports `inputs.fallbacks` but no adapter reads them. If the primary source is down, every adapter fails entirely. This is acceptable at current scale but should be considered as the system matures.

### 6.5 `computeReserveCompositionOverview` double-counting

A coin can be counted in both `degradedCoins` and `missingCoins` simultaneously in the overview computation. These counters measure different dimensions (last-status vs snapshot-presence), but consumers who assume mutual exclusivity could be confused.

---

## 7. Type Safety

### 7.1 `adapter: string` should be a string union

The `adapter` field on `LiveReservesConfig` is a plain `string`, but only 16 values are valid. A string union would catch typos at compile time.

### 7.2 `chain: string` on onchain-evm should be constrained

Used values: `"ethereum"`, `"arbitrum"`, `"hyperevm"`. A `ChainId` type union would be safer.

### 7.3 Unused type members

| Type member | Status |
|-------------|--------|
| `"attestation-mix"` semantics | Defined, never used in any config |
| `"etherscan-proxy"` rpcMode | Defined, never used in any config |
| `"indexer"` input kind | Defined, never used in any config |
| `version` field | Always `1` everywhere; no runtime dispatch logic reads it |

These are not bugs — they're reasonable forward planning. But they should be documented as reserved-for-future-use to avoid confusion.

### 7.4 No runtime response validation

All adapters cast JSON responses with `as` without runtime shape validation. If an external API changes its response format, adapters will silently produce incorrect data or throw unguarded property access errors. Adding lightweight runtime checks (e.g., verifying required fields exist and are the expected type) would significantly improve robustness.

---

## 8. Test Coverage

### 8.1 Coverage matrix

| Component | Has Tests | Test Count | Assessment |
|-----------|-----------|------------|------------|
| accountable | Yes | 5 | Best coverage — all bucket formats |
| asymmetry | Yes | 1 | Happy path only |
| btcfi | Yes | 1 | Happy path only |
| collateral-positions-api | Yes | 1 | Happy path only |
| crvusd | Yes | 1 | Happy path + warnings |
| erc4626-single-asset | Yes | 2 | Happy path + asset mismatch |
| ethena | Yes | 3 | Bucket grouping + warnings |
| falcon | Yes | 1 | Happy path only |
| fx | Yes | 1 | Happy path only |
| infinifi | Yes | 5 | Strong — including edge cases |
| m0 | Yes | 1 | Happy path only |
| mento | Yes | 2 | HTML parsing + slice mapping |
| openeden | Yes | 1 | Happy path only |
| reservoir | Yes | 2 | Happy path + unknown assets |
| **single-asset** | **No** | 0 | **No tests** |
| **evm-branch-balances** | **No** | 0 | **No tests** |
| helpers.ts | **No** | 0 | **Critical untested module** |
| utils.ts | **No** | 0 | **Untested** |
| evm.ts | **No** | 0 | **Untested** |
| sync-live-reserves.ts | Yes | 4 | Lifecycle coverage |
| live-reserves-store.ts | Yes | 4 | Resolution + overview |
| stablecoin-reserves.ts | Yes | 3 | API handler |

### 8.2 Key gaps

1. **`normalizeSlices` has no dedicated tests** despite being the most critical shared function (percentage rounding, dedup, largest-remainder adjustment). This is the highest-value untested function.
2. **`single-asset` and `evm-branch-balances`** are in production with zero test coverage.
3. **8 of 14 adapter test files have only 1 test case** — happy path only. No error-path or edge-case testing.
4. **No test validates against real API snapshots** — all payloads are synthetic handcrafted objects.
5. **No test verifies that percentages sum to 100%** except `infinifi.test.ts`.

### 8.3 Test architecture strength

The pure-transformation test approach (testing `adapt*` functions directly without mocking) is an excellent pattern — fast, reliable, and easy to maintain. This should be preserved and extended to the untested adapters.

---

## 9. Per-Adapter Notes

Quick reference for each adapter's status and unique concerns:

| Adapter | Status | Key Concern |
|---------|--------|-------------|
| accountable | Good | Silent drop of unmapped assets (defaults to "medium") |
| asymmetry | Good | No unknown-branch warnings |
| btcfi | **BUG** | Always 100% single slice — redundant computation |
| collateral-positions-api | Good | EUR→USD price fallback bug; "Other" risk floor at "medium" |
| crvusd | **BUG** | Order-dependent risk; Ethereum-only |
| erc4626-single-asset | Good | Potential BigInt throw on malformed RPC response |
| ethena | Good | New ETH derivatives silently classified as "other" |
| evm-branch-balances | Good but untested | Hard fail on partial price miss; bigint precision theoretical concern |
| falcon | Acceptable | No unknown-asset warnings; possible insurance fund double-counting |
| fx | Good | Non-canonical wstETH risk hardcoded; hard fail on price miss |
| infinifi | Good | Direct fetchWithRetry + inline normalize — needs consolidation |
| m0 | Acceptable | Fragile `* 1_000` unit scaling |
| mento | Fragile | HTML scraping depends on exact page structure |
| openeden | Acceptable | Static 6-field mapping; new assets silently ignored |
| reservoir | Good | Order-dependent bucket matching; inline helpers |
| single-asset | Good but untested | No risk validation on params |

---

## 10. Recommendations Summary

### Priority 1 — Before adding more adapters

| # | Action | Impact |
|---|--------|--------|
| 1 | **Merge `utils.ts` into `helpers.ts`**; standardize input validation and slice-building signatures | Eliminates split ecosystem; single import source for all adapters |
| 2 | **Remove inline duplicates** in reservoir (`adjustSlicesToHundred`, `isHttpJsonInput`), infinifi (`isHttpJsonInput`, inline normalize), erc4626 (`isOnChainInput`) | Reduces maintenance surface |
| 3 | **Switch 7 adapters to `fetchJsonWithRetry`** (add `timeoutMs` and optional `init` params) | Eliminates 4-line boilerplate per adapter |
| 4 | **Standardize rounding to 1 decimal place** across all adapters | Consistent display precision |
| 5 | **Fix the 3 bugs** (btcfi redundant computation, crvusd order-dependent risk, collateral-positions-api EUR fallback) | Data correctness |

### Priority 2 — Hardening

| # | Action | Impact |
|---|--------|--------|
| 6 | **Add `withErrorHandler` to `handleStablecoinReserves`** | Prevents bare 500s on D1 failure |
| 7 | **Add unknown-asset warnings** to adapters that silently classify: asymmetry, falcon, openeden, fx | Operator observability when protocols add collateral |
| 8 | **Use canonical risk helpers** in fx.ts and validate risk in single-asset.ts params | Consistent risk classification |
| 9 | **Degrade gracefully on partial DefiLlama price misses** (fx, evm-branch-balances) | Resilience to temporary price feed gaps |
| 10 | **Add lightweight response shape validation** to adapters (check required fields exist before accessing) | Earlier, clearer errors on API changes |

### Priority 3 — Test coverage

| # | Action | Impact |
|---|--------|--------|
| 11 | **Add `normalizeSlices` and `slicesFromUsdValues` unit tests** | Highest-value untested shared logic |
| 12 | **Add tests for `single-asset` and `evm-branch-balances`** | 2 production adapters with zero coverage |
| 13 | **Add error-path tests** for adapters with only happy-path coverage | Robustness confidence |
| 14 | **Add sum-to-100% assertions** to all adapter tests | Catch rounding regressions |

### Priority 4 — Type safety

| # | Action | Impact |
|---|--------|--------|
| 15 | **Type `adapter` as a string union** of the 16 registered adapter names | Compile-time typo prevention |
| 16 | **Type `chain` on onchain-evm input** as a constrained union | Catch invalid chain identifiers |
| 17 | **Document unused type members** (`attestation-mix`, `etherscan-proxy`, `indexer`, `version`) as reserved | Reduce confusion for new contributors |
