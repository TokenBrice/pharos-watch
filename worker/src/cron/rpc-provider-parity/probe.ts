import { fetchTextWithRetry, type FetchWithRetryBodyResult } from "../../lib/fetch-retry";
import { parseJson } from "../../lib/json-parse";
import { recordDwellirCredits } from "../../lib/rpc-provider-budget";
import { getRpcAuthHeaders, type ChainRpcConfig } from "../../lib/chain-registry";
import { dwellirRpcUrl } from "@shared/lib/dwellir-chains";
import { USER_AGENT } from "../../lib/constants";
import {
  RPC_PARITY_TARGETS,
  dwellirEntryForChain,
  resolveRpcParityComparator,
  RPC_PARITY_MULTICALL3_ADDRESS,
  RPC_PARITY_MULTICALL3_BLOCK_SELECTOR,
  RPC_PARITY_ARBSYS_ADDRESS,
  RPC_PARITY_ARBSYS_BLOCK_SELECTOR,
  type RpcParityComparatorTarget,
  type RpcParityTarget,
} from "../../lib/rpc-provider-parity/targets";
import {
  combineRpcParityLatestFreshness,
  RPC_PARITY_LATEST_MAX_NUMERIC_CALLS,
  type RpcParityCallObservation,
  type RpcParityChainSkip,
  type RpcParityChainSample,
  type RpcParityErrorClass,
  type RpcParityProbeStep,
  type RpcParityStepFailures,
  type RpcParityLatestFreshness,
} from "../../lib/rpc-provider-parity/types";
// Sentinel tolerance shares the head-lag gate's chain-time policy.
import { headLagThresholdBlocks } from "../../lib/rpc-provider-parity/report";

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
 * A stationary-head 37-chain pass uses 648 calls / 536 Dwellir credits;
 * capped feasible windows allow at most 802 calls / 690 credits. Extrapolating
 * prior 102 s / 174 calls gives ~380–470 s, beyond this four-minute deadline;
 * slow tails deadline-skip, and hourly rotation shares the retained coverage.
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
  observeCall?: (url: string, method: string, params: readonly unknown[], call: RpcCallResult) => void;
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
  if (status >= 500) return "server-error";
  if (RANGE_LIMIT_BODY_PATTERN.test(bodyText)) return "range-cap";
  if (RESULT_LIMIT_BODY_PATTERN.test(bodyText)) return "result-cap";
  if (CAPABILITY_BODY_PATTERN.test(bodyText)) return "capability";
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

