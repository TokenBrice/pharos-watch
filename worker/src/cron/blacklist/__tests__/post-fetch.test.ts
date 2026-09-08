import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeBlacklistRow } from "../../../test-helpers/__shared/fixtures";
import type { ContractEventConfig } from "../../../lib/blacklist-contracts";
import { D1_BATCH_SIZE } from "../../../lib/constants";
import type { BlacklistRunBudget } from "../../../lib/blacklist/run-budget";
import type { BlacklistRow } from "../../../lib/blacklist/shared";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";
import { makePendingBlacklistRow } from "./blacklist.test-support";

vi.mock("../../../lib/blacklist/amount-recovery", () => ({
  enrichRowBalances: vi.fn(),
}));

vi.mock("../persistence", () => ({
  insertBlacklistRows: vi.fn(),
}));

vi.mock("../../../lib/blacklist/current-balance-cache", () => ({
  syncCurrentBalanceCacheForRows: vi.fn(),
}));

vi.mock("../../../lib/blacklist/row-preparation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/blacklist/row-preparation")>();
  return {
    ...actual,
    fetchBlacklistAssetPriceFromCache: vi.fn(async () => null),
  };
});

import { enrichRowBalances } from "../../../lib/blacklist/amount-recovery";
import { syncCurrentBalanceCacheForRows } from "../../../lib/blacklist/current-balance-cache";
import { insertBlacklistRows } from "../persistence";
import { processFetchedBlacklistRows } from "../post-fetch";

const config: ContractEventConfig = {
  configKey: "ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7",
  chain: {
    chainId: "ethereum",
    chainName: "Ethereum",
    evmChainId: 1,
    explorerUrl: "https://etherscan.io",
    type: "evm",
  },
  stablecoinId: "usdt-tether",
  stablecoin: "USDT",
  contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  decimals: 6,
  events: [],
};

function makeRunBudget(): BlacklistRunBudget {
  return {
    subrequestBudget: { count: 0, limit: 10 },
    deadlineMs: Date.now() + 10_000,
    minimumConfigWindowMs: 0,
  };
}

function postFetchOptions(
  db: D1Database,
  rows: BlacklistRow[],
  overrides: Partial<Parameters<typeof processFetchedBlacklistRows>[0]> = {},
): Parameters<typeof processFetchedBlacklistRows>[0] {
  return {
    db,
    config,
    rows,
    chainLabel: "evm",
    etherscanApiKey: null,
    drpcApiKey: null,
    trongridApiKey: null,
    etherscanLimiter: async <T>(fn: () => Promise<T>) => fn(),
    tronLimiter: async <T>(fn: () => Promise<T>) => fn(),
    runBudget: makeRunBudget(),
    ...overrides,
  };
}

