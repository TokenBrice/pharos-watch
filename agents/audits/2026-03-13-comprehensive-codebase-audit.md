# Comprehensive Codebase Audit Report

**Date:** 2026-03-13
**Codebase:** Pharos Stablecoin Dashboard
**Scope:** Full codebase (~146K lines TypeScript across frontend, worker, and shared layers)

---

## 1. Executive Summary

### Finding Counts by Pillar and Severity

| Severity | Redundancy | Code Quality | Sustainability | Total |
|----------|-----------|-------------|---------------|-------|
| Critical | 0 | 2 | 0 | **2** |
| High | 1 | 5 | 3 | **9** |
| Medium | 3 | 9 | 6 | **18** |
| Low | 7 | 6 | 9 | **22** |
| **Total** | **11** | **22** | **18** | **51** |

*Note: 5 of the Sustainability Low findings are documented strengths, not issues.*

### Top 5 Most Critical Findings

1. **Q-001 (Critical/Security):** Admin auth relies on header presence, not validation -- the worker never verifies Cloudflare Access JWTs or service token values, trusting infrastructure to strip spoofed headers.
2. **Q-002 (Critical/Security):** Telegram webhook secret compared via `!==` (not timing-safe) and exposed in URL query parameter (log leakage risk).
3. **Q-005 (High/Type Safety):** The stablecoins cache -- the single most-consumed data structure -- casts parsed JSON via `as StablecoinData[]` with zero runtime validation. A malformed DefiLlama response silently propagates through every cron and API.
4. **S-002 (High/Scalability):** Unbounded `SELECT` queries in stability-index (`detail=true`) and dex-liquidity APIs will degrade as tables grow, eventually hitting D1's 30-second statement limit.
5. **Q-006 (High/Complexity):** `detectDepegEvents` is a 307-line function with 5-level nesting mixing detection logic, state management, and DB persistence -- the system's most consequential business logic and also one of its least tested (Q-015).

### Overall Codebase Health Assessment

| Pillar | Score (1-10) | Justification |
|--------|-------------|---------------|
| Redundancy | **8/10** | Remarkably clean. No dead code found. Existing factory patterns (`createPageError`, `createMethodologyChangelogRoute`, `createMethodologyVersion`) show mature consolidation discipline. Remaining duplication is incremental. |
| Code Quality | **7/10** | Strong architectural patterns (circuit breakers, abort signal propagation, parameterized SQL). Weakened by 2 security findings, insufficient runtime validation at data boundaries, and high complexity in depeg detection without matching test coverage. |
| Sustainability | **8/10** | Excellent documentation (30+ topic files), multi-layered boundary enforcement, tiered test infrastructure, lean dependencies. Main friction points are structural (monolithic metadata file, flat component directory, db.ts cohesion). |

### Technical Debt Profile

~15% of the codebase is affected by significant findings. The debt is concentrated in:
- Worker cron pipelines (complexity, testing gaps)
- Data boundary validation (stablecoins cache, feedback endpoint)
- Security posture (auth delegation, webhook secret handling)
- Structural organization (monolithic files, flat directories)

---

## 2. Findings by Pillar

### Pillar A: Redundancy Elimination

#### R-001 | HIGH | Code Duplication
**Duplicate binary search implementations**

Three separate nearest-neighbor lookup implementations exist when a generic `binarySearchNearest()` is available:

| Location | Function | Approach |
|----------|----------|----------|
| `worker/src/lib/binary-search.ts` | `binarySearchNearest<T>()` | Canonical generic utility |
| `worker/src/api/backfill-depegs.ts:869-891` | `findNearestSupply()` | Custom lo/hi/candidates binary search |
| `worker/src/lib/authoritative-price-sources.ts:112-133` | `findNearestSupply()` | Nearly identical to above, different type |
| `worker/src/lib/psi-recompute.ts:47-66` | `findNearestSupplySnapshot()` | Linear scan with 14-day max-distance |

The two `findNearestSupply` functions are algorithmically identical, differing only in type signatures. Two other call sites correctly delegate to the shared utility.

**Consolidation:** Refactor the two duplicate `findNearestSupply` functions to delegate to `binarySearchNearest()`. For `psi-recompute.ts`, use a post-filter for the max-distance constraint. ~40 lines removed, one bug surface eliminated.

---

#### R-002 | MEDIUM | Code Duplication
**Structural clone pattern across table logic files**

Four `*-table-logic.ts` files follow an identical structural pattern:

- `src/components/liquidity-table-logic.ts` -- `compareLiquidityRows()`
- `src/components/depeg-table-logic.ts` -- `compareDepegRows()`
- `src/components/blacklist-table-logic.ts` -- `compareBlacklistRows()`
- `src/components/yield-table-logic.ts` -- `compareYieldRows()`

Each imports `TableSortState`, defines a switch/case comparator extracting `aVal`/`bVal`, then applies directional comparison. Only row types and field accessors differ.

