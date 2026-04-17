import { CONTRACT_CONFIGS } from "../lib/blacklist-contracts";
import { CIRCUIT_SOURCE } from "../lib/constants";
import { shouldAttemptFetch, recordOutcomeSafe } from "../lib/circuit-breaker";
import { getLastBlock, setLastBlock } from "../lib/db";
import {
  type RateLimitedFetch,
  createBudget,
  budgetExhausted,
  createRateLimiter,
  getEvmBlockNumber,
} from "../lib/evm-logs";
import { type ChainRpcConfig } from "../lib/chain-registry";
import { throwIfAborted } from "../lib/abort";
import type { CronProgressReporter } from "../lib/cron-logger";
import { reportCronProgress, withBudgetMetadata } from "../lib/cron-progress";
import { fetchEvmEventsIncremental } from "./blacklist/evm-source";
import { fetchTronEventsIncremental } from "./blacklist/tron-source";
import type { BlacklistRow } from "./blacklist/shared";
import { backfillAmounts, backfillTronFromLedger } from "./blacklist/amount-recovery";
import { processFetchedBlacklistRows } from "./blacklist/post-fetch";

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

function shouldStopBeforeNextConfig(deadlineMs: number): boolean {
  return Date.now() + SYNC_BLACKLIST_MIN_CONFIG_WINDOW_MS >= deadlineMs;
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

export async function syncBlacklist(opts: SyncBlacklistOptions): Promise<SyncBlacklistResult> {
  const { db, etherscanApiKey, trongridApiKey, drpcApiKey, externalEtherscanRL, signal, onProgress, chainRpcs } = opts;
  const etherscanLimiter = externalEtherscanRL ?? createRateLimiter(4);
  const tronLimiter = createRateLimiter(3);
  const budget = createBudget(900);
  const deadlineMs = Date.now() + SYNC_BLACKLIST_RUNTIME_BUDGET_MS;
  let totalFetchedEvents = 0;
  let totalInsertedRows = 0;
  let contractsSkipped = 0;
  let apiErrors = 0;
  let rpcLogConfigs = 0;
  let runtimeBudgetHit = false;
  const enrichCounters = { attempted: 0, succeeded: 0, failed: 0 };
  const currentBalanceCacheCounters = { updated: 0, deleted: 0, failed: 0 };
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

  const configStates = await Promise.all(
    CONTRACT_CONFIGS.map(async (config) => {
      const configKey = config.configKey;
      const lastBlock = await getLastBlock(db, configKey);
      return { config, configKey, lastBlock };
    }),
  );
  const zeroCursorConfigs = configStates.filter((state) => state.lastBlock === 0).map((state) => state.configKey);
  const recordApiErrorConfig = (
    configKey: string,
    stablecoin: string,
    chainId: string,
    reason: string,
    error?: unknown,
  ): void => {
    if (apiErrorConfigs.length >= 10) return;
    const entry: (typeof apiErrorConfigs)[number] = { configKey, stablecoin, chainId, reason };
    if (error instanceof Error) {
      entry.errorMessage = error.message.slice(0, 200);
      if (error.stack) {
        entry.stackHead = error.stack.split("\n").slice(0, 3).join(" | ").slice(0, 240);
      }
    }
    apiErrorConfigs.push(entry);
  };

  let tronLedgerUpdated = 0;
  try {
    const ledgerResult = await backfillTronFromLedger(db);
    tronLedgerUpdated = ledgerResult.updated;
    if (tronLedgerUpdated > 0) {
      console.log(`[sync-blacklist] Tron ledger mirror updated ${tronLedgerUpdated} row(s)`);
    }
  } catch (err) {
    console.warn("[sync-blacklist] Tron ledger mirror failed:", err);
  }

  // Backfill NULL amounts first — this has priority over new event scanning
  // because the worker may time out before completing the full config loop.
  try {
    const backfill = await backfillAmounts(
      db,
      etherscanApiKey,
      drpcApiKey,
      etherscanLimiter,
      budget,
      deadlineMs,
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
    if (shouldStopBeforeNextConfig(deadlineMs)) {
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
    if (budgetExhausted(budget)) {
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
      let result: {
        rows: BlacklistRow[];
        maxBlock: number;
        apiError: boolean;           // required on both branches now
        chainHead?: number | null;
        usedRpcLogs?: boolean;
        scannedToBlock?: number | null;
        incomplete?: boolean;
      };

      if (config.chain.type === "tron") {
        result = await fetchTronEventsIncremental(
          config,
          trongridApiKey,
          lastBlock,
          deadlineMs,
          tronLimiter,
          budget,
          signal,
        );
        await recordOutcomeSafe(db, CIRCUIT_SOURCE.TRONGRID, !result.apiError);
        if (result.apiError) {
          apiErrors++;
          recordApiErrorConfig(configKey, config.stablecoin, config.chain.chainId, "trongrid-failed");
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
          budget,
          deadlineMs,
          signal,
          chainRpcs,
        });
        enrichCounters.attempted += processed.enrichCounters.attempted;
        enrichCounters.succeeded += processed.enrichCounters.succeeded;
        enrichCounters.failed += processed.enrichCounters.failed;
        currentBalanceCacheCounters.updated += processed.currentBalanceCacheCounters.updated;
        currentBalanceCacheCounters.deleted += processed.currentBalanceCacheCounters.deleted;
        currentBalanceCacheCounters.failed += processed.currentBalanceCacheCounters.failed;
        totalInsertedRows += processed.insertedRows;

        if (result.incomplete) {
          runtimeBudgetHit = true;
          console.warn(
            `[sync-blacklist] Runtime budget reached while scanning ${config.stablecoin} on ${config.chain.chainName}, keeping sync at ts ${lastBlock}`,
          );
        } else {
          // When no events found, advance toward current time but leave a safety margin
          // to avoid permanently skipping events the explorer hasn't indexed yet.
          const newBlock = result.rows.length > 0 ? result.maxBlock : Math.max(Date.now() - TRON_SAFETY_MS, lastBlock);
          if (newBlock > lastBlock) {
            await setLastBlock(db, configKey, newBlock);
          }
        }
      } else {
        const evmChainId = config.chain.evmChainId!;
        // If lastBlock hit the sentinel (99999999), reset to 0 to re-scan.
        const wasReset = lastBlock >= EVM_SCANNED_TO_LATEST;
        const configuredStartBlock =
          typeof config.startBlock === "number" && Number.isFinite(config.startBlock) && config.startBlock > 0
            ? Math.floor(config.startBlock)
            : 0;
        const fromBlock = wasReset
          ? configuredStartBlock
          : lastBlock > 0
            ? lastBlock + 1
            : configuredStartBlock;
        result = await fetchEvmEventsIncremental(
          db,
          config,
          etherscanApiKey,
          fromBlock,
          getChainTimestampCache(config.chain.chainId),
          deadlineMs,
          etherscanLimiter,
          budget,
          signal,
          chainRpcs,
        );
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
          budget,
          deadlineMs,
          signal,
          chainRpcs,
        });
        enrichCounters.attempted += processed.enrichCounters.attempted;
        enrichCounters.succeeded += processed.enrichCounters.succeeded;
        enrichCounters.failed += processed.enrichCounters.failed;
        currentBalanceCacheCounters.updated += processed.currentBalanceCacheCounters.updated;
        currentBalanceCacheCounters.deleted += processed.currentBalanceCacheCounters.deleted;
        currentBalanceCacheCounters.failed += processed.currentBalanceCacheCounters.failed;
        totalInsertedRows += processed.insertedRows;

        let newBlock: number;
        if (result.incomplete) {
          runtimeBudgetHit = true;
          newBlock = lastBlock;
          console.warn(
            `[sync-blacklist] Runtime budget reached while scanning ${config.stablecoin} on ${config.chain.chainName}, keeping sync at block ${lastBlock}`,
          );
        } else if (result.apiError) {
          const partialAdvance = result.scannedToBlock;
          apiErrors++;
          recordApiErrorConfig(
            configKey,
            config.stablecoin,
            config.chain.chainId,
            partialAdvance != null && partialAdvance > lastBlock ? "partial-coverage" : "no-coverage",
          );
          if (partialAdvance != null && partialAdvance > lastBlock) {
            newBlock = partialAdvance;
            console.warn(
              `[sync-blacklist] Partial coverage scanning ${config.stablecoin} on ${config.chain.chainName}, advancing sync from ${lastBlock} to ${newBlock}`,
            );
          } else {
            console.warn(
              `[sync-blacklist] API error scanning ${config.stablecoin} on ${config.chain.chainName}, keeping sync at block ${lastBlock}`,
            );
            newBlock = lastBlock;
          }
        } else if (result.rows.length > 0) {
          newBlock = result.maxBlock;
        } else {
          // Genuine no events — advance sync state toward chain head, but leave a safety
          // margin to avoid permanently skipping events that the explorer hasn't indexed yet.
          if (!chainHeadCache.has(evmChainId)) {
            const head =
              result.chainHead ??
              (await getEvmBlockNumber(evmChainId, etherscanApiKey, etherscanLimiter, budget, signal));
            if (head) chainHeadCache.set(evmChainId, head);
          }
          const head = chainHeadCache.get(evmChainId);
          const margin = evmSafetyMarginBlocks(evmChainId);
          if (
            result.usedRpcLogs &&
            result.scannedToBlock != null &&
            head != null &&
            result.scannedToBlock < head
          ) {
            newBlock = Math.max(result.scannedToBlock, lastBlock);
          } else {
            // Fall back: if sentinel was reset, use the configured start block rather than staying stuck at sentinel.
            newBlock = head
              ? Math.max(head - margin, lastBlock)
              : wasReset
                ? configuredStartBlock
                : lastBlock;
          }
        }

        if (newBlock !== lastBlock) {
          await setLastBlock(db, configKey, newBlock);
        }
      }

      totalFetchedEvents += result.rows.length;
      const syncLabel = config.chain.type === "tron" ? "ts" : "block";
      console.log(
        `[sync-blacklist] ${config.stablecoin} on ${config.chain.chainName}: ${result.rows.length} new events, ${syncLabel} ${result.maxBlock}`,
      );
    } catch (err) {
      apiErrors++;
      const errorClass = err instanceof Error ? err.name : "UnknownError";
      apiErrorClasses[errorClass] = (apiErrorClasses[errorClass] ?? 0) + 1;
      recordApiErrorConfig(configKey, config.stablecoin, config.chain.chainId, `exception:${errorClass}`, err);
      console.warn(`[sync-blacklist] Failed ${config.stablecoin} on ${config.chain.chainName}:`, err);
    }
  }

  console.log(`[sync-blacklist] Completed with ${budget.count}/${budget.limit} subrequests`);
  await reportCronProgress(onProgress, {
    stage: "complete",
    itemsDone: configStates.length,
    itemsTotal: configStates.length,
    message: "Completed blacklist sync",
    metadata: {
      rowsWritten: totalInsertedRows,
      eventsFetched: totalFetchedEvents,
      contractsSkipped,
      apiErrors,
    },
  }, budget);
  // Tolerate up to 25% of configs failing (transient upstream timeouts) before
  // marking the run degraded.  More than 50% is a full error.
  const degradedThreshold = Math.max(1, Math.ceil(CONTRACT_CONFIGS.length * 0.25));
  const errorThreshold = Math.ceil(CONTRACT_CONFIGS.length / 2);
  const status: SyncBlacklistResult["status"] =
    apiErrors > errorThreshold
      ? "error"
      : apiErrors > degradedThreshold
        ? "degraded"
        : runtimeBudgetHit
          ? "degraded"
          : "ok";
  return {
    status,
    itemCount: totalInsertedRows,
    metadata: JSON.stringify(withBudgetMetadata(budget, {
      rowsWritten: totalInsertedRows,
      eventsFetched: totalFetchedEvents,
      contractsSkipped,
      apiErrors,
      apiErrorConfigs,
      zeroCursorConfigCount: zeroCursorConfigs.length,
      zeroCursorConfigs: zeroCursorConfigs.slice(0, 10),
      rpcLogConfigs,
      apiErrorClasses,
      runtimeBudgetReached: runtimeBudgetHit,
      subrequestBudgetReached: budgetExhausted(budget),
      runtimeBudgetMs: SYNC_BLACKLIST_RUNTIME_BUDGET_MS,
      enrichAttempted: enrichCounters.attempted,
      enrichSucceeded: enrichCounters.succeeded,
      enrichFailed: enrichCounters.failed,
      currentBalanceCacheUpdated: currentBalanceCacheCounters.updated,
      currentBalanceCacheDeleted: currentBalanceCacheCounters.deleted,
      currentBalanceCacheFailed: currentBalanceCacheCounters.failed,
      tronLedgerUpdated,
    })),
  };
}
