# pyUSD + USD1 Blacklist Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add blacklist event tracking for pyUSD (Ethereum, Arbitrum) and USD1 (Ethereum, BSC, Tron) to the existing blacklist tracker, with a parser extension to handle USD1's two-indexed-address events.

**Architecture:** Extend `BlacklistEventDef` with `addressTopicIndex` (EVM) and `tronResultKey` (Tron) to support USD1's `Freeze(address indexed caller, address indexed account)` where the affected address is in `topics[2]`. pyUSD uses the existing single-indexed-address pattern. The aggregation layer (`BlacklistChartPoint`, `computeBlacklistSummaryStats`, `BLACKLIST_CHART_COLORS`, chart component) must be made dynamic to avoid hardcoded 4-stablecoin references.

**Tech Stack:** TypeScript, Vitest, Cloudflare Workers, D1, Recharts

**Spec:** `docs/superpowers/specs/2026-03-24-pyusd-usd1-blacklist-tracking-design.md`

---

### Task 1: Extend shared types

**Files:**
- Modify: `shared/types/market.ts:395` (BLACKLIST_STABLECOINS)
- Modify: `shared/types/market.ts:468-475` (BlacklistChartPointSchema)

- [ ] **Step 1: Extend BLACKLIST_STABLECOINS**

In `shared/types/market.ts`, change line 395:
```ts
// Before:
export const BLACKLIST_STABLECOINS = ["USDC", "USDT", "PAXG", "XAUT"] as const;

// After:
export const BLACKLIST_STABLECOINS = ["USDC", "USDT", "PAXG", "XAUT", "PYUSD", "USD1"] as const;
```

- [ ] **Step 2: Make BlacklistChartPointSchema dynamic**

In `shared/types/market.ts`, replace lines 468-475:
```ts
// Before:
const BlacklistChartPointSchema = z.object({
  quarter: z.string(),
  USDT: z.number(),
  USDC: z.number(),
  PAXG: z.number(),
  XAUT: z.number(),
  total: z.number(),
});

// After:
const BlacklistChartPointSchema = z.object({
  quarter: z.string(),
  ...Object.fromEntries(BLACKLIST_STABLECOINS.map((s) => [s, z.number()])),
  total: z.number(),
});
```

- [ ] **Step 3: Type-check**

Run: `npm run build`
Expected: Type errors in `shared/lib/blacklist-aggregates.ts` (hardcoded chart point properties) and `shared/lib/classification.ts` (missing BLACKLIST_CHART_COLORS keys). These are expected and will be fixed in Tasks 2-3.

- [ ] **Step 4: Commit**

```bash
git add shared/types/market.ts
git commit -m "feat(blacklist): add PYUSD and USD1 to BLACKLIST_STABLECOINS, make chart schema dynamic"
```

---

### Task 2: Fix aggregation layer

**Files:**
- Modify: `shared/lib/blacklist-aggregates.ts:1-112`

- [ ] **Step 1: Write failing tests**

