import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { compareBlacklistEvents } from "@shared/lib/blacklist-event-order";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

vi.mock("../../../lib/blacklist/tron-replay-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/blacklist/tron-replay-provider")>()),
  fetchTronBlockTransactionPositions: vi.fn(),
}));

import { resolveTronBlacklistOrder } from "../../../lib/blacklist/tron-order-recovery";
import {
  TronReplayProviderError,
  fetchTronBlockTransactionPositions,
  type TronReplayProviderContext,
} from "../../../lib/blacklist/tron-replay-provider";
import type { BlacklistRunBudget } from "../../../lib/blacklist/run-budget";
import { createBudget, createRateLimiter } from "../../../lib/evm-logs";

const fixtures = createLatestSchemaFixtureTracker();

const TX_A = "aa".repeat(32);
const TX_B = "bb".repeat(32);
const ADDRESS = "0x6f566c6d608550fb50c9365bdb6665e1c8e53caa";
const TRON_USDT_CONFIG_ID = "tron-tr7nhqjekqxgtci8q8zy4pl8otszgjlj6t";
const BASE_TIMESTAMP = 1_790_000_000;
const RETRY_KEY_PREFIX = "blacklist:order-retry:";

interface SeedEvent {
  id: string;
  block: number;
  tx: string;
  eventType: string;
  timestamp: number;
  transactionIndex?: number | null;
  chainId?: string;
  suppressionReason?: string | null;
}

function seedEvent(sqlite: DatabaseSync, event: SeedEvent): void {
  sqlite.prepare(
    `INSERT INTO blacklist_events (id, stablecoin, chain_id, chain_name, event_type, address, tx_hash,
       block_number, timestamp, explorer_tx_url, explorer_address_url, config_key, suppression_reason,
       transaction_index)
     VALUES (?, 'USDT', ?, 'Tron', ?, ?, ?, ?, ?, 'https://tronscan.org/#/tx/x',
       'https://tronscan.org/#/address/x', ?, ?, ?)`,
  ).run(
    event.id,
    event.chainId ?? "tron",
    event.eventType,
    ADDRESS,
    event.tx,
    event.block,
    event.timestamp,
    TRON_USDT_CONFIG_ID,
    event.suppressionReason ?? null,
    event.transactionIndex ?? null,
  );
}

interface ConflictSeed {
  block: number;
  timestamp?: number;
  chainId?: string;
  suppressionReason?: string | null;
  blacklistIndex?: number | null;
  otherIndex?: number | null;
  otherEventType?: string;
}

function seedConflictBlock(sqlite: DatabaseSync, seed: ConflictSeed): void {
  const timestamp = seed.timestamp ?? BASE_TIMESTAMP + seed.block;
  seedEvent(sqlite, {
    id: `tron-${TX_A}-${seed.block}-0`,
    block: seed.block,
    tx: TX_A,
    eventType: "blacklist",
    timestamp,
    transactionIndex: seed.blacklistIndex ?? null,
    chainId: seed.chainId,
    suppressionReason: seed.suppressionReason,
  });
  seedEvent(sqlite, {
    id: `tron-${TX_B}-${seed.block}-0`,
    block: seed.block,
    tx: TX_B,
    eventType: seed.otherEventType ?? "destroy",
    timestamp,
    transactionIndex: seed.otherIndex ?? null,
    chainId: seed.chainId,
    suppressionReason: seed.suppressionReason,
  });
}

/** Deterministic fixture tracker: serves canned confirmed blocks and records
 * exactly which block numbers the lane asked the provider for. */
function stubConfirmedBlocks(blocks: ReadonlyMap<number, { timestamp: number; transactions: readonly string[] }>, calls: number[]): void {
  vi.mocked(fetchTronBlockTransactionPositions).mockImplementation(async (_ctx, blockNumber) => {
    calls.push(blockNumber);
    const block = blocks.get(blockNumber);
    if (!block) throw new TronReplayProviderError("provider_http_error", `block ${blockNumber} unreadable`);
    return {
      timestamp: block.timestamp,
      positions: new Map(block.transactions.map((tx, index) => [tx.toLowerCase(), index])),
    };
  });
}

function providerContext(): TronReplayProviderContext {
  return {
    apiKey: null,
    limiter: createRateLimiter(1000),
    budget: createBudget(1000),
    pagesFetched: { count: 0 },
  };
}

