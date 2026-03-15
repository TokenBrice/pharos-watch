# Pharos Stablecoin Dashboard — Comprehensive Codebase Audit

**Date:** 2026-03-15 | **Codebase:** `stablecoin-dashboard` | **Coverage:** Frontend + Worker + Shared

---

## 1. Executive Summary

### Findings Count

| Pillar | High/Critical | Medium | Low | Total |
|--------|:---:|:---:|:---:|:---:|
| **Redundancy** | 0 | 2 | 7 | **9** |
| **Code Quality** | 5 | 6 | 3 | **14** |
| **Sustainability** | 3 | 9 | 3 | **15** |
| **Total** | **8** | **17** | **13** | **38** |

### Top 5 Critical Findings

| # | Finding | Pillar | Why It Matters |
|---|---------|--------|----------------|
| 1 | **Q1** — Silent error suppression in rate-limit pruning | Quality | Allows rate-limit bypass under DB pressure; security risk |
| 2 | **Q4** — Unhandled promise rejection in Alchemy block-timestamp batches | Quality | Silent data loss; corrupt timestamp maps propagate into downstream scoring |
| 3 | **S2** — `stablecoins.ts` at 4,924 lines (5× larger than any peer) | Sustainability | Single point of contention; 40+ dependents; cascading rebuild cost |
| 4 | **S4** — 24 cron jobs across 10 trigger slots; quarter-hourly slot near connection pool limit | Sustainability | Adding one more fetching job to the quarter-hourly slot risks pool exhaustion |
| 5 | **Q5** — Division-by-zero risk in yield variance produces `NaN` scores | Quality | Silent bad data flows into PYS and ranking tables |

### Overall Health Scores

| Pillar | Score | Justification |
|--------|:-----:|---------------|
| **Redundancy** | 8/10 | Architecture is sound; main issues are organizational boilerplate (error.tsx pattern, version file repetition), not logic duplication |
| **Code Quality** | 6.5/10 | Well-structured overall, but five High-severity issues in error handling and numeric safety concentrate risk in the yield pipeline and external-API layers |
| **Sustainability** | 7/10 | Excellent documentation corpus (50 files) and test infrastructure (233 tests); weakest at scale: one 5k-line God file, inconsistent DB batching, and undocumented cron slot capacity |

### Technical Debt Profile

~25% of the codebase carries significant findings: the yield-sync module, the stablecoins metadata file, the route registry, and the entire cron error-handling layer all need targeted attention.

---

## 2. Findings by Pillar

---

### Pillar 1 — Redundancy

#### Medium

**FINDING-R2: Duplicate Time-Constant Definitions Across Boundaries**
- **Files:** `src/lib/cron-intervals.ts` (ms units) · `shared/lib/time-constants.ts` (seconds) · `worker/src/lib/time-constants.ts` (thin re-export wrapper)
- **Type:** Near-Duplicate
- **Description:** Three files serve the same purpose with different units and naming conventions. Frontend imports millisecond values from `@/lib/cron-intervals`; worker wraps shared seconds via a re-export. The wrapper adds zero logic but requires a developer to know three files exist.
- **Strategy:** Consolidate into `@shared/lib/time-constants.ts` with both second and millisecond exports. Delete `src/lib/cron-intervals.ts` and `worker/src/lib/time-constants.ts`. Update ~15 import sites.

**FINDING-R12: API Endpoint Paths Hand-Coded Alongside Existing Helpers**
- **Files:** `shared/lib/api-endpoints.ts` lines 51–93 (API_PATHS helpers) vs lines 95–563 (ENDPOINT_DEFINITIONS array)
- **Type:** Partial Exact Duplicate
- **Description:** ~15 paths in `ENDPOINT_DEFINITIONS` are hardcoded strings instead of using the existing `API_PATHS.*()` helpers (e.g., line 212: `path: "/api/dex-liquidity-history"` instead of `path: API_PATHS.dexLiquidityHistory()`). Drift risk: updating a helper doesn't update the definition.
- **Strategy:** Audit every `ENDPOINT_DEFINITIONS` entry; replace all bare string paths with the corresponding `API_PATHS` getter. Add a CI validation that all definition paths are generated from helpers.

---

#### Low

**FINDING-R1: 11+ Identical 3-Line `error.tsx` Files**
- **Files:** `src/app/*/error.tsx` (about, blacklist, cemetery, compare, coverage, depeg, dependency-map, flows, liquidity, methodology, portfolio, safety-scores, stability-index, status, yield, stablecoin/[id]/, stablecoins/[peg]/)
- **Type:** Exact Duplicate
- **Description:** Each file contains exactly 3 lines delegating to `createPageError()`. The factory already exists; the per-route files are pure boilerplate glue. ~33 lines of identical content across 17+ files.
- **Strategy:** Replace with a single generic `src/app/error.tsx` root handler, or keep the factory pattern but generate the files from a script rather than maintaining them manually.

