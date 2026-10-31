import { sha256Hex, sha256HexFromBytes } from "@shared/lib/sha256";
import {
  LANE_ADMIN_EVENT_SCREENING_POLICY_DIGEST,
  TOPIC_BY0,
  TOPICS_BY_FAMILY,
} from "@shared/lib/safety-score-v9/lane-screening-derivation";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { isWellFormedDeploymentId } from "@shared/types/deployment-id";
import {
  V9_LANE_SCREENING_EVIDENCE_CLASS,
  V9LaneIncidentCertificateSchema,
  type V9LaneAdminEventFamily,
  type V9LaneIncidentScreeningResult,
  type V9LaneScreeningFailureReason,
} from "@shared/types/safety-score-v9-incidents";
import { rethrowIfAborted, throwIfAborted } from "../abort";
import type { ChainRpcConfig } from "../chain-registry";
import {
  fetchEvmBlockHeader,
  fetchEvmRpcBatchDetailed,
  toBlockTag,
  usableCcipRpcEndpoints,
  type EvmBlockHeader,
  type EvmRpcBatchCall,
  type EvmRpcBatchDetailedResult,
} from "../evm-rpc";
import { decodeEvmHexBytes } from "./supply-observation-primitives";

/**
 * Pinned admin-event screening for one EVM lane and every contract that can
 * administer it.
 *
 * The producer reads the frozen `topic0` list below over one caller-pinned,
 * finalized block range for each declared emitter (OApp, endpoint, ULN library)
 * and either emits a C3 `V9LaneIncidentCertificate` or a machine-reasoned
 * failure. Every emitter's runtime code must hash to its reviewed SHA-256, and a
 * partial or malformed read never becomes a certificate (ADR-29): a missing
 * certificate keeps the lane's incident state unknown, never "none".
 *
 * Every read is one JSON-RPC batch with at most one request in flight, so a lane
 * never contributes more than one connection to the invocation budget. Per-lane
 * cost is `2 + ceil(blocks / pageSpan)` sequential RPC batches (finalized head,
 * block-range pin plus every emitter's code, then one batch per log page).
 */

/** Fallback `eth_getLogs` page span when the serving provider declares none. */
export const LANE_ADMIN_EVENT_DEFAULT_LOG_PAGE_BLOCKS = 10_000;
/** Hard per-lane request budget for log pages; exceeding it fails the lane closed with no certificate. */
export const LANE_ADMIN_EVENT_MAX_LOG_PAGES = 32;
/** A page returning more matches than this is narrowed before it is trusted. */
export const LANE_ADMIN_EVENT_MAX_EVENTS_PER_PAGE = 1_024;
/** Certificates carry every material event; an unrepresentable count fails closed. */
export const LANE_ADMIN_EVENT_MAX_MATERIAL_EVENTS = 1_024;
const MAX_DETAIL_LENGTH = 240;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/u;
const BYTES32_PATTERN = /^0x[0-9a-f]{64}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const QUANTITY_PATTERN = /^0x[0-9a-f]{1,16}$/u;
const HEX_BYTES_PATTERN = /^0x[0-9a-f]*$/u;
const PRUNED_MESSAGE_HINTS = ["pruned", "not available", "missing trie node", "history", "oldest", "earliest"] as const;
const RANGE_MESSAGE_HINTS = [
  "block range", "range is too", "too many", "more than", "limit", "query timeout", "timed out",
  "response size", "result set", "exceeds",
] as const;

export interface LaneAdminEventEmitter {
  /** Lowercase emitter contract address (OApp, endpoint, ULN library, ...). */
  address: `0x${string}`;
  /** Reviewed runtime code hash (sha256 hex, no prefix); a mismatch fails closed. */
  expectedRuntimeCodeSha256: string;
  /** Emitted-event families this emitter can produce. */
  families: readonly V9LaneAdminEventFamily[];
}

export interface LaneAdminEventScreeningTarget {
  /** Lane/controller deployment the certificate closes (`chain:contractAddress`, normalized). */
  subjectDeploymentKey: string;
  fromBlock: number;
  toBlock: number;
  /** Every contract whose logs this certificate covers; at least one. */
  emitters: readonly LaneAdminEventEmitter[];
}

