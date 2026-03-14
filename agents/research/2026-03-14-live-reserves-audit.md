# Live Reserve Sync — Comprehensive Audit Report

**Date:** 2026-03-14
**Scope:** Code review, operational data evaluation, live observation
**Feature age:** ~1 week in production

---

## Executive Summary

The live reserve sync feature is **well-architected and production-ready**. The adapter pattern, circuit breaker integration, fallback resolution, and operator tooling are solid. 26 of 28 configured coins are syncing cleanly. Two adapters (Ethena, Reservoir) are in persistent error state but still serving fresh-enough cached data.

This audit identifies **1 high-severity issue** (circuit breaker amplification), **4 medium-severity issues**, and **several low-severity improvements** that would harden the system for long-term maintainability.

---

## 1. Architecture Assessment

### Strengths

| Area | Assessment |
|------|------------|
| **Adapter pattern** | Clean `AdapterFn` signature, 16 specialized adapters, registry lookup. Easy to add new adapters without touching orchestration. |
| **Shared source caching** | `buildSharedSourceCacheKey` prevents redundant HTTP calls when multiple coins share a source. Well-keyed on adapter+version+semantics+inputs+params. |
| **Graceful degradation** | 5-mode fallback chain (live → live-stale → curated-fallback → template-fallback → unavailable). Users always see *something*. |
| **Circuit breaker** | Per-source breaker with 3-failure threshold, 30-min probe interval, alert webhooks on open/close transitions. |
| **Atomic persistence** | `upsertReserveSnapshot` uses `db.batch()` for atomic composition+sync-state writes. |
| **Consistency invariant** | `hasConsistentSnapshotRecord` prevents serving stale composition when sync state has moved on. |
| **Freshness model** | 48-hour `LIVE_RESERVE_FRESHNESS_SEC` with clear stale/bootstrap states. |
| **Type safety** | Full TypeScript coverage with discriminated unions for input kinds, risk levels, and presentation modes. |
| **Test coverage** | 218 test files, 1964 tests all passing. Each adapter has dedicated unit tests. Data integrity validators in `stablecoins.test.ts`. |
| **Documentation** | `docs/live-reserves.md` is comprehensive and accurate against the code. |
| **Isolated trigger** | Dedicated `11 * * * *` cron slot prevents connection-pool contention with other fetch-heavy jobs. |

### Architecture Diagram (Data Flow)

```
StablecoinMeta.liveReservesConfig
       |
       v
syncLiveReserves() [cron at :11]
  |-- for each configured coin:
  |     |-- shouldAttemptFetch() [circuit breaker check]
  |     |-- getReserveAdapter() [registry lookup]
  |     |-- runAdapter() [shared source cache]
  |     |     |-- adapter(coin, config, signal, ctx)
  |     |     |     |-- fetchJsonWithRetry / fetchTextWithRetry / fetchOnchainUint256
  |     |     |     |-- adapt*() [pure transformation]
  |     |     |     '-- return { slices, warnings?, metadata? }
  |     |-- upsertReserveSnapshot() [D1 batch: composition + sync_state]
  |     '-- recordOutcomeSafe() [circuit breaker telemetry]
  |
  v
reserve_composition (D1)  +  reserve_sync_state (D1)
       |
       v
resolveReserveResult() [API handler]
  |-- getReserveComposition + getReserveSyncState
  |-- hasConsistentSnapshotRecord [consistency check]
  |-- fallback to getReserves(meta) [curated/template]
  '-- return ReserveResult with mode + sync status
       |
       v
GET /api/stablecoin-reserves/:id
  |-- Cache-Control: s-maxage=3600 (live) or s-maxage=300 (fallback)
  '-- Frontend: useStablecoinReserves() → ReserveTreemap
```

---

## 2. Operational Status (2026-03-14 ~11:30 UTC)

### Sync Health Summary

| Metric | Value |
|--------|-------|
| **Configured coins** | 28 |
| **Syncing OK** | 26 |
| **In error** | 2 (usde-ethena, wsrusd-reservoir) |
| **Stale** | 0 |
| **Missing** | 0 |
| **Last global success** | 2026-03-14 11:11 UTC |

### Per-Adapter Status (from API spot check)

