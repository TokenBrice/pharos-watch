import { ALCHEMY_CHAINS } from "./chain-registry";
import type { SubrequestBudget } from "./evm-logs";
import { budgetExhausted } from "./evm-logs";
import { buildInClause } from "./db";
import { throwIfAborted } from "./abort";
import { cancelResponseBodyQuietly } from "./response-body";
import { logWorkerEvent } from "./structured-log";
import { DAY_SECONDS } from "@shared/lib/time-constants";

const ALCHEMY_RPC_TIMEOUT_MS = 30_000;

// --- Types ---

export interface AlchemyLogEntry {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string; // hex
  transactionHash: string;
  transactionIndex: string; // hex
  blockHash: string;
  logIndex: string; // hex
  removed: boolean;
}

export interface AlchemyTransactionEntry {
  hash: string;
  to: string | null;
  input: string;
}

export interface AlchemyTransactionReceipt {
  transactionHash: string;
  to: string | null;
  logs: AlchemyLogEntry[];
}

export interface AlchemyTransactionContextBatch {
  tx: AlchemyTransactionEntry | null;
  receipt: AlchemyTransactionReceipt | null;
}

interface JsonRpcResponse<T> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

interface JsonRpcCallResult<T> {
  result: T | null;
  error: { code: number; message: string } | null;
  status: number;
  transientHttpError: boolean;
}

export interface AlchemyLogsFetchResult {
  logs: AlchemyLogEntry[];
  complete: boolean;
  scannedToBlock: number;
  calls: number;
  maxDepth: number;
  failureReason?: string;
}

export interface AlchemyTopicFilter {
  index: number;
  value: string | readonly string[];
}

type FetchLogsRangeResult = AlchemyLogsFetchResult;

export interface PersistentBlockTimestampCache {
  db: D1Database;
  chainId: string;
  maxAgeSec?: number;
}

export interface ResolveBlockTimestampOptions {
  signal?: AbortSignal;
  localCache?: Map<number, number>;
  persistentCache?: PersistentBlockTimestampCache;
  deadlineMs?: number;
}

// --- URL builder ---

export function buildAlchemyUrl(chainId: string, apiKey: string): string | null {
  const slug = ALCHEMY_CHAINS[chainId];
  if (!slug) return null;
  return `https://${slug}.g.alchemy.com/v2/${apiKey}`;
}

// --- Helpers ---

async function jsonRpcCall<T>(
  alchemyUrl: string,
  method: string,
  params: unknown[],
  signal?: AbortSignal,
  timeoutMs = ALCHEMY_RPC_TIMEOUT_MS,
): Promise<JsonRpcCallResult<T>> {
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(ALCHEMY_RPC_TIMEOUT_MS, timeoutMs)));
  let res: Response;
  try {
    res = await fetch(alchemyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    logWorkerEvent({
      scope: "lib",
      level: "debug",
      event: "alchemy_json_rpc_fetch_failed",
      message: "Alchemy JSON-RPC fetch failed",
      provider: "alchemy",
      metadata: { method },
      error: err,
    });
    return {
      result: null,
      error: { code: -1, message: "network failure" },
      status: 0,
      transientHttpError: true,
    };
  }

  const transientHttpError = !res.ok && (res.status >= 500 || res.status === 429 || res.status === 408);

  let json: JsonRpcResponse<T> | null = null;
  try {
    json = (await res.json()) as JsonRpcResponse<T>;
  } catch (err) {
    logWorkerEvent({
      scope: "lib",
      level: "debug",
      event: "alchemy_json_rpc_response_parse_failed",
      message: "Alchemy JSON-RPC response body parse failed",
      provider: "alchemy",
      status: res.status,
      metadata: { method },
      error: err,
    });
    if (transientHttpError) {
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: "alchemy_json_rpc_non_json_response",
        message: "Alchemy JSON-RPC returned a non-JSON response body",
        provider: "alchemy",
        status: res.status,
        metadata: { method },
      });
      return {
        result: null,
        error: { code: -1, message: "non-JSON response body" },
        status: res.status,
        transientHttpError: true,
      };
    }
    return {
      result: null,
      error: { code: -1, message: "non-JSON response body" },
      status: res.status,
      transientHttpError: false,
    };
  }

  if (json?.error) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "alchemy_json_rpc_error",
      message: "Alchemy JSON-RPC returned an error",
      provider: "alchemy",
      status: res.status,
      metadata: { method, rpcErrorCode: json.error.code, rpcErrorMessage: json.error.message },
    });
    return {
      result: null,
      error: json.error,
      status: res.status,
      transientHttpError,
    };
  }

  if (!res.ok) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "alchemy_json_rpc_http_error",
      message: "Alchemy JSON-RPC returned an HTTP error without a JSON-RPC error",
      provider: "alchemy",
      status: res.status,
      metadata: { method },
    });
    return {
      result: null,
      error: { code: -1, message: `HTTP ${res.status}` },
      status: res.status,
      transientHttpError,
    };
  }

  return {
    result: json?.result ?? null,
    error: null,
    status: res.status,
    transientHttpError: false,
  };
}

