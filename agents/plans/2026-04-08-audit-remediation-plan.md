# Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 9 verified issues from the 2026-04-08 codebase audit — 4 major (missing `.json()` error handling, unbounded admin query) and 5 minor (type safety, filter dedup, NaN guard, silent catches, unsafe cast).

**Architecture:** Each fix is a self-contained, narrowly scoped change to one or two files. No shared abstractions introduced. Every fix is test-driven: failing test first, then minimal implementation. Fixes are ordered by severity (majors first), then by dependency (shared-lib before consumers).

**Tech Stack:** TypeScript strict, Vitest, Cloudflare Workers D1, React 19.

---

## File Map

| Task | Files Modified | Files Created | Test File |
|------|---------------|---------------|-----------|
| 1 | `worker/src/cron/dex-liquidity/fetch-primary.ts` | — | `worker/src/cron/__tests__/dex-liquidity-fetch-primary.test.ts` |
| 2 | `worker/src/api/status-supplements.ts` | — | (no test — private function, verified by tsc + build) |
| 3 | `worker/src/api/audit-depeg-history.ts` | — | (existing test coverage via admin route pattern) |
| 4 | `worker/src/api/discovery.ts` | — | `worker/src/api/__tests__/discovery.test.ts` |
| 5 | `shared/lib/peg-score.ts` | — | `shared/lib/__tests__/peg-score.test.ts` |
| 6 | `src/components/share-button.tsx` | — | (no test — UI component, manual verification) |
| 7 | `src/components/yield-scatter-plot.tsx` | — | (no test — chart callback, manual verification) |
| 8 | `src/components/peg-heatmap.tsx`, `src/app/depeg/client.tsx`, `shared/lib/classification.ts` | — | (no test — constant extraction, type-checked at build) |
| 9 | — | — | — (commit + merge gate) |

---

### Task 1: Wrap DeFiLlama `.json()` calls in try-catch (fetch-primary.ts)

**Severity:** Major
**Files:**
- Modify: `worker/src/cron/dex-liquidity/fetch-primary.ts:71,116`
- Create: `worker/src/cron/__tests__/dex-liquidity-fetch-primary.test.ts`

**Context:** `fetchDataSources()` calls `.json()` on DeFiLlama yields (line 71) and protocols (line 116) responses without try-catch. If DL returns malformed JSON during maintenance, the entire dex-liquidity sync crashes instead of degrading gracefully to CG/GT-only mode.

- [ ] **Step 1: Write the failing test**

