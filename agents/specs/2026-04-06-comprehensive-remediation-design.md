# Comprehensive Codebase Remediation — Design Spec

**Date:** 2026-04-06
**Source:** `agents/audits/comprehensive-codebase-audit-2026-04-06.md`
**Scope:** 32 actionable findings (13 excluded as deferred/informational/N/A)
**Execution model:** 5 agent streams across 2 waves, optimized for parallel worktree execution

---

## 1. Architecture

```
Wave 1 (4 parallel worktree agents)           Wave 2 (1 agent, post-merge)
┌─────────────────────────────────┐           ┌──────────────────────────────┐
│ Stream 1: Worker Internals      │──┐        │ Stream 5: Barrel Export      │
│   8 findings · ~50 files        │  │        │ Migration + Validation       │
├─────────────────────────────────┤  │ merge  │   S-015 · ~250 files         │
│ Stream 2: Frontend + Formatting │  ├──►─────►│   + full merge-gate run      │
│  10 findings · ~55 files        │  │        └──────────────────────────────┘
├─────────────────────────────────┤  │
│ Stream 3: Shared + Cross-Runtime│  │
│   4 findings · ~40 files        │  │
├─────────────────────────────────┤  │
│ Stream 4: Build/CI/Docs/Infra   │──┘
│   8 findings · ~15 files        │
└─────────────────────────────────┘
```

**Merge order:** Stream 4 → Stream 1 → Stream 3 → Stream 2 → Wave 2 (Stream 5).
Rationale: Streams 1 and 4 have minimal file overlap with other streams (Stream 1 touches `shared/lib/cron-jobs.ts` and `shared/lib/scheduled-runner-registry.ts` in the shared namespace, but no other stream writes to those files). Stream 3 modifies api-endpoint import paths in files Stream 2 also touches (function bodies only), so Stream 3 merges first to establish the import-path baseline. Stream 2 merges last among Wave 1 streams. Wave 2 runs on the fully merged result. Note: Stream 1 writes `worker/package.json`, Stream 4 writes root `package.json` — different files.

---

## 2. File Ownership Matrix

Each stream has exclusive write access to its listed files. No stream may edit files owned by another stream.

### Stream 1: Worker Internals

```
worker/src/cron/**                           (all cron modules + reserve adapters)
worker/src/api/mint-burn-flows.ts            (Q-001 handleAggregate split)
worker/src/api/telegram-webhook.ts           (Q-009 auth warning)
worker/src/lib/rate-limit.ts                 (S-002 IsolateLocalState)
worker/src/lib/request-source-attribution.ts (S-002 IsolateLocalState)
worker/src/lib/api-keys.ts                   (S-002 IsolateLocalState)
worker/src/lib/isolate-local-state.ts        (NEW — S-002)
worker/src/lib/alchemy-logs.ts               (Q-003 catch comments)
worker/src/lib/fetch-retry.ts                (R-002 body cancel)
worker/src/lib/evm-logs.ts                   (R-002 body cancel)
worker/src/api/backfill-depegs.ts            (R-002 body cancel)
worker/src/handlers/scheduled/**             (S-009 cron consolidation — subdirectory files)
worker/src/handlers/scheduled.ts             (S-009 runner dispatch — remove daily0805Utc key)
worker/wrangler.toml                         (S-009 cron consolidation)
worker/package.json                          (S-004 viem subpath import)
shared/lib/cron-jobs.ts                      (S-009 schedule key removal)
shared/lib/scheduled-runner-registry.ts      (S-009 runner key removal)
```

### Stream 2: Frontend + Formatting

```
src/components/**                            (S-011 model extraction, Q-002 homepage split, R-003 formatting)
src/app/**                                   (R-003 formatting in page clients)
src/hooks/**                                 (R-003 formatting in hooks)
src/lib/**                                   (R-007, R-008, R-009, R-012, R-013 cleanup)
shared/lib/format.ts                         (R-003 formatPercentFromRatio addition)
shared/lib/__tests__/format.test.ts          (R-003 tests, R-004 dedup)
src/lib/__tests__/format.test.ts             (R-004 remove duplicate tests)
```

### Stream 3: Shared Layer + Cross-Runtime

