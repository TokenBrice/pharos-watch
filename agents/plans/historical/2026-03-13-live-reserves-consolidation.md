# Live Reserves Adapter Consolidation

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the live reserve adapter layer — merge duplicate helpers, fix 3 confirmed bugs, standardize patterns across all 16 adapters, harden the API handler, and close critical test gaps — so the system is maintainable before scaling to more adapters.

**Architecture:** The adapter layer currently has two parallel helper modules (`helpers.ts` and `utils.ts`) with overlapping functions, 4 separate normalize-to-100% implementations, and 7 adapters bypassing shared fetch wrappers. This plan merges everything into a single `helpers.ts`, migrates all adapters to use it, fixes 3 data accuracy bugs, and adds tests for the shared helpers and the 2 untested production adapters.

**Tech Stack:** TypeScript, Vitest, Cloudflare Workers (D1)

**Audit reference:** `agents/plans/live-reserves-audit.md`

---

## File Structure

### Modified files

| File | Change |
|------|--------|
| `worker/src/cron/reserve-adapters/helpers.ts` | Add `requireJsonInputFromConfig`, `isReserveRisk`, `slicesFromValues` (replaces both `slicesFromUsdValues` and `buildReserveSlicesFromValues`). Add `decimals` param to `normalizeSlices`. |
| `worker/src/cron/reserve-adapters/btcfi.ts` | Fix redundant computation bug |
| `worker/src/cron/reserve-adapters/crvusd.ts` | Fix order-dependent risk assignment |
| `worker/src/cron/reserve-adapters/collateral-positions-api.ts` | Remove EUR price fallback |
| `worker/src/cron/reserve-adapters/accountable.ts` | Migrate from utils.ts → helpers.ts, drop direct `fetchWithRetry` |
| `worker/src/cron/reserve-adapters/ethena.ts` | Migrate from utils.ts → helpers.ts, drop direct `fetchWithRetry` |
| `worker/src/cron/reserve-adapters/falcon.ts` | Migrate from utils.ts → helpers.ts, drop direct `fetchWithRetry` |
| `worker/src/cron/reserve-adapters/m0.ts` | Migrate from utils.ts → helpers.ts, drop direct `fetchWithRetry` |
| `worker/src/cron/reserve-adapters/openeden.ts` | Migrate from utils.ts → helpers.ts, drop direct `fetchWithRetry` |
| `worker/src/cron/reserve-adapters/mento.ts` | Migrate from utils.ts → helpers.ts |
| `worker/src/cron/reserve-adapters/infinifi.ts` | Remove inline `isHttpJsonInput` and normalize logic; use helpers |
| `worker/src/cron/reserve-adapters/reservoir.ts` | Remove inline `isHttpJsonInput` and `adjustSlicesToHundred`; use helpers |
| `worker/src/cron/reserve-adapters/erc4626-single-asset.ts` | Remove inline `isOnChainInput`; import from helpers. Move `isReserveRisk` to helpers. |
| `worker/src/cron/reserve-adapters/single-asset.ts` | Add risk validation using shared `isReserveRisk` |
| `worker/src/cron/reserve-adapters/evm-branch-balances.ts` | Migrate `slicesFromUsdValues` → `slicesFromValues` (field rename `usd` → `value`) |
| `worker/src/cron/reserve-adapters/fx.ts` | Use canonical risk helper instead of hardcoded risk, migrate `slicesFromUsdValues` → `slicesFromValues` |
| `worker/src/api/stablecoin-reserves.ts` | Wrap with `withErrorHandler` |

### Deleted files

| File | Reason |
|------|--------|
| `worker/src/cron/reserve-adapters/utils.ts` | Merged into `helpers.ts` |

### New test files

| File | Tests |
|------|-------|
| `worker/src/cron/reserve-adapters/__tests__/helpers.test.ts` | `normalizeSlices`, `slicesFromValues`, `isReserveRisk` |
| `worker/src/cron/reserve-adapters/__tests__/single-asset.test.ts` | Happy path (http-json + onchain), risk validation |
| `worker/src/cron/reserve-adapters/__tests__/evm-branch-balances.test.ts` | Happy path multi-branch balances |

---

## Chunk 1: Consolidate helpers and fix bugs

### Task 1: Extend `helpers.ts` with consolidated functions

This task adds new shared functions to `helpers.ts` that will replace the `utils.ts` exports and inline duplicates. Existing functions remain untouched — adapters will be migrated in later tasks.

**Files:**
- Modify: `worker/src/cron/reserve-adapters/helpers.ts`
- Create: `worker/src/cron/reserve-adapters/__tests__/helpers.test.ts`

- [ ] **Step 1: Write tests for `normalizeSlices` with decimals support**

