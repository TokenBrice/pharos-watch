# Mint/Burn Flow Tracker Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Track real-time minting and redemption flows for 10 stablecoins on Ethereum to build a Bank Run Gauge and flight-to-quality detection system.

**Architecture:** Incremental block scanning via Etherscan V2 API (piggyback on existing `3,23,43` cron trigger), pre-aggregated hourly buckets in D1, two new API endpoints, and a dedicated `/flows` page with gauge visualization, flow charts, and per-coin table.

**Tech Stack:** Cloudflare Worker (cron + API), D1 (SQLite), Etherscan V2 API, Next.js 16 static export, React 19, TanStack Query, Recharts, Tailwind CSS v4.

**Design doc:** `docs/plans/mint-burn-flow-design.md`

---

## Task 1: Database Migration

**Files:**
- Create: `worker/migrations/0031_mint_burn_v2.sql`

**Context:** Migrations 0019/0020 created and dropped a previous mint_burn_events table. Latest migration is `0030_onchain_supply_index.sql`. This starts clean.

**Step 1: Create migration file**

```sql
-- Individual mint/burn events
CREATE TABLE mint_burn_events (
  id TEXT PRIMARY KEY,                 -- "{chainId}-{txHash}-{logIndex}"
  stablecoin_id TEXT NOT NULL,         -- Pharos stablecoin ID ("1", "2", "5", "118", etc.)
  symbol TEXT NOT NULL,                -- "USDT", "USDC", "DAI", "GHO", etc.
  chain_id TEXT NOT NULL,              -- "ethereum", "tron", etc.
  direction TEXT NOT NULL,             -- "mint" or "burn"
  amount REAL NOT NULL,                -- Token-native amount (e.g., 1000000.5 USDC)
  amount_usd REAL,                     -- USD value at time of event (NULL if price unavailable)
  counterparty TEXT,                   -- Address that received minted tokens or sent burned tokens
  tx_hash TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,          -- Unix seconds
  explorer_tx_url TEXT NOT NULL
);

CREATE INDEX idx_mbe2_ts ON mint_burn_events(timestamp DESC);
CREATE INDEX idx_mbe2_coin ON mint_burn_events(stablecoin_id, timestamp DESC);
CREATE INDEX idx_mbe2_chain ON mint_burn_events(chain_id, timestamp DESC);

-- Pre-aggregated hourly flow buckets (written by cron after each scan)
CREATE TABLE mint_burn_hourly (
  stablecoin_id TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  hour_ts INTEGER NOT NULL,            -- Unix seconds, truncated to hour boundary
  mint_count INTEGER NOT NULL DEFAULT 0,
  burn_count INTEGER NOT NULL DEFAULT 0,
  mint_volume_usd REAL NOT NULL DEFAULT 0,
  burn_volume_usd REAL NOT NULL DEFAULT 0,
  net_flow_usd REAL NOT NULL DEFAULT 0, -- mint_volume - burn_volume (positive = net mint)
  PRIMARY KEY (stablecoin_id, chain_id, hour_ts)
);

CREATE INDEX idx_mbh_ts ON mint_burn_hourly(hour_ts DESC);
CREATE INDEX idx_mbh_coin ON mint_burn_hourly(stablecoin_id, hour_ts DESC);

-- Incremental block tracking (same pattern as blacklist_sync_state)
CREATE TABLE mint_burn_sync_state (
  config_key TEXT PRIMARY KEY,         -- "{chainId}-{contractAddress}"
  last_block INTEGER NOT NULL DEFAULT 0
);
```

**Step 2: Verify migration file numbering**

Run: `ls worker/migrations/ | tail -5`
Expected: `0031_mint_burn_v2.sql` is the newest file, comes after `0030_onchain_supply_index.sql`.

**Step 3: Commit**

```bash
git add worker/migrations/0031_mint_burn_v2.sql
git commit -m "feat(db): add mint_burn_events, mint_burn_hourly, and sync_state tables"
```

---

## Task 2: Contract Configs + Types

**Files:**
- Create: `worker/src/lib/mint-burn-contracts.ts`

**Context:** Follow the same pattern as `worker/src/lib/blacklist-contracts.ts`. Reuse the `ChainConfig` type and `chainConfig()` helper from there. See design doc Section 3 for the full type definitions and all 10 Phase 1 configs.

**Step 1: Create the config file**

The file must export:
- `MintBurnDirection` type (`"mint" | "burn"`)
- `MintBurnEventDef` interface (signature, topicHash, direction, amountEncoding, filterTopic)
- `MintBurnContractConfig` interface (chain, stablecoinId, symbol, contractAddress, decimals, dustThreshold, events)
- `MINT_BURN_CONFIGS` array with all 10 Phase 1 contracts
- A `transferMintBurn()` helper that returns the standard mint+burn event pair to DRY the configs

Constants to define:
```typescript
const ZERO_ADDRESS_PADDED = "0x0000000000000000000000000000000000000000000000000000000000000000";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Phase 2 readiness — USDT Tron uses these instead of Transfer
const USDT_ISSUE_TOPIC = "0xcb8241adb0c3fdb35b70c24ce35c5eb0c17af7431c99f827d44a445ca624176a";
const USDT_REDEEM_TOPIC = "0x702d5967f45f6513a38ffc42d6ba9bf230bd40e8f53b16363c7eb4fd2deb9a44";
```

All 10 configs use `transferMintBurn()` — see design doc Section 3 "Phase 1 contract configs" for exact contract addresses, IDs, symbols, and decimals.

Import `ChainConfig` and `chainConfig` from `"./blacklist-contracts"` to construct the `ETHEREUM` constant.

**Step 2: Worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

**Step 3: Commit**

```bash
git add worker/src/lib/mint-burn-contracts.ts
git commit -m "feat(worker): add mint-burn contract configs for 10 Phase 1 coins"
```

---

## Task 3: Compound Topic Filtering (`fetchEvmLogsForTopics`)

**Files:**
- Modify: `worker/src/lib/evm-logs.ts`
- Create: `worker/src/lib/__tests__/evm-logs.test.ts`

**Context:** The existing `fetchEvmLogsForTopic()` only supports filtering by `topic0` (event signature). Mint/burn detection needs compound filtering: `topic0 + topic1` (from=zero for mints) or `topic0 + topic2` (to=zero for burns). The new function must replicate all behavior: recursive block splitting, budget tracking, rate limiting, error handling.

**Step 1: Write unit tests for URL construction**

Create `worker/src/lib/__tests__/evm-logs.test.ts`. Test the Etherscan URL parameter building logic:

```typescript
import { describe, it, expect } from "vitest";
import { buildTopicParams } from "../evm-logs";

describe("buildTopicParams", () => {
  it("builds params for single topic (topic0 only)", () => {
    const params = buildTopicParams([{ index: 0, value: "0xabc" }]);
    expect(params.get("topic0")).toBe("0xabc");
    expect(params.has("topic0_1_opr")).toBe(false);
  });

  it("builds params for compound topics (topic0 + topic1)", () => {
    const params = buildTopicParams([
      { index: 0, value: "0xddf252ad..." },
      { index: 1, value: "0x000...000" },
    ]);
    expect(params.get("topic0")).toBe("0xddf252ad...");
    expect(params.get("topic1")).toBe("0x000...000");
    expect(params.get("topic0_1_opr")).toBe("and");
    expect(params.has("topic0_2_opr")).toBe(false);
  });

  it("builds params for topic0 + topic2 (burn detection)", () => {
    const params = buildTopicParams([
      { index: 0, value: "0xddf252ad..." },
      { index: 2, value: "0x000...000" },
    ]);
    expect(params.get("topic0")).toBe("0xddf252ad...");
    expect(params.get("topic2")).toBe("0x000...000");
    expect(params.get("topic0_2_opr")).toBe("and");
    expect(params.has("topic0_1_opr")).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- worker/src/lib/__tests__/evm-logs.test.ts`