```
shared/lib/api-endpoints.ts                  (S-007 → split into api-endpoints/ directory)
shared/lib/api-endpoints/**                  (NEW — S-007 sub-modules + barrel)
shared/lib/env-utils.ts                      (NEW — S-003)
shared/lib/validate-coin-id.ts               (R-011 JSDoc)
functions/lib/proxy-utils.ts                 (NEW — R-001)
functions/lib/ops-env.ts                     (S-003 import update)
functions/api/admin/[[path]].ts              (R-001 proxy helper extraction)
functions/_site-data/[[path]].ts             (R-001 proxy helper extraction)
worker/src/lib/env.ts                        (S-003 import update only)
+ 34 api-endpoint consumer files             (S-007 import path updates)
```

**S-007 consumer files** (import path updates only — no logic changes):

Frontend hooks: `src/hooks/api-hooks.ts`, `use-chains.ts`, `use-stablecoins.ts`, `use-depeg-events.ts`, `use-mint-burn-flows.ts`, `use-endpoint-probes.ts`, `use-compare-data-model.ts`, `use-stablecoin-detail-history.ts`, `use-blacklist-events.ts`, `use-prefetch-stablecoin.ts`, `use-api-keys.ts`, `use-request-source-stats.ts`, `use-treasury-stable-exposure.ts`
Frontend other: `src/components/status/admin-action-button.tsx`, `src/components/status/admin-actions-panel.tsx`, `src/lib/api.ts`, `src/lib/blacklist-api.ts`, `src/lib/status/action-recommendations.ts`
Worker: `worker/src/router.ts`, `worker/src/handlers/http/context.ts`, `worker/src/handlers/http/edge-cache.ts`, `worker/src/handlers/http/gates.ts`, `worker/src/cron/status-self-check.ts`, `worker/src/routes/dependency-hydrators.ts`, `worker/src/routes/dynamic-routes.ts`, `worker/src/routes/registry.ts`, `worker/src/routes/shared.ts`
Shared: `shared/lib/request-attribution.ts`, `shared/lib/site-data-routes.ts`
Functions: `functions/api/admin/[[path]].ts`
Tests: `src/hooks/__tests__/query-polling-policy.test.ts`, `worker/src/api/__tests__/router-contract.test.ts`

**Note:** The barrel re-export (`api-endpoints/index.ts`) preserves the same import path (`@shared/lib/api-endpoints` → `api-endpoints/index.ts`), so consumer files do NOT need import path changes. The list above is the blast radius for reference only — the agent should verify imports resolve after the split, not manually rewrite them.

**Overlap note:** The barrel re-export at `api-endpoints/index.ts` makes S-007 a zero-consumer-change refactoring. Files under `src/hooks/`, `src/components/`, and `src/lib/` (which Stream 2 owns) do NOT need import path updates. Stream 3 only writes to the `shared/lib/api-endpoints/` directory itself and verifies consumers compile. If any consumer does fail to resolve, Stream 3 should only fix files NOT owned by Stream 2 and flag the rest for post-merge resolution. Merge order (Stream 3 before Stream 2) ensures any import-level changes land first.

### Stream 4: Build/CI/Docs/Infra

```
.github/workflows/pull-request-checks.yml    (S-005)
scripts/generate-sitemap-dates.ts             (NEW — S-006)
scripts/check-hotspot-ratchet.mjs             (S-013)
src/app/sitemap.ts                            (S-006 import generated dates)
worker/src/lib/db-cache.ts                    (S-010 size tracking)
worker/src/lib/status/d1-usage.ts             (S-010 telemetry)
README.md                                     (S-014)
docs/**                                       (S-008, S-012, Q-008)
package.json                                  (S-006 prebuild update)
```

### Stream 5 (Wave 2): Barrel Export Migration

```
shared/types/index.ts                         (deprecation comment)
~250 files importing from @shared/types       (import path rewrites — exact count determined at runtime via grep)
```

**Scope note:** The barrel import count is estimated at ~250 files (~284 occurrences). The agent MUST grep for the exact count at execution time. Process in batches by directory: `src/lib/` → `src/components/` → `src/hooks/` → `src/app/` → `worker/` → `shared/` → `functions/`.