// --- Block number ---

export async function getAlchemyBlockNumber(
  alchemyUrl: string,
  budget: SubrequestBudget,
  signal?: AbortSignal,
): Promise<number | null> {
  if (budgetExhausted(budget)) return null;
  budget.count++;
  try {
    const rpc = await jsonRpcCall<string>(alchemyUrl, "eth_blockNumber", [], signal);
    if (!rpc.result || !rpc.result.startsWith("0x")) return null;
    return parseInt(rpc.result, 16);
  } catch (err) {
    logWorkerEvent({
      scope: "lib",
      level: "debug",
      event: "alchemy_block_number_failed",
      message: "Alchemy eth_blockNumber failed",
      provider: "alchemy",
      metadata: { method: "eth_blockNumber" },
      error: err,
    });
    return null;
  }
}

export async function getAlchemyTransactionContextBatchMany(
  alchemyUrl: string,
  txHashes: string[],
  budget: SubrequestBudget,
  signal?: AbortSignal,
  timeoutMs = ALCHEMY_RPC_TIMEOUT_MS,
): Promise<Map<string, AlchemyTransactionContextBatch>> {
  const uniqueTxHashes = [...new Set(txHashes)];
  const results = new Map<string, AlchemyTransactionContextBatch>(
    uniqueTxHashes.map((txHash) => [txHash, { tx: null, receipt: null }]),
  );
  if (uniqueTxHashes.length === 0 || budgetExhausted(budget)) return results;
  budget.count++;

  const payload = uniqueTxHashes.flatMap((txHash, index) => [
    {
      jsonrpc: "2.0",
      id: index * 2,
      method: "eth_getTransactionByHash",
      params: [txHash],
    },
    {
      jsonrpc: "2.0",
      id: index * 2 + 1,
      method: "eth_getTransactionReceipt",
      params: [txHash],
    },
  ]);

  const timeout = AbortSignal.timeout(Math.max(1, Math.min(ALCHEMY_RPC_TIMEOUT_MS, timeoutMs)));
  let res: Response;
  try {
    res = await fetch(alchemyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    logWorkerEvent({
      scope: "lib",
      level: "debug",
      event: "alchemy_transaction_context_batch_fetch_failed",
      message: "Alchemy transaction-context batch fetch failed",
      provider: "alchemy",
      error: err,
    });
    return results;
  }

  if (!res.ok) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "alchemy_transaction_context_batch_http_error",
      message: "Alchemy transaction-context batch returned an HTTP error",
      provider: "alchemy",
      status: res.status,
    });
    await cancelResponseBodyQuietly(res);
    return results;
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    logWorkerEvent({
      scope: "lib",
      level: "debug",
      event: "alchemy_transaction_context_batch_parse_failed",
      message: "Alchemy transaction-context batch response body parse failed",
      provider: "alchemy",
      error: err,
    });
    return results;
  }

  if (!Array.isArray(parsed)) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "alchemy_transaction_context_batch_non_array_response",
      message: "Alchemy transaction-context batch returned a non-array JSON body",
      provider: "alchemy",
    });
    return results;
  }

  for (const item of parsed as Array<JsonRpcResponse<unknown>>) {
    if (item?.error) {
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: "alchemy_transaction_context_batch_item_error",
        message: "Alchemy transaction-context batch item returned an error",
        provider: "alchemy",
        metadata: { rpcErrorCode: item.error.code, rpcErrorMessage: item.error.message },
      });
      continue;
    }
    if (typeof item?.id !== "number" || !Number.isInteger(item.id) || item.id < 0) {
      continue;
    }
    const txHash = uniqueTxHashes[Math.floor(item.id / 2)];
    if (!txHash) continue;
    const current = results.get(txHash) ?? { tx: null, receipt: null };
    if (item.id % 2 === 0) {
      current.tx = (item.result ?? null) as AlchemyTransactionEntry | null;
    } else {
      current.receipt = (item.result ?? null) as AlchemyTransactionReceipt | null;
    }
    results.set(txHash, current);
  }

  return results;
}

