# Comprehensive Codebase Audit -- Pharos Stablecoin Dashboard

**Date:** 2026-04-06
**Scope:** Full codebase (`shared/`, `src/`, `worker/`, `functions/`, configuration, CI/CD)
**Method:** Three-agent parallel analysis (Redundancy, Code Quality, Sustainability)
**Build baseline:** Clean pass, zero errors/warnings

---

## 1. Executive Summary

### Finding Counts

| Pillar | Critical | High | Medium | Low | Info/Positive | Total |
|--------|----------|------|--------|-----|---------------|-------|
| Redundancy | 0 | 0 | 6 | 8 | 1 | 15 |
| Code Quality | 0 | 0 | 4 | 5 | 4 | 13 |
| Sustainability | 0 | 3 | 8 | 6 | 0 | 17 |
| **Total** | **0** | **3** | **18** | **19** | **5** | **45** |

### Health Ratings

| Pillar | Score | Justification |
|--------|-------|---------------|
| **Redundancy** | **8 / 10** | Markedly improved since the March 2026 audit. The `shared/lib/` boundary is effective at preventing cross-layer duplication. Remaining debt is scattered inline formatting patterns (~20 sites) and a handful of thin wrappers. Zero redundant dependencies. |
| **Code Quality** | **8.5 / 10** | No Critical or High findings. SQL injection is systematically prevented via parameterized queries and allowlisted identifiers. Auth uses timing-safe comparisons and CF Access JWT verification. Zod validates API responses at runtime. Zero `@ts-ignore` directives, zero production `as any`. 10,000+ test assertions. Medium findings are limited to monolithic-function complexity in a few hotspots. |
| **Sustainability** | **7.5 / 10** | Excellent CI/CD (20+ automated checks, hotspot ratchets, rollback automation, doc-sync verification). Primary risks are forward-looking: static-export build scaling, cron-trigger ceiling, single-blob D1 cache approaching row-size limits. A 48 MB dependency (`viem`) serves only 3 function calls. |

### Technical Debt Profile

Approximately **8-10%** of the codebase is touched by significant findings. The vast majority of files are clean, well-typed, and well-tested. Debt is concentrated in:
- ~20 scattered inline formatting sites (formatting DRY debt)
- 5-6 monolithic files in the 600-1000 line range (complexity)
- 3 forward-looking scalability ceilings (static export, cron triggers, D1 blob)

### Top 5 Most Critical Findings

| # | ID | Pillar | Finding | Why It Matters |
|---|-----|--------|---------|----------------|
| 1 | S-001 | Sustainability | Static-export build + Zod-on-import scales linearly with tracked coins | Build time and memory will degrade as the tracked set grows toward 300-500 coins |
| 2 | S-010 | Sustainability | D1 cache stores the entire stablecoins payload as a single JSON blob | Approaching D1's 2 MB row-size limit as per-coin data gets richer |
| 3 | S-004 | Sustainability | `viem` is a 48 MB dependency used by only 3 function calls | Significant install-time and bundle-size cost for narrow usage |
| 4 | R-003 | Redundancy | ~20+ sites still inline `${value.toFixed(N)}%` instead of using shared formatters | Largest remaining formatting debt; inconsistent display and maintenance burden |
| 5 | Q-001 | Quality | `handleAggregate` is a 360-line monolithic function with 11 parallel D1 queries | High cyclomatic complexity resists testing and modification |

---

## 2. Findings by Pillar

### Pillar A -- Redundancy

#### R-001 | Medium | Duplication -- Proxy helper duplication across Pages Functions

**Files:**
- `functions/api/admin/[[path]].ts` lines 38-46, 63-82, 84-101, 103-111
- `functions/_site-data/[[path]].ts` lines 48-57, 74-92, 94-108, 122-130

**Description:** Both proxy functions define identical `jsonError`, `summarizeFetchError`, and structurally identical `buildUpstreamHeaders`/`buildProxyResponse`. `summarizeFetchError` is byte-for-byte identical.

**Consolidation:** Extract `jsonError` and `summarizeFetchError` into `functions/lib/proxy-utils.ts`. Parameterize `buildUpstreamHeaders` and `buildProxyResponse` via header allowlists.
**Effort:** Small

---

#### R-002 | Medium | Duplication -- Inline `await res.body?.cancel()` vs centralized helpers

**Files:**
- `worker/src/lib/response-body.ts` (centralized `cancelResponseBodyQuietly` and `drainResponseBody`)
- 13+ inline occurrences: `worker/src/cron/reserve-adapters/helpers.ts` (4 sites), `worker/src/lib/fetch-retry.ts` (2), `worker/src/lib/evm-logs.ts` (2), `worker/src/cron/blacklist/tron-source.ts`, `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts`, `worker/src/api/backfill-depegs.ts`, `worker/src/lib/alchemy-logs.ts`

**Description:** Well-designed `cancelResponseBodyQuietly` and `drainResponseBody` helpers exist but 13+ call sites still use raw `await res.body?.cancel()`. The helpers add proper try/catch and null guards.

**Consolidation:** Mechanical replacement of inline calls with `cancelResponseBodyQuietly(res)` imports.
**Effort:** Small

