import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { CONTRACT_CONFIGS } from "../../../lib/blacklist-contracts";
import { CIRCUIT_SOURCE } from "../../../lib/constants";
import type { BlacklistConfigState } from "../state";
import type { FetchTronEventsIncrementalResult } from "../tron-source";

const mocks = vi.hoisted(() => ({
  loadBlacklistConfigStates: vi.fn(),
  recordApiErrorConfig: vi.fn((
    entries: Array<Record<string, unknown>>,
    configKey: string,
    stablecoin: string,
    chainId: string,
    reason: string,
  ) => {
    entries.push({ configKey, stablecoin, chainId, reason });
  }),
  recordProcessedRows: vi.fn(),
  claimBlacklistConfigAttempt: vi.fn(),
  finalizeBlacklistConfigAttempt: vi.fn(),
  orderBlacklistConfigStatesFairly: vi.fn((states: BlacklistConfigState[]) => [...states]),
  recordBlacklistConfigSkips: vi.fn(),
  shouldAttemptFetch: vi.fn(),
  recordOutcomeSafe: vi.fn(),
  fetchEvmEventsIncremental: vi.fn(),
  fetchTronEventsIncremental: vi.fn(),
  fetchTronEventsWithRpc: vi.fn(),
  processFetchedBlacklistRows: vi.fn(),
  blacklistShouldStopBeforeNextConfig: vi.fn(),
  blacklistSubrequestBudgetReached: vi.fn(),
}));

vi.mock("../sync-support", () => ({
  loadBlacklistConfigStates: mocks.loadBlacklistConfigStates,
  recordApiErrorConfig: mocks.recordApiErrorConfig,
  recordProcessedRows: mocks.recordProcessedRows,
}));

vi.mock("../state", () => ({
  claimBlacklistConfigAttempt: mocks.claimBlacklistConfigAttempt,
  finalizeBlacklistConfigAttempt: mocks.finalizeBlacklistConfigAttempt,
  orderBlacklistConfigStatesFairly: mocks.orderBlacklistConfigStatesFairly,
  recordBlacklistConfigSkips: mocks.recordBlacklistConfigSkips,
}));

vi.mock("../../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: mocks.shouldAttemptFetch,
  recordOutcomeSafe: mocks.recordOutcomeSafe,
}));

vi.mock("../evm-source", () => ({
  fetchEvmEventsIncremental: mocks.fetchEvmEventsIncremental,
  shouldPreferRpcLogScan: vi.fn(() => true),
}));

vi.mock("../tron-source", () => ({
  fetchTronEventsIncremental: mocks.fetchTronEventsIncremental,
}));

vi.mock("../tron-rpc-source", () => ({ fetchTronEventsWithRpc: mocks.fetchTronEventsWithRpc }));

vi.mock("../post-fetch", () => ({
  processFetchedBlacklistRows: mocks.processFetchedBlacklistRows,
}));

vi.mock("../../../lib/blacklist/run-budget", () => ({
  blacklistShouldStopBeforeNextConfig: mocks.blacklistShouldStopBeforeNextConfig,
  blacklistSubrequestBudgetReached: mocks.blacklistSubrequestBudgetReached,
}));

vi.mock("../../../lib/cron-progress", () => ({ reportCronProgress: vi.fn() }));
vi.mock("../../../lib/structured-log", () => ({ logWorkerEventArgs: vi.fn() }));

import { BLACKLIST_COVERAGE_LAG_TOLERANCE_BLOCKS, scanBlacklistConfigs } from "../config-scan";

const EVM_CONFIG = CONTRACT_CONFIGS.find((config) => config.chain.type === "evm")!;
const TRON_CONFIG = CONTRACT_CONFIGS.find((config) => config.chain.type === "tron")!;