**Consolidation:** Create a generic `createTableComparator<Row, Key>(fieldExtractors: Record<Key, (row: Row) => number | string>)` factory. Each file reduces to ~5-10 lines of accessor definitions. ~100 lines of boilerplate removed.

---

#### R-003 | MEDIUM | Overlapping Responsibilities
**Dual admin auth patterns**

`worker/src/lib/auth.ts` exports both:
- `requireAdmin()` (returns `Response | null`, 7 consumers use early-return guard pattern)
- `withAdmin()` (callback wrapper, 11 consumers)

Both call `hasValidAdminCredential()`. Two patterns for the same purpose creates cognitive overhead for contributors.

**Consolidation:** Standardize on `withAdmin()` (cleaner abstraction, no null-check boilerplate) or document clearly when each is preferred. Migrate 7 `requireAdmin` consumers for consistency.

---

#### R-004 | MEDIUM | Code Duplication
**Duplicate `useIsMobile` hook across chart components**

- `src/components/psi-history-chart.tsx:136-148` -- SSR-safe `useState` initializer pattern
- `src/components/yield-scatter-plot.tsx:108-117` -- initializes to `false`, corrects in `useEffect`

Same default breakpoint (640px), same `matchMedia("change")` observer, slightly different SSR handling.

**Consolidation:** Extract to `src/hooks/use-is-mobile.ts` with the SSR-safe pattern. ~20 lines removed, consistent SSR behavior.

---

#### R-005 | LOW | Code Duplication
**Duplicate series merge logic in comparison charts**

`src/components/comparison-chart.tsx:42-57` and `src/components/flow-comparison-chart.tsx:48-58` implement identical timestamp-keyed series merge using a `Map<number, Record>`.

**Consolidation:** Extract `mergeSeriesByTimestamp(series, valueAccessor)` utility. ~15 lines shared.

---

#### R-006 | LOW | Code Duplication
**`formatFlowValue` reimplements `formatCurrency`**

`src/components/flow-comparison-chart.tsx:34-39` reimplements tier-suffix abbreviation (B/M/K) that `shared/lib/format.ts:formatCurrency()` already provides.

**Consolidation:** Replace with `formatCurrency(v, 1)`. ~6 lines removed.

---

#### R-007 | LOW | Redundant Abstraction
**`formatAge` passthrough wrapper**

`src/components/status/format.ts:9-11` -- `formatAge()` does nothing except call `formatElapsedSeconds()` from `@shared/lib/format`.

**Consolidation:** Replace 2 import sites with direct imports. Remove passthrough. ~3 lines.

---

#### R-008 | LOW | Redundant Abstraction
**Redundant `toMethodologyVersionLabel` re-exports**

Three domain-specific version files re-export the trivial `toMethodologyVersionLabel()` (prepends `"v"`) under domain-specific names:
- `shared/lib/stability-index-version.ts:133`
- `shared/lib/depeg-dews-version.ts:253`
- `shared/lib/blacklist-tracker-version.ts:148`

**Consolidation:** Have 5 API handler consumers import directly from `@shared/lib/methodology-version`. Remove 3 re-exports.

---

#### R-009 | LOW | Redundant Abstraction
**Unnecessary type/const aliases in `cron-config.ts`**

`src/components/status/cron-config.ts` creates `StatusCronGroupKey = CronGroupKey`, `StatusCronGroupDefinition = CronGroupDefinition`, and `STATUS_CRON_GROUPS = CRON_GROUPS` -- pure aliases with no transformation.

**Consolidation:** Replace with direct imports from `@shared/lib/cron-jobs`.

---

#### R-010 | LOW | Overlapping Responsibilities
**Inconsistent version file patterns**

Of 7 methodology version files, 5 use the `createMethodologyVersion()` factory from `shared/lib/methodology-version.ts`. Two (`safety-score-version.ts`, `redemption-backstop-version.ts`) manually define bare constants instead.

**Consolidation:** Migrate `redemption-backstop-version.ts` to the factory. Accept `safety-score-version.ts` divergence (justified by extra `CHANGELOG_NAV_VERSIONS` data).

---

#### R-011 | LOW | Code Duplication
**Chart Y-domain computation duplication**

Three chart components compute Y-axis domains with identical logic (min/max reduce, 15% padding, 5% fallback, clamp to 0):
- `src/components/mcap-chart.tsx:137-144`
- `src/components/total-mcap-chart.tsx:70-77`
- `src/components/peg-diversity-chart.tsx:135-141`

**Consolidation:** Extract `computeChartYDomain(values, isAllRange)` utility into `src/lib/chart-utils.ts`. ~20 lines removed.

---

### Pillar B: Code Quality

#### Q-001 | CRITICAL | Security
**Admin auth relies on header presence, not validation**

