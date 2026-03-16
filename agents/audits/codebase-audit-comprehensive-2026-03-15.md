# Comprehensive Codebase Audit — Pharos (stablecoin-dashboard)

**Date**: 2026-03-15
**Scope**: Full codebase (~160K lines TypeScript/TSX, 600+ source files)
**Methodology**: Three parallel specialized agents analyzed every directory and cross-referenced findings

---

## 1. Executive Summary

### Overall Codebase Health

| Pillar | Rating (1–10) | Justification |
|--------|:---:|---|
| **Redundancy** | **8.5** | Strong centralization patterns (shared format lib, API hook factories, methodology version factory, adapter registries). Only 3 medium-severity duplications found across 160K lines. |
| **Code Quality** | **8.0** | Zero SQL injection, near-zero `any` usage, circuit breakers on all external calls, timing-safe auth. Two high-severity gaps (auth fallback, missing core tests). |
| **Sustainability** | **9.0** | Exemplary documentation (53 docs files), clean layer boundaries verified by CI, mature deployment pipeline, lean dependencies. No high-impact findings. |

### Total Findings

| Severity | Redundancy | Quality | Sustainability | Total |
|----------|:---:|:---:|:---:|:---:|
| **Critical** | 0 | 0 | 0 | **0** |
| **High** | 0 | 2 | 0 | **2** |
| **Medium** | 3 | 9 | 5 | **17** |
| **Low** | 11 | 4 | 6 | **21** |
| **Positive** | — | 7 noted | 12 noted | **19 noted** |
| **Total issues** | **14** | **15** | **11** | **40** |

### Top 5 Most Critical Findings

1. **[Q01] Auth fallback accepts spoofable headers** — When `CF_ACCESS_OPS_API_AUD` is unconfigured, admin endpoints accept any request with a `Cf-Access-Authenticated-User-Email` header. Grants access to backfill, sync, and debug endpoints.

2. **[Q03] Core scoring engine has no unit tests** — `report-cards.ts` (829 lines), `peg-score.ts` (181 lines), and `redemption-backstop-scoring.ts` (268 lines) lack dedicated tests. Scoring changes could silently alter grades for all 157+ stablecoins.

3. **[R03] PYS formula duplicated between frontend and worker** — The Pharos Yield Score formula constants and computation exist in both `src/lib/yield-constants.ts` and `worker/src/cron/yield-helpers.ts`. A formula change in one won't propagate to the other.

4. **[S03] Safety scripts not in CI pipeline** — `check:cron-sync`, `check:doc-counts`, and `check:duplicate-exports` only run locally. A PR could deploy a cron schedule mismatch or stale doc counts.

5. **[R13] Parallel type definitions for DEX liquidity** — `worker/src/cron/dex-liquidity/types.ts` and `shared/types/market.ts` define the same domain types independently. Shape drift between cron output and API contract is possible.

### Technical Debt Profile

Approximately **3–4% of the codebase** is affected by significant findings (medium severity or above). The vast majority of code follows consistent patterns, uses proper abstractions, and respects architectural boundaries. This is a well-maintained codebase with localized improvement opportunities, not systemic debt.

---

## 2. Findings by Pillar

### Pillar A — Redundancy

#### Medium Severity

##### [R03] Frontend `computePysBreakdown` duplicates worker PYS formula
- **Type**: Code Duplication
- **Files**:
  - `src/lib/yield-constants.ts:28-38`
  - `worker/src/cron/yield-helpers.ts:51-57` (canonical)
- **Description**: The frontend reimplements PYS formula constants (`riskPenaltyFloor=0.5`, `sustainabilityFloor=0.3`) and computation logic independently. If the canonical formula changes, the frontend breakdown display will diverge silently.
- **Consolidation Strategy**: Extract PYS formula constants and the breakdown computation into `shared/lib/` so both worker and frontend import from the same source.

##### [R12] Seven files define `const DAY = 86400` instead of importing `DAY_SECONDS`
- **Type**: Code Duplication
- **Files**:
  - `worker/src/api/backfill-depegs.ts:266`
  - `worker/src/api/backfill-stability-index.ts:29`
  - `worker/src/api/backfill-dews.ts:71`
  - `worker/src/api/mint-burn-flows-shared.ts:45`
  - `worker/src/api/audit-depeg-history.ts:18`
  - `worker/src/lib/psi-recompute.ts:3`
  - `src/lib/__tests__/peg-scoring.test.ts:29`
  - Canonical: `shared/lib/time-constants.ts` (`DAY_SECONDS`)
