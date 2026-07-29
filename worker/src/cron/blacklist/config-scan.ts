import { CIRCUIT_SOURCE } from "../../lib/constants";
import { shouldAttemptFetch, recordOutcomeSafe } from "../../lib/circuit-breaker";
import { type RateLimitedFetch, getEvmBlockNumber } from "../../lib/evm-logs";
import { type ChainRpcConfig } from "../../lib/chain-registry";
import { throwIfAborted } from "../../lib/abort";
import type { CronProgressReporter } from "../../lib/cron-logger";
import { reportCronProgress } from "../../lib/cron-progress";
import { CONTRACT_CONFIGS } from "../../lib/blacklist-contracts";
import {
  fetchEvmEventsIncremental,
  shouldPreferRpcLogScan,
  type FetchEvmEventsIncrementalResult,
} from "./evm-source";
import { fetchTronEventsIncremental, type FetchTronEventsIncrementalResult } from "./tron-source";
import type { BlacklistScanResult } from "./shared";
import { processFetchedBlacklistRows } from "./post-fetch";
import {
  blacklistShouldStopBeforeNextConfig,
  blacklistSubrequestBudgetReached,
  type BlacklistRunBudget,
} from "./run-budget";
import {
  loadBlacklistConfigStates,
  recordApiErrorConfig,
  recordProcessedRows,
  type SyncBlacklistApiErrorConfig,
} from "./sync-support";
import { toErrorMessage } from "../../lib/error-utils";
import {
  claimBlacklistConfigAttempt,
  finalizeBlacklistConfigAttempt,
  orderBlacklistConfigStatesFairly,
  recordBlacklistConfigSkips,
  type BlacklistConfigAttempt,
  type BlacklistConfigState,
} from "./state";
import type { BlacklistProviderScanTelemetry } from "./provider-telemetry";

type ScanCounters = {
  totalInsertedRows: number;
  enrichCounters: { attempted: number; succeeded: number; failed: number };
  currentBalanceCacheCounters: { updated: number; deleted: number; failed: number };
};

type ScanState = {
  totalFetchedEvents: number;
  contractsSkipped: number;
  apiErrors: number;
  rpcLogConfigs: number;
  runtimeBudgetHit: boolean;
  providerCircuitSkips: number;
  etherscanCircuitSkips: number;
  tronGridCircuitSkips: number;
  incompleteRuntimeConfigs: number;
  counters: ScanCounters;
  apiErrorClasses: Record<string, number>;
  apiErrorConfigs: SyncBlacklistApiErrorConfig[];
  configsAttempted: number;
  configsSucceeded: number;
  stateConflicts: number;
  blacklistProviderCalls: number;
  maxProviderSplitDepth: number;
  providerScanTelemetry: BlacklistProviderScanTelemetry[];
  coverageOutcomeCounts: Record<string, number>;
};

export type BlacklistConfigScanSummary = ScanState & {
  configStates: BlacklistConfigState[];
  zeroCursorConfigs: string[];
  etherscanCircuitAllowed: boolean;
};

type ScanBlacklistConfigsArgs = {
  db: D1Database;
  etherscanApiKey: string | null;
  trongridApiKey: string | null;
  drpcApiKey: string | null;
  etherscanLimiter: RateLimitedFetch;
  tronLimiter: RateLimitedFetch;
  runBudget: BlacklistRunBudget;
  signal?: AbortSignal;
  onProgress?: CronProgressReporter;
  chainRpcs?: Map<string, ChainRpcConfig>;
};

type ScanSingleConfigArgs = ScanBlacklistConfigsArgs & {
  state: ScanState;
  configState: BlacklistConfigState;
  attempt: BlacklistConfigAttempt;
  etherscanCircuitAllowed: boolean;
  chainHeadCache: Map<number, number>;
  getChainTimestampCache: (chainId: string) => Map<number, number>;
};

