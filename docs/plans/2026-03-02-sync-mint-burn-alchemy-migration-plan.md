# Mint/Burn Alchemy Migration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate `sync-mint-burn.ts` from Etherscan V2 REST to Alchemy JSON-RPC for `eth_getLogs` and `eth_blockNumber`, enabling multi-chain mint/burn tracking (Ethereum, Arbitrum, Base, Optimism, Avalanche — Polygon not used yet but supported).

**Architecture:** New `worker/src/lib/alchemy-logs.ts` module with three functions (`getAlchemyBlockNumber`, `fetchAlchemyLogs`, `resolveBlockTimestamps`). `sync-mint-burn.ts` switches from Etherscan imports to Alchemy imports. Block timestamps resolved via batch `eth_getBlockByNumber` calls (Alchemy's `eth_getLogs` doesn't include timestamps). Blacklist sync stays on Etherscan — no changes to `sync-blacklist.ts`.

**Tech Stack:** TypeScript, Cloudflare Workers `fetch()`, Alchemy JSON-RPC (PAYG plan), Vitest.

**Design doc:** `docs/plans/2026-03-02-sync-mint-burn-alchemy-migration.md`

---

### Task 1: Export `ALCHEMY_CHAINS` from `chain-rpcs.ts`

The `ALCHEMY_CHAINS` map (chain name → Alchemy slug) is currently a private `const`. The new Alchemy logs module needs it to build URLs.

**Files:**
- Modify: `worker/src/lib/chain-rpcs.ts:15`

**Step 1: Change `const` to `export const`**

In `worker/src/lib/chain-rpcs.ts`, line 15, change:

```typescript
const ALCHEMY_CHAINS: Record<string, string> = {
```

to:

```typescript
export const ALCHEMY_CHAINS: Record<string, string> = {
```

**Step 2: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors (existing consumers use it via `Object.entries`, export doesn't break anything).

**Step 3: Commit**

```bash
git add worker/src/lib/chain-rpcs.ts
git commit -m "refactor: export ALCHEMY_CHAINS for use by alchemy-logs module"
```

---

### Task 2: Create `alchemy-logs.ts` — types and URL builder

**Files:**
- Create: `worker/src/lib/alchemy-logs.ts`

**Step 1: Write the failing test**

Create `worker/src/lib/__tests__/alchemy-logs.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildAlchemyUrl } from "../alchemy-logs";

describe("buildAlchemyUrl", () => {
  it("builds correct URL for known chains", () => {
    expect(buildAlchemyUrl("ethereum", "test-key")).toBe(
      "https://eth-mainnet.g.alchemy.com/v2/test-key"
    );
    expect(buildAlchemyUrl("base", "test-key")).toBe(
      "https://base-mainnet.g.alchemy.com/v2/test-key"
    );
    expect(buildAlchemyUrl("avalanche", "test-key")).toBe(
      "https://avax-mainnet.g.alchemy.com/v2/test-key"
    );
  });

  it("returns null for unknown chains", () => {
    expect(buildAlchemyUrl("tron", "test-key")).toBeNull();
    expect(buildAlchemyUrl("solana", "test-key")).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- worker/src/lib/__tests__/alchemy-logs.test.ts`
Expected: FAIL — module not found.

**Step 3: Write the module skeleton**

Create `worker/src/lib/alchemy-logs.ts`:

```typescript
import { ALCHEMY_CHAINS } from "./chain-rpcs";
import type { SubrequestBudget } from "./evm-logs";
import { budgetExhausted } from "./evm-logs";

// --- Types ---

export interface AlchemyLogEntry {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;   // hex
  transactionHash: string;
  transactionIndex: string; // hex
  blockHash: string;
  logIndex: string;       // hex
  removed: boolean;
}

interface JsonRpcResponse<T> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

// --- URL builder ---

export function buildAlchemyUrl(chainId: string, apiKey: string): string | null {
  const slug = ALCHEMY_CHAINS[chainId];
  if (!slug) return null;
  return `https://${slug}.g.alchemy.com/v2/${apiKey}`;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- worker/src/lib/__tests__/alchemy-logs.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add worker/src/lib/alchemy-logs.ts worker/src/lib/__tests__/alchemy-logs.test.ts
git commit -m "feat(alchemy-logs): add module skeleton with types and URL builder"
```

---

### Task 3: Implement `getAlchemyBlockNumber`

**Files:**
- Modify: `worker/src/lib/alchemy-logs.ts`
- Modify: `worker/src/lib/__tests__/alchemy-logs.test.ts`

**Step 1: Write the failing test**

Add to `alchemy-logs.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildAlchemyUrl, getAlchemyBlockNumber } from "../alchemy-logs";
import { createBudget } from "../evm-logs";

// At module level, after existing imports:
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

