import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import type { ContractEventConfig } from "../../../lib/blacklist-contracts";

vi.mock("../../../lib/evm-logs", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../lib/evm-logs")>();
  return {
    ...original,
    fetchEvmLogsForTopicWithCompleteness: vi.fn(),
  };
});

vi.mock("../../../lib/alchemy-logs", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../lib/alchemy-logs")>();
  return {
    ...original,
    fetchAlchemyLogs: vi.fn(),
    getAlchemyBlockNumber: vi.fn(),
    resolveBlockTimestamps: vi.fn(),
  };
});

vi.mock("../../../lib/chain-registry", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../lib/chain-registry")>();
  return {
    ...original,
    getChainRpc: vi.fn(),
  };
});

import { EXPLORER_LOG_SCAN_WINDOWS, fetchEvmEventsIncremental, getEvmSafeHead } from "../evm-source";
import { createBlacklistRunBudget } from "../../../lib/blacklist/run-budget";
import { fetchEvmLogsForTopicWithCompleteness } from "../../../lib/evm-logs";
import { fetchAlchemyLogs, getAlchemyBlockNumber, resolveBlockTimestamps } from "../../../lib/alchemy-logs";
import { buildChainRpcs, getChainRpc, type ChainRpcConfig } from "../../../lib/chain-registry";

const TOPIC_A = "0x" + "11".repeat(32);
const TOPIC_B = "0x" + "22".repeat(32);
const ADDRESS_WORD = "0x" + "00".repeat(12) + "33".repeat(20);

function makeConfig(chainId = "arbitrum", topics = [TOPIC_A]): ContractEventConfig {
  return {
    configKey: `${chainId}-0x${"44".repeat(20)}`,
    chain: {
      chainId,
      chainName: chainId === "arbitrum" ? "Arbitrum" : "Base",
      evmChainId: chainId === "arbitrum" ? 42161 : 8453,
      explorerUrl: "https://example.invalid",
      type: "evm",
    },
    stablecoinId: "usdc-circle",
    stablecoin: "USDC",
    contractAddress: "0x" + "44".repeat(20),
    decimals: 6,
    events: topics.map((topicHash, index) => ({
      signature: index === 0 ? "Blacklisted(address)" : "UnBlacklisted(address)",
      topicHash,
      eventType: index === 0 ? "blacklist" : "unblacklist",
      hasAmount: false,
    })),
  };
}

function makeBudget() {
  return createBlacklistRunBudget({
    subrequestLimit: 900,
    runtimeBudgetMs: 600_000,
    minimumConfigWindowMs: 60_000,
  });
}

const limiter = async <T>(fn: () => Promise<T>) => fn();

