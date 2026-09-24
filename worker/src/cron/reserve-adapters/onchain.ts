import { encodeBalanceOfCallData, TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import {
  fetchEtherscanUint256AtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  fetchEvmUint256AtBlock,
  fetchEvmCallHexAtBlock,
  fetchEtherscanProxyHex,
  fetchEvmRpcBatchDetailed,
  toBlockTag,
  type EvmMulticall3Result,
  type EvmRpcBatchError,
} from "../../lib/evm-rpc";
import { tronBase58ToHex } from "../../lib/tron-address";
import { rethrowIfAborted } from "../../lib/abort";
import { logWorkerEventArgs } from "../../lib/structured-log";
import type { LiveReserveInput } from "@shared/types/live-reserves";
import type { AdapterContext } from "./types";
import { runAdapterIo } from "./concurrency";
import { fetchJsonPostWithRetry } from "./request";

type EvmInput = Extract<LiveReserveInput, { kind: "onchain-evm" }>;
type EvmCallInput = Pick<EvmInput, "chain"> & { rpcMode?: EvmInput["rpcMode"] };
type EvmBlockNumberOrTag = number | "latest";

interface EvmCallOptions {
  contract: string;
  data: string;
  signal: AbortSignal;
  ctx?: AdapterContext;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  rpcMode?: EvmInput["rpcMode"];
  chain?: string;
  timeoutMs?: number;
  blockNumberOrTag?: EvmBlockNumberOrTag;
}

interface BoundOnchainCallOptions {
  signal: AbortSignal;
  ctx?: AdapterContext;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  timeoutMs?: number;
  blockNumberOrTag?: EvmBlockNumberOrTag;
}

export type OnchainUint256Caller = (contract: string, data: string) => Promise<bigint | null>;
export type OnchainRawCaller = (contract: string, data: string) => Promise<string | null>;

export interface OnchainCallers {
  uint256: OnchainUint256Caller;
  raw: OnchainRawCaller;
}

export interface OnchainRateProbe {
  contract: string;
  selector: string;
  decimals?: number;
}

export interface OnchainMulticall3Call {
  label: string;
  contract: string;
  data: string;
  allowFailure?: boolean;
}

interface EvmMulticall3Options {
  calls: readonly OnchainMulticall3Call[];
  signal: AbortSignal;
  ctx?: AdapterContext;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  chain?: string;
  timeoutMs?: number;
  multicallBatchSize?: number;
  blockNumberOrTag?: EvmBlockNumberOrTag;
}

function resolveOnchainBlock(options: {
  chain?: string;
  ctx?: AdapterContext;
  blockNumberOrTag?: EvmBlockNumberOrTag;
}): EvmBlockNumberOrTag {
  const observedBlock = options.ctx?.observedBlock;
  if (observedBlock && observedBlock.chain !== options.chain) {
    throw new Error(`Pinned block chain ${observedBlock.chain} does not match ${options.chain}`);
  }
  return options.blockNumberOrTag ?? observedBlock?.number ?? "latest";
}

async function runWithRpcFallback<T>(
  options: EvmCallOptions,
  opLabel: string,
  runRpc: (extraRpcUrls: string[]) => Promise<T | null>,
  runEtherscan: () => Promise<T | null>,
): Promise<T | null> {
  return runAdapterIo(options.ctx, `${opLabel}:${options.chain ?? "unknown"}:${options.contract}`, async () => {
    const extraRpcUrls = [options.rpcUrl, options.fallbackRpcUrl].filter(
      (url): url is string => typeof url === "string" && url.length > 0,
    );

    const rpcValue = await runRpc(extraRpcUrls);
    if (rpcValue != null) {
      return rpcValue;
    }

    if (options.rpcMode === "etherscan-proxy") {
      if (options.chain !== "ethereum") return null;
      return runEtherscan();
    }

    return null;
  });
}

export function makeOnchainCallers(input: EvmCallInput, options: BoundOnchainCallOptions): OnchainCallers {
  const callBase = {
    signal: options.signal,
    ctx: options.ctx,
    rpcUrl: options.rpcUrl,
    fallbackRpcUrl: options.fallbackRpcUrl,
    rpcMode: input.rpcMode,
    chain: input.chain,
    timeoutMs: options.timeoutMs,
    blockNumberOrTag: options.blockNumberOrTag,
  };

  return {
    uint256: (contract: string, data: string) =>
      fetchOnchainUint256({
        ...callBase,
        contract,
        data,
      }),
    raw: (contract: string, data: string) =>
      fetchOnchainRawCall({
        ...callBase,
        contract,
        data,
      }),
  };
}

export async function fetchOnchainUint256(options: EvmCallOptions): Promise<bigint | null> {
  const blockNumberOrTag = resolveOnchainBlock(options);
  return runWithRpcFallback<bigint>(
    options,
    "evm-uint256",
    (extraRpcUrls) =>
      fetchEvmUint256AtBlock(options.chain, options.contract, options.data, blockNumberOrTag, {
        extraRpcUrls,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 10_000,
        chainRpcs: options.ctx?.chainRpcs,
      }),
    () =>
      fetchEtherscanUint256AtBlock(1, options.contract, options.data, blockNumberOrTag, {
        apiKey: options.ctx?.etherscanApiKey,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 10_000,
      }),
  );
}

export async function fetchOnchainMulticall3(options: EvmMulticall3Options): Promise<EvmMulticall3Result[] | null> {
  return runAdapterIo(options.ctx, `evm-multicall3:${options.chain ?? "unknown"}:${options.calls.length}`, async () => {
    const extraRpcUrls = [options.rpcUrl, options.fallbackRpcUrl].filter(
      (url): url is string => typeof url === "string" && url.length > 0,
    );

    return fetchEvmMulticall3Aggregate3AtBlock(
      options.chain,
      options.calls.map((call) => ({
        label: call.label,
        target: call.contract,
        callData: call.data,
        allowFailure: call.allowFailure,
      })),
      resolveOnchainBlock(options),
      {
        extraRpcUrls,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 10_000,
        chainRpcs: options.ctx?.chainRpcs,
        multicallBatchSize: options.multicallBatchSize,
      },
    );
  });
}

export interface OnchainLogEntry {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
}

export interface OnchainLogsResult {
  logs: readonly OnchainLogEntry[];
  /** False means the requested range was not fully scanned; callers must fail closed. */
  complete: boolean;
  calls: number;
  failureReason?: string;
}

export interface OnchainLogsOptions {
  chain: string;
  contract: string;
  /** Positional topic filter; `null` matches any topic at that position. */
  topics: readonly (string | null)[];
  fromBlock: number;
  toBlock: number;
  signal: AbortSignal;
  ctx?: AdapterContext;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  timeoutMs?: number;
  /** Provider calls the bounded range split may spend before failing closed. */
  maxCalls?: number;
  /** A split stops at this range size instead of recursing further. */
  minRangeBlocks?: number;
}

const DEFAULT_ONCHAIN_LOG_SCAN_MAX_CALLS = 4;
const DEFAULT_ONCHAIN_LOG_MIN_RANGE_BLOCKS = 1_000;
const ADDRESS_HEX_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const TOPIC_HEX_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const DATA_HEX_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const QUANTITY_HEX_PATTERN = /^0x[0-9a-fA-F]+$/;
const SPLITTABLE_RANGE_HINTS = [
  "block range",
  "query timeout",
  "timed out",
  "too many results",
  "response size",
  "result set too large",
  "more than",
  "limit exceeded",
] as const;

function isSplittableLogRangeError(error: EvmRpcBatchError): boolean {
  if (error.code === -32005 || error.code === -32000) return true;
  const message = (error.message ?? "").toLowerCase();
  return SPLITTABLE_RANGE_HINTS.some((hint) => message.includes(hint));
}

/**
 * Strict log decoder. Every entry must carry the address, topics, data, and
 * block number the range filter requested; a removed or malformed entry makes
 * the whole scan incomplete so the caller never treats a partial set as whole.
 */
function parseOnchainLogEntry(
  value: unknown,
  expected: { contract: string; topic0: string | null },
): OnchainLogEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.address !== "string" || !ADDRESS_HEX_PATTERN.test(entry.address)) return null;
  if (entry.address.toLowerCase() !== expected.contract.toLowerCase()) return null;
  if (!Array.isArray(entry.topics) || entry.topics.length === 0) return null;
  if (entry.topics.some((topic) => typeof topic !== "string" || !TOPIC_HEX_PATTERN.test(topic))) return null;
  const topics = entry.topics as string[];
  if (expected.topic0 != null && topics[0]?.toLowerCase() !== expected.topic0.toLowerCase()) return null;
  if (entry.removed === true) return null;
  if (typeof entry.data !== "string" || !DATA_HEX_PATTERN.test(entry.data)) return null;
  if (typeof entry.blockNumber !== "string" || !QUANTITY_HEX_PATTERN.test(entry.blockNumber)) return null;
  return { address: entry.address, topics, data: entry.data, blockNumber: entry.blockNumber };
}

