# Comprehensive Codebase Audit: Simplification, Deduplication & Structural Elegance

**Date:** 2026-04-23
**Scope:** Full stack (Next.js frontend, Cloudflare Worker API, Cloudflare Pages Functions, shared runtime)
**Methodology:** Parallel subagent swarm across 6 architectural boundaries + targeted manual verification

---

## 1. Executive Summary

The Pharos codebase is well-organized at the macro level — clear directory boundaries, strong shadcn primitive discipline, and sensible runtime separation between `src/`, `shared/`, `functions/`, and `worker/`. However, **organic growth has produced a "copy-paste tax"** that is now the dominant maintenance burden. The same visual surface pattern appears 112 times across 45 files, the same D1 queries are inlined in 3–4 handlers each, and ~8 TanStack Query hooks are identical one-liners living in separate files. The good news: most of this is low-risk, mechanical cleanup. There are no architectural rot issues requiring rewrites.

**The single biggest structural issue** is the **absence of a shared styling/token abstraction** for the app's most common visual pattern (`rounded-2xl border border-border/60 bg-background/45`). This forces every new feature to copy-paste 6–8 Tailwind classes, creating a hidden dependency web where design tweaks require touching 40+ files. Downstream effects include inconsistent border-radius values, forgotten `dark:` variants, and developer hesitation when iterating on UI.

**Estimated code volume reduction if all recommendations are implemented:** ~2,800–3,500 lines removed or consolidated (~5–6% of non-test TypeScript), plus elimination of ~15–20 unnecessary files.

---

## 2. Findings Table

| # | Category | Location | Description | Impact | Effort |
|---|----------|----------|-------------|--------|--------|
| 1 | Duplication | `src/components/*.tsx` (45 files) | Surface container pattern (`rounded-2xl border border-border/60 bg-background/45`) copy-pasted 112× | High | Low |
| 2 | Duplication | `worker/src/api/*.ts` | D1 SQL queries duplicated: `dex_prices`, `stability_index_samples`, `supply_history`, `depeg_events` | High | Low |
| 3 | Duplication | `shared/types/core.ts` + `shared/lib/stablecoins/schema.ts` | `StablecoinMeta` interface (~40 fields) manually mirrored by Zod schema with no derivation | High | Medium |
| 4 | Duplication | `src/hooks/use-*.ts` (8 files) | Near-identical TanStack Query wrapper hooks (e.g., `useApiKeys`, `useStatus`, `useTelegramPulse`) | Medium | Medium |
| 5 | Duplication | `src/components/chart-skeleton.tsx` + `homepage-skeletons.tsx` | Two incompatible chart skeleton systems serving identical purpose | Medium | Low |
| 6 | Duplication | `src/components/metric-stat-card.tsx` + `yield-detail-section-stat-card.tsx` + `status-metric-card.tsx` | Three parallel stat card abstractions differing only in padding/radius | Medium | Low |
| 7 | Duplication | `src/hooks/use-compare-data-model.ts` + `use-stablecoin-detail-view-model.ts` + `use-coverage-matrix-model.ts` | "God hooks" re-implement same multi-query retry orchestration (`Promise.allSettled`) | Medium | Low |
| 8 | Duplication | `functions/lib/proxy-utils.ts` + `worker/src/lib/api-response.ts` | JSON error response builders with identical behavior across runtime boundaries | Medium | Low |
| 9 | Duplication | `worker/src/lib/rate-limit.ts` + `api-key-rate-limit.ts` + `request-source-attribution.ts` + `functions/lib/request-attribution.ts` | Prune guard algorithm (bucket check + pending promise + DELETE) duplicated 4× | Medium | Low |
| 10 | Duplication | `worker/src/lib/circuit-breaker.ts` + `shared/types/status.ts` | `CircuitRecord` interface defined identically in both locations | Medium | Low |
| 11 | Duplication | `src/components/table-logic/*.ts` (5 files) | `createTableComparator` configuration copy-pasted per domain with identical boilerplate | Medium | Medium |
| 12 | Duplication | `src/components/stablecoin-table-row.tsx` + `interactive-table-row.tsx` | `StablecoinVirtualRow` re-implements 80% of `InteractiveTableRow` inline instead of composing it | Medium | Low |
| 13 | Duplication | `functions/api/admin/[[path]].ts` + `worker/src/lib/route-wrappers.ts` | Admin mutating-gate constants (`MUTATING_METHODS`, `X-Pharos-Admin` header) duplicated | Medium | Low |
| 14 | Duplication | `shared/types/report-cards.ts` + `stablecoin-meta-schemas.ts` | `DependencyWeightSchema` defined twice with divergent strictness | Medium | Low |
| 15 | Duplication | `shared/types/redemption.ts` + `live-reserves.ts` | Redemption route status values (`"open"`, `"degraded"`, etc.) duplicated as arrays and schemas | Low | Low |
| 16 | Over-engineering | `src/components/report-card.tsx` (445 lines) | `DimensionRow` includes inline regex parsing that belongs in a view-model | Medium | Low |
| 17 | Over-engineering | `src/hooks/use-command-palette-history.ts` (140 lines) | `useSyncExternalStore` + custom event dispatching for a 5-item history list | Medium | Low |
| 18 | Over-engineering | `src/hooks/use-sidebar-nav-signals.ts` | Consumes 5 API queries solely to compute 5 boolean badge states | Medium | Medium |
| 19 | Over-engineering | `src/app/blacklist/layout.tsx`, `src/app/flows/layout.tsx` | Dead layout files that only export metadata and render `<>children</>` | Low | Trivial |
| 20 | Over-engineering | `src/components/grade-badge.tsx` | 28-line thin wrapper around `Badge` + color map; adds minimal value | Low | Trivial |
| 21 | Over-engineering | `src/app/error.tsx` | Root error boundary manually duplicates `PageError` visuals instead of using `createPageError` | Low | Trivial |
| 22 | Inconsistency | `src/app/admin/page.tsx`, `status/page.tsx`, `methodology/page.tsx`, `cemetery/page.tsx` | Metadata constructed manually instead of using `buildPageMetadata` helper | Medium | Low |
| 23 | Inconsistency | `src/components/chart-primitives.tsx` vs chart consumers | `TimeXAxis`, `MonoYAxis`, `DateTooltip` exist but ~15 charts still inline identical props | Medium | Medium |
| 24 | Inconsistency | `src/hooks/use-nav-collapse.ts`, `use-start-here-callout.ts`, `use-portfolio.ts` | Re-implement localStorage read/write/parse instead of using existing `usePreference` | Medium | Low |
| 25 | Inconsistency | `src/lib/dex-constants.ts` + `worker/src/lib/dex-constants.ts` | Same filename, completely different domains (display colors vs TVL multipliers) | Low | Low |
| 26 | Inconsistency | `src/components/key-info-card.tsx` + `flow-table-logic.ts` + others | Inline badge Tailwind classes violate AGENTS.md rule to use `shared/lib/classification.ts` | Medium | Medium |
| 27 | Inconsistency | `shared/types/core.ts` + `report-cards.ts` | `BluechipGrade` and `ReportCardGrade` duplicate 11 identical values | Low | Low |
| 28 | Dead code | `src/components/blacklist-table.tsx` | Hand-rolled loading skeleton table instead of using `DataTableShell` | Medium | Medium |
| 29 | Dead code | `src/app/blacklist/layout.tsx` | Metadata-only layout; Next.js allows metadata in `page.tsx` | Low | Trivial |
| 30 | Type safety | `shared/lib/stress-signals-envelope.ts` + 3 worker files | `isRecord` type guard copy-pasted in 4 files | Low | Low |