// --- Log fetching ---

export async function fetchAlchemyLogs(
  alchemyUrl: string,
  contractAddress: string,
  topics: AlchemyTopicFilter[],
  fromBlock: number,
  toBlock: number,
  budget: SubrequestBudget,
  signal?: AbortSignal,
  options?: { deadlineMs?: number; maxSplitCalls?: number },
): Promise<AlchemyLogsFetchResult | null> {
  const callBudget = {
    count: 0,
    limit: Math.max(1, Math.floor(options?.maxSplitCalls ?? DEFAULT_LOG_SPLIT_MAX_CALLS)),
  };
  return fetchAlchemyLogsRange(
    alchemyUrl,
    contractAddress,
    topics,
    fromBlock,
    toBlock,
    budget,
    signal,
    0,
    options,
    callBudget,
  );
}

const LOG_SPLIT_MAX_DEPTH = 8;
const LOG_SPLIT_MIN_RANGE = 8;
const DEFAULT_LOG_SPLIT_MAX_CALLS = 64;

type LogSplitCallBudget = { count: number; limit: number };

function shouldSplitLogRange(
  errorMessage: string | null,
  code: number | null,
  status: number,
  transientHttpError: boolean,
): boolean {
  if (transientHttpError) return true;
  if (status === 429 || status === 408 || status === 504) return true;
  if (code === -32005 || code === -32000) return true;
  const msg = (errorMessage ?? "").toLowerCase();
  return (
    msg.includes("block range") ||
    msg.includes("query timeout") ||
    msg.includes("timed out") ||
    msg.includes("too many results") ||
    msg.includes("response size") ||
    msg.includes("result set too large") ||
    msg.includes("more than") ||
    msg.includes("limit exceeded")
  );
}

