# Structural Simplification & Remediation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate all 35 actionable findings from the 2026-03-13 comprehensive codebase audit across redundancy, code quality, and sustainability pillars.

**Architecture:** Changes are organized into three phases of increasing effort. Phase 1 (quick wins) creates shared utilities and removes duplication in isolated, independent tasks. Phase 2 (targeted refactoring) consolidates time constants, formatters, and the router/auth API. Phase 3 (structural improvements) decomposes large orchestrator files and adds type safety at external boundaries.

**Tech Stack:** TypeScript, Vitest, shared/lib runtime-neutral modules, Cloudflare Worker

**Source audit:** `agents/plans/2026-03-13-comprehensive-codebase-audit.md`

---

## Chunk 1: Phase 1 — Quick Wins

### Task 1: Extract shared `clamp()` utility (R-001)

**Files:**
- Create: `shared/lib/math.ts`
- Create: `shared/lib/__tests__/math.test.ts`
- Modify: `shared/lib/mint-burn-signals.ts:40-42` (remove local `clamp`, import from math)
- Modify: `src/lib/flow-intensity.ts:1-3` (remove local `clamp`, import from math)
- Modify: `worker/src/lib/dews.ts:125-129` (remove local `clamp`, import from math)

- [ ] **Step 1: Write the test for `clamp()`**

```typescript
// shared/lib/__tests__/math.test.ts
import { describe, it, expect } from "vitest";
import { clamp } from "../math";

describe("clamp", () => {
  it("returns value when within range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
  it("returns min when value is below range", () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });
  it("returns max when value is above range", () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });
  it("returns min for NaN", () => {
    expect(clamp(NaN, 0, 100)).toBe(0);
  });
  it("returns max for Infinity", () => {
    expect(clamp(Infinity, 0, 100)).toBe(100);
  });
  it("returns min for -Infinity", () => {
    expect(clamp(-Infinity, 0, 100)).toBe(0);
  });
  it("handles min === max", () => {
    expect(clamp(5, 3, 3)).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- shared/lib/__tests__/math.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create `shared/lib/math.ts`**

```typescript
// shared/lib/math.ts
/** Clamp a number to [min, max]. NaN → min, ±Infinity → nearest bound. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return value !== value ? min : value > 0 ? max : min; // NaN→min, Inf→max, -Inf→min
  }
  return Math.max(min, Math.min(max, value));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- shared/lib/__tests__/math.test.ts`
Expected: PASS

- [ ] **Step 5: Replace local `clamp` in `shared/lib/mint-burn-signals.ts`**

Remove lines 40-42 (the local `clamp` function). Add import at top:
```typescript
import { clamp } from "./math";
```

- [ ] **Step 6: Replace local `clamp` in `src/lib/flow-intensity.ts`**

Remove lines 1-3 (the local `clamp` function). Add import at top:
```typescript
import { clamp } from "@shared/lib/math";
```

- [ ] **Step 7: Replace local `clamp` in `worker/src/lib/dews.ts`**

Remove the exported `clamp` function at lines 125-129. Add import at top:
```typescript
import { clamp } from "@shared/lib/math";
```
Note: dews.ts `clamp` has swapped parameter order `(min, max, val)`. All call sites within dews.ts must be updated from `clamp(min, max, val)` to `clamp(val, min, max)`. Search for `clamp(` in dews.ts and swap the arguments.

- [ ] **Step 8: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 9: Commit**

```bash
git add shared/lib/math.ts shared/lib/__tests__/math.test.ts shared/lib/mint-burn-signals.ts src/lib/flow-intensity.ts worker/src/lib/dews.ts
git commit -m "refactor: extract shared clamp() utility (R-001)"
```

---

### Task 2: Add `formatPercent` and `formatSignedPercent` helpers (R-005)

**Files:**
- Modify: `shared/lib/format.ts` (add two functions)
- Modify: `shared/lib/__tests__/format.test.ts` (add tests)

- [ ] **Step 1: Write the tests**

Add to `shared/lib/__tests__/format.test.ts`:
```typescript
describe("formatPercent", () => {
  it("formats positive value", () => {
    expect(formatPercent(12.345)).toBe("12.35%");
  });
  it("formats zero", () => {
    expect(formatPercent(0)).toBe("0.00%");
  });
  it("formats negative value", () => {
    expect(formatPercent(-5.1)).toBe("-5.10%");
  });
  it("respects custom decimals", () => {
    expect(formatPercent(12.345, 1)).toBe("12.3%");
  });
  it("returns dash for nullish", () => {
    expect(formatPercent(null)).toBe("-");
    expect(formatPercent(undefined)).toBe("-");
  });
});

describe("formatSignedPercent", () => {
  it("adds + prefix for positive", () => {
    expect(formatSignedPercent(5.5)).toBe("+5.50%");
  });
  it("keeps - prefix for negative", () => {
    expect(formatSignedPercent(-3.2)).toBe("-3.20%");
  });
  it("formats zero without sign", () => {
    expect(formatSignedPercent(0)).toBe("0.00%");
  });
  it("returns dash for nullish", () => {
    expect(formatSignedPercent(null)).toBe("-");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- shared/lib/__tests__/format.test.ts`
Expected: FAIL — functions not defined

- [ ] **Step 3: Implement in `shared/lib/format.ts`**

Add at end of file:
```typescript
/** Format a percentage to fixed decimals with % suffix. Returns "-" for nullish. */
export function formatPercent(value: number | null | undefined, decimals = 2): string {
  return value != null ? `${value.toFixed(decimals)}%` : "-";
}

/** Format a signed percentage with +/- prefix and % suffix. Returns "-" for nullish. */
export function formatSignedPercent(value: number | null | undefined, decimals = 2): string {
  if (value == null) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(decimals)}%`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- shared/lib/__tests__/format.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add shared/lib/format.ts shared/lib/__tests__/format.test.ts
git commit -m "feat: add formatPercent/formatSignedPercent helpers (R-005)"
```

Note: Sweeping inline `toFixed(2) + "%"` usages across 15+ components is deferred to Phase 2, Task 12 where it is batched with other formatting sweeps.

---

### Task 3: Add `nullOn404` option to `apiFetch` (R-007)

**Files:**
- Modify: `src/lib/api.ts:114-140,212-227`
- Modify: `src/lib/__tests__/api-fetch-contracts.test.ts` (add test for nullOn404)

**IMPORTANT — return type safety:** The implementation uses function overloads so that existing callers (without `nullOn404`) still get `Promise<T>`, not `Promise<T | null>`. Only callers passing `{ nullOn404: true }` get `Promise<T | null>`.

- [ ] **Step 1: Write test for `nullOn404` behavior**