/**
 * Generic `eth_getLogs` read over one bounded block window through the vetted
 * EVM RPC transport (registry endpoints only, same as every other reserve
 * adapter read; never Alchemy-specific helpers). The range is scanned
 * depth-first with a hard provider-call budget: a provider that rejects the
 * range splits it, and anything the budget cannot cover returns
 * `complete: false` instead of a silently partial log set.
 */
export async function fetchOnchainLogs(options: OnchainLogsOptions): Promise<OnchainLogsResult | null> {
  return runAdapterIo(
    options.ctx,
    `evm-getlogs:${options.chain}:${options.contract}`,
    async (): Promise<OnchainLogsResult | null> => {
      const extraRpcUrls = [options.rpcUrl, options.fallbackRpcUrl].filter(
        (url): url is string => typeof url === "string" && url.length > 0,
      );
      const maxCalls = Math.max(1, options.maxCalls ?? DEFAULT_ONCHAIN_LOG_SCAN_MAX_CALLS);
      const minRangeBlocks = Math.max(1, options.minRangeBlocks ?? DEFAULT_ONCHAIN_LOG_MIN_RANGE_BLOCKS);
      const expected = { contract: options.contract, topic0: options.topics[0] ?? null };
      const topicFilter = options.topics;

      let calls = 0;
      const logs: OnchainLogEntry[] = [];
      const pendingRanges: Array<{ from: number; to: number }> = [{ from: options.fromBlock, to: options.toBlock }];
      while (pendingRanges.length > 0) {
        const range = pendingRanges.pop()!;
        if (calls >= maxCalls) return { logs: [], complete: false, calls, failureReason: "split-call-budget-exhausted" };
        calls += 1;

        const batch = await fetchEvmRpcBatchDetailed(
          options.chain,
          [{
            method: "eth_getLogs",
            params: [{
              address: options.contract,
              fromBlock: toBlockTag(range.from),
              toBlock: toBlockTag(range.to),
              topics: topicFilter,
            }],
          }],
          {
            extraRpcUrls,
            signal: options.signal,
            timeoutMs: options.timeoutMs ?? 10_000,
            chainRpcs: options.ctx?.chainRpcs,
          },
        );
        if (!batch) return { logs: [], complete: false, calls, failureReason: "provider-unavailable" };

        const error = batch.errors[0];
        if (error) {
          const splittable = isSplittableLogRangeError(error);
          const rangeSize = range.to - range.from + 1;
          if (splittable && rangeSize > minRangeBlocks && calls < maxCalls) {
            const mid = Math.floor((range.from + range.to) / 2);
            pendingRanges.push({ from: mid + 1, to: range.to }, { from: range.from, to: mid });
            continue;
          }
          return {
            logs: [],
            complete: false,
            calls,
            failureReason: splittable ? "split-call-budget-exhausted" : "provider-error",
          };
        }

        const raw = batch.results[0];
        if (!Array.isArray(raw)) return { logs: [], complete: false, calls, failureReason: "malformed-result" };
        for (const value of raw) {
          const entry = parseOnchainLogEntry(value, expected);
          if (!entry) return { logs: [], complete: false, calls, failureReason: "malformed-log-entry" };
          logs.push(entry);
        }
      }

      return { logs, complete: true, calls };
    },
  );
}

