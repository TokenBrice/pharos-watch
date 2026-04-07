# Stablecoin Dashboard Simplification Audit

Date: 2026-04-07

## Executive Summary

The codebase is generally healthy: the runtime split is clear, documentation is unusually strong, and shared registries already exist for several complex domains. Complexity is concentrated in `worker/src/cron` and a handful of large interactive frontend routes rather than spread uniformly across the repo. The biggest structural issue is uneven convergence on existing abstractions: the project already has shared page shells, table scaffolding, query helpers, and pricing registries, but several important flows still bypass them and re-implement similar logic locally. If the recommendations below are implemented, a realistic reduction is roughly 800-1,200 lines of production code, with a larger gain in behavioral consistency than raw line count.

## Structural Survey

- Frontend app shell: `src/app/` route entry points, `src/components/` reusable UI, `src/hooks/` query and view-model hooks, `src/lib/` frontend utilities.
- Shared core logic: `shared/lib/` and `shared/types/` hold runtime-neutral metadata, scoring, IDs, endpoint definitions, and classification constants.
- Worker runtime: `worker/src/api/` endpoint handlers, `worker/src/cron/` scheduled pipelines, `worker/src/lib/` runtime helpers, `worker/src/routes/` router metadata/composition.
- Infrastructure/glue: `functions/` Pages Functions, `scripts/` validation/deploy tooling, repo config files.

### Code Volume Hotspots

- `worker/src/cron`: 78,954 lines across 320 files
- `worker/src/lib`: 45,259 lines across 246 files
- `src/components`: 43,806 lines across 282 files
- `worker/src/api`: 26,728 lines across 132 files
- `shared/lib`: 21,147 lines across 132 files
- `src/app`: 20,044 lines across 146 files

### Largest Production Files Worth Watching

- `src/app/stability-index/client.tsx`
- `src/app/about/page.tsx`
- `src/app/chains/[chain]/client.tsx`
- `src/app/safety-scores/client.tsx`
- `src/components/stablecoin-detail/hero-card.tsx`
- `src/components/stablecoin-table.tsx`
- `worker/src/lib/mint-burn-contracts.ts`
- `worker/src/cron/dex-liquidity/fetch-primary.ts`
- `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`
- `worker/src/cron/yield-config.ts`

### Tech Stack

- Frontend: Next.js 16 static export, React 19, TanStack Query, Tailwind 4, Radix/shadcn, Recharts
- Worker/API: Cloudflare Worker, D1, Wrangler
- Validation/tooling: Vitest, ESLint, TypeScript, many repo-local validation scripts
- Redundant dependency finding: no obvious overlapping libraries serving the same role; the main simplification opportunities are in local code, not package churn

## Findings Table

| # | Category | Location | Description | Impact | Effort |
|---|----------|----------|-------------|--------|--------|
| 1 | Duplication | `src/lib/client-feature-page.tsx`, route clients under `src/app/*/client.tsx` | `createClientFeaturePage()` already wraps clients in `SectionErrorBoundary`, but several clients wrap themselves again | Medium | Low |
| 2 | Inconsistent patterns | `src/components/data-table-shell.tsx`, `src/components/table-pagination.tsx`, `src/components/event-pagination-footer.tsx`, table components/routes | The repo has a table shell stack, but several tables still hand-roll sorting/header/pagination patterns | High | Medium |
| 3 | Structural redundancy | `src/lib/admin-access.ts`, admin hooks/components | `AdminAccess` is a constant string and `buildAdminFetchInit()` is effectively a no-op, yet both are threaded through many hooks/components | Medium | Medium |
| 4 | Duplication | `worker/src/cron/sync-stablecoins/stages.ts`, `worker/src/cron/sync-stablecoins/fallback.ts` | Main and fallback stablecoin pricing paths repeat setup, enrichment bookkeeping, override application, and post-enrichment stages | High | Medium |
| 5 | Parallel metadata | `shared/lib/pricing-source-registry.ts`, `worker/src/lib/price-publish-policy.ts`, `src/hooks/use-coverage-matrix-model.ts` | Pricing-source authority rules exist in the registry, but important callers still special-case source strings locally | High | Medium |
| 6 | Layer elimination | `worker/src/route-registry.ts` | Compatibility facade adds another import hop but has a single real consumer | Low | Low |
| 7 | Inconsistent patterns | `src/hooks/use-url-filters.ts`, `src/app/safety-scores/client.tsx`, `src/components/yield-detail-section.tsx`, other query-state consumers | URL/query-state updates are done in multiple ways, including a shared hook whose comment no longer matches implementation | Medium | Medium |
| 8 | Duplication | `src/app/status/client.tsx`, `src/app/admin/client.tsx` | Same `FeaturePageShell` props are repeated across loading/error/empty branches instead of being hoisted once | Low | Low |