---

## 3. Detailed Recommendations

### Finding 1: Surface Container Pattern (112× copy-paste)
**What exists now:** The class combo `rounded-2xl border border-border/60 bg-background/45 px-4 py-3` (and opacity variants `/55`, `/70`) appears in 45 component files, often with additional copy-pasted `shadow-sm`, `backdrop-blur`, or `overflow-hidden`.

**What is wrong:** This is the app's default "inner card" look. Any design tweak (e.g., changing to `rounded-xl` or `bg-muted/20`) requires a find-and-replace across 45 files. New developers discover the pattern by reading existing components and copy it, perpetuating the debt.

**What to do:** Create a Tailwind `@layer components` class in `src/styles/globals.css`:
```css
@layer components {
  .pharos-surface {
    @apply rounded-2xl border border-border/60 bg-background/45 px-4 py-3;
  }
  .pharos-surface-dense {
    @apply rounded-xl border border-border/60 bg-background/55 px-3 py-2;
  }
}
```
Audit all 45 files and replace. Add `pharos-surface-elevated` for variants that include `shadow-sm backdrop-blur`.

**What to watch out for:** Some instances combine this with `overflow-hidden` or `relative` for chart containers. Ensure the component class does not strip those. Tailwind `@apply` requires static strings, so verify the build succeeds.

---

### Finding 2: D1 SQL Query Duplication
**What exists now:** Four SQL patterns are inlined in multiple API handlers:
- `SELECT ... FROM dex_prices` — in `peg-summary.ts`, `dex-liquidity.ts`, `depeg-helpers.ts`
- `SELECT score, band FROM stability_index_samples ORDER BY stored_at DESC LIMIT 1` — in `stability-index.ts`, `og.tsx`, `cron/daily-digest/input.ts`
- `SELECT ... FROM supply_history ORDER BY snapshot_date` — in `audit-depeg-history.ts` (twice!), `backfill-dews.ts`, `backfill-stability-index.ts`
- `SELECT ... FROM depeg_events ORDER BY started_at` — in `audit-depeg-history.ts`, `backfill-stability-index.ts`

