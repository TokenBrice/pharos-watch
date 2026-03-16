# Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate all 40 findings from the 2026-03-15 comprehensive codebase audit across redundancy, code quality, and sustainability pillars.

**Architecture:** Work proceeds in 6 chunks from lowest-risk to highest. Each chunk is independently mergeable. Chunks 1-2 are quick wins requiring no new abstractions. Chunks 3-4 add tests and type safety. Chunks 5-6 are structural refactors that existing tests validate.

**Tech Stack:** TypeScript strict, Vitest, Zod v4, Cloudflare Workers, D1

**Audit report:** `agents/audits/codebase-audit-comprehensive-2026-03-15.md`

**Excluded findings (no code change):**
- S05: Deferred (>200 coin trigger)
- S06: Deferred (>60 endpoint trigger)
- S10: Acknowledged TOCTOU trade-off
- S17: Deferred migration squash (milestone trigger)
- S02: Manual worktree cleanup (`git worktree list --porcelain | ...`)
- S21: Deferred (Miniflare setup is a standalone project)

---

## File Structure

### Files to Create
| Path | Responsibility | Finding |
|------|---------------|---------|
| `shared/lib/yield-scoring.ts` | PYS formula constants + `computePysComponents()` | R03 |
| `shared/lib/__tests__/yield-scoring.test.ts` | PYS formula unit tests | R03 |
| `shared/lib/__tests__/report-cards.test.ts` | Report card scoring tests | Q03 |
| `shared/lib/__tests__/peg-score.test.ts` | Peg score computation tests | Q03 |
| `shared/lib/__tests__/redemption-backstop-scoring.test.ts` | Effective exit score tests | Q03 |
| `shared/lib/__tests__/supply.test.ts` | Supply helper tests | Q16 |
| `shared/lib/__tests__/peg-utils.test.ts` | Depeg utility tests | Q16 |
| `worker/src/lib/external-api-schemas.ts` | Zod schemas for external APIs | Q11 |
| `worker/src/cron/telegram-alert-snapshots.ts` | Snapshot diff extraction | Q05 |
| `worker/src/cron/telegram-pending-queue.ts` | Pending queue management | Q05 |
| `worker/src/api/backfill-fx.ts` | FX rate fetching helpers | Q04 |
| `worker/src/api/backfill-price-sources.ts` | CG/DL price history fetching | Q04 |
| `worker/src/cron/enrich-prices-passes.ts` | Extracted enrichment passes | Q14 |

### Files to Delete
| Path | Reason | Finding |
|------|--------|---------|
| `src/lib/sort-utils.ts` | Dead code (superseded by `createTableComparator`) | R01 |
| `src/lib/__tests__/sort-utils.test.ts` | Test for dead code | R01 |

### Files to Modify
~45 files across all remaining findings (detailed per-task below).

---

## Chunk 1: Quick Wins — Dead Code & Import Consolidation

### Task 1: Remove Dead Code (R01, R06, R07, R08, R09, R10)

**Files:**
- Delete: `src/lib/sort-utils.ts`
- Delete: `src/lib/__tests__/sort-utils.test.ts`
- Modify: `shared/lib/pricing-pipeline-version.ts`
- Modify: `shared/lib/redemption-backstop-version.ts`
- Modify: `shared/lib/supply.ts`
- Modify: `worker/src/lib/dex-liquidity.ts`
- Modify: `shared/lib/time-constants.ts`

- [ ] **Step 1: Delete `sort-utils.ts` and its test (R01)**

Delete both files:
- `src/lib/sort-utils.ts`
- `src/lib/__tests__/sort-utils.test.ts`

- [ ] **Step 2: Unexport dead version symbols (R06, R07)**

In `shared/lib/pricing-pipeline-version.ts`, remove the `export` keyword from:
```typescript
// Line 46: change to
const PRICING_PIPELINE_VERSION = pricing.currentVersion;
// Line 58: change to
const getPricingPipelineVersionAt = pricing.getVersionAt;
```

In `shared/lib/redemption-backstop-version.ts`, remove `export` from:
```typescript
// Line 35: change to
const getRedemptionBackstopVersionAt = redemptionBackstop.getVersionAt;
```

- [ ] **Step 3: Remove dead `getPrevMonthRaw` export (R08)**

In `shared/lib/supply.ts`, remove lines 47-49 (`getPrevMonthRaw` function). In `src/lib/__tests__/supply.test.ts`, remove the `getPrevMonthRaw` import (line 9) and the entire `describe("getPrevMonthRaw", ...)` block (lines 183-195) — `getPrevMonthRawOrNull` is already tested separately at line 197+. Do NOT replace `getPrevMonthRaw` calls with `getPrevMonthRawOrNull` — they have different semantics (returns 0 vs null for no data).

- [ ] **Step 4: Unexport `DexLiquiditySnapshot`, rename `DexLiquidityMap` (R09)**

In `worker/src/lib/dex-liquidity.ts`:
```typescript
// Line 11: remove export
type DexLiquiditySnapshot = Pick<...>;
// Line 16: rename to avoid shadowing shared type
type DexLiquidityDbMap = Record<string, DexLiquiditySnapshot>;
```
Update all references to `DexLiquidityMap` within the same file to `DexLiquidityDbMap`.

- [ ] **Step 5: Unexport file-internal time constants (R10)**

In `shared/lib/time-constants.ts`:
```typescript
// Line 2: remove export
const MINUTES_PER_HOUR = 60;
// Line 4: remove export
const MS_PER_SECOND = 1000;
```

- [ ] **Step 6: Verify build passes**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: Clean build, no errors.

- [ ] **Step 7: Run tests**

Run: `npm test`
Expected: All tests pass. `sort-utils.test.ts` no longer runs (file deleted).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: remove dead code and unexport unused symbols