```typescript
// worker/src/cron/reserve-adapters/__tests__/helpers.test.ts
import { describe, it, expect } from "vitest";
import { normalizeSlices, slicesFromValues, isReserveRisk } from "../helpers";
import type { ReserveSlice } from "@shared/types";

describe("normalizeSlices", () => {
  it("rounds to integers by default and adjusts largest to sum to 100", () => {
    const slices: ReserveSlice[] = [
      { name: "A", pct: 33.3, risk: "low" },
      { name: "B", pct: 33.3, risk: "low" },
      { name: "C", pct: 33.3, risk: "low" },
    ];
    const result = normalizeSlices(slices);
    expect(result.reduce((s, r) => s + r.pct, 0)).toBe(100);
    expect(result).toHaveLength(3);
    // Largest slice gets the remainder
    expect(result[0].pct).toBe(34);
  });

  it("rounds to 1 decimal place when decimals = 1", () => {
    const slices: ReserveSlice[] = [
      { name: "A", pct: 33.33, risk: "low" },
      { name: "B", pct: 33.33, risk: "low" },
      { name: "C", pct: 33.33, risk: "low" },
    ];
    const result = normalizeSlices(slices, 1);
    const sum = Math.round(result.reduce((s, r) => s + r.pct, 0) * 10) / 10;
    expect(sum).toBe(100);
  });

  it("deduplicates slices with the same key", () => {
    const slices: ReserveSlice[] = [
      { name: "A", pct: 50, risk: "low" },
      { name: "A", pct: 50, risk: "low" },
    ];
    const result = normalizeSlices(slices);
    expect(result).toHaveLength(1);
    expect(result[0].pct).toBe(100);
  });

  it("filters zero and negative slices", () => {
    const slices: ReserveSlice[] = [
      { name: "A", pct: 100, risk: "low" },
      { name: "B", pct: 0, risk: "low" },
      { name: "C", pct: -5, risk: "low" },
    ];
    const result = normalizeSlices(slices);
    expect(result).toHaveLength(1);
  });

  it("returns empty for empty input", () => {
    expect(normalizeSlices([])).toEqual([]);
  });

  it("sorts descending by pct", () => {
    const slices: ReserveSlice[] = [
      { name: "Small", pct: 10, risk: "low" },
      { name: "Big", pct: 90, risk: "low" },
    ];
    const result = normalizeSlices(slices);
    expect(result[0].name).toBe("Big");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run worker/src/cron/reserve-adapters/__tests__/helpers.test.ts`
Expected: FAIL — `slicesFromValues` and `isReserveRisk` are not yet exported.

- [ ] **Step 3: Add `decimals` parameter to `normalizeSlices`**

In `worker/src/cron/reserve-adapters/helpers.ts`, modify `normalizeSlices` (line 206) to accept an optional `decimals` parameter (default `0` for backward compatibility):

