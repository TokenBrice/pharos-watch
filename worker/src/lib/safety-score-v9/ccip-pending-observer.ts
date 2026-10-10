import { z } from "zod";
import { decodeAbiParameters, encodeAbiParameters, keccak256, parseAbiParameters, toFunctionSelector, toHex } from "viem/utils";
import { CcipPendingCheckpointSchema, CcipPendingReadSchema, type CcipPendingCheckpoint, type CcipPendingRead, type EconomicSupplyObservation } from "@shared/types/safety-score-v9-supply-attribution";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { rethrowIfAborted, throwIfAborted } from "../abort";
import { CCIP_MONAD_CANONICAL_HASH_ARCHIVE_REQUIRED_REASON, type ChainRpcConfig } from "../chain-registry";
import { getCache, setCache } from "../db-cache";
import { fetchEvmBlockHeader, fetchEvmRpcBatch, type EvmBlockHeader } from "../evm-rpc";
import { fetchJsonWithRetry } from "../fetch-retry";
import type { SupplyAttributionAttemptDiagnostic } from "@shared/types/safety-score-v9-supply-attribution";
import { emitSupplyAttributionDiagnostic } from "./supply-attribution-diagnostics";

// ABI authorities: CCIP 1.5 commit 5e7b2096586bc32c6e975fc13f4c411eb687f833
// and CCIP 1.6 commit 2114b90f39c82c052e05af7c33d42c1ae98f4180, Internal.sol.
// CCIP 2.0 MessageV1Codec/OnRamp/OffRamp: d0e9ff9e116e3fb60b61d00d41aae7e98886ffe6.
const MESSAGE_15 = "(uint64 sourceChainSelector,address sender,address receiver,uint64 sequenceNumber,uint256 gasLimit,bool strict,uint64 nonce,address feeToken,uint256 feeTokenAmount,bytes data,(address token,uint256 amount)[] tokenAmounts,bytes[] sourceTokenData,bytes32 messageId)";
const MESSAGE_16 = "((bytes32 messageId,uint64 sourceChainSelector,uint64 destChainSelector,uint64 sequenceNumber,uint64 nonce) header,address sender,bytes data,bytes receiver,bytes extraArgs,address feeToken,uint256 feeTokenAmount,uint256 feeValueJuels,(address sourcePoolAddress,bytes destTokenAddress,bytes extraData,uint256 amount,bytes destExecData)[] tokenAmounts)";
const SEND_15 = keccak256(toHex("CCIPSendRequested((uint64,address,address,uint64,uint256,bool,uint64,address,uint256,bytes,(address,uint256)[],bytes[],bytes32))"));
const SEND_16 = keccak256(toHex("CCIPMessageSent(uint64,uint64,((bytes32,uint64,uint64,uint64,uint64),address,bytes,bytes,bytes,address,uint256,uint256,(address,bytes,bytes,uint256,bytes)[]))"));
const EXECUTION_15 = keccak256(toHex("ExecutionStateChanged(uint64,bytes32,uint8,bytes)"));
const EXECUTION_16 = keccak256(toHex("ExecutionStateChanged(uint64,uint64,bytes32,bytes32,uint8,bytes,uint256)"));
const SEND_20 = keccak256(toHex("CCIPMessageSent(uint64,address,bytes32,address,uint256,bytes,(address,uint32,uint32,uint256,bytes)[],bytes[])"));
const EXECUTION_20 = keccak256(toHex("ExecutionStateChanged(uint64,uint64,bytes32,uint8,bytes)"));
const WORD = /^0x[0-9a-f]{64}$/;
const HEX = /^0x[0-9a-f]*$/;
const PAGE_BLOCKS = 2000;
const PAGES_PER_ATTEMPT = 8;
const MAX_CHECKPOINT_BYTES = 128 * 1024;
const MAX_LOG_DATA_LENGTH = 32770;
const DISCOVERY_LIMIT = 1;
const API_BASE = "https://api.ccip.chain.link/v2";
type Lane = CcipPendingRead["lanes"][number];
type Message = CcipPendingCheckpoint["lanes"][number]["messages"][number];
type Proof = NonNullable<EconomicSupplyObservation["ccipPendingProof"]>;
const LogSchema = z.object({
  address: z.string().regex(/^0x[0-9a-f]{40}$/), topics: z.array(z.string().regex(WORD)).max(4),
  data: z.string().regex(HEX).refine(value => value.length % 2 === 0).transform(value => value as `0x${string}`),
  blockNumber: z.string().regex(/^0x[0-9a-f]+$/).max(18),
  blockHash: z.string().regex(WORD), transactionHash: z.string().regex(WORD),
  logIndex: z.string().regex(/^0x[0-9a-f]+$/).max(18), removed: z.literal(false),
});
type Log = z.infer<typeof LogSchema>;
const ReceiptSchema = z.object({
  transactionHash: z.string().regex(WORD), blockHash: z.string().regex(WORD),
  blockNumber: z.string().regex(/^0x[0-9a-f]+$/).max(18),
  status: z.literal("0x1"), logs: z.array(z.unknown()).max(1024),
});
const DiscoverySchema = z.object({ data: z.array(z.object({ messageId: z.string().regex(WORD) })).max(DISCOVERY_LIMIT) });
const DiscoveryDetailSchema = z.object({
  onramp: z.string().regex(/^0x[0-9a-f]{40}$/i).transform(value => value.toLowerCase()),
  sendTransactionHash: z.string().regex(WORD),
});
const LogHeaderSchema = z.object({ number: z.string().regex(/^0x[0-9a-f]+$/), hash: z.string().regex(WORD) });
const word = (value: string) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
const addressWord = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;
const call = (signature: string, args: `0x${string}` = "0x") => toFunctionSelector(signature) + args.slice(2);
const nextSequenceCall = (lane: Lane) => lane.version === "2.0.0" ? call("getExpectedNextMessageNumber(uint64)", encodeAbiParameters(parseAbiParameters("uint64"), [BigInt(lane.destination.chainSelector)]))
  : lane.version === "1.6" ? call("getExpectedNextSequenceNumber(uint64)", encodeAbiParameters(parseAbiParameters("uint64"), [BigInt(lane.destination.chainSelector)])) : call("getExpectedNextSequenceNumber()");