function buildTronScanResult(result: FetchTronEventsIncrementalResult, lastCursor: number): BlacklistScanResult {
  const nextCursor = result.scannedToTimestamp != null ? Math.max(lastCursor, result.scannedToTimestamp) : lastCursor;
  const coverageOutcome = result.apiError
    ? result.coveredTopicCount > 0
      ? "missing_topic"
      : "provider_error"
    : result.incomplete
      ? result.coveredTopicCount > 0
        ? "missing_topic"
        : "incomplete"
      : result.rows.length > 0
        ? "complete"
        : "quiet";

  return {
    rows: result.rows,
    latestCursor: result.maxBlock,
    nextCursor: nextCursor > lastCursor ? nextCursor : null,
    apiError: result.apiError,
    incomplete: result.incomplete,
    usedRpcLogs: false,
    scannedToCursor: result.scannedToTimestamp,
    safeHead: result.safeHead,
    coverageOutcome,
    topicCount: result.topicCount,
    coveredTopicCount: result.coveredTopicCount,
    providerCalls: result.providerCalls,
    maxSplitDepth: 0,
    failureSamples: result.apiError || result.incomplete ? ["trongrid-incomplete"] : [],
  };
}

function buildEvmScanResult(args: {
  result: FetchEvmEventsIncrementalResult;
  lastCursor: number;
}): BlacklistScanResult {
  const { result } = args;
  const nextCursor = result.scannedToBlock != null ? Math.max(args.lastCursor, result.scannedToBlock) : args.lastCursor;

  return {
    rows: result.rows,
    latestCursor: result.maxBlock,
    nextCursor: nextCursor !== args.lastCursor ? nextCursor : null,
    apiError: result.apiError,
    incomplete: result.incomplete,
    usedRpcLogs: result.usedRpcLogs,
    scannedToCursor: result.scannedToBlock,
    safeHead: result.safeHead,
    coverageOutcome: result.coverageOutcome,
    topicCount: result.topicCount,
    coveredTopicCount: result.coveredTopicCount,
    providerCalls: result.providerCalls,
    maxSplitDepth: result.maxSplitDepth,
    failureSamples: result.failureSamples,
  };
}

async function scanBlacklistConfig(args: {
  db: D1Database;
  config: (typeof CONTRACT_CONFIGS)[number];
  lastBlock: number;
  runBudget: BlacklistRunBudget;
  etherscanApiKey: string | null;
  etherscanCircuitAllowed: boolean;
  trongridApiKey: string | null;
  etherscanLimiter: RateLimitedFetch;
  tronLimiter: RateLimitedFetch;
  signal?: AbortSignal;
  chainHeadCache: Map<number, number>;
  chainRpcs?: Map<string, ChainRpcConfig>;
  getChainTimestampCache: (chainId: string) => Map<number, number>;
}): Promise<BlacklistScanResult> {
  if (args.config.chain.type === "tron") {
    const result = await fetchTronEventsIncremental(
      args.config,
      args.trongridApiKey,
      args.lastBlock,
      args.runBudget,
      args.tronLimiter,
      args.signal,
    );
    return buildTronScanResult(result, args.lastBlock);
  }

  const evmChainId = args.config.chain.evmChainId!;
  const configuredStartBlock =
    typeof args.config.startBlock === "number" && Number.isFinite(args.config.startBlock) && args.config.startBlock > 0
      ? Math.floor(args.config.startBlock)
      : 0;
  const fromBlock = args.lastBlock > 0 ? args.lastBlock + 1 : configuredStartBlock;
  let knownChainHead = args.chainHeadCache.get(evmChainId) ?? null;
  if (knownChainHead == null && args.etherscanCircuitAllowed && !shouldPreferRpcLogScan(args.config.chain.chainId)) {
    knownChainHead = await getEvmBlockNumber(
      evmChainId,
      args.etherscanApiKey,
      args.etherscanLimiter,
      args.runBudget.subrequestBudget,
      args.signal,
    );
    if (knownChainHead != null) args.chainHeadCache.set(evmChainId, knownChainHead);
  }

  const result = await fetchEvmEventsIncremental(
    args.db,
    args.config,
    args.etherscanApiKey,
    fromBlock,
    args.getChainTimestampCache(args.config.chain.chainId),
    args.runBudget,
    args.etherscanLimiter,
    args.signal,
    args.chainRpcs,
    knownChainHead,
  );

  if (result.chainHead != null) args.chainHeadCache.set(evmChainId, result.chainHead);

  return buildEvmScanResult({ result, lastCursor: args.lastBlock });
}

