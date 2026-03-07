# Codebase Simplification Audit

**Date:** 2026-03-07
**Scope:** 591 TypeScript files, ~100K lines across `src/`, `worker/`, `shared/`
**Focus:** Duplication, over-engineering, complexity, dead code, structural issues

---

## Summary

The codebase is well-structured overall with clear boundaries (frontend / worker / shared) and consistent patterns. The main simplification opportunities stem from **duplicated methodology version infrastructure** (6 identical file templates), **dead code exports**, **history endpoint handler boilerplate**, and **scoring changelog not using the factory pattern**. Implementing all high and medium findings would eliminate ~1,500 lines and consolidate 15+ files.

### Biggest Themes

1. **Methodology version file duplication** — 6 files with identical structure, identical logic, identical test files. ~950 lines of pure duplication.
2. **Dead code** — `isValidStablecoinId()` never called, deprecated wrappers in `flow-intensity.ts`, unused component props.
3. **History endpoint boilerplate** — 4 API handlers repeat the same `handleStablecoinHistoryRequest` scaffolding.
4. **Scoring changelog outlier** — `scoring-changelog/page.tsx` (856 lines) doesn't use the factory pattern that keeps other changelog pages at 26 lines.
5. **Inline response construction** — 13 places bypass the `errorResponse()` utility.
6. **Status-reliability try-catch repetition** — 15 identical try-catch blocks in one file.

---

## Prioritized Findings

### HIGH SEVERITY

---

#### H1: Methodology Version Files — Massive Structural Duplication

**Location:** `shared/lib/{depeg-dews,mint-burn-flow,stability-index,liquidity-score,blacklist-tracker,yield-methodology}-version.ts`
**Category:** Duplication
**Lines affected:** ~950 lines across 6 files + ~190 lines across 6 test files

**Current state:** Six files follow an identical template:
1. `VERSION` constant (string)
2. `VERSION_LABEL` constant (`v${VERSION}`)
3. `CHANGELOG_PATH` constant (string)
4. `ChangelogEntry` interface — identical fields except one field name varies (`methodologyImpact` / `scoreImpact` / `trackingImpact`)
5. `CHANGELOG` array (the actual data — this is different per file)
6. `VERSION_WINDOWS_ASC` — sorted copy of changelog (identical logic)
7. `getXMethodologyVersionAt()` — identical algorithm in all 6 files
8. `toXMethodologyVersionLabel()` — `return \`v${version}\`` — identical one-liner in all 6 files

Additionally, 6 test files (`src/lib/__tests__/*-version.test.ts`) follow an identical 3-test structure.

**Proposed change:** Create a generic `shared/lib/methodology-version.ts` module:

```typescript
export interface MethodologyChangelogEntry {
  version: string;
  title: string;
  date: string;
  effectiveAt: number;
  summary: string;
  impact: readonly string[];
  commits: readonly string[];
  reconstructed: boolean;
}

export interface MethodologyVersionConfig {
  currentVersion: string;
  changelogPath: string;
  changelog: readonly MethodologyChangelogEntry[];
}

export function createMethodologyVersion(config: MethodologyVersionConfig) {
  const { currentVersion, changelogPath, changelog } = config;
  const versionLabel = `v${currentVersion}`;
  const windows = [...changelog]
    .map(e => ({ version: e.version, effectiveAt: e.effectiveAt }))
    .sort((a, b) => a.effectiveAt - b.effectiveAt);

  function getVersionAt(unixSeconds: number): string {
    if (!Number.isFinite(unixSeconds)) return currentVersion;
    let resolved = windows[0]?.version ?? currentVersion;
    for (const w of windows) {
      if (unixSeconds >= w.effectiveAt) resolved = w.version;
      else break;
    }
    return resolved;
  }

  return { currentVersion, versionLabel, changelogPath, changelog, getVersionAt };
}

export function toMethodologyVersionLabel(version: string): string {
  return `v${version}`;
}
```