**What is wrong:** Query drift. If a column is added or renamed, every inline site must be updated. `audit-depeg-history.ts` runs the exact same `supply_history` query in two different branches.

**What to do:**
1. `worker/src/lib/depeg-helpers.ts` already exports `loadDexPriceRows()`. Make `peg-summary.ts` and `dex-liquidity.ts` use it.
2. Add `getLatestPsiSample(db)` and `getPsiRollingAverage(db, windowSec)` to `worker/src/lib/stability-index.ts`.
3. Add `loadSupplyHistoryOrdered(db, { direction })` to `worker/src/lib/db.ts`.
4. Add `loadDepegEventsOrdered(db)` to `worker/src/lib/depeg-helpers.ts`.

**What to watch out for:** `dex-liquidity.ts` selects an extra `price_sources_json` column. Extend `loadDexPriceRows` with an optional `includePriceSources` flag.

---

### Finding 3: StablecoinMeta Interface/Schema Drift
**What exists now:** `shared/types/core.ts:211` defines `StablecoinMeta` as a 40-field interface. `shared/lib/stablecoins/schema.ts:54` defines `StablecoinMetaAssetSchema` as a Zod schema manually mirroring every field. There is no automatic derivation.

**What is wrong:** This is the project's most central data structure. Any drift between the compile-time interface and the runtime schema is a latent deserialization bug. Adding a field requires two edits in different directories.

**What to do:** Invert the relationship. Make the Zod schema the source of truth and derive the TypeScript interface:
```ts
// shared/lib/stablecoins/schema.ts
export const StablecoinMetaAssetSchema = z.object({ ... });
export type StablecoinMeta = z.infer<typeof StablecoinMetaAssetSchema>;
```
Delete the hand-rolled interface from `shared/types/core.ts`. Update all imports to use the derived type.

**What to watch out for:** The interface may have JSDoc comments or `readonly` modifiers that the schema lacks. Preserve documentation by adding `.describe()` to schema fields or maintaining a parallel doc interface. Run `cd worker && npx tsc --noEmit` after the change.

---

### Finding 4: Thin TanStack Query Wrapper Hooks
**What exists now:** ~8 hooks (`useApiKeys`, `useStatus`, `useTelegramPulse`, `useRequestSourceStats`, `usePublicStatusHistory`, `useStatusHistory`) are 14–35 line files containing a single `useAdminPollingQuery` or `useApiQuery` call with hardcoded path and cron interval.

**What is wrong:** Each file carries its own imports, JSDoc, unit test, and export surface. The cognitive overhead of maintaining 6 nearly identical files outweighs the value. New endpoints encourage copy-pasting a new file rather than using a generic hook.

**What to do:** Introduce two generic hooks in `src/hooks/use-api-query.ts`:
```ts
export function useAdminEndpoint<T>(
  key: string,
  path: string,
  cronMs: number,
  opts?: Omit<UseQueryOptions<T>, "queryKey" | "queryFn">
) { ... }

export function usePublicEndpoint<T>(
  key: string,
  path: string,
  staleMs: number,
  opts?: Omit<UseQueryOptions<T>, "queryKey" | "queryFn">
) { ... }
```
Inline existing call sites. Delete the thin wrapper files and their tests. If tests mock the hook path, update them to mock `useAdminEndpoint` with the specific path.

**What to watch out for:** Some hooks have slightly different `select` transformers or `enabled` flags. Preserve those at the call site.

---

### Finding 5: Two Incompatible Chart Skeleton Systems
**What exists now:** `src/components/chart-skeleton.tsx` uses SVG path-based fake area charts with a custom `skeleton-shimmer` animation. `src/components/homepage-skeletons.tsx` uses `<Skeleton variant="shimmer">` from shadcn with gradient divs and SVG line paths. They have different APIs (`variant` vs `type`, `className` vs `height`).

**What is wrong:** Callers import whichever they discover first. Visual inconsistency between pages. Two files to maintain for one concept.

**What to do:** Audit all consumers. Pick the richer abstraction (`homepage-skeletons.tsx`) as the canonical one. Migrate `chart-skeleton.tsx` consumers to it, then delete `chart-skeleton.tsx`. Rename `homepage-skeletons.tsx` to `chart-skeleton.tsx` if desired for semantic clarity.

**What to watch out for:** The two have different `className` behaviors. Verify visual parity after migration.

---

### Finding 6: Three Parallel Stat Card Abstractions
**What exists now:** `metric-stat-card.tsx` uses shadcn `Card`. `yield-detail-section-stat-card.tsx` uses a raw `div` with `rounded-xl border border-border/60 bg-muted/20`. `status-metric-card.tsx` uses a bare `div` with `rounded-lg border border-border/50 p-3`. All render label + big value + optional subtext.

**What is wrong:** Three files for one concept. Adding a new stat card variant requires choosing between them.

**What to do:** Unify on `metric-stat-card.tsx`. Add a `variant` prop (`"card" | "flat" | "dense"`) to cover the visual differences. Update 6–8 consumers in status pages and yield sections. Delete the other two.