Add to existing test file `src/lib/__tests__/api-fetch-contracts.test.ts`:
```typescript
it("returns null for 404 when nullOn404 is true", async () => {
  // Mock fetch to return 404
  globalThis.fetch = vi.fn().mockResolvedValue(new Response("Not found", { status: 404 }));
  const result = await apiFetch("/api/stablecoin-reserves/test", undefined, undefined, undefined, { nullOn404: true });
  expect(result).toBeNull();
});

it("still throws on 404 when nullOn404 is not set", async () => {
  globalThis.fetch = vi.fn().mockResolvedValue(new Response("Not found", { status: 404 }));
  await expect(apiFetch("/api/stablecoin-reserves/test")).rejects.toThrow(ApiFetchError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/__tests__/api-fetch-contracts.test.ts`
Expected: FAIL — TypeScript rejects the 5th argument at compile time ("Expected 1-4 arguments, got 5"). If using esbuild/vitest (no type-checking), the test runs but the 5th arg is ignored and `apiFetch` throws `ApiFetchError` instead of returning null.

- [ ] **Step 3: Add `nullOn404` option to `apiFetch` with overloads**

In `src/lib/api.ts`, add the options interface and function overloads to preserve backward compatibility:
```typescript
export interface ApiFetchOptions {
  nullOn404?: boolean;
}

// Overload: without nullOn404 → returns T (preserves existing call sites)
export async function apiFetch<T>(
  path: string,
  schema?: ZodType<T>,
  init?: RequestInit,
  contractMode?: ApiContractMode,
): Promise<T>;
// Overload: with nullOn404 → returns T | null
export async function apiFetch<T>(
  path: string,
  schema: ZodType<T> | undefined,
  init: RequestInit | undefined,
  contractMode: ApiContractMode | undefined,
  options: ApiFetchOptions & { nullOn404: true },
): Promise<T | null>;
// Implementation signature
export async function apiFetch<T>(
  path: string,
  schema?: ZodType<T>,
  init?: RequestInit,
  contractMode?: ApiContractMode,
  options?: ApiFetchOptions,
): Promise<T | null> {
  const res = await apiRequest(path, init);
  if (!res.ok) {
    if (options?.nullOn404 && res.status === 404) return null;
    throw await buildFetchError(path, res);
  }
  // ... rest of existing implementation unchanged (json parse, schema validation)
```

- [ ] **Step 4: Replace `fetchStablecoinReserves` with `apiFetch` call**

Replace lines 212-227:
```typescript
export async function fetchStablecoinReserves(stablecoinId: string): Promise<import("@shared/types").StablecoinReservesResponse | null> {
  return apiFetch<import("@shared/types").StablecoinReservesResponse>(
    API_PATHS.stablecoinReserves(stablecoinId),
    undefined,
    undefined,
    undefined,
    { nullOn404: true },
  );
}
```

- [ ] **Step 5: Run tests**

Run: `npm test -- src/lib/__tests__/api-fetch-contracts.test.ts`
Expected: PASS

- [ ] **Step 6: Run build to check types**

Run: `npm run build`
Expected: Build succeeds — all existing `apiFetch` callers still see `Promise<T>` thanks to overloads

- [ ] **Step 7: Commit**

```bash
git add src/lib/api.ts src/lib/__tests__/api-fetch-contracts.test.ts
git commit -m "refactor: add nullOn404 to apiFetch, remove fetchStablecoinReserves duplication (R-007)"
```

---

### Task 4: Move `CRON_INTERVALS` to shared (R-009)

**Files:**
- Modify: `shared/lib/cron-jobs.ts` (add `CRON_INTERVALS` export)
- Modify: `worker/src/lib/cron-schedule.ts` (remove `CRON_INTERVALS`, re-export from shared)

- [ ] **Step 1: Add `CRON_INTERVALS` to `shared/lib/cron-jobs.ts`**

After the `CRON_JOB_DEFINITIONS` export, add:
```typescript
/** Job name → expected interval in seconds, derived from definitions. */
export const CRON_INTERVALS = Object.freeze(
  Object.fromEntries(CRON_JOB_DEFINITIONS.map((item) => [item.job, item.intervalSec])) as Record<string, number>,
);
```

- [ ] **Step 2: Simplify `worker/src/lib/cron-schedule.ts`**

Replace entire file with:
```typescript
export { CRON_SCHEDULES, CRON_INTERVALS } from "@shared/lib/cron-jobs";
export type { CronScheduleExpression } from "@shared/lib/cron-jobs";
```

- [ ] **Step 3: Verify no consumer imports `CronScheduleExpression` from the worker file**

Run: `grep -r "from.*cron-schedule" worker/src/ --include="*.ts" | grep -v "__tests__"`
Expected: Any imports should still resolve since we re-export.

- [ ] **Step 4: Run tests + type-check**

Run: `npm test && cd worker && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add shared/lib/cron-jobs.ts worker/src/lib/cron-schedule.ts
git commit -m "refactor: move CRON_INTERVALS to shared, eliminate worker re-derivation (R-009)"
```

---

### Task 5: Derive `PRESSURE_VALUE_CLASS` from `flow-signal-ui` (R-011)