---

## 3. Stream Specifications

### Stream 1: Worker Internals

#### Step 1a — R-006: Remove `getAdapterTimeout`

**What:** `getAdapterTimeout(config, fallbackMs)` in `worker/src/cron/reserve-adapters/helpers.ts:141-144` explicitly discards `config` and always returns `fallbackMs`. Remove the function definition and replace all 28 consumer call sites with the literal timeout they already pass.

**Files:** `helpers.ts` (remove definition), 28 adapter files (mechanical replacement), 2 test files (update if needed).

**Pattern:**
```typescript
// Before
const timeout = getAdapterTimeout(config, 12_000);
// After
const timeout = 12_000;
```

**Verification:** `grep -r "getAdapterTimeout" worker/` returns 0 hits.

#### Step 1b — S-004: Tree-shake viem via subpath imports

**What:** Replace broad `from "viem"` imports with specific `from "viem/abi"` subpath imports to enable tree-shaking. This reduces the deployed worker bundle to only the ABI codec, rather than shipping the full viem client (48 MB installed).

**Why not full removal:** The Slipstream Sugar ABI involves deeply nested tuple return types (arrays of structs with 27+ fields including `int24`, `uint160`, `address[]`). Building a custom ABI encoder/decoder for these types is high-risk and unjustified. Subpath imports achieve the bundle-size goal with near-zero risk.

**Depends on:** Step 1a (crvusd.ts cleaned of getAdapterTimeout first).

**Files:**
- `worker/src/cron/dex-liquidity/fetch-slipstream.ts` — change `from "viem"` to `from "viem/abi"`
- `worker/src/cron/reserve-adapters/crvusd.ts` — change `from "viem"` to `from "viem/abi"`
- `worker/src/cron/dex-liquidity/__tests__/fetch-slipstream.test.ts` — change `from "viem"` to `from "viem/abi"`
- `worker/src/cron/reserve-adapters/__tests__/crvusd.test.ts` — change `from "viem"` to `from "viem/abi"`

**Pattern:**
```typescript
// Before
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
// After
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem/abi";
```

**Verification:** `grep -rn 'from "viem"' worker/src/` returns 0 hits (note: `worker/scripts/` may still use broad viem imports for one-off reconciliation scripts — that is acceptable). All existing tests pass.

#### Step 1c — R-002: Replace inline body cancel

**What:** Replace 13+ inline `await res.body?.cancel()` with `cancelResponseBodyQuietly(res)` from `worker/src/lib/response-body.ts`.

**Depends on:** Step 1a (helpers.ts cleaned first).

**Files:** `helpers.ts` (4 sites), `fetch-retry.ts` (2), `evm-logs.ts` (2), `tron-source.ts`, `enrich-prices-passes.ts`, `backfill-depegs.ts`, `alchemy-logs.ts`.

**Pattern:**
```typescript
// Before
try { await res.body?.cancel(); } catch { }
// After
import { cancelResponseBodyQuietly } from "../lib/response-body";
cancelResponseBodyQuietly(res);
```

**Verification:** `grep -rn "res\.body\?\.cancel\(\)" worker/src/` returns 0 hits outside `response-body.ts` itself.

#### Step 2 — Q-001: Split `handleAggregate`

**What:** The 360-line `handleAggregate` function in `worker/src/api/mint-burn-flows.ts` (lines 102-463) issues 11 parallel D1 queries, builds baseline maps, computes scores, and serializes the response. Split into 3 focused functions.

**Files:** `worker/src/api/mint-burn-flows.ts`

**Approach:**
1. Extract the inline coin response type (lines 274-313) into a named `CoinFlowSummary` interface at module level.
2. Extract query execution into `fetchAggregateData(db, params)` returning a typed result object.
3. Extract per-coin logic into `buildCoinSummaries(data, params)` returning `CoinFlowSummary[]`.
4. Slim `handleAggregate` to: parse params → fetch → build → serialize response.

**Verification:** Existing tests for the mint-burn-flows API pass unchanged. `handleAggregate` is under 60 lines.

#### Step 3 — Q-003: Document silent catch blocks

