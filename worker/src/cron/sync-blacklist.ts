import { CIRCUIT_SOURCE } from "../lib/constants";
import { shouldAttemptFetch, recordOutcomeSafe } from "../lib/circuit-breaker";
import { setLastBlock } from "../lib/db";
import {
  type RateLimitedFetch,
  createRateLimiter,
  getEvmBlockNumber,
} from "../lib/evm-logs";
import { type ChainRpcConfig } from "../lib/chain-registry";
import { throwIfAborted } from "../lib/abort";
import type { CronProgressReporter } from "../lib/cron-logger";
import { reportCronProgress, withBudgetMetadata } from "../lib/cron-progress";
import { CONTRACT_CONFIGS } from "../lib/blacklist-contracts";
import { fetchEvmEventsIncremental } from "./blacklist/evm-source";
import { fetchTronEventsIncremental } from "./blacklist/tron-source";
import type { BlacklistRow, BlacklistScanResult } from "./blacklist/shared";
import { backfillAmounts } from "./blacklist/amount-recovery";
import { processFetchedBlacklistRows } from "./blacklist/post-fetch";
import {
  blacklistShouldStopBeforeNextConfig,
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
} from "./blacklist/sync-support";

const EVM_SCANNED_TO_LATEST = 99999999;
const SYNC_BLACKLIST_RUNTIME_BUDGET_MS = 7 * 60_000;
const SYNC_BLACKLIST_MIN_CONFIG_WINDOW_MS = 60_000;

type SyncBlacklistResult = {
  itemCount: number;
  metadata: string;
  status: "ok" | "degraded" | "error";
};

// Safety margin when advancing sync state to chain head (prevents permanent event loss
// if block explorer indexing lags behind chain tip). 15 minutes in seconds/ms.
const INDEXING_SAFETY_SEC = 900;
const TRON_SAFETY_MS = INDEXING_SAFETY_SEC * 1000;

// Approximate block times (seconds) per EVM chain — used to compute safety margin in blocks.
const EVM_BLOCK_TIME: Record<number, number> = {
  1: 12,       // Ethereum
  42161: 0.25, // Arbitrum
  8453: 2,     // Base
  10: 2,       // Optimism
  137: 2,      // Polygon
  43114: 2,    // Avalanche
  56: 3,       // BSC
  100: 5,      // Gnosis
};

function evmSafetyMarginBlocks(evmChainId: number): number {
  const blockTime = EVM_BLOCK_TIME[evmChainId] ?? 2;
  return Math.ceil(INDEXING_SAFETY_SEC / blockTime);
}

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

function buildTronScanResult(
  result: { rows: BlacklistRow[]; maxBlock: number; incomplete: boolean; apiError: boolean },
  lastCursor: number,
): BlacklistScanResult {
  const nextCursor = result.incomplete
    ? lastCursor
    : result.rows.length > 0
      ? result.maxBlock
      : Math.max(Date.now() - TRON_SAFETY_MS, lastCursor);

  return {
    rows: result.rows,
    latestCursor: result.maxBlock,
    nextCursor: nextCursor > lastCursor ? nextCursor : null,
    apiError: result.apiError,
    incomplete: result.incomplete,
    usedRpcLogs: false,
  };
}

function buildEvmScanResult(args: {
  result: {
    rows: BlacklistRow[];
    maxBlock: number;
    apiError: boolean;
    chainHead: number | null;
    usedRpcLogs: boolean;
    scannedToBlock: number | null;
    incomplete: boolean;
  };
  lastCursor: number;
  configuredStartBlock: number;
  wasReset: boolean;
  evmChainId: number;
  chainHeadCache: Map<number, number>;
}): BlacklistScanResult {
  let nextCursor = args.lastCursor;
  const { result } = args;

  if (result.incomplete) {
    nextCursor = args.lastCursor;
  } else if (result.apiError) {
    const partialAdvance = result.scannedToBlock;
    nextCursor =
      partialAdvance != null && partialAdvance > args.lastCursor
        ? partialAdvance
        : args.lastCursor;
  } else if (result.rows.length > 0) {
    nextCursor = result.maxBlock;
  } else {
    const head = args.chainHeadCache.get(args.evmChainId);
    const margin = evmSafetyMarginBlocks(args.evmChainId);
    if (result.usedRpcLogs && result.scannedToBlock != null && head != null && result.scannedToBlock < head) {
      nextCursor = Math.max(result.scannedToBlock, args.lastCursor);
    } else {
      nextCursor = head
        ? Math.max(head - margin, args.lastCursor)
        : args.wasReset
          ? args.configuredStartBlock
          : args.lastCursor;
    }
  }

  return {
    rows: result.rows,
    latestCursor: result.maxBlock,
    nextCursor: nextCursor !== args.lastCursor ? nextCursor : null,
    apiError: result.apiError,
    incomplete: result.incomplete,
    usedRpcLogs: result.usedRpcLogs,
  };
}

