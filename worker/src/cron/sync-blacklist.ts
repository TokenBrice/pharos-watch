import { CIRCUIT_SOURCE } from "../lib/constants";
import { shouldAttemptFetch, recordOutcomeSafe } from "../lib/circuit-breaker";
import { materializeBlacklistGapMetrics } from "../lib/blacklist-gaps";
import { materializeBlacklistSummarySnapshot } from "../api/blacklist-summary";
import { type RateLimitedFetch, createRateLimiter, getEvmBlockNumber } from "../lib/evm-logs";
import { type ChainRpcConfig } from "../lib/chain-registry";
import { throwIfAborted } from "../lib/abort";
import type { CronProgressReporter } from "../lib/cron-logger";
import { reportCronProgress, withBudgetMetadata } from "../lib/cron-progress";
import { CONTRACT_CONFIGS } from "../lib/blacklist-contracts";
import {
  fetchEvmEventsIncremental,
  shouldPreferRpcLogScan,
  type FetchEvmEventsIncrementalResult,
} from "./blacklist/evm-source";
import { fetchTronEventsIncremental, type FetchTronEventsIncrementalResult } from "./blacklist/tron-source";
import type { BlacklistScanResult } from "./blacklist/shared";
import { backfillAmounts } from "./blacklist/amount-recovery";
import { processFetchedBlacklistRows } from "./blacklist/post-fetch";
import {
  blacklistShouldStopBeforeNextConfig,
  blacklistRuntimeBudgetReached,
  blacklistSubrequestBudgetReached,
  createBlacklistRunBudget,
  type BlacklistRunBudget,
} from "./blacklist/run-budget";
import {
  applyTronLedgerMirrorPass,
  deriveSyncBlacklistStatus,
  loadBlacklistConfigStates,
  recordApiErrorConfig,
  recordProcessedRows,
  type SyncBlacklistApiErrorConfig,
} from "./blacklist/sync-support";
import { toErrorMessage } from "../lib/error-utils";
import {
  claimBlacklistConfigAttempt,
  finalizeBlacklistConfigAttempt,
  getOldestBlacklistSuccessAt,
  orderBlacklistConfigStatesFairly,
  recordBlacklistConfigSkips,
  type BlacklistConfigAttempt,
} from "./blacklist/state";
import {
  persistBlacklistProviderScanTelemetry,
  type BlacklistProviderScanTelemetry,
} from "./blacklist/provider-telemetry";
import {
  migrateLegacyBlacklistIdentities,
  type BlacklistLegacyIdentityMigrationResult,
} from "./blacklist/legacy-identity-migration";

const SYNC_BLACKLIST_RUNTIME_BUDGET_MS = 10 * 60_000;
const SYNC_BLACKLIST_MIN_CONFIG_WINDOW_MS = 60_000;
const BLACKLIST_PRODUCER_SNAPSHOT_MIN_WINDOW_MS = 10_000;
// createRateLimiter is intentionally serial. Keep the declared live
// concurrency aligned with that implementation and the shared six-connection
// trigger budget; throughput is controlled independently by requests/second.
export const BLACKLIST_PROVIDER_LIVE_CONCURRENCY = 1;
export const BLACKLIST_PROVIDER_REQUESTS_PER_SECOND = 3;

type SyncBlacklistResult = {
  itemCount: number;
  metadata: string;
  status: "ok" | "degraded" | "error";
};

export interface SyncBlacklistOptions {
  db: D1Database;
  etherscanApiKey: string | null;
  trongridApiKey: string | null;
  drpcApiKey: string | null;
  externalEtherscanRL?: RateLimitedFetch;
  signal?: AbortSignal;
  onProgress?: CronProgressReporter;
  chainRpcs?: Map<string, ChainRpcConfig>;
}

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
  configKey: string;
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

  if (result.chainHead != null) {
    args.chainHeadCache.set(evmChainId, result.chainHead);
  }

  return buildEvmScanResult({
    result,
    lastCursor: args.lastBlock,
  });
}

