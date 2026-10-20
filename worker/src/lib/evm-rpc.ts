import { logWorkerEventArgs } from "./structured-log";
import {
  getChainRpc,
  getRpcAuth,
  getRpcAuthHeaders,
  type ChainRpcConfig,
  type RpcEndpoint,
} from "./chain-registry";
import { recordDwellirCredits } from "./rpc-provider-budget";
import { ETHERSCAN_V2_BASE } from "./constants";
import { encodeAddress, encodeUint256 } from "./evm-selectors";
import { fetchJsonWithRetry, fetchTextWithRetry } from "./fetch-retry";
import { parseQuantityHex } from "./bigint";
import { FetchRequestNotStartedError, rethrowIfAborted } from "./abort";
import { toErrorMessage } from "@shared/lib/error-utils";
import { isTronRpcUrl, requiresHistoricalEvmState } from "@shared/lib/tron-rpc";

export interface JsonRpcEnvelope<T> {
  result?: T;
  error?: { code?: number; message?: string };
}

interface JsonRpcResultPolicy<T> {
  acceptResult?: (value: unknown) => value is T;
  rejectedReason?: (value: unknown) => string;
  /** Direct optional probes stop at a proven revert; ordinary calls retain provider failover. */
  stopOnExecutionRevert?: boolean;
}

type JsonRpcOutcome<T> =
  | { status: "data"; value: T }
  | { status: "reverted" }
  | { status: "unavailable" };

export interface EvmRpcOptions {
  extraRpcUrls?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Optional streamed response-body ceiling; omitted callers retain the fetch helper's default. */
  maxResponseBytes?: number;
  /** Absolute wall-clock deadline. Each retry/fallback caps its timeout to the remaining time. */
  deadlineMs?: number;
  /** Invoked immediately before each RPC URL attempt with the URL about to be requested. False prevents the request. */
  beforeRequest?: (url: string) => boolean;
  /** Exclude supplemental endpoints AND the metered Dwellir operator at every position. */
  excludeSupplementalRpc?: boolean;
  /** Authenticated pin context; does not authorize any different batch member pin. */
  recentStatePin?: RecentFinalizedRpcPin;
  /** Observed head used only to check moving log/header retention. */
  observedHeadBlock?: number;
  maxRetries?: number;
  /** Reject null batch members at this endpoint when the caller requires observed evidence. */
  requireNonNullResults?: boolean;
  /** Gas limit for eth_call (hex string, e.g. "0x7A120"). Needed for cross-contract calls. */
  gas?: string;
  /** Maximum number of calls per Multicall3 aggregate3 request. Defaults to one request for the full input. */
  multicallBatchSize?: number;
  /** Reviewed quote aggregates may return unavailable on -32000/out of gas so their caller can split before failover. */
  stopOnExecutionBudgetError?: boolean;
  /** EIP-1898 identity for every state read; unsupported hash reads fail closed. */
  stateBlockHash?: `0x${string}`;
  /** Enable direct-call fallback only for explicit Multicall3 absence at a numbered, hash-bound block. */
  multicallFallbackBlockHash?: `0x${string}`;
  /** Chain RPC config map (built via buildChainRpcs). Required for RPC URL resolution. */
  chainRpcs?: Map<string, ChainRpcConfig>;
}

export interface EvmBlockHeaderOptions extends EvmRpcOptions {
  /** Required observation window; stale but well-formed headers try the next endpoint. */
  minTimestampSec?: number;
  /** Required finalized coverage; lagging headers try the next endpoint. */
  minBlockNumber?: number;
}

export interface EvmRpcBatchCall {
  method: string;
  params: unknown[];
}

export interface EvmRpcBatchError {
  index: number;
  code?: number;
  message?: string;
}

