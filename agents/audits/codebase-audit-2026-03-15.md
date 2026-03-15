# Comprehensive Codebase Audit Report

**Project:** Stablecoin Dashboard (Pharos)
**Date:** 2026-03-15
**Scope:** ~112,400 LOC across 610 production source files (338 frontend, 224 worker, 48 shared), 235 test files, 74 D1 migrations, 52 documentation files

---

## 1. Executive Summary

### Finding Counts by Pillar and Severity

| Pillar | Critical | High | Medium | Low | Positive | Total |
|--------|----------|------|--------|-----|----------|-------|
| Redundancy | 0 | 0 | 3 | 12 | 0 | 15 |
| Code Quality | 1 | 3 | 7 | 9 | 8 | 28 |
| Sustainability | 0 | 0 | 5 | 7 | 4 | 16 |
| **Total** | **1** | **3** | **15** | **28** | **12** | **59** |

### Overall Codebase Health

| Pillar | Score (1-10) | Justification |
|--------|-------------|---------------|
| Redundancy | **8/10** | Strong anti-duplication patterns already in place (`createTableComparator`, `createCacheHandler`, centralized color/classification maps). Remaining duplication is residual from incremental feature additions. |
| Code Quality | **8/10** | Exceptional type discipline (1 `any` in 112K LOC), zero empty catch blocks, consistent circuit breaker pattern, comprehensive test suite. Single critical finding (auth header-only validation) is infrastructure-dependent. |
| Sustainability | **9/10** | Zero boundary violations, 52-file documentation corpus, CI with coverage ratchet, methodology versioning. Single-developer project with team-scaling readiness as the primary concern. |

### Top 5 Most Critical Findings

1. **Q-001 (Critical/Security):** Admin auth checks JWT header *presence* only, not signature validity. DNS misconfiguration would expose all admin endpoints.
2. **Q-002 (High/Complexity):** `syncStablecoins()` is 540 lines with 14 abort checkpoints and interleaved concerns -- the most critical data pipeline.
3. **Q-003 (High/Type Safety):** Pervasive `JSON.parse(...) as T` without runtime validation at system boundaries across the worker layer.
4. **Q-004 (High/Architecture):** Module-level mutable state in 5 worker modules risks subtle concurrency issues in shared isolates.
5. **S-002 (Medium/Modularity):** Stablecoin metadata monolith (4,890 lines, 157 entries) creates merge-conflict bottleneck for team scaling.

### Technical Debt Profile

Approximately **5-8%** of the codebase is affected by significant findings. This is remarkably low for a project of this size and feature breadth. The debt is concentrated in:
- Worker data pipeline complexity (~3% of worker code)
- Missing runtime validation at JSON parse boundaries (~2% of worker code)
- Residual formatting/color duplication (~1% across layers)

---

## 2. Findings by Pillar

### Pillar A: Redundancy

#### Medium Severity

**R-003 | OG Template Color Map Duplication**
- **Files:** `worker/src/lib/og-templates/stablecoin-card.tsx:23-55`, `stability-index-card.tsx:13-20`, `depeg-card.tsx:19-22` vs `shared/lib/psi-colors.ts`, `shared/lib/classification.ts:357-363`, `shared/lib/report-cards.ts:131-138`
- **Description:** Three OG template files hardcode ~40 lines of hex color maps (`GRADE_COLORS`, `DEWS_BAND_COLORS`, `PSI_BAND_COLORS`) that already exist in shared/lib. Comments claim "Satori cannot use imports" but this is incorrect for plain JS objects -- the limitation is CSS variables, not module imports.
- **Strategy:** Import canonical hex maps from `@shared/lib/` directly. Remove local copies.

**R-004 | Table Sort Logic Not Using Shared Comparator**
- **Files:** `src/components/stablecoin-table-logic.ts:88-180` (97 lines), `src/components/flow-table-logic.ts:59-112` (54 lines) vs `src/lib/table-comparator.ts`
- **Description:** Two table logic files implement hand-rolled sort comparators (~150 lines combined) with the same `switch/case -> aVal/bVal -> direction` pattern. Three other table files (`blacklist-`, `liquidity-`, `yield-table-logic.ts`) already use the existing `createTableComparator` utility.
- **Strategy:** Refactor both to use `createTableComparator` with field extractor maps. Add a `compareNullable`-aware extractor option for nullable score columns.

**R-009 | Scattered API Hook Organization**
- **Files:** `src/hooks/api-hooks.ts` (17 hooks), `use-stablecoins.ts` (2 hooks), `use-blacklist-events.ts`, `use-depeg-events.ts`, `use-mint-burn-flows.ts`
- **Description:** Data-fetching hooks are split across 5 files with no clear organizational principle. All use the same `useApiQuery` pattern. Consumers must know which file to import from.
- **Strategy:** Either consolidate all into `api-hooks.ts` (majority already there) or adopt one-hook-per-file consistently.

#### Low Severity

**R-001 | `buildFreshnessMeta` Duplicated**
- **Files:** `worker/src/api/cache-handlers.ts:24-32` (copy), `worker/src/lib/api-utils.ts:24-32` (canonical)
- **Description:** Identical function in two files. The `cache-handlers.ts` version is an inlined copy.
- **Strategy:** Export from `api-utils.ts`, import in `cache-handlers.ts`.