Create `worker/src/cron/__tests__/dex-liquidity-fetch-primary.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

// Isolate the module under test from its heavy dependency tree
vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(),
}));
vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(),
  recordOutcome: vi.fn(async () => {}),
}));
vi.mock("../../lib/db-cache", () => ({ setCache: vi.fn(async () => {}) }));
vi.mock("../yield-sync/cache", () => ({ buildDlStablecoinPoolsCache: vi.fn(() => "{}") }));
vi.mock("../yield-sync/pool-filter", () => ({ isYieldRelevantDlPool: vi.fn(() => false) }));
vi.mock("../../lib/coingecko-onchain", () => ({
  fetchCgTokensBatch: vi.fn(),
  onchainRateLimit: vi.fn(async () => {}),
  CG_CHAIN_MAP: {},
}));
vi.mock("../../lib/chain-registry", () => ({ GT_CHAIN_MAP: {} }));
vi.mock("../../lib/rate-limit", () => ({ RATE_LIMITS: {} }));
vi.mock("../../lib/dex-constants", () => ({ GT_API_BASE: "", normalizeDexSymbol: vi.fn((s: string) => s) }));
vi.mock("../../lib/abort", () => ({ sleepWithSignal: vi.fn() }));
vi.mock("../dex-liquidity/pool-helpers", () => ({
  normalizeProtocol: vi.fn((s: string) => s),
  getTrackedContracts: vi.fn(() => new Map()),
  classifyPoolType: vi.fn(() => "unknown"),
  isCryptoSwap: vi.fn(() => false),
}));
vi.mock("../dex-liquidity/price-sanity", () => ({ isPlausibleDexObservationPrice: vi.fn(() => true) }));
vi.mock("../../lib/price-validation", () => ({}));
vi.mock("../dex-liquidity/pool-identity", () => ({
  buildPoolIdentity: vi.fn(),
  createKnownPoolIdentityIndex: vi.fn(() => ({
    exactKeys: new Set(),
    derivedKeyCounts: new Map(),
    derivedToExactKeys: new Map(),
    wildcardKeyCounts: new Map(),
    wildcardToExactKeys: new Map(),
  })),
  registerKnownPoolIdentity: vi.fn(),
}));
vi.mock("../dex-liquidity/token-resolution", () => ({ resolveTrackedStablecoinId: vi.fn() }));
vi.mock("../dex-liquidity/subgraph-source-families", () => ({
  fetchAerodromeData: vi.fn(async () => ({ aerodromePriceObs: new Map(), aerodromeIsStable: new Map() })),
  fetchUniV3Data: vi.fn(async () => ({ uniV3PoolFees: new Map(), uniV3SymbolFees: new Map(), uniV3PriceObs: new Map() })),
}));
vi.mock("../dex-liquidity/token-batch-runner", () => ({ runTokenBatchPriceFetch: vi.fn(async () => new Map()) }));

import { fetchWithRetry } from "../../lib/fetch-retry";
import { shouldAttemptFetch } from "../../lib/circuit-breaker";
import { recordOutcome } from "../../lib/circuit-breaker";

// Must be imported AFTER vi.mock calls
const { fetchDataSources } = await import("../dex-liquidity/fetch-primary");

describe("fetchDataSources — malformed JSON resilience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Allow DL yields + protocols, block Curve circuit to isolate DL JSON handling
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => {
      if (source === "curve-liquidity-api") return false;
      return true;
    });
  });

  it("degrades gracefully when DL yields returns invalid JSON", async () => {
    const badResponse = {
      ok: true,
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
      body: { cancel: async () => {} },
      bodyUsed: false,
    } as unknown as Response;

    vi.mocked(fetchWithRetry).mockResolvedValueOnce(badResponse)   // yields
      .mockResolvedValueOnce(null);                                 // protocols

    const db = mockD1();
    const result = await fetchDataSources(null, db);
    // Should NOT throw — should return a DataSources with empty pools
    // (Curve circuit is closed, so the catastrophic "all sources failed" check
    // is bypassed: !dlYieldsAvailable && curveResponses.every(!ok) is false
    // because curveResponses are all null from the closed circuit path)
    expect(result).toBeNull();
    // The key assertion: no unhandled SyntaxError thrown — function ran to completion.
    // Circuit breaker should record DL yields failure
    expect(recordOutcome).toHaveBeenCalledWith(expect.anything(), "defillama-yields", false);
  });

  it("degrades gracefully when DL protocols returns invalid JSON", async () => {
    // Provide valid yields with 1000+ pools so dlYieldsAvailable = true
    const pools = Array.from({ length: 1001 }, (_, i) => ({
      pool: `pool-${i}`, chain: "Ethereum", project: `proj-${i}`, symbol: "USDC",
      tvlUsd: 1000, apy: 1, apyBase: 1, apyReward: 0, stablecoin: true, exposure: "single",
    }));
    const goodYieldsResponse = {
      ok: true,
      json: async () => ({ data: pools }),
      body: { cancel: async () => {} },
      bodyUsed: false,
    } as unknown as Response;
    const badProtocolsResponse = {
      ok: true,
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
      body: { cancel: async () => {} },
      bodyUsed: false,
    } as unknown as Response;

    vi.mocked(fetchWithRetry).mockResolvedValueOnce(goodYieldsResponse)
      .mockResolvedValueOnce(badProtocolsResponse);

    const db = mockD1();
    const result = await fetchDataSources(null, db);
    // dlYieldsAvailable = true, so catastrophic check passes → returns DataSources
    expect(result).not.toBeNull();
    expect(result!.pools).toHaveLength(1001);
    // Circuit breaker should record DL protocols failure
    expect(recordOutcome).toHaveBeenCalledWith(expect.anything(), "defillama-protocols", false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run worker/src/cron/__tests__/dex-liquidity-fetch-primary.test.ts`
Expected: FAIL — `SyntaxError: Unexpected token` propagates unhandled.

- [ ] **Step 3: Implement the fix**

In `worker/src/cron/dex-liquidity/fetch-primary.ts`, wrap the two `.json()` calls:

