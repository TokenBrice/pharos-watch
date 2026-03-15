# Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate all confirmed findings from the 2026-03-15 codebase audit, fixing code quality issues, improving observability, and adding missing CI checks.

**Architecture:** Targeted fixes to existing files — no new abstractions, no file restructuring. Each task modifies 1-3 files with tests. Phase 4 strategic overhauls (stablecoins.ts split, D1 batching layer, route registry refactor) are deferred to dedicated sessions.

**Tech Stack:** TypeScript, Vitest, ESLint, Node.js scripts

**Audit reference:** `agents/plans/2026-03-15-codebase-audit.md`

**Findings dropped after verification (false positives):** Q2, Q3, Q9, Q10, Q11, R2, R12, S5 — see `agents/plans/2026-03-15-codebase-audit.md` Appendix for original descriptions.

---

## Chunk 1: Code Quality Fixes

### Task 1: Yield Pipeline NaN/Infinity Guards (Q5)

**Files:**
- Modify: `worker/src/cron/yield-helpers.ts:46-61`
- Modify: `worker/src/cron/__tests__/yield-helpers.test.ts`

- [ ] **Step 1: Write failing tests for Infinity propagation**

Add to `worker/src/cron/__tests__/yield-helpers.test.ts` inside the `computeYieldStability` describe block:

```typescript
it("returns null when CV is Infinity (tiny mean, extreme variance)", () => {
  // mean = 5e-10 (above 1e-10 guard), variance overflows to Infinity → cv = Infinity
  expect(computeYieldStability([1e-9, 1e200, -1e200, 1e-9])).toBeNull();
});
```

Add to `computeApyVarianceScore` describe block:

```typescript
it("returns null when CV is Infinity", () => {
  // Same mechanism: mean bypasses near-zero guard but variance overflows
  expect(computeApyVarianceScore([1e-9, 1e200, -1e200, 1e-9])).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-helpers.test.ts --reporter=verbose`
Expected: 2 new tests FAIL (returning a number instead of null)

- [ ] **Step 3: Add isFinite guard to computeYieldStability**

In `worker/src/cron/yield-helpers.ts`, line 51, after `const cv = ...`:

```typescript
export function computeYieldStability(apySamples: number[]): number | null {
  if (apySamples.length < 2) return null;
  const mean = apySamples.reduce((s, v) => s + v, 0) / apySamples.length;
  if (Math.abs(mean) < 1e-10) return null;
  const variance = apySamples.reduce((s, v) => s + (v - mean) ** 2, 0) / apySamples.length;
  const cv = Math.sqrt(variance) / Math.abs(mean);
  if (!Number.isFinite(cv)) return null;
  return Math.max(0, Math.min(1, Math.round((1 - cv) * 100) / 100));
}
```

- [ ] **Step 4: Add isFinite guard to computeApyVarianceScore**

Same pattern at line 60:

```typescript
export function computeApyVarianceScore(apySamples: number[]): number | null {
  if (apySamples.length < 2) return null;
  const mean = apySamples.reduce((s, v) => s + v, 0) / apySamples.length;
  if (Math.abs(mean) < 1e-10) return null;
  const variance = apySamples.reduce((s, v) => s + (v - mean) ** 2, 0) / apySamples.length;
  const cv = Math.sqrt(variance) / Math.abs(mean);
  if (!Number.isFinite(cv)) return null;
  return Math.min(1, cv);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-helpers.test.ts --reporter=verbose`
Expected: ALL tests PASS

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/yield-helpers.ts worker/src/cron/__tests__/yield-helpers.test.ts
git commit -m "fix(yield): guard against NaN/Infinity in yield stability and variance scores (Q5)"
```

---

### Task 2: Yield Pipeline Observability (Q7, Q12)

**Files:**
- Modify: `worker/src/cron/yield-sync/rankings.ts:5-38,83-92`
- Modify: `worker/src/cron/__tests__/yield-helpers.test.ts` (add parseWarningSignals + rowToRanking tests)

- [ ] **Step 1: Write failing test for parseWarningSignals logging**

First, update the existing import on line 1 of `worker/src/cron/__tests__/yield-helpers.test.ts` to add `vi`:

```typescript
import { describe, it, expect, vi } from "vitest";
```

Then update the existing import on line 13 to add `parseWarningSignals`:

```typescript
import { computeTvlWeightedMedianApy, parseWarningSignals } from "../yield-sync/rankings";
```

Then add this describe block after the existing test blocks:

```typescript
describe("parseWarningSignals", () => {
  it("returns empty array for empty string", () => {
    expect(parseWarningSignals("")).toEqual([]);
  });

  it("parses valid JSON array of strings", () => {
    expect(parseWarningSignals('["yield-spike","tvl-outflow"]')).toEqual(["yield-spike", "tvl-outflow"]);
  });

  it("filters out non-string elements", () => {
    expect(parseWarningSignals('[1, "yield-spike", null, true]')).toEqual(["yield-spike"]);
  });

  it("returns empty array and logs warning for malformed JSON", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseWarningSignals("{not valid json")).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[yield-sync] failed to parse warning_signals"),
      expect.any(String),
    );
    warnSpy.mockRestore();
  });

  it("returns empty array and logs warning for non-array JSON", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseWarningSignals('{"key": "value"}')).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[yield-sync] warning_signals is not an array"),
    );
    warnSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify logging tests fail**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-helpers.test.ts --reporter=verbose`
Expected: The "logs warning" tests FAIL (no console.warn called)

- [ ] **Step 3: Add logging to parseWarningSignals**

In `worker/src/cron/yield-sync/rankings.ts`, update `parseWarningSignals`:

```typescript
export function parseWarningSignals(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      console.warn("[yield-sync] warning_signals is not an array:", typeof parsed);
      return [];
    }
    return parsed.filter((value): value is string => typeof value === "string");
  } catch (e) {
    console.warn("[yield-sync] failed to parse warning_signals:", e instanceof Error ? e.message : String(e));
    return [];
  }
}
```

- [ ] **Step 4: Add numeric type guards to rowToRanking**

In `worker/src/cron/yield-sync/rankings.ts`, update `rowToRanking` to coerce numeric fields:

```typescript
function toNum(val: unknown): number | null {
  if (typeof val === "number") return val;
  if (typeof val === "string") { const n = parseFloat(val); return Number.isFinite(n) ? n : null; }
  return null;
}