export async function fetchOnchainRateBps(
  input: EvmInput,
  probe: OnchainRateProbe,
  signal: AbortSignal,
  ctx?: AdapterContext,
  rpcUrl?: string,
  fallbackRpcUrl?: string,
): Promise<number | null> {
  const decimals = probe.decimals;
  if (decimals == null) {
    logWorkerEventArgs("handler", "warn",
      `[onchain-rate] probe skipped for ${probe.contract}: decimals are missing`,
    );
    return null;
  }
  const scale = 10n ** BigInt(decimals);
  const raw = await fetchOnchainUint256({
    contract: probe.contract,
    data: probe.selector,
    signal,
    ctx,
    rpcUrl,
    fallbackRpcUrl,
    rpcMode: input.rpcMode,
    chain: input.chain,
  });
  if (raw == null) return null;

  const roundedBps = (raw * 10_000n + scale / 2n) / scale;
  return Number(roundedBps);
}

export async function fetchOnchainRawCall(options: EvmCallOptions): Promise<string | null> {
  const blockNumberOrTag = resolveOnchainBlock(options);
  return runWithRpcFallback<string>(
    options,
    "evm-call",
    (extraRpcUrls) =>
      fetchEvmCallHexAtBlock(options.chain, options.contract, options.data, blockNumberOrTag, {
        extraRpcUrls,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 10_000,
        chainRpcs: options.ctx?.chainRpcs,
      }),
    () =>
      fetchEtherscanProxyHex({
        evmChainId: 1,
        action: "eth_call",
        to: options.contract,
        data: options.data,
        blockNumberOrTag,
        apiKey: options.ctx?.etherscanApiKey,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 10_000,
      }),
  );
}

