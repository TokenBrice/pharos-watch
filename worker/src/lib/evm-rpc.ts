import { getChainRpc } from "./chain-registry";
import { ETHERSCAN_V2_BASE } from "./constants";
import { fetchWithRetry } from "./fetch-retry";

interface JsonRpcEnvelope<T> {
  result?: T;
  error?: { message?: string };
}

export interface EvmRpcOptions {
  extraRpcUrls?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface EtherscanProxyRequest {
  evmChainId: number;
  action: "eth_call" | "eth_getStorageAt";
  apiKey?: string | null;
  blockNumberOrTag?: number | "latest";
  to?: string;
  data?: string;
  address?: string;
  position?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface EvmBlockSearchCache {
  latestBlockNumber?: number;
  blockTimestampByNumber: Map<number, number>;
}

interface EvmBlockResult {
  number: string;
  timestamp: string;
}

function buildRpcUrls(chainId?: string, extraRpcUrls?: string[]): string[] {
  const urls: string[] = [];
  if (chainId) {
    const chainRpc = getChainRpc(chainId);
    if (chainRpc) {
      urls.push(chainRpc.rpcUrl);
      if (chainRpc.fallbackRpcUrl) urls.push(chainRpc.fallbackRpcUrl);
    }
  }
  if (extraRpcUrls) {
    urls.push(...extraRpcUrls);
  }

  return Array.from(new Set(urls.filter((url) => typeof url === "string" && url.length > 0)));
}

async function fetchJsonRpcResult<T>(
  urls: string[],
  method: string,
  params: unknown[],
  options?: EvmRpcOptions,
): Promise<T | null> {
  const timeoutMs = options?.timeoutMs ?? 10_000;

  for (const rpcUrl of urls) {
    try {
      const res = await fetchWithRetry(
        rpcUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: options?.signal,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params,
          }),
        },
        1,
        { timeoutMs },
      );

      if (!res?.ok) continue;

      const body = await res.json() as JsonRpcEnvelope<T>;
      if (body.error) continue;
      if (body.result == null) continue;

      return body.result;
    } catch {
      continue;
    }
  }

  return null;
}

export function toBlockTag(blockNumberOrTag: number | "latest"): string {
  return blockNumberOrTag === "latest" ? "latest" : `0x${blockNumberOrTag.toString(16)}`;
}