**What to watch out for:** `status-metric-card.tsx` is used inside `d1-usage-card.tsx` which wraps it in a shadcn `Card`. Ensure the unified component supports being wrapped without double borders.

---

### Finding 7: God Hooks with Duplicated Multi-Query Retry
**What exists now:** `useCompareDataModel`, `useStablecoinDetailViewModel`, `useChainProfileData`, and `useStatusDashboardModel` each manually destructure `data`/`error`/`refetch`, compute a combined `globalError`, and implement a bespoke `handleRetryAll` that fires `Promise.allSettled([...refetchs])`.

**What is wrong:** The retry orchestration is copy-pasted in 4 hooks. The `globalError` computation (`listError ?? pegError ?? ...`) is also copy-pasted.

**What to do:** Extract a small utility hook:
```ts
// src/hooks/use-combined-refetch.ts
export function useCombinedRefetch(...refetchFns: (() => Promise<unknown>)[]) {
  return useCallback(() => {
    void Promise.allSettled(refetchFns.map((fn) => fn()));
  }, refetchFns);
}
```
Replace 10–15 lines of retry logic in each god hook with one line.

**What to watch out for:** Some hooks log warnings on partial failure. Extend `useCombinedRefetch` with an optional `onPartialFailure` callback.

---

### Finding 8: Cross-Boundary JSON Error Response Builders
**What exists now:** `functions/lib/proxy-utils.ts` exports `jsonError(status, message, headers?)`. `worker/src/lib/api-response.ts` exports `errorResponse(status, message, initOrHeaders?)`. Both construct `Cache-Control: no-store` + `Content-Type: application/json` responses.

**What is wrong:** The two runtimes (Pages Functions vs Worker) independently maintain identical response formatting logic. Any header change must be applied twice.

**What to do:** Create `shared/lib/response-utils.ts` with a runtime-neutral helper:
```ts
export function makeJsonErrorResponse(
  status: number,
  message: string,
  headers?: HeadersInit
): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}
```
Import in both `functions/` and `worker/`. Keep proxy-specific `buildProxyResponse` and `buildUpstreamHeaders` in `functions/`.

**What to watch out for:** The Worker version supports `initOrHeaders` (can be a `ResponseInit`). Preserve that flexibility in the shared helper.

---

### Finding 9: Prune Guard Algorithm Duplicated 4×
**What exists now:** `worker/src/lib/rate-limit.ts`, `api-key-rate-limit.ts`, `request-source-attribution.ts`, and `functions/lib/request-attribution.ts` each implement the same pattern:
1. Compute bucket/key from timestamp.
2. Check `lastPruneBucket !== currentBucket && !pendingPrune`.
3. Run `DELETE ... WHERE bucket_start < ?`.
4. Store `pendingPrune` promise, clear in `.finally()`.

**What is wrong:** Four copies of the same algorithm. Race-condition bugs fixed in one copy may not propagate to others.

**What to do:** Extract a generic helper:
```ts
// shared/lib/prune-guard.ts
export function pruneOnBucketChange<TState extends { lastPruneBucket: number; pendingPrune: Promise<unknown> | null }>(
  state: TState,
  nowSec: number,
  windowSec: number,
  pruneFn: () => Promise<unknown>
): void { ... }
```
Use it in all four locations. The D1-specific SQL stays local, but the guard logic becomes shared.

**What to watch out for:** Error handling differs slightly (some count consecutive failures). Make the helper accept an optional `onError` callback.

---

### Finding 10: CircuitRecord Interface Duplication
**What exists now:** `shared/types/status.ts:583` and `worker/src/lib/circuit-breaker.ts:18` define identical `CircuitRecord` interfaces.

**What is wrong:** The worker already imports `CircuitRecord` from shared types in `public-health-assessment.ts`, but the circuit-breaker module itself redefines it.

**What to do:** Delete the local interface in `worker/src/lib/circuit-breaker.ts`. Import from `@shared/types/status`. Remove the hand-rolled `isCircuitRecord` guard and use the Zod schema already defined in `status.ts`.

**What to watch out for:** Verify the Zod schema validates the same shape as the hand-rolled guard.

---

### Finding 11: Five Nearly Identical Table Logic Files
**What exists now:** `stablecoin-table-logic.ts`, `liquidity-table-logic.ts`, `flow-table-logic.ts`, `depeg-table-logic.ts`, and `yield-table-logic.ts` each export a `createTableComparator` configuration, sort keys, and sometimes CSV export helpers.

**What is wrong:** Adding a new table requires cloning the entire file. The `createTableComparator` pattern and `TableSortState` interface are repeated assumptions.

**What to do:** Extract shared `SortKey` and `Row` type helpers into `src/lib/table-types.ts`. Optionally introduce a `defineTableLogic({ sortKeys, extractors })` factory that generates the comparator config. This is medium effort because each domain has unique row shapes.