export interface EvmRpcBatchDetailedResult {
  results: Array<unknown | undefined>;
  errors: EvmRpcBatchError[];
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

export type EvmCodeAtBlockResult =
  | { status: "available"; code: `0x${string}` }
  | { status: "absent" }
  | { status: "unavailable" };

interface EvmBlockResult {
  number?: string;
  timestamp?: string;
  hash?: string;
}

export interface EvmBlockHeader {
  number: number;
  timestamp: number;
  hash: `0x${string}`;
}

/** Original observation identity, not a fresh clock attached to old state. */
export interface RecentFinalizedRpcPin {
  chainId: string;
  header: EvmBlockHeader;
  finalized: EvmBlockHeader;
  observedAtSec: number;
  maxAgeSec: number;
  retainedFromBlock?: number;
}

export type EvmRpcReadRequirement =
  | { kind: "current-state"; finalizedTag?: boolean }
  | { kind: "recent-pinned-state"; pin: RecentFinalizedRpcPin; hashPinned: boolean }
  | { kind: "historical-state"; hashPinned: boolean }
  | { kind: "headers-receipts"; blockNumber?: number; finalizedTag?: boolean; observedHeadBlock?: number }
  | { kind: "logs"; fromBlock: number; toBlock: number; observedHeadBlock?: number }
  | { kind: "unsupported" };

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

interface BuildRpcUrlsOptions {
  requirements: readonly EvmRpcReadRequirement[];
  excludeSupplementalRpc?: boolean;
}

/**
 * Dwellir origins demoted after a failed attempt, keyed by the per-run
 * `chainRpcs` Map object. Placement does not affect the operator's failure policy.
 */
const demotedSupplementalRpcOriginsByRun = new WeakMap<Map<string, ChainRpcConfig>, Set<string>>();

/** Dedupe/graph identity of a URL. Returns null when the URL cannot be parsed. */
function endpointOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** True when the url's registered origin carries the Dwellir key. */
function isDwellirRpcUrl(rpcUrl: string): boolean {
  const origin = endpointOrigin(rpcUrl);
  return origin != null && getRpcAuth(rpcUrl)?.provider === "dwellir";
}

/**
 * Counts one credit per JSON-RPC response item before the request is sent, so a
 * provider that answers with an error still consumes budget.
 */
function meterDwellirRpcRequest(rpcUrl: string, credits: number): void {
  if (isDwellirRpcUrl(rpcUrl)) recordDwellirCredits(credits);
}

/** A timeout or network failure takes the origin out of this run's failover order. */
function demoteFailedDwellirAttempt(
  chainRpcs: Map<string, ChainRpcConfig> | undefined,
  rpcUrl: string,
): void {
  if (!chainRpcs) return;
  const origin = endpointOrigin(rpcUrl);
  if (origin == null || !isDwellirRpcUrl(rpcUrl)) return;

  const demoted = demotedSupplementalRpcOriginsByRun.get(chainRpcs) ?? new Set<string>();
  demoted.add(origin);
  demotedSupplementalRpcOriginsByRun.set(chainRpcs, demoted);
}

/** Recent state is admitted only for the exact authenticated number/hash. */
function stateReadRequirement(selector: unknown, options?: EvmRpcOptions): EvmRpcReadRequirement {
  if (selector === "latest" || selector === "safe" || selector === "finalized" || selector === "pending") {
    return { kind: "current-state", finalizedTag: selector === "finalized" };
  }
  const pin = options?.recentStatePin;
  const hashPinned = typeof selector === "object" && selector !== null && "blockHash" in selector &&
    "requireCanonical" in selector && selector.requireCanonical === true;
  if (pin && (selector === toBlockTag(pin.header.number) ||
      (hashPinned && selector.blockHash === pin.header.hash))) {
    return { kind: "recent-pinned-state", pin, hashPinned };
  }
  return { kind: "historical-state", hashPinned };
}

/** Every batch member contributes its actual method and pin, never a batch-wide archive flag. */
function rpcReadRequirement(call: EvmRpcBatchCall, options?: EvmRpcOptions): EvmRpcReadRequirement {
  if (call.method === "eth_call" || call.method === "eth_getCode" || call.method === "eth_getBalance" || call.method === "eth_getTransactionCount") {
    return stateReadRequirement(call.params[1], options);
  }
  if (call.method === "eth_getStorageAt" || call.method === "eth_getProof") {
    return stateReadRequirement(call.params[2], options);
  }
  if (call.method === "eth_getLogs") {
    const filter = call.params[0];
    if (!filter || typeof filter !== "object") return { kind: "unsupported" };
    const from = "fromBlock" in filter ? parseQuantityHex(filter.fromBlock) : null;
    const to = "toBlock" in filter ? parseQuantityHex(filter.toBlock) : null;
    if (from === null || to === null || from < 0n || to < from || to > BigInt(Number.MAX_SAFE_INTEGER)) return { kind: "unsupported" };
    return { kind: "logs", fromBlock: Number(from), toBlock: Number(to), observedHeadBlock: options?.observedHeadBlock };
  }
  if (call.method === "eth_blockNumber" || call.method === "eth_chainId" || call.method === "eth_getBlockByNumber" ||
    call.method === "eth_getBlockByHash" || call.method === "eth_getTransactionReceipt" ||
    call.method === "eth_getTransactionByHash" || call.method === "eth_getBlockReceipts") {
    const number = call.method === "eth_getBlockByNumber" ? parseQuantityHex(call.params[0]) : null;
    return { kind: "headers-receipts", ...(number !== null ? { blockNumber: Number(number) } : {}),
      finalizedTag: call.params[0] === "finalized", observedHeadBlock: options?.observedHeadBlock };
  }
  return { kind: "unsupported" };
}

function validRecentPin(pin: RecentFinalizedRpcPin, chainId?: string): boolean {
  const { header, finalized, observedAtSec, maxAgeSec } = pin;
  const now = Math.floor(Date.now() / 1000);
  return pin.chainId === chainId && Number.isSafeInteger(header.number) && header.number >= 0 &&
    /^0x[0-9a-fA-F]{64}$/.test(header.hash) && /^0x[0-9a-fA-F]{64}$/.test(finalized.hash) &&
    Number.isSafeInteger(finalized.number) && finalized.number >= header.number &&
    Number.isSafeInteger(finalized.timestamp) && finalized.timestamp >= header.timestamp &&
    (finalized.number !== header.number || finalized.hash === header.hash) &&
    Number.isSafeInteger(header.timestamp) && header.timestamp > 0 && Number.isSafeInteger(observedAtSec) &&
    Number.isSafeInteger(maxAgeSec) && maxAgeSec > 0 && header.timestamp <= observedAtSec &&
    observedAtSec <= now && now - header.timestamp <= maxAgeSec &&
    (pin.retainedFromBlock === undefined || (Number.isSafeInteger(pin.retainedFromBlock) &&
      pin.retainedFromBlock >= 0 && header.number >= pin.retainedFromBlock));
}

function supportsRead(endpoint: RpcEndpoint, requirement: EvmRpcReadRequirement, chainId?: string): boolean {
  if (endpoint.operator === "dwellir" && (endpoint.routingDisabled || requirement.kind === "unsupported")) return false;
  if (requirement.kind === "current-state" && requirement.finalizedTag && endpoint.finalizedTagUnsupported) return false;
  if (requirement.kind === "historical-state" || requirement.kind === "recent-pinned-state") {
    // The reviewed HyperEVM Alchemy numeric-state mispin cannot be cured by retrying it.
    if (chainId === "hyperevm" && endpoint.operator === "alchemy" && !requirement.hashPinned) return false;
    if (requirement.kind === "historical-state") {
      return endpoint.operator === "dwellir" ? endpoint.stateHistory === "archive" : endpoint.stateHistory !== "recent";
    }
  }
  if (requirement.kind === "logs") {
    if (!Number.isSafeInteger(requirement.fromBlock) || !Number.isSafeInteger(requirement.toBlock) ||
      requirement.fromBlock < 0 || requirement.toBlock < requirement.fromBlock ||
      (endpoint.maxLogBlockSpan !== undefined && requirement.toBlock - requirement.fromBlock + 1 > endpoint.maxLogBlockSpan)) return false;
    if (endpoint.logsHistory === "full") return true;
    // Unknown incumbent retention permits an attempt, never a completeness claim.
    if (endpoint.logsHistory === "unknown") return endpoint.operator !== "dwellir";
    return typeof endpoint.logsHistory === "object" && Number.isSafeInteger(requirement.observedHeadBlock) &&
      requirement.observedHeadBlock !== undefined && requirement.toBlock <= requirement.observedHeadBlock &&
      requirement.fromBlock >= requirement.observedHeadBlock - endpoint.logsHistory.retainedBlocks + 1;
  }
  if (requirement.kind === "headers-receipts") {
    if (requirement.finalizedTag && endpoint.finalizedTagUnsupported) return false;
    if (endpoint.operator === "dwellir" && typeof endpoint.logsHistory === "object" && requirement.blockNumber !== undefined) {
      return Number.isSafeInteger(requirement.observedHeadBlock) && requirement.observedHeadBlock !== undefined &&
        requirement.blockNumber >= requirement.observedHeadBlock - endpoint.logsHistory.retainedBlocks + 1;
    }
  }
  return true;
}

/** Eligible Dwellir first; incumbent registry, adapter, supplemental relative order is unchanged. */
function buildRpcUrls(
  chainId: string | undefined,
  extraRpcUrls: string[] | undefined,
  chainRpcs: Map<string, ChainRpcConfig> | undefined,
  options: BuildRpcUrlsOptions,
): string[] {
  if (options.requirements.some(requirement => requirement.kind === "recent-pinned-state" &&
    !validRecentPin(requirement.pin, chainId))) return [];
  const chainRpc = chainId && chainRpcs ? getChainRpc(chainRpcs, chainId) : undefined;
  const endpoints = chainRpc?.endpoints ?? [];
  const demoted = chainRpcs == null ? undefined : demotedSupplementalRpcOriginsByRun.get(chainRpcs);
  const eligible = (url: string): boolean => {
    const endpoint = endpoints.find(row => row.url === url);
    if (endpoint?.operator === "dwellir" || isDwellirRpcUrl(url)) {
      if (!endpoint || options.excludeSupplementalRpc || demoted?.has(endpointOrigin(url) ?? url)) return false;
    }
    return !endpoint || options.requirements.every(requirement => supportsRead(endpoint, requirement, chainId));
  };
  const urls = [
    ...endpoints.filter(endpoint => endpoint.operator === "dwellir").map(endpoint => endpoint.url),
    ...endpoints.filter(endpoint => endpoint.operator !== "dwellir" && endpoint.position === "registry").map(endpoint => endpoint.url),
    ...(extraRpcUrls ?? []),
    ...(!options.excludeSupplementalRpc
      ? endpoints.filter(endpoint => endpoint.operator !== "dwellir" && endpoint.position === "supplemental").map(endpoint => endpoint.url)
      : []),
  ];
  return [...new Set(urls.filter(url => typeof url === "string" && url.length > 0 && eligible(url)))];
}

/** Page sizing starts with the first eligible provider, independent of archive state. */
export function usableCcipRpcEndpoints(
  chainId: string,
  chainRpcs: Map<string, ChainRpcConfig>,
  requirement: Extract<EvmRpcReadRequirement, { kind: "logs" }>,
): readonly RpcEndpoint[] {
  const config = chainRpcs.get(chainId);
  if (!config) return [];
  return buildRpcUrls(chainId, undefined, chainRpcs, { requirements: [requirement] })
    .map(url => config.endpoints.find(endpoint => endpoint.url === url)!);
}

function requestRpcUrls(
  chainId: string | undefined,
  options: EvmRpcOptions | undefined,
  blockTag?: string | number,
  headerRead = false,
): string[] {
  const requirement: EvmRpcReadRequirement = headerRead
    ? { kind: "headers-receipts", ...(typeof blockTag === "number" ? { blockNumber: blockTag } : {}),
      finalizedTag: blockTag === "finalized", observedHeadBlock: options?.observedHeadBlock }
    : stateReadRequirement(stateBlockSelector(blockTag as number | "latest", options), options);
  return buildRpcUrls(chainId, options?.extraRpcUrls, options?.chainRpcs, {
    requirements: [requirement], excludeSupplementalRpc: options?.excludeSupplementalRpc,
  });
}

function buildJsonRpcHeaders(rpcUrl: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(getRpcAuthHeaders(rpcUrl) ?? {}),
  };
}