**FINDING-R4/R13: 8 Methodology Version Files With Identical Export Shape**
- **Files:** All `shared/lib/*-version.ts` — `safety-score-version`, `stability-index-version`, `liquidity-score-version`, `mint-burn-flow-version`, `depeg-dews-version`, `blacklist-tracker-version`, `pricing-pipeline-version`, `redemption-backstop-version`
- **Type:** Redundant Abstraction
- **Description:** Each file exports the same 4–5 names (`XXX_METHODOLOGY_VERSION`, `XXX_METHODOLOGY_VERSION_LABEL`, `XXX_METHODOLOGY_CHANGELOG_PATH`, `XXX_METHODOLOGY_CHANGELOG`, `getXxxMethodologyVersionAt`) with a different prefix. The `createMethodologyVersion()` factory already extracts logic; only the export names vary.
- **Strategy:** Create `shared/lib/methodology-registry.ts` with a single object `METHODOLOGY_VERSIONS = { psi, liquidity, yield, … }`. Keep individual files as re-export shims for backward compat.

**FINDING-R11: Cron Constants Re-Exported Through `use-api-query.ts`**
- **Files:** `src/hooks/use-api-query.ts` lines 5–12
- **Type:** Redundant Abstraction
- **Description:** The hook re-exports `CRON_1MIN`, `CRON_15MIN`, etc. from `@/lib/cron-intervals`, creating a misleading import path that suggests the hook defines these constants.
- **Strategy:** Remove the re-export. All consumers should import directly from `@/lib/cron-intervals` (or `@shared/lib/time-constants` after R2 is resolved).

**FINDING-R5: DEX Constants Split Across Two Files Without Clear Boundary**
- **Files:** `worker/src/lib/dex-constants.ts` · `worker/src/cron/dex-liquidity/constants.ts`
- **Description:** The split is defensible (reusable utilities vs. cron-specific config) but undocumented, causing "where does this go?" decisions for new constants.
- **Strategy:** Rename for clarity: `dex-core-constants.ts` (reusable) and `dex-liquidity-config.ts` (cron-specific). Add a one-line comment at the top of each explaining the boundary.

**FINDING-R6: Yield-Sync Functions Spread Across 5 Files Without Documented Rationale**
- **Files:** `worker/src/cron/yield-helpers.ts` · `yield-sync/sources.ts` · `yield-sync/resolve.ts` · `yield-sync/cache.ts` · `yield-sync/rankings.ts`
- **Description:** Pure math vs. I/O separation is intentional and good, but the boundary is undocumented. Naming (`sources.ts`) doesn't signal its role vs. `yield-helpers.ts`.
- **Strategy:** Add section comments to each file documenting which pipeline stage it serves. Rename `sources.ts` → `pool-discovery.ts`.

**FINDING-R3: Bridge Classifier Split — Architecture Is Correct, Needs Documentation**
- **Files:** `worker/src/lib/mint-burn-bridge-classifier.ts` · `worker/src/lib/mint-burn-pipeline/classification.ts`
- **Description:** Pure logic vs. async orchestration — a valid pattern. No consolidation needed; document the layering in a comment.

---

### Pillar 2 — Code Quality

#### High / Critical

**FINDING-Q1: Silent Error Suppression in Rate-Limit Pruning**
- **File:** `worker/src/lib/rate-limit.ts` lines 140–143, 192–195
- **Category:** Error Handling | **Severity:** High
- **Description:** `.catch()` handlers on DB prune operations log a warning and discard the error. If D1 pruning silently fails repeatedly, the in-memory rate-limit map grows stale or unbounded and rate limiting can be bypassed under DB pressure. No recovery path.
- **Remediation:** Track consecutive prune failures; after N failures, switch to aggressive in-memory eviction and alert ops.

**FINDING-Q2: Missing Type Validation in `buildInClause()`**
- **File:** `worker/src/lib/db.ts` lines 39–45
- **Category:** Type Safety | **Severity:** High
- **Description:** The function throws on empty arrays but does not validate element types. `null`, `undefined`, or object values can be passed as bind values, causing silent D1 failures or unexpected type coercions.
- **Remediation:** Add a loop validating each element is a string, number, or boolean before building the clause; throw descriptively on invalid input.

**FINDING-Q3: Unsafe Cast in `validateStablecoinEntry()`**
- **File:** `worker/src/lib/stablecoins-cache.ts` line 18
- **Category:** Type Safety | **Severity:** High
- **Description:** `result.data as StablecoinData` bypasses TypeScript's type checking after a Zod `.safeParse()` with `.passthrough()`. Required fields like `id` and `symbol` are not explicitly verified to be present and non-empty before the cast.
- **Remediation:** After `safeParse`, explicitly destructure and check critical required fields before returning.

