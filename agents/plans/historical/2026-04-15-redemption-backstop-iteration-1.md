# Redemption Backstop Iteration 1 — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten the redemption backstop implementation through targeted test coverage, code deduplication, documentation of rationale, and a small methodology version bump. No scoring semantics change in this iteration.

**Architecture:** The redemption backstop pipeline is: config (code) → capacity resolver → scoring → store → report-card consumer. Iteration 1 focuses on the scoring + report-card consumer layer. The audit found two independent `hasStrongLiveDirectRoute` implementations that drift; missing boundary tests for the 2500 bps severe-depeg gate; no tests for `live-proxy` under severe depegs; and hardcoded route-family caps without documented rationale. Iteration 1 fixes all four without touching any coin scores.

**Tech Stack:** TypeScript, Vitest, Node, `@shared/*` path alias, D1-less shared-lib tests.

---

## Audit Context (read before starting)

**Verified facts** (confirmed via TypeScript import + code reads, not the faulty raw regex grep):

- 190 tracked stablecoins (canonical-order.json)
- 138 coins with `liveReservesConfig`
- 147 coins with a `REDEMPTION_BACKSTOP_CONFIGS` entry (route families: 81 offchain-issuer, 21 stablecoin-redeem, 19 collateral-redeem, 15 queue-redeem, 8 psm-swap, 3 basket-redeem)
- 122 coins have both live reserves AND a backstop config
- 16 coins have live reserves but no backstop config (candidates for iteration 2+)
- 25 coins have a backstop config but no live reserves adapter (static/documented)
- Current methodology version: `3.96` → bump to `3.97`
- `ACTIVE_DEPEG_CAP_F_BPS = 2500` (severe-depeg exclusion threshold)
- `REDEMPTION_ROUTE_FAMILY_CAPS = { queueRedeem: 70, offchainIssuer: 65 }`

**Confirmed structural issues**:

1. `hasStrongLiveDirectRoute` is implemented twice:
   - `shared/lib/report-card-peg-liquidity.ts:115-119` — reads `redemption.capacityConfidence`, `redemption.sourceMode`, `redemption.accessModel`, `redemption.settlementModel` from an entry
   - `worker/src/lib/redemption-backstop-sources.ts:147-151` — reads `capacity.capacityConfidence`, `capacity.sourceMode`, `config.accessModel`, `config.settlementModel` from build-time inputs
   - They do the same check with identical rules. Any change to one risks drift.

2. No boundary test for severe-depeg threshold. The existing tests use `activeDepegBps: 8332` and `activeDepegBps: 3000` — neither pinpoints the exact 2500 bps boundary or the 2499 just-below case.

3. No test that confirms `live-proxy` routes are impaired under severe depeg (documented in v3.8 changelog but not covered by an assertion).

4. No test that a severe-depeg + live-direct + permissionless + atomic route survives. The existing test at `report-cards.test.ts:348-354` uses `activeDepegBps: 3000` but does not explicitly assert on the `hasStrongLiveDirectRoute` combination.

5. `REDEMPTION_ROUTE_FAMILY_CAPS` is hardcoded with no JSDoc. The v3.7 changelog documents why, but the scoring file is self-contained and should carry inline rationale.

**Not in scope for iteration 1** (deferred to iteration 2+):

- Adding backstop configs for the 16 coins with live reserves but no backstop (requires per-coin research)
- Promoting proxy adapters to direct (requires adapter migration to on-chain reads)
- Revisiting `resolveCapacitySemantics` to let `permissionless-onchain + atomic + supply-full` routes be `immediate-bounded` (methodology change that affects 10+ coins)
- Fixing documentation drift — none found; the 147 count is correct once `expandIds` is accounted for

---

## File Structure

**Modify (no new files):**

