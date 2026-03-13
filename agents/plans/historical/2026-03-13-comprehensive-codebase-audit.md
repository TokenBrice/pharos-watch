# Pharos Comprehensive Codebase Audit Report

**Date:** 2026-03-13
**Scope:** Full codebase — frontend (`src/`), shared (`shared/`), worker (`worker/`), scripts, configuration
**Methodology:** Three parallel specialized agents analyzed every file, then findings were cross-correlated and deduplicated

---

## 1. Executive Summary

### Finding Counts by Pillar and Severity

| Severity | Redundancy | Code Quality | Sustainability | Total |
|----------|-----------|-------------|----------------|-------|
| Critical | 0 | 0 | 0 | **0** |
| High | 0 | 0 | 0 | **0** |
| Medium | 2 | 5 | 4 | **11** |
| Low | 8 | 7 | 9 | **24** |
| Info/Positive | 5 | 6 | 6 | **17** |
| **Total** | **15** | **18** | **19** | **52** |

Actionable findings (excluding positive/info): **35**

### Overall Health Scores

| Pillar | Score (1-10) | Justification |
|--------|:---:|---|
| **Redundancy** | **8/10** | Very little duplication. The shared layer effectively prevents cross-boundary duplication. Remaining issues are small utility functions (`clamp`, formatters) and scattered inline formatting patterns. No dead files or unused modules found. |
| **Code Quality** | **8/10** | Zero `any` in production code, zero `@ts-ignore`, consistent parameterized SQL, robust circuit breaker/retry infrastructure. Main issues are structural — a few monolithic files (916-2215 lines) and the router parameter API needs cleanup. No security vulnerabilities found. |
| **Sustainability** | **9/10** | Exceptionally clean three-layer architecture with automated boundary enforcement. 48-file documentation suite. Robust 6-stage CI/CD pipeline. Lean dependency tree with all packages current. Production-grade cron orchestration. |

### Top 5 Most Critical Findings

1. **CC-001 -- Router/auth API surface** (Q-003 + Q-004 + S-002 + S-018): The `route()` function takes 13 positional parameters and `withAdmin` has a confusing overloaded signature with 3 auth patterns. This is the biggest friction point for adding new features.

2. **CC-002 -- Large monolithic orchestrators** (Q-001 + Q-011): `syncStablecoins` (916 lines) and `daily-digest` (1131 lines) concentrate too much logic in single functions. Reduces testability and readability.

3. **CC-003 -- Time/formatting utilities not fully centralized** (R-001 + R-002 + R-003 + R-004 + R-005 + S-004): Five duration formatters, triple `clamp()`, 15+ inline date formatters, and parallel time-constant systems between frontend and worker.

4. **CC-004 -- Test coverage gaps** (Q-007 + S-005): Frontend components are ~11% covered by file count. Seven API handlers lack dedicated tests, including `cache-handlers.ts` which serves 5 high-traffic endpoints.

5. **CC-005 -- External API response type safety** (Q-005 + Q-016 + S-020): DefiLlama responses use `[key: string]: unknown` index signatures instead of Zod validation, weakening TypeScript's protection at the most important system boundary.

### Technical Debt Profile

**~15% of the codebase is affected by significant findings.** The debt is concentrated in:
- Worker orchestrators (`sync-stablecoins.ts`, `daily-digest.ts`, `sync-blacklist.ts`) -- long functions with embedded data collection
- Router/auth layer (`router.ts`, `auth.ts`) -- parameter accumulation and overloaded signatures
- Scattered formatting patterns across 15+ frontend components

The debt is *manageable and well-contained* -- no systemic rot, no security holes, no broken abstractions.

---

## 2. Findings by Pillar

### Pillar A: Redundancy

#### R-001 -- Triple `clamp()` function definition
- **Category:** Code Duplication
- **Files:**
  - `shared/lib/mint-burn-signals.ts:40` -- `clamp(value, min, max)`
  - `src/lib/flow-intensity.ts:1` -- identical copy
  - `worker/src/lib/dews.ts:125` -- `clamp(min, max, val)` (swapped params, NaN guards)
- **Description:** Three independent implementations. Two are byte-for-byte identical; the third swaps parameter order and adds NaN/Infinity guards.
- **Consolidation Strategy:** Export `clamp()` from `shared/lib/math.ts` (new file) or `shared/lib/format.ts`. Keep the NaN-safe variant if needed.
- **Effort:** Small

#### R-002 -- Time constant duplication between frontend and worker
- **Category:** Code Duplication
- **Files:**
  - `src/lib/constants.ts:1-23` -- `HOUR_SECONDS`, `DAY_SECONDS`, `THIRTY_DAYS_SECONDS`, etc.
  - `worker/src/lib/time-constants.ts:1-15` -- `SECONDS.ONE_HOUR`, `SECONDS.ONE_DAY`, etc.
  - `worker/src/cron/sync-yield-data.ts:39` -- local `THIRTY_DAYS_SECONDS = 30 * 86400`
