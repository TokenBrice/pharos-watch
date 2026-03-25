# Comprehensive Codebase Audit Report

**Date:** 2026-03-25
**Scope:** Full codebase — 1,102 TypeScript/TSX files, ~209,000 lines of code
**Build status:** Clean (build, lint, worker type-check all pass)

---

## 1. Executive Summary

### Finding Counts

| Pillar | Critical | High | Medium | Low | Total |
|--------|----------|------|--------|-----|-------|
| Redundancy | 0 | 0 | 5 | 6 | 11 |
| Code Quality | 0 | 0 | 7 | 9 | 16 |
| Sustainability | 0 | 0 | 6 | 8 | 14 |
| **Totals** | **0** | **0** | **18** | **23** | **41** |
| Cross-Cutting | — | — | 5 | — | 5 |

### Overall Health Ratings

| Pillar | Rating (1–10) | Justification |
|--------|:---:|---|
| **Redundancy** | **8/10** | Strong centralization patterns (shared/lib, createTableComparator factory, createClientFeaturePage). Duplication is minor and localized — primarily magic numbers, a few utility clones, and one unused abstraction. No systemic duplication. |
| **Code Quality** | **8.5/10** | Zero critical or high-severity findings. Parameterized SQL throughout, Zod at boundaries, timing-safe auth, circuit breakers, 317 test files. The remaining gaps are unsafe casts on external data and missing error boundaries on some pages. |
| **Sustainability** | **9/10** | Exceptionally mature for its size. Three-layer module boundary enforcement (tsconfig + ESLint + CI script), 14-step merge gate, coverage ratchets, hotspot complexity guards, 57-document doc corpus with CI-enforced sync, and pinned GitHub Actions. Few codebases at any scale reach this level. |

### Technical Debt Profile

Approximately **5–8%** of the codebase is affected by significant findings. The vast majority of the codebase follows consistent, well-enforced patterns. The findings are concentrated in:
- Worker cron/lib modules: unsafe casts on external API data (Q-001/002/003/011)
- Frontend: missing error boundaries and untested view-model hooks (Q-009/015, S-017)
- Worker-wide: 166 instances of hardcoded `86400` instead of the available constant (R-004)

### Top 5 Critical Findings

1. **CC-003: Frontend resilience gap** — Missing error boundaries on 10+ data-heavy pages, untested view-model hooks, and 19% component test coverage create compound risk. A single rendering error crashes an entire page with no graceful fallback.
2. **Q-001/002/011: Unsafe casts on external data** — Three worker modules cast external API responses (CoinGecko, Bluechip, DefiLlama) without runtime validation. Shape changes would produce silent `NaN` or incorrect type values flowing into scoring algorithms.
3. **R-004: Magic number proliferation** — `86400` appears 166 times across 64 worker files despite `DAY_SECONDS` and `SECONDS.ONE_DAY` being available. Harms readability and makes time-unit changes error-prone.
4. **S-008: Sparse inline documentation in worker** — Complex scoring algorithms (DEWS, PSI, stability index, price consensus) lack function-level JSDoc. The external `/docs/` are excellent, but onboarding to the algorithmic internals requires source reading with minimal guidance.
5. **S-013: Cron connection budget pressure** — 26 jobs across 10 triggers are approaching the per-trigger 6-connection limit. No CI check validates the budget, so job rebalancing could silently overcommit.

---

## 2. Findings by Pillar

### Pillar A — Redundancy

#### Medium Severity

**R-001 | Code Duplication | Medium**
Local `clamp()` duplicates `shared/lib/math.ts`

Two files define their own `clamp()` instead of importing the shared one:
- `src/lib/yield-scatter.ts:25`
- `src/components/minting-pressure-gauge.tsx:20`

Nine other files already correctly import from `@shared/lib/math`.

*Consolidation:* Replace both with `import { clamp } from "@shared/lib/math"`.

---

**R-002 | Code Duplication | Medium**
`GRADE_COLORS` in OG template duplicates `GRADE_RADAR_COLORS`

- `worker/src/lib/og-templates/shared.tsx:21-26` — defines `GRADE_COLORS`
- `shared/lib/report-cards.ts:128-135` — defines `GRADE_RADAR_COLORS`

