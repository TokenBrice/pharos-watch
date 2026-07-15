import { getChainRpc, type ChainRpcConfig } from "./chain-registry";
import { ETHERSCAN_V2_BASE } from "./constants";
import { encodeAddress, encodeUint256 } from "./evm-selectors";
import { fetchJsonWithRetry } from "./fetch-retry";
import { rethrowIfAborted } from "./abort";
import { toErrorMessage } from "./error-utils";

interface JsonRpcEnvelope<T> {
  result?: T;
  error?: { code?: number; message?: string };
}

interface JsonRpcResultPolicy<T> {
  acceptResult?: (value: unknown) => value is T;
  rejectedReason?: (value: unknown) => string;
}

export interface EvmRpcOptions {
  extraRpcUrls?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Absolute wall-clock deadline. Each retry/fallback caps its timeout to the remaining time. */
  deadlineMs?: number;
  /** Invoked immediately before each RPC URL attempt. False prevents the request. */
  beforeRequest?: () => boolean;
  maxRetries?: number;
  /** Gas limit for eth_call (hex string, e.g. "0x7A120"). Needed for cross-contract calls. */
  gas?: string;
  /** Maximum number of calls per Multicall3 aggregate3 request. Defaults to one request for the full input. */
  multicallBatchSize?: number;
  /** Chain RPC config map (built via buildChainRpcs). Required for RPC URL resolution. */
  chainRpcs?: Map<string, ChainRpcConfig>;
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

export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

const MULTICALL3_AGGREGATE3_SELECTOR = "0x82ad56cb";

export interface EvmMulticall3Call {
  label: string;
  target: string;
  callData: string;
  allowFailure?: boolean;
}

export interface EvmMulticall3Result {
  label: string;
  success: boolean;
  returnData: `0x${string}`;
}

interface EvmBlockResult {
  number: string;
  timestamp: string;
}

function stripHexPrefix(value: string): string {
  return value.startsWith("0x") ? value.slice(2) : value;
}

function normalizeEvenHex(value: string): string | null {
  const body = stripHexPrefix(value);
  if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) return null;
  return body.toLowerCase();
}

function requireEvenHex(value: string, fieldName: string): string {
  const body = normalizeEvenHex(value);
  if (body == null) throw new Error(`Invalid ${fieldName}: expected even-length hex`);
  return body;
}

function encodeAbiBool(value: boolean): string {
  return encodeUint256(value ? 1 : 0);
}

function encodeAbiBytes(hexValue: string): string {
  const body = requireEvenHex(hexValue, "Multicall3 callData");
  const paddedByteLength = Math.ceil(body.length / 2 / 32) * 32;
  return `${encodeUint256(body.length / 2)}${body.padEnd(paddedByteLength * 2, "0")}`;
}

function readAbiWord(hexBody: string, byteOffset: number): string | null {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) return null;
  const start = byteOffset * 2;
  const end = start + 64;
  if (end > hexBody.length) return null;
  return hexBody.slice(start, end);
}

function parseAbiWordAsSafeNumber(word: string | null): number | null {
  if (word == null) return null;
  const value = BigInt(`0x${word}`);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value);
}

function readAbiOffset(hexBody: string, byteOffset: number): number | null {
  const offset = parseAbiWordAsSafeNumber(readAbiWord(hexBody, byteOffset));
  if (offset == null || offset % 32 !== 0 || offset > hexBody.length / 2) return null;
  return offset;
}

function readAbiBytes(hexBody: string, byteOffset: number): `0x${string}` | null {
  const byteLength = parseAbiWordAsSafeNumber(readAbiWord(hexBody, byteOffset));
  if (byteLength == null) return null;
  const dataStart = byteOffset + 32;
  const dataEnd = dataStart + byteLength;
  const paddedEnd = dataStart + Math.ceil(byteLength / 32) * 32;
  if (dataEnd > hexBody.length / 2 || paddedEnd > hexBody.length / 2) return null;
  return `0x${hexBody.slice(dataStart * 2, dataEnd * 2)}` as `0x${string}`;
}

export function encodeMulticall3Aggregate3CallData(calls: readonly EvmMulticall3Call[]): `0x${string}` {
  const encodedCalls = calls.map((call) => {
    const encodedCallData = encodeAbiBytes(call.callData);
    return `${encodeAddress(call.target)}${encodeAbiBool(call.allowFailure ?? true)}${encodeUint256(96)}${encodedCallData}`;
  });

  let nextOffset = calls.length * 32;
  const offsets = encodedCalls.map((encodedCall) => {
    const offset = encodeUint256(nextOffset);
    nextOffset += encodedCall.length / 2;
    return offset;
  });

  return `${MULTICALL3_AGGREGATE3_SELECTOR}${encodeUint256(32)}${encodeUint256(calls.length)}${offsets.join("")}${encodedCalls.join("")}` as `0x${string}`;
}

