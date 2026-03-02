# Three-Phase Refinement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Consolidate API handler boilerplate, add comprehensive worker tests, and close resilience gaps — in that dependency order.

**Architecture:** Extract 3 shared utilities into the existing `worker/src/lib/api-utils.ts`, mechanically replace inline patterns across 32 handlers, then write ~29 test files covering all public API handlers and critical cron jobs (with degraded-mode scenarios), then add Etherscan circuit breaker, AbortController-based cron timeouts, and expanded stale-data monitoring.

**Tech Stack:** TypeScript, Vitest, Cloudflare Workers D1, TanStack Query, React

**Design doc:** `docs/plans/2026-03-02-three-phase-refinement-design.md`

---

## Phase 1: API Handler Consolidation

### Task 1: Add shared response utilities to api-utils.ts

**Files:**
- Modify: `worker/src/lib/api-utils.ts` (add 3 new exports after line 117)
- Test: `worker/src/lib/__tests__/api-utils.test.ts` (new)

**Step 1: Write tests for the three new utilities**

Create `worker/src/lib/__tests__/api-utils.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { errorResponse, parseIntParam, jsonResponse } from "../api-utils";

describe("errorResponse", () => {
  it("returns JSON error with given status", async () => {
    const res = errorResponse(400, "Bad request");
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = await res.json();
    expect(body).toEqual({ error: "Bad request" });
  });

  it("returns 503 for service unavailable", async () => {
    const res = errorResponse(503, "Data not yet available");
    expect(res.status).toBe(503);
  });
});

describe("parseIntParam", () => {
  it("returns default for null input", () => {
    expect(parseIntParam(null, 100, 1, 1000)).toBe(100);
  });

  it("returns default for undefined input", () => {
    expect(parseIntParam(undefined, 50, 1, 500)).toBe(50);
  });

  it("parses valid integer", () => {
    expect(parseIntParam("25", 100, 1, 1000)).toBe(25);
  });

  it("clamps below min", () => {
    expect(parseIntParam("-5", 100, 0, 1000)).toBe(0);
  });

  it("clamps above max", () => {
    expect(parseIntParam("9999", 100, 1, 500)).toBe(500);
  });

  it("returns default for NaN input", () => {
    expect(parseIntParam("abc", 100, 1, 1000)).toBe(100);
  });

  it("returns default for empty string", () => {
    expect(parseIntParam("", 100, 1, 1000)).toBe(100);
  });
});

describe("jsonResponse", () => {
  it("returns JSON with default headers", async () => {
    const res = jsonResponse({ ok: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("merges custom headers", async () => {
    const res = jsonResponse({ ok: true }, { "Cache-Control": "no-store" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- worker/src/lib/__tests__/api-utils.test.ts
```

Expected: FAIL — `errorResponse`, `parseIntParam`, `jsonResponse` not exported from `api-utils`.

**Step 3: Add the three utilities to api-utils.ts**

Add after the `isValidStablecoinId` function (after line 122 in `worker/src/lib/api-utils.ts`):

```ts
// --- Shared response builders ---

/** Build a JSON error response. Replaces inline `new Response(JSON.stringify({ error }), ...)` calls. */
export function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Parse an integer query parameter with default, min, and max bounds. */
export function parseIntParam(
  value: string | null | undefined,
  defaultVal: number,
  min: number,
  max: number,
): number {
  if (value == null) return defaultVal;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultVal : Math.min(max, Math.max(min, parsed));
}

/** Build a JSON success response with optional extra headers. */
export function jsonResponse(body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...headers },
  });
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- worker/src/lib/__tests__/api-utils.test.ts
```

Expected: PASS (all 9 tests).

**Step 5: Commit**

```bash
git add worker/src/lib/api-utils.ts worker/src/lib/__tests__/api-utils.test.ts
git commit -m "feat(worker): add errorResponse, parseIntParam, jsonResponse utilities"
```

---

### Task 2: Write regression snapshot test

**Files:**
- Create: `worker/src/api/__tests__/snapshot-responses.test.ts`

This test calls every handler with mock D1 and captures `{ status }` for each. It proves the refactoring in Task 3 doesn't change observable behavior.

**Step 1: Write the snapshot test**

Create `worker/src/api/__tests__/snapshot-responses.test.ts`. This test imports every handler and calls it with a generic mock D1 that returns empty results for any query. It captures the HTTP status code for each handler under "no data" conditions.

