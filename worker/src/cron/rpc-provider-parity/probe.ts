import { fetchTextWithRetry, type FetchWithRetryBodyResult } from "../../lib/fetch-retry";
import { parseJson } from "../../lib/json-parse";
import { recordDwellirCredits } from "../../lib/rpc-provider-budget";
import { dwellirRpcUrl, getRpcAuthHeaders, type ChainRpcConfig } from "../../lib/chain-registry";
import { USER_AGENT } from "../../lib/constants";
import {
  RPC_PARITY_TARGETS,
  dwellirEntryForChain,
  resolveRpcParityComparator,
  type RpcParityComparatorTarget,
  type RpcParityTarget,
} from "../../lib/rpc-provider-parity/targets";
import type {
  RpcParityChainSample,
  RpcParityErrorClass,
  RpcParityProbeStep,
  RpcParityStepFailures,
} from "../../lib/rpc-provider-parity/types";

/**
 * The trial probe: one strictly serial pass over every Dwellir chain, reading
 * the same block height from Dwellir and the chain's current first operator.
 *
 * Serial on purpose. The lane exists to measure latency and history
 * capabilities, so a fan-out would contaminate the latency samples with its own
 * queueing, and the slot budget counts one connection for this lane. Every
 * response body is consumed or cancelled inside `fetchTextWithRetry` before the
 * next request opens, and the key travels only as the `X-Api-Key` header.
 */

const RPC_PARITY_REQUEST_TIMEOUT_MS = 8_000;
/**
 * Internal probe deadline. 29 chains x 6 serial requests (~300 ms nominal) is
 * ~52 s; the four-minute bound keeps a slow provider day inside the job's
 * five-minute cron timeout instead of losing the run's terminal row.
 */
export const RPC_PARITY_RUN_BUDGET_MS = 4 * 60_000;
const RPC_PARITY_MAX_RESPONSE_BYTES = 128 * 1024;
/**
 * `eth_getLogs` answers are legitimately large: a 10-block address-filtered
 * window on a busy chain runs into megabytes. The lane keeps its general bound
 * and raises it only for log reads, still bounded so one response cannot
 * dominate the isolate's heap.
 */
const RPC_PARITY_LOGS_MAX_RESPONSE_BYTES = 1024 * 1024;
/** Inclusive window of blocks read for log parity, ending at the common block. */
export const RPC_PARITY_LOG_WINDOW_BLOCKS = 10;
/** How far below the common block the pruned-history probe reads on `logsHistory: "none"` chains. */
export const RPC_PARITY_PRUNED_LOG_DEPTH_BLOCKS = 1_000_000;
/** ERC-20 `totalSupply()` selector. */
const RPC_PARITY_TOTAL_SUPPLY_SELECTOR = "0x18160ddd";

const CAPABILITY_BODY_PATTERN = /does not support|not supported|not allowed|unsupported|not enabled on your plan/i;
const RANGE_LIMIT_BODY_PATTERN = /block limit|block range|out of range|range (?:is )?(?:too|exceed)|exceeds? (?:the )?range/i;
const RESULT_LIMIT_BODY_PATTERN = /too many logs|max(?:imum)? results|results? (?:limit|cap)|query returned more than|response size/i;

/** Test seam: the probe's transport, clock, and credit meter. */
export interface RpcParityProbeDeps {
  fetchText: typeof fetchTextWithRetry;
  nowMs: () => number;
  recordCredits: (count: number) => void;
}

const DEFAULT_PROBE_DEPS: RpcParityProbeDeps = {
  fetchText: fetchTextWithRetry,
  nowMs: () => Date.now(),
  recordCredits: recordDwellirCredits,
};

/**
 * Dwellir's failure class for one failed call. HTTP-level signals win over the
 * body, because a plan refusal arrives as a status while an overloaded node
 * often answers 200 with a JSON-RPC error.
 */
export function classifyRpcParityHttpFailure(status: number, bodyText: string): RpcParityErrorClass {
  if (status === 429) return "rate-limited";
  if (status === 408) return "timeout";
  if (CAPABILITY_BODY_PATTERN.test(bodyText)) return "capability";
  if (status >= 500) return "server-error";
  if (status === 401 || status === 402 || status === 403 || status === 404) return "capability";
  return "invalid-response";
}