function parseHexInteger(value: string | undefined): number | null {
  if (typeof value !== "string" || !value.startsWith("0x")) return null;
  const parsed = Number.parseInt(value, 16);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isHexResult(value: string | null | undefined): value is `0x${string}` {
  return typeof value === "string" && value.startsWith("0x") && value.length > 2;
}

export function parseUint256Hex(value: unknown): bigint | null {
  if (!isHexResult(typeof value === "string" ? value : null)) return null;
  try {
    return BigInt(value as `0x${string}`);
  } catch {
    return null;
  }
}

export async function fetchJsonRpcHexAtUrl(
  rpcUrl: string,
  method: string,
  params: unknown[],
  options?: Pick<EvmRpcOptions, "signal" | "timeoutMs">,
): Promise<`0x${string}` | null> {
  const result = await fetchJsonRpcResult<string>([rpcUrl], method, params, options);
  return isHexResult(result ?? undefined) && result !== "0x"
    ? result as `0x${string}`
    : null;
}

export async function fetchEvmCallHexAtBlock(
  chainId: string | undefined,
  to: string,
  data: string,
  blockNumberOrTag: number | "latest" = "latest",
  options?: EvmRpcOptions,
): Promise<`0x${string}` | null> {
  const urls = buildRpcUrls(chainId, options?.extraRpcUrls);
  if (urls.length === 0) return null;

  const result = await fetchJsonRpcResult<string>(
    urls,
    "eth_call",
    [{ to, data }, toBlockTag(blockNumberOrTag)],
    options,
  );

  if (!isHexResult(result ?? undefined) || result === "0x") return null;
  return result as `0x${string}`;
}

export async function fetchEvmUint256AtBlock(
  chainId: string | undefined,
  to: string,
  data: string,
  blockNumberOrTag: number | "latest" = "latest",
  options?: EvmRpcOptions,
): Promise<bigint | null> {
  const result = await fetchEvmCallHexAtBlock(chainId, to, data, blockNumberOrTag, options);
  return parseUint256Hex(result);
}

export async function fetchEtherscanProxyHex(
  request: EtherscanProxyRequest,
): Promise<`0x${string}` | null> {
  if (!request.apiKey) return null;

  const params = new URLSearchParams({
    chainid: request.evmChainId.toString(),
    module: "proxy",
    action: request.action,
    apikey: request.apiKey,
  });
  const blockTag = toBlockTag(request.blockNumberOrTag ?? "latest");

  if (request.action === "eth_call") {
    if (!request.to || !request.data) return null;
    params.set("to", request.to);
    params.set("data", request.data);
    params.set("tag", blockTag);
  } else {
    if (!request.address || !request.position) return null;
    params.set("address", request.address);
    params.set("position", request.position);
    params.set("tag", blockTag);
  }

  const res = await fetchWithRetry(
    `${ETHERSCAN_V2_BASE}?${params.toString()}`,
    request.signal ? { signal: request.signal } : undefined,
    1,
    { timeoutMs: request.timeoutMs ?? 10_000 },
  );
  if (!res?.ok) return null;

  const body = await res.json() as JsonRpcEnvelope<string>;
  if (body.error) return null;
  if (!isHexResult(body.result ?? undefined) || body.result === "0x") return null;
  return body.result as `0x${string}`;
}

export async function fetchEtherscanUint256AtBlock(
  evmChainId: number,
  to: string,
  data: string,
  blockNumberOrTag: number | "latest" = "latest",
  options?: Pick<EtherscanProxyRequest, "apiKey" | "signal" | "timeoutMs">,
): Promise<bigint | null> {
  const result = await fetchEtherscanProxyHex({
    evmChainId,
    action: "eth_call",
    to,
    data,
    blockNumberOrTag,
    apiKey: options?.apiKey,
    signal: options?.signal,
    timeoutMs: options?.timeoutMs,
  });
  return parseUint256Hex(result);
}

export async function fetchEvmBlockNumber(
  chainId: string,
  options?: EvmRpcOptions,
): Promise<number | null> {
  const urls = buildRpcUrls(chainId, options?.extraRpcUrls);
  if (urls.length === 0) return null;

  const result = await fetchJsonRpcResult<string>(urls, "eth_blockNumber", [], options);
  return parseHexInteger(result ?? undefined);
}

export async function fetchEvmBlockTimestamp(
  chainId: string,
  blockNumber: number,
  options?: EvmRpcOptions,
): Promise<number | null> {
  const urls = buildRpcUrls(chainId, options?.extraRpcUrls);
  if (urls.length === 0) return null;

  const block = await fetchJsonRpcResult<EvmBlockResult>(
    urls,
    "eth_getBlockByNumber",
    [toBlockTag(blockNumber), false],
    options,
  );

  return parseHexInteger(block?.timestamp);
}

export async function resolveClosestBlockAtOrBeforeTimestamp(
  chainId: string,
  targetTimestamp: number,
  cache: EvmBlockSearchCache,
  options?: EvmRpcOptions,
): Promise<number | null> {
  if (!Number.isFinite(targetTimestamp) || targetTimestamp <= 0) return null;

  let latestBlock: number | null | undefined = cache.latestBlockNumber;
  if (latestBlock == null) {
    latestBlock = await fetchEvmBlockNumber(chainId, options);
    if (latestBlock == null) return null;
    cache.latestBlockNumber = latestBlock;
  }

  const getTimestamp = async (blockNumber: number): Promise<number | null> => {
    const cached = cache.blockTimestampByNumber.get(blockNumber);
    if (cached != null) return cached;

    const timestamp = await fetchEvmBlockTimestamp(chainId, blockNumber, options);
    if (timestamp != null) {
      cache.blockTimestampByNumber.set(blockNumber, timestamp);
    }
    return timestamp;
  };

  const latestTimestamp = await getTimestamp(latestBlock);
  if (latestTimestamp == null) return null;
  if (latestTimestamp <= targetTimestamp) return latestBlock;

  let low = 0;
  let high = latestBlock;

  for (const [blockNumber, timestamp] of cache.blockTimestampByNumber.entries()) {
    if (timestamp <= targetTimestamp && blockNumber > low) {
      low = blockNumber;
    }
    if (timestamp >= targetTimestamp && blockNumber < high) {
      high = blockNumber;
    }
  }

  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    const timestamp = await getTimestamp(mid);
    if (timestamp == null) return null;

    if (timestamp <= targetTimestamp) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return low;
}
