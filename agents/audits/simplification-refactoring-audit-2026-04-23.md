# Simplification Refactoring Audit - 2026-04-23

## 1. Executive Summary

The codebase is in strong operational shape: there are clear route registries, shared runtime libraries, and a substantial guardrail suite, and exact copy-paste duplication is low. A `jscpd` scan over `src`, `shared`, `worker/src`, `functions`, and `scripts` found 12 clones and only 0.07% duplicated lines, excluding tests, shadcn primitives, data files, and migrations. The main maintainability issue is not raw copy-paste; it is parallel metadata and partially migrated helper patterns, where the same contract is represented in multiple places.

The single biggest structural issue is drift-prone duplicated source-of-truth data: endpoint access policy, public API artifact query metadata, cron schedule metadata, chain/peg/reserve metadata, and methodology versions are each split across adjacent modules. This has already produced at least one contract drift: `/api/mint-burn-flows` uses `hours` in the Worker, docs, and Postman, while the OpenAPI generator still emits `days`.

If all recommendations are implemented, the realistic net reduction is roughly 1,300-2,300 LOC, mostly from boilerplate, generated-artifact helpers, frontend scaffolding, and Worker wrapper cleanup. The larger benefit is reduced cognitive load and fewer hidden contract updates when adding routes, schedule slots, peg categories, admin endpoints, or generated public API artifacts.

## 2. Findings Table

| # | Category | Location | Description | Impact | Effort |
|---|----------|----------|-------------|--------|--------|
| 1 | Contract drift | `scripts/generate-openapi-spec.ts`, `scripts/generate-postman-collection.ts`, `shared/lib/api-endpoints/*`, `worker/src/api/mint-burn-flows.ts` | Public API artifacts duplicate endpoint/query metadata and one endpoint is already out of sync. | High | Medium |
| 2 | Metadata drift | `shared/lib/api-endpoints/definitions.ts` | Static endpoint definitions keep access policy in separate key sets instead of local endpoint records. | High | Medium |
| 3 | Wrapper duplication | `worker/src/routes/admin-routes.ts`, `worker/src/api/*`, `worker/src/lib/route-wrappers.ts` | Admin routes and handlers double-wrap auth/idempotency/no-store behavior. | High | Medium |
| 4 | Cron boilerplate | `worker/src/handlers/scheduled/*`, `shared/lib/cron-jobs.ts`, `shared/lib/scheduled-runner-registry.ts` | Scheduled slots partially use shared helpers but still repeat best-effort, circuit, and schedule mapping logic. | High | Medium |
| 5 | Frontend scaffolding | `src/components/homepage-client.tsx`, `src/app/*/client.tsx`, `src/components/*table*.tsx` | Query error/freshness notices, table skeletons, and stablecoin-table inputs repeat across pages. | Medium | Medium |
| 6 | Shared metadata duplication | `shared/types/core.ts`, `shared/lib/classification.ts`, `shared/lib/filter-tags.ts`, `shared/types/live-reserves.ts`, `shared/types/reserves.ts`, `shared/lib/chain-health*.ts` | Peg, grade, reserve-risk, coin-id, and chain-health version metadata have parallel definitions. | Medium | Low |
| 7 | Worker API helper debt | `worker/src/lib/api-params.ts`, `worker/src/lib/api-cache-read.ts`, `worker/src/lib/cache-json.ts`, `worker/src/api/*` | Query parsing, cached JSON decoding, paginated response shaping, and rate-limit primitives are only partly centralized. | Medium | Medium |
| 8 | Cron runtime utility drift | `worker/src/cron/dex-liquidity/*`, `worker/src/cron/dex-discovery/*`, `worker/src/cron/*run-state*`, `worker/src/lib/db.ts` | Fetch timeout handling, D1 batching, deadline budgets, progress reports, and cursor rotation repeat across cron jobs. | Medium | Medium |
| 9 | Script/check duplication | `scripts/generate-*.ts`, `scripts/lib/deploy-impact.mjs`, `scripts/check-doc-counts.mjs`, `scripts/lib/hotspot-ratchet*` | Generated artifact writers and validation checks contain repeated mechanics and some stale process state. | Medium | Low |
| 10 | Status/admin UI concentration | `src/components/status/api-keys-panel.tsx`, `src/components/status/cron-metadata-summary.ts`, `src/components/status/*health*.tsx` | Status components mix transport, model, form, row, empty-state, and parser concerns. | Medium | Medium |
| 11 | Large mixed modules | `src/lib/coverage.ts`, `src/lib/contagion-layout.ts`, `worker/src/cron/dispatch-telegram-alerts.ts`, `src/components/stablecoin-detail/hero-card.tsx` | Several files are maintainable but broad, combining data modeling, orchestration, formatting, and rendering. | Medium | High |
| 12 | Repair tooling overlap | `scripts/fix-*depeg*.ts`, `worker/scripts/repair-non-usd-fiat-depeg-history.ts`, `worker/src/api/backfill-depegs-replay.ts` | Depeg repair/replay paths overlap across root scripts, worker scripts, and Worker API. | Medium | Medium |
| 13 | Dynamic route wiring | `worker/src/routes/dynamic-routes.ts` | Dynamic route descriptors are looked up repeatedly and admin dispatch tables duplicate keys. | Low | Low |
| 14 | Heavy query reuse gap | `src/hooks/use-stablecoin-detail-history.ts`, `src/hooks/use-stablecoins.ts` | Detail history fetches the heavy detail endpoint instead of using the dedicated supply-history query options. | Medium | Low |