async function fetchAlchemyLogsRange(
  alchemyUrl: string,
  contractAddress: string,
  topics: AlchemyTopicFilter[],
  fromBlock: number,
  toBlock: number,
  budget: SubrequestBudget,
  signal: AbortSignal | undefined,
  depth: number,
  options: { deadlineMs?: number; maxSplitCalls?: number } | undefined,
  callBudget: LogSplitCallBudget,
): Promise<FetchLogsRangeResult> {
  if (fromBlock > toBlock) {
    return { logs: [], complete: true, scannedToBlock: toBlock, calls: 0, maxDepth: depth };
  }

  if (options?.deadlineMs != null && Date.now() >= options.deadlineMs) {
    return { logs: [], complete: false, scannedToBlock: fromBlock - 1, calls: 0, maxDepth: depth };
  }

  if (budgetExhausted(budget)) {
    return {
      logs: [],
      complete: false,
      scannedToBlock: fromBlock - 1,
      calls: 0,
      maxDepth: depth,
      failureReason: "subrequest-budget-exhausted",
    };
  }
  if (callBudget.count >= callBudget.limit) {
    return {
      logs: [],
      complete: false,
      scannedToBlock: fromBlock - 1,
      calls: 0,
      maxDepth: depth,
      failureReason: "split-call-cap",
    };
  }
  budget.count++;
  callBudget.count++;

  const topicArray: (string | readonly string[] | null)[] = [];
  for (const { index, value } of topics) {
    while (topicArray.length <= index) topicArray.push(null);
    topicArray[index] = value;
  }

  const params = [
    {
      address: contractAddress,
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + toBlock.toString(16),
      topics: topicArray,
    },
  ];

  try {
    const timeoutMs =
      options?.deadlineMs != null ? Math.max(1, options.deadlineMs - Date.now()) : ALCHEMY_RPC_TIMEOUT_MS;
    const rpc = await jsonRpcCall<AlchemyLogEntry[]>(alchemyUrl, "eth_getLogs", params, signal, timeoutMs);
    if (Array.isArray(rpc.result)) {
      return { logs: rpc.result, complete: true, scannedToBlock: toBlock, calls: 1, maxDepth: depth };
    }

    const rangeSize = toBlock - fromBlock + 1;
    const canSplit = depth < LOG_SPLIT_MAX_DEPTH && rangeSize > LOG_SPLIT_MIN_RANGE;
    const splitRecommended = shouldSplitLogRange(
      rpc.error?.message ?? null,
      rpc.error?.code ?? null,
      rpc.status,
      rpc.transientHttpError,
    );

    if (!canSplit || !splitRecommended) {
      return {
        logs: [],
        complete: false,
        scannedToBlock: fromBlock - 1,
        calls: 1,
        maxDepth: depth,
        failureReason: splitRecommended ? "split-limit" : "provider-error",
      };
    }

    const mid = Math.floor((fromBlock + toBlock) / 2);
    if (mid <= fromBlock || mid >= toBlock) {
      return {
        logs: [],
        complete: false,
        scannedToBlock: fromBlock - 1,
        calls: 1,
        maxDepth: depth,
        failureReason: "unsplittable-range",
      };
    }

    // Walk split ranges depth-first so one oversized scan cannot fan out into
    // many concurrent eth_getLogs requests and exhaust the shared Worker connection pool.
    const left = await fetchAlchemyLogsRange(
      alchemyUrl,
      contractAddress,
      topics,
      fromBlock,
      mid,
      budget,
      signal,
      depth + 1,
      options,
      callBudget,
    );
    if (!left.complete) {
      return {
        logs: left.logs,
        complete: false,
        scannedToBlock: left.scannedToBlock,
        calls: 1 + left.calls,
        maxDepth: Math.max(depth, left.maxDepth),
        failureReason: left.failureReason,
      };
    }

    const right = await fetchAlchemyLogsRange(
      alchemyUrl,
      contractAddress,
      topics,
      mid + 1,
      toBlock,
      budget,
      signal,
      depth + 1,
      options,
      callBudget,
    );

    return {
      logs: [...left.logs, ...right.logs],
      complete: right.complete,
      scannedToBlock: right.scannedToBlock,
      calls: 1 + left.calls + right.calls,
      maxDepth: Math.max(depth, left.maxDepth, right.maxDepth),
      failureReason: right.failureReason,
    };
  } catch (e) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "alchemy_get_logs_failed",
      message: "Alchemy eth_getLogs failed",
      provider: "alchemy",
      metadata: { method: "eth_getLogs" },
      error: e,
    });
    return {
      logs: [],
      complete: false,
      scannedToBlock: fromBlock - 1,
      calls: 1,
      maxDepth: depth,
      failureReason: "exception",
    };
  }
}

// --- Block timestamps ---

const TIMESTAMP_BATCH_SIZE = 50;
// D1 enforces a relatively low SQL variable cap in some environments; keep this conservative.
const D1_SAFE_MAX_SQL_VARIABLES = 90;
const TIMESTAMP_CACHE_READ_FIXED_BINDINGS = 2; // chain_id + updated_at
const TIMESTAMP_CACHE_READ_CHUNK = Math.max(1, D1_SAFE_MAX_SQL_VARIABLES - TIMESTAMP_CACHE_READ_FIXED_BINDINGS);
const DEFAULT_TIMESTAMP_CACHE_MAX_AGE_SEC = 14 * DAY_SECONDS;
const TIMESTAMP_RETRY_BATCH_SIZES = [TIMESTAMP_BATCH_SIZE, 10, 1] as const;

