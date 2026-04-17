/**
 * Mint/Burn Bridge Classification — Async Orchestration
 *
 * Wraps the pure classifier (../mint-burn-bridge-classifier.ts) with
 * transaction context fetching from the chain RPC. Handles I/O and
 * batch processing; delegates classification logic to the pure module.
 */
import {
  getAlchemyTransactionByHash,
  getAlchemyTransactionReceipt,
} from "../alchemy-logs";
import {
  classifyBridgeAwareBurnRows,
  type MintBurnTxContext,
} from "../mint-burn-bridge-classifier";
import type { MintBurnContractConfig } from "../mint-burn-contracts";
import type {
  BurnClassificationCounters,
  MintBurnRequestBudget,
  MintBurnRow,
} from "./types";

// Keep <= half of CF's 6-connection-per-trigger pool so other
// ctx.waitUntil() work in the same cron trigger has headroom.
const TX_CONTEXT_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function resolveTxContext(
  alchemyUrl: string,
  txHash: string,
  budget: MintBurnRequestBudget,
  txContextCache: Map<string, MintBurnTxContext | null>,
  signal?: AbortSignal,
): Promise<MintBurnTxContext | null> {
  const cached = txContextCache.get(txHash);
  if (cached !== undefined) return cached;

  const [tx, receipt] = await Promise.all([
    getAlchemyTransactionByHash(alchemyUrl, txHash, budget, signal),
    getAlchemyTransactionReceipt(alchemyUrl, txHash, budget, signal),
  ]);

  if (!tx && !receipt) {
    txContextCache.set(txHash, null);
    return null;
  }

  const context: MintBurnTxContext = {
    to: tx?.to ?? receipt?.to ?? null,
    inputSelector: tx?.input?.slice(0, 10) ?? null,
    logTopics: receipt?.logs.flatMap((log) => log.topics ?? []) ?? [],
    logAddresses: receipt?.logs.map((log) => log.address).filter((address): address is string => Boolean(address)) ?? [],
  };
  txContextCache.set(txHash, context);
  return context;
}

export async function classifyBridgeBurnRows(
  rows: MintBurnRow[],
  config: MintBurnContractConfig,
  alchemyUrl: string,
  budget: MintBurnRequestBudget,
  txContextCache: Map<string, MintBurnTxContext | null>,
  signal?: AbortSignal,
): Promise<BurnClassificationCounters> {
  if (rows.length === 0) {
    return { effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0 };
  }

  const burnRows = rows.filter((row) => row.direction === "burn");
  const txHashes = [...new Set(rows.map((row) => row.tx_hash))];
  const contexts = await mapWithConcurrency(
    txHashes,
    TX_CONTEXT_CONCURRENCY,
    (txHash) => resolveTxContext(alchemyUrl, txHash, budget, txContextCache, signal),
  );
  const txContextByHash = new Map<string, MintBurnTxContext | null>();
  for (let i = 0; i < txHashes.length; i++) {
    txContextByHash.set(txHashes[i]!, contexts[i]!);
  }

  classifyBridgeAwareBurnRows(rows, config.bridgeDetection, txContextByHash);

  let effectiveBurns = 0;
  let bridgeBurns = 0;
  let reviewBurns = 0;
  for (const row of burnRows) {
    if (row.burn_type === "bridge_burn") {
      bridgeBurns++;
    } else if (row.burn_type === "review_required") {
      reviewBurns++;
    } else {
      effectiveBurns++;
    }
  }

  return { effectiveBurns, bridgeBurns, reviewBurns };
}