**FINDING-Q4: Unhandled Promise Rejection in Alchemy Block-Timestamp Batch**
- **File:** `worker/src/lib/alchemy-logs.ts` lines 431–471
- **Category:** Error Handling | **Severity:** High
- **Description:** The batch `eth_getBlockByNumber` request lacks structured error handling. Malformed JSON or HTTP errors are caught, but the catch path doesn't prevent the recursive log-split from continuing with an incomplete timestamp map. Downstream scoring uses corrupted age data silently.
- **Remediation:** Return a `{ logs, complete: false }` partial-success shape from the catch path; callers should gate on `complete` before trusting timestamps.

**FINDING-Q5: `NaN` Propagation in Yield Variance / Stability Score**
- **File:** `worker/src/cron/yield-helpers.ts` lines 46–61
- **Category:** Error Handling | **Severity:** High
- **Description:** `computeYieldStability()` checks `Math.abs(mean) < 1e-10` before computing CV, but does not guard against `NaN` or `Infinity` in the CV itself. `Math.max(0, Math.min(1, NaN))` → `NaN`, which then enters the PYS formula and ranking tables silently.
- **Remediation:** Add `if (!Number.isFinite(cv)) return null;` after computing CV.

---

#### Medium

**FINDING-Q6: Unsafe `.reduce()` on Potentially-Empty Array in Pool Selection**
- **File:** `worker/src/cron/yield-helpers.ts` lines 130–145
- **Category:** Type Safety | **Severity:** Medium
- **Description:** `candidates.reduce((a, b) => b.tvlUsd > a.tvlUsd ? b : a)` will throw if `candidates` is empty. The enclosing `if (candidates.length > 0)` guard is correct today but is one filter-logic change away from being wrong.
- **Remediation:** Use the two-argument reduce overload with an explicit initial value, or enforce via a stricter early guard.

**FINDING-Q7: Silent Data Drop in `parseWarningSignals()`**
- **File:** `worker/src/cron/yield-sync/rankings.ts` lines 83–91
- **Category:** Error Handling | **Severity:** Medium
- **Description:** JSON parse errors return `[]` without any logging. Non-string elements are filtered silently. Bad data that enters the DB produces an invisible empty-array result, making data quality issues undetectable.
- **Remediation:** Log all parse failures and filtered element counts via `console.warn`.

**FINDING-Q8: `useUrlFilters` — Effect Dependency Pattern Is Fragile**
- **File:** `src/hooks/use-url-filters.ts` lines 31–34
- **Category:** React Anti-Pattern | **Severity:** Medium
- **Description:** `useEffect` depends on `syncFromLocation` (a `useCallback` with `[]`). This is correct today but the stable-reference guarantee is not obvious. If `syncFromLocation` ever gains dependencies, an `[]` deps array becomes a bug that's hard to diagnose.
- **Remediation:** Add an explicit comment: `// syncFromLocation is stable (empty deps on useCallback) — safe to depend on here`.

**FINDING-Q9: `scoreToGrade()` Does Not Handle Non-Finite Inputs**
- **File:** `shared/lib/report-cards.ts` lines 145–151
- **Category:** Error Handling | **Severity:** Medium
- **Description:** `Math.max(0, Math.min(100, NaN))` returns `NaN`. The threshold loop never matches, silently returning `"F"` without logging the anomaly. Upstream NaN values from peg-score calculations propagate invisibly.
- **Remediation:** Add `if (!Number.isFinite(score)) { console.warn(...); return "F"; }` before clamping.

**FINDING-Q10: Cache Injection Catch Block Returns Undefined Instead of Error Response**
- **File:** `worker/src/lib/api-utils.ts` lines 475–483
- **Category:** Error Handling | **Severity:** Medium
- **Description:** If the cached value is malformed JSON, the catch block logs a warning but the caller receives `undefined`. This causes a runtime crash further up the call stack with no useful context.
- **Remediation:** Return `new Response(cached.value, { headers })` (unparsed passthrough) or an explicit `errorResponse(503, "Cache corruption")` from the catch path.

**FINDING-Q11: Partial EVM Log Failure Returns Wrong Data Shape**
- **File:** `worker/src/lib/evm-logs.ts` lines 231–245
- **Category:** Error Handling | **Severity:** Medium
- **Description:** When recursive block-range splitting has one half return `null`, `[...(null ?? []), ...(rightLogs)]` returns only the right half silently as if it were the full result. Supply event data is systematically incomplete.
- **Remediation:** Track completion separately; return `{ logs: partialLogs, complete: false }` on partial success so callers can decide whether to trust the result.

---

#### Low