interface JsonRpcRequest {
  jsonrpc: string;
  id: number;
  method: string;
  params: readonly unknown[];
}

type JsonRpcTransportOutcome =
  | { status: "response" | "http-error" | "rpc-error" | "invalid-envelope"; response: Response;
      body: unknown; rows: ReadonlyMap<number, JsonRpcEnvelope<unknown>>; invalidRows: number }
  | { status: "parse-error"; response: Response; error: unknown }
  | { status: "transport-error"; error: unknown | null }
  | { status: "control-error"; error: unknown };

/**
 * One URL only: shared POST/auth, bounded intake and response identity checks.
 * Callers retain admission/metering, failover, diagnostics and partial recovery.
 * Text decoding preserves Alchemy's HTTP/non-JSON diagnostics; generic reads
 * retain the fetch helper's JSON parse/transport-failure semantics.
 */
export async function requestJsonRpcAtUrl(
  rpcUrl: string,
  payload: JsonRpcRequest | JsonRpcRequest[],
  options: Pick<EvmRpcOptions, "signal" | "timeoutMs" | "deadlineMs" | "maxResponseBytes" | "maxRetries"> & {
    beforeRequest?: () => boolean;
    responseMode?: "text";
  },
): Promise<JsonRpcTransportOutcome> {
  try {
    const fetched = await (options.responseMode === "text" ? fetchTextWithRetry : fetchJsonWithRetry<unknown>)(
      rpcUrl,
      { method: "POST", headers: buildJsonRpcHeaders(rpcUrl), signal: options.signal, body: JSON.stringify(payload) },
      options.maxRetries ?? 0,
      {
        timeoutMs: options.timeoutMs,
        deadlineMs: options.deadlineMs,
        beforeRequest: options.beforeRequest,
        retryMode: "network-only",
        ...(options.responseMode === "text" ? { returnFinalResponse: true } : {}),
        ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
      },
    );
    if (!fetched) return { status: "transport-error", error: null };
    let body = fetched.body;
    if (options.responseMode === "text") {
      try {
        body = JSON.parse(body as string) as unknown;
      } catch (error) {
        return { status: "parse-error", response: fetched.response, error };
      }
    }
    const batch = Array.isArray(payload);
    const expectedIds = new Set(batch ? payload.map(request => request.id) : [payload.id]);
    const candidates: unknown[] = batch ? Array.isArray(body) ? body : [] : [body];
    const counts = new Map<number, number>();
    for (const row of candidates) {
      if (row && typeof row === "object" && "id" in row && typeof row.id === "number") {
        counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
      }
    }
    const rows = new Map<number, JsonRpcEnvelope<unknown>>();
    let invalidRows = 0;
    for (const row of candidates) {
      const id = row && typeof row === "object" && !Array.isArray(row) && "id" in row ? row.id : undefined;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || !expectedIds.has(id) || counts.get(id) !== 1) {
        invalidRows++;
      } else {
        rows.set(id, row as JsonRpcEnvelope<unknown>);
      }
    }
    const status = !fetched.response.ok ? "http-error"
      : (batch ? !Array.isArray(body) : invalidRows > 0) ? "invalid-envelope"
      : !batch && rows.get(payload.id)?.error ? "rpc-error" : "response";
    return { status, response: fetched.response, body, rows, invalidRows };
  } catch (error) {
    return { status: error instanceof FetchRequestNotStartedError || options.signal?.aborted
      ? "control-error" : "transport-error", error };
  }
}