**What to watch out for:** Some logic files include domain-specific styling (e.g., `flow-table-logic.ts` coverage badges). Keep those in domain files; only deduplicate the comparator boilerplate.

---

### Finding 12: StablecoinVirtualRow Re-implements InteractiveTableRow
**What exists now:** `src/components/interactive-table-row.tsx` (43 lines) adds `onClick`, `onMouseEnter`, keyboard activation, and `tabIndex` to `TableRow`. `src/components/stablecoin-table-row.tsx` (381 lines) reimplements all of this inline (lines 124–144) plus complex nested-interactive-target detection.

**What is wrong:** `StablecoinVirtualRow` does not use `InteractiveTableRow` despite matching 80% of its behavior.

**What to do:** Enhance `InteractiveTableRow` with optional `onPrefetch` and `nestedInteractiveTarget` detection, then make `StablecoinVirtualRow` delegate to it.

**What to watch out for:** `StablecoinVirtualRow` has complex prefetching logic on hover. Ensure `InteractiveTableRow` does not break that behavior.

---

### Finding 13: Admin Mutating-Gate Constants Duplicated
**What exists now:** `functions/api/admin/[[path]].ts` and `worker/src/lib/route-wrappers.ts` both define `MUTATING_METHODS` as a `Set<string>` and check `X-Pharos-Admin` header.

**What is wrong:** The duplication is intentional for defense-in-depth, but the constants can drift.

**What to do:** Move `MUTATING_METHODS` and the header name constant to `shared/lib/admin-gate.ts`. Both layers import from there. Do **not** unify the gate logic itself (security risk), only the constants.

**What to watch out for:** Ensure the shared module is runtime-neutral (no Worker-specific or Pages-specific APIs).

---

### Finding 14: DependencyWeightSchema Divergence
**What exists now:** `shared/types/report-cards.ts:53` defines a loose `DependencyWeightSchema` (plain `z.number()`). `shared/types/stablecoin-meta-schemas.ts:71` defines a strict version (`.strict()`, `z.number().finite().positive().max(1)`).

**What is wrong:** Divergent validation strictness for the same logical type.

**What to do:** Keep the stricter version. Export it from `stablecoin-meta-schemas.ts` and import it into `report-cards.ts`. Delete the loose local copy.

**What to watch out for:** Check if any runtime code relies on the loose validation (e.g., accepting `0` or negative weights).

---

### Finding 15: Redemption Status Values Duplicated
**What exists now:** `shared/types/redemption.ts:66` defines `RedemptionRouteStatusSchema` as a Zod enum. `shared/types/live-reserves.ts:98` defines `LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_VALUES` as a hardcoded array of the same 5 strings.

**What is wrong:** Adding a new status requires two edits.

**What to do:** Derive the array from the schema: `z.enum([...]).options`.

**What to watch out for:** Ensure the derived array is typed correctly for its consumers.

---

### Finding 16: ReportCardDetail Monolith with Inline Regex
**What exists now:** `src/components/report-card.tsx` (445 lines) contains `GradeGlow`, `DimensionLabel`, `DimensionRow`, and the main `ReportCardDetail`. `DimensionRow` includes regex parsing (`part.match(/^(.+?):\s*(.+?)\s*\((-?\d+)\)$/)`) and deeply nested conditional UI.

**What is wrong:** The component is doing data transformation, formatting, and rendering. The regex parsing belongs in a view-model.

**What to do:** Extract `parseDimensionDetail(detail: string)` into `src/lib/report-card-parsing.ts`. Extract `GradeGlow` into its own file if it grows.

**What to watch out for:** The regex is brittle. Add unit tests for `parseDimensionDetail` before extracting it.

---

### Finding 17: useCommandPaletteHistory Over-Engineered
**What exists now:** `src/hooks/use-command-palette-history.ts` (140 lines) uses `useSyncExternalStore`, custom event dispatching, and snapshot caching for a "last 5 visited items" list.

**What is wrong:** Unless cross-tab sync is a hard requirement, this is massive overkill for a 5-item list.

**What to do:** Replace with `usePreference("pharos-cmd-history", [])` + `useCallback` for append/replace logic. If cross-tab sync is required, document it explicitly in a code comment.

**What to watch out for:** Verify that `usePreference` handles the array serialization correctly (it likely does).

---

### Finding 18: useSidebarNavSignals Over-Specific
**What exists now:** `src/hooks/use-sidebar-nav-signals.ts` consumes 5 API queries (`usePegSummary`, `useStabilityIndex`, `useBlacklistSummary`, `useHealth`, `useDailyDigest`) to compute 5 boolean badge states.

**What is wrong:** High query subscription cost for minimal output. Each query fetches full payloads.

**What to do:** Either add a lightweight `/api/nav-signals` endpoint that returns `{ hasDepeg, hasBlacklist, hasDigest, ... }`, or compute signals from a single lightweight status endpoint.

