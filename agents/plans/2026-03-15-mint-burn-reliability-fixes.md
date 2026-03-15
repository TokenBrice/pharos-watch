# Mint/Burn Flow Reliability Fixes — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all issues identified in the [2026-03-15 mint/burn flow audit](../audits/2026-03-15-mint-burn-flow-audit.md) — 3 high, 6 medium, 4 low severity items (L1 and L3 require no code changes).

**Architecture:** Four chunks: (1) test coverage for custom event parsing and bridge classification, (2) roundtrip reliability — rewrite the admin reclassify endpoint and add automated post-cron sweep, (3) frontend/schema hardening, (4) documentation fixes. Chunks 1, 2, and 3 are independent and parallelizable. Chunk 4 (Task 10, Step 7) depends on Chunk 2 being merged first since it documents the roundtrip sweep file created there.

**Tech Stack:** TypeScript, Vitest, Cloudflare Workers (D1), React 19, Recharts, Zod.

**Audit reference:** `agents/audits/2026-03-15-mint-burn-flow-audit.md`

**Tests:** `npm test -- --run` (full suite), or target a specific file with `npx vitest run <path>`.

**Build check:** `npm run build && cd worker && npx tsc --noEmit`

---

## Chunk 1: Test Coverage — Custom Event Parsing & Bridge Classification

Fixes: **H1** (USDT Issue/Redeem + reUSD custom event parsing — zero test coverage) and **M6** (bridge classification address matching — mocked away in pipeline tests).

### Task 1: Add USDT Issue/Redeem event parsing tests

**Files:**
- Create: `worker/src/lib/__tests__/mint-burn-parse.test.ts`
- Read (reference): `worker/src/lib/mint-burn-pipeline/parse.ts` (the function under test)
- Read (reference): `worker/src/lib/mint-burn-contracts.ts:157-176` (USDT config with Issue/Redeem events)
- Read (reference): `worker/src/lib/evm-logs.ts:61-67` (`decodeUint256AtSlot` — the decoder)

**Context:**

USDT has 4 event definitions: 2 standard Transfer mint/burn + custom `Issue(uint256)` and `Redeem(uint256)`. The custom events use `amountEncoding: "first-data-uint256"` which decodes the first 32-byte word of the event data (slot 0) via `decodeUint256AtSlot(data, 0, decimals)`. USDT has 6 decimals.

The `parseMintBurnLogs()` function at `parse.ts:55-120` takes a config, an event definition, raw Alchemy log entries, block timestamps, prices, price history, and a run timestamp. It returns `{ rows, dropped }`.

Existing tests in `mint-burn-pipeline.test.ts` use a `makeRow()` helper and `makeDb()` / `makeAggregationDb()` helpers but never call `parseMintBurnLogs` directly — they test persistence and aggregation. We need to add a new describe block that tests parsing directly.

A mock Alchemy log entry for a `first-data-uint256` event looks like:
```typescript
{
  address: "0xdac17f958d2ee523a2206206994597c13d831ec7",  // USDT contract
  topics: ["0xcb8241ad..."],  // Issue topic — just the event hash, no address topics
  data: "0x" + "00000000000000000000000000000000000000000000000000000002540be400",
  // ↑ 10,000,000,000 in hex = 10,000 USDT (6 decimals)
  blockNumber: "0x14e0001",
  logIndex: "0x5",
  transactionHash: "0xabc123...",
}
```

- [ ] **Step 1: Write failing test — USDT Issue event parsed as mint with correct amount**

Create `worker/src/lib/__tests__/mint-burn-parse.test.ts` with a new `describe("parseMintBurnLogs — custom event encodings")` block. Add this test:

```typescript
import { parseMintBurnLogs } from "../mint-burn-pipeline/parse";
import type { MintBurnContractConfig, MintBurnEventDef } from "../mint-burn-contracts";
import type { AlchemyLogEntry } from "../alchemy-logs";

describe("parseMintBurnLogs — custom event encodings", () => {
  const ETHEREUM_CHAIN = {
    chainId: "ethereum",
    chainName: "Ethereum",
    evmChainId: 1,
    explorerUrl: "https://etherscan.io",
    type: "evm" as const,
  };

  // 10,000 USDT = 10_000_000_000 raw (6 decimals)
  const TEN_THOUSAND_USDT_HEX =
    "0x" + "00000000000000000000000000000000000000000000000000000002540be400";
  const USDT_ADDRESS = "0xdac17f958d2ee523a2206206994597c13d831ec7";

  const usdtIssueEventDef: MintBurnEventDef = {
    signature: "Issue(uint256)",
    topicHash: "0xcb8241adb0c3fdb35b70c24ce35c5eb0c17af7431c99f827d44a445ca624176a",
    direction: "mint" as const,
    amountEncoding: "first-data-uint256" as const,
  };

  const usdtRedeemEventDef: MintBurnEventDef = {
    signature: "Redeem(uint256)",
    topicHash: "0x702d5967f45f6513a38ffc42d6ba9bf230bd40e8f53b16363c7eb4fd2deb9a44",
    direction: "burn" as const,
    amountEncoding: "first-data-uint256" as const,
  };

  const makeUsdtConfig = (): MintBurnContractConfig => ({
    stablecoinId: "usdt-tether",
    symbol: "USDT",
    chain: ETHEREUM_CHAIN,
    contractAddress: USDT_ADDRESS,
    decimals: 6,
    dustThreshold: 10_000,
    startBlock: 21_900_000,
    tier: "critical",
    events: [usdtIssueEventDef, usdtRedeemEventDef],
  });

  const makeLog = (overrides: Partial<AlchemyLogEntry> = {}): AlchemyLogEntry => ({
    address: USDT_ADDRESS,
    topics: [usdtIssueEventDef.topicHash],
    data: TEN_THOUSAND_USDT_HEX,
    blockNumber: "0x14e0001",
    logIndex: "0x5",
    transactionHash: "0xabc1230000000000000000000000000000000000000000000000000000000001",
    blockHash: "0x0",
    transactionIndex: "0x0",
    removed: false,
    ...overrides,
  });

  // 0x14e0001 = 21,889,025
  const blockTimestamps = new Map([[21_889_025, 1700000000]]);
  const prices = new Map([["usdt-tether", 1.0]]);
  const priceHistory = new Map<string, []>();
  const runTimestamp = 1700000100;

  it("parses USDT Issue event as mint with correct amount", () => {
    const config = makeUsdtConfig();
    const { rows, dropped } = parseMintBurnLogs(
      config,
      usdtIssueEventDef,
      [makeLog()],
      blockTimestamps,
      prices,
      priceHistory,
      runTimestamp,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe("mint");
    expect(rows[0].amount).toBe(10_000); // 10,000 USDT
    expect(rows[0].amount_usd).toBe(10_000); // 10,000 * $1.00
    expect(rows[0].symbol).toBe("USDT");
    expect(rows[0].stablecoin_id).toBe("usdt-tether");
    expect(dropped).toBe(0);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run worker/src/lib/__tests__/mint-burn-parse.test.ts -t "parses USDT Issue event"`