export interface LaneAdminEventScreeningOptions {
  chainRpcs: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Absolute producer deadline, inherited by every RPC retry and fallback. */
  deadlineMs?: number;
  /** Producer clock; must be at or after the pinned window end. */
  observedAtSec?: number;
  /**
   * Finalized head the producer already read for this chain. The driver plans
   * the pinned range from it, so re-reading `finalized` here could pin the range
   * against a lagging second observation; the caller's admitted head is the
   * range authority for this invocation.
   */
  finalizedHead?: EvmBlockHeader;
}

/** Execution deferral, not an evidence failure or scoring reason. */
export class LaneScreeningDeadlineError extends Error {
  constructor() {
    super("lane-screening-deadline");
    this.name = "LaneScreeningDeadlineError";
  }
}

function requestTimeoutMs(options: { timeoutMs: number; deadlineMs?: number }): number {
  if (options.deadlineMs === undefined) return options.timeoutMs;
  const remainingMs = options.deadlineMs - Date.now();
  // Do not begin another batch without room for one full request. The RPC
  // helper still clips each retry/fallback to the absolute remaining budget.
  if (remainingMs < options.timeoutMs) throw new LaneScreeningDeadlineError();
  return Math.min(options.timeoutMs, remainingMs);
}

function throwIfDeadlineExhausted(deadlineMs: number | undefined): void {
  if (deadlineMs !== undefined && Date.now() >= deadlineMs) throw new LaneScreeningDeadlineError();
}

interface ParsedLog {
  address: string;
  family: V9LaneAdminEventFamily;
  topics: string[];
  data: string;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
}

interface ResolvedTarget {
  chainId: string;
  subjectDeploymentKey: string;
  fromBlock: number;
  toBlock: number;
  emitters: Array<{ address: string; expectedRuntimeCodeSha256: string; families: V9LaneAdminEventFamily[] }>;
  screenedFamilies: V9LaneAdminEventFamily[];
}

function failedResult(
  deploymentKey: string,
  failureReason: V9LaneScreeningFailureReason,
  observedAtSec: number,
  detail?: string,
): V9LaneIncidentScreeningResult {
  return {
    outcome: "failed",
    deploymentKey,
    failureReason,
    observedAtSec,
    ...(detail === undefined ? {} : { detail: detail.replace(/\s+/gu, " ").trim().slice(0, MAX_DETAIL_LENGTH) }),
  };
}

