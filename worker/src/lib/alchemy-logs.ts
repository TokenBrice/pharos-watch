import { ALCHEMY_CHAINS } from "./chain-rpcs";
import type { SubrequestBudget } from "./evm-logs";
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
  const json = (await res.json()) as JsonRpcResponse<T>;
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
