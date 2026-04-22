# Maintainability Refactor Audit

Date: 2026-04-22
Scope: simplification, deduplication, structural elegance, and incremental maintainability improvements
Method: static code inspection plus six scoped subagent audits; no build/lint/test commands were run

## Executive Summary

The codebase is generally disciplined and already contains several good single-source-of-truth patterns, especially around endpoint metadata, cron metadata, and shared domain logic. The main problem is that those abstractions are applied unevenly: several high-traffic areas still duplicate route descriptors, query contracts, validation plans, or orchestration logic next to an existing shared mechanism. The largest downstream cost is drift, where a change to one source of truth still requires hand-editing multiple adapters, wrappers, or parallel registries. If the recommendations below are implemented, the likely net reduction is roughly 1,500-2,500 lines of handwritten TS/TSX/JS, with a larger improvement in cognitive load than the raw line count suggests.

The single biggest structural issue is “parallel definitions”: the same intent is often modeled once in a shared abstraction and then again in a local adapter layer. That shows up in worker routing, frontend query options, validation/deploy plans, and parts of the shared domain model. The practical effect is review friction, slower safe changes, and more places where behavior can silently diverge.

## Findings

| # | Category | Location | Description | Impact | Effort |
|---|----------|----------|-------------|--------|--------|
| 1 | Duplication | `shared/lib/api-endpoints/validation.ts`, `worker/src/routes/dynamic-routes.ts` | Dynamic route shape is declared twice, with separate regexes, method rules, access rules, and dependency wiring. | High | Medium |
| 2 | Duplication | `worker/src/routes/public-routes.ts`, `worker/src/routes/admin-routes.ts`, `worker/src/routes/ops-routes.ts`, `worker/src/api/admin-*.ts` | Static route files and small admin mutation endpoints are dominated by adapter glue, repeated context types, and repeated audit-response patterns. | High | Medium |
| 3 | Duplication | `worker/src/lib/api-cache-read.ts`, `worker/src/api/cache-handlers.ts` | Cache-backed GET handlers reimplement the same cache-read, parse, freshness-header, and `_meta` pipeline instead of extending the shared helper. | Medium | Low |
| 4 | Duplication | `src/hooks/use-api-query.ts`, `src/hooks/use-compare-data-model.ts`, `src/hooks/use-prefetch-stablecoin.ts`, `src/hooks/use-stablecoin-reserves.ts`, `src/hooks/use-depeg-events.ts` | Query keys, paths, schemas, defaults, and polling cadence rules are hard-coded in multiple hook callsites. | High | Medium |
| 5 | Redundancy | `src/hooks/use-stablecoin-detail-history.ts`, `src/hooks/use-stablecoins.ts` | The app derives `SupplyHistoryPoint[]` from both `/api/stablecoin/:id` and `/api/supply-history`, creating two paths for the same concept. | Medium | Low |
| 6 | Complexity | `src/app/stability-index/client.tsx`, `src/app/safety-scores/client.tsx`, `src/components/stablecoin-detail/hero-card.tsx`, `src/app/about/page.tsx`, `src/app/telegram/page.tsx` | Large route/client files mix container logic, presentation helpers, and large static content/config blocks in one place. | Medium | Medium |
| 7 | Duplication | `src/app/stablecoins/backing/page.tsx`, `src/app/stablecoins/governance/page.tsx`, `src/app/stablecoins/infrastructure/page.tsx`, matching slug routes, `src/app/flows/page.tsx` | Taxonomy route families and one feature route still copy page-shell and route metadata patterns that are already data-driven elsewhere. | Medium | Low |
| 8 | Duplication | `src/components/blacklist-stats.tsx`, `src/components/blacklist-status-charts.tsx`, `src/components/blacklist-status-drilldown.tsx`, `src/app/blacklist/page.tsx` | Three blacklist child components independently fetch and rebuild the same support data instead of receiving a shared route-scoped view model. | Medium | Medium |
| 9 | Boundary Drift | `shared/types/core.ts`, `shared/lib/stablecoins/schema.ts`, `shared/lib/classification.ts` | The stablecoin domain model is mirrored in hand-written Zod schemas, while type modules also carry runtime taxonomy/filter logic. | High | Medium |
| 10 | Boundary Drift | `shared/lib/report-card-resilience.ts`, `shared/lib/report-card-governance.ts`, `shared/lib/reserve-templates.ts`, `shared/lib/report-card-blacklist-*` | Classification and blacklist policy are spread across multiple modules with overlapping authority, and reserve templates also derive dependencies. | High | High |
| 11 | Orchestration | `worker/src/cron/sync-blacklist.ts`, `worker/src/cron/blacklist/*`, `worker/src/cron/sync-live-reserves.ts`, `worker/src/cron/dex-discovery/orchestrator.ts` | Scheduler-heavy jobs duplicate budget/deadline logic and keep too much orchestration in top-level functions. | High | High |
| 12 | Drift | `package.json`, `scripts/lib/validate-contract.mjs`, `scripts/lib/deploy-impact.mjs`, `scripts/run-node-lts-validation.mjs`, `scripts/check-doc-counts.mjs`, `scripts/lib/doc-sync/checks.ts` | Validation, deploy-impact, LTS validation, and doc-check registries are maintained in parallel and have already drifted. | High | Medium |