- **Location:** `worker/src/lib/auth.ts`, `hasOpsApiAccessSignal()`, lines 14-30
- **Description:** The auth module checks whether Cloudflare Access headers (`Cf-Access-Jwt-Assertion`, `Cf-Access-Authenticated-User-Email`, `CF-Access-Client-Id` + `CF-Access-Client-Secret`) are *present* but never validates their content. The JWT is not verified against a signing key. The email header is not checked against an allowlist. Any request with a non-empty `Cf-Access-Authenticated-User-Email: anything` header passes.
- **Impact:** Full admin access (backfills, DB mutations) to anyone who can route a request to the worker with the ops-api hostname and a single spoofed header. Relies entirely on Cloudflare Access sitting in front to strip/validate these headers.
- **Remediation:** Validate JWT signature against Cloudflare Access team's public keys, or verify `CF-Access-Client-Id` against known env value. At minimum, add documentation noting the external infrastructure dependency.

---

#### Q-002 | CRITICAL | Security
**Telegram webhook secret in URL, not timing-safe**

- **Location:** `worker/src/api/telegram-webhook.ts`, `handleTelegramWebhook()`, line 57
- **Description:** Webhook secret compared with `!==` (not timing-safe) and exposed as a URL query parameter (appears in logs, HTTP referrer, Cloudflare analytics).
- **Impact:** Secret leakage enables arbitrary webhook command injection -- manipulating user subscriptions and triggering bot interactions.
- **Remediation:** Use `crypto.subtle.timingSafeEqual()` for comparison. Move secret to `X-Telegram-Bot-Api-Secret-Token` header using Telegram's native `secret_token` registration parameter.

---

#### Q-003 | HIGH | Error Handling
**In-memory rate limiter resets on worker eviction**

- **Location:** `worker/src/lib/rate-limit.ts`, `checkRateLimit()`, lines 20-63
- **Description:** The `ipCounts` Map lives in V8 isolate memory and is lost on cold starts. The in-memory fallback (used when D1 fails) provides no cross-isolate protection, leaving the API unprotected during D1 outages.
- **Impact:** Rate limiting disappears when most needed (D1 failure scenarios).
- **Remediation:** Add `Retry-After` header with conservative value when D1 limiter fails. Consider Cloudflare's native rate limiting rules as outer defense layer.

---

#### Q-004 | HIGH | Error Handling
**Circuit breaker TOCTOU race between `shouldAttemptFetch` and `recordOutcome`**

- **Location:** `worker/src/lib/circuit-breaker.ts`, lines 69-133
- **Description:** Two separate D1 reads of the same circuit record without atomicity. Concurrent cron jobs sharing D1 connections can both see "half-open" and both probe, defeating single-probe semantics.
- **Impact:** Under concurrent cron execution, circuit state transitions may not behave as designed.
- **Remediation:** Merge read-check-write into single SQL CAS operation using `ON CONFLICT ... WHERE`, or document as "best-effort."

---

#### Q-005 | HIGH | Type Safety
**Unsafe type assertions in stablecoins-cache.ts**

- **Location:** `worker/src/lib/stablecoins-cache.ts`, `normalizePayload()`, lines 64-91
- **Description:** Casts `parsed as StablecoinData[]` without runtime validation. This is the system's most-consumed data structure -- every cron and most API endpoints depend on it.
- **Impact:** A malformed DefiLlama response silently propagates, corrupting scores, triggering false depegs, or crashing multiple crons simultaneously.
- **Remediation:** Add Zod schema validation for critical fields (`id`, `symbol`, `price`, `pegType`, `circulating`) at the cache boundary. Reject individual malformed entries while preserving valid ones.

---

#### Q-006 | HIGH | Complexity
**`detectDepegEvents` has excessive cyclomatic complexity (307 lines, 5-level nesting)**

- **Location:** `worker/src/cron/detect-depegs.ts`, lines 24-331
- **Description:** Single function mixing detection logic, state management, duplicate merging, orphan cleanup, and DB persistence with deeply interleaved concerns.
- **Impact:** Extremely difficult to verify correctness of edge cases. The combinatorial explosion of paths (direction changes, DEX disagreements, supply thresholds, pending confirmation) resists exhaustive testing.
- **Remediation:** Extract per-asset evaluation into a pure function returning a discriminated union of actions (`open-event`, `close-event`, `update-peak`, `pending`, `skip`). Orchestrator maps actions to SQL.

---

#### Q-007 | HIGH | Design Pattern
**`fetchWithRetry` returns null on failure instead of throwing**

- **Location:** `worker/src/lib/fetch-retry.ts`, lines 11-58
- **Description:** Returns `null` when all retries exhausted. Over 40 call sites must check for null. Cannot distinguish between failure modes (500 vs network error vs 404).
- **Impact:** Encourages subtle mistakes in future code where null check is forgotten.
- **Remediation:** Consider a result-type return (`{ ok: true, response } | { ok: false, lastStatus, error }`) or prominent JSDoc documenting the null-return contract.