```ts
import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";

/**
 * Regression snapshot: captures HTTP status for every handler under "no data" conditions.
 * Run BEFORE and AFTER mechanical refactoring to prove behavioral equivalence.
 * Will be retired once comprehensive tests (Phase 2) supersede this.
 */

// Cache-passthrough handlers (expect 503 when cache is empty)
import { handleStablecoins } from "../stablecoins";
import { handleStablecoinCharts } from "../stablecoin-charts";
import { handleUsdsStatus } from "../usds-status";
import { handleBluechipRatings } from "../bluechip";

// Query handlers (expect 200 with empty results)
import { handleBlacklist } from "../blacklist";
import { handleDepegEvents } from "../depeg-events";
import { handleSupplyHistory } from "../supply-history";
import { handleDexLiquidityHistory } from "../dex-liquidity-history";
import { handleYieldHistory } from "../yield-history";
import { handleDigestArchive } from "../digest-archive";

// Computed handlers
import { handleStabilityIndex } from "../stability-index";
import { handleStressSignals } from "../stress-signals";
import { handleHealth } from "../health";

const emptyDb = mockD1();

describe("handler regression snapshots", () => {
  describe("cache-passthrough handlers return 503 when cache is empty", () => {
    it.each([
      ["stablecoins", () => handleStablecoins(emptyDb)],
      ["stablecoin-charts", () => handleStablecoinCharts(emptyDb)],
      ["usds-status", () => handleUsdsStatus(emptyDb)],
      ["bluechip", () => handleBluechipRatings(emptyDb)],
    ])("%s", async (_name, call) => {
      const res = await call();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toHaveProperty("error");
    });
  });

  describe("paginated handlers return 200 with empty results", () => {
    it.each([
      ["blacklist", () => handleBlacklist(emptyDb, new URL("https://x/api/blacklist"))],
      ["depeg-events", () => handleDepegEvents(emptyDb, new URL("https://x/api/depeg-events"))],
      ["supply-history", () => handleSupplyHistory(emptyDb, new URL("https://x/api/supply-history?stablecoin=1"))],
      ["dex-liquidity-history", () => handleDexLiquidityHistory(emptyDb, new URL("https://x/api/dex-liquidity-history?stablecoin=1"))],
    ])("%s", async (_name, call) => {
      const res = await call();
      expect(res.status).toBe(200);
    });
  });

  describe("computed handlers return valid responses", () => {
    it("health returns 200", async () => {
      const res = await handleHealth(emptyDb);
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string };
      expect(["healthy", "degraded", "stale"]).toContain(body.status);
    });
  });
});
```