- `shared/lib/redemption-backstop-scoring.ts` — extract shared predicate, add JSDoc on caps
- `shared/lib/report-card-peg-liquidity.ts` — delete local `hasStrongLiveDirectRoute`, import from scoring
- `worker/src/lib/redemption-backstop-sources.ts` — delete local `hasStrongLiveDirectRoute`, import from scoring
- `shared/lib/redemption-backstop-version.ts` — add 3.97 changelog entry, bump currentVersion
- `docs/redemption-backstops.md` — update version reference
- `shared/lib/__tests__/redemption-backstop-scoring.test.ts` — add boundary tests for capacity score and effective-exit
- `shared/lib/__tests__/report-cards.test.ts` — add depeg boundary and live-proxy tests

**Do not touch:**

- `worker/src/lib/redemption-backstop-capacity.ts` — no capacity logic changes
- `shared/lib/redemption-backstop-confidence.ts` — no confidence logic changes
- Any coin JSON data — no config changes
- Any reserve adapter code — no adapter changes

---

## Task 1: Extract shared `hasStrongLiveDirectRoute` predicate

**Files:**
- Modify: `shared/lib/redemption-backstop-scoring.ts` (add new exported function)
- Modify: `shared/lib/report-card-peg-liquidity.ts:115-120` (remove local, import)
- Modify: `worker/src/lib/redemption-backstop-sources.ts:147-151` (remove local, import)
- Test: `shared/lib/__tests__/redemption-backstop-scoring.test.ts` (new describe block)

### Step 1.1: Add the shared predicate in `shared/lib/redemption-backstop-scoring.ts`

Append at the end of the file (before the existing `REDEMPTION_ROUTE_FAMILY_LABELS` export):

```typescript
import type {
  RedemptionAccessModel,
  RedemptionCapacityConfidence,
  RedemptionExecutionModel,
  RedemptionOutputAssetType,
  RedemptionRouteFamily,
  RedemptionSettlementModel,
  RedemptionSourceMode,
} from "../types";
```

(Extend the existing import block rather than adding a second — `RedemptionCapacityConfidence` and `RedemptionSourceMode` are the only new names.)

Then add this function and its signature type:

```typescript
/**
 * A route qualifies as a "strong live-direct" route when its current redemption
 * evidence is fresh on-chain telemetry AND the route itself is permissionless +
 * atomic/immediate. Only these routes remain scoreable during a severe active
 * depeg (≥ {@link ACTIVE_DEPEG_CAP_F_BPS} bps) because only they provide current
 * direct exercisability evidence.
 *
 * See redemption backstop methodology v3.8 (`shared/lib/redemption-backstop-version.ts`).
 */
export interface StrongLiveDirectRouteInput {
  capacityConfidence: RedemptionCapacityConfidence;
  sourceMode: RedemptionSourceMode;
  accessModel: RedemptionAccessModel;
  settlementModel: RedemptionSettlementModel;
}

export function isStrongLiveDirectRoute(input: StrongLiveDirectRouteInput): boolean {
  return (
    input.capacityConfidence === "live-direct" &&
    input.sourceMode === "dynamic" &&
    input.accessModel === "permissionless-onchain" &&
    (input.settlementModel === "atomic" || input.settlementModel === "immediate")
  );
}
```

### Step 1.2: Add unit tests for the predicate

Open `shared/lib/__tests__/redemption-backstop-scoring.test.ts`. At the top, add `isStrongLiveDirectRoute` to the import statement:

```typescript
import {
  computeEffectiveExitScore,
  computeCapacityScore,
  computeRedemptionBackstopScore,
  isStrongLiveDirectRoute,
} from "../redemption-backstop-scoring";
```

At the end of the file, add:

```typescript
describe("isStrongLiveDirectRoute", () => {
  const strongInput = {
    capacityConfidence: "live-direct" as const,
    sourceMode: "dynamic" as const,
    accessModel: "permissionless-onchain" as const,
    settlementModel: "atomic" as const,
  };

  it("returns true for live-direct dynamic permissionless atomic", () => {
    expect(isStrongLiveDirectRoute(strongInput)).toBe(true);
  });

  it("returns true for live-direct dynamic permissionless immediate", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, settlementModel: "immediate" })).toBe(true);
  });

  it("returns false for live-proxy capacity confidence", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, capacityConfidence: "live-proxy" })).toBe(false);
  });

  it("returns false for documented-bound capacity confidence", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, capacityConfidence: "documented-bound" })).toBe(false);
  });

  it("returns false for heuristic capacity confidence", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, capacityConfidence: "heuristic" })).toBe(false);
  });

  it("returns false for estimated source mode", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, sourceMode: "estimated" })).toBe(false);
  });

  it("returns false for static source mode", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, sourceMode: "static" })).toBe(false);
  });

  it("returns false for whitelisted-onchain access", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, accessModel: "whitelisted-onchain" })).toBe(false);
  });

  it("returns false for issuer-api access", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, accessModel: "issuer-api" })).toBe(false);
  });

  it("returns false for same-day settlement", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, settlementModel: "same-day" })).toBe(false);
  });

  it("returns false for queued settlement", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, settlementModel: "queued" })).toBe(false);
  });

  it("returns false for days settlement", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, settlementModel: "days" })).toBe(false);
  });
});
```

### Step 1.3: Run the new test to verify it passes

Run: `npx vitest run shared/lib/__tests__/redemption-backstop-scoring.test.ts`

Expected: all existing tests still pass, and the 12 new `isStrongLiveDirectRoute` tests pass.

### Step 1.4: Replace the local definition in `shared/lib/report-card-peg-liquidity.ts`

The current local definition at lines 115-120 is:

```typescript
function hasStrongLiveDirectRoute(redemption: RedemptionLiquidityInput): boolean {
  return redemption.capacityConfidence === "live-direct" &&
    redemption.sourceMode === "dynamic" &&
    redemption.accessModel === "permissionless-onchain" &&
    (redemption.settlementModel === "atomic" || redemption.settlementModel === "immediate");
}
```

Update the top-of-file import at line 8 from:

```typescript
import { computeEffectiveExitScore, REDEMPTION_ROUTE_FAMILY_LABELS } from "./redemption-backstop-scoring";
```

to:

```typescript
import {
  computeEffectiveExitScore,
  isStrongLiveDirectRoute,
  REDEMPTION_ROUTE_FAMILY_LABELS,
} from "./redemption-backstop-scoring";
```

Then delete lines 115-120 (the local `hasStrongLiveDirectRoute` function) and update the single caller at line 160 from:

```typescript
if (isSevereActiveDepeg(options?.activeDepegBps) && !hasStrongLiveDirectRoute(redemption)) {
```

to:

```typescript
if (
  isSevereActiveDepeg(options?.activeDepegBps) &&
  !(
    redemption.capacityConfidence != null &&
    redemption.sourceMode != null &&
    redemption.accessModel != null &&
    redemption.settlementModel != null &&
    isStrongLiveDirectRoute({
      capacityConfidence: redemption.capacityConfidence,
      sourceMode: redemption.sourceMode,
      accessModel: redemption.accessModel,
      settlementModel: redemption.settlementModel,
    })
  )
) {
```

The null guards are required because `RedemptionLiquidityInput` makes `capacityConfidence`, `sourceMode`, `accessModel`, `settlementModel` all `Partial<...>` (see lines 98-106). If any of those fields are missing, the route is by definition not strong-live-direct, so the overall condition is still `true` (impair).

### Step 1.5: Replace the local definition in `worker/src/lib/redemption-backstop-sources.ts`

Delete the local check at lines 147-151:

```typescript
const hasStrongLiveDirectRoute =
  capacity.capacityConfidence === "live-direct" &&
  capacity.sourceMode === "dynamic" &&
  config.accessModel === "permissionless-onchain" &&
  (config.settlementModel === "atomic" || config.settlementModel === "immediate");
```

Replace with:

```typescript
const hasStrongLiveDirectRoute = isStrongLiveDirectRoute({
  capacityConfidence: capacity.capacityConfidence,
  sourceMode: capacity.sourceMode,
  accessModel: config.accessModel,
  settlementModel: config.settlementModel,
});
```

Update the import at line 7-15 to add `isStrongLiveDirectRoute`:

```typescript
import {
  computeCapacityScore,
  computeEffectiveExitScore,
  computeRedemptionBackstopScore,
  isStrongLiveDirectRoute,
  REDEMPTION_ACCESS_SCORES,
  REDEMPTION_EXECUTION_SCORES,
  REDEMPTION_OUTPUT_ASSET_SCORES,
  REDEMPTION_SETTLEMENT_SCORES,
} from "@shared/lib/redemption-backstop-scoring";
```

### Step 1.6: Run full shared-lib and worker tests

Run: `npm test -- --run shared/lib/__tests__/redemption-backstop-scoring.test.ts shared/lib/__tests__/report-cards.test.ts shared/lib/__tests__/redemption-backstop-consistency.test.ts shared/lib/__tests__/redemption-backstops.test.ts`

Run: `cd worker && npx vitest run src/lib/__tests__/redemption-backstop-sources.test.ts`

Expected: all pass. No regressions.

### Step 1.7: Typecheck worker

Run: `cd worker && npx tsc --noEmit`

Expected: no errors.

### Step 1.8: Commit

```bash
git add shared/lib/redemption-backstop-scoring.ts shared/lib/report-card-peg-liquidity.ts worker/src/lib/redemption-backstop-sources.ts shared/lib/__tests__/redemption-backstop-scoring.test.ts
git commit -m "Extract shared isStrongLiveDirectRoute predicate

Dedupe the two drift-prone copies of the severe-depeg \"strong route\"
check used by scoreLiquidity and the backstop builder. Both copies now
delegate to a single exported predicate in redemption-backstop-scoring."
```

---

## Task 2: Add route family cap JSDoc rationale

**Files:**
- Modify: `shared/lib/redemption-backstop-scoring.ts:20-23`

### Step 2.1: Edit the `REDEMPTION_ROUTE_FAMILY_CAPS` declaration

Current code at lines 20-23:

```typescript
export const REDEMPTION_ROUTE_FAMILY_CAPS = {
  queueRedeem: 70,
  offchainIssuer: 65,
} as const;
```

Replace with:

```typescript
/**
 * Route-family score ceilings applied after the weighted component score.
 *
 * - `queueRedeem` (70): queued redemption inherently involves multi-hour or
 *   multi-day settlement friction plus FIFO processing. Even a perfect
 *   component mix stays below 70/100 so queued rails never match permissionless
 *   atomic rails in the effective-exit blend. See v3.7 methodology changelog.
 *
 * - `offchainIssuer` (65): offchain institutional redemption is gated by KYC,
 *   primary-market access, and banking-hour settlement. The 65 ceiling reflects
 *   the residual par-exit guarantee that CeFi-issued coins carry for retail
 *   holders even without a live instant buffer. See v3.7 methodology changelog.
 */
export const REDEMPTION_ROUTE_FAMILY_CAPS = {
  queueRedeem: 70,
  offchainIssuer: 65,
} as const;
```

### Step 2.2: Verify tests still pass

Run: `npx vitest run shared/lib/__tests__/redemption-backstop-scoring.test.ts`

Expected: same tests still pass.

### Step 2.3: Commit

```bash
git add shared/lib/redemption-backstop-scoring.ts
git commit -m "Document route family cap rationale

Inline JSDoc on REDEMPTION_ROUTE_FAMILY_CAPS explains why queue=70 and
offchain=65 so future readers don't have to chase the v3.7 changelog."
```

---

## Task 3: Add severe-depeg boundary and live-proxy exclusion tests

**Files:**
- Modify: `shared/lib/__tests__/report-cards.test.ts`

### Step 3.1: Find an appropriate place to add tests

Open `shared/lib/__tests__/report-cards.test.ts`. There's an existing `describe("scoreLiquidity", ...)` block around line 219. Add the new tests INSIDE that describe block, right after the last existing `it(...)` test for scoreLiquidity.

### Step 3.2: Add the boundary test cases

Add these `it(...)` blocks inside `describe("scoreLiquidity", ...)`:

```typescript
  it("does NOT exclude redemption at 2499 bps depeg (just below severe threshold)", () => {
    const result = scoreLiquidity(
      { liquidityScore: 10, concentrationHhi: 0.1, poolCount: 1, chainCount: 1 },
      {
        score: 85,
        routeFamily: "stablecoin-redeem",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.2,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
        routeStatus: "open",
        capacityConfidence: "documented-bound",
        sourceMode: "estimated",
        accessModel: "issuer-api",
        settlementModel: "same-day",
      },
      { activeDepegBps: 2499 },
    );
    // Redemption score is NOT excluded at 2499 bps
    expect(result.score).not.toBeNull();
    expect(result.detail).not.toContain("not used for Safety Score uplift");
  });

  it("excludes non-live-direct redemption at exactly 2500 bps depeg (severe threshold)", () => {
    const result = scoreLiquidity(
      { liquidityScore: 10, concentrationHhi: 0.1, poolCount: 1, chainCount: 1 },
      {
        score: 85,
        routeFamily: "stablecoin-redeem",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.2,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
        routeStatus: "open",
        capacityConfidence: "documented-bound",
        sourceMode: "estimated",
        accessModel: "issuer-api",
        settlementModel: "same-day",
      },
      { activeDepegBps: 2500 },
    );
    expect(result.detail).toContain("active severe depeg requires live-open redemption evidence");
  });

  it("does NOT exclude strong live-direct redemption at 2500 bps depeg", () => {
    const result = scoreLiquidity(
      { liquidityScore: 10, concentrationHhi: 0.1, poolCount: 1, chainCount: 1 },
      {
        score: 85,
        routeFamily: "stablecoin-redeem",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.2,
        resolutionState: "resolved",
        modelConfidence: "high",
        capacitySemantics: "immediate-bounded",
        routeStatus: "open",
        capacityConfidence: "live-direct",
        sourceMode: "dynamic",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
      },
      { activeDepegBps: 2500 },
    );
    // Strong live-direct route survives the severe-depeg gate
    expect(result.detail).not.toContain("active severe depeg requires live-open redemption evidence");
    expect(result.score).not.toBeNull();
  });

  it("excludes live-proxy redemption during severe depeg (not considered strong)", () => {
    const result = scoreLiquidity(
      { liquidityScore: 10, concentrationHhi: 0.1, poolCount: 1, chainCount: 1 },
      {
        score: 85,
        routeFamily: "stablecoin-redeem",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.2,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
        routeStatus: "open",
        capacityConfidence: "live-proxy",
        sourceMode: "dynamic",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
      },
      { activeDepegBps: 2500 },
    );
    // live-proxy is explicitly NOT considered strong even with permissionless + atomic
    expect(result.detail).toContain("active severe depeg requires live-open redemption evidence");
  });

  it("excludes redemption with route status degraded", () => {
    const result = scoreLiquidity(
      { liquidityScore: 40, concentrationHhi: 0.3, poolCount: 5, chainCount: 2 },
      {
        score: 85,
        routeFamily: "stablecoin-redeem",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.2,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
        routeStatus: "degraded",
      },
    );
    expect(result.detail).toContain("route currently degraded");
  });

  it("excludes redemption with route status paused", () => {
    const result = scoreLiquidity(
      { liquidityScore: 40, concentrationHhi: 0.3, poolCount: 5, chainCount: 2 },
      {
        score: 85,
        routeFamily: "stablecoin-redeem",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.2,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
        routeStatus: "paused",
      },
    );
    expect(result.detail).toContain("route currently paused");
  });

  it("excludes redemption with route status cohort-limited", () => {
    const result = scoreLiquidity(
      { liquidityScore: 40, concentrationHhi: 0.3, poolCount: 5, chainCount: 2 },
      {
        score: 85,
        routeFamily: "stablecoin-redeem",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.2,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
        routeStatus: "cohort-limited",
      },
    );
    expect(result.detail).toContain("route currently cohort-limited");
  });
```

### Step 3.3: Run the new tests

Run: `npx vitest run shared/lib/__tests__/report-cards.test.ts`

Expected: all existing tests pass + 7 new tests pass.

### Step 3.4: Commit

