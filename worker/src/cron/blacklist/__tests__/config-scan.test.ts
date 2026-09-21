import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { CONTRACT_CONFIGS } from "../../../lib/blacklist-contracts";
import type { BlacklistConfigState } from "../state";

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

vi.mock("../post-fetch", () => ({
  processFetchedBlacklistRows: mocks.processFetchedBlacklistRows,
}));

vi.mock("../../../lib/blacklist/run-budget", () => ({
  blacklistShouldStopBeforeNextConfig: mocks.blacklistShouldStopBeforeNextConfig,
  blacklistSubrequestBudgetReached: mocks.blacklistSubrequestBudgetReached,
}));

vi.mock("../../../lib/cron-progress", () => ({ reportCronProgress: vi.fn() }));
vi.mock("../../../lib/structured-log", () => ({ logWorkerEventArgs: vi.fn() }));

import { scanBlacklistConfigs } from "../config-scan";

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
    safeHead: 900,
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
