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

// Keep <= half of CF's 6-connection-per-trigger pool so other
// ctx.waitUntil() work in the same cron trigger has headroom.
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
  if (!batch.tx || !batch.receipt) {
    return { context: null, shortfall: true };
  }

  return {
    context: {
      to: batch.tx.to ?? batch.receipt.to ?? null,
      inputSelector: batch.tx.input?.slice(0, 10) ?? null,
      logTopics: batch.receipt.logs.flatMap((log) => log.topics ?? []),
      logAddresses: batch.receipt.logs.map((log) => log.address).filter((address): address is string => Boolean(address)),
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
  const chunks: string[][] = [];
  for (let i = 0; i < txHashes.length; i += TX_CONTEXT_BATCH_SIZE) {
    chunks.push(txHashes.slice(i, i + TX_CONTEXT_BATCH_SIZE));
  }
  return chunks;
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