function makeState(
  config = EVM_CONFIG,
  overrides: Partial<BlacklistConfigState> = {},
): BlacklistConfigState {
  return {
    config,
    configKey: config.configKey,
    cursorKind: config.chain.type === "tron" ? "tron_timestamp_ms" : "evm_block",
    cursorValue: 100,
    attemptGeneration: 0,
    lastAttemptedAt: null,
    lastSucceededAt: null,
    lastSkippedAt: null,
    lastFailedAt: null,
    consecutiveSkips: 0,
    consecutiveFailures: 0,
    lastOutcome: null,
    ...overrides,
  };
}

function scanArgs() {
  return {
    db: mockD1(),
    etherscanApiKey: null,
    trongridApiKey: null,
    drpcApiKey: null,
    etherscanLimiter: async <T>(fn: () => Promise<T>) => fn(),
    tronLimiter: async <T>(fn: () => Promise<T>) => fn(),
    runBudget: {
      subrequestBudget: { count: 0, limit: 100 },
      deadlineMs: Date.now() + 60_000,
      minimumConfigWindowMs: 1_000,
    },
  };
}

function evmResult() {
  return {
    rows: [],
    maxBlock: 120,
    apiError: false,
    chainHead: 1_000,
    usedRpcLogs: true,
    scannedToBlock: 120,
    safeHead: 120,
    incomplete: false,
    coverageOutcome: "quiet",
    topicCount: 1,
    coveredTopicCount: 1,
    providerCalls: 1,
    maxSplitDepth: 0,
    failureSamples: [],
  } as const;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.shouldAttemptFetch.mockResolvedValue(true);
  mocks.blacklistShouldStopBeforeNextConfig.mockReturnValue(false);
  mocks.blacklistSubrequestBudgetReached.mockReturnValue(false);
  mocks.claimBlacklistConfigAttempt.mockImplementation(
    async (_db: D1Database, state: BlacklistConfigState, attemptedAt: number) => ({
      configKey: state.configKey,
      cursorKind: state.cursorKind,
      expectedCursor: state.cursorValue,
      generation: state.attemptGeneration + 1,
      attemptedAt,
    }),
  );
  mocks.finalizeBlacklistConfigAttempt.mockResolvedValue(true);
  mocks.recordBlacklistConfigSkips.mockResolvedValue(undefined);
  mocks.fetchEvmEventsIncremental.mockResolvedValue(evmResult());
  mocks.processFetchedBlacklistRows.mockResolvedValue({
    insertedRows: 0,
    enrichCounters: { attempted: 0, succeeded: 0, failed: 0 },
    currentBalanceCacheCounters: {
      updated: 0,
      failed: 0,
      skippedDueBudget: 0,
      budgetExhausted: false,
    },
  });
});