- **Description**: The shared `DAY_SECONDS` constant exists and is used widely, but 7 files define local `const DAY = 86400` variants. Signals awareness drift about the canonical constant.
- **Consolidation Strategy**: Replace all local definitions with `import { DAY_SECONDS } from "@shared/lib/time-constants"`.

##### [R13] Parallel type definitions for DEX liquidity
- **Type**: Overlapping Responsibilities
- **Files**:
  - `worker/src/cron/dex-liquidity/types.ts:71-90+`
  - `shared/types/market.ts:116-147`
- **Description**: `LiquidityPoolSourceFamily`, `LiquiditySourceMixEntry`, `LiquiditySourceMix`, `LiquidityCoverageClass`, and `PoolEntry` are defined in both files. The shared versions are Zod-schema-backed; the worker versions are plain TypeScript interfaces. The cron modules import exclusively from their local `types.ts`.
- **Consolidation Strategy**: Make the shared Zod schemas the single source of truth. Have the cron module import from `@shared/types` and extend with cron-specific fields where needed.

#### Low Severity

##### [R01] `compareNullable` in `sort-utils.ts` is dead code
- **Type**: Dead Code
- **Files**: `src/lib/sort-utils.ts:1-5`, `src/lib/__tests__/sort-utils.test.ts`
- **Description**: Exported but only imported in its own test file. Superseded by `createTableComparator`.
- **Consolidation Strategy**: Delete `src/lib/sort-utils.ts` and its test file.

##### [R02] `clampConfidence` duplicates shared `clamp(value, 0.1, 1)`
- **Type**: Code Duplication
- **Files**: `worker/src/lib/status-reliability.ts:75-78`, `shared/lib/math.ts` (`clamp()`)
- **Description**: Reimplements NaN-guarded clamping already in `shared/lib/math.ts:clamp`.
- **Consolidation Strategy**: Replace with `clamp(confidence, 0.1, 1)` from `@shared/lib/math`.

##### [R04] `audit-depeg-history.ts` bypasses `jsonResponse`/`errorResponse` helpers
- **Type**: Abstraction Bypass
- **Files**: `worker/src/api/audit-depeg-history.ts:62-65, 94-96, 100-104, 120-124, 305`
- **Description**: Five `new Response(JSON.stringify(...))` calls instead of using centralized helpers. Misses standard security headers.
- **Consolidation Strategy**: Replace with `jsonResponse()`/`errorResponse()` from `api-utils.ts`.

##### [R05] `DepegEvent` naming collision
- **Type**: Overlapping Responsibilities
- **Files**: `shared/types/market.ts:259-273` (full shape, 12 fields), `worker/src/lib/telegram-alerts.ts:180-187` (slim shape, 6 fields)
- **Description**: Two interfaces named `DepegEvent` with different shapes. Import confusion risk.
- **Consolidation Strategy**: Rename the telegram version to `DepegAlertPayload`.

##### [R06] Dead exports: `PRICING_PIPELINE_VERSION` and `getPricingPipelineVersionAt`
- **Type**: Dead Code
- **Files**: `shared/lib/pricing-pipeline-version.ts:46, 58`
- **Description**: Exported but never imported. Only the label and changelog are consumed.
- **Consolidation Strategy**: Remove or unexport.

##### [R07] Dead export: `getRedemptionBackstopVersionAt`
- **Type**: Dead Code
- **Files**: `shared/lib/redemption-backstop-version.ts:35`
- **Description**: Exported but never imported by any module.
- **Consolidation Strategy**: Remove or add consumer when methodology versioning is needed.

##### [R08] `getPrevMonthRaw` is test-only dead code
- **Type**: Dead Code
- **Files**: `shared/lib/supply.ts:47-48`
- **Description**: Only imported in its own test file. Production uses `getPrevMonthRawOrNull`.
- **Consolidation Strategy**: Remove export or delete function.

##### [R09] `DexLiquiditySnapshot` exported but never imported externally
- **Type**: Dead Code
- **Files**: `worker/src/lib/dex-liquidity.ts:11-16`
- **Description**: Used only within same file. Also shadows shared `DexLiquidityMap`.
- **Consolidation Strategy**: Unexport and rename worker-local `DexLiquidityMap` to `DexLiquidityDbMap`.

##### [R11] `safeRecordOutcome` duplicates `recordOutcomeSafe`
- **Type**: Code Duplication
- **Files**: `worker/src/api/stablecoin-detail.ts:43-49`, `worker/src/lib/circuit-breaker.ts:146-152`
- **Description**: Inline closure reimplements the centralized `recordOutcomeSafe` function.
- **Consolidation Strategy**: Replace with `recordOutcomeSafe(db, source, success)`.

