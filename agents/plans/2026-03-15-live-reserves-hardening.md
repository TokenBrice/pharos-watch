# Live Reserves & Dependency Adjustment Hardening Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate all 20 findings from the live-reserves audit — validation gaps, observability holes, breaker bias, test coverage, metadata fixes, dead code removal, and documentation updates.

**Architecture:** Defense-in-depth validation at three layers (adapter output → orchestrator gate → store read-back), standalone drift-check function wired from the hourly reserve cron (which has `runtime.alertWebhookUrl`), worst-outcome breaker recording via deferred post-loop pattern, and comprehensive test coverage for the integration boundary.

**Tech Stack:** TypeScript strict, Vitest, Cloudflare Workers D1, shared `@shared/types` and `@shared/lib`.

**Audit reference:** `agents/audits/live-reserves-dependency-adjustment-audit.md`

---

## Chunk 1: Validation & Guards

Fixes the NaN propagation risk in scoring, strengthens slice validation at both the store layer and the orchestrator output boundary.

### Task 1: Guard `computeCollateralQualityFromReserves` against invalid risk values

**Files:**
- Modify: `shared/lib/report-cards.ts:321-329`
- Modify: `src/lib/__tests__/report-cards.test.ts`

- [ ] **Step 1: Write the failing test — NaN propagation from invalid risk**

In `src/lib/__tests__/report-cards.test.ts`, add in the existing `computeCollateralQualityFromReserves` describe block:

```typescript
it("treats unknown risk values as 0 instead of producing NaN", () => {
  const slices = [
    { name: "Good", pct: 50, risk: "low" as ReserveRisk },
    { name: "Bad", pct: 50, risk: "bogus" as unknown as ReserveRisk },
  ];
  const score = computeCollateralQualityFromReserves(slices);
  expect(Number.isFinite(score)).toBe(true);
  expect(score).toBe(Math.round((50 * 75 + 50 * 0) / 100)); // 38
});

it("returns 0 when all risk values are invalid", () => {
  const slices = [
    { name: "A", pct: 60, risk: "invalid" as unknown as ReserveRisk },
    { name: "B", pct: 40, risk: "nope" as unknown as ReserveRisk },
  ];
  expect(computeCollateralQualityFromReserves(slices)).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run -t "treats unknown risk values"`
Expected: FAIL — currently produces NaN

- [ ] **Step 3: Add the guard in `computeCollateralQualityFromReserves`**

In `shared/lib/report-cards.ts`, change lines 324-327:

```typescript
export function computeCollateralQualityFromReserves(reserves: ReserveSlice[]): number {
  const totalPct = reserves.reduce((s, r) => s + r.pct, 0);
  if (totalPct === 0) return 0;
  const weighted = reserves.reduce(
    (s, r) => s + r.pct * (RESERVE_QUALITY_SCORE[r.risk] ?? 0),
    0,
  );
  return Math.round(weighted / totalPct);
}
```

The only change is `RESERVE_QUALITY_SCORE[r.risk]` → `(RESERVE_QUALITY_SCORE[r.risk] ?? 0)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run -t "computeCollateralQualityFromReserves"`
Expected: all pass

- [ ] **Step 5: Commit**

```
feat: guard collateral quality scoring against invalid risk enum values
```

---

### Task 2: Strengthen `isValidSlice` with risk enum and pct range checks

**Files:**
- Modify: `worker/src/lib/live-reserves-store.ts:91-98`
- Modify: `worker/src/lib/__tests__/live-reserves-store.test.ts`

- [ ] **Step 1: Write the failing tests — invalid risk and negative pct filtered out**

In `worker/src/lib/__tests__/live-reserves-store.test.ts`, add inside the existing describe block:

```typescript
it("filters slices with invalid risk enum values during resolution", async () => {
  const now = Math.floor(Date.now() / 1000);
  const db = mockD1([
    {
      match: "reserve_composition",
      rows: [],
      first: {
        stablecoin_id: "iusd-infinifi",
        slices: JSON.stringify([
          { name: "Good", pct: 60, risk: "low" },
          { name: "Bad", pct: 40, risk: "bogus" },
        ]),
        fetched_at: now,
        source: "infinifi",
      },
    },
    {
      match: "reserve_sync_state",
      rows: [],
      first: {
        stablecoin_id: "iusd-infinifi",
        adapter_key: "infinifi",
        breaker_key: "live-reserves:infinifi",
        last_attempted_at: now,
        last_success_at: now,
        last_status: "ok",
        warning_count: 0,
        warnings: null,
        last_error: null,
        metadata: "{}",
      },
    },
  ]);

  const result = await resolveReserveResult(db, "iusd-infinifi", now + 100);
  // Only the valid slice should survive
  expect(result!.reserves).toHaveLength(1);
  expect(result!.reserves[0].name).toBe("Good");
});

it("filters slices with negative pct during resolution", async () => {
  const now = Math.floor(Date.now() / 1000);
  const db = mockD1([
    {
      match: "reserve_composition",
      rows: [],
      first: {
        stablecoin_id: "iusd-infinifi",
        slices: JSON.stringify([
          { name: "Valid", pct: 80, risk: "medium" },
          { name: "Negative", pct: -10, risk: "low" },
          { name: "Zero", pct: 0, risk: "high" },
        ]),
        fetched_at: now,
        source: "infinifi",
      },
    },
    {
      match: "reserve_sync_state",
      rows: [],
      first: {
        stablecoin_id: "iusd-infinifi",
        adapter_key: "infinifi",
        breaker_key: "live-reserves:infinifi",
        last_attempted_at: now,
        last_success_at: now,
        last_status: "ok",
        warning_count: 0,
        warnings: null,
        last_error: null,
        metadata: "{}",
      },
    },
  ]);

  const result = await resolveReserveResult(db, "iusd-infinifi", now + 100);
  expect(result!.reserves).toHaveLength(1);
  expect(result!.reserves[0].name).toBe("Valid");
});
```

