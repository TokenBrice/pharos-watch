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
import type { RpcEndpoint } from "../chain-registry";
import { getMintBurnConservationRuntimeEntry, requiresReviewedSupplyBurnProof } from "../mint-burn-conservation";
import { decodeAddress, decodeUint256AtSlotOrNull, readDataWord } from "../evm-logs";
import { updateEventClassifications } from "./persistence";
import { throwIfAborted } from "../abort";
import { getCache, setCache } from "../db-cache";
import { mintBurnConfigKey } from "./sync-state";
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
  blockHashesByTx?: ReadonlyMap<string, string>;
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
  const receiptLogs: NonNullable<MintBurnTxContext["receiptLogs"]> = [];
  for (const log of receiptRecord.logs) {
    const logRecord = log as Record<string, unknown>;
    logAddresses.push(logRecord.address as string);
    logTopics.push(...(logRecord.topics as string[]));
    if (typeof logRecord.data === "string") {
      receiptLogs.push({
        address: logRecord.address as string,
        topics: logRecord.topics as string[],
        data: logRecord.data,
        ...(typeof logRecord.logIndex === "string" ? { logIndex: logRecord.logIndex } : {}),
      });
    }
  }
  const blockHash = receiptRecord.blockHash;
  const blockNumber = typeof receiptRecord.blockNumber === "string" && /^0x[0-9a-f]+$/i.test(receiptRecord.blockNumber)
    ? Number(receiptRecord.blockNumber) : NaN;
  const supplyProofContext = typeof txRecord.from === "string" && /^0x[0-9a-f]{40}$/i.test(txRecord.from)
    && typeof blockHash === "string" && /^0x[0-9a-f]{64}$/i.test(blockHash) && !/^0x0{64}$/i.test(blockHash)
    && typeof txRecord.blockHash === "string" && txRecord.blockHash.toLowerCase() === blockHash.toLowerCase()
    && Number.isSafeInteger(blockNumber) && blockNumber > 0
    && typeof txRecord.blockNumber === "string" && Number(txRecord.blockNumber) === blockNumber
    && txRecord.to === receiptRecord.to && txRecord.hash === receiptRecord.transactionHash
    && receiptRecord.status === "0x1"
    && receiptRecord.logs.every((log) => {
      const item = log as Record<string, unknown>;
      return typeof item.blockHash === "string" && item.blockHash.toLowerCase() === blockHash.toLowerCase()
        && typeof item.blockNumber === "string" && Number(item.blockNumber) === blockNumber
        && item.transactionHash === txRecord.hash && item.removed === false;
    })
    ? { from: txRecord.from, input: txRecord.input, blockHash, blockNumber, success: true }
    : undefined;
  return {
    context: {
      to: typeof txRecord.to === "string" ? txRecord.to : null,
      inputSelector: txRecord.input.slice(0, 10),
      logTopics,
      logAddresses,
      receiptLogs,
      ...(supplyProofContext ? { supplyProofContext } : {}),
    },
    shortfall: false,
  };
}