**What:** Add explanatory comments to undocumented bare `catch { }` blocks. Add `console.debug` to `alchemy-logs.ts` (5 consecutive bare catches) so systematic failures become observable.

**Files:** `sync-stablecoin-charts.ts:86`, `alchemy-logs.ts` (5 sites), `scoring.ts:119`, `challenger-persistence.ts:156`, and any other undocumented bare catches found in worker/src/cron/.

**Pattern:**
```typescript
// Before
} catch { }
// After (if intentionally silent)
} catch { /* non-blocking: description of why this is safe to swallow */ }
// After (if observability needed, e.g. alchemy-logs)
} catch (err) { console.debug("[alchemy] operation description failed", err); }
```

#### Step 4 — Q-009: Telegram webhook auth warning

**What:** Add `console.warn` before the `return new Response("OK", { status: 200 })` on auth failure in `worker/src/api/telegram-webhook.ts:70-71`.

**One-line change.**

#### Step 5 — S-002+Q-007: Extract `IsolateLocalState`

**What:** Create `worker/src/lib/isolate-local-state.ts` with a typed utility that documents per-isolate semantics and provides `reset()` for tests. Refactor the 3 consumer files to use it.

**Files:**
- `worker/src/lib/isolate-local-state.ts` (NEW)
- `worker/src/lib/rate-limit.ts` — replace 6 module-level `let` vars
- `worker/src/lib/request-source-attribution.ts` — replace 2 module-level `let` vars
- `worker/src/lib/api-keys.ts` — replace 2 module-level `let` vars

**Design:**
```typescript
/**
 * Per-isolate mutable state container. Values persist across requests
 * within the same Cloudflare Worker isolate but reset on deployment
 * or isolate recycle. NOT shared across concurrent isolates.
 *
 * Use for best-effort dedup, rate limiting, and caching where
 * cross-isolate consistency is not required.
 */
export class IsolateLocalState<T extends Record<string, unknown>> {
  constructor(private initial: () => T) { ... }
  get state(): T { ... }
  reset(): void { /* for tests */ }
}
```

**Verification:** Existing tests pass. `resetRateLimitStateForTests()` replaced by `IsolateLocalState.reset()`.

#### Step 6 — S-009: Consolidate cron triggers

**What:** Merge `daily0800Utc` (`0 8 * * *`) and `daily0805Utc` (`5 8 * * *`) into a single `daily0800Utc` trigger. The merged runner calls both sub-runners sequentially (the 5-minute offset was only to avoid a minute collision, not for any functional dependency).

**Files:**
- `worker/wrangler.toml` — remove `daily0805Utc` cron entry (13→12 triggers)
- `shared/lib/cron-jobs.ts` — remove `daily0805Utc` schedule key
- `shared/lib/scheduled-runner-registry.ts` — remove `daily0805Utc` runner key mapping
- `worker/src/handlers/scheduled/daily-0800.ts` — import and call the daily-0805 runner after the 0800 runner completes
- `worker/src/handlers/scheduled/daily-0805.ts` — convert to an exported async function callable from daily-0800 (remove standalone runner wrapper if any)
- `worker/src/handlers/scheduled.ts` — remove `daily0805Utc` from `SLOT_RUNNER_BY_KEY` mapping

**Verification:** wrangler.toml has 12 cron triggers. `cd worker && npx tsc --noEmit` passes. `grep -r "daily0805" shared/ worker/` returns 0 hits outside daily-0805.ts itself.

---

### Stream 2: Frontend Components + Formatting

#### Step 1 — Add `formatPercentFromRatio` to shared format

**What:** Add a new function to `shared/lib/format.ts` that multiplies a ratio by 100 and formats as a percentage. This absorbs the `value * 100` + `toFixed` pattern found across ~20+ files.

**Files:** `shared/lib/format.ts`, `shared/lib/__tests__/format.test.ts`

**Design:**
```typescript
/**
 * Format a ratio (0-1 scale) as a percentage string.
 * Multiplies by 100 internally; callers should NOT pre-multiply.
 */
export function formatPercentFromRatio(
  ratio: number | null | undefined,
  decimals = 2,
): string {
  if (ratio == null) return "-";
  return `${(ratio * 100).toFixed(decimals)}%`;
}
```

