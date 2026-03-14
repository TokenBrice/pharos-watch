# Live Reserve Sync Audit Remediation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 10 issues (H1, M1-M4, L1-L5) identified in the live reserve sync audit report (`agents/research/2026-03-14-live-reserves-audit.md`).

**Architecture:** Changes span the cron orchestrator, D1 persistence layer, shared types, public API, status dashboard UI, adapter implementations, and documentation. All changes are additive/refinement -- no schema migrations required.

**Tech Stack:** TypeScript strict, Cloudflare Workers + D1, Vitest, React 19 (status UI)

**Task Dependencies:** Most tasks are independent, but note:
- **M2 before M3** -- M3's `fetchMentoReserves` uses `getAdapterTimeout` from M2
- **M3 before L4** -- both modify `mento.ts`; M3 changes the return type that L4 builds on

---

## File Structure

### Modified files

| File | Tasks | Changes |
|------|-------|---------|
| `worker/src/cron/sync-live-reserves.ts` | H1 | Deduplicate circuit breaker recordings per breakerKey per cron run |
| `shared/types/core.ts` | M1 | Add `lastError?: string` to `ReserveSyncStateView` |
| `worker/src/lib/live-reserves-store.ts` | M1, L2, L3 | Surface `lastError` in `resolveReserveResult`; validate slice elements in `parseSlices`; add `errorCoins` to overview |
| `shared/types/status.ts` | L3 | Add `errorCoins` to `StatusResponse["reserveComposition"]` |
| `worker/src/api/status-derived-data.ts` | L3 | Add `errorCoins: 0` to `emptyReserveComposition()` |
| `worker/src/api/status.ts` | L3 | Include `errorCoins` in status warning message |
| `src/components/status/reserve-sync-health.tsx` | L3 | Add Error column to health card grid |
| `worker/src/cron/reserve-adapters/helpers.ts` | M2 | Add `getAdapterTimeout` helper |
| `worker/src/cron/reserve-adapters/mento.ts` | M2, M3, L4 | Use configurable timeout; add structural integrity check; emit warning for unknown symbols |
| `worker/src/cron/reserve-adapters/ethena.ts` | M2 | Use configurable timeout |
| `worker/src/cron/reserve-adapters/accountable.ts` | M2 | Use configurable timeout |
| `worker/src/cron/reserve-adapters/openeden.ts` | M2 | Use configurable timeout |
| `worker/src/cron/reserve-adapters/falcon.ts` | M2, L4 | Use configurable timeout; emit warning for unmapped assets |
| `worker/src/cron/reserve-adapters/m0.ts` | M2 | Use configurable timeout |
| `worker/src/cron/reserve-adapters/collateral-positions-api.ts` | L4 | Emit warning for unmapped symbols |
| `docs/live-reserves.md` | L1, M4 | Document edge cache behavior; document fallback inputs as unimplemented |
| `worker/migrations/0064_reserve_composition.sql` | L5 | Fix comment from "daily" to "hourly" |

### Modified test files

| File | Tasks |
|------|-------|
| `worker/src/cron/__tests__/sync-live-reserves.test.ts` | H1 |
| `worker/src/lib/__tests__/live-reserves-store.test.ts` | M1, L2, L3 |
| `worker/src/api/__tests__/stablecoin-reserves.test.ts` | M1 |
| `worker/src/cron/reserve-adapters/__tests__/mento.test.ts` | M3, L4 |
| `worker/src/cron/reserve-adapters/__tests__/falcon.test.ts` | L4 |
| `worker/src/cron/reserve-adapters/__tests__/collateral-positions-api.test.ts` | L4 |

---

## Chunk 1: H1 -- Circuit Breaker Amplification Fix

### Task 1: Deduplicate circuit breaker recordings per breakerKey per cron run

**Files:**
- Modify: `worker/src/cron/sync-live-reserves.ts:70-203`
- Test: `worker/src/cron/__tests__/sync-live-reserves.test.ts`

**Context:** When multiple coins share a `breakerScope` (e.g., M0 has 3 coins all sharing `"m0"`), a single transient failure records N failures against the same breaker key in one cron run. With `CIRCUIT_OPEN_THRESHOLD = 3`, this opens the circuit immediately on a single failure.

**Why simple dedup is correct:** Coins sharing a `breakerScope` also share a `sharedSourceCacheKey` (same adapter+version+semantics+inputs+params), so they share the same adapter Promise. A resolved Promise produces the same result for all sharing coins; a rejected Promise throws the same error for all. Per-coin validation paths (empty slices, unknown adapter) produce identical outcomes for shared-source coins because they receive the same data. Therefore, recording the first outcome per breakerKey and skipping duplicates is semantically correct.

- [ ] **Step 1: Write the failing test for breaker deduplication**

Add a new test to `worker/src/cron/__tests__/sync-live-reserves.test.ts`:

```typescript
it("records circuit breaker outcome only once per unique breakerKey per run", async () => {
  getReserveAdapterMock.mockReturnValue(
    async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }),
  );

  const { syncLiveReserves } = await import("../sync-live-reserves");
  const db = mockD1();
  await syncLiveReserves(db, new AbortController().signal, {});

  // Count recordOutcomeSafe calls per breakerKey
  const callsByKey = new Map<string, number>();
  for (const call of recordOutcomeSafeMock.mock.calls) {
    const key = call[1] as string;
    callsByKey.set(key, (callsByKey.get(key) ?? 0) + 1);
  }

  // Each unique breakerKey should appear at most once
  for (const [key, count] of callsByKey) {
    expect(count, `breakerKey "${key}" recorded ${count} times, expected 1`).toBe(1);
  }

  // Total calls should equal unique breakerKey count, not configuredCoinCount
  const uniqueBreakerKeys = new Set(
    TRACKED_STABLECOINS
      .filter((c) => c.liveReservesConfig)
      .map((c) => `live-reserves:${c.liveReservesConfig!.breakerScope ?? c.liveReservesConfig!.adapter}`),
  );
  expect(recordOutcomeSafeMock).toHaveBeenCalledTimes(uniqueBreakerKeys.size);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd worker && npx vitest run src/cron/__tests__/sync-live-reserves.test.ts --reporter=verbose`
Expected: FAIL -- `recordOutcomeSafe` is currently called `configuredCoinCount` times, not `uniqueBreakerKeys.size`.

- [ ] **Step 3: Implement breaker deduplication and update existing test assertion**

In `worker/src/cron/sync-live-reserves.ts`, add a `Set<string>` to track which breakerKeys have been recorded:

```typescript
// Add at line 78 (after sharedSourceResults declaration):
const recordedBreakerOutcomes = new Set<string>();
```

Replace each `recordOutcomeSafe` call (lines 136, 156, 186, 202) with the guarded version. There are 4 call sites:

Line 136 (unknown adapter failure):
```typescript
if (!recordedBreakerOutcomes.has(breakerKey)) {
  await recordOutcomeSafe(db, breakerKey, false);
  recordedBreakerOutcomes.add(breakerKey);
}
```

Line 156 (empty slices failure):
```typescript
if (!recordedBreakerOutcomes.has(breakerKey)) {
  await recordOutcomeSafe(db, breakerKey, false);
  recordedBreakerOutcomes.add(breakerKey);
}
```

Line 186 (success):
```typescript
if (!recordedBreakerOutcomes.has(breakerKey)) {
  await recordOutcomeSafe(db, breakerKey, true);
  recordedBreakerOutcomes.add(breakerKey);
}
```

Line 202 (catch/exception failure):
```typescript
if (!recordedBreakerOutcomes.has(breakerKey)) {
  await recordOutcomeSafe(db, breakerKey, false);
  recordedBreakerOutcomes.add(breakerKey);
}
```

**Also update the existing clean-run test assertion** in the same file at line 64. Change:
```typescript
expect(recordOutcomeSafeMock).toHaveBeenCalledTimes(configuredCoinCount);
```
to:
```typescript
const uniqueBreakerKeyCount = new Set(
  TRACKED_STABLECOINS
    .filter((c) => c.liveReservesConfig)
    .map((c) => `live-reserves:${c.liveReservesConfig!.breakerScope ?? c.liveReservesConfig!.adapter}`),
).size;
expect(recordOutcomeSafeMock).toHaveBeenCalledTimes(uniqueBreakerKeyCount);
```

- [ ] **Step 4: Run the full test file to verify all tests pass**

Run: `cd worker && npx vitest run src/cron/__tests__/sync-live-reserves.test.ts --reporter=verbose`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/sync-live-reserves.ts worker/src/cron/__tests__/sync-live-reserves.test.ts
git commit -m "fix(H1): deduplicate circuit breaker recordings per breakerKey per cron run