## Detailed Recommendations

### 1. Dynamic route descriptors are duplicated

- What exists now:
  - `shared/lib/api-endpoints/validation.ts` hard-codes dynamic path regexes and method/access behavior.
  - `worker/src/routes/dynamic-routes.ts` hard-codes a second regex/dependency/dispatch table.
- What is wrong:
  - Route behavior is not actually single-source; access control and dispatch can drift independently.
  - Every new dynamic route requires editing two registries plus tests.
- What to do:
  - Create one shared dynamic endpoint descriptor table that owns pattern, method set, access flags, dependency list, and param decoding.
  - Make `validateEndpointMethod()`, `getPublicApiAccess()`, `getSiteDataAccess()`, and worker dynamic routing read from that table.
- What to watch out for:
  - Preserve current decoding/error semantics for malformed IDs and admin path matching.
  - Keep worker-only handler functions out of shared runtime-neutral modules.

### 2. Static route and admin mutation glue should be collapsed

- What exists now:
  - Route arrays are mostly lambdas translating `RouteContext` into incompatible handler signatures.
  - Small admin mutation endpoints repeat `AdminRouteContext`, param extraction, audit logging, and `{ ok, ... }` JSON shaping.
- What is wrong:
  - Boilerplate overwhelms the actual behavior.
  - Handler signatures are inconsistent, which forces route tables to carry complexity that should live in helpers.
- What to do:
  - Add typed adapter helpers for repeated handler shapes such as `db`, `db+url`, and `db+request+trustedAdmin`.
  - Add a `makeAuditedAdminMutation()` helper that wraps idempotency, param validation, audit logging, and success/error shaping.
  - Replace repeated local `AdminRouteContext` declarations with one shared type from the routing layer.
- What to watch out for:
  - Do not change idempotency boundaries or existing audit log payloads.
  - Keep direct handler testing straightforward; expose the core mutation logic separately when useful.

### 3. Cache-backed GET handlers should extend the shared cache helper

- What exists now:
  - `createCacheHandler()` already covers the standard cache-read path.
  - `handleStablecoinCharts`, `handleBluechipRatings`, and `handleYieldRankings` recreate missing-cache, malformed-cache, freshness, and `_meta` logic around their custom transforms.
- What is wrong:
  - The most failure-prone response path exists in multiple forms.
  - Small policy changes around freshness/meta handling require touching multiple endpoints.
- What to do:
  - Extend `createCacheHandler()` with optional hooks for schema validation, transformed response bodies, and live hydration.
  - Migrate the three special handlers onto the shared path one by one.
- What to watch out for:
  - Preserve current fallback behavior for yield-rankings when live Safety Score hydration fails.
  - Keep large-array responses like stablecoin charts from paying unnecessary object/meta overhead.

### 4. Frontend query contracts should come from reusable option builders

- What exists now:
  - `useCompareDataModel` rebuilds query keys, paths, schemas, and polling windows that existing hooks already define.
  - `usePrefetchStablecoin` repeats the same contract again.
  - `useInfiniteDepegEvents` and `useStablecoinReserves` implement polling behavior outside the shared helper.
- What is wrong:
  - Query contract drift is likely whenever defaults or schemas change.
  - The “stale = cron, refetch = 2x cron” rule is not actually centralized.
- What to do:
  - Export per-resource `queryOptions` builders from each domain hook module.
  - Add a tiny non-hook helper like `getPollingWindow(cronMs)` for custom TanStack setups.
  - Reuse those builders from single hooks, `useQueries`, `prefetchQuery`, and conditional polling hooks.