Create `shared/lib/__tests__/blacklist-aggregates.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildBlacklistChartData, computeBlacklistSummaryStats } from "../blacklist-aggregates";
import type { BlacklistEvent } from "../../types/market";

function makeEvent(overrides: Partial<BlacklistEvent> = {}): BlacklistEvent {
  return {
    id: "bl-1",
    stablecoin: "USDT",
    chainId: "ethereum",
    chainName: "Ethereum",
    eventType: "blacklist",
    address: "0xabc",
    amountNative: 1000,
    amountUsdAtEvent: 1000,
    amountSource: "event",
    amountStatus: "resolved",
    txHash: "0xtx",
    blockNumber: 19000000,
    timestamp: 1770000000,
    methodologyVersion: "3.3",
    contractAddress: "0xcontract",
    configKey: "ethereum-0xcontract",
    eventSignature: "Blacklisted(address)",
    eventTopic0: "0xtopic",
    explorerTxUrl: "https://etherscan.io/tx/0xtx",
    explorerAddressUrl: "https://etherscan.io/address/0xabc",
    ...overrides,
  };
}

describe("buildBlacklistChartData", () => {
  it("includes PYUSD and USD1 in chart data and total", () => {
    const events = [
      makeEvent({ id: "1", stablecoin: "PYUSD", amountUsdAtEvent: 500, timestamp: 1770000000 }),
      makeEvent({ id: "2", stablecoin: "USD1", amountUsdAtEvent: 300, timestamp: 1770000000 }),
      makeEvent({ id: "3", stablecoin: "USDC", amountUsdAtEvent: 200, timestamp: 1770000000 }),
    ];
    const chart = buildBlacklistChartData(events);
    expect(chart.length).toBeGreaterThan(0);
    const point = chart[0];
    expect(point.PYUSD).toBe(500);
    expect(point.USD1).toBe(300);
    expect(point.USDC).toBe(200);
    expect(point.total).toBe(1000);
  });

  it("returns zero for stablecoins with no events in a quarter", () => {
    const events = [makeEvent({ stablecoin: "USDT", amountUsdAtEvent: 100, timestamp: 1770000000 })];
    const chart = buildBlacklistChartData(events);
    const point = chart[0];
    expect(point.PYUSD).toBe(0);
    expect(point.USD1).toBe(0);
  });
});

describe("computeBlacklistSummaryStats", () => {
  it("routes PYUSD and USD1 to frozenAddresses but not usdcBlacklisted or usdtBlacklisted", () => {
    const events = [
      makeEvent({ id: "1", stablecoin: "PYUSD", address: "0xpyusd1" }),
      makeEvent({ id: "2", stablecoin: "USD1", address: "0xusd1a" }),
      makeEvent({ id: "3", stablecoin: "USDC", address: "0xusdc1" }),
      makeEvent({ id: "4", stablecoin: "USDT", address: "0xusdt1" }),
    ];
    const stats = computeBlacklistSummaryStats(events);
    expect(stats.usdcBlacklisted).toBe(1);
    expect(stats.usdtBlacklisted).toBe(1);
    expect(stats.frozenAddresses).toBe(4); // all four contribute to total
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- shared/lib/__tests__/blacklist-aggregates.test.ts`
Expected: FAIL — `buildBlacklistChartData` returns no `PYUSD`/`USD1` keys, and `computeBlacklistSummaryStats` routes PYUSD into `usdtBlacklisted`.

- [ ] **Step 3: Fix BlacklistChartPoint type**

In `shared/lib/blacklist-aggregates.ts`, replace lines 1-26:
```ts
import {
  buildBlacklistAddressCountKey,
  isBlacklistAmountGapStatus,
  isGoldBlacklistStablecoin,
  type BlacklistAddressCountMode,
} from "./blacklist";
import { BLACKLIST_STABLECOINS } from "../types/market";
import type { BlacklistEvent, BlacklistStablecoin } from "../types/market";

export interface BlacklistSummaryStats {
  usdcBlacklisted: number;
  usdtBlacklisted: number;
  goldBlacklisted: number;
  frozenAddresses: number;
  destroyedTotal: number;
  recentCount: number;
  recoverableGapCount: number;
}

export type BlacklistChartPoint = { quarter: string; total: number } & Record<BlacklistStablecoin, number>;
```

- [ ] **Step 4: Fix buildBlacklistChartData**

