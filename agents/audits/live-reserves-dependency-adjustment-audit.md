# Audit: Live Reserve Sync & Automated Dependency Adjustment

**Date:** 2026-03-15
**Scope:** End-to-end audit of the live reserve sync pipeline and its integration with the safety score (report cards) system, including automated collateral quality scoring.

---

## Executive Summary

Both features are well-architected and form a solid foundation. The live reserve sync is cleanly separated from curated metadata, with proper circuit breakers, per-coin sync state tracking, and graceful degradation. The report cards integration is conservative — live data only affects collateral quality scoring (1/3 of the resilience dimension), while dependency inference stays on curated data for safety. The main concerns are: (1) observability gaps in the live-to-scoring pipeline, (2) validation holes in adapter outputs and slice data, (3) a structural inconsistency where `isBlacklistable` uses curated reserves while collateral quality uses live reserves, and (4) significant test coverage gaps for the integration boundary.

**Overall assessment:** Production-worthy with identified improvements.

---

## 1. Live Reserve Sync Pipeline

### 1.1 Architecture (Strong)

The pipeline is well-structured with clear separation of concerns:

- **Orchestrator** (`worker/src/cron/sync-live-reserves.ts`) — sequential coin iteration with circuit breaker gating
- **Adapter registry** (`worker/src/cron/reserve-adapters/index.ts`) — 24 adapters, simple lookup
- **Shared helpers** (`helpers.ts`, `evm.ts`) — centralized fetch/normalize/validate primitives
- **Persistence** (`worker/src/lib/live-reserves-store.ts`) — dual-table model (composition + sync state)
- **API** (`worker/src/api/stablecoin-reserves.ts`) — five-mode response with appropriate cache control
- **Isolated cron trigger** (`hourly-live-reserves.ts`) — dedicated `:11` slot prevents connection contention

The shared source deduplication in the orchestrator (lines 86-98) is a smart optimization — coins sharing identical adapter configs reuse the same fetch promise.

### 1.2 Circuit Breaker Integration (Good, One Issue)

Circuit breakers gate every fetch attempt via `shouldAttemptFetch()` and record outcomes via `recordOutcomeSafe()`. The breaker key scheme (`live-reserves:${breakerScope ?? adapter}`) allows both per-adapter and per-source grouping.

**Issue: First-outcome-wins for shared breaker keys.** The `recordedBreakerOutcomes` Set (line 79) ensures only the first coin per breaker key records an outcome. If coin A succeeds and coin B (same breaker key) fails, the breaker records success. The inverse is also true — first failure wins even if later coins succeed.

- **Severity:** Medium
- **Impact:** Breaker state may not reflect the actual health of the source
- **Recommendation:** Record the *worst* outcome per breaker key, or record per-coin and let the breaker aggregate

### 1.3 Empty Slices Handling (Design Question)

Empty slice arrays are treated as hard errors (lines 146-164), recording breaker failure. Some adapters could legitimately return empty slices during data gaps or when a protocol's reserves are temporarily zero.

- **Severity:** Low
- **Recommendation:** Consider a `degraded` status instead of `error` for empty slices, or let adapters signal "no data available" vs "empty reserves" via a distinct return value

### 1.4 Adapter Quality Varies

Across 24 adapters, quality ranges from robust to fragile:

**Strong adapters:**
- `accountable.ts` — validates bucket parameters, checks for empty entries
- `gho.ts` — explicit null checks for all on-chain calls
- `collateral-positions-api.ts` — validates price lookups, warns on unknown assets
- `falcon.ts` — threshold-based warning suppression ($10k floor)

**Fragile adapters:**

| Adapter | Concern | Severity |
|---------|---------|----------|
| `circle-transparency.ts` | HTML regex parsing — any attribute name/whitespace change breaks extraction | High |
| `mento.ts` | HTML unescape logic is error-prone, assumes specific escape sequences | High |
| `fx.ts` | Missing DefiLlama price fails entire adapter (no graceful degradation for partial pricing) | Medium |
| `evm-branch-balances.ts` | Same pattern — any missing price fails entire run | Medium |
| `chainlink-por.ts` | Assumes `parseLatestRoundData()` won't fail on truncated Etherscan hex | Medium |
| `asymmetry.ts` | No validation of `coll_value` parsing; NaN silently treated as 0 | Medium |
| `sky-makercore.ts` | Takes last array entry without validating timestamp freshness | Medium |

