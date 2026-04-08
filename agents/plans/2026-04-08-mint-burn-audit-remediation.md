# Mint-Burn Flows Audit Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate all findings from the 2026-04-08 mint-burn flows audit — fixing data accuracy bugs, improving crash resilience, reducing frontend duplication, optimizing D1 query patterns, and expanding test coverage.

**Architecture:** 10 independent tasks ordered correctness-first, then resilience, then optimization, then tests, then polish. Each task is independently committable. Two tasks require D1 migrations (0091, 0092).

**Tech Stack:** TypeScript strict, Vitest, Cloudflare Workers D1, React 19 + TanStack Query

---

## Scope Decisions

**Confirmed non-issues excluded from plan:**
- FlowEventFeed pagination: already guarded with `Math.max(1, ...)` at `src/components/flow-event-feed.tsx:167`
- FlowChart sparse arrays: max 720 entries for 30d is acceptable
- `flow_type` CHECK constraint: D1/SQLite can't ALTER TABLE ADD CONSTRAINT; current TS types are sufficient
- Price resolution null-historical: `findMintBurnHistoricalPrice` returns `null` (not `{price: null}`) when no match — the SQL filters `WHERE price IS NOT NULL` and the return type is `{price: number}`. Guard is defensive only.

---

## File Map

| Task | Files Modified | Files Created |
|------|---------------|---------------|
| 1 | `src/hooks/use-mint-burn-flows.ts`, `src/components/flow-summary-card.tsx`, `src/components/flow-table-logic.ts` | `src/lib/mint-burn-coin-helpers.ts`, `src/lib/__tests__/mint-burn-coin-helpers.test.ts` |
| 2 | `worker/src/lib/mint-burn-pipeline/parse.ts`, `worker/src/lib/__tests__/mint-burn-parse.test.ts` | — |
| 3 | `worker/src/cron/sync-mint-burn.ts`, `worker/src/cron/mint-burn/run-configs.ts` | — |
| 4 | `worker/src/lib/mint-burn-contracts.ts` | — |
| 5 | `worker/src/api/mint-burn-flows.ts` | — |
| 6 | `worker/src/cron/mint-burn/run-state.ts`, `worker/src/cron/mint-burn/run-completion.ts`, `worker/src/cron/sync-mint-burn.ts` | `worker/migrations/0091_mint_burn_run_state_last_config_key.sql`, `worker/src/cron/__tests__/mint-burn-run-state-rotation.test.ts` |
| 7 | `worker/src/lib/mint-burn-pipeline/roundtrip-sweep.ts` | — |
| 8 | `src/components/flow-event-feed.tsx` | — |
| 9 | — | `worker/src/lib/__tests__/mint-burn-canonical-chain.test.ts`, `worker/src/lib/__tests__/mint-burn-health-config.test.ts` |
| 10 | — | `worker/migrations/0092_cleanup_legacy_mint_burn_sync_keys.sql` |

---

### Task 1: Extract duplicated frontend coin-flow helpers

**Why:** `inferHas24hActivity`, `resolvePressureScore`, `resolvePressureState`, and `resolveNetDirection` are duplicated across 3 files with slight divergences. Single source of truth prevents drift.

**Files:**
- Create: `src/lib/mint-burn-coin-helpers.ts`
- Create: `src/lib/__tests__/mint-burn-coin-helpers.test.ts`
- Modify: `src/hooks/use-mint-burn-flows.ts` (remove lines 27-38)
- Modify: `src/components/flow-summary-card.tsx` (remove lines 45-72)
- Modify: `src/components/flow-table-logic.ts` (remove lines 17-23)

- [ ] **Step 1: Write failing test** `src/lib/__tests__/mint-burn-coin-helpers.test.ts`

