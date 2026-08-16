import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../../test-helpers/__shared/mock-d1";
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
import { getChainRpc, type ChainRpcConfig } from "../../../lib/chain-registry";

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
      coverageOutcome: "quiet",
    });
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

  it("pins the cursor when a required topic has no proven coverage", async () => {
    vi.mocked(fetchEvmLogsForTopicWithCompleteness)
      .mockResolvedValueOnce({ logs: [], complete: true, scannedToBlock: 120, calls: 1, maxDepth: 0 })
      .mockResolvedValueOnce({
        logs: [],
        complete: false,
        scannedToBlock: 99,
        calls: 1,
        maxDepth: 0,
        failureReason: "provider-error",
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
      scannedToBlock: null,
      coverageOutcome: "missing_topic",
      coveredTopicCount: 1,
    });
  });

  it("stops before the earliest RPC log whose timestamp is unresolved", async () => {
    const config = makeConfig("base");
    const chainRpcs = new Map<string, ChainRpcConfig>();
    chainRpcs.set("base", {
      chainId: "base",
      chainName: "Base",
      type: "evm",
      rpcUrl: "https://base.example",
      alchemyPrimary: true,
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

  it("uses a bounded RPC fallback when explorer head resolution failed", async () => {
    const config = makeConfig("arbitrum");
    const chainRpcs = new Map<string, ChainRpcConfig>();
    chainRpcs.set("arbitrum", {
      chainId: "arbitrum",
      chainName: "Arbitrum",
      type: "evm",
      rpcUrl: "https://arb.example",
      alchemyPrimary: false,
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
    expect(result).toMatchObject({ coverageOutcome: "quiet", usedRpcLogs: true });
  });

  it("fails over to the secondary RPC when the primary proves zero log coverage", async () => {
    const config = makeConfig("base");
    const chainRpcs = new Map<string, ChainRpcConfig>();
    chainRpcs.set("base", {
      chainId: "base",
      chainName: "Base",
      type: "evm",
      rpcUrl: "https://primary.example",
      fallbackRpcUrl: "https://fallback.example",
      alchemyPrimary: true,
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