export function decodeMulticall3Aggregate3Result(
  result: `0x${string}`,
  labels: readonly string[],
): EvmMulticall3Result[] | null {
  const hexBody = normalizeEvenHex(result);
  if (hexBody == null || hexBody.length < 64) return null;

  const arrayOffset = readAbiOffset(hexBody, 0);
  if (arrayOffset == null) return null;

  const length = parseAbiWordAsSafeNumber(readAbiWord(hexBody, arrayOffset));
  if (length == null || length !== labels.length) return null;

  const elementOffsetBase = arrayOffset + 32;
  if (elementOffsetBase + length * 32 > hexBody.length / 2) return null;

  const decoded: EvmMulticall3Result[] = [];
  for (let index = 0; index < length; index += 1) {
    const relativeOffset = readAbiOffset(hexBody, elementOffsetBase + index * 32);
    if (relativeOffset == null || relativeOffset < length * 32) return null;

    const tupleStart = elementOffsetBase + relativeOffset;
    const successWord = parseAbiWordAsSafeNumber(readAbiWord(hexBody, tupleStart));
    if (successWord !== 0 && successWord !== 1) return null;

    const returnDataOffset = readAbiOffset(hexBody, tupleStart + 32);
    if (returnDataOffset == null || returnDataOffset < 64) return null;

    const returnData = readAbiBytes(hexBody, tupleStart + returnDataOffset);
    if (returnData == null) return null;

    decoded.push({
      label: labels[index],
      success: successWord === 1,
      returnData,
    });
  }

  return decoded;
}

function resolveMulticallBatchSize(callsLength: number, rawBatchSize: number | undefined): number {
  if (rawBatchSize == null || !Number.isSafeInteger(rawBatchSize) || rawBatchSize <= 0 || rawBatchSize >= callsLength) {
    return callsLength;
  }

  return rawBatchSize;
}

function buildRpcUrls(chainId?: string, extraRpcUrls?: string[], chainRpcs?: Map<string, ChainRpcConfig>): string[] {
  const urls: string[] = [];
  if (chainId && chainRpcs) {
    const chainRpc = getChainRpc(chainRpcs, chainId);
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
  policy?: JsonRpcResultPolicy<T>,
): Promise<T | null> {
  const configuredTimeoutMs = options?.timeoutMs ?? 10_000;
  const maxRetries = options?.maxRetries ?? 1;
  const failures: string[] = [];

  for (const rpcUrl of urls) {
    const remainingMs = options?.deadlineMs == null
      ? configuredTimeoutMs
      : Math.floor(options.deadlineMs - Date.now());
    if (remainingMs <= 0) {
      failures.push(`${rpcUrl}: request deadline exceeded`);
      break;
    }
    if (options?.beforeRequest && !options.beforeRequest()) {
      failures.push(`${rpcUrl}: request budget exhausted`);
      break;
    }
    const timeoutMs = Math.min(configuredTimeoutMs, remainingMs);
    try {
      const result = await fetchJsonWithRetry<JsonRpcEnvelope<unknown>>(
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
        maxRetries,
        { timeoutMs },
      );

      if (!result?.response.ok) {
        failures.push(`${rpcUrl}: HTTP ${result?.response.status ?? "no-response"}`);
        continue;
      }

      const body = result.body;
      if (body.error) {
        failures.push(`${rpcUrl}: RPC error ${body.error.code ?? ""} ${body.error.message ?? ""}`);
        continue;
      }
      if (body.result == null) {
        failures.push(`${rpcUrl}: null result`);
        continue;
      }

      if (policy?.acceptResult && !policy.acceptResult(body.result)) {
        failures.push(
          `${rpcUrl}: ${policy.rejectedReason ? policy.rejectedReason(body.result) : "unacceptable result"}`,
        );
        continue;
      }

      return body.result as T;
    } catch (err) {
      rethrowIfAborted(err, options?.signal);
      failures.push(`${rpcUrl}: ${toErrorMessage(err)}`);
      continue;
    }
  }

  if (failures.length > 0) {
    console.warn(`[evm-rpc] ${method} failed across ${urls.length} RPCs: ${failures.join("; ")}`);
  }
  return null;
}

export function toBlockTag(blockNumberOrTag: number | "latest"): string {
  return blockNumberOrTag === "latest" ? "latest" : `0x${blockNumberOrTag.toString(16)}`;
}

function normalizeJsonRpcQuantityHex(value: string): string | null {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) return null;
  const body = value.slice(2).replace(/^0+/, "");
  return `0x${body.length > 0 ? body : "0"}`;
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
  return isHexResult(result ?? undefined) && result !== "0x" ? (result as `0x${string}`) : null;
}

