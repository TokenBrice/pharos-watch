# Post-Release Codebase Audit — 2026-03-01

**Scope**: Yield Intelligence, Mint/Burn Tracker, DEWS, Depeg Tracker Page, and cross-cutting concerns.

---

## 1. Executive Summary

The codebase is in strong health after three major feature launches. Build, type-check (`tsc --noEmit`), lint (47 warnings, 0 errors), and all 213 tests pass. Zero `as any` casts, zero `@ts-ignore`, zero `console.log` in production code, zero TODO/FIXME comments — an unusually clean baseline. The architecture is well-layered (pure compute → cron → cache → API → hooks → components) with consistent patterns across all three features.

One **critical display bug** exists (flight-to-quality intensity double-multiplied by 100), alongside several high-severity type/data gaps and a handful of medium/low maintainability items. Total: **1 Critical, 6 High, 14 Medium, 14 Low**.

**Top three priorities:**
1. **F-001** — Fix flight-to-quality intensity display (shows 2000% instead of 20%)
2. **F-003** — Guard `computeApyFromRate` against negative exchange rates producing NaN
3. **F-005** — Add `isValidStablecoinId()` to 5 API endpoints missing input validation

---

## 2. Findings Table

### Critical

| ID | Category | Feature | Location | Description | Recommendation | Effort |
|----|----------|---------|----------|-------------|----------------|--------|
| F-001 | Reliability | Mint-Burn | `src/components/flow-gauge.tsx:293` | `Math.round(flightIntensity * 100)` double-converts intensity. `detectFlightToQuality` already returns 0–100 (see `mint-burn-scoring.ts:153`). When FTQ triggers with $200M outflows, UI shows "2000% intensity" instead of "20%". | Change to `Math.round(flightIntensity)` | Small |

### High

| ID | Category | Feature | Location | Description | Recommendation | Effort |
|----|----------|---------|----------|-------------|----------------|--------|
| F-002 | Reliability | Yield | `worker/src/cron/sync-yield-data.ts:373,406` | `safeVariance` guards `apyVarianceScore` with `Number.isFinite()` but is never used. Line 406 inserts the raw `variance30d` instead. If upstream `samples` contain NaN (corrupt on-chain data), `variance30d` propagates NaN to D1. | Use `safeVariance` in the INSERT bind or add a separate `Number.isFinite()` guard on `variance30d`. Remove the unused variable after. | Small |
| F-003 | Reliability | Yield | `worker/src/cron/yield-helpers.ts:6-8` | `computeApyFromRate` does `Math.pow(rateNow / ratePrev, 365.25/days) - 1`. If `rateNow < 0` (corrupt on-chain data), `Math.pow(negative, non-integer)` returns NaN. The `safePys` guard catches NaN for PYS but `currentApy`, `apy7d`, `apy30d` have no NaN guard before D1 write. | Add `if (rateNow <= 0 \|\| ratePrev <= 0) return 0;` at the top of `computeApyFromRate`. | Small |
| F-004 | Reliability | Mint-Burn | `worker/src/api/mint-burn-flows.ts:210` | Largest-event subquery is hardcoded to `nowSec - 24 * 3600` regardless of the user's `hours` parameter. When a user selects 7d or 30d, the "Largest Event" column still shows last-24h data, creating a confusing mismatch. | Use `windowStart` (the user-selected window) instead of `nowSec - 24 * 3600`. | Small |
| F-005 | Security | Cross-cutting | `worker/src/api/stress-signals.ts`, `mint-burn-flows.ts`, `mint-burn-events.ts`, `depeg-events.ts`, `blacklist.ts` | These 5 endpoints accept a `stablecoin` query param without `isValidStablecoinId()` validation. While parameterized SQL prevents injection, arbitrary strings pollute the edge cache with garbage keys. Older endpoints (yield-history, supply-history, dex-liquidity-history) do validate. | Add `isValidStablecoinId()` check returning 400 for invalid IDs, matching the pattern in `yield-history.ts`. | Small |
| F-006 | Reliability | Mint-Burn | `worker/src/api/mint-burn-flows.ts:198-211` | Largest-event query uses `GROUP BY e.stablecoin_id` after a JOIN that can match multiple rows (when events tie on `COALESCE(amount_usd, amount)`). SQLite picks an arbitrary row for non-aggregated columns, so txHash/direction/timestamp may be from different rows. | Add `ORDER BY e.timestamp DESC` before the GROUP BY, or use a window function with `ROW_NUMBER() ... ORDER BY max_val DESC, timestamp DESC`. | Small |
| F-007 | Reliability | Cross-cutting | `worker/src/lib/fetch-retry.ts:24-33` | Response bodies are not consumed on 429 (before retry) or on non-retryable errors. In Workers, unconsumed `Response` bodies hold TCP connections open until GC. With 20+ call sites across crons sharing the 6-connection-per-trigger pool, this creates connection pressure during error bursts. | Add `await res.body?.cancel();` after line 30 (429 continue) and after line 33 (non-retryable error). | Small |