/** Key-free failure text for one attempt; never includes the URL query or headers. */
function describeRpcFailure(result: { response: Response } | null, rpcUrl: string): string {
  if (result == null) return "HTTP no-response";
  if (result.response.status === 403 && isDwellirRpcUrl(rpcUrl)) {
    return "provider-capability (HTTP 403)";
  }
  return `HTTP ${result.response.status}`;
}

async function fetchJsonRpcOutcome<T>(
  urls: string[],
  method: string,
  params: unknown[],
  options?: EvmRpcOptions,
  policy?: JsonRpcResultPolicy<T>,
  chainId?: string,
): Promise<JsonRpcOutcome<T>> {
  const configuredTimeoutMs = options?.timeoutMs ?? 10_000;
  const maxRetries = options?.maxRetries ?? 1;
  const failures: string[] = [];
  const onRpcRequest = chainId ? options?.chainRpcs?.get(chainId)?.onRpcRequest : undefined;
  const requirement = options?.recentStatePin ? rpcReadRequirement({ method, params }, options) : undefined;

  for (const rpcUrl of urls) {
    if (isTronRpcUrl(rpcUrl) && requiresHistoricalEvmState(method, params)) continue;
    const remainingMs = options?.deadlineMs == null
      ? configuredTimeoutMs
      : Math.floor(options.deadlineMs - Date.now());
    if (remainingMs <= 0) {
      failures.push(`${rpcUrl}: request deadline exceeded`);
      break;
    }
    try {
      const result = await requestJsonRpcAtUrl(rpcUrl, { jsonrpc: "2.0", id: 1, method, params }, {
        signal: options?.signal,
        maxRetries,
        timeoutMs: Math.min(configuredTimeoutMs, remainingMs),
        deadlineMs: options?.deadlineMs,
        maxResponseBytes: options?.maxResponseBytes,
        beforeRequest: () => {
          if (requirement?.kind === "recent-pinned-state" && !validRecentPin(requirement.pin, chainId)) return false;
          if (options?.beforeRequest?.(rpcUrl) === false) return false;
          meterDwellirRpcRequest(rpcUrl, 1);
          onRpcRequest?.({ providerOrigin: new URL(rpcUrl).origin, method, rpcCalls: 1, signal: options?.signal });
          return true;
        },
      });
      if (result.status === "control-error" || result.status === "transport-error") {
        if (result.error != null) throw result.error;
        demoteFailedDwellirAttempt(options?.chainRpcs, rpcUrl);
        failures.push(`${rpcUrl}: ${describeRpcFailure(null, rpcUrl)}`);
        continue;
      }

      if (result.status === "http-error") {
        failures.push(`${rpcUrl}: ${describeRpcFailure(result, rpcUrl)}`);
        continue;
      }

      if (result.status === "parse-error") throw result.error;
      if (result.status === "invalid-envelope") {
        failures.push(`${rpcUrl}: invalid response identity`);
        continue;
      }
      const body = result.rows.get(1)!;
      if (body.error) {
        failures.push(`${rpcUrl}: RPC error ${body.error.code ?? ""} ${body.error.message ?? ""}`);
        if (options?.stopOnExecutionBudgetError &&
            body.error.code === -32000 && /\bout of gas\b/i.test(body.error.message ?? "")) break;
        if (policy?.stopOnExecutionRevert && method === "eth_call" &&
            (body.error.code === 3 || /\bexecution reverted\b/i.test(body.error.message ?? ""))) {
          return { status: "reverted" };
        }
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

      return { status: "data", value: body.result as T };
    } catch (err) {
      rethrowIfAborted(err, options?.signal);
      if (err instanceof FetchRequestNotStartedError) {
        if (err.attemptsStarted > 0) demoteFailedDwellirAttempt(options?.chainRpcs, rpcUrl);
        failures.push(`${rpcUrl}: ${err.message}`);
        break;
      }
      demoteFailedDwellirAttempt(options?.chainRpcs, rpcUrl);
      failures.push(`${rpcUrl}: ${toErrorMessage(err)}`);
      continue;
    }
  }

  if (failures.length > 0) {
    logWorkerEventArgs("lib", "warn", `[evm-rpc] ${method} failed across ${urls.length} RPCs: ${failures.join("; ")}`);
  }
  return { status: "unavailable" };
}

async function fetchJsonRpcResult<T>(
  urls: string[],
  method: string,
  params: unknown[],
  options?: EvmRpcOptions,
  policy?: JsonRpcResultPolicy<T>,
  chainId?: string,
): Promise<T | null> {
  const outcome = await fetchJsonRpcOutcome(urls, method, params, options, policy, chainId);
  return outcome.status === "data" ? outcome.value : null;
}

export function toBlockTag(blockNumberOrTag: number | "latest" | "finalized"): string {
  return typeof blockNumberOrTag === "string"
    ? blockNumberOrTag
    : `0x${blockNumberOrTag.toString(16)}`;
}

function normalizeJsonRpcQuantityHex(value: string): string | null {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) return null;
  const body = value.slice(2).replace(/^0+/, "");
  return `0x${body.length > 0 ? body : "0"}`;
}

