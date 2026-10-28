export const TRON_RPC_MAX_BLOCK_SPAN = 10_000;
export const TRON_RPC_MAX_RESPONSE_BYTES = 128 * 1024;
export const TRON_RPC_BLOCK_CONTEXT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// getnowblock includes transactions even with detail:false.
export const TRON_SOLID_HEAD_MAX_RESPONSE_BYTES = 1024 * 1024;
export const TRON_SOLID_HEAD_MAX_AGE_MS = 10 * 60 * 1000;
export const TRON_SOLID_HEAD_MAX_FUTURE_MS = 30 * 1000;

export function tronRpcQuantity(value: unknown): number | null {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function isTronLogFilter(value: unknown): boolean {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const filter = value as Record<string, unknown>;
  if (Object.keys(filter).some((key) => !["fromBlock", "toBlock", "address", "topics"].includes(key))) return false;
  const from = tronRpcQuantity(filter.fromBlock);
  const to = tronRpcQuantity(filter.toBlock);
  if (from == null || to == null || from > to || to - from >= TRON_RPC_MAX_BLOCK_SPAN) return false;
  // Full single-block context is needed to recover TronGrid's transaction-local event identity.
  if (filter.address === undefined && filter.topics === undefined) return from === to;
  return typeof filter.address === "string" && /^0x[0-9a-f]{40}$/i.test(filter.address)
    && Array.isArray(filter.topics) && filter.topics.length === 1
    && Array.isArray(filter.topics[0]) && filter.topics[0].length > 0 && filter.topics[0].length <= 16
    && filter.topics[0].every((topic: unknown) => typeof topic === "string" && /^0x[0-9a-f]{64}$/i.test(topic));
}

export function isTronJsonRpcRead(value: unknown): boolean {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (body.jsonrpc !== "2.0" || !Number.isSafeInteger(body.id) || !Array.isArray(body.params)
    || Object.keys(body).some((key) => !["jsonrpc", "id", "method", "params"].includes(key))) return false;
  if (body.method === "eth_blockNumber") return body.params.length === 0;
  if (body.method === "eth_getBlockByNumber") {
    return body.params.length === 2 && body.params[1] === false
      && (body.params[0] === "latest" || tronRpcQuantity(body.params[0]) != null);
  }
  return body.method === "eth_getLogs" && body.params.length === 1 && isTronLogFilter(body.params[0]);
}

export function tronRpcResponseByteLimit(path: string, body: unknown): number {
  if (path === "/walletsolidity/getnowblock") return TRON_SOLID_HEAD_MAX_RESPONSE_BYTES;
  if (path === "/jsonrpc" && isTronJsonRpcRead(body)) {
    const request = body as { method: string; params: unknown[] };
    if (request.method === "eth_getLogs") {
      const filter = request.params[0] as Record<string, unknown>;
      if (filter.address === undefined && filter.topics === undefined) return TRON_RPC_BLOCK_CONTEXT_MAX_RESPONSE_BYTES;
    }
  }
  return TRON_RPC_MAX_RESPONSE_BYTES;
}
