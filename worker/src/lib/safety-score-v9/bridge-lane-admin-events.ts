import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { isWellFormedDeploymentId } from "@shared/types/deployment-id";
import {
  V9_LANE_SCREENING_EVIDENCE_CLASS,
  V9LaneIncidentCertificateSchema,
  type V9LaneAdminEventFamily,
  type V9LaneIncidentScreeningResult,
  type V9LaneScreeningFailureReason,
} from "@shared/types/safety-score-v9-incidents";
import { keccak256 } from "viem/utils";
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

/**
 * Pinned admin-event screening for one exact EVM lane contract.
 *
 * The producer reads the frozen `topic0` list below over one caller-pinned,
 * finalized block range and either emits a C3 `V9LaneIncidentCertificate` or a
 * machine-reasoned failure. A partial read never becomes a certificate (ADR-29):
 * a missing certificate keeps the lane's incident state unknown, never "none".
 *
 * Every read is one JSON-RPC batch with at most one request in flight, so a lane
 * never contributes more than one connection to the invocation budget. Per-lane
 * cost is `2 + ceil(blocks / pageSpan)` sequential RPC batches (finalized head,
 * block-range pin plus code, then one batch per log page).
 */

/**
 * C3 family vocabulary mapped to the exact, frozen ABI signature per family.
 * Frozen 2026-10-29 against LayerZero-v2 `main` (`IMessageLibManager.sol`,
 * `UlnBase.sol`, `SendLibBase.sol`, `OAppCore.sol`, `RateLimiter.sol`) and
 * chainlink-ccip `main` (`pools/TokenPool.sol`). Family names stay the C3
 * vocabulary; where the contract emits a differently named event (for example
 * `SetPeer` -> `PeerSet`) the signature column is authoritative.
 */
export const LANE_ADMIN_EVENT_TOPICS = [
  { family: "OwnershipTransferred", signature: "OwnershipTransferred(address,address)", topic0: "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0" },
  { family: "RoleGranted", signature: "RoleGranted(bytes32,address,address)", topic0: "0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d" },
  { family: "RoleRevoked", signature: "RoleRevoked(bytes32,address,address)", topic0: "0xf6391f5c32d9c69d2a47ea670b442974b53935d1edc7fd64eb21e047a839171b" },
  { family: "Paused", signature: "Paused(address)", topic0: "0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258" },
  { family: "Unpaused", signature: "Unpaused(address)", topic0: "0x5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa" },
  { family: "Upgraded", signature: "Upgraded(address)", topic0: "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b" },
  { family: "AdminChanged", signature: "AdminChanged(address,address)", topic0: "0x7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f" },
  { family: "BeaconUpgraded", signature: "BeaconUpgraded(address)", topic0: "0x1cf3b03a6cf19fa2baba4df148e9dcabedea7f8a5c07840e207e5c089be95d3e" },
  // LayerZero v2 OApp peer and endpoint-delegate controls.
  { family: "SetPeer", signature: "PeerSet(uint32,bytes32)", topic0: "0x238399d427b947898edb290f5ff0f9109849b1c3ba196a42e35f00c50a54b98b" },
  { family: "SetDelegate", signature: "DelegateSet(address,address)", topic0: "0x6ee10e9ed4d6ce9742703a498707862f4b00f1396a87195eb93267b3d7983981" },
  // Chainlink CCIP TokenPool admin config and rate-limit setters.
  { family: "SetConfig", signature: "DynamicConfigSet(address,address,address)", topic0: "0x3f1036e85d016a93254a0b1415844f79b85424959d90ae5ad51ce8f4533fe701" },
  { family: "SetRateLimit", signature: "RateLimitConfigured(uint64,bool,(bool,uint128,uint128),(bool,uint128,uint128))", topic0: "0x41f7c8f7cfdad9350aa495e6c54cbbf750a07ab38a9098aed1256e30dd1682bb" },
  // LayerZero v2 RateLimiter mixin used by OFT contracts.
  { family: "RateLimitChanged", signature: "RateLimitsChanged((uint32,uint256,uint256)[])", topic0: "0xe888347665897e637801f36c5129f510657276178c89022bc5fa0246dbc19de1" },
  // LayerZero v2 ULN DVN and executor configuration.
  { family: "UlnConfigSet", signature: "UlnConfigSet(address,uint32,(uint64,uint8,uint8,uint8,address[],address[]))", topic0: "0x82118522aa536ac0e96cc5c689407ae42b89d592aa133890a01f1509842f5081" },
  { family: "ExecutorConfigSet", signature: "ExecutorConfigSet(address,uint32,(uint32,address))", topic0: "0x779cb2dd9d2bb1be1737d05435d744facbfb84a2a4912e21379d39beddcdc805" },
  // LayerZero v2 EndpointV2 message-library changes.
  { family: "DefaultSendLibrarySet", signature: "DefaultSendLibrarySet(uint32,address)", topic0: "0x16aa0f528038ab41019e95bae5b418a50ba8532c5800e3b7ea2f517d3fa625f5" },
  { family: "DefaultReceiveLibrarySet", signature: "DefaultReceiveLibrarySet(uint32,address)", topic0: "0xc16891855cffb4a5ac51ac11864a3f3c96ba816cc45fe686c987ae36277de5ec" },
  { family: "SendLibrarySet", signature: "SendLibrarySet(address,uint32,address)", topic0: "0x4cff966ebee29a156dcb34cf72c1d06231fb1777f6bdf6e8089819232f002b1c" },
  { family: "ReceiveLibrarySet", signature: "ReceiveLibrarySet(address,uint32,address)", topic0: "0xcd6f92f5ac6185a5acfa02c92090746cec64d777269cbcd0ed031e396657a1c2" },
] as const satisfies readonly {
  family: V9LaneAdminEventFamily;
  signature: string;
  topic0: `0x${string}`;
}[];

