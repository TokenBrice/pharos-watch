# Comprehensive Codebase Remediation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate 32 audit findings across redundancy, code quality, and sustainability pillars in one parallel pass.

**Architecture:** 5 agent streams across 2 waves. Wave 1 runs 4 streams in parallel worktrees (worker internals, frontend formatting, shared layer, CI/infra). Wave 2 runs 1 stream (barrel migration + validation) after Wave 1 merges. Each stream has exclusive file ownership — no cross-stream file conflicts.

**Tech Stack:** Next.js 16, React 19, TypeScript strict, Tailwind v4, Cloudflare Workers + D1, Vitest

**Design Spec:** `agents/specs/2026-04-06-comprehensive-remediation-design.md`
**Source Audit:** `agents/audits/comprehensive-codebase-audit-2026-04-06.md`

---

## Task 1: Stream 1 — Worker Internals (8 findings)

**Findings:** R-006, S-004, R-002, Q-001, Q-003, Q-009, S-002+Q-007, S-009

**Files:**
- Modify: `worker/src/cron/reserve-adapters/helpers.ts` (R-006 remove getAdapterTimeout, R-002 body cancel)
- Modify: 28 reserve adapter files in `worker/src/cron/reserve-adapters/` (R-006 call site replacement)
- Modify: `worker/src/cron/dex-liquidity/fetch-slipstream.ts` (S-004 viem subpath)
- Modify: `worker/src/cron/reserve-adapters/crvusd.ts` (S-004 viem subpath)
- Modify: `worker/src/cron/dex-liquidity/__tests__/fetch-slipstream.test.ts` (S-004 viem subpath)
- Modify: `worker/src/cron/reserve-adapters/__tests__/crvusd.test.ts` (S-004 viem subpath)
- Modify: `worker/src/lib/fetch-retry.ts`, `worker/src/lib/evm-logs.ts`, `worker/src/lib/alchemy-logs.ts`, `worker/src/cron/blacklist/tron-source.ts`, `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts`, `worker/src/api/backfill-depegs.ts` (R-002 body cancel)
- Modify: `worker/src/api/mint-burn-flows.ts` (Q-001 split handleAggregate)
- Modify: `worker/src/lib/alchemy-logs.ts`, `worker/src/cron/sync-stablecoin-charts.ts`, `worker/src/cron/dex-liquidity/scoring.ts`, `worker/src/cron/dex-liquidity/challenger-persistence.ts` (Q-003 catch comments)
- Modify: `worker/src/api/telegram-webhook.ts` (Q-009 auth warning)
- Create: `worker/src/lib/isolate-local-state.ts` (S-002)
- Modify: `worker/src/lib/rate-limit.ts`, `worker/src/lib/request-source-attribution.ts`, `worker/src/lib/api-keys.ts` (S-002 refactor)
- Modify: `worker/wrangler.toml`, `shared/lib/cron-jobs.ts`, `shared/lib/scheduled-runner-registry.ts`, `worker/src/handlers/scheduled.ts`, `worker/src/handlers/scheduled/daily-0800.ts`, `worker/src/handlers/scheduled/daily-0805.ts` (S-009)

### Step 1a: R-006 — Remove `getAdapterTimeout` definition

- [ ] **Remove the function from helpers.ts**

In `worker/src/cron/reserve-adapters/helpers.ts`, delete lines 136-140:

```typescript
// DELETE these lines:
const DEFAULT_ADAPTER_TIMEOUT_MS = 10_000;
/** Returns the adapter's explicit fallback timeout or the shared 10s default. */
export function getAdapterTimeout(config: LiveReservesConfig, fallbackMs = DEFAULT_ADAPTER_TIMEOUT_MS): number {
  void config;
  return fallbackMs;
}
```

- [ ] **Replace all 28 consumer call sites**

Find all call sites:
```bash
grep -rn "getAdapterTimeout" worker/src/cron/reserve-adapters/ --include="*.ts" | grep -v "__tests__" | grep -v "helpers.ts"
```

For each file, apply this transformation:
```typescript
// Before:
import { ..., getAdapterTimeout, ... } from "./helpers";
// ...
const timeout = getAdapterTimeout(config, 12_000);

// After:
import { ... } from "./helpers";  // remove getAdapterTimeout from import
// ...
const timeout = 12_000;
```

The literal value is always the second argument at each call site. Keep that exact value.

- [ ] **Remove from test imports if present**

```bash
grep -rn "getAdapterTimeout" worker/src/cron/reserve-adapters/__tests__/ --include="*.ts"
```

Remove any test assertions about getAdapterTimeout.

- [ ] **Verify R-006**

```bash
grep -r "getAdapterTimeout" worker/
```

Expected: 0 hits.

- [ ] **Commit R-006**

```bash
git add worker/src/cron/reserve-adapters/
git commit -m "refactor(reserves): remove no-op getAdapterTimeout wrapper (R-006)

Replace all 28 adapter call sites with the literal timeout value they
already pass. The function discarded its config parameter and always
returned the fallback.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Step 1b: S-004 — Tree-shake viem via subpath imports

- [ ] **Update viem imports in production files**

In `worker/src/cron/dex-liquidity/fetch-slipstream.ts` line 1:
```typescript
// Before:
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
// After:
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem/abi";
```

In `worker/src/cron/reserve-adapters/crvusd.ts` line 4:
```typescript
// Before:
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Abi } from "viem";
// After:
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Abi } from "viem/abi";
```

- [ ] **Update viem imports in test files**

```bash
grep -rn 'from "viem"' worker/src/cron/ --include="*.test.ts"
```

Apply the same `"viem"` → `"viem/abi"` change in each test file.

- [ ] **Verify S-004**

```bash
grep -rn 'from "viem"' worker/src/
```

Expected: 0 hits (worker/scripts/ may still have broad imports — that's acceptable).

- [ ] **Run tests**

```bash
cd worker && npx vitest run src/cron/dex-liquidity/__tests__/fetch-slipstream.test.ts src/cron/reserve-adapters/__tests__/crvusd.test.ts
```

Expected: all pass.

- [ ] **Commit S-004**

```bash
git add worker/src/cron/
git commit -m "perf(worker): use viem/abi subpath import for tree-shaking (S-004)

