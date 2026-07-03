import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

const ZERO_TOPIC = "0x0000000000000000000000000000000000000000000000000000000000000000";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const CCIP_SEND_REQUESTED_TOPIC = "0xd0c3c799bf9e2639de44391e7f524d229b2b55f5b1ea94b2bf7da42f7243dddd";

vi.mock("../../lib/mint-burn-contracts", () => ({
  buildMintBurnScope: vi.fn((configs: Array<{ chain: { chainId: string } }>) => ({
    chainIds: [...new Set(configs.map((config) => config.chain.chainId))],
    label: "Ethereum",
  })),
  MINT_BURN_BRIDGE_VALIDATION_ERROR_COUNT: 0,
  getMintBurnConfigsForStablecoin: vi.fn((stablecoinId: string) =>
    stablecoinId === "usdt-tether"
      ? [{
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
          adapterKind: "mixed",
          startBlockSource: "reviewed-contract-specific",
          startBlockConfidence: "high",
          tier: "critical",
          events: [],
        }]
      : [],
  ),
  getMintBurnTrackedPairs: vi.fn(() => new Set([
    "usdt-tether|ethereum",
    "usdc-circle|ethereum",
  ])),
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
      adapterKind: "mixed",
      startBlockSource: "reviewed-contract-specific",
      startBlockConfidence: "high",
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
      adapterKind: "transfer-zero-address",
      startBlockSource: "default-coverage-floor-2026-03-24",
      startBlockConfidence: "low",
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
  getAlchemyTransactionContextBatchMany: vi.fn(async (_url: string, txHashes: string[]) =>
    new Map(txHashes.map((txHash) => [txHash, {
      tx: { hash: txHash, to: "0xrouter", input: "0x96f4e9f9" },
      receipt: { transactionHash: txHash, to: "0xrouter", logs: [] },
    }])),
  ),
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

vi.mock("../../lib/mint-burn-pipeline/persistence", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../lib/mint-burn-pipeline/persistence")>();
  return {
    ...orig,
    recalcAffectedHours: vi.fn(orig.recalcAffectedHours),
  };
});

vi.mock("../../lib/mint-burn-pipeline/price-heal", () => ({
  getNullPriceBacklog: vi.fn(async () => ({ recent: 0, historical: 0 })),
  healNullPrices: vi.fn(async () => ({ healed: 0, affectedHours: new Map() })),
}));

vi.mock("../../lib/mint-burn-pipeline/roundtrip-sweep", () => ({
  sweepRecentRoundtrips: vi.fn(async () => ({ reclassified: 0, affectedHours: new Map(), saturated: false })),
}));

import { syncMintBurn } from "../sync-mint-burn";
import { syncMintBurnConfig } from "../mint-burn/sync-config";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import { batchExecute } from "../../lib/db";
import { recalcAffectedHours } from "../../lib/mint-burn-pipeline/persistence";
import { getNullPriceBacklog, healNullPrices } from "../../lib/mint-burn-pipeline/price-heal";
import { sweepRecentRoundtrips } from "../../lib/mint-burn-pipeline/roundtrip-sweep";
// batchExecute stays in db.ts (core DB utility)
import {
  fetchAlchemyLogs,
  getAlchemyBlockNumber,
  getAlchemyTransactionContextBatchMany,
  resolveBlockTimestamps,
} from "../../lib/alchemy-logs";
import { createBudget, decodeUint256AtSlot } from "../../lib/evm-logs";

function makeDb(opts: {
  runState?: { degradedStreak: number; lastConfigKey?: string | null } | null;
  syncRows?: Array<{ last_block: number; config_key?: string }>;
  cacheRows?: Array<{ key: string; value: string; updated_at: number }>;
} = {}): D1Database {
  const runState = opts.runState ?? { degradedStreak: 0, lastConfigKey: null };
  return mockD1([
    {
      match: "mint_burn_run_state",
      rows: runState ? [{ degraded_streak: runState.degradedStreak, last_config_key: runState.lastConfigKey ?? null }] : [],
      first: runState ? { degraded_streak: runState.degradedStreak, last_config_key: runState.lastConfigKey ?? null } : null,
    },
    { match: "mint_burn_sync_state", rows: opts.syncRows ?? [] },
    { match: "price_cache", rows: [{ asset_id: "usdt-tether", price: 1.0 }, { asset_id: "usdc-circle", price: 0.999 }] },
    { match: "supply_history", rows: [] },
    { match: "mint_burn_hourly", rows: [] },
    { match: "mint_burn_events", rows: [] },
    ...(opts.cacheRows
      ? [{ match: "cache", rows: opts.cacheRows }]
      : []),
  ]);
}

const USDT_CONFIG_KEY = "ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7";

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
    vi.mocked(decodeUint256AtSlot).mockReset().mockReturnValue(50_000);
    vi.mocked(getAlchemyBlockNumber).mockReset().mockResolvedValue(22_000_000);
    vi.mocked(getAlchemyTransactionContextBatchMany).mockReset().mockImplementation(async (_url, txHashes: string[]) =>
      new Map(txHashes.map((txHash) => [txHash, {
        tx: { hash: txHash, to: "0xrouter", input: "0x96f4e9f9" },
        receipt: { transactionHash: txHash, to: "0xrouter", logs: [] },
      }])),
    );
    vi.mocked(fetchAlchemyLogs).mockReset().mockResolvedValue({
      logs: [],
      complete: true,
      scannedToBlock: 22_000_000,
      calls: 1,
      maxDepth: 0,
    });
    vi.mocked(resolveBlockTimestamps).mockReset().mockResolvedValue(new Map());
    vi.mocked(batchExecute).mockReset().mockImplementation(async (_db, stmts) => stmts.length);
    vi.mocked(recalcAffectedHours).mockReset().mockResolvedValue(undefined);
    vi.mocked(getNullPriceBacklog).mockReset().mockResolvedValue({ recent: 0, historical: 0 });
    vi.mocked(healNullPrices).mockReset().mockResolvedValue({ healed: 0, affectedHours: new Map() });
    vi.mocked(sweepRecentRoundtrips).mockReset().mockResolvedValue({ reclassified: 0, affectedHours: new Map(), saturated: false });
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

  it("keeps full-success event scans anchored to the newest returned event", async () => {
    const db = makeDb();
    const config = MINT_BURN_CONFIGS[0]!;

    vi.mocked(fetchAlchemyLogs)
      .mockResolvedValueOnce({
        logs: [makeMintLog({ blockNumber: 21_910_000 })],
        complete: true,
        scannedToBlock: 21_949_999,
        calls: 1,
        maxDepth: 0,
      })
      .mockResolvedValueOnce({
        logs: [],
        complete: true,
        scannedToBlock: 21_949_999,
        calls: 1,
        maxDepth: 0,
      });
    vi.mocked(resolveBlockTimestamps).mockResolvedValueOnce(new Map([[21_910_000, 1_718_650_752]]));

    const result = await syncMintBurnConfig({
      db,
      config,
      key: "ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7",
      tier: "critical",
      fromBlock: 21_900_000,
      scanTo: 21_949_999,
      chainHead: 22_000_000,
      alchemyUrl: "https://eth-mainnet.g.alchemy.com/v2/alchemy-key",
      configBudgetLimit: 200,
      runTimestamp: 1_718_650_752,
      priceContext: { prices: new Map([["usdt-tether", 1]]), priceHistory: new Map() },
      chainTimestampCache: new Map(),
      txContextCache: new Map(),
      affectedHours: new Map(),
      safetyMarginBlocks: 10_000,
    });

    expect(result.summary.maxBlockSeen).toBe(21_910_000);
    expect(result.summary.advanceReason).toBe("full-success-events");
    expect(result.summary.advancedTo).toBe(21_910_000);
    expect(result.newLastBlock).toBe(21_910_000);
  });

  it("resumes from canonical sync-state progress", async () => {
    const db = makeDb({
      syncRows: [{
        config_key: "ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7",
        last_block: 21_955_000,
      }],
    });

    await syncMintBurn(db, "alchemy-key");

    const firstCall = vi.mocked(fetchAlchemyLogs).mock.calls[0];
    const fromBlock = firstCall[3] as number;
    expect(fromBlock).toBe(21_955_001);

    const history = (db as ReturnType<typeof makeDb> & { getHistory(): Array<{ sql: string; binds: unknown[] }> }).getHistory();
    const syncStateUpsert = history.find((entry: { sql: string; binds: unknown[] }) =>
      entry.sql.includes("INSERT INTO mint_burn_sync_state")
      && entry.binds[0] === "ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7",
    );
    expect(syncStateUpsert).toBeDefined();
  });

  it("prioritizes critical configs even when rotation starts with extended", async () => {
    const db = makeDb({ runState: { degradedStreak: 0, lastConfigKey: USDT_CONFIG_KEY } });

    await syncMintBurn(db, "alchemy-key");

    const firstCall = vi.mocked(fetchAlchemyLogs).mock.calls[0];
    const firstContract = firstCall[1] as string;
    expect(firstContract).toBe("0xdac17f958d2ee523a2206206994597c13d831ec7"); // USDT critical first
  });

  it("filters to the extended lane and reports lane metadata", async () => {
    const db = makeDb();

    const result = await syncMintBurn(db, "alchemy-key", {
      lane: "extended",
      jobName: "sync-mint-burn-extended",
    });
    const firstCall = vi.mocked(fetchAlchemyLogs).mock.calls[0];
    const firstContract = firstCall[1] as string;
    const meta = JSON.parse(result.metadata);

    expect(firstContract).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"); // USDC extended-only lane
    expect(meta.lane).toBe("extended");
    expect(meta.jobName).toBe("sync-mint-burn-extended");
    expect(meta.criticalCoverage.contractsEnabled).toBe(0);
    expect(meta.sourceCoverage.contractsEnabled).toBe(1);
  });

  it("does not advance when one eventDef fails with no safe frontier", async () => {
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
    expect(usdt?.advancedTo).toBeNull();
    expect(usdt?.advanceReason).toBe("no-safe-frontier");
  });

  it("advances only to the shared coverage frontier on partial event coverage", async () => {
    const db = makeDb();

    vi.mocked(fetchAlchemyLogs)
      .mockResolvedValueOnce({
        logs: [],
        complete: false,
        scannedToBlock: 21_910_000,
        calls: 3,
        maxDepth: 1,
      })
      .mockResolvedValueOnce({
        logs: [makeBurnLog({ blockNumber: 22_000_000 })],
        complete: true,
        scannedToBlock: 22_000_000,
        calls: 1,
        maxDepth: 0,
      })
      .mockResolvedValueOnce({ logs: [], complete: true, scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 });

    vi.mocked(resolveBlockTimestamps).mockResolvedValueOnce(new Map([[22_000_000, 1_718_650_752]]));

    const result = await syncMintBurn(db, "alchemy-key");
    const meta = JSON.parse(result.metadata);
    const usdt = (meta.configBreakdown as Array<Record<string, unknown>>).find((row) => row.symbol === "USDT");

    expect(usdt?.advancedTo).toBe(21_910_000);
    expect(usdt?.coverageFrontier).toBe(21_910_000);
    expect(usdt?.advanceReason).toBe("partial-frontier");
  });

  it("caps advancement before the earliest missing timestamp block", async () => {
    const db = makeDb();

    vi.mocked(fetchAlchemyLogs)
      .mockResolvedValueOnce({
        logs: [
          makeMintLog({ blockNumber: 21_950_000, txHash: "0xmissing-ts", logIndex: 0 }),
          makeMintLog({ blockNumber: 22_000_000, txHash: "0xpresent-ts", logIndex: 1 }),
        ],
        complete: true,
        scannedToBlock: 22_000_000,
        calls: 1,
        maxDepth: 0,
      })
      .mockResolvedValueOnce({ logs: [], complete: true, scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 })
      .mockResolvedValueOnce({ logs: [], complete: true, scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 });

    vi.mocked(resolveBlockTimestamps).mockResolvedValueOnce(new Map([[22_000_000, 1_718_650_752]]));

    const result = await syncMintBurn(db, "alchemy-key");
    const meta = JSON.parse(result.metadata);
    const usdt = (meta.configBreakdown as Array<Record<string, unknown>>).find((row) => row.symbol === "USDT");

    expect(usdt?.missingTimestampCount).toBe(1);
    expect(usdt?.earliestMissingTimestampBlock).toBe(21_950_000);
    expect(usdt?.advancedTo).toBe(21_949_999);
    expect(usdt?.coverageFrontier).toBe(21_949_999);
    expect(usdt?.advanceReason).toBe("partial-frontier");
  });

  it("does not require timestamps for dust-only logs", async () => {
    const db = makeDb();

    vi.mocked(decodeUint256AtSlot).mockReturnValue(1);
    vi.mocked(fetchAlchemyLogs)
      .mockResolvedValueOnce({
        logs: [makeMintLog({ blockNumber: 21_950_000 })],
        complete: true,
        scannedToBlock: 22_000_000,
        calls: 1,
        maxDepth: 0,
      })
      .mockResolvedValueOnce({
        logs: [makeBurnLog({ blockNumber: 21_950_001 })],
        complete: true,
        scannedToBlock: 22_000_000,
        calls: 1,
        maxDepth: 0,
      });

    const result = await syncMintBurn(db, "alchemy-key", { lane: "critical" });
    const meta = JSON.parse(result.metadata);
    const usdt = (meta.configBreakdown as Array<Record<string, unknown>>).find((row) => row.symbol === "USDT");

    expect(resolveBlockTimestamps).not.toHaveBeenCalled();
    expect(usdt?.missingTimestampCount).toBe(0);
    expect(usdt?.rowsDropped).toBe(2);
    expect(usdt?.advanceReason).toBe("full-success-empty");
    expect(usdt?.advancedTo).toBe(21_949_999);
  });

  it("marks run as degraded after consecutive degraded streak", async () => {
    const db = makeDb({ runState: { degradedStreak: 1 } });

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
    vi.mocked(getAlchemyTransactionContextBatchMany).mockImplementation(async (_url, txHashes: string[]) =>
      new Map(txHashes.map((txHash) => [txHash, txHash === "0xbridge"
        ? {
            tx: {
              hash: txHash,
              to: "0x80226fc0ee2b096224eeac085bb9a8cba1146f7d",
              input: "0x96f4e9f9",
            },
            receipt: {
              transactionHash: txHash,
              to: "0x80226fc0ee2b096224eeac085bb9a8cba1146f7d",
              logs: [makeReceiptLog(txHash, [CCIP_SEND_REQUESTED_TOPIC])],
            },
          }
        : {
            tx: {
              hash: txHash,
              to: "0x1111111111111111111111111111111111111111",
              input: "0xdeadbeef",
            },
            receipt: {
              transactionHash: txHash,
              to: "0x1111111111111111111111111111111111111111",
              logs: [makeReceiptLog(txHash, [])],
            },
          }])),
    );

    const result = await syncMintBurn(db, "alchemy-key");
    const meta = JSON.parse(result.metadata);

    expect(meta.burnClassification.bridgeBurns).toBe(1);
    expect(meta.burnClassification.effectiveBurns).toBe(1);
    expect(meta.burnClassification.reviewBurns).toBe(0);
    expect(meta.bridgeValidationErrors).toBe(0);
  });

  it("withholds tx-context shortfall rows and keeps the frontier retryable", async () => {
    const db = makeDb();

    vi.mocked(fetchAlchemyLogs)
      .mockResolvedValueOnce({
        logs: [makeMintLog({ txHash: "0xmissing-context" })],
        complete: true,
        scannedToBlock: 22_000_000,
        calls: 1,
        maxDepth: 0,
      })
      .mockResolvedValueOnce({ logs: [], complete: true, scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 })
      .mockResolvedValueOnce({ logs: [], complete: true, scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 });
    vi.mocked(resolveBlockTimestamps).mockResolvedValueOnce(new Map([[22_000_000, 1_718_650_752]]));
    vi.mocked(getAlchemyTransactionContextBatchMany).mockResolvedValueOnce(new Map());

    const result = await syncMintBurn(db, "alchemy-key");
    const meta = JSON.parse(result.metadata);
    const usdt = meta.configBreakdown.find((entry: { symbol: string }) => entry.symbol === "USDT");

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(0);
    expect(meta.rowsParsed).toBe(1);
    expect(meta.rowsInserted).toBe(0);
    expect(meta.apiErrors).toBe(1);
    expect(meta.bridgeClassification.txContextShortfalls).toBe(1);
    expect(meta.bridgeClassification.deferredRows).toBe(1);
    expect(meta.degradedSignal).toBe(true);
    expect(usdt?.txContextShortfalls).toBe(1);
    expect(usdt?.bridgeClassificationDeferredRows).toBe(1);
    expect(usdt?.failedEventDefs).toContain("tx-context:1");
    expect(usdt?.advancedTo).toBe(21_999_999);
    expect(usdt?.advanceReason).toBe("partial-frontier");
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
    const db = makeDb({ runState: { degradedStreak: 2 } });
    vi.mocked(createBudget).mockImplementation(() => ({ count: 190, limit: 200 }));

    const result = await syncMintBurn(db, "alchemy-key");
    const meta = JSON.parse(result.metadata);

    expect(result.status).toBe("ok");
    expect(meta.criticalCoverage.contractsEnabled).toBe(1);
    expect(meta.criticalCoverage.contractsSatisfied).toBe(1);
    expect(meta.criticalCoverage.ratio).toBe(1);
    expect(meta.degradedSignal).toBe(false);
  });

  it("caps per-config budget so a hot config cannot consume the whole cron budget", async () => {
    const db = makeDb();

    vi.mocked(fetchAlchemyLogs)
      .mockImplementationOnce(async (_url, _contract, _topics, fromBlock, _toBlock, budget) => {
        budget.count = budget.limit;
        return {
          logs: [],
          complete: false,
          scannedToBlock: fromBlock - 1,
          calls: budget.limit,
          maxDepth: 0,
        };
      })
      .mockResolvedValueOnce({
        logs: [],
        complete: true,
        scannedToBlock: 22_000_000,
        calls: 1,
        maxDepth: 0,
      })
      .mockResolvedValueOnce({
        logs: [],
        complete: true,
        scannedToBlock: 22_000_000,
        calls: 1,
        maxDepth: 0,
      });

    const result = await syncMintBurn(db, "alchemy-key");
    const meta = JSON.parse(result.metadata);
    const fetchedContracts = vi.mocked(fetchAlchemyLogs).mock.calls.map((call) => call[1] as string);

    expect(fetchedContracts[0]).toBe("0xdac17f958d2ee523a2206206994597c13d831ec7");
    expect(fetchedContracts).toContain("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(meta.configBreakdown[0].requestBudgetUsed).toBe(meta.configBreakdown[0].requestBudgetLimit);
  });

  it("stops before starting another config when the runtime budget tail is reserved", async () => {
    const db = makeDb();

    vi.mocked(fetchAlchemyLogs).mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-03-04T12:08:31Z"));
      return {
        logs: [],
        complete: true,
        scannedToBlock: 22_000_000,
        calls: 1,
        maxDepth: 0,
      };
    });

    const result = await syncMintBurn(db, "alchemy-key");
    const meta = JSON.parse(result.metadata);
    const usdc = (meta.configBreakdown as Array<Record<string, unknown>>).find((row) => row.symbol === "USDC");

    expect(meta.runtimeBudgetHit).toBe(true);
    expect(usdc?.attempted).toBe(false);
    expect(usdc?.skippedReason).toBe("runtime-budget-exhausted");
    expect(vi.mocked(fetchAlchemyLogs).mock.calls[0]?.[7]).toMatchObject({
      deadlineMs: expect.any(Number),
    });
  });

  it("allows bridge-aware critical configs to use the larger tx-context budget", async () => {
    const db = makeDb();

    vi.mocked(fetchAlchemyLogs)
      .mockResolvedValueOnce({
        logs: Array.from({ length: 70 }, (_, index) =>
          makeMintLog({ txHash: `0xbridge-mint-${index}`, logIndex: index }),
        ),
        complete: true,
        scannedToBlock: 22_000_000,
        calls: 1,
        maxDepth: 0,
      })
      .mockResolvedValueOnce({ logs: [], complete: true, scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 })
      .mockResolvedValueOnce({ logs: [], complete: true, scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 });
    vi.mocked(resolveBlockTimestamps).mockResolvedValueOnce(new Map([[22_000_000, 1_718_650_752]]));

    const result = await syncMintBurn(db, "alchemy-key");
    const meta = JSON.parse(result.metadata);
    const usdt = meta.configBreakdown.find((entry: { symbol: string }) => entry.symbol === "USDT");

    expect(usdt?.requestBudgetLimit).toBe(150);
    expect(usdt?.txContextShortfalls).toBe(0);
    expect(usdt?.advanceReason).toBe("full-success-events");
    expect(vi.mocked(getAlchemyTransactionContextBatchMany)).toHaveBeenCalledTimes(4);
  });

  it("rejects when ALCHEMY_API_KEY is missing", async () => {
    const db = makeDb();
    await expect(syncMintBurn(db, null)).rejects.toThrow("No ALCHEMY_API_KEY configured");
  });

  it("invalidates mint-burn-flows cache rows after a successful run", async () => {
    const db = makeDb();

    const result = await syncMintBurn(db, "alchemy-key");

    expect(result.status).toBe("ok");
    const history = (db as ReturnType<typeof makeDb> & { getHistory(): Array<{ sql: string; binds: unknown[] }> }).getHistory();
    const invalidation = history.find(
      (entry) =>
        entry.sql.includes("DELETE FROM cache")
        && entry.binds[0] === "mint-burn-flows:v3:"
        && entry.binds[1] === "mint-burn-flows:v3:\uffff",
    );
    expect(invalidation).toBeDefined();
  });

  it("emits nullPriceBacklog and roundtripsBacklogSaturated in metadata", async () => {
    const db = makeDb();

    vi.mocked(getNullPriceBacklog).mockResolvedValueOnce({ recent: 12, historical: 45 });
    vi.mocked(sweepRecentRoundtrips).mockResolvedValueOnce({
      reclassified: 200,
      affectedHours: new Map(),
      saturated: true,
    });

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

    expect(meta.nullPriceBacklogRecent).toBe(12);
    expect(meta.nullPriceBacklogHistorical).toBe(45);
    expect(meta.roundtripsBacklogSaturated).toBe(true);
    expect(meta.atomicRoundtripsDetected).toBe(2);
  });

  it("emits budgetUsed and budgetLimit in metadata via withBudgetMetadata", async () => {
    const db = makeDb();

    const result = await syncMintBurn(db, "alchemy-key");
    const meta = JSON.parse(result.metadata);

    expect(meta.budgetLimit).toBe(200);
    expect(typeof meta.budgetUsed).toBe("number");
    expect(meta.budgetUsed).toBeGreaterThanOrEqual(0);
    expect(meta.budgetUsed).toBeLessThanOrEqual(meta.budgetLimit);
  });

  it("downgrades to degraded and flags metadata when recalcAffectedHours throws", async () => {
    const db = makeDb();

    vi.mocked(fetchAlchemyLogs)
      .mockResolvedValueOnce({ logs: [makeMintLog()], complete: true, scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 })
      .mockResolvedValueOnce({ logs: [], complete: true, scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 })
      .mockResolvedValueOnce({ logs: [], complete: true, scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 });

    vi.mocked(resolveBlockTimestamps).mockResolvedValueOnce(new Map([[22_000_000, 1_718_650_752]]));
    // Insert path must succeed so affectedHours gets populated before recalc runs.
    vi.mocked(batchExecute)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);

    vi.mocked(recalcAffectedHours).mockRejectedValueOnce(new Error("D1 timeout during hourly recalc"));

    const result = await syncMintBurn(db, "alchemy-key");
    const meta = JSON.parse(result.metadata);

    expect(vi.mocked(recalcAffectedHours)).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("degraded");
    expect(meta.recalcFailed).toBe(true);
    expect(typeof meta.recalcError).toBe("string");
    expect(meta.recalcError).toContain("D1 timeout during hourly recalc");
  });
});