---

#### R-003 | Medium | Duplication -- Remaining inline percentage formatting (~20+ sites)

**Files (representative):**
- `src/components/comparison-table.tsx` lines 209, 315
- `src/components/dews-detail.tsx` line 54
- `src/components/yield-detail-section.tsx` line 431
- `src/components/yield-scatter-plot.tsx` lines 373-374
- `src/components/yield-leaderboard-table-row.tsx` line 208
- `src/components/status/data-quality-cards.tsx` lines 64, 83
- `src/components/status/price-source-health.tsx` line 63
- `src/components/status/mint-burn-reconciliation.tsx` line 167
- `src/lib/chain-ui.ts` line 7
- `src/lib/treasury-table-utils.ts` line 45
- `src/app/coverage/coverage-feature-snapshot.tsx` line 74
- `src/hooks/use-compare-share-actions.ts` line 82

**Description:** Despite `formatPercent` and `formatSignedPercent` existing in `shared/lib/format.ts`, ~20+ sites still construct `${value.toFixed(N)}%` inline. Many compute `value * 100` before formatting.

**Consolidation:** Add `formatPercentFromRatio(ratio, decimals)` to shared format (auto-multiplies by 100). Systematically replace inline patterns. This is the largest remaining formatting debt.
**Effort:** Medium

---

#### R-004 | Medium | Duplication -- Duplicate test coverage for shared format functions

**Files:**
- `shared/lib/__tests__/format.test.ts` (canonical)
- `src/lib/__tests__/format.test.ts` (duplicate tests for 5 functions)

**Description:** Five functions (`formatCompactCount`, `formatTrackingSpanDays`, `formatTrackingSpanSeconds`, `formatNativePrice`, `formatDeathDate`) are tested in both test files. The frontend tests import from `@shared/lib/format` -- truly redundant assertions.

**Consolidation:** Remove duplicated tests from `src/lib/__tests__/format.test.ts`.
**Effort:** Small

---

#### R-005 | Medium | Duplication -- Yield chart date formatters overlap with shared `formatChartDate`

**Files:**
- `shared/lib/format.ts` lines 264-292 (`formatChartDate` with 6 presets)
- `src/components/yield-history-chart-model.ts` lines 73-89 (`formatAxisDate`, `formatTooltipDate`)

**Description:** Yield chart defines its own date formatters using cached `Intl.DateTimeFormat` instances while the rest of the codebase uses `formatChartDate`. Output formats are equivalent.

**Consolidation:** Map yield chart formatters to the shared `formatChartDate` presets.
**Effort:** Small

---

#### R-006 | Medium | Redundant Abstraction -- `getAdapterTimeout` is a no-op wrapper

**Files:**
- `worker/src/cron/reserve-adapters/helpers.ts` lines 141-144 (definition)
- 30+ consumer files across reserve adapters

**Description:** `getAdapterTimeout(config, fallbackMs)` explicitly discards `config` (`void config`) and always returns `fallbackMs`. Every call site passes a literal fallback. Pure indirection with no configurability.

**Consolidation:** Replace all `getAdapterTimeout(config, N)` calls with the literal `N`. Remove the function.
**Effort:** Small (mechanical find-replace across 30+ sites)

---

#### R-007 | Low | Redundant Abstraction -- `formatHealthAge` one-liner with single consumer

**Files:**
- `src/lib/data-health.ts` lines 165-168 (definition)
- `src/components/data-health-banner.tsx` line 51 (sole consumer)

**Description:** `formatHealthAge(ms)` is `return formatElapsedSeconds(ms / 1000)`. One consumer. Adds no value.

**Consolidation:** Inline `formatElapsedSeconds(worstAge / 1000)` at the call site. Remove `formatHealthAge`.
**Effort:** Small

---

#### R-008 | Low | Redundant Abstraction -- `formatTreasuryPct` duplicates `formatPercent`

**Files:**
- `src/lib/treasury-table-utils.ts` lines 44-45
- `shared/lib/format.ts` lines 238-239 (`formatPercent`)

**Description:** `formatTreasuryPct(value)` returns `value == null ? "N/A" : ${value.toFixed(1)}%` -- identical to `formatPercent(value, 1)` except the null return is "N/A" vs "-".

**Consolidation:** Replace with `formatPercent(value, 1)` or unify null-return convention.
**Effort:** Small

---

#### R-009 | Low | Redundant Abstraction -- `formatRatioPct` overlaps with `formatSignedPercent`

**Files:**
- `src/lib/chain-ui.ts` lines 4-8
- `shared/lib/format.ts` lines 243-247

**Description:** `formatRatioPct(value)` computes `value * 100` then formats as signed percent -- equivalent to `formatSignedPercent(value * 100, 2)`.

**Consolidation:** Replace with `formatSignedPercent(value * 100, 2)` or the proposed `formatPercentFromRatio`.
**Effort:** Small

---

#### R-010 | Low | Redundant Abstraction -- `encodeStablecoinUrlToken` identity function (deferred)

**Files:** `src/lib/stablecoin-url-codec.ts` lines 20-22