- **Description:** Identical durations defined in two naming conventions across three files.
- **Consolidation Strategy:** Create `shared/lib/time-constants.ts`. Both layers import from there. Frontend's `src/lib/constants.ts` retains page-specific constants (`TABLE_PAGE_SIZE`, `CATEGORY_LINKS`).
- **Effort:** Medium

#### R-003 -- Five overlapping duration/age formatters
- **Category:** Code Duplication
- **Files:**
  - `shared/lib/format.ts:110-127` -- `formatDuration(startSec, endSec)`
  - `shared/lib/format.ts:138-146` -- `timeAgo(epochSec)`
  - `src/lib/data-health.ts:155-162` -- `formatHealthAge(ms)`
  - `src/components/status/format.ts:8-15` -- `formatAge(seconds)`
  - `src/components/status/format.ts:3-6` -- `formatDuration(ms)` (sub-second latency, different domain)
- **Description:** The core "seconds to human-readable" logic is implemented four times with nearly identical threshold chains.
- **Consolidation Strategy:** Create `formatElapsedSeconds(seconds)` in `shared/lib/format.ts`. Have `formatHealthAge` call it with `ms / 1000`. Have `formatAge` import it. `timeAgo` remains as a wrapper adding "ago" and "just now". Status `formatDuration(ms)` stays separate (different domain).
- **Effort:** Small

#### R-004 -- Inline `toLocaleDateString` in 15+ components
- **Category:** Code Duplication
- **Files:** `src/components/digest-archive-client.tsx`, `src/components/daily-digest.tsx`, `src/components/usds-status-card.tsx`, `src/components/methodology-version-card.tsx`, `src/components/stablecoin-detail/safety-score-history-section.tsx`, `src/components/stablecoin-detail/overview-section.tsx`, `src/app/stability-index/client.tsx`, and 8+ more
- **Description:** `shared/lib/format.ts` provides `formatChartDate()` with four presets, yet many components create inline `new Date(...).toLocaleDateString("en-US", {...})` with the same 3-4 option combinations.
- **Consolidation Strategy:** Add 2-3 presets to `formatChartDate` (e.g., `"long-month-year"`, `"day-month-time"`). Systematically replace inline calls.
- **Effort:** Medium

#### R-005 -- Inline `${value.toFixed(2)}%` percentage formatting
- **Category:** Code Duplication
- **Files:** 15+ locations across yield, comparison, KPI, and stability-index components
- **Description:** No general `formatPercent(value)` exists. `formatApy()` handles APY specifically, `formatPercentChange()` requires two args.
- **Consolidation Strategy:** Add `formatPercent(value, decimals = 2)` and `formatSignedPercent(value, decimals = 2)` to `shared/lib/format.ts`.
- **Effort:** Small

#### R-006 -- `strict-contract-paths.ts` is a trivial 3-line re-export
- **Category:** Redundant Abstractions
- **Files:** `shared/lib/strict-contract-paths.ts` (3 lines)
- **Description:** Exists solely to pre-compute a list at module load time. Used by 3 files.
- **Consolidation Strategy:** Export the pre-computed list directly from `api-endpoints.ts` or inline into `src/lib/api.ts`.
- **Effort:** Small

#### R-007 -- `fetchStablecoinReserves` bypasses standard `apiFetch`
- **Category:** Redundant Abstractions
- **Files:** `src/lib/api.ts:212-227`
- **Description:** Manually reimplements what `apiFetch()` does (fetch, check `.ok`, parse JSON, throw `ApiFetchError`). Only difference: 404-returns-null behavior.
- **Consolidation Strategy:** Add `nullOn404?: boolean` option to `apiFetch`. Reduces ~16 lines to ~3.
- **Effort:** Small

#### R-008 -- `encodeStablecoinUrlToken` is an identity function
- **Category:** Redundant Abstractions
- **Files:** `src/lib/stablecoin-url-codec.ts:20-22`
- **Description:** Returns `canonicalId` unchanged. Exists as a future abstraction point for the ticker-issuer ID migration.
- **Consolidation Strategy:** Leave in place -- intentional future-proofing per active migration plan.
- **Effort:** N/A (deferred)

#### R-009 -- Worker cron-schedule re-derives type already in shared
- **Category:** Redundant Abstractions
- **Files:**
  - `worker/src/lib/cron-schedule.ts:4` -- `CronScheduleExpression`
  - `shared/lib/cron-jobs.ts:24` -- same type
- **Description:** Worker file re-derives the same type. Only adds `CRON_INTERVALS` map.
- **Consolidation Strategy:** Move `CRON_INTERVALS` to `shared/lib/cron-jobs.ts`. Eliminate worker duplicate.
- **Effort:** Small