| Adapter | Coins | Status | Notes |
|---------|-------|--------|-------|
| `accountable` | 5 | All OK | Each coin has unique breakerScope |
| `asymmetry` | 1 | OK | |
| `btcfi` | 1 | OK | |
| `collateral-positions-api` | 2 | OK | |
| `crvusd` | 1 | OK | |
| `erc4626-single-asset` | 2 | OK | |
| `ethena` | 1 | **ERROR** | Failing since ~2026-03-13 21:00 UTC (~14h). API responds fine externally. |
| `evm-branch-balances` | 2 | OK | |
| `falcon` | 1 | OK | |
| `fx` | 1 | OK | |
| `infinifi` | 1 | OK | |
| `m0` | 3 | OK | All share breakerScope "m0" — amplification risk (see H1) |
| `mento` | 2 | OK | HTML scraping — fragility risk (see M3) |
| `openeden-usdo` | 1 | OK | |
| `reservoir` | 1 | **ERROR** | Same failure window as Ethena. API responds fine externally. |
| `single-asset` | 3 | OK | |

### Error Analysis: Ethena & Reservoir

Both adapters entered error state around the same time (~2026-03-13 21:00 UTC) and have been failing consistently since. Both source APIs respond normally when fetched externally. Key observations:

- **lastSuccessAt:** 1773436286 (2026-03-13 ~21:11 UTC)
- **lastAttemptedAt:** 1773486717 (2026-03-14 ~11:11 UTC)
- **Gap:** ~14 hours of failures
- **Data impact:** None visible — both still serve mode="live" with data within the 48h freshness window
- **Possible cause:** Worker-side connectivity issue, transient CF Workers fetch failures, or a subtle API response change that triggers a parsing error. The `last_error` field is not exposed via the public API, only visible on `/status` (auth-gated).

**Recommendation:** Expose `lastError` (or a truncated version) in the public sync object so operators can diagnose without needing `/status` auth. Also check Worker logs for the actual error messages.

---

## 3. Issues Found

### H1 (High): Circuit Breaker Amplification for Shared-Scope Adapters

**File:** `worker/src/cron/sync-live-reserves.ts:100-203`

**Problem:** When multiple coins share a `breakerScope` AND a shared source (same `buildSharedSourceCacheKey`), a single transient failure records N consecutive failures against the same breaker key in one cron run. With `CIRCUIT_OPEN_THRESHOLD = 3`, a single failure of the M0 adapter (3 coins sharing scope `"m0"`) opens the circuit immediately, blocking all 3 coins for 30 minutes.

**Mechanism:**
1. M0 GraphQL endpoint has a transient 503
2. Coin 1 (m-m0): adapter throws → `recordOutcomeSafe("live-reserves:m0", false)` → consecutiveFailures = 1
3. Coin 2 (musd-metamask): same cached rejected promise → same throw → consecutiveFailures = 2
4. Coin 3 (usdn-noble): same cached rejected promise → same throw → consecutiveFailures = 3 → **CIRCUIT OPENS**

A single transient failure should not immediately open the circuit. The `breakerScope` sharing is intentional (same source), but the amplification within a single cron run is not.

**Affected adapters:**
- `m0`: 3 coins, all sharing `breakerScope: "m0"` — opens immediately on any failure
- `mento`: 2 coins, sharing `breakerScope: "mento-reserve"` — 2 failures per run (under threshold alone, but 2 consecutive runs would open)
- `accountable`: 5 coins, each with unique breakerScope — NOT affected (correct design)

**Proposed fix:** When coins share a source via `sharedSourceResults`, record the circuit breaker outcome only once per unique breakerKey per cron run, not once per coin. Track which breakerKeys have already been recorded and skip duplicates:

```typescript
const recordedBreakerOutcomes = new Set<string>();

// In the success/failure handlers:
if (!recordedBreakerOutcomes.has(breakerKey)) {
  await recordOutcomeSafe(db, breakerKey, success);
  recordedBreakerOutcomes.add(breakerKey);
}
```

---

### M1 (Medium): `lastError` Not Exposed in Public API

**Files:** `worker/src/api/stablecoin-reserves.ts`, `worker/src/lib/live-reserves-store.ts`

**Problem:** The `ReserveSyncStateView` type (shared/types) includes `status`, `stale`, `bootstrap`, `warnings`, and timestamps — but does NOT include `lastError`. The D1 `reserve_sync_state` table stores `last_error`, but it's never surfaced in the API response.

**Impact:** Operators checking the public reserves endpoint can see `"status": "error"` but have no visibility into WHY. Diagnosis requires either:
- Auth-gated `/status` endpoint access
- Direct D1 query (`wrangler d1 execute`)
- Worker logs (10% sampling rate)

