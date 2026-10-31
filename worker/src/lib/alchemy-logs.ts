import { ALCHEMY_CHAINS, buildAlchemyRpcUrl, getRpcAuth, type RpcEndpoint } from "./chain-registry";
import { recordDwellirCredits } from "./rpc-provider-budget";
import { parseQuantityHex } from "./bigint";
import type { SubrequestBudget } from "./evm-logs";
import { budgetExhausted } from "./evm-logs";
import { batchExecute, buildInClause } from "./db";
import { rethrowIfAborted, throwIfAborted } from "./abort";
import { requestJsonRpcAtUrl } from "./evm-rpc";
import { logWorkerEvent } from "./structured-log";
import type { CacheRetentionPolicy } from "./db-cache";
import { DAY_SECONDS } from "@shared/lib/time-constants";

const ALCHEMY_RPC_TIMEOUT_MS = 30_000;
const TRANSACTION_CONTEXT_MAX_MEMBER_RETRIES = 8;
const ALCHEMY_RPC_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

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
  blockHash?: string | null;
  from?: string;
  blockNumber?: string;
}

export interface AlchemyTransactionReceipt {
  transactionHash: string;
  to: string | null;
  logs: AlchemyLogEntry[];
  blockHash?: string;
  blockNumber?: string;
  status?: string;
}

export interface AlchemyTransactionContextBatch {
  tx: AlchemyTransactionEntry | null;
  receipt: AlchemyTransactionReceipt | null;
  unavailableReason?: "rpc-request-not-started";
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
  unavailableReason?: "rpc-request-not-started";
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
  localCache?: Map<string, number>;
  blockHashes?: ReadonlyMap<number, string>;
  persistentCache?: PersistentBlockTimestampCache;
  deadlineMs?: number;
}

/** A mixed fork at one height cannot establish any log's timestamp. */
export function blockHashesForLogs(logs: readonly Pick<AlchemyLogEntry, "blockNumber" | "blockHash">[]): Map<number, string> {
  const hashes = new Map<number, string>();
  for (const log of logs) {
    const block = Number(log.blockNumber);
    const hash = log.blockHash?.toLowerCase();
    if (!Number.isSafeInteger(block) || !hash) continue;
    const previous = hashes.get(block);
    hashes.set(block, previous != null && previous !== hash ? "conflicting-block-hashes" : hash);
  }
  return hashes;
}

// --- URL builder ---

export function buildAlchemyUrl(chainId: string, apiKey: string): string | null {
  const slug = ALCHEMY_CHAINS[chainId];
  if (!slug) return null;
  return buildAlchemyRpcUrl(slug, apiKey);
}

// --- Helpers ---
function isAlchemyLogEntry(value: unknown): value is AlchemyLogEntry {
  if (!value || typeof value !== "object") return false;
  const log = value as Record<string, unknown>;
  return typeof log.address === "string"
    && Array.isArray(log.topics)
    && log.topics.every((topic) => typeof topic === "string")
    && typeof log.data === "string"
    && typeof log.blockNumber === "string"
    && typeof log.transactionHash === "string"
    && typeof log.transactionIndex === "string"
    && typeof log.blockHash === "string"
    && typeof log.logIndex === "string"
    && typeof log.removed === "boolean";
}

function isAlchemyTransactionEntry(value: unknown, txHash: string): value is AlchemyTransactionEntry {
  if (!value || typeof value !== "object") return false;
  const tx = value as Record<string, unknown>;
  return tx.hash === txHash
    && (typeof tx.to === "string" || tx.to === null)
    && typeof tx.input === "string";
}

function isAlchemyTransactionReceipt(value: unknown, txHash: string): value is AlchemyTransactionReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Record<string, unknown>;
  return receipt.transactionHash === txHash
    && (typeof receipt.to === "string" || receipt.to === null)
    && Array.isArray(receipt.logs)
    && receipt.logs.every(isAlchemyLogEntry);
}