---

#### Q-008 | MEDIUM | Design Pattern
**Duplicated `normalizeOrigin` function in Pages Functions**

- **Location:** `functions/api/admin/[[path]].ts:49`, `functions/status/[[path]].ts:10`
- **Description:** `normalizeOrigin` and `resolveOpsUiOrigin` duplicated verbatim across two Pages Functions files.
- **Remediation:** Extract into shared module under `functions/`.

---

#### Q-009 | MEDIUM | Error Handling
**`resolveBackfillConfig` throws Response objects as exceptions**

- **Location:** `worker/src/api/backfill-mint-burn.ts`, lines 48-106, 208-214
- **Description:** Uses exceptions for control flow -- throws `Response` objects for expected validation failures, caught with `instanceof Response` check. Fragile and confusing.
- **Remediation:** Return discriminated union: `{ ok: true, config } | { ok: false, response }`.

---

#### Q-010 | MEDIUM | Naming
**`pass4` field name in `EnrichmentStats` is misleading**

- **Location:** `worker/src/cron/enrich-prices.ts`, `EnrichmentStats`, line 298
- **Description:** Field `pass4: number` has comment `// DexScreener (legacy field name)`. Passes are now 1, 1b, 2, 3 but stats field is still `pass4`.
- **Remediation:** Rename to `passDex` or `pass3`.

---

#### Q-011 | MEDIUM | Error Handling
**Silent empty catch blocks in cron jobs**

- **Locations:**
  - `worker/src/cron/sync-stablecoin-charts.ts` lines 75, 121
  - `worker/src/cron/daily-digest.ts` line 562
  - `worker/src/cron/announce-cemetery-additions.ts` line 49
  - `worker/src/lib/authoritative-price-sources.ts` line 81
- **Description:** Empty `catch {}` blocks silently swallow errors without logging.
- **Remediation:** Add `console.warn("[context] ignored error:", err)` or document why error is safe to ignore.

---

#### Q-012 | MEDIUM | Type Safety
**Feedback endpoint trusts `request.json()` shape without runtime validation**

- **Location:** `worker/src/api/feedback.ts`, `handleFeedback()`, line 228
- **Description:** Body cast `as FeedbackBody` without Zod validation. Malformed payload (e.g., `description: 12345`) could cause unhandled `.trim()` exception.
- **Remediation:** Use Zod schema validation at boundary, consistent with `validatePayloadWithSchema` pattern.

---

#### Q-013 | MEDIUM | Complexity
**`sync-blacklist.ts` is a 1,258-line monolith**

- **Location:** `worker/src/cron/sync-blacklist.ts`
- **Description:** Contains entire pipeline: EVM log parsing, Tron event fetching, balance enrichment via multiple providers, amount backfilling, orchestration, and progress reporting. Main function is ~325 lines.
- **Remediation:** Extract into `worker/src/cron/sync-blacklist/` following `dex-liquidity/` and `mint-burn-pipeline/` patterns.

---

#### Q-014 | MEDIUM | Design Pattern
**`parseIntParam` returns `number | Response` -- poor discriminated union**

- **Location:** `worker/src/lib/api-utils.ts`, lines 187-204
- **Description:** Callers must check `instanceof Response` at every call site. Pattern is consistently applied but unconventional.
- **Remediation:** Document as project convention. Consider migrating to a proper result type long-term.

---

#### Q-015 | MEDIUM | Testing
**No test coverage for depeg detection pipeline**

- **Location:** `worker/src/cron/detect-depegs.ts`, `worker/src/cron/confirm-pending-depegs.ts`
- **Description:** Neither function has test coverage. These are among the most complex and consequential cron jobs, with helper tests but no orchestration-level tests.
- **Remediation:** Add integration-style tests covering: open new event, close on recovery, direction change, DEX auto-close, duplicate merging, pending confirmation promotion, orphan cleanup.

---

#### Q-016 | MEDIUM | Testing
**Insufficient test coverage for stablecoin detail handler fallback paths**

- **Location:** `worker/src/api/stablecoin-detail.ts`
- **Description:** Most complex API handler with multi-level fallback chains, circuit breaker integration, and cache-write side effects. Existing test file has minimal coverage of fallback paths.
- **Remediation:** Add tests for: fresh cache hit, stale cache + successful upstream, upstream failure + supply_history fallback, circuit breaker open, commodity/CG-only paths.

---

#### Q-017 | LOW | Naming
`TRON_SAFETY_MS` vs `INDEXING_SAFETY_SEC` naming inconsistency in `sync-blacklist.ts:52-53`. Self-documenting, no action needed.

#### Q-018 | LOW | Design Pattern
`dangerouslySetInnerHTML` for JSON-LD with proper `safeJsonLd()` escaping. Correct pattern, no action needed.