### Medium

| ID | Category | Feature | Location | Description | Recommendation | Effort |
|----|----------|---------|----------|-------------|----------------|--------|
| F-008 | Maintainability | DEWS | `src/components/dews-detail.tsx:23-34` | `SIGNAL_META` lists 7 signals but the compute function produces 8 (missing `yield`). The yield signal contributes to the score but is invisible in the detail breakdown UI. | Add `yield: { name: "Yield Anomaly", metricKey: "warnings", metricLabel: "warnings" }` to `SIGNAL_META`. Also update `formatMetric` to handle array-type values. | Small |
| F-009 | Maintainability | DEWS | `src/components/dews-detail.tsx:129`, `worker/src/lib/dews.ts:4`, `src/app/about/page.tsx:341`, `src/app/methodology/page.tsx:958` | Hardcoded "7 sub-signals" text in 4 locations. The actual count is 8 since yield signal was added. | Update all references to "8 sub-signals". | Small |
| F-010 | Maintainability | DEWS | `worker/src/lib/dews.ts:80-89` | WEIGHTS sum to 1.15, not 1.0. Normalization at runtime (`weightedSum / totalWeight`) makes this correct, but nominal weights don't reflect effective weights. The comment says "7 sub-signals" too. | Either re-normalize to 1.0 or add a prominent code comment explaining the intentional >1.0 sum and redistribution behavior. | Small |
| F-011 | Maintainability | Yield | `worker/src/cron/sync-yield-data.ts:355-356` | Variable `variance30d` and DB column `apy_variance_30d` are named "variance" but the formula computes standard deviation (`Math.sqrt(...)`). Misleading for data consumers. | Since the field isn't exposed in the frontend UI yet, rename to `stdDev30d` / `apy_stddev_30d` / `apyStdDev30d` throughout, or remove `Math.sqrt()` if variance was intended. | Medium |
| F-012 | Maintainability | Yield | `worker/src/cron/sync-yield-data.ts:213-218` | Tier 1 APY calculation uses exactly `days = 7` but the "previous" exchange rate may be from 10+ days ago if the cron had a gap. This skews the annualized rate. | Compute actual delta-days from the returned row's timestamp: `const actualDays = (startSec - prevRow.recorded_at) / 86400` and pass that to `computeApyFromRate()`. | Small |
| F-013 | Maintainability | Website | `src/app/depeg/client.tsx:188-200` + `src/components/peg-heatmap.tsx:124-147` | Heatmap renders its own filter controls (peg currency, search, governance) that duplicate the depeg page's unified filters above the table. Both sets are synced via URL params, but the visual duplication is confusing. | Pass a `hideFilters` prop to `PegHeatmap` and suppress filter chrome when embedded in the depeg page. | Small |
| F-014 | Maintainability | Mint-Burn | `src/components/flow-table.tsx:28-36`, `src/components/flow-summary-card.tsx:20-28` | `getNetColor()` and `getNetPrefix()` are identical functions duplicated across two files. | Extract to a shared utility (e.g., `src/lib/format.ts`) and import from both. | Small |
| F-015 | Maintainability | Mint-Burn | `src/components/flow-table.tsx:203` | `flowIntensity` displayed as raw float (e.g., "37.500000000000004") due to IEEE 754 artifacts. The gauge component uses `Math.round()` but the table does not. | Change to `{Math.round(coin.flowIntensity)}` or `{coin.flowIntensity.toFixed(0)}`. | Small |
| F-016 | Maintainability | Cross-cutting | `worker/migrations/0031_mint_burn_v2.sql`, `worker/migrations/0031_yield_data.sql` | Duplicate migration number `0031_`. Both are already applied and independent, but violates sequential numbering and causes confusion. | Rename one to a unique number (e.g., `0034_mint_burn_v2.sql`). Since both are applied in production, this is a local consistency fix only. | Small |
| F-017 | Maintainability | Cross-cutting | `src/hooks/use-stress-signals.ts` | Stress signal types (`StressSignalsAllResponse`, `StressSignalDetailResponse`) are defined locally in the hook file. Also, unlike mint-burn hooks, no Zod schema is passed for runtime validation. | Move types to `src/lib/types.ts`. Create Zod schemas and pass to `useApiQuery`. | Medium |
| F-018 | Maintainability | Cross-cutting | `worker/src/lib/dews.ts:14`, `src/lib/classification.ts:293` | `ThreatBand` type literal is defined identically in two locations (worker and frontend). Could drift apart. | Export `ThreatBand` from `src/lib/types.ts` and import in both `classification.ts` and `dews.ts`. | Small |
| F-019 | Maintainability | Cross-cutting | `src/lib/types.ts:677-699`, `worker/src/cron/sync-yield-data.ts:600` | `warningSignals` is computed, stored in D1, and serialized into the yield-rankings cache response, but `YieldRanking` interface has no `warningSignals` field. Type/API shape mismatch. | Add `warningSignals: string[]` to the `YieldRanking` interface. | Small |
| F-020 | Maintainability | Website | `src/components/depeg-tracker-table.tsx:244-345` | When all rows are filtered out, the table shows empty body with "Showing 0-0 of 0 stablecoin". No "No results match your filters" empty state. | Add an empty state `<TableRow>` with colSpan message when `paginated.length === 0`. | Small |
| F-021 | Maintainability | Cross-cutting | `src/hooks/use-yield-history.ts:10` | Uses `CRON_1H` staleTime but yield sync runs every 30 minutes (`10,40 * * * *`). Convention says staleTime = cron interval. | Change to `CRON_30MIN`. (Moot since the hook is unused — see F-022.) | Small |