**Recommendation:** Prioritize hardening the HTML-based adapters (`circle-transparency`, `mento`) since format changes are likely. Consider adding adapter-level integration tests with fixture data.

### 1.5 Missing Validation at Adapter Output Boundary

No orchestrator-level validation exists for adapter output quality:

1. **No check that slice percentages sum to ~100%.** A malformed adapter could return slices summing to 10% or 500%.
2. **No validation of `risk` enum values.** An invalid risk string passes through to storage and scoring.
3. **No check for duplicate slice names.** Two slices with identical `name` + `risk` could confuse the frontend.
4. **No anomaly detection.** If reserves jump 10x between syncs, no alert fires.

- **Severity:** Medium (items 1-2), Low (items 3-4)
- **Recommendation:** Add a `validateAdapterOutput()` gate in the orchestrator between adapter return and persistence. Validate: sum ≈ 100%, all risk values are valid enum members, no NaN/negative percentages.

### 1.6 `isValidSlice` Validation Gaps

In `live-reserves-store.ts:91-98`:

```typescript
function isValidSlice(item: unknown): item is ReserveSlice {
  return (
    typeof slice.name === "string"
    && typeof slice.pct === "number"
    && typeof slice.risk === "string"  // Only checks string type, not valid enum
  );
}
```

- Does NOT validate `risk` is in `["very-low", "low", "medium", "high", "very-high"]`
- Does NOT check `pct >= 0` or `pct <= 100`
- Does NOT check `name.length > 0`

This means invalid slices pass through to `loadFreshLiveReserveMap()` and ultimately to `scoreResilience()`.

- **Severity:** Medium
- **Recommendation:** Add enum validation for `risk`, range check for `pct`

### 1.7 Silent JSON Parse Failures

In `loadFreshLiveReserveMap()` (line 388-396), malformed JSON in the `slices` column is caught and silently skipped with no logging. If DB corruption occurs, there's no diagnostic trail.

- **Severity:** Low
- **Recommendation:** Add a warning counter or log the skip

### 1.8 Fallback Inputs Declared but Unimplemented

`inputs.fallbacks` exists in the type but no adapter reads it, no config declares it, and the orchestrator doesn't attempt fallback resolution. This is documented as a known limitation.

- **Severity:** Low (documented)
- **Recommendation:** Either implement or remove from the type to avoid confusion

### 1.9 No Historical Snapshot Retention

Only the latest snapshot per coin is stored in `reserve_composition`. If data corruption occurs, there's no historical fallback. Unlike supply history (which retains daily rows), reserve composition is overwrite-only.

- **Severity:** Low
- **Recommendation:** Consider a `reserve_composition_history` table or periodic D1 Time Travel bookmarks

---

## 2. Automated Dependency Adjustment (Report Cards Integration)

### 2.1 Data Flow (Clean)

The integration path is well-defined:

```
sync-live-reserves (hourly)
  → reserve_composition table
    → loadFreshLiveReserveMap() [< 48h, >= 2 slices]
      → buildReportCardsSnapshot()
        → computeCard() per coin
          → scoreResilience(meta, canBeBlacklisted, liveSlices)
            → computeCollateralQualityFromReserves(liveSlices ?? meta.reserves)
```

Key design decisions are sound:
- Live data only affects **collateral quality** (1/3 of resilience, ~6.7% of overall score)
- Dependencies remain on curated data (live slices lack `coinId` links)
- `collateralFromLive` flag in `RawDimensionInputs` provides transparency
- 48-hour freshness cutoff prevents ancient data from influencing scores

### 2.2 Structural Inconsistency: `isBlacklistable` Uses Curated Data

`isBlacklistable()` at `report-cards.ts:452-457` computes "possible-inherited" blacklistability from `meta.reserves` (curated):

```typescript
if (blacklistableIds && meta.reserves) {
  const inheritedPct = meta.reserves
    .filter(r => r.coinId !== undefined && blacklistableIds.has(r.coinId))
    .reduce((sum, r) => sum + r.pct, 0);
  if (inheritedPct >= INHERITED_BLACKLIST_THRESHOLD_PCT) return "possible-inherited";
}
```