Each version file shrinks to just its data + a one-line factory call. The 6 `toXMethodologyVersionLabel` functions collapse into one shared `toMethodologyVersionLabel`. The changelog entry interfaces unify with `impact` as the canonical field name (the UI already maps via `selectImpact`). Tests can use a single parametrized test helper.

**Estimated reduction:** ~600 lines of source + ~120 lines of tests

**Risk:** Medium — requires updating all imports in worker API handlers and frontend changelog pages. The changelog page factory (`changelog-route-factory.ts`) already uses `selectImpact` to abstract the field name difference, so the frontend side is mostly ready.

**Verification:**
- `npm run build` (type-check + build)
- `npm test` (all version tests should pass)
- Verify all 6 changelog pages render correctly
- Verify worker API responses still include correct `methodologyVersion` fields

---

#### H2: `SortDirection` Type Defined Three Times

**Location:**
- `src/hooks/use-sort.ts:5` — `export type SortDirection = "asc" | "desc";`
- `src/hooks/use-sorted-table-rows.ts:6` — `type SortDirection = "asc" | "desc";`
- `src/hooks/use-sorted-paginated-table.ts:6` — `type SortDirection = "asc" | "desc";`

**Category:** Duplication
**Lines affected:** 3

**Current state:** The same type alias is defined independently in 3 files. `use-sorted-table-rows.ts` and `use-sorted-paginated-table.ts` define their own local copies instead of importing from `use-sort.ts`.

**Proposed change:** Delete the local definitions in `use-sorted-table-rows.ts` and `use-sorted-paginated-table.ts`. Import from `use-sort.ts` (which already exports it).

**Estimated reduction:** 2 lines (but eliminates a maintenance drift risk)

**Risk:** Very low. These are identical type aliases.

**Verification:** `npm run build`

---

#### H3: Dynamic Route Matching Duplication in Router

**Location:** `worker/src/router.ts:282-323`
**Category:** Duplication
**Lines affected:** ~40 lines

**Current state:** The `/api/stablecoin-summary/:id` and `/api/stablecoin/:id` route matching blocks are near-identical:
```typescript
const summaryMatch = path.match(/^\/api\/stablecoin-summary\/(.+)$/);
if (summaryMatch) {
  let id: string;
  try { id = decodeURIComponent(summaryMatch[1]); }
  catch { return Promise.resolve(/* Malformed URI error */); }
  const resolved = resolveOrReject(id, ...);
  if (resolved instanceof Response) return Promise.resolve(resolved);
  return handleX(db, resolved.canonicalId);
}
// ... exact same pattern for /api/stablecoin/:id
```

**Proposed change:** Extract a `matchDynamicRoute` helper:
```typescript
function matchDynamicRoute(
  path: string,
  pattern: RegExp,
  handler: (db: D1Database, id: string, ctx: ExecutionContext) => Promise<Response>,
  db: D1Database,
  ctx: ExecutionContext,
): Promise<Response> | null {
  const match = path.match(pattern);
  if (!match) return null;
  let id: string;
  try { id = decodeURIComponent(match[1]); }
  catch { return Promise.resolve(errorResponse(400, "Malformed URI")); }
  const resolved = resolveOrReject(id, `path=${path}`);
  if (resolved instanceof Response) return Promise.resolve(resolved);
  return handler(db, resolved.canonicalId, ctx);
}
```

**Estimated reduction:** ~20 lines

**Risk:** Very low. Pure refactor of duplicated control flow.

**Verification:** `cd worker && npx tsc --noEmit` + run `worker/src/api/__tests__/router-contract.test.ts`

---

#### H4: Inline Response Construction Bypasses `errorResponse()` Utility

**Location:** `worker/src/router.ts` (8 occurrences), `worker/src/lib/auth.ts` (2), `worker/src/handlers/http.ts` (2), `worker/src/lib/rate-limit.ts` (1)
**Category:** Complexity / Duplication
**Lines affected:** ~30 lines

**Current state:** The codebase has a well-designed `errorResponse(status, message)` utility in `api-utils.ts`, used in 53 call sites. But 13 places in non-test code still construct error responses inline:
```typescript
new Response(JSON.stringify({ error: "Bad request" }), {
  status: 400,
  headers: { "Content-Type": "application/json" },
})
```