Note: These tests use the `mockD1()` canned response pattern (matching by SQL table name) that this test file already uses. The `resolveReserveResult` function queries `reserve_composition` via `.first()` and `reserve_sync_state` via `.first()`, and the mock matches the SQL by substring.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run -t "filters slices with invalid risk"`
Expected: FAIL — currently "bogus" passes the type-only validation

- [ ] **Step 3: Strengthen `isValidSlice`**

In `worker/src/lib/live-reserves-store.ts`, replace the `isValidSlice` function (lines 91-99):

```typescript
const VALID_RISKS = new Set(["very-low", "low", "medium", "high", "very-high"]);

function isValidSlice(item: unknown): item is ReserveSlice {
  if (!item || typeof item !== "object") return false;
  const slice = item as Partial<ReserveSlice>;
  return (
    typeof slice.name === "string"
    && slice.name.length > 0
    && typeof slice.pct === "number"
    && Number.isFinite(slice.pct)
    && slice.pct > 0
    && typeof slice.risk === "string"
    && VALID_RISKS.has(slice.risk)
  );
}
```

- [ ] **Step 4: Apply `isValidSlice` filtering in `loadFreshLiveReserveMap` too**

In `worker/src/lib/live-reserves-store.ts`, change `loadFreshLiveReserveMap` (line 390):

```typescript
// OLD:
      const slices: ReserveSlice[] = JSON.parse(row.slices);
      if (slices.length >= minSlices) {
        map.set(row.stablecoin_id, slices);
      }

// NEW:
      const raw: unknown[] = JSON.parse(row.slices);
      const slices = raw.filter(isValidSlice);
      if (slices.length >= minSlices) {
        map.set(row.stablecoin_id, slices);
      }
```

This closes the validation chain: `isValidSlice` is now applied at both the read-back path (`loadFreshLiveReserveMap` → scoring) and the resolution path (`parseSlices` → API response), ensuring invalid risk/pct values never reach `computeCollateralQualityFromReserves`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- --run worker/src/lib/__tests__/live-reserves-store`
Expected: all pass

Note: The existing test "filters out malformed slices from D1 data during resolution" (line 150) tests `{ name: "Valid Too", pct: 10, risk: "high" }` which now passes the stricter validation. Check that the existing test still passes: the "Valid Farm" (pct=60, risk="low") and "Valid Too" (pct=10, risk="high") slices both have valid risks and positive pct, so they pass. The "Missing Risk", "Bad Pct", and missing-name slices still fail.

- [ ] **Step 6: Commit**

```
fix: strengthen isValidSlice with risk enum validation and pct range checks
```

---

### Task 3: Add orchestrator-level adapter output validation

**Files:**
- Create: `worker/src/cron/reserve-adapters/validate.ts`
- Modify: `worker/src/cron/sync-live-reserves.ts:144-165`
- Create: `worker/src/cron/__tests__/reserve-adapter-validate.test.ts`

- [ ] **Step 1: Write the failing test for `validateAdapterOutput`**

Create `worker/src/cron/__tests__/reserve-adapter-validate.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { validateAdapterOutput } from "../reserve-adapters/validate";

describe("validateAdapterOutput", () => {
  it("accepts valid slices summing to 100", () => {
    const result = validateAdapterOutput({
      slices: [
        { name: "A", pct: 60, risk: "low" },
        { name: "B", pct: 40, risk: "medium" },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("warns when slices sum deviates from 100 by more than 5 points", () => {
    const result = validateAdapterOutput({
      slices: [{ name: "A", pct: 80, risk: "low" }],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0].code).toBe("pct-sum-deviation");
  });

  it("rejects slices with invalid risk enum values", () => {
    const result = validateAdapterOutput({
      slices: [
        { name: "A", pct: 50, risk: "low" },
        { name: "B", pct: 50, risk: "bogus" as any },
      ],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects slices with negative pct", () => {
    const result = validateAdapterOutput({
      slices: [
        { name: "A", pct: -10, risk: "low" },
        { name: "B", pct: 110, risk: "medium" },
      ],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects slices with NaN pct", () => {
    const result = validateAdapterOutput({
      slices: [{ name: "A", pct: NaN, risk: "low" }],
    });
    expect(result.valid).toBe(false);
  });

  it("accepts slices with sum deviation within tolerance", () => {
    const result = validateAdapterOutput({
      slices: [
        { name: "A", pct: 51, risk: "low" },
        { name: "B", pct: 51, risk: "medium" },
      ],
    });
    expect(result.valid).toBe(true); // sum = 102, within 5-point tolerance
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run reserve-adapter-validate`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `validateAdapterOutput`**

Create `worker/src/cron/reserve-adapters/validate.ts`:

```typescript
import type { LiveReserveWarning, ReserveSlice } from "@shared/types";
import { isReserveRisk } from "./helpers";

interface ValidationInput {
  slices: ReserveSlice[];
}

interface ValidationResult {
  valid: boolean;
  warnings: LiveReserveWarning[];
}

const PCT_SUM_TOLERANCE = 5;

export function validateAdapterOutput(input: ValidationInput): ValidationResult {
  const warnings: LiveReserveWarning[] = [];

  for (const slice of input.slices) {
    if (!Number.isFinite(slice.pct) || slice.pct < 0) {
      return { valid: false, warnings: [{ code: "invalid-pct", message: `Slice "${slice.name}" has invalid pct: ${slice.pct}`, severity: "warning" }] };
    }
    if (!isReserveRisk(slice.risk)) {
      return { valid: false, warnings: [{ code: "invalid-risk", message: `Slice "${slice.name}" has invalid risk: ${slice.risk}`, severity: "warning" }] };
    }
  }

  const sum = input.slices.reduce((s, r) => s + r.pct, 0);
  if (Math.abs(sum - 100) > PCT_SUM_TOLERANCE) {
    warnings.push({
      code: "pct-sum-deviation",
      message: `Slice percentages sum to ${sum.toFixed(1)}% (expected ~100%)`,
      severity: "warning",
    });
  }

  return { valid: true, warnings };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run reserve-adapter-validate`
Expected: all pass

- [ ] **Step 5: Wire validation into the orchestrator**

In `worker/src/cron/sync-live-reserves.ts`, add import at top:

```typescript
import { validateAdapterOutput } from "./reserve-adapters/validate";
```

After `const result = await runAdapter(coin, config, adapter);` (line 145), before the empty-slices check, insert:

```typescript
      const validation = validateAdapterOutput(result);
      if (!validation.valid) {
        console.warn(`[sync-live-reserves] Adapter output invalid for ${coin.id}: ${validation.warnings.map(w => w.message).join("; ")}`);
        failed++;
        coinsWithErrors.push(coin.id);
        await upsertReserveSyncState(db, buildReserveSyncStateRecord({
          stablecoinId: coin.id,
          config,
          breakerKey,
          previousLastSuccessAt: previousState?.lastSuccessAt ?? null,
          now,
          status: "error",
          lastError: `Validation failed: ${validation.warnings.map(w => w.message).join("; ")}`,
          metadata: { reason: "validation-failed" },
        }));
        if (!recordedBreakerOutcomes.has(breakerKey)) {
          await recordOutcomeSafe(db, breakerKey, false);
          recordedBreakerOutcomes.add(breakerKey);
        }
        continue;
      }

      // Propagate sum-deviation warnings to result warnings
      if (validation.warnings.length > 0) {
        result.warnings = [...(result.warnings ?? []), ...validation.warnings];
      }
```

Note: This uses the existing `recordedBreakerOutcomes` Set pattern. Task 6 later refactors all breaker recording sites (including this one) to the deferred Map pattern.

- [ ] **Step 6: Run full test suite**

Run: `npm test -- --run`
Expected: all pass

- [ ] **Step 7: Commit**

```
feat: add orchestrator-level adapter output validation (risk enum, pct range, sum check)
```

---

### Task 4: Log malformed JSON skips in `loadFreshLiveReserveMap`

**Files:**
- Modify: `worker/src/lib/live-reserves-store.ts:394-396`

- [ ] **Step 1: Add logging to the catch block**

In `worker/src/lib/live-reserves-store.ts`, change lines 394-396:

```typescript
    } catch {
      console.warn(`[live-reserves-store] Skipping malformed slices JSON for ${row.stablecoin_id}`);
    }
```

- [ ] **Step 2: Run existing tests**

Run: `npm test -- --run worker/src/lib/__tests__/live-reserves-store`
Expected: all pass

- [ ] **Step 3: Commit**

```
fix: log malformed JSON skips in loadFreshLiveReserveMap for diagnostics
```

---

## Chunk 2: Observability — Delta Alerts & Fallback Transitions

Wires the delta alert and live-to-curated fallback transition into the existing alert system and cron metadata.

### Task 5: Wire delta alerts into a standalone drift-check function called from reserve cron

**Context:** The API handler `handleReportCards` in `worker/src/api/report-cards.ts` only receives `(db: D1Database)` — it has no access to `webhookUrl` or `env`. The cron handler `hourly-live-reserves.ts` has access to `runtime.alertWebhookUrl` via `ScheduledRuntimeContext`. Firing alerts from the API handler would also spam on every GET request.

**Design:** Create a standalone `checkCollateralDrift(db)` function that returns drift data. Wire alert firing in `hourly-live-reserves.ts` after `syncLiveReserves` completes. Also enrich `buildReportCardsSnapshot` to return drift metadata for `/status` visibility.

**Files:**
- Create: `worker/src/lib/collateral-drift.ts`
- Create: `worker/src/lib/__tests__/collateral-drift.test.ts`
- Modify: `worker/src/lib/report-cards-snapshot.ts:46-59,245-256`
- Modify: `worker/src/handlers/scheduled/hourly-live-reserves.ts`

- [ ] **Step 1: Write the failing tests for drift detection**