## 3. Detailed Recommendations

### 1. Public API artifacts duplicate endpoint metadata

**What exists now:** `scripts/generate-openapi-spec.ts` and `scripts/generate-postman-collection.ts` each maintain public endpoint/query metadata. The Worker handler for `mint-burn-flows` parses `hours`, docs document `hours`, and Postman emits `hours`, but OpenAPI emits the generic `days` parameter.

**What is wrong:** Generated public artifacts can drift without changing runtime behavior, so docs/clients may become wrong even while tests and runtime routes pass.

**What to do:** First fix OpenAPI for `/api/mint-burn-flows` to emit `hours`. Then introduce a narrow public API artifact registry fed by `shared/lib/api-endpoints/*`, with path, summary, auth, and query parameter metadata shared by OpenAPI and Postman. Keep schema bodies local to each generator until the shared registry has settled.

**What to watch out for:** Artifact diffs are user-facing. Run the OpenAPI/Postman generation checks and review generated output manually.

### 2. Endpoint access policy lives outside static endpoint records

**What exists now:** `BASE_ENDPOINT_DEFINITIONS` in `shared/lib/api-endpoints/definitions.ts` defines the static route list, while `SITE_DATA_ALLOWED_ENDPOINT_KEYS` and `PUBLIC_API_EXEMPT_ENDPOINT_KEYS` separately define access policy. Dynamic endpoints already colocate `publicApiAccess` and `siteDataAccess`.

**What is wrong:** Adding or changing a static endpoint requires checking multiple distant lists. Tests reduce runtime risk, but the mental model is split.

**What to do:** Add small builders such as `publicGet()`, `adminGet()`, and `adminPost()` or explicit inline access fields on base endpoint records. Mechanically populate them from the current sets, preserve the exported `ENDPOINT_DEFINITIONS` shape, then delete the key sets.

**What to watch out for:** Preserve admin, mutating-admin, cache-bypass, public API, and site-data behavior exactly. Route contract tests should be run after each mechanical migration batch.

### 3. Admin route wrappers double-handle auth and no-store

**What exists now:** `ADMIN_STATIC_ROUTES` wraps many routes with `makeIdempotentAdminRoute()`, while handlers such as `backfill-depegs`, `backfill-cg-prices`, `audit-depeg-history`, and `reclassify-atomic-roundtrips` also call `runAdminRoute()`, `runAdminJob()`, `withAdmin()`, or `requireAdmin()`. Many handlers manually add `{ noStore: true }` even though admin helpers and router protections already exist.

**What is wrong:** Auth/idempotency/no-store responsibility is not obvious. This increases test setup, handler boilerplate, and risk that new admin routes choose a different pattern.