function recordProviderTelemetry(
  state: ScanState,
  configState: BlacklistConfigState,
  result: BlacklistScanResult,
  insertedRowsForConfig: number,
): void {
  const { config, configKey, cursorValue } = configState;
  state.blacklistProviderCalls += result.providerCalls;
  state.maxProviderSplitDepth = Math.max(state.maxProviderSplitDepth, result.maxSplitDepth);
  state.coverageOutcomeCounts[result.coverageOutcome] = (state.coverageOutcomeCounts[result.coverageOutcome] ?? 0) + 1;
  state.providerScanTelemetry.push({
    configKey,
    chainId: config.chain.chainId,
    providerMode:
      config.chain.type === "tron"
        ? "trongrid"
        : result.usedRpcLogs
          ? result.topicCount > 1
            ? "rpc-or-topics"
            : "rpc"
          : "etherscan",
    coverageOutcome: result.coverageOutcome,
    fromCursor: cursorValue,
    scannedToCursor: result.scannedToCursor,
    safeHead: result.safeHead,
    fetchedRowCount: result.rows.length,
    insertedRowCount: insertedRowsForConfig,
    providerCallCount: result.providerCalls,
    maxSplitDepth: result.maxSplitDepth,
    failureSamples: result.failureSamples,
    observedAt: Math.floor(Date.now() / 1000),
  });
}

async function finalizeSuccessfulConfigScan(
  db: D1Database,
  configState: BlacklistConfigState,
  attempt: BlacklistConfigAttempt,
  result: BlacklistScanResult,
  state: ScanState,
  signal?: AbortSignal,
): Promise<void> {
  const completedAt = Math.floor(Date.now() / 1000);
  const finalized = await finalizeBlacklistConfigAttempt(
    db,
    attempt,
    {
      outcome: result.coverageOutcome,
      nextCursor: result.nextCursor,
      observedSafeHead: result.safeHead,
      completedAt,
    },
    signal,
  );
  if (!finalized) {
    state.stateConflicts++;
    state.apiErrors++;
    recordApiErrorConfig(
      state.apiErrorConfigs,
      configState.configKey,
      configState.config.stablecoin,
      configState.config.chain.chainId,
      "state-finalize-conflict",
    );
    return;
  }

  configState.cursorValue = Math.max(configState.cursorValue, result.nextCursor ?? configState.cursorValue);
  configState.lastOutcome = result.coverageOutcome;
  configState.consecutiveSkips = 0;
  if (result.coverageOutcome === "complete" || result.coverageOutcome === "quiet") {
    state.configsSucceeded++;
    configState.lastSucceededAt = completedAt;
    configState.consecutiveFailures = 0;
  } else {
    configState.lastFailedAt = completedAt;
    configState.consecutiveFailures++;
  }
}

function recordIncompleteConfigScan(
  configState: BlacklistConfigState,
  result: BlacklistScanResult,
  state: ScanState,
): void {
  state.runtimeBudgetHit ||= !result.apiError;
  if (!result.apiError) state.incompleteRuntimeConfigs++;
  if (configState.config.chain.type === "evm" && result.apiError) {
    state.apiErrors++;
    recordApiErrorConfig(
      state.apiErrorConfigs,
      configState.configKey,
      configState.config.stablecoin,
      configState.config.chain.chainId,
      "incomplete-coverage",
    );
  }
  const cursorLabel = configState.config.chain.type === "tron" ? "ts" : "block";
  console.warn(
    `[sync-blacklist] Incomplete scan for ${configState.config.stablecoin} on ${configState.config.chain.chainName}, keeping sync at ${cursorLabel} ${configState.cursorValue}`,
  );
}