##### [R14] Local `formatCapacityUsd` and `formatMcap` duplicate `formatCurrency`
- **Type**: Code Duplication
- **Files**: `src/components/stablecoin-detail/redemption-backstop-card.tsx:15-21`, `src/components/status/discovery-candidates.tsx:12-17`
- **Description**: Both reimplement the T/B/M/K abbreviation ladder already in `shared/lib/format.ts:formatCurrency`.
- **Consolidation Strategy**: Replace with `formatCurrency` + null guard.

##### [R16] `safety-score-version.ts` doesn't use `createMethodologyVersion` factory
- **Type**: Inconsistency
- **Files**: `shared/lib/safety-score-version.ts` (entire file)
- **Description**: 9 of 10 methodology version files use the factory. This one defines constants manually, lacking programmatic changelog or `getVersionAt`.
- **Consolidation Strategy**: Migrate to use `createMethodologyVersion()`.

#### Negligible

##### [R10] `MINUTES_PER_HOUR` and `MS_PER_SECOND` are file-internal only
- **Files**: `shared/lib/time-constants.ts:2, 4`
- **Consolidation Strategy**: Make `const` without `export`.

##### [R15] Local `formatSignedPercent` trivially duplicates shared version
- **Files**: `src/components/yield-detail-section.tsx:46-50`
- **Consolidation Strategy**: Import from shared or accept trivial divergence (em-dash vs hyphen).

---

### Pillar B — Code Quality

#### High Severity

##### [Q01] Auth Fallback: Header-Presence Check Without JWT Verification
- **Severity**: High
- **Category**: Security
- **Location**: `worker/src/lib/auth.ts:48-61` (`hasOpsApiAccessSignal`)
- **Description**: When `CF_ACCESS_OPS_API_AUD` is not configured, the auth system falls back to accepting requests if any of `Cf-Access-Jwt-Assertion`, `Cf-Access-Authenticated-User-Email`, or `CF-Access-Client-Id`+`CF-Access-Client-Secret` headers are present. These can be trivially spoofed.
- **Impact**: If `CF_ACCESS_OPS_API_AUD` is unconfigured and the origin is accessible without Cloudflare Access, any caller gains admin privileges.
- **Remediation**: Remove the header-presence fallback. Always require JWT verification when AUD is set. If unset, reject admin requests entirely. Add a deployment check preventing production without AUD configured.

##### [Q03] Missing Test Coverage for Core Scoring Engine
- **Severity**: High
- **Category**: Testing
- **Location**: `shared/lib/report-cards.ts` (829 lines), `shared/lib/peg-score.ts` (181 lines), `shared/lib/redemption-backstop-scoring.ts` (268 lines)
- **Description**: The three most critical scoring modules lack dedicated unit tests. While API-level tests exist, they don't exercise scoring functions directly. `computeStressedGrades` (stress test simulation) has zero test coverage.
- **Impact**: Scoring changes can silently alter grades for 157+ stablecoins. Edge cases in weight redistribution, peg multiplier curves, dependency ceilings, and grade boundaries are unverified.
- **Remediation**: Add `shared/lib/__tests__/report-cards.test.ts` covering `scoreToGrade` boundaries, `computeOverallGrade` with NR dimensions, `scoreDependencyRisk` with circular/missing upstreams, `computeStressedGrades` with override cascades. Add similar tests for `computePegScore` and `computeEffectiveExitScore`.

#### Medium Severity

##### [Q02] Long Parameter Lists in Critical Functions
- **Category**: Design Pattern
- **Location**: `worker/src/cron/sync-blacklist.ts:748-757` (8 params), `:206-224` (10 params), `:493-502` (9 params), `worker/src/lib/report-cards-snapshot.ts:247-256` (8 params)
- **Description**: Several functions accept >5 positional parameters, making call sites error-prone.
- **Remediation**: Introduce options objects (already used well elsewhere, e.g., `JwtVerifyOptions`).

##### [Q04] Monolithic `backfill-depegs.ts` — 1035 Lines, Multiple Responsibilities
- **Category**: Design Pattern / Complexity
- **Location**: `worker/src/api/backfill-depegs.ts`
- **Description**: Single file handles FX rate fetching, commodity price calculation, price history chunking, supply parsing, depeg event extraction, and orchestration. `extractDepegEvents` alone is 120 lines with state machine logic.
- **Remediation**: Split into `backfill-fx.ts`, `backfill-price-sources.ts`, and a slimmer orchestrator.

##### [Q05] `dispatch-telegram-alerts.ts` — 1069 Lines
- **Category**: Complexity
- **Location**: `worker/src/cron/dispatch-telegram-alerts.ts`
- **Description**: Handles 4 snapshot types, diffing, subscriber matching, quiet hours, message consolidation, pending queue management, batch sending, blocked user cleanup, and snapshot persistence.
- **Remediation**: Extract snapshot diff logic and pending queue management into separate modules (~400-line orchestrator remaining).