In `shared/lib/blacklist-aggregates.ts`, replace the `buildBlacklistChartData` function (lines 85-112):
```ts
export function buildBlacklistChartData(events: BlacklistEvent[]): BlacklistChartPoint[] {
  const emptyBucket = (): Record<BlacklistStablecoin, number> =>
    Object.fromEntries(BLACKLIST_STABLECOINS.map((s) => [s, 0])) as Record<BlacklistStablecoin, number>;

  const buckets = new Map<number, Record<BlacklistStablecoin, number>>();

  for (const evt of events) {
    if (evt.eventType !== "blacklist" || evt.amountUsdAtEvent == null || evt.amountUsdAtEvent <= 0) continue;
    const sortKey = quarterToSortKey(evt.timestamp);
    const bucket = buckets.get(sortKey) ?? emptyBucket();
    bucket[evt.stablecoin] = (bucket[evt.stablecoin] ?? 0) + evt.amountUsdAtEvent;
    buckets.set(sortKey, bucket);
  }

  if (buckets.size === 0) return [];
  const sortKeys = [...buckets.keys()].sort((a, b) => a - b);
  const result: BlacklistChartPoint[] = [];
  for (let sortKey = sortKeys[0]; sortKey <= sortKeys[sortKeys.length - 1]; sortKey++) {
    const bucket = buckets.get(sortKey);
    const total = BLACKLIST_STABLECOINS.reduce((sum, s) => sum + (bucket?.[s] ?? 0), 0);
    const point = Object.fromEntries(BLACKLIST_STABLECOINS.map((s) => [s, bucket?.[s] ?? 0])) as Record<BlacklistStablecoin, number>;
    result.push({ quarter: sortKeyToLabel(sortKey), ...point, total });
  }
  return result;
}
```

- [ ] **Step 5: Fix computeBlacklistSummaryStats routing**

In `shared/lib/blacklist-aggregates.ts`, in `computeBlacklistSummaryStats`, add an `otherAddresses` map after `goldAddresses` (line 47):
```ts
  const otherAddresses = new Map<string, number>();
```

Replace line 56:
```ts
    // Before:
    const map = isGold ? goldAddresses : evt.stablecoin === "USDC" ? usdcAddresses : usdtAddresses;

    // After:
    const map = isGold ? goldAddresses
      : evt.stablecoin === "USDC" ? usdcAddresses
      : evt.stablecoin === "USDT" ? usdtAddresses
      : otherAddresses;
```

No change to the return value — `otherAddresses` is not surfaced in its own stat card. It only feeds into `allAddresses` (via the `allAddresses.set()` calls on lines 59-63 which already cover all events).

- [ ] **Step 6: Run tests**

Run: `npm test -- shared/lib/__tests__/blacklist-aggregates.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add shared/lib/blacklist-aggregates.ts shared/lib/__tests__/blacklist-aggregates.test.ts
git commit -m "feat(blacklist): make chart/summary aggregation dynamic for new stablecoins"
```

---

### Task 3: Add chart colors and fix chart component

**Files:**
- Modify: `shared/lib/classification.ts:315-320`
- Modify: `src/components/blacklist-chart.tsx:13,136-138`

- [ ] **Step 1: Add PYUSD and USD1 to BLACKLIST_CHART_COLORS**

In `shared/lib/classification.ts`, replace lines 315-320:
```ts
// Before:
export const BLACKLIST_CHART_COLORS: Record<BlacklistStablecoin, string> = {
  USDT: "#06b6d4",
  USDC: "#3b82f6",
  PAXG: "#eab308",
  XAUT: "#f59e0b",
};

// After:
export const BLACKLIST_CHART_COLORS: Record<BlacklistStablecoin, string> = {
  USDT: "#06b6d4",
  USDC: "#3b82f6",
  PYUSD: "#6366f1",
  USD1: "#c026d3",
  PAXG: "#eab308",
  XAUT: "#f59e0b",
};
```

Note: Using `#6366f1` (indigo) for PYUSD instead of the spec's `#002e6e` — better contrast at 62% opacity on dark themes.

- [ ] **Step 2: Update STABLECOINS_ORDER and radius logic in chart**

In `src/components/blacklist-chart.tsx`, change line 13:
```ts
// Before:
const STABLECOINS_ORDER = ["USDT", "USDC", "PAXG", "XAUT"] as const satisfies readonly BlacklistStablecoin[];

// After:
const STABLECOINS_ORDER = ["USDT", "USDC", "PYUSD", "USD1", "PAXG", "XAUT"] as const satisfies readonly BlacklistStablecoin[];
```