#### Q-019 | LOW | Naming
`supply` variable computed twice in `detectDepegEvents` (lines 154, 241) under different names (`supply`, `coinSupply`). Minor redundant computation.

#### Q-020 | LOW | Style
Inconsistent `signal?.aborted` re-throw pattern duplicated across catch blocks. Consider extracting `rethrowIfAborted(signal, err)` utility.

#### Q-021 | LOW | Design Pattern
Module-scoped mutable state via `let webhookUrl` in `alerts.ts`. Standard Workers pattern, correctly re-initialized per request.

#### Q-022 | LOW | Type Safety
`as unknown as D1Database` casts in test files. Standard test mocking practice, no action needed.

---

### Pillar C: Sustainability and Maintainability

#### S-001 | HIGH | Architecture / Scalability
**Monolithic stablecoin metadata file (4,637 lines)**

- **Location:** `shared/lib/stablecoins.ts`
- **Description:** Single 4,637-line file with hand-maintained metadata for 156+ stablecoins, imported by 58 files across all three layers. Every coin addition edits this file, creating high merge-conflict risk in parallel worktrees. GitHub truncates display at 256KB.
- **Consequences:** Collision risk during concurrent development, no schema validation at metadata level, file too large for efficient code review.
- **Remediation:** Split into per-category or per-peg-currency files re-exported from an index, or adopt structured data format (YAML/JSON per coin) with build-time Zod validation.

---

#### S-002 | HIGH | Scalability
**Unbounded SQL queries in API handlers**

- **Locations:**
  - `worker/src/api/stability-index.ts:43` -- `SELECT ... FROM stability_index ORDER BY computed_at DESC` (when `detail=true`)
  - `worker/src/api/dex-liquidity.ts:166` -- `SELECT * FROM dex_liquidity ORDER BY liquidity_score DESC`
- **Description:** No `LIMIT` clause. The stability_index table grows one row per day, unbounded.
- **Consequences:** Progressive performance degradation, eventual D1 30-second timeout, multi-megabyte JSON responses.
- **Remediation:** Add configurable `LIMIT` (default 365/730) with pagination for detail mode. Use explicit column names instead of `SELECT *`.

---

#### S-003 | HIGH | Modularity
**`db.ts` conflates 5 responsibilities (534 lines)**

- **Location:** `worker/src/lib/db.ts`
- **Description:** Mixes generic D1 batch execution, cache CRUD, blacklist sync state, price cache operations, and cron infrastructure (lease acquisition/renewal/release, progress reporting, timeout management -- ~350 lines alone).
- **Consequences:** Any cron leasing change requires touching core D1 utilities, increasing cognitive load and merge conflict risk.
- **Remediation:** Extract into `db-cache.ts`, `cron-lease.ts`, `cron-logger.ts`. Keep `db.ts` as thin batch/query utility layer.

---

#### S-004 | MEDIUM | Architecture
**Module-level mutable state via init-pattern singletons (6 modules)**

- **Locations:** `alerts.ts`, `coingecko.ts`, `coingecko-onchain.ts`, `chain-registry.ts`, `rate-limit.ts`
- **Description:** Workers platform constraint -- `Env` bindings unavailable at module init. Re-initialized on every request (idempotent but wasteful). Risk: new developer adds module-scoped `let` expecting cross-isolate persistence.
- **Remediation:** Consider lint rule flagging module-level `let` in worker code. Document in `docs/worker-infrastructure.md` (partially done).

---

#### S-005 | MEDIUM | Configuration
**Google Analytics tracking ID hardcoded in layout**

- **Location:** `src/app/layout.tsx:92-98` -- hardcoded `G-6TS0KG8H04`
- **Description:** Cannot be disabled for staging/preview deployments. Preview deploys send events to production GA.
- **Remediation:** Use `NEXT_PUBLIC_GA_ID` env variable, render Script tag only when set.

---

#### S-006 | MEDIUM | Modularity
**116 components in flat directory structure**

- **Location:** `src/components/` -- 116 `.tsx` files at root, only 3 subdirectories
- **Description:** Largest components (`flow-machine-scene.tsx` 929 lines, `contagion-graph.tsx` 781 lines, `yield-history-chart.tsx` 682 lines) mix data transformation with rendering. Flat structure provides no signal about feature ownership.
- **Remediation:** Group by feature domain (`components/depeg/`, `components/yield/`, `components/flows/`, `components/dependency-map/`) while keeping `components/ui/` as-is.

---

#### S-007 | MEDIUM | Scalability
**Daily 08:00 UTC slot fans out 5 ctx.waitUntil() jobs sharing 6-connection pool**

- **Location:** `worker/src/handlers/scheduled/daily-0800.ts`
- **Description:** 5 cron jobs dispatched in parallel. `sync-usds-status` and `fetch-tbill-rate` both make external HTTP calls. Adding a third external-facing job creates connection contention.
- **Remediation:** Sequence external-fetch jobs after DB-only snapshot jobs, mirroring the quarter-hourly pattern. Document connection budget per slot.

