import { ETHERSCAN_V2_BASE } from "./constants";
import { decimalNumberFromBigInt } from "./bigint";
import { fetchJsonWithRetry } from "./fetch-retry";
import { logWorkerEvent } from "./structured-log";

const MAX_RECURSION_DEPTH = 8;
const ETHERSCAN_MAX_RESULTS = 1000;

// --- Budget tracking ---

export interface SubrequestBudget {
  count: number;
  limit: number;
}

export function createBudget(limit = 900): SubrequestBudget {
  return { count: 0, limit };
}

export function budgetExhausted(budget: SubrequestBudget): boolean {
  return budget.count >= budget.limit;
}

// --- Rate limiting ---

// The configured throughput travels with the limiter so callers that report it
// (cron run metadata) read the rate actually in force rather than restating a
// default an injected limiter may have replaced. Hand-rolled limiters may omit
// it, so treat it as unknown rather than assuming a default.
export type RateLimitedFetch = {
  <T>(fn: () => Promise<T>): Promise<T>;
  readonly requestsPerSecond?: number;
};

export function createRateLimiter(requestsPerSecond: number): RateLimitedFetch {
  let pending = Promise.resolve();
  const interval = Math.ceil(1000 / requestsPerSecond);

  const limiter = function <T>(fn: () => Promise<T>): Promise<T> {
    const execute = pending.then(async () => {
      const result = await fn();
      await new Promise((r) => setTimeout(r, interval));
      return result;
    });
    pending = execute.then(
      () => {},
      () => {},
    );
    return execute;
  };

  return Object.assign(limiter, { requestsPerSecond });
}

// --- Helpers ---

export function decodeAddress(topicOrData: string): string {
  const cleaned = topicOrData.startsWith("0x") ? topicOrData.slice(2) : topicOrData;
  return "0x" + cleaned.slice(24).toLowerCase();
}

export function decodeAddressWord(topicOrData: string | null | undefined): string | null {
  if (typeof topicOrData !== "string") return null;
  const cleaned = topicOrData.startsWith("0x") ? topicOrData.slice(2) : topicOrData;
  if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) return null;
  return "0x" + cleaned.slice(24).toLowerCase();
}

export function decodeUint256(hexData: string, decimals: number): number {
  const cleaned = hexData.startsWith("0x") ? hexData.slice(2) : hexData;
  return decimalNumberFromBigInt(BigInt("0x" + cleaned), decimals);
}

export function decodeUint256Word(hexData: string | null | undefined, decimals: number): number | null {
  if (typeof hexData !== "string") return null;
  const cleaned = hexData.startsWith("0x") ? hexData.slice(2) : hexData;
  if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) return null;
  return decimalNumberFromBigInt(BigInt("0x" + cleaned), decimals);
}

/**
 * Decode a specific 32-byte slot (0-indexed) from ABI-encoded event data.
 * Handles multi-param events where the amount is not in the first slot.
 * Returns 0 when the data is shorter than expected.
 */
export function decodeUint256AtSlot(hexData: string, slotIndex: number, decimals: number): number {
  const cleaned = hexData.startsWith("0x") ? hexData.slice(2) : hexData;
  const start = slotIndex * 64;
  const slot = cleaned.slice(start, start + 64);
  if (slot.length < 64) return 0;
  return decimalNumberFromBigInt(BigInt("0x" + slot), decimals);
}

export function decodeUint256AtSlotOrNull(hexData: string, slotIndex: number, decimals: number): number | null {
  return decodeUint256Word(readDataWord(hexData, slotIndex), decimals);
}

/**
 * Extract a 32-byte data word (hex string with 0x prefix) at slot index from
 * ABI-encoded event data. Returns null when data is shorter than expected.
 * Compose with `decodeAddress(...)` to extract unindexed address parameters.
 */
export function readDataWord(hexData: string, slotIndex: number): string | null {
  const cleaned = hexData.startsWith("0x") ? hexData.slice(2) : hexData;
  const start = slotIndex * 64;
  if (cleaned.length < start + 64) return null;
  return "0x" + cleaned.slice(start, start + 64);
}

// --- Chain head (current block number) ---

