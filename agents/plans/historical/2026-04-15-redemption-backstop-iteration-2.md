# Redemption Backstop Iteration 2 — Plan

**Goal:** Add direct unit test coverage for the 9 exported confidence resolver functions and for the private `resolveBoundedFeeScore` helper. Pure test coverage — no semantics change, no methodology version bump.

**Scope:** Two new test files, one tiny production change (export a helper). Everything else untouched.

**Tech Stack:** TypeScript, Vitest, `@shared/*` path alias.

---

## Audit Context

Iteration 1 (commit `8f57e005`) shipped the `isStrongLiveDirectRoute` dedupe + JSDoc + boundary tests + v3.97 bump. After iteration 1, the fresh audit surfaced two test-coverage gaps:

1. **`shared/lib/redemption-backstop-confidence.ts`** — 9 exported functions, 0 direct tests. Only `resolveCapacityConfidence` and `resolveFeeConfidence` are touched indirectly via `redemption-backstop-consistency.test.ts`, and even then only as part of config validation loops — not as branch-by-branch assertions. The other 7 (`resolveCapacitySemantics`, `resolveFeeModelKind`, `deriveModelConfidence`, `inferStoredCapacityConfidence`, `inferStoredCapacitySemantics`, `inferStoredFeeConfidence`, `inferStoredFeeModelKind`) are fully indirect.

2. **`worker/src/lib/redemption-backstop-cost.ts:38-43`** — `resolveBoundedFeeScore` has 4 buckets (`<=10`, `<=50`, `<=100`, else) but the integration tests in `redemption-backstop-sources.test.ts` only cover the sample points 0, 25, 50, 75, 200. The exact boundary pairs (10/11, 50/51, 100/101) are NOT pinned, so an off-by-one regression would slip through.

Both resolvers and the fee-score helper gate user-facing API fields (`modelConfidence`, `feeModelKind`, `capacitySemantics`, `costScore`, `feeConfidence`) — silent decay would degrade API consumer signals without being caught.

**Not in scope** (deferred further):

- Adding backstop configs for the 16 coins with live reserves but no backstop (per-coin research)
- Promoting proxy adapters to direct
- `resolveCapacitySemantics` methodology change (touches scores)
- Direct unit tests for `readRedemptionBackstopLiveMetadata` (large harness surface)
- Extracting coercion helpers from `redemption-backstop-live-metadata.ts` to a shared module (purely cosmetic)

---

## File Structure

**Create:**

- `shared/lib/__tests__/redemption-backstop-confidence.test.ts` — direct tests for all 9 exported functions
- `worker/src/lib/__tests__/redemption-backstop-cost.test.ts` — boundary tests for the exported `resolveBoundedFeeScore`

**Modify:**

- `worker/src/lib/redemption-backstop-cost.ts:38` — change `function resolveBoundedFeeScore` → `export function resolveBoundedFeeScore` (no behavior change)

**Do not touch:**

- Anything else. No production behavior, no types, no configs, no version.

---

## Task 1: Confidence resolver unit tests

**Files:**
- Create: `shared/lib/__tests__/redemption-backstop-confidence.test.ts`

### Step 1.1: Write the test file

Create `shared/lib/__tests__/redemption-backstop-confidence.test.ts` with the following content:

```typescript
import { describe, expect, it } from "vitest";
import {
  deriveModelConfidence,
  inferStoredCapacityConfidence,
  inferStoredCapacitySemantics,
  inferStoredFeeConfidence,
  inferStoredFeeModelKind,
  resolveCapacityConfidence,
  resolveCapacitySemantics,
  resolveFeeConfidence,
  resolveFeeModelKind,
} from "../redemption-backstop-confidence";

describe("resolveCapacityConfidence", () => {
  it("returns the explicit confidence when set", () => {
    expect(resolveCapacityConfidence({ kind: "supply-full", confidence: "documented-bound" })).toBe("documented-bound");
    expect(resolveCapacityConfidence({ kind: "supply-ratio", ratio: 0.1, confidence: "live-direct" })).toBe("live-direct");
    expect(
      resolveCapacityConfidence({ kind: "reserve-sync-metadata", confidence: "live-proxy" }),
    ).toBe("live-proxy");
  });

  it("defaults reserve-sync-metadata to dynamic when confidence is unset", () => {
    expect(resolveCapacityConfidence({ kind: "reserve-sync-metadata" })).toBe("dynamic");
  });

  it("defaults non-reserve-sync models to heuristic when confidence is unset", () => {
    expect(resolveCapacityConfidence({ kind: "supply-full" })).toBe("heuristic");
    expect(resolveCapacityConfidence({ kind: "supply-ratio", ratio: 0.05 })).toBe("heuristic");
  });
});

describe("resolveCapacitySemantics", () => {
  it("returns eventual-only for supply-full", () => {
    expect(resolveCapacitySemantics({ kind: "supply-full" })).toBe("eventual-only");
    expect(
      resolveCapacitySemantics({ kind: "supply-full", confidence: "documented-bound", basis: "full-system-eventual" }),
    ).toBe("eventual-only");
  });

  it("returns immediate-bounded for supply-ratio", () => {
    expect(resolveCapacitySemantics({ kind: "supply-ratio", ratio: 0.1 })).toBe("immediate-bounded");
  });

  it("returns immediate-bounded for reserve-sync-metadata", () => {
    expect(resolveCapacitySemantics({ kind: "reserve-sync-metadata" })).toBe("immediate-bounded");
    expect(resolveCapacitySemantics({ kind: "reserve-sync-metadata", fallbackRatio: 0.2 })).toBe("immediate-bounded");
  });
});

describe("resolveFeeConfidence", () => {
  it("returns the explicit confidence for fee-bps models", () => {
    expect(resolveFeeConfidence({ kind: "fee-bps", feeBps: 10, confidence: "formula" })).toBe("formula");
    expect(resolveFeeConfidence({ kind: "fee-bps", feeBps: 0, confidence: "undisclosed-reviewed" })).toBe("undisclosed-reviewed");
  });

  it("defaults fee-bps to fixed when confidence is unset", () => {
    expect(resolveFeeConfidence({ kind: "fee-bps", feeBps: 25 })).toBe("fixed");
  });

  it("returns the explicit confidence for dynamic-or-unclear models", () => {
    expect(
      resolveFeeConfidence({ kind: "dynamic-or-unclear", confidence: "formula" }),
    ).toBe("formula");
  });

  it("defaults dynamic-or-unclear to undisclosed-reviewed when confidence is unset", () => {
    expect(resolveFeeConfidence({ kind: "dynamic-or-unclear" })).toBe("undisclosed-reviewed");
    expect(
      resolveFeeConfidence({ kind: "dynamic-or-unclear", feeDescription: "base + variable" }),
    ).toBe("undisclosed-reviewed");
  });
});

describe("resolveFeeModelKind", () => {
  it("returns fixed-bps for fee-bps models regardless of other fields", () => {
    expect(resolveFeeModelKind({ kind: "fee-bps", feeBps: 0 })).toBe("fixed-bps");
    expect(resolveFeeModelKind({ kind: "fee-bps", feeBps: 100, confidence: "formula" })).toBe("fixed-bps");
  });

  it("returns the explicit feeModelKind for dynamic-or-unclear when set", () => {
    expect(
      resolveFeeModelKind({
        kind: "dynamic-or-unclear",
        feeModelKind: "documented-variable",
        feeDescription: "desc",
      }),
    ).toBe("documented-variable");
    expect(
      resolveFeeModelKind({
        kind: "dynamic-or-unclear",
        feeModelKind: "formula",
        confidence: "formula",
      }),
    ).toBe("formula");
  });

  it("returns formula for dynamic-or-unclear when confidence is formula and no explicit kind", () => {
    expect(resolveFeeModelKind({ kind: "dynamic-or-unclear", confidence: "formula" })).toBe("formula");
  });

  it("returns documented-variable for dynamic-or-unclear with feeDescription only", () => {
    expect(
      resolveFeeModelKind({ kind: "dynamic-or-unclear", feeDescription: "min 50 bps + base" }),
    ).toBe("documented-variable");
  });

  it("returns undisclosed-reviewed for dynamic-or-unclear with no description and no formula confidence", () => {
    expect(resolveFeeModelKind({ kind: "dynamic-or-unclear" })).toBe("undisclosed-reviewed");
    expect(
      resolveFeeModelKind({ kind: "dynamic-or-unclear", confidence: "undisclosed-reviewed" }),
    ).toBe("undisclosed-reviewed");
  });
});

describe("deriveModelConfidence", () => {
  it("returns low when resolution state is not resolved", () => {
    expect(
      deriveModelConfidence({
        resolutionState: "failed",
        capacityConfidence: "live-direct",
        feeConfidence: "fixed",
      }),
    ).toBe("low");
    expect(
      deriveModelConfidence({
        resolutionState: "missing-capacity",
        capacityConfidence: "live-direct",
        feeConfidence: "fixed",
      }),
    ).toBe("low");
    expect(
      deriveModelConfidence({
        resolutionState: "missing-cache",
        capacityConfidence: "live-direct",
        feeConfidence: "fixed",
      }),
    ).toBe("low");
    expect(
      deriveModelConfidence({
        resolutionState: "impaired",
        capacityConfidence: "live-direct",
        feeConfidence: "fixed",
      }),
    ).toBe("low");
  });

  it("returns low when resolved but capacity confidence is heuristic", () => {
    expect(
      deriveModelConfidence({
        resolutionState: "resolved",
        capacityConfidence: "heuristic",
        feeConfidence: "fixed",
      }),
    ).toBe("low");
  });

  it("returns high for resolved live-direct with any disclosed fee confidence", () => {
    expect(
      deriveModelConfidence({
        resolutionState: "resolved",
        capacityConfidence: "live-direct",
        feeConfidence: "fixed",
      }),
    ).toBe("high");
    expect(
      deriveModelConfidence({
        resolutionState: "resolved",
        capacityConfidence: "live-direct",
        feeConfidence: "formula",
      }),
    ).toBe("high");
  });

  it("returns medium for resolved live-direct with undisclosed-reviewed fee", () => {
    expect(
      deriveModelConfidence({
        resolutionState: "resolved",
        capacityConfidence: "live-direct",
        feeConfidence: "undisclosed-reviewed",
      }),
    ).toBe("medium");
  });

  it("returns medium for resolved live-proxy, dynamic, and documented-bound capacity", () => {
    for (const capacityConfidence of ["live-proxy", "dynamic", "documented-bound"] as const) {
      expect(
        deriveModelConfidence({
          resolutionState: "resolved",
          capacityConfidence,
          feeConfidence: "fixed",
        }),
      ).toBe("medium");
    }
  });
});

describe("inferStoredCapacityConfidence", () => {
  it("returns dynamic only when provider is reserve-sync-metadata and sourceMode is dynamic", () => {
    expect(
      inferStoredCapacityConfidence({ provider: "reserve-sync-metadata", sourceMode: "dynamic" }),
    ).toBe("dynamic");
  });

  it("returns heuristic for non-dynamic source modes even with reserve-sync-metadata provider", () => {
    expect(
      inferStoredCapacityConfidence({ provider: "reserve-sync-metadata", sourceMode: "estimated" }),
    ).toBe("heuristic");
    expect(
      inferStoredCapacityConfidence({ provider: "reserve-sync-metadata", sourceMode: "static" }),
    ).toBe("heuristic");
  });

  it("returns heuristic for any other provider", () => {
    expect(
      inferStoredCapacityConfidence({ provider: "supply-full-model", sourceMode: "dynamic" }),
    ).toBe("heuristic");
    expect(
      inferStoredCapacityConfidence({ provider: "supply-ratio", sourceMode: "static" }),
    ).toBe("heuristic");
  });
});

describe("inferStoredCapacitySemantics", () => {
  it("returns eventual-only for supply-full-model", () => {
    expect(inferStoredCapacitySemantics({ provider: "supply-full-model" })).toBe("eventual-only");
  });

  it("returns immediate-bounded for any other provider", () => {
    expect(inferStoredCapacitySemantics({ provider: "reserve-sync-metadata" })).toBe("immediate-bounded");
    expect(inferStoredCapacitySemantics({ provider: "supply-ratio" })).toBe("immediate-bounded");
    expect(inferStoredCapacitySemantics({ provider: "sync-error" })).toBe("immediate-bounded");
  });
});

describe("inferStoredFeeConfidence", () => {
  it("returns fixed when feeBps is a number", () => {
    expect(inferStoredFeeConfidence({ feeBps: 0 })).toBe("fixed");
    expect(inferStoredFeeConfidence({ feeBps: 25 })).toBe("fixed");
  });

  it("returns undisclosed-reviewed when feeBps is null", () => {
    expect(inferStoredFeeConfidence({ feeBps: null })).toBe("undisclosed-reviewed");
  });
});

describe("inferStoredFeeModelKind", () => {
  it("returns fixed-bps when feeBps is a number, regardless of other fields", () => {
    expect(
      inferStoredFeeModelKind({ feeBps: 0, feeConfidence: "fixed" }),
    ).toBe("fixed-bps");
    expect(
      inferStoredFeeModelKind({
        feeBps: 25,
        feeConfidence: "formula",
        feeDescription: "formula + base",
      }),
    ).toBe("fixed-bps");
  });

  it("returns formula for null feeBps with formula confidence", () => {
    expect(
      inferStoredFeeModelKind({ feeBps: null, feeConfidence: "formula" }),
    ).toBe("formula");
  });

  it("returns documented-variable for null feeBps without formula confidence but with feeDescription", () => {
    expect(
      inferStoredFeeModelKind({
        feeBps: null,
        feeConfidence: "undisclosed-reviewed",
        feeDescription: "reviewed per PR",
      }),
    ).toBe("documented-variable");
  });

  it("returns undisclosed-reviewed when nothing identifies the fee", () => {
    expect(
      inferStoredFeeModelKind({ feeBps: null, feeConfidence: "undisclosed-reviewed" }),
    ).toBe("undisclosed-reviewed");
  });
});
```