/**
 * Frozen-list identity. Certificates carry this digest so a certificate produced
 * under a different topic list can never be admitted by a reader that uses the
 * current one. Changing the table or the freeze date deliberately changes it.
 */
export const LANE_ADMIN_EVENT_SCREENING_POLICY_DIGEST = sha256Hex(stableJsonStringifyV1({
  domain: "safety-score-v9.lane-admin-event-screening-policy.v1",
  frozenAt: "2026-10-29",
  topics: LANE_ADMIN_EVENT_TOPICS.map((topic) => ({ ...topic })),
}));

const TOPIC0_BY_FAMILY = new Map<string, V9LaneAdminEventFamily>(
  LANE_ADMIN_EVENT_TOPICS.map((topic) => [topic.topic0, topic.family]),
);
const SCREENED_TOPIC0S = LANE_ADMIN_EVENT_TOPICS.map((topic) => topic.topic0);

/** Fallback `eth_getLogs` page span when the serving provider declares none. */
export const LANE_ADMIN_EVENT_DEFAULT_LOG_PAGE_BLOCKS = 10_000;
/** Hard per-lane request budget for log pages; exceeding it fails the lane closed. */
export const LANE_ADMIN_EVENT_MAX_LOG_PAGES = 32;
/** A page returning more matches than this is narrowed before it is trusted. */
export const LANE_ADMIN_EVENT_MAX_EVENTS_PER_PAGE = 1_024;
/** Certificates carry every material event; an unrepresentable count fails closed. */
export const LANE_ADMIN_EVENT_MAX_MATERIAL_EVENTS = 1_024;
const MAX_DETAIL_LENGTH = 240;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/u;
const BYTES32_PATTERN = /^0x[0-9a-f]{64}$/u;
const QUANTITY_PATTERN = /^0x[0-9a-f]{1,16}$/u;
const HEX_BYTES_PATTERN = /^0x[0-9a-f]*$/u;
const PRUNED_MESSAGE_HINTS = ["pruned", "not available", "missing trie node", "history", "oldest", "earliest"] as const;
const RANGE_MESSAGE_HINTS = [
  "block range", "range is too", "too many", "more than", "limit", "query timeout", "timed out",
  "response size", "result set", "exceeds",
] as const;

export interface LaneAdminEventScreeningTarget {
  /** Exact lane deployment identity (`chain:contractAddress`, already normalized). */
  deploymentKey: string;
  /** Reviewed runtime code hash (keccak256 of `eth_getCode`); a mismatch fails closed. */
  expectedCodeHash: `0x${string}`;
  fromBlock: number;
  toBlock: number;
}

export interface LaneAdminEventScreeningOptions {
  chainRpcs: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Producer clock; must be at or after the pinned window end. */
  observedAtSec?: number;
}