function recordEvmApiError(configState: BlacklistConfigState, result: BlacklistScanResult, state: ScanState): void {
  if (result.incomplete || !result.apiError) return;

  state.apiErrors++;
  recordApiErrorConfig(
    state.apiErrorConfigs,
    configState.configKey,
    configState.config.stablecoin,
    configState.config.chain.chainId,
    result.nextCursor != null ? "partial-coverage" : "no-coverage",
  );
  const message =
    result.nextCursor != null
      ? `[sync-blacklist] Partial coverage scanning ${configState.config.stablecoin} on ${configState.config.chain.chainName}, advancing sync from ${configState.cursorValue} to ${result.nextCursor}`
      : `[sync-blacklist] API error scanning ${configState.config.stablecoin} on ${configState.config.chain.chainName}, keeping sync at block ${configState.cursorValue}`;
  console.warn(message);
}

async function processConfigScan(args: ScanSingleConfigArgs): Promise<void> {
  const { configState, state } = args;
  const { config, configKey, cursorValue: lastBlock } = configState;
  try {
    const result = await scanBlacklistConfig({
      db: args.db,
      config,
      lastBlock,
      runBudget: args.runBudget,
      etherscanApiKey: args.etherscanApiKey,
      etherscanCircuitAllowed: args.etherscanCircuitAllowed,
      trongridApiKey: args.trongridApiKey,
      etherscanLimiter: args.etherscanLimiter,
      tronLimiter: args.tronLimiter,
      signal: args.signal,
      chainHeadCache: args.chainHeadCache,
      chainRpcs: args.chainRpcs,
      getChainTimestampCache: args.getChainTimestampCache,
    });
    let insertedRowsForConfig = 0;

    if (config.chain.type === "tron") {
      await recordOutcomeSafe(args.db, CIRCUIT_SOURCE.TRONGRID, !result.apiError);
      if (result.apiError) {
        state.apiErrors++;
        recordApiErrorConfig(state.apiErrorConfigs, configKey, config.stablecoin, config.chain.chainId, "trongrid-failed");
      }
    } else {
      if (!shouldPreferRpcLogScan(config.chain.chainId) && args.etherscanCircuitAllowed) {
        await recordOutcomeSafe(args.db, CIRCUIT_SOURCE.ETHERSCAN, !result.apiError);
      }
      if (result.usedRpcLogs) state.rpcLogConfigs++;
    }

    const processed = await processFetchedBlacklistRows({
      db: args.db,
      config,
      rows: result.rows,
      chainLabel: config.chain.type === "tron" ? "tron" : "evm",
      etherscanApiKey: args.etherscanApiKey,
      drpcApiKey: args.drpcApiKey,
      trongridApiKey: args.trongridApiKey,
      etherscanLimiter: args.etherscanLimiter,
      tronLimiter: args.tronLimiter,
      runBudget: args.runBudget,
      signal: args.signal,
      chainRpcs: args.chainRpcs,
    });
    recordProcessedRows(state.counters, processed);
    insertedRowsForConfig = processed.insertedRows;

    if (result.incomplete) recordIncompleteConfigScan(configState, result, state);
    if (config.chain.type === "evm") recordEvmApiError(configState, result, state);

    recordProviderTelemetry(state, configState, result, insertedRowsForConfig);
    await finalizeSuccessfulConfigScan(args.db, configState, args.attempt, result, state, args.signal);
    state.totalFetchedEvents += result.rows.length;
    const syncLabel = config.chain.type === "tron" ? "ts" : "block";
    console.log(
      `[sync-blacklist] ${config.stablecoin} on ${config.chain.chainName}: ${result.rows.length} new events, ${syncLabel} ${result.latestCursor}`,
    );
  } catch (err) {
    await recordConfigScanException(args, err);
  }
}