Narrow imports from 'viem' to 'viem/abi' in slipstream and crvusd
adapters. Enables bundler tree-shaking so only the ABI codec ships
in the deployed worker, not the full 48MB viem client.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Step 1c: R-002 — Replace inline body cancel with helper

- [ ] **Replace all inline `res.body?.cancel()` calls**

Find all sites:
```bash
grep -rn "\.body\?\.cancel()" worker/src/ --include="*.ts" | grep -v "response-body.ts" | grep -v "__tests__"
```

For each file, apply:
```typescript
// Before:
try { await res.body?.cancel(); } catch { }
// or:
await res.body?.cancel();

// After:
import { cancelResponseBodyQuietly } from "../../lib/response-body"; // adjust relative path
// ...
await cancelResponseBodyQuietly(res);
```

Add the import if not already present. Adjust the relative path based on file location. Remove the surrounding try/catch since the helper handles it internally.

- [ ] **Verify R-002**

```bash
grep -rn "\.body\?\.cancel()" worker/src/ --include="*.ts" | grep -v "response-body.ts"
```

Expected: 0 hits.

- [ ] **Run worker tests**

```bash
cd worker && npx vitest run
```

Expected: all pass.

- [ ] **Commit R-002**

```bash
git add worker/src/
git commit -m "refactor(worker): use cancelResponseBodyQuietly helper everywhere (R-002)

Replace 13+ inline await res.body?.cancel() calls with the centralized
helper that provides proper null guards and error swallowing.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Step 2: Q-001 — Split `handleAggregate`

- [ ] **Extract CoinFlowSummary interface**

Read `worker/src/api/mint-burn-flows.ts` fully. Find the inline type literal in the `coins` array (approximately lines 274-313). Extract it to a named interface at the top of the file:

```typescript
interface CoinFlowSummary {
  // Copy all fields from the inline type literal exactly
  id: string;
  name: string;
  // ... all other fields as found in the inline type
}
```

- [ ] **Extract `fetchAggregateData`**

Move the 11 parallel D1 queries (the large `Promise.all([...])` block) into a standalone function:

```typescript
async function fetchAggregateData(
  db: D1Database,
  params: { windowStart: number; window24h: number; window7d: number; window30d: number; window90d: number; baselineWindowStart: number; nowDayTs: number },
) {
  const [/* paste the destructured result names */] = await Promise.all([
    // paste all 11 queries exactly as they appear
  ]);
  return { /* named result object */ };
}
```

- [ ] **Extract `buildCoinSummaries`**

Move the per-coin iteration logic into a standalone function:

```typescript
function buildCoinSummaries(
  data: ReturnType<typeof fetchAggregateData> extends Promise<infer T> ? T : never,
  gradeClassification: FlightToQualityClassification | null,
): CoinFlowSummary[] {
  // paste the coin iteration logic
}
```

- [ ] **Slim down `handleAggregate`**

The remaining function should be ~50 lines: parse params → call fetchAggregateData → call buildCoinSummaries → serialize response.

- [ ] **Run tests**

```bash
cd worker && npx vitest run src/api/__tests__/mint-burn-flows
```

Expected: all existing tests pass unchanged.

- [ ] **Commit Q-001**

```bash
git add worker/src/api/mint-burn-flows.ts
git commit -m "refactor(api): split handleAggregate into focused functions (Q-001)

Extract CoinFlowSummary interface, fetchAggregateData() for the 11
parallel D1 queries, and buildCoinSummaries() for per-coin logic.
Reduces handleAggregate from 360 lines to ~50.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Step 3: Q-003 — Document silent catch blocks

- [ ] **Add comments and observability to catch blocks**

For `worker/src/lib/alchemy-logs.ts` (5 consecutive bare catches), add `console.debug`:
```typescript
// Before:
} catch { }
// After:
} catch (err) { console.debug("[alchemy] <operation> failed", err); }
```

For `worker/src/cron/sync-stablecoin-charts.ts:86`, `scoring.ts:119`, `challenger-persistence.ts:156`, add explanatory comments:
```typescript
// Before:
} catch { }
// After:
} catch { /* non-blocking: <explain why this is safe to swallow> */ }
```

Read each catch block's context to write an accurate explanation.

- [ ] **Commit Q-003**

```bash
git add worker/src/lib/alchemy-logs.ts worker/src/cron/
git commit -m "docs(worker): document silent catch blocks, add alchemy observability (Q-003)

Add console.debug to 5 consecutive bare catches in alchemy-logs so
systematic RPC failures become observable. Add explanatory comments
to other intentionally silent catch blocks.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Step 4: Q-009 — Telegram webhook auth warning

- [ ] **Add console.warn on auth failure**

In `worker/src/api/telegram-webhook.ts`, find the auth failure branch (approximately line 70-71) that returns `new Response("OK", { status: 200 })`. Add before the return:

```typescript
console.warn("[telegram-webhook] auth validation failed — returning 200 to prevent retry storm");
return new Response("OK", { status: 200 });
```

- [ ] **Commit Q-009**

```bash
git add worker/src/api/telegram-webhook.ts
git commit -m "fix(telegram): log warning on webhook auth failure (Q-009)

Add console.warn before the 200 OK response on auth failure. The 200
status is correct per Telegram webhook conventions (prevents retries),
but failed attempts were previously invisible.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Step 5: S-002+Q-007 — Extract `IsolateLocalState`

- [ ] **Create the utility**

Create `worker/src/lib/isolate-local-state.ts`:

```typescript
/**
 * Per-isolate mutable state container for Cloudflare Workers.
 *
 * Values persist across requests within the same Worker isolate but
 * reset on deployment or isolate recycle. State is NOT shared across
 * concurrent isolates — use for best-effort dedup, rate limiting, and
 * caching where cross-isolate consistency is not required.
 */
export class IsolateLocalState<T extends Record<string, unknown>> {
  private _state: T;

  constructor(private readonly _initial: () => T) {
    this._state = _initial();
  }

  get state(): T {
    return this._state;
  }

  /** Reset to initial values. For tests only. */
  reset(): void {
    this._state = this._initial();
  }
}
```