#### Step 2a — S-011: Extract component model files

**What:** Extract data transformation logic from 5 large components into companion `*-model.ts` files, following the established pattern (`flow-machine-scene-model.ts`, `stablecoin-detail-view-model.ts`).

**Components:**

| Component | Lines | Extract |
|-----------|-------|---------|
| `contagion-graph.tsx` | 803 | Graph data preparation, force simulation config, node/link computation |
| `dex-liquidity-card.tsx` | 680 | Pool aggregation, scoring tier computation, sort/filter logic |
| `dews-summary.tsx` | 675 | DEWS score derivation, tier classification, trend computation |
| `yield-detail-section.tsx` | 642 | Yield data transformation, APY bucketing, source classification |
| `stablecoin-table.tsx` | 700 | Already has `stablecoin-table-logic.ts` — check if further extraction needed; if the existing split is sufficient, skip this component |

**Approach per component:**
1. Read the component to identify pure data-transformation functions (no JSX, no hooks)
2. Move those functions to a new `<component-name>-model.ts` file
3. Import from the model in the original component
4. Add basic tests for the extracted model functions

**New files:** Up to 4 new `*-model.ts` files + 4 test files in `src/components/`.

#### Step 2b — Q-002: Extract homepage sections

**What:** Extract skeleton loading states and peg distribution grid from `homepage-client.tsx` (608 lines).

**Files:**
- `src/components/homepage-skeletons.tsx` (NEW) — `ChartSkeleton`, `SectionSkeleton`, all SVG-based loading states (~80 lines)
- `src/components/peg-distribution-grid.tsx` (NEW) — static peg-type grid with counts and links
- `src/components/homepage-client.tsx` — import from new files, target under 400 lines

#### Step 3 — R-003: Replace inline percentage formatting

**What:** Systematically replace ~38 inline `${value.toFixed(N)}%` and `${(value * 100).toFixed(N)}%` patterns with the appropriate shared formatter.

**Decision tree for each site:**
- Ratio input (0-1 scale, needs ×100): use `formatPercentFromRatio(value, decimals)`
- Already-percentage input (0-100 scale): use `formatPercent(value, decimals)`
- Signed percentage: use `formatSignedPercent(value, decimals)`

**Files:** ~38 files across `src/components/`, `src/app/`, `src/hooks/`, `src/lib/` (full list in audit R-003 + exploration agent R-003 detailed list).

**Verification:** `grep -rn "\.toFixed.*['\"]%['\"]" src/ shared/` returns 0 hits outside test assertions and format.ts itself.

#### Step 4a — R-005: Yield chart date formatters

**What:** Replace `formatAxisDate` and `formatTooltipDate` in `src/components/yield-history-chart-model.ts` (lines 73-89) with `formatChartDate` presets from `shared/lib/format.ts`.

**Mapping:**
- `formatAxisDate(ts, days)` → `formatChartDate(ts, days > 180 ? "compact" : "short")`
- `formatTooltipDate(ts)` → `formatChartDate(ts, "full")`

Remove the cached `Intl.DateTimeFormat` instances.

#### Step 4b — R-008: Remove `formatTreasuryPct`

**What:** Replace `formatTreasuryPct(value)` in `src/lib/treasury-table-utils.ts:44-45` with `formatPercent(value, 1)`. If the "N/A" null return (vs "-") matters in context, pass an explicit null display option or accept the standardized "-".

#### Step 4c — R-009: Remove `formatRatioPct`

**What:** Replace `formatRatioPct(value)` in `src/lib/chain-ui.ts:4-8` with `formatSignedPercent(value * 100, 2)` from `shared/lib/format.ts`. The existing `formatRatioPct` prepends a `"+"` sign for positive values (used for 7d/30d change display on chains pages), so `formatSignedPercent` is the correct match — NOT `formatPercentFromRatio`, which produces unsigned output.

#### Step 4d — R-007: Inline `formatHealthAge`

**What:** In `src/components/data-health-banner.tsx:51`, replace `formatHealthAge(worstAge)` with `formatElapsedSeconds(worstAge / 1000)`. Remove `formatHealthAge` from `src/lib/data-health.ts:165-168`.