**FINDING-Q12: Implicit String→Number Coercion in `rowToRanking()`**
- **File:** `worker/src/cron/yield-sync/rankings.ts` lines 5–38
- **Category:** Type Safety | **Severity:** Low
- **Description:** Numeric DB fields are assigned directly without type guards. If D1 returns `"5.0"` as a string (a known D1 quirk on some column types), arithmetic downstream produces `NaN`.
- **Remediation:** `const currentApy = typeof row.current_apy === "number" ? row.current_apy : parseFloat(String(row.current_apy ?? 0));`

**FINDING-Q13: `SectionErrorBoundary` Retry Loop Has No Backoff or Max Attempts**
- **File:** `src/components/section-error-boundary.tsx` lines 21–23
- **Category:** React Anti-Pattern | **Severity:** Low
- **Description:** "Try again" resets `hasError` immediately, re-throwing the same error if it's deterministic (e.g., bad API response shape). Results in infinite-retry UX.
- **Remediation:** Add a `retryAttempts` counter; after 3 attempts, show "please refresh" instead of a retry button.

**FINDING-Q14: In-Memory Rate-Limit Map Can Grow Past `MAX_IP_ENTRIES` Under Attack**
- **File:** `worker/src/lib/rate-limit.ts` lines 20–74
- **Category:** Complexity | **Severity:** Low
- **Description:** Prune strategy deletes a random half of entries when over capacity, not the oldest. Under a DDoS spike, the map can exceed `MAX_IP_ENTRIES` between prune cycles.
- **Remediation:** Sort entries by `lastSeen` before pruning; evict the oldest half.

---

### Pillar 3 — Sustainability & Maintainability

#### High

**FINDING-S2: `stablecoins.ts` Is a 4,924-Line God File**
- **Scope:** `shared/lib/stablecoins.ts` — imported by 40+ files across frontend and worker
- **Impact:** High
- **Description:** At 5.7× the size of the next-largest peer (`dead-stablecoins.ts` at 1,191 lines), this file is a single point of change for all stablecoin metadata. Any modification triggers a TypeScript re-check of 4,924 lines, a re-test cascade across 40+ importing modules, and a full-file review burden. Metadata (name, logo, chains) is mingled with derived config (supply sources, depeg tracking, blacklist rules).
- **Recommendation:** Split into `stablecoins-registry.ts` (minimal identity data), `stablecoins-supply-config.ts` (supply sources + peg config), and `stablecoins-metadata-extended.ts` (governance, links, etc.). Keep `stablecoins.ts` as a barrel re-export for backward compat.

**FINDING-S3: 186 Direct D1 Query Calls With Inconsistent Batching Strategy**
- **Scope:** `worker/src/**/*.ts` — cron + API handlers
- **Impact:** High
- **Description:** Only 22 of 186 D1 calls use `db.batch()`. High-volume loops (e.g., iterating 156 stablecoins) likely use single-row `db.run()` calls instead of batching. Per CLAUDE.md, the 30-second CPU limit on D1 is already known to kill UPDATE-with-JOIN at scale. As `mint_burn_events` (~1M rows) and `supply_history` (~225K rows) grow, un-batched loops will start timing out.
- **Recommendation:** Create `worker/src/lib/db-queries.ts` as a batching layer. Enforce per-stablecoin-id chunking for all writes to tables with >10K rows. Add a CI lint check that flags bare `db.run()` inside `for` loops.

**FINDING-S4: 24 Cron Jobs Across 10 Trigger Slots; Quarter-Hourly Slot Near Connection Pool Limit**
- **Scope:** `wrangler.toml`, `shared/lib/cron-jobs.ts`, `worker/src/handlers/scheduled/*.ts`
- **Impact:** High
- **Description:** The quarter-hourly slot (`*/15`) already runs sync-stablecoins, sync-fx-rates, stability-index, compute-dews, status-self-check, and snapshot-supply — all sharing one 6-connection Workers fetch pool. A comment in `quarter-hourly.ts` warns about this. Adding any new fetching job to this slot risks pool exhaustion and cascading timeouts. There is no documented policy for when a job needs isolation vs. can share a slot.
- **Recommendation:** (1) Document current fetch-connection count per slot in `docs/worker-infrastructure.md`. (2) Create a CI script that counts concurrent fetch calls per slot and fails if any slot exceeds 4. (3) Preemptively move the next high-fetch cron to an isolated trigger.

---

#### Medium

**FINDING-S1: 10 Version Files Create Discoverability Burden**
- **Scope:** All `shared/lib/*-version.ts` files (10 total)
- **Description:** No single place lists all version files, their purpose, or their consumers. Every new algorithm addition requires a new file. The `createMethodologyVersion()` factory is good; the proliferation is the problem.
- **Recommendation:** Create `shared/lib/methodology-registry.ts` as a central hub. (Overlaps with R4/R13.)