describe("blacklist config scan accounting", () => {
  it.each([2, 52, BLACKLIST_COVERAGE_LAG_TOLERANCE_BLOCKS])(
    "tolerates a proven all-topic %i-block residual without renewing full coverage", async (lag) => {
      const state = makeState(EVM_CONFIG, { lastSucceededAt: 10 });
      mocks.loadBlacklistConfigStates.mockResolvedValue({ configStates: [state], zeroCursorConfigs: [] });
      mocks.fetchEvmEventsIncremental.mockResolvedValueOnce({
        ...evmResult(), safeHead: 120 + lag, incomplete: true, coverageOutcome: "incomplete",
        failureSamples: ["behind-safe-head"],
      });
      const result = await scanBlacklistConfigs(scanArgs());
      expect(result.coverageVerdicts[state.configKey]).toBe("lagging-within-tolerance");
      expect(result.configsSucceeded).toBe(0);
      expect(result.runtimeBudgetHit).toBe(false);
      expect(state.lastSucceededAt).toBe(10);
      expect(result.coverageFailureConfigs[0]).toMatchObject({ lag, samples: ["behind-safe-head"] });
    },
  );

  it.each([
    { safeHead: 121 + BLACKLIST_COVERAGE_LAG_TOLERANCE_BLOCKS },
    { apiError: true },
    { coveredTopicCount: 0 },
    { scannedToBlock: null },
    { safeHead: null },
    { safeHead: Number.NaN },
    { failureSamples: ["behind-safe-head", "decode-error"] },
  ])("keeps missing or failed evidence outside tolerance: %j", async (overrides) => {
    const state = makeState();
    mocks.loadBlacklistConfigStates.mockResolvedValue({ configStates: [state], zeroCursorConfigs: [] });
    mocks.fetchEvmEventsIncremental.mockResolvedValueOnce({
      ...evmResult(), safeHead: 122, incomplete: true, coverageOutcome: "incomplete",
      failureSamples: ["behind-safe-head"], ...overrides,
    });
    const result = await scanBlacklistConfigs(scanArgs());
    expect(result.coverageVerdicts[state.configKey]).toBe("failed");
  });

  it("retains catch-up progress and lag without refreshing success until safe head is reached", async () => {
    const state = makeState(EVM_CONFIG, { lastSucceededAt: 10 });
    mocks.loadBlacklistConfigStates.mockResolvedValue({ configStates: [state], zeroCursorConfigs: [] });
    mocks.fetchEvmEventsIncremental.mockResolvedValueOnce({
      ...evmResult(), safeHead: 900, incomplete: true, coverageOutcome: "incomplete",
      failureSamples: ["behind-safe-head"],
    });
    const first = await scanBlacklistConfigs(scanArgs());
    expect(state.cursorValue).toBe(120);
    expect(state.lastSucceededAt).toBe(10);
    expect(first.configsSucceeded).toBe(0);
    expect(first.runtimeBudgetHit).toBe(false);
    expect(first.configLag[state.configKey]).toEqual({ cursorKind: "evm_block", frontier: 120, safeHead: 900, lag: 780 });
    expect(first.coverageFailureConfigs).toEqual([{
      configKey: state.configKey, outcome: "incomplete", cursorKind: "evm_block",
      frontier: 120, safeHead: 900, lag: 780, samples: ["behind-safe-head"],
    }]);
    mocks.fetchEvmEventsIncremental.mockResolvedValueOnce({ ...evmResult(), scannedToBlock: 900, safeHead: 900 });
    const second = await scanBlacklistConfigs(scanArgs());
    expect(second.configsSucceeded).toBe(1);
    expect(state.cursorValue).toBe(900);
    expect(state.lastSucceededAt).toBeGreaterThan(10);
    expect(second.configLag[state.configKey]?.lag).toBe(0);
    expect(second.coverageVerdicts[state.configKey]).toBe("covered");
    expect(second.coverageFailureConfigs).toEqual([]);
  });

  it("samples only the first six failed source scans without capping failure counts", async () => {
    const states = Array.from({ length: 9 }, (_, index) =>
      makeState(EVM_CONFIG, { configKey: `${EVM_CONFIG.configKey}-${index}` }),
    );
    mocks.loadBlacklistConfigStates.mockResolvedValue({ configStates: states, zeroCursorConfigs: [] });
    for (let index = 0; index < 8; index++) {
      mocks.fetchEvmEventsIncremental.mockResolvedValueOnce({
        ...evmResult(), safeHead: 900, incomplete: true, coverageOutcome: "incomplete",
        failureSamples: ["behind-safe-head"],
      });
    }

    const result = await scanBlacklistConfigs(scanArgs());

    expect(result).toMatchObject({
      configsAttempted: 9, configsSucceeded: 1,
      coverageOutcomeCounts: { incomplete: 8, quiet: 1 },
      coverageVerdicts: Object.fromEntries(states.map((state, index) => [state.configKey, index < 8 ? "failed" : "covered"])),
    });
    expect(result.coverageFailureConfigs).toEqual(states.slice(0, 6).map((state) => ({
      configKey: state.configKey, outcome: "incomplete", cursorKind: "evm_block",
      frontier: 120, safeHead: 900, lag: 780, samples: ["behind-safe-head"],
    })));
  });

  it("retains unavailable frontier evidence instead of inventing zero lag", async () => {
    const state = makeState();
    mocks.loadBlacklistConfigStates.mockResolvedValue({ configStates: [state], zeroCursorConfigs: [] });
    mocks.fetchEvmEventsIncremental.mockResolvedValueOnce({
      ...evmResult(), apiError: true, coverageOutcome: "provider_error",
      scannedToBlock: null, safeHead: null, failureSamples: ["rpc-error"],
    });

    const result = await scanBlacklistConfigs(scanArgs());

    expect(result.configsSucceeded).toBe(0);
    expect(result.coverageFailureConfigs).toEqual([{
      configKey: state.configKey, outcome: "provider_error", cursorKind: "evm_block",
      frontier: null, safeHead: null, lag: null, samples: ["rpc-error"],
    }]);
  });

  it("keeps Tron failure diagnostic units and source reason", async () => {
    const state = makeState(TRON_CONFIG);
    mocks.loadBlacklistConfigStates.mockResolvedValue({ configStates: [state], zeroCursorConfigs: [] });
    mocks.fetchTronEventsIncremental.mockResolvedValueOnce({
      rows: [], maxBlock: 120, scannedToTimestamp: 120_000, safeHead: 900_000,
      incomplete: true, apiError: false, topicCount: 1, coveredTopicCount: 0, providerCalls: 1,
    });

    const result = await scanBlacklistConfigs(scanArgs());

    expect(result).toMatchObject({
      configsAttempted: 1, configsSucceeded: 0, incompleteRuntimeConfigs: 1, runtimeBudgetHit: true,
    });
    expect(result.coverageFailureConfigs).toEqual([{
      configKey: state.configKey, outcome: "incomplete", cursorKind: "tron_timestamp_ms",
      frontier: 120_000, safeHead: 900_000, lag: 780_000, samples: ["trongrid-incomplete"],
    }]);
  });

  it("records every remaining config when the budget is reached mid-loop", async () => {
    const states = [makeState(), makeState(EVM_CONFIG, { configKey: `${EVM_CONFIG.configKey}-2` }), makeState(EVM_CONFIG, { configKey: `${EVM_CONFIG.configKey}-3` })];
    mocks.loadBlacklistConfigStates.mockResolvedValue({ configStates: states, zeroCursorConfigs: [] });
    mocks.blacklistShouldStopBeforeNextConfig.mockReturnValueOnce(false).mockReturnValueOnce(true);

    const result = await scanBlacklistConfigs(scanArgs());

    expect(result).toMatchObject({ runtimeBudgetHit: true, contractsSkipped: 2, configsAttempted: 1 });
    expect(mocks.recordBlacklistConfigSkips).toHaveBeenCalledWith(
      expect.anything(),
      states.slice(1),
      expect.any(Number),
      undefined,
    );
    expect(states.slice(1).map((state) => state.lastOutcome)).toEqual(["budget_skipped", "budget_skipped"]);
  });

  it("counts a failed attempt claim as a conflict and skip", async () => {
    const state = makeState();
    mocks.loadBlacklistConfigStates.mockResolvedValue({ configStates: [state], zeroCursorConfigs: [] });
    mocks.claimBlacklistConfigAttempt.mockResolvedValueOnce(null);

    const result = await scanBlacklistConfigs(scanArgs());

    expect(result).toMatchObject({ stateConflicts: 1, contractsSkipped: 1, configsAttempted: 0 });
    expect(result.apiErrorConfigs).toEqual([
      expect.objectContaining({ configKey: state.configKey, reason: "state-claim-conflict" }),
    ]);
    expect(mocks.fetchEvmEventsIncremental).not.toHaveBeenCalled();
  });

  it("finalizes a Tron config skipped by an open provider circuit", async () => {
    const state = makeState(TRON_CONFIG);
    mocks.loadBlacklistConfigStates.mockResolvedValue({ configStates: [state], zeroCursorConfigs: [] });
    mocks.shouldAttemptFetch.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = await scanBlacklistConfigs(scanArgs());

    expect(result).toMatchObject({
      contractsSkipped: 1,
      providerCircuitSkips: 1,
      tronGridCircuitSkips: 1,
      configsAttempted: 1,
      coverageOutcomeCounts: { provider_skipped: 1 },
      coverageFailureConfigs: [],
    });
    expect(mocks.finalizeBlacklistConfigAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ outcome: "provider_skipped" }),
      undefined,
    );
    expect(state.lastOutcome).toBe("provider_skipped");
    expect(mocks.fetchTronEventsIncremental).not.toHaveBeenCalled();
  });

  it("records and finalizes exceptions without losing failure counters", async () => {
    const state = makeState();
    mocks.loadBlacklistConfigStates.mockResolvedValue({ configStates: [state], zeroCursorConfigs: [] });
    mocks.fetchEvmEventsIncremental.mockRejectedValueOnce(new TypeError("provider exploded"));

    const result = await scanBlacklistConfigs(scanArgs());

    expect(result).toMatchObject({
      apiErrors: 1,
      configsAttempted: 1,
      stateConflicts: 0,
      apiErrorClasses: { TypeError: 1 },
      coverageOutcomeCounts: { exception: 1 },
      coverageFailureConfigs: [],
    });
    expect(result.apiErrorConfigs).toEqual([
      expect.objectContaining({ configKey: state.configKey, reason: "exception:TypeError" }),
    ]);
    expect(mocks.finalizeBlacklistConfigAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ outcome: "exception" }),
      undefined,
    );
    expect(state).toMatchObject({ lastOutcome: "exception", consecutiveFailures: 1, consecutiveSkips: 0 });
  });
});