##### [Q06] Unsafe Type Assertions on External API Data
- **Category**: Type Safety
- **Location**: `worker/src/cron/sync-stablecoins/stages.ts:42, 53`
- **Description**: `chainCirculating` from DefiLlama is cast as `Record<string, Record<string, unknown>>` without runtime validation. If the API shape changes, the code silently produces incorrect results.
- **Remediation**: Add runtime shape validation before casting. Define a Zod schema for the DL response.

##### [Q11] No Zod Validation on Several External API Responses
- **Category**: Type Safety / Data Integrity
- **Location**: `worker/src/cron/sync-blacklist.ts:446` (TronGrid), `worker/src/api/backfill-depegs.ts:111` (Frankfurter FX), `worker/src/api/backfill-depegs.ts:759` (CG prices), `worker/src/cron/sync-bluechip.ts`
- **Description**: Many external API responses use `as TypeName` assertions instead of Zod validation. The team applies Zod selectively but not universally.
- **Remediation**: Add Zod schemas for TronGrid events, CG market charts, and Frankfurter FX rates. Prioritize TronGrid (most fragile external integration).

##### [Q13] Partial Atomicity in `backfill-stability-index` Rebuild
- **Category**: Data Integrity
- **Location**: `worker/src/api/backfill-stability-index.ts:56-57`
- **Description**: Uses `db.exec()` for DROP TABLE + CREATE TABLE. If interrupted between DROP and rebuild, stability index data is temporarily inconsistent.
- **Remediation**: Use `db.batch()` for DDL or add state tracking for partial rebuild detection.

##### [Q14] `enrichMissingPrices` — 875 Lines With 4 Sequential Passes
- **Category**: Complexity
- **Location**: `worker/src/cron/enrich-prices.ts:570-875`
- **Description**: 4-pass enrichment pipeline in a single function body with 8+ mutable counter variables.
- **Remediation**: Extract each pass into a named helper returning its own result struct.

##### [Q16] No Tests for `supply.ts` or `peg-utils.ts` Core Logic
- **Category**: Testing
- **Location**: `shared/lib/supply.ts` (99 lines), `shared/lib/peg-utils.ts`
- **Description**: `getCirculatingRaw`, `sumPegBuckets`, `mergeDepegSeconds`, `worstDeviation` — functions used across the entire dashboard — lack dedicated unit tests.
- **Remediation**: Add `shared/lib/__tests__/supply.test.ts` and `shared/lib/__tests__/peg-utils.test.ts`.

#### Low Severity

##### [Q07] Missing `reserves` in Stress Test Minimal Meta
- **Category**: Type Safety
- **Location**: `shared/lib/report-cards.ts:808-813`
- **Description**: Minimal meta object in `computeStressedGrades` omits `reserves`, relying on fallback behavior.
- **Remediation**: Add `reserves: undefined` explicitly or define `StressTestMeta` type.

##### [Q08] Inconsistent Error Return Patterns in Cron Catch Blocks
- **Category**: Error Handling
- **Location**: Multiple files in `worker/src/cron/`
- **Description**: Mix of `console.warn`+continue, `console.error`+return, and silent `catch {}`.
- **Remediation**: Adopt lightweight error classification comments.

##### [Q09] `syncBlacklist` Return Type Field Name Ambiguous
- **Category**: Naming
- **Location**: `worker/src/cron/sync-blacklist.ts:43-47`
- **Description**: `itemCount` could mean events fetched, rows written, or configs processed.
- **Remediation**: Rename to `rowsInserted` or add JSDoc.

##### [Q15] `Math.pow(10, decimals)` Precision Risk for Tron Amounts
- **Category**: Data Integrity
- **Location**: `worker/src/cron/sync-blacklist.ts:458`
- **Description**: Uses `Number()` for Tron amounts while EVM side uses BigInt. Precision loss possible for >15 decimals.
- **Remediation**: Use `BigInt` for conversion (matching EVM code path).

---

### Pillar C — Sustainability & Maintainability

#### Medium Impact

##### [S01] Duplicate Migration Sequence Numbers
- **Category**: Configuration
- **Scope**: `worker/migrations/`
- **Description**: Migrations `0056` and `0061` each have multiple files sharing the same sequence number. The `check:migrations` script validates syntax but not sequence uniqueness.
- **Remediation**: Add uniqueness check to `scripts/check-worker-migrations.mjs`.