**Proposed fix:** Add `lastError?: string` to `ReserveSyncStateView` and populate it in `resolveReserveResult()`. Consider truncating to 200 chars to prevent leaking verbose stack traces.

---

### M2 (Medium): No Per-Adapter Timeout Configuration

**File:** `worker/src/cron/reserve-adapters/helpers.ts:71-72`

**Problem:** All adapters use the same `fetchJsonWithRetry` defaults: 10s timeout, 2 retries. Some adapters call heavy endpoints (e.g., M0 GraphQL with collateral aggregation, Reservoir with full balance sheet) that may legitimately need more time, while others (single-asset probes) could use tighter timeouts.

Individual adapters override to 12s in some cases (`ethena`, `falcon`, `mento`, `openeden`, `m0`), but this is ad-hoc, not systematic.

**Impact:** Adapters hitting slower APIs may timeout unnecessarily. Conversely, fast adapters keep the cron running longer than needed when sources are unresponsive.

**Proposed fix:** Add an optional `timeoutMs` field to `LiveReservesConfig` or `LiveReservesConfig.params` that adapters can read from config rather than hardcoding. This makes timeout tuning an operator concern, not a code change.

---

### M3 (Medium): Mento HTML Scraping Fragility

**File:** `worker/src/cron/reserve-adapters/mento.ts:11-42`

**Problem:** The Mento adapter parses reserve composition by searching for string markers in server-rendered HTML:
```typescript
const RESERVE_COMPOSITION_START = '\\"reserveComposition\\":';
const RESERVE_COMPOSITION_END = '],\\"reserveHoldings\\":';
```

This is inherently fragile. Any change to the Mento website's server-rendered JSON structure (key rename, reordering, additional escaping, or migration to client-side rendering) would break the adapter silently.

**Impact:** Mento serves 2 coins (cUSD, cEUR). A website update would cause both to fail simultaneously, amplified by the shared breakerScope (see H1, though only 2 coins = under threshold).

**Proposed fix:**
1. Monitor for a public Mento API endpoint that could replace HTML scraping
2. Add a structural integrity warning: if the parsed array has fewer than 3 entries or total percentages < 50%, emit a warning
3. Consider adding a `fallbacks` input pointing to an alternative data source (the config supports it, but no adapter uses fallbacks yet)

---

### M4 (Medium): Fallback Inputs Declared But Never Used

**Files:** `shared/types/core.ts` (LiveReservesConfig), all adapters

**Problem:** `LiveReservesConfig.inputs` supports `fallbacks?: LiveReserveInput[]`, but:
1. No adapter implementation reads or uses fallback inputs
2. No coin configuration declares fallback inputs
3. The cron orchestrator doesn't attempt fallback resolution on primary failure

The fallback mechanism is a dead code path.

**Impact:** No immediate operational impact, but it represents an unused resilience lever. If the primary source for an adapter goes down, there's no automatic failover — the adapter simply fails and the circuit breaker handles it.

**Proposed fix:** Either:
- Implement fallback resolution in the cron orchestrator (try primary → on failure, try each fallback)
- Or remove the `fallbacks` field from the type to avoid suggesting a capability that doesn't exist

The first option is recommended as it adds meaningful resilience, especially for HTML-scraped sources (Mento).

---

### L1 (Low): Edge Cache Masks Sync Status for Operators

**File:** `worker/src/api/stablecoin-reserves.ts:6-7`

**Problem:** When a coin has mode="live" (i.e., a valid recent snapshot exists), the response is cached at the edge for 1 hour (`s-maxage=3600`). If the adapter starts failing, operators querying the public API won't see the "error" status until the edge cache expires.

**Impact:** Low — operators should use `/status` for monitoring. But it can cause confusion during troubleshooting.

**Proposed fix:** No code change needed, but document this behavior explicitly in `docs/live-reserves.md` to set operator expectations.

---

### L2 (Low): `parseSlices` Does Not Validate Slice Structure

**File:** `worker/src/lib/live-reserves-store.ts:90-97`

**Problem:** `parseSlices` does `JSON.parse(value)` and checks `Array.isArray(parsed)`, then casts with `as ReserveSlice[]`. It does not validate that each element has `name`, `pct`, and `risk` fields. Corrupt D1 data could produce malformed slices that pass the consistency check but render incorrectly on the frontend.

**Impact:** Low — data only enters through the adapter → normalize → upsert path, which produces valid slices. But a manual D1 edit or migration error could introduce corrupt data.

**Proposed fix:** Add element-level validation (at least check for `name`, `pct`, `risk` being present and correct types).

