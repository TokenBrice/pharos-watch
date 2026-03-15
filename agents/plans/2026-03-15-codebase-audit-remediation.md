# Codebase Audit Remediation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate all 47 actionable findings from the 2026-03-15 codebase audit across redundancy, code quality, and sustainability pillars.

**Architecture:** Changes are organized into 18 tasks grouped by dependency and blast radius. Tasks 1-8 are independent quick wins and targeted refactoring; Tasks 9-13 are structural improvements with some sequencing; Tasks 14-18 are strategic overhauls that touch foundational patterns.

**Tech Stack:** TypeScript, Next.js 16, Cloudflare Workers, D1, Vitest, Zod, TanStack Query

**Source audit:** `agents/audits/codebase-audit-2026-03-15.md`

---

## Chunk 1: Quick Wins (Tasks 1-3)

### Task 1: Dead Code & Trivial Cleanups

**Findings:** R-005, R-014, R-010, S-005, Q-019

**Files:**
- Modify: `shared/lib/redemption-backstop-version.ts`
- Modify: `shared/lib/mint-burn-signals.ts`
- Delete: `worker/src/lib/cron-schedule.ts`
- Modify: `worker/src/api/status.ts` (import path)
- Modify: `worker/src/handlers/scheduled.ts` (import path)
- Modify: `worker/src/api/__tests__/status.test.ts` (import path)
- Modify: `.env.example`
- Modify: `worker/src/lib/api-utils.ts`

> **Note:** Q-012 (double assertion in enrich-prices.ts:678) was flagged in the audit but cannot be reproduced in the current codebase — the pattern does not exist at that location. Marked as already-resolved.

- [ ] **Step 1: Remove unused `REDEMPTION_BACKSTOP_CHANGELOG` export**