**R-002 | USD Formatting Duplication**
- **Files:** `worker/src/lib/og-templates/stablecoin-card.tsx:57-64` (`formatUsd`), `worker/src/api/feedback.ts:86-91` (inline), vs `shared/lib/format.ts` (`abbreviateNumber`/`formatCurrency`)
- **Description:** Two worker files duplicate the tier-based USD abbreviation logic that exists in `shared/lib/format.ts`.
- **Strategy:** Import `formatCurrency` from `@shared/lib/format` in both files.

**R-005 | Dead Export: `REDEMPTION_BACKSTOP_CHANGELOG`**
- **Files:** `shared/lib/redemption-backstop-version.ts:35`
- **Description:** Exported but never imported anywhere. Only version file changelog with zero consumers.
- **Strategy:** Remove export or wire to methodology changelog page.

**R-006 | Trivial Wrapper: `getTrackedStablecoin()`**
- **Files:** `shared/lib/tracked-stablecoin-utils.ts:11-15`
- **Description:** Single-line wrapper around `TRACKED_META_BY_ID.get(id)` with 2 consumers. Adds indirection without value.
- **Strategy:** Consider inlining. Very low priority.

**R-007 | `formatDuration` Name Collision**
- **Files:** `shared/lib/format.ts:110` (epoch seconds -> "2d 5h"), `src/components/status/format.ts:3` (ms -> "123ms")
- **Description:** Two functions with identical names but different signatures and semantics.
- **Strategy:** Rename status version to `formatLatency()` or `formatDurationMs()`.

**R-008 | Taxonomy Page Structural Repetition**
- **Files:** `src/app/stablecoins/backing/[backing]/page.tsx`, `src/app/stablecoins/governance/[governance]/page.tsx`
- **Description:** 40-line structurally identical pages differing only in data source variable names. Inherent Next.js file-system routing constraint.
- **Strategy:** No action needed. Shared `StablecoinTaxonomyPage` component already eliminates rendering duplication.

**R-010 | Re-export Barrel: `cron-schedule.ts`**
- **Files:** `worker/src/lib/cron-schedule.ts` (2-line re-export from `@shared/lib/cron-jobs`)
- **Description:** File exists solely to re-export 3 symbols. Worker consumers could import directly.
- **Strategy:** Update 4 consumers to import from `@shared/lib/cron-jobs` directly, delete file.

**R-011 | Inline `.toFixed()` Formatting in Worker**
- **Files:** ~15 instances across worker cron/API files vs `shared/lib/format.ts`
- **Description:** User-visible outputs (Telegram alerts, digest text) use inline `.toFixed()` template literals instead of shared formatters.
- **Strategy:** Use `formatCurrency`/`formatPercent` from `shared/lib/format.ts` for user-visible outputs. Leave log-only formatting as-is.

**R-013 | Overlapping Freshness Threshold Definitions**
- **Files:** `src/lib/data-health.ts`, `src/lib/data-health-config.ts`, `worker/src/lib/api-utils.ts`, `shared/lib/status-thresholds.ts`, `worker/src/lib/constants.ts`
- **Description:** Freshness evaluation implemented in 4 layers with overlapping but independently defined threshold semantics (ratio boundaries: 1.0, 1.5, 2.0).
- **Strategy:** Document relationships. Consider moving overlapping ratio boundaries into `shared/lib/status-thresholds.ts`.

**R-014 | Dead Export: `COIN_FLOW_COMPOSITE_STATE_VALUES`**
- **Files:** `shared/lib/mint-burn-signals.ts:21`
- **Description:** Exported array only consumed within same file for type derivation. No external imports.
- **Strategy:** Remove `export` keyword.

**R-015 | Inconsistent Worker USD Formatting** (subset of R-002/R-011)
- **Files:** `worker/src/lib/og-templates/stablecoin-card.tsx`, `worker/src/lib/telegram-alerts.ts`, `worker/src/cron/dex-liquidity/fetch-fallbacks.ts`
- **Description:** Three different number formatting approaches in the worker layer for the same purpose.
- **Strategy:** Standardize on `formatCurrency` from `shared/lib/format.ts`.

---

### Pillar B: Code Quality

#### Critical

**Q-001 | Admin Authentication Checks Header Presence Only**
- **Severity:** Critical
- **Category:** Security
- **Location:** `worker/src/lib/auth.ts`, `hasOpsApiAccessSignal()`, lines 25-41
- **Description:** Admin auth verifies that `Cf-Access-Jwt-Assertion`, `Cf-Access-Authenticated-User-Email`, or `CF-Access-Client-Id` headers *exist* but never validates JWT signatures or token values. The code acknowledges: "If the Worker is ever reachable without Cloudflare Access in the path, all admin endpoints are unprotected." A DNS misconfiguration or direct Worker URL leak would expose all admin/backfill endpoints to unauthenticated access with a forged header.
- **Remediation:** Add JWT signature verification using Cloudflare's JWKS endpoint. Verify `aud` claim matches the configured application AUD and token hasn't expired. The `@cloudflare/access-authenticator` package or manual JWKS verification via Web Crypto API are both viable.