```typescript
import { describe, expect, it } from "vitest";
import {
  inferHas24hActivity,
  resolvePressureScore,
  resolvePressureState,
  resolveNetDirection,
} from "../mint-burn-coin-helpers";
import type { MintBurnCoinFlow } from "@shared/types";

function stubCoin(overrides: Partial<MintBurnCoinFlow> = {}): MintBurnCoinFlow {
  return {
    stablecoinId: "test",
    symbol: "TEST",
    mintVolume24hUsd: 0,
    burnVolume24hUsd: 0,
    netFlow24hUsd: 0,
    mintCount24h: 0,
    burnCount24h: 0,
    netFlow7dUsd: 0,
    netFlow30dUsd: 0,
    netFlow90dUsd: 0,
    flowIntensity: null,
    ...overrides,
  } as MintBurnCoinFlow;
}

describe("inferHas24hActivity", () => {
  it("returns explicit has24hActivity when present", () => {
    expect(inferHas24hActivity(stubCoin({ has24hActivity: true }))).toBe(true);
    expect(inferHas24hActivity(stubCoin({ has24hActivity: false }))).toBe(false);
  });

  it("derives from volume fields when has24hActivity missing", () => {
    expect(inferHas24hActivity(stubCoin({ mintVolume24hUsd: 100 }))).toBe(true);
    expect(inferHas24hActivity(stubCoin({ burnCount24h: 1 }))).toBe(true);
    expect(inferHas24hActivity(stubCoin())).toBe(false);
  });
});

describe("resolvePressureScore", () => {
  it("prefers pressureShiftScore over flowIntensity", () => {
    expect(resolvePressureScore(stubCoin({ pressureShiftScore: 42, flowIntensity: 10 }))).toBe(42);
  });

  it("falls back to flowIntensity", () => {
    expect(resolvePressureScore(stubCoin({ flowIntensity: 10 }))).toBe(10);
  });

  it("returns null when both absent", () => {
    expect(resolvePressureScore(stubCoin())).toBeNull();
  });
});

describe("resolvePressureState", () => {
  it("returns explicit state when present", () => {
    expect(resolvePressureState(stubCoin({ pressureShiftState: "improving" }))).toBe("improving");
  });

  it("derives from score when state missing", () => {
    expect(resolvePressureState(stubCoin({ pressureShiftScore: 50 }))).toBe("improving");
    expect(resolvePressureState(stubCoin({ pressureShiftScore: -50 }))).toBe("worsening");
  });
});

describe("resolveNetDirection", () => {
  it("returns explicit direction when present", () => {
    expect(resolveNetDirection(stubCoin({ netFlowDirection24h: "minting" }))).toBe("minting");
  });

  it("derives from net flow when direction missing", () => {
    expect(resolveNetDirection(stubCoin({ netFlow24hUsd: 1000, mintVolume24hUsd: 1000 }))).toBe("minting");
  });
});
```

- [ ] **Step 2: Run test — expect FAIL** (module not found)

```bash
npm test -- --run src/lib/__tests__/mint-burn-coin-helpers.test.ts
```

- [ ] **Step 3: Create** `src/lib/mint-burn-coin-helpers.ts`

```typescript
import type { MintBurnCoinFlow } from "@shared/types";
import {
  getNetFlowDirection24h,
  getPressureShiftState,
  type NetFlowDirection24h,
  type PressureShiftState,
} from "@shared/lib/mint-burn-signals";

/** Canonical activity inference — checks explicit flag first, then derives from fields. */
export function inferHas24hActivity(coin: MintBurnCoinFlow): boolean {
  if (coin.has24hActivity !== undefined) return coin.has24hActivity;
  return Boolean(
    coin.mintCount24h
    || coin.burnCount24h
    || coin.mintVolume24hUsd
    || coin.burnVolume24hUsd
    || coin.netFlow24hUsd,
  );
}

export function resolvePressureScore(coin: MintBurnCoinFlow): number | null {
  return coin.pressureShiftScore ?? coin.flowIntensity;
}

export function resolvePressureState(coin: MintBurnCoinFlow): PressureShiftState {
  return coin.pressureShiftState ?? getPressureShiftState(resolvePressureScore(coin));
}

export function resolveNetDirection(coin: MintBurnCoinFlow): NetFlowDirection24h {
  return coin.netFlowDirection24h
    ?? getNetFlowDirection24h({
      netFlow24hUsd: coin.netFlow24hUsd,
      has24hActivity: inferHas24hActivity(coin),
    });
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm test -- --run src/lib/__tests__/mint-burn-coin-helpers.test.ts
```

- [ ] **Step 5: Update consumers**

In `src/hooks/use-mint-burn-flows.ts`: remove local `inferHas24hActivity` (lines 27-38), import from `@/lib/mint-burn-coin-helpers`. The hook version takes `MintBurnFlowsResponse["coins"][number]` while the shared one takes `MintBurnCoinFlow` — confirm these types are compatible (MintBurnCoinFlow is the union type used by the response). If not, cast or adjust the shared version.

**Behavior note:** The hook's `inferHas24hActivity` uses `??` chaining (`coin.has24hActivity ?? coin.mintCount24h ?? ...`), which treats `0` as non-nullish and stops early. The shared version uses `||` (from `flow-summary-card.tsx`), which skips `0` as falsy. The `||` behavior is correct: `mintCount24h: 0` should NOT indicate activity. This is a minor behavior fix for the hook.

In `src/components/flow-summary-card.tsx`: remove local `inferHas24hActivity`, `resolveNetDirection`, `resolvePressureScore`, `resolvePressureState` (lines 45-72). Import all four from `@/lib/mint-burn-coin-helpers`.

In `src/components/flow-table-logic.ts`: remove local `getPressureScore` and `getPressureState` (lines 17-23). Import `resolvePressureScore as getPressureScore` and `resolvePressureState as getPressureState` from `@/lib/mint-burn-coin-helpers` to preserve the public names used by `compareFlowRows` and external callers. Also remove the now-unused `getPressureShiftState` import from line 1 (only `PRESSURE_SHIFT_STATE_VALUES` and `type PressureShiftState` are still needed from `@shared/lib/mint-burn-signals`).

- [ ] **Step 6: Run full validation**

```bash
npm test -- --run src/lib/__tests__/mint-burn-coin-helpers.test.ts src/components/__tests__/flow-table.test.ts src/hooks/__tests__/use-mint-burn-flows.test.tsx
npm run build
```