/** JSON-RPC error classes: range/result caps are the history-capability signals this lane watches. */
export function classifyRpcParityJsonRpcError(code: number | null, message: string): RpcParityErrorClass {
  if (CAPABILITY_BODY_PATTERN.test(message)) return "capability";
  if (code === -32005 || RANGE_LIMIT_BODY_PATTERN.test(message)) return "range-cap";
  if (RESULT_LIMIT_BODY_PATTERN.test(message)) return "result-cap";
  return "rpc-error";
}

/** Transport failures that never produced a usable response. */
export function classifyRpcParityTransportError(error: unknown): RpcParityErrorClass {
  if (!error || typeof error !== "object") return "network";
  const name = "name" in error ? String((error as { name?: unknown }).name ?? "") : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  if ("maxBytes" in error) return "invalid-response";
  return "network";
}

/**
 * Control signals that stop the run without classifying a provider fault, so a
 * torn-down or over-budget run never pollutes the provider's error statistics.
 */
type RpcCallStop = "aborted" | "deadline";

interface RpcCallResult {
  status: "ok" | "error" | RpcCallStop;
  result: unknown;
  latencyMs: number | null;
  errorClass: RpcParityErrorClass | null;
  /** HTTP status of an answered request; null when no response arrived. */
  httpStatus: number | null;
}

async function callRpcEndpoint(input: {
  url: string;
  method: string;
  params: readonly unknown[];
  headers: Record<string, string>;
  metered: boolean;
  signal: AbortSignal;
  timeoutMs: number;
  deadlineMs: number;
  maxResponseBytes?: number;
  deps: RpcParityProbeDeps;
}): Promise<RpcCallResult> {
  if (input.deps.nowMs() >= input.deadlineMs) {
    return { status: "deadline", result: null, latencyMs: null, errorClass: null, httpStatus: null };
  }
  const startedAtMs = input.deps.nowMs();
  if (input.metered) input.deps.recordCredits(1);
  let outcome: FetchWithRetryBodyResult<string> | null;
  try {
    outcome = await input.deps.fetchText(
      input.url,
      {
        method: "POST",
        headers: { "content-type": "application/json", "User-Agent": USER_AGENT, ...input.headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: input.method, params: input.params }),
        signal: input.signal,
      },
      0,
      {
        timeoutMs: input.timeoutMs,
        returnFinalResponse: true,
        throwOnFinalNetworkError: true,
        maxResponseBytes: input.maxResponseBytes ?? RPC_PARITY_MAX_RESPONSE_BYTES,
      },
    );
  } catch (error) {
    const latencyMs = Math.max(0, input.deps.nowMs() - startedAtMs);
    if (input.signal.aborted) {
      return { status: "aborted", result: null, latencyMs, errorClass: null, httpStatus: null };
    }
    return {
      status: "error",
      result: null,
      latencyMs,
      errorClass: classifyRpcParityTransportError(error),
      httpStatus: null,
    };
  }
  const latencyMs = Math.max(0, input.deps.nowMs() - startedAtMs);
  if (!outcome) {
    // Only reachable if the transport stops throwing on final network errors.
    return { status: "error", result: null, latencyMs, errorClass: "network", httpStatus: null };
  }
  if (!outcome.response.ok) {
    return {
      status: "error",
      result: null,
      latencyMs,
      errorClass: classifyRpcParityHttpFailure(outcome.response.status, outcome.body),
      httpStatus: outcome.response.status,
    };
  }

  const parsed = parseJson(outcome.body);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return { status: "error", result: null, latencyMs, errorClass: "invalid-response", httpStatus: outcome.response.status };
  }
  const payload = parsed.value as { result?: unknown; error?: unknown };
  if (payload.error != null) {
    const errorObject = typeof payload.error === "object" ? (payload.error as { code?: unknown; message?: unknown }) : {};
    const code = typeof errorObject.code === "number" ? errorObject.code : null;
    const message = typeof errorObject.message === "string" ? errorObject.message : JSON.stringify(payload.error);
    return {
      status: "error",
      result: null,
      latencyMs,
      errorClass: classifyRpcParityJsonRpcError(code, message),
      httpStatus: outcome.response.status,
    };
  }
  if (!("result" in payload)) {
    return { status: "error", result: null, latencyMs, errorClass: "invalid-response", httpStatus: outcome.response.status };
  }
  return { status: "ok", result: payload.result, latencyMs, errorClass: null, httpStatus: outcome.response.status };
}

