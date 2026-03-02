# Three-Phase Refinement: Consolidation → Tests → Resilience

**Date:** 2026-03-02
**Status:** Design approved, pending implementation plan

## Motivation

Pharos tracks ~145 stablecoins across a static Next.js frontend and a Cloudflare Worker data pipeline. The core algorithms (PSI, DEWS, report cards, peg scoring) are well-tested and type-safe. But three structural gaps compound risk as the project grows:

1. **API handler boilerplate** — 37 copy-pasted error response builders, 5+ inconsistent parameter parsing patterns, varied cache-miss behavior across 32 handlers. Each new endpoint copies patterns from existing handlers and hopes for the best.
2. **Pipeline test coverage** — 91% of API handlers and 89% of cron jobs have zero tests. The algorithms they invoke are tested, but the pipeline connecting external APIs → D1 → JSON responses is not.
3. **Resilience gaps** — Circuit breakers protect 7 data sources but not Etherscan. Cron jobs have no per-job timeouts. The frontend computes `meta.status` (fresh/degraded/stale) but never displays it beyond a single top-level query.

These three are implemented in dependency order: consolidation makes testing easier, testing validates resilience paths, resilience prevents the data issues that tests catch.

---

## Phase 1: API Handler Consolidation

### Goal

Extract shared utilities into `worker/src/lib/api-utils.ts`, then mechanically replace inline patterns across all 32 handlers. Net reduction: ~150-200 lines of boilerplate. Zero API behavior changes.

### New utilities

#### `errorResponse(status, message)`

Replaces 37 inline `new Response(JSON.stringify({ error: ... }))` calls.

```ts
export function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
```

#### `parseIntParam(value, defaultVal, min, max)`

Unifies 5+ different parameter parsing patterns (limit, offset, days, hours) that currently use varied defaults, bounds, and NaN handling.

```ts
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
```

#### `jsonResponse(body, headers?)`

Standardizes success response creation.

```ts
export function jsonResponse(
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...headers },
  });
}
```

### Cache-miss standardization

Document and enforce:
- **503** — Cache-passthrough handlers when cache key has never been populated ("Data not yet available")
- **200 + empty results** — Query handlers that find no matching rows (`{ events: [], total: 0 }`)
- **404** — Invalid resource IDs only (e.g., unknown stablecoin ID in detail endpoint)

### What we don't touch

- Router structure (40 if-statements in `router.ts` — explicit, works fine)
- `buildPaginatedQuery()` (already extracted)
- `createCacheHandler()` (already clean)
- `withErrorHandler()` (already clean)
- Handler signatures and response shapes (no breaking API changes)

### Regression gate

Phase 1 refactors 32 handlers before Phase 2 writes full tests. To prove behavioral equivalence:

1. **Before refactoring:** Write a lightweight snapshot script (`worker/src/api/__tests__/snapshot-responses.test.ts`) that calls every handler with mock D1 + known params, captures `{ status, bodyShape }` for each.
2. **After refactoring:** Re-run the snapshot test. Any shape or status code difference fails the test.
3. **Retire after Phase 2:** Once comprehensive tests exist, the snapshot test is superseded.

The snapshot test uses the existing `mockD1()` helper with generic canned rows. It doesn't validate business logic — just proves the refactoring didn't change observable behavior.

### Diff estimate

~32 files touched, each change mechanical. The snapshot test adds 1 file (~200 lines) that validates the entire surface.

---

## Phase 2: Comprehensive Worker Test Suite

### Goal

Test all 21 public API handlers + all 8 crons that touch external APIs. ~29 new test files. Coverage target: raise minimum from 20% to 50% lines.

### Test patterns (established conventions)

All tests follow patterns documented in `docs/testing.md` and demonstrated in existing test files:

- **API contract tests:** Mock D1 with canned rows via `mockD1()`, call handler directly with `(db, url)`, assert HTTP status + response shape. Validate against Zod schemas where they exist.
- **Cron tests:** `vi.mock()` dependencies (stablecoin lists, peg rates, supply helpers), `vi.useFakeTimers()`, spy on `db.prepare()` to capture SQL statements, assert INSERT/UPDATE/DELETE operations.
- **Degraded-mode tests:** Every cron test file includes at least one "upstream is down" scenario and one "stale/corrupt cache" scenario. This ensures Phase 3's resilience changes are covered by tests before we modify the code.

### API handler tests (21 new files)

#### Paginated endpoints (5)

`blacklist`, `depeg-events`, `mint-burn-events`, `supply-history`, `dex-liquidity-history`