function makeRunBudget(overrides: { subrequestLimit?: number; deadlineMs?: number } = {}): BlacklistRunBudget {
  return {
    subrequestBudget: createBudget(overrides.subrequestLimit ?? 1000),
    deadlineMs: overrides.deadlineMs ?? Date.now() + 60_000,
    minimumConfigWindowMs: 0,
  };
}

function transactionIndexOf(sqlite: DatabaseSync, id: string): number | null {
  const row = sqlite.prepare("SELECT transaction_index AS idx FROM blacklist_events WHERE id = ?").get(id) as
    | { idx: number | null }
    | undefined;
  if (!row) throw new Error(`missing seeded row ${id}`);
  return row.idx;
}

function orderRetryState(sqlite: DatabaseSync, block: number): { attempts: number; dueAt: number } | null {
  const row = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(`${RETRY_KEY_PREFIX}${block}`) as
    | { value: string }
    | undefined;
  return row ? (JSON.parse(row.value) as { attempts: number; dueAt: number }) : null;
}

function orderRetryKeys(sqlite: DatabaseSync): string[] {
  return (sqlite
    .prepare("SELECT key FROM cache WHERE key LIKE ? ORDER BY key")
    .all(`${RETRY_KEY_PREFIX}%`) as Array<{ key: string }>).map((row) => row.key);
}

beforeEach(() => {
  vi.mocked(fetchTronBlockTransactionPositions).mockReset();
});

afterEach(() => {
  fixtures.closeAll();
});