Meanwhile, `scoreResilience()` at line 489 uses live slices for collateral quality:

```typescript
const effectiveReserves = liveReserveSlices ?? meta.reserves;
```

This means: if live reserves show 50% USDC (blacklistable) but curated shows 20% USDC, the blacklist scoring sees 20% (below threshold) while collateral quality sees the actual 50%. These two resilience sub-factors can become inconsistent with each other.

- **Severity:** Medium
- **Impact:** A coin could have its collateral scored from live data showing heavy stablecoin backing, while blacklist-inherited status still shows "No" based on stale curated data
- **Recommendation:** This is constrained by the fact that live slices lack `coinId` links. Until adapters emit `coinId`, this inconsistency is unavoidable. Document it explicitly and flag in the delta alert.

### 2.3 Delta Alert is Console-Only

The divergence detection at `report-cards-snapshot.ts:245-256` only logs to `console.warn`:

```typescript
if (delta > 15) {
  console.warn(`[report-cards] Collateral score drift for ${meta.id}: ...`);
}
```

This alert is **not**:
- Stored in D1 for audit trail
- Surfaced in the `/status` dashboard
- Sent via the alert system (Telegram/webhook)
- Exposed in the API response

- **Severity:** High (operational visibility)
- **Impact:** The entire value proposition of live reserve sync for scoring is undermined if score drift goes unnoticed. The alert exists to signal when curated metadata needs human review — if nobody sees it, curated data silently drifts.
- **Recommendation:** Wire delta alerts into the existing alert system (`sendAlert`). Store drift events in D1. Surface in `/status`. Include affected coins in cron metadata.

### 2.4 Missing Alert for Live-to-Curated Fallback Transitions

When a coin transitions from live scoring to curated fallback (e.g., live snapshot becomes stale), no alert fires. The score could change silently.

- **Severity:** Medium
- **Recommendation:** Track `collateralFromLive` per coin over time. Alert when a coin drops from live to curated, especially if it causes a grade change.

### 2.5 Dependency Graph Never Updates from Live Data

Dependencies are always derived from curated `meta.reserves` + `meta.dependencies`:

```typescript
dependencies: deriveDependencies(meta),  // Always curated, never live
```

This is the correct design (live slices lack `coinId`), but creates a potential divergence: live collateral composition could show different backing than what the dependency graph implies.

- **Severity:** Low (by design)
- **Recommendation:** Document this boundary clearly. Consider enriching live adapter output with `coinId` links for major adapters over time.

### 2.6 `deriveDependencies()` Called Redundantly

In `computeCard()`, `deriveDependencies(meta)` is called:
1. Line 242: inside `scoreDependencyRisk(meta, overallScores)` (which calls it internally)
2. Line 281: for `rawInputs.dependencies`
3. Lines 297-298: for the `dependencies` field on the card itself

Three calls for the same pure function with the same input. Not a bug, but unnecessary work.

- **Severity:** Trivial
- **Recommendation:** Compute once, reuse

### 2.7 Risk Value Lookup Without Guard

In `computeCollateralQualityFromReserves()` at line 324-327:

```typescript
const weighted = reserves.reduce(
  (s, r) => s + r.pct * RESERVE_QUALITY_SCORE[r.risk],
  0,
);
```

If `r.risk` is an invalid string (not in the enum), `RESERVE_QUALITY_SCORE[r.risk]` returns `undefined`, and `pct * undefined = NaN`. The entire weighted sum becomes `NaN`, producing `NaN` as the score, which propagates through the grading system.

- **Severity:** Medium
- **Impact:** A single adapter returning an invalid risk value could produce NaN scores
- **Recommendation:** Add a guard: `RESERVE_QUALITY_SCORE[r.risk] ?? 0` or validate before scoring

### 2.8 Topological Sort Lacks Cycle Detection

`topologicalOrder()` at line 304-324 uses DFS with a `visited` set. If a circular dependency exists (e.g., A depends on B, B depends on A), the visited set prevents infinite recursion, but silently drops one node from the ordering. The dependency scores would use stale/missing upstream values.