**FINDING-S5: 38 Env Vars in `Env` Interface Have No Inline Documentation**
- **Scope:** `worker/src/lib/env.ts`
- **Description:** Fields like `FEEDBACK_IP_SALT`, `MINT_BURN_ALERT_COOLDOWN_SEC`, and `CF_ACCESS_OPS_UI_AUD` have no comments explaining format, purpose, or what breaks if they're absent. Onboarding a new developer or debugging a misconfiguration requires tracing through code.
- **Recommendation:** Add JSDoc comments to every field in the `Env` interface. Create a startup validator that logs warnings for missing optional-but-critical vars (e.g., `ANTHROPIC_API_KEY` for digest generation).

**FINDING-S6: Global Test Coverage Threshold Is 55% — Below Industry Standard**
- **Scope:** `vitest.config.ts`
- **Description:** 55% line coverage with no per-module thresholds. Critical modules like `worker/src/lib/auth.ts`, `worker/src/handlers/*`, and `shared/lib/report-cards.ts` may have lower coverage than the global threshold implies.
- **Recommendation:** Raise global threshold to 70%. Add per-module floors (85% for auth, 80% for handlers). Document the distinction between global threshold and the `coverage:critical` ratchet mechanism.

**FINDING-S8: No Migration Version Control or Rollback Runbook**
- **Scope:** `worker/migrations/*.sql` (31 files)
- **Description:** Wrangler applies migrations sequentially with no tracking table, checksums, or rollback semantics. Recovery from a bad migration depends on knowing to use D1 Time Travel — a procedure not documented in the repo. Rollback steps involve manual wrangler commands that are easy to get wrong under pressure.
- **Recommendation:** (1) Create `worker/migrations/MANIFEST.md` documenting each migration's date, intent, and idempotency guarantee. (2) Add a `_migrations` tracking table. (3) Document the full rollback procedure in `docs/deployment-process.md`.

**FINDING-S9: Route Registry Is a 250+-Line Import Explosion**
- **Scope:** `worker/src/route-registry.ts`
- **Description:** 40+ handler imports at the top; 80+ hand-wired entries in `STATIC_ROUTE_HANDLERS_BY_KEY`. Adding an endpoint requires changes in 4 places (handler file, import in registry, entry in registry, definition in api-endpoints.ts). No build-time validation that defined endpoints have implementations.
- **Recommendation:** Co-locate each handler's registration with its implementation (`export const endpoint: EndpointEntry = { key, handler }`). Aggregate in registry via `buildRouteRegistry([...handlers])`, which validates completeness at startup.

**FINDING-S10: Complex Cron Jobs Lack Algorithm Overview Comments**
- **Scope:** `worker/src/cron/sync-mint-burn.ts` (855 lines), `dex-liquidity/*`, `yield-sync/*`
- **Description:** A developer reading `sync-mint-burn.ts` must traverse 855 lines to understand the three-stage pipeline. No function has a comment explaining why it exists. The DEX liquidity and yield crons are similarly opaque.
- **Recommendation:** Add a file-level docblock to each major cron explaining its pipeline stages, input sources, output targets, and budget constraints. Create `docs/algorithm-guide.md` with diagrams.

**FINDING-S11: Post-Merge Duplicate-Export Check Is Manual**
- **Scope:** CLAUDE.md post-merge checklist step 4; no corresponding CI script
- **Description:** Parallel worktree merges can silently introduce duplicate `export const X` definitions in the same file. There is no automated check — it relies on human vigilance. The failure mode is unpredictable runtime behavior.
- **Recommendation:** Create `scripts/check-duplicate-exports.mjs`. Add to `package.json` scripts. Run in CI on every push to main.

**FINDING-S12: 50 Documentation Files Have No Automated Staleness Detection**
- **Scope:** `docs/*.md` (50 files)
- **Description:** File path references in docs can become stale silently (e.g., a cron trigger count in `worker-infrastructure.md` becomes wrong after `wrangler.toml` changes). No CI checks that referenced paths exist or counts match reality.
- **Recommendation:** Create `scripts/check-doc-staleness.sh` that validates file path references in docs still exist and that structured counts (cron triggers, tracked stablecoins) match live code.

**FINDING-S13: No Concurrency or Connection-Pool Tests**
- **Scope:** `worker/src/__tests__/`, cron test suite
- **Description:** 233 test files cover nominal paths well. No tests simulate: simultaneous cron trigger execution, 6-connection pool saturation, `db.batch()` atomicity under simulated failures, or lease-manager race conditions.
- **Recommendation:** Create `worker/src/__tests__/concurrency.test.ts` covering: (1) simultaneous lease requests for the same job, (2) partial `db.batch()` failure with idempotent re-run, (3) sequential-job enforcement on shared cron slots.

---

#### Low