describe("processFetchedBlacklistRows", () => {
  beforeEach(() => {
    vi.mocked(enrichRowBalances).mockReset();
    vi.mocked(insertBlacklistRows).mockReset();
    vi.mocked(syncCurrentBalanceCacheForRows).mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("honors abort before a post-fetch D1 read", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop post-fetch"));
    const prepare = vi.fn();
    const row = makeBlacklistRow({ id: "ethereum-aborted" }) as BlacklistRow;

    await expect(processFetchedBlacklistRows(postFetchOptions(makeNoopD1({ prepare }), [row], {
      signal: controller.signal,
    }))).rejects.toThrow("stop post-fetch");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("retries a transient D1 overload while filtering existing ids", async () => {
    vi.useFakeTimers();
    const row = makeBlacklistRow({
      id: "ethereum-overload-retry",
      suppression_reason: "fixture-suppressed",
    }) as BlacklistRow;
    let attempts = 0;
    const all = vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error("D1 DB is overloaded");
      return { results: [{ id: row.id }] };
    });
    const db = makeNoopD1({
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({ all })) })),
    });
    vi.spyOn(Math, "random").mockReturnValue(0);

    const pending = processFetchedBlacklistRows(postFetchOptions(db, [row]));
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(attempts).toBe(2);
    expect(result.insertedRows).toBe(0);
  });

  it("runs a current-balance cache repair lane for duplicate fetched rows", async () => {
    const duplicateRow = makePendingBlacklistRow({
      id: "ethereum-0xduplicate-0x0",
      address: "0x0000000000000000000000000000000000000123",
    });
    const db = mockD1([
      {
        match: "SELECT id FROM blacklist_events WHERE id IN",
        rows: [{ id: duplicateRow.id }],
      },
      {
        match: "SELECT * FROM blacklist_events",
        rows: [duplicateRow as unknown as Record<string, unknown>],
      },
    ], { requireMatch: true });
    vi.mocked(syncCurrentBalanceCacheForRows).mockResolvedValue({
      updated: 1,
      failed: 0,
      skippedDueBudget: 0,
      budgetExhausted: false,
    });

    const result = await processFetchedBlacklistRows(postFetchOptions(db, [duplicateRow]));

    expect(result.insertedRows).toBe(0);
    expect(result.enrichCounters).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    expect(result.currentBalanceCacheCounters).toMatchObject({ updated: 1, failed: 0 });
    expect(enrichRowBalances).not.toHaveBeenCalled();
    expect(insertBlacklistRows).not.toHaveBeenCalled();
    expect(syncCurrentBalanceCacheForRows).toHaveBeenCalledWith(
      db,
      config,
      [duplicateRow],
      expect.objectContaining({
        assetPriceUsd: null,
        latestRows: [duplicateRow],
      }),
    );
  });

  it("chunks duplicate repair latest-state lookups at the D1 batch limit", async () => {
    const duplicateRows = Array.from({ length: 101 }, (_, index) => makePendingBlacklistRow({
      id: `ethereum-0xduplicate-chunk-${index}`,
      address: `0x${(index + 1).toString(16).padStart(40, "0")}`,
    }));
    const db = mockD1([
      {
        match: "SELECT id FROM blacklist_events WHERE id IN",
        rows: duplicateRows.map((row) => ({ id: row.id })),
      },
      {
        match: "SELECT * FROM blacklist_events",
        rows: [],
      },
    ], { requireMatch: true });
    const batchSizes: number[] = [];
    const originalBatch = db.batch.bind(db);
    db.batch = (async (statements: D1PreparedStatement[]) => {
      batchSizes.push(statements.length);
      if (statements.length > D1_BATCH_SIZE) {
        throw new Error(`simulated D1 batch limit exceeded: ${statements.length} statements > ${D1_BATCH_SIZE}`);
      }
      return originalBatch(statements);
    }) as D1Database["batch"];
    vi.mocked(syncCurrentBalanceCacheForRows).mockResolvedValue({
      updated: 0,
      failed: 0,
      skippedDueBudget: 0,
      budgetExhausted: false,
    });

    const result = await processFetchedBlacklistRows(postFetchOptions(db, duplicateRows));

    expect(result.insertedRows).toBe(0);
    expect(batchSizes).toEqual([D1_BATCH_SIZE, 1]);
    expect(syncCurrentBalanceCacheForRows).toHaveBeenCalledWith(
      db,
      config,
      duplicateRows,
      expect.objectContaining({
        assetPriceUsd: null,
      }),
    );
  });

  it("uses duplicate unblacklist rows when selecting repair latest state", async () => {
    const blacklistRow = makePendingBlacklistRow({
      id: "ethereum-0xduplicate-release-0",
      address: "0x0000000000000000000000000000000000000789",
      timestamp: 100,
    });
    const unblacklistRow = makePendingBlacklistRow({
      id: "ethereum-0xduplicate-release-1",
      event_type: "unblacklist",
      address: blacklistRow.address,
      timestamp: 200,
    });
    const db = mockD1([
      {
        match: "SELECT id FROM blacklist_events WHERE id IN",
        rows: [{ id: blacklistRow.id }, { id: unblacklistRow.id }],
      },
      {
        match: "SELECT * FROM blacklist_events",
        rows: [unblacklistRow as unknown as Record<string, unknown>],
      },
    ], { requireMatch: true });
    vi.mocked(syncCurrentBalanceCacheForRows).mockResolvedValue({
      updated: 0,
      failed: 0,
      skippedDueBudget: 0,
      budgetExhausted: false,
    });

    const result = await processFetchedBlacklistRows(postFetchOptions(db, [blacklistRow, unblacklistRow]));

    expect(result.insertedRows).toBe(0);
    expect(syncCurrentBalanceCacheForRows).toHaveBeenCalledWith(
      db,
      config,
      [blacklistRow, unblacklistRow],
      expect.objectContaining({
        latestRows: [unblacklistRow],
      }),
    );
  });

  it("passes same-batch blacklist rows to cache sync even when a later unblacklist is latest", async () => {
    const blacklistRow = makePendingBlacklistRow({
      id: "ethereum-0xtransient-0",
      address: "0x0000000000000000000000000000000000000456",
      timestamp: 20,
    });
    const unblacklistRow = makePendingBlacklistRow({
      id: "ethereum-0xtransient-1",
      event_type: "unblacklist",
      address: blacklistRow.address,
      timestamp: 21,
    });
    const db = mockD1([
      {
        match: "SELECT id FROM blacklist_events WHERE id IN",
        rows: [],
      },
    ], { requireMatch: true });
    vi.mocked(enrichRowBalances).mockResolvedValue({ attempted: 0, succeeded: 0, failed: 0 });
    vi.mocked(insertBlacklistRows).mockResolvedValue(2);
    vi.mocked(syncCurrentBalanceCacheForRows).mockResolvedValue({
      updated: 1,
      failed: 0,
      skippedDueBudget: 0,
      budgetExhausted: false,
    });

    const result = await processFetchedBlacklistRows(postFetchOptions(db, [blacklistRow, unblacklistRow]));

    expect(result.insertedRows).toBe(2);
    expect(syncCurrentBalanceCacheForRows).toHaveBeenCalledWith(
      db,
      config,
      [blacklistRow, unblacklistRow],
      expect.objectContaining({
        latestRows: [blacklistRow, unblacklistRow],
      }),
    );
  });

  it("stops mixed-row processing when insertion completes after cancellation", async () => {
    const controller = new AbortController();
    const fresh = makeBlacklistRow({ id: "fresh" }) as BlacklistRow;
    const duplicate = makeBlacklistRow({ id: "duplicate", address: "0xdef" }) as BlacklistRow;
    const db = mockD1([
      { match: "SELECT id FROM blacklist_events WHERE id IN", rows: [{ id: duplicate.id }] },
      { match: "SELECT * FROM blacklist_events", rows: [{ ...duplicate }] },
    ], { requireMatch: true });
    const batch = vi.spyOn(db, "batch");
    vi.mocked(enrichRowBalances).mockResolvedValue({ attempted: 0, succeeded: 0, failed: 0 });
    vi.mocked(insertBlacklistRows).mockImplementation(async () => {
      controller.abort(new Error("stop after insert"));
      return 1;
    });
    await expect(processFetchedBlacklistRows(postFetchOptions(db, [fresh, duplicate], {
      signal: controller.signal,
    }))).rejects.toThrow("stop after insert");
    expect(batch).not.toHaveBeenCalled();
    expect(syncCurrentBalanceCacheForRows).not.toHaveBeenCalled();
  });

  it("uses a newer persisted release when repairing mixed fetched rows", async () => {
    const fresh = makeBlacklistRow({ id: "fresh", timestamp: 100 }) as BlacklistRow;
    const duplicate = makeBlacklistRow({ id: "duplicate", address: "0xdef", timestamp: 100 }) as BlacklistRow;
    const release = { ...duplicate, id: "release", event_type: "unblacklist" as const, timestamp: 200 };
    const db = mockD1([
      { match: "SELECT id FROM blacklist_events WHERE id IN", rows: [{ id: duplicate.id }] },
      { match: "SELECT * FROM blacklist_events", rows: [release] },
    ], { requireMatch: true });
    vi.mocked(enrichRowBalances).mockResolvedValue({ attempted: 0, succeeded: 0, failed: 0 });
    vi.mocked(insertBlacklistRows).mockResolvedValue(1);
    vi.mocked(syncCurrentBalanceCacheForRows).mockResolvedValue({
      updated: 1, failed: 0, skippedDueBudget: 0, budgetExhausted: false,
    });
    const result = await processFetchedBlacklistRows(postFetchOptions(db, [fresh, duplicate]));
    expect(result.insertedRows).toBe(1);
    expect(syncCurrentBalanceCacheForRows).toHaveBeenCalledWith(db, config, [fresh, duplicate],
      expect.objectContaining({ latestRows: [fresh, release] }));
  });
});