export async function fetchErc20Balance(
  input: EvmInput,
  contract: string,
  holder: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
  rpcUrl?: string,
  fallbackRpcUrl?: string,
): Promise<bigint | null> {
  return fetchOnchainUint256({
    contract,
    data: encodeBalanceOfCallData(holder),
    signal,
    ctx,
    rpcUrl,
    fallbackRpcUrl,
    rpcMode: input.rpcMode,
    chain: input.chain,
  });
}

export async function fetchErc20TotalSupply(
  input: EvmInput,
  contract: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
  rpcUrl?: string,
  fallbackRpcUrl?: string,
): Promise<bigint | null> {
  return fetchOnchainUint256({
    contract,
    data: TOTAL_SUPPLY_SELECTOR,
    signal,
    ctx,
    rpcUrl,
    fallbackRpcUrl,
    rpcMode: input.rpcMode,
    chain: input.chain,
  });
}

const TRON_TOTAL_SUPPLY_FUNCTION_SELECTOR = "totalSupply()";
// Tron's constant-contract call requires a well-formed owner_address even for
// reads that never inspect msg.sender; the zero address is the standard filler.
const TRON_ZERO_OWNER_ADDRESS_HEX41 = "410000000000000000000000000000000000000000";

interface TronTriggerConstantContractResponse {
  result?: { result?: boolean };
  constant_result?: string[];
}

/**
 * TRC-20 totalSupply() via TronGrid's wallet/triggerconstantcontract endpoint.
 * Mirrors fetchErc20TotalSupply's fail-closed contract: any read failure
 * (bad address, HTTP error, contract revert) resolves to null rather than
 * throwing, so callers can fold it into the same success/failure aggregation.
 */
export async function fetchTronErc20TotalSupply(
  contractAddress: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<bigint | null> {
  const contractHex = await tronBase58ToHex(contractAddress);
  if (!contractHex) return null;
  const contractHex41 = `41${contractHex.slice(2)}`;

  const headers: Record<string, string> = {};
  if (ctx?.trongridApiKey) headers["TRON-PRO-API-KEY"] = ctx.trongridApiKey;

  try {
    const json = await fetchJsonPostWithRetry<TronTriggerConstantContractResponse>(
      "https://api.trongrid.io/wallet/triggerconstantcontract",
      {
        owner_address: TRON_ZERO_OWNER_ADDRESS_HEX41,
        contract_address: contractHex41,
        function_selector: TRON_TOTAL_SUPPLY_FUNCTION_SELECTOR,
        parameter: "",
        visible: false,
      },
      signal,
      10_000,
      ctx,
      { headers },
    );

    if (json.result?.result !== true) return null;
    const raw = json.constant_result?.[0];
    if (!raw) return null;
    return BigInt(`0x${raw}`);
  } catch (error) {
    rethrowIfAborted(error, signal);
    // Null feeds the caller's omittedReadFailureChains degraded warning, which
    // already surfaces the failing chain on status surfaces.
    return null;
  }
}