function hexQuantity(value: unknown): number | null {
  if (typeof value !== "string" || !QUANTITY_PATTERN.test(value)) return null;
  const parsed = Number.parseInt(value, 16);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Strict `eth_getBlockByNumber` decoder; any missing or malformed field fails closed. */
function parseBlockHeader(value: unknown, expectedNumber?: number): EvmBlockHeader | null {
  if (!value || typeof value !== "object") return null;
  const header = value as Record<string, unknown>;
  const number = hexQuantity(header.number);
  const timestamp = hexQuantity(header.timestamp);
  if (number === null || timestamp === null || timestamp < 1) return null;
  if (typeof header.hash !== "string" || !BYTES32_PATTERN.test(header.hash)) return null;
  if (expectedNumber !== undefined && number !== expectedNumber) return null;
  return { number, timestamp, hash: header.hash as `0x${string}` };
}

function isPrunedMessage(message: string | undefined): boolean {
  const text = (message ?? "").toLowerCase();
  return PRUNED_MESSAGE_HINTS.some((hint) => text.includes(hint));
}

function isRangeMessage(message: string | undefined): boolean {
  const text = (message ?? "").toLowerCase();
  return RANGE_MESSAGE_HINTS.some((hint) => text.includes(hint));
}

function rpcErrorReason(error: { code?: number; message?: string }): V9LaneScreeningFailureReason {
  if (error.code === -32005 || isRangeMessage(error.message) || isPrunedMessage(error.message)) return "pruned-range";
  return "rpc-unavailable";
}

/**
 * One batch; transport failures return null. Abort reasons pass through
 * unchanged so cancellation is never reported as a lane failure.
 */
async function readBatch(
  chainId: string,
  calls: readonly EvmRpcBatchCall[],
  options: { chainRpcs: Map<string, ChainRpcConfig>; signal?: AbortSignal; timeoutMs: number; deadlineMs?: number; observedHeadBlock: number },
): Promise<EvmRpcBatchDetailedResult | null> {
  const timeoutMs = requestTimeoutMs(options);
  try {
    const result = await fetchEvmRpcBatchDetailed(chainId, calls, {
      chainRpcs: options.chainRpcs,
      signal: options.signal,
      timeoutMs,
      deadlineMs: options.deadlineMs,
      observedHeadBlock: options.observedHeadBlock,
    });
    throwIfDeadlineExhausted(options.deadlineMs);
    return result;
  } catch (error) {
    rethrowIfAborted(error, options.signal);
    throwIfDeadlineExhausted(options.deadlineMs);
    return null;
  }
}

function parseLogEntry(
  value: unknown,
  lane: { addresses: ReadonlySet<string>; familiesByAddress: ReadonlyMap<string, ReadonlySet<string>>; fromBlock: number; toBlock: number },
): ParsedLog | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.address !== "string") return null;
  const address = entry.address.toLowerCase();
  if (!ADDRESS_PATTERN.test(address) || !lane.addresses.has(address)) return null;
  if (entry.removed === true) return null;
  if (!Array.isArray(entry.topics) || entry.topics.length === 0) return null;
  const topics: string[] = [];
  for (const topic of entry.topics) {
    if (typeof topic !== "string" || !BYTES32_PATTERN.test(topic)) return null;
    topics.push(topic);
  }
  const screened = TOPIC_BY0.get(topics[0]!);
  if (screened === undefined) return null;
  if (!lane.familiesByAddress.get(address)?.has(screened.family)) return null;
  if (typeof entry.data !== "string" || entry.data.length % 2 !== 0 || !HEX_BYTES_PATTERN.test(entry.data)) return null;
  if (typeof entry.blockHash !== "string" || !BYTES32_PATTERN.test(entry.blockHash)) return null;
  if (typeof entry.transactionHash !== "string" || !BYTES32_PATTERN.test(entry.transactionHash)) return null;
  const blockNumber = hexQuantity(entry.blockNumber);
  const logIndex = hexQuantity(entry.logIndex);
  if (blockNumber === null || logIndex === null || logIndex >= 1_000_000) return null;
  if (blockNumber < lane.fromBlock || blockNumber > lane.toBlock) return null;
  return {
    address,
    family: screened.family,
    topics,
    data: entry.data,
    blockNumber,
    blockHash: entry.blockHash,
    transactionHash: entry.transactionHash,
    logIndex,
  };
}