**Description:** Returns its input unchanged. Flagged in prior audit as intentional future-proofing for ticker-issuer migration.

**Consolidation:** Keep deferred. Re-evaluate if migration plan is abandoned.
**Effort:** N/A

---

#### R-011 | Low | Overlapping Responsibility -- `isKnownCoinId` vs `REGISTRY_BY_ID.has()` scope ambiguity

**Files:**
- `shared/lib/validate-coin-id.ts` lines 1-8 (excludes shadow stablecoins)
- `shared/lib/stablecoin-id-registry.ts` line 79 (includes shadow stablecoins)

**Description:** Two ID validation paths with subtly different scope. The difference is not documented at call sites.

**Consolidation:** Add JSDoc clarifying scope. Consider renaming to `isTrackedCoinId` for clarity.
**Effort:** Small

---

#### R-012 | Low | Overlapping Responsibility -- `formatTimestampSeconds/Ms` overlap with inline `toLocaleString`

**Files:**
- `src/lib/status-dashboard-model.ts` lines 153-161
- 5+ status components with inline `new Date(...).toLocaleString()`

**Description:** Two one-liner helpers wrap the same pattern other components do inline. Status-dashboard-specific.

**Consolidation:** Fine as local helpers. Not worth extracting to shared.
**Effort:** Small

---

#### R-013 | Low | Dead Code -- `isAmbiguousStablecoinSymbol` exported but test-only

**Files:**
- `src/lib/stablecoin-url-codec.ts` lines 45-48 (export)
- `src/lib/__tests__/stablecoin-url-codec.test.ts` (sole consumer)

**Description:** Exported public function with no production consumers.

**Consolidation:** Remove the export or mark as test-only.
**Effort:** Small

---

#### R-014 | Low | Dead Code -- `formatChartPercent` has only one consumer

**Files:** `shared/lib/format.ts` lines 251-254

**Description:** Used only by `src/components/comparison-chart.tsx`. Serves as a semantic alias for chart-axis context.

**Consolidation:** Keep -- active consumer exists.
**Effort:** N/A

---

#### R-015 | Info | Redundant Dependencies -- None found

All `dependencies` in both `package.json` files have active production import sites. No orphaned packages.

---

### Pillar B -- Code Quality

#### Q-001 | Medium | Complexity -- `handleAggregate` is a 360-line monolithic function

**Location:** `worker/src/api/mint-burn-flows.ts`, `handleAggregate()`, lines 102-463

**Description:** Single function issues 11 parallel D1 queries, builds baseline maps, computes FIS/gauge scores, constructs flight-to-quality classification, assembles per-coin summaries, and serializes the response. Inline type literal for the `coins` array spans 40 lines.

**Remediation:** Extract the inline coin type into a named `CoinFlowSummary` interface. Split into `fetchAggregateData()`, `buildCoinSummaries()`, and `buildAggregateResponse()` for independent testability.
**Effort:** Medium

---

#### Q-002 | Medium | Design Pattern -- `homepage-client.tsx` mixes UI with multiple data concerns

**Location:** `src/components/homepage-client.tsx` (608 lines)

**Description:** Orchestrates 5+ data hooks, renders 80+ lines of skeleton placeholders, filter bars, market highlights, stablecoin table, peg distribution, and upcoming stablecoins. SRP tension between layout orchestration, data aggregation, and loading state rendering.

**Remediation:** Extract `ChartSkeleton`/`SectionSkeleton` into `homepage-skeletons.tsx`. Extract `PegDistributionGrid` into its own component. Target: under 400 lines.
**Effort:** Small

---

#### Q-003 | Medium | Error Handling -- Silent catch blocks in worker/cron code paths

**Location:**
- `worker/src/cron/sync-stablecoin-charts.ts:86`
- `worker/src/lib/alchemy-logs.ts` (lines 94, 108, 167, 188, 209)
- `worker/src/cron/dex-liquidity/scoring.ts:119`
- `worker/src/cron/dex-liquidity/challenger-persistence.ts:156`

**Description:** 50+ bare `catch { }` blocks. Many are documented with intent comments, but several (especially in alchemy-logs -- 5 consecutive bare catches) have no explanation. Systematic failures become invisible.

**Remediation:** Add explanatory comments to undocumented catch blocks. Add `console.debug` or metric increments to the Alchemy module so systematic failures become observable.
**Effort:** Small

---

#### Q-004 | Medium | Complexity -- `enrich-prices-passes.ts` accumulated complexity

**Location:** `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts` (806 lines)

**Description:** Multi-pass price enrichment pipeline handling CoinGecko, Chainlink, Pyth, RedStone, Curve, and GeckoTerminal. File is well-structured with named pass functions but has accumulated deep conditional logic.

**Remediation:** Informational. Current structure is sound. Future price source additions should evaluate per-source module extraction.
**Effort:** Large (if acted on)

---

#### Q-005 | Low | Type Safety -- `safeJsonParse` uses unconstrained generic type assertion

**Location:** `worker/src/lib/api-utils.ts`, `safeJsonParse()`, line 220