#### Step 4e — R-004: Remove duplicate format tests

**What:** Remove the 5 duplicate test blocks from `src/lib/__tests__/format.test.ts` that test functions already covered by `shared/lib/__tests__/format.test.ts`: `formatCompactCount`, `formatTrackingSpanDays`, `formatTrackingSpanSeconds`, `formatNativePrice`, `formatDeathDate`.

#### Step 4f — R-013: Remove unused export

**What:** Remove or unexport `isAmbiguousStablecoinSymbol` from `src/lib/stablecoin-url-codec.ts:45-48`. If the test file is the only consumer, update the test to access it via a different mechanism or remove those specific test cases.

#### Step 4g — R-012: Document timestamp formatting scope

**What:** Add a brief inline comment in `src/lib/status-dashboard-model.ts` at `formatTimestampSeconds`/`formatTimestampMs` noting these are intentionally status-dashboard-scoped formatters, not candidates for shared extraction.

---

### Stream 3: Shared Layer + Cross-Runtime

#### Step 1a — S-003: Consolidate `getConfiguredValue`

**What:** Create `shared/lib/env-utils.ts` exporting `getConfiguredValue` and `hasConfiguredValue`. Update both consumers to import from the shared module.

**Files:**
- `shared/lib/env-utils.ts` (NEW)
- `worker/src/lib/env.ts` — remove local `getConfiguredValue`/`hasConfiguredValue`, import from `@shared/lib/env-utils`
- `functions/lib/ops-env.ts` — remove local `getConfiguredValue`, import from `@shared/lib/env-utils`

**Canonical implementation** (use the worker version which is simpler; both are functionally equivalent):
```typescript
export function hasConfiguredValue(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function getConfiguredValue(value: string | undefined): string | null {
  return hasConfiguredValue(value) ? value.trim() : null;
}
```

#### Step 1b — R-001: Extract proxy helpers

**What:** Extract shared proxy utilities from the two Pages Function proxy handlers into `functions/lib/proxy-utils.ts`.

**Files:**
- `functions/lib/proxy-utils.ts` (NEW) — `jsonError`, `summarizeFetchError`, parameterized `buildUpstreamHeaders`, `buildProxyResponse`
- `functions/api/admin/[[path]].ts` — import from proxy-utils, remove local definitions
- `functions/_site-data/[[path]].ts` — import from proxy-utils, remove local definitions

**Design:**
```typescript
export function jsonError(status: number, message: string): Response { ... }
export function summarizeFetchError(err: unknown): string { ... }

export function buildUpstreamHeaders(
  request: Request,
  options: { forwardHeaders: string[]; extraHeaders?: Record<string, string> },
): Headers { ... }

export function buildProxyResponse(
  upstreamRes: Response,
  options?: { method?: string },
): Response { ... }
```

#### Step 1c — R-011: Document ID validation scope

**What:** Add JSDoc to `isKnownCoinId` in `shared/lib/validate-coin-id.ts` clarifying it checks tracked stablecoins only (excludes shadow stablecoins like PSI phantom assets). Mention `REGISTRY_BY_ID.has()` as the alternative for shadow-inclusive checks.

#### Step 2 — S-007: Split `api-endpoints.ts`

**What:** Split the 999-line `shared/lib/api-endpoints.ts` into focused sub-modules with a backward-compatible barrel re-export.

**New structure:**
```
shared/lib/api-endpoints/
├── index.ts              ← barrel re-export (all existing public API preserved)
├── definitions.ts        ← endpoint registry (EndpointDef[], ENDPOINTS array)
├── paths.ts              ← API_PATHS builder, path construction helpers
├── validation.ts         ← method validation, query param construction
└── status.ts             ← status-page action extraction, admin path matching
```

**Approach:**
1. Read `api-endpoints.ts` fully to identify the 4 logical sections
2. Create the sub-module files with the extracted code
3. Create `index.ts` that re-exports everything: `export * from "./definitions"; export * from "./paths"; ...`
4. Delete the original `api-endpoints.ts`
5. Verify that the barrel re-export at `api-endpoints/index.ts` makes existing `@shared/lib/api-endpoints` import paths resolve unchanged (TypeScript resolves `api-endpoints` → `api-endpoints/index.ts` automatically)