Values are semantically identical (same hex per grade range), with 2 minor hex variants for A+/A.

*Consolidation:* Import `GRADE_RADAR_COLORS` from `@shared/lib/report-cards` in the OG module. Reconcile the 2 differing hex values in the canonical source.

---

**R-004 | Code Duplication | Medium**
Hardcoded `86400` used 166 times instead of `DAY_SECONDS`

- `shared/lib/time-constants.ts` exports `DAY_SECONDS = 86400`
- `worker/src/lib/time-constants.ts` re-exports as `SECONDS.ONE_DAY`
- Raw `86400` appears 166 times across 64 worker files (e.g., `compute-dews.ts:218`, `stability-index.ts:233`)
- Some files create local aliases (`DAY_SEC`) rather than using the canonical constant

*Consolidation:* Replace raw `86400` literals with `DAY_SECONDS` or `SECONDS.ONE_DAY`. Expressions like `7 * 86400` become `7 * DAY_SECONDS`.

---

**R-005 | Code Duplication | Medium**
Inline Tailwind color classes repeated across 37+ components

The pattern `"text-emerald-700 dark:text-emerald-400"` (and its red/amber variants) is used as raw string literals in 37+ files, despite `src/lib/severity-colors.ts` providing centralized color helpers.

Examples:
- `src/components/balance-bar.tsx:4`
- `src/components/dex-liquidity-card.tsx:43,54`
- `src/components/liquidity-table.tsx:149`
- `src/components/market-highlights.tsx:191`

*Consolidation:* Add semantic helpers (e.g., `tierColorClass(ratio, thresholds)`) to `severity-colors.ts`. Replace only genuinely identical patterns — some threshold mappings are domain-specific and should stay local.

---

**R-006 | Dead Code | Medium**
`DataTableShell` component unused in production

- `src/components/data-table-shell.tsx` — 103-line generic table shell
- Only imported by its own test file
- All 14 actual tables import directly from `ui/table` and `sortable-table-head`

*Consolidation:* Remove `data-table-shell.tsx` and its test, or migrate tables to use it.

---

#### Low Severity

**R-003 | Code Duplication | Low**
`truncateTeaser()` in `src/lib/pre-launch.ts:155` duplicates `trimTextAtWordBoundary()` in `src/lib/page-metadata.ts:36`. The latter is more robust (trailing punctuation trimming, safety cutoff). `truncateTeaser` has one consumer (`upcoming-stablecoins-section.tsx`).

*Consolidation:* Replace `truncateTeaser` with `trimTextAtWordBoundary`.

---

**R-007 | Code Duplication | Low**
`worker/src/api/mint-burn-flows-shared.ts:46` creates `DAY_SEC = DAY_SECONDS` — a third alias for the same constant (alongside `DAY_SECONDS` and `SECONDS.ONE_DAY`).

*Consolidation:* Use `DAY_SECONDS` directly.

---

**R-009 | Redundant Dependencies | Low**
Both `radix-ui` (1.4.3) and 7 individual `@radix-ui/react-*` packages installed. The umbrella re-exports primitives the individual packages also provide.

*Consolidation:* Standardize on one approach — either all via `radix-ui` or all via `@radix-ui/react-*`.

---

**R-010 | Redundant Dependencies | Low**
`viem` (48MB) used for only 3 functions in 1 worker file (`worker/src/cron/dex-liquidity/fetch-slipstream.ts`): `decodeFunctionResult`, `encodeFunctionData`, `parseAbi`.

