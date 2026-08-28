import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 as createMockD1 } from "@shared/test-utils/mock-d1";
import { mockFetch } from "@shared/test-utils/mock-fetch";

function installFetch(implementation: (request: Request) => Response | Promise<Response>) {
  return mockFetch([{ match: () => true, respond: implementation }]);
}

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
      stablecoinId: "usdc-circle",
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
      stablecoinId: "usdc-circle",
      stablecoin: "USDC",
      contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      decimals: 6,
      startBlock: 19950001,
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
      stablecoinId: "usdt-tether",
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
  getBlacklistTopicHashes: (config: { events: Array<{ topicHash: string }> }) => [
    ...new Set(config.events.map((event) => event.topicHash)),
  ],
  getBlacklistEventByTopic: (
    config: { events: Array<{ topicHash: string; signature: string; eventType: string; hasAmount: boolean }> },
    topicHash: string | null | undefined,
  ) =>
    topicHash ? config.events.find((event) => event.topicHash.toLowerCase() === topicHash.toLowerCase()) : undefined,
  getBlacklistEventBySignature: (
    config: { events: Array<{ signature: string; eventType: string; hasAmount: boolean }> },
    signature: string | null | undefined,
  ) =>
    signature
      ? config.events.find((event) => event.signature === signature || event.signature.split("(")[0] === signature)
      : undefined,
  getBlacklistConfigsForSymbolAndChain: () => [],
}));

vi.mock("../../lib/alchemy-logs", () => ({
  fetchAlchemyLogs: vi.fn(async () => ({ logs: [], complete: true, scannedToBlock: 20000000, calls: 1, maxDepth: 0 })),
  getAlchemyBlockNumber: vi.fn(async () => 20010000),
  resolveBlockTimestamps: vi.fn(async () => new Map()),
}));

// Stub evm-logs — heavy EVM interaction primitives
vi.mock("../../lib/evm-logs", () => ({
  createBudget: vi.fn((limit = 900) => ({ count: 0, limit })),
  budgetExhausted: vi.fn((b: { count: number; limit: number }) => b.count >= b.limit),
  createRateLimiter: vi.fn((requestsPerSecond: number) =>
    Object.assign(async <T>(fn: () => Promise<T>) => fn(), { requestsPerSecond }),
  ),
  decodeAddress: vi.fn((hex: string) => "0x" + hex.slice(-40)),
  decodeAddressWord: vi.fn((hex: string | null | undefined) =>
    typeof hex === "string" && /^(0x)?[0-9a-fA-F]{64}$/.test(hex) ? "0x" + hex.slice(-40) : null,
  ),
  decodeUint256: vi.fn(() => 1000000),
  decodeUint256Word: vi.fn((hex: string | null | undefined) =>
    typeof hex === "string" && /^(0x)?[0-9a-fA-F]{64}$/.test(hex) ? 1000000 : null,
  ),
  decodeUint256AtSlotOrNull: vi.fn(() => 1000000),
  getEvmBlockNumber: vi.fn(async () => 20010000),
  fetchEvmLogsForTopic: vi.fn(async () => []),
  fetchEvmLogsForTopicWithCompleteness: vi.fn(async () => ({
    logs: [],
    complete: true,
    scannedToBlock: 99999999,
    calls: 1,
    maxDepth: 0,
  })),
  readDataWord: vi.fn((hex: string, slotIndex: number) => {
    const cleaned = hex.startsWith("0x") ? hex.slice(2) : hex;
    const start = slotIndex * 64;
    return cleaned.length >= start + 64 ? "0x" + cleaned.slice(start, start + 64) : null;
  }),
}));

vi.mock("../../lib/chain-registry", () => ({
  getAlchemyAuthHeaders: () => undefined,
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
  decimalNumberFromBigInt: vi.fn((value: bigint, decimals: number) => Number(value) / Math.pow(10, decimals)),
}));

// Stub db helpers
vi.mock("../../lib/db", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../lib/db")>();
  return {
    ...orig,
    batchExecute: vi.fn(async (_db, stmts: D1PreparedStatement[]) => stmts.length),
  };
});

