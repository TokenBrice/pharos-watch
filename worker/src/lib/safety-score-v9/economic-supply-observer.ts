import { decodeAbiParameters, encodeAbiParameters, keccak256, parseAbiParameters, toFunctionSelector, toHex } from "viem/utils";
import { CHAIN_META } from "@shared/types/chain-identity";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { parseXrplIssuedCurrencyAmount } from "@shared/lib/deployment-amounts";
import { CurveLzPendingCheckpointSchema, type CurveLzPendingCheckpoint, type CurveLzPendingRead, type EconomicSupplyObservation, type EconomicSupplyReference, type ReviewedEconomicSupplyPlan, type ReviewedEconomicDeploymentPartition } from "@shared/types/safety-score-v9-supply-attribution";
import type { SupplyAttributionRejectionCode } from "@shared/lib/safety-score-v9-supply-attribution-journal";
import { rethrowIfAborted, throwIfAborted } from "../abort";
import { getRpcAuthHeaders, type ChainRpcConfig } from "../chain-registry";
import { getCache, setCache } from "../db-cache";
import { fetchEvmBlockHeader, fetchEvmBlockNumber, fetchEvmMulticall3Aggregate3AtBlock, fetchEvmRpcBatch, type EvmBlockHeader, type EvmMulticall3Call, type EvmMulticall3Result } from "../evm-rpc";
import { DECIMALS_SELECTOR, TOTAL_SUPPLY_SELECTOR } from "../evm-selectors";
import { getPublicRpcUrl } from "../public-rpc-registry";
import { decodeEvmUint256, fetchSafetyScoreV9SolanaRpc, rewindEvmBlockHeaderToScoringClock, type SafetyScoreV9SolanaRpcFetcher } from "./supply-observation-primitives";
import { buildReviewedEconomicDeploymentInventory, deriveReviewedEconomicDeploymentPartition, economicProviderSupplyContradictionChain, economicSupplyInputDeploymentObservation, economicSupplyInputReferencePrice, REVIEWED_ECONOMIC_SUPPLY_PLANS } from "./supply-attribution-contract";
import type { SafetyScoreV9SupplyAttributionInput } from "./supply-attribution-source";
import { observeEconomicCosmosBank, pinEconomicCosmosBank, type CosmosBankPin } from "./cosmos-bank-observer";
import { fetchMoveFungibleAssetSupply, fetchTonJettonSupply } from "../../cron/reserve-adapters/token-supply";
import { observeCcipPending } from "./ccip-pending-observer";