#### R-010 -- Nullable-value comparison boilerplate in table-logic comparators
- **Category:** Overlapping Responsibilities
- **Files:** `src/components/stablecoin-table-logic.ts:132-157`, `src/components/flow-table-logic.ts:100-103`, `src/components/depeg-table-logic.ts` (similar)
- **Description:** The null-guard pattern (`if (a === null && b === null) return 0; if (a === null) return 1; if (b === null) return -1;`) repeats in 5+ comparator switch cases.
- **Consolidation Strategy:** Extract `compareNullable(a, b)` utility that handles nulls, returning the definitive order or `null` to signal both values are non-null.
- **Effort:** Small

#### R-011 -- `PRESSURE_VALUE_CLASS` duplicates values from `FLOW_PRESSURE_BASE`
- **Category:** Overlapping Responsibilities
- **Files:**
  - `src/components/flow-table-logic.ts:23-28`
  - `src/lib/flow-signal-ui.ts:100-129`
- **Description:** Identical Tailwind text color classes for each `PressureShiftState` defined in both places.
- **Consolidation Strategy:** Derive `PRESSURE_VALUE_CLASS` from `flow-signal-ui` map.
- **Effort:** Small

---

### Pillar B: Code Quality

#### Q-001 -- `syncStablecoins` is a 916-line monolith
- **Severity:** Medium
- **Category:** Complexity / SRP
- **Location:** `worker/src/cron/sync-stablecoins.ts`, main function lines 393-916
- **Description:** Performs fetch, validation, price enrichment, price rejection, cache writes, depeg detection, and metadata assembly in a single linear flow. ~20+ branches. The `fallbackToCgSupply` path duplicates ~60% of the main path's price enrichment logic.
- **Remediation:** Break into 3-4 orchestration stages (fetch+validate, enrich+validate, persist, depeg pipeline). Extract shared price enrichment logic between main and CG-fallback paths.

#### Q-002 -- `methodology-sections.tsx` is 2215 lines of static JSX
- **Severity:** Low
- **Category:** Readability
- **Location:** `src/app/methodology/methodology-sections.tsx`
- **Description:** All methodology section bodies in one file. The stress-test pipeline diagram renders twice (mobile/desktop variants with identical content).
- **Remediation:** Split into per-section components in a `methodology-sections/` directory. Extract duplicated pipeline diagram into a responsive component.

#### Q-003 -- `withAdmin` has a confusing overloaded signature
- **Severity:** Medium
- **Category:** Readability / API Design
- **Location:** `worker/src/lib/auth.ts:55-83`
- **Description:** Second parameter can be string, boolean, or function. Third can be function or boolean. Internal resolution uses three levels of `typeof` checks. The legacy string-key parameter appears no longer needed.
- **Remediation:** Simplify to `withAdmin(request, handler, trustedAdmin?)`. Remove legacy overloads.

#### Q-004 -- `route()` function has 13 positional parameters
- **Severity:** Medium
- **Category:** Long Parameter List
- **Location:** `worker/src/router.ts:52-67`
- **Description:** The `RouteContext` interface already exists in `route-registry.ts` but `route()` doesn't use it.
- **Remediation:** Refactor to accept a single `RouteContext` object. Mechanical change, no behavioral impact.

#### Q-005 -- `PeggedAsset` has `[key: string]: unknown` index signature
- **Severity:** Medium
- **Category:** Type Safety
- **Location:** `worker/src/cron/enrich-prices.ts:42`
- **Description:** Disables TypeScript's excess property checking. Typos in property names won't be caught at compile time.
- **Remediation:** Use a separate `RawLlamaAsset` type for the untyped API response, then map to a strict `PeggedAsset` during parsing.

#### Q-006 -- Semantic overloading of `last_block` column
- **Severity:** Low
- **Category:** Naming / Data Integrity
- **Location:** `worker/src/cron/sync-blacklist.ts:591-596`
- **Description:** `blacklist_sync_state.last_block` stores block numbers for EVM chains but millisecond timestamps for Tron. Documented only in a comment.
- **Remediation:** Rename to `last_cursor` or add a `cursor_type` discriminator column.

#### Q-007 -- API handlers missing test coverage
- **Severity:** Medium
- **Category:** Testing Gaps
- **Location:** Seven files:
  - `worker/src/api/cache-handlers.ts` (serves 5 cache-passthrough endpoints)
  - `worker/src/api/status-data-quality.ts`
  - `worker/src/lib/status-derived-data.ts`
  - `worker/src/api/reclassify-atomic-roundtrips.ts`
  - `worker/src/api/stablecoin-detail/commodity.ts`
  - `worker/src/api/stablecoin-detail/coingecko-only.ts`
  - `worker/src/api/stablecoin-detail/defillama.ts`