// Stub chains module (used by blacklist-contracts)
vi.mock("@shared/lib/chains", () => ({
  CHAIN_META: {
    ethereum: { name: "Ethereum", evmChainId: 1, explorerUrl: "https://etherscan.io", type: "evm" },
    tron: { name: "Tron", evmChainId: null, explorerUrl: "https://tronscan.org", type: "tron" },
  },
  resolveChainId: (chain: string) => chain.trim().toLowerCase(),
  normalizeChainId: (chain: string) => chain.trim().toLowerCase(),
}));

import { syncBlacklist, type SyncBlacklistOptions } from "../sync-blacklist";
import { createRateLimiter, fetchEvmLogsForTopicWithCompleteness, getEvmBlockNumber } from "../../lib/evm-logs";
import type { EtherscanLogEntry, EvmLogFetchResult } from "../../lib/evm-logs";
import { batchExecute } from "../../lib/db";
import { fetchAlchemyLogs, getAlchemyBlockNumber, resolveBlockTimestamps } from "../../lib/alchemy-logs";
import { getChainRpc, type ChainRpcConfig } from "../../lib/chain-registry";
import { CONTRACT_CONFIGS } from "../../lib/blacklist-contracts";

function mockD1(tables: Parameters<typeof createMockD1>[0] = []) {
  return createMockD1([
    ...tables,
    { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
    { match: "INSERT OR REPLACE INTO cache", rows: [] },
    { match: "FROM blacklist_current_balances", rows: [] },
    { match: "INSERT INTO blacklist_current_balances", rows: [] },
    { match: "UPDATE blacklist_current_balances", rows: [] },
    { match: "DELETE FROM blacklist_current_balances", rows: [] },
    { match: "FROM blacklist_amount_repair_queue", rows: [] },
    { match: "FROM blacklist_reconciliation_runs", rows: [], first: null },
    { match: "blacklist-amount-repair-queue-", rows: [] },
    { match: "blacklist-amount-recovery-evm-candidates", rows: [] },
    { match: "UPDATE blacklist_events", rows: [] },
    { match: "INSERT OR IGNORE INTO blacklist_events", rows: [] },
    { match: "blacklist-summary-snapshot-write", rows: [] },
    { match: "blacklist-gap-metrics-cache-write", rows: [] },
  ]);
}

// --- Helpers ---

const testChainRpcs = new Map<string, ChainRpcConfig>([
  [
    "base",
    {
      chainId: "base",
      chainName: "Base",
      type: "evm",
      rpcUrl: "https://base-rpc.example",
      explorerUrl: "https://basescan.org",
    },
  ],
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

function makeDb(syncStateRows: Record<string, unknown>[] = []) {
  return mockD1([
    { match: "blacklist_sync_state", rows: syncStateRows },
    { match: "blacklist_events", rows: [] },
  ]);
}

function findStateFinalization(db: ReturnType<typeof makeDb>, configKey: string) {
  return db
    .getHistory()
    .find((entry) => entry.sql.includes("blacklist-state-finalize") && entry.binds[16] === configKey);
}

function completeEtherscanLogs(logs: EtherscanLogEntry[] = []): EvmLogFetchResult {
  return { logs, complete: true, scannedToBlock: 99999999, calls: 1, maxDepth: 0 };
}

function failedEtherscanLogs(): EvmLogFetchResult {
  return {
    logs: [],
    complete: false,
    scannedToBlock: -1,
    calls: 1,
    maxDepth: 0,
    failureReason: "test-failure",
  };
}

describe("syncBlacklist", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
    vi.clearAllMocks();
    // Reset mocks to defaults
    vi.mocked(batchExecute).mockImplementation(async (_db, stmts) => stmts.length);
    vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockResolvedValue(completeEtherscanLogs());
    vi.mocked(getEvmBlockNumber).mockResolvedValue(20010000);
    vi.mocked(fetchAlchemyLogs).mockResolvedValue({
      logs: [],
      complete: true,
      scannedToBlock: 20000000,
      calls: 1,
      maxDepth: 0,
    });
    vi.mocked(getAlchemyBlockNumber).mockResolvedValue(20010000);
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
    vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockResolvedValueOnce(
      completeEtherscanLogs([
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
      ]),
    );

    // Stub global fetch for Tron API (returns empty events)
    installFetch(async () => new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

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

  it("skips enrichment and cache work for rows already present in blacklist_events", async () => {
    const duplicateId = "ethereum-0xdup123-0x0";
    const db = mockD1([
      { match: "blacklist_sync_state", rows: [] },
      { match: "SELECT id FROM blacklist_events WHERE id IN", rows: [{ id: duplicateId }] },
      { match: "blacklist_events", rows: [] },
    ]);

    vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockResolvedValueOnce(
      completeEtherscanLogs([
        {
          address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          topics: [
            "0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855",
            "0x000000000000000000000000abcdef1234567890abcdef1234567890abcdef12",
          ],
          data: "0x",
          blockNumber: "0x1312d00",
          timeStamp: "0x6670a780",
          transactionHash: "0xdup123",
          logIndex: "0x0",
        },
      ]),
    );

    installFetch(async () => new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const result = await syncBlacklist(buildTestOpts({ db }));

    expect(result.itemCount).toBe(0);
    const meta = JSON.parse(result.metadata);
    expect(meta.rowsWritten).toBe(0);
    expect(meta.eventsFetched).toBe(1);
    expect(meta.enrichAttempted).toBe(0);
    expect(meta.currentBalanceCacheUpdated).toBe(0);
  });

  it("reports the provider limiter rates actually in use, not the producer default", async () => {
    const db = makeDb();

    installFetch(async () => new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    // The scheduled slot injects a faster Etherscan limiter than the producer's
    // own default; TronGrid keeps the default. Metadata must show both.
    const result = await syncBlacklist(
      buildTestOpts({ db, externalEtherscanRL: createRateLimiter(4) }),
    );
    const meta = JSON.parse(result.metadata);

    expect(meta.etherscanLimiterRequestsPerSecond).toBe(4);
    expect(meta.tronLimiterRequestsPerSecond).toBe(3);
  });

  it("falls back to the producer default Etherscan rate when no limiter is injected", async () => {
    const db = makeDb();

    installFetch(async () => new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const result = await syncBlacklist(buildTestOpts({ db }));
    const meta = JSON.parse(result.metadata);

    expect(meta.etherscanLimiterRequestsPerSecond).toBe(3);
    expect(meta.tronLimiterRequestsPerSecond).toBe(3);
  });

  it("records thrown config scan exceptions and continues the sync", async () => {
    const db = makeDb();
    vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockRejectedValueOnce(new TypeError("explorer down"));

    installFetch(async () => new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const result = await syncBlacklist(buildTestOpts({ db }));
    const meta = JSON.parse(result.metadata);

    expect(meta.apiErrors).toBe(1);
    expect(meta.apiErrorClasses.TypeError).toBe(1);
    expect(fetchEvmLogsForTopicWithCompleteness).toHaveBeenCalled();
  });

  it("isolates per-chain errors — Etherscan 429 does not block Tron", async () => {
    const db = makeDb();

    // Simulate Etherscan returning null (API error) for the EVM config
    vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockResolvedValueOnce(failedEtherscanLogs());

    // Tron fetch succeeds with one event for AddedBlackList only
    const fetchMock = installFetch(async (url: string | Request) => {
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
    const result = await syncBlacklist(buildTestOpts({ db }));

    // Tron event should be processed despite EVM failure
    expect(result.itemCount).toBe(1);
    const meta = JSON.parse(result.metadata);
    // The EVM config had an API error (null logs) — recorded but did not crash
    expect(meta.apiErrors).toBe(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("trongrid.io"))).toBe(true);
  });

  it("runs Tron and RPC-primary configs when the Etherscan circuit is open", async () => {
    const openedAt = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          {
            key: "circuit:etherscan",
            value: JSON.stringify({
              state: "open",
              consecutiveFailures: 3,
              lastFailureAt: openedAt,
              lastSuccessAt: null,
              openedAt,
            }),
          },
        ],
      },
      { match: "blacklist_sync_state", rows: [] },
      { match: "blacklist_events", rows: [] },
    ]);

    const fetchMock = installFetch(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("trongrid.io/v1/contracts") && urlStr.includes("event_name=AddedBlackList")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                block_number: 50000000,
                block_timestamp: 1718650752000,
                transaction_id: "tx-tron-circuit",
                event_index: 0,
                event_name: "AddedBlackList",
                result: { _user: "0x00000000000000000000000000000000000000cd" },
              },
            ],
            meta: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const result = await syncBlacklist(buildTestOpts({ db }));
    const meta = JSON.parse(result.metadata);

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(1);
    expect(meta.etherscanCircuitSkips).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("trongrid.io"))).toBe(true);
    expect(fetchEvmLogsForTopicWithCompleteness).not.toHaveBeenCalled();
    expect(fetchAlchemyLogs).toHaveBeenCalled();
  });

  it("marks TronGrid circuit-open skips as degraded instead of successful completion", async () => {
    const openedAt = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          {
            key: "circuit:trongrid",
            value: JSON.stringify({
              state: "open",
              consecutiveFailures: 3,
              lastFailureAt: openedAt,
              lastSuccessAt: null,
              openedAt,
            }),
          },
        ],
      },
      { match: "blacklist_sync_state", rows: [] },
      { match: "blacklist_events", rows: [] },
    ]);
    const fetchMock = installFetch(
      async (_url: string | Request) =>
        new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const result = await syncBlacklist(buildTestOpts({ db }));
    const meta = JSON.parse(result.metadata);

    expect(result.status).toBe("degraded");
    expect(meta.tronGridCircuitSkips).toBe(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("trongrid.io/v1/contracts"))).toBe(false);
  });

  it("reapplies the Tron ledger mirror after refreshing current balances", async () => {
    const db = makeDb();

    vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockResolvedValue(completeEtherscanLogs());

    installFetch(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("trongrid.io/v1/contracts") && urlStr.includes("event_name=AddedBlackList")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                block_number: 50000000,
                block_timestamp: 1718650752000,
                transaction_id: "tx-tron-ledger-1",
                event_index: 0,
                event_name: "AddedBlackList",
                result: { _user: "0x00000000000000000000000000000000000000ab" },
              },
            ],
            meta: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (urlStr.includes("trongrid.io/v1/contracts")) {
        return new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("api.trongrid.io/jsonrpc")) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: "0x00000000000000000000000000000000000000000000000000000000000f4240",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    await syncBlacklist(buildTestOpts({ db }));

    const history = db.getHistory();
    const tronLedgerMirrorRuns = history.filter((entry) =>
      entry.sql.includes("blacklist-tron-ledger-backfill-candidates"),
    );
    const currentBalanceUpserts = history.filter((entry) =>
      entry.sql.includes("INSERT INTO blacklist_current_balances"),
    );

    expect(currentBalanceUpserts.length).toBeGreaterThan(0);
    expect(tronLedgerMirrorRuns).toHaveLength(1);
  });

  it("returns zero events when all APIs return empty", async () => {
    const db = makeDb(
      CONTRACT_CONFIGS.map((config) => ({
        config_key: config.configKey,
        last_block: 0,
        cursor_value: 0,
        attempt_generation: 1,
        last_succeeded_at: Math.floor(Date.now() / 1000) - 60,
      })),
    );

    vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockResolvedValue(completeEtherscanLogs());

    // Tron API returns empty
    installFetch(async () => new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const result = await syncBlacklist(buildTestOpts({ db }));

    expect(result.itemCount).toBe(0);
    const meta = JSON.parse(result.metadata);
    expect(meta.apiErrors).toBe(0);
    expect(meta.rowsWritten).toBe(0);
    expect(meta.eventsFetched).toBe(0);
    expect(meta.producerGapMetricSnapshots).toBe(2);
    expect(meta.producerSummarySnapshot).toBe(true);
    expect(db.getHistory().some((entry) => entry.sql.includes("blacklist-summary-snapshot-write"))).toBe(true);
  });

  it("stops cleanly before the cron wrapper timeout when runtime budget is nearly exhausted", async () => {
    const db = makeDb();

    vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockResolvedValue(completeEtherscanLogs());

    installFetch(async () => {
        vi.setSystemTime(new Date("2025-06-15T12:09:30Z"));
        return new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

    const result = await syncBlacklist(buildTestOpts({ db }));

    expect(result.status).toBe("degraded");
    const meta = JSON.parse(result.metadata);
    expect(meta.runtimeBudgetReached).toBe(true);
    expect(meta.contractsSkipped).toBeGreaterThan(0);
    expect(meta.producerSnapshotSkipped).toBe(true);
    expect(db.getHistory().some((entry) => entry.sql.includes("blacklist-summary-snapshot-write"))).toBe(false);
  });

  it("uses the bounded maintenance tail to repair queued amounts after scan exhaustion", async () => {
    const db = mockD1([
      { match: "blacklist_sync_state", rows: [] },
      {
        match: "blacklist-amount-recovery-evm-candidates",
        rows: [{
          id: "repair-row-1",
          chain_id: "ethereum",
          event_type: "blacklist",
          address: "0x1111111111111111111111111111111111111111",
          block_number: 100,
          stablecoin: "USDC",
          tx_hash: "0xrepair",
          config_key: null,
          contract_address: null,
          amount_attempt_count: 0,
          amount_last_attempted_at: null,
          amount_last_error_class: null,
          amount_last_provider: null,
          amount_source: "unavailable",
          queue_attempt_count: 0,
        }],
      },
      { match: "blacklist_events", rows: [] },
    ]);

    vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockResolvedValue(completeEtherscanLogs());
    vi.mocked(fetchAlchemyLogs).mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2025-06-15T12:10:05Z"));
      return {
        logs: [],
        complete: true,
        scannedToBlock: 20000000,
        calls: 1,
        maxDepth: 0,
      };
    });
    installFetch(async () => new Response(JSON.stringify({ result: "0x0000000000000000000000000000000000000000000000000000000000989680" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const result = await syncBlacklist(buildTestOpts({ db }));
    const meta = JSON.parse(result.metadata);

    expect(result.status).toBe("degraded");
    expect(meta.runtimeBudgetReached).toBe(true);
    expect(meta.amountRepairTailWindowUsed).toBe(true);
    expect(meta.amountRepairTailLimit).toBe(10);
    expect(meta.amountRepairAttempted).toBe(1);
    expect(meta.amountRepairResolved).toBe(0);
    expect(meta.amountRepairRetried).toBe(1);
    expect(meta.maintenanceRuntimeBudgetMs).toBe(645_000);
    const candidateQuery = db.getHistory().find((entry) =>
      entry.sql.includes("blacklist-amount-recovery-evm-candidates"),
    );
    expect(candidateQuery?.binds).toEqual([3, 10]);
  });

  it("degrades a one-contract runtime tail and withholds producer snapshots", async () => {
    const db = makeDb();

    vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockResolvedValue(completeEtherscanLogs());
    vi.mocked(fetchAlchemyLogs).mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2025-06-15T12:09:30Z"));
      return {
        logs: [],
        complete: true,
        scannedToBlock: 20000000,
        calls: 1,
        maxDepth: 0,
      };
    });

    installFetch(async () => new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const result = await syncBlacklist(buildTestOpts({ db }));

    expect(result.status).toBe("degraded");
    const meta = JSON.parse(result.metadata);
    expect(meta.runtimeBudgetReached).toBe(true);
    expect(meta.contractsSkipped).toBe(1);
    expect(meta.incompleteRuntimeConfigs).toBe(0);
    expect(meta.subrequestBudgetReached).toBe(false);
    expect(meta.producerSnapshotWindowUnavailable).toBe(false);
    expect(meta.producerSnapshotSkipped).toBe(true);
    expect(db.getHistory().some((entry) => entry.sql.includes("blacklist-summary-snapshot-write"))).toBe(false);
  });

  it("records producer snapshot materialization errors without failing an otherwise healthy run", async () => {
    const db = mockD1([
      { match: "blacklist_sync_state", rows: [] },
      { match: "blacklist_events", rows: [] },
      { match: "blacklist-gap-metrics-cache-write", rows: [], throwError: new Error("snapshot write failed") },
    ]);
    const onProgress = vi.fn();

    vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockResolvedValue(completeEtherscanLogs());
    installFetch(async () => new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const result = await syncBlacklist(buildTestOpts({ db, onProgress }));

    expect(result.status).toBe("ok");
    const meta = JSON.parse(result.metadata);
    expect(meta.producerSnapshotError).toBe("Error");
    expect(meta.producerGapMetricSnapshots).toBe(0);
    expect(meta.producerSummarySnapshot).toBe(false);
    expect(meta.producerSnapshotSkipped).toBe(false);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "producer-snapshots",
        message: "Failed to materialize blacklist producer snapshots",
        metadata: expect.objectContaining({
          producerSnapshotError: "Error",
          errorMessage: "snapshot write failed",
        }),
      }),
    );
  });

  it("advances sync state for EVM chains toward chain head when no events", async () => {
    const db = makeDb();

    vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockResolvedValue(completeEtherscanLogs());
    vi.mocked(getEvmBlockNumber).mockResolvedValue(20000000);

    installFetch(async () => new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await syncBlacklist(buildTestOpts({ db }));

    const baseFinalization = findStateFinalization(db, "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    const ethereumFinalization = findStateFinalization(db, "ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(baseFinalization?.binds[0]).toBeGreaterThan(19_950_000);
    expect(ethereumFinalization?.binds[0]).toBeGreaterThan(0);
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

    installFetch(async () => new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

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
    const fetchMock = installFetch(async (url: string | Request) => {
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
    const result = await syncBlacklist(buildTestOpts({ db, drpcApiKey: "drpc-key" }));

    expect(result.itemCount).toBe(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("lb.drpc.org"))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("base-rpc.example"))).toBe(true);
  });

  it("orders backfill work newest-first so recent gaps are not starved by old backlog", async () => {
    const db = makeDb();

    installFetch(async () => new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await syncBlacklist(buildTestOpts({ db }));

    const backfillQuery = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("FROM blacklist_events") &&
          entry.sql.includes("amount_status IN") &&
          entry.sql.includes("LIMIT ?"),
      );
    expect(backfillQuery?.sql).toContain("timestamp DESC");
  });

  it("advances the cursor after partial RPC coverage instead of restarting from zero", async () => {
    const db = makeDb();

    vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockResolvedValue(completeEtherscanLogs());
    vi.mocked(fetchAlchemyLogs).mockResolvedValueOnce({
      logs: [],
      complete: false,
      scannedToBlock: 19_960_000,
      calls: 9,
      maxDepth: 3,
    });

    installFetch(async () => new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

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
    const finalization = findStateFinalization(db, "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    expect(finalization?.binds[0]).toBe(19_960_000);
    expect(finalization?.binds[11]).toBe("partial");
  });

  it("does not advance a shared Etherscan cursor when one configured topic fails", async () => {
    const db = makeDb();
    const ethereumConfig = CONTRACT_CONFIGS.find((config) => config.chain.chainId === "ethereum");
    expect(ethereumConfig).toBeDefined();
    if (!ethereumConfig) return;

    const previousEvents = ethereumConfig.events;
    const firstEvent = previousEvents[0];
    expect(firstEvent).toBeDefined();
    if (!firstEvent) return;
    ethereumConfig.events = [
      ...previousEvents,
      {
        signature: "UnBlacklisted(address)",
        topicHash: "0x117e3210bb9aa7d9baff172026820255c6f6c30ba8999d1c2fd88e2848137c4e",
        eventType: "unblacklist",
        hasAmount: false,
      },
    ];

    vi.mocked(fetchEvmLogsForTopicWithCompleteness)
      .mockResolvedValueOnce(
        completeEtherscanLogs([
          {
            address: ethereumConfig.contractAddress,
            topics: [firstEvent.topicHash, "0x000000000000000000000000abcdef1234567890abcdef1234567890abcdef12"],
            data: "0x",
            blockNumber: "0xc8",
            timeStamp: "0x6670a780",
            transactionHash: "0xpartial-topic",
            logIndex: "0x0",
          },
        ]),
      )
      .mockResolvedValueOnce(failedEtherscanLogs())
      .mockResolvedValue(completeEtherscanLogs());

    installFetch(async () => new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    try {
      const result = await syncBlacklist(buildTestOpts({ db }));
      const meta = JSON.parse(result.metadata);

      expect(meta.apiErrors).toBe(1);
      expect(meta.eventsFetched).toBe(0);
      const finalization = findStateFinalization(db, "ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
      expect(finalization?.binds[0]).toBe(0);
      expect(finalization?.binds[11]).toBe("missing_topic");
    } finally {
      ethereumConfig.events = previousEvents;
    }
  });

  it("advances a multi-topic RPC cursor after one complete OR-topic scan", async () => {
    const db = makeDb();
    const baseConfig = CONTRACT_CONFIGS.find((config) => config.chain.chainId === "base");
    expect(baseConfig).toBeDefined();
    if (!baseConfig) return;

    const previousEvents = baseConfig.events;
    baseConfig.events = [
      ...previousEvents,
      {
        signature: "UnBlacklisted(address)",
        topicHash: "0x117e3210bb9aa7d9baff172026820255c6f6c30ba8999d1c2fd88e2848137c4e",
        eventType: "unblacklist",
        hasAmount: false,
      },
    ];

    vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockResolvedValue(completeEtherscanLogs());
    vi.mocked(fetchAlchemyLogs).mockImplementationOnce(
      async (_rpcUrl, _contractAddress, _topics, _fromBlock, _toBlock, budget) => {
        budget.count = budget.limit;
        return {
          logs: [],
          complete: true,
          scannedToBlock: 19_960_000,
          calls: 1,
          maxDepth: 0,
        };
      },
    );

    installFetch(async () => new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    try {
      const result = await syncBlacklist(buildTestOpts({ db }));
      const meta = JSON.parse(result.metadata);

      expect(result.status).toBe("degraded");
      expect(meta.runtimeBudgetReached).toBe(true);
      expect(meta.subrequestBudgetReached).toBe(true);
      expect(fetchAlchemyLogs).toHaveBeenCalledTimes(1);
      const finalization = findStateFinalization(db, "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
      expect(finalization?.binds[0]).toBe(19_960_000);
      expect(finalization?.binds[11]).toBe("quiet");
      expect(vi.mocked(fetchAlchemyLogs).mock.calls[0]?.[2]).toEqual([
        {
          index: 0,
          value: [
            "0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855",
            "0x117e3210bb9aa7d9baff172026820255c6f6c30ba8999d1c2fd88e2848137c4e",
          ],
        },
      ]);
    } finally {
      baseConfig.events = previousEvents;
    }
  });

  it("uses configured startBlock and bounded RPC scan windows for zero-cursor configs", async () => {
    const db = makeDb();
    const baseConfig = CONTRACT_CONFIGS.find((config) => config.chain.chainId === "base");
    expect(baseConfig).toBeDefined();
    const previousStartBlock = baseConfig?.startBlock;
    if (!baseConfig) return;

    baseConfig.startBlock = 1_000_000;
    vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockResolvedValue(completeEtherscanLogs());
    vi.mocked(fetchAlchemyLogs).mockResolvedValueOnce({
      logs: [],
      complete: true,
      scannedToBlock: 1_049_999,
      calls: 1,
      maxDepth: 0,
    });

    installFetch(async () => new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    try {
      await syncBlacklist(buildTestOpts({ db }));

      const baseCalls = vi
        .mocked(fetchAlchemyLogs)
        .mock.calls.filter((call) => call[1] === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
      const baseCall = baseCalls[baseCalls.length - 1];
      expect(baseCall?.[3]).toBe(1_000_000);
      expect(baseCall?.[4]).toBe(1_049_999);
      const finalization = findStateFinalization(db, "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
      expect(finalization?.binds[0]).toBe(1_049_999);
    } finally {
      baseConfig.startBlock = previousStartBlock;
    }
  });
});