Replace the stacked bar radius logic (lines 130-139) to use the last element dynamically:
```tsx
                {STABLECOINS_ORDER.map((coin, i) => (
                  <Bar
                    key={coin}
                    dataKey={coin}
                    stackId="a"
                    fill={BLACKLIST_CHART_COLORS[coin]}
                    fillOpacity={i === 0 ? 0.75 : 0.62}
                    radius={i === STABLECOINS_ORDER.length - 1 ? [3, 3, 0, 0] : undefined}
                  />
                ))}
```

- [ ] **Step 3: Type-check**

Run: `npm run build`
Expected: PASS — the `Record<BlacklistStablecoin, string>` on `BLACKLIST_CHART_COLORS` will now require all 6 keys.

- [ ] **Step 4: Commit**

```bash
git add shared/lib/classification.ts src/components/blacklist-chart.tsx
git commit -m "feat(blacklist): add PYUSD/USD1 chart colors, update stacked bar order"
```

---

### Task 4: Extend BlacklistEventDef and add contract configs

**Files:**
- Modify: `worker/src/lib/blacklist-contracts.ts:28-33,74-264`
- Test: `worker/src/lib/__tests__/blacklist-contracts.test.ts`

- [ ] **Step 1: Add addressTopicIndex and tronResultKey to BlacklistEventDef**

In `worker/src/lib/blacklist-contracts.ts`, replace lines 28-33:
```ts
// Before:
export interface BlacklistEventDef {
  signature: string;     // Human-readable event signature
  topicHash: string;     // Keccak256 of the event signature
  eventType: BlacklistEventType;
  hasAmount: boolean;
}

// After:
export interface BlacklistEventDef {
  signature: string;     // Human-readable event signature
  topicHash: string;     // Keccak256 of the event signature
  eventType: BlacklistEventType;
  hasAmount: boolean;
  addressTopicIndex?: number;  // EVM: which topics[] slot holds the affected address (default 1)
  tronResultKey?: string;      // Tron: which result key holds the affected address
}
```

- [ ] **Step 2: Add pyUSD event family**

After the PAXG event family (line 191), add:
```ts
// --- pyUSD event definitions (Paxos PaxosTokenV2 contract) ---
// FreezeAddress/UnfreezeAddress/FrozenAddressWiped — address is indexed (in topics[1])

const PYUSD_FREEZE_TOPIC = "0x1aa660498c83ea285bc55e4cfc00afcaa7120798db87b74f3c0d7c6e001bc392"; // FreezeAddress(address)
const PYUSD_UNFREEZE_TOPIC = "0x150465b020dfc06a59269da94ed66db9b65a516cf4fdd5f583b0f12752339bbe"; // UnfreezeAddress(address)
const PYUSD_WIPED_TOPIC = "0xfc5960f1c5a5d2b60f031bf534af053b1bf7d9881989afaeb8b1d164db23aede"; // FrozenAddressWiped(address)

const PYUSD_EVENT_FAMILY = defineEventFamily("paxos-pyusd-freeze", [
  {
    signature: "FreezeAddress(address)",
    topicHash: PYUSD_FREEZE_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "UnfreezeAddress(address)",
    topicHash: PYUSD_UNFREEZE_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
  {
    signature: "FrozenAddressWiped(address)",
    topicHash: PYUSD_WIPED_TOPIC,
    eventType: "destroy",
    hasAmount: false, // Amount not in event; fetched via balanceOf at blockNumber-1
  },
]);
```

**IMPORTANT:** The topic hashes above must be verified. Compute them during implementation:
```bash
node -e "const {keccak256,toUtf8Bytes}=require('ethers'); console.log(keccak256(toUtf8Bytes('FreezeAddress(address)')))"
```
Or use `cast keccak "FreezeAddress(address)"` if foundry is available. Verify all three hashes before committing.