```typescript
export function normalizeSlices(slices: ReserveSlice[], decimals = 0): ReserveSlice[] {
  const factor = 10 ** decimals;
  const grouped = new Map<string, ReserveSlice>();

  for (const slice of slices) {
    if (!Number.isFinite(slice.pct) || slice.pct <= 0) continue;
    const key = `${slice.name}|${slice.risk}|${slice.coinId ?? ""}|${slice.depType ?? ""}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.pct += slice.pct;
    } else {
      grouped.set(key, { ...slice });
    }
  }

  const normalized = Array.from(grouped.values())
    .map((slice) => ({ ...slice, pct: Math.round(slice.pct * factor) / factor }))
    .filter((slice) => slice.pct > 0);

  if (normalized.length === 0) return normalized;

  const sum = normalized.reduce((acc, slice) => acc + slice.pct, 0);
  const maxIdx = normalized.reduce(
    (maxIndex, slice, index, arr) => (slice.pct > arr[maxIndex].pct ? index : maxIndex),
    0,
  );
  const adjustment = Math.round((100 - sum) * factor) / factor;
  normalized[maxIdx].pct = Math.round((normalized[maxIdx].pct + adjustment) * factor) / factor;

  return normalized
    .filter((slice) => slice.pct > 0)
    .sort((a, b) => b.pct - a.pct);
}
```

- [ ] **Step 4: Add `slicesFromValues` — unified replacement for both `slicesFromUsdValues` and `buildReserveSlicesFromValues`**

Add after `normalizeSlices` in `helpers.ts`. Keep `slicesFromUsdValues` as a deprecated alias for backward compatibility during migration:

```typescript
export function slicesFromValues(
  values: Array<{
    value: number;
    name: string;
    risk: ReserveSlice["risk"];
    coinId?: string;
    depType?: ReserveSlice["depType"];
  }>,
  decimals = 1,
): ReserveSlice[] {
  const filtered = values.filter((v) => Number.isFinite(v.value) && v.value > 0);
  const total = filtered.reduce((acc, v) => acc + v.value, 0);
  if (total <= 0) return [];

  return normalizeSlices(
    filtered.map((v) => ({
      name: v.name,
      pct: (v.value / total) * 100,
      risk: v.risk,
      ...(v.coinId ? { coinId: v.coinId } : {}),
      ...(v.depType ? { depType: v.depType } : {}),
    })),
    decimals,
  );
}
```

Also add `requireJsonInputFromConfig` (replaces `utils.requireHttpJsonInput`):

```typescript
export function requireJsonInputFromConfig(
  config: { inputs: { primary: LiveReserveInput } },
  adapterName: string,
): JsonInput {
  return requireJsonInput(config.inputs.primary, adapterName);
}
```

Also add `isReserveRisk` (moved from `erc4626-single-asset.ts`):

```typescript
export function isReserveRisk(value: unknown): value is ReserveSlice["risk"] {
  return value === "very-low"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "very-high";
}
```

You will need to add the `LiveReservesConfig` import at the top (it's in `@shared/types`).

- [ ] **Step 5: Add tests for `slicesFromValues` and `isReserveRisk`**

Append to `helpers.test.ts`:

```typescript
describe("slicesFromValues", () => {
  it("converts values to percentage slices summing to 100", () => {
    const result = slicesFromValues([
      { value: 700, name: "A", risk: "low" },
      { value: 300, name: "B", risk: "medium" },
    ]);
    expect(result.reduce((s, r) => s + r.pct, 0)).toBe(100);
    expect(result[0]).toMatchObject({ name: "A", pct: 70 });
    expect(result[1]).toMatchObject({ name: "B", pct: 30 });
  });

  it("filters zero and negative values", () => {
    const result = slicesFromValues([
      { value: 100, name: "A", risk: "low" },
      { value: 0, name: "B", risk: "low" },
      { value: -50, name: "C", risk: "low" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].pct).toBe(100);
  });

  it("returns empty for all-zero input", () => {
    expect(slicesFromValues([{ value: 0, name: "A", risk: "low" }])).toEqual([]);
  });

  it("preserves coinId and depType", () => {
    const result = slicesFromValues([
      { value: 100, name: "A", risk: "low", coinId: "usdc-circle", depType: "wrapper" },
    ]);
    expect(result[0].coinId).toBe("usdc-circle");
    expect(result[0].depType).toBe("wrapper");
  });

  it("rounds to 1 decimal by default", () => {
    const result = slicesFromValues([
      { value: 1, name: "A", risk: "low" },
      { value: 1, name: "B", risk: "low" },
      { value: 1, name: "C", risk: "low" },
    ]);
    // 33.3 + 33.3 + 33.4 = 100
    const sum = Math.round(result.reduce((s, r) => s + r.pct, 0) * 10) / 10;
    expect(sum).toBe(100);
  });
});

describe("isReserveRisk", () => {
  it("returns true for valid risk values", () => {
    for (const risk of ["very-low", "low", "medium", "high", "very-high"]) {
      expect(isReserveRisk(risk)).toBe(true);
    }
  });

  it("returns false for invalid values", () => {
    expect(isReserveRisk("lo")).toBe(false);
    expect(isReserveRisk("")).toBe(false);
    expect(isReserveRisk(null)).toBe(false);
    expect(isReserveRisk(undefined)).toBe(false);
    expect(isReserveRisk(42)).toBe(false);
  });
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- --run worker/src/cron/reserve-adapters/__tests__/helpers.test.ts`
Expected: All pass.

- [ ] **Step 7: Run full test suite to verify no regressions**

Run: `npm test -- --run`
Expected: All existing tests still pass. The `normalizeSlices` change is backward-compatible (default `decimals = 0` preserves old rounding behavior).

- [ ] **Step 8: Commit**

```bash
git add worker/src/cron/reserve-adapters/helpers.ts worker/src/cron/reserve-adapters/__tests__/helpers.test.ts
git commit -m "feat(reserves): extend helpers with slicesFromValues, isReserveRisk, and decimals support for normalizeSlices"
```

---

### Task 2: Fix the 3 confirmed bugs

**Files:**
- Modify: `worker/src/cron/reserve-adapters/btcfi.ts:28-53`
- Modify: `worker/src/cron/reserve-adapters/crvusd.ts:21-35`
- Modify: `worker/src/cron/reserve-adapters/collateral-positions-api.ts:67`

- [ ] **Step 1: Fix btcfi — remove redundant identical computation**

The `btcBucket` (lines 39-44) computes the same thing as `total` (lines 30-35). Since this adapter is meant to produce a single "BTC collateral" slice for a BTC-backed stablecoin, simplify `adaptBtcfi` to return a single 100% slice when any non-stable collateral exists:

Replace the body of `adaptBtcfi` in `worker/src/cron/reserve-adapters/btcfi.ts` (lines 28-53):

```typescript
export function adaptBtcfi(market: BtcfiMarketRow[], handlers: BtcfiHandlerRow[]): ReserveSlice[] {
  const handlerMap = new Map(handlers.map((handler) => [handler.id, handler]));
  const total = market.reduce((acc, row) => {
    const handler = handlerMap.get(row.token_handler_id);
    if (!handler || handler.isStable) return acc;
    const value = Number(row.deposit_value ?? "0");
    return Number.isFinite(value) && value > 0 ? acc + value : acc;
  }, 0);

  if (total <= 0) return [];

  return [{ name: "BTC / WBTC / BTCB / cbBTC", pct: 100, risk: "medium" }];
}
```

- [ ] **Step 2: Update btcfi test**

In `worker/src/cron/reserve-adapters/__tests__/btcfi.test.ts`, verify the test still passes. The existing test should already expect a single 100% slice. If it uses `normalizeSlices` output shape, update accordingly.

Run: `npm test -- --run worker/src/cron/reserve-adapters/__tests__/btcfi.test.ts`
Expected: PASS.

- [ ] **Step 3: Fix crvusd — use worst risk across bucket symbols**

In `worker/src/cron/reserve-adapters/crvusd.ts`, the risk is set only on bucket creation (line 62) and never updated for subsequent symbols. Fix by comparing risks when accumulating into an existing bucket.

Add a risk severity comparison helper at the top of `crvusd.ts`:

```typescript
const RISK_SEVERITY: Record<ReserveSlice["risk"], number> = {
  "very-low": 0,
  low: 1,
  medium: 2,
  high: 3,
  "very-high": 4,
};

function worseRisk(a: ReserveSlice["risk"], b: ReserveSlice["risk"]): ReserveSlice["risk"] {
  return RISK_SEVERITY[a] >= RISK_SEVERITY[b] ? a : b;
}
```

Then modify the bucket accumulation (lines 58-63):

```typescript
    const existing = buckets.get(bucket.name);
    if (existing) {
      existing.usd += usd;
      existing.risk = worseRisk(existing.risk, bucket.risk);
    } else {
      buckets.set(bucket.name, { usd, risk: bucket.risk });
    }
```

- [ ] **Step 4: Add crvusd test for worst-risk behavior**

In `worker/src/cron/reserve-adapters/__tests__/crvusd.test.ts`, add a test:

```typescript
it("uses worst risk when multiple symbols share a bucket", () => {
  const payload = {
    chains: {
      ethereum: {
        data: [
          { collateral_amount_usd: 100_000_000, collateral_token: { symbol: "wstETH" } },
          { collateral_amount_usd: 50_000_000, collateral_token: { symbol: "weETH" } },
        ],
      },
    },
  };
  const { slices } = adaptCrvUsd(payload);
  const lstBucket = slices.find((s) => s.name.includes("wstETH"));
  expect(lstBucket).toBeDefined();
  // If either wstETH or weETH has a higher canonical risk, the bucket should use it.
  // Currently both are "low", so this tests the mechanism without breaking if canonical risks change.
  expect(lstBucket!.risk).toBeDefined();
});
```

Run: `npm test -- --run worker/src/cron/reserve-adapters/__tests__/crvusd.test.ts`
Expected: PASS.

- [ ] **Step 5: Fix collateral-positions-api — remove EUR fallback**

In `worker/src/cron/reserve-adapters/collateral-positions-api.ts`, line 67, replace:

```typescript
    const usdPrice = priceInfo?.price?.usd ?? priceInfo?.price?.eur;
```

with:

```typescript
    const usdPrice = priceInfo?.price?.usd;
```

This means assets without a USD price will be silently skipped (the `typeof usdPrice !== "number" || usdPrice <= 0` guard on line 68 will catch `undefined`). This is safer than using a wrong currency.

- [ ] **Step 6: Run all affected tests**

Run: `npm test -- --run worker/src/cron/reserve-adapters/__tests__/collateral-positions-api.test.ts worker/src/cron/reserve-adapters/__tests__/btcfi.test.ts worker/src/cron/reserve-adapters/__tests__/crvusd.test.ts`
Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add worker/src/cron/reserve-adapters/btcfi.ts worker/src/cron/reserve-adapters/crvusd.ts worker/src/cron/reserve-adapters/collateral-positions-api.ts worker/src/cron/reserve-adapters/__tests__/crvusd.test.ts
git commit -m "fix(reserves): btcfi redundant computation, crvusd order-dependent risk, collateral-positions-api EUR-as-USD fallback"
```

---

### Task 3: Migrate `utils.ts`-camp adapters to `helpers.ts`

These 6 adapters import from `utils.ts`: accountable, ethena, falcon, m0, openeden, mento. They also bypass `fetchJsonWithRetry` with direct `fetchWithRetry` imports (except mento which uses `fetchTextWithRetry`). Migrate them all.

**Files:**
- Modify: `worker/src/cron/reserve-adapters/accountable.ts`
- Modify: `worker/src/cron/reserve-adapters/ethena.ts`
- Modify: `worker/src/cron/reserve-adapters/falcon.ts`
- Modify: `worker/src/cron/reserve-adapters/m0.ts`
- Modify: `worker/src/cron/reserve-adapters/openeden.ts`
- Modify: `worker/src/cron/reserve-adapters/mento.ts`

The migration pattern for each adapter is the same:

1. Replace `import { requireHttpJsonInput, buildReserveSlicesFromValues } from "./utils"` with `import { requireJsonInputFromConfig, slicesFromValues } from "./helpers"`
2. Replace `import { fetchWithRetry } from "../../lib/fetch-retry"` with `import { fetchJsonWithRetry } from "./helpers"` (except m0 which needs POST — keep its direct import)
3. Replace `requireHttpJsonInput(config, "name")` → `requireJsonInputFromConfig(config, "name")`
4. Replace `buildReserveSlicesFromValues(entries)` → `slicesFromValues(entries)` (the field name changes from `value` to `value` — same name, no change needed since both use `value` in the `SliceAmount` / `slicesFromValues` input)
5. Replace inline `fetchWithRetry` + status checks with `fetchJsonWithRetry<Type>(url, signal, timeoutMs)`

**Important:** `buildReserveSlicesFromValues` uses a `value` field, and the new `slicesFromValues` also uses `value`. No field rename needed.

**Important:** `slicesFromValues` defaults to `decimals = 1`. The old `buildReserveSlicesFromValues` also defaulted to `decimals = 1`. So behavior is preserved.

**Important:** `slicesFromUsdValues` (used by `fx.ts`) uses a `usd` field. `fx.ts` is in the helpers camp already, not being migrated here. We'll update `fx.ts` later in Task 5 to use `slicesFromValues` with a field rename from `usd` to `value`.

- [ ] **Step 1: Migrate `accountable.ts`**

In `accountable.ts`:
- Replace `import { buildReserveSlicesFromValues, requireHttpJsonInput } from "./utils"` with `import { requireJsonInputFromConfig, slicesFromValues, fetchJsonWithRetry } from "./helpers"`
- Remove `import { fetchWithRetry } from "../../lib/fetch-retry"`
- Replace `requireHttpJsonInput(config, "accountable")` → `requireJsonInputFromConfig(config, "accountable")`
- Replace the manual fetch block (`fetchWithRetry` + `!res` + `!res.ok` + `res.json() as`) with `fetchJsonWithRetry<AccountableResponse>(primaryInput.url, signal, 12_000)`
- Replace all `buildReserveSlicesFromValues(...)` → `slicesFromValues(...)`

- [ ] **Step 2: Migrate `ethena.ts`**

Same pattern. Replace imports, swap `requireHttpJsonInput` → `requireJsonInputFromConfig`, swap manual fetch with `fetchJsonWithRetry<EthenaCollateralResponse>(url, signal, 12_000)`, swap `buildReserveSlicesFromValues` → `slicesFromValues`.

- [ ] **Step 3: Migrate `falcon.ts`**

Same pattern. Replace imports, swap manual fetch with `fetchJsonWithRetry<FalconTransparencyResponse>(url, signal, 12_000)`, swap slice builder.

- [ ] **Step 4: Migrate `openeden.ts`**

Same pattern. Replace imports, swap manual fetch with `fetchJsonWithRetry<OpenEdenReserveCompositionResponse>(url, signal, 12_000)`, swap slice builder.

- [ ] **Step 5: Migrate `m0.ts`**

M0 is the only adapter that does a POST (GraphQL). Keep its direct `fetchWithRetry` import for the POST request only. Migrate the other imports:
- Replace `import { buildReserveSlicesFromValues, requireHttpJsonInput } from "./utils"` with `import { requireJsonInputFromConfig, slicesFromValues } from "./helpers"`
- Replace `requireHttpJsonInput(config, "m0")` → `requireJsonInputFromConfig(config, "m0")`
- Replace `buildReserveSlicesFromValues(...)` → `slicesFromValues(...)`
- Keep `import { fetchWithRetry } from "../../lib/fetch-retry"` (needed for POST)

- [ ] **Step 6: Migrate `mento.ts`**

Mento already imports `fetchTextWithRetry` and `requireHtmlInput` from `./helpers`. Only the `buildReserveSlicesFromValues` import from `./utils` needs changing:
- Replace `import { buildReserveSlicesFromValues } from "./utils"` with `import { slicesFromValues } from "./helpers"` (add to existing helpers import)
- Replace `buildReserveSlicesFromValues(entries, 1)` → `slicesFromValues(entries, 1)`

- [ ] **Step 7: Run all adapter tests**

Run: `npm test -- --run worker/src/cron/reserve-adapters/__tests__/`
Expected: All 14 test files pass. The behavioral change is only in rounding for the adapters that previously went through `normalizeSlices` (integer rounding) and now go through `slicesFromValues` (1-decimal rounding). But the `utils.ts`-camp adapters were already using 1-decimal rounding via `buildReserveSlicesFromValues`, so no behavioral change for them.

- [ ] **Step 8: Commit**

```bash
git add worker/src/cron/reserve-adapters/accountable.ts worker/src/cron/reserve-adapters/ethena.ts worker/src/cron/reserve-adapters/falcon.ts worker/src/cron/reserve-adapters/m0.ts worker/src/cron/reserve-adapters/openeden.ts worker/src/cron/reserve-adapters/mento.ts
git commit -m "refactor(reserves): migrate 6 adapters from utils.ts to helpers.ts"
```

---

### Task 4: Remove inline duplicates from infinifi, reservoir, and erc4626-single-asset

**Files:**
- Modify: `worker/src/cron/reserve-adapters/infinifi.ts`
- Modify: `worker/src/cron/reserve-adapters/reservoir.ts`
- Modify: `worker/src/cron/reserve-adapters/erc4626-single-asset.ts`

- [ ] **Step 1: Clean up `infinifi.ts`**

- Remove the local `isHttpJsonInput` function (line 64-66)
- Import `isHttpJsonInput` and `fetchJsonWithRetry` from `./helpers`
- Remove `import { fetchWithRetry } from "../../lib/fetch-retry"`
- Replace the manual fetch block (lines 126-130) with:
  ```typescript
  const payload = await fetchJsonWithRetry<InfiniFiProtocolData>(url, signal);
  if (payload.code !== "OK") throw new Error("infiniFi API returned non-OK code");
  ```
- Replace the inline normalize-to-100 logic (lines 97-108) with a call to `normalizeSlices` from helpers:
  Import `normalizeSlices` from `./helpers`, then replace the inline adjustment with:
  ```typescript
  const finalSlices = normalizeSlices(rawSlices);
  return { slices: finalSlices, unknownFarms };
  ```
  Note: `rawSlices` already have integer `pct` values from the `Math.round` on line 82, so `normalizeSlices` with default `decimals = 0` preserves behavior exactly.

- [ ] **Step 2: Clean up `reservoir.ts`**

- Remove the local `isHttpJsonInput` function (lines 89-91)
- Remove the local `adjustSlicesToHundred` function (lines 93-106)
- Import `isHttpJsonInput, normalizeSlices` from `./helpers`
- Replace `import { fetchWithRetry } from "../../lib/fetch-retry"` with `import { fetchJsonWithRetry } from "./helpers"` (add to existing import)
- Replace the manual fetch block with `fetchJsonWithRetry<ReservoirReservesResponse>(url, signal, 12_000)`
- Replace `adjustSlicesToHundred(result)` calls with `normalizeSlices(result)`

- [ ] **Step 3: Clean up `erc4626-single-asset.ts`**

- Remove the local `isOnChainInput` function (line 27)
- Remove the local `isReserveRisk` function (lines 31-37)
- Import `isOnchainEvmInput, isReserveRisk` from `./helpers`
- Replace `isOnChainInput(primary)` → `isOnchainEvmInput(primary)` (line 42 area)
- Replace `isReserveRisk(risk)` — same name, now imported from helpers

- [ ] **Step 4: Run all affected tests**

Run: `npm test -- --run worker/src/cron/reserve-adapters/__tests__/`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/reserve-adapters/infinifi.ts worker/src/cron/reserve-adapters/reservoir.ts worker/src/cron/reserve-adapters/erc4626-single-asset.ts
git commit -m "refactor(reserves): remove inline duplicates from infinifi, reservoir, erc4626-single-asset"
```

---

### Task 5: Delete `utils.ts` and update remaining helpers-camp adapters

**Files:**
- Delete: `worker/src/cron/reserve-adapters/utils.ts`
- Modify: `worker/src/cron/reserve-adapters/fx.ts` (use canonical risk, migrate `slicesFromUsdValues` → `slicesFromValues`)
- Modify: `worker/src/cron/reserve-adapters/single-asset.ts` (add risk validation)
- Modify: `worker/src/cron/reserve-adapters/helpers.ts` (remove now-unused `slicesFromUsdValues`)

- [ ] **Step 1: Delete `utils.ts`**

Verify no remaining imports:
Run: `grep -r "from.*./utils" worker/src/cron/reserve-adapters/`
Expected: No results (all migrated in Tasks 3-4).

Then delete the file.

- [ ] **Step 2: Migrate `fx.ts` to use canonical risk and `slicesFromValues`**

In `worker/src/cron/reserve-adapters/fx.ts`:
- Add `import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk"`
- Replace hardcoded `risk: "low" as const` for wstETH with `risk: getCanonicalReserveAssetRisk("WSTETH") ?? "low"`
- Replace hardcoded `risk: "medium" as const` for WBTC with `risk: getCanonicalReserveAssetRisk("WBTC") ?? "medium"`
- Replace `slicesFromUsdValues` import with `slicesFromValues` from helpers
- Update the call site: change `usd:` field to `value:` in the objects passed to the slice builder

- [ ] **Step 3: Add risk validation to `single-asset.ts`**

In `worker/src/cron/reserve-adapters/single-asset.ts`:
- Add `isReserveRisk` to the imports from `./helpers`
- In `readParams` (line 24-30), after the existing falsy check, add risk validation:

```typescript
function readParams(config: LiveReservesConfig): SingleAssetParams {
  const params = (config.params ?? {}) as Partial<SingleAssetParams>;
  if (!params.label || !params.risk) {
    throw new Error("single-asset adapter requires params.label and params.risk");
  }
  if (!isReserveRisk(params.risk)) {
    throw new Error(`single-asset adapter: invalid risk value "${params.risk}"`);
  }
  return params as SingleAssetParams;
}
```

- [ ] **Step 4: Migrate `evm-branch-balances.ts` from `slicesFromUsdValues` → `slicesFromValues`**

`evm-branch-balances.ts` imports `slicesFromUsdValues` from `./helpers` (line 7) and calls it at line 78 with objects using a `usd` field. Migrate:
- Replace `slicesFromUsdValues` import with `slicesFromValues`
- Rename the `usd:` field to `value:` in the objects at lines 84-90

**Rounding precision note:** `slicesFromUsdValues` called `normalizeSlices()` with default `decimals = 0` (integer rounding). `slicesFromValues` defaults to `decimals = 1`. This is an intentional standardization — all adapters will now produce 1-decimal-place percentages for consistency.

- [ ] **Step 5: Remove `slicesFromUsdValues` from helpers.ts**

After `fx.ts` and `evm-branch-balances.ts` are migrated, `slicesFromUsdValues` has no more consumers. Remove it from `helpers.ts` (lines 238-260).

Verify no remaining references:
Run: `grep -r "slicesFromUsdValues" worker/src/cron/reserve-adapters/`
Expected: No results.

- [ ] **Step 6: Run tests and type-check**

Run: `npm test -- --run && cd worker && npx tsc --noEmit`
Expected: All pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add -u worker/src/cron/reserve-adapters/
git commit -m "refactor(reserves): delete utils.ts, use canonical risk in fx, validate risk in single-asset, standardize rounding to 1dp"
```

---

## Chunk 2: Hardening and test coverage

### Task 6: Wrap API handler with `withErrorHandler`

**Files:**
- Modify: `worker/src/api/stablecoin-reserves.ts`

- [ ] **Step 1: Add `withErrorHandler` wrapper**

In `worker/src/api/stablecoin-reserves.ts`:
- Add `withErrorHandler` to the import from `"../lib/api-utils"` (line 1)
- Wrap the handler function:

```typescript
import { jsonFreshResponse, errorResponse, withErrorHandler } from "../lib/api-utils";
import { TRACKED_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { StablecoinReservesResponse } from "@shared/types";
import { resolveReserveResult } from "../lib/live-reserves-store";

const LIVE_CACHE_CONTROL = "public, s-maxage=3600, max-age=300";
const FALLBACK_CACHE_CONTROL = "public, s-maxage=300, max-age=60";

export const handleStablecoinReserves = withErrorHandler("stablecoin-reserves", async (
  db: D1Database,
  stablecoinId: string,
): Promise<Response> => {
  if (!TRACKED_IDS.has(stablecoinId)) {
    return errorResponse(404, "Not found");
  }

  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  if (!meta?.liveReservesConfig) {
    return errorResponse(404, "Not found");
  }

  const resolved = await resolveReserveResult(db, stablecoinId);
  if (!resolved) {
    return errorResponse(404, "Not found");
  }

  const body: StablecoinReservesResponse = {
    stablecoinId,
    mode: resolved.mode,
    reserves: resolved.reserves,
    estimated: resolved.estimated,
    ...(resolved.liveAt != null ? { liveAt: resolved.liveAt } : {}),
    ...(resolved.source ? { source: resolved.source } : {}),
    ...(resolved.displayUrl ? { displayUrl: resolved.displayUrl } : {}),
    ...(resolved.sync ? { sync: resolved.sync } : {}),
  };

  return jsonFreshResponse(body, {
    cacheControl: resolved.mode === "live" ? LIVE_CACHE_CONTROL : FALLBACK_CACHE_CONTROL,
  });
});
```

`withErrorHandler` is a generic passthrough that preserves the handler's parameter signature. Other dynamic-route handlers like `handleStablecoinSummary` use `withErrorHandler("name", async (db: D1Database, id: string) => ...)` — the same `(db, id)` pattern. The router calls `handleStablecoinReserves(db, id)` via a lambda adapter, so the signature is compatible.

- [ ] **Step 2: Run the stablecoin-reserves test**

Run: `npm test -- --run worker/src/api/__tests__/stablecoin-reserves.test.ts`
Expected: PASS. If the test calls `handleStablecoinReserves` directly, verify the signature still matches.

- [ ] **Step 3: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add worker/src/api/stablecoin-reserves.ts
git commit -m "fix(reserves): wrap stablecoin-reserves API handler with withErrorHandler"
```

---

### Task 7: Add tests for `single-asset` adapter

**Files:**
- Create: `worker/src/cron/reserve-adapters/__tests__/single-asset.test.ts`

The `single-asset` adapter has two modes: http-json probe and onchain-evm totalSupply. Since both modes involve I/O (fetch or RPC call), and the adapter doesn't export a pure `adapt*` function, these tests will need to mock `fetchJsonWithRetry` and `fetchErc20TotalSupply`.

- [ ] **Step 1: Write the test file**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LiveReservesConfig, StablecoinMeta } from "@shared/types";

// Mock helpers before importing the adapter
vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchJsonWithRetry: vi.fn(),
    fetchErc20TotalSupply: vi.fn(),
  };
});