describe("resolveTronBlacklistOrder candidate selection", () => {
  it("attempts only conflicting, unsuppressed Tron groups with unresolved positions", async () => {
    const { sqlite, db } = fixtures.open();
    seedConflictBlock(sqlite, { block: 100 });
    // Same event type across transactions is not a conflicting group.
    seedEvent(sqlite, { id: `tron-${TX_A}-200-0`, block: 200, tx: TX_A, eventType: "blacklist", timestamp: BASE_TIMESTAMP + 200 });
    seedEvent(sqlite, { id: `tron-${TX_B}-200-1`, block: 200, tx: TX_B, eventType: "blacklist", timestamp: BASE_TIMESTAMP + 200 });
    // Fully positioned blocks carry no ambiguity left to repair.
    seedConflictBlock(sqlite, { block: 300, blacklistIndex: 1, otherIndex: 0 });
    // Suppressed rows are outside the public fold this lane repairs for.
    seedConflictBlock(sqlite, { block: 400, suppressionReason: "operator-review" });
    // EVM blocks already have block-global log order in their event ids.
    seedConflictBlock(sqlite, { block: 500, chainId: "ethereum" });
    // Without a blacklist event there is no freeze conflict to order.
    seedEvent(sqlite, { id: `tron-${TX_A}-600-0`, block: 600, tx: TX_A, eventType: "destroy", timestamp: BASE_TIMESTAMP + 600 });
    seedEvent(sqlite, { id: `tron-${TX_B}-600-1`, block: 600, tx: TX_B, eventType: "unblacklist", timestamp: BASE_TIMESTAMP + 600 });
    // A lone destroy row never becomes a candidate either.
    seedEvent(sqlite, { id: `tron-${TX_B}-700-0`, block: 700, tx: TX_B, eventType: "destroy", timestamp: BASE_TIMESTAMP + 700 });

    const calls: number[] = [];
    stubConfirmedBlocks(new Map([[100, { timestamp: BASE_TIMESTAMP + 100, transactions: [TX_B, TX_A] }]]), calls);

    const result = await resolveTronBlacklistOrder(db, providerContext(), makeRunBudget());

    expect(calls).toEqual([100]);
    expect(result).toEqual({ blocksAttempted: 1, positionsResolved: 2, blocksDeferred: 0 });
    expect(transactionIndexOf(sqlite, `tron-${TX_A}-100-0`)).toBe(1);
    expect(transactionIndexOf(sqlite, `tron-${TX_B}-100-0`)).toBe(0);
    // No row outside the one qualifying block was written.
    const untouched = sqlite
      .prepare("SELECT id FROM blacklist_events WHERE block_number NOT IN (100, 300) AND transaction_index IS NOT NULL")
      .all() as unknown[];
    expect(untouched).toEqual([]);
    expect(orderRetryKeys(sqlite)).toEqual([]);
  });

  it("skips stored rows whose timestamp disagrees with the confirmed block and parks the block", async () => {
    const { sqlite, db } = fixtures.open();
    const confirmedTimestamp = BASE_TIMESTAMP + 200;
    // tx_a carries a wrong stored timestamp; tx_b matches the confirmed block.
    seedEvent(sqlite, { id: `tron-${TX_A}-200-0`, block: 200, tx: TX_A, eventType: "blacklist", timestamp: confirmedTimestamp - 7 });
    seedEvent(sqlite, { id: `tron-${TX_B}-200-0`, block: 200, tx: TX_B, eventType: "destroy", timestamp: confirmedTimestamp });

    const calls: number[] = [];
    stubConfirmedBlocks(new Map([[200, { timestamp: confirmedTimestamp, transactions: [TX_B, TX_A] }]]), calls);

    const result = await resolveTronBlacklistOrder(db, providerContext(), makeRunBudget());

    expect(result).toEqual({ blocksAttempted: 1, positionsResolved: 1, blocksDeferred: 0 });
    expect(transactionIndexOf(sqlite, `tron-${TX_B}-200-0`)).toBe(0);
    expect(transactionIndexOf(sqlite, `tron-${TX_A}-200-0`)).toBeNull();
    // Confirmed evidence that cannot fill the remaining row is immutable, so the
    // block parks instead of consuming a slot on every later run.
    const parked = orderRetryState(sqlite, 200);
    expect(parked?.attempts).toBe(1);
    const nowSec = Math.floor(Date.now() / 1000);
    expect(parked?.dueAt).toBeGreaterThan(nowSec + 6 * 24 * 60 * 60);
  });

  it("updates only the exact still-null row so replays stay idempotent", async () => {
    const { sqlite, db } = fixtures.open();
    const timestamp = BASE_TIMESTAMP + 300;
    seedConflictBlock(sqlite, { block: 300, timestamp });

    const calls: number[] = [];
    stubConfirmedBlocks(new Map([[300, { timestamp, transactions: [TX_A, TX_B] }]]), calls);
    await resolveTronBlacklistOrder(db, providerContext(), makeRunBudget());
    expect(transactionIndexOf(sqlite, `tron-${TX_A}-300-0`)).toBe(0);
    expect(transactionIndexOf(sqlite, `tron-${TX_B}-300-0`)).toBe(1);
    expect(orderRetryKeys(sqlite)).toEqual([]);

    // Another writer re-opens one row and pins the other to a foreign position.
    sqlite.prepare("UPDATE blacklist_events SET transaction_index = NULL WHERE id = ?").run(`tron-${TX_A}-300-0`);
    sqlite.prepare("UPDATE blacklist_events SET transaction_index = 7 WHERE id = ?").run(`tron-${TX_B}-300-0`);

    const second = await resolveTronBlacklistOrder(db, providerContext(), makeRunBudget());

    expect(calls).toEqual([300, 300]);
    expect(second).toEqual({ blocksAttempted: 1, positionsResolved: 1, blocksDeferred: 0 });
    // The exact-row guard refills only the still-null row; the foreign value survives.
    expect(transactionIndexOf(sqlite, `tron-${TX_A}-300-0`)).toBe(0);
    expect(transactionIndexOf(sqlite, `tron-${TX_B}-300-0`)).toBe(7);

    // With every position known the block has left the lane entirely.
    const third = await resolveTronBlacklistOrder(db, providerContext(), makeRunBudget());
    expect(third).toEqual({ blocksAttempted: 0, positionsResolved: 0, blocksDeferred: 0 });
    expect(calls).toEqual([300, 300]);
    expect(orderRetryKeys(sqlite)).toEqual([]);
  });

  it("exits candidacy once a block is filled and never refetches it", async () => {
    const { sqlite, db } = fixtures.open();
    seedConflictBlock(sqlite, { block: 100 });
    seedConflictBlock(sqlite, { block: 200 });
    const calls: number[] = [];
    stubConfirmedBlocks(
      new Map([
        [100, { timestamp: BASE_TIMESTAMP + 100, transactions: [TX_A, TX_B] }],
        [200, { timestamp: BASE_TIMESTAMP + 200, transactions: [TX_B, TX_A] }],
      ]),
      calls,
    );

    const first = await resolveTronBlacklistOrder(db, providerContext(), makeRunBudget());
    expect(first).toEqual({ blocksAttempted: 2, positionsResolved: 4, blocksDeferred: 0 });
    expect(calls).toEqual([100, 200]);

    const second = await resolveTronBlacklistOrder(db, providerContext(), makeRunBudget());
    expect(second).toEqual({ blocksAttempted: 0, positionsResolved: 0, blocksDeferred: 0 });
    expect(calls).toEqual([100, 200]);
    expect(orderRetryKeys(sqlite)).toEqual([]);
  });

  it("stops before the first block when the run budget is exhausted", async () => {
    const subrequestExhausted = fixtures.open();
    seedConflictBlock(subrequestExhausted.sqlite, { block: 100 });
    seedConflictBlock(subrequestExhausted.sqlite, { block: 200 });
    seedConflictBlock(subrequestExhausted.sqlite, { block: 300 });
    const subrequestCalls: number[] = [];
    stubConfirmedBlocks(new Map(), subrequestCalls);

    const bySubrequests = await resolveTronBlacklistOrder(
      subrequestExhausted.db,
      providerContext(),
      makeRunBudget({ subrequestLimit: 0 }),
    );
    expect(bySubrequests).toEqual({ blocksAttempted: 0, positionsResolved: 0, blocksDeferred: 3 });
    expect(subrequestCalls).toEqual([]);
    // Deferral books no attempt and writes no backoff state.
    expect(orderRetryKeys(subrequestExhausted.sqlite)).toEqual([]);

    const runtimeExhausted = fixtures.open();
    seedConflictBlock(runtimeExhausted.sqlite, { block: 100 });
    seedConflictBlock(runtimeExhausted.sqlite, { block: 200 });
    const runtimeCalls: number[] = [];
    stubConfirmedBlocks(new Map(), runtimeCalls);

    const byRuntime = await resolveTronBlacklistOrder(
      runtimeExhausted.db,
      providerContext(),
      makeRunBudget({ deadlineMs: Date.now() - 1 }),
    );
    expect(byRuntime).toEqual({ blocksAttempted: 0, positionsResolved: 0, blocksDeferred: 2 });
    expect(runtimeCalls).toEqual([]);
  });
});