Expected: FAIL — `buildTopicParams` not exported.

**Step 3: Extract `buildTopicParams` and implement `fetchEvmLogsForTopics`**

In `worker/src/lib/evm-logs.ts`:

1. Extract a `buildTopicParams(topics: { index: number; value: string }[]): URLSearchParams` function. For each topic, set `topic{N}` and for N > 0, set `topic0_{N}_opr = "and"`.

2. Add `fetchEvmLogsForTopics()` with the same signature as `fetchEvmLogsForTopic` but accepting a `topics` array instead of a single `topicHash`:

```typescript
export async function fetchEvmLogsForTopics(
  evmChainId: number,
  contractAddress: string,
  topics: { index: number; value: string }[],
  apiKey: string | null,
  fromBlock: number,
  toBlock: number,
  depth: number,
  rateLimit: RateLimitedFetch,
  budget: SubrequestBudget
): Promise<EtherscanLogEntry[] | null>
```

3. Refactor `fetchEvmLogsForTopic` to delegate to `fetchEvmLogsForTopics` with `[{ index: 0, value: topicHash }]`. This avoids code duplication.

Export `buildTopicParams` for testing.

**Step 4: Run tests to verify they pass**

Run: `npm test -- worker/src/lib/__tests__/evm-logs.test.ts`
Expected: PASS.

**Step 5: Worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors. Verify existing blacklist sync (which uses `fetchEvmLogsForTopic`) still compiles.

**Step 6: Commit**

```bash
git add worker/src/lib/evm-logs.ts worker/src/lib/__tests__/evm-logs.test.ts
git commit -m "feat(worker): add fetchEvmLogsForTopics for compound topic filtering"
```

---

## Task 4: Scoring Logic (TDD)

**Files:**
- Create: `worker/src/lib/mint-burn-scoring.ts`
- Create: `worker/src/lib/__tests__/mint-burn-scoring.test.ts`

**Context:** Extract the Flow Intensity Score (FIS), Bank Run Gauge, and flight-to-quality detection as pure functions for testability. See design doc Section 6 for all formulas.

**Step 1: Write failing tests**