- [ ] **Step 3: Add USD1 event family**

After the pyUSD event family, add:
```ts
// --- USD1 event definitions (World Liberty Financial Stablecoin contract) ---
// Freeze(address indexed caller, address indexed account) / Unfreeze — affected address in topics[2]

const USD1_FREEZE_TOPIC = "0x51d18786e9cb144f87d46e7b796309ea84c7c687d91e09c97f051eacf59bc528"; // Freeze(address,address)
const USD1_UNFREEZE_TOPIC = "0x4f3ab9ff0cc4f039268532098e01239544b0420171876e36889d01c62c784c79"; // Unfreeze(address,address)

const USD1_EVENT_FAMILY = defineEventFamily("wlfi-freeze", [
  {
    signature: "Freeze(address,address)",
    topicHash: USD1_FREEZE_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
    addressTopicIndex: 2,
    tronResultKey: "account",
  },
  {
    signature: "Unfreeze(address,address)",
    topicHash: USD1_UNFREEZE_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
    addressTopicIndex: 2,
    tronResultKey: "account",
  },
]);
```

Verify these topic hashes too:
```bash
node -e "const {keccak256,toUtf8Bytes}=require('ethers'); console.log(keccak256(toUtf8Bytes('Freeze(address,address)')))"
```

- [ ] **Step 4: Add contract config specs**

In the `CONTRACT_CONFIG_SPECS` array (after the XAUT entry at line 263), add:
```ts
  // pyUSD (Ethereum + Arbitrum)
  { chain: ETHEREUM, stablecoinId: "pyusd-paypal", events: PYUSD_EVENT_FAMILY.events },
  { chain: ARBITRUM, stablecoinId: "pyusd-paypal", events: PYUSD_EVENT_FAMILY.events },

  // USD1 (Ethereum + BSC + Tron)
  { chain: ETHEREUM, stablecoinId: "usd1-world-liberty-financial", events: USD1_EVENT_FAMILY.events },
  { chain: BSC, stablecoinId: "usd1-world-liberty-financial", events: USD1_EVENT_FAMILY.events },
  { chain: TRON, stablecoinId: "usd1-world-liberty-financial", events: USD1_EVENT_FAMILY.events },
```

- [ ] **Step 5: Run existing contract config tests**

Run: `npm test -- worker/src/lib/__tests__/blacklist-contracts.test.ts`
Expected: PASS — the existing test at line 11 (`resolves each tracked contract from shared stablecoin metadata`) will verify that pyusd-paypal and usd1-world-liberty-financial contract addresses exist in the shared stablecoin data for each declared chain.

- [ ] **Step 6: Commit**

```bash
git add worker/src/lib/blacklist-contracts.ts
git commit -m "feat(blacklist): add pyUSD and USD1 event families and contract configs"
```

---

### Task 5: Update EVM parser for addressTopicIndex

**Files:**
- Modify: `worker/src/cron/blacklist/evm-source.ts:73-76`
- Test: `worker/src/cron/__tests__/sync-blacklist.test.ts` (existing tests still pass)

- [ ] **Step 1: Write failing test for topics[2] extraction**