- What to watch out for:
  - Preserve query keys exactly to avoid cache invalidation regressions.
  - Keep the reserve hook’s mode-dependent stale/refetch policy intact.

### 5. `useStablecoinDetailHistory` should stop duplicating supply-history behavior

- What exists now:
  - `useStablecoinDetailHistory()` fetches `/api/stablecoin/:id` and maps `tokens` into `SupplyHistoryPoint[]`.
  - `useSupplyHistory()` already exposes the dedicated history endpoint.
- What is wrong:
  - The app has two sources for the same conceptual data.
  - One path depends on a larger payload than needed and can drift in transformation logic.
- What to do:
  - Point the affected chart/view-model path at `useSupplyHistory()`.
  - If both payload shapes must remain supported, extract one shared `toSupplyHistoryPoints()` normalizer and use it in both places.
- What to watch out for:
  - Confirm the detail endpoint carries any data that `supply-history` does not; only keep the heavier path if it is truly needed.

### 6. Large route/client files should be decomposed along existing seams

- What exists now:
  - Several large files contain both page orchestration and many local subcomponents or content arrays.
- What is wrong:
  - Review scope is too wide.
  - Small edits to copy or presentation force touching files that also own state and data wiring.
- What to do:
  - Extract pure presentational subcomponents into adjacent files.
  - Move large static arrays/content blocks into `*-content.ts` or `view-model.ts` style modules.
  - Keep route/client files focused on data loading and composition.
- What to watch out for:
  - Do not split stateful logic across too many tiny files; extract only pure helpers and static content first.
  - Preserve existing route-level Suspense/loading behavior.

### 7. Taxonomy routes and `/flows` should reuse existing page abstractions

- What exists now:
  - Three taxonomy hub routes and three slug routes repeat nearly the same page setup.
  - `/flows` hand-builds feature page chrome instead of using the existing feature shell abstraction.
- What is wrong:
  - The repo already has the abstraction; these routes still live outside it.
  - Metadata, breadcrumbs, and shell behavior are harder to keep consistent.
- What to do:
  - Introduce a small taxonomy route descriptor/factory over the existing stablecoin taxonomy data.
  - Move `/flows` onto `FeaturePageShell` or `createClientFeaturePage`.
- What to watch out for:
  - Preserve route-specific copy and warning banners.
  - Keep generated metadata identical to avoid SEO regressions.

### 8. Blacklist route support data should be hoisted once

- What exists now:
  - `BlacklistStats`, `BlacklistStatusCharts`, and `BlacklistStatusDrilldown` each fetch stablecoins/report cards and rebuild lookup maps.
- What is wrong:
  - The route repeats the same expensive support-data preparation in multiple children.
  - Lookup behavior can diverge between sibling components.
- What to do:
  - Add a route-scoped blacklist page model or hook that prepares support data once.
  - Pass prepared maps/buckets into the child components as props.
- What to watch out for:
  - Preserve loading behavior for partially available data.
  - Avoid coupling components to more data than they need; pass prepared subsets.

### 9. Shared stablecoin domain contracts need one canonical shape

- What exists now:
  - `StablecoinMeta` is defined as a TS interface in `shared/types/core.ts`.
  - `StablecoinMetaAssetSchema` re-declares the same structure in `shared/lib/stablecoins/schema.ts`.
  - `shared/types/core.ts` also includes runtime taxonomy/filter helpers.
- What is wrong:
  - The core domain shape is mirrored by hand.
  - Type modules are not purely type/domain contracts, which muddles boundaries.
- What to do:
  - Export reusable nested schemas for flags, reserves, links, notices, yield config, and launch metadata.
  - Compose the top-level asset schema from those pieces instead of restating the full tree.
  - Move runtime filter/tag helpers out of `shared/types/core.ts` into `shared/lib/*`.
- What to watch out for:
  - Preserve strict schema behavior and current validation messages.
  - Avoid introducing circular imports between shared types and shared lib modules.

### 10. Classification and blacklist policy should have clearer authority

- What exists now:
  - Classification defaults, governance scoring, reserve-template classification, and blacklist inference live across several modules.
  - `reserve-templates.ts` also derives dependencies.
  - Blacklist resolution exposes both `resolveBlacklistStatuses()` and a convenience `isBlacklistable()` path with a thinner context.
- What is wrong:
  - Policy changes require edits in multiple places.
  - Reserve presentation, dependency derivation, and blacklist policy are not clearly separated.
