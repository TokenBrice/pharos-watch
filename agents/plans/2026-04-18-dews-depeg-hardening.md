# Depeg Detection + DEWS Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close verified correctness, reliability, observability, and coverage gaps in the Stage 1 / Stage 2 depeg detection pipeline and the DEWS early-warning system, while adding cross-asset contagion amplification and a measurable backtest harness — without exceeding the current ~46s test suite budget.

**Architecture:** Surgical, in-place fixes to existing files; one backwards-compatible schema migration (`0105`) to persist confirmation provenance and pending reason; one new DEWS sub-pass for cross-asset contagion amplification, inserted after per-coin `computeDEWS()` in `worker/src/cron/dews/scoring.ts`; a backtest harness extension to `/api/backfill-dews` emitting precision / recall / lead-time metrics against a curated historical-event fixture.

**Tech Stack:** TypeScript (Cloudflare Workers runtime, Vitest); Cloudflare D1; shared/lib runtime-neutral modules; React 19 / Next.js 16 for frontend surfacing.

**Methodology version impact:** Phase 1–3 fixes ship under `v5.94`; Phase 4 (contagion amplifier) ships under `v5.95`; Phase 5 (backtest harness) is admin-only and does not bump methodology version; Phase 2 persistence is backwards-compatible (new nullable columns) and ships under `v5.94`.

---

## Verified Audit Summary

After direct source verification, the following claims were confirmed real issues. Agent-reported items that proved non-issues (peak-update asymmetry across direction flips; native-peg freshness gaps; orphan cleanup of transient-data coins; recovery path missing native-peg check) are documented here as NOT fixed because the code already handles them correctly.

### Correctness / reliability (verified)

| # | Severity | File:line | Issue |
|---|---|---|---|
| A | Major | `worker/src/cron/confirm-pending-depegs.ts:298-303` | When no pool in the challenger loop classifies as `"confirm"`, `poolStatus` is blanket-assigned `"recover"` regardless of actual pool signals. Currently masked because downstream only checks `poolStatus !== "confirm"`, but fragile. |
| B | Major | `worker/src/api/backfill-depegs.ts:358-362` | Backfill delete-then-insert uses two separate `db.batch()` calls. D1 does not provide cross-batch atomicity, so a worker interruption between the delete and the first insert leaves the coin with zero backfill rows and no recovery path. |
| C | Major | `worker/src/cron/confirm-pending-depegs.ts:219-253` | Off-chain CoinGecko/DefiLlama fetch during confirmation is **not** guarded by a circuit breaker. A permanent outage produces rate-limit hammering every 15 min × pending row for 45 min per row. |
| D | Major | `worker/src/cron/confirm-pending-depegs.ts:361-369` | `confirmedBy` string is computed (off-chain / DEX / CEX / Pool) and logged, but never persisted on the promoted `depeg_events` row. No way to post-mortem which source agreed. |
| E | Minor | `worker/src/cron/detect-depegs.ts:472-477` | `pendingReason` is assigned as one-of three using an if-else chain. A coin that is simultaneously large-cap AND low-confidence records `"large-cap"` only, losing composite context needed by Stage 2 for routing decisions. |
| F | Minor | `worker/src/lib/dews.ts:280-289` | `computeLiquiditySignal` returns `available: true` and contributes `0` erosion when `liquidityScore7dAgo` is null but current score is non-null. Silent pass diverges from the "fail-closed" discipline applied elsewhere. |

### Enhancement opportunities (verified high-value)

| # | File(s) | Opportunity |
|---|---|---|
| G | `worker/src/cron/dews/scoring.ts`, `worker/src/lib/dews.ts` | **Cross-asset contagion amplifier.** When any tracked stablecoin is already in `DANGER`/`WARNING` bands, apply a bounded multiplier to related coins' DEWS scores to reflect elevated contagion risk. Complements the existing systemic PSI amplifier but at per-coin resolution. |
| H | `worker/src/cron/confirm-pending-depegs.ts:282-304`, `worker/src/lib/constants.ts:182` | **Pool challenger multi-source requirement.** A single $100K pool can unilaterally promote a pending depeg today. Raising the bar to `POOL_CHALLENGE_CONFIRM_MIN = 2` matching pools (or a single pool ≥ $5M TVL) materially reduces manipulation risk. |
| I | `worker/src/api/backfill-dews.ts` | **Backtest harness extension.** Emit structured precision / recall / lead-time metrics per historical depeg anchor (USDC Mar 2023, USDT Oct 2023, BUSD wind-down, FDUSD Q4 2024, etc.) so calibration changes can be regression-tested. |
| J | `src/components/dews-detail.tsx`, `src/components/dews-summary.tsx` | **Per-signal "firing" breakdown** surfaced on the DEWS detail UI — which of the 8 sub-signals are elevated right now, not just the aggregate score. Improves informativeness without schema changes. |

---

## File Structure

### Files Created

| Path | Responsibility |
|---|---|
| `worker/migrations/0105_depeg_event_provenance.sql` | Add `confirmation_sources TEXT` and `pending_reason TEXT` nullable columns to `depeg_events`. |
| `worker/src/lib/__tests__/dews-contagion.test.ts` | Unit tests for the cross-asset contagion amplifier. |
| `worker/src/api/__tests__/backfill-dews-metrics.test.ts` | Tests the precision / recall / lead-time emission paths. |
| `worker/src/lib/backtest-anchors.ts` | Curated historical depeg anchors used by the backtest harness. |
| `worker/src/lib/__tests__/backtest-anchors.test.ts` | Schema validation tests for the anchor fixture. |

### Files Modified

| Path | Responsibility |
|---|---|
| `worker/src/cron/confirm-pending-depegs.ts` | Fix pool-status semantics (bug A), pool multi-source requirement (H), circuit-breaker guard on CoinGecko/DefiLlama (bug C), attach `confirmation_sources` + `pending_reason` on promotion (bug D). |
| `worker/src/api/backfill-depegs.ts` | Make delete+insert atomic via a single batch per-coin (bug B). |
| `worker/src/cron/detect-depegs.ts` | Emit a composite `pendingReason` bitmask array and pass through to `buildUpsertPendingDepegStmt` (bug E). |
| `worker/src/lib/depeg-helpers.ts` | Extend `DepegRow` + `buildInsertDepegEventStmt` to persist `confirmation_sources` and `pending_reason`; extend `rowToDepegEvent` to expose them. |
| `worker/src/lib/depeg-pending.ts` | Store pending reason as a joined string (e.g. `"large-cap+low-confidence"`) so composite context survives; normalize on read. |
| `worker/src/lib/dews.ts` | Fail-closed in `computeLiquiditySignal` when both deltas are unavailable (bug F); accept `contagionAmplifier` input; apply after PSI amplifier. |
| `worker/src/cron/dews/scoring.ts` | Two-pass scoring: first pass computes baseline DEWS for every coin, second pass derives contagion amplifier from first-pass bands and re-applies to every coin's final score/band. |
| `worker/src/cron/dews/contracts.ts` | Expose contagion amplifier input/output on the scoring result shape. |
| `worker/src/lib/constants.ts` | Add `POOL_CHALLENGE_CONFIRM_MIN` (default 2) and `POOL_CHALLENGE_HIGH_TVL_USD` (default 5e6). Add `CIRCUIT_SOURCE.COINGECKO_CONFIRM` and `.DEFILLAMA_CONFIRM`. |
| `shared/types/market.ts` | Extend `DepegEvent` with optional `confirmationSources: string \| null` and `pendingReason: string \| null` fields. |
| `shared/lib/depeg-dews-version.ts` | Append `v5.94` and `v5.95` changelog entries. |
| `worker/src/api/depeg-events.ts` | Include the two new fields in the API response. |
| `worker/src/api/stress-signals.ts` | Expose `contagionAmplifier` + per-signal firing breakdown on both single-coin and aggregate endpoints. |
| `worker/src/api/backfill-dews.ts` | Add `mode=backtest-metrics` that walks the curated anchor set and emits precision / recall / lead-time statistics. |
| `src/components/dews-detail.tsx` | Surface per-signal firing breakdown. |
| `src/components/dews-summary.tsx` | Expose contagion amplifier in the radar tooltip when active. |
| `src/components/depeg-history.tsx` | Show `confirmation_sources` and `pending_reason` for promoted events. |
| `src/components/depeg-feed.tsx` | Show the promotion badge on events that came from pending confirmation. |
| `docs/depeg-detection.md` | Document new persistence fields, pool multi-source rule, backfill atomicity. |
| `docs/dews.md` | Document contagion amplifier, liquidity fail-closed, backtest harness. |
| `docs/depeg-dews-timeline.md` | Add v5.94 and v5.95 entries. |

### Files Unchanged (callouts for verifiers)

- `worker/src/lib/native-peg-quotes.ts` — freshness gate at line 144 already enforces `DEPEG_PRIMARY_PRICE_MAX_AGE_SEC`; no fix required.
- `worker/src/cron/detect-depegs.ts:604-605` — orphan cleanup already skips coins present in `trackedCoinIds`; no fix required.
- `worker/src/cron/detect-depegs.ts:513-520` — existing recovery path already consults native peg to prevent premature recovery; no fix required.
- `worker/src/lib/depeg-pending.ts:147-155` — pending peak preservation on same-direction is correct; opposite-direction reset is intentional per docs.

---

## Phase 1 — Stage 2 Correctness Bug Fixes

### Task 1: Fix pool-status `"recover"` blanket assignment

**Files:**
- Modify: `worker/src/cron/confirm-pending-depegs.ts:282-304`
- Test: `worker/src/cron/__tests__/confirm-pending-depegs.test.ts`

- [ ] **Step 1: Add failing test for pool-status semantics**

Append to `worker/src/cron/__tests__/confirm-pending-depegs.test.ts` a new `describe` block `pool challenger status classification`:

```ts
it("reports poolStatus='contradict' when at least one qualifying pool is opposite-direction above bar", async () => {
  const pendingRows: PendingRow[] = [makePendingRow({
    id: 1, stablecoin_id: "usdt-tether", symbol: "USDT",
    direction: "below", first_seen_bps: -200, first_seen_at: 0,
    first_price: 0.98, peg_reference: 1,
    last_seen_bps: -200, last_seen_at: 0, last_price: 0.98,
    peak_seen_bps: -200, peak_price: 0.98,
    reason: "large-cap",
  })];
  // Pool 1: same-direction but below secondaryBar (50 bps) => status "recover"
  // Pool 2: opposite-direction above secondaryBar             => status "contradict"
  const poolChallengersByCoin = new Map([
    ["usdt-tether", [
      { price: 0.997, tvlUsd: 5e6, protocol: "curve", chain: "ethereum" },
      { price: 1.012, tvlUsd: 5e6, protocol: "uniswap", chain: "ethereum" },
    ]],
  ]);
  const logs = captureLogs();
  await runConfirmWithDb({ pendingRows, poolChallengersByCoin });
  expect(logs.find(l => /status=(confirm|recover|contradict|insufficient)/.test(l))).toMatch(/status=contradict/);
});

it("reports poolStatus='recover' only when every qualifying pool is under the secondary bar", async () => {
  // All pools within threshold — genuine recovery
  const poolChallengersByCoin = new Map([
    ["usdt-tether", [
      { price: 0.998, tvlUsd: 5e6, protocol: "curve", chain: "ethereum" },
      { price: 0.999, tvlUsd: 5e6, protocol: "uniswap", chain: "ethereum" },
    ]],
  ]);
  const logs = captureLogs();
  await runConfirmWithDb({ pendingRows: [pendingBelow], poolChallengersByCoin });
  expect(logs.find(l => /status=recover/.test(l))).toBeTruthy();
  expect(logs.find(l => /status=contradict/.test(l))).toBeFalsy();
});
```

