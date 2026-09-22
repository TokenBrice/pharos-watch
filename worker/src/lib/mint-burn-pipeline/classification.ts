/**
 * Mint/Burn Bridge Classification — Async Orchestration
 *
 * Wraps the pure classifier (../mint-burn-bridge-classifier.ts) with
 * transaction context fetching from the chain RPC. Handles I/O and
 * batch processing; delegates classification logic to the pure module.
 */
import {
  getAlchemyTransactionContextBatchMany,
  type AlchemyTransactionContextBatch,
} from "../alchemy-logs";
import { mapWithConcurrency } from "../concurrency";
import { chunkArray } from "../collections";
import {
  classifyBridgeAwareBurnRows,
  type MintBurnTxContext,
} from "../mint-burn-bridge-classifier";
import type { MintBurnContractConfig } from "../mint-burn-contracts";
import { budgetExhausted } from "../evm-logs";
import type {
  BurnClassificationCounters,
  MintBurnRequestBudget,
  MintBurnRow,
} from "./types";

// Keep <= half of the repo's six-request trigger budget so other
// ctx.waitUntil() work in the same cron invocation has headroom.
const TX_CONTEXT_BATCH_SIZE = 20;
const TX_CONTEXT_BATCH_CONCURRENCY = 3;
const TX_CONTEXT_MIN_REMAINING_MS = 2_000;

interface BridgeClassificationOptions {
  deadlineMs?: number;
}

interface TxContextResolution {
  context: MintBurnTxContext | null;
  shortfall: boolean;
}

function hasRuntimeWindow(options?: BridgeClassificationOptions): boolean {
  return options?.deadlineMs == null || Date.now() + TX_CONTEXT_MIN_REMAINING_MS < options.deadlineMs;
}

function toTxContext(batch: AlchemyTransactionContextBatch): TxContextResolution {
  const tx = batch.tx as unknown;
  const receipt = batch.receipt as unknown;
  if (!tx || typeof tx !== "object" || !receipt || typeof receipt !== "object") {
    return { context: null, shortfall: true };
  }
  const txRecord = tx as Record<string, unknown>;
  const receiptRecord = receipt as Record<string, unknown>;
  if (
    (typeof txRecord.to !== "string" && txRecord.to !== null)
    || typeof txRecord.input !== "string"
    || (typeof receiptRecord.to !== "string" && receiptRecord.to !== null)
    || !Array.isArray(receiptRecord.logs)
    || !receiptRecord.logs.every((log) => {
      if (!log || typeof log !== "object") return false;
      const logRecord = log as Record<string, unknown>;
      return typeof logRecord.address === "string"
        && Array.isArray(logRecord.topics)
        && logRecord.topics.every((topic) => typeof topic === "string");
    })
  ) {
    return { context: null, shortfall: true };
  }

  const logTopics: string[] = [];
  const logAddresses: string[] = [];
  for (const log of receiptRecord.logs) {
    const logRecord = log as Record<string, unknown>;
    logAddresses.push(logRecord.address as string);
    logTopics.push(...(logRecord.topics as string[]));
  }
  return {
    context: {
      to: typeof txRecord.to === "string" ? txRecord.to : null,
      inputSelector: txRecord.input.slice(0, 10),
      logTopics,
      logAddresses,
    },
    shortfall: false,
  };
}

async function resolveTxContextBatch(
  alchemyUrl: string,
  txHashes: string[],
  budget: MintBurnRequestBudget,
  txContextCache: Map<string, MintBurnTxContext | null>,
  signal?: AbortSignal,
  options?: BridgeClassificationOptions,
): Promise<Map<string, TxContextResolution>> {
  const resolutions = new Map<string, TxContextResolution>();
  const uncached: string[] = [];

  for (const txHash of txHashes) {
    const cached = txContextCache.get(txHash);
    if (cached !== undefined) {
      resolutions.set(txHash, { context: cached, shortfall: false });
    } else {
      uncached.push(txHash);
    }
  }

  if (uncached.length === 0) return resolutions;
  if (budgetExhausted(budget) || !hasRuntimeWindow(options) || signal?.aborted) {
    for (const txHash of uncached) {
      resolutions.set(txHash, { context: null, shortfall: true });
    }
    return resolutions;
  }

  const timeoutMs = options?.deadlineMs != null
    ? Math.max(1, options.deadlineMs - Date.now())
    : undefined;
  const fetched = await getAlchemyTransactionContextBatchMany(alchemyUrl, uncached, budget, signal, timeoutMs);

  for (const txHash of uncached) {
    const resolution = toTxContext(fetched.get(txHash) ?? { tx: null, receipt: null });
    if (!resolution.shortfall) {
      txContextCache.set(txHash, resolution.context);
    }
    resolutions.set(txHash, resolution);
  }

  return resolutions;
}

function chunkTxHashes(txHashes: string[]): string[][] {
  return chunkArray(txHashes, TX_CONTEXT_BATCH_SIZE);
}

export async function classifyBridgeBurnRows(
  rows: MintBurnRow[],
  config: MintBurnContractConfig,
  alchemyUrl: string,
  budget: MintBurnRequestBudget,
  txContextCache: Map<string, MintBurnTxContext | null>,
  signal?: AbortSignal,
  options?: BridgeClassificationOptions,
): Promise<BurnClassificationCounters> {
  if (rows.length === 0) {
    return { effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0, txContextShortfalls: 0, deferredTxHashes: [] };
  }

  if (!config.bridgeDetection) {
    classifyBridgeAwareBurnRows(rows, undefined, new Map());
    const burnRows = rows.filter((row) => row.direction === "burn");
    return {
      effectiveBurns: burnRows.length,
      bridgeBurns: 0,
      reviewBurns: 0,
      txContextShortfalls: 0,
      deferredTxHashes: [],
    };
  }

  const burnRows = rows.filter((row) => row.direction === "burn");
  const txHashes = [...new Set(rows.map((row) => row.tx_hash))];
  const batchResults = await mapWithConcurrency(
    chunkTxHashes(txHashes),
    TX_CONTEXT_BATCH_CONCURRENCY,
    (txHashBatch) => resolveTxContextBatch(alchemyUrl, txHashBatch, budget, txContextCache, signal, options),
  );
  const txContextByHash = new Map<string, MintBurnTxContext | null>();
  let txContextShortfalls = 0;
  const deferredTxHashes: string[] = [];
  const resolutions = new Map<string, TxContextResolution>();
  for (const batchResult of batchResults) {
    for (const [txHash, resolution] of batchResult) {
      resolutions.set(txHash, resolution);
    }
  }
  for (const txHash of txHashes) {
    const resolution = resolutions.get(txHash) ?? { context: null, shortfall: true };
    txContextByHash.set(txHash, resolution.context);
    if (resolution.shortfall) {
      txContextShortfalls++;
      deferredTxHashes.push(txHash);
    }
  }

  classifyBridgeAwareBurnRows(rows, config.bridgeDetection, txContextByHash);

  let effectiveBurns = 0;
  let bridgeBurns = 0;
  let reviewBurns = 0;
  const deferredTxHashSet = new Set(deferredTxHashes);

  for (const row of burnRows) {
    if (deferredTxHashSet.has(row.tx_hash)) continue;
    if (row.burn_type === "bridge_burn") {
      bridgeBurns++;
    } else if (row.burn_type === "review_required") {
      reviewBurns++;
    } else {
      effectiveBurns++;
    }
  }

  return { effectiveBurns, bridgeBurns, reviewBurns, txContextShortfalls, deferredTxHashes };
}