function fail(reason: string): never { throw new Error(`ccip-pending:${reason}`); }
function asLog(raw: unknown, envelopeOnly = false): Log {
  const parsed = LogSchema.safeParse(raw);
  if (!parsed.success) throw new CcipLogInvalidError("asLog-schema", raw);
  if (!envelopeOnly && parsed.data.data.length > MAX_LOG_DATA_LENGTH) throw new CcipLogInvalidError("asLog-payload-cap", raw);
  const row = parsed.data;
  return row;
}
class CcipLogInvalidError extends Error {
  readonly operands: NonNullable<SupplyAttributionAttemptDiagnostic["operands"]>;
  constructor(readonly predicate: string, raw: unknown) {
    super("ccip-pending:log-invalid");
    const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    this.operands = { address: typeof row.address === "string" ? row.address.slice(0, 256) : null, topicCount: Array.isArray(row.topics) ? row.topics.length : null, topic0: Array.isArray(row.topics) && typeof row.topics[0] === "string" ? row.topics[0].slice(0, 256) : null, dataLength: typeof row.data === "string" ? row.data.length : null, blockNumber: typeof row.blockNumber === "string" ? row.blockNumber.slice(0, 80) : null, transactionHash: typeof row.transactionHash === "string" ? row.transactionHash.slice(0, 80) : null, logIndex: typeof row.logIndex === "string" ? row.logIndex.slice(0, 80) : null, removed: typeof row.removed === "boolean" ? row.removed : null };
  }
}
function decodeSend(log: Log, lane: Lane): { sequence: bigint; messageId: string; amount: bigint } {
  if (log.address !== lane.onRampAddress) fail("send-address-mismatch");
  let sequence: bigint, messageId: string, amount = 0n;
  if (lane.version === "2.0.0") {
    if (log.topics.length !== 4 || log.topics[0] !== SEND_20 ||
      BigInt(log.topics[1]!) !== BigInt(lane.destination.chainSelector)) fail("send-lane-mismatch");
    const [, , encoded] = decodeAbiParameters(parseAbiParameters("address,uint256,bytes,(address,uint32,uint32,uint256,bytes)[],bytes[]"), log.data);
    const body = encoded.slice(2);
    let offset = 0;
    const take = (bytes: number) => {
      if (offset + bytes * 2 > body.length) fail("message-codec-invalid");
      const value = body.slice(offset, offset + bytes * 2);
      offset += bytes * 2;
      return value;
    };
    const variable = (lengthBytes: number) => take(Number.parseInt(take(lengthBytes), 16));
    if (take(1) !== "01") fail("message-codec-version");
    const sourceSelector = BigInt(`0x${take(8)}`), destSelector = BigInt(`0x${take(8)}`);
    sequence = BigInt(`0x${take(8)}`);
    take(44); // execution gas, callback gas, finality, verifier/executor commitment.
    const onRamp = `0x${variable(1)}`, offRamp = `0x${variable(1)}`, sender = `0x${variable(1)}`;
    const receiver = variable(1);
    variable(2); // destination blob
    const tokenTransfer = variable(2);
    variable(2); // application data
    messageId = keccak256(encoded);
    if (offset !== body.length || sourceSelector !== BigInt(lane.source.chainSelector) ||
      destSelector !== BigInt(lane.destination.chainSelector) || onRamp !== addressWord(lane.onRampAddress) ||
      offRamp !== lane.offRampAddress || sender !== log.topics[2] || receiver.length !== 40 ||
      messageId !== log.topics[3]) fail("message-codec-identity");
    if (tokenTransfer.length > 0) {
      let tokenOffset = 0;
      const tokenTake = (bytes: number) => {
        if (tokenOffset + bytes * 2 > tokenTransfer.length) fail("token-codec-invalid");
        const value = tokenTransfer.slice(tokenOffset, tokenOffset + bytes * 2);
        tokenOffset += bytes * 2;
        return value;
      };
      const tokenVariable = (lengthBytes: number) => tokenTake(Number.parseInt(tokenTake(lengthBytes), 16));
      if (tokenTake(1) !== "01") fail("token-codec-version");
      const tokenAmount = BigInt(`0x${tokenTake(32)}`);
      const sourcePool = `0x${tokenVariable(1)}`, sourceToken = `0x${tokenVariable(1)}`;
      const destToken = `0x${tokenVariable(1)}`, tokenReceiver = tokenVariable(1);
      tokenVariable(2);
      if (tokenOffset !== tokenTransfer.length || tokenReceiver.length !== 40) fail("token-codec-invalid");
      if (sourcePool === addressWord(lane.source.tokenPoolAddress)) {
        if (sourceToken !== addressWord(lane.source.tokenAddress) || destToken !== lane.destination.tokenAddress) fail("token-mapping-mismatch");
        amount = tokenAmount; // Actual amount owed after any source-pool fee.
      }
    }
  } else if (lane.version === "1.6") {
    if (log.topics.length !== 3 || log.topics[0] !== SEND_16 || BigInt(log.topics[1]!) !== BigInt(lane.destination.chainSelector)) fail("send-lane-mismatch");
    const [message] = decodeAbiParameters(parseAbiParameters(MESSAGE_16), log.data);
    sequence = message.header.sequenceNumber; messageId = message.header.messageId;
    if (message.header.sourceChainSelector !== BigInt(lane.source.chainSelector) ||
      message.header.destChainSelector !== BigInt(lane.destination.chainSelector) || sequence !== BigInt(log.topics[2]!)) fail("send-lane-mismatch");
    for (const token of message.tokenAmounts) {
      if (token.sourcePoolAddress.toLowerCase() !== lane.source.tokenPoolAddress) continue;
      if (token.destTokenAddress.toLowerCase() !== addressWord(lane.destination.tokenAddress)) fail("token-mapping-mismatch");
      amount += token.amount;
    }
  } else {
    if (log.topics.length !== 1 || log.topics[0] !== SEND_15) fail("send-lane-mismatch");
    const [message] = decodeAbiParameters(parseAbiParameters(MESSAGE_15), log.data);
    sequence = message.sequenceNumber; messageId = message.messageId;
    if (message.sourceChainSelector !== BigInt(lane.source.chainSelector) || message.tokenAmounts.length !== message.sourceTokenData.length) fail("send-lane-mismatch");
    for (let i = 0; i < message.tokenAmounts.length; i++) {
      const token = message.tokenAmounts[i]!;
      if (token.token.toLowerCase() !== lane.source.tokenAddress) continue;
      const [data] = decodeAbiParameters(parseAbiParameters("(bytes sourcePoolAddress,bytes destTokenAddress,bytes extraData,uint32 destGasAmount)"), message.sourceTokenData[i]!);
      if (data.sourcePoolAddress.toLowerCase() !== addressWord(lane.source.tokenPoolAddress)) continue;
      if (data.destTokenAddress.toLowerCase() !== addressWord(lane.destination.tokenAddress)) fail("token-mapping-mismatch");
      amount += token.amount;
    }
  }
  if (sequence === 0n || !WORD.test(messageId) || messageId === word("0")) fail("send-invalid");
  return { sequence, messageId, amount };
}
function decodeExecution(log: Log, lane: Lane): { sequence: string; messageId: string; state: number } {
  if (log.address !== lane.offRampAddress) fail("execution-address-mismatch");
  if (lane.version === "2.0.0") {
    if (log.topics.length !== 4 || log.topics[0] !== EXECUTION_20 ||
      BigInt(log.topics[1]!) !== BigInt(lane.source.chainSelector)) fail("execution-lane-mismatch");
    const [state] = decodeAbiParameters(parseAbiParameters("uint8,bytes"), log.data);
    if (state !== 2 && state !== 3) fail("execution-state-invalid");
    return { sequence: BigInt(log.topics[2]!).toString(), messageId: log.topics[3]!, state };
  }
  if (lane.version === "1.6") {
    if (log.topics.length !== 4 || log.topics[0] !== EXECUTION_16 || BigInt(log.topics[1]!) !== BigInt(lane.source.chainSelector)) fail("execution-lane-mismatch");
    const [, state] = decodeAbiParameters(parseAbiParameters("bytes32,uint8,bytes,uint256"), log.data);
    if (state !== 2 && state !== 3) fail("execution-state-invalid");
    return { sequence: BigInt(log.topics[2]!).toString(), messageId: log.topics[3]!, state };
  }
  if (log.topics.length !== 3 || log.topics[0] !== EXECUTION_15) fail("execution-lane-mismatch");
  const [state] = decodeAbiParameters(parseAbiParameters("uint8,bytes"), log.data);
  if (state !== 2 && state !== 3) fail("execution-state-invalid");
  return { sequence: BigInt(log.topics[1]!).toString(), messageId: log.topics[2]!, state };
}

