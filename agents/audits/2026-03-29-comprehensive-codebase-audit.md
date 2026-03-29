# Comprehensive Codebase Audit Report

**Date:** 2026-03-29
**Scope:** Full codebase — frontend (`src/`), worker (`worker/src/`), shared (`shared/`), functions, scripts, configuration
**Build status:** Clean (all routes prerender, zero compilation errors)

---

## 1. Executive Summary

### Findings Overview

| Pillar | Critical | Medium | Low | Total |
|---|---|---|---|---|
| Redundancy | 0 | 1 | 8 | 9 |
| Code Quality | 0 | 4 | 7 | 11 |
| Sustainability | 0 | 4 | 4 | 8 |
| **Total** | **0** | **9** | **19** | **28** |

### Codebase Health Ratings

| Pillar | Score | Justification |
|---|---|---|
| **Redundancy** | **8 / 10** | Very little genuine duplication. The codebase already uses factories (`createPageError`, `createMethodologyChangelogRoute`), shared utilities, and centralized constants extensively. Findings are mostly thin re-export shims and one dead root artifact. |
| **Code Quality** | **8 / 10** | Strong type safety (zero `as any` in production code), comprehensive Zod validation at API boundaries, parameterized SQL, proper auth/CORS/rate-limiting. Main gaps are ~70 empty catch blocks in cron pipelines and some monolithic file complexity. |
| **Sustainability** | **9 / 10** | Exemplary architectural enforcement (ESLint boundary rules, static import checks, cycle detection), deploy-surface-aware CI/CD with structural parity tests, 363 test files, zero npm audit vulnerabilities, thorough documentation corpus with automated doc-sync checks. |

**Overall: 8.3 / 10** — This is a well-engineered codebase with mature tooling and strong conventions. Technical debt is concentrated in the worker cron layer (silent error handling, file size) and a handful of legacy shims. Roughly **2–3%** of the codebase is affected by medium-severity findings.

### Top 5 Most Critical Findings

1. **[Q1] ~70 empty `catch {}` blocks in worker cron pipelines** — Silent error swallowing in data-critical paths makes debugging production issues extremely difficult.
2. **[Q4] Dual-query pattern in `getPriceCache()`** — Doubles D1 read cost and introduces a race window between the two queries.
3. **[Q3] Four monolithic cron files (660–820 lines)** — `dispatch-telegram-alerts.ts` handles 6 alert types, subscribers, formatting, batching, and queuing in one file.
4. **[S7] No automated rollback mechanism in CI/CD** — D1 migrations are forward-only; worker deploys have no automated revert on post-deploy failure.
5. **[R5] Status severity logic duplicated across 3 files** — Three independent implementations of the same `"healthy"|"degraded"|"stale"` → numeric mapping, risking silent divergence.

---

## 2. Findings by Pillar

### Pillar A — Redundancy

#### R1 (Low) — Duplicate + Dead ID Mapping Table

**Files:**
- `DESIGN-MAPPING-TABLE.ts` (root, 237 lines) — never imported anywhere
- `scripts/generate-redirects.ts:18–175` — inline copy of the same mapping

**Description:** The stablecoin ID migration mapping (`ID_MAPPING`, `SHADOW_ID_MAPPING`, `DEAD_ID_MAPPING`) exists in two copies. The root file is a dead artifact ("Auto-generated for TICKET-002") with zero consumers. `generate-redirects.ts` has its own inline copy rather than importing from the root file.