- **Remediation:** Prioritize `cache-handlers.ts` (high-traffic) and `status-derived-data.ts` (complex aggregations).

#### Q-008 -- SQL column/table interpolation in `status-derived-data.ts`
- **Severity:** Low
- **Category:** Security Surface
- **Location:** `worker/src/api/status-derived-data.ts:248-251`
- **Description:** `target.column` and `target.table` interpolated into SQL strings. Values come from hardcoded `DATASET_FRESHNESS_TARGETS` constant (not user input), but the pattern is fragile.
- **Remediation:** Add allowlist validation matching the pattern in `api-utils.ts`.

#### Q-009 -- `enrichRowBalances` has 8 parameters
- **Severity:** Low
- **Category:** Long Parameter List
- **Location:** `worker/src/cron/sync-blacklist.ts:683-692`
- **Description:** Multiple functions in this file have 7-9 parameters sharing common context (budget, deadline, rate limiter, API keys, signal).
- **Remediation:** Introduce a `BlacklistSyncContext` object.

#### Q-010 -- `contagion-graph.tsx` combines rendering + physics + data transformation
- **Severity:** Low
- **Category:** SRP Violation
- **Location:** `src/components/contagion-graph.tsx` (1279 lines)
- **Description:** d3-force simulation, SVG rendering, interaction handlers, and data transformation all in one component.
- **Remediation:** Extract simulation/layout logic into a pure `buildContagionLayout()` function.

#### Q-011 -- `daily-digest.ts` 1131-line orchestrator
- **Severity:** Medium
- **Category:** Complexity / SRP
- **Location:** `worker/src/cron/daily-digest.ts`, main function lines 300-1131
- **Description:** ~830-line function with 10+ try/catch blocks for individual data collection phases, each 30-80 lines of query + transformation.
- **Remediation:** Extract each enrichment phase into a named function (e.g., `collectBlacklistActivity()`, `collectDewsStress()`). The orchestrator becomes a clean sequential pipeline.

#### Q-016 -- Missing Zod validation on DefiLlama detail response
- **Severity:** Low
- **Category:** Type Safety / Data Integrity
- **Location:** `worker/src/api/stablecoin-detail/defillama.ts:55`
- **Description:** Response cast rather than validated. The list endpoint uses Zod, but the detail endpoint doesn't.
- **Remediation:** Add a Zod schema consistent with the list endpoint's validation.

#### Q-017 -- `coin()` factory produces 275-character single-line return
- **Severity:** Low
- **Category:** Readability
- **Location:** `shared/lib/stablecoins.ts:37`
- **Description:** Single-line object literal mapping 25+ fields. Hard to read in diffs.
- **Remediation:** Reformat to multi-line return statement.

#### Q-018 -- Frontend hooks surface generic error messages
- **Severity:** Low
- **Category:** Error Handling
- **Location:** `src/hooks/use-api-query.ts`, `src/hooks/api-hooks.ts`
- **Description:** Errors show as generic "Failed to fetch" rather than actionable messages. Freshness-aware hooks provide stale-data metadata but most consumers only check `isLoading`/`isError`.
- **Remediation:** Consider a `useApiQueryWithFallback` variant that returns last successful data with a staleness indicator when fetches fail.

#### Q-019 -- `enrichRowBalances` silently continues on failure without counters
- **Severity:** Low
- **Category:** Error Handling
- **Location:** `worker/src/cron/sync-blacklist.ts:683-722`
- **Description:** Catches balance fetch failures with `console.warn` but has no counter for how many enrichments failed. Compare with `syncMintBurn` which tracks `rowsDropped`, `errors`, `failedEventDefs`.
- **Remediation:** Add attempted/succeeded/failed counters to cron metadata.

---

### Pillar C: Sustainability & Maintainability

#### S-001 -- Global mutable state in worker modules (init pattern)
- **Impact:** Medium
- **Category:** Architectural Coherence / Scalability
- **Location:** `worker/src/lib/alerts.ts:7`, `worker/src/lib/coingecko.ts:10`, `worker/src/lib/chain-registry.ts:132`, `worker/src/lib/coingecko-onchain.ts:16`, `worker/src/lib/rate-limit.ts:20-25`
- **Description:** Five modules use module-level `let` variables initialized via `initX()` calls. Every entrypoint must remember to call all init functions. The in-memory rate limiter fallback (`ipCounts` Map) counts per-isolate, not globally -- documented only in a catch block.
- **Remediation:** Consider a context object pattern where env-derived config is passed explicitly. Document rate-limit fallback behavior at module level.

