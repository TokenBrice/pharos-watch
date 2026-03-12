import { getChainRpc } from "./chain-registry";
import { fetchWithRetry } from "./fetch-retry";

interface JsonRpcEnvelope<T> {
  result?: T;
  error?: { message?: string };
}

interface EvmRpcOptions {
  extraRpcUrls?: string[];
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

function buildRpcUrls(chainId: string, extraRpcUrls?: string[]): string[] {
  const urls: string[] = [];
  const chainRpc = getChainRpc(chainId);
  if (chainRpc) {
    urls.push(chainRpc.rpcUrl);
    if (chainRpc.fallbackRpcUrl) urls.push(chainRpc.fallbackRpcUrl);
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

function toBlockTag(blockNumberOrTag: number | "latest"): string {
  return blockNumberOrTag === "latest" ? "latest" : `0x${blockNumberOrTag.toString(16)}`;
}

function parseHexInteger(value: string | undefined): number | null {
  if (typeof value !== "string" || !value.startsWith("0x")) return null;
  const parsed = Number.parseInt(value, 16);
  return Number.isFinite(parsed) ? parsed : null;
}

function isHexResult(value: string | null | undefined): value is `0x${string}` {
  return typeof value === "string" && value.startsWith("0x") && value.length > 2;
}

export async function fetchEvmCallHexAtBlock(
  chainId: string,
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
  return result;
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