---

#### S-008 | MEDIUM | Build Pipeline
**No SAST security scanning in CI**

- **Location:** `.github/workflows/deploy-cloudflare.yml`
- **Description:** Runs `npm audit` for dependency vulns but no static application security testing. Codebase handles 17 distinct secrets.
- **Remediation:** Add `semgrep` or `eslint-plugin-security` to the validate job.

---

#### S-009 | MEDIUM | Dependencies
**TypeScript version pinned to `^5` (floating major)**

- **Location:** Both `package.json` and `worker/package.json`
- **Description:** Will accept TS 6.0 when released. Major versions regularly introduce breaking changes.
- **Remediation:** Pin to specific minor range (e.g., `~5.7.0`).

---

#### S-010 | LOW | Documentation
No human-contributor quickstart (CLAUDE.md is agent-oriented). Minor gap given current team size.

#### S-011 | LOW | Architecture (STRENGTH)
Multi-layered import boundary enforcement: tsconfig exclusion, ESLint rules, CI script. Zero violations found.

#### S-012 | LOW | Architecture (STRENGTH)
Cron schedule synchronization verified by `scripts/check-cron-schedule-sync.ts`. Prevents config/code drift.

#### S-013 | LOW | Build Pipeline
No Dependabot/Renovate configuration. Dependencies currently up-to-date but will drift.

#### S-014 | LOW | Scalability
In-memory rate limiter `ipCounts` grows unbounded within an isolate between 1000-request prune cycles. Mitigated by D1 primary limiter.

#### S-015 | LOW | Configuration (STRENGTH)
Exemplary environment variable documentation: `.env.example` with 30+ vars, `Env` interface matches exactly, full table in `docs/worker-infrastructure.md`.

#### S-016 | LOW | Modularity (STRENGTH)
Well-decoupled cron job architecture: each job is standalone `(db, signal) => Promise`, composed via slot handlers with dependency ordering.

#### S-017 | LOW | Dependencies (STRENGTH)
Lean dependency set: 14 frontend runtime deps, 3 worker deps. All actively maintained. Zero known vulnerabilities.

#### S-018 | LOW | Build Pipeline (STRENGTH)
Tiered test infrastructure: 208 test files, `test:critical-contracts`, `test:invariants`, `coverage:critical` with per-file thresholds, delta-aware merge gate.

---

## 3. Cross-Cutting Concerns

### CC-001: Depeg Detection -- Complexity x Testing x Sustainability
**References:** Q-006, Q-015, Q-019

The depeg detection pipeline is the system's highest-consequence business logic (visible to all users, drives Telegram alerts, feeds safety scores). It is simultaneously:
- **Overly complex** (Q-006): 307-line function, 5-level nesting, interleaved concerns
- **Undertested** (Q-015): No orchestration-level test coverage despite being the most complex cron job
- **Internally redundant** (Q-019): Same `sumPegBuckets` computation performed twice per loop iteration

This combination creates maximum regression risk. A decomposition that enables unit testing of each decision path is the highest-value remediation in the entire audit.

### CC-002: Data Boundary Validation -- Quality x Sustainability
**References:** Q-005, Q-012, S-001

Three data boundaries lack runtime validation:
- Stablecoins cache (Q-005): system's most critical data path
- Feedback endpoint (Q-012): public-facing user input
- Stablecoin metadata (S-001): 4,637-line file with no schema validation

Adding Zod validation at these boundaries would catch malformed data at entry points rather than allowing it to propagate downstream. The Zod dependency already exists in the project.

### CC-003: Auth Security -- Quality x Build Pipeline
**References:** Q-001, Q-002, S-008

The security posture depends entirely on infrastructure-layer guarantees (Cloudflare Access for admin, URL secrecy for Telegram) with no application-layer defense-in-depth. The absence of SAST scanning (S-008) means these patterns won't be flagged automatically if they regress or are replicated in new endpoints.

### CC-004: Monolithic Files -- Redundancy x Sustainability
**References:** Q-013, S-001, S-003, S-006

Four structural bottlenecks concentrate change risk:
- `shared/lib/stablecoins.ts` (4,637 lines) -- every coin addition
- `worker/src/cron/sync-blacklist.ts` (1,258 lines) -- entire pipeline
- `worker/src/lib/db.ts` (534 lines) -- 5 unrelated responsibilities
- `src/components/` (116 flat files) -- discoverability

These are the files most likely to cause merge conflicts in parallel development. Decomposition follows proven internal patterns (`dex-liquidity/`, `mint-burn-pipeline/`, `stablecoin-detail/`).

---

## 4. Prioritized Remediation Roadmap

### Phase 1: Quick Wins (Low effort, high impact)