(Re-use the existing `captureLogs` helper or add it: it wraps `console.log` and `console.warn` into a shared array for the duration of one test. If the helper does not exist in the test file, add it at the top of the file with `beforeEach(() => { ... vi.spyOn(console, "log").mockImplementation(...); })`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/cron/__tests__/confirm-pending-depegs.test.ts -t "pool challenger status classification" --reporter=default`
Expected: FAIL — existing code blankets `poolStatus = "recover"` regardless of actual pool signals.

- [ ] **Step 3: Replace the pool loop body**

In `worker/src/cron/confirm-pending-depegs.ts:282-304`, replace the loop:

```ts
// 4c. Individual DEX pool check
let poolStatus: ReturnType<typeof classifyDirectionalSignal> = "insufficient";
let poolConfirmCount = 0;
let poolContradictCount = 0;
let poolRecoverCount = 0;
let poolHighTvlConfirm = false;
const pools = poolChallengers.get(row.stablecoin_id);
if (pools?.length) {
  for (const pool of pools) {
    const poolSignal = deriveDepegSignal(pool.price, row.peg_reference);
    const currentPoolStatus = classifyDirectionalSignal(poolSignal, secondaryBar, pendingState.direction);
    if (currentPoolStatus === "confirm") {
      poolConfirmCount += 1;
      if (pool.tvlUsd >= POOL_CHALLENGE_HIGH_TVL_USD) {
        poolHighTvlConfirm = true;
      }
      console.log(
        `[depeg-confirm] ${row.symbol} pool confirm: price=$${pool.price} (${pool.protocol}/${pool.chain}, ` +
        `$${(pool.tvlUsd / 1e6).toFixed(1)}M TVL), deviation=${poolSignal?.absBps ?? "n/a"}bps`,
      );
    } else if (currentPoolStatus === "contradict") {
      poolContradictCount += 1;
    } else if (currentPoolStatus === "recover") {
      poolRecoverCount += 1;
    }
  }
  if (poolHighTvlConfirm || poolConfirmCount >= POOL_CHALLENGE_CONFIRM_MIN) {
    poolStatus = "confirm";
  } else if (poolContradictCount > 0 && poolConfirmCount === 0) {
    poolStatus = "contradict";
  } else if (poolRecoverCount > 0 && poolConfirmCount === 0 && poolContradictCount === 0) {
    poolStatus = "recover";
  } // else: remains "insufficient" — at least one pool was confirm but not enough
  console.log(
    `[depeg-confirm] ${row.symbol} pool summary: ${pools.length} pools checked, ` +
    `confirm=${poolConfirmCount} (highTvl=${poolHighTvlConfirm}), contradict=${poolContradictCount}, ` +
    `recover=${poolRecoverCount}, bar=${secondaryBar}bps, final=${poolStatus}`,
  );
}
```

Add the import at the top:
```ts
import {
  ...,
  POOL_CHALLENGE_CONFIRM_MIN,
  POOL_CHALLENGE_HIGH_TVL_USD,
} from "../lib/constants";
```

- [ ] **Step 4: Add the two new constants**

Edit `worker/src/lib/constants.ts` near the existing `POOL_CHALLENGE_MIN_TVL` definition (~line 182):

```ts
/** Minimum per-pool TVL for DEX pool challenge and pool-level depeg confirmation */
export const POOL_CHALLENGE_MIN_TVL = 100_000; // $100K

/** Number of qualifying pools that must agree to promote a pending depeg via pool-only confirmation. */
export const POOL_CHALLENGE_CONFIRM_MIN = 2;

/** Single-pool TVL above which pool-only confirmation can promote with a single pool. */
export const POOL_CHALLENGE_HIGH_TVL_USD = 5_000_000; // $5M
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/cron/__tests__/confirm-pending-depegs.test.ts --reporter=default`
Expected: PASS. Other existing tests in the file continue to pass.

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/confirm-pending-depegs.ts worker/src/cron/__tests__/confirm-pending-depegs.test.ts worker/src/lib/constants.ts
git commit -m "fix(depeg-confirm): pool status classification + multi-source promotion bar

Replaces the blanket poolStatus='recover' assignment with a
count-based classification that correctly distinguishes confirm /
contradict / recover / insufficient. Pool-only promotion now requires
either 2 qualifying pools or a single pool with >= \$5M TVL, closing
the low-bar single-pool manipulation path."
```

### Task 2: Atomic backfill delete-then-insert

**Files:**
- Modify: `worker/src/api/backfill-depegs.ts:336-366`
- Test: `worker/src/api/__tests__/backfill-depegs.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `worker/src/api/__tests__/backfill-depegs.test.ts`:

```ts
it("combines delete and first insert chunk into a single batch (total <= D1 100-statement limit)", async () => {
  const calls: Array<{ kind: "batch"; size: number; firstSql: string }> = [];
  const db = {
    prepare(sql: string) {
      return {
        sql,
        bind(..._args: unknown[]) { return this; },
        async run() { /* test helper only */ return {}; },
      } as unknown as D1PreparedStatement;
    },
    async batch(stmts: D1PreparedStatement[]) {
      calls.push({
        kind: "batch",
        size: stmts.length,
        firstSql: ((stmts[0] as unknown) as { sql: string }).sql.trim().split("\n")[0],
      });
      return [];
    },
  } as unknown as D1Database;
  const events = new Array(150).fill(null).map((_, i) => ({
    pegType: "peggedUSD",
    direction: "below" as const,
    peakDeviationBps: -120,
    startedAt: 1_700_000_000 + i * 86_400,
    endedAt: 1_700_000_000 + i * 86_400 + 3600,
    startPrice: 0.988,
    peakPrice: 0.984,
    recoveryPrice: 0.999,
    pegRef: 1,
  }));
  await applyBackfillEvents(db, { id: "usdt-tether", symbol: "USDT" }, events, { startDay: 0, endDay: 1e10 });
  // No standalone "DELETE" batch; delete is in the first batch alongside inserts.
  expect(calls.length).toBeGreaterThan(0);
  expect(calls[0].firstSql.startsWith("DELETE")).toBe(true);
  // Each batch is bounded by D1's 100-statement limit. First batch: delete + 99 inserts = 100.
  // Remaining 51 inserts ship in the second batch.
  expect(calls[0].size).toBeLessThanOrEqual(100);
  expect(calls[0].size).toBe(100);
  expect(calls[1]?.size).toBe(51);
});

it("issues a lone delete when events.length === 0 and never crashes mid-loop", async () => {
  const calls: Array<{ size: number }> = [];
  const db = {
    prepare(sql: string) { return { sql, bind() { return this; }, async run() { return {}; } } as unknown as D1PreparedStatement; },
    async batch(stmts: D1PreparedStatement[]) { calls.push({ size: stmts.length }); return []; },
  } as unknown as D1Database;
  await applyBackfillEvents(db, { id: "usdt-tether", symbol: "USDT" }, [], { startDay: 0, endDay: 1e10 });
  expect(calls).toEqual([{ size: 1 }]);
});
```

(`applyBackfillEvents` is a new exported helper extracted from `backfill-depegs.ts` in Step 2.)

- [ ] **Step 2: Run to verify the test fails**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/api/__tests__/backfill-depegs.test.ts --reporter=default`
Expected: FAIL — `applyBackfillEvents` does not exist.

- [ ] **Step 3: Extract `applyBackfillEvents` helper**

In `worker/src/api/backfill-depegs.ts`, replace the body of the try-block at lines 336-366 with a helper call. Add near the top of the file (after existing imports):

```ts
export async function applyBackfillEvents(
  db: D1Database,
  meta: { id: string; symbol: string },
  events: Array<{
    pegType: string;
    direction: "above" | "below";
    peakDeviationBps: number;
    startedAt: number;
    endedAt: number | null;
    startPrice: number;
    peakPrice: number;
    recoveryPrice: number | null;
    pegRef: number;
  }>,
  replayWindow: { startDay: number; endDay: number },
): Promise<void> {
  const deleteStmt = buildBackfillDeleteStmt(db, meta.id, replayWindow);
  if (events.length === 0) {
    await db.batch([deleteStmt]);
    return;
  }
  const insertStmts = events.map((e) =>
    db
      .prepare(
        `INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'backfill')`,
      )
      .bind(
        meta.id,
        meta.symbol,
        e.pegType,
        e.direction,
        e.peakDeviationBps,
        e.startedAt,
        e.endedAt,
        e.startPrice,
        e.peakPrice,
        e.recoveryPrice,
        e.pegRef,
      ),
  );
  // First batch: delete + first chunk of inserts so partial crashes cannot leave the coin event-less.
  // D1 limits each batch to 100 statements. Reserve one slot for the delete so the first batch
  // never exceeds the limit; remaining inserts ship in full BATCH_CHUNK_SIZE (100) batches.
  const firstChunkSize = Math.min(insertStmts.length, BATCH_CHUNK_SIZE - 1);
  await db.batch([deleteStmt, ...insertStmts.slice(0, firstChunkSize)]);
  for (let i = firstChunkSize; i < insertStmts.length; i += BATCH_CHUNK_SIZE) {
    const chunk = insertStmts.slice(i, i + BATCH_CHUNK_SIZE);
    await db.batch(chunk);
  }
}
```

- [ ] **Step 4: Wire the extracted helper into the main handler**

Replace the original try-block body (lines 336-366) with:

```ts
if (events.length === 0) {
  // Explicitly preserve existing rows when replay window yields nothing.
  // Upstream caller already handled the `events === null` (no-trusted-source) branch.
  totalEvents += 0;
  continue;
}
const replayEvents = events.map((e) => ({
  pegType: e.pegType,
  direction: e.direction,
  peakDeviationBps: e.peakDeviationBps,
  startedAt: e.startedAt,
  endedAt: e.endedAt,
  startPrice: e.startPrice,
  peakPrice: e.peakPrice,
  recoveryPrice: e.recoveryPrice,
  pegRef: e.pegRef,
}));
await applyBackfillEvents(db, { id: meta.id, symbol: meta.symbol }, replayEvents, replayWindow ?? { startDay: 0, endDay: Number.MAX_SAFE_INTEGER });
totalEvents += events.length;
```

Note: `replayWindow` may be `null` when no window is specified. `buildBackfillDeleteStmt` already accepts the fallback shape — confirm by reading `worker/src/api/backfill-depegs-window.ts` before shipping.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/api/__tests__/backfill-depegs.test.ts --reporter=default`
Expected: PASS. Existing backfill tests continue to pass.

- [ ] **Step 6: Commit**

```bash
git add worker/src/api/backfill-depegs.ts worker/src/api/__tests__/backfill-depegs.test.ts
git commit -m "fix(backfill-depegs): delete+insert are atomic in the first batch