function parseHexInteger(value: string | undefined): number | null {
  const parsed = parseQuantityHex(value);
  if (parsed == null) return null;
  const parsedNumber = Number(parsed);
  return Number.isFinite(parsedNumber) ? parsedNumber : null;
}

function isHexBytes(value: unknown): value is `0x${string}` {
  return typeof value === "string" && value.length % 2 === 0 && /^0x[0-9a-fA-F]*$/.test(value);
}

export function isHexResult(value: string | null | undefined): value is `0x${string}` {
  return typeof value === "string" && value.startsWith("0x") && value.length > 2;
}

function fitsRpcLogSpan(calls: readonly EvmRpcBatchCall[], maxLogBlockSpan: number | undefined): boolean {
  if (maxLogBlockSpan === undefined) return true;
  if (!Number.isSafeInteger(maxLogBlockSpan) || maxLogBlockSpan < 1) return false;
  for (const call of calls) {
    if (call.method !== "eth_getLogs") continue;
    const filter = call.params[0];
    if (!filter || typeof filter !== "object") return false;
    if ("blockHash" in filter) continue;
    const from = "fromBlock" in filter ? parseQuantityHex(filter.fromBlock) : null;
    const to = "toBlock" in filter ? parseQuantityHex(filter.toBlock) : null;
    if (from === null || to === null || to < from || to - from + 1n > BigInt(maxLogBlockSpan)) return false;
  }
  return true;
}


/**
 * One JSON-RPC batch against the reviewed chain endpoints, with the envelope
 * validation every caller needs: matching row count, safe-integer ids, no
 * duplicate or out-of-range id, one row per call. `project` owns the
 * per-variant postcondition and returns null to reject this endpoint and fall
 * through to the next url.
 */