#### S-002 -- Router parameter accumulation (13 params)
- **Impact:** Medium
- **Category:** Modularity & Coupling
- **Location:** `worker/src/router.ts:52-66`
- **Description:** Each new feature that needs env access adds another parameter. `RouteContext` in `route-registry.ts` already consolidates these but `router.ts` doesn't use it.
- **Remediation:** Refactor `route()` to accept `RouteContext`. Mechanical refactor.

#### S-003 -- Stablecoin metadata god module (4,600 lines, 72 importers)
- **Impact:** Medium
- **Category:** Modularity & Coupling
- **Location:** `shared/lib/stablecoins.ts`
- **Description:** All 156+ entries in one file. Approaching merge-conflict threshold for parallel worktree work. The `coin()` factory is a single-line constructor.
- **Remediation:** At current scale (156 coins), tolerable. Past ~200, split by category (`stablecoins-usd-cefi.ts`, `stablecoins-eur.ts`, etc.). Immediately: reformat `coin()` to multi-line.

#### S-004 -- Duplicate time constants across layers
- **Impact:** Low
- **Category:** Configuration Management
- **Location:** `src/lib/constants.ts`, `worker/src/lib/time-constants.ts`, `worker/src/cron/sync-yield-data.ts:39`
- **Description:** Three definitions of "30 days in seconds" exist.
- **Remediation:** Move to `shared/lib/time-constants.ts`.

#### S-005 -- Frontend component test coverage gap
- **Impact:** Medium
- **Category:** Build & Deployment Pipeline
- **Location:** `src/components/` (144 components, 16 test files -- ~11%)
- **Description:** Worker side is comprehensively tested; frontend derivation logic is not. The critical-coverage gate focuses on API contracts and worker invariants.
- **Remediation:** Prioritize testing the pure derivation files: `stablecoin-table-logic.ts`, `flow-table-logic.ts`, `depeg-table-logic.ts`, `yield-table-logic.ts`, `stablecoin-detail-derive.ts`.

#### S-011 -- API handler pattern consistency is mixed
- **Impact:** Low
- **Category:** Architectural Coherence
- **Location:** `worker/src/api/`
- **Description:** Three handler patterns: (1) `createCacheHandler`, (2) `withErrorHandler`-wrapped, (3) raw functions. Pattern (3) lacks automatic error handling.
- **Remediation:** Wrap remaining raw handlers with `withErrorHandler` for consistent structured logging.

#### S-014 -- Hardcoded fallback values in constants
- **Impact:** Low
- **Category:** Configuration Management
- **Location:** `worker/src/lib/constants.ts:50,105-106`
- **Description:** `RUB_FALLBACK = 0.011` and `RISK_FREE_RATE_FALLBACK = 4.25` will go stale if fallback paths trigger for extended periods.
- **Remediation:** Add a staleness warning when fallback values are used for >48 hours.

#### S-015 -- In-memory rate limiter as silent fallback
- **Impact:** Low
- **Category:** Scalability Bottlenecks
- **Location:** `worker/src/lib/rate-limit.ts:20-63,102-145`
- **Description:** D1-backed rate limiting falls back to per-isolate in-memory `Map`. Under multiple isolates, effective limit is `N * limit`.
- **Remediation:** At current traffic levels, fine. If traffic grows, the fallback should trigger a circuit-breaker alert.

#### S-018 -- `withAdmin` auth has two variants
- **Impact:** Low
- **Category:** Architectural Coherence
- **Location:** `worker/src/route-registry.ts`
- **Description:** `withAdmin(request, key, handler)` vs `requireAdmin(request, key)` early-return vs direct `adminKey` injection -- three auth paths that must stay consistent.
- **Remediation:** Consolidate to `withAdmin` wrapper pattern for new endpoints.

#### S-019 -- Cron schedule / wrangler.toml sync is manual
- **Impact:** Low
- **Category:** Build & Deployment Pipeline
- **Location:** `worker/wrangler.toml:33-44`, `shared/lib/cron-jobs.ts:10-21`
- **Description:** 10 cron expressions must match `CRON_SCHEDULES`. A mismatch would silently no-op.
- **Remediation:** Add a CI check that verifies 1:1 correspondence.

#### S-020 -- No Zod validation on most API response outputs
- **Impact:** Low
- **Category:** Scalability Bottlenecks
- **Location:** `worker/src/api/` handlers
- **Description:** Most handlers construct JSON directly from D1 results without schema validation. Frontend strict contracts catch mismatches at the integration level but not at the API handler level.
- **Remediation:** Add output schema validation for critical public endpoints (stablecoins, peg-summary, report-cards, stability-index).

---

### Positive Findings (What's Working Well)

These patterns should be preserved and extended:

| ID | Finding |
|----|---------|
| R-012 | **Zero dead files/modules** -- every file has active consumers |
| R-014 | **CSS utility stack is correct** -- `clsx` + `tailwind-merge` + `cva` serve distinct purposes |
| R-015 | **No overlapping chart libraries** -- Recharts for charts, d3-force for graph layout only |
| Q-012-15 | **Exceptional type safety** -- zero `as any` in production, zero `@ts-ignore`, `as unknown as` confined to test mocks |
| Q-014 | **`dangerouslySetInnerHTML` properly sanitized** via `safeJsonLd()` |
| Q-020 | **Circuit breaker and fetch-retry well-implemented** -- D1-persisted state, alert integration, abort signal composition |
| Q-021 | **SQL consistently parameterized** -- no injection vectors found |
| Q-022 | **160+ test files** with behavior-based assertions |
| S-006-07 | **Dependency tree lean and current** -- 16 runtime deps (frontend), 2 (worker) |
| S-008 | **Three-layer boundary enforcement** via CI script + tsconfig exclusions |
| S-009 | **Cron orchestration is production-grade** -- D1 leases, heartbeat renewal, sequential slot execution, abort signals |
| S-010 | **48-file documentation suite** -- comprehensive and well-organized |
| S-012 | **6-stage CI/CD pipeline** -- lint -> type-check -> test -> deploy -> smoke -> ops-smoke |

---

## 3. Cross-Cutting Concerns

These findings span multiple pillars and should be addressed as compound issues:

### CC-001 -- Router/Auth API Surface (Q-003 + Q-004 + S-002 + S-018)
**Pillars:** Code Quality + Sustainability
**Description:** The worker's routing and auth layer has accumulated friction from organic growth:
- `route()` takes 13 positional parameters (Q-004/S-002)
- `withAdmin` has a confusing 3-way overloaded signature (Q-003)
- Three distinct auth patterns coexist (S-018)

The `RouteContext` interface already exists and defines the correct shape -- the code just doesn't use it yet.
**Remediation:** Single refactoring PR: (1) refactor `route()` to accept `RouteContext`, (2) simplify `withAdmin` to a clean 3-param signature, (3) standardize on the `withAdmin` wrapper pattern for all admin endpoints.
**Effort:** Medium

### CC-002 -- Monolithic Orchestrator Functions (Q-001 + Q-011 + Q-010 + S-003)
**Pillars:** Code Quality + Sustainability
**Description:** Four files exceed 900 lines with SRP violations:
- `syncStablecoins` main function: 520 lines, 20+ branches (Q-001)
- `generateDailyDigest`: 830 lines, 10+ try/catch phases (Q-011)
- `contagion-graph.tsx`: 1279 lines mixing rendering + physics + data (Q-010)
- `stablecoins.ts`: 4600 lines of metadata (S-003, lower urgency)

All four are comprehensible (good comments, logical flow) but resist testability and parallel development.
**Remediation:** Extract stage functions from orchestrators. For `syncStablecoins`: fetch+validate, enrich, persist, depeg pipeline. For `daily-digest`: named collector functions per enrichment phase. For `contagion-graph`: pure layout function separate from React rendering.
**Effort:** Large (but can be done incrementally per file)

### CC-003 -- Formatting & Utility Centralization Gap (R-001 + R-002 + R-003 + R-004 + R-005 + S-004)
**Pillars:** Redundancy + Sustainability
**Description:** The shared formatting layer (`shared/lib/format.ts`) is good but incomplete:
- `clamp()` defined 3 times (R-001)
- Time constants duplicated across layers (R-002/S-004)
- Duration formatters duplicated 4 times (R-003)
- Inline date formatting in 15+ components (R-004)
- Inline percentage formatting in 15+ locations (R-005)

**Remediation:** Three focused PRs: (1) move time constants + `clamp` to shared, (2) consolidate duration formatters, (3) add date/percent presets and sweep inline usages.
**Effort:** Medium (many files touched but mechanical changes)

### CC-004 -- Test Coverage Gaps (Q-007 + S-005)
**Pillars:** Code Quality + Sustainability
**Description:** Two complementary gaps:
- 7 API handlers without tests, including `cache-handlers.ts` (Q-007)
- Frontend derivation logic in `*-table-logic.ts` files untested (S-005)

Both gaps are in pure logic files that are highly testable without complex mocking.
**Remediation:** Add test files for (1) cache-handlers composition logic, (2) status-derived-data aggregations, (3) the 6 `*-table-logic.ts` files. All are unit-testable without DOM rendering.
**Effort:** Medium

### CC-005 -- External API Response Type Safety (Q-005 + Q-016 + S-020)
**Pillars:** Code Quality + Sustainability
**Description:** External API responses (DefiLlama detail, price enrichment) use `[key: string]: unknown` index signatures instead of Zod validation. The list endpoint validates with Zod, but the detail endpoint doesn't. Most API handler outputs lack schema validation.
**Remediation:** (1) Add Zod schemas for DL detail responses, (2) remove index signatures from `PeggedAsset`, (3) add output validation for top-5 public endpoints.
**Effort:** Medium