Each test covers:
- Default pagination (no params) → 200 + results
- Custom limit/offset with clamping (uses Phase 1's `parseIntParam`)
- Filter params (stablecoin, chain, eventType, active)
- Empty results → 200 + empty array (not 404)
- Response includes `total` count
- Freshness headers present (`X-Data-Age`)

#### Scoring/computed endpoints (5)

`report-cards`, `peg-summary`, `stablecoin-detail`, `dex-liquidity`, `stress-signals` (already tested — verify or expand)

Each test covers:
- Normal response shape with realistic canned data
- Missing cache → 503 for cache-passthrough, graceful degradation for computed
- Zod schema alignment (`schema.safeParse(body)`) where schemas exist
- Edge cases: unknown stablecoin ID → 400/404

#### Cache-passthrough endpoints (4)

`stablecoins`, `stablecoin-charts`, `usds-status`, `bluechip`

Each test covers:
- Cache hit → 200 with `_meta` injected (object responses)
- Cache miss → 503 "Data not yet available"
- Freshness headers: `X-Data-Age` present, `Warning` header when stale

#### Remaining endpoints (7)

`yield-rankings`, `yield-history`, `digest-archive`, `digest-snapshot`, `health`, `status`, `feedback`

Key tests:
- `health`: degraded/stale status based on cache ages and circuit states
- `status`: cron run history aggregation, data quality metrics
- `feedback`: POST body validation, rate limiting (429 on excess)
- `yield-history`: required `?stablecoin=` param → 400 when missing

### Cron tests (8 new files)

#### sync-stablecoins (highest priority)

- Normal DL fetch → structural validation (MIN_VALID_ASSET_COUNT), price bounds, cache write via `setCacheIfNewer`
- DL circuit open → CG fallback activates, fallback data meets min asset threshold
- DL returns malformed data → rejects, doesn't overwrite cache
- Staleness detection → >95% identical prices logs warning
- **Degraded:** DL + CG both fail → no cache write, error logged, alert fired

#### snapshot-supply

- Normal path → INSERT INTO supply_history with correct snapshot_date
- <80% valid data → warning logged, still saves
- **Degraded:** Stablecoins cache missing → graceful skip

#### sync-dex-liquidity orchestrator

- Connection release pattern (consume DL bodies before Curve batch)
- DL yields circuit open → CG/GT as primary source
- Budget exhaustion → stops gracefully
- **Degraded:** All pool sources fail → scores degrade to null, no crash

#### sync-blacklist

- EVM log fetching with budget tracking
- Tron balance enrichment
- Budget exhaustion → early exit, sync state not advanced
- **Degraded:** Etherscan 429 → rate limiter backs off, partial progress saved

#### sync-mint-burn

- Event parsing from EVM logs
- Block range capping (MAX_SCAN_RANGE)
- Price enrichment from cache
- Hourly aggregation recalculation
- **Degraded:** API error on one contract → that contract skipped, others proceed

#### sync-yield-data

- Normal path with DEX data available
- **Degraded:** Missing DEX data → graceful degradation
- T-bill rate fallback (RISK_FREE_RATE_FALLBACK = 4.25)

#### enrich-prices (expand existing)

- Full 4-pass pipeline (DL → CG → CMC → DexScreener)
- Circuit breaker integration per source
- **Degraded:** All sources fail → 24h price cache fallback used

#### sync-fx-rates

- Normal FX rate fetch + commodity rates
- **Degraded:** API failure → previous cached rates preserved, no overwrite

### Test infrastructure additions

- **Expand `mock-d1.ts`:** Support `db.batch()` returning per-statement results (currently returns `[]`). Needed for crons that batch-query sync states.
- **Add `mockFetch()` helper:** For cron tests mocking external API responses. Intercepts global `fetch` with pattern-matched responses.
- **Shared fixtures:** Common data shapes (stablecoin asset, depeg event row, blacklist row, mint-burn row) as factory functions following the `mockCoin()` pattern.

---

## Phase 3: Resilience Gap Closure

### Goal

Close three specific gaps in the existing resilience infrastructure. Architecture is already built — this is coverage, not design.

### Gap A: Etherscan circuit breaker

Both `sync-blacklist` and `sync-mint-burn` share an Etherscan API key and rate limiter. They should share one circuit breaker for the source.

**Implementation:**

1. Add `CIRCUIT_SOURCE.ETHERSCAN = "etherscan"` to source constants
2. In the `3,23,43` cron slot in `index.ts`: check `shouldAttemptFetch(db, "etherscan")` before launching either job
3. Circuit open → skip both jobs, log warning, return early
4. Record outcome after both jobs complete:
   - Both succeed → `recordOutcome(db, "etherscan", true)`
   - Either throws → `recordOutcome(db, "etherscan", false)`
5. Existing thresholds apply: 3 consecutive failures → open, 30-min probe interval

### Gap B: Per-job cron timeouts with AbortController

`Promise.race` alone doesn't cancel the losing promise — a hung fetch keeps consuming connections and CPU. Real cancellation requires `AbortController`.

**Timeout map:**

```ts
const CRON_TIMEOUT_MS: Record<string, number> = {
  "sync-dex-liquidity": 10 * 60_000,  // 10 min — 150+ pool crawl
  "sync-blacklist":      8 * 60_000,  // 8 min — multi-chain scan + balance enrichment
  "sync-mint-burn":      8 * 60_000,  // 8 min — multi-contract EVM log scan
  "daily-digest":        8 * 60_000,  // 8 min — LLM generation + distribution
};
const DEFAULT_TIMEOUT_MS = 5 * 60_000; // 5 min baseline
```

**Implementation:**

Modify `logCronRun` in `worker/src/lib/db.ts` to accept an optional `AbortSignal` and wrap the job with timeout:

```ts
export async function logCronRun(
  db: D1Database,
  jobName: string,
  fn: (signal: AbortSignal) => Promise<CronResult>,
): Promise<void> {
  const timeoutMs = CRON_TIMEOUT_MS[jobName] ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await fn(controller.signal);
    clearTimeout(timer);
    // ... log success
  } catch (err) {
    clearTimeout(timer);
    // ... log error + send alert (timeout errors flow here naturally)
  }
}
```

Each cron function receives the `signal` and passes it through to `fetchWithRetry` (which already accepts `signal` via `RequestInit`). When the timeout fires:
1. `controller.abort()` cancels all in-flight fetches
2. The cron function's promise rejects with `AbortError`
3. `logCronRun` catches it, logs the timeout, fires an alert
4. Connections are freed immediately — sibling jobs on the same cron slot can proceed

**Migration:** Update each cron function signature to accept `signal: AbortSignal` as a parameter and thread it through to fetch calls. This is mechanical — `fetchWithRetry` already supports it via `opts.signal`.

### Gap C: Enhanced stale-data-banner

Extend query monitoring on each page. The `StaleDataBanner` component and `StaleQuery` interface are unchanged — we just pass more queries to the existing `queries` prop.

**Current → After:**

| Page | Currently monitors | After |
|------|-------------------|-------|
| Homepage | `stablecoins` | `stablecoins`, `pegSummary`, `reportCards`, `dexLiquidity` |
| Stability Index | `stability-index` | (unchanged) |
| Stablecoin detail | `stablecoins` | `stablecoins`, `dexLiquidity`, `depegEvents` |
| Liquidity | (none) | `dexLiquidity` |
| Depeg tracker | (none) | `depegEvents` |
| Flows | (none) | `mintBurnFlows` |
| Yield | (none) | `yieldRankings` |

**Implementation:** Each page client already has TanStack Query results with `dataUpdatedAt` and `staleTime`. The change is purely wiring — expand the `queries` array in each `<StaleDataBanner>` invocation.

Pages that don't currently render `<StaleDataBanner>` (liquidity, depeg, flows, yield) get one added, following the same pattern as the homepage.

### Documentation updates

- `docs/worker-infrastructure.md`: Add Etherscan to circuit breaker source list, document per-job timeout map
- `docs/data-pipeline.md`: Document expanded stale-data monitoring coverage per page
- `docs/testing.md`: Update with new test file inventory and degraded-mode testing convention

---

## Implementation Order

```
Phase 1: Handler Consolidation
├── 1a. Write regression snapshot test (golden responses for all 32 handlers)
├── 1b. Add errorResponse(), parseIntParam(), jsonResponse() to api-utils.ts
├── 1c. Replace inline patterns across all 32 handlers (mechanical)
├── 1d. Standardize cache-miss behavior (503/200/404 rules)
├── 1e. Run snapshot test + existing tests + type-check + lint
└── 1f. Document cache-miss rules in api-reference.md

Phase 2: Comprehensive Test Suite
├── 2a. Expand mock-d1.ts (batch support), add mockFetch(), add shared fixtures
├── 2b. Write 21 API handler contract tests
├── 2c. Write 8 cron tests (each with degraded-mode scenarios)
├── 2d. Raise coverage threshold from 20% to 50%
├── 2e. Retire Phase 1 snapshot test (superseded by comprehensive tests)
└── 2f. Update docs/testing.md with new inventory

Phase 3: Resilience Gap Closure
├── 3a. Add Etherscan circuit breaker (source constant + cron slot guard)
├── 3b. Add AbortController-based per-job timeouts to logCronRun
├── 3c. Thread signal through all cron functions to fetchWithRetry
├── 3d. Expand StaleDataBanner queries on 7 pages
├── 3e. Run full test suite (Phase 2 tests validate resilience changes)
└── 3f. Update docs (worker-infrastructure, data-pipeline, testing)
```

## Scope boundaries

**In scope:**
- Utility extraction and mechanical replacement (Phase 1)
- Contract tests and degraded-mode tests (Phase 2)
- Circuit breaker, timeouts, banner expansion (Phase 3)
- Documentation updates for all changes

**Out of scope (future work):**
- Router refactoring (route table registry)
- Paginated handler wrapper factory
- Header status dot / persistent health indicator
- Component or hook tests (React testing infrastructure)
- D1 backup strategy
- End-to-end integration tests (full Worker invocation)