#### High

**Q-002 | Excessive Complexity in `syncStablecoins()`**
- **Severity:** High
- **Category:** Complexity
- **Location:** `worker/src/cron/sync-stablecoins.ts`, lines 393-933 (540 lines)
- **Description:** The main sync function interleaves fetching, ID remapping, deduplication, price enrichment, validation, cache writes, depeg detection, and metadata assembly. Contains 14 abort-signal checkpoints, 4 CG fallback paths, and constructs two different metadata structures. The existing `stages.ts` module partially extracts helpers but many stages remain inline.
- **Remediation:** Extract into a pipeline of named stages (`fetchSources`, `remapIds`, `enrichPrices`, `validate`, `persist`, `runDepegDetection`), each returning an intermediate result. The shared post-enrichment pipeline (Q-011) between `syncStablecoins` and `fallbackToCgSupply` should be unified.

**Q-003 | Pervasive `JSON.parse(...) as T` Without Validation**
- **Severity:** High
- **Category:** Type Safety
- **Location:** Multiple worker files (examples: `worker/src/api/yield-history.ts:86`, `worker/src/api/dex-liquidity.ts:140`, `worker/src/cron/daily-digest.ts:554`)
- **Description:** `JSON.parse` results are cast to typed objects without runtime validation throughout the worker. While critical paths (stablecoins cache) use Zod, the majority blindly cast. Corrupted D1 data or upstream API changes would produce silently wrong financial analytics.
- **Remediation:** Use Zod schemas for data read from D1 or external APIs at system boundaries. The pattern already exists (`StablecoinListResponseSchema`); extend to other JSON parse sites. Use the existing `safeParse` utility from `api-utils.ts` for internal metadata.

**Q-004 | Module-Level Mutable State in Worker**
- **Severity:** High
- **Category:** Design Pattern
- **Location:** `worker/src/lib/alerts.ts:7`, `coingecko.ts:10`, `coingecko-onchain.ts:16`, `chain-registry.ts:132`, `rate-limit.ts:25-28`
- **Description:** Five modules use module-level `let` variables with `init*()` functions. While re-initialized per-request, the pattern is fragile for concurrent isolate reuse and prevents safe extension by new contributors. `rate-limit.ts` intentionally persists state across requests but will silently break if Cloudflare routes to different isolates.
- **Remediation:** Pass configuration through an explicit per-request context object. Document the single-isolate assumption for rate limiting.

#### Medium

**Q-005 | Single Try/Catch Wraps Entire Price Enrichment Pipeline**
- **Severity:** Medium
- **Category:** Error Handling
- **Location:** `worker/src/cron/enrich-prices.ts`, `enrichMissingPrices()`, lines 547-851
- **Description:** If pass 1 (DL coins API) throws, passes 2-3 are silently skipped. The catch clause sets `finalMissing = totalMissing`, masking whatever progress was made.
- **Remediation:** Wrap each pass in its own try/catch. Return `failedPasses: string[]` in stats.

**Q-006 | High Cyclomatic Complexity in Depeg Detection Inner Loop**
- **Severity:** Medium
- **Category:** Complexity
- **Location:** `worker/src/cron/detect-depegs.ts`, lines 141-291 (~25+ cyclomatic complexity)
- **Description:** 4 levels of nesting with the same DEX cross-validation conditional repeated three times at lines 211, 256, 272.
- **Remediation:** Extract helpers: `handleExistingSameDirection`, `handleDirectionChange`, `handleNewEvent`, `handleRecovery`. Create shared `isDexConfirmed()`.

**Q-007 | Largest Worker File: `sync-blacklist.ts` (1,261 lines)**
- **Severity:** Medium
- **Category:** Complexity
- **Location:** `worker/src/cron/sync-blacklist.ts`
- **Description:** Handles EVM log parsing, Tron event fetching, balance enrichment via three RPC providers, block range management, and event persistence in one file.
- **Remediation:** Extract balance-fetching logic (lines 101-291) into `balance-providers.ts`. Separate EVM/Tron parsers by chain type.

**Q-008 | Unvalidated External API Response Shapes**
- **Severity:** Medium
- **Category:** Type Safety
- **Location:** `worker/src/cron/enrich-prices.ts:513,217,256,689`
- **Description:** `(json as { coins?: ... }).coins` casts entire unknown JSON responses without validation. API shape changes would silently return empty maps.
- **Remediation:** Add structural checks or Zod schemas for external API response shapes.

**Q-009 | Misleading Function Name: `fallbackToCgSupply`**
- **Severity:** Medium
- **Category:** Naming
- **Location:** `worker/src/cron/sync-stablecoins.ts`, lines 110-391
- **Description:** Name suggests a simple supply fallback, but actually orchestrates a complete sync cycle: asset list construction, overrides, 4+ source price enrichment, Zod validation, cache write, depeg detection.
- **Remediation:** Rename to `syncViaCoingeckoFallback` or `runFallbackSyncPipeline`.