**DL Yields block (replace lines 70-100):**
```typescript
  if (dlYieldsAllowed) {
    if (llamaRes?.ok) {
      try {
        const llamaData = (await llamaRes.json()) as { data: LlamaPool[] };
        if (llamaData.data && llamaData.data.length >= 1000) {
          await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, true);
          pools = llamaData.data;
          dlYieldsAvailable = true;
          for (const pool of pools) {
            if (!pool.project || pool.exposure === "single") continue;
            fallbackDexProjects.add(pool.project);
          }
          console.log(`[dex-liquidity] Got ${pools.length} pools from DeFiLlama yields`);

          // Cache minimal stablecoin pool data for yield sync (avoids redundant 13MB re-fetch)
          try {
            const minimalPools = pools
              .filter(isYieldRelevantDlPool)
              .map((p) => ({
                pool: p.pool, chain: p.chain, project: p.project, symbol: p.symbol,
                poolMeta: p.poolMeta ?? null,
                tvlUsd: p.tvlUsd, apy: p.apy, apyBase: p.apyBase,
                apyReward: p.apyReward, apyMean30d: p.apyMean30d ?? p.apy, stablecoin: p.stablecoin, exposure: p.exposure,
                underlyingTokens: p.underlyingTokens ?? null,
              }));
            await setCache(db, "dl-stablecoin-pools", buildDlStablecoinPoolsCache(minimalPools));
          } catch (e) {
            console.warn("[dex-liquidity] Failed to cache stablecoin pools for yield sync:", e);
          }
        } else {
          await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, false);
          console.warn(`[dex-liquidity] DeFiLlama returned only ${llamaData.data?.length ?? 0} pools — degraded mode`);
        }
      } catch (e) {
        console.warn("[dex-liquidity] DeFiLlama yields response parse failed:", e instanceof Error ? e.message : String(e));
        await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, false);
      }
    } else {
```

**DL Protocols block (replace lines 114-144):**
```typescript
  if (dlProtocolsAllowed) {
    if (protocolsRes?.ok) {
      try {
        const protocols = (await protocolsRes.json()) as {
          slug: string;
          category?: string;
          tvl?: number | null;
          deadFrom?: number | null;
          rugged?: boolean | null;
          deprecated?: boolean | null;
        }[];
        for (const p of protocols) {
          if (p.category !== "Dexs") continue;
          if (p.deadFrom || p.rugged || p.deprecated) continue;
          dexProjects.add(p.slug);
          if (p.tvl && p.tvl > 0) {
            const norm = normalizeProtocol(p.slug);
            protocolTvlCaps.set(norm, (protocolTvlCaps.get(norm) ?? 0) + p.tvl);
          }
        }
        dlProtocolsAvailable = dexProjects.size > 0;
        await recordOutcome(db, CIRCUIT_SOURCE.DL_PROTOCOLS, dlProtocolsAvailable);
        if (dlProtocolsAvailable) {
          console.log(`[dex-liquidity] Indexed ${dexProjects.size} active DEX projects, ${protocolTvlCaps.size} with TVL caps`);
        } else {
          console.warn("[dex-liquidity] DeFiLlama protocols response had zero active DEX projects — degraded");
        }
      } catch (e) {
        console.warn("[dex-liquidity] DeFiLlama protocols response parse failed:", e instanceof Error ? e.message : String(e));
        await recordOutcome(db, CIRCUIT_SOURCE.DL_PROTOCOLS, false);
      }
    } else {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run worker/src/cron/__tests__/dex-liquidity-fetch-primary.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/dex-liquidity/fetch-primary.ts worker/src/cron/__tests__/dex-liquidity-fetch-primary.test.ts
git commit -m "fix(dex-liquidity): wrap DeFiLlama .json() calls in try-catch for graceful degradation"
```

---

### Task 2: Wrap CoinGecko `.json()` in try-catch (status-supplements.ts)

**Severity:** Major
**Files:**
- Modify: `worker/src/api/status-supplements.ts:97`
- Create: `worker/src/api/__tests__/status-supplements.test.ts`

**Context:** `fetchCoinGeckoUsdPrices()` calls `await response.json()` without try-catch. If CoinGecko returns an HTML error page on a 200 status (known to happen), this crashes the status supplements endpoint. The function is private (not exported), so testing requires either exporting it or mocking globalThis.fetch with complex setup. Given the fix is a 5-line try-catch in a loop body, worker type-check + build verification is sufficient.

- [ ] **Step 1: Implement the fix**

In `worker/src/api/status-supplements.ts`, replace lines 97-103:

```typescript
    let payload: Record<string, { usd?: number }> | null;
    try {
      payload = await response.json();
    } catch {
      console.warn("[status-supplements] CoinGecko price response parse failed — skipping batch");
      continue;
    }
    if (!payload || typeof payload !== "object") continue;
    for (const [geckoId, quote] of Object.entries(payload)) {
      if (typeof quote?.usd === "number" && Number.isFinite(quote.usd) && quote.usd > 0) {
        prices.set(geckoId, quote.usd);
      }
    }
```

Note: this removes the `as Record<string, { usd?: number }>` cast by typing `payload` properly.

- [ ] **Step 2: Run worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add worker/src/api/status-supplements.ts
git commit -m "fix(status): wrap CoinGecko .json() in try-catch to survive HTML-on-200 responses"
```

---

### Task 3: Add LIMIT to unbounded admin depeg-audit query

**Severity:** Major
**Files:**
- Modify: `worker/src/api/audit-depeg-history.ts:234-235`

**Context:** The audit endpoint loads ALL closed depeg events (no LIMIT). It's admin-only so not user-exploitable, but as the table grows this becomes a D1 memory pressure issue. The endpoint already accepts `limit`/`offset` query params (parsed at line 201) but doesn't apply them to the events query.

**Important constraint:** The `?delete=ID1,ID2` code path (line 241) searches the fetched events by ID. If we blindly paginate, IDs outside the current page would cause false 404s. The fix applies LIMIT/OFFSET only on the default CG price-validation path (no delete, no repair). The delete path uses `DELETE ... WHERE id = ?` directly (it doesn't need the full result set), and the repair path has its own separate unbounded query (line 290).

- [ ] **Step 1: Implement the fix**

In `worker/src/api/audit-depeg-history.ts`, replace lines 232-238:

```typescript
      // 1. Query closed depeg events
      // Apply pagination only for the default audit path. The delete path
      // targets events by ID (doesn't need the full set), and the repair path
      // has its own separate query at line 290.
      const usePagination = !deleteIds && !repairMode;
      const eventsSql = "SELECT id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source FROM depeg_events WHERE ended_at IS NOT NULL ORDER BY started_at"
        + (usePagination ? " LIMIT ? OFFSET ?" : "");
      const eventsStmt = usePagination
        ? db.prepare(eventsSql).bind(limit, offset)
        : db.prepare(eventsSql);
      const allEvents = await eventsStmt.all<DepegRow>();
      const events = allEvents.results ?? [];
```

- [ ] **Step 2: Run worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add worker/src/api/audit-depeg-history.ts
git commit -m "fix(admin): add LIMIT/OFFSET to audit-depeg-history default path to bound memory usage"
```

---

### Task 4: Type the D1 count result in discovery.ts

**Severity:** Minor
**Files:**
- Modify: `worker/src/api/discovery.ts:56-65`
- Modify: `worker/src/api/__tests__/discovery.test.ts` (existing test covers this already — just verify it still passes)

**Context:** Line 65 uses an unsafe double cast `((countResult.results?.[0] as Record<string, unknown>)?.total as number) ?? 0`. The fix types the `.all()` call properly.

- [ ] **Step 1: Implement the fix**

In `worker/src/api/discovery.ts`, replace lines 56-65:

```typescript
    db.prepare(
      `SELECT COUNT(*) as total FROM discovery_candidates ${whereClause}`,
    ).all<{ total: number }>(),
  ]);

  const candidates: DiscoveryCandidate[] = (rows.results ?? []).map((row) =>
    mapDiscoveryCandidateRow(row, nowSec)
  );

  const total = countResult.results?.[0]?.total ?? 0;
```

- [ ] **Step 2: Run existing test + type-check**

Run: `npx vitest run worker/src/api/__tests__/discovery.test.ts && cd worker && npx tsc --noEmit`
Expected: all pass, 0 type errors.

- [ ] **Step 3: Commit**

```bash
git add worker/src/api/discovery.ts
git commit -m "fix(discovery): type D1 count query to eliminate unsafe double assertion"
```

---

### Task 5: Add `Number.isFinite()` guard to peg-score spread penalty

**Severity:** Minor
**Files:**
- Modify: `shared/lib/peg-score.ts:146`
- Modify: `shared/lib/__tests__/peg-score.test.ts`

**Context:** `Math.sqrt(variance)` could produce NaN if a corrupted `peakDeviationBps` value enters the calculation. Single-line guard with zero cost.