Expected: FAIL — `parseMintBurnLogs` not yet imported or module resolution issues on first run.

- [ ] **Step 3: Add USDT Redeem event test**

```typescript
  it("parses USDT Redeem event as burn with correct amount", () => {
    const config = makeUsdtConfig();
    const redeemLog = makeLog({
      topics: [usdtRedeemEventDef.topicHash],
      transactionHash: "0xdef4560000000000000000000000000000000000000000000000000000000002",
    });
    const { rows, dropped } = parseMintBurnLogs(
      config,
      usdtRedeemEventDef,
      [redeemLog],
      blockTimestamps,
      prices,
      priceHistory,
      runTimestamp,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe("burn");
    expect(rows[0].amount).toBe(10_000);
    expect(rows[0].burn_type).toBe("effective_burn");
    expect(dropped).toBe(0);
  });
```

- [ ] **Step 4: Add dust filtering test for Issue events**

```typescript
  it("drops Issue events below dust threshold", () => {
    const config = makeUsdtConfig();
    // 9,999 USDT = below 10,000 dust threshold
    const dustHex = "0x" + BigInt(9_999_000_000).toString(16).padStart(64, "0");
    const dustLog = makeLog({ data: dustHex });
    const { rows, dropped } = parseMintBurnLogs(
      config,
      usdtIssueEventDef,
      [dustLog],
      blockTimestamps,
      prices,
      priceHistory,
      runTimestamp,
    );

    expect(rows).toHaveLength(0);
    expect(dropped).toBe(1);
  });
```

- [ ] **Step 5: Add counterparty=null test for Issue events**

Issue/Redeem events have no address topics (only the event hash), so counterparty should be null.

```typescript
  it("sets counterparty to null for Issue events (no address topics)", () => {
    const config = makeUsdtConfig();
    // Issue events have only 1 topic (the event hash), no address topics
    const log = makeLog({ topics: [usdtIssueEventDef.topicHash] });
    const { rows } = parseMintBurnLogs(
      config,
      usdtIssueEventDef,
      [log],
      blockTimestamps,
      prices,
      priceHistory,
      runTimestamp,
    );

    expect(rows[0].counterparty).toBeNull();
  });
```

- [ ] **Step 6: Run all new tests**

Run: `npx vitest run worker/src/lib/__tests__/mint-burn-parse.test.ts`

Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add worker/src/lib/__tests__/
git commit -m "test(mint-burn): add USDT Issue/Redeem event parsing coverage

