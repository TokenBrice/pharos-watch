import { ALCHEMY_CHAINS } from "./chain-rpcs";
import type { SubrequestBudget, TopicFilter } from "./evm-logs";
import { budgetExhausted } from "./evm-logs";

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

interface JsonRpcResponse<T> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string };
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
): Promise<T | null> {
  const timeout = AbortSignal.timeout(30_000);
  const res = await fetch(alchemyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok && res.status >= 500) {
    console.warn(`[alchemy-logs] ${method} HTTP ${res.status}`);
    await res.body?.cancel();
    return null;
  }
  let json: JsonRpcResponse<T>;
  try {
    json = (await res.json()) as JsonRpcResponse<T>;
  } catch {
    console.warn(`[alchemy-logs] ${method} HTTP ${res.status} non-JSON body`);
    return null;
  }
  if (json.error) {
    console.warn(`[alchemy-logs] ${method} error (${json.error.code}): ${json.error.message}`);
    return null;
  }
  if (!res.ok) {
    console.warn(`[alchemy-logs] ${method} HTTP ${res.status} with no JSON-RPC error`);
    return null;
  }
  return json.result ?? null;
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
    const result = await jsonRpcCall<string>(alchemyUrl, "eth_blockNumber", [], signal);
    if (!result || !result.startsWith("0x")) return null;
    return parseInt(result, 16);
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
): Promise<AlchemyLogEntry[] | null> {
  if (budgetExhausted(budget)) return null;
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
    const result = await jsonRpcCall<AlchemyLogEntry[]>(alchemyUrl, "eth_getLogs", params, signal);
    if (result === null) return null;
    return Array.isArray(result) ? result : null;
  } catch (e) {
    console.warn(`[alchemy-logs] eth_getLogs failed:`, e);
    return null;
  }
}

// --- Block timestamps ---

const TIMESTAMP_BATCH_SIZE = 50;

export async function resolveBlockTimestamps(
  alchemyUrl: string,
  blockNumbers: number[],
  budget: SubrequestBudget,
  signal?: AbortSignal,
): Promise<Map<number, number>> {
  const timestamps = new Map<number, number>();
  if (blockNumbers.length === 0) return timestamps;

  for (let i = 0; i < blockNumbers.length; i += TIMESTAMP_BATCH_SIZE) {
    if (budgetExhausted(budget)) break;
    budget.count++;

    const batch = blockNumbers.slice(i, i + TIMESTAMP_BATCH_SIZE);
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
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
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
        }
      }
    } catch (e) {
      console.warn(`[alchemy-logs] batch timestamp fetch failed:`, e);
    }
  }

  return timestamps;
}