**Key constraint:** The barrel re-export preserves the existing import path. Consumer files do NOT need modification — this is an internal restructuring only. The ~30 consumer files listed above are the blast radius for reference, but they should compile without changes.

**Verification:** `npm run build` and `cd worker && npx tsc --noEmit` both pass. Zero consumer files need import path changes thanks to the barrel re-export.

---

### Stream 4: Build/CI/Docs/Infra

#### Step 1 — S-005: PR change detection

**What:** Add a `detect-changes` job to `.github/workflows/pull-request-checks.yml` that mirrors the deploy workflow's change classification. Pass `pages_changed` and `worker_changed` flags to `validate-ci.yml` so non-deploy-impacting PRs skip unnecessary build/typecheck steps.

**Files:** `.github/workflows/pull-request-checks.yml`

**Approach:**
1. Add a `detect-changes` job that runs `node scripts/classify-deploy-changes.mjs` (already exists)
2. Add `needs: detect-changes` to the validate job
3. Pass `pages_changed` and `worker_changed` as inputs to the reusable workflow

**Verification:** YAML is valid. Dry-run logic: a docs-only diff would produce `pages_changed=false, worker_changed=false`.

#### Step 2 — S-006: Auto-generate sitemap dates

**What:** Create `scripts/generate-sitemap-dates.ts` that uses `git log` to determine last-modified dates for each page route. Replace the hardcoded `LAST_EDITED` map in `src/app/sitemap.ts` with an import of the generated data.

**Files:**
- `scripts/generate-sitemap-dates.ts` (NEW) — generates `src/generated/sitemap-dates.json`
- `src/app/sitemap.ts` — import from generated file, remove hardcoded map
- `package.json` — update `prebuild` script to include `tsx scripts/generate-sitemap-dates.ts`

**Design:**
```typescript
// scripts/generate-sitemap-dates.ts
// For each page in src/app/*/page.tsx, run:
//   git log -1 --format=%aI -- src/app/<page>/page.tsx
// Output: { "/about/": "2026-03-10T...", ... }
// Write to src/generated/sitemap-dates.json
```

**Fallback:** If git history is unavailable (e.g., shallow clone in CI), fall back to the current date for all pages.

#### Step 3 — S-010: Cache blob size telemetry

**What:** Add cache key size tracking to the status endpoint so the D1 blob growth can be monitored.

**Files:**
- `worker/src/lib/status/d1-usage.ts` — add `getCacheBlobSizes(db)` function that queries `SELECT key, LENGTH(value) as bytes FROM cache`
- `worker/src/lib/db-cache.ts` — no changes needed (size is measured via query, not instrumented in writes)

**Output:** Status endpoint includes a new `cacheSizes` field: `{ stablecoins: 245000, fxRates: 1200, ... }` (bytes per key).

#### Step 4 — S-013: Improve hotspot ratchet error message

**What:** Update `scripts/check-hotspot-ratchet.mjs` to include a remediation suggestion in the error output.

**Current:**
```
Hotspot complexity regressions detected:
  src/foo.ts fileLines: current=500 baseline=400
```

**Improved:**
```
Hotspot complexity regressions detected:
  src/foo.ts fileLines: current=500 baseline=400

If these changes are intentional, update the baseline:
  npm run check:hotspot-ratchet:update-baseline
```

#### Step 5 — S-014: Local dev setup in README

**What:** Add a "Local Development Setup" section to `README.md` mapping three development scenarios to minimum required env vars.

**Scenarios:**
1. **Frontend-only** (`npm run dev`): `NEXT_PUBLIC_API_BASE_URL` (point to production or local worker)
2. **Worker-only** (`cd worker && npx wrangler dev`): D1 bindings, API keys for external sources
3. **Full-stack local**: Both sets

Reference `.env.example` and `worker/src/lib/env.ts` for the complete binding list.

#### Step 6 — S-008: Methodology doc-sync improvements

**What:** Evaluate feasibility of generating methodology doc sections from code. If feasible within the agent's time budget, implement as a prebuild codegen step. If not feasible in one pass, improve the existing `check:doc-sync` error messages to include the expected values and suggest exact fixes.