async function runEvmRpcBatch<Value>(
  chainId: string | undefined,
  calls: readonly EvmRpcBatchCall[],
  options: EvmRpcOptions | undefined,
  project: (rowsById: ReadonlyMap<number, JsonRpcEnvelope<unknown>>) => Value | null,
): Promise<Value | null> {
  if ((chainId === "tron" || (chainId && options?.chainRpcs?.get(chainId)?.type === "tron")) &&
      calls.some(call => requiresHistoricalEvmState(call.method, call.params))) return null;
  const requirements = calls.map(call => rpcReadRequirement(call, options));
  const urls = buildRpcUrls(chainId, options?.extraRpcUrls, options?.chainRpcs, {
    requirements,
    excludeSupplementalRpc: options?.excludeSupplementalRpc,
  });
  if (urls.length === 0 || calls.length === 0) return null;

  const configuredTimeoutMs = options?.timeoutMs ?? 10_000;
  const maxRetries = options?.maxRetries ?? 1;
  const onRpcRequest = chainId ? options?.chainRpcs?.get(chainId)?.onRpcRequest : undefined;
  endpoints: for (const rpcUrl of urls) {
    if (isTronRpcUrl(rpcUrl) && calls.some(call => requiresHistoricalEvmState(call.method, call.params))) continue;
    const endpoint = chainId ? options?.chainRpcs?.get(chainId)?.endpoints.find(row => row.url === rpcUrl) : undefined;
    if (!fitsRpcLogSpan(calls, endpoint?.maxLogBlockSpan)) continue;
    const noBatch = endpoint?.noBatch === true;
    const requestCount = noBatch ? calls.length : 1;
    const byId = new Map<number, JsonRpcEnvelope<unknown>>();

    try {
      for (let requestIndex = 0; requestIndex < requestCount; requestIndex += 1) {
        const remainingMs = options?.deadlineMs == null ? configuredTimeoutMs : options.deadlineMs - Date.now();
        if (remainingMs <= 0) return null;
        const payload = noBatch
          ? { jsonrpc: "2.0", id: requestIndex + 1, method: calls[requestIndex]!.method, params: calls[requestIndex]!.params }
          : calls.map((call, index) => ({ jsonrpc: "2.0", id: index + 1, method: call.method, params: call.params }));
        const result = await requestJsonRpcAtUrl(rpcUrl, payload, {
          signal: options?.signal,
          maxRetries,
          timeoutMs: Math.min(configuredTimeoutMs, remainingMs),
          deadlineMs: options?.deadlineMs,
          maxResponseBytes: options?.maxResponseBytes,
          beforeRequest: () => {
            if (requirements.some(requirement => requirement.kind === "recent-pinned-state" &&
              !validRecentPin(requirement.pin, chainId))) return false;
            if (options?.beforeRequest?.(rpcUrl) === false) return false;
            meterDwellirRpcRequest(rpcUrl, noBatch ? 1 : calls.length);
            onRpcRequest?.({ providerOrigin: new URL(rpcUrl).origin,
              method: noBatch ? calls[requestIndex]!.method : calls.length === 1 ? calls[0]!.method : "batch",
              rpcCalls: noBatch ? 1 : calls.length, signal: options?.signal });
            return true;
          },
        });
        if (result.status === "control-error" || result.status === "transport-error") {
          if (result.error != null) throw result.error;
          demoteFailedDwellirAttempt(options?.chainRpcs, rpcUrl);
          continue endpoints;
        }
        if (result.status === "parse-error") throw result.error;
        if (result.status === "http-error" || result.status === "invalid-envelope" || result.invalidRows > 0) continue endpoints;
        for (const [id, row] of result.rows) byId.set(id, row);
      }
      if (byId.size !== calls.length) continue;
      const projected = project(byId);
      if (projected !== null) return projected;
    } catch (error) {
      rethrowIfAborted(error, options?.signal);
      if (error instanceof FetchRequestNotStartedError) {
        if (error.attemptsStarted > 0) demoteFailedDwellirAttempt(options?.chainRpcs, rpcUrl);
        return null;
      }
      demoteFailedDwellirAttempt(options?.chainRpcs, rpcUrl);
    }
  }

  return null;
}

/**
 * Execute one JSON-RPC batch against the reviewed chain endpoint. The adapter
 * owns the operation limiter; keeping the batch primitive here means code and
 * state reads can share one provider request without weakening per-result
 * validation.
 */
export async function fetchEvmRpcBatch(
  chainId: string | undefined,
  calls: readonly EvmRpcBatchCall[],
  options?: EvmRpcOptions,
): Promise<unknown[] | null> {
  return runEvmRpcBatch(chainId, calls, options, (rowsById) => {
    const values: unknown[] = [];
    for (let index = 0; index < calls.length; index += 1) {
      const row = rowsById.get(index + 1);
      if (!row || row.error || !("result" in row) || row.result === undefined) return null;
      if (options?.requireNonNullResults && row.result === null) return null;
      values.push(row.result);
    }
    return values;
  });
}

/**
 * Batch variant that preserves per-call JSON-RPC errors. This is intentionally
 * separate from fetchEvmRpcBatch: most reserve reads require every call to
 * succeed, while a reviewed adapter may need to prove that one bounded probe
 * reverts (for example, an out-of-range token index).
 */
export async function fetchEvmRpcBatchDetailed(
  chainId: string | undefined,
  calls: readonly EvmRpcBatchCall[],
  options?: EvmRpcOptions,
): Promise<EvmRpcBatchDetailedResult | null> {
  return runEvmRpcBatch(chainId, calls, options, (rowsById) => {
    const results: Array<unknown | undefined> = [];
    const errors: EvmRpcBatchError[] = [];
    for (let index = 0; index < calls.length; index += 1) {
      const row = rowsById.get(index + 1);
      if (!row) return null;
      if (row.error) {
        results.push(undefined);
        errors.push({ index, code: row.error.code, message: row.error.message });
      } else if ("result" in row && row.result !== undefined) {
        results.push(row.result);
      } else {
        return null;
      }
    }
    return { results, errors };
  });
}

export function parseUint256Hex(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) return null;
  return BigInt(value);
}

export async function fetchJsonRpcHexAtUrl(
  rpcUrl: string,
  method: string,
  params: unknown[],
  options?: Pick<EvmRpcOptions, "signal" | "timeoutMs">,
): Promise<`0x${string}` | null> {
  return fetchJsonRpcResult<`0x${string}`>([rpcUrl], method, params, options, {
    acceptResult: (value): value is `0x${string}` => isHexBytes(value) && value !== "0x",
  });
}