**Q-010 | No Timeout on Alert Webhook Fetch**
- **Severity:** Medium
- **Category:** Error Handling
- **Location:** `worker/src/lib/alerts.ts`, `sendAlert()`, lines 19-63
- **Description:** No timeout on Discord/Slack webhook fetch. Hanging webhook could extend cron execution or cause timeout failures.
- **Remediation:** Add `signal: AbortSignal.timeout(5000)` to the fetch call.

**Q-011 | Duplicated Pipeline Between Main Sync and Fallback**
- **Severity:** Medium
- **Category:** Design Pattern
- **Location:** `worker/src/cron/sync-stablecoins.ts`, lines 110-391 vs 393-933
- **Description:** `fallbackToCgSupply` and `syncStablecoins` contain substantial duplicated pipeline stages: price validation (lines 218-231 vs 609-627), enrichment, cache write, depeg detection. Changes must be made in both places.
- **Remediation:** Extract shared `postEnrichmentPipeline()` function called by both paths.

#### Low

**Q-012 | Double Non-null Assertion + Cast**
- **Location:** `worker/src/cron/enrich-prices.ts:678`
- **Description:** `a.price! as number` uses both `!` and `as` where the preceding filter already guarantees validity.
- **Remediation:** Store filtered results in a typed variable to eliminate assertions.

**Q-013 | Untested Reserve Adapters and Yield Resolution**
- **Location:** `worker/src/cron/yield-sync/resolve.ts`, 20+ reserve adapter files
- **Description:** Individual yield resolution logic and reserve adapter parsing (on-chain data decoding, financial calculations) have no dedicated unit tests.
- **Remediation:** Add unit tests for yield resolution and critical reserve adapters (Tether, Circle, MakerDAO/Sky, Ethena).

**Q-014 | O(n) Array Lookup in Hot Loop**
- **Location:** `worker/src/lib/chain-registry.ts`, `getChainRpc()`, lines 140-142
- **Description:** `Array.find()` called per event during blacklist/mint-burn sync (thousands of calls). Array is small (~12 entries) but unnecessarily linear.
- **Remediation:** Return a `Map<string, ChainRpcConfig>` from `buildChainRpcs()`.

**Q-015 | `fetchWithRetry` Returns `null` for Total Failure**
- **Location:** `worker/src/lib/fetch-retry.ts`
- **Description:** `null` return conflates "no response" with "bad response." Every caller must null-check.
- **Remediation:** Consider throwing `FetchExhaustedError` or document null semantics prominently.

**Q-016 | Silent Coverage Guard Degradation on D1 Query Failure**
- **Location:** `worker/src/cron/dex-liquidity/orchestrator.ts`, lines 169-196
- **Description:** Four D1 queries for coverage comparison use `.catch(() => null)`. If `previousCoverageRow` fails, `previousCoverage` becomes 0, effectively disabling the safety check.
- **Remediation:** Log warnings on query failure. Set `previousCoverage` to a safe high value rather than 0.

**Q-017 | Public Health Endpoint Exposes Infrastructure Topology**
- **Location:** `worker/src/api/health.ts`, `worker/src/handlers/http.ts:101-113`
- **Description:** `/api/health` is public and returns circuit breaker states, cron job names, and data freshness metrics.
- **Remediation:** Low risk for a public analytics dashboard. Optionally reduce verbosity to status code + top-level health only.

**Q-018 | Unprotected `JSON.parse` in Daily Digest**
- **Location:** `worker/src/cron/daily-digest.ts:441`
- **Description:** `JSON.parse(currentPsiSource.components)` called without try/catch. Malformed JSON in D1 would crash entire digest generation.
- **Remediation:** Wrap in try/catch with fallback setting `stabilityIndex` to null.

**Q-019 | `safeParse` Name Collision with Zod Convention**
- **Location:** `worker/src/lib/api-utils.ts:160-163`
- **Description:** Local `safeParse<T>(json, fallback)` does JSON parsing, not schema validation. Conflicts with Zod's `safeParse` naming convention.
- **Remediation:** Rename to `safeJsonParse` or `jsonParseOr`.

**Q-020 | Silent API Contract Change Detection**
- **Location:** `worker/src/cron/sync-stablecoins.ts:432`
- **Description:** If DefiLlama response shape changes, `peggedAssets` becomes `undefined`. The fallback path triggers correctly but no log distinguishes "API contract change" from "API returned zero assets."
- **Remediation:** Add distinct warning when `peggedAssets` is `undefined` (vs empty array).

#### Positive Observations (Code Quality)

1. **Comprehensive test coverage:** Nearly every cron job and API handler has a test file. Unusually high test-to-implementation ratio.
2. **SQL injection prevention:** All D1 queries use parameterized binds. String interpolation in SQL guarded by allowlist validation.
3. **Zero empty catch blocks:** Every catch logs, returns degraded result, or re-throws.
4. **Circuit breaker discipline:** Applied uniformly across 10+ external data sources with `shouldAttemptFetch()`.
5. **Abort signal propagation:** Every cron job threads `AbortSignal` through its call chain.
6. **Zod at cache boundaries:** Critical stablecoins cache write validates before persisting.
7. **Security headers:** HTTP handler applies `X-Content-Type-Options`, `HSTS`, `CSP`, `Referrer-Policy`.
8. **Input validation on public endpoints:** Feedback uses Zod; query params validated with `parseIntParam` + min/max bounds.