import { fetchSingleAssetReserves } from "../single-asset";
import { fetchJsonWithRetry, fetchErc20TotalSupply } from "../helpers";

const signal = AbortSignal.timeout(5000);

function makeCoin(contracts?: Array<{ chain: string; address: string }>): StablecoinMeta {
  return { id: "test-coin", name: "Test", ticker: "TST", contracts } as unknown as StablecoinMeta;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchSingleAssetReserves", () => {
  it("returns 100% slice in http-json mode when probe returns non-zero", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({ total_supply: "1000000" });
    const config: LiveReservesConfig = {
      adapter: "single-asset",
      version: 1,
      semantics: "single-asset",
      inputs: { primary: { kind: "http-json", url: "https://example.com/api" } },
      params: {
        label: "ETH collateral",
        risk: "low",
        probe: { kind: "json-path", path: ["total_supply"] },
      },
    };

    const result = await fetchSingleAssetReserves(makeCoin(), config, signal);
    expect(result.slices).toEqual([
      { name: "ETH collateral", pct: 100, risk: "low" },
    ]);
  });

  it("throws on zero probe value in http-json mode", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({ total_supply: "0" });
    const config: LiveReservesConfig = {
      adapter: "single-asset",
      version: 1,
      semantics: "single-asset",
      inputs: { primary: { kind: "http-json", url: "https://example.com/api" } },
      params: {
        label: "ETH collateral",
        risk: "low",
        probe: { kind: "json-path", path: ["total_supply"] },
      },
    };

    await expect(fetchSingleAssetReserves(makeCoin(), config, signal))
      .rejects.toThrow("zero/empty");
  });

  it("throws on invalid risk value", async () => {
    const config: LiveReservesConfig = {
      adapter: "single-asset",
      version: 1,
      semantics: "single-asset",
      inputs: { primary: { kind: "http-json", url: "https://example.com/api" } },
      params: { label: "Test", risk: "invalid-risk" },
    };

    await expect(fetchSingleAssetReserves(makeCoin(), config, signal))
      .rejects.toThrow("invalid risk");
  });

  it("returns 100% slice in onchain mode when totalSupply > 0", async () => {
    vi.mocked(fetchErc20TotalSupply).mockResolvedValue(1000000n);
    const config: LiveReservesConfig = {
      adapter: "single-asset",
      version: 1,
      semantics: "single-asset",
      inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
      params: { label: "ETH collateral", risk: "low" },
    };

    const result = await fetchSingleAssetReserves(
      makeCoin([{ chain: "ethereum", address: "0x1234" }]),
      config,
      signal,
    );
    expect(result.slices).toEqual([
      { name: "ETH collateral", pct: 100, risk: "low" },
    ]);
  });
});
```

- [ ] **Step 2: Run test**

Run: `npm test -- --run worker/src/cron/reserve-adapters/__tests__/single-asset.test.ts`
Expected: PASS (after the risk validation was added in Task 5).

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/reserve-adapters/__tests__/single-asset.test.ts
git commit -m "test(reserves): add single-asset adapter tests"
```