### Step 1.2: Run the new test file

Run: `npx vitest run shared/lib/__tests__/redemption-backstop-confidence.test.ts`

Expected: all tests pass.

### Step 1.3: Commit

```bash
git add shared/lib/__tests__/redemption-backstop-confidence.test.ts
git commit -m "Add unit tests for redemption backstop confidence resolvers"
```

---

## Task 2: Fee score boundary tests

**Files:**
- Modify: `worker/src/lib/redemption-backstop-cost.ts:38` (export the helper)
- Create: `worker/src/lib/__tests__/redemption-backstop-cost.test.ts`

### Step 2.1: Export `resolveBoundedFeeScore`

In `worker/src/lib/redemption-backstop-cost.ts`, change line 38 from:

```typescript
function resolveBoundedFeeScore(feeBps: number): number {
```

to:

```typescript
export function resolveBoundedFeeScore(feeBps: number): number {
```

(Nothing else changes. This function stays in the same file; just becomes importable.)

### Step 2.2: Create the boundary test file

Create `worker/src/lib/__tests__/redemption-backstop-cost.test.ts` with:

```typescript
import { describe, expect, it } from "vitest";
import { resolveBoundedFeeScore } from "../redemption-backstop-cost";

describe("resolveBoundedFeeScore", () => {
  it("scores 0 bps as 100", () => {
    expect(resolveBoundedFeeScore(0)).toBe(100);
  });

  it("scores exactly 10 bps as 100 (top of <=10 bucket)", () => {
    expect(resolveBoundedFeeScore(10)).toBe(100);
  });

  it("scores 11 bps as 80 (first step below 100)", () => {
    expect(resolveBoundedFeeScore(11)).toBe(80);
  });

  it("scores 25 bps as 80", () => {
    expect(resolveBoundedFeeScore(25)).toBe(80);
  });

  it("scores exactly 50 bps as 80 (top of <=50 bucket)", () => {
    expect(resolveBoundedFeeScore(50)).toBe(80);
  });

  it("scores 51 bps as 60 (first step below 80)", () => {
    expect(resolveBoundedFeeScore(51)).toBe(60);
  });

  it("scores 75 bps as 60", () => {
    expect(resolveBoundedFeeScore(75)).toBe(60);
  });

  it("scores exactly 100 bps as 60 (top of <=100 bucket)", () => {
    expect(resolveBoundedFeeScore(100)).toBe(60);
  });

  it("scores 101 bps as 40 (first step below 60)", () => {
    expect(resolveBoundedFeeScore(101)).toBe(40);
  });

  it("scores 200 bps as 40", () => {
    expect(resolveBoundedFeeScore(200)).toBe(40);
  });

  it("scores 500 bps as 40 (no floor below 40)", () => {
    expect(resolveBoundedFeeScore(500)).toBe(40);
  });
});
```

### Step 2.3: Run the new test file

Run: `cd worker && npx vitest run src/lib/__tests__/redemption-backstop-cost.test.ts`

Expected: 11 tests pass.

### Step 2.4: Typecheck worker

Run: `cd worker && npx tsc --noEmit`

Expected: no errors.

### Step 2.5: Commit

```bash
git add worker/src/lib/redemption-backstop-cost.ts worker/src/lib/__tests__/redemption-backstop-cost.test.ts
git commit -m "Add boundary tests for resolveBoundedFeeScore"
```

---

## Task 3: Final validation and push

### Step 3.1: Run full merge gate

Run: `npm run test:merge-gate`

Expected: all gates pass.

### Step 3.2: Push

Run: `git push origin main`

Expected: push succeeds.

---

## Self-Review Checklist

- [x] No methodology version bump (pure test coverage)
- [x] No production behavior change (one helper exported, no logic change)
- [x] Every resolver branch in `redemption-backstop-confidence.ts` is exercised
- [x] Fee-score tests cover all 4 buckets AND the three boundary pairs (10/11, 50/51, 100/101)
- [x] Type inputs match the real `RedemptionCapacityModel` / `RedemptionCostModel` shapes verified from `shared/lib/redemption-backstop-configs/shared.ts`