**Description:** Returns `JSON.parse(json) as T` without runtime validation. Doc comment warns against canonical usage, but the generic signature provides no compile-time enforcement.

**Remediation:** Appropriately documented. Consider narrowing return to `unknown` for additional safety, or adding a linter rule flagging new call sites. No immediate change needed.
**Effort:** Small

---

#### Q-006 | Low | Design Pattern -- `fetch-primary.ts` as DEX liquidity "god module"

**Location:** `worker/src/cron/dex-liquidity/fetch-primary.ts` (798 lines)

**Description:** Fetches from DefiLlama, Curve, UniV3, Aerodrome, and CoinGecko. Connection management is correct per CLAUDE.md guidance. Approaching the threshold where per-protocol extraction would help.

**Remediation:** Monitor. If further sources are added, extract per-protocol fetch modules.
**Effort:** Medium (if acted on)

---

#### Q-007 | Low | Design Pattern -- Module-level mutable state in `rate-limit.ts`

**Location:** `worker/src/lib/rate-limit.ts`, lines 19-25

**Description:** 7 module-level `let` variables for per-isolate state. Pattern is correct for Cloudflare Workers model but fragile due to implicit `ctx.waitUntil` dependencies.

**Remediation:** Document isolate-scope semantics at module top. The `flushPendingPrunes()` integration is correct.
**Effort:** Small

---

#### Q-008 | Low | Readability -- Consistent `!= null` convention (informational)

**Location:** 422 occurrences across 144 files in worker codebase

**Description:** Deliberate, consistent convention for guarding D1 query results. Correct throughout.

**Remediation:** No action. Document as codebase convention for onboarding.
**Effort:** N/A

---

#### Q-009 | Low | Security -- Telegram webhook returns 200 on auth failure

**Location:** `worker/src/api/telegram-webhook.ts`, lines 70-71

**Description:** Returns `200 OK` on auth failure -- correct per Telegram webhook conventions (prevents retry storms). But failed auth attempts produce no observable signal.

**Remediation:** Add a `console.warn` on auth failure for observability. Keep the 200 response status.
**Effort:** Small

---

#### Q-010 | Info | Complexity -- `stablecoin-table.tsx` at 700 lines (informational)

**Location:** `src/components/stablecoin-table.tsx` (700 lines)

**Description:** Logic/view separation already in place via `stablecoin-table-logic.ts`. Column render logic is distinct and difficult to abstract further.

**Remediation:** Informational. If column count grows, consider a column-definition-driven approach.
**Effort:** N/A

---

#### Q-011 | Info | Security -- `dangerouslySetInnerHTML` properly sanitized (positive)

**Location:** 16 occurrences across `src/app/` and `src/components/`

All usages pass through `safeJsonLd()` which escapes `<`, `>`, and `/`. Used exclusively for JSON-LD structured data.

---

#### Q-012 | Info | Security -- Hardcoded secrets only in test files (positive)

Production secrets loaded from Cloudflare Worker `Env` bindings with startup-time validation via `validateWorkerEnvContract()`.

---

#### Q-013 | Info | Security -- SQL injection prevention systematically enforced (positive)

`fetchPaginatedEvents()` validates table/column names against allowlists. All user values are bound as parameters. `buildInClause()` generates parameterized placeholders. Blacklist handler LIKE-escapes wildcards.

---

### Pillar C -- Sustainability & Maintainability

#### S-001 | High | Scalability -- Static-export build scales linearly with tracked coins

**Scope:** `shared/data/stablecoins/*.json` (17,672 lines), `shared/lib/stablecoins/index.ts`, `src/app/stablecoin/[id]/page.tsx`, `src/app/sitemap.ts`

**Description:** Stablecoin metadata is loaded at module evaluation time and Zod-parsed on every import. `generateStaticParams()` builds one page per tracked coin (188 today). Build times, memory, and sitemap size all scale linearly. At 300-500 coins, this becomes a friction point.

**Remediation:** Introduce a pre-compiled binary cache or code-generation step so Zod validation runs once at build time. Plan sitemap index with sub-sitemaps once URLs exceed ~5,000.
**Effort:** Medium

---

#### S-002 | High | Scalability -- Module-scoped mutable state across 3 Worker files

**Scope:**
- `worker/src/lib/rate-limit.ts` (6 variables)
- `worker/src/lib/request-source-attribution.ts` (2 variables)
- `worker/src/lib/api-keys.ts` (2 variables)

**Description:** Per-isolate state survives across invocations but is not shared across isolates. Prune-dedup may re-trigger across concurrent isolates. Emergency-block counter resets on recycle. Pattern repeated in 3 files without a shared abstraction.

**Remediation:** Extract an `IsolateLocalState` utility documenting per-isolate semantics. Consider D1-backed state if cross-isolate consistency becomes necessary.
**Effort:** Small

---

#### S-003 | High | Architecture -- Duplicated `getConfiguredValue` helper across runtimes

**Files:**
- `worker/src/lib/env.ts` line 151
- `functions/lib/ops-env.ts` line 48

**Description:** Identical null/empty/trim check defined in both runtimes. The `@shared/*` alias exists for exactly this purpose.