- **Severity:** Low (unlikely in practice — curated data is human-reviewed)
- **Recommendation:** Add a cycle detection assertion in development/test builds

---

## 3. Test Coverage Analysis

### 3.1 Coverage Map

| Component | Coverage | Quality | Notes |
|-----------|----------|---------|-------|
| Adapter parsing (6/24 adapters) | ~25% of adapters | High | Tether, Circle, Ethena, Sky, Frax, GHO well-tested |
| Circuit breaker state machine | ~90% | High | All transitions tested |
| Live reserves store | ~85% | Good | Fallback/consistency tested |
| Sync orchestrator | ~80% | Good | Routing, dedup, breaker integration |
| Reserve dependency derivation | ~90% | High | All paths from empty to weighted |
| Individual dimension scorers | ~90% | High | Thresholds, edge cases |
| Live reserve passthrough | ~70% | Good | Basic live vs curated tested |
| Reserve risk consistency | ~95% | High | Cross-validates curated and adapter risk tiers |
| Stablecoin reserves API | ~85% | Good | Modes and cache headers tested |

### 3.2 Critical Test Gaps

#### Gap 1: Delta Alert Mechanism (0% coverage)

The collateral score drift detection (`report-cards-snapshot.ts:245-256`) is entirely untested. No tests verify:
- Delta calculation correctness
- Threshold boundary (14 vs 15 vs 16 points)
- Which coins trigger alerts
- Behavior when only live OR curated exists

#### Gap 2: End-to-End Pipeline Integration (0% coverage)

No test exercises the full pipeline: `syncLiveReserves → reserve_composition → loadFreshLiveReserveMap → computeCard → scoreResilience → overall grade`. Each step is tested in isolation but the seams between them are not validated.

#### Gap 3: 18 Untested Adapters

Only 6 of 24 adapters have unit tests. The untested adapters include high-risk ones:
- `mento` (HTML parsing)
- `chainlink-nav`, `chainlink-por` (on-chain)
- `evm-branch-balances` (multi-source)
- `erc4626-single-asset` (vault introspection)
- `collateral-positions-api` (DeFi positions)

#### Gap 4: Adapter Error Recovery Paths

No tests cover:
- Network timeouts within adapters
- Partial data responses (some fields missing)
- Breaker-blocked adapter runs
- Empty slices → error classification

#### Gap 5: Stale Data Transitions

No tests cover:
- Fresh → stale transition (48h boundary)
- Live → curated fallback when live becomes stale
- Score change magnitude during source transitions

#### Gap 6: Topological Ordering

No tests for the `topologicalOrder()` function used in report card computation. No cycle detection tests.

### 3.3 Test Priority Recommendations

1. **P0:** Add delta alert tests (threshold, calculation, boundary)
2. **P0:** Add `computeCollateralQualityFromReserves` test with invalid `risk` values (NaN propagation)
3. **P1:** Add integration test for live-reserve → scoring pipeline
4. **P1:** Add fixture-based tests for HTML adapters (mento, circle)
5. **P1:** Add `topologicalOrder` tests (basic order, diamond deps, isolated nodes)
6. **P2:** Add adapter error path tests (timeout, partial data, empty slices)
7. **P2:** Add stale data transition tests

---

## 4. Metadata Configuration

### 4.1 Coverage

44 stablecoins declare `liveReservesConfig` across 24 adapters. All 44 have matching curated `reserves` arrays, **except one:**

**wsrUSD (Wrapped Savings rUSD)** has `liveReservesConfig` with `adapter: "reservoir"` but **no curated `reserves` array**. This means:
- Live scoring works (when adapter succeeds)
- Curated fallback produces no collateral quality data
- `deriveDependencies(meta)` returns `meta.dependencies ?? []` (no reserve-derived deps)
- Delta alerting silently skips (no curated data to compare against)

- **Severity:** Low (single coin)
- **Recommendation:** Add curated `reserves` to wsrUSD for fallback and delta alerting

### 4.2 Adapter-to-Semantics Distribution

| Semantics | Count | Description |
|-----------|-------|-------------|
| `collateral-mix` | 17 | Mixed collateral baskets |
| `single-asset` | 11 | Single underlying |
| `protocol-reserve` | 10 | Protocol internal reserves |
| `attestation-mix` | 5 | Mixed attestation sources |