interface BlockTimestampBatchResult {
  timestamps: Map<number, number>;
  missingBlocks: number[];
  issueCount: number;
}

async function fetchBlockTimestampBatch(
  alchemyUrl: string,
  batch: number[],
  signal?: AbortSignal,
  timeoutMs = ALCHEMY_RPC_TIMEOUT_MS,
): Promise<BlockTimestampBatchResult> {
  const missingAll = (issueCount = 1): BlockTimestampBatchResult => ({
    timestamps: new Map<number, number>(),
    missingBlocks: batch,
    issueCount,
  });

  const payload = batch.map((block, idx) => ({
    jsonrpc: "2.0",
    id: idx,
    method: "eth_getBlockByNumber",
    params: ["0x" + block.toString(16), false],
  }));

  try {
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(ALCHEMY_RPC_TIMEOUT_MS, timeoutMs)));
    const res = await fetch(alchemyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) {
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: "alchemy_block_timestamp_batch_http_error",
        message: "Alchemy block timestamp batch returned an HTTP error",
        provider: "alchemy",
        status: res.status,
        metadata: { method: "eth_getBlockByNumber", batchSize: batch.length },
      });
      await cancelResponseBodyQuietly(res);
      return missingAll();
    }

    const parsed = (await res.json()) as unknown;
    if (!Array.isArray(parsed)) {
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: "alchemy_block_timestamp_batch_non_array_response",
        message: "Alchemy block timestamp batch returned a non-array JSON body",
        provider: "alchemy",
        metadata: { method: "eth_getBlockByNumber", batchSize: batch.length },
      });
      return missingAll();
    }

    const timestamps = new Map<number, number>();
    let issueCount = 0;
    for (const response of parsed) {
      if (!response || typeof response !== "object") {
        issueCount++;
        continue;
      }
      const rpc = response as Partial<JsonRpcResponse<{ timestamp: string }>>;
      const requestIndex = rpc.id;
      if (typeof requestIndex !== "number" || !Number.isInteger(requestIndex)) {
        issueCount++;
        continue;
      }
      if (requestIndex < 0 || requestIndex >= batch.length) {
        issueCount++;
        continue;
      }
      if (rpc.error) {
        issueCount++;
        continue;
      }

      const tsHex = rpc.result?.timestamp;
      if (typeof tsHex !== "string") {
        issueCount++;
        continue;
      }

      const ts = parseInt(tsHex, 16);
      if (Number.isFinite(ts)) {
        // Duplicate IDs are deterministic: the last valid mapping wins.
        timestamps.set(batch[requestIndex]!, ts);
      } else {
        issueCount++;
      }
    }

    const missingBlocks = batch.filter((block) => !timestamps.has(block));
    if (missingBlocks.length > 0) issueCount++;
    return { timestamps, missingBlocks, issueCount };
  } catch (e) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "alchemy_block_timestamp_batch_fetch_failed",
      message: "Alchemy block timestamp batch fetch failed",
      provider: "alchemy",
      metadata: { method: "eth_getBlockByNumber", batchSize: batch.length },
      error: e,
    });
    return missingAll();
  }
}