In `shared/lib/redemption-backstop-version.ts`, the `REDEMPTION_BACKSTOP_CHANGELOG` is exported but never imported. Check that it's truly unused:

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard && grep -r "REDEMPTION_BACKSTOP_CHANGELOG" --include="*.ts" --include="*.tsx" -l
```

Expected: only `shared/lib/redemption-backstop-version.ts` itself. Then remove the standalone export (keep the property on the version object if used via `REDEMPTION_BACKSTOP_VERSION.changelog`).

- [ ] **Step 2: Remove unused `COIN_FLOW_COMPOSITE_STATE_VALUES` export**

In `shared/lib/mint-burn-signals.ts:21`, remove the `export` keyword from `COIN_FLOW_COMPOSITE_STATE_VALUES`. The array is only consumed within the same file for type derivation.

```bash
grep -r "COIN_FLOW_COMPOSITE_STATE_VALUES" --include="*.ts" --include="*.tsx" -l
```

Expected: only `shared/lib/mint-burn-signals.ts`.

- [ ] **Step 3: Delete `cron-schedule.ts` re-export barrel**

`worker/src/lib/cron-schedule.ts` is a 2-line re-export file. Update its 3 consumers to import directly from `@shared/lib/cron-jobs`:

1. `worker/src/api/status.ts` — change import from `../lib/cron-schedule` to `@shared/lib/cron-jobs`
2. `worker/src/handlers/scheduled.ts` — same
3. `worker/src/api/__tests__/status.test.ts` — same

Then delete `worker/src/lib/cron-schedule.ts`.

- [ ] **Step 4: Add `OPENEXCHANGERATES_API_KEY` to `.env.example`**

Add the missing env var to `.env.example` in the appropriate section near other API keys.

- [ ] **Step 5: Rename `safeParse` to `safeJsonParse` (Q-019)**

In `worker/src/lib/api-utils.ts`, rename the `safeParse` function to `safeJsonParse` to avoid collision with Zod's `safeParse` convention.

**Important disambiguation:** Only rename the `safeParse` function exported from `worker/src/lib/api-utils.ts` and its import sites. Do NOT rename Zod's `.safeParse()` method calls, which appear in the same files. The known import sites are: `worker/src/api/stability-index.ts`, `worker/src/api/stress-signals.ts`, `worker/src/api/dex-liquidity.ts`, `worker/src/api/digest-snapshot.ts`.

Verify via:
```bash
grep -rn "from.*api-utils.*safeParse\|import.*safeParse.*api-utils" worker/src/ --include="*.ts"
```

Update each import site to use `safeJsonParse`.

- [ ] **Step 6: Run tests and type-check**

```bash
npm test && cd worker && npx tsc --noEmit
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "chore: dead code cleanup and naming fixes (R-005, R-014, R-010, Q-019, S-005, Q-012-verified-resolved)"
```

---

### Task 2: Formatting & Color Map Consolidation

**Findings:** R-001, R-002, R-003, R-007, R-011, R-015

**Files:**
- Modify: `worker/src/lib/api-utils.ts` (export `buildFreshnessMeta`)
- Modify: `worker/src/api/cache-handlers.ts` (import instead of duplicate)
- Modify: `worker/src/lib/og-templates/stablecoin-card.tsx`
- Modify: `worker/src/lib/og-templates/stability-index-card.tsx`
- Modify: `worker/src/lib/og-templates/depeg-card.tsx`
- Modify: `worker/src/api/feedback.ts`
- Modify: `src/components/status/format.ts`

- [ ] **Step 1: Export `buildFreshnessMeta` from `api-utils.ts` (R-001)**

In `worker/src/lib/api-utils.ts`, add `export` to the existing `buildFreshnessMeta` function (currently internal). In `worker/src/api/cache-handlers.ts`, replace the local duplicate with an import:

```typescript
import { buildFreshnessMeta } from "../lib/api-utils";
```

Remove the local `buildFreshnessMeta` function from `cache-handlers.ts`.

- [ ] **Step 2: Replace OG template hardcoded color maps with shared imports (R-003)**

> **Note:** `formatCurrency` is already exported from `shared/lib/format.ts` and calls `abbreviateNumber` internally. No need to export `abbreviateNumber` directly — all consumers should use `formatCurrency`.

In `worker/src/lib/og-templates/stablecoin-card.tsx`:
- Remove local `GRADE_COLORS` (lines 23-36), import `GRADE_RADAR_COLORS` from `@shared/lib/report-cards`
- Remove local `DEWS_BAND_COLORS` (lines 39-45), import `THREAT_BAND_HEX` from `@shared/lib/classification`
- Remove local `PSI_BAND_COLORS` (lines 48-55), import `PSI_HEX_COLORS` from `@shared/lib/psi-colors`

Verify the key names match (e.g., `GRADE_RADAR_COLORS["A+"]` vs `GRADE_COLORS["A+"]`). Adapt lookup keys if needed.

In `worker/src/lib/og-templates/stability-index-card.tsx`:
- Remove local `BAND_COLORS` (lines 13-20), import `PSI_HEX_COLORS` from `@shared/lib/psi-colors`

In `worker/src/lib/og-templates/depeg-card.tsx`:
- Remove local `DANGER_HEX`/`ALERT_HEX`/`WARNING_HEX`/`NORMAL_HEX` (lines 19-22), import `THREAT_BAND_HEX` from `@shared/lib/classification` and derive constants.

- [ ] **Step 3: Replace inline USD formatting with shared `formatCurrency` (R-002, R-015)**

In `worker/src/lib/og-templates/stablecoin-card.tsx`:
- Remove local `formatUsd` function (lines 57-64), import `formatCurrency` from `@shared/lib/format`

In `worker/src/api/feedback.ts`:
- Replace inline ternary chain (lines 86-91) with `formatCurrency(totalUSD)`

- [ ] **Step 4: Rename status `formatDuration` to `formatLatency` (R-007)**

In `src/components/status/format.ts`, rename `formatDuration` to `formatLatency`. Update all consumers within `src/components/status/` that import this function.

```bash
grep -r "formatDuration" src/components/status/ --include="*.ts" --include="*.tsx" -l
```

- [ ] **Step 5: Replace key inline `.toFixed()` in user-facing outputs (R-011, R-015)**

Replace inline USD formatting with `formatCurrency` from `@shared/lib/format` in user-facing outputs. Target files:
1. `worker/src/lib/telegram-alerts.ts` — Telegram alert messages (primary target, ~5 instances)
2. `worker/src/cron/dex-liquidity/fetch-fallbacks.ts` — `.toLocaleString()` formatting per R-015

Focus on user-facing strings only. Leave log-only `.toFixed()` calls as-is.

- [ ] **Step 6: Run tests and type-check**

```bash
npm test && cd worker && npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "refactor: consolidate formatting and color maps (R-001, R-002, R-003, R-007, R-011, R-015)"
```

---

### Task 3: Error Handling Hardening

**Findings:** Q-010, Q-018, Q-020, Q-016, Q-005

**Files:**
- Modify: `worker/src/lib/alerts.ts`
- Modify: `worker/src/cron/daily-digest.ts`
- Modify: `worker/src/cron/sync-stablecoins.ts`
- Modify: `worker/src/cron/dex-liquidity/orchestrator.ts`
- Modify: `worker/src/cron/enrich-prices.ts`

- [ ] **Step 1: Add timeout to `sendAlert()` fetch (Q-010)**

In `worker/src/lib/alerts.ts`, add `signal: AbortSignal.timeout(5000)` to the `fetch()` call inside `sendAlert()` (around line 38-42). This bounds alert delivery to 5 seconds so hanging webhooks don't block cron execution.

- [ ] **Step 2: Add try/catch for `JSON.parse(components)` in daily-digest (Q-018)**

In `worker/src/cron/daily-digest.ts` around line 441, wrap `JSON.parse(currentPsiSource.components)` in a try/catch. On parse failure, set the stability index data to null and add a note to degraded reasons:

```typescript
let psiComponents: Record<string, unknown> | null = null;
try {
  psiComponents = JSON.parse(currentPsiSource.components);
} catch {
  console.warn("[digest] failed to parse PSI components JSON");
}
```

- [ ] **Step 3: Add distinct warning for undefined `peggedAssets` (Q-020)**

In `worker/src/cron/sync-stablecoins.ts` around line 435, before the existing `if (!llamaData.peggedAssets || ...)` check, add a distinct warning when `peggedAssets` is `undefined` (API contract change) vs an empty array (legitimate empty response):

```typescript
if (llamaData.peggedAssets === undefined) {
  console.warn("[sync] DefiLlama response missing peggedAssets field — possible API contract change");
}
```

- [ ] **Step 4: Fix silent coverage guard degradation (Q-016)**

In `worker/src/cron/dex-liquidity/orchestrator.ts` (lines 169-196), modify the `.catch()` handlers to log warnings and use conservative fallback values:

For the `previousCoverageRow` catch: log a warning and set `previousCoverage` to a high safe value (e.g., the `MIN_VALID_ASSET_COUNT` constant) instead of 0, so the coverage guard remains protective.

For the other three catches: add `console.warn()` calls so failures are observable in cron metadata.

- [ ] **Step 5: Add per-pass try/catch in `enrichMissingPrices` (Q-005)**

In `worker/src/cron/enrich-prices.ts`, the outer try/catch (lines 573-851) wraps all passes. Restructure so Pass 1 (DL, lines 574-600) has its own try/catch. Pass 1b (lines 602-645) already has partial handling. Passes 2 (CMC, 647-739) and 3 (DexScreener, 741-830) already have inner try/catches.

The key change: wrap Pass 1 / Pass 1b in their own try/catch so a DL failure doesn't prevent CMC and DexScreener from running. Add a `failedPasses: string[]` array to the return stats:

```typescript
const failedPasses: string[] = [];