| ID | Action | Files | Effort |
|----|--------|-------|--------|
| Q-002 | Move Telegram webhook secret to header, use timing-safe comparison | `worker/src/api/telegram-webhook.ts` | Small |
| R-007 | Remove `formatAge` passthrough wrapper | `src/components/status/format.ts`, 2 consumers | Small |
| R-008 | Remove redundant `toMethodologyVersionLabel` re-exports | 3 version files, 5 API consumers | Small |
| R-009 | Remove type/const aliases in `cron-config.ts` | `src/components/status/cron-config.ts`, 2 consumers | Small |
| Q-010 | Rename `pass4` to `passDex` in `EnrichmentStats` | `worker/src/cron/enrich-prices.ts` | Small |
| Q-011 | Add `console.warn` to silent catch blocks | 5 locations across cron jobs | Small |
| S-005 | Move GA tracking ID to env variable | `src/app/layout.tsx` | Small |
| S-009 | Pin TypeScript to `~5.x.0` minor range | Both `package.json` files | Small |
| S-013 | Add Dependabot config for security updates | `.github/dependabot.yml` | Small |
| R-006 | Replace `formatFlowValue` with `formatCurrency` | `src/components/flow-comparison-chart.tsx` | Small |

### Phase 2: Targeted Refactoring (Medium effort, high value)

| ID | Action | Files | Effort | Dependencies |
|----|--------|-------|--------|-------------|
| Q-005 | Add Zod validation to stablecoins cache boundary | `worker/src/lib/stablecoins-cache.ts` | Medium | None |
| Q-012 | Add Zod validation to feedback endpoint | `worker/src/api/feedback.ts` | Medium | None |
| Q-015 | Add depeg detection integration tests | New test file | Medium | Q-006 benefits from this but not required |
| Q-016 | Expand stablecoin detail handler test coverage | `worker/src/api/__tests__/stablecoin-detail.test.ts` | Medium | None |
| R-001 | Consolidate binary search implementations | 3 files in worker/ | Medium | None |
| R-002 | Create generic table comparator factory | 4 `*-table-logic.ts` files + new factory | Medium | None |
| R-004 | Extract shared `useIsMobile` hook | 2 chart components + new hook | Small | None |
| R-011 | Extract shared chart Y-domain utility | 3 chart components + new utility | Small | None |
| R-005 | Extract series merge utility | 2 comparison charts + new utility | Small | None |
| Q-008 | Extract `normalizeOrigin` from Pages Functions | 2 files under `functions/` | Small | None |
| S-008 | Add SAST scanning to CI | `.github/workflows/deploy-cloudflare.yml` | Medium | None |
| S-002 | Add LIMIT/pagination to unbounded queries | `worker/src/api/stability-index.ts`, `dex-liquidity.ts` | Medium | None |

### Phase 3: Structural Improvements (Higher effort, sustainability-focused)

| ID | Action | Files | Effort | Dependencies |
|----|--------|-------|--------|-------------|
| Q-006 | Decompose `detectDepegEvents` into pure evaluation + orchestrator | `worker/src/cron/detect-depegs.ts` | Large | Q-015 tests first |
| Q-013 | Split `sync-blacklist.ts` into module directory | New `worker/src/cron/sync-blacklist/` | Large | None |
| S-003 | Split `db.ts` into focused modules | `worker/src/lib/db.ts` -> `db-cache.ts`, `cron-lease.ts` | Large | None |
| S-006 | Organize components into feature directories | `src/components/` restructuring | Large | None |
| S-007 | Sequence daily-0800 cron slot connection budget | `worker/src/handlers/scheduled/daily-0800.ts` | Small | None |
| R-003 | Standardize on single admin auth pattern | `worker/src/lib/auth.ts` + 18 consumers | Medium | None |
| R-010 | Standardize version file factory usage | 2 version files | Small | None |

### Phase 4: Strategic Overhauls (Major effort, long-term value)

| ID | Action | Files | Effort | Dependencies |
|----|--------|-------|--------|-------------|
| Q-001 | Implement application-layer JWT validation for admin auth | `worker/src/lib/auth.ts` | Large | Security review |
| S-001 | Split monolithic stablecoins.ts (4,637 lines) | `shared/lib/stablecoins.ts` -> per-category files or structured data format | Large | Build-time validation tooling |
| Q-007 | Migrate `fetchWithRetry` to result-type return | `worker/src/lib/fetch-retry.ts` + 40+ consumers | Large | Phased migration |

---

## 5. Appendices

### 5A. File-by-File Finding Index