**What to watch out for:** This requires API change. Coordinate with Worker layer.

---

### Finding 19: Dead Layout Files
**What exists now:** `src/app/blacklist/layout.tsx` exports metadata and renders `<>children</>`. `src/app/flows/layout.tsx` does the same plus JSON-LD.

**What is wrong:** Next.js does not require a layout for metadata. These files add indirection.

**What to do:** Move metadata to `page.tsx`. Delete `layout.tsx`. For `flows`, move JSON-LD to `page.tsx` to match other pages.

**What to watch out for:** None. Trivial change.

---

### Finding 20: GradeBadge Thin Wrapper
**What exists now:** `src/components/grade-badge.tsx` (28 lines) imports `Badge` from shadcn and applies `REPORT_CARD_GRADE_COLORS[grade]`.

**What is wrong:** Adds minimal value over `<Badge className={REPORT_CARD_GRADE_COLORS[grade]}>`.

**What to do:** Inline it or replace with a one-liner. Not high priority.

**What to watch out for:** It is used in a few places. Update imports.

---

### Finding 21: Root error.tsx Manual Duplication
**What exists now:** `src/app/error.tsx` is a 41-line manual JSX error boundary. Every other `error.tsx` uses `createPageError("...", "Name")`.

**What is wrong:** Duplicates `PageError` visuals (centered layout, "Try again" button, "Back to dashboard" link).

**What to do:** Replace with `export default createPageError("Something went wrong while loading this page", "RootError");`.

**What to watch out for:** None. Pure refactor.

---

### Finding 22: Metadata Helper Bypass
**What exists now:** `buildPageMetadata` is used by ~25 pages, but `admin/page.tsx`, `status/page.tsx`, `methodology/page.tsx`, `cemetery/page.tsx`, and `about/page.tsx` manually construct `Metadata` objects.

**What is wrong:** Duplicates OG/Twitter image arrays, canonical paths, and title templates.

**What to do:** Migrate all of the above to `buildPageMetadata({ title, description, canonical, ogImage })`.

**What to watch out for:** SEO output should be pixel-compared before/after. Some pages may have custom OG images.

---

### Finding 23: Chart Primitives Not Fully Adopted
**What exists now:** `src/components/chart-primitives.tsx` exports `TimeXAxis`, `MonoYAxis`, `CategoricalXAxis`, `DateTooltip`, `ChartGrid`. Many charts still inline the same props.

**What is wrong:** `dex-liquidity-card.tsx` lines 346–365 inline full `XAxis`, `YAxis`, and `Tooltip` configurations that match the primitives exactly.

**What to do:** Audit all chart components (~15 files) and migrate them to `chart-primitives`. Add missing variants (e.g., `CurrencyYAxis`) if needed.

**What to watch out for:** Some charts have custom tick formatters. Ensure primitives accept formatter props.

---

### Finding 24: localStorage Hooks Re-implement usePreference
**What exists now:** `useNavCollapse`, `useStartHereCallout`, and `usePortfolio` each manually read/write/parse localStorage instead of using the existing `usePreference` hook.

**What is wrong:** `usePreference` already handles SSR safety, JSON serialization, and change events.

**What to do:**
- `useNavCollapse`: Replace with `usePreference("pharos-nav-groups", DEFAULT_EXPANDED)`.
- `useStartHereCallout`: Replace with `usePreference` + decoder.
- `usePortfolio`: Delegate persistence to `usePreference`; keep URL-param bootstrap logic.

**What to watch out for:** `usePortfolio` has URL-param priority logic. Ensure `usePreference` does not overwrite URL-driven state on first render.

---

### Finding 25: dex-constants.ts Naming Clash
**What exists now:** `src/lib/dex-constants.ts` contains display colors/protocol logos. `worker/src/lib/dex-constants.ts` contains TVL quality multipliers and DEX API constants.

**What is wrong:** Same filename, completely different domains. Causes import confusion.

**What to do:** Rename to `src/lib/dex-display-constants.ts` and `worker/src/lib/dex-cron-constants.ts`.

**What to watch out for:** Update all imports. Use grep to find every import of both files.

---

### Finding 26: Inline Badge Styles Violate AGENTS.md
**What exists now:** `key-info-card.tsx` lines 57–112 render governance, backing, peg, infrastructure, yield-bearing, RWA, and PoR badges with inline Tailwind classes. `flow-table-logic.ts` coverage badges and `freshness-indicator.tsx` repeat similar color combinations.

**What is wrong:** AGENTS.md explicitly states: *"Classification labels and colors live in `shared/lib/classification.ts`; do not redefine them locally."*

**What to do:** Add `INFRASTRUCTURE_BADGE_STYLES`, `YIELD_BEARING_BADGE_STYLE`, `RWA_BADGE_STYLE`, etc., to `shared/lib/classification.ts` (or a new `shared/lib/badge-styles.ts`). Replace all inline instances across ~10 files.