/** Finalized mint snapshot, case-preserved identity, pinned chronology and response hash. */
export async function observeEconomicSolanaMint(input: {
  address: string; decimals: number; programOwner?: string; clockSec: number;
  /** Economic accounting needs the exact context block; active transfer reads retain skipped-slot semantics. */
  requireExactContextSlot?: boolean;
  chainRpcs?: Map<string, ChainRpcConfig>; signal?: AbortSignal;
}, rpc?: SafetyScoreV9SolanaRpcFetcher): Promise<{ amount: string; slot: string; blockHash: string; observedAtSec: number; responseSha256: string } | null> {
  const read: SafetyScoreV9SolanaRpcFetcher = rpc ?? ((method, params, signal) => fetchSafetyScoreV9SolanaRpc(method, params, signal, input.chainRpcs));
  const account = await read<{ context?: { slot?: number }; value?: { owner?: string; data?: { parsed?: { type?: string; info?: { supply?: string; decimals?: number } } } } }>("getAccountInfo", [input.address, { commitment: "finalized", encoding: "jsonParsed" }], input.signal);
  const info = account?.value?.data?.parsed?.info;
  const slot = account?.context?.slot;
  const owner = account?.value?.owner;
  if (!Number.isSafeInteger(slot) || slot! < 0 || account?.value?.data?.parsed?.type !== "mint" || !info || typeof info.supply !== "string" || !/^(0|[1-9][0-9]*)$/.test(info.supply) || info.decimals !== input.decimals ||
    (owner !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" && owner !== "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") || (input.programOwner !== undefined && owner !== input.programOwner)) return null;
  const startSlot = input.requireExactContextSlot ? slot! : Math.max(0, slot! - 64);
  const slots = await read<number[]>("getBlocks", [startSlot, slot, { commitment: "finalized", minContextSlot: slot }], input.signal);
  if (!Array.isArray(slots)) return null;
  const anchor = input.requireExactContextSlot
    ? slots.length === 1 && slots[0] === slot ? slot! : null
    : slots.filter(value => Number.isSafeInteger(value) && value >= startSlot && value <= slot!)
      .reduce<number | null>((latest, value) => latest === null || value > latest ? value : latest, null);
  if (anchor === null) return null;
  const block = await read<{ blockTime?: number; blockhash?: string }>("getBlock", [anchor, { commitment: "finalized", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 }], input.signal);
  const policy = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution;
  if (!block || !Number.isInteger(block.blockTime) || block.blockTime! < 0 || block.blockTime! > input.clockSec || input.clockSec - block.blockTime! > policy.observationMaxAgeSec || typeof block.blockhash !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(block.blockhash)) return null;
  // Hash the score-bearing RPC response projection. Incidental rentEpoch is u64
  // and may be an unsafe JS number; it is neither quantity nor identity evidence.
  return { amount: info.supply, slot: `${slot}:${anchor}`, blockHash: block.blockhash, observedAtSec: block.blockTime!, responseSha256: sha256Hex(stableJsonStringifyV1({
    address: input.address, accountSlot: slot, owner, parsedType: account!.value!.data!.parsed!.type,
    supply: info.supply, decimals: info.decimals, blockSlot: anchor, blockTime: block.blockTime, blockhash: block.blockhash,
  })) };
}

async function readReviewedApiAmount(source: ReviewedEconomicSupplyPlan["conversionSources"][number], signal?: AbortSignal): Promise<EconomicSupplyReference | null> {
  const response = await fetch(source.url, { signal });
  const text = await response.text();
  if (!response.ok) return null;
  const body: unknown = JSON.parse(text);
  const field = (path: string[]) => path.reduce<unknown>((value, key) => value !== null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key) ? (value as Record<string, unknown>)[key] : undefined, body);
  const value = field(source.amountPath), observedAt = field(source.observedAtPath), generation = field(source.generationPath);
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored canonical unsigned-decimal shape; groups cannot overlap.
  if ((typeof value !== "string" && typeof value !== "number") || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(String(value)) || typeof observedAt !== "number" || !Number.isInteger(observedAt) || observedAt < 0 || typeof generation !== "string" || generation.length === 0) return null;
  return { sourceId: source.sourceId, sourceGeneration: generation, value: String(value), observedAtSec: observedAt, responseSha256: sha256Hex(text) };
}

const CURVE_HISTORY_PAGE_BLOCKS = 2000;
const CURVE_HISTORY_PAGES_PER_ATTEMPT = 8;
const CURVE_CHECKPOINT_MAX_BYTES = 128 * 1024;
const CURVE_WORD = /^0x[0-9a-f]{64}$/;
const CURVE_ADDRESS_WORD = /^0x0{24}[0-9a-f]{40}$/;
const CURVE_EVENT_TOPICS = ["Delayed", "Failed", "Issued"].map(name => keccak256(toHex(`${name}(uint64,address,uint256)`)));
const CURVE_PACKET_TOPIC = keccak256(toHex("Packet(bytes)"));
const CURVE_PACKET_SENT_TOPIC = keccak256(toHex("PacketSent(bytes,bytes,uint256,uint256)"));
const curvePayload = (receiver: string, amount: string) =>
  encodeAbiParameters(parseAbiParameters("address,uint256"), [receiver as `0x${string}`, BigInt(amount)]);
const curveCall = (signature: string, args: `0x${string}`) => toFunctionSelector(signature) + args.slice(2);

/**
 * Bounded producer-only history. Checkpoints contain unresolved raw messages,
 * never shares, and advance only after a complete successful inclusive page.
 * A review must cover EVERY historical send library; current defaults alone
 * cannot authorize this reader. No backdated or latest-state fallbacks.
 */
export async function observeCurveLzPending(input: {
  source: CurveLzPendingRead; headers: readonly EvmBlockHeader[];
  chainRpcs: Map<string, ChainRpcConfig>; signal?: AbortSignal;
  checkpoint?: CurveLzPendingCheckpoint; db?: D1Database;
}): Promise<
  | { status: "accepted"; amount: string; proof: NonNullable<EconomicSupplyObservation["curvePendingProof"]>; responseSha256: string; checkpoint: CurveLzPendingCheckpoint }
  | { status: "rejected"; reason: string; checkpoint?: CurveLzPendingCheckpoint }
> {
  const sourceDigest = sha256Hex(stableJsonStringifyV1(input.source));
  const cacheKey = `safety-score-v9:curve-lz-pending:v1:${sourceDigest}`;
  const options = { chainRpcs: input.chainRpcs, signal: input.signal };
  let checkpoint: CurveLzPendingCheckpoint | undefined;
  function fail(reason: string): never { throw new Error(`curve-pending:${reason}`); }
  try {
    if (input.headers.length !== 2) fail("pin-missing");
    const cached = input.db ? await getCache(input.db, cacheKey, input.signal) : null;
    const decoded = input.checkpoint ?? (cached ? JSON.parse(cached.value) as unknown : null);
    if (decoded !== null) {
      const parsed = CurveLzPendingCheckpointSchema.safeParse(decoded);
      if (!parsed.success || parsed.data.sourceDigest !== sourceDigest) fail("checkpoint-invalid");
      checkpoint = parsed.data;
    } else {
      const cursor = (nextBlock: number) => ({ nextBlock, anchor: null, anchorHash: null, digest: sha256Hex("curve-lz-history-v1") });
      checkpoint = { schemaVersion: 1, sourceDigest, directions: input.source.sides.map((side, i) => ({
        sent: cursor(side.deploymentBlock), received: cursor(input.source.sides[1 - i]!.deploymentBlock),
        sentNonce: "0", receivedNonce: "0", messages: [], recoveries: [],
      })) };
    }
    const cp = checkpoint!;
    // Validate finalized pins and the predecessor of every persisted cursor.
    for (let i = 0; i < 2; i++) {
      const side = input.source.sides[i]!, pin = input.headers[i]!;
      const finalized = await fetchEvmBlockHeader(side.chainId, "finalized", options);
      if (!finalized || finalized.number < pin.number || pin.number < side.deploymentBlock) fail("pin-not-finalized");
      for (const cursor of [cp.directions[i]!.sent, cp.directions[1 - i]!.received]) {
        if (cursor.nextBlock < side.deploymentBlock || cursor.nextBlock > pin.number + 1 ||
          (cursor.anchor === null) !== (cursor.anchorHash === null) ||
          (cursor.anchor === null ? cursor.nextBlock !== side.deploymentBlock : cursor.anchor !== cursor.nextBlock - 1)) fail("history-gap");
        if (cursor.anchor !== null) {
          const previous = await fetchEvmBlockHeader(side.chainId, cursor.anchor, options);
          if (!previous || previous.hash !== cursor.anchorHash) fail("checkpoint-reorg");
        }
      }
      const contracts = [
        { address: side.bridgeAddress, runtimeCodeSha256: side.bridgeRuntimeCodeSha256 },
        { address: side.endpointAddress, runtimeCodeSha256: side.endpointRuntimeCodeSha256 },
        side.outboundNonceRead, ...side.sendLibraries,
      ];
      const block = { blockHash: pin.hash, requireCanonical: true };
      const codes = await fetchEvmRpcBatch(side.chainId, contracts.map(row => ({ method: "eth_getCode", params: [row.address, block] })), options);
      if (!codes || codes.length !== contracts.length || codes.some((code, j) =>
        typeof code !== "string" || !/^0x[0-9a-f]+$/i.test(code) || code.length % 2 !== 0 ||
        sha256Hex(code.toLowerCase()) !== contracts[j]!.runtimeCodeSha256)) fail("runtime-mismatch");
      const remote = input.source.sides[1 - i]!;
      const identities = await fetchEvmRpcBatch(side.chainId, [
        { method: "eth_call", params: [{ to: side.bridgeAddress, data: toFunctionSelector("LZ_ENDPOINT()") }, block] },
        { method: "eth_call", params: [{ to: side.bridgeAddress, data: toFunctionSelector("LZ_CHAIN_ID()") }, block] },
      ], options);
      if (!identities || identities[0] !== `0x${side.endpointAddress.slice(2).padStart(64, "0")}` ||
        typeof identities[1] !== "string" || !CURVE_WORD.test(identities[1]) || BigInt(identities[1]) !== BigInt(remote.lzChainId)) fail("endpoint-identity");
    }
    let pages = 0;
    const scan = async (directionIndex: number, sent: boolean) => {
      const direction = cp.directions[directionIndex]!;
      const sideIndex = sent ? directionIndex : 1 - directionIndex;
      const side = input.source.sides[sideIndex]!, pin = input.headers[sideIndex]!;
      const cursor = sent ? direction.sent : direction.received;
      while (cursor.nextBlock <= pin.number && pages < CURVE_HISTORY_PAGES_PER_ATTEMPT) {
        throwIfAborted(input.signal);
        const from = cursor.nextBlock, end = Math.min(pin.number, from + CURVE_HISTORY_PAGE_BLOCKS - 1);
        const endHeader = await fetchEvmBlockHeader(side.chainId, end, options);
        if (!endHeader) fail("history-unavailable");
        const responses = await fetchEvmRpcBatch(side.chainId, [{
          method: "eth_getLogs", params: [{
            address: sent ? side.sendLibraries.map(row => row.address) : side.bridgeAddress,
            topics: [sent ? [CURVE_PACKET_TOPIC, CURVE_PACKET_SENT_TOPIC] : CURVE_EVENT_TOPICS],
            fromBlock: `0x${from.toString(16)}`, toBlock: `0x${end.toString(16)}`,
          }],
        }], options);
        const logs = responses?.[0];
        if (!Array.isArray(logs) || logs.length > 2048) fail("history-unavailable");
        let previousPosition = -1;
        for (const raw of logs as Array<Record<string, unknown>>) {
          const { address, topics, data, blockNumber, blockHash, transactionHash, logIndex, removed } = raw;
          if (typeof address !== "string" || !Array.isArray(topics) || topics.some(topic => typeof topic !== "string") ||
            typeof data !== "string" || !/^0x[0-9a-f]*$/i.test(data) || data.length % 2 !== 0 || data.length > 8194 ||
            typeof blockNumber !== "string" || !/^0x[0-9a-f]+$/i.test(blockNumber) ||
            typeof logIndex !== "string" || !/^0x[0-9a-f]+$/i.test(logIndex) ||
            typeof blockHash !== "string" || !CURVE_WORD.test(blockHash) ||
            typeof transactionHash !== "string" || !CURVE_WORD.test(transactionHash) || removed !== false) fail("log-invalid");
          const height = Number(BigInt(blockNumber as string)), index = Number(BigInt(logIndex as string));
          const position = height * 1_000_000 + index;
          if (!Number.isSafeInteger(position) || index >= 1_000_000 || height < from || height > end || position <= previousPosition) fail("history-gap");
          previousPosition = position;
          if (sent) {
            const library = side.sendLibraries.find(row => row.address === address);
            if (!library || topics.length !== 1) fail("log-invalid");
            const topic = library!.encoding === "packet-v1" ? CURVE_PACKET_TOPIC : CURVE_PACKET_SENT_TOPIC;
            if (topics[0] !== topic) fail("packet-encoding");
            const packet = library!.encoding === "packet-v1"
              ? decodeAbiParameters(parseAbiParameters("bytes"), data as `0x${string}`)[0]
              : decodeAbiParameters(parseAbiParameters("bytes,bytes,uint256,uint256"), data as `0x${string}`)[0];
            const body = packet.slice(2), remote = input.source.sides[1 - directionIndex]!;
            let nonce: bigint, payload: `0x${string}`;
            if (library!.encoding === "packet-v1") {
              // ULN v2 packed nonce/u16 source/address/u16 destination/address.
              if (body.length < 104) fail("packet-invalid");
              if (body.slice(20, 60) !== side.bridgeAddress.slice(2) ||
                Number.parseInt(body.slice(16, 20), 16) !== side.lzChainId ||
                Number.parseInt(body.slice(60, 64), 16) !== remote.lzChainId ||
                body.slice(64, 104) !== remote.bridgeAddress.slice(2)) continue;
              nonce = BigInt(`0x${body.slice(0, 16)}`); payload = `0x${body.slice(104)}`;
            } else {
              // ULN301 PacketV1Codec: version, nonce, u32 source, bytes32 sender,
              // u32 destination, bytes32 receiver, guid, 64-byte bridge payload.
              if (body.length < 226 || body.slice(0, 2) !== "01") fail("packet-invalid");
              if (body.slice(26, 90) !== side.bridgeAddress.slice(2).padStart(64, "0") ||
                Number.parseInt(body.slice(18, 26), 16) !== side.lzChainId ||
                Number.parseInt(body.slice(90, 98), 16) !== remote.lzChainId ||
                body.slice(98, 162) !== remote.bridgeAddress.slice(2).padStart(64, "0")) continue;
              nonce = BigInt(`0x${body.slice(2, 18)}`); payload = `0x${body.slice(226)}`;
              const guid = keccak256(`0x${body.slice(2, 26)}${side.bridgeAddress.slice(2)}${body.slice(90, 162)}`);
              if (guid !== `0x${body.slice(162, 226)}`) fail("packet-guid");
            }
            if (nonce <= BigInt(direction.sentNonce)) fail("replayed-nonce");
            if (nonce !== BigInt(direction.sentNonce) + 1n) fail("missing-nonce");
            if (payload.length !== 130 || !CURVE_ADDRESS_WORD.test(payload.slice(0, 66))) fail("packet-invalid");
            const [receiver, amount] = decodeAbiParameters(parseAbiParameters("address,uint256"), payload);
            if (amount === 0n || /^0x0{40}$/.test(receiver)) fail("packet-invalid");
            direction.messages.push({ nonce: nonce.toString(), receiver: receiver.toLowerCase(), amount: amount.toString(), transactionHash: transactionHash as string, state: "sent", timestamp: null });
            // recover() is unlogged at the application; authenticate its exact
            // consumed nonce from the transaction that emitted this packet.
            const txResult = await fetchEvmRpcBatch(side.chainId, [{ method: "eth_getTransactionByHash", params: [transactionHash] }], options);
            const tx = txResult?.[0] as { hash?: unknown; to?: unknown; input?: unknown } | undefined;
            if (!tx || tx.hash !== transactionHash || typeof tx.to !== "string" || typeof tx.input !== "string") fail("send-transaction-unavailable");
            if (tx.to.toLowerCase() === side.bridgeAddress && tx.input.startsWith(toFunctionSelector("recover(uint64,address,uint256)"))) {
              if (!side.supportsFailed || tx.input.length !== 202) fail("recovery-invalid");
              const [failedNonce, recoveredReceiver, recoveredAmount] = decodeAbiParameters(parseAbiParameters("uint64,address,uint256"), `0x${tx.input.slice(10)}`);
              if (recoveredReceiver.toLowerCase() !== receiver.toLowerCase() || recoveredAmount !== amount) fail("recovery-payload-mismatch");
              if (direction.recoveries.some(row => row.nonce === failedNonce.toString())) fail("replayed-recovery");
              direction.recoveries.push({ nonce: failedNonce.toString(), receiver: receiver.toLowerCase(), amount: amount.toString(), transactionHash: transactionHash as string });
            }
            direction.sentNonce = nonce.toString();
          } else {
            if (address !== side.bridgeAddress || topics.length !== 3 || !CURVE_EVENT_TOPICS.includes(topics[0]) ||
              !CURVE_WORD.test(topics[1]) || !CURVE_ADDRESS_WORD.test(topics[2]) || !CURVE_WORD.test(data as string)) fail("log-invalid");
            const nonce = BigInt(topics[1]).toString(), receiver = `0x${topics[2].slice(-40)}`;
            const message = direction.messages.find(row => row.nonce === nonce);
            if (!message || message.receiver !== receiver || message.amount !== BigInt(data as string).toString()) fail("replayed-or-missing-nonce");
            if (message.state === "sent") {
              if (BigInt(nonce) !== BigInt(direction.receivedNonce) + 1n) fail("missing-nonce");
              direction.receivedNonce = nonce;
            } else if (topics[0] !== CURVE_EVENT_TOPICS[2] || message.state !== "delayed") fail("replayed-nonce");
            if (topics[0] === CURVE_EVENT_TOPICS[2]) {
              direction.messages.splice(direction.messages.indexOf(message), 1);
            } else {
              if (topics[0] === CURVE_EVENT_TOPICS[1] && !side.supportsFailed) fail("unexpected-failed-event");
              const eventHeader = await fetchEvmBlockHeader(side.chainId, height, options);
              if (!eventHeader || eventHeader.hash !== blockHash) fail("event-anchor");
              message.state = topics[0] === CURVE_EVENT_TOPICS[0] ? "delayed" : "failed";
              message.timestamp = eventHeader!.timestamp;
            }
          }
          if (direction.messages.length > 512) fail("checkpoint-capacity");
        }
        const rechecked = await fetchEvmBlockHeader(side.chainId, end, options);
        if (!rechecked || rechecked.hash !== endHeader!.hash) fail("history-reorg");
        cursor.digest = sha256Hex(stableJsonStringifyV1({ previous: cursor.digest, from, end, header: endHeader, logs }));
        cursor.anchor = end; cursor.anchorHash = endHeader!.hash; cursor.nextBlock = end + 1; pages++;
      }
    };
    for (let i = 0; i < 2; i++) {
      await scan(i, true);
      if (cp.directions[i]!.sent.nextBlock <= input.headers[i]!.number) break;
      await scan(i, false);
      if (cp.directions[i]!.received.nextBlock <= input.headers[1 - i]!.number) break;
    }
    const complete = cp.directions.every((direction, i) =>
      direction.sent.nextBlock === input.headers[i]!.number + 1 && direction.received.nextBlock === input.headers[1 - i]!.number + 1);
    const serialized = stableJsonStringifyV1(cp);
    if (serialized.length > CURVE_CHECKPOINT_MAX_BYTES) fail("checkpoint-capacity");
    if (!complete) {
      if (input.db) await setCache(input.db, cacheKey, serialized, input.signal);
      return { status: "rejected", reason: "history-incomplete", checkpoint: cp };
    }
    let amount = 0n;
    for (let i = 0; i < 2; i++) {
      const direction = cp.directions[i]!, source = input.source.sides[i]!, destination = input.source.sides[1 - i]!;
      const sourceBlock = { blockHash: input.headers[i]!.hash, requireCanonical: true };
      const destinationBlock = { blockHash: input.headers[1 - i]!.hash, requireCanonical: true };
      const nonce = await fetchEvmRpcBatch(source.chainId, [{ method: "eth_call", params: [{ to: source.outboundNonceRead.address, data: source.outboundNonceRead.callData }, sourceBlock] }], options);
      if (!nonce || typeof nonce[0] !== "string" || !CURVE_WORD.test(nonce[0]) || BigInt(nonce[0]) !== BigInt(direction.sentNonce)) fail("send-census-mismatch");
      const recovered = new Set<string>();
      for (const message of direction.messages) {
        if (message.state !== "sent") {
          const args = encodeAbiParameters(parseAbiParameters("uint64"), [BigInt(message.nonce)]);
          const commitment = await fetchEvmRpcBatch(destination.chainId, [{
            method: "eth_call", params: [{ to: destination.bridgeAddress, data: curveCall(`${message.state}(uint64)`, args) }, destinationBlock],
          }], options);
          const payload = curvePayload(message.receiver, message.amount);
          const expected = message.state === "failed" ? keccak256(payload) :
            keccak256(encodeAbiParameters(parseAbiParameters("uint256,bytes"), [BigInt(message.timestamp!), payload]));
          if (commitment?.[0] === `0x${"0".repeat(64)}` && message.state === "failed") {
            const recovery = cp.directions[1 - i]!.recoveries.find(row => row.nonce === message.nonce);
            if (!recovery || recovery.receiver !== message.receiver || recovery.amount !== message.amount) fail("recovery-unproved");
            cp.directions[1 - i]!.recoveries.splice(cp.directions[1 - i]!.recoveries.indexOf(recovery!), 1);
            recovered.add(message.nonce);
            continue;
          }
          if (!commitment || commitment[0] !== expected) fail("commitment-mismatch");
        }
        amount += BigInt(message.amount);
      }
      direction.messages = direction.messages.filter(message => !recovered.has(message.nonce));
      // Endpoint inbound chronology authenticates sends not yet represented in
      // bridge events, including a stored/reverted endpoint payload.
      const path = `0x${source.bridgeAddress.slice(2)}${destination.bridgeAddress.slice(2)}` as `0x${string}`;
      const args = encodeAbiParameters(parseAbiParameters("uint16,bytes"), [source.lzChainId, path]);
      const inbound = await fetchEvmRpcBatch(destination.chainId, [{ method: "eth_call", params: [{ to: destination.endpointAddress, data: curveCall("getInboundNonce(uint16,bytes)", args) }, destinationBlock] }], options);
      if (!inbound || typeof inbound[0] !== "string" || !CURVE_WORD.test(inbound[0])) fail("inbound-unavailable");
      const inboundNonce = BigInt(inbound[0]), receivedNonce = BigInt(direction.receivedNonce);
      if (inboundNonce < receivedNonce || inboundNonce > BigInt(direction.sentNonce) || inboundNonce > receivedNonce + 1n) fail("delivery-census-mismatch");
      if (inboundNonce === receivedNonce + 1n) {
        const message = direction.messages.find(row => BigInt(row.nonce) === inboundNonce && row.state === "sent");
        const stored = await fetchEvmRpcBatch(destination.chainId, [{ method: "eth_call", params: [{ to: destination.endpointAddress, data: curveCall("storedPayload(uint16,bytes)", args) }, destinationBlock] }], options);
        if (!message || !stored || typeof stored[0] !== "string") fail("delivery-census-mismatch");
        const [length, receiver, hash] = decodeAbiParameters(parseAbiParameters("uint64,address,bytes32"), stored![0] as `0x${string}`);
        if (length !== 64n || receiver.toLowerCase() !== destination.bridgeAddress || hash !== keccak256(curvePayload(message!.receiver, message!.amount))) fail("stored-payload-mismatch");
      }
    }
    if (cp.directions.some(direction => direction.recoveries.length > 0)) fail("recovery-history-missing");
    for (let i = 0; i < 2; i++) {
      const pin = input.headers[i]!, header = await fetchEvmBlockHeader(input.source.sides[i]!.chainId, pin.number, options);
      if (!header || header.hash !== pin.hash || header.timestamp !== pin.timestamp) fail("pin-reorg");
    }
    const authenticated = stableJsonStringifyV1(cp);
    if (input.db) await setCache(input.db, cacheKey, authenticated, input.signal);
    const proof = { sourceDigest, checkpointDigest: sha256Hex(authenticated), pins: input.source.sides.map((side, i) => ({
      chainId: side.chainId, anchor: input.headers[i]!.number, anchorHash: input.headers[i]!.hash,
      observedAtSec: input.headers[i]!.timestamp, sentNonce: cp.directions[i]!.sentNonce, receivedNonce: cp.directions[1 - i]!.receivedNonce,
    })) };
    return { status: "accepted", amount: amount.toString(), proof, responseSha256: sha256Hex(stableJsonStringifyV1({ proof, amount: amount.toString() })), checkpoint: cp };
  } catch (error) {
    rethrowIfAborted(error, input.signal);
    return { status: "rejected", reason: error instanceof Error && error.message.startsWith("curve-pending:") ? error.message.slice(14) : "rpc-unavailable" };
  }
}

export type ReviewedEconomicSupplyObservationAttempt =
  | { status: "accepted"; attribution: ReviewedEconomicDeploymentPartition }
  | { status: "rejected"; rejectionCode: SupplyAttributionRejectionCode; failedRouteId: string | null; rejectedSourceObservedAtSec?: number | null };

/** Reads only the reviewed census. The aggregate is always copied from admitted source input. */
export async function observeReviewedEconomicDeploymentPartitionAttempt(input: {
  assetId: string; fixedInput: Readonly<SafetyScoreV9SupplyAttributionInput>; scoringClockSec: number; chainRpcs: Map<string, ChainRpcConfig>; signal?: AbortSignal; db?: D1Database;
}): Promise<ReviewedEconomicSupplyObservationAttempt> {
  let failedRouteId: string | null = null;
  try {
    if (!Number.isSafeInteger(input.scoringClockSec) || input.scoringClockSec < input.fixedInput.clockSec) {
      return { status: "rejected", rejectionCode: "packet-reconciliation-failed", failedRouteId: null };
    }
    const inventory = buildReviewedEconomicDeploymentInventory(input.assetId);
    const plan = REVIEWED_ECONOMIC_SUPPLY_PLANS.get(input.assetId);
    if (!inventory || !plan) return { status: "rejected", rejectionCode: "route-inventory-unavailable", failedRouteId: null };
    const aggregate = input.fixedInput.aggregateCirculatingById[input.assetId];
    const aggregateUsd = getCirculatingRawOrNull(aggregate ?? {});
    if (aggregateUsd === null || aggregate?.observedAtSec == null) return { status: "rejected", rejectionCode: "packet-reconciliation-failed", failedRouteId: null };
    const observations: EconomicSupplyObservation[] = [], inFlight: EconomicSupplyObservation[] = [], conversions: EconomicSupplyReference[] = [];
    const referencePrice: EconomicSupplyReference | null = plan.referencePriceSource
      ? await readReviewedApiAmount(plan.referencePriceSource, input.signal)
      : economicSupplyInputReferencePrice(input.fixedInput, input.assetId);
    if (!referencePrice || Number(referencePrice.value) <= 0) return { status: "rejected", rejectionCode: "packet-reconciliation-failed", failedRouteId: plan.sourceId };
    const headers = new Map<string, EvmBlockHeader>();
    const cosmosPins = new Map<string, CosmosBankPin>();
    const readCosmos = async (row: ReviewedEconomicSupplyPlan["deployments"][number], id: string, account?: string): Promise<EconomicSupplyObservation | null> => {
      if (row.read.kind !== "cosmos-bank-supply" || row.address !== row.read.denom) return null;
      const key = `${row.chainId}:${row.read.restUrl}`;
      let pin = cosmosPins.get(key);
      if (!pin) {
        const result = await pinEconomicCosmosBank({ source: row.read, chainId: row.chainId, clockSec: input.scoringClockSec, signal: input.signal });
        if (!result) return null;
        pin = result; cosmosPins.set(key, pin);
      }
      const result = await observeEconomicCosmosBank({ source: row.read, chainId: row.chainId, pin, clockSec: input.scoringClockSec, account, signal: input.signal });
      return result ? { id, deploymentKey: row.deploymentKey, ...result } : null;
    };
    const evmCallsByChain = new Map<string, EvmMulticall3Call[]>();
    const evmCallsById = new Map<string, readonly EvmMulticall3Call[]>();
    const evmResultsById = new Map<string, readonly EvmMulticall3Result[] | null>();
    const batchedChains = new Set<string>();
    const addEvmRead = (row: ReviewedEconomicSupplyPlan["deployments"][number], id: string, account?: string) => {
      if (CHAIN_META[row.chainId]?.type !== "evm" || row.address === null ||
        row.decimals === null || (row.holdingKind === "native-gas" && account !== undefined) ||
        (account !== undefined && !/^0x[0-9a-f]{40}$/.test(account))) return;
      const calls = evmCallsByChain.get(row.chainId) ?? [];
      const pair = [
        { label: id, target: row.address, callData: account === undefined ? TOTAL_SUPPLY_SELECTOR : `0x70a08231${account.slice(2).padStart(64, "0")}`, allowFailure: true },
        { label: `${id}:decimals`, target: row.address, callData: DECIMALS_SELECTOR, allowFailure: true },
      ];
      calls.push(...pair);
      evmCallsById.set(id, pair);
      evmCallsByChain.set(row.chainId, calls);
    };
    for (const row of plan.deployments) {
      if (row.read.kind === "evm-total-supply" || row.read.kind === "evm-balance") {
        addEvmRead(row, row.deploymentKey, row.read.kind === "evm-balance" ? row.read.account : undefined);
      }
    }
    for (const rule of [...plan.exclusions, ...plan.escrows.map(escrow => ({
      id: escrow.id, deploymentKey: escrow.canonicalDeploymentKey, account: escrow.account,
    }))]) {
      const row = plan.deployments.find(row => row.deploymentKey === rule.deploymentKey);
      if (row) addEvmRead(row, rule.id, rule.account);
    }
    const readEvm = async (row: ReviewedEconomicSupplyPlan["deployments"][number], id: string, account?: string): Promise<EconomicSupplyObservation | null> => {
      if (CHAIN_META[row.chainId]?.type !== "evm" || row.address === null) return null;
      let header = headers.get(row.chainId);
      if (!header) {
        const options = { chainRpcs: input.chainRpcs, signal: input.signal };
        const head = await fetchEvmBlockNumber(row.chainId, options);
        const lag = Math.max(...plan.deployments.filter(other => other.chainId === row.chainId).map(other =>
          "safeBlockLag" in other.read ? other.read.safeBlockLag : 0));
        if (head === null || lag <= 0 || head < lag) return null;
        const block = await rewindEvmBlockHeaderToScoringClock({
          initialBlockNumber: head - lag, scoringClockSec: input.scoringClockSec, signal: input.signal,
          fetchHeader: number => fetchEvmBlockHeader(row.chainId, number, options),
        });
        if (!block) return null;
        header = block; headers.set(row.chainId, header);
      }
      if (account !== undefined && !/^0x[0-9a-f]{40}$/.test(account)) return null;
      if (row.holdingKind === "native-gas" && account !== undefined) {
        const result = await fetchEvmRpcBatch(row.chainId, [{ method: "eth_getBalance", params: [account, { blockHash: header.hash, requireCanonical: true }] }], { chainRpcs: input.chainRpcs, signal: input.signal });
        const value = result?.[0];
        if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
        const wei = BigInt(value).toString().padStart(19, "0");
        const amount = `${wei.slice(0, -18)}.${wei.slice(-18)}`.replace(/0+$/, "").replace(/\.$/, "");
        return { id, deploymentKey: row.deploymentKey, amount, observedAtSec: header.timestamp, anchor: String(header.number), anchorHash: header.hash, responseSha256: sha256Hex(stableJsonStringifyV1({ result, header, account })) };
      }
      if (row.decimals === null) return null;
      if (!batchedChains.has(row.chainId)) {
        batchedChains.add(row.chainId);
        const calls = evmCallsByChain.get(row.chainId) ?? [];
        // The existing multicall helper chunks large censuses and consumes
        // each response before opening the next. All rows share this exact pin.
        const batch = await fetchEvmMulticall3Aggregate3AtBlock(row.chainId, calls, header.number, {
          chainRpcs: input.chainRpcs, signal: input.signal,
          stateBlockHash: header.hash, multicallFallbackBlockHash: header.hash,
        });
        for (let index = 0; index < calls.length; index += 2) {
          evmResultsById.set(calls[index].label, batch ? [batch[index], batch[index + 1]] : null);
        }
      }
      const calls = evmCallsById.get(id) ?? [];
      const results = evmResultsById.get(id);
      const value = results && decodeEvmUint256(results[0]), decimals = results && decodeEvmUint256(results[1]);
      if (value == null || decimals == null || decimals !== BigInt(row.decimals)) return null;
      return { id, deploymentKey: row.deploymentKey, amount: value.toString(), observedAtSec: header.timestamp, anchor: String(header.number), anchorHash: header.hash, responseSha256: sha256Hex(stableJsonStringifyV1({ calls, results, header })) };
    };
    const readPendingState = async (
      source: Extract<NonNullable<ReviewedEconomicSupplyPlan["escrows"][number]["inFlightSource"]>, { kind: "evm-pending-state" }>,
      escrow: ReviewedEconomicSupplyPlan["escrows"][number],
    ): Promise<EconomicSupplyObservation | null> => {
      const header = headers.get(source.chainId);
      if (!header) return null;
      const options = { chainRpcs: input.chainRpcs, signal: input.signal };
      const finalized = await fetchEvmBlockHeader(source.chainId, "finalized", options);
      if (!finalized || finalized.number < header.number) return null;
      // EIP-1898 binds every state read to the exact already-observed escrow
      // block hash. Unsupported hash-pinned reads reject; no latest fallback.
      const block = { blockHash: header.hash, requireCanonical: true };
      const state = await fetchEvmRpcBatch(source.chainId, [
        { method: "eth_getCode", params: [source.bridgeAddress, block] },
        { method: "eth_call", params: [{ to: source.bridgeAddress, data: source.messageCountSelector }, block] },
      ], options);
      if (!state || state.length !== 2 || typeof state[0] !== "string" ||
        !/^0x[0-9a-f]+$/i.test(state[0]) || state[0].length % 2 !== 0 ||
        sha256Hex(state[0].toLowerCase()) !== source.bridgeRuntimeCodeSha256 ||
        typeof state[1] !== "string" || !/^0x[0-9a-f]{64}$/i.test(state[1]) ||
        BigInt(state[1]) !== BigInt(source.messageIds.length)) return null;
      const calls = source.messageIds.flatMap((messageId, index) => [
        { method: "eth_call", params: [{ to: source.bridgeAddress, data: source.messageIdSelector + index.toString(16).padStart(64, "0") }, block] },
        { method: "eth_call", params: [{ to: source.bridgeAddress, data: source.pendingAmountSelector + messageId.slice(2) }, block] },
      ]);
      const messages = calls.length === 0 ? [] : await fetchEvmRpcBatch(source.chainId, calls, options);
      if (!messages || messages.length !== calls.length) return null;
      let amount = 0n;
      for (let index = 0; index < source.messageIds.length; index++) {
        const identity = messages[index * 2], value = messages[index * 2 + 1];
        if (typeof identity !== "string" || identity.toLowerCase() !== source.messageIds[index] ||
          typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) return null;
        amount += BigInt(value);
      }
      return { id: `in-flight:${escrow.id}`, deploymentKey: escrow.canonicalDeploymentKey,
        amount: amount.toString(), observedAtSec: header.timestamp, anchor: String(header.number), anchorHash: header.hash,
        responseSha256: sha256Hex(stableJsonStringifyV1({ source, state, calls, messages, header,
          sourceGeneration: input.fixedInput.sourceGeneration, baseInputGenerationId: input.fixedInput.baseInputGenerationId })) };
    };
    for (const row of plan.deployments) {
      throwIfAborted(input.signal); failedRouteId = row.routeId ?? row.deploymentKey;
      let observation: EconomicSupplyObservation | null = null;
      if (row.read.kind === "provider-chain" || row.read.kind === "native-from-aggregate") {
        observation = economicSupplyInputDeploymentObservation({ fixedInput: input.fixedInput, plan, row, referencePrice });
      } else if (row.read.kind === "cosmos-bank-supply") {
        observation = await readCosmos(row, row.deploymentKey);
      } else if (row.read.kind === "evm-total-supply" || row.read.kind === "evm-balance") {
        observation = await readEvm(row, row.deploymentKey, row.read.kind === "evm-balance" ? row.read.account : undefined);
      } else if (row.read.kind === "solana-mint" && row.chainId === "solana" && row.address !== null && row.decimals !== null) {
        const result = await observeEconomicSolanaMint({ address: row.address, decimals: row.decimals, programOwner: row.read.programOwner, clockSec: input.scoringClockSec, chainRpcs: input.chainRpcs, signal: input.signal, requireExactContextSlot: true });
        if (result) observation = { id: row.deploymentKey, deploymentKey: row.deploymentKey, amount: result.amount, observedAtSec: result.observedAtSec, anchor: result.slot, anchorHash: result.blockHash, responseSha256: result.responseSha256 };
      } else if (row.read.kind === "move-fa-supply" && ["aptos", "movement"].includes(row.chainId) && row.address !== null && row.decimals !== null) {
        const url = input.chainRpcs.get(row.chainId)?.endpoints[0]?.url ?? getPublicRpcUrl(row.chainId);
        if (url) {
          const result = await fetchMoveFungibleAssetSupply(row.address, input.signal ?? new AbortController().signal, url, undefined, {
            clockSec: input.scoringClockSec, expectedChainId: row.read.ledgerChainId,
            identityKind: row.read.identityKind, expectedMetadataAddress: row.read.metadataAddress, expectedDecimals: row.decimals,
          });
          if (result?.ledgerTimestampSec !== undefined && result.metadataAddress === row.read.metadataAddress && result.responseSha256) {
            observation = { id: row.deploymentKey, deploymentKey: row.deploymentKey, amount: result.rawSupply.toString(),
              observedAtSec: result.ledgerTimestampSec, anchor: result.ledgerVersion,
              anchorHash: result.responseSha256, responseSha256: result.responseSha256 };
          }
        }
      } else if (row.read.kind === "ton-jetton-supply" && row.chainId === "ton" && row.address !== null && row.decimals !== null) {
        const result = await fetchTonJettonSupply(row.address, input.signal ?? new AbortController().signal, row.read.apiUrl, {
          clockSec: input.scoringClockSec, expectedDecimals: row.decimals,
        });
        if (result) observation = { id: row.deploymentKey, deploymentKey: row.deploymentKey, amount: result.rawSupply.toString(),
          observedAtSec: result.blockTimestampSec, anchor: String(result.masterchainSeqno),
          anchorHash: result.blockHash, responseSha256: result.responseSha256 };
      } else if (row.read.kind === "xrpl-issued-currency" && row.chainId === "xrpl") {
        const url = input.chainRpcs.get("xrpl")?.endpoints[0]?.url ?? getPublicRpcUrl("xrpl");
        if (url) {
          const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...getRpcAuthHeaders(url) }, body: JSON.stringify({ method: "gateway_balances", params: [{ account: row.read.issuer, ledger_index: "validated", strict: true }] }), signal: input.signal });
          const text = await response.text();
          const body = JSON.parse(text) as { result?: { validated?: boolean; ledger_index?: number; ledger_hash?: string; obligations?: Record<string, string> } };
          const result = body.result, value = result?.obligations?.[row.read.currency];
          if (response.ok && result?.validated === true && Number.isSafeInteger(result.ledger_index) && typeof result.ledger_hash === "string" && /^[A-Fa-f0-9]{64}$/.test(result.ledger_hash) && typeof value === "string") {
            const amount = parseXrplIssuedCurrencyAmount({ issuer: row.read.issuer, currency: row.read.currency, value }, row.read);
            if (!amount.coefficient.startsWith("-")) {
              const coefficient = amount.coefficient, exponent = amount.exponent;
              const decimal = exponent >= 0 ? coefficient + "0".repeat(exponent) : coefficient.length + exponent > 0 ? `${coefficient.slice(0, coefficient.length + exponent)}.${coefficient.slice(coefficient.length + exponent)}` : `0.${"0".repeat(-exponent - coefficient.length)}${coefficient}`;
              // Read the pinned ledger's true close clock; a response receipt clock is not a ledger clock.
              const ledgerResponse = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...getRpcAuthHeaders(url) }, body: JSON.stringify({ method: "ledger", params: [{ ledger_hash: result.ledger_hash }] }), signal: input.signal });
              const ledgerText = await ledgerResponse.text();
              const ledger = JSON.parse(ledgerText) as { result?: { ledger?: { close_time?: number; ledger_hash?: string } } };
              const close = ledger.result?.ledger?.close_time;
              if (ledgerResponse.ok && ledger.result?.ledger?.ledger_hash === result.ledger_hash && Number.isInteger(close)) observation = { id: row.deploymentKey, deploymentKey: row.deploymentKey, amount: decimal.includes(".") ? decimal.replace(/0+$/, "").replace(/\.$/, "") : decimal, observedAtSec: close! + 946684800, anchor: String(result.ledger_index), anchorHash: result.ledger_hash.toLowerCase(), responseSha256: sha256Hex(text + ledgerText) };
            }
          }
        }
      }
      if (!observation) return { status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId };
      observations.push(observation);
    }
    for (const rule of [...plan.exclusions, ...plan.escrows.map(escrow => ({ id: escrow.id, deploymentKey: escrow.canonicalDeploymentKey, account: escrow.account }))]) {
      const row = plan.deployments.find(row => row.deploymentKey === rule.deploymentKey)!;
      failedRouteId = row.routeId ?? row.deploymentKey;
      const observation = row.read.kind === "cosmos-bank-supply"
        ? await readCosmos(row, rule.id, rule.account) : await readEvm(row, rule.id, rule.account);
      if (!observation) return { status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId };
      observations.push(observation);
    }
    for (const source of plan.conversionSources) {
      const conversion = await readReviewedApiAmount(source, input.signal);
      if (!conversion || Number(conversion.value) <= 0) return { status: "rejected", rejectionCode: "packet-reconciliation-failed", failedRouteId: source.sourceId };
      conversions.push(conversion);
    }
    for (const escrow of plan.escrows) {
      for (const receipt of escrow.receiptClaimSources) {
        const claim = await readReviewedApiAmount(receipt.source, input.signal);
        if (!claim) return { status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: receipt.deploymentKey };
        observations.push({ id: `receipt:${escrow.id}:${receipt.deploymentKey}`, deploymentKey: receipt.deploymentKey,
          amount: claim.value, observedAtSec: claim.observedAtSec, anchor: claim.sourceGeneration, anchorHash: claim.responseSha256, responseSha256: claim.responseSha256 });
      }
      if (escrow.inFlightSource === null) continue;
      failedRouteId = escrow.id;
      if ("kind" in escrow.inFlightSource) {
        let pending: EconomicSupplyObservation | null;
        if (escrow.inFlightSource.kind === "evm-ccip-pending") {
          const source = escrow.inFlightSource;
          const result = await observeCcipPending({ source, headers, clockSec: input.scoringClockSec,
            chainRpcs: input.chainRpcs, signal: input.signal, db: input.db });
          if (result.status !== "accepted") return { status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: `${escrow.id}:${result.reason}` };
          const header = headers.get(source.chainId)!;
          pending = { id: `in-flight:${escrow.id}`, deploymentKey: escrow.canonicalDeploymentKey, amount: result.amount,
            observedAtSec: header.timestamp, anchor: String(header.number), anchorHash: header.hash,
            responseSha256: result.responseSha256, ccipPendingProof: result.proof };
        } else if (escrow.inFlightSource.kind === "evm-curve-lz-pending") {
          const source = escrow.inFlightSource;
          const pins = source.sides.map(side => headers.get(side.chainId));
          if (pins.some(pin => pin === undefined)) return { status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: `${escrow.id}:pin-missing` };
          const result = await observeCurveLzPending({ source, headers: pins as EvmBlockHeader[], chainRpcs: input.chainRpcs, signal: input.signal, db: input.db });
          if (result.status !== "accepted") return { status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: `${escrow.id}:${result.reason}` };
          const header = pins[0]!;
          pending = { id: `in-flight:${escrow.id}`, deploymentKey: escrow.canonicalDeploymentKey, amount: result.amount,
            observedAtSec: header.timestamp, anchor: String(header.number), anchorHash: header.hash,
            responseSha256: result.responseSha256, curvePendingProof: result.proof };
        } else {
          pending = await readPendingState(escrow.inFlightSource, escrow);
        }
        if (!pending) return { status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: escrow.id };
        inFlight.push(pending);
      } else {
        const pending = await readReviewedApiAmount(escrow.inFlightSource, input.signal);
        if (!pending) return { status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: escrow.id };
        inFlight.push({ id: `in-flight:${escrow.id}`, deploymentKey: escrow.canonicalDeploymentKey, amount: pending.value, observedAtSec: pending.observedAtSec, anchor: pending.sourceGeneration, anchorHash: pending.responseSha256, responseSha256: pending.responseSha256 });
      }
    }
    if (plan.liabilityInFlightSource !== null) {
      if ("kind" in plan.liabilityInFlightSource) {
        const source = plan.liabilityInFlightSource;
        if (source.kind !== "evm-ccip-pending") return { status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: "in-flight:liability:unsupported-read" };
        const result = await observeCcipPending({ source, headers, clockSec: input.scoringClockSec,
          chainRpcs: input.chainRpcs, signal: input.signal, db: input.db });
        if (result.status !== "accepted") return { status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: `in-flight:liability:${result.reason}` };
        const header = headers.get(source.chainId)!;
        inFlight.push({ id: "in-flight:liability", deploymentKey: plan.deployments[0]!.deploymentKey, amount: result.amount,
          observedAtSec: header.timestamp, anchor: String(header.number), anchorHash: header.hash,
          responseSha256: result.responseSha256, ccipPendingProof: result.proof });
      } else {
        const pending = await readReviewedApiAmount(plan.liabilityInFlightSource, input.signal);
        if (!pending) return { status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: "in-flight:liability" };
        inFlight.push({ id: "in-flight:liability", deploymentKey: plan.deployments[0]!.deploymentKey, amount: pending.value,
          observedAtSec: pending.observedAtSec, anchor: pending.sourceGeneration, anchorHash: pending.responseSha256, responseSha256: pending.responseSha256 });
      }
    }
    for (const [chainId, header] of headers) {
      const rechecked = await fetchEvmBlockHeader(chainId, header.number, { chainRpcs: input.chainRpcs, signal: input.signal });
      if (!rechecked || rechecked.number !== header.number || rechecked.hash !== header.hash || rechecked.timestamp !== header.timestamp) {
        return { status: "rejected", rejectionCode: "deployment-state-invalid", failedRouteId: `anchor:${chainId}` };
      }
    }
    const attribution = deriveReviewedEconomicDeploymentPartition({ plan, baseInputGenerationId: input.fixedInput.baseInputGenerationId, sourceGeneration: input.fixedInput.sourceGeneration, registryFingerprint: input.fixedInput.registryFingerprint, clockSec: input.scoringClockSec, aggregate: { supplyUsd: aggregateUsd, observedAtSec: aggregate.observedAtSec, sourceGeneration: input.fixedInput.sourceGeneration }, referencePrice, conversions, observations, inFlight });
    if (attribution) {
      const contradiction = economicProviderSupplyContradictionChain(attribution, input.fixedInput.chainCirculatingById[input.assetId] ?? {});
      if (contradiction !== null) return { status: "rejected", rejectionCode: "packet-reconciliation-failed", failedRouteId: `provider:${contradiction}` };
    }
    return attribution ? { status: "accepted", attribution } : { status: "rejected", rejectionCode: "packet-reconciliation-failed", failedRouteId };
  } catch (error) {
    rethrowIfAborted(error, input.signal);
    return { status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId };
  }
}