- [ ] **Step 1: Write the failing test**

Add to `shared/lib/__tests__/peg-score.test.ts`:

```typescript
  it("handles NaN peakDeviationBps without producing NaN score", () => {
    const start = NOW - 90 * DAY;
    const events = [
      {
        startedAt: NOW - 30 * DAY,
        endedAt: NOW - 29 * DAY,
        peakDeviationBps: NaN,
        direction: "below" as const,
      },
      {
        startedAt: NOW - 20 * DAY,
        endedAt: NOW - 19 * DAY,
        peakDeviationBps: 200,
        direction: "below" as const,
      },
    ];
    const result = computePegScore(events as never, start, NOW);
    // Score must be a finite number or null — never NaN
    if (result.pegScore !== null) {
      expect(Number.isFinite(result.pegScore)).toBe(true);
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/lib/__tests__/peg-score.test.ts`
Expected: FAIL — `result.pegScore` is `NaN` because the NaN propagates through the spread penalty calculation.

- [ ] **Step 3: Implement the fix**

In `shared/lib/peg-score.ts`, replace line 146:

```typescript
    spreadPenalty = Number.isFinite(stdDev) ? Math.min(15, (stdDev / 1000) * 15) : 0;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run shared/lib/__tests__/peg-score.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add shared/lib/peg-score.ts shared/lib/__tests__/peg-score.test.ts
git commit -m "fix(peg-score): guard spread penalty against NaN from corrupted deviation data"
```

---

### Task 6: Add error logging to share-button catch blocks

**Severity:** Minor
**Files:**
- Modify: `src/components/share-button.tsx:48,62,79`

**Context:** Three catch blocks silently swallow errors, making clipboard/download failures impossible to debug in production.

- [ ] **Step 1: Implement the fix**

In `src/components/share-button.tsx`, update the three catch blocks:

Replace line 48:
```typescript
    } catch (err) {
      console.warn("[share] clipboard write failed:", err instanceof Error ? err.message : String(err));
```

Replace line 62:
```typescript
    } catch (err) {
      console.warn("[share] image copy failed:", err instanceof Error ? err.message : String(err));
```

Replace line 79:
```typescript
    } catch (err) {
      console.warn("[share] download failed:", err instanceof Error ? err.message : String(err));
```

- [ ] **Step 2: Run build to verify**

Run: `npm run build 2>&1 | tail -5`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/share-button.tsx
git commit -m "fix(share): log errors in catch blocks for production debuggability"
```

---

### Task 7: Add type guard to yield scatter plot click handler

**Severity:** Minor
**Files:**
- Modify: `src/components/yield-scatter-plot.tsx:223-229`

**Context:** Recharts passes `unknown` to click callbacks. The current code casts without validation. Adding a type guard makes the handler resilient to Recharts payload changes.

- [ ] **Step 1: Implement the fix**

In `src/components/yield-scatter-plot.tsx`, replace lines 223-229:

```typescript
  const handleClick = useCallback(
    (entry: unknown) => {
      if (entry && typeof entry === "object" && "id" in entry && typeof (entry as { id: unknown }).id === "string") {
        onDotClick((entry as { id: string }).id);
      }
    },
    [onDotClick],
  );
```

- [ ] **Step 2: Run build to verify**

Run: `npm run build 2>&1 | tail -5`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/yield-scatter-plot.tsx
git commit -m "fix(yield-scatter): add type guard to click handler instead of unsafe cast"
```

---

### Task 8: Extract shared filter option constants

**Severity:** Minor
**Files:**
- Modify: `shared/lib/classification.ts` (add exports)
- Modify: `src/components/peg-heatmap.tsx:32-44` (consume shared constants)
- Modify: `src/app/depeg/client.tsx:30-42` (consume shared constants)

**Context:** Both `peg-heatmap.tsx` and `depeg/client.tsx` define local PEG/TYPE filter option arrays with overlapping but divergent content. Extract to `classification.ts` as the single source of truth.

**Label normalization:** The depeg client currently uses `"All"` (short) while the heatmap uses `"All Pegs"`. We standardize on `"All Pegs"` for the shared constant since both UIs have adequate horizontal space. The depeg governance filters use hardcoded `"CeFi"/"CeFi-Dep"/"DeFi"` strings which already match `GOVERNANCE_LABELS_SHORT` values.