Create `worker/src/lib/__tests__/collateral-drift.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { computeCollateralQualityFromReserves } from "@shared/lib/report-cards";
import type { ReserveSlice } from "@shared/types";

describe("collateral score delta detection", () => {
  function computeDelta(live: ReserveSlice[], curated: ReserveSlice[]): number {
    return Math.abs(
      computeCollateralQualityFromReserves(live) -
      computeCollateralQualityFromReserves(curated),
    );
  }

  it("detects no drift when compositions match", () => {
    const slices: ReserveSlice[] = [
      { name: "USDC", pct: 100, risk: "low" },
    ];
    expect(computeDelta(slices, slices)).toBe(0);
  });

  it("detects drift above threshold when composition diverges", () => {
    const live: ReserveSlice[] = [{ name: "ETH", pct: 100, risk: "very-low" }];
    const curated: ReserveSlice[] = [{ name: "SOL", pct: 100, risk: "high" }];
    // live = 100, curated = 25, delta = 75
    expect(computeDelta(live, curated)).toBe(75);
    expect(computeDelta(live, curated)).toBeGreaterThan(15);
  });

  it("stays below threshold for minor composition changes", () => {
    const live: ReserveSlice[] = [
      { name: "Treasuries", pct: 55, risk: "very-low" },
      { name: "USDC", pct: 45, risk: "low" },
    ];
    const curated: ReserveSlice[] = [
      { name: "Treasuries", pct: 60, risk: "very-low" },
      { name: "USDC", pct: 40, risk: "low" },
    ];
    expect(computeDelta(live, curated)).toBeLessThanOrEqual(15);
  });

  it("boundary: exactly 15 does not trigger (threshold is >15)", () => {
    // live: 40% very-low + 60% low = 40+45=85. curated: 100% very-low = 100. delta=15.
    const live: ReserveSlice[] = [
      { name: "A", pct: 40, risk: "very-low" },
      { name: "B", pct: 60, risk: "low" },
    ];
    const curated: ReserveSlice[] = [{ name: "A", pct: 100, risk: "very-low" }];
    expect(computeDelta(live, curated)).toBe(15);
    // 15 is NOT > 15, so no alert
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm test -- --run collateral-drift`
Expected: all pass (these test the pure function, which already works)

- [ ] **Step 3: Create standalone drift-check module**

Create `worker/src/lib/collateral-drift.ts`:

```typescript
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { computeCollateralQualityFromReserves } from "@shared/lib/report-cards";
import { loadFreshLiveReserveMap } from "./live-reserves-store";

const DRIFT_THRESHOLD = 15;

export interface CollateralDriftEntry {
  id: string;
  liveScore: number;
  curatedScore: number;
  delta: number;
}

export interface CollateralDriftResult {
  driftCoins: CollateralDriftEntry[];
  fallbackCoins: string[];
}

/**
 * Load fresh live reserves and compare with curated reserve metadata.
 * Returns coins with score drift > 15 points and coins that fell back to curated.
 */
export async function checkCollateralDrift(db: D1Database): Promise<CollateralDriftResult> {
  const liveReserveMap = await loadFreshLiveReserveMap(db);
  const driftCoins: CollateralDriftEntry[] = [];
  const fallbackCoins: string[] = [];

  for (const meta of TRACKED_STABLECOINS) {
    if (!meta.liveReservesConfig) continue;

    const liveSlices = liveReserveMap.get(meta.id);
    if (!liveSlices) {
      fallbackCoins.push(meta.id);
      continue;
    }

    if (meta.reserves && meta.reserves.length > 0) {
      const liveScore = computeCollateralQualityFromReserves(liveSlices);
      const curatedScore = computeCollateralQualityFromReserves(meta.reserves);
      const delta = Math.abs(liveScore - curatedScore);
      if (delta > DRIFT_THRESHOLD) {
        driftCoins.push({ id: meta.id, liveScore, curatedScore, delta });
      }
    }
  }

  return { driftCoins, fallbackCoins };
}
```

- [ ] **Step 4: Enrich `buildReportCardsSnapshot` with drift metadata**

In `worker/src/lib/report-cards-snapshot.ts`, update the `ReportCardsSnapshot` interface (lines 46-59):

```typescript
export interface ReportCardsSnapshot {
  cards: ReportCard[];
  methodology: {
    version: string;
    weights: Record<DimensionKey, number>;
    pegMultiplierExponent: number;
    thresholds: { grade: ReportCardGrade; min: number }[];
  };
  dependencyGraph: {
    edges: { from: string; to: string }[];
  };
  updatedAt: number;
  liquidityStale: boolean;
  /** Coins where live vs curated collateral score diverges by >15 points (may be empty) */
  collateralDriftCoins?: CollateralDriftEntry[];
  /** Coins that fell back from live to curated scoring (may be empty) */
  liveToFallbackCoins?: string[];
}
```

Add import at the top:

```typescript
import type { CollateralDriftEntry } from "./collateral-drift";
```

In `buildReportCardsSnapshot`, before the card loop, add accumulators:

```typescript
  const collateralDriftCoins: CollateralDriftEntry[] = [];
  const liveToFallbackCoins: string[] = [];
```

After `liveCards.push(card);` (line 137), add tracking logic:

```typescript
    // Track drift for snapshot metadata
    const liveSlices = liveReserveMap.get(meta.id);
    if (liveSlices && meta.reserves && meta.reserves.length > 0) {
      const liveScore = computeCollateralQualityFromReserves(liveSlices);
      const curatedScore = computeCollateralQualityFromReserves(meta.reserves);
      const delta = Math.abs(liveScore - curatedScore);
      if (delta > 15) {
        collateralDriftCoins.push({ id: meta.id, liveScore, curatedScore, delta });
      }
    }
    if (meta.liveReservesConfig && !liveReserveMap.has(meta.id)) {
      liveToFallbackCoins.push(meta.id);
    }
```

Remove the existing delta alert block from `computeCard` (lines 245-256 of the current code):

```typescript
  // DELETE these lines:
  // Delta alerting: warn when live and curated collateral scores diverge significantly
  if (liveSlices && meta.reserves && meta.reserves.length > 0) {
    ...
  }
```

Include in the return object (inside the `return { ... }` at line 204):

```typescript
    ...(collateralDriftCoins.length > 0 ? { collateralDriftCoins } : {}),
    ...(liveToFallbackCoins.length > 0 ? { liveToFallbackCoins } : {}),
```

- [ ] **Step 5: Wire alerting in the hourly reserve cron handler**

In `worker/src/handlers/scheduled/hourly-live-reserves.ts`, add imports and post-sync drift check:

```typescript
import { syncLiveReserves } from "../../cron/sync-live-reserves";
import { syncRedemptionBackstops } from "../../cron/sync-redemption-backstops";
import { checkCollateralDrift } from "../../lib/collateral-drift";
import { sendAlert } from "../../lib/alerts";
import type { ScheduledRuntimeContext } from "./context";

export function runHourlyReserveSyncSlot(runtime: ScheduledRuntimeContext): void {
  runtime.ctx.waitUntil(
    (async () => {
      try {
        await runtime.runLeasedCron("sync-live-reserves", (signal) =>
          syncLiveReserves(runtime.db, signal, {
            etherscanApiKey: runtime.env.ETHERSCAN_API_KEY,
            alchemyApiKey: runtime.env.ALCHEMY_API_KEY,
            chainRpcs: runtime.chainRpcs,
          }),
        );
      } finally {
        await runtime.runLeasedCron("sync-redemption-backstops", (signal) =>
          syncRedemptionBackstops(runtime.db, signal),
        );
      }

      // Post-sync: check for collateral drift and fire alerts
      try {
        const drift = await checkCollateralDrift(runtime.db);
        if (drift.driftCoins.length > 0) {
          const summary = drift.driftCoins
            .map((d) => `${d.id}: live=${d.liveScore}, curated=${d.curatedScore} (Δ${d.delta})`)
            .join("\n");
          console.warn(`[live-reserves] Collateral drift detected:\n${summary}`);
          sendAlert(
            runtime.alertWebhookUrl,
            "Collateral Score Drift",
            `${drift.driftCoins.length} coin(s) with >15pt live/curated divergence:\n${summary}`,
          ).catch(() => {});
        }
        if (drift.fallbackCoins.length > 5) {
          console.warn(`[live-reserves] ${drift.fallbackCoins.length} live-enabled coins using curated fallback`);
        }
      } catch (e) {
        console.error("[live-reserves] Drift check failed:", e);
      }
    })(),
  );
}
```

- [ ] **Step 6: Run full test suite**

Run: `npm test -- --run`
Expected: all pass

- [ ] **Step 7: Commit**

```
feat: wire collateral drift alerts into hourly reserve cron with standalone drift-check module
```

---

### Task 6: Fix breaker outcome first-wins bias

**Context:** The current `recordedBreakerOutcomes` Set (line 79) ensures only the first coin per breaker key records an outcome. If coin A succeeds and coin B (same breaker key) fails, the breaker records success — hiding the failure. The fix: accumulate outcomes in a Map and record the worst (failure trumps success) after the loop.

**Files:**
- Modify: `worker/src/cron/sync-live-reserves.ts:79, 137-140, 160-163, 193-196, 212-215`

- [ ] **Step 1: Replace `recordedBreakerOutcomes` Set with `breakerOutcomes` Map**

In `worker/src/cron/sync-live-reserves.ts`, change line 79:

```typescript
// OLD:
const recordedBreakerOutcomes = new Set<string>();

// NEW:
const breakerOutcomes = new Map<string, boolean>();
```

- [ ] **Step 2: Replace inline breaker recording at each of the 4 call sites**

**Site 1 — Unknown adapter failure (lines 137-140):**

```typescript
// OLD:
      if (!recordedBreakerOutcomes.has(breakerKey)) {
        await recordOutcomeSafe(db, breakerKey, false);
        recordedBreakerOutcomes.add(breakerKey);
      }

// NEW:
      breakerOutcomes.set(breakerKey, false);
```

**Site 2 — Empty slices failure (lines 160-163):**

```typescript
// OLD:
        if (!recordedBreakerOutcomes.has(breakerKey)) {
          await recordOutcomeSafe(db, breakerKey, false);
          recordedBreakerOutcomes.add(breakerKey);
        }

// NEW:
        breakerOutcomes.set(breakerKey, false);
```

**Site 3 — Adapter success (lines 193-196):**

```typescript
// OLD:
      if (!recordedBreakerOutcomes.has(breakerKey)) {
        await recordOutcomeSafe(db, breakerKey, true);
        recordedBreakerOutcomes.add(breakerKey);
      }

// NEW — only set true if not already false (failure wins):
      if (breakerOutcomes.get(breakerKey) !== false) {
        breakerOutcomes.set(breakerKey, true);
      }
```

**Site 4 — Adapter exception catch block (lines 212-215):**

```typescript
// OLD:
      if (!recordedBreakerOutcomes.has(breakerKey)) {
        await recordOutcomeSafe(db, breakerKey, false);
        recordedBreakerOutcomes.add(breakerKey);
      }

// NEW:
      breakerOutcomes.set(breakerKey, false);
```

- [ ] **Step 3: Add deferred recording after the main loop**

After the `for (const coin of CONFIGURED_COINS)` loop (after line 217), insert:

```typescript
  // Deferred breaker outcome recording: worst outcome per key wins
  for (const [key, success] of breakerOutcomes) {
    await recordOutcomeSafe(db, key, success);
  }
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --run sync-live-reserves`
Expected: all pass

- [ ] **Step 5: Commit**

```
fix: record worst breaker outcome per key instead of first-wins bias
```

---

## Chunk 3: Metadata & Dead Code Cleanup

### Task 7: Add curated reserves to wsrUSD

**Files:**
- Modify: `shared/lib/stablecoins/usd-minor.ts:2504-2553`

- [ ] **Step 1: Research wsrUSD reserves**

The reservoir adapter (`reservoir.ts`) shows bucket configs: USD1, PYUSD, RLUSD, GHO, USDT/USDT0, USDC, rUSD strategy vaults. These are all medium-risk stablecoin lending positions. Since wsrUSD has `collateralQuality: "exotic"` and is a multi-stablecoin lending protocol, add a curated reserve approximation.