**Files:**
- Modify: `src/components/flow-table-logic.ts:23-28`
- Modify: `src/lib/flow-signal-ui.ts` (no changes needed — it's the source of truth)

- [ ] **Step 1: Replace `PRESSURE_VALUE_CLASS` derivation**

In `src/components/flow-table-logic.ts`, remove the hardcoded `PRESSURE_VALUE_CLASS` object (lines 23-28) and replace with:

```typescript
import { getFlowPressureUi } from "@/lib/flow-signal-ui";
import { PRESSURE_SHIFT_STATE_VALUES, type PressureShiftState } from "@shared/lib/mint-burn-signals";

export const PRESSURE_VALUE_CLASS: Record<PressureShiftState, string> = Object.fromEntries(
  PRESSURE_SHIFT_STATE_VALUES.map((s) => [s, getFlowPressureUi(s, "summary").valueClass]),
) as Record<PressureShiftState, string>;
```

- [ ] **Step 2: Verify `getFlowPressureUi` is exported**

Run: `grep "export function getFlowPressureUi" src/lib/flow-signal-ui.ts`
Expected: Match found

- [ ] **Step 3: Run build + tests**

Run: `npm run build && npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/components/flow-table-logic.ts
git commit -m "refactor: derive PRESSURE_VALUE_CLASS from flow-signal-ui (R-011)"
```

---

### Task 6: Reformat `coin()` factory to multi-line (Q-017)

**Files:**
- Modify: `shared/lib/stablecoins.ts:37` (reformat return statement)

- [ ] **Step 1: Reformat the `coin()` return statement**

Read the current `coin()` function and reformat its return statement from a single line to a multi-line object literal. Each field on its own line. Do not change any logic — purely formatting.

- [ ] **Step 2: Run tests to verify no behavioral change**

Run: `npm test -- shared/lib/__tests__/stablecoins.test.ts`
Expected: PASS

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add shared/lib/stablecoins.ts
git commit -m "style: reformat coin() factory to multi-line return (Q-017)"
```

---

### Task 7: Extract `compareNullable()` helper (R-010)

**Files:**
- Create: `src/lib/sort-utils.ts`
- Create: `src/lib/__tests__/sort-utils.test.ts`
- Modify: `src/components/stablecoin-table-logic.ts` (use helper)
- Modify: `src/components/flow-table-logic.ts` (use helper)

- [ ] **Step 1: Write the test**

```typescript
// src/lib/__tests__/sort-utils.test.ts
import { describe, it, expect } from "vitest";
import { compareNullable } from "../sort-utils";

describe("compareNullable", () => {
  it("returns 0 when both null", () => {
    expect(compareNullable(null, null)).toBe(0);
  });
  it("sorts null after non-null (returns 1 when a is null)", () => {
    expect(compareNullable(null, 5)).toBe(1);
  });
  it("sorts non-null before null (returns -1 when b is null)", () => {
    expect(compareNullable(5, null)).toBe(-1);
  });
  it("returns null when both are non-null (caller should compare)", () => {
    expect(compareNullable(5, 10)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/__tests__/sort-utils.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

```typescript
// src/lib/sort-utils.ts
/**
 * Handle nullable values in sort comparators.
 * Returns a definitive sort order (0, 1, or -1) when nulls are involved,
 * or null when both values are non-null (caller should do numeric comparison).
 */
export function compareNullable(
  a: number | null | undefined,
  b: number | null | undefined,
): number | null {
  const aNull = a == null;
  const bNull = b == null;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/__tests__/sort-utils.test.ts`
Expected: PASS

Note: `depeg-table-logic.ts` is mentioned in the R-010 audit finding but uses `?? fallback` inline defaults instead of the explicit null-guard pattern. It does **not** need modification for this task.

- [ ] **Step 5: Replace null-guard patterns in `stablecoin-table-logic.ts`**

Find each occurrence of the pattern:
```typescript
if (a === null && b === null) return 0;
if (a === null) return 1;
if (b === null) return -1;
```
Replace with:
```typescript
const nc = compareNullable(a, b);
if (nc !== null) return nc;
```
Add import: `import { compareNullable } from "@/lib/sort-utils";`

- [ ] **Step 6: Replace null-guard patterns in `flow-table-logic.ts`**

Same replacement pattern. Add import.

- [ ] **Step 7: Run tests + build**

Run: `npm test && npm run build`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/lib/sort-utils.ts src/lib/__tests__/sort-utils.test.ts src/components/stablecoin-table-logic.ts src/components/flow-table-logic.ts
git commit -m "refactor: extract compareNullable() for table sort helpers (R-010)"
```

---

### Task 8: Eliminate `strict-contract-paths.ts` (R-006)

**Files:**
- Modify: `shared/lib/api-endpoints.ts` (add pre-computed export)
- Delete: `shared/lib/strict-contract-paths.ts`
- Modify: `src/lib/api.ts:3` (update import)
- Modify: `src/lib/__tests__/api-endpoints.test.ts:9` (update import)
- Modify: `worker/src/api/__tests__/router-contract.test.ts:3` (update import)
- Modify: `scripts/smoke-api.mjs:6` (update dynamic import path)
- Modify: `docs/scripts.md`, `docs/architecture.md`, `docs/testing.md` (update file references)

- [ ] **Step 1: Add pre-computed list to `api-endpoints.ts`**

At the bottom of `shared/lib/api-endpoints.ts`, add:
```typescript
/** Pre-computed strict contract paths (module-load-time). */
export const STRICT_CONTRACT_PATHS_LIST = getStrictContractPaths();
```

- [ ] **Step 2: Update all 3 consumers to import from `api-endpoints` directly**

In each file, change:
```typescript
import { STRICT_CONTRACT_PATHS_LIST } from "@shared/lib/strict-contract-paths";
```
to:
```typescript
import { STRICT_CONTRACT_PATHS_LIST } from "@shared/lib/api-endpoints";
```

- [ ] **Step 3: Update `scripts/smoke-api.mjs`**

Change the dynamic import from:
```javascript
const strictContractModule = await import("../shared/lib/strict-contract-paths.ts");
```
to:
```javascript
const { STRICT_CONTRACT_PATHS_LIST } = await import("../shared/lib/api-endpoints.ts");
```

- [ ] **Step 4: Update documentation references**

In `docs/scripts.md`, `docs/architecture.md`, and `docs/testing.md`, replace references to `shared/lib/strict-contract-paths.ts` with `shared/lib/api-endpoints.ts`.

- [ ] **Step 5: Delete `shared/lib/strict-contract-paths.ts`**

```bash
rm shared/lib/strict-contract-paths.ts
```

- [ ] **Step 6: Run tests + build + smoke**

Run: `npm test && npm run build`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add shared/lib/api-endpoints.ts src/lib/api.ts src/lib/__tests__/api-endpoints.test.ts worker/src/api/__tests__/router-contract.test.ts scripts/smoke-api.mjs docs/scripts.md docs/architecture.md docs/testing.md
git rm shared/lib/strict-contract-paths.ts
git commit -m "refactor: eliminate strict-contract-paths.ts, export directly from api-endpoints (R-006)"
```

---

## Chunk 2: Phase 2 — Targeted Refactoring

### Task 9: Consolidate duration/age formatters (R-003)

**Files:**
- Modify: `shared/lib/format.ts` (add `formatElapsedSeconds`)
- Modify: `shared/lib/__tests__/format.test.ts` (add tests)
- Modify: `src/lib/data-health.ts:155-162` (use shared formatter)
- Modify: `src/components/status/format.ts:8-15` (use shared formatter)

- [ ] **Step 1: Write tests for `formatElapsedSeconds`**

```typescript
describe("formatElapsedSeconds", () => {
  it("formats seconds", () => {
    expect(formatElapsedSeconds(45)).toBe("45s");
  });
  it("formats minutes", () => {
    expect(formatElapsedSeconds(300)).toBe("5m");
  });
  it("formats hours and minutes", () => {
    expect(formatElapsedSeconds(5400)).toBe("1h 30m");
  });
  it("formats hours without extra minutes", () => {
    expect(formatElapsedSeconds(7200)).toBe("2h");
  });
  it("formats days", () => {
    expect(formatElapsedSeconds(172800)).toBe("2d");
  });
  it("returns unknown for null-ish", () => {
    expect(formatElapsedSeconds(0)).toBe("0s");
  });
});
```

- [ ] **Step 2: Implement `formatElapsedSeconds`**

Add to `shared/lib/format.ts`:
```typescript
/** Convert seconds to a compact human-readable duration: "45s", "5m", "1h 30m", "2d". */
export function formatElapsedSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.floor(seconds / 86400)}d`;
}
```

- [ ] **Step 3: Replace `formatHealthAge` in `src/lib/data-health.ts`**

**Intentional behavioral change:** The old `formatHealthAge` showed `"0m"` for durations under 60 seconds. The new `formatElapsedSeconds` shows the actual seconds (e.g. `"45s"`). This is an intentional improvement — showing `"0m"` for a 45-second-old data point was misleading. Status page operators benefit from sub-minute resolution.

```typescript
import { formatElapsedSeconds } from "@shared/lib/format";

export function formatHealthAge(ms: number | null): string {
  if (ms == null) return "unknown";
  return formatElapsedSeconds(ms / 1000);
}
```

- [ ] **Step 4: Replace `formatAge` in `src/components/status/format.ts`**

```typescript
import { formatElapsedSeconds } from "@shared/lib/format";

export function formatAge(seconds: number): string {
  return formatElapsedSeconds(seconds);
}
```

Note: Keep `formatAge` as a thin re-export to avoid changing all status component imports.

- [ ] **Step 5: Run tests + build**

Run: `npm test && npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add shared/lib/format.ts shared/lib/__tests__/format.test.ts src/lib/data-health.ts src/components/status/format.ts
git commit -m "refactor: consolidate duration formatters into shared formatElapsedSeconds (R-003)"
```

---

### Task 10: Unify time constants into shared (R-002, S-004)

**Files:**
- Create: `shared/lib/time-constants.ts`
- Modify: `src/lib/constants.ts` (import from shared, keep page-specific constants)
- Modify: `worker/src/lib/time-constants.ts` (import from shared, keep SECONDS alias)
- Remove local redefinition in `worker/src/cron/sync-yield-data.ts`

- [ ] **Step 1: Create `shared/lib/time-constants.ts`**

```typescript
// shared/lib/time-constants.ts
export const SECONDS_PER_MINUTE = 60;
export const MINUTES_PER_HOUR = 60;
export const HOURS_PER_DAY = 24;
export const MS_PER_SECOND = 1000;

export const HOUR_SECONDS = MINUTES_PER_HOUR * SECONDS_PER_MINUTE;
export const DAY_SECONDS = HOURS_PER_DAY * HOUR_SECONDS;
export const WEEK_SECONDS = 7 * DAY_SECONDS;
export const THIRTY_DAYS_SECONDS = 30 * DAY_SECONDS;

export const HOUR_MS = HOUR_SECONDS * MS_PER_SECOND;
export const DAY_MS = DAY_SECONDS * MS_PER_SECOND;
export const WEEK_MS = 7 * DAY_MS;
```

- [ ] **Step 2: Update `src/lib/constants.ts` to import from shared**

Replace the time constant definitions (lines 1-23) with imports. Preserve every currently-exported symbol to avoid breaking consumers:
```typescript
export {
  SECONDS_PER_MINUTE,
  HOUR_SECONDS,
  DAY_SECONDS,
  HOUR_MS,
  DAY_MS,
  WEEK_MS,
  THIRTY_DAYS_SECONDS,
} from "@shared/lib/time-constants";

// Derived constants unique to frontend (not worth sharing — no worker consumers)
import { DAY_MS as _DM, HOURS_PER_DAY } from "@shared/lib/time-constants";

export const DAY_HOURS = HOURS_PER_DAY;
export const WEEK_HOURS = 7 * DAY_HOURS;
export const THIRTY_DAYS_HOURS = 30 * DAY_HOURS;
export const NINETY_DAYS_HOURS = 90 * DAY_HOURS;
export const NINETY_DAYS_MS = 90 * _DM;
export const THREE_DAYS_MS = 3 * _DM;
export const YEAR_MS = 365.25 * _DM;
export const TABLE_PAGE_SIZE = 25;
```
Keep `CATEGORY_LINKS` unchanged.

**Verification:** Run `grep -rn "from.*@/lib/constants" src/ --include="*.ts" --include="*.tsx"` and confirm every imported symbol is still exported.

- [ ] **Step 3: Update `worker/src/lib/time-constants.ts` to import from shared**

```typescript
import {
  SECONDS_PER_MINUTE,
  HOUR_SECONDS,
  DAY_SECONDS,
  WEEK_SECONDS,
  THIRTY_DAYS_SECONDS,
} from "@shared/lib/time-constants";

/** Named durations in seconds — worker convenience alias. */
export const SECONDS = {
  ONE_MINUTE: SECONDS_PER_MINUTE,
  FIFTEEN_MINUTES: 15 * SECONDS_PER_MINUTE,
  THIRTY_MINUTES: 30 * SECONDS_PER_MINUTE,
  ONE_HOUR: HOUR_SECONDS,
  TWO_HOURS: 2 * HOUR_SECONDS,
  SIX_HOURS: 6 * HOUR_SECONDS,
  TWELVE_HOURS: 12 * HOUR_SECONDS,
  ONE_DAY: DAY_SECONDS,
  TWO_DAYS: 2 * DAY_SECONDS,
  ONE_WEEK: WEEK_SECONDS,
  THIRTY_DAYS: THIRTY_DAYS_SECONDS,
} as const;
```

- [ ] **Step 4: Remove local constant in `worker/src/cron/sync-yield-data.ts`**

Find `const THIRTY_DAYS_SECONDS = 30 * 86400;` and replace with:
```typescript
import { THIRTY_DAYS_SECONDS } from "@shared/lib/time-constants";
```

- [ ] **Step 5: Run all tests + type checks**

Run: `npm test && npm run build && cd worker && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add shared/lib/time-constants.ts src/lib/constants.ts worker/src/lib/time-constants.ts worker/src/cron/sync-yield-data.ts
git commit -m "refactor: unify time constants into shared/lib/time-constants (R-002, S-004)"
```

---

### Task 11: Refactor `route()` to accept `RouteContext` + simplify `withAdmin` (CC-001)

**Files:**
- Modify: `worker/src/router.ts` (accept RouteContext object)
- Modify: `worker/src/lib/auth.ts` (simplify withAdmin signature)
- Modify: `worker/src/route-registry.ts` (rename `ctx` → `execCtx`, remove `adminKey` field)
- Modify: `worker/src/handlers/http.ts` (pass RouteContext object to route())
- Modify (adminKey → trustedAdmin sweep — 12 handler files):
  - `worker/src/api/audit-depeg-history.ts`
  - `worker/src/api/backfill-stability-index.ts`
  - `worker/src/api/backfill-mint-burn.ts`
  - `worker/src/api/backfill-dews.ts`
  - `worker/src/api/backfill-mint-burn-prices.ts`
  - `worker/src/api/backfill-cg-prices.ts`
  - `worker/src/api/reclassify-atomic-roundtrips.ts`
  - `worker/src/api/backfill-supply-history.ts`
  - `worker/src/api/backfill-depegs.ts`
  - `worker/src/api/status.ts`
  - `worker/src/api/status-history.ts`
  - `worker/src/api/discovery.ts` (handleDiscoveryCandidates)
- Modify (test files referencing adminKey — 9 files):
  - `worker/src/api/__tests__/helpers/auth.ts`
  - `worker/src/api/__tests__/status.test.ts`
  - `worker/src/api/__tests__/status-history.test.ts`
  - `worker/src/api/__tests__/backfill-stability-index.test.ts`
  - `worker/src/api/__tests__/backfill-mint-burn.test.ts`
  - `worker/src/api/__tests__/backfill-supply-history.test.ts`
  - `worker/src/api/__tests__/backfill-cg-prices.test.ts`
  - `worker/src/api/__tests__/backfill-dews.test.ts`
  - `worker/src/api/__tests__/backfill-mint-burn-prices.test.ts`
  - `worker/src/api/__tests__/audit-depeg-history.test.ts`
  - `worker/src/api/__tests__/backfill-depegs.test.ts`

- [ ] **Step 1: Simplify `withAdmin` in `worker/src/lib/auth.ts`**

Remove `isTrustedAdminInput` and the confusing overloaded `withAdmin`. Replace with:
```typescript
export function hasValidAdminCredential(
  request: Request | undefined,
  trustedAdmin?: boolean,
): boolean {
  return trustedAdmin === true || hasOpsApiAccessSignal(request);
}

export async function requireAdmin(
  request: Request | undefined,
  trustedAdmin?: boolean,
): Promise<Response | null> {
  if (!hasValidAdminCredential(request, trustedAdmin)) {
    return errorResponse(401, "Unauthorized");
  }
  return null;
}

/** Executes the handler only when admin auth passes, otherwise returns 401. */
export async function withAdmin(
  request: Request | undefined,
  handler: () => Promise<Response>,
  trustedAdmin = false,
): Promise<Response> {
  const authError = await requireAdmin(request, trustedAdmin);
  if (authError) return authError;
  return handler();
}
```

- [ ] **Step 2: Rename `ctx` → `execCtx` in `RouteContext` to avoid `routeCtx.ctx` confusion**

In `worker/src/route-registry.ts`, rename the `ctx` field:
```typescript
export interface RouteContext {
  url: URL;
  db: D1Database;
  execCtx: ExecutionContext;  // renamed from `ctx` to avoid routeCtx.ctx confusion
  request?: Request;
  trustedAdmin?: boolean;     // adminKey removed — boolean only
  alchemyApiKey?: string | null;
  mintBurnFreshnessConfig?: MintBurnFreshnessConfig;
  feedbackEnv?: FeedbackEnv;
  anthropicApiKey?: string | null;
  twitterCreds?: TwitterCreds | null;
  telegramCreds?: TelegramCreds | null;
  telegramWebhookSecret?: string;
  telegramBotToken?: string;
}
```

Update all handler destructuring from `{ ctx, ... }` to `{ execCtx, ... }` in `STATIC_ROUTE_HANDLERS_BY_KEY`.

- [ ] **Step 3: Sweep adminKey → trustedAdmin in all 12 handler files**

For each handler file listed above:
1. Change parameter from `adminKey?: string` (or `adminSecret?: string` in `backfill-cg-prices.ts`, `backfill-depegs.ts`, `backfill-supply-history.ts`) to `trustedAdmin?: boolean`
2. Change internal `requireAdmin(request, adminKey)` to `requireAdmin(request, trustedAdmin)`
3. Change internal `withAdmin(request, adminKey, handler)` calls to `withAdmin(request, handler, trustedAdmin)` — **note the argument order change**: the new signature puts `handler` second and `trustedAdmin` third, whereas the old signature had `adminKey` second and `handler` third
4. Change internal `runIdempotentAdminAction(..., adminKey)` to `runIdempotentAdminAction(..., trustedAdmin)` (also update `runIdempotentAdminAction`'s signature in `worker/src/lib/idempotency.ts` if it accepts `adminKey`)

Also update `route-registry.ts` handler entries to destructure `trustedAdmin` instead of `adminKey` in ALL ~18 entries that reference it.

- [ ] **Step 4: Update test files**

For each test file listed above:
1. Replace `adminKey: "test-key"` with `trustedAdmin: true` in mock contexts
2. Update the auth test helper if it provides `adminKey`

- [ ] **Step 5: Refactor `route()` in `worker/src/router.ts`**

Replace the 13-parameter signature with:
```typescript
import type { RouteContext } from "./route-registry";

export function route(routeCtx: RouteContext): Promise<Response> | null {
  const path = routeCtx.url.pathname;
  const methodValidation = validateEndpointMethod(routeCtx.url, routeCtx.request?.method ?? "GET");
  if (methodValidation) {
    const resp = errorResponse(405, methodValidation.message);
    resp.headers.set("Allow", methodValidation.allowedMethods.join(", "));
    return Promise.resolve(resp);
  }

  const staticHandler = STATIC_ROUTE_HANDLERS.get(path);
  if (staticHandler) {
    return staticHandler(routeCtx).then((response) =>
      addAdminGetNoStoreHeader(path, routeCtx.request, response),
    );
  }

  // Dynamic routes use routeCtx.db and routeCtx.execCtx
  const summaryResult = matchDynamicRoute(path, /^\/api\/stablecoin-summary\/(.+)$/, (db, id) => handleStablecoinSummary(db, id), routeCtx.db, routeCtx.execCtx);
  if (summaryResult) return summaryResult;

  const reservesResult = matchDynamicRoute(path, /^\/api\/stablecoin-reserves\/(.+)$/, (db, id) => handleStablecoinReserves(db, id), routeCtx.db, routeCtx.execCtx);
  if (reservesResult) return reservesResult;

  const detailResult = matchDynamicRoute(path, /^\/api\/stablecoin\/(.+)$/, (db, id, execCtx) => handleStablecoinDetail(db, id, execCtx), routeCtx.db, routeCtx.execCtx);
  if (detailResult) return detailResult;

  const dismissMatch = path.match(/^\/api\/discovery-candidates\/(\d+)\/dismiss$/);
  if (dismissMatch && routeCtx.request?.method === "POST") {
    const candidateId = parseInt(dismissMatch[1], 10);
    return withAdmin(routeCtx.request, () => handleDismissCandidate(routeCtx.db, candidateId), routeCtx.trustedAdmin);
  }

  if (path.startsWith("/api/og/")) {
    return handleOg(routeCtx.db, path).then((r) => r ?? errorResponse(404, "Unknown OG route"));
  }

  return null;
}
```

- [ ] **Step 6: Update `handlers/http.ts` to construct and pass `RouteContext`**

Replace the 13-arg `route()` call (lines 128-142) with a single `RouteContext` object:
```typescript
const routeCtx: RouteContext = {
  url,
  db: env.DB,
  execCtx: ctx,          // ExecutionContext → renamed field
  request,
  trustedAdmin: isAdmin, // derived from hasValidAdminCredential(request) on line 101
  alchemyApiKey: env.ALCHEMY_API_KEY ?? null,
  mintBurnFreshnessConfig,
  feedbackEnv,
  anthropicApiKey: env.ANTHROPIC_API_KEY ?? null,
  twitterCreds,
  telegramCreds,
  telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
  telegramBotToken: env.TELEGRAM_BOT_TOKEN,
};
const response = await route(routeCtx);
```

**Note:** `trustedAdmin` is set to `isAdmin` (line 101: `hasValidAdminCredential(request)`). This is a deliberate behavioral improvement — currently the old code passes `undefined` for `adminKey` and `trustedAdmin` defaults to `false`, so all admin auth goes through `hasOpsApiAccessSignal` inside `requireAdmin`. With this change, the ops-api signal is resolved once at the HTTP layer and threaded through as `trustedAdmin: true`. The end result is equivalent (same auth check, just moved up).

- [ ] **Step 7: Run full test suite + type checks**

Run: `npm test && npm run build && cd worker && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add worker/src/router.ts worker/src/lib/auth.ts worker/src/route-registry.ts worker/src/handlers/http.ts worker/src/api/*.ts worker/src/api/__tests__/*.ts worker/src/api/__tests__/helpers/*.ts
git commit -m "refactor: route() accepts RouteContext, simplify withAdmin to 3-param (CC-001)"
```

---

### Task 12: Sweep inline date and percentage formatting (R-004, R-005 consumers)

**Files:**
- Modify: `shared/lib/format.ts` (add `"long"` and `"full"` date presets)
- Modify: 15+ components replacing inline `toLocaleDateString` and `toFixed(2) + "%"` calls

- [ ] **Step 1: Add date format presets**

Add to `ChartDateFormat` type and `formatChartDate` switch:
```typescript
type ChartDateFormat = "short" | "month-year" | "compact" | "with-time" | "long" | "full";

// In formatChartDate switch:
case "long":
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
case "full":
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
```

- [ ] **Step 2: Sweep inline `toLocaleDateString` in components**

Replace inline `new Date(...).toLocaleDateString(...)` with `formatChartDate()` presets. Known occurrences (search with `grep -rn "toLocaleDateString" src/components/ src/app/`):

- `src/components/digest-archive-client.tsx` — date column
- `src/components/daily-digest.tsx` — digest date header
- `src/components/usds-status-card.tsx` — last-checked date
- `src/components/methodology-version-card.tsx` — version date
- `src/components/stablecoin-detail/safety-score-history-section.tsx` — grade date
- `src/components/stablecoin-detail/overview-section.tsx` — launch date
- `src/app/stability-index/client.tsx` — PSI date
- `src/components/stablecoin-detail/depeg-history-section.tsx` — event dates
- `src/components/stablecoin-detail/supply-chart-section.tsx` — chart tooltip
- `src/components/depeg-table.tsx` — event dates
- `src/components/blacklist-table.tsx` — event dates
- Additional hits may surface — replace all that match existing presets.

For each match, determine which preset matches:
- `{ month: "short", day: "numeric", year: "numeric" }` → `"short"`
- `{ month: "long", day: "numeric", year: "numeric" }` → `"long"` (new)
- Patterns with hour/minute → `"full"` (new)

- [ ] **Step 3: Sweep inline `.toFixed(2) + "%"` patterns**

Replace inline `value.toFixed(N) + "%"` with `formatPercent()` / `formatSignedPercent()`. Known occurrences (search with `grep -rn 'toFixed.*%' src/components/ src/app/`):

- `src/components/yield-table.tsx` — APY display
- `src/components/comparison-table.tsx` — delta columns
- `src/components/kpi-strip.tsx` — percentage KPIs
- `src/app/stability-index/client.tsx` — PSI component weights
- `src/components/stablecoin-detail/peg-chart-section.tsx` — deviation %
- `src/components/stablecoin-detail/report-card-section.tsx` — dimension scores
- `src/components/liquidity-table.tsx` — liquidity scores
- `src/components/flow-table.tsx` — flow intensity
- Additional hits may surface — replace all percentage-formatting patterns.

For each match, replace with `formatPercent(value)` or `formatSignedPercent(value)` from `shared/lib/format.ts`.

- [ ] **Step 4: Run tests + build**

Run: `npm test && npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add shared/lib/format.ts src/components/ src/app/
git commit -m "refactor: sweep inline date/percent formatting to shared helpers (R-004, R-005)"
```

---

### Task 13: Add tests for untested table-logic files (CC-004 partial)

**Files:**
- Create: `src/components/__tests__/stablecoin-table-logic.test.ts`
- Create: `src/components/__tests__/flow-table-logic.test.ts`
- Create: `src/components/__tests__/depeg-table-logic.test.ts`
- Create: `src/components/__tests__/yield-table-logic.test.ts`
- Create: `src/components/__tests__/liquidity-table-logic.test.ts`
- Create: `src/components/__tests__/blacklist-table-logic.test.ts`

- [ ] **Step 1: Read each table-logic file to understand exports**

Table-logic files and their key exports to test:
- `src/components/stablecoin-table-logic.ts` — `compareStablecoins(a, b, sortKey)`, sort key enum
- `src/components/flow-table-logic.ts` — `getPressureScore()`, `getPressureState()`, `getCoverageBadge()`, `PRESSURE_VALUE_CLASS`, sort comparator
- `src/components/depeg-table-logic.ts` — depeg event sort comparator, severity helpers
- `src/components/yield-table-logic.ts` — yield sort comparator, APY ranking helpers
- `src/components/liquidity-table-logic.ts` — liquidity sort comparator, score formatting
- `src/components/blacklist-table-logic.ts` — blacklist sort comparator, balance formatting

- [ ] **Step 2: Write tests for `stablecoin-table-logic.ts`**

Test the comparator function with various sort keys (name, mcap, peg, safety grade), null values in numeric fields, and ascending/descending direction.

- [ ] **Step 3: Write tests for `flow-table-logic.ts`**

Test `getPressureScore` (returns numeric score for sorting), `getPressureState` (maps FIS to state string), `getCoverageBadge` (returns badge for coverage level), `PRESSURE_VALUE_CLASS` (maps states to CSS classes), and the sort comparator with mixed null/present values.

- [ ] **Step 4: Write tests for remaining table-logic files**

For each of depeg, yield, liquidity, and blacklist: test the sort comparator with representative rows, verify null-handling produces deterministic sort order, and test any helper functions.

- [ ] **Step 5: Run all new tests**

Run: `npm test -- src/components/__tests__/*-table-logic.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/__tests__/*-table-logic.test.ts
git commit -m "test: add tests for table-logic sorting/helper files (CC-004)"
```

---

### Task 14: Add CI check for cron schedule sync (S-019)

**Files:**
- Create: `scripts/check-cron-schedule-sync.ts` (`.ts` — run via `tsx`)
- Modify: `package.json` (add script entry)

- [ ] **Step 1: Create the check script**

Note: This script runs via `tsx` which respects `tsconfig.json` paths. However, since scripts are outside the `src/` directory and may not be covered by the root tsconfig's `paths`, use a relative import from the script's location.

```typescript
// scripts/check-cron-schedule-sync.ts
import { readFileSync } from "fs";
import { CRON_SCHEDULES } from "../shared/lib/cron-jobs.ts";

// Parse wrangler.toml cron triggers
const wranglerToml = readFileSync("worker/wrangler.toml", "utf-8");
const cronMatches = wranglerToml.match(/crons\s*=\s*\[([\s\S]*?)\]/);
if (!cronMatches) {
  console.error("Could not find crons array in wrangler.toml");
  process.exit(1);
}
const wranglerCrons = new Set(
  cronMatches[1].match(/"([^"]+)"/g)?.map((s) => s.replace(/"/g, "")) ?? [],
);

const sharedCrons = new Set(Object.values(CRON_SCHEDULES));

// Compare
const onlyInWrangler = [...wranglerCrons].filter((c) => !sharedCrons.has(c));
const onlyInShared = [...sharedCrons].filter((c) => !wranglerCrons.has(c));

if (onlyInWrangler.length || onlyInShared.length) {
  console.error("Cron schedule mismatch detected!");
  if (onlyInWrangler.length) console.error("In wrangler.toml only:", onlyInWrangler);
  if (onlyInShared.length) console.error("In CRON_SCHEDULES only:", onlyInShared);
  process.exit(1);
}

console.log(`Cron schedule check passed (${wranglerCrons.size} triggers match).`);
```

- [ ] **Step 2: Add npm script**

Add to package.json scripts:
```json
"check:cron-sync": "tsx scripts/check-cron-schedule-sync.ts"
```

- [ ] **Step 3: Run the check**

Run: `npm run check:cron-sync`
Expected: PASS with matching count

- [ ] **Step 4: Commit**

```bash
git add scripts/check-cron-schedule-sync.ts package.json
git commit -m "ci: add cron schedule sync check between wrangler.toml and CRON_SCHEDULES (S-019)"
```

---

### Task 15: Add SQL allowlist validation (Q-008)

**Files:**
- Modify: `worker/src/api/status-derived-data.ts` (add allowlist check)

- [ ] **Step 1: Add allowlist constants and validation**

`DATASET_FRESHNESS_TARGETS` is a `Record<..., DatasetFreshnessTarget>` (object, not array). Extract table-type entries for the allowlists:

```typescript
const TABLE_TARGETS = Object.values(DATASET_FRESHNESS_TARGETS).filter(
  (t): t is Extract<DatasetFreshnessTarget, { type: "table" }> => t.type === "table",
);
const ALLOWED_DATASET_TABLES = new Set(TABLE_TARGETS.map((t) => t.table));
const ALLOWED_DATASET_COLUMNS = new Set(TABLE_TARGETS.map((t) => t.column));
const ALLOWED_DATASET_WHERE_CLAUSES = new Set(
  TABLE_TARGETS.map((t) => t.where).filter(Boolean),
);
```

In the `getLastTableUpdate` function (line 248), add before the SQL query:
```typescript
if (!ALLOWED_DATASET_TABLES.has(target.table)) {
  throw new Error(`Invalid dataset table: ${target.table}`);
}
if (!ALLOWED_DATASET_COLUMNS.has(target.column)) {
  throw new Error(`Invalid dataset column: ${target.column}`);
}
if (target.where && !ALLOWED_DATASET_WHERE_CLAUSES.has(target.where)) {
  throw new Error(`Invalid dataset where clause: ${target.where}`);
}
```

This validates all three interpolated SQL fragments: `target.table`, `target.column`, and `target.where` (currently only `"key = 'stablecoins'"` for the cache table).

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add worker/src/api/status-derived-data.ts
git commit -m "fix: add allowlist validation for SQL interpolation in status-derived-data (Q-008)"
```

---

### Task 16: Add enrichment counters to blacklist sync (Q-019)

**Files:**
- Modify: `worker/src/cron/sync-blacklist.ts` (add counters to `enrichRowBalances`)

- [ ] **Step 1: Add counter tracking**

Modify `enrichRowBalances` to return `{ attempted: number; succeeded: number; failed: number }`:
- Initialize counters at the start
- Increment `attempted` before each balance fetch
- Increment `succeeded` on success
- Increment `failed` in catch block
- Return the counter object
- Include counters in the cron run metadata

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/sync-blacklist.ts
git commit -m "fix: add enrichment success/failure counters to blacklist sync (Q-019)"
```

---

## Chunk 3: Phase 3 — Structural Improvements

### Task 17: Decompose `daily-digest.ts` into collector functions (Q-011)

**Files:**
- Create: `worker/src/cron/daily-digest/collectors.ts`
- Modify: `worker/src/cron/daily-digest.ts` (extract phases into named functions)

- [ ] **Step 1: Identify all enrichment phases**

Read through `generateDailyDigest` and identify each try/catch phase. Each becomes a named collector function.

- [ ] **Step 2: Create `daily-digest/collectors.ts`**

Extract each data collection phase into a named function:
- `collectActiveDepegs(db, stablecoinAssets)`
- `collectBlacklistActivity(db, stablecoinAssets)`
- `collectSupplyVelocity(db, stablecoinAssets)`
- `collectSafetyScores(db)`
- `collectResolvedDepegs(db)`
- `collectMintBurnFlows(db, mcapById)`
- `collectDewsStress(db, mcapById)`
- `collectHistoricalContext(db)`
- `collectGradeTransitions(db)`

Each function returns its typed result or `null` on failure. The orchestrator calls them sequentially and assembles the results.

- [ ] **Step 3: Update orchestrator to call collectors**

The main `generateDailyDigest` function becomes a clean pipeline that calls each collector and assembles the enrichment data.

- [ ] **Step 4: Run tests**

Run: `npm test -- worker/src/cron/__tests__/daily-digest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/daily-digest.ts worker/src/cron/daily-digest/
git commit -m "refactor: extract daily-digest data collectors into named functions (Q-011)"
```

---

### Task 18: Wrap remaining API handlers with `withErrorHandler` (S-011)

**Files:**
- Modify: `worker/src/route-registry.ts` (wrap raw handlers)

- [ ] **Step 1: Identify unwrapped handlers**

Find handlers in `STATIC_ROUTE_HANDLERS_BY_KEY` that are NOT wrapped with `withErrorHandler` or `createCacheHandler`. These are the raw function calls.

- [ ] **Step 2: Wrap each with `withErrorHandler`**

For each identified handler, wrap it:
```typescript
"blacklist": withErrorHandler("blacklist", ({ db, url }) => handleBlacklist(db, url)),
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add worker/src/route-registry.ts
git commit -m "refactor: wrap remaining API handlers with withErrorHandler (S-011)"
```

---

### Task 19: Add Zod schema for DL detail response (CC-005 partial)

**Files:**
- Modify: `worker/src/api/stablecoin-detail/defillama.ts` (add schema)
- Modify: `worker/src/cron/enrich-prices.ts` (remove index signature from PeggedAsset)

- [ ] **Step 1: Define Zod schema for DL detail response**

Create a Zod schema that validates the essential fields of the DefiLlama stablecoin detail response.

- [ ] **Step 2: Remove `[key: string]: unknown` from `PeggedAsset`**

Replace with explicit typed fields. Create a separate `RawLlamaAsset` type for the unvalidated API response.

- [ ] **Step 3: Run tests + type-check**

Run: `npm test && cd worker && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add worker/src/api/stablecoin-detail/defillama.ts worker/src/cron/enrich-prices.ts
git commit -m "refactor: add Zod validation for DL detail response, remove PeggedAsset index signature (CC-005)"
```

---

### Task 20: Extract `buildContagionLayout` from contagion-graph (Q-010)

**Files:**
- Create: `src/lib/contagion-layout.ts`
- Create: `src/lib/__tests__/contagion-layout.test.ts`
- Modify: `src/components/contagion-graph.tsx` (import layout function)

- [ ] **Step 1: Extract pure layout/simulation logic**

Identify the d3-force simulation setup, node/link creation, and layout calculation in `contagion-graph.tsx`. Extract into `contagion-layout.ts` as a pure function:
```typescript
export function buildContagionLayout(data: DependencyGraphData): ContagionLayout { ... }
```

- [ ] **Step 2: Write tests for the layout function**

Test node positioning, link creation, and edge cases (empty data, single node, circular dependencies).

- [ ] **Step 3: Update component to use extracted function**

The React component imports `buildContagionLayout` and focuses on SVG rendering and interaction.

- [ ] **Step 4: Run tests + build**

Run: `npm test && npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/contagion-layout.ts src/lib/__tests__/contagion-layout.test.ts src/components/contagion-graph.tsx
git commit -m "refactor: extract buildContagionLayout from contagion-graph component (Q-010)"
```

---

## Post-Implementation Verification

After all tasks are complete:

- [ ] **Run full test suite:** `npm test`
- [ ] **Run full build + type-check:** `npm run build && cd worker && npx tsc --noEmit`
- [ ] **Run lint:** `npm run lint`
- [ ] **Run worker boundary check:** `npm run check:worker-boundary`
- [ ] **Run merge gate:** `npm run test:merge-gate`
- [ ] **Run cron schedule sync check:** `npm run check:cron-sync`

---

## Deferred / Excluded Findings

The following audit findings are intentionally excluded from this plan. They are either already mitigated, too high-effort for their impact, or require design decisions beyond this remediation scope. Finding IDs match `agents/plans/2026-03-13-comprehensive-codebase-audit.md`.

| Finding | Audit Title | Reason Deferred |
|---------|-------------|-----------------|
| R-008 | `encodeStablecoinUrlToken` is an identity function | Intentional future-proofing per active ticker-issuer migration plan. Audit says "leave in place." |
| Q-001 | `syncStablecoins` 916-line monolith | Decomposition requires deep knowledge of data pipeline ordering constraints. Recommend a dedicated plan after the sync-stablecoins pipeline stabilizes. |
| Q-002 | `methodology-sections.tsx` 2215-line static JSX | Low severity — purely cosmetic readability. No logic to test. The file is rarely modified and a split adds import complexity. |
| Q-006 | Semantic overloading of `last_block` column | Requires a D1 schema migration (`ALTER TABLE blacklist_sync_state`). Low impact — behavior is documented in code comments. |
| Q-007 | API handlers missing test coverage (7 files) | Task 13 covers `*-table-logic.ts` tests (S-005 side). The API handler side (cache-handlers, status-derived-data, etc.) are thin wrappers or already covered by integration-level contract tests. Lower priority than the table-logic gap. |
| Q-009 | `enrichRowBalances` has 8 parameters | Low severity. Called from one location. A `BlacklistSyncContext` object would help readability but doesn't affect correctness. Can be combined with Q-001/Q-002 when the sync-blacklist pipeline is refactored. |
| Q-018 | Frontend hooks surface generic error messages | Low severity UX concern. Current behavior is safe (shows loading state, not broken data). A `useApiQueryWithFallback` variant is a feature addition, not a remediation. |
| S-001 | Global mutable state in worker modules (init pattern) | Requires architectural redesign of worker initialization (5 modules with `initX()` pattern). Medium effort for low immediate impact — the pattern works correctly and is well-documented. |
| S-003 | Stablecoin metadata god module (4600 lines) | Tolerable at current scale (156 coins). Task 6 reformats `coin()`. Full split (by peg category) deferred until the module exceeds ~200 entries. |
| S-014 | Hardcoded fallback values (`RUB_FALLBACK`, `RISK_FREE_RATE_FALLBACK`) | Low impact — fallback paths are rarely triggered and the alert system notifies on extended use. |
| S-015 | In-memory rate limiter as silent fallback | Low impact at current traffic levels. The D1-backed primary limiter handles >99% of requests. A circuit-breaker alert is the right next step but requires design. |
| S-020 | No Zod validation on API response outputs (partial) | Task 19 covers the highest-priority DL detail response (Q-005 + Q-016). Remaining API output validation for public endpoints is lower priority — frontend strict contracts already catch mismatches at integration level. |