function resolveTarget(target: LaneAdminEventScreeningTarget): ResolvedTarget {
  if (!isWellFormedDeploymentId(target.subjectDeploymentKey)) {
    throw new TypeError(`Lane screening requires a normalized subject deployment id: ${target.subjectDeploymentKey}`);
  }
  for (const [label, value] of [["fromBlock", target.fromBlock], ["toBlock", target.toBlock]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Lane screening ${label} must be a non-negative safe integer`);
  }
  if (target.toBlock < target.fromBlock) throw new TypeError("Lane screening block range must end at or after its start");
  if (target.emitters.length === 0) throw new TypeError("Lane screening requires at least one emitter");
  const addresses = new Set<string>();
  const screened = new Set<V9LaneAdminEventFamily>();
  const emitters = target.emitters.map((emitter) => {
    const address = emitter.address.toLowerCase();
    if (!ADDRESS_PATTERN.test(address)) throw new TypeError(`Lane screening emitter address is not an EVM address: ${emitter.address}`);
    if (addresses.has(address)) throw new TypeError(`Lane screening emitter addresses must be unique: ${address}`);
    addresses.add(address);
    const expected = emitter.expectedRuntimeCodeSha256.toLowerCase();
    if (!SHA256_PATTERN.test(expected)) throw new TypeError(`Lane screening emitter ${address} needs a sha256 runtime code hash`);
    if (emitter.families.length === 0) throw new TypeError(`Lane screening emitter ${address} declares no families`);
    const families = [...new Set(emitter.families)];
    for (const family of families) {
      if (!TOPICS_BY_FAMILY.has(family)) throw new TypeError(`Lane screening family is not in the frozen list: ${family}`);
      screened.add(family);
    }
    return { address, expectedRuntimeCodeSha256: expected, families: families.sort() };
  });
  const separator = target.subjectDeploymentKey.indexOf(":");
  return {
    chainId: target.subjectDeploymentKey.slice(0, separator),
    subjectDeploymentKey: target.subjectDeploymentKey,
    fromBlock: target.fromBlock,
    toBlock: target.toBlock,
    emitters,
    screenedFamilies: [...screened].sort(),
  };
}

/**
 * Screen one lane over a pinned finalized block range.
 *
 * Fail-closed outcomes (never a certificate): unsupported chain, unavailable
 * RPC, unpinned or future-dated range end, pruned or budget-exhausted log read,
 * malformed header/log data, absent emitter code, and any emitter whose observed
 * runtime code hash differs from its reviewed hash. The certificate is the C3
 * wire shape, `evidenceClass` `explorer-events`, with every screened emitter's
 * observed code hash and the full read's `logDigest`.
 */
export async function screenLaneAdminEvents(
  target: LaneAdminEventScreeningTarget,
  options: LaneAdminEventScreeningOptions,
): Promise<V9LaneIncidentScreeningResult> {
  const observedAtSec = options.observedAtSec ?? Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(observedAtSec) || observedAtSec < 0) {
    throw new TypeError("Lane screening producer clock must be a non-negative integer");
  }
  const resolved = resolveTarget(target);
  const { chainId, subjectDeploymentKey, fromBlock, toBlock, emitters, screenedFamilies } = resolved;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const readOptions = { chainRpcs: options.chainRpcs, signal: options.signal, timeoutMs, deadlineMs: options.deadlineMs };

  const chain = options.chainRpcs.get(chainId);
  if (!chain || chain.type !== "evm") return failedResult(subjectDeploymentKey, "unsupported-chain", observedAtSec, `chain:${chainId}`);

  throwIfAborted(options.signal);
  const finalized = options.finalizedHead ?? await fetchEvmBlockHeader(chainId, "finalized", {
    ...readOptions, timeoutMs: requestTimeoutMs(readOptions),
  });
  throwIfDeadlineExhausted(options.deadlineMs);
  if (!finalized) return failedResult(subjectDeploymentKey, "rpc-unavailable", observedAtSec, "finalized-head-unavailable");
  if (toBlock > finalized.number) {
    return failedResult(subjectDeploymentKey, "non-finalized-head", observedAtSec, `to-block:${toBlock}>finalized:${finalized.number}`);
  }

  const pinCalls: EvmRpcBatchCall[] = [{ method: "eth_getBlockByNumber", params: [toBlockTag(fromBlock), false] }];
  if (toBlock !== fromBlock) pinCalls.push({ method: "eth_getBlockByNumber", params: [toBlockTag(toBlock), false] });
  const headerCallCount = pinCalls.length;
  for (const emitter of emitters) pinCalls.push({ method: "eth_getCode", params: [emitter.address, toBlockTag(toBlock)] });

  const pin = await readBatch(chainId, pinCalls, { ...readOptions, observedHeadBlock: finalized.number });
  if (!pin) return failedResult(subjectDeploymentKey, "rpc-unavailable", observedAtSec, "block-range-pin-unavailable");
  const fromHeader = parseBlockHeader(pin.results[0], fromBlock);
  const toHeader = toBlock === fromBlock ? fromHeader : parseBlockHeader(pin.results[1], toBlock);
  for (const error of pin.errors) {
    if (error.index < headerCallCount) {
      return failedResult(subjectDeploymentKey, rpcErrorReason(error), observedAtSec, `header:${error.code ?? "?"}:${error.message ?? ""}`);
    }
    return failedResult(subjectDeploymentKey, rpcErrorReason(error), observedAtSec, `code:${emitters[error.index - headerCallCount]?.address ?? "?"}:${error.code ?? "?"}`);
  }
  if (!fromHeader || !toHeader) return failedResult(subjectDeploymentKey, "rpc-unavailable", observedAtSec, "malformed-block-header");
  if (toHeader.timestamp < fromHeader.timestamp) {
    return failedResult(subjectDeploymentKey, "malformed-read", observedAtSec, "window-clock-inversion");
  }
  if (toHeader.timestamp > observedAtSec) {
    return failedResult(subjectDeploymentKey, "non-finalized-head", observedAtSec, "window-end-in-future");
  }

  const observedCodeHashes = new Map<string, string>();
  for (let index = 0; index < emitters.length; index += 1) {
    const emitter = emitters[index]!;
    const code = pin.results[headerCallCount + index];
    if (code === "0x") return failedResult(subjectDeploymentKey, "missing-controller", observedAtSec, emitter.address);
    if (typeof code !== "string" || code.length % 2 !== 0 || !HEX_BYTES_PATTERN.test(code)) {
      return failedResult(subjectDeploymentKey, "malformed-read", observedAtSec, `code:${emitter.address}`);
    }
    const runtimeBytes = decodeEvmHexBytes(code);
    if (!runtimeBytes) return failedResult(subjectDeploymentKey, "malformed-read", observedAtSec, `code:${emitter.address}`);
    const observed = sha256HexFromBytes(runtimeBytes);
    if (observed !== emitter.expectedRuntimeCodeSha256) {
      return failedResult(subjectDeploymentKey, "code-hash-mismatch", observedAtSec, `${emitter.address}:${observed}`);
    }
    observedCodeHashes.set(emitter.address, observed);
  }

  const eligible = usableCcipRpcEndpoints(chainId, options.chainRpcs, {
    kind: "logs",
    fromBlock,
    toBlock: fromBlock,
    observedHeadBlock: finalized.number,
  });
  if (eligible.length === 0) return failedResult(subjectDeploymentKey, "pruned-range", observedAtSec, "range-outside-retained-logs");
  const declaredSpan = eligible[0]?.maxLogBlockSpan;
  if (declaredSpan !== undefined && (!Number.isSafeInteger(declaredSpan) || declaredSpan < 1)) {
    return failedResult(subjectDeploymentKey, "rpc-unavailable", observedAtSec, "invalid-log-span");
  }

  const addresses = emitters.map((emitter) => emitter.address);
  const familiesByAddress = new Map(emitters.map((emitter) => [emitter.address, new Set<string>(emitter.families)] as const));
  const logTopics = [...new Set(screenedFamilies.map((family) => TOPICS_BY_FAMILY.get(family)!.topic0))];
  const logs: ParsedLog[] = [];
  let pageSpan = declaredSpan ?? LANE_ADMIN_EVENT_DEFAULT_LOG_PAGE_BLOCKS;
  let cursor = fromBlock;
  let pages = 0;
  let lastBlockNumber = -1;
  let lastLogIndex = -1;
  while (cursor <= toBlock) {
    throwIfAborted(options.signal);
    if (pages >= LANE_ADMIN_EVENT_MAX_LOG_PAGES) {
      return failedResult(subjectDeploymentKey, "read-budget-exhausted", observedAtSec, `pages:${pages};from:${cursor}`);
    }
    const end = Math.min(toBlock, cursor + pageSpan - 1);
    pages += 1;
    const batch = await readBatch(chainId, [{
      method: "eth_getLogs",
      params: [{ address: addresses, fromBlock: toBlockTag(cursor), toBlock: toBlockTag(end), topics: [logTopics] }],
    }], { ...readOptions, observedHeadBlock: finalized.number });
    if (!batch) return failedResult(subjectDeploymentKey, "rpc-unavailable", observedAtSec, `log-page:${cursor}-${end}`);

    const error = batch.errors[0];
    if (error) {
      const narrowable = end > cursor && pages < LANE_ADMIN_EVENT_MAX_LOG_PAGES;
      if ((error.code === -32005 || isRangeMessage(error.message)) && narrowable) {
        pageSpan = Math.max(1, Math.floor(pageSpan / 2));
        continue;
      }
      return failedResult(subjectDeploymentKey, rpcErrorReason(error), observedAtSec, `log-error:${error.code ?? "?"}:${error.message ?? ""}`);
    }

    const raw = batch.results[0];
    if (!Array.isArray(raw)) return failedResult(subjectDeploymentKey, "malformed-read", observedAtSec, "malformed-log-result");
    if (raw.length > LANE_ADMIN_EVENT_MAX_EVENTS_PER_PAGE) {
      if (end > cursor && pages < LANE_ADMIN_EVENT_MAX_LOG_PAGES) {
        pageSpan = Math.max(1, Math.floor(pageSpan / 2));
        continue;
      }
      return failedResult(subjectDeploymentKey, "read-budget-exhausted", observedAtSec, `page-capacity:${cursor}-${end}`);
    }

    const pageLogs: ParsedLog[] = [];
    for (const value of raw) {
      const log = parseLogEntry(value, { addresses: new Set(addresses), familiesByAddress, fromBlock: cursor, toBlock: end });
      if (!log) return failedResult(subjectDeploymentKey, "malformed-read", observedAtSec, `malformed-log-entry:${cursor}-${end}`);
      pageLogs.push(log);
    }
    pageLogs.sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex);
    for (const log of pageLogs) {
      const position = log.blockNumber * 1_000_000 + log.logIndex;
      if (position <= lastBlockNumber * 1_000_000 + lastLogIndex) {
        return failedResult(subjectDeploymentKey, "malformed-read", observedAtSec, `log-duplicate:${log.blockNumber}:${log.logIndex}`);
      }
      lastBlockNumber = log.blockNumber;
      lastLogIndex = log.logIndex;
      logs.push(log);
      if (logs.length > LANE_ADMIN_EVENT_MAX_MATERIAL_EVENTS) {
        return failedResult(subjectDeploymentKey, "read-budget-exhausted", observedAtSec, "material-event-capacity");
      }
    }
    cursor = end + 1;
  }

  throwIfDeadlineExhausted(options.deadlineMs);
  const eventCounts: Partial<Record<V9LaneAdminEventFamily, number>> = {};
  for (const family of screenedFamilies) eventCounts[family] = 0;
  for (const log of logs) eventCounts[log.family] = (eventCounts[log.family] ?? 0) + 1;

  const logDigest = sha256Hex(stableJsonStringifyV1({
    domain: "safety-score-v9.lane-admin-event-log.v2",
    evidenceClass: V9_LANE_SCREENING_EVIDENCE_CLASS,
    subjectDeploymentKey,
    screeningPolicyDigest: LANE_ADMIN_EVENT_SCREENING_POLICY_DIGEST,
    fromBlock,
    toBlock,
    fromBlockHash: fromHeader.hash,
    fromBlockTimestamp: fromHeader.timestamp,
    toBlockHash: toHeader.hash,
    toBlockTimestamp: toHeader.timestamp,
    finalizedHeadNumber: finalized.number,
    finalizedHeadHash: finalized.hash,
    emitters: emitters.map((emitter) => ({
      address: emitter.address,
      expectedRuntimeCodeSha256: emitter.expectedRuntimeCodeSha256,
      runtimeCodeSha256: observedCodeHashes.get(emitter.address),
      families: emitter.families,
    })),
    logs: logs.map((log) => ({
      address: log.address,
      family: log.family,
      topics: log.topics,
      data: log.data,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
    })),
  }));

  const certificate = V9LaneIncidentCertificateSchema.parse({
    schemaVersion: 1,
    certificateId: `lane-cert:${chainId}:${emitters[0]!.address}:${fromBlock}-${toBlock}:${logDigest.slice(0, 12)}`,
    evidenceClass: V9_LANE_SCREENING_EVIDENCE_CLASS,
    subjectDeploymentKey,
    fromBlock,
    toBlock,
    toBlockHash: toHeader.hash,
    windowStartSec: fromHeader.timestamp,
    windowEndSec: toHeader.timestamp,
    observedAtSec,
    screeningPolicyDigest: LANE_ADMIN_EVENT_SCREENING_POLICY_DIGEST,
    logDigest,
    emitters: emitters.map((emitter) => ({
      address: emitter.address,
      expectedRuntimeCodeSha256: emitter.expectedRuntimeCodeSha256,
      runtimeCodeSha256: observedCodeHashes.get(emitter.address)!,
      families: emitter.families,
    })),
    screenedTopics: screenedFamilies.map((family) => ({ ...TOPICS_BY_FAMILY.get(family)! })),
    eventCounts,
    finding: logs.length > 0 ? "material-event" : "no-material-admin-event",
    ...(logs.length === 0 ? {} : {
      materialEvents: logs.map((log) => ({
        address: log.address,
        family: log.family,
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
      })),
    }),
  });
  return { outcome: "admitted", certificate };
}

/**
 * Screen lanes strictly one after another so a multi-lane cycle never holds more
 * than one RPC connection open. Results keep the input order.
 */
export async function screenLaneAdminEventsBatch(
  targets: readonly LaneAdminEventScreeningTarget[],
  options: LaneAdminEventScreeningOptions,
): Promise<V9LaneIncidentScreeningResult[]> {
  const results: V9LaneIncidentScreeningResult[] = [];
  for (const target of targets) {
    throwIfAborted(options.signal);
    results.push(await screenLaneAdminEvents(target, options));
  }
  return results;
}