async function recordConfigScanException(args: ScanSingleConfigArgs, err: unknown): Promise<void> {
  const { configState, state } = args;
  const { config, configKey, cursorValue: lastBlock } = configState;
  state.apiErrors++;
  const errorClass = err instanceof Error ? err.name : "UnknownError";
  state.apiErrorClasses[errorClass] = (state.apiErrorClasses[errorClass] ?? 0) + 1;
  recordApiErrorConfig(state.apiErrorConfigs, configKey, config.stablecoin, config.chain.chainId, `exception:${errorClass}`, err);
  const completedAt = Math.floor(Date.now() / 1000);
  const finalized = await finalizeBlacklistConfigAttempt(
    args.db,
    args.attempt,
    { outcome: "exception", completedAt },
    args.signal,
  ).catch(() => false);
  if (!finalized) state.stateConflicts++;
  configState.lastFailedAt = completedAt;
  configState.consecutiveFailures++;
  configState.consecutiveSkips = 0;
  configState.lastOutcome = "exception";
  state.coverageOutcomeCounts.exception = (state.coverageOutcomeCounts.exception ?? 0) + 1;
  state.providerScanTelemetry.push({
    configKey,
    chainId: config.chain.chainId,
    providerMode: "exception",
    coverageOutcome: "exception",
    fromCursor: lastBlock,
    scannedToCursor: null,
    safeHead: null,
    fetchedRowCount: 0,
    insertedRowCount: 0,
    providerCallCount: 0,
    maxSplitDepth: 0,
    failureSamples: [toErrorMessage(err)],
    observedAt: Math.floor(Date.now() / 1000),
  });
  console.warn(`[sync-blacklist] Failed ${config.stablecoin} on ${config.chain.chainName}:`, err);
}

async function skipTronGridCircuitConfig(args: ScanSingleConfigArgs): Promise<boolean> {
  const { configState, state } = args;
  const { config, configKey } = configState;
  if (config.chain.type !== "tron" || (await shouldAttemptFetch(args.db, CIRCUIT_SOURCE.TRONGRID))) return false;

  console.log(`[sync-blacklist] TronGrid circuit open, skipping ${configKey}`);
  state.contractsSkipped++;
  state.providerCircuitSkips++;
  state.tronGridCircuitSkips++;
  state.coverageOutcomeCounts.provider_skipped = (state.coverageOutcomeCounts.provider_skipped ?? 0) + 1;
  recordApiErrorConfig(state.apiErrorConfigs, configKey, config.stablecoin, config.chain.chainId, "trongrid-circuit-open");
  const completedAt = Math.floor(Date.now() / 1000);
  const finalized = await finalizeBlacklistConfigAttempt(
    args.db,
    args.attempt,
    { outcome: "provider_skipped", completedAt },
    args.signal,
  );
  if (!finalized) state.stateConflicts++;
  configState.lastSkippedAt = completedAt;
  configState.consecutiveSkips++;
  configState.lastOutcome = "provider_skipped";
  return true;
}