async function resolveTxContextBatch(
  rpcEndpoints: readonly RpcEndpoint[],
  txHashes: string[],
  budget: MintBurnRequestBudget,
  txContextCache: Map<string, MintBurnTxContext | null>,
  signal?: AbortSignal,
  options?: BridgeClassificationOptions,
): Promise<Map<string, TxContextResolution>> {
  const resolutions = new Map<string, TxContextResolution>();
  const uncached: string[] = [];

  for (const txHash of txHashes) {
    const cacheKey = `${txHash}:${options?.blockHashesByTx?.get(txHash) ?? "unverified"}`;
    const cached = txContextCache.get(cacheKey);
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

  let pending = uncached;
  for (const endpoint of rpcEndpoints) {
    if (pending.length === 0 || budgetExhausted(budget) || !hasRuntimeWindow(options)) break;
    const timeoutMs = options?.deadlineMs != null
      ? Math.max(1, options.deadlineMs - Date.now())
      : undefined;
    const fetched = await getAlchemyTransactionContextBatchMany(endpoint.url, pending, budget, signal, timeoutMs, options?.deadlineMs);
    const unresolved: string[] = [];
    for (const txHash of pending) {
      const batch = fetched.get(txHash) ?? { tx: null, receipt: null };
      const expectedHash = options?.blockHashesByTx?.get(txHash);
      const hashMatches = expectedHash == null || (batch.receipt != null
        && (batch.receipt.blockHash == null || (typeof batch.receipt.blockHash === "string" && batch.receipt.blockHash.toLowerCase() === expectedHash))
        && (batch.tx?.blockHash == null || (typeof batch.tx.blockHash === "string" && batch.tx.blockHash.toLowerCase() === expectedHash))
        && batch.receipt.logs.length > 0
        && batch.receipt.logs.every((log) => log.blockHash?.toLowerCase() === expectedHash));
      const resolution = hashMatches ? toTxContext(batch) : { context: null, shortfall: true };
      if (!resolution.shortfall) {
        txContextCache.set(`${txHash}:${expectedHash ?? "unverified"}`, resolution.context);
      } else {
        unresolved.push(txHash);
      }
      resolutions.set(txHash, resolution);
    }
    pending = unresolved;
  }
  for (const txHash of pending) {
    if (!resolutions.has(txHash)) resolutions.set(txHash, { context: null, shortfall: true });
  }

  return resolutions;
}

function chunkTxHashes(txHashes: string[]): string[][] {
  return chunkArray(txHashes, TX_CONTEXT_BATCH_SIZE);
}

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_WORD = `0x${"0".repeat(64)}`;
const ADDRESS_WORD = /^0x0{24}[0-9a-f]{40}$/i;

/** Admission is orthogonal to bridge/roundtrip economics and never infers an internal call from a selector. */
export function applyReviewedSupplyBurnAdmission(
  rows: MintBurnRow[],
  config: MintBurnContractConfig,
  contexts: ReadonlyMap<string, MintBurnTxContext | null>,
): void {
  if (!requiresReviewedSupplyBurnProof(config)) return;
  const proof = getMintBurnConservationRuntimeEntry(config)?.supplyBurnProof;
  const token = config.contractAddress.toLowerCase();
  for (const row of rows) {
    if (row.direction !== "burn") continue;
    const context = contexts.get(row.tx_hash);
    const identity = context?.supplyProofContext;
    const logs = context?.receiptLogs ?? [];
    const indices = logs.map((log) => log.logIndex == null ? NaN : Number(log.logIndex));
    const validReceipt = identity?.success === true && identity.blockNumber === row.block_number
      && indices.every((index) => Number.isSafeInteger(index) && index >= 0)
      && new Set(indices).size === indices.length;
    const burns = logs.filter((log) => log.address.toLowerCase() === token
      && log.topics.length === 3 && log.topics[0].toLowerCase() === TRANSFER_TOPIC
      && ADDRESS_WORD.test(log.topics[1]) && log.topics[1].toLowerCase() !== ZERO_WORD
      && log.topics[2].toLowerCase() === ZERO_WORD && /^0x[0-9a-f]{64}$/i.test(log.data));
    const observed = burns.filter((log) => Number(log.logIndex) === Number(row.id.slice(row.id.lastIndexOf("-") + 1))
      && decodeAddress(log.topics[1]) === row.counterparty?.toLowerCase()
      && decodeUint256AtSlotOrNull(log.data, 0, config.decimals) === row.amount);
    let proven = false;
    if (validReceipt && observed.length === 1 && proof) {
      const burn = observed[0];
      const account = burn.topics[1].toLowerCase();
      const amount = burn.data.toLowerCase();
      const event = proof.receiptEvent;
      if (event) {
        const sameBurns = burns.filter((log) => log.topics[1].toLowerCase() === account && log.data.toLowerCase() === amount);
        const matched = logs.filter((log) => log.address.toLowerCase() === token
          && log.topics.length === event.topicArity && log.topics[0].toLowerCase() === event.topicHash
          && log.topics.every((topic) => /^0x[0-9a-f]{64}$/i.test(topic))
          && log.topics[event.accountTopic]?.toLowerCase() === account
          && log.data.length === 2 + event.dataWords * 64 && /^0x[0-9a-f]*$/i.test(log.data)
          && readDataWord(log.data, event.amountSlot)?.toLowerCase() === amount);
        // A proof cannot also certify an unrelated same-amount Transfer. Compare
        // the complete receipt, not just above-cutoff rows or transaction-wide topics.
        proven = matched.length > 0 && matched.length === sameBurns.length;
      }
      if (!proven && burns.length === 1 && context?.to?.toLowerCase() === token) {
        proven = (proof.directCalls ?? []).some((call) => {
          const input = identity!.input;
          if (input.slice(0, 10).toLowerCase() !== call.selector
            || input.length !== 10 + call.dataWords * 64 || !/^0x[0-9a-f]*$/i.test(input)) return false;
          const data = `0x${input.slice(10)}`;
          const owner = call.account === "sender" ? identity!.from.toLowerCase()
            : readDataWord(data, call.account);
          return (call.account === "sender" ? owner === decodeAddress(account)
            : owner != null && ADDRESS_WORD.test(owner) && owner.toLowerCase() === account)
            && readDataWord(data, call.amountSlot)?.toLowerCase() === amount;
        });
      }
    }
    if (!proven) {
      row.burn_type = "review_required";
      row.burn_review_reason = validReceipt ? "unproven-supply-destruction" : "supply-proof-context-unavailable";
    } else {
      row.burn_type = row.flow_type === "bridge_transfer" ? "bridge_burn" : "effective_burn";
      row.burn_review_reason = "reviewed-supply-destruction";
    }
  }
}

export async function classifyBridgeBurnRows(
  rows: MintBurnRow[],
  config: MintBurnContractConfig,
  rpcEndpoints: readonly RpcEndpoint[],
  budget: MintBurnRequestBudget,
  txContextCache: Map<string, MintBurnTxContext | null>,
  signal?: AbortSignal,
  options?: BridgeClassificationOptions,
): Promise<BurnClassificationCounters> {
  if (rows.length === 0) {
    return { effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0, txContextShortfalls: 0, deferredTxHashes: [] };
  }

  const requiresSupplyProof = requiresReviewedSupplyBurnProof(config);
  if (!config.bridgeDetection && !requiresSupplyProof) {
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
  const txHashes = [...new Set((config.bridgeDetection ? rows : burnRows).map((row) => row.tx_hash))];
  const batchResults = await mapWithConcurrency(
    chunkTxHashes(txHashes),
    TX_CONTEXT_BATCH_CONCURRENCY,
    (txHashBatch) => resolveTxContextBatch(rpcEndpoints, txHashBatch, budget, txContextCache, signal, options),
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
    if (resolution.shortfall && config.bridgeDetection) {
      txContextShortfalls++;
      deferredTxHashes.push(txHash);
    }
  }

  classifyBridgeAwareBurnRows(rows, config.bridgeDetection, txContextByHash);
  applyReviewedSupplyBurnAdmission(rows, config, txContextByHash);

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

/** Bounded retained-ledger cutover; never rewrites hours whose raw events have expired. */
export async function reconcileReviewedSupplyBurns(
  db: D1Database,
  config: MintBurnContractConfig,
  rpcEndpoints: readonly RpcEndpoint[],
  budget: MintBurnRequestBudget,
  txContextCache: Map<string, MintBurnTxContext | null>,
  retainedFromTimestamp: number,
  signal?: AbortSignal,
  options?: BridgeClassificationOptions,
): Promise<number> {
  if (!requiresReviewedSupplyBurnProof(config) || budgetExhausted(budget) || !hasRuntimeWindow(options)) return 0;
  throwIfAborted(signal);
  // The caller rounds the retention cutoff UP to a complete hour. Older raw
  // survivors do not prove their already-partially-pruned siblings still exist.
  if (!Number.isSafeInteger(retainedFromTimestamp) || retainedFromTimestamp % 3600 !== 0) {
    throw new Error("invalid-mint-burn-retained-hour-boundary");
  }
  const cursorKey = `mint-burn-supply-proof-cursor:v1:${mintBurnConfigKey(config)}`;
  const cached = await getCache(db, cursorKey);
  let cursor: Pick<MintBurnRow, "timestamp" | "id"> | null = null;
  if (cached) {
    try {
      const value = JSON.parse(cached.value) as Partial<MintBurnRow> | null;
      if (value && Number.isSafeInteger(value.timestamp) && value.timestamp! >= retainedFromTimestamp
        && typeof value.id === "string" && value.id.length > 0) {
        cursor = { timestamp: value.timestamp!, id: value.id };
      }
    } catch { /* Invalid/expired cursors restart the retained sweep. */ }
  }
  const candidates = await db.prepare(`SELECT * FROM mint_burn_events
    WHERE stablecoin_id = ? AND chain_id = ? AND direction = 'burn'
      AND timestamp >= ?
      AND (burn_review_reason IS NULL OR burn_review_reason NOT IN
        ('reviewed-supply-destruction', 'unproven-supply-destruction'))
      ${cursor ? "AND (timestamp, id) > (?, ?)" : ""}
    ORDER BY timestamp, id LIMIT 20`)
    .bind(config.stablecoinId, config.chain.chainId, retainedFromTimestamp,
      ...(cursor ? [cursor.timestamp, cursor.id] : [])).all<MintBurnRow>();
  const rows = candidates.results ?? [];
  if (rows.length === 0) {
    await setCache(db, cursorKey, "null");
    return 0;
  }
  await classifyBridgeBurnRows(rows, config, rpcEndpoints, budget, txContextCache, signal, options);
  throwIfAborted(signal);
  // This writer atomically enqueues existing A18 dirty-hour debt with each
  // classification. Completion's independent A47 drainer rebuilds current rows.
  const result = await updateEventClassifications(db, rows, { signal });
  // Advance only after durable classification/debt persistence. Unavailable
  // receipts retain their named reason and retry eligibility on the next wrap.
  const last = rows[rows.length - 1];
  await setCache(db, cursorKey, JSON.stringify(rows.length === 20
    ? { timestamp: last.timestamp, id: last.id } : null));
  return result.rowsUpdated;
}