**Minimum deliverable:** Error messages from `methodology-manifest.ts` include the expected value alongside the actual value, so fixing a drift is a copy-paste rather than a treasure hunt.

**Stretch deliverable:** A `scripts/generate-methodology-docs.ts` that outputs the methodology-version and weight tables as markdown fragments importable by the docs pages.

#### Step 7 — S-012: PostCSS documentation

**What:** Add a one-line mention of the PostCSS + Tailwind v4 pipeline to architecture docs.

#### Step 8 — Q-008: Document `!= null` convention

**What:** Add a brief note to `docs/` (e.g., in a coding conventions section) explaining the deliberate `!= null` loose-equality pattern used throughout the worker codebase for D1 null/undefined guarding.

---

### Stream 5 (Wave 2): Barrel Export Migration + Validation

#### Step 1 — Build type→submodule mapping

**What:** Read all 16 sub-modules under `shared/types/` (excluding `index.ts`) to build a map: `{ TypeName → submodule }`. For example, `StablecoinListResponse → "market"`, `ReportCard → "report-cards"`.

#### Step 2 — Rewrite barrel imports

**What:** Grep for all `from "@shared/types"` occurrences (estimated ~250 files). For each, determine which types are imported and rewrite to the specific submodule. Process in directory batches if count exceeds 150: `src/lib/` → `src/components/` → `src/hooks/` → `src/app/` → `worker/` → `shared/` → `functions/`.

**Pattern:**
```typescript
// Before
import type { StablecoinListResponse, HealthResponse } from "@shared/types";
// After
import type { StablecoinListResponse } from "@shared/types/market";
import type { HealthResponse } from "@shared/types/status";
```

If a single import pulls types from multiple submodules, split into separate import statements.

#### Step 3 — Deprecate barrel

**What:** Add a comment to `shared/types/index.ts`:
```typescript
/**
 * @deprecated Import from specific submodules instead:
 *   import type { Foo } from "@shared/types/core";
 * This barrel re-export is preserved for backward compatibility
 * but should not be used in new code.
 */
```

#### Step 4-6 — Full validation

Run the complete validation suite:
```bash
npm run lint
npm run build
npm test
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

All must pass with zero errors. Any failure is investigated and fixed before declaring the remediation complete.

---

## 4. Excluded Findings

| ID | Reason for Exclusion |
|----|----------------------|
| R-010 | Deferred — intentional future-proofing for ticker-issuer URL migration |
| R-014 | N/A — `formatChartPercent` has an active consumer, keep |
| R-015 | N/A — no redundant dependencies found |
| Q-004 | Informational — enrich-prices-passes.ts structure is sound |
| Q-005 | No immediate change — `safeJsonParse` is documented appropriately |
| Q-006 | Monitor — fetch-primary.ts approaching threshold but acceptable |
| Q-010 | Informational — stablecoin-table.tsx logic/view split already exists |
| Q-011 | Positive finding — `dangerouslySetInnerHTML` properly sanitized |
| Q-012 | Positive finding — secret management properly configured |
| Q-013 | Positive finding — SQL injection systematically prevented |
| S-001 | Phase 4 strategic — trigger when build time > 3 min or coins > 300 |
| S-016 | N/A — `html-to-image` appropriate and lightweight |
| S-017 | N/A — Node.js version consistency is good practice |

---

## 5. Acceptance Criteria (Global)

The remediation is complete when ALL of the following hold:

**Automated gates:**
1. `npm run test:merge-gate` passes
2. `npm run build` produces zero warnings
3. `cd worker && npx tsc --noEmit` passes
4. `npm test` passes with zero failures
5. `npm run lint` passes

**Per-stream verification:**
6. All per-stream verification checks pass (listed in each stream section)
7. No file is modified by more than one Wave 1 stream (verified via diff inspection per branch)

**Completeness audit:**
8. All 32 actionable findings have a corresponding code change with a verifiable before/after
9. Documentation-only findings (Q-008, S-012, S-014, R-012) are verified by reading the target files to confirm the additions exist — these cannot be caught by automated gates alone
10. The validation agent produces a checklist mapping each finding ID to the specific commit/diff that addresses it