- [ ] **Step 2: Add reserves array**

In `shared/lib/stablecoins/usd-minor.ts`, add after the `liveReservesConfig` block (before `links`):

```typescript
    reserves: [
      { name: "USDC positions", pct: 30, risk: "medium", coinId: "usdc-circle", depType: "wrapper" },
      { name: "USDT / USDT0 positions", pct: 25, risk: "medium", coinId: "usdt-tether", depType: "wrapper" },
      { name: "rUSD strategy vaults", pct: 20, risk: "medium" },
      { name: "PYUSD lending markets", pct: 10, risk: "medium", coinId: "pyusd-paypal", depType: "wrapper" },
      { name: "GHO lending markets", pct: 5, risk: "medium", coinId: "gho-aave", depType: "wrapper" },
      { name: "USD1 lending markets", pct: 5, risk: "medium", coinId: "usd1-world-liberty-financial", depType: "wrapper" },
      { name: "RLUSD lending markets", pct: 5, risk: "medium", coinId: "rlusd-ripple", depType: "wrapper" },
    ],
```

Note: These percentages are estimates that match the reservoir adapter bucket structure. They'll be superseded by live data when the adapter runs, and delta alerting will flag if the real composition diverges significantly.

- [ ] **Step 3: Run build + type check**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: clean

- [ ] **Step 4: Run reserve consistency tests**

Run: `npm test -- --run reserve-risk-consistency`
Expected: pass

- [ ] **Step 5: Commit**

```
fix: add curated reserves to wsrUSD for fallback scoring and delta alerting
```

---

### Task 8: Remove dead `ousd` adapter

**Files:**
- Delete: `worker/src/cron/reserve-adapters/ousd.ts`
- Modify: `worker/src/cron/reserve-adapters/index.ts:19,68`

- [ ] **Step 1: Verify no coins use ousd adapter**

Run a grep to confirm:

```bash
grep -r '"ousd"' shared/lib/stablecoins/ --include="*.ts"
```

Expected: no results for `adapter: "ousd"`.

- [ ] **Step 2: Remove ousd from the adapter registry**

In `worker/src/cron/reserve-adapters/index.ts`:
- Remove the import line for `fetchOusdReserves` from `"./ousd"`
- Remove the `ousd: fetchOusdReserves,` entry from the registry object

- [ ] **Step 3: Delete the adapter file**

Delete `worker/src/cron/reserve-adapters/ousd.ts`.

- [ ] **Step 4: Run build + tests**

Run: `npm run build && npm test -- --run`
Expected: all pass

- [ ] **Step 5: Commit**

```
chore: remove dead ousd adapter (0 configured coins)
```

---

### Task 9: Deduplicate `deriveDependencies` calls in `computeCard`

**Files:**
- Modify: `worker/src/lib/report-cards-snapshot.ts:281,296-299`

- [ ] **Step 1: Compute dependencies once and reuse**

In `computeCard()`, add at the top (after `const liveSlices = liveReserveMap.get(meta.id);`):

```typescript
  const deps = deriveDependencies(meta);
```

Change line 281:

```typescript
// OLD:
    dependencies: deriveDependencies(meta),
// NEW:
    dependencies: deps,
```

Change lines 296-299:

```typescript
// OLD:
    ...(() => {
      const deps = deriveDependencies(meta);
      return deps.length > 0 ? { dependencies: deps } : {};
    })(),
// NEW:
    ...(deps.length > 0 ? { dependencies: deps } : {}),
```

This eliminates 2 of the 3 calls. The one inside `scoreDependencyRisk` remains (that function is pure and used elsewhere).

- [ ] **Step 2: Run tests**

Run: `npm test -- --run`
Expected: all pass

- [ ] **Step 3: Commit**

```
refactor: cache deriveDependencies result in computeCard to avoid redundant calls
```

---

## Chunk 4: Test Coverage

### Task 10: Add topological ordering tests

**Files:**
- Modify: `worker/src/lib/report-cards-snapshot.ts:304` (export the function)
- Create: `worker/src/lib/__tests__/report-cards-snapshot-topo.test.ts`

- [ ] **Step 1: Export `topologicalOrder` from `report-cards-snapshot.ts`**

Change `function topologicalOrder(` to `export function topologicalOrder(` at line 304.

- [ ] **Step 2: Write tests**

Create `worker/src/lib/__tests__/report-cards-snapshot-topo.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { topologicalOrder } from "../report-cards-snapshot";
import type { StablecoinMeta } from "@shared/types";

function makeMeta(id: string, reserves?: Array<{ coinId?: string; pct: number; name: string; risk: "low" }>): StablecoinMeta {
  return {
    id,
    name: id,
    symbol: id.toUpperCase(),
    flags: { governance: "centralized", backing: "rwa-backed" },
    reserves: reserves ?? [],
  } as unknown as StablecoinMeta;
}

describe("topologicalOrder", () => {
  it("returns isolated nodes in original order", () => {
    const metas = [makeMeta("a"), makeMeta("b"), makeMeta("c")];
    const sorted = topologicalOrder(metas);
    expect(sorted.map(m => m.id)).toEqual(["a", "b", "c"]);
  });

  it("places upstream before downstream", () => {
    const metas = [
      makeMeta("downstream", [{ coinId: "upstream", pct: 50, name: "X", risk: "low" }]),
      makeMeta("upstream"),
    ];
    const sorted = topologicalOrder(metas);
    const ids = sorted.map(m => m.id);
    expect(ids.indexOf("upstream")).toBeLessThan(ids.indexOf("downstream"));
  });

  it("handles diamond dependencies", () => {
    const metas = [
      makeMeta("d", [{ coinId: "b", pct: 30, name: "B", risk: "low" }, { coinId: "c", pct: 30, name: "C", risk: "low" }]),
      makeMeta("b", [{ coinId: "a", pct: 50, name: "A", risk: "low" }]),
      makeMeta("c", [{ coinId: "a", pct: 50, name: "A", risk: "low" }]),
      makeMeta("a"),
    ];
    const sorted = topologicalOrder(metas);
    const ids = sorted.map(m => m.id);
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("c"));
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("d"));
    expect(ids.indexOf("c")).toBeLessThan(ids.indexOf("d"));
  });

  it("handles circular dependencies without infinite loop", () => {
    const metas = [
      makeMeta("x", [{ coinId: "y", pct: 50, name: "Y", risk: "low" }]),
      makeMeta("y", [{ coinId: "x", pct: 50, name: "X", risk: "low" }]),
    ];
    // Should not hang — visited set prevents infinite recursion
    const sorted = topologicalOrder(metas);
    expect(sorted).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npm test -- --run report-cards-snapshot-topo`