export async function scanBlacklistConfigs(args: ScanBlacklistConfigsArgs): Promise<BlacklistConfigScanSummary> {
  const state: ScanState = {
    totalFetchedEvents: 0,
    contractsSkipped: 0,
    apiErrors: 0,
    rpcLogConfigs: 0,
    runtimeBudgetHit: false,
    providerCircuitSkips: 0,
    etherscanCircuitSkips: 0,
    tronGridCircuitSkips: 0,
    incompleteRuntimeConfigs: 0,
    counters: {
      totalInsertedRows: 0,
      enrichCounters: { attempted: 0, succeeded: 0, failed: 0 },
      currentBalanceCacheCounters: { updated: 0, deleted: 0, failed: 0 },
    },
    apiErrorClasses: {},
    apiErrorConfigs: [],
    configsAttempted: 0,
    configsSucceeded: 0,
    stateConflicts: 0,
    blacklistProviderCalls: 0,
    maxProviderSplitDepth: 0,
    providerScanTelemetry: [],
    coverageOutcomeCounts: {},
  };
  const chainTimestampCaches = new Map<string, Map<number, number>>();
  const getChainTimestampCache = (chainId: string): Map<number, number> => {
    let cache = chainTimestampCaches.get(chainId);
    if (!cache) {
      cache = new Map<number, number>();
      chainTimestampCaches.set(chainId, cache);
    }
    return cache;
  };
  const { configStates, zeroCursorConfigs } = await loadBlacklistConfigStates(args.db, args.signal);
  const orderedConfigStates = orderBlacklistConfigStatesFairly(configStates);
  const etherscanCircuitAllowed = await shouldAttemptFetch(args.db, CIRCUIT_SOURCE.ETHERSCAN);
  await reportCronProgress(
    args.onProgress,
    {
      stage: "scan-configs",
      itemsDone: 0,
      itemsTotal: orderedConfigStates.length,
      message: `Scanning ${orderedConfigStates.length} blacklist config(s) before maintenance`,
    },
    args.runBudget.subrequestBudget,
  );
  const chainHeadCache = new Map<number, number>();

  for (let ci = 0; ci < orderedConfigStates.length; ci++) {
    throwIfAborted(args.signal);
    if (blacklistShouldStopBeforeNextConfig(args.runBudget) || blacklistSubrequestBudgetReached(args.runBudget)) {
      state.runtimeBudgetHit = true;
      const skippedStates = orderedConfigStates.slice(ci);
      state.contractsSkipped += skippedStates.length;
      await recordBlacklistConfigSkips(args.db, skippedStates, Math.floor(Date.now() / 1000), args.signal);
      for (const skippedState of skippedStates) {
        skippedState.lastSkippedAt = Math.floor(Date.now() / 1000);
        skippedState.consecutiveSkips++;
        skippedState.lastOutcome = "budget_skipped";
      }
      console.warn(`[sync-blacklist] Runtime budget reached, skipping ${state.contractsSkipped} remaining contracts`);
      break;
    }

    const configState = orderedConfigStates[ci]!;
    const { config, configKey } = configState;
    await reportCronProgress(
      args.onProgress,
      {
        stage: "scan-config",
        itemsDone: ci,
        itemsTotal: orderedConfigStates.length,
        message: `Scanning ${config.stablecoin} on ${config.chain.chainName}`,
        metadata: { configKey, stablecoin: config.stablecoin, chainId: config.chain.chainId },
      },
      args.runBudget.subrequestBudget,
    );
    const attemptedAt = Math.floor(Date.now() / 1000);
    const attempt = await claimBlacklistConfigAttempt(args.db, configState, attemptedAt, args.signal);
    if (!attempt) {
      state.stateConflicts++;
      state.contractsSkipped++;
      recordApiErrorConfig(state.apiErrorConfigs, configKey, config.stablecoin, config.chain.chainId, "state-claim-conflict");
      continue;
    }
    state.configsAttempted++;
    configState.attemptGeneration = attempt.generation;
    configState.lastAttemptedAt = attemptedAt;
    configState.lastOutcome = "running";

    const singleConfigArgs: ScanSingleConfigArgs = {
      ...args,
      state,
      configState,
      attempt,
      etherscanCircuitAllowed,
      chainHeadCache,
      getChainTimestampCache,
    };
    if (await skipTronGridCircuitConfig(singleConfigArgs)) continue;
    await processConfigScan(singleConfigArgs);
  }

  return { ...state, configStates, zeroCursorConfigs, etherscanCircuitAllowed };
}