## Detailed Recommendations

### 1. Remove nested feature-route error boundaries

- What exists now:
  - `createClientFeaturePage()` wraps every generated client page in `SectionErrorBoundary` at [src/lib/client-feature-page.tsx:24](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/client-feature-page.tsx#L24).
  - Several generated clients wrap themselves again, for example [src/app/liquidity/client.tsx:181](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/liquidity/client.tsx#L181), [src/app/coverage/client.tsx:15](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/coverage/client.tsx#L15), and [src/app/yield/client.tsx:205](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/yield/client.tsx#L205).
- What is wrong:
  - The inner boundary rarely changes behavior, but it creates more wrapper depth and obscures which boundary should own a route-level failure.
- What to do:
  - For pages created with `createClientFeaturePage()`, remove the outermost `SectionErrorBoundary` from the client component and keep only smaller sectional boundaries where they isolate a genuinely optional subsection.
- Watch out:
  - Do not remove boundaries inside complex detail pages where only one subsection should fail independently.

### 2. Converge table rendering on one stack

- What exists now:
  - Shared table shell and pagination exist at [src/components/data-table-shell.tsx:49](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/data-table-shell.tsx#L49) and [src/components/table-pagination.tsx:15](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/table-pagination.tsx#L15).
  - Similar pagination UI is reimplemented in [src/components/event-pagination-footer.tsx:18](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/event-pagination-footer.tsx#L18).
  - Some tables still hand-roll headers/sort logic, for example [src/components/stablecoin-table.tsx:196](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/stablecoin-table.tsx#L196) and [src/app/chains/client.tsx:205](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/chains/client.tsx#L205), while event tables use yet another shape in [src/components/flow-event-feed.tsx:168](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/flow-event-feed.tsx#L168) and [src/components/depeg-history.tsx:189](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/depeg-history.tsx#L189).
- What is wrong:
  - Sorting, pagination, empty-state handling, and table chrome are implemented multiple ways, so style and behavior drift over time.
- What to do:
  - Keep `DataTableShell` + `TablePagination` as the standard.
  - Merge `EventPaginationFooter` into `TablePagination` with a small prop surface for copy/layout differences.
  - Port non-virtualized manual tables like `chains` and event tables to the shared shell.
  - For `stablecoin-table`, keep the virtualization, but extract its duplicated header/pagination chrome to shared helpers instead of maintaining a private stack.
- Watch out:
  - Do not force virtualization into the shared table shell; `stablecoin-table` is a real outlier because of row count and density modes.

### 3. Delete the phantom admin-access layer

- What exists now:
  - `AdminAccess` is just a constant-string alias at [src/lib/admin-access.ts:3](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/admin-access.ts#L3).
  - `buildAdminFetchInit()` only clones headers at [src/lib/admin-access.ts:19](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/admin-access.ts#L19).
  - Hooks still require `adminAccess` and append it to query keys, for example [src/hooks/use-admin-polling-query.ts:13](/Users/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-admin-polling-query.ts#L13) and [src/hooks/use-endpoint-probes.ts:38](/Users/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-endpoint-probes.ts#L38).
- What is wrong:
  - This adds parameter threading and type noise without representing real state or credentials.
- What to do:
  - Replace `AdminAccess` with direct admin-route helpers.
  - Remove `buildAdminFetchInit()` unless it starts attaching real headers.
  - Drop `adminAccess` props/parameters from hooks and components that only need the admin proxy path.
- Watch out:
  - Keep `isOpsUiHost()`; host detection is real behavior and should remain separate from query-key plumbing.

### 4. Merge duplicated main/fallback stablecoin pricing orchestration

- What exists now:
  - Main flow setup in [worker/src/cron/sync-stablecoins/stages.ts:159](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-stablecoins/stages.ts#L159).
  - Fallback path repeats the same context building and post-enrichment steps in [worker/src/cron/sync-stablecoins/fallback.ts:126](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-stablecoins/fallback.ts#L126).
  - Entry orchestration then repeats more result handling in [worker/src/cron/sync-stablecoins.ts:66](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-stablecoins.ts#L66).
- What is wrong:
  - The same rules for `missingBefore`, prevalidation, fallback stamping, authoritative overrides, and post-enrichment must stay aligned across two execution paths.
- What to do:
  - Extract one shared “price recovery pipeline” that accepts an asset set and mode-specific knobs.
  - Keep intake differences separate, but converge everything from validation-context construction through `runPostEnrichmentPricePipeline()`.
- Watch out:
  - Preserve different stage names and metadata labels where ops visibility depends on main vs fallback mode.

### 5. Stop re-encoding pricing-source semantics outside the registry

- What exists now:
  - The canonical source metadata already lives in [shared/lib/pricing-source-registry.ts:536](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/pricing-source-registry.ts#L536).
  - Policy helpers already read from it in [worker/src/lib/pricing-source-policy.ts:22](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/pricing-source-policy.ts#L22).
  - But other modules still hardcode source names, for example [worker/src/lib/price-publish-policy.ts:58](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/price-publish-policy.ts#L58) and [src/hooks/use-coverage-matrix-model.ts:103](/Users/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-coverage-matrix-model.ts#L103).
- What is wrong:
  - The registry stops being a source of truth if downstream code keeps special-casing `protocol-redeem`, `pool-tvl-weighted`, or local “authoritative” sets.
- What to do:
  - Push all authority/replay/trust checks through shared helpers backed by the registry.
  - Replace local sets and string comparisons with semantic predicates.
- Watch out:
  - Some UI groupings may still want display-specific buckets; if so, encode that explicitly in the registry instead of inferring from strings elsewhere.

### 6. Delete the route-registry facade

- What exists now:
  - [worker/src/route-registry.ts:1](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/route-registry.ts#L1) only re-exports from `worker/src/routes/*`.
  - The real registry already lives at [worker/src/routes/registry.ts:24](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/routes/registry.ts#L24), and the only production consumer is [worker/src/router.ts:7](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/router.ts#L7).
- What is wrong:
  - This is pure indirection with no compatibility value left.
- What to do:
  - Import directly from `worker/src/routes/registry.ts` and `worker/src/routes/shared.ts`, then delete `worker/src/route-registry.ts`.
- Watch out:
  - Update any docs that still mention the facade as a live architecture surface.

### 7. Standardize query-string state management

- What exists now:
  - Shared URL filter hook at [src/hooks/use-url-filters.ts:21](/Users/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-url-filters.ts#L21).
  - Manual router/query updates still appear in [src/app/safety-scores/client.tsx:405](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/safety-scores/client.tsx#L405) and [src/components/yield-detail-section.tsx:304](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/yield-detail-section.tsx#L304).
- What is wrong:
  - The same operation is performed with different APIs, and the shared hook’s comment claims `router.replace()` while the implementation uses `history.replaceState()`.
- What to do:
  - Pick one lightweight pattern for browser-only query state and use it consistently.
  - Either expand `useUrlFilters()` to cover these cases, or keep route-local serializers but stop introducing new one-off query sync blocks.
- Watch out:
  - `yield-detail-section` uses `useSearchParams()` reactivity; preserve that behavior if you fold it into a shared helper.

### 8. Hoist repeated `FeaturePageShell` props in admin/status clients

- What exists now:
  - `System Status` repeats the same shell props in three branches at [src/app/status/client.tsx:108](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/status/client.tsx#L108).
  - `Operator Admin` does the same in [src/app/admin/client.tsx:52](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/admin/client.tsx#L52).
- What is wrong:
  - This is low-grade duplication, but it bloats conditional branches and makes content tweaks more error-prone.
- What to do:
  - Hoist the common shell once and branch only on the inner body content.
- Watch out:
  - Keep the lead paragraph copy branchable if the public-host warning genuinely needs different wording.

## Prioritized Action Plan

### Tier 1 — Quick wins

- Remove nested `SectionErrorBoundary` wrappers from `createClientFeaturePage()` consumers.
- Delete `worker/src/route-registry.ts`.
- Hoist repeated `FeaturePageShell` props in `admin` and `status` clients.
- Fold `EventPaginationFooter` into `TablePagination`.

### Tier 2 — High-value refactors

- Remove the `AdminAccess` / `buildAdminFetchInit()` abstraction and flatten admin hook signatures.
- Standardize query-string state management so new pages stop inventing their own URL-sync logic.
- Converge non-virtualized tables on `DataTableShell` + `useSortedPaginatedTable`.

### Tier 3 — Structural improvements

- Unify main and fallback stablecoin pricing/post-enrichment orchestration into one pipeline core.
- Replace stringly pricing-source authority checks with registry-backed helper calls everywhere.
- Extract reusable header/pagination chrome from `stablecoin-table` without removing its virtualization-specific behavior.

### Defer or skip

- Large static content pages like `about`, `telegram`, and some methodology surfaces are big, but most of that size is content, not abstraction debt.
- No package-level simplification is urgent; the repo’s complexity is mostly local code complexity rather than dependency overlap.