**Consolidation:** Delete `DESIGN-MAPPING-TABLE.ts`. If the redirect script still needs the mapping, keep its inline copy (it's the only consumer). If the migration is complete and redirects are baked, consider removing both.

**Effort:** Small

---

#### R2 (Low) — Dead Export `formatDeathDateShort`

**File:** `shared/lib/format.ts:198`

**Description:** Exported function with test coverage (`src/lib/__tests__/format.test.ts:357`) but zero production consumers anywhere in the codebase.

**Consolidation:** Remove the function and its tests.

**Effort:** Small

---

#### R3 (Low) — Thin Re-export Shims in Worker

**Files:**
- `worker/src/lib/depeg-config.ts` (4 lines — pure re-export from `@shared/lib/depeg-config`)
- `worker/src/lib/dews-config.ts` (4 lines — pure re-export from `@shared/lib/dews-config`)

**Description:** Each is a 4-line file that re-exports from `@shared/lib/` with exactly one consumer. The `@shared/` alias is directly available in worker code, making these indirection-only shims.

**Consolidation:** Update each single consumer to import from `@shared/lib/` directly. Delete both shim files.

**Effort:** Small

---

#### R4 (Low) — Thin Wrapper `findChainData`

**File:** `src/hooks/use-chains.ts:44–49`

**Description:** Exported function that delegates directly to `findCanonicalChainData` from `@shared/lib/chain-circulating` with identical parameters and return type. One internal caller (line 66).

**Consolidation:** Replace calls with direct use of `findCanonicalChainData`. Remove `findChainData`.

**Effort:** Small

---

#### R5 (Medium) — Duplicate Status Severity Logic

**Files:**
- `shared/lib/public-health.ts:6` — `STATUS_SEVERITY` record + `maxPublicStatus` function
- `src/lib/status/public-status.ts:56` — standalone `getStatusSeverity` function
- `src/components/status/top-fold-copy.ts:76` — standalone `getStatusSeverity` function

**Description:** Three separate implementations map `"healthy" | "degraded" | "stale"` to numeric severity. The shared module already has the logic; the two frontend files independently redefine it. Divergence risk if severity ordering ever changes.

**Consolidation:** Export a single `getStatusSeverity()` from `shared/lib/public-health.ts`. Replace both frontend definitions.

**Effort:** Small

---

#### R6 (Low) — Repeated Chart Animation Pattern

**Files:**
- `src/components/total-mcap-chart.tsx:31`
- `src/components/psi-history-chart.tsx:152`
- `src/components/peg-diversity-chart.tsx:72`
- `src/app/stability-index/client.tsx:147`

**Description:** Four components repeat the identical ternary: `const animProps = shouldAnimate ? CHART_DRAW_IN : { isAnimationActive: false }`.

**Consolidation:** Add a `resolveAnimProps(shouldAnimate: boolean)` helper to `src/lib/chart-animation.ts`, or export a `CHART_NO_ANIM` constant alongside `CHART_DRAW_IN`.

**Effort:** Small

---

#### R7 (Low) — Worker Time-Constants Convenience Aliases

**Files:**
- `worker/src/lib/time-constants.ts` (23 lines)
- `shared/lib/time-constants.ts` (13 lines)

**Description:** The worker file imports all constants from `@shared/lib/time-constants` and re-exports them wrapped in a `SECONDS` object with renamed keys. Most worker code already imports directly from shared. The `SECONDS.X` pattern has only a few call sites.

**Consolidation:** Borderline finding. Keep as-is or fold the `SECONDS` object into shared constants. Low priority — the DX convenience may be worth the minor indirection.

**Effort:** Medium (touches many import sites if removed)

---

#### R8 (Low) — Frontend `cache-health.ts` Pure Re-export

**File:** `src/lib/status/cache-health.ts` (5 lines)

**Description:** Pure pass-through re-export of 3 functions from `@shared/lib/cache-health`. Its 2–3 consumers could import from shared directly.

**Consolidation:** Update consumers to import from `@shared/lib/cache-health`. Delete the shim.

**Effort:** Small

---

#### R9 (Low) — Unnecessary Import Alias

**File:** `src/components/yield-detail-section.tsx:18`

**Description:** Imports `formatSignedPercent as sharedFormatSignedPercent` from `@shared/lib/format` but never defines a local `formatSignedPercent`. The alias adds confusion without purpose.

**Consolidation:** Remove the alias; import as `formatSignedPercent` directly.

**Effort:** Small

---

### Pillar B — Code Quality

#### Q1 (Medium) — ~70 Empty `catch {}` Blocks in Worker Cron Code

**Files:**
- `worker/src/cron/compute-dews.ts:369, 453, 529`
- `worker/src/cron/yield-sync/cache.ts:126, 245, 303, 354, 402, 456`
- `worker/src/cron/dex-liquidity/challenger-persistence.ts:118, 333, 378`
- `worker/src/cron/daily-digest/response.ts:45–58` (triple-nested catch chain)
- ~55 additional occurrences across other cron modules

**Problem:** Silent error swallowing in data pipeline code. Many catches have comments (e.g., `/* expected: malformed signals_json */`), but they produce zero observability. If an unexpected failure mode emerges (e.g., D1 schema change), these silent catches make debugging extremely difficult. The daily-digest response parser has three nested try/catch blocks with empty catches, creating a deep suppression chain.

**Severity:** Medium — not a current bug, but significantly impairs production debugging when issues arise.

**Remediation:** Replace empty catches in data-critical paths with `console.warn` including source context. For documented "expected malformed" cases, add a `malformedCount++` counter so cron result metadata can track regression. Refactor the daily-digest triple-nested catch into a helper with a single parse attempt and explicit fallback.

---

#### Q2 (Medium) — Complex `runLeasedCron` Closure

**File:** `worker/src/handlers/scheduled/context.ts:97–189`

**Problem:** The `runLeasedCron` closure is 90+ lines with 4 nesting levels (closure > `logCronRun` callback > `runCronWithLease` callback > conditional blocks). It manually re-parses and merges JSON metadata with a try/catch that falls back to string concatenation (`metadata = ${metadata} | lease=${JSON.stringify(leaseMeta)}`), creating a fragile mixed JSON/string metadata format.

**Severity:** Medium — the mixed format makes downstream parsing brittle and the nesting depth impairs readability.

**Remediation:** Extract a `mergeCronMetadataWithLease(cronResult, leaseOwner, renewFailures, slotStartedAt, scheduleKey)` helper. This eliminates the try/catch JSON re-parse and string-concat fallback, reducing nesting by one level.

---

#### Q3 (Medium) — Large Monolithic Cron Files

**Files:**
- `worker/src/cron/dispatch-telegram-alerts.ts` (820 lines)
- `worker/src/cron/compute-dews.ts` (678 lines)
- `worker/src/cron/sync-yield-data.ts` (666 lines)
- `worker/src/cron/sync-fx-rates-helpers.ts` (664 lines)

**Problem:** These exceed the 500-line single-file comprehension threshold. `dispatch-telegram-alerts.ts` handles detection of 6 alert types, subscriber loading, message formatting, batch sending, and queue management in one file.

**Severity:** Medium — hinders code review, onboarding, and merge conflict resolution.

**Remediation:** The project already demonstrates effective decomposition (`sync-stablecoins/` → 14 files, `dex-liquidity/` → 14 files). Apply the same pattern: extract `dispatch-telegram-alerts.ts` into a `telegram-alerts/` subdirectory with per-alert-type detection, subscriber resolution, and batch delivery modules.

---

#### Q4 (Medium) — Dual Query Pattern in `getPriceCache()`

**File:** `worker/src/lib/db-cache.ts:66–118`

**Problem:** Makes two separate queries to the same `price_cache` table — first selecting core columns, then a second query for all metadata columns. The second query is wrapped in a try/catch that silently ignores errors unless they contain "no such column". This doubles D1 read units and has a race condition window between queries.

**Severity:** Medium — unnecessary cost and subtle race condition.

**Remediation:** Consolidate into a single query selecting all columns. If forward-compatibility with missing columns is needed, use a single try/catch around the full-column query and fall back to the minimal query only on schema error.

---

#### Q5 (Low) — Template Literal Table Name Interpolation

**File:** `worker/src/cron/dex-liquidity/persistence.ts:175–186`

**Problem:** Uses `DELETE FROM ${table}` with template literal interpolation. The `table` variable comes from a hardcoded `const` array, but unlike other locations in the codebase, this site lacks an explicit allowlist validation check before interpolation.

**Severity:** Low — no current injection risk (hardcoded source), but inconsistent with the project's allowlist-validation convention.

**Remediation:** Add an allowlist Set and validate before interpolation, matching the pattern in `compute-dews.ts` and `api-utils.ts`.

---

#### Q6 (Low) — Duplicated `crypto.randomUUID()` Workaround

**File:** `worker/src/api/admin-actions.ts:78–81`

**Problem:** Accesses `crypto.randomUUID()` via a manual `globalThis` cast instead of using the existing `createLeaseOwner()` helper from `cron-lease.ts` which wraps the same pattern.

**Severity:** Low — functional duplication of a Workers runtime workaround.

**Remediation:** Replace with `createLeaseOwner("trigger-digest")` or extract the `randomUUID()` call into a shared `randomRequestId()` utility.

---

#### Q7 (Low) — Raw SQL Fragment as String Constant

**File:** `worker/src/cron/daily-digest.ts:101, 111`

**Problem:** `DAILY_FILTER` is a raw SQL WHERE clause fragment interpolated into a template literal SQL string. While hardcoded and safe, a reviewer seeing `${DAILY_FILTER}` in a `db.prepare()` call must trace back to verify it isn't user-derived.

**Severity:** Low — no security risk, but hinders auditability.

**Remediation:** Add a `// SAFETY: hardcoded SQL filter, not derived from user input` comment where interpolated, matching the convention used elsewhere.

---

#### Q8 (Low) — Large Frontend Components Lacking Test Coverage

**Files:**
- `src/components/kpi-bar.tsx` (720 lines) — no test file
- `src/components/dex-liquidity-card.tsx` (680 lines) — no test file
- `src/components/yield-detail-section.tsx` (642 lines) — no test file

**Problem:** The three largest untested frontend components contain significant business logic in `useMemo` data transformations (score computations, conditional rendering paths).

**Severity:** Low — the project has 363 test files overall, but these specific high-complexity components are uncovered.

**Remediation:** Extract `useMemo` data transformation logic into pure functions in companion `-logic.ts` files (following the existing pattern: `stablecoin-table-logic.ts`, `blacklist-table-logic.ts`, `flow-table-logic.ts`). Test the pure functions.

---

#### Q9 (Low) — `contagion-graph.tsx` Complexity

**File:** `src/components/contagion-graph.tsx` (803 lines)

**Problem:** Manages its own physics simulation, SVG rendering, pan/zoom state, hover state, tier filtering, and layout calculations in a single component. 5+ state variables, 3 `useEffect` hooks with complex dependency arrays.

**Severity:** Low — functional but dense. The layout logic is already extracted to `@/lib/contagion-layout`.

**Remediation:** Extract pan/zoom interaction into a `usePanZoom` hook and node hover/focus into a `useGraphSelection` hook. Reduces the component to rendering + hook-driven state.

---

#### Q10 (Low) — Silent RPC Failure in `evm-rpc.ts`

**File:** `worker/src/lib/evm-rpc.ts:60–101, 138–179`

**Problem:** `fetchJsonRpcResult()` and `fetchEvmCallHexAtBlock()` iterate over RPC URLs with `for...of` and silently `continue` on any error. If all RPCs fail, returns `null` with no logging of which URLs were tried or what errors occurred.

**Severity:** Low — zero observability for on-chain data debugging.

**Remediation:** Collect error/status for each failed attempt and log a single summary after the loop exhausts all URLs: `console.warn(\`[evm-rpc] ${method} failed across ${urls.length} RPCs: ${failures.join(", ")}\`)`.

---

#### Q11 (Low) — Naming Inconsistency in Cron Schedule

**File:** `worker/src/handlers/scheduled.ts:26`

**Problem:** Runner key `thirtyMinuteDexDiscovery` maps to function `runTwentyMinuteDexDiscoverySlot`. The schedule likely changed from 20 to 30 minutes without renaming the function.

**Severity:** Low — confuses maintainers.

**Remediation:** Rename the function to `runThirtyMinuteDexDiscoverySlot` or add a clarifying comment.

---

### Pillar C — Sustainability and Maintainability

#### S1 (Low) — Orphaned Root-Level `DESIGN-MAPPING-TABLE.ts`

**File:** `DESIGN-MAPPING-TABLE.ts` (237 lines, root directory)

**Problem:** Tracked by git, never imported. A migration artifact adding noise to the root directory and confusing onboarding. (Cross-reference: R1)

**Impact:** Low — no runtime effect, but contributes to root clutter.

**Remediation:** Delete and remove from git tracking. Recoverable from git history if needed.

---

#### S2 (Medium) — Global Mutable State in Worker Rate-Limit Module

**File:** `worker/src/lib/rate-limit.ts:16–20`

**Problem:** Five module-scoped `let` variables track prune state and pending promises. In Cloudflare Workers, V8 isolates recycle unpredictably. Under current load this is harmless (code is defensive about D1 transient failures and falls through gracefully), but under horizontal scaling the prune dedup would silently stop working across isolates.

**Impact:** Medium — not a current bug, but a scaling ceiling.

**Remediation:** No immediate action. If request volume grows substantially, move prune tracking into a D1 row to make it durable across isolate recycling.

---

#### S3 (Medium) — Dynamic SQL Table Name Interpolation Lacks Formalized Enforcement

**Files:**
- `worker/src/cron/compute-dews.ts:99, 112`
- `worker/src/lib/api-utils.ts:103`
- `worker/src/cron/dex-liquidity/persistence.ts:178, 183`
- `worker/src/lib/status/derived-data.ts:272`

**Problem:** Several modules use template-literal SQL interpolation for table names. Each occurrence is validated against an allowlist (correct D1 approach), but the safety depends on maintainer discipline — no automated check ensures all `FROM ${` occurrences have corresponding allowlist validation. (Cross-reference: Q5)

**Impact:** Medium — correct today, but fragile under contributor scaling.

**Remediation:** Add a lint rule or CI check that all `` `...FROM ${` `` occurrences have a corresponding allowlist check within the same function scope.

---

#### S4 (Low) — `check:unused-code` Allowlist Is Growing

**File:** `scripts/check-unused-code.mjs:20–51+`

**Problem:** The unused-code checker's allowlist of "expected unused" exports (schema types, variant builders, public API surface) needs periodic review. A growing allowlist can hide genuine dead code.

**Impact:** Low — the script works correctly, but the allowlist may silently shield dead code over time.

**Remediation:** Add a `check:unused-code:audit-allowlist` script that flags allowlisted items no longer present in the codebase.

---

#### S5 (Low) — Large Test Files in Worker Cron Layer

**Files:**
- `worker/src/cron/__tests__/sync-yield-data.test.ts` (3026 lines)
- `worker/src/cron/__tests__/sync-stablecoins.test.ts` (1992 lines)
- `worker/src/cron/__tests__/enrich-prices.test.ts` (1633 lines)

**Problem:** Monolithic test files are difficult to navigate, slow to isolate individual failures, and create merge-conflict risk.

**Impact:** Low — tests pass and are comprehensive, but the file sizes impair developer velocity.

**Remediation:** Split into focused test suites per functional concern (e.g., `sync-yield-data/resolve.test.ts`, `sync-yield-data/history.test.ts`), paralleling the production code structure.

---

#### S6 (Medium) — Stablecoin Metadata Schema Validation Is All-or-Nothing

**File:** `shared/lib/stablecoins/index.ts`, `shared/lib/stablecoins/schema.ts`, `shared/data/stablecoins/*.json` (~17K lines JSON)

**Problem:** Metadata is parsed through Zod schemas at module initialization time. A validation failure in a single coin entry crashes the entire application (both worker and frontend build). This is an intentional fail-fast design (correct for data integrity), but the JSON files are large and manually curated, making editing error-prone.

**Impact:** Medium — a single typo in a JSON entry blocks all deploys.

**Remediation:** Add a dedicated `check:stablecoin-data` script that validates JSON independently of module import, providing per-entry error messages with file/line context. Run it early in the merge gate.

---

#### S7 (Medium) — CI/CD Pipeline Has No Automated Rollback

**Files:** `.github/workflows/deploy-cloudflare.yml`, `.github/workflows/pages-release.yml`

**Problem:** The deployment pipeline is sophisticated (deploy-surface-aware detection, validation gate, D1 migrations, worker deploy, smoke tests, then Pages release), but there is no automated rollback path. D1 migrations are forward-only with no down-migration scripts. If a worker deploy produces subtle issues post-smoke-test, the revert path is manual.

**Impact:** Medium — acceptable at current scale, but a growing risk as the project evolves.

**Remediation:** Consider adding: (1) a `wrangler rollback` step triggered by post-deploy monitoring failures, (2) down-migration scripts for D1, (3) a deployment history artifact for audit trail.

---

#### S8 (Low) — TypeScript Target Mismatch

**Files:**
- Root `tsconfig.json`: `target: "ES2017"`
- `worker/tsconfig.json`: `target: "ES2021"`

**Problem:** Both runtimes (modern browsers, Cloudflare Workers) support ES2022+. The ES2017 frontend target is conservative — Next.js/SWC handles transpilation independently, so the TypeScript target primarily affects type-checking behavior. The gap is harmless but mildly confusing.

**Impact:** Low — no functional impact.

**Remediation:** Consider aligning both to ES2022 to match the Node 22+ engine constraint and actual runtime capabilities.

---

## 3. Cross-Cutting Concerns

### CC1 — Silent Error Handling Pattern (Q1 + Q10)

Empty catch blocks in cron pipelines (Q1) and silent RPC failure loops (Q10) share the same root cause: the codebase defaults to resilience-over-observability in data pipelines. While this prevents one bad data point from crashing a cron run, it creates a systemic debugging blind spot. When a data source changes format or an RPC endpoint degrades, the failure is invisible until downstream effects (missing data, stale metrics) surface much later.

**Recommendation:** Establish a consistent "warn-and-continue" pattern across all data pipelines. Replace empty catches with `console.warn` + context. Add malformed-data counters to cron result metadata. This preserves resilience while adding observability.

---

### CC2 — Dead Root Artifact (R1 + S1)

Both the Redundancy and Sustainability agents independently flagged `DESIGN-MAPPING-TABLE.ts`. It is simultaneously dead code (zero imports), a duplication source (mapping also exists inline in `generate-redirects.ts`), and an onboarding confuser (prominent root-level file with no purpose).

**Recommendation:** Delete `DESIGN-MAPPING-TABLE.ts`. Single action resolves findings across two pillars.

---

### CC3 — Monolithic File Decomposition (Q3 + Q8 + Q9 + S5)

Four cron files exceed 660 lines (Q3), three frontend components exceed 640 lines without test coverage (Q8), one component manages 5+ concerns (Q9), and three test files exceed 1600 lines (S5). The project already demonstrates the solution: `sync-stablecoins/` and `dex-liquidity/` are cleanly decomposed into 14-file subdirectories, and complex component logic is extracted into `-logic.ts` companion files.

**Recommendation:** Apply the existing decomposition patterns consistently. Priority order: (1) `dispatch-telegram-alerts.ts` (largest, most concerns), (2) large test files (most daily friction), (3) frontend components (extract logic, add tests).

---

### CC4 — Re-export Shim Accumulation (R3 + R8 + R4)

Five thin re-export shims/wrappers exist across the codebase — files that add a layer of indirection between a consumer and `@shared/lib/` without adding value. Each has 1–3 consumers that could import from shared directly. Individually minor, but collectively they obscure the import graph and add maintenance surface.

**Recommendation:** Batch-remove all five shims in a single cleanup PR. Update consumers to import from `@shared/lib/` directly.

---

### CC5 — SQL Interpolation Safety Consistency (Q5 + Q7 + S3)

The codebase handles dynamic SQL table names correctly (allowlist validation before interpolation) but inconsistently — some sites have explicit `// SAFETY:` comments and allowlist checks, others interpolate from hardcoded `const` arrays without the validation step, and one site uses a raw SQL fragment constant without safety annotation. No automated enforcement ensures new dynamic SQL follows the allowlist pattern.

**Recommendation:** (1) Add `// SAFETY:` comments to all existing interpolation sites. (2) Add a CI check (grep-based script) that flags `` `...FROM ${` `` patterns without a nearby allowlist validation or safety comment.

---

## 4. Prioritized Remediation Roadmap

### Phase 1 — Quick Wins

Low-effort, high-impact changes completable in isolation. No dependencies between items.

| Ref | Action | Files | Effort |
|---|---|---|---|
| R1/S1 | Delete `DESIGN-MAPPING-TABLE.ts` | 1 file | Small |
| R2 | Remove dead `formatDeathDateShort` + tests | 2 files | Small |
| R3 | Remove worker re-export shims (`depeg-config.ts`, `dews-config.ts`) | 4 files | Small |
| R4 | Remove `findChainData` wrapper, use `findCanonicalChainData` directly | 2 files | Small |
| R8 | Remove `cache-health.ts` re-export shim | 3 files | Small |
| R9 | Remove unnecessary `formatSignedPercent` alias | 1 file | Small |
| Q6 | Replace inline `crypto.randomUUID()` cast with `createLeaseOwner` | 1 file | Small |
| Q7 | Add `// SAFETY:` comment to `DAILY_FILTER` interpolation | 1 file | Small |
| Q11 | Rename `runTwentyMinuteDexDiscoverySlot` → `runThirtyMinuteDexDiscoverySlot` | 2 files | Small |
| S8 | Align TypeScript targets to ES2022 | 2 files | Small |

**Estimated total: ~1–2 hours of focused work**

---

### Phase 2 — Targeted Refactoring

Medium-effort changes addressing specific quality and redundancy issues.

| Ref | Action | Files | Effort | Depends on |
|---|---|---|---|---|
| R5 | Consolidate status severity logic into `shared/lib/public-health.ts` | 3 files | Small | — |
| R6 | Extract `resolveAnimProps` or `CHART_NO_ANIM` constant | 5 files | Small | — |
| Q1 | Add `console.warn` + context to empty catch blocks in cron pipelines | ~15 files | Medium | — |
| Q2 | Extract `mergeCronMetadataWithLease()` helper | 1 file | Small | — |
| Q4 | Consolidate dual `getPriceCache()` query into single query | 1 file | Small | — |
| Q5 | Add allowlist validation to `dex-liquidity/persistence.ts` SQL interpolation | 1 file | Small | — |
| Q10 | Add RPC failure summary logging to `evm-rpc.ts` | 1 file | Small | — |
| S3 | Add CI script checking SQL interpolation sites have allowlist validation | 1 new script | Medium | Q5 |
| S6 | Add `check:stablecoin-data` validation script | 1 new script | Medium | — |
| S4 | Add allowlist audit mode to `check:unused-code` | 1 file | Small | — |

**Estimated total: ~1–2 days of focused work**

---

### Phase 3 — Structural Improvements

Higher-effort changes addressing file decomposition and test coverage.

| Ref | Action | Files | Effort | Depends on |
|---|---|---|---|---|
| Q3 | Decompose `dispatch-telegram-alerts.ts` into `telegram-alerts/` subdirectory | 5–7 new files | Large | — |
| Q3 | Decompose remaining large cron files (dews, yield, fx-rates) | 8–12 new files | Large | — |
| Q8 | Extract logic from `kpi-bar`, `dex-liquidity-card`, `yield-detail-section` into `-logic.ts` files + add tests | 6+ files | Medium | — |
| Q9 | Extract `usePanZoom` and `useGraphSelection` hooks from `contagion-graph.tsx` | 3 files | Medium | — |
| S5 | Split large test files into per-concern test suites | 6–9 files | Medium | Q3 |
| R7 | Evaluate and potentially consolidate worker `time-constants.ts` | 10+ files | Medium | — |

**Estimated total: ~3–5 days of focused work**

---

### Phase 4 — Strategic Overhauls

Major infrastructure improvements for long-term scaling.

| Ref | Action | Scope | Effort | Depends on |
|---|---|---|---|---|
| S7 | Add automated rollback mechanism to CI/CD (wrangler rollback step, D1 down-migrations, deployment history) | CI/CD pipeline | Large | — |
| S2 | Move rate-limit prune state into D1 for cross-isolate durability | Worker infrastructure | Medium | — |

**Estimated total: ~2–3 days of focused work, best addressed when scaling pressure materializes**

---

## 5. Appendices

### Appendix A — File-by-File Finding Index

| File | Findings |
|---|---|
| `DESIGN-MAPPING-TABLE.ts` | R1, S1 |
| `scripts/generate-redirects.ts` | R1 |
| `shared/lib/format.ts` | R2 |
| `shared/lib/public-health.ts` | R5 |
| `shared/lib/time-constants.ts` | R7 |
| `src/app/stability-index/client.tsx` | R6 |
| `src/components/contagion-graph.tsx` | Q9 |
| `src/components/dex-liquidity-card.tsx` | Q8 |
| `src/components/kpi-bar.tsx` | Q8 |
| `src/components/peg-diversity-chart.tsx` | R6 |
| `src/components/psi-history-chart.tsx` | R6 |
| `src/components/status/top-fold-copy.ts` | R5 |
| `src/components/total-mcap-chart.tsx` | R6 |
| `src/components/yield-detail-section.tsx` | R9, Q8 |
| `src/hooks/use-chains.ts` | R4 |
| `src/lib/status/cache-health.ts` | R8 |
| `src/lib/status/public-status.ts` | R5 |
| `worker/src/api/admin-actions.ts` | Q6 |
| `worker/src/cron/compute-dews.ts` | Q1, Q3, S3 |
| `worker/src/cron/daily-digest.ts` | Q7 |
| `worker/src/cron/daily-digest/response.ts` | Q1 |
| `worker/src/cron/dex-liquidity/challenger-persistence.ts` | Q1 |
| `worker/src/cron/dex-liquidity/persistence.ts` | Q5, S3 |
| `worker/src/cron/dispatch-telegram-alerts.ts` | Q3 |
| `worker/src/cron/sync-fx-rates-helpers.ts` | Q3 |
| `worker/src/cron/sync-yield-data.ts` | Q3 |
| `worker/src/cron/yield-sync/cache.ts` | Q1 |
| `worker/src/cron/__tests__/enrich-prices.test.ts` | S5 |
| `worker/src/cron/__tests__/sync-stablecoins.test.ts` | S5 |
| `worker/src/cron/__tests__/sync-yield-data.test.ts` | S5 |
| `worker/src/handlers/scheduled.ts` | Q11 |
| `worker/src/handlers/scheduled/context.ts` | Q2 |
| `worker/src/lib/api-utils.ts` | S3 |
| `worker/src/lib/db-cache.ts` | Q4 |
| `worker/src/lib/depeg-config.ts` | R3 |
| `worker/src/lib/dews-config.ts` | R3 |
| `worker/src/lib/evm-rpc.ts` | Q10 |
| `worker/src/lib/rate-limit.ts` | S2 |
| `worker/src/lib/status/derived-data.ts` | S3 |
| `worker/src/lib/time-constants.ts` | R7 |
| `worker/wrangler.toml` | S3 |
| `.github/workflows/deploy-cloudflare.yml` | S7 |
| `.github/workflows/pages-release.yml` | S7 |
| `scripts/check-unused-code.mjs` | S4 |
| `shared/lib/stablecoins/index.ts` | S6 |
| `tsconfig.json` | S8 |
| `worker/tsconfig.json` | S8 |

### Appendix B — Dependency Audit Summary

| Metric | Value |
|---|---|
| Frontend runtime deps | 21 |
| Frontend dev deps | 12 |
| Worker runtime deps | 2 |
| Worker dev deps | 3 |
| npm audit high/critical | 0 |
| Dependabot configured | Yes (weekly npm, monthly Actions) |
| TypeScript version | ~5.9.0 (minor range) |
| Node engine constraint | >=22 <25 |
| Lock file integrity | Clean |
| Overlapping libraries | None detected |

### Appendix C — Positive Findings Summary

The audit identified significant architectural strengths that merit documentation:

1. **SQL injection prevention** — All user-derived values use `.bind()` parameterization. Dynamic table/column names validated against allowlist Sets.
2. **Authentication** — JWT verification against Cloudflare Access JWKS with timing-safe comparison.
3. **Rate limiting** — D1-backed with IP hashing (SHA-256 + salt), proper 429 + Retry-After, fail-open on D1 unavailability.
4. **CORS/Security headers** — Origin allowlisting, HSTS, CSP, X-Content-Type-Options, Referrer-Policy.
5. **Zod validation** — Comprehensive schema validation at all API boundaries.
6. **TanStack Query discipline** — All hooks follow `staleTime = cronInterval, refetchInterval = 2x` via shared factories.
7. **Tailwind safety** — Zero dynamic class construction; all conditional classes use static string ternaries.
8. **Architectural boundary enforcement** — ESLint rules + static import checks + cycle detection, all running in CI.
9. **Cron orchestration** — Connection budget enforcement, schedule sync checks, slot fencing.
10. **CI/CD parity** — Structural test ensures merge gate and CI workflow stay aligned.
11. **Documentation** — 57 doc files, automated doc-sync checks, thorough `.env.example`.
12. **Test coverage** — 363 test files across all layers with critical coverage baseline tracking.

### Appendix D — Glossary

| Term | Definition |
|---|---|
| **D1** | Cloudflare's SQLite-compatible serverless database |
| **Allowlist validation** | Pattern where dynamic SQL identifiers are checked against a predefined Set before interpolation |
| **Re-export shim** | A thin module file that imports from one location and re-exports without adding logic |
| **Fail-fast** | Design choice where schema/validation errors crash immediately rather than producing corrupt data |
| **Isolate recycling** | Cloudflare Workers behavior where V8 isolates are created/destroyed unpredictably |
| **Connection budget** | Cloudflare Workers limit of 6 concurrent outbound connections per cron trigger |
| **Structural clone** | Code blocks with the same logic structure but superficial differences (variable names, formatting) |
| **SRP** | Single Responsibility Principle — each module/class should have one reason to change |
| **Deploy-surface-aware** | CI/CD that classifies changes by which deployment targets they affect (Pages, Worker, or both) |