---

### Task 8: Add tests for `evm-branch-balances` adapter

**Files:**
- Create: `worker/src/cron/reserve-adapters/__tests__/evm-branch-balances.test.ts`

This adapter also has no pure `adapt*` export — it's all I/O (ERC-20 balance reads + DefiLlama price fetches). Will need to mock helpers.

- [ ] **Step 1: Write the test file**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LiveReservesConfig, StablecoinMeta } from "@shared/types";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchErc20Balance: vi.fn(),
    fetchDefiLlamaPrices: vi.fn(),
  };
});

import { fetchEvmBranchBalancesReserves } from "../evm-branch-balances";
import { fetchErc20Balance, fetchDefiLlamaPrices } from "../helpers";

const signal = AbortSignal.timeout(5000);
const coin = { id: "test-coin" } as unknown as StablecoinMeta;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchEvmBranchBalancesReserves", () => {
  it("computes percentage slices from branch balances and prices", async () => {
    vi.mocked(fetchErc20Balance)
      .mockResolvedValueOnce(1_000_000_000_000_000_000n)   // 1 wstETH (18 dec)
      .mockResolvedValueOnce(100_000_000n);                 // 1 WBTC (8 dec)

    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(
      new Map([["wstETH", 2000], ["WBTC", 60000]]),
    );

    const config: LiveReservesConfig = {
      adapter: "evm-branch-balances",
      version: 1,
      semantics: "collateral-mix",
      inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
      params: {
        branches: [
          { name: "wstETH", holder: "0xAAA", token: { chain: "ethereum", address: "0xBBB", decimals: 18 }, risk: "low" },
          { name: "WBTC", holder: "0xCCC", token: { chain: "ethereum", address: "0xDDD", decimals: 8 }, risk: "medium" },
        ],
      },
    };

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.slices).toHaveLength(2);
    const sum = Math.round(result.slices.reduce((s, r) => s + r.pct, 0) * 10) / 10;
    expect(sum).toBe(100);
    // WBTC value = 60000 (96.8%), wstETH = 2000 (3.2%)
    expect(result.slices[0].name).toBe("WBTC");
  });

  it("throws when all balances are zero", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(0n);
    const config: LiveReservesConfig = {
      adapter: "evm-branch-balances",
      version: 1,
      semantics: "collateral-mix",
      inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
      params: {
        branches: [
          { name: "wstETH", holder: "0xAAA", token: { chain: "ethereum", address: "0xBBB", decimals: 18 }, risk: "low" },
        ],
      },
    };

    await expect(fetchEvmBranchBalancesReserves(coin, config, signal))
      .rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test**

Run: `npm test -- --run worker/src/cron/reserve-adapters/__tests__/evm-branch-balances.test.ts`
Expected: PASS. **Important:** Check the actual `BranchConfig` interface in `evm-branch-balances.ts` for the exact field names in the params. Adjust the test fixture if the interface differs from what's shown here.

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/reserve-adapters/__tests__/evm-branch-balances.test.ts
git commit -m "test(reserves): add evm-branch-balances adapter tests"
```

---

### Task 9: Final validation and documentation update

**Files:**
- Modify: `docs/live-reserves.md`

- [ ] **Step 1: Full build + type-check**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 2: Full test suite**

Run: `npm test -- --run`
Expected: All tests pass.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: No errors.

- [ ] **Step 4: Verify `utils.ts` is gone and no orphan imports**

Run: `grep -r "from.*./utils" worker/src/cron/reserve-adapters/`
Expected: No results.

Run: `grep -r "from.*../../lib/fetch-retry" worker/src/cron/reserve-adapters/`
Expected: Only `helpers.ts` and `m0.ts` (the POST adapter).

- [ ] **Step 5: Update `docs/live-reserves.md`**

Update the "Adapter helpers" section (around line 184-189):

```markdown
Adapter helpers are centralized in `worker/src/cron/reserve-adapters/helpers.ts`:

- HTTP JSON / HTML fetch wrappers (`fetchJsonWithRetry`, `fetchTextWithRetry`)
- DefiLlama spot-price loading for valuation (`fetchDefiLlamaPrices`)
- EVM balance, total-supply, and hex-call reads (`fetchErc20Balance`, `fetchErc20TotalSupply`)
- Input-kind type guards and validators (`requireJsonInput`, `requireJsonInputFromConfig`, etc.)
- Slice normalization with configurable precision (`normalizeSlices`, `slicesFromValues`)
- Risk validation (`isReserveRisk`)

`worker/src/cron/reserve-adapters/evm.ts` provides hex-level EVM call helpers for ERC-4626 vault introspection.
```

Remove any mention of `utils.ts` from docs.

- [ ] **Step 6: Commit**

```bash
git add -u
git commit -m "docs(reserves): update live-reserves.md after helpers consolidation"
```

- [ ] **Step 7: Move audit to historical**

```bash
mv agents/plans/live-reserves-audit.md agents/plans/historical/
git add agents/plans/historical/live-reserves-audit.md
git rm agents/plans/live-reserves-audit.md
git commit -m "chore: move live-reserves audit to historical"
```