// Pass 1: DefiLlama
try {
  // existing Pass 1 logic
} catch (e) {
  console.warn("[enrich] Pass 1 (DL) failed:", e);
  failedPasses.push("DL");
}

// Pass 2: CMC (already has inner try/catch, wrap outer for safety)
// Pass 3: DexScreener (already has inner try/catch)
```

Return `failedPasses` in the stats object for cron metadata visibility.

- [ ] **Step 6: Run tests and type-check**

```bash
npm test && cd worker && npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "fix: harden error handling across worker pipelines (Q-005, Q-010, Q-016, Q-018, Q-020)"
```

---

## Chunk 2: Targeted Refactoring (Tasks 4-8)

### Task 4: Table Sort Consolidation

**Findings:** R-004

**Files:**
- Modify: `src/lib/table-comparator.ts`
- Modify: `src/components/stablecoin-table-logic.ts`
- Modify: `src/components/flow-table-logic.ts`

- [ ] **Step 1: Extend `createTableComparator` for nullable values**

In `src/lib/table-comparator.ts`, the current implementation handles `number | string` extractors. Extend to support nullable extractors by adding an optional `nullPosition` parameter ("first" | "last", default "last"):

```typescript
export function createTableComparator<K extends string, Row>(
  extractors: Record<K, (row: Row) => number | string | null | undefined>,
  options?: { nullPosition?: "first" | "last" }
): (a: Row, b: Row, sort: { key: K; direction: "asc" | "desc" }) => number
```

Null/undefined values sort to the end (or beginning) regardless of direction. Non-null values compare normally.

- [ ] **Step 2: Write tests for the extended `createTableComparator`**

Create `src/lib/__tests__/table-comparator.test.ts` (or add to existing test file). Test cases:
- Basic numeric sort (ascending/descending)
- String sort
- Null values sort to end by default
- Null values sort to beginning with `nullPosition: "first"`
- Mixed null and non-null values

- [ ] **Step 3: Run test to verify**

```bash
npx vitest run src/lib/__tests__/table-comparator.test.ts
```

- [ ] **Step 4: Refactor `sortStablecoins` to use `createTableComparator`**

In `src/components/stablecoin-table-logic.ts`, replace the 89-line switch statement (lines 103-176) with a `createTableComparator` call. Define extractors for each sort key:

```typescript
const stablecoinExtractors: Record<StablecoinTableSortKey, (row: StablecoinRow) => number | string | null> = {
  name: (r) => r.name.toLowerCase(),
  supply: (r) => getCirculatingRaw(r),
  price: (r) => r.price ?? 0,
  change1d: (r) => r.change_1d ?? 0,
  change7d: (r) => r.change_7d ?? 0,
  change30d: (r) => r.change_30d ?? 0,
  stability: (r) => r.stabilityIndex?.score ?? null,
  liquidity: (r) => r.liquidityScore ?? null,
  grade: (r) => r.safetyGradeNumeric ?? null,
  peg: (r) => r.pegScore ?? null,
};
```

Replace the function body with the comparator call. Handle any special cases (like the `compareNullable` fallback pattern) through the new null support.

- [ ] **Step 5: Refactor `compareFlowRows` to use `createTableComparator`**

Same pattern for `src/components/flow-table-logic.ts`. Define extractors for `FlowTableSortKey` and replace the switch statement.

- [ ] **Step 6: Run full test suite**

```bash
npm test
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "refactor: consolidate table sorting onto createTableComparator (R-004)"
```

---

### Task 5: SQL Query Hygiene

**Findings:** S-007

**Files:**
- Modify: `worker/src/api/peg-summary.ts`
- Modify: `worker/src/api/audit-depeg-history.ts`
- Modify: `worker/src/api/status.ts`
- Modify: `worker/src/api/discovery.ts`
- Modify: `worker/src/cron/detect-depegs.ts`
- Modify: `worker/src/cron/confirm-pending-depegs.ts`
- Modify: `worker/src/cron/sync-yield-data.ts`
- Modify: `worker/src/api/telegram-webhook.ts`

- [ ] **Step 1: Replace `SELECT *` with explicit columns in each file**

For each file, replace `SELECT *` with the exact columns that the typed result or downstream code actually uses. Reference the type annotations and row access patterns:

1. **`peg-summary.ts:89`** — already has typed columns in the generic: `stablecoin_id, dex_price_usd, deviation_from_primary_bps, source_pool_count, source_total_tvl, updated_at`
2. **`audit-depeg-history.ts:84`** — uses `DepegRow` type, check its fields in `depeg-helpers.ts`
3. **`status.ts:747`** — check which fields are accessed in lines 749-761
4. **`discovery.ts:45`** — check which fields are accessed in lines 52-64
5. **`detect-depegs.ts:87`** — uses `DepegRow` type
6. **`confirm-pending-depegs.ts:60`** — uses `PendingRow` type
7. **`sync-yield-data.ts:844`** — check downstream field access
8. **`telegram-webhook.ts:99`** — uses `PendingDisambiguationRow` type

For each, read the row type definition and list exactly the needed columns.

- [ ] **Step 2: Run tests to verify no regressions**

```bash
npm test
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "refactor: replace SELECT * with explicit column lists (S-007)"
```

---

### Task 6: Zod Validation at System Boundaries

**Findings:** Q-003, Q-008

**Files:**
- Modify: `worker/src/api/yield-history.ts`
- Modify: `worker/src/api/dex-liquidity.ts`
- Modify: `worker/src/cron/daily-digest.ts`
- Modify: `worker/src/cron/enrich-prices.ts`
- Create: `worker/src/lib/schemas.ts` (shared Zod schemas for external API responses)

- [ ] **Step 1: Create shared schema file for external API response shapes**

Create `worker/src/lib/schemas.ts` with Zod schemas for the most critical external API responses:

```typescript
import { z } from "zod";