- What to do:
  - Introduce a shared classification-profile module for reusable tables/defaults.
  - Move dependency derivation out of `reserve-templates.ts`.
  - Make one blacklist-resolution API authoritative and keep batch helpers as wrappers over it.
- What to watch out for:
  - This touches methodology-sensitive code; migrate with tight test coverage and snapshot checks.
  - Avoid changing scores/labels as part of the structural refactor.

### 11. Scheduler-heavy cron jobs need shared budget/orchestration helpers

- What exists now:
  - Blacklist sync, live reserves, DEX discovery, and parts of yield sync encode deadline and budget policy inline.
  - `syncBlacklist()` duplicates fetch -> process -> cursor-advance flows across chain branches.
- What is wrong:
  - Runtime safety policy is repeated and slightly different across helpers.
  - Top-level cron functions own too many responsibilities.
- What to do:
  - Start with `sync-blacklist`: add a `BlacklistRunBudget` helper and a shared `BlacklistScanResult` pipeline.
  - Then split `syncLiveReserves()` into runner, queue, and finalize phases.
  - Add a small shared cron budget profile registry only after the first migration proves the shape.
- What to watch out for:
  - Preserve current subrequest budgets, connection assumptions, and cursor semantics.
  - This work is high leverage but also the most regression-sensitive in the plan.

### 12. Validation and deploy-impact contracts should come from shared registries

- What exists now:
  - `package.json` owns the real prebuild command list.
  - `validate-contract.mjs`, `deploy-impact.mjs`, and `run-node-lts-validation.mjs` maintain overlapping views of that contract.
  - Doc checks are split across separate frameworks with overlapping scope.
- What is wrong:
  - CI parity and deploy-impact logic can claim correctness while missing actual underlying commands.
  - The LTS validation lane is a manual fork.
- What to do:
  - Move the validate plan into JS/TS data and have `package.json`, merge-gate, CI, and LTS validation consume it.
  - Replace `npx --yes madge` with an LTS-safe invocation so `validate:lts` can share the main plan.
  - Merge doc-count and doc-sync registries into one owned validation surface.
- What to watch out for:
  - Keep command ordering and conditional Pages/worker gates unchanged during the first migration.
  - Update the parity tests at the same time so the new registry is immediately enforced.

## Prioritized Action Plan

### Tier 1 — Quick wins

- Replace `useStablecoinDetailHistory()` with the existing `useSupplyHistory()` contract, or extract a shared normalizer first.
- Add a small `getPollingWindow()` helper and remove the fake `createPollingQueryOptions([], ...)` usage in `useStablecoinReserves()`.
- Extract `queryOptions` builders for the compare and prefetch paths so they stop restating keys/paths/schemas.
- Introduce a taxonomy route descriptor/factory for the backing/governance/infrastructure route family.
- Move `/flows` onto the existing feature page shell.
- Add one shared `AdminRouteContext` type and a small `makeAuditedAdminMutation()` helper for the tiny operator endpoints.

### Tier 2 — High-value refactors

- Consolidate dynamic route descriptors so validation and worker routing consume the same table.
- Extend `createCacheHandler()` with validation/transform hooks and migrate the special cache-backed endpoints.
- Hoist blacklist page support data into one route-scoped view model and pass prepared data to child components.
- Move the validate plan into shared data and make merge-gate, CI, `validate:lts`, and deploy-impact classification consume it.
- Rework `StablecoinMeta` validation around reusable nested schemas and move runtime filter helpers out of `shared/types/core.ts`.

### Tier 3 — Structural improvements

- Decompose `sync-blacklist()` around shared budget and scan-result helpers.
- Split `syncLiveReserves()` orchestration into smaller phases.
- Centralize classification policy tables and blacklist-resolution authority.
- Remove the legacy input union from `buildStablecoinDetailViewModel()` once tests are migrated.
- Break up the largest page/client files by extracting pure subcomponents and static content/config modules.

### Defer or skip

- Full API-handler context standardization across the entire worker surface.
  - Worth doing only after the routing adapter helpers settle; otherwise it risks becoming churn.
- Deep classification-policy consolidation that changes methodology tables and scoring defaults at the same time.
  - Do the structural extraction first; do not combine it with behavior changes.
- Purely aesthetic file splitting where the only benefit is shorter files but shared logic remains unchanged.
  - Prioritize places where duplication or drift risk is real, not just places that are large.