**What to watch out for:** Some badges have conditional logic (e.g., "No PoR" vs "PoR"). The style map should handle both.

---

### Finding 27: BluechipGrade vs ReportCardGrade
**What exists now:** `shared/types/core.ts:328` defines `BluechipGrade` with 11 values (`A+` through `F`). `shared/types/report-cards.ts:27` defines `ReportCardGrade` repeating all 11 and adding `"NR"`.

**What is wrong:** Grade boundary changes require two edits.

**What to do:**
```ts
export const BaseGradeSchema = z.enum(["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F"]);
export const ReportCardGradeSchema = z.enum([...BaseGradeSchema.options, "NR"]);
```

**What to watch out for:** Check if any code relies on the literal type name `BluechipGrade`.

---

### Finding 28: BlacklistTable Bypasses DataTableShell
**What exists now:** When `isLoading` is true, `BlacklistTable` renders a completely hand-rolled `<table>` with `<Skeleton>` cells instead of using `DataTableShell`.

**What is wrong:** The loading state duplicates `DataTableShell`'s header layout manually and drifts if columns change.

**What to do:** Add a `loading` prop to `DataTableShell` that renders skeleton rows internally. Update `BlacklistTable`, `FlowTable`, `LiquidityTable`, etc., to use it.

**What to watch out for:** `DataTableShell` may need to know the column count for skeleton rows. Pass it or derive it from `columns`.

---

### Finding 29: Dead layout file (blacklist)
**What exists now:** `src/app/blacklist/layout.tsx` only exports metadata.

**What is wrong:** Next.js allows metadata in `page.tsx`.

**What to do:** Move metadata to `blacklist/page.tsx` and delete `layout.tsx`.

**What to watch out for:** None.

---

### Finding 30: isRecord Type Guard Copy-Pasted
**What exists now:** The same 1-line guard is in `shared/lib/stress-signals-envelope.ts`, `worker/src/api/stability-index.ts`, `worker/src/api/mint-burn-flows-shared.ts`, and `worker/src/cron/yield-sync/cache.ts`.

**What is wrong:** Trivial noise that accumulates.

**What to do:** Move to `shared/lib/type-guards.ts` and import everywhere.

**What to watch out for:** None.

---

## 4. Prioritized Action Plan

### Tier 1 — Quick Wins (low effort, high impact, safe independently)

| # | Action | Files | Est. Time | Verification |
|---|--------|-------|-----------|--------------|
| 1.1 | Replace root `error.tsx` with `createPageError` | `src/app/error.tsx` | 5 min | Visual parity check |
| 1.2 | Delete dead `blacklist/layout.tsx` | `src/app/blacklist/layout.tsx` | 5 min | Page renders, metadata present |
| 1.3 | Collapse `flows/layout.tsx` into `flows/page.tsx` | `src/app/flows/layout.tsx`, `flows/page.tsx` | 10 min | Page renders, JSON-LD present |
| 1.4 | Delete `isAllowedAdminPath` wrapper | `functions/api/admin/[[path]].ts` | 5 min | Build passes |
| 1.5 | Extract `isRecord` to shared utility | 4 files + new `shared/lib/type-guards.ts` | 15 min | Tests pass |
| 1.6 | Inline or remove `GradeBadge` | `src/components/grade-badge.tsx` + consumers | 10 min | Visual parity |
| 1.7 | Create `DetailSectionTitle` wrapper | `src/components/stablecoin-detail/section-title.ts` + ~10 consumers | 15 min | Build passes |
| 1.8 | Extract `parseDimensionDetail` from `report-card.tsx` | `src/components/report-card.tsx` → `src/lib/report-card-parsing.ts` | 30 min | Tests pass |
| 1.9 | Import `CircuitRecord` from shared types in worker | `worker/src/lib/circuit-breaker.ts` | 10 min | `cd worker && npx tsc --noEmit` |
| 1.10 | Move admin gate constants to shared | `shared/lib/admin-gate.ts` | 15 min | Both layers build |
| 1.11 | Unify `DependencyWeightSchema` on strict version | `shared/types/report-cards.ts`, `stablecoin-meta-schemas.ts` | 15 min | Tests pass |
| 1.12 | Derive redemption status arrays from schema | `shared/types/live-reserves.ts` | 10 min | Tests pass |
| 1.13 | Rename clashing `dex-constants.ts` files | `src/lib/dex-constants.ts`, `worker/src/lib/dex-constants.ts` | 20 min | Grep for imports, build passes |
| 1.14 | Migrate metadata bypass pages to `buildPageMetadata` | 5 pages | 30 min | SEO diff check |

**Tier 1 total estimate:** ~3.5 hours. Removes ~400–500 lines and ~3 files.

---

### Tier 2 — High-Value Refactors (medium effort, high impact, require planning)