async function transportRpcEndpoint(input: {
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

function isRpcParityBlockHeader(value: unknown): value is { hash: string; number: string; parentHash?: string } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && "hash" in value && typeof value.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(value.hash)
    && "number" in value && typeof value.number === "string" && normalizeBlockNumber(value.number) !== null
    && (!("parentHash" in value) || (typeof value.parentHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(value.parentHash)));
}

async function callRpcEndpoint(input: Parameters<typeof transportRpcEndpoint>[0]): Promise<RpcCallResult> {
  const call = await transportRpcEndpoint(input);
  // A JSON-RPC envelope is not a successful method read until its result is usable.
  if (call.status === "ok") {
    const valid = input.method === "eth_blockNumber"
      ? normalizeBlockNumber(call.result) !== null
      : input.method === "eth_getBlockByNumber"
        ? isRpcParityBlockHeader(call.result) && normalizeBlockNumber(call.result.number) === normalizeBlockNumber(input.params[0])
        : input.method === "eth_call"
          ? normalizeRpcQuantity(call.result) !== null
          : sortedLogIdentities(call.result) !== null;
    if (!valid) {
      call.status = "error";
      call.errorClass = "invalid-response";
    }
  }
  if (call.status === "ok" || call.status === "error") {
    input.deps.observeCall?.(input.url, input.method, input.params, call);
  }
  return call;
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
  return { head: false, state: false, logs: false, latest: false };
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
  touchedOrigins: Set<string>;
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
  logsComparator: RpcParityComparatorTarget | null;
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
  const logsHeaders = target.logsComparator && input.logsComparator
    ? getRpcAuthHeaders(input.logsComparator.url) ?? {} : comparatorHeaders;
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
    calls: { dwellir: [], comparator: [] },
  };
  if (target.logsComparator) sample.logsComparator = input.logsComparator?.ref ?? null;
  const touchedOrigins = context.touchedOrigins;
  context = {
    ...context,
    deps: {
      ...context.deps,
      observeCall: (url, method, params, call) => {
        const operator = url === input.dwellirUrl ? "dwellir" : "comparator";
        const origin = new URL(url).origin;
        const phase = touchedOrigins.has(origin) ? "warm" : "firstTouch";
        touchedOrigins.add(origin);
        const step = method === "eth_blockNumber" ? "head"
          : method === "eth_getLogs" ? "logs"
            : params[1] === toHexQuantity(sample.commonBlock ?? -1) ? "state" : "latest";
        const observation: RpcParityCallObservation = {
          step, phase, latencyMs: call.latencyMs!, errorClass: call.errorClass,
        };
        if (input.logsComparator && operator === "comparator" && target.logsComparator && url === input.logsComparator.url) {
          observation.comparator = input.logsComparator.ref;
        }
        sample.calls![operator].push(observation);
        recordStepFailure(sample, operator, step, call);
        if (operator === "dwellir") sample.errorClass ??= call.errorClass;
      },
    },
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
  sample.errorClass = sample.errorClass ?? dwellirHead.errorClass;
  const freshnessStop = await probeLatestFreshness(input, context, sample, dwellirHeadNumber);
  if (freshnessStop !== "none") return { sample, stop: freshnessStop };
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

  const logsComparator = input.logsComparator;
  if (!logsComparator) return { sample, stop: "none" };
  if (target.logsComparator) {
    // A separate origin's log call is not warm until that origin was touched.
    // This head is a warm-up only; head/lag/state still use the primary baseline.
    const logOriginHead = await callRpcEndpoint({
      url: logsComparator.url, method: "eth_blockNumber", params: [],
      headers: logsHeaders, metered: false, signal: context.signal,
      timeoutMs: remainingRequestTimeoutMs(context), deadlineMs: context.deadlineMs,
      deps: context.deps,
    });
    if (logOriginHead.status === "aborted" || logOriginHead.status === "deadline") {
      return { sample, stop: logOriginHead.status };
    }
  }

  if (input.logsHistory === "none") {
    const pruned = await probePrunedLogTrap(input, context, commonBlock, logsComparator, logsHeaders);
    recordStepFailure(sample, "comparator", "logs", pruned.comparatorCall);
    recordStepFailure(sample, "dwellir", "logs", pruned.dwellirCall);
    if (pruned.stop !== "none") return { sample, stop: pruned.stop };
    sample.prunedLogChecked = pruned.checked;
    sample.prunedLogTrap = pruned.trap;
    sample.errorClass = sample.errorClass ?? pruned.dwellirCall?.errorClass ?? null;
    return { sample, stop: "none" };
  }

  const logs = await probeLogParity(input, context, commonBlock, logsComparator, logsHeaders);
  recordStepFailure(sample, "comparator", "logs", logs.comparatorCall);
  recordStepFailure(sample, "dwellir", "logs", logs.dwellirCall);
  if (logs.stop !== "none") return { sample, stop: logs.stop };
  sample.logChecked = logs.checked;
  sample.logMatched = logs.matched;
  sample.errorClass = sample.errorClass ?? logs.dwellirCall?.errorClass ?? null;
  return { sample, stop: "none" };
}

/** A served-block sentinel cannot establish freshness for another (to,data) pair. */
async function probeLatestFreshness(
  input: RpcParityChainProbeInput,
  context: ChainProbeContext,
  sample: RpcParityChainSample,
  headBefore: number | null,
): Promise<"none" | RpcCallStop> {
  const method = input.target.latestStateProbe;
  const tolerance = headLagThresholdBlocks(input.target.blockTimeSec);
  const sentinel: RpcParityLatestFreshness | null = method === "state-bracket" ? null : {
    verdict: "indeterminate", reason: "step-failed", method, discriminating: false,
    headBefore, headAfter: null, matchedBlock: null, latestValue: null,
    numericValues: [], servedBlock: null, lagBlocks: null, toleranceBlocks: tolerance,
    call: method === "multicall3-block-number"
      ? { to: RPC_PARITY_MULTICALL3_ADDRESS, data: RPC_PARITY_MULTICALL3_BLOCK_SELECTOR }
      : { to: RPC_PARITY_ARBSYS_ADDRESS, data: RPC_PARITY_ARBSYS_BLOCK_SELECTOR },
  };
  const token: RpcParityLatestFreshness = {
    verdict: "indeterminate", reason: "step-failed", method: "state-bracket", discriminating: false,
    headBefore, headAfter: null, matchedBlock: null, latestValue: null,
    numericValues: [], toleranceBlocks: tolerance,
    call: { to: input.target.contract, data: RPC_PARITY_TOTAL_SUPPLY_SELECTOR },
  };
  sample.sentinelFreshness = sentinel;
  sample.tokenFreshness = token;
  if (headBefore === null) {
    sample.latestFreshness = combineRpcParityLatestFreshness(sentinel, token);
    return "none";
  }
  const headers = { "X-Api-Key": input.dwellirApiKey };
  const call: LatestRpcCall = (rpcMethod, params) => callRpcEndpoint({
    url: input.dwellirUrl, method: rpcMethod, params, headers,
    metered: true, signal: context.signal, timeoutMs: remainingRequestTimeoutMs(context),
    deadlineMs: context.deadlineMs, deps: context.deps,
  });
  let stop = sentinel ? await probeServedBlockFreshness(sample, sentinel, call) : "none" as const;
  if (stop === "none") {
    stop = await probeTokenFreshness(token, sentinel?.servedBlock ?? null, call);
  }
  sample.latestFreshness = combineRpcParityLatestFreshness(sentinel, token);
  return stop;
}

type LatestRpcCall = (method: string, params: readonly unknown[]) => Promise<RpcCallResult>;

async function probeServedBlockFreshness(
  sample: RpcParityChainSample,
  freshness: RpcParityLatestFreshness,
  call: LatestRpcCall,
): Promise<"none" | RpcCallStop> {
  const latest = await call("eth_call", [freshness.call!, "latest"]);
  if (latest.status === "deadline" || latest.status === "aborted") return latest.status;
  freshness.latestValue = normalizeRpcQuantity(latest.result);
  if (latest.status !== "ok") return "none";
  const after = await call("eth_blockNumber", []);
  if (after.status === "deadline" || after.status === "aborted") return after.status;
  const headAfter = normalizeBlockNumber(after.result);
  freshness.headAfter = headAfter;
  if (after.status !== "ok" || headAfter === null) return "none";
  const served = normalizeBlockNumber(latest.result);
  if (served === null) {
    const observation = sample.calls!.dwellir.find((entry) => entry.step === "latest");
    if (observation) observation.errorClass = "invalid-response";
    sample.failedSteps.dwellir.latest = true;
    sample.errorClass ??= "invalid-response";
    return "none";
  }
  const headBefore = freshness.headBefore!;
  const tolerance = freshness.toleranceBlocks!;
  freshness.servedBlock = served;
  freshness.lagBlocks = headBefore - served;
  if (headAfter < headBefore) freshness.reason = "head-regressed";
  else if (served < headBefore - tolerance) {
    freshness.verdict = "stale";
    freshness.reason = "served-block-behind";
    freshness.discriminating = true;
  } else if (served > headAfter + tolerance) freshness.reason = "served-block-ahead";
  else {
    freshness.verdict = "fresh";
    freshness.reason = "served-block-in-range";
    freshness.discriminating = true;
  }
  return "none";
}

async function probeTokenFreshness(
  freshness: RpcParityLatestFreshness,
  sentinelBlock: number | null,
  call: LatestRpcCall,
): Promise<"none" | RpcCallStop> {
  const headBefore = freshness.headBefore!;
  const before = await call("eth_getBlockByNumber", [toHexQuantity(headBefore), false]);
  if (before.status === "deadline" || before.status === "aborted") return before.status;
  if (before.status !== "ok" || !isRpcParityBlockHeader(before.result)) return "none";
  const latest = await call("eth_call", [freshness.call!, "latest"]);
  if (latest.status === "deadline" || latest.status === "aborted") return latest.status;
  freshness.latestValue = normalizeRpcQuantity(latest.result);
  if (latest.status !== "ok") return "none";
  const after = await call("eth_blockNumber", []);
  if (after.status === "deadline" || after.status === "aborted") return after.status;
  const headAfter = normalizeBlockNumber(after.result);
  freshness.headAfter = headAfter;
  if (after.status !== "ok" || headAfter === null) return "none";
  if (headAfter < headBefore) {
    freshness.reason = "head-regressed";
    return "none";
  }
  const firstBlock = Math.max(0, headBefore - freshness.toleranceBlocks!);
  const endBlock = Math.max(headAfter, sentinelBlock ?? headAfter);
  freshness.referenceEndBlock = endBlock;
  if (endBlock - firstBlock + 1 > RPC_PARITY_LATEST_MAX_NUMERIC_CALLS) {
    freshness.reason = "bracket-too-wide";
    return "none";
  }
  // Fence known head hashes; an ahead-of-head sentinel must not require its header.
  const anchor = await call("eth_getBlockByNumber", [toHexQuantity(headAfter), false]);
  if (anchor.status === "deadline" || anchor.status === "aborted") return anchor.status;
  if (anchor.status !== "ok" || !isRpcParityBlockHeader(anchor.result)) return "none";
  const anchorBlock = anchor.result;
  if ((headAfter === headBefore && anchorBlock.hash !== before.result.hash)
    || (headAfter === headBefore + 1 && anchorBlock.parentHash !== before.result.hash)) {
    freshness.reason = "bracket-reorg";
    return "none";
  }
  for (let block = endBlock; block >= firstBlock; block--) {
    const numeric = await call("eth_call", [freshness.call!, toHexQuantity(block)]);
    if (numeric.status === "deadline" || numeric.status === "aborted") return numeric.status;
    const value = normalizeRpcQuantity(numeric.result);
    if (numeric.status !== "ok" || value === null) return "none";
    freshness.numericValues!.push({ block, value });
    if (value === freshness.latestValue && freshness.matchedBlock === null) freshness.matchedBlock = block;
  }
  const confirmed = await call("eth_getBlockByNumber", [toHexQuantity(headAfter), false]);
  if (confirmed.status === "deadline" || confirmed.status === "aborted") return confirmed.status;
  if (confirmed.status !== "ok" || !isRpcParityBlockHeader(confirmed.result)) return "none";
  if (confirmed.result.hash !== anchorBlock.hash) {
    freshness.reason = "bracket-reorg";
    return "none";
  }
  if (freshness.matchedBlock !== null) {
    freshness.discriminating = freshness.numericValues!.some((entry) => entry.value !== freshness.numericValues![0].value);
    freshness.verdict = "fresh";
    freshness.reason = "matched-numeric-block";
  } else {
    freshness.verdict = "stale";
    freshness.reason = "no-bracket-match";
    freshness.discriminating = true;
  }
  return "none";
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
  const checked = dwellirSupply !== null && comparatorSupply !== null;
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
  comparator: RpcParityComparatorTarget,
  comparatorHeaders: Record<string, string>,
): Promise<ParityStepProbe> {
  const windowBlocks = input.target.logWindowBlocks ?? RPC_PARITY_LOG_WINDOW_BLOCKS;
  const fromBlock = Math.max(0, commonBlock - (windowBlocks - 1));
  const params = [{ address: input.target.contract, fromBlock: toHexQuantity(fromBlock), toBlock: toHexQuantity(commonBlock) }];
  const comparatorLogs = await callRpcEndpoint({
    url: comparator.url,
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
  const checked = dwellirIdentities !== null && comparatorIdentities !== null;
  return {
    checked,
    matched:
      checked && dwellirIdentities !== null && comparatorIdentities !== null
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
  comparator: RpcParityComparatorTarget,
  comparatorHeaders: Record<string, string>,
): Promise<PrunedLogProbe> {
  const windowBlocks = input.target.logWindowBlocks ?? RPC_PARITY_LOG_WINDOW_BLOCKS;
  const toBlock = Math.max(0, commonBlock - RPC_PARITY_PRUNED_LOG_DEPTH_BLOCKS);
  const fromBlock = Math.max(0, toBlock - (windowBlocks - 1));
  const params = [{ address: input.target.contract, fromBlock: toHexQuantity(fromBlock), toBlock: toHexQuantity(toBlock) }];
  const comparatorLogs = await callRpcEndpoint({
    url: comparator.url,
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
  const checked = dwellirCount !== null && comparatorCount !== null;
  return {
    checked,
    trap: checked && comparatorCount !== null && comparatorCount > 0 && dwellirCount === 0,
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
  skipped: RpcParityChainSkip[];
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
  atSec?: number;
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
  const touchedOrigins = new Set<string>();

  const offset = targets.length === 0 ? 0 : Math.floor((input.atSec ?? deps.nowMs() / 1000) / 3600) % targets.length;
  for (let index = 0; index < targets.length; index++) {
    const target = targets[(offset + index) % targets.length];
    if (input.signal.aborted) {
      result.aborted = true;
      for (let remaining = index; remaining < targets.length; remaining++) {
        result.skipped.push({ chainId: targets[(offset + remaining) % targets.length].chainId, reason: "aborted" });
      }
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
        logsComparator: target.logsComparator ? resolveRpcParityComparator(target, input.chainRpcs, "logs") : comparator,
        dwellirUrl: dwellirRpcUrl(dwellirEntry),
        dwellirHost: `${dwellirEntry.host}.n.dwellir.com`,
        dwellirApiKey: input.dwellirApiKey,
        logsHistory: typeof dwellirEntry.logsHistory === "string" ? dwellirEntry.logsHistory : "full",
      },
      { signal: input.signal, deadlineMs: input.deadlineMs, deps, touchedOrigins },
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
      if (probe.stop === "aborted") {
        for (let remaining = index + 1; remaining < targets.length; remaining++) {
          result.skipped.push({ chainId: targets[(offset + remaining) % targets.length].chainId, reason: "aborted" });
        }
        break;
      }
      continue;
    }
    result.samples.push(probe.sample);
    result.attempted += 1;
    if (probe.sample.headOk) result.headOk += 1;
    await input.onChainProbed?.(target.chainId, result.attempted);
  }

  return result;
}