Exercises first-data-uint256 amountEncoding, dust filtering, and
counterparty resolution for custom USDT events that don't emit Transfer.
Closes audit H1 (USDT portion)."
```

---

### Task 2: Add reUSD custom event parsing tests

**Files:**
- Modify: `worker/src/lib/__tests__/mint-burn-parse.test.ts`
- Read (reference): `worker/src/lib/mint-burn-contracts.ts:676-702` (reUSD vault configs)

**Context:**

reUSD has two vault contracts:
- **Mint (Deposited):** `amountEncoding: "nth-data-uint256"`, `dataSlot: 2` — the amount is in the 3rd 32-byte word (slot 2, bytes 64-96 of the data). 18 decimals.
- **Burn (InstantRedemptionProcessed):** `amountEncoding: "first-data-uint256"` — slot 0. 18 decimals.

For a `dataSlot: 2` event, the ABI-encoded data has 3 words: `[address(depositor), address(receiver), uint256(amount)]`. We need to construct hex data with the amount in slot 2.

- [ ] **Step 1: Write failing test — reUSD Deposited event parsed with dataSlot=2**

```typescript
  // Inside the same describe("parseMintBurnLogs — custom event encodings") block:

  const REUSD_DEPOSITED_TOPIC = "0x8752a472e571a816aea92eec8dae9baf628e840f4929fbcc2d155e6233ff68a7";
  const REUSD_INSTANT_REDEEM_TOPIC = "0xa58dba63852b106a5b3bbc558fa3fbcfe606497cbc0af66837a83c3560ec6220";

  const reusdDepositEventDef: MintBurnEventDef = {
    signature: "Deposited(address,address,uint256)",
    topicHash: REUSD_DEPOSITED_TOPIC,
    direction: "mint" as const,
    amountEncoding: "nth-data-uint256" as const,
    dataSlot: 2,
  };

  const reusdRedeemEventDef: MintBurnEventDef = {
    signature: "InstantRedemptionProcessed(address,uint256,uint256)",
    topicHash: REUSD_INSTANT_REDEEM_TOPIC,
    direction: "burn" as const,
    amountEncoding: "first-data-uint256" as const,
  };

  // 50,000 reUSD (18 decimals) = 50_000 * 10^18
  // Slot 0: depositor address (32 bytes of address, padded)
  // Slot 1: receiver address (32 bytes of address, padded)
  // Slot 2: amount = 50,000 * 10^18 (this is what we want to decode)
  const DEPOSITOR_SLOT = "0000000000000000000000001111111111111111111111111111111111111111";
  const RECEIVER_SLOT  = "0000000000000000000000002222222222222222222222222222222222222222";
  const AMOUNT_50K_18DEC = BigInt("50000000000000000000000").toString(16).padStart(64, "0");
  const REUSD_DEPOSIT_DATA = "0x" + DEPOSITOR_SLOT + RECEIVER_SLOT + AMOUNT_50K_18DEC;

  const REUSD_VAULT_ADDRESS = "0x4691c475be804fa85f91c2d6d0adf03114de3093";

  const makeReusdConfig = (eventDef: MintBurnEventDef, address: string): MintBurnContractConfig => ({
    stablecoinId: "reusd-re-protocol",
    symbol: "reUSD",
    chain: ETHEREUM_CHAIN,
    contractAddress: address,
    decimals: 18,
    dustThreshold: 10_000,
    startBlock: 21_675_000,
    tier: "extended",
    events: [eventDef],
  });

  it("parses reUSD Deposited event with dataSlot=2 as mint", () => {
    const config = makeReusdConfig(reusdDepositEventDef, REUSD_VAULT_ADDRESS);
    const log: AlchemyLogEntry = {
      address: REUSD_VAULT_ADDRESS,
      topics: [REUSD_DEPOSITED_TOPIC],
      data: REUSD_DEPOSIT_DATA,
      blockNumber: "0x14e0001",
      logIndex: "0x3",
      transactionHash: "0xreusd10000000000000000000000000000000000000000000000000000000001",
      blockHash: "0x0",
      transactionIndex: "0x0",
      removed: false,
    };

    const { rows, dropped } = parseMintBurnLogs(
      config,
      reusdDepositEventDef,
      [log],
      blockTimestamps,
      new Map([["reusd-re-protocol", 1.0]]),
      priceHistory,
      runTimestamp,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe("mint");
    expect(rows[0].amount).toBe(50_000);
    expect(rows[0].amount_usd).toBe(50_000);
    expect(rows[0].stablecoin_id).toBe("reusd-re-protocol");
    expect(dropped).toBe(0);
  });
```

- [ ] **Step 2: Write test — reUSD InstantRedemptionProcessed as burn (slot 0)**

```typescript
  it("parses reUSD InstantRedemptionProcessed as burn from slot 0", () => {
    const REDEEM_VAULT = "0x8aeb9453ef22cb38abc7a3af9c208f65c1bfe31e";
    const config = makeReusdConfig(reusdRedeemEventDef, REDEEM_VAULT);

    // InstantRedemptionProcessed(address indexed user, uint256 sharesBurned, uint256 netPayout)
    // `user` is indexed → goes to topics, not data. Data has 2 slots: [sharesBurned, netPayout].
    // first-data-uint256 reads slot 0 = sharesBurned = 25,000 reUSD
    const SHARES_25K = BigInt("25000000000000000000000").toString(16).padStart(64, "0");
    const PAYOUT_SLOT = "0".repeat(64);
    const redeemData = "0x" + SHARES_25K + PAYOUT_SLOT;

    const log: AlchemyLogEntry = {
      address: REDEEM_VAULT,
      topics: [REUSD_INSTANT_REDEEM_TOPIC],
      data: redeemData,
      blockNumber: "0x14e0001",
      logIndex: "0x7",
      transactionHash: "0xreusd20000000000000000000000000000000000000000000000000000000002",
      blockHash: "0x0",
      transactionIndex: "0x0",
      removed: false,
    };

    const { rows, dropped } = parseMintBurnLogs(
      config,
      reusdRedeemEventDef,
      [log],
      blockTimestamps,
      new Map([["reusd-re-protocol", 1.0]]),
      priceHistory,
      runTimestamp,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe("burn");
    expect(rows[0].amount).toBe(25_000);
    expect(rows[0].burn_type).toBe("effective_burn");
    expect(dropped).toBe(0);
  });
```

- [ ] **Step 3: Write test — dataSlot pointing beyond data returns 0 (dropped as dust)**

```typescript
  it("drops event when dataSlot points beyond available data", () => {
    const config = makeReusdConfig(reusdDepositEventDef, REUSD_VAULT_ADDRESS);
    // Only 2 slots of data (128 hex chars) — slot 2 is missing
    const shortData = "0x" + DEPOSITOR_SLOT + RECEIVER_SLOT;
    const log: AlchemyLogEntry = {
      address: REUSD_VAULT_ADDRESS,
      topics: [REUSD_DEPOSITED_TOPIC],
      data: shortData,
      blockNumber: "0x14e0001",
      logIndex: "0x4",
      transactionHash: "0xreusd30000000000000000000000000000000000000000000000000000000003",
      blockHash: "0x0",
      transactionIndex: "0x0",
      removed: false,
    };

    const { rows, dropped } = parseMintBurnLogs(
      config,
      reusdDepositEventDef,
      [log],
      blockTimestamps,
      new Map([["reusd-re-protocol", 1.0]]),
      priceHistory,
      runTimestamp,
    );

    expect(rows).toHaveLength(0);
    expect(dropped).toBe(1); // decodeUint256AtSlot returns 0 for short data → dust filter
  });
```

- [ ] **Step 4: Run all new tests**

Run: `npx vitest run worker/src/lib/__tests__/mint-burn-parse.test.ts`

Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/__tests__/
git commit -m "test(mint-burn): add reUSD vault event parsing coverage

Exercises nth-data-uint256 with dataSlot=2 for Deposited events and
first-data-uint256 for InstantRedemptionProcessed. Also covers the
short-data edge case where the target slot is beyond available data.
Closes audit H1 (reUSD portion)."
```

---

### Task 3: Add bridge-burn classification integration test

**Files:**
- Read (as-is): `worker/src/lib/__tests__/mint-burn-bridge-classifier.test.ts` (existing parameterized tests)
- Modify: `worker/src/lib/__tests__/mint-burn-pipeline.test.ts`
- Read (reference): `worker/src/lib/mint-burn-pipeline/classification.ts` (the wrapper)
- Read (reference): `worker/src/lib/mint-burn-bridge-classifier.ts` (the actual classifier)

**Context:**

Existing bridge classifier tests at `mint-burn-bridge-classifier.test.ts` already test the pure `classifyBridgeAwareBurnRows()` function with real configs from `MINT_BURN_CONFIGS`, including 5 parameterized coins with CCIP bridge detection. These tests exercise the address-matching and topic-matching logic with real config values.

The audit concern (M6) is that `mint-burn-pipeline.test.ts` mocks the classifier entirely via `vi.mock("../mint-burn-bridge-classifier")`. This means the pipeline integration (loading tx context → passing to classifier → returning counts) is tested, but the actual classification logic is bypassed.

Since the bridge classifier unit tests already cover real address/topic matching, the remaining gap is narrower than the audit suggested: we just need to verify that the pipeline's `classifyBridgeBurnRows()` wrapper correctly passes null tx context (Alchemy failure) and that the classifier handles it gracefully.

- [ ] **Step 1: Add test for null tx context handling in bridge classifier**

Add to `worker/src/lib/__tests__/mint-burn-bridge-classifier.test.ts`:

```typescript
  it("treats null tx context as effective_burn (Alchemy lookup failure)", () => {
    const caseData = COIN_CASES[0]; // first CCIP coin
    if (!caseData) return; // guard

    const row = makeBurnRow({
      counterparty: caseData.detection.knownBridgePoolAddresses[0],
    });
    // null context = Alchemy failed to fetch tx/receipt
    const txContext = new Map<string, null>([[row.tx_hash, null]]);

    classifyBridgeAwareBurnRows([row], caseData.detection, txContext);

    // Without tx context, can't verify bridge signal → review_required
    expect(row.burn_type).toBe("review_required");
    expect(row.burn_review_reason).toBe("tx-context-unavailable");
  });
```

- [ ] **Step 2: Run test to verify behavior**

Run: `npx vitest run worker/src/lib/__tests__/mint-burn-bridge-classifier.test.ts -t "null tx context"`

Expected: Either PASS (if classifier already handles null context with review_required) or FAIL (revealing actual behavior). Adjust expected value based on actual behavior.

**Important:** Read the classifier code at `mint-burn-bridge-classifier.ts` to verify what happens when `txContextByHash.get(txHash)` returns `null`. The test expectation must match actual behavior — we are testing documentation, not changing behavior.

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run worker/src/lib/__tests__/mint-burn-bridge-classifier.test.ts`

Expected: All pass including existing parameterized tests.

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/__tests__/mint-burn-bridge-classifier.test.ts
git commit -m "test(bridge-classifier): add null tx context edge case

Verifies classifier behavior when Alchemy tx/receipt lookup fails (null
context map entry). Closes audit M6."
```

---

## Chunk 2: Roundtrip Reliability — Rewrite Reclassify & Add Post-Cron Sweep

Fixes: **H3** (N+1 query in reclassify endpoint) and **H2** (no automated cross-run roundtrip detection).

### Task 4: Rewrite reclassify-atomic-roundtrips to batch queries

**Files:**
- Modify: `worker/src/api/reclassify-atomic-roundtrips.ts`
- Modify: `worker/src/api/__tests__/reclassify-atomic-roundtrips.test.ts` (if exists; create if not)
- Read (reference): `worker/src/lib/mint-burn-pipeline/persistence.ts` (`recalcAffectedHours`)
- Read (reference): `worker/src/lib/db.ts` (`batchExecute`)

**Context:**

Current implementation at `reclassify-atomic-roundtrips.ts:25-63` has an N+1 pattern:
1. Query: find up to 1000 `(tx_hash, stablecoin_id)` groups with both mint and burn where `flow_type = 'standard'`
2. For EACH group: query events to get chain_id + timestamp (for affected hours), then update flow_type

Fix: Replace the per-group loop with batch operations:
1. Query: same discovery query, but also return `chain_id` and `timestamp` (saves the per-group event lookup)
2. Batch UPDATE all rows in one `batchExecute` call
3. Collect affected hours from the discovery results

- [ ] **Step 1: Write failing test for batched reclassification**

Create or modify test file. If no test file exists, create `worker/src/api/__tests__/reclassify-atomic-roundtrips.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { handleReclassifyAtomicRoundtrips } from "../reclassify-atomic-roundtrips";

// Use the same mockD1 helper pattern as other API tests
import { mockD1 } from "./helpers/mock-d1";

describe("reclassify-atomic-roundtrips", () => {
  it("returns done:true when no roundtrips found", async () => {
    const db = mockD1([
      { match: "GROUP BY tx_hash", rows: [] },
    ]);
    const url = new URL("https://api.pharos.watch/api/reclassify-atomic-roundtrips");
    const res = await handleReclassifyAtomicRoundtrips(db, url, true);
    const body = await res.json();
    expect(body.done).toBe(true);
    expect(body.updated).toBe(0);
  });

  it("batches updates without per-tx queries (no N+1)", async () => {
    const db = mockD1([
      // Discovery query returns rows with chain_id and timestamp
      {
        match: "GROUP BY tx_hash",
        rows: [
          { tx_hash: "0xaaa", stablecoin_id: "usdc-circle", chain_id: "ethereum", min_ts: 1700000000, cnt: 2 },
          { tx_hash: "0xbbb", stablecoin_id: "usdt-tether", chain_id: "ethereum", min_ts: 1700003600, cnt: 3 },
        ],
      },
      // Batch UPDATE — single batched call
      {
        match: "UPDATE mint_burn_events",
        rows: [],
        runMeta: { changes: 5 },
      },
      // Affected hours recalc — DELETE then INSERT
      { match: "DELETE FROM mint_burn_hourly", rows: [] },
      { match: "INSERT OR REPLACE INTO mint_burn_hourly", rows: [] },
    ]);

    const url = new URL("https://api.pharos.watch/api/reclassify-atomic-roundtrips");
    const res = await handleReclassifyAtomicRoundtrips(db, url, true);
    const body = await res.json();

    expect(body.done).toBe(true);
    expect(body.updated).toBeGreaterThan(0);

    // Verify no per-tx SELECT queries happened (the old N+1 pattern)
    const history = db.getHistory();
    const selectQueries = history.filter(
      (q: { sql: string }) => q.sql.includes("SELECT") && q.sql.includes("WHERE tx_hash = ?"),
    );
    expect(selectQueries).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run worker/src/api/__tests__/reclassify-atomic-roundtrips.test.ts`

Expected: FAIL — current implementation still uses per-tx queries.

- [ ] **Step 3: Rewrite the endpoint to batch queries**

Replace the content of `worker/src/api/reclassify-atomic-roundtrips.ts`:

```typescript
import { requireAdmin } from "../lib/auth";
import { withErrorHandler, jsonResponse } from "../lib/api-utils";
import { batchExecute } from "../lib/db";
import { recalcAffectedHours } from "../lib/mint-burn-pipeline/persistence";
import type { MintBurnAffectedHour } from "../lib/mint-burn-pipeline/types";

const BATCH_SIZE = 1000;

/**
 * POST /api/reclassify-atomic-roundtrips (admin)
 * Retroactively classifies existing events where the same tx_hash contains
 * both mints and burns for the same stablecoin. Processes BATCH_SIZE tx groups
 * per call. Returns { done: true } when no more roundtrips remain.
 */
export const handleReclassifyAtomicRoundtrips = withErrorHandler(
  "reclassify-atomic-roundtrips",
  async (
    db: D1Database,
    _url: URL,
    trustedAdmin: boolean | undefined,
    request?: Request,
  ): Promise<Response> => {
    const authErr = await requireAdmin(request, trustedAdmin);
    if (authErr) return authErr;

    // Single discovery query that also returns chain_id + timestamp for affected hours.
    // This replaces the old per-group SELECT loop.
    // chain_id is in GROUP BY for formal correctness (all rows in a tx_hash group share
    // the same chain_id since tx hashes are chain-specific). MIN(timestamp) is safe because
    // events in the same transaction share a block and therefore a timestamp and hour bucket.
    const { results: roundtripTxs } = await db.prepare(
      `SELECT tx_hash, stablecoin_id, chain_id,
              MIN(timestamp) as min_ts,
              COUNT(*) as cnt
       FROM mint_burn_events
       WHERE flow_type = 'standard'
       GROUP BY tx_hash, stablecoin_id, chain_id
       HAVING COUNT(DISTINCT direction) > 1
       LIMIT ?`,
    ).bind(BATCH_SIZE).all<{
      tx_hash: string;
      stablecoin_id: string;
      chain_id: string;
      min_ts: number;
      cnt: number;
    }>();

    if (roundtripTxs.length === 0) {
      return jsonResponse({ done: true, updated: 0 });
    }

    // Collect affected hours from discovery results (no per-tx query needed).
    const affectedHours = new Map<string, MintBurnAffectedHour>();
    for (const row of roundtripTxs) {
      const hourTs = Math.floor(row.min_ts / 3600) * 3600;
      const key = `${row.stablecoin_id}-${row.chain_id}-${hourTs}`;
      affectedHours.set(key, {
        stablecoinId: row.stablecoin_id,
        chainId: row.chain_id,
        hourTs,
      });
    }

    // Batch UPDATE all matched rows in one batchExecute call.
    const updateStmts = roundtripTxs.map((row) =>
      db.prepare(
        `UPDATE mint_burn_events
         SET flow_type = 'atomic_roundtrip'
         WHERE tx_hash = ? AND stablecoin_id = ? AND flow_type = 'standard'`,
      ).bind(row.tx_hash, row.stablecoin_id),
    );
    const updated = await batchExecute(db, updateStmts);

    await recalcAffectedHours(db, affectedHours);

    return jsonResponse({
      done: roundtripTxs.length < BATCH_SIZE,
      updated,
      hoursRecalculated: affectedHours.size,
      batchSize: BATCH_SIZE,
    });
  },
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run worker/src/api/__tests__/reclassify-atomic-roundtrips.test.ts`

Expected: PASS.

- [ ] **Step 5: Run full test suite**

Run: `npm test -- --run`

Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add worker/src/api/reclassify-atomic-roundtrips.ts worker/src/api/__tests__/reclassify-atomic-roundtrips.test.ts
git commit -m "fix(reclassify): replace N+1 query loop with batch operations

Discovery query now returns chain_id+timestamp so per-tx event lookups
are eliminated. Updates use batchExecute instead of sequential run().
Reduces query count from 1+2n to 3 (discovery + batch update + recalc).
Closes audit H3."
```

---

### Task 5: Add automated post-cron roundtrip sweep

**Files:**
- Create: `worker/src/lib/mint-burn-pipeline/roundtrip-sweep.ts`
- Modify: `worker/src/cron/sync-mint-burn.ts` (~3 lines to call the sweep)
- Create: `worker/src/lib/__tests__/mint-burn-roundtrip-sweep.test.ts`

**Context:**

The audit found that roundtrip detection only works within a single cron run's batch (H2). If a mint and burn in the same tx are split across two cron runs, neither detects the roundtrip.

Fix: After the existing price-heal step in `sync-mint-burn.ts:774-787`, add a lightweight sweep that checks recently-inserted events (same 48h window as price heal) for un-caught roundtrips. This is a small, bounded query that runs only on non-error cron completions.

- [ ] **Step 1: Write failing test for roundtrip sweep function**

Create `worker/src/lib/__tests__/mint-burn-roundtrip-sweep.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { sweepRecentRoundtrips } from "../mint-burn-pipeline/roundtrip-sweep";

vi.mock("../db", () => ({
  batchExecute: vi.fn().mockResolvedValue(0),
}));

describe("sweepRecentRoundtrips", () => {
  it("returns 0 when no cross-run roundtrips exist", async () => {
    const db = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: [] }),
        }),
      }),
    } as unknown as D1Database;

    const result = await sweepRecentRoundtrips(db, Math.floor(Date.now() / 1000));
    expect(result.reclassified).toBe(0);
    expect(result.affectedHours.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run worker/src/lib/__tests__/mint-burn-roundtrip-sweep.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the sweep function**

Create `worker/src/lib/mint-burn-pipeline/roundtrip-sweep.ts`:

```typescript
import { batchExecute } from "../db";
import { recalcAffectedHours } from "./persistence";
import type { MintBurnAffectedHour } from "./types";

const SWEEP_LOOKBACK_SEC = 48 * 3600; // same window as price heal
const SWEEP_LIMIT = 200; // keep it lightweight per cron run

export interface RoundtripSweepResult {
  reclassified: number;
  affectedHours: Map<string, MintBurnAffectedHour>;
}

/**
 * Lightweight post-cron sweep for cross-run atomic roundtrips.
 * Finds (tx_hash, stablecoin_id) groups within the recent window where
 * both directions exist but flow_type is still 'standard'. Reclassifies
 * and recalculates affected hourly buckets.
 */
export async function sweepRecentRoundtrips(
  db: D1Database,
  nowSec: number,
): Promise<RoundtripSweepResult> {
  const cutoff = nowSec - SWEEP_LOOKBACK_SEC;

  // chain_id in GROUP BY for formal correctness; MIN(timestamp) is safe because
  // events in the same transaction share a block and therefore a timestamp.
  const { results: candidates } = await db.prepare(
    `SELECT tx_hash, stablecoin_id, chain_id, MIN(timestamp) as min_ts
     FROM mint_burn_events
     WHERE flow_type = 'standard' AND timestamp >= ?
     GROUP BY tx_hash, stablecoin_id, chain_id
     HAVING COUNT(DISTINCT direction) > 1
     LIMIT ?`,
  ).bind(cutoff, SWEEP_LIMIT).all<{
    tx_hash: string;
    stablecoin_id: string;
    chain_id: string;
    min_ts: number;
  }>();

  if (candidates.length === 0) {
    return { reclassified: 0, affectedHours: new Map() };
  }

  if (candidates.length === SWEEP_LIMIT) {
    console.warn(`[roundtrip-sweep] Hit limit (${SWEEP_LIMIT}), backlog may remain`);
  }

  const affectedHours = new Map<string, MintBurnAffectedHour>();
  for (const row of candidates) {
    const hourTs = Math.floor(row.min_ts / 3600) * 3600;
    const key = `${row.stablecoin_id}-${row.chain_id}-${hourTs}`;
    affectedHours.set(key, {
      stablecoinId: row.stablecoin_id,
      chainId: row.chain_id,
      hourTs,
    });
  }

  const updateStmts = candidates.map((row) =>
    db.prepare(
      `UPDATE mint_burn_events
       SET flow_type = 'atomic_roundtrip'
       WHERE tx_hash = ? AND stablecoin_id = ? AND flow_type = 'standard'`,
    ).bind(row.tx_hash, row.stablecoin_id),
  );
  const reclassified = await batchExecute(db, updateStmts);

  if (affectedHours.size > 0) {
    await recalcAffectedHours(db, affectedHours);
  }

  return { reclassified, affectedHours };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run worker/src/lib/__tests__/mint-burn-roundtrip-sweep.test.ts`

Expected: PASS.

- [ ] **Step 5: Add test for actual reclassification**

Add to the same test file:

```typescript
  it("reclassifies cross-run roundtrips and returns affected hours", async () => {
    const mockAll = vi.fn().mockResolvedValue({
      results: [
        { tx_hash: "0xaaa", stablecoin_id: "usdc-circle", chain_id: "ethereum", min_ts: 1700000000 },
      ],
    });
    const mockBind = vi.fn().mockReturnValue({
      all: mockAll,
      run: vi.fn().mockResolvedValue({ meta: { changes: 2 } }),
    });
    const db = {
      prepare: vi.fn().mockReturnValue({ bind: mockBind }),
    } as unknown as D1Database;

    // Mock batchExecute to return the number of changes
    const { batchExecute } = await import("../db");
    vi.mocked(batchExecute).mockResolvedValue(2);

    const result = await sweepRecentRoundtrips(db, 1700001000);
    expect(result.reclassified).toBe(2);
    expect(result.affectedHours.size).toBe(1);
  });
```

- [ ] **Step 6: Run test**

Run: `npx vitest run worker/src/lib/__tests__/mint-burn-roundtrip-sweep.test.ts`

Expected: PASS.

- [ ] **Step 7: Wire sweep into cron — modify sync-mint-burn.ts**

In `worker/src/cron/sync-mint-burn.ts`, after the price-heal block (around line 787), add the roundtrip sweep:

```typescript
  // Add import at top of file:
  import { sweepRecentRoundtrips } from "../lib/mint-burn-pipeline/roundtrip-sweep";

  // After the price-heal block (after line 787), add:
  let roundtripSweepCount = 0;
  if (status !== "error") {
    try {
      const sweepResult = await sweepRecentRoundtrips(db, Math.floor(Date.now() / 1000));
      roundtripSweepCount = sweepResult.reclassified;
      if (roundtripSweepCount > 0) {
        console.log(`[sync-mint-burn] Roundtrip sweep reclassified ${roundtripSweepCount} rows`);
      }
    } catch (error) {
      console.warn("[sync-mint-burn] Roundtrip sweep failed (non-fatal):", error);
    }
  }
```

Also add `roundtripSweepCount` to the metadata object (around line 789+):

```typescript
  // In the metadata JSON.stringify block, add:
  roundtripSweepCount,
```

- [ ] **Step 8: Run full test suite**

Run: `npm test -- --run`

Expected: All pass. The existing sync-mint-burn tests mock the module imports, so the new import won't affect them.

- [ ] **Step 9: Commit**

```bash
git add worker/src/lib/mint-burn-pipeline/roundtrip-sweep.ts worker/src/lib/__tests__/mint-burn-roundtrip-sweep.test.ts worker/src/cron/sync-mint-burn.ts
git commit -m "feat(mint-burn): add automated post-cron roundtrip sweep

Lightweight 48h-window sweep runs after price heal on non-error cron
completions. Catches (tx_hash, stablecoin_id) groups split across
two cron runs where in-batch detection missed the roundtrip.
Closes audit H2."
```

---

## Chunk 3: Schema & Frontend Hardening

Fixes: **L2** (Zod schema non-finite numbers), **L4** (event feed zero-amount display), **L5** (gauge knob accessibility), **M3** (chart gap-fill ambiguity).

### Task 6: Harden Zod schemas with .finite()

**Files:**
- Modify: `shared/types/mint-burn.ts`

**Context:**

Several numeric fields in the mint-burn Zod schemas accept `Infinity` and `NaN` because they use bare `z.number()`. The most important ones to harden are the gauge fields (`trackedMcapUsd`, `flightIntensity`) and per-coin flow volumes (`netFlow24hUsd`, etc.) since these feed into weighted-average calculations.

- [ ] **Step 1: Add .finite() to gauge schema fields**

In `shared/types/mint-burn.ts`, modify the `MintBurnGaugeSchema` (lines 8-17):

```typescript
const MintBurnGaugeSchema = z.object({
  score: SignedFlowIntensitySchema.nullable(),
  band: z.string().nullable(),
  intensitySemantics: z.enum(["midpoint-v1", "signed-v2"]).optional(),
  flightToQuality: z.boolean(),
  flightIntensity: z.number().finite(),
  classificationSource: z.enum(["report-card-cache", "unavailable"]).optional(),
  trackedCoins: z.number().int().nonnegative(),
  trackedMcapUsd: z.number().finite().nonnegative(),
});
```

- [ ] **Step 2: Add .finite() to per-coin flow volume fields**

Modify the `MintBurnCoinFlowSchema` (lines 57-86). Add `.finite()` to the volume and net flow fields:

```typescript
  netFlow24hUsd: z.number().finite(),
  mintVolume24hUsd: z.number().finite().nonnegative(),
  burnVolume24hUsd: z.number().finite().nonnegative(),
  mintCount24h: z.number().int().nonnegative(),
  burnCount24h: z.number().int().nonnegative(),
  netFlow7dUsd: z.number().finite(),
  netFlow30dUsd: z.number().finite(),
  netFlow90dUsd: z.number().finite(),
```

- [ ] **Step 2b: Add .finite() to parallel schemas for consistency**

Apply the same pattern to `MintBurnPerCoinChainSchema` (lines 107-114):

```typescript
const MintBurnPerCoinChainSchema = z.object({
  chainId: z.string(),
  mintVolumeUsd: z.number().finite().nonnegative(),
  burnVolumeUsd: z.number().finite().nonnegative(),
  mintCount: z.number().int().nonnegative(),
  burnCount: z.number().int().nonnegative(),
  netFlowUsd: z.number().finite(),
});
```

And to `MintBurnHourlyBucketSchema` (lines 88-93):

```typescript
const MintBurnHourlyBucketSchema = z.object({
  hourTs: z.number().int().nonnegative(),
  netFlowUsd: z.number().finite(),
  mintVolumeUsd: z.number().finite().nonnegative(),
  burnVolumeUsd: z.number().finite().nonnegative(),
});
```

- [ ] **Step 3: Run full test suite**

Run: `npm test -- --run`

Expected: All pass. If any existing test data uses `Infinity` or non-integer counts, fix the test data.

- [ ] **Step 4: Type-check**

Run: `npm run build && cd worker && npx tsc --noEmit`

Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add shared/types/mint-burn.ts
git commit -m "fix(types): add finite/nonneg constraints to mint-burn Zod schemas

Prevents Infinity/NaN from passing validation for gauge mcap, flight
intensity, coin flow volumes, and event counts. Closes audit L2."
```

---

### Task 7: Fix flow event feed display for unpriced zero-amount events

**Files:**
- Modify: `src/components/flow-event-feed.tsx:200-210`

**Context:**

When `amountUsd` is null AND `amount` is 0 or very small, the display shows "0 SYMBOL" with an "Unpriced" badge, which is confusing. The dust filter should prevent this in production, but defensive display handling is worthwhile.

- [ ] **Step 1: Add zero-amount guard**

In `src/components/flow-event-feed.tsx`, modify the amount display cell (around line 200-210):

```tsx
<TableCell className="text-right font-mono tabular-nums text-sm">
  {evt.amountUsd != null ? (
    formatCurrency(evt.amountUsd)
  ) : evt.amount > 0 ? (
    <div className="flex flex-col items-end gap-1">
      <span>{formatTokenAmount(evt.amount)} {evt.symbol}</span>
      <Badge variant="outline" className="text-[10px]">
        Unpriced
      </Badge>
    </div>
  ) : (
    <span className="text-muted-foreground">—</span>
  )}
</TableCell>
```

- [ ] **Step 2: Build to verify no errors**

Run: `npm run build`

Expected: Clean build.

- [ ] **Step 3: Commit**

```bash
git add src/components/flow-event-feed.tsx
git commit -m "fix(flows): show dash instead of '0 SYMBOL Unpriced' for zero-amount events

Closes audit L4."
```

---

### Task 8: Add accessibility labels to gauge knobs

**Files:**
- Modify: `src/components/flow-brrr-overview.tsx:324-327`
- Modify: `src/components/minting-pressure-gauge.tsx:122-126`

- [ ] **Step 1: Add aria-label to Bank Run Gauge knob**

In `src/components/flow-brrr-overview.tsx`, find the knob div (around line 324-327) and add an aria-label:

```tsx
<div
  className="absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full border-2 border-background bg-foreground shadow-[0_0_0_3px_rgba(15,23,42,0.45)] transition-all"
  style={{ left: `calc(${snapshot.leverPct}% - 10px)` }}
  role="img"
  aria-label={`Bank Run Gauge at ${Math.round(snapshot.leverPct)}%`}
/>
```

- [ ] **Step 2: Add aria-label to Minting Pressure Gauge knob**

In `src/components/minting-pressure-gauge.tsx`, find the knob div (around line 123-126) and add an aria-label:

```tsx
<div
  className="absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full border-2 border-background bg-foreground shadow-[0_0_0_3px_rgba(15,23,42,0.45)] transition-all"
  style={{ left: `calc(${knobPct}% - 10px)` }}
  role="img"
  aria-label={`Minting pressure at ${Math.round(knobPct)}%`}
/>
```

- [ ] **Step 3: Build to verify**

Run: `npm run build`

Expected: Clean build.

- [ ] **Step 4: Commit**

```bash
git add src/components/flow-brrr-overview.tsx src/components/minting-pressure-gauge.tsx
git commit -m "fix(a11y): add aria-labels to gauge knob indicators

Closes audit L5."
```

---

### Task 9: Mark interpolated zero-fill hours in flow chart

**Files:**
- Modify: `src/components/flow-chart.tsx`

**Context:**

The chart fills hourly gaps with zeros (`flow-chart.tsx:42-51`). This creates ambiguity between "genuinely zero activity" and "no data recorded." A lightweight fix is to track which data points are real vs interpolated, and render the interpolated regions with reduced opacity.

The simplest approach: add an `isInterpolated` flag to the `ChartDatum` interface and use it to set opacity on the area fills.

- [ ] **Step 1: Add isInterpolated flag to chart data**

In `src/components/flow-chart.tsx`, modify the `ChartDatum` interface and the gap-fill loop:

```typescript
interface ChartDatum {
  ts: number;
  mint: number;
  burn: number;
  net: number;
  isInterpolated: boolean; // true for gap-filled zeros, false for real data
}
```

Modify the fill loop (around lines 42-51):

```typescript
const filled: ChartDatum[] = [];
for (let hourTs = startHour; hourTs <= endHour; hourTs += HOUR_SECONDS) {
  const bucket = byHour.get(hourTs);
  filled.push({
    ts: hourTs * 1000,
    mint: bucket?.mintVolumeUsd ?? 0,
    burn: -(bucket?.burnVolumeUsd ?? 0),
    net: bucket?.netFlowUsd ?? 0,
    isInterpolated: !bucket,
  });
}
```

- [ ] **Step 2: Use opacity in Recharts Area components**

In the Recharts rendering (find the `<Area>` components for mint and burn), Recharts doesn't natively support per-point opacity on Area fills. Instead, use a `dot={false}` approach and add a visual indicator via the reference area pattern.

**Simpler approach:** Instead of per-point opacity (which Recharts doesn't support well), add a subtitle note below the chart when interpolated points exist:

```typescript
// After the chart, before the closing div:
const hasInterpolated = chartData.some((d) => d.isInterpolated);

// In the JSX, below the ResponsiveContainer:
{hasInterpolated && (
  <p className="mt-1 text-[11px] text-muted-foreground/60">
    Gaps in hourly data are filled with zero values.
  </p>
)}
```

- [ ] **Step 3: Build to verify**

Run: `npm run build`

Expected: Clean build.

- [ ] **Step 4: Commit**

```bash
git add src/components/flow-chart.tsx
git commit -m "fix(flows): add note when chart contains interpolated zero-fill hours

Helps users distinguish 'no data recorded' from 'zero activity.'
Closes audit M3."
```

---

## Chunk 4: Documentation Fixes

Fixes: **M1** (price_timestamp provenance comment), **M2** (FTQ fallback comment), **M4** (partial coverage docs), **M5** (3 doc inconsistencies).

### Task 10: Fix all documentation drift

**Files:**
- Modify: `docs/mint-burn-flows.md`
- Modify: `worker/src/api/mint-burn-flows.ts:109` (misleading comment)

- [ ] **Step 1: Fix misleading FTQ fallback comment (M2 + M5.1)**

In `worker/src/api/mint-burn-flows.ts`, line 109, change:

```typescript
// Load grade-based classification (falls back to hardcoded SAFE_HAVEN_IDS if unavailable)
```

to:

```typescript
// Load grade-based classification (FTQ disabled when cache unavailable; see classificationWarning)
```

- [ ] **Step 2: Fix docs/mint-burn-flows.md — FTQ fallback description (M5.1)**

In `docs/mint-burn-flows.md`, line 163, find the text about falling back to hardcoded safe-haven list and replace with:

```markdown
Flight-to-quality classification is now **report-card-cache driven only**. Coins with report-card score `>= 65` are treated as `safe`, scores `< 50` are treated as `risky`, and the middle band is ignored for FTQ. When `report_card_cache` is missing, stale, or malformed, FTQ classification is marked unavailable in the response (`gauge.classificationSource = "unavailable"`, `sync.classificationWarning != null`) instead of silently falling back to a hardcoded safe-haven list. No hardcoded fallback is implemented — FTQ requires fresh report-card data.
```

- [ ] **Step 3: Fix pressure shift boundary docs (M5.2)**

In `docs/mint-burn-flows.md`, around lines 274-278, clarify the boundary values:

```markdown
2. **Pressure Shift vs 30D** — how unusual current pressure is versus the coin's own baseline
   - `improving`: score `> 10` (strictly greater; score of exactly 10 is stable)
   - `stable`: score between `-10` and `+10` (inclusive on both boundaries)
   - `worsening`: score `< -10` (strictly less; score of exactly -10 is stable)
   - `nr`: insufficient history or no current activity
```

- [ ] **Step 4: Verify config count (M5.3)**

Run this to get the actual config count:

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard && npx vitest run --reporter=verbose 2>&1 | grep -c "mint-burn" || node -e "
const { MINT_BURN_CONFIGS } = require('./worker/src/lib/mint-burn-contracts');
const ids = new Set(MINT_BURN_CONFIGS.map(c => c.stablecoinId));
console.log('Configs:', MINT_BURN_CONFIGS.length, 'IDs:', ids.size);
"
```

Update the count at `docs/mint-burn-flows.md:76` if it has drifted.

- [ ] **Step 5: Add price_timestamp provenance note (M1)**

In `docs/mint-burn-flows.md`, in the Database Schema section under `mint_burn_events` (around line 330), add a comment after the existing column descriptions. Find the line for `amount_usd` and add after it:

```markdown
  price_used REAL,                   -- Price at resolution time
  price_timestamp INTEGER,           -- When the price was sourced (cache update time), NOT the event's block timestamp
  price_source TEXT,                 -- "supply-history-daily", "price-cache-current", or "price_cache_heal"
```

- [ ] **Step 6: Add partial coverage note (M4)**

In `docs/mint-burn-flows.md`, in the "Error Handling & Edge Cases" table (around line 539), add a new row:

```markdown
| Partial-coverage cron run | Hourly aggregation rebuilds from all DB events for affected hours; buckets may be temporarily incomplete for configs still catching up |
```

- [ ] **Step 7: Update docs for roundtrip sweep**

In `docs/mint-burn-flows.md`, in the Sync Algorithm section (around line 209-212), after the price heal step, add:

```markdown
10. **Sweep cross-run roundtrips** — on non-error runs, query up to 200 `(tx_hash, stablecoin_id)` groups within the last 48 hours where both mint and burn directions exist but `flow_type = 'standard'`. Reclassify to `atomic_roundtrip` and re-aggregate affected hourly buckets. This catches roundtrips where the mint and burn were ingested in separate cron runs.
```

Also update the File Index table to include the new file:

```markdown
| `worker/src/lib/mint-burn-pipeline/roundtrip-sweep.ts` | Post-cron sweep for cross-run atomic roundtrip detection |
```

- [ ] **Step 8: Commit**

```bash
git add docs/mint-burn-flows.md worker/src/api/mint-burn-flows.ts
git commit -m "docs(mint-burn): fix 5 documentation inconsistencies from audit

- Fix misleading FTQ fallback comment in code and docs (M2, M5.1)
- Clarify pressure shift boundary semantics at +/-10 (M5.2)
- Verify and update config count (M5.3)
- Add price_timestamp provenance note (M1)
- Document partial-coverage aggregation behavior (M4)
- Document new roundtrip sweep step"
```

---

## Final Verification

After all chunks are merged:

- [ ] **Run full test suite:** `npm test -- --run`
- [ ] **Run build + type-check:** `npm run build && cd worker && npx tsc --noEmit`
- [ ] **Run lint:** `npm run lint`

Expected: All green. No regressions.

---

## Issue Coverage Checklist

| Issue | Task | Status |
|-------|------|--------|
| H1: USDT Issue/Redeem test coverage | Task 1 | |
| H1: reUSD custom event test coverage | Task 2 | |
| H2: Cross-run roundtrip detection | Task 5 | |
| H3: N+1 reclassify query | Task 4 | |
| M1: Price heal provenance docs | Task 10 | |
| M2: FTQ fallback comment | Task 10 | |
| M3: Chart gap-fill ambiguity | Task 9 | |
| M4: Partial coverage docs | Task 10 | |
| M5: Documentation drift (3 items) | Task 10 | |
| M6: Bridge classification test | Task 3 | |
| L1: Net flow sorting | N/A — intentional design, no change | |
| L2: Zod schema finite constraints | Task 6 | |
| L3: Zero-activity coins | N/A — operational check, no code change | |
| L4: Event feed zero-amount display | Task 7 | |
| L5: Gauge knob accessibility | Task 8 | |