---

## 4. Prioritized Remediation Roadmap

### Phase 1 -- Quick Wins (Small effort, high impact, independent)

| Ref | Action | Files | Effort | Dependencies |
|-----|--------|-------|--------|-------------|
| R-001 | Extract shared `clamp()` into `shared/lib/math.ts` | 3 files | Small | None |
| R-005 | Add `formatPercent()` / `formatSignedPercent()` to `shared/lib/format.ts` | 1 file + 15 consumers | Small | None |
| R-007 | Add `nullOn404` option to `apiFetch`, replace `fetchStablecoinReserves` inline impl | `src/lib/api.ts` | Small | None |
| R-009 | Move `CRON_INTERVALS` to `shared/lib/cron-jobs.ts`, delete worker duplicate | 2 files | Small | None |
| R-011 | Derive `PRESSURE_VALUE_CLASS` from `flow-signal-ui.ts` map | 2 files | Small | None |
| Q-017 | Reformat `coin()` factory to multi-line return | `shared/lib/stablecoins.ts` | Small | None |
| R-010 | Extract `compareNullable()` helper for table sort comparators | 4 files | Small | None |
| R-006 | Simplify `strict-contract-paths.ts` | 1 file + 3 consumers | Small | None |

**Estimated total:** 8 independent tasks, all Small

### Phase 2 -- Targeted Refactoring (Medium effort, focused improvements)

| Ref | Action | Files | Effort | Dependencies |
|-----|--------|-------|--------|-------------|
| CC-001 | Refactor `route()` to accept `RouteContext` + simplify `withAdmin` + standardize auth pattern | `router.ts`, `auth.ts`, `route-registry.ts`, handler call sites | Medium | None |
| R-002/S-004 | Unify time constants into `shared/lib/time-constants.ts` | 3 source files + ~20 consumers | Medium | None |
| R-003 | Consolidate duration/age formatters into single `formatElapsedSeconds()` | 4 source files + consumers | Small | None |
| R-004 | Add date format presets, sweep inline `toLocaleDateString` calls | `shared/lib/format.ts` + 15 components | Medium | None |
| CC-004 | Add tests for `cache-handlers.ts`, `status-derived-data.ts`, and 6 `*-table-logic.ts` files | 8 new test files | Medium | None |
| Q-008 | Add allowlist validation for SQL column/table interpolation | `worker/src/api/status-derived-data.ts` | Small | None |
| S-019 | Add CI check for wrangler.toml / CRON_SCHEDULES parity | New script | Small | None |
| Q-019 | Add enrichment success/failure counters to blacklist sync metadata | `sync-blacklist.ts` | Small | None |

### Phase 3 -- Structural Improvements (Higher effort, architectural)

| Ref | Action | Files | Effort | Dependencies |
|-----|--------|-------|--------|-------------|
| Q-001 | Break `syncStablecoins` into 3-4 orchestration stages | `sync-stablecoins.ts` + `stages.ts` | Large | None |
| Q-011 | Extract daily-digest data collection into named collector functions | `daily-digest.ts` | Medium | None |
| CC-005 | Add Zod schemas for DL detail response + remove `PeggedAsset` index signature | `enrich-prices.ts`, `defillama.ts` | Medium | None |
| S-001 | Refactor worker init pattern to explicit context passing | 5 lib files + 2 handler entrypoints | Medium | CC-001 |
| S-011 | Wrap remaining raw API handlers with `withErrorHandler` | ~10 handler files | Small | None |
| Q-010 | Extract `buildContagionLayout()` from `contagion-graph.tsx` | 1 file -> 2 files | Medium | None |

### Phase 4 -- Strategic (When scale demands it)

| Ref | Action | Files | Effort | Trigger |
|-----|--------|-------|--------|---------|
| S-003 | Split `stablecoins.ts` by category | 1 -> 5-8 files | Large | >200 coins |
| Q-002 | Split `methodology-sections.tsx` into per-section components | 1 -> 8-10 files | Medium | When methodology changes become frequent |
| S-020 | Add Zod output validation to public API handlers | ~10 handler files | Large | When data-quality incidents increase |
| Q-006 | Rename `last_block` to `last_cursor` + migration | DB migration + sync-blacklist.ts | Medium | Next blacklist schema change |
| S-015 | Add circuit-breaker alert on rate-limit D1 fallback | `rate-limit.ts` | Small | When traffic scale increases |

---

## 5. Appendices

### Appendix A -- File-by-File Finding Index