| File | Findings |
|------|----------|
| `functions/api/admin/[[path]].ts` | Q-008 |
| `functions/status/[[path]].ts` | Q-008 |
| `shared/lib/blacklist-tracker-version.ts` | R-008 |
| `shared/lib/depeg-dews-version.ts` | R-008 |
| `shared/lib/redemption-backstop-version.ts` | R-010 |
| `shared/lib/safety-score-version.ts` | R-010 |
| `shared/lib/stability-index-version.ts` | R-008 |
| `shared/lib/stablecoins.ts` | S-001 |
| `src/app/layout.tsx` | S-005 |
| `src/components/blacklist-table-logic.ts` | R-002 |
| `src/components/comparison-chart.tsx` | R-005 |
| `src/components/depeg-table-logic.ts` | R-002 |
| `src/components/flow-comparison-chart.tsx` | R-005, R-006 |
| `src/components/liquidity-table-logic.ts` | R-002 |
| `src/components/mcap-chart.tsx` | R-011 |
| `src/components/peg-diversity-chart.tsx` | R-011 |
| `src/components/psi-history-chart.tsx` | R-004 |
| `src/components/status/cron-config.ts` | R-009 |
| `src/components/status/format.ts` | R-007 |
| `src/components/total-mcap-chart.tsx` | R-011 |
| `src/components/yield-scatter-plot.tsx` | R-004 |
| `src/components/yield-table-logic.ts` | R-002 |
| `worker/src/api/backfill-depegs.ts` | R-001 |
| `worker/src/api/backfill-mint-burn.ts` | Q-009 |
| `worker/src/api/dex-liquidity.ts` | S-002 |
| `worker/src/api/feedback.ts` | Q-012 |
| `worker/src/api/stability-index.ts` | S-002 |
| `worker/src/api/stablecoin-detail.ts` | Q-016 |
| `worker/src/api/telegram-webhook.ts` | Q-002 |
| `worker/src/cron/announce-cemetery-additions.ts` | Q-011 |
| `worker/src/cron/daily-digest.ts` | Q-011 |
| `worker/src/cron/detect-depegs.ts` | Q-006, Q-015, Q-019 |
| `worker/src/cron/confirm-pending-depegs.ts` | Q-015 |
| `worker/src/cron/enrich-prices.ts` | Q-010 |
| `worker/src/cron/sync-blacklist.ts` | Q-013, Q-017 |
| `worker/src/cron/sync-stablecoin-charts.ts` | Q-011 |
| `worker/src/handlers/scheduled/daily-0800.ts` | S-007 |
| `worker/src/lib/api-utils.ts` | Q-014 |
| `worker/src/lib/alerts.ts` | Q-021, S-004 |
| `worker/src/lib/auth.ts` | Q-001, R-003 |
| `worker/src/lib/authoritative-price-sources.ts` | R-001, Q-011 |
| `worker/src/lib/circuit-breaker.ts` | Q-004 |
| `worker/src/lib/db.ts` | S-003 |
| `worker/src/lib/fetch-retry.ts` | Q-007 |
| `worker/src/lib/psi-recompute.ts` | R-001 |
| `worker/src/lib/rate-limit.ts` | Q-003, S-014 |
| `worker/src/lib/stablecoins-cache.ts` | Q-005 |

### 5B. Dependency Audit Summary

| Category | Status |
|----------|--------|
| Known vulnerabilities | 0 (`npm audit --audit-level=high --omit=dev` clean) |
| Abandoned packages | None detected |
| Outdated packages | All current (Next.js 16.1.6, React 19.2.4, TanStack Query 5.90, Zod 4.3) |
| Duplicate functionality | None (lean, non-overlapping dependency set) |
| Lock file integrity | Healthy |
| Automated updates | Missing (no Dependabot/Renovate -- S-013) |
| Version pinning risk | TypeScript `^5` floats on major (S-009) |

### 5C. Documented Strengths

The audit identified 5 notable strengths that should be preserved:

1. **S-011:** Multi-layered import boundary enforcement (tsconfig + ESLint + CI script). Zero violations.
2. **S-012:** Automated cron schedule sync validation prevents config/code drift.
3. **S-015:** Exemplary env variable documentation (`.env.example`, `Env` interface, docs table all aligned).
4. **S-016:** Well-decoupled cron architecture via standalone `(db, signal) => Promise` pattern.
5. **S-017/S-018:** Lean dependencies + tiered test infrastructure with per-file coverage gates and delta-aware merge gate.

### 5D. Glossary

| Term | Definition |
|------|-----------|
| CAS | Compare-and-swap: atomic read-modify-write pattern |
| Circuit breaker | Pattern that stops calling a failing external service, with periodic probes to detect recovery |
| D1 | Cloudflare's serverless SQLite database |
| DEWS | Daily Early Warning System -- composite stress signal for stablecoins |
| DRY | Don't Repeat Yourself -- principle against code duplication |
| Half-open | Circuit breaker state allowing a single probe request to test if service has recovered |
| PSI | Pharos Stability Index -- ecosystem-level health metric |
| SAST | Static Application Security Testing |
| SRP | Single Responsibility Principle |
| TOCTOU | Time-of-check to time-of-use: race condition between checking a condition and acting on it |