---

### L3 (Low): Overview Classification Counts "Error" Coins as "Degraded"

**File:** `worker/src/lib/live-reserves-store.ts:330`

**Problem:** In `computeReserveCompositionOverview`, a coin with `last_status = "error"` but a valid fresh snapshot is classified as "degraded", not separately tracked:
```typescript
if (sync && (sync.last_status !== "ok" || (sync.last_success_at != null && !hasSnapshot))) {
  degradedCoins++;
```

**Impact:** Low — the `/status` health card shows "Degraded: 2" instead of distinguishing "Error: 2". Operators need to drill into individual coins to distinguish warnings from failures.

**Proposed fix:** Add an `errorCoins` counter to `ReserveCompositionOverview` that counts coins where `last_status === "error"`, separate from `degradedCoins` (which would then only count `"degraded"` and `"skipped"` statuses).

---

### L4 (Low): Inconsistent Unknown-Asset Handling Across Adapters

**Problem:** Adapters handle unknown/unexpected data inconsistently:

| Adapter | Unknown Asset Behavior |
|---------|----------------------|
| `ethena` | Buckets into "other-crypto", emits warning |
| `crvusd` | Skips entirely, emits warning |
| `reservoir` | Skips entirely, emits warning |
| `infinifi` | Uses default risk based on farm type, emits warning |
| `falcon` | Buckets into "other-crypto", no warning |
| `mento` | Uses default risk "medium", no warning |
| `collateral-positions-api` | Uses `inferRisk()` fallback, no warning |

**Impact:** Low — some adapters silently absorb new asset types without operator awareness. A new collateral type added by a protocol would be silently bucketed with a possibly incorrect risk level.

**Proposed fix:** Standardize: all adapters should emit a warning when encountering an unmapped asset. This is already the pattern for `ethena`, `crvusd`, `reservoir`, and `infinifi` — extend it to `falcon`, `mento`, and `collateral-positions-api`.

---

### L5 (Low): Migration Comment Says "Daily" but Cron Is Hourly

**File:** `worker/migrations/0064_reserve_composition.sql:1`

```sql
-- Live reserve composition synced daily from protocol data APIs.
```

The cron actually runs hourly (`11 * * * *`). This is a minor documentation inaccuracy in the migration comment.

---

## 4. Test Coverage Assessment

### Current Coverage

| Area | Coverage | Quality |
|------|----------|---------|
| Adapter unit tests | 16/16 adapters | Good — each tests happy path + edge cases |
| Adapter helpers | `normalizeSlices`, `slicesFromValues`, `isReserveRisk` | Good |
| Cron orchestration | Source dedup, degraded path, circuit breaker skip | Good |
| API handler | 404, fallback, live modes, cache headers | Adequate |
| D1 persistence | Upsert, consistency check, overview computation | Good |
| Data integrity | Adapter reuse validation, breaker scope uniqueness, ETH risk alignment | Excellent |
| Reserve templates | Dependency derivation, coinId validation | Good |

### Coverage Gaps

1. **No integration tests**: No test exercises the full sync → D1 → API pipeline
2. **No error scenario tests**: No adapter tests for HTTP 403/500, timeout, malformed JSON responses
3. **No circuit breaker amplification test**: The H1 issue isn't caught by existing tests
4. **No stale data tests**: No test for `resolveReserveResult` when liveAt is beyond freshness window
5. **No corrupt D1 data tests**: No test for malformed JSON in slices/warnings columns
6. **No AbortSignal tests**: No test for cron timeout / signal cancellation behavior

---

## 5. Security Assessment

| Check | Status |
|-------|--------|
| SQL injection | Safe — all queries use parameterized binds |
| XSS via reserve data | Safe — slice names are rendered as text, not HTML |
| Error message leakage | Safe — 404 responses are generic; adapter errors logged server-side only |
| API key exposure | Safe — `AdapterContext` passes keys only to EVM RPC calls, never to external APIs |
| Cache poisoning | Safe — cache keys are request-path based, no user-controlled variance |
| Rate limiting | Covered — public API has D1-backed rate limiting |
| CORS | Properly configured with origin allowlist |
| Input validation | Adapter params validated at runtime; invalid configs throw before fetching |

---

## 6. Maintainability Assessment

### Adding a New Adapter