export function rowToRanking(row: Record<string, unknown>) {
  const stablecoinId = String(row.stablecoin_id);
  const meta = TRACKED_META_BY_ID.get(stablecoinId);

  return {
    id: stablecoinId,
    symbol: row.symbol,
    name: meta?.name ?? String(row.symbol),
    currentApy: toNum(row.current_apy),
    apy7d: toNum(row.apy_7d),
    apy30d: toNum(row.apy_30d),
    apyBase: toNum(row.apy_base),
    apyReward: toNum(row.apy_reward),
    yieldSource: row.yield_source,
    yieldSourceUrl: resolveYieldSourceUrl({
      stablecoinId,
      sourceKey: typeof row.source_key === "string" ? row.source_key : null,
      yieldSource: typeof row.yield_source === "string" ? row.yield_source : null,
    }),
    yieldType: row.yield_type,
    dataSource: row.data_source,
    sourceTvlUsd: toNum(row.source_tvl_usd),
    pharosYieldScore: toNum(row.pharos_yield_score),
    safetyScore: toNum(row.safety_score),
    safetyGrade: row.safety_grade,
    yieldToRisk: toNum(row.yield_to_risk),
    excessYield: toNum(row.excess_yield),
    yieldStability: toNum(row.yield_stability),
    apyVariance30d: toNum(row.apy_variance_30d),
    apyMin30d: toNum(row.apy_min_30d),
    apyMax30d: toNum(row.apy_max_30d),
    warningSignals: parseWarningSignals(row.warning_signals),
    altSources: [] as AltYieldSource[],
  };
}
```

- [ ] **Step 5: Run tests to verify all pass**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-helpers.test.ts --reporter=verbose`
Expected: ALL tests PASS

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/yield-sync/rankings.ts worker/src/cron/__tests__/yield-helpers.test.ts
git commit -m "fix(yield): add logging to parseWarningSignals and type guards to rowToRanking (Q7, Q12)"
```

---

### Task 3: Rate-Limit Hardening (Q1, Q14)

**Files:**
- Modify: `worker/src/lib/rate-limit.ts:28-50,138-144,191-196`
- Create: `worker/src/lib/__tests__/rate-limit.test.ts`

- [ ] **Step 1: Write tests for improved pruning behavior**

Create `worker/src/lib/__tests__/rate-limit.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkRateLimit } from "../rate-limit";

