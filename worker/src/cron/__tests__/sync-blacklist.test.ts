import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

// --- Module-level mocks ---

// Stub blacklist-contracts to provide a minimal set of configs
vi.mock("../../lib/blacklist-contracts", () => ({
  CONTRACT_CONFIGS: [
    {
      configKey: "ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      chain: {
        chainId: "ethereum",
        chainName: "Ethereum",
        evmChainId: 1,
        explorerUrl: "https://etherscan.io",
        type: "evm",
      },
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
    },
    {
      configKey: "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      chain: {
        chainId: "base",
        chainName: "Base",
        evmChainId: 8453,
        explorerUrl: "https://basescan.org",
        type: "evm",
      },
      stablecoin: "USDC",
      contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      decimals: 6,
      events: [
        {
          signature: "Blacklisted(address)",
          topicHash: "0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855",
          eventType: "blacklist",
          hasAmount: false,
        },
      ],
    },
    {
      configKey: "tron-tr7nhqjekqxgtci8q8zy4pl8otszgjlj6t",
      chain: {
        chainId: "tron",
        chainName: "Tron",
        evmChainId: null,
        explorerUrl: "https://tronscan.org",
        type: "tron",
      },
      stablecoin: "USDT",
      contractAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      decimals: 6,
      events: [
        {
          signature: "AddedBlackList(address)",
          topicHash: "0x42e160154868087d6bfdc0ca23d96a1c1cfa32f1b72ba9c306f83367e8cfd27b",
          eventType: "blacklist",
          hasAmount: false,
        },
      ],
    },
  ],
  getBlacklistTopicHashes: (config: { events: Array<{ topicHash: string }> }) =>
    [...new Set(config.events.map((event) => event.topicHash))],
  getBlacklistEventByTopic: (
    config: { events: Array<{ topicHash: string; signature: string; eventType: string; hasAmount: boolean }> },
    topicHash: string | null | undefined,
  ) => topicHash ? config.events.find((event) => event.topicHash.toLowerCase() === topicHash.toLowerCase()) : undefined,
  getBlacklistEventBySignature: (
    config: { events: Array<{ signature: string; eventType: string; hasAmount: boolean }> },
    signature: string | null | undefined,
  ) => signature ? config.events.find((event) => event.signature === signature || event.signature.split("(")[0] === signature) : undefined,
}));

vi.mock("../../lib/alchemy-logs", () => ({
  fetchAlchemyLogs: vi.fn(async () => ({ logs: [], complete: true, scannedToBlock: 20000000, calls: 1, maxDepth: 0 })),
  getAlchemyBlockNumber: vi.fn(async () => 20000000),
  resolveBlockTimestamps: vi.fn(async () => new Map()),
}));

// Stub evm-logs — heavy EVM interaction primitives
vi.mock("../../lib/evm-logs", () => ({
  createBudget: vi.fn((limit = 900) => ({ count: 0, limit })),
  budgetExhausted: vi.fn((b: { count: number; limit: number }) => b.count >= b.limit),
  createRateLimiter: vi.fn(
    () =>
      async <T>(fn: () => Promise<T>) =>
        fn(),
  ),
  decodeAddress: vi.fn((hex: string) => "0x" + hex.slice(-40)),
  decodeUint256: vi.fn(() => 1000000),
  getEvmBlockNumber: vi.fn(async () => 20000000),
  fetchEvmLogsForTopic: vi.fn(async () => []),
  fetchEvmLogsForTopics: vi.fn(async () => []),
}));

vi.mock("../../lib/chain-registry", () => ({
  getChainRpc: vi.fn((_chainRpcs: Map<string, unknown>, chainId: string) =>
    chainId === "base"
      ? {
          chainId: "base",
          chainName: "Base",
          type: "evm",
          rpcUrl: "https://base-rpc.example",
          explorerUrl: "https://basescan.org",
        }
      : undefined,
  ),
}));

// Stub bigint helper
vi.mock("../../lib/bigint", () => ({
  bigIntToDecimal: vi.fn((value: bigint, decimals: number) => Number(value) / Math.pow(10, decimals)),
}));

