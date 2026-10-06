import { z } from "zod";
import { decodeAbiParameters, encodeAbiParameters, keccak256, parseAbiParameters, toFunctionSelector, toHex } from "viem/utils";
import { CHAIN_META } from "@shared/types/chain-identity";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { LayerZeroOftPendingCheckpointSchema, LayerZeroOftPendingReadSchema, type LayerZeroOftPendingCheckpoint, type LayerZeroOftPendingRead, type EconomicSupplyObservation } from "@shared/types/safety-score-v9-supply-attribution";
import { rethrowIfAborted, throwIfAborted } from "../abort";
import type { ChainRpcConfig } from "../chain-registry";
import { USER_AGENT } from "../constants";
import { getCache, setCache } from "../db-cache";
import { fetchEvmBlockHeader, fetchEvmRpcBatch, type EvmBlockHeader } from "../evm-rpc";
import { fetchJsonWithRetry } from "../fetch-retry";

// Discovery window width is independent of provider eth_getLogs limits: Scan
// returns identifiers, never an exhaustive quantity. Dense windows subdivide;
// consecutive receipted nonces still reconcile against the pinned counter.
const HISTORY_PAGE_BLOCKS = 1_000_000;
const HISTORY_PAGES_PER_ATTEMPT = 8;
const CHECKPOINT_MAX_BYTES = 512 * 1024;
const MAX_MESSAGES = 512;
const HISTORY_PAGE_MESSAGES = 8;
const SCAN_ORIGIN = "https://scan.layerzero-api.com/v1";
const WORD = /^0x[0-9a-f]{64}$/;
const ADDRESS_WORD = /^0x0{24}[0-9a-f]{40}$/;
const SENT_TOPIC = keccak256(toHex("PacketSent(bytes,bytes,address)"));
const DELIVERED_TOPIC = keccak256(toHex("PacketDelivered((uint32,bytes32,uint64),address)"));
const OFT_SENT_TOPIC = keccak256(toHex("OFTSent(bytes32,uint32,address,uint256,uint256)"));
const OFT_RECEIVED_TOPIC = keccak256(toHex("OFTReceived(bytes32,uint32,address,uint256)"));
const addressWord = (value: string): `0x${string}` => `0x${value.slice(2).padStart(64, "0")}`;
const call = (signature: string, types: string, values: readonly unknown[]): string =>
  toFunctionSelector(signature) + encodeAbiParameters(parseAbiParameters(types), values as never).slice(2);
// Review hashes authenticate executable contracts, not an upgradeable proxy's
// stable dispatch shell. Skip PUSH data while conservatively rejecting runtime
// delegation; unsupported proxy families require stronger execution evidence.
function hasDelegatedExecution(code: string): boolean {
  for (let offset = 2; offset < code.length; offset += 2) {
    const opcode = Number.parseInt(code.slice(offset, offset + 2), 16);
    if (opcode === 0xf4 || opcode === 0xf2) return true;
    if (opcode >= 0x60 && opcode <= 0x7f) offset += (opcode - 0x5f) * 2;
  }
  return false;
}
function fail(reason: string): never { throw new Error(`oft-pending:${reason}`); }
const uint = (value: unknown): bigint => typeof value === "string" && WORD.test(value) ? BigInt(value) : fail("state-unavailable");
const ScanMessageSchema = z.object({
  guid: z.string().regex(WORD),
  pathway: z.object({ srcEid: z.number().int(), dstEid: z.number().int(),
    sender: z.object({ address: z.string() }), receiver: z.object({ address: z.string() }) }),
  source: z.object({ tx: z.object({ txHash: z.string().regex(WORD), blockNumber: z.union([z.string(), z.number()]) }) }),
  destination: z.object({ tx: z.object({ txHash: z.string().regex(WORD) }).optional() }).optional(),
});
type ScanMessage = z.infer<typeof ScanMessageSchema>;
type Message = LayerZeroOftPendingCheckpoint["pathways"][number]["messages"][number];
type Log = { address: string; topics: string[]; data: `0x${string}`; transactionHash: string; blockHash: string; blockNumber: string; logIndex: string; removed?: boolean };
type Receipt = { status: string; transactionHash: string; blockHash: string; blockNumber: string; logs: Log[] };
type Proof = NonNullable<EconomicSupplyObservation["layerZeroOftPendingProof"]>;