> **Note:** Not every handler can be tested with an empty DB (some require specific cache keys). Focus on the handlers that will be mechanically refactored. Expand this file as needed to cover more handlers — the goal is coverage of the refactoring surface, not exhaustive testing (that's Phase 2).

**Step 2: Run to verify all pass (baseline)**

```bash
npm test -- worker/src/api/__tests__/snapshot-responses.test.ts
```

Expected: PASS. This is the baseline. Any failure after Task 3 indicates a regression.

**Step 3: Commit**

```bash
git add worker/src/api/__tests__/snapshot-responses.test.ts
git commit -m "test(worker): add regression snapshot for handler refactoring"
```

---

### Task 3: Mechanically replace inline patterns across all handlers

**Files:**
- Modify: All 32 files in `worker/src/api/` (except `__tests__/` directory)

This is the largest task. Each file gets the same mechanical treatment:

1. Add `errorResponse` and/or `parseIntParam` to the import from `../lib/api-utils`
2. Replace `new Response(JSON.stringify({ error: "..." }), { status: N, headers: { "Content-Type": "application/json" } })` with `errorResponse(N, "...")`
3. Replace inline `parseInt(...) || default` + `Math.min/Math.max` chains with `parseIntParam(...)`
4. Optionally replace success `new Response(JSON.stringify(body), { headers })` with `jsonResponse(body, headers)` where it reduces boilerplate

**Example: `blacklist.ts` before → after**

Before (lines 12-13):
```ts
const rawLimit = params.get("limit");
const limit = rawLimit !== null ? Math.min(Math.max(parseInt(rawLimit, 10) || 0, 0), 5000) : 0;
```

After:
```ts
const limit = parseIntParam(params.get("limit"), 0, 0, 5000);
```

Before (lines 23-25):
```ts
return new Response(JSON.stringify({ error: "Invalid stablecoin ID" }), {
  status: 400, headers: { "Content-Type": "application/json" },
});
```

After:
```ts
return errorResponse(400, "Invalid stablecoin ID");
```

**Processing order:** Work through handlers alphabetically. For each file:
1. Add needed imports (`errorResponse`, `parseIntParam`, `jsonResponse`)
2. Replace all inline error responses
3. Replace all inline param parsing
4. Save and move to next file

**Do NOT change:**
- Response body shapes (field names, nesting)
- Status codes (keep existing 400/404/503 as-is)
- Handler signatures
- Business logic
- `createCacheHandler` handlers (stablecoins, stablecoin-charts, usds-status, bluechip) — these already use a factory and have no inline patterns to replace

**Step 1: Refactor all handlers**

Process all files. This is mechanical — grep for `new Response(JSON.stringify({ error:` in each file and replace. Also replace param parsing patterns.

**Step 2: Run snapshot + existing tests + type-check**

```bash
npm test -- worker/src/api/__tests__/snapshot-responses.test.ts && npm test && cd worker && npx tsc --noEmit && cd ..
```

Expected: All pass. If any snapshot test fails, the refactoring changed observable behavior — fix before proceeding.

**Step 3: Run lint**

```bash
npm run lint
```

Expected: No new errors (unused imports, etc.).

**Step 4: Commit**

```bash
git add worker/src/api/
git commit -m "refactor(worker): replace inline error/param patterns with shared utilities

Mechanical replacement across all API handlers:
- errorResponse() replaces 37 inline JSON error constructors
- parseIntParam() replaces 5+ varied parseInt+clamp patterns
- jsonResponse() replaces common success response constructors

Zero behavioral changes — validated by regression snapshot test."
```

---

### Task 4: Document cache-miss rules

**Files:**
- Modify: `docs/api-reference.md`

**Step 1: Add cache-miss standardization section**

Add a section near the top of `docs/api-reference.md` (after the overview, before individual endpoints):

```markdown
## Error Response Conventions

All error responses use `{ "error": "message" }` JSON format.

| Status | Meaning | When |
|--------|---------|------|
| 400 | Bad Request | Invalid query parameter (unknown stablecoin ID, invalid enum value) |
| 401 | Unauthorized | Admin endpoint called without valid `X-Admin-Key` header |
| 404 | Not Found | Valid ID format but resource doesn't exist (e.g., unknown stablecoin in detail endpoint) |
| 429 | Too Many Requests | Rate limit exceeded (feedback endpoint) |
| 500 | Internal Server Error | Unhandled exception (caught by `withErrorHandler`) |
| 503 | Service Unavailable | Cache-passthrough endpoint where cache has never been populated |

**Rule:** Cache-passthrough handlers return **503** when data hasn't been populated yet. Query handlers that find no matching rows return **200** with empty results (e.g., `{ events: [], total: 0 }`).
```

**Step 2: Commit**

```bash
git add docs/api-reference.md
git commit -m "docs: add error response conventions to API reference"
```

---

## Phase 2: Comprehensive Worker Test Suite

### Task 5: Expand test infrastructure

**Files:**
- Modify: `worker/src/api/__tests__/helpers/mock-d1.ts` (add batch support)
- Create: `worker/src/api/__tests__/helpers/mock-fetch.ts`
- Create: `worker/src/api/__tests__/helpers/fixtures.ts`

**Step 1: Add `db.batch()` support to mock-d1.ts**

The current `mockD1` returns `[]` for `batch()`. Cron tests need per-statement results.

Replace line 44 in `mock-d1.ts`:

```ts
batch: async () => [],
```

With:

```ts
batch: async (stmts: { all: () => Promise<unknown>; first: () => Promise<unknown> }[]) => {
  // Execute each statement and return per-statement results
  const results = [];
  for (const s of stmts) {
    results.push(await s.all());
  }
  return results;
},
```

**Step 2: Create mockFetch helper**

Create `worker/src/api/__tests__/helpers/mock-fetch.ts`:

```ts
import { vi } from "vitest";

interface MockRoute {
  /** URL substring to match */
  match: string;
  /** Response body (will be JSON.stringified if object) */
  body: unknown;
  /** HTTP status (default 200) */
  status?: number;
  /** Response headers */
  headers?: Record<string, string>;
}

/**
 * Installs a mock global fetch that returns canned responses based on URL matching.
 * Unmatched URLs return 404.
 * Returns a spy for assertion.
 */
export function mockFetch(routes: MockRoute[] = []): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (input: string | Request) => {
    const url = typeof input === "string" ? input : input.url;
    const route = routes.find((r) => url.includes(r.match));
    if (!route) {
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    }
    const body = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    return new Response(body, {
      status: route.status ?? 200,
      headers: { "Content-Type": "application/json", ...route.headers },
    });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}
```

**Step 3: Create shared fixtures**

Create `worker/src/api/__tests__/helpers/fixtures.ts`:

```ts
/** Factory for a minimal stablecoin asset (DefiLlama shape) */
export function makeAsset(overrides: Partial<{
  id: string; name: string; symbol: string; price: number;
  pegType: string; circulating: Record<string, number>;
  chainCirculating: Record<string, { current: Record<string, number> }>;
}> = {}) {
  return {
    id: overrides.id ?? "1",
    name: overrides.name ?? "Tether",
    symbol: overrides.symbol ?? "USDT",
    price: overrides.price ?? 1.0,
    pegType: overrides.pegType ?? "peggedUSD",
    circulating: overrides.circulating ?? { peggedUSD: 100_000_000 },
    chainCirculating: overrides.chainCirculating ?? {
      Ethereum: { current: { peggedUSD: 50_000_000 } },
    },
  };
}

/** Factory for a blacklist event row (D1 shape) */
export function makeBlacklistRow(overrides: Partial<{
  id: string; stablecoin: string; chain_id: string; chain_name: string;
  event_type: string; address: string; amount: number | null;
  tx_hash: string; block_number: number; timestamp: number;
  explorer_tx_url: string; explorer_address_url: string;
}> = {}) {
  return {
    id: overrides.id ?? "bl-1",
    stablecoin: overrides.stablecoin ?? "1",
    chain_id: overrides.chain_id ?? "ethereum",
    chain_name: overrides.chain_name ?? "Ethereum",
    event_type: overrides.event_type ?? "blacklist",
    address: overrides.address ?? "0xabc123",
    amount: overrides.amount ?? 1000,
    tx_hash: overrides.tx_hash ?? "0xtx1",
    block_number: overrides.block_number ?? 19000000,
    timestamp: overrides.timestamp ?? Math.floor(Date.now() / 1000) - 3600,
    explorer_tx_url: overrides.explorer_tx_url ?? "https://etherscan.io/tx/0xtx1",
    explorer_address_url: overrides.explorer_address_url ?? "https://etherscan.io/address/0xabc123",
  };
}

/** Factory for a depeg event row (D1 shape) */
export function makeDepegRow(overrides: Partial<{
  id: number; stablecoin_id: string; symbol: string; peg_type: string;
  direction: string; peak_deviation_bps: number; started_at: number;
  start_price: number; peak_price: number; peg_reference: number;
  recovery_price: number | null; ended_at: number | null; source: string;
}> = {}) {
  return {
    id: overrides.id ?? 1,
    stablecoin_id: overrides.stablecoin_id ?? "1",
    symbol: overrides.symbol ?? "USDT",
    peg_type: overrides.peg_type ?? "peggedUSD",
    direction: overrides.direction ?? "below",
    peak_deviation_bps: overrides.peak_deviation_bps ?? -200,
    started_at: overrides.started_at ?? Math.floor(Date.now() / 1000) - 7200,
    start_price: overrides.start_price ?? 0.98,
    peak_price: overrides.peak_price ?? 0.97,
    peg_reference: overrides.peg_reference ?? 1.0,
    recovery_price: overrides.recovery_price ?? null,
    ended_at: overrides.ended_at ?? null,
    source: overrides.source ?? "live",
  };
}

/** Factory for a supply history row (D1 shape) */
export function makeSupplyRow(overrides: Partial<{
  stablecoin_id: string; snapshot_date: number;
  circulating_usd: number; price: number | null;
}> = {}) {
  return {
    stablecoin_id: overrides.stablecoin_id ?? "1",
    snapshot_date: overrides.snapshot_date ?? Math.floor(Date.now() / 1000) - 86400,
    circulating_usd: overrides.circulating_usd ?? 100_000_000,
    price: overrides.price ?? 1.0,
  };
}

/** Factory for a mint/burn event row (D1 shape) */
export function makeMintBurnRow(overrides: Partial<{
  id: string; stablecoin_id: string; symbol: string; chain_id: string;
  direction: string; amount: number; amount_usd: number;
  counterparty: string; tx_hash: string; block_number: number;
  timestamp: number; explorer_tx_url: string;
}> = {}) {
  return {
    id: overrides.id ?? "mb-1",
    stablecoin_id: overrides.stablecoin_id ?? "1",
    symbol: overrides.symbol ?? "USDT",
    chain_id: overrides.chain_id ?? "ethereum",
    direction: overrides.direction ?? "mint",
    amount: overrides.amount ?? 1_000_000,
    amount_usd: overrides.amount_usd ?? 1_000_000,
    counterparty: overrides.counterparty ?? "0x000...000",
    tx_hash: overrides.tx_hash ?? "0xtx1",
    block_number: overrides.block_number ?? 19000000,
    timestamp: overrides.timestamp ?? Math.floor(Date.now() / 1000) - 3600,
    explorer_tx_url: overrides.explorer_tx_url ?? "https://etherscan.io/tx/0xtx1",
  };
}
```

**Step 4: Run existing tests to verify nothing broke**

```bash
npm test
```

Expected: PASS.

**Step 5: Commit**

```bash
git add worker/src/api/__tests__/helpers/
git commit -m "test(worker): expand mock-d1 batch support, add mockFetch and fixtures"
```

---

### Task 6: Write API handler contract tests (21 handlers)

**Files:**
- Create: 18 new test files in `worker/src/api/__tests__/` (3 already exist)

This is the largest task. Each test file follows the same pattern. Work through handlers in groups:

**Group A: Paginated endpoints** (5 tests — blacklist, depeg-events, mint-burn-events, supply-history, dex-liquidity-history)

Each follows this pattern:

```ts
import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeBlacklistRow } from "./helpers/fixtures";
import { handleBlacklist } from "../blacklist";

describe("handleBlacklist", () => {
  const row = makeBlacklistRow();
  const db = mockD1([
    { match: "COUNT", rows: [{ total: 1 }] },
    { match: "blacklist_events", rows: [row] },
  ]);

  it("returns 200 with events array", async () => {
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist"));
    expect(res.status).toBe(200);
    const body = await res.json() as { events: unknown[]; total: number };
    expect(body.events).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  it("returns 200 with empty results when no data", async () => {
    const emptyDb = mockD1([
      { match: "COUNT", rows: [{ total: 0 }] },
      { match: "blacklist_events", rows: [] },
    ]);
    const res = await handleBlacklist(emptyDb, new URL("https://x/api/blacklist"));
    expect(res.status).toBe(200);
    const body = await res.json() as { events: unknown[]; total: number };
    expect(body.events).toHaveLength(0);
  });

  it("rejects invalid stablecoin ID with 400", async () => {
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist?stablecoin=<script>"));
    expect(res.status).toBe(400);
  });

  it("includes X-Data-Age header", async () => {
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist"));
    expect(res.headers.has("X-Data-Age")).toBe(true);
  });
});
```

**Group B: Cache-passthrough endpoints** (4 tests — stablecoins, stablecoin-charts, usds-status, bluechip)

Pattern: cache hit → 200 + `_meta`, cache miss → 503.

**Group C: Scoring/computed endpoints** (5 tests — report-cards, peg-summary, stablecoin-detail, dex-liquidity, stress-signals [expand existing])

Pattern: mock cache with realistic JSON, validate response shape.

**Group D: Remaining endpoints** (7 tests — yield-rankings, yield-history, digest-archive, digest-snapshot, health, status, feedback)

Pattern: endpoint-specific tests per the design doc.

**Step 1: Write all 18 new test files**

Work through groups A→D. Each file should be self-contained: imports, mock data, 3-5 `it()` blocks.

**Step 2: Run all tests**

```bash
npm test
```

Expected: All pass (existing + new).

**Step 3: Commit per group**

```bash
git commit -m "test(worker): add contract tests for paginated API handlers"
git commit -m "test(worker): add contract tests for cache-passthrough handlers"
git commit -m "test(worker): add contract tests for scoring/computed handlers"
git commit -m "test(worker): add contract tests for remaining API handlers"
```

---

### Task 7: Write cron tests with degraded-mode scenarios (8 crons)

**Files:**
- Create: 6 new test files in `worker/src/cron/__tests__/` (2 already exist)
- Modify: 2 existing test files (expand `detect-depegs.test.ts`, `enrich-prices.test.ts`)

Each cron test follows the established pattern from `detect-depegs.test.ts`:
1. `vi.mock()` external dependencies (stablecoin list, peg rates, supply helpers)
2. `vi.useFakeTimers()` for deterministic time
3. Spy on `db.prepare()` to capture SQL statements
4. Test normal path + at least one degraded-mode scenario

**Priority order:**

1. `sync-stablecoins.test.ts` — Most critical. Test DL fetch, validation, CG fallback, staleness detection. Degraded: DL+CG both fail.
2. `snapshot-supply.test.ts` — Test supply INSERT, <80% warning. Degraded: stalecoins cache missing.
3. `sync-dex-liquidity.test.ts` — Test orchestrator, connection release. Degraded: all sources fail.
4. `sync-blacklist.test.ts` — Test EVM logs, budget tracking. Degraded: Etherscan 429.
5. `sync-mint-burn.test.ts` — Test event parsing, block range cap. Degraded: per-contract error isolation.
6. `sync-yield-data.test.ts` — Test normal + T-bill fallback. Degraded: missing DEX data.
7. Expand `enrich-prices.test.ts` — Add 4-pass pipeline test, circuit breaker per source. Degraded: all sources fail.
8. `sync-fx-rates.test.ts` — Test FX + commodity rates. Degraded: API failure → cached rates preserved.

**Key pattern for degraded-mode tests:**

```ts
it("falls back to CG supply when DL circuit is open", async () => {
  // Mock circuit breaker returning false for DL
  vi.mocked(shouldAttemptFetch).mockResolvedValueOnce(false);

  // Mock CG data
  fetchSpy.mockImplementation(async (url: string) => {
    if (url.includes("coingecko")) return new Response(JSON.stringify(cgData));
    return new Response("", { status: 500 });
  });

  await syncStablecoins(db, null);

  // Verify cache was written with CG data
  const cacheWrites = preparedSqls.filter(s => s.includes("INSERT") && s.includes("cache"));
  expect(cacheWrites.length).toBeGreaterThan(0);
});
```

**Step 1: Write all 6 new + expand 2 existing test files**

**Step 2: Run all tests**

```bash
npm test
```

Expected: All pass.

**Step 3: Commit per batch**

```bash
git commit -m "test(worker): add sync-stablecoins cron tests with CG fallback scenarios"
git commit -m "test(worker): add snapshot-supply and sync-fx-rates cron tests"
git commit -m "test(worker): add sync-dex-liquidity and sync-yield-data cron tests"
git commit -m "test(worker): add sync-blacklist and sync-mint-burn cron tests"
git commit -m "test(worker): expand enrich-prices tests with full pipeline + degraded mode"
```

---

### Task 8: Raise coverage threshold and retire snapshot test

**Files:**
- Modify: `vitest.config.ts` (line 9: change threshold from 20 to 50)
- Delete: `worker/src/api/__tests__/snapshot-responses.test.ts` (superseded)

**Step 1: Update coverage threshold**

In `vitest.config.ts`, change:

```ts
thresholds: {
  lines: 20,
},
```

To:

```ts
thresholds: {
  lines: 50,
},
```

**Step 2: Delete snapshot test**

Remove `worker/src/api/__tests__/snapshot-responses.test.ts` — the comprehensive tests now cover every handler individually.

**Step 3: Run full test suite with coverage**

```bash
npm test -- --coverage
```

Expected: All pass, coverage ≥50%.

**Step 4: Commit**

```bash
git rm worker/src/api/__tests__/snapshot-responses.test.ts
git add vitest.config.ts
git commit -m "test: raise coverage threshold to 50%, retire regression snapshot"
```

---

### Task 9: Update testing documentation

**Files:**
- Modify: `docs/testing.md`

**Step 1: Update test inventory and conventions**

Add to `docs/testing.md`:
- New test file inventory (all 29 files)
- Degraded-mode testing convention: "Every cron test includes at least one upstream-down and one stale-cache scenario"
- `mockFetch()` helper documentation
- Shared fixtures documentation
- Coverage threshold change (20% → 50%)

**Step 2: Commit**

```bash
git add docs/testing.md
git commit -m "docs: update testing guide with Phase 2 inventory and conventions"
```

---

## Phase 3: Resilience Gap Closure

### Task 10: Add Etherscan circuit breaker

**Files:**
- Modify: `worker/src/lib/constants.ts` (line 98: add ETHERSCAN source)
- Modify: `worker/src/index.ts` (lines 230-243: wrap with circuit check)
- Test: `worker/src/lib/__tests__/circuit-breaker.test.ts` (add Etherscan scenario)

**Step 1: Write the test**

Add to existing `worker/src/lib/__tests__/circuit-breaker.test.ts`:

```ts
describe("Etherscan circuit source", () => {
  it("ETHERSCAN source constant exists", () => {
    expect(CIRCUIT_SOURCE.ETHERSCAN).toBe("etherscan");
  });
});
```

**Step 2: Add constant**

In `worker/src/lib/constants.ts`, add after line 97 (`TREASURY_RATES`):

```ts
  ETHERSCAN: "etherscan",
```

**Step 3: Wrap the `3,23,43` cron slot with circuit check**

In `worker/src/index.ts`, replace the `3,23,43` case (lines 230-243) with:

```ts
case "3,23,43 * * * *": {
  const etherscanAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.ETHERSCAN);
  if (!etherscanAllowed) {
    console.warn("[cron] Etherscan circuit open — skipping blacklist + mint/burn sync");
    break;
  }
  const etherscanRL = createRateLimiter(4);
  const etherscanKey = env.ETHERSCAN_API_KEY ?? null;
  const blacklistJob = logCronRun(db, "sync-blacklist", () =>
    syncBlacklist(db, etherscanKey, env.TRONGRID_API_KEY ?? null, env.DRPC_API_KEY ?? null, etherscanRL)
  );
  const mintBurnJob = logCronRun(db, "sync-mint-burn", () =>
    syncMintBurn(db, etherscanKey, etherscanRL)
  );
  ctx.waitUntil(blacklistJob);
  ctx.waitUntil(mintBurnJob);
  // Record outcome: success only if both jobs complete without error
  ctx.waitUntil(
    Promise.allSettled([blacklistJob, mintBurnJob]).then((results) => {
      const allOk = results.every((r) => r.status === "fulfilled");
      return recordOutcome(db, CIRCUIT_SOURCE.ETHERSCAN, allOk);
    })
  );
  break;
}
```

Add needed imports at the top of `index.ts`:

```ts
import { shouldAttemptFetch, recordOutcome } from "./lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "./lib/constants";
```

**Step 4: Run tests + type-check**

```bash
npm test && cd worker && npx tsc --noEmit && cd ..
```

Expected: PASS.

**Step 5: Commit**

```bash
git add worker/src/lib/constants.ts worker/src/index.ts worker/src/lib/__tests__/circuit-breaker.test.ts
git commit -m "feat(worker): add Etherscan circuit breaker for blacklist + mint/burn crons"
```

---

### Task 11: Add AbortController-based per-job cron timeouts

**Files:**
- Modify: `worker/src/lib/db.ts` (modify `logCronRun`, add timeout map)
- Test: `worker/src/lib/__tests__/log-cron-run.test.ts` (new)

**Step 1: Write tests for timeout behavior**

Create `worker/src/lib/__tests__/log-cron-run.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock alerts to avoid actual webhook calls
vi.mock("../alerts", () => ({
  sendAlert: vi.fn().mockResolvedValue(undefined),
}));

import { logCronRun } from "../db";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

describe("logCronRun", () => {
  const db = mockD1([
    { match: "cron_runs", rows: [] },
  ]);

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("passes AbortSignal to the job function", async () => {
    let receivedSignal: AbortSignal | undefined;
    await logCronRun(db, "test-job", async (signal) => {
      receivedSignal = signal;
      return { itemCount: 0 };
    });
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal!.aborted).toBe(false);
  });

  it("aborts signal when job exceeds timeout", async () => {
    const jobPromise = logCronRun(db, "test-job", async (signal) => {
      // Simulate a job that takes longer than the timeout
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
        // Job would normally take 10 minutes
      });
      return { itemCount: 0 };
    });

    // Advance past the default 5-minute timeout
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 100);

    await expect(jobPromise).rejects.toThrow();
  });
});
```

**Step 2: Modify logCronRun to add AbortController + timeout**

In `worker/src/lib/db.ts`, replace the `logCronRun` function (lines 153-207):

```ts
// --- Per-job cron timeout configuration ---

const CRON_TIMEOUT_MS: Record<string, number> = {
  "sync-dex-liquidity": 10 * 60_000,  // 10 min — 150+ pool crawl
  "sync-blacklist":      8 * 60_000,  // 8 min — multi-chain scan + balance enrichment
  "sync-mint-burn":      8 * 60_000,  // 8 min — multi-contract EVM log scan
  "daily-digest":        8 * 60_000,  // 8 min — LLM generation + distribution
};
const DEFAULT_CRON_TIMEOUT_MS = 5 * 60_000; // 5 min baseline

/**
 * Wraps a cron job function with execution logging and timeout.
 * - Creates an AbortController and passes its signal to the job
 * - Aborts after per-job timeout (see CRON_TIMEOUT_MS)
 * - Logs start time, duration, status, and optional item count to cron_runs table
 * - Prunes rows older than 7 days after each insert
 */
export async function logCronRun(
  db: D1Database,
  job: string,
  fn: (signal: AbortSignal) => Promise<CronResult | void>
): Promise<void> {
  const startMs = Date.now();
  const startSec = Math.floor(startMs / 1000);
  const timeoutMs = CRON_TIMEOUT_MS[job] ?? DEFAULT_CRON_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${job} timed out after ${timeoutMs / 1000}s`)), timeoutMs);

  try {
    const result = await fn(controller.signal);
    clearTimeout(timer);
    await db
      .prepare(
        "INSERT INTO cron_runs (job, started_at, duration_ms, status, item_count, metadata) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .bind(
        job,
        startSec,
        Date.now() - startMs,
        "ok",
        result?.itemCount ?? null,
        result?.metadata ?? null
      )
      .run();
  } catch (e) {
    clearTimeout(timer);
    try {
      await db
        .prepare(
          "INSERT INTO cron_runs (job, started_at, duration_ms, status, error) VALUES (?, ?, ?, ?, ?)"
        )
        .bind(job, startSec, Date.now() - startMs, "error", String(e))
        .run();
    } catch (logErr) {
      console.error(`[db] Failed to log cron error for ${job}:`, logErr);
    }
    // Alert on cron failure (non-blocking)
    sendAlert(`Cron failure: ${job}`, `Error: ${String(e).slice(0, 500)}`).catch(() => {});
    throw e;
  }
  // Prune rows older than 7 days
  try {
    await db
      .prepare("DELETE FROM cron_runs WHERE started_at < ?")
      .bind(Math.floor(Date.now() / 1000) - SECONDS.ONE_WEEK)
      .run();
  } catch (e) {
    console.error("[db] Failed to prune old cron runs:", e);
    // Safety valve: if time-based prune fails, keep only most recent 5000 rows
    try {
      await db
        .prepare("DELETE FROM cron_runs WHERE rowid NOT IN (SELECT rowid FROM cron_runs ORDER BY started_at DESC LIMIT 5000)")
        .run();
    } catch (e2) {
      console.error("[db] Safety valve prune also failed:", e2);
    }
  }
}
```

**Step 3: Run tests**

```bash
npm test
```

Expected: PASS. Existing cron tests may need updating since `logCronRun` now passes a signal — but those tests call cron functions directly, not through `logCronRun`, so they should be unaffected.

**Step 4: Commit**

```bash
git add worker/src/lib/db.ts worker/src/lib/__tests__/log-cron-run.test.ts
git commit -m "feat(worker): add AbortController-based per-job cron timeouts