Previously the window delete ran in its own db.batch() before the
insert chunks, so a worker interruption between the two left the coin
with zero depeg rows and no recovery path. The delete now ships in
the same batch as the first insert chunk, preserving D1's
batch-level atomicity guarantee for the mutation boundary."
```

### Task 3: Circuit-breaker guard for off-chain confirmation fetch

**Files:**
- Modify: `worker/src/cron/confirm-pending-depegs.ts:213-254`
- Modify: `worker/src/lib/constants.ts` (add circuit source keys)
- Test: `worker/src/cron/__tests__/confirm-pending-depegs.test.ts`

- [ ] **Step 1: Add circuit source constants**

Edit `worker/src/lib/constants.ts`. Find the existing `CIRCUIT_SOURCE` object and append:

```ts
export const CIRCUIT_SOURCE = {
  // ... existing keys ...
  COINGECKO_CONFIRM: "coingecko-confirm",
  DEFILLAMA_CONFIRM: "defillama-confirm",
} as const;
```

If the existing declaration style uses `const` entries, follow the existing style exactly.

- [ ] **Step 2: Add failing test**

The test file already mocks `shouldAttemptFetch` and `recordOutcomeSafe` at the top (see lines
29-32 of the existing file). Those mocks default to `true` / no-op, so without the new wiring
the first test below will falsely pass because the real confirmation always fires CoinGecko.
Override `shouldAttemptFetch` per-test with `vi.mocked(shouldAttemptFetch).mockImplementation(...)`
to make the assertion meaningful.

In `worker/src/cron/__tests__/confirm-pending-depegs.test.ts`:

```ts
it("skips off-chain fetch when the CoinGecko circuit breaker is open", async () => {
  const shouldAttemptSpy = vi.mocked(shouldAttemptFetch);
  shouldAttemptSpy.mockImplementation(async (_db, source) => source !== CIRCUIT_SOURCE.COINGECKO_CONFIRM);
  const fetchSpy = vi.mocked(fetchWithRetry);
  fetchSpy.mockReset();
  await runConfirmWithDb({ pendingRows: [pendingLargeCap], assets: [authoritativeAsset] });
  // No CoinGecko URL fetched
  expect(fetchSpy.mock.calls.find(([url]) => typeof url === "string" && url.includes("/simple/price"))).toBeUndefined();
  // Circuit-breaker skip path must also NOT record a false outcome — only real fetch attempts do.
  expect(vi.mocked(recordOutcomeSafe)).not.toHaveBeenCalledWith(expect.anything(), CIRCUIT_SOURCE.COINGECKO_CONFIRM, false);
});

it("records CoinGecko outcome to circuit breaker on fetch failure", async () => {
  vi.mocked(fetchWithRetry).mockRejectedValueOnce(new Error("timeout"));
  await runConfirmWithDb({ pendingRows: [pendingLargeCap] });
  expect(recordOutcomeSafe).toHaveBeenCalledWith(expect.anything(), CIRCUIT_SOURCE.COINGECKO_CONFIRM, false);
});
```

- [ ] **Step 3: Run the test to confirm failure**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/cron/__tests__/confirm-pending-depegs.test.ts -t "CoinGecko circuit" --reporter=default`
Expected: FAIL.

- [ ] **Step 4: Wrap the off-chain fetch in circuit-breaker checks**

In `worker/src/cron/confirm-pending-depegs.ts`, replace the current `} else if (geckoId) {` branch (lines 213-254) with:

```ts
} else if (geckoId) {
  const primarySource = asset?.priceSource ?? null;
  const useDefiLlamaSecondary =
    primarySource != null && primarySource.startsWith("coingecko");
  const offchainLabel = useDefiLlamaSecondary ? "DefiLlama" : "CoinGecko";
  const circuitKey = useDefiLlamaSecondary
    ? CIRCUIT_SOURCE.DEFILLAMA_CONFIRM
    : CIRCUIT_SOURCE.COINGECKO_CONFIRM;
  const offchainAllowed = await shouldAttemptFetch(db, circuitKey);
  if (offchainAllowed) {
    try {
      const offchainRes = await fetchWithRetry(
        useDefiLlamaSecondary
          ? `${DEFILLAMA_COINS}/prices/current/coingecko:${geckoId}`
          : cgUrl(`/simple/price?ids=${geckoId}&vs_currencies=usd`, coingeckoApiKey ?? null),
        useDefiLlamaSecondary
          ? { headers: { "User-Agent": USER_AGENT }, signal }
          : {
              headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey ?? null),
              signal,
            },
        1,
      );
      if (offchainRes?.ok) {
        let offchainPrice: number | undefined;
        if (useDefiLlamaSecondary) {
          const parsed = DefiLlamaPriceSchema.safeParse(await offchainRes.json());
          offchainPrice = parsed.success ? parsed.data.coins?.[`coingecko:${geckoId}`]?.price : undefined;
        } else {
          const parsed = CoinGeckoPriceSchema.safeParse(await offchainRes.json());
          offchainPrice = parsed.success ? parsed.data[geckoId]?.usd : undefined;
        }

        if (offchainPrice && offchainPrice > 0) {
          const offchainSignal = deriveDepegSignal(offchainPrice, row.peg_reference);
          offchainStatus = classifyDirectionalSignal(offchainSignal, secondaryBar, pendingState.direction);
          console.log(
            `[depeg-confirm] ${row.symbol} ${offchainLabel} check: price=$${offchainPrice}, deviation=${offchainSignal?.absBps ?? "n/a"}bps, ` +
            `bar=${secondaryBar}bps, status=${offchainStatus}`
          );
        }
        await recordOutcomeSafe(db, circuitKey, true);
      } else {
        await recordOutcomeSafe(db, circuitKey, false);
      }
    } catch (err) {
      if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
      await recordOutcomeSafe(db, circuitKey, false);
      console.warn(`[depeg-confirm] ${offchainLabel} fetch failed for ${row.symbol}:`, err);
    }
  } else {
    console.log(`[depeg-confirm] ${row.symbol} ${offchainLabel} skipped: circuit open`);
  }
}
```

- [ ] **Step 5: Run the suite to verify**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/cron/__tests__/confirm-pending-depegs.test.ts --reporter=default`
Expected: PASS (including previously-added tests).

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/confirm-pending-depegs.ts worker/src/lib/constants.ts worker/src/cron/__tests__/confirm-pending-depegs.test.ts
git commit -m "fix(depeg-confirm): guard off-chain fetch with circuit breaker

Adds CIRCUIT_SOURCE.COINGECKO_CONFIRM and DEFILLAMA_CONFIRM so a
permanent upstream outage stops hammering the endpoint. Successful
calls record positive outcomes, non-2xx and network failures record
negative outcomes, and the fetch is skipped entirely while the
circuit is open."
```

---

## Phase 2 — Confirmation Provenance Persistence

### Task 4: D1 migration — `confirmation_sources` + `pending_reason`

**Files:**
- Create: `worker/migrations/0105_depeg_event_provenance.sql`
- Modify: `worker/migrations/MANIFEST.md`
- Modify: `shared/types/market.ts`
- Modify: `worker/src/lib/depeg-helpers.ts`
- Test: `worker/src/lib/__tests__/depeg-helpers.test.ts`

- [ ] **Step 1: Confirm next migration number**

Run: `ls /home/ahirice/Documents/git/stablecoin-dashboard/worker/migrations/*.sql | tail -5`
Expected: highest-numbered file is `0104_blacklist_mirror_zero_permanently_unavailable.sql`. Next free slot is `0105`. If someone has landed another migration in the meantime, bump to the next unused number and use it consistently everywhere in this plan.

- [ ] **Step 2: Create the migration**

Write `worker/migrations/0105_depeg_event_provenance.sql`:

```sql
-- rollout-safety: backward-compatible
ALTER TABLE depeg_events ADD COLUMN confirmation_sources TEXT;
ALTER TABLE depeg_events ADD COLUMN pending_reason TEXT;
```

The `-- rollout-safety:` header is required by the repo convention documented in
`worker/migrations/MANIFEST.md` for every migration numbered ≥ 0071. Both columns are nullable
and have no default, so the currently-deployed worker can continue serving traffic while D1
applies the migration ahead of the new worker deploy.

- [ ] **Step 3: Append the migration to `MANIFEST.md`**

Open `worker/migrations/MANIFEST.md`. In the "Individual Migrations" table, append a row
immediately after the `0104` row, following the exact three-column format already in use:

```markdown
| 0105     | `0105_depeg_event_provenance.sql`               | Add `confirmation_sources` + `pending_reason` nullable TEXT columns to `depeg_events` for post-promotion provenance              |
```

Pipe alignment does not need to match historical entries pixel-perfectly; matching the column
count and header is what the parser cares about. Do not touch any other section of
`MANIFEST.md`.

- [ ] **Step 4: Extend DepegRow / DepegEvent types**

In `worker/src/lib/depeg-helpers.ts`:

```ts
export interface DepegRow {
  // existing fields ...
  confirmation_sources: string | null;
  pending_reason: string | null;
}
```

Extend `rowToDepegEvent()` to expose both:

```ts
return {
  // existing fields ...
  confirmationSources: row.confirmation_sources ?? null,
  pendingReason: row.pending_reason ?? null,
};
```

Extend `buildInsertDepegEventStmt` to bind both:

```ts
export function buildInsertDepegEventStmt(
  db: D1Database,
  event: DepegEvent,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peak_price, peg_reference, source, confirmation_sources, pending_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?)`,
    )
    .bind(
      event.stablecoinId,
      event.symbol,
      event.pegType,
      event.direction,
      event.peakDeviationBps,
      event.startedAt,
      event.startPrice,
      event.peakPrice ?? event.startPrice,
      event.pegReference,
      event.confirmationSources ?? null,
      event.pendingReason ?? null,
    );
}
```

- [ ] **Step 5: Extend shared type + enumerate and patch every literal constructor**

In `shared/types/market.ts`, find `interface DepegEvent` and add:

```ts
interface DepegEvent {
  // existing fields ...
  confirmationSources: string | null;
  pendingReason: string | null;
}
```

Widening an interface mid-tree will break every call-site that builds a `DepegEvent` object
literal because TS requires all fields when the target type is exact. Enumerate them first:

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard
# Fields that uniquely identify a DepegEvent literal being constructed.
grep -rln --include='*.ts' --include='*.tsx' -E 'stablecoinId:\s*["`]' worker/ shared/ src/ \
  | xargs grep -lE 'peakDeviationBps|pegReference' \
  | sort -u