**Proposed change:** Replace all inline constructions with `errorResponse()`. The router already imports it.

**Estimated reduction:** ~15 lines, plus consistency improvement

**Risk:** Very low. The output is byte-identical.

**Verification:** `cd worker && npx tsc --noEmit` + existing tests

---

### MEDIUM SEVERITY

---

#### M1: Cache-Passthrough API Files Are Trivial Config

**Location:**
- `worker/src/api/stablecoins.ts` (4 lines)
- `worker/src/api/stablecoin-charts.ts` (4 lines)
- `worker/src/api/bluechip.ts` (4 lines)
- `worker/src/api/usds-status.ts` (4 lines)
- `worker/src/api/yield-rankings.ts` (13 lines)

**Category:** Structural
**Lines affected:** 29 lines across 5 files

**Current state:** Five API handler files each contain a single `createCacheHandler(...)` call. They exist as separate files only because the router imports each by name from its own module.

**Proposed change:** Consolidate into a single `worker/src/api/cache-handlers.ts`:
```typescript
export const handleStablecoins = createCacheHandler("stablecoins", "stablecoins", CACHE_PROFILES.realtime, 600);
export const handleStablecoinCharts = createCacheHandler("stablecoin-charts", "stablecoin-charts", CACHE_PROFILES.standard, 600);
export const handleBluechipRatings = createCacheHandler("bluechip-ratings", "bluechip-ratings", CACHE_PROFILES.slow, 43200);
export const handleUsdsStatus = createCacheHandler("usds-status", "usds-status", CACHE_PROFILES.standard, 86400);
export const handleYieldRankings = createCacheHandler("yield-rankings", "yield-rankings", CACHE_PROFILES.standard, 3600);
```

**Estimated reduction:** 4 files deleted, ~15 lines saved

**Risk:** Low. Update imports in `router.ts`.

**Verification:** `cd worker && npx tsc --noEmit` + `npm test`

---

#### M2: `data-health-config.ts` Is Single-Use, 22 Lines

**Location:** `src/lib/data-health-config.ts` (22 lines, imported only by `src/hooks/use-health.ts`)
**Category:** Over-Engineering
**Lines affected:** 22

**Current state:** This file defines `DATA_HEALTH_PRESETS` — a simple record of label/staleTime pairs. It's only imported in one place.

**Proposed change:** Move the presets directly into `src/hooks/use-health.ts` or into `src/lib/data-health.ts` where the health logic already lives.

**Estimated reduction:** 1 file, ~5 lines of import boilerplate

**Risk:** Very low.

**Verification:** `npm run build`

---

#### M3: `blacklist-api.ts` Is Single-Use, 50 Lines

**Location:** `src/lib/blacklist-api.ts` (50 lines, imported only by `src/hooks/use-blacklist-events.ts`)
**Category:** Over-Engineering
**Lines affected:** 50

**Current state:** Contains `fetchAllBlacklistEvents()` — a pagination utility used by exactly one hook.

**Proposed change:** Inline into `src/hooks/use-blacklist-events.ts`. The function is self-contained and doesn't benefit from being a separate module.

**Estimated reduction:** 1 file

**Risk:** Very low.

**Verification:** `npm run build` + blacklist page functional test

---

#### M4: `buildMethodologyEnvelope` Adds No Logic

**Location:** `worker/src/lib/api-utils.ts:203-220`
**Category:** Over-Engineering
**Lines affected:** 18

**Current state:** `buildMethodologyEnvelope()` takes an `input` object and returns `{ ...input, isCurrent: version === currentVersion }`. It's a function that adds one boolean to a pass-through object.

**Proposed change:** Inline the `isCurrent` computation at call sites. The abstraction adds no clarity.

**Estimated reduction:** ~15 lines

**Risk:** Low. Verify all call sites.

**Verification:** `cd worker && npx tsc --noEmit`

---

#### M5: `formatHealthAge` Duplicates `timeAgo` Logic