Default 5 min, with overrides:
- sync-dex-liquidity: 10 min (150+ pool crawl)
- sync-blacklist/mint-burn: 8 min (multi-chain scan)
- daily-digest: 8 min (LLM generation)

Signal threaded through to fetchWithRetry for real cancellation."
```

---

### Task 12: Thread AbortSignal through cron functions

**Files:**
- Modify: All cron files that are called via `logCronRun` in `index.ts`

The `logCronRun` signature changed: `fn` now receives `(signal: AbortSignal)`. Update each cron call site in `index.ts` and each cron function signature.

**Step 1: Update index.ts call sites**

Every `logCronRun(db, "job", () => fn(...))` becomes `logCronRun(db, "job", (signal) => fn(..., signal))` where the cron function accepts and uses the signal.

Example for the `*/15` slot:

```ts
const stablecoinsSync = logCronRun(db, "sync-stablecoins", (signal) => syncStablecoins(db, env.CMC_API_KEY, signal));
```

**Step 2: Update each cron function to accept `signal: AbortSignal` as last parameter**

For each cron function, add `signal?: AbortSignal` as the last parameter and thread it through to `fetchWithRetry` calls via `{ signal }` in the opts.

Example for `syncStablecoins` (line 414 in `sync-stablecoins.ts`):

```ts
export async function syncStablecoins(db: D1Database, cmcApiKey?: string, signal?: AbortSignal): Promise<CronResult> {
```

Then in fetch calls within that function:

```ts
fetchWithRetry(`${DEFILLAMA_BASE}/stablecoins?includePrices=true`, { signal })
```

**This is mechanical:** For each of the ~15 cron functions called from `index.ts`:
1. Add `signal?: AbortSignal` parameter
2. Pass `{ signal }` to `fetchWithRetry` calls
3. Update the `index.ts` call site to forward the signal

**Step 3: Run tests + type-check**

```bash
npm test && cd worker && npx tsc --noEmit && cd ..
```

Expected: PASS. The `signal` parameter is optional, so existing direct-call tests still work.

**Step 4: Commit**

```bash
git add worker/src/index.ts worker/src/cron/
git commit -m "feat(worker): thread AbortSignal through all cron functions to fetchWithRetry"
```

---

### Task 13: Expand StaleDataBanner queries on all pages

**Files:**
- Modify: 7 page client files (expand `queries` array in existing `<StaleDataBanner>` or add new one)

**Current state:** Most pages already render `<StaleDataBanner>` with a single query. We expand to include all critical queries per page.

**Step 1: Update each page**

For each page, locate the `<StaleDataBanner>` component and expand its `queries` prop to include all data queries used on that page.

**Homepage** (`src/components/homepage-client.tsx`):
Add `pegSummary`, `reportCards`, `dexLiquidity` queries alongside the existing `stablecoins` query.

**Stablecoin detail** (`src/app/stablecoin/[id]/client.tsx`):
Add `dexLiquidity` and `depegEvents` queries alongside the existing `stablecoins` query.

**Liquidity** (`src/app/liquidity/client.tsx`):
Already has a banner — verify it monitors the `dexLiquidity` query. Expand if it only monitors `stablecoins`.

**Depeg** (`src/app/depeg/client.tsx`):
Already has a banner — verify it monitors the right query.

**Flows** (`src/app/flows/page.tsx`):
Already has a banner — verify coverage.

**Yield** (`src/app/yield/client.tsx`):
Already has a banner — verify it monitors `yieldRankings`.

> **Pattern:** Each page client already has TanStack Query results with `dataUpdatedAt`. Expanding the `queries` array is purely additive.

**Step 2: Run build + type-check**

```bash
npm run build
```

Expected: PASS.

**Step 3: Commit**

```bash
git add src/components/homepage-client.tsx src/app/stablecoin/*/client.tsx src/app/liquidity/client.tsx src/app/depeg/client.tsx src/app/flows/page.tsx src/app/yield/client.tsx
git commit -m "feat(ui): expand stale-data-banner to monitor all critical queries per page"
```

---

### Task 14: Run full test suite and type-check

**Step 1: Run everything**

```bash
npm test && npm run lint && npm run build && cd worker && npx tsc --noEmit && cd ..
```

Expected: All pass.

**Step 2: If any failures, fix and re-run**

---

### Task 15: Update documentation

**Files:**
- Modify: `docs/worker-infrastructure.md`
- Modify: `docs/data-pipeline.md`
- Modify: `docs/testing.md` (if not already updated in Task 9)

**Step 1: Update worker-infrastructure.md**

Add Etherscan to circuit breaker source list. Document per-job timeout map with the values:

| Job | Timeout | Reason |
|-----|---------|--------|
| Default | 5 min | Standard jobs complete in <60s |
| sync-dex-liquidity | 10 min | 150+ pool crawl |
| sync-blacklist | 8 min | Multi-chain scan + balance enrichment |
| sync-mint-burn | 8 min | Multi-contract EVM log scan |
| daily-digest | 8 min | LLM generation + distribution |

**Step 2: Update data-pipeline.md**

Document expanded stale-data monitoring per page.

**Step 3: Commit**

```bash
git add docs/
git commit -m "docs: update worker-infrastructure and data-pipeline for Phase 3 changes"
```

---

## Verification Checklist

After all 15 tasks:

- [ ] `npm test` — all pass
- [ ] `npm test -- --coverage` — ≥50% lines
- [ ] `npm run lint` — no errors
- [ ] `npm run build` — static export succeeds
- [ ] `cd worker && npx tsc --noEmit` — worker types clean
- [ ] Phase 1 utilities (`errorResponse`, `parseIntParam`, `jsonResponse`) used across all handlers
- [ ] Phase 2 tests cover all 21 public handlers + 8 cron jobs with degraded scenarios
- [ ] Phase 3: Etherscan circuit breaker active, per-job timeouts with AbortController, stale banner expanded
- [ ] All docs updated (api-reference, testing, worker-infrastructure, data-pipeline)