async function scanBlacklistConfig(args: {
  db: D1Database;
  config: (typeof CONTRACT_CONFIGS)[number];
  configKey: string;
  lastBlock: number;
  runBudget: BlacklistRunBudget;
  etherscanApiKey: string | null;
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
  const wasReset = args.lastBlock >= EVM_SCANNED_TO_LATEST;
  const configuredStartBlock =
    typeof args.config.startBlock === "number" && Number.isFinite(args.config.startBlock) && args.config.startBlock > 0
      ? Math.floor(args.config.startBlock)
      : 0;
  const fromBlock = wasReset
    ? configuredStartBlock
    : args.lastBlock > 0
      ? args.lastBlock + 1
      : configuredStartBlock;

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
  );

  if (result.chainHead != null) {
    args.chainHeadCache.set(evmChainId, result.chainHead);
  } else if (!args.chainHeadCache.has(evmChainId) && !result.incomplete && !result.apiError && result.rows.length === 0) {
    const head = await getEvmBlockNumber(
      evmChainId,
      args.etherscanApiKey,
      args.etherscanLimiter,
      args.runBudget.subrequestBudget,
      args.signal,
    );
    if (head) args.chainHeadCache.set(evmChainId, head);
  }

  return buildEvmScanResult({
    result,
    lastCursor: args.lastBlock,
    configuredStartBlock,
    wasReset,
    evmChainId,
    chainHeadCache: args.chainHeadCache,
  });
}