/** Generic EVM OFT/OFTAdapter v1; nonstandard credit codecs fail closed. */
export async function observeLayerZeroOftPending(input: {
  source: LayerZeroOftPendingRead; headers: readonly EvmBlockHeader[];
  chainRpcs: Map<string, ChainRpcConfig>; signal?: AbortSignal; db?: D1Database;
  checkpoint?: LayerZeroOftPendingCheckpoint;
}): Promise<
  | { status: "accepted"; amount: string; proof: Proof; responseSha256: string; checkpoint: LayerZeroOftPendingCheckpoint }
  | { status: "rejected"; reason: string; checkpoint?: LayerZeroOftPendingCheckpoint }
> {
  try {
    if (!LayerZeroOftPendingReadSchema.safeParse(input.source).success) fail("review-invalid");
    const source = input.source, options = { chainRpcs: input.chainRpcs, signal: input.signal };
    const sourceDigest = sha256Hex(stableJsonStringifyV1(source));
    const cacheKey = `safety-score-v9:layerzero-oft-pending:v2:${sourceDigest}`;
    if (input.headers.length !== source.sides.length) fail("pin-missing");
    const cached = input.db ? await getCache(input.db, cacheKey, input.signal) : null;
    if (cached && cached.value.length > CHECKPOINT_MAX_BYTES) fail("checkpoint-capacity");
    const decoded: unknown = input.checkpoint ?? (cached ? JSON.parse(cached.value) : null);
    let cp: LayerZeroOftPendingCheckpoint;
    if (decoded !== null) {
      const parsed = LayerZeroOftPendingCheckpointSchema.safeParse(decoded);
      if (!parsed.success || parsed.data.sourceDigest !== sourceDigest || parsed.data.pathways.length !== source.pathways.length) fail("checkpoint-invalid");
      cp = parsed.data;
    } else {
      cp = { schemaVersion: 1, sourceDigest, pathways: source.pathways.map(path => ({
        sent: { nextBlock: source.sides[path.sourceIndex]!.deploymentBlock, anchor: null, anchorHash: null, digest: sha256Hex("layerzero-oft-history-v1") },
        sentNonce: "0", destinationAnchor: null, destinationAnchorHash: null, messages: [],
      })) };
    }
    if (cp.pathways.reduce((sum, lane) => sum + lane.messages.length, 0) > MAX_MESSAGES) fail("checkpoint-capacity");
    const rpc = async (chain: string, method: string, params: unknown[]) => {
      throwIfAborted(input.signal);
      const result = await fetchEvmRpcBatch(chain, [{ method, params }], options);
      if (!result || result.length !== 1) fail("rpc-unavailable");
      return result[0];
    };
    const state = async (index: number, to: string, data: string) => rpc(source.sides[index]!.chainId, "eth_call", [{ to, data }, { blockHash: input.headers[index]!.hash, requireCanonical: true }]);
    const authenticateRuntime = async (index: number, blockHash: string) => {
      const side = source.sides[index]!;
      for (const contract of [{ address: side.oappAddress, hash: side.oappRuntimeCodeSha256 }, { address: side.endpointAddress, hash: side.endpointRuntimeCodeSha256 }]) {
        const code = await rpc(side.chainId, "eth_getCode", [contract.address, { blockHash, requireCanonical: true }]);
        if (typeof code !== "string" || !/^0x[0-9a-f]+$/.test(code) || code.length % 2 !== 0 || sha256Hex(code) !== contract.hash) fail("runtime-mismatch");
        if (code.startsWith("0xef") || hasDelegatedExecution(code)) fail("delegated-runtime-unsupported");
      }
    };
    const saveCheckpoint = async () => {
      // Refresh mutates every lane, so every delivery decision in the serialized
      // checkpoint must bind the destination pin before ANY durable prefix write.
      for (let index = 0; index < source.sides.length; index++) {
        const pin = input.headers[index]!, rechecked = await fetchEvmBlockHeader(source.sides[index]!.chainId, pin.number, options);
        if (!rechecked || rechecked.hash !== pin.hash || rechecked.timestamp !== pin.timestamp) fail("pin-reorg");
      }
      for (let index = 0; index < cp.pathways.length; index++) {
        const pin = input.headers[source.pathways[index]!.destinationIndex]!;
        cp.pathways[index]!.destinationAnchor = pin.number; cp.pathways[index]!.destinationAnchorHash = pin.hash;
      }
      const serialized = stableJsonStringifyV1(cp);
      if (serialized.length > CHECKPOINT_MAX_BYTES) fail("checkpoint-capacity");
      if (input.db) await setCache(input.db, cacheKey, serialized, input.signal);
      return serialized;
    };
    const scan = async (url: string): Promise<{ data: ScanMessage[]; nextToken?: string }> => {
      // Scan rejects Worker-egress requests without an explicit User-Agent.
      const result = await fetchJsonWithRetry<unknown>(url, { headers: { "User-Agent": USER_AGENT }, signal: input.signal }, 0, { timeoutMs: 10_000, maxResponseBytes: 2 * 1024 * 1024 });
      const parsed = z.object({ data: z.array(ScanMessageSchema).max(100), nextToken: z.string().max(8192).optional() }).safeParse(result?.body);
      if (!result?.response.ok || !parsed.success) fail("discovery-unavailable");
      return parsed.data;
    };
    const receipt = async (index: number, hash: string, maxBlock = input.headers[index]!.number): Promise<Receipt> => {
      const raw = await rpc(source.sides[index]!.chainId, "eth_getTransactionReceipt", [hash]) as Receipt | null;
      if (!raw || raw.status !== "0x1" || raw.transactionHash !== hash || !WORD.test(raw.blockHash) ||
        !/^0x[0-9a-f]+$/.test(raw.blockNumber) || !Array.isArray(raw.logs) || raw.logs.length > 2048) fail("receipt-unproved");
      const height = Number(BigInt(raw.blockNumber));
      if (!Number.isSafeInteger(height) || height < source.sides[index]!.deploymentBlock || height > maxBlock) fail("receipt-not-finalized");
      const header = await fetchEvmBlockHeader(source.sides[index]!.chainId, height, options);
      if (!header || header.hash !== raw.blockHash) fail("receipt-anchor");
      for (const log of raw.logs) {
        if (typeof log.address !== "string" || !Array.isArray(log.topics) || log.topics.some(topic => !WORD.test(topic)) ||
          typeof log.data !== "string" || !/^0x[0-9a-f]*$/.test(log.data) || log.data.length % 2 !== 0 || log.data.length > 32770 ||
          log.transactionHash !== hash || log.blockHash !== raw.blockHash || log.blockNumber !== raw.blockNumber || log.removed === true) fail("log-invalid");
      }
      await authenticateRuntime(index, raw.blockHash);
      return raw;
    };
    const matches = (row: ScanMessage, sourceIndex: number, destinationIndex: number) => {
      const a = source.sides[sourceIndex]!, b = source.sides[destinationIndex]!;
      return row.pathway.srcEid === a.eid && row.pathway.dstEid === b.eid &&
        row.pathway.sender.address.toLowerCase() === a.oappAddress && row.pathway.receiver.address.toLowerCase() === b.oappAddress;
    };
    for (let index = 0; index < source.sides.length; index++) {
      const side = source.sides[index]!, pin = input.headers[index]!;
      if (CHAIN_META[side.chainId]?.type !== "evm") fail("unsupported-chain");
      const finalized = await fetchEvmBlockHeader(side.chainId, "finalized", options);
      const pinned = await fetchEvmBlockHeader(side.chainId, pin.number, options);
      if (!finalized || finalized.number < pin.number || pin.number < side.deploymentBlock ||
        !pinned || pinned.hash !== pin.hash || pinned.timestamp !== pin.timestamp) fail("pin-not-finalized");
      await authenticateRuntime(index, pin.hash);
      if (await state(index, side.oappAddress, toFunctionSelector("endpoint()")) !== addressWord(side.endpointAddress) ||
        uint(await state(index, side.endpointAddress, toFunctionSelector("eid()"))) !== BigInt(side.eid) ||
        await state(index, side.oappAddress, toFunctionSelector("token()")) !== addressWord(side.tokenAddress) ||
        uint(await state(index, side.tokenAddress, toFunctionSelector("decimals()"))) !== BigInt(side.localDecimals) ||
        uint(await state(index, side.oappAddress, toFunctionSelector("sharedDecimals()"))) !== BigInt(source.sharedDecimals) ||
        uint(await state(index, side.oappAddress, toFunctionSelector("decimalConversionRate()"))) !== 10n ** BigInt(side.localDecimals - source.sharedDecimals)) fail("oft-identity");
    }
    const pathStates: Array<{ outbound: bigint; inbound: bigint; lazy: bigint }> = [];
    for (let index = 0; index < source.pathways.length; index++) {
      const path = source.pathways[index]!, a = source.sides[path.sourceIndex]!, b = source.sides[path.destinationIndex]!, checkpoint = cp.pathways[index]!;
      const cursor = checkpoint.sent, pin = input.headers[path.sourceIndex]!, destinationPin = input.headers[path.destinationIndex]!;
      if (cursor.nextBlock < a.deploymentBlock || cursor.nextBlock > pin.number + 1 ||
        (cursor.anchor === null) !== (cursor.anchorHash === null) ||
        (cursor.anchor === null ? cursor.nextBlock !== a.deploymentBlock || checkpoint.sentNonce !== "0" || checkpoint.messages.length !== 0 : cursor.anchor !== cursor.nextBlock - 1)) fail("history-gap");
      if (cursor.anchor !== null && (await fetchEvmBlockHeader(a.chainId, cursor.anchor, options))?.hash !== cursor.anchorHash) fail("checkpoint-reorg");
      if ((checkpoint.destinationAnchor === null) !== (checkpoint.destinationAnchorHash === null) ||
        (checkpoint.destinationAnchor !== null && (checkpoint.destinationAnchor > destinationPin.number ||
          (await fetchEvmBlockHeader(b.chainId, checkpoint.destinationAnchor, options))?.hash !== checkpoint.destinationAnchorHash))) fail("checkpoint-reorg");
      const seenNonces = new Set<string>();
      for (const message of checkpoint.messages) {
        const nonce = BigInt(message.nonce), payload = message.payload;
        const guid = keccak256(`0x${nonce.toString(16).padStart(16, "0")}${a.eid.toString(16).padStart(8, "0")}${addressWord(a.oappAddress).slice(2)}${b.eid.toString(16).padStart(8, "0")}${addressWord(b.oappAddress).slice(2)}`);
        if (nonce === 0n || nonce > BigInt(checkpoint.sentNonce) || seenNonces.has(message.nonce) ||
          cursor.anchor === null || message.sourceBlock < a.deploymentBlock || message.sourceBlock > cursor.anchor ||
          payload.length < 82 || payload.length % 2 !== 0 || !ADDRESS_WORD.test(payload.slice(0, 66)) ||
          message.recipient !== `0x${payload.slice(26, 66)}` || message.amountSD !== BigInt(`0x${payload.slice(66, 82)}`).toString() ||
          message.guid !== guid) fail("checkpoint-message");
        seenNonces.add(message.nonce);
      }
      if (await state(path.sourceIndex, a.oappAddress, call("peers(uint32)", "uint32", [b.eid])) !== addressWord(b.oappAddress) ||
        await state(path.destinationIndex, b.oappAddress, call("peers(uint32)", "uint32", [a.eid])) !== addressWord(a.oappAddress)) fail("peer-identity");
      const outboundCall = call("outboundNonce(address,uint32,bytes32)", "address,uint32,bytes32", [a.oappAddress, b.eid, addressWord(b.oappAddress)]);
      if (cursor.anchor === null) {
        const before = await fetchEvmBlockHeader(a.chainId, a.deploymentBlock - 1, options);
        if (!before || uint(await rpc(a.chainId, "eth_call", [{ to: a.endpointAddress, data: outboundCall }, { blockHash: before.hash, requireCanonical: true }])) !== 0n) fail("history-start-unproved");
      }
      const args = [b.oappAddress, a.eid, addressWord(a.oappAddress)];
      const outbound = uint(await state(path.sourceIndex, a.endpointAddress, outboundCall));
      const inbound = uint(await state(path.destinationIndex, b.endpointAddress, call("inboundNonce(address,uint32,bytes32)", "address,uint32,bytes32", args)));
      const lazy = uint(await state(path.destinationIndex, b.endpointAddress, call("lazyInboundNonce(address,uint32,bytes32)", "address,uint32,bytes32", args)));
      if (outbound >= 2n ** 64n || inbound > outbound || lazy > inbound || BigInt(checkpoint.sentNonce) > outbound) fail("nonce-state-mismatch");
      pathStates.push({ outbound, inbound, lazy });
    }
    const discoverGuid = async (message: Message, path: LayerZeroOftPendingRead["pathways"][number]) => {
      const rows = (await scan(`${SCAN_ORIGIN}/messages/guid/${message.guid}`)).data.filter(row => matches(row, path.sourceIndex, path.destinationIndex) && row.guid === message.guid && row.source.tx.txHash === message.transactionHash);
      if (rows.length !== 1) fail("discovery-unproved");
      return rows[0]!;
    };
    const isPending = async (index: number, message: Message, discovery?: ScanMessage): Promise<boolean> => {
      const path = source.pathways[index]!, a = source.sides[path.sourceIndex]!, b = source.sides[path.destinationIndex]!, states = pathStates[index]!;
      const nonce = BigInt(message.nonce);
      const payloadCommitment = await state(path.destinationIndex, b.endpointAddress, call("inboundPayloadHash(address,uint32,bytes32,uint64)", "address,uint32,bytes32,uint64", [b.oappAddress, a.eid, addressWord(a.oappAddress), nonce]));
      if (typeof payloadCommitment !== "string" || !WORD.test(payloadCommitment)) fail("payload-unavailable");
      if (payloadCommitment !== addressWord("0x0000000000000000000000000000000000000000")) {
        if (payloadCommitment !== keccak256(`0x${message.guid.slice(2)}${message.payload.slice(2)}`)) fail("stored-payload-mismatch");
        // Verified-but-reverted lzReceive retains this commitment. Neither
        // inboundNonce nor a Scan DELIVERED label is completion evidence.
        return true;
      }
      if (nonce > states.lazy) {
        if (nonce <= states.inbound) fail("delivery-state-mismatch");
        return true;
      }
      const row = discovery ?? await discoverGuid(message, path);
      if (!row.destination?.tx) fail("delivery-unproved");
      const delivered = await receipt(path.destinationIndex, row.destination.tx.txHash);
      const completion = delivered.logs.filter(log => log.address.toLowerCase() === b.oappAddress && log.topics[0] === OFT_RECEIVED_TOPIC && log.topics[1] === message.guid);
      if (completion.length !== 1 || completion[0]!.topics.length !== 3 || completion[0]!.topics[2] !== addressWord(message.recipient)) fail("lzreceive-unproved");
      const [srcEid, credited] = decodeAbiParameters(parseAbiParameters("uint32,uint256"), completion[0]!.data);
      if (srcEid !== a.eid || credited !== BigInt(message.amountSD) * 10n ** BigInt(b.localDecimals - source.sharedDecimals)) fail("lzreceive-amount-mismatch");
      const events = delivered.logs.filter(log => log.address.toLowerCase() === b.endpointAddress && log.topics[0] === DELIVERED_TOPIC);
      if (!events.some(log => {
        if (log.topics.length !== 1) return false;
        const [origin, receiver] = decodeAbiParameters(parseAbiParameters("(uint32,bytes32,uint64),address"), log.data);
        return origin[0] === a.eid && origin[1] === addressWord(a.oappAddress) && origin[2] === nonce && receiver.toLowerCase() === b.oappAddress;
      })) fail("delivery-unproved");
      return false;
    };
    // Refresh old pending commitments before advancing history; delivered
    // messages are removed only with both endpoint and application receipts.
    for (let index = 0; index < cp.pathways.length; index++) {
      const remaining: Message[] = [];
      for (const message of cp.pathways[index]!.messages) if (await isPending(index, message)) remaining.push(message);
      cp.pathways[index]!.messages = remaining;
    }
    let pages = 0;
    for (let index = 0; index < source.pathways.length; index++) {
      const path = source.pathways[index]!, a = source.sides[path.sourceIndex]!, b = source.sides[path.destinationIndex]!, pin = input.headers[path.sourceIndex]!;
      const checkpoint = cp.pathways[index]!, cursor = checkpoint.sent;
      let pageBlocks = HISTORY_PAGE_BLOCKS;
      while (cursor.nextBlock <= pin.number) {
        // A receipted consecutive census equal to the pinned outbound nonce
        // proves the remaining interval empty, including a genuinely unused lane.
        if (BigInt(checkpoint.sentNonce) === pathStates[index]!.outbound) {
          cursor.digest = sha256Hex(stableJsonStringifyV1({ previous: cursor.digest, from: cursor.nextBlock, end: pin.number, header: pin, sentNonce: checkpoint.sentNonce }));
          cursor.nextBlock = pin.number + 1; cursor.anchor = pin.number; cursor.anchorHash = pin.hash;
          break;
        }
        if (pages >= HISTORY_PAGES_PER_ATTEMPT) break;
        const from = cursor.nextBlock, end = Math.min(pin.number, from + pageBlocks - 1);
        const beginHeader = await fetchEvmBlockHeader(a.chainId, from, options), endHeader = await fetchEvmBlockHeader(a.chainId, end, options);
        if (!beginHeader || !endHeader) fail("history-unavailable");
        // Overlap accommodates indexer ingestion timestamps. Exact receipt
        // heights, not API clocks or block hints, delimit the admitted page.
        const url = new URL(`${SCAN_ORIGIN}/messages/pathway/${a.eid}-${b.eid}-${a.oappAddress}-${b.oappAddress}`);
        url.searchParams.set("limit", "100");
        url.searchParams.set("start", new Date(Math.max(0, beginHeader.timestamp - 3600) * 1000).toISOString());
        url.searchParams.set("end", new Date((endHeader.timestamp + 3600) * 1000).toISOString());
        const discovered: ScanMessage[] = [], tokens = new Set<string>();
        let discoveryComplete = true;
        for (let count = 0; ; count++) {
          if (count >= 8) { discoveryComplete = false; break; }
          const result = await scan(url.toString());
          discovered.push(...result.data.filter(row => matches(row, path.sourceIndex, path.destinationIndex)));
          if (!result.nextToken) break;
          if (tokens.has(result.nextToken)) fail("discovery-pagination-gap");
          tokens.add(result.nextToken); url.searchParams.set("nextToken", result.nextToken);
        }
        pages++;
        let inWindowCount = 0;
        for (const row of discovered) {
          const hint = Number(row.source.tx.blockNumber);
          if (!Number.isSafeInteger(hint) || hint < 0) fail("discovery-invalid");
          if (hint >= from && hint <= end) inWindowCount++;
        }
        if (!discoveryComplete || inWindowCount > HISTORY_PAGE_MESSAGES) {
          if (end === from) fail("discovery-capacity");
          pageBlocks = Math.max(1, Math.floor((end - from + 1) / 10));
          continue;
        }
        const messages: Array<{ message: Message; discovery: ScanMessage }> = [];
        const seen = new Set<string>();
        for (const row of discovered) {
          const hint = Number(row.source.tx.blockNumber);
          if (!Number.isSafeInteger(hint) || hint < 0) fail("discovery-invalid");
          if (hint < from || hint > end) continue;
          if (seen.has(row.guid)) fail("discovery-duplicate");
          seen.add(row.guid);
          const sent = await receipt(path.sourceIndex, row.source.tx.txHash, end);
          if (Number(BigInt(sent.blockNumber)) < from) fail("discovery-unproved");
          let message: Message | undefined;
          for (const log of sent.logs.filter(log => log.address.toLowerCase() === a.endpointAddress && log.topics[0] === SENT_TOPIC)) {
            if (log.topics.length !== 1) fail("packet-invalid");
            const [packet] = decodeAbiParameters(parseAbiParameters("bytes,bytes,address"), log.data);
            const body = packet.slice(2);
            if (body.length < 306 || body.slice(0, 2) !== "01") fail("packet-invalid");
            if (body.slice(26, 90) !== addressWord(a.oappAddress).slice(2) || Number.parseInt(body.slice(18, 26), 16) !== a.eid ||
              Number.parseInt(body.slice(90, 98), 16) !== b.eid || body.slice(98, 162) !== addressWord(b.oappAddress).slice(2)) continue;
            const guid = `0x${body.slice(162, 226)}`;
            if (guid !== row.guid) continue;
            if (keccak256(`0x${body.slice(2, 162)}`) !== guid) fail("packet-guid");
            const payload = `0x${body.slice(226)}`;
            if (!ADDRESS_WORD.test(payload.slice(0, 66)) || payload.length > 8194) fail("packet-invalid");
            if (message) fail("packet-replayed");
            message = { nonce: BigInt(`0x${body.slice(2, 18)}`).toString(), guid,
              recipient: `0x${body.slice(250, 290)}`, amountSD: BigInt(`0x${body.slice(290, 306)}`).toString(), payload,
              transactionHash: sent.transactionHash, sourceBlock: Number(BigInt(sent.blockNumber)), sourceBlockHash: sent.blockHash };
          }
          const sourceMessage = message;
          if (!sourceMessage) fail("source-send-unproved");
          const debits = sent.logs.filter(log => log.address.toLowerCase() === a.oappAddress && log.topics[0] === OFT_SENT_TOPIC && log.topics[1] === sourceMessage.guid);
          if (debits.length !== 1 || debits[0]!.topics.length !== 3) fail("oft-debit-unproved");
          const [dstEid, debited, credited] = decodeAbiParameters(parseAbiParameters("uint32,uint256,uint256"), debits[0]!.data);
          const amountLD = BigInt(sourceMessage.amountSD) * 10n ** BigInt(a.localDecimals - source.sharedDecimals);
          if (dstEid !== b.eid || debited !== amountLD || credited !== amountLD) fail("oft-debit-mismatch");
          messages.push({ message: sourceMessage, discovery: row });
        }
        messages.sort((left, right) => BigInt(left.message.nonce) < BigInt(right.message.nonce) ? -1 : 1);
        for (const { message, discovery } of messages) {
          if (BigInt(message.nonce) !== BigInt(checkpoint.sentNonce) + 1n) fail("missing-nonce");
          if (await isPending(index, message, discovery)) checkpoint.messages.push(message);
          checkpoint.sentNonce = message.nonce;
          if (cp.pathways.reduce((sum, lane) => sum + lane.messages.length, 0) > MAX_MESSAGES) fail("checkpoint-capacity");
        }
        if ((await fetchEvmBlockHeader(a.chainId, end, options))?.hash !== endHeader.hash) fail("history-reorg");
        cursor.digest = sha256Hex(stableJsonStringifyV1({ previous: cursor.digest, from, end, header: endHeader, messages: messages.map(row => row.message) }));
        cursor.nextBlock = end + 1; cursor.anchor = end; cursor.anchorHash = endHeader.hash;
        // Save only a fully authenticated prefix; a later receipt timeout must
        // not force sparse bootstrap windows to be scanned again.
        await saveCheckpoint();
      }
      if (cursor.nextBlock > pin.number && BigInt(checkpoint.sentNonce) !== pathStates[index]!.outbound) fail("send-census-mismatch");
    }
    const complete = cp.pathways.every((lane, index) => lane.sent.nextBlock === input.headers[source.pathways[index]!.sourceIndex]!.number + 1);
    const serialized = await saveCheckpoint();
    if (!complete) return { status: "rejected", reason: "history-incomplete", checkpoint: cp };
    let amountSD = 0n;
    const pathways = cp.pathways.map((lane, index) => {
      const pending = lane.messages.reduce((sum, message) => sum + BigInt(message.amountSD), 0n);
      amountSD += pending;
      return { ...source.pathways[index]!, sentNonce: lane.sentNonce, inboundNonce: pathStates[index]!.inbound.toString(), lazyInboundNonce: pathStates[index]!.lazy.toString(), pendingCount: lane.messages.length, pendingAmountSD: pending.toString() };
    });
    const amount = (amountSD * 10n ** BigInt(source.localDecimals - source.sharedDecimals)).toString();
    const proof: Proof = { sourceDigest, checkpointDigest: sha256Hex(serialized), pins: source.sides.map((side, index) => ({ chainId: side.chainId, eid: side.eid, anchor: input.headers[index]!.number, anchorHash: input.headers[index]!.hash, observedAtSec: input.headers[index]!.timestamp })), pathways };
    return { status: "accepted", amount, proof, responseSha256: sha256Hex(stableJsonStringifyV1({ proof, amount })), checkpoint: cp };
  } catch (error) {
    rethrowIfAborted(error, input.signal);
    return { status: "rejected", reason: error instanceof Error && error.message.startsWith("oft-pending:") ? error.message.slice(12) : "rpc-unavailable" };
  }
}