**What to do:** Centralize `Cache-Control: no-store` in `runAdminRoute()` for all admin responses. Then split admin handlers one family at a time into route-facing core functions that assume validation has already happened, while preserving wrapper exports for direct tests where needed.

**What to watch out for:** Direct handler tests may assert headers or call handlers without route wrappers. Keep idempotency behavior in one place and migrate tests with each endpoint family.

### 4. Scheduled slots repeat best-effort, circuit, and mapping logic

**What exists now:** `runBestEffortScheduledJob()` exists, but slots like `daily-0300`, `hourly-yield`, `yield-supplemental`, `status-self-check`, and parts of `hourly-live-reserves` still hand-roll catch/log/continue blocks. `hourly-blacklist` and `mint-burn-slot` duplicate circuit-gated leased-job patterns. Cron schedule keys and expressions are split across `cron-jobs`, `scheduled-runner-registry`, `scheduled.ts`, and sync checks.

**What is wrong:** Scheduler behavior is connection-budget-sensitive and operationally important, but equivalent patterns are encoded several ways.

**What to do:** Convert catch-equivalent slots to `runBestEffortScheduledJob()`. Add a small `runCircuitGatedLeasedJob()` for the Etherscan/Alchemy circuit pattern. Later, derive runner keys from `CRON_SCHEDULES` and keep `SLOT_RUNNER_BY_KEY satisfies Record<CronScheduleKey, SlotRunner>` as the coverage guard.

**What to watch out for:** Some slots intentionally fail or have custom retry behavior; migrate only equivalent best-effort cases first.

### 5. Frontend query/table/view-model scaffolding repeats

**What exists now:** Homepage, compare, depeg, liquidity, safety scores, and stablecoin filtered table each render `QueryErrorNotice`, build stale query descriptors, and wire retry behavior. `FlowTable` and `BlacklistTable` use `DataTableShell` but hand-render matching loading table skeletons. Stablecoin table consumers repeatedly prepare `pegScores`, `pegRates`, and `reportCardMap`.

**What is wrong:** Page code stays longer than the page-specific behavior warrants, and small changes to stale-data UX or table loading affordances require edits in several places.

**What to do:** Export the `StaleQuery` type and add a `QueryFreshnessNotices` component or `buildStaleQuery()` helper. Add `DataTableSkeleton` from `DataTableColumn[]`. Introduce `buildStablecoinTableInputs()` for shared peg/report-card/table prep, keeping route-specific filtering outside it.

**What to watch out for:** Preserve route-specific warning suppression, retry semantics, and exact table column layout.

### 6. Shared domain metadata has parallel definitions

**What exists now:** Peg values, labels, badge styles, chart colors, and filter tags are spread across `shared/types/core.ts`, `shared/lib/classification.ts`, and `shared/lib/filter-tags.ts`. Grade rank is independent of report-card grade order. Reserve-risk values are duplicated between static reserves and live reserves. `HEALTH_METHODOLOGY_VERSION` and `CHAIN_HEALTH_METHODOLOGY_VERSION` both hardcode `1.2`. `validate-coin-id.ts` rebuilds a set already exported as `TRACKED_IDS`.

**What is wrong:** These are small duplications individually, but they are exactly the kind of policy metadata that drifts during incremental product changes.

**What to do:** Add a peg metadata table keyed by `PegCurrency` and derive existing exports from it. Export shared grade rank/order from report-card core. Export `RESERVE_RISK_VALUES` and alias live reserve risk to it where terminology allows. Re-export `HEALTH_METHODOLOGY_VERSION` from `chain-health-version.ts`. Make `isKnownCoinId()` delegate to `TRACKED_IDS`.

**What to watch out for:** Keep existing export names for compatibility. For peg styles, do not collapse product-specific label/color choices unless the metadata table can represent them explicitly.

### 7. Worker API helpers are partly adopted

**What exists now:** `parseQueryParams` and numeric parsing helpers exist, but some handlers keep local positive/clamped integer parsers. `readCachedJson*` and `decodeCachedJson` overlap. Paginated event endpoints repeat outer pagination/response mechanics. Public and API-key rate limiting duplicate bucket/prune/429 primitives.

**What is wrong:** Shared helpers exist but are not the default path, so new endpoints can copy older one-off patterns.