*Consolidation:* Accept as worker-only (doesn't affect frontend bundle) or evaluate a lighter ABI encoding alternative.

---

**R-013 | Code Duplication | Low**
`formatBillions()` in `src/components/total-mcap-chart.tsx:22` partially duplicates `formatCompactUsd()` from `shared/lib/format.ts`. Difference: whitespace before "B" and decimal precision (1 vs 2). May be intentional for chart-axis readability.

*Consolidation:* Accept as chart-specific formatting or add a precision option to `formatCompactUsd`.

---

**R-014 | Code Duplication | Low**
Inline currency formatting in worker log messages (`worker/src/cron/detect-depegs.ts:136,173,193`, `worker/src/lib/telegram-alerts.ts:237`) duplicates `formatCurrency()` but with slightly different precision for log context.

*Consolidation:* Low priority. Log messages often need specific precision.

---

### Pillar B — Code Quality

#### Medium Severity

**Q-001 | Type Safety | Medium**
Unsafe cast on parsed JSON in `worker/src/cron/compute-dews.ts:464-466`

`(p.extra as Record<string, unknown>)?.balanceRatio as number` — double unsafe cast on deserialized DB data. If `top_pools_json` changes shape, this silently produces `NaN` flowing into DEWS computation.

*Remediation:* Define a lightweight Zod schema for pool entries and use `safeParse`.

---

**Q-002 | Type Safety | Medium**
Zod-then-cast pattern in `worker/src/cron/sync-bluechip.ts:132-146`

Zod validates `grade` as `z.string()`, then code immediately casts `coin.grade as BluechipGrade`. An unexpected grade value bypasses validation.

*Remediation:* Use `z.enum(["A+", "A", "B+", ...])` in the Zod schema and consume the validated output directly.

---

**Q-003 | Type Safety | Medium**
Multiple `as Record<string, ...>` casts on DefiLlama data in `worker/src/cron/sync-stablecoins/stages.ts:42,53,84-89,97-102`

External API data is cast without runtime validation. The `normalizeChainCirculating` function guards with `typeof` checks (acceptable), but `compareCanonicalAssetQuality` (lines 82-108) would benefit from a helper with type narrowing.

*Remediation:* Extract a typed bucket-summing helper to reduce cast proliferation.

---

**Q-007 | Design Pattern | Medium**
`parseIntParam`/`parseFloatParam` return `number | Response` in `worker/src/lib/api-utils.ts:254-290`

Every handler has 2-4 lines of boilerplate per parameter: `const x = parseIntParam(...); if (x instanceof Response) return x;`.

*Remediation:* A combined parser returning a validated object or error response could reduce boilerplate. Low priority — the current pattern is consistent and well-understood.

---

**Q-008 | Complexity | Medium**
Telegram webhook handler at `worker/src/api/telegram-webhook.ts` (562 lines)

Largest API handler. Combines routing, business logic, and response formatting. Already decomposed into 5 supporting files, but `handleSubscribe`/`handleUnsubscribe`/`handleSet` follow the same pattern.

*Remediation:* Collapse the three similar handlers into a single generic `handleTickerCommand` with an action-type parameter (~80 lines reduction).

---

**Q-009 | Testing | Medium**
Multiple frontend view-model hooks lack test coverage

Untested hooks with non-trivial business logic:
- `src/hooks/use-compare-data-model.ts`
- `src/hooks/use-coverage-matrix-model.ts`
- `src/hooks/use-stablecoin-detail-view-model.ts`
- `src/hooks/use-stablecoin-detail-history.ts`
- `src/hooks/use-homepage-filters.ts`
- `src/hooks/use-mint-burn-flows.ts`
- `src/hooks/use-status-dashboard-model.ts`
- `src/hooks/use-depeg-events.ts`
- `src/hooks/use-chains.ts`

*Remediation:* Add unit tests for hooks with significant derivation logic, or extract pure computation into standalone functions (as done with `stablecoin-detail-derive.ts`) and test those.

---

**Q-015 | Error Handling | Medium**
Only 3 pages use `SectionErrorBoundary`

`SectionErrorBoundary` exists in `src/components/section-error-boundary.tsx` but is only used in `homepage-client.tsx`, `stablecoin/[id]/client.tsx`, and `depeg/client.tsx`. Pages with complex client-side rendering (portfolio, compare, flows, liquidity, chains, coverage, status, yield) have no error boundary.

*Remediation:* Wrap main client content of data-heavy pages with `SectionErrorBoundary`. Low-effort, high-value.

---

#### Low Severity

**Q-004 | Type Safety | Low**
`src/lib/api.ts:168` — When no Zod schema provided, `apiFetch` returns `data as T`. Known tradeoff documented by `contractMode`.

*Remediation:* No change needed. Consider a lint convention marking callsites that deliberately skip validation.

---

**Q-005 | Security | Low**
`worker/src/api/blacklist.ts:131` — LIKE wildcards (`%`, `_`) in user-supplied `query` parameter are not escaped. Not SQL injection, but allows broader matching than intended.

*Remediation:* Escape LIKE wildcards before binding, add `ESCAPE '\\'` to the clause.

---

**Q-006 | Error Handling | Low**
`worker/src/lib/response-body.ts:11` — Empty catch block in `drainResponseBody`. Intentional best-effort body cancellation.

*Remediation:* Add a brief comment: `/* expected: body already consumed or cancelled */`.

---

**Q-010 | Testing | Low**
Frontend lib files with business logic lack tests: `portfolio-codec.ts`, `stablecoin-detail-derive.ts`, `flow-signal-ui.ts`, `liquidity-coverage.ts`, `peg-stability.ts`.

*Remediation:* Add tests for `portfolio-codec.ts` (URL encoding/migration logic) and `stablecoin-detail-derive.ts` at minimum.

---

**Q-011 | Error Handling | Low**
`worker/src/cron/confirm-pending-depegs.ts:186` — CoinGecko response cast as `Record<string, { usd?: number }>` without validation.

*Remediation:* Add a Zod schema or basic shape check for the CoinGecko simple/price response.

---

**Q-012 | Design Pattern | Low**
`worker/src/lib/stablecoins-cache.ts:19` — `validateStablecoinEntry` validates only `id`/`symbol` then casts entire result as `StablecoinData`. Documented as intentional passthrough.

*Remediation:* Add JSDoc noting callers should treat optional fields as potentially absent.

---

**Q-013 | Security | Low**
`worker/src/lib/env.ts:39` — Hardcoded `PUBLIC_API_RATE_LIMIT_SALT_FALLBACK`. For local dev only; production should always set the real salt. Warning system already in place.

*Remediation:* No change needed for production. Consider making fallback include a timestamp for dev.

---

**Q-016 | Security | Low**
`worker/src/api/telegram-webhook.ts:56-61` — Webhook secret can be passed via URL query parameter (backward compatibility). Secrets in URLs appear in logs and cache keys.

*Remediation:* If migration is complete, remove the query parameter fallback. If not, add a deprecation timeline and log a warning.

---

**Q-017 | Design Pattern | Low**
`worker/src/lib/rate-limit.ts:22-27` — Module-level mutable state for deprecated in-memory rate limiter. D1-backed limiter is the active path.

*Remediation:* Remove deprecated `checkRateLimit` and its state once confirmed unused. (Overlaps with S-001.)

---

### Pillar C — Sustainability & Maintainability

#### Medium Impact

**S-003 | Dependencies | Medium**
Dual `radix-ui` installation

`radix-ui` (1.4.3) coexists with 7 individual `@radix-ui/react-*` packages. May cause duplicate module resolution or version drift.

*Remediation:* Audit usage. If only individual packages are used, remove the umbrella. Or migrate all consumers to the umbrella. (Overlaps R-009.)

---

**S-008 | Documentation | Medium**
Sparse inline documentation in worker algorithmic modules

Complex scoring modules (`price-consensus.ts`, `safety-scores.ts`, `stability-index.ts`, `dews.ts`, depeg detection) lack function-level JSDoc. The `/docs/` corpus is excellent for system-level understanding but insufficient for algorithmic internals.

*Remediation:* Add JSDoc to the most algorithmically dense modules. The `/docs/` system docs serve as the "why" layer; inline docs explain the "how."

---

**S-010 | Modularity | Medium**
`shared/types/index.ts` barrel re-exports 12 sub-modules

Both frontend and worker import from `@shared/types`. Any type surface change invalidates the entire barrel for TypeScript incremental compilation.

*Remediation:* Consider direct sub-module imports (e.g., `@shared/types/core`) for worker code while keeping the barrel for frontend convenience. Introduce incrementally.

---

**S-012 | Build/Deploy | Medium**
Merge gate runs 14+ sequential checks on every push

Full gate likely takes 3-7 minutes. Already skips build/SEO when no Pages files changed, but all other checks always run.

*Remediation:* Extend the `getChangedFiles()` infrastructure to skip more checks when their inputs haven't changed (e.g., skip `check:migrations` when no migration files changed).

---

**S-013 | Scalability | Medium**
Cron connection budget approaching limits

26 jobs across 10 triggers. The `halfHourlyOffset` trigger runs 5 shared jobs whose aggregate outbound connections could approach 6 during slow responses. No CI check validates per-trigger budgets.

*Remediation:* Add a CI check validating per-trigger connection sums don't exceed 6 (similar to existing `check:cron-sync`).

---

**S-017 | Modularity | Medium**
Component test coverage at ~19% by file count

144 component files, 27 test files. Tests focus on logic-heavy areas (correct prioritization), but many presentation components with conditional rendering lack coverage.

*Remediation:* Gradually add render tests for frequently modified presentation components. Infrastructure is already configured.

---

#### Low Impact

**S-001 | Architecture | Low**
Deprecated in-memory rate limiter persists in `worker/src/lib/rate-limit.ts:22-29`. Module-scope mutable state (`ipCounts` Map, counters) coexists with the active D1-backed limiter.

*Remediation:* Remove `checkRateLimit` and associated state once confirmed unused. (Overlaps Q-017.)

---

**S-002 | Architecture | Low**
Route registry runtime exhaustiveness check in `worker/src/route-registry.ts:260-274` runs on every cold start. A misconfigured endpoint causes a production crash rather than a build/test failure.

*Remediation:* No action needed — comprehensive test suite already validates. The fail-at-cold-start approach is arguably a safer default for string-keyed config.

---

**S-005 | Configuration | Low**
Frontend env vars (`NEXT_PUBLIC_API_BASE`, `NEXT_PUBLIC_GA_ID`) lack compile-time validation equivalent. Rely on graceful fallback in `resolveApiBase()`.

*Remediation:* Optional polish. The fallback is well-designed for the static-export model.

---

**S-006 | Configuration | Low**
D1 `database_id` hardcoded in `wrangler.toml`. Standard for single-environment, but precludes staging without overrides.

*Remediation:* Adopt `[env.staging]` pattern when multi-environment becomes necessary.

---

**S-014 | Scalability | Low**
85 D1 migration files. Fresh setup requires sequential replay.

*Remediation:* Consider periodic squash migration (e.g., every 50 files).

---

**S-016 | Architecture | Low**
`src/lib/api.ts:15-25` — Hardcoded domain detection for `pharos.watch` and `stablecoin-dashboard.pages.dev`. Inherent constraint of static export.

*Remediation:* Document behavior. No change until SSR migration.

---

**S-019 | Architecture | Low**
Time constants defined in both `shared/lib/time-constants.ts` and `worker/src/lib/time-constants.ts`. Risk of drift without a sync check.

*Remediation:* Verify the worker module re-exports from shared (it does). No action needed.

---

**S-020 | Scalability | Low**
D1 as both primary database and cache layer. Single `cache` table serves all cron jobs, API handlers, and circuit breaker state.

*Remediation:* Monitor D1 metrics. If contention grows, consider Cloudflare KV for hot-path reads.

---

## 3. Cross-Cutting Concerns

### CC-001: Radix UI Dependency Overlap
**Spans:** R-009 (Redundancy), S-003 (Sustainability)

Both `radix-ui` (umbrella) and 7 individual `@radix-ui/react-*` packages are installed. This creates potential for duplicate module resolution, version drift, and developer confusion about which import path to use.

**Unified remediation:** Audit which import style is used by each shadcn/ui component. Standardize on one. Remove the other. One PR, 10 minutes.

---

### CC-002: Worker Code Readability Deficit
**Spans:** R-004 (Redundancy), S-008 (Sustainability)

166 instances of hardcoded `86400` combine with sparse inline documentation to make complex worker algorithms (DEWS, stability index, price consensus, depeg detection) harder to understand than necessary. The raw numbers obscure the intent ("8 days" reads better than `8 * 86400`), and the lack of JSDoc means the reader must reverse-engineer algorithmic design.

**Unified remediation:** Phase the constant replacement (R-004) alongside JSDoc additions (S-008) — both improve the same files and can be done in a single pass per module.

---

### CC-003: Frontend Resilience Gap
**Spans:** Q-015 (Quality), Q-009 (Quality), S-017 (Sustainability)

Missing error boundaries on 10+ data-heavy pages, untested view-model hooks with significant derivation logic, and 19% component test coverage create a compound risk: if a data shape changes or an edge case occurs, the user sees a blank screen, and there are no tests to catch the regression beforehand.

**Unified remediation:** (1) Wrap data-heavy pages with `SectionErrorBoundary` (1-2 hours). (2) Add tests for the highest-risk view-model hooks (`use-stablecoin-detail-view-model.ts`, `use-compare-data-model.ts`). (3) Add tests for `portfolio-codec.ts` and `stablecoin-detail-derive.ts`.

---

### CC-004: Unsafe Casts on External Data
**Spans:** Q-001 (Quality), Q-002 (Quality), Q-003 (Quality), Q-011 (Quality)

Four worker modules cast external API/DB responses without runtime validation. These casts are in scoring-critical paths (DEWS, Bluechip sync, DefiLlama ingestion, depeg confirmation). A shape change in any external source would produce silent incorrect data rather than a visible error.

**Unified remediation:** Add lightweight Zod schemas for the 4 external response shapes. This also serves as documentation of the expected contract (addressing S-008).

---

### CC-005: Dead Code with Tests, Live Code Without
**Spans:** R-006 (Redundancy), Q-009 (Quality), S-017 (Sustainability)

`DataTableShell` is unused but has a test. Meanwhile, 9 view-model hooks and 5 lib modules with business logic have no tests. Test investment is misallocated.

**Unified remediation:** Remove `DataTableShell` and its test. Redirect testing effort to the untested hooks and libs identified in Q-009 and Q-010.

---

## 4. Prioritized Remediation Roadmap

### Phase 1 — Quick Wins
Low effort, high impact. Each item completable in isolation in under 30 minutes.

| Ref | Action | Files | Effort |
|-----|--------|-------|--------|
| R-001 | Replace local `clamp()` with shared import | `yield-scatter.ts`, `minting-pressure-gauge.tsx` | Small |
| R-002 | Import `GRADE_RADAR_COLORS` in OG template | `og-templates/shared.tsx` | Small |
| R-003 | Replace `truncateTeaser` with `trimTextAtWordBoundary` | `pre-launch.ts`, `upcoming-stablecoins-section.tsx` | Small |
| R-006 | Remove unused `DataTableShell` + test | `data-table-shell.tsx`, `data-table-shell.test.tsx` | Small |
| R-007 | Remove `DAY_SEC` alias | `mint-burn-flows-shared.ts` | Small |
| Q-005 | Escape LIKE wildcards in blacklist search | `blacklist.ts` | Small |
| Q-006 | Add comment in empty catch block | `response-body.ts` | Small |
| Q-015 | Add `SectionErrorBoundary` to data-heavy pages | 10+ page client files | Small |
| S-001/Q-017 | Remove deprecated in-memory rate limiter | `rate-limit.ts` | Small |

---

### Phase 2 — Targeted Refactoring
Medium effort, addressing specific quality and redundancy issues across 1-5 files.

| Ref | Action | Files | Effort | Depends On |
|-----|--------|-------|--------|------------|
| Q-001 | Add Zod schema for pool entries in DEWS | `compute-dews.ts` | Small | — |
| Q-002 | Strengthen Bluechip Zod schema with `z.enum` | `sync-bluechip.ts` | Small | — |
| Q-003 | Extract typed bucket-summing helper | `stages.ts` | Medium | — |
| Q-008 | Collapse subscribe/unsubscribe/set into generic handler | `telegram-webhook.ts` | Medium | — |
| Q-011 | Add Zod schema for CoinGecko simple/price response | `confirm-pending-depegs.ts` | Small | — |
| Q-016 | Remove webhook secret query param fallback (if migration complete) | `telegram-webhook.ts` | Small | Verify migration status |
| R-009/S-003 | Standardize Radix UI imports (umbrella or individual) | `package.json`, shadcn components | Medium | — |
| R-005 | Create semantic color helpers, replace inline ternaries | `severity-colors.ts`, 15-20 components | Medium | — |
| Q-009 | Add tests for priority view-model hooks | New test files for 3-4 hooks | Medium | — |
| Q-010 | Add tests for `portfolio-codec.ts` and `stablecoin-detail-derive.ts` | New test files | Medium | — |
| S-012 | Add fine-grained change detection to merge gate | `test-merge-gate.mjs` | Medium | — |

---

### Phase 3 — Structural Improvements
Higher effort, addressing sustainability and architectural concerns.

| Ref | Action | Files | Effort | Depends On |
|-----|--------|-------|--------|------------|
| R-004 | Replace 166 hardcoded `86400` with `DAY_SECONDS` | 64 worker files | Large | — |
| S-008 | Add JSDoc to algorithmically dense worker modules | `price-consensus.ts`, `safety-scores.ts`, `stability-index.ts`, `dews.ts`, `depeg-helpers.ts` | Large | — |
| S-013 | Add CI check for per-trigger connection budgets | New script, merge gate integration | Medium | — |
| S-010 | Migrate worker imports to direct `@shared/types/*` sub-modules | Worker type imports across ~50 files | Medium | — |
| S-017 | Expand component test coverage for conditional-rendering components | New test files for 10-15 components | Large | — |

---

### Phase 4 — Strategic Overhauls
Major efforts for long-term health. No immediate urgency.

| Ref | Action | Files | Effort | Depends On |
|-----|--------|-------|--------|------------|
| Q-007 | Redesign param parsing to return validated object | `api-utils.ts`, all API handlers | Large | — |
| S-014 | Squash D1 migrations to baseline | `worker/migrations/` | Large | Requires coordination with deploy pipeline |
| S-020 | Evaluate KV for hot-path cache reads | Worker cache layer | Large | D1 contention evidence |
| R-010 | Evaluate lighter alternative to viem | `fetch-slipstream.ts` | Medium | Only if install/CI time becomes a concern |

---

## 5. Appendices

### Appendix A — File-by-File Finding Index

| File | Findings |
|------|----------|
| `shared/lib/report-cards.ts` | R-002 |
| `shared/lib/format.ts` | R-013 |
| `shared/lib/time-constants.ts` | R-004 |
| `shared/types/index.ts` | S-010 |
| `src/components/data-table-shell.tsx` | R-006 |
| `src/components/minting-pressure-gauge.tsx` | R-001 |
| `src/components/balance-bar.tsx` | R-005 |
| `src/components/dex-liquidity-card.tsx` | R-005 |
| `src/components/liquidity-table.tsx` | R-005 |
| `src/components/market-highlights.tsx` | R-005 |
| `src/components/section-error-boundary.tsx` | Q-015 |
| `src/components/total-mcap-chart.tsx` | R-013 |
| `src/hooks/use-compare-data-model.ts` | Q-009 |
| `src/hooks/use-coverage-matrix-model.ts` | Q-009 |
| `src/hooks/use-stablecoin-detail-view-model.ts` | Q-009 |
| `src/hooks/use-homepage-filters.ts` | Q-009 |
| `src/hooks/use-mint-burn-flows.ts` | Q-009 |
| `src/hooks/use-status-dashboard-model.ts` | Q-009 |
| `src/lib/api.ts` | Q-004, S-016 |
| `src/lib/pre-launch.ts` | R-003 |
| `src/lib/page-metadata.ts` | R-003 |
| `src/lib/yield-scatter.ts` | R-001 |
| `src/lib/portfolio-codec.ts` | Q-010 |
| `src/lib/stablecoin-detail-derive.ts` | Q-010 |
| `worker/src/api/blacklist.ts` | Q-005 |
| `worker/src/api/mint-burn-flows-shared.ts` | R-007 |
| `worker/src/api/telegram-webhook.ts` | Q-008, Q-016 |
| `worker/src/cron/compute-dews.ts` | Q-001, R-004 |
| `worker/src/cron/confirm-pending-depegs.ts` | Q-011 |
| `worker/src/cron/detect-depegs.ts` | R-014 |
| `worker/src/cron/sync-bluechip.ts` | Q-002 |
| `worker/src/cron/sync-stablecoins/stages.ts` | Q-003 |
| `worker/src/lib/api-utils.ts` | Q-007 |
| `worker/src/lib/env.ts` | Q-013 |
| `worker/src/lib/og-templates/shared.tsx` | R-002 |
| `worker/src/lib/rate-limit.ts` | Q-017, S-001 |
| `worker/src/lib/response-body.ts` | Q-006 |
| `worker/src/lib/stablecoins-cache.ts` | Q-012 |
| `worker/src/lib/telegram-alerts.ts` | R-014 |
| `worker/src/lib/time-constants.ts` | R-004, S-019 |
| `worker/src/route-registry.ts` | S-002 |
| `worker/wrangler.toml` | S-006, S-013 |
| `scripts/test-merge-gate.mjs` | S-012 |
| `worker/migrations/` (85 files) | S-014 |
| `package.json` | R-009, R-010, S-003 |

### Appendix B — Dependency Audit Summary

| Package | Status | Notes |
|---------|--------|-------|
| `next` 16.2.1 | Current | Latest stable |
| `react` ^19.2.4 | Current | |
| `typescript` ~5.9.0 | Current | |
| `tailwindcss` 4.2.2 | Current | |
| `@tanstack/react-query` ^5.91.2 | Current | |
| `recharts` ^3.8.0 | Current | |
| `zod` ^4.3.6 | Current | |
| `viem` ^2.38.2 | Current | Worker-only, 48MB install size (R-010) |
| `radix-ui` 1.4.3 | Overlap | Coexists with individual packages (R-009/S-003) |
| `html-to-image` 1.11.13 | Monitor | Reports of stale maintenance (S-003) |
| `d3-force` ^3.0.0 | Current | Used for contagion graph |
| `vitest` ^4.1.0 | Current | |
| `eslint` ^9.39.4 | Current | |
| `eslint-plugin-security` ^4.0.0 | Current | |

All dependencies are within current major versions. No known vulnerabilities detected by `npm audit --audit-level=high --omit=dev` (integrated into merge gate).

### Appendix C — Glossary

| Term | Definition |
|------|------------|
| **DEWS** | Dynamic Early Warning Score — composite risk metric computed from multiple data signals |
| **PSI** | Peg Stability Index — measures how well a stablecoin maintains its target peg |
| **D1** | Cloudflare's serverless SQLite database |
| **Circuit breaker** | Pattern that stops calling a failing dependency after a threshold, allowing recovery |
| **Merge gate** | Local validation script mirroring CI, run before every push |
| **Hotspot ratchet** | CI check that prevents complexity growth in designated high-risk files |
| **Coverage ratchet** | CI check ensuring test coverage never decreases below a tracked baseline |
| **Barrel export** | A module (typically `index.ts`) that re-exports from multiple sub-modules |
| **Shadow asset** | An internal-only synthetic entry in the stablecoin registry (not user-visible) |
| **OG template** | Open Graph image template (SVG-based, rendered via satori/resvg on the Worker) |
| **SRP** | Single Responsibility Principle — each module/class should have one reason to change |

### Appendix D — Positive Patterns Worth Preserving

The audit identified several patterns that represent engineering excellence and should be maintained as the codebase evolves:

1. **Three-layer module boundary enforcement** (tsconfig + ESLint + CI script) — makes boundary violations nearly impossible to merge
2. **14-step merge gate with pre-push hook** — strong regression prevention
3. **Coverage and complexity ratchets** — prevent debt accumulation
4. **57-document corpus with CI-enforced sync** — documentation that can't drift from code
5. **Typed environment variable interfaces with runtime validation** — strong config management
6. **Circuit breakers + retry with backoff on all external API calls** — operational resilience
7. **Parameterized SQL throughout, Zod at boundaries, timing-safe auth** — security baseline
8. **Pinned GitHub Actions via commit SHA** — supply chain protection
9. **Cron lease fencing via D1** — prevents duplicate execution
10. **TanStack Query polling synced to cron intervals** — prevents over-fetching

---

*Report generated by three-agent parallel audit: Redundancy Analyst, Code Quality Auditor, and Sustainability Assessor.*