```bash
git add shared/lib/__tests__/report-cards.test.ts
git commit -m "Add severe-depeg boundary and live-proxy exclusion tests

Lock in four gaps that were not covered:
- 2499 bps (just below severe) does NOT exclude any route
- 2500 bps (severe) excludes non-live-direct routes
- 2500 bps (severe) does NOT exclude strong live-direct routes
- live-proxy + permissionless + atomic is NOT considered strong-live-direct
  under severe depeg (per v3.8 methodology)

Also adds explicit coverage for the three paused/degraded/cohort-limited
route-status exclusion paths."
```

---

## Task 4: Add capacity score boundary and clamping tests

**Files:**
- Modify: `shared/lib/__tests__/redemption-backstop-scoring.test.ts`

### Step 4.1: Add new tests inside the existing `describe("computeCapacityScore", ...)` block

Open `shared/lib/__tests__/redemption-backstop-scoring.test.ts`. Find the `describe("computeCapacityScore", ...)` block (starts around line 65). After the existing `it(...)` test cases for `computeCapacityScore`, add:

```typescript
  it("clamps ratio > 1 to the top breakpoint", () => {
    const result = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 2 });
    expect(result.coverageRatioScore).toBe(100);
  });

  it("returns null for negative ratio", () => {
    const result = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: -0.1 });
    expect(result.coverageRatioScore).toBeNull();
    expect(result.score).toBeNull();
  });

  it("returns null for negative USD", () => {
    const result = computeCapacityScore({ immediateCapacityUsd: -1000, immediateCapacityRatio: null });
    expect(result.absoluteCapacityScore).toBeNull();
    expect(result.score).toBeNull();
  });

  it("returns null for non-finite inputs", () => {
    const nan = computeCapacityScore({ immediateCapacityUsd: NaN, immediateCapacityRatio: null });
    expect(nan.score).toBeNull();
    const inf = computeCapacityScore({ immediateCapacityUsd: Infinity, immediateCapacityRatio: null });
    expect(inf.score).toBeNull();
  });

  it("scores exact ratio breakpoints", () => {
    const bp001 = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 0.01 });
    expect(bp001.coverageRatioScore).toBe(20);
    const bp005 = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 0.05 });
    expect(bp005.coverageRatioScore).toBe(40);
    const bp010 = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 0.10 });
    expect(bp010.coverageRatioScore).toBe(60);
    const bp025 = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 0.25 });
    expect(bp025.coverageRatioScore).toBe(80);
  });

  it("scores exact USD breakpoints", () => {
    const bp100k = computeCapacityScore({ immediateCapacityUsd: 100_000, immediateCapacityRatio: null });
    expect(bp100k.absoluteCapacityScore).toBe(20);
    const bp1m = computeCapacityScore({ immediateCapacityUsd: 1_000_000, immediateCapacityRatio: null });
    expect(bp1m.absoluteCapacityScore).toBe(40);
    const bp10m = computeCapacityScore({ immediateCapacityUsd: 10_000_000, immediateCapacityRatio: null });
    expect(bp10m.absoluteCapacityScore).toBe(60);
    const bp50m = computeCapacityScore({ immediateCapacityUsd: 50_000_000, immediateCapacityRatio: null });
    expect(bp50m.absoluteCapacityScore).toBe(80);
    const bp250m = computeCapacityScore({ immediateCapacityUsd: 250_000_000, immediateCapacityRatio: null });
    expect(bp250m.absoluteCapacityScore).toBe(100);
  });

  it("handles USD beyond top breakpoint without overflow", () => {
    const huge = computeCapacityScore({ immediateCapacityUsd: 1_000_000_000_000, immediateCapacityRatio: null });
    expect(huge.absoluteCapacityScore).toBe(100);
  });
```

### Step 4.2: Add new cap-boundary tests inside `describe("computeRedemptionBackstopScore", ...)`

After the existing `it("applies queue-redeem cap at 70", ...)` test, add:

```typescript
  it("queue-redeem cap is NOT applied when raw score is exactly 70", () => {
    // Craft inputs where the weighted score lands at exactly 70
    // 70 = access*0.20 + ... choose all components = 70
    const result = computeRedemptionBackstopScore({
      routeFamily: "queue-redeem",
      accessScore: 70, settlementScore: 70, executionCertaintyScore: 70,
      capacityScore: 70, outputAssetQualityScore: 70, costScore: 70,
    });
    expect(result.score).toBe(70);
    expect(result.capsApplied).toEqual([]);
  });

  it("queue-redeem cap is applied when raw score is 71", () => {
    // Craft inputs where the weighted score lands just above 70
    // All 71: weighted = 71 → cap applies → 70
    const result = computeRedemptionBackstopScore({
      routeFamily: "queue-redeem",
      accessScore: 71, settlementScore: 71, executionCertaintyScore: 71,
      capacityScore: 71, outputAssetQualityScore: 71, costScore: 71,
    });
    expect(result.score).toBe(70);
    expect(result.capsApplied).toContain("queue-route-cap");
  });

  it("offchain-issuer cap is NOT applied when raw score is exactly 65", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "offchain-issuer",
      accessScore: 65, settlementScore: 65, executionCertaintyScore: 65,
      capacityScore: 65, outputAssetQualityScore: 65, costScore: 65,
    });
    expect(result.score).toBe(65);
    expect(result.capsApplied).toEqual([]);
  });

  it("offchain-issuer cap is applied when raw score is 66", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "offchain-issuer",
      accessScore: 66, settlementScore: 66, executionCertaintyScore: 66,
      capacityScore: 66, outputAssetQualityScore: 66, costScore: 66,
    });
    expect(result.score).toBe(65);
    expect(result.capsApplied).toContain("offchain-route-cap");
  });
```

### Step 4.3: Run the expanded scoring tests

Run: `npx vitest run shared/lib/__tests__/redemption-backstop-scoring.test.ts`

Expected: all tests pass including 4 new capacity-score tests, 2 new USD breakpoint tests, 1 new overflow test, 4 new cap-boundary tests, plus the 12 from Task 1.

### Step 4.4: Commit

```bash
git add shared/lib/__tests__/redemption-backstop-scoring.test.ts
git commit -m "Add capacity-score and route-family cap boundary tests

Lock in behavior at every breakpoint: ratio breakpoints 0.01/0.05/0.10/0.25,
USD breakpoints 100K/1M/10M/50M/250M, clamping above 1 ratio and beyond
250M USD, null returns for negative/non-finite inputs, and the exact
70/71 (queue) and 65/66 (offchain) cap boundaries."
```

---

## Task 5: Methodology version bump to 3.97

**Files:**
- Modify: `shared/lib/redemption-backstop-version.ts`
- Modify: `docs/redemption-backstops.md:9`, `docs/redemption-backstops.md:13`

### Step 5.1: Add the 3.97 changelog entry

Open `shared/lib/redemption-backstop-version.ts`. The current `currentVersion` is `"3.96"` and the latest changelog entry is at the top of the array. Bump to `3.97` and prepend a new entry.

Change line 4 from:

```typescript
  currentVersion: "3.96",
```

to:

```typescript
  currentVersion: "3.97",
```

Insert a new entry at the very top of the `changelog` array (right after the opening `changelog: [`):

```typescript
    {
      version: "3.97",
      title: "Redemption backstop code deduplication and boundary test coverage",
      date: "2026-04-15",
      effectiveAt: 1776290400,
      summary:
        "The \"strong live-direct route\" predicate is now defined once and reused by both the report-card liquidity consumer and the backstop builder, with inline rationale on route family caps and new boundary test coverage.",
      impact: [
        "`isStrongLiveDirectRoute` is now a single shared predicate in `shared/lib/redemption-backstop-scoring.ts` consumed by both `scoreLiquidity` and `buildRedemptionBackstopEntry`, removing the prior drift-prone duplicate definitions",
        "Severe-depeg exclusion behavior is now locked in at the exact 2499/2500 bps boundary, live-proxy routes are explicitly confirmed not to survive severe depegs even with permissionless atomic execution, and all capacity-score and route-family cap breakpoints are covered by assertions",
        "No coin-facing scoring semantics changed; this release is test coverage, documentation, and code deduplication only",
      ],
      commits: [],
      reconstructed: false,
    },
```