##### [S03] Safety Scripts Not in CI Pipeline
- **Category**: Build/Deploy
- **Scope**: `.github/workflows/validate-ci.yml`
- **Description**: `check:cron-sync`, `check:doc-counts`, `check:duplicate-exports` only run locally or in the merge gate. A PR modifying cron triggers without running `check:cron-sync` could deploy a mismatch.
- **Remediation**: Add these three checks to `validate-ci.yml` (fast, no network, high value).

##### [S05] Large Stablecoin Configuration as Data-in-Code
- **Category**: Modularity
- **Scope**: `shared/lib/stablecoins/`
- **Description**: 174 coins stored as TypeScript across 4 files (~5,141 lines). Excellent type safety but operational friction for catalog changes.
- **Remediation**: Acceptable trade-off at current scale. If >200 coins, consider JSON/YAML with codegen.

##### [S20] Cron Slot Connection Contention Managed But Fragile
- **Category**: Scalability
- **Scope**: `worker/src/handlers/scheduled/`
- **Description**: The 6-connection-per-trigger budget is managed by code discipline and comments, not automated enforcement. A new `fetch()` in a shared-trigger job could exhaust the pool.
- **Remediation**: Add subrequest-count assertions to cron job tests, or connection budget metadata to cron definitions.

##### [S21] No Integration or End-to-End Test Layer
- **Category**: Build/Deploy
- **Scope**: System-wide
- **Description**: Unit tests are comprehensive (242 files), and smoke tests verify post-deploy. But no integration tests exercise worker + D1 together locally.
- **Remediation**: Add a small integration test suite using `wrangler dev --local` or Miniflare for critical paths.

#### Low Impact

##### [S02] Stale Worktrees Consuming 2.3 GB
- **Category**: Build/Deploy
- **Scope**: `worktrees/`
- **Description**: 12 worktrees, several from completed branches. No automated cleanup.
- **Remediation**: Add script listing worktrees whose branch is merged to main.

##### [S04] In-Memory Rate Limiting Not Effective Across Isolates
- **Category**: Scalability
- **Scope**: `worker/src/lib/rate-limit.ts`
- **Description**: Legacy `checkRateLimit` uses in-memory Map, ineffective across Workers isolates. The D1-backed version is used in production.
- **Remediation**: Deprecate or document as "best-effort single-isolate only."

##### [S06] Monolithic Route Registry Growing
- **Category**: Architecture
- **Scope**: `worker/src/route-registry.ts`
- **Description**: 304 lines, imports 48 handlers eagerly. Manageable now but scales linearly.
- **Remediation**: No immediate action. Consider lazy-loading if endpoint count grows significantly.

##### [S09] Worker tsconfig Includes Frontend Path Alias
- **Category**: Configuration
- **Scope**: `worker/tsconfig.json`
- **Description**: `"@/*": ["../src/*"]` exists in worker tsconfig. Boundary enforced by CI and ESLint, but IDE auto-complete offers invalid imports.
- **Remediation**: Remove the `@/*` mapping from `worker/tsconfig.json`.

##### [S10] Circuit Breaker TOCTOU Window (Acknowledged)
- **Category**: Scalability
- **Scope**: `worker/src/lib/circuit-breaker.ts`
- **Description**: Documented TOCTOU in half-open state. Accepted trade-off given D1's lack of CAS primitives.
- **Remediation**: No action needed. Documentation is clear.

##### [S17] 75 Migration Files With No Squash Strategy
- **Category**: Scalability
- **Scope**: `worker/migrations/`
- **Description**: Growing migration directory. CI replays all on every run.
- **Remediation**: Consider periodic squash into baseline after milestones.

---

## Positive Findings (Notable Strengths)

These are not issues — they represent exemplary engineering practices to maintain:

| Area | Description |
|------|-------------|
| **Zero SQL injection** | All D1 queries use parameterized `db.prepare().bind()`. `buildInClause` generates safe placeholders. |
| **Near-zero `any`** | Only 2 occurrences across 160K lines (test mock, prompt string match). |
| **Circuit breakers everywhere** | All external API calls use `shouldAttemptFetch`/`recordOutcome`. No cascade failures. |
| **Timing-safe auth** | `timingSafeCompare` uses HMAC via Web Crypto API for webhook secrets. |
| **Proper CORS** | Origin validation against configurable allowlist, never `*`. Full security headers. |
| **Runtime-neutral shared layer** | Zero DOM, Worker, or framework imports in `shared/`. Verified by CI + ESLint + tsconfig. |
| **No barrel exports in frontend** | All imports by direct path. No tree-shaking issues. |
| **Comprehensive documentation** | 53 specialized docs, methodology changelogs, `.env.example` with 31 vars documented. |
| **Staged deployment pipeline** | Validate -> deploy worker -> smoke API -> deploy pages -> smoke UI -> smoke ops. SHA-pinned Actions. |
| **API contract chain** | Endpoint registry -> handler validation -> Zod response schemas -> hook polling. Traceable end-to-end. |
| **Clean hook architecture** | No DOM in hooks. No manual URL construction. Cron-derived polling intervals. |
| **Type discipline** | `strict: true` everywhere. Zero `as any` in production code. Worker types properly scoped. |
| **`dangerouslySetInnerHTML` safe** | All 14 uses are JSON-LD with `safeJsonLd()` escaping. |
| **D1 query patterns scaled** | Batched statements, compare-and-swap cache writes, pagination helper, overload retry. |
| **Lean dependencies** | 21 prod + 2 worker deps. No abandoned packages. `npm audit` in CI. |
| **Consistent cron architecture** | `logCronRun` wraps all jobs with timeout/logging/progress. Lease system prevents overlap. |
| **Clean frontend env usage** | Only 5 `process.env` references, all `NEXT_PUBLIC_` or `NODE_ENV`. No secret leaks. |
| **Worktree exclusion patterns** | tsconfig, vitest, eslint all exclude worktrees. No stale code interference. |

---

## 3. Cross-Cutting Concerns

These findings span multiple pillars and represent compound issues with higher priority:

### [CC-1] External API Response Validation Gap
**Spans**: Q06 (Type Safety) + Q11 (Data Integrity) + S21 (no integration tests)

The codebase has excellent internal type safety but inconsistently validates external API responses. DefiLlama prices use Zod; TronGrid events, CoinGecko market charts, Frankfurter FX, and DefiLlama `chainCirculating` structures use `as TypeName` assertions. When these external APIs change, the failure mode is silent data corruption rather than fast failure. This compounds with the lack of integration tests (S21) — the only defense is production smoke tests.

**Priority**: High — validate the most fragile integrations (TronGrid, DL chain data) first.

### [CC-2] Core Scoring Logic Is Duplicated AND Untested
**Spans**: R03 (PYS formula duplication) + Q03 (missing scoring tests) + Q16 (missing supply/peg tests)

The scoring layer — the product's core value proposition — has two compounding risks: (a) the PYS formula exists in two places that can drift, and (b) the report card, peg score, and supply functions lack direct unit tests. If either the worker or frontend formula is changed independently, there's no test to catch the divergence.

**Priority**: High — extract PYS to shared, then add tests for all scoring modules.

### [CC-3] Safety Checks Rely on Local Discipline, Not CI
**Spans**: S03 (safety scripts not in CI) + S01 (migration sequence uniqueness) + S20 (connection contention)

Three important consistency checks run only locally: cron schedule sync, doc count validation, and duplicate export detection. Migration sequence uniqueness has no check at all. Connection budget enforcement is purely comments. A PR from a new contributor or an AI agent could violate any of these without CI catching it.

**Priority**: Medium — adding 3 scripts to CI is minimal effort with outsized payoff.

### [CC-4] Monolithic Handler Files Resist Maintenance
**Spans**: Q04 (backfill-depegs 1035 lines) + Q05 (telegram-alerts 1069 lines) + Q14 (enrichMissingPrices 875 lines)

Three handler/cron files exceed 800 lines with multiple responsibilities. They're individually complex (state machines, multi-pass pipelines, 4 snapshot types) and would benefit from decomposition. Each represents a maintenance burden when debugging production issues.

**Priority**: Medium — decompose as part of future feature work in these areas.

---

## 4. Prioritized Remediation Roadmap

### Phase 1 — Quick Wins
Low-effort, high-impact changes completable independently.

| Ref | Action | Files Affected | Effort |
|-----|--------|----------------|--------|
| R01 | Delete `sort-utils.ts` and its test | 2 files | Small |
| R06 | Remove/unexport dead `PRICING_PIPELINE_VERSION` | 1 file | Small |
| R07 | Remove/unexport dead `getRedemptionBackstopVersionAt` | 1 file | Small |
| R08 | Remove dead `getPrevMonthRaw` export | 1 file | Small |
| R09 | Unexport `DexLiquiditySnapshot`, rename local `DexLiquidityMap` | 1 file | Small |
| R10 | Unexport `MINUTES_PER_HOUR`, `MS_PER_SECOND` | 1 file | Small |
| R11 | Replace inline `safeRecordOutcome` with `recordOutcomeSafe` | 1 file | Small |
| R12 | Replace 7 local `DAY = 86400` with `DAY_SECONDS` import | 7 files | Small |
| R02 | Replace `clampConfidence` with `clamp(x, 0.1, 1)` | 1 file | Small |
| R05 | Rename telegram `DepegEvent` to `DepegAlertPayload` | 1 file (+imports) | Small |
| R14 | Replace local format functions with `formatCurrency` | 2 files | Small |
| R04 | Replace raw `Response` in `audit-depeg-history` with `jsonResponse` | 1 file | Small |
| S09 | Remove `@/*` path alias from `worker/tsconfig.json` | 1 file | Small |
| S02 | Clean up stale worktrees | 12 worktrees | Small |
| Q09 | Rename `itemCount` to `rowsInserted` in `SyncBlacklistResult` | 1 file (+consumers) | Small |