---

### Pillar C: Sustainability & Maintainability

#### Medium Impact

**S-001 | Global Mutable State Pattern in Worker**
- **Category:** Architecture
- **Location:** `worker/src/lib/alerts.ts:7`, `coingecko.ts:10`, `coingecko-onchain.ts:16`, `chain-registry.ts:132`, `rate-limit.ts:25-28`
- **Description:** Module-level `let` variables with init functions. While correctly re-initialized per-request, the pattern is fragile for new contributors. Rate-limit state intentionally persists across requests but breaks under multi-isolate routing.
- **Remediation:** Pass configuration through explicit context object. Document single-isolate assumption.

**S-002 | Stablecoin Metadata Monolith (4,890 Lines)**
- **Category:** Modularity
- **Location:** `shared/lib/stablecoins.ts` (157 entries, imported by 62 modules)
- **Description:** All tracked stablecoin metadata in a single file. Every addition touches this file, creating merge conflicts in parallel worktree branches. `StablecoinOpts` factory has 34 optional fields.
- **Remediation:** Split by peg currency or market-cap tier. Alternatively, extract dense config objects (`liveReservesConfig`, `reserves`, `contracts`) into per-coin satellite files.

**S-003 | RouteContext Growing Bag of Optionals**
- **Category:** Architecture
- **Location:** `worker/src/route-registry.ts:60-74` (12 fields, most optional)
- **Description:** Every feature integration adds optional fields to `RouteContext`. All fields populated for every request. The `request!` non-null assertion on line 188 is a symptom.
- **Remediation:** Split into core context + per-domain option bags.

**S-006 | No Automated Dependency Update Pipeline**
- **Category:** Dependencies
- **Location:** Project root (no `.github/dependabot.yml` or Renovate config)
- **Description:** Lean dependency set (17 runtime, 13 dev) but no automated PR creation for security patches. Relies on `npm run audit:deps` reactively.
- **Remediation:** Add Dependabot or Renovate config for security-patch PRs.

**S-009 | No SAST Security Scanning in CI**
- **Category:** Build/Deploy
- **Location:** `.github/workflows/validate-ci.yml`
- **Description:** Comprehensive CI (lint, boundary check, migration replay, tests, coverage ratchet, smoke tests) but no CodeQL, Semgrep, or Snyk. `eslint-plugin-security` provides basic detection only.
- **Remediation:** Add CodeQL or Semgrep to PR checks. Free for open-source.

**S-013 | Cron Schedule Density Approaching Limits**
- **Category:** Scalability
- **Location:** `worker/wrangler.toml:33-44`, `shared/lib/cron-jobs.ts`
- **Description:** 10 of 15 available cron trigger expressions used, with 24 runtime jobs across them. Limited room for new features with unique cadences. Each slot shares a single 6-connection pool.
- **Remediation:** Document capacity plan. Consider whether a second worker is needed for high-frequency vs low-frequency separation.

#### Low Impact

**S-004 | Frontend Cron Interval Constants Diverge from Shared Definitions**
- **Category:** Modularity
- **Location:** `src/lib/cron-intervals.ts` vs `shared/lib/cron-jobs.ts`
- **Description:** Frontend defines own `CRON_15MIN`, `CRON_30MIN` constants that must be manually kept in sync with shared definitions.
- **Remediation:** Derive frontend polling intervals from `CRON_INTERVALS[jobName] * 1000`.

**S-005 | Missing `OPENEXCHANGERATES_API_KEY` from `.env.example`**
- **Category:** Configuration
- **Location:** `.env.example` (missing), `worker/src/lib/env.ts:37` (declared)
- **Remediation:** Add to `.env.example` in the "Optional upstream integration secrets" section.

**S-007 | `SELECT *` in 8 Production Files**
- **Category:** Scalability
- **Location:** `worker/src/api/peg-summary.ts:89`, `audit-depeg-history.ts:84`, `status.ts:747`, `discovery.ts:45`, `detect-depegs.ts:87`, `confirm-pending-depegs.ts:60`, `sync-yield-data.ts:844`, `telegram-webhook.ts:99`
- **Description:** Couples query results to full table schema. Column additions become potential breaking changes.
- **Remediation:** Replace with explicit column lists.

**S-011 | Dead Stablecoin Registry Unbounded Growth**
- **Category:** Scalability
- **Location:** `shared/lib/dead-stablecoins.ts` (1,191 lines, 81 entries)
- **Description:** Cemetery registry grows monotonically, bundled into frontend static export.
- **Remediation:** Fine for now. Consider D1 table + API if it reaches hundreds.

**S-012 | 74 D1 Migrations Without Squash Strategy**
- **Category:** Scalability
- **Location:** `worker/migrations/` (74 files replayed in CI)
- **Remediation:** Plan a one-time squash at ~150 migrations. Document procedure in `MANIFEST.md`.

**S-015 | Route Registry Lacks Reverse Validation**
- **Category:** Modularity
- **Location:** `worker/src/route-registry.ts:266-270`
- **Description:** Validates handlers have endpoint definitions but not the reverse. A declared-but-unimplemented route would be silently ignored.
- **Remediation:** Add symmetric validation for endpoints without handlers.