describe("resolveTronBlacklistOrder durable backoff", () => {
  it("backs failed blocks off in the cache table so later blocks are not starved", async () => {
    const { sqlite, db } = fixtures.open();
    for (let block = 1001; block <= 1010; block++) {
      seedConflictBlock(sqlite, { block });
    }
    // Blocks 1001 and 1002 fail at the provider; 1003-1010 are served.
    const blocks = new Map(
      Array.from({ length: 8 }, (_, offset) => {
        const block = 1003 + offset;
        return [block, { timestamp: BASE_TIMESTAMP + block, transactions: [TX_A, TX_B] }] as const;
      }),
    );
    const calls: number[] = [];
    stubConfirmedBlocks(blocks, calls);
    const beforeFirstRun = Math.floor(Date.now() / 1000);

    const first = await resolveTronBlacklistOrder(db, providerContext(), makeRunBudget());
    // Eight blocks are admitted per pass: the two provider failures back off and
    // six resolve. Blocks 1009-1010 sit beyond the selection limit, so they are
    // not admitted and not counted as deferred.
    expect(first).toEqual({ blocksAttempted: 8, positionsResolved: 12, blocksDeferred: 0 });
    expect(calls).toEqual([1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008]);
    for (const failed of [1001, 1002]) {
      const state = orderRetryState(sqlite, failed);
      expect(state?.attempts).toBe(1);
      expect(state?.dueAt).toBeGreaterThan(beforeFirstRun);
      expect(transactionIndexOf(sqlite, `tron-${TX_A}-${failed}-0`)).toBeNull();
    }

    const second = await resolveTronBlacklistOrder(db, providerContext(), makeRunBudget());
    // The failed blocks are not due yet, so they are deferred — not refetched —
    // and the later conflicting blocks proceed instead of starving behind them.
    expect(second).toEqual({ blocksAttempted: 2, positionsResolved: 4, blocksDeferred: 2 });
    expect(calls).toEqual([1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010]);
    expect(orderRetryKeys(sqlite)).toEqual([`${RETRY_KEY_PREFIX}1001`, `${RETRY_KEY_PREFIX}1002`]);
    expect(orderRetryState(sqlite, 1001)?.attempts).toBe(1);
    expect(transactionIndexOf(sqlite, `tron-${TX_A}-1009-0`)).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM blacklist_events WHERE block_number IN (1001, 1002) AND transaction_index IS NOT NULL").get()).toEqual({ count: 0 });
  });

  it("filters not-yet-due blocks before the selection limit so poison blocks cannot starve later ones", async () => {
    const { sqlite, db } = fixtures.open();
    for (let block = 2001; block <= 2070; block++) {
      seedConflictBlock(sqlite, { block });
    }
    // Sixty-eight previously failed blocks are parked well past this run.
    const nowSec = Math.floor(Date.now() / 1000);
    const parked = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
    for (let block = 2001; block <= 2068; block++) {
      parked.run(`blacklist:order-retry:${block}`, JSON.stringify({ attempts: 2, dueAt: nowSec + 3_600 }), nowSec);
    }
    // Only the two fresh blocks are servable; every parked block would throw.
    const calls: number[] = [];
    stubConfirmedBlocks(
      new Map([
        [2069, { timestamp: BASE_TIMESTAMP + 2069, transactions: [TX_A, TX_B] }],
        [2070, { timestamp: BASE_TIMESTAMP + 2070, transactions: [TX_B, TX_A] }],
      ]),
      calls,
    );

    const result = await resolveTronBlacklistOrder(db, providerContext(), makeRunBudget());

    // The due-time filter must run before the selection limit: with the parked
    // majority removed in SQL, the fresh blocks are reached in the same pass
    // instead of hiding behind sixty-eight never-enrichable older blocks.
    expect(result).toEqual({ blocksAttempted: 2, positionsResolved: 4, blocksDeferred: 68 });
    expect(calls).toEqual([2069, 2070]);
    expect(transactionIndexOf(sqlite, `tron-${TX_A}-2069-0`)).toBe(0);
    expect(transactionIndexOf(sqlite, `tron-${TX_B}-2070-0`)).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM blacklist_events WHERE block_number <= 2068 AND transaction_index IS NOT NULL").get()).toEqual({ count: 0 });
  });
});

