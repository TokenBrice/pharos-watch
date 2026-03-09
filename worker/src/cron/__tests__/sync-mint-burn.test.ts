import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

const ZERO_TOPIC = "0x0000000000000000000000000000000000000000000000000000000000000000";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const CCIP_SEND_REQUESTED_TOPIC = "0xd0c3c799bf9e2639de44391e7f524d229b2b55f5b1ea94b2bf7da42f7243dddd";

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
      stablecoinId: "usdt-tether",
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
      bridgeDetection: {
        protocol: "ccip",
        knownBridgePoolAddresses: ["0x9359cd75549dae00cdd8d22297bc9b13fbbe4b79"],
        knownBridgeRouterAddresses: ["0x80226fc0ee2b096224eeac085bb9a8cba1146f7d"],
        bridgeSignalTopics: ["0xd0c3c799bf9e2639de44391e7f524d229b2b55f5b1ea94b2bf7da42f7243dddd"],
        bridgeSignalSelectors: ["0x96f4e9f9"],
      },
    },
    {
      chain: {
        chainId: "ethereum",
        chainName: "Ethereum",
        evmChainId: 1,
        explorerUrl: "https://etherscan.io",
        type: "evm",
      },
      stablecoinId: "usdc-circle",
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
  getAlchemyTransactionByHash: vi.fn(async () => ({ hash: "0xtx", to: "0xrouter", input: "0x96f4e9f9" })),
  getAlchemyTransactionReceipt: vi.fn(async () => ({ transactionHash: "0xtx", to: "0xrouter", logs: [] })),
  fetchAlchemyLogs: vi.fn(async () => ({ logs: [], complete: true, scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 })),
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
import {
  fetchAlchemyLogs,
  getAlchemyBlockNumber,
  getAlchemyTransactionByHash,
  getAlchemyTransactionReceipt,
  resolveBlockTimestamps,
} from "../../lib/alchemy-logs";
import { createBudget } from "../../lib/evm-logs";

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
    { match: "price_cache", rows: [{ asset_id: "usdt-tether", price: 1.0 }, { asset_id: "usdc-circle", price: 0.999 }] },
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

function topicAddress(address: string): string {
  const raw = address.toLowerCase().replace(/^0x/, "");
  return `0x${"0".repeat(24)}${raw}`;
}

function makeBurnLog(opts: { blockNumber?: number; txHash?: string; logIndex?: number; sender?: string } = {}) {
  const block = opts.blockNumber ?? 22_000_000;
  const sender = opts.sender ?? "0x1234000000000000000000000000000000000000";
  return {
    address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    topics: [
      TRANSFER_TOPIC,
      topicAddress(sender),
      ZERO_TOPIC,
    ],
    data: "0x00000000000000000000000000000000000000000000000000000002540be400",
    blockNumber: "0x" + block.toString(16),
    transactionHash: opts.txHash ?? "0xburn",
    transactionIndex: "0x0",
    blockHash: "0x0",
    logIndex: "0x" + (opts.logIndex ?? 0).toString(16),
    removed: false,
  };
}

function makeReceiptLog(txHash: string, topics: string[]) {
  return {
    address: "0x80226fc0ee2b096224eeac085bb9a8cba1146f7d",
    topics,
    data: "0x",
    blockNumber: "0x14fb180",
    transactionHash: txHash,
    transactionIndex: "0x0",
    blockHash: "0x0",
    logIndex: "0x0",
    removed: false,
  };
}

describe("syncMintBurn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T12:00:00Z"));
    vi.mocked(createBudget).mockReset().mockImplementation((limit = 200) => ({ count: 0, limit }));
    vi.mocked(getAlchemyBlockNumber).mockReset().mockResolvedValue(22_000_000);
    vi.mocked(getAlchemyTransactionByHash).mockReset().mockResolvedValue({ hash: "0xtx", to: "0xrouter", input: "0x96f4e9f9" });
    vi.mocked(getAlchemyTransactionReceipt).mockReset().mockResolvedValue({ transactionHash: "0xtx", to: "0xrouter", logs: [] });
    vi.mocked(fetchAlchemyLogs).mockReset().mockResolvedValue({
      logs: [],
      complete: true,
      scannedToBlock: 22_000_000,
      calls: 1,
      maxDepth: 0,
    });
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
      .mockResolvedValueOnce({ logs: [makeMintLog(), makeMintLog({ txHash: "0xsecond", logIndex: 1 })], complete: true, scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 })
      .mockResolvedValueOnce({ logs: [], complete: true, scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 })
      .mockResolvedValueOnce({ logs: [], complete: true, scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 });

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

  it("prioritizes critical configs even when rotation starts with extended", async () => {
    const db = makeDb({ runState: { nextIndex: 1, degradedStreak: 0 } });

    await syncMintBurn(db, "alchemy-key");

    const firstCall = vi.mocked(fetchAlchemyLogs).mock.calls[0];
    const firstContract = firstCall[1] as string;
    expect(firstContract).toBe("0xdac17f958d2ee523a2206206994597c13d831ec7"); // USDT critical first
  });

  it("advances contract despite one failing eventDef and reports failedEventDefs", async () => {
    const db = makeDb();

    vi.mocked(fetchAlchemyLogs)
      .mockResolvedValueOnce(null as unknown as never)
      .mockResolvedValueOnce({ logs: [makeMintLog()], complete: true, scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 })
      .mockResolvedValueOnce({ logs: [], complete: true, scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 });

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

  it("reports bridge burn classification counters in metadata", async () => {
    const db = makeDb();

    vi.mocked(fetchAlchemyLogs)
      .mockResolvedValueOnce({ logs: [], complete: true, scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 })
      .mockResolvedValueOnce({
        logs: [
          makeBurnLog({
            txHash: "0xbridge",
            sender: "0x9359cd75549dae00cdd8d22297bc9b13fbbe4b79",
          }),
          makeBurnLog({
            txHash: "0xeffective",
            sender: "0x1234000000000000000000000000000000000000",
            logIndex: 1,
          }),
        ],
        complete: true,
        scannedToBlock: 22_000_000,
        calls: 1,
        maxDepth: 0,
      })
      .mockResolvedValueOnce({ logs: [], complete: true, scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 });

    vi.mocked(resolveBlockTimestamps).mockResolvedValueOnce(new Map([[22_000_000, 1_718_650_752]]));
    vi.mocked(getAlchemyTransactionByHash).mockImplementation(async (_url, txHash) => {
      if (txHash === "0xbridge") {
        return {
          hash: txHash,
          to: "0x80226fc0ee2b096224eeac085bb9a8cba1146f7d",
          input: "0x96f4e9f9",
        };
      }
      return {
        hash: txHash,
        to: "0x1111111111111111111111111111111111111111",
        input: "0xdeadbeef",
      };
    });
    vi.mocked(getAlchemyTransactionReceipt).mockImplementation(async (_url, txHash) => {
      if (txHash === "0xbridge") {
        return {
          transactionHash: txHash,
          to: "0x80226fc0ee2b096224eeac085bb9a8cba1146f7d",
          logs: [makeReceiptLog(txHash, [CCIP_SEND_REQUESTED_TOPIC])],
        };
      }
      return {
        transactionHash: txHash,
        to: "0x1111111111111111111111111111111111111111",
        logs: [makeReceiptLog(txHash, [])],
      };
    });

    const result = await syncMintBurn(db, "alchemy-key");
    const meta = JSON.parse(result.metadata);

    expect(meta.burnClassification.bridgeBurns).toBe(1);
    expect(meta.burnClassification.effectiveBurns).toBe(1);
    expect(meta.burnClassification.reviewBurns).toBe(0);
  });

  it("counts atomic roundtrips across mint and burn event definitions", async () => {
    const db = makeDb();

    vi.mocked(fetchAlchemyLogs)
      .mockResolvedValueOnce({
        logs: [makeMintLog({ txHash: "0xroundtrip", logIndex: 0 })],
        complete: true,
        scannedToBlock: 22_000_000,
        calls: 1,
        maxDepth: 0,
      })
      .mockResolvedValueOnce({
        logs: [makeBurnLog({ txHash: "0xroundtrip", logIndex: 1 })],
        complete: true,
        scannedToBlock: 22_000_000,
        calls: 1,
        maxDepth: 0,
      })
      .mockResolvedValueOnce({ logs: [], complete: true, scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 });

    vi.mocked(resolveBlockTimestamps).mockResolvedValueOnce(new Map([[22_000_000, 1_718_650_752]]));

    const result = await syncMintBurn(db, "alchemy-key");
    const meta = JSON.parse(result.metadata);

    expect(meta.atomicRoundtripsDetected).toBe(2);
  });

  it("keeps status ok when only extended configs are deferred", async () => {
    const db = makeDb({ runState: { nextIndex: 0, degradedStreak: 2 } });
    vi.mocked(createBudget).mockImplementation(() => ({ count: 190, limit: 200 }));

    const result = await syncMintBurn(db, "alchemy-key");
    const meta = JSON.parse(result.metadata);

    expect(result.status).toBe("ok");
    expect(meta.contractsDeferredExtended).toBeGreaterThan(0);
    expect(meta.criticalCoverage.contractsEnabled).toBe(1);
    expect(meta.criticalCoverage.contractsSatisfied).toBe(1);
    expect(meta.criticalCoverage.ratio).toBe(1);
    expect(meta.degradedSignal).toBe(false);
  });

  it("rejects when ALCHEMY_API_KEY is missing", async () => {
    const db = makeDb();
    await expect(syncMintBurn(db, null)).rejects.toThrow("No ALCHEMY_API_KEY configured");
  });
});