Addresses R01, R06, R07, R08, R09, R10 from codebase audit."
```

---

### Task 2: Import Consolidation (R02, R04, R05, R11, R12, R14, R15)

**Files:**
- Modify: `worker/src/lib/status-reliability.ts`
- Modify: `worker/src/api/audit-depeg-history.ts` (R04: response helpers; R12: DAY_SECONDS)
- Modify: `worker/src/lib/telegram-alerts.ts`
- Modify: `worker/src/api/stablecoin-detail.ts`
- Modify: `worker/src/api/backfill-depegs.ts`
- Modify: `worker/src/api/backfill-stability-index.ts`
- Modify: `worker/src/api/backfill-dews.ts`
- Modify: `worker/src/api/mint-burn-flows-shared.ts`
- Modify: `worker/src/api/mint-burn-flows.ts` (imports `DAY_SEC` from shared)
- Modify: `worker/src/lib/psi-recompute.ts`
- Modify: `src/lib/__tests__/peg-scoring.test.ts`
- Modify: `worker/src/cron/dispatch-telegram-alerts.ts` (imports `DepegEvent`)
- Modify: `src/components/stablecoin-detail/redemption-backstop-card.tsx`
- Modify: `src/components/status/discovery-candidates.tsx`
- Modify: `src/components/yield-detail-section.tsx`

- [ ] **Step 1: Replace `clampConfidence` with shared `clamp` (R02)**

In `worker/src/lib/status-reliability.ts`:
1. Add import: `import { clamp } from "@shared/lib/math";`
2. Replace the `clampConfidence` function body (lines 75-78). Keep the `!Number.isFinite` guard because the shared `clamp` returns `max` (1.0) for +Infinity, while the current function returns `min` (0.1) — a semantic difference for corrupt data:
```typescript
export function clampConfidence(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0.1;
  return clamp(confidence, 0.1, 1);
}
```
Keep the function name as a semantic alias for readability at call sites.

- [ ] **Step 2: Replace raw `Response` calls with `jsonResponse`/`errorResponse` (R04)**

In `worker/src/api/audit-depeg-history.ts`:
1. **Add** `jsonResponse` and `errorResponse` to the existing import: `import { withErrorHandler, parseIntParam, jsonResponse, errorResponse } from "../lib/api-utils";` (they are NOT currently imported)
2. **Keep** the 405 response (line 62-65) as-is — `errorResponse` does not support the `Allow` header required by HTTP 405.
3. Replace error responses:
   - Line 94-96: → `return errorResponse(404, "No matching events found");`
4. Replace JSON responses (note: loses pretty-printing `JSON.stringify(result, null, 2)` — acceptable for admin endpoints):
   - Lines 100-104, 120-124, 305: → `return jsonResponse(result);`

- [ ] **Step 3: Rename telegram `DepegEvent` to `DepegAlertPayload` (R05)**

In `worker/src/lib/telegram-alerts.ts`, rename the interface at lines 180-187:
```typescript
export interface DepegAlertPayload {
  stablecoinId: string;
  symbol: string;
  direction: "above" | "below";
  deviationBps: number;
  price: number;
  pegReference: number;
}
```
Then find and update **all** references to this type. Consumers include:
- `worker/src/lib/telegram-alerts.ts` — definition + internal usages
- `worker/src/cron/dispatch-telegram-alerts.ts` — import on line 15, usage at lines 89 (`type DepegSnapshot = Record<string, DepegAlertPayload>`) and 714 (`const depegTriggered: DepegAlertPayload[]`)

Run: `grep -rn "DepegEvent" worker/src/ --include="*.ts" | grep -v __tests__`

- [ ] **Step 4: Replace inline `safeRecordOutcome` with `recordOutcomeSafe` (R11)**

In `worker/src/api/stablecoin-detail.ts`:
1. **Change** the import on line 5 from `import { recordOutcome, shouldAttemptFetch } from "../lib/circuit-breaker";` to `import { recordOutcomeSafe, shouldAttemptFetch } from "../lib/circuit-breaker";` (replace `recordOutcome` with `recordOutcomeSafe` — `recordOutcome` becomes unused once the closure is removed).
2. Remove the inline `safeRecordOutcome` closure (lines 43-49).
3. Replace all 6 call sites from `safeRecordOutcome(source, success)` to `recordOutcomeSafe(db, source, success)`. The `db` parameter is available as the first argument to the `withErrorHandler` callback.

- [ ] **Step 5: Replace 7 local `DAY = 86400` with `DAY_SECONDS` import (R12)**

In each of these files, remove the local `const DAY = 86400` (or `const DAY_SEC = 86400`) and add `import { DAY_SECONDS } from "@shared/lib/time-constants";`. Then replace all usages of `DAY` / `DAY_SEC` with `DAY_SECONDS`:

1. `worker/src/api/backfill-depegs.ts:266`
2. `worker/src/api/backfill-stability-index.ts:29`
3. `worker/src/api/backfill-dews.ts:71`
4. `worker/src/api/mint-burn-flows-shared.ts:45` — **WARNING: `DAY_SEC` is exported here and imported by `worker/src/api/mint-burn-flows.ts` (line 50)**. Replace the export with `export { DAY_SECONDS as DAY_SEC } from "@shared/lib/time-constants";` to preserve the consumer API, OR also update `mint-burn-flows.ts` to import `DAY_SECONDS` directly.
5. `worker/src/api/audit-depeg-history.ts:18`
6. `worker/src/lib/psi-recompute.ts:3`
7. `src/lib/__tests__/peg-scoring.test.ts:29` — Note: this file uses `DAY` ~90 times and defines `const YEAR = 365.25 * DAY;`. Perform a global find-replace of `\bDAY\b` → `DAY_SECONDS` after adding the import, then update `YEAR` to `365.25 * DAY_SECONDS`.

- [ ] **Step 6: Replace local format functions with shared `formatCurrency` (R14)**

In `src/components/stablecoin-detail/redemption-backstop-card.tsx`:
1. Add import: `import { formatCurrency } from "@shared/lib/format";`
2. Replace `formatCapacityUsd` (lines 15-21) with:
```typescript
function formatCapacityUsd(value: number | null): string | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return formatCurrency(value, 1);
}
```

In `src/components/status/discovery-candidates.tsx`:
**Keep the local `formatMcap` as-is** — it is NOT a true duplicate. For values < 1M, the local uses `$${mcap.toLocaleString()}` (thousands separators, e.g. "$123,456") while `formatCurrency` returns `$123.5K`. These produce visually different results. This finding (R14 for this file) is a false positive.

- [ ] **Step 7: Replace local `formatSignedPercent` with shared import (R15)**

In `src/components/yield-detail-section.tsx`:
1. Add import: `import { formatSignedPercent as sharedFormatSignedPercent } from "@shared/lib/format";`
2. Replace the local function (lines 46-50) with:
```typescript
function formatSignedPercent(value: number | null) {
  if (value === null) return "—";
  return sharedFormatSignedPercent(value);
}
```
Note: If the shared version uses `-` for null and this component needs `—`, keep the wrapper.

- [ ] **Step 8: Verify build passes**

Run: `npm run build && cd worker && npx tsc --noEmit`

- [ ] **Step 9: Run tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: consolidate duplicate imports and format functions

Addresses R02, R04, R05, R11, R12, R14, R15 from codebase audit."
```

---

### Task 3: Config & Naming Fixes (S09, Q09, Q07)

**Files:**
- Modify: `worker/tsconfig.json`
- Modify: `worker/src/cron/sync-blacklist.ts`
- Modify: `shared/lib/report-cards.ts`

- [ ] **Step 1: Remove frontend path alias from worker tsconfig (S09)**

In `worker/tsconfig.json`, remove the `"@/*": ["../src/*"]` line from `paths`:
```json
    "paths": {
      "@shared/*": ["../shared/*"]
    }
```

- [ ] **Step 2: ~~Rename `itemCount` to `rowsInserted`~~ — ABANDONED (Q09)**

**Do NOT rename** `itemCount`. It is part of the shared `CronResult` interface used by `logCronRun()` in `worker/src/lib/cron-logger.ts` (line 137: reads `resolvedResult?.itemCount`). Renaming it only in `SyncBlacklistResult` would break the cron infrastructure contract, causing `item_count` to log as `null` for blacklist runs. The field name `itemCount` is a codebase-wide convention across all cron results, not a per-file naming issue. 6 assertions in `sync-blacklist.test.ts` also depend on it. The Q09 audit finding is invalid — skip it.

- [ ] **Step 3: Add explicit `reserves: undefined` to stress test meta (Q07)**

In `shared/lib/report-cards.ts`, at lines 809-812:
```typescript
const meta = {
  flags: { governance: card.rawInputs.governanceTier },
  dependencies: card.rawInputs.dependencies,
  reserves: undefined,
};
```

- [ ] **Step 4: Verify build + tests**

Run: `npm run build && cd worker && npx tsc --noEmit && npm test`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: config and naming fixes