describe("compareBlacklistEvents transaction-position ties", () => {
  const T = BASE_TIMESTAMP;
  const B = 500_000;

  it("orders two Tron events across transactions only by observed block positions", () => {
    const later = { id: `tron-${TX_A}-0`, timestamp: T, blockNumber: B, chainId: "tron", txHash: TX_A, transactionIndex: 3 };
    const earlier = { id: `tron-${TX_B}-0`, timestamp: T, blockNumber: B, chainId: "tron", txHash: TX_B, transactionIndex: 1 };
    expect(compareBlacklistEvents(later, earlier)).toBe(2);
    expect(compareBlacklistEvents(earlier, later)).toBe(-2);
  });

  it("withholds cross-transaction order when either Tron position is unobserved", () => {
    const observed = { id: `tron-${TX_A}-0`, timestamp: T, blockNumber: B, chainId: "tron", txHash: TX_A, transactionIndex: 3 };
    const unobserved = { id: `tron-${TX_B}-0`, timestamp: T, blockNumber: B, chainId: "tron", txHash: TX_B, transactionIndex: null };
    expect(compareBlacklistEvents(observed, unobserved)).toBe(0);
    expect(compareBlacklistEvents(unobserved, observed)).toBe(0);
  });

  it("never compares transaction-local indexes across chains or inside one transaction", () => {
    // Before the both-Tron guard this pair compared 9 - 0; the id-derived
    // presentation order (2 vs 5) must decide instead.
    const tron = { id: `tron-${TX_A}-2`, timestamp: T, blockNumber: B, chainId: "tron", txHash: TX_A, transactionIndex: 9 };
    const evm = { id: "ethereum-0xbb-5", timestamp: T, blockNumber: B, chainId: "ethereum", txHash: "0xbb", transactionIndex: 0 };
    expect(compareBlacklistEvents(tron, evm)).toBe(-3);
    expect(compareBlacklistEvents(evm, tron)).toBe(3);
    // Same transaction: the array suffix orders the events, not the shared position.
    const first = { id: `tron-${TX_A}-0`, timestamp: T, blockNumber: B, chainId: "tron", txHash: TX_A, transactionIndex: 4 };
    const second = { id: `tron-${TX_A}-1`, timestamp: T, blockNumber: B, chainId: "tron", txHash: TX_A, transactionIndex: 4 };
    expect(compareBlacklistEvents(first, second)).toBe(-1);
  });
});