function stateBlockSelector(blockNumberOrTag: number | "latest", options?: EvmRpcOptions) {
  const blockHash = options?.stateBlockHash ?? options?.multicallFallbackBlockHash;
  return blockHash ? { blockHash: blockHash.toLowerCase(), requireCanonical: true } : toBlockTag(blockNumberOrTag);
}

async function fetchEvmCallOutcome(
  chainId: string | undefined,
  to: string,
  data: string,
  blockNumberOrTag: number | "latest" = "latest",
  options?: EvmRpcOptions,
  acceptResult: (value: `0x${string}`) => boolean = (value) => value !== "0x",
  stopOnExecutionRevert = false,
): Promise<JsonRpcOutcome<`0x${string}`>> {
  if ((chainId === "tron" || (chainId && options?.chainRpcs?.get(chainId)?.type === "tron")) &&
      (blockNumberOrTag !== "latest" || options?.stateBlockHash || options?.multicallFallbackBlockHash)) return { status: "unavailable" };
  const urls = requestRpcUrls(chainId, options, blockNumberOrTag);
  if (urls.length === 0) return { status: "unavailable" };

  const callObj: Record<string, string> = { to, data };
  if (options?.gas) {
    const normalizedGas = normalizeJsonRpcQuantityHex(options.gas);
    if (normalizedGas) callObj.gas = normalizedGas;
  }
  const blockTag = stateBlockSelector(blockNumberOrTag, options);
  return fetchJsonRpcOutcome<`0x${string}`>(urls, "eth_call", [callObj, blockTag], options, {
    acceptResult: (value): value is `0x${string}` => isHexBytes(value) && acceptResult(value),
    rejectedReason: () => "invalid call result",
    stopOnExecutionRevert,
  }, chainId);
}

export async function fetchEvmCallHexAtBlock(
  chainId: string | undefined,
  to: string,
  data: string,
  blockNumberOrTag: number | "latest" = "latest",
  options?: EvmRpcOptions,
): Promise<`0x${string}` | null> {
  const outcome = await fetchEvmCallOutcome(chainId, to, data, blockNumberOrTag, options);
  return outcome.status === "data" ? outcome.value : null;
}

export async function fetchEvmCodeStatusAtBlock(
  chainId: string | undefined,
  address: string,
  blockNumberOrTag: number | "latest" = "latest",
  options?: EvmRpcOptions,
): Promise<EvmCodeAtBlockResult> {
  if ((chainId === "tron" || (chainId && options?.chainRpcs?.get(chainId)?.type === "tron")) &&
      (blockNumberOrTag !== "latest" || options?.stateBlockHash || options?.multicallFallbackBlockHash)) return { status: "unavailable" };
  const urls = requestRpcUrls(chainId, options, blockNumberOrTag);
  if (urls.length === 0) return { status: "unavailable" };

  const result = await fetchJsonRpcResult<string>(
    urls,
    "eth_getCode",
    [address, stateBlockSelector(blockNumberOrTag, options)],
    options,
    {
      acceptResult: isHexBytes,
      rejectedReason: () => "invalid bytecode",
    },
    chainId,
  );
  if (result == null) return { status: "unavailable" };
  if (result === "0x") return { status: "absent" };
  return { status: "available", code: result as `0x${string}` };
}

export async function fetchEvmCodeAtBlock(
  chainId: string | undefined,
  address: string,
  blockNumberOrTag: number | "latest" = "latest",
  options?: EvmRpcOptions,
): Promise<`0x${string}` | null> {
  const result = await fetchEvmCodeStatusAtBlock(
    chainId,
    address,
    blockNumberOrTag,
    options,
  );
  return result.status === "available" ? result.code : null;
}