// Stub db helpers
vi.mock("../../lib/db", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../lib/db")>();
  return {
    ...orig,
    getLastBlock: vi.fn(async () => 0),
    setLastBlock: vi.fn(async () => {}),
    batchExecute: vi.fn(async (_db, stmts: D1PreparedStatement[]) => stmts.length),
  };
});

// Stub chains module (used by blacklist-contracts)
vi.mock("@shared/lib/chains", () => ({
  CHAIN_META: {
    ethereum: { name: "Ethereum", evmChainId: 1, explorerUrl: "https://etherscan.io", type: "evm" },
    tron: { name: "Tron", evmChainId: null, explorerUrl: "https://tronscan.org", type: "tron" },
  },
}));

import { syncBlacklist, type SyncBlacklistOptions } from "../sync-blacklist";
import { fetchEvmLogsForTopic, getEvmBlockNumber } from "../../lib/evm-logs";
import { getLastBlock, setLastBlock, batchExecute } from "../../lib/db";
import { fetchAlchemyLogs, getAlchemyBlockNumber, resolveBlockTimestamps } from "../../lib/alchemy-logs";
import { getChainRpc, type ChainRpcConfig } from "../../lib/chain-registry";
import { CONTRACT_CONFIGS } from "../../lib/blacklist-contracts";

// --- Helpers ---

const testChainRpcs = new Map<string, ChainRpcConfig>([
  ["base", {
    chainId: "base",
    chainName: "Base",
    type: "evm",
    rpcUrl: "https://base-rpc.example",
    explorerUrl: "https://basescan.org",
  }],
]);

function buildTestOpts(overrides: Partial<SyncBlacklistOptions> = {}): SyncBlacklistOptions {
  return {
    db: makeDb(),
    etherscanApiKey: "etherscan-key",
    trongridApiKey: "tron-key",
    drpcApiKey: null,
    chainRpcs: testChainRpcs,
    ...overrides,
  };
}

function makeDb() {
  return mockD1([
    { match: "blacklist_sync_state", rows: [] },
    { match: "blacklist_events", rows: [] },
  ]);
}