**Remediation:** Move to `shared/lib/` as a general-purpose binding resolution utility. Both files already import from `@shared/lib/`.
**Effort:** Small

---

#### S-004 | Medium | Dependencies -- `viem` is 48 MB for 3 function calls

**Scope:** `worker/package.json`, consumed by `fetch-slipstream.ts` and `crvusd.ts` only

**Description:** `viem` v2.38 (48 MB installed) provides `decodeFunctionResult`, `encodeFunctionData`, `parseAbi`. The rest of EVM RPC uses in-house `evm-rpc.ts` hex encoding.

**Remediation:** Either (a) use `viem/abi` subpath import for tree-shaking, or (b) replace with the existing `evm-rpc.ts` pattern and remove viem entirely.
**Effort:** Medium

---

#### S-005 | Medium | Build/Deploy -- PR validation skips no change detection

**Scope:** `.github/workflows/pull-request-checks.yml`, `.github/workflows/validate-ci.yml`

**Description:** Every PR runs full Pages build + worker typecheck, even for docs-only changes. The deploy workflow has `detect-changes` but PRs do not.

**Remediation:** Add `detect-changes` step to PR workflow and pass flags to the reusable workflow. Saves 3-5 minutes on non-deploy PRs.
**Effort:** Small

---

#### S-006 | Medium | Configuration -- Sitemap `LAST_EDITED` dates are manually maintained

**Scope:** `src/app/sitemap.ts` lines 14-45

**Description:** 30+ hardcoded date strings require manual updating whenever a page is edited. Inevitable drift misleads search engine crawl scheduling.

**Remediation:** Generate from git history at build time: `git log -1 --format=%aI -- src/app/<page>/page.tsx`.
**Effort:** Small

---

#### S-007 | Medium | Modularity -- `api-endpoints.ts` is a 999-line monolith

**Scope:** `shared/lib/api-endpoints.ts`

**Description:** Contains endpoint registry, path builders, method validation, status-page actions, admin path matching, and URL query construction. Single most-imported shared module.

**Remediation:** Split into sub-modules: `endpoint-definitions.ts`, `endpoint-paths.ts`, `endpoint-validation.ts`, `endpoint-status.ts`. Re-export from `api-endpoints/index.ts`.
**Effort:** Medium

---

#### S-008 | Medium | Documentation -- Methodology version checksums are fragile

**Scope:** `check:doc-sync` script, `methodology-manifest.ts` (300+ lines)

**Description:** Excellent guard for doc/code alignment, but the tight coupling requires lockstep updates. The manifest itself could drift from actual constants.

**Remediation:** Consider generating doc-facing methodology summaries from code at build time.
**Effort:** Medium

---

#### S-009 | Medium | Architecture -- 13 cron triggers approaching Cloudflare limits

**Scope:** `worker/wrangler.toml`

**Description:** 13 of ~20 available triggers in use. Current expansion trajectory (yield, treasury, audit features) will reach the limit.

**Remediation:** Consolidate lower-frequency jobs (e.g., merge `daily0800Utc` and `daily0805Utc` into a single slot with sub-dispatch). The existing `scheduledRunnerRegistry` pattern supports this cleanly.
**Effort:** Small

---

#### S-010 | Medium | Scalability -- D1 cache stores entire stablecoins payload as a single JSON blob

**Scope:** `worker/src/lib/db-cache.ts`

**Description:** Full 188-coin payload with supply, price, and chain data stored as one `cache` row. Approaching D1's 2 MB row-size limit as per-coin data grows.

**Remediation:** Add size-in-bytes telemetry to the status endpoint. Plan migration to per-coin or per-category rows if blob exceeds 1 MB.
**Effort:** Small (monitoring) / Large (migration)

---

#### S-011 | Medium | Modularity -- Large components resist isolated testability

**Scope:**
- `src/components/contagion-graph.tsx` (803 lines)
- `src/components/stablecoin-table.tsx` (700 lines)
- `src/components/dex-liquidity-card.tsx` (680 lines)
- `src/components/dews-summary.tsx` (675 lines)
- `src/components/yield-detail-section.tsx` (642 lines)

**Description:** Mix presentation, data transformation, and layout in single files. Resist unit testing in isolation.

**Remediation:** Extract data transformation into companion `*-model.ts` files (pattern already established with `flow-machine-scene-model.ts`, `stablecoin-detail-view-model.ts`).
**Effort:** Medium per component

---

#### S-012 | Low | Configuration -- PostCSS config undocumented

**Scope:** `postcss.config.mjs`

Standard Tailwind v4 infrastructure. No issues, but not mentioned in docs.

**Remediation:** Add a one-line mention to architecture docs.
**Effort:** Trivial

---

#### S-013 | Low | Build/Deploy -- Hotspot ratchet baseline update is manual

**Scope:** `check:hotspot-ratchet` npm script

**Description:** Intentional refactors require running `npm run check:hotspot-ratchet:update-baseline` manually. Forgetting produces a confusing merge-gate failure.

**Remediation:** Improve the error message to suggest the update command. Consider auto-detect for strict improvements.
**Effort:** Small

---