**Location:**
- `src/lib/data-health.ts:148-155` — `formatHealthAge(ms)`
- `shared/lib/format.ts:124-132` — `timeAgo(epochSec)`

**Category:** Duplication
**Lines affected:** 8

**Current state:** Both functions convert a time delta into human-readable strings like "5m", "2h", "3d". They differ in input units (milliseconds vs epoch seconds) and exact format ("5m" vs "5m ago"), but the core logic is duplicated.

**Proposed change:** Keep both since they serve different UX contexts (health status vs data freshness), but document the relationship to prevent future drift. This is low-priority.

**Risk:** N/A (documentation only)

---

#### M6: `safety-score-version.ts` Doesn't Follow the Pattern

**Location:** `shared/lib/safety-score-version.ts` (8 lines)
**Category:** Structural inconsistency

**Current state:** This file only exports `SAFETY_SCORE_VERSION`, `SAFETY_SCORE_VERSION_LABEL`, and `SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH` — no changelog array, no `getVersionAt`, no `toVersionLabel`. The scoring changelog page (`scoring-changelog/page.tsx`) at 856 lines has its own inline changelog data.

**Proposed change:** After implementing H1 (generic methodology version module), migrate the scoring changelog data into the same pattern. This would make all 7 methodologies consistent.

**Risk:** Medium. The scoring changelog page has the most entries (856 lines of content). Requires careful migration.

---

#### M7: `stablecoin-detail-derive.ts` Is Single-Use, 104 Lines

**Location:** `src/lib/stablecoin-detail-derive.ts` (104 lines, imported only by `src/hooks/use-stablecoin-detail-view-model.ts`)
**Category:** Over-Engineering

**Current state:** Derives a view model from raw API data. Used only once.

**Proposed change:** Inline into `use-stablecoin-detail-view-model.ts`. The view model derivation is tightly coupled to the hook.

**Estimated reduction:** 1 file

**Risk:** Low.

---

### LOW SEVERITY

---

#### L1: Unused `toXMethodologyVersionLabel` Functions

**Location:**
- `toMintBurnFlowMethodologyVersionLabel` — **never imported** outside its own file and test
- `toLiquidityMethodologyVersionLabel` — never imported outside its own file and test
- `toYieldMethodologyVersionLabel` — never imported outside its own file and test

**Category:** Dead Code
**Lines affected:** 3 functions

**Current state:** Three of the six `toXMethodologyVersionLabel()` functions are only used in tests. The actual API handlers that need version labels use the corresponding `VERSION_LABEL` constant directly.

**Proposed change:** These go away automatically when H1 is implemented.

---

#### L2: `page` and `effectivePage` Returned Redundantly

**Location:** `src/hooks/use-table-pagination.ts:113-114`
**Category:** Over-Engineering

**Current state:** The return object includes both `page: effectivePage` and `effectivePage`. They are always the same value.

**Proposed change:** Remove `page` from the return interface, keep only `effectivePage`.

**Risk:** Low. Check all consumers.

---

#### L3: `cron-intervals.ts` Is 7 Lines, Single-Use Pattern

**Location:** `src/lib/cron-intervals.ts` (8 lines)
**Category:** Over-Engineering

**Current state:** Defines 6 constants (`CRON_1MIN`, `CRON_15MIN`, etc.). Imported by 2 files: `use-api-query.ts` (re-exports them) and `data-health-config.ts`.

**Proposed change:** Move into `use-api-query.ts` where the constants are re-exported from anyway, or into `data-health-config.ts` if M2 is done.

**Estimated reduction:** 1 file

**Risk:** Very low.

---

#### L4: Repeated `.toFixed()` Formatting in Components

**Location:** Throughout `src/components/` — 55+ occurrences
**Category:** Complexity (minor)

**Current state:** Many components format numbers inline:
```tsx
{score.toFixed(1)}%
{(mcap / 1e9).toFixed(1)}B
{change >= 0 ? "+" : ""}${change.toFixed(2)}%
```

Some of these could use `formatCurrency()` or `formatPercentChange()` from `shared/lib/format.ts`, but many are context-specific enough that a shared formatter wouldn't add clarity.

