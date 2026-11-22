import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockD1Preset } from "@shared/test-utils/mock-d1";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import type * as AlchemyLogsModule from "../../lib/alchemy-logs";
import type * as AmountRecoveryModule from "../../lib/blacklist/amount-recovery";
import type * as TronAmountRecoveryModule from "../../lib/blacklist/tron-amount-recovery";
import type * as TronOrderRecoveryModule from "../../lib/blacklist/tron-order-recovery";

const sqliteFixtures = createLatestSchemaFixtureTracker();

function installFetch(implementation: (request: Request) => Response | Promise<Response>) {
  return mockFetch([{ match: () => true, respond: implementation }]);
}

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const emptyTronResponse = () => jsonResp({ success: true, data: [] });

vi.mock("../../lib/blacklist-contracts", () => ({
  CONTRACT_CONFIGS: [
    {
      configKey: "ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      chain: { chainId: "ethereum", chainName: "Ethereum", evmChainId: 1, explorerUrl: "https://etherscan.io", type: "evm" },
      stablecoinId: "usdc-circle", stablecoin: "USDC",
      contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6,
      events: [{ signature: "Blacklisted(address)", topicHash: "0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855", eventType: "blacklist", hasAmount: false }],
    },
    {
      configKey: "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      chain: { chainId: "base", chainName: "Base", evmChainId: 8453, explorerUrl: "https://basescan.org", type: "evm" },
      stablecoinId: "usdc-circle", stablecoin: "USDC",
      contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6, startBlock: 19950001,
      events: [{ signature: "Blacklisted(address)", topicHash: "0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855", eventType: "blacklist", hasAmount: false }],
    },
    {
      configKey: "tron-tr7nhqjekqxgtci8q8zy4pl8otszgjlj6t",
      chain: { chainId: "tron", chainName: "Tron", evmChainId: null, explorerUrl: "https://tronscan.org", type: "tron" },
      stablecoinId: "usdt-tether", stablecoin: "USDT",
      contractAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6,
      events: [{ signature: "AddedBlackList(address)", topicHash: "0x42e160154868087d6bfdc0ca23d96a1c1cfa32f1b72ba9c306f83367e8cfd27b", eventType: "blacklist", hasAmount: false }],
    },
  ],
  getBlacklistTopicHashes: (config: { events: Array<{ topicHash: string }> }) => [...new Set(config.events.map((e) => e.topicHash))],
  getBlacklistEventByTopic: (
    config: { events: Array<{ topicHash: string; signature: string; eventType: string; hasAmount: boolean }> },
    topicHash: string | null | undefined,
  ) => (topicHash ? config.events.find((e) => e.topicHash.toLowerCase() === topicHash.toLowerCase()) : undefined),
  getBlacklistEventBySignature: (
    config: { events: Array<{ signature: string; eventType: string; hasAmount: boolean }> },
    signature: string | null | undefined,
  ) => (signature ? config.events.find((e) => e.signature === signature || e.signature.split("(")[0] === signature) : undefined),
  getBlacklistConfigsForSymbolAndChain: () => [],
  getBlacklistConfigByContract: () => undefined,
}));

vi.mock("../../lib/blacklist/amount-recovery", async (importOriginal) => {
  const actual = await importOriginal<typeof AmountRecoveryModule>();
  return { ...actual, backfillAmounts: vi.fn(actual.backfillAmounts) };
});
vi.mock("../../lib/blacklist/tron-amount-recovery", async (importOriginal) => {
  const actual = await importOriginal<typeof TronAmountRecoveryModule>();
  return { ...actual, backfillTronBlacklistAmounts: vi.fn(actual.backfillTronBlacklistAmounts) };
});
vi.mock("../../lib/blacklist/tron-order-recovery", async (importOriginal) => {
  const actual = await importOriginal<typeof TronOrderRecoveryModule>();
  return { ...actual, resolveTronBlacklistOrder: vi.fn(actual.resolveTronBlacklistOrder) };
});
vi.mock("../../lib/blacklist-gaps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/blacklist-gaps")>();
  return { ...actual, materializeBlacklistGapMetrics: vi.fn(actual.materializeBlacklistGapMetrics) };
});
vi.mock("../../lib/alchemy-logs", async (importOriginal) => ({
  ...(await importOriginal<typeof AlchemyLogsModule>()),
  fetchAlchemyLogs: vi.fn(async () => ({ logs: [], complete: true, scannedToBlock: 20000000, calls: 1, maxDepth: 0 })),
  getAlchemyBlockNumber: vi.fn(async () => 20000450),
  resolveBlockTimestamps: vi.fn(async () => new Map()),
}));

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
    logs: [], complete: true, scannedToBlock: 99999999, calls: 1, maxDepth: 0,
  })),
  readDataWord: vi.fn((hex: string, slotIndex: number) => {
    const cleaned = hex.startsWith("0x") ? hex.slice(2) : hex;
    const start = slotIndex * 64;
    return cleaned.length >= start + 64 ? "0x" + cleaned.slice(start, start + 64) : null;
  }),
}));

vi.mock("../../lib/chain-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/chain-registry")>()),
  getChainRpc: vi.fn((_chainRpcs: Map<string, unknown>, chainId: string) =>
    chainId === "base" ? baseChainRpcConfig() : undefined,
  ),
}));

function baseChainRpcConfig(): ChainRpcConfig {
  return {
    chainId: "base", chainName: "Base", type: "evm", explorerUrl: "https://basescan.org",
    endpoints: [{ url: "https://base-rpc.example", operator: "public", keyed: false, position: "registry", stateHistory: "archive", logsHistory: "full" }],
  };
}

vi.mock("../../lib/bigint", () => ({
  decimalNumberFromBigInt: vi.fn((value: bigint, decimals: number) => Number(value) / Math.pow(10, decimals)),
}));
vi.mock("../../lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/db")>()),
  batchExecute: vi.fn(async (_db, stmts: D1PreparedStatement[]) => stmts.length),
}));
vi.mock("@shared/types/chain-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shared/types/chain-identity")>()),
  CHAIN_META: {
    ethereum: { name: "Ethereum", evmChainId: 1, explorerUrl: "https://etherscan.io", type: "evm" },
    tron: { name: "Tron", evmChainId: null, explorerUrl: "https://tronscan.org", type: "tron" },
  },
  resolveChainId: (chain: string) => chain.trim().toLowerCase(),
  normalizeChainId: (chain: string) => chain.trim().toLowerCase(),
}));

import { compactCronMetadataForPersistence, getCronMetadataBudgetBytes } from "../../lib/cron-metadata-persistence";
import { syncBlacklist, type SyncBlacklistOptions } from "../sync-blacklist";
import { fetchEvmLogsForTopicWithCompleteness, getEvmBlockNumber } from "../../lib/evm-logs";
import type { EtherscanLogEntry, EvmLogFetchResult } from "../../lib/evm-logs";
import { batchExecute } from "../../lib/db";
import { fetchAlchemyLogs, getAlchemyBlockNumber, resolveBlockTimestamps } from "../../lib/alchemy-logs";
import { getChainRpc, type ChainRpcConfig } from "../../lib/chain-registry";
import { CONTRACT_CONFIGS } from "../../lib/blacklist-contracts";
import { BLACKLIST_COVERAGE_LAG_TOLERANCE_BLOCKS } from "../blacklist/config-scan";
import { backfillAmounts } from "../../lib/blacklist/amount-recovery";
import { backfillTronBlacklistAmounts } from "../../lib/blacklist/tron-amount-recovery";
import { resolveTronBlacklistOrder } from "../../lib/blacklist/tron-order-recovery";
import * as tronReplayProvider from "../../lib/blacklist/tron-replay-provider";
import { invalidateBlacklistDerivedCaches } from "../../lib/blacklist-cache-invalidation";
import { materializeBlacklistGapMetrics } from "../../lib/blacklist-gaps";
import { handleBlacklistSummary, materializeBlacklistSummarySnapshot } from "../../lib/blacklist-summary-service";
import { BLACKLIST_SUMMARY_SNAPSHOT_CACHE_KEY } from "../../lib/blacklist-cache-keys";