export async function getEvmBlockNumber(
  evmChainId: number,
  apiKey: string | null,
  rateLimit: RateLimitedFetch,
  budget: SubrequestBudget,
  signal?: AbortSignal,
): Promise<number | null> {
  if (budgetExhausted(budget)) return null;

  const params = new URLSearchParams({
    chainid: evmChainId.toString(),
    module: "proxy",
    action: "eth_blockNumber",
  });
  if (apiKey) params.set("apikey", apiKey);

  try {
    budget.count++;
    const json = await rateLimit(async () => {
      const result = await fetchJsonWithRetry<{ result?: string }>(
        `${ETHERSCAN_V2_BASE}?${params}`,
        { signal },
        0,
        { returnFinalResponse: true, maxResponseBytes: 256 * 1024 },
      );
      return result?.response.ok ? result.body : null;
    });
    if (!json?.result || !/^0x[0-9a-fA-F]+$/.test(json.result)) return null;
    const parsed = Number.parseInt(json.result, 16);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// --- EVM log fetching ---

export interface EtherscanLogEntry {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  timeStamp: string;
  transactionHash: string;
  logIndex: string;
}

export interface EvmLogFetchResult {
  logs: EtherscanLogEntry[];
  complete: boolean;
  scannedToBlock: number;
  calls: number;
  maxDepth: number;
  failureReason?: string;
}

/**
 * Fetch EVM logs for a single topic0 hash from Etherscan v2.
 *
 * Returns a completeness-aware result so callers can distinguish reliable
 * empty scans from partial failures; splits the block range recursively
 * when the provider caps results.
 */
export async function fetchEvmLogsForTopicWithCompleteness(
  evmChainId: number,
  contractAddress: string,
  topicHash: string,
  apiKey: string | null,
  fromBlock: number,
  toBlock: number,
  depth: number,
  rateLimit: RateLimitedFetch,
  budget: SubrequestBudget,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<EvmLogFetchResult> {
  const unscannedBlock = fromBlock - 1;
  if (budgetExhausted(budget)) {
    return {
      logs: [],
      complete: false,
      scannedToBlock: unscannedBlock,
      calls: 0,
      maxDepth: depth,
      failureReason: "budget-exhausted",
    };
  }
  if (depth > MAX_RECURSION_DEPTH) {
    return {
      logs: [],
      complete: false,
      scannedToBlock: unscannedBlock,
      calls: 0,
      maxDepth: depth,
      failureReason: "max-recursion-depth",
    };
  }

  const params = new URLSearchParams({
    chainid: evmChainId.toString(),
    module: "logs",
    action: "getLogs",
    address: contractAddress,
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    topic0: topicHash,
  });
  if (apiKey) params.set("apikey", apiKey);

  budget.count++;
  const timeout = AbortSignal.timeout(timeoutMs);
  const json = await rateLimit(async () => {
    const result = await fetchJsonWithRetry<{ status: string; message: string; result: EtherscanLogEntry[] }>(
      `${ETHERSCAN_V2_BASE}?${params}`,
      {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      },
      1,
    );
    if (!result?.response.ok) {
      if (result) {
        logWorkerEvent({ scope: "lib", level: "warn", event: "etherscan_logs_http_error", message: "Etherscan log request returned an HTTP error", provider: "etherscan", status: result.response.status, metadata: { chainId: evmChainId } });
      }
      return null;
    }
    return result.body;
  });

  if (!json || json.status !== "1" || !Array.isArray(json.result)) {
    if (json?.message === "No records found") {
      return { logs: [], complete: true, scannedToBlock: toBlock, calls: 1, maxDepth: depth };
    }
    // API error — return incomplete so callers know the scan was not reliable.
    if (json) {
      logWorkerEvent({ scope: "lib", level: "warn", event: "etherscan_logs_api_error", message: "Etherscan log request returned an API error", provider: "etherscan", metadata: { chainId: evmChainId, upstreamMessage: json.message, upstreamResult: json.result ? String(json.result).slice(0, 200) : "no result" } });
    }
    return {
      logs: [],
      complete: false,
      scannedToBlock: unscannedBlock,
      calls: 1,
      maxDepth: depth,
      failureReason: json?.message ?? "etherscan-api-error",
    };
  }

  const logs = json.result;

  if (logs.length >= ETHERSCAN_MAX_RESULTS) {
    const mid = Math.floor((fromBlock + toBlock) / 2);
    if (mid === fromBlock) {
      return {
        logs,
        complete: false,
        scannedToBlock: unscannedBlock,
        calls: 1,
        maxDepth: depth,
        failureReason: "etherscan-result-cap-unsplittable",
      };
    }

    // Sequential splits to avoid fanning out into 2^depth concurrent connections.
    // Matches the sequential pattern in alchemy-logs.ts.
    const first = await fetchEvmLogsForTopicWithCompleteness(
      evmChainId,
      contractAddress,
      topicHash,
      apiKey,
      fromBlock,
      mid,
      depth + 1,
      rateLimit,
      budget,
      signal,
      timeoutMs,
    );
    if (!first.complete) {
      return {
        ...first,
        calls: first.calls + 1,
        maxDepth: Math.max(depth, first.maxDepth),
      };
    }
    const second = await fetchEvmLogsForTopicWithCompleteness(
      evmChainId,
      contractAddress,
      topicHash,
      apiKey,
      mid + 1,
      toBlock,
      depth + 1,
      rateLimit,
      budget,
      signal,
      timeoutMs,
    );
    return {
      logs: [...first.logs, ...second.logs],
      complete: second.complete,
      scannedToBlock: second.complete ? toBlock : second.scannedToBlock,
      calls: 1 + first.calls + second.calls,
      maxDepth: Math.max(depth, first.maxDepth, second.maxDepth),
      failureReason: second.failureReason,
    };
  }

  return { logs, complete: true, scannedToBlock: toBlock, calls: 1, maxDepth: depth };
}