**Proposed change:** No action — the inline formatting is usually clearer in context than an abstraction would be. The existing `formatCurrency` and `formatPercentChange` utilities cover the cases where abstraction helps.

---

#### L5: `peg-stability.ts` Could Live in Hooks

**Location:** `src/lib/peg-stability.ts` (86 lines, imported only by `src/hooks/use-stablecoin-detail-view-model.ts`)
**Category:** Structural

**Current state:** Single-consumer utility.

**Proposed change:** Consider inlining into the view model hook, similar to M7. However, the function has non-trivial logic (depeg interval merging) that benefits from being testable in isolation. Keep as-is unless M7 is done first.

---

#### L6: `mint-burn-timeframes.ts` Could Live in Hooks

**Location:** `src/lib/mint-burn-timeframes.ts` (59 lines, imported only by `src/components/stablecoin-detail/hero-card.tsx`)
**Category:** Structural

**Current state:** Single-consumer utility with USDT-specific override config.

**Proposed change:** Could be inlined into `hero-card.tsx`, but the per-coin override map is a reasonable standalone concern. Keep as-is.

---

## Files NOT Changed (and Why)

| Area | Reason |
|------|--------|
| `shared/lib/stablecoins.ts` (3968 lines) | Data file — all stablecoin metadata. Cannot be simplified. |
| `shared/types/index.ts` (1401 lines) | Type definitions + Zod schemas. Size is proportional to API surface. |
| `shared/lib/dead-stablecoins.ts` (1150 lines) | Data file — cemetery records. Cannot be simplified. |
| `src/components/stablecoin-detail/*.tsx` thin wrappers | Serve as `dynamic()` code-splitting boundaries. Intentional. |
| `src/components/contagion-graph.tsx` (1183 lines) | Complex force-directed graph visualization. Size is inherent. |
| `src/components/flow-machine-scene.tsx` (929 lines) | Animated 3D scene. Complexity is inherent. |
| `src/app/methodology/page.tsx` (2328 lines) | Static content page. Size is content volume, not complexity. |
| `worker/src/lib/db.ts` (439 lines) | Well-organized DB utilities with distinct responsibilities. |
| `worker/src/lib/api-utils.ts` (456 lines) | Central utility module. Functions are well-used and non-redundant. |

---

## Implementation Plan

### Phase 1: Zero-Risk Quick Wins (verify: `npm run build && npm test`)

1. **H2**: Remove redundant `SortDirection` type definitions
2. **H4**: Replace inline `new Response(JSON.stringify({error:...}))` with `errorResponse()` in router/auth/http
3. **L2**: Remove redundant `page` from pagination return

### Phase 2: Consolidation (verify: `npm run build && npm test` + manual page checks)

4. **H3**: Extract `matchDynamicRoute` helper in router
5. **M1**: Consolidate cache-passthrough handlers into one file
6. **M2**: Merge `data-health-config.ts` into `data-health.ts`
7. **M3**: Inline `blacklist-api.ts` into its consumer hook
8. **L3**: Merge `cron-intervals.ts` into `use-api-query.ts`

### Phase 3: Structural (verify: full build + all tests + verify all changelog pages + verify API responses)

9. **H1**: Create generic methodology version infrastructure and migrate all 6 version files
10. **M6**: Migrate scoring changelog to the same pattern
11. **M4**: Inline `buildMethodologyEnvelope`
12. **M7**: Inline `stablecoin-detail-derive.ts` into view model hook

### Phase 4: Optional (verify: build + manual checks)

13. **L1**: Automatic cleanup after H1

---

## Estimated Impact

| Metric | Before | After |
|--------|--------|-------|
| Total files | 591 | ~580 |
| Lines of code | ~100,289 | ~99,400 |
| Duplicated methodology logic | 6 copies | 1 generic |
| Inline error responses | 13 | 0 |
| Single-use lib files | 6 | 2 |

The reductions are modest in absolute terms (~1%) because the codebase is fundamentally well-structured. The main value is in eliminating maintenance burden from duplicated patterns, not in raw line count reduction.
