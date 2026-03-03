import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

// --- Module-level mocks ---

// Stub mint-burn contracts to minimal configs (2 contracts)
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
      events: [
        {
          signature: "Transfer(address,address,uint256)",
          topicHash: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          direction: "mint",
          amountEncoding: "transfer-value",
          filterTopic: { index: 1, value: "0x0000000000000000000000000000000000000000000000000000000000000000" },
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
      events: [
        {
          signature: "Transfer(address,address,uint256)",
          topicHash: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          direction: "mint",
          amountEncoding: "transfer-value",
          filterTopic: { index: 1, value: "0x0000000000000000000000000000000000000000000000000000000000000000" },
        },
      ],
    },
  ],
}));

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

// Stub db helpers
vi.mock("../../lib/db", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../lib/db")>();
  return {
    ...orig,
    batchExecute: vi.fn(async () => {}),
  };
});

// Stub chains module
vi.mock("../../../../src/lib/chains", () => ({
  CHAIN_META: {
    ethereum: { name: "Ethereum", evmChainId: 1, explorerUrl: "https://etherscan.io", type: "evm" },
  },
}));

import { syncMintBurn } from "../sync-mint-burn";
import { batchExecute } from "../../lib/db";
import { getAlchemyBlockNumber, fetchAlchemyLogs, resolveBlockTimestamps } from "../../lib/alchemy-logs";

// --- Helpers ---

function makeDb() {
  return mockD1([
    { match: "mint_burn_sync_state", rows: [] },
    { match: "mint_burn_events", rows: [] },
    { match: "mint_burn_hourly", rows: [] },
    { match: "price_cache", rows: [{ asset_id: "1", price: 1.0 }, { asset_id: "2", price: 0.999 }] },
  ]);
}

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

describe("syncMintBurn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
    vi.mocked(getAlchemyBlockNumber).mockReset().mockResolvedValue(22000000);
    vi.mocked(fetchAlchemyLogs).mockReset().mockResolvedValue([]);
    vi.mocked(resolveBlockTimestamps).mockReset().mockResolvedValue(new Map());
    vi.mocked(batchExecute).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("parses mint events and writes to DB on normal path", async () => {
    const db = makeDb();

    // First config (USDT) returns one mint log, second (USDC) returns empty
    vi.mocked(fetchAlchemyLogs)
      .mockResolvedValueOnce([makeMintLog()])
      .mockResolvedValueOnce([]);
    vi.mocked(resolveBlockTimestamps).mockResolvedValueOnce(
      new Map([[22000000, 1718650752]])
    );

    const result = await syncMintBurn(db, "alchemy-key");

    expect(result.itemCount).toBe(1);
    const meta = JSON.parse(result.metadata);
    expect(meta.contractsProcessed).toBe(2);
    expect(meta.apiErrors).toBe(0);
    // batchExecute should have been called for event insert + hourly aggregation
    expect(batchExecute).toHaveBeenCalled();
  });

  it("isolates per-contract errors — one contract fails, other succeeds", async () => {
    const db = makeDb();

    // First config (USDT) — API error (null logs)
    vi.mocked(fetchAlchemyLogs)
      .mockResolvedValueOnce(null as unknown as never[])
      // Second config (USDC) — one event
      .mockResolvedValueOnce([makeMintLog({ txHash: "0xdef456" })]);
    // resolveBlockTimestamps is only called for USDC (USDT errored before reaching it)
    vi.mocked(resolveBlockTimestamps)
      .mockResolvedValueOnce(new Map([[22000000, 1718650752]]));

    const result = await syncMintBurn(db, "alchemy-key");

    // USDC event should be processed despite USDT failure
    expect(result.itemCount).toBe(1);
    const meta = JSON.parse(result.metadata);
    expect(meta.apiErrors).toBe(1);
    expect(meta.contractsProcessed).toBe(2);
  });

  it("rejects when chain head fetch fails", async () => {
    const db = makeDb();

    // Chain head returns null — total failure
    vi.mocked(getAlchemyBlockNumber).mockResolvedValue(null);

    await expect(syncMintBurn(db, "alchemy-key")).rejects.toThrow("Failed to get Ethereum chain head");
  });

  it("rejects when ALCHEMY_API_KEY is missing", async () => {
    const db = makeDb();
    await expect(syncMintBurn(db, null)).rejects.toThrow("No ALCHEMY_API_KEY configured");
  });

  it("skips contracts when fromBlock exceeds chain head", async () => {
    const db = mockD1([
      // Both configs already synced past chain head
      {
        match: "mint_burn_sync_state",
        rows: [{ last_block: 22000001 }],
      },
      { match: "mint_burn_events", rows: [] },
      { match: "mint_burn_hourly", rows: [] },
      { match: "price_cache", rows: [{ asset_id: "1", price: 1.0 }, { asset_id: "2", price: 0.999 }] },
    ]);

    const result = await syncMintBurn(db, "alchemy-key");

    expect(result.itemCount).toBe(0);
    const meta = JSON.parse(result.metadata);
    expect(meta.contractsSkipped).toBe(2);
    // No fetch should have been attempted
    expect(vi.mocked(fetchAlchemyLogs)).not.toHaveBeenCalled();
  });

  it("recalculates affected hourly buckets after inserting events", async () => {
    const db = makeDb();

    vi.mocked(fetchAlchemyLogs).mockResolvedValueOnce([
      makeMintLog(),
      makeMintLog({ txHash: "0xsecond", logIndex: 1 }),
    ]).mockResolvedValueOnce([]);
    vi.mocked(resolveBlockTimestamps).mockResolvedValueOnce(
      new Map([[22000000, 1718650000]])
    );

    const result = await syncMintBurn(db, "alchemy-key");

    expect(result.itemCount).toBe(2);
    // batchExecute called at least twice: once for event inserts, once for hourly aggregation
    expect(vi.mocked(batchExecute).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