Expected: all pass

- [ ] **Step 4: Commit**

```
test: add topologicalOrder unit tests (basic, diamond, circular)
```

---

### Task 11: Add fixture-based tests for mento adapter

**Files:**
- Modify: `worker/src/cron/__tests__/reserve-adapters.test.ts`

- [ ] **Step 1: Add mento adapter tests**

In `worker/src/cron/__tests__/reserve-adapters.test.ts`, add imports:

```typescript
import { parseMentoReserveComposition, adaptMentoReserveComposition } from "../reserve-adapters/mento";
```

Add test blocks after the GHO tests:

```typescript
// --- Mento adapter tests ---

describe("parseMentoReserveComposition", () => {
  const VALID_HTML = `blah\\"reserveComposition\\":[{\\"symbol\\":\\"USDC\\",\\"percent\\":40},{\\"symbol\\":\\"ETH\\",\\"percent\\":30},{\\"symbol\\":\\"CELO\\",\\"percent\\":20},{\\"symbol\\":\\"stETH\\",\\"percent\\":10}],\\"reserveHoldings\\":blah`;

  it("parses valid escaped reserve composition", () => {
    const entries = parseMentoReserveComposition(VALID_HTML);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toEqual({ symbol: "USDC", percent: 40 });
  });

  it("throws on missing reserveComposition marker", () => {
    expect(() => parseMentoReserveComposition("no data here")).toThrow("missing reserveComposition");
  });

  it("throws on missing reserveHoldings delimiter", () => {
    const broken = `\\"reserveComposition\\":[{"symbol":"USDC","percent":40}]`;
    expect(() => parseMentoReserveComposition(broken)).toThrow("missing reserveHoldings delimiter");
  });
});

describe("adaptMentoReserveComposition", () => {
  const VALID_HTML = `blah\\"reserveComposition\\":[{\\"symbol\\":\\"USDC\\",\\"percent\\":40},{\\"symbol\\":\\"ETH\\",\\"percent\\":30},{\\"symbol\\":\\"CELO\\",\\"percent\\":20},{\\"symbol\\":\\"stETH\\",\\"percent\\":10}],\\"reserveHoldings\\":blah`;

  it("maps known tokens to correct risk levels", () => {
    const result = adaptMentoReserveComposition(VALID_HTML);
    const usdc = result.slices.find(s => s.name.includes("USDC"));
    const eth = result.slices.find(s => s.name === "ETH");
    expect(usdc?.risk).toBe("low");
    expect(eth?.risk).toBe("very-low");
  });

  it("warns on unknown asset symbols", () => {
    const html = `blah\\"reserveComposition\\":[{\\"symbol\\":\\"USDC\\",\\"percent\\":40},{\\"symbol\\":\\"MYSTERY\\",\\"percent\\":30},{\\"symbol\\":\\"ETH\\",\\"percent\\":30}],\\"reserveHoldings\\":blah`;
    const result = adaptMentoReserveComposition(html);
    expect(result.warnings?.some(w => w.code === "unknown-asset")).toBe(true);
  });

  it("warns on low entry count", () => {
    const html = `blah\\"reserveComposition\\":[{\\"symbol\\":\\"USDC\\",\\"percent\\":50},{\\"symbol\\":\\"ETH\\",\\"percent\\":50}],\\"reserveHoldings\\":blah`;
    const result = adaptMentoReserveComposition(html);
    expect(result.warnings?.some(w => w.code === "mento-low-entry-count")).toBe(true);
  });

  it("warns on low total percentage", () => {
    const html = `blah\\"reserveComposition\\":[{\\"symbol\\":\\"USDC\\",\\"percent\\":10},{\\"symbol\\":\\"ETH\\",\\"percent\\":10},{\\"symbol\\":\\"CELO\\",\\"percent\\":10}],\\"reserveHoldings\\":blah`;
    const result = adaptMentoReserveComposition(html);
    expect(result.warnings?.some(w => w.code === "mento-low-total-pct")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm test -- --run reserve-adapters`
Expected: all pass

- [ ] **Step 3: Commit**

```
test: add fixture-based tests for mento HTML adapter
```

---

### Task 12: Add fixture-based tests for reservoir adapter

**Files:**
- Modify: `worker/src/cron/__tests__/reserve-adapters.test.ts`

- [ ] **Step 1: Add reservoir adapter tests**

In `worker/src/cron/__tests__/reserve-adapters.test.ts`, add imports:

```typescript
import { adaptReservoirReserves, type ReservoirReservesResponse } from "../reserve-adapters/reservoir";
```