| # | Action | Files | Est. Time | Verification |
|---|--------|-------|-----------|--------------|
| 2.1 | Centralize surface container pattern with `.pharos-surface` | 45 files | 2 h | Visual regression on key pages |
| 2.2 | Extract D1 query helpers (`loadDexPriceRows`, `getLatestPsiSample`, etc.) | 8–10 API/cron files | 2 h | Worker tests pass, SQL verified |
| 2.3 | Unify chart skeleton systems | `chart-skeleton.tsx`, `homepage-skeletons.tsx` + consumers | 1.5 h | Visual parity |
| 2.4 | Unify stat card components | `metric-stat-card.tsx` + 2 others + 6–8 consumers | 2 h | Visual parity on status, yield, detail pages |
| 2.5 | Inline thin API hooks to generic `useAdminEndpoint`/`usePublicEndpoint` | 8 hook files + consumers | 2 h | Hook tests pass |
| 2.6 | Extract `useCombinedRefetch` for god hooks | 4 hooks + new utility | 1.5 h | Hook tests pass |
| 2.7 | Make `DataTableShell` handle loading state | `data-table-shell.tsx` + 4 table consumers | 2 h | Table loading states match |
| 2.8 | Centralize inline badge styles | `shared/lib/classification.ts` or `badge-styles.ts` + ~10 files | 2 h | Visual parity |
| 2.9 | Extract shared JSON error response helper | `shared/lib/response-utils.ts` + both runtimes | 1 h | Proxy tests pass |
| 2.10 | Extract generic prune guard | `shared/lib/prune-guard.ts` + 4 consumers | 1.5 h | Rate-limit tests pass |
| 2.11 | Replace localStorage hooks with `usePreference` | `use-nav-collapse.ts`, `use-start-here-callout.ts`, `use-portfolio.ts` | 1.5 h | Local state persists correctly |
| 2.12 | Simplify `useCommandPaletteHistory` | `src/hooks/use-command-palette-history.ts` | 1 h | History persists, cross-tab behavior documented |
| 2.13 | Derive `StablecoinMeta` interface from Zod schema | `shared/types/core.ts`, `shared/lib/stablecoins/schema.ts` | 2 h | `cd worker && npx tsc --noEmit`, all imports updated |
| 2.14 | Unify `BluechipGrade`/`ReportCardGrade` | `shared/types/core.ts`, `report-cards.ts` | 30 min | Tests pass |

**Tier 2 total estimate:** ~20–22 hours. Removes/consolidates ~1,800–2,200 lines and ~15 files.

---

### Tier 3 — Structural Improvements (higher effort, long-term value)

| # | Action | Files | Est. Time | Verification |
|---|--------|-------|-----------|--------------|
| 3.1 | Migrate all charts to `chart-primitives.tsx` | ~15 chart files | 3 h | All charts render correctly |
| 3.2 | Refactor hero card mobile/desktop branching | `hero-card-metrics.tsx` + consumers | 3 h | Visual regression on mobile/desktop |
| 3.3 | Centralize `oklch()` colors and shadows into design tokens | 20+ files | 3 h | Visual parity |
| 3.4 | Extract table logic factory (`defineTableLogic`) | 5 table-logic files | 3 h | Sorting/CSV export behavior unchanged |
| 3.5 | Move hook normalization into API/shared layer | `use-mint-burn-flows.ts`, `use-stablecoin-detail-history.ts` | 3 h | API response matches hook expectations |
| 3.6 | Introduce `FeaturePageSkeleton` for route loading states | `createClientFeaturePage` + 5 route files | 3 h | Loading states consistent |
| 3.7 | Evaluate `FeaturePageShell` adoption for longform pages | `methodology`, `cemetery`, `digest/[date]` | 4 h | Design review + visual parity |
| 3.8 | Add `/api/nav-signals` endpoint to replace `useSidebarNavSignals` | Worker API + hook | 4 h | Sidebar badges still accurate |
| 3.9 | Make `StablecoinVirtualRow` compose `InteractiveTableRow` | Both files | 2 h | Table interactions unchanged |
| 3.10 | Extract `buildStablecoinMap` utility for duplicated Map builders | 4 view-model/hook files | 1 h | Tests pass |

**Tier 3 total estimate:** ~25–30 hours. Improves maintainability but does not significantly reduce line count.

---

### Defer or Skip

| # | Issue | Reason |
|---|-------|--------|
| D.1 | Status page micro-component grouping (`status/*.tsx`) | Files are well-isolated and tree-shakeable; grouping adds little value |
| D.2 | `cache-json.ts` vs `api-cache-read.ts` consolidation | APIs differ in shape; partial overlap is acceptable |
| D.3 | Full unification of Pages/Worker auth layers | Security model requires defense-in-depth; constant-sharing is sufficient |
| D.4 | `EmptyStateSurface` adoption in `stablecoin-table-empty-state.tsx` | Table empty state has search-specific UX that doesn't fit the generic shell |
| D.5 | `package.json` metadata duplication between root and worker | Acceptable in non-workspace setup; low risk |