### Low

| ID | Category | Feature | Location | Description | Recommendation | Effort |
|----|----------|---------|----------|-------------|----------------|--------|
| F-022 | Simplicity | Yield | `src/hooks/use-yield-history.ts` | `useYieldHistory` hook is exported but never imported by any component. Dead code. | Remove if no near-term plans to use it. If planned, add a comment. | Small |
| F-023 | Simplicity | Yield | `worker/src/cron/yield-helpers.ts:47-55` | `WarningInput` has both `currentApy` and `apy` fields; caller passes `y.currentApy` to both. Redundant. | Remove `apy` field and use `currentApy` in `detectWarningSignals`. | Small |
| F-024 | Simplicity | Yield | `worker/src/cron/yield-config.ts:95-98,110-111` | 3 empty-string entries in `YIELD_POOL_MAP` (e.g., `"173": ""`). Serve as documentation but are confusing — they're truthy-checked and silently skipped. | Remove empty entries; add explanation as comments in `YIELD_VARIANT_MAP`. | Small |
| F-025 | Simplicity | DEWS | `worker/src/lib/dews.ts:59` | `mintBaseline30dUsd` field in `DEWSInput` is populated from DB but never read by any compute function. | Remove the field or add a comment marking it as reserved for future use. | Small |
| F-026 | Maintainability | Mint-Burn | `worker/src/cron/sync-mint-burn.ts:101` | Non-null assertion `config.chain.evmChainId!` — safe today since all configs use Ethereum, but fragile for Phase 2 non-EVM chains. | Add guard: `if (config.chain.evmChainId === null) { continue; }` | Small |
| F-027 | Maintainability | Website | `src/components/depeg-tracker-table.tsx:78,86` | `useSort<SortKey \| "__attention">("__attention" as SortKey, "desc")` uses unsafe cast for sentinel value. | Add `"__attention"` to the `SortKey` union type directly. | Small |
| F-028 | Maintainability | Website | `src/components/depeg-tracker-table.tsx:355` | `noun="stablecoin"` (singular) — pagination reads "Showing 1-25 of 143 stablecoin". | Change to `noun="stablecoins"`. | Small |
| F-029 | Maintainability | Website | `src/components/feature-highlights.tsx` | Depeg Tracker page not listed in `FEATURES` array. Never appears in homepage feature highlights. | Add a Depeg Tracker entry matching the existing pattern. | Small |
| F-030 | Maintainability | Website | `src/app/depeg/client.tsx:142-165` | ToggleGroup filter components lack `aria-label` attributes. Screen readers can't distinguish the two filter groups. | Add `aria-label="Filter by peg currency"` and `aria-label="Filter by governance type"`. | Small |
| F-031 | Maintainability | Cross-cutting | `src/lib/types.ts:521-527` | Frontend `CronRun` type is missing `metadata?: Record<string, unknown>` field that the worker sends. | Add the field to match the API shape. | Small |
| F-032 | Testing | DEWS | `worker/src/lib/__tests__/dews.test.ts` | No test cases for: yield anomaly signal, PSI systemic amplifier, minimum weight threshold (< 0.3), smoothing behavior. | Add test cases for these 4 scenarios. | Medium |
| F-033 | Testing | Cross-cutting | `worker/src/api/__tests__/` | No API contract tests for: stress-signals (both modes), yield-rankings, yield-history, mint-burn-events. | Add contract tests following the `mint-burn-flows.test.ts` pattern. | Medium |
| F-034 | Maintainability | Cross-cutting | `worker/src/api/stress-signals.ts` | Missing `addFreshnessHeaders()` on response (no `X-Data-Age` or stale `Warning` header). Other data endpoints include them. | Add `addFreshnessHeaders()` to both aggregate and detail response paths. | Small |