async function jsonRpcCall<T>(
  alchemyUrl: string,
  method: string,
  params: unknown[],
  signal?: AbortSignal,
  timeoutMs = ALCHEMY_RPC_TIMEOUT_MS,
): Promise<JsonRpcCallResult<T>> {
  if (getRpcAuth(alchemyUrl)?.provider === "dwellir") recordDwellirCredits(1);
  const fetched = await requestJsonRpcAtUrl(alchemyUrl, { jsonrpc: "2.0", id: 1, method, params }, {
    signal, responseMode: "text",
    timeoutMs: Math.max(1, Math.min(ALCHEMY_RPC_TIMEOUT_MS, timeoutMs)),
    maxResponseBytes: ALCHEMY_RPC_MAX_RESPONSE_BYTES,
  });
  if (fetched.status === "control-error") {
    throwIfAborted(signal);
    return { result: null, error: { code: -1, message: "rpc-request-not-started" }, status: 0,
      transientHttpError: false, unavailableReason: "rpc-request-not-started" };
  }
  if (fetched.status === "transport-error") {
    throwIfAborted(signal);
    logWorkerEvent({
      scope: "lib",
      level: "debug",
      event: "alchemy_json_rpc_fetch_failed",
      message: "Alchemy JSON-RPC fetch failed",
      provider: "alchemy",
      metadata: { method },
    });
    return {
      result: null,
      error: { code: -1, message: "network failure" },
      status: 0,
      transientHttpError: true,
    };
  }
  const res = fetched.response;

  const transientHttpError = !res.ok && (res.status >= 500 || res.status === 429 || res.status === 408);

  if (fetched.status === "parse-error") {
    const err = fetched.error;
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
  if (fetched.status === "invalid-envelope") {
    return { result: null, error: { code: -1, message: "invalid response identity" }, status: res.status, transientHttpError };
  }
  const json = fetched.body as JsonRpcResponse<T> | null;

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
    rethrowIfAborted(err, signal);
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
  deadlineMs?: number,
): Promise<Map<string, AlchemyTransactionContextBatch>> {
  const uniqueTxHashes = [...new Set(txHashes)];
  const results = new Map<string, AlchemyTransactionContextBatch>(
    uniqueTxHashes.map((txHash) => [txHash, { tx: null, receipt: null }]),
  );
  throwIfAborted(signal);
  if (uniqueTxHashes.length === 0 || budgetExhausted(budget) || (deadlineMs != null && Date.now() >= deadlineMs)) return results;
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

  if (getRpcAuth(alchemyUrl)?.provider === "dwellir") recordDwellirCredits(payload.length);
  const fetched = await requestJsonRpcAtUrl(alchemyUrl, payload, {
    signal, responseMode: "text",
    timeoutMs: Math.max(1, Math.min(ALCHEMY_RPC_TIMEOUT_MS, timeoutMs, deadlineMs != null ? deadlineMs - Date.now() : Infinity)),
    maxResponseBytes: ALCHEMY_RPC_MAX_RESPONSE_BYTES,
  });
  if (fetched.status === "control-error") {
    throwIfAborted(signal);
    for (const context of results.values()) context.unavailableReason = "rpc-request-not-started";
    return results;
  }
  if (fetched.status === "transport-error") {
    throwIfAborted(signal);
    logWorkerEvent({
      scope: "lib",
      level: "debug",
      event: "alchemy_transaction_context_batch_fetch_failed",
      message: "Alchemy transaction-context batch fetch failed",
      provider: "alchemy",
    });
    return results;
  }
  const res = fetched.response;

  if (!res.ok) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "alchemy_transaction_context_batch_http_error",
      message: "Alchemy transaction-context batch returned an HTTP error",
      provider: "alchemy",
      status: res.status,
    });
    return results;
  }

  if (fetched.status === "parse-error") {
    const err = fetched.error;
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
  const parsed = fetched.body;

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

  let memberRetries = 0;
  for (const item of parsed as Array<JsonRpcResponse<unknown>>) {
    if (!fetched.rows.has(item?.id)) continue;
    if (item?.error?.code === -32000 && (item.error.message ?? "").toLowerCase().includes("batch not executed")
      && Number.isInteger(item.id) && item.id >= 0 && item.id < payload.length && !budgetExhausted(budget)
      && memberRetries < TRANSACTION_CONTEXT_MAX_MEMBER_RETRIES && (deadlineMs == null || Date.now() < deadlineMs)) {
      // Retry unexecuted members serially within the caller's abort, deadline,
      // and request budgets. Excess members retain their fail-closed context.
      throwIfAborted(signal);
      budget.count++;
      memberRetries++;
      const request = payload[item.id]!;
      const retryTimeoutMs = deadlineMs != null ? Math.min(timeoutMs, deadlineMs - Date.now()) : timeoutMs;
      const retried = await jsonRpcCall<unknown>(alchemyUrl, request.method, request.params, signal, retryTimeoutMs);
      item.result = retried.result;
      item.error = retried.error ?? undefined;
      if (retried.unavailableReason) results.get(uniqueTxHashes[Math.floor(item.id / 2)]!)!.unavailableReason = retried.unavailableReason;
    }
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
    const txHash = uniqueTxHashes[Math.floor(item.id / 2)];
    if (!txHash) continue;
    const current = results.get(txHash) ?? { tx: null, receipt: null };
    const validResult = item.result == null
      ? null
      : item.id % 2 === 0
      ? isAlchemyTransactionEntry(item.result, txHash)
        ? item.result
        : null
      : isAlchemyTransactionReceipt(item.result, txHash)
      ? item.result
      : null;
    if (item.result != null && validResult == null) {
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: "alchemy_transaction_context_batch_malformed_item",
        message: "Alchemy transaction-context batch item had a malformed result",
        provider: "alchemy",
        metadata: { txHash, responseId: item.id, kind: item.id % 2 === 0 ? "transaction" : "receipt" },
      });
    }
    if (item.id % 2 === 0) {
      current.tx = validResult as AlchemyTransactionEntry | null;
    } else {
      current.receipt = validResult as AlchemyTransactionReceipt | null;
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
  options?: { deadlineMs?: number; maxSplitCalls?: number; endpoint?: RpcEndpoint; headBlock?: number },
): Promise<AlchemyLogsFetchResult | null> {
  const callBudget = {
    count: 0,
    limit: Math.max(1, Math.floor(options?.maxSplitCalls ?? DEFAULT_LOG_SPLIT_MAX_CALLS)),
  };
  const endpoint = options?.endpoint;
  // A retained-block count floors at `head - retainedBlocks + 1`, the same
  // boundary evm-rpc.ts admits; one block earlier was silently a pruned page.
  if (endpoint?.logsHistory === "none" || (typeof endpoint?.logsHistory === "object"
    && (options?.headBlock == null || fromBlock < options.headBlock - endpoint.logsHistory.retainedBlocks + 1))) {
    return { logs: [], complete: false, scannedToBlock: fromBlock - 1, calls: 0, maxDepth: 0,
      failureReason: "log-history-unavailable" };
  }
  // Preserve incumbent lane windows; these measured caps admit the new Dwellir route.
  const span = endpoint?.operator === "dwellir" ? endpoint.maxLogBlockSpan : undefined;
  if (span != null && (!Number.isSafeInteger(span) || span < 1)) {
    return { logs: [], complete: false, scannedToBlock: fromBlock - 1, calls: 0, maxDepth: 0,
      failureReason: "invalid-log-span" };
  }
  if (span != null && toBlock - fromBlock + 1 > span) {
    const logs: AlchemyLogEntry[] = [];
    let calls = 0;
    let maxDepth = 0;
    for (let start = fromBlock; start <= toBlock; start += span) {
      const end = Math.min(toBlock, start + span - 1);
      const page = await fetchAlchemyLogsRange(alchemyUrl, contractAddress, topics, start, end,
        budget, signal, 0, options, callBudget);
      logs.push(...page.logs);
      calls += page.calls;
      maxDepth = Math.max(maxDepth, page.maxDepth);
      if (!page.complete) return { ...page, logs, calls, maxDepth };
    }
    return { logs, complete: true, scannedToBlock: toBlock, calls, maxDepth };
  }
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
    if (rpc.unavailableReason) {
      return { logs: [], complete: false, scannedToBlock: fromBlock - 1, calls: 0, maxDepth: depth,
        failureReason: rpc.unavailableReason };
    }
    if (Array.isArray(rpc.result)) {
      if (!rpc.result.every((log) => isAlchemyLogEntry(log) && log.blockHash.length > 0)) {
        return { logs: [], complete: false, scannedToBlock: fromBlock - 1, calls: 1, maxDepth: depth,
          failureReason: "invalid-log-payload" };
      }
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
    rethrowIfAborted(e, signal);
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
const ALCHEMY_BLOCK_TIMESTAMP_CACHE_POLICY = {
  storage: "domain-table",
  schemaId: "alchemy:block-timestamp:v1",
  ttlSec: DEFAULT_TIMESTAMP_CACHE_MAX_AGE_SEC,
  stale: "reject",
  invalid: "retain",
} satisfies CacheRetentionPolicy;
const TIMESTAMP_RETRY_BATCH_SIZES = [TIMESTAMP_BATCH_SIZE, 10, 1] as const;

interface BlockTimestampBatchResult {
  timestamps: Map<number, number>;
  blockHashes: Map<number, string>;
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
    blockHashes: new Map<number, string>(),
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
    if (getRpcAuth(alchemyUrl)?.provider === "dwellir") recordDwellirCredits(payload.length);
    const fetched = await requestJsonRpcAtUrl(alchemyUrl, payload, {
      signal, responseMode: "text",
      timeoutMs: Math.max(1, Math.min(ALCHEMY_RPC_TIMEOUT_MS, timeoutMs)),
      maxResponseBytes: ALCHEMY_RPC_MAX_RESPONSE_BYTES,
    });
    if (fetched.status === "transport-error" || fetched.status === "control-error") {
      if (fetched.error != null) throw fetched.error;
      return missingAll();
    }
    const res = fetched.response;
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
      return missingAll();
    }

    if (fetched.status === "parse-error") throw fetched.error;
    const parsed = fetched.body;
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

    const headers = new Map<number, { number: number; hash: string; timestamp: number }>();
    let issueCount = 0;
    for (const response of parsed) {
      if (!response || typeof response !== "object") {
        issueCount++;
        continue;
      }
      const rpc = response as Partial<JsonRpcResponse<{ number: string; timestamp: string; hash: string }>>;
      const requestIndex = rpc.id;
      if (typeof requestIndex !== "number" || !Number.isInteger(requestIndex)) {
        issueCount++;
        continue;
      }
      if (requestIndex < 0 || requestIndex >= batch.length) {
        issueCount++;
        continue;
      }
      if (!fetched.rows.has(requestIndex) || rpc.error) {
        issueCount++;
        continue;
      }

      const block = rpc.result;
      const numberQuantity = parseQuantityHex(block?.number);
      const timestampQuantity = parseQuantityHex(block?.timestamp);
      const number = numberQuantity == null ? null : Number(numberQuantity);
      const timestamp = timestampQuantity == null ? null : Number(timestampQuantity);
      if (number === batch[requestIndex] && Number.isSafeInteger(number) &&
          timestamp !== null && Number.isSafeInteger(timestamp) && timestamp > 0 &&
          typeof block?.hash === "string" && /^0x[0-9a-f]{64}$/i.test(block.hash)) {
        headers.set(number, { number, timestamp, hash: block.hash.toLowerCase() });
      } else {
        issueCount++;
      }
    }

    const timestamps = new Map([...headers].map(([number, header]) => [number, header.timestamp]));
    const blockHashes = new Map([...headers].map(([number, header]) => [number, header.hash]));

    const missingBlocks = batch.filter((block) => !timestamps.has(block));
    if (missingBlocks.length > 0) issueCount++;
    return { timestamps, blockHashes, missingBlocks, issueCount };
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
  const expectedHash = (block: number) => options?.blockHashes?.get(block)?.toLowerCase();
  const localKey = (block: number) => `${block}:${expectedHash(block) ?? "unverified"}`;

  for (const block of uniqueBlocks) {
    const cached = localCache?.get(localKey(block));
    if (cached != null) {
      timestamps.set(block, cached);
    }
  }

  let unresolved = uniqueBlocks.filter((block) => !timestamps.has(block));

  if (persistentCache && unresolved.length > 0) {
    const maxAgeSec = persistentCache.maxAgeSec ?? ALCHEMY_BLOCK_TIMESTAMP_CACHE_POLICY.ttlSec;
    const cutoff = nowSec - maxAgeSec;
    for (let i = 0; i < unresolved.length; i += TIMESTAMP_CACHE_READ_CHUNK) {
      throwIfAborted(options?.signal);
      const batchBlocks = unresolved.slice(i, i + TIMESTAMP_CACHE_READ_CHUNK);
      const blockInClause = buildInClause(batchBlocks);
      const rows = await persistentCache.db
        .prepare(
          `SELECT block_number, timestamp, block_hash
           FROM block_timestamp_cache
           WHERE chain_id = ?
             AND updated_at >= ?
             AND block_number IN (${blockInClause.sql})`,
        )
        .bind(persistentCache.chainId, cutoff, ...blockInClause.binds)
        .all<{ block_number: number; timestamp: number; block_hash: string | null }>();

      for (const row of rows.results ?? []) {
        if (expectedHash(row.block_number) != null && row.block_hash?.toLowerCase() !== expectedHash(row.block_number)) continue;
        timestamps.set(row.block_number, row.timestamp);
        localCache?.set(localKey(row.block_number), row.timestamp);
      }
    }
    unresolved = uniqueBlocks.filter((block) => !timestamps.has(block));
  }

  const freshResolvedForCache = new Map<number, number>();
  const freshHashes = new Map<number, string>();
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
        const hash = result.blockHashes.get(block);
        if (expectedHash(block) != null && hash !== expectedHash(block)) continue;
        timestamps.set(block, ts);
        localCache?.set(localKey(block), ts);
        freshResolvedForCache.set(block, ts);
        if (hash) freshHashes.set(block, hash);
      }
      stillMissing.push(...batch.filter((block) => !timestamps.has(block)));
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
            (chain_id, block_number, timestamp, updated_at, block_hash)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(persistentCache.chainId, block, ts, nowSec, freshHashes.get(block) ?? null),
    );
    await batchExecute(persistentCache.db, stmts, {
      chunkSize: TIMESTAMP_CACHE_READ_CHUNK,
      signal: options?.signal,
    });
  }

  return timestamps;
}
