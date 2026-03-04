import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

vi.mock("../../lib/mint-burn-contracts", () => ({
  MINT_BURN_CONFIGS: [
    {
      chain: {
        chainId: "ethereum",
        chainName: "Ethereum",
        evmChainId: 1,
        explorerUrl: "https://etherscan.io",
        type: "evm",
      },
      stablecoinId: "1",
      symbol: "USDT",
      contractAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      decimals: 6,
      dustThreshold: 10_000,
      startBlock: 21_900_000,
      tier: "critical",
      events: [
        {
          signature: "Transfer(address,address,uint256)",
          topicHash: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          direction: "mint",
          amountEncoding: "transfer-value",
          filterTopic: {
            index: 1,
            value: "0x0000000000000000000000000000000000000000000000000000000000000000",
          },
        },
        {
          signature: "Transfer(address,address,uint256)",
          topicHash: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          direction: "burn",
          amountEncoding: "transfer-value",
          filterTopic: {
            index: 2,
            value: "0x0000000000000000000000000000000000000000000000000000000000000000",
          },
        },
      ],
    },
    {
      chain: {
        chainId: "ethereum",
        chainName: "Ethereum",
        evmChainId: 1,
        explorerUrl: "https://etherscan.io",
        type: "evm",
      },
      stablecoinId: "2",
      symbol: "USDC",
      contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      decimals: 6,
      dustThreshold: 10_000,
      startBlock: 21_900_000,
      tier: "extended",
      events: [
        {
          signature: "Transfer(address,address,uint256)",
          topicHash: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          direction: "mint",
          amountEncoding: "transfer-value",
          filterTopic: {
            index: 1,
            value: "0x0000000000000000000000000000000000000000000000000000000000000000",
          },
        },
      ],
    },
  ],
}));

vi.mock("../../lib/alchemy-logs", () => ({
  buildAlchemyUrl: vi.fn(() => "https://eth-mainnet.g.alchemy.com/v2/test-key"),
  getAlchemyBlockNumber: vi.fn(async () => 22_000_000),
  fetchAlchemyLogs: vi.fn(async () => ({ logs: [], complete: true, calls: 1, maxDepth: 0 })),
  resolveBlockTimestamps: vi.fn(async () => new Map()),
}));

vi.mock("../../lib/evm-logs", () => ({
  createBudget: vi.fn((limit = 200) => ({ count: 0, limit })),
  budgetExhausted: vi.fn((budget: { count: number; limit: number }) => budget.count >= budget.limit),
  decodeUint256AtSlot: vi.fn(() => 50_000),
  decodeAddress: vi.fn((hex: string) => "0x" + hex.slice(-40)),
}));

vi.mock("../../lib/db", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../lib/db")>();
  return {
    ...orig,
    batchExecute: vi.fn(async (_db: D1Database, stmts: D1PreparedStatement[]) => stmts.length),
  };
});

import { syncMintBurn } from "../sync-mint-burn";
import { batchExecute } from "../../lib/db";
import { fetchAlchemyLogs, getAlchemyBlockNumber, resolveBlockTimestamps } from "../../lib/alchemy-logs";

function makeDb(opts: {
  runState?: { nextIndex: number; degradedStreak: number } | null;
  syncRows?: Array<{ last_block: number }>;
} = {}): D1Database {
  const runState = opts.runState ?? { nextIndex: 0, degradedStreak: 0 };
  return mockD1([
    {
      match: "mint_burn_run_state",
      rows: runState ? [{ next_config_index: runState.nextIndex, degraded_streak: runState.degradedStreak }] : [],
      first: runState ? { next_config_index: runState.nextIndex, degraded_streak: runState.degradedStreak } : null,
    },
    { match: "mint_burn_sync_state", rows: opts.syncRows ?? [] },
    { match: "price_cache", rows: [{ asset_id: "1", price: 1.0 }, { asset_id: "2", price: 0.999 }] },
    { match: "supply_history", rows: [] },
    { match: "mint_burn_hourly", rows: [] },
    { match: "mint_burn_events", rows: [] },
  ]);
}