/** Discovery is deliberately not a census. Consecutive OnRamp logs complete
 * omissions; finalized OffRamp state proves absence of SUCCESS (including a
 * historical attempt preceding the first checkpoint). SUCCESS is terminal in
 * the reviewed runtimes. FAILURE is still owed, never discarded. */
export async function observeCcipPending(input: {
  source: CcipPendingRead; headers: ReadonlyMap<string, EvmBlockHeader>; clockSec: number;
  chainRpcs: Map<string, ChainRpcConfig>; signal?: AbortSignal; db?: D1Database;
  checkpoint?: CcipPendingCheckpoint;
  onDiagnostic?: (diagnostic: SupplyAttributionAttemptDiagnostic) => void;
}): Promise<
  | { status: "accepted"; amount: string; proof: Proof; responseSha256: string; checkpoint: CcipPendingCheckpoint }
  | { status: "rejected"; reason: string; checkpoint?: CcipPendingCheckpoint }
> {
  const options = { chainRpcs: input.chainRpcs, signal: input.signal, excludeSupplementalRpc: true, maxRetries: 0 };
  let checkpoint: CcipPendingCheckpoint | undefined;
  let context: Partial<SupplyAttributionAttemptDiagnostic> = {};
  const emit = (detail: Partial<SupplyAttributionAttemptDiagnostic>) => emitSupplyAttributionDiagnostic(input.onDiagnostic, { observer: "ccip", sourceId: input.source.sourceId, ...context, ...detail });
  const savedCursors = new Map<string, number>();
  try {
    if (!CcipPendingReadSchema.safeParse(input.source).success) fail("source-invalid");
    const sourceDigest = sha256Hex(stableJsonStringifyV1(input.source));
    const cacheKey = `safety-score-v9:ccip-pending:v1:${sourceDigest}`;
    const policy = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution;
    const chains = [...new Set(input.source.lanes.flatMap(lane => [lane.source.chainId, lane.destination.chainId]))];
    for (const chain of chains) {
      const pin = input.headers.get(chain);
      context = { chainId: chain, pinObservedAtSec: pin?.timestamp ?? null, method: "eth_getBlockByNumber", phase: "pin-authentication", operands: { scoringClockSec: input.clockSec, pinNumber: pin?.number ?? null } };
      if (!pin || !Number.isSafeInteger(input.clockSec) || pin.timestamp > input.clockSec || input.clockSec - pin.timestamp > policy.observationMaxAgeSec) fail("pin-stale-or-future");
      const finalized = await fetchEvmBlockHeader(chain, "finalized", options);
      const canonical = await fetchEvmBlockHeader(chain, pin.number, options);
      context = { ...context, finalizedLagBlocks: finalized ? Math.max(0, pin.number - finalized.number) : null, operands: { scoringClockSec: input.clockSec, pinNumber: pin.number, finalizedNumber: finalized?.number ?? null, finalizedObservedAtSec: finalized?.timestamp ?? null } };
      emit({});
      if (!finalized || finalized.number < pin.number || !canonical || canonical.hash !== pin.hash || canonical.timestamp !== pin.timestamp) fail("pin-not-finalized");
    }
    if (Math.max(...chains.map(chain => input.headers.get(chain)!.timestamp)) - Math.min(...chains.map(chain => input.headers.get(chain)!.timestamp)) > policy.observationMaxSkewSec) fail("pin-skew");
    const cached = input.db && !input.checkpoint ? await getCache(input.db, cacheKey, input.signal) : null;
    if ((cached && cached.value.length > MAX_CHECKPOINT_BYTES) ||
      (input.checkpoint && stableJsonStringifyV1(input.checkpoint).length > MAX_CHECKPOINT_BYTES)) fail("checkpoint-capacity");
    // Old lane-serial checkpoints are not admitted by the shared-page scheduler.
    // Bootstrap afresh rather than interpreting their partial roster as complete.
    const decoded: unknown = input.checkpoint ?? (cached ? JSON.parse(cached.value) : null);
    if (decoded !== null && !(typeof decoded === "object" && "schemaVersion" in decoded && decoded.schemaVersion === 1)) {
      const parsed = CcipPendingCheckpointSchema.safeParse(decoded);
      if (!parsed.success || parsed.data.sourceDigest !== sourceDigest || parsed.data.nextChainIndex >= chains.length ||
        parsed.data.lanes.length > input.source.lanes.length || parsed.data.lanes.some((lane, i) => lane.id !== input.source.lanes[i]!.id)) fail("checkpoint-invalid");
      checkpoint = parsed.data;
    } else {
      checkpoint = { schemaVersion: 2, sourceDigest, nextChainIndex: 0, lanes: [] };
    }
    // Repeated migrated lanes share exact immutable, hash-pinned reads within
    // this attempt. Never reuse runtime/state authentication across attempts.
    const pinnedReads = new Map<string, unknown>();
    const rpc = async (chain: string, requests: Parameters<typeof fetchEvmRpcBatch>[1]) => {
      const keys = requests.map(request => {
        const block = request.params[1];
        return (request.method === "eth_call" || request.method === "eth_getCode") &&
          block !== null && typeof block === "object" && "blockHash" in block && "requireCanonical" in block && block.requireCanonical === true
          ? `${chain}:${stableJsonStringifyV1(request)}` : null;
      });
      const values: unknown[] = [], missing: Parameters<typeof fetchEvmRpcBatch>[1][number][] = [], positions: number[] = [];
      for (let i = 0; i < requests.length; i++) {
        const key = keys[i]!;
        if (key !== null && pinnedReads.has(key)) values[i] = pinnedReads.get(key);
        else { missing.push(requests[i]!); positions.push(i); }
      }
      if (missing.length > 0) {
        context = { ...context, chainId: chain, method: missing[0]?.method ?? "unknown", phase: "rpc", providerOrigin: null };
        const result = await fetchEvmRpcBatch(chain, missing, options);
        if (!result || result.length !== missing.length || result.some(value => value === undefined || value === null)) fail(chain === "monad" && missing.some(request => (request.method === "eth_call" || request.method === "eth_getCode") && request.params[1] !== null && typeof request.params[1] === "object" && "blockHash" in request.params[1]) ? CCIP_MONAD_CANONICAL_HASH_ARCHIVE_REQUIRED_REASON : "rpc-unavailable");
        for (let i = 0; i < result.length; i++) {
          const position = positions[i]!, key = keys[position]!;
          values[position] = result[i];
          if (key !== null) pinnedReads.set(key, result[i]);
        }
      }
      return values;
    };
    const identityHeaders = new Map<string, EvmBlockHeader>(chains.map(chain => {
      const pin = input.headers.get(chain)!;
      return [`${chain}:${pin.number}`, pin] as const;
    }));
    const identityHeader = async (chain: string, number: number) => {
      const key = `${chain}:${number}`, cached = identityHeaders.get(key);
      if (cached) return cached;
      const header = await fetchEvmBlockHeader(chain, number, options);
      if (header) identityHeaders.set(key, header);
      return header;
    };
    const discoveryBodies = new Map<string, unknown>();
    const discover = async (url: string, maxResponseBytes: number) => {
      if (discoveryBodies.has(url)) return discoveryBodies.get(url);
      context = { ...context, method: "ccip-discovery", phase: "discovery", providerOrigin: new URL(url).origin };
      const response = await fetchJsonWithRetry<unknown>(url, { signal: input.signal }, 0, { maxResponseBytes, timeoutMs: 10000 });
      if (response) discoveryBodies.set(url, response.body);
      return response?.body;
    };
    const persistCheckpoint = async () => {
      if (!input.db) return;
      const saved = stableJsonStringifyV1(checkpoint);
      if (saved.length > MAX_CHECKPOINT_BYTES) fail("checkpoint-capacity");
      await setCache(input.db, cacheKey, saved, input.signal);
      for (let i = 0; i < checkpoint!.lanes.length; i++) {
        const cp = checkpoint!.lanes[i]!, lane = input.source.lanes[i]!;
        for (const [name, cursor, side, start] of [["sent", cp.sent, lane.source, lane.sourceStartBlock], ["executed", cp.executed, lane.destination, input.headers.get(lane.destination.chainId)!.number + 1]] as const) {
          const key = `${lane.id}:${name}`, before = savedCursors.get(key) ?? start, target = input.headers.get(side.chainId)!.number + 1;
          if (cursor.nextBlock === before) continue;
          emit({ laneId: lane.id, chainId: side.chainId, method: "eth_getLogs", phase: "authenticated-prefix-persisted", beforeCursor: String(before), afterCursor: String(cursor.nextBlock), targetCursor: String(target), pinObservedAtSec: input.headers.get(side.chainId)!.timestamp, persisted: true, authenticatedCursorAdvanced: cursor.nextBlock > before, incompleteBootstrap: checkpoint!.lanes.length < input.source.lanes.length || checkpoint!.lanes.some((row, j) => row.sent.nextBlock < input.headers.get(input.source.lanes[j]!.source.chainId)!.number + 1 || row.executed.nextBlock < input.headers.get(input.source.lanes[j]!.destination.chainId)!.number + 1) });
          savedCursors.set(key, cursor.nextBlock);
        }
      }
    };
    const state = async (lane: Lane, messages: readonly Pick<Message, "sequence" | "messageId">[]) => {
      const pin = input.headers.get(lane.destination.chainId)!;
      const values: number[] = [];
      for (let from = 0; from < messages.length; from += 32) {
        const rows = messages.slice(from, from + 32);
        const result = await rpc(lane.destination.chainId, rows.map(message => ({ method: "eth_call", params: [{ to: lane.offRampAddress,
          data: lane.version === "2.0.0" ? call("getExecutionState(bytes32)", encodeAbiParameters(parseAbiParameters("bytes32"), [message.messageId as `0x${string}`]))
            : lane.version === "1.6" ? call("getExecutionState(uint64,uint64)", encodeAbiParameters(parseAbiParameters("uint64,uint64"), [BigInt(lane.source.chainSelector), BigInt(message.sequence)])) : call("getExecutionState(uint64)", encodeAbiParameters(parseAbiParameters("uint64"), [BigInt(message.sequence)])),
        }, { blockHash: pin.hash, requireCanonical: true }] })));
        for (const value of result) {
          if (typeof value !== "string" || !WORD.test(value) || ![0n, 2n, 3n].includes(BigInt(value))) fail("execution-state-invalid");
          values.push(Number(BigInt(value)));
        }
      }
      return values;
    };
    let discoveryDigest = sha256Hex("ccip-indexer-discovery-v2");
    const proofs: Proof["lanes"] = [];
    for (let i = 0; i < input.source.lanes.length; i++) {
      const lane = input.source.lanes[i]!, sourcePin = input.headers.get(lane.source.chainId)!, destPin = input.headers.get(lane.destination.chainId)!;
      context = { laneId: lane.id, chainId: lane.source.chainId, pinObservedAtSec: sourcePin.timestamp, phase: "lane-authentication" };
      if (sourcePin.number < lane.sourceStartBlock) fail("pin-before-deployment");
      for (const [side, ramp, rampHash] of [[lane.source, lane.onRampAddress, lane.onRampRuntimeCodeSha256], [lane.destination, lane.offRampAddress, lane.offRampRuntimeCodeSha256]] as const) {
        const pin = input.headers.get(side.chainId)!, block = { blockHash: pin.hash, requireCanonical: true };
        const code = await rpc(side.chainId, [ramp, side.tokenPoolAddress].map(address => ({ method: "eth_getCode", params: [address, block] })));
        if (code.some((value, index) => typeof value !== "string" || value === "0x" || !HEX.test(value) || sha256Hex(value) !== (index === 0 ? rampHash : side.tokenPoolRuntimeCodeSha256))) fail("runtime-mismatch");
        const remote = side === lane.source ? lane.destination : lane.source;
        const args = encodeAbiParameters(parseAbiParameters("uint64"), [BigInt(remote.chainSelector)]);
        let peerBlock = block;
        if (side.peerBindingPin) {
          const binding = await identityHeader(side.chainId, side.peerBindingPin.number);
          if (!binding || binding.number > pin.number || binding.timestamp > pin.timestamp ||
            binding.hash !== side.peerBindingPin.hash) fail("peer-binding-pin-invalid");
          peerBlock = { blockHash: binding.hash, requireCanonical: true };
          const [historicalCode] = await rpc(side.chainId, [{ method: "eth_getCode", params: [side.tokenPoolAddress, peerBlock] }]);
          if (typeof historicalCode !== "string" || sha256Hex(historicalCode) !== side.tokenPoolRuntimeCodeSha256) fail("peer-binding-runtime-mismatch");
        }
        const token = await rpc(side.chainId, [
          { method: "eth_call", params: [{ to: side.tokenPoolAddress, data: call("getToken()") }, block] },
          { method: "eth_call", params: [{ to: side.tokenAddress, data: call("decimals()") }, block] },
          { method: "eth_call", params: [{ to: side.tokenPoolAddress, data: call("getRemoteToken(uint64)", args) }, peerBlock] },
          { method: "eth_call", params: [{ to: side.tokenPoolAddress, data: call("getRemotePools(uint64)", args) }, peerBlock] },
        ]);
        if (token[0] !== addressWord(side.tokenAddress) || token[1] !== word(String(side.decimals)) ||
          typeof token[2] !== "string" || typeof token[3] !== "string") fail("pool-token-mismatch");
        const [remoteToken] = decodeAbiParameters(parseAbiParameters("bytes"), token[2] as `0x${string}`);
        const [remotePools] = decodeAbiParameters(parseAbiParameters("bytes[]"), token[3] as `0x${string}`);
        if (remoteToken.toLowerCase() !== addressWord(remote.tokenAddress) || !remotePools.some(pool => pool.toLowerCase() === addressWord(remote.tokenPoolAddress))) fail("pool-peer-mismatch");
      }
      const sourceConfig = await rpc(lane.source.chainId, [{ method: "eth_call", params: [{ to: lane.onRampAddress, data: call("getStaticConfig()") }, { blockHash: sourcePin.hash, requireCanonical: true }] }]);
      if (typeof sourceConfig[0] !== "string") fail("lane-identity-mismatch");
      if (lane.version === "2.0.0") {
        const [row] = decodeAbiParameters(parseAbiParameters("(uint64 chainSelector,address rmnRemote,uint32 maxUSDCentsPerMessage,address tokenAdminRegistry)"), sourceConfig[0] as `0x${string}`);
        if (row.chainSelector !== BigInt(lane.source.chainSelector)) fail("lane-identity-mismatch");
      } else if (lane.version === "1.6") {
        const [row] = decodeAbiParameters(parseAbiParameters("(uint64 chainSelector,address rmnRemote,address nonceManager,address tokenAdminRegistry)"), sourceConfig[0] as `0x${string}`);
        if (row.chainSelector !== BigInt(lane.source.chainSelector)) fail("lane-identity-mismatch");
      } else {
        const [row] = decodeAbiParameters(parseAbiParameters("(address linkToken,uint64 chainSelector,uint64 destChainSelector,uint64 defaultTxGasLimit,uint96 maxNopFeesJuels,address prevOnRamp,address rmnProxy,address tokenAdminRegistry)"), sourceConfig[0] as `0x${string}`);
        if (row.chainSelector !== BigInt(lane.source.chainSelector) || row.destChainSelector !== BigInt(lane.destination.chainSelector)) fail("lane-identity-mismatch");
      }
      // OffRamp state is keyed by lane sequence, not token: authenticate the
      // OnRamp binding before admitting even an untouched zero-state message.
      const destinationBlock = { blockHash: destPin.hash, requireCanonical: true };
      const config = await rpc(lane.destination.chainId, [{ method: "eth_call", params: [{ to: lane.offRampAddress, data: lane.version !== "1.5"
        ? call("getSourceChainConfig(uint64)", encodeAbiParameters(parseAbiParameters("uint64"), [BigInt(lane.source.chainSelector)])) : call("getStaticConfig()") }, destinationBlock] }]);
      if (typeof config[0] !== "string" || !HEX.test(config[0])) fail("lane-identity-mismatch");
      if (lane.version === "2.0.0") {
        const [row] = decodeAbiParameters(parseAbiParameters("(address router,bool isEnabled,bytes[] onRamps,address[] defaultCCVs,address[] laneMandatedCCVs)"), config[0] as `0x${string}`);
        if (!row.onRamps.some(onRamp => onRamp.toLowerCase() === addressWord(lane.onRampAddress))) fail("lane-identity-mismatch");
        const [staticConfig] = await rpc(lane.destination.chainId, [{ method: "eth_call", params: [{ to: lane.offRampAddress, data: call("getStaticConfig()") }, destinationBlock] }]);
        if (typeof staticConfig !== "string") fail("lane-identity-mismatch");
        const [identity] = decodeAbiParameters(parseAbiParameters("(uint64 localChainSelector,uint16 gasForCallExactCheck,address rmnRemote,address tokenAdminRegistry,uint32 maxGasBufferToUpdateState)"), staticConfig as `0x${string}`);
        if (identity.localChainSelector !== BigInt(lane.destination.chainSelector)) fail("lane-identity-mismatch");
      } else if (lane.version === "1.6") {
        const [row] = decodeAbiParameters(parseAbiParameters("(address router,bool isEnabled,uint64 minSeqNr,bool isRMNVerificationDisabled,bytes onRamp)"), config[0] as `0x${string}`);
        if (row.onRamp.toLowerCase() !== addressWord(lane.onRampAddress)) fail("lane-identity-mismatch");
      } else {
        const [row] = decodeAbiParameters(parseAbiParameters("(address commitStore,uint64 chainSelector,uint64 sourceChainSelector,address onRamp,address prevOffRamp,address rmnProxy,address tokenAdminRegistry)"), config[0] as `0x${string}`);
        if (row.chainSelector !== BigInt(lane.destination.chainSelector) || row.sourceChainSelector !== BigInt(lane.source.chainSelector) || row.onRamp.toLowerCase() !== lane.onRampAddress) fail("lane-identity-mismatch");
      }
      const nextCall = nextSequenceCall(lane);
      const initializing = !checkpoint.lanes[i];
      if (initializing) {
        const previous = await identityHeader(lane.source.chainId, lane.sourceStartBlock - 1);
        if (!previous) fail("history-unavailable");
        const block = { blockHash: previous.hash, requireCanonical: true };
        const code = await rpc(lane.source.chainId, [lane.onRampAddress, lane.source.tokenPoolAddress].map(address => ({ method: "eth_getCode", params: [address, block] })));
        if (code[0] !== "0x" && code[1] !== "0x") fail("history-start-unproved");
        let initialSequence = "1";
        if (code[0] !== "0x") {
          const next = await rpc(lane.source.chainId, [{ method: "eth_call", params: [{ to: lane.onRampAddress, data: nextCall }, block] }]);
          if (typeof next[0] !== "string" || !WORD.test(next[0]) || BigInt(next[0]) < 1n || BigInt(next[0]) >= 2n ** 64n) fail("send-census-mismatch");
          initialSequence = BigInt(next[0]).toString();
        }
        checkpoint.lanes.push({ id: lane.id, initialSequence, lastSequence: (BigInt(initialSequence) - 1n).toString(), messages: [],
          sent: { nextBlock: lane.sourceStartBlock, anchor: previous.number, anchorHash: previous.hash,
            digest: sha256Hex(stableJsonStringifyV1({ domain: "ccip-send-history-v1", previous, initialSequence, code })) },
          // A pinned exhaustive state read, not a negative indexer/log claim,
          // supplies the initial destination baseline. Later logs scan deltas.
          executed: { nextBlock: destPin.number + 1, anchor: destPin.number, anchorHash: destPin.hash, digest: sha256Hex(stableJsonStringifyV1(destPin)) },
        });
      }
      const cp = checkpoint.lanes[i]!;
      if (BigInt(cp.initialSequence) < 1n || BigInt(cp.lastSequence) < BigInt(cp.initialSequence) - 1n ||
        new Set(cp.messages.map(message => message.sequence)).size !== cp.messages.length ||
        new Set(cp.messages.map(message => message.messageId)).size !== cp.messages.length ||
        cp.messages.some(message => BigInt(message.sequence) < BigInt(cp.initialSequence) ||
          BigInt(message.sequence) > BigInt(cp.lastSequence) || message.sourceBlock < lane.sourceStartBlock ||
          message.sourceBlock >= cp.sent.nextBlock)) fail("checkpoint-invalid");
      for (const [cursor, side, pin] of [[cp.sent, lane.source, sourcePin], [cp.executed, lane.destination, destPin]] as const) {
        if (cursor.nextBlock > pin.number + 1 || (cursor.anchor === null) !== (cursor.anchorHash === null) ||
          (cursor.anchor === null ? cursor !== cp.sent || cursor.nextBlock !== lane.sourceStartBlock : cursor.nextBlock !== cursor.anchor + 1) || cp.sent.nextBlock < lane.sourceStartBlock) fail("history-gap");
        if (cursor.anchor !== null) {
          const anchor = await identityHeader(side.chainId, cursor.anchor);
          if (!anchor || anchor.hash !== cursor.anchorHash) fail("checkpoint-reorg");
        }
      }
      savedCursors.set(`${lane.id}:sent`, cp.sent.nextBlock);
      savedCursors.set(`${lane.id}:executed`, cp.executed.nextBlock);
      const discovery = DiscoverySchema.safeParse(await discover(`${API_BASE}/messages?sourceChainSelector=${lane.source.chainSelector}&destChainSelector=${lane.destination.chainSelector}&sourceTokenAddress=${lane.source.tokenAddress}&limit=${DISCOVERY_LIMIT}`, 128 * 1024));
      if (!discovery.success) fail("indexer-unavailable");
      discoveryDigest = sha256Hex(stableJsonStringifyV1({ previous: discoveryDigest, lane: lane.id, discovery: discovery.data }));
      for (const discovered of discovery.data.data) {
        const identity = DiscoveryDetailSchema.safeParse(await discover(`${API_BASE}/messages/${discovered.messageId}`, 64 * 1024));
        if (!identity.success) fail("indexer-invalid");
        if (identity.data.onramp !== lane.onRampAddress) continue; // Another history, never this lane's evidence.
        const tx = identity.data.sendTransactionHash;
        const [receipt] = await rpc(lane.source.chainId, [{ method: "eth_getTransactionReceipt", params: [tx] }]);
        const parsed = ReceiptSchema.safeParse(receipt);
        if (!parsed.success || parsed.data.transactionHash !== tx) fail("indexer-send-unproved");
        const row = parsed.data, height = Number(BigInt(row.blockNumber));
        const found = row.logs.some(raw => {
          if (!raw || typeof raw !== "object" || !("address" in raw) || typeof raw.address !== "string" || raw.address.toLowerCase() !== lane.onRampAddress) return false;
          const log = asLog(raw);
          if (log.topics[0] !== (lane.version === "2.0.0" ? SEND_20 : lane.version === "1.6" ? SEND_16 : SEND_15)) return false;
          const message = decodeSend(log, lane);
          return log.transactionHash === tx && log.blockNumber === row.blockNumber && log.blockHash === row.blockHash && message.messageId === discovered.messageId && message.amount > 0n;
        });
        if (!found) fail("indexer-send-unproved");
        if (height <= sourcePin.number) {
          const header = await identityHeader(lane.source.chainId, height);
          if (!header || header.hash !== row.blockHash) fail("indexer-send-unproved");
        }
      }
      // Bootstrap is durable before authenticating the next lane. A later
      // cancellation can resume this prefix, never admit it as a census.
      if (initializing) await persistCheckpoint();
    }
    type Scan = { lane: Lane; cp: CcipPendingCheckpoint["lanes"][number]; sent: boolean; topic: `0x${string}` };
    const scansByChain = chains.map(chain => input.source.lanes.flatMap((lane, i): Scan[] => {
      const cp = checkpoint!.lanes[i]!, scans: Scan[] = [];
      if (lane.source.chainId === chain) scans.push({ lane, cp, sent: true,
        topic: lane.version === "2.0.0" ? SEND_20 : lane.version === "1.6" ? SEND_16 : SEND_15 });
      if (lane.destination.chainId === chain) scans.push({ lane, cp, sent: false,
        topic: lane.version === "2.0.0" ? EXECUTION_20 : lane.version === "1.6" ? EXECUTION_16 : EXECUTION_15 });
      return scans;
    }));
    let pages = 0, idleChains = 0;
    const narrowedSpans = new Map<string, number>();
    while (pages < PAGES_PER_ATTEMPT && idleChains < chains.length) {
      throwIfAborted(input.signal);
      const chainIndex = checkpoint.nextChainIndex, chain = chains[chainIndex]!, pin = input.headers.get(chain)!;
      context = { chainId: chain, laneId: null, pinObservedAtSec: pin.timestamp, method: "eth_getLogs", phase: "history-page" };
      checkpoint.nextChainIndex = (chainIndex + 1) % chains.length;
      const backlog = scansByChain[chainIndex]!.filter(scan => (scan.sent ? scan.cp.sent : scan.cp.executed).nextBlock <= pin.number);
      if (backlog.length === 0) { idleChains++; continue; }
      idleChains = 0;
      let declaredSpan: number | undefined;
      for (const endpoint of input.chainRpcs.get(chain)?.endpoints ?? []) {
        if (endpoint.position !== "registry" || endpoint.operator === "dwellir" ||
          endpoint.logsHistory !== "full" || endpoint.maxLogBlockSpan === undefined) continue;
        if (!Number.isSafeInteger(endpoint.maxLogBlockSpan) || endpoint.maxLogBlockSpan < 1) fail("rpc-log-span-invalid");
        declaredSpan = Math.max(declaredSpan ?? endpoint.maxLogBlockSpan, endpoint.maxLogBlockSpan);
      }
      // The RPC transport skips endpoints whose own declaration cannot fit this
      // interval; a narrow primary must not constrain a reviewed wider fallback.
      const pageBlocks = Math.min(narrowedSpans.get(chain) ?? Infinity, declaredSpan ?? PAGE_BLOCKS);
      // One physical log page covers every participating lane/side on this chain.
      // Later cursors never rescan their prefix; they join when the oldest reaches them.
      const from = Math.min(...backlog.map(scan => (scan.sent ? scan.cp.sent : scan.cp.executed).nextBlock));
      const end = Math.min(pin.number, from + pageBlocks - 1);
      const scans = backlog.filter(scan => (scan.sent ? scan.cp.sent : scan.cp.executed).nextBlock <= end);
      const addresses = [...new Set(scans.map(scan => scan.sent ? scan.lane.onRampAddress : scan.lane.offRampAddress))];
      const topics = [...new Set(scans.map(scan => scan.topic))];
      const endHeader = await fetchEvmBlockHeader(chain, end, options);
      if (!endHeader) fail("history-unavailable");
      const result = await fetchEvmRpcBatch(chain, [{ method: "eth_getLogs", params: [{ address: addresses, topics: [topics],
        fromBlock: `0x${from.toString(16)}`, toBlock: `0x${end.toString(16)}` }] }], options);
      const raw = result?.[0];
      // Provider/body/result caps never advance a cursor. Subdivision consumes
      // the same eight-attempt budget, preserving wall/connection ceilings.
      if ((!Array.isArray(raw) || raw.length > 2048) && end > from) {
        narrowedSpans.set(chain, Math.max(1, Math.floor(pageBlocks / 10)));
        checkpoint.nextChainIndex = chainIndex;
        pages++;
        continue;
      }
      if (!Array.isArray(raw) || raw.length > 2048) fail("history-capacity");
      const logs = raw.map(log => asLog(log, true)), blockHashes = new Map<string, string>();
      let previousPosition = -1;
      for (const log of logs) {
        const height = Number(BigInt(log.blockNumber)), index = Number(BigInt(log.logIndex)), position = height * 1000000 + index;
        if (!Number.isSafeInteger(position) || height < from || height > end || index >= 1000000 || position <= previousPosition) fail("history-gap");
        previousPosition = position;
        if (!addresses.includes(log.address) || !topics.includes(log.topics[0] as `0x${string}`)) fail("log-filter-mismatch");
        const topicCount = log.topics[0] === SEND_15 ? 1 : log.topics[0] === EXECUTION_15 || log.topics[0] === SEND_16 ? 3 : 4;
        if (log.topics.length !== topicCount) throw new CcipLogInvalidError("topic-count", log);
        const previous = blockHashes.get(log.blockNumber);
        if (previous !== undefined && previous !== log.blockHash) fail("event-anchor-mismatch");
        blockHashes.set(log.blockNumber, log.blockHash);
      }
      const blocks = [...blockHashes];
      for (let offset = 0; offset < blocks.length; offset += 32) {
        const chunk = blocks.slice(offset, offset + 32);
        const headers = await rpc(chain, chunk.map(([number]) => ({ method: "eth_getBlockByNumber", params: [number, false] })));
        if (headers.some((raw, j) => {
          const parsed = LogHeaderSchema.safeParse(raw);
          return !parsed.success || BigInt(parsed.data.number) !== BigInt(chunk[j]![0]) || parsed.data.hash !== chunk[j]![1];
        })) fail("event-anchor-mismatch");
      }
      for (const { lane, cp, sent, topic } of scans) {
        context = { ...context, laneId: lane.id, chainId: chain };
        const cursor = sent ? cp.sent : cp.executed, additions: Message[] = [];
        const laneLogs = logs.filter(log => {
          if (Number(BigInt(log.blockNumber)) < cursor.nextBlock ||
            log.address !== (sent ? lane.onRampAddress : lane.offRampAddress) ||
            log.topics[0] !== topic) return false;
          // Shared ramps also emit other directed lanes. Only our exact selector
          // is in this census; ABI/identity validation remains below.
          return lane.version === "1.5" || log.topics[1] === word(sent ? lane.destination.chainSelector : lane.source.chainSelector);
        });
        for (const log of laneLogs) {
          // Bound payloads only after exact directed-lane routing. A valid
          // foreign message on this shared ramp cannot poison our census.
          if (log.data.length > MAX_LOG_DATA_LENGTH) throw new CcipLogInvalidError("matched-payload-cap", log);
          if (sent) {
            const message = decodeSend(log, lane);
            if (message.sequence !== BigInt(cp.lastSequence) + 1n) fail("sequence-gap");
            cp.lastSequence = message.sequence.toString();
            if (message.amount > 0n) additions.push({ sequence: message.sequence.toString(), messageId: message.messageId, amount: message.amount.toString(), transactionHash: log.transactionHash,
              sourceBlock: Number(BigInt(log.blockNumber)), sourceBlockHash: log.blockHash, executionState: 0 });
          } else {
            const event = decodeExecution(log, lane), message = cp.messages.find(message => message.sequence === event.sequence);
            if (message && message.messageId !== event.messageId) fail("execution-message-mismatch");
            // Only finalized state, below, removes a liability; logs alone do not.
          }
        }
        const states = await state(lane, additions);
        additions.forEach((message, j) => { if (states[j] !== 2) cp.messages.push({ ...message, executionState: states[j] as 0 | 3 }); });
        if (cp.messages.length > 512) fail("checkpoint-capacity");
        cursor.digest = sha256Hex(stableJsonStringifyV1({ previous: cursor.digest, from: cursor.nextBlock, end, endHeader, logs: laneLogs }));
      }
      const rechecked = await fetchEvmBlockHeader(chain, end, options);
      if (!rechecked || rechecked.hash !== endHeader.hash) fail("history-reorg");
      for (const scan of scans) {
        const cursor = scan.sent ? scan.cp.sent : scan.cp.executed;
        cursor.nextBlock = end + 1; cursor.anchor = end; cursor.anchorHash = endHeader.hash;
      }
      pages++;
      await persistCheckpoint();
    }
    for (let i = 0; i < input.source.lanes.length; i++) {
      const lane = input.source.lanes[i]!, cp = checkpoint.lanes[i]!, sourcePin = input.headers.get(lane.source.chainId)!;
      const states = await state(lane, cp.messages);
      cp.messages = cp.messages.filter((message, j) => {
        if (message.executionState === 3 && states[j] === 0) fail("execution-state-regressed");
        if (states[j] === 2) return false;
        message.executionState = states[j] as 0 | 3;
        return true;
      });
      if (cp.sent.nextBlock === sourcePin.number + 1) {
        const [next] = await rpc(lane.source.chainId, [{ method: "eth_call", params: [{ to: lane.onRampAddress, data: nextSequenceCall(lane) }, { blockHash: sourcePin.hash, requireCanonical: true }] }]);
        if (typeof next !== "string" || !WORD.test(next) || BigInt(next) !== BigInt(cp.lastSequence) + 1n) fail("send-census-mismatch");
      }
      let amount = cp.messages.reduce((sum, message) => sum + BigInt(message.amount), 0n);
      const decimalDifference = input.source.amountDecimals - lane.source.decimals;
      if (decimalDifference >= 0) amount *= 10n ** BigInt(decimalDifference);
      else {
        const divisor = 10n ** BigInt(-decimalDifference);
        if (amount % divisor !== 0n) fail("amount-precision-loss");
        amount /= divisor;
      }
      proofs.push({ id: lane.id, sourcePoolAddress: lane.source.tokenPoolAddress, destinationPoolAddress: lane.destination.tokenPoolAddress,
        sourceChainSelector: lane.source.chainSelector, destinationChainSelector: lane.destination.chainSelector,
        initialSequence: cp.initialSequence, lastSequence: cp.lastSequence, pendingCount: cp.messages.length,
        failedCount: cp.messages.filter(message => message.executionState === 3).length, amount: amount.toString() });
    }
    const serialized = stableJsonStringifyV1(checkpoint);
    if (serialized.length > MAX_CHECKPOINT_BYTES) fail("checkpoint-capacity");
    // Recheck every holding pin before final admission or incomplete return.
    for (const chain of chains) {
      const pin = input.headers.get(chain)!, rechecked = await fetchEvmBlockHeader(chain, pin.number, options);
      if (!rechecked || rechecked.hash !== pin.hash || rechecked.timestamp !== pin.timestamp) fail("pin-reorg");
    }
    if (input.db) await setCache(input.db, cacheKey, serialized, input.signal);
    if (checkpoint.lanes.length !== input.source.lanes.length || checkpoint.lanes.some((cp, i) => cp.sent.nextBlock !== input.headers.get(input.source.lanes[i]!.source.chainId)!.number + 1 || cp.executed.nextBlock !== input.headers.get(input.source.lanes[i]!.destination.chainId)!.number + 1)) {
      emit({ phase: "history-incomplete", incompleteBootstrap: true, failurePredicate: "history-incomplete" });
      return { status: "rejected", reason: "history-incomplete", checkpoint };
    }
    const amount = proofs.reduce((sum, lane) => sum + BigInt(lane.amount), 0n).toString();
    const proof: Proof = { sourceDigest, checkpointDigest: sha256Hex(serialized), discoveryDigest, lanes: proofs,
      pins: chains.map(chainId => { const pin = input.headers.get(chainId)!; return { chainId, anchor: pin.number, anchorHash: pin.hash, observedAtSec: pin.timestamp }; }) };
    return { status: "accepted", amount, proof, responseSha256: sha256Hex(stableJsonStringifyV1({ proof, amount })), checkpoint };
  } catch (error) {
    rethrowIfAborted(error, input.signal);
    const reason = error instanceof Error && error.message.startsWith("ccip-pending:") ? error.message.slice(13) : "rpc-unavailable";
    emit({ hardEvidenceFailure: true, failurePredicate: error instanceof CcipLogInvalidError ? error.predicate : reason, ...(error instanceof CcipLogInvalidError ? { operands: error.operands } : {}) });
    return { status: "rejected", reason: error instanceof Error && error.message.startsWith("ccip-pending:") ? error.message.slice(13) : "rpc-unavailable" };
  }
}