The process is well-defined:
1. Create `worker/src/cron/reserve-adapters/{name}.ts` implementing `AdapterFn`
2. Register in `worker/src/cron/reserve-adapters/index.ts`
3. Add `liveReservesConfig` to coin(s) in `shared/lib/stablecoins.ts`
4. Add unit test in `worker/src/cron/reserve-adapters/__tests__/{name}.test.ts`
5. Update adapter count in `docs/live-reserves.md`

**Friction points:**
- No adapter template / generator — each new adapter is written from scratch
- No systematic way to test against live APIs (only unit tests with mocked responses)
- The `breakerScope` must be explicitly set for reused adapters (enforced by test), but the amplification risk (H1) isn't documented

### Code Quality

- Functions are well-sized (largest adapter is ~180 lines)
- Pure transformation functions are separated from I/O (e.g., `adaptEthenaCollateral` vs `fetchEthenaReserves`)
- Shared helpers reduce boilerplate (`slicesFromValues`, `normalizeSlices`, `requireJsonInput`)
- Consistent error handling: adapters throw on invalid data, cron catches and records

---

## 7. Recommendations Priority

| ID | Severity | Effort | Description |
|----|----------|--------|-------------|
| H1 | High | Small | Fix circuit breaker amplification for shared-scope adapters |
| M1 | Medium | Small | Expose `lastError` in public API sync object |
| M2 | Medium | Small | Add configurable per-adapter timeout |
| M3 | Medium | Small | Add structural integrity warnings for Mento HTML parsing |
| M4 | Medium | Medium | Implement or remove fallback input resolution |
| L1 | Low | Trivial | Document edge cache behavior for operators |
| L2 | Low | Small | Validate slice structure in `parseSlices` |
| L3 | Low | Small | Separate error vs degraded counts in overview |
| L4 | Low | Small | Standardize unknown-asset warning across all adapters |
| L5 | Low | Trivial | Fix migration comment |

### Immediate Actions (before next release)

1. **Investigate Ethena/Reservoir failures**: Check Worker logs or query `reserve_sync_state.last_error` via `wrangler d1 execute` for the actual error messages
2. **Fix H1**: Prevent circuit breaker amplification — small, high-impact change
3. **Fix M1**: Expose lastError — enables faster operator debugging

---

## 8. Live Observation Notes

### Cron Run at 11:11 UTC (2026-03-14)

- **Most recent run timestamp:** 1773486717 (2026-03-14 11:11:57 UTC)
- **26 coins** updated successfully (matching lastAttemptedAt = lastSuccessAt = 1773486717)
- **2 coins** failed (Ethena, Reservoir): lastAttemptedAt advanced to 1773486717 but lastSuccessAt remains at 1773436286
- **Edge cache observation**: Public API responses were still served from the 11:11 cache at 12:35 UTC (1-hour s-maxage working as designed). Fresh data from the 12:11 run was not yet visible via public API.

### Source API Verification

Both failing source APIs respond correctly when fetched externally:
- `app.ethena.fi/api/positions/current/collateral`: 200 OK, 77 entries (16 non-zero), $5.93B total
- `app.reservoir.xyz/api/reserves/raw`: 200 OK, full balance sheet with $177M total assets

The failures are likely Worker-side (network/timeout) rather than source-side. Both sources going down at the same time (~21:00 UTC March 13) and staying down for 14+ hours suggests a systemic issue rather than independent adapter bugs.

---

## Appendix: File Index

| Category | Files |
|----------|-------|
| **Cron** | `worker/src/cron/sync-live-reserves.ts`, `worker/src/handlers/scheduled/hourly-live-reserves.ts` |
| **Adapters** | `worker/src/cron/reserve-adapters/{index,helpers,evm}.ts` + 16 adapter files |
| **Storage** | `worker/src/lib/live-reserves-store.ts`, `worker/migrations/0064_*.sql`, `worker/migrations/0065_*.sql` |
| **API** | `worker/src/api/stablecoin-reserves.ts` |
| **Shared** | `shared/lib/reserve-templates.ts`, `shared/lib/reserve-asset-risk.ts`, `shared/types/core.ts` |
| **Frontend** | `src/hooks/use-stablecoin-reserves.ts`, `src/components/reserve-treemap.tsx`, `src/components/status/reserve-sync-health.tsx` |
| **Tests** | `worker/src/cron/__tests__/sync-live-reserves.test.ts`, `worker/src/api/__tests__/stablecoin-reserves.test.ts`, `worker/src/lib/__tests__/live-reserves-store.test.ts`, 16 adapter test files, `shared/lib/__tests__/reserve-asset-risk.test.ts` |
| **Docs** | `docs/live-reserves.md` |