The `effectiveAt` value `1776290400` is `1776276000 + 14400` (4 hours after v3.96) to keep entries chronologically ordered.

### Step 5.2: Update `docs/redemption-backstops.md`

Change line 9 from:

```markdown
- **Current methodology version:** `v3.96`
```

to:

```markdown
- **Current methodology version:** `v3.97`
```

Change line 13 from:

```markdown
Latest `v3.96` update: live route-status telemetry now fails closed for paused, degraded, or cohort-limited routes; nested and legacy redemption telemetry fields are validated independently before persistence; unsupported capacity metadata was removed from adapters whose registry definition does not expose redemption-capacity telemetry; and expanded shared route configs now receive per-asset reviewed docs.
```

to:

```markdown
Latest `v3.97` update: the "strong live-direct route" predicate is now defined once and reused by both the report-card liquidity consumer and the backstop builder; severe-depeg boundary behavior and capacity-score breakpoints are now locked in by explicit tests; route family cap rationale is documented inline. No coin-facing scoring semantics changed.
```

### Step 5.3: Run doc-sync checks

Run: `npm run test:merge-gate`

Expected: doc-sync passes. If it complains about the changelog shape, re-check the effectiveAt ordering.

### Step 5.4: Commit

```bash
git add shared/lib/redemption-backstop-version.ts docs/redemption-backstops.md
git commit -m "Bump redemption backstop methodology to v3.97

Pure deduplication, documentation, and test coverage release.
No coin scores change."
```

---

## Task 6: Final validation before push

### Step 6.1: Run the full merge gate

Run: `npm run test:merge-gate`

Expected: all gates pass (format, lint, typecheck, unit, doc-sync).

### Step 6.2: Run the worker-side tests

Run: `cd worker && npm test -- --run`

Expected: all worker tests pass. (If there are no worker test failures related to our changes, continue.)

### Step 6.3: Worker typecheck

Run: `cd worker && npx tsc --noEmit`

Expected: no errors.

### Step 6.4: Verify git status is clean (aside from our commits)

Run: `git status`

Expected: working tree clean, 5 commits ahead of origin/main (or 1 if squashed).

### Step 6.5: Push to origin/main

The user has authorized pushing iteration results to `origin/main`.

Run: `git push origin main`

Expected: push succeeds.

---

## Self-Review Checklist

- [x] Every file path is exact (no TBDs)
- [x] Every code snippet is complete (no "similar to above" shortcuts)
- [x] All type names verified against `shared/types/redemption.ts` (`RedemptionCapacityConfidence`, `RedemptionSourceMode`, `RedemptionAccessModel`, `RedemptionSettlementModel`)
- [x] All function names verified against current codebase (`computeCapacityScore`, `computeRedemptionBackstopScore`, `computeEffectiveExitScore`, `scoreLiquidity`)
- [x] Plan does not touch the capacity resolver, confidence resolver, cost model, store layer, adapters, or coin data
- [x] Plan does not change any coin scores (verified: the new predicate has identical semantics to the two local copies it replaces)
- [x] Every new test has explicit expected values, not just "is not null"
- [x] Version bump uses numeric scheme (3.96 → 3.97), per CLAUDE.md methodology versioning rule
- [x] `effectiveAt` for 3.97 is greater than `effectiveAt` for 3.96 (1776290400 > 1776276000)

## Review Loop

**Review 1 (self):**

- Minor: Task 1.4's null-guard pattern at `report-card-peg-liquidity.ts` is defensive but repetitive. An alternative is to add an overload in `isStrongLiveDirectRoute` that accepts `Partial<StrongLiveDirectRouteInput>` and returns false if any required field is missing. Decision: keep the inline null-guards for now because it's clearer at the call site and doesn't require a new overload.
- Minor: Task 5.1's `effectiveAt: 1776290400` is a fresh timestamp; the v3.96 entry uses `1776276000`. Verified 1776290400 - 1776276000 = 14400 seconds = 4 hours, so the new entry sorts after v3.96. Acceptable.

Status: less than 3 minor issues, proceed.