describe("Tron native scan admission", () => {
  const telemetry = {
    source: "dwellir-jsonrpc", dwellirCalls: 5, trongridRpcCalls: 0, eventApiCalls: 0,
    trongridFailureReason: null,
    fallbackReason: null, orderRepairSkippedRows: 0, orderRepairSkipReason: null,
    amountRepairSkippedRows: 0, amountRepairSkipReason: null,
  };
  const result = {
    rows: [], maxBlock: 200, scannedToTimestamp: 200, safeHead: 200,
    incomplete: false, apiError: false, topicCount: 3, coveredTopicCount: 3,
    providerCalls: 5, usedRpcLogs: true, tronRpc: telemetry,
  };

  it("keeps admitted Dwellir scanning with TronGrid's circuit open without recording a TronGrid success", async () => {
    const state = makeState(TRON_CONFIG);
    mocks.loadBlacklistConfigStates.mockResolvedValue({ configStates: [state], zeroCursorConfigs: [] });
    mocks.shouldAttemptFetch.mockResolvedValue(false);
    mocks.fetchTronEventsWithRpc.mockResolvedValue(result);
    const summary = await scanBlacklistConfigs({ ...scanArgs(), dwellirNative: { readJson: vi.fn() } });
    expect(mocks.fetchTronEventsWithRpc).toHaveBeenCalledWith(expect.objectContaining({ eventApiAllowed: false }));
    expect(mocks.fetchTronEventsIncremental).not.toHaveBeenCalled();
    expect(mocks.recordOutcomeSafe).not.toHaveBeenCalled();
    expect(summary.tronRpc[TRON_CONFIG.configKey]).toEqual(telemetry);
    expect(summary.configsSucceeded).toBe(1);
    expect(summary.rpcLogConfigs).toBe(1);
    expect(mocks.finalizeBlacklistConfigAttempt).toHaveBeenCalledWith(expect.anything(), expect.anything(),
      expect.objectContaining({ nextCursor: 200, observedSafeHead: 200, outcome: "quiet" }), undefined);
  });

  it("preserves partial all-topic progress without renewing the full-coverage clock", async () => {
    const state = makeState(TRON_CONFIG, { lastSucceededAt: 10 });
    mocks.loadBlacklistConfigStates.mockResolvedValue({ configStates: [state], zeroCursorConfigs: [] });
    mocks.fetchTronEventsWithRpc.mockResolvedValue({ ...result, safeHead: 300, incomplete: true });
    const summary = await scanBlacklistConfigs({ ...scanArgs(), dwellirNative: { readJson: vi.fn() } });
    expect(summary.configsSucceeded).toBe(0);
    expect(state.lastSucceededAt).toBe(10);
    expect(state.cursorValue).toBe(200);
    expect(mocks.finalizeBlacklistConfigAttempt).toHaveBeenCalledWith(expect.anything(), expect.anything(),
      expect.objectContaining({ nextCursor: 200, outcome: "partial" }), undefined);
  });

  it("keeps a stale solid-head failure unavailable without advancing its cursor or success clock", async () => {
    const desiredSafeHead = 1_793_196_000_000;
    const cursorValue = desiredSafeHead - 6 * 60 * 60_000;
    const lastSucceededAt = Math.floor(cursorValue / 1000);
    const state = makeState(TRON_CONFIG, { cursorValue, lastSucceededAt });
    mocks.loadBlacklistConfigStates.mockResolvedValue({ configStates: [state], zeroCursorConfigs: [] });
    const staleResult: FetchTronEventsIncrementalResult = {
      ...result,
      maxBlock: cursorValue,
      scannedToTimestamp: null,
      safeHead: desiredSafeHead,
      incomplete: true,
      apiError: true,
      coveredTopicCount: 0,
      failureSamples: ["tron-rpc-stale-solid-head"],
      tronRpc: { ...telemetry, source: "unavailable", fallbackReason: "tron-rpc-stale-solid-head" },
    };
    mocks.fetchTronEventsWithRpc.mockResolvedValueOnce(staleResult);

    const summary = await scanBlacklistConfigs({ ...scanArgs(), dwellirNative: { readJson: vi.fn() } });

    expect(state).toMatchObject({ cursorValue, lastSucceededAt, lastOutcome: "provider_error", consecutiveFailures: 1 });
    expect(summary).toMatchObject({ configsAttempted: 1, configsSucceeded: 0, apiErrors: 1,
      runtimeBudgetHit: false, coverageOutcomeCounts: { provider_error: 1 } });
    expect(summary.coverageVerdicts[state.configKey]).toBe("failed");
    expect(summary.configLag[state.configKey]).toEqual({
      cursorKind: "tron_timestamp_ms", frontier: null, safeHead: desiredSafeHead, lag: null,
    });
    expect(summary.coverageFailureConfigs).toEqual([{
      configKey: state.configKey, outcome: "provider_error", cursorKind: "tron_timestamp_ms",
      frontier: null, safeHead: desiredSafeHead, lag: null, samples: ["tron-rpc-stale-solid-head"],
    }]);
    expect(mocks.finalizeBlacklistConfigAttempt).toHaveBeenCalledExactlyOnceWith(
      expect.anything(), expect.objectContaining({ expectedCursor: cursorValue }),
      expect.objectContaining({ nextCursor: null, observedSafeHead: desiredSafeHead, outcome: "provider_error" }),
      undefined,
    );
    expect(mocks.fetchTronEventsIncremental).not.toHaveBeenCalled();
  });

  it("retains the old event path when Tron is disabled in the admitted capability", async () => {
    const state = makeState(TRON_CONFIG);
    mocks.loadBlacklistConfigStates.mockResolvedValue({ configStates: [state], zeroCursorConfigs: [] });
    mocks.fetchTronEventsIncremental.mockResolvedValue({ ...result, usedRpcLogs: false, tronRpc: undefined });
    await scanBlacklistConfigs({ ...scanArgs(), dwellirNative: { readJson: vi.fn(), isNetworkEnabled: () => false } });
    expect(mocks.fetchTronEventsWithRpc).not.toHaveBeenCalled();
    expect(mocks.fetchTronEventsIncremental).toHaveBeenCalledOnce();
  });

  it("leaves the TronGrid circuit untouched when local admission truncates the event scan", async () => {
    const state = makeState(TRON_CONFIG);
    mocks.loadBlacklistConfigStates.mockResolvedValue({ configStates: [state], zeroCursorConfigs: [] });
    mocks.fetchTronEventsIncremental.mockResolvedValue({
      ...result, usedRpcLogs: false, tronRpc: undefined,
      incomplete: true, apiError: false, scannedToTimestamp: null,
      coveredTopicCount: 0, localBudgetStop: true,
    });

    const summary = await scanBlacklistConfigs({ ...scanArgs(), dwellirNative: { readJson: vi.fn(), isNetworkEnabled: () => false } });

    expect(mocks.recordOutcomeSafe).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ apiErrors: 0, runtimeBudgetHit: true, coverageOutcomeCounts: { incomplete: 1 } });
  });

  it("records an observed TronGrid failure even when the scan ends on a neutral request budget limit", async () => {
    mocks.loadBlacklistConfigStates.mockResolvedValue({ configStates: [makeState(TRON_CONFIG)], zeroCursorConfigs: [] });
    mocks.fetchTronEventsWithRpc.mockResolvedValue({ ...result, incomplete: true, apiError: false, safeHead: 300,
      tronRpc: { ...telemetry, trongridRpcCalls: 1, fallbackReason: "tron-rpc-budget-exhausted",
        trongridFailureReason: "tron-rpc-transport-error" },
    });
    await scanBlacklistConfigs({ ...scanArgs(), dwellirNative: { readJson: vi.fn() } });
    expect(mocks.recordOutcomeSafe).toHaveBeenCalledExactlyOnceWith(expect.anything(), CIRCUIT_SOURCE.TRONGRID, false);
    expect(mocks.finalizeBlacklistConfigAttempt).toHaveBeenCalledWith(expect.anything(), expect.anything(),
      expect.objectContaining({ nextCursor: 200, outcome: "partial" }), undefined);
  });

  it("rechecks TronGrid admission after a failed config opens its circuit while continuing Dwellir", async () => {
    const configs = CONTRACT_CONFIGS.filter((config) => config.chain.type === "tron");
    mocks.loadBlacklistConfigStates.mockResolvedValue({ configStates: configs.map((config) => makeState(config)), zeroCursorConfigs: [] });
    let tronGridAllowed = true;
    mocks.shouldAttemptFetch.mockImplementation(async (_db, source) => source !== CIRCUIT_SOURCE.TRONGRID || tronGridAllowed);
    mocks.recordOutcomeSafe.mockImplementationOnce(async (_db, source, successful) => {
      if (source === CIRCUIT_SOURCE.TRONGRID && !successful) tronGridAllowed = false;
    });
    mocks.fetchTronEventsWithRpc.mockResolvedValueOnce({ ...result,
      incomplete: true, apiError: true, scannedToTimestamp: null, coveredTopicCount: 0,
      tronRpc: { ...telemetry, trongridRpcCalls: 1, fallbackReason: "tron-rpc-providers-unavailable",
        trongridFailureReason: "tron-rpc-transport-error" },
    }).mockResolvedValue(result);
    const readJson = vi.fn().mockRejectedValue(new Error("Dwellir unavailable"));
    const summary = await scanBlacklistConfigs({ ...scanArgs(), dwellirNative: { readJson } });
    expect(mocks.fetchTronEventsWithRpc.mock.calls.map(([args]) => args.eventApiAllowed)).toEqual([true, false]);
    expect(summary.configsAttempted).toBe(2);
    expect(mocks.fetchTronEventsIncremental).not.toHaveBeenCalled();
    expect(mocks.recordOutcomeSafe).toHaveBeenCalledExactlyOnceWith(expect.anything(), CIRCUIT_SOURCE.TRONGRID, false);

    // The shared RPC reader must honor the updated gate too, not only the event fallback.
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
    try {
      await expect(mocks.fetchTronEventsWithRpc.mock.calls[1][0].reader.getBlock(1))
        .rejects.toThrow("tron-rpc-providers-unavailable");
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      fetcher.mockRestore();
    }
  });
});