**S-016 | Worker and Frontend TypeScript Target Divergence**
- **Category:** Build/Deploy
- **Location:** `tsconfig.json` (ES2017) vs `worker/tsconfig.json` (ES2021)
- **Description:** Shared modules must be ES2017-compatible but nothing validates this constraint.
- **Remediation:** Document ES2017 floor in `docs/architecture.md`. Consider bumping root to ES2021.

**S-018 | Pre-Push Hook is Opt-In**
- **Category:** Build/Deploy
- **Location:** `.githooks/pre-push`
- **Description:** Requires manual `git config core.hooksPath .githooks`. CI catches issues but wastes a run.
- **Remediation:** Use `simple-git-hooks` or `lefthook` to auto-install on `npm install`.

#### Positive Observations (Sustainability)

1. **S-008: Zero boundary violations.** The three-layer boundary (src/shared/worker) is enforced via ESLint rules, CI scripts, and tsconfig exclusions. Zero misuse across 355+ import sites.
2. **S-010: Documentation is exceptionally comprehensive.** 52 docs files covering every subsystem. Zero TODO/FIXME/HACK comments in the entire codebase.
3. **S-014: Version tracking pattern is exemplary.** `createMethodologyVersion()` factory across 10 scoring systems enables independent rollbacks and audit trails.
4. **S-017: Single `any` in 112K LOC.** TypeScript strict mode enabled in both tsconfigs with exceptional type discipline.

---

## 3. Cross-Cutting Concerns

These findings span two or more pillars:

### CC-001: `syncStablecoins` Complexity + Duplication Compound Issue
- **Connects:** Q-002 (Complexity), Q-009 (Naming), Q-011 (Duplication), R-004-style
- **Description:** The most critical data pipeline has two problems compounding each other: the main function is 540 lines of interleaved concerns (Quality), AND the fallback path duplicates substantial portions of that pipeline (Redundancy). Changes to validation or enrichment logic must be made in both places, and the complexity of each path makes it hard to verify they remain consistent.
- **Priority:** High. This is the single highest-impact remediation opportunity.

### CC-002: Module-Level Mutable State (Architecture + Quality + Sustainability)
- **Connects:** Q-004 (Quality), S-001 (Sustainability)
- **Description:** The same finding surfaces from both the quality and sustainability perspectives. It's a concurrency risk (Quality) AND a team-scaling risk (Sustainability) -- new contributors are likely to extend the pattern incorrectly.
- **Priority:** Medium. Address during any refactoring of the worker initialization flow.

### CC-003: Missing Runtime Validation at System Boundaries (Quality + Sustainability)
- **Connects:** Q-003 (Type Safety), Q-008 (API Response Shapes), S-007 (SELECT *)
- **Description:** Three related findings about data integrity at boundaries: `JSON.parse as T` without validation, external API responses cast without checks, and `SELECT *` coupling to full schemas. All three create silent failure modes when schemas evolve.
- **Priority:** Medium-High. Apply Zod schemas progressively, starting with external API boundaries.

### CC-004: Freshness Threshold Fragmentation (Redundancy + Sustainability)
- **Connects:** R-013 (Overlapping thresholds), S-004 (Frontend cron interval divergence)
- **Description:** Data freshness evaluation is implemented in 4+ layers with independently defined thresholds. Frontend polling intervals are also disconnected from shared cron definitions. Changes to cron intervals require manual updates in multiple places.
- **Priority:** Low. Document relationships, then progressively consolidate.

### CC-005: Worker File Size and Responsibility (Quality + Redundancy)
- **Connects:** Q-007 (sync-blacklist 1,261 lines), Q-006 (detect-depegs complexity)
- **Description:** The largest worker files combine multiple provider-specific implementations in single files. The same DEX validation conditional is repeated three times in detect-depegs.
- **Priority:** Medium. Extract provider-specific logic into dedicated modules.

---

## 4. Prioritized Remediation Roadmap

### Phase 1: Quick Wins (1-2 days, minimal risk)

| # | Finding | Action | Files | Effort |
|---|---------|--------|-------|--------|
| 1 | R-001 | Export `buildFreshnessMeta` from `api-utils.ts`, import in `cache-handlers.ts` | 2 files | Small |
| 2 | R-002 | Replace inline USD formatting with `formatCurrency` from `@shared/lib/format` | 3 files | Small |
| 3 | R-003 | Import hex color maps from `shared/lib/` in OG templates, remove local copies | 3 files | Small |
| 4 | R-005 | Remove unused `REDEMPTION_BACKSTOP_CHANGELOG` export | 1 file | Small |
| 5 | R-014 | Remove `export` from `COIN_FLOW_COMPOSITE_STATE_VALUES` | 1 file | Small |
| 6 | R-007 | Rename status `formatDuration` to `formatLatency` | 1 file + consumers | Small |
| 7 | R-010 | Delete `cron-schedule.ts` re-export barrel, update 4 imports | 5 files | Small |
| 8 | Q-012 | Remove redundant `!` assertion on pre-filtered price values | 1 file | Small |
| 9 | Q-019 | Rename `safeParse` to `safeJsonParse` in `api-utils.ts` | 1 file + consumers | Small |
| 10 | S-005 | Add `OPENEXCHANGERATES_API_KEY` to `.env.example` | 1 file | Small |
| 11 | Q-010 | Add `AbortSignal.timeout(5000)` to `sendAlert()` fetch | 1 file | Small |
| 12 | Q-018 | Wrap `JSON.parse(components)` in try/catch in `daily-digest.ts` | 1 file | Small |
| 13 | Q-020 | Add distinct warning for undefined vs empty `peggedAssets` | 1 file | Small |