/** Hex-quantity comparison that ignores leading zeros; null when the value is not a quantity. */
export function normalizeRpcQuantity(value: unknown): string | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  try {
    return BigInt(value).toString(10);
  } catch {
    return null;
  }
}

function normalizeBlockNumber(value: unknown): number | null {
  const normalized = normalizeRpcQuantity(value);
  if (normalized === null) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Margin below the lowest head both operators may read at. Two blocks cover
 * L1-style chains; sub-second chains need proportionally more so a block that is
 * still being built is never read by one operator and missing on the other.
 */
export function rpcParityCommonBlockMargin(blockTimeSec: number): number {
  if (!Number.isFinite(blockTimeSec) || blockTimeSec <= 0) return 2;
  return Math.max(2, Math.ceil(4 / blockTimeSec));
}

function toHexQuantity(value: number): string {
  return `0x${value.toString(16)}`;
}

function logIdentity(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const value = entry as { transactionHash?: unknown; logIndex?: unknown };
  if (typeof value.transactionHash !== "string" || typeof value.logIndex !== "string") return null;
  return `${value.transactionHash.toLowerCase()}:${value.logIndex.toLowerCase()}`;
}

function sortedLogIdentities(result: unknown): string[] | null {
  if (!Array.isArray(result)) return null;
  const identities: string[] = [];
  for (const entry of result) {
    const identity = logIdentity(entry);
    if (identity === null) return null;
    identities.push(identity);
  }
  return identities.sort();
}

function emptyStepFailures(): RpcParityStepFailures {
  return { head: false, state: false, logs: false };
}

/**
 * Records one failed call against its operator and step. The first comparator
 * failure in the sample keeps its class and status: later steps only run when
 * the earlier ones produced something to compare against.
 */
function recordStepFailure(
  sample: RpcParityChainSample,
  operator: "dwellir" | "comparator",
  step: RpcParityProbeStep,
  call: RpcCallResult | null,
): void {
  if (!call || call.status !== "error") return;
  sample.failedSteps[operator][step] = true;
  if (operator !== "comparator" || sample.comparatorErrorClass !== null) return;
  sample.comparatorErrorClass = call.errorClass;
  sample.comparatorHttpStatus = call.httpStatus;
}

interface ChainProbeContext {
  signal: AbortSignal;
  deadlineMs: number;
  deps: RpcParityProbeDeps;
}

function remainingRequestTimeoutMs(context: ChainProbeContext): number {
  return Math.max(1, Math.min(RPC_PARITY_REQUEST_TIMEOUT_MS, context.deadlineMs - context.deps.nowMs()));
}

/**
 * Probes one chain. Every Dwellir failure is classified rather than thrown: a
 * capability refusal is evidence about the provider, and the run must keep
 * probing the remaining chains.
 */
interface RpcParityChainProbeInput {
  target: RpcParityTarget;
  comparator: RpcParityComparatorTarget;
  dwellirUrl: string;
  dwellirHost: string;
  dwellirApiKey: string;
  logsHistory: string;
}

async function probeRpcParityChain(
  input: RpcParityChainProbeInput,
  context: ChainProbeContext,
): Promise<{ sample: RpcParityChainSample; stop: "none" | RpcCallStop }> {
  const { target, comparator, dwellirApiKey } = input;
  const dwellirHeaders = { "X-Api-Key": dwellirApiKey };
  // The comparator's operator may authenticate by header (Alchemy's registry
  // URL carries no key), so the origin-registered auth is replayed verbatim.
  // Reviewed public pins and keyless public endpoints have no registration.
  const comparatorHeaders = getRpcAuthHeaders(comparator.url) ?? {};
  const sample: RpcParityChainSample = {
    chainId: target.chainId,
    comparator: comparator.ref,
    dwellirHost: input.dwellirHost,
    headOk: false,
    comparatorHeadOk: false,
    comparatorHead: null,
    dwellirHead: null,
    commonBlock: null,
    lagBlocks: null,
    stateChecked: false,
    stateMatched: false,
    logChecked: false,
    logMatched: false,
    prunedLogChecked: false,
    prunedLogTrap: false,
    dwellirLatencyMs: null,
    comparatorLatencyMs: null,
    errorClass: null,
    comparatorErrorClass: null,
    comparatorHttpStatus: null,
    failedSteps: { dwellir: emptyStepFailures(), comparator: emptyStepFailures() },
  };

  const comparatorHead = await callRpcEndpoint({
    url: comparator.url,
    method: "eth_blockNumber",
    params: [],
    headers: comparatorHeaders,
    metered: false,
    signal: context.signal,
    timeoutMs: remainingRequestTimeoutMs(context),
    deadlineMs: context.deadlineMs,
    deps: context.deps,
  });
  if (comparatorHead.status === "aborted" || comparatorHead.status === "deadline") {
    return { sample, stop: comparatorHead.status };
  }
  recordStepFailure(sample, "comparator", "head", comparatorHead);
  sample.comparatorLatencyMs = comparatorHead.latencyMs;
  const comparatorHeadNumber = normalizeBlockNumber(comparatorHead.result);
  sample.comparatorHeadOk = comparatorHeadNumber !== null;
  sample.comparatorHead = comparatorHeadNumber;

  const dwellirHead = await callRpcEndpoint({
    url: input.dwellirUrl,
    method: "eth_blockNumber",
    params: [],
    headers: dwellirHeaders,
    metered: true,
    signal: context.signal,
    timeoutMs: remainingRequestTimeoutMs(context),
    deadlineMs: context.deadlineMs,
    deps: context.deps,
  });
  if (dwellirHead.status === "aborted" || dwellirHead.status === "deadline") {
    return { sample, stop: dwellirHead.status };
  }
  recordStepFailure(sample, "dwellir", "head", dwellirHead);
  sample.dwellirLatencyMs = dwellirHead.latencyMs;
  const dwellirHeadNumber = normalizeBlockNumber(dwellirHead.result);
  sample.headOk = dwellirHeadNumber !== null;
  sample.dwellirHead = dwellirHeadNumber;
  sample.errorClass = dwellirHead.errorClass;
  if (comparatorHeadNumber === null || dwellirHeadNumber === null) return { sample, stop: "none" };

  sample.lagBlocks = comparatorHeadNumber - dwellirHeadNumber;
  const commonBlock = Math.max(
    0,
    Math.min(comparatorHeadNumber, dwellirHeadNumber) - rpcParityCommonBlockMargin(target.blockTimeSec),
  );
  sample.commonBlock = commonBlock;

  const state = await probeStateParity(input, context, commonBlock, comparatorHeaders);
  recordStepFailure(sample, "comparator", "state", state.comparatorCall);
  recordStepFailure(sample, "dwellir", "state", state.dwellirCall);
  if (state.stop !== "none") return { sample, stop: state.stop };
  sample.stateChecked = state.checked;
  sample.stateMatched = state.matched;
  sample.errorClass = sample.errorClass ?? state.dwellirCall?.errorClass ?? null;

  if (input.logsHistory === "none") {
    const pruned = await probePrunedLogTrap(input, context, commonBlock, comparatorHeaders);
    recordStepFailure(sample, "comparator", "logs", pruned.comparatorCall);
    recordStepFailure(sample, "dwellir", "logs", pruned.dwellirCall);
    if (pruned.stop !== "none") return { sample, stop: pruned.stop };
    sample.prunedLogChecked = pruned.checked;
    sample.prunedLogTrap = pruned.trap;
    sample.errorClass = sample.errorClass ?? pruned.dwellirCall?.errorClass ?? null;
    return { sample, stop: "none" };
  }

  const logs = await probeLogParity(input, context, commonBlock, comparatorHeaders);
  recordStepFailure(sample, "comparator", "logs", logs.comparatorCall);
  recordStepFailure(sample, "dwellir", "logs", logs.dwellirCall);
  if (logs.stop !== "none") return { sample, stop: logs.stop };
  sample.logChecked = logs.checked;
  sample.logMatched = logs.matched;
  sample.errorClass = sample.errorClass ?? logs.dwellirCall?.errorClass ?? null;
  return { sample, stop: "none" };
}

/** One comparison step's outcome plus the calls behind it, for per-step diagnostics. */
interface ParityStepProbe {
  checked: boolean;
  matched: boolean;
  stop: "none" | RpcCallStop;
  comparatorCall: RpcCallResult | null;
  dwellirCall: RpcCallResult | null;
}

/** The pruned-history probe answers with a trap flag instead of a parity verdict. */
interface PrunedLogProbe {
  checked: boolean;
  trap: boolean;
  stop: "none" | RpcCallStop;
  comparatorCall: RpcCallResult | null;
  dwellirCall: RpcCallResult | null;
}

async function probeStateParity(
  input: RpcParityChainProbeInput,
  context: ChainProbeContext,
  commonBlock: number,
  comparatorHeaders: Record<string, string>,
): Promise<ParityStepProbe> {
  const callParams = [{ to: input.target.contract, data: RPC_PARITY_TOTAL_SUPPLY_SELECTOR }, toHexQuantity(commonBlock)];
  const comparatorCall = await callRpcEndpoint({
    url: input.comparator.url,
    method: "eth_call",
    params: callParams,
    headers: comparatorHeaders,
    metered: false,
    signal: context.signal,
    timeoutMs: remainingRequestTimeoutMs(context),
    deadlineMs: context.deadlineMs,
    deps: context.deps,
  });
  if (comparatorCall.status === "aborted" || comparatorCall.status === "deadline") {
    return { checked: false, matched: false, stop: comparatorCall.status, comparatorCall, dwellirCall: null };
  }
  const comparatorSupply = normalizeRpcQuantity(comparatorCall.result);
  if (comparatorSupply === null) {
    return { checked: false, matched: false, stop: "none", comparatorCall, dwellirCall: null };
  }

  const dwellirCall = await callRpcEndpoint({
    url: input.dwellirUrl,
    method: "eth_call",
    params: callParams,
    headers: { "X-Api-Key": input.dwellirApiKey },
    metered: true,
    signal: context.signal,
    timeoutMs: remainingRequestTimeoutMs(context),
    deadlineMs: context.deadlineMs,
    deps: context.deps,
  });
  if (dwellirCall.status === "aborted" || dwellirCall.status === "deadline") {
    return { checked: false, matched: false, stop: dwellirCall.status, comparatorCall, dwellirCall };
  }
  const dwellirSupply = normalizeRpcQuantity(dwellirCall.result);
  // R1: a read that produced no value is unavailable, not unequal. Only a pair
  // of answers is a comparison, and only a pair of answers can mismatch.
  const checked = dwellirSupply !== null;
  return {
    checked,
    matched: checked && dwellirSupply === comparatorSupply,
    stop: "none",
    comparatorCall,
    dwellirCall,
  };
}

async function probeLogParity(
  input: RpcParityChainProbeInput,
  context: ChainProbeContext,
  commonBlock: number,
  comparatorHeaders: Record<string, string>,
): Promise<ParityStepProbe> {
  const windowBlocks = input.target.logWindowBlocks ?? RPC_PARITY_LOG_WINDOW_BLOCKS;
  const fromBlock = Math.max(0, commonBlock - (windowBlocks - 1));
  const params = [{ address: input.target.contract, fromBlock: toHexQuantity(fromBlock), toBlock: toHexQuantity(commonBlock) }];
  const comparatorLogs = await callRpcEndpoint({
    url: input.comparator.url,
    method: "eth_getLogs",
    params,
    headers: comparatorHeaders,
    metered: false,
    signal: context.signal,
    timeoutMs: remainingRequestTimeoutMs(context),
    deadlineMs: context.deadlineMs,
    maxResponseBytes: RPC_PARITY_LOGS_MAX_RESPONSE_BYTES,
    deps: context.deps,
  });
  if (comparatorLogs.status === "aborted" || comparatorLogs.status === "deadline") {
    return { checked: false, matched: false, stop: comparatorLogs.status, comparatorCall: comparatorLogs, dwellirCall: null };
  }
  // The comparator's own logs read is the window's reference: without it there
  // is nothing to compare against, so the sample records no log parity claim.
  const comparatorIdentities = comparatorLogs.status === "ok" ? sortedLogIdentities(comparatorLogs.result) : null;
  if (comparatorIdentities === null) {
    return { checked: false, matched: false, stop: "none", comparatorCall: comparatorLogs, dwellirCall: null };
  }

  const dwellirLogs = await callRpcEndpoint({
    url: input.dwellirUrl,
    method: "eth_getLogs",
    params,
    headers: { "X-Api-Key": input.dwellirApiKey },
    metered: true,
    signal: context.signal,
    timeoutMs: remainingRequestTimeoutMs(context),
    deadlineMs: context.deadlineMs,
    maxResponseBytes: RPC_PARITY_LOGS_MAX_RESPONSE_BYTES,
    deps: context.deps,
  });
  if (dwellirLogs.status === "aborted" || dwellirLogs.status === "deadline") {
    return { checked: false, matched: false, stop: dwellirLogs.status, comparatorCall: comparatorLogs, dwellirCall: dwellirLogs };
  }
  const dwellirIdentities = dwellirLogs.status === "ok" ? sortedLogIdentities(dwellirLogs.result) : null;
  const checked = dwellirIdentities !== null;
  return {
    checked,
    matched:
      checked
      && dwellirIdentities.length === comparatorIdentities.length
      && dwellirIdentities.every((identity, index) => identity === comparatorIdentities[index]),
    stop: "none",
    comparatorCall: comparatorLogs,
    dwellirCall: dwellirLogs,
  };
}

/**
 * zkSync-style chains: Dwellir's `-full` node silently returns `[]` for pruned
 * log ranges instead of erroring, so the lane reads a small window far below
 * its retention on both operators and records whether the trap persists.
 */
async function probePrunedLogTrap(
  input: RpcParityChainProbeInput,
  context: ChainProbeContext,
  commonBlock: number,
  comparatorHeaders: Record<string, string>,
): Promise<PrunedLogProbe> {
  const windowBlocks = input.target.logWindowBlocks ?? RPC_PARITY_LOG_WINDOW_BLOCKS;
  const toBlock = Math.max(0, commonBlock - RPC_PARITY_PRUNED_LOG_DEPTH_BLOCKS);
  const fromBlock = Math.max(0, toBlock - (windowBlocks - 1));
  const params = [{ address: input.target.contract, fromBlock: toHexQuantity(fromBlock), toBlock: toHexQuantity(toBlock) }];
  const comparatorLogs = await callRpcEndpoint({
    url: input.comparator.url,
    method: "eth_getLogs",
    params,
    headers: comparatorHeaders,
    metered: false,
    signal: context.signal,
    timeoutMs: remainingRequestTimeoutMs(context),
    deadlineMs: context.deadlineMs,
    maxResponseBytes: RPC_PARITY_LOGS_MAX_RESPONSE_BYTES,
    deps: context.deps,
  });
  if (comparatorLogs.status === "aborted" || comparatorLogs.status === "deadline") {
    return { checked: false, trap: false, stop: comparatorLogs.status, comparatorCall: comparatorLogs, dwellirCall: null };
  }
  const comparatorCount = comparatorLogs.status === "ok" && Array.isArray(comparatorLogs.result) ? comparatorLogs.result.length : null;
  if (comparatorCount === null) {
    return { checked: false, trap: false, stop: "none", comparatorCall: comparatorLogs, dwellirCall: null };
  }

  const dwellirLogs = await callRpcEndpoint({
    url: input.dwellirUrl,
    method: "eth_getLogs",
    params,
    headers: { "X-Api-Key": input.dwellirApiKey },
    metered: true,
    signal: context.signal,
    timeoutMs: remainingRequestTimeoutMs(context),
    deadlineMs: context.deadlineMs,
    maxResponseBytes: RPC_PARITY_LOGS_MAX_RESPONSE_BYTES,
    deps: context.deps,
  });
  if (dwellirLogs.status === "aborted" || dwellirLogs.status === "deadline") {
    return { checked: false, trap: false, stop: dwellirLogs.status, comparatorCall: comparatorLogs, dwellirCall: dwellirLogs };
  }
  const dwellirCount = dwellirLogs.status === "ok" && Array.isArray(dwellirLogs.result) ? dwellirLogs.result.length : null;
  const checked = dwellirCount !== null;
  return {
    checked,
    trap: checked && comparatorCount > 0 && dwellirCount === 0,
    stop: "none",
    comparatorCall: comparatorLogs,
    dwellirCall: dwellirLogs,
  };
}

export interface RpcParityProbeRunResult {
  samples: RpcParityChainSample[];
  attempted: number;
  headOk: number;
  deadlineHit: boolean;
  aborted: boolean;
  skipped: { chainId: string; reason: "no-comparator" | "no-dwellir-entry" | "deadline" | "aborted" }[];
}

/**
 * One strictly serial pass over the target table. The loop awaits each chain
 * before starting the next, so at most one request is in flight for the whole
 * run, and it stops starting chains once the deadline or the job signal fires.
 */
export async function probeRpcProviderParityRun(input: {
  targets?: readonly RpcParityTarget[];
  chainRpcs: Map<string, ChainRpcConfig>;
  dwellirApiKey: string;
  signal: AbortSignal;
  deadlineMs: number;
  deps?: Partial<RpcParityProbeDeps>;
  onChainProbed?: (chainId: string, probed: number) => void | Promise<void>;
}): Promise<RpcParityProbeRunResult> {
  const deps: RpcParityProbeDeps = { ...DEFAULT_PROBE_DEPS, ...input.deps };
  const targets = input.targets ?? RPC_PARITY_TARGETS;
  const result: RpcParityProbeRunResult = {
    samples: [],
    attempted: 0,
    headOk: 0,
    deadlineHit: false,
    aborted: false,
    skipped: [],
  };

  for (const target of targets) {
    if (input.signal.aborted) {
      // A torn-down slot is not evidence about the chains left unprobed.
      result.aborted = true;
      break;
    }
    if (deps.nowMs() >= input.deadlineMs) {
      result.deadlineHit = true;
      result.skipped.push({ chainId: target.chainId, reason: "deadline" });
      continue;
    }
    const comparator = resolveRpcParityComparator(target, input.chainRpcs);
    if (!comparator) {
      result.skipped.push({ chainId: target.chainId, reason: "no-comparator" });
      continue;
    }
    const dwellirEntry = dwellirEntryForChain(target.chainId);
    if (!dwellirEntry) {
      result.skipped.push({ chainId: target.chainId, reason: "no-dwellir-entry" });
      continue;
    }

    const probe = await probeRpcParityChain(
      {
        target,
        comparator,
        dwellirUrl: dwellirRpcUrl(dwellirEntry),
        dwellirHost: `${dwellirEntry.host}.n.dwellir.com`,
        dwellirApiKey: input.dwellirApiKey,
        logsHistory: typeof dwellirEntry.logsHistory === "string" ? dwellirEntry.logsHistory : "full",
      },
      { signal: input.signal, deadlineMs: input.deadlineMs, deps },
    );
    if (probe.stop !== "none") {
      // The chain's observation is incomplete because the run stopped, not
      // because the provider failed, so it is not stored as a sample.
      if (probe.stop === "deadline") {
        result.deadlineHit = true;
      } else {
        result.aborted = true;
      }
      result.skipped.push({ chainId: target.chainId, reason: probe.stop });
      if (probe.stop === "aborted") break;
      continue;
    }
    result.samples.push(probe.sample);
    result.attempted += 1;
    if (probe.sample.headOk) result.headOk += 1;
    await input.onChainProbed?.(target.chainId, result.attempted);
  }

  return result;
}