function makeMintLog(opts: { blockNumber?: number; txHash?: string; logIndex?: number } = {}) {
  const block = opts.blockNumber ?? 22_000_000;
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

describe("syncMintBurn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T12:00:00Z"));
    vi.mocked(getAlchemyBlockNumber).mockReset().mockResolvedValue(22_000_000);
    vi.mocked(fetchAlchemyLogs).mockReset().mockResolvedValue({ logs: [], complete: true, calls: 1, maxDepth: 0 });
    vi.mocked(resolveBlockTimestamps).mockReset().mockResolvedValue(new Map());
    vi.mocked(batchExecute).mockReset().mockImplementation(async (_db, stmts) => stmts.length);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports inserted rows (not parsed rows) in itemCount", async () => {
    const db = makeDb();

    vi.mocked(fetchAlchemyLogs)
      .mockResolvedValueOnce({ logs: [makeMintLog(), makeMintLog({ txHash: "0xsecond", logIndex: 1 })], complete: true, calls: 1, maxDepth: 0 })
      .mockResolvedValueOnce({ logs: [], complete: true, calls: 1, maxDepth: 0 })
      .mockResolvedValueOnce({ logs: [], complete: true, calls: 1, maxDepth: 0 });

    vi.mocked(resolveBlockTimestamps).mockResolvedValueOnce(new Map([[22_000_000, 1_718_650_752]]));

    // call order: init sync-state, event insert, hourly aggregation
    vi.mocked(batchExecute)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);

    const result = await syncMintBurn(db, "alchemy-key");

    expect(result.itemCount).toBe(1);
    const meta = JSON.parse(result.metadata);
    expect(meta.rowsParsed).toBe(2);
    expect(meta.rowsInserted).toBe(1);
    expect(meta.rowsIgnored).toBe(1);
  });

  it("applies disabled symbols and reports configsDisabled", async () => {
    const db = makeDb();

    const result = await syncMintBurn(db, "alchemy-key", {
      disabledSymbols: ["USDC"],
    });

    const meta = JSON.parse(result.metadata);
    expect(meta.configsDisabled).toBe(1);
    expect(meta.sourceCoverage.contractsEnabled).toBe(1);
  });

  it("uses exact scan range (maxRange blocks inclusive)", async () => {
    const db = makeDb();

    await syncMintBurn(db, "alchemy-key");

    const firstCall = vi.mocked(fetchAlchemyLogs).mock.calls[0];
    const fromBlock = firstCall[3] as number;
    const toBlock = firstCall[4] as number;
    expect(toBlock - fromBlock + 1).toBe(50_000);
  });

  it("rotates config order using persisted next_config_index", async () => {
    const db = makeDb({ runState: { nextIndex: 1, degradedStreak: 0 } });

    await syncMintBurn(db, "alchemy-key");

    const firstCall = vi.mocked(fetchAlchemyLogs).mock.calls[0];
    const firstContract = firstCall[1] as string;
    expect(firstContract).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"); // USDC first
  });

  it("advances contract despite one failing eventDef and reports failedEventDefs", async () => {
    const db = makeDb();

    vi.mocked(fetchAlchemyLogs)
      .mockResolvedValueOnce(null as unknown as never)
      .mockResolvedValueOnce({ logs: [makeMintLog()], complete: true, calls: 1, maxDepth: 0 })
      .mockResolvedValueOnce({ logs: [], complete: true, calls: 1, maxDepth: 0 });

    vi.mocked(resolveBlockTimestamps).mockResolvedValueOnce(new Map([[22_000_000, 1_718_650_752]]));

    const result = await syncMintBurn(db, "alchemy-key");
    const meta = JSON.parse(result.metadata);
    const usdt = (meta.configBreakdown as Array<Record<string, unknown>>).find((row) => row.symbol === "USDT");

    expect(usdt?.failedEventDefs).toBeTruthy();
    expect(usdt?.advancedTo).not.toBeNull();
  });

  it("marks run as degraded after consecutive degraded streak", async () => {
    const db = makeDb({ runState: { nextIndex: 0, degradedStreak: 1 } });

    vi.mocked(fetchAlchemyLogs)
      .mockResolvedValueOnce(null as unknown as never)
      .mockResolvedValueOnce(null as unknown as never)
      .mockResolvedValueOnce(null as unknown as never);

    const result = await syncMintBurn(db, "alchemy-key");

    expect(result.status).toBe("degraded");
  });

  it("rejects when ALCHEMY_API_KEY is missing", async () => {
    const db = makeDb();
    await expect(syncMintBurn(db, null)).rejects.toThrow("No ALCHEMY_API_KEY configured");
  });
});