#### S-014 | Low | Documentation -- No env-var runbook for new contributors

**Scope:** `.env.example`, `worker/src/lib/env.ts`, `docs/worker-infrastructure.md`

**Description:** 50+ bindings across files with minimal guidance on which are needed per development scenario (frontend-only, worker-only, full-stack).

**Remediation:** Add a "Local Development Setup" section to README mapping scenarios to minimum required env vars.
**Effort:** Small

---

#### S-015 | Low | Architecture -- Shared types barrel export at `shared/types/index.ts`

**Scope:** `shared/types/index.ts` re-exporting from 14 sub-modules

**Description:** Currently manageable but barrel-export-driven import costs grow with the type surface. Worker already uses sub-module imports inconsistently.

**Remediation:** Standardize on sub-module imports. Deprecate barrel with a code comment.
**Effort:** Small

---

#### S-016 | Low | Dependencies -- `html-to-image` appropriate and lightweight (positive)

14 KB gzipped, well-maintained. No action needed.

---

#### S-017 | Low | Build/Deploy -- Node.js version consistency (positive)

Workflows pin `22.x` with `engines: ">=22 <25"`. Forward-compatibility testing against Node 24 is good practice.

---

## 3. Cross-Cutting Concerns

### CC-001 | Monolithic File Cluster (Q-001 + Q-002 + Q-004 + Q-006 + S-007 + S-011)

**Description:** Seven files exceed 600 lines: `api-endpoints.ts` (999), `fetch-primary.ts` (798), `enrich-prices-passes.ts` (806), `contagion-graph.tsx` (803), `stablecoin-table.tsx` (700), `dex-liquidity-card.tsx` (680), `dews-summary.tsx` (675), `yield-detail-section.tsx` (642), and `homepage-client.tsx` (608). Each independently flagged for complexity (Q pillar) or modularity (S pillar). Collectively, they represent the primary maintenance friction zone.

**Unified Strategy:** Apply the established `*-model.ts` extraction pattern (already proven with `stablecoin-detail-view-model.ts` and `flow-machine-scene-model.ts`) to all large components. For worker files, decompose along data-source or responsibility boundaries. Prioritize `api-endpoints.ts` (999 lines, most imported) and `handleAggregate` (hardest to test).

---

### CC-002 | Formatting DRY Debt (R-003 + R-008 + R-009 + R-005)

**Description:** The March audit consolidated core format functions into `shared/lib/format.ts`, but adoption is incomplete. ~20+ sites still inline `${value.toFixed(N)}%`, two thin wrappers (`formatTreasuryPct`, `formatRatioPct`) duplicate existing shared functions, and yield chart dates diverge from shared `formatChartDate`. All are formatting concerns spanning redundancy and quality.

**Unified Strategy:** Add `formatPercentFromRatio(ratio, decimals)` to shared format (auto-multiplies by 100). This single addition enables mechanical replacement of R-003, R-008, and R-009. Separately, map yield chart formatters to shared `formatChartDate` presets (R-005).

---

### CC-003 | Worker Isolate State Pattern (Q-007 + S-002)

**Description:** Module-scoped mutable state is spread across 3 files (`rate-limit.ts`, `request-source-attribution.ts`, `api-keys.ts`) with 10 total `let` variables. Flagged as both a design pattern concern (Q-007, fragile `ctx.waitUntil` dependencies) and a sustainability concern (S-002, repeated pattern without shared abstraction).

**Unified Strategy:** Extract an `IsolateLocalState<T>` utility that documents per-isolate semantics, provides a reset-for-tests method, and centralizes the "best-effort" contract. All three files adopt the shared primitive.

---

### CC-004 | Cross-Runtime Duplication (R-001 + S-003)

**Description:** Two duplication findings span the `functions/` ↔ `worker/` runtime boundary: proxy helpers (R-001) duplicated between Pages Functions, and `getConfiguredValue` (S-003) duplicated between worker `env.ts` and functions `ops-env.ts`. Both are DRY violations in code that should share via `shared/lib/` or `functions/lib/`.

**Unified Strategy:** Move `getConfiguredValue` to `shared/lib/`. Extract proxy helpers to `functions/lib/proxy-utils.ts`. Both are small, low-risk extractions.

---

### CC-005 | Scalability Ceiling Triad (S-001 + S-009 + S-010)

**Description:** Three independent scalability concerns that share a common trigger: growth of the tracked stablecoin set. Static-export build time (S-001), cron trigger count (S-009), and D1 cache blob size (S-010) all scale with coin count. None is critical today at 188 coins, but all three will need attention in the 300-500 range.

**Unified Strategy:** Add monitoring first (S-010 blob size telemetry, build-time tracking). Consolidate cron triggers (S-009) proactively as the lowest-effort fix. Plan the build-time optimization (S-001) and cache migration (S-010) as a coordinated effort when metrics indicate the threshold is approaching.

---

## 4. Prioritized Remediation Roadmap

### Phase 1 -- Quick Wins
*Low-effort, high-impact changes completable in isolation. No cross-file dependencies.*