describe("syncBlacklist", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
    // Reset mocks to defaults
    vi.mocked(getLastBlock).mockResolvedValue(0);
    vi.mocked(setLastBlock).mockResolvedValue(undefined);
    vi.mocked(batchExecute).mockImplementation(async (_db, stmts) => stmts.length);
    vi.mocked(fetchEvmLogsForTopic).mockResolvedValue([]);
    vi.mocked(getEvmBlockNumber).mockResolvedValue(20000000);
    vi.mocked(fetchAlchemyLogs).mockResolvedValue({
      logs: [],
      complete: true,
      scannedToBlock: 20000000,
      calls: 1,
      maxDepth: 0,
    });
    vi.mocked(getAlchemyBlockNumber).mockResolvedValue(20000000);
    vi.mocked(resolveBlockTimestamps).mockResolvedValue(new Map());
    vi.mocked(getChainRpc).mockImplementation((_chainRpcs: Map<string, unknown>, chainId: string) =>
      chainId === "base"
        ? {
            chainId: "base",
            chainName: "Base",
            type: "evm",
            rpcUrl: "https://base-rpc.example",
            explorerUrl: "https://basescan.org",
          }
        : undefined,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("processes events and writes to DB on normal path", async () => {
    const db = makeDb();

    // Simulate EVM logs for the USDC config — one blacklist event
    vi.mocked(fetchEvmLogsForTopic).mockResolvedValueOnce([
      {
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        topics: [
          "0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855",
          "0x000000000000000000000000abcdef1234567890abcdef1234567890abcdef12",
        ],
        data: "0x",
        blockNumber: "0x1312d00", // 20,000,000
        timeStamp: "0x6670a780", // 1718650752
        transactionHash: "0xabc123",
        logIndex: "0x0",
      },
    ]);

    // Stub global fetch for Tron API (returns empty events)
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    const result = await syncBlacklist(buildTestOpts({ db }));

    // Should have found the 1 EVM event
    expect(result.itemCount).toBe(1);
    const meta = JSON.parse(result.metadata);
    expect(meta.apiErrors).toBe(0);
    expect(meta.rowsWritten).toBe(1);
    expect(meta.eventsFetched).toBe(1);
    // batchExecute should have been called to insert the event row
    expect(batchExecute).toHaveBeenCalled();
  });

  it("isolates per-chain errors — Etherscan 429 does not block Tron", async () => {
    const db = makeDb();

    // Simulate Etherscan returning null (API error) for the EVM config
    vi.mocked(fetchEvmLogsForTopic).mockResolvedValueOnce(null as unknown as never[]);

    // Tron fetch succeeds with one event for AddedBlackList only
    const fetchMock = vi.fn(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("trongrid.io/v1/contracts") && urlStr.includes("event_name=AddedBlackList")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                block_number: 50000000,
                block_timestamp: 1718650752000,
                transaction_id: "tx-tron-1",
                event_index: 0,
                event_name: "AddedBlackList",
                result: { _user: "0xdeadbeef" },
              },
            ],
            meta: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (urlStr.includes("trongrid.io/v1/contracts")) {
        // Other Tron event names return empty
        return new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Etherscan balance/block fetches — success with dummy data
      if (urlStr.includes("etherscan.io")) {
        return new Response(JSON.stringify({ result: "0x1312d00" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Default: TronGrid account lookups
      return new Response(JSON.stringify({ success: true, data: [{ trc20: [] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncBlacklist(buildTestOpts({ db }));

    // Tron event should be processed despite EVM failure
    expect(result.itemCount).toBe(1);
    const meta = JSON.parse(result.metadata);
    // The EVM config had an API error (null logs) — recorded but did not crash
    expect(meta.apiErrors).toBe(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/v1/accounts/"))).toBe(false);
  });

  it("returns zero events when all APIs return empty", async () => {
    const db = makeDb();

    vi.mocked(fetchEvmLogsForTopic).mockResolvedValue([]);

    // Tron API returns empty
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    const result = await syncBlacklist(buildTestOpts({ db }));

    expect(result.itemCount).toBe(0);
    const meta = JSON.parse(result.metadata);
    expect(meta.apiErrors).toBe(0);
    expect(meta.rowsWritten).toBe(0);
    expect(meta.eventsFetched).toBe(0);
  });

  it("stops cleanly before the cron wrapper timeout when runtime budget is nearly exhausted", async () => {
    const db = makeDb();

    vi.mocked(fetchEvmLogsForTopic)
      .mockImplementationOnce(async () => {
        vi.setSystemTime(new Date("2025-06-15T12:06:30Z"));
        return [];
      })
      .mockResolvedValue([]);

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    const result = await syncBlacklist(buildTestOpts({ db }));

    expect(result.status).toBe("degraded");
    const meta = JSON.parse(result.metadata);
    expect(meta.runtimeBudgetReached).toBe(true);
    expect(meta.contractsSkipped).toBeGreaterThan(0);
  });

  it("advances sync state for EVM chains toward chain head when no events", async () => {
    const db = makeDb();

    vi.mocked(fetchEvmLogsForTopic).mockResolvedValue([]);
    vi.mocked(getEvmBlockNumber).mockResolvedValue(20000000);

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    await syncBlacklist(buildTestOpts({ db }));

    // setLastBlock should be called for both configs (EVM advances to chain head - safety margin)
    expect(setLastBlock).toHaveBeenCalled();
  });

  it("falls back to RPC log scans for paid-only Etherscan chains", async () => {
    const db = makeDb();

    vi.mocked(fetchAlchemyLogs).mockResolvedValueOnce({
      logs: [
        {
          address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
          topics: [
            "0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855",
            "0x000000000000000000000000abcdef1234567890abcdef1234567890abcdef12",
          ],
          data: "0x",
          blockNumber: "0x1312d00",
          transactionHash: "0xbase123",
          transactionIndex: "0x0",
          blockHash: "0xblockhash",
          logIndex: "0x0",
          removed: false,
        },
      ],
      complete: true,
      scannedToBlock: 20000000,
      calls: 1,
      maxDepth: 0,
    });
    vi.mocked(resolveBlockTimestamps).mockResolvedValueOnce(new Map([[20000000, 1718650752]]));

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    const result = await syncBlacklist(buildTestOpts({ db }));

    expect(result.itemCount).toBe(1);
    const meta = JSON.parse(result.metadata);
    expect(meta.apiErrors).toBe(0);
    expect(meta.rpcLogConfigs).toBeGreaterThanOrEqual(1);
  });

  it("tries chain RPC after a dRPC miss for non-mainnet balance enrichment", async () => {
    const db = makeDb();

    vi.mocked(fetchAlchemyLogs).mockResolvedValueOnce({
      logs: [
        {
          address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
          topics: [
            "0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855",
            "0x000000000000000000000000abcdef1234567890abcdef1234567890abcdef12",
          ],
          data: "0x",
          blockNumber: "0x1312d00",
          transactionHash: "0xbase123",
          transactionIndex: "0x0",
          blockHash: "0xblockhash",
          logIndex: "0x0",
          removed: false,
        },
      ],
      complete: true,
      scannedToBlock: 20000000,
      calls: 1,
      maxDepth: 0,
    });
    vi.mocked(resolveBlockTimestamps).mockResolvedValueOnce(new Map([[20000000, 1718650752]]));
    const fetchMock = vi.fn(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("lb.drpc.org")) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("base-rpc.example")) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: "0x0000000000000000000000000000000000000000000000000000000000000000",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncBlacklist(buildTestOpts({ db, drpcApiKey: "drpc-key" }));

    expect(result.itemCount).toBe(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("lb.drpc.org"))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("base-rpc.example"))).toBe(true);
  });

  it("orders backfill work newest-first so recent gaps are not starved by old backlog", async () => {
    const db = makeDb();

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    await syncBlacklist(buildTestOpts({ db }));

    const backfillQuery = db.getHistory().find((entry) =>
      entry.sql.includes("FROM blacklist_events")
      && entry.sql.includes("amount_status IN")
      && entry.sql.includes("LIMIT ?"),
    );
    expect(backfillQuery?.sql).toContain("ORDER BY timestamp DESC");
  });

  it("advances the cursor after partial RPC coverage instead of restarting from zero", async () => {
    const db = makeDb();

    vi.mocked(getLastBlock).mockImplementation(async (_db, configKey: string) =>
      configKey.startsWith("base-") ? 0 : 100,
    );
    vi.mocked(fetchEvmLogsForTopic).mockResolvedValue([]);
    vi.mocked(fetchAlchemyLogs).mockResolvedValueOnce({
      logs: [],
      complete: false,
      scannedToBlock: 12345,
      calls: 9,
      maxDepth: 3,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    const result = await syncBlacklist(buildTestOpts({ db }));

    expect(result.itemCount).toBe(0);
    const meta = JSON.parse(result.metadata);
    expect(meta.apiErrors).toBe(1);
    expect(meta.apiErrorConfigs).toEqual([
      expect.objectContaining({
        configKey: "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        stablecoin: "USDC",
        chainId: "base",
        reason: "partial-coverage",
      }),
    ]);
    expect(meta.zeroCursorConfigs).toContain("base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    expect(setLastBlock).toHaveBeenCalledWith(db, "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", 12345);
  });

  it("uses configured startBlock and bounded RPC scan windows for zero-cursor configs", async () => {
    const db = makeDb();
    const baseConfig = CONTRACT_CONFIGS.find((config) => config.chain.chainId === "base");
    expect(baseConfig).toBeDefined();
    const previousStartBlock = baseConfig?.startBlock;
    if (!baseConfig) return;

    baseConfig.startBlock = 1_000_000;
    vi.mocked(getLastBlock).mockImplementation(async (_db, configKey: string) =>
      configKey.startsWith("base-") ? 0 : 100,
    );
    vi.mocked(fetchEvmLogsForTopic).mockResolvedValue([]);
    vi.mocked(fetchAlchemyLogs).mockResolvedValueOnce({
      logs: [],
      complete: true,
      scannedToBlock: 1_049_999,
      calls: 1,
      maxDepth: 0,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    try {
      await syncBlacklist(buildTestOpts({ db }));

      const baseCalls = vi.mocked(fetchAlchemyLogs).mock.calls
        .filter((call) => call[1] === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
      const baseCall = baseCalls[baseCalls.length - 1];
      expect(baseCall?.[3]).toBe(1_000_000);
      expect(baseCall?.[4]).toBe(1_049_999);
      expect(setLastBlock).toHaveBeenCalledWith(db, "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", 1_049_999);
    } finally {
      baseConfig.startBlock = previousStartBlock;
    }
  });
});