```typescript
import { describe, it, expect } from "vitest";
import {
  computeFlowIntensity,
  computeGaugeScore,
  detectFlightToQuality,
  GAUGE_BANDS,
  getGaugeBand,
} from "../mint-burn-scoring";

// Hand-computed reference values from the design doc formula:
//   denominator = max(baselineDailyAbs * 0.3, 1_000_000)
//   z_score = (currentDailyNet - baselineDailyNet) / denominator
//   if currentDailyNet < 0: intensity = clamp(0, 100, 50 - z_score * 25)
//   else:                   intensity = clamp(0, 100, 50 + z_score * 25)

describe("computeFlowIntensity", () => {
  it("returns null when fewer than 7 days of data", () => {
    expect(computeFlowIntensity({ currentDailyNet: -1e8, baselineDailyNet: 0, baselineDailyAbs: 1e9, dataAgeDays: 5 })).toBeNull();
  });

  it("returns exactly 50 when current equals baseline (neutral)", () => {
    // z_score = (1e8 - 1e8) / max(5e8 * 0.3, 1e6) = 0 / 1.5e8 = 0
    // intensity = 50 + 0 * 25 = 50
    const result = computeFlowIntensity({ currentDailyNet: 1e8, baselineDailyNet: 1e8, baselineDailyAbs: 5e8, dataAgeDays: 30 });
    expect(result).toBe(50);
  });

  it("computes correct value for moderate net redemptions", () => {
    // denominator = max(2e8 * 0.3, 1e6) = 6e7
    // z_score = (-5e8 - 0) / 6e7 = -8.333
    // intensity = clamp(0, 100, 50 - (-8.333) * 25) = clamp(0, 100, 50 + 208.33) = 100
    // Wait — that clamps to 100, not <50. Let me reconsider.
    // Actually for negative currentDailyNet: intensity = 50 - z_score * 25
    // z_score = (-5e8 - 0) / 6e7 = -8.333
    // intensity = 50 - (-8.333 * 25) = 50 + 208.33 = 258.33 → clamped to 100
    // That's wrong — extreme redemptions should go BELOW 50, not above.
    // Re-reading the formula: the z_score IS negative for redemptions.
    // intensity = 50 - z_score * 25 = 50 - (-8.33 * 25) = 50 + 208 → clamped 100
    // This can't be right. The formula must use abs or the sign convention differs.
    // Correct interpretation from design doc (re-read carefully):
    //   z_score = (current - baseline) / denominator  (this is negative for redemptions)
    //   intensity = clamp(0, 100, 50 + z_score * 25)  (SAME formula for both directions)
    // So: z = -8.33, intensity = 50 + (-8.33 * 25) = 50 - 208 = -158 → clamped to 0
    // Let's use milder numbers:
    // currentDailyNet = -1.2e8, baseline = 0, absBaseline = 2e8
    // denom = max(2e8 * 0.3, 1e6) = 6e7
    // z = (-1.2e8 - 0) / 6e7 = -2.0
    // intensity = clamp(0, 100, 50 + (-2.0) * 25) = clamp(0, 100, 0) = 0
    // Still extreme. Let's try smaller:
    // currentDailyNet = -3e7, baseline = 0, absBaseline = 2e8
    // z = -3e7 / 6e7 = -0.5
    // intensity = 50 + (-0.5 * 25) = 50 - 12.5 = 37.5
    const result = computeFlowIntensity({ currentDailyNet: -3e7, baselineDailyNet: 0, baselineDailyAbs: 2e8, dataAgeDays: 30 });
    expect(result).toBeCloseTo(37.5, 1);
  });

  it("computes correct value for moderate net minting", () => {
    // currentDailyNet = 6e7, baseline = 0, absBaseline = 2e8
    // denom = max(2e8 * 0.3, 1e6) = 6e7
    // z = (6e7 - 0) / 6e7 = 1.0
    // intensity = clamp(0, 100, 50 + 1.0 * 25) = 75
    const result = computeFlowIntensity({ currentDailyNet: 6e7, baselineDailyNet: 0, baselineDailyAbs: 2e8, dataAgeDays: 30 });
    expect(result).toBeCloseTo(75, 1);
  });

  it("clamps to 0 for extreme net redemptions", () => {
    // currentDailyNet = -1e12, baseline = 0, absBaseline = 1e8
    // denom = max(1e8 * 0.3, 1e6) = 3e7
    // z = -1e12 / 3e7 = -33333
    // intensity = 50 + (-33333 * 25) → -833275 → clamped to 0
    expect(computeFlowIntensity({ currentDailyNet: -1e12, baselineDailyNet: 0, baselineDailyAbs: 1e8, dataAgeDays: 30 })).toBe(0);
  });

  it("clamps to 100 for extreme net minting", () => {
    // currentDailyNet = 1e12, baseline = 0, absBaseline = 1e8
    // z = 1e12 / 3e7 = 33333
    // intensity = 50 + 33333 * 25 → 833375 → clamped to 100
    expect(computeFlowIntensity({ currentDailyNet: 1e12, baselineDailyNet: 0, baselineDailyAbs: 1e8, dataAgeDays: 30 })).toBe(100);
  });

  it("uses floor of 1M for denominator when baseline abs flow is tiny", () => {
    // absBaseline = 100, denom = max(100 * 0.3, 1e6) = 1e6
    // z = (-2e6 - 0) / 1e6 = -2.0
    // intensity = 50 + (-2 * 25) = 0
    const result = computeFlowIntensity({ currentDailyNet: -2e6, baselineDailyNet: 0, baselineDailyAbs: 100, dataAgeDays: 30 });
    expect(result).toBeCloseTo(0, 1);
  });

  it("accounts for non-zero baseline in z-score", () => {
    // baseline = 5e7 (normal daily net mint of $50M)
    // current = 5e7 (same as baseline → neutral)
    // absBaseline = 3e8, denom = 9e7
    // z = (5e7 - 5e7) / 9e7 = 0 → intensity = 50
    expect(computeFlowIntensity({ currentDailyNet: 5e7, baselineDailyNet: 5e7, baselineDailyAbs: 3e8, dataAgeDays: 30 })).toBe(50);

    // current = -1e7 (slight redemptions vs normal $50M minting)
    // z = (-1e7 - 5e7) / 9e7 = -6e7 / 9e7 = -0.667
    // intensity = 50 + (-0.667 * 25) = 50 - 16.67 = 33.33
    expect(computeFlowIntensity({ currentDailyNet: -1e7, baselineDailyNet: 5e7, baselineDailyAbs: 3e8, dataAgeDays: 30 })).toBeCloseTo(33.33, 0);
  });
});

describe("getGaugeBand", () => {
  it("returns CRISIS for 0-15", () => {
    expect(getGaugeBand(10)).toEqual({ label: "CRISIS", color: "red" });
  });
  it("returns NEUTRAL for 45-55", () => {
    expect(getGaugeBand(50)).toEqual({ label: "NEUTRAL", color: "gray" });
  });
  it("returns SURGE for 85-100", () => {
    expect(getGaugeBand(95)).toEqual({ label: "SURGE", color: "bright-green" });
  });
});

describe("computeGaugeScore", () => {
  it("returns null when any coin has null intensity", () => {
    expect(computeGaugeScore([
      { intensity: 40, mcap: 1e11 },
      { intensity: null, mcap: 5e10 },
    ])).toBeNull();
  });

  it("computes mcap-weighted average", () => {
    // 60 * (100B/150B) + 40 * (50B/150B) = 40 + 13.33 = 53.33
    const result = computeGaugeScore([
      { intensity: 60, mcap: 1e11 },
      { intensity: 40, mcap: 5e10 },
    ]);
    expect(result).toBeCloseTo(53.33, 1);
  });
});

// Formula: active = riskyNet24h < -1e8 AND safeNet24h > 1e8
//          intensity = min(100, abs(riskyNet24h) / 1e9 * 100)
describe("detectFlightToQuality", () => {
  it("returns inactive when risky outflows below $100M threshold", () => {
    // riskyNet24h = -5e7 → abs < 1e8 → not active
    expect(detectFlightToQuality({ safeNet24h: 2e8, riskyNet24h: -5e7 })).toEqual({
      active: false, intensity: 0,
    });
  });

  it("returns inactive when safe inflows below $100M threshold", () => {
    // safeNet24h = 5e7 < 1e8 → not active (even though risky < -1e8)
    expect(detectFlightToQuality({ safeNet24h: 5e7, riskyNet24h: -2e8 })).toEqual({
      active: false, intensity: 0,
    });
  });

  it("computes exact intensity when both thresholds exceeded", () => {
    // riskyNet24h = -2e8, safeNet24h = 3e8 → active
    // intensity = min(100, abs(-2e8) / 1e9 * 100) = min(100, 20) = 20
    const result = detectFlightToQuality({ safeNet24h: 3e8, riskyNet24h: -2e8 });
    expect(result).toEqual({ active: true, intensity: 20 });
  });

  it("caps intensity at 100 for extreme outflows", () => {
    // intensity = min(100, abs(-2e9) / 1e9 * 100) = min(100, 200) = 100
    const result = detectFlightToQuality({ safeNet24h: 5e9, riskyNet24h: -2e9 });
    expect(result).toEqual({ active: true, intensity: 100 });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- worker/src/lib/__tests__/mint-burn-scoring.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement scoring functions**

Create `worker/src/lib/mint-burn-scoring.ts` with:

- `computeFlowIntensity({ currentDailyNet, baselineDailyNet, baselineDailyAbs, dataAgeDays })` — returns `number | null`. Returns null if `dataAgeDays < 7`. Formula (unified, no branching needed):
  ```
  denominator = max(baselineDailyAbs * 0.3, 1_000_000)
  z_score = (currentDailyNet - baselineDailyNet) / denominator
  intensity = clamp(0, 100, 50 + z_score * 25)
  ```
  Note: the design doc shows two branches (if/else for negative/positive currentDailyNet) but both reduce to the same formula `50 + z_score * 25` since z_score is already signed. Use the unified version — simpler and identical results.
- `GAUGE_BANDS` — array of `{ min, max, label, color }` objects per design doc.
- `getGaugeBand(score: number)` — returns `{ label, color }` for the band containing the score.
- `computeGaugeScore(coins: { intensity: number | null; mcap: number }[])` — returns `number | null`. Null if any coin has null intensity. Otherwise mcap-weighted average.
- `detectFlightToQuality({ safeNet24h, riskyNet24h })` — returns `{ active: boolean; intensity: number }`. Active when `riskyNet24h < -1e8 && safeNet24h > 1e8`. Intensity capped at 100.

**Step 4: Run tests to verify they pass**

Run: `npm test -- worker/src/lib/__tests__/mint-burn-scoring.test.ts`
Expected: All PASS.

**Step 5: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

**Step 6: Commit**

```bash
git add worker/src/lib/mint-burn-scoring.ts worker/src/lib/__tests__/mint-burn-scoring.test.ts
git commit -m "feat(worker): add FIS, Bank Run Gauge, and flight-to-quality scoring logic"
```

---

## Task 5: Sync Cron Implementation

**Files:**
- Create: `worker/src/cron/sync-mint-burn.ts`

**Context:** Follow the same structural pattern as `worker/src/cron/sync-blacklist.ts` — incremental block scanning, rate-limited Etherscan fetching, event parsing, DB insertion, hourly aggregation. The key differences: uses `fetchEvmLogsForTopics` (compound topics), simpler event parsing (no balance enrichment), and writes to different tables. This is the most complex task — broken into 4 sub-steps, each compilable independently.

**Reference files to study first:**
- `worker/src/cron/sync-blacklist.ts` — overall structure, error handling, budget checks
- `worker/src/lib/evm-logs.ts` — `decodeUint256`, `decodeAddress`, `getEvmBlockNumber`, `fetchEvmLogsForTopics`
- `worker/src/lib/blacklist-contracts.ts` — `evmSafetyMarginBlocks()` for safety margin calculation
- `worker/src/lib/db.ts` — `batchExecute()` for chunked DB operations

### Step 1: Scaffolding — function shell, sync state loading, block head

Create `worker/src/cron/sync-mint-burn.ts` with the outer function, sync state loading, and chain head fetch. This compiles and returns empty results.

```typescript
import type { RateLimitedFetch } from "../lib/evm-logs";
import {
  createBudget, budgetExhausted, getEvmBlockNumber,
  fetchEvmLogsForTopics, decodeUint256, decodeAddress,
} from "../lib/evm-logs";
import { MINT_BURN_CONFIGS, type MintBurnContractConfig } from "../lib/mint-burn-contracts";
import { evmSafetyMarginBlocks } from "../lib/blacklist-contracts";