export async function resolveBlockTimestamps(
  alchemyUrl: string,
  blockNumbers: number[],
  budget: SubrequestBudget,
  options?: ResolveBlockTimestampOptions,
): Promise<Map<number, number>> {
  const timestamps = new Map<number, number>();
  if (blockNumbers.length === 0) return timestamps;

  const uniqueBlocks = [...new Set(blockNumbers)].filter((b) => Number.isFinite(b) && b >= 0);
  const localCache = options?.localCache;
  const persistentCache = options?.persistentCache;
  const nowSec = Math.floor(Date.now() / 1000);

  for (const block of uniqueBlocks) {
    const cached = localCache?.get(block);
    if (cached != null) {
      timestamps.set(block, cached);
    }
  }

  let unresolved = uniqueBlocks.filter((block) => !timestamps.has(block));

  if (persistentCache && unresolved.length > 0) {
    const maxAgeSec = persistentCache.maxAgeSec ?? DEFAULT_TIMESTAMP_CACHE_MAX_AGE_SEC;
    const cutoff = nowSec - maxAgeSec;
    for (let i = 0; i < unresolved.length; i += TIMESTAMP_CACHE_READ_CHUNK) {
      throwIfAborted(options?.signal);
      const batchBlocks = unresolved.slice(i, i + TIMESTAMP_CACHE_READ_CHUNK);
      const blockInClause = buildInClause(batchBlocks);
      const rows = await persistentCache.db
        .prepare(
          `SELECT block_number, timestamp
           FROM block_timestamp_cache
           WHERE chain_id = ?
             AND updated_at >= ?
             AND block_number IN (${blockInClause.sql})`,
        )
        .bind(persistentCache.chainId, cutoff, ...blockInClause.binds)
        .all<{ block_number: number; timestamp: number }>();

      for (const row of rows.results ?? []) {
        timestamps.set(row.block_number, row.timestamp);
        localCache?.set(row.block_number, row.timestamp);
      }
    }
    unresolved = uniqueBlocks.filter((block) => !timestamps.has(block));
  }

  const freshResolvedForCache = new Map<number, number>();
  let fetchIssues = 0;
  let remotePending = unresolved;
  for (const batchSize of TIMESTAMP_RETRY_BATCH_SIZES) {
    if (remotePending.length === 0) break;
    const stillMissing: number[] = [];

    for (let i = 0; i < remotePending.length; i += batchSize) {
      throwIfAborted(options?.signal);
      if (options?.deadlineMs != null && Date.now() >= options.deadlineMs) {
        stillMissing.push(...remotePending.slice(i));
        break;
      }
      if (budgetExhausted(budget)) {
        stillMissing.push(...remotePending.slice(i));
        break;
      }
      budget.count++;

      const batch = remotePending.slice(i, i + batchSize);
      const timeoutMs =
        options?.deadlineMs != null ? Math.max(1, options.deadlineMs - Date.now()) : ALCHEMY_RPC_TIMEOUT_MS;
      const result = await fetchBlockTimestampBatch(alchemyUrl, batch, options?.signal, timeoutMs);
      fetchIssues += result.issueCount;
      for (const [block, ts] of result.timestamps) {
        timestamps.set(block, ts);
        localCache?.set(block, ts);
        freshResolvedForCache.set(block, ts);
      }
      stillMissing.push(...result.missingBlocks.filter((block) => !timestamps.has(block)));
    }

    remotePending = stillMissing;
    if (budgetExhausted(budget)) break;
  }

  if (fetchIssues > 0) {
    const totalNeeded = uniqueBlocks.length;
    const stillMissing = uniqueBlocks.filter((b) => !timestamps.has(b)).length;
    if (stillMissing > 0) {
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: "alchemy_block_timestamp_resolution_incomplete",
        message: "Alchemy block timestamp resolution was incomplete",
        provider: "alchemy",
        metadata: { stillMissing, totalNeeded, fetchIssues },
      });
    }
  }

  if (persistentCache && freshResolvedForCache.size > 0) {
    const stmts = [...freshResolvedForCache.entries()].map(([block, ts]) =>
      persistentCache.db
        .prepare(
          `INSERT OR REPLACE INTO block_timestamp_cache
            (chain_id, block_number, timestamp, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(persistentCache.chainId, block, ts, nowSec),
    );
    for (let i = 0; i < stmts.length; i += TIMESTAMP_CACHE_READ_CHUNK) {
      throwIfAborted(options?.signal);
      await persistentCache.db.batch(stmts.slice(i, i + TIMESTAMP_CACHE_READ_CHUNK));
    }
  }

  return timestamps;
}
