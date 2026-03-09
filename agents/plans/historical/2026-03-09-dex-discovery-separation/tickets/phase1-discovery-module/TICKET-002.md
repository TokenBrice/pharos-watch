---
title: "Create discovery cron orchestrator with tiered priority and backoff"
agent: codex
model: gpt-5.4
reasoning_effort: high
done: false
---

## Goal

Create the orchestrator that reads current coverage + backoff state, computes effective tiers, orders coins for crawling, and runs the budget loop.

## Context

The discovery cron runs on the 20-minute trigger (`3,23,43 * * * *`) alongside blacklist and mint-burn. It gets ~15 min of wall-clock budget. It must use strictly sequential fetches (1 connection at a time) to coexist within the 6-connection pool.

## Task

1. Read these files for context:
   - `worker/src/cron/dex-discovery/types.ts` — `DISCOVERY_TIERS`, `DiscoveryMeta`, `StagedPool` (created by TICKET-001)
   - `shared/lib/stablecoins.ts` — exports `TRACKED_STABLECOINS` (array of `StablecoinMeta` with `id`, `contracts` map). Already excludes shadow stablecoins — no filtering needed.
   - `worker/src/cron/dex-liquidity/orchestrator.ts` — existing orchestrator for pattern reference (how it returns `CronResult`, uses `AbortSignal`, handles errors)
   - `worker/src/lib/db.ts` — exports `CronResult` interface (line ~139)
   - `worker/src/lib/abort.ts` — exports `throwIfAborted(signal)` and `sleepWithSignal(ms, signal)`

2. Create `worker/src/cron/dex-discovery/orchestrator.ts` implementing `syncDexDiscovery()`:

```typescript
import type { CronResult } from "../../lib/db";
import { throwIfAborted } from "../../lib/abort";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import type { DiscoveryMeta } from "./types";
import { DISCOVERY_TIERS } from "./types";
```

```typescript
export async function syncDexDiscovery(
  db: D1Database,
  cgApiKey: string | null,
  signal?: AbortSignal,
): Promise<CronResult>
```

Note: `D1Database` is a global type in the Cloudflare Workers runtime — do NOT import it.

The function must implement these phases:

### Phase A: Read current state (~1 sec)

a) Query `dex_liquidity` for all rows: `SELECT stablecoin_id, pool_count, chain_count FROM dex_liquidity WHERE stablecoin_id != '__global__'`. Build a `Map<string, { poolCount: number; chainCount: number }>`.

b) Call `readDiscoveryMeta(db)` from `./persistence.ts` (TICKET-004) to get backoff state. For now, create a minimal stub file `persistence.ts` with the correct type signatures so the import compiles:

```typescript
// worker/src/cron/dex-discovery/persistence.ts — stub (replaced by TICKET-004)
import type { StagedPool, DiscoveryMeta } from "./types";
export async function readDiscoveryMeta(_db: D1Database): Promise<Map<string, DiscoveryMeta>> { return new Map(); }
export async function incrementRunSeq(_db: D1Database): Promise<number> { return 1; }
export async function upsertStagedPools(_db: D1Database, _pools: StagedPool[]): Promise<void> {}
export async function updateDiscoveryMeta(_db: D1Database, _id: string, _found: number, _now: number): Promise<void> {}
export async function cleanupStaging(_db: D1Database, _now: number): Promise<void> {}
```

c) Call `incrementRunSeq(db)` from `./persistence.ts` to get the current sequence number.

### Phase B: Compute tiers and filter eligible coins

d) Iterate over `TRACKED_STABLECOINS` (imported from `@shared/lib/stablecoins`). This array already excludes shadow stablecoins — no additional filter needed.

e) For each coin, compute the effective tier using an exported pure function:

```typescript
export type EffectiveTier = "t1" | "t2" | "t3" | "dormant" | "skip";

/**
 * @param nowSec — current time in epoch seconds (passed explicitly for testability)
 */
export function computeEffectiveTier(
  poolCount: number,
  chainCount: number,
  meta: DiscoveryMeta | undefined,
  runSeq: number,
  nowSec: number,
): EffectiveTier
```

Logic:
- Base tier: `poolCount === 0` -> T1, `poolCount <= T2_MAX_POOLS || chainCount <= 1` -> T2, else -> T3
- Apply backoff from `meta?.consecutiveMisses`:
  - `>= BACKOFF_DORMANT_MISSES` (10): dormant. If `meta.lastCrawlAt > nowSec - DORMANT_INTERVAL_SEC`, return `"skip"`. Otherwise eligible at T3 cadence.
  - `>= BACKOFF_T3_MISSES` (6): effective cadence becomes T3
  - `>= BACKOFF_T2_MISSES` (3): effective cadence becomes T2 (even if base is T1)
- Eligible check: T1 always eligible, T2 when `runSeq % T2_MODULO === 0`, T3 when `runSeq % T3_MODULO === 0`
- Return `"skip"` if not eligible this run; otherwise return the effective tier string

f) Also export:

```typescript
export function isEligibleThisRun(tier: EffectiveTier): boolean {
  return tier !== "skip";
}
```

### Phase C: Order and crawl

g) Sort eligible coins by `meta.lastCrawlAt` ascending (most stale first). Coins with no meta row (`undefined`) sort to the front (never crawled before).

h) For each coin, build a `coinChains: Map<string, string>` from its `contracts` array in `TRACKED_STABLECOINS`. The `contracts` field is `ContractDeployment[]` (array of `{ chain: string; address: string; decimals: number }`). Build the map as:
```typescript
const coinChains = new Map(
  (coin.contracts ?? []).map(c => [c.chain, c.address])
);
```

