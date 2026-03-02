import { ETHERSCAN_V2_BASE } from "./constants";
import { bigIntToDecimal } from "./bigint";

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

export type RateLimitedFetch = <T>(fn: () => Promise<T>) => Promise<T>;

export function createRateLimiter(requestsPerSecond: number): RateLimitedFetch {
  let pending = Promise.resolve();
  const interval = Math.ceil(1000 / requestsPerSecond);

  return function <T>(fn: () => Promise<T>): Promise<T> {
    const execute = pending.then(async () => {
      const result = await fn();
      await new Promise((r) => setTimeout(r, interval));
      return result;
    });
    pending = execute.then(
      () => {},
      () => {}
    );
    return execute;
  };
}

// --- Helpers ---

export function decodeAddress(topicOrData: string): string {
  const cleaned = topicOrData.startsWith("0x") ? topicOrData.slice(2) : topicOrData;
  return "0x" + cleaned.slice(24).toLowerCase();
}

export function decodeUint256(hexData: string, decimals: number): number {
  const cleaned = hexData.startsWith("0x") ? hexData.slice(2) : hexData;
  return bigIntToDecimal(BigInt("0x" + cleaned), decimals);
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
      const res = await fetch(`${ETHERSCAN_V2_BASE}?${params}`, { signal });
      if (!res.ok) { await res.body?.cancel(); return null; }
      return res.json() as Promise<{ result?: string }>;
    });
    if (!json?.result || !json.result.startsWith("0x")) return null;
    return parseInt(json.result, 16);
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

/** Topic filter entry for compound topic queries */
export interface TopicFilter {
  index: number; // 0–3
  value: string; // hex hash
}

/**
 * Build Etherscan topic filter URL params from an array of topic filters.
 * Sets `topic{N}` for each entry and `topic0_{N}_opr = "and"` for N > 0
 * (Etherscan requires explicit operator params between topic positions).
 */
export function buildTopicParams(topics: TopicFilter[]): URLSearchParams {
  const params = new URLSearchParams();
  for (const { index, value } of topics) {
    params.set(`topic${index}`, value);
    if (index > 0) {
      params.set(`topic0_${index}_opr`, "and");
    }
  }
  return params;
}

/**
 * Fetch EVM logs for a specific topic from Etherscan v2.
 * Returns `null` on API failure (rate limit, network error, invalid key)
 * vs `[]` for a genuine "no records found" response.
 *
 * Delegates to `fetchEvmLogsForTopics` with a single topic0 filter.
 */
export async function fetchEvmLogsForTopic(
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
): Promise<EtherscanLogEntry[] | null> {
  return fetchEvmLogsForTopics(
    evmChainId,
    contractAddress,
    [{ index: 0, value: topicHash }],
    apiKey,
    fromBlock,
    toBlock,
    depth,
    rateLimit,
    budget,
    signal,
  );
}

/**
 * Fetch EVM logs matching compound topic filters from Etherscan v2.
 * Supports filtering by topic0 alone, or topic0 + topic1/topic2 for
 * mint/burn detection (e.g. Transfer where from=zero or to=zero).
 *
 * Returns `null` on API failure (rate limit, network error, invalid key)
 * vs `[]` for a genuine "no records found" response.
 *
 * Recursively splits block ranges when result count hits Etherscan's 1000-row cap.
 */
export async function fetchEvmLogsForTopics(
  evmChainId: number,
  contractAddress: string,
  topics: TopicFilter[],
  apiKey: string | null,
  fromBlock: number,
  toBlock: number,
  depth: number,
  rateLimit: RateLimitedFetch,
  budget: SubrequestBudget,
  signal?: AbortSignal,
): Promise<EtherscanLogEntry[] | null> {
  if (budgetExhausted(budget)) return null;
  if (depth > MAX_RECURSION_DEPTH) return null;

  const topicParams = buildTopicParams(topics);
  const params = new URLSearchParams({
    chainid: evmChainId.toString(),
    module: "logs",
    action: "getLogs",
    address: contractAddress,
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
  });
  // Merge topic params into the main params
  for (const [key, value] of topicParams) {
    params.set(key, value);
  }
  if (apiKey) params.set("apikey", apiKey);

  budget.count++;
  const timeout = AbortSignal.timeout(30_000);
  const json = await rateLimit(async () => {
    const res = await fetch(`${ETHERSCAN_V2_BASE}?${params}`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) {
      console.warn(`[evm-logs] Etherscan v2 (chain ${evmChainId}) HTTP ${res.status}`);
      await res.body?.cancel();
      return null;
    }
    return res.json() as Promise<{ status: string; message: string; result: EtherscanLogEntry[] }>;
  });

  if (!json || json.status !== "1" || !Array.isArray(json.result)) {
    if (json?.message === "No records found") return [];  // Genuine: no events in range
    // API error — return null so callers know the scan was not reliable
    if (json) console.warn(`[evm-logs] Etherscan v2 (chain ${evmChainId}) API error: ${json.message}`, json.result ? String(json.result).slice(0, 200) : "no result");
    return null;
  }

  const logs = json.result;

  if (logs.length >= ETHERSCAN_MAX_RESULTS) {
    const mid = Math.floor((fromBlock + toBlock) / 2);
    if (mid === fromBlock) return logs;

    const [first, second] = await Promise.all([
      fetchEvmLogsForTopics(evmChainId, contractAddress, topics, apiKey, fromBlock, mid, depth + 1, rateLimit, budget, signal),
      fetchEvmLogsForTopics(evmChainId, contractAddress, topics, apiKey, mid + 1, toBlock, depth + 1, rateLimit, budget, signal),
    ]);
    // Combine partial results; propagate null only if both halves failed
    if (first === null && second === null) return null;
    return [...(first ?? []), ...(second ?? [])];
  }

  return logs;
}