S09: remove @/* from worker tsconfig
Q09: abandoned — itemCount is CronResult contract, not a naming issue
Q07: add explicit reserves:undefined to stress test meta"
```

---

## Chunk 2: Security — Auth Hardening (Q01)

### Task 4: Remove Auth Header-Presence Fallback

**Files:**
- Modify: `worker/src/lib/auth.ts:32-62`
- Modify: `worker/src/lib/__tests__/auth.test.ts`
- Modify: `worker/src/api/__tests__/telegram-webhook-auth.test.ts`

**Context:** The `hasOpsApiAccessSignal` function (lines 32-62) currently falls back to header-presence checks when `CF_ACCESS_OPS_API_AUD` is not configured. This allows spoofed headers to grant admin access.

**Design approach:** The only change needed is inside `hasOpsApiAccessSignal` — remove the header-presence fallback (lines 49-61). The existing auth chain already works correctly:
1. `http.ts:98` calls `hasValidAdminCredential(request, undefined, env)` with `env` → computes `trustedAdmin`
2. All 8 admin handlers already pass `trustedAdmin` to `withAdmin(request, handler, trustedAdmin)` — the third arg is at the *closing brace* of the callback, 100+ lines below the opening. No handler fixes needed.
3. After removing the fallback, `hasOpsApiAccessSignal` without `env` returns `false`, but `trustedAdmin` (computed earlier with `env`) carries the auth decision through.

- [ ] **Step 1: Write failing tests**

Replace the contents of `worker/src/lib/__tests__/auth.test.ts` with the following (removes the old tests that validated header-presence acceptance):

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireAdmin, hasValidAdminCredential } from "../auth";

vi.mock("../jwt-verify", () => ({
  verifyAccessJwt: vi.fn().mockResolvedValue(true),
}));

describe("auth helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 401 when auth headers are missing", async () => {
    const request = new Request("https://x/admin");
    const result = await requireAdmin(request);
    expect(result?.status).toBe(401);
  });

  it("rejects ops-api requests when CF_ACCESS_OPS_API_AUD is not configured", async () => {
    const request = new Request("https://ops-api.pharos.watch/api/status", {
      headers: { "Cf-Access-Authenticated-User-Email": "operator@example.com" },
    });
    // Without env.CF_ACCESS_OPS_API_AUD, hasOpsApiAccessSignal returns false
    // and trustedAdmin is not set, so requireAdmin rejects
    const result = await requireAdmin(request);
    expect(result?.status).toBe(401);
  });

  it("rejects ops-api requests with spoofed service token headers when AUD not set", async () => {
    const request = new Request("https://ops-api.pharos.watch/api/status", {
      headers: {
        "CF-Access-Client-Id": "svc-id",
        "CF-Access-Client-Secret": "svc-secret",
      },
    });
    const result = await requireAdmin(request);
    expect(result?.status).toBe(401);
  });

  it("accepts ops-api request with valid JWT when AUD is configured", async () => {
    const request = new Request("https://ops-api.pharos.watch/api/status", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    });
    const env = { CF_ACCESS_OPS_API_AUD: "test-aud" };
    const result = await hasValidAdminCredential(request, false, env);
    expect(result).toBe(true);
  });

  it("accepts trustedAdmin=true regardless of headers", async () => {
    const request = new Request("https://x/admin");
    expect(await hasValidAdminCredential(request, true)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `npx vitest run worker/src/lib/__tests__/auth.test.ts`
Expected: FAIL — the "rejects ops-api requests when CF_ACCESS_OPS_API_AUD is not configured" test fails because the current code accepts header-presence.

- [ ] **Step 3: Harden `hasOpsApiAccessSignal` — remove the header-presence fallback**

In `worker/src/lib/auth.ts`, replace the entire `hasOpsApiAccessSignal` function (lines 32-62) with the following. The key change is removing the header-presence fallback (old lines 49-61) and requiring `env.CF_ACCESS_OPS_API_AUD` before any JWT verification:

```typescript
async function hasOpsApiAccessSignal(
  request: Request | undefined,
  env?: AdminAuthEnv,
): Promise<boolean> {
  if (!isOpsApiRequest(request)) return false;

  const accessJwt = request?.headers.get("Cf-Access-Jwt-Assertion")?.trim();

  // Require AUD to be configured for JWT verification
  if (!env?.CF_ACCESS_OPS_API_AUD) {
    console.warn("[auth] CF_ACCESS_OPS_API_AUD not configured — rejecting ops-api admin request");
    return false;
  }

  if (!accessJwt) {
    return false;
  }

  return verifyAccessJwt({
    token: accessJwt,
    aud: env.CF_ACCESS_OPS_API_AUD,
    teamDomain: env.CF_ACCESS_TEAM_DOMAIN ?? "pharos",
  });
}
```

**Do NOT change** the signatures of `hasValidAdminCredential`, `requireAdmin`, or `withAdmin` — they already have the correct parameter threading. `hasValidAdminCredential` already accepts `env` at line 64 and passes it through.

**Pre-flight verification:** Before committing, confirm that `worker/src/api/http.ts` calls `hasValidAdminCredential(request, undefined, env)` with the `env` parameter (line ~98). If `env` is NOT passed there, this fix will break all ops-api admin access in production — `trustedAdmin` would always be `false` after the fallback removal. If this verification fails, the `http.ts` call must be updated to pass `env` before proceeding.

- [ ] **Step 4: Update `telegram-webhook-auth.test.ts`**

In `worker/src/api/__tests__/telegram-webhook-auth.test.ts`, 3 tests assume header-presence grants access and will now fail. Flip their expectations to `false`:

1. Line ~30-35: "returns true for ops-api request with JWT header (no AUD configured)" → rename to "rejects ops-api request with JWT header when AUD not configured", change `expect(...).toBe(true)` to `expect(...).toBe(false)`
2. Line ~36-41: "returns true for ops-api request with email header" → rename to "rejects ops-api request with only email header", change to `expect(...).toBe(false)`
3. Line ~42-47: "returns true for ops-api request with service token headers" → rename to "rejects ops-api request with only service token headers", change to `expect(...).toBe(false)`

Tests that use `trustedAdmin=true` remain unchanged — `trustedAdmin` bypasses all header checks.

- [ ] **Step 5: Run tests to confirm they pass**

Run: `npx vitest run worker/src/lib/__tests__/auth.test.ts worker/src/api/__tests__/telegram-webhook-auth.test.ts`
Expected: All pass.

Run: `npm test`
Expected: All pass.

- [ ] **Step 6: Verify worker build**

Run: `cd worker && npx tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "fix(security): require JWT verification for admin auth, remove header-presence fallback

Previously, when CF_ACCESS_OPS_API_AUD was not configured, admin
endpoints accepted requests with any Cf-Access-* header present.
Now, AUD must be configured and JWT signatures are cryptographically
verified via Cloudflare Access JWKS.

Addresses Q01 from codebase audit."
```

---

## Chunk 3: Core Scoring Tests (Q03, Q16)

### Task 5: Add Report Card Scoring Tests (Q03)

**Files:**
- Create: `shared/lib/__tests__/report-cards.test.ts`
- Create: `shared/lib/__tests__/peg-score.test.ts`
- Create: `shared/lib/__tests__/redemption-backstop-scoring.test.ts`

- [ ] **Step 1: Write `report-cards.test.ts`**

Create `shared/lib/__tests__/report-cards.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  scoreToGrade,
  computeOverallGrade,
  scoreDependencyRisk,
  computeStressedGrades,
  isBlacklistable,
  GRADE_THRESHOLDS,
} from "../report-cards";

describe("scoreToGrade", () => {
  it("returns NR for null", () => {
    expect(scoreToGrade(null)).toBe("NR");
  });

  it("returns A+ for scores >= 87", () => {
    expect(scoreToGrade(87)).toBe("A+");
    expect(scoreToGrade(100)).toBe("A+");
  });

  it("returns correct grade at each threshold boundary", () => {
    for (const { grade, min } of GRADE_THRESHOLDS) {
      expect(scoreToGrade(min)).toBe(grade);
      if (min > 0) expect(scoreToGrade(min - 0.1)).not.toBe(grade);
    }
  });

  it("clamps scores to 0-100 range", () => {
    expect(scoreToGrade(-10)).toBe("F");
    expect(scoreToGrade(150)).toBe("A+");
  });

  it("returns F for score 0", () => {
    expect(scoreToGrade(0)).toBe("F");
  });
});

describe("computeOverallGrade", () => {
  const makeDimension = (score: number | null) => ({
    grade: score !== null ? scoreToGrade(score) : ("NR" as const),
    score,
    detail: "test",
  });

  it("returns NR when fewer than 2 base dimensions are rated", () => {
    const dims = {
      pegStability: makeDimension(90),
      liquidity: makeDimension(null),
      resilience: makeDimension(null),
      decentralization: makeDimension(null),
      dependencyRisk: makeDimension(null),
    };
    const result = computeOverallGrade(dims as never);
    expect(result.grade).toBe("NR");
  });

  it("computes a grade when 2+ base dimensions are rated", () => {
    const dims = {
      pegStability: makeDimension(90),
      liquidity: makeDimension(80),
      resilience: makeDimension(75),
      decentralization: makeDimension(70),
      dependencyRisk: makeDimension(85),
    };
    const result = computeOverallGrade(dims as never);
    expect(result.grade).not.toBe("NR");
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});

describe("scoreDependencyRisk", () => {
  it("scores self-backed centralized coin at 95", () => {
    const meta = {
      flags: { governance: "centralized" as const },
      dependencies: undefined,
      reserves: undefined,
    };
    const result = scoreDependencyRisk(meta as never, new Map());
    expect(result.score).toBe(95);
  });

  it("scores self-backed decentralized coin at 90", () => {
    const meta = {
      flags: { governance: "decentralized" as const },
      dependencies: undefined,
      reserves: undefined,
    };
    const result = scoreDependencyRisk(meta as never, new Map());
    expect(result.score).toBe(90);
  });

  it("caps wrapper dependency score", () => {
    const meta = {
      flags: { governance: "centralized" as const },
      dependencies: [{ id: "usdc", weight: 1.0, type: "wrapper" as const }],
      reserves: undefined,
    };
    const upstream = new Map([["usdc", 80]]);
    const result = scoreDependencyRisk(meta as never, upstream);
    // Wrapper cap: dep_score - 3 = 77
    expect(result.score).toBeLessThanOrEqual(77);
  });
});

describe("computeStressedGrades", () => {
  it.todo("returns modified grades for overridden coins — requires constructing full ReportCard[] shape");
});

describe("isBlacklistable", () => {
  it("returns true for centralized governance", () => {
    const meta = {
      flags: { governance: "centralized" as const },
      canBeBlacklisted: undefined,
    };
    expect(isBlacklistable(meta as never)).toBe(true);
  });

  it("respects explicit override", () => {
    const meta = {
      flags: { governance: "centralized" as const },
      canBeBlacklisted: false,
    };
    expect(isBlacklistable(meta as never)).toBe(false);
  });
});
```

- [ ] **Step 2: Write `peg-score.test.ts`**

Create `shared/lib/__tests__/peg-score.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { computePegScore, coinTrackingStart, PEG_SCORE_LOOKBACK_SEC } from "../peg-score";

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

describe("coinTrackingStart", () => {
  const fourYearsAgo = NOW - PEG_SCORE_LOOKBACK_SEC;

  it("returns null when no data and no firstSeen", () => {
    expect(coinTrackingStart([], fourYearsAgo)).toBeNull();
  });

  it("uses firstSeenSec when available", () => {
    const firstSeen = NOW - 365 * DAY;
    expect(coinTrackingStart([], fourYearsAgo, firstSeen)).toBe(firstSeen);
  });

  it("clamps to fourYearsAgo if firstSeen is earlier", () => {
    const veryOld = NOW - 10 * 365 * DAY;
    expect(coinTrackingStart([], fourYearsAgo, veryOld)).toBe(fourYearsAgo);
  });
});

describe("computePegScore", () => {
  it("returns null for insufficient tracking (< 30 days)", () => {
    const start = NOW - 10 * DAY;
    const result = computePegScore([], start, NOW);
    expect(result.pegScore).toBeNull();
  });

  it("returns 100 for a coin with no depeg events over 30+ days", () => {
    const start = NOW - 60 * DAY;
    const result = computePegScore([], start, NOW);
    expect(result.pegScore).toBe(100);
    expect(result.pegPct).toBeCloseTo(100);
    expect(result.severityScore).toBeCloseTo(100);
  });

  it("penalizes active depeg events", () => {
    const start = NOW - 90 * DAY;
    const events = [{
      startedAt: NOW - DAY,
      endedAt: null, // still active
      peakDeviationBps: 500,
      direction: "below" as const,
    }];
    const result = computePegScore(events as never, start, NOW);
    expect(result.pegScore).toBeLessThan(100);
    expect(result.activeDepeg).toBe(true);
  });

  it("weights recent events more heavily than old ones", () => {
    const start = NOW - 365 * DAY;
    const recentEvent = [{
      startedAt: NOW - 30 * DAY,
      endedAt: NOW - 29 * DAY,
      peakDeviationBps: 300,
      direction: "below" as const,
    }];
    const oldEvent = [{
      startedAt: NOW - 350 * DAY,
      endedAt: NOW - 349 * DAY,
      peakDeviationBps: 300,
      direction: "below" as const,
    }];
    const recentResult = computePegScore(recentEvent as never, start, NOW);
    const oldResult = computePegScore(oldEvent as never, start, NOW);
    expect(recentResult.pegScore!).toBeLessThan(oldResult.pegScore!);
  });
});
```

- [ ] **Step 3: Write `redemption-backstop-scoring.test.ts`**

Create `shared/lib/__tests__/redemption-backstop-scoring.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  computeEffectiveExitScore,
  computeCapacityScore,
  computeRedemptionBackstopScore,
} from "../redemption-backstop-scoring";

describe("computeEffectiveExitScore", () => {
  it("returns null when both inputs are null", () => {
    expect(computeEffectiveExitScore(null, null)).toBeNull();
  });

  it("returns liquidity score when only liquidity available", () => {
    expect(computeEffectiveExitScore(80, null)).toBe(80);
  });

  it("caps redemption-only to 70", () => {
    const result = computeEffectiveExitScore(null, 90);
    expect(result).toBeLessThanOrEqual(70);
  });

  it("returns max of pure-liquidity vs blend when both available", () => {
    const result = computeEffectiveExitScore(80, 60);
    // max(80, 80*0.55 + 60*0.45) = max(80, 71) = 80
    expect(result).toBe(80);
  });

  it("returns blend when blend exceeds pure liquidity", () => {
    const result = computeEffectiveExitScore(40, 90);
    // max(40, 40*0.55 + 90*0.45) = max(40, 62.5) = 63 (rounded)
    expect(result).toBeGreaterThan(40);
  });
});

describe("computeCapacityScore", () => {
  it("returns null when both inputs are null", () => {
    const result = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: null });
    expect(result.score).toBeNull();
  });

  it("scores high for >50% coverage ratio and >$250M capacity", () => {
    const result = computeCapacityScore({ immediateCapacityUsd: 300_000_000, immediateCapacityRatio: 0.6 });
    expect(result.score).toBeGreaterThanOrEqual(90);
  });

  it("scores low for minimal capacity", () => {
    const result = computeCapacityScore({ immediateCapacityUsd: 50_000, immediateCapacityRatio: 0.001 });
    expect(result.score).toBeLessThan(30);
  });
});

describe("computeRedemptionBackstopScore", () => {
  it("applies route family caps", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "queue-redeem",
      accessScore: 100, settlementScore: 100, executionCertaintyScore: 100,
      capacityScore: 100, outputAssetQualityScore: 100, costScore: 100,
    });
    expect(result.score).toBeLessThanOrEqual(70); // queue-redeem cap
    expect(result.capsApplied).toContain("queue-route-cap");
  });
});
```

- [ ] **Step 4: Run all new tests to verify they pass**

Run: `npx vitest run shared/lib/__tests__/report-cards.test.ts shared/lib/__tests__/peg-score.test.ts shared/lib/__tests__/redemption-backstop-scoring.test.ts`
Expected: PASS (tests validate existing code, not new code).

- [ ] **Step 5: Commit**

```bash
git add shared/lib/__tests__/report-cards.test.ts shared/lib/__tests__/peg-score.test.ts shared/lib/__tests__/redemption-backstop-scoring.test.ts
git commit -m "test: add unit tests for core scoring engine

Tests for report-cards.ts, peg-score.ts, and redemption-backstop-scoring.ts.
Covers scoreToGrade boundaries, computeOverallGrade with NR dimensions,
scoreDependencyRisk with wrapper caps, computePegScore with active depegs
and recency weighting, computeEffectiveExitScore blending.

Addresses Q03 from codebase audit."
```

---

### Task 6: Add Supply & Peg Utility Tests (Q16)

**Files:**
- Create: `shared/lib/__tests__/supply.test.ts`
- Create: `shared/lib/__tests__/peg-utils.test.ts`

- [ ] **Step 1: Write `supply.test.ts`**

Create `shared/lib/__tests__/supply.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { sumPegBuckets, getCirculatingRaw, getPrevMonthRawOrNull } from "../supply";

describe("sumPegBuckets", () => {
  it("returns 0 for undefined", () => {
    expect(sumPegBuckets(undefined)).toBe(0);
  });

  it("returns 0 for empty object", () => {
    expect(sumPegBuckets({})).toBe(0);
  });

  it("sums all numeric values", () => {
    expect(sumPegBuckets({ usd: 100, eur: 50, gbp: 25 })).toBe(175);
  });

  it("treats NaN as 0", () => {
    expect(sumPegBuckets({ usd: 100, eur: NaN })).toBe(100);
  });

  it("treats Infinity as 0", () => {
    expect(sumPegBuckets({ usd: 100, eur: Infinity })).toBe(100);
  });

  it("treats -Infinity as 0", () => {
    expect(sumPegBuckets({ usd: 100, eur: -Infinity })).toBe(100);
  });
});

describe("getCirculatingRaw", () => {
  it("sums circulating peg buckets", () => {
    const coin = { circulating: { usd: 1_000_000 } } as never;
    expect(getCirculatingRaw(coin)).toBe(1_000_000);
  });
});

describe("getPrevMonthRawOrNull", () => {
  it("returns null when no prev month data", () => {
    const coin = { circulatingPrevMonth: undefined } as never;
    expect(getPrevMonthRawOrNull(coin)).toBeNull();
  });

  it("returns sum when data exists", () => {
    const coin = { circulatingPrevMonth: { usd: 500_000 } } as never;
    expect(getPrevMonthRawOrNull(coin)).toBe(500_000);
  });
});
```

- [ ] **Step 2: Write `peg-utils.test.ts`**

Create `shared/lib/__tests__/peg-utils.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mergeDepegSeconds, worstDeviation } from "../peg-utils";

const NOW = 1_700_000_000;
const DAY = 86400;

describe("mergeDepegSeconds", () => {
  it("returns 0 for no events", () => {
    expect(mergeDepegSeconds([], NOW - 30 * DAY, NOW)).toBe(0);
  });

  it("computes duration of a single resolved event", () => {
    const events = [{ startedAt: NOW - 10 * DAY, endedAt: NOW - 9 * DAY }];
    expect(mergeDepegSeconds(events as never, NOW - 30 * DAY, NOW)).toBe(DAY);
  });

  it("merges overlapping intervals", () => {
    const events = [
      { startedAt: NOW - 10 * DAY, endedAt: NOW - 8 * DAY },
      { startedAt: NOW - 9 * DAY, endedAt: NOW - 7 * DAY },
    ];
    // Merged: one interval spanning 3 days
    expect(mergeDepegSeconds(events as never, NOW - 30 * DAY, NOW)).toBe(3 * DAY);
  });

  it("clamps events to window boundaries", () => {
    const windowStart = NOW - 5 * DAY;
    const events = [{ startedAt: NOW - 10 * DAY, endedAt: NOW - 3 * DAY }];
    // Clamped: only 2 days within window
    expect(mergeDepegSeconds(events as never, windowStart, NOW)).toBe(2 * DAY);
  });

  it("treats active events (endedAt=null) as ending at now", () => {
    const events = [{ startedAt: NOW - 2 * DAY, endedAt: null }];
    expect(mergeDepegSeconds(events as never, NOW - 30 * DAY, NOW)).toBe(2 * DAY);
  });
});

describe("worstDeviation", () => {
  it("returns null for empty array", () => {
    expect(worstDeviation([])).toBeNull();
  });

  it("returns the largest absolute deviation", () => {
    const events = [
      { peakDeviationBps: -200 },
      { peakDeviationBps: 150 },
      { peakDeviationBps: -300 },
    ];
    expect(worstDeviation(events as never)).toBe(-300);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run shared/lib/__tests__/supply.test.ts shared/lib/__tests__/peg-utils.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add shared/lib/__tests__/supply.test.ts shared/lib/__tests__/peg-utils.test.ts
git commit -m "test: add unit tests for supply helpers and peg utilities

Tests sumPegBuckets with NaN/Infinity/undefined, mergeDepegSeconds
with overlapping intervals and window clamping, worstDeviation.

Addresses Q16 from codebase audit."
```

---

## Chunk 4: Type Consolidation & External API Validation

### Task 7: Extract PYS Formula to Shared (R03)

**Files:**
- Create: `shared/lib/yield-scoring.ts`
- Create: `shared/lib/__tests__/yield-scoring.test.ts`
- Modify: `worker/src/cron/yield-helpers.ts:19-21, 44-57`
- Modify: `src/lib/yield-constants.ts:28-38`

- [ ] **Step 1: Write failing test for shared PYS**

Create `shared/lib/__tests__/yield-scoring.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  PYS_RISK_PENALTY_FLOOR,
  PYS_SUSTAINABILITY_FLOOR,
  computePysComponents,
  computePYS,
} from "../yield-scoring";

describe("PYS constants", () => {
  it("exports risk penalty floor of 0.5", () => {
    expect(PYS_RISK_PENALTY_FLOOR).toBe(0.5);
  });
  it("exports sustainability floor of 0.3", () => {
    expect(PYS_SUSTAINABILITY_FLOOR).toBe(0.3);
  });
});

describe("computePysComponents", () => {
  it("computes riskPenalty from safety score", () => {
    const result = computePysComponents({ apy30d: 5, safetyScore: 80, apyVarianceScore: 0.2 });
    expect(result.riskPenalty).toBeCloseTo((101 - 80) / 20); // 1.05
  });

  it("floors riskPenalty at 0.5", () => {
    const result = computePysComponents({ apy30d: 5, safetyScore: 100, apyVarianceScore: 0 });
    expect(result.riskPenalty).toBe(0.5); // (101-100)/20 = 0.05, floored to 0.5
  });

  it("defaults null safetyScore to 40", () => {
    const result = computePysComponents({ apy30d: 5, safetyScore: null, apyVarianceScore: 0 });
    expect(result.riskPenalty).toBeCloseTo((101 - 40) / 20); // 3.05
  });

  it("floors sustainabilityMultiplier at 0.3", () => {
    const result = computePysComponents({ apy30d: 5, safetyScore: 80, apyVarianceScore: 0.9 });
    expect(result.sustainabilityMultiplier).toBe(0.3); // 1.0 - 0.9 = 0.1, floored to 0.3
  });
});

describe("computePYS", () => {
  it("returns 0 for non-positive APY", () => {
    expect(computePYS({ apy30d: 0, safetyScore: 80, apyVarianceScore: 0, scalingFactor: 1 })).toBe(0);
    expect(computePYS({ apy30d: -1, safetyScore: 80, apyVarianceScore: 0, scalingFactor: 1 })).toBe(0);
  });

  it("caps at 100", () => {
    const result = computePYS({ apy30d: 500, safetyScore: 100, apyVarianceScore: 0, scalingFactor: 10 });
    expect(result).toBe(100);
  });

  it("applies scaling factor", () => {
    const base = computePYS({ apy30d: 5, safetyScore: 80, apyVarianceScore: 0.1, scalingFactor: 1 });
    const scaled = computePYS({ apy30d: 5, safetyScore: 80, apyVarianceScore: 0.1, scalingFactor: 2 });
    expect(scaled).toBeGreaterThan(base);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/lib/__tests__/yield-scoring.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `shared/lib/yield-scoring.ts`**

```typescript
/**
 * PYS (Pharos Yield Score) formula — shared between worker computation
 * and frontend breakdown display.
 *
 * Worker: uses computePYS() for the final score.
 * Frontend: uses computePysComponents() for breakdown tooltip display.
 */