A single transient failure for shared-scope adapters (e.g., M0 with 3 coins)
was recording 3 consecutive failures in one cron run, immediately opening the
circuit. Now each unique breakerKey is recorded at most once per run."
```

---

## Chunk 2: M1 -- Expose lastError in Public API

### Task 2: Add `lastError` to the shared type and surface it in the API response

**Files:**
- Modify: `shared/types/core.ts:172-180`
- Modify: `worker/src/lib/live-reserves-store.ts:379-422`
- Test: `worker/src/lib/__tests__/live-reserves-store.test.ts`
- Test: `worker/src/api/__tests__/stablecoin-reserves.test.ts`

**Context:** The `ReserveSyncStateView` type exposes sync metadata to the public API but omits `lastError`. The D1 `reserve_sync_state` table stores `last_error`, and the store reads it, but `resolveReserveResult()` never includes it in the sync view. This makes it impossible for operators to diagnose adapter failures without auth-gated `/status` access or direct D1 queries.

- [ ] **Step 1: Write the failing test for lastError in resolveReserveResult**

Add to `worker/src/lib/__tests__/live-reserves-store.test.ts`:

```typescript
it("includes lastError in sync view when sync state has an error", async () => {
  const db = mockD1([
    {
      match: "reserve_composition",
      rows: [],
      first: null,
    },
    {
      match: "reserve_sync_state",
      rows: [],
      first: {
        stablecoin_id: "iusd-infinifi",
        adapter_key: "infinifi",
        breaker_key: "live-reserves:infinifi",
        last_attempted_at: 1_000,
        last_success_at: null,
        last_status: "error",
        warning_count: 0,
        warnings: null,
        last_error: "HTTP 503 for https://api.example.com",
        metadata: "{}",
      },
    },
  ]);

  const result = await resolveReserveResult(db, "iusd-infinifi", 1_200);

  expect(result?.sync?.lastError).toBe("HTTP 503 for https://api.example.com");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd worker && npx vitest run src/lib/__tests__/live-reserves-store.test.ts --reporter=verbose`
Expected: FAIL -- `lastError` property does not exist on `ReserveSyncStateView`.

- [ ] **Step 3: Add `lastError` to `ReserveSyncStateView`**

In `shared/types/core.ts`, add `lastError` to the `ReserveSyncStateView` interface (after line 179):

```typescript
export interface ReserveSyncStateView {
  enabled: boolean;
  status: "ok" | "degraded" | "error" | "skipped";
  stale: boolean;
  bootstrap: boolean;
  lastAttemptedAt?: number;
  lastSuccessAt?: number;
  warnings?: string[];
  lastError?: string;
}
```

- [ ] **Step 4: Surface `lastError` in `resolveReserveResult()`**

In `worker/src/lib/live-reserves-store.ts`, add `lastError` to each of the three sync object constructions inside `resolveReserveResult()`. Add this line to each sync object (at lines 387, 404, and 422):

```typescript
...(syncState?.lastError ? { lastError: syncState.lastError.slice(0, 200) } : {}),
```

This truncates to 200 chars to prevent leaking verbose stack traces in the public API.

- [ ] **Step 5: Run the store test to verify it passes**

Run: `cd worker && npx vitest run src/lib/__tests__/live-reserves-store.test.ts --reporter=verbose`
Expected: All tests PASS.

- [ ] **Step 6: Write API-level test for lastError surfacing**

Add to `worker/src/api/__tests__/stablecoin-reserves.test.ts`:

```typescript
it("surfaces lastError from sync state in the API response", async () => {
  const now = Math.floor(Date.now() / 1000);
  const db = mockD1([
    {
      match: "reserve_composition",
      rows: [],
      first: null,
    },
    {
      match: "reserve_sync_state",
      rows: [],
      first: {
        stablecoin_id: "iusd-infinifi",
        adapter_key: "infinifi",
        breaker_key: "live-reserves:infinifi",
        last_attempted_at: now,
        last_success_at: null,
        last_status: "error",
        warning_count: 0,
        warnings: null,
        last_error: "HTTP 503 for https://api.example.com",
        metadata: "{}",
      },
    },
  ]);
  const res = await handleStablecoinReserves(db, "iusd-infinifi");
  expect(res.status).toBe(200);
  const body = await res.json() as { sync?: { lastError?: string } };
  expect(body.sync?.lastError).toBe("HTTP 503 for https://api.example.com");
});
```

- [ ] **Step 7: Run API test to verify it passes**

Run: `cd worker && npx vitest run src/api/__tests__/stablecoin-reserves.test.ts --reporter=verbose`
Expected: All tests PASS.

- [ ] **Step 8: Update `docs/live-reserves.md` sync object table**

In `docs/live-reserves.md`, add `lastError` to the sync field table (after line 157):

```markdown
| `lastError` | Most recent adapter error message (truncated to 200 chars), when present |
```

- [ ] **Step 9: Commit**

```bash
git add shared/types/core.ts worker/src/lib/live-reserves-store.ts \
  worker/src/lib/__tests__/live-reserves-store.test.ts \
  worker/src/api/__tests__/stablecoin-reserves.test.ts \
  docs/live-reserves.md
git commit -m "feat(M1): expose lastError in public reserve sync API response

Adds lastError to ReserveSyncStateView so operators can diagnose adapter
failures without needing /status auth or direct D1 queries. Truncated to
200 chars to prevent leaking verbose stack traces."
```

---

## Chunk 3: M2 -- Configurable Per-Adapter Timeout

### Task 3: Add `getAdapterTimeout` helper and use it in adapters

**Files:**
- Modify: `worker/src/cron/reserve-adapters/helpers.ts`
- Modify: `worker/src/cron/reserve-adapters/mento.ts`
- Modify: `worker/src/cron/reserve-adapters/ethena.ts`
- Modify: `worker/src/cron/reserve-adapters/accountable.ts`
- Modify: `worker/src/cron/reserve-adapters/openeden.ts`
- Modify: `worker/src/cron/reserve-adapters/falcon.ts`
- Modify: `worker/src/cron/reserve-adapters/m0.ts`

**Context:** All adapters use `fetchJsonWithRetry`/`fetchTextWithRetry`/`fetchWithRetry` with either the default 10s or a hardcoded 12s timeout. The fix: add a `getAdapterTimeout()` helper that reads from `LiveReservesConfig.params.timeoutMs`, falling back to a per-adapter-type default.

- [ ] **Step 1: Write a basic test for `getAdapterTimeout`**

Add to an existing helpers test file (or create a minimal inline test in the adapter test directory):

```typescript
// In worker/src/cron/reserve-adapters/__tests__/helpers.test.ts (add to existing or create)
import { getAdapterTimeout } from "../helpers";
import type { LiveReservesConfig } from "@shared/types";

describe("getAdapterTimeout", () => {
  const baseConfig = {
    adapter: "test",
    version: 1,
    semantics: "single-asset" as const,
    inputs: { primary: { kind: "http-json" as const, url: "https://example.com" } },
  } satisfies LiveReservesConfig;

  it("returns params.timeoutMs when set", () => {
    expect(getAdapterTimeout({ ...baseConfig, params: { timeoutMs: 15_000 } })).toBe(15_000);
  });

  it("returns fallback when params.timeoutMs is not set", () => {
    expect(getAdapterTimeout(baseConfig, 12_000)).toBe(12_000);
  });

  it("returns default 10s when no fallback specified", () => {
    expect(getAdapterTimeout(baseConfig)).toBe(10_000);
  });

  it("ignores non-positive or oversized timeoutMs", () => {
    expect(getAdapterTimeout({ ...baseConfig, params: { timeoutMs: -1 } })).toBe(10_000);
    expect(getAdapterTimeout({ ...baseConfig, params: { timeoutMs: 60_000 } })).toBe(10_000);
    expect(getAdapterTimeout({ ...baseConfig, params: { timeoutMs: 0 } })).toBe(10_000);
  });

  it("ignores non-numeric timeoutMs", () => {
    expect(getAdapterTimeout({ ...baseConfig, params: { timeoutMs: "fast" } })).toBe(10_000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd worker && npx vitest run src/cron/reserve-adapters/__tests__/helpers.test.ts --reporter=verbose`
Expected: FAIL -- `getAdapterTimeout` is not exported.

- [ ] **Step 3: Add `getAdapterTimeout` helper to `helpers.ts`**

Add after the existing `requireHtmlInput` function in `worker/src/cron/reserve-adapters/helpers.ts`:

```typescript
const DEFAULT_ADAPTER_TIMEOUT_MS = 10_000;
const MAX_ADAPTER_TIMEOUT_MS = 30_000;

/** Reads timeout from config.params.timeoutMs, falling back to the adapter's default or 10s. */
export function getAdapterTimeout(config: LiveReservesConfig, fallbackMs = DEFAULT_ADAPTER_TIMEOUT_MS): number {
  const paramTimeout = (config.params as Record<string, unknown> | undefined)?.timeoutMs;
  if (typeof paramTimeout === "number" && paramTimeout > 0 && paramTimeout <= MAX_ADAPTER_TIMEOUT_MS) {
    return paramTimeout;
  }
  return fallbackMs;
}
```

Add `LiveReservesConfig` to the imports from `@shared/types` if not already imported.

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `cd worker && npx vitest run src/cron/reserve-adapters/__tests__/helpers.test.ts --reporter=verbose`
Expected: All tests PASS.

- [ ] **Step 5: Update adapters that hardcode timeouts**

Update each adapter that currently hardcodes a timeout. Each adapter file needs to add `getAdapterTimeout` to its imports from `./helpers`.

**`mento.ts:87`:**
```typescript
const html = await fetchTextWithRetry(input.url, signal, getAdapterTimeout(config, 12_000));
```

**`ethena.ts`:** (find the `fetchJsonWithRetry` call with `12_000`)
```typescript
const payload = await fetchJsonWithRetry<EthenaCollateralResponse>(primaryInput.url, signal, getAdapterTimeout(config, 12_000));
```

**`accountable.ts`:** (find the `fetchJsonWithRetry` call with `12_000`)
```typescript
const payload = await fetchJsonWithRetry<AccountableDashboardResponse>(primaryInput.url, signal, getAdapterTimeout(config, 12_000));
```

**`openeden.ts`:** (find the `fetchJsonWithRetry` call with `12_000`)
```typescript
const payload = await fetchJsonWithRetry<OpenEdenReserveCompositionResponse>(primaryInput.url, signal, getAdapterTimeout(config, 12_000));
```

**`falcon.ts:137`:**
```typescript
const payload = await fetchJsonWithRetry<FalconTransparencyResponse>(primaryInput.url, signal, getAdapterTimeout(config, 12_000));
```

**`m0.ts:108`:** (uses `fetchWithRetry` directly, not `fetchJsonWithRetry`)
```typescript
// Before:
{ timeoutMs: 12_000 },
// After:
{ timeoutMs: getAdapterTimeout(config, 12_000) },
```
Add `getAdapterTimeout` to imports from `./helpers` and ensure `config` is in scope (the `fetchM0Reserves` function receives `config` as its second parameter).

- [ ] **Step 6: Run all adapter tests to verify nothing breaks**

Run: `cd worker && npx vitest run src/cron/reserve-adapters/__tests__/ --reporter=verbose`
Expected: All adapter tests PASS.

- [ ] **Step 7: Commit**

```bash
git add worker/src/cron/reserve-adapters/helpers.ts \
  worker/src/cron/reserve-adapters/__tests__/helpers.test.ts \
  worker/src/cron/reserve-adapters/mento.ts \
  worker/src/cron/reserve-adapters/ethena.ts \
  worker/src/cron/reserve-adapters/accountable.ts \
  worker/src/cron/reserve-adapters/openeden.ts \
  worker/src/cron/reserve-adapters/falcon.ts \
  worker/src/cron/reserve-adapters/m0.ts
git commit -m "feat(M2): add configurable per-adapter timeout via params.timeoutMs

Adapters now read timeout from config.params.timeoutMs (capped at 30s),
falling back to their previous hardcoded default. Makes timeout tuning
an operator config change instead of a code change."
```

---

## Chunk 4: M3 + L4 (Mento) -- Mento Structural Integrity + Unknown Asset Warnings

### Task 4: Add structural integrity validation and unknown-asset warnings to Mento adapter

**Files:**
- Modify: `worker/src/cron/reserve-adapters/mento.ts:64-91`
- Test: `worker/src/cron/reserve-adapters/__tests__/mento.test.ts`

**Context:** The Mento adapter parses reserve composition from server-rendered HTML using string markers. It has no structural integrity check and silently absorbs unknown symbols with a default risk of `"medium"`. The fix: (1) add integrity warnings when parsed data looks suspicious, (2) emit `"unknown-asset"` warnings for unmapped symbols.

**Important:** This task changes `adaptMentoReserveComposition` to return `AdapterResult` instead of `ReserveSlice[]`. The existing test at `mento.test.ts:27-39` must be updated to use `result.slices`.

- [ ] **Step 1: Write failing tests for structural integrity and unknown-asset warnings**

Add to `worker/src/cron/reserve-adapters/__tests__/mento.test.ts`:

```typescript
it("emits a structural integrity warning when fewer than 3 reserve entries are parsed", () => {
  // Build minimal HTML with only 2 entries using the same escaped-JSON format as SAMPLE_HTML
  const twoEntryHtml = `<html><body><script>self.__next_f.push([1,"...\\"reserveComposition\\":[{\\"symbol\\":\\"USDC\\",\\"percent\\":80},{\\"symbol\\":\\"ETH\\",\\"percent\\":20}],\\"reserveHoldings\\":{}..."]);
</script></body></html>`;
  const result = adaptMentoReserveComposition(twoEntryHtml);
  expect(result.warnings).toBeDefined();
  expect(result.warnings!.some((w) => w.code === "mento-low-entry-count")).toBe(true);
});

it("emits a structural integrity warning when total percentages are below 50%", () => {
  const lowPctHtml = `<html><body><script>self.__next_f.push([1,"...\\"reserveComposition\\":[{\\"symbol\\":\\"USDC\\",\\"percent\\":10},{\\"symbol\\":\\"ETH\\",\\"percent\\":5},{\\"symbol\\":\\"CELO\\",\\"percent\\":3}],\\"reserveHoldings\\":{}..."]);
</script></body></html>`;
  const result = adaptMentoReserveComposition(lowPctHtml);
  expect(result.warnings).toBeDefined();
  expect(result.warnings!.some((w) => w.code === "mento-low-total-pct")).toBe(true);
});

it("emits an unknown-asset warning for symbols not in TOKEN_CONFIG", () => {
  const unknownTokenHtml = `<html><body><script>self.__next_f.push([1,"...\\"reserveComposition\\":[{\\"symbol\\":\\"USDC\\",\\"percent\\":50},{\\"symbol\\":\\"ETH\\",\\"percent\\":30},{\\"symbol\\":\\"NEW_TOKEN\\",\\"percent\\":10},{\\"symbol\\":\\"CELO\\",\\"percent\\":10}],\\"reserveHoldings\\":{}..."]);
</script></body></html>`;
  const result = adaptMentoReserveComposition(unknownTokenHtml);
  expect(result.warnings).toBeDefined();
  expect(result.warnings!.some((w) => w.code === "unknown-asset" && w.message.includes("NEW_TOKEN"))).toBe(true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd worker && npx vitest run src/cron/reserve-adapters/__tests__/mento.test.ts --reporter=verbose`
Expected: FAIL -- `adaptMentoReserveComposition` returns `ReserveSlice[]`, not `AdapterResult`.

- [ ] **Step 3: Refactor `adaptMentoReserveComposition` to return `AdapterResult` with warnings**

In `worker/src/cron/reserve-adapters/mento.ts`:

1. Add `LiveReserveWarning` to the imports from `@shared/types`.
2. Add `type AdapterResult` to the imports from `./index`.
3. Replace the function (lines 64-78):

```typescript
export function adaptMentoReserveComposition(html: string): AdapterResult {
  const entries = parseMentoReserveComposition(html);
  const warnings: LiveReserveWarning[] = [];

  if (entries.length < 3) {
    warnings.push({
      code: "mento-low-entry-count",
      message: `Mento reserve composition has only ${entries.length} entries (expected >= 3)`,
      severity: "warning",
    });
  }

  const totalPct = entries.reduce((sum, e) => sum + e.percent, 0);
  if (totalPct < 50) {
    warnings.push({
      code: "mento-low-total-pct",
      message: `Mento reserve composition total is ${totalPct.toFixed(1)}% (expected >= 50%)`,
      severity: "warning",
    });
  }

  const slices = slicesFromValues(
    entries.map((entry) => {
      const config = TOKEN_CONFIG[entry.symbol];
      if (!config) {
        warnings.push({
          code: "unknown-asset",
          message: `Unmapped Mento reserve symbol: ${entry.symbol}`,
          severity: "warning",
        });
      }
      const resolved = config ?? { name: entry.symbol, risk: "medium" as const };
      return {
        name: resolved.name,
        value: entry.percent,
        risk: resolved.risk,
        ...(resolved.coinId ? { coinId: resolved.coinId } : {}),
      };
    }),
    1,
  );

  return { slices, ...(warnings.length > 0 ? { warnings } : {}) };
}
```

4. Update `fetchMentoReserves` (lines 80-91) to pass through the result directly:

```typescript
export async function fetchMentoReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  _ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireHtmlInput(config.inputs.primary, "mento");
  const html = await fetchTextWithRetry(input.url, signal, getAdapterTimeout(config, 12_000));
  return adaptMentoReserveComposition(html);
}
```

- [ ] **Step 4: Update the existing test for the return type change**

In `worker/src/cron/reserve-adapters/__tests__/mento.test.ts`, update the test at line 27-39:

```typescript
it("maps parsed reserve composition into Pharos reserve slices", () => {
  const result = adaptMentoReserveComposition(SAMPLE_HTML);
  expect(result.slices).toEqual([
    { name: "sUSDS (Sky savings USDS)", pct: 54.8, risk: "low", coinId: "usds-sky" },
    { name: "EURC (Circle euro stablecoin)", pct: 19.9, risk: "low" },
    { name: "CELO", pct: 13.5, risk: "high" },
    { name: "USDGLO (Glo Dollar)", pct: 5, risk: "low" },
    { name: "stETH (Lido staked ETH)", pct: 2.6, risk: "low" },
    { name: "USDT", pct: 2.1, risk: "low", coinId: "usdt-tether" },
    { name: "USDC", pct: 1.2, risk: "low", coinId: "usdc-circle" },
    { name: "ETH", pct: 0.9, risk: "very-low" },
  ]);
  // SAMPLE_HTML has all known tokens, so no warnings should be emitted
  expect(result.warnings).toBeUndefined();
});
```

- [ ] **Step 5: Run all mento tests to verify they pass**

Run: `cd worker && npx vitest run src/cron/reserve-adapters/__tests__/mento.test.ts --reporter=verbose`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/reserve-adapters/mento.ts \
  worker/src/cron/reserve-adapters/__tests__/mento.test.ts
git commit -m "feat(M3,L4): add structural integrity and unknown-asset warnings to Mento adapter

Emits warnings when parsed reserve composition has fewer than 3 entries,
total percentages below 50%, or unknown token symbols. Changes
adaptMentoReserveComposition to return AdapterResult instead of ReserveSlice[]."
```

---

## Chunk 5: M4 + L1 -- Documentation Fixes

### Task 5: Document fallback inputs limitation and edge cache behavior

**Files:**
- Modify: `docs/live-reserves.md`

**Context:** Two documentation gaps: (1) `inputs.fallbacks` is a dead code path; (2) edge caching masks sync status for operators.

- [ ] **Step 1: Add fallback inputs limitation note**

In `docs/live-reserves.md`, after the `inputs.fallbacks` row in the Metadata Contract table (after line 34), add a subsection:

```markdown
### Known Limitation: Fallback Inputs

`inputs.fallbacks` is declared in `LiveReservesConfig` but **not currently implemented**:

- No adapter reads or uses fallback inputs
- No coin configuration declares fallback inputs
- The cron orchestrator does not attempt fallback resolution on primary failure

When the primary source fails, the adapter throws and the circuit breaker handles recovery. Implementing fallback resolution would provide meaningful resilience for adapters with fragile primary sources (e.g., HTML-scraped sources like Mento).

**Future implementation path:** Add fallback resolution to `runAdapter()` in `sync-live-reserves.ts` -- try primary input first, and on failure, iterate through `config.inputs.fallbacks` with the same adapter function.
```

- [ ] **Step 2: Add edge cache section**

In `docs/live-reserves.md`, add a new subsection after the existing Cache control table (after line 145):

```markdown
### Edge Cache Implications for Monitoring

When a coin has `mode="live"`, the response is edge-cached for 1 hour (`s-maxage=3600`). If the adapter starts failing *after* a successful response was cached:

- The public API will continue serving the **cached successful response** for up to 1 hour
- The `sync` object in the cached response will show the **previous** sync state, not the current failure
- Operators querying the public API will not see the error status until the edge cache expires

**For real-time monitoring**, use the auth-gated `/status` endpoint, which is never edge-cached and always reflects current D1 state.

Fallback/degraded responses use a shorter edge cache (`s-maxage=300`, 5 minutes), so status transitions from fallback modes propagate faster.
```

- [ ] **Step 3: Commit**

```bash
git add docs/live-reserves.md
git commit -m "docs(M4,L1): document fallback inputs limitation and edge cache monitoring implications

Documents that inputs.fallbacks is declared but unimplemented, and that
edge caching on live-mode responses delays public API status propagation
by up to 1 hour."
```

---

## Chunk 6: L2 -- Validate Slice Structure in parseSlices

### Task 6: Add element-level validation to `parseSlices`

**Files:**
- Modify: `worker/src/lib/live-reserves-store.ts:90-97`
- Test: `worker/src/lib/__tests__/live-reserves-store.test.ts`

**Context:** `parseSlices` does `JSON.parse` + `Array.isArray` check, then casts with `as ReserveSlice[]`. It doesn't validate individual elements. If corrupt data enters D1, malformed slices could reach the frontend.

- [ ] **Step 1: Write the failing test for corrupt slice filtering**

Add to `worker/src/lib/__tests__/live-reserves-store.test.ts`:

```typescript
it("filters out malformed slices from D1 data during resolution", async () => {
  const now = Math.floor(Date.now() / 1000);
  const corruptSlices = [
    { name: "Valid Farm", pct: 60, risk: "low" },
    { name: "Missing Risk", pct: 20 },
    { pct: 10, risk: "medium" },
    { name: "Bad Pct", pct: "fifty", risk: "low" },
    { name: "Valid Too", pct: 10, risk: "high" },
  ];

  const db = mockD1([
    {
      match: "reserve_composition",
      rows: [],
      first: {
        stablecoin_id: "iusd-infinifi",
        slices: JSON.stringify(corruptSlices),
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
  // Only the 2 valid slices should survive
  expect(result?.reserves).toHaveLength(2);
  expect(result?.reserves[0].name).toBe("Valid Farm");
  expect(result?.reserves[1].name).toBe("Valid Too");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd worker && npx vitest run src/lib/__tests__/live-reserves-store.test.ts --reporter=verbose`
Expected: FAIL -- currently all 5 entries pass through unfiltered.

- [ ] **Step 3: Add element validation to `parseSlices`**

In `worker/src/lib/live-reserves-store.ts`, replace `parseSlices` (lines 90-97):

```typescript
function isValidSlice(item: unknown): item is ReserveSlice {
  if (!item || typeof item !== "object") return false;
  const slice = item as Partial<ReserveSlice>;
  return (
    typeof slice.name === "string"
    && typeof slice.pct === "number"
    && typeof slice.risk === "string"
  );
}

function parseSlices(value: string): ReserveSlice[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(isValidSlice) : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd worker && npx vitest run src/lib/__tests__/live-reserves-store.test.ts --reporter=verbose`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/live-reserves-store.ts \
  worker/src/lib/__tests__/live-reserves-store.test.ts
git commit -m "fix(L2): validate individual slice elements in parseSlices

Filters out malformed ReserveSlice entries from D1 data. Prevents corrupt
data (missing name/pct/risk fields) from reaching the frontend."
```

---

## Chunk 7: L3 -- Separate Error vs Degraded Counts in Overview

### Task 7: Add `errorCoins` counter to the reserve composition overview

**Files:**
- Modify: `worker/src/lib/live-reserves-store.ts:50-57,304-337`
- Modify: `shared/types/status.ts:308-316`
- Modify: `worker/src/api/status-derived-data.ts:47-56`
- Modify: `worker/src/api/status.ts:386-393,663`
- Modify: `src/components/status/reserve-sync-health.tsx:22-43`
- Test: `worker/src/lib/__tests__/live-reserves-store.test.ts`

**Context:** `computeReserveCompositionOverview` lumps coins with `last_status = "error"` into the `degradedCoins` count. The `/status` health card can't distinguish warnings from failures.

**Design decision:** The new `errorCoins` check is placed *after* the stale check (line 325-328) in the classification cascade. This means stale coins are always classified as stale regardless of error status -- only *fresh* error-state coins are counted as `errorCoins`. This is the correct behavior: staleness is the more severe concern.

- [ ] **Step 1: Write the failing test for errorCoins in overview**

Add to `worker/src/lib/__tests__/live-reserves-store.test.ts`:

```typescript
it("separates error coins from degraded coins in the overview", async () => {
  const now = 2_000;
  const db = mockD1([
    {
      match: "reserve_sync_state",
      rows: [
        {
          stablecoin_id: "iusd-infinifi",
          adapter_key: "infinifi",
          breaker_key: "live-reserves:infinifi",
          last_attempted_at: now,
          last_success_at: now,
          last_status: "error",
          warning_count: 0,
          warnings: null,
          last_error: "HTTP 503",
          metadata: "{}",
        },
      ],
    },
    {
      match: "reserve_composition",
      rows: [
        {
          stablecoin_id: "iusd-infinifi",
          slices: JSON.stringify(LIVE_SLICES),
          fetched_at: now,
          source: "infinifi",
        },
      ],
    },
  ]);

  const overview = await computeReserveCompositionOverview(db, now + 100);

  // The error coin has a consistent snapshot (sync.last_success_at === composition.fetched_at)
  // and is within the freshness window, so it should be counted as errorCoins, not degradedCoins
  expect(overview.errorCoins).toBe(1);
  // Verify it's NOT double-counted as degraded
  expect(overview.degradedCoins).toBe(0);
});
```

Note: This test constructs a mock where only `iusd-infinifi` has data. The `computeReserveCompositionOverview` uses `getConfiguredLiveReserveCoins()` which returns all 28 configured coins, but the mock will return `null` for coins not in the mock data, so those will be counted as `missingCoins`. The assertions above focus on the error coin not being in the degraded count. Adjust `expect(overview.errorCoins).toBe(1)` based on actual mock behavior -- the key point is `errorCoins >= 1` and the error coin is not in `degradedCoins`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd worker && npx vitest run src/lib/__tests__/live-reserves-store.test.ts --reporter=verbose`
Expected: FAIL -- `errorCoins` property doesn't exist on `ReserveCompositionOverview`.

- [ ] **Step 3: Add `errorCoins` to `ReserveCompositionOverview`**

In `worker/src/lib/live-reserves-store.ts`, update the interface (lines 50-58):

```typescript
export interface ReserveCompositionOverview {
  configuredCoins: number;
  freshCoins: number;
  staleCoins: number;
  missingCoins: number;
  degradedCoins: number;
  errorCoins: number;
  lastSuccessAt: number | null;
  oldestFreshAgeSec: number | null;
}
```

- [ ] **Step 4: Update the overview computation logic**

In `computeReserveCompositionOverview`, add `let errorCoins = 0;` after `let degradedCoins = 0;` (line 307).

Replace the degraded classification block (line 330-333). Insert the error check BEFORE the existing degraded check:

```typescript
// Error coins: fresh snapshot but last status is error
if (sync && sync.last_status === "error") {
  errorCoins++;
  continue;
}

// Degraded coins: non-ok status or inconsistent snapshot
if (sync && (sync.last_status !== "ok" || (sync.last_success_at != null && !hasSnapshot))) {
  degradedCoins++;
  continue;
}
```

Update BOTH return statements to include `errorCoins`:
- The empty return (line 265-273): add `errorCoins: 0`
- The main return (line 339-347): add `errorCoins`

- [ ] **Step 5: Update `StatusResponse` type**

In `shared/types/status.ts` (lines 308-316), add `errorCoins`:

```typescript
reserveComposition: {
  configuredCoins: number;
  freshCoins: number;
  staleCoins: number;
  missingCoins: number;
  degradedCoins: number;
  errorCoins: number;
  lastSuccessAt: number | null;
  oldestFreshAgeSec: number | null;
};
```

- [ ] **Step 6: Update `emptyReserveComposition`**

In `worker/src/api/status-derived-data.ts` (lines 47-56), add `errorCoins: 0`.

- [ ] **Step 7: Update status warning/critical detection and message**

In `worker/src/api/status.ts`:

Line 386-390 (`reserveCompositionCritical`): add `|| reserveComposition.errorCoins > 0`
```typescript
const reserveCompositionCritical =
  !reserveCompositionBootstrap
  && reserveComposition.configuredCoins > 0
  && reserveComposition.freshCoins === 0
  && (reserveComposition.missingCoins > 0 || reserveComposition.staleCoins > 0 || reserveComposition.degradedCoins > 0 || reserveComposition.errorCoins > 0);
```

Line 391-393 (`reserveCompositionWarning`): add `|| reserveComposition.errorCoins > 0`
```typescript
const reserveCompositionWarning =
  !reserveCompositionBootstrap
  && (reserveComposition.missingCoins > 0 || reserveComposition.staleCoins > 0 || reserveComposition.degradedCoins > 0 || reserveComposition.errorCoins > 0);
```

Line 663 (warning message): update to include errorCoins
```typescript
message: `${reserveComposition.errorCoins} error, ${reserveComposition.missingCoins} missing, ${reserveComposition.staleCoins} stale, ${reserveComposition.degradedCoins} degraded live reserve feed(s).`,
```

- [ ] **Step 8: Update the status health card UI**

In `src/components/status/reserve-sync-health.tsx`, change `md:grid-cols-5` to `md:grid-cols-6` and add an Error column after Fresh:

```tsx
<div className="grid grid-cols-2 gap-3 md:grid-cols-6">
  <div>
    <div className="text-muted-foreground">Configured</div>
    <div className="font-mono text-lg">{health.configuredCoins}</div>
  </div>
  <div>
    <div className="text-muted-foreground">Fresh</div>
    <div className="font-mono text-lg text-green-600 dark:text-green-400">{health.freshCoins}</div>
  </div>
  <div>
    <div className="text-muted-foreground">Error</div>
    <div className="font-mono text-lg text-red-600 dark:text-red-400">{health.errorCoins}</div>
  </div>
  <div>
    <div className="text-muted-foreground">Degraded</div>
    <div className="font-mono text-lg text-amber-600 dark:text-amber-400">{health.degradedCoins}</div>
  </div>
  <div>
    <div className="text-muted-foreground">Stale</div>
    <div className="font-mono text-lg text-orange-600 dark:text-orange-400">{health.staleCoins}</div>
  </div>
  <div>
    <div className="text-muted-foreground">Missing</div>
    <div className="font-mono text-lg text-red-600 dark:text-red-400">{health.missingCoins}</div>
  </div>
</div>
```

- [ ] **Step 9: Update `docs/live-reserves.md` overview fields list**

In `docs/live-reserves.md`, the overview field list (lines 110-116), add `errorCoins` after `degradedCoins`:

```markdown
- `errorCoins`
```

- [ ] **Step 10: Run all affected tests and type-check**

Run: `cd worker && npx vitest run src/lib/__tests__/live-reserves-store.test.ts --reporter=verbose`
Run: `npm run build` (type-check frontend + worker)
Expected: All PASS.

- [ ] **Step 11: Commit**

```bash
git add worker/src/lib/live-reserves-store.ts shared/types/status.ts \
  worker/src/api/status-derived-data.ts worker/src/api/status.ts \
  src/components/status/reserve-sync-health.tsx \
  worker/src/lib/__tests__/live-reserves-store.test.ts \
  docs/live-reserves.md
git commit -m "feat(L3): separate error vs degraded coin counts in reserve overview

Adds errorCoins counter to ReserveCompositionOverview. The /status health
card now shows Error and Degraded as distinct columns. Stale coins are
still classified as stale regardless of error status."
```

---

## Chunk 8: L4 (Falcon + Collateral-Positions-API) -- Unknown Asset Warnings

### Task 8: Add unknown-asset warnings to falcon and collateral-positions-api adapters

**Files:**
- Modify: `worker/src/cron/reserve-adapters/falcon.ts:67-128`
- Modify: `worker/src/cron/reserve-adapters/collateral-positions-api.ts:34-40,58-114`
- Test: `worker/src/cron/reserve-adapters/__tests__/falcon.test.ts`
- Test: `worker/src/cron/reserve-adapters/__tests__/collateral-positions-api.test.ts`

**Context:** Falcon and collateral-positions-api silently absorb unknown assets. The fix: emit `"unknown-asset"` warnings when encountering unmapped symbols, matching the pattern in ethena, crvusd, reservoir, and infinifi.

- [ ] **Step 1: Write the failing test for falcon unknown-asset warning**

Add to `worker/src/cron/reserve-adapters/__tests__/falcon.test.ts`:

```typescript
it("emits a warning for asset labels that fall into the 'other' bucket", () => {
  const payload: FalconTransparencyResponse = {
    snapshot_date: 1773316982,
    usdf: {
      supply: "100",
      insurance_fund: "5",
      breakdown: {
        assets: [
          { label: "USDC", ceffu: "50" },
          { label: "UNKNOWN_TOKEN_XYZ", ceffu: "50" },
        ],
      },
    },
  };
  const result = adaptFalconTransparency(payload);
  expect(result.warnings).toBeDefined();
  expect(result.warnings!.some(
    (w) => w.code === "unknown-asset" && w.message.includes("UNKNOWN_TOKEN_XYZ"),
  )).toBe(true);
});
```

- [ ] **Step 2: Write the failing test for collateral-positions-api unknown-asset warning**

First, the return type of `adaptCollateralPositions` must change from `ReserveSlice[]` to `AdapterResult`. Add to `worker/src/cron/reserve-adapters/__tests__/collateral-positions-api.test.ts`:

```typescript
it("emits a warning for symbols without a canonical reserve asset risk", () => {
  const result = adaptCollateralPositions(
    {
      "0xabc": {
        address: "0xabc",
        name: "Unknown Token",
        symbol: "XYZZY",
        decimals: 18,
        positions: [{ collateralBalance: "1000000000000000000" }],
      },
    },
    {
      "0xabc": { price: { usd: 100 } },
    },
  );
  expect(result.warnings).toBeDefined();
  expect(result.warnings!.some(
    (w) => w.code === "unknown-asset" && w.message.includes("XYZZY"),
  )).toBe(true);
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `cd worker && npx vitest run src/cron/reserve-adapters/__tests__/falcon.test.ts src/cron/reserve-adapters/__tests__/collateral-positions-api.test.ts --reporter=verbose`
Expected: FAIL.

- [ ] **Step 4: Add unknown-asset warning to `falcon.ts`**

In `worker/src/cron/reserve-adapters/falcon.ts`:

1. Add `LiveReserveWarning` to imports from `@shared/types`.
2. In `adaptFalconTransparency`, add a `warnings` array and push a warning when `bucket === "other"`:

```typescript
export function adaptFalconTransparency(payload: FalconTransparencyResponse): AdapterResult {
  const assets = payload.usdf?.breakdown?.assets ?? [];
  if (assets.length === 0) {
    throw new Error("Falcon transparency payload missing usdf.breakdown.assets");
  }

  const warnings: LiveReserveWarning[] = [];
  const bucketTotals = new Map<FalconBucket, number>();
  for (const asset of assets) {
    const value = sumFalconAssetValue(asset);
    if (!Number.isFinite(value) || value <= 0) continue;
    const bucket = bucketForFalconAsset(asset.label);
    if (bucket === "other") {
      warnings.push({
        code: "unknown-asset",
        message: `Unmapped Falcon asset: ${asset.label}`,
        severity: "warning",
      });
    }
    bucketTotals.set(bucket, (bucketTotals.get(bucket) ?? 0) + value);
  }

  // ... rest of slices construction stays the same ...

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      snapshotDate: payload.snapshot_date,
      supply: payload.usdf?.supply,
      insuranceFund: payload.usdf?.insurance_fund,
      assetCount: assets.length,
    },
  };
}
```

- [ ] **Step 5: Add unknown-asset warning to `collateral-positions-api.ts`**

This changes `adaptCollateralPositions` from returning `ReserveSlice[]` to `AdapterResult`.

1. Add `LiveReserveWarning` to imports from `@shared/types`.
2. Add `type AdapterResult` to imports from `./index`.
3. Change the return type and add warnings:

```typescript
export function adaptCollateralPositions(
  details: PositionDetailsPayload,
  prices: PriceMappingPayload,
  otherThresholdPct = 2,
): AdapterResult {
  const warnings: LiveReserveWarning[] = [];
  const values: Array<{ name: string; usd: number; risk: ReserveSlice["risk"]; coinId?: string }> = [];

  for (const entry of Object.values(details)) {
    const priceInfo = prices[entry.address.toLowerCase()];
    const usdPrice = priceInfo?.price?.usd;
    if (typeof usdPrice !== "number" || usdPrice <= 0) continue;

    const totalBalance = entry.positions.reduce((acc, position) => {
      if (position.closed || position.denied) return acc;
      const raw = Number(position.collateralBalance ?? "0");
      return Number.isFinite(raw) && raw > 0 ? acc + raw / (10 ** entry.decimals) : acc;
    }, 0);

    if (totalBalance <= 0) continue;

    const risk = inferRisk(entry.symbol);
    if (!getCanonicalReserveAssetRisk(entry.symbol.toUpperCase())) {
      warnings.push({
        code: "unknown-asset",
        message: `Unmapped collateral symbol: ${entry.symbol} (inferred risk: ${risk})`,
        severity: "warning",
      });
    }

    values.push({
      name: `${entry.symbol}${entry.name && entry.name !== entry.symbol ? ` (${entry.name})` : ""}`,
      usd: totalBalance * usdPrice,
      risk,
      coinId: inferCoinId(entry.symbol),
    });
  }

  const total = values.reduce((acc, value) => acc + value.usd, 0);
  if (total <= 0) return { slices: [] };

  const major = values.filter((value) => (value.usd / total) * 100 >= otherThresholdPct);
  const minor = values.filter((value) => (value.usd / total) * 100 < otherThresholdPct);

  const slices = major.map((value) => ({
    name: value.name,
    pct: (value.usd / total) * 100,
    risk: value.risk,
    ...(value.coinId ? { coinId: value.coinId } : {}),
  }));

  if (minor.length > 0) {
    const otherUsd = minor.reduce((acc, value) => acc + value.usd, 0);
    const highestRisk = minor.some((value) => value.risk === "very-high")
      ? "very-high"
      : minor.some((value) => value.risk === "high")
        ? "high"
        : "medium";
    slices.push({
      name: "Other collateral",
      pct: (otherUsd / total) * 100,
      risk: highestRisk,
    });
  }

  return {
    slices: normalizeSlices(slices),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
```

Update `fetchCollateralPositionsApiReserves` to pass through the full result:
```typescript
export async function fetchCollateralPositionsApiReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "collateral-positions-api");
  const params = readParams(config);

  const [details, prices] = await Promise.all([
    fetchJsonWithRetry<PositionDetailsPayload>(input.url, signal),
    fetchJsonWithRetry<PriceMappingPayload>(params.pricesUrl, signal),
  ]);

  return adaptCollateralPositions(details, prices, params.otherThresholdPct ?? 2);
}
```

- [ ] **Step 6: Update the existing collateral-positions-api test for the return type change**

In `worker/src/cron/reserve-adapters/__tests__/collateral-positions-api.test.ts`, update the test at lines 4-48:

```typescript
it("aggregates open collateral positions into reserve slices and folds small tails into Other", () => {
  const result = adaptCollateralPositions(
    {
      "0xbtc": {
        address: "0xBTC",
        name: "Wrapped BTC",
        symbol: "WBTC",
        decimals: 8,
        positions: [
          { collateralBalance: "500000000", closed: false, denied: false },
        ],
      },
      "0xeth": {
        address: "0xETH",
        name: "Wrapped Ether",
        symbol: "WETH",
        decimals: 18,
        positions: [
          { collateralBalance: "200000000000000000000", closed: false, denied: false },
        ],
      },
      "0xgno": {
        address: "0xGNO",
        name: "Gnosis",
        symbol: "GNO",
        decimals: 18,
        positions: [
          { collateralBalance: "1000000000000000000", closed: false, denied: false },
        ],
      },
    },
    {
      "0xbtc": { price: { usd: 100000 } },
      "0xeth": { price: { usd: 2000 } },
      "0xgno": { price: { usd: 200 } },
    },
    5,
  );

  expect(result.slices).toEqual([
    { name: "WBTC (Wrapped BTC)", pct: 56, risk: "medium" },
    { name: "WETH (Wrapped Ether)", pct: 44, risk: "very-low" },
  ]);
});
```

- [ ] **Step 7: Update the existing falcon test to verify no warnings on known assets**

In `worker/src/cron/reserve-adapters/__tests__/falcon.test.ts`, at the end of the existing test (after `expect(result.metadata)...`), verify no warnings are emitted for the `AVAX` asset (which intentionally falls into "other" -- but wait, the existing test DOES include AVAX which falls into "other"). The existing test payload includes `AVAX` which would now trigger a warning. Verify this is acceptable and update the existing test assertion:

After the existing `expect(result.metadata)` assertion, add:
```typescript
// AVAX falls into "other" bucket, triggering an unknown-asset warning
expect(result.warnings).toBeDefined();
expect(result.warnings!.some((w) => w.code === "unknown-asset" && w.message.includes("AVAX"))).toBe(true);
```

- [ ] **Step 8: Run all affected adapter tests**

Run: `cd worker && npx vitest run src/cron/reserve-adapters/__tests__/ --reporter=verbose`
Expected: All PASS.

- [ ] **Step 9: Commit**

```bash
git add worker/src/cron/reserve-adapters/falcon.ts \
  worker/src/cron/reserve-adapters/collateral-positions-api.ts \
  worker/src/cron/reserve-adapters/__tests__/falcon.test.ts \
  worker/src/cron/reserve-adapters/__tests__/collateral-positions-api.test.ts
git commit -m "feat(L4): standardize unknown-asset warnings in falcon and collateral-positions-api

Both adapters now emit warnings with code 'unknown-asset' when encountering
unmapped symbols, matching the existing pattern in ethena, crvusd, reservoir,
and infinifi. adaptCollateralPositions now returns AdapterResult."
```

---

## Chunk 9: L5 -- Fix Migration Comment

### Task 9: Fix the migration comment from "daily" to "hourly"

**Files:**
- Modify: `worker/migrations/0064_reserve_composition.sql:1`

**Note:** This is a comment-only change. It does NOT require re-running the migration or any schema changes.

- [ ] **Step 1: Fix the comment**

In `worker/migrations/0064_reserve_composition.sql`, change line 1:

```sql
-- Before:
-- Live reserve composition synced daily from protocol data APIs.
-- After:
-- Live reserve composition synced hourly from protocol data APIs.
```

- [ ] **Step 2: Commit**

```bash
git add worker/migrations/0064_reserve_composition.sql
git commit -m "docs(L5): fix migration comment from 'daily' to 'hourly'

The reserve sync cron runs at '11 * * * *' (hourly), not daily.
Comment-only change; no schema modification."
```

---

## Final Verification

- [ ] **Run full test suite**: `npm test`
- [ ] **Run full build + type-check**: `npm run build && cd worker && npx tsc --noEmit`
- [ ] **Run lint**: `npm run lint`