/** DefiLlama /coins/{tokens} price response */
export const DLPriceResponseSchema = z.object({
  coins: z.record(z.string(), z.object({
    price: z.number(),
    timestamp: z.number().optional(),
    confidence: z.number().optional(),
  })).optional().default({}),
});

/** Cron metadata JSON stored in cron_runs.metadata */
export const CronMetadataSchema = z.record(z.string(), z.unknown());
```

- [ ] **Step 2: Add Zod validation to highest-priority JSON parse sites**

Replace `JSON.parse(...) as T` with `schema.parse()` or `schema.safeParse()` at system boundaries:

1. **`worker/src/api/yield-history.ts:86`** — `JSON.parse(row.warning_signals) as string[]` → use `z.array(z.string()).catch([]).parse(JSON.parse(row.warning_signals))`
2. **`worker/src/api/dex-liquidity.ts:140`** — `JSON.parse(latestCron.metadata) as {...}` → use a `DexLiquidityCronMetadataSchema.safeParse()`
3. **`worker/src/cron/daily-digest.ts:554`** — LLM response JSON parsing (already has raw-text fallback, just add structural validation)
4. **`worker/src/cron/enrich-prices.ts:513`** — `(json as { coins?: ... }).coins` → use `DLPriceResponseSchema.parse(json).coins`

- [ ] **Step 3: Add structural checks for external API responses (Q-008)**

In `worker/src/cron/enrich-prices.ts`, for each external API call site that casts the response:
- Add a structural check before access: `if (json && typeof json === 'object' && 'coins' in json)`
- Or use the Zod schema from Step 1

- [ ] **Step 4: Run tests**

```bash
npm test && cd worker && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add Zod validation at JSON parse system boundaries (Q-003, Q-008)"
```

---

### Task 7: Frontend Interval & Hook Consolidation

**Findings:** S-004, R-009

**Files:**
- Modify: `src/lib/cron-intervals.ts`
- Modify: `src/hooks/api-hooks.ts`
- Modify: `src/hooks/use-stablecoins.ts`
- Modify: `src/hooks/use-blacklist-events.ts`
- Modify: `src/hooks/use-depeg-events.ts`
- Modify: `src/hooks/use-mint-burn-flows.ts`

- [ ] **Step 1: Derive frontend polling from shared cron intervals (S-004)**

In `src/lib/cron-intervals.ts`, replace hardcoded millisecond constants with derivations from `@shared/lib/cron-jobs`:

```typescript
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";

// Derived from shared cron job definitions (seconds -> ms)
// Only export constants that have existing consumers — do not add unused exports
export const CRON_1MIN = 60_000;
export const CRON_15MIN = CRON_INTERVALS["sync-stablecoins"] * 1000;
export const CRON_20MIN = CRON_INTERVALS["sync-dex-discovery"] * 1000;
export const CRON_30MIN = CRON_INTERVALS["sync-dex-liquidity"] * 1000;
export const CRON_1H = CRON_INTERVALS["sync-live-reserves"] * 1000;
export const CRON_24H = CRON_INTERVALS["sync-bluechip"] * 1000;
```

Verify imports still work for all consumers. Check that every exported constant has at least one import site; if `CRON_1MIN` has no consumers, remove it too.

- [ ] **Step 2: Consolidate scattered API hooks into `api-hooks.ts` (R-009)**

Move the data-fetching hooks from `use-stablecoins.ts`, `use-blacklist-events.ts`, `use-depeg-events.ts`, and `use-mint-burn-flows.ts` into `api-hooks.ts` if they follow the same `useApiQuery` pattern. Update all consumer imports.

If any hooks have genuinely distinct patterns (e.g., `useSupplyHistory` returns a custom shape, `useMintBurnFlows` has complex query logic), keep those in their own files but document the rationale at the top of each file.

- [ ] **Step 3: Run tests and build**

```bash
npm test && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor: derive frontend intervals from shared cron defs, consolidate API hooks (S-004, R-009)"
```

---

### Task 8: Route Registry & CI Improvements

**Findings:** S-015, S-006, S-009, S-018

**Files:**
- Modify: `worker/src/route-registry.ts`
- Create: `.github/dependabot.yml`
- Modify: `.github/workflows/validate-ci.yml`
- Modify: `package.json` (add `simple-git-hooks` or `lefthook`)

- [ ] **Step 1: Add reverse route-registry validation (S-015)**

In `worker/src/route-registry.ts`, after the existing validation loop (lines 266-270), add a symmetric check for endpoints without handlers:

```typescript
// Verify all non-dynamic endpoints have handlers
for (const ep of ENDPOINT_DEFINITIONS) {
  if (!ep.path.includes(":") && !ep.path.includes("*")) {
    const key = ep.key as keyof typeof STATIC_ROUTE_HANDLERS_BY_KEY;
    if (!(key in STATIC_ROUTE_HANDLERS_BY_KEY)) {
      throw new Error(`Endpoint "${ep.key}" is defined but has no handler in STATIC_ROUTE_HANDLERS_BY_KEY`);
    }
  }
}
```

- [ ] **Step 2: Add Dependabot configuration (S-006)**

Create `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 5
    labels:
      - "dependencies"
    groups:
      minor-and-patch:
        update-types:
          - "minor"
          - "patch"
  - package-ecosystem: "npm"
    directory: "/worker"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 3
    labels:
      - "dependencies"
      - "worker"