export async function syncMintBurn(
  db: D1Database,
  etherscanApiKey: string | null,
  etherscanRL: RateLimitedFetch,
): Promise<{ itemCount: number; metadata: string }> {
  const budget = createBudget(200);
  let totalNewEvents = 0;
  let contractsProcessed = 0;
  let contractsSkipped = 0;
  let apiErrors = 0;

  // 1. Load last_block for all configs in one batch query
  const configKeys = MINT_BURN_CONFIGS.map(
    (c) => `${c.chain.chainId}-${c.contractAddress}`
  );
  const syncStates = await db.batch(
    configKeys.map((key) =>
      db.prepare("SELECT last_block FROM mint_burn_sync_state WHERE config_key = ?").bind(key)
    )
  );
  const lastBlocks = new Map<string, number>();
  configKeys.forEach((key, i) => {
    const row = syncStates[i].results[0] as { last_block: number } | undefined;
    lastBlocks.set(key, row?.last_block ?? 0);
  });

  // 2. Get current Ethereum block number (single call, shared across all configs)
  const chainHead = await getEvmBlockNumber(1, etherscanApiKey, etherscanRL, budget);
  if (chainHead === null) {
    return { itemCount: 0, metadata: JSON.stringify({ error: "Failed to get chain head" }) };
  }

  // 3. Load current prices for USD conversion (one query, cached in Map)
  const priceRows = await db.prepare(
    "SELECT stablecoin_id, price FROM price_cache WHERE stablecoin_id IN (" +
    MINT_BURN_CONFIGS.map(() => "?").join(",") + ")"
  ).bind(...MINT_BURN_CONFIGS.map((c) => c.stablecoinId)).all();
  const prices = new Map<string, number>();
  for (const row of priceRows.results) {
    prices.set(row.stablecoin_id as string, row.price as number);
  }

  // TODO: Steps 2-4 (event scanning, aggregation, sync state update)

  return {
    itemCount: totalNewEvents,
    metadata: JSON.stringify({ contractsProcessed, contractsSkipped, apiErrors }),
  };
}
```

Verify: `cd worker && npx tsc --noEmit` — should compile.

### Step 2: Event scanning loop — fetch + parse + insert

Replace the TODO with the per-config scanning loop. For each config:

```typescript
  // 4. Process each config
  const allNewEvents: Array<{
    stablecoinId: string; chainId: string; hourTs: number;
  }> = [];

  for (const config of MINT_BURN_CONFIGS) {
    const configKey = `${config.chain.chainId}-${config.contractAddress}`;
    const fromBlock = (lastBlocks.get(configKey) ?? 0) + 1;

    if (fromBlock > chainHead) {
      contractsSkipped++;
      continue;
    }
    if (budgetExhausted(budget)) {
      contractsSkipped++;
      continue;
    }

    let maxBlockSeen = 0;
    let configEvents = 0;
    let configError = false;

    for (const eventDef of config.events) {
      if (budgetExhausted(budget)) break;

      // Build compound topics: [topic0 (event sig), topicN (zero address filter)]
      const topics = [{ index: 0, value: eventDef.topicHash }];
      if (eventDef.filterTopic) {
        topics.push({ index: eventDef.filterTopic.index, value: eventDef.filterTopic.value });
      }

      const logs = await fetchEvmLogsForTopics(
        config.chain.evmChainId!, config.contractAddress, topics,
        etherscanApiKey, fromBlock, chainHead, 0, etherscanRL, budget
      );

      if (logs === null) {
        apiErrors++;
        configError = true;
        continue;
      }

      // Parse logs into DB rows
      const rows: Array<Record<string, unknown>> = [];
      for (const log of logs) {
        const amount = decodeUint256(log.data, config.decimals);
        if (amount <= 0 || amount < config.dustThreshold) continue;

        const blockNum = parseInt(log.blockNumber, 16);
        const logIndex = parseInt(log.logIndex, 16);
        const timestamp = parseInt(log.timeStamp, 16);
        const id = `${config.chain.chainId}-${log.transactionHash}-${logIndex}`;

        // Counterparty: for mints it's topics[2] (recipient), for burns it's topics[1] (sender)
        const counterpartyTopic = eventDef.direction === "mint" ? log.topics[2] : log.topics[1];
        const counterparty = counterpartyTopic ? decodeAddress(counterpartyTopic) : null;

        const price = prices.get(config.stablecoinId);
        const amountUsd = price != null ? amount * price : null;

        rows.push({
          id, stablecoin_id: config.stablecoinId, symbol: config.symbol,
          chain_id: config.chain.chainId, direction: eventDef.direction,
          amount, amount_usd: amountUsd, counterparty,
          tx_hash: log.transactionHash, block_number: blockNum,
          timestamp, explorer_tx_url: `${config.chain.explorerUrl}/tx/${log.transactionHash}`,
        });

        maxBlockSeen = Math.max(maxBlockSeen, blockNum);

        // Track affected hour buckets for aggregation
        const hourTs = Math.floor(timestamp / 3600) * 3600;
        allNewEvents.push({ stablecoinId: config.stablecoinId, chainId: config.chain.chainId, hourTs });
      }

      // Batch INSERT OR IGNORE
      if (rows.length > 0) {
        const stmt = db.prepare(
          `INSERT OR IGNORE INTO mint_burn_events
           (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd,
            counterparty, tx_hash, block_number, timestamp, explorer_tx_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const batches: D1PreparedStatement[] = rows.map((r) =>
          stmt.bind(r.id, r.stablecoin_id, r.symbol, r.chain_id, r.direction,
            r.amount, r.amount_usd, r.counterparty, r.tx_hash, r.block_number,
            r.timestamp, r.explorer_tx_url)
        );
        // D1 batch limit is 100 statements
        for (let i = 0; i < batches.length; i += 100) {
          await db.batch(batches.slice(i, i + 100));
        }
        configEvents += rows.length;
      }
    }

    // Update sync state for this config (Step 4 below)
    // ... placeholder for now

    totalNewEvents += configEvents;
    contractsProcessed++;
  }
```

Key details:
- `log.timeStamp` from Etherscan is hex. Parse with `parseInt(x, 16)`.
- `decodeAddress` extracts last 20 bytes from a 32-byte topic. Import from `evm-logs.ts`.
- `price_cache` may not have every coin — `amountUsd` is NULL when price is missing.
- D1 batch limit is 100 statements — chunk inserts accordingly.

Verify: `cd worker && npx tsc --noEmit`

### Step 3: Hourly aggregation recalculation

After the scanning loop, recalculate only the affected hourly buckets:

```typescript
  // 5. Recalculate affected hourly buckets
  // Deduplicate the (stablecoinId, chainId, hourTs) tuples
  const affectedHours = new Map<string, { stablecoinId: string; chainId: string; hourTs: number }>();
  for (const evt of allNewEvents) {
    const key = `${evt.stablecoinId}-${evt.chainId}-${evt.hourTs}`;
    affectedHours.set(key, evt);
  }

  if (affectedHours.size > 0) {
    const aggStmt = db.prepare(`
      INSERT OR REPLACE INTO mint_burn_hourly
        (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
         mint_volume_usd, burn_volume_usd, net_flow_usd)
      SELECT
        stablecoin_id, chain_id,
        (timestamp / 3600) * 3600 AS hour_ts,
        SUM(CASE WHEN direction = 'mint' THEN 1 ELSE 0 END),
        SUM(CASE WHEN direction = 'burn' THEN 1 ELSE 0 END),
        COALESCE(SUM(CASE WHEN direction = 'mint' THEN amount_usd ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN direction = 'burn' THEN amount_usd ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN direction = 'mint' THEN amount_usd ELSE -amount_usd END), 0)
      FROM mint_burn_events
      WHERE stablecoin_id = ? AND chain_id = ?
        AND timestamp >= ? AND timestamp < ?
      GROUP BY stablecoin_id, chain_id, hour_ts
    `);

    const aggBatches = [...affectedHours.values()].map((h) =>
      aggStmt.bind(h.stablecoinId, h.chainId, h.hourTs, h.hourTs + 3600)
    );
    for (let i = 0; i < aggBatches.length; i += 100) {
      await db.batch(aggBatches.slice(i, i + 100));
    }
  }
```

Note: `(timestamp / 3600) * 3600` uses SQLite integer division, which floors correctly for positive unix timestamps. The WHERE clause bounds the query to exactly one hour bucket.

Verify: `cd worker && npx tsc --noEmit`

### Step 4: Sync state advancement

Replace the sync state placeholder in Step 2's loop with:

```typescript
    // Update sync state
    if (!configError) {
      const configKey = `${config.chain.chainId}-${config.contractAddress}`;
      let newLastBlock: number;
      if (maxBlockSeen > 0) {
        // Events found — advance to the highest block we saw
        newLastBlock = maxBlockSeen;
      } else {
        // No events, scan succeeded — advance toward chain head with safety margin
        const safetyBlocks = evmSafetyMarginBlocks(config.chain.chainId);
        newLastBlock = Math.max(fromBlock - 1, chainHead - safetyBlocks);
      }
      await db.prepare(
        `INSERT INTO mint_burn_sync_state (config_key, last_block) VALUES (?, ?)
         ON CONFLICT(config_key) DO UPDATE SET last_block = ?`
      ).bind(configKey, newLastBlock, newLastBlock).run();
    }
```

The safety margin prevents permanently skipping events when Etherscan's indexing lags behind the actual chain head. `evmSafetyMarginBlocks()` returns ~75 blocks for Ethereum (15 minutes at 12s/block).

### Step 5: Type-check the complete file

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

### Step 6: Commit

```bash
git add worker/src/cron/sync-mint-burn.ts
git commit -m "feat(worker): add sync-mint-burn cron for incremental event scanning"
```

---

## Task 6: Shared Rate Limiter + Cron Registration

**Files:**
- Modify: `worker/src/cron/sync-blacklist.ts` (~line 624)
- Modify: `worker/src/index.ts` (~line 217)

**Context:** Both `syncBlacklist` and `syncMintBurn` hit the Etherscan API. Running with independent rate limiters at 4 req/sec each would combine to 8 req/sec — exceeding the free-tier 5 req/sec cap. The `scheduled()` handler creates one shared rate limiter and passes it to both.

**Step 1: Modify `syncBlacklist` to accept an optional external rate limiter**

In `worker/src/cron/sync-blacklist.ts`, change the function signature:

```typescript
export async function syncBlacklist(
  db: D1Database,
  etherscanApiKey: string | null,
  trongridApiKey: string | null,
  drpcApiKey: string | null,
  externalEtherscanRL?: RateLimitedFetch,
): Promise<{ itemCount: number; metadata: string }> {
  const etherscanLimiter = externalEtherscanRL ?? createRateLimiter(4);
  // ... rest unchanged (tronLimiter still created internally)
```

This is backward-compatible — existing callers (admin endpoints, if any) continue to work without the new parameter.

**Step 2: Update the `3,23,43` cron case in `index.ts`**

```typescript
case "3,23,43 * * * *": {
  const etherscanRL = createRateLimiter(4);
  const etherscanKey = env.ETHERSCAN_API_KEY ?? null;
  ctx.waitUntil(
    logCronRun(db, "sync-blacklist", () =>
      syncBlacklist(db, etherscanKey, env.TRONGRID_API_KEY ?? null, env.DRPC_API_KEY ?? null, etherscanRL)
    )
  );
  ctx.waitUntil(
    logCronRun(db, "sync-mint-burn", () =>
      syncMintBurn(db, etherscanKey, etherscanRL)
    )
  );
  break;
}
```

Add imports at top of `index.ts`:
- `import { syncMintBurn } from "./cron/sync-mint-burn";`
- `import { createRateLimiter } from "./lib/evm-logs";`

**Step 3: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

**Step 4: Commit**

```bash
git add worker/src/cron/sync-blacklist.ts worker/src/index.ts
git commit -m "feat(worker): shared Etherscan rate limiter + register sync-mint-burn cron"
```

---

## Task 7: API Handlers + Router Registration

**Files:**
- Create: `worker/src/api/mint-burn-flows.ts`
- Create: `worker/src/api/mint-burn-events.ts`
- Modify: `worker/src/router.ts`

**Context:** Two new endpoints. Follow patterns from `worker/src/api/blacklist.ts` — use `withErrorHandler`, `buildPaginatedQuery`, `addFreshnessHeaders`, `CACHE_PROFILES`. See design doc Section 7 for full request/response specs.

**Step 1: Implement `GET /api/mint-burn-flows`**

Create `worker/src/api/mint-burn-flows.ts`:

Handler signature: `handleMintBurnFlows(db: D1Database, url: URL)`

Two modes:
- **Aggregate** (no `stablecoin` param): returns gauge score, per-coin summaries, hourly timeseries.
- **Per-coin** (with `stablecoin` param): returns single-coin detail with chain breakdown.

Query params: `stablecoin` (optional), `hours` (optional, default 24, range 1-720).

For the aggregate response, the handler must:
1. Query `mint_burn_hourly` for the requested time window grouped by stablecoin.
2. Compute 24h and 7d net flows, mint/burn volumes and counts per coin.
3. Query 30-day baselines from `mint_burn_hourly`.
4. Compute FIS per coin using `computeFlowIntensity()` from `mint-burn-scoring.ts`.
5. Look up mcaps from `stablecoins` table (or `stablecoin_data` — check which table has current mcap).
6. Compute Bank Run Gauge via `computeGaugeScore()`.
7. Classify coins as safe/risky using `MINT_BURN_CONFIGS` metadata + stablecoin backing/governance.
8. Run `detectFlightToQuality()`.
9. Find largest event per coin in 24h from `mint_burn_events`.
10. Build hourly timeseries for the chart.

Cache: `CACHE_PROFILES.standard` (5min edge, 1min client).

**Step 2: Implement `GET /api/mint-burn-events`**

Create `worker/src/api/mint-burn-events.ts`:

Handler signature: `handleMintBurnEvents(db: D1Database, url: URL)`

Required param: `stablecoin`. Optional: `direction`, `chain`, `minAmount`, `limit` (1-500, default 50), `offset`.

Use `buildPaginatedQuery` to construct WHERE clause. Return paginated events with total count.

Cache: `CACHE_PROFILES.realtime` (1min edge, 10s client).

**Step 3: Register routes**

In `worker/src/router.ts`:

Add imports:
```typescript
import { handleMintBurnFlows } from "./api/mint-burn-flows";
import { handleMintBurnEvents } from "./api/mint-burn-events";
```

Add route cases (before the dynamic `/api/stablecoin/:id` match):
```typescript
if (path === "/api/mint-burn-flows") {
  return handleMintBurnFlows(db, url);
}
if (path === "/api/mint-burn-events") {
  return handleMintBurnEvents(db, url);
}
```

**Step 4: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

**Step 5: Commit**

```bash
git add worker/src/api/mint-burn-flows.ts worker/src/api/mint-burn-events.ts worker/src/router.ts
git commit -m "feat(api): add /api/mint-burn-flows and /api/mint-burn-events endpoints"
```

---

## Task 8: Frontend Types + Hooks

**Files:**
- Create: `src/hooks/use-mint-burn-flows.ts`
- Modify: `src/lib/types.ts` (add response types)

**Context:** Follow hook conventions from `src/hooks/use-api-query.ts`. Use `CRON_20MIN` since the cron runs every 20 minutes. See design doc Section 8 for the hook code.

**Step 1: Add TypeScript types**

In `src/lib/types.ts`, add the response interfaces. Check where other API response types are defined in the codebase — they may be co-located with hooks or in a shared types file. Add these types wherever the existing pattern places them:

```typescript
// Mint/Burn Flow types
export interface MintBurnGauge {
  score: number | null;
  band: string | null;
  flightToQuality: boolean;
  flightIntensity: number;
  trackedCoins: number;
  trackedMcapUsd: number;
}

export interface MintBurnCoinFlow {
  stablecoinId: string;
  symbol: string;
  flowIntensity: number | null;
  netFlow24hUsd: number;
  mintVolume24hUsd: number;
  burnVolume24hUsd: number;
  mintCount24h: number;
  burnCount24h: number;
  netFlow7dUsd: number;
  largestEvent24h: {
    direction: "mint" | "burn";
    amountUsd: number;
    txHash: string;
    timestamp: number;
  } | null;
}

export interface MintBurnHourlyBucket {
  hourTs: number;
  netFlowUsd: number;
  mintVolumeUsd: number;
  burnVolumeUsd: number;
}

export interface MintBurnFlowsResponse {
  gauge: MintBurnGauge;
  coins: MintBurnCoinFlow[];
  hourly: MintBurnHourlyBucket[];
  updatedAt: number;
}

export interface MintBurnEvent {
  id: string;
  stablecoinId: string;
  symbol: string;
  chainId: string;
  direction: "mint" | "burn";
  amount: number;
  amountUsd: number | null;
  counterparty: string | null;
  txHash: string;
  blockNumber: number;
  timestamp: number;
  explorerTxUrl: string;
}

export interface MintBurnEventsResponse {
  events: MintBurnEvent[];
  total: number;
}
```

**Step 2: Create hooks**

Create `src/hooks/use-mint-burn-flows.ts`:

```typescript
import { useApiQuery, CRON_20MIN } from "./use-api-query";
import type { MintBurnFlowsResponse, MintBurnEventsResponse } from "@/lib/types";

export function useMintBurnFlows(stablecoinId?: string, hours = 24) {
  const params = new URLSearchParams();
  if (stablecoinId) params.set("stablecoin", stablecoinId);
  if (hours !== 24) params.set("hours", hours.toString());
  const qs = params.toString();

  return useApiQuery<MintBurnFlowsResponse>(
    ["mint-burn-flows", stablecoinId ?? "all", hours],
    `/api/mint-burn-flows${qs ? `?${qs}` : ""}`,
    CRON_20MIN
  );
}

export function useMintBurnEvents(
  stablecoinId: string,
  opts?: { direction?: string; limit?: number; offset?: number }
) {
  const params = new URLSearchParams({ stablecoin: stablecoinId });
  if (opts?.direction) params.set("direction", opts.direction);
  if (opts?.limit) params.set("limit", opts.limit.toString());
  if (opts?.offset) params.set("offset", opts.offset.toString());

  return useApiQuery<MintBurnEventsResponse>(
    ["mint-burn-events", stablecoinId, opts?.direction ?? "all", opts?.offset ?? 0],
    `/api/mint-burn-events?${params}`,
    CRON_20MIN
  );
}
```

**Step 3: Build check**

Run: `npm run build`
Expected: No TypeScript errors, no build errors.

**Step 4: Commit**

```bash
git add src/lib/types.ts src/hooks/use-mint-burn-flows.ts
git commit -m "feat(ui): add mint-burn flow types and TanStack Query hooks"
```

---

## Cross-Cutting: UI States Contract

> **Every frontend component (Tasks 9-14) MUST handle these three states consistently.** Reference this section when implementing each component.

### State 1: Loading (TanStack Query `isLoading`)

| Component | Behavior |
|-----------|----------|
| Flow Gauge | Gray silhouette of gauge arc, no needle, pulsing shimmer. Label: empty. |
| Flow Gauge Mini | Gray pill-shaped placeholder with shimmer, no score text. |
| Flow Chart | Recharts container at full height, gray shimmer fill (no axes/data). |
| Flow Table | Skeleton rows (5 rows × column count), pulsing gray bars for each cell. |
| Event Feed | 4 skeleton list items with gray bars for direction/amount/time. |
| Summary Card | Gray shimmer blocks where stat values appear. Labels visible, values replaced with shimmer. |

**Pattern:** Use existing shimmer/skeleton patterns from the codebase. Check `src/components/` for any shared `Skeleton` or loading components already in use.

### State 2: No Data / Calibrating (API returns `gauge.score === null`)

This state occurs during the first 7 days of operation — the system has no baseline yet. The API returns real data but with `null` scores.

| Component | Behavior |
|-----------|----------|
| Flow Gauge | Render gauge arc in `muted` color (no gradient). Needle at center (50 mark). Label: **"Calibrating…"** in `muted-foreground`. Subtitle: "Collecting baseline data (≤7 days)". |
| Flow Gauge Mini | Text: **"—"** in `muted-foreground`. No score, no color coding. |
| Flow Chart | Render chart normally if `hourly[]` has data (raw volumes work even without scores). If `hourly[]` is also empty, show centered text: "Collecting flow data…" |
| Flow Table | Render table rows with real volume data. FIS column: **"—"** instead of a bar/number for coins with `flowIntensity === null`. |
| Event Feed | If `events[]` is empty: centered icon + "No mint/burn events recorded yet. Flow tracking is initializing." If events exist, show them normally. |
| Summary Card | Show volume stats normally (they're non-null even during calibration). Replace score-dependent stats with **"—"**. |

**Key rule:** `null` score ≠ zero score. Never display `0` when the value is `null`. Always use `"—"` (em-dash) for null numeric displays, `"Calibrating…"` for null status labels.

### State 3: API Error (TanStack Query `isError`)

| Component | Behavior |
|-----------|----------|
| All components | Show a dismissible error banner above the component: "Unable to load flow data. Retrying…" in `destructive` variant. Do NOT show a blank/empty screen. Keep any previously cached data visible underneath (TanStack Query `data` may still have stale data). |

**Pattern:** Check the codebase for existing error banner or alert components (likely in `src/components/ui/`). Use the same pattern. If none exists, use a simple `<div>` with `bg-destructive/10 text-destructive` styling.

### Implementation Checklist (for each of Tasks 9-14)

Before marking any frontend task as complete, verify:
- [ ] `isLoading` → skeleton/shimmer shown (not blank)
- [ ] `gauge.score === null` → "Calibrating…" / em-dash shown (not `0`)
- [ ] `isError` → error banner shown (not blank screen)
- [ ] Stale data preserved on error (not cleared)

---

## Task 9: Flow Gauge Component

**Files:**
- Create: `src/components/flow-gauge.tsx`
- Create: `src/components/flow-gauge-mini.tsx`

**Context:** The gauge is a semicircular SVG "speedometer" visualization. Use the `frontend-design` skill for the visual design. The gauge must show: needle position (0-100), color gradient (red→amber→green), current band label, subtitle text, and optional flight-to-quality badge.

**Step 1: Build the full gauge component**

Create `src/components/flow-gauge.tsx`:

Props:
```typescript
interface FlowGaugeProps {
  score: number | null;
  band: string | null;
  flightToQuality: boolean;
  flightIntensity: number;
  trackedCoins: number;
}
```

When `score` is null (insufficient data), show a grayed-out gauge with "Calibrating..." label.

The gauge SVG should use a semicircular arc path with:
- Color gradient segments matching the 7 gauge bands from design doc Section 6.
- A needle/indicator pointing to the current score position.
- Band label centered below.
- Flight-to-quality badge conditionally rendered below.

Use static Tailwind classes only. Get band colors from the scoring module's `GAUGE_BANDS` — define a frontend-compatible mapping in the component (don't import from worker code).

**Step 2: Build the mini gauge**

Create `src/components/flow-gauge-mini.tsx`:

Props:
```typescript
interface FlowGaugeMiniProps {
  score: number | null;
  band: string | null;
}
```

A compact (48x24px-ish) inline indicator showing just the score number and a colored dot/bar matching the band color. Used on the homepage.

**Step 3: Build check**

Run: `npm run build`
Expected: No errors.

**Step 4: Commit**

```bash
git add src/components/flow-gauge.tsx src/components/flow-gauge-mini.tsx
git commit -m "feat(ui): add flow gauge and mini gauge components"
```

---

## Task 10: Flow Chart + Flow Table Components

**Files:**
- Create: `src/components/flow-chart.tsx`
- Create: `src/components/flow-table.tsx`

**Context:** The chart is a stacked area chart (Recharts `AreaChart`) with mint volume above x-axis (green) and burn volume below (red), plus a net flow line overlay. The table is a sortable per-coin summary. See design doc Section 8.

**Step 1: Build the flow chart**

Create `src/components/flow-chart.tsx`:

Props:
```typescript
interface FlowChartProps {
  hourly: MintBurnHourlyBucket[];
  isLoading: boolean;
}
```

Use Recharts `AreaChart` with:
- `mintVolumeUsd` as a green area above x-axis.
- `burnVolumeUsd` as a red area below x-axis (negate the values for display).
- `netFlowUsd` as a line overlay.
- Tooltip with formatted USD values (use `formatCurrency` from `src/lib/format.ts`).
- Responsive container.

Check existing chart components in `src/components/` for Recharts patterns and styling conventions already used in the codebase.

**Step 2: Build the flow table**

Create `src/components/flow-table.tsx`:

Props:
```typescript
interface FlowTableProps {
  coins: MintBurnCoinFlow[];
  isLoading: boolean;
}
```

Sortable table with columns: Coin (logo + symbol), Flow Intensity (0-100 bar), Net 24h, Minted 24h, Burned 24h, Net 7d, Largest Event.

Use the `<Table>` component from `src/components/ui/table.tsx`. Get stablecoin logos/metadata from the existing stablecoin list helpers. Use `formatCurrency` for USD values. Color-code net flows: green for positive (net mint), red for negative (net burn).

Default sort: by absolute Net 24h descending.

**Step 3: Build check**

Run: `npm run build`
Expected: No errors.

**Step 4: Commit**

```bash
git add src/components/flow-chart.tsx src/components/flow-table.tsx
git commit -m "feat(ui): add flow chart and flow table components"
```

---

## Task 11: Flow Event Feed + Summary Card

**Files:**
- Create: `src/components/flow-event-feed.tsx`
- Create: `src/components/flow-summary-card.tsx`

**Context:** The event feed is a paginated table of raw mint/burn events (used on the flows page and detail page). The summary card shows key stats for a single coin (used on the detail page).

**Step 1: Build the event feed**

Create `src/components/flow-event-feed.tsx`:

Props:
```typescript
interface FlowEventFeedProps {
  stablecoinId: string;
  limit?: number;
}
```

Internally calls `useMintBurnEvents()`. Renders a table with columns: Time (relative + absolute tooltip), Direction (mint/burn badge), Amount (USD), Chain, Tx (linked to explorer). Pagination with offset-based navigation (if `limit` is provided, show "Load more" or page controls).

Reference `src/app/blacklist/page.tsx` for the existing event table pattern with pagination.

**Step 2: Build the summary card**

Create `src/components/flow-summary-card.tsx`:

Props:
```typescript
interface FlowSummaryCardProps {
  stablecoinId: string;
}
```

Internally calls `useMintBurnFlows(stablecoinId)`. Shows:
- Flow Intensity score (with color-coded bar).
- Net 24h and Net 7d flows.
- Small sparkline or mini chart of hourly flows.
- Link to full `/flows` page.

Only renders content if the API returns data for this coin. Returns null if the coin has no flow data.

**Step 3: Build check**

Run: `npm run build`
Expected: No errors.

**Step 4: Commit**

```bash
git add src/components/flow-event-feed.tsx src/components/flow-summary-card.tsx
git commit -m "feat(ui): add flow event feed and summary card components"
```

---

## Task 12: Flows Page + Navigation

**Files:**
- Create: `src/app/flows/page.tsx`
- Modify: `src/lib/nav-config.ts`

**Context:** Follow the page pattern from `src/app/blacklist/page.tsx` — `"use client"` + inner component + Suspense wrapper. The flows page has 3 sections: Bank Run Gauge (hero), per-coin flow table, aggregate flow chart. See design doc Section 8.

**Step 1: Create the flows page**

Create `src/app/flows/page.tsx`:

```typescript
"use client";

import { Suspense } from "react";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
// ... import components

function FlowsPageInner() {
  const [hours, setHours] = useState(24);
  const { data, isLoading, isError, error, dataUpdatedAt } = useMintBurnFlows(undefined, hours);

  return (
    <div className="space-y-6">
      {/* Breadcrumb + Title + Description */}
      {/* Error/stale banners */}
      {/* Section 1: Bank Run Gauge (hero) */}
      {/* Section 2: Per-coin flow table */}
      {/* Section 3: Aggregate flow chart with time range toggle (24h/7d/30d) */}
    </div>
  );
}

export default function FlowsPage() {
  return (
    <Suspense>
      <FlowsPageInner />
    </Suspense>
  );
}
```

Use `TimeRangeButtons` or a `ToggleGroup` for the 24h/7d/30d chart toggle (pass different `hours` values: 24, 168, 720).

**Step 2: Add navigation entry**

In `src/lib/nav-config.ts`, add to the "Data" group:

```typescript
{
  label: "Data",
  items: [
    { href: "/liquidity", label: "Liquidity", icon: Droplets },
    { href: "/flows", label: "Flows", icon: ArrowUpDown },  // or Activity, TrendingDown
    { href: "/blacklist", label: "Blacklist Tracker", icon: ShieldBan },
    { href: "/compare", label: "Compare", icon: ArrowLeftRight },
  ],
},
```

Pick an appropriate `lucide-react` icon. `ArrowUpDown`, `Activity`, or `Banknote` would work. Check what's already imported in the file.

**Step 3: Build check**

Run: `npm run build`
Expected: No errors. The static export should generate the `/flows` route.

**Step 4: Commit**

```bash
git add src/app/flows/page.tsx src/lib/nav-config.ts
git commit -m "feat(ui): add /flows page with Bank Run Gauge and flow table"
```

---

## Task 13: Detail Page Integration

**Files:**
- Modify: `src/app/stablecoin/[id]/client.tsx`

**Context:** Add a "Mint/Burn Flows" section to the stablecoin detail page. It should only render for coins that have flow data (the 10 tracked coins). See design doc Section 8 "Detail page integration".

**Step 1: Add the flows section**

In `src/app/stablecoin/[id]/client.tsx`:

1. Import `FlowSummaryCard` and `FlowEventFeed`.
2. Add `"flows"` to the `DETAIL_SECTIONS` array (after "liquidity", before "history"):
   ```typescript
   { id: "flows", label: "Flows" },
   ```
3. Add a conditional section in the JSX (after the liquidity section):
   ```tsx
   <section id="flows">
     <FlowSummaryCard stablecoinId={id} />
     <FlowEventFeed stablecoinId={id} limit={10} />
   </section>
   ```

The `FlowSummaryCard` component handles its own data fetching and returns null if the coin has no flow data, so no gating logic is needed in the parent.

**Step 2: Build check**

Run: `npm run build`
Expected: No errors.

**Step 3: Commit**

```bash
git add src/app/stablecoin/[id]/client.tsx
git commit -m "feat(ui): add mint/burn flows section to stablecoin detail page"
```

---

## Task 14: Homepage Mini Gauge

**Files:**
- Modify: `src/app/page.tsx` (or wherever the homepage KPI/header stats are rendered)

**Context:** Add a compact flow indicator to the homepage. The design says "Gauge mini" + "Flow trend" text. Find where the existing header stats are rendered (look for the KPI bar or market highlights section).

**Step 1: Add the mini gauge**

1. Find the homepage component that renders market stats/KPIs (search for where "Total Market Cap" or header stats are displayed).
2. Import `FlowGaugeMini` and `useMintBurnFlows`.
3. Add a compact flow indicator showing:
   - The mini gauge (score + band color)
   - A one-line flow trend: "Net 24h: +$1.2B minted" or "Net 24h: -$500M redeemed"

This should degrade gracefully: if the flows API returns no data (503 or empty), hide the indicator entirely.

**Step 2: Build check**

Run: `npm run build`
Expected: No errors.

**Step 3: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat(ui): add mint/burn flow mini gauge to homepage"
```

---

## Task 15: Documentation Updates

**Files:**
- Modify: `docs/architecture.md` (add new files to directory tree)
- Modify: `docs/api-reference.md` (add 2 new endpoints)
- Modify: `docs/worker-infrastructure.md` (update cron slot table, add shared rate limiter note)
- Modify: `src/app/about/page.tsx` (add Etherscan as data source if not already listed)
- Modify: `src/app/methodology/page.tsx` (add FIS and Bank Run Gauge methodology)

**Context:** Per CLAUDE.md: "When adding a data source, update the about page" and "After updating a scoring methodology, update the /methodology page."

**Step 1: Update architecture docs**

Add the new files to the directory tree in `docs/architecture.md`. Add the 2 new API endpoints.

**Step 2: Update API reference**

In `docs/api-reference.md`, add full documentation for:
- `GET /api/mint-burn-flows` — params, response shapes, cache profile
- `GET /api/mint-burn-events` — params, response shapes, cache profile

Follow the format of existing endpoint documentation.

**Step 3: Update worker infrastructure**

In `docs/worker-infrastructure.md`, update the cron slot table to show `sync-mint-burn` on Trigger 2. Document the shared Etherscan rate limiter pattern.

**Step 4: Update about page**

If Etherscan is not already listed as a data source on the about page, add it with a note about what it's used for (on-chain Transfer event monitoring for mint/burn flow tracking).

**Step 5: Update methodology page**

Add a section explaining:
- Flow Intensity Score (FIS): what it measures, the 0-100 scale, the baseline period
- Bank Run Gauge: mcap-weighted composite, the 7 bands and their meanings
- Flight-to-quality detection: safe vs risky classification, threshold triggers

**Step 6: Build check**

Run: `npm run build`
Expected: No errors.

**Step 7: Commit**

```bash
git add docs/architecture.md docs/api-reference.md docs/worker-infrastructure.md src/app/about/page.tsx src/app/methodology/page.tsx
git commit -m "docs: add mint/burn flow documentation to architecture, API reference, methodology"
```

---

## Task 16: Final Verification

**Step 1: Run all tests**

Run: `npm test`
Expected: All tests pass including new scoring tests and evm-logs tests.

**Step 2: Run lint**

Run: `npm run lint`
Expected: No errors (warnings acceptable).

**Step 3: Full build**

Run: `npm run build`
Expected: Clean build with all pages generated including `/flows`.

**Step 4: Worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

**Step 5: Manual smoke test**

Run the worker dev server and frontend dev server:
```bash
cd worker && npx wrangler dev &
npm run dev
```

Verify:
- `/flows` page loads (will show loading/empty state without data)
- `/api/mint-burn-flows` returns 503 (no data yet) or empty response
- `/api/mint-burn-events?stablecoin=1` returns 200 with empty events array
- Navigation sidebar shows the new "Flows" link
- Stablecoin detail pages load without errors (flows section hidden when no data)

**Step 6: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address issues found during final verification"
```
