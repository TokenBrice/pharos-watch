# Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate all 28 findings from the 2026-03-29 comprehensive codebase audit across redundancy, code quality, and sustainability pillars.

**Architecture:** Four-phase approach ordered by effort/impact ratio. Phase 1 (quick wins) removes dead code and shims. Phase 2 (targeted refactoring) consolidates duplicated logic, improves observability, and adds CI guardrails. Phase 3 (structural) decomposes monolithic files and adds test coverage. Phase 4 (strategic) addresses CI/CD rollback and scaling concerns.

**Tech Stack:** TypeScript strict, Next.js 16, Cloudflare Workers + D1, Vitest, ESLint

**Audit reference:** `agents/audits/2026-03-29-comprehensive-codebase-audit.md`

---

## Phase 1 — Quick Wins

### Task 1: Delete dead root artifact and dead export [R1/S1, R2]

**Files:**
- Delete: `DESIGN-MAPPING-TABLE.ts`
- Modify: `shared/lib/format.ts` (remove `formatDeathDateShort`, ~line 198)
- Modify: `src/lib/__tests__/format.test.ts` (remove tests, ~line 357)

- [ ] **Step 1: Delete orphaned mapping table**

```bash
git rm DESIGN-MAPPING-TABLE.ts
```

- [ ] **Step 2: Remove `formatDeathDateShort` from shared/lib/format.ts**

Remove the function (lines 198-203):

```ts
// DELETE this entire function:
export function formatDeathDateShort(d: string): string {
  const [year, month] = d.split("-");
  if (!month) return year;
  const dt = new Date(Number(year), Number(month) - 1);
  return dt.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}
```

Also remove `formatDeathDateShort` from any import/export barrel if present.

- [ ] **Step 3: Remove tests for `formatDeathDateShort` from format.test.ts**

Remove the describe block (lines 357-369):

```ts
// DELETE this entire describe block:
describe("formatDeathDateShort", () => {
  it("formats with short year", () => {
    const jan23 = formatDeathDateShort("2023-01");
    expect(jan23).toMatch(/^Jan.+23$/);
    const dec24 = formatDeathDateShort("2024-12");
    expect(dec24).toMatch(/^Dec.+24$/);
  });

  it("returns year only if no month", () => {
    expect(formatDeathDateShort("2023")).toBe("2023");
  });
});
```

Remove the `formatDeathDateShort` import at the top of the test file.

- [ ] **Step 4: Verify**

Run: `npm test -- --run src/lib/__tests__/format.test.ts`
Expected: all remaining tests pass

- [ ] **Step 5: Commit**

```bash
git add DESIGN-MAPPING-TABLE.ts shared/lib/format.ts src/lib/__tests__/format.test.ts
git commit -m "chore: remove dead DESIGN-MAPPING-TABLE and unused formatDeathDateShort [R1/S1, R2]"
```

---

### Task 2: Remove worker re-export shims [R3]

**Files:**
- Delete: `worker/src/lib/depeg-config.ts`
- Delete: `worker/src/lib/dews-config.ts`
- Modify: `worker/src/lib/constants.ts:5`
- Modify: `worker/src/lib/dews.ts:15`

- [ ] **Step 1: Update constants.ts import**

In `worker/src/lib/constants.ts`, change line 5:

```ts
// OLD:
} from "./depeg-config";
// NEW:
} from "@shared/lib/depeg-config";
```

- [ ] **Step 2: Update dews.ts import**

In `worker/src/lib/dews.ts`, change line 15:

```ts
// OLD:
} from "./dews-config";
// NEW:
} from "@shared/lib/dews-config";
```

- [ ] **Step 3: Delete shim files**

```bash
git rm worker/src/lib/depeg-config.ts worker/src/lib/dews-config.ts
```

- [ ] **Step 4: Verify**

Run: `cd worker && npx tsc --noEmit`
Expected: clean

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/constants.ts worker/src/lib/dews.ts worker/src/lib/depeg-config.ts worker/src/lib/dews-config.ts
git commit -m "chore: remove worker re-export shims for depeg-config and dews-config [R3]"
```

---

### Task 3: Remove frontend cache-health re-export shim [R8]

**Files:**
- Delete: `src/lib/status/cache-health.ts`
- Modify: `src/lib/__tests__/cache-health.test.ts:2`
- Modify: `src/lib/status/public-status.ts:4`
- Modify: `src/components/status/cache-freshness-table.tsx:5`

- [ ] **Step 1: Update test import**

In `src/lib/__tests__/cache-health.test.ts`, change line 2:

```ts
// OLD:
import { getCacheFreshnessStatus, getCacheImpactStatus } from "@/lib/status/cache-health";
// NEW:
import { getCacheFreshnessStatus, getCacheImpactStatus } from "@shared/lib/cache-health";
```

- [ ] **Step 2: Update public-status.ts import**

In `src/lib/status/public-status.ts`, change line 4:

```ts
// OLD:
import { getCacheFreshnessRatio, getCacheImpactStatus } from "@/lib/status/cache-health";
// NEW:
import { getCacheFreshnessRatio, getCacheImpactStatus } from "@shared/lib/cache-health";
```

- [ ] **Step 3: Update cache-freshness-table.tsx import**

In `src/components/status/cache-freshness-table.tsx`, change line 5:

```ts
// OLD:
import { getCacheFreshnessRatio, getCacheFreshnessStatus } from "@/lib/status/cache-health";
// NEW:
import { getCacheFreshnessRatio, getCacheFreshnessStatus } from "@shared/lib/cache-health";
```

- [ ] **Step 4: Delete shim file**

```bash
git rm src/lib/status/cache-health.ts
```

- [ ] **Step 5: Verify**

Run: `npm run build && npm test -- --run src/lib/__tests__/cache-health.test.ts`
Expected: build clean, tests pass

- [ ] **Step 6: Commit**

```bash
git add src/lib/status/cache-health.ts src/lib/__tests__/cache-health.test.ts src/lib/status/public-status.ts src/components/status/cache-freshness-table.tsx
git commit -m "chore: remove cache-health re-export shim, import from @shared directly [R8]"
```

---

### Task 4: Remove findChainData wrapper [R4]

**Files:**
- Modify: `src/hooks/use-chains.ts:44-49, 66`
- Modify: `src/hooks/__tests__/use-chains.test.ts`

- [ ] **Step 1: Replace internal usage in use-chains.ts**

In `src/hooks/use-chains.ts`, change line 66:

```ts
// OLD:
      const chainData = findChainData(
        cc as RawChainCirculating,
        chainId,
      );