| Ref | Action | Files | Effort | Depends On |
|-----|--------|-------|--------|------------|
| R-004 | Remove 5 duplicate format tests from `src/lib/__tests__/format.test.ts` | 1 file | Small | -- |
| R-007 | Inline `formatElapsedSeconds(ms / 1000)` in banner, remove `formatHealthAge` | 2 files | Small | -- |
| R-013 | Remove or unexport `isAmbiguousStablecoinSymbol` | 1 file | Small | -- |
| Q-003 | Add explanatory comments to undocumented catch blocks; add `console.debug` to alchemy-logs | ~10 files | Small | -- |
| Q-009 | Add `console.warn` on Telegram webhook auth failure | 1 file | Small | -- |
| S-003 | Move `getConfiguredValue` to `shared/lib/`, update imports in `env.ts` and `ops-env.ts` | 3 files | Small | -- |
| S-006 | Generate `LAST_EDITED` from git history in a prebuild script | 1 file + script | Small | -- |
| S-013 | Improve hotspot ratchet error message to suggest update command | 1 file | Small | -- |
| S-014 | Add "Local Development Setup" section to README | 1 file | Small | -- |
| R-011 | Add JSDoc to `isKnownCoinId` clarifying it excludes shadow stablecoins | 1 file | Small | -- |

---

### Phase 2 -- Targeted Refactoring
*Medium-effort changes addressing specific redundancy and quality issues across 1-5 files.*

| Ref | Action | Files | Effort | Depends On |
|-----|--------|-------|--------|------------|
| R-003 + R-008 + R-009 | Add `formatPercentFromRatio` to shared format; replace ~20+ inline sites and 2 thin wrappers | ~25 files | Medium | -- |
| R-002 | Replace 13+ inline `res.body?.cancel()` with `cancelResponseBodyQuietly` imports | ~10 files | Small | -- |
| R-001 | Extract `functions/lib/proxy-utils.ts` from duplicated proxy helpers | 3 files | Small | -- |
| R-005 | Map yield chart formatters to shared `formatChartDate` presets | 2 files | Small | -- |
| R-006 | Remove `getAdapterTimeout`, replace 30+ call sites with literal values | ~30 files | Small | -- |
| Q-001 | Extract `CoinFlowSummary` interface; split `handleAggregate` into 3 functions | 1 file | Medium | -- |
| Q-002 | Extract skeleton and peg distribution components from homepage-client | 3 files | Small | -- |
| S-005 | Add `detect-changes` to PR workflow, pass flags to validate-ci | 1 file | Small | -- |
| S-009 | Consolidate cron triggers (merge daily slots with sub-dispatch) | 2 files | Small | -- |
| S-002 + Q-007 | Extract `IsolateLocalState` utility, refactor 3 consumer files | 4 files | Small | -- |

---

### Phase 3 -- Structural Improvements
*Higher-effort changes improving modularity and long-term maintainability.*

| Ref | Action | Files | Effort | Depends On |
|-----|--------|-------|--------|------------|
| S-007 | Split `api-endpoints.ts` into sub-modules with barrel re-export | 5+ files | Medium | -- |
| S-011 | Extract `*-model.ts` companions for the 5 largest components | 10 files | Medium | -- |
| S-004 | Replace 3 viem calls with in-house `evm-rpc.ts` patterns; remove viem dependency | 3-4 files | Medium | -- |
| S-010 | Add blob-size telemetry to status endpoint; design per-coin cache schema | 2 files (monitoring) | Small | -- |
| S-008 | Generate methodology doc sections from code instead of manual sync + check | 3+ files | Medium | -- |
| S-015 | Standardize sub-module imports for shared types, deprecate barrel | ~20 files | Small | -- |

---

### Phase 4 -- Strategic Overhauls
*Major efforts addressing deep scalability and architecture concerns. Plan when metrics indicate necessity.*

| Ref | Action | Files | Effort | Trigger |
|-----|--------|-------|--------|---------|
| S-001 | Pre-compiled stablecoin metadata cache (skip Zod-on-import); sitemap index splitting | Core build pipeline | Large | Build time exceeds 3 min or coin count > 300 |
| S-010 | Migrate D1 cache from single blob to per-coin/per-category rows | Worker cache layer | Large | Blob size exceeds 1 MB |
| CC-001 | Systematic decomposition of all 600+ line files via model extraction pattern | ~15 files | Large | Ongoing, prioritize by churn rate |

---

## 5. Appendices

### Appendix A -- File-by-File Finding Index