Add a test to `worker/src/cron/__tests__/sync-blacklist.test.ts` (or a new focused test file `worker/src/cron/blacklist/__tests__/evm-source.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { parseEvmLogs } from "../evm-source";
import type { ContractEventConfig } from "../../../lib/blacklist-contracts";

const USD1_CONFIG: ContractEventConfig = {
  configKey: "ethereum-0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d",
  chain: { chainId: "ethereum", chainName: "Ethereum", evmChainId: 1, explorerUrl: "https://etherscan.io", type: "evm" },
  stablecoinId: "usd1-world-liberty-financial",
  stablecoin: "USD1",
  contractAddress: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d",
  decimals: 18,
  events: [
    {
      signature: "Freeze(address,address)",
      topicHash: "0x51d18786e9cb144f87d46e7b796309ea84c7c687d91e09c97f051eacf59bc528",
      eventType: "blacklist",
      hasAmount: false,
      addressTopicIndex: 2,
    },
  ],
};

const USDC_CONFIG: ContractEventConfig = {
  configKey: "ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  chain: { chainId: "ethereum", chainName: "Ethereum", evmChainId: 1, explorerUrl: "https://etherscan.io", type: "evm" },
  stablecoinId: "usdc-circle",
  stablecoin: "USDC",
  contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  decimals: 6,
  events: [
    {
      signature: "Blacklisted(address)",
      topicHash: "0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855",
      eventType: "blacklist",
      hasAmount: false,
    },
  ],
};

describe("parseEvmLogs", () => {
  it("extracts address from topics[2] when addressTopicIndex is 2 (USD1)", () => {
    const callerAddr = "0x0000000000000000000000001111111111111111111111111111111111111111";
    const frozenAddr = "0x0000000000000000000000002222222222222222222222222222222222222222";
    const logs = [{
      address: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d",
      topics: [
        "0x51d18786e9cb144f87d46e7b796309ea84c7c687d91e09c97f051eacf59bc528",
        callerAddr,
        frozenAddr,
      ],
      data: "0x",
      blockNumber: "0x1234",
      transactionHash: "0xabc",
      logIndex: "0x0",
      timeStamp: "0x65000000",
    }];
    const rows = parseEvmLogs(USD1_CONFIG, logs);
    expect(rows).toHaveLength(1);
    expect(rows[0].address).toBe("0x2222222222222222222222222222222222222222");
    expect(rows[0].stablecoin).toBe("USD1");
    expect(rows[0].event_type).toBe("blacklist");
  });

  it("extracts address from topics[1] by default (USDC regression)", () => {
    const blacklistedAddr = "0x0000000000000000000000003333333333333333333333333333333333333333";
    const logs = [{
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      topics: [
        "0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855",
        blacklistedAddr,
      ],
      data: "0x",
      blockNumber: "0x1234",
      transactionHash: "0xdef",
      logIndex: "0x0",
      timeStamp: "0x65000000",
    }];
    const rows = parseEvmLogs(USDC_CONFIG, logs);
    expect(rows).toHaveLength(1);
    expect(rows[0].address).toBe("0x3333333333333333333333333333333333333333");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- worker/src/cron/blacklist/__tests__/evm-source.test.ts`
Expected: FAIL — the USD1 test will extract the caller from `topics[1]` instead of the frozen address from `topics[2]`.

- [ ] **Step 3: Update parseEvmLogs**

In `worker/src/cron/blacklist/evm-source.ts`, replace lines 73-76:
```ts
    // Before:
    const addressIndexed = log.topics.length > 1;
    const affectedAddress = addressIndexed ? decodeAddress(log.topics[1]) : decodeAddress(log.data.slice(0, 66));

    // After:
    const topicIdx = eventDef.addressTopicIndex ?? 1;
    const addressIndexed = log.topics.length > topicIdx;
    const affectedAddress = addressIndexed ? decodeAddress(log.topics[topicIdx]) : decodeAddress(log.data.slice(0, 66));
```

- [ ] **Step 4: Run tests**

Run: `npm test -- worker/src/cron/blacklist/__tests__/evm-source.test.ts`
Expected: PASS

- [ ] **Step 5: Run full blacklist test suite for regression**

Run: `npm test -- worker/src/cron/__tests__/sync-blacklist.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/blacklist/evm-source.ts worker/src/cron/blacklist/__tests__/evm-source.test.ts
git commit -m "feat(blacklist): support configurable addressTopicIndex in EVM parser"
```

---

### Task 6: Update Tron parser

**Files:**
- Modify: `worker/src/cron/blacklist/tron-source.ts:32-36,47`

- [ ] **Step 1: Extend TRON_EVENT_NAME_MAP**

In `worker/src/cron/blacklist/tron-source.ts`, replace lines 32-36:
```ts
// Before:
const TRON_EVENT_NAME_MAP: Record<string, BlacklistEventType> = {
  AddedBlackList: "blacklist",
  RemovedBlackList: "unblacklist",
  DestroyedBlackFunds: "destroy",
};

// After:
const TRON_EVENT_NAME_MAP: Record<string, BlacklistEventType> = {
  AddedBlackList: "blacklist",
  RemovedBlackList: "unblacklist",
  DestroyedBlackFunds: "destroy",
  Freeze: "blacklist",
  Unfreeze: "unblacklist",
};
```

- [ ] **Step 2: Update address extraction in parseTronEvent**

In `worker/src/cron/blacklist/tron-source.ts`, replace line 47:
```ts
  // Before:
  const affectedAddress = evt.result._user || evt.result._blackListedUser || evt.result["0"] || "";

  // After:
  const affectedAddress = (eventDef.tronResultKey && evt.result[eventDef.tronResultKey])
    || evt.result._user
    || evt.result._blackListedUser
    || evt.result["0"]
    || evt.result["1"]
    || "";
```

- [ ] **Step 3: Run existing sync-blacklist tests for Tron regression**

Run: `npm test -- worker/src/cron/__tests__/sync-blacklist.test.ts`
Expected: PASS — existing Tron tests use `_user`/`_blackListedUser` keys and should not be affected.

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/blacklist/tron-source.ts
git commit -m "feat(blacklist): extend Tron parser for USD1 Freeze/Unfreeze events"
```

---

### Task 7: Update API type and methodology version

**Files:**
- Modify: `worker/src/api/blacklist-summary.ts:18-20`
- Modify: `shared/lib/blacklist-tracker-version.ts:3-12`

- [ ] **Step 1: Fix SummaryRow type**

In `worker/src/api/blacklist-summary.ts`, replace lines 18-20:
```ts
// Before:
type SummaryRow = {
  id: string;
  stablecoin: "USDC" | "USDT" | "PAXG" | "XAUT";

// After:
type SummaryRow = {
  id: string;
  stablecoin: BlacklistStablecoin;
```

Add the import at the top of the file (after the existing imports):
```ts
import type { BlacklistStablecoin } from "@shared/types";
```

- [ ] **Step 2: Bump methodology version**

In `shared/lib/blacklist-tracker-version.ts`, update `currentVersion` to `"3.3"` and add a new changelog entry at the top of the array:
```ts
const blacklistTracker = createMethodologyVersion({
  currentVersion: "3.3",
  changelogPath: "/methodology/blacklist-tracker-changelog/",
  changelog: [
  {
    version: "3.3",
    title: "pyUSD and USD1 blacklist tracking coverage",
    date: "2026-03-24",
    effectiveAt: 1774353600,
    summary:
      "Extended blacklist tracker to cover pyUSD (PayPal/Paxos) on Ethereum and Arbitrum, and USD1 (World Liberty Financial) on Ethereum, BSC, and Tron. Introduced configurable address topic index for two-indexed-address events.",
    impact: [
      "Added pyUSD FreezeAddress/UnfreezeAddress/FrozenAddressWiped event tracking (Paxos PaxosTokenV2 pattern)",
      "Added USD1 Freeze/Unfreeze event tracking with addressTopicIndex=2 for dual-indexed events",
      "EVM parser now supports configurable topic index for affected address extraction",
      "Tron parser extended with tronResultKey for non-standard event parameter names",
      "Aggregation layer (chart, summary stats) made dynamic to accommodate new stablecoins",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.2",
    // ... existing entry unchanged
```

- [ ] **Step 3: Run existing API tests**

Run: `npm test -- worker/src/api/__tests__/blacklist-summary.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add worker/src/api/blacklist-summary.ts shared/lib/blacklist-tracker-version.ts
git commit -m "feat(blacklist): bump methodology to v3.3, fix SummaryRow type"
```

---

### Task 8: Update documentation

**Files:**
- Modify: `docs/blacklist-tracker.md:5-7,365`
- Modify: `docs/blacklist-tracker-timeline.md` (prepend v3.3 entry)
- Modify: `src/app/about/page.tsx:255-256`

- [ ] **Step 1: Update blacklist-tracker.md**

At line 5, change:
```
Cron-backed sync coverage: USDC, USDT, PAXG, XAUT.
```
to:
```
Cron-backed sync coverage: USDC, USDT, PAXG, XAUT, PYUSD, USD1.
```

At line 7, change:
```
Live API/UI filter enum: USDC, USDT, PAXG, XAUT via `BLACKLIST_STABLECOINS` in `shared/types/index.ts`.
```
to:
```
Live API/UI filter enum: USDC, USDT, PAXG, XAUT, PYUSD, USD1 via `BLACKLIST_STABLECOINS` in `shared/types/index.ts`.
```

At line 365, change:
```
| `stablecoin` | string | --      | Filter by name (`"USDC"`, `"USDT"`, `"PAXG"`, `"XAUT"`)              |
```
to:
```
| `stablecoin` | string | --      | Filter by name (`"USDC"`, `"USDT"`, `"PAXG"`, `"XAUT"`, `"PYUSD"`, `"USD1"`)  |
```

At line 372, change:
```
The handler now exposes only the live-supported symbols: USDC, USDT, PAXG, and XAUT.
```
to:
```
The handler now exposes only the live-supported symbols: USDC, USDT, PAXG, XAUT, PYUSD, and USD1.
```

- [ ] **Step 2: Update blacklist-tracker-timeline.md**

Prepend before the v3.2 entry:
```md
## v3.3 — pyUSD and USD1 blacklist tracking coverage (Mar 24, 2026)

- Added pyUSD (PayPal/Paxos) blacklist event tracking on Ethereum and Arbitrum using `FreezeAddress`, `UnfreezeAddress`, and `FrozenAddressWiped` events
- Added USD1 (World Liberty Financial) blacklist event tracking on Ethereum, BSC, and Tron using `Freeze` and `Unfreeze` events with `addressTopicIndex: 2` for dual-indexed address extraction
- Extended `BlacklistEventDef` with `addressTopicIndex` (EVM) and `tronResultKey` (Tron) for flexible address extraction
- Made aggregation layer dynamic: `BlacklistChartPoint`, `buildBlacklistChartData`, `computeBlacklistSummaryStats`, `BLACKLIST_CHART_COLORS`

---
```

- [ ] **Step 3: Update about page**

In `src/app/about/page.tsx`, change lines 255-256:
```ts
// Before:
      description:
        "USDC, USDT, PAXG, and XAUT blacklist events across Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche, BSC, and Tron.",

// After:
      description:
        "USDC, USDT, PAXG, XAUT, PYUSD, and USD1 blacklist events across Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche, BSC, and Tron.",
```

- [ ] **Step 4: Commit**

```bash
git add docs/blacklist-tracker.md docs/blacklist-tracker-timeline.md src/app/about/page.tsx
git commit -m "docs: update blacklist tracker docs for pyUSD and USD1 coverage"
```

---

### Task 9: Final validation

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 2: Run type-check and lint**

Run: `npm run build && npm run lint`
Expected: PASS

- [ ] **Step 3: Run worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Run merge gate**

Run: `npm run test:merge-gate`
Expected: PASS — this mirrors full CI validation.

- [ ] **Step 5: Verify contract config count**

Run: `npm test -- worker/src/lib/__tests__/blacklist-contracts.test.ts`
Verify output: 21 contract configs resolved (16 existing + 5 new: pyUSD ETH, pyUSD ARB, USD1 ETH, USD1 BSC, USD1 Tron).