// NEW:
      const chainData = findCanonicalChainData(
        cc as RawChainCirculating,
        chainId,
      );
```

- [ ] **Step 2: Remove findChainData function**

Delete lines 39-49 (the JSDoc + function):

```ts
// DELETE:
/**
 * Find all chainCirculating entries that resolve to the target chain ID.
 * Handles DL display names ("Ethereum", "BSC") and aliases ("hyperliquid-l1").
 * Returns the summed data across all matching keys.
 */
export function findChainData(
  cc: RawChainCirculating,
  targetChainId: string,
): { current: number; circulatingPrevDay: number; circulatingPrevWeek: number; circulatingPrevMonth: number } | null {
  return findCanonicalChainData(cc, targetChainId);
}
```

- [ ] **Step 3: Update test file**

In `src/hooks/__tests__/use-chains.test.ts`:

Change the import (line 2):
```ts
// OLD:
import { findChainData } from "@/hooks/use-chains";
// NEW:
import { findCanonicalChainData } from "@shared/lib/chain-circulating";
```

Also import the type needed for test data:
```ts
import { findCanonicalChainData, type RawChainCirculating } from "@shared/lib/chain-circulating";
```

Rename the describe block (line 14):
```ts
// OLD:
describe("findChainData", () => {
// NEW:
describe("findCanonicalChainData", () => {
```

Replace all `findChainData(` calls with `findCanonicalChainData(` throughout the test file (10 occurrences at lines 16, 24, 36, 45, 54, 64, 74, 86, 96, 105).

- [ ] **Step 4: Verify**

Run: `npm test -- --run src/hooks/__tests__/use-chains.test.ts`
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/hooks/use-chains.ts src/hooks/__tests__/use-chains.test.ts
git commit -m "chore: remove findChainData wrapper, use findCanonicalChainData directly [R4]"
```

---

### Task 5: Batch one-line fixes [R9, Q6, Q7]

**Files:**
- Modify: `src/components/yield-detail-section.tsx:18, 59`
- Modify: `worker/src/api/admin-actions.ts:78-81`
- Modify: `worker/src/cron/daily-digest.ts:111`

- [ ] **Step 1: Fix unnecessary import alias (R9)**

In `src/components/yield-detail-section.tsx`, change line 18:

```ts
// OLD:
import { formatCurrency, formatPercent, formatSignedPercent as sharedFormatSignedPercent } from "@shared/lib/format";
// NEW:
import { formatCurrency, formatPercent, formatSignedPercent } from "@shared/lib/format";
```

Change line 59:

```ts
// OLD:
  return sharedFormatSignedPercent(value);
// NEW:
  return formatSignedPercent(value);
```

- [ ] **Step 2: Remove manual globalThis cast for UUID generation (Q6)**

In `worker/src/api/admin-actions.ts`, replace lines 78-81:

```ts
// OLD:
      const cryptoObj = globalThis as typeof globalThis & {
        crypto?: { randomUUID?: () => string };
      };
      const requestId = cryptoObj.crypto?.randomUUID?.() ?? `manual-digest-${Date.now()}`;
// NEW:
      const requestId = `manual-digest-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
```

Note: `createLeaseOwner` (imported on line 5) is semantically for lease ownership, not request tracking. A simple unique-enough ID is sufficient for digest request tracing. If cryptographic randomness is ever needed here, refactor `createLeaseOwner` into a shared `generateUniqueId()` utility instead.

- [ ] **Step 3: Add SQL safety comment (Q7)**

In `worker/src/cron/daily-digest.ts`, add a safety comment before line 111:

```ts
// OLD:
  const countResult = await db.prepare(`SELECT COUNT(*) as cnt FROM daily_digest WHERE ${DAILY_FILTER}`).all<{ cnt: number }>();
// NEW:
  // SAFETY: DAILY_FILTER is a hardcoded SQL fragment (line 101), not derived from user input.
  const countResult = await db.prepare(`SELECT COUNT(*) as cnt FROM daily_digest WHERE ${DAILY_FILTER}`).all<{ cnt: number }>();
```

- [ ] **Step 4: Verify**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: both clean

- [ ] **Step 5: Commit**

```bash
git add src/components/yield-detail-section.tsx worker/src/api/admin-actions.ts worker/src/cron/daily-digest.ts
git commit -m "chore: fix import alias, simplify UUID generation, add SQL safety comment [R9, Q6, Q7]"
```

---

### Task 6: Rename dex discovery slot function [Q11]

**Files:**
- Rename: `worker/src/handlers/scheduled/twenty-minute-dex-discovery.ts` -> `thirty-minute-dex-discovery.ts`
- Modify: `worker/src/handlers/scheduled.ts:9`

- [ ] **Step 1: Rename function in source file**

In `worker/src/handlers/scheduled/twenty-minute-dex-discovery.ts`, change line 4:

```ts
// OLD:
export async function runTwentyMinuteDexDiscoverySlot(runtime: ScheduledRuntimeContext): Promise<void> {
// NEW:
export async function runThirtyMinuteDexDiscoverySlot(runtime: ScheduledRuntimeContext): Promise<void> {
```

- [ ] **Step 2: Rename the file**

```bash
git mv worker/src/handlers/scheduled/twenty-minute-dex-discovery.ts worker/src/handlers/scheduled/thirty-minute-dex-discovery.ts
```

- [ ] **Step 3: Update import in scheduled.ts**

In `worker/src/handlers/scheduled.ts`, change line 9:

```ts
// OLD:
import { runTwentyMinuteDexDiscoverySlot } from "./scheduled/twenty-minute-dex-discovery";
// NEW:
import { runThirtyMinuteDexDiscoverySlot } from "./scheduled/thirty-minute-dex-discovery";
```

Change line 26:

```ts
// OLD:
  thirtyMinuteDexDiscovery: runTwentyMinuteDexDiscoverySlot,
// NEW:
  thirtyMinuteDexDiscovery: runThirtyMinuteDexDiscoverySlot,
```

- [ ] **Step 4: Verify**

Run: `cd worker && npx tsc --noEmit`
Expected: clean

- [ ] **Step 5: Commit**

```bash
git add worker/src/handlers/scheduled/twenty-minute-dex-discovery.ts worker/src/handlers/scheduled/thirty-minute-dex-discovery.ts worker/src/handlers/scheduled.ts
git commit -m "chore: rename runTwentyMinuteDexDiscoverySlot to match 30-minute schedule [Q11]"
```

---

### Task 7: Align TypeScript targets to ES2022 [S8]

**Files:**
- Modify: `tsconfig.json:4`
- Modify: `worker/tsconfig.json:4`

- [ ] **Step 1: Update root tsconfig**

In `tsconfig.json`, change line 4:

```json
// OLD:
    "target": "ES2017",
// NEW:
    "target": "ES2022",
```

- [ ] **Step 2: Update worker tsconfig**

In `worker/tsconfig.json`, change line 4:

```json
// OLD:
    "target": "ES2021",
// NEW:
    "target": "ES2022",
```

- [ ] **Step 3: Verify**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: both clean (Next.js handles browser targeting via SWC independently)

- [ ] **Step 4: Commit**

```bash
git add tsconfig.json worker/tsconfig.json
git commit -m "chore: align TypeScript targets to ES2022 to match Node 22+ runtime [S8]"
```

---

### Task 8: Phase 1 validation

- [ ] **Step 1: Run the merge gate**

```bash
npm run test:merge-gate
```

Expected: all checks pass.

- [ ] **Step 2: Verify no regressions**

```bash
npm test
```

Expected: all tests pass.

---

## Phase 2 — Targeted Refactoring

### Task 9: Consolidate status severity logic [R5]

**Files:**
- Modify: `shared/lib/public-health.ts` (export new `getStatusSeverity` function)
- Modify: `src/lib/status/public-status.ts:56-60` (remove local function, import from shared)
- Modify: `src/components/status/top-fold-copy.ts:76-80` (remove local function, import from shared)

- [ ] **Step 1: Export `getStatusSeverity` from shared/lib/public-health.ts**

Add after the `STATUS_SEVERITY` record (after line 10):

```ts
export function getStatusSeverity(status: PublicStatusTone): number {
  return STATUS_SEVERITY[status];
}
```

- [ ] **Step 2: Replace local function in public-status.ts**

In `src/lib/status/public-status.ts`, add import:

```ts
// ADD to existing import from @shared/lib/public-health (or add new import):
import { getStatusSeverity } from "@shared/lib/public-health";
```

Remove the local function (lines 56-60):

```ts
// DELETE:
function getStatusSeverity(status: PublicStatusTone): number {
  if (status === "stale") return 2;
  if (status === "degraded") return 1;
  return 0;
}
```

- [ ] **Step 3: Replace local function in top-fold-copy.ts**

In `src/components/status/top-fold-copy.ts`, add import:

```ts
import { getStatusSeverity } from "@shared/lib/public-health";
```

Remove the local function (lines 76-80):

```ts
// DELETE:
function getStatusSeverity(status: StatusResponse["overallStatus"]): number {
  if (status === "healthy") return 0;
  if (status === "degraded") return 1;
  return 2;
}
```

Note: `StatusResponse["overallStatus"]` is compatible with `PublicStatusTone` (both are `"healthy" | "degraded" | "stale"`). If the compiler flags a type mismatch, cast at the call site: `getStatusSeverity(overallStatus as PublicStatusTone)`.

- [ ] **Step 4: Verify**

Run: `npm run build`
Expected: clean

- [ ] **Step 5: Commit**

```bash
git add shared/lib/public-health.ts src/lib/status/public-status.ts src/components/status/top-fold-copy.ts
git commit -m "refactor: consolidate duplicate getStatusSeverity into shared/lib/public-health [R5]"
```

---

### Task 10: Add chart animation constant [R6]

**Files:**
- Modify: `src/lib/chart-animation.ts`
- Modify: `src/components/total-mcap-chart.tsx:31`
- Modify: `src/components/psi-history-chart.tsx:152`
- Modify: `src/components/peg-diversity-chart.tsx:72`
- Modify: `src/app/stability-index/client.tsx:147`

- [ ] **Step 1: Add CHART_NO_ANIM constant**

In `src/lib/chart-animation.ts`, add after the existing export:

```ts
export const CHART_NO_ANIM = { isAnimationActive: false } as const;
```

- [ ] **Step 2: Update all four consumers**

In each file, update the import to include `CHART_NO_ANIM`, then replace the inline object:

```ts
// OLD (in each file):
const animProps = shouldAnimate ? CHART_DRAW_IN : { isAnimationActive: false };
// NEW:
const animProps = shouldAnimate ? CHART_DRAW_IN : CHART_NO_ANIM;
```

Files to update:
- `src/components/total-mcap-chart.tsx:31`
- `src/components/psi-history-chart.tsx:152`
- `src/components/peg-diversity-chart.tsx:72`
- `src/app/stability-index/client.tsx:147`

Each file's import line needs `CHART_NO_ANIM` added (they already import `CHART_DRAW_IN` from `@/lib/chart-animation`).

- [ ] **Step 3: Verify**

Run: `npm run build`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add src/lib/chart-animation.ts src/components/total-mcap-chart.tsx src/components/psi-history-chart.tsx src/components/peg-diversity-chart.tsx src/app/stability-index/client.tsx
git commit -m "refactor: extract CHART_NO_ANIM constant to deduplicate animation pattern [R6]"
```

---

### Task 11: Consolidate getPriceCache dual query [Q4]

**Files:**
- Modify: `worker/src/lib/db-cache.ts:66-117`

- [ ] **Step 1: Merge into a single query**

Replace the entire `getPriceCache` function body (lines 66-117) with:

```ts
export async function getPriceCache(db: D1Database): Promise<Map<string, PriceCacheEntry>> {
  const map = new Map<string, PriceCacheEntry>();

  // Try full-column query first (preferred — single D1 read).
  try {
    const result = await db
      .prepare(
        "SELECT asset_id, price, updated_at, source, confidence, observed_at, observed_at_mode, synced_at, agree_sources_json, consensus_sources_json FROM price_cache",
      )
      .all<{
        asset_id: string;
        price: number;
        updated_at: number;
        source: string | null;
        confidence: PriceConfidence | null;
        observed_at: number | null;
        observed_at_mode: PriceObservedAtMode | null;
        synced_at: number | null;
        agree_sources_json: string | null;
        consensus_sources_json: string | null;
      }>();
    for (const row of result.results ?? []) {
      map.set(row.asset_id, {
        price: row.price,
        updatedAt: row.updated_at,
        source: row.source ?? null,
        confidence: row.confidence ?? null,
        observedAt: row.observed_at ?? row.updated_at,
        observedAtMode: row.observed_at_mode ?? null,
        syncedAt: row.synced_at ?? row.updated_at,
        agreeSources: parseJsonStringArray(row.agree_sources_json),
        consensusSources: parseJsonStringArray(row.consensus_sources_json),
      });
    }
    return map;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("no such column")) {
      console.warn("[db-cache] Full-column price_cache query failed, trying core-only fallback:", msg);
    }
  }

  // Fallback: core columns only (schema may be missing metadata columns,
  // or the full-column query hit a transient D1 error).
  try {
    const result = await db
      .prepare("SELECT asset_id, price, updated_at FROM price_cache")
      .all<{ asset_id: string; price: number; updated_at: number }>();
    for (const row of result.results ?? []) {
      map.set(row.asset_id, {
        price: row.price,
        updatedAt: row.updated_at,
        source: null,
        confidence: null,
        observedAt: row.updated_at,
        observedAtMode: null,
        syncedAt: row.updated_at,
        agreeSources: [],
        consensusSources: [],
      });
    }
  } catch (err) {
    console.warn("[db-cache] Failed to load price_cache:", err instanceof Error ? err.message : String(err));
  }
  return map;
}
```

- [ ] **Step 2: Update existing test mock for the new query**

The existing `getPriceCache` test in `worker/src/lib/__tests__/db-utils.test.ts` uses a `makeDb` mock that only matches the core-column SQL string (`"SELECT asset_id, price, updated_at FROM price_cache"`). After this refactoring, the function tries the full-column query first. Update the mock's `prepare()` handler to also match the full-column SQL string and return the same `priceRows` data with additional null metadata columns:

```ts
// In the makeDb helper, add a case for the full-column query:
if (sql.includes("source, confidence, observed_at")) {
  return {
    all: async () => ({
      results: priceRows.map((r) => ({
        ...r,
        source: null,
        confidence: null,
        observed_at: null,
        observed_at_mode: null,
        synced_at: null,
        agree_sources_json: null,
        consensus_sources_json: null,
      })),
    }),
  };
}
```

Also add a new test for the schema-error fallback:

```ts
it("falls back to core columns when metadata columns are missing", async () => {
  // Use a mock DB where the full-column query throws "no such column: source"
  // and the core-column query succeeds with price data
});
```

- [ ] **Step 3: Verify**

Run: `cd worker && npx tsc --noEmit && cd .. && npm test -- --run worker/`
Expected: type-check clean, related tests pass

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/db-cache.ts
git commit -m "refactor: consolidate getPriceCache into single query with schema fallback [Q4]"
```

---

### Task 12: Extract mergeCronMetadataWithLease helper [Q2]

**Files:**
- Create: `worker/src/lib/cron-metadata.ts` (add function — verify file exists first; if it does, append to it)
- Modify: `worker/src/handlers/scheduled/context.ts:154-171`

- [ ] **Step 1: Check if cron-metadata.ts exists and read it**

The file `worker/src/lib/cron-metadata.ts` likely already exists (it's imported on line 7 of `admin-actions.ts`). Read it and add the new function.

Add this function to `worker/src/lib/cron-metadata.ts`:

```ts
export function mergeCronMetadataWithLease(
  cronMetadata: string | null | undefined,
  leaseMeta: Record<string, unknown>,
): string {
  if (!cronMetadata) return JSON.stringify(leaseMeta);
  try {
    const parsed = JSON.parse(cronMetadata) as Record<string, unknown>;
    return JSON.stringify({ ...parsed, ...leaseMeta });
  } catch {
    return `${cronMetadata} | lease=${JSON.stringify(leaseMeta)}`;
  }
}
```

- [ ] **Step 2: Use helper in context.ts**

In `worker/src/handlers/scheduled/context.ts`, add import:

```ts
import { mergeCronMetadataWithLease } from "../../lib/cron-metadata";
```

Replace only the metadata merging block (lines 161-171 — the `const normalized`, `let metadata`, and the try/catch/fallback logic). Keep the `leaseMeta` construction at lines 154-160 intact. The block to replace:

```ts
// OLD (lines 161-171):
        const normalized = normalizeCronMetadata(result);
        let metadata = normalized;
        if (!metadata) {
          metadata = JSON.stringify(leaseMeta);
        } else {
          try {
            const parsed = JSON.parse(metadata) as Record<string, unknown>;
            metadata = JSON.stringify({ ...parsed, ...leaseMeta });
          } catch {
            metadata = `${metadata} | lease=${JSON.stringify(leaseMeta)}`;
          }
        }
// NEW:
        const metadata = mergeCronMetadataWithLease(
          normalizeCronMetadata(result),
          leaseMeta,
        );
```

Keep the existing `leaseMeta` const (lines 154-160) and the subsequent `reportProgress` call and `return` statement unchanged.

- [ ] **Step 3: Add test for the helper**

Create or append to the test file for cron-metadata. Write a test:

```ts
import { mergeCronMetadataWithLease } from "../lib/cron-metadata";

describe("mergeCronMetadataWithLease", () => {
  it("returns lease meta when cron metadata is null", () => {
    const result = mergeCronMetadataWithLease(null, { owner: "test" });
    expect(JSON.parse(result)).toEqual({ owner: "test" });
  });

  it("merges when cron metadata is valid JSON", () => {
    const result = mergeCronMetadataWithLease('{"items":5}', { owner: "test" });
    expect(JSON.parse(result)).toEqual({ items: 5, owner: "test" });
  });

  it("falls back to string concat when cron metadata is not JSON", () => {
    const result = mergeCronMetadataWithLease("plain text", { owner: "test" });
    expect(result).toContain("plain text");
    expect(result).toContain("lease=");
  });
});
```

- [ ] **Step 4: Verify**

Run: `cd worker && npx tsc --noEmit && cd .. && npm test -- --run worker/`
Expected: clean

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/cron-metadata.ts worker/src/handlers/scheduled/context.ts worker/src/lib/__tests__/cron-metadata.test.ts
git commit -m "refactor: extract mergeCronMetadataWithLease to reduce runLeasedCron complexity [Q2]"
```

---

### Task 13: Add SQL interpolation allowlist to dex-liquidity persistence [Q5]

**Files:**
- Modify: `worker/src/cron/dex-liquidity/persistence.ts:174-187`

- [ ] **Step 1: Add allowlist constant**

Add before the orphan cleanup block (around line 170):

```ts
const DEX_LIQUIDITY_TABLES = new Set([
  "dex_liquidity",
  "dex_liquidity_history",
  "dex_discovery_meta",
] as const);
```

- [ ] **Step 2: Add validation and safety comments**

Replace lines 175-186 with:

```ts
    const tables = ["dex_liquidity", "dex_liquidity_history", "dex_discovery_meta"] as const;
    for (const table of tables) {
      if (!DEX_LIQUIDITY_TABLES.has(table)) throw new Error(`Invalid DEX liquidity table: ${table}`);
      const existingRows = await db
        // SAFETY: validated against DEX_LIQUIDITY_TABLES allowlist above.
        .prepare(`SELECT DISTINCT stablecoin_id FROM ${table}`)
        .all<{ stablecoin_id: string }>();
      for (const row of existingRows.results ?? []) {
        if (!validIds.has(row.stablecoin_id)) {
          stmts.push(
            // SAFETY: validated against DEX_LIQUIDITY_TABLES allowlist above.
            db.prepare(`DELETE FROM ${table} WHERE stablecoin_id = ?`).bind(row.stablecoin_id),
          );
        }
      }
    }
```

- [ ] **Step 3: Verify**

Run: `cd worker && npx tsc --noEmit`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/dex-liquidity/persistence.ts
git commit -m "refactor: add DEX_LIQUIDITY_TABLES allowlist for SQL interpolation safety [Q5]"
```

---

### Task 14: Add RPC failure summary logging [Q10]

**Files:**
- Modify: `worker/src/lib/evm-rpc.ts:60-101, 138-179`

- [ ] **Step 1: Add failure tracking to fetchJsonRpcResult**

In `worker/src/lib/evm-rpc.ts`, modify `fetchJsonRpcResult` (lines 60-101):

```ts
async function fetchJsonRpcResult<T>(
  urls: string[],
  method: string,
  params: unknown[],
  options?: EvmRpcOptions,
): Promise<T | null> {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const maxRetries = options?.maxRetries ?? 1;
  const failures: string[] = [];

  for (const rpcUrl of urls) {
    try {
      const res = await fetchWithRetry(
        rpcUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: options?.signal,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params,
          }),
        },
        maxRetries,
        { timeoutMs },
      );

      if (!res?.ok) {
        failures.push(`${rpcUrl}: HTTP ${res?.status ?? "no-response"}`);
        continue;
      }

      const body = await res.json() as JsonRpcEnvelope<T>;
      if (body.error) {
        failures.push(`${rpcUrl}: RPC error ${body.error.code ?? ""} ${body.error.message ?? ""}`);
        continue;
      }
      if (body.result == null) {
        failures.push(`${rpcUrl}: null result`);
        continue;
      }

      return body.result;
    } catch (err) {
      failures.push(`${rpcUrl}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
  }

  if (failures.length > 0) {
    console.warn(`[evm-rpc] ${method} failed across ${urls.length} RPCs: ${failures.join("; ")}`);
  }
  return null;
}
```

- [ ] **Step 2: Add failure tracking to fetchEvmCallHexAtBlock**

Similarly modify `fetchEvmCallHexAtBlock` (lines 138-179) to collect failures and log a summary if all URLs fail. Follow the same pattern: add `const failures: string[] = [];`, collect failure reasons in each branch, and log after the loop.

- [ ] **Step 3: Verify**

Run: `cd worker && npx tsc --noEmit && cd .. && npm test -- --run worker/src/lib/__tests__/evm-rpc`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/evm-rpc.ts
git commit -m "refactor: add RPC failure summary logging for debugging observability [Q10]"
```

---

### Task 15: Add observability to empty catch blocks [Q1]

**Files:**
- Multiple files across `worker/src/cron/`

This is the largest remediation task. The ~70 empty catch blocks fall into three categories:

**Category A — Already handled (skip):** Catches with `validationFailures++` counters or documented fallback behavior (e.g., `return null`). These are correct. Examples: `compute-dews.ts:369,453` (have counters), `yield-sync/cache.ts:245,354` (documented fallbacks).

**Category B — Progressive parsing (skip):** The triple-nested catch in `daily-digest/response.ts:42-58` is a well-designed progressive JSON extractor for LLM output. Leave as-is.

**Category C — Silent network/DB catches (fix):** Catches on fetch, database, or external service calls that produce zero observability.

- [ ] **Step 1: Inventory empty catches**

Run grep to find all empty catch blocks:

```bash
cd worker && grep -rn 'catch\s*{' src/cron/ --include='*.ts' | grep -v test | grep -v '__tests__'
```

Categorize each as A (has counter/documented fallback), B (progressive parsing), or C (needs console.warn).

- [ ] **Step 2: Add console.warn to Category C catches**

For each Category C catch, add a `console.warn` with the source context. Pattern:

```ts
// OLD:
} catch {
  continue;
}
// NEW:
} catch (err) {
  console.warn(`[${JOB_NAME}] ${CONTEXT}: ${err instanceof Error ? err.message : String(err)}`);
  continue;
}
```

Where `JOB_NAME` is the cron job name and `CONTEXT` describes the operation.

- [ ] **Step 3: Verify**

Run: `cd worker && npx tsc --noEmit && cd .. && npm test -- --run worker/`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/
git commit -m "refactor: add observability to silent catch blocks in cron pipelines [Q1]"
```

---

### Task 16: Add SQL interpolation safety CI check [S3]

**Depends on:** Task 5 (Q7 safety comment) and Task 13 (Q5 allowlist) must complete first — the check script expects all interpolation sites to have SAFETY comments or allowlist validation.

**Files:**
- Create: `scripts/check-sql-interpolation-safety.mjs`
- Modify: `package.json` (add `check:sql-safety` script)
- Modify: `scripts/test-merge-gate.mjs` (add to `COMMON_VALIDATE_PREBUILD_COMMANDS`)

- [ ] **Step 1: Write the check script**

Create `scripts/check-sql-interpolation-safety.mjs`:

```js
#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const WORKER_SRC = "worker/src";
const INTERPOLATION_PATTERN = /`[^`]*(?:FROM|INTO|UPDATE|DELETE\s+FROM|JOIN)\s+\$\{/;
const SAFETY_PATTERN = /(?:\/\/\s*SAFETY:|\.has\(|throw\s+new\s+Error)/;

function collectTsFiles(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "__tests__" || entry === "__mocks__" || entry === "node_modules") continue;
      collectTsFiles(full, files);
    } else if (stat.isFile() && (extname(full) === ".ts" || extname(full) === ".tsx")) {
      files.push(full);
    }
  }
  return files;
}

const files = collectTsFiles(WORKER_SRC);
const violations = [];

for (const file of files) {
  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (INTERPOLATION_PATTERN.test(lines[i])) {
      // Check surrounding 5 lines for safety evidence
      const context = lines.slice(Math.max(0, i - 5), i + 1).join("\n");
      if (!SAFETY_PATTERN.test(context)) {
        violations.push({ file, line: i + 1, text: lines[i].trim() });
      }
    }
  }
}

if (violations.length > 0) {
  process.stderr.write("SQL interpolation sites missing allowlist validation or SAFETY comment:\n\n");
  for (const v of violations) {
    process.stderr.write(`  ${v.file}:${v.line}: ${v.text}\n`);
  }
  process.stderr.write(`\n${violations.length} violation(s) found.\n`);
  process.stderr.write("Fix: add allowlist Set + .has() validation, or a // SAFETY: comment.\n");
  process.exit(1);
}
process.stdout.write("SQL interpolation safety: OK\n");
```

- [ ] **Step 2: Register in package.json**

Add to scripts:

```json
"check:sql-safety": "node scripts/check-sql-interpolation-safety.mjs",
```

- [ ] **Step 3: Add to merge gate**

In `scripts/test-merge-gate.mjs`, add to `COMMON_VALIDATE_PREBUILD_COMMANDS` array:

```js
"npm run check:sql-safety",
```

- [ ] **Step 4: Update CI parity**

Run `npm test -- --run scripts/__tests__/validate-ci-parity` to check if the parity test needs updating. If it fails, update the CI workflow to include the new check.

- [ ] **Step 5: Verify**

Run: `npm run check:sql-safety`
Expected: OK (all existing sites should now have SAFETY comments or allowlist checks from Tasks 5 and 13)

- [ ] **Step 6: Commit**

```bash
git add scripts/check-sql-interpolation-safety.mjs package.json scripts/test-merge-gate.mjs
git commit -m "feat: add CI check for SQL interpolation safety enforcement [S3]"
```

---

### Task 17: Add stablecoin data validation script [S6]

**Files:**
- Create: `scripts/check-stablecoin-data.ts`
- Modify: `package.json` (add `check:stablecoin-data` script)
- Modify: `scripts/test-merge-gate.mjs`

Note: Uses `.ts` + `tsx` runner, following the project's existing pattern for TypeScript check scripts (`check:cron-sync`, `check:redemption-backstops`).

- [ ] **Step 1: Write the validation script**

Create `scripts/check-stablecoin-data.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  StablecoinMetaAssetArraySchema,
  CanonicalOrderAssetSchema,
} from "../shared/lib/stablecoins/schema";

const DATA_DIR = "shared/data/stablecoins";

interface DataFile {
  file: string;
  schema: z.ZodType;
  label: string;
}

const DATA_FILES: DataFile[] = [
  { file: "usd-major.json", schema: StablecoinMetaAssetArraySchema, label: "USD major" },
  { file: "usd-minor.json", schema: StablecoinMetaAssetArraySchema, label: "USD minor" },
  { file: "non-usd.json", schema: StablecoinMetaAssetArraySchema, label: "non-USD" },
  { file: "commodity.json", schema: StablecoinMetaAssetArraySchema, label: "commodity" },
  { file: "canonical-order.json", schema: CanonicalOrderAssetSchema, label: "canonical order" },
];

let errorCount = 0;

for (const { file, schema, label } of DATA_FILES) {
  const path = join(DATA_DIR, file);
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    // Validate per-entry for array schemas to get granular error reporting
    if (Array.isArray(parsed)) {
      const result = schema.safeParse(parsed);
      if (result.success) {
        process.stdout.write(`${path}: ${parsed.length} entries OK\n`);
      } else {
        for (const issue of result.error.issues) {
          const pathStr = issue.path.length > 0 ? `[${issue.path.join(".")}]` : "";
          const entry =
            issue.path.length > 0 && typeof issue.path[0] === "number"
              ? parsed[issue.path[0]]
              : undefined;
          const id =
            typeof entry === "object" && entry !== null && "id" in entry
              ? (entry as { id: string }).id
              : "";
          process.stderr.write(`${path}${pathStr} (${id}): ${issue.message}\n`);
          errorCount++;
        }
      }
    } else {
      process.stderr.write(`${path}: expected array, got ${typeof parsed}\n`);
      errorCount++;
    }
  } catch (err) {
    process.stderr.write(`${path}: ${err instanceof Error ? err.message : String(err)}\n`);
    errorCount++;
  }
}

if (errorCount > 0) {
  process.stderr.write(`\n${errorCount} error(s) found in stablecoin data files.\n`);
  process.exit(1);
}
process.stdout.write("Stablecoin data validation: OK\n");
```

- [ ] **Step 2: Register and wire into merge gate**

Add to `package.json` scripts:
```json
"check:stablecoin-data": "tsx scripts/check-stablecoin-data.ts",
```

Add to `COMMON_VALIDATE_PREBUILD_COMMANDS` in `scripts/test-merge-gate.mjs`:
```js
"npm run check:stablecoin-data",
```

- [ ] **Step 3: Verify the schemas are exported**

The script imports `StablecoinMetaAssetArraySchema` and `CanonicalOrderAssetSchema` from `shared/lib/stablecoins/schema.ts`. Verify these are in the `EXPORT_ALLOWLIST` in `check-unused-code.mjs` (they already are — lines 38-41).

- [ ] **Step 4: Update CI parity if needed**

Run `npm test -- --run scripts/__tests__/validate-ci-parity` and fix if needed.

- [ ] **Step 5: Verify**

Run: `npm run check:stablecoin-data`
Expected: all files OK

- [ ] **Step 6: Commit**

```bash
git add scripts/check-stablecoin-data.ts package.json scripts/test-merge-gate.mjs
git commit -m "feat: add pre-build stablecoin data validation with per-entry Zod errors [S6]"
```

---

### Task 18: Add allowlist audit mode to unused-code check [S4]

**Files:**
- Modify: `scripts/check-unused-code.mjs`

- [ ] **Step 1: Add audit function**

At the end of `scripts/check-unused-code.mjs`, add:

```js
function auditAllowlists(allExports) {
  const exportKeys = new Set(allExports.map((e) => `${e.file}::${e.name}`));
  const staleEntries = [];
  for (const entry of EXPORT_ALLOWLIST) {
    const [file] = entry.split("::");
    try {
      statSync(file);
    } catch {
      staleEntries.push({ entry, reason: "file does not exist" });
      continue;
    }
    if (!exportKeys.has(entry)) {
      staleEntries.push({ entry, reason: "export no longer exists" });
    }
  }
  for (const mod of MODULE_ALLOWLIST) {
    try {
      statSync(mod);
    } catch {
      staleEntries.push({ entry: mod, reason: "module does not exist" });
    }
  }
  return staleEntries;
}
```

Add CLI flag handling near the bottom, before the final exit:

```js
if (process.argv.includes("--audit-allowlist")) {
  const stale = auditAllowlists(allExports);
  if (stale.length > 0) {
    process.stderr.write("\nStale allowlist entries:\n");
    for (const s of stale) {
      process.stderr.write(`  ${s.entry} — ${s.reason}\n`);
    }
    process.stderr.write(`\n${stale.length} stale entry/entries.\n`);
    process.exit(1);
  }
  process.stdout.write("Allowlist audit: all entries valid.\n");
}
```

- [ ] **Step 2: Verify**

Run: `node scripts/check-unused-code.mjs --audit-allowlist`
Expected: either all valid, or surfaces genuinely stale entries

- [ ] **Step 3: Commit**

```bash
git add scripts/check-unused-code.mjs
git commit -m "feat: add --audit-allowlist flag to check:unused-code for periodic review [S4]"
```

---

### Task 19: Phase 2 validation

- [ ] **Step 1: Run the merge gate**

```bash
npm run test:merge-gate
```

Expected: all checks pass.

---

## Phase 3 — Structural Improvements

These tasks involve larger refactoring. Each should be executed as a standalone branch/PR.

### Task 20: Decompose dispatch-telegram-alerts.ts [Q3]

**Files:**
- Create directory: `worker/src/cron/telegram-alerts/`
- Create: `worker/src/cron/telegram-alerts/detect-dews.ts`
- Create: `worker/src/cron/telegram-alerts/detect-depegs.ts`
- Create: `worker/src/cron/telegram-alerts/detect-safety.ts`
- Create: `worker/src/cron/telegram-alerts/detect-launches.ts`
- Create: `worker/src/cron/telegram-alerts/subscriber-resolution.ts`
- Create: `worker/src/cron/telegram-alerts/batch-delivery.ts`
- Modify: `worker/src/cron/dispatch-telegram-alerts.ts` (reduce to orchestrator importing sub-modules)

**Approach:** Follow the existing `sync-stablecoins/` decomposition pattern. The main file becomes an orchestrator that imports detection, resolution, and delivery functions from sub-modules. Each alert type's detection logic moves to its own file. Subscriber loading and batch sending become shared utilities.

- [ ] **Step 1:** Read the full file to map logical boundaries
- [ ] **Step 2:** Extract per-alert-type detection into `detect-*.ts` files
- [ ] **Step 3:** Extract subscriber loading into `subscriber-resolution.ts`
- [ ] **Step 4:** Extract batch delivery into `batch-delivery.ts`
- [ ] **Step 5:** Reduce main file to orchestrator
- [ ] **Step 6:** Run `cd worker && npx tsc --noEmit && cd .. && npm test -- --run worker/src/cron/__tests__/dispatch-telegram`
- [ ] **Step 7:** Commit

---

### Task 21: Extract frontend component logic + tests [Q8]

**Files:**
- Create: `src/components/kpi-bar-logic.ts` (5 useMemo extractions)
- Create: `src/components/dex-liquidity-card-logic.ts` (1 useMemo extraction)
- Create: `src/components/yield-detail-section-logic.ts` (useMemo extractions)
- Create: `src/components/__tests__/kpi-bar-logic.test.ts`
- Create: `src/components/__tests__/dex-liquidity-card-logic.test.ts`
- Create: `src/components/__tests__/yield-detail-section-logic.test.ts`
- Modify: corresponding component files to import from `-logic.ts`

**Approach:** Follow existing pattern (`stablecoin-table-logic.ts`, `flow-table-logic.ts`). Each `useMemo` callback with business logic becomes a named exported function in the companion `-logic.ts` file. The component calls the function inside `useMemo`. Tests exercise the pure functions directly.

- [ ] **Step 1:** Read each component fully, identify extractable useMemo logic
- [ ] **Step 2:** Write `-logic.ts` files with pure functions
- [ ] **Step 3:** Write tests for the pure functions
- [ ] **Step 4:** Update components to import from `-logic.ts`
- [ ] **Step 5:** Run `npm run build && npm test -- --run src/components/__tests__/`
- [ ] **Step 6:** Commit

---

### Task 22: Extract contagion-graph hooks [Q9]

**Files:**
- Create: `src/hooks/use-pan-zoom.ts`
- Create: `src/hooks/use-graph-selection.ts`
- Modify: `src/components/contagion-graph.tsx`

**Approach:** Extract pan/zoom interaction state and event handlers into `usePanZoom`. Extract hover/selection state into `useGraphSelection`. The component becomes rendering + hook composition.

- [ ] **Step 1:** Read contagion-graph.tsx fully, identify state boundaries
- [ ] **Step 2:** Write `usePanZoom` hook
- [ ] **Step 3:** Write `useGraphSelection` hook
- [ ] **Step 4:** Refactor component to use hooks
- [ ] **Step 5:** Run `npm run build` to verify the refactored component compiles. Note: `contagion-graph` may not have existing tests — if not, add basic smoke tests for the extracted hooks.
- [ ] **Step 6:** Commit

---

### Task 23: Split large test files [S5]

**Files:**
- Split: `worker/src/cron/__tests__/enrich-prices.test.ts` (1633 lines, 17 describe blocks)
  - → `worker/src/cron/__tests__/enrich-prices/price-bounds.test.ts`
  - → `worker/src/cron/__tests__/enrich-prices/is-reasonable-price.test.ts`
  - → `worker/src/cron/__tests__/enrich-prices/enrich-missing.test.ts`
  - → `worker/src/cron/__tests__/enrich-prices/fetch-primary.test.ts`
  - → `worker/src/cron/__tests__/enrich-prices/apply-resolved.test.ts`
  - → `worker/src/cron/__tests__/enrich-prices/pool-challenge.test.ts`
- Split: `worker/src/cron/__tests__/sync-stablecoins.test.ts` (1992 lines, 2 describes)
  - → `worker/src/cron/__tests__/sync-stablecoins/sync-stablecoins.test.ts`
  - → `worker/src/cron/__tests__/sync-stablecoins/stamp-price-metadata.test.ts`
- Split: `worker/src/cron/__tests__/sync-yield-data.test.ts` (3026 lines, 1 describe)
  - → Split by `it`-block functional groups within the single describe (e.g., source resolution, history writing, incremental sync, cache management, error handling). Read the file to identify natural boundaries at `it("...` clusters.

**Approach:** Move each top-level describe block to its own file. Shared mocks and helpers go in a `helpers.ts` file within the subdirectory.

- [ ] **Step 1:** Create subdirectories
- [ ] **Step 2:** Extract describe blocks with their imports and mock setup
- [ ] **Step 3:** Create shared mock helpers
- [ ] **Step 4:** Delete original monolithic files
- [ ] **Step 5:** Run `npm test -- --run worker/src/cron/__tests__/`
- [ ] **Step 6:** Commit

---

### Task 24: Evaluate and consolidate worker time-constants [R7]

**Decision point:** The `SECONDS` convenience object in `worker/src/lib/time-constants.ts` has 59 consumer files. Removing it would touch many imports. Evaluate whether the DX benefit justifies the indirection.

**Recommended action:** Skip unless the team consensus is that the `SECONDS.X` pattern adds confusion. The indirection cost is minimal for 22 lines.

---

## Phase 4 — Strategic

### Task 25: CI/CD rollback mechanism [S7]

**Scope:** `.github/workflows/deploy-cloudflare.yml`

**Implementation sketch:**
1. After worker deploy, add a post-deploy health check job that hits the `/api/health` endpoint
2. If the health check fails, run `wrangler rollback` to revert to previous version
3. Add a deployment history artifact that records version IDs
4. For D1: start writing reversible migration pairs (`NNNN-up.sql` + `NNNN-down.sql`)

This is a strategic improvement best addressed when the project scales to multiple contributors or when a deployment incident makes the ROI clear.

---

### Task 26: Durable rate-limit prune state [S2]

**Scope:** `worker/src/lib/rate-limit.ts`

**Implementation sketch:** Replace the 5 module-scoped `let` variables (lines 16-20) with a D1-backed state row. This makes prune deduplication work across V8 isolate recycling under horizontal scaling.

**Recommended action:** Defer until request volume demonstrates that isolate-local prune tracking is insufficient. The current code falls through gracefully.

---

## Validation Checklist

After all tasks in a phase are complete:

- [ ] `npm run test:merge-gate` passes
- [ ] `npm run build` produces clean output
- [ ] `cd worker && npx tsc --noEmit` passes
- [ ] `npm test` passes with no regressions
- [ ] No new ESLint warnings introduced