**What to do:** Add missing small helpers: `parseOptionalPositiveIntParam()`, `parseClampedIntParam()`, `parsePaginationParams()`, `jsonFreshPaginatedResponse()`, `bucketStart()`, and `rateLimitExceededResponse()`. Make `readCachedJson*` wrap the lower-level `decodeCachedJson` result model before touching handlers.

**What to watch out for:** Preserve reject-vs-clamp quirks documented in `docs/api-reference.md`. Cached malformed-response status strings may be contract-tested.

### 8. Cron runtime utilities diverge across jobs

**What exists now:** `batchExecute()` exists but DEX discovery, yield history backfill, and live-reserve state still call `db.batch()` directly in some paths. DEX direct API fetchers repeat timeout/signal/User-Agent/error handling. Deadline budgets, progress reporting, metadata builders, and cursor rotation also have local variants.

**What is wrong:** Cron code has the highest operational constraints in the repo. Repeated low-level patterns increase connection-pool and timeout bug surface.

**What to do:** Migrate DEX discovery and yield backfill to `batchExecute()` first. Add `fetchDexApiResponse()` for direct API fetchers, leaving Orca/custom retry local. Add a small `DeadlineBudget` helper only when touching budgeted jobs. Add `rotateFromCursor<T>()` for mint/burn and live-reserve rotation.

**What to watch out for:** D1 batch semantics and retry behavior matter; live-reserve deferred-tail batching may need to remain grouped differently.

### 9. Scripts and guardrails repeat mechanics

**What exists now:** Generated artifact scripts repeat `--check`/read/write boilerplate. Deploy-impact classification treats some validation-only script changes as Pages and Worker deploy-impacting. `check-doc-counts` regex-parses exported values. Hotspot baseline/backlog state still includes already-decomposed facades and only fails upward metric regressions.

**What is wrong:** Process code is now broad enough to create its own maintenance burden, and stale audit/ratchet metadata can make simplification work harder to reason about.

**What to do:** Add a `scripts/lib/generated-artifacts` helper for check/write output. Split deploy-impact into runtime deploy impact vs validation-required impact. Convert `check-doc-counts` to import real exports or TS-runner helpers. Refresh hotspot baseline notes and add stale-shrink detection that asks maintainers to rebaseline when a queued hotspot has already collapsed to a facade.

**What to watch out for:** CI workflow behavior is sensitive. Treat deploy-impact changes as behavior changes and verify `test:merge-gate` and workflow parity tests.

### 10. Status/admin UI components concentrate too many concerns

**What exists now:** `api-keys-panel.tsx` combines admin transport, model helpers, create form, row editor, token reveal, and mutations. `cron-metadata-summary.ts` centralizes multiple job-family parsers. Several status cards repeat the same empty/error shell.

**What is wrong:** Status pages are operational surfaces; mixing transport, presentation, and parsing makes small changes harder to review.

**What to do:** Split API-key client/model helpers and create/row components. Move cron metadata summaries into per-job summarizer modules behind a facade registry. Add `StatusEmptyCard` to status page primitives.

**What to watch out for:** Keep admin mutation invalidation and token reveal behavior unchanged.

### 11. Large mixed modules should be split behind facades

**What exists now:** `coverage.ts` mixes feature descriptors, presets, resolvers, and summary builders. `contagion-layout.ts` mixes graph selection, hub scoring, target placement, simulation, and collision cleanup. `dispatch-telegram-alerts.ts` loads data, builds diffs, routes, sends, enqueues, writes snapshots, and records circuit state. `hero-card.tsx` builds a broad view model inside the render component.

**What is wrong:** These files are not necessarily wrong, but their responsibilities are broad enough that future fixes need more context than they should.

**What to do:** Split by responsibility while preserving facade exports. For example, table-drive `buildCoverageBreakdown`, split contagion into graph-data/supernode/simulation helpers, extract Telegram diff/recipient/delivery/finalization helpers, and add `buildHeroCardModel(input)`.

**What to watch out for:** These are not quick wins. Keep public exports stable and migrate tests with each extracted helper.

### 12. Depeg repair tooling overlaps