---

## 3. Positive Observations

**Architecture & Design:**
- Clean layered architecture: pure compute functions → cron jobs → cache → API handlers → TanStack Query hooks → React components. All three features follow this pattern consistently.
- Compare-and-swap cache writes (`setCacheIfNewer`) prevent slow cron runs from overwriting fresher data.
- Circuit breaker pattern with persistence in D1 and webhook alerting is used for all external API dependencies.
- Cron dependency chaining in `index.ts` correctly ensures DEWS/PSI run after `stablecoinsSync`, and yield runs after `dexSync`.

**Code Quality:**
- Zero `as any` casts across the entire codebase. TypeScript strict mode fully honored.
- Zero `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` directives.
- Zero `console.log` statements in production code. Clean production logging through structured `console.warn` in worker.
- Zero TODO/FIXME/HACK comments — all tracked work is in issues or plans.
- All SQL queries use parameterized bindings (`.bind()`). No string interpolation of user input anywhere.

**Defensive Coding:**
- NaN guards (`Number.isFinite()`) on critical financial fields before D1 writes.
- Rate limiter sharing across crons respects the 6-connection-per-trigger limit.
- Subrequest budget system prevents runaway API consumption.
- Block safety margins prevent skipping unindexed events.
- `INSERT OR IGNORE` for idempotent event ingestion.
- Dust threshold filtering prevents noise from micro-transactions.