**Type note:** The shared constants are typed as mutable arrays (`{ value; label }[]`) — not `readonly` or `as const` — because the `FilterChips` component generic expects `T[]` not `readonly T[]`.

- [ ] **Step 1: Add shared filter option exports**

In `shared/lib/classification.ts`, add after the `GOVERNANCE_LABELS_SHORT` block (after line 35, before the `// Backing labels` comment):

```typescript

// ---------------------------------------------------------------------------
// Filter option tuples — used by heatmap and depeg filter UIs
// ---------------------------------------------------------------------------

export const PEG_FILTER_OPTIONS: { value: PegCurrency | "all"; label: string }[] = [
  { value: "all", label: "All Pegs" },
  { value: "USD", label: "USD" },
  { value: "EUR", label: "EUR" },
  { value: "GOLD", label: "Gold" },
];

export const GOVERNANCE_FILTER_OPTIONS: { value: GovernanceType | "all"; label: string }[] = [
  { value: "all", label: "All Types" },
  { value: "centralized", label: GOVERNANCE_LABELS_SHORT.centralized },
  { value: "centralized-dependent", label: GOVERNANCE_LABELS_SHORT["centralized-dependent"] },
  { value: "decentralized", label: GOVERNANCE_LABELS_SHORT.decentralized },
];
```

- [ ] **Step 2: Update peg-heatmap.tsx to use shared constants**

In `src/components/peg-heatmap.tsx`:

**2a.** Replace the import (line 16):
```typescript
import { GOVERNANCE_LABELS_SHORT } from "@shared/lib/classification";
```
with:
```typescript
import { PEG_FILTER_OPTIONS, GOVERNANCE_FILTER_OPTIONS } from "@shared/lib/classification";
```

**2b.** Delete the local `PEG_OPTIONS` constant (lines 32-37) and `TYPE_OPTIONS` constant (lines 39-44) entirely.

**2c.** In the JSX (line 115-116), replace:
```typescript
              <FilterChips options={PEG_OPTIONS} value={pegFilter} onChange={onPegFilterChange} />
              <FilterChips options={TYPE_OPTIONS} value={typeFilter} onChange={onTypeFilterChange} />
```
with:
```typescript
              <FilterChips options={PEG_FILTER_OPTIONS} value={pegFilter} onChange={onPegFilterChange} />
              <FilterChips options={GOVERNANCE_FILTER_OPTIONS} value={typeFilter} onChange={onTypeFilterChange} />
```

- [ ] **Step 3: Update depeg/client.tsx to use shared constants**

In `src/app/depeg/client.tsx`:

**3a.** Replace the import (line 27):
```typescript
import { PEG_LABELS_SHORT, GOVERNANCE_LABELS } from "@shared/lib/classification";
```
with:
```typescript
import { PEG_LABELS_SHORT, GOVERNANCE_LABELS, PEG_FILTER_OPTIONS, GOVERNANCE_FILTER_OPTIONS } from "@shared/lib/classification";
```

**3b.** Delete the local `PEG_FILTERS` constant (lines 30-35) and `TYPE_FILTERS` constant (lines 37-42) entirely.

**3c.** In the JSX (line 197), replace:
```typescript
                {PEG_FILTERS.map((f) => (
```
with:
```typescript
                {PEG_FILTER_OPTIONS.map((f) => (
```

**3d.** In the JSX (line 210), replace:
```typescript
                {TYPE_FILTERS.map((f) => (
```
with:
```typescript
                {GOVERNANCE_FILTER_OPTIONS.map((f) => (
```

- [ ] **Step 4: Run build + lint**

Run: `npm run build 2>&1 | tail -5 && npm run lint 2>&1 | tail -3`
Expected: Both pass.

- [ ] **Step 5: Commit**

```bash
git add shared/lib/classification.ts src/components/peg-heatmap.tsx src/app/depeg/client.tsx
git commit -m "refactor: extract peg/governance filter options to shared classification module"
```

---

### Task 9: Final verification — merge gate

- [ ] **Step 1: Run the full merge gate**

Run: `npm run test:merge-gate`
Expected: All checks pass (lint, type-check, tests, build, SEO).

- [ ] **Step 2: Verify no regressions**

Run: `npm test -- --run 2>&1 | tail -5`
Expected: 4030+ tests pass, 0 failures.

- [ ] **Step 3: Run worker type-check independently**

Run: `cd worker && npx tsc --noEmit`
Expected: 0 errors.