- [ ] **Refactor rate-limit.ts**

Replace the 7 module-level `let` variables with an IsolateLocalState instance:

```typescript
import { IsolateLocalState } from "./isolate-local-state";

const rateLimitState = new IsolateLocalState(() => ({
  lastPublicApiPruneBucket: null as number | null,
  publicApiPruneFailures: 0,
  feedbackPruneFailures: 0,
  consecutivePublicApiRateLimitFailures: 0,
  lastPublicApiRateLimitFailureAt: null as number | null,
  pendingPublicPrune: null as Promise<void> | null,
  pendingFeedbackPrune: null as Promise<void> | null,
}));
```

Then update all references from `lastPublicApiPruneBucket` to `rateLimitState.state.lastPublicApiPruneBucket`, etc.

Replace `resetRateLimitStateForTests()` with:
```typescript
export function resetRateLimitStateForTests(): void {
  rateLimitState.reset();
}
```

- [ ] **Refactor request-source-attribution.ts and api-keys.ts**

Apply the same pattern. Read each file to identify the module-level `let` variables and wrap them in an `IsolateLocalState` instance.

- [ ] **Run tests**

```bash
cd worker && npx vitest run src/lib/__tests__/rate-limit src/api/
```

Expected: all pass. The `resetRateLimitStateForTests()` API is preserved.

- [ ] **Commit S-002**

```bash
git add worker/src/lib/isolate-local-state.ts worker/src/lib/rate-limit.ts worker/src/lib/request-source-attribution.ts worker/src/lib/api-keys.ts
git commit -m "refactor(worker): extract IsolateLocalState for per-isolate mutable state (S-002)

Replace module-level let variables in rate-limit.ts (7 vars),
request-source-attribution.ts (2 vars), and api-keys.ts (2 vars)
with typed IsolateLocalState containers that document per-isolate
semantics explicitly.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Step 6: S-009 — Consolidate cron triggers

- [ ] **Merge daily-0805 into daily-0800 runner**

Read `worker/src/handlers/scheduled/daily-0800.ts` and `daily-0805.ts`. Export the 0805 runner logic as a callable function, then call it from the 0800 runner:

In `daily-0805.ts`, change the export to expose the inner logic:
```typescript
export async function runDaily0805Jobs(ctx: ScheduledRunnerContext): Promise<void> {
  // existing runner body
}
```

In `daily-0800.ts`, import and call after existing work:
```typescript
import { runDaily0805Jobs } from "./daily-0805";
// ... existing 0800 logic ...
await runDaily0805Jobs(ctx);
```

- [ ] **Remove daily0805Utc from wrangler.toml**

In `worker/wrangler.toml`, remove the `daily0805Utc` cron line (`5 8 * * *`). Result: 12 triggers.

- [ ] **Remove daily0805Utc from cron-jobs.ts**

In `shared/lib/cron-jobs.ts`, remove the `daily0805Utc` schedule key.

- [ ] **Remove daily0805Utc from scheduled-runner-registry.ts**

In `shared/lib/scheduled-runner-registry.ts`, remove the `daily0805Utc` runner key mapping.

- [ ] **Remove daily0805Utc from scheduled.ts dispatch**

In `worker/src/handlers/scheduled.ts`, remove `daily0805Utc` from `SLOT_RUNNER_BY_KEY`.

- [ ] **Verify S-009**

```bash
grep -c "crons" worker/wrangler.toml  # count cron lines
grep -r "daily0805" shared/ worker/ | grep -v "daily-0805.ts"
cd worker && npx tsc --noEmit
```

Expected: 12 cron triggers, 0 stale references outside daily-0805.ts, clean compile.

- [ ] **Commit S-009**

```bash
git add worker/wrangler.toml shared/lib/cron-jobs.ts shared/lib/scheduled-runner-registry.ts worker/src/handlers/
git commit -m "refactor(cron): consolidate daily0805 into daily0800 trigger (S-009)

Merge the two daily cron triggers into one, freeing a trigger slot
for future expansion. The 5-minute offset existed only to avoid a
minute collision, not for any functional dependency.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Stream 1 Final Verification

- [ ] **Run full worker checks**

```bash
cd worker && npx tsc --noEmit && npx vitest run
```

Expected: all pass.

---

## Task 2: Stream 2 — Frontend Components + Formatting (10 findings)

**Findings:** R-003, R-004, R-005, R-007, R-008, R-009, R-012, R-013, S-011, Q-002

### Step 1: Add `formatPercentFromRatio` to shared format

- [ ] **Write the test**

Add to `shared/lib/__tests__/format.test.ts`:

```typescript
describe("formatPercentFromRatio", () => {
  it("formats a ratio as a percentage", () => {
    expect(formatPercentFromRatio(0.1234)).toBe("12.34%");
    expect(formatPercentFromRatio(1)).toBe("100.00%");
    expect(formatPercentFromRatio(0)).toBe("0.00%");
  });

  it("respects decimal precision", () => {
    expect(formatPercentFromRatio(0.1234, 1)).toBe("12.3%");
    expect(formatPercentFromRatio(0.1234, 0)).toBe("12%");
  });

  it("returns dash for nullish", () => {
    expect(formatPercentFromRatio(null)).toBe("-");
    expect(formatPercentFromRatio(undefined)).toBe("-");
  });
});
```

- [ ] **Run test to verify it fails**

```bash
npx vitest run shared/lib/__tests__/format.test.ts -t "formatPercentFromRatio"
```

Expected: FAIL — `formatPercentFromRatio` not defined.

- [ ] **Implement the function**

Add to `shared/lib/format.ts` after `formatSignedPercent`:

```typescript
/**
 * Format a ratio (0-1 scale) as a percentage string.
 * Multiplies by 100 internally — callers should NOT pre-multiply.
 */
export function formatPercentFromRatio(
  ratio: number | null | undefined,
  decimals = 2,
): string {
  if (ratio == null) return "-";
  return `${(ratio * 100).toFixed(decimals)}%`;
}
```