export async function syncBlacklist(opts: SyncBlacklistOptions): Promise<SyncBlacklistResult> {
  const { db, etherscanApiKey, trongridApiKey, drpcApiKey, externalEtherscanRL, signal, onProgress, chainRpcs } = opts;
  const etherscanLimiter = externalEtherscanRL ?? createRateLimiter(4);
  const tronLimiter = createRateLimiter(3);
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
  const counters = {
    totalInsertedRows: 0,
    enrichCounters: { attempted: 0, succeeded: 0, failed: 0 },
    currentBalanceCacheCounters: { updated: 0, deleted: 0, failed: 0 },
  };
  const apiErrorClasses: Record<string, number> = {};
  const apiErrorConfigs: Array<{
    configKey: string;
    stablecoin: string;
    chainId: string;
    reason: string;
    errorMessage?: string;
    stackHead?: string;
  }> = [];
  const chainTimestampCaches = new Map<string, Map<number, number>>();
  const getChainTimestampCache = (chainId: string): Map<number, number> => {
    let cache = chainTimestampCaches.get(chainId);
    if (!cache) {
      cache = new Map<number, number>();
      chainTimestampCaches.set(chainId, cache);
    }
    return cache;
  };
  const { configStates, zeroCursorConfigs } = await loadBlacklistConfigStates(db);
  let tronLedgerUpdated = await applyTronLedgerMirrorPass(db, "initial");

  // Backfill NULL amounts first — this has priority over new event scanning
  // because the worker may time out before completing the full config loop.
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
  console.log(`[sync-blacklist] Backfill done, budget: ${budget.count}/${budget.limit}`);
  await reportCronProgress(onProgress, {
    stage: "backfill-amounts",
    itemsDone: 0,
    itemsTotal: configStates.length,
    message: `Backfill pass complete; scanning ${configStates.length} blacklist config(s)`,
  }, budget);

  // Sort by lastBlock ascending so least-synced configs go first
  configStates.sort((a, b) => a.lastBlock - b.lastBlock);

  // Cache current block per EVM chain to avoid redundant API calls
  const chainHeadCache = new Map<number, number>();

  for (let ci = 0; ci < configStates.length; ci++) {
    throwIfAborted(signal);
    if (blacklistShouldStopBeforeNextConfig(runBudget)) {
      runtimeBudgetHit = true;
      contractsSkipped = configStates.length - ci;
      console.warn(`[sync-blacklist] Runtime budget reached, skipping ${contractsSkipped} remaining contracts`);
      break;
    }
    const { config, configKey, lastBlock } = configStates[ci];
    await reportCronProgress(onProgress, {
      stage: "scan-config",
      itemsDone: ci,
      itemsTotal: configStates.length,
      message: `Scanning ${config.stablecoin} on ${config.chain.chainName}`,
      metadata: {
        configKey,
        stablecoin: config.stablecoin,
        chainId: config.chain.chainId,
      },
    }, budget);
    if (blacklistSubrequestBudgetReached(runBudget)) {
      runtimeBudgetHit = true;
      contractsSkipped = configStates.length - ci;
      console.log(`[sync-blacklist] Budget exhausted (${budget.count}/${budget.limit}), skipping ${contractsSkipped} remaining contracts`);
      break;
    }

    // Circuit breaker checks for provider-specific sources
    if (config.chain.type === "tron" && !(await shouldAttemptFetch(db, CIRCUIT_SOURCE.TRONGRID))) {
      console.log(`[sync-blacklist] TronGrid circuit open, skipping ${configKey}`);
      contractsSkipped++;
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
        trongridApiKey,
        etherscanLimiter,
        tronLimiter,
        signal,
        chainHeadCache,
        chainRpcs,
        getChainTimestampCache,
      });

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

        if (result.incomplete) {
          runtimeBudgetHit = true;
          console.warn(
            `[sync-blacklist] Runtime budget reached while scanning ${config.stablecoin} on ${config.chain.chainName}, keeping sync at ts ${lastBlock}`,
          );
        }
      } else {
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

        if (result.incomplete) {
          runtimeBudgetHit = true;
          console.warn(
            `[sync-blacklist] Runtime budget reached while scanning ${config.stablecoin} on ${config.chain.chainName}, keeping sync at block ${lastBlock}`,
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

      if (result.nextCursor != null) {
        await setLastBlock(db, configKey, result.nextCursor);
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
      console.warn(`[sync-blacklist] Failed ${config.stablecoin} on ${config.chain.chainName}:`, err);
    }
  }

  tronLedgerUpdated += await applyTronLedgerMirrorPass(db, "post-sync");

  console.log(`[sync-blacklist] Completed with ${budget.count}/${budget.limit} subrequests`);
  await reportCronProgress(onProgress, {
    stage: "complete",
    itemsDone: configStates.length,
    itemsTotal: configStates.length,
    message: "Completed blacklist sync",
    metadata: {
      rowsWritten: counters.totalInsertedRows,
      eventsFetched: totalFetchedEvents,
      contractsSkipped,
      apiErrors,
    },
  }, budget);
  // Tolerate up to 25% of configs failing (transient upstream timeouts) before
  // marking the run degraded.  More than 50% is a full error.
  const status: SyncBlacklistResult["status"] = deriveSyncBlacklistStatus(apiErrors, runtimeBudgetHit);
  return {
    status,
    itemCount: counters.totalInsertedRows,
    metadata: JSON.stringify(withBudgetMetadata(budget, {
      rowsWritten: counters.totalInsertedRows,
      eventsFetched: totalFetchedEvents,
      contractsSkipped,
      apiErrors,
      apiErrorConfigs,
      zeroCursorConfigCount: zeroCursorConfigs.length,
      zeroCursorConfigs: zeroCursorConfigs.slice(0, 10),
      rpcLogConfigs,
      apiErrorClasses,
      runtimeBudgetReached: runtimeBudgetHit,
      subrequestBudgetReached: blacklistSubrequestBudgetReached(runBudget),
      runtimeBudgetMs: SYNC_BLACKLIST_RUNTIME_BUDGET_MS,
      enrichAttempted: counters.enrichCounters.attempted,
      enrichSucceeded: counters.enrichCounters.succeeded,
      enrichFailed: counters.enrichCounters.failed,
      currentBalanceCacheUpdated: counters.currentBalanceCacheCounters.updated,
      currentBalanceCacheDeleted: counters.currentBalanceCacheCounters.deleted,
      currentBalanceCacheFailed: counters.currentBalanceCacheCounters.failed,
      tronLedgerUpdated,
    })),
  };
}