**Frontend:**
- Static Tailwind classes throughout — no dynamic class construction.
- All classification labels, colors, and styles centralized in `classification.ts`.
- Proper loading/error/empty states with `SectionErrorBoundary` per section.
- `usePrefetchStablecoin` on hover for perceived performance.
- Keyboard navigation with `tabIndex`, `onKeyDown`, and `role` attributes on interactive table rows.

**Testing:**
- 213 tests passing, covering pure compute functions, helpers, classification, formatting, and API contract shapes.
- Contract tests cross-validate API handler output against the same Zod schemas the frontend uses.
- Edge cases well-covered in scoring tests: zero values, clamping, boundary conditions.

**Security:**
- Timing-safe admin auth using hash comparison.
- Input validation with `isValidStablecoinId()` on the most-exposed endpoints (gaps noted in F-005).
- No exposed secrets or hardcoded credentials.

---

## 4. Recommended Fix Order

### Batch 1 — Critical + High Reliability (fix immediately)

**IDs: F-001, F-002, F-003, F-007**

These are data correctness and reliability issues. F-001 displays wrong numbers when FTQ triggers. F-002/F-003 risk NaN reaching the database. F-007 risks connection pool exhaustion during error bursts. All are 1–3 line fixes.

### Batch 2 — High Data Accuracy + Security (fix this week)

**IDs: F-004, F-005, F-006**

F-004 (hardcoded 24h window) and F-006 (non-deterministic largest event) produce subtly wrong API data. F-005 (missing input validation) is a cache-pollution vector. All are small, focused changes.

### Batch 3 — DEWS Signal Consistency (fix this week)

**IDs: F-008, F-009, F-010**

The yield signal is invisible in the UI despite contributing to the DEWS score. The "7 sub-signals" text is factually wrong in 4 locations. These are quick text/config fixes that improve user trust.

### Batch 4 — Type Safety & API Contracts (fix within 2 weeks)

**IDs: F-016, F-017, F-018, F-019, F-031**

Consolidate duplicated types (`ThreatBand`, `CronRun`), add missing fields to `YieldRanking`, create Zod schemas for stress-signals. Strengthens the type boundary between worker and frontend.

### Batch 5 — UX Polish (fix within 2 weeks)

**IDs: F-013, F-015, F-020, F-027, F-028, F-029, F-030**

Duplicate heatmap filters, unrounded float display, empty table state, pluralization, accessibility labels, feature highlights. User-facing quality improvements.

### Batch 6 — Code Cleanup (fix at leisure)

**IDs: F-011, F-012, F-014, F-021, F-022, F-023, F-024, F-025, F-026, F-034**

Naming corrections (variance→stddev), dead code removal, DRY extraction, stale time fixes. These improve maintainability but have no user-visible impact.

### Batch 7 — Test Coverage Expansion (ongoing)

**IDs: F-032, F-033**

Add missing DEWS test scenarios and API contract tests for 4 endpoints. Reduces regression risk for future changes.

---

## 5. Open Questions — Resolved

1. **DEWS weights intentionality**: **Intentional.** The flow signal (0.1) was added as "extra" weight because mint/burn data isn't available for all coins. The >1.0 sum is by design — add a code comment explaining this. Downgrade F-010 to a comment-only fix.

2. **`variance30d` vs standard deviation**: **Harmonize to stddev.** Standard deviation is the more logical metric (same units as APY, more intuitive for volatility). Rename variable/type to `stdDev30d`/`apyStdDev30d`. DB column can stay as-is with a clarifying comment (no migration needed).

3. **`useYieldHistory` dead hook**: **Keep for now.** Planned for future detail page expansion. Add a comment. Remove F-022 from findings.

4. **Depeg Tracker feature highlight**: **Yes, add all three** — Depeg Tracker, Flows, and Yield to `feature-highlights.tsx`.

5. **Stress-signals health monitoring**: **Yes, add it.** Add DEWS freshness check to `/health` endpoint.