describe("checkRateLimit", () => {
  beforeEach(() => {
    // Reset module state between tests by clearing the in-memory map.
    // The map is module-scoped, so we test via the public API.
  });

  it("allows requests within the limit", () => {
    const ip = `test-allow-${Date.now()}`;
    for (let i = 0; i < 60; i++) {
      expect(checkRateLimit(ip, 60, 60_000)).toBeNull();
    }
  });

  it("returns 429 when limit is exceeded", () => {
    const ip = `test-exceed-${Date.now()}`;
    for (let i = 0; i < 61; i++) {
      checkRateLimit(ip, 60, 60_000);
    }
    const result = checkRateLimit(ip, 60, 60_000);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);
  });

  it("includes Retry-After header in 429 response", () => {
    const ip = `test-retry-${Date.now()}`;
    for (let i = 0; i < 62; i++) {
      checkRateLimit(ip, 60, 60_000);
    }
    const result = checkRateLimit(ip, 60, 60_000);
    expect(result).not.toBeNull();
    expect(result!.headers.get("Retry-After")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they pass (these test existing behavior)**

Run: `cd worker && npx vitest run src/lib/__tests__/rate-limit.test.ts --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 3: Add consecutive failure counters to prune operations (Q1)**

The current eviction logic (line 47) already sorts by `resetAt` and evicts the oldest half — Q14 is verified correct, no code change needed.

For Q1: the fire-and-forget `.catch()` is appropriate for non-critical cleanup, but repeated failures should be visible. Add module-level counters.

In `worker/src/lib/rate-limit.ts`, add after line 26 (`let lastPublicApiPruneBucket: number | null = null;`):

```typescript
let publicApiPruneFailures = 0;
let feedbackPruneFailures = 0;
```

Replace lines 138-144 (the full `if` block containing the prune in `checkPublicApiRateLimit`) — keep the `if` wrapper, only change the `.run().catch()` chain inside it:

```typescript
    if (lastPublicApiPruneBucket !== bucketStart) {
      lastPublicApiPruneBucket = bucketStart;
      db.prepare("DELETE FROM public_api_rate_limit WHERE bucket_start < ?")
        .bind(bucketStart - windowSec * PUBLIC_API_PRUNE_WINDOW_MULTIPLIER)
        .run()
        .then(() => { publicApiPruneFailures = 0; })
        .catch((e) => {
          publicApiPruneFailures++;
          console.warn(`[public-api] rate-limit prune failed (${publicApiPruneFailures} consecutive):`, e);
        });
    }
```

Replace lines 192-195 (the prune chain at the end of `checkFeedbackRateLimit`):

```typescript
  db.prepare("DELETE FROM feedback_rate_limit WHERE submitted_at < ?")
    .bind(now - 3600)
    .run()
    .then(() => { feedbackPruneFailures = 0; })
    .catch((e) => {
      feedbackPruneFailures++;
      console.warn(`[feedback] rate-limit prune failed (${feedbackPruneFailures} consecutive):`, e);
    });
```

- [ ] **Step 4: Run tests to verify they still pass**

Run: `cd worker && npx vitest run src/lib/__tests__/rate-limit.test.ts --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/rate-limit.ts worker/src/lib/__tests__/rate-limit.test.ts
git commit -m "fix(rate-limit): track consecutive prune failures for observability (Q1)"
```

---

### Task 4: Alchemy Batch Timestamp Error Tracking (Q4)

**Files:**
- Modify: `worker/src/lib/alchemy-logs.ts:431-471`

- [ ] **Step 1: Add `batchErrors` counter to resolveBlockTimestamps**

In `worker/src/lib/alchemy-logs.ts`, before the batch loop (around line 418), add a counter:

```typescript
let batchErrors = 0;
```

In the catch block at line 468, increment it:

```typescript
} catch (e) {
  batchErrors++;
  console.warn(`[alchemy-logs] batch timestamp fetch failed (${batchErrors}):`, e);
}
```

After the loop ends (before the persistent cache write at line 473), add:

```typescript
if (batchErrors > 0) {
  const totalNeeded = uniqueBlocks.length;
  const stillMissing = uniqueBlocks.filter((b) => !timestamps.has(b)).length;
  console.warn(`[alchemy-logs] timestamp resolution incomplete: ${stillMissing}/${totalNeeded} blocks still unresolved after ${batchErrors} batch error(s)`);
}
```

- [ ] **Step 2: Run existing tests to verify no regression**

Run: `cd worker && npx vitest run src/lib/__tests__/alchemy-logs.test.ts --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add worker/src/lib/alchemy-logs.ts
git commit -m "fix(alchemy): log incomplete timestamp resolution from batch errors (Q4)"
```

---

### Task 5: Frontend Defensive Improvements (Q8, Q13)

**Files:**
- Modify: `src/hooks/use-url-filters.ts:26-29`
- Modify: `src/components/section-error-boundary.tsx`

- [ ] **Step 1: Add stability comment to useUrlFilters (Q8)**

In `src/hooks/use-url-filters.ts`, before line 26:

```typescript
  // syncFromLocation is referentially stable (empty useCallback deps) —
  // safe to use as a useEffect dependency without causing re-subscription loops.
  const syncFromLocation = useCallback(() => {
```

- [ ] **Step 2: Add retry limit to SectionErrorBoundary (Q13)**

_Note: TDD is skipped for this component — React class-based error boundaries require JSDOM + React Testing Library to test, which is not part of the current Vitest setup. The retry-exhaustion behavior is verified by the build check in Step 3._

Replace `src/components/section-error-boundary.tsx` content:

```typescript
"use client";

import { Component, type ReactNode } from "react";

interface Props {
  name: string;
  children: ReactNode;
  supportingText?: string;
}

interface State {
  hasError: boolean;
  retryCount: number;
}

const MAX_RETRIES = 3;

export class SectionErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, retryCount: 0 };
  }

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error(`[${this.props.name}] render error:`, error);
  }

  render() {
    if (this.state.hasError) {
      const canRetry = this.state.retryCount < MAX_RETRIES;
      return (
        <div className="rounded-lg border border-border/50 bg-muted/30 p-6 text-center">
          <p className="text-sm font-medium text-foreground">The {this.props.name} section is temporarily unavailable.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {this.props.supportingText ?? "Please try again. Existing page content is still safe to use."}
          </p>
          {canRetry ? (
            <button
              onClick={() => this.setState((prev) => ({ hasError: false, retryCount: prev.retryCount + 1 }))}
              className="mt-2 text-sm font-medium text-foreground hover:underline"
            >
              Try again ({MAX_RETRIES - this.state.retryCount} {MAX_RETRIES - this.state.retryCount === 1 ? "retry" : "retries"} left)
            </button>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              Please refresh the page to try again.
            </p>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
```

- [ ] **Step 3: Run full build to verify**

Run: `npm run build`
Expected: Build succeeds with no type errors

- [ ] **Step 4: Commit**

```bash
git add src/hooks/use-url-filters.ts src/components/section-error-boundary.tsx
git commit -m "fix(ui): add stability comment to useUrlFilters and retry limits to SectionErrorBoundary (Q8, Q13)"
```

---

## Chunk 2: Import Cleanup & CI Scripts

### Task 6: Remove CRON_* Re-Exports from use-api-query.ts (R11)

**Files:**
- Modify: `src/hooks/use-api-query.ts:5-12`
- Modify: 13 consumer files (listed below)

Consumer files that import CRON_* from `use-api-query` (verified via grep):
- `src/hooks/api-hooks.ts` (imports CRON_1H, CRON_1MIN, CRON_15MIN, CRON_24H, CRON_30MIN from `"./use-api-query"`)
- `src/hooks/use-prefetch-stablecoin.ts` (imports CRON_15MIN, CRON_1H, CRON_24H from `"@/hooks/use-api-query"`)
- `src/hooks/use-stress-signals.ts` (imports CRON_15MIN from `"./use-api-query"`)
- `src/hooks/use-mint-burn-flows.ts` (imports CRON_20MIN from `"./use-api-query"`)
- `src/hooks/use-status-history.ts` (imports CRON_1MIN from `"./use-api-query"`)
- `src/hooks/use-status.ts` (imports CRON_1MIN from `"./use-api-query"`)
- `src/hooks/use-depeg-events.ts` (imports CRON_15MIN from `"./use-api-query"`)
- `src/hooks/use-blacklist-events.ts` (imports CRON_20MIN from `"./use-api-query"`)
- `src/hooks/use-endpoint-probes.ts` (imports CRON_1MIN from `"./use-api-query"`)
- `src/hooks/use-stablecoins.ts` (imports CRON_15MIN, CRON_1H from `"./use-api-query"`)
- `src/hooks/use-compare-data-model.ts` (imports CRON_1H, CRON_20MIN from `"@/hooks/use-api-query"`)
- `src/hooks/__tests__/query-polling-policy.test.ts` (imports CRON_1MIN from `"../use-api-query"`)
- `src/hooks/__tests__/use-safety-score-history.test.ts` (imports CRON_24H from `"../use-api-query"`)

- [ ] **Step 1: Remove re-export block from use-api-query.ts**

Delete lines 5-12 from `src/hooks/use-api-query.ts`:

```typescript
// DELETE this block:
export {
  CRON_1MIN,
  CRON_15MIN,
  CRON_20MIN,
  CRON_30MIN,
  CRON_1H,
  CRON_24H,
} from "@/lib/cron-intervals";
```

- [ ] **Step 2: Update all 13 consumer files**

In each file, move CRON_* constants out of the `use-api-query` import and into a new `@/lib/cron-intervals` import. **Preserve the existing import path style** (relative `"./use-api-query"` or alias `"@/hooks/use-api-query"`) for the remaining `use-api-query` import.

The rule: move all `CRON_*` constants to `@/lib/cron-intervals` and keep all non-CRON symbols in their existing import line. Examples for each pattern:

**Pattern A — mixed CRON + query hook (most files):**
```typescript
// Before (use-stress-signals.ts):
import { useApiQueryWithMeta, CRON_15MIN } from "./use-api-query";
// After:
import { useApiQueryWithMeta } from "./use-api-query";
import { CRON_15MIN } from "@/lib/cron-intervals";
```

**Pattern B — mixed CRON + usePollingQuery (use-blacklist-events, use-endpoint-probes, use-status, use-status-history):**
```typescript
// Before (use-blacklist-events.ts):
import { CRON_20MIN, usePollingQuery } from "./use-api-query";
// After:
import { usePollingQuery } from "./use-api-query";
import { CRON_20MIN } from "@/lib/cron-intervals";
```

**Pattern C — CRON-only alias import (use-compare-data-model.ts):**
```typescript
// Before:
import { CRON_1H, CRON_20MIN } from "@/hooks/use-api-query";
// After:
import { CRON_1H, CRON_20MIN } from "@/lib/cron-intervals";
```

**Pattern D — test file with mixed CRON + non-CRON (query-polling-policy.test.ts):**
```typescript
// Before:
import { CRON_1MIN, createPollingQueryOptions } from "../use-api-query";
// After:
import { createPollingQueryOptions } from "../use-api-query";
import { CRON_1MIN } from "@/lib/cron-intervals";
```

**Pattern E — test file with CRON only (use-safety-score-history.test.ts):**
```typescript
// Before:
import { CRON_24H } from "../use-api-query";
// After:
import { CRON_24H } from "@/lib/cron-intervals";
```

**Pattern F — multi-CRON + multi-hook (api-hooks.ts, use-prefetch-stablecoin.ts):**
```typescript
// Before (api-hooks.ts):
import { CRON_1H, CRON_1MIN, CRON_15MIN, CRON_24H, CRON_30MIN, createApiQueryFn, createStaticQueryOptions, useApiQuery, useApiQueryWithMeta } from "./use-api-query";
// After:
import { createApiQueryFn, createStaticQueryOptions, useApiQuery, useApiQueryWithMeta } from "./use-api-query";
import { CRON_1H, CRON_1MIN, CRON_15MIN, CRON_24H, CRON_30MIN } from "@/lib/cron-intervals";
```

- [ ] **Step 3: Run build to verify all imports resolve**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 4: Run tests to verify no regressions**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/hooks/use-api-query.ts \
  src/hooks/api-hooks.ts src/hooks/use-prefetch-stablecoin.ts \
  src/hooks/use-stress-signals.ts src/hooks/use-mint-burn-flows.ts \
  src/hooks/use-status-history.ts src/hooks/use-status.ts \
  src/hooks/use-depeg-events.ts src/hooks/use-blacklist-events.ts \
  src/hooks/use-endpoint-probes.ts src/hooks/use-stablecoins.ts \
  src/hooks/use-compare-data-model.ts \
  src/hooks/__tests__/query-polling-policy.test.ts \
  src/hooks/__tests__/use-safety-score-history.test.ts
git commit -m "refactor(imports): remove CRON_* re-exports from use-api-query, import directly (R11)"
```

---

### Task 7: Check-Duplicate-Exports CI Script (S11)

**Files:**
- Create: `scripts/check-duplicate-exports.mjs`
- Modify: `package.json` (add script entry)

- [ ] **Step 1: Create the script**

Create `scripts/check-duplicate-exports.mjs`:

```javascript
#!/usr/bin/env node
/**
 * Detects duplicate `export` names within any single .ts/.tsx file
 * in shared/lib and src/lib. Catches post-merge conflicts from
 * parallel worktree development.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const DIRS = ["shared/lib", "src/lib", "worker/src/lib"];
const EXT_RE = /\.(ts|tsx)$/;
const EXPORT_RE = /^export\s+(?:const|let|function|class|type|interface|enum)\s+(\w+)/gm;

let errors = 0;

function scanDir(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { scanDir(full); continue; }
    if (!EXT_RE.test(entry)) continue;

    const content = readFileSync(full, "utf-8");
    const seen = new Map();
    let match;
    EXPORT_RE.lastIndex = 0;
    while ((match = EXPORT_RE.exec(content)) !== null) {
      const name = match[1];
      const line = content.slice(0, match.index).split("\n").length;
      if (seen.has(name)) {
        console.error(`DUPLICATE: ${relative(".", full)} exports "${name}" at lines ${seen.get(name)} and ${line}`);
        errors++;
      } else {
        seen.set(name, line);
      }
    }
  }
}

for (const dir of DIRS) scanDir(dir);

if (errors > 0) {
  console.error(`\n${errors} duplicate export(s) found.`);
  process.exit(1);
} else {
  console.log("No duplicate exports found.");
}
```

- [ ] **Step 2: Add script to package.json**

Add to `scripts` in `package.json`:
```json
"check:duplicate-exports": "node scripts/check-duplicate-exports.mjs"
```

- [ ] **Step 3: Verify the script detects actual duplicates (TDD)**

Create a temporary test file, run the script to confirm it catches the violation, then remove the file:

```bash
echo 'export const DUPLICATE_TEST = 1;\nexport const DUPLICATE_TEST = 2;' > shared/lib/_test_dup.ts
npm run check:duplicate-exports
```

Expected: Exit code 1, output includes `DUPLICATE: shared/lib/_test_dup.ts exports "DUPLICATE_TEST"`.

Then remove the test file:

```bash
rm shared/lib/_test_dup.ts
```

_Note: This script catches same-file duplicate `export const/function/class/type/interface/enum` declarations — the class of bug caused by parallel worktree merges. It does NOT catch cross-file name shadowing via re-exports (the R11 pattern); that is addressed by Task 6._

- [ ] **Step 4: Run the script on the real codebase**

Run: `npm run check:duplicate-exports`
Expected: "No duplicate exports found." with exit code 0

- [ ] **Step 5: Commit**

```bash
git add scripts/check-duplicate-exports.mjs package.json
git commit -m "ci(scripts): add duplicate-export checker for post-merge safety (S11)"
```

---

### Task 8: ESLint Rule for Shared Lib Imports (S7)

**Files:**
- Modify: `eslint.config.mjs`

- [ ] **Step 1: Read current eslint.config.mjs**

Read the file first to understand the existing configuration structure.

- [ ] **Step 2: Add no-restricted-imports rule for shared/lib source files (excluding tests)**

Add a new config entry targeting source files only (tests use `@shared/*` aliases intentionally since they are external consumers of the shared library):

```javascript
{
  files: ["shared/lib/**/*.ts"],
  ignores: ["shared/lib/__tests__/**"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [{
          group: ["@shared/*"],
          message: "Within shared/lib/, use relative imports (./file) instead of @shared/* aliases.",
        }],
      },
    ],
  },
},
```

- [ ] **Step 3: Run lint to verify no violations exist in source files**

Run: `npm run lint`
Expected: PASS (test files are excluded from the rule; source files already use relative imports)

- [ ] **Step 4: Commit**

```bash
git add eslint.config.mjs
git commit -m "lint(shared): enforce relative imports within shared/lib/ (S7)"
```

---

### Task 9: Raise Test Coverage Threshold (S6)

**Files:**
- Modify: `vitest.config.ts`

- [ ] **Step 1: Check current actual coverage**

Run: `npm run test:coverage 2>&1 | tail -20`
Note the actual line coverage percentage.

- [ ] **Step 2: Raise threshold to 5% below actual (ratchet up)**

In `vitest.config.ts`, update the `thresholds` section. If actual coverage is e.g. 62%, set to 60%:

```typescript
thresholds: {
  lines: 60,  // Ratcheted up from 55%; raise further as coverage improves
},
```

Only raise to a value that won't break the build. If actual is 55-57%, keep at 55% and document why. If Step 3 fails, reduce the threshold by 2% and retry until passing; commit the highest value that passes.

- [ ] **Step 3: Run coverage to verify threshold passes**

Run: `npm run test:coverage`
Expected: PASS

- [ ] **Step 4: Commit**

Substitute the actual percentage into the commit message:

```bash
git add vitest.config.ts
git commit -m "ci(coverage): ratchet test coverage threshold from 55% to <actual>% (S6)"
```

---

## Chunk 3: Documentation & Infrastructure

### Task 10: Algorithm Overview Comments (S10, R3, R5, R6)

**Files:**
- Modify: `worker/src/cron/yield-helpers.ts:1-2` (add overview)
- Modify: `worker/src/cron/yield-sync/rankings.ts:1` (add overview)
- Modify: `worker/src/lib/mint-burn-bridge-classifier.ts:1` (add layering comment)
- Modify: `worker/src/lib/mint-burn-pipeline/classification.ts:1` (add layering comment)
- Modify: `worker/src/lib/dex-constants.ts:1` (add boundary comment)
- Modify: `worker/src/cron/dex-liquidity/constants.ts:1` (add boundary comment)

- [ ] **Step 1: Add overview comment to yield-helpers.ts**

Delete lines 1-2 of `worker/src/cron/yield-helpers.ts` (the existing `// worker/src/cron/yield-helpers.ts` path comment and `// Pure computation functions...` one-liner) and insert this JSDoc block at the top of the file:

```typescript
/**
 * Yield Pipeline — Pure Computation Functions
 *
 * Contains all math/scoring functions for yield intelligence. No I/O.
 *
 * Functions by pipeline stage:
 * - APY computation:    computeApyFromRate(), computeApyFromPrice()
 * - Scoring:            computePYS() (Pharos Yield Score)
 * - Variance analysis:  computeYieldStability(), computeApyVarianceScore()
 * - Warning detection:  detectWarningSignals()
 * - Pool matching:      matchAllDlPools() (3-layer resolution), findBestLendingPool()
 *
 * I/O counterparts live in yield-sync/: sources.ts (pool discovery), resolve.ts
 * (APY resolution), cache.ts (KV caching), rankings.ts (DB row mapping).
 */
```

- [ ] **Step 2: Add overview comment to yield-sync/rankings.ts**

Prepend to `worker/src/cron/yield-sync/rankings.ts`:

```typescript
/**
 * Yield Pipeline — DB Row Mapping & Ranking Helpers
 *
 * Converts raw D1 query results into typed ranking objects for the API.
 * Also handles warning signal deserialization and TVL-weighted median computation.
 *
 * Pure computation counterparts live in ../yield-helpers.ts.
 */
```

- [ ] **Step 3: Add layering comments to bridge classifier files**

Prepend to `worker/src/lib/mint-burn-bridge-classifier.ts`:

```typescript
/**
 * Mint/Burn Bridge Classifier — Pure Logic
 *
 * Classifies burn events as real burns or bridge transfers based on
 * contract-level bridge detection config. Pure function: no I/O, no DB access.
 *
 * Async orchestration wrapper: ../mint-burn-pipeline/classification.ts
 */
```

Prepend to `worker/src/lib/mint-burn-pipeline/classification.ts`:

```typescript
/**
 * Mint/Burn Bridge Classification — Async Orchestration
 *
 * Wraps the pure classifier (../mint-burn-bridge-classifier.ts) with
 * transaction context fetching from the chain RPC. Handles I/O and
 * batch processing; delegates classification logic to the pure module.
 */
```

- [ ] **Step 4: Add boundary comments to DEX constant files**

Prepend to `worker/src/lib/dex-constants.ts`:

```typescript
/**
 * DEX Core Constants — Reusable across any DEX operation
 *
 * Quality multipliers, symbol normalization, composite pool names,
 * blocked DEX IDs, DEX symbol aliases.
 *
 * Cron-specific config (subgraph URLs, rate limits, TVL factors):
 * see ../cron/dex-liquidity/constants.ts
 */
```

Prepend to `worker/src/cron/dex-liquidity/constants.ts`:

```typescript
/**
 * DEX Liquidity Cron Config — Specific to the dex-liquidity scoring cron
 *
 * DefiLlama URLs, Curve chain configs, Uniswap V3 subgraph IDs,
 * Aerodrome queries, governance lookup, rate limits, TVL factors.
 *
 * Reusable DEX utilities (symbol maps, quality multipliers):
 * see ../../lib/dex-constants.ts
 */
```

- [ ] **Step 5: Run build to verify comments don't break anything**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/yield-helpers.ts worker/src/cron/yield-sync/rankings.ts \
  worker/src/lib/mint-burn-bridge-classifier.ts worker/src/lib/mint-burn-pipeline/classification.ts \
  worker/src/lib/dex-constants.ts worker/src/cron/dex-liquidity/constants.ts
git commit -m "docs(worker): add algorithm overview comments to complex crons and classifier files (S10, R3, R5, R6)"
```

---

### Task 11: Cron Slot Capacity Documentation (S4)

**Files:**
- Modify: `docs/worker-infrastructure.md` (add section)

- [ ] **Step 1: Read current worker-infrastructure.md**

Read the file to find the appropriate section for inserting cron slot documentation.

- [ ] **Step 2: Add cron slot capacity section**

Insert the following section immediately before the `## Telegram Alert Bot` heading (after the Trigger 10 table) in `docs/worker-infrastructure.md`:

```markdown
### Cron Slot Capacity and Connection Pool Budget

Workers enforce a **6 concurrent fetch connections** limit per cron trigger invocation. All jobs sharing a trigger slot share this pool. Exceeding 6 causes `fetch()` to queue or fail.

| Trigger | Cron Expression | Max Concurrent External Connections | Headroom |
|---------|----------------|:---:|:---:|
| 1 | `*/15 * * * *` | 3 (sync-stablecoins + sync-fx-rates + status-self-check) | 3 |
| 2 | `3,23,43 * * * *` | 4 (multi-chain blacklist scans) | 2 |
| 3 | `4,24,44 * * * *` | 2 (Alchemy JSON-RPC) | 4 |
| 4 | `6,26,46 * * * *` | 1 (sequential CG/GT/DexScreener) | 5 |
| 5 | `13,33,53 * * * *` | 2 (Alchemy JSON-RPC, extended lane) | 4 |
| 6 | `10,40 * * * *` | 4 (charts + DEX liquidity + yield) | 2 |
| 7 | `11 * * * *` | 2 (reserve adapters + redemption) | 4 |
| 8 | `2,7,…,57 * * * *` | 5 (Telegram fan-out batch sends) | 1 |
| 9 | `0 8 * * *` | 2 (FRED + Etherscan) | 4 |
| 10 | `5 8 * * *` | 5 (bluechip + Anthropic + CoinGecko) | 1 |

**Policy for new jobs:**
- Jobs requiring ≤1 external connection may share any slot with headroom ≥2.
- Jobs requiring >2 concurrent connections should get a dedicated trigger slot.
- Never add a fetching job to a slot with headroom ≤1 (Triggers 8 and 10 are full).
```

- [ ] **Step 3: Commit**

```bash
git add docs/worker-infrastructure.md
git commit -m "docs(infra): document cron slot capacity and connection pool budget (S4)"
```

---

### Task 12: Cron Error Handling Policy (S14)

**Files:**
- Modify: `docs/worker-infrastructure.md` (add section)

- [ ] **Step 1: Add error handling policy section**

Insert a section "### Cron Error Handling Policy" in `docs/worker-infrastructure.md` immediately after the "### Cron Slot Capacity and Connection Pool Budget" section added in Task 11:

```markdown
### Cron Error Handling Policy

All cron jobs follow a 4-tier error classification:

| Tier | Example | Action | Log Level |
|------|---------|--------|-----------|
| **Fatal** | D1 unreachable, binding error | `sendAlert()` + abort job | `error` |
| **Recoverable** | External API timeout, HTTP 5xx | Retry with backoff (max 3), then warn | `warn` |
| **Validation** | Malformed API response, schema mismatch | Skip record, continue processing | `warn` |
| **Degradation** | Partial sync, stale data | Update status page, continue | `warn` |

**Fire-and-forget cleanup** (e.g., rate-limit pruning, cache eviction) may use `.catch()` with a counter. Non-critical background operations should never crash the main job.

**Alert deduplication:** Use job name + error category as the dedup key. Don't send the same alert more than once per 10-minute window.
```

- [ ] **Step 2: Commit**

```bash
git add docs/worker-infrastructure.md
git commit -m "docs(infra): define 4-tier cron error handling policy (S14)"
```

---

### Task 13: Migration Manifest (S8)

**Files:**
- Create: `worker/migrations/MANIFEST.md`

- [ ] **Step 1: List migration files and harvest git commit dates**

```bash
ls worker/migrations/*.sql | sort
git log --format="%as %f" -- worker/migrations/ | sort -k2
```

Use the output to build the MANIFEST table. Note that the naming has known anomalies: `0031` and `0031a` share a sequence number; three files share sequence `0056`; four files share sequence `0061`.

- [ ] **Step 2: Create MANIFEST.md**

Create `worker/migrations/MANIFEST.md` with:
- A table documenting each migration: number, filename, description (from filename), and idempotency status.
- A "Known Anomalies" subsection documenting the duplicate sequence numbers: `0031/0031a`, the three `0056_*` files, and the four `0061_*` files. Note that wrangler tracks applied migrations by filename, not sequence number, so duplicates are safe but confusing.
- A "Rollback Procedure" section (below).

Rollback Procedure section:

```markdown
## Rollback Procedure

If a migration corrupts data:

1. **Get bookmark:** `wrangler d1 time-travel info stablecoin-db --remote`
2. **Restore:** `wrangler d1 time-travel restore stablecoin-db --bookmark=<BOOKMARK> --remote`
3. **Remove bad migration** from `worker/migrations/` directory
4. **Re-apply remaining:** `wrangler d1 migrations apply stablecoin-db --remote`
5. **Redeploy worker:** `wrangler deploy`

D1 Time Travel retention: 30 days (paid plan), 7 days (free).
```

- [ ] **Step 3: Commit**

```bash
git add worker/migrations/MANIFEST.md
git commit -m "docs(migrations): add MANIFEST.md with rollback runbook (S8)"
```

---

### Task 14: Workspace Setup (.nvmrc, .npmrc) (S15)

**Files:**
- Create: `.nvmrc`
- Create: `.npmrc`

- [ ] **Step 1: Check current Node.js version and engines constraint**

Run: `node --version` and check `package.json` for `engines.node`.

The `.nvmrc` value should match the major version reported by `node --version`. The project's `engines.node` field should remain consistent (currently `">=20.0.0"`).

- [ ] **Step 2: Create .nvmrc**

Set to the major version of the current Node.js runtime (e.g., if `node --version` reports `v25.7.0`, write `25`):

```
25
```

- [ ] **Step 3: Create .npmrc**

```ini
save-exact=true
```

_Note: `workspaces-update=false` is omitted — it would prevent workspace dependency syncing during `npm install`, causing `worker/` to drift from the root lockfile._

- [ ] **Step 4: Run build to verify config files don't break anything**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add .nvmrc .npmrc
git commit -m "chore: add .nvmrc and .npmrc for workspace hygiene (S15)"
```

---

## Chunk 4: Deferred Items (Not Implemented in This Plan)

The following findings require dedicated implementation sessions due to their scope:

| Finding | Reason for Deferral | Estimated Effort |
|---------|---------------------|------------------|
| **S2:** Split `stablecoins.ts` (4,924 lines) | 40+ importing files; needs careful barrel-export migration | 2-3 days |
| **S3:** D1 batching layer | 186 query call sites; needs per-module audit | 3-5 days |
| **S9:** Route registry refactor | 40+ handler files; needs co-located endpoint registration pattern | 2-3 days |
| **S13:** Concurrency tests | New testing infrastructure (lease mocking, batch failure simulation) | 1-2 days |
| **S12:** Doc staleness checker | Needs file-path reference parser + count validator | 1 day |
| **R1:** error.tsx consolidation | Current per-route messages provide better UX; low value to consolidate | Deprioritized |
| **R4/R13/S1:** Version file registry | 8 files + importers; working pattern, low urgency | 1-2 days |

---

## Final Verification

After all tasks complete:

- [ ] **Full build:** `npm run build && cd worker && npx tsc --noEmit`
- [ ] **Full test suite:** `npm test`
- [ ] **Lint:** `npm run lint`
- [ ] **New CI script:** `npm run check:duplicate-exports`
- [ ] **Worker boundary check:** `npm run check:worker-boundary`