export async function fetchEvmCallHexAtBlock(
  chainId: string | undefined,
  to: string,
  data: string,
  blockNumberOrTag: number | "latest" = "latest",
  options?: EvmRpcOptions,
): Promise<`0x${string}` | null> {
  const urls = buildRpcUrls(chainId, options?.extraRpcUrls, options?.chainRpcs);
  if (urls.length === 0) return null;

  const callObj: Record<string, string> = { to, data };
  if (options?.gas) {
    const normalizedGas = normalizeJsonRpcQuantityHex(options.gas);
    if (normalizedGas) callObj.gas = normalizedGas;
  }
  const blockTag = toBlockTag(blockNumberOrTag);
  const result = await fetchJsonRpcResult<string>(urls, "eth_call", [callObj, blockTag], options, {
    acceptResult: (value): value is `0x${string}` => isHexResult(value as string) && value !== "0x",
    rejectedReason: () => {
      return "null result";
    },
  });

  return result as `0x${string}` | null;
}

export async function fetchEvmCodeAtBlock(
  chainId: string | undefined,
  address: string,
  blockNumberOrTag: number | "latest" = "latest",
  options?: EvmRpcOptions,
): Promise<`0x${string}` | null> {
  const urls = buildRpcUrls(chainId, options?.extraRpcUrls, options?.chainRpcs);
  if (urls.length === 0) return null;

  const result = await fetchJsonRpcResult<string>(
    urls,
    "eth_getCode",
    [address, toBlockTag(blockNumberOrTag)],
    options,
    {
      acceptResult: (value): value is `0x${string}` => isHexResult(value as string) && value !== "0x",
      rejectedReason: () => "empty bytecode",
    },
  );
  return result as `0x${string}` | null;
}

export async function fetchEvmMulticall3Aggregate3AtBlock(
  chainId: string | undefined,
  calls: readonly EvmMulticall3Call[],
  blockNumberOrTag: number | "latest" = "latest",
  options?: EvmRpcOptions,
): Promise<EvmMulticall3Result[] | null> {
  if (calls.length === 0) return [];

  const batchSize = resolveMulticallBatchSize(calls.length, options?.multicallBatchSize);
  const decodedResults: EvmMulticall3Result[] = [];

  for (let start = 0; start < calls.length; start += batchSize) {
    const batch = calls.slice(start, start + batchSize);
    const result = await fetchEvmCallHexAtBlock(
      chainId,
      MULTICALL3_ADDRESS,
      encodeMulticall3Aggregate3CallData(batch),
      blockNumberOrTag,
      options,
    );
    if (result == null) return null;

    const decoded = decodeMulticall3Aggregate3Result(
      result,
      batch.map((call) => call.label),
    );
    if (decoded == null) return null;
    decodedResults.push(...decoded);
  }

  return decodedResults;
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

export async function fetchEtherscanProxyHex(request: EtherscanProxyRequest): Promise<`0x${string}` | null> {
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

  const result = await fetchJsonWithRetry<JsonRpcEnvelope<string>>(
    `${ETHERSCAN_V2_BASE}?${params.toString()}`,
    request.signal ? { signal: request.signal } : undefined,
    1,
    { timeoutMs: request.timeoutMs ?? 10_000 },
  );
  if (!result?.response.ok) return null;

  const body = result.body;
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

export async function fetchEvmBlockNumber(chainId: string, options?: EvmRpcOptions): Promise<number | null> {
  const urls = buildRpcUrls(chainId, options?.extraRpcUrls, options?.chainRpcs);
  if (urls.length === 0) return null;

  const result = await fetchJsonRpcResult<string>(urls, "eth_blockNumber", [], options);
  return parseHexInteger(result ?? undefined);
}

export async function fetchEvmBlockTimestamp(
  chainId: string,
  blockNumber: number,
  options?: EvmRpcOptions,
): Promise<number | null> {
  const urls = buildRpcUrls(chainId, options?.extraRpcUrls, options?.chainRpcs);
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