- [ ] **Step 7: Commit**

```
refactor: extract duplicated mint-burn coin-flow helpers into shared module
```

---

### Task 2: Add defensive null guard to price resolution

**Why:** `resolveEventPrice` at `parse.ts:21` checks `if (historical)` — while the current type system guarantees `price: number`, a runtime schema drift (e.g., a D1 migration adding a nullable price column) could surface a truthy object with `price: null`. Zero-cost defensive improvement.

**Files:**
- Modify: `worker/src/lib/mint-burn-pipeline/parse.ts:21`
- Modify: `worker/src/lib/__tests__/mint-burn-parse.test.ts` (append new describe block)

- [ ] **Step 1: Write failing test** `worker/src/lib/__tests__/mint-burn-parse.test.ts`

```typescript
import { describe, expect, it } from "vitest";
import { parseMintBurnLogs } from "../mint-burn-pipeline/parse";
import type { MintBurnContractConfig, MintBurnEventDef } from "../mint-burn-contracts";
import type { AlchemyLogEntry } from "../alchemy-logs";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_PADDED = "0x0000000000000000000000000000000000000000000000000000000000000000";
const RECIPIENT = "0x000000000000000000000000abcdefabcdefabcdefabcdefabcdefabcdefabcd";

function stubConfig(overrides?: Partial<MintBurnContractConfig>): MintBurnContractConfig {
  return {
    chain: { chainId: "ethereum", explorerUrl: "https://etherscan.io", rpcSuffix: "eth-mainnet" } as any,
    stablecoinId: "test-coin",
    symbol: "TEST",
    contractAddress: "0x1234",
    decimals: 6,
    dustThreshold: 1,
    startBlock: 1,
    events: [],
    adapterKind: "transfer-zero-address",
    startBlockSource: "test",
    startBlockConfidence: "high",
    ...overrides,
  };
}

function stubMintEventDef(): MintBurnEventDef {
  return {
    signature: "Transfer(address,address,uint256)",
    topicHash: TRANSFER_TOPIC,
    direction: "mint",
    amountEncoding: "transfer-value",
    filterTopic: { index: 1, value: ZERO_PADDED },
  };
}

function stubLog(amount: bigint, blockNumber: number): AlchemyLogEntry {
  return {
    address: "0x1234",
    topics: [TRANSFER_TOPIC, ZERO_PADDED, RECIPIENT],
    data: "0x" + amount.toString(16).padStart(64, "0"),
    blockNumber: "0x" + blockNumber.toString(16),
    transactionHash: "0xabc123",
    logIndex: "0x0",
    blockHash: "0xdef",
    transactionIndex: "0x0",
    removed: false,
  };
}

describe("parseMintBurnLogs — price resolution", () => {
  const config = stubConfig();
  const eventDef = stubMintEventDef();
  const blockTimestamps = new Map([[100, 1700000000]]);
  const runTimestamp = 1700000100;

  it("uses current price when no historical data exists", () => {
    const prices = new Map([["test-coin", 1.0]]);
    const priceHistory = new Map<string, { snapshotDate: number; price: number }[]>();

    const { rows } = parseMintBurnLogs(config, eventDef, [stubLog(1_000_000n, 100)], blockTimestamps, prices, priceHistory, runTimestamp);
    expect(rows[0].price_source).toBe("price-cache-current");
    expect(rows[0].amount_usd).toBe(1.0);
  });

  it("uses historical price when available", () => {
    const prices = new Map([["test-coin", 0.99]]);
    const dayTs = Math.floor(1700000000 / 86400) * 86400;
    const priceHistory = new Map([["test-coin", [{ snapshotDate: dayTs, price: 1.01 }]]]);

    const { rows } = parseMintBurnLogs(config, eventDef, [stubLog(1_000_000n, 100)], blockTimestamps, prices, priceHistory, runTimestamp);
    expect(rows[0].price_source).toBe("supply-history-daily");
    expect(rows[0].amount_usd).toBeCloseTo(1.01);
  });

  it("falls through to current price when historical price is null at runtime", () => {
    const prices = new Map([["test-coin", 1.0]]);
    const dayTs = Math.floor(1700000000 / 86400) * 86400;
    // Simulate runtime drift: historical row exists but price is null
    const priceHistory = new Map([["test-coin", [{ snapshotDate: dayTs, price: null as any }]]]);

    const { rows } = parseMintBurnLogs(config, eventDef, [stubLog(1_000_000n, 100)], blockTimestamps, prices, priceHistory, runTimestamp);
    expect(rows[0].price_source).toBe("price-cache-current");
    expect(rows[0].amount_usd).toBe(1.0);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL** (third test fails: price_source is "supply-history-daily" with null amount)

```bash
npm test -- --run worker/src/lib/__tests__/mint-burn-parse.test.ts
```

- [ ] **Step 3: Fix** `worker/src/lib/mint-burn-pipeline/parse.ts:21`

Change:
```typescript
  if (historical) {
```
To:
```typescript
  if (historical?.price != null) {
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm test -- --run worker/src/lib/__tests__/mint-burn-parse.test.ts
cd worker && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```
fix(mint-burn): guard price resolution against null historical price at runtime
```

---

### Task 3: Crash-resilient hourly recalc via externalized affectedHours

**Why:** `runMintBurnConfigPhase` creates `affectedHours` internally (run-configs.ts:77) and returns it. If the function throws (abort signal, unhandled error), the accumulated hours are lost and `recalcAffectedHours` at sync-mint-burn.ts:265 never runs. Fix: pass the map in as an input, wrap the caller in try/finally.

**Files:**
- Modify: `worker/src/cron/mint-burn/run-configs.ts` (lines 35, 38-59, 77, 235-253)
- Modify: `worker/src/cron/sync-mint-burn.ts` (lines 229-265)

- [ ] **Step 1: Modify `MintBurnRunConfigPhaseResult`** in `run-configs.ts`

Remove `affectedHours` from the return type (line 35):
```typescript
// Delete: affectedHours: Map<string, MintBurnAffectedHour>;
```

Add `affectedHours` as an input parameter to the function signature (line 38-59):
```typescript
export async function runMintBurnConfigPhase(input: {
  // ... existing fields ...
  affectedHours: Map<string, MintBurnAffectedHour>;  // add this
}): Promise<MintBurnRunConfigPhaseResult> {
```

Remove the local creation at line 77:
```typescript
// Delete: const affectedHours = new Map<string, MintBurnAffectedHour>();
```

Replace with a reference to the input:
```typescript
const affectedHours = input.affectedHours;
```

Remove `affectedHours` from the return object (line 252).

- [ ] **Step 2: Update caller** in `sync-mint-burn.ts` (lines 229-265)

Add the import at the top of the file (near the existing `mint-burn-pipeline/context` import at line 9):
```typescript
import type { MintBurnAffectedHour } from "../lib/mint-burn-pipeline/types";
```

Create the map before the call, wrap in try/finally:
```typescript
  const affectedHours = new Map<string, MintBurnAffectedHour>();

  let phaseResult!: MintBurnRunConfigPhaseResult; // definite assignment: always set if execution reaches past try/finally
  try {
    phaseResult = await runMintBurnConfigPhase({
      db,
      configs,
      lane,
      jobName,
      reportProgress,
      budget,
      chainContexts,
      signal,
      runTimestamp,
      priceContext: { prices, priceHistory },
      lastBlocksAfterRun,
      maxScanRange: MAX_SCAN_RANGE,
      criticalConfigBudgetLimit: CRITICAL_CONFIG_BUDGET_LIMIT,
      extendedConfigBudgetLimit: EXTENDED_CONFIG_BUDGET_LIMIT,
      evmSafetyMarginBlocks: EVM_SAFETY_MARGIN_BLOCKS,
      affectedHours,
    });
  } finally {
    // Always recalc whatever hours accumulated, even on partial failure
    if (affectedHours.size > 0) {
      try {
        await recalcAffectedHours(db, affectedHours);
      } catch (recalcError) {
        console.error("[sync-mint-burn] recalcAffectedHours failed in finally block:", recalcError);
      }
    }
  }

  const {
    rowsRead, rowsParsed, rowsInserted, rowsIgnored, rowsDropped,
    contractsProcessed, contractsSkipped, contractsDeferredExtended,
    apiErrors, effectiveBurns, bridgeBurns, reviewBurns,
    atomicRoundtripsTotal, criticalContractsSatisfied, criticalContractsUnsatisfied,
    configBreakdown,
  } = phaseResult;

  // Remove the standalone recalcAffectedHours call that was at line 265
  // (now handled in finally block above)
```

- [ ] **Step 3: Verify type-check and existing tests**

```bash
cd worker && npx tsc --noEmit
npm test -- --run worker/src/cron
```

- [ ] **Step 4: Commit**

```
fix(mint-burn): ensure hourly recalc runs even on partial sync failure
```

---

### Task 4: Replace start block magic number with explicit flag

**Why:** `resolveMintBurnContractConfig` at `mint-burn-contracts.ts:171` infers `defaultedStartBlock` by comparing `startBlock === 21_900_000`. Any coin legitimately deployed at that block gets incorrectly flagged as "low" confidence.

**Files:**
- Modify: `worker/src/lib/mint-burn-contracts.ts` (lines 63-78, 169-173, and config specs ~275-807)

- [ ] **Step 1: Add `isDefaultStartBlock` to spec interface** (line 63-78)

```typescript
interface MintBurnContractConfigSpec {
  // ... existing fields ...
  isDefaultStartBlock?: boolean;  // add after startBlockConfidence
}
```

- [ ] **Step 2: Replace magic number** at lines 171-173

Change:
```typescript
  const defaultedStartBlock = spec.startBlock === 21_900_000
    && spec.tier === "extended"
    && adapterKind === "transfer-zero-address";
```
To:
```typescript
  const defaultedStartBlock = spec.isDefaultStartBlock === true;
```

- [ ] **Step 3: Add `isDefaultStartBlock: true` to all config specs that currently match**

Search for configs with `startBlock: 21_900_000` AND `tier: "extended"` that don't have explicit `startBlockSource` or `startBlockConfidence`. Add `isDefaultStartBlock: true` to each. Configs with explicit `startBlockSource` or `startBlockConfidence` should NOT get the flag (they were intentionally configured).

Run:
```bash
# Find all configs that would have matched the old magic number check
cd worker && grep -n "startBlock: 21_900_000" src/lib/mint-burn-contracts.ts
```

For each matching extended-tier config that relies on the default, add `isDefaultStartBlock: true`.

- [ ] **Step 4: Verify**

```bash
cd worker && npx tsc --noEmit
npm test -- --run worker/src/lib/__tests__/mint-burn-contracts.test.ts
```

- [ ] **Step 5: Commit**

```
fix(mint-burn): replace start-block magic number with explicit isDefaultStartBlock flag
```

---

### Task 5: Batch D1 queries in aggregate mint-burn-flows API

**Why:** `fetchAggregateData` sends 10 queries via `Promise.all`, each a separate HTTP roundtrip to D1. The first 8 are plain SQL that can be sent as a single `db.batch()` call, reducing roundtrips from 10 to 3 (1 batch + 2 helper calls with internal batching).

**Files:**
- Modify: `worker/src/api/mint-burn-flows.ts` (lines 200-305)

- [ ] **Step 1: Refactor `fetchAggregateData`**

Replace lines 208-305. Prepare 8 statements, send via `db.batch()`, then run the 2 helper calls separately:

```typescript
async function fetchAggregateData(
  db: D1Database,
  params: AggregateQueryParams,
): Promise<AggregateData> {
  const trackedPairs = getMintBurnTrackedPairs();
  const trackedChainIds = [...new Set(MINT_BURN_CONFIGS.map((config) => config.chain.chainId))];
  const chainInClause = buildInClause(trackedChainIds);

  // Batch 8 SQL queries into a single D1 HTTP roundtrip
  const batchResults = await db.batch([
    // [0] hourlyWindow
    db.prepare(
      `SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
              mint_volume_usd, burn_volume_usd, net_flow_usd
       FROM mint_burn_hourly
       WHERE chain_id IN (${chainInClause.sql}) AND hour_ts >= ?
       ORDER BY hour_ts ASC`,
    ).bind(...chainInClause.binds, params.windowStart),
    // [1] hourly24h
    db.prepare(
      `SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
              mint_volume_usd, burn_volume_usd, net_flow_usd
       FROM mint_burn_hourly
       WHERE chain_id IN (${chainInClause.sql}) AND hour_ts >= ?
       ORDER BY hour_ts ASC`,
    ).bind(...chainInClause.binds, params.window24h),
    // [2] hourly7d grouped
    db.prepare(
      `SELECT stablecoin_id, chain_id, SUM(net_flow_usd) as net_flow_usd
       FROM mint_burn_hourly
       WHERE chain_id IN (${chainInClause.sql}) AND hour_ts >= ?
       GROUP BY stablecoin_id, chain_id`,
    ).bind(...chainInClause.binds, params.window7d),
    // [3] hourly30d grouped
    db.prepare(
      `SELECT stablecoin_id, chain_id, SUM(net_flow_usd) as net_flow_usd
       FROM mint_burn_hourly
       WHERE chain_id IN (${chainInClause.sql}) AND hour_ts >= ?
       GROUP BY stablecoin_id, chain_id`,
    ).bind(...chainInClause.binds, params.window30d),
    // [4] hourly90d grouped
    db.prepare(
      `SELECT stablecoin_id, chain_id, SUM(net_flow_usd) as net_flow_usd
       FROM mint_burn_hourly
       WHERE chain_id IN (${chainInClause.sql}) AND hour_ts >= ?
       GROUP BY stablecoin_id, chain_id`,
    ).bind(...chainInClause.binds, params.window90d),
    // [5] baselineDaily
    db.prepare(
      `SELECT stablecoin_id, chain_id,
              (hour_ts / 86400) * 86400 as day_ts,
              SUM(net_flow_usd) as daily_net,
              SUM(mint_volume_usd + burn_volume_usd) as daily_abs
       FROM mint_burn_hourly
       WHERE chain_id IN (${chainInClause.sql}) AND hour_ts >= ? AND hour_ts < ?
       GROUP BY stablecoin_id, chain_id, day_ts`,
    ).bind(...chainInClause.binds, params.baselineWindowStart, params.nowDayTs),
    // [6] firstSeen
    db.prepare(
      `SELECT stablecoin_id, chain_id, MIN(hour_ts) as first_hour_ts
       FROM mint_burn_hourly
       WHERE chain_id IN (${chainInClause.sql})
       GROUP BY stablecoin_id, chain_id`,
    ).bind(...chainInClause.binds),
    // [7] largestEvents
    db.prepare(
      `SELECT id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd,
              counterparty, tx_hash, block_number, timestamp, explorer_tx_url
       FROM mint_burn_events
       WHERE chain_id IN (${chainInClause.sql})
         AND timestamp >= ?
         AND (direction = 'mint' OR burn_type = 'effective_burn')
         AND flow_type = 'standard'`,
    ).bind(...chainInClause.binds, params.window24h),
  ]);

  // Access .results following codebase convention (see api-pagination.ts:69-70)
  const hourlyWindowResult = { results: (batchResults[0].results ?? []) as HourlyRow[] };
  const hourly24hResult = { results: (batchResults[1].results ?? []) as HourlyRow[] };
  const hourly7dResult = { results: (batchResults[2].results ?? []) as GroupedNetFlowRow[] };
  const hourly30dResult = { results: (batchResults[3].results ?? []) as GroupedNetFlowRow[] };
  const hourly90dResult = { results: (batchResults[4].results ?? []) as GroupedNetFlowRow[] };
  const baselineDailyResult = { results: (batchResults[5].results ?? []) as DailyBaselineRow[] };
  const firstSeenResult = { results: (batchResults[6].results ?? []) as FirstSeenRow[] };
  const largestEventsResult = { results: (batchResults[7].results ?? []) as EventRow[] };

  // These have internal batching and can't be inlined into db.batch()
  const [lastBlocks, latestCronSnapshot] = await Promise.all([
    readMintBurnSyncStateBatch(db, MINT_BURN_CONFIGS),
    readMintBurnCronSnapshot(db),
  ]);

  // ... rest of function unchanged from line 307 onward
```

- [ ] **Step 2: Verify**

```bash
cd worker && npx tsc --noEmit
npm run build
```

- [ ] **Step 3: Commit**

```
perf(mint-burn): batch 8 D1 queries into single request in aggregate flows API
```

---

### Task 6: Key-based run-state rotation with D1 migration

**Why:** `nextConfigIndex` uses a numeric index into `enabledConfigs`. If configs are added/removed between runs, the index points to a different config, causing unfair scheduling. Using a config key string is stable across additions/removals.

**Files:**
- Create: `worker/migrations/0091_mint_burn_run_state_last_config_key.sql`
- Create: `worker/src/cron/__tests__/mint-burn-run-state-rotation.test.ts`
- Modify: `worker/src/cron/mint-burn/run-state.ts` (lines 3-6, 22-46, 48-72)
- Modify: `worker/src/cron/mint-burn/run-completion.ts` (lines 81-84)
- Modify: `worker/src/cron/sync-mint-burn.ts` (line 184)

- [ ] **Step 1: Create migration** `worker/migrations/0091_mint_burn_run_state_last_config_key.sql`

```sql
ALTER TABLE mint_burn_run_state ADD COLUMN last_config_key TEXT;
```

- [ ] **Step 2: Write failing test** `worker/src/cron/__tests__/mint-burn-run-state-rotation.test.ts`

```typescript
import { describe, expect, it } from "vitest";
import { resolveStartIndex } from "../mint-burn/run-state";

describe("resolveStartIndex", () => {
  const configs = [
    { key: "ethereum-0xaaa" },
    { key: "ethereum-0xbbb" },
    { key: "ethereum-0xccc" },
  ];
  const keyFn = (c: { key: string }) => c.key;

  it("returns index after the last-processed config", () => {
    expect(resolveStartIndex("ethereum-0xaaa", configs, keyFn)).toBe(1);
    expect(resolveStartIndex("ethereum-0xbbb", configs, keyFn)).toBe(2);
  });

  it("wraps around at end of list", () => {
    expect(resolveStartIndex("ethereum-0xccc", configs, keyFn)).toBe(0);
  });

  it("returns 0 when key not found (config was removed)", () => {
    expect(resolveStartIndex("ethereum-0xzzz", configs, keyFn)).toBe(0);
  });

  it("returns 0 when key is null (first run)", () => {
    expect(resolveStartIndex(null, configs, keyFn)).toBe(0);
  });

  it("returns 0 for empty config list", () => {
    expect(resolveStartIndex("ethereum-0xaaa", [], keyFn)).toBe(0);
  });
});
```

- [ ] **Step 3: Run test — expect FAIL**

```bash
npm test -- --run worker/src/cron/__tests__/mint-burn-run-state-rotation.test.ts
```

- [ ] **Step 4: Implement `resolveStartIndex`** in `run-state.ts`

```typescript
/** Find the rotation start index based on last-processed config key. */
export function resolveStartIndex<T>(
  lastConfigKey: string | null,
  configs: T[],
  keyFn: (config: T) => string,
): number {
  if (!lastConfigKey || configs.length === 0) return 0;
  const idx = configs.findIndex((c) => keyFn(c) === lastConfigKey);
  if (idx < 0) return 0;
  return (idx + 1) % configs.length;
}
```

Add `lastConfigKey: string | null` to `MintBurnRunStateRow`.

Update `getMintBurnRunState` to read `last_config_key`:
```typescript
.prepare("SELECT next_config_index, degraded_streak, last_config_key FROM mint_burn_run_state WHERE job = ?")
// ...
lastConfigKey: row?.last_config_key ?? null,
```

Update `setMintBurnRunState` signature to accept `lastConfigKey: string | null`:
```typescript
export async function setMintBurnRunState(
  db: D1Database,
  jobName: string,
  nextConfigIndex: number,
  degradedStreak: number,
  lastConfigKey: string | null,
): Promise<boolean> {
```

Update the INSERT to include `last_config_key`:
```typescript
.prepare(
  `INSERT INTO mint_burn_run_state (job, next_config_index, degraded_streak, last_config_key, updated_at)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(job) DO UPDATE SET
     next_config_index = excluded.next_config_index,
     degraded_streak = excluded.degraded_streak,
     last_config_key = excluded.last_config_key,
     updated_at = excluded.updated_at`,
)
.bind(jobName, nextConfigIndex, degradedStreak, lastConfigKey, now)
```

- [ ] **Step 5: Update `sync-mint-burn.ts`** line 184

`mintBurnConfigKey` is already imported at line 14 via `sync-state`. Add only the new import:
```typescript
import { resolveStartIndex } from "./mint-burn/run-state";
```

Replace line 184:
```typescript
// Replace:
// const startIndex = runState.nextConfigIndex % enabledConfigs.length;
const startIndex = resolveStartIndex(
  runState.lastConfigKey,
  enabledConfigs,
  (c) => mintBurnConfigKey(c),
);
```

- [ ] **Step 6: Update `run-completion.ts`** lines 81-84

`mintBurnConfigKey` is already imported at line 4. Replace the nextConfigIndex calculation:
```typescript
// Replace lines 81-84:
const nextConfigIndex = input.enabledConfigs.length > 0
  ? (input.startIndex + 1) % input.enabledConfigs.length
  : 0;
// Track the config AT startIndex (the one we just rotated FROM) — stable across additions/removals
const lastConfigKey = input.enabledConfigs.length > 0
  ? mintBurnConfigKey(input.enabledConfigs[input.startIndex % input.enabledConfigs.length])
  : null;
const runStatePersisted = await setMintBurnRunState(
  input.db, input.jobName, nextConfigIndex, degradedStreak, lastConfigKey,
);
```

- [ ] **Step 7: Run test and verify**

```bash
npm test -- --run worker/src/cron/__tests__/mint-burn-run-state-rotation.test.ts
cd worker && npx tsc --noEmit
npm run check:migrations
```

- [ ] **Step 8: Commit**

```
fix(mint-burn): use config key instead of index for run-state rotation
```

---

### Task 7: Extend roundtrip sweep lookback to 7 days

**Why:** 48h lookback may miss atomic roundtrips confirmed after L2 sequencer delays. The sweep is already capped at 200 candidates per run (SWEEP_LIMIT), so a wider window doesn't cause performance issues.

**Files:**
- Modify: `worker/src/lib/mint-burn-pipeline/roundtrip-sweep.ts` (lines 5-6, 19-22)

- [ ] **Step 1: Change default lookback** at line 5

```typescript
// Change from:
const SWEEP_LOOKBACK_SEC = 48 * 3600;
// To:
const SWEEP_LOOKBACK_SEC = 7 * 24 * 3600; // 7 days; capped by SWEEP_LIMIT per run
```

- [ ] **Step 2: Add optional `lookbackSec` parameter** to the function signature (line 19-22)

```typescript
export async function sweepRecentRoundtrips(
  db: D1Database,
  nowSec: number,
  lookbackSec = SWEEP_LOOKBACK_SEC,
): Promise<RoundtripSweepResult> {
  const cutoff = nowSec - lookbackSec;
```

- [ ] **Step 3: Verify**

```bash
cd worker && npx tsc --noEmit
npm test -- --run worker/src/lib/__tests__/mint-burn-roundtrip.test.ts
```

- [ ] **Step 4: Commit**

```
fix(mint-burn): extend roundtrip sweep lookback from 48h to 7d
```

---

### Task 8: Sanitize error messages in flow event feed

**Why:** Raw error messages from API/network are exposed to users. Replace with a user-friendly message and log the actual error for debugging.

**Files:**
- Modify: `src/components/flow-event-feed.tsx` (line 159)

- [ ] **Step 1: Change line 159**

From:
```typescript
  if (isError) return <FeedError message={error instanceof Error ? error.message : "Unknown error"} />;
```
To:
```typescript
  if (isError) return <FeedError message="Please try again in a few moments." />;
```

Note: TanStack Query already logs errors internally. Adding `console.error` in the render path would fire on every re-render while the error persists. Omit it.

- [ ] **Step 2: Verify**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```
fix: replace raw error message with user-friendly text in flow event feed
```

---

### Task 9: Add tests for canonical-chain and health-config modules

**Why:** Two worker modules lack unit tests. These are load-bearing for data accuracy (canonical chain filtering) and operational health (freshness monitoring).

**Files:**
- Create: `worker/src/lib/__tests__/mint-burn-canonical-chain.test.ts`
- Create: `worker/src/lib/__tests__/mint-burn-health-config.test.ts`

- [ ] **Step 1: Write canonical-chain tests**

```typescript
import { describe, expect, it } from "vitest";
import { isCanonicalMintBurnPair } from "../mint-burn-canonical-chain";

describe("isCanonicalMintBurnPair", () => {
  it("USDai canonical chain is arbitrum", () => {
    expect(isCanonicalMintBurnPair("usdai-usd-ai", "arbitrum")).toBe(true);
    expect(isCanonicalMintBurnPair("usdai-usd-ai", "ethereum")).toBe(false);
  });

  it("defaults to ethereum for unspecified coins", () => {
    expect(isCanonicalMintBurnPair("usdc-circle", "ethereum")).toBe(true);
    expect(isCanonicalMintBurnPair("usdc-circle", "arbitrum")).toBe(false);
  });

  it("handles unknown stablecoin ID gracefully", () => {
    expect(isCanonicalMintBurnPair("nonexistent", "ethereum")).toBe(true);
  });
});
```

- [ ] **Step 2: Write health-config tests**

```typescript
import { describe, expect, it } from "vitest";
import {
  computeMintBurnSyncFreshnessStatus,
  resolveMintBurnFreshnessConfig,
} from "../mint-burn-health-config";

describe("resolveMintBurnFreshnessConfig", () => {
  it("returns defaults with no env overrides", () => {
    const config = resolveMintBurnFreshnessConfig({});
    expect(config.majorSymbols).toContain("USDT");
    expect(config.majorSymbols).toContain("USDC");
    expect(config.staleWarnSec).toBeGreaterThan(0);
    expect(config.staleCritSec).toBeGreaterThan(config.staleWarnSec);
  });

  it("overrides major symbols from env", () => {
    const config = resolveMintBurnFreshnessConfig({
      MINT_BURN_MAJOR_SYMBOLS: "USDC,DAI",
    });
    expect(config.majorSymbols).toEqual(["USDC", "DAI"]);
  });
});

describe("computeMintBurnSyncFreshnessStatus", () => {
  // MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC = 40 * 60 = 2400
  const MAX_AGE = 2400;

  it("returns fresh when age ratio <= 1.0", () => {
    // age = 1200s → ratio 0.5
    expect(computeMintBurnSyncFreshnessStatus(10000, 10000 - 1200)).toBe("fresh");
    // age = 2400s → ratio 1.0
    expect(computeMintBurnSyncFreshnessStatus(10000, 10000 - MAX_AGE)).toBe("fresh");
  });

  it("returns degraded when age ratio <= 1.5", () => {
    // age = 2880s → ratio 1.2
    expect(computeMintBurnSyncFreshnessStatus(10000, 10000 - 2880)).toBe("degraded");
    // age = 3600s → ratio 1.5
    expect(computeMintBurnSyncFreshnessStatus(10000, 10000 - 3600)).toBe("degraded");
  });

  it("returns stale when age ratio > 1.5", () => {
    // age = 4800s → ratio 2.0
    expect(computeMintBurnSyncFreshnessStatus(10000, 10000 - 4800)).toBe("stale");
  });

  it("returns stale when lastSuccessfulSyncAt is null", () => {
    expect(computeMintBurnSyncFreshnessStatus(10000, null)).toBe("stale");
  });
});
```

- [ ] **Step 3: Run tests — expect PASS**

```bash
npm test -- --run worker/src/lib/__tests__/mint-burn-canonical-chain.test.ts worker/src/lib/__tests__/mint-burn-health-config.test.ts
```

- [ ] **Step 4: Commit**

```
test(mint-burn): add unit tests for canonical-chain and health-config modules
```

---

### Task 10: Clean up legacy sync state keys via migration

**Why:** `readMintBurnSyncStateBatch` at sync-state.ts:52-80 reads both canonical keys (`chainId-address`) and legacy keys (`stablecoinId:chainId:address`). The legacy rows are orphaned since canonical keys have been the primary format since the March 2026 refactor. Remove them to reduce table bloat and query overhead.

**Files:**
- Create: `worker/migrations/0092_cleanup_legacy_mint_burn_sync_keys.sql`

- [ ] **Step 1: Create migration**

```sql
-- Remove legacy sync state rows in stablecoinId:chainId:address format.
-- Canonical keys use chainId-contractAddress format (no colon separators).
DELETE FROM mint_burn_sync_state WHERE config_key LIKE '%:%';
```

- [ ] **Step 2: Verify migration is valid**

```bash
npm run check:migrations
```

- [ ] **Step 3: Commit**

```
chore(mint-burn): clean up legacy sync state keys via migration
```

---

## Execution Order

```
1 → 2 → 3 → 4 → 5 → 7 → 9 → 6 → 8 → 10
```

Task 1 refactor first (unblocks clean consumer code), then correctness (2, 3, 4), then perf (5), then resilience (7), then tests (9), then schema (6, 10), then polish (8).

## Verification

After all tasks, run the full merge gate:

```bash
npm run test:merge-gate
```

This covers lint, type-check, tests, build, and worker type-check.