The `ousd` adapter is registered but has 0 configured coins — dead code candidate.

---

## 5. Prioritized Improvements

### Tier 1: Should Fix (Correctness / Observability)

| # | Issue | Location | Effort |
|---|-------|----------|--------|
| 1 | Wire delta alerts into alert system + D1 storage + /status | `report-cards-snapshot.ts:245-256` | Medium |
| 2 | Guard against invalid `risk` enum in `computeCollateralQualityFromReserves` | `report-cards.ts:324-327` | Small |
| 3 | Add orchestrator-level slice validation (sum ≈ 100%, valid risk enum, pct >= 0) | `sync-live-reserves.ts` after adapter return | Medium |
| 4 | Strengthen `isValidSlice` with risk enum check and pct range | `live-reserves-store.ts:91-98` | Small |
| 5 | Add delta alert unit tests (P0 test gap) | New test file | Small |
| 6 | Add NaN propagation test for invalid risk values | `report-cards.test.ts` | Small |

### Tier 2: Should Add (Resilience)

| # | Issue | Location | Effort |
|---|-------|----------|--------|
| 7 | Harden HTML adapters (circle, mento) — use structured selectors or add format-change detection | `circle-transparency.ts`, `mento.ts` | Medium |
| 8 | Add live-to-curated fallback transition alerting | `report-cards-snapshot.ts` | Medium |
| 9 | Fix breaker outcome first-wins bias (record worst per key) | `sync-live-reserves.ts:137-140` | Small |
| 10 | Add fixture-based tests for untested adapters (priority: mento, chainlink-nav, evm-branch-balances) | New test files | Medium |
| 11 | Add curated `reserves` to wsrUSD | `usd-minor.ts` | Small |
| 12 | Log malformed JSON skips in `loadFreshLiveReserveMap` | `live-reserves-store.ts:394` | Small |

### Tier 3: Nice to Have (Polish / Future-Proofing)

| # | Issue | Location | Effort |
|---|-------|----------|--------|
| 13 | Add E2E integration test for reserve → scoring pipeline | New test file | Large |
| 14 | Document `isBlacklistable` curated-vs-live inconsistency | `docs/report-cards.md` | Small |
| 15 | Add `topologicalOrder` unit tests + cycle detection | New test in `report-cards.test.ts` | Small |
| 16 | Remove or implement `inputs.fallbacks` | Types + orchestrator | Medium |
| 17 | Deduplicate `deriveDependencies` calls in `computeCard` | `report-cards-snapshot.ts` | Small |
| 18 | Remove dead `ousd` adapter (0 configured coins) | `reserve-adapters/ousd.ts` | Small |
| 19 | Add anomaly detection for large inter-sync reserve swings | `sync-live-reserves.ts` | Large |
| 20 | Consider historical snapshot retention | New migration | Medium |

---

## 6. File Reference

| File | Role |
|------|------|
| `worker/src/cron/sync-live-reserves.ts` | Cron orchestrator |
| `worker/src/cron/reserve-adapters/index.ts` | Adapter registry (24 adapters) |
| `worker/src/cron/reserve-adapters/helpers.ts` | Shared fetch/normalize/validate |
| `worker/src/cron/reserve-adapters/evm.ts` | EVM call helpers |
| `worker/src/lib/live-reserves-store.ts` | D1 persistence + freshness |
| `worker/src/api/stablecoin-reserves.ts` | Public API handler |
| `worker/src/handlers/scheduled/hourly-live-reserves.ts` | Cron trigger |
| `worker/src/lib/report-cards-snapshot.ts` | Live reserve → scoring integration |
| `shared/lib/report-cards.ts` | Pure grading engine |
| `shared/lib/reserve-templates.ts` | Dependency derivation |
| `shared/lib/stablecoins/usd-major.ts` | Major coin configs |
| `shared/lib/stablecoins/usd-minor.ts` | Minor coin configs |
| `shared/lib/stablecoins/non-usd.ts` | Non-USD coin configs |
| `docs/live-reserves.md` | Feature documentation |
| `docs/report-cards.md` | Scoring documentation |