describe("EVM blacklist contiguous coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockImplementation(
      async (_chain, _address, _topic, _key, _from, toBlock) => ({
        logs: [],
        complete: true,
        scannedToBlock: toBlock,
        calls: 1,
        maxDepth: 0,
      }),
    );
    vi.mocked(fetchAlchemyLogs).mockResolvedValue({
      logs: [],
      complete: true,
      scannedToBlock: 1_000_000,
      calls: 1,
      maxDepth: 0,
    });
    vi.mocked(getAlchemyBlockNumber).mockResolvedValue(1_000_000);
    vi.mocked(resolveBlockTimestamps).mockResolvedValue(new Map());
    vi.mocked(getChainRpc).mockReturnValue(undefined);
  });

  it.each([{ data: "malformed" }, { transactionHash: "malformed" }, { topics: ["malformed"] }])(
    "holds malformed explorer intake until durable exhaustion and recovers a transient peer: %j", async (defect) => {
      const sqlite = new DatabaseSync(":memory:");
      sqlite.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)");
      const db = { prepare(sql: string) {
        let args: (string | number)[] = [];
        return { bind(...values: (string | number)[]) { args = values; return this; },
          async first() { return sqlite.prepare(sql).get(...args) ?? null; },
          async run() { return sqlite.prepare(sql).run(...args); } };
      } } as unknown as D1Database;
      try {
        const config = makeConfig();
        const valid = { address: config.contractAddress, topics: [TOPIC_A, ADDRESS_WORD], data: "0x",
          blockNumber: "0x64", timeStamp: "0x3e8", transactionHash: "0x" + "55".repeat(32), logIndex: "0x0" };
        const repaired = { ...valid, blockNumber: "0x69", logIndex: "0x1" };
        vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockResolvedValue({
          logs: [valid], rejectedLogs: [{ ...repaired, ...defect }], validatedToBlock: 120,
          complete: false, scannedToBlock: 104, calls: 1, maxDepth: 0,
        });
        const first = await fetchEvmEventsIncremental(db, config, "key", 100, new Map(), makeBudget(), limiter, undefined, undefined, 10_000);
        expect(first.scannedToBlock).toBe(104);
        expect(first.rows).toHaveLength(1);
        vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockResolvedValue({
          logs: [valid, repaired], complete: true, scannedToBlock: 120, calls: 1, maxDepth: 0,
        });
        const second = await fetchEvmEventsIncremental(db, config, "key", 105, new Map(), makeBudget(), limiter, undefined, undefined, 10_000);
        expect(second.scannedToBlock).toBe(120);
        expect(second.rows.map((row) => row.block_number)).toContain(105);
        vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockResolvedValue({
          logs: [valid], rejectedLogs: [{ ...repaired, ...defect }], validatedToBlock: 120,
          complete: false, scannedToBlock: 104, calls: 1, maxDepth: 0,
        });
        for (let scan = 2; scan <= 3; scan++) {
          const result = await fetchEvmEventsIncremental(db, config, "key", 100, new Map(),
            { ...makeBudget(), deadlineMs: Date.now() + 600_000 + scan * 100 }, limiter, undefined, undefined, 10_000);
          expect(result.scannedToBlock).toBe(scan < 3 ? 104 : 120);
        }
        expect(JSON.parse(String(sqlite.prepare("SELECT value FROM cache").get()!.value))).toMatchObject({
          attempts: 3, disposition: "decode-retry-exhausted",
        });
      } finally { sqlite.close(); }
    },
  );

  it("advances Avalanche fallback faster than a moving six-hour safe head without exceeding per-call caps", async () => {
    const config = { ...makeConfig("avalanche"), chain: { ...makeConfig("avalanche").chain, evmChainId: 43114 } };
    const rpc: ChainRpcConfig = {
      chainId: "avalanche", chainName: "Avalanche", type: "evm", explorerUrl: "https://example.invalid",
      endpoints: [{ url: "https://avalanche.invalid", operator: "public", keyed: false,
        position: "registry", stateHistory: "archive", logsHistory: "full" }],
    };
    const chainRpcs = new Map([["avalanche", rpc]]);
    vi.mocked(getChainRpc).mockReturnValue(rpc);
    vi.mocked(fetchAlchemyLogs).mockImplementation(async (_rpc, _address, _topics, from, to) => {
      expect(to - from + 1).toBeLessThanOrEqual(2_000);
      return { logs: [], complete: true, scannedToBlock: to, calls: 1, maxDepth: 0 };
    });
    let cursor = 10_000;
    let head = 100_000;
    let previousLag = Infinity;
    for (let cycle = 0; cycle < 3; cycle++) {
      vi.mocked(getAlchemyBlockNumber).mockResolvedValue(head);
      const callsBefore = vi.mocked(fetchAlchemyLogs).mock.calls.length;
      const result = await fetchEvmEventsIncremental(
        mockD1(), config, null, cursor + 1, new Map(), makeBudget(), limiter, undefined, chainRpcs,
      );
      expect(result.coverageOutcome).toBe("incomplete");
      expect(result.failureSamples).toContain("behind-safe-head");
      expect(vi.mocked(fetchAlchemyLogs).mock.calls.length - callsBefore).toBe(8);
      expect(result.scannedToBlock).toBeGreaterThan(cursor);
      const lag = result.safeHead! - result.scannedToBlock!;
      expect(lag).toBeLessThan(previousLag);
      previousLag = lag;
      cursor = result.scannedToBlock!;
      head += 10_800;
    }
  });

  describe("reviewed Dwellir blacklist log routing", () => {
    function setup(chainId: "arbitrum" | "base" | "optimism" | "avalanche", disabled = false, alchemy = true) {
      const config = makeConfig(chainId, [TOPIC_A, TOPIC_B]);
      config.chain.evmChainId = chainId === "arbitrum" ? 42161 : chainId === "base" ? 8453 : chainId === "optimism" ? 10 : 43114;
      const chainRpcs = buildChainRpcs(alchemy ? "alchemy" : undefined, undefined, {
        dwellirApiKey: "dwellir", dwellirRoutingDisabledChains: disabled ? new Set([chainId]) : undefined,
      });
      vi.mocked(getChainRpc).mockReturnValue(chainRpcs.get(chainId));
      vi.mocked(getAlchemyBlockNumber).mockResolvedValue(chainId === "arbitrum" ? 20_003_600 : 20_000_450);
      vi.mocked(fetchAlchemyLogs).mockImplementation(async (_rpc, _address, _topics, _from, to, budget) => {
        budget.count++;
        return { logs: [], complete: true, scannedToBlock: to, calls: 1, maxDepth: 0 };
      });
      return { config, chainRpcs };
    }

    it.each(["arbitrum", "base", "optimism", "avalanche"] as const)(
      "scans %s Dwellir first in 10,000-block pages under the existing catch-up allowance", async (chainId) => {
        const { config, chainRpcs } = setup(chainId);
        const budget = createBlacklistRunBudget({ subrequestLimit: 2_000, runtimeBudgetMs: 600_000 });
        const result = await fetchEvmEventsIncremental(mockD1(), config, null, 1, new Map(), budget, limiter, undefined, chainRpcs);
        expect(fetchAlchemyLogs).toHaveBeenCalledTimes(600);
        for (const [index, call] of vi.mocked(fetchAlchemyLogs).mock.calls.entries()) {
          expect(call[0]).toContain(".n.dwellir.com");
          expect(call[3]).toBe(index * 10_000 + 1);
          expect(call[4]).toBe((index + 1) * 10_000);
          expect(call[7]?.maxSplitCalls).toBe(600 - index);
        }
        expect(result).toMatchObject({ scannedToBlock: 6_000_000, safeHead: 20_000_000,
          coverageOutcome: "incomplete", providerCalls: chainId === "arbitrum" ? 601 : 600, coveredTopicCount: 2 });
      },
    );

    it.each(["base", "optimism", "avalanche"] as const)(
      "keeps %s's unconditional 100-page allowance when extension reserves are exhausted", async (chainId) => {
        const { config, chainRpcs } = setup(chainId);
        const budget = makeBudget();
        budget.deadlineMs = Date.now() + 200_000;
        const result = await fetchEvmEventsIncremental(mockD1(), config, null, 1, new Map(), budget, limiter, undefined, chainRpcs);
        expect(fetchAlchemyLogs).toHaveBeenCalledTimes(100);
        expect(result.scannedToBlock).toBe(1_000_000);
      },
    );

    it.each([
      ["base", 500_000, 50_000], ["optimism", 500_000, 50_000], ["avalanche", 250_000, 2_000],
    ] as const)("retains %s incumbent page windows on rollback, failed Dwellir head, and failed Dwellir logs", async (chainId, alchemyWindow, publicWindow) => {
      for (const alchemy of [true, false]) {
        for (const failure of ["disabled", "head", "logs"] as const) {
          vi.clearAllMocks();
          const { config, chainRpcs } = setup(chainId, failure === "disabled", alchemy);
          if (failure === "head") {
            vi.mocked(getAlchemyBlockNumber).mockImplementation(async (url) =>
              url.includes(".n.dwellir.com") ? null : 20_000_450);
          }
          if (failure === "logs") {
            vi.mocked(fetchAlchemyLogs).mockImplementation(async (url, _address, _topics, from, to) =>
              url.includes(".n.dwellir.com")
                ? { logs: [], complete: false, scannedToBlock: from - 1, calls: 1, maxDepth: 0, failureReason: "rpc-error" }
                : { logs: [], complete: true, scannedToBlock: to, calls: 1, maxDepth: 0 });
          }
          const result = await fetchEvmEventsIncremental(mockD1(), config, null, 1, new Map(), makeBudget(), limiter, undefined, chainRpcs);
          const incumbentCalls = vi.mocked(fetchAlchemyLogs).mock.calls.filter((call) => !call[0].includes(".n.dwellir.com"));
          expect(incumbentCalls).toHaveLength(!alchemy && chainId === "avalanche" ? 8 : 1);
          for (const call of incumbentCalls) {
            expect(call[4] - call[3] + 1).toBe(alchemy ? alchemyWindow : publicWindow);
            expect(call[7]?.maxSplitCalls).toBeUndefined();
          }
          expect(result.scannedToBlock).toBe(alchemy ? alchemyWindow : chainId === "avalanche" ? 16_000 : publicWindow);
        }
      }
    });
  });

  describe("Dwellir serial catch-up pacing", () => {
    function setup() {
      const config = { ...makeConfig("gnosis", [TOPIC_A, TOPIC_B]),
        chain: { ...makeConfig("gnosis").chain, evmChainId: 100 } };
      const rpc: ChainRpcConfig = {
        chainId: "gnosis", chainName: "Gnosis", type: "evm", explorerUrl: "https://example.invalid",
        endpoints: [{ url: "https://gnosis.invalid", operator: "dwellir", keyed: true,
          position: "registry", stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000 }],
      };
      vi.mocked(getChainRpc).mockReturnValue(rpc);
      vi.mocked(getAlchemyBlockNumber).mockResolvedValue(20_000_180);
      vi.mocked(fetchAlchemyLogs).mockImplementation(async (_rpc, _address, _topics, from, to, budget) => {
        expect(to - from + 1).toBeLessThanOrEqual(9_000);
        budget.count++;
        return { logs: [], complete: true, scannedToBlock: to, calls: 1, maxDepth: 0 };
      });
      return { config, chainRpcs: new Map([["gnosis", rpc]]) };
    }

    it("scans 600 contiguous pages but does not certify the unscanned safe head", async () => {
      const { config, chainRpcs } = setup();
      const budget = createBlacklistRunBudget({ subrequestLimit: 2_000, runtimeBudgetMs: 600_000 });
      const result = await fetchEvmEventsIncremental(
        mockD1(), config, null, 1, new Map(), budget, limiter, undefined, chainRpcs,
      );
      expect(fetchAlchemyLogs).toHaveBeenCalledTimes(600);
      expect(fetchEvmLogsForTopicWithCompleteness).not.toHaveBeenCalled();
      expect(result).toMatchObject({ scannedToBlock: 5_400_000, safeHead: 20_000_000,
        coverageOutcome: "incomplete", providerCalls: 600, coveredTopicCount: 2 });
      for (const [index, call] of vi.mocked(fetchAlchemyLogs).mock.calls.entries()) {
        expect(call[3]).toBe(index * 9_000 + 1);
        expect(call[7]?.maxSplitCalls).toBe(600 - index);
      }
    });

    it.each(["subrequest", "runtime"] as const)("extends past 100 pages only while the %s reserve for queued configs holds", async (reserve) => {
      const { config, chainRpcs } = setup();
      const budget = makeBudget();
      if (reserve === "subrequest") budget.subrequestBudget.count = 550;
      if (reserve === "runtime") budget.deadlineMs = Date.now() + 200_000;
      const result = await fetchEvmEventsIncremental(
        mockD1(), config, null, 1, new Map(), budget, limiter, undefined, chainRpcs,
      );
      // The first 100 pages keep their unconditional allowance; extension stops at the reserve.
      expect(fetchAlchemyLogs).toHaveBeenCalledTimes(100);
      expect(result).toMatchObject({ scannedToBlock: 900_000, coverageOutcome: "incomplete" });
    });

    it("stops an extended catch-up when only the subrequest reserve remains", async () => {
      const { config, chainRpcs } = setup();
      const budget = makeBudget();
      budget.subrequestBudget.count = 300;
      const result = await fetchEvmEventsIncremental(
        mockD1(), config, null, 1, new Map(), budget, limiter, undefined, chainRpcs,
      );
      expect(fetchAlchemyLogs).toHaveBeenCalledTimes(300);
      expect(budget.subrequestBudget.limit - budget.subrequestBudget.count).toBe(300);
      expect(result).toMatchObject({ scannedToBlock: 2_700_000, coverageOutcome: "incomplete" });
    });

    it.each(["subrequest", "deadline", "split-calls"] as const)("stops at the %s budget with only the proven prefix", async (boundary) => {
      const { config, chainRpcs } = setup();
      const budget = makeBudget();
      vi.mocked(fetchAlchemyLogs).mockImplementation(async (_rpc, _address, _topics, _from, to) => {
        if (boundary === "subrequest") budget.subrequestBudget.count = budget.subrequestBudget.limit;
        if (boundary === "deadline") budget.deadlineMs = Date.now() - 1;
        return { logs: [], complete: true, scannedToBlock: to,
          calls: boundary === "split-calls" ? 600 : 1, maxDepth: 0 };
      });
      const result = await fetchEvmEventsIncremental(
        mockD1(), config, null, 1, new Map(), budget, limiter, undefined, chainRpcs,
      );
      expect(fetchAlchemyLogs).toHaveBeenCalledTimes(1);
      expect(result.scannedToBlock).toBe(9_000);
      expect(result.coverageOutcome).not.toBe("quiet");
      expect(result.coverageOutcome).not.toBe("complete");
    });

    it.each(["partial", "null"] as const)("does not advance across a mid-loop %s failure", async (failure) => {
      const { config, chainRpcs } = setup();
      vi.mocked(fetchAlchemyLogs)
        .mockResolvedValueOnce({ logs: [], complete: true, scannedToBlock: 9_000, calls: 1, maxDepth: 0 })
        .mockResolvedValueOnce(failure === "null" ? null
          : { logs: [], complete: false, scannedToBlock: 9_000, calls: 1, maxDepth: 0 });
      const result = await fetchEvmEventsIncremental(
        mockD1(), config, null, 1, new Map(), makeBudget(), limiter, undefined, chainRpcs,
      );
      expect(fetchAlchemyLogs).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ scannedToBlock: 9_000, coverageOutcome: "partial", apiError: true });
    });

    it("certifies coverage only after the final short page reaches the safe head", async () => {
      const { config, chainRpcs } = setup();
      vi.mocked(getAlchemyBlockNumber).mockResolvedValue(10_180);
      const result = await fetchEvmEventsIncremental(
        mockD1(), config, null, 1, new Map(), makeBudget(), limiter, undefined, chainRpcs,
      );
      expect(fetchAlchemyLogs).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ scannedToBlock: 10_000, safeHead: 10_000,
        coverageOutcome: "quiet", incomplete: false, apiError: false });
    });
  });

  it.each([null, "[]", "42"])("holds malformed state with prior %s for two scans then durably quarantines it without losing valid rows", async (priorValue) => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)");
    const db = { prepare(sql: string) {
      let args: (string | number)[] = [];
      return { bind(...values: (string | number)[]) { args = values; return this; },
        async first() { return sqlite.prepare(sql).get(...args) ?? null; },
        async run() { return sqlite.prepare(sql).run(...args); } };
    } } as unknown as D1Database;
    const config = makeConfig();
    const valid = {
      address: config.contractAddress, topics: [TOPIC_A, ADDRESS_WORD], data: "0x",
      blockNumber: "0x64", timeStamp: "0x3e8", transactionHash: "0x" + "55".repeat(32), logIndex: "0x0",
    };
    if (priorValue != null) {
      sqlite.prepare("INSERT INTO cache VALUES (?, ?, ?)").run(
        `blacklist:decode-retry:${config.configKey}:0x69:${valid.transactionHash}:0x1`, priorValue, 0,
      );
    }
    vi.mocked(fetchEvmLogsForTopicWithCompleteness).mockResolvedValue({
      logs: [valid, { ...valid, blockNumber: "0x69", logIndex: "0x1", topics: [TOPIC_A] }],
      complete: true, scannedToBlock: 120, calls: 1, maxDepth: 0,
    });
    const deadline = Date.now() + 600_000;
    for (let scan = 1; scan <= 3; scan++) {
      const result = await fetchEvmEventsIncremental(db, config, "key", 100, new Map(),
        { ...makeBudget(), deadlineMs: deadline + scan }, limiter, undefined, undefined, 10_000);
      expect(result.rows.map((row) => row.block_number)).toEqual([100]);
      expect(result.scannedToBlock).toBe(scan < 3 ? 104 : 120);
    }
    const state = JSON.parse(String(sqlite.prepare("SELECT value FROM cache").get()!.value));
    expect(state).toMatchObject({ attempts: 3, quarantined: true, reason: "invalid-address", evidence: { blockNumber: "0x69" } });
    sqlite.close();
  });

  it("scans above the retired 99,999,999 fence and bounds Arbitrum ranges", async () => {
    const fromBlock = 450_000_000;
    const chainHead = 482_000_000;
    const result = await fetchEvmEventsIncremental(
      mockD1(),
      makeConfig(),
      "key",
      fromBlock,
      new Map(),
      makeBudget(),
      limiter,
      undefined,
      undefined,
      chainHead,
    );

    const expectedToBlock = fromBlock + EXPLORER_LOG_SCAN_WINDOWS.arbitrum - 1;
    expect(fetchEvmLogsForTopicWithCompleteness).toHaveBeenCalledWith(
      42161,
      expect.any(String),
      TOPIC_A,
      "key",
      fromBlock,
      expectedToBlock,
      0,
      limiter,
      expect.any(Object),
      undefined,
    );
    expect(expectedToBlock).toBeGreaterThan(99_999_999);
    expect(result).toMatchObject({
      scannedToBlock: expectedToBlock,
      safeHead: getEvmSafeHead(42161, chainHead),
      coverageOutcome: "incomplete",
    });
    expect(result.incomplete).toBe(true);
    expect(result.failureSamples).toContain("behind-safe-head");
  });

  it("fails visibly instead of treating a cursor ahead of the safe head as quiet", async () => {
    const result = await fetchEvmEventsIncremental(
      mockD1(),
      makeConfig(),
      "key",
      500_000_000,
      new Map(),
      makeBudget(),
      limiter,
      undefined,
      undefined,
      482_000_000,
    );

    expect(result).toMatchObject({
      rows: [],
      scannedToBlock: null,
      coverageOutcome: "cursor_ahead",
      incomplete: true,
      apiError: true,
    });
    expect(fetchEvmLogsForTopicWithCompleteness).not.toHaveBeenCalled();
  });

  it("advances only to the minimum frontier shared by every topic", async () => {
    vi.mocked(fetchEvmLogsForTopicWithCompleteness)
      .mockResolvedValueOnce({ logs: [], complete: true, scannedToBlock: 120, calls: 1, maxDepth: 0 })
      .mockResolvedValueOnce({
        logs: [],
        complete: false,
        scannedToBlock: 110,
        calls: 3,
        maxDepth: 2,
        failureReason: "provider-timeout",
      });

    const result = await fetchEvmEventsIncremental(
      mockD1(),
      makeConfig("arbitrum", [TOPIC_A, TOPIC_B]),
      "key",
      100,
      new Map(),
      makeBudget(),
      limiter,
      undefined,
      undefined,
      10_000,
    );

    expect(result).toMatchObject({
      scannedToBlock: 110,
      coverageOutcome: "partial",
      topicCount: 2,
      coveredTopicCount: 2,
      providerCalls: 4,
      maxSplitDepth: 2,
    });
  });

  it("keeps covered rows without advancing and recovers a missed topic on the next run", async () => {
    vi.mocked(fetchEvmLogsForTopicWithCompleteness)
      .mockResolvedValueOnce({
        logs: [{
          address: "0x" + "44".repeat(20),
          topics: [TOPIC_A, ADDRESS_WORD],
          data: "0x",
          blockNumber: "0x6e",
          timeStamp: "0x3e8",
          transactionHash: "0x" + "55".repeat(32),
          logIndex: "0x0",
        }],
        complete: true,
        scannedToBlock: 120,
        calls: 1,
        maxDepth: 0,
      })
      .mockResolvedValueOnce({
        logs: [],
        complete: false,
        scannedToBlock: 99,
        calls: 1,
        maxDepth: 0,
        failureReason: "provider-error",
      })
      .mockResolvedValueOnce({
        logs: [],
        complete: true,
        scannedToBlock: 120,
        calls: 1,
        maxDepth: 0,
      })
      .mockResolvedValueOnce({
        logs: [{
          address: "0x" + "44".repeat(20),
          topics: [TOPIC_B, ADDRESS_WORD],
          data: "0x",
          blockNumber: "0x73",
          timeStamp: "0x3e9",
          transactionHash: "0x" + "66".repeat(32),
          logIndex: "0x0",
        }],
        complete: true,
        scannedToBlock: 120,
        calls: 1,
        maxDepth: 0,
      });

    const config = makeConfig("arbitrum", [TOPIC_A, TOPIC_B]);
    const firstRun = await fetchEvmEventsIncremental(
      mockD1(),
      config,
      "key",
      100,
      new Map(),
      makeBudget(),
      limiter,
      undefined,
      undefined,
      10_000,
    );

    expect(firstRun).toMatchObject({
      scannedToBlock: 99,
      coverageOutcome: "missing_topic",
      coveredTopicCount: 1,
      maxBlock: 110,
    });
    expect(firstRun.rows.map((row) => row.block_number)).toEqual([110]);

    const secondRun = await fetchEvmEventsIncremental(
      mockD1(),
      config,
      "key",
      firstRun.scannedToBlock! + 1,
      new Map(),
      makeBudget(),
      limiter,
      undefined,
      undefined,
      10_000,
    );

    expect(secondRun).toMatchObject({
      scannedToBlock: 120,
      coverageOutcome: "incomplete",
      coveredTopicCount: 2,
      maxBlock: 115,
    });
    expect(secondRun.rows.map((row) => row.block_number)).toEqual([115]);
  });

  it("stops before the earliest RPC log whose timestamp is unresolved", async () => {
    const config = makeConfig("base");
    const chainRpcs = new Map<string, ChainRpcConfig>();
    chainRpcs.set("base", {
      chainId: "base",
      chainName: "Base",
      type: "evm",
      endpoints: [
        {
          url: "https://base.example",
          operator: "alchemy",
          keyed: true,
          position: "registry",
          stateHistory: "archive",
          logsHistory: "full",
        },
      ],
      explorerUrl: "https://basescan.org",
    });
    vi.mocked(getChainRpc).mockReturnValue(chainRpcs.get("base"));
    vi.mocked(getAlchemyBlockNumber).mockResolvedValue(1_000);
    vi.mocked(fetchAlchemyLogs).mockResolvedValue({
      logs: [
        {
          address: config.contractAddress,
          topics: [TOPIC_A, ADDRESS_WORD],
          data: "0x",
          blockNumber: "0x69",
          transactionHash: "0x" + "55".repeat(32),
          transactionIndex: "0x0",
          blockHash: "0x" + "66".repeat(32),
          logIndex: "0x0",
          removed: false,
        },
      ],
      complete: true,
      scannedToBlock: 200,
      calls: 1,
      maxDepth: 0,
    });
    vi.mocked(resolveBlockTimestamps).mockResolvedValue(new Map());

    const result = await fetchEvmEventsIncremental(
      mockD1(),
      config,
      null,
      100,
      new Map(),
      makeBudget(),
      limiter,
      undefined,
      chainRpcs,
    );

    expect(result).toMatchObject({
      rows: [],
      scannedToBlock: 104,
      coverageOutcome: "partial",
      usedRpcLogs: true,
    });
  });

  it.each([50, -50])("keeps the original topic safe head when RPC fallback moves by %i blocks", async (headDelta) => {
    const config = makeConfig("arbitrum", [TOPIC_A, TOPIC_B]);
    const rpc: ChainRpcConfig = {
      chainId: "arbitrum", chainName: "Arbitrum", type: "evm", explorerUrl: "https://arbiscan.io",
      endpoints: [{ url: "https://arb.example", operator: "public", keyed: false,
        position: "registry", stateHistory: "archive", logsHistory: "full" }],
    };
    const chainRpcs = new Map([["arbitrum", rpc]]);
    const originalHead = 10_000;
    const originalSafeHead = getEvmSafeHead(42161, originalHead);
    const availableSafeHead = Math.min(originalSafeHead, getEvmSafeHead(42161, originalHead + headDelta));
    vi.mocked(getChainRpc).mockReturnValue(rpc);
    vi.mocked(getAlchemyBlockNumber).mockResolvedValue(originalHead + headDelta);
    vi.mocked(fetchEvmLogsForTopicWithCompleteness)
      .mockResolvedValueOnce({ logs: [], complete: true, scannedToBlock: originalSafeHead, calls: 1, maxDepth: 0 })
      .mockResolvedValueOnce({ logs: [], complete: false, scannedToBlock: 5_999, calls: 1, maxDepth: 0 });
    vi.mocked(fetchAlchemyLogs).mockImplementation(async (_url, _address, _topics, _from, toBlock) => ({
      logs: [], complete: true, scannedToBlock: toBlock, calls: 1, maxDepth: 0,
    }));

    const result = await fetchEvmEventsIncremental(
      mockD1(), config, "key", 6_000, new Map(), makeBudget(), limiter, undefined, chainRpcs, originalHead,
    );

    expect(vi.mocked(fetchEvmLogsForTopicWithCompleteness).mock.calls.map((call) => call[5]))
      .toEqual([originalSafeHead, originalSafeHead]);
    expect(vi.mocked(fetchAlchemyLogs).mock.calls[0]?.[4]).toBe(availableSafeHead);
    expect(result).toMatchObject({
      safeHead: originalSafeHead, scannedToBlock: availableSafeHead, coveredTopicCount: 2,
      apiError: false, usedRpcLogs: true,
      coverageOutcome: headDelta > 0 ? "quiet" : "incomplete",
      incomplete: headDelta < 0,
    });
    expect(result.failureSamples).toEqual(headDelta > 0 ? [] : ["behind-safe-head"]);
  });

  it("uses a bounded RPC fallback when explorer head resolution failed", async () => {
    const config = makeConfig("arbitrum");
    const chainRpcs = new Map<string, ChainRpcConfig>();
    chainRpcs.set("arbitrum", {
      chainId: "arbitrum",
      chainName: "Arbitrum",
      type: "evm",
      endpoints: [
        {
          url: "https://arb.example",
          operator: "public",
          keyed: false,
          position: "registry",
          stateHistory: "archive",
          logsHistory: "full",
        },
      ],
      explorerUrl: "https://arbiscan.io",
    });
    vi.mocked(getChainRpc).mockReturnValue(chainRpcs.get("arbitrum"));
    vi.mocked(getAlchemyBlockNumber).mockResolvedValue(482_000_000);
    vi.mocked(fetchAlchemyLogs).mockImplementation(async (_url, _address, _topics, _from, toBlock) => ({
      logs: [],
      complete: true,
      scannedToBlock: toBlock,
      calls: 1,
      maxDepth: 0,
    }));

    const result = await fetchEvmEventsIncremental(
      mockD1(),
      config,
      null,
      450_000_000,
      new Map(),
      makeBudget(),
      limiter,
      undefined,
      chainRpcs,
      null,
    );

    expect(vi.mocked(fetchAlchemyLogs).mock.calls[0]?.[4]).toBe(450_249_999);
    expect(result).toMatchObject({ coverageOutcome: "incomplete", usedRpcLogs: true });
  });

  it("fails over to the secondary RPC when the primary proves zero log coverage", async () => {
    const config = makeConfig("base");
    const chainRpcs = new Map<string, ChainRpcConfig>();
    chainRpcs.set("base", {
      chainId: "base",
      chainName: "Base",
      type: "evm",
      endpoints: [
        {
          url: "https://primary.example",
          operator: "alchemy",
          keyed: true,
          position: "registry",
          stateHistory: "archive",
          logsHistory: "full",
        },
        {
          url: "https://fallback.example",
          operator: "public",
          keyed: false,
          position: "registry",
          stateHistory: "archive",
          logsHistory: "full",
        },
      ],
      explorerUrl: "https://basescan.org",
    });
    vi.mocked(getChainRpc).mockReturnValue(chainRpcs.get("base"));
    vi.mocked(getAlchemyBlockNumber).mockResolvedValue(1_000);
    vi.mocked(fetchAlchemyLogs)
      .mockResolvedValueOnce({
        logs: [],
        complete: false,
        scannedToBlock: 99,
        calls: 9,
        maxDepth: 8,
        failureReason: "split-limit",
      })
      .mockImplementationOnce(async (_url, _address, _topics, _from, toBlock) => ({
        logs: [],
        complete: true,
        scannedToBlock: toBlock,
        calls: 1,
        maxDepth: 0,
      }));

    const result = await fetchEvmEventsIncremental(
      mockD1(),
      config,
      null,
      100,
      new Map(),
      makeBudget(),
      limiter,
      undefined,
      chainRpcs,
    );

    expect(vi.mocked(fetchAlchemyLogs).mock.calls.map((call) => call[0])).toEqual([
      "https://primary.example",
      "https://fallback.example",
    ]);
    expect(result).toMatchObject({
      coverageOutcome: "quiet",
      usedRpcLogs: true,
      providerCalls: 10,
      maxSplitDepth: 8,
      failureSamples: ["primary-failover:split-limit"],
    });
  });

  it("honors an already-aborted run before opening a provider request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("lease lost"));

    await expect(
      fetchEvmEventsIncremental(
        mockD1(),
        makeConfig(),
        "key",
        100,
        new Map(),
        makeBudget(),
        limiter,
        controller.signal,
        undefined,
        1_000,
      ),
    ).rejects.toThrow("lease lost");
    expect(fetchEvmLogsForTopicWithCompleteness).not.toHaveBeenCalled();
  });
});