interface ParsedLog {
  family: V9LaneAdminEventFamily;
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
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
 * One batch with at most one call; transport failures return null. Abort reasons
 * pass through unchanged so cancellation is never reported as a lane failure.
 */
async function readBatch(
  chainId: string,
  calls: readonly EvmRpcBatchCall[],
  options: { chainRpcs: Map<string, ChainRpcConfig>; signal?: AbortSignal; timeoutMs: number; observedHeadBlock: number },
): Promise<EvmRpcBatchDetailedResult | null> {
  try {
    return await fetchEvmRpcBatchDetailed(chainId, calls, {
      chainRpcs: options.chainRpcs,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      observedHeadBlock: options.observedHeadBlock,
    });
  } catch (error) {
    rethrowIfAborted(error, options.signal);
    return null;
  }
}

function parseLogEntry(
  value: unknown,
  lane: { address: string; fromBlock: number; toBlock: number },
): ParsedLog | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.address !== "string" || !ADDRESS_PATTERN.test(entry.address.toLowerCase())) return null;
  if (entry.address.toLowerCase() !== lane.address) return null;
  if (entry.removed === true) return null;
  if (!Array.isArray(entry.topics) || entry.topics.length === 0) return null;
  const topics: string[] = [];
  for (const topic of entry.topics) {
    if (typeof topic !== "string" || !BYTES32_PATTERN.test(topic)) return null;
    topics.push(topic);
  }
  const family = TOPIC0_BY_FAMILY.get(topics[0]!);
  if (family === undefined) return null;
  if (typeof entry.data !== "string" || entry.data.length % 2 !== 0 || !HEX_BYTES_PATTERN.test(entry.data)) return null;
  if (typeof entry.blockHash !== "string" || !BYTES32_PATTERN.test(entry.blockHash)) return null;
  if (typeof entry.transactionHash !== "string" || !BYTES32_PATTERN.test(entry.transactionHash)) return null;
  const blockNumber = hexQuantity(entry.blockNumber);
  const logIndex = hexQuantity(entry.logIndex);
  if (blockNumber === null || logIndex === null || logIndex >= 1_000_000) return null;
  if (blockNumber < lane.fromBlock || blockNumber > lane.toBlock) return null;
  return {
    family,
    address: lane.address,
    topics,
    data: entry.data,
    blockNumber,
    blockHash: entry.blockHash,
    transactionHash: entry.transactionHash,
    logIndex,
  };
}