/** Risk penalty floor — prevents division by near-zero. */
export const PYS_RISK_PENALTY_FLOOR = 0.5;

/** Sustainability multiplier floor — ensures non-zero contribution. */
export const PYS_SUSTAINABILITY_FLOOR = 0.3;

/** Default safety score when no report card grade is available. */
export const PYS_DEFAULT_SAFETY_SCORE = 40;

interface PysComponentInput {
  apy30d: number;
  safetyScore: number | null;
  apyVarianceScore: number;
}

export function computePysComponents(input: PysComponentInput) {
  const effectiveSafety = input.safetyScore ?? PYS_DEFAULT_SAFETY_SCORE;
  const riskPenalty = Math.max(PYS_RISK_PENALTY_FLOOR, (101 - effectiveSafety) / 20);
  const yieldEfficiency = input.apy30d / riskPenalty;
  const sustainabilityMultiplier = Math.max(PYS_SUSTAINABILITY_FLOOR, 1.0 - input.apyVarianceScore);
  return { riskPenalty, yieldEfficiency, sustainabilityMultiplier };
}

interface PYSInput {
  apy30d: number;
  safetyScore: number;
  apyVarianceScore: number;
  scalingFactor: number;
}

export function computePYS({ apy30d, safetyScore, apyVarianceScore, scalingFactor }: PYSInput): number {
  if (apy30d <= 0) return 0;
  const { yieldEfficiency, sustainabilityMultiplier } = computePysComponents({
    apy30d,
    safetyScore,
    apyVarianceScore,
  });
  return Math.min(100, Math.round(yieldEfficiency * sustainabilityMultiplier * scalingFactor));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run shared/lib/__tests__/yield-scoring.test.ts`
Expected: PASS.

- [ ] **Step 5: Update worker `yield-helpers.ts` to import from shared**

In `worker/src/cron/yield-helpers.ts`:
1. Remove lines 19-21 (local `PYS_RISK_PENALTY_FLOOR`, `PYS_SUSTAINABILITY_FLOOR` constants)
2. Remove the local `PYSInput` interface and `computePYS` function (lines 44-57)
3. Add: `export { computePYS, PYS_RISK_PENALTY_FLOOR, PYS_SUSTAINABILITY_FLOOR } from "@shared/lib/yield-scoring";`

This re-exports from shared so existing worker consumers don't need import path changes.

- [ ] **Step 6: Update frontend `yield-constants.ts` to import from shared**

In `src/lib/yield-constants.ts`, replace `computePysBreakdown` (lines 28-38):
```typescript
import { computePysComponents } from "@shared/lib/yield-scoring";

export function computePysBreakdown(
  apy30d: number,
  safetyScore: number | null,
  yieldStability: number | null,
) {
  // yieldStability in the API = 1.0 - apyVarianceScore
  const apyVarianceScore = 1.0 - (yieldStability ?? 1.0);
  const { riskPenalty, yieldEfficiency, sustainabilityMultiplier } =
    computePysComponents({ apy30d, safetyScore, apyVarianceScore });
  return { riskPenalty, yieldEfficiency, sustainabilityMult: sustainabilityMultiplier };
}
```

- [ ] **Step 7: Verify build + tests**

Run: `npm run build && cd worker && npx tsc --noEmit && npm test`

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: extract PYS formula to shared/lib/yield-scoring.ts

Single source of truth for PYS constants and computation, consumed by
both worker (full PYS score) and frontend (breakdown display).

Addresses R03 from codebase audit."
```

---

### Task 8: Consolidate DEX Liquidity Types (R13) & Safety Score Version (R16)

**Files:**
- Modify: `worker/src/cron/dex-liquidity/types.ts`
- Modify: `shared/types/market.ts`
- Modify: `shared/lib/safety-score-version.ts`

- [ ] **Step 1: Make cron import shared DEX types where compatible (R13)**

In `worker/src/cron/dex-liquidity/types.ts`, replace ONLY the compatible local type definitions with imports. **Caution:** The types are NOT identical between cron and shared:

- `LiquidityPoolSourceFamily`: Import from shared — it's a string union, safe to unify.
- `LiquiditySourceMixEntry`: Import from shared — structurally identical.
- `LiquidityCoverageClass`: Import from shared — string union, safe to unify.
- **`LiquiditySourceMix`: DO NOT replace.** The cron version is `Partial<Record<LiquidityPoolSourceFamily, ...>>` (typed keys, optional values). The shared version is `Record<string, ...>` (any string key, required values). These are structurally different. Keep the cron version as a local type that uses the shared `LiquiditySourceMixEntry`.
- **`PoolEntry`: DO NOT replace.** The cron's `PoolEntry` (lines 92-123) has `poolId`, `volumeUsd7d`, `qualityAdjustedTvl` and `hasMeasuredOrganicFraction` in `extra` which do not exist in the shared `DexLiquidityPool`. Keep `PoolEntry` local.

```typescript
export type { LiquidityPoolSourceFamily, LiquiditySourceMixEntry, LiquidityCoverageClass } from "@shared/types";
// LiquiditySourceMix and PoolEntry remain local (different shapes from shared)
```

- [ ] **Step 2: Migrate `safety-score-version.ts` to factory (R16)**

Read `shared/lib/methodology-version.ts` for the factory signature. **Important:** `MethodologyChangelogEntry` requires 8 fields: `version`, `title`, `date`, `effectiveAt`, `summary`, `impact` (readonly string[]), `commits` (readonly string[]), `reconstructed` (boolean). The plan's simplified `{ version, effectiveAt, label }` shape will NOT compile.

Rewrite `shared/lib/safety-score-version.ts`:

```typescript
import { createMethodologyVersion } from "./methodology-version";

const safetyScore = createMethodologyVersion({
  currentVersion: "5.8",
  changelogPath: "/methodology/scoring-changelog/",
  changelog: [
    // The implementer MUST read docs/report-cards-timeline.md and populate
    // ALL required MethodologyChangelogEntry fields for each version:
    // { version, title, date, effectiveAt, summary, impact: [], commits: [], reconstructed }
    // Example entry:
    // { version: "5.8", title: "Reserves dimension + live reserve data", date: "2026-03-01",
    //   effectiveAt: 1740787200, summary: "Added reserves as scoring dimension",
    //   impact: ["Coins with live reserves may see grade changes"], commits: ["abc1234"], reconstructed: false },
  ],
});

export const SAFETY_SCORE_VERSION = safetyScore.currentVersion;
export const SAFETY_SCORE_VERSION_LABEL = safetyScore.versionLabel;
export const SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH = safetyScore.changelogPath;
export const getSafetyScoreVersionAt = safetyScore.getVersionAt;

/** Nav versions for the changelog page sidebar. */
export const SAFETY_SCORE_CHANGELOG_NAV_VERSIONS = [
  safetyScore.versionLabel, // dynamic coupling to currentVersion
  "v5.7", "v5.6", "v5.5", "v5.4", "v5.3",
  "v5.2", "v5.1", "v5.0", "v4.1", "v4.0", "v3.3",
  "v3.2", "v3.0", "v2.0", "v1.0",
] as const;
```

- [ ] **Step 3: Verify build + tests**

Run: `npm run build && cd worker && npx tsc --noEmit && npm test`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: consolidate DEX types to shared schemas, migrate safety-score-version to factory

R13: cron dex-liquidity types now import from shared/types/market.ts
R16: safety-score-version.ts uses createMethodologyVersion() factory"
```

---

### Task 9: Add External API Validation Schemas (Q06, Q11)

**Files:**
- Create: `worker/src/lib/external-api-schemas.ts`
- Modify: `worker/src/cron/sync-stablecoins/stages.ts`
- Modify: `worker/src/cron/sync-blacklist.ts`
- Modify: `worker/src/api/backfill-depegs.ts`

- [ ] **Step 1: Create Zod schemas for external APIs**

Create `worker/src/lib/external-api-schemas.ts`:

```typescript
import { z } from "zod";

// NOTE: DefiLlama chainCirculating (Q06) is already validated by the existing
// ChainCirculatingSchema in shared/types/market.ts (lines 11-19). The cast at
// stages.ts:42 is a post-parse narrowing, not a raw API cast. No new schema needed.

// --- TronGrid events (Q11) ---
export const TronEventResultSchema = z.object({
  _balance: z.string().optional(),
  _value: z.string().optional(),
  "1": z.string().optional(),
}).passthrough();

export const TronEventSchema = z.object({
  block_number: z.number(),
  block_timestamp: z.number(),
  transaction_id: z.string(),
  result: TronEventResultSchema,
  event_name: z.string(),
}).passthrough();

export const TronEventsResponseSchema = z.object({
  data: z.array(TronEventSchema),
  success: z.boolean(),
  meta: z.object({
    links: z.object({ next: z.string().optional() }).optional(),
  }).optional(),
}).passthrough();

// --- CoinGecko market chart (Q11) ---
export const CoinGeckoMarketChartSchema = z.object({
  prices: z.array(z.tuple([z.number(), z.number()])),
});

// --- Frankfurter FX rates (Q11) ---
export const FrankfurterTimeSeriesSchema = z.object({
  base: z.string(),
  start_date: z.string(),
  end_date: z.string(),
  rates: z.record(z.string(), z.record(z.string(), z.number())),
});
```

- [ ] **Step 2: ~~Apply DL chain circulating validation~~ — SKIPPED (Q06)**

The cast at `stages.ts:42` is NOT an unsafe cast on raw external API data — it's a post-parse mutation cast on data already validated through `StablecoinListResponseSchema` (Zod-backed) in `shared/types/market.ts`. The `ChainCirculatingSchema` already validates this structure at lines 11-19. No additional validation needed here. Q06 finding is a false positive for this location.

- [ ] **Step 3: Apply TronGrid validation (Q11)**

In `worker/src/cron/sync-blacklist.ts`, at line 446:
```typescript
import { TronEventsResponseSchema } from "../lib/external-api-schemas";

// Replace: return res.json() as Promise<TronEventsResponse>;
// With:
const raw = await res.json();
const parsed = TronEventsResponseSchema.safeParse(raw);
if (!parsed.success) {
  console.warn("[blacklist] TronGrid response validation failed:", parsed.error.message);
  return null;
}
return parsed.data;
```

- [ ] **Step 4: Apply CG market chart validation (Q11)**

In `worker/src/api/backfill-depegs.ts`, apply validation to ALL CG market chart casts:

```typescript
import { CoinGeckoMarketChartSchema } from "../lib/external-api-schemas";
```

At lines 759, 794, and 817 (all `fetchCgPriceHistory*` functions), replace `const data = await res.json() as { prices: [number, number][] }` with:
```typescript
const raw = await res.json();
const parsed = CoinGeckoMarketChartSchema.safeParse(raw);
if (!parsed.success) {
  console.warn("[backfill-depegs] CG market chart validation failed:", parsed.error.message);
  return []; // Return empty array, matching existing error-handling pattern (NOT null)
}
const data = parsed.data;
```

Also apply `FrankfurterTimeSeriesSchema` validation to the Frankfurter cast at `backfill-depegs.ts:111` (`as FrankfurterTimeSeriesResponse`). Use the same `.safeParse()` + warn-and-return pattern. If the implementer decides to skip it, **remove the unused schema from `external-api-schemas.ts`** to avoid dead code.

- [ ] **Step 5: Verify build + tests**

Run: `npm run build && cd worker && npx tsc --noEmit && npm test`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add Zod validation for external API responses

Schemas for TronGrid events, CoinGecko market charts, and
Frankfurter FX rates. Replaces unsafe 'as TypeName' casts
with runtime validation.

Q06 (DL chainCirculating) already validated by existing Zod schemas.
Addresses Q11 from codebase audit."
```

---

## Chunk 5: CI Safety & Code Quality

### Task 10: Add Safety Scripts to CI (S03, S01)

**Files:**
- Modify: `.github/workflows/validate-ci.yml`
- Modify: `scripts/check-worker-migrations.mjs`

- [ ] **Step 1: Add safety checks to CI workflow (S03)**

In `.github/workflows/validate-ci.yml`, add after the `check:migrations` step (line 27):
```yaml
      - run: npm run check:cron-sync
      - run: npm run check:doc-counts
      - run: npm run check:duplicate-exports
```

- [ ] **Step 2: Add migration sequence uniqueness check (S01)**

In `scripts/check-worker-migrations.mjs`, add after the file listing logic (before the replay loop):
```javascript
// Check for duplicate sequence numbers (use full alphanumeric prefix to handle 0031a)
const sequenceNumbers = migrationFiles.map(f => f.match(/^(\d+[a-z]?)/)?.[1]).filter(Boolean);
const duplicates = sequenceNumbers.filter((num, i) => sequenceNumbers.indexOf(num) !== i);
const uniqueDuplicates = [...new Set(duplicates)];
// Known legacy duplicates that can't be renumbered without replay risk
const KNOWN_LEGACY_DUPLICATES = new Set(["0056", "0061"]);
const newDuplicates = uniqueDuplicates.filter(n => !KNOWN_LEGACY_DUPLICATES.has(n));
if (newDuplicates.length > 0) {
  console.error(`❌ Duplicate migration sequence numbers: ${newDuplicates.join(", ")}`);
  console.error("Each migration must have a unique numeric prefix.");
  process.exit(1);
}
if (uniqueDuplicates.length > 0) {
  console.warn(`⚠️  Known legacy duplicate prefixes: ${uniqueDuplicates.join(", ")} (suppressed)`);
}
```

- [ ] **Step 3: Verify locally**

Run: `npm run check:cron-sync && npm run check:doc-counts && npm run check:duplicate-exports`
Expected: All pass.

Run: `node scripts/check-worker-migrations.mjs`
Expected: Warns about legacy duplicates 0056/0061 but does NOT exit with error.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "ci: add safety scripts to CI pipeline and migration uniqueness check

S03: check:cron-sync, check:doc-counts, check:duplicate-exports now run in CI
S01: migration sequence uniqueness check added to check-worker-migrations"
```

---

### Task 11: Code Quality Improvements (Q02, Q08, Q15, Q13)

**Files:**
- Modify: `worker/src/cron/sync-blacklist.ts`
- Modify: `worker/src/lib/report-cards-snapshot.ts`
- Modify: `worker/src/api/backfill-stability-index.ts`

- [ ] **Step 1: Convert `syncBlacklist` to options object (Q02)**

In `worker/src/cron/sync-blacklist.ts`, define an options interface and refactor:

```typescript
export interface SyncBlacklistOptions {
  db: D1Database;
  etherscanApiKey: string | null;
  trongridApiKey: string | null;
  drpcApiKey: string | null;
  externalEtherscanRL?: RateLimitedFetch;
  signal?: AbortSignal;
  onProgress?: CronProgressReporter;
  chainRpcs?: Map<string, ChainRpcConfig>;
}

export async function syncBlacklist(opts: SyncBlacklistOptions): Promise<SyncBlacklistResult> {
  const { db, etherscanApiKey, trongridApiKey, drpcApiKey, externalEtherscanRL, signal, onProgress, chainRpcs } = opts;
  // ... existing body unchanged
}
```

**Do NOT** apply the same pattern to `fetchEvmEventsIncremental` or `enrichRowBalances` — they are private functions called from a single site within the same file. The Q02 finding targets exported APIs with long parameter lists.

**Call sites to update (11 total):**
- `worker/src/handlers/scheduled/twenty-minute-blacklist.ts` (1 call)
- `worker/src/cron/__tests__/sync-blacklist.test.ts` (10 calls — consider adding a `buildTestOpts()` helper to avoid repeating the options object)

- [ ] **Step 2: Convert `computeCard` to options object (Q02)**

In `worker/src/lib/report-cards-snapshot.ts`, define:

```typescript
interface ComputeCardInput {
  meta: (typeof TRACKED_STABLECOINS)[number];
  pegDataById: Map<string, PegSummaryCoin>;
  dexLiqMap: Record<string, Pick<DexLiquidityData, "liquidityScore" | "concentrationHhi" | "poolCount" | "chainCount">>;
  redemptionBackstopMap: Record<string, RedemptionBackstopEntry>;
  bluechipMap: Record<string, BluechipRating>;
  overallScores: Map<string, number>;
  blacklistableIds: ReadonlySet<string>;
  liveReserveMap: Map<string, ReserveSlice[]>;
}

function computeCard(input: ComputeCardInput): ReportCard {
  const { meta, pegDataById, dexLiqMap, ... } = input;
  // ... existing body
}
```

- [ ] **Step 3: Use `bigIntToDecimal` for Tron amount parsing (Q15)**

In `worker/src/cron/sync-blacklist.ts`, at line 458, use the **existing** `bigIntToDecimal` utility from `worker/src/lib/bigint.ts` (already used by `balance-providers.ts` in the same module for EVM balance parsing):

```typescript
import { bigIntToDecimal } from "../lib/bigint";

// Replace: Number(evt.result._balance || evt.result._value || evt.result["1"]) / Math.pow(10, config.decimals)
// With:
const rawStr = String(evt.result._balance || evt.result._value || evt.result["1"] || "0");
const amount = bigIntToDecimal(BigInt(rawStr), config.decimals);
```

This is DRY, handles the `10n ** BigInt(decimals)` correctly (avoids `Number` precision loss for `10 ** 18`), and is already tested.

- [ ] **Step 4: Improve atomicity of stability index rebuild (Q13)**

In `worker/src/api/backfill-stability-index.ts`, replace `db.exec()` with `db.batch()` for the DDL sequence (lines 56-57):
```typescript
// Replace:
// await db.exec("DROP TABLE IF EXISTS stability_index_rebuild");
// await db.exec(rebuildTableSql);
// With:
await db.batch([
  db.prepare("DROP TABLE IF EXISTS stability_index_rebuild"),
  db.prepare(rebuildTableSql),
]);
```

Note: Verify `rebuildTableSql` is a single statement (not multi-statement), as `db.prepare` expects one statement.

- [ ] **Step 5: Verify build + tests**

Run: `npm run build && cd worker && npx tsc --noEmit && npm test`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: options objects for long param lists, BigInt for Tron amounts, atomic DDL

Q02: syncBlacklist, computeCard now use options objects
Q15: Tron amount parsing uses BigInt for precision
Q13: stability index rebuild uses db.batch() for atomicity"
```

---

### Task 12: Error Classification Comments (Q08) & Rate Limiter Deprecation (S04)

**Files:**
- Modify: Multiple files in `worker/src/cron/`
- Modify: `worker/src/lib/rate-limit.ts`

- [ ] **Step 1: Add JSDoc deprecation to in-memory rate limiter (S04)**

In `worker/src/lib/rate-limit.ts`, add before the in-memory `checkRateLimit` function:
```typescript
/**
 * Best-effort rate limiting within a single Workers isolate.
 *
 * @deprecated This Map-based limiter is NOT shared across isolates or data centers.
 * Use `checkPublicApiRateLimit()` (D1-backed) for distributed rate limiting.
 * This function only provides per-isolate throttling (~5-30s window).
 */
```

- [ ] **Step 2: Standardize error classification comments (Q08)**

Add classification comments to silent catch blocks across cron files. For each `catch` block in `worker/src/cron/`:
- `catch { /* non-blocking: observability only */ }` — for monitoring/metric queries
- `console.warn("[module] degraded: ...")` — for graceful degradation of non-critical data
- `console.error("[module] unexpected: ...")` — for unexpected failures

This is a documentation-only change. Search with:
Run: `grep -rn "catch.*{" worker/src/cron/ | grep -v "test"`

Add the classification comment to each catch block that lacks one.

- [ ] **Step 3: Verify build**

Run: `cd worker && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: standardize error classification in cron catch blocks, deprecate in-memory rate limiter

Q08: add classification comments to catch blocks
S04: add @deprecated JSDoc to in-memory checkRateLimit"
```

---

## Chunk 6: Structural Decompositions

### Task 13: Split `backfill-depegs.ts` (Q04)

**Files:**
- Create: `worker/src/api/backfill-fx.ts`
- Create: `worker/src/api/backfill-price-sources.ts`
- Modify: `worker/src/api/backfill-depegs.ts`

- [ ] **Step 1: Identify extraction boundaries**

Read `worker/src/api/backfill-depegs.ts` completely. Identify:
1. **FX rate functions** (Frankfurter primary + CDN secondary, commodity median): Extract to `backfill-fx.ts`
2. **Price source functions** (CG hourly/daily, DL chart fallback): Extract to `backfill-price-sources.ts`
3. **Orchestrator** (remains in `backfill-depegs.ts`): Imports from the two new files

- [ ] **Step 2: Extract FX functions to `backfill-fx.ts`**

Move all FX-related functions to `worker/src/api/backfill-fx.ts`. Maintain the same function signatures. Update imports in the original file.

- [ ] **Step 3: Extract price source functions to `backfill-price-sources.ts`**

Move CG/DL price history fetching to `worker/src/api/backfill-price-sources.ts`. The `extractDepegEvents` function is already well-defined — it can stay in the orchestrator.

- [ ] **Step 4: Update imports in orchestrator**

In `worker/src/api/backfill-depegs.ts`, add imports from the two new files and remove the extracted function definitions.

- [ ] **Step 5: Update test file imports and verify tests pass**

There are TWO test files that import from `backfill-depegs.ts`:
1. `worker/src/api/__tests__/backfill-depegs.test.ts`
2. `worker/src/api/__tests__/backfill-depegs-helpers.test.ts` — imports `buildFxLookup`, `fetchHistoricalSecondaryFxRates`, `extractDepegEvents`, `findNearestSupply`, `parseSupplyData`

After the split, update imports in `backfill-depegs-helpers.test.ts` to import FX functions from `../backfill-fx` and price source functions from `../backfill-price-sources`. Alternatively, add re-exports from the orchestrator file for backward compatibility.

Run: `npx vitest run worker/src/api/__tests__/backfill-depegs.test.ts worker/src/api/__tests__/backfill-depegs-helpers.test.ts`
Expected: PASS — behavioral preservation, just file reorganization.

- [ ] **Step 6: Full build + test**

Run: `npm run build && cd worker && npx tsc --noEmit && npm test`

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: decompose backfill-depegs.ts into FX, price sources, and orchestrator

Splits 1035-line monolith into three focused modules:
- backfill-fx.ts: FX rate fetching (Frankfurter + commodity median)
- backfill-price-sources.ts: CG/DL price history
- backfill-depegs.ts: orchestration and depeg extraction

Addresses Q04 from codebase audit."
```

---

### Task 14: Extract Telegram Alert Modules (Q05)

**Files:**
- Create: `worker/src/cron/telegram-alert-snapshots.ts`
- Create: `worker/src/cron/telegram-pending-queue.ts`
- Modify: `worker/src/cron/dispatch-telegram-alerts.ts`

- [ ] **Step 1: Read and identify extraction boundaries**

Read `worker/src/cron/dispatch-telegram-alerts.ts` completely. Identify:
1. **Snapshot diff logic**: Functions that load snapshots from D1, compare current state, and produce change sets (DEWS/depeg/safety). Extract to `telegram-alert-snapshots.ts`.
2. **Pending queue management**: Enqueue, drain, retry, expire logic. Extract to `telegram-pending-queue.ts`.
3. **Orchestrator** (remains): Subscriber matching, message consolidation, batch sending, and the main dispatch flow.

- [ ] **Step 2: Extract snapshot diff module**

Create `worker/src/cron/telegram-alert-snapshots.ts` with the snapshot loading and diffing functions. Export clear interfaces for the change sets returned.

- [ ] **Step 3: Extract pending queue module**

Create `worker/src/cron/telegram-pending-queue.ts` with enqueue, drain, retry, expire functions.

- [ ] **Step 4: Update orchestrator imports**

- [ ] **Step 5: Verify existing tests pass**

Run: `npx vitest run worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts`

- [ ] **Step 6: Full build + test**

Run: `npm run build && cd worker && npx tsc --noEmit && npm test`

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: extract snapshot diff and pending queue from dispatch-telegram-alerts

Splits 1069-line cron handler into three modules:
- telegram-alert-snapshots.ts: snapshot loading and change detection (~180 lines)
- telegram-pending-queue.ts: pending message lifecycle management (~110 lines)
- dispatch-telegram-alerts.ts: orchestration + types + helpers (~780 lines)

Note: Types/interfaces (lines 21-161) and subscriber loading helpers are
deeply interleaved. Create a telegram-alert-types.ts for shared row/snapshot
types if needed to avoid circular imports. disableBlockedSubscriber is used
by both pending queue and orchestrator — place it in pending queue module.

Addresses Q05 from codebase audit."
```

---

### Task 15: Extract Enrichment Passes from `enrich-prices.ts` (Q14)

**Files:**
- Create: `worker/src/cron/enrich-prices-passes.ts`
- Modify: `worker/src/cron/enrich-prices.ts`

- [ ] **Step 1: Define pass result interface**

```typescript
export interface EnrichPassResult {
  resolved: number;
  failures: string[];
}
```

- [ ] **Step 2: Extract each pass into a named function**

In `worker/src/cron/enrich-prices-passes.ts`, create:
- `runDlContractPasses(assets, fxRates, signal): Promise<EnrichPassResult>` — Passes 1 + 1b combined (DL contract addresses + multi-chain fallback). These MUST stay together because Pass 1b reads from the `withAddress` array computed by Pass 1.
- `runCmcPass(assets, cmcApiKey, fxRates, signal): Promise<EnrichPassResult>` — Pass 2 (CMC API). Note: `cmcApiKey` parameter is required.
- `runDexScreenerPass(assets, fxRates, db, signal): Promise<EnrichPassResult>` — Pass 3 (DexScreener)

**Important:** All passes mutate the shared `assets` array in-place (via `applyResolvedPrice`). They are NOT independent — each pass reads the mutable state left by the previous pass (`hasMissingPrice`). The result struct captures resolved counts only; the core side-effect remains mutation. Also, `fxRates` (loaded once from D1 cache) must be passed to each function.

- [ ] **Step 3: Update `enrichMissingPrices` to pipeline the passes**

```typescript
export async function enrichMissingPrices(assets, db, signal) {
  const totalMissing = assets.filter(hasMissingPrice).length;
  if (totalMissing === 0) return zeroResult();

  const fxRates = await loadFxRates(db); // loaded once, shared across passes
  const passDl = await runDlContractPasses(assets, fxRates, signal);
  const passCmc = await runCmcPass(assets, cmcApiKey, fxRates, signal);
  const passDex = await runDexScreenerPass(assets, fxRates, db, signal);

  return {
    totalMissing,
    pass1: passDl.resolved, // includes both 1 + 1b counts
    passCmc: passCmc.resolved,
    passDex: passDex.resolved,
    finalMissing: assets.filter(hasMissingPrice).length,
    failedPasses: [...passDl.failures, ...passCmc.failures, ...passDex.failures],
  };
}
```

- [ ] **Step 4: Verify existing tests pass**

Run: `npx vitest run worker/src/cron/__tests__/enrich-prices.test.ts`

- [ ] **Step 5: Full build + test**

Run: `npm run build && cd worker && npx tsc --noEmit && npm test`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: extract enrichment passes from enrichMissingPrices

Price enrichment passes are now named functions with own result structs.
Passes 1+1b combined (shared state). Reduces 7 shared mutable counters.

Addresses Q14 from codebase audit."
```

---

### Task 16: Connection Budget Documentation (S20)

**Files:**
- Modify: `shared/lib/cron-jobs.ts`

- [ ] **Step 1: Add connection budget metadata to cron definitions**

In `shared/lib/cron-jobs.ts`, extend the cron job definition type to include connection budget documentation:

```typescript
/** Maximum outbound fetch connections this job may use (of the 6-per-trigger pool). */
maxConnections?: number;
```

Add `maxConnections` to each job definition based on analysis of their fetch patterns. This serves as documentation for code review.

- [ ] **Step 2: Add JSDoc to slot runner about connection limits**

In the relevant `worker/src/handlers/scheduled/` files, add a JSDoc comment at the top documenting the connection budget for that trigger slot.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: add connection budget metadata to cron job definitions

Each cron job now documents its max outbound connections, making the
6-per-trigger budget visible during code review.

Addresses S20 from codebase audit."
```

---

## Finding Coverage Summary

| Finding | Task | Status |
|---------|------|--------|
| R01 | Task 1 | Dead code removal |
| R02 | Task 2 | Import consolidation |
| R03 | Task 7 | PYS extraction |
| R04 | Task 2 | Response helper usage |
| R05 | Task 2 | Rename DepegAlertPayload |
| R06 | Task 1 | Unexport dead symbol |
| R07 | Task 1 | Unexport dead symbol |
| R08 | Task 1 | Remove dead export |
| R09 | Task 1 | Unexport + rename |
| R10 | Task 1 | Unexport internal constants |
| R11 | Task 2 | Use recordOutcomeSafe |
| R12 | Task 2 | DAY_SECONDS consolidation |
| R13 | Task 8 | DEX type consolidation |
| R14 | Task 2 | formatCurrency usage |
| R15 | Task 2 | formatSignedPercent import |
| R16 | Task 8 | Methodology version factory |
| Q01 | Task 4 | Auth hardening |
| Q02 | Task 11 | Options objects |
| Q03 | Task 5 | Scoring engine tests |
| Q04 | Task 13 | backfill-depegs decomposition |
| Q05 | Task 14 | telegram-alerts decomposition |
| Q06 | — | Skipped (already validated by existing Zod schemas in shared/types/market.ts) |
| Q07 | Task 3 | Explicit reserves:undefined |
| Q08 | Task 12 | Error classification |
| Q09 | — | Abandoned (itemCount is CronResult contract — rename breaks cron infrastructure) |
| Q11 | Task 9 | External API schemas |
| Q13 | Task 11 | Atomic DDL |
| Q14 | Task 15 | enrich-prices decomposition |
| Q15 | Task 11 | BigInt Tron amounts |
| Q16 | Task 6 | Supply/peg utility tests |
| S01 | Task 10 | Migration uniqueness check |
| S03 | Task 10 | CI safety scripts |
| S04 | Task 12 | Rate limiter deprecation |
| S05 | — | Deferred (scale trigger) |
| S06 | — | Deferred (scale trigger) |
| S09 | Task 3 | Remove @/* from worker tsconfig |
| S10 | — | No action (acknowledged) |
| S17 | — | Deferred (milestone trigger) |
| S20 | Task 16 | Connection budget docs |
| S21 | — | Deferred to separate plan (Miniflare setup is a standalone project) |
| S02 | — | Manual cleanup (not code) |