### Phase 2: Targeted Refactoring (1-2 weeks)

| # | Finding | Action | Files | Effort | Dependencies |
|---|---------|--------|-------|--------|-------------|
| 1 | R-004 | Refactor stablecoin + flow table sort to use `createTableComparator` | 3 files | Medium | None |
| 2 | Q-005 | Per-pass try/catch in `enrichMissingPrices()` with `failedPasses` reporting | 1 file | Medium | None |
| 3 | Q-006 | Extract depeg detection helpers (`handleNewEvent`, `isDexConfirmed`, etc.) | 1 file | Medium | None |
| 4 | Q-016 | Fix silent coverage guard degradation on D1 query failure | 1 file | Small | None |
| 5 | R-011 | Replace inline `.toFixed()` with shared formatters in user-facing outputs | ~8 files | Medium | R-002 |
| 6 | S-007 | Replace `SELECT *` with explicit column lists | 8 files | Medium | None |
| 7 | Q-003 | Add Zod schemas for top-priority JSON parse sites (yield, liquidity, digest) | ~6 files | Medium | None |
| 8 | S-004 | Derive frontend polling from `CRON_INTERVALS[jobName]` | 2 files | Small | None |
| 9 | S-015 | Add reverse route-registry validation (endpoints without handlers) | 1 file | Small | None |
| 10 | S-018 | Add `simple-git-hooks` for auto-install of pre-push hook | 2 files | Small | None |

### Phase 3: Structural Improvements (2-4 weeks)

| # | Finding | Action | Files | Effort | Dependencies |
|---|---------|--------|-------|--------|-------------|
| 1 | CC-001 | Extract `postEnrichmentPipeline()` shared by main sync + fallback | 3 files | Large | Phase 2 #2 |
| 2 | Q-002 | Decompose `syncStablecoins` into named pipeline stages | 4-5 files | Large | Phase 3 #1 |
| 3 | Q-007 | Extract `balance-providers.ts` from `sync-blacklist.ts` | 2 files | Medium | None |
| 4 | CC-002 | Replace module-level mutable state with per-request context | 6 files | Medium | None |
| 5 | S-003 | Split `RouteContext` into core + per-domain option bags | 5+ files | Medium | Phase 3 #4 |
| 6 | Q-008 | Add Zod schemas for all external API response boundaries | ~10 files | Medium | Phase 2 #7 |
| 7 | S-006 | Add Dependabot/Renovate configuration | 1 file | Small | None |
| 8 | S-009 | Add CodeQL/Semgrep to CI pipeline | 1-2 files | Small | None |
| 9 | R-009 | Consolidate API hooks into consistent organization | 5 files | Medium | None |

### Phase 4: Strategic Overhauls (1-2 months)

| # | Finding | Action | Files | Effort | Dependencies |
|---|---------|--------|-------|--------|-------------|
| 1 | Q-001 | Implement JWT signature verification for admin auth | 2-3 files | Medium | None |
| 2 | S-002 | Split stablecoin metadata monolith into per-category files | 10+ files | Large | None |
| 3 | S-013 | Document cron capacity plan; evaluate second worker | Docs + config | Medium | None |
| 4 | Q-013 | Add unit tests for reserve adapters and yield resolution | 10+ new files | Large | None |
| 5 | R-013 | Consolidate freshness thresholds into shared definitions | 5 files | Medium | Phase 2 #8 |

---

## 5. Appendices

### 5.A File-by-File Finding Index