### Phase 2 — Targeted Refactoring
Medium-effort changes addressing specific quality and redundancy issues.

| Ref | Action | Files Affected | Effort | Dependencies |
|-----|--------|----------------|--------|--------------|
| Q01 | Remove auth header-presence fallback; require JWT always | `worker/src/lib/auth.ts` + deploy config | Medium | None (highest priority) |
| Q03 | Add unit tests for `report-cards.ts` scoring engine | New test file + shared/lib | Medium | None |
| Q16 | Add unit tests for `supply.ts` and `peg-utils.ts` | New test files | Medium | None |
| R03 | Extract PYS formula to `shared/lib/yield-scoring.ts` | 3 files | Medium | None |
| R13 | Consolidate DEX liquidity types to shared Zod schemas | 2-3 files | Medium | None |
| S03 | Add `check:cron-sync`, `check:doc-counts`, `check:duplicate-exports` to CI | 1 workflow file | Small | None |
| S01 | Add migration sequence uniqueness check | 1 script file | Small | None |
| Q06 | Add Zod schema for DL `chainCirculating` response | 2 files | Medium | None |
| Q11 | Add Zod schemas for TronGrid, CG market chart, Frankfurter FX | 3-4 files | Medium | None |
| Q02 | Convert long param lists to options objects in `sync-blacklist.ts` | 1 file | Medium | None |
| R16 | Migrate `safety-score-version.ts` to `createMethodologyVersion` | 1 file | Small | None |
| Q15 | Use BigInt for Tron amount parsing | 1 file | Small | None |
| Q08 | Standardize error classification in cron catch blocks | ~10 files | Medium | None |
| Q07 | Add `reserves: undefined` to stress test meta | 1 file | Small | None |

### Phase 3 — Structural Improvements
Higher-effort changes improving long-term maintainability.

| Ref | Action | Files Affected | Effort | Dependencies |
|-----|--------|----------------|--------|--------------|
| Q04 | Split `backfill-depegs.ts` into FX, price sources, orchestrator | 3+ files | Large | None |
| Q05 | Extract snapshot diff and pending queue from `dispatch-telegram-alerts.ts` | 3+ files | Large | None |
| Q14 | Extract enrichment passes from `enrichMissingPrices` | 2-3 files | Medium | None |
| S21 | Add integration test layer with Miniflare | New test setup + files | Large | Phase 2 Zod schemas |
| S20 | Add connection budget metadata to cron definitions | Cron config + tests | Medium | None |
| Q13 | Improve atomicity of stability index rebuild | 1 file | Medium | None |
| S17 | Squash old migrations into baseline | Migration dir | Large | Coordination with D1 |

### Phase 4 — Strategic (Future Scale)
Changes that become relevant as the project grows beyond current scale.

| Ref | Action | Trigger | Effort |
|-----|--------|---------|--------|
| S05 | Extract stablecoin catalog to JSON/YAML + codegen | >200 stablecoins | Large |
| S06 | Lazy-load route handlers | >60 endpoints | Medium |
| S04 | Replace in-memory rate limiter with D1-backed version | New rate-limited features | Medium |

---

## 5. Appendices

### Appendix A — File-by-File Finding Index