| File | Findings |
|------|----------|
| `shared/lib/format.ts` | R-003, R-004, R-005 |
| `shared/lib/mint-burn-signals.ts` | R-001 |
| `shared/lib/stablecoins.ts` | S-003, Q-017 |
| `shared/lib/strict-contract-paths.ts` | R-006 |
| `shared/lib/cron-jobs.ts` | R-009, S-019 |
| `src/lib/api.ts` | R-007 |
| `src/lib/constants.ts` | R-002, S-004 |
| `src/lib/data-health.ts` | R-003 |
| `src/lib/flow-intensity.ts` | R-001 |
| `src/lib/flow-signal-ui.ts` | R-011 |
| `src/components/status/format.ts` | R-003 |
| `src/components/stablecoin-table-logic.ts` | R-010 |
| `src/components/flow-table-logic.ts` | R-010, R-011 |
| `src/components/depeg-table-logic.ts` | R-010 |
| `src/components/contagion-graph.tsx` | Q-010 |
| `src/app/methodology/methodology-sections.tsx` | Q-002 |
| `src/hooks/use-api-query.ts` | Q-018 |
| `worker/src/router.ts` | Q-004, S-002 |
| `worker/src/lib/auth.ts` | Q-003 |
| `worker/src/lib/alerts.ts` | S-001 |
| `worker/src/lib/coingecko.ts` | S-001 |
| `worker/src/lib/chain-registry.ts` | S-001 |
| `worker/src/lib/coingecko-onchain.ts` | S-001 |
| `worker/src/lib/rate-limit.ts` | S-001, S-015 |
| `worker/src/lib/constants.ts` | S-014 |
| `worker/src/lib/time-constants.ts` | R-002 |
| `worker/src/lib/cron-schedule.ts` | R-009 |
| `worker/src/lib/dews.ts` | R-001 |
| `worker/src/api/cache-handlers.ts` | Q-007 |
| `worker/src/api/status-derived-data.ts` | Q-007, Q-008 |
| `worker/src/api/stablecoin-detail/defillama.ts` | Q-016 |
| `worker/src/api/stablecoin-detail/commodity.ts` | Q-007 |
| `worker/src/api/stablecoin-detail/coingecko-only.ts` | Q-007 |
| `worker/src/cron/sync-stablecoins.ts` | Q-001 |
| `worker/src/cron/daily-digest.ts` | Q-011 |
| `worker/src/cron/enrich-prices.ts` | Q-005 |
| `worker/src/cron/sync-blacklist.ts` | Q-006, Q-009, Q-019 |
| `worker/src/cron/sync-yield-data.ts` | R-002 |
| `worker/src/route-registry.ts` | S-018 |
| 15+ frontend components | R-004, R-005 |

### Appendix B -- Dependency Audit Summary

| Package | Version | Status | Notes |
|---------|---------|--------|-------|
| next | 16.1.6 | Current | Latest Next.js 16 |
| react / react-dom | 19.2.4 | Current | React 19 |
| typescript | ^5 | Current | TS 5.x |
| tailwindcss | ^4.2.1 | Current | Tailwind v4 |
| zod | ^4.3.6 | Current | Zod 4 |
| @tanstack/react-query | ^5.90.21 | Current | |
| recharts | ^3.8.0 | Current | |
| vitest | ^4.1.0 | Current | |
| eslint | ^9.39.4 | Current | ESLint flat config |
| wrangler | ^4.72.0 | Current | |
| @cloudflare/workers-types | ^4.20260312.1 | Current | March 2026 |
| satori | ^0.25.0 | Current | OG image generation |
| @cf-wasm/resvg | ^0.3.3 | Current | SVG -> PNG in Workers |
| clsx + tailwind-merge + cva | Current | Justified | Standard shadcn/ui CSS stack |
| d3-force | ^3.0.0 | Current | Dependency graph layout only |
| lucide-react | ^0.563.0 | Current | Icon library |

No vulnerable, abandoned, or redundant dependencies found.

### Appendix C -- Glossary

| Term | Definition |
|------|-----------|
| **SRP** | Single Responsibility Principle -- a module should have one reason to change |
| **Circuit breaker** | Resilience pattern that stops calling a failing service after N consecutive failures, then probes periodically |
| **D1** | Cloudflare's serverless SQLite database |
| **Index signature** | TypeScript's `[key: string]: T` allowing arbitrary properties, weakening type checking |
| **Barrel export** | A file that re-exports from multiple modules (e.g., `index.ts` re-exporting everything) |
| **Isolate** | A Cloudflare Worker instance; module-level state persists within an isolate but not across |
| **PSI** | Pharos Stability Index -- composite ecosystem health score |
| **DEWS** | Depeg Early Warning System -- 8 sub-signal stress detection |
| **God module** | Anti-pattern: a single module that concentrates too much knowledge or responsibility |
| **CG** | CoinGecko |
| **DL** | DefiLlama |