i) Set a wall-clock deadline: `const deadlineMs = Date.now() + 14 * 60_000` (14 minutes).

j) Iterate through sorted coins. For each:
   - Call `crawlCoin(stablecoinId, coinChains, cgApiKey, knownPoolIds, signal, deadlineMs)` from `./crawl-sources.ts` (TICKET-003). Create a minimal stub for compilation:
     ```typescript
     // worker/src/cron/dex-discovery/crawl-sources.ts — stub (replaced by TICKET-003)
     import type { StagedPool } from "./types";
     export interface CrawlResult { pools: StagedPool[]; priceObs: Array<{ stablecoinId: string; price: number; tvl: number; chain: string; protocol: string }>; }
     export async function crawlCoin(_id: string, _chains: Map<string, string>, _key: string | null, _known: Set<string>, _signal?: AbortSignal, _deadline?: number): Promise<CrawlResult> { return { pools: [], priceObs: [] }; }
     ```
   - Call `upsertStagedPools(db, result.pools)` and `updateDiscoveryMeta(db, stablecoinId, result.pools.length, nowSec)` from `./persistence.ts`.
   - After each coin, check `Date.now() >= deadlineMs` — if so, set `budgetExhausted = true` and break.
   - Catch per-coin errors: log `console.warn("[dex-discovery]", stablecoinId, err)`, continue to next coin. Do NOT let one coin's failure abort the run. Track failed coins in `failedCoins: string[]`.
   - Track: `coinsCrawled++`, `poolsDiscovered += result.pools.length`.

### Phase D: Cleanup and return

k) Call `cleanupStaging(db, nowSec)` from `./persistence.ts`.

l) Return `CronResult`:
```typescript
{
  status: failedCoins.length > 0 ? "degraded" : "ok",
  itemCount: coinsCrawled,
  metadata: JSON.stringify({
    coinsCrawled,
    poolsDiscovered,
    tierBreakdown: { t1: countT1, t2: countT2, t3: countT3, dormant: countDormant, skipped: countSkipped },
    budgetExhausted,
    runSeq,
    failedCoins,
  }),
}
```

### Error handling pattern

Use the same pattern as the existing orchestrator. For the overall function, catch fatal errors and return `CronResult` with error status. For per-coin errors, catch non-fatal and continue:

```typescript
function rethrowIfAborted(err: unknown, signal?: AbortSignal): void {
  if (signal?.aborted) throw err;
}
```

This is the same local helper used in `worker/src/cron/dex-liquidity/orchestrator.ts` (line 20).

3. Create unit tests in `worker/src/cron/dex-discovery/__tests__/orchestrator.test.ts`:

Test `computeEffectiveTier()` (nowSec = 1710000000 for all tests):
- `(0, 0, undefined, 1, nowSec)` -> `"t1"` (no pools, no meta, always eligible)
- `(3, 1, undefined, 1, nowSec)` -> `"skip"` (T2 base, seq=1 not divisible by 3)
- `(3, 1, undefined, 3, nowSec)` -> `"t2"` (T2 base, seq=3 divisible by 3)
- `(5, 2, undefined, 1, nowSec)` -> `"skip"` (T3 base, seq=1 not divisible by 10)
- `(5, 2, undefined, 10, nowSec)` -> `"t3"` (T3 base, seq=10 divisible by 10)
- `(0, 0, { consecutiveMisses: 5, lastCrawlAt: nowSec - 100, lastHitAt: null, stablecoinId: "x" }, 1, nowSec)` -> `"skip"` (T1 base but backoff to T2, seq not divisible by 3)
- `(0, 0, { consecutiveMisses: 5, lastCrawlAt: nowSec - 100, lastHitAt: null, stablecoinId: "x" }, 3, nowSec)` -> `"t2"` (T1 base, backoff to T2, seq divisible by 3)
- `(0, 0, { consecutiveMisses: 10, lastCrawlAt: nowSec - 100, lastHitAt: null, stablecoinId: "x" }, 1, nowSec)` -> `"skip"` (dormant, crawled recently)
- `(0, 0, { consecutiveMisses: 10, lastCrawlAt: nowSec - 86401, lastHitAt: null, stablecoinId: "x" }, 10, nowSec)` -> `"t3"` or `"dormant"` (dormant but stale, eligible at T3 cadence, seq divisible by 10)

Test `isEligibleThisRun()`:
- `"t1"` -> `true`, `"t2"` -> `true`, `"t3"` -> `true`, `"dormant"` -> `true`, `"skip"` -> `false`

Test coin sorting:
- Coin with no meta sorts before coin with `lastCrawlAt: 1000`
- Coin with `lastCrawlAt: 500` sorts before coin with `lastCrawlAt: 1000`

## Acceptance Criteria

- `cd worker && npx tsc --noEmit` exits 0
- `npm test -- --run worker/src/cron/dex-discovery/__tests__/orchestrator.test.ts` — all tests pass
- `syncDexDiscovery` is exported from `worker/src/cron/dex-discovery/orchestrator.ts`
- `computeEffectiveTier` and `isEligibleThisRun` are exported (pure functions, testable)
- `computeEffectiveTier` accepts a `nowSec` parameter (5th argument) — no `Date.now()` calls inside
- Stub files `persistence.ts` and `crawl-sources.ts` exist with correct type signatures
- `grep "import.*CronResult.*from" worker/src/cron/dex-discovery/orchestrator.ts` shows import from `../../lib/db`
- `grep "TRACKED_STABLECOINS" worker/src/cron/dex-discovery/orchestrator.ts` shows import from `@shared/lib/stablecoins`
- No `import type { D1Database }` line anywhere — `D1Database` is a global
- `npm run build` exits 0
- `npm test` exits 0 (no regressions)