describe("getAlchemyBlockNumber", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("returns block number from JSON-RPC response", async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x176f12d" }),
      { status: 200 },
    ));

    const budget = createBudget(100);
    const result = await getAlchemyBlockNumber("https://eth-mainnet.g.alchemy.com/v2/key", budget);
    expect(result).toBe(0x176f12d);
    expect(budget.count).toBe(1);
  });

  it("returns null on 5xx HTTP error", async () => {
    fetchMock.mockResolvedValueOnce(new Response("error", { status: 500 }));

    const budget = createBudget(100);
    const result = await getAlchemyBlockNumber("https://eth-mainnet.g.alchemy.com/v2/key", budget);
    expect(result).toBeNull();
    expect(budget.count).toBe(1);
  });

  it("parses error message from 400 JSON-RPC response", async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "block range too large" } }),
      { status: 400 },
    ));

    const budget = createBudget(100);
    const result = await getAlchemyBlockNumber("https://eth-mainnet.g.alchemy.com/v2/key", budget);
    expect(result).toBeNull();
  });

  it("returns null when budget exhausted", async () => {
    const budget = createBudget(0);
    const result = await getAlchemyBlockNumber("https://eth-mainnet.g.alchemy.com/v2/key", budget);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- worker/src/lib/__tests__/alchemy-logs.test.ts`
Expected: FAIL — `getAlchemyBlockNumber` is not exported.

**Step 3: Implement**

Add to `worker/src/lib/alchemy-logs.ts`:

```typescript
// --- Helpers ---

async function jsonRpcCall<T>(
  alchemyUrl: string,
  method: string,
  params: unknown[],
  signal?: AbortSignal,
): Promise<T | null> {
  const timeout = AbortSignal.timeout(30_000);
  const res = await fetch(alchemyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  // Alchemy returns JSON-RPC errors with HTTP 400 — parse the body for diagnostics
  // instead of discarding it. 5xx errors unlikely to have useful JSON, so cancel those.
  if (!res.ok && res.status >= 500) {
    console.warn(`[alchemy-logs] ${method} HTTP ${res.status}`);
    await res.body?.cancel();
    return null;
  }
  const json = (await res.json()) as JsonRpcResponse<T>;
  if (json.error) {
    console.warn(`[alchemy-logs] ${method} error (${json.error.code}): ${json.error.message}`);
    return null;
  }
  if (!res.ok) {
    console.warn(`[alchemy-logs] ${method} HTTP ${res.status} with no JSON-RPC error`);
    return null;
  }
  return json.result ?? null;
}

// --- Block number ---

export async function getAlchemyBlockNumber(
  alchemyUrl: string,
  budget: SubrequestBudget,
  signal?: AbortSignal,
): Promise<number | null> {
  if (budgetExhausted(budget)) return null;
  budget.count++;
  try {
    const result = await jsonRpcCall<string>(alchemyUrl, "eth_blockNumber", [], signal);
    if (!result || !result.startsWith("0x")) return null;
    return parseInt(result, 16);
  } catch {
    return null;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- worker/src/lib/__tests__/alchemy-logs.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add worker/src/lib/alchemy-logs.ts worker/src/lib/__tests__/alchemy-logs.test.ts
git commit -m "feat(alchemy-logs): implement getAlchemyBlockNumber"
```

---

### Task 4: Implement `fetchAlchemyLogs`

**Files:**
- Modify: `worker/src/lib/alchemy-logs.ts`
- Modify: `worker/src/lib/__tests__/alchemy-logs.test.ts`

**Step 1: Write the failing test**

Add to `alchemy-logs.test.ts`:

```typescript
import { buildAlchemyUrl, getAlchemyBlockNumber, fetchAlchemyLogs } from "../alchemy-logs";

describe("fetchAlchemyLogs", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("returns parsed log entries on success", async () => {
    const mockLogs = [
      {
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        topics: ["0xddf252ad...", "0x0000..."],
        data: "0x00000000000000000000000000000000000000000000000000000002540be400",
        blockNumber: "0x176f050",
        transactionHash: "0xabc123",
        transactionIndex: "0x0",
        blockHash: "0xdef456",
        logIndex: "0x0",
        removed: false,
      },
    ];
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: mockLogs }),
      { status: 200 },
    ));

    const budget = createBudget(100);
    const result = await fetchAlchemyLogs(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      [{ index: 0, value: "0xddf252ad..." }],
      0x176f000, 0x176f100, budget,
    );
    expect(result).toHaveLength(1);
    expect(result![0].transactionHash).toBe("0xabc123");
    expect(budget.count).toBe(1);
  });

  it("returns empty array when no logs found", async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }),
      { status: 200 },
    ));

    const budget = createBudget(100);
    const result = await fetchAlchemyLogs(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      "0xcontract", [{ index: 0, value: "0xtopic" }],
      100, 200, budget,
    );
    expect(result).toEqual([]);
  });

  it("returns null on JSON-RPC error", async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "bad range" } }),
      { status: 400 },
    ));

    const budget = createBudget(100);
    const result = await fetchAlchemyLogs(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      "0xcontract", [{ index: 0, value: "0xtopic" }],
      100, 200, budget,
    );
    expect(result).toBeNull();
  });

  it("returns null when budget exhausted", async () => {
    const budget = createBudget(0);
    const result = await fetchAlchemyLogs(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      "0xcontract", [{ index: 0, value: "0xtopic" }],
      100, 200, budget,
    );
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- worker/src/lib/__tests__/alchemy-logs.test.ts`
Expected: FAIL — `fetchAlchemyLogs` not exported.

**Step 3: Implement**

Add to `worker/src/lib/alchemy-logs.ts`:

```typescript
import type { TopicFilter } from "./evm-logs";

// --- Log fetching ---

export async function fetchAlchemyLogs(
  alchemyUrl: string,
  contractAddress: string,
  topics: TopicFilter[],
  fromBlock: number,
  toBlock: number,
  budget: SubrequestBudget,
  signal?: AbortSignal,
): Promise<AlchemyLogEntry[] | null> {
  if (budgetExhausted(budget)) return null;
  budget.count++;

  // Build topics array for JSON-RPC: [topic0, topic1_or_null, topic2_or_null, ...]
  // Sparse array: only positions specified in `topics` are set.
  const topicArray: (string | null)[] = [];
  for (const { index, value } of topics) {
    while (topicArray.length <= index) topicArray.push(null);
    topicArray[index] = value;
  }

  const params = [{
    address: contractAddress,
    fromBlock: "0x" + fromBlock.toString(16),
    toBlock: "0x" + toBlock.toString(16),
    topics: topicArray,
  }];

  try {
    const result = await jsonRpcCall<AlchemyLogEntry[]>(alchemyUrl, "eth_getLogs", params, signal);
    if (result === null) return null;
    return Array.isArray(result) ? result : null;
  } catch (e) {
    console.warn(`[alchemy-logs] eth_getLogs failed:`, e);
    return null;
  }
}
```

Note: The `TopicFilter` type is already exported from `evm-logs.ts` (line 114). Add the import at the top of the file alongside the existing `SubrequestBudget` import.

**Step 4: Run test to verify it passes**

Run: `npm test -- worker/src/lib/__tests__/alchemy-logs.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add worker/src/lib/alchemy-logs.ts worker/src/lib/__tests__/alchemy-logs.test.ts
git commit -m "feat(alchemy-logs): implement fetchAlchemyLogs"
```

---

### Task 5: Implement `resolveBlockTimestamps`

**Files:**
- Modify: `worker/src/lib/alchemy-logs.ts`
- Modify: `worker/src/lib/__tests__/alchemy-logs.test.ts`

**Step 1: Write the failing test**

Add to `alchemy-logs.test.ts`:

```typescript
import {
  buildAlchemyUrl, getAlchemyBlockNumber, fetchAlchemyLogs, resolveBlockTimestamps,
} from "../alchemy-logs";

describe("resolveBlockTimestamps", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("batch-fetches timestamps for multiple blocks", async () => {
    // Batch JSON-RPC response: array of results
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify([
        { jsonrpc: "2.0", id: 0, result: { timestamp: "0x6651a2c0" } },
        { jsonrpc: "2.0", id: 1, result: { timestamp: "0x6651a2cc" } },
      ]),
      { status: 200 },
    ));

    const budget = createBudget(100);
    const result = await resolveBlockTimestamps(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      [0x176f050, 0x176f051], budget,
    );
    expect(result.get(0x176f050)).toBe(0x6651a2c0);
    expect(result.get(0x176f051)).toBe(0x6651a2cc);
    expect(budget.count).toBe(1); // single batch request
  });

  it("returns empty map for empty input", async () => {
    const budget = createBudget(100);
    const result = await resolveBlockTimestamps(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      [], budget,
    );
    expect(result.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("splits into batches of 50", async () => {
    // 60 blocks → 2 batch requests (50 + 10)
    const blocks = Array.from({ length: 60 }, (_, i) => 1000 + i);
    const makeBatchResponse = (count: number, startIdx: number) =>
      Array.from({ length: count }, (_, i) => ({
        jsonrpc: "2.0", id: startIdx + i,
        result: { timestamp: "0x" + (1700000000 + startIdx + i).toString(16) },
      }));

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(makeBatchResponse(50, 0)), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(makeBatchResponse(10, 50)), { status: 200 }));

    const budget = createBudget(100);
    const result = await resolveBlockTimestamps(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      blocks, budget,
    );
    expect(result.size).toBe(60);
    expect(budget.count).toBe(2); // two batch HTTP requests
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns partial map when budget exhausted mid-batch", async () => {
    const blocks = Array.from({ length: 60 }, (_, i) => 1000 + i);
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify(Array.from({ length: 50 }, (_, i) => ({
        jsonrpc: "2.0", id: i,
        result: { timestamp: "0x" + (1700000000 + i).toString(16) },
      }))),
      { status: 200 },
    ));

    const budget = createBudget(1); // only enough for 1 batch
    const result = await resolveBlockTimestamps(
      "https://eth-mainnet.g.alchemy.com/v2/key",
      blocks, budget,
    );
    expect(result.size).toBe(50); // first batch only
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- worker/src/lib/__tests__/alchemy-logs.test.ts`
Expected: FAIL — `resolveBlockTimestamps` not exported.

**Step 3: Implement**

Add to `worker/src/lib/alchemy-logs.ts`:

```typescript
const TIMESTAMP_BATCH_SIZE = 50;

export async function resolveBlockTimestamps(
  alchemyUrl: string,
  blockNumbers: number[],
  budget: SubrequestBudget,
  signal?: AbortSignal,
): Promise<Map<number, number>> {
  const timestamps = new Map<number, number>();
  if (blockNumbers.length === 0) return timestamps;

  // Process in batches of TIMESTAMP_BATCH_SIZE
  for (let i = 0; i < blockNumbers.length; i += TIMESTAMP_BATCH_SIZE) {
    if (budgetExhausted(budget)) break;
    budget.count++;

    const batch = blockNumbers.slice(i, i + TIMESTAMP_BATCH_SIZE);
    const payload = batch.map((block, idx) => ({
      jsonrpc: "2.0",
      id: idx,
      method: "eth_getBlockByNumber",
      params: ["0x" + block.toString(16), false],
    }));

    try {
      const timeout = AbortSignal.timeout(30_000);
      const res = await fetch(alchemyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!res.ok) {
        console.warn(`[alchemy-logs] batch eth_getBlockByNumber HTTP ${res.status}`);
        await res.body?.cancel();
        continue;
      }
      const responses = (await res.json()) as JsonRpcResponse<{ timestamp: string }>[];
      for (let j = 0; j < responses.length; j++) {
        const ts = responses[j]?.result?.timestamp;
        if (ts) timestamps.set(batch[j], parseInt(ts, 16));
      }
    } catch (e) {
      console.warn(`[alchemy-logs] batch timestamp fetch failed:`, e);
    }
  }

  return timestamps;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- worker/src/lib/__tests__/alchemy-logs.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add worker/src/lib/alchemy-logs.ts worker/src/lib/__tests__/alchemy-logs.test.ts
git commit -m "feat(alchemy-logs): implement resolveBlockTimestamps with batch JSON-RPC"
```

---

### Task 6: Add per-chain `MAX_SCAN_RANGE` to `sync-mint-burn.ts`

Alchemy PAYG has different block range limits per chain. Replace the flat `MAX_SCAN_RANGE = 50_000` with a per-chain lookup.

**Files:**
- Modify: `worker/src/cron/sync-mint-burn.ts:26-30`

**Step 1: Replace the constant**

In `sync-mint-burn.ts`, replace lines 26–30:

```typescript
// Maximum block range to scan per contract per cron cycle.
// Prevents exponential recursion in fetchEvmLogsForTopics from exhausting the
// shared subrequest budget when scanning dense contracts (e.g. USDC) over large ranges.
// 50K blocks ≈ 7 days of Ethereum blocks. Full backfill of 2.6M blocks takes ~17 hours.
// Note: for fast chains like Arbitrum (0.25s blocks), 50K blocks ≈ 3.5 hours.
const MAX_SCAN_RANGE = 50_000;
```

with:

```typescript
// Maximum block range to scan per contract per cron cycle.
// Respects Alchemy PAYG eth_getLogs block range limits per chain.
// ETH/ARB/BASE/OPT = unlimited on PAYG — we self-cap at 50K for budget control.
// Avalanche ("all other chains") = 10K. Polygon = 2K.
const CHAIN_SCAN_RANGE: Record<number, number> = {
  1:     50_000,  // Ethereum — unlimited on PAYG, self-capped
  42161: 50_000,  // Arbitrum — unlimited on PAYG, self-capped
  8453:  50_000,  // Base — unlimited on PAYG, self-capped
  10:    50_000,  // Optimism — unlimited on PAYG, self-capped
  43114: 10_000,  // Avalanche — 10K Alchemy limit
  137:   2_000,   // Polygon — 2K Alchemy limit
};

function getMaxScanRange(evmChainId: number): number {
  return CHAIN_SCAN_RANGE[evmChainId] ?? 10_000;
}
```

Then update the usage at line 116 — replace:

```typescript
const scanTo = Math.min(fromBlock + MAX_SCAN_RANGE, chainHead);
```

with:

```typescript
const scanTo = Math.min(fromBlock + getMaxScanRange(evmChainId), chainHead);
```

**Step 2: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

**Step 3: Run existing tests**

Run: `npm test -- worker/src/cron/__tests__/sync-mint-burn.test.ts`
Expected: PASS — existing tests mock `fetchEvmLogsForTopics` and don't exercise this code path directly.

**Step 4: Commit**

```bash
git add worker/src/cron/sync-mint-burn.ts
git commit -m "feat(mint-burn): add per-chain MAX_SCAN_RANGE for Alchemy PAYG limits"
```

---

### Task 7: Migrate `syncMintBurn` from Etherscan to Alchemy

This is the core migration step. Change the function signature, replace Etherscan calls with Alchemy calls, add timestamp resolution after log fetching.

**Files:**
- Modify: `worker/src/cron/sync-mint-burn.ts`

**Step 1: Update imports**

Replace the Etherscan imports (lines 1-9) with:

```typescript
import type { AlchemyLogEntry } from "../lib/alchemy-logs";
import {
  buildAlchemyUrl,
  getAlchemyBlockNumber,
  fetchAlchemyLogs,
  resolveBlockTimestamps,
} from "../lib/alchemy-logs";
import {
  createBudget,
  budgetExhausted,
  decodeUint256AtSlot,
  decodeAddress,
} from "../lib/evm-logs";
import type { TopicFilter } from "../lib/evm-logs";
import { MINT_BURN_CONFIGS, type MintBurnContractConfig, type MintBurnEventDef } from "../lib/mint-burn-contracts";
import { batchExecute } from "../lib/db";
```

Note: `createBudget`, `budgetExhausted`, `decodeUint256AtSlot`, `decodeAddress` stay imported from `evm-logs.ts` — they're generic helpers not tied to Etherscan. `TopicFilter` type is also reused.

**Step 2: Update function signature**

Change the `syncMintBurn` signature (line 37-41) from:

```typescript
export async function syncMintBurn(
  db: D1Database,
  etherscanApiKey: string | null,
  etherscanRL: RateLimitedFetch,
  _signal?: AbortSignal,
): Promise<{ itemCount: number; metadata: string }> {
```

to:

```typescript
export async function syncMintBurn(
  db: D1Database,
  alchemyApiKey: string | null,
  _signal?: AbortSignal,
): Promise<{ itemCount: number; metadata: string }> {
```

Remove `RateLimitedFetch` from the imports since it's no longer needed.

**Step 3: Update chain head fetching**

Replace the `getChainHead` function (lines 66-73) and the Ethereum pre-check (lines 76-79):

```typescript
  // 2. Get current block number per chain (lazy cache — fetched on first use per chain ID)
  const chainHeadCache = new Map<number, number>();
  async function getChainHead(config: MintBurnContractConfig): Promise<number | null> {
    const evmChainId = config.chain.evmChainId;
    if (evmChainId === null) return null;
    if (chainHeadCache.has(evmChainId)) return chainHeadCache.get(evmChainId)!;
    const url = buildAlchemyUrl(config.chain.chainId, alchemyApiKey!);
    if (!url) return null;
    const head = await getAlchemyBlockNumber(url, budget);
    if (head !== null) chainHeadCache.set(evmChainId, head);
    return head;
  }

  // Pre-check: fail fast if no API key
  if (!alchemyApiKey) {
    return { itemCount: 0, metadata: JSON.stringify({ error: "No ALCHEMY_API_KEY configured" }) };
  }

  // Pre-fetch Ethereum chain head so an early failure returns a clear error
  const ethConfig = MINT_BURN_CONFIGS.find((c) => c.chain.evmChainId === 1);
  if (ethConfig) {
    const ethHead = await getChainHead(ethConfig);
    if (ethHead === null) {
      return { itemCount: 0, metadata: JSON.stringify({ error: "Failed to get Ethereum chain head" }) };
    }
  }
```

**Step 4: Update the log-fetching loop**

In the main loop (starting around line 97), replace:
- The call to `getChainHead(evmChainId)` → `getChainHead(config)` (now takes config)
- The call to `fetchEvmLogsForTopics(...)` with `fetchAlchemyLogs(...)`
- Add timestamp resolution after fetching logs for a config
- Update `parseMintBurnLogs` to accept `blockTimestamps` parameter

Replace the per-config processing body (the loop over `config.events` plus parsing) with:

```typescript
    // Collect all logs for this config (across all event definitions)
    const allConfigLogs: { eventDef: MintBurnEventDef; logs: AlchemyLogEntry[] }[] = [];

    for (const eventDef of config.events) {
      if (budgetExhausted(budget)) break;

      const topics: TopicFilter[] = [{ index: 0, value: eventDef.topicHash }];
      if (eventDef.filterTopic) {
        topics.push({ index: eventDef.filterTopic.index, value: eventDef.filterTopic.value });
      }

      const url = buildAlchemyUrl(config.chain.chainId, alchemyApiKey!);
      if (!url) { configError = true; continue; }

      const logs = await fetchAlchemyLogs(url, config.contractAddress, topics, fromBlock, scanTo, budget);

      if (logs === null) {
        apiErrors++;
        configError = true;
        continue;
      }

      if (logs.length > 0) allConfigLogs.push({ eventDef, logs });
    }

    // Resolve block timestamps for all logs in a single batch
    const uniqueBlocks = [
      ...new Set(allConfigLogs.flatMap(({ logs }) => logs.map((l) => parseInt(l.blockNumber, 16))))
    ];
    const url = buildAlchemyUrl(config.chain.chainId, alchemyApiKey!);
    const blockTimestamps = url && uniqueBlocks.length > 0
      ? await resolveBlockTimestamps(url, uniqueBlocks, budget)
      : new Map<number, number>();

    // Guard: if any block has no timestamp, treat as config error.
    // Prevents advancing sync state past events that would be silently dropped.
    if (uniqueBlocks.length > 0 && blockTimestamps.size < uniqueBlocks.length) {
      const missing = uniqueBlocks.length - blockTimestamps.size;
      console.warn(
        `[sync-mint-burn] ${config.symbol} on ${config.chain.chainName}: ` +
        `${missing}/${uniqueBlocks.length} blocks missing timestamps — skipping to retry next cycle`
      );
      apiErrors++;
      configError = true;
      contractsProcessed++;
      continue;
    }

    // Parse and insert logs
    for (const { eventDef, logs } of allConfigLogs) {
      const rows = parseMintBurnLogs(config, eventDef, logs, blockTimestamps, prices);
      for (const row of rows) {
        maxBlockSeen = Math.max(maxBlockSeen, row.block_number);
        const hourTs = Math.floor(row.timestamp / 3600) * 3600;
        allNewEvents.push({ stablecoinId: config.stablecoinId, chainId: config.chain.chainId, hourTs });
      }

      if (rows.length > 0) {
        const stmts = rows.map((r) =>
          db.prepare(
            `INSERT OR IGNORE INTO mint_burn_events
             (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd,
              counterparty, tx_hash, block_number, timestamp, explorer_tx_url)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            r.id, r.stablecoin_id, r.symbol, r.chain_id, r.direction,
            r.amount, r.amount_usd, r.counterparty, r.tx_hash, r.block_number,
            r.timestamp, r.explorer_tx_url
          )
        );
        await batchExecute(db, stmts);
        configEvents += rows.length;
      }
    }
```

**Step 5: Update `parseMintBurnLogs`**

Change the function signature and timestamp resolution (around line 251):

```typescript
function parseMintBurnLogs(
  config: MintBurnContractConfig,
  eventDef: MintBurnEventDef,
  logs: AlchemyLogEntry[],
  blockTimestamps: Map<number, number>,
  prices: Map<string, number>,
): MintBurnRow[] {
```

And replace the timestamp parsing line inside the loop:

```typescript
    // Old:
    // const timestamp = parseInt(log.timeStamp, 16);
    // New:
    const blockNum = parseInt(log.blockNumber, 16);
    const logIndex = parseInt(log.logIndex, 16);
    const timestamp = blockTimestamps.get(blockNum) ?? 0;
    if (isNaN(blockNum) || !timestamp) continue;
```

Also remove the now-redundant `const blockNum` and `const logIndex` declarations further down — they're now at the top of the loop body.

**Step 6: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

**Step 7: Commit**

```bash
git add worker/src/cron/sync-mint-burn.ts
git commit -m "feat(mint-burn): migrate from Etherscan to Alchemy JSON-RPC

Replace Etherscan V2 REST getLogs with Alchemy eth_getLogs.
Block timestamps resolved via batch eth_getBlockByNumber.
Removes dependency on shared Etherscan rate limiter."
```

---

### Task 8: Update `index.ts` wiring + separate circuit breaker

Mint/burn now uses Alchemy, blacklist uses Etherscan. They need independent circuit breakers — an Alchemy outage must not block blacklist, and vice versa.

**Files:**
- Modify: `worker/src/lib/constants.ts:98` (add `ALCHEMY` circuit source)
- Modify: `worker/src/index.ts:234-257`

**Step 1: Add `ALCHEMY` circuit breaker source**

In `worker/src/lib/constants.ts`, add to the `CIRCUIT_SOURCE` object (line 98):

```typescript
export const CIRCUIT_SOURCE = {
  DL_STABLECOINS: "defillama-stablecoins",
  DL_COINS: "defillama-coins",
  DL_YIELDS: "defillama-yields",
  DL_PROTOCOLS: "defillama-protocols",
  CG_PRICES: "coingecko-prices",
  CG_MCAP: "coingecko-mcap",
  TREASURY_RATES: "treasury-rates",
  ETHERSCAN: "etherscan",
  ALCHEMY: "alchemy",
} as const;
```

**Step 2: Update the cron case in `index.ts`**

Replace lines 234–257 (the entire `3,23,43` case):

```typescript
      // Blacklist + mint/burn on a 20-min cycle (offset at :03/:23/:43 to avoid colliding with the 15-min trigger)
      // Blacklist uses Etherscan; mint/burn uses Alchemy (independent providers, independent circuit breakers).
      case "3,23,43 * * * *": {
        // Blacklist — gated by Etherscan circuit breaker
        const etherscanAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.ETHERSCAN);
        if (etherscanAllowed) {
          const etherscanRL = createRateLimiter(4);
          const etherscanKey = env.ETHERSCAN_API_KEY ?? null;
          const blacklistJob = logCronRun(db, "sync-blacklist", (signal) =>
            syncBlacklist(db, etherscanKey, env.TRONGRID_API_KEY ?? null, env.DRPC_API_KEY ?? null, etherscanRL, signal)
          );
          ctx.waitUntil(blacklistJob);
          ctx.waitUntil(blacklistJob.then(
            () => recordOutcome(db, CIRCUIT_SOURCE.ETHERSCAN, true),
            () => recordOutcome(db, CIRCUIT_SOURCE.ETHERSCAN, false),
          ));
        } else {
          console.warn("[cron] Etherscan circuit open — skipping blacklist sync");
        }

        // Mint/burn — gated by Alchemy circuit breaker
        const alchemyAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.ALCHEMY);
        if (alchemyAllowed) {
          const mintBurnJob = logCronRun(db, "sync-mint-burn", (signal) =>
            syncMintBurn(db, env.ALCHEMY_API_KEY ?? null, signal)
          );
          ctx.waitUntil(mintBurnJob);
          ctx.waitUntil(mintBurnJob.then(
            () => recordOutcome(db, CIRCUIT_SOURCE.ALCHEMY, true),
            () => recordOutcome(db, CIRCUIT_SOURCE.ALCHEMY, false),
          ));
        } else {
          console.warn("[cron] Alchemy circuit open — skipping mint/burn sync");
        }
        break;
      }
```

Key changes:
- Each job has its own circuit breaker gate (`shouldAttemptFetch`) and outcome recording
- An Alchemy outage no longer blocks blacklist, and vice versa
- The `etherscanRL` rate limiter is now scoped inside the blacklist branch (not shared)
- Removed the old `etherscanAllowed` gate at the top that blocked both jobs

**Step 3: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

**Step 4: Commit**

```bash
git add worker/src/lib/constants.ts worker/src/index.ts
git commit -m "feat(cron): separate circuit breakers for Etherscan (blacklist) and Alchemy (mint/burn)

Alchemy outage no longer blocks blacklist sync, and vice versa."
```

---

### Task 9: Update tests

**Files:**
- Modify: `worker/src/cron/__tests__/sync-mint-burn.test.ts`

**Step 1: Replace mocks**

The test file currently mocks `../../lib/evm-logs` for `getEvmBlockNumber` and `fetchEvmLogsForTopics`. Replace with mocks for the new Alchemy module.

Replace the `vi.mock("../../lib/evm-logs", ...)` block (lines 61-69) with:

```typescript
// Stub alchemy-logs — new Alchemy JSON-RPC functions
vi.mock("../../lib/alchemy-logs", () => ({
  buildAlchemyUrl: vi.fn((_chainId: string, _apiKey: string) =>
    "https://eth-mainnet.g.alchemy.com/v2/test-key"
  ),
  getAlchemyBlockNumber: vi.fn(async () => 22000000),
  fetchAlchemyLogs: vi.fn(async () => []),
  resolveBlockTimestamps: vi.fn(async () => new Map()),
}));

// Keep evm-logs helpers (budget, decode) — they're still imported by sync-mint-burn
vi.mock("../../lib/evm-logs", () => ({
  createBudget: vi.fn((limit = 200) => ({ count: 0, limit })),
  budgetExhausted: vi.fn((b: { count: number; limit: number }) => b.count >= b.limit),
  decodeUint256: vi.fn(() => 50000),
  decodeUint256AtSlot: vi.fn(() => 50000),
  decodeAddress: vi.fn((hex: string) => "0x" + hex.slice(-40)),
}));
```

**Step 2: Update imports**

Replace:

```typescript
import { getEvmBlockNumber, fetchEvmLogsForTopics } from "../../lib/evm-logs";
```

with:

```typescript
import { getAlchemyBlockNumber, fetchAlchemyLogs, resolveBlockTimestamps } from "../../lib/alchemy-logs";
```

**Step 3: Update `makeMintLog` helper**

Remove the `timeStamp` field and ensure the log shape matches `AlchemyLogEntry`:

```typescript
function makeMintLog(opts: { blockNumber?: number; txHash?: string; logIndex?: number } = {}) {
  const block = opts.blockNumber ?? 22000000;
  return {
    address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x000000000000000000000000abcdef1234567890abcdef1234567890abcdef12",
    ],
    data: "0x00000000000000000000000000000000000000000000000000000002540be400",
    blockNumber: "0x" + block.toString(16),
    transactionHash: opts.txHash ?? "0xabc123",
    transactionIndex: "0x0",
    blockHash: "0x0",
    logIndex: "0x" + (opts.logIndex ?? 0).toString(16),
    removed: false,
  };
}
```

**Step 4: Update test cases**

In each test that calls `syncMintBurn`, update the call signature from `syncMintBurn(db, "etherscan-key", etherscanRL)` to `syncMintBurn(db, "alchemy-key")`.

Remove the `etherscanRL` variable at line 125 — it's no longer needed.

Update mock references:
- `vi.mocked(getEvmBlockNumber)` → `vi.mocked(getAlchemyBlockNumber)`
- `vi.mocked(fetchEvmLogsForTopics)` → `vi.mocked(fetchAlchemyLogs)`

In `beforeEach`, update the mock resets:

```typescript
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
    vi.mocked(getAlchemyBlockNumber).mockReset().mockResolvedValue(22000000);
    vi.mocked(fetchAlchemyLogs).mockReset().mockResolvedValue([]);
    vi.mocked(resolveBlockTimestamps).mockReset().mockResolvedValue(new Map());
    vi.mocked(batchExecute).mockReset().mockResolvedValue(undefined);
  });
```

For the test "parses mint events and writes to DB on normal path" — also mock `resolveBlockTimestamps` to return a timestamp for the block:

```typescript
    vi.mocked(resolveBlockTimestamps).mockResolvedValueOnce(
      new Map([[22000000, 1718650752]])
    );
```

For "recalculates affected hourly buckets" — mock timestamps for the blocks used:

```typescript
    vi.mocked(resolveBlockTimestamps).mockResolvedValueOnce(
      new Map([[22000000, 1718650000]])
    );
```

Note: The `makeMintLog` no longer accepts `timestamp` — the timestamps come from `resolveBlockTimestamps` mock.

**Step 5: Run tests**

Run: `npm test -- worker/src/cron/__tests__/sync-mint-burn.test.ts`
Expected: All 4 tests PASS.

**Step 6: Commit**

```bash
git add worker/src/cron/__tests__/sync-mint-burn.test.ts
git commit -m "test(mint-burn): update tests for Alchemy migration"
```

---

### Task 10: Full build + type-check + lint

**Files:** None (verification only)

**Step 1: Worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

**Step 2: Full test suite**

Run: `npm test`
Expected: All tests pass.

**Step 3: Lint**

Run: `npm run lint`
Expected: No errors.

**Step 4: Frontend build (ensures no shared-import breakage)**

Run: `npm run build`
Expected: Successful build.

---

### Task 11: Update documentation

**Files:**
- Modify: `docs/mint-burn-flows.md:1-16, 33-35, 80-84, 330`
- Modify: `docs/worker-and-api-limits.md:144-157` (Alchemy section)
- Modify: `docs/plans/2026-03-02-sync-mint-burn-alchemy-migration.md` (mark complete)

**Step 1: Update `docs/mint-burn-flows.md`**

Line 1-5 — update the opening paragraph to mention multi-chain:

> On-chain mint and burn event tracker for stablecoins. Detects Transfer events (and USDT-specific Issue/Redeem events) across multiple EVM chains via Alchemy JSON-RPC...

Lines 11-15 — update cron section:
- Remove: "Shares slot with: sync-blacklist (both share one Etherscan rate limiter)"
- Update: "Function: `syncMintBurn(db, alchemyApiKey)`"
- Add: "Provider: Alchemy JSON-RPC (PAYG plan)"

Line 33-35 — update constants table:
- Replace `MAX_SCAN_RANGE | 50,000` with `CHAIN_SCAN_RANGE | 50K (ETH/ARB/BASE/OPT), 10K (AVAX), 2K (Polygon)`
- Replace `Subrequest budget | 200 per cron run | Etherscan API call budget` with `Subrequest budget | 200 per cron run | Alchemy API call budget`

Lines 80-84 — update sync flow:
- Step 2: "Get chain head — Alchemy `eth_blockNumber` call per chain (cached per chain ID)"
- Step 4: "call Alchemy `eth_getLogs`" instead of "Etherscan v2 `getLogs`"
- Add step 4b: "Resolve block timestamps — batch `eth_getBlockByNumber` for all unique blocks"

Line 330 — update error handling:
- "Alchemy API error" instead of "Etherscan API error"
- Add: "Incomplete timestamp resolution" → `configError = true`, sync state not advanced, retried next cycle

Add note about circuit breaker separation:
- Blacklist and mint/burn have independent circuit breakers (`CIRCUIT_SOURCE.ETHERSCAN` and `CIRCUIT_SOURCE.ALCHEMY`)
- An Alchemy outage does not block blacklist sync, and vice versa

**Step 2: Update `docs/worker-and-api-limits.md`**

In the Alchemy section (lines 144-157), add a note about mint/burn usage:

After the existing table and note, add:

```markdown
**Mint/burn usage**: `sync-mint-burn` now uses Alchemy for all `eth_getLogs` and `eth_blockNumber` calls.
Steady-state: ~35 getLogs + 4 blockNumbers + ~30 batch timestamp lookups per run → ~3,000 CUs/run.
72 runs/day × 30 days → ~6.5M CUs/month (22% of 30M free-tier CU cap).

**Per-chain `eth_getLogs` block range limits (PAYG):**
| Chain | Limit |
|---|---|
| Ethereum, Arbitrum, Base, Optimism | Unlimited |
| Avalanche | 10,000 blocks |
| Polygon | 2,000 blocks |
```

Also update the Summary table at the bottom — change the Alchemy row from:

> Alchemy free CUs (30M/month) | Tight if on-chain supply cron is frequent | 🟡 Monitor usage

to:

> Alchemy PAYG CUs (30M free + $0.40/M over) | ~6.5M CUs/month for supply + mint/burn combined | 🟢 Plenty of headroom

**Step 3: Mark design doc as implemented**

Add at the top of `docs/plans/2026-03-02-sync-mint-burn-alchemy-migration.md`:

```markdown
> **Status: IMPLEMENTED** — See implementation plan: `2026-03-02-sync-mint-burn-alchemy-migration-plan.md`
```

**Step 4: Commit**

```bash
git add docs/mint-burn-flows.md docs/worker-and-api-limits.md docs/plans/2026-03-02-sync-mint-burn-alchemy-migration.md
git commit -m "docs: update mint-burn and API limits docs for Alchemy migration"
```

---

### Task 12: Deploy and smoke-test

**Step 1: Deploy worker**

Run: `cd worker && npx wrangler deploy`

**Step 2: Wait for next cron run**

The `3,23,43` cron fires every 20 minutes. Wait for the next trigger.

**Step 3: Check logs**

Run: `cd worker && npx wrangler tail --format pretty`

Look for:
- `[sync-mint-burn] USDT on Ethereum: X new events, block NNNN`
- `[sync-mint-burn] reUSD on base: X new events, block NNNN`
- `[sync-mint-burn] reUSD on avalanche: X new events, block NNNN`
- `[sync-mint-burn] Completed with N/200 subrequests`

**Step 4: Verify via API**

Run: `curl -s 'https://api.pharos.watch/api/stablecoin/339' | python3 -m json.tool | head -30`

Check that reUSD (ID 339) shows mint/burn flow data.

**Step 5: Check status page**

Run: `curl -s 'https://api.pharos.watch/api/status' | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('sync-mint-burn'), indent=2))"`

Verify `sync-mint-burn` shows recent success with `itemCount > 0`.