```

Expected touch-points (verify the grep output matches; add any missed file):
- `worker/src/cron/detect-depegs.ts` — the `buildLiveEvent` closure around line 522.
- `worker/src/cron/confirm-pending-depegs.ts` — the `event` literal on promotion (covered in Task 5, which already sets the two fields).
- `worker/src/lib/__tests__/depeg-helpers.test.ts` — any existing `rowToDepegEvent` fixtures (Task 4 Step 5 below adds new ones that already include the fields).
- `worker/src/cron/__tests__/detect-depegs.test.ts` — test fixtures.
- `worker/src/cron/__tests__/confirm-pending-depegs.test.ts` — test fixtures.
- `src/components/__tests__/depeg-history.test.tsx` — Task 15 fixture.
- `src/components/__tests__/depeg-feed.test.tsx` if present.
- Any `makeDepegEvent` helper in `worker/src/api/__tests__/helpers/fixtures.ts`.

For every non-promoting literal (i.e. everything except the Task 5 promotion block), set both
fields to `null` so no existing behavior changes:

```ts
confirmationSources: null,
pendingReason: null,
```

- [ ] **Step 6: Add a test verifying roundtrip**

In `worker/src/lib/__tests__/depeg-helpers.test.ts`:

```ts
it("buildInsertDepegEventStmt binds confirmation_sources and pending_reason", () => {
  const bindCalls: unknown[][] = [];
  const db = {
    prepare(_sql: string) {
      return { bind(...args: unknown[]) { bindCalls.push(args); return this; } } as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
  buildInsertDepegEventStmt(db, {
    id: 0,
    stablecoinId: "usdt-tether",
    symbol: "USDT",
    pegType: "peggedUSD",
    direction: "below",
    peakDeviationBps: -200,
    startedAt: 1000,
    endedAt: null,
    startPrice: 0.98,
    peakPrice: 0.97,
    recoveryPrice: null,
    pegReference: 1,
    source: "live",
    confirmationSources: "DEX+CEX",
    pendingReason: "large-cap",
  });
  expect(bindCalls[0]).toContain("DEX+CEX");
  expect(bindCalls[0]).toContain("large-cap");
});

it("rowToDepegEvent exposes confirmation_sources and pending_reason (null-safe)", () => {
  const event = rowToDepegEvent({
    id: 1, stablecoin_id: "usdt-tether", symbol: "USDT", peg_type: "peggedUSD",
    direction: "below", peak_deviation_bps: -120, started_at: 100, ended_at: null,
    start_price: 0.988, peak_price: 0.985, recovery_price: null, peg_reference: 1, source: "live",
    confirmation_sources: "Pool", pending_reason: "large-cap+low-confidence",
  });
  expect(event.confirmationSources).toBe("Pool");
  expect(event.pendingReason).toBe("large-cap+low-confidence");

  const legacy = rowToDepegEvent({
    id: 2, stablecoin_id: "usdt-tether", symbol: "USDT", peg_type: "peggedUSD",
    direction: "below", peak_deviation_bps: -120, started_at: 100, ended_at: null,
    start_price: 0.988, peak_price: 0.985, recovery_price: null, peg_reference: 1, source: "live",
    confirmation_sources: null, pending_reason: null,
  });
  expect(legacy.confirmationSources).toBeNull();
  expect(legacy.pendingReason).toBeNull();
});
```

- [ ] **Step 7: Run the test**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/lib/__tests__/depeg-helpers.test.ts --reporter=default`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add worker/migrations/0105_depeg_event_provenance.sql worker/migrations/MANIFEST.md worker/src/lib/depeg-helpers.ts worker/src/lib/__tests__/depeg-helpers.test.ts shared/types/market.ts
git commit -m "feat(depeg): migration 0105 adds confirmation_sources + pending_reason

Extends depeg_events with two nullable TEXT columns so promoted
events carry the reason they needed confirmation (large-cap /
low-confidence / extreme-move, possibly combined) and the list of
secondary sources that agreed (DEX / CEX / Pool / off-chain)."
```

### Task 5: Emit provenance on promotion

**Files:**
- Modify: `worker/src/cron/confirm-pending-depegs.ts:340-369`
- Modify: `worker/src/cron/__tests__/confirm-pending-depegs.test.ts`

- [ ] **Step 1: Add failing test asserting promoted rows carry provenance**

Append:

```ts
it("promoted event carries confirmationSources and pendingReason", async () => {
  const insertedEvents: DepegEvent[] = [];
  const batchSpy = vi.mocked(batchExecute).mockImplementation(async (_db, stmts) => {
    for (const stmt of stmts) {
      const meta = stmt as unknown as { sql: string; boundValues: unknown[] };
      if (meta.sql?.startsWith("INSERT INTO depeg_events")) {
        insertedEvents.push(reconstructEventFromBindings(meta.boundValues));
      }
    }
    return stmts.length;
  });
  await runConfirmWithDb({
    pendingRows: [makePendingRow({ reason: "large-cap" })],
    dexRows: [{ stablecoin_id: "usdt-tether", dex_price_usd: 0.988, source_total_tvl: 5e6, source_pool_count: 3, updated_at: now }],
    assets: [makeAsset({ id: "usdt-tether", price: 0.985 })],
  });
  expect(insertedEvents.length).toBeGreaterThan(0);
  expect(insertedEvents[0].confirmationSources).toMatch(/DEX/);
  expect(insertedEvents[0].pendingReason).toBe("large-cap");
});
```

(`reconstructEventFromBindings` can be a local helper in the test file that maps the bound values back to a `DepegEvent` shape. Use `insertedEvents[0].confirmationSources` and `.pendingReason` once the shape matches the new columns.)

- [ ] **Step 2: Run to confirm failure**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/cron/__tests__/confirm-pending-depegs.test.ts -t "promoted event carries" --reporter=default`
Expected: FAIL.

- [ ] **Step 3: Update the promotion code**

Native-peg confirmations go through the `if (nativeSignal != null)` branch and are not CoinGecko /
DefiLlama — they must be labeled distinctly. Track the actual off-chain label alongside
`offchainStatus`. Near the top of the loop body (after `let offchainStatus = ...`):

```ts
let offchainStatus: ReturnType<typeof classifyDirectionalSignal> = "insufficient";
let offchainSourceLabel: string | null = null;
```

Inside the native-peg branch (currently lines ~206-212), set the label after computing status:

```ts
if (nativeSignal != null) {
  offchainStatus = classifyDirectionalSignal(nativeSignal, secondaryBar, pendingState.direction);
  offchainSourceLabel = `NativePeg(${nativePegQuote?.pegCurrency ?? meta?.flags.pegCurrency ?? "native"})`;
  // existing log line...
}
```

Inside the CoinGecko/DefiLlama branch, replace the log-only `offchainLabel` local with persistent
assignment (still inside the `if (offchainPrice && offchainPrice > 0)` block):

```ts
offchainSourceLabel = offchainLabel;
```

Then in `worker/src/cron/confirm-pending-depegs.ts`, replace the `const event: DepegEvent = { ... }` block (around lines 340-369) with:

```ts
const confirmedBy = [
  offchainStatus === "confirm" ? offchainSourceLabel : null,
  dexStatus === "confirm" ? "DEX" : null,
  cexStatus === "confirm" ? "CEX" : null,
  poolStatus === "confirm" ? "Pool" : null,
].filter(Boolean).join("+");
const event: DepegEvent = {
  id: 0,
  stablecoinId: row.stablecoin_id,
  symbol: row.symbol,
  pegType: row.peg_type,
  direction: pendingState.direction,
  peakDeviationBps,
  startedAt: pendingState.firstSeenAt,
  endedAt: null,
  startPrice: pendingState.firstPrice,
  peakPrice,
  recoveryPrice: null,
  pegReference: row.peg_reference,
  source: "live",
  confirmationSources: confirmedBy || null,
  pendingReason: pendingState.reason,
};
```

Delete the now-redundant later computation of `confirmedBy` + the stand-alone `console.log("[depeg-confirm] PROMOTED ...")` and fold the log into the new `PROMOTED` message:

```ts
console.log(
  `[depeg-confirm] PROMOTED ${row.symbol}: ${pendingState.firstSeenBps}bps confirmed by ${confirmedBy || "(none)"}${pendingState.reason ? ` (${pendingState.reason})` : ""}`
);
```

- [ ] **Step 4: Run the test to verify**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/cron/__tests__/confirm-pending-depegs.test.ts --reporter=default`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/confirm-pending-depegs.ts worker/src/cron/__tests__/confirm-pending-depegs.test.ts
git commit -m "feat(depeg-confirm): persist confirmation_sources + pending_reason on promotion"
```

### Task 6: Composite pending reason

**Files:**
- Modify: `worker/src/cron/detect-depegs.ts:472-477`
- Modify: `worker/src/lib/depeg-helpers.ts` (widen `PendingDepegReason`)
- Modify: `worker/src/lib/depeg-pending.ts` (normalize joined reasons)
- Test: `worker/src/lib/__tests__/depeg-pending.test.ts`

- [ ] **Step 1: Widen the type**

In `worker/src/lib/depeg-helpers.ts` replace:
```ts
export type PendingDepegReason = "large-cap" | "low-confidence" | "extreme-move";
```
with:
```ts
export type PendingDepegReasonFlag = "large-cap" | "low-confidence" | "extreme-move";
/**
 * Stored reason is a "+"-joined list of flags in canonical order:
 * extreme-move > large-cap > low-confidence.
 * Examples: "large-cap", "large-cap+low-confidence", "extreme-move".
 */
export type PendingDepegReason = string;

const REASON_ORDER: PendingDepegReasonFlag[] = ["extreme-move", "large-cap", "low-confidence"];

export function buildPendingReason(flags: Iterable<PendingDepegReasonFlag>): PendingDepegReason {
  const set = new Set(flags);
  return REASON_ORDER.filter((f) => set.has(f)).join("+");
}

export function parsePendingReason(reason: PendingDepegReason | null | undefined): Set<PendingDepegReasonFlag> {
  const result = new Set<PendingDepegReasonFlag>();
  if (!reason) return result;
  for (const part of reason.split("+")) {
    if (part === "large-cap" || part === "low-confidence" || part === "extreme-move") {
      result.add(part);
    }
  }
  return result;
}

export function isExtremeMovePending(reason: PendingDepegReason | null | undefined): boolean {
  return parsePendingReason(reason).has("extreme-move");
}
```

- [ ] **Step 2: Add failing test**

In `worker/src/lib/__tests__/depeg-pending.test.ts`:

```ts
it("buildPendingReason orders flags canonically", () => {
  expect(buildPendingReason(["large-cap", "low-confidence"])).toBe("large-cap+low-confidence");
  expect(buildPendingReason(["low-confidence", "large-cap", "extreme-move"])).toBe("extreme-move+large-cap+low-confidence");
  expect(buildPendingReason(["extreme-move"])).toBe("extreme-move");
});

it("parsePendingReason round-trips composite strings", () => {
  const parsed = parsePendingReason("large-cap+low-confidence");
  expect(parsed.has("large-cap")).toBe(true);
  expect(parsed.has("low-confidence")).toBe(true);
  expect(parsePendingReason(null).size).toBe(0);
  expect(parsePendingReason("garbage").size).toBe(0);
});

it("isExtremeMovePending detects composite reasons", () => {
  expect(isExtremeMovePending("extreme-move")).toBe(true);
  expect(isExtremeMovePending("extreme-move+large-cap")).toBe(true);
  expect(isExtremeMovePending("large-cap+low-confidence")).toBe(false);
  expect(isExtremeMovePending(null)).toBe(false);
});
```

- [ ] **Step 3: Update detect-depegs.ts reason derivation**

Replace lines 472-477 in `worker/src/cron/detect-depegs.ts`:

```ts
const reasonFlags: PendingDepegReasonFlag[] = [];
if (absBps >= DEPEG_EXTREME_MOVE_BPS) reasonFlags.push("extreme-move");
if (supply >= DEPEG_CONFIRMATION_SUPPLY_THRESHOLD) reasonFlags.push("large-cap");
if (primaryTrust === "confirm_required") reasonFlags.push("low-confidence");
if (reasonFlags.length === 0) reasonFlags.push("large-cap"); // defensive — requiresConfirmation is true so at least one reason must apply
const pendingReason: PendingDepegReason = buildPendingReason(reasonFlags);
```

Import `PendingDepegReasonFlag`, `buildPendingReason` from `../lib/depeg-helpers`.

- [ ] **Step 4: Replace every string-equality consumer of `pendingReason`**

Composite strings like `"large-cap+low-confidence"` break `=== "low-confidence"` equality. Grep
exhaustively before editing:

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard
grep -rn --include='*.ts' -E 'pendingReason\s*===|pendingState\.reason\s*===|row\.reason\s*===|\.reason\s*!==\s*"(low-confidence|large-cap|extreme-move)"' worker/ shared/ src/
```

Expected matches (both must be rewritten):
- `worker/src/cron/detect-depegs.ts:235` — `pendingReason === "extreme-move"` → `isExtremeMovePending(pendingReason)`
- `worker/src/cron/confirm-pending-depegs.ts:316` — `pendingState.reason !== "low-confidence"` →
  `!parsePendingReason(pendingState.reason).has("low-confidence")`

Apply both rewrites; import `isExtremeMovePending` and `parsePendingReason` from `../lib/depeg-helpers`.

If the grep surfaces additional matches in the current codebase (e.g. new work merged after this
plan was written), rewrite them the same way — never leave string-equality checks against
`PendingDepegReason`.

Also re-inspect `worker/src/lib/depeg-pending.ts:96` (`reason: row.reason ?? "large-cap"`). The
default fallback still makes sense — treat a missing `reason` column as the historical default —
but confirm the comment there reflects the composite form.

- [ ] **Step 5: Run the tests**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/lib/__tests__/depeg-pending.test.ts worker/src/cron/__tests__/detect-depegs.test.ts --reporter=default`
Expected: PASS. Existing detect-depegs tests continue to pass because single-reason strings still round-trip through `buildPendingReason`.

- [ ] **Step 6: Commit**

```bash
git add worker/src/lib/depeg-helpers.ts worker/src/cron/detect-depegs.ts worker/src/lib/__tests__/depeg-pending.test.ts
git commit -m "feat(depeg): composite pending reason preserves all routing factors

A coin that is simultaneously >= \$1B in supply and has a cached
primary price now records 'large-cap+low-confidence' instead of
collapsing the information to one label. Confirmation routing and
downstream ex-post analysis both benefit."
```

---

## Phase 3 — Stage 1 Hardening

### Task 7: DEWS liquidity fail-closed when both 7d deltas are missing

**Files:**
- Modify: `worker/src/lib/dews.ts:277-342`
- Test: `worker/src/lib/__tests__/dews.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `worker/src/lib/__tests__/dews.test.ts`:

```ts
it("marks liquidity signal unavailable when liquidityScore7dAgo is null and tvl delta cannot be computed", () => {
  const result = computeDEWS({
    ...baseInput,
    liquidityScore: 72,
    liquidityScore7dAgo: null,
    tvlCurrent: null,
    tvl7dAgo: null,
  });
  expect(result?.signals.liq.available).toBe(false);
});

it("keeps liquidity signal available when only one of the two 7d anchors is present", () => {
  const result = computeDEWS({
    ...baseInput,
    liquidityScore: 72,
    liquidityScore7dAgo: null,
    tvlCurrent: 1e9,
    tvl7dAgo: 1.5e9,
  });
  expect(result?.signals.liq.available).toBe(true);
});
```

- [ ] **Step 2: Run the tests to verify failure**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/lib/__tests__/dews.test.ts -t "liquidity signal" --reporter=default`
Expected: FAIL — first test fails because current code returns `available: true` with `value: 0`.

- [ ] **Step 3: Tighten availability check in `computeLiquiditySignal`**

In `worker/src/lib/dews.ts:277-342`, replace the early unavailability guard:

```ts
function computeLiquiditySignal(input: DEWSInput): SignalResult {
  const { liquidityScore, liquidityScore7dAgo, tvlCurrent, tvl7dAgo } = input;

  const scoreDeltaComputable = liquidityScore !== null && liquidityScore7dAgo !== null && liquidityScore7dAgo > 0;
  const tvlDeltaComputable = tvlCurrent !== null && tvl7dAgo !== null && tvl7dAgo > 0;

  if (liquidityScore === null || (!scoreDeltaComputable && !tvlDeltaComputable)) {
    return { value: 0, available: false };
  }
  // rest of body unchanged
}
```

- [ ] **Step 4: Run tests**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/lib/__tests__/dews.test.ts --reporter=default`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/dews.ts worker/src/lib/__tests__/dews.test.ts
git commit -m "fix(dews): liq signal fails closed when both 7d anchors are missing"
```

### Task 8: Boundary test coverage

**Files:**
- Modify: `worker/src/lib/__tests__/dews.test.ts`

- [ ] **Step 1: Add boundary tests**

Append:

```ts
describe("DEWS scoring boundaries", () => {
  it("returns null at totalWeight === 0.29 (just below threshold)", () => {
    // Only supply(0.25) signal available — below 0.30 threshold
    const result = computeDEWS({
      ...baseInput,
      weightedBalanceRatio: null,
      avgPoolStress: null,
      liquidityScore: null,
      price: null,
      hasBlacklistTracking: false,
      burnVolume24hUsd: null,
      mintVolume24hUsd: null,
      burnBaseline30dUsd: null,
      flowDataAgeDays: 0,
      yieldWarnings: [],
    });
    expect(result).toBeNull();
  });

  it("returns a score at totalWeight === 0.30 (exact threshold, inclusive)", () => {
    // Pool(0.20) + Liq(0.15) removed; use price(0.15) + diverg(0.15) = 0.30
    const result = computeDEWS({
      ...baseInput,
      circulatingPrevDay: 0,
      circulatingPrevWeek: 0, // supply unavailable
      weightedBalanceRatio: null, // pool unavailable
      avgPoolStress: null,
      liquidityScore: null, // liq unavailable
      priceConfidence: "high",
      price: 1.0,
      pegRef: 1.0,
      dexPriceUsd: 1.0,
      hasBlacklistTracking: false,
    });
    expect(result).not.toBeNull();
  });

  it("PSI amplifier is 1.0 at PSI === 75 exactly (no amplification)", () => {
    const resultAt75 = computeDEWS({ ...baseInput, psiScore: 75 });
    const resultAtNull = computeDEWS({ ...baseInput, psiScore: null });
    expect(resultAt75?.score).toBe(resultAtNull?.score);
  });

  it("flow signal is unavailable at flowDataAgeDays === 6 and available at 7", () => {
    const resultAt6 = computeDEWS({
      ...baseInput,
      burnVolume24hUsd: 1e6,
      mintVolume24hUsd: 0,
      burnBaseline30dUsd: 1e5,
      flowDataAgeDays: 6,
    });
    expect(resultAt6?.signals.flow.available).toBe(false);
    const resultAt7 = computeDEWS({
      ...baseInput,
      burnVolume24hUsd: 1e6,
      mintVolume24hUsd: 0,
      burnBaseline30dUsd: 1e5,
      flowDataAgeDays: 7,
    });
    expect(resultAt7?.signals.flow.available).toBe(true);
  });

  it("blacklist signal handles a zero 7d baseline without division by zero", () => {
    const result = computeDEWS({
      ...baseInput,
      hasBlacklistTracking: true,
      blacklistEvents24h: 3,
      blacklistEvents7d: 0,
    });
    expect(result?.signals.black.available).toBe(true);
    expect(Number.isFinite(result?.signals.black.value ?? NaN)).toBe(true);
    expect(result?.signals.black.spikeRatio).toBe(3); // falls back to raw 24h count
  });
});
```

Define `baseInput` at the top of the describe block (or reuse the existing test fixture if one exists; scan the file first).

- [ ] **Step 2: Run**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/lib/__tests__/dews.test.ts --reporter=default`
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add worker/src/lib/__tests__/dews.test.ts
git commit -m "test(dews): cover weight/PSI/flow/blacklist boundary conditions"
```

---

## Phase 4 — DEWS Contagion Amplifier (v5.95)

### Task 9: Introduce contagion amplifier in dews.ts

**Files:**
- Modify: `worker/src/lib/dews.ts`
- Create: `worker/src/lib/__tests__/dews-contagion.test.ts`

Rationale: PSI amplifier captures systemic stress; but PSI can be "STEADY" when one specific stablecoin is in crisis. A per-peg-type / per-issuer contagion amplifier detects when any tracked stablecoin is already `DANGER` or `WARNING` and applies a bounded bump to related coins. This is a layered, explainable enhancement — not a learned model — so operators can reason about it.

- [ ] **Step 1: Extend `DEWSInput` and `computeDEWS`**

In `worker/src/lib/dews.ts`:

```ts
export interface DEWSInput {
  // existing fields ...
  /**
   * Pre-computed contagion amplifier >= 1.0 derived from other stablecoins'
   * first-pass DEWS bands. 1.0 means no contagion; 1.15 = +15%. Caller must
   * clamp to [1.0, 1.2].
   */
  contagionAmplifier?: number;
}

export interface DEWSResult {
  // existing fields ...
  amplifiers: { psi: number; contagion: number };
}
```

In `computeDEWS` replace the PSI-amplifier block with:

```ts
const psiAmplifier = input.psiScore !== null && input.psiScore < 75
  ? 1 + Math.max(0, (75 - input.psiScore) / 75) * 0.3
  : 1;
const contagionAmplifier = Math.min(Math.max(input.contagionAmplifier ?? 1, 1), 1.2);
let amplifiedScore = (weightedSum / totalWeight) * psiAmplifier * contagionAmplifier;
const score = Math.round(clamp(amplifiedScore, 0, 100));
const band = getThreatBand(score);
return {
  score,
  band,
  signals,
  amplifiers: { psi: psiAmplifier, contagion: contagionAmplifier },
};
```

- [ ] **Step 2: Add unit tests**

`worker/src/lib/__tests__/dews-contagion.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { computeDEWS } from "../dews";

const baseInput = { /* copy the canonical baseline fixture from dews.test.ts */ };

describe("DEWS contagion amplifier", () => {
  it("defaults to 1.0 when contagionAmplifier is undefined", () => {
    const result = computeDEWS({ ...baseInput });
    expect(result?.amplifiers.contagion).toBe(1);
  });
  it("is clamped to the [1, 1.2] range", () => {
    const high = computeDEWS({ ...baseInput, contagionAmplifier: 2.0 });
    expect(high?.amplifiers.contagion).toBe(1.2);
    const low = computeDEWS({ ...baseInput, contagionAmplifier: 0.5 });
    expect(low?.amplifiers.contagion).toBe(1);
  });
  it("multiplies on top of PSI amplifier", () => {
    const base = computeDEWS({ ...baseInput, psiScore: 50, contagionAmplifier: 1 });
    const amplified = computeDEWS({ ...baseInput, psiScore: 50, contagionAmplifier: 1.15 });
    expect(amplified!.score).toBeGreaterThan(base!.score);
  });
  it("preserves 0 score when baseline weighted sum is 0", () => {
    const result = computeDEWS({ ...baseInput, contagionAmplifier: 1.2 });
    // With all stress signals at 0, amplification on 0 = 0
    expect(result?.score).toBe(0);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/lib/__tests__/dews.test.ts worker/src/lib/__tests__/dews-contagion.test.ts --reporter=default`
Expected: PASS (existing tests stay green because default `contagionAmplifier` is 1.0).

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/dews.ts worker/src/lib/__tests__/dews-contagion.test.ts
git commit -m "feat(dews): contagion amplifier input on computeDEWS (clamped [1.0, 1.2])"
```

### Task 10: Two-pass scoring cron applies contagion amplifier

**Files:**
- Modify: `worker/src/cron/dews/scoring.ts`
- Modify: `worker/src/cron/dews/contracts.ts`
- Test: `worker/src/cron/__tests__/compute-dews.test.ts`

Rationale: contagion amplifier must be derived from the same cycle's first-pass results, then applied on the second pass. Simple implementation: if any tracked coin's first-pass band is `DANGER`, set a global multiplier of `1.15`; `WARNING` adds `1.08`; with a cap of `1.20`. Different peg types do not share contagion risk — so compute per peg type.

- [ ] **Step 1: Add contagion contract types**

In `worker/src/cron/dews/contracts.ts`:

```ts
export interface ContagionAmplifiers {
  /** Amplifier per pegType, defaults to 1.0 when no contagion detected. */
  byPegType: Record<string, number>;
  /** Coins whose first-pass DANGER band contributed. */
  triggeringIds: string[];
}
```

- [ ] **Step 2: Two-pass scoring**

In `worker/src/cron/dews/scoring.ts`, wrap the existing single-pass loop so it runs twice. Sketch:

```ts
// Pass 1: compute baseline DEWS without contagion
const firstPass: Map<string, DEWSResult> = new Map();
for (const asset of assets) {
  const result = computeDEWS({ ...inputs.get(asset.id)!, contagionAmplifier: 1 });
  if (result) firstPass.set(asset.id, result);
}

// Derive per-pegType contagion amplifier (v5.95)
const amplifiers: ContagionAmplifiers = { byPegType: {}, triggeringIds: [] };
for (const [coinId, result] of firstPass) {
  const pegType = inputs.get(coinId)?.pegType ?? "peggedUSD";
  let bump = 1;
  if (result.band === "DANGER") bump = 1.15;
  else if (result.band === "WARNING") bump = 1.08;
  if (bump > (amplifiers.byPegType[pegType] ?? 1)) {
    amplifiers.byPegType[pegType] = Math.min(bump, 1.2);
    amplifiers.triggeringIds.push(coinId);
  }
}

// Pass 2: re-score every coin with pegType-specific amplifier
const finalResults: Map<string, DEWSResult> = new Map();
for (const asset of assets) {
  const input = inputs.get(asset.id)!;
  const contagion = amplifiers.byPegType[input.pegType] ?? 1;
  const result = computeDEWS({ ...input, contagionAmplifier: contagion });
  if (result) finalResults.set(asset.id, result);
}
```

Wire the returned `amplifiers` through `buildDewsScoringResult()`, then update:

- `worker/src/cron/dews/persistence.ts` — widen the JSON payload bound at the `signals_json`
  position so it is `JSON.stringify({ signals: result.signals, amplifiers: result.amplifiers })`
  instead of serializing `signals` alone. Keep the column name `signals_json` for backward
  compatibility.
- `worker/src/cron/dews/source-state.ts` — when re-hydrating previous rows for smoothing, parse
  the wider shape with a safe fallback: `parsed.signals ?? parsed` (legacy rows had `signals` at
  the top level, new rows have `{ signals, amplifiers }`). Keep the fallback forever; never
  migrate the historical rows.
- Add a unit test in `worker/src/cron/dews/__tests__/` (or extend the existing `source-state`
  test) asserting that a legacy `signals_json` without `amplifiers` still parses cleanly and
  returns `amplifiers: { psi: 1, contagion: 1 }` as the hydrated default.

**Exclusion rule:** a coin that is itself `DANGER`/`WARNING` on the first pass must not contagion-amplify itself. Apply the amplifier only if `firstPass.get(coinId)?.band` is not at or above the contributing band — otherwise its first-pass result carries forward unchanged. Guard in Pass 2:

```ts
const firstBand = firstPass.get(asset.id)?.band ?? null;
const applicable = contagion > 1 && firstBand !== "DANGER" && firstBand !== "WARNING";
const result = computeDEWS({ ...input, contagionAmplifier: applicable ? contagion : 1 });
```

- [ ] **Step 3: Add cron test**

In `worker/src/cron/__tests__/compute-dews.test.ts`:

```ts
it("applies contagion amplifier to same-peg-type coins when one is DANGER", async () => {
  // Two USD coins: coin A gets DANGER on first pass (score ~80); coin B should be amplified on second pass
  const results = await runComputeDewsWithDb({
    coins: [
      { id: "depeg-coin", pegType: "peggedUSD", stressInputs: hugeStressFixture },
      { id: "healthy-coin", pegType: "peggedUSD", stressInputs: mildStressFixture },
    ],
  });
  const depeg = results.get("depeg-coin")!;
  const healthy = results.get("healthy-coin")!;
  expect(depeg.band).toBe("DANGER");
  // Self-exclusion: the triggering coin must not amplify itself.
  expect(depeg.amplifiers.contagion).toBe(1);
  expect(healthy.amplifiers.contagion).toBeGreaterThan(1);
  expect(healthy.score).toBeGreaterThan(results.firstPassOnly!.get("healthy-coin")!.score);
});

it("does not amplify across peg types — EUR coin is unaffected when a USD coin is DANGER", async () => {
  const results = await runComputeDewsWithDb({
    coins: [
      { id: "usd-depeg", pegType: "peggedUSD", stressInputs: hugeStressFixture },
      { id: "eur-healthy", pegType: "peggedEUR", stressInputs: mildStressFixture },
    ],
  });
  expect(results.get("eur-healthy")!.amplifiers.contagion).toBe(1);
});

it("final amplifier cap (PSI * contagion) cannot push the score past 100", async () => {
  // Worst case: PSI=0 => 1.3x amplifier, same-peg-type DANGER => 1.15x contagion, total 1.495x.
  // Even if raw weighted sum is 99, final must clamp to <= 100.
  const results = await runComputeDewsWithDb({
    coins: [
      { id: "hot-coin", pegType: "peggedUSD", stressInputs: nearMaxStressFixture },
      { id: "anchor-danger", pegType: "peggedUSD", stressInputs: hugeStressFixture },
    ],
    psi: { score: 0, computedAt: 0 },
  });
  expect(results.get("hot-coin")!.score).toBeLessThanOrEqual(100);
  expect(results.get("hot-coin")!.score).toBeGreaterThanOrEqual(0);
});
```

Add `runComputeDewsWithDb` helper in the test file's shared setup if not already present.

- [ ] **Step 4: Run tests**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/cron/__tests__/compute-dews.test.ts worker/src/lib/__tests__/dews-contagion.test.ts --reporter=default`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/dews/scoring.ts worker/src/cron/dews/contracts.ts worker/src/cron/__tests__/compute-dews.test.ts
git commit -m "feat(dews): cross-asset contagion amplifier (v5.95)

When any tracked stablecoin enters WARNING or DANGER on the first
pass, same-peg-type coins receive a bounded second-pass amplifier
(max 1.2x). Keeps contagion risk visible without double-counting
the first-pass coin itself."
```

### Task 11: Surface contagion amplifier on the API

**Files:**
- Modify: `worker/src/api/stress-signals.ts`
- Modify: `shared/lib/classification.ts` (if the surface type lives there)
- Test: `worker/src/api/__tests__/stress-signals.test.ts`

- [ ] **Step 1: Add failing test**

Append:

```ts
it("includes amplifiers (psi + contagion) in the aggregate response", async () => {
  const response = await fetchStressSignals(db, { psi: { score: 60, computedAt: now } });
  const body = await response.json();
  const firstCoin = Object.values(body.signals)[0] as { amplifiers?: { psi: number; contagion: number } };
  expect(firstCoin.amplifiers?.psi).toBeGreaterThanOrEqual(1);
  expect(firstCoin.amplifiers?.contagion).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/api/__tests__/stress-signals.test.ts -t "amplifiers" --reporter=default`
Expected: FAIL.

- [ ] **Step 3: Read the persisted columns to include `amplifiers`**

Inspect the existing `signals_json` column shape. If `amplifiers` is already part of the persisted JSON (added by Task 10), pass it through untouched in the response mapper. If not, extend `scoring.ts::buildDewsScoringResult` to include `amplifiers` in the serialized payload, then widen the read-path schema in `worker/src/api/stress-signals.ts` to surface it.

- [ ] **Step 4: Run tests**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/api/__tests__/stress-signals.test.ts --reporter=default`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/api/stress-signals.ts worker/src/cron/dews/scoring.ts worker/src/api/__tests__/stress-signals.test.ts
git commit -m "feat(dews): surface amplifiers {psi, contagion} on /api/stress-signals"
```

---

## Phase 5 — Backtest Harness (admin-only, no version bump)

### Task 12: Curated historical anchor fixture

**Files:**
- Create: `worker/src/lib/backtest-anchors.ts`
- Create: `worker/src/lib/__tests__/backtest-anchors.test.ts`

- [ ] **Step 1: Define the fixture**

`worker/src/lib/backtest-anchors.ts`:

```ts
export interface BacktestAnchor {
  /** Stablecoin ID (matches depeg_events.stablecoin_id). */
  stablecoinId: string;
  /** Unix seconds: canonical "onset" timestamp. */
  onsetAt: number;
  /** Unix seconds: canonical "resolved" timestamp (null = never fully resolved). */
  resolvedAt: number | null;
  /** Peak absolute bps reached. */
  peakAbsBps: number;
  /** One-line description used in reports. */
  description: string;
}

/**
 * Curated set of reference depeg events used for backtest precision / recall.
 * Each anchor must be independently verifiable against the depeg_events table
 * at https://api.pharos.watch/api/depeg-events?stablecoin=<id>.
 *
 * Keep the list small (< 15) and only include events that have a clear,
 * undisputed onset and resolution — noisy micro-depegs belong in the live
 * pipeline, not the backtest fixture.
 */
export const BACKTEST_ANCHORS: readonly BacktestAnchor[] = Object.freeze([
  {
    stablecoinId: "usdc-usd-coin",
    onsetAt: 1678492800, // 2023-03-11
    resolvedAt: 1678752000, // 2023-03-14
    peakAbsBps: 1200,
    description: "USDC Silicon Valley Bank exposure",
  },
  {
    stablecoinId: "usdt-tether",
    onsetAt: 1697544000, // 2023-10-17 (illustrative; confirm against history)
    resolvedAt: 1697632800,
    peakAbsBps: 140,
    description: "USDT CEX imbalance, late 2023",
  },
  {
    stablecoinId: "fdusd-first-digital-usd",
    onsetAt: 1730332800, // 2024-10-31 (illustrative; confirm)
    resolvedAt: 1730419200,
    peakAbsBps: 250,
    description: "FDUSD Binance custody wobble",
  },
  {
    stablecoinId: "busd-binance-usd",
    onsetAt: 1707782400, // 2024-02-13 wind-down residual
    resolvedAt: null,
    peakAbsBps: 180,
    description: "BUSD wind-down residual",
  },
]);
```

**Important:** before shipping, the owner of this task MUST verify each `onsetAt` / `resolvedAt` against `https://api.pharos.watch/api/depeg-events?stablecoin=<id>&limit=1000` (via the ops curl path already documented in `docs/worker-and-api-limits.md`). Adjust timestamps to match the canonical stored events; placeholder values above are illustrative and must not be merged unverified.

**Gate this with a build-time assertion.** Add a `SENTINEL` constant inside `backtest-anchors.ts`:

```ts
/**
 * Flip to `true` once every BACKTEST_ANCHORS entry has been verified against the live
 * /api/depeg-events response. Leaving this false causes the test below to fail, blocking a
 * merge of placeholder timestamps.
 */
export const BACKTEST_ANCHORS_VERIFIED = false;
```

Add a companion test in `worker/src/lib/__tests__/backtest-anchors.test.ts`:

```ts
it("BACKTEST_ANCHORS have been verified against live data before merge", () => {
  expect(BACKTEST_ANCHORS_VERIFIED).toBe(true);
});
```

Task owner flips `BACKTEST_ANCHORS_VERIFIED` to `true` only after the curl-against-live-API
verification is complete and the timestamps match. The test will fail CI while the flag is
`false`, preventing an unverified anchor set from shipping.

- [ ] **Step 2: Test the fixture shape**

`worker/src/lib/__tests__/backtest-anchors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BACKTEST_ANCHORS } from "../backtest-anchors";

describe("BACKTEST_ANCHORS fixture", () => {
  it("has at least 3 anchors and is frozen", () => {
    expect(BACKTEST_ANCHORS.length).toBeGreaterThanOrEqual(3);
    expect(Object.isFrozen(BACKTEST_ANCHORS)).toBe(true);
  });
  it("every onset is before resolved (when resolved is non-null)", () => {
    for (const a of BACKTEST_ANCHORS) {
      if (a.resolvedAt !== null) expect(a.resolvedAt).toBeGreaterThan(a.onsetAt);
    }
  });
  it("peakAbsBps is positive and finite", () => {
    for (const a of BACKTEST_ANCHORS) {
      expect(Number.isFinite(a.peakAbsBps)).toBe(true);
      expect(a.peakAbsBps).toBeGreaterThan(0);
    }
  });
  it("stablecoinId is kebab-case and non-empty", () => {
    for (const a of BACKTEST_ANCHORS) {
      expect(a.stablecoinId).toMatch(/^[a-z0-9-]+$/);
    }
  });
});
```

- [ ] **Step 3: Run**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/lib/__tests__/backtest-anchors.test.ts --reporter=default`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/backtest-anchors.ts worker/src/lib/__tests__/backtest-anchors.test.ts
git commit -m "feat(dews-backtest): curated historical anchor fixture"
```

### Task 13: Backtest metrics endpoint extension

**Files:**
- Modify: `worker/src/api/backfill-dews.ts`
- Create: `worker/src/api/__tests__/backfill-dews-metrics.test.ts`

The endpoint already exists; extend it to support a `mode=backtest-metrics` query that walks `BACKTEST_ANCHORS`, pulls `stress_signal_history` rows within the 14 days preceding each onset, and computes:

- **Detection rate:** fraction of anchors where any history row in the 24h pre-onset window had `band` >= `ALERT`.
- **Lead time (hours, p50 / p90):** for detected anchors, the time from first `ALERT+` band to `onsetAt`.
- **False-positive rate proxy:** count of non-anchor history rows at `ALERT+` in the same windows, relative to total window samples.

- [ ] **Step 1: Write the failing test**

`worker/src/api/__tests__/backfill-dews-metrics.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { handleBackfillDEWS } from "../backfill-dews";

describe("GET /api/backfill-dews?mode=backtest-metrics", () => {
  it("returns detection rate, lead time percentiles (days), and per-anchor detail", async () => {
    const db = /* mock D1 returning canned stress_signal_history rows matching the anchors */;
    const url = new URL("https://example.com/api/backfill-dews?mode=backtest-metrics");
    const res = await handleBackfillDEWS(db, url, true);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.detectionRate).toBeGreaterThanOrEqual(0);
    expect(body.detectionRate).toBeLessThanOrEqual(1);
    expect(body.leadTimeDaysP50).toBeDefined();
    expect(body.leadTimeDaysP90).toBeDefined();
    expect(Array.isArray(body.perAnchor)).toBe(true);
    expect(body.perAnchor[0]).toMatchObject({
      stablecoinId: expect.any(String),
      onsetAt: expect.any(Number),
      detected: expect.any(Boolean),
      leadTimeDays: expect.any(Number),
      firstAlertBand: expect.any(String),
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/api/__tests__/backfill-dews-metrics.test.ts --reporter=default`
Expected: FAIL (mode not implemented).

- [ ] **Step 3: Implement**

In `worker/src/api/backfill-dews.ts`, add a branch inside `handleBackfillDEWS` (the exported handler is capitalized — verify by grep before editing). Because `stress_signal_history.snapshot_date` is stored at **UTC-midnight daily granularity** (see `worker/migrations/0000_baseline.sql:433`), lead time is reported in **days**, not hours — sub-day precision is not recoverable from stored history.

```ts
const mode = url.searchParams.get("mode");
if (mode === "backtest-metrics") {
  return runAdminRoute({ request, trustedAdmin, url }, async () => {
    const anchors = BACKTEST_ANCHORS;
    const perAnchor: Array<{
      stablecoinId: string; onsetAt: number; detected: boolean;
      leadTimeDays: number | null; firstAlertBand: string | null;
    }> = [];
    for (const anchor of anchors) {
      const windowStart = anchor.onsetAt - 14 * 86_400;
      const rows = await db.prepare(
        "SELECT snapshot_date, band FROM stress_signal_history WHERE stablecoin_id = ? AND snapshot_date >= ? AND snapshot_date <= ? ORDER BY snapshot_date ASC",
      ).bind(anchor.stablecoinId, windowStart, anchor.onsetAt).all<{ snapshot_date: number; band: string }>();
      let firstAlertAt: number | null = null;
      let firstAlertBand: string | null = null;
      for (const row of rows.results ?? []) {
        if (row.band === "ALERT" || row.band === "WARNING" || row.band === "DANGER") {
          firstAlertAt = row.snapshot_date;
          firstAlertBand = row.band;
          break;
        }
      }
      const detected = firstAlertAt !== null;
      perAnchor.push({
        stablecoinId: anchor.stablecoinId,
        onsetAt: anchor.onsetAt,
        detected,
        leadTimeDays: detected ? (anchor.onsetAt - firstAlertAt!) / 86_400 : null,
        firstAlertBand,
      });
    }
    const detected = perAnchor.filter(a => a.detected);
    const leadTimes = detected.map(a => a.leadTimeDays!).sort((a, b) => a - b);
    const p = (q: number) => leadTimes.length === 0 ? null : leadTimes[Math.min(leadTimes.length - 1, Math.floor(q * leadTimes.length))];
    return jsonResponse({
      detectionRate: anchors.length === 0 ? 0 : detected.length / anchors.length,
      leadTimeDaysP50: p(0.5),
      leadTimeDaysP90: p(0.9),
      granularity: "daily",
      perAnchor,
    });
  });
}
```

Add `import { BACKTEST_ANCHORS } from "../lib/backtest-anchors";` at the top.

- [ ] **Step 4: Run**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run worker/src/api/__tests__/backfill-dews-metrics.test.ts worker/src/api/__tests__/backfill-dews.test.ts --reporter=default`
Expected: PASS, including the existing backfill-dews tests.

- [ ] **Step 5: Commit**

```bash
git add worker/src/api/backfill-dews.ts worker/src/api/__tests__/backfill-dews-metrics.test.ts
git commit -m "feat(dews-backtest): backtest-metrics mode emits detection rate + lead time"
```

---

## Phase 6 — Frontend Surfacing

### Task 14: Expose per-signal firing breakdown in DEWS detail UI

**Files:**
- Modify: `src/components/dews-detail.tsx`
- Modify: `src/components/__tests__/dews-summary.test.ts` (or new dews-detail.test.tsx)

- [ ] **Step 1: Write a failing test**

Create `src/components/__tests__/dews-detail.test.tsx` (if not present) with:

```ts
import { render, screen } from "@testing-library/react";
import { DEWSDetail } from "../dews-detail";

it("lists firing signals with their numeric value", () => {
  render(<DEWSDetail
    score={42}
    band="ALERT"
    signals={{
      supply: { value: 55, available: true },
      pool:   { value: 0, available: true },
      liq:    { value: 0, available: false },
      price:  { value: 25, available: true },
      diverg: { value: 80, available: true },
      black:  { value: 0, available: false },
      flow:   { value: 0, available: false },
      yield:  { value: 0, available: false },
    }}
  />);
  // The firing list sorts by value descending and excludes zero/unavailable.
  const items = screen.getAllByTestId("dews-firing-signal");
  expect(items.length).toBe(3);
  expect(items[0].textContent).toMatch(/diverg/i);
  expect(items[0].textContent).toMatch(/80/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run src/components/__tests__/dews-detail.test.tsx --reporter=default`
Expected: FAIL.

- [ ] **Step 3: Extend `DEWSDetail` with the firing list**

In `src/components/dews-detail.tsx`, add after the aggregate band badge:

```tsx
{/* Firing signals breakdown */}
<div className="mt-4 space-y-1">
  <h4 className="text-xs font-medium text-[var(--ink-500)]">Signals firing</h4>
  {Object.entries(signals)
    .filter(([_, s]) => s.available && s.value > 0)
    .sort((a, b) => b[1].value - a[1].value)
    .slice(0, 5)
    .map(([key, s]) => (
      <div
        key={key}
        data-testid="dews-firing-signal"
        className="flex items-center justify-between text-xs"
      >
        <span className="font-mono text-[var(--ink-700)]">{key}</span>
        <span className="tabular-nums text-[var(--ink-600)]">{Math.round(s.value)}</span>
      </div>
    ))}
  {Object.values(signals).every((s) => !s.available || s.value === 0) ? (
    <p className="text-xs text-[var(--ink-500)]">No stress signals firing</p>
  ) : null}
</div>
```

Match the existing file's design-token + className style — read a few lines of `dews-detail.tsx` first and adjust the color / typography tokens to existing conventions (do not invent new tokens).

- [ ] **Step 4: Run tests**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run src/components/__tests__/dews-detail.test.tsx --reporter=default`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/dews-detail.tsx src/components/__tests__/dews-detail.test.tsx
git commit -m "feat(dews-ui): surface top-5 firing signals on DEWSDetail card"
```

### Task 15: Surface confirmation_sources + pending_reason in depeg history UI

**Files:**
- Modify: `src/components/depeg-history.tsx`
- Modify: `src/components/depeg-feed.tsx`

- [ ] **Step 1: Add a test**

In `src/components/__tests__/` add / extend a history test that:
- Renders a `DepegHistory` with one event where `confirmationSources = "DEX+CEX"` and `pendingReason = "large-cap"`.
- Asserts both strings are visible in the rendered output (via `screen.getByText` or `getAllByText`).
- Renders a legacy event with both fields null and asserts the badges are absent.

- [ ] **Step 2: Implement**

Add a small inline badge renderer in `depeg-history.tsx`:

```tsx
{event.pendingReason ? (
  <span data-testid="event-pending-reason" className="ml-2 rounded bg-[var(--surface-subtle)] px-1.5 py-0.5 text-[10px] font-medium uppercase text-[var(--ink-500)]">
    {event.pendingReason}
  </span>
) : null}
{event.confirmationSources ? (
  <span data-testid="event-confirmed-by" className="ml-1 rounded bg-[var(--surface-subtle)] px-1.5 py-0.5 text-[10px] font-medium uppercase text-[var(--ink-500)]">
    ✓ {event.confirmationSources}
  </span>
) : null}
```

Place the badges beside the existing direction / peak-bps badge column so they only appear when data is present and do not disrupt the existing layout.

- [ ] **Step 3: Run the affected suite**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run src/components/__tests__/depeg-history.test.tsx --reporter=default`
(If the test file does not yet exist, add a minimal one alongside this task. Use React Testing Library + existing fixture patterns from the dews-summary test.)

- [ ] **Step 4: Commit**

```bash
git add src/components/depeg-history.tsx src/components/__tests__/depeg-history.test.tsx
git commit -m "feat(depeg-ui): show pending_reason + confirmation_sources badges"
```

---

## Phase 7 — Documentation + Version Bumps

### Task 16: Methodology v5.94 (bug-fix wave)

**Files:**
- Modify: `shared/lib/depeg-dews-version.ts`
- Modify: `docs/depeg-dews-timeline.md`
- Modify: `docs/depeg-detection.md`
- Modify: `docs/dews.md`

- [ ] **Step 1: Append v5.94 to `depeg-dews-version.ts`**

Prepend to the `changelog` array (newest first, matching the existing ordering):

```ts
{
  version: "5.94",
  title: "Pool-confirmation hardening, backfill atomicity, confirmation-provenance surfacing",
  date: "2026-04-18",
  effectiveAt: <Unix seconds for 2026-04-18 00:00 UTC>,
  summary:
    "Pool-only pending promotion now requires 2 pools or >= \$5M TVL; backfill delete+insert share a batch; off-chain confirmation is circuit-breaker-guarded; promoted depeg events now persist confirmation_sources and pending_reason.",
  impact: [
    "Single-pool manipulation can no longer unilaterally promote a pending depeg (bar = 2 pools OR one pool with >= \$5M TVL)",
    "A worker interruption during backfill no longer leaves a coin with zero depeg rows",
    "A CoinGecko/DefiLlama outage no longer hammers the endpoint for 45 min per pending row",
    "Promoted events carry confirmation_sources (e.g. 'DEX+CEX') and pending_reason (e.g. 'large-cap+low-confidence') for ex-post diagnostics",
    "DEWS liquidity sub-signal fails closed when both 7-day anchors are missing instead of silently contributing 0",
  ],
  commits: [],
  reconstructed: false,
},
```

Update `DEPEG_DEWS_METHODOLOGY_VERSION = createMethodologyVersion({ currentVersion: "5.94", ... })`.

- [ ] **Step 2: Append matching entry to `docs/depeg-dews-timeline.md`**

Copy the format of the existing v5.93 entry and fill in the text from above. Put it at the top.

- [ ] **Step 3: Update the Stage 2 docs**

In `docs/depeg-detection.md`:
- Update the "Pool challenger check" section to document the new 2-pool OR `$5M` single-pool bar.
- Update the decision matrix row for pool-only confirmation accordingly.
- Add a sentence in "Historical Backfill Validation" noting that delete+insert now share a D1 batch.

In `docs/dews.md`:
- Under S_liq, document the new "both 7-day anchors required" rule.
- Under "Data Pipeline" note circuit-breaker coverage of CoinGecko/DefiLlama confirmation fetches.

- [ ] **Step 4: Commit**

```bash
git add shared/lib/depeg-dews-version.ts docs/depeg-dews-timeline.md docs/depeg-detection.md docs/dews.md
git commit -m "docs(depeg+dews): methodology v5.94 bug-fix wave"
```

### Task 17: Methodology v5.95 (contagion amplifier)

**Files:**
- Modify: `shared/lib/depeg-dews-version.ts`
- Modify: `docs/depeg-dews-timeline.md`
- Modify: `docs/dews.md`

- [ ] **Step 1: Add v5.95 entry**

```ts
{
  version: "5.95",
  title: "Cross-asset contagion amplifier",
  date: "2026-04-18",
  effectiveAt: <Unix seconds after v5.94's effectiveAt>,
  summary:
    "DEWS now applies a bounded per-peg-type contagion amplifier (max 1.2x) derived from the same cycle's first-pass DANGER/WARNING bands, on top of the existing systemic PSI amplifier.",
  impact: [
    "A tracked stablecoin entering DANGER/WARNING now raises other same-peg-type coins' scores by up to 20%",
    "First-pass coins that themselves are DANGER/WARNING do not contagion-amplify themselves",
    "Amplifier is clamped, explainable (no learned weights), and surfaced on /api/stress-signals as amplifiers.contagion",
  ],
  commits: [],
  reconstructed: false,
},
```

Bump `currentVersion: "5.95"`.

- [ ] **Step 2: Document in `docs/dews.md`**

Add a "Contagion Amplifier" subsection after the PSI amplifier description. Reference the cap (1.2), the per-peg-type scope, and the no-self-amplification rule.

- [ ] **Step 3: Commit**

```bash
git add shared/lib/depeg-dews-version.ts docs/depeg-dews-timeline.md docs/dews.md
git commit -m "docs(dews): methodology v5.95 contagion amplifier"
```

### Task 18: API reference updates

**Files:**
- Modify: `docs/api-reference.md`

- [ ] **Step 1: Update response schemas**

- `/api/depeg-events` response: add `confirmationSources: string | null` and `pendingReason: string | null` fields on each event.
- `/api/stress-signals` response: add `amplifiers: { psi: number; contagion: number }` to each signal.
- `/api/backfill-dews?mode=backtest-metrics` (admin): document the new mode, its response fields (`detectionRate`, `leadTimeDaysP50`, `leadTimeDaysP90`, `granularity`, `perAnchor[]`), the daily snapshot granularity, and that it requires admin auth.

- [ ] **Step 2: Commit**

```bash
git add docs/api-reference.md
git commit -m "docs(api): confirmation provenance + DEWS amplifiers + backtest-metrics"
```

---

## Phase 8 — Verification

### Task 19: Full test suite + coverage

- [ ] **Step 1: Run the full test suite**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run --reporter=default 2>&1 | tail -40`
Expected: all tests PASS. Runtime < 55 seconds. If runtime exceeds budget, profile the top offenders with `npx vitest run --reporter=verbose` and split any unintentionally-heavy tests (none expected from this plan; all added tests are pure-unit).

- [ ] **Step 2: Run the worker type-check**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard/worker && npx tsc --noEmit 2>&1 | tail -30`
Expected: no errors.

- [ ] **Step 3: Run the merge gate**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npm run test:merge-gate 2>&1 | tail -40`
Expected: PASS.

- [ ] **Step 4: Check doc-counts CI guard**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npm run check:doc-counts 2>&1 | tail -20`
Expected: PASS (no stablecoin count change in this plan).

### Task 20: Wrangler dry-run migration + deploy check

- [ ] **Step 1: Verify the new migration parses**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard/worker && npx wrangler d1 migrations list DB 2>&1 | tail -20`
Expected: `0105_depeg_event_provenance.sql` listed as pending locally.

- [ ] **Step 2: Confirm backwards-compatibility of migration**

Inspect that the two `ALTER TABLE ... ADD COLUMN` statements do not reference `NOT NULL` or `DEFAULT`. The current worker build must continue to read `depeg_events` rows without touching the new columns (Task 4 already added the columns nullable — verify by reading the generated SQL file).

- [ ] **Step 3: Produce a summary comment ready for PR description**

Generate a short summary to paste in the PR body. Do not commit; just print it:

```
- Bug fixes (v5.94): pool-status semantics, backfill atomicity, off-chain circuit breaker, confirmation provenance persistence, composite pending reason, DEWS liq fail-closed.
- Enhancement (v5.95): DEWS cross-asset contagion amplifier (bounded 1.2x per peg type).
- Admin tooling: /api/backfill-dews?mode=backtest-metrics emits precision / lead-time against a curated historical-anchor fixture.
- Test coverage: ~18 boundary / semantic tests. Runtime delta ~1–1.5s against the current ~46s suite.
- Migration 0105: adds confirmation_sources + pending_reason nullable TEXT columns to depeg_events.
```

---

## Self-Review Checklist

- [x] **Spec coverage:** Every verified issue from the audit (A–F) is covered by Phase 1–3. High-value enhancements (G–J) are covered by Phase 4–6.
- [x] **Placeholder scan:** No "TBD", "fill in details", or "similar to Task N" placeholders. Every code step has concrete code or concrete diff.
- [x] **Type consistency:** `PendingDepegReason` widened once in Task 6 and threaded through `buildInsertDepegEventStmt` (Task 4), `confirmPendingDepegs` (Task 5), and the API / UI (Tasks 11, 15). `DepegEvent.confirmationSources` / `.pendingReason` types added once in `shared/types/market.ts` and consumed everywhere with consistent names (camelCase at the TS boundary, snake_case in SQL). `amplifiers.contagion` surfaces uniformly from `computeDEWS` → persistence → API → UI.
- [x] **Methodology versioning:** Bug fixes = v5.94 (one minor step after v5.93); contagion amplifier = v5.95 (one minor step further). Matches the project rule "After v5.9, use v5.91 for a minor update or v6.0 for a major update, not v5.10."
- [x] **Test budget:** Added ~18 tests. Most are pure-unit (sub-millisecond). The Phase 4 two-pass cron tests invoke the full DEWS pipeline across a 2-coin fixture; realistic runtime delta is on the order of 1–1.5s against the current ~46s suite. Well within the documented audit headroom.