const BLACKLISTED_TOPIC = "0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855";
const UNBLACKLISTED_TOPIC = "0x117e3210bb9aa7d9baff172026820255c6f6c30ba8999d1c2fd88e2848137c4e";
const TOPIC_USER = "0x000000000000000000000000abcdef1234567890abcdef1234567890abcdef12";
const ETH_USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const mockD1 = createMockD1Preset([
  { match: "blacklist-summary-fence-capture", rows: [], first: { generation: null, summaryValue: null, rollbackValue: null, rollbackUpdatedAt: null } },
  { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
  { match: "SELECT value FROM cache WHERE key = ?", rows: [], first: null },
  { match: "blacklist:decode-retry:", rows: [] },
  { match: "INSERT INTO cache", rows: [] },
  { match: "DELETE FROM cache WHERE key = ?", rows: [] },
  { match: "FROM blacklist_current_balances", rows: [] },
  { match: "INSERT INTO blacklist_current_balances", rows: [] },
  { match: "UPDATE blacklist_current_balances", rows: [] },
  { match: "DELETE FROM blacklist_current_balances", rows: [] },
  { match: "FROM blacklist_amount_repair_queue", rows: [] },
  { match: "FROM blacklist_reconciliation_runs", rows: [], first: null },
  { match: "blacklist-amount-repair-queue-", rows: [] },
  { match: "blacklist-amount-recovery-evm-candidates", rows: [] },
  { match: "blacklist-tron-replay-candidates", rows: [] },
  { match: "UPDATE blacklist_events", rows: [] },
  { match: "INSERT OR IGNORE INTO blacklist_events", rows: [] },
  { match: "blacklist-summary-snapshot-write", rows: [] },
  { match: "blacklist-gap-metrics-cache-write", rows: [] },
]);

const testChainRpcs = new Map<string, ChainRpcConfig>([["base", baseChainRpcConfig()]]);

function buildTestOpts(overrides: Partial<SyncBlacklistOptions> = {}): SyncBlacklistOptions {
  return {
    db: makeDb(), etherscanApiKey: "etherscan-key", trongridApiKey: "tron-key",
    drpcApiKey: null, chainRpcs: testChainRpcs, ...overrides,
  };
}

function makeDb(syncStateRows: Record<string, unknown>[] = [], tables: Parameters<typeof mockD1>[0] = []) {
  return mockD1([
    ...tables,
    { match: "blacklist-gap-aggregate", rows: [], first: {
      total: 0, missing: null, missing_recent: null, oldest_gap_age_sec: null,
      never_attempted: null, repeated_failures: null, unrecoverable: null,
    } },
    { match: "blacklist-summary-public-aggregate", rows: [], first: {
      total: 0, max_ts: null, recent_30d: null, recent_24h: null, freeze_24h: null,
      freeze_7d: null, freeze_usd_24h: null, freeze_usd_7d: null, freeze_known_24h: null, freeze_known_7d: null,
    } },
    { match: "blacklist-summary-latest-event-type-history", rows: [] },
    { match: "blacklist_sync_state", rows: syncStateRows },
    { match: "blacklist_events", rows: [] },
  ]);
}

function openCircuitDb(circuitKey: string, openedAt: number) {
  return mockD1([
    {
      match: "FROM cache WHERE key = ?", matchBinds: [circuitKey],
      rows: [{
        key: circuitKey, updated_at: openedAt,
        value: JSON.stringify({ state: "open", consecutiveFailures: 3, lastFailureAt: openedAt, lastSuccessAt: null, openedAt }),
      }],
    },
    { match: "blacklist_sync_state", rows: [] },
    { match: "blacklist_events", rows: [] },
  ]);
}

async function runSync(overrides: Partial<SyncBlacklistOptions> = {}) {
  const result = await syncBlacklist(buildTestOpts(overrides));
  return { result, meta: JSON.parse(result.metadata) };
}

function findStateFinalization(db: ReturnType<typeof makeDb>, configKey: string) {
  return db.getHistory().find((e) => e.sql.includes("blacklist-state-finalize") && e.binds[16] === configKey);
}

const completeEtherscanLogs = (logs: EtherscanLogEntry[] = []): EvmLogFetchResult => ({
  logs, complete: true, scannedToBlock: 99999999, calls: 1, maxDepth: 0,
});
const failedEtherscanLogs = (): EvmLogFetchResult => ({
  logs: [], complete: false, scannedToBlock: -1, calls: 1, maxDepth: 0, failureReason: "test-failure",
});

function makeEvmLog(overrides: Partial<EtherscanLogEntry> = {}): EtherscanLogEntry {
  return {
    address: ETH_USDC, topics: [BLACKLISTED_TOPIC, TOPIC_USER], data: "0x",
    blockNumber: "0x1312d00", timeStamp: "0x6670a780", transactionHash: "0x" + "ab".repeat(32), logIndex: "0x0",
    ...overrides,
  };
}

function makeAlchemyLog() {
  return {
    address: BASE_USDC, topics: [BLACKLISTED_TOPIC, TOPIC_USER], data: "0x",
    blockNumber: "0x1312d00", transactionHash: "0x" + "ba".repeat(32),
    transactionIndex: "0x0", blockHash: "0xblockhash", logIndex: "0x0", removed: false,
  };
}

function makeTronEventResponse(txByte: string, user: string) {
  return jsonResp({
    success: true,
    data: [{
      block_number: 50000000, block_timestamp: 1718650752000, transaction_id: txByte.repeat(32),
      event_index: 0, event_name: "AddedBlackList", result: { _user: user },
    }],
    meta: {},
  });
}

describe("syncBlacklist", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
    vi.clearAllMocks();
    vi.mocked(batchExecute).mockImplementation(async (_db, stmts) => stmts.length);
    vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockResolvedValue(completeEtherscanLogs());
    vi.mocked(getEvmBlockNumber).mockResolvedValue(20010000);
    vi.mocked(fetchAlchemyLogs).mockResolvedValue({ logs: [], complete: true, scannedToBlock: 20000000, calls: 1, maxDepth: 0 });
    vi.mocked(getAlchemyBlockNumber).mockResolvedValue(20000450);
    vi.mocked(resolveBlockTimestamps).mockResolvedValue(new Map());
    vi.mocked(getChainRpc).mockImplementation((_chainRpcs: Map<string, unknown>, chainId: string) =>
      chainId === "base" ? baseChainRpcConfig() : undefined,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    sqliteFixtures.closeAll();
  });

  it.each(["scan", "gaps", "own", "foreign-before", "foreign-after", "crash"])(
    "fences producer publication across %s interleaving in SQLite", async (phase) => {
      const { sqlite, db } = sqliteFixtures.open();
      sqlite.function("unixepoch", () => Math.floor(Date.now() / 1000));
      const now = Math.floor(Date.now() / 1000);
      const actualDb = await vi.importActual<typeof import("../../lib/db")>("../../lib/db");
      const actualGaps = await vi.importActual<typeof import("../../lib/blacklist-gaps")>("../../lib/blacklist-gaps");
      const actualOrder = await vi.importActual<typeof TronOrderRecoveryModule>("../../lib/blacklist/tron-order-recovery");
      vi.mocked(batchExecute).mockImplementation(actualDb.batchExecute);
      installFetch(async () => new Response(JSON.stringify({ success: true, data: [] })));
      await materializeBlacklistSummarySnapshot(db, now, now);
      const invalidate = vi.fn(() => invalidateBlacklistDerivedCaches(db));
      const stored = () => sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(BLACKLIST_SUMMARY_SNAPSHOT_CACHE_KEY);
      if (!["scan", "gaps"].includes(phase)) {
        const insert = sqlite.prepare(`INSERT INTO blacklist_events
          (id, stablecoin, chain_id, chain_name, event_type, address, tx_hash, block_number,
           timestamp, config_key, amount_status, explorer_tx_url, explorer_address_url)
          VALUES (?, 'USDT', 'tron', 'Tron', ?, '0x00000000000000000000000000000000000000ab', ?, 1, ?, ?,
            'permanently_unavailable', '', '')`);
        for (const [index, event] of ["blacklist", "unblacklist"].entries()) {
          insert.run(`order-${index}`, event, String(index).repeat(64), now - 3600, CONTRACT_CONFIGS[2].configKey);
        }
        vi.spyOn(tronReplayProvider, "fetchTronBlockTransactionPositions").mockResolvedValue({
          timestamp: now - 3600, positions: new Map([["0".repeat(64), 0], ["1".repeat(64), 1]]),
        });
      }
      if (phase === "scan") {
        vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockImplementationOnce(async () => {
          await invalidate();
          return completeEtherscanLogs();
        });
      }
      if (phase === "gaps" || phase === "crash") {
        vi.mocked(materializeBlacklistGapMetrics).mockImplementationOnce(async (...args) => {
          if (phase === "crash") throw new Error("producer stopped after repair rotation");
          const result = await actualGaps.materializeBlacklistGapMetrics(...args);
          await invalidate();
          return result;
        });
      }
      vi.mocked(resolveTronBlacklistOrder).mockImplementationOnce(async (...args) => {
        if (phase === "foreign-before") await invalidate();
        const result = await actualOrder.resolveTronBlacklistOrder(...args);
        if (phase === "foreign-after") await invalidate();
        return result;
      });
      const { result, meta } = await runSync({ db });
      expect(invalidate).toHaveBeenCalledTimes(phase === "own" || phase === "crash" ? 0 : 1);
      if (phase === "own" || phase === "crash") {
        expect(meta.tronOrderPositionsResolved).toBe(2);
        expect(sqlite.prepare("SELECT value FROM cache WHERE key = 'blacklist:derived-generation'").get()).toBeDefined();
        expect(sqlite.prepare("SELECT transaction_index FROM blacklist_events ORDER BY id").all())
          .toEqual([{ transaction_index: 0 }, { transaction_index: 1 }]);
        expect(meta.producerSummarySnapshot).toBe(phase === "own");
        if (phase === "crash") {
          expect(stored()).toBeUndefined();
          expect((await handleBlacklistSummary(db)).status).toBe(200);
          expect(stored()).toBeDefined();
        }
      } else {
        expect(meta).toMatchObject({ producerSummarySnapshot: false, producerSnapshotReason: "superseded", reason: "superseded" });
        expect(result.status).toBe("degraded");
        expect(stored()).toBeUndefined();
      }
    },
  );

  it("processes events and writes to DB on normal path", async () => {
    vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockResolvedValueOnce(completeEtherscanLogs([makeEvmLog()]));
    installFetch(emptyTronResponse);
    const { result, meta } = await runSync();

    expect(result.itemCount).toBe(1);
    expect(meta).toMatchObject({
      apiErrors: 0, rowsWritten: 1, eventsFetched: 1,
      currentBalanceCacheSkippedDueBudget: 0, currentBalanceCacheBudgetExhausted: false,
    });
    expect(meta).not.toHaveProperty("currentBalanceCacheDeleted");
    expect(meta).not.toHaveProperty("tronLedgerUpdated");
    expect(batchExecute).toHaveBeenCalled();
  });

  it("skips enrichment and cache work for rows already present in blacklist_events", async () => {
    const duplicateId = `ethereum-0x${"de".repeat(32)}-0x0`;
    const db = mockD1([
      { match: "blacklist_sync_state", rows: [] },
      { match: "SELECT id FROM blacklist_events WHERE id IN", rows: [{ id: duplicateId }] },
      { match: "blacklist_events", rows: [] },
    ]);
    vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockResolvedValueOnce(
      completeEtherscanLogs([makeEvmLog({ transactionHash: "0x" + "de".repeat(32) })]),
    );
    installFetch(emptyTronResponse);
    const { result, meta } = await runSync({ db });

    expect(result.itemCount).toBe(0);
    expect(meta).toMatchObject({ rowsWritten: 0, eventsFetched: 1, enrichAttempted: 0, currentBalanceCacheUpdated: 0 });
  });

  it("records thrown config scan exceptions and continues the sync", async () => {
    vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockRejectedValueOnce(new TypeError("explorer down"));
    installFetch(emptyTronResponse);
    const { meta } = await runSync();

    expect(meta.apiErrors).toBe(1);
    expect(meta.apiErrorClasses.TypeError).toBe(1);
    expect(fetchEvmLogsForTopicWithCompleteness).toHaveBeenCalled();
  });

  it("isolates per-chain errors — Etherscan 429 does not block Tron", async () => {
    vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockResolvedValueOnce(failedEtherscanLogs());
    const fetchMock = installFetch(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("trongrid.io/v1/contracts") && urlStr.includes("event_name=AddedBlackList")) {
        return makeTronEventResponse("ab", "0x" + "de".repeat(20));
      }
      if (urlStr.includes("trongrid.io/v1/contracts")) return emptyTronResponse();
      if (urlStr.includes("etherscan.io")) return jsonResp({ result: "0x1312d00" });
      return jsonResp({ success: true, data: [{ trc20: [] }] });
    });
    const { result, meta } = await runSync();

    expect(result.itemCount).toBe(1);
    expect(meta.apiErrors).toBe(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("trongrid.io"))).toBe(true);
  });

  it("runs Tron and RPC-primary configs when the Etherscan circuit is open", async () => {
    const db = openCircuitDb("circuit:etherscan", Math.floor(Date.now() / 1000));
    const fetchMock = installFetch(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("trongrid.io/v1/contracts") && urlStr.includes("event_name=AddedBlackList")) {
        return makeTronEventResponse("cd", "0x00000000000000000000000000000000000000cd");
      }
      return emptyTronResponse();
    });
    const { result, meta } = await runSync({ db });

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(1);
    expect(meta.etherscanCircuitSkips).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("trongrid.io"))).toBe(true);
    expect(fetchEvmLogsForTopicWithCompleteness).not.toHaveBeenCalled();
    expect(fetchAlchemyLogs).toHaveBeenCalled();
  });

  it("marks TronGrid circuit-open skips as degraded instead of successful completion", async () => {
    const db = openCircuitDb("circuit:trongrid", Math.floor(Date.now() / 1000));
    const fetchMock = installFetch(emptyTronResponse);
    const { result, meta } = await runSync({ db });

    expect(result.status).toBe("degraded");
    expect(meta.tronGridCircuitSkips).toBeGreaterThan(0);
    expect(meta).toMatchObject({
      tronAmountRepairOutcome: "skipped", tronAmountRepairReason: "provider-circuit-open",
      tronOrderOutcome: "skipped", tronAmountRepairAttempted: null, tronAmountRepairLimit: null, tronOrderBlocksAttempted: null,
    });
    expect(db.getHistory().some((e) => e.sql.includes("blacklist-tron-replay-candidates"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("trongrid.io/v1/contracts"))).toBe(false);
  });

  it("keeps a historical Tron event unresolved after refreshing its current balance", async () => {
    const { sqlite } = sqliteFixtures.open();
    const history: string[] = [];
    const db = createSqliteD1(sqlite, { onRun: (sql) => history.push(sql), onAll: (sql) => history.push(sql) });
    const actualDb = await vi.importActual<typeof import("../../lib/db")>("../../lib/db");
    vi.mocked(batchExecute).mockImplementation(actualDb.batchExecute);

    installFetch(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("trongrid.io/v1/contracts") && urlStr.includes("event_name=AddedBlackList")) {
        return makeTronEventResponse("ef", "0x00000000000000000000000000000000000000ab");
      }
      if (urlStr.includes("api.trongrid.io/jsonrpc")) {
        return jsonResp({ jsonrpc: "2.0", id: 1, result: "0x00000000000000000000000000000000000000000000000000000000000f4240" });
      }
      return emptyTronResponse();
    });
    await syncBlacklist(buildTestOpts({ db }));

    expect(history.findIndex((sql) => sql.includes("INSERT INTO blacklist_current_balances"))).toBeGreaterThanOrEqual(0);
    expect(sqlite.prepare("SELECT amount_native, amount_usd_at_event, amount_source, amount_status FROM blacklist_events WHERE tx_hash = ?").all("ef".repeat(32))).toEqual([{
      amount_native: null, amount_usd_at_event: null, amount_source: "unavailable", amount_status: "recoverable_pending",
    }]);
    expect(sqlite.prepare("SELECT amount_native, amount_usd FROM blacklist_current_balances WHERE chain_id = 'tron'").all()).toEqual([{
      amount_native: 1, amount_usd: 1,
    }]);
  });

  it.each([
    { error: "D1_ERROR: internal error; reference = transient", failures: 1, attempts: 2, recovers: true },
    { error: "D1_ERROR: internal error; reference = persistent", failures: 4, attempts: 4, recovers: false },
    { error: "D1_ERROR: no such table: cache", failures: 1, attempts: 1, recovers: false },
  ])("handles final decode diagnostics failure: $error", async ({ error, failures, attempts, recovers }) => {
    const diagnosticFixture = {
      match: "blacklist:decode-retry:",
      rows: [{ configKey: CONTRACT_CONFIGS[0].configKey, count: 2 }],
      throwError: undefined as Error | undefined,
    };
    const db = makeDb([], [diagnosticFixture]);
    const prepare = db.prepare.bind(db);
    let diagnosticAttempts = 0;
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (sql.includes("blacklist:decode-retry:")) {
        diagnosticFixture.throwError = ++diagnosticAttempts <= failures ? new Error(error) : undefined;
      }
      return prepare(sql);
    });
    installFetch(emptyTronResponse);

    const outcomePromise = syncBlacklist(buildTestOpts({ db })).then(
      (result) => ({ result, error: null }),
      (caught: unknown) => ({ result: null, error: caught }),
    );
    await vi.runAllTimersAsync();
    const outcome = await outcomePromise;
    if (recovers) {
      expect(outcome.error).toBeNull();
      expect(outcome.result?.status).toBe("ok");
      expect(JSON.parse(outcome.result!.metadata)).toMatchObject({
        configsSucceeded: CONTRACT_CONFIGS.length, decodeRetryCounts: { [CONTRACT_CONFIGS[0].configKey]: 2 },
      });
    } else {
      expect(outcome.result).toBeNull();
      expect(outcome.error).toEqual(new Error(error));
    }
    expect(diagnosticAttempts).toBe(attempts);
  });

  it("returns zero events when all APIs return empty", async () => {
    const db = makeDb(CONTRACT_CONFIGS.map((c) => ({
      config_key: c.configKey, last_block: 0, cursor_value: 0,
      attempt_generation: 1, last_succeeded_at: Math.floor(Date.now() / 1000) - 60,
    })));
    installFetch(emptyTronResponse);
    const { result, meta } = await runSync({ db });

    expect(result.itemCount).toBe(0);
    expect(meta).toMatchObject({
      apiErrors: 0, rowsWritten: 0, eventsFetched: 0, producerGapMetricSnapshots: 2, producerSummarySnapshot: true,
    });
    expect(db.getHistory().some((e) => e.sql.includes("blacklist-summary-snapshot-write"))).toBe(true);
  });

  it.each([
    { lag: 52, expectedStatus: "ok" },
    { lag: BLACKLIST_COVERAGE_LAG_TOLERANCE_BLOCKS, expectedStatus: "ok" },
    { lag: BLACKLIST_COVERAGE_LAG_TOLERANCE_BLOCKS + 1, expectedStatus: "degraded" },
  ])("uses the measured lag tolerance for run status ($lag blocks)", async ({ lag, expectedStatus }) => {
    const priorSuccess = Math.floor(Date.now() / 1000) - 3600;
    const db = makeDb(CONTRACT_CONFIGS.map((c) => ({
      config_key: c.configKey,
      last_block: c.chain.chainId === "base" ? 19_950_000 - lag : 0,
      cursor_value: c.chain.chainId === "base" ? 19_950_000 - lag : 0,
      attempt_generation: 1, last_succeeded_at: priorSuccess,
    })));
    vi.mocked(fetchAlchemyLogs).mockResolvedValueOnce({ logs: [], complete: true, scannedToBlock: 20_000_000 - lag, calls: 1, maxDepth: 0 });
    installFetch(emptyTronResponse);
    const { result, meta } = await runSync({ db });

    expect(result.status).toBe(expectedStatus);
    expect(meta).toMatchObject({
      coverageLagToleranceBlocks: BLACKLIST_COVERAGE_LAG_TOLERANCE_BLOCKS,
      coverageFailures: expectedStatus === "ok" ? 0 : 1,
      coverageLaggingWithinTolerance: expectedStatus === "ok" ? 1 : 0,
      oldestConfigSuccessAt: priorSuccess,
    });
    expect(meta.coverageFailureConfigs).toEqual([expect.objectContaining({ lag, samples: ["behind-safe-head"] })]);
  });

  it.each([
    { complete: true, previouslySucceeded: true },
    { complete: false, previouslySucceeded: true },
    { complete: true, previouslySucceeded: false },
  ])("refreshes observed summaries during degraded RPC coverage $complete/$previouslySucceeded without renewing freshness", async ({ complete, previouslySucceeded }) => {
    const now = Math.floor(Date.now() / 1000);
    const priorSuccess = previouslySucceeded ? now - 2 * 86400 : null;
    const db = makeDb(CONTRACT_CONFIGS.map((c) => ({
      config_key: c.configKey, last_block: 0, cursor_value: 0, attempt_generation: 1, last_succeeded_at: priorSuccess,
    })));
    vi.mocked(fetchAlchemyLogs).mockResolvedValueOnce({ logs: [], complete, scannedToBlock: 19_960_000, calls: 9, maxDepth: 3 });
    installFetch(emptyTronResponse);
    const { result, meta } = await runSync({ db });

    expect(result.status).toBe("degraded");
    expect(meta).toMatchObject({
      configsSucceeded: CONTRACT_CONFIGS.length - 1, oldestConfigSuccessAt: priorSuccess,
      producerSnapshotSkipped: false, producerSummarySnapshot: true,
      producerGapMetricSnapshots: previouslySucceeded ? 2 : 0,
    });
    const write = db.getHistory().find((e) => e.sql.includes("blacklist-summary-snapshot-write"));
    expect(write).toBeDefined();
    expect(JSON.parse(String(write!.binds[1]))).toMatchObject({
      materializedAt: now, freshnessTs: priorSuccess, freshnessStatus: previouslySucceeded ? "ok" : "missing",
      payload: { refresh: { observedAt: now, behindConfigs: [expect.objectContaining({ lastSucceededAt: priorSuccess })] } },
    });
    expect(write!.binds[2]).toBe(now);
  });

  it("stops cleanly before the cron wrapper timeout when runtime budget is nearly exhausted", async () => {
    const db = makeDb();
    installFetch(async () => {
      vi.setSystemTime(new Date("2025-06-15T12:09:30Z"));
      return emptyTronResponse();
    });
    const { result, meta } = await runSync({ db });

    expect(result.status).toBe("degraded");
    expect(meta).toMatchObject({ runtimeBudgetReached: true, producerSnapshotSkipped: true, producerSnapshotAttempts: 0 });
    expect(meta.contractsSkipped).toBeGreaterThan(0);
    expect(db.getHistory().some((e) => e.sql.includes("blacklist-summary-snapshot-write"))).toBe(false);
  });

  it("preserves later maintenance and snapshots when a long EVM repair reaches its own deadline", async () => {
    const db = makeDb();
    const startedAt = Date.now();
    vi.mocked(backfillAmounts).mockImplementationOnce(async (_db, _key, _limiter, budget, _signal, options) => {
      expect(options?.attemptDeadlineMs).toBe(budget.deadlineMs - 55_000);
      expect(options?.attemptDeadlineMs).toBe(startedAt + 590_000);
      vi.setSystemTime(options!.attemptDeadlineMs!);
      return { runtimeBudgetReached: false, repairWindowExhausted: true, attempted: 400, resolved: 400, retried: 0, unrecoverable: 0 };
    });
    vi.mocked(resolveTronBlacklistOrder).mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 10_000);
      return { blocksAttempted: 1, positionsResolved: 2, blocksDeferred: 0 };
    });
    vi.mocked(backfillTronBlacklistAmounts).mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 10_000);
      return { runtimeBudgetReached: false, attempted: 0, resolved: 0, retried: 0, parked: 0, limit: 24 };
    });
    installFetch(emptyTronResponse);

    const { result, meta } = await runSync({ db });
    expect(result.status).toBe("ok");
    expect(meta).toMatchObject({
      runtimeBudgetReached: false, amountRepairOutcome: "partial", amountRepairReason: "maintenance-tail-reserved",
      amountRepairAttempted: 400, tronOrderOutcome: "ok", tronAmountRepairOutcome: "ok",
      producerSnapshotSkipped: false, producerSnapshotWindowUnavailable: false,
      producerSummarySnapshot: true, producerGapMetricSnapshots: 2,
    });
    expect(resolveTronBlacklistOrder).toHaveBeenCalledOnce();
    expect(backfillTronBlacklistAmounts).toHaveBeenCalledOnce();
    expect(db.getHistory().some((e) => e.sql.includes("FROM cache AS debt"))).toBe(true);
  });

  it("keeps the exhausted-scan row cap while deferring EVM repair to preserve the remaining tail", async () => {
    const db = mockD1([
      { match: "blacklist_sync_state", rows: [] },
      {
        match: "blacklist-amount-recovery-evm-candidates",
        rows: [{
          id: "repair-row-1", chain_id: "ethereum", event_type: "blacklist",
          address: "0x1111111111111111111111111111111111111111", block_number: 100, stablecoin: "USDC",
          tx_hash: "0xrepair", config_key: null, contract_address: null, amount_attempt_count: 0,
          amount_last_attempted_at: null, amount_last_error_class: null, amount_last_provider: null,
          amount_source: "unavailable", queue_attempt_count: 0,
        }],
      },
      { match: "blacklist_events", rows: [] },
    ]);
    vi.mocked(fetchAlchemyLogs).mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2025-06-15T12:10:05Z"));
      return { logs: [], complete: true, scannedToBlock: 20000000, calls: 1, maxDepth: 0 };
    });
    installFetch(async () => jsonResp({ result: "0x0000000000000000000000000000000000000000000000000000000000989680" }));
    const { result, meta } = await runSync({ db });

    expect(result.status).toBe("degraded");
    expect(meta).toMatchObject({
      runtimeBudgetReached: true, amountRepairTailWindowUsed: true, amountRepairTailLimit: 10,
      amountRepairAttempted: 0, amountRepairResolved: 0, amountRepairRetried: 0,
      amountRepairOutcome: "partial", amountRepairReason: "maintenance-tail-reserved", maintenanceRuntimeBudgetMs: 645_000,
    });
    expect(db.getHistory().find((e) => e.sql.includes("blacklist-amount-recovery-evm-candidates"))).toBeUndefined();
    expect(vi.mocked(backfillAmounts).mock.calls[0][5]?.maxRows).toBe(10);
  });

  it("degrades a one-contract runtime tail and withholds producer snapshots", async () => {
    const db = makeDb();
    vi.mocked(fetchAlchemyLogs).mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2025-06-15T12:09:30Z"));
      return { logs: [], complete: true, scannedToBlock: 20000000, calls: 1, maxDepth: 0 };
    });
    installFetch(emptyTronResponse);
    const { result, meta } = await runSync({ db });

    expect(result.status).toBe("degraded");
    expect(meta).toMatchObject({
      runtimeBudgetReached: true, contractsSkipped: 1, incompleteRuntimeConfigs: 0,
      subrequestBudgetReached: false, producerSnapshotWindowUnavailable: false, producerSnapshotSkipped: true,
    });
    expect(db.getHistory().some((e) => e.sql.includes("blacklist-summary-snapshot-write"))).toBe(false);
  });

  it.each([
    ["blacklist-gap-metrics-cache-write", "materializeBlacklistGapMetrics", 0, undefined],
    ["blacklist-summary-snapshot-write", "materializeBlacklistSummarySnapshot", 2, undefined],
    ...["once", "twice", "late"].map((mode) => ["blacklist-summary-per-coin-event-counts", "materializeBlacklistSummarySnapshot", 2, mode] as const),
  ] as const)("retains bounded publication diagnostics for %s %s %s %s", async (match, operation, gaps, mode) => {
    const startedAt = Date.now();
    const retried = mode === "once" || mode === "twice";
    const error = mode ? "D1 DB is overloaded: consumed within a 10 second window" : "snapshot write failed".repeat(40);
    let reads = 0;
    const db = makeDb([], [{
      match, throwError: mode ? undefined : new Error(error),
      get rows() {
        if (++reads <= (mode === "twice" ? 2 : 1)) {
          if (mode === "late") vi.setSystemTime(Date.now() + 625_000);
          throw new Error(error);
        }
        return [];
      },
    }]);
    const onProgress = vi.fn();
    installFetch(emptyTronResponse);
    const pending = runSync({ db, onProgress });
    await vi.runAllTimersAsync();
    const { result, meta } = await pending;
    if (mode === "late") expect(Date.now() - startedAt).toBeLessThan(635_000);
    if (mode === "once") {
      expect(result.status).toBe("ok");
      expect(meta.producerSummarySnapshot).toBe(true);
      expect(materializeBlacklistGapMetrics).toHaveBeenCalledTimes(2);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(10_000);
      expect(db.getHistory().find((r) => r.sql.includes("blacklist-summary-snapshot-write"))?.binds[2]).toBe(startedAt / 1000);
    }
    expect(meta.producerSnapshotAttempts).toBe(retried ? 2 : 1);
    expect(reads).toBe(mode ? (retried ? 2 : 1) : 0);
    if (mode === "once") return;
    expect(result.status).toBe("degraded");
    expect(meta).toMatchObject({
      reason: "blacklist-snapshot-publication-failed", reasons: ["blacklist-snapshot-publication-failed"],
      producerSnapshotError: error.slice(0, 500), producerSnapshotErrorOperation: operation,
      producerGapMetricSnapshots: gaps, producerSummarySnapshot: false, producerSnapshotSkipped: false,
    });
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      stage: "producer-snapshots", message: "Failed to materialize blacklist producer snapshots",
      metadata: expect.objectContaining({ errorMessage: error.slice(0, 500) }),
    }));
  });

  describe("outcome truth", () => {
    const emptyOk = () => installFetch(emptyTronResponse);

    it("reports successful empty repair stages as ok with observed zero", async () => {
      emptyOk();
      const { result, meta } = await runSync();
      expect(result.status).toBe("ok");
      expect(meta.reasons).toBeUndefined();
      for (const prefix of ["amountRepair", "tronOrder", "tronAmountRepair"]) {
        expect(meta[`${prefix}Outcome`]).toBe("ok");
        expect(meta[`${prefix}Reason`]).toBeNull();
      }
      expect(meta).toMatchObject({ amountRepairAttempted: 0, tronAmountRepairAttempted: 0, tronOrderBlocksAttempted: 0 });
    });

    it("marks a thrown EVM amount repair failed with null counters", async () => {
      emptyOk();
      vi.mocked(backfillAmounts).mockRejectedValueOnce(new Error("repair boom"));
      const { result, meta } = await runSync();
      expect(result.status).toBe("degraded");
      expect(meta).toMatchObject({
        reason: "blacklist-evm-amount-repair-failed", reasons: ["blacklist-evm-amount-repair-failed"],
        amountRepairOutcome: "failed", amountRepairAttempted: null, amountRepairResolved: null, tronAmountRepairOutcome: "ok",
      });
    });

    it("names the order failure when Tron order repair throws and skips replay", async () => {
      emptyOk();
      vi.mocked(resolveTronBlacklistOrder).mockRejectedValueOnce(new Error("order boom"));
      const { result, meta } = await runSync();
      expect(result.status).toBe("degraded");
      expect(meta).toMatchObject({
        reasons: ["blacklist-tron-order-repair-failed"], tronOrderOutcome: "failed", tronOrderBlocksAttempted: null,
        tronAmountRepairOutcome: "skipped", tronAmountRepairReason: "tron-order-repair-failed", tronAmountRepairAttempted: null,
      });
      expect(backfillTronBlacklistAmounts).not.toHaveBeenCalled();
    });

    it("keeps order counters when Tron amount replay throws", async () => {
      emptyOk();
      vi.mocked(backfillTronBlacklistAmounts).mockRejectedValueOnce(new Error("replay boom"));
      const { result, meta } = await runSync();
      expect(result.status).toBe("degraded");
      expect(meta).toMatchObject({
        reasons: ["blacklist-tron-amount-repair-failed"], tronOrderOutcome: "ok",
        tronOrderBlocksAttempted: 0, tronAmountRepairOutcome: "failed", tronAmountRepairLimit: null,
      });
    });

    it.each([false, true])("reports replay limits (page cap %s)", async (pageCapReached) => {
      emptyOk();
      vi.mocked(backfillTronBlacklistAmounts).mockResolvedValueOnce({
        runtimeBudgetReached: !pageCapReached, pageCapReached, attempted: 2, resolved: 1, retried: 1, parked: 0, limit: 24,
      });
      const { result, meta } = await runSync();
      expect(result.status).toBe(pageCapReached ? "ok" : "degraded");
      expect(meta).toMatchObject({
        tronAmountRepairOutcome: "partial",
        tronAmountRepairReason: pageCapReached ? "blacklist-tron-amount-repair-page-cap" : "blacklist-budget-exhausted",
        tronAmountRepairAttempted: 2, tronAmountRepairLimit: 24, producerSnapshotSkipped: false, producerSummarySnapshot: true,
      });
      expect(meta.quality?.reason).toBe(pageCapReached ? meta.tronAmountRepairReason : undefined);
    });

    it("skips EVM repair with provider-circuit-open when the Etherscan circuit is open", async () => {
      const db = openCircuitDb("circuit:etherscan", Math.floor(Date.now() / 1000));
      emptyOk();
      const { meta } = await runSync({ db });
      expect(meta).toMatchObject({ amountRepairOutcome: "skipped", amountRepairReason: "provider-circuit-open", amountRepairAttempted: null });
      expect(backfillAmounts).not.toHaveBeenCalled();
    });

    it("skips EVM repair with subrequest-budget-exhausted when the shared budget refused it", async () => {
      emptyOk();
      vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockImplementation(
        async (_id, _c, _t, _k, _from, toBlock, _d, _l, budget) => {
          budget.count = budget.limit;
          return { logs: [], complete: true, scannedToBlock: toBlock, calls: 1, maxDepth: 0 };
        },
      );
      const { meta } = await runSync();
      expect(meta).toMatchObject({
        subrequestBudgetReached: true, tronAmountRepairOutcome: "skipped", tronAmountRepairReason: "subrequest-budget-exhausted",
        amountRepairOutcome: "skipped", amountRepairReason: "subrequest-budget-exhausted", amountRepairAttempted: null,
      });
      expect(backfillAmounts).not.toHaveBeenCalled();
    });

    it("admits new amount-gap rows to the repair queue even when the maintenance tail is starved", async () => {
      emptyOk();
      const startedAt = Date.now();
      vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockImplementation(async () => {
        vi.setSystemTime(startedAt + 650_000);
        return completeEtherscanLogs();
      });
      const db = makeDb();
      const { meta } = await runSync({ db });
      expect(meta).toMatchObject({ amountRepairOutcome: "skipped", amountRepairReason: "maintenance-budget-exhausted", amountRepairAttempted: null });
      expect(backfillAmounts).not.toHaveBeenCalled();
      expect(db.getHistory().some((e) => e.sql.includes("blacklist-amount-repair-queue-enqueue"))).toBe(true);
    });

    it("degrades instead of rejecting when the current-balance debt lane throws", async () => {
      const db = makeDb([], [{ match: "FROM cache AS debt", rows: [], throwError: new Error("D1_ERROR: internal error; reference = overloaded") }]);
      emptyOk();
      vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockResolvedValueOnce(completeEtherscanLogs([makeEvmLog()]));
      const nowSec = Math.floor(Date.now() / 1000);
      const { result, meta } = await runSync({ db });

      expect(result.status).toBe("degraded");
      expect(result.itemCount).toBe(1);
      expect(meta.reasons).toContain("blacklist-current-balance-debt-repair-failed");
      expect(meta).toMatchObject({
        reason: "blacklist-current-balance-debt-repair-failed", currentBalanceDebtOutcome: "failed",
        currentBalanceDebtReason: "repair-threw", configsAttempted: CONTRACT_CONFIGS.length,
        configsSucceeded: CONTRACT_CONFIGS.length, rowsWritten: 1, outputPublishedAt: nowSec,
      });
    });

    it("preserves scan reason first and lists publication and repair failures together", async () => {
      const db = makeDb([], [{ match: "blacklist-summary-snapshot-write", rows: [], throwError: new Error("snapshot write failed") }]);
      vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockRejectedValueOnce(new TypeError("explorer down"));
      vi.mocked(backfillAmounts).mockRejectedValueOnce(new Error("repair boom"));
      vi.mocked(backfillTronBlacklistAmounts).mockRejectedValueOnce(new Error("replay boom"));
      emptyOk();
      const { result, meta } = await runSync({ db });

      expect(result.status).toBe("degraded");
      expect(meta.reason).toBe("blacklist-source-coverage-incomplete");
      expect(meta.reasons).toEqual([
        "blacklist-source-coverage-incomplete", "blacklist-snapshot-publication-failed",
        "blacklist-evm-amount-repair-failed", "blacklist-tron-amount-repair-failed",
      ]);
    });

    it("never lowers an error status when publication or repair also fails", async () => {
      vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockRejectedValue(new TypeError("explorer down"));
      vi.mocked(fetchAlchemyLogs).mockRejectedValue(new TypeError("rpc down"));
      vi.mocked(backfillAmounts).mockRejectedValueOnce(new Error("repair boom"));
      installFetch(async () => new Response("down", { status: 500 }));
      const pending = runSync();
      await vi.runAllTimersAsync();
      const { result, meta } = await pending;

      expect(result.status).toBe("error");
      expect(meta.reasons).toContain("blacklist-evm-amount-repair-failed");
      expect(meta.reasons?.[0]).toBe("blacklist-source-coverage-incomplete");
    });
  });

  it("advances sync state for EVM chains toward chain head when no events", async () => {
    const db = makeDb();
    vi.mocked(getEvmBlockNumber).mockResolvedValue(20000000);
    installFetch(emptyTronResponse);
    await syncBlacklist(buildTestOpts({ db }));

    expect(findStateFinalization(db, `base-${BASE_USDC}`)?.binds[0]).toBeGreaterThan(19_950_000);
    expect(findStateFinalization(db, `ethereum-${ETH_USDC}`)?.binds[0]).toBeGreaterThan(0);
  });

  it("falls back to RPC log scans for paid-only Etherscan chains", async () => {
    vi.mocked(fetchAlchemyLogs).mockResolvedValueOnce({ logs: [makeAlchemyLog()], complete: true, scannedToBlock: 20000000, calls: 1, maxDepth: 0 });
    vi.mocked(resolveBlockTimestamps).mockResolvedValueOnce(new Map([[20000000, 1718650752]]));
    installFetch(emptyTronResponse);
    const { result, meta } = await runSync();

    expect(result.itemCount).toBe(1);
    expect(meta.apiErrors).toBe(0);
    expect(meta.rpcLogConfigs).toBeGreaterThanOrEqual(1);
  });

  it("tries chain RPC after a dRPC miss for non-mainnet balance enrichment", async () => {
    vi.mocked(fetchAlchemyLogs).mockResolvedValueOnce({ logs: [makeAlchemyLog()], complete: true, scannedToBlock: 20000000, calls: 1, maxDepth: 0 });
    vi.mocked(resolveBlockTimestamps).mockResolvedValueOnce(new Map([[20000000, 1718650752]]));
    const fetchMock = installFetch(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("lb.drpc.org")) return jsonResp({ jsonrpc: "2.0", id: 1, result: "0x" });
      if (urlStr.includes("base-rpc.example")) return jsonResp({ jsonrpc: "2.0", id: 1, result: "0x" + "0".repeat(64) });
      return emptyTronResponse();
    });
    const { result } = await runSync({ drpcApiKey: "drpc-key" });

    expect(result.itemCount).toBe(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("lb.drpc.org"))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("base-rpc.example"))).toBe(true);
  });

  it("orders backfill work newest-first so recent gaps are not starved by old backlog", async () => {
    const db = makeDb();
    installFetch(emptyTronResponse);
    await syncBlacklist(buildTestOpts({ db }));
    const backfillQuery = db.getHistory().find(
      (e) => e.sql.includes("FROM blacklist_events") && e.sql.includes("amount_status IN") && e.sql.includes("LIMIT ?"),
    );
    expect(backfillQuery?.sql).toContain("timestamp DESC");
  });

  it.each([
    [null, 0, false, "degraded"], [60, 0, false, "ok"], [60, 1, false, "degraded"],
    [60, 0, true, "degraded"], [60, 0, "exhausted", "degraded"],
    [7 * 86400, 0, false, "degraded"], [-86400, 0, false, "degraded"],
  ] as const)("retains partial progress; success=%s failures=%s peerPartial=%s grades %s", async (success, failures, peerPartial, status) => {
    const base = CONTRACT_CONFIGS[1];
    const peer = { ...base, configKey: "base-peer" };
    const now = Math.floor(Date.now() / 1000);
    CONTRACT_CONFIGS.push(peer);
    const db = makeDb(CONTRACT_CONFIGS.map((c) => ({
      config_key: c.configKey, last_block: c === base && success == null ? 0 : 19_950_000,
      last_succeeded_at: c === base && success == null ? null : now - (c === base ? success! : 60),
      consecutive_failures: c === base ? failures : 0,
      last_attempted_at: c.chain.chainId === "ethereum" ? 1 : 2,
    })));
    vi.mocked(fetchAlchemyLogs).mockResolvedValueOnce({
      logs: [], complete: false, scannedToBlock: 19_960_000, calls: 9, maxDepth: 3, failureReason: "provider-timeout",
    });
    if (peerPartial === true) vi.mocked(fetchAlchemyLogs).mockResolvedValueOnce({ logs: [], complete: false, scannedToBlock: 19_960_000, calls: 9, maxDepth: 3 });
    if (peerPartial === "exhausted") vi.mocked(fetchAlchemyLogs).mockImplementationOnce(async (...args) => {
      if (args[5]) args[5].count = args[5].limit;
      return { logs: [], complete: true, scannedToBlock: 20_000_000, calls: 1, maxDepth: 0 };
    });
    installFetch(emptyTronResponse);

    const result = await syncBlacklist(buildTestOpts({ db })).finally(() => CONTRACT_CONFIGS.pop());
    expect(result.status).toBe(status);
    expect(result.itemCount).toBe(0);
    const metadata = {
      ...JSON.parse(result.metadata),
      configLag: Object.fromEntries(Array.from({ length: 66 }, (_, i) => [i, { cursorKind: "evm_block", frontier: 19_960_000, safeHead: 20_000_000, lag: 40_000 }])),
    };
    const pack = (data: Record<string, unknown>) => compactCronMetadataForPersistence(JSON.stringify(data), undefined, "sync-blacklist");
    const meta = JSON.parse(pack(metadata).metadata!);
    expect(meta.apiErrors).toBe(peerPartial === true ? 2 : 1);
    if (success && Math.abs(success) >= 86400) expect(meta.reason).toBe("blacklist-source-coverage-incomplete");
    if (peerPartial === "exhausted") expect(meta).toMatchObject({ reason: "blacklist-budget-exhausted", subrequestBudgetReached: true });
    expect(meta.apiErrorConfigs).toEqual([
      expect.objectContaining({
        configKey: base.configKey, stablecoin: "USDC", chainId: "base",
        reason: "partial-coverage", errorClass: "provider-timeout", failureSamples: ["provider-timeout"],
        frontier: 19_960_000, safeHead: 20_000_000, providerCalls: 9, maxSplitDepth: 3,
      }),
      ...(peerPartial === true ? [expect.objectContaining({ configKey: peer.configKey })] : []),
    ]);
    if (success == null) expect(JSON.parse(result.metadata).zeroCursorConfigs).toContain(base.configKey);
    if (status === "ok") {
      expect(meta.quality).toEqual({ reason: "blacklist-isolated-partial-coverage", configKey: base.configKey });
      for (const text of ["a", String.fromCharCode(0, 34, 92, 0x2603)]) {
        const sample = text.repeat(120).slice(0, 120);
        const entries = Array.from({ length: 10 }, (_, i) => ({
          ...meta.apiErrorConfigs[0], configKey: base.configKey + i, errorClass: i + sample, failureSamples: Array(4).fill(sample),
        }));
        const packed = pack({
          ...metadata, apiErrorConfigs: entries,
          apiErrorClasses: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i < 2 ? ["constructor", "__proto__"][i] : i + sample, 1])),
          schedulerAttemptKey: "attempt", resourcePressure: { outcome: "ok", pending: false },
        });
        const bounded = JSON.parse(packed.metadata!);
        expect.soft(packed.persistedBytes).toBeLessThanOrEqual(getCronMetadataBudgetBytes("sync-blacklist"));
        expect(bounded.apiErrorConfigs.map((e: { configKey: string }) => e.configKey)).toEqual(entries.map((e) => e.configKey));
        expect.soft(bounded.apiErrorDetailsOmitted).toBeGreaterThan(0);
        expect(Object.values<number>(bounded.apiErrorClasses).reduce((a, b) => a + b, 0)).toBe(20);
        expect.soft(Object.keys(bounded.apiErrorClasses).length).toBeLessThanOrEqual(10);
        expect.soft(Object.keys(bounded.apiErrorClasses).every((code) => /^[a-zA-Z0-9:._-]{1,64}$/.test(code))).toBe(true);
      }
    }
    const finalization = findStateFinalization(db, base.configKey);
    expect(finalization?.binds[0]).toBe(19_960_000);
    expect(finalization?.binds[2]).toBe(0);
    expect(finalization?.binds[11]).toBe("partial");
  });

  it("does not advance a shared Etherscan cursor when one configured topic fails", async () => {
    const db = makeDb();
    const ethereumConfig = CONTRACT_CONFIGS.find((c) => c.chain.chainId === "ethereum")!;
    const previousEvents = ethereumConfig.events;
    ethereumConfig.events = [
      ...previousEvents,
      { signature: "UnBlacklisted(address)", topicHash: UNBLACKLISTED_TOPIC, eventType: "unblacklist", hasAmount: false },
    ];
    vi.mocked(fetchEvmLogsForTopicWithCompleteness)
      .mockResolvedValueOnce(completeEtherscanLogs([makeEvmLog({ blockNumber: "0xc8", transactionHash: "0x" + "fa".repeat(32) })]))
      .mockResolvedValueOnce(failedEtherscanLogs())
      .mockResolvedValue(completeEtherscanLogs());
    installFetch(emptyTronResponse);

    try {
      const { meta } = await runSync({ db });
      expect(meta).toMatchObject({ apiErrors: 1, eventsFetched: 1 });
      const finalization = findStateFinalization(db, `ethereum-${ETH_USDC}`);
      expect(finalization?.binds[0]).toBe(0);
      expect(finalization?.binds[11]).toBe("missing_topic");
    } finally {
      ethereumConfig.events = previousEvents;
    }
  });

  it("advances a multi-topic RPC cursor after one complete OR-topic scan", async () => {
    const db = makeDb();
    const baseConfig = CONTRACT_CONFIGS.find((c) => c.chain.chainId === "base")!;
    const previousEvents = baseConfig.events;
    baseConfig.events = [
      ...previousEvents,
      { signature: "UnBlacklisted(address)", topicHash: UNBLACKLISTED_TOPIC, eventType: "unblacklist", hasAmount: false },
    ];
    vi.mocked(getAlchemyBlockNumber).mockResolvedValue(19_960_450);
    vi.mocked(fetchAlchemyLogs).mockImplementationOnce(async (_rpc, _addr, _topics, _from, _to, budget) => {
      budget.count = budget.limit;
      return { logs: [], complete: true, scannedToBlock: 19_960_000, calls: 1, maxDepth: 0 };
    });
    installFetch(emptyTronResponse);

    try {
      const { result, meta } = await runSync({ db });
      expect(result.status).toBe("degraded");
      expect(meta).toMatchObject({ runtimeBudgetReached: true, subrequestBudgetReached: true });
      expect(fetchAlchemyLogs).toHaveBeenCalledTimes(1);
      const finalization = findStateFinalization(db, `base-${BASE_USDC}`);
      expect(finalization?.binds[0]).toBe(19_960_000);
      expect(finalization?.binds[11]).toBe("quiet");
      expect(vi.mocked(fetchAlchemyLogs).mock.calls[0]?.[2]).toEqual([{ index: 0, value: [BLACKLISTED_TOPIC, UNBLACKLISTED_TOPIC] }]);
    } finally {
      baseConfig.events = previousEvents;
    }
  });

  it("uses configured startBlock and bounded RPC scan windows for zero-cursor configs", async () => {
    const db = makeDb();
    const baseConfig = CONTRACT_CONFIGS.find((c) => c.chain.chainId === "base")!;
    const previousStartBlock = baseConfig.startBlock;
    baseConfig.startBlock = 1_000_000;
    vi.mocked(fetchAlchemyLogs).mockResolvedValueOnce({ logs: [], complete: true, scannedToBlock: 1_049_999, calls: 1, maxDepth: 0 });
    installFetch(emptyTronResponse);

    try {
      const { result, meta } = await runSync({ db });
      expect(result.status).toBe("degraded");
      expect(meta).toMatchObject({
        producerSnapshotSkipped: false, producerSummarySnapshot: true,
        reason: "blacklist-source-coverage-incomplete",
        configLag: { [baseConfig.configKey]: { frontier: 1_049_999, safeHead: 20_000_000, lag: 18_950_001 } },
      });
      expect(meta.coverageFailureConfigs).toContainEqual({
        configKey: baseConfig.configKey, outcome: "incomplete", cursorKind: "evm_block",
        frontier: 1_049_999, safeHead: 20_000_000, lag: 18_950_001, samples: ["behind-safe-head"],
      });
      expect(meta.coverageFailureConfigs.length).toBeLessThanOrEqual(6);
      const baseCalls = vi.mocked(fetchAlchemyLogs).mock.calls.filter((c) => c[1] === BASE_USDC);
      const baseCall = baseCalls[baseCalls.length - 1];
      expect(baseCall?.[3]).toBe(1_000_000);
      expect(baseCall?.[4]).toBe(1_049_999);
      expect(findStateFinalization(db, `base-${BASE_USDC}`)?.binds[0]).toBe(1_049_999);
    } finally {
      baseConfig.startBlock = previousStartBlock;
    }
  });
});
