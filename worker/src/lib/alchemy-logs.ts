import { ALCHEMY_CHAINS } from "./chain-registry";
import type { SubrequestBudget, TopicFilter } from "./evm-logs";
import { budgetExhausted } from "./evm-logs";
import { buildInClause } from "./db";

// --- Types ---

export interface AlchemyLogEntry {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;   // hex
  transactionHash: string;
  transactionIndex: string; // hex
  blockHash: string;
  logIndex: string;       // hex
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
): Promise<JsonRpcCallResult<T>> {
  const timeout = AbortSignal.timeout(30_000);
  let res: Response;
  try {
    res = await fetch(alchemyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
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
  } catch {
    if (transientHttpError) {
      console.warn(`[alchemy-logs] ${method} HTTP ${res.status} non-JSON body`);
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
    console.warn(`[alchemy-logs] ${method} error (${json.error.code}): ${json.error.message}`);
    return {
      result: null,
      error: json.error,
      status: res.status,
      transientHttpError,
    };
  }

  if (!res.ok) {
    console.warn(`[alchemy-logs] ${method} HTTP ${res.status} with no JSON-RPC error`);
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
  } catch {
    return null;
  }
}

export async function getAlchemyTransactionByHash(
  alchemyUrl: string,
  txHash: string,
  budget: SubrequestBudget,
  signal?: AbortSignal,
): Promise<AlchemyTransactionEntry | null> {
  if (budgetExhausted(budget)) return null;
  budget.count++;
  try {
    const rpc = await jsonRpcCall<AlchemyTransactionEntry>(
      alchemyUrl,
      "eth_getTransactionByHash",
      [txHash],
      signal,
    );
    return rpc.result ?? null;
  } catch {
    return null;
  }
}

export async function getAlchemyTransactionReceipt(
  alchemyUrl: string,
  txHash: string,
  budget: SubrequestBudget,
  signal?: AbortSignal,
): Promise<AlchemyTransactionReceipt | null> {
  if (budgetExhausted(budget)) return null;
  budget.count++;
  try {
    const rpc = await jsonRpcCall<AlchemyTransactionReceipt>(
      alchemyUrl,
      "eth_getTransactionReceipt",
      [txHash],
      signal,
    );
    return rpc.result ?? null;
  } catch {
    return null;
  }
}

// --- Log fetching ---

export async function fetchAlchemyLogs(
  alchemyUrl: string,
  contractAddress: string,
  topics: TopicFilter[],
  fromBlock: number,
  toBlock: number,
  budget: SubrequestBudget,
  signal?: AbortSignal,
): Promise<AlchemyLogsFetchResult | null> {
  return fetchAlchemyLogsRange(
    alchemyUrl,
    contractAddress,
    topics,
    fromBlock,
    toBlock,
    budget,
    signal,
    0,
  );
}

const LOG_SPLIT_MAX_DEPTH = 8;
const LOG_SPLIT_MIN_RANGE = 8;

function shouldSplitLogRange(errorMessage: string | null, code: number | null, status: number, transientHttpError: boolean): boolean {
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
  topics: TopicFilter[],
  fromBlock: number,
  toBlock: number,
  budget: SubrequestBudget,
  signal: AbortSignal | undefined,
  depth: number,
): Promise<FetchLogsRangeResult> {
  if (fromBlock > toBlock) {
    return { logs: [], complete: true, scannedToBlock: toBlock, calls: 0, maxDepth: depth };
  }

  if (budgetExhausted(budget)) {
    return { logs: [], complete: false, scannedToBlock: fromBlock - 1, calls: 0, maxDepth: depth };
  }
  budget.count++;

  const topicArray: (string | null)[] = [];
  for (const { index, value } of topics) {
    while (topicArray.length <= index) topicArray.push(null);
    topicArray[index] = value;
  }

  const params = [{
    address: contractAddress,
    fromBlock: "0x" + fromBlock.toString(16),
    toBlock: "0x" + toBlock.toString(16),
    topics: topicArray,
  }];

  try {
    const rpc = await jsonRpcCall<AlchemyLogEntry[]>(alchemyUrl, "eth_getLogs", params, signal);
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
      return { logs: [], complete: false, scannedToBlock: fromBlock - 1, calls: 1, maxDepth: depth };
    }

    const mid = Math.floor((fromBlock + toBlock) / 2);
    if (mid <= fromBlock || mid >= toBlock) {
      return { logs: [], complete: false, scannedToBlock: fromBlock - 1, calls: 1, maxDepth: depth };
    }

    const [left, right] = await Promise.all([
      fetchAlchemyLogsRange(
        alchemyUrl,
        contractAddress,
        topics,
        fromBlock,
        mid,
        budget,
        signal,
        depth + 1,
      ),
      fetchAlchemyLogsRange(
        alchemyUrl,
        contractAddress,
        topics,
        mid + 1,
        toBlock,
        budget,
        signal,
        depth + 1,
      ),
    ]);

    return {
      logs: [...left.logs, ...right.logs],
      complete: left.complete && right.complete,
      scannedToBlock: left.complete ? right.scannedToBlock : left.scannedToBlock,
      calls: 1 + left.calls + right.calls,
      maxDepth: Math.max(depth, left.maxDepth, right.maxDepth),
    };
  } catch (e) {
    console.warn("[alchemy-logs] eth_getLogs failed:", e);
    return { logs: [], complete: false, scannedToBlock: fromBlock - 1, calls: 1, maxDepth: depth };
  }
}

// --- Block timestamps ---

const TIMESTAMP_BATCH_SIZE = 50;
// D1 enforces a relatively low SQL variable cap in some environments; keep this conservative.
const D1_SAFE_MAX_SQL_VARIABLES = 90;
const TIMESTAMP_CACHE_READ_FIXED_BINDINGS = 2; // chain_id + updated_at
const TIMESTAMP_CACHE_READ_CHUNK = Math.max(
  1,
  D1_SAFE_MAX_SQL_VARIABLES - TIMESTAMP_CACHE_READ_FIXED_BINDINGS,
);
const DEFAULT_TIMESTAMP_CACHE_MAX_AGE_SEC = 14 * 86400;

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
  for (let i = 0; i < unresolved.length; i += TIMESTAMP_BATCH_SIZE) {
    if (budgetExhausted(budget)) break;
    budget.count++;

    const batch = unresolved.slice(i, i + TIMESTAMP_BATCH_SIZE);
    const payload = batch.map((block, idx) => ({
      jsonrpc: "2.0",
      id: idx,
      method: "eth_getBlockByNumber",
      params: ["0x" + block.toString(16), false],
    }));

    try {
      const timeout = AbortSignal.timeout(30_000);
      const res = await fetch(alchemyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      });
      if (!res.ok) {
        console.warn(`[alchemy-logs] batch eth_getBlockByNumber HTTP ${res.status}`);
        await res.body?.cancel();
        continue;
      }
      const parsed = await res.json() as unknown;
      if (!Array.isArray(parsed)) {
        console.warn("[alchemy-logs] batch eth_getBlockByNumber returned non-array JSON body");
        continue;
      }

      for (const response of parsed) {
        if (!response || typeof response !== "object") continue;
        const rpc = response as Partial<JsonRpcResponse<{ timestamp: string }>>;
        const requestIndex = rpc.id;
        if (typeof requestIndex !== "number" || !Number.isInteger(requestIndex)) continue;
        if (requestIndex < 0 || requestIndex >= batch.length) continue;

        const tsHex = rpc.result?.timestamp;
        if (typeof tsHex !== "string") continue;

        const ts = parseInt(tsHex, 16);
        if (Number.isFinite(ts)) {
          // Duplicate IDs are deterministic: the last valid mapping wins.
          timestamps.set(batch[requestIndex], ts);
          localCache?.set(batch[requestIndex], ts);
          freshResolvedForCache.set(batch[requestIndex], ts);
        }
      }
    } catch (e) {
      console.warn(`[alchemy-logs] batch timestamp fetch failed:`, e);
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
      await persistentCache.db.batch(stmts.slice(i, i + TIMESTAMP_CACHE_READ_CHUNK));
    }
  }

  return timestamps;
}