export async function syncBlacklist(opts: SyncBlacklistOptions): Promise<SyncBlacklistResult> {
  const { db, etherscanApiKey, trongridApiKey, drpcApiKey, externalEtherscanRL, signal, onProgress, chainRpcs } = opts;
  const etherscanLimiter = externalEtherscanRL ?? createRateLimiter(BLACKLIST_PROVIDER_REQUESTS_PER_SECOND);
  const tronLimiter = createRateLimiter(BLACKLIST_PROVIDER_REQUESTS_PER_SECOND);
  const runBudget = createBlacklistRunBudget({
    subrequestLimit: 900,
    runtimeBudgetMs: SYNC_BLACKLIST_RUNTIME_BUDGET_MS,
    minimumConfigWindowMs: SYNC_BLACKLIST_MIN_CONFIG_WINDOW_MS,
  });
  const budget = runBudget.subrequestBudget;
  let totalFetchedEvents = 0;
  let contractsSkipped = 0;
  let apiErrors = 0;
  let rpcLogConfigs = 0;
  let runtimeBudgetHit = false;
  let providerCircuitSkips = 0;
  let etherscanCircuitSkips = 0;
  let tronGridCircuitSkips = 0;
  let producerGapMetricSnapshots = 0;
  let producerSummarySnapshot = false;
  let producerSnapshotSkipped = false;
  let producerSnapshotError: string | null = null;
  let incompleteRuntimeConfigs = 0;
  const counters = {
    totalInsertedRows: 0,
    enrichCounters: { attempted: 0, succeeded: 0, failed: 0 },
    currentBalanceCacheCounters: { updated: 0, deleted: 0, failed: 0 },
  };
  const apiErrorClasses: Record<string, number> = {};
  const apiErrorConfigs: SyncBlacklistApiErrorConfig[] = [];
  const chainTimestampCaches = new Map<string, Map<number, number>>();
  const getChainTimestampCache = (chainId: string): Map<number, number> => {
    let cache = chainTimestampCaches.get(chainId);
    if (!cache) {
      cache = new Map<number, number>();
      chainTimestampCaches.set(chainId, cache);
    }
    return cache;
  };
  const { configStates, zeroCursorConfigs } = await loadBlacklistConfigStates(db, signal);
  const orderedConfigStates = orderBlacklistConfigStatesFairly(configStates);
  let tronLedgerUpdated = 0;
  let configsAttempted = 0;
  let configsSucceeded = 0;
  let stateConflicts = 0;
  let blacklistProviderCalls = 0;
  let maxProviderSplitDepth = 0;
  const providerScanTelemetry: BlacklistProviderScanTelemetry[] = [];
  let providerTelemetryWritten = 0;
  let providerTelemetryError: string | null = null;
  let legacyIdentityMigration: BlacklistLegacyIdentityMigrationResult = {
    eventMigrated: 0,
    balanceMigrated: 0,
    ambiguousSkipped: 0,
  };
  let legacyIdentityMigrationError: string | null = null;
  const coverageOutcomeCounts: Record<string, number> = {};
  const etherscanCircuitAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.ETHERSCAN);
  await reportCronProgress(
    onProgress,
    {
      stage: "scan-configs",
      itemsDone: 0,
      itemsTotal: orderedConfigStates.length,
      message: `Scanning ${orderedConfigStates.length} blacklist config(s) before maintenance`,
    },
    budget,
  );

  // Cache current block per EVM chain to avoid redundant API calls
  const chainHeadCache = new Map<number, number>();

  for (let ci = 0; ci < orderedConfigStates.length; ci++) {
    throwIfAborted(signal);
    if (blacklistShouldStopBeforeNextConfig(runBudget) || blacklistSubrequestBudgetReached(runBudget)) {
      runtimeBudgetHit = true;
      const skippedStates = orderedConfigStates.slice(ci);
      contractsSkipped += skippedStates.length;
      await recordBlacklistConfigSkips(db, skippedStates, Math.floor(Date.now() / 1000), signal);
      for (const skippedState of skippedStates) {
        skippedState.lastSkippedAt = Math.floor(Date.now() / 1000);
        skippedState.consecutiveSkips++;
        skippedState.lastOutcome = "budget_skipped";
      }
      console.warn(`[sync-blacklist] Runtime budget reached, skipping ${contractsSkipped} remaining contracts`);
      break;
    }
    const state = orderedConfigStates[ci]!;
    const { config, configKey } = state;
    const lastBlock = state.cursorValue;
    await reportCronProgress(
      onProgress,
      {
        stage: "scan-config",
        itemsDone: ci,
        itemsTotal: orderedConfigStates.length,
        message: `Scanning ${config.stablecoin} on ${config.chain.chainName}`,
        metadata: {
          configKey,
          stablecoin: config.stablecoin,
          chainId: config.chain.chainId,
        },
      },
      budget,
    );

    const attemptedAt = Math.floor(Date.now() / 1000);
    const attempt: BlacklistConfigAttempt | null = await claimBlacklistConfigAttempt(db, state, attemptedAt, signal);
    if (!attempt) {
      stateConflicts++;
      contractsSkipped++;
      recordApiErrorConfig(apiErrorConfigs, configKey, config.stablecoin, config.chain.chainId, "state-claim-conflict");
      continue;
    }
    configsAttempted++;
    state.attemptGeneration = attempt.generation;
    state.lastAttemptedAt = attemptedAt;
    state.lastOutcome = "running";

    // Circuit breaker checks for provider-specific sources
    if (config.chain.type === "tron" && !(await shouldAttemptFetch(db, CIRCUIT_SOURCE.TRONGRID))) {
      console.log(`[sync-blacklist] TronGrid circuit open, skipping ${configKey}`);
      contractsSkipped++;
      providerCircuitSkips++;
      tronGridCircuitSkips++;
      coverageOutcomeCounts.provider_skipped = (coverageOutcomeCounts.provider_skipped ?? 0) + 1;
      recordApiErrorConfig(
        apiErrorConfigs,
        configKey,
        config.stablecoin,
        config.chain.chainId,
        "trongrid-circuit-open",
      );
      const completedAt = Math.floor(Date.now() / 1000);
      const finalized = await finalizeBlacklistConfigAttempt(
        db,
        attempt,
        {
          outcome: "provider_skipped",
          completedAt,
        },
        signal,
      );
      if (!finalized) stateConflicts++;
      state.lastSkippedAt = completedAt;
      state.consecutiveSkips++;
      state.lastOutcome = "provider_skipped";
      continue;
    }

    try {
      const result = await scanBlacklistConfig({
        db,
        config,
        configKey,
        lastBlock,
        runBudget,
        etherscanApiKey,
        etherscanCircuitAllowed,
        trongridApiKey,
        etherscanLimiter,
        tronLimiter,
        signal,
        chainHeadCache,
        chainRpcs,
        getChainTimestampCache,
      });
      let insertedRowsForConfig = 0;

      if (config.chain.type === "tron") {
        await recordOutcomeSafe(db, CIRCUIT_SOURCE.TRONGRID, !result.apiError);
        if (result.apiError) {
          apiErrors++;
          recordApiErrorConfig(apiErrorConfigs, configKey, config.stablecoin, config.chain.chainId, "trongrid-failed");
        }

        const processed = await processFetchedBlacklistRows({
          db,
          config,
          rows: result.rows,
          chainLabel: "tron",
          etherscanApiKey,
          drpcApiKey,
          trongridApiKey,
          etherscanLimiter,
          tronLimiter,
          runBudget,
          signal,
          chainRpcs,
        });
        recordProcessedRows(counters, processed);
        insertedRowsForConfig = processed.insertedRows;

        if (result.incomplete) {
          runtimeBudgetHit ||= !result.apiError;
          if (!result.apiError) incompleteRuntimeConfigs++;
          console.warn(
            `[sync-blacklist] Incomplete scan for ${config.stablecoin} on ${config.chain.chainName}, keeping sync at ts ${lastBlock}`,
          );
        }
      } else {
        if (!shouldPreferRpcLogScan(config.chain.chainId) && etherscanCircuitAllowed) {
          await recordOutcomeSafe(db, CIRCUIT_SOURCE.ETHERSCAN, !result.apiError);
        }

        if (result.usedRpcLogs) {
          rpcLogConfigs++;
        }

        const processed = await processFetchedBlacklistRows({
          db,
          config,
          rows: result.rows,
          chainLabel: "evm",
          etherscanApiKey,
          drpcApiKey,
          trongridApiKey,
          etherscanLimiter,
          tronLimiter,
          runBudget,
          signal,
          chainRpcs,
        });
        recordProcessedRows(counters, processed);
        insertedRowsForConfig = processed.insertedRows;

        if (result.incomplete) {
          runtimeBudgetHit ||= !result.apiError;
          if (!result.apiError) incompleteRuntimeConfigs++;
          if (result.apiError) {
            apiErrors++;
            recordApiErrorConfig(
              apiErrorConfigs,
              configKey,
              config.stablecoin,
              config.chain.chainId,
              "incomplete-coverage",
            );
          }
          console.warn(
            `[sync-blacklist] Incomplete scan for ${config.stablecoin} on ${config.chain.chainName}, keeping sync at block ${lastBlock}`,
          );
        } else if (result.apiError) {
          apiErrors++;
          recordApiErrorConfig(
            apiErrorConfigs,
            configKey,
            config.stablecoin,
            config.chain.chainId,
            result.nextCursor != null ? "partial-coverage" : "no-coverage",
          );
          if (result.nextCursor != null) {
            console.warn(
              `[sync-blacklist] Partial coverage scanning ${config.stablecoin} on ${config.chain.chainName}, advancing sync from ${lastBlock} to ${result.nextCursor}`,
            );
          } else {
            console.warn(
              `[sync-blacklist] API error scanning ${config.stablecoin} on ${config.chain.chainName}, keeping sync at block ${lastBlock}`,
            );
          }
        }
      }

      blacklistProviderCalls += result.providerCalls;
      maxProviderSplitDepth = Math.max(maxProviderSplitDepth, result.maxSplitDepth);
      coverageOutcomeCounts[result.coverageOutcome] = (coverageOutcomeCounts[result.coverageOutcome] ?? 0) + 1;
      providerScanTelemetry.push({
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
        fromCursor: lastBlock,
        scannedToCursor: result.scannedToCursor,
        safeHead: result.safeHead,
        fetchedRowCount: result.rows.length,
        insertedRowCount: insertedRowsForConfig,
        providerCallCount: result.providerCalls,
        maxSplitDepth: result.maxSplitDepth,
        failureSamples: result.failureSamples,
        observedAt: Math.floor(Date.now() / 1000),
      });

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
        stateConflicts++;
        apiErrors++;
        recordApiErrorConfig(
          apiErrorConfigs,
          configKey,
          config.stablecoin,
          config.chain.chainId,
          "state-finalize-conflict",
        );
      } else {
        state.cursorValue = Math.max(state.cursorValue, result.nextCursor ?? state.cursorValue);
        state.lastOutcome = result.coverageOutcome;
        state.consecutiveSkips = 0;
        if (result.coverageOutcome === "complete" || result.coverageOutcome === "quiet") {
          configsSucceeded++;
          state.lastSucceededAt = completedAt;
          state.consecutiveFailures = 0;
        } else {
          state.lastFailedAt = completedAt;
          state.consecutiveFailures++;
        }
      }

      totalFetchedEvents += result.rows.length;
      const syncLabel = config.chain.type === "tron" ? "ts" : "block";
      console.log(
        `[sync-blacklist] ${config.stablecoin} on ${config.chain.chainName}: ${result.rows.length} new events, ${syncLabel} ${result.latestCursor}`,
      );
    } catch (err) {
      apiErrors++;
      const errorClass = err instanceof Error ? err.name : "UnknownError";
      apiErrorClasses[errorClass] = (apiErrorClasses[errorClass] ?? 0) + 1;
      recordApiErrorConfig(
        apiErrorConfigs,
        configKey,
        config.stablecoin,
        config.chain.chainId,
        `exception:${errorClass}`,
        err,
      );
      const completedAt = Math.floor(Date.now() / 1000);
      const finalized = await finalizeBlacklistConfigAttempt(
        db,
        attempt,
        {
          outcome: "exception",
          completedAt,
        },
        signal,
      ).catch(() => false);
      if (!finalized) stateConflicts++;
      state.lastFailedAt = completedAt;
      state.consecutiveFailures++;
      state.consecutiveSkips = 0;
      state.lastOutcome = "exception";
      coverageOutcomeCounts.exception = (coverageOutcomeCounts.exception ?? 0) + 1;
      providerScanTelemetry.push({
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
  }

  // Historical amount repair and ledger mirroring are maintenance work. They
  // run only after every admissible event source has had its turn.
  if (!blacklistRuntimeBudgetReached(runBudget)) {
    try {
      legacyIdentityMigration = await migrateLegacyBlacklistIdentities(db, signal);
    } catch (error) {
      legacyIdentityMigrationError = error instanceof Error ? error.name : "UnknownError";
      console.warn("[sync-blacklist] Legacy identity migration failed:", error);
    }
  }
  if (etherscanCircuitAllowed && !blacklistRuntimeBudgetReached(runBudget)) {
    try {
      const backfill = await backfillAmounts(
        db,
        etherscanApiKey,
        drpcApiKey,
        etherscanLimiter,
        runBudget,
        signal,
        chainRpcs,
      );
      runtimeBudgetHit ||= backfill.runtimeBudgetReached;
    } catch (err) {
      console.warn("[sync-blacklist] Backfill failed:", err);
    }
  } else if (!etherscanCircuitAllowed) {
    etherscanCircuitSkips++;
    console.warn("[sync-blacklist] Etherscan circuit open, skipping EVM amount backfill");
  }
  tronLedgerUpdated = await applyTronLedgerMirrorPass(db, "post-sync", { runBudget, signal });
  try {
    providerTelemetryWritten = await persistBlacklistProviderScanTelemetry(
      db,
      providerScanTelemetry,
      Math.floor(Date.now() / 1000),
      signal,
    );
  } catch (error) {
    providerTelemetryError = error instanceof Error ? error.name : "UnknownError";
    console.warn("[sync-blacklist] Provider telemetry persistence failed:", error);
  }

  const subrequestBudgetReached = blacklistSubrequestBudgetReached(runBudget);
  const derivedStatus = deriveSyncBlacklistStatus(apiErrors, runtimeBudgetHit, {
    contractsSkipped,
    totalConfigs: configStates.length,
    incompleteRuntimeConfigs,
    subrequestBudgetHit: subrequestBudgetReached,
  });
  const { oldestSuccessAt, neverSucceeded } = getOldestBlacklistSuccessAt(configStates);
  const coverageFailures = Math.max(0, configsAttempted - configsSucceeded);
  const status: SyncBlacklistResult["status"] =
    derivedStatus === "ok" &&
    (providerCircuitSkips > 0 || coverageFailures > 0 || stateConflicts > 0 || neverSucceeded > 0)
      ? "degraded"
      : derivedStatus;
  const producerSnapshotWindowUnavailable =
    Date.now() + BLACKLIST_PRODUCER_SNAPSHOT_MIN_WINDOW_MS >= runBudget.deadlineMs;

  if (
    status !== "ok" ||
    blacklistRuntimeBudgetReached(runBudget) ||
    subrequestBudgetReached ||
    oldestSuccessAt == null ||
    producerSnapshotWindowUnavailable
  ) {
    producerSnapshotSkipped = true;
  } else {
    try {
      const snapshotNow = Math.floor(Date.now() / 1000);
      const gapSnapshot = await materializeBlacklistGapMetrics(db, snapshotNow, undefined, oldestSuccessAt);
      const summarySnapshot = await materializeBlacklistSummarySnapshot(db, snapshotNow, oldestSuccessAt);
      producerGapMetricSnapshots = gapSnapshot.written;
      producerSummarySnapshot = summarySnapshot.written;
    } catch (err) {
      producerSnapshotError = err instanceof Error ? err.name : "UnknownError";
      await reportCronProgress(
        onProgress,
        {
          stage: "producer-snapshots",
          itemsDone: configStates.length,
          itemsTotal: configStates.length,
          message: "Failed to materialize blacklist producer snapshots",
          metadata: {
            producerSnapshotError,
            errorMessage: toErrorMessage(err),
          },
        },
        budget,
      );
    }
  }

  console.log(`[sync-blacklist] Completed with ${budget.count}/${budget.limit} subrequests`);
  await reportCronProgress(
    onProgress,
    {
      stage: "complete",
      itemsDone: configStates.length,
      itemsTotal: configStates.length,
      message: "Completed blacklist sync",
      metadata: {
        rowsWritten: counters.totalInsertedRows,
        eventsFetched: totalFetchedEvents,
        contractsSkipped,
        apiErrors,
        configsAttempted,
        configsSucceeded,
        coverageFailures,
        stateConflicts,
      },
    },
    budget,
  );
  return {
    status,
    itemCount: counters.totalInsertedRows,
    metadata: JSON.stringify(
      withBudgetMetadata(budget, {
        rowsWritten: counters.totalInsertedRows,
        eventsFetched: totalFetchedEvents,
        contractsSkipped,
        apiErrors,
        apiErrorConfigs,
        zeroCursorConfigCount: zeroCursorConfigs.length,
        zeroCursorConfigs: zeroCursorConfigs.slice(0, 10),
        configsAttempted,
        configsSucceeded,
        coverageFailures,
        stateConflicts,
        rpcLogConfigs,
        providerCircuitSkips,
        etherscanCircuitSkips,
        tronGridCircuitSkips,
        apiErrorClasses,
        coverageOutcomeCounts,
        blacklistProviderCalls,
        maxProviderSplitDepth,
        providerLimiterLiveConcurrency: BLACKLIST_PROVIDER_LIVE_CONCURRENCY,
        providerLimiterRequestsPerSecond: BLACKLIST_PROVIDER_REQUESTS_PER_SECOND,
        providerTelemetryWritten,
        providerTelemetryError,
        legacyIdentityEventMigrated: legacyIdentityMigration.eventMigrated,
        legacyIdentityBalanceMigrated: legacyIdentityMigration.balanceMigrated,
        legacyIdentityAmbiguousSkipped: legacyIdentityMigration.ambiguousSkipped,
        legacyIdentityMigrationError,
        runtimeBudgetReached: runtimeBudgetHit,
        subrequestBudgetReached,
        runtimeBudgetMs: SYNC_BLACKLIST_RUNTIME_BUDGET_MS,
        incompleteRuntimeConfigs,
        oldestConfigSuccessAt: oldestSuccessAt,
        oldestConfigSuccessAgeSec:
          oldestSuccessAt == null ? null : Math.max(0, Math.floor(Date.now() / 1000) - oldestSuccessAt),
        configsNeverSucceeded: neverSucceeded,
        enrichAttempted: counters.enrichCounters.attempted,
        enrichSucceeded: counters.enrichCounters.succeeded,
        enrichFailed: counters.enrichCounters.failed,
        currentBalanceCacheUpdated: counters.currentBalanceCacheCounters.updated,
        currentBalanceCacheDeleted: counters.currentBalanceCacheCounters.deleted,
        currentBalanceCacheFailed: counters.currentBalanceCacheCounters.failed,
        tronLedgerUpdated,
        producerGapMetricSnapshots,
        producerSummarySnapshot,
        producerSnapshotSkipped,
        producerSnapshotError,
        producerSnapshotWindowMs: BLACKLIST_PRODUCER_SNAPSHOT_MIN_WINDOW_MS,
        producerSnapshotWindowUnavailable,
      }),
    ),
  };
}