- [ ] **Run test to verify it passes**

```bash
npx vitest run shared/lib/__tests__/format.test.ts -t "formatPercentFromRatio"
```

Expected: PASS.

- [ ] **Commit**

```bash
git add shared/lib/format.ts shared/lib/__tests__/format.test.ts
git commit -m "feat(format): add formatPercentFromRatio for ratio-to-percent display (R-003)

New shared formatter that multiplies by 100 internally, eliminating
the scattered \${(value * 100).toFixed(N)}% pattern across ~38 files.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Step 2a: S-011 — Extract component model files

- [ ] **Extract contagion-graph-model.ts**

Read `src/components/contagion-graph.tsx` (803 lines). Identify all pure data-transformation functions (no JSX, no React hooks). Move them to `src/components/contagion-graph-model.ts`. Import them back in the original component.

- [ ] **Extract dex-liquidity-card-model.ts**

Read `src/components/dex-liquidity-card.tsx` (680 lines). Extract pool aggregation, scoring tier computation, and sort/filter logic to `src/components/dex-liquidity-card-model.ts`.

- [ ] **Extract dews-summary-model.ts**

Read `src/components/dews-summary.tsx` (675 lines). Extract DEWS score derivation, tier classification, and trend computation to `src/components/dews-summary-model.ts`.

- [ ] **Extract yield-detail-section-model.ts**

Read `src/components/yield-detail-section.tsx` (642 lines). Extract yield data transformation, APY bucketing, and source classification to `src/components/yield-detail-section-model.ts`.

- [ ] **Assess stablecoin-table.tsx**

Read `src/components/stablecoin-table.tsx` (700 lines). It already has `stablecoin-table-logic.ts`. Check if further extraction is warranted. If the existing split is sufficient, skip.

- [ ] **Run build**

```bash
npm run build
```

Expected: clean build.

- [ ] **Commit S-011**

```bash
git add src/components/*-model.ts src/components/contagion-graph.tsx src/components/dex-liquidity-card.tsx src/components/dews-summary.tsx src/components/yield-detail-section.tsx
git commit -m "refactor(components): extract model files for large components (S-011)

Move pure data-transformation logic from contagion-graph (803 lines),
dex-liquidity-card (680), dews-summary (675), and yield-detail-section
(642) into companion *-model.ts files for independent testability.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Step 2b: Q-002 — Extract homepage sections

- [ ] **Create homepage-skeletons.tsx**

Create `src/components/homepage-skeletons.tsx` with the `ChartSkeleton` and `SectionSkeleton` components extracted from `homepage-client.tsx` lines ~33-120:

```typescript
import { Skeleton } from "@/components/ui/skeleton";

export function SectionSkeleton({ className }: { className: string }) {
  return <Skeleton className={className} />;
}

export function ChartSkeleton({
  className,
  type = "area",
  height = "h-[300px]",
}: {
  className?: string;
  type?: "area" | "bar" | "radar";
  height?: string;
}) {
  return (
    <div className={`relative overflow-hidden rounded-xl border border-border/50 bg-card/50 ${className}`}>
      {/* Copy the exact JSX from homepage-client.tsx ChartSkeleton */}
      {/* ... full implementation from lines 38-110 ... */}
    </div>
  );
}
```

Copy the full JSX exactly from the source file.

- [ ] **Create peg-distribution-grid.tsx**

Find the peg distribution section in `homepage-client.tsx` (the static grid with CEFI_COUNT, CEFI_DEP_COUNT, DEFI_COUNT and links). Extract to `src/components/peg-distribution-grid.tsx`.

- [ ] **Update homepage-client.tsx**

Replace the extracted sections with imports:
```typescript
import { ChartSkeleton, SectionSkeleton } from "./homepage-skeletons";
import { PegDistributionGrid } from "./peg-distribution-grid";
```

- [ ] **Verify homepage-client is under 400 lines**

```bash
wc -l src/components/homepage-client.tsx
```

Expected: under 400 lines.

- [ ] **Commit Q-002**

```bash
git add src/components/homepage-skeletons.tsx src/components/peg-distribution-grid.tsx src/components/homepage-client.tsx
git commit -m "refactor(homepage): extract skeletons and peg distribution grid (Q-002)

Split homepage-client.tsx (608 lines) into focused components:
homepage-skeletons.tsx for loading states and peg-distribution-grid.tsx
for the static governance breakdown section.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Step 3: R-003 + R-008 + R-009 — Replace inline formatting

- [ ] **Replace formatTreasuryPct (R-008)**

In `src/lib/treasury-table-utils.ts`, replace:
```typescript
// Before (lines 44-45):
export function formatTreasuryPct(value: number | null): string {
  return value == null ? "N/A" : `${value.toFixed(1)}%`;
}
// After:
import { formatPercent } from "@shared/lib/format";
// ... remove formatTreasuryPct, replace all call sites with formatPercent(value, 1)
```

Note: `formatPercent` returns "-" for null instead of "N/A". Check all call sites — if "N/A" is required, use: `value == null ? "N/A" : formatPercent(value, 1)`.

- [ ] **Replace formatRatioPct (R-009)**

In `src/lib/chain-ui.ts`, replace:
```typescript
// Before (lines 4-8):
export function formatRatioPct(value: number): string {
  const pct = value * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}
// After:
import { formatSignedPercent } from "@shared/lib/format";
// At each call site, replace formatRatioPct(value) with formatSignedPercent(value * 100, 2)
```

Update all consumers (grep for `formatRatioPct`).

- [ ] **Replace inline formatting across ~38 files (R-003)**

Find all inline sites:
```bash
grep -rn "\.toFixed.*%" src/ --include="*.ts" --include="*.tsx" | grep -v "__tests__" | grep -v "format.ts" | grep -v "node_modules"
```

For each site, determine the correct replacement:
- `${(value * 100).toFixed(N)}%` → `formatPercentFromRatio(value, N)`
- `${value.toFixed(N)}%` → `formatPercent(value, N)`
- `${sign}${value.toFixed(N)}%` → `formatSignedPercent(value, N)`