Add test block:

```typescript
// --- Reservoir adapter tests ---

describe("adaptReservoirReserves", () => {
  it("buckets known assets correctly", () => {
    const payload: ReservoirReservesResponse = {
      assets: [
        { label: "Morpho USDC Vault", totalBalanceValue: "5000000" },
        { label: "Euler USDT0 Vault", totalBalanceValue: "3000000" },
        { label: "Morpho GHO Vault", totalBalanceValue: "2000000" },
      ],
      liabilities: [],
      totalAssets: "10000000",
      totalLiabilities: "9500000",
      equity: "500000",
    };
    const result = adaptReservoirReserves(payload);
    expect(result.slices.length).toBeGreaterThanOrEqual(3);
    expect(result.unknownAssets).toHaveLength(0);
    const usdc = result.slices.find(s => s.name.includes("USDC"));
    expect(usdc?.coinId).toBe("usdc-circle");
  });

  it("reports unknown assets", () => {
    const payload: ReservoirReservesResponse = {
      assets: [
        { label: "Mystery Protocol", totalBalanceValue: "1000000" },
        { label: "Morpho USDC Vault", totalBalanceValue: "9000000" },
      ],
      liabilities: [],
      totalAssets: "10000000",
      totalLiabilities: "9500000",
      equity: "500000",
    };
    const result = adaptReservoirReserves(payload);
    expect(result.unknownAssets).toContain("Mystery Protocol");
  });

  it("returns empty slices for zero total assets", () => {
    const payload: ReservoirReservesResponse = {
      assets: [],
      liabilities: [],
      totalAssets: "0",
      totalLiabilities: "0",
      equity: "0",
    };
    const result = adaptReservoirReserves(payload);
    expect(result.slices).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm test -- --run reserve-adapters`
Expected: all pass

- [ ] **Step 3: Commit**

```
test: add fixture-based tests for reservoir adapter
```

---

## Chunk 5: Documentation

### Task 13: Document `isBlacklistable` curated-vs-live inconsistency

**Files:**
- Modify: `docs/report-cards.md`
- Modify: `docs/live-reserves.md`

- [ ] **Step 1: Add documentation to report-cards.md**

In `docs/report-cards.md`, after the "Live Reserve Passthrough (v5.8)" section (around line 89), add:

```markdown
#### Known Limitation: Blacklist Inherited Uses Curated Data

`isBlacklistable()` computes `"possible-inherited"` blacklistability from curated
`StablecoinMeta.reserves` (which carry `coinId` links), not from live adapter
snapshots. Live adapter slices do not carry `coinId` because adapters return generic
slice names without linking to tracked Pharos stablecoin IDs.

This means the blacklist capability sub-factor and the collateral quality sub-factor
within Resilience can see different reserve compositions when live data diverges from
curated. The collateral drift alert (>15pt divergence) helps operators detect when
curated metadata needs updating, which also refreshes the blacklist-inherited
calculation.
```

- [ ] **Step 2: Update live-reserves.md scope boundaries**

In `docs/live-reserves.md`, in the "Scope Boundaries" section (around line 243), add a bullet:

```markdown
- `isBlacklistable()` inherited detection still uses curated `meta.reserves` (which carry `coinId` links). Live adapter slices lack `coinId`, so inherited blacklist scoring cannot use live data. The collateral drift alert flags when these two sources diverge.
```

- [ ] **Step 3: Commit**

```
docs: document isBlacklistable curated-vs-live inconsistency in report-cards and live-reserves
```

---

### Task 14: Update docs with all changes from this plan

**Files:**
- Modify: `docs/live-reserves.md`
- Modify: `docs/report-cards.md`

- [ ] **Step 1: Update live-reserves.md**

Add to the "Cron Behavior" section:

```markdown
**Adapter output validation:** After each adapter returns, `validateAdapterOutput()` checks
that all slice `risk` values are valid enum members, all `pct` values are finite and non-negative,
and the sum is within 5 points of 100%. Invalid output is treated as an error. Sum deviation
is propagated as a warning.
```

Update the adapter count:

```markdown
- **Current coverage:** 45 live-enabled stablecoins across 23 registered adapters
```

(Was 24 — the `ousd` adapter was removed.)

Add to the "Known Limitation: Fallback Inputs" section, a note about the deferred breaker outcome:

```markdown
**Circuit breaker recording:** Breaker outcomes are deferred until the entire sync loop
completes, recording the worst outcome per breaker key (failure trumps success). This
prevents first-coin-wins bias where a successful early coin would mask failures of later
coins sharing the same breaker key.
```

- [ ] **Step 2: Update report-cards.md**

In the "Live Reserve Passthrough (v5.8)" section, add after the delta alert paragraph:

```markdown
Delta alerts are now fired from the hourly reserve sync cron via `checkCollateralDrift()`.
Drift data is also included in the report-cards snapshot as `collateralDriftCoins` for
`/status` visibility. Coins using curated fallback (no fresh live data) are tracked as
`liveToFallbackCoins` in the snapshot metadata.
```

- [ ] **Step 3: Commit**

```
docs: update live-reserves and report-cards docs with hardening changes
```

---

## Chunk 6: Build, Type-check & Final Verification

### Task 15: Final verification

- [ ] **Step 1: Full build + type-check**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: clean, no errors

- [ ] **Step 2: Full test suite**

Run: `npm test -- --run`
Expected: all pass

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: clean

- [ ] **Step 4: Verify doc count guard**

Run: `npm run check:doc-counts`
Expected: pass (adapter count change in docs should be reflected)

- [ ] **Step 5: Final commit if any fixups needed**

```
chore: fixups from final verification
```