**FINDING-S7: Inconsistent Import Style Within `shared/lib/`**
- **Scope:** `shared/lib/**/*.ts`
- **Description:** Files within `shared/lib` occasionally use `@shared/lib/file` imports (intended for external consumers) instead of relative `./file` imports. This blurs the module boundary.
- **Recommendation:** Add ESLint rule for `shared/lib/*.ts` files prohibiting `@shared/*` imports (use `./` instead). Document the convention in CLAUDE.md.

**FINDING-S14: Cron Error Handling Has No Shared Policy**
- **Scope:** `worker/src/handlers/scheduled/*.ts`
- **Description:** Some cron handlers call `sendAlert()`, others log at warn and continue, others silently swallow errors. No documented policy exists for when each strategy is appropriate.
- **Recommendation:** Define a 4-tier error policy (fatal / recoverable / validation / degradation) in `docs/worker-infrastructure.md`. Create `worker/src/lib/cron-error-reporter.ts` as a shared utility.

**FINDING-S15: npm Workspace Setup Underdocumented**
- **Scope:** `package.json`, `worker/package.json`
- **Description:** No `.nvmrc`, no `.npmrc`, no README section explaining why `npm install` must be run from root (not from `worker/`). A developer running `npm install` inside `worker/` creates a second lock file.
- **Recommendation:** Add `.nvmrc` (pin LTS), `.npmrc` (workspace hygiene), and a "Setup" section to README.

---

## 3. Cross-Cutting Concerns

**CC-1: The Yield Pipeline Is the Riskiest Module (R6 + Q5 + Q6 + Q7 + S10)**

The yield-sync module accumulates five independent findings across all three pillars:
- **R6:** Functions scattered across 5 files without documented boundaries
- **Q5:** Division-by-zero produces silent `NaN` PYS scores
- **Q6:** Unsafe reduce on potentially-empty candidate array
- **Q7:** Silent data drop in warning signals parsing
- **S10:** No algorithm overview; 4-tier APY resolution logic is undocumented

Together these make the yield pipeline the highest-risk module: it produces user-visible APY and PYS rankings, is recently modified (per git status), and has the least documentation and runtime safety guards. Treat as a focused remediation target.

---

**CC-2: Version File Pattern Needs Consolidation (R4 + R13 + S1)**

Three agents independently flagged the 8–10 methodology version files: the redundancy agent noted identical export shapes, the sustainability agent noted discoverability burden. Resolution via a single `methodology-registry.ts` addresses all three findings simultaneously with low effort.

---

**CC-3: Systemic Observability Deficit in Workers (Q1 + Q4 + Q10 + Q11 + S14)**

Five findings collectively describe a pattern: errors are caught and swallowed throughout the worker, with no central reporter, no dedup, and no escalation policy. Rate-limit pruning failures (Q1), Alchemy batch failures (Q4), cache injection errors (Q10), and partial EVM log failures (Q11) all silently corrupt data or degrade service without operator visibility. S14 adds that cron error handling has no defined policy. A single `cron-error-reporter.ts` utility and a documented error-tier policy would address all five.

---

**CC-4: Endpoint Management Is Fragmented (R12 + S9)**

Path duplication in `api-endpoints.ts` (R12) and the import-explosion in `route-registry.ts` (S9) are two symptoms of the same problem: there is no single authoritative source that maps "this endpoint exists" → "this path" → "this handler". Consolidating via co-located `EndpointEntry` exports and a `buildRouteRegistry()` validator solves both.

---

**CC-5: D1 Access Layer Has Safety and Scale Risks (Q2 + S3)**

`buildInClause()` lacks input validation (Q2), and the broader codebase has 186 direct D1 calls without a consistent batching strategy (S3). Both findings point to the need for a purpose-built `db-queries.ts` layer that enforces safe binding and per-ID batching for large-table operations.

---

## 4. Prioritized Remediation Roadmap

### Phase 1 — Quick Wins
*Low effort, immediately actionable, no architectural changes required.*

| Ref | Action | Files | Effort | Depends On |
|-----|--------|-------|:------:|:----------:|
| Q5 | Add `isFinite(cv)` guard in `computeYieldStability` | `yield-helpers.ts` | S | — |
| Q9 | Add `isFinite` guard in `scoreToGrade` | `shared/lib/report-cards.ts` | S | — |
| Q7 | Log warning signals parse failures | `yield-sync/rankings.ts` | S | — |
| Q12 | Add type guards in `rowToRanking` | `yield-sync/rankings.ts` | S | — |
| Q2 | Validate bind values in `buildInClause` | `worker/src/lib/db.ts` | S | — |
| Q3 | Explicit required-field check in `validateStablecoinEntry` | `stablecoins-cache.ts` | S | — |
| S5 | Add JSDoc to all 38 `Env` interface fields | `worker/src/lib/env.ts` | S | — |
| S7 | Add ESLint rule: no `@shared/*` inside `shared/lib` | `eslint.config.mjs` | S | — |
| S15 | Add `.nvmrc`, workspace README section | root | S | — |
| R11 | Remove cron constant re-export from `use-api-query.ts` | `src/hooks/use-api-query.ts` | S | — |
| S11 | Create `scripts/check-duplicate-exports.mjs` + add to CI | `scripts/`, CI config | S | — |
| S10 | Add file-level algorithm overview comments to `sync-mint-burn.ts`, `yield-sync/*`, `dex-liquidity/*` | 5+ cron files | M | — |