```

- [ ] **Step 3: Add CodeQL to CI (S-009)**

Create `.github/workflows/codeql.yml`:

```yaml
name: CodeQL
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: "0 6 * * 1"

jobs:
  analyze:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
    steps:
      - uses: actions/checkout@v4
      - uses: github/codeql-action/init@v3
        with:
          languages: javascript-typescript
      - uses: github/codeql-action/analyze@v3
```

- [ ] **Step 4: Add auto-install git hooks (S-018)**

Add `simple-git-hooks` to devDependencies and configure in `package.json`:

```bash
npm install -D simple-git-hooks
```

Add to `package.json`:
```json
{
  "simple-git-hooks": {
    "pre-push": "npm run test:merge-gate"
  }
}
```

Add `"prepare": "npx simple-git-hooks"` to the `scripts` section.

- [ ] **Step 5: Run tests**

```bash
npm test
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: add route validation, Dependabot, CodeQL, auto-hooks (S-006, S-009, S-015, S-018)"
```

---

## Chunk 3: Structural Improvements (Tasks 9-13)

### Task 9: Depeg Detection Refactoring

**Findings:** Q-006

**Files:**
- Modify: `worker/src/cron/detect-depegs.ts`
- Create: `worker/src/cron/__tests__/detect-depegs-helpers.test.ts` (if not exists)

- [ ] **Step 1: Extract `isDexConfirmed` helper**

The pattern `dexAbsBps != null && dexRow != null && isTrustedDexPriceRow(dexRow, now, "depeg")` is repeated 4 times. Extract into a helper:

```typescript
function isDexConfirmed(
  dexRow: DexPriceRow | undefined,
  dexAbsBps: number | null,
  now: number,
): boolean {
  return dexAbsBps != null && dexRow != null && isTrustedDexPriceRow(dexRow, now, "depeg");
}
```

- [ ] **Step 2: Extract detection scenario handlers**

Break the inner loop (lines 141-291) into named helpers:
- `handleExistingEvent(...)` — lines 179-237 (existing event, same or changed direction)
- `handleNewDepeg(...)` — lines 239-267 (no existing event, deviation exceeds threshold)
- `handleRecovery(...)` — lines 268-289 (existing event, price recovered)

Each helper returns a `D1PreparedStatement[]` to be batched.

- [ ] **Step 3: Simplify main loop to dispatch to helpers**

The main loop becomes:

```typescript
for (const asset of assets) {
  // setup: threshold, DEX check...
  const confirmed = isDexConfirmed(dexRow, dexAbsBps, now);

  if (existingEvent) {
    if (recovered) {
      stmts.push(...handleRecovery(asset, existingEvent, confirmed, ...));
    } else {
      stmts.push(...handleExistingEvent(asset, existingEvent, deviation, confirmed, ...));
    }
  } else if (Math.abs(deviationBps) >= threshold) {
    stmts.push(...handleNewDepeg(asset, deviationBps, confirmed, ...));
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run worker/src/cron/__tests__/detect-depegs.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor: extract depeg detection helpers to reduce cyclomatic complexity (Q-006)"
```

---

### Task 10: Blacklist File Decomposition

**Findings:** Q-007

**Files:**
- Create: `worker/src/cron/blacklist/balance-providers.ts`
- Modify: `worker/src/cron/sync-blacklist.ts`

- [ ] **Step 1: Extract balance-fetching logic into `balance-providers.ts`**

Move the following functions from `sync-blacklist.ts` (lines 101-291) into a new `worker/src/cron/blacklist/balance-providers.ts`:
- `fetchEvmBalanceAtTag()` (lines 103-143)
- `fetchBalanceViaDrpc()` (lines 157-193)
- `fetchBalanceViaChainRpc()` (lines 195-235)
- `fetchEvmTokenBalance()` (lines 237-291) — the main dispatcher

Export `fetchEvmTokenBalance` as the public API. Keep the internal helpers as module-private.

- [ ] **Step 2: Update imports in `sync-blacklist.ts`**

Import `fetchEvmTokenBalance` from the new module. Remove the moved functions.

- [ ] **Step 3: Run tests**

```bash
npx vitest run worker/src/api/__tests__/blacklist.test.ts
npm test
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor: extract balance providers from sync-blacklist (Q-007)"
```

---

### Task 11: Worker State Architecture

**Findings:** Q-004, S-001, Q-014

**Files:**
- Modify: `worker/src/lib/coingecko.ts`
- Modify: `worker/src/lib/coingecko-onchain.ts`
- Modify: `worker/src/lib/alerts.ts`
- Modify: `worker/src/lib/chain-registry.ts`
- Modify: `worker/src/handlers/http.ts`
- Modify: `worker/src/handlers/scheduled.ts`

- [ ] **Step 1: Refactor `coingecko.ts` to accept key as parameter**

Replace module-level `let apiKey` with functions that accept the key directly:

```typescript
// Before: let apiKey: string | null = null;
// Before: export function initCoinGecko(key?: string) { apiKey = key ?? null; }

// After: pass key through directly
export function cgUrl(path: string, apiKey: string | null): string {
  const base = apiKey ? CG_PRO_BASE : CG_FREE_BASE;
  return `${base}${path}`;
}

export function cgHeaders(apiKey: string | null, extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { accept: "application/json", ...extra };
  if (apiKey) h["x-cg-pro-api-key"] = apiKey;
  return h;
}
```

Update all callers to pass `apiKey` from the env/context.

- [ ] **Step 2: Refactor `coingecko-onchain.ts` similarly**

Replace `let onchainAvailable` with a parameter-based approach. Functions that check onchain availability should receive the flag or API key.

- [ ] **Step 3: Refactor `alerts.ts` to accept webhook URL as parameter**

Replace `let webhookUrl` with `sendAlert(url, message, options)`.

- [ ] **Step 4: Refactor `chain-registry.ts` to return a Map (Q-014)**

Change `buildChainRpcs()` to return `Map<string, ChainRpcConfig>` instead of an array. Replace `getChainRpc(chainId)` with direct map lookup. This also fixes Q-014 (O(n) lookup in hot loops).

Remove the `initChainRpcs` function and module-level state.

- [ ] **Step 5: Update `handleHttpRequest` and `handleScheduledEvent`**

Remove `initCoinGecko()`, `initAlerts()`, `initChainRpcs()` calls. Instead, pass configuration through the handler context or directly to utility functions.

- [ ] **Step 6: Run tests and smoke-test worker startup**

```bash
npm test && cd worker && npx tsc --noEmit
```

Also verify the worker starts successfully with:
```bash
cd worker && npx wrangler dev --test-scheduled 2>&1 | head -20
```

Confirm it binds to localhost without initialization errors. This catches issues that type-checking alone won't find (e.g., missing init calls at runtime).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "refactor: replace module-level mutable state with parameter passing (Q-004, S-001, Q-014)"
```

---

### Task 12: Pipeline Decomposition

**Findings:** Q-002, Q-009, Q-011, CC-001

**Files:**
- Create: `worker/src/cron/sync-stablecoins/post-enrichment.ts`
- Modify: `worker/src/cron/sync-stablecoins/stages.ts`
- Modify: `worker/src/cron/sync-stablecoins.ts`

- [ ] **Step 1: Identify shared pipeline stages**

Both `syncStablecoins` (lines 393-933) and `fallbackToCgSupply` (lines 110-391) share these stages:
1. Price validation loop
2. Apply cached fallback prices
3. Zod schema validation + cache write
4. Depeg detection + pending confirmation

- [ ] **Step 2: Extract `postEnrichmentPipeline()` into `post-enrichment.ts`**

Create `worker/src/cron/sync-stablecoins/post-enrichment.ts`:

```typescript
export interface PostEnrichmentInput {
  assets: PeggedAsset[];
  db: D1Database;
  previousCache: CachePayload | null;
  signal: AbortSignal;
  label: string; // "main" | "cg-fallback" for logging
}

export interface PostEnrichmentResult {
  cachedCount: number;
  depegResults: DepegResult[];
  validationPassed: boolean;
}

export async function postEnrichmentPipeline(input: PostEnrichmentInput): Promise<PostEnrichmentResult> {
  // 1. Price validation
  // 2. Apply cached fallbacks
  // 3. Zod validation + cache write
  // 4. Depeg detection
}
```

- [ ] **Step 3: Rename `fallbackToCgSupply` to `syncViaCoingeckoFallback` (Q-009)**

Rename the function and update the caller in `syncStablecoins`.

- [ ] **Step 4: Refactor both functions to use `postEnrichmentPipeline`**

Replace the duplicated post-enrichment logic in both `syncStablecoins` and `syncViaCoingeckoFallback` with calls to `postEnrichmentPipeline()`.

- [ ] **Step 5: Extract remaining inline stages from `syncStablecoins`**

Move additional self-contained stages to `stages.ts`:
- `remapLlamaIds()` — ID remapping logic
- `mergeSupplementalAssets()` — supplemental asset merging
- `assembleSyncMetadata()` — metadata construction (lines 827-932)

- [ ] **Step 6: Run tests**

```bash
npx vitest run worker/src/cron/__tests__/sync-stablecoins.test.ts
npm test
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "refactor: decompose sync pipeline, extract shared post-enrichment stage (Q-002, Q-009, Q-011, CC-001)"
```

---

### Task 13: RouteContext Refactoring

**Findings:** S-003

**Files:**
- Modify: `worker/src/route-registry.ts`
- Modify: `worker/src/handlers/http.ts`
- Modify: `worker/src/api/telegram-webhook.ts`
- Modify: `worker/src/api/feedback.ts`
- Modify: `worker/src/cron/daily-digest.ts`

- [ ] **Step 1: Split `RouteContext` into core + domain bags**

In `worker/src/route-registry.ts`, replace the monolithic `RouteContext` interface:

```typescript
/** Core context available to all handlers */
export interface RouteContext {
  url: URL;
  db: D1Database;
  execCtx: ExecutionContext;
  request: Request;  // make non-optional
  trustedAdmin: boolean;  // make non-optional
}

/** Extended context for handlers that need external service credentials */
export interface TelegramContext {
  telegramCreds: TelegramCreds;
  telegramWebhookSecret: string;
  telegramBotToken: string;
}

export interface DigestContext {
  anthropicApiKey: string;
  twitterCreds: TwitterCreds | null;
  telegramCreds: TelegramCreds | null;
}

export interface FeedbackContext {
  feedbackEnv: FeedbackEnv;
}

export interface MintBurnContext {
  alchemyApiKey: string | null;
  mintBurnFreshnessConfig: MintBurnFreshnessConfig;
}
```

- [ ] **Step 2: Update handler signatures**

Update handlers that need domain-specific context to accept `RouteContext & TelegramContext` or similar intersections. Handlers that only need core context keep `RouteContext`.

- [ ] **Step 3: Update `handleHttpRequest` to build context per-route**

Instead of building all fields for every request, build the core context always and add domain-specific fields only for routes that need them.

- [ ] **Step 4: Run tests**

```bash
npm test && cd worker && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor: split RouteContext into core + domain-specific bags (S-003)"
```

---

## Chunk 4: Strategic Overhauls (Tasks 14-18)

### Task 14: Admin Auth JWT Verification

**Findings:** Q-001

**Files:**
- Modify: `worker/src/lib/auth.ts`
- Create: `worker/src/lib/jwt-verify.ts`
- Create: `worker/src/lib/__tests__/jwt-verify.test.ts`
- Modify: `worker/src/lib/env.ts` (add `CF_ACCESS_AUD` env var)
- Modify: `.env.example`

- [ ] **Step 1: Create JWT verification module**

Create `worker/src/lib/jwt-verify.ts` implementing Cloudflare Access JWT verification:

```typescript
export interface JwtVerifyOptions {
  token: string;
  aud: string;           // Application AUD from Access settings
  teamDomain: string;    // e.g., "pharos" for pharos.cloudflareaccess.com
}

export async function verifyAccessJwt(options: JwtVerifyOptions): Promise<boolean> {
  // 1. Decode JWT header to get kid
  // 2. Fetch JWKS from https://{teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs
  // 3. Find matching key by kid
  // 4. Verify signature using Web Crypto API (importKey + verify)
  // 5. Validate claims: aud matches, exp > now, iss matches team domain
  // Return true if valid, false otherwise
}
```

Cache the JWKS keys in-memory (they rotate infrequently) with a 1-hour TTL.

- [ ] **Step 2: Write tests for JWT verification**

Create `worker/src/lib/__tests__/jwt-verify.test.ts`:
- Test with a valid (self-signed for testing) JWT: passes
- Test with expired JWT: fails
- Test with wrong audience: fails
- Test with tampered payload: fails

- [ ] **Step 3: Update `hasOpsApiAccessSignal` to verify JWT**

In `worker/src/lib/auth.ts`, update `hasOpsApiAccessSignal` to call `verifyAccessJwt`:

```typescript
export async function hasOpsApiAccessSignal(request: Request, env: Env): Promise<boolean> {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) return false;

  if (env.CF_ACCESS_AUD) {
    return verifyAccessJwt({
      token: jwt,
      aud: env.CF_ACCESS_AUD,
      teamDomain: env.CF_ACCESS_TEAM_DOMAIN ?? "pharos",
    });
  }

  // Fallback to header-presence check if AUD not configured (backwards compat)
  return true;
}
```

**Async cascade:** Making `hasOpsApiAccessSignal` async requires making `hasValidAdminCredential` async too (it calls `hasOpsApiAccessSignal`), which cascades to `requireAdmin` and `withAdmin`. Trace the full call chain and update all signatures:
1. `hasOpsApiAccessSignal(request, env)` → `async`, returns `Promise<boolean>`
2. `hasValidAdminCredential(request, env)` → `async`, returns `Promise<boolean>` (add `env` parameter)
3. `requireAdmin(request, env)` → already async, add `env` parameter, `await hasValidAdminCredential`
4. `withAdmin(request, env, handler)` → already async, add `env` parameter
5. All callers in `worker/src/handlers/http.ts` and route handlers — pass `env` through

- [ ] **Step 4: Add `CF_ACCESS_AUD` and `CF_ACCESS_TEAM_DOMAIN` to Env interface and `.env.example`**

- [ ] **Step 5: Run tests**

```bash
npm test && cd worker && npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "security: add JWT signature verification for admin auth (Q-001)"
```

---

### Task 15: Stablecoin Metadata Split

**Findings:** S-002

**Files:**
- Create: `shared/lib/stablecoins/index.ts`
- Create: `shared/lib/stablecoins/usd-major.ts`
- Create: `shared/lib/stablecoins/usd-minor.ts`
- Create: `shared/lib/stablecoins/non-usd.ts`
- Create: `shared/lib/stablecoins/commodity.ts`
- Create: `shared/lib/stablecoins/factory.ts`
- Modify: `shared/lib/stablecoins.ts` (becomes re-export barrel)

- [ ] **Step 1: Create the factory module**

Extract the `coin()`, `usd()`, `eur()`, `other()` factory functions and `StablecoinOpts` interface into `shared/lib/stablecoins/factory.ts`.

- [ ] **Step 2: Split stablecoin entries by category**

Organize the 157 entries into category files:
- `usd-major.ts`: Top stablecoins by market cap (USDT, USDC, DAI, BUSD, etc. — ~30 entries)
- `usd-minor.ts`: Remaining USD-pegged stablecoins (~80 entries)
- `non-usd.ts`: EUR, GBP, JPY, BRL, IDR, and other fiat pegs (~30 entries)
- `commodity.ts`: Gold, silver, and commodity-backed tokens (~15 entries)

Each file exports a `const` array of stablecoin definitions.

- [ ] **Step 3: Create barrel index**

Create `shared/lib/stablecoins/index.ts` that re-exports the combined `TRACKED_STABLECOINS` array and all existing utility exports (`TRACKED_META_BY_ID`, `findByTicker`, etc.).

- [ ] **Step 4: Update `shared/lib/stablecoins.ts` to be a re-export barrel**

Replace the 4,890-line file with a single re-export from the new directory:

```typescript
export * from "./stablecoins/index";
```

This preserves all existing import paths (`@shared/lib/stablecoins`).

- [ ] **Step 5: Run tests and build**

```bash
npm test && npm run build && cd worker && npx tsc --noEmit
```

Verify all 62 consuming modules still compile.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor: split stablecoin metadata monolith into category files (S-002)"
```

---

### Task 16: Testing Gaps

**Findings:** Q-013

**Files:**
- Create: `worker/src/cron/__tests__/yield-resolve.test.ts`
- Create: `worker/src/cron/__tests__/reserve-adapters.test.ts`

- [ ] **Step 1: Add yield resolution tests**

Create `worker/src/cron/__tests__/yield-resolve.test.ts` covering:
- Source selection logic (4-tier resolution)
- APY normalization
- T-bill excess yield calculation
- Warning signal generation

- [ ] **Step 2: Add critical reserve adapter tests**

Create `worker/src/cron/__tests__/reserve-adapters.test.ts` covering at minimum:
- Tether adapter (largest by AUM — data decoding, normalization)
- Circle adapter (USDC — data decoding, normalization)
- Ethena adapter (USDe — on-chain data parsing)
- Sky/MakerDAO adapter (DAI — complex multi-collateral parsing)

Mock the on-chain RPC responses and verify parsed reserve compositions match expected structures.

- [ ] **Step 3: Run tests**

```bash
npx vitest run worker/src/cron/__tests__/yield-resolve.test.ts worker/src/cron/__tests__/reserve-adapters.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test: add yield resolution and reserve adapter unit tests (Q-013)"
```

---

### Task 17: Freshness Threshold Consolidation

**Findings:** R-013

**Files:**
- Modify: `shared/lib/status-thresholds.ts`
- Modify: `worker/src/lib/api-utils.ts`
- Modify: `src/lib/data-health.ts`

- [ ] **Step 1: Centralize ratio boundaries in `status-thresholds.ts`**

In `shared/lib/status-thresholds.ts`, define canonical freshness ratio boundaries:

```typescript
export const FRESHNESS_RATIOS = {
  /** Data is considered fresh if age <= interval * FRESH_RATIO */
  FRESH: 1.0,
  /** Data is degraded if age <= interval * DEGRADED_RATIO */
  DEGRADED: 1.5,
  /** Data is stale if age > interval * DEGRADED_RATIO */
  // Anything beyond DEGRADED is stale
} as const;
```

- [ ] **Step 2: Update `buildFreshnessMeta` in `api-utils.ts` to use shared ratios**

Import `FRESHNESS_RATIOS` from `@shared/lib/status-thresholds` and use its values instead of hardcoded 1.0/1.5.

- [ ] **Step 3: Update frontend `data-health.ts` to reference shared ratios**

Where the frontend defines its own freshness boundaries, import from the shared module so both layers use the same thresholds.

- [ ] **Step 4: Run tests**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor: consolidate freshness thresholds into shared definitions (R-013)"
```

---

### Task 18: Documentation & Tracking Items

**Findings:** S-012, S-013, S-016, Q-017, Q-015, S-011

These findings are documentation, tracking, or very low priority. Address as documentation updates.

> **Intentionally deferred (accepted risk):**
> - **Q-015** (fetchWithRetry null return semantics): Low severity, all callers already handle null. Document-only — no code change.
> - **Q-017** (health endpoint verbosity): Low risk for a public analytics dashboard. No action taken — accepted as-is.
> - **S-011** (dead stablecoin registry growth): 81 entries is tiny. Revisit when approaching hundreds.

**Files:**
- Modify: `docs/worker-infrastructure.md`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Document migration squash strategy (S-012)**

Add a section to `docs/worker-infrastructure.md` or the migration `MANIFEST.md`:

```markdown
## Migration Squash Strategy

When the migration count reaches ~150, perform a one-time squash:
1. Export current schema via `wrangler d1 export stablecoin-db --remote --output=baseline.sql`
2. Replace all migrations with a single `0001_baseline.sql`
3. Update migration tracking in D1
```

- [ ] **Step 2: Document cron capacity plan (S-013)**

Add to `docs/worker-infrastructure.md`:

```markdown
## Cron Slot Capacity Plan

Currently using 10 of 15 available cron triggers. 5 slots remain.
If capacity is exhausted, consider deploying a second worker for
low-frequency jobs (daily/weekly) to free high-frequency slots.
```

- [ ] **Step 3: Document ES2017 shared-module floor (S-016)**

Add to `docs/architecture.md`:

```markdown
## TypeScript Target Constraints

Root tsconfig targets ES2017 (for browser compatibility).
Worker targets ES2021 (Cloudflare Workers runtime).
Shared modules MUST be ES2017-compatible as they compile under both targets.
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: add migration squash, cron capacity, and TS target documentation (S-012, S-013, S-016)"
```

---

## Execution Dependencies

> **File conflict note:** Tasks 1, 2, and 3 share overlapping files (`worker/src/lib/api-utils.ts`
> is touched by Tasks 1 and 2; `worker/src/cron/enrich-prices.ts` by Tasks 1 and 3). They must
> run sequentially (1 → 2 → 3) or in a single worktree, NOT as parallel agents.

```
Task 1 → Task 2 → Task 3   (sequential — shared files: api-utils.ts, enrich-prices.ts)

Task 4 ─┐
Task 5 ─┼─── independent (parallel batch A, no file overlap with Tasks 1-3 or each other)
Task 7 ─┤
Task 8 ─┘

Task 5 → Task 9      (sequential — shared file: detect-depegs.ts)

Task 6 ────── independent (but must complete before Task 13 — shared file: daily-digest.ts)
Task 10 ───── independent

Tasks 5, 6, 8 must complete before:
Task 11 ──→ Task 12 ──→ Task 13  (sequential: state → pipeline → context)
  (Task 13 shares files with Tasks 5, 6, 8: telegram-webhook.ts, daily-digest.ts, route-registry.ts)

Task 14 ───── independent
Task 15 ───── independent (high risk — extra review)
Task 16 ───── independent (no production code changes)
Task 17 ───── depends on Task 2 (buildFreshnessMeta export)
Task 18 ───── independent (docs only)
```

## Verification Gate

After all tasks complete:

```bash
# Full build + type-check
npm run build && cd worker && npx tsc --noEmit

# Full test suite
npm test

# Critical contract tests
npm run test:critical-contracts

# Worker boundary check
npm run check:worker-boundary

# Lint
npm run lint

# Cron schedule sync check
npm run check:cron-sync
```

All must pass before pushing to main.