function parseTarget(target: LaneAdminEventScreeningTarget): { chainId: string; address: string; expectedCodeHash: string } {
  if (!isWellFormedDeploymentId(target.deploymentKey)) {
    throw new TypeError(`Lane screening requires a normalized deployment id: ${target.deploymentKey}`);
  }
  for (const [label, value] of [["fromBlock", target.fromBlock], ["toBlock", target.toBlock]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Lane screening ${label} must be a non-negative safe integer`);
  }
  if (target.toBlock < target.fromBlock) throw new TypeError("Lane screening block range must end at or after its start");
  if (typeof target.expectedCodeHash !== "string" || !BYTES32_PATTERN.test(target.expectedCodeHash.toLowerCase())) {
    throw new TypeError("Lane screening requires a 32-byte reviewed code hash");
  }
  const separator = target.deploymentKey.indexOf(":");
  return {
    chainId: target.deploymentKey.slice(0, separator),
    address: target.deploymentKey.slice(separator + 1),
    expectedCodeHash: target.expectedCodeHash.toLowerCase(),
  };
}

/**
 * Screen one exact lane contract over a pinned finalized block range.
 *
 * Fail-closed outcomes (never a certificate): unsupported chain, unavailable
 * RPC, unpinned or future-dated range end, pruned or budget-exhausted log read,
 * malformed log/header data, absent lane code, and observed/reviewed code-hash
 * mismatch. The certificate itself is the C3 wire shape, `evidenceClass`
 * `explorer-events`, with the observed `codeHash` and `logDigest`.
 */
export async function screenLaneAdminEvents(
  target: LaneAdminEventScreeningTarget,
  options: LaneAdminEventScreeningOptions,
): Promise<V9LaneIncidentScreeningResult> {
  const observedAtSec = options.observedAtSec ?? Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(observedAtSec) || observedAtSec < 0) {
    throw new TypeError("Lane screening producer clock must be a non-negative integer");
  }
  const { chainId, address, expectedCodeHash } = parseTarget(target);
  const deploymentKey = target.deploymentKey;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const readOptions = { chainRpcs: options.chainRpcs, signal: options.signal, timeoutMs };

  const chain = options.chainRpcs.get(chainId);
  if (!chain || chain.type !== "evm") return failedResult(deploymentKey, "unsupported-chain", observedAtSec, `chain:${chainId}`);
  if (!ADDRESS_PATTERN.test(address)) return failedResult(deploymentKey, "unsupported-chain", observedAtSec, "non-evm-address");

  throwIfAborted(options.signal);
  const finalized = await fetchEvmBlockHeader(chainId, "finalized", readOptions);
  if (!finalized) return failedResult(deploymentKey, "rpc-unavailable", observedAtSec, "finalized-head-unavailable");
  if (target.toBlock > finalized.number) {
    return failedResult(deploymentKey, "non-finalized-head", observedAtSec, `to-block:${target.toBlock}>finalized:${finalized.number}`);
  }

  const pinCalls: EvmRpcBatchCall[] = [{
    method: "eth_getBlockByNumber",
    params: [toBlockTag(target.fromBlock), false],
  }];
  if (target.toBlock !== target.fromBlock) {
    pinCalls.push({ method: "eth_getBlockByNumber", params: [toBlockTag(target.toBlock), false] });
  }
  pinCalls.push({ method: "eth_getCode", params: [address, toBlockTag(target.toBlock)] });

  const pin = await readBatch(chainId, pinCalls, { ...readOptions, observedHeadBlock: finalized.number });
  if (!pin) return failedResult(deploymentKey, "rpc-unavailable", observedAtSec, "block-range-pin-unavailable");
  const fromHeader = parseBlockHeader(pin.results[0], target.fromBlock);
  const toHeader = target.toBlock === target.fromBlock
    ? fromHeader
    : parseBlockHeader(pin.results[1], target.toBlock);
  const codeIndex = pinCalls.length - 1;
  const codeError = pin.errors.find((error) => error.index === codeIndex);
  const fromError = pin.errors.find((error) => error.index === 0);
  const toError = target.toBlock === target.fromBlock
    ? undefined
    : pin.errors.find((error) => error.index === 1);
  if (fromError || toError) {
    const error = fromError ?? toError!;
    return failedResult(deploymentKey, rpcErrorReason(error), observedAtSec, `header:${error.code ?? "?"}:${error.message ?? ""}`);
  }
  if (!fromHeader || !toHeader) return failedResult(deploymentKey, "rpc-unavailable", observedAtSec, "malformed-block-header");
  if (toHeader.timestamp < fromHeader.timestamp) {
    return failedResult(deploymentKey, "rpc-unavailable", observedAtSec, "window-clock-inversion");
  }
  if (toHeader.timestamp > observedAtSec) {
    return failedResult(deploymentKey, "non-finalized-head", observedAtSec, "window-end-in-future");
  }
  if (codeError) {
    return failedResult(deploymentKey, rpcErrorReason(codeError), observedAtSec, `code:${codeError.code ?? "?"}:${codeError.message ?? ""}`);
  }
  const code = pin.results[codeIndex];
  if (code === "0x") return failedResult(deploymentKey, "missing-controller", observedAtSec, "no-runtime-code");
  if (typeof code !== "string" || code.length % 2 !== 0 || !/^0x[0-9a-f]+$/u.test(code)) {
    return failedResult(deploymentKey, "rpc-unavailable", observedAtSec, "malformed-runtime-code");
  }
  const observedCodeHash = keccak256(code as `0x${string}`);
  if (observedCodeHash !== expectedCodeHash) {
    return failedResult(deploymentKey, "code-hash-mismatch", observedAtSec, `observed:${observedCodeHash}`);
  }

  const eligible = usableCcipRpcEndpoints(chainId, options.chainRpcs, {
    kind: "logs",
    fromBlock: target.fromBlock,
    toBlock: target.fromBlock,
    observedHeadBlock: finalized.number,
  });
  if (eligible.length === 0) {
    return failedResult(deploymentKey, "pruned-range", observedAtSec, "range-outside-retained-logs");
  }
  const declaredSpan = eligible[0]?.maxLogBlockSpan;
  if (declaredSpan !== undefined && (!Number.isSafeInteger(declaredSpan) || declaredSpan < 1)) {
    return failedResult(deploymentKey, "rpc-unavailable", observedAtSec, "invalid-log-span");
  }

  const logs: ParsedLog[] = [];
  let pageSpan = declaredSpan ?? LANE_ADMIN_EVENT_DEFAULT_LOG_PAGE_BLOCKS;
  let cursor = target.fromBlock;
  let pages = 0;
  let lastBlockNumber = -1;
  let lastLogIndex = -1;
  let sawRangeRefusal = false;
  while (cursor <= target.toBlock) {
    throwIfAborted(options.signal);
    if (pages >= LANE_ADMIN_EVENT_MAX_LOG_PAGES) {
      return failedResult(
        deploymentKey,
        sawRangeRefusal ? "pruned-range" : "rpc-unavailable",
        observedAtSec,
        "log-read-budget-exhausted",
      );
    }
    const end = Math.min(target.toBlock, cursor + pageSpan - 1);
    pages += 1;
    const batch = await readBatch(chainId, [{
      method: "eth_getLogs",
      params: [{
        address,
        fromBlock: toBlockTag(cursor),
        toBlock: toBlockTag(end),
        topics: [SCREENED_TOPIC0S],
      }],
    }], { ...readOptions, observedHeadBlock: finalized.number });
    if (!batch) return failedResult(deploymentKey, "rpc-unavailable", observedAtSec, `log-page:${cursor}-${end}`);

    const error = batch.errors[0];
    if (error) {
      const narrowable = end > cursor && pages < LANE_ADMIN_EVENT_MAX_LOG_PAGES;
      if ((error.code === -32005 || isRangeMessage(error.message)) && narrowable) {
        sawRangeRefusal = true;
        pageSpan = Math.max(1, Math.floor(pageSpan / 2));
        continue;
      }
      return failedResult(deploymentKey, rpcErrorReason(error), observedAtSec, `log-error:${error.code ?? "?"}:${error.message ?? ""}`);
    }

    const raw = batch.results[0];
    if (!Array.isArray(raw)) return failedResult(deploymentKey, "rpc-unavailable", observedAtSec, "malformed-log-result");
    if (raw.length > LANE_ADMIN_EVENT_MAX_EVENTS_PER_PAGE) {
      if (end > cursor && pages < LANE_ADMIN_EVENT_MAX_LOG_PAGES) {
        sawRangeRefusal = true;
        pageSpan = Math.max(1, Math.floor(pageSpan / 2));
        continue;
      }
      return failedResult(deploymentKey, "rpc-unavailable", observedAtSec, "log-page-capacity");
    }

    const pageLogs: ParsedLog[] = [];
    for (const value of raw) {
      const log = parseLogEntry(value, { address, fromBlock: cursor, toBlock: end });
      if (!log) return failedResult(deploymentKey, "rpc-unavailable", observedAtSec, `malformed-log-entry:${cursor}-${end}`);
      pageLogs.push(log);
    }
    pageLogs.sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex);
    for (const log of pageLogs) {
      const position = log.blockNumber * 1_000_000 + log.logIndex;
      if (position <= lastBlockNumber * 1_000_000 + lastLogIndex) {
        return failedResult(deploymentKey, "rpc-unavailable", observedAtSec, `log-duplicate:${log.blockNumber}:${log.logIndex}`);
      }
      lastBlockNumber = log.blockNumber;
      lastLogIndex = log.logIndex;
      logs.push(log);
      if (logs.length > LANE_ADMIN_EVENT_MAX_MATERIAL_EVENTS) {
        return failedResult(deploymentKey, "rpc-unavailable", observedAtSec, "material-event-capacity");
      }
    }
    cursor = end + 1;
  }

  const eventCounts: Partial<Record<V9LaneAdminEventFamily, number>> = {};
  for (const topic of LANE_ADMIN_EVENT_TOPICS) eventCounts[topic.family] = 0;
  for (const log of logs) eventCounts[log.family] = (eventCounts[log.family] ?? 0) + 1;

  const logDigest = sha256Hex(stableJsonStringifyV1({
    domain: "safety-score-v9.lane-admin-event-log.v1",
    evidenceClass: V9_LANE_SCREENING_EVIDENCE_CLASS,
    deploymentKey,
    codeHash: observedCodeHash,
    screeningPolicyDigest: LANE_ADMIN_EVENT_SCREENING_POLICY_DIGEST,
    fromBlock: target.fromBlock,
    toBlock: target.toBlock,
    fromBlockHash: fromHeader.hash,
    fromBlockTimestamp: fromHeader.timestamp,
    toBlockHash: toHeader.hash,
    toBlockTimestamp: toHeader.timestamp,
    finalizedHeadNumber: finalized.number,
    finalizedHeadHash: finalized.hash,
    logs: logs.map((log) => ({
      family: log.family,
      address: log.address,
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
    certificateId: `lane-cert:${chainId}:${address}:${target.fromBlock}-${target.toBlock}:${logDigest.slice(0, 12)}`,
    evidenceClass: V9_LANE_SCREENING_EVIDENCE_CLASS,
    deploymentKey,
    codeHash: observedCodeHash,
    fromBlock: target.fromBlock,
    toBlock: target.toBlock,
    windowStartSec: fromHeader.timestamp,
    windowEndSec: toHeader.timestamp,
    observedAtSec,
    screeningPolicyDigest: LANE_ADMIN_EVENT_SCREENING_POLICY_DIGEST,
    logDigest,
    screenedTopics: LANE_ADMIN_EVENT_TOPICS.map((topic) => ({ family: topic.family, topic0: topic.topic0 })),
    eventCounts,
    finding: logs.length > 0 ? "material-event" : "no-material-admin-event",
    ...(logs.length === 0 ? {} : {
      materialEvents: logs.map((log) => ({
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