export async function fetchEvmStorageAtBlock(
  chainId: string | undefined,
  address: string,
  position: string,
  blockNumberOrTag: number | "latest" = "latest",
  options?: EvmRpcOptions,
): Promise<`0x${string}` | null> {
  if ((chainId === "tron" || (chainId && options?.chainRpcs?.get(chainId)?.type === "tron")) &&
      (blockNumberOrTag !== "latest" || options?.stateBlockHash || options?.multicallFallbackBlockHash)) return null;
  const urls = requestRpcUrls(chainId, options, blockNumberOrTag);
  if (urls.length === 0) return null;

  const result = await fetchJsonRpcResult<string>(
    urls,
    "eth_getStorageAt",
    [address, position, stateBlockSelector(blockNumberOrTag, options)],
    options,
    {
      acceptResult: (value): value is `0x${string}` => isHexBytes(value) && value !== "0x",
      rejectedReason: () => "null storage",
    },
    chainId,
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

  if (options?.multicallFallbackBlockHash) {
    if (!chainId || typeof blockNumberOrTag !== "number" ||
        !Number.isSafeInteger(blockNumberOrTag) || blockNumberOrTag < 0) return null;
    const code = await fetchEvmCodeStatusAtBlock(
      chainId, MULTICALL3_ADDRESS, blockNumberOrTag, options,
    );
    if (code.status === "unavailable") return null;
    if (code.status === "absent") {
      const results: EvmMulticall3Result[] = [];
      for (const call of calls) {
        const outcome = await fetchEvmCallOutcome(
          chainId, call.target, call.callData, blockNumberOrTag, options, () => true, true,
        );
        if (outcome.status === "unavailable" ||
            (outcome.status === "reverted" && call.allowFailure === false)) return null;
        results.push({ label: call.label, success: outcome.status === "data",
          returnData: outcome.status === "data" ? outcome.value : "0x" });
      }
      const header = await fetchEvmBlockHeader(chainId, blockNumberOrTag, options);
      return header?.number === blockNumberOrTag &&
        header.hash === options.multicallFallbackBlockHash.toLowerCase()
        ? results : null;
    }
  }

  const batchSize = resolveMulticallBatchSize(calls.length, options?.multicallBatchSize);
  const decodedResults: EvmMulticall3Result[] = [];

  for (let start = 0; start < calls.length; start += batchSize) {
    const batch = calls.slice(start, start + batchSize);
    const labels = batch.map((call) => call.label);
    const outcome = await fetchEvmCallOutcome(
      chainId,
      MULTICALL3_ADDRESS,
      encodeMulticall3Aggregate3CallData(batch),
      blockNumberOrTag,
      options,
      (value) => {
        const decoded = decodeMulticall3Aggregate3Result(value, labels);
        if (decoded == null) return false;
        decodedResults.push(...decoded);
        return true;
      },
    );
    if (outcome.status !== "data") return null;
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
  const outcome = await fetchEvmCallOutcome(
    chainId, to, data, blockNumberOrTag, options, (value) => value !== "0x" && value.length <= 66,
  );
  return outcome.status === "data" ? parseUint256Hex(outcome.value) : null;
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
  const urls = requestRpcUrls(chainId, options, "latest", true);
  if (urls.length === 0) return null;

  const result = await fetchJsonRpcResult<string>(urls, "eth_blockNumber", [], options, undefined, chainId);
  return parseHexInteger(result ?? undefined);
}

export async function fetchEvmBlockTimestamp(
  chainId: string,
  blockNumber: number,
  options?: EvmRpcOptions,
): Promise<number | null> {
  return (await fetchEvmBlockHeader(chainId, blockNumber, options))?.timestamp ?? null;
}

async function readEvmBlockHeader(
  chainId: string,
  blockNumberOrTag: number | "latest" | "safe" | "finalized",
  options?: EvmBlockHeaderOptions,
): Promise<EvmBlockHeader | null> {
  const urls = requestRpcUrls(chainId, options, blockNumberOrTag, true);
  if (
    urls.length === 0 ||
    (typeof blockNumberOrTag === "number" &&
      (!Number.isSafeInteger(blockNumberOrTag) || blockNumberOrTag < 0))
  ) {
    return null;
  }

  let acceptedHeader: EvmBlockHeader | null = null;
  await fetchJsonRpcResult<EvmBlockResult>(
    urls,
    "eth_getBlockByNumber",
    [typeof blockNumberOrTag === "number" ? toBlockTag(blockNumberOrTag) : blockNumberOrTag, false],
    options,
    {
      acceptResult: (result): result is EvmBlockResult => {
        if (typeof result !== "object" || result === null) return false;
        const block = result as EvmBlockResult;
        const number = parseHexInteger(block.number);
        const timestamp = parseHexInteger(block.timestamp);
        if (
          number == null ||
          !Number.isSafeInteger(number) ||
          number < 0 ||
          (options?.minBlockNumber !== undefined && number < options.minBlockNumber) ||
          (typeof blockNumberOrTag === "number" && number !== blockNumberOrTag) ||
          timestamp == null ||
          !Number.isSafeInteger(timestamp) ||
          timestamp <= 0 ||
          (options?.minTimestampSec !== undefined && timestamp < options.minTimestampSec) ||
          typeof block.hash !== "string" ||
          !/^0x[0-9a-fA-F]{64}$/.test(block.hash)
        ) {
          return false;
        }
        acceptedHeader = { number, timestamp, hash: block.hash.toLowerCase() as `0x${string}` };
        return true;
      },
      rejectedReason: () => "block header has invalid number, hash, or timestamp, or falls below the required observation window or block",
    },
    chainId,
  );
  return acceptedHeader;
}

export function fetchEvmBlockHeader(
  chainId: string,
  blockNumberOrTag: number | "finalized",
  options?: EvmBlockHeaderOptions,
): Promise<EvmBlockHeader | null> {
  return readEvmBlockHeader(chainId, blockNumberOrTag, options);
}

/** Symbolic-head lookup stays separate from numbered/finalized observer contracts. */
export async function fetchEvmBlockHeaderAtTag(
  chainId: string,
  blockNumberOrTag: "latest" | "safe" | "finalized",
  options?: EvmBlockHeaderOptions,
): Promise<EvmBlockHeader | null> {
  return readEvmBlockHeader(chainId, blockNumberOrTag, options);
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

  // A scoring clock captured immediately before this lookup is commonly only
  // seconds behind the chain tip. Starting an unbounded binary search at block
  // zero makes the first probe deep history, which non-archive public RPCs may
  // have pruned even though every block needed for the near-tip lookup is still
  // available. Find a retained lower bound by walking back exponentially from
  // the closest known upper bound, then binary-search only that bracket.
  if (low === 0 && high > 0) {
    const upperAnchor = high;
    let offset = 1;
    while (true) {
      const candidate = Math.max(0, upperAnchor - offset);
      const timestamp = await getTimestamp(candidate);
      if (timestamp == null) return null;
      if (timestamp <= targetTimestamp) {
        low = candidate;
        break;
      }
      high = candidate;
      if (candidate === 0) return null;
      offset = Math.min(upperAnchor, offset * 2);
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
