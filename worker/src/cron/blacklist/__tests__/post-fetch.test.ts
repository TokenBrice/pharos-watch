import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../../test-helpers/__shared/mock-d1";
import { makeBlacklistRow } from "../../../test-helpers/__shared/fixtures";
import type { ContractEventConfig } from "../../../lib/blacklist-contracts";
import { D1_BATCH_SIZE } from "../../../lib/constants";
import type { BlacklistRunBudget } from "../run-budget";
import type { BlacklistRow } from "../shared";

vi.mock("../amount-recovery", () => ({
  enrichRowBalances: vi.fn(),
}));

vi.mock("../persistence", () => ({
  insertBlacklistRows: vi.fn(),
}));

vi.mock("../current-balance-cache", () => ({
  syncCurrentBalanceCacheForRows: vi.fn(),
}));

vi.mock("../row-preparation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../row-preparation")>();
  return {
    ...actual,
    fetchBlacklistAssetPriceFromCache: vi.fn(async () => null),
  };
});

import { enrichRowBalances } from "../amount-recovery";
import { syncCurrentBalanceCacheForRows } from "../current-balance-cache";
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

describe("processFetchedBlacklistRows", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("honors abort before a post-fetch D1 read", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop post-fetch"));
    const prepare = vi.fn();
    const row = makeBlacklistRow({ id: "ethereum-aborted" }) as BlacklistRow;

    await expect(processFetchedBlacklistRows({
      db: { prepare } as unknown as D1Database,
      config,
      rows: [row],
      chainLabel: "evm",
      etherscanApiKey: null,
      drpcApiKey: null,
      trongridApiKey: null,
      etherscanLimiter: async <T>(fn: () => Promise<T>) => fn(),
      tronLimiter: async <T>(fn: () => Promise<T>) => fn(),
      runBudget: makeRunBudget(),
      signal: controller.signal,
    })).rejects.toThrow("stop post-fetch");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("retries a transient D1 overload while filtering existing ids", async () => {
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
    const db = {
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({ all })) })),
    } as unknown as D1Database;
    vi.spyOn(Math, "random").mockReturnValue(0);

    const result = await processFetchedBlacklistRows({
      db,
      config,
      rows: [row],
      chainLabel: "evm",
      etherscanApiKey: null,
      drpcApiKey: null,
      trongridApiKey: null,
      etherscanLimiter: async <T>(fn: () => Promise<T>) => fn(),
      tronLimiter: async <T>(fn: () => Promise<T>) => fn(),
      runBudget: makeRunBudget(),
    });

    expect(attempts).toBe(2);
    expect(result.insertedRows).toBe(0);
  });

  it("runs a current-balance cache repair lane for duplicate fetched rows", async () => {
    const duplicateRow = makeBlacklistRow({
      id: "ethereum-0xduplicate-0x0",
      stablecoin: "USDT",
      chain_id: "ethereum",
      chain_name: "Ethereum",
      event_type: "blacklist",
      address: "0x0000000000000000000000000000000000000123",
      amount_native: null,
      amount_usd_at_event: null,
      amount_source: "unavailable",
      amount_status: "recoverable_pending",
    }) as BlacklistRow;
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

    const result = await processFetchedBlacklistRows({
      db,
      config,
      rows: [duplicateRow],
      chainLabel: "evm",
      etherscanApiKey: null,
      drpcApiKey: null,
      trongridApiKey: null,
      etherscanLimiter: async <T>(fn: () => Promise<T>) => fn(),
      tronLimiter: async <T>(fn: () => Promise<T>) => fn(),
      runBudget: makeRunBudget(),
    });

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
    const duplicateRows = Array.from({ length: 101 }, (_, index) => makeBlacklistRow({
      id: `ethereum-0xduplicate-chunk-${index}`,
      stablecoin: "USDT",
      chain_id: "ethereum",
      chain_name: "Ethereum",
      event_type: "blacklist",
      address: `0x${(index + 1).toString(16).padStart(40, "0")}`,
      amount_native: null,
      amount_usd_at_event: null,
      amount_source: "unavailable",
      amount_status: "recoverable_pending",
    }) as BlacklistRow);
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

    const result = await processFetchedBlacklistRows({
      db,
      config,
      rows: duplicateRows,
      chainLabel: "evm",
      etherscanApiKey: null,
      drpcApiKey: null,
      trongridApiKey: null,
      etherscanLimiter: async <T>(fn: () => Promise<T>) => fn(),
      tronLimiter: async <T>(fn: () => Promise<T>) => fn(),
      runBudget: makeRunBudget(),
    });

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
    const blacklistRow = makeBlacklistRow({
      id: "ethereum-0xduplicate-release-0",
      stablecoin: "USDT",
      chain_id: "ethereum",
      chain_name: "Ethereum",
      event_type: "blacklist",
      address: "0x0000000000000000000000000000000000000789",
      amount_native: null,
      amount_usd_at_event: null,
      amount_source: "unavailable",
      amount_status: "recoverable_pending",
      timestamp: 100,
    }) as BlacklistRow;
    const unblacklistRow = makeBlacklistRow({
      id: "ethereum-0xduplicate-release-1",
      stablecoin: "USDT",
      chain_id: "ethereum",
      chain_name: "Ethereum",
      event_type: "unblacklist",
      address: blacklistRow.address,
      amount_native: null,
      amount_usd_at_event: null,
      amount_source: "unavailable",
      amount_status: "recoverable_pending",
      timestamp: 200,
    }) as BlacklistRow;
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

    const result = await processFetchedBlacklistRows({
      db,
      config,
      rows: [blacklistRow, unblacklistRow],
      chainLabel: "evm",
      etherscanApiKey: null,
      drpcApiKey: null,
      trongridApiKey: null,
      etherscanLimiter: async <T>(fn: () => Promise<T>) => fn(),
      tronLimiter: async <T>(fn: () => Promise<T>) => fn(),
      runBudget: makeRunBudget(),
    });

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
    const blacklistRow = makeBlacklistRow({
      id: "ethereum-0xtransient-0",
      stablecoin: "USDT",
      chain_id: "ethereum",
      chain_name: "Ethereum",
      event_type: "blacklist",
      address: "0x0000000000000000000000000000000000000456",
      amount_native: null,
      amount_usd_at_event: null,
      amount_source: "unavailable",
      amount_status: "recoverable_pending",
      timestamp: 20,
    }) as BlacklistRow;
    const unblacklistRow = makeBlacklistRow({
      id: "ethereum-0xtransient-1",
      stablecoin: "USDT",
      chain_id: "ethereum",
      chain_name: "Ethereum",
      event_type: "unblacklist",
      address: blacklistRow.address,
      amount_native: null,
      amount_usd_at_event: null,
      amount_source: "unavailable",
      amount_status: "recoverable_pending",
      timestamp: 21,
    }) as BlacklistRow;
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

    const result = await processFetchedBlacklistRows({
      db,
      config,
      rows: [blacklistRow, unblacklistRow],
      chainLabel: "evm",
      etherscanApiKey: null,
      drpcApiKey: null,
      trongridApiKey: null,
      etherscanLimiter: async <T>(fn: () => Promise<T>) => fn(),
      tronLimiter: async <T>(fn: () => Promise<T>) => fn(),
      runBudget: makeRunBudget(),
    });

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
});