| File | Findings |
|------|----------|
| `shared/lib/format.ts` | R-002, R-007, R-011, R-015 (canonical source) |
| `shared/lib/mint-burn-signals.ts` | R-014 |
| `shared/lib/redemption-backstop-version.ts` | R-005 |
| `shared/lib/stablecoins.ts` | S-002 |
| `shared/lib/status-thresholds.ts` | R-013 |
| `shared/lib/tracked-stablecoin-utils.ts` | R-006 |
| `shared/lib/cron-jobs.ts` | S-004, S-013 |
| `shared/lib/classification.ts` | R-003 (canonical source) |
| `shared/lib/psi-colors.ts` | R-003 (canonical source) |
| `shared/lib/report-cards.ts` | R-003 (canonical source) |
| `src/components/stablecoin-table-logic.ts` | R-004 |
| `src/components/flow-table-logic.ts` | R-004 |
| `src/components/status/format.ts` | R-007 |
| `src/hooks/api-hooks.ts` | R-009 |
| `src/hooks/use-stablecoins.ts` | R-009 |
| `src/lib/cron-intervals.ts` | S-004 |
| `src/lib/data-health.ts` | R-013 |
| `src/lib/data-health-config.ts` | R-013 |
| `worker/src/api/cache-handlers.ts` | R-001 |
| `worker/src/api/dex-liquidity.ts` | Q-003 |
| `worker/src/api/feedback.ts` | R-002 |
| `worker/src/api/health.ts` | Q-017 |
| `worker/src/api/peg-summary.ts` | S-007 |
| `worker/src/api/status.ts` | S-007 |
| `worker/src/api/yield-history.ts` | Q-003 |
| `worker/src/cron/daily-digest.ts` | Q-003, Q-018 |
| `worker/src/cron/detect-depegs.ts` | Q-006, S-007 |
| `worker/src/cron/dex-liquidity/fetch-fallbacks.ts` | R-015 |
| `worker/src/cron/dex-liquidity/orchestrator.ts` | Q-016 |
| `worker/src/cron/enrich-prices.ts` | Q-005, Q-008, Q-012 |
| `worker/src/cron/sync-blacklist.ts` | Q-007 |
| `worker/src/cron/sync-stablecoins.ts` | Q-002, Q-009, Q-011, Q-020 |
| `worker/src/handlers/http.ts` | Q-017 |
| `worker/src/lib/alerts.ts` | Q-004, Q-010 |
| `worker/src/lib/api-utils.ts` | R-001, Q-019 |
| `worker/src/lib/auth.ts` | Q-001 |
| `worker/src/lib/chain-registry.ts` | Q-004, Q-014 |
| `worker/src/lib/coingecko.ts` | Q-004 |
| `worker/src/lib/coingecko-onchain.ts` | Q-004 |
| `worker/src/lib/cron-schedule.ts` | R-010 |
| `worker/src/lib/fetch-retry.ts` | Q-015 |
| `worker/src/lib/og-templates/stablecoin-card.tsx` | R-002, R-003 |
| `worker/src/lib/og-templates/stability-index-card.tsx` | R-003 |
| `worker/src/lib/og-templates/depeg-card.tsx` | R-003 |
| `worker/src/lib/rate-limit.ts` | Q-004, S-001 |
| `worker/src/lib/telegram-alerts.ts` | R-011, R-015 |
| `worker/src/route-registry.ts` | S-003, S-015 |
| `worker/wrangler.toml` | S-013 |
| `.env.example` | S-005 |
| `.github/workflows/validate-ci.yml` | S-009 |

### 5.B Dependency Audit Summary

| Package | Layer | Status | Notes |
|---------|-------|--------|-------|
| `next` 16.1.6 | Frontend | Current | Latest Next.js major |
| `react` 19.2.4 | Frontend | Current | Latest React major |
| `@tanstack/react-query` 5.90.21 | Frontend | Current | |
| `recharts` 3.8.0 | Frontend | Current | |
| `zod` 4.3.6 | Shared | Current | Latest Zod major |
| `tailwindcss` 4.2.1 | Frontend dev | Current | v4 |
| `typescript` 5.9.0 | Both | Current | |
| `vitest` 4.1.0 | Dev | Current | |
| `wrangler` 4.73.0 | Worker dev | Current | |
| `satori` 0.25.0 | Worker | Current | OG image generation |
| `@cf-wasm/resvg` 0.3.3 | Worker | Current | SVG-to-PNG |
| `d3-force` 3.0.0 | Frontend | Current | Dependency graph |
| `html-to-image` 1.11.13 | Frontend | Current | Share image export |
| `lucide-react` 0.577.0 | Frontend | Current | Icon library |
| `clsx` 2.1.1 | Frontend | Current | Class joining (shadcn pattern) |
| `tailwind-merge` 3.5.0 | Frontend | Current | Tailwind conflict resolution |
| `class-variance-authority` 0.7.1 | Frontend | Current | Variant management (shadcn) |
| `next-themes` 0.4.6 | Frontend | Current | Theme switching |

**Verdict:** All dependencies are on current major versions. No abandoned or deprecated packages. Dependency count is lean (17 runtime) for the feature surface. No redundant dependencies identified (clsx + tailwind-merge is standard shadcn pattern).

### 5.C Glossary

| Term | Definition |
|------|-----------|
| **Circuit breaker** | Pattern preventing cascade failures by tracking consecutive failures per external source and short-circuiting requests when a threshold is reached |
| **CAS guard** | Compare-And-Swap: `setCacheIfNewer` only writes if the incoming timestamp is newer than the stored one |
| **Coverage guard** | Safety check preventing DEX liquidity sync from persisting results that cover significantly fewer coins than the previous run |
| **D1** | Cloudflare's serverless SQLite database |
| **DEWS** | Daily Early Warning System -- 8-signal composite stress score for stablecoins |
| **FIS** | Flow Intensity Score -- mint/burn volume magnitude metric |
| **PSI** | Pharos Stability Index -- ecosystem-wide health score |
| **PYS** | Pharos Yield Score -- risk-adjusted yield ranking metric |
| **Gradual deployments** | Cloudflare Workers feature for traffic splitting between versions |
| **Isolate** | V8 isolate context in Cloudflare Workers; may be reused across requests |
| **SRP** | Single Responsibility Principle |
| **SAST** | Static Application Security Testing |