| File | Findings |
|------|----------|
| `shared/lib/format.ts` | R14, R15 (canonical source) |
| `shared/lib/math.ts` | R02 (canonical source) |
| `shared/lib/peg-score.ts` | Q03 |
| `shared/lib/peg-utils.ts` | Q16 |
| `shared/lib/pricing-pipeline-version.ts` | R06 |
| `shared/lib/redemption-backstop-scoring.ts` | Q03 |
| `shared/lib/redemption-backstop-version.ts` | R07 |
| `shared/lib/report-cards.ts` | Q03, Q07 |
| `shared/lib/safety-score-version.ts` | R16 |
| `shared/lib/supply.ts` | R08, Q16 |
| `shared/lib/time-constants.ts` | R10, R12 (canonical source) |
| `shared/types/market.ts` | R05, R13 |
| `src/components/stablecoin-detail/redemption-backstop-card.tsx` | R14 |
| `src/components/status/discovery-candidates.tsx` | R14 |
| `src/components/yield-detail-section.tsx` | R15 |
| `src/lib/sort-utils.ts` | R01 |
| `src/lib/yield-constants.ts` | R03 |
| `src/lib/__tests__/peg-scoring.test.ts` | R12 |
| `worker/src/api/audit-depeg-history.ts` | R04, R12 |
| `worker/src/api/backfill-depegs.ts` | Q04, Q11, R12 |
| `worker/src/api/backfill-dews.ts` | R12 |
| `worker/src/api/backfill-stability-index.ts` | Q13, R12 |
| `worker/src/api/mint-burn-flows-shared.ts` | R12 |
| `worker/src/api/stablecoin-detail.ts` | R11 |
| `worker/src/cron/dispatch-telegram-alerts.ts` | Q05 |
| `worker/src/cron/dex-liquidity/types.ts` | R13 |
| `worker/src/cron/enrich-prices.ts` | Q14 |
| `worker/src/cron/sync-blacklist.ts` | Q02, Q09, Q11, Q15 |
| `worker/src/cron/sync-bluechip.ts` | Q11 |
| `worker/src/cron/sync-stablecoins/stages.ts` | Q06 |
| `worker/src/cron/yield-helpers.ts` | R03 (canonical source) |
| `worker/src/lib/auth.ts` | Q01 |
| `worker/src/lib/circuit-breaker.ts` | R11 (canonical), S10 |
| `worker/src/lib/dex-liquidity.ts` | R09 |
| `worker/src/lib/psi-recompute.ts` | R12 |
| `worker/src/lib/rate-limit.ts` | S04 |
| `worker/src/lib/report-cards-snapshot.ts` | Q02 |
| `worker/src/lib/status-reliability.ts` | R02 |
| `worker/src/lib/telegram-alerts.ts` | R05 |
| `worker/src/route-registry.ts` | S06 |
| `worker/tsconfig.json` | S09 |
| `worker/migrations/` | S01, S17 |
| `.github/workflows/validate-ci.yml` | S03 |

### Appendix B — Dependency Audit Summary

| Package | Version | Status | Notes |
|---------|---------|--------|-------|
| `next` | 16.1.6 | Current | Latest major |
| `react` / `react-dom` | ^19.2.4 | Current | Latest major |
| `typescript` | ~5.9.0 | Current | Pinned consistently across root + worker |
| `@tanstack/react-query` | ^5.90.21 | Current | |
| `recharts` | ^3.8.0 | Current | |
| `zod` | ^4.3.6 | Current | v4 |
| `tailwindcss` | ^4.2.1 | Current | v4 |
| `vitest` | ^4.1.0 | Current | |
| `eslint` | ^9.39.4 | Current | Flat config |
| `@radix-ui/*` (6 packages) | Various ^2.x/^1.x | Current | Granular imports |
| `d3-force` | ^3.0.0 | Current | Dependency map visualization |
| `html-to-image` | ^1.11.13 | Current | Portfolio share |
| `lucide-react` | ^0.577.0 | Current | Icon library |
| `satori` (worker) | — | Current | OG image generation |
| `@cf-wasm/resvg` (worker) | — | Current | SVG to PNG for OG |

**Verdict**: All dependencies are actively maintained, current major versions, and appropriately scoped. No redundant, abandoned, or vulnerable packages detected. The 21+2 production dependency count is lean for the feature set.

### Appendix C — Glossary

| Term | Definition |
|------|------------|
| **Circuit breaker** | Pattern that stops calling a failing external service after repeated failures, with half-open probe to detect recovery |
| **TOCTOU** | Time-of-check-time-of-use race condition: state can change between checking a condition and acting on it |
| **CAS** | Compare-and-swap: atomic operation that updates a value only if it matches an expected previous value |
| **PSI** | Pharos Stability Index — composite stability score for stablecoins |
| **PYS** | Pharos Yield Score — yield quality assessment factoring APY, risk, and sustainability |
| **DEWS** | Dynamic Early Warning System — 8-signal threat detection for stablecoins |
| **D1** | Cloudflare's serverless SQLite database |
| **Isolate** | Cloudflare Workers execution context; module-level state persists within but not across isolates |
| **Barrel export** | An `index.ts` file that re-exports from multiple modules, potentially defeating tree-shaking |
| **SRP** | Single Responsibility Principle — a class/module should have one reason to change |
| **Zod** | TypeScript-first runtime schema validation library |
| **DDL** | Data Definition Language — SQL statements like CREATE TABLE, DROP TABLE |
| **Miniflare** | Local Cloudflare Workers simulator for testing |
