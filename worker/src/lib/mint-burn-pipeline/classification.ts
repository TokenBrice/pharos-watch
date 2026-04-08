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
  const txContextByHash = new Map<string, MintBurnTxContext | null>();
  for (const txHash of txHashes) {
    const context = await resolveTxContext(
      alchemyUrl,
      txHash,
      budget,
      txContextCache,
      signal,
    );
    txContextByHash.set(txHash, context);
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