**What exists now:** Root `scripts/fix-*depeg*.ts`, `worker/scripts/repair-non-usd-fiat-depeg-history.ts`, and Worker API replay handlers share repair/replay concerns.

**What is wrong:** Emergency repair paths are easy to keep after they are obsolete, but they encode sensitive mutation logic that should have one maintained path.

**What to do:** Confirm whether the root bootstrap scripts are still used. If obsolete, delete them and document the maintained worker repair path. If still needed, extract shared SQL mutation/replay helpers from the worker repair implementation.

**What to watch out for:** Do not delete operational repair tooling without owner confirmation and a documented replacement command.

### 13. Dynamic route wiring repeats descriptor lookup

**What exists now:** `dynamic-routes.ts` repeats `requireDynamicEndpointDescriptor()` calls and has separate keyed admin handler dispatch.

**What is wrong:** This is small boilerplate, but it repeats the same route descriptor contract that is already typed elsewhere.

**What to do:** Add `defineDynamicRouteFromDescriptor(key, handler)` and a keyed admin handler map.

**What to watch out for:** Keep descriptor key coverage type-checked; do not hide route-specific URL parameter extraction.

### 14. Stablecoin detail history fetches too much

**What exists now:** `use-stablecoin-detail-history.ts` fetches/parses a detail-history path while `supplyHistoryQueryOptions()` and `useSupplyHistory()` already exist.

**What is wrong:** The hook maintains a local response schema and uses a heavier contract than necessary.

**What to do:** Make `useStablecoinDetailHistory()` a thin wrapper around `supplyHistoryQueryOptions()` or `useSupplyHistory()`, then delete the local schema.

**What to watch out for:** Compare loading/error/cache keys in the stablecoin detail page before changing the hook.

## 4. Prioritized Action Plan

### Tier 1 - Quick wins

- Fix OpenAPI `/api/mint-burn-flows` to use `hours`.
- Re-export `HEALTH_METHODOLOGY_VERSION` from `chain-health-version.ts`.
- Make `isKnownCoinId()` use `TRACKED_IDS`.
- Remove the redundant Worker boundary subset scan.
- Convert smoke ops 502/504 retry tests to a table test.
- Add `StatusEmptyCard`.
- Centralize admin `no-store` in `runAdminRoute()`.
- Convert obvious scheduled catch/log blocks to `runBestEffortScheduledJob()`.
- Migrate `useStablecoinDetailHistory()` to the existing supply-history query.

### Tier 2 - High-value refactors

- Move endpoint access policy into endpoint definitions and use small route definition builders.
- Add shared public API artifact metadata for OpenAPI and Postman.
- Add missing Worker API query/pagination/rate-limit helper primitives.
- Consolidate frontend query freshness/error scaffolding and table skeletons.
- Consolidate peg, grade, reserve-risk, and chain/provider metadata through canonical tables.
- Migrate DEX discovery/yield backfill batching and DEX direct fetch timeout handling to shared helpers.
- Split API-key status panel into client/model/form/row units.

### Tier 3 - Structural improvements

- Derive cron schedule runner keys from cron schedule definitions.
- Add circuit-gated scheduled job helper.
- Add shared deadline budget/progress helper only when touching budgeted cron jobs.
- Split coverage, contagion layout, Telegram dispatch, and detail hero modules behind stable facades.
- Refresh hotspot ratchet baseline/backlog governance and add stale-shrink detection.

### Defer or skip

- Do not collapse pricing source registry further; presets already remove the useful repetition, and extra compression would hide policy.
- Do not broadly abstract endpoint-specific filters; only share pagination and response shells.
- Do not delete depeg repair scripts without confirming operational ownership.
- Do not split large modules solely to reduce file length; split only when moving a real responsibility behind a stable facade.

## Verification

- Read relevant architecture/API/testing/worker-limit docs and prior audits.
- Spawned six xhigh subagents across frontend, shared logic, Worker API, cron, scripts/CI, and prior-audit verification.
- Ran `jscpd` clone scan over core runtime/script areas; exact duplication is low at 0.07% duplicated lines.
- No build, lint, or test suite was run because this was a read-only audit plus a markdown artifact.