Add the appropriate import from `@shared/lib/format` to each file.

- [ ] **Verify R-003**

```bash
grep -rn "\.toFixed.*%" src/ --include="*.ts" --include="*.tsx" | grep -v "__tests__" | grep -v "format.ts" | grep -v "node_modules"
```

Expected: 0 hits.

- [ ] **Run build and tests**

```bash
npm run build && npm test
```

Expected: clean build, all tests pass.

- [ ] **Commit R-003 + R-008 + R-009**

```bash
git add src/ shared/lib/format.ts
git commit -m "refactor(format): replace ~38 inline percent patterns with shared formatters (R-003/R-008/R-009)

Eliminate formatTreasuryPct and formatRatioPct thin wrappers. Replace
all inline \${value.toFixed(N)}% patterns with formatPercent,
formatSignedPercent, or formatPercentFromRatio from shared/lib/format.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Step 4: Cleanup batch (R-004, R-005, R-007, R-012, R-013)

- [ ] **R-004: Remove duplicate format tests**

In `src/lib/__tests__/format.test.ts`, remove the test blocks for `formatCompactCount`, `formatTrackingSpanDays`, `formatTrackingSpanSeconds`, `formatNativePrice`, `formatDeathDate`. These are already tested in `shared/lib/__tests__/format.test.ts`.

- [ ] **R-005: Replace yield chart date formatters**

In `src/components/yield-history-chart-model.ts` (lines 73-89), replace:
```typescript
// Before:
const axisFormatter = new Intl.DateTimeFormat(...)
function formatAxisDate(ts: number, days: number) { ... }
function formatTooltipDate(ts: number) { ... }

// After:
import { formatChartDate } from "@shared/lib/format";
// At call sites:
//   formatAxisDate(ts, days) → formatChartDate(ts, days > 180 ? "compact" : "short")
//   formatTooltipDate(ts) → formatChartDate(ts, "full")
```

- [ ] **R-007: Inline formatHealthAge**

In `src/components/data-health-banner.tsx`, replace `formatHealthAge(worstAge)` with:
```typescript
import { formatElapsedSeconds } from "@shared/lib/format";
// ...
formatElapsedSeconds(worstAge / 1000)
```

In `src/lib/data-health.ts`, delete the `formatHealthAge` function (lines 163-166).

- [ ] **R-012: Document timestamp formatting scope**

In `src/lib/status-dashboard-model.ts`, add a comment above `formatTimestampSeconds`:
```typescript
/** Status-dashboard-scoped timestamp formatter. Not a candidate for shared extraction
 *  — the null-guard and locale pattern is trivially inlined. */
export function formatTimestampSeconds(...) { ... }
```

- [ ] **R-013: Remove unused export**

In `src/lib/stablecoin-url-codec.ts`, remove or unexport `isAmbiguousStablecoinSymbol` (lines 45-48). Update the test file if it imports this function.

- [ ] **Run tests**

```bash
npm test
```

Expected: all pass.

- [ ] **Commit cleanup batch**

```bash
git add src/
git commit -m "refactor(frontend): cleanup batch — dedup tests, formatters, dead exports (R-004/R-005/R-007/R-012/R-013)

Remove 5 duplicate format tests, map yield chart dates to shared
formatChartDate, inline formatHealthAge, document timestamp formatter
scope, and remove unused isAmbiguousStablecoinSymbol export.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Stream 2 Final Verification

- [ ] **Run full frontend checks**

```bash
npm run build && npm run lint && npm test
```

Expected: all pass.

---

## Task 3: Stream 3 — Shared Layer + Cross-Runtime (4 findings)

**Findings:** S-003, R-001, R-011, S-007

### Step 1a: S-003 — Consolidate `getConfiguredValue`

- [ ] **Create shared/lib/env-utils.ts**

```typescript
/**
 * Runtime-neutral environment binding resolution utilities.
 * Shared between worker (env.ts) and Pages Functions (ops-env.ts).
 */

/** Type guard: value is a non-empty string after trimming. */
export function hasConfiguredValue(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Returns the trimmed value if non-empty, otherwise null. */
export function getConfiguredValue(value: string | undefined): string | null {
  return hasConfiguredValue(value) ? value.trim() : null;
}
```

- [ ] **Update worker/src/lib/env.ts**

Remove the local `hasConfiguredValue` and `getConfiguredValue` (lines ~145-153). Add import:
```typescript
import { hasConfiguredValue, getConfiguredValue } from "@shared/lib/env-utils";
```

- [ ] **Update functions/lib/ops-env.ts**

Remove the local `getConfiguredValue` (lines ~48-52). Add import:
```typescript
import { getConfiguredValue } from "@shared/lib/env-utils";
```

- [ ] **Run type checks**

```bash
npm run build && cd worker && npx tsc --noEmit
```

Expected: both pass.

- [ ] **Commit S-003**

```bash
git add shared/lib/env-utils.ts worker/src/lib/env.ts functions/lib/ops-env.ts
git commit -m "refactor(shared): consolidate getConfiguredValue into shared/lib/env-utils (S-003)

Move the duplicated null/empty/trim binding check from worker env.ts
and functions ops-env.ts into a shared runtime-neutral module.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Step 1b: R-001 — Extract proxy helpers

- [ ] **Create functions/lib/proxy-utils.ts**

```typescript
/**
 * Shared proxy utilities for Cloudflare Pages Function proxy handlers.
 */

export function jsonError(status: number, message: string, headers?: HeadersInit): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

export function summarizeFetchError(error: unknown): { kind: string; message: string } {
  if (error instanceof DOMException) {
    return { kind: error.name, message: error.message };
  }
  if (error instanceof Error) {
    return { kind: error.name, message: error.message };
  }
  return { kind: typeof error, message: String(error) };
}

export function buildUpstreamHeaders(
  request: Request,
  forwardedHeaders: readonly string[],
  authHeaders: Record<string, string>,
): Headers {
  const headers = new Headers();
  for (const headerName of forwardedHeaders) {
    const value = request.headers.get(headerName);
    if (value) headers.set(headerName, value);
  }
  for (const [key, value] of Object.entries(authHeaders)) {
    headers.set(key, value);
  }
  return headers;
}

