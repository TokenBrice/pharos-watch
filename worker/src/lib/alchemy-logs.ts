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