### Phase 2 — Targeted Refactoring
*Medium effort, specific quality and redundancy improvements.*

| Ref | Action | Files | Effort | Depends On |
|-----|--------|-------|:------:|:----------:|
| Q1 | Fix rate-limit prune error suppression; add failure counter + memory fallback | `rate-limit.ts` | M | — |
| Q4 | Return partial-success shape from Alchemy batch catch path | `alchemy-logs.ts` | M | — |
| Q10 | Fix cache injection catch to return usable response | `api-utils.ts` | S | — |
| Q11 | Return `{ complete: false }` from partial EVM log splits | `evm-logs.ts` | M | — |
| Q6 | Add safe reduce guard in pool selection | `yield-helpers.ts` | S | Q5 |
| Q13 | Add retry backoff + max attempts to `SectionErrorBoundary` | `section-error-boundary.tsx` | S | — |
| R2 | Consolidate time constants into `@shared/lib/time-constants.ts` | 3 files + ~15 import sites | M | — |
| R12 | Replace all bare path strings in `ENDPOINT_DEFINITIONS` with `API_PATHS.*()` | `api-endpoints.ts` | S | — |
| R4/R13/S1 | Create `methodology-registry.ts`; convert 8 version files to re-exports | `shared/lib/` | M | — |
| S6 | Raise vitest threshold to 70%; add per-module floors for critical files | `vitest.config.ts` | S | — |
| S8 | Create `MANIFEST.md` for migrations + `_migrations` tracking table + rollback runbook | `worker/migrations/`, `docs/` | M | — |
| S12 | Create `scripts/check-doc-staleness.sh` + add to CI | `scripts/`, CI config | M | S11 |

### Phase 3 — Structural Improvements
*Higher effort, targeted at specific subsystems.*

| Ref | Action | Files | Effort | Depends On |
|-----|--------|-------|:------:|:----------:|
| CC-3/S14 | Create `cron-error-reporter.ts`; define 4-tier error policy; refactor slot runners | `worker/src/lib/`, `handlers/scheduled/` | M | — |
| S9/R12 | Refactor route registry: co-locate `EndpointEntry` with handlers; `buildRouteRegistry()` | `route-registry.ts`, `worker/src/api/*` | L | R12 |
| S4 | Document fetch-connection count per cron slot; add CI slot-capacity check script | `docs/`, `scripts/`, CI | M | — |
| S13 | Create `worker/src/__tests__/concurrency.test.ts` covering lease races and partial batch failures | `worker/src/__tests__/` | L | — |
| R1 | Auto-generate or consolidate route `error.tsx` files | `src/app/*/error.tsx` | M | — |
| S3 | Create `db-queries.ts` batching layer; refactor high-volume `db.run()` loops | `worker/src/lib/`, multiple cron files | L | Q2 |

### Phase 4 — Strategic Overhauls
*Major refactoring efforts addressing deep structural concerns.*

| Ref | Action | Files | Effort | Depends On |
|-----|--------|-------|:------:|:----------:|
| S2 | Split `stablecoins.ts` (4,924 lines) into registry, supply-config, and metadata-extended modules | `shared/lib/stablecoins*.ts`, 40+ importers | L | — |
| S3 (deep) | Enforce batching layer across entire D1 access surface; add telemetry | All worker DB callers | L | S3 Phase 3 |
| S4 (deep) | Audit and rebalance cron slot assignments; isolate any slot exceeding 4 concurrent connections | `wrangler.toml`, cron handlers | L | S4 Phase 3 |
| CC-4 | Full endpoint registry with build-time completeness validation | `shared/lib/api-endpoints.ts`, registry | L | S9 |

---

## 5. Appendices

### A. File-by-File Finding Index