export function buildProxyResponse(
  upstreamResponse: Response,
  forwardedHeaders: readonly string[],
  options?: { method?: string; defaultCacheControl?: string },
): Response {
  const headers = new Headers();
  for (const headerName of forwardedHeaders) {
    const value = upstreamResponse.headers.get(headerName);
    if (value) headers.set(headerName, value);
  }
  if (!headers.has("Cache-Control") && options?.defaultCacheControl) {
    headers.set("Cache-Control", options.defaultCacheControl);
  }
  const isHead = options?.method === "HEAD";
  return new Response(isHead ? null : upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}
```

- [ ] **Update functions/api/admin/[[path]].ts**

Remove local `jsonError`, `summarizeFetchError`, `buildProxyResponse`. Import from proxy-utils. Refactor `buildUpstreamHeaders` to use the shared version:

```typescript
import { jsonError, summarizeFetchError, buildUpstreamHeaders, buildProxyResponse } from "../../lib/proxy-utils";
```

Adapt the call sites to pass the forwarded-header arrays and auth headers as parameters.

- [ ] **Update functions/_site-data/[[path]].ts**

Same approach. Remove local definitions, import from proxy-utils.

- [ ] **Run functions tests**

```bash
npx vitest run functions/
```

Expected: all pass.

- [ ] **Commit R-001**

```bash
git add functions/
git commit -m "refactor(functions): extract shared proxy helpers to functions/lib/proxy-utils (R-001)

Consolidate jsonError, summarizeFetchError, buildUpstreamHeaders, and
buildProxyResponse from the two proxy handlers into a shared module
with parameterized header allowlists.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Step 1c: R-011 — Document ID validation scope

- [ ] **Add JSDoc to isKnownCoinId**

In `shared/lib/validate-coin-id.ts`, add:
```typescript
/**
 * Check whether a coin ID is in the tracked stablecoins set.
 * Excludes shadow stablecoins (PSI phantom assets). For shadow-inclusive
 * validation, use REGISTRY_BY_ID.has() from stablecoin-id-registry.ts.
 */
export function isKnownCoinId(id: string): boolean { ... }
```

- [ ] **Commit R-011**

```bash
git add shared/lib/validate-coin-id.ts
git commit -m "docs(shared): clarify isKnownCoinId excludes shadow stablecoins (R-011)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Step 2: S-007 — Split `api-endpoints.ts`

- [ ] **Read and analyze the file**

Read `shared/lib/api-endpoints.ts` fully (999 lines). Identify the 4 logical sections:
1. **Definitions** — endpoint registry types and the ENDPOINTS array
2. **Paths** — API_PATHS builder and path construction helpers
3. **Validation** — method validation, query parameter construction
4. **Status** — status-page action extraction, admin path matching

- [ ] **Create sub-module directory and files**

```bash
mkdir -p shared/lib/api-endpoints
```

Create 4 sub-modules by moving the appropriate code:
- `shared/lib/api-endpoints/definitions.ts`
- `shared/lib/api-endpoints/paths.ts`
- `shared/lib/api-endpoints/validation.ts`
- `shared/lib/api-endpoints/status.ts`

Handle cross-references between sub-modules with explicit imports.

- [ ] **Create barrel re-export**

Create `shared/lib/api-endpoints/index.ts`:
```typescript
export * from "./definitions";
export * from "./paths";
export * from "./validation";
export * from "./status";
```

- [ ] **Delete original file**

```bash
rm shared/lib/api-endpoints.ts
```

- [ ] **Verify all imports resolve**

```bash
npm run build && cd worker && npx tsc --noEmit
```

The barrel at `api-endpoints/index.ts` makes existing `@shared/lib/api-endpoints` imports resolve unchanged.

Expected: both pass with zero errors.

- [ ] **Run tests**

```bash
npm test
```

Expected: all pass.

- [ ] **Commit S-007**

```bash
git add shared/lib/api-endpoints/ shared/lib/api-endpoints.ts
git commit -m "refactor(shared): split api-endpoints.ts into sub-modules (S-007)

Decompose the 999-line monolith into definitions, paths, validation,
and status sub-modules. Barrel re-export at index.ts preserves all
existing import paths — zero consumer changes needed.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Stream 3 Final Verification

- [ ] **Run full checks**

```bash
npm run build && npm run lint && npm test && cd worker && npx tsc --noEmit
```

Expected: all pass.

---

## Task 4: Stream 4 — Build/CI/Docs/Infra (8 findings)

**Findings:** S-005, S-006, S-008, S-010, S-012, S-013, S-014, Q-008

### Step 1: S-005 — PR change detection

- [ ] **Update pull-request-checks.yml**

Read `.github/workflows/pull-request-checks.yml` and `.github/workflows/deploy-cloudflare.yml` (the `detect-changes` job). Add a similar `detect-changes` job to the PR workflow that uses the existing `scripts/classify-deploy-changes.mjs`:

```yaml
jobs:
  detect-changes:
    runs-on: ubuntu-latest
    outputs:
      pages_changed: ${{ steps.classify.outputs.pages_changed }}
      worker_changed: ${{ steps.classify.outputs.worker_changed }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: "22.x"
      - id: classify
        run: node scripts/classify-deploy-changes.mjs
        env:
          GITHUB_OUTPUT: ${{ github.output }}

  validate:
    needs: detect-changes
    uses: ./.github/workflows/validate-ci.yml
    with:
      pages_changed: ${{ needs.detect-changes.outputs.pages_changed == 'true' }}
      worker_changed: ${{ needs.detect-changes.outputs.worker_changed == 'true' }}
```

Read the actual workflow files to match the exact structure and input names.

- [ ] **Commit S-005**

```bash
git add .github/workflows/pull-request-checks.yml
git commit -m "ci: add change detection to PR checks, skip unnecessary builds (S-005)

Mirror the deploy workflow's detect-changes step so docs-only or
agents-only PRs skip the full Pages build and worker typecheck.
Saves 3-5 minutes on non-deploy-impacting PRs.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Step 2: S-006 — Auto-generate sitemap dates

- [ ] **Create the generator script**

Create `scripts/generate-sitemap-dates.ts`:

```typescript
import { execSync } from "node:child_process";
import { readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const APP_DIR = join(import.meta.dirname, "../src/app");
const OUTPUT = join(import.meta.dirname, "../src/generated/sitemap-dates.json");

function getPageDirs(): string[] {
  const entries = readdirSync(APP_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .filter((e) => {
      const pagePath = join(APP_DIR, e.name, "page.tsx");
      try { statSync(pagePath); return true; } catch { return false; }
    })
    .map((e) => e.name);
}

function getLastModified(pagePath: string): string {
  try {
    const date = execSync(`git log -1 --format=%aI -- "${pagePath}"`, { encoding: "utf-8" }).trim();
    return date || new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

const dates: Record<string, string> = {};
for (const dir of getPageDirs()) {
  const pagePath = join(APP_DIR, dir, "page.tsx");
  const route = `/${dir}/`;
  dates[route] = getLastModified(pagePath);
}

mkdirSync(join(import.meta.dirname, "../src/generated"), { recursive: true });
writeFileSync(OUTPUT, JSON.stringify(dates, null, 2) + "\n");
console.log(`Generated sitemap dates for ${Object.keys(dates).length} pages → ${OUTPUT}`);
```

- [ ] **Update prebuild script**

In `package.json`, update the prebuild script:
```json
"prebuild": "tsx scripts/generate-redirects.ts && tsx scripts/generate-sitemap-dates.ts"
```

- [ ] **Update sitemap.ts**

In `src/app/sitemap.ts`, replace the hardcoded `LAST_EDITED` map:
```typescript
// Before:
const LAST_EDITED: Record<string, string> = {
  "/about/": "2026-03-10",
  // ... 30+ entries
};

// After:
import sitemapDates from "@/generated/sitemap-dates.json";
const LAST_EDITED: Record<string, string> = sitemapDates;
```

- [ ] **Run build to test**

```bash
npm run build
```

Expected: prebuild generates dates, build succeeds.

- [ ] **Commit S-006**

```bash
git add scripts/generate-sitemap-dates.ts src/app/sitemap.ts src/generated/sitemap-dates.json package.json
git commit -m "feat(build): auto-generate sitemap lastModified dates from git (S-006)

Replace 30+ hardcoded LAST_EDITED dates with a prebuild script that
reads git log for each page route. Falls back to current date if git
history is unavailable (e.g. shallow clone).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Step 3: S-010 — Cache blob size telemetry

- [ ] **Add getCacheBlobSizes to d1-usage.ts**

Read `worker/src/lib/status/d1-usage.ts`. Add:

```typescript
export async function getCacheBlobSizes(db: D1Database): Promise<Record<string, number>> {
  const rows = await db
    .prepare("SELECT key, LENGTH(value) as bytes FROM cache")
    .all<{ key: string; bytes: number }>();
  const sizes: Record<string, number> = {};
  for (const row of rows.results ?? []) {
    sizes[row.key] = row.bytes;
  }
  return sizes;
}
```

- [ ] **Surface in status endpoint**

Read `worker/src/lib/status/` to find where D1 usage is assembled. Add `cacheSizes` to the status response payload by calling `getCacheBlobSizes(db)` alongside existing D1 metrics.

- [ ] **Commit S-010**

```bash
git add worker/src/lib/status/d1-usage.ts worker/src/lib/db-cache.ts
git commit -m "feat(status): add cache blob size telemetry (S-010)

Track bytes per cache key in the status endpoint so D1 blob growth
toward the 2MB row limit can be monitored proactively.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Step 4: S-013 — Improve hotspot ratchet error message

- [ ] **Update error output**

In `scripts/check-hotspot-ratchet.mjs`, find the error reporting section. Add remediation suggestion:

```javascript
// After listing regressions, add:
console.error("");
console.error("If these changes are intentional, update the baseline:");
console.error("  npm run check:hotspot-ratchet:update-baseline");
```

- [ ] **Commit S-013**

```bash
git add scripts/check-hotspot-ratchet.mjs
git commit -m "dx: suggest baseline update command on hotspot ratchet failure (S-013)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Step 5: S-014 — Local dev setup in README

- [ ] **Add development setup section**

In `README.md`, add after the existing setup instructions:

```markdown
## Local Development Setup

### Frontend-only (`npm run dev`)

Minimum env vars:
- `NEXT_PUBLIC_API_BASE_URL` — point to production (`https://api.pharos.watch`) or local worker (`http://localhost:8787`)

### Worker-only (`cd worker && npx wrangler dev`)

Requires D1 bindings and external API keys. See `worker/src/lib/env.ts` for the full binding contract and `.env.example` for all available keys.

### Full-stack local

Both sets above. Run `npm run dev` and `cd worker && npx wrangler dev` in separate terminals.
```

- [ ] **Commit S-014**

```bash
git add README.md
git commit -m "docs: add local development setup guide to README (S-014)

Map three development scenarios (frontend-only, worker-only, full-stack)
to their minimum required environment variables.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Step 6: S-008 — Methodology doc-sync improvements

- [ ] **Improve sync-check error messages**

Read the methodology manifest check script. Find where version/weight mismatches are reported. Update error messages to include both expected and actual values:

```
Methodology drift detected:
  PSI version: expected="3.2" actual="3.1" (source: shared/lib/psi.ts:VERSION)
  Fix: update docs/methodology.md line 42 to match the code value
```

This makes fixing drift a copy-paste operation.

- [ ] **Commit S-008**

```bash
git add scripts/ docs/
git commit -m "dx: improve methodology sync-check error messages with expected values (S-008)

Include both expected and actual values plus source file references
in drift errors, making fixes a copy-paste operation.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Step 7: S-012 + Q-008 — Documentation additions

- [ ] **S-012: Add PostCSS mention**

Find the architecture docs (e.g., `docs/architecture.md` or similar). Add:
```markdown
### CSS Pipeline
Tailwind CSS v4 via PostCSS (`postcss.config.mjs`). Styles are purged at build time — Tailwind classes must be static strings (never dynamically constructed).
```

- [ ] **Q-008: Document `!= null` convention**

In the same docs file or a coding conventions section:
```markdown
### Null/Undefined Guards
The worker codebase uses `!= null` (loose equality) throughout for D1 query result guards. This deliberately coalesces both `null` and `undefined` checks into one expression. This is a deliberate convention, not a lint oversight.
```

- [ ] **Commit docs**

```bash
git add docs/
git commit -m "docs: add PostCSS pipeline and != null convention notes (S-012/Q-008)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Stream 4 Final Verification

- [ ] **Run build and worker typecheck**

```bash
npm run build && cd worker && npx tsc --noEmit
```

Expected: both pass.

---

## Task 5: Stream 5 (Wave 2) — Barrel Export Migration + Validation (1 finding)

**Finding:** S-015
**Prerequisite:** All Wave 1 streams merged to working branch.

### Step 1: Build type→submodule mapping

- [ ] **Inventory all submodules**

```bash
ls shared/types/*.ts | grep -v index.ts
```

Expected: 16 files. Read each to catalog all exported types.

- [ ] **Build the mapping**

Create a local lookup: for each type name, record which submodule exports it. Example:
```
StablecoinListResponse → market
HealthResponse → status
ReportCard → report-cards
CoreStablecoinId → core
```

### Step 2: Rewrite barrel imports

- [ ] **Find all barrel imports**

```bash
grep -rn 'from "@shared/types"' --include="*.ts" --include="*.tsx" | grep -v "index.ts" | grep -v node_modules
```

Record the exact count.

- [ ] **Process by directory batch**

Work through directories in order: `src/lib/` → `src/components/` → `src/hooks/` → `src/app/` → `worker/` → `shared/` → `functions/`.

For each file, rewrite:
```typescript
// Before:
import type { StablecoinListResponse, HealthResponse } from "@shared/types";

// After:
import type { StablecoinListResponse } from "@shared/types/market";
import type { HealthResponse } from "@shared/types/status";
```

If a single import pulls types from multiple submodules, split into separate import statements.

- [ ] **Add deprecation comment to barrel**

In `shared/types/index.ts`, add at the top:
```typescript
/**
 * @deprecated Import from specific submodules instead:
 *   import type { Foo } from "@shared/types/core";
 * This barrel re-export is preserved for backward compatibility
 * but should not be used in new code.
 */
```

- [ ] **Verify S-015**

```bash
grep -c 'from "@shared/types"' --include="*.ts" --include="*.tsx" -r src/ worker/ shared/ functions/ | grep -v ":0$" | grep -v "index.ts"
```

Expected: 0 hits.

- [ ] **Commit S-015**

```bash
git add .
git commit -m "refactor(types): migrate barrel imports to specific submodule imports (S-015)

Rewrite ~250 barrel imports from @shared/types to their specific
submodules (@shared/types/market, @shared/types/core, etc.) for
better tree-shaking and IDE performance. Deprecate the barrel with
a JSDoc comment.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Step 3: Full validation

- [ ] **Run complete validation suite**

```bash
npm run lint
npm run build
npm test
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

ALL must pass with zero errors.

- [ ] **Completeness audit**

Verify each finding has a corresponding change:

| Finding | Verification |
|---------|-------------|
| R-001 | `functions/lib/proxy-utils.ts` exists |
| R-002 | `grep -rn "\.body\?\.cancel()" worker/src/` hits only `response-body.ts` |
| R-003 | `grep -rn "\.toFixed.*%" src/` returns 0 non-test hits |
| R-004 | `src/lib/__tests__/format.test.ts` has no `formatCompactCount` block |
| R-005 | `grep "Intl.DateTimeFormat" src/components/yield-history-chart-model.ts` returns 0 |
| R-006 | `grep -r "getAdapterTimeout" worker/` returns 0 |
| R-007 | `grep "formatHealthAge" src/` returns 0 |
| R-008 | `grep "formatTreasuryPct" src/` returns 0 |
| R-009 | `grep "formatRatioPct" src/` returns 0 |
| R-011 | `shared/lib/validate-coin-id.ts` has JSDoc on `isKnownCoinId` |
| R-012 | `src/lib/status-dashboard-model.ts` has scope comment |
| R-013 | `grep "isAmbiguousStablecoinSymbol" src/lib/stablecoin-url-codec.ts` returns 0 exports |
| Q-001 | `wc -l worker/src/api/mint-burn-flows.ts` shows `handleAggregate` under 60 lines |
| Q-002 | `wc -l src/components/homepage-client.tsx` under 400 |
| Q-003 | `grep -c "catch {}" worker/src/lib/alchemy-logs.ts` returns 0 (all have comments or debug) |
| Q-009 | `grep "console.warn" worker/src/api/telegram-webhook.ts` returns 1 hit |
| S-002 | `worker/src/lib/isolate-local-state.ts` exists |
| S-003 | `shared/lib/env-utils.ts` exists |
| S-004 | `grep 'from "viem"' worker/src/` returns 0 |
| S-005 | `.github/workflows/pull-request-checks.yml` has `detect-changes` job |
| S-006 | `scripts/generate-sitemap-dates.ts` exists |
| S-007 | `shared/lib/api-endpoints/index.ts` exists |
| S-008 | Methodology sync errors include expected values |
| S-009 | `grep -c "crons" worker/wrangler.toml` shows 12 |
| S-010 | `grep "getCacheBlobSizes" worker/src/lib/status/d1-usage.ts` returns 1 |
| S-011 | Model files exist for 4 large components |
| S-012 | Docs mention PostCSS/Tailwind v4 |
| S-013 | Hotspot ratchet suggests update command |
| S-014 | README has "Local Development Setup" section |
| S-015 | Barrel imports return 0 outside index.ts |
| Q-008 | Docs mention `!= null` convention |

- [ ] **Report completion**

All 32 findings remediated. Merge gate passes. Ready for push.