| File | Findings |
|------|----------|
| `functions/api/admin/[[path]].ts` | R-001 |
| `functions/_site-data/[[path]].ts` | R-001 |
| `functions/lib/ops-env.ts` | S-003 |
| `shared/lib/api-endpoints.ts` | S-007 |
| `shared/lib/format.ts` | R-003, R-005, R-008, R-009, R-014 |
| `shared/lib/stablecoins/index.ts` | S-001 |
| `shared/lib/stablecoin-id-registry.ts` | R-011 |
| `shared/lib/validate-coin-id.ts` | R-011 |
| `shared/lib/__tests__/format.test.ts` | R-004 |
| `shared/types/index.ts` | S-015 |
| `src/app/sitemap.ts` | S-006 |
| `src/app/stablecoin/[id]/page.tsx` | S-001 |
| `src/app/coverage/coverage-feature-snapshot.tsx` | R-003 |
| `src/components/comparison-table.tsx` | R-003 |
| `src/components/contagion-graph.tsx` | S-011 |
| `src/components/data-health-banner.tsx` | R-007 |
| `src/components/dews-detail.tsx` | R-003 |
| `src/components/dews-summary.tsx` | S-011 |
| `src/components/dex-liquidity-card.tsx` | S-011 |
| `src/components/homepage-client.tsx` | Q-002 |
| `src/components/stablecoin-table.tsx` | Q-010, S-011 |
| `src/components/yield-detail-section.tsx` | R-003, S-011 |
| `src/components/yield-history-chart-model.ts` | R-005 |
| `src/components/yield-leaderboard-table-row.tsx` | R-003 |
| `src/components/yield-scatter-plot.tsx` | R-003 |
| `src/components/status/data-quality-cards.tsx` | R-003 |
| `src/components/status/mint-burn-reconciliation.tsx` | R-003 |
| `src/components/status/price-source-health.tsx` | R-003 |
| `src/hooks/use-compare-share-actions.ts` | R-003 |
| `src/lib/chain-ui.ts` | R-009 |
| `src/lib/data-health.ts` | R-007 |
| `src/lib/stablecoin-url-codec.ts` | R-010, R-013 |
| `src/lib/status-dashboard-model.ts` | R-012 |
| `src/lib/treasury-table-utils.ts` | R-008 |
| `src/lib/__tests__/format.test.ts` | R-004 |
| `worker/src/api/mint-burn-flows.ts` | Q-001 |
| `worker/src/api/telegram-webhook.ts` | Q-009 |
| `worker/src/cron/dex-liquidity/challenger-persistence.ts` | Q-003 |
| `worker/src/cron/dex-liquidity/fetch-primary.ts` | Q-006 |
| `worker/src/cron/dex-liquidity/scoring.ts` | Q-003 |
| `worker/src/cron/reserve-adapters/helpers.ts` | R-002, R-006 |
| `worker/src/cron/sync-stablecoin-charts.ts` | Q-003 |
| `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts` | Q-004, R-002 |
| `worker/src/lib/alchemy-logs.ts` | Q-003, R-002 |
| `worker/src/lib/api-keys.ts` | S-002 |
| `worker/src/lib/api-utils.ts` | Q-005, Q-013 |
| `worker/src/lib/db-cache.ts` | S-010 |
| `worker/src/lib/env.ts` | S-003 |
| `worker/src/lib/evm-logs.ts` | R-002 |
| `worker/src/lib/fetch-retry.ts` | R-002 |
| `worker/src/lib/rate-limit.ts` | Q-007, S-002 |
| `worker/src/lib/request-source-attribution.ts` | S-002 |
| `worker/src/lib/response-body.ts` | R-002 |
| `worker/wrangler.toml` | S-009 |
| `.env.example` | S-014 |
| `.github/workflows/pull-request-checks.yml` | S-005 |
| `postcss.config.mjs` | S-012 |

### Appendix B -- Dependency Audit Summary

| Package | Status | Notes |
|---------|--------|-------|
| `viem` (worker, 48 MB) | **Oversized for usage** | 3 function calls; replaceable with in-house `evm-rpc.ts` |
| `html-to-image` (frontend, 14 KB gzipped) | Clean | Appropriate for chart export |
| `d3-force` (frontend) | Clean | Used for contagion graph layout |
| `react-tweet` (frontend) | Clean | Pre-launch detail embeds |
| `recharts` (frontend) | Clean | All chart rendering |
| `cmdk` (frontend) | Clean | Command palette via shadcn |
| `satori` (worker) | Clean | OG image generation |
| `@cf-wasm/resvg` (worker) | Clean | SVG-to-PNG for OG images |
| All other deps | Clean | No orphaned, abandoned, or duplicate packages detected |

### Appendix C -- Glossary

| Term | Definition |
|------|------------|
| **SRP** | Single Responsibility Principle -- a class/function should have one reason to change |
| **DRY** | Don't Repeat Yourself -- avoid duplicating knowledge across the codebase |
| **God class/module** | A component that has accumulated too many responsibilities |
| **Barrel export** | An `index.ts` that re-exports everything from sub-modules |
| **Isolate-scoped state** | Variables that persist across requests within a single Cloudflare Worker isolate but reset on deployment or isolate recycle |
| **TOCTOU** | Time-of-check to time-of-use race condition |
| **Circuit breaker** | Pattern that stops calling a failing external service and fails fast, with periodic recovery probes |
| **Hotspot ratchet** | CI check that prevents file-size regressions in tracked "hotspot" files |
| **D1** | Cloudflare's SQLite-based serverless database |
| **Static export** | Next.js build mode that pre-renders all pages to static HTML at build time |
| **Tree-shaking** | Bundler optimization that removes unused code from the final output |
| **Subpath import** | Importing from a specific sub-module path (e.g., `viem/abi`) to enable tree-shaking |