| File | Findings |
|------|---------|
| `worker/src/lib/rate-limit.ts` | Q1, Q14 |
| `worker/src/lib/db.ts` | Q2, CC-5 |
| `worker/src/lib/stablecoins-cache.ts` | Q3 |
| `worker/src/lib/alchemy-logs.ts` | Q4 |
| `worker/src/lib/api-utils.ts` | Q10 |
| `worker/src/lib/evm-logs.ts` | Q11 |
| `worker/src/lib/env.ts` | S5 |
| `worker/src/lib/dex-constants.ts` | R5 |
| `worker/src/cron/yield-helpers.ts` | Q5, Q6, R6, CC-1 |
| `worker/src/cron/yield-sync/rankings.ts` | Q7, Q12 |
| `worker/src/cron/yield-sync/sources.ts` | R6 |
| `worker/src/cron/sync-mint-burn.ts` | S10 |
| `worker/src/cron/dex-liquidity/constants.ts` | R5 |
| `worker/src/handlers/scheduled/*.ts` | S4, S14 |
| `worker/src/route-registry.ts` | S9, CC-4 |
| `worker/migrations/*.sql` | S8 |
| `shared/lib/stablecoins.ts` | S2, CC-5 |
| `shared/lib/api-endpoints.ts` | R12, CC-4 |
| `shared/lib/report-cards.ts` | Q9 |
| `shared/lib/*-version.ts` (×8) | R4, R13, S1, CC-2 |
| `shared/lib/time-constants.ts` | R2 |
| `src/lib/cron-intervals.ts` | R2, R11 |
| `src/hooks/use-api-query.ts` | R11 |
| `src/hooks/use-url-filters.ts` | Q8 |
| `src/components/section-error-boundary.tsx` | Q13 |
| `src/app/*/error.tsx` (×17) | R1 |
| `vitest.config.ts` | S6 |
| `eslint.config.mjs` | S7 |
| `docs/*.md` (×50) | S12 |
| `package.json` | S15 |

---

### B. Dependency Audit Summary

| Package | Version | Status |
|---------|---------|--------|
| `next` | 16.1.6 | Current major |
| `react` / `react-dom` | ^19.2.4 | Current |
| `@tanstack/react-query` | ^5.90.21 | Current |
| `recharts` | ^3.8.0 | Current |
| `zod` | ^4.3.6 | Current major |
| `tailwindcss` | ^4.2.1 | Current major |
| `lucide-react` | ^0.577.0 | Current |
| `d3-force` | ^3.0.0 | Current |
| `html-to-image` | ^1.11.13 | No update in ~2 years — evaluate for maintenance status |
| `clsx` + `tailwind-merge` | Both present | Intentional: `cn()` needs both; not redundant |

No known high-severity CVEs detected in production dependencies. `html-to-image` should be monitored for maintenance activity.

---

### C. Positive Findings (What's Working Well)

- **`shared/lib/format.ts`** — All formatting utilities centralized in one place; zero duplication found across frontend and worker.
- **`createPageError()` factory** — Correct abstraction for route error boundaries; the 17 boilerplate files are the only issue, not the pattern itself.
- **`use-url-filters.ts` / `use-homepage-filters.ts` layering** — Clean separation of generic URL parameter sync from domain filter logic.
- **`mint-burn-bridge-classifier.ts` + `classification.ts` split** — Correct pure-function / async-orchestration layering.
- **`mint-burn-signals.ts` / `mint-burn-scoring.ts` separation** — State machines in shared/, financial metrics in worker. Correct boundary.
- **Worker boundary enforcement** — No evidence of `src/` importing from `worker/` or vice versa; the `@shared/*` alias is used correctly at the boundary.
- **Documentation corpus** — 50 docs covering every major subsystem is exceptional for a project at this scale.
- **Comprehensive test scripts** — `test:critical-contracts`, `test:invariants`, `coverage:critical`, `test:merge-gate` demonstrate deliberate test strategy. The 233-file test suite is a strong asset.
- **D1 Time Travel awareness** — CLAUDE.md documents the rollback procedure; this institutional knowledge just needs to move into `docs/deployment-process.md` (S8).

---

### D. Glossary

| Term | Definition |
|------|-----------|
| **God File** | A module so large it becomes a single point of contention for changes, rebuilds, and cognitive load |
| **Swallowed exception** | A `catch` block that logs or ignores an error without propagating it, masking failures from callers |
| **Cron slot** | A single Cloudflare Workers cron trigger; multiple jobs can share one slot but share its 6-connection fetch pool |
| **D1 batch** | `db.batch([stmt1, stmt2, …])` — Cloudflare D1's mechanism for atomic multi-statement execution |
| **Cache bust** | A version identifier embedded in API cache keys to force a fresh fetch when methodology changes |
| **PYS** | Pharos Yield Score — the composite yield quality metric computed per stablecoin |
| **PSI** | Pharos Stability Index — the composite stability metric tracked in the stability-index cron |
| **DEWS** | Depeg Early Warning System — 8 sub-signal threat-band detection system |
| **NaN propagation** | When `NaN` enters a computation and all downstream arithmetic silently produces `NaN` without error |
| **Worktree merge** | Git workflow where parallel feature branches are developed in isolated working trees then merged sequentially |
